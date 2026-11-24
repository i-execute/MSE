'use strict';
/* Repack the maintained MSE sources into the existing one-file artifact.
   The original vendor build input is not bundled; this does not rebuild vendor chunks. */
const fs=require('fs'), path=require('path'), crypto=require('crypto');
const {sanitize,verifySanitized}=require('./sanitize');
const {patchBundle,stripSerializedLocales}=require('./silence-vendor');
const root=path.resolve(__dirname,'../..'), src=path.join(root,'Extensions/src'), artifact=path.join(root,'Storage/artifacts/mse.user.js'), reportPath=path.join(root,'Storage/artifacts/build-report.json');
const read=p=>fs.readFileSync(p,'utf8'); const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
const version=JSON.parse(read(path.join(root,'package.json'))).version;
let script=read(artifact), report=JSON.parse(read(reportPath));
// Patch the vendor functions already embedded in this artifact. Boundaries are checked.
const bundles=['commons','background','quiz_attempt','quiz_overview','quiz_board','popup','popper','bootstrap'];
for (let i=0;i<5;i++) {
 const name=bundles[i], start=name+':function(){\n', end='\n},\n'+bundles[i+1]+':function(){\n';
 const a=script.indexOf(start), b=script.indexOf(end,a+start.length);
 if(a<0||b<0) throw Error('vendor bundle boundaries missing: '+name);
 const out=patchBundle(name,script.slice(a+start.length,b));
 script=script.slice(0,a+start.length)+out+script.slice(b);
 report.bundles[name].bytes=Buffer.byteLength(out);report.bundles[name].sha256=sha(out);
}
script=stripSerializedLocales(script);
function rebrand(s) {
  const domains=['syncshare.ru','syncshare.naloaty.me'];
  domains.forEach((d,i)=>{s=s.split(d).join('\u0000D'+i+'\u0000')});
  s=s.split('SyncShare').join('MSE').split('syncshare').join('mse');
  domains.forEach((d,i)=>{s=s.split('\u0000D'+i+'\u0000').join(d)});return s;
}
const begin='var __mseCreate=(function(){\n', end='\nreturn createMSERuntime;';
const a=script.indexOf(begin), b=script.indexOf(end,a+begin.length);
if(a<0||b<0)throw Error('runtime boundary not found');
const runtime=sanitize(rebrand(read(path.join(src,'runtime.js')))).code.replace(/\n$/,'');
script=script.slice(0,a+begin.length)+runtime+script.slice(b);
const marker=';(function(){\nvar __ssW=window,__msePageWindow=window;\n';
const positions=[];for(let p=0;;){let i=script.indexOf(marker,p);if(i<0)break;positions.push(i);p=i+marker.length;}
if(positions.length!==4)throw Error('expected four page scripts');
const css=read(path.join(src,'theme.css'));
for(const [index,name] of [[3,'mse-ui'],[0,'mse-bridge']]) {
 let source=read(path.join(src,name+'.js'));
 if(name==='mse-ui')source=source.replace('  var CSS = [ /* @theme */ ];','  var CSS = '+JSON.stringify(':host,*{box-sizing:border-box}\n'+css)+';');
 const clean=sanitize(source);verifySanitized(source,clean);
 const limit=index===3?script.indexOf('\ntry{ var __mseReady',positions[index]):positions[index+1];
 const close=script.lastIndexOf('\n})();\n',limit);
 if(limit<0||close<positions[index])throw Error('page script boundary missing: '+name);
 const block=marker+clean.code+'\n})();\n';
 script=script.slice(0,positions[index])+block+script.slice(close+'\n})();\n'.length);
 report.pageScripts[name]={bytes:clean.code.length,sha256:sha(clean.code),sanitizer:clean.stats};
}
script=script.replace(/^(\/\/ @version\s+)\S+/m,'$1'+version);
script=script.replace(/^\/\/\s*@name:ru\s+.*\n/m, '');
if(!script.includes('*://*/course/view.php*')){
 script=script.replace('// @match        *://*/my/index.php*\n','// @match        *://*/my/index.php*\n// @match        *://*/course/view.php*\n// @match        *://*/course/index.php*\n');
}
report.version=version;report.oneFile.bytes=script.length;report.userscript.bytes=Buffer.byteLength(script);report.userscript.sha256=sha(script);
fs.writeFileSync(artifact,script);fs.writeFileSync(reportPath,JSON.stringify(report,null,2)+'\n');
console.log('repacked one-file artifact',version,report.userscript.sha256);
