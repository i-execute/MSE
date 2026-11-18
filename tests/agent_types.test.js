'use strict';
const test=require('node:test'), assert=require('node:assert/strict'), fs=require('fs'),os=require('os'),path=require('path'),http=require('http');
const data=fs.mkdtempSync(path.join(os.tmpdir(),'mse-types-')); Object.assign(process.env,{MSE_DATA_DIR:data,MSE_ADMIN_TOKEN:'adm_test',MSE_UPSTREAM_PORT:'1',MSE_MODEL:'mock'});
const router=require('../Server/mse-router'); let upstream,base,lastPayload;
const key='mse_'+ '8'.repeat(48);
test.before(async()=>{
 upstream=http.createServer((req,res)=>{
  if(req.url==='/v1/models')return res.end('{"data":[{"id":"mock"}]}');let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{lastPayload=JSON.parse(raw);let content=lastPayload.messages[1].content;let text=Array.isArray(content)?((content.find(c=>c.type==='text')||{}).text||''):String(content||'');let answer=text.includes('dropdown')?'Alpha | Beta':text.includes('all that apply')?'Alpha | Beta':'Alpha';res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({answer})}}]}));});
 }); await new Promise(r=>upstream.listen(0,'127.0.0.1',r));router.CFG.upstreamUrl='http://127.0.0.1:'+upstream.address().port; await new Promise(r=>router.server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+router.server.address().port;
 const d=await(await post('/mse/v1/register',{key,moodleId:'9'})).json();await post('/admin/approve',{deviceId:d.device.deviceId},{'x-admin-token':'adm_test'});
});
test.after(()=>{router.server.close();upstream.close()});
const post=(url,b,h={})=>fetch(base+url,{method:'POST',headers:{'content-type':'application/json',...h},body:JSON.stringify(b)});
const ask=async(body)=>{const r=await post('/mse/v1/agent',body,{authorization:'Bearer '+key});return {status:r.status,body:await r.json()}};
test('multi and dropdown answers are validated against every option',async()=>{
 const multi=await ask({question:'q',options:['Alpha','Beta','Gamma'],multiple:true});assert.equal(multi.body.answer,'Alpha | Beta');
 const selects=await ask({question:'q',selects:[['Alpha','Gamma'],['Beta','Gamma']]});assert.equal(selects.body.answer,'Alpha | Beta');
 const invalid=await ask({question:'q',selects:[['Gamma'],['Beta']]});assert.equal(invalid.body.ok,false);assert.match(invalid.body.message,/not in/);
});
test('images travel as data only to the backend; a remote URL is rejected',async()=>{
 const image='data:image/png;base64,aGVsbG8=';const r=await ask({question:'image?',options:['Alpha'],image:[{data:image,label:'question'}]});assert.equal(r.body.ok,true);
 const imgObj = lastPayload.messages[1].content.find(c => c.type === 'image_url');
 assert.equal(imgObj.image_url.url,image);
 const invalid=await ask({question:'image?',image:[{data:'https://other.example.edu/secret'}]});assert.equal(invalid.status,400);
});
