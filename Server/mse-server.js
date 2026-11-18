'use strict';
/*
 * MSE gateway — the owner's own bridge between the MSE extension (and any OpenAI-compatible client) and a model.
 *
 *   extension  ──register──▶ gateway ──approve(admin by Moodle id)──▶ active device
 *   any client ──POST /v1/chat/completions (Bearer mse_…)──▶ gateway ──▶ upstream model ──▶ stream back
 *
 * The one rule: the identity of the caller is never read from the request. It lives in the record this server
 * created when the device registered and the owner approved it. A client can claim any Moodle id it likes; only
 * the record decides whose quota is spent and whose name is in the log.
 *
 * Zero dependencies: node:http, node:crypto, a JSON file for state. Meant to sit behind
 * a tunnel pointing at the configured MSE_PORT, so it binds to 127.0.0.1 by default.
 *
 *   node server-mse/mse-server.js
 *   MSE_ADMIN_TOKEN=... MSE_UPSTREAM_URL=https://api.openai.com/v1 MSE_UPSTREAM_KEY=sk-... node mse-server.js
 */
const http = require('http');
const https = require('https');
const tls = require('tls');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

/* ------------------------------------------------------------------ config */
const here = __dirname;
const DATA_DIR = path.resolve(process.env.MSE_DATA_DIR || process.env.MSE_STATE_DIR || path.join(require('os').homedir(), '.local', 'share', 'mse'));
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const PORT = Number(process.env.MSE_PORT);
const HOST = process.env.MSE_HOST || '127.0.0.1';
const VERSION = '1.0.0';

const TLS_CERT = process.env.MSE_TLS_CERT || '';
const TLS_KEY = process.env.MSE_TLS_KEY || '';

const CFG = {
  upstreamUrl: (process.env.MSE_UPSTREAM_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
  upstreamKey: process.env.MSE_UPSTREAM_KEY || '',
  upstreamHeader: process.env.MSE_UPSTREAM_AUTH_HEADER || 'authorization',
  upstreamPrefix: process.env.MSE_UPSTREAM_AUTH_PREFIX === undefined ? 'Bearer ' : process.env.MSE_UPSTREAM_AUTH_PREFIX,
  model: process.env.MSE_MODEL || '',
  models: (process.env.MSE_MODELS || '').split(',').map((s) => s.trim()).filter(Boolean),
  dailyQuota: Number(process.env.MSE_DAILY_QUOTA || 200),
  registerPerHour: Number(process.env.MSE_REGISTER_PER_HOUR || 20),
  autoApprove: String(process.env.MSE_AUTO_APPROVE || '') === '1',
  allowOrigins: (process.env.MSE_ALLOW_ORIGINS || '*').split(',').map((s) => s.trim()).filter(Boolean),
  timeoutMs: Number(process.env.MSE_UPSTREAM_TIMEOUT_MS || 120000)
};

/* ------------------------------------------------------------------ state */
fs.mkdirSync(DATA_DIR, { recursive: true });
let state = { devices: {}, allow: [], log: [] };
function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    state = Object.assign({ devices: {}, allow: [], log: [] }, parsed);
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('state file is unreadable, starting empty:', e.message);
  }
}
let saveTimer = null;
function saveState() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const tmp = STATE_FILE + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
      fs.renameSync(tmp, STATE_FILE);
    } catch (e) { console.error('could not write state:', e.message); }
  }, 60);
}
loadState();

/* the admin token: from the environment, else generated once and written next to the state */
const ADMIN_TOKEN = (() => {
  if (process.env.MSE_ADMIN_TOKEN) return process.env.MSE_ADMIN_TOKEN;
  const f = path.join(DATA_DIR, 'admin-token.txt');
  try { return fs.readFileSync(f, 'utf8').trim(); } catch (e) {}
  const t = 'adm_' + crypto.randomBytes(24).toString('base64url');
  try { fs.writeFileSync(f, t + '\n', { mode: 0o600 }); } catch (e) {}
  console.log('admin token written to', f);
  return t;
})();

/* ------------------------------------------------------------------ helpers */
const now = () => Date.now();
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const day = () => new Date().toISOString().slice(0, 10);
const b64len = (s) => Buffer.byteLength(String(s || ''));

function cors(req, res) {
  const origin = req.headers.origin || '';
  const allowed = CFG.allowOrigins.includes('*') ? (origin || '*') : (CFG.allowOrigins.includes(origin) ? origin : '');
  if (allowed) res.setHeader('access-control-allow-origin', allowed);
  if (allowed && allowed !== '*') res.setHeader('vary', 'Origin');
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  res.setHeader('access-control-allow-headers',
    'authorization,content-type,x-requested-with,x-mse-id,x-mse-nonce,x-mse-ts,x-mse-signature,x-mse-handler,x-api-key');
  res.setHeader('access-control-expose-headers', 'x-quota-left,x-mse-status,x-request-id');
  res.setHeader('access-control-max-age', '86400');
}
function send(req, res, status, obj, extraHeaders) {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  res.writeHead(status, Object.assign({ 'content-type': 'application/json; charset=utf-8' }, extraHeaders || {}));
  res.end(req.method === 'HEAD' ? undefined : body);
}
function oaiError(req, res, status, message, code) {
  send(req, res, status, { error: { message, type: status === 401 ? 'invalid_request_error' : 'gateway_error', code: code || String(status) } });
}
function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function parseJson(text) { try { return JSON.parse(text || '{}'); } catch (e) { return null; } }

function deviceIdOf(key) { return 'mse-' + sha256(key).slice(0, 16); }
function keyOf(req) {
  const auth = String(req.headers.authorization || '');
  const m = /^Bearer\s+([A-Za-z0-9_\-\.]+)$/i.exec(auth.trim());
  if (m) return m[1];
  const api = req.headers['x-api-key'];
  return typeof api === 'string' && api ? api : null;
}
function deviceByKey(key) {
  if (!key) return null;
  const id = deviceIdOf(key);
  const rec = state.devices[id];
  if (!rec) return null;
  if (rec.keyHash !== sha256(key)) return null;
  return rec;
}
function quotaOf(rec) {
  if (rec.quotaDay !== day()) { rec.quotaDay = day(); rec.quotaUsed = 0; saveState(); }
  return Math.max(0, CFG.dailyQuota - (rec.quotaUsed || 0));
}
function note(text, rec) {
  const line = { at: new Date().toISOString(), text };
  if (rec) { line.device = rec.deviceId; line.moodleId = rec.moodleId; }
  state.log.push(line);
  if (state.log.length > 500) state.log.splice(0, state.log.length - 500);
  saveState();
  console.log('[' + line.at + ']', text, rec ? '(' + rec.deviceId + ' / ' + rec.moodleId + ')' : '');
}
function isAdmin(req) {
  const t = String(req.headers['x-admin-token'] || req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!t) return false;
  const a = Buffer.from(t), b = Buffer.from(ADMIN_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ------------------------------------------------------------------ registration / identity */
function registerDevice(body) {
  const key = String(body.key || '');
  const moodleId = String(body.moodleId || '').trim();
  const name = String(body.name || '').trim().slice(0, 120);
  const site = String(body.site || '').trim().slice(0, 200);
  if (!/^mse_[A-Za-z0-9_\-]{20,}$/.test(key)) return { error: 'key must look like mse_<32+ random chars>' };
  if (!/^\d{1,12}$/.test(moodleId)) return { error: 'moodleId must be a number: the id from the profile page' };
  const deviceId = deviceIdOf(key);
  const existing = state.devices[deviceId];
  /* the device keeps its own key: a second registration of the same key never changes the owner record */
  if (existing) {
    return { device: existing, repeat: true };
  }
  const allowed = state.allow.some((a) => String(a.moodleId) === moodleId);
  const rec = {
    deviceId,
    keyHash: sha256(key),
    moodleId,
    name,
    site,
    status: 'pending',
    note: allowed ? 'another device requires explicit approval' : null,
    created: now(),
    seen: now(),
    quotaDay: day(),
    quotaUsed: 0,
    requests: 0
  };
  state.devices[deviceId] = rec;
  /* first claim of an allow-listed id binds the device to it; a second device cannot take it away */
  if (rec.status === 'active') {
    const slot = state.allow.find((a) => String(a.moodleId) === moodleId);
    if (slot && slot.deviceId && slot.deviceId !== deviceId) {
      rec.status = 'pending';
      rec.note = 'the id is already bound to another device';
    } else if (slot) { slot.deviceId = deviceId; }
  }
  saveState();
  note('register ' + moodleId + ' → ' + rec.status, rec);
  return { device: rec };
}

function publicDevice(rec) {
  return {
    deviceId: rec.deviceId,
    moodleId: rec.moodleId,
    name: rec.name || null,
    status: rec.status,
    note: rec.note || null,
    created: rec.created,
    quota: { left: quotaOf(rec), of: CFG.dailyQuota, day: rec.quotaDay },
    requests: rec.requests || 0
  };
}

/* ------------------------------------------------------------------ upstream */
function upstreamHeaders(extra) {
  const h = Object.assign({ 'content-type': 'application/json' }, extra || {});
  if (CFG.upstreamKey) h[CFG.upstreamHeader] = CFG.upstreamPrefix + CFG.upstreamKey;
  return h;
}
function upstreamRequest(method, pathname, bodyText, headers) {
  const url = new URL(CFG.upstreamUrl + pathname);
  const lib = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request({
      method,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      headers: headers || upstreamHeaders(),
      timeout: CFG.timeoutMs
    }, (res) => resolve(res));
    req.on('timeout', () => req.destroy(new Error('upstream timeout')));
    req.on('error', reject);
    if (bodyText) req.write(bodyText);
    req.end();
  });
}

/* ------------------------------------------------------------------ routes */
async function handleAdmin(req, res, url) {
  if (!isAdmin(req)) return oaiError(req, res, 401, 'admin token required', 'admin_denied');
  if (url.pathname === '/admin/state' && req.method === 'GET') {
    return send(req, res, 200, {
      allow: state.allow,
      devices: Object.values(state.devices).map(publicDevice),
      log: state.log.slice(-50),
      quota: CFG.dailyQuota,
      model: CFG.model,
      upstream: CFG.upstreamUrl
    });
  }
  const body = parseJson(await readBody(req)) || {};
  if (url.pathname === '/admin/allow') {
    const moodleId = String(body.moodleId || '').trim();
    if (!/^\d{1,12}$/.test(moodleId)) return oaiError(req, res, 400, 'moodleId must be a number', 'bad_id');
    if (!state.allow.some((a) => String(a.moodleId) === moodleId)) {
      state.allow.push({ moodleId, name: String(body.name || '').trim().slice(0, 120), added: now(), deviceId: null });
    }
    const pending = Object.values(state.devices).filter((d) => String(d.moodleId) === moodleId && d.status === 'pending' && !d.banned);
    if (pending.length > 1) return oaiError(req, res, 409, 'multiple pending devices: approve by deviceId', 'ambiguous_device');
    if (pending.length === 1) {
      pending[0].status = 'active';
      const slot = state.allow.find((a) => String(a.moodleId) === moodleId);
      if (slot && !slot.deviceId) slot.deviceId = pending[0].deviceId;
    }
    saveState();
    note('allow ' + moodleId);
    return send(req, res, 200, { ok: true, allow: state.allow });
  }
  if (url.pathname === '/admin/approve') {
    const deviceId = String(body.deviceId || '').trim();
    const rec = state.devices[deviceId];
    if (!rec) return oaiError(req, res, 404, 'no such device', 'no_device');
    rec.status = 'active';
    delete rec.banned;
    delete rec.note;
    saveState();
    note('approve ' + deviceId, rec);
    return send(req, res, 200, { ok: true, device: publicDevice(rec) });
  }
  if (url.pathname === '/admin/revoke') {
    const deviceId = String(body.deviceId || '').trim();
    const rec = state.devices[deviceId];
    if (!rec) return oaiError(req, res, 404, 'no such device', 'no_device');
    rec.status = 'revoked';
    rec.banned = true;
    saveState();
    note('revoke ' + deviceId, rec);
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
  return oaiError(req, res, 404, 'no such admin endpoint', 'not_found');
}

async function handleRegister(req, res) {
  const text = await readBody(req);
  const body = parseJson(text);
  if (!body) return oaiError(req, res, 400, 'body must be JSON', 'bad_json');
  const r = registerDevice(body);
  if (r.error) return oaiError(req, res, 400, r.error, 'bad_register');
  const rec = r.device;
  res.setHeader('x-mse-status', rec.status);
  return send(req, res, rec.status === 'active' ? 200 : 202, {
    ok: true,
    device: publicDevice(rec),
    hint: rec.status === 'active'
      ? 'the key is live: use it as "api key" in any OpenAI-compatible client'
      : 'waiting for the owner: ask them to allow Moodle id ' + rec.moodleId + ' (/admin/allow)'
  });
}

async function handleMe(req, res) {
  const rec = deviceByKey(keyOf(req));
  if (!rec) return oaiError(req, res, 401, 'unknown key: register the device first', 'invalid_key');
  rec.seen = now();
  saveState();
  res.setHeader('x-mse-status', rec.status);
  if (rec.status !== 'active') {
    return send(req, res, 403, { ok: false, device: publicDevice(rec), hint: rec.status === 'revoked' ? 'the key was revoked' : 'waiting for approval' });
  }
  return send(req, res, 200, { ok: true, device: publicDevice(rec), model: CFG.model });
}

async function handleModels(req, res) {
  const list = (CFG.models.length ? CFG.models : [CFG.model]).map((id) => ({
    id, object: 'model', created: 1700000000, owned_by: 'mse'
  }));
  return send(req, res, 200, { object: 'list', data: list });
}

/* ------------------------------------------------------------------ the agent */
/* The question goes to the model with a strict instruction to answer with one of the offered options only, and
   the reply is parsed against that list. Nothing of the model's prose is trusted: an answer that is not one of
   the options is reported as an agent error, so the extension can say so instead of guessing. */
function extractJson(text) {
  var s = String(text || '');
  var m = /\{[\s\S]*\}/.exec(s);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (e) { return null; }
}
const RU_LETTERS = 'абвгдежзийклмнопрстуфхцчшщэюя';
const TRUE_VALS = ['true', 'верно', 'правда', 'да', 't'];
const FALSE_VALS = ['false', 'неверно', 'ложь', 'нет', 'f'];

function normOpt(s) {
  return String(s || '').trim().toLowerCase()
    .replace(/^(\([a-zа-я0-9]{1,2}\)|[a-zа-я0-9]{1,2}[\.\)\:\-])\s*/i, '')
    .replace(/[.,;:!?'\"«»()]+$/g, '')
    .trim();
}
function matchOption(part, options) {
  if (!Array.isArray(options) || !options.length) return null;
  const pRaw = String(part || '').trim();
  let m = options.filter((o) => o.trim().toLowerCase() === pRaw.toLowerCase());
  if (m.length === 1) return m[0];
  const np = normOpt(pRaw);
  if (np) {
    m = options.filter((o) => normOpt(o) === np);
    if (m.length === 1) return m[0];
  }
  const pClean = pRaw.toLowerCase().replace(/[\.\)\:]$/, '');
  const isTrue = TRUE_VALS.includes(pClean);
  const isFalse = FALSE_VALS.includes(pClean);
  if (isTrue || isFalse) {
    const truthyOpt = options.find((o) => TRUE_VALS.includes(normOpt(o)));
    const falsyOpt = options.find((o) => FALSE_VALS.includes(normOpt(o)));
    if (truthyOpt && falsyOpt) {
      return isTrue ? truthyOpt : falsyOpt;
    }
  }
  if (/^\d+$/.test(pRaw)) {
    const idx = parseInt(pRaw, 10);
    if (idx >= 1 && idx <= options.length) return options[idx - 1];
  }
  const latMatch = /^[a-z]$/i.exec(pRaw.replace(/[\.\)\:]$/, ''));
  if (latMatch) {
    const code = latMatch[0].toUpperCase().charCodeAt(0) - 65;
    if (code >= 0 && code < options.length) return options[code];
  }
  const ruMatch = /^[а-я]$/i.exec(pRaw.replace(/[\.\)\:]$/, ''));
  if (ruMatch) {
    const ruCode = RU_LETTERS.indexOf(ruMatch[0].toLowerCase());
    if (ruCode >= 0 && ruCode < options.length) return options[ruCode];
  }
  if (np && np.length >= 3) {
    m = options.filter((o) => {
      const no = normOpt(o);
      return (no && (no.startsWith(np) || np.startsWith(no)));
    });
    if (m.length === 1) return m[0];
  }
  return null;
}

function buildAgentPrompt(body) {
  var options = Array.isArray(body.options) ? body.options.map(function (o, i) { return (i + 1) + '. ' + o; }).join('\n') : '';
  var type = String(body.type || '').toLowerCase();
  var isNumeric = /^(numerical|calculated|calculatedsimple)$/.test(type);
  var isDdwtos = type === 'ddwtos' || Number(body.placesCount) > 0;
  var isCoderunner = type === 'coderunner';

  var system = 'You are solving a Moodle quiz. Answer with ONE JSON object only, no explanations: ' +
    '{"answer": "<verbatim option text or exact answer value>", "confidence": <0..1>, "reason": "<up to 120 characters>"}. ' +
    'If there is no correct option or the data is missing, return {"error": "<short reason>"}. ' +
    'Add nothing outside the JSON.';
  if (options && !isDdwtos) {
    system += ' MANDATORY: For choice questions, return the EXACT VERBATIM text of the option as listed. Do NOT prefix with option numbers or index numbers.';
  }
  var user = 'Question: ' + String(body.question || '').slice(0, 3000) + '\n';
  if (Array.isArray(body.fields) && body.fields.length > 1) {
    user += 'This question has ' + body.fields.length + ' inputs in order from left to right, joined by |:\n';
    body.fields.forEach(function (f, i) {
      var lbl = f.label ? ' [' + f.label + ']' : '';
      if (f.kind === 'select') {
        user += (i + 1) + '.' + lbl + ' [Dropdown] Options: ' + (Array.isArray(f.options) ? f.options.join(' / ') : '') + '\n';
      } else if (f.kind === 'place') {
        user += (i + 1) + '.' + lbl + ' [Blank] Choose matching option from the options list below\n';
      } else {
        user += (i + 1) + '.' + lbl + ' [Text field] Enter value\n';
      }
    });
    if (options) user += 'Available options:\n' + options + '\n';
    user += 'Provide the answer for all ' + body.fields.length + ' inputs in exact order, joined by |.\n';
  } else if (isDdwtos) {
    var places = Number(body.placesCount) || 1;
    user += 'This is a drag-and-drop into text question with ' + places + ' blank(s) marked [[1]]' + (places > 1 ? ', [[2]], etc.' : '') + '.\n';
    if (options) user += 'Available options:\n' + options + '\n';
    user += 'Choose one option for each blank in order, joined by | (exact verbatim option text only).\n';
  } else if (options) {
    user += (body.multiple ? 'Options (pick all that apply):\n' : 'Options (pick exactly one):\n') + options + '\n';
    user += 'Return the exact verbatim text of the chosen option as listed. Do not include option numbers or letters.\n';
  }
  if (body.multiple && !isDdwtos) user += 'Several may be correct: list them separated by "|" in answer (verbatim text only, no numbers).\n';
  if (isNumeric) user += 'Give the exact numerical answer as a number (e.g. 42 or 3.14). Do not include units unless explicitly asked.\n';
  if (isCoderunner) user += 'Provide only the exact working code to solve the task. Do not wrap in markdown fences or explanations.\n';
  if (body.image) user += 'The question has an image attached, but it was not passed as text.\n';
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

async function handleAgent(req, res) {
  const rec = deviceByKey(keyOf(req));
  if (!rec) return oaiError(req, res, 401, 'unknown key: register the device first', 'invalid_key');
  if (rec.status !== 'active') return oaiError(req, res, 403, 'device is ' + rec.status, 'device_' + rec.status);
  const left = quotaOf(rec);
  res.setHeader('x-quota-left', String(left));
  if (left <= 0) {
    res.setHeader('retry-after', '60');
    return send(req, res, 429, { ok: false, code: 'rate_limited', retry_after: 60, message: 'the daily quota is used up' });
  }
  const text = await readBody(req, 256 * 1024);
  const body = parseJson(text);
  if (!body || !body.question) return oaiError(req, res, 400, 'question is required', 'bad_request');

  const payload = { model: CFG.model, temperature: 0, messages: buildAgentPrompt(body) };
  const started = now();
  rec.requests = (rec.requests || 0) + 1;
  rec.quotaUsed = (rec.quotaUsed || 0) + 1;
  saveState();
  note('agent ' + String(body.question).slice(0, 40), rec);

  let upstream;
  try {
    upstream = await upstreamRequest('POST', '/chat/completions', JSON.stringify(payload));
  } catch (e) {
    res.setHeader('retry-after', '5');
    return send(req, res, 502, { ok: false, code: 'upstream_down', retry_after: 5, message: 'the model is unavailable: ' + e.message });
  }
  const chunks = [];
  upstream.on('data', (c) => chunks.push(c));
  await new Promise((r) => upstream.on('end', r).on('error', r));
  const raw = Buffer.concat(chunks).toString('utf8');
  const ms = now() - started;

  if (upstream.statusCode === 429) {
    res.setHeader('retry-after', '5');
    return send(req, res, 429, { ok: false, code: 'rate_limited', retry_after: 5, message: 'the model rate-limited the call' });
  }
  const parsed = parseJson(raw);
  if (!parsed || !parsed.choices) {
    return send(req, res, 502, { ok: false, code: 'upstream_bad', retry_after: 5, message: 'the model answered in an unexpected format' });
  }
  const prose = String((parsed.choices[0].message || {}).content || '');
  const answerObj = extractJson(prose);
  const options = Array.isArray(body.options) ? body.options : [];
  if (!answerObj) {
    return send(req, res, 200, { ok: false, code: 'agent_error', ms, message: 'the agent could not parse the task', raw: prose.slice(0, 200) });
  }
  if (answerObj.error) {
    return send(req, res, 200, { ok: false, code: 'agent_error', ms, message: String(answerObj.error).slice(0, 160) });
  }
  let rawAns = answerObj.answer;
  if (Array.isArray(rawAns)) {
    rawAns = rawAns.map((x) => String(x == null ? '' : x)).join(' | ');
  } else if (rawAns && typeof rawAns === 'object') {
    rawAns = Object.values(rawAns).map((x) => String(x == null ? '' : x)).join(' | ');
  } else if (rawAns != null) {
    rawAns = String(rawAns);
  } else {
    rawAns = '';
  }
  const answer = rawAns.trim();
  if (answer === '') {
    return send(req, res, 200, { ok: false, code: 'agent_error', ms, message: 'the agent did not pick an option' });
  }
  let cleanAnswer = answer.replace(/^```[a-z]*\s*\n?/i, '').replace(/\n?```\s*$/i, '');
  const parts = cleanAnswer.split('|').map((x) => x.trim()).filter(Boolean);
  let picked = cleanAnswer;

  if (Array.isArray(body.fields) && body.fields.length > 1) {
    const matched = parts.map((part, i) => {
      const f = body.fields[i];
      if (f && f.kind === 'select' && Array.isArray(f.options)) {
        return matchOption(part, f.options);
      }
      if (f && f.kind === 'place' && options.length) {
        return matchOption(part, options);
      }
      return part;
    });
    if (matched.some((x) => x === null)) {
      return send(req, res, 200, { ok: false, code: 'agent_error', ms, message: 'the agent named an option that is not in the task', answer });
    }
    picked = matched.join(' | ');
  } else if (options.length) {
    const matches = parts.map((part) => matchOption(part, options));
    if (matches.some((xs) => xs === null)) {
      return send(req, res, 200, { ok: false, code: 'agent_error', ms, message: 'the agent named an option that is not in the task', answer });
    }
    picked = matches.join(' | ');
  }
  return send(req, res, 200, {
    ok: true, code: 'ok', ms, answer: picked || answer,
    confidence: typeof answerObj.confidence === 'number' ? answerObj.confidence : null,
    reasoning: answerObj.reason || null, model: CFG.model
  });
}

async function handleChat(req, res) {
  const rec = deviceByKey(keyOf(req));
  if (!rec) return oaiError(req, res, 401, 'unknown key: register the device first', 'invalid_key');
  if (rec.status !== 'active') return oaiError(req, res, 403, 'device is ' + rec.status, 'device_' + rec.status);
  const left = quotaOf(rec);
  res.setHeader('x-quota-left', String(left));
  if (left <= 0) return oaiError(req, res, 429, 'daily quota is over', 'quota_exceeded');

  const text = await readBody(req, 4 * 1024 * 1024);
  const body = parseJson(text);
  if (!body || !Array.isArray(body.messages)) return oaiError(req, res, 400, 'messages[] is required', 'bad_request');
  /* the model is the owner's business: whatever the client asks for, the configured one is used */
  const payload = Object.assign({}, body, { model: CFG.model });
  const wantStream = body.stream === true;
  payload.stream = wantStream;

  rec.requests = (rec.requests || 0) + 1;
  rec.quotaUsed = (rec.quotaUsed || 0) + 1;
  saveState();
  note('chat ' + (wantStream ? 'stream' : 'plain') + ' ' + b64len(text) + 'B', rec);

  let upstream;
  try {
    upstream = await upstreamRequest('POST', '/chat/completions', JSON.stringify(payload));
  } catch (e) {
    return oaiError(req, res, 502, 'upstream is unreachable: ' + e.message, 'upstream_down');
  }

  res.setHeader('x-quota-left', String(Math.max(0, left - 1)));
  if (!wantStream) {
    const chunks = [];
    upstream.on('data', (c) => chunks.push(c));
    await new Promise((r) => upstream.on('end', r).on('error', r));
    const raw = Buffer.concat(chunks).toString('utf8');
    const parsed = parseJson(raw);
    if (!parsed) return oaiError(req, res, 502, 'upstream answered with something that is not JSON', 'upstream_bad');
    return send(req, res, upstream.statusCode || 200, parsed);
  }

  /* streaming: the bytes go through untouched, the client sees a normal SSE of the OpenAI shape */
  res.writeHead(upstream.statusCode || 200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no'
  });
  upstream.on('data', (c) => res.write(c));
  upstream.on('end', () => res.end());
  upstream.on('error', () => res.end());
  req.on('close', () => { try { upstream.destroy(); } catch (e) {} });
}

/* ------------------------------------------------------------------ server */
const handler = async (req, res) => {
  cors(req, res);
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  try {
    if (url.pathname === '/health' || url.pathname === '/') {
      res.setHeader('cache-control', 'no-store');
      const body = {
        ok: true,
        name: 'MSE gateway',
        version: VERSION,
        upstream: CFG.upstreamUrl ? 'configured' : 'not configured',
        model: CFG.model,
        models: CFG.models.length ? CFG.models : [CFG.model],
        quota: CFG.dailyQuota,
        devices: Object.keys(state.devices).length,
        allow: state.allow.length,
        time: new Date().toISOString()
      };
      if (url.pathname === '/' && (req.headers.accept || '').includes('text/html')) {
        const html = '<!doctype html><meta charset="utf-8"><title>MSE gateway</title>' +
          '<body style="background:#050505;color:#fafafa;font:14px/1.6 system-ui;padding:32px;max-width:640px;margin:auto">' +
          '<h1 style="font-weight:700;letter-spacing:.14em;text-shadow:0 0 18px rgba(255,255,255,.55)">MSE GATEWAY</h1>' +
          '<p>alive, version ' + VERSION + '</p><pre style="background:#0e0e0e;border:1px solid #2b2b2b;border-radius:10px;padding:14px;overflow:auto">' +
          JSON.stringify(body, null, 2) + '</pre>' +
          '<p style="color:#8b8b8b">endpoint for the extension: <code>' + (req.headers['x-forwarded-proto'] || 'https') + '://' + (req.headers.host || '') + '</code></p></body>';
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(html);
      }
      return send(req, res, 200, body);
    }
    if (url.pathname.startsWith('/admin/')) return await handleAdmin(req, res, url);
    if (url.pathname === '/mse/v1/register' && req.method === 'POST') return await handleRegister(req, res);
    if (url.pathname === '/mse/v1/me' && req.method === 'GET') return await handleMe(req, res);
    if (url.pathname === '/v1/models' && req.method === 'GET') return await handleModels(req, res);
    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') return await handleChat(req, res);
    if (url.pathname === '/mse/v1/agent' && req.method === 'POST') return await handleAgent(req, res);
    return oaiError(req, res, 404, 'no such endpoint: ' + url.pathname, 'not_found');
  } catch (e) {
    console.error('unhandled:', e && e.stack || e);
    if (!res.headersSent) return oaiError(req, res, 500, 'internal error', 'internal');
    try { res.end(); } catch (x) {}
  }
};

const server = (TLS_CERT && TLS_KEY)
  ? https.createServer({ cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY), minVersion: 'TLSv1.2' }, handler)
  : http.createServer(handler);

if (require.main === module) {
  if (!Number.isInteger(PORT) || PORT <= 0 || PORT > 65535) {
    console.error('MSE_PORT must be a valid port');
    process.exit(1);
  }
  server.listen(PORT, HOST, () => {
    console.log('MSE gateway ' + VERSION + ' on ' + ((TLS_CERT && TLS_KEY) ? 'https' : 'http') + '://' + HOST + ':' + PORT);
    console.log('  upstream:', CFG.upstreamUrl, CFG.upstreamKey ? '(key set)' : '(NO KEY: chat will fail)');
    console.log('  model   :', CFG.model, '· quota', CFG.dailyQuota, '/day');
    console.log('  admin   :', path.join(DATA_DIR, 'admin-token.txt'), '(or MSE_ADMIN_TOKEN)');
    if (CFG.upstreamKey && !process.env.MSE_ADMIN_TOKEN && !fs.existsSync(path.join(DATA_DIR, 'admin-token.txt'))) {
      console.log('  warning : the admin token is generated on first start and kept there');
    }
  });
}

module.exports = { server, CFG, state: () => state, deviceIdOf, registerDevice, deviceByKey, ADMIN_TOKEN, handleAgent };
