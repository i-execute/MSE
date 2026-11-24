'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const h = require('./lib/harness.js');

test('MSE 2.11 Acceptance: UI kit, unified check, gear & log icons, no agent pct, question #qid, model chip cache, instant debug light, Layer 1 constructor', { timeout: 60000 }, async () => {
  const t = await h.launch({
    api: () => ({
      status: 200,
      json: [{
        anchor: ['1:М'],
        suggestions: [{ correctness: 2, confidence: 0.85, count: 12, share: 85, label: '1:М' }]
      }]
    })
  });

  try {
    const page = await t.newPage(h.fixtureUrl('attempt'));
    await page.waitForFunction(() => !!window.__mse && !!window.MSEBridge);

    // Mock clipboard and gateway URL
    await page.evaluate(() => {
      window.__copied = null;
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: text => { window.__copied = text; return Promise.resolve(); } }
      });
      window.MSEBridge.setUrl(location.origin);
      window.MSEBridge.saveMeta({ device: { deviceId: 'test-device-id-211', moodleId: '12345', status: 'active' } }, {});
    });

    // 1. Open panel and verify B4 (Question subtitle removed from header to make room for model chip)
    await page.evaluate(() => window.__mse.open());
    await page.waitForFunction(() => !!window.__mse.state().pop && !window.__mse.state().loading);

    const subText = await page.evaluate(() => {
      const em = window.__mse.root().querySelector('.ph .t em');
      return em ? em.textContent : '';
    });
    assert.equal(subText, '', 'B4: question subtitle removed from header to make room for model chip');

    // 2. A6: Verify Agent answer row does not show percentage or count
    await page.evaluate(() => {
      window.MSEBridge.agent = () => Promise.resolve({ ok: true, answer: '1:М', model: 'gpt-4o-test' });
      window.__mse.runAgent();
    });
    await page.waitForFunction(() => window.__mse.agent()?.state === 'ok');
    await page.waitForFunction(() => {
      const root = window.__mse.root();
      return !!root.querySelector('.ans.agent, .ans:has(.tag.agent)');
    });

    const agentRow = await page.evaluate(() => {
      const root = window.__mse.root();
      const row = root.querySelector('.ans.agent, .ans:has(.tag.agent)');
      const pct = row ? row.querySelector('.pct') : null;
      return {
        text: row ? row.textContent : '',
        hasPct: !!pct,
        pctText: pct ? pct.textContent : null
      };
    });
    assert.equal(agentRow.hasPct, false, 'A6: Agent answer row has no percentage or count element');

    // 3. A8: Verify Model chip in header caches model from agent answers and displays
    const headerChip = await page.evaluate(() => {
      const chip = window.__mse.root().querySelector('.ph [data-mse="model-chip"]');
      const cached = localStorage.getItem('mse.gateway.lastModel');
      return {
        chipText: chip ? chip.textContent : null,
        cachedModel: cached
      };
    });
    assert.equal(headerChip.chipText, 'gpt-4o-test', 'A8: Header displays active model from agent response');
    assert.equal(headerChip.cachedModel, 'gpt-4o-test', 'A8: Agent model cached to localStorage');

    // 4. A9 & A5: Account view has "gateway settings" with gear icon, and network log with list icon
    await page.evaluate(() => window.__mse.route('account'));
    await page.waitForFunction(() => window.__mse.route() === 'account');

    const accountView = await page.evaluate(() => {
      const root = window.__mse.root();
      const rows = [...root.querySelectorAll('.row')];
      const gwRow = rows.find(r => /gateway settings/i.test(r.textContent));
      const logRow = rows.find(r => /network log/i.test(r.textContent));
      const gwGear = gwRow ? gwRow.querySelector('svg.gear-icon') : null;
      const logIcon = logRow ? logRow.querySelector('svg.log-icon') : null;
      return {
        hasGwRow: !!gwRow,
        hasGwGear: !!gwGear,
        hasLogRow: !!logRow,
        hasLogIcon: !!logIcon
      };
    });
    assert.ok(accountView.hasGwRow, 'A9: "gateway settings" row exists in account view');
    assert.ok(accountView.hasGwGear, 'A9: Gear icon rendered on gateway settings row');
    assert.ok(accountView.hasLogRow, 'A5: "network log" row exists in account view');
    assert.ok(accountView.hasLogIcon, 'A5: Monochrome list icon rendered on network log row');

    // 5. A2 & A1: Gateway view has single unified check button and instant debug toggle
    await page.evaluate(() => window.__mse.route('gateway'));
    await page.waitForFunction(() => window.__mse.route() === 'gateway');

    const gwView = await page.evaluate(() => {
      const root = window.__mse.root();
      const checkBtn = root.querySelector('[data-mse="gateway-check"]');
      const integrateBtn = root.querySelector('[data-mse="integrate-request"]');
      const dbgBtn = root.querySelector('[data-mse="debug-mode"]');
      const dbgLight = dbgBtn ? dbgBtn.querySelector('.dbg-light') : null;
      return {
        hasCheckBtn: !!checkBtn,
        checkText: checkBtn ? checkBtn.textContent.trim() : null,
        hasIntegrateBtn: !!integrateBtn,
        hasDbgBtn: !!dbgBtn,
        dbgLightOn: dbgLight ? dbgLight.classList.contains('on') : false
      };
    });
    assert.ok(gwView.hasCheckBtn, 'A2: Unified check button exists');
    assert.equal(gwView.hasIntegrateBtn, false, 'A2: Separate "Integrate request" button removed');
    assert.ok(gwView.hasDbgBtn, 'A1: Debug mode button exists');

    // A1: Toggle debug mode instantly
    const debugToggled = await page.evaluate(() => {
      const root = window.__mse.root();
      const dbgBtn = root.querySelector('[data-mse="debug-mode"]');
      dbgBtn.click();
      const dbgLight = dbgBtn.querySelector('.dbg-light');
      return {
        lightOn: dbgLight ? dbgLight.classList.contains('on') : false,
        enabled: window.MSEBridge.debugEnabled()
      };
    });
    assert.equal(debugToggled.lightOn, true, 'A1: Debug light turns on instantly on tap');
    assert.equal(debugToggled.enabled, true, 'A1: Debug mode enabled in bridge');

    // 6. A3: Network log copy button is styled and visible
    await page.evaluate(() => window.__mse.route('net'));
    await page.waitForFunction(() => window.__mse.route() === 'net');

    const netLogView = await page.evaluate(() => {
      const root = window.__mse.root();
      const copyBtn = root.querySelector('[data-mse="copy-log"]');
      const clearBtn = root.querySelector('.frow .btn:not([data-mse="copy-log"])');
      return {
        hasCopy: !!copyBtn,
        copyClasses: copyBtn ? copyBtn.className : '',
        copyVisible: copyBtn ? copyBtn.offsetHeight > 0 : false,
        hasClear: !!clearBtn
      };
    });
    assert.ok(netLogView.hasCopy, 'A3: Copy button exists in network log');
    assert.ok(netLogView.copyVisible, 'A3: Copy button is visible');
    assert.match(netLogView.copyClasses, /btn solid/i, 'A3: Copy button has unified solid btn styling');

    // 7. D1, D2, D3: Layer 1 Constructor and sniffer protocol
    const snifDump = await page.evaluate(() => window.__mse.snifDump());
    assert.equal(snifDump.schema_layer, 1, 'D1: schema_layer is 1');
    assert.equal(typeof snifDump.is_known_layer, 'boolean', 'D2: is_known_layer is boolean');
    assert.equal(snifDump.is_known_layer, true, 'D2: multichoice is known layer 1 type');
    assert.ok(snifDump.protocol, 'D3: protocol object present');
    assert.ok(snifDump.protocol.constructor, 'D3: protocol.constructor present');
    assert.equal(snifDump.protocol.constructor.qtype, 'multichoice', 'D3: constructor qtype matches');
    assert.ok(Array.isArray(snifDump.protocol.constructor.options), 'D3: constructor options present');
    assert.equal(typeof snifDump.protocol.constructor.single, 'boolean', 'D3: constructor single boolean present');

    // 8. B1: MSEBridge.probe accepts "MSE" and "MSE gateway"
    const probeContract = await page.evaluate(() => {
      const probeStr = window.MSEBridge.probe.toString();
      return probeStr.includes('MSE gateway') && probeStr.includes('name === \'MSE\'');
    });
    assert.ok(probeContract, 'B1: Probe contract accepts both "MSE" and "MSE gateway"');

  } finally {
    await t.close();
  }
});
