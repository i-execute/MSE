'use strict';
/*
 * Bug 3 as a regression test: the iOS script must be ONE file and ONE script.
 *
 * Stay takes the file, injects it as a single page script and nothing else. If the build ever goes back to
 * creating extra <script> tags at run time (the way it injected the interface, the authorisation, the bridge and
 * the debug layer), the user ends up pasting several pieces and the panel does not appear. This test reads the
 * shipped artifact and fails on any of that.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ART = path.join(__dirname, '..', 'Storage', 'artifacts');
const src = fs.readFileSync(path.join(ART, 'mse.user.js'), 'utf8');
const report = JSON.parse(fs.readFileSync(path.join(ART, 'build-report.json'), 'utf8'));

test('iOS: one file, one userscript header, no @require', () => {
  assert.match(src, /^\/\/ @version\s+2\.12\.0$/m);
  assert.equal(report.version, '2.12.0');
  assert.equal(require('../package.json').version, '2.12.0');
  assert.equal((src.match(/==UserScript==/g) || []).length, 1, 'exactly one userscript header');
  assert.equal((src.match(/==\/UserScript==/g) || []).length, 1, 'exactly one userscript footer');
  assert.equal((src.match(/^\s*\/\/\s*@require\b/gm) || []).length, 0, 'no @require');
  assert.equal((src.match(/^\s*\/\/\s*@resource\b/gm) || []).length, 0, 'no @resource');
});

test('iOS: the build injects no script of its own', () => {
  /* the shipped body must not contain the four extra <script> tags the old build made for its parts */
  assert.ok(!/__mseShellSrc|__mseDebugSrc|__mseAuthSrc|__mseBridgeSrc/.test(src),
    'no dynamic <script> injection of the parts');
  const created = (src.match(/createElement\(["']script["']\)/g) || []);
  assert.equal(created.length, 2,
    'both <script> elements in the file belong to the vendor bundle (an inert one inside its iframe and its ' +
    'error-reporting helper); our own code creates none');
});

test('iOS: every part still rides along in the same file', () => {
  for (const marker of ['MSEBridge', 'MSEAuth', 'createMSERuntime', '__msePageWindow']) {
    assert.ok(src.includes(marker), 'the file still contains ' + marker);
  }
  /* the parts each keep their own scope, so the whole thing is one script with no leaked helpers */
  assert.ok((src.match(/^;\(function\(\)\{/gm) || []).length >= 4, 'each part is its own scoped block');
});

test('iOS: the build report states the one-file facts', () => {
  assert.ok(report.oneFile, 'the report has a oneFile section');
  assert.equal(report.oneFile.scripts, 1);
  assert.equal(report.oneFile.headers, 1);
  assert.equal(report.oneFile.requires, 0);
  assert.ok(report.oneFile.bytes > 100000, 'the file is the whole thing, not a stub');
});

test('shipped UI and bridge match sanitized source and report', () => {
  const crypto = require('crypto');
  const { sanitize, verifySanitized } = require('../Extensions/tools/sanitize.js');
  const sourceDir = path.join(__dirname, '..', 'Extensions', 'src');
  const css = fs.readFileSync(path.join(sourceDir, 'theme.css'), 'utf8');
  for (const name of ['mse-ui', 'mse-bridge']) {
    let source = fs.readFileSync(path.join(sourceDir, name + '.js'), 'utf8');
    if (name === 'mse-ui') source = source.replace('  var CSS = [ /* @theme */ ];', '  var CSS = ' + JSON.stringify(':host,*{box-sizing:border-box}\n' + css) + ';');
    const clean = sanitize(source);
    verifySanitized(source, clean);
    const block = ';(function(){\nvar __ssW=window,__msePageWindow=window;\n' + clean.code + '\n})();\n';
    assert.equal(src.split(block).length, 2, name + ' embedded exactly once');
    assert.equal(report.pageScripts[name].sha256, crypto.createHash('sha256').update(clean.code).digest('hex'));
  }
  assert.equal(report.userscript.sha256, crypto.createHash('sha256').update(src).digest('hex'));
  assert.equal(report.userscript.bytes, Buffer.byteLength(src));
  assert.equal(report.oneFile.bytes, src.length);
});

test('repacking all maintained sources, including runtime, is reproducible', () => {
  const os = require('os'), cp = require('child_process');
  const root = path.join(__dirname, '..'), tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mse-repack-'));
  try {
    for (const dir of ['Extensions/src', 'Extensions/tools', 'Storage/artifacts']) {
      fs.mkdirSync(path.join(tmp, path.dirname(dir)), {recursive:true});
      fs.cpSync(path.join(root,dir), path.join(tmp,dir), {recursive:true});
    }
    fs.copyFileSync(path.join(root,'package.json'),path.join(tmp,'package.json'));
    cp.execFileSync(process.execPath,[path.join(tmp,'Extensions/tools/repack-artifact.js')], {env:{...process.env, NODE_PATH:path.join(root,'node_modules')}});
    for (const file of ['mse.user.js','build-report.json'])
      assert.deepEqual(fs.readFileSync(path.join(tmp,'Storage/artifacts',file)),fs.readFileSync(path.join(ART,file)), file + ' changed after repack');
  } finally { fs.rmSync(tmp,{recursive:true,force:true}); }
});
