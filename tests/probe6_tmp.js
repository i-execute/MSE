const fs=require('fs');const h=require('./lib/harness.js');const pw=require('playwright');
(async()=>{
  const b=await pw.webkit.launch(); const ctx=await b.newContext(pw.devices['iPhone 13']);
  const t=await h.launch({browser:'webkit',source:fs.readFileSync('Storage/artifacts/mse.user.js','utf8'),context:ctx,state:{}});
  const page=await t.newPage(null); await page.goto(h.fixtureUrl('attempt'),{waitUntil:'load'}); await page.waitForTimeout(900);
  await page.evaluate(()=>window.__mse.open()); await page.waitForTimeout(900);
  console.log(await page.evaluate(()=>{const r=window.__mse.root();return r?{tag:r.tagName||'#shadow', hasQ:!!r.querySelector, child:(r.querySelector&&r.querySelector('.mse')? 'wrap':'nowrap')}:'null';}));
  await b.close();
})();
