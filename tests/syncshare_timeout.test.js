'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./lib/harness.js');

test('MSE 2.15.0: Question opens directly to agent without syncshare delay', { timeout: 30000 }, async () => {
  const t = await h.launch({
    allowLocal: true
  });

  try {
    const page = await t.newPage(h.fixtureUrl('attempt'));
    await page.waitForFunction(() => !!window.__mse && !!window.MSEBridge);

    // Setup bridge with active owner status and mock agent answer
    await page.evaluate(() => {
      window.MSEBridge.setUrl(location.origin);
      window.MSEBridge.saveMeta({ device: { deviceId: 'test_dev', moodleId: '1', status: 'active' } }, {});
      window.MSEBridge.check = () => Promise.resolve({ state: 'active' });
      window.MSEBridge.agent = () => Promise.resolve({ ok: true, answer: '1:М', model: 'mock-agent' });
    });

    // Trigger open which immediately loads question and calls agent
    await page.evaluate(() => {
      window.__mse.open();
    });

    // Verify initial state is NOT stuck in database loading
    const state = await page.evaluate(() => window.__mse.state());
    assert.equal(state.loading, false, 'Loading is false because database phase is removed');

    // Wait for agent answer to appear (immediate without 10s database delay)
    await page.waitForFunction(() => {
      const st = window.__mse.state();
      return st.agent && st.agent.state === 'ok' && st.rows && st.rows.some(r => r.agent);
    }, { timeout: 5000 });

    const finalState = await page.evaluate(() => window.__mse.state());
    assert.ok(finalState.rows.some(r => r.label === '1:М' && r.agent), 'Agent answered directly without DB delay');
  } finally {
    await t.close();
  }
});
