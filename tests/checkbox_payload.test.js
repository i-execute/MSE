'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./lib/harness.js');

test('Stay: checkbox choices are sent with multiple=true, not silently auto-applied', {timeout: 60000}, async () => {
  const t = await h.launch({api: () => ({status: 200, json: []})});
  try {
    const page = await t.newPage(h.fixtureUrl('attempt'));
    await page.waitForFunction(() => !!window.__mse);
    await page.evaluate(() => {
      const q = document.querySelector('.que');
      q.querySelector('.answer').innerHTML = '<div class="r0"><input type="checkbox" name="q9:1_answer0" value="1"><span> First option </span></div><div class="r1"><input type="checkbox" name="q9:1_answer1" value="1"><span> Second option </span></div>';
      window.MSEBridge.url = () => 'configured';
      window.MSEBridge.agent = async payload => { window.__capturedPayload = payload; return {ok:true,answer:'First option'}; };
      window.__mse.open();
    });
    await page.waitForFunction(() => !!window.__mse.state().question);
    await page.evaluate(() => window.__mse.runAgent());
    await page.waitForFunction(() => !!window.__capturedPayload);
    const result = await page.evaluate(() => ({payload: window.__capturedPayload, checked: [...document.querySelectorAll('.que .answer input[type=checkbox]')].map(x => x.checked)}));
    assert.deepEqual(result.payload.options, ['First option', 'Second option']);
    assert.equal(result.payload.multiple, true);
    assert.deepEqual(result.checked, [false, false]);
  } finally { await t.close(); }
});
