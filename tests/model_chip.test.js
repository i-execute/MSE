'use strict';
const test=require('node:test'), assert=require('node:assert/strict'), fs=require('fs'), path=require('path'), h=require('./lib/harness');
test('Stay header model follows health and agent response, glows, and is absent from answer rows', {timeout:60000},async()=>{
 const t=await h.launch({api:()=>({status:200,json:[]})});
 try {
  let model='initial-model', healthRequests=[];
  const page=await t.newPage(h.fixtureUrl('attempt'));await page.waitForFunction(()=>!!window.__mse&&!!window.MSEBridge);
  await page.route('**/health',route=>{healthRequests.push(model);return route.fulfill({status:200,contentType:'application/json',headers:{'cache-control':'no-store'},body:JSON.stringify({ok:true,name:'MSE gateway',model,models:[model]})});});
  await page.route('**/v1/models',route=>route.fulfill({status:200,contentType:'application/json',body:'{"data":[]}'}));
  await page.route('**/mse/v1/me',route=>route.fulfill({status:200,contentType:'application/json',body:'{"ok":true,"device":{"status":"pending"}}'}));
  await page.route('**/mse/v1/agent',route=>route.fulfill({status:200,contentType:'text/event-stream',body:'event: stage\ndata: {"stage":"writing answer"}\n\nevent: result\ndata: {"ok":true,"answer":"A hashtag","model":"answer-model"}\n\n'}));
  await page.evaluate(()=>{window.MSEBridge.setUrl(location.origin);window.MSEBridge.saveMeta({device:{deviceId:'fixture',moodleId:'1',status:'pending'}},{});window.__mse.open();});
  await page.waitForFunction(()=>window.__mse.root().querySelector('.pop:not(.out) [data-mse="model-chip"]')?.textContent==='initial-model');
  const style=await page.evaluate(()=>{const e=window.__mse.root().querySelector('.ph [data-mse="model-chip"]');const s=getComputedStyle(e);return {shadow:s.textShadow,box:s.boxShadow,color:s.color,header:!!e.closest('.ph'),title:e.title};});
  assert.equal(style.header,true);assert.equal(style.title,'initial-model');assert.notEqual(style.shadow,'none');assert.notEqual(style.box,'none');assert.match(style.shadow,/rgba?\(255, ?255, ?255/);
  model='changed-model';
  const checked=await page.evaluate(()=>window.__mse.gateway(location.origin));
  assert.equal(checked.ok,true,JSON.stringify(checked));
  const current=await page.evaluate(()=>window.__mse.root().querySelector('.pop:not(.out) [data-mse="model-chip"]')?.textContent);
  assert.equal(current,'changed-model','health calls: '+JSON.stringify(healthRequests));
  await page.evaluate(()=>window.__mse.runAgent());
  await page.waitForFunction(()=>window.__mse.root().querySelector('.pop:not(.out) [data-mse="model-chip"]')?.textContent==='answer-model');
  const labels=await page.evaluate(()=>Array.from(window.__mse.root().querySelectorAll('.ans')).map(e=>e.textContent));
  assert.ok(labels.some(s=>s.includes('A hashtag'))); assert.ok(labels.every(s=>!s.includes('model')));
  // A slow earlier health response must not overwrite a newer agent result.
  await page.evaluate(()=>{window.MSEBridge.probe=()=>new Promise(resolve=>setTimeout(()=>resolve({ok:true,model:'stale-model'}),600));window.__mse.open();window.__mse.runAgent();});
  await page.waitForFunction(()=>window.__mse.agent()?.state==='ok');await page.waitForTimeout(800);
  assert.equal(await page.evaluate(()=>window.__mse.root().querySelector('.pop:not(.out) [data-mse="model-chip"]')?.textContent),'answer-model');
  // If health no longer provides a model, do not show a stale selection as current.
  await page.evaluate(()=>{window.MSEBridge.probe=()=>Promise.resolve({ok:true,model:null});window.__mse.open();});
  await page.waitForFunction(()=>!window.__mse.root().querySelector('.pop:not(.out) [data-mse="model-chip"]'));
  await page.evaluate(()=>{window.MSEBridge.probe=()=>Promise.resolve({ok:true,model:'answer-model'});window.__mse.open();});
  await page.waitForFunction(()=>!!window.__mse.root().querySelector('.pop:not(.out) [data-mse="model-chip"]'));
  if(process.env.MSE_EVIDENCE_DIR){await page.waitForTimeout(500);fs.mkdirSync(process.env.MSE_EVIDENCE_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.MSE_EVIDENCE_DIR,'model-chip.png')});}
 } finally {await t.close()}
});
