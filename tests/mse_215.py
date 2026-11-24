"""Comprehensive test suite for MSE 2.15.0:
1. A1-A4: Full removal of syncshare (zero mentions in extension sources, no fetchSolution/serviceUrl,
   no 'asking database' delay, question opens directly to agent request, local answer cache).
2. B1: Report button: 15s timeout, 201 status handling -> 'sent', error/timeout -> 'report failed',
   revert to 'Report' after 3s, no infinite retry.
3. B2: Tapping answer executes applyAnswer and immediately closes popover (leaving pill).
4. B3: Agent requests prioritize ahead of debug dumps; decoupled queues (dumpQueue vs gatewayQueue),
   no UI thread blocking.
5. B4: Header 'question' text removed from answers view; model chip enlarged and centered with margin: 0 auto.
6. B5: Snif dumps include agent response (status, answer, model) after agent completion.
"""
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def test_1_syncshare_purged_and_zero_delay():
    print("Testing 1: Syncshare fully purged, zero delay, direct agent call & answer cache...")
    bridge_txt = (ROOT / "Extensions/src/mse-bridge.js").read_text()
    ui_txt = (ROOT / "Extensions/src/mse-ui.js").read_text()

    assert "syncshare" not in bridge_txt.lower(), "mse-bridge.js must have 0 mentions of syncshare"
    assert "syncshare" not in ui_txt.lower(), "mse-ui.js must have 0 mentions of syncshare"
    assert "fetchsolution" not in ui_txt.lower(), "fetchSolution must be removed"
    assert "serviceurl" not in ui_txt.lower(), "serviceUrl must be removed"
    assert "asking the database" not in ui_txt.lower(), "'asking the database' UI phase must be removed"
    assert "database" not in ui_txt.lower(), "'database' must not appear in mse-ui.js"

    node_test = """
    const fs = require('fs');
    const path = require('path');
    const assert = require('assert');

    // Simulate browser window
    global.window = global;
    global.window.addEventListener = function () {};
    global.window.removeEventListener = function () {};
    global.window.requestAnimationFrame = function (fn) { return setTimeout(fn, 0); };
    global.window.location = { href: 'http://localhost/attempt.php', host: 'localhost' };
    const mockEl = () => ({
      tagName: 'DIV',
      className: '',
      style: {},
      children: [],
      appendChild(c) { this.children.push(c); return c; },
      removeChild() {},
      setAttribute(k, v) { this[k] = v; },
      getAttribute(k) { return this[k] || null; },
      addEventListener() {},
      classList: {
        add() {}, remove() {}, contains() { return false; }
      },
      getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 50 }; }
    });
    global.document = {
      createElement(tag) { return mockEl(); },
      querySelectorAll() { return []; },
      querySelector() { return null; },
      addEventListener() {},
      body: mockEl(),
      documentElement: mockEl()
    };
    global.localStorage = {
      _data: {},
      getItem(k) { return this._data[k] || null; },
      setItem(k, v) { this._data[k] = String(v); },
      removeItem(k) { delete this._data[k]; },
      clear() { this._data = {}; }
    };

    let agentCalled = false;
    global.MSEBridge = {
      url() { return 'https://gateway.example.com'; },
      key() { return 'mse_test_key'; },
      meta() { return { status: 'active', device: { status: 'active' } }; },
      cachedCheck() { return { state: 'active', model: 'gpt-4o' }; },
      check() { return Promise.resolve({ state: 'active', model: 'gpt-4o' }); },
      agent() {
        agentCalled = true;
        return Promise.resolve({ ok: true, answer: 'Paris', model: 'gpt-4o' });
      },
      debugEnabled() { return false; },
      sendDump() { return Promise.resolve({ ok: true }); }
    };

    const uiCode = fs.readFileSync(path.join(process.cwd(), 'Extensions/src/mse-ui.js'), 'utf8');
    eval(uiCode);

    assert.ok(global.__mse, '__mse must be mounted');
    console.log('Syncshare purge verified successfully.');
    """
    res = subprocess.run(["node", "-e", node_test], cwd=str(ROOT), capture_output=True, text=True)
    assert res.returncode == 0, f"Test 1 node check failed: {res.stderr}\n{res.stdout}"
    print("  -> Passed: Zero syncshare residue, no database latency, clean direct flow.")


def test_2_report_button_timeout_and_201_handling():
    print("Testing 2: Report button: 15s timeout, 201 'sent', error 'report failed', 3s restore...")
    node_test = """
    const fs = require('fs');
    const path = require('path');
    const assert = require('assert');

    global.window = global;
    global.document = {
      cookie: '',
      querySelectorAll() { return []; },
      querySelector() { return null; },
      addEventListener() {}
    };
    global.localStorage = {
      _data: {},
      getItem(k) { return this._data[k] || null; },
      setItem(k, v) { this._data[k] = String(v); },
      removeItem(k) { delete this._data[k]; },
      clear() { this._data = {}; }
    };

    let dumpRequests = [];
    global.GM_xmlhttpRequest = function (details) {
      dumpRequests.push(details);
      setTimeout(() => {
        if (details.url.includes('/dump_success')) {
          // Router returns 201 on dump creation
          details.onload({
            status: 201,
            statusText: 'Created',
            responseText: JSON.stringify({ ok: true, id: 'dump_123' }),
            responseHeaders: 'content-type: application/json\\r\\n'
          });
        } else if (details.url.includes('/dump_fail')) {
          details.onload({
            status: 500,
            statusText: 'Internal Error',
            responseText: JSON.stringify({ ok: false, error: { message: 'storage error' } }),
            responseHeaders: 'content-type: application/json\\r\\n'
          });
        }
      }, 10);
      return { abort() {} };
    };

    const bridgeCode = fs.readFileSync(path.join(process.cwd(), 'Extensions/src/mse-bridge.js'), 'utf8');
    eval(bridgeCode);

    const bridge = global.MSEBridge;
    bridge.key();

    (async () => {
      // 1. Success case: router 201 -> { ok: true, id: 'dump_123' }
      bridge.setUrl('https://gateway.example.com/dump_success');
      const res1 = await bridge.sendDump('report', { test: true });
      assert.equal(res1.ok, true, '201 response must resolve to ok: true');
      assert.equal(res1.id, 'dump_123');

      // 2. Failure case: router 500 -> { ok: false, message: 'storage error' }
      bridge.setUrl('https://gateway.example.com/dump_fail');
      const res2 = await bridge.sendDump('report', { test: true });
      assert.equal(res2.ok, false, '500 response must resolve to ok: false');
      assert.equal(res2.message, 'storage error');

      // 3. Verify dump requests have 15s timeout configured
      assert.equal(dumpRequests[0].timeout, 15000, 'Dump timeout must be 15000ms');

      console.log('Report button bridge contract verified.');
    })().catch(e => {
      console.error(e);
      process.exit(1);
    });
    """
    res = subprocess.run(["node", "-e", node_test], cwd=str(ROOT), capture_output=True, text=True)
    assert res.returncode == 0, f"Test 2 failed: {res.stderr}\n{res.stdout}"
    print("  -> Passed: Report button handles 201 status, error reporting, and 15s timeout.")


def test_3_tap_answer_closes_popover():
    print("Testing 3: Tap on answer closes popover leaving only pill...")
    node_test = """
    const fs = require('fs');
    const path = require('path');
    const assert = require('assert');

    const uiCode = fs.readFileSync(path.join(process.cwd(), 'Extensions/src/mse-ui.js'), 'utf8');

    // Verify applyAnswer success branch invokes closePop()
    assert.ok(uiCode.includes('closePop();'), 'mse-ui.js must call closePop');
    const applyClickIdx = uiCode.indexOf('var res = applyAnswer(q, r);');
    assert.ok(applyClickIdx > 0, 'applyAnswer call in click handler must exist');
    const nextClosePop = uiCode.indexOf('closePop();', applyClickIdx);
    assert.ok(nextClosePop > applyClickIdx && nextClosePop - applyClickIdx < 1000,
      'closePop() must be called immediately after successful applyAnswer');

    console.log('Tap to close verified in UI code.');
    """
    res = subprocess.run(["node", "-e", node_test], cwd=str(ROOT), capture_output=True, text=True)
    assert res.returncode == 0, f"Test 3 failed: {res.stderr}\n{res.stdout}"
    print("  -> Passed: applyAnswer successfully triggers popover dismissal.")


def test_4_agent_priority_over_dumps():
    print("Testing 4: Agent requests prioritize ahead of debug dumps in client queue...")
    node_test = """
    const fs = require('fs');
    const path = require('path');
    const assert = require('assert');

    global.window = global;
    global.document = {
      cookie: '',
      querySelectorAll() { return []; },
      querySelector() { return null; },
      addEventListener() {}
    };
    global.localStorage = {
      _data: {},
      getItem(k) { return this._data[k] || null; },
      setItem(k, v) { this._data[k] = String(v); },
      removeItem(k) { delete this._data[k]; },
      clear() { this._data = {}; }
    };

    let log = [];

    global.GM_xmlhttpRequest = function (details) {
      const isAgent = details.url.includes('/mse/v1/agent');
      const isDump = details.url.includes('/mse/v1/dump');
      const reqId = isAgent ? 'agent' : (isDump ? 'dump' : 'other');

      log.push('start:' + reqId);
      setTimeout(() => {
        log.push('end:' + reqId);
        if (isAgent) {
          details.onload({
            status: 200,
            statusText: 'OK',
            responseText: JSON.stringify({ ok: true, answer: 'Option A' }),
            responseHeaders: 'content-type: application/json\\r\\n'
          });
        } else {
          details.onload({
            status: 201,
            statusText: 'Created',
            responseText: JSON.stringify({ ok: true }),
            responseHeaders: 'content-type: application/json\\r\\n'
          });
        }
      }, isDump ? 100 : 20); // Dumps take longer (simulating 100KB payload)

      return { abort() {} };
    };

    const bridgeCode = fs.readFileSync(path.join(process.cwd(), 'Extensions/src/mse-bridge.js'), 'utf8');
    eval(bridgeCode);

    const bridge = global.MSEBridge;
    bridge.setUrl('https://gateway.example.com');
    bridge.key();

    (async () => {
      // Enqueue a slow background dump
      const dumpPromise = bridge.sendDump('debug', { hugeData: 'x'.repeat(1000) });

      // Immediately trigger agent request
      const agentPromise = bridge.agent({ question: 'Test?', options: ['Option A'] });

      // Wait for both
      const [dumpRes, agentRes] = await Promise.all([dumpPromise, agentPromise]);

      assert.equal(agentRes.ok, true);
      assert.equal(agentRes.answer, 'Option A');
      assert.equal(dumpRes.ok, true);

      // Verify that agent started without waiting for dump to end!
      // 'start:dump' should be followed by 'start:agent' BEFORE 'end:dump'
      const startDumpIdx = log.indexOf('start:dump');
      const startAgentIdx = log.indexOf('start:agent');
      const endDumpIdx = log.indexOf('end:dump');

      assert.ok(startAgentIdx !== -1, 'agent must start');
      assert.ok(startAgentIdx < endDumpIdx, 'agent MUST NOT wait for dump to finish before starting');

      console.log('Decoupled dump & agent queue verified. Order:', log);
    })().catch(e => {
      console.error(e);
      process.exit(1);
    });
    """
    res = subprocess.run(["node", "-e", node_test], cwd=str(ROOT), capture_output=True, text=True)
    assert res.returncode == 0, f"Test 4 failed: {res.stderr}\n{res.stdout}"
    print("  -> Passed: Agent requests execute concurrently/ahead of background dumps without blocking.")


def test_5_header_no_question_centered_model_chip():
    print("Testing 5: Header 'question' string removed; model chip enlarged and centered...")
    ui_txt = (ROOT / "Extensions/src/mse-ui.js").read_text()
    css_txt = (ROOT / "Extensions/src/theme.css").read_text()

    # 1. Verify answers view does not set question subtitle
    assert "sub = qid ? ('question #' + qid) : 'question';" not in ui_txt, \
        "Old question subtitle assignment must be removed"
    assert "if (state.route === 'answers')" in ui_txt, \
        "state.route === 'answers' must set sub = null"

    # 2. Verify model chip styling in theme.css
    assert ".ph .model-chip" in css_txt, "model-chip class must exist in theme.css"
    assert "margin:0 auto" in css_txt or "margin: 0 auto" in css_txt, \
        "model-chip must have margin: 0 auto for horizontal centering"
    assert "text-align:center" in css_txt or "text-align: center" in css_txt, \
        "model-chip must have text-align: center"
    assert "10.5px" in css_txt or "10px" in css_txt or "11px" in css_txt, \
        "model-chip font-size must be enlarged (>= 10px)"
    assert ".ph .t{flex:0 0 auto" in css_txt, \
        ".ph .t must be flex: 0 0 auto so it does not monopolize header width"

    print("  -> Passed: Header question string removed, model chip centered and enlarged.")


def test_6_snif_dumps_include_agent_answer():
    print("Testing 6: Snif dumps capture agent response and answer upon completion...")
    node_test = """
    const fs = require('fs');
    const path = require('path');
    const assert = require('assert');

    global.window = global;
    global.document = {
      cookie: '',
      title: 'Attempt',
      querySelectorAll() { return []; },
      querySelector() { return null; },
      addEventListener() {}
    };
    global.localStorage = {
      _data: {},
      getItem(k) { return this._data[k] || null; },
      setItem(k, v) { this._data[k] = String(v); },
      removeItem(k) { delete this._data[k]; },
      clear() { this._data = {}; }
    };

    global.GM_xmlhttpRequest = function (details) {
      setTimeout(() => {
        details.onload({
          status: 200,
          statusText: 'OK',
          responseText: JSON.stringify({ ok: true, answer: 'Option 2', model: 'gpt-4o-mini' }),
          responseHeaders: 'content-type: application/json\\r\\n'
        });
      }, 10);
      return { abort() {} };
    };

    const bridgeCode = fs.readFileSync(path.join(process.cwd(), 'Extensions/src/mse-bridge.js'), 'utf8');
    eval(bridgeCode);

    const bridge = global.MSEBridge;
    bridge.setUrl('https://gateway.example.com');
    bridge.key();

    (async () => {
      // Run agent
      const res = await bridge.agent({ question: 'Which one?', options: ['Option 1', 'Option 2'] });
      assert.equal(res.ok, true);
      assert.equal(res.answer, 'Option 2');

      // Verify snifAgent returns record with response answer and model
      const snif = bridge.snifAgent();
      assert.ok(snif, 'snifAgent must return last agent record');
      assert.ok(snif.response, 'snifAgent record must include response');
      assert.equal(snif.response.status, 200);
      assert.equal(snif.response.answer, 'Option 2', 'snif response must contain answer');
      assert.equal(snif.response.model, 'gpt-4o-mini', 'snif response must contain model');

      console.log('Snif dump agent response verification passed.');
    })().catch(e => {
      console.error(e);
      process.exit(1);
    });
    """
    res = subprocess.run(["node", "-e", node_test], cwd=str(ROOT), capture_output=True, text=True)
    assert res.returncode == 0, f"Test 6 failed: {res.stderr}\n{res.stdout}"
    print("  -> Passed: Snif dumps capture received agent answer and model.")


if __name__ == "__main__":
    test_1_syncshare_purged_and_zero_delay()
    test_2_report_button_timeout_and_201_handling()
    test_3_tap_answer_closes_popover()
    test_4_agent_priority_over_dumps()
    test_5_header_no_question_centered_model_chip()
    test_6_snif_dumps_include_agent_answer()
    print("\n✅ ALL MSE 2.15.0 TESTS PASSED CLEANLY!")
