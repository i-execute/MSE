/*
 * B1 — the new gateway address replaces the old one everywhere.
 *
 * The owner changes the address in the panel. From that moment there is exactly one address: the new one, in the
 * site localStorage, in the Stay storage and in the bridge mirror — and the old one is gone from every one of them,
 * so nothing (a reload, the agent call, the panel itself) can come back to it.
 *
 *   node --test tests/b1_address.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const h = require('./lib/harness.js');
const pw = require('playwright');
let shared = null;
async function browserOnce() { if (!shared) shared = await pw.webkit.launch(); return shared; }
test.after(async () => { if (shared) await shared.close(); });

const https = require('https');
const { ensureTls } = require('./lib/tls.js');
const SOURCE = path.join(h.ROOT, 'Storage', 'artifacts', 'mse.user.js');

/* two gateways of the test: the address the device already had, and the new one the owner moves to. The old one
   counts its hits, so "the old address is not used any more" is a measurement, not a promise. */
const hits = { old: 0, new: 0 };
function gateway(bucket, tls) {
  /* https on the loopback: the page is https, and WebKit refuses to call a plain http address from it */
  const server = https.createServer({ cert: fs.readFileSync(tls.cert), key: fs.readFileSync(tls.key) }, (req, res) => {
    if (bucket) hits[bucket]++;
    res.setHeader('content-type', 'application/json');
    res.setHeader('access-control-allow-origin', '*');
    res.end(JSON.stringify({ ok: true, name: 'MSE gateway', version: '2.3.0', model: 'mock-model', models: ['mock-model'], quota: 200 }));
  });
  const p = new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
  servers.push(server);
  return p;
}
let OLD = '';
let NEW = '';
async function gateways() {
  if (OLD && NEW) return { OLD, NEW };
  const tls = ensureTls();
  const a = await gateway('old', tls);
  const b = await gateway('new', tls);
  OLD = 'https://127.0.0.1:' + a.address().port;
  NEW = 'https://127.0.0.1:' + b.address().port;
  return { OLD, NEW };
}
test.after(() => { for (const s of servers) s.close(); });
const servers = [];

async function open(opts = {}) {
  const b = await browserOnce();
  const ctx = await b.newContext(Object.assign({}, pw.devices['iPhone 13'], { ignoreHTTPSErrors: true }));
  const t = await h.launch({
    browser: 'webkit',
    source: fs.readFileSync(SOURCE, 'utf8'),
    api: opts.api || ((req) => {
      if (/\/health$/.test(req.path)) return { status: 200, json: { ok: true, name: 'MSE gateway', version: '2.3.0', model: 'mock-model', models: ['mock-model'] } };
      return { status: 200, json: {} };
    }),
    state: { bindingName: '__stayBg' + Math.random().toString(36).slice(2, 6) },
    context: ctx,
    allowLocal: true,
    ignoreHTTPSErrors: true,
  });
  t.close = async () => { await ctx.close().catch(() => {}); };
  const page = await t.newPage(null);
  await page.goto(h.fixtureUrl('attempt'), { waitUntil: 'load' });
  await page.waitForTimeout(900);
  return { t, page };
}

/* what every store holds right now: the site localStorage, the Stay backend the extension itself writes through,
   and the mirror property of the older bridge */
async function everywhere(page) {
  return page.evaluate(() => {
    const out = { ls: {}, stay: {}, win: {} };
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (/url/i.test(k)) out.ls[k] = localStorage.getItem(k);
      }
    } catch (e) {}
    const store = window.__mseRuntime.pageStorage();
    return store.keys().then((keys) => {
      const mine = (keys || []).filter((k) => /url/i.test(k));
      return Promise.all(mine.map((k) => store.get(k)));
    }).then((vals) => {
      const store = window.__mseRuntime.pageStorage();
      return store.keys().then((keys) => {
        const mine = (keys || []).filter((k) => /url/i.test(k));
        return Promise.all(mine.map((k) => store.get(k))).then((vs) => {
          mine.forEach((k, i) => { out.stay[k] = vs[i]; });
          out.win['mse:local:gatewayUrl'] = window['mse:local:gatewayUrl'] === undefined ? null : window['mse:local:gatewayUrl'];
          return out;
        });
      });
    });
  });
}

test('B1 the new address replaces the old one in every store, and the old one is left nowhere', { timeout: 120000 }, async () => {
  await gateways();
  const { t, page } = await open();
  try {
    /* the state of a device that already knows an address: the old one is in both stores */
    await page.evaluate((old) => {
      localStorage.setItem('mse.gateway.url', old);
      localStorage.setItem('mse:local:gatewayUrl', old);
      const store = window.__mseRuntime.pageStorage();
      return Promise.all([
        store.set('mse:L:mse.gateway.url', old),
        store.set('mse:L:mse:local:gatewayUrl', old),
        store.set('mse:L:mse.gateway.url.legacy', 'https://before.example-tailnet.ts.net'),
      ]);
    }, OLD);
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(900);
    const before = await page.evaluate(() => window.MSEBridge.url());
    assert.equal(before, OLD, 'the old address is the one in use');

    /* the owner types the new one in the panel and presses check */
    await page.evaluate(() => {
      window.__mse.open();
      return new Promise((resolve) => setTimeout(resolve, 600));
    });
    await page.evaluate(() => window.__mse.route('gateway'));
    await page.waitForTimeout(400);
    const checked = await page.evaluate((url) => window.__mse.gateway(url), NEW);
    assert.ok(checked && checked.ok, 'the panel accepted the new address: ' + JSON.stringify(checked));
    await page.waitForTimeout(600);

    /* what is stored now */
    const after = await everywhere(page);
    assert.equal(await page.evaluate(() => window.MSEBridge.url()), NEW, 'the address in use is the new one');
    const oldPlaces = [];
    Object.keys(after.ls).forEach((k) => { if (after.ls[k] === OLD) oldPlaces.push('localStorage:' + k); });
    Object.keys(after.stay).forEach((k) => { if (after.stay[k] === OLD) oldPlaces.push('stay:' + k); });
    Object.keys(after.win).forEach((k) => { if (after.win[k] === OLD) oldPlaces.push('window:' + k); });
    assert.deepEqual(oldPlaces, [], 'the old address is left in no store at all: ' + JSON.stringify(after));
    assert.equal(after.ls['mse.gateway.url'], NEW, 'localStorage has the new address');
    assert.equal(after.stay['mse:L:mse.gateway.url'], NEW, 'the Stay storage has the new address');

    /* and after a reload there is still exactly one address */
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(900);
    const reloaded = await everywhere(page);
    const strays = Object.keys(reloaded.stay).concat(Object.keys(reloaded.ls))
      .filter((k) => (reloaded.stay[k] || reloaded.ls[k]) && (reloaded.stay[k] || reloaded.ls[k]) !== NEW)
      .map((k) => k + '=' + (reloaded.stay[k] || reloaded.ls[k]));
    assert.deepEqual(strays, [], 'no other address survives a reload: ' + JSON.stringify(strays));
    assert.equal(await page.evaluate(() => window.MSEBridge.url()), NEW, 'after the reload the address is the new one');

    /* the one call that matters goes to the new address, not to the old one */
    const askedBefore = { old: hits.old, new: hits.new };
    await page.evaluate(() => window.MSEBridge.probe());
    await page.waitForTimeout(900);
    assert.ok(hits.new > askedBefore.new, 'the gateway is asked at the new address');
    assert.equal(hits.old, askedBefore.old, 'the old address is not asked even once after the change');
    assert.deepEqual(t.errors, []);
  } finally {
    await t.close();
  }
});

test('B1 an address is not used before it is checked, and clearing it clears every store', { timeout: 120000 }, async () => {
  await gateways();
  const { t, page } = await open();
  try {
    await page.evaluate((url) => window.MSEBridge.setUrl(url), OLD);
    await page.waitForTimeout(200);
    /* a typed but unchecked address must not become the address in use */
    await page.evaluate(() => {
      window.__mse.open();
      return new Promise((r) => setTimeout(r, 600));
    });
    /* an address that answers but is not checked never becomes the saved one: the panel only writes after a probe */
    const bad = await page.evaluate(() => window.__mse.gateway('http://127.0.0.1:1'));
    assert.equal(bad.ok, false, 'an address that does not answer is not saved: ' + JSON.stringify(bad));
    assert.equal(await page.evaluate(() => window.MSEBridge.url()), OLD, 'an unchecked address does not replace the saved one');

    /* clearing the address clears all of it */
    await page.evaluate(() => window.MSEBridge.setUrl(''));
    await page.waitForTimeout(300);
    const empty = await everywhere(page);
    assert.equal(await page.evaluate(() => window.MSEBridge.url()), null, 'there is no address any more');
    const left = Object.keys(empty.ls).map((k) => empty.ls[k]).concat(Object.keys(empty.stay).map((k) => empty.stay[k]));
    assert.deepEqual(left.filter(Boolean), [], 'every store is empty: ' + JSON.stringify(empty));
    /* the failed probe above is the point of the test: the browser reports it, and nothing else should appear */
    assert.ok(t.errors.every((e) => /127\.0\.0\.1:1|access control/.test(String(e))), 'no other error: ' + JSON.stringify(t.errors.slice(0, 2)));
  } finally {
    await t.close();
  }
});
