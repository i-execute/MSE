'use strict';
const test=require('node:test'), assert=require('node:assert/strict'), fs=require('fs'), os=require('os'), path=require('path'), http=require('http');
const data=fs.mkdtempSync(path.join(os.tmpdir(),'mse-stream-'));
Object.assign(process.env,{MSE_DATA_DIR:data,MSE_ADMIN_TOKEN:'adm_test',MSE_UPSTREAM_PORT:'1',MSE_MODEL:'mock'});
const router=require('../Server/mse-router'); const key='mse_'+ '6'.repeat(48); let base, upstream;
let reportedModel=null;
const event=(delta)=>'data: '+JSON.stringify({model:reportedModel,choices:[{delta}]})+'\n\n';
test.before(async()=>{
 upstream=http.createServer((req,res)=>{
  if(req.url==='/v1/models') {res.writeHead(200,{'content-type':'application/json'});return res.end('{"data":[{"id":"mock"}]}');}
  let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{
   const data=JSON.parse(raw); assert.equal(data.stream,true);
   res.writeHead(200,{'content-type':'text/event-stream'});
   res.write(event({reasoning_content:'thinking'}));
   setTimeout(()=>res.write(event({content:'{"answer":"Right'})),300);
   setTimeout(()=>res.end(event({content:' option"}'})+'data: [DONE]\n\n'),700);
  });
 }); await new Promise(r=>upstream.listen(0,'127.0.0.1',r));router.CFG.upstreamUrl='http://127.0.0.1:'+upstream.address().port;
 await new Promise(r=>router.server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+router.server.address().port;
});
test.after(()=>{router.server.close();upstream.close()});
const post=(p,b,h={})=>fetch(base+p,{method:'POST',headers:{'content-type':'application/json',...h},body:JSON.stringify(b)});
test('agent emits stages as backend streams, then exact parsed answer',async()=>{
 const dev=await(await post('/mse/v1/register',{key,moodleId:'77'})).json();await post('/admin/approve',{deviceId:dev.device.deviceId},{'x-admin-token':'adm_test'});
 const started=Date.now(); const response=await post('/mse/v1/agent',{question:'which?',options:['Right option']},{authorization:'Bearer '+key,accept:'text/event-stream'});
 assert.match(response.headers.get('content-type'),/event-stream/);const reader=response.body.getReader(), decoder=new TextDecoder();let raw='';
 while(!raw.includes('writing answer')) {const part=await reader.read();assert.equal(part.done,false);raw+=decoder.decode(part.value);}
 const writingAt=Date.now()-started; assert.ok(writingAt<650,'writing event precedes stream completion');
 for(;;){const p=await reader.read();if(p.done)break;raw+=decoder.decode(p.value)}
 assert.match(raw,/reasoning/);assert.match(raw,/writing answer/);assert.match(raw,/"answer":"Right option"/);assert.ok(Date.now()-started>=650);
});
test('image stage appears before reasoning and streamed writing',async()=>{
 const response=await post('/mse/v1/agent',{question:'image?',options:['Right option'],image:[{data:'data:image/png;base64,aGVsbG8=',label:'question'}]},{authorization:'Bearer '+key,accept:'text/event-stream'});
 assert.equal(response.status,200);
 const raw=await response.text();
 const looking=raw.indexOf('looking at image'), reasoning=raw.indexOf('reasoning',looking), writing=raw.indexOf('writing answer',reasoning);
 assert.ok(looking>=0 && reasoning>looking && writing>reasoning,raw);
 assert.match(raw,/"answer":"Right option"/);
});

test('in-flight agent reports the model that answered, not a later owner selection',async()=>{
 router.CFG.model='before-change';
 const response=await post('/mse/v1/agent',{question:'which?',options:['Right option']},{authorization:'Bearer '+key,accept:'text/event-stream'});
 const reader=response.body.getReader(), decoder=new TextDecoder();let raw='';
 try {
  while(!raw.includes('writing answer')){const part=await reader.read();assert.equal(part.done,false);raw+=decoder.decode(part.value);}
  router.CFG.model='after-change';
  for(;;){const part=await reader.read();if(part.done)break;raw+=decoder.decode(part.value)}
  assert.match(raw,/"model":"before-change"/);assert.doesNotMatch(raw,/"model":"after-change"/);
 } finally {router.CFG.model='mock';}
});

test('agent preserves a model identifier actually reported by the streaming backend',async()=>{
 reportedModel='reported-by-backend';
 try {
  const response=await post('/mse/v1/agent',{question:'which?',options:['Right option']},{authorization:'Bearer '+key,accept:'text/event-stream'});
  assert.match(await response.text(),/"model":"reported-by-backend"/);
 } finally {reportedModel=null;}
});
