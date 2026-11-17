'use strict';
const test=require('node:test'), assert=require('node:assert/strict'), h=require('./lib/harness');
test('WebKit parses stage events and updates one live status row', {timeout:60000},async()=>{
 const t=await h.launch({api:()=>({status:200,json:[]})});
 try {
  const page=await t.newPage(h.fixtureUrl('attempt'));await page.waitForFunction(()=>!!window.__mse&&!!window.MSEBridge);
  await page.route('**/mse/v1/agent', route=>route.fulfill({status:200,contentType:'text/event-stream',body:'event: stage\ndata: {"stage":"reasoning"}\n\nevent: stage\ndata: {"stage":"writing answer"}\n\nevent: result\ndata: {"ok":true,"answer":"A"}\n\n'}));
  const got=await page.evaluate(async()=>{window.MSEBridge.url=()=>location.origin;const stages=[];const out=await window.MSEBridge.agent({question:'fixture',options:['A']},s=>stages.push(s));return {stages,out};});
  assert.deepEqual(got.stages,['reasoning','writing answer']);assert.equal(got.out.answer,'A');
  await page.evaluate(()=>{window.__mse.open();window.MSEBridge.agent=(_,stage)=>new Promise(resolve=>{stage('reasoning');setTimeout(()=>stage('writing answer'),200);setTimeout(()=>resolve({ok:true,answer:'A'}),1000)});window.__mse.runAgent();});
  await page.waitForFunction(()=>window.__mse.agent()&&window.__mse.agent().stage==='writing answer');
  assert.equal(await page.evaluate(()=>window.__mse.agent().stage),'writing answer');
 } finally {await t.close()}
});
