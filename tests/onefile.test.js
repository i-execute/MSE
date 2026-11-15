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
