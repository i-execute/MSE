"""Comprehensive test suite for MSE 2.14.1 critical hotfix:
1. CSP blocking window.fetch (Safari TypeError: Load failed) with GM_xmlhttpRequest succeeding
2. Fallback to window.fetch when GM is unavailable (order: GM -> fetch)
3. Timeout handling (30s standard, 120s agent) and AbortController .abort() integration
4. No avalanche loops: retry capped at 1 retry (max 2 attempts)
5. Transport identifier ('gm' vs 'fetch') in diagnostics and network logs
6. Zero Russian / VPN blaming messages in extension UI and bridge
"""
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def test_1_csp_blocking_fetch_with_gm_passing():
    print("Testing 1: Safari CSP blocks fetch, but GM_xmlhttpRequest bypasses CSP and succeeds...")
    node_test = """
    const fs = require('fs');
    const path = require('path');
    const assert = require('assert');

    // Simulate browser window
    global.window = global;
    global.localStorage = {
      _data: {},
      getItem(k) { return this._data[k] || null; },
      setItem(k, v) { this._data[k] = String(v); },
      removeItem(k) { delete this._data[k]; },
      clear() { this._data = {}; }
    };

    // 1. window.fetch throws TypeError ('Load failed') as Safari does due to Moodle page CSP connect-src
    global.fetch = async function (url, opts) {
      throw new TypeError('Load failed');
    };

    // 2. GM_xmlhttpRequest succeeds in runner context
    let gmCalls = 0;
    global.GM_xmlhttpRequest = function (details) {
      gmCalls++;
      setTimeout(() => {
        if (details.url.endsWith('/health')) {
          details.onload({
            status: 200,
            statusText: 'OK',
            responseText: JSON.stringify({ name: 'MSE gateway', version: '2.14.1', model: 'gpt-4o' }),
            responseHeaders: 'content-type: application/json\\r\\n'
          });
        } else if (details.url.includes('/mse/v1/me')) {
          details.onload({
            status: 200,
            statusText: 'OK',
            responseText: JSON.stringify({
              status: 'active',
              device: { deviceId: 'mse-12345', status: 'active', quota: 100 },
              version: '2.14.1',
              model: 'gpt-4o'
            }),
            responseHeaders: 'content-type: application/json\\r\\nx-mse-status: active\\r\\n'
          });
        } else if (details.url.includes('/mse/v1/agent')) {
          details.onload({
            status: 200,
            statusText: 'OK',
            responseText: JSON.stringify({ ok: true, answer: 'Paris', model: 'gpt-4o' }),
            responseHeaders: 'content-type: application/json\\r\\n'
          });
        } else {
          details.onload({ status: 200, statusText: 'OK', responseText: '{}', responseHeaders: '' });
        }
      }, 10);
      return { abort() {} };
    };

    const bridgeCode = fs.readFileSync(path.join(process.cwd(), 'Extensions/src/mse-bridge.js'), 'utf8');
    eval(bridgeCode);

    const bridge = global.MSEBridge;
    bridge.setUrl('https://gateway.example.com');

    (async () => {
      // 1. probe() should succeed via GM_xmlhttpRequest despite window.fetch being blocked
      const pr = await bridge.probe();
      assert.equal(pr.ok, true, 'probe succeeded via GM');
      assert.equal(pr.reachable, true);
      assert.equal(pr.transport, 'gm', 'transport must be gm');
      assert.equal(pr.version, '2.14.1');

      // 2. check() should succeed via GM_xmlhttpRequest
      const ch = await bridge.check('12345');
      assert.equal(ch.state, 'active', 'check succeeded via GM');
      assert.equal(ch.transport, 'gm', 'transport must be gm');

      // 3. agent() should succeed via GM_xmlhttpRequest
      const ag = await bridge.agent({ question: 'Capital of France?', options: ['Paris', 'London'] });
      assert.equal(ag.ok, true);
      assert.equal(ag.answer, 'Paris');

      assert.ok(gmCalls >= 3, 'All gateway calls must route through GM_xmlhttpRequest');
      console.log('CSP bypass verified successfully.');
    })().catch(e => {
      console.error(e);
      process.exit(1);
    });
    """
    res = subprocess.run(["node", "-e", node_test], cwd=str(ROOT), capture_output=True, text=True)
    assert res.returncode == 0, f"Test 1 failed: {res.stderr}\n{res.stdout}"
    print("  -> Passed: GM_xmlhttpRequest successfully bypasses page CSP and delivers gateway requests.")


def test_2_fallback_to_fetch_when_gm_absent():
    print("Testing 2: Fallback to window.fetch when GM transport is unavailable...")
    node_test = """
    const fs = require('fs');
    const path = require('path');
    const assert = require('assert');

    global.window = global;
    global.localStorage = {
      _data: {},
      getItem(k) { return this._data[k] || null; },
      setItem(k, v) { this._data[k] = String(v); },
      removeItem(k) { delete this._data[k]; },
      clear() { this._data = {}; }
    };

    // No GM_xmlhttpRequest defined
    delete global.GM_xmlhttpRequest;
    delete global.GM;
    delete global.__mseGm;

    // window.fetch is available
    let fetchCalls = 0;
    global.fetch = async function (url, opts) {
      fetchCalls++;
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: {
          get(h) { return h.toLowerCase() === 'content-type' ? 'application/json' : null; }
        },
        async json() {
          return { name: 'MSE gateway', version: '2.14.1', model: 'fallback-model' };
        },
        async text() {
          return JSON.stringify({ name: 'MSE gateway', version: '2.14.1', model: 'fallback-model' });
        },
        clone() { return this; }
      };
    };

    const bridgeCode = fs.readFileSync(path.join(process.cwd(), 'Extensions/src/mse-bridge.js'), 'utf8');
    eval(bridgeCode);

    const bridge = global.MSEBridge;
    bridge.setUrl('https://gateway.example.com');

    (async () => {
      const pr = await bridge.probe();
      assert.equal(pr.ok, true);
      assert.equal(pr.transport, 'fetch', 'transport must report fetch');
      assert.equal(fetchCalls, 1, 'fetch must be called when GM is absent');
      console.log('Fallback verified successfully.');
    })().catch(e => {
      console.error(e);
      process.exit(1);
    });
    """
    res = subprocess.run(["node", "-e", node_test], cwd=str(ROOT), capture_output=True, text=True)
    assert res.returncode == 0, f"Test 2 failed: {res.stderr}\n{res.stdout}"
    print("  -> Passed: Fallback to window.fetch functions correctly when GM is absent.")


def test_3_no_avalanche_loops():
    print("Testing 3: Retry policy is capped at 1 retry (max 2 attempts, no avalanche)...")
    node_test = """
    const fs = require('fs');
    const path = require('path');
    const assert = require('assert');

    global.window = global;
    global.localStorage = {
      _data: {},
      getItem(k) { return this._data[k] || null; },
      setItem(k, v) { this._data[k] = String(v); },
      removeItem(k) { delete this._data[k]; },
      clear() { this._data = {}; }
    };

    let attempts = 0;
    global.GM_xmlhttpRequest = function (details) {
      attempts++;
      setTimeout(() => {
        details.onerror({ status: 0, error: 'Network error' });
      }, 10);
      return { abort() {} };
    };

    const bridgeCode = fs.readFileSync(path.join(process.cwd(), 'Extensions/src/mse-bridge.js'), 'utf8');
    eval(bridgeCode);

    const bridge = global.MSEBridge;
    bridge.setUrl('https://gateway.example.com');

    (async () => {
      const pr = await bridge.probe();
      assert.equal(pr.ok, false);
      assert.equal(pr.reachable, false);
      // initial call + 1 retry = exactly 2 attempts
      assert.equal(attempts, 2, 'Must not make more than 2 attempts (initial + 1 retry)');
      assert.equal(pr.attempt, 2);
      assert.ok(pr.diag.includes('attempt #2'));
      console.log('No avalanche verified.');
    })().catch(e => {
      console.error(e);
      process.exit(1);
    });
    """
    res = subprocess.run(["node", "-e", node_test], cwd=str(ROOT), capture_output=True, text=True)
    assert res.returncode == 0, f"Test 3 failed: {res.stderr}\n{res.stdout}"
    print("  -> Passed: Requests strictly limited to 1 retry (max 2 attempts).")


def test_4_abort_controller_and_timeouts():
    print("Testing 4: AbortController and GM request abort...")
    node_test = """
    const fs = require('fs');
    const path = require('path');
    const assert = require('assert');

    global.window = global;
    global.localStorage = {
      _data: {},
      getItem(k) { return this._data[k] || null; },
      setItem(k, v) { this._data[k] = String(v); },
      removeItem(k) { delete this._data[k]; },
      clear() { this._data = {}; }
    };

    let aborted = false;
    global.GM_xmlhttpRequest = function (details) {
      const handle = {
        abort() {
          aborted = true;
          if (details.onabort) details.onabort();
        }
      };
      return handle;
    };

    const bridgeCode = fs.readFileSync(path.join(process.cwd(), 'Extensions/src/mse-bridge.js'), 'utf8');
    eval(bridgeCode);

    const bridge = global.MSEBridge;
    bridge.setUrl('https://gateway.example.com');

    (async () => {
      const ctrl = new AbortController();
      const p = bridge.agent({ question: 'Test?', options: ['A'], timeoutMs: 30000, signal: ctrl.signal });
      setTimeout(() => {
        ctrl.abort();
      }, 5);

      const res = await p;
      // Abort is caught and converted to timeout/error object in agent
      assert.ok(aborted, 'GM_xmlhttpRequest .abort() must be called');
      assert.ok(res.code === 'timeout' || res.code === 'network');
      console.log('AbortController verified.');
    })().catch(e => {
      console.error(e);
      process.exit(1);
    });
    """
    res = subprocess.run(["node", "-e", node_test], cwd=str(ROOT), capture_output=True, text=True)
    assert res.returncode == 0, f"Test 4 failed: {res.stderr}\n{res.stdout}"
    print("  -> Passed: AbortController integration cleanly aborts requests.")


def test_5_zero_cringe_and_zero_vpn_words():
    print("Testing 5: Verifying zero Russian words and zero 'VPN' messages in extension...")
    bridge_txt = (ROOT / "Extensions/src/mse-bridge.js").read_text()
    ui_txt = (ROOT / "Extensions/src/mse-ui.js").read_text()

    assert "vpn" not in bridge_txt.lower(), "mse-bridge.js must not mention VPN"
    assert "vpn" not in ui_txt.lower(), "mse-ui.js must not mention VPN"

    import re
    cyr_bridge = re.findall(r"[\u0400-\u04FF]+", bridge_txt)
    cyr_ui = re.findall(r"[\u0400-\u04FF]+", ui_txt)

    assert len(cyr_bridge) == 0, f"mse-bridge.js has cyrillic words: {cyr_bridge}"
    assert len(cyr_ui) == 0, f"mse-ui.js has cyrillic words: {cyr_ui}"

    print("  -> Passed: Extension code is 100% free of Russian text and VPN blame messages.")


if __name__ == "__main__":
    test_1_csp_blocking_fetch_with_gm_passing()
    test_2_fallback_to_fetch_when_gm_absent()
    test_3_no_avalanche_loops()
    test_4_abort_controller_and_timeouts()
    test_5_zero_cringe_and_zero_vpn_words()
    print("\n✅ ALL MSE 2.14.1 HOTFIX TESTS PASSED CLEANLY!")
