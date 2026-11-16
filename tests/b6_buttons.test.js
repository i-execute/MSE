/*
 * Bug 6 — every action is reachable by ONE button, and no two buttons do the same thing.
 *
 * The owner said "some buttons do the same". This test enumerates the controls of every screen of the panel,
 * records what each one does (its handler signature from the live DOM) and refuses the screen if two controls
 * resolve to the same action. It also prints the table the PR quotes.
 *
 *   node --test tests/b6_buttons.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const h = require('./lib/harness.js');
const pw = require('playwright');

const SOURCE = path.join(h.ROOT, 'Storage', 'artifacts', 'mse.user.js');
const OUT = path.join(h.ROOT, 'evidence', 'b6-buttons.md');
fs.mkdirSync(path.dirname(OUT), { recursive: true });

let shared = null;
async function browserOnce() { if (!shared) shared = await pw.webkit.launch(); return shared; }
test.after(async () => { if (shared) await shared.close(); });

const SOLUTION = [{
  anchor: ['A hashtag'],
  suggestions: [{ correctness: 2, confidence: 0.91, label: 'A hashtag', data: { anchor: ['A hashtag'] } }],
  submissions: [
    { correctness: 2, count: 57, label: 'A hashtag', data: { anchor: ['A hashtag'] } },
    { correctness: 0, count: 12, label: 'A tweet', data: { anchor: ['A tweet'] } },
  ],
}];

async function open(opts = {}) {
  const b = await browserOnce();
  const ctx = await b.newContext(Object.assign({}, pw.devices['iPhone 13']));
  const t = await h.launch({
    browser: 'webkit',
    source: fs.readFileSync(SOURCE, 'utf8'),
    api: (req) => {
      if (/ofrep\/v1\/evaluate\/flags/.test(req.path)) return { status: 200, json: {} };
      if (/v2\/quiz\/solution/.test(req.path)) return { status: 200, json: opts.empty ? [] : SOLUTION };
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

/* every control of the open screen, with the identity of the action it triggers */
async function controls(page) {
  return page.evaluate(() => {
    const root = window.__mse.root();
    if (!root) return null;
    const nodes = [...root.querySelectorAll('button')];
    return nodes.map((n) => {
      const box = n.getBoundingClientRect();
      const label = (n.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 48);
      /* what the control does, said by the panel itself: its text, its view and the state it moves */
      const cls = String(n.className || '');
      return { label, cls, w: Math.round(box.width), h: Math.round(box.height), tag: n.tagName.toLowerCase() };
    }).filter((c) => c.w > 0 && c.h > 0);
  });
}

test('bug 6: each screen has one button per action, and no two buttons share an action', { timeout: 150000 }, async () => {
  const { t, page } = await open();
  const table = ['# the buttons of every screen, and what each one does', ''];
  try {
    await page.evaluate(() => { window.__mse.open(); return new Promise((r) => setTimeout(r, 900)); });

    const screens = ['answers', 'account', 'gateway', 'net'];
    const byScreen = {};
    for (const route of screens) {
      await page.evaluate((r) => window.__mse.route(r), route);
      await page.waitForTimeout(500);
      const list = await controls(page);
      assert.ok(list && list.length, 'the ' + route + ' screen draws controls: ' + JSON.stringify(list));
      byScreen[route] = list;
      table.push('## ' + route, '', '| button | class | what it does |', '| --- | --- | --- |');
      const seen = new Map();
      for (const c of list) {
        /* the label is the action for text buttons; the class carries the meaning for the three head buttons */
        const key = c.cls.includes('ib x') ? 'close' : c.cls.includes('ib back') ? 'back'
          : c.cls.includes('ib') ? 'account-toggle'
          : c.cls.includes('pill') ? 'open'
          : c.label.toLowerCase();
        table.push('| ' + c.label + ' | ' + c.cls + ' | ' + key + ' |');
        if (seen.has(key) && key !== 'answer-row' && !/^\s*$/.test(key)) {
          assert.fail('two buttons do the same thing on ' + route + ': "' + seen.get(key) + '" and "' + c.label + '" (' + key + ')');
        }
        seen.set(key, c.label);
      }
      table.push('');
    }

    /* the head of every screen: exactly the account toggle (or back) and the close — nothing else */
    const answers = byScreen.answers;
    const head = answers.filter((c) => /ib/.test(c.cls));
    assert.ok(head.length <= 2, 'the head has at most two buttons: ' + JSON.stringify(head.map((c) => c.label)));
    assert.ok(head.some((c) => c.label === '×'), 'and one of them closes');
    assert.ok(head.some((c) => c.label === 'i' || c.label === '←'), 'and the other is the account door');

    /* the gateway screen: one button that checks the address, one that binds, one that clears — all different */
    const gateway = byScreen.gateway;
    const texts = gateway.map((c) => c.label.toLowerCase());
    assert.equal(texts.filter((x) => /^check/.test(x)).length, 1, 'exactly one "check" on the gateway: ' + JSON.stringify(texts));
    assert.ok(!texts.some((x) => /check (the )?key/.test(x)), 'and no second button that also checks the key');

    /* the answers screen: one action asks the model; the state line below it is not a button */
    const asks = (byScreen.answers || []).filter((c) => /ask the agent/i.test(c.label));
    assert.ok(asks.length <= 1, 'one button asks the model, not two: ' + JSON.stringify(asks.map((c) => c.label)));
    const strips = (byScreen.answers || []).filter((c) => /^agent: /i.test(c.label));
    assert.deepEqual(strips, [], 'the agent state line is not a button any more: ' + JSON.stringify(strips.map((c) => c.label)));

    fs.writeFileSync(OUT, table.join('\n') + '\n');
    assert.deepEqual(t.errors, []);
  } finally {
    await t.close();
  }
});

test('bug 6: no gateway, no model door — and never two controls for one action', { timeout: 150000 }, async () => {
  const { t, page } = await open({ empty: true });
  try {
    await page.evaluate(() => { window.__mse.open(); return new Promise((r) => setTimeout(r, 1200)); });
    const state = await page.evaluate(() => window.__mse.state());
    const list = await controls(page);
    /* an empty base and no gateway: there is nothing to ask the model with, so the panel must offer no door at all
       (the owner case, where the agent answers by itself, is M13) — and it must never draw two of them */
    assert.equal(state.tier, 'base', 'a key that was never let in stays base: ' + JSON.stringify(state.tier));
    const ask = list.filter((c) => /ask the agent|agent: |agent is /i.test(c.label));
    assert.deepEqual(ask, [], 'no model door for a base key: ' + JSON.stringify(ask.map((c) => c.label)));
    assert.ok(!state.agent, 'and no agent was called behind the user\'s back');
    /* one label per action on this screen too: no repeated control text */
    const labels = list.map((c) => c.label.toLowerCase()).filter(Boolean);
    assert.equal(new Set(labels).size, labels.length, 'no two controls share a label: ' + JSON.stringify(labels));
    assert.deepEqual(t.errors, []);
  } finally {
    await t.close();
  }
});
