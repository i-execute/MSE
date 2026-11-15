'use strict';
/* The gateway and its mock upstream, run for real: registration, the allow-list by Moodle id, an OpenAI-shaped
   chat call (plain and streaming), the quota, and the promise that a forged id buys nothing. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'mse-gw-'));
process.env.MSE_DATA_DIR = DATA;
process.env.MSE_ADMIN_TOKEN = 'adm_test_token';
process.env.MSE_UPSTREAM_URL = 'http://127.0.0.1:0/v1'; /* replaced below, after the mock is listening */
process.env.MSE_MODEL = 'mock-model';
process.env.MSE_DAILY_QUOTA = '3';
process.env.MSE_ALLOW_ORIGINS = '*';

const gw = require(path.join(__dirname, '..', 'Server', 'mse-server.js'));
const up = require(path.join(__dirname, '..', 'Server', 'mock-upstream.js'));

let base = '';
let upstreamBase = '';
test.before(async () => {
  await new Promise((r) => up.server.listen(0, '127.0.0.1', r));
  upstreamBase = 'http://127.0.0.1:' + up.server.address().port + '/v1';
  gw.CFG.upstreamUrl = upstreamBase;
  await new Promise((r) => gw.server.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + gw.server.address().port;
});
test.after(() => { gw.server.close(); up.server.close(); });

const j = (r) => r.json();
const post = (p, body, headers) => fetch(base + p, {
  method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, headers || {}), body: JSON.stringify(body || {})
});
const key = (n) => 'mse_' + String(n).repeat(48);
const admin = { 'x-admin-token': 'adm_test_token' };

test('G1 /health introduces itself, so the extension can tell a gateway from anything else', async () => {
  const r = await fetch(base + '/health');
  const b = await j(r);
  assert.equal(r.status, 200);
  assert.equal(b.ok, true);
  assert.equal(b.name, 'MSE gateway');
  assert.equal(b.model, 'mock-model');
  assert.equal(b.quota, 3);
});

test('G2 the address is checked before it is believed: CORS preflight answers for the panel', async () => {
  const r = await fetch(base + '/v1/chat/completions', {
    method: 'OPTIONS',
    headers: { origin: 'https://school.example.edu', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' }
  });
  assert.equal(r.status, 204);
  assert.equal(r.headers.get('access-control-allow-origin'), 'https://school.example.edu');
  assert.match(r.headers.get('access-control-allow-headers'), /authorization/);
});

test('G3 an unknown id registers as pending, and a pending device is refused', async () => {
  const r = await post('/mse/v1/register', { key: key(1), moodleId: '11111', name: 'Test User', site: 'school.example.edu' });
  const b = await j(r);
  assert.equal(r.status, 202, 'not active until the owner says so');
  assert.equal(b.device.status, 'pending');
  assert.equal(r.headers.get('x-mse-status'), 'pending');
  const chat = await post('/v1/chat/completions', { messages: [{ role: 'user', content: 'hi' }] }, { authorization: 'Bearer ' + key(1) });
  assert.equal(chat.status, 403);
  assert.equal((await j(chat)).error.code, 'device_pending');
});

test('G4 the owner allows an id, the device comes alive, and the chat answers in the OpenAI shape', async () => {
  const a = await post('/admin/allow', { moodleId: '11111' }, admin);
  assert.equal(a.status, 200, 'the admin token was accepted');
  const me = await fetch(base + '/mse/v1/me', { headers: { authorization: 'Bearer ' + key(1) } });
  const b = await j(me);
  assert.equal(me.status, 200);
  assert.equal(b.device.status, 'active', 'the allow-list entry switched the device on');
  assert.equal(b.device.moodleId, '11111');

  const chat = await post('/v1/chat/completions', { model: 'whatever-the-client-asks', messages: [{ role: 'user', content: 'what is a hashtag?' }] },
    { authorization: 'Bearer ' + key(1) });
  assert.equal(chat.status, 200);
  assert.equal(chat.headers.get('x-quota-left'), '2', 'one call was spent of three');
  const c = await j(chat);
  assert.equal(c.object, 'chat.completion');
  assert.match(c.choices[0].message.content, /hashtag/i);
  assert.equal(c.model, 'mock-model', 'the model of the owner wins over the one the client asked for');
});

test('G5 a second device that claims the same id does not take it over', async () => {
  const r = await post('/mse/v1/register', { key: key(2), moodleId: '11111', name: 'Impostor' });
  const b = await j(r);
  assert.equal(b.device.status, 'pending', 'the id is already bound to another device');
  assert.match(b.device.note || '', /another device|bound/i);
  const chat = await post('/v1/chat/completions', { messages: [{ role: 'user', content: 'give me the answers' }] }, { authorization: 'Bearer ' + key(2) });
  assert.equal(chat.status, 403, 'a forged claim buys nothing');
});

test('G6 the key is the only credential: a wrong one, or none, is refused', async () => {
  const bad = await post('/v1/chat/completions', { messages: [] }, { authorization: 'Bearer mse_' + '0'.repeat(48) });
  assert.equal(bad.status, 401);
  const none = await post('/v1/chat/completions', { messages: [] });
  assert.equal(none.status, 401);
  const noAdmin = await post('/admin/allow', { moodleId: '22222' });
  assert.equal(noAdmin.status, 401, 'the admin endpoints need the token');
});

test('G7 streaming: the bytes go through as a normal OpenAI SSE', async () => {
  const r = await post('/v1/chat/completions', { stream: true, messages: [{ role: 'user', content: 'stream' }] }, { authorization: 'Bearer ' + key(1) });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/event-stream/);
  const text = await r.text();
  assert.match(text, /data: \{/);
  assert.match(text, /chat\.completion\.chunk/);
  assert.match(text, /data: \[DONE\]/);
});

test('G8 the quota: three calls a day, then a plain 429', async () => {
  /* one call is spent in G4, one in G7 — the third here, the fourth is refused */
  const third = await post('/v1/chat/completions', { messages: [{ role: 'user', content: 'third' }] }, { authorization: 'Bearer ' + key(1) });
  assert.equal(third.status, 200);
  assert.equal(third.headers.get('x-quota-left'), '0');
  const fourth = await post('/v1/chat/completions', { messages: [{ role: 'user', content: 'fourth' }] }, { authorization: 'Bearer ' + key(1) });
  assert.equal(fourth.status, 429);
  assert.equal(fourth.headers.get('x-quota-left'), '0');
});

test('G9 the log knows who asked, and the allow-list can be read back', async () => {
  const r = await fetch(base + '/admin/state', { headers: admin });
  const b = await j(r);
  assert.equal(b.allow.length >= 1, true);
  const line = b.log.filter((l) => /chat/.test(l.text)).pop();
  assert.ok(line, 'the chat is in the log');
  assert.equal(line.moodleId, '11111', 'the id in the log comes from the record, not from the request');
  assert.deepEqual(Object.keys(gw.state().devices).length >= 2, true);
});

/* ---------------- the agent: the answer never comes from prose ---------------- */
const http = require('http');
function fakeModel(reply) {
  /* a model that answers with whatever the test wants: a JSON, a JSON with an unknown option, or prose */
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'x', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: reply } }] }));
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}

test('A-g1 the agent answers with one of the options, and that is what comes back', async () => {
  /* a device of its own with a fresh quota: the agent gets its own questions asked */
  const reg = await post('/mse/v1/register', { key: key(9), moodleId: '33333', name: 'Agent' });
  assert.ok([200, 202].includes(reg.status));
  await post('/admin/allow', { moodleId: '33333' }, admin);
  const srv = await fakeModel('{"answer":"Paris","confidence":0.9,"reason":"the capital"}');
  const before = gw.CFG.upstreamUrl;
  gw.CFG.upstreamUrl = 'http://127.0.0.1:' + srv.address().port + '/v1';
  try {
    const r = await post('/mse/v1/agent', { question: 'Capital of France?', options: ['Paris', 'Lyon'], type: 'multichoice' },
      { authorization: 'Bearer ' + key(9) });
    const b = await j(r);
    assert.equal(r.status, 200);
    assert.equal(b.ok, true);
    assert.equal(b.answer, 'Paris', 'the answer is one of the offered options');
    assert.equal(b.confidence, 0.9);
    assert.equal(b.model, 'mock-model', 'the model of the server is reported');
  } finally { gw.CFG.upstreamUrl = before; srv.close(); }
});

test('A-g2 an answer that is not one of the options is an agent error, not a silent guess', async () => {
  const srv = await fakeModel('{"answer":"Marseille"}');
  const before = gw.CFG.upstreamUrl;
  gw.CFG.upstreamUrl = 'http://127.0.0.1:' + srv.address().port + '/v1';
  try {
    const r = await post('/mse/v1/agent', { question: 'Capital of France?', options: ['Paris', 'Lyon'] },
      { authorization: 'Bearer ' + key(9) });
    const b = await j(r);
    assert.equal(b.ok, false);
    assert.equal(b.code, 'agent_error');
    assert.match(b.message, /is not in the task/);
  } finally { gw.CFG.upstreamUrl = before; srv.close(); }
});

test('A-g3 prose instead of JSON is an agent error; a model that says it cannot see is reported as it said', async () => {
  const srv = await fakeModel('I cannot parse this task, it needs an image.');
  const before = gw.CFG.upstreamUrl;
  gw.CFG.upstreamUrl = 'http://127.0.0.1:' + srv.address().port + '/v1';
  try {
    const r = await post('/mse/v1/agent', { question: 'What is in the image?', options: ['a', 'b'] }, { authorization: 'Bearer ' + key(9) });
    const b = await j(r);
    assert.equal(b.ok, false);
    assert.equal(b.code, 'agent_error');
    assert.match(b.message, /could not parse/);
  } finally { gw.CFG.upstreamUrl = before; srv.close(); }
});

test('A-g4 a rate limit of the model becomes a 429 with retry-after, so the extension can retry by itself', async () => {
  const srv = http.createServer((req, res) => { res.writeHead(429, { 'content-type': 'application/json' }); res.end('{"error":"slow down"}'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const before = gw.CFG.upstreamUrl;
  gw.CFG.upstreamUrl = 'http://127.0.0.1:' + srv.address().port + '/v1';
  try {
    const r = await post('/mse/v1/agent', { question: 'q', options: ['a'] }, { authorization: 'Bearer ' + key(9) });
    const b = await j(r);
    assert.equal(r.status, 429);
    assert.equal(b.code, 'rate_limited');
    assert.ok(['5', '60'].includes(r.headers.get('retry-after')), 'the extension knows when to try again: ' + r.headers.get('retry-after'));
  } finally { gw.CFG.upstreamUrl = before; srv.close(); }
});

test('A-g5 /health names the models, so the panel can show what will help', async () => {
  const r = await fetch(base + '/health');
  const b = await j(r);
  assert.ok(Array.isArray(b.models) && b.models.length > 0);
});
