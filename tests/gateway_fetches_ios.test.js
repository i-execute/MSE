'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const router = require('../Server/mse-router.js');
const h = require('./lib/harness.js');

test('Criterion 1 & 2: WebKit/Stay never makes parallel fetches to gateway and retries TypeError once after 500ms', async () => {
  const t = await h.launch({ api: () => ({ status: 200, json: [] }) });
  try {
    const page = await t.newPage(h.fixtureUrl('attempt'));
    await page.waitForFunction(() => !!window.__mse && !!window.MSEBridge);

    // Track active in-flight fetches and retry events in the browser context
    const fetchResults = await page.evaluate(async () => {
      window.MSEBridge.setUrl(location.origin);
      window.MSEBridge.saveMeta({ device: { deviceId: 'test-dev-1', moodleId: '12345', status: 'active' } }, {});

      let inFlight = 0;
      let maxInFlight = 0;
      let callCount = 0;
      let delays = [];
      let lastCallTime = 0;

      const originalFetch = window.fetch;
      window.fetch = function (url, opts) {
        const urlStr = String(url);
        // Only track gateway calls
        if (urlStr.includes('/health') || urlStr.includes('/mse/v1/')) {
          callCount++;
          inFlight++;
          if (inFlight > maxInFlight) maxInFlight = inFlight;

          const now = Date.now();
          if (lastCallTime > 0) {
            delays.push(now - lastCallTime);
          }
          lastCallTime = now;

          // For the retry test: if calling /mse/v1/test-retry, fail on first call with TypeError
          if (urlStr.includes('/mse/v1/test-retry')) {
            if (callCount === 1) {
              inFlight--;
              return Promise.reject(new TypeError('Load failed'));
            }
          }

          return new Promise((resolve) => {
            setTimeout(() => {
              inFlight--;
              resolve(new Response(JSON.stringify({
                ok: true,
                status: 'active',
                state: 'active',
                message: 'key accepted',
                device: { status: 'active', moodleId: '12345' },
                model: 'test-model',
                version: '2.14.0'
              }), {
                status: 200,
                headers: { 'content-type': 'application/json', 'x-mse-status': 'active' }
              }));
            }, 80);
          });
        }
        return originalFetch.apply(this, arguments);
      };

      // 1. Parallel launch of probe and check: verify queue serializes them (max in-flight = 1)
      const p1 = window.MSEBridge.probe();
      const p2 = window.MSEBridge.check('12345');
      const [r1, r2] = await Promise.all([p1, p2]);

      return {
        maxInFlight,
        callCount,
        r1Ok: r1.ok || r1.reachable,
        r2State: r2.state
      };
    });

    assert.equal(fetchResults.maxInFlight, 1, 'Max in-flight requests to gateway must be strictly <= 1');
    assert.equal(fetchResults.r2State, 'active', 'check resolved successfully');

    // 2. Test TypeError retry after 500ms
    const retryResult = await page.evaluate(async () => {
      let attempts = 0;
      let timestamps = [];
      const origFetch = window.fetch;

      window.fetch = function (url, opts) {
        const urlStr = String(url);
        if (urlStr.includes('/mse/v1/me')) {
          attempts++;
          timestamps.push(Date.now());
          if (attempts === 1) {
            return Promise.reject(new TypeError('Load failed'));
          }
          return Promise.resolve(new Response(JSON.stringify({
            ok: true,
            status: 'active',
            state: 'active',
            message: 'key accepted',
            device: { status: 'active' },
            model: 'retry-model'
          }), { status: 200, headers: { 'content-type': 'application/json' } }));
        }
        return origFetch.apply(this, arguments);
      };

      const res = await window.MSEBridge.check('12345');
      const delay = timestamps.length === 2 ? timestamps[1] - timestamps[0] : 0;

      return {
        attempts,
        delay,
        state: res.state,
        message: res.message
      };
    });

    assert.equal(retryResult.attempts, 2, 'Exactly 2 attempts made (1 initial + 1 retry)');
    assert.ok(retryResult.delay >= 450, 'Retry happened after ~500ms delay: ' + retryResult.delay + 'ms');
    assert.equal(retryResult.state, 'active', 'Second attempt succeeded');
    assert.equal(retryResult.message, 'key accepted');

  } finally {
    await t.close();
  }
});

test('Criterion 3: Composite GET /mse/v1/me returns composite payload and client makes exactly 1 request per cycle', async () => {
  const https = require('node:https');
  const fs = require('node:fs');
  const { ensureTls } = require('./lib/tls.js');
  const tls = ensureTls();

  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  const PORT = 19855;
  const srv = https.createServer({ cert: fs.readFileSync(tls.cert), key: fs.readFileSync(tls.key) }, router.handler);
  await new Promise(r => srv.listen(PORT, '127.0.0.1', r));

  try {
    const testKey = 'mse_' + '3'.repeat(48);
    // Register & allow device
    await fetch(`https://127.0.0.1:${PORT}/mse/v1/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: testKey, moodleId: '22222', name: 'Composite Device' })
    });
    await fetch(`https://127.0.0.1:${PORT}/admin/allow`, {
      method: 'POST',
      headers: { 'x-admin-token': router.ADMIN_TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ moodleId: '22222' })
    });

    // 1. Verify router /mse/v1/me response fields directly
    const meRes = await fetch(`https://127.0.0.1:${PORT}/mse/v1/me`, {
      headers: { authorization: 'Bearer ' + testKey, 'x-moodle-id': '22222' }
    });
    assert.equal(meRes.status, 200);
    const me = await meRes.json();

    assert.equal(me.ok, true);
    assert.equal(me.status, 'active');
    assert.equal(me.state, 'active');
    assert.equal(me.message, 'key accepted');
    assert.equal(me.version, '2.14.0');
    assert.equal(me.schema_layer, 1);
    assert.equal(me.layer, 1);
    assert.ok(me.model, 'Composite response contains model: ' + me.model);
    assert.ok(Array.isArray(me.models), 'Composite response contains models list');
    assert.equal(typeof me.quota, 'number', 'Composite response contains quota number');
    assert.equal(typeof me.quotaLimit, 'number');
    assert.equal(typeof me.quotaUsed, 'number');
    assert.ok(me.resets_after, 'Composite response contains resets_after');
    assert.ok(me.quotaDetails, 'Composite response contains quotaDetails object');

    // 2. Launch WebKit and verify client makes EXACTLY 1 request to gateway during standard cycle
    const pw = require('playwright');
    const browser = await pw.webkit.launch();
    const context = await browser.newContext(Object.assign({}, pw.devices['iPhone 13'], { ignoreHTTPSErrors: true }));
    const t = await h.launch({ api: () => ({ status: 200, json: [{ suggestions: [{ label: 'Option A', count: 5 }] }] }), context });
    try {
      const page = await t.newPage(h.fixtureUrl('attempt'));
      await page.waitForFunction(() => !!window.__mse && !!window.MSEBridge);

      let gatewayHits = [];
      await page.route(`https://127.0.0.1:${PORT}/**`, route => {
        gatewayHits.push(route.request().url());
        return route.continue();
      });

      await page.evaluate((cfg) => {
        window.MSEBridge.setUrl(cfg.url);
        window.MSEBridge.saveMeta({ device: { deviceId: 'composite-dev', moodleId: '22222', status: 'active' } }, { key: cfg.key });
        localStorage.setItem('mse.gateway.key', cfg.key);
      }, { url: `https://127.0.0.1:${PORT}`, key: testKey });

      // Trigger popover open (standard cycle)
      await page.evaluate(() => window.__mse.open());
      await page.waitForFunction(() => !!window.__mse.root().querySelector('.pop.in'));
      await page.waitForTimeout(1000);

      // Filter gateway hits for the cycle
      const relevantHits = gatewayHits.filter(u => u.includes('/mse/v1/') || u.includes('/health'));
      assert.equal(relevantHits.length, 1, 'Client makes EXACTLY ONE request to gateway per cycle: ' + JSON.stringify(relevantHits));
      assert.ok(relevantHits[0].includes('/mse/v1/me'), 'The one request is to composite /mse/v1/me: ' + relevantHits[0]);

      // Verify model is shown in header chip without calling /health
      const chip = await page.evaluate(() => {
        const el = window.__mse.root().querySelector('[data-mse="model-chip"]');
        return el ? el.textContent : null;
      });
      assert.ok(chip, 'Header model chip rendered: ' + chip);

    } finally {
      await t.close();
      await browser.close();
    }
  } finally {
    await new Promise(r => srv.close(r));
  }
});

test('Criterion 4: Single status row in settings and instant cache display on popover open', async () => {
  const t = await h.launch({ api: () => ({ status: 200, json: [] }) });
  try {
    const page = await t.newPage(h.fixtureUrl('attempt'));
    await page.waitForFunction(() => !!window.__mse && !!window.MSEBridge);

    // Pre-populate cache
    await page.evaluate(() => {
      const cached = {
        key: 'mse_test_cached_key',
        check: {
          state: 'active',
          ok: true,
          message: 'key accepted',
          ms: 142,
          model: 'instant-cached-model',
          quota: 185,
          quotaLimit: 200,
          quotaUsed: 15,
          quotaResetsAfter: '14h 20m'
        },
        t: Date.now()
      };
      localStorage.setItem('mse.gateway.key', 'mse_test_cached_key');
      localStorage.setItem('mse.cache.gw_check', JSON.stringify(cached));
      window.MSEBridge.setUrl('https://gateway.example.com');
      window.MSEBridge.saveMeta({ device: { deviceId: 'cached-dev', moodleId: '99999', status: 'active' } }, { key: 'mse_test_cached_key' });
    });

    // Open popover and verify instant display from cache without any network delay
    const initialView = await page.evaluate(() => {
      window.__mse.open();
      const root = window.__mse.root();
      const chip = root.querySelector('[data-mse="model-chip"]');
      return {
        modelChip: chip ? chip.textContent : null,
        tier: window.__mse.tier ? window.__mse.tier() : null
      };
    });

    assert.equal(initialView.modelChip, 'instant-cached-model', 'Model chip is immediately rendered from cache');

    // Route to gateway settings and verify status has exactly ONE row and displays "key accepted · N ms"
    await page.evaluate(() => window.__mse.route('gateway'));
    await page.waitForFunction(() => window.__mse.route() === 'gateway');

    const statusInfo = await page.evaluate(() => {
      const root = window.__mse.root();
      const secTitles = Array.from(root.querySelectorAll('.sec')).map(s => s.textContent.trim());
      const statusSec = Array.from(root.querySelectorAll('.sec')).find(s => s.textContent.trim() === 'status');
      const rows = [];
      if (statusSec && statusSec.nextElementSibling) {
        let sibling = statusSec.nextElementSibling;
        while (sibling && !sibling.classList.contains('sec')) {
          rows.push({
            text: sibling.textContent.trim(),
            hasDot: !!sibling.querySelector('.dot'),
            dotClass: sibling.querySelector('.dot') ? sibling.querySelector('.dot').className : ''
          });
          sibling = sibling.nextElementSibling;
        }
      }
      return {
        secTitles,
        statusRows: rows
      };
    });

    assert.equal(statusInfo.statusRows.length, 1, 'Exactly ONE status row is displayed in settings');
    assert.match(statusInfo.statusRows[0].text, /^key accepted\s*·\s*142\s*ms$/, 'Status row format is "key accepted · N ms"');
    assert.match(statusInfo.statusRows[0].dotClass, /\bok\b/, 'Status dot has ok class');

  } finally {
    await t.close();
  }
});
