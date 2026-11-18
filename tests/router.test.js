'use strict';
/* The router of MSE 2.0: access by device key, the owner's allow-list by Moodle id, the quota, and the one thing
   that makes it a router — everything an allowed device asks for is passed to the AI backend on the loopback,
   untouched, streaming included. A device nobody let in never reaches the backend at all. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'mse-router-'));
const UP_PORT = 18799;
Object.assign(process.env, {
  MSE_DATA_DIR: DATA,
  MSE_ADMIN_TOKEN: 'adm_router_token',
  MSE_UPSTREAM_PORT: String(UP_PORT),
  MSE_UPSTREAM_HOST: '127.0.0.1',
  MSE_MODEL: 'mock-model',
  MSE_MOCK_MODELS: 'mock-model,gemini-3-flash',
  MSE_DAILY_QUOTA: '3',
  MSE_ALLOW_ORIGINS: '*',
  MSE_PUBLIC_URL: 'https://mse-gateway.example.ts.net'
});

/* the backend is the mock upstream, but on a port of its own, so the router is the only way to it */
const up = require('../Server/mock-upstream.js');
const router = require('../Server/mse-router.js');

let base = '';
let upstreamHits = 0;
up.server.on('request', () => { upstreamHits += 1; });

test.before(async () => {
  await new Promise((r) => up.server.listen(UP_PORT, '127.0.0.1', r));
  await new Promise((r) => router.server.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + router.server.address().port;
});
test.after(() => { router.server.close(); up.server.close(); });

const post = (p, body, headers) => fetch(base + p, {
  method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, headers || {}), body: JSON.stringify(body || {})
});
const get = (p, headers) => fetch(base + p, { headers: headers || {} });
const key = (n) => 'mse_' + String(n).repeat(48);
const admin = { 'x-admin-token': 'adm_router_token' };

test('R1 /health says it is a router behind tailscale, and where the backend is', async () => {
  const response = await get('/health');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const h = await response.json();
  assert.equal(h.ok, true);
  assert.equal(h.name, 'MSE gateway');
  assert.equal(h.role, 'router');
  assert.equal(h.backend, 'tailscale');
  assert.equal(h.publicUrl, 'https://mse-gateway.example.ts.net');
  assert.equal(h.upstream.port, UP_PORT, 'the backend is a loopback port');
  assert.equal(h.quota, 3);
});

test('R2 an unknown key gets 401 and not one byte of the backend', async () => {
  upstreamHits = 0;
  const r = await post('/v1/chat/completions', { messages: [{ role: 'user', content: 'hi' }] }, { authorization: 'Bearer ' + key(1) });
  assert.equal(r.status, 401);
  assert.equal(upstreamHits, 0, 'the backend was not touched');
});

test('R3 a registered but unallowed device is pending: 403 on the model, and the backend is still untouched', async () => {
  const reg = await post('/mse/v1/register', { key: key(2), moodleId: '12346', name: 'Test' });
  assert.equal(reg.status, 202);
  assert.equal((await reg.json()).device.status, 'pending');
  upstreamHits = 0;
  const r = await post('/v1/chat/completions', { messages: [{ role: 'user', content: 'hi' }] }, { authorization: 'Bearer ' + key(2) });
  assert.equal(r.status, 403);
  assert.equal(upstreamHits, 0);
  const me = await get('/mse/v1/me', { authorization: 'Bearer ' + key(2) });
  assert.equal(me.status, 403);
});

test('R4 the owner allows the Moodle id: same key becomes active, and the answer is streamed through the router', async () => {
  const allow = await post('/admin/allow', { moodleId: '12346' }, admin);
  assert.equal(allow.status, 200);
  const me = await get('/mse/v1/me', { authorization: 'Bearer ' + key(2) });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).device.status, 'active');

  upstreamHits = 0;
  const r = await post('/v1/chat/completions', { model: 'whatever', stream: true, messages: [{ role: 'user', content: 'ping router' }] }, { authorization: 'Bearer ' + key(2) });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') || '', /text\/event-stream/);
  const text = await r.text();
  /* the mock streams twelve characters at a time: the sentence is assembled from the deltas */
  const streamed = text.split('\n')
    .map((l) => /^data: (\{.*\})$/.exec(l.trim()))
    .filter(Boolean)
    .map((m) => { try { const j = JSON.parse(m[1]); return (j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content) || ''; } catch (e) { return ''; } })
    .join('');
  assert.match(streamed, /MSE mock upstream/, 'the model answered through the router, delta by delta');
  assert.ok(/data: \[DONE\]/.test(text), 'and the stream ends as an SSE stream ends');
  assert.equal(upstreamHits, 1, 'the backend was reached exactly once');
  assert.ok(Number(r.headers.get('x-quota-left')) >= 0, 'the remaining quota is on the answer');
});

test('R5 a plain (non-streaming) call is passed through with its body intact', async () => {
  const r = await post('/v1/chat/completions', { messages: [{ role: 'user', content: 'what is MSE' }] }, { authorization: 'Bearer ' + key(2) });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.object, 'chat.completion');
  assert.match(j.choices[0].message.content, /what is MSE/);
});

test('R6 the quota counts down and then stops the device with a retry-after', async () => {
  let last = null;
  const codes = [];
  for (let i = 0; i < 4; i++) {
    last = await post('/v1/chat/completions', { messages: [{ role: 'user', content: 'q' + i }] }, { authorization: 'Bearer ' + key(2) });
    codes.push(last.status);
    if (last.status === 429) break;
  }
  assert.equal(last.status, 429, 'the calls after the 3/day quota are refused: ' + JSON.stringify(codes));
  assert.equal(last.headers.get('retry-after'), '60');
});

test('R7 revoke stops the key at once, and the backend hears nothing of it', async () => {
  const st = await (await get('/admin/state', admin)).json();
  const dev = st.devices.filter((d) => d.moodleId === '12346')[0];
  assert.ok(dev, 'the device is in the state');
  const rev = await post('/admin/revoke', { deviceId: dev.deviceId }, admin);
  assert.equal(rev.status, 200);
  upstreamHits = 0;
  const r = await post('/v1/chat/completions', { messages: [{ role: 'user', content: 'hi' }] }, { authorization: 'Bearer ' + key(2) });
  assert.equal(r.status, 403);
  assert.equal(upstreamHits, 0);
});

test('R8 /admin/state is the same report as before, and /admin/quota changes the day limit', async () => {
  const denied = await get('/admin/state');
  assert.equal(denied.status, 401, 'no token, no state');
  const q = await post('/admin/quota', { quota: 50 }, admin);
  assert.equal((await q.json()).quota, 50);
  const st = await (await get('/admin/state', admin)).json();
  assert.equal(st.quota, 50);
  assert.equal(st.version, '2.8.0');
  assert.ok(Array.isArray(st.log) && st.log.length > 0, 'the log tells what happened');
  assert.equal(st.backend, 'tailscale');
});

test('R9 /v1/models is named to an allowed device and denied to a stranger', async () => {
  await router.modelsReady;
  const open = await get('/v1/models');
  assert.equal(open.status, 200, 'the list itself is public, as OpenAI clients expect');
  const list = await open.json();
  assert.deepEqual(list.data.map((m) => m.id), ['mock-model', 'gemini-3-flash'], 'the backend\'s list, verbatim');
  const strandev = await get('/v1/models', { authorization: 'Bearer ' + key(9) });
  assert.equal(strandev.status, 200, 'an unknown key that asks for models still gets the list');
});
