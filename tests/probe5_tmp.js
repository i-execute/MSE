const fs=require('fs');const h=require('./lib/harness.js');const pw=require('playwright');
(async()=>{
  const b=await pw.webkit.launch(); const ctx=await b.newContext(pw.devices['iPhone 13']);
  const t=await h.launch({browser:'webkit',source:fs.readFileSync('Storage/artifacts/mse.user.js','utf8'),context:ctx,state:{},openShadow:true});
  const page=await t.newPage(null); await page.goto(h.fixtureUrl('attempt'),{waitUntil:'load'}); await page.waitForTimeout(900);
  await page.evaluate(()=>window.__mse.open()); await page.waitForTimeout(900);
  console.log(await page.evaluate(()=>({roots:(window.__roots||[]).length, hosts:(window.__roots||[]).map(h=>h.tagName+'|'+h.getAttribute('style')), has: (window.__roots||[]).map(h=>!!h.shadowRoot), mse:(window.__roots||[]).map(h=>h.shadowRoot?!!h.shadowRoot.querySelector('.mse'):null)})));
  await b.close();
})();
