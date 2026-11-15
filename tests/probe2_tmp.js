const fs=require('fs'),path=require('path');
const h=require('./lib/harness.js');
const pw=require('playwright');
(async()=>{
  const b=await pw.webkit.launch(); const ctx=await b.newContext(pw.devices['iPhone 13']);
  const t=await h.launch({browser:'webkit',source:fs.readFileSync('/home/user/work/MSE/Storage/artifacts/mse.user.js','utf8'),context:ctx,state:{}});
  const page=await t.newPage(null); await page.goto(h.fixtureUrl('attempt'),{waitUntil:'load'}); await page.waitForTimeout(900);
  await page.evaluate(()=>{window.__mse.open();});
  await page.waitForTimeout(700);
  
  const r=await page.evaluate(()=>window.__mse.route('gateway'));
  await page.waitForTimeout(400);
  console.log(JSON.stringify(await page.evaluate(()=>({route:window.__mse.state().route, host: [...document.querySelectorAll('div')].filter(d=>/mse/.test(d.className||d.id||'')).map(d=>d.className+'#'+d.id).slice(-8)})),null,1));
  await b.close();
})();
