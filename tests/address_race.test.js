'use strict';
const test=require('node:test'), assert=require('node:assert/strict'), h=require('./lib/harness');
test('changing gateway cannot delete its new Stay address during a slow queued write', {timeout:30000},async()=>{
 const t=await h.launch({api:()=>({status:200,json:[]})});
 try {
  const page=await t.newPage(h.fixtureUrl('attempt'));await page.waitForFunction(()=>!!window.MSEBridge&&!!window.__mseRuntime);
  const got=await page.evaluate(async()=>{
   const saved=window.__mseRuntime.pageStorage, data=new Map();
   window.__mseRuntime.pageStorage=()=>({
     keys:()=>Promise.resolve([...data.keys()]),get:k=>Promise.resolve(data.get(k)),
     set:(k,v)=>new Promise(r=>setTimeout(()=>{data.set(k,v);r()},180)),
     del:k=>{data.delete(k);return Promise.resolve()}
   });
   window.MSEBridge.setUrl('https://example.org');await new Promise(r=>setTimeout(r,650));
   window.MSEBridge.url();window.MSEBridge.setUrl('https://example.net');
   await new Promise(r=>setTimeout(r,1000));
   const out={primary:data.get('mse:L:mse.gateway.url')||null,local:window.MSEBridge.url()};
   window.__mseRuntime.pageStorage=saved;return out;
  });
  assert.deepEqual(got,{primary:'https://example.net',local:'https://example.net'});
 }finally{await t.close()}
});
