'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'mse-sse-'));
process.env.MSE_DATA_DIR = data;
process.env.MSE_ADMIN_TOKEN = 'adm_sse_token';
process.env.MSE_PORT = '0';
process.env.MSE_MODEL = 'test-model';

const router = require('../Server/mse-router');
const KEY = 'mse_' + '8'.repeat(48);

let base = '';
let upstream = null;
let upstreamAborted = false;

test.before(async () => {
  upstream = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"data":[{"id":"test-model"}]}');
    }
    req.on('close', () => {
      upstreamAborted = true;
    });
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const parsed = JSON.parse(raw);
      if (parsed.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { reasoning_content: 'thinking hard' } }] }) + '\n\n');
        setTimeout(() => {
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: '{"answer": "A"}' } }] }) + '\n\n');
          res.end('data: [DONE]\n\n');
        }, 100);
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{ message: { content: '{"answer": "A", "confidence": 0.9}' } }]
        }));
      }
    });
  });

  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  router.CFG.upstreamUrl = 'http://127.0.0.1:' + upstream.address().port;
  await new Promise((r) => router.server.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + router.server.address().port;

  // Register and allow device
  await fetch(base + '/mse/v1/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: KEY, moodleId: '5555' })
  });
  await fetch(base + '/admin/allow', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-token': 'adm_sse_token' },
    body: JSON.stringify({ moodleId: '5555' })
  });
});

test.after(() => {
  router.server.close();
  upstream.close();
});

test('B: SSE streaming returns stage events and final result event', async () => {
  const res = await fetch(base + '/mse/v1/agent', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      authorization: 'Bearer ' + KEY
    },
    body: JSON.stringify({ question: 'Which option?', options: ['A', 'B'] })
  });

  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const text = await res.text();
  assert.match(text, /event: stage/);
  assert.match(text, /event: result/);
  assert.match(text, /"answer":"A"/);
});

test('B: plain JSON request returns regular JSON without SSE framing', async () => {
  const res = await fetch(base + '/mse/v1/agent', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      authorization: 'Bearer ' + KEY
    },
    body: JSON.stringify({ question: 'Which option?', options: ['A', 'B'] })
  });

  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/json/);
  const json = await res.json();
  assert.equal(json.ok, true);
  assert.equal(json.answer, 'A');
});

test('B: client abort destroys upstream request', async () => {
  const controller = new AbortController();
  const slowPromise = fetch(base + '/mse/v1/agent', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      authorization: 'Bearer ' + KEY
    },
    body: JSON.stringify({ question: 'Which option?', options: ['A', 'B'] }),
    signal: controller.signal
  });

  setTimeout(() => controller.abort(), 20);
  try {
    await slowPromise;
  } catch (_) {}
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(upstreamAborted, true, 'upstream request was aborted on client close');
});

test('B: router SSE agent code contains zero comments', () => {
  const routerSrc = fs.readFileSync(path.join(__dirname, '../Server/mse-router.js'), 'utf8');
  const start = routerSrc.indexOf('function upstreamJson(');
  const end = routerSrc.indexOf('/* ------------------------------------------------------------------ admin */');
  assert.ok(start > 0 && end > start);
  const agentCode = routerSrc.slice(start, end);
  const lines = agentCode.split('\n');
  const comments = lines.filter((l) => l.trim().startsWith('//') || l.trim().startsWith('/*') || l.trim().startsWith('*'));
  assert.deepEqual(comments, [], 'SSE agent code has zero comments');
});
