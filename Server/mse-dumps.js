'use strict';
/* Dump storage is intentionally outside the code tree (under MSE_DATA_DIR). */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const MAX_BYTES = 256 * 1024;
const KEEP = 100;
const SECRET_FIELD = /^(authorization|cookie|cookies|set-cookie|key|devicekey|api[-_]?key|password|passwd|secret|token|sesskey|session|csrf|xsrf|inlineMoodleScripts)$/i;
function cleanText(input, deviceKey) {
  let s = String(input);
  if (deviceKey) s = s.split(deviceKey).join('[redacted]');
  s = s.replace(/mse_[A-Za-z0-9_-]{20,}/g, '[redacted]');
  s = s.replace(/\bBearer\s+[A-Za-z0-9_.-]+/gi, 'Bearer [redacted]');
  // Query strings and fragments are not needed to identify the resource; they can contain credentials.
  s = s.replace(/(https?:\/\/[^\s"'<>?#]+)[?#][^\s"'<>]*/gi, '$1?[redacted]');
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '[script removed]');
  s = s.replace(/<input\b[^>]*(?:type\s*=\s*["']?(?:hidden|password)|name\s*=\s*["']?(?:sesskey|token|password|csrf))[^>]*>/gi, '[hidden input removed]');
  s = s.replace(/((?:sesskey|password|token|secret|csrf|session|authorization)\s*["']?\s*[:=]\s*["']?)[^\s"'&,<>}]+/gi, '$1[redacted]');
  return s;
}
function clean(value, deviceKey, depth = 0) {
  if (depth > 30) return '[depth limit]';
  if (typeof value === 'string') return cleanText(value, deviceKey);
  if (Array.isArray(value)) return value.slice(0, 10000).map(v => clean(v, deviceKey, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const out = {};
  const sensitiveInput = /^(hidden|password)$/i.test(String(value.type || '')) || /sess|token|secret|pass|csrf|auth|cookie/i.test(String(value.name || ''));
  for (const [k,v] of Object.entries(value)) out[k] = (sensitiveInput && /^(value|text)$/i.test(k)) || SECRET_FIELD.test(k) ? '[redacted]' : clean(v, deviceKey, depth + 1);
  return out;
}
function store(dataDir, rec, type, dump, deviceKey) {
  const dir = path.join(dataDir, 'dumps');
  fs.mkdirSync(dir, {recursive:true, mode:0o700}); fs.chmodSync(dir, 0o700);
  const id = crypto.randomBytes(16).toString('hex');
  const meta = { id, type, at:new Date().toISOString(), moodleId:rec.moodleId, deviceId:rec.deviceId, deviceKeyHash:crypto.createHash('sha256').update(deviceKey).digest('hex') };
  let obj = { ...meta, truncated:!!(dump && dump.clientTruncated), dump:clean(dump, deviceKey) };
  let bytes = Buffer.from(JSON.stringify(obj,null,2));
  if (bytes.length > MAX_BYTES) {
    // Preview is a valid JSON string rather than a truncated JSON document. Budget for worst-case JSON escaping.
    let preview = Buffer.from(JSON.stringify(obj.dump)).subarray(0, Math.floor((MAX_BYTES - 4096)/6)).toString('utf8');
    obj = { ...meta, truncated:true, preview };
    bytes = Buffer.from(JSON.stringify(obj,null,2));
    while (bytes.length > MAX_BYTES) { preview = preview.slice(0, Math.floor(preview.length * 0.8)); obj.preview = preview; bytes = Buffer.from(JSON.stringify(obj,null,2)); }
  }
  fs.writeFileSync(path.join(dir,id+'.json'), bytes, {mode:0o600, flag:'wx'});
  const files = fs.readdirSync(dir).filter(f => /^[a-f0-9]{32}\.json$/.test(f)).map(f => ({f, t:fs.statSync(path.join(dir,f)).mtimeMs})).sort((a,b)=>b.t-a.t);
  for (const x of files.slice(KEEP)) fs.unlinkSync(path.join(dir,x.f));
  return { ...meta, truncated:obj.truncated, bytes:bytes.length };
}
function list(dataDir) {
  const dir=path.join(dataDir,'dumps');
  try { return fs.readdirSync(dir).filter(f=>/^[a-f0-9]{32}\.json$/.test(f)).map(f=>{
    try { const x=JSON.parse(fs.readFileSync(path.join(dir,f),'utf8')); return {id:x.id, type:x.type, at:x.at, moodleId:x.moodleId, deviceId:x.deviceId, truncated:x.truncated}; }
    catch (_) { return null; }
  }).filter(Boolean).sort((a,b)=>b.at.localeCompare(a.at)).slice(0,10); } catch (e) { if (e.code==='ENOENT') return []; throw e; }
}
function get(dataDir,id) {
  if (!/^[a-f0-9]{32}$/.test(id)) return null;
  try { return JSON.parse(fs.readFileSync(path.join(dataDir,'dumps',id+'.json'),'utf8')); }
  catch (e) { if (e.code==='ENOENT') return null; throw e; }
}
module.exports={store,list,get,clean,MAX_BYTES,KEEP};
