'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./lib/harness.js');

test('2.10-B: Network retry logic in UI performs up to 2 retries before error', { timeout: 60000 }, async () => {
  const t = await h.launch({ api: () => ({ status: 200, json: [] }) });
  try {
    const page = await t.newPage(h.fixtureUrl('attempt'));
    await page.waitForFunction(() => !!window.__mse && !!window.MSEBridge);

    await page.evaluate(() => {
      window.MSEBridge.url = () => location.origin;
      window.MSEBridge.meta = () => ({ allowed: true, device: 'mse-1234567890abcdef' });
      window.MSEBridge.check = () => Promise.resolve({ state: 'active', ok: true });
      window.__mse.open();
    });
    await page.waitForFunction(() => !!window.__mse.state().pop);

    // Case 1: Fails once with network error, succeeds on retry #1
    await page.evaluate(() => {
      window.__attemptsCase1 = 0;
      window.MSEBridge.agent = (payload, onStage) => {
        window.__attemptsCase1++;
        if (window.__attemptsCase1 === 1) {
          return Promise.reject(new Error('failed to fetch (network error)'));
        }
        return Promise.resolve({ ok: true, answer: '1:М' });
      };
      window.__mse.runAgent();
    });

    // Wait for retry and resolution
    await page.waitForFunction(() => {
      const a = window.__mse.agent();
      return a && a.state === 'ok';
    }, { timeout: 5000 });

    const case1Result = await page.evaluate(() => ({
      attempts: window.__attemptsCase1,
      agent: window.__mse.agent()
    }));
    assert.equal(case1Result.attempts, 2, 'Retried once after first network failure');
    assert.equal(case1Result.agent.state, 'ok');
    assert.equal(case1Result.agent.answer, '1:М');

    // Case 2: Continuous network errors: initial + 2 retries = 3 attempts total, then error
    await page.evaluate(() => {
      window.__attemptsCase2 = 0;
      window.MSEBridge.agent = (payload, onStage) => {
        window.__attemptsCase2++;
        return Promise.reject(new Error('NetworkError: connection lost'));
      };
      window.__mse.runAgent();
    });

    // Wait for all retries to exhaust and error to be set
    await page.waitForFunction(() => {
      const a = window.__mse.agent();
      return a && a.state === 'error';
    }, { timeout: 6000 });

    const case2Result = await page.evaluate(() => ({
      attempts: window.__attemptsCase2,
      agent: window.__mse.agent()
    }));
    assert.equal(case2Result.attempts, 3, 'Tried initial + 2 retries (total 3 attempts)');
    assert.equal(case2Result.agent.state, 'error');

    // Case 3: Non-network error does not retry
    await page.evaluate(() => {
      window.__attemptsCase3 = 0;
      window.MSEBridge.agent = (payload, onStage) => {
        window.__attemptsCase3++;
        return Promise.reject(new Error('forbidden: quota exceeded'));
      };
      window.__mse.runAgent();
    });

    await page.waitForFunction(() => {
      const a = window.__mse.agent();
      return a && a.state === 'error';
    }, { timeout: 2000 });

    const case3Result = await page.evaluate(() => ({
      attempts: window.__attemptsCase3,
      agent: window.__mse.agent()
    }));
    assert.equal(case3Result.attempts, 1, 'Non-network error is not retried');
    assert.equal(case3Result.agent.state, 'error');

  } finally {
    await t.close();
  }
});
