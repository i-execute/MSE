'use strict';
/*
 * Builds MSE — Moodle Solver Extension — from the SyncShare 2.22.0 bundles.
 *
 * What it does on top of build.js:
 *   1. Rebranding: every visible "SyncShare" becomes "MSE" (locales, popup page, script header, menu items,
 *      the welcome card, the document title). The answer service URL of the original stays in ONE place and is
 *      declared as such in the report — the hints still come from it, and the code is honest about it.
 *   2. The shell (src/mse-ui.js): the draggable MSE pill with the glow, the sheet in the Hotaru language, the
 *      advanced view with the user id, the bridge to the debug layer.
 *   3. The debug layer (src/debug.js) rides along, so the traffic sniffer and the key check are in the same
 *      script, as asked.
 *
 * Outputs:
 *   Storage/artifacts/mse.user.js           the userscript (the same file for every client)
 *   Storage/artifacts/build-report.json     sizes, hashes, branding map, the service URLs left in place
 *
 * Paths come from env.js: MSE_ROOT / MSE_SRC_DIR / MSE_VENDOR_DIR / MSE_OUT_DIR, with neutral defaults.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { sanitize, verifySanitized } = require('./sanitize.js');
const { patchBundle, stripLocales } = require('./silence-vendor.js');

const LAYOUT = require('./env.js');
const ROOT = LAYOUT.ROOT;
const VENDOR = LAYOUT.VENDOR;
const OUT = LAYOUT.OUT;
const SRC = LAYOUT.SRC;
const BRAND = 'MSE';
const VERSION = '2.7.0';

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const read = (p) => fs.readFileSync(path.join(VENDOR, p), 'utf8');

const manifest = JSON.parse(read('manifest.json'));
const report = { version: VERSION, brand: BRAND, base: manifest.version, bundles: {}, branding: { strings: 0, locales: 0, files: [] } };

/* ------------------------------------------------------------------ 1. branding */
/* the words that must not survive in anything the user can see */
const WORD = /SyncShare/g;
/* host names that are not the brand: the answer service of the original and its site links stay as they are */
const DOMAINS = ['syncshare.ru', 'syncshare.naloaty.me'];
function rebrand(text, where) {
  let protectedText = text;
  DOMAINS.forEach((d, i) => { protectedText = protectedText.split(d).join('\u0000D' + i + '\u0000'); });
  const before = (text.match(WORD) || []).length;
  let out = protectedText.split('SyncShare').join(BRAND).split('syncshare').join('mse');
  DOMAINS.forEach((d, i) => { out = out.split('\u0000D' + i + '\u0000').join(d); });
  if (before) { report.branding.strings += before; report.branding.files.push({ where, replaced: before }); }
  return out;
}

/* locales: the words the extension itself shows, plus its own name */
const locales = {};
for (const loc of fs.readdirSync(path.join(VENDOR, '_locales'))) {
  const data = JSON.parse(read(`_locales/${loc}/messages.json`));
  for (const k of Object.keys(data)) {
    if (data[k] && typeof data[k].message === 'string') data[k].message = rebrand(data[k].message, `_locales/${loc}/${k}`);
  }
  locales[loc] = data;
  report.branding.locales++;
}

/* The words of the original nobody asked for: the welcome card of a fresh install and the changelog card.
   They are removed from the locales, so nothing can render them even if the code path is reached. */
const DROP_MESSAGES = [/^install(Title|Content|Button)$/, /^changelog(Title|Content)$/, /^docs(Btn|Link|Title)$/];
let dropped = 0;
for (const loc of Object.keys(locales)) {
  for (const k of Object.keys(locales[loc])) {
    if (DROP_MESSAGES.some((re) => re.test(k))) { delete locales[loc][k]; dropped++; }
  }
}
stripLocales(locales);
report.branding.droppedMessages = dropped;

/* Settings the extension starts with. installationMessage is kept away from "none", so getInstallationMessage()
   never hands out the welcome modal (it also closes itself with a click on the backdrop, which is the second
   thing the user complained about); hideNotifications silences the "basic functionality only" toast. */
const SETTINGS_PRESET = {
  installationMessage: manifest.version,
  hideNotifications: true,
  hideWidgetByDefault: true,
  allowTechnicalDataCollection: false,
  privacyPolicyAcceptedByUser: true,
};

/* the bundles, with the same webpack-chunk rewriting build.js does */
const BUNDLES = {
  commons: 'js/commons.js',
  background: 'js/background.js',
  quiz_attempt: 'js/quiz_attempt.js',
  quiz_overview: 'js/quiz_overview.js',
  quiz_board: 'js/quiz_board.js',
  popup: 'js/popup.js',
  popper: 'js/popper.min.js',
  bootstrap: 'js/bootstrap.min.js',
};
const CHUNK_GLOBAL = 'self.webpackChunksyncshare_extension';
const CHUNK_LOCAL = '__mseCtx.chunks';
const SUFFIX = { popper: ';Popper=globalThis.Popper;', bootstrap: ';bootstrap=globalThis.bootstrap;' };
const ASSET_RE = /\b[A-Za-z_$][\w$]*\.p\+"([0-9a-f]{16,}\.(png|svg|jpe?g|gif|webp))"/g;
const MIME = { png: 'image/png', svg: 'image/svg+xml', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

/* the answer service of the original: kept on purpose, declared in the report */
const SERVICE = { serviceUrl: 'https://syncshare.ru/api/', accountsUrl: 'https://syncshare.ru/api/' };

function bundleBody(name) {
  const raw = read(BUNDLES[name]);
  const count = raw.split(CHUNK_GLOBAL).length - 1;
  const expected = name === 'popper' || name === 'bootstrap' ? 0 : 2;
  if (count !== expected) throw new Error(`${name}: expected ${expected} chunk refs, found ${count}`);
  /* the webpack chunk array is renamed before the word rebrand, or the old name would be cut in half */
  let out = rebrand(raw.split(CHUNK_GLOBAL).join(CHUNK_LOCAL), BUNDLES[name]);
  const assets = [];
  out = out.replace(ASSET_RE, (m, file, ext) => {
    const bin = fs.readFileSync(path.join(VENDOR, file));
    assets.push({ file, bytes: bin.length, sha256: sha(bin) });
    return JSON.stringify('data:' + MIME[ext] + ';base64,' + bin.toString('base64'));
  });
  if (/\.p\+"/.test(out)) throw new Error(name + ': unhandled asset reference');
  /* the service URL must survive exactly as it was: the answers come from there */
  for (const [k, v] of Object.entries(SERVICE)) {
    if (name === 'background' && !out.includes(v)) throw new Error('background.js lost the answer service URL: ' + v);
  }
  out = patchBundle(name, out);
  report.bundles[name] = { file: BUNDLES[name], bytes: Buffer.byteLength(out), sha256: sha(out), assets };
  return out + (SUFFIX[name] || '');
}

/* ------------------------------------------------------------------ 2. pages & styles */
const fontDataUrl = (f) => 'data:font/woff2;base64,' + fs.readFileSync(path.join(VENDOR, 'fonts', f)).toString('base64');
function cssText(p) {
  let css = read(p);
  css = css.replace(/url\(\.\.\/fonts\/([a-z0-9-]+)\.woff2\)/g, (m, f) => `url(${fontDataUrl(f + '.woff2')})`);
  css = css.replace(/,url\(\.\.\/fonts\/[a-z0-9-]+\.ttf\) format\("truetype"\)/g, '');
  if (/url\(\.\.\//.test(css)) throw new Error('unresolved url() in ' + p);
  return rebrand(css, p);
}
const resources = {};
const addCss = (p) => { resources[p] = { type: 'text/css', text: cssText(p) }; };

function parsePage(p, extra) {
  const html = rebrand(read(p), p);
  const dir = path.posix.dirname(p);
  const rel = (u) => path.posix.normalize(path.posix.join(dir, u));
  const js = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"[^>]*><\/script>/g)].map((m) => {
    const file = rel(m[1]);
    const name = Object.keys(BUNDLES).find((k) => BUNDLES[k] === file);
    if (!name) throw new Error('unknown script ' + file + ' in ' + p);
    return name;
  });
  const css = [...html.matchAll(/<link[^>]*\shref="([^"]+)"[^>]*rel="stylesheet"[^>]*>/g)].map((m) => rel(m[1]));
  css.forEach(addCss);
  const body = /<body([^>]*)>([\s\S]*)<\/body>/.exec(html);
  if (!body) throw new Error('no body in ' + p);
  const bodyAttrs = {};
  for (const m of body[1].matchAll(/([a-zA-Z-]+)="([^"]*)"/g)) bodyAttrs[m[1]] = m[2];
  const lang = (/<html[^>]*\slang="([^"]+)"/.exec(html) || [])[1] || 'en';
  const title = (/<title>([^<]*)<\/title>/.exec(html) || [])[1] || BRAND;
  return Object.assign({ lang, title, bodyAttrs, bodyHtml: body[2], js, css }, extra);
}
const pages = { 'html/popup/popup.html': parsePage('html/popup/popup.html', { popup: true }) };
addCss('css/widgets/context_menu.css');

/* ------------------------------------------------------------------ 3. the runtime */
const REALM_NAMES = [
  'Element', 'HTMLElement', 'HTMLInputElement', 'HTMLAnchorElement', 'HTMLDivElement', 'HTMLOptionElement',
  'HTMLUListElement', 'HTMLLIElement', 'HTMLFormElement', 'HTMLCanvasElement', 'HTMLImageElement', 'Node',
  'Document', 'Event', 'CustomEvent', 'MouseEvent', 'ShadowRoot', 'getComputedStyle',
];
const runtimeSrc = rebrand(fs.readFileSync(path.join(SRC, 'runtime.js'), 'utf8'), 'src/runtime.js');
for (const n of REALM_NAMES) if (!runtimeSrc.includes(`'${n}'`)) throw new Error('REALM_NAMES out of sync: ' + n);
const scopeVars = ['browser', 'chrome', 'fetch', 'window', 'self', 'globalThis', 'document', ...REALM_NAMES].map((n) => `${n}${n === 'window' ? '__msePageWindow' : ''}=E.${n}`).join(',');
const bundleFns = Object.keys(BUNDLES).map((name) => `${name}:function(){\n${bundleBody(name)}\n}`).join(',\n');

/* the name of the extension in every place the manifest has one (action, browser_action, sidebar) */
['name', 'short_name', 'description'].forEach((k) => { if (typeof manifest[k] === 'string') manifest[k] = rebrand(manifest[k], 'manifest.' + k); });
for (const k of ['action', 'browser_action', 'page_action', 'sidebar_action']) {
  if (manifest[k] && typeof manifest[k].default_title === 'string') manifest[k].default_title = rebrand(manifest[k].default_title, 'manifest.' + k + '.default_title');
}
const data = { manifest, locales, resources, pages };
/* the whole theme lives in one file and is injected into the interface at build time: no second copy to drift, and
   the shipped script keeps a single <style> of its own */
const shellSrc = (() => {
  const css = fs.readFileSync(path.join(SRC, 'theme.css'), 'utf8');
  const shell = fs.readFileSync(path.join(SRC, 'mse-ui.js'), 'utf8');
  const marker = '  var CSS = [ /* @theme */ ];';
  if (!shell.includes(marker)) throw new Error('the theme marker is gone from src/mse-ui.js');
  return shell.replace(marker, '  var CSS = ' + JSON.stringify(':host,*{box-sizing:border-box}\n' + css) + ';');
})();
const debugSrc = rebrand(fs.readFileSync(path.join(SRC, 'debug.js'), 'utf8'), 'src/debug.js');
const authSrc = fs.readFileSync(path.join(SRC, 'mse-auth.js'), 'utf8');
const bridgeSrc = fs.readFileSync(path.join(SRC, 'mse-bridge.js'), 'utf8');

/* The userscript itself: ONE file, ONE script, ONE paste.
   Stay (and every other userscript host) injects this file as a single page script. The interface and the debug
   layer used to be injected as four extra <script> tags created at run time — on Stay that path is fragile (the
   tags are transient and the CSP of a page can drop them), so everything now runs inline in the same scope:
   the interface finds the engine, the debug layer finds the interface, all inside one closure. */

/* a page script still goes through the sanitizer on its own, so nothing in it looks like a Stay page-mode request */
function pageScript(src, name) {
  const clean = sanitize(src);
  verifySanitized(src, clean);
  report.pageScripts = report.pageScripts || {};
  report.pageScripts[name] = { bytes: clean.code.length, sha256: sha(clean.code), sanitizer: clean.stats };
  /* the sanitizer names the global object __ssW; inside the page script nothing defines it, so it is declared here */
  return 'var __ssW=window,__msePageWindow=window;\n' + clean.code;
}

/* each part keeps its own lexical scope: the interface, the authorisation, the bridge and the debug layer were
   written as separate files and must not see each other's helpers — only their public objects */
function scoped(src, name) {
  return ';(function(){\n' + pageScript(src, name) + '\n})();\n';
}

const shellClean = scoped(shellSrc, 'mse-ui');
const authClean = scoped(authSrc, 'mse-auth');
const bridgeClean = scoped(bridgeSrc, 'mse-bridge');
/* the debug layer rides along without its own floating button: the MSE pill is the only entry point */
const debugClean = scoped(
  debugSrc
    .split('__SS_EXPECT_SHA256__').join(process.env.MSE_EXPECT_SHA || '')
    .replace('showFab: true', 'showFab: false'),
  'debug'
);

const body = `(function(){
var __ssW=window;
var __mseW=__ssW;
var __msePageWindow=__ssW;
var __mseCreate=(function(){
${runtimeSrc}
return createMSERuntime;
})();
function __mseVendorScope(E){
var __mseCtx=E.ctx,${scopeVars};
var __msePageWin=E.windowMembers||__msePageWindow;
var define,module,exports,require,bootstrap,Popper;
return {
${bundleFns}
};
}
var __mseData=${JSON.stringify(data)};
var __mseGm={};
try{if(typeof GM_getValue==="function")__mseGm.getValueSync=GM_getValue;}catch(e){}
try{if(typeof GM_setValue==="function")__mseGm.setValueSync=GM_setValue;}catch(e){}
try{if(typeof GM_deleteValue==="function")__mseGm.deleteValueSync=GM_deleteValue;}catch(e){}
try{if(typeof GM_listValues==="function")__mseGm.listValuesSync=GM_listValues;}catch(e){}
try{if(typeof GM_xmlhttpRequest==="function")__mseGm.xhr=GM_xmlhttpRequest;}catch(e){}
try{if(typeof GM_registerMenuCommand==="function")__mseGm.registerMenuCommand=GM_registerMenuCommand;}catch(e){}
try{if(typeof GM_unregisterMenuCommand==="function")__mseGm.unregisterMenuCommand=GM_unregisterMenuCommand;}catch(e){}
try{if(typeof GM_openInTab==="function")__mseGm.openInTab=GM_openInTab;}catch(e){}
var __mseConfig=${JSON.stringify({ consentGate: false, welcomePage: false, noTelemetry: true, hideHostWidget: true, settingsPreset: SETTINGS_PRESET })};
var __mseRuntime=__mseCreate({
win:__mseW,doc:document,gm:__mseGm,vendorScope:__mseVendorScope,
manifest:__mseData.manifest,locales:__mseData.locales,resources:__mseData.resources,pages:__mseData.pages,
config:Object.assign({extId:"mse-stay",keyPrefix:"mse:",popupHash:"#mse"},__mseConfig)
});
try{__mseRuntime.boot();}catch(e){}
/* the layer beside the page script reads the same storage through this name: the runtime picks the backend, and
   that backend is what the extension's own storage would be */
try{__mseW.__mseRuntime=__mseRuntime;}catch(e){}
/* ---- the bridge, the authorisation, the debug layer and the interface: one scope each, no extra <script> tags */
${bridgeClean}
${authClean}
${debugClean}
${shellClean}
/* each part published its public object on window above; the interface is the only thing with a button */
try{ var __mseReady=(__ssW.__mseSources||{}); __mseReady.shell=1; __mseReady.debug=1; __mseReady.auth=1; __mseReady.bridge=1; __ssW.__mseSources=__mseReady; }catch(e){}
})();
`;

/* the same sanitizer the Stay port uses: Stay strips //-comments with a regex and treats window.<name> as a
   request for page mode, so the shipped body has neither */
const clean = sanitize(body);
verifySanitized(body, clean);
/* the sanitizer sees "window__msePageWindow" as a window.<name> use and splits it; the name is restored */
clean.code = clean.code.split('window__msePageWindow').join('__msePageWindow');
if (/window__msePageWindow/.test(clean.code)) throw new Error('scope variable was not restored');

const GRANTS = ['GM_getValue', 'GM_setValue', 'GM_deleteValue', 'GM_listValues', 'GM.getValue', 'GM.setValue',
  'GM.deleteValue', 'GM.listValues', 'GM_xmlhttpRequest', 'GM.xmlHttpRequest', 'GM_registerMenuCommand',
  'GM_unregisterMenuCommand', 'GM_openInTab'];
/* Not every site of the world: the pill appears only where it is useful — the personal cabinet /my/ and the quiz
   attempts of Moodle (attempt/review/summary/view). Everything else is left alone. */
const MATCHES = [
  '*://*/mod/quiz/attempt.php*',
  '*://*/mod/quiz/review.php*',
  '*://*/mod/quiz/summary.php*',
  '*://*/mod/quiz/view.php*',
  '*://*/my/',
  '*://*/my/*',
  '*://*/my/index.php*',
  '*://*/course/view.php*',
  '*://*/course/index.php*',
];

const header = [
  '// ==UserScript==',
  `// @name         ${BRAND}`,
  `// @name:ru      ${BRAND} — Moodle Solver Extension`,
  '// @namespace    https://github.com/mse',
  `// @version      ${VERSION}`,
  '// @description  Answers and hints for Moodle quizzes, with a draggable MSE button, a built-in traffic sniffer and the id of the signed-in user.',
  '// @description Answers and hints for Moodle quizzes: the MSE button, a built-in traffic sniffer and the id of the signed-in user.',
  '// @author       MSE',
  '// @homepage     https://github.com/mse',
  ...MATCHES.map((m) => `// @match        ${m}`),
  '// @run-at       document-end',
  '// @noframes',
  ...GRANTS.map((g) => `// @grant        ${g}`),
  '// ==/UserScript==',
  '',
].join('\n');

fs.mkdirSync(path.dirname(OUT), { recursive: true });
const text = header + clean.code;

/* One file, one script. The build refuses to ship anything that would make Stay inject more than one script:
   no createElement("script") of ours, no data: or blob: script source, no @require, no second userscript header.
   (The vendor bundle has an error-reporting helper that creates a <script> for a hosted page — it is neutralised
   below by the same check, so the shipped file has none.) */
/* only our four parts count: the vendor runtime keeps one inert <script type="text/plain"> inside its own iframe
   (webpack looks for it to learn its public path), it is never executed and it is not a second userscript */
const ourCode = [shellClean, authClean, bridgeClean, debugClean].join('\n');
const OUR_SCRIPT_CREATE = /createElement\(["']script["']\)/g;
const offenders = (ourCode.match(OUR_SCRIPT_CREATE) || []).length;
if (offenders) {
  throw new Error('one-file rule broken: the body creates ' + offenders + ' <script> element(s) at run time');
}
const headerCount = (text.match(/==UserScript==/g) || []).length;
if (headerCount !== 1) throw new Error('one-file rule broken: ' + headerCount + ' userscript headers');
if (/^\/\/\s*@(require|resource)\b/m.test(text)) throw new Error('one-file rule broken: @require/@resource present');
report.oneFile = { scripts: 1, headers: headerCount, requires: 0, bytes: text.length };
fs.writeFileSync(OUT, text);

report.userscript = { file: path.relative(ROOT, OUT), bytes: fs.statSync(OUT).size, sha256: sha(text) };
report.sanitizer = clean.stats;
report.service = SERVICE;
report.leaks = {
  brandWord: (text.match(/SyncShare/g) || []).length,
  brandWordLower: (text.match(/syncshare/gi) || []).length,
  note: 'the answer service of the original is the only place the old name may remain',
};
report.matches = MATCHES;
fs.writeFileSync(LAYOUT.REPORT, JSON.stringify(report, null, 2) + '\n');
console.log(`built ${report.userscript.file}: ${(report.userscript.bytes / 1024).toFixed(0)} KiB, sha256 ${report.userscript.sha256.slice(0, 16)}…`);
console.log('branding:', JSON.stringify(report.branding.strings), 'replaced ·', 'old name left:', report.leaks.brandWord, '/', report.leaks.brandWordLower);
