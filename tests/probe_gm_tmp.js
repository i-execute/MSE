const fs=require('fs'),path=require('path');
const h=require('./lib/harness.js');
const pw=require('playwright');
(async()=>{
  const b=await pw.webkit.launch(); const ctx=await b.newContext(pw.devices['iPhone 13']);
  const t=await h.launch({browser:'webkit',source:fs.readFileSync('/home/user/work/MSE/Storage/artifacts/mse.user.js','utf8'),context:ctx,state:{}});
  const page=await t.newPage(null); await page.goto(h.fixtureUrl('attempt'),{waitUntil:'load'}); await page.waitForTimeout(900);
  console.log(await page.evaluate(()=>({gm:typeof GM_getValue, gmSet:typeof GM_setValue, bridge:typeof window.MSEBridge, places: window.MSEBridge? window.MSEBridge.places():null})));
  await b.close();
})();
