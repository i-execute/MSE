'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./lib/harness.js');

test('MSE 2.13 Error 429/5xx: logs error, displays "something went wrong" and autoreconnect countdown under button', { timeout: 60000 }, async () => {
  const t = await h.launch({ api: () => ({ status: 200, json: [] }) });
  try {
    const page = await t.newPage(h.fixtureUrl('attempt'));
    await page.waitForFunction(() => !!window.__mse && !!window.MSEBridge);

    await page.evaluate(() => {
      window.MSEBridge.url = () => 'https://gateway.example.com';
      window.MSEBridge.meta = () => ({ allowed: true, device: 'mse-1234567890abcdef' });
      window.MSEBridge.check = () => Promise.resolve({ state: 'active', ok: true });
      window.MSEBridge.agent = () => {
        return Promise.resolve({ ok: false, status: 429, code: 'rate_limited', message: 'rate limit reached' });
      };
      window.__mse.open();
    });

    await page.waitForFunction(() => {
      const root = window.__mse.root();
      return !!root.querySelector('.pop.in');
    });

    // Wait for error state to transition to reconnecting
    await page.waitForFunction(() => {
      const ag = window.__mse.agent();
      return ag && ag.state === 'reconnecting';
    });

    // Verify UI shows "something went wrong" and "autoreconnect in ... sec"
    const errorState = await page.evaluate(() => {
      const root = window.__mse.root();
      const strip = root.querySelector('.agent-status-strip, [data-mse="agent-status"]');
      const hint = root.querySelector('.reconnect-hint');
      const logs = window.__mse.log();
      return {
        hasStrip: !!strip,
        stripText: strip ? strip.textContent : '',
        hasHint: !!hint,
        hintText: hint ? hint.textContent : '',
        hasLog: logs.some(l => /HTTP 429|something went wrong/i.test(l.text))
      };
    });

    assert.equal(errorState.hasStrip, true, 'Status strip is shown');
    assert.match(errorState.stripText, /something went wrong/i, 'Shows "something went wrong" in UI');
    assert.equal(errorState.hasHint, true, 'Autoreconnect hint is displayed');
    assert.match(errorState.hintText, /autoreconnect in \d+ sec/i, 'Shows countdown e.g. "autoreconnect in 5 sec"');
    assert.equal(errorState.hasLog, true, 'Error is recorded in extension log');

  } finally {
    await t.close();
  }
});
