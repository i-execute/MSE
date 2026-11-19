'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./lib/harness.js');

test('MSE 2.13 Multi-choice AI UI: multiple selections, step-by-step applying, popover stays open, brighter illumination feedback', { timeout: 60000 }, async () => {
  const t = await h.launch({ api: () => ({ status: 200, json: [] }) });
  try {
    const page = await t.newPage(h.fixtureUrl('attempt'));
    await page.waitForFunction(() => !!window.__mse && !!window.MSEBridge);

    // 1. Setup question 1 as a multi-choice checkbox question
    await page.evaluate(() => {
      const q = document.querySelector('.que');
      q.className = 'que multichoiceset deferredfeedback notyetanswered';
      q.querySelector('.qtext').textContent = 'Select all European capitals:';
      q.querySelector('.answer').innerHTML = `
        <div class="r0"><label><input type="checkbox" name="q42:1_choice0" value="1"> Paris</label></div>
        <div class="r1"><label><input type="checkbox" name="q42:1_choice1" value="2"> Tokyo</label></div>
        <div class="r0"><label><input type="checkbox" name="q42:1_choice2" value="3"> Berlin</label></div>
        <div class="r1"><label><input type="checkbox" name="q42:1_choice3" value="4"> Madrid</label></div>
      `;
      window.MSEBridge.url = () => 'https://gateway.example.com';
      window.MSEBridge.meta = () => ({ allowed: true, device: 'mse-1234567890abcdef' });
      window.MSEBridge.check = () => Promise.resolve({ state: 'active', ok: true });
      window.MSEBridge.agent = () => Promise.resolve({
        ok: true,
        answer: 'Paris | Berlin | Madrid',
        model: 'gpt-4o-test'
      });
      window.__mse.open();
    });

    await page.waitForFunction(() => {
      const root = window.__mse.root();
      return !!root.querySelector('.pop.in');
    });

    // 2. Run agent
    await page.evaluate(() => window.__mse.runAgent());

    // 3. Wait for agent state to become ok and rows to show all 3 picks
    await page.waitForFunction(() => window.__mse.agent()?.state === 'ok');
    await page.waitForFunction(() => {
      const root = window.__mse.root();
      const agentRows = root.querySelectorAll('.ans.agent');
      return agentRows.length === 3;
    });

    const initialInfo = await page.evaluate(() => {
      const root = window.__mse.root();
      const rows = [...root.querySelectorAll('.ans.agent')];
      return {
        count: rows.length,
        labels: rows.map(r => r.querySelector('.lbl').textContent.trim()),
        hasPopover: !!root.querySelector('.pop.in')
      };
    });

    assert.equal(initialInfo.count, 3, 'All 3 AI chosen answers rendered with agent styling');
    assert.deepEqual(initialInfo.labels, ['Paris', 'Berlin', 'Madrid']);
    assert.equal(initialInfo.hasPopover, true, 'Popover is open');

    // Verify initial checkboxes in Moodle page are unchecked
    const initialChecked = await page.evaluate(() => {
      return [...document.querySelectorAll('input[type="checkbox"]')].map(cb => ({
        name: cb.name,
        checked: cb.checked
      }));
    });
    assert.equal(initialChecked.every(c => !c.checked), true, 'All Moodle checkboxes initially unchecked');

    // 4. Click the first AI pick (Paris)
    await page.evaluate(() => {
      const root = window.__mse.root();
      const first = root.querySelectorAll('.ans.agent')[0];
      first.click();
    });
    await page.waitForTimeout(200);

    // Verify:
    // - Popover is STILL open!
    // - Paris checkbox in Moodle is now checked!
    // - First button has .lit and .applied class (brighter light feedback)
    const afterFirstTap = await page.evaluate(() => {
      const root = window.__mse.root();
      const first = root.querySelectorAll('.ans.agent')[0];
      const cbParis = document.querySelector('input[name="q42:1_choice0"]');
      return {
        popoverOpen: !!root.querySelector('.pop'),
        parisChecked: cbParis ? cbParis.checked : false,
        isLit: first.classList.contains('lit'),
        isApplied: first.classList.contains('applied')
      };
    });

    assert.equal(afterFirstTap.popoverOpen, true, 'Popover MUST stay open after clicking first answer');
    assert.equal(afterFirstTap.parisChecked, true, 'Paris checkbox in Moodle question was checked');
    assert.equal(afterFirstTap.isLit, true, 'First answer button has .lit for brighter glow');
    assert.equal(afterFirstTap.isApplied, true, 'First answer button has .applied');

    // 5. Click the second AI pick (Berlin)
    await page.evaluate(() => {
      const root = window.__mse.root();
      const second = root.querySelectorAll('.ans.agent')[1];
      second.click();
    });
    await page.waitForTimeout(200);

    const afterSecondTap = await page.evaluate(() => {
      const root = window.__mse.root();
      const second = root.querySelectorAll('.ans.agent')[1];
      const cbBerlin = document.querySelector('input[name="q42:1_choice2"]');
      return {
        popoverOpen: !!root.querySelector('.pop'),
        berlinChecked: cbBerlin ? cbBerlin.checked : false,
        isLit: second.classList.contains('lit')
      };
    });

    assert.equal(afterSecondTap.popoverOpen, true, 'Popover still open after second click');
    assert.equal(afterSecondTap.berlinChecked, true, 'Berlin checkbox was checked');
    assert.equal(afterSecondTap.isLit, true, 'Second button is lit');

    // 6. Click the third AI pick (Madrid)
    await page.evaluate(() => {
      const root = window.__mse.root();
      const third = root.querySelectorAll('.ans.agent')[2];
      third.click();
    });
    await page.waitForTimeout(200);

    const afterThirdTap = await page.evaluate(() => {
      const root = window.__mse.root();
      const third = root.querySelectorAll('.ans.agent')[2];
      const cbMadrid = document.querySelector('input[name="q42:1_choice3"]');
      const cbTokyo = document.querySelector('input[name="q42:1_choice1"]');
      return {
        popoverOpen: !!root.querySelector('.pop'),
        madridChecked: cbMadrid ? cbMadrid.checked : false,
        tokyoChecked: cbTokyo ? cbTokyo.checked : false,
        allLit: [...root.querySelectorAll('.ans.agent')].every(b => b.classList.contains('lit'))
      };
    });

    assert.equal(afterThirdTap.popoverOpen, true, 'Popover still available');
    assert.equal(afterThirdTap.madridChecked, true, 'Madrid checkbox was checked');
    assert.equal(afterThirdTap.tokyoChecked, false, 'Tokyo (not chosen by AI) was NOT checked');
    assert.equal(afterThirdTap.allLit, true, 'All 3 AI choices illuminated with brighter light');

  } finally {
    await t.close();
  }
});
