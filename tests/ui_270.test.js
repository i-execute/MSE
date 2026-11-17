'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const h = require('./lib/harness.js');

test('2.7.0 UI acceptance: A1, A2, A4, A5, A6, A8, and sniffer debug schema', { timeout: 60000 }, async () => {
  const t = await h.launch({
    api: () => ({
      status: 200,
      json: [{
        anchor: ['A hashtag'],
        suggestions: [{ correctness: 2, confidence: 0.95, label: 'A hashtag' }],
        submissions: [{ correctness: 2, count: 42, label: 'A hashtag' }]
      }]
    })
  });

  try {
    const page = await t.newPage(h.fixtureUrl('attempt'));
    await page.waitForFunction(() => !!window.__mse && !!window.MSEBridge);

    // Mock clipboard
    await page.evaluate(() => {
      window.__copied = null;
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: text => { window.__copied = text; return Promise.resolve(); } }
      });
      window.MSEBridge.url = () => location.origin;
    });

    // 1. Open popover
    await page.evaluate(() => window.__mse.open());
    await page.waitForFunction(() => !!window.__mse.state().pop);

    // 2. A6: Mini-status button in header
    const hasMiniStatus = await page.evaluate(() => {
      const mini = window.__mse.root().querySelector('button.mini-status');
      return !!mini && mini.textContent.includes('status');
    });
    assert.ok(hasMiniStatus, 'A6: mini-status button is present in header');

    // Click mini-status opens status view
    await page.evaluate(() => {
      window.__mse.root().querySelector('button.mini-status').click();
    });
    await page.waitForFunction(() => window.__mse.route() === 'status');
    const statusItems = await page.evaluate(() => {
      const items = [...window.__mse.root().querySelectorAll('.status-item')].map(el => ({
        k: el.querySelector('.k').textContent,
        v: el.querySelector('.v').textContent
      }));
      return items;
    });
    assert.ok(statusItems.some(i => i.k === 'network'), 'status view includes network');
    assert.ok(statusItems.some(i => i.k === 'agent'), 'status view includes agent');
    assert.ok(statusItems.some(i => i.k === 'gateway'), 'status view includes gateway');
    assert.ok(statusItems.some(i => i.k === 'model'), 'status view includes model');

    // Switch back to answers
    await page.evaluate(() => window.__mse.route('answers'));
    await page.waitForFunction(() => window.__mse.route() === 'answers');

    // 3. A8: Full key copy on account screen
    await page.evaluate(() => window.__mse.route('account'));
    await page.waitForFunction(() => window.__mse.route() === 'account');
    const rawKey = await page.evaluate(() => window.MSEBridge.key());
    assert.ok(rawKey && rawKey.startsWith('mse_') && rawKey.length > 20, 'raw device key exists');

    // Tap on key row
    await page.evaluate(() => {
      const keyRow = [...window.__mse.root().querySelectorAll('.val')].find(b => b.querySelector('.k')?.textContent === 'key');
      if (!keyRow) throw new Error('key row not found');
      keyRow.click();
    });
    await page.waitForFunction(() => window.__copied !== null);
    const copiedKey = await page.evaluate(() => window.__copied);
    assert.equal(copiedKey, rawKey, 'A8: full device key is copied to clipboard, not masked key');

    // 4. A5: Debug mode switch with light indicator
    await page.evaluate(() => window.__mse.route('gateway'));
    await page.waitForFunction(() => window.__mse.route() === 'gateway');
    const debugLight = await page.evaluate(() => {
      const toggle = window.__mse.root().querySelector('.dbg-toggle');
      const light = toggle.querySelector('.dbg-light');
      const input = toggle.querySelector('input[data-mse="debug-mode"]');
      const before = light.classList.contains('on');
      input.checked = true;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      const after = light.classList.contains('on');
      return { before, after, text: toggle.textContent };
    });
    assert.equal(debugLight.before, false);
    assert.equal(debugLight.after, true, 'A5: debug light indicator turns ON');
    assert.ok(debugLight.text.includes('Debug mode'), 'full text is present');

    // 5. A2 & A1: Answer row tap selects option and closes popover immediately
    await page.evaluate(() => window.__mse.route('answers'));
    await page.waitForFunction(() => window.__mse.route() === 'answers');

    // Check answer row
    const rowsCount = await page.evaluate(() => window.__mse.root().querySelectorAll('.ans').length);
    assert.ok(rowsCount >= 1, 'answers row rendered');

    // Click answer row
    await page.evaluate(() => {
      const row = window.__mse.root().querySelector('.ans');
      row.click();
    });
    await page.waitForTimeout(300);

    // Popover must be closed (A2)
    const isPopClosed = await page.evaluate(() => !window.__mse.state().visible);
    assert.ok(isPopClosed, 'A2: popover is closed immediately after selecting an answer row');

    // Moodle form input must be selected
    const inputChecked = await page.evaluate(() => {
      const inp = document.querySelector('input[name="q127:1_answer"][value="0"], input[name="q127:1_answer"]:checked');
      return inp && inp.checked;
    });
    assert.ok(inputChecked, 'A2: Moodle radio input is checked');

    // 6. Sniffer schema captures full questions structure
    const dumpData = await page.evaluate(() => {
      window.__mse.open();
      const snifBtn = window.__mse.root().querySelector('[data-mse="snif"]');
      snifBtn.click();
    });
    await page.waitForFunction(() => window.__mse.route() === 'snif');
    await page.evaluate(() => {
      const copyBtn = window.__mse.root().querySelector('[data-mse="snif-copy"]');
      copyBtn.click();
    });
    await page.waitForFunction(() => typeof window.__copied === 'string' && window.__copied.includes('mse-snif-1'));
    const dump = await page.evaluate(() => JSON.parse(window.__copied));
    assert.equal(dump.schema, 'mse-snif-1');
    assert.ok(Array.isArray(dump.questions), 'sniffer captures full questions array');
    assert.ok(dump.questions.length >= 1, 'at least 1 question captured in schema');
    assert.ok(dump.questions[0].inputs.length >= 1, 'question inputs captured in schema');
  } finally {
    await t.close();
  }
});
