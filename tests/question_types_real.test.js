'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./lib/harness.js');

test('WebKit: universal handling of Layer 1 question types in real Moodle format', { timeout: 90000 }, async () => {
  const t = await h.launch({ api: () => ({ status: 200, json: [] }) });
  try {
    // 1. Real Moodle checkboxes: name="qX:N_choice*"
    {
      const page = await t.newPage(h.fixtureUrl('attempt'));
      await page.waitForFunction(() => !!window.__mse);
      await page.evaluate(() => {
        const q = document.querySelector('.que');
        q.className = 'que multichoice deferredfeedback notyetanswered';
        q.querySelector('.answer').innerHTML = `
          <div class="r0"><input type="checkbox" name="q42:1_choice0" id="c0" value="1"><label for="c0">Apple</label></div>
          <div class="r1"><input type="checkbox" name="q42:1_choice1" id="c1" value="1"><label for="c1">Banana</label></div>
          <div class="r0"><input type="checkbox" name="q42:1_choice2" id="c2" value="1"><label for="c2">Cherry</label></div>
        `;
        window.__mse.open();
      });
      await page.waitForFunction(() => !!window.__mse.state().question);
      const q = await page.evaluate(() => {
        const cur = window.__mse.current();
        return {
          detectedAnswers: cur.answers.length,
          labels: cur.answers.map(a => a.text),
          supported: cur.supported
        };
      });
      assert.equal(q.detectedAnswers, 3, 'all 3 checkboxes detected');
      assert.deepEqual(q.labels, ['Apple', 'Banana', 'Cherry']);

      const applied = await page.evaluate(() => window.__mse.apply('Apple | Cherry'));
      assert.equal(applied.ok, true, 'applied checkbox answer successfully');
      assert.equal(applied.how, 'choice');

      const checked = await page.evaluate(() => [
        document.getElementById('c0').checked,
        document.getElementById('c1').checked,
        document.getElementById('c2').checked
      ]);
      assert.deepEqual(checked, [true, false, true], 'correct checkboxes ticked');
      await page.close();
    }

    // 2. Cloze multianswer with mixed controls (select dropdown + text field)
    {
      const page = await t.newPage(h.fixtureUrl('attempt'));
      await page.waitForFunction(() => !!window.__mse);
      await page.evaluate(() => {
        const q = document.querySelector('.que');
        q.className = 'que multianswer deferredfeedback notyetanswered';
        q.querySelector('.formulation').innerHTML = `
          <div class="qtext">
            The capital of France is
            <select name="q42:2_sub1_answer" id="cloze_sel">
              <option value="0">Choose...</option>
              <option value="1">Lyon</option>
              <option value="2">Paris</option>
            </select>
            and its population is
            <input type="text" name="q42:2_sub2_answer" id="cloze_txt" value="">
          </div>
        `;
        window.__mse.open();
      });
      await page.waitForFunction(() => !!window.__mse.state().question);
      const applied = await page.evaluate(() => window.__mse.apply('Paris | 2.1 million'));
      assert.equal(applied.ok, true, 'Cloze mixed answer applied');
      assert.equal(applied.how, 'multi');

      const values = await page.evaluate(() => ({
        selectVal: document.getElementById('cloze_sel').value,
        selectText: document.getElementById('cloze_sel').options[document.getElementById('cloze_sel').selectedIndex].textContent,
        textVal: document.getElementById('cloze_txt').value
      }));
      assert.equal(values.selectVal, '2');
      assert.equal(values.selectText, 'Paris');
      assert.equal(values.textVal, '2.1 million');
      await page.close();
    }

    // 3. DDWTOS (drag and drop into text)
    {
      const page = await t.newPage(h.fixtureUrl('attempt'));
      await page.waitForFunction(() => !!window.__mse);
      await page.evaluate(() => {
        const q = document.querySelector('.que');
        q.className = 'que ddwtos deferredfeedback notyetanswered';
        q.querySelector('.formulation').innerHTML = `
          <div class="qtext">
            The <span class="place1 drop active">[[1]]</span> jumped over the <span class="place2 drop active">[[2]]</span>
          </div>
          <div class="answercontainer">
            <div class="draggrouphomes">
              <span class="draghome choice1 group1">fox</span>
              <span class="draghome choice2 group1">dog</span>
              <span class="draghome choice3 group1">cat</span>
            </div>
          </div>
          <input type="hidden" class="placeinput place1 group1" id="dd_p1" name="q42:3_p1" value="0">
          <input type="hidden" class="placeinput place2 group1" id="dd_p2" name="q42:3_p2" value="0">
        `;
        window.__mse.open();
      });
      await page.waitForFunction(() => !!window.__mse.state().question);
      const q = await page.evaluate(() => {
        const cur = window.__mse.current();
        return {
          supported: cur.supported,
          kind: cur.kind,
          answers: cur.answers.map(a => a.text),
          controls: cur.controls.map(c => c.kind)
        };
      });
      assert.equal(q.supported, true, 'ddwtos is marked supported');
      assert.equal(q.kind, 'ddwtos');
      assert.deepEqual(q.answers, ['fox', 'dog', 'cat']);
      assert.deepEqual(q.controls, ['place', 'place']);

      const applied = await page.evaluate(() => window.__mse.apply('fox | dog'));
      assert.equal(applied.ok, true, 'ddwtos answer applied');
      assert.equal(applied.how, 'ddwtos');

      const values = await page.evaluate(() => ({
        p1: document.getElementById('dd_p1').value,
        p2: document.getElementById('dd_p2').value,
        drop1Text: document.querySelector('.place1.drop').textContent.trim(),
        drop2Text: document.querySelector('.place2.drop').textContent.trim()
      }));
      assert.equal(values.p1, '1', 'place 1 input gets choice 1');
      assert.equal(values.p2, '2', 'place 2 input gets choice 2');
      assert.match(values.drop1Text, /fox/, 'visual drop 1 shows fox');
      assert.match(values.drop2Text, /dog/, 'visual drop 2 shows dog');
      await page.close();
    }

    // 4. Calculatedmulti: kind: 'choice'
    {
      const page = await t.newPage(h.fixtureUrl('attempt'));
      await page.waitForFunction(() => !!window.__mse);
      await page.evaluate(() => {
        const q = document.querySelector('.que');
        q.className = 'que calculatedmulti deferredfeedback notyetanswered';
        q.querySelector('.answer').innerHTML = `
          <div class="r0"><input type="radio" name="q42:4_answer" id="cm0" value="0"><label for="cm0">4.5 m/s</label></div>
          <div class="r1"><input type="radio" name="q42:4_answer" id="cm1" value="1"><label for="cm1">9.8 m/s</label></div>
        `;
        window.__mse.open();
      });
      await page.waitForFunction(() => !!window.__mse.state().question);
      const q = await page.evaluate(() => {
        const cur = window.__mse.current();
        return {
          supported: cur.supported,
          kind: cur.kind
        };
      });
      assert.equal(q.supported, true);
      assert.equal(q.kind, 'choice', 'calculatedmulti is kind: choice');

      const applied = await page.evaluate(() => window.__mse.apply('9.8 m/s'));
      assert.equal(applied.ok, true);
      const selected = await page.evaluate(() => document.getElementById('cm1').checked);
      assert.equal(selected, true, 'calculatedmulti radio selected');
      await page.close();
    }

    // 5. Numerical / calculated: number entry
    {
      const page = await t.newPage(h.fixtureUrl('attempt'));
      await page.waitForFunction(() => !!window.__mse);
      await page.evaluate(() => {
        const q = document.querySelector('.que');
        q.className = 'que numerical deferredfeedback notyetanswered';
        q.querySelector('.formulation').innerHTML = `
          <div class="qtext">What is gravity acceleration?</div>
          <input type="text" name="q42:5_answer" id="num_ans" value="">
        `;
        window.__mse.open();
      });
      await page.waitForFunction(() => !!window.__mse.state().question);
      const applied = await page.evaluate(() => window.__mse.apply('9.81'));
      assert.equal(applied.ok, true);
      const val = await page.evaluate(() => document.getElementById('num_ans').value);
      assert.equal(val, '9.81', 'numerical value inserted');
      await page.close();
    }

    // 6. Fuzzy letter and index matching for choices (A, (B), 2, a.)
    {
      const page = await t.newPage(h.fixtureUrl('attempt'));
      await page.waitForFunction(() => !!window.__mse);
      await page.evaluate(() => {
        const q = document.querySelector('.que');
        q.className = 'que multichoice deferredfeedback notyetanswered';
        q.querySelector('.answer').innerHTML = `
          <div class="r0"><input type="radio" name="q42:6_answer" id="r0" value="0"><label for="r0">Rome</label></div>
          <div class="r1"><input type="radio" name="q42:6_answer" id="r1" value="1"><label for="r1">Madrid</label></div>
        `;
        window.__mse.open();
      });
      await page.waitForFunction(() => !!window.__mse.state().question);

      // Model returns "B" (letter index)
      const appliedLetter = await page.evaluate(() => window.__mse.apply('B'));
      assert.equal(appliedLetter.ok, true);
      assert.equal(await page.evaluate(() => document.getElementById('r1').checked), true, 'letter B clicked Madrid');

      // Model returns "1. Rome" (prefixed)
      const appliedPrefixed = await page.evaluate(() => window.__mse.apply('1. Rome'));
      assert.equal(appliedPrefixed.ok, true);
      assert.equal(await page.evaluate(() => document.getElementById('r0').checked), true, 'prefixed 1. Rome clicked Rome');

      await page.close();
    }

    // 7. Coderunner / Rich text editor updating with multiline code and pipes
    {
      const page = await t.newPage(h.fixtureUrl('attempt'));
      await page.waitForFunction(() => !!window.__mse);
      await page.evaluate(() => {
        const q = document.querySelector('.que');
        q.className = 'que coderunner deferredfeedback notyetanswered';
        q.querySelector('.formulation').innerHTML = `
          <div class="qtext">Write function foo</div>
          <div class="answer">
            <textarea name="q42:7_answer" id="code_box"></textarea>
            <div contenteditable="true" class="editor_atto_content" id="atto_ed"></div>
          </div>
        `;
        window.__mse.open();
      });
      await page.waitForFunction(() => !!window.__mse.state().question);
      const codePayload = 'def foo(a, b):\n    return a | b';
      const applied = await page.evaluate((c) => window.__mse.apply(c), codePayload);
      assert.equal(applied.ok, true);
      assert.equal(applied.how, 'text');
      const res = await page.evaluate(() => ({
        boxVal: document.getElementById('code_box').value,
        edHtml: document.getElementById('atto_ed').innerHTML
      }));
      assert.equal(res.boxVal, codePayload, 'full multiline code preserved with bitwise pipe intact');
      assert.match(res.edHtml, /def foo\(a, b\):<br>\s*return a \| b/);
      await page.close();
    }

    // 8. True/False cross-lingual: Russian radios ('Верно' / 'Неверно') with English answer 'True'
    {
      const page = await t.newPage(h.fixtureUrl('attempt'));
      await page.waitForFunction(() => !!window.__mse);
      await page.evaluate(() => {
        const q = document.querySelector('.que');
        q.className = 'que truefalse deferredfeedback notyetanswered';
        q.querySelector('.answer').innerHTML = `
          <div class="r0"><input type="radio" name="q42:8_answer" id="tf_t" value="1"><label for="tf_t">Верно</label></div>
          <div class="r1"><input type="radio" name="q42:8_answer" id="tf_f" value="0"><label for="tf_f">Неверно</label></div>
        `;
        window.__mse.open();
      });
      await page.waitForFunction(() => !!window.__mse.state().question);
      const applied = await page.evaluate(() => window.__mse.apply('True'));
      assert.equal(applied.ok, true);
      assert.equal(applied.how, 'choice');
      const isChecked = await page.evaluate(() => document.getElementById('tf_t').checked);
      assert.equal(isChecked, true, 'Russian "Верно" selected via English "True"');
      await page.close();
    }

    // 9. Essay question: supported and populates textarea
    {
      const page = await t.newPage(h.fixtureUrl('attempt'));
      await page.waitForFunction(() => !!window.__mse);
      await page.evaluate(() => {
        const q = document.querySelector('.que');
        q.className = 'que essay deferredfeedback notyetanswered';
        q.querySelector('.formulation').innerHTML = `
          <div class="qtext">Write an essay on photosynthesis</div>
          <div class="answer"><textarea name="q42:9_answer" id="essay_box"></textarea></div>
        `;
        window.__mse.open();
      });
      await page.waitForFunction(() => !!window.__mse.state().question);
      const q = await page.evaluate(() => window.__mse.current());
      assert.equal(q.supported, true, 'essay is now supported');
      assert.equal(q.kind, 'text');

      const essayText = 'Photosynthesis is the process used by plants to convert light energy into chemical energy.';
      const applied = await page.evaluate((txt) => window.__mse.apply(txt), essayText);
      assert.equal(applied.ok, true);
      assert.equal(applied.how, 'text');
      const val = await page.evaluate(() => document.getElementById('essay_box').value);
      assert.equal(val, essayText);
      await page.close();
    }
  } finally {
    await t.close();
  }
});
