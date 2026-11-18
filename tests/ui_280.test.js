'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const h = require('./lib/harness.js');

test('2.8.0 acceptance: question label "куэшон", English "agent", glowing dot, Snif/Report in settings, monochrome debug light', { timeout: 60000 }, async () => {
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

    // Mock bridge URL and clipboard
    await page.evaluate(() => {
      window.__copied = null;
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: text => { window.__copied = text; return Promise.resolve(); } }
      });
      window.MSEBridge.url = () => location.origin;
    });

    // 1. Open popover and verify Bug 8: question label is "куэшон 1"
    await page.evaluate(() => window.__mse.open());
    await page.waitForFunction(() => !!window.__mse.state().pop);

    const subText = await page.evaluate(() => {
      const em = window.__mse.root().querySelector('.ph .t em');
      return em ? em.textContent : '';
    });
    assert.match(subText, /куэшон\s+\d+/i, 'Bug 8: popover question header uses "куэшон N"');
    assert.doesNotMatch(subText, /question\s+\d+/i, 'Bug 8: old "question N" label is gone');

    // 2. UI1: Snif and Report buttons must NOT be present in main answers view
    const mainHasSnifOrReport = await page.evaluate(() => {
      const root = window.__mse.root();
      return {
        snif: !!root.querySelector('[data-mse="snif"]'),
        report: !!root.querySelector('[data-mse="report"]')
      };
    });
    assert.equal(mainHasSnifOrReport.snif, false, 'UI1: Snif is not in main answers screen');
    assert.equal(mainHasSnifOrReport.report, false, 'UI1: Report is not in main answers screen');

    // 3. UI1 & UI2: In settings (gateway), Snif and Report ARE present, and debug mode is monochrome indicator without checkbox
    await page.evaluate(() => window.__mse.route('gateway'));
    await page.waitForFunction(() => window.__mse.route() === 'gateway');

    const gatewayControls = await page.evaluate(() => {
      const root = window.__mse.root();
      const toggle = root.querySelector('.dbg-toggle');
      const light = toggle ? toggle.querySelector('.dbg-light') : null;
      const checkbox = toggle ? toggle.querySelector('input[type="checkbox"]') : null;
      const snif = root.querySelector('[data-mse="snif"]');
      const report = root.querySelector('[data-mse="report"]');
      return {
        hasToggle: !!toggle,
        hasLight: !!light,
        hasCheckbox: !!checkbox,
        hasSnif: !!snif,
        hasReport: !!report,
        beforeOn: light ? light.classList.contains('on') : false
      };
    });
    assert.ok(gatewayControls.hasToggle, 'Debug toggle exists in settings');
    assert.ok(gatewayControls.hasLight, 'Debug light indicator exists in settings');
    assert.equal(gatewayControls.hasCheckbox, false, 'UI2: No checkbox in debug toggle (monochrome indicator only)');
    assert.ok(gatewayControls.hasSnif, 'UI1: Snif button exists in settings');
    assert.ok(gatewayControls.hasReport, 'UI1: Report button exists in settings');

    // Toggle debug mode on tap
    const toggleResult = await page.evaluate(() => {
      const toggle = window.__mse.root().querySelector('.dbg-toggle');
      toggle.click();
      const light = toggle.querySelector('.dbg-light');
      return { afterOn: light.classList.contains('on'), enabled: window.MSEBridge.debugEnabled() };
    });
    assert.equal(toggleResult.afterOn, true, 'Debug light turns ON with glowing white dot');
    assert.equal(toggleResult.enabled, true, 'Bridge debug mode is enabled');

    // 4. Bug 9 & Bug 10: Agent answer row with English "agent" badge and glowing dot in indicator square
    await page.evaluate(() => {
      window.__mse.route('answers');
      // Simulate agent answer received
      const state = window.__mse.state();
      window.__mse.apply('1:М');
    });

    // Check DOM for agent label and styling
    const agentDom = await page.evaluate(() => {
      // Simulate an agent answer row
      window.MSEBridge.agent = () => Promise.resolve({ ok: true, answer: '1:М', model: 'mock-vision' });
      return new Promise(resolve => {
        window.__mse.runAgent();
        setTimeout(() => {
          const root = window.__mse.root();
          const agentRow = root.querySelector('.ans.agent, .ans:has(.tag.agent)');
          const tag = agentRow ? agentRow.querySelector('.tag.agent') : null;
          const mark = agentRow ? agentRow.querySelector('.mark.agent, .mark') : null;
          resolve({
            tagText: tag ? tag.textContent.trim() : null,
            hasMark: !!mark,
            isAgentMark: mark ? mark.classList.contains('agent') : false
          });
        }, 120);
      });
    });

    assert.equal(agentDom.tagText, 'agent', 'Bug 9: Agent label is strictly in English ("agent", no Russian "агент")');

    // Check that ::after rule for glowing dot exists in CSS
    const hasGlowingDotRule = await page.evaluate(() => {
      const container = window.__mse.root().parentNode || window.__mse.root();
      const styles = [...container.querySelectorAll('style')].map(s => s.textContent).join('\n');
      return /\.ans\.agent\s+\.mark::after|\.mark\.agent::after/i.test(styles) && styles.includes('border-radius:50%');
    });
    assert.ok(hasGlowingDotRule, 'Bug 10: CSS contains glowing white dot rule inside agent answer mark square');

    // 5. Schema verification vs quiz_protocol.json
    await page.evaluate(() => {
      window.__mse.route('gateway');
      const snifBtn = window.__mse.root().querySelector('[data-mse="snif"]');
      snifBtn.click();
    });
    await page.waitForFunction(() => window.__mse.route() === 'snif');
    await page.evaluate(() => {
      const copyBtn = window.__mse.root().querySelector('[data-mse="snif-copy"]');
      copyBtn.click();
    });
    await page.waitForFunction(() => typeof window.__copied === 'string' && window.__copied.includes('mse-snif-1'));
    const snifProtocol = await page.evaluate(() => JSON.parse(window.__copied));
    assert.ok(snifProtocol.protocol, 'Protocol field present in snif dump');
    assert.ok('qtype' in snifProtocol.protocol, 'Protocol covers qtype');
    assert.ok('options' in snifProtocol.protocol, 'Protocol covers options');
    assert.ok('checked' in snifProtocol.protocol, 'Protocol covers checked');
    assert.ok('selects' in snifProtocol.protocol, 'Protocol covers selects');
    assert.ok('text_inputs' in snifProtocol.protocol, 'Protocol covers text_inputs');
    assert.ok('images' in snifProtocol.protocol, 'Protocol covers images');
  } finally {
    await t.close();
  }
});
