'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('fs');
const h = require('./lib/harness');
const source = fs.readFileSync(h.USERJS,'utf8');
function body(name, next) {
  const start=name+':function(){\n', end='\n},\n'+next+':function(){\n';
  const a=source.indexOf(start), b=source.indexOf(end,a+start.length);
  assert.ok(a>=0 && b>a, 'bundle boundaries: '+name);
  return source.slice(a+start.length,b);
}
test('artifact strips both parallel warnings, all four locales, update message and disables vendor modal/toast', () => {
  for (const name of ['PARALLEL_ATTEMPTS_WARNING','parallelAttemptsTitle','parallelAttemptsContent','updateAvailableTitle','updateAvailableContent']) assert.equal(source.includes(name),false,name);
  const commons=body('commons','background'), board=body('quiz_board','popup'), background=body('background','quiz_attempt');
  assert.ok(commons.includes('show(){return this}toggle(){this._visible?this.hide():this.show()}'));
  assert.ok(board.includes('static async show(e){return null}'));
  assert.match(background,/async getUpdateMessage\(\)\{return null\}/);
  const report=JSON.parse(fs.readFileSync(require('path').join(h.ROOT,'Storage/artifacts/build-report.json')));
  const crypto=require('crypto');
  for(const [name,next] of [['commons','background'],['background','quiz_attempt'],['quiz_attempt','quiz_overview'],['quiz_overview','quiz_board'],['quiz_board','popup']]) {
    const bundle=body(name,next);
    assert.equal(report.bundles[name].sha256,crypto.createHash('sha256').update(bundle).digest('hex'));
    assert.equal(report.bundles[name].bytes,Buffer.byteLength(bundle));
  }
});
test('two Stay tabs and both actual invalidation continuations remain silent', {timeout:60000}, async()=>{
  const attempt=body('quiz_attempt','quiz_overview'), overview=body('quiz_overview','quiz_board');
  const a=attempt.match(/await o\.invalidate\(\)&&j\.info\("Attempt context invalidated"\)/g);
  const b=overview.match(/await a\.invalidate\(\)&&D\.info\("Attempt context invalidated"\)/g);
  assert.equal(a && a.length,1); assert.equal(b && b.length,1);
  const t=await h.launch({openShadow:true,api:()=>({status:200,json:[]})});
  try {
    await t.context.addInitScript(()=>{window.__dialogs=[];window.alert=x=>window.__dialogs.push(x);window.confirm=x=>{window.__dialogs.push(x);return false;};});
    const pages=[await t.newPage(h.fixtureUrl('attempt')),await t.newPage(h.fixtureUrl('attempt'))];
    for(const page of pages) {
      await page.waitForFunction(()=>!!window.__mse&&!!window.__mseRuntime);
      const got=await page.evaluate(async({attempt,overview})=>{
        let calls=0, logs=0, shows=0;
        const before=document.querySelectorAll('.modal,[role="dialog"],.toast').length;
        const invalidator={invalidate:async()=>{calls++;return true}};
        const logger={info:()=>{logs++}};
        const dangerous={default:class{show(){shows++;document.body.insertAdjacentHTML('beforeend','<div class="modal">BAD</div>')}}};
        const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
        await new AsyncFunction('o','j','x','S',attempt)(invalidator,logger,dangerous,{});
        await new AsyncFunction('a','D','b','w',overview)(invalidator,logger,dangerous,{});
        window.__mse.open();
        return {calls,logs,shows,dialogs:window.__dialogs,modal:document.querySelectorAll('.modal,[role="dialog"],.toast').length-before,widgets:window.__mseRuntime._internals.contentScriptsFor(location)};
      },{attempt:a[0],overview:b[0]});
      assert.deepEqual(got,{calls:2,logs:2,shows:0,dialogs:[],modal:0,widgets:null});
    }
  } finally { await t.close(); }
});

test('forced real vendor entrypoints in two tabs handle mocked invalidation without a modal', {timeout:60000},async()=>{
 // The shipped runtime does not load vendor content UI. For defense-in-depth, temporarily enable
 // the real bundled attempt/overview entrypoints in this test and force invalidate() to return true.
 let forced=source.replace('function contentScriptsFor(loc) { return null; }',
   "function contentScriptsFor(loc) { if(loc.pathname.includes('attempt.php')) return {js:['commons','quiz_attempt'],css:[]}; if(loc.pathname.includes('summary.php')) return {js:['commons','quiz_overview'],css:[]}; return null; }");
 assert.notEqual(forced,source);
 for(const symbol of ['o','a']) {
  const original='await '+symbol+'.invalidate()&&'; assert.equal(forced.split(original).length-1,1);
  forced=forced.replace(original,'await (document.__mseInvalidations=(document.__mseInvalidations||0)+1,Promise.resolve(true))&&');
 }
 const t=await h.launch({source:forced,openShadow:true,api:()=>({status:200,json:[]})});
 try {
  await t.context.addInitScript(()=>{window.__dialogs=[];window.alert=x=>window.__dialogs.push(x);window.confirm=x=>{window.__dialogs.push(x);return false;};});
  const pages=await Promise.all([t.newPage(h.fixtureUrl('attempt')),t.newPage(h.fixtureUrl('attempt')),t.newPage(h.fixtureUrl('summary'))]);
  for(const page of pages) {
   await page.waitForFunction(()=>document.__mseInvalidations===1,{timeout:15000});
   await page.waitForTimeout(300);
   const out=await page.evaluate(()=>({count:document.__mseInvalidations,dialogs:window.__dialogs,
     modal:document.querySelectorAll('.modal.show,.modal-backdrop').length+(window.__roots||[]).reduce((n,e)=>n+(e.shadowRoot?e.shadowRoot.querySelectorAll('.modal.show,.modal-backdrop').length:0),0)}));
   assert.deepEqual(out,{count:1,dialogs:[],modal:0});
  }
  assert.deepEqual(t.errors,[]);
 } finally { await t.close(); }
});

test('update service answers null even when update is required; vendor show methods are inert',async()=>{
 const bg=body('background','quiz_attempt');
 const start='4993:function(e,t,a){', end='},5107:(e,t,a)=>';
 const a=bg.indexOf(start),b=bg.indexOf(end,a+start.length);assert.ok(a>=0&&b>a);
 const exports={};
 new Function('e','t','a',bg.slice(a+start.length,b))({},exports,()=>({Topics:{GetUpdateMessage:'update'}}));
 let bound;const service=new exports.default({checkUpdate:async()=>({updateRequired:true})});
 await service.init({bind:(topic,handler)=>{assert.equal(topic,'update');bound=handler;}});
 assert.equal(await bound(),null);
 const commons=body('commons','background');
 const show=commons.match(/show\(\)\{return this\}(?=toggle\(\)\{this\._visible)/);assert.ok(show);
 const modal=new Function('return ({'+show[0]+'})')();
 assert.equal(modal.show(),modal);
 const board=body('quiz_board','popup');const toast=board.match(/static async show\(e\)\{return null\}/);assert.ok(toast);
 const klass=new Function('return class {'+toast[0]+'}')();assert.equal(await klass.show({}),null);
});
