'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'mse-multi-'));
process.env.MSE_DATA_DIR = data;
process.env.MSE_ADMIN_TOKEN = 'adm_multi_token';
process.env.MSE_PORT = '0';
process.env.MSE_UPSTREAM_PORT = '1';

const router = require('../Server/mse-router');
const KEY = 'mse_' + '9'.repeat(48);

let base = '';
test.before(async () => {
  await new Promise((r) => router.server.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + router.server.address().port;
});

test.after(() => {
  router.server.close();
});

test('2.10-B: multi-account device registration stores accounts list', async () => {
  // First Moodle ID registration
  const r1 = await (await fetch(base + '/mse/v1/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: KEY, moodleId: '1001', name: 'Alice', site: 'moodle1.edu' })
  })).json();

  assert.equal(r1.ok, true);
  assert.equal(r1.device.status, 'pending');
  assert.ok(Array.isArray(r1.device.accounts));
  assert.equal(r1.device.accounts.length, 1);
  assert.equal(r1.device.accounts[0].moodleId, '1001');

  // Second Moodle ID on same device
  const r2 = await (await fetch(base + '/mse/v1/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: KEY, moodleId: '1002', name: 'Alice Alt', site: 'moodle2.edu' })
  })).json();

  assert.equal(r2.ok, true);
  assert.equal(r2.device.accounts.length, 2);
  assert.equal(r2.device.accounts[1].moodleId, '1002');
  assert.equal(r2.device.accounts[1].status, 'pending');

  const devId = r2.device.deviceId;

  // Approve only first account 1001
  const app1 = await (await fetch(base + '/admin/approve', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-token': 'adm_multi_token' },
    body: JSON.stringify({ deviceId: devId, moodleId: '1001' })
  })).json();

  assert.equal(app1.ok, true);
  const acc1001 = app1.device.accounts.find((a) => a.moodleId === '1001');
  const acc1002 = app1.device.accounts.find((a) => a.moodleId === '1002');
  assert.equal(acc1001.status, 'active');
  assert.equal(acc1002.status, 'pending');

  // Check from client with x-moodle-id: 1001 gets active (200)
  const me1 = await fetch(base + '/mse/v1/me', {
    headers: { authorization: 'Bearer ' + KEY, 'x-moodle-id': '1001' }
  });
  assert.equal(me1.status, 200);

  // Revoke account 1001
  const rev1 = await (await fetch(base + '/admin/revoke', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-token': 'adm_multi_token' },
    body: JSON.stringify({ deviceId: devId, moodleId: '1001' })
  })).json();

  assert.equal(rev1.ok, true);
  assert.equal(rev1.device.accounts.find((a) => a.moodleId === '1001').status, 'revoked');

  // Disassociate account 1002
  const dis = await (await fetch(base + '/admin/disassociate', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-token': 'adm_multi_token' },
    body: JSON.stringify({ deviceId: devId, moodleId: '1002' })
  })).json();

  assert.equal(dis.ok, true);
  assert.equal(dis.device.accounts.some((a) => a.moodleId === '1002'), false);
});
