'use strict';
const fs = require('fs');
const path = require('path');
const pw = require('playwright');
const emu = require('./stay-emu.js');

const ROOT = path.join(__dirname, '..', '..');
const FIX = path.join(ROOT, 'tests', 'fixtures');
const USERJS = process.env.MSE_USERJS || path.join(ROOT, 'Storage', 'artifacts', 'mse.user.js');

function fixtureUrl(name) { return fs.readFileSync(path.join(FIX, name + '.url'), 'utf8').trim(); }
function fixtureHtml(name) { return fs.readFileSync(path.join(FIX, name + '.html'), 'utf8'); }

/**
 * opts: browser ('webkit'|'chromium'), mode ('content'|'page'|undefined = what Stay would choose),
 *       api(req) -> {status, json|body, headers} | undefined  (mock of https://syncshare.ru/api/),
 *       csp (string, Content-Security-Policy for fixture pages), assets (bool: let the real Moodle assets load),
 *       state (shared Stay state: storage survives), config (written as __SS_STAY_CONFIG__ ahead of the script body)
 */
async function launch(opts = {}) {
  const browserName = opts.browser || process.env.SS_BROWSER || 'webkit';
  const browser = await pw[browserName].launch();
  const device = pw.devices[opts.device || 'iPhone 13'];
  const ctxOpts = Object.assign({}, browserName === 'webkit' ? device : { viewport: device.viewport, userAgent: device.userAgent, deviceScaleFactor: 2, hasTouch: true, isMobile: true }, { locale: opts.locale || 'en-US' });
  let context = await browser.newContext(ctxOpts);
  let source = opts.source || fs.readFileSync(USERJS, 'utf8');
  const script = emu.installScript(source, { forceMode: opts.mode, commentVariant: opts.commentVariant });
  const state = opts.state || {};
  const apiLog = state.apiLog = state.apiLog || [];
  const api = opts.api || (() => undefined);
  const answer = async (via, method, url, headers, body) => {
    const rec = { via, method, url, path: new URL(url).pathname + new URL(url).search, headers: headers || {}, body: body === undefined || body === null ? null : String(body) };
    try { rec.json = rec.body ? JSON.parse(rec.body) : null; } catch (e) { rec.json = undefined; }
    apiLog.push(rec);
    let r = await api(rec);
    if (!r) r = { status: 404, json: { message: 'not mocked' } };
    rec.responseStatus = r.status || 200;
    return r;
  };
  /* GM_xmlhttpRequest path (performed by the Stay extension, outside of the page) */
  state.xhrHandler = async (details) => {
    if (opts.gmDead) return new Promise(() => {});
    if (!/^https:\/\/syncshare\.ru\/api\//.test(details.url)) return { error: true };
    const r = await answer('gm', details.method || 'GET', details.url, details.headers, details.data);
    if (r.networkError) return { error: true };
    const text = r.body !== undefined ? r.body : JSON.stringify(r.json === undefined ? null : r.json);
    return { readyState: 4, status: r.status || 200, statusText: '', responseHeaders: 'content-type: application/json\r\n' + Object.entries(r.headers || {}).map(([k, v]) => k + ': ' + v + '\r\n').join(''), responseText: text, response: text, responseType: '', responseURL: details.url, finalUrl: details.url };
  };
  /* test-only peepholes, installed ahead of everything else */
  if (opts.openShadow) {
    /* the widgets live in closed shadow roots; WebKit has no protocol to look inside, so they are opened */
    await context.addInitScript(() => { const o = Element.prototype.attachShadow; Element.prototype.attachShadow = function (i) { const r = o.call(this, Object.assign({}, i, { mode: 'open' })); (window.__roots = window.__roots || []).push(this); return r; }; });
  }
  if (opts.noBeforeUnload) {
    /* iOS Safari does not fire "beforeunload": nobody gets it here either */
    await context.addInitScript(() => { window.addEventListener('beforeunload', (e) => { e.stopImmediatePropagation(); }, true); });
  }
  if (opts.context) context = opts.context;
  await emu.installStay(context, [script], state);
  /* page fetch path */
  await context.route('https://syncshare.ru/api/**', async (route) => {
    const req = route.request();
    const origin = req.headers().origin || '*';
    const cors = { 'access-control-allow-origin': origin, 'access-control-allow-headers': 'Content-Type,Authorization,X-Requested-With,X-Api-Key,If-None-Match', 'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS', 'access-control-expose-headers': 'X-Request-Ref,ETag', vary: 'Origin' };
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (opts.nativeDead) return route.abort('failed');
    const r = await answer('fetch', req.method(), req.url(), req.headers(), req.postData());
    if (r.networkError) return route.abort('failed');
    return route.fulfill({ status: r.status || 200, headers: Object.assign({ 'content-type': 'application/json' }, cors, r.headers || {}), body: r.body !== undefined ? r.body : JSON.stringify(r.json === undefined ? null : r.json) });
  });
  const docs = {};
  for (const n of fs.readdirSync(FIX).filter((f) => f.endsWith('.url'))) {
    const name = n.replace(/\.url$/, '');
    docs[fixtureUrl(name).split('#')[0]] = name;
  }
  Object.assign(docs, opts.docs || {});
  /* opts.page(url, html): an extra page of its own, for the suites that need a non-quiz page (the personal
     cabinet of Moodle, for instance) — the answer stays a route of the test, never the live site */
  if (typeof opts.page === 'function') docs[opts.pageUrl] = opts.page();
  const fixtureHosts = new Set(Object.keys(docs).map((u) => new URL(u).host));
  /* opts.live: the real site is used instead of the saved pages (the SyncShare API stays mocked) */
  if (!opts.live) await context.route((u) => fixtureHosts.has(u.host), async (route) => {
    const req = route.request();
    const u = req.url().split('#')[0];
    /* the saved page answers the document itself, and a same-page fetch (the extension reads /my/ to learn the id) */
    if (docs[u] && (req.resourceType() === 'document' || req.resourceType() === 'fetch' || req.resourceType() === 'xhr')) {
      const headers = { 'content-type': 'text/html; charset=utf-8' };
      if (opts.csp) headers['content-security-policy'] = opts.csp;
      let body = docs[u].startsWith('<') ? docs[u] : fixtureHtml(docs[u]);
      /* The saved pages are rendered DOM snapshots; Moodle's own scripts would only notice the expired
         demo session and redirect to the login page, so they are dropped unless asked for. */
      /* the snapshot was taken on a desktop viewport with the quiz-navigation drawer open; on a phone it would cover the page */
      body = body.replace('drawer drawer-right show d-print-none', 'drawer drawer-right d-print-none').replace(/(<body[^>]*class="[^"]*)\bdrawer-open-index\b/, '$1');
      if (!opts.keepScripts) body = body.replace(/<script\b[\s\S]*?<\/script>/gi, '').replace(/<link[^>]+rel="(?:modulepreload|preload)"[^>]*>/gi, '');
      /* with a cookie jar of the test, no remote asset is loaded either: pluginfile.php of the saved page
         answers with a Set-Cookie that would overwrite the jar */
      if (state.cookies && state.cookies.length) body = body.replace(/<img\b[^>]*>/gi, '').replace(/<link\b[^>]*rel="(?:icon|shortcut icon|apple-touch-icon)"[^>]*>/gi, '');
      /* no live asset is ever fetched from a saved page: only the document itself is served, everything the page
         would pull (theme scripts, images, ajax) answers with an empty 204. Without this a page loads its own
         "you are not logged in" ajax and the test starts fighting a live site. */
      if (opts.quietAssets !== false && req.resourceType() !== 'document' && !['fetch', 'xhr'].includes(req.resourceType())) {
        return route.fulfill({ status: 204, headers: { 'content-type': 'text/plain' }, body: '' });
      }
      return route.fulfill({ status: 200, headers, body });
    }
    /* like Moodle: saving a quiz page answers with a redirect to the next page (here: the summary) */
    if (req.resourceType() === 'document' && /\/mod\/quiz\/processattempt\.php/.test(u) && opts.afterSubmit !== false) {
      return route.fulfill({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: '<!doctype html><title>saving</title><script>location.replace(' + JSON.stringify(fixtureUrl(opts.afterSubmit || 'summary')) + ')</script>' });
    }
    if (req.resourceType() === 'document' && req.method() === 'GET') {
      /* no live site is ever reached: a page the suite did not save is a plain 404 (after a POST it is the
         "saved" page above, which stands for Moodle's redirect) */
      return route.fulfill({ status: 404, headers: { 'content-type': 'text/html; charset=utf-8' }, body: '<!doctype html><title>not in the fixtures</title><body data-missing="1">' + u.replace(/[<>&]/g, '') + '</body>' });
    }
    if (req.resourceType() === 'document') return route.fulfill({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: '<!doctype html><title>left the saved page</title><body data-left="1">' + req.method() + ' ' + u.replace(/[<>&]/g, '') + '</body>' });
    if (opts.assets === false) return route.abort('failed');
    if (!opts.keepScripts && !['stylesheet', 'image', 'font'].includes(req.resourceType())) return route.abort('failed');
    return route.fallback();
  });
  /* anything else that leaves the browser is recorded and blocked (telemetry hosts etc.) */
  const external = state.external = state.external || [];
  await context.route((u) => !fixtureHosts.has(u.host) && !(u.host === 'syncshare.ru' && u.pathname.startsWith('/api/')) && /^https?:$/.test(u.protocol), async (route) => {
    const u = route.request().url();
    /* a server the suite started itself (the MSE gateway on localhost) is not an outside world: the suite
       says so with allowLocal, and nothing of the live internet is reached through it */
    if (opts.allowLocal && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u)) return route.fallback();
    if (opts.allowExternal && opts.allowExternal(u)) return route.fallback();
    external.push(route.request().method() + ' ' + u);
    return route.abort('failed');
  });
  /* allowLocal: a server the suite started itself (the MSE gateway) is not an outside world. The request is
     performed in node and the answer is handed to the page, CORS included, because Safari in the simulator
     cannot dial the loopback of the host at all */
  if (opts.allowLocal) {
    const lib = require('http');
    const libs = require('https');
    await context.route((u) => /^(127\.0\.0\.1|localhost)$/.test(u.hostname), async (route) => {
      const req = route.request();
      const target = new URL(req.url());
      const origin = req.headers().origin || '*';
      const cors = {
        'access-control-allow-origin': origin,
        'access-control-allow-methods': 'GET,POST,OPTIONS',
        'access-control-allow-headers': 'authorization,content-type,x-admin-token,x-requested-with',
        'access-control-expose-headers': 'x-quota-left,x-mse-status',
        vary: 'Origin'
      };
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      /* the same record as the mocked API: a suite must be able to count what was asked of a local server */
      const rec = {
        via: 'local', method: req.method(), url: req.url(),
        path: target.pathname + target.search, headers: req.headers(),
        body: req.postData() === undefined || req.postData() === null ? null : String(req.postData())
      };
      try { rec.json = rec.body ? JSON.parse(rec.body) : null; } catch (e) { rec.json = undefined; }
      apiLog.push(rec);
      const local = await new Promise((resolve) => {
        const r = (target.protocol === 'https:' ? libs : lib).request({
          hostname: '127.0.0.1', port: target.port, path: target.pathname + target.search, method: req.method(),
          headers: Object.assign({}, req.headers(), { host: target.host }),
          rejectUnauthorized: false
        }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        });
        r.on('error', (e) => resolve({ error: String(e) }));
        // (the log entry is pushed before the call, so a failing local request is counted too)
        const data = req.postData();
        if (data) r.write(data);
        r.end();
      });
      if (local.error) {
        rec.responseStatus = 502;
        console.error('[harness] allowLocal request failed:', local.error, target.href);
        return route.fulfill({ status: 502, headers: Object.assign({ 'content-type': 'application/json' }, cors), body: '{"error":"local request failed"}' });
      }
      const headers = Object.assign({}, cors);
      for (const [k, v] of Object.entries(local.headers)) {
        if (['content-length', 'content-encoding', 'transfer-encoding', 'connection', 'keep-alive', 'access-control-allow-origin'].includes(k)) continue;
        headers[k] = Array.isArray(v) ? v.join(', ') : v;
      }
      rec.responseStatus = local.status;
      return route.fulfill({ status: local.status, headers, body: local.body });
    });
  }
  const logs = [];
  const errors = [];
  context.on('console', (m) => logs.push('[' + m.type() + '] ' + m.text()));
  context.on('weberror', (e) => errors.push(String(e.error())));
  const newPage = async (url) => {
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(String(e && e.stack || e)));
    if (url) await page.goto(url, { waitUntil: 'domcontentloaded' });
    return page;
  };
  return { browser, context, script, state, apiLog, external, logs, errors, newPage, close: () => browser.close(), fixtureUrl };
}

module.exports = { launch, fixtureUrl, fixtureHtml, ROOT, FIX, USERJS, emu };
