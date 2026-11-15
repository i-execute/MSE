'use strict';
/*
 * MSE router — the only thing the outside world talks to.
 *
 * The shape of the stack (and the reason this file is so thin):
 *
 *   iPhone (tailscale client)  ──https──▶  <host>.<tailnet>.ts.net   [tailscale funnel]
 *                                              │
 *                                              ▼  127.0.0.1:MSE_PORT
 *                                     mse-router.js  (this file: access, quota, log)
 *                                              │
 *                                              ▼  127.0.0.1:MSE_UPSTREAM_PORT  (loopback only)
 *                                     AI backend (agy-upstream.js / OpenAI-compatible)
 *
 * The router knows nothing about model keys: the key of the model lives in the backend on the same machine and
 * never leaves the loopback. The router only decides *who* may pass (the device key the extension made up, and
 * the owner let in by Moodle id), counts what they asked, and streams the answer back untouched.
 *
 * It is the same access model as server-mse/mse-server.js — the router is that gateway plus a pure proxy for
 * every other path (`/v1/chat/completions`, `/v1/models`, …), so an allowed device can point any
 * OpenAI-compatible client at it and get the model, while a device nobody let in gets a 401/403 and no bytes.
 *
 * Env: MSE_PORT (8788), MSE_HOST (127.0.0.1), MSE_UPSTREAM_PORT (8799), MSE_UPSTREAM_HOST (127.0.0.1),
 *      MSE_UPSTREAM_KEY (the *device-facing* key of the backend, if it wants one — never the model key),
 *      MSE_DATA_DIR, MSE_ADMIN_TOKEN, MSE_MODEL(S), MSE_DAILY_QUOTA, MSE_ALLOW_ORIGINS, MSE_PUBLIC_URL.
 */
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const here = __dirname;
const DATA_DIR = process.env.MSE_DATA_DIR || path.join(here, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const PORT = Number(process.env.MSE_PORT || 8788);
const HOST = process.env.MSE_HOST || '127.0.0.1';
const VERSION = '2.0.0';
const UPSTREAM_HOST = process.env.MSE_UPSTREAM_HOST || '127.0.0.1';
const UPSTREAM_PORT = Number(process.env.MSE_UPSTREAM_PORT || 8799);
const UPSTREAM_TLS = String(process.env.MSE_UPSTREAM_TLS || '') === '1';
const UPSTREAM_KEY = process.env.MSE_UPSTREAM_KEY || '';

const CFG = {
  upstreamUrl: (UPSTREAM_TLS ? 'https://' : 'http://') + UPSTREAM_HOST + ':' + UPSTREAM_PORT,
  publicUrl: String(process.env.MSE_PUBLIC_URL || '').replace(/\/+$/, ''),
  model: process.env.MSE_MODEL || 'gemini-3-flash',
  models: String(process.env.MSE_MODELS || '').split(',').map((s) => s.trim()).filter(Boolean),
  dailyQuota: Number(process.env.MSE_DAILY_QUOTA || 200),
  allowOrigins: String(process.env.MSE_ALLOW_ORIGINS || '*').split(',').map((s) => s.trim()).filter(Boolean),
  timeoutMs: Number(process.env.MSE_TIMEOUT_MS || 120000)
};

/* ------------------------------------------------------------------ state */
let state = { devices: {}, allow: [], log: [], applications: [] };
function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      state = {
        devices: parsed.devices || {},
        allow: Array.isArray(parsed.allow) ? parsed.allow : [],
        log: Array.isArray(parsed.log) ? parsed.log : [],
        applications: Array.isArray(parsed.applications) ? parsed.applications : []
      };
    }
  } catch (e) { /* first run: the defaults above are the whole state */ }
}
let saveTimer = null;
function saveState() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = STATE_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
      fs.renameSync(tmp, STATE_FILE);
    } catch (e) { console.error('state not saved:', e.message); }
  }, 120);
}
const ADMIN_TOKEN = (() => {
  if (process.env.MSE_ADMIN_TOKEN) return String(process.env.MSE_ADMIN_TOKEN);
  const f = path.join(DATA_DIR, 'admin-token.txt');
  try { const t = fs.readFileSync(f, 'utf8').trim(); if (t) return t; } catch (e) {}
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const t = 'adm_' + crypto.randomBytes(24).toString('base64url');
  fs.writeFileSync(f, t + '\n', { mode: 0o600 });
  return t;
})();

const now = () => Date.now();
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const day = () => new Date().toISOString().slice(0, 10);

/* ------------------------------------------------------------------ plumbing */
function cors(req, res) {
  const origin = req.headers.origin || '';
  const allowed = CFG.allowOrigins.includes('*') ? (origin || '*') : (CFG.allowOrigins.includes(origin) ? origin : '');
  if (allowed) {
    res.setHeader('access-control-allow-origin', allowed);
    res.setHeader('vary', 'Origin');
    res.setHeader('access-control-allow-headers', 'content-type,authorization,x-api-key,x-admin-token,x-requested-with');
    res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
    res.setHeader('access-control-expose-headers', 'x-quota-left,x-mse-status,retry-after');
  }
}
function send(req, res, status, obj, extra) {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  res.writeHead(status, Object.assign({ 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) }, extra || {}));
  res.end(body);
}
function oaiError(req, res, status, message, code) {
  return send(req, res, status, { error: { message, type: 'mse_router', code: code || 'error' } });
}
function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
const parseJson = (t) => { try { return JSON.parse(t || '{}'); } catch (e) { return null; } };
const deviceIdOf = (key) => 'mse-' + sha256(key).slice(0, 16);
function keyOf(req) {
  const auth = String(req.headers.authorization || '');
  const m = /^Bearer\s+([A-Za-z0-9_\-\.]+)$/i.exec(auth.trim());
  if (m) return m[1];
  const api = req.headers['x-api-key'];
  return api ? String(api).trim() : '';
}
const deviceByKey = (key) => (key ? state.devices[deviceIdOf(key)] || null : null);
function quotaOf(rec) {
  if (!rec) return 0;
  if (rec.quotaDay !== day()) { rec.quotaDay = day(); rec.quotaUsed = 0; }
  return Math.max(0, CFG.dailyQuota - (rec.quotaUsed || 0));
}
function note(text, rec) {
  const line = { at: new Date().toISOString(), text };
  if (rec) { line.deviceId = rec.deviceId; line.moodleId = rec.moodleId; }
  state.log.push(line);
  if (state.log.length > 500) state.log = state.log.slice(-400);
  saveState();
}
function isAdmin(req) {
  const t = String(req.headers['x-admin-token'] || req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!t) return false;
  const a = Buffer.from(t), b = Buffer.from(ADMIN_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function publicDevice(rec) {
  return {
    deviceId: rec.deviceId, moodleId: rec.moodleId, name: rec.name, site: rec.site,
    status: rec.status, created: rec.created, seen: rec.seen, requests: rec.requests || 0,
    quota: quotaOf(rec), quotaUsed: rec.quotaUsed || 0, banned: !!rec.banned
  };
}

/* ------------------------------------------------------------------ devices */
function registerDevice(body) {
  const key = String(body.key || '');
  const moodleId = String(body.moodleId || '').trim();
  const name = String(body.name || '').trim().slice(0, 120);
  const site = String(body.site || '').trim().slice(0, 200);
  if (!/^mse_[A-Za-z0-9_-]{32,}$/.test(key)) return { error: 'key must look like mse_<32+ chars>' };
  if (!/^\d{1,12}$/.test(moodleId)) return { error: 'moodleId must be a number' };
  const deviceId = deviceIdOf(key);
  const existing = state.devices[deviceId];
  if (existing && existing.banned) return { error: 'this key was revoked', device: existing };
  const allowed = state.allow.some((a) => String(a.moodleId) === moodleId);
  const rec = {
    deviceId, moodleId, name, site,
    status: allowed ? 'active' : 'pending',
    created: existing ? existing.created : now(),
    seen: now(), requests: existing ? existing.requests || 0 : 0,
    quotaDay: day(), quotaUsed: existing ? existing.quotaUsed || 0 : 0
  };
  state.devices[deviceId] = rec;
  saveState();
  note('register ' + deviceId + ' moodle ' + moodleId + ' → ' + rec.status, rec);
  // a new application is worth a message: the bot picks these up with long polling and pings the owner
  if (!existing && !allowed) {
    state.applications.push({ deviceId, moodleId, name, site, at: now() });
    if (state.applications.length > 40) state.applications.splice(0, state.applications.length - 40);
    saveState();
  }
  return { device: rec };
}

/* ------------------------------------------------------------------ the proxy */
function proxyStream(req, res, bodyText, rec) {
  const url = new URL(CFG.upstreamUrl + req.url);
  const lib = url.protocol === 'https:' ? https : http;
  const headers = { 'content-type': req.headers['content-type'] || 'application/json', accept: req.headers.accept || '*/*' };
  if (UPSTREAM_KEY) headers.authorization = 'Bearer ' + UPSTREAM_KEY;
  const upstream = lib.request({
    method: req.method, hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: url.pathname + url.search, headers, timeout: CFG.timeoutMs
  }, (up) => {
    const pass = {};
    for (const [k, v] of Object.entries(up.headers)) {
      if (['connection', 'keep-alive', 'transfer-encoding', 'content-length', 'content-encoding'].includes(k)) continue;
      pass[k] = v;
    }
    pass['x-quota-left'] = String(quotaOf(rec));
    res.writeHead(up.statusCode || 502, pass);
    up.pipe(res);
    up.on('end', () => { try { res.end(); } catch (e) {} });
    up.on('error', () => { try { res.end(); } catch (e) {} });
  });
  upstream.on('timeout', () => upstream.destroy(new Error('upstream timeout')));
  upstream.on('error', (e) => {
    if (!res.headersSent) return oaiError(req, res, 502, 'AI backend is unreachable: ' + e.message, 'upstream_down');
    try { res.end(); } catch (x) {}
  });
  req.on('close', () => { try { upstream.destroy(); } catch (e) {} });
  if (bodyText) upstream.write(bodyText);
  upstream.end();
  rec.requests = (rec.requests || 0) + 1;
  rec.seen = now();
  /* the quota is counted here, where the bytes actually leave for the model: every proxied call is one */
  quotaOf(rec);
  rec.quotaUsed = (rec.quotaUsed || 0) + 1;
  saveState();
  note('proxy ' + req.method + ' ' + req.url.slice(0, 80), rec);
}

/* ------------------------------------------------------------------ admin */
async function handleAdmin(req, res, url) {
  if (!isAdmin(req)) return oaiError(req, res, 401, 'admin token required', 'admin_denied');
  // the queue of new applications, drained by the bot: /admin/applications?take=1 hands them over and clears them
  if (url.pathname === '/admin/applications' && req.method === 'GET') {
    const take = url.searchParams.get('take') === '1';
    const items = Array.isArray(state.applications) ? state.applications.slice() : [];
    if (take && items.length) { state.applications = []; saveState(); }
    return send(req, res, 200, { ok: true, applications: items, pending: Object.values(state.devices).filter((d) => d.status === 'pending').length });
  }
  if (url.pathname === '/admin/state' && req.method === 'GET') {
    return send(req, res, 200, {
      version: VERSION,
      backend: 'tailscale',
      publicUrl: CFG.publicUrl || null,
      upstream: CFG.upstreamUrl,
      model: CFG.model,
      models: CFG.models.length ? CFG.models : [CFG.model],
      quota: CFG.dailyQuota,
      allow: state.allow,
      devices: Object.values(state.devices).map(publicDevice),
      log: state.log.slice(-50)
    });
  }
  const body = parseJson(await readBody(req)) || {};
  if (url.pathname === '/admin/allow') {
    const moodleId = String(body.moodleId || '').trim();
    if (!/^\d{1,12}$/.test(moodleId)) return oaiError(req, res, 400, 'moodleId must be a number', 'bad_id');
    if (!state.allow.some((a) => String(a.moodleId) === moodleId)) {
      state.allow.push({ moodleId, name: String(body.name || '').trim().slice(0, 120), added: now(), deviceId: null });
    }
    Object.values(state.devices).forEach((d) => {
      if (String(d.moodleId) === moodleId && d.status !== 'active' && !d.banned) {
        d.status = 'active';
        const slot = state.allow.find((a) => String(a.moodleId) === moodleId);
        if (slot && !slot.deviceId) slot.deviceId = d.deviceId;
      }
    });
    saveState();
    note('allow ' + moodleId);
    return send(req, res, 200, { ok: true, allow: state.allow });
  }
  if (url.pathname === '/admin/approve' || url.pathname === '/admin/revoke') {
    const deviceId = String(body.deviceId || '').trim();
    const rec = state.devices[deviceId];
    if (!rec) return oaiError(req, res, 404, 'no such device', 'no_device');
    const revoke = url.pathname === '/admin/revoke';
    rec.status = revoke ? 'revoked' : 'active';
    if (revoke) rec.banned = true; else delete rec.banned;
    saveState();
    note((revoke ? 'revoke ' : 'approve ') + deviceId, rec);
    return send(req, res, 200, { ok: true, device: publicDevice(rec) });
  }
  if (url.pathname === '/admin/disallow') {
    const moodleId = String(body.moodleId || '').trim();
    state.allow = state.allow.filter((a) => String(a.moodleId) !== moodleId);
    Object.values(state.devices).forEach((d) => { if (String(d.moodleId) === moodleId) d.status = 'revoked'; });
    saveState();
    note('disallow ' + moodleId);
    return send(req, res, 200, { ok: true, allow: state.allow });
  }
  if (url.pathname === '/admin/quota') {
    const n = Number(body.quota);
    if (!Number.isFinite(n) || n < 0) return oaiError(req, res, 400, 'quota must be a number >= 0', 'bad_quota');
    CFG.dailyQuota = Math.floor(n);
    saveState();
    note('quota ' + CFG.dailyQuota);
    return send(req, res, 200, { ok: true, quota: CFG.dailyQuota });
  }
  return oaiError(req, res, 404, 'no such admin endpoint', 'not_found');
}

/* ------------------------------------------------------------------ server */
const handler = async (req, res) => {
  cors(req, res);
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  try {
    if (url.pathname === '/health' || url.pathname === '/') {
      return send(req, res, 200, {
        ok: true, name: 'MSE gateway', version: VERSION, role: 'router',
        backend: 'tailscale', publicUrl: CFG.publicUrl || null,
        upstream: { host: UPSTREAM_HOST, port: UPSTREAM_PORT, tls: UPSTREAM_TLS },
        model: CFG.model, models: CFG.models.length ? CFG.models : [CFG.model],
        quota: CFG.dailyQuota, devices: Object.keys(state.devices).length, allow: state.allow.length,
        time: new Date().toISOString()
      });
    }
    if (url.pathname.startsWith('/admin/')) return await handleAdmin(req, res, url);
    if (url.pathname === '/mse/v1/register' && req.method === 'POST') {
      const body = parseJson(await readBody(req));
      if (!body) return oaiError(req, res, 400, 'body must be JSON', 'bad_json');
      const r = registerDevice(body);
      if (r.error) return oaiError(req, res, 400, r.error, 'bad_register');
      res.setHeader('x-mse-status', r.device.status);
      return send(req, res, r.device.status === 'active' ? 200 : 202, {
        ok: true, device: publicDevice(r.device),
        hint: r.device.status === 'active'
          ? 'the key is live: use it as the api key of any OpenAI-compatible client'
          : 'waiting for the owner: Moodle id ' + r.device.moodleId + ' must be allowed (/admin/allow)'
      });
    }
    if (url.pathname === '/mse/v1/me' && req.method === 'GET') {
      const rec = deviceByKey(keyOf(req));
      if (!rec) return oaiError(req, res, 401, 'unknown key: register the device first', 'invalid_key');
      rec.seen = now(); saveState();
      res.setHeader('x-mse-status', rec.status);
      if (rec.status !== 'active') {
        return send(req, res, 403, { ok: false, device: publicDevice(rec), hint: rec.status === 'revoked' ? 'the key was revoked' : 'waiting for approval' });
      }
      return send(req, res, 200, { ok: true, device: publicDevice(rec), model: CFG.model, quota: quotaOf(rec) });
    }
    if (url.pathname === '/v1/models' && req.method === 'GET') {
      /* a device that was not let in is told nothing, not even the list of models */
      const rec = deviceByKey(keyOf(req));
      if (keyOf(req) && rec && rec.status !== 'active') return oaiError(req, res, 403, 'device is ' + rec.status, 'device_' + rec.status);
      const list = (CFG.models.length ? CFG.models : [CFG.model]).map((id) => ({ id, object: 'model', created: 1700000000, owned_by: 'mse' }));
      return send(req, res, 200, { object: 'list', data: list });
    }
    /* everything else is the model: same rule as above — nobody without an active key gets through */
    const key = keyOf(req);
    const rec = deviceByKey(key);
    if (!rec) return oaiError(req, res, 401, 'unknown key: register the device first', 'invalid_key');
    if (rec.status !== 'active') return oaiError(req, res, 403, 'device is ' + rec.status, 'device_' + rec.status);
    const left = quotaOf(rec);
    res.setHeader('x-quota-left', String(left));
    if (left <= 0) {
      res.setHeader('retry-after', '60');
      return oaiError(req, res, 429, 'daily quota is over', 'quota_exceeded');
    }
    const bodyText = req.method === 'POST' ? await readBody(req) : '';
    return proxyStream(req, res, bodyText, rec);
  } catch (e) {
    console.error('unhandled:', (e && e.stack) || e);
    if (!res.headersSent) return oaiError(req, res, 500, 'internal error', 'internal');
    try { res.end(); } catch (x) {}
  }
};

loadState();
const server = http.createServer(handler);
if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log('MSE router ' + VERSION + ' on http://' + HOST + ':' + PORT + '  (public: ' + (CFG.publicUrl || 'not set yet') + ')');
    console.log('  AI backend:', CFG.upstreamUrl, '(loopback only; the model key stays there)');
    console.log('  model     :', CFG.model, '· quota', CFG.dailyQuota, '/day');
    console.log('  admin     :', process.env.MSE_ADMIN_TOKEN ? 'MSE_ADMIN_TOKEN' : path.join(DATA_DIR, 'admin-token.txt'));
  });
}
module.exports = { server, CFG, state: () => state, deviceIdOf, registerDevice, deviceByKey, ADMIN_TOKEN, handler };
