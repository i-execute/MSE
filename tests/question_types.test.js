'use strict';
const test=require('node:test'), assert=require('node:assert/strict'), h=require('./lib/harness');
test('WebKit applies radio, checkboxes, grouped selects and text safely', {timeout:90000}, async()=>{
 const t=await h.launch({api:()=>({status:200,json:[]})});
 async function run(type,inner,answer,verify) {
  const page=await t.newPage(h.fixtureUrl('attempt')); await page.waitForFunction(()=>!!window.__mse);
  await page.evaluate(({type,inner})=>{const q=document.querySelector('.que');q.className='que '+type;q.querySelector('.answer').innerHTML=inner;window.__mse.open();},{type,inner});
  await page.waitForFunction(()=>!!window.__mse.state().question); const applied=await page.evaluate(a=>window.__mse.apply(a),answer);
  assert.equal(applied.ok,true,type); const state=await page.evaluate(()=>[...document.querySelector('.que .answer').querySelectorAll('input, select')].map(e=>e.type==='radio'||e.type==='checkbox'?e.checked:e.value));
  assert.deepEqual(state,verify); await page.close();
 }
 try {
  await run('multichoice','<label><input type="radio" name="q9:1_answer" value="a">Alpha</label><label><input type="radio" name="q9:1_answer" value="b">Beta</label>','Beta',[false,true]);
  await run('multichoiceset','<label><input type="checkbox" name="q9:1_answer0" value="1">Alpha</label><label><input type="checkbox" name="q9:1_answer1" value="1">Beta</label>','Alpha | Beta',[true,true]);
  await run('gapselect','<select name="q9:1_first"><option value="">Choose</option><option value="a">Alpha</option><option value="b">Beta</option></select><select name="q9:1_second"><option value="">Choose</option><option value="b">Beta</option><option value="a">Alpha</option></select>','Alpha | Beta',['a','b']);
  await run('shortanswer','<input type="text" name="q9:1_part1"><input type="text" name="q9:1_part2">','hello | world',['hello','world']);
 } finally {await t.close()}
});
