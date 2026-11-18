'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./lib/harness.js');

test('WebKit: Cloze multianswer handles multi-control sequencing in document order', { timeout: 90000 }, async () => {
  const t = await h.launch({ api: () => ({ status: 200, json: [] }) });
  try {
    const page = await t.newPage(h.fixtureUrl('attempt'));
    await page.waitForFunction(() => !!window.__mse);
    await page.evaluate(() => {
      const q = document.querySelector('.que');
      q.className = 'que multianswer deferredfeedback notyetanswered';
      q.querySelector('.formulation').innerHTML = `
        <div class="qtext">
          Fill in:
          Part 1 (text): <input type="text" name="q50:1_sub1_answer" id="c_txt1" value="">
          Part 2 (select):
          <select name="q50:1_sub2_answer" id="c_sel">
            <option value="0">Choose...</option>
            <option value="1">Alpha</option>
            <option value="2">Beta</option>
          </select>
          Part 3 (text): <input type="text" name="q50:1_sub3_answer" id="c_txt2" value="">
        </div>
      `;
      window.__mse.open();
    });
    await page.waitForFunction(() => !!window.__mse.state().question);

    const q = await page.evaluate(() => {
      const cur = window.__mse.current();
      return {
        controls: cur.controls.map(c => c.kind)
      };
    });
    assert.deepEqual(q.controls, ['text', 'select', 'text'], 'controls preserve exact document order');

    // Attempt valid 3-part answer
    const applied = await page.evaluate(() => window.__mse.apply('Hello | Beta | World'));
    assert.equal(applied.ok, true);
    assert.equal(applied.how, 'multi');

    const res = await page.evaluate(() => ({
      t1: document.getElementById('c_txt1').value,
      sVal: document.getElementById('c_sel').value,
      t2: document.getElementById('c_txt2').value
    }));
    assert.equal(res.t1, 'Hello');
    assert.equal(res.sVal, '2');
    assert.equal(res.t2, 'World');

    // Attempt invalid dropdown option in 3-part answer
    const invalidApplied = await page.evaluate(() => window.__mse.apply('Hello | Gamma | World'));
    assert.equal(invalidApplied.ok, false, 'invalid dropdown option rejected');

    await page.close();
  } finally {
    await t.close();
  }
});
