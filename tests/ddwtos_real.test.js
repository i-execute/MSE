'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./lib/harness.js');

test('WebKit: ddwtos is supported, parses drag items, and fills hidden placeinputs on real fixture', { timeout: 90000 }, async () => {
  const t = await h.launch({ api: () => ({ status: 200, json: [] }) });
  try {
    const page = await t.newPage(h.fixtureUrl('attempt'));
    await page.waitForFunction(() => !!window.__mse);

    // Scroll question 2 into view and wait for viewport repositioning
    await page.evaluate(() => {
      document.getElementById('question-127-2').scrollIntoView();
    });
    await page.waitForTimeout(300);
    await page.evaluate(() => {
      window.__mse.open();
    });
    await page.waitForFunction(() => {
      const cur = window.__mse.state().question;
      return cur && cur.type === 'ddwtos';
    });

    const q = await page.evaluate(() => {
      const cur = window.__mse.state().question;
      return {
        type: cur.type,
        supported: cur.supported,
        kind: cur.kind,
        answers: cur.answers,
        placesCount: cur.controls.filter(c => c.kind === 'place').length
      };
    });

    assert.equal(q.type, 'ddwtos');
    assert.equal(q.supported, true, 'ddwtos is supported');
    assert.equal(q.kind, 'ddwtos');
    assert.equal(q.placesCount, 3, '3 drop places detected');
    assert.deepEqual(q.answers, ['Twitter', 'Instagram', 'Facetime', 'LinkedIn', 'Pinterest', 'Youtube']);

    // Apply 3-slot answer
    const applied = await page.evaluate(() => window.__mse.apply('Twitter | Instagram | Facetime'));
    assert.equal(applied.ok, true, 'answer applied');
    assert.equal(applied.how, 'ddwtos');

    const result = await page.evaluate(() => {
      const p1 = document.getElementById('q127_2_p1').value;
      const p2 = document.getElementById('q127_2_p2').value;
      const p3 = document.getElementById('q127_2_p3').value;
      const t1 = document.querySelector('.place1.drop').textContent;
      const t2 = document.querySelector('.place2.drop').textContent;
      const t3 = document.querySelector('.place3.drop').textContent;
      return { p1, p2, p3, t1, t2, t3 };
    });

    assert.equal(result.p1, '1', 'place 1 input set to choice 1 (Twitter)');
    assert.equal(result.p2, '2', 'place 2 input set to choice 2 (Instagram)');
    assert.equal(result.p3, '3', 'place 3 input set to choice 3 (Facetime)');
    assert.match(result.t1, /Twitter/, 'drop 1 contains Twitter text');
    assert.match(result.t2, /Instagram/, 'drop 2 contains Instagram text');
    assert.match(result.t3, /Facetime/, 'drop 3 contains Facetime text');

    // Invalid choice rejected
    const invalid = await page.evaluate(() => window.__mse.apply('Twitter | NonExistentApp | Facetime'));
    assert.equal(invalid.ok, false, 'non-existent choice rejected');

    await page.close();
  } finally {
    await t.close();
  }
});
