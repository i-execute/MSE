/*
 * Bug 1 — the agent is a route of the router, not of the backend.
 *
 * The live stand answered every question that had options with {"error":{"message":"not found: /mse/v1/agent"}},
 * because /mse/* was proxied to the AI backend, where those paths do not exist. This test runs the real router
 * against a mock backend that knows only /v1/*, registers a device, lets it in and asks a real question: the answer
 * must be one of the offered options, and the backend must never have seen a /mse/ path.
 *
 * Bug 3 — the list of models belongs to the backend: a mock with one list gives that list, another mock with a
 * different list changes it without touching a line of code.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ROUTER = path.join(ROOT, 'Server', 'mse-router.js');
const TOKEN = 'adm_agent_route_test';

function freePort() {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

/* a stand-in for the OpenAI-compatible local backend: it knows /v1/models and /v1/chat/completions and nothing
   else, which is exactly the situation that broke the live stand */
function backend(options) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      seen.push({ method: req.method, url: req.url, body });
      const json = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.method === 'GET' && req.url === '/v1/models') {
        return json(200, { object: 'list', data: options.models.map((id) => ({ id, object: 'model' })) });
      }
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        let parsed = {};
        try { parsed = JSON.parse(body); } catch (e) {}
        const asked = String((parsed.messages || []).map((m) => m.content).join('\n'));
        const answer = options.answer ? options.answer(asked) : 'B';
        return json(200, {
          id: 'chatcmpl-1', object: 'chat.completion', model: parsed.model,
          choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }]
        });
      }
      return json(404, { error: { message: 'not found: ' + req.url, type: 'upstream_error', code: 'agy_upstream' } });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port }));
  });
}

async function startRouter(backendPort, env) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'mse-agent-'));
  const port = await freePort();
  const child = spawn('node', [ROUTER], {
    env: Object.assign({}, process.env, {
      MSE_PORT: String(port), MSE_DATA_DIR: data, MSE_ADMIN_TOKEN: TOKEN,
      MSE_UPSTREAM_HOST: '127.0.0.1', MSE_UPSTREAM_PORT: String(backendPort),
    }, env || {}),
    cwd: path.join(ROOT, 'Server'), stdio: ['ignore', 'pipe', 'pipe']
  });
  let out = '';
  child.stdout.on('data', (c) => { out += c.toString(); });
  child.stderr.on('data', (c) => { out += c.toString(); });
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    try {
      const r = await fetch('http://127.0.0.1:' + port + '/health');
      if (r.ok) break;
    } catch (e) {}
    await new Promise((r) => setTimeout(r, 150));
  }
  return { child, port, data, log: () => out };
}

function call(port, method, pathname, body, key) {
  const headers = { 'content-type': 'application/json' };
  if (key) headers.authorization = 'Bearer ' + key;
  return fetch('http://127.0.0.1:' + port + pathname, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body)
  }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
}

const KEY = 'mse_' + 'a'.repeat(48);

test('bug 1: register -> allow -> agent, and the answer is one of the options', { timeout: 60000 }, async () => {
  const bg = await backend({
    models: ['model-one', 'model-two'],
    /* the model answers with a JSON object, as the prompt asks: the letter of the right option */
    answer: (asked) => (/Right one/.test(asked) ? '{"answer": "Right one", "confidence": 0.8, "reason": "it is"}' : '{"error": "no idea"}')
  });
  const r = await startRouter(bg.port, { MSE_MODEL: 'model-one' });
  try {
    const health = await (await fetch('http://127.0.0.1:' + r.port + '/health')).json();
    assert.equal(health.model, 'model-one', 'the default from the env is kept: it is offered by the backend');

    const reg = await call(r.port, 'POST', '/mse/v1/register', { key: KEY, moodleId: '4242', name: 'Test' });
    assert.equal(reg.status, 202, 'a fresh device waits for the owner: ' + JSON.stringify(reg.json));
    const allow = await call(r.port, 'POST', '/admin/allow', { moodleId: '4242' }, null);
    assert.equal(allow.status, 401, 'admin needs the token');
    const allowed = await fetch('http://127.0.0.1:' + r.port + '/admin/allow', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-token': TOKEN },
      body: JSON.stringify({ moodleId: '4242' })
    });
    assert.equal(allowed.status, 200);
    const again = await call(r.port, 'POST', '/mse/v1/register', { key: KEY, moodleId: '4242', name: 'Test' });
    assert.equal(again.json.device.status, 'active', 'after the allow the device is active');

    const options = ['Wrong one', 'Right one', 'Another one'];
    const res = await call(r.port, 'POST', '/mse/v1/agent', { question: 'Which one is right?', options }, KEY);
    assert.equal(res.status, 200, 'the agent route answers: ' + JSON.stringify(res.json));
    assert.equal(res.json.ok, true, 'and it is a success: ' + JSON.stringify(res.json));
    assert.equal(res.json.answer, 'Right one', 'the answer is one of the options');
    assert.equal(res.json.model, 'model-one', 'and it names the model it used');
    assert.ok(!/not found/i.test(JSON.stringify(res.json)), 'no "not found" anywhere: ' + JSON.stringify(res.json));

    /* the backend was asked for the completion, and never for a /mse/ path */
    const paths = bg.seen.map((s) => s.url);
    assert.ok(paths.some((p) => p === '/v1/chat/completions'), 'the completion went to the backend: ' + JSON.stringify(paths));
    assert.deepEqual(paths.filter((p) => p.indexOf('/mse/') === 0), [], 'no /mse/ path ever reached the backend');
    const chat = bg.seen.filter((s) => s.url === '/v1/chat/completions').pop();
    assert.match(chat.body, /Options \(pick exactly one\)/, 'the router built the strict prompt');
    assert.match(chat.body, /Right one/, 'with every option in it');

    /* an answer that is not one of the options is reported, never passed on as if it were */
    const bad = await backend({ models: ['model-one'], answer: () => '{"answer": "Something else"}' });
    const r2 = await startRouter(bad.port, { MSE_MODEL: 'model-one' });
    try {
      await call(r2.port, 'POST', '/mse/v1/register', { key: KEY, moodleId: '4242' });
      await fetch('http://127.0.0.1:' + r2.port + '/admin/allow', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-token': TOKEN },
        body: JSON.stringify({ moodleId: '4242' })
      });
      const out = await call(r2.port, 'POST', '/mse/v1/agent', { question: 'q?', options }, KEY);
      assert.equal(out.json.ok, false, 'an option that was not offered is an agent error');
      assert.match(String(out.json.message), /not in the task/, 'and says why: ' + JSON.stringify(out.json));
    } finally {
      r2.child.kill();
    }

    /* a key nobody let in never reaches the model */
    const stranger = await call(r.port, 'POST', '/mse/v1/agent', { question: 'q?', options }, 'mse_' + 'b'.repeat(48));
    assert.equal(stranger.status, 401, 'an unknown key is refused');
  } finally {
    r.child.kill();
    bg.server.close();
  }
});

test('bug 3: the list of models is the backend\'s, and changes when the backend changes', { timeout: 60000 }, async () => {
  const first = await backend({ models: ['alpha-1', 'alpha-2', 'alpha-3'] });
  const r = await startRouter(first.port, {});
  try {
    /* the router asks at start: the health carries the backend's list, not a constant */
    const end = Date.now() + 8000;
    let health = {};
    while (Date.now() < end) {
      health = await (await fetch('http://127.0.0.1:' + r.port + '/health')).json();
      if ((health.models || []).length) break;
      await new Promise((x) => setTimeout(x, 200));
    }
    assert.deepEqual(health.models, ['alpha-1', 'alpha-2', 'alpha-3'], 'the list is exactly what the backend offered: ' + JSON.stringify(health.models));
    assert.equal(health.modelsCount, 3, 'and it is counted');
    assert.equal(health.modelsSource, 'backend', 'and it is named as the backend\'s');
    assert.equal(health.model, 'alpha-1', 'with no default in the env, the first one the backend offers becomes the model');

    const listed = await (await fetch('http://127.0.0.1:' + r.port + '/v1/models')).json();
    assert.deepEqual(listed.data.map((m) => m.id), ['alpha-1', 'alpha-2', 'alpha-3'], 'GET /v1/models of the router repeats it');

    /* another backend, another list: the same code, no edit */
    first.server.close();
    const second = await backend({ models: ['beta-9'] });
    /* the router cannot be re-pointed at a new port without a restart, which is how it is meant to be: a restart
       re-reads the backend */
    const r2 = await startRouter(second.port, { MSE_MODEL: 'alpha-1' });
    try {
      const end2 = Date.now() + 8000;
      let h2 = {};
      while (Date.now() < end2) {
        h2 = await (await fetch('http://127.0.0.1:' + r2.port + '/health')).json();
        if ((h2.models || []).length) break;
        await new Promise((x) => setTimeout(x, 200));
      }
      assert.deepEqual(h2.models, ['beta-9'], 'the new backend brings its own list: ' + JSON.stringify(h2.models));
      assert.equal(h2.model, 'beta-9', 'a default the backend does not offer is replaced by the one it does');
      assert.match(r2.log(), /is not offered by the backend/, 'and it is said out loud in the log');

      /* refresh on demand: the backend swaps its list, the owner presses refresh */
      const r3 = await startRouter(second.port, {});
      try {
        await fetch('http://127.0.0.1:' + r3.port + '/admin/models', { method: 'POST', headers: { 'x-admin-token': TOKEN } });
        const after = await fetch('http://127.0.0.1:' + r3.port + '/admin/models', { headers: { 'x-admin-token': TOKEN } }).then((x) => x.json());
        assert.ok(Array.isArray(after.models) && after.models.length === 1, 'the admin endpoint reports the live list');
        assert.equal(after.source, 'backend');
      } finally {
        r3.child.kill();
      }
    } finally {
      r2.child.kill();
      second.server.close();
    }
  } finally {
    r.child.kill();
  }
});
