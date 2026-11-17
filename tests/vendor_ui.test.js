'use strict';
const test=require('node:test'), assert=require('node:assert/strict'),h=require('./lib/harness'),fs=require('fs'),path=require('path');
test('vendor UI paths are disabled; selection stays silent and inside the compact panel', {timeout:60000},async()=>{
 const t=await h.launch({openShadow:true,api:req=>({status:200,json:req.path.includes('/solution')?[{suggestions:[{label:'A hashtag',correctness:2}]}]:{}})});
 try{
  await t.context.addInitScript(()=>{window.__dialogs=[];window.alert=x=>window.__dialogs.push(['alert',x]);window.confirm=x=>{window.__dialogs.push(['confirm',x]);return false;};});
  const page=await t.newPage(h.fixtureUrl('attempt'));await page.waitForFunction(()=>!!window.__mse&&!!window.__mseRuntime);
  const noVendor=await page.evaluate(async()=>{
   const rt=window.__mseRuntime;const locations=['attempt','review','summary','view'].map(x=>({protocol:'https:',pathname:'/mod/quiz/'+x+'.php',search:''}));
   return {scripts:locations.map(x=>rt._internals.contentScriptsFor(x)),popup:await rt.openPopup(),dialogs:window.__dialogs};
  });
  assert.deepEqual(noVendor.scripts,[null,null,null,null]);assert.equal(noVendor.popup,null);assert.deepEqual(noVendor.dialogs,[]);
  await page.evaluate(()=>window.__mse.open());await page.waitForFunction(()=>window.__mse.root().querySelector('.ans'));
  await page.evaluate(()=>window.__mse.root().querySelector('.ans').click()); await page.waitForTimeout(400);
  const result=await page.evaluate(()=>({visible:window.__mse.state().visible, checked:!!document.querySelector('.que .answer input[type=radio]:checked'), toasts:window.__mse.root().querySelectorAll('.toast').length, dialogs:window.__dialogs, lit:!!window.__mse.root().querySelector('.ans.lit')}));
  assert.equal(result.visible,true);assert.equal(result.checked,true);assert.equal(result.toasts,0);assert.equal(result.lit,true);assert.deepEqual(result.dialogs,[]);
  if (process.env.MSE_EVIDENCE_DIR) { fs.mkdirSync(process.env.MSE_EVIDENCE_DIR,{recursive:true}); await page.screenshot({path:path.join(process.env.MSE_EVIDENCE_DIR,'mse26-panel.png')}); }
 }finally{await t.close()}
});
