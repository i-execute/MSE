'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./lib/harness');

test('C: Moodle 11-inputs multichoice parser extracts all 4 options and excludes hidden fields and clearchoice', { timeout: 60000 }, async () => {
  const t = await h.launch({ api: () => ({ status: 200, json: [] }) });
  try {
    const page = await t.newPage(h.fixtureUrl('attempt'));
    await page.waitForFunction(() => !!window.__mse);

    // Inject realistic Moodle multichoice block with 11 inputs:
    // 4 radio choices, 1 clearchoice radio, 6 hidden inputs (sequencecheck, flagged, postdata, etc.)
    await page.evaluate(() => {
      const q = document.querySelector('.que');
      q.className = 'que multichoice';
      q.id = 'q8128543';
      q.querySelector('.qtext').innerHTML = '<p>What is the output of the code?</p>';
      q.querySelector('.answer').innerHTML = `
        <div class="r0"><input type="radio" name="q8128543:1_answer" id="q8128543:1_answer0" value="0"><label for="q8128543:1_answer0"><span class="answernumber">a. </span><div class="flex-fill">Alpha Variant</div></label></div>
        <div class="r1"><input type="radio" name="q8128543:1_answer" id="q8128543:1_answer1" value="1"><label for="q8128543:1_answer1"><span class="answernumber">b. </span><div class="flex-fill">Beta Variant</div></label></div>
        <div class="r0"><input type="radio" name="q8128543:1_answer" id="q8128543:1_answer2" value="2"><label for="q8128543:1_answer2"><span class="answernumber">c. </span><div class="flex-fill">Gamma Variant</div></label></div>
        <div class="r1"><input type="radio" name="q8128543:1_answer" id="q8128543:1_answer3" value="3"><label for="q8128543:1_answer3"><span class="answernumber">d. </span><div class="flex-fill">Delta Variant</div></label></div>
        <div class="qtype_multichoice_clearchoice"><input type="radio" name="q8128543:1_answer" id="q8128543:1_answer-1" value="-1"><label for="q8128543:1_answer-1">Очистить мой выбор</label></div>
        <input type="hidden" name="q8128543:1_:sequencecheck" value="1">
        <input type="hidden" name="q8128543:1_:flagged" value="0">
        <input type="hidden" class="questionflagpostdata" name="q8128543:1_-flagpostdata" value="qid=8128543">
        <input type="hidden" name="sesskey" value="testsession">
        <input type="hidden" name="slots" value="1">
        <input type="hidden" name="scrollpos" value="0">
      `;
      window.__mse.open();
    });

    await page.waitForFunction(() => !window.__mse.state().loading && !!window.__mse.state().question);

    const qInfo = await page.evaluate(() => {
      const q = window.__mse.current();
      const st = window.__mse.state();
      const root = window.__mse.root();
      const ansButtons = [...root.querySelectorAll('.ans')].map(b => b.querySelector('.lbl').textContent.trim());
      return {
        answersCount: q.answers.length,
        answersText: q.answers.map(a => a.text),
        controlsCount: q.controls.length,
        renderedAnsCount: ansButtons.length,
        renderedAnsLabels: ansButtons
      };
    });

    // 1. All 4 variants are extracted
    assert.equal(qInfo.answersCount, 4, 'exactly 4 answers parsed from 11 inputs');
    assert.deepEqual(qInfo.answersText, [
      'Alpha Variant',
      'Beta Variant',
      'Gamma Variant',
      'Delta Variant'
    ]);

    // 2. Hidden inputs did not leak into controls or answers
    assert.equal(qInfo.controlsCount, 0, 'no hidden fields leaked into controls');

    // 3. Clear choice and hidden fields do not appear in UI
    assert.equal(qInfo.renderedAnsCount, 4, 'exactly 4 option rows rendered in UI');
    assert.ok(!qInfo.renderedAnsLabels.includes('Очистить мой выбор'), 'clearchoice omitted from UI');
    assert.ok(!qInfo.renderedAnsLabels.some(lbl => /sequencecheck|flagged|sesskey/.test(lbl)), 'hidden inputs omitted from UI');

  } finally {
    await t.close();
  }
});
