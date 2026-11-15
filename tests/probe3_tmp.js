const fs=require('fs');const h=require('./lib/harness.js');const pw=require('playwright');const http=require('http');
(async()=>{
  const srv=http.createServer((q,s)=>{s.setHeader('content-type','application/json');s.setHeader('access-control-allow-origin','*');s.end('{"ok":true,"name":"MSE gateway"}');});
  await new Promise(r=>srv.listen(0,'127.0.0.1',r));
  const port=srv.address().port;
  const b=await pw.webkit.launch(); const ctx=await b.newContext(pw.devices['iPhone 13']);
  const t=await h.launch({browser:'webkit',source:fs.readFileSync('/home/user/work/MSE/Storage/artifacts/mse.user.js','utf8'),context:ctx,state:{},allowLocal:true});
  const page=await t.newPage(null); await page.goto(h.fixtureUrl('attempt'),{waitUntil:'load'}); await page.waitForTimeout(800);
  console.log(await page.evaluate((p)=>fetch('http://127.0.0.1:'+p+'/health').then(r=>r.status, e=>'ERR '+e.message), port));
  console.log(await page.evaluate((p)=>window.MSEBridge.probe('http://127.0.0.1:'+p), port));
  console.log('apiLog', JSON.stringify(t.apiLog.slice(-3)));console.log('logs', t.logs.slice(-5));
  await b.close(); srv.close();
})();
