'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const router = require('../Server/mse-router.js');
const h = require('./lib/harness.js');

test('MSE 2.13 Quota Endpoint: GET /mse/v1/quota and UI settings display', async () => {
  const PORT = 19854;
  const srv = http.createServer(router.handler);
  await new Promise(r => srv.listen(PORT, '127.0.0.1', r));

  try {
    // 1. Register a test device
    const testKey = 'mse_' + '1'.repeat(48);
    const regRes = await fetch(`http://127.0.0.1:${PORT}/mse/v1/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: testKey, moodleId: '88888', name: 'Quota Tester' })
    });
    assert.ok(regRes.status === 200 || regRes.status === 202);
    const regJson = await regRes.json();
    assert.equal(regJson.ok, true);

    // Allow device
    await fetch(`http://127.0.0.1:${PORT}/admin/allow`, {
      method: 'POST',
      headers: { 'x-admin-token': router.ADMIN_TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ moodleId: '88888' })
    });

    // 2. Query /mse/v1/quota
    const qRes = await fetch(`http://127.0.0.1:${PORT}/mse/v1/quota`, {
      method: 'GET',
      headers: { authorization: 'Bearer ' + testKey }
    });
    assert.equal(qRes.status, 200, 'GET /mse/v1/quota returns 200');
    const qJson = await qRes.json();
    assert.equal(qJson.ok, true);
    assert.ok(qJson.quota, 'quota object returned');
    assert.equal(typeof qJson.quota.left, 'number');
    assert.equal(typeof qJson.quota.limit, 'number');
    assert.match(qJson.quota.resets_after, /^\d+h\s+\d+m$/, 'resets_after has format "Xh Ym"');
    assert.ok(qJson.quota.resets_in_sec > 0, 'resets_in_sec is positive');
    assert.ok(new Date(qJson.quota.resets_at).getTime() > Date.now(), 'resets_at is in the future');

    // 3. Test UI Settings rendering in WebKit
    const t = await h.launch({ api: () => ({ status: 200, json: [] }) });
    try {
      const page = await t.newPage(h.fixtureUrl('attempt'));
      await page.waitForFunction(() => !!window.__mse && !!window.MSEBridge);

      await page.evaluate(() => {
        window.MSEBridge.url = () => 'https://gateway.example.com';
        window.MSEBridge.meta = () => ({ allowed: true, device: 'mse-test-quota-key-1' });
        window.MSEBridge.check = () => Promise.resolve({
          state: 'active',
          ok: true,
          quota: 200,
          quotaLimit: 200,
          quotaUsed: 0,
          quotaResetsAfter: '5h 12m'
        });
        window.__mse.open();
      });

      await page.waitForFunction(() => !!window.__mse.root().querySelector('.pop.in'));

      // Switch to gateway / settings route
      await page.evaluate(() => window.__mse.route('gateway'));
      await page.waitForFunction(() => window.__mse.route() === 'gateway');

      const quotaCard = await page.evaluate(() => {
        const root = window.__mse.root();
        const card = root.querySelector('[data-mse="quota-status"]');
        return {
          hasCard: !!card,
          text: card ? card.innerText || card.textContent : ''
        };
      });

      assert.equal(quotaCard.hasCard, true, 'Quota card is rendered in settings');
      assert.match(quotaCard.text, /quota:\s*200\/200/i, 'Shows line 1 "quota: 200/200"');
      assert.match(quotaCard.text, /resets after 5h 12m/i, 'Shows line 2 "resets after 5h 12m"');

    } finally {
      await t.close();
    }

  } finally {
    await new Promise(r => srv.close(r));
  }
});
