'use strict';
/* Runs the ORIGINAL SyncShare extension (Chrome package, unpacked from the store CRX) in Chromium against
   the same saved pages and the same mock API as the userscript, for side-by-side comparison. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');
const pw = require('playwright');
const { FIX, fixtureHtml, fixtureUrl } = require('./harness.js');

const EXT_DIR = [process.env.SS_ORIGINAL_CRX_DIR, path.join(__dirname, '..', '..', '.original', 'crx'), path.join(__dirname, '..', '..', '..', 'orig', 'crx')]
  .filter(Boolean).find((d) => fs.existsSync(path.join(d, 'manifest.json'))) || path.join(__dirname, '..', '..', '.original', 'crx');
const available = () => fs.existsSync(path.join(EXT_DIR, 'manifest.json'));

function selfSigned() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-cert-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-days', '2', '-subj', '/CN=syncshare.ru', '-addext', 'subjectAltName=DNS:syncshare.ru'], { stdio: 'ignore' });
  return { key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) };
}

/** Local stand-in for https://syncshare.ru (the browser is told to resolve the host to it). */
async function startApiServer(api, apiLog) {
  const server = https.createServer(selfSigned(), (req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const cors = { 'access-control-allow-origin': req.headers.origin || '*', 'access-control-allow-headers': 'Content-Type,Authorization,X-Requested-With,X-Api-Key,If-None-Match', 'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS', 'access-control-expose-headers': 'X-Request-Ref,ETag', vary: 'Origin' };
      if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
      const body = Buffer.concat(chunks).toString('utf8');
      const rec = { via: 'extension', method: req.method, url: 'https://syncshare.ru' + req.url, path: req.url, headers: req.headers, body: body || null };
      try { rec.json = body ? JSON.parse(body) : null; } catch (e) { rec.json = undefined; }
      apiLog.push(rec);
      let r = req.url.startsWith('/api/') ? await api(rec) : { status: 404, body: 'not found' };
      if (!r) r = { status: 404, json: { message: 'not mocked' } };
      rec.responseStatus = r.status || 200;
      const text = r.body !== undefined ? r.body : JSON.stringify(r.json === undefined ? null : r.json);
      res.writeHead(r.status || 200, Object.assign({ 'content-type': 'application/json' }, cors, r.headers || {}));
      res.end(r.status === 204 ? undefined : text);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, port: server.address().port };
}

async function launchOriginal(opts = {}) {
  const apiLog = [];
  const { server, port } = await startApiServer(opts.api || (() => undefined), apiLog);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-prof-'));
  const device = pw.devices['iPhone 13'];
  const context = await pw.chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true, locale: opts.locale || 'en-US',
    viewport: device.viewport, deviceScaleFactor: 2,
    /* the API host goes to the local mock; the error-reporting host of the original is made unreachable so that
       running the original here never reports anything to its developer */
    args: ['--disable-extensions-except=' + EXT_DIR, '--load-extension=' + EXT_DIR, '--host-resolver-rules=MAP syncshare.ru 127.0.0.1:' + port + ', MAP bugs.naloaty.me ~NOTFOUND, MAP *.naloaty.me ~NOTFOUND, MAP cdm.sumjest.ru ~NOTFOUND', '--ignore-certificate-errors'],
  });
  const docs = {};
  for (const n of fs.readdirSync(FIX).filter((f) => f.endsWith('.url'))) docs[fixtureUrl(n.replace(/\.url$/, '')).split('#')[0]] = n.replace(/\.url$/, '');
  Object.assign(docs, opts.docs || {});
  const hosts = new Set(Object.keys(docs).map((u) => new URL(u).host));
  await context.route((u) => hosts.has(u.host), async (route) => {
    const req = route.request(); const u = req.url().split('#')[0];
    if (docs[u] && req.resourceType() === 'document') {
      let body = fixtureHtml(docs[u]);
      body = body.replace('drawer drawer-right show d-print-none', 'drawer drawer-right d-print-none');
      body = body.replace(/<script\b[\s\S]*?<\/script>/gi, '').replace(/<link[^>]+rel="(?:modulepreload|preload)"[^>]*>/gi, '');
      return route.fulfill({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body });
    }
    /* like Moodle: saving a quiz page answers with a redirect to the next page (here: the summary) */
    if (req.resourceType() === 'document' && /\/mod\/quiz\/processattempt\.php/.test(u) && opts.afterSubmit !== false) {
      return route.fulfill({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: '<!doctype html><title>saving</title><script>location.replace(' + JSON.stringify(fixtureUrl(opts.afterSubmit || 'summary')) + ')</script>' });
    }
    if (req.resourceType() === 'document') return route.fulfill({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: '<!doctype html><title>left the saved page</title><body data-left="1">' + req.method() + ' ' + u.replace(/[<>&]/g, '') + '</body>' });
    if (!['stylesheet', 'image', 'font'].includes(req.resourceType())) return route.abort('failed');
    return route.fallback();
  });
  const logs = []; const errors = [];
  context.on('console', (m) => logs.push('[' + m.type() + '] ' + m.text()));
  context.on('weberror', (e) => errors.push(String(e.error())));
  /* the extension opens its consent page right after installation */
  let consent = context.pages().find((p) => /privacy_policy/.test(p.url()));
  if (!consent) consent = await context.waitForEvent('page', { predicate: (p) => /privacy_policy/.test(p.url()), timeout: 15000 }).catch(() => null);
  const result = {
    context, apiLog, logs, errors, consent,
    acceptConsent: async (o = {}) => { if (!o.technical) await consent.locator('#technicalConsent').uncheck(); await consent.locator('#acceptBtn').click(); await consent.waitForEvent('close', { timeout: 5000 }).catch(() => {}); },
    newPage: async (url) => { const page = await context.newPage(); page.on('pageerror', (e) => errors.push(String(e))); if (url) await page.goto(url, { waitUntil: 'domcontentloaded' }); return page; },
    close: async () => { await context.close(); server.close(); fs.rmSync(profile, { recursive: true, force: true }); },
  };
  return result;
}

module.exports = { launchOriginal, available, EXT_DIR };
