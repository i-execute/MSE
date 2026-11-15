/*
 * B2 — the panel has air: rows do not touch each other, a group is separated from the next, and the head is one line,
 *      not a wall of text.
 * B3 — the theme is black and white only: every colour drawn inside the panel has no hue, the one accent is the white
 *      border of a chosen row, and the screenshots in Storage/screenshots are made here.
 *
 *   node --test tests/b2_b3_theme.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const h = require('./lib/harness.js');
const pw = require('playwright');

const SOURCE = path.join(h.ROOT, 'Storage', 'artifacts', 'mse.user.js');
const SHOTS = path.join(h.ROOT, 'Storage', 'screenshots');
fs.mkdirSync(SHOTS, { recursive: true });

let shared = null;
async function browserOnce() { if (!shared) shared = await pw.webkit.launch(); return shared; }
test.after(async () => { if (shared) await shared.close(); });

const SOLUTION = [{
  anchor: ['A hashtag'],
  suggestions: [{ correctness: 2, confidence: 0.91, label: 'A hashtag', data: { anchor: ['A hashtag'] } }],
  submissions: [
    { correctness: 2, count: 57, label: 'A hashtag', data: { anchor: ['A hashtag'] } },
    { correctness: 0, count: 12, label: 'A tweet', data: { anchor: ['A tweet'] } },
    { correctness: 0, count: 3, label: 'A mention', data: { anchor: ['A mention'] } },
  ],
}];

async function open() {
  const b = await browserOnce();
  const ctx = await b.newContext(Object.assign({}, pw.devices['iPhone 13']));
  const t = await h.launch({
    browser: 'webkit',
    source: fs.readFileSync(SOURCE, 'utf8'),
    api: (req) => {
      if (/ofrep\/v1\/evaluate\/flags/.test(req.path)) return { status: 200, json: {} };
      if (/v2\/quiz\/solution/.test(req.path)) return { status: 200, json: SOLUTION };
      return { status: 200, json: {} };
    },
    state: { bindingName: '__stayBg' + Math.random().toString(36).slice(2, 6) },
    context: ctx,
  });
  t.close = async () => { await ctx.close().catch(() => {}); };
  const page = await t.newPage(null);
  await page.goto(h.fixtureUrl('attempt'), { waitUntil: 'load' });
  await page.waitForTimeout(900);
  return { t, page };
}

/* every piece of colour the panel paints: text, backgrounds and borders of every element in the open shadow root */
async function paint(page) {
  return page.evaluate(() => {
    const root = window.__mse.root();
    if (!root) return null;
    const out = { colored: [], elements: 0, accent: [], radius: [], open: true };
    const parse = (v) => {
      const m = String(v || '').match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const p = m[1].split(',').map((x) => parseFloat(x));
      return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
    };
    const isGray = (c) => c && (Math.abs(c.r - c.g) <= 2 && Math.abs(c.g - c.b) <= 2);
    const walk = (el, cls) => {
      if (!el || el.nodeType !== 1) return;
      out.elements++;
      const cs = getComputedStyle(el);
      [['color', cs.color], ['background', cs.backgroundColor], ['border-top', cs.borderTopColor], ['border-bottom', cs.borderBottomColor]].forEach(([what, v]) => {
        const c = parse(v);
        if (!c || c.a === 0) return;
        if (!isGray(c)) out.colored.push({ what, cls: el.className || el.tagName, value: v });
      });
      [...el.children].forEach((k) => walk(k, cls));
    };
    walk(root, '');
    return out;
  });
}

test('B2 the panel has air: rows do not touch, groups are separated, the head is one line', { timeout: 120000 }, async () => {
  const { t, page } = await open();
  try {
    const st = await page.evaluate(() => { window.__mse.open(); return new Promise((r) => setTimeout(() => r(window.__mse.state()), 900)); });
    assert.ok(st.visible, 'the panel is open with answers in it');
    const air = await page.evaluate(() => {
      const root = window.__mse.root();
      const rows = [...root.querySelectorAll('.ans')];
      const gaps = [];
      for (let i = 1; i < rows.length; i++) {
        const a = rows[i - 1].getBoundingClientRect();
        const b = rows[i].getBoundingClientRect();
        gaps.push(Math.round(b.top - a.bottom));
      }
      const secs = [...root.querySelectorAll('.sec')];
      const pad = (el) => { const cs = getComputedStyle(el); return [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].map((x) => parseFloat(x)); };
      const head = root.querySelector('.ph');
      const headText = (head.querySelector('.t') || {}).innerText || '';
      return {
        rows: rows.length,
        gaps,
        rowPad: rows.length ? pad(rows[0]) : null,
        bodyPad: pad(root.querySelector('.pb')),
        sectionNames: secs.map((s) => s.textContent.trim()),
        sectionCase: secs.map((s) => getComputedStyle(s).textTransform),
        headLines: headText.split('\n').filter(Boolean),
        headHeight: Math.round(head.getBoundingClientRect().height),
      };
    });
    assert.ok(air.rows >= 2, 'there are rows to measure: ' + air.rows);
    assert.ok(air.gaps.every((g) => g >= 6), 'every row is at least 6px from the next: ' + JSON.stringify(air.gaps));
    assert.ok(air.rowPad.every((x) => x >= 9), 'inside a row there is padding: ' + JSON.stringify(air.rowPad));
    assert.ok(air.bodyPad.every((x) => x >= 10), 'the body has a margin of its own: ' + JSON.stringify(air.bodyPad));
    assert.ok(air.headLines.length <= 2, 'the head is the name and one line under it, not a paragraph: ' + JSON.stringify(air.headLines));
    assert.ok(air.headHeight <= 62, 'the head is short: ' + air.headHeight);
    assert.ok(air.sectionCase.every((c) => c === 'none' || c === 'lowercase' || c === 'uppercase'), 'sections are set in one style');
    await page.screenshot({ path: path.join(SHOTS, '1-panel-bw.png') });

    /* the gateway view and the account view: named groups, controls in a stack with a gap */
    await page.evaluate(() => window.__mse.route('gateway'));
    await page.waitForTimeout(500);
    const gw = await page.evaluate(() => {
      const root = window.__mse.root();
      const frow = root.querySelector('.frow');
      const inp = root.querySelector('.inp');
      const secs = [...root.querySelectorAll('.sec')].map((s) => s.textContent.trim());
      const r = frow.getBoundingClientRect(), i2 = inp.getBoundingClientRect();
      return { secs, gapAfterInput: Math.round(r.top - i2.bottom), controls: frow.children.length, headText: root.querySelector('.ph .t').innerText };
    });
    assert.ok(gw.secs.length >= 2, 'the gateway view is split into named groups: ' + JSON.stringify(gw.secs));
    assert.ok(gw.gapAfterInput >= 8, 'the address is not glued to the buttons: ' + gw.gapAfterInput);
    assert.ok(gw.controls >= 1, 'the buttons are there');
    await page.screenshot({ path: path.join(SHOTS, '2-gateway-bw.png') });

    await page.evaluate(() => window.__mse.route('account'));
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(SHOTS, '3-account-bw.png') });
    const acc = await page.evaluate(() => {
      const root = window.__mse.root();
      const vals = [...root.querySelectorAll('.val')];
      const gaps = [];
      for (let i = 1; i < vals.length; i++) gaps.push(Math.round(vals[i].getBoundingClientRect().top - vals[i - 1].getBoundingClientRect().bottom));
      return { values: vals.length, gaps };
    });
    assert.ok(acc.values >= 2, 'the account view shows rows of values');
    assert.ok(acc.gaps.every((g) => g >= 6), 'and they do not touch: ' + JSON.stringify(acc.gaps));
    const keyRow = await page.evaluate(() => {
      const root = window.__mse.root();
      const rows = [...root.querySelectorAll('.val')];
      const row = rows.filter((r) => /key/i.test(r.querySelector('.k').textContent))[0];
      return row ? row.querySelector('.v').textContent.trim() : null;
    });
    assert.ok(keyRow && keyRow.indexOf('…') > 0, 'the device key is shown masked, never in full: ' + keyRow);
    assert.deepEqual(t.errors, []);
  } finally {
    await t.close();
  }
});

test('B3 the theme is black and white: no hue anywhere, one white accent, one system face', { timeout: 120000 }, async () => {
  const { t, page } = await open();
  try {
    await page.evaluate(() => { window.__mse.open(); return new Promise((r) => setTimeout(r, 900)); });
    const answers = await paint(page);
    assert.ok(answers && answers.elements > 8, 'the panel was walked: ' + JSON.stringify(answers && answers.elements));
    assert.deepEqual(answers.colored, [], 'not one coloured pixel in the answers view: ' + JSON.stringify(answers.colored.slice(0, 6)));

    for (const route of ['gateway', 'net', 'account']) {
      await page.evaluate((r) => window.__mse.route(r), route);
      await page.waitForTimeout(400);
      const p = await paint(page);
      assert.deepEqual(p.colored, [], 'no colour on the ' + route + ' view: ' + JSON.stringify(p.colored.slice(0, 6)));
    }
    await page.evaluate(() => window.__mse.route('answers'));
    await page.waitForTimeout(300);

    /* the one accent: the chosen row is marked with white and nothing else */
    const accent = await page.evaluate(() => {
      const root = window.__mse.root();
      const best = root.querySelector('.ans.best');
      if (!best) return null;
      const mark = best.querySelector('.mark');
      const cs = getComputedStyle(mark);
      return { bg: cs.backgroundColor, color: cs.color, border: getComputedStyle(best).borderTopColor };
    });
    assert.ok(accent, 'the chosen answer is on the panel');
    assert.match(accent.bg, /rgba?\((255, 255, 255|0, 0, 0)/, 'the mark is white or black: ' + accent.bg);

    /* the fonts: system only, no downloaded face */
    const fonts = await page.evaluate(() => {
      const root = window.__mse.root();
      const faces = new Set();
      [root, ...root.querySelectorAll('*')].forEach((el) => faces.add(getComputedStyle(el).fontFamily));
      return [...faces];
    });
    const bad = fonts.filter((f) => /Tektur|Onest|JetBrains|Inter|Roboto Mono/.test(f));
    assert.deepEqual(bad, [], 'no downloaded typeface anywhere: ' + JSON.stringify(fonts));

    /* the pill: letters glow, nothing else around it */
    const pill = await page.evaluate(() => {
      const root = window.__mse.root();
      const p = root.querySelector('.pill');
      const cs = getComputedStyle(p);
      return { shadow: cs.boxShadow, textShadow: cs.textShadow, border: cs.borderTopColor, bg: cs.backgroundColor };
    });
    assert.ok(!/rgb\(/.test(pill.shadow.replace(/rgba\([^)]*\)/g, '')) || /^none$/.test(pill.shadow), 'no glow around the pill: ' + pill.shadow);
    assert.match(pill.textShadow, /rgba?\(255, 255, 255/, 'the letters of the pill carry white light: ' + pill.textShadow);
    await page.screenshot({ path: path.join(SHOTS, '4-pill-bw.png'), clip: { x: 0, y: 0, width: 390, height: 200 } });

    /* what was shipped: the old theme is gone from the built file */
    const src = fs.readFileSync(SOURCE, 'utf8');
    for (const old of ['#a9cdff', '#0d1420', '#101a2b', 'Tektur', 'Onest', 'oklch(']) {
      assert.equal(src.indexOf(old), -1, 'the old theme value is gone: ' + old);
    }
    assert.ok(src.indexOf('--paper:#0a0a0a') > 0, 'the black and white palette is in the built file');
    assert.deepEqual(t.errors, []);
  } finally {
    await t.close();
  }
});
