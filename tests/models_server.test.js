'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'mse-models-'));
process.env.MSE_DATA_DIR = data;
process.env.MSE_ADMIN_TOKEN = 'adm_models_token';
process.env.MSE_PORT = '0';
process.env.MSE_UPSTREAM_PORT = '1';
process.env.MSE_MODEL = 'primary-model';

const router = require('../Server/mse-router');
const KEY = 'mse_' + '7'.repeat(48);

let base = '';
test.before(async () => {
  router.CFG.models = ['primary-model', 'secondary-model'];
  await new Promise((r) => router.server.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + router.server.address().port;

  // Register and allow client key
  await fetch(base + '/mse/v1/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: KEY, moodleId: '9999' })
  });
  await fetch(base + '/admin/allow', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-token': 'adm_models_token' },
    body: JSON.stringify({ moodleId: '9999' })
  });
});

test.after(() => {
  router.server.close();
});

test('C: unauthenticated request to /v1/models gets 403', async () => {
  const res = await fetch(base + '/v1/models');
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.error.code, 'admin_restricted');
});

test('C: client key to /v1/models gets 403', async () => {
  const res = await fetch(base + '/v1/models', {
    headers: { authorization: 'Bearer ' + KEY }
  });
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.error.code, 'admin_restricted');
});

test('C: admin token to /v1/models gets 200 with model list', async () => {
  const res = await fetch(base + '/v1/models', {
    headers: { 'x-admin-token': 'adm_models_token' }
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.object, 'list');
  assert.ok(Array.isArray(body.data));
  assert.ok(body.data.some((m) => m.id === 'primary-model'));
});

test('C: extension source code does not call /v1/models', () => {
  const bridgeSrc = fs.readFileSync(path.join(__dirname, '../Extensions/src/mse-bridge.js'), 'utf8');
  const uiSrc = fs.readFileSync(path.join(__dirname, '../Extensions/src/mse-ui.js'), 'utf8');
  assert.equal(bridgeSrc.includes('/v1/models'), false, 'bridge does not call /v1/models');
  assert.equal(uiSrc.includes('/v1/models'), false, 'ui does not call /v1/models');
});
