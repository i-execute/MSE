'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./lib/harness.js');

test('2.10-A: Sniffer dump includes schema_layer=1 and is_known_layer boolean', { timeout: 60000 }, async () => {
  const t = await h.launch({ api: () => ({ status: 200, json: [] }) });
  try {
    const page = await t.newPage(h.fixtureUrl('attempt'));
    await page.waitForFunction(() => !!window.__mse && !!window.MSEBridge);
    await page.evaluate(() => window.__mse.open());
    await page.waitForFunction(() => !!window.__mse.state().question);

    const parsed = await page.evaluate(() => window.__mse.snifDump());

    assert.equal(parsed.schema, 'mse-snif-1');
    assert.equal(parsed.schema_layer, 1, 'schema_layer is 1');
    assert.equal(typeof parsed.is_known_layer, 'boolean', 'is_known_layer is boolean');
    assert.equal(parsed.is_known_layer, true, 'is_known_layer is true for standard Moodle attempt');
  } finally {
    await t.close();
  }
});
