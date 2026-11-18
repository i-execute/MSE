'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'mse-health-'));
process.env.MSE_DATA_DIR = data;
process.env.MSE_ADMIN_TOKEN = 'adm_health_token';
process.env.MSE_PORT = '0';
process.env.MSE_UPSTREAM_PORT = '1';

const router = require('../Server/mse-router');

let base = '';
test.before(async () => {
  await new Promise((r) => router.server.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + router.server.address().port;
});

test.after(() => {
  router.server.close();
});

test('2.10-E: public /health without admin token returns strictly minimal json', async () => {
  const res = await fetch(base + '/health');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const body = await res.json();
  assert.deepEqual(body, {
    name: 'MSE',
    version: '2.10.0',
    layer: 1
  });
});

test('2.10-E: /health with admin token returns full detailed report', async () => {
  const res = await fetch(base + '/health', {
    headers: { 'x-admin-token': 'adm_health_token' }
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.name, 'MSE gateway');
  assert.equal(body.version, '2.10.0');
  assert.equal(body.role, 'router');
  assert.equal(body.backend, 'tailscale');
  assert.ok('upstream' in body);
  assert.ok('quota' in body);
  assert.ok('devices' in body);
});
