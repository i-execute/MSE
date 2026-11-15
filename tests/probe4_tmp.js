const fs=require('fs');const h=require('./lib/harness.js');const pw=require('playwright');const https=require('https');
const {ensureTls}=require('./lib/tls.js');
(async()=>{
  const tls=ensureTls();
  const hits={old:0,new:0};
  const mk=(b)=>new Promise(r=>{const s=https.createServer({cert:fs.readFileSync(tls.cert),key:fs.readFileSync(tls.key)},(q,res)=>{hits[b]++;res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true,name:'MSE gateway'}));});s.listen(0,'127.0.0.1',()=>r(s));});
  const a=await mk('old'), b2=await mk('new');
  const OLD='https://127.0.0.1:'+a.address().port, NEW='https://127.0.0.1:'+b2.address().port;
  const b=await pw.webkit.launch(); const ctx=await b.newContext(Object.assign({},pw.devices['iPhone 13'],{ignoreHTTPSErrors:true}));
  const t=await h.launch({browser:'webkit',source:fs.readFileSync('Storage/artifacts/mse.user.js','utf8'),context:ctx,state:{},allowLocal:true});
  const page=await t.newPage(null); await page.goto(h.fixtureUrl('attempt'),{waitUntil:'load'}); await page.waitForTimeout(800);
  console.log(OLD, NEW, await page.evaluate((u)=>window.MSEBridge.probe(u), NEW), hits);
  await b.close(); a.close(); b2.close();
})();
