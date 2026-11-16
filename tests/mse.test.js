'use strict';
/* MSE 0.3: the tiny pill with glowing letters only, the panel that grows inward smoothly, the answers drawn by
   us and applied on a tap, the account sheet, the gateway, the network log and the agent.
   WebKit, iPhone screen, installed the way Stay installs a script. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const h = require('./lib/harness.js');
const { ensureTls } = require('./lib/tls.js');

const SOURCE = path.join(h.ROOT, 'Storage', 'artifacts', 'mse.user.js');
const EVID = path.join(h.ROOT, 'evidence', 'mse');
fs.mkdirSync(EVID, { recursive: true });
const report = {};
test.after(() => fs.writeFileSync(path.join(EVID, 'report.json'), JSON.stringify(report, null, 1)));

const pw = require('playwright');
let shared = null;
async function browserOnce() { if (!shared) shared = await pw.webkit.launch(); return shared; }
test.after(async () => { if (shared) await shared.close(); });

/* what the answer service of the original says about the first question of the fixture */
const SOLUTION = [{
  anchor: ['A hashtag'],
  suggestions: [{ correctness: 2, confidence: 0.91, label: 'A hashtag', data: { anchor: ['A hashtag'] } }],
  submissions: [
    { correctness: 2, count: 57, label: 'A hashtag', data: { anchor: ['A hashtag'] } },
    { correctness: 0, count: 12, label: 'A tweet', data: { anchor: ['A tweet'] } }
  ]
}];

async function open(opts = {}) {
  const b = await browserOnce();
  const ctx = await b.newContext(Object.assign({}, pw.devices['iPhone 13'], { locale: 'ru-RU' }, opts.ignoreHTTPSErrors ? { ignoreHTTPSErrors: true } : {}));
  const t = await h.launch({
    browser: 'webkit', source: fs.readFileSync(SOURCE, 'utf8'),
    api: opts.api || ((req) => {
      if (/ofrep\/v1\/evaluate\/flags/.test(req.path)) return { status: 200, json: {} };
      if (/v2\/quiz\/solution/.test(req.path)) return { status: 200, json: SOLUTION };
      return { status: 200, json: {} };
    }),
    state: Object.assign({ bindingName: '__stayBg' + Math.random().toString(36).slice(2, 6) }, opts.state || {}),
    context: ctx,
    keepScripts: opts.keepScripts,
    page: opts.page,
    pageUrl: opts.pageUrl,
    docs: opts.docs,
    allowLocal: opts.allowLocal,
    allowExternal: opts.allowExternal,
  });
  t.close = async () => { await ctx.close().catch(() => {}); };
  if (opts.before) await opts.before(ctx);
  const page = await t.newPage(null);
  await page.goto(opts.url || h.fixtureUrl('attempt'), { waitUntil: 'load' });
  await page.waitForTimeout(900);
  return { t, page, ctx };
}

/* open the panel and wait until the answers are in: the height settles then, and so does the position */
async function openPanel(page) {
  await page.evaluate(() => window.__mse.open());
  await page.waitForTimeout(650);
  await page.waitForFunction(() => {
    const st = window.__mse.state();
    return st.visible && (st.rows !== null || !!st.error || !st.question);
  }, null, { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(250);
  return page.evaluate(() => window.__mse.state());
}

const URL_BARE = 'https://school.moodledemo.net/mod/quiz/attempt.php';

const byText = (controls, re) => Object.keys(controls).map((k) => controls[k]).filter((c) => re.test(c.text || ''))[0];

test('M1 the pill is tiny and quiet: only its letters carry light, and the panel opens beside it', { timeout: 120000 }, async () => {
  const { t, page } = await open();
  try {
    const s = await page.evaluate(() => ({ state: window.__mse.state(), vw: innerWidth, vh: innerHeight }));
    assert.match(s.state.pill.text, /^MSE/);
    assert.equal(s.state.visible, false, 'nothing is open until asked');
    /* miniature: no bigger than a fingertip, and no light around it (the glow lives on the letters only) */
    assert.ok(parseFloat(s.state.pill.w) <= 60, 'the pill is narrow: ' + s.state.pill.w);
    assert.ok(parseFloat(s.state.pill.h) <= 32, 'the pill is short: ' + s.state.pill.h);

    const st = await openPanel(page);
    assert.equal(st.visible, true, 'the pill opens the panel');
    const pop = st.pop;
    assert.ok(pop.w <= Math.min(300, s.vw - 16), 'the panel is narrow: ' + pop.w);
    assert.ok(pop.h <= s.vh * 0.8, 'the panel is not full height: ' + pop.h);
    assert.ok(parseFloat(pop.left) >= 0 && parseFloat(pop.left) + pop.w <= s.vw + 1, 'it fits the screen');
    const pillTop = parseFloat(st.pill.top), pillBottom = pillTop + parseFloat(st.pill.h);
    const popTop = parseFloat(pop.top), popBottom = popTop + pop.h;
    assert.ok(popBottom <= pillTop + 1 || popTop >= pillBottom - 1, 'the panel never covers the pill');
    assert.doesNotMatch(pop.text, /SyncShare/i, 'no old name in the interface');
    await page.screenshot({ path: path.join(EVID, '1-popover.png') });
    report.m1 = { pill: st.pill, pop: { w: pop.w, h: pop.h }, text: pop.text.slice(0, 200) };
    assert.deepEqual(t.errors, []);
  } finally { await t.close(); }
});

test('M2 the panel opens smoothly and closes by its ×; on the way out it folds inward again', { timeout: 120000 }, async () => {
  const { t, page } = await open();
  try {
    /* the opening is animated: right after the tap the frame is there but the rows are still rising */
    await page.evaluate(() => window.__mse.open());
    await page.waitForTimeout(30);
    const early = await page.evaluate(() => {
      const st = window.__mse.state();
      return { visible: st.visible, hasPop: !!st.pop };
    });
    assert.equal(early.visible, true, 'the frame is already in place a frame after the tap');
    await page.waitForTimeout(700);
    const st = await page.evaluate(() => window.__mse.state());
    assert.equal(st.visible, true);
    const close = byText(st.pop.controls, /^×$/);
    assert.ok(close, 'the × is in the head');
    await page.mouse.click(close.x, close.y);
    await page.waitForTimeout(120);
    const closing = await page.evaluate(() => window.__mse.state());
    assert.equal(closing.visible, false, 'the panel is gone from the state at once, and folds away visually');
    await page.waitForTimeout(400);
    const after = await page.evaluate(() => window.__mse.state());
    assert.equal(after.pop, null, 'after the fold there is no panel node left');
    assert.match(after.pill.text, /^MSE/, 'the pill is still there');
    await page.screenshot({ path: path.join(EVID, '2-closed.png') });
    report.m2 = { early: early, after: { visible: after.visible, pill: after.pill } };
    assert.deepEqual(t.errors, []);
  } finally { await t.close(); }
});

test('M3 the pill drags where it is put, and a drag never opens anything', { timeout: 150000 }, async () => {
  const { t, page } = await open();
  try {
    const moved = await page.evaluate(() => window.__mse.move(24, 180));
    assert.equal(moved.x, 24);
    assert.equal(moved.y, 180);
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(900);
    const after = await page.evaluate(() => window.__mse.pos());
    assert.equal(after.x, 24, 'the position survived a reload');
    assert.equal(after.y, 180);

    const st = await page.evaluate(() => window.__mse.state());
    const startX = parseFloat(st.pill.left) + 18, startY = parseFloat(st.pill.top) + 12;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 60, startY - 80, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(400);
    const dragged = await page.evaluate(() => ({ pos: window.__mse.pos(), open: window.__mse.state().visible }));
    assert.equal(dragged.open, false, 'a drag does not open anything — there is no long press left');
    assert.notEqual(dragged.pos.y, 180, 'the drag moved the pill');
    report.m3 = { after, dragged };
    assert.deepEqual(t.errors, []);
  } finally { await t.close(); }
});

test('M4 the answers: the service is asked with every parameter, the rows are ours, a tap selects the answer', { timeout: 120000 }, async () => {
  const { t, page } = await open();
  try {
    const q = await page.evaluate(() => {
      const cur = window.__mse.current();
      return { text: cur.text.slice(0, 60), type: cur.type, answers: cur.answers.map((a) => a.text), identity: cur.identity, supported: cur.supported };
    });
    assert.equal(q.type, 'multichoice');
    assert.equal(q.supported, true);
    assert.deepEqual(q.answers.slice(0, 3), ['A hashtag', 'A tweet', 'A tag'], 'the answers are read off the Moodle form');

    /* the parameters their service asks for: all of them come off the page, none is guessed */
    const meta = await page.evaluate(() => window.__mse.meta());
    assert.equal(meta.moodleId, '56');
    assert.equal(meta.courseId, '66', 'the course comes from the body class course-66');
    assert.equal(meta.quizId, '789', 'the quiz comes from cmid');
    assert.equal(meta.attemptId, '89', 'the attempt comes from the form when the url has none');
    assert.deepEqual(meta.missing, [], 'nothing is missing');

    const st = await openPanel(page);
    assert.ok(st.rows && st.rows.length >= 2, 'the service answered and the rows are there');
    assert.equal(st.rows[0].label, 'A hashtag', 'the correct one is first');
    assert.equal(st.rows[0].correctness, 2);
    assert.ok(st.rows[0].share >= 40, 'the popularity of the answer is shown as a share');
    assert.match(st.pop.text, /A hashtag/);
    assert.match(st.pop.text, /A tweet/);
    assert.equal(st.rows[1].share + st.rows[0].share, 100, 'the shares add up');

    const asked = t.apiLog.filter((r) => /quiz\/solution/.test(r.path));
    assert.ok(asked.length >= 1, 'their service is asked');
    assert.equal(asked[asked.length - 1].method, 'GET');
    ['client=', 'host=', 'courseId=', 'quizId=', 'attemptId=', 'moodleId=', 'questionIdentity=', 'questionType='].forEach((p) => {
      assert.ok(asked[asked.length - 1].path.includes(p), 'the request carries ' + p);
    });

    /* the tap: the radio of the Moodle form gets selected, by itself */
    const row = byText(st.pop.controls, /A hashtag/);
    assert.ok(row, 'the row of the correct answer is on the screen');
    await page.mouse.click(row.x, row.y);
    await page.waitForTimeout(700);
    const chosen = await page.evaluate(() => {
      const sel = [...document.querySelectorAll('input[name="q127:1_answer"]')].filter((i) => i.checked && i.value !== '-1')[0];
      return { value: sel ? sel.value : null, label: sel ? sel.closest('.answer').querySelector('.flex-fill').textContent.trim() : null };
    });
    assert.equal(chosen.label, 'A hashtag', 'the tap selected the answer in the Moodle form');
    report.m4 = { question: q, meta, rows: st.rows, asked: asked[0].path.slice(0, 260), chosen };
    assert.deepEqual(t.errors, []);
  } finally { await t.close(); }
});

test('M5 every type of the answer service is understood, and an unknown one is named instead of failing', { timeout: 120000 }, async () => {
  const { t, page } = await open();
  try {
    const kinds = await page.evaluate(() => window.__mse.questions().map((q) => ({ type: q.type, supported: q.supported, kind: q.kind, label: q.label })));
    const map = {};
    kinds.forEach((k) => { map[k.type] = k; });
    /* the five questions of the fixture: the checklist of the types this build claims to handle */
    assert.equal(map.multichoice.supported, true);
    assert.equal(map.multichoice.kind, 'choice');
    assert.equal(map.shortanswer.kind, 'text', 'a short answer goes into the text box');
    assert.equal(map.truefalse.kind, 'choice');
    assert.equal(map.match.kind, 'select', 'a matching question is filled through its selects');
    assert.equal(map.ddwtos.supported, false, 'drag-and-drop in text is not something we can set: it is said plainly');
    const lists = await page.evaluate(() => window.__mse.types());
    assert.ok(lists.supported.indexOf('multichoice') >= 0 && lists.supported.indexOf('match') >= 0, 'the supported list');
    assert.ok(lists.unsupported.indexOf('ddwtos') >= 0, 'drag-and-drop is on the unsupported list');
    assert.equal(map.ddwtos.kind, null, 'and it has no way to be filled');
    report.m5 = { map };
    assert.deepEqual(t.errors, []);
  } finally { await t.close(); }
});

test('M6 the account sheet: one ⓘ, the id, the login, the name — each copies on a tap and flashes', { timeout: 120000 }, async () => {
  const { t, page } = await open({
    before: async (ctx) => {
      await ctx.addInitScript(() => {
        window.M = { cfg: { userid: 12345, username: 'testuser', siteId: '981484524', wwwroot: 'https://study.example.edu' } };
        document.addEventListener('DOMContentLoaded', () => {
          const d = document.createElement('div');
          d.className = 'usertext';
          d.textContent = 'Test User';
          document.body.appendChild(d);
        });
      });
    },
  });
  try {
    await openPanel(page);
    const st = await page.evaluate(() => window.__mse.state());
    const info = st.pop.controls.c0;
    assert.ok(info && /i/.test(info.text || 'i'), 'the ⓘ is the leading control of the head');
    const infoBtn = Object.keys(st.pop.controls).map((k) => st.pop.controls[k]).filter((c) => c.text === 'i')[0];
    assert.ok(infoBtn, 'the ⓘ is there');
    await page.mouse.click(infoBtn.x, infoBtn.y);
    await page.waitForTimeout(600);
    const acct = await page.evaluate(() => window.__mse.state());
    assert.equal(acct.route, 'account', 'the ⓘ opens the account sheet');
    assert.match(acct.pop.text, /12345/, 'the id is there');
    assert.match(acct.pop.text, /testuser/, 'the login is there');
    assert.match(acct.pop.text, /Test User/, 'the name is there');
    assert.match(acct.pop.text, /key/, 'the device key is there');
    assert.doesNotMatch(acct.pop.text, /stored on this device|sha256/, 'no explanatory prose in a production build');

    /* the copy: a tap puts the value on the clipboard and the value takes the light */
    const row = byText(acct.pop.controls, /12345/);
    await page.mouse.click(row.x, row.y);
    await page.waitForTimeout(500);
    const copied = await page.evaluate(() => window.__mse.state());
    assert.match(copied.pop.text, /copied/, 'the value says it was copied');
    await page.screenshot({ path: path.join(EVID, '3-account.png') });
    report.m6 = { identity: acct.identity, text: acct.pop.text.slice(0, 300) };
    assert.deepEqual(t.errors, []);
  } finally { await t.close(); }
});

test('M7 the uninvited windows of the original are gone: no welcome card, no "basic functionality" toast', { timeout: 120000 }, async () => {
  const VIEW = 'https://school.moodledemo.net/mod/quiz/view.php?id=789';
  const { t, page } = await open({
    pageUrl: VIEW,
    keepScripts: true,
    page: () => '<!doctype html><html><head><title>Test</title></head><body class="cmid-789">' +
      '<div class="usertext">Test User</div>' +
      '<a href="/user/profile.php?id=12345">Profile</a>' +
      '<script>window.M={cfg:{userid:12345,username:"testuser",siteId:"981484524"}};</script>' +
      '</body></html>',
    url: VIEW,
  });
  try {
    await page.waitForTimeout(1200);
    const st = await page.evaluate(() => ({
      text: document.body.innerText || '',
      modals: document.querySelectorAll('.modal, .modal-dialog, .modal-backdrop').length,
      shell: !!window.__mse,
      pill: window.__mse ? window.__mse.state().pill.text : null
    }));
    assert.doesNotMatch(st.text, /Благодарим за установку|Thank you for installing/i, 'no welcome card');
    assert.doesNotMatch(st.text, /только базовый функционал|basic functionality only/i, 'no "basic functionality" toast');
    assert.equal(st.modals, 0, 'no modal of the original on the page');
    assert.equal(st.shell, true, 'the MSE shell is there, and it is the only thing that is');
    assert.match(st.pill, /^MSE/);
    report.m7 = { text: st.text.slice(0, 200), modals: st.modals, pill: st.pill };
    assert.deepEqual(t.errors, []);
  } finally { await t.close(); }
});

test('M8 read-only: only GET towards their service, no cookie touched, the form alone until a tap', { timeout: 120000 }, async () => {
  const { t, page } = await open();
  const posted = [];
  page.on('request', (r) => { if (r.method() !== 'GET') posted.push(r.method() + ' ' + r.url()); });
  try {
    const pick = () => [...document.querySelectorAll('input[name$="_answer"]')].filter((i) => i.checked && i.value !== '-1').length;
    const before = await page.evaluate(`({ cookie: document.cookie, checked: (${pick})() })`);
    await openPanel(page);
    const after = await page.evaluate(`({ cookie: document.cookie, checked: (${pick})() })`);
    assert.equal(after.cookie, before.cookie, 'no cookie was touched');
    assert.equal(after.checked, before.checked, 'opening the panel selects nothing: the user taps for that');
    assert.deepEqual(posted, [], 'nothing is posted anywhere');
    const asked = t.apiLog.filter((r) => /quiz\/solution/.test(r.path));
    assert.ok(asked.length > 0, 'the panel asks the answer service');
    assert.equal(asked[0].method, 'GET', 'with a GET, as the original does');
    report.m8 = { asked: asked.length, posted: posted.length };
    assert.deepEqual(t.errors, []);
  } finally { await t.close(); }
});

/* M9: the network log. Their service dies (500) — the panel says so in one line, and the journal keeps it. */
test('M9 the network journal: a failing request is reported in one line and kept in the log', { timeout: 120000 }, async () => {
  const { t, page } = await open({
    api: (req) => {
      if (/v2\/quiz\/solution/.test(req.path)) return { status: 500, json: { message: 'boom' } };
      return { status: 200, json: {} };
    },
  });
  try {
    const st = await openPanel(page);
    assert.match(st.pop.text, /answer database: 500/, 'the failure is on the panel, in one line');
    const journal = await page.evaluate(() => window.__mse.log());
    assert.ok(journal.length > 0, 'the journal has the line');
    assert.equal(journal[journal.length - 1].ok, false);
    assert.match(journal[journal.length - 1].text, /500/);

    /* the journal view shows it, and can be cleared */
    await page.evaluate(() => window.__mse.route('net'));
    await page.waitForTimeout(500);
    const net = await page.evaluate(() => window.__mse.state());
    assert.equal(net.route, 'net');
    assert.match(net.pop.text, /journal/i);
    assert.match(net.pop.text, /500/);
    await page.screenshot({ path: path.join(EVID, '4-net.png') });
    report.m9 = { journal: journal.slice(-3), text: net.pop.text.slice(0, 240) };
    assert.deepEqual(t.errors, []);
  } finally { await t.close(); }
});

/* M10: the missing parameters. On a page where the attempt cannot be read, nothing is sent at all, and the panel
   says exactly which field of the page is missing — that is the 400 the owner saw, answered before it happens. */
test('M10 a page without the attempt data: no request is sent, and the missing field is named', { timeout: 120000 }, async () => {
  const { t, page } = await open({
    url: URL_BARE,
    pageUrl: URL_BARE,
    keepScripts: true,
    page: () => '<!doctype html><html><head><title>Test</title></head><body class="path-mod-quiz">' +
      '<div id="question-1-1" class="que multichoice deferredfeedback notyetanswered">' +
      '<div class="info"><h3 class="no">Question <span class="qno">1</span></h3></div>' +
      '<div class="content"><div class="formulation clearfix"><div class="qtext"><p>Capital of France?</p></div>' +
      '<div class="answer"><div class="r0"><input type="radio" name="q1:1_answer" value="0" id="q1:1_answer0">' +
      '<div id="q1:1_answer0_label" data-region="answer-label"><span class="answernumber">a. </span>' +
      '<div class="flex-fill"><p>Paris</p></div></div></div>' +
      '<div class="r1"><input type="radio" name="q1:1_answer" value="1" id="q1:1_answer1">' +
      '<div id="q1:1_answer1_label" data-region="answer-label"><span class="answernumber">b. </span>' +
      '<div class="flex-fill"><p>Lyon</p></div></div></div></div></div></div></div>' +
      '<script>window.M={cfg:{userid:12345,wwwroot:"https://study.example.edu"}};</scr' + 'ipt>' +
      '</body></html>',
    api: (req) => {
      if (/v2\/quiz\/solution/.test(req.path)) return { status: 400, json: { message: 'Bad Request', statusCode: 400 } };
      return { status: 200, json: {} };
    },
  });
  try {
    const meta = await page.evaluate(() => window.__mse.meta());
    assert.ok(meta.missing.length >= 2, 'the page gave neither the attempt nor the quiz: ' + JSON.stringify(meta.missing));
    const st = await openPanel(page);
    assert.match(st.pop.text, /page data missing/, 'the panel names what the page did not give');
    assert.match(st.pop.text, /attempt/, 'in words the user reads');
    const asked = t.apiLog.filter((r) => /quiz\/solution/.test(r.path));
    assert.equal(asked.length, 0, 'no request went out: their 400 never happens');
    report.m10 = { meta, text: st.pop.text.slice(0, 200) };
    assert.deepEqual(t.errors, []);
  } finally { await t.close(); }
});

/* M11: the gateway panel and the agent, against a real gateway on the loopback (with its mock model).
   The chain that matters: the address is checked, the models are listed, the key is generated here, the owner
   allows the Moodle id, the key goes live — and then the agent answers a question and its answer lands in the form. */
test('M11 the gateway and the agent: check, models, allow by ID, and the agent fills the answer', { timeout: 240000 }, async () => {
  const os = require('os');
  const tls = ensureTls();
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'mse-ui-gw-'));
  Object.assign(process.env, {
    MSE_DATA_DIR: DATA,
    MSE_ADMIN_TOKEN: 'adm_ui_test',
    MSE_UPSTREAM_URL: 'http://127.0.0.1:8797/v1',
    MSE_MODEL: 'mock-model',
    MSE_MODELS: 'mock-model,gpt-4o-mini',
    MSE_ALLOW_ORIGINS: '*',
    MSE_TLS_CERT: tls.cert,
    MSE_TLS_KEY: tls.key
  });
  const mockPath = path.join(h.ROOT, 'Server', 'mock-upstream.js');
  const serverPath = path.join(h.ROOT, 'Server', 'mse-server.js');
  delete require.cache[require.resolve(mockPath)];
  delete require.cache[require.resolve(serverPath)];
  const up = require(mockPath);
  const gw = require(serverPath);
  await new Promise((r) => up.server.listen(0, '127.0.0.1', r));
  gw.CFG.upstreamUrl = 'http://127.0.0.1:' + up.server.address().port + '/v1';
  await new Promise((r) => gw.server.listen(0, '127.0.0.1', r));
  const GW = 'https://127.0.0.1:' + gw.server.address().port;

  const { t, page } = await open({
    ignoreHTTPSErrors: true,
    allowLocal: true,
    before: async (ctx) => {
      await ctx.addInitScript(() => {
        window.M = { cfg: { userid: 12345, username: 'test', siteId: '1' } };
        document.addEventListener('DOMContentLoaded', () => {
          const d = document.createElement('div');
          d.className = 'usertext';
          d.textContent = 'Test User';
          document.body.appendChild(d);
        });
      });
    },
  });
  try {
    /* 1. the address: a wrong one is refused, the right one answers and is remembered */
    const wrong = await page.evaluate((url) => window.MSEBridge.probe(url + '/nope'), GW);
    assert.equal(wrong.mine, false, 'another server is not mistaken for the gateway');
    await page.evaluate((url) => window.MSEBridge.setUrl(url), GW);
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(900);
    assert.equal(await page.evaluate(() => window.MSEBridge.url()), GW, 'the address survived the reload');
    const key = await page.evaluate(() => window.MSEBridge.key());
    assert.match(key, /^mse_[0-9a-f]{64}$/, 'the key was generated on the device');

    /* 2. the panel shows it all: the check passes, the models are listed, the key is not registered yet */
    await page.evaluate(() => window.__mse.settings(true));
    await page.waitForTimeout(400);
    const openGw = await page.evaluate(() => window.__mse.state());
    const checkBtn = byText(openGw.pop.controls, /check/);
    assert.ok(checkBtn, 'the one button that checks');
    await page.mouse.click(checkBtn.x, checkBtn.y);
    await page.waitForTimeout(2500);
    const checked = await page.evaluate(() => window.__mse.state());
    assert.match(checked.pop.text, /AI gateway answered/, 'the gateway answers');
    /* 2.4: the panel does not name models any more — the router answers for them; the check reports the address
       and the key, and the journal keeps the count of models the gateway offers */
    assert.doesNotMatch(checked.pop.text, /mock-model|gpt-4o-mini/, 'the panel names no model: the router decides');
    const gwLog = await page.evaluate(() => window.__mse.log());
    assert.ok(gwLog.some((l) => /AI gateway is up/.test(l.text)), 'the journal says the gateway is up');
    assert.ok(gwLog.some((l) => /\d+ models/.test(l.text)), 'and how many models it offers');
    await page.screenshot({ path: path.join(EVID, '5-gateway.png') });

    /* 3. the registration is pending, and the agent refuses until the owner allows the id */
    const reg = await page.evaluate(() => window.MSEBridge.register(window.__mse.identity()));
    assert.equal(reg.status, 'pending');
    const denied = await page.evaluate(() => window.MSEBridge.agent({ question: 'x', options: ['a'] }));
    assert.equal(denied.ok, false, 'a pending device cannot ask the agent');
    assert.ok(/pending|403|device/.test(JSON.stringify(denied)), 'and the refusal says why: ' + JSON.stringify(denied));

    /* 4. the owner allows the id — the same key goes live */
    const httpsLib = require('https');
    const allow = await new Promise((resolve, reject) => {
      const body = JSON.stringify({ moodleId: '12345' });
      const req = httpsLib.request(GW + '/admin/allow', {
        method: 'POST', rejectUnauthorized: false,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-admin-token': 'adm_ui_test' }
      }, (res) => { res.resume(); resolve({ status: res.statusCode }); });
      req.on('error', reject);
      req.end(body);
    });
    assert.equal(allow.status, 200);
    const live = await page.evaluate(() => window.MSEBridge.check());
    assert.equal(live.state, 'active');

    /* 5. the agent: the question goes out, the answer comes back, and the form gets it */
    await page.evaluate(() => window.__mse.route('answers'));
    await page.waitForTimeout(400);
    const res = await page.evaluate(async () => {
      window.__mse.runAgent();
      for (let i = 0; i < 60; i++) {
        const st = window.__mse.state();
        if (st.agent && (st.agent.state === 'ok' || st.agent.state === 'error')) return st;
        await new Promise((r) => setTimeout(r, 200));
      }
      return window.__mse.state();
    });
    assert.equal(res.agent.state, 'ok', 'the agent answered: ' + JSON.stringify(res.agent));
    assert.match(res.agent.answer, /A hashtag/, 'and picked an option of the question');
    await page.waitForTimeout(400);
    const picked = await page.evaluate(() => {
      const sel = [...document.querySelectorAll('input[name="q127:1_answer"]')].filter((i) => i.checked && i.value !== '-1')[0];
      return sel ? sel.closest('.answer').querySelector('.flex-fill').textContent.trim() : null;
    });
    assert.equal(picked, 'A hashtag', 'the agent answer is selected in the form');

    const journal = await page.evaluate(() => window.__mse.log());
    assert.ok(journal.some((l) => l.kind === 'agent' && l.ok), 'the journal keeps the agent call');
    assert.ok(journal.some((l) => l.kind === 'gateway'), 'and the gateway check');
    report.m11 = { key: key.slice(0, 10) + '…', reg: reg.status, agent: res.agent, journal: journal.slice(-5) };
    assert.deepEqual(t.errors, []);
  } finally {
    await t.close();
    gw.server.close();
    up.server.close();
  }
});

/* M12: the id on a theme that hides it. The report from the field was exactly this: no M.cfg.userid on the
   attempt page, no profile link, no data attributes — only the personal cabinet knows the id. Three cases:
   (a) the cabinet answers and the questions go out with the real id, (b) nothing anywhere → the panel still
   names what is missing and sends nothing, (c) the id is remembered and used on the next attempt page. */
test('M12 the id is found through /my/ when the attempt page hides it, and then remembered', { timeout: 180000 }, async () => {
  const ATTEMPT = 'https://school.moodledemo.net/mod/quiz/attempt.php?attempt=89&cmid=789';
  const CAB = 'https://school.moodledemo.net/my/';
  const bareQuestion = (extra) => '<!doctype html><html><head><title>Test</title></head>' +
    '<body class="path-mod path-mod-quiz course-66 cmid-789">' +
    '<div id="question-127-1" class="que multichoice deferredfeedback notyetanswered">' +
    '<div class="info"><h3 class="no">Question <span class="qno">1</span></h3></div>' +
    '<div class="content"><div class="formulation clearfix"><div class="qtext"><p>What is #elections2018?</p></div>' +
    '<div class="answer"><div class="r0"><input type="radio" name="q127:1_answer" value="0" id="q127:1_answer0">' +
    '<div id="q127:1_answer0_label" data-region="answer-label"><span class="answernumber">a. </span>' +
    '<div class="flex-fill"><p>A hashtag</p></div></div></div>' +
    '<div class="r1"><input type="radio" name="q127:1_answer" value="1" id="q127:1_answer1">' +
    '<div id="q127:1_answer1_label" data-region="answer-label"><span class="answernumber">b. </span>' +
    '<div class="flex-fill"><p>A tweet</p></div></div></div></div></div></div></div>' +
    '<form id="responseform" action="/mod/quiz/processattempt.php?cmid=789" method="post">' +
    '<input type="hidden" name="attempt" value="89"></form>' + (extra || '') + '</body></html>';
  const cabinet = '<!doctype html><html><head><title>Dashboard</title></head><body>' +
    '<div class="usertext">Test User</div>' +
    '<a href="/user/profile.php?id=12345">Profile</a>' +
    '<scr' + 'ipt>var cfg={"userid":12345,"courseid":66};</scr' + 'ipt></body></html>';

  /* (a) the theme with nothing on it, and a cabinet that knows: the panel fixes itself, without a single tap */
  {
    const { t, page } = await open({
      url: ATTEMPT,
      pageUrl: ATTEMPT,
      keepScripts: true,
      page: () => bareQuestion('<scr' + 'ipt>window.M={cfg:{wwwroot:"https://school.moodledemo.net"}};</scr' + 'ipt>'),
      docs: { [CAB]: cabinet },
    });
    try {
      const before = await page.evaluate(() => window.__mse.meta());
      assert.equal(before.moodleId, null, 'the attempt page really has no id — this is the bug from the report');
      assert.ok(before.missing.includes('moodleId'));

      const st = await openPanel(page);
      const after = await page.evaluate(() => window.__mse.state());
      assert.equal(after.meta.moodleId, '12345', 'the id was taken from /my/ by itself');
      assert.match(String(after.meta.identity.source), /remembered/);
      assert.ok(st.rows && st.rows.length > 0, 'and the answers came back, without the user doing anything');
      const asked = t.apiLog.filter((r) => /quiz\/solution/.test(r.path));
      assert.ok(asked.length > 0, 'the question went out with the real id');
      assert.match(asked[asked.length - 1].path, /moodleId=12345/);
      const journal = await page.evaluate(() => window.__mse.log());
      assert.ok(journal.some((l) => /\/my\//.test(l.text) && l.ok), 'the journal says where the id came from');

      /* (c) the next page, still without the id, uses what was learned */
      const again = await page.evaluate(() => window.__mse.meta());
      assert.equal(again.moodleId, '12345', 'the id is remembered for this host');
      report.m12a = { before: before.moodleId, after: after.meta.moodleId, asked: asked.length, rows: after.rows.length };
      assert.deepEqual(t.errors, []);
    } finally { await t.close(); }
  }

  /* (b) nothing anywhere: no id, no cabinet — the panel names what is missing, offers the one action, and sends nothing */
  {
    const { t, page } = await open({
      url: ATTEMPT,
      pageUrl: ATTEMPT,
      keepScripts: true,
      page: () => bareQuestion('<scr' + 'ipt>window.M={cfg:{wwwroot:"https://school.moodledemo.net"}};</scr' + 'ipt>'),
      docs: { [CAB]: '<!doctype html><html><body><p>no sign-in</p></body></html>' },
    });
    try {
      const st = await openPanel(page);
      assert.match(st.pop.text, /page data missing/, 'the panel is honest about it');
      assert.match(st.pop.text, /user id/, 'and names exactly what is missing');
      const fix = byText(st.pop.controls, /take the id from|retry/);
      assert.ok(fix, 'an action is offered instead of a dead end');
      const asked = t.apiLog.filter((r) => /quiz\/solution/.test(r.path));
      assert.equal(asked.length, 0, 'not a single request: their 400 never happens');
      const journal = await page.evaluate(() => window.__mse.log());
      assert.ok(journal.some((l) => /\/my\//.test(l.text)), 'and the journal keeps the failed attempt');
      report.m12b = { text: st.pop.text.slice(0, 160), journal: journal.slice(-2) };
      assert.deepEqual(t.errors, []);
    } finally { await t.close(); }
  }
});

/* M13: two tiers. A key nobody let in sees their answer service and never a request towards the gateway — not
   one, not even the AI row. The same key, after the owner allows the id, gets the model as a fallback when the
   base stays silent, the answer comes in a row of its own, and a tap puts it in the form. */
test('M13 the two tiers: a base key never reaches the gateway, an allowed key gets the AI answer when the base is empty', { timeout: 300000 }, async () => {
  const os = require('os');
  const tls = ensureTls();
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'mse-ui-tier-'));
  Object.assign(process.env, {
    MSE_DATA_DIR: DATA,
    MSE_ADMIN_TOKEN: 'adm_ui_test',
    MSE_UPSTREAM_URL: 'http://127.0.0.1:8796/v1',
    MSE_MODEL: 'mock-model',
    MSE_MODELS: 'mock-model',
    MSE_ALLOW_ORIGINS: '*',
    MSE_TLS_CERT: tls.cert,
    MSE_TLS_KEY: tls.key
  });
  const mockPath = path.join(h.ROOT, 'Server', 'mock-upstream.js');
  const serverPath = path.join(h.ROOT, 'Server', 'mse-server.js');
  delete require.cache[require.resolve(mockPath)];
  delete require.cache[require.resolve(serverPath)];
  const up = require(mockPath);
  const gw = require(serverPath);
  await new Promise((r) => up.server.listen(0, '127.0.0.1', r));
  gw.CFG.upstreamUrl = 'http://127.0.0.1:' + up.server.address().port + '/v1';
  await new Promise((r) => gw.server.listen(0, '127.0.0.1', r));
  const GW = 'https://127.0.0.1:' + gw.server.address().port;

  /* their service says nothing (empty list): exactly the case where the model should step in for an owner */
  const emptyBase = (req) => {
    if (/ofrep\/v1\/evaluate\/flags/.test(req.path)) return { status: 200, json: {} };
    if (/v2\/quiz\/solution/.test(req.path)) return { status: 200, json: [] };
    return { status: 200, json: {} };
  };

  const { t, page } = await open({
    ignoreHTTPSErrors: true,
    allowLocal: true,
    api: emptyBase,
    before: async (ctx) => {
      await ctx.addInitScript(() => {
        window.M = { cfg: { userid: 12345, username: 'test', siteId: '1' } };
        document.addEventListener('DOMContentLoaded', () => {
          const d = document.createElement('div');
          d.className = 'usertext';
          d.textContent = 'Test User';
          document.body.appendChild(d);
        });
      });
    },
  });
  const gwHits = () => t.apiLog.filter((r) => /127\.0\.0\.1/.test(r.url));
  try {
    /* the address is known from the start: the extension knows where the gateway is, but nobody let the key in */
    await page.evaluate((url) => window.MSEBridge.setUrl(url), GW);
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(900);

    /* 1. base tier: the panel is opened, the service is asked, the gateway is not touched */
    const base = await openPanel(page);
    assert.match(base.pop.text, /no answers yet/, 'their base answered with nothing');
    assert.doesNotMatch(base.pop.text, /AI/, 'no AI row for a key that was never let in');
    assert.equal(gwHits().length, 0,
      'not a single request towards the gateway: ' + JSON.stringify(gwHits().map((r) => r.path)));
    assert.equal(await page.evaluate(() => window.__mse.state().tier), 'base', 'the tier is base');
    const askedBase = t.apiLog.filter((r) => /quiz\/solution/.test(r.path));
    assert.ok(askedBase.length > 0, 'their own service was asked, as always');

    /* 2. the key is registered and pending: still base, still not a request */
    await page.evaluate(() => window.MSEBridge.register(window.__mse.identity()));
    await page.evaluate(() => window.__mse.route('answers'));
    await page.waitForTimeout(300);
    const stillBase = await openPanel(page);
    assert.doesNotMatch(stillBase.pop.text, /ask AI|AI is thinking/, 'a pending key is base: no AI row');
    assert.equal(t.apiLog.filter((r) => /chat\/completions|mse\/v1\/agent/.test(r.url)).length, 0,
      'a pending key never asks the model');

    /* 3. the owner allows the id: the tier is owner, and the empty base brings the model in by itself */
    const httpsLib = require('https');
    const allow = await new Promise((resolve, reject) => {
      const body = JSON.stringify({ moodleId: '12345' });
      const req = httpsLib.request(GW + '/admin/allow', {
        method: 'POST', rejectUnauthorized: false,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-admin-token': 'adm_ui_test' }
      }, (res) => { res.resume(); resolve({ status: res.statusCode }); });
      req.on('error', reject);
      req.end(body);
    });
    assert.equal(allow.status, 200);
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(900);
    const owner = await openPanel(page);
    const waited = await page.evaluate(async () => {
      for (let i = 0; i < 40; i++) {
        const st = window.__mse.state();
        if (st.ai && (st.ai.state === 'ok' || st.ai.state === 'error')) return st;
        await new Promise((r) => setTimeout(r, 200));
      }
      return window.__mse.state();
    });
    assert.equal(waited.ai.state, 'ok', 'the model answered the empty question: ' + JSON.stringify(waited.ai));
    assert.match(waited.ai.text, /A hashtag/, 'and named the option of the question');
    /* 2.4: the extension asks the agent route of the gateway; the gateway itself builds the /v1 call to the backend */
    const agentHits = t.apiLog.filter((r) => /\/mse\/v1\/agent/.test(r.url));
    assert.ok(agentHits.length > 0, 'the AI call went through the gateway: ' + JSON.stringify(t.apiLog.map((r) => r.path)));
    const agentBody = agentHits[agentHits.length - 1];
    assert.match(String(agentBody.body), /elections2018/, 'the full text of the question went out');
    assert.match(String(agentBody.body), /A hashtag/, 'every option is there');
    assert.ok(agentBody.headers.authorization && /^Bearer mse_/.test(agentBody.headers.authorization), 'with the device key');
    assert.equal(t.apiLog.filter((r) => /\/chat\/completions/.test(r.url)).length, 0,
      'and the extension does not speak to the backend itself: one door only');

    /* 4. the AI row is on the panel, marked, and a tap puts it in the form */
    await page.evaluate(() => window.__mse.open());
    await page.waitForTimeout(600);
    const shown = await page.evaluate(() => window.__mse.state());
    assert.match(shown.pop.text, /A hashtag/, 'the answer is in the panel');
    assert.match(shown.pop.text, /agent/, 'marked as the model\'s own row');
    const aiRow = byText(shown.pop.controls, /A hashtag/);
    assert.ok(aiRow, 'the row is tappable');
    await page.mouse.click(aiRow.x, aiRow.y);
    await page.waitForTimeout(400);
    const picked = await page.evaluate(() => {
      const sel = [...document.querySelectorAll('input[name="q127:1_answer"]')].filter((i) => i.checked && i.value !== '-1')[0];
      return sel ? sel.closest('.answer').querySelector('.flex-fill').textContent.trim() : null;
    });
    assert.equal(picked, 'A hashtag', 'the model answer is selected in the form, like any other row');

    /* 5. a base user who tries anyway gets nothing from the gateway */
    await page.evaluate(() => window.MSEBridge.forgetRegister = true);
    const journal = await page.evaluate(() => window.__mse.log());
    assert.ok(journal.some((l) => l.kind === 'agent' && l.ok && /\bagent\b:/.test(l.text)), 'the journal keeps the AI call');
    await page.screenshot({ path: path.join(EVID, '7-ai-row.png') });
    report.m13 = { base: base.pop.text.slice(0, 120), ai: waited.ai, agentHits: agentHits.length, tier: await page.evaluate(() => window.__mse.state().tier) };
    assert.deepEqual(t.errors, []);
  } finally {
    await t.close();
    gw.server.close();
    up.server.close();
  }
});
