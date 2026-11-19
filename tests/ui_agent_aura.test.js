'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./lib/harness.js');

test('MSE 2.13 Agent status strip: flowing light aura, 3 action icons (brain, eye, pencil), shimmering text', { timeout: 60000 }, async () => {
  const t = await h.launch({ api: () => ({ status: 200, json: [] }) });
  try {
    const page = await t.newPage(h.fixtureUrl('attempt'));
    await page.waitForFunction(() => !!window.__mse && !!window.MSEBridge);

    let stageCallback = null;
    let finishAgent = null;

    await page.evaluate(() => {
      window.MSEBridge.url = () => 'https://gateway.example.com';
      window.MSEBridge.meta = () => ({ allowed: true, device: 'mse-1234567890abcdef' });
      window.MSEBridge.check = () => Promise.resolve({ state: 'active', ok: true });
      window.MSEBridge.agent = (payload, onStage) => {
        window.__onStage = onStage;
        return new Promise(resolve => {
          window.__resolveAgent = resolve;
        });
      };
      window.__mse.open();
    });

    await page.waitForFunction(() => {
      const root = window.__mse.root();
      return !!root.querySelector('.pop.in');
    });

    // Start agent running
    await page.evaluate(() => window.__mse.runAgent());
    await page.waitForFunction(() => {
      const root = window.__mse.root();
      return !!root.querySelector('.agent-status-strip');
    });

    // --- State 1: Reasoning (Default) ---
    const reasoningState = await page.evaluate(() => {
      const root = window.__mse.root();
      const strip = root.querySelector('.agent-status-strip');
      const icon = strip ? strip.querySelector('.action-icon.brain-icon') : null;
      const text = strip ? strip.querySelector('.txt') : null;
      return {
        hasStrip: !!strip,
        hasBrainIcon: !!icon,
        isShimmering: text ? text.classList.contains('agent-shimmer') : false,
        text: text ? text.textContent.trim() : ''
      };
    });

    assert.equal(reasoningState.hasStrip, true, 'Agent status strip is present');
    assert.equal(reasoningState.hasBrainIcon, true, 'Reasoning stage has brain action icon');
    assert.equal(reasoningState.isShimmering, true, 'Action text has .agent-shimmer class');
    assert.match(reasoningState.text, /reasoning/i);

    // --- State 2: Looking at image ---
    await page.evaluate(() => {
      if (typeof window.__onStage === 'function') {
        window.__onStage('looking at image');
      }
    });
    await page.waitForTimeout(200);

    const imageState = await page.evaluate(() => {
      const root = window.__mse.root();
      const strip = root.querySelector('.agent-status-strip');
      const icon = strip ? strip.querySelector('.action-icon.eye-icon') : null;
      const text = strip ? strip.querySelector('.txt') : null;
      return {
        hasEyeIcon: !!icon,
        isShimmering: text ? text.classList.contains('agent-shimmer') : false,
        text: text ? text.textContent.trim() : ''
      };
    });

    assert.equal(imageState.hasEyeIcon, true, 'Looking at image stage has eye action icon');
    assert.equal(imageState.isShimmering, true, 'Looking at image text has .agent-shimmer');
    assert.match(imageState.text, /looking at image/i);

    // --- State 3: Writing answer ---
    await page.evaluate(() => {
      if (typeof window.__onStage === 'function') {
        window.__onStage('writing answer');
      }
    });
    await page.waitForTimeout(200);

    const writingState = await page.evaluate(() => {
      const root = window.__mse.root();
      const strip = root.querySelector('.agent-status-strip');
      const icon = strip ? strip.querySelector('.action-icon.pencil-icon') : null;
      const text = strip ? strip.querySelector('.txt') : null;
      return {
        hasPencilIcon: !!icon,
        isShimmering: text ? text.classList.contains('agent-shimmer') : false,
        text: text ? text.textContent.trim() : ''
      };
    });

    assert.equal(writingState.hasPencilIcon, true, 'Writing answer stage has pencil action icon');
    assert.equal(writingState.isShimmering, true, 'Writing answer text has .agent-shimmer');
    assert.match(writingState.text, /writing answer/i);

    // Finish agent
    await page.evaluate(() => {
      if (typeof window.__resolveAgent === 'function') {
        window.__resolveAgent({ ok: true, answer: 'Twitter' });
      }
    });
    await page.waitForTimeout(200);

    const finalState = await page.evaluate(() => {
      const root = window.__mse.root();
      return {
        hasStrip: !!root.querySelector('.agent-status-strip'),
        agentState: window.__mse.agent()?.state
      };
    });
    assert.equal(finalState.hasStrip, false, 'Status strip disappears when answer completes');
    assert.equal(finalState.agentState, 'ok');

  } finally {
    await t.close();
  }
});
