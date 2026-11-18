'use strict';
const test=require('node:test'), assert=require('node:assert/strict'), h=require('./lib/harness');
test('report works without debug; debug captures extension traffic without leaking device key', {timeout:60000},async()=>{
 const t=await h.launch({api:()=>({status:200,json:[]})});
 try {
  const page=await t.newPage(h.fixtureUrl('attempt')); await page.waitForFunction(()=>!!window.__mse&&!!window.MSEBridge);
  const messages=[];
  await page.route('**/mse/v1/dump',route=>{messages.push(JSON.parse(route.request().postData()));return route.fulfill({status:201,contentType:'application/json',body:'{"ok":true}'});});
  await page.route('**/health',route=>route.fulfill({status:200,contentType:'application/json',body:'{"ok":true,"name":"MSE gateway"}'}));
  await page.evaluate(()=>{document.cookie='fixture_cookie=hidden_cookie_value; path=/'; const input=document.createElement('input');input.type='hidden';input.value='hidden_form_value'; document.querySelector('.que').appendChild(input);document.querySelector('.que .qtext').append(' hidden_cookie_value hidden_form_value');window.MSEBridge.url=()=>location.origin;window.MSEBridge.setDebugEnabled(false);window.__mse.open();});
  await page.waitForFunction(()=>window.__mse.root().querySelector('[data-mse="report"]'));
  await page.evaluate(()=>window.__mse.root().querySelector('[data-mse="report"]').click());
  await page.waitForFunction(()=>window.__mse.root().querySelector('[data-mse="report"]').textContent==='sent');
  assert.equal(messages.length,1); assert.equal(messages[0].type,'report');
  await page.evaluate(()=>{window.__mse.route('gateway');});
  await page.waitForFunction(()=>window.__mse.root().querySelector('[data-mse="debug-mode"]'));
  await page.evaluate(()=>{const i=window.__mse.root().querySelector('[data-mse="debug-mode"]');i.checked=true;i.dispatchEvent(new Event('change',{bubbles:true}));});
  await page.evaluate(()=>window.MSEBridge.probe(location.origin));
  await page.waitForTimeout(600);
  assert.ok(messages.some(x=>x.type==='debug'));
  const deviceKey=await page.evaluate(()=>window.MSEBridge.key());
  assert.ok(!JSON.stringify(messages).includes(deviceKey));
  assert.ok(!JSON.stringify(messages).includes('hidden_cookie_value'));
  assert.ok(!JSON.stringify(messages).includes('hidden_form_value'));
  assert.ok(messages[0].dump.question.html.includes('qtext'));
 } finally {await t.close()}
});
