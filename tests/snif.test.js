'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const h = require('./lib/harness.js');

test('Snif copies a local diagnostic snapshot in Stay without sending it', { timeout: 60000 }, async () => {
  const t = await h.launch({api: req => ({status: 200, json: req.path.includes('/solution') ? [{answer:'fixture'}] : {}})});
  try {
    const page = await t.newPage(h.fixtureUrl('attempt'));
    await page.waitForFunction(() => !!window.__mse && !!window.MSEBridge);
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {writeText: text => { window.__clipboard = text; return Promise.resolve(); }} });
      document.cookie = 'snif_fixture=do_not_copy_cookie_value; path=/';
      const q = document.querySelector('.que');
      const img = document.createElement('img');
      img.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
      img.alt = 'diagram'; img.setAttribute('srcset', img.src + ' 1x');
      q.querySelector('.qtext').appendChild(img);
      const d = document.createElement('div'); d.style.backgroundImage = 'url("data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==")';
      q.appendChild(d);
      const controls = document.createElement('div');
      controls.innerHTML = '<input type="checkbox" name="fixture_choice" value="v1" checked><label for="fixture-choice">Choice</label><select name="fixture_select"><option value="x" selected>Chosen</option><option value="y">Other</option></select>';
      q.appendChild(controls);
      const script = document.createElement('script'); script.textContent = 'var YUI_config = {fixture:true};'; document.head.appendChild(script);
      window.MSEBridge.url = () => location.origin;
      window.__mse.open();
    });
    await page.waitForFunction(() => !!window.__mse.state().question && window.__mse.state().rows !== null);
    await page.route('**/mse/v1/agent', route => route.fulfill({status:503, contentType:'application/json', body:JSON.stringify({ok:false, code:'model_unavailable', message:'unavailable'})}));
    const agent = await page.evaluate(() => window.MSEBridge.agent({question:'fixture', type:'multichoice', options:['A','B'], multiple:true}));
    assert.equal(agent.code, 'model_unavailable');
    await page.waitForTimeout(200);
    const requests = [];
    page.on('request', req => { if (['fetch', 'xhr', 'document'].includes(req.resourceType())) requests.push(req.url()); });
    let pos = await page.evaluate(() => window.__mse.state().pop.controls.snif);
    assert.ok(pos, 'Snif button is visible');
    await page.waitForTimeout(700);
    const size = await page.evaluate(() => {
      const rect = window.__mse.root().querySelector('[data-mse="snif"]').getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    });
    assert.ok(size.width >= 100 && size.height >= 43, 'Snif is a compact touch target: ' + JSON.stringify(size));
    const entryDir = path.join(process.env.MSE_EVIDENCE_DIR || require('os').tmpdir(), 'mse-snif');
    fs.mkdirSync(entryDir, { recursive: true });
    await page.screenshot({ path: path.join(entryDir, 'snif-entry.png') });
    await page.touchscreen.tap(pos.x, pos.y);
    await page.waitForFunction(() => window.__mse.route() === 'snif');
    await page.waitForTimeout(350);
    pos = await page.evaluate(() => window.__mse.state().pop.controls['snif-copy']);
    assert.ok(pos, 'Copy button is visible');
    const evidenceDir = path.join(process.env.MSE_EVIDENCE_DIR || require('os').tmpdir(), 'mse-snif');
    fs.mkdirSync(evidenceDir, { recursive: true });
    await page.screenshot({ path: path.join(evidenceDir, 'snif.png') });
    await page.touchscreen.tap(pos.x, pos.y);
    await page.waitForFunction(() => !!window.__clipboard);
    const data = await page.evaluate(() => ({text: window.__clipboard, key: window.MSEBridge.key()}));
    const dump = JSON.parse(data.text);
    assert.equal(dump.schema, 'mse-snif-1');
    assert.match(dump.question.html, /qtext/);
    assert.ok(dump.question.images.some(x => x.alt === 'diagram' && x.srcset));
    assert.ok(dump.question.backgrounds.length);
    assert.ok(dump.question.inputs.some(x => x.name === 'fixture_choice' && x.checked && x.value === 'v1'));
    assert.ok(dump.question.inputs.some(x => x.tag === 'LABEL' && x.for === 'fixture-choice'));
    assert.ok(dump.question.inputs.some(x => x.name === 'fixture_select' && x.options[0].selected));
    assert.ok(dump.page.inlineMoodleScripts.some(x => x.includes('YUI_config')));
    assert.ok(dump.page.cookieNamesVisibleToJavaScript.includes('snif_fixture'));
    assert.ok(!data.text.includes('do_not_copy_cookie_value'));
    assert.ok(!data.text.includes(data.key), 'device credential must not appear');
    assert.ok(dump.requests.syncshare.request.url.includes('questionIdentity='));
    assert.equal(dump.requests.syncshare.request.params.questionIdentity, String(dump.question.identity));
    assert.equal(dump.requests.syncshare.response.status, 200);
    assert.deepEqual(dump.requests.syncshare.response.json, [{answer:'fixture'}]);
    assert.equal(dump.page.httpHeaders, 'unavailable to page JavaScript');
    assert.equal(dump.requests.agent.request.json.multiple, true);
    assert.equal(dump.requests.agent.response.status, 503);
    assert.ok(dump.question.identityCalculation.includes('charCodeAt'));
    assert.deepEqual(requests, [], 'Snif and Copy did not send a request');
    await page.unroute('**/mse/v1/agent');
    await page.route('**/mse/v1/agent', route => route.fulfill({status:503, contentType:'text/plain', body:'capacity unavailable'}));
    const plain = await page.evaluate(() => window.MSEBridge.agent({question:'fixture', options:['A']}));
    assert.equal(plain.code, 'model_unavailable');
    assert.match(plain.message, /try another model/);
    const saved = await page.evaluate(() => window.MSEBridge.snifAgent());
    assert.equal(saved.response.status, 503);
    assert.equal(saved.response.body, 'capacity unavailable');
  } finally { await t.close(); }
});

test('Snif Copy writes a complete JSON to the real WebKit clipboard', { timeout: 60000 }, async () => {
  const t = await h.launch({api: () => ({status: 200, json: []})});
  try {
    const page = await t.newPage(h.fixtureUrl('attempt'));
    await page.waitForFunction(() => !!window.__mse);
    await page.evaluate(() => window.__mse.open());
    await page.waitForFunction(() => !!window.__mse.state().pop.controls.snif);
    let pos = await page.evaluate(() => window.__mse.state().pop.controls.snif);
    await page.touchscreen.tap(pos.x, pos.y);
    await page.waitForFunction(() => window.__mse.route() === 'snif');
    await page.waitForTimeout(400);
    pos = await page.evaluate(() => window.__mse.state().pop.controls['snif-copy']);
    await page.touchscreen.tap(pos.x, pos.y);
    await page.waitForFunction(() => window.__mse.root().textContent.includes('copied'));
    await page.evaluate(() => {
      const el = document.createElement('textarea'); el.id = 'mse-clipboard-test';
      el.style.cssText = 'position:fixed;top:0;left:0;z-index:2147483647;width:200px;height:100px';
      document.body.appendChild(el);
    });
    await page.locator('#mse-clipboard-test').click();
    await page.keyboard.press('Control+V');
    const text = await page.locator('#mse-clipboard-test').inputValue();
    const dump = JSON.parse(text);
    assert.equal(dump.schema, 'mse-snif-1');
    assert.match(dump.question.html, /qtext/);
    assert.ok(dump.question.inputs.length > 0);
  } finally { await t.close(); }
});
