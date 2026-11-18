'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./lib/harness.js');

test('Bug 1: Syncshare hanging query times out at 10s with "база не ответила" and falls back to agent without blocking popover', { timeout: 30000 }, async () => {
  // Mock API that hangs indefinitely to simulate syncshare hanging on iOS
  const t = await h.launch({
    allowLocal: true,
    api: () => new Promise(() => {})
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

    // Trigger load which initiates the 10s timeout fetch
    await page.evaluate(() => {
      window.__mse.open();
    });

    // Verify initial state is loading
    const initialLoading = await page.evaluate(() => window.__mse.state().loading);
    assert.equal(initialLoading, true, 'Initially in loading state while waiting for DB');

    // Wait for the 10s timeout to trigger "база не ответила"
    await page.waitForFunction(() => {
      const st = window.__mse.state();
      return !st.loading && (st.error === 'база не ответила' || (st.rows && st.rows.some(r => r.agent)));
    }, { timeout: 15000 });

    const state = await page.evaluate(() => window.__mse.state());
    assert.equal(state.loading, false, 'Loading flag cleared on timeout');
    assert.ok(state.rows && state.rows.some(r => r.label === '1:М' && r.agent), 'Agent answered automatically after DB timeout');
  } finally {
    await t.close();
  }
});
