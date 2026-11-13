'use strict';
/*
 * Makes a JS source safe for Stay's userscript pre-processing:
 *
 *  1. Stay strips "comments" with regular expressions before injecting a
 *     script (current: /^\/\/.*$/m, older builds: /(?<!:)\/\/.*|\/\*[\s\S]*?\*\//).
 *     A minified bundle full of "http://..." strings and regex literals would
 *     be corrupted, so the output contains no "//", "/*" or "*\/" at all.
 *  2. Stay switches a script to "page" injection when it sees `window.<name>`
 *     outside a small allow-list. Member accesses are rewritten so the script
 *     can run in the isolated content-script world like the original
 *     extension does.
 *
 * Only the spelling of tokens changes; the program is the same (verified by
 * verifySanitized: identical token stream modulo the documented rewrites).
 */
const acorn = require('acorn');

const WINDOW_ALIAS = '__ssW';
const OPTS = { ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true };

function escLiteralText(raw) {
  /* inside string / template literal: "\/" and "\*" are identity escapes */
  return raw
    .replace(/\/(?=[\/*])/g, '/\\')
    .replace(/\*(?=\/)/g, '*\\')
    .replace(/window\./g, 'window\\x2e');
}

function escRegex(raw) {
  const end = raw.lastIndexOf('/');
  const body = raw.slice(1, end);
  const flags = raw.slice(end + 1);
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '\\') {
      const nx = body[i + 1];
      if (nx === '/') out += '\\x2F';
      else out += ch + nx;
      i++;
    } else if (ch === '/') {
      out += '\\x2F'; /* only legal unescaped inside a character class */
    } else {
      out += ch;
    }
  }
  /* the closing delimiter must not form a "*\/" sequence */
  if (out.endsWith('\\*')) out = out.slice(0, -2) + '\\x2A';
  else if (out.endsWith('*')) out = out.slice(0, -1) + '{0,}';
  if (/window\./.test(out)) throw new Error('regex literal with "window." is not supported: ' + raw.slice(0, 80));
  return '/' + out + '/' + flags;
}

function tokenize(code) {
  const tokens = [];
  const comments = [];
  const ast = acorn.parse(code, Object.assign({}, OPTS, { onToken: tokens, onComment: comments }));
  return { tokens, comments, ast };
}

function taggedQuasiStarts(ast) {
  const starts = new Set();
  (function walk(node) {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'TaggedTemplateExpression') {
      for (const q of node.quasi.quasis) starts.add(q.start);
    }
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v.type === 'string') walk(v);
    }
  })(ast);
  return starts;
}

function sanitize(code) {
  const { tokens, comments, ast } = tokenize(code);
  const tagged = taggedQuasiStarts(ast);
  const edits = [];
  const stats = { comments: comments.length, strings: 0, templates: 0, regexps: 0, windowRefs: 0, windowProps: 0 };

  for (const c of comments) {
    const text = code.slice(c.start, c.end);
    edits.push({ start: c.start, end: c.end, text: /[\n\r\u2028\u2029]/.test(text) ? '\n' : ' ' });
  }

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const raw = code.slice(t.start, t.end);
    const label = t.type.label;
    if (label === 'string') {
      const esc = escLiteralText(raw);
      if (esc !== raw) { edits.push({ start: t.start, end: t.end, text: esc }); stats.strings++; }
    } else if (label === 'template') {
      const esc = escLiteralText(raw);
      if (esc !== raw) {
        if (tagged.has(t.start)) throw new Error('tagged template needs escaping, not supported: ' + raw.slice(0, 80));
        edits.push({ start: t.start, end: t.end, text: esc });
        stats.templates++;
      }
    } else if (label === 'regexp') {
      const esc = escRegex(raw);
      if (esc !== raw) { edits.push({ start: t.start, end: t.end, text: esc }); stats.regexps++; }
    } else if (label === 'name' && /window$/.test(t.value)) {
      const next = tokens[i + 1];
      if (!next || next.type.label !== '.') continue;
      const prev = tokens[i - 1];
      const prevLabel = prev ? prev.type.label : '';
      if (prevLabel === '.') {
        /* a.window.b  ->  a["window"].b */
        edits.push({ start: prev.start, end: t.end, text: '[' + JSON.stringify(t.value) + ']' });
        stats.windowProps++;
      } else if (prevLabel === '?.') {
        edits.push({ start: t.start, end: t.end, text: '[' + JSON.stringify(t.value) + ']' });
        stats.windowProps++;
      } else if (t.value === 'window') {
        edits.push({ start: t.start, end: t.end, text: WINDOW_ALIAS });
        stats.windowRefs++;
      } else {
        throw new Error('identifier "' + t.value + '." would trigger Stay page mode; rename it');
      }
    }
  }

  edits.sort((a, b) => a.start - b.start);
  let out = '';
  let pos = 0;
  for (const e of edits) {
    if (e.start < pos) throw new Error('overlapping edits at ' + e.start);
    out += code.slice(pos, e.start) + e.text;
    pos = e.end;
  }
  out += code.slice(pos);
  return { code: out, stats };
}

/* The regular expressions Stay has used to strip comments (see
   Stay/tampermonkey/Tampermonkey.m, -_removeComment:) plus its page-mode probe. */
const STAY_PATTERNS = {
  'line comment at line start': /^\/\/.*/m,
  'line comment (old)': /(?<!:)\/\/.*/,
  'block comment (old)': /\/\*[\s\S]*?\*\//,
  'any //': /\/\//,
  'any /*': /\/\*/,
  'any */': /\*\//,
  'window.<name> (forces page mode)': /window\.[a-zA-Z|()]/,
};

function normPattern(p) {
  return p.replace(/\\x2F/g, '/').replace(/\\\//g, '/').replace(/\\x2A$/, '\\*').replace(/\{0,\}$/, '*');
}

function normTokens(code) {
  const { tokens } = tokenize(code);
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const label = t.type.label;
    if (label === 'regexp') out.push('re:' + normPattern(t.value.pattern) + '/' + t.value.flags);
    else if (label === 'string' || label === 'template') out.push(label + ':' + t.value);
    else if (label === 'name' || label === 'num' || label === 'privateId') out.push(label + ':' + t.value);
    else out.push(typeof t.value === 'string' ? label + ' ' + t.value : label); /* operators share labels, e.g. === and !== */
  }
  return out;
}

/* a.window -> a["window"] and window -> alias, applied to the token list of the original */
function expectedTokens(code) {
  const { tokens } = tokenize(code);
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const label = t.type.label;
    const next = tokens[i + 1];
    const prev = tokens[i - 1];
    if (label === 'name' && /window$/.test(t.value) && next && next.type.label === '.') {
      const pl = prev ? prev.type.label : '';
      if (pl === '.') { out.pop(); out.push('[', 'string:' + t.value, ']'); continue; }
      if (pl === '?.') { out.push('[', 'string:' + t.value, ']'); continue; }
      out.push('name:' + (t.value === 'window' ? WINDOW_ALIAS : t.value));
      continue;
    }
    if (label === 'regexp') out.push('re:' + normPattern(t.value.pattern) + '/' + t.value.flags);
    else if (label === 'string' || label === 'template') out.push(label + ':' + t.value);
    else if (label === 'name' || label === 'num' || label === 'privateId') out.push(label + ':' + t.value);
    else out.push(typeof t.value === 'string' ? label + ' ' + t.value : label); /* operators share labels, e.g. === and !== */
  }
  return out;
}

function verifySanitized(original, result) {
  const code = result.code;
  for (const [name, re] of Object.entries(STAY_PATTERNS)) {
    const m = re.exec(code);
    if (m) throw new Error(`sanitized code still matches "${name}" at ${m.index}: ${JSON.stringify(code.slice(Math.max(0, m.index - 40), m.index + 40))}`);
  }
  const want = expectedTokens(original);
  const got = normTokens(code);
  if (want.length !== got.length) throw new Error(`token count changed: ${want.length} -> ${got.length}`);
  for (let i = 0; i < want.length; i++) {
    if (want[i] !== got[i]) throw new Error(`token ${i} changed: ${JSON.stringify(want[i]).slice(0, 120)} -> ${JSON.stringify(got[i]).slice(0, 120)}`);
  }
  return { tokens: got.length };
}

module.exports = { sanitize, verifySanitized, STAY_PATTERNS, escLiteralText, escRegex, WINDOW_ALIAS };
