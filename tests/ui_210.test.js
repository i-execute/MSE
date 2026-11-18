'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const h = require('./lib/harness.js');

test('MSE 2.10 UI Acceptance: question N, gear icon, no login, copyable device, settings button, compact DEBG, single status row, agent status strip', { timeout: 60000 }, async () => {
  const t = await h.launch({
    api: () => ({
      status: 200,
      json: [{
        anchor: ['1:М'],
        suggestions: [{ correctness: 2, confidence: 0.8, label: '1:М' }]
      }]
    })
  });

  try {
    const page = await t.newPage(h.fixtureUrl('attempt'));
    await page.waitForFunction(() => !!window.__mse && !!window.MSEBridge);

    // Setup clipboard mock and bridge defaults
    await page.evaluate(() => {
      window.__copied = null;
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: text => { window.__copied = text; return Promise.resolve(); } }
      });
      window.MSEBridge.url = () => location.origin;
      window.MSEBridge.meta = () => ({ allowed: true, device: 'mse-1234567890abcdef' });
      window.MSEBridge.check = () => Promise.resolve({ state: 'active', ok: true });
    });

    // Open popover
    await page.evaluate(() => window.__mse.open());
    await page.waitForFunction(() => !!window.__mse.state().pop);

    // 1. A1: Question subtitle is "question N", no "куэшон"
    const subText = await page.evaluate(() => {
      const em = window.__mse.root().querySelector('.ph .t em');
      return em ? em.textContent : '';
    });
    assert.match(subText, /question(?:\s*#?\d+)?/i, 'Question header uses question or question #qid');
    assert.doesNotMatch(subText, /куэшон/i, 'No "куэшон" in header');

    // 2. A9: Letter 'i' replaced by gear icon
    const headerLead = await page.evaluate(() => {
      const root = window.__mse.root();
      const lead = root.querySelector('.ph .ib');
      const gearSvg = lead ? lead.querySelector('svg.gear-icon') : null;
      return {
        hasGear: !!gearSvg,
        ariaLabel: lead ? lead.getAttribute('aria-label') : null,
        text: lead ? lead.textContent.trim() : null
      };
    });
    assert.equal(headerLead.hasGear, true, 'Header has gear SVG icon');
    assert.equal(headerLead.ariaLabel, 'settings');
    assert.notEqual(headerLead.text, 'i', 'Header button text is not "i"');

    // 3. A2 & A7: Open Account view - no login row, device is copyable
    await page.evaluate(() => window.__mse.route('account'));
    await page.waitForFunction(() => window.__mse.route() === 'account');

    const accountRows = await page.evaluate(() => {
      const root = window.__mse.root();
      const vals = [...root.querySelectorAll('.val')].map(v => ({
        k: v.querySelector('.k')?.textContent?.trim(),
        v: v.querySelector('.v')?.textContent?.trim(),
        hasCopy: v.classList.contains('press') && !v.disabled
      }));
      return {
        rows: vals,
        text: root.textContent || ''
      };
    });

    assert.equal(accountRows.rows.some(r => r.k === 'login'), false, 'A2: login row is removed from account');
    const deviceRow = accountRows.rows.find(r => r.k === 'device');
    assert.ok(deviceRow, 'Device row exists');
    assert.equal(deviceRow.hasCopy, true, 'A7: Device row is copyable');

    // Tap device row and verify clipboard
    await page.evaluate(() => {
      const root = window.__mse.root();
      const rows = [...root.querySelectorAll('.val')];
      const dev = rows.find(r => r.querySelector('.k')?.textContent?.trim() === 'device');
      if (dev) dev.click();
    });
    await page.waitForFunction(() => typeof window.__copied === 'string' && window.__copied.length > 0);
    const copiedDev = await page.evaluate(() => window.__copied);
    assert.ok(copiedDev.startsWith('mse-'), 'Tapping device copies full device identifier: ' + copiedDev);

    // 4. A3-A4: Cached key check - button is named "gateway settings" or "settings"
    const settingsBtn = await page.evaluate(() => {
      const root = window.__mse.root();
      const rows = [...root.querySelectorAll('.row')];
      return rows.map(r => r.querySelector('.txt')?.textContent?.trim()).find(t => t === 'settings' || t === 'key accepted' || t === 'gateway settings');
    });
    assert.ok(settingsBtn, 'A3-A4: Button is named "gateway settings" (or "settings"), not "key not checked"');
    assert.doesNotMatch(accountRows.text, /key not checked/, 'No "key not checked" displayed');

    // 5. A5-A6 & A10: View Gateway (settings)
    await page.evaluate(() => window.__mse.route('gateway'));
    await page.waitForFunction(() => window.__mse.route() === 'gateway');

    const gatewayState = await page.evaluate(() => {
      const root = window.__mse.root();
      return {
        hasSnif: !!root.querySelector('[data-mse="snif"]'),
        hasReport: !!root.querySelector('[data-mse="report"]'),
        hasDbg: !!root.querySelector('.dbg-toggle'),
        dbgParentIsFrow: !!root.querySelector('.frow .dbg-toggle'),
        hasCheckBtn: !!root.querySelector('[data-mse="gateway-check"]'),
        hasIntegrateBtn: !!root.querySelector('[data-mse="integrate-request"]')
      };
    });

    assert.equal(gatewayState.hasSnif, false, 'A5: Snif button removed from settings');
    assert.equal(gatewayState.hasReport, false, 'A5: Report button removed from settings');
    assert.equal(gatewayState.hasDbg, true, 'A6: DEBG toggle exists');
    assert.equal(gatewayState.dbgParentIsFrow, true, 'A6: DEBG button is compact in button row');
    assert.equal(gatewayState.hasCheckBtn, true, 'Unified gateway check button exists');

    // 6. 2.10-C: Agent status strip
    await page.evaluate(() => {
      window.MSEBridge.meta = () => ({ allowed: true, device: 'mse-1234567890abcdef' });
      window.MSEBridge.check = () => Promise.resolve({ state: 'active', ok: true });
      window.__mse.route('answers');
    });
    await page.waitForTimeout(300);

    // Simulate running agent with pending stage
    await page.evaluate(() => {
      let resolveAgent;
      window.__resolveAgent = () => resolveAgent({ ok: true, answer: '1:М' });
      window.MSEBridge.agent = (payload, onStage) => {
        if (typeof onStage === 'function') onStage('reasoning');
        return new Promise(resolve => {
          resolveAgent = resolve;
        });
      };
      window.__mse.runAgent();
    });

    const statusStrip = await page.evaluate(() => {
      const root = window.__mse.root();
      const strip = root.querySelector('.agent-status-strip, [data-mse="agent-status"]');
      const ansBusy = root.querySelector('.ans.ai.busy');
      return {
        hasStrip: !!strip,
        stripText: strip ? strip.textContent.trim() : null,
        hasAnsBusy: !!ansBusy
      };
    });

    assert.equal(statusStrip.hasStrip, true, '2.10-C: Dedicated agent status strip rendered');
    assert.equal(statusStrip.hasAnsBusy, false, 'Agent status is NOT rendered inside .ans answer row');
    assert.match(statusStrip.stripText, /reasoning|looking at image/i);

    // Resolve agent promise and verify strip disappears when answer arrives
    await page.evaluate(async () => {
      window.__resolveAgent();
    });
    await page.waitForTimeout(300);
    const stripAfterAnswer = await page.evaluate(() => {
      const root = window.__mse.root();
      return !!root.querySelector('.agent-status-strip');
    });
    assert.equal(stripAfterAnswer, false, 'Agent status strip disappears when answer arrives');

    // 7. A8: Verify no Russian UI text in source files
    const uiSrc = fs.readFileSync(path.join(__dirname, '../Extensions/src/mse-ui.js'), 'utf8');
    const cyrillicMatches = [];
    const lines = uiSrc.split('\n');
    lines.forEach((line, idx) => {
      // Exclude option letter regex and clear choice regex
      if (/replace\(\/\^\[a-zа-я\]/i.test(line) || /очистить мой выбор/i.test(line)) return;
      if (/[\u0400-\u04FF]/.test(line)) cyrillicMatches.push({ line: idx + 1, text: line.trim() });
    });
    assert.deepEqual(cyrillicMatches, [], 'A8: All UI strings in mse-ui.js are strictly English (0 Cyrillic matches)');

  } finally {
    await t.close();
  }
});
