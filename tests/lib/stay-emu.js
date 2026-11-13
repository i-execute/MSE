'use strict';
/*
 * Emulation of the Stay userscript pipeline for tests, built from Stay's own sources:
 *   - header parsing:       tests/lib/stay/parse-user-script.js (+ parse-meta-line.js)
 *   - URL matching:         tests/lib/stay/MatchPattern.js
 *   - comment stripping:    port of -[Tampermonkey _removeComment:] (current + 2 older regexes)
 *   - page/content choice:  port of -[Tampermonkey usedCustomWindowPropertyOrMethod:]
 *   - GM_* API source:      tests/lib/stay/gm-api-create.js (createGMApisWithUserScript)
 *   - wrapper:              port of -[Tampermonkey conventScriptContent:]
 * The extension side (bootstrap.js bridge, background.js, native handler) is re-implemented
 * in installStay() following the same message protocol.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const http = require('http');
const https = require('https');

const LIB = path.join(__dirname, 'stay');
const lib = (n) => fs.readFileSync(path.join(LIB, n), 'utf8');

function stayVm() {
  const logs = [];
  const sandbox = { native: { nslog: (m) => logs.push(String(m)) }, console, URL };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const f of ['gm-api-create.js', 'supported-apis.js', 'convert2RegExp.js', 'MatchPattern.js', 'parse-meta-line.js', 'parse-user-script.js']) {
    /* top-level const/function declarations of each file must be visible to the next ones */
    vm.runInContext(lib(f), sandbox, { filename: f });
  }
  return sandbox;
}

const COMMENT_REGEX = {
  current: /^\/\/.*/gm,
  old1: /((?<!:)\/\/.*|\/\*(\s|.)*?\*\/)/gm,
  old2: /\/\*[\s\S]*?\*\/|([^\\:]|^)\/\/.*$/gm,
};
function removeComment(script, variant = 'current') {
  return script.replace(COMMENT_REGEX[variant], '').replace(/^[\n\r]+|[\n\r]+$/g, '');
}

const WINDOW_PROPS = new Set(('clientInformation navigator closed console customElements crypto devicePixelRatio document event external frameElement frames fullScreen history innerHeight innerWidth length frames location locationbar localStorage menubar messageManager mozInnerScreenX mozInnerScreenY name navigator opener outerHeight outerWidth pageXOffset pageYOffset parent performance personalbar screen screenX screenY scrollbars scrollMaxX scrollMaxY scrollX scrollY self sessionStorage sidebar speechSynthesis status statusbar toolbar top visualViewport window content defaultStatus orientation returnValue').split(' ').map((s) => 'window.' + s));
const WINDOW_METHODS = new Set(('alert blur cancelAnimationFrame cancelIdleCallback clearImmediate close confirm dump find focus getComputedStyle getDefaultComputedStyle getSelection matchMedia moveBy moveTo open postMessage print prompt requestAnimationFrame requestIdleCallback resizeBy resizeTo scroll scrollBy scrollByLines scrollByPages scrollTo setImmediate setResizable sizeToContent showOpenFilePicker showSaveFilePicker showDirectoryPicker stop updateCommands back captureEvents forward home openDialog releaseEvents showModalDialog').split(' ').map((s) => 'window.' + s + '()'));
function usedCustomWindowPropertyOrMethod(script) {
  const re = /(window\.[a-z|A-z|\(|\)]*)/g;
  let m;
  while ((m = re.exec(script))) {
    if (!WINDOW_PROPS.has(m[1]) && !WINDOW_METHODS.has(m[1])) return m[1];
  }
  return null;
}

/** What the Stay app does when a script is added. */
function installScript(source, opts = {}) {
  const sb = stayVm();
  /* plain copy: the parser runs in another realm */
  const header = JSON.parse(JSON.stringify(sb.parseUserScript(source, '')));
  if (!header.pass) throw new Error('Stay rejects the script: ' + header.errorMessage);
  const uuid = opts.uuid || 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';
  const userscript = Object.assign({}, header, { uuid, icon: header.iconUrl, content: source });
  const stripped = removeComment(source, opts.commentVariant || 'current');
  const custom = usedCustomWindowPropertyOrMethod(stripped);
  let installType = userscript.grants.includes('unsafeWindow') || custom ? 'page' : 'content';
  if (opts.forceMode) installType = opts.forceMode;
  const id = uuid.replace(/-/g, '_');
  const pageApi = sb.createGMApisWithUserScript(userscript, uuid, '2.0.0', stripped, 'page');
  const pageContent = `async function stay_script_${id}(){\n\t${pageApi}\n\t${stripped}\n}\nstay_script_${id}();\n`;
  let content = pageContent;
  if (installType === 'content') {
    const api = sb.createGMApisWithUserScript(userscript, uuid, '2.0.0', stripped, 'content');
    content = `async function gm_init(){\n\t${api}\n\t${stripped}\n}\ngm_init().catch((e)=>browser.runtime.sendMessage({ from: 'gm-apis', operate: 'GM_error', message: e.message, uuid:'${uuid}'}));\n`;
  }
  return { header, uuid, installType, customWindowUse: custom, stripped, content, pageContent, matchers: header.matches.map((m) => new sb.MatchPattern(m)), sb };
}

function matches(script, url) {
  const u = new URL(url);
  return script.matchers.some((m) => m.doMatch(u));
}

function nodeRequest(details) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(details.url); } catch (e) { resolve({ error: true }); return; }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, { method: details.method || 'GET', headers: details.headers || {} }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const rawHeaders = [];
        for (let i = 0; i < res.rawHeaders.length; i += 2) rawHeaders.push(res.rawHeaders[i].toLowerCase() + ': ' + res.rawHeaders[i + 1]);
        resolve({
          readyState: 4, status: res.statusCode, statusText: res.statusMessage || '',
          responseHeaders: rawHeaders.join('\r\n') + '\r\n', responseText: Buffer.concat(chunks).toString('utf8'),
          response: Buffer.concat(chunks).toString('utf8'), responseType: '', responseURL: details.url, finalUrl: details.url,
          timeout: 0, withCredentials: false,
        });
      });
    });
    req.on('error', () => resolve({ error: true }));
    if (details.timeout) req.setTimeout(details.timeout, () => { req.destroy(); });
    if (details.data !== undefined && details.data !== null) req.write(String(details.data));
    req.end();
  });
}

/* Runs in the page before any page script: Stay's content-script side. */
function contentScriptSide(cfg) {
  const listeners = [];
  const browser = {
    runtime: {
      sendMessage(msg, cb) {
        if (msg && msg.from === 'content' && msg.operate === 'giveRegisterMenuCommand') { window.__stayGive(JSON.parse(JSON.stringify(msg.data || []))); return Promise.resolve(); }
        const p = window[window.__stayBgName || '__stayBg'](JSON.parse(JSON.stringify(msg)));
        if (typeof cb === 'function') p.then(cb);
        return p;
      },
      onMessage: { addListener(fn) { listeners.push(fn); } },
      getURL: (n) => 'safari-web-extension://stay/' + n,
    },
  };
  Object.defineProperty(window, '__stayDeliver', { value: (msg) => { listeners.slice().forEach((fn) => { try { fn(msg, {}, () => {}); } catch (e) { console.error('stay listener', e); } }); } });
  if (cfg.exposeBrowser) window.browser = browser;

  /* bootstrap.js: bridge between page-mode GM API (window.postMessage) and the background */
  const RMC = {};
  /* Stay popup -> background -> tab: page-mode commands live in RMC (bootstrap), content-mode ones in the script itself */
  let given = null;
  window.__stayGive = (data) => { if (given) given(data || []); };
  window.__stayMenu = async (uuid) => {
    const fromPage = Object.values(RMC).flat().map((x) => ({ id: x.id, caption: x.caption }));
    const fromContent = await new Promise((resolve) => {
      given = resolve;
      setTimeout(() => resolve([]), 300);
      window.__stayDeliver({ from: 'background', operate: 'fetchRegisterMenuCommand', uuid });
    });
    given = null;
    return fromPage.concat((fromContent || []).map((x) => ({ id: x.id, caption: x.caption })));
  };
  window.__stayMenuExec = (menuId, uuid) => {
    window.postMessage({ name: 'execRegisterMenuCommand', menuId, uuid });
    window.__stayDeliver({ from: 'background', operate: 'execRegisterMenuCommand', id: menuId, uuid });
  };
  window.addEventListener('message', (e) => {
    if (!e || !e.data || !e.data.name) return;
    const d = e.data; const uuid = d.id; const pid = d.pid; const name = d.name;
    const message = { from: 'gm-apis', uuid };
    const post = (n, extra) => window.postMessage(Object.assign({ id: uuid, pid, name: n }, extra));
    if (name === 'API_LIST_VALUES') { message.operate = 'GM_listValues'; browser.runtime.sendMessage(message, (r) => post('RESP_LIST_VALUES', { response: r })); }
    else if (name === 'API_DELETE_VALUE') { message.operate = 'GM_deleteValue'; message.key = d.key; browser.runtime.sendMessage(message, (r) => post('RESP_DELETE_VALUE', { response: r })); }
    else if (name === 'API_SET_VALUE' || name === 'API_SET_VALUE_SYNC') { message.operate = 'GM_setValue'; message.key = d.key; message.value = d.value; browser.runtime.sendMessage(message, (r) => { if (name === 'API_SET_VALUE') post('RESP_SET_VALUE', { response: r }); }); }
    else if (name === 'API_GET_VALUE' || name === 'API_GET_VALUE_SYNC') { message.operate = 'GM_getValue'; message.key = d.key; message.defaultValue = d.defaultValue; browser.runtime.sendMessage(message, (r) => { if (name === 'API_GET_VALUE') post('RESP_GET_VALUE', { response: r }); }); }
    else if (name === 'API_GET_ALL_REXOURCE_TEXT') { message.operate = 'GM_getAllResourceText'; browser.runtime.sendMessage(message, (r) => post('RESP_GET_ALL_REXOURCE_TEXT', { response: r })); }
    else if (name === 'API_LOG') { message.operate = 'GM_log'; message.message = d.message; browser.runtime.sendMessage(message); }
    else if (name === 'API_CLEAR_LOG') { message.operate = 'clear_GM_log'; browser.runtime.sendMessage(message); }
    else if (name === 'REGISTER_MENU_COMMAND_CONTEXT') { (RMC[uuid] = RMC[uuid] || []).push(JSON.parse(d.rmc_context)); }
    else if (name === 'UNREGISTER_MENU_COMMAND_CONTEXT') { RMC[uuid] = (RMC[uuid] || []).filter((x) => x.id !== pid); }
    else if (name === 'API_OPEN_IN_TAB') { message.operate = 'openInTab'; message.url = d.url; message.options = d.options ? JSON.parse(d.options) : {}; browser.runtime.sendMessage(message, (r) => post('RESP_OPEN_IN_TAB', { tabId: r.tabId })); }
    else if (name === 'API_XHR_FROM_CREATE') { message.operate = 'API_XHR_FROM_BOOTSTRAP'; message.details = JSON.parse(d.details); message.xhrId = d.xhrId; browser.runtime.sendMessage(message); }
    else if (name === 'API_XHR_ABORT_INJ_FROM_CREATE') { message.operate = 'API_XHR_ABORT_FROM_BOOTSTRAP'; message.xhrId = d.xhrId; browser.runtime.sendMessage(message); }
  });
  browser.runtime.onMessage.addListener((request) => {
    if (request && typeof request.operate === 'string' && request.operate.startsWith('RESP_API_XHR_BG_')) {
      window.postMessage({ name: request.operate.replace('_BG_', '_TO_CREATE_'), response: request.response, id: request.id, xhrId: request.xhrId });
    }
  });

  /* fetchScripts + injection, as bootstrap.js does */
  browser.runtime.sendMessage({ from: 'bootstrap', operate: 'fetchScripts', url: location.href }, (response) => {
    (response.body || []).forEach((script) => {
      if (!script.active) return;
      const runAt = 'document_' + script.runAt;
      const inject = () => {
        if (script.installType === 'page') {
          const tag = document.createElement('script');
          tag.type = 'text/javascript';
          tag.id = 'Stay_Inject_JS_' + script.uuid;
          tag.appendChild(document.createTextNode(script.content));
          document.body.appendChild(tag);
        } else {
          /* tabs.executeScript({code}) into the content-script world, where `browser` exists */
          window.__stayContentWorld = browser;
          const tag = document.createElement('script');
          tag.textContent = '(function(browser){' + script.content + '\n})(window.__stayContentWorld);';
          document.documentElement.appendChild(tag);
          tag.remove();
        }
      };
      const when = (pred, evt, target) => { if (pred()) inject(); else target.addEventListener(evt, function h() { if (pred()) { target.removeEventListener(evt, h); inject(); } }); };
      if (runAt === 'document_start') when(() => document.readyState !== 'loading', 'readystatechange', document);
      else if (runAt === 'document_idle') when(() => document.readyState === 'complete', 'readystatechange', document);
      else when(() => document.readyState !== 'loading', 'DOMContentLoaded', document);
    });
  });
}

/**
 * Installs the emulated Stay extension into a Playwright BrowserContext.
 * state.store survives across pages/contexts when the same object is passed again.
 */
async function installStay(context, scripts, state = {}) {
  state.store = state.store || {};
  state.log = state.log || [];
  state.xhr = state.xhr || [];
  state.opened = state.opened || [];
  state.errors = state.errors || [];
  const xhrBlock = state.xhrHandler || null;
  const bindingName = state.bindingName || '__stayBg';
  if (state.bindingName) await context.addInitScript((n) => { window.__stayBgName = n; }, bindingName);
  await context.exposeBinding(bindingName, async ({ page }, request) => {
    const st = (uuid) => (state.store[uuid] = state.store[uuid] || {});
    const deliver = (msg) => page.evaluate((m) => window.__stayDeliver(m), msg).catch(() => {});
    if (request.from === 'bootstrap') {
      if (request.operate === 'fetchScripts') {
        const body = scripts.filter((s) => matches(s, request.url)).map((s) => ({
          uuid: s.uuid, active: true, installType: s.installType, runAt: s.header.runAt, noFrames: s.header.noFrames,
          requireUrls: [], requireCodes: [], content: s.content, pageContent: s.pageContent, name: s.header.name,
        }));
        return { type: 'fetchScripts', body };
      }
      return undefined;
    }
    if (request.from !== 'gm-apis') return undefined;
    const op = request.operate;
    if (op === 'GM_listValues') return { type: op, body: Object.assign({}, st(request.uuid)) };
    if (op === 'GM_getValue') { const s = st(request.uuid); return { type: op, body: request.key in s ? s[request.key] : (request.defaultValue === undefined ? null : request.defaultValue) }; }
    if (op === 'GM_setValue') { if (request.key && request.value !== undefined && request.value !== null) st(request.uuid)[request.key] = request.value; return { type: op, body: null }; }
    if (op === 'GM_deleteValue') { delete st(request.uuid)[request.key]; return { type: op, body: null }; }
    if (op === 'GM_getAllResourceText' || op === 'GM_getAllResourceUrl') return { type: op, body: {} };
    if (op === 'clear_GM_log') return undefined;
    if (op === 'GM_log') { state.log.push(request.message); return undefined; }
    if (op === 'GM_error') { state.errors.push(request.message); return undefined; }
    if (op === 'openInTab') { state.opened.push(request.url); return { tabId: 2 }; }
    if (op === 'closeTab') return {};
    if (op === 'GM_xmlhttpRequest') {
      /* content mode: one response object with onload / onerror */
      const details = request.params || {};
      state.xhr.push({ mode: 'content', method: details.method || 'GET', url: details.url, headers: details.headers, data: details.data });
      const r = (xhrBlock && await xhrBlock(details)) || await nodeRequest(details);
      if (r.error) return { onerror: { readyState: 4, status: 0, statusText: '', responseHeaders: '', responseText: '' } };
      return { onreadystatechange: r, onload: r };
    }
    if (op === 'API_XHR_FROM_BOOTSTRAP') {
      const details = request.details || {};
      state.xhr.push({ mode: 'page', method: details.method || 'GET', url: details.url, headers: details.headers, data: details.data });
      (async () => {
        const r = (xhrBlock && await xhrBlock(details)) || await nodeRequest(details);
        const send = (evt, resp) => deliver({ operate: 'RESP_API_XHR_BG_' + evt, id: request.uuid, xhrId: request.xhrId, response: resp });
        if (r.error) {
          const x = { readyState: 4, status: 0, statusText: '', responseHeaders: '', response: '', responseText: '', responseType: '', responseURL: '' };
          if (details.onerror) await send('ERROR', x);
          if (details.onloadend) await send('LOADEND', x);
        } else {
          if (details.onload) await send('LOAD', r);
          if (details.onloadend) await send('LOADEND', r);
        }
      })();
      return undefined;
    }
    return undefined;
  });
  await context.addInitScript(contentScriptSide, { exposeBrowser: false });
  /* optional cookies for the saved pages (WebKit has no other API for that here). They are written on the
     first page of the context and kept from then on: HttpOnly ones are set by the browser, the rest by a
     script, exactly as a site would do it. */
  if (Array.isArray(state.cookies) && state.cookies.length) {
    state.cookies.forEach((c) => { state.requiredCookies = state.requiredCookies || {}; state.requiredCookies[c.name] = c.value; });
    const visible = state.cookies.filter((c) => !c.httpOnly);
    const hidden = state.cookies.filter((c) => c.httpOnly);
    const origin = state.cookieOrigin || 'https://school.moodledemo.net';
    if (hidden.length) {
      await context.addCookies(hidden.map((c) => ({
        name: c.name, value: c.value, url: origin + (c.path || '/'),
        httpOnly: true, secure: true, sameSite: 'Lax', expires: Math.floor(Date.now() / 1000) + 86400,
      })));
    }
    const secure = visible.some((c) => c.secure === undefined || c.secure) ? '; Secure' : '';
    const jar = visible.map((c) => c.name + '=' + c.value + '; path=' + (c.path || '/') + secure + '; SameSite=Lax').join('\n');
    let seeded = false;
    await context.addInitScript((lines) => {
      if (window.__ssCookieJar || window.top !== window) return;
      window.__ssCookieJar = 1;
      for (const line of lines.split('\n')) { try { document.cookie = line; } catch (e) {} }
    }, jar);
    context.on('page', async (page) => {
      if (seeded) return;
      seeded = true;
      if (visible.length) await page.addInitScript(() => {}).catch(() => {});
    });
  }
  return state;
}

/** Stay popup: list of registered menu commands and a way to tap one. */
async function menuCommands(page, script) { return page.evaluate((uuid) => window.__stayMenu(uuid), script.uuid); }
async function tapMenuCommand(page, script, caption) {
  const items = await menuCommands(page, script);
  const item = items.find((x) => x.caption === caption);
  if (!item) throw new Error('no menu command ' + caption + ' in ' + JSON.stringify(items));
  await page.evaluate(([id, uuid]) => window.__stayMenuExec(id, uuid), [item.id, script.uuid]);
}

module.exports = { installScript, installStay, matches, removeComment, usedCustomWindowPropertyOrMethod, menuCommands, tapMenuCommand, nodeRequest, COMMENT_REGEX };
