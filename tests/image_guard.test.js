'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const h = require('./lib/harness.js');
test('Stay: image payload is passed; inaccessible images fail honestly before AI request', {timeout:60000},async()=>{
 const t=await h.launch({api:()=>({status:200,json:[]})});
 try {
  const page=await t.newPage(h.fixtureUrl('attempt')); await page.waitForFunction(()=>!!window.__mse);
  await page.evaluate(()=>{
   const img=document.createElement('img');img.id='fixture-image';img.src='data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
   document.querySelector('.que .qtext').appendChild(img);
   window.MSEBridge.url=()=>location.origin;window.MSEBridge.agent=async payload=>{window.__capture=payload;return {ok:true,answer:'A hashtag'};};window.__mse.open();
  });
  await page.waitForFunction(()=>!!window.__mse.state().question); await page.evaluate(()=>window.__mse.runAgent());
  await page.waitForFunction(()=>!!window.__capture);const payload=await page.evaluate(()=>window.__capture);
  assert.match(payload.image[0].data,/^data:image\/gif;base64,/); assert.equal(payload.image[0].label,'question image 1');
  await page.evaluate(()=>{window.__capture=null;document.querySelector('#fixture-image').src='https://other.example.edu/image.png';window.__mse.runAgent();});
  await page.waitForFunction(()=>window.__mse.agent()&&window.__mse.agent().state==='error');
  assert.match((await page.evaluate(()=>window.__mse.agent())).text,/image unsupported/i);assert.equal(await page.evaluate(()=>window.__capture),null);
 } finally {await t.close();}
});
