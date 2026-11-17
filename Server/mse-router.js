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
 * Env: MSE_PORT, MSE_HOST (127.0.0.1), MSE_UPSTREAM_PORT, MSE_UPSTREAM_HOST (127.0.0.1),
 *      MSE_UPSTREAM_KEY (the *device-facing* key of the backend, if it wants one — never the model key),
 *      MSE_DATA_DIR, MSE_ADMIN_TOKEN, MSE_MODEL(S), MSE_DAILY_QUOTA, MSE_ALLOW_ORIGINS, MSE_PUBLIC_URL.
 */
const http = require('http');
const https = require('https');
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { StringDecoder } = require('string_decoder');
const dumps = require('./mse-dumps');

const here = __dirname;
/* One data directory, and it is not the code directory: an update wipes /opt/mse, so state, the admin token and the
   goygram vault all live under MSE_DATA_DIR (/var/lib/mse on a real install). The default keeps a bare
   `node mse-router.js` from a checkout working, but the install always passes the real path. */
const DATA_DIR = path.resolve(process.env.MSE_DATA_DIR || process.env.MSE_STATE_DIR || path.join(require('os').homedir(), '.local', 'share', 'mse'));
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const VAULT_FILE = path.join(DATA_DIR, 'default.vault');
/* goygram keeps its session vault in the working directory unless it is told otherwise: point it at the data
   directory before anything can read it, so a vault is never written into the code tree */
process.env.GOYGRAM_VAULT = process.env.GOYGRAM_VAULT || VAULT_FILE;
process.env.MSE_BOT_VAULT = process.env.MSE_BOT_VAULT || VAULT_FILE;
const PORT = Number(process.env.MSE_PORT);
const HOST = process.env.MSE_HOST || '127.0.0.1';
const VERSION = '2.7.0';
const UPSTREAM_HOST = process.env.MSE_UPSTREAM_HOST || '127.0.0.1';
const UPSTREAM_PORT = Number(process.env.MSE_UPSTREAM_PORT);
const UPSTREAM_TLS = String(process.env.MSE_UPSTREAM_TLS || '') === '1';
const UPSTREAM_KEY = process.env.MSE_UPSTREAM_KEY || '';

/* SOCKS5 proxy client helper for AI_PROXY (format: socks5://<host>:<port>) */
function createSocksConnection(proxyUrlStr, targetHost, targetPort, timeoutMs, onConnect) {
  let proxyUrl;
  try { proxyUrl = new URL(proxyUrlStr); } catch (e) { return onConnect(e); }
  const s = net.connect({ host: proxyUrl.hostname, port: Number(proxyUrl.port) || 1080 });
  let done = false;
  function finish(err, sock) {
    if (done) return;
    done = true;
    s.removeAllListeners('error');
    s.removeAllListeners('timeout');
    if (err) { try { s.destroy(); } catch (_) {} onConnect(err); }
    else onConnect(null, sock);
  }
  s.setTimeout(timeoutMs || 15000, () => finish(new Error('SOCKS5 proxy connection timeout')));
  s.on('error', (e) => finish(e));
  s.once('connect', () => {
    // 1. SOCKS5 greeting: VER=5, NMETHODS=1, METHODS=[0 (no auth)]
    s.write(Buffer.from([0x05, 0x01, 0x00]));
    s.once('data', (greetingResp) => {
      if (greetingResp[0] !== 0x05 || greetingResp[1] !== 0x00) {
        return finish(new Error('SOCKS5 proxy authentication rejected: ' + greetingResp[1]));
      }
      // 2. CONNECT request: VER=5, CMD=1, RSV=0, ATYP=3 (domain), DOMAIN, PORT
      const hostBuf = Buffer.from(targetHost, 'utf8');
      const reqBuf = Buffer.alloc(4 + 1 + hostBuf.length + 2);
      reqBuf[0] = 0x05;
      reqBuf[1] = 0x01;
      reqBuf[2] = 0x00;
      reqBuf[3] = 0x03; // domain name
      reqBuf[4] = hostBuf.length;
      hostBuf.copy(reqBuf, 5);
      reqBuf.writeUInt16BE(targetPort, 5 + hostBuf.length);
      s.write(reqBuf);
      s.once('data', (connectResp) => {
        if (connectResp[0] !== 0x05 || connectResp[1] !== 0x00) {
          return finish(new Error('SOCKS5 connection failed, status: ' + connectResp[1]));
        }
        s.setTimeout(0);
        finish(null, s);
      });
    });
  });
}

/* The one place a model name is written: MSE_MODEL is a *default*, not a list. The list itself comes from the local
   OpenAI-compatible backend (GET /v1/models) and is cached here; nothing else in the code names a model. */
const CFG = {
  upstreamUrl: (UPSTREAM_TLS ? 'https://' : 'http://') + UPSTREAM_HOST + ':' + UPSTREAM_PORT,
  publicUrl: String(process.env.MSE_PUBLIC_URL || '').replace(/\/+$/, ''),
  model: String(process.env.MSE_MODEL || '').trim(),
  models: [],                       // filled from the backend, never from a file
  modelsSource: 'unknown',          // backend | state | none
  modelsAt: 0,
  dailyQuota: Number(process.env.MSE_DAILY_QUOTA || 200),
  allowOrigins: String(process.env.MSE_ALLOW_ORIGINS || '*').split(',').map((s) => s.trim()).filter(Boolean),
  timeoutMs: Number(process.env.MSE_TIMEOUT_MS || 120000),
  aiProxy: String(process.env.AI_PROXY || '').trim()
};

/* ------------------------------------------------------------------ state */
function ensureDataDir() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    fs.chmodSync(DATA_DIR, 0o700);
    return true;
  } catch (e) {
    console.error('data directory cannot be created:', DATA_DIR, '-', e.message);
    return false;
  }
}
ensureDataDir();

/* settings that the owner changes from the panel are part of the state too: without them a restart silently
   put the quota back to the value from the environment */
let state = { devices: {}, allow: [], log: [], applications: [], dumpNotifications: [], settings: {} };
function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      state = {
        devices: parsed.devices || {},
        allow: Array.isArray(parsed.allow) ? parsed.allow : [],
        log: Array.isArray(parsed.log) ? parsed.log : [],
        applications: Array.isArray(parsed.applications) ? parsed.applications : [],
        dumpNotifications: Array.isArray(parsed.dumpNotifications) ? parsed.dumpNotifications : [],
        settings: parsed.settings && typeof parsed.settings === 'object' ? parsed.settings : {}
      };
      const q = Number(state.settings.dailyQuota);
      if (Number.isFinite(q) && q >= 0) CFG.dailyQuota = Math.floor(q);
      const envModel = String(process.env.MSE_MODEL || '').trim();
      if (envModel) {
        CFG.model = envModel;
      } else {
        const m = String(state.settings.model || '').trim();
        if (m) CFG.model = m;
      }
      const cached = Array.isArray(state.settings.models) ? state.settings.models.filter((x) => typeof x === 'string' && x.trim()) : [];
      if (cached.length) { CFG.models = cached; CFG.modelsSource = 'state'; }
    }
  } catch (e) { /* first run: the defaults above are the whole state */ }
}
let saveTimer = null;
function saveState() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      ensureDataDir();
      const tmp = STATE_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
      fs.renameSync(tmp, STATE_FILE);
    } catch (e) { console.error('state not saved:', e.message); }
  }, 120);
}
function saveStateNow() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  ensureDataDir();
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1), {mode:0o600});
  fs.renameSync(tmp, STATE_FILE);
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
function deviceByKey(key) {
  const rec = key ? state.devices[deviceIdOf(key)] : null;
  if (!rec) return null;
  const digest = sha256(key);
  if (rec.keyHash) {
    const a = Buffer.from(rec.keyHash), b = Buffer.from(digest);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  } else { rec.keyHash = digest; saveState(); } // migrate legacy records on first use
  return rec;
}
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
    deviceId: rec.deviceId, moodleId: rec.moodleId, name: rec.name, site: rec.site, deviceName: rec.deviceName || "",
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
  const deviceName = String(body.deviceName || '').trim().slice(0, 120);
  if (!/^mse_[A-Za-z0-9_-]{32,}$/.test(key)) return { error: 'invalid key' };
  if (!/^\d{1,12}$/.test(moodleId)) return { error: 'moodleId must be a number' };
  const deviceId = deviceIdOf(key);
  const existing = state.devices[deviceId];
  if (existing && !deviceByKey(key)) return { error: 'invalid key' };
  if (existing && existing.banned) return { error: 'this key was revoked', device: existing };
  // The identity and approval of an existing key are immutable through registration.
  if (existing && (existing.moodleId !== moodleId || existing.site !== site)) return { error: 'key already bound to another identity' };
  const rec = existing || { deviceId, keyHash: sha256(key), moodleId, name, site, deviceName, status: 'pending',
    created: now(), seen: now(), requests: 0, quotaDay: day(), quotaUsed: 0 };
  rec.seen = now();
  if (deviceName) rec.deviceName = deviceName;
  state.devices[deviceId] = rec;
  saveState();
  if (!existing) {
    note('register ' + deviceId + ' moodle ' + moodleId + ' → pending', rec);
    state.applications.push({ deviceId, moodleId, name, site, deviceName, at: now() });
    if (state.applications.length > 40) state.applications.splice(0, state.applications.length - 40);
    saveState();
  }
  return { device: rec };
}

function getCandidateModels(requestedModel) {
  const envModel = String(process.env.MSE_MODEL || '').trim();
  const primary = requestedModel || envModel || CFG.model || (CFG.models && CFG.models[0]) || '';
  const candidates = [];
  if (primary) candidates.push(primary);
  (CFG.models || []).forEach((m) => {
    if (m && !candidates.includes(m)) candidates.push(m);
  });
  return candidates;
}

/* ------------------------------------------------------------------ the proxy */
function proxyStream(req, res, bodyText, rec) {
  let bodyObj = null;
  if (bodyText && req.method === 'POST' && req.url.startsWith('/v1/chat/completions')) {
    bodyObj = parseJson(bodyText);
  }
  const isChat = !!(bodyObj && typeof bodyObj === 'object');
  const envModel = String(process.env.MSE_MODEL || '').trim();
  if (isChat && (!bodyObj.model || !String(bodyObj.model).trim())) {
    bodyObj.model = envModel || CFG.model || (CFG.models && CFG.models[0]) || '';
  }
  const candidates = isChat ? getCandidateModels(bodyObj.model) : [null];
  let candidateIdx = 0;

  function trySend() {
    const activeModel = candidates[candidateIdx];
    let activeBody = bodyText;
    if (isChat && activeModel) {
      bodyObj.model = activeModel;
      activeBody = JSON.stringify(bodyObj);
    }
    const url = new URL(CFG.upstreamUrl + req.url);
    const lib = url.protocol === 'https:' ? https : http;
    const headers = { 'content-type': req.headers['content-type'] || 'application/json', accept: req.headers.accept || '*/*' };
    if (UPSTREAM_KEY) headers.authorization = 'Bearer ' + UPSTREAM_KEY;
    if (activeBody) headers['content-length'] = Buffer.byteLength(activeBody);

    const reqOpts = {
      method: req.method, hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search, headers, timeout: CFG.timeoutMs
    };
    if (CFG.aiProxy) {
      reqOpts.createConnection = (options, cb) => {
        createSocksConnection(CFG.aiProxy, options.hostname || url.hostname, Number(options.port) || (url.protocol === 'https:' ? 443 : 80), CFG.timeoutMs, cb);
      };
    }

    const upstream = lib.request(reqOpts, (up) => {
      if (isChat && up.statusCode === 503 && candidateIdx + 1 < candidates.length) {
        candidateIdx++;
        note('chat model ' + activeModel + ' 503 → fallback to ' + candidates[candidateIdx], rec);
        up.resume();
        return trySend();
      }
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
      if (isChat && candidateIdx + 1 < candidates.length) {
        candidateIdx++;
        return trySend();
      }
      if (!res.headersSent) return oaiError(req, res, 502, 'AI backend is unreachable: ' + e.message, 'upstream_down');
      try { res.end(); } catch (x) {}
    });
    req.on('close', () => { try { upstream.destroy(); } catch (e) {} });
    if (activeBody) upstream.write(activeBody);
    upstream.end();
  }

  trySend();
  rec.requests = (rec.requests || 0) + 1;
  rec.seen = now();
  /* the quota is counted here, where the bytes actually leave for the model: every proxied call is one */
  quotaOf(rec);
  rec.quotaUsed = (rec.quotaUsed || 0) + 1;
  saveState();
  note('proxy ' + req.method + ' ' + req.url.slice(0, 80), rec);
}

/* ------------------------------------------------------------------ models */
/* The backend is the only source of truth about models. Ask it, cache the answer, and keep the owner's default
   honest: a default the backend does not offer is reported out loud and replaced by the first one it does offer. */
function modelsFallback() {
  const saved = Array.isArray(state.settings && state.settings.models) ? state.settings.models : [];
  return saved.filter((m) => typeof m === 'string' && m.trim()).map((m) => m.trim());
}
function refreshModels() {
  return new Promise((resolve) => {
    let done = false;
    const finish = (list, source, reason) => {
      if (done) return;
      done = true;
      if (list && list.length) {
        CFG.models = list;
        CFG.modelsSource = source;
        CFG.modelsAt = now();
        state.settings = Object.assign({}, state.settings, { models: list.slice(0, 100) });
        const envModel = String(process.env.MSE_MODEL || '').trim();
        const wanted = envModel || CFG.model;
        if (wanted && list.includes(wanted)) {
          CFG.model = wanted;
        } else if (!wanted) {
          CFG.model = list[0];
          note('model default taken from the backend: ' + CFG.model);
        } else {
          const previous = wanted;
          CFG.model = list[0];
          console.error('model "' + previous + '" is not offered by the backend; using "' + CFG.model + '"');
          note('model ' + previous + ' is not offered by the backend → ' + CFG.model);
        }
        saveState();
      } else {
        CFG.models = [];
        CFG.modelsSource = 'none';
        if (reason) console.error('the backend did not answer /v1/models:', reason);
      }
      resolve({ ok: !!(list && list.length), models: CFG.models, source: CFG.modelsSource, reason: reason || null });
    };
    const url = new URL(CFG.upstreamUrl + '/v1/models');
    const lib = url.protocol === 'https:' ? https : http;
    const headers = { accept: 'application/json' };
    if (UPSTREAM_KEY) headers.authorization = 'Bearer ' + UPSTREAM_KEY;
    const reqOpts = {
      method: 'GET', hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname, headers, timeout: 8000
    };
    if (CFG.aiProxy) {
      reqOpts.createConnection = (options, cb) => {
        createSocksConnection(CFG.aiProxy, options.hostname || url.hostname, Number(options.port) || (url.protocol === 'https:' ? 443 : 80), 8000, cb);
      };
    }
    const req = lib.request(reqOpts, (up) => {
      const chunks = [];
      up.on('data', (c) => chunks.push(c));
      up.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const parsed = parseJson(raw);
        if (up.statusCode >= 400) return finish(null, 'none', 'the backend answered ' + up.statusCode);
        const rows = parsed && Array.isArray(parsed.data) ? parsed.data : (Array.isArray(parsed) ? parsed : []);
        const ids = rows.map((r) => (typeof r === 'string' ? r : r && (r.id || r.name))).filter(Boolean).map(String);
        if (!ids.length) return finish(null, 'none', 'the backend named no model');
        finish(Array.from(new Set(ids)), 'backend', null);
      });
      up.on('error', (e) => finish(null, 'none', e.message));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => finish(null, 'none', e.message));
    req.end();
  });
}

/* ------------------------------------------------------------------ the agent */
/* The extension asks "which of these options is the answer". The router does the whole job locally: it builds the
   chat-completions call, sends it to the local backend and parses the reply against the offered options. The
   backend never hears about /mse/*, so it cannot answer "not found: /mse/v1/agent" any more. */
function extractJson(text) {
  const m = /\{[\s\S]*\}/.exec(String(text || ''));
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (e) { return null; }
}
function buildAgentPrompt(body) {
  const options = Array.isArray(body.options) ? body.options.map((o, i) => (i + 1) + '. ' + o).join('\n') : '';
  const system = 'You are solving a Moodle quiz. Answer with ONE JSON object only, no explanations: ' +
    '{"answer": "<verbatim option text>", "confidence": <0..1>, "reason": "<up to 120 characters>"}. ' +
    'If there is no correct answer or data is missing, return {"error": "<short reason>"}. Add nothing outside the JSON. ' +
    'MANDATORY: Return the EXACT VERBATIM text of the option as listed. Do NOT return numbers, digits, indexes, or letters. Numbering is strictly forbidden.';
  let user = 'Question: ' + String(body.question || '').slice(0, 3000) + '\n';
  if (options) {
    user += (body.multiple ? 'Options (pick all that apply):\n' : 'Options (pick exactly one):\n') + options + '\n';
    user += 'Return the exact verbatim text of the chosen option as listed. Do NOT return numbers or option indexes; numbers are strictly forbidden.\n';
  }
  if (body.multiple) user += 'Return selected option captions joined by |, exactly as listed (verbatim text only, no numbers).\n';
  if (Array.isArray(body.selects) && body.selects.length) {
    user += 'For each numbered dropdown choose one option, in order, joined by | (exact verbatim option text, no numbers):\n';
    body.selects.forEach((values,i) => { user += (i+1) + ': ' + (Array.isArray(values) ? values.join(' / ') : '') + '\n'; });
  }
  if (Number(body.textCount) > 1) user += 'Give one value for each of the ' + Math.min(20, Number(body.textCount)) + ' text fields, in order, joined by |.\n';
  const images = Array.isArray(body.image) ? body.image : [];
  if (images.length) {
    const content = [{type:'text', text:user}];
    images.forEach((image) => { content.push({type:'text', text:String(image.label || 'image').slice(0,200)}); content.push({type:'image_url', image_url:{url:image.data}}); });
    return [{role:'system', content:system}, {role:'user', content}];
  }
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

function upstreamJson(method, pathname, payload, onContent) {
  return new Promise((resolve) => {
    const url = new URL(CFG.upstreamUrl + pathname);
    const lib = url.protocol === 'https:' ? https : http;
    const body = payload ? JSON.stringify(payload) : null;
    const headers = { accept: onContent ? 'text/event-stream, application/json' : 'application/json' };
    if (body) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(body); }
    if (UPSTREAM_KEY) headers.authorization = 'Bearer ' + UPSTREAM_KEY;
    let finished = false;
    function finish(result) { if (!finished) { finished = true; resolve(result); } }
    const reqOpts = {
      method, hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search, headers, timeout: CFG.timeoutMs
    };
    if (CFG.aiProxy) {
      reqOpts.createConnection = (options, cb) => {
        createSocksConnection(CFG.aiProxy, options.hostname || url.hostname, Number(options.port) || (url.protocol === 'https:' ? 443 : 80), CFG.timeoutMs, cb);
      };
    }
    const req = lib.request(reqOpts, (up) => {
      const streaming = onContent && /text\/event-stream/i.test(String(up.headers['content-type'] || ''));
      const decoder = new StringDecoder('utf8'); let raw = '', pending = '', content = '', backendModel = null;
      function lines(chunk) {
        pending += chunk;
        const split = pending.split(/\r?\n/); pending = split.pop();
        for (const line of split) {
          if (!line.startsWith('data:')) continue;
          const item = parseJson(line.slice(5).trim());
          if (item && typeof item.model === 'string' && item.model) backendModel = item.model;
          const delta = item && item.choices && item.choices[0] && item.choices[0].delta;
          if (delta && typeof delta.reasoning_content === 'string' && delta.reasoning_content) onContent('reasoning');
          if (delta && typeof delta.content === 'string' && delta.content) {
            content += delta.content;
            if (content.length > 1024 * 1024) { req.destroy(new Error('upstream answer too large')); return; }
            onContent('writing answer');
          }
        }
      }
      up.on('data', (c) => {
        const text = decoder.write(c);
        if (streaming) lines(text); else { raw += text; if (raw.length > 2 * 1024 * 1024) req.destroy(new Error('upstream answer too large')); }
      });
      up.on('end', () => {
        const tail = decoder.end();
        if (streaming) { lines(tail + '\n'); raw = JSON.stringify({model:backendModel,choices:[{message:{content}}]}); }
        else { raw += tail; if (onContent && up.statusCode >= 200 && up.statusCode < 300) onContent('writing answer'); }
        finish({ status: up.statusCode || 502, text: raw });
      });
      up.on('error', (e) => finish({ status: 0, text: '', error: e.message }));
    });
    req.on('timeout', () => req.destroy(new Error('the model did not answer in time')));
    req.on('error', (e) => finish({ status: 0, text: '', error: e.message }));
    if (body) req.write(body);
    req.end();
  });
}

async function handleAgent(req, res, rec) {
  const left = quotaOf(rec);
  res.setHeader('x-quota-left', String(left));
  if (left <= 0) {
    res.setHeader('retry-after', '60');
    return send(req, res, 429, { ok: false, code: 'rate_limited', retry_after: 60, message: 'the daily quota is used up' });
  }
  const body = parseJson(await readBody(req, 256 * 1024));
  if (!body || !body.question) return oaiError(req, res, 400, 'question is required', 'bad_request');
  if (body.image && (!Array.isArray(body.image) || body.image.length > 5 || body.image.some((x) => !x || !/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/i.test(String(x.data || ''))) || body.image.reduce((n,x) => n + String(x.data).length, 0) > 180000)) return oaiError(req, res, 400, 'image format or size unsupported', 'bad_image');
  const candidateModels = getCandidateModels(CFG.model);
  if (!candidateModels.length) return send(req, res, 503, { ok: false, code: 'no_model', retry_after: 5, message: 'the backend offered no model yet' });

  const streaming = /text\/event-stream/i.test(String(req.headers.accept || ''));
  const payload = { model: candidateModels[0], temperature: 0, messages: buildAgentPrompt(body) };
  if (streaming) {
    payload.stream = true;
    res.writeHead(200, { 'content-type':'text/event-stream; charset=utf-8', 'cache-control':'no-cache', 'x-accel-buffering':'no' });
  }
  function event(type, value) { if (!res.destroyed) res.write('event: ' + type + '\ndata: ' + JSON.stringify(value) + '\n\n'); }
  function reply(status, result) {
    if (!streaming) return send(req, res, status, result);
    event('result', result); return res.end();
  }
  if (streaming) event('stage', {stage: body.image ? 'looking at image' : 'reasoning'});
  let currentStage = body.image ? 'looking at image' : 'reasoning';
  const onContent = streaming ? (stage) => { if (stage !== currentStage && !(currentStage === 'writing answer' && stage === 'reasoning')) { currentStage = stage; event('stage', {stage}); } } : null;
  const started = now();
  rec.requests = (rec.requests || 0) + 1;
  rec.quotaUsed = (rec.quotaUsed || 0) + 1;
  saveState();
  note('agent ' + String(body.question).slice(0, 40), rec);

  let up = null;
  let chosenModel = candidateModels[0];
  for (let ci = 0; ci < candidateModels.length; ci++) {
    chosenModel = candidateModels[ci];
    payload.model = chosenModel;
    up = await upstreamJson('POST', '/v1/chat/completions', payload, onContent);
    if (up && up.status === 503 && ci + 1 < candidateModels.length) {
      note('agent model ' + chosenModel + ' 503 → fallback to ' + candidateModels[ci + 1], rec);
      continue;
    }
    break;
  }
  const ms = now() - started;
  if (!up.status) {
    if (!streaming) res.setHeader('retry-after', '5');
    return reply(502, { ok: false, code: 'upstream_down', retry_after: 5, message: 'the model is unavailable: ' + (up.error || 'network') });
  }
  if (up.status === 429) {
    if (!streaming) res.setHeader('retry-after', '5');
    return reply(429, { ok: false, code: 'rate_limited', retry_after: 5, message: 'the model rate-limited the call' });
  }
  if (up.status >= 500) {
    if (!streaming) res.setHeader('retry-after', '5');
    return reply(503, { ok: false, code: 'model_unavailable', retry_after: 5, message: 'model unavailable, try another model' });
  }
  if (up.status < 200 || up.status >= 300) {
    return reply(502, { ok: false, code: 'upstream_error', message: 'AI backend rejected the request (HTTP ' + up.status + ')' });
  }
  const parsed = parseJson(up.text);
  if (!parsed || !parsed.choices || !parsed.choices[0]) {
    return reply(502, { ok: false, code: 'upstream_bad', retry_after: 5, message: 'the model answered in an unexpected format' });
  }
  const prose = String((parsed.choices[0].message || {}).content || '');
  const answerObj = extractJson(prose);
  const options = Array.isArray(body.options) ? body.options : [];
  if (!answerObj) return reply(200, { ok: false, code: 'agent_error', ms, message: 'the agent could not parse the task', raw: prose.slice(0, 200) });
  if (answerObj.error) return reply(200, { ok: false, code: 'agent_error', ms, message: String(answerObj.error).slice(0, 160) });
  const answer = String(answerObj.answer || '').trim();
  if (!answer) return reply(200, { ok: false, code: 'agent_error', ms, message: 'the agent did not pick an option' });
  const parts = answer.split('|').map((x) => x.trim()).filter(Boolean);
  let picked = answer;
  if (Array.isArray(body.selects) && body.selects.length) {
    if (parts.length !== body.selects.length) return reply(200, {ok:false, code:'agent_error', ms, message:'wrong number of dropdown answers'});
    const matches = body.selects.map((group,i) => {
      if (!Array.isArray(group)) return [];
      const part = parts[i];
      let m = group.filter((o) => String(o).trim().toLowerCase() === part.toLowerCase());
      if (m.length === 1) return m;
      if (/^\d+$/.test(part)) {
        const idx = parseInt(part, 10);
        if (idx >= 1 && idx <= group.length) return [group[idx - 1]];
      }
      return [];
    });
    if (matches.some((xs) => xs.length !== 1)) return reply(200, {ok:false, code:'agent_error', ms, message:'dropdown answer not in the task'});
    picked = matches.map((xs) => xs[0]).join(' | ');
  } else if (options.length) {
    if (!body.multiple && parts.length !== 1) return reply(200, {ok:false, code:'agent_error', ms, message:'agent picked multiple options'});
    const matches = parts.map((part) => {
      let m = options.filter((o) => String(o).trim().toLowerCase() === part.toLowerCase());
      if (m.length === 1) return m;
      if (/^\d+$/.test(part)) {
        const idx = parseInt(part, 10);
        if (idx >= 1 && idx <= options.length) return [options[idx - 1]];
      }
      return [];
    });
    if (matches.some((xs) => xs.length !== 1)) return reply(200, {ok:false, code:'agent_error', ms, message:'the agent named an option that is not in the task', answer});
    picked = matches.map((xs) => xs[0]).join(' | ');
  } else if (Number(body.textCount) > 1 && parts.length !== Number(body.textCount)) {
    return reply(200, {ok:false, code:'agent_error', ms, message:'wrong number of text answers'});
  }
  return reply(200, {
    ok: true, code: 'ok', ms, answer: picked || answer,
    confidence: typeof answerObj.confidence === 'number' ? answerObj.confidence : null,
    reasoning: answerObj.reason || null, model: typeof parsed.model === 'string' && parsed.model ? parsed.model : chosenModel
  });
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
  if (url.pathname === '/admin/dumps' && req.method === 'GET') {
    return send(req, res, 200, { ok: true, dumps: dumps.list(DATA_DIR) });
  }
  if (url.pathname === '/admin/dump-notifications' && req.method === 'GET') {
    const items = state.dumpNotifications.slice();
    return send(req, res, 200, { ok: true, notifications: items });
  }
  if (/^\/admin\/dumps\/[a-f0-9]{32}$/.test(url.pathname) && req.method === 'GET') {
    const item = dumps.get(DATA_DIR, url.pathname.split('/').pop());
    return item ? send(req, res, 200, { ok: true, dump: item }) : oaiError(req, res, 404, 'dump not found', 'not_found');
  }
  if (url.pathname === '/admin/state' && req.method === 'GET') {
    return send(req, res, 200, {
      version: VERSION,
      backend: 'tailscale',
      publicUrl: CFG.publicUrl || null,
      upstream: CFG.upstreamUrl,
      proxy: CFG.aiProxy || null,
      model: CFG.model,
      models: CFG.models, modelsCount: CFG.models.length, modelsSource: CFG.modelsSource,
      quota: CFG.dailyQuota,
      allow: state.allow,
      devices: Object.values(state.devices).map(publicDevice),
      log: state.log.slice(-50)
    });
  }
  const body = parseJson(await readBody(req)) || {};
  if (url.pathname === '/admin/dump-notifications/ack') {
    const id = String(body.id || '');
    state.dumpNotifications = state.dumpNotifications.filter((n) => n.id !== id);
    saveStateNow();
    return send(req, res, 200, {ok:true});
  }
  if (url.pathname === '/admin/allow') {
    const moodleId = String(body.moodleId || '').trim();
    if (!/^\d{1,12}$/.test(moodleId)) return oaiError(req, res, 400, 'moodleId must be a number', 'bad_id');
    const pending = Object.values(state.devices).filter((d) => String(d.moodleId) === moodleId && d.status === 'pending' && !d.banned);
    if (pending.length > 1) return oaiError(req, res, 409, 'multiple pending devices: approve a deviceId explicitly', 'ambiguous_device');
    if (!state.allow.some((a) => String(a.moodleId) === moodleId)) {
      state.allow.push({ moodleId, name: String(body.name || '').trim().slice(0, 120), added: now() });
    }
    if (pending.length === 1) pending[0].status = 'active';
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
  if (url.pathname === '/admin/models') {
    /* the owner pressed "refresh" in the bot or the TUI: ask the backend again, right now */
    const r = req.method === 'POST' ? await refreshModels() : { ok: CFG.models.length > 0, models: CFG.models, reason: null };
    return send(req, res, 200, { ok: r.ok, models: CFG.models, count: CFG.models.length, source: CFG.modelsSource, model: CFG.model, reason: r.reason });
  }
  if (url.pathname === '/admin/model') {
    const wanted = String(body.model || '').trim();
    if (!wanted) return oaiError(req, res, 400, 'model is required', 'bad_model');
    if (CFG.models.length && !CFG.models.includes(wanted)) {
      return oaiError(req, res, 400, 'the backend does not offer "' + wanted + '": ' + CFG.models.slice(0, 5).join(', '), 'unknown_model');
    }
    CFG.model = wanted;
    state.settings = Object.assign({}, state.settings, { model: wanted });
    saveState();
    note('model ' + wanted);
    return send(req, res, 200, { ok: true, model: CFG.model, models: CFG.models });
  }
  if (url.pathname === '/admin/quota') {
    const n = Number(body.quota);
    if (!Number.isFinite(n) || n < 0) return oaiError(req, res, 400, 'quota must be a number >= 0', 'bad_quota');
    CFG.dailyQuota = Math.floor(n);
    state.settings = Object.assign({}, state.settings, { dailyQuota: CFG.dailyQuota });
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
      res.setHeader('cache-control', 'no-store');
      return send(req, res, 200, {
        ok: true, name: 'MSE gateway', version: VERSION, role: 'router',
        backend: 'tailscale', publicUrl: CFG.publicUrl || null,
        upstream: { host: UPSTREAM_HOST, port: UPSTREAM_PORT, tls: UPSTREAM_TLS },
        proxy: CFG.aiProxy || null,
        model: CFG.model,
        models: CFG.models, modelsCount: CFG.models.length, modelsSource: CFG.modelsSource,
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
      /* the list is the backend's: cached at start and on every refresh, never a constant in this file */
      const ids = CFG.models.length ? CFG.models : (CFG.model ? [CFG.model] : []);
      return send(req, res, 200, { object: 'list', data: ids.map((id) => ({ id, object: 'model', created: 1700000000, owned_by: 'backend' })) });
    }
    /* the agent is served here, by the router: /mse/* does not exist behind us, and asking the backend for it was
       the bug that answered "not found: /mse/v1/agent" on every question that had options */
    if (url.pathname === '/mse/v1/dump' && req.method === 'POST') {
      const key = keyOf(req), rec = deviceByKey(key);
      if (!rec) return oaiError(req, res, 401, 'unknown key', 'invalid_key');
      if (rec.status !== 'active') return oaiError(req, res, 403, 'device is ' + rec.status, 'device_' + rec.status);
      const body = parseJson(await readBody(req, 4 * 1024 * 1024));
      if (!body || !['report', 'debug'].includes(body.type) || !body.dump || typeof body.dump !== 'object')
        return oaiError(req, res, 400, 'type and dump required', 'bad_dump');
      if (rec.dumpDay !== day()) { rec.dumpDay = day(); rec.dumpUsed = 0; }
      if ((rec.dumpUsed || 0) >= 50) return oaiError(req, res, 429, 'dump quota reached', 'dump_quota');
      const meta = dumps.store(DATA_DIR, rec, body.type, body.dump, key);
      rec.dumpUsed = (rec.dumpUsed || 0) + 1; rec.seen = now();
      state.dumpNotifications.push(meta);
      if (state.dumpNotifications.length > 100) state.dumpNotifications.splice(0, state.dumpNotifications.length - 100);
      saveStateNow();
      return send(req, res, 201, {ok:true, id:meta.id, truncated:meta.truncated});
    }
    if (url.pathname === '/mse/v1/agent' && req.method === 'POST') {
      const rec = deviceByKey(keyOf(req));
      if (!rec) return oaiError(req, res, 401, 'unknown key: register the device first', 'invalid_key');
      if (rec.status !== 'active') return oaiError(req, res, 403, 'device is ' + rec.status, 'device_' + rec.status);
      return await handleAgent(req, res, rec);
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
/* the list belongs to the backend. As a program the router asks at start, before the first device can ask for a
   model; as a module (`--require`-like use, a test) it asks once the server is listening, which is the same moment. */
let modelsReady = Promise.resolve({ ok: false, models: [], source: 'none', reason: 'not asked yet' });
if (require.main !== module) {
  server.on('listening', () => { modelsReady = refreshModels(); });
}
function askModelsAtStart() {
  modelsReady = refreshModels().then((r) => {
    if (r.ok) console.log('  models    :', CFG.models.length, 'from the backend ·', CFG.model);
    else console.error('  models    : the backend did not answer /v1/models (' + r.reason + ')');
    return r;
  });
  return modelsReady;
}
if (require.main === module) {
  if (![PORT, UPSTREAM_PORT].every((p) => Number.isInteger(p) && p > 0 && p <= 65535) || PORT === UPSTREAM_PORT) {
    console.error('MSE_PORT and MSE_UPSTREAM_PORT must be distinct valid ports');
    process.exit(1);
  }
  askModelsAtStart();
  server.listen(PORT, HOST, () => {
    console.log('MSE router ' + VERSION + ' on http://' + HOST + ':' + PORT + '  (public: ' + (CFG.publicUrl || 'not set yet') + ')');
    console.log('  AI backend:', CFG.upstreamUrl, '(loopback only; the model key stays there)');
    console.log('  model     :', CFG.model || '(the backend names it)', '· quota', CFG.dailyQuota, '/day');
    console.log('  admin     :', process.env.MSE_ADMIN_TOKEN ? 'MSE_ADMIN_TOKEN' : path.join(DATA_DIR, 'admin-token.txt'));
  console.log('  state     :', STATE_FILE);
  });
}
module.exports = { server, CFG, state: () => state, deviceIdOf, registerDevice, deviceByKey, ADMIN_TOKEN, handler, refreshModels, get modelsReady() { return modelsReady; }, handleAgent };
