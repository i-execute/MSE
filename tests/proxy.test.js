'use strict';

const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ROUTER = path.join(ROOT, 'Server', 'mse-router.js');
const TOKEN = 'adm_proxy_test';

function freePort() {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function createMockSocksServer(targetPort) {
  let connectionsCount = 0;
  const server = net.createServer((client) => {
    connectionsCount++;
    client.once('data', (greeting) => {
      if (greeting[0] !== 5) return client.destroy();
      client.write(Buffer.from([0x05, 0x00])); // no auth
      client.once('data', (req) => {
        if (req[0] !== 5 || req[1] !== 1) return client.destroy(); // CONNECT cmd
        client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 80]));
        const target = net.connect(targetPort, '127.0.0.1', () => {
          client.pipe(target);
          target.pipe(client);
        });
        target.on('error', () => client.destroy());
        client.on('error', () => target.destroy());
      });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        port: server.address().port,
        getConnections: () => connectionsCount
      });
    });
  });
}

function createMockBackend() {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits++;
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: [{ id: 'test-model' }] }));
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        id: 'chat-1', object: 'chat.completion', model: 'test-model',
        choices: [{ index: 0, message: { role: 'assistant', content: '{"answer": "Option 1"}' }, finish_reason: 'stop' }]
      }));
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, getHits: () => hits });
    });
  });
}

async function startRouter(backendPort, env) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'mse-proxy-'));
  const port = await freePort();
  const child = spawn('node', [ROUTER], {
    env: Object.assign({}, process.env, {
      MSE_PORT: String(port), MSE_DATA_DIR: data, MSE_ADMIN_TOKEN: TOKEN,
      MSE_UPSTREAM_HOST: '127.0.0.1', MSE_UPSTREAM_PORT: String(backendPort),
    }, env || {}),
    cwd: path.join(ROOT, 'Server'), stdio: ['ignore', 'pipe', 'pipe']
  });
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    try {
      const r = await fetch('http://127.0.0.1:' + port + '/health');
      if (r.ok) break;
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 150));
  }
  return { child, port, data };
}

test('B3: AI_PROXY routes upstream requests through SOCKS5 proxy', { timeout: 60000 }, async () => {
  const backend = await createMockBackend();
  const socks = await createMockSocksServer(backend.port);

  // Start router with AI_PROXY pointing to mock SOCKS5
  const r = await startRouter(backend.port, {
    AI_PROXY: 'socks5://127.0.0.1:' + socks.port,
    MSE_MODEL: 'test-model'
  });

  try {
    const key = 'mse_' + 'c'.repeat(48);
    // Register device
    await fetch('http://127.0.0.1:' + r.port + '/mse/v1/register', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key, moodleId: '9999' })
    });
    // Allow device
    await fetch('http://127.0.0.1:' + r.port + '/admin/allow', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-token': TOKEN },
      body: JSON.stringify({ moodleId: '9999' })
    });

    const initSocksConns = socks.getConnections();
    assert.ok(initSocksConns > 0, 'SOCKS proxy was used during startup models check');

    // Make an agent call
    const res = await fetch('http://127.0.0.1:' + r.port + '/mse/v1/agent', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
      body: JSON.stringify({ question: 'Test question', options: ['Option 1', 'Option 2'] })
    });
    const json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.answer, 'Option 1');

    assert.ok(socks.getConnections() > initSocksConns, 'SOCKS proxy saw the agent request');

    // Health reflects proxy setting
    const health = await (await fetch('http://127.0.0.1:' + r.port + '/health', { headers: { 'x-admin-token': TOKEN } })).json();
    assert.equal(health.proxy, 'socks5://127.0.0.1:' + socks.port);
  } finally {
    r.child.kill();
    socks.server.close();
    backend.server.close();
  }
});

test('B3: empty AI_PROXY connects directly without SOCKS proxy', { timeout: 60000 }, async () => {
  const backend = await createMockBackend();
  const r = await startRouter(backend.port, { AI_PROXY: '', MSE_MODEL: 'test-model' });

  try {
    const health = await (await fetch('http://127.0.0.1:' + r.port + '/health', { headers: { 'x-admin-token': TOKEN } })).json();
    assert.equal(health.proxy, null);

    const key = 'mse_' + 'd'.repeat(48);
    await fetch('http://127.0.0.1:' + r.port + '/mse/v1/register', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key, moodleId: '8888' })
    });
    await fetch('http://127.0.0.1:' + r.port + '/admin/allow', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-token': TOKEN },
      body: JSON.stringify({ moodleId: '8888' })
    });

    const res = await fetch('http://127.0.0.1:' + r.port + '/mse/v1/agent', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
      body: JSON.stringify({ question: 'Test question', options: ['Option 1', 'Option 2'] })
    });
    const json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.answer, 'Option 1');
  } finally {
    r.child.kill();
    backend.server.close();
  }
});
