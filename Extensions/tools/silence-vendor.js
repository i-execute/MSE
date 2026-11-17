'use strict';
/* These patches apply to the shipped SyncShare 2.22 webpack bundles, before or after repacking.
   Fail closed on a different vendor build rather than silently shipping a new modal path. */
const DROP = ['parallelAttemptsTitle','parallelAttemptsContent','updateAvailableTitle','updateAvailableContent'];
function replaceOnceOrAlready(text, old, replacement, label) {
  const count = text.split(old).length - 1;
  const done = text.split(replacement).length - 1;
  if (count === 1 && done === 0) return text.replace(old, () => replacement);
  if (count === 0 && done === 1) return text;
  throw new Error(label + ': unexpected vendor shape (original ' + count + ', patched ' + done + ')');
}
function patchBundle(name, code) {
  if (name === 'commons') {
    const re = /,t\.PARALLEL_ATTEMPTS_WARNING=void 0;const s=r\(n\(6815\)\);t\.PARALLEL_ATTEMPTS_WARNING=\{title:s\.default\.i18n\.getMessage\("parallelAttemptsTitle"\),content:s\.default\.i18n\.getMessage\("parallelAttemptsContent"\),construct:!0,keyboard:!1,backdrop:"static",headerClose:!1,buttons:\[\{text:s\.default\.i18n\.getMessage\("gotIt"\),value:!1,attr:\{class:"btn btn-primary","data-dismiss":"modal"\}\}\]\},t\.default=class/;
    if (re.test(code)) code = code.replace(re, ';t.default=class');
    else if (code.includes('PARALLEL_ATTEMPTS_WARNING') || !code.includes('2176:function(e,t,n){')) throw Error('unknown parallel warning constructor');
    const start = 'show(){let e=this._options,t=this._html;return this.emit("show",this),';
    const patched = 'show(){return this}toggle(){this._visible?this.hide():this.show()}';
    const at = code.indexOf(start);
    if (at >= 0) {
      const tail = 'toggle(){this._visible?this.hide():this.show()}';
      const end = code.indexOf(tail, at);
      if (end < 0 || code.indexOf(start,at+1) >= 0) throw Error('vendor modal shape changed');
      code = code.slice(0,at) + patched + code.slice(end+tail.length);
    } else if (!code.includes(patched)) throw Error('vendor modal patch missing');
  }
  if (name === 'quiz_attempt') code = replaceOnceOrAlready(code,
    'await o.invalidate()&&(j.info("Attempt context invalidated"),new x.default(S.PARALLEL_ATTEMPTS_WARNING).show(),j.warn("Parallel attempts warning shown"))',
    'await o.invalidate()&&j.info("Attempt context invalidated")', name);
  if (name === 'quiz_overview') code = replaceOnceOrAlready(code,
    'await a.invalidate()&&(D.info("Attempt context invalidated"),new b.default(w.PARALLEL_ATTEMPTS_WARNING).show())',
    'await a.invalidate()&&D.info("Attempt context invalidated")', name);
  if (name === 'background') {
    const start='4993:function(e,t,a){', end='},5107:(e,t,a)=>';
    const a=code.indexOf(start), b=code.indexOf(end,a+start.length);
    if(a<0||b<0) throw Error('update module missing');
    const body='4993:function(e,t,a){Object.defineProperty(t,"__esModule",{value:!0});const o=a(859);t.default=class{async init(e){e.bind(o.Topics.GetUpdateMessage,e=>this.getUpdateMessage())}async getUpdateMessage(){return null}}';
    code=code.slice(0,a)+body+code.slice(b);
  }
  if (name === 'quiz_board') {
    const old='static async show(e){const t=(0,a.getGlobalShadowRoot)();return t?await(0,o.Eggy)({title:s.default.i18n.getMessage("mse"),...e,container:t,styleContainer:t}):Promise.reject("Global shadow is not initialized")}';
    code=replaceOnceOrAlready(code,old,'static async show(e){return null}',name+' toast');
  }
  return code;
}
function stripLocales(locales) {
  for (const loc of Object.keys(locales)) for (const key of DROP) delete locales[loc][key];
}
function stripSerializedLocales(script) {
  for (const key of DROP) {
    const re=new RegExp('"'+key+'":\\{"message":"(?:\\\\.|[^"\\\\])*"\\},','g');
    script=script.replace(re,'');
    if (script.includes('"'+key+'"')) throw Error('unhandled locale '+key);
  }
  return script;
}
module.exports={patchBundle,stripLocales,stripSerializedLocales,DROP};
