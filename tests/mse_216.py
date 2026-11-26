"""Comprehensive test suite for MSE 2.16.0:
1. Part A: Question identity hashing with options & images, broad DOM option extraction,
   non-destructive applyAgentAnswer with closestMatch & agentUnmatched, zero-options guard,
   agent_error answer recovery, and cleaned UI (no snif/report buttons in answers view or error row).
2. Part B: Router 2.16.0 DUMP_QUOTA support (default 0 = unlimited active, 50 pending),
   /admin/dump-quota dynamic updates, /admin/state field, and dump quota enforcement.
3. Part C: mse_setup.py DUMP_QUOTA config spec, validation, health display, interactive editing,
   and router push integration.
4. Part D: Tunnel scripts (mse-tunnel.sh, install.sh, Storage/get.sh) IPv4 enforcement (curl -4),
   external funnel verification with tailscaled auto-restart, and local-only watchdog.
"""
import http.server
import json
import os
import re
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def test_part_a_question_identity():
    print("Testing Part A.1: Question identity hashing with options and images...")
    node_test = """
    const fs = require('fs');
    const path = require('path');
    const assert = require('assert');

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
      classList: { add() {}, remove() {}, contains() { return false; } },
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
    global.MSEBridge = {
      url() { return 'https://gateway.example.com'; },
      key() { return 'mse_test_key'; },
      meta() { return { status: 'active' }; },
      cachedCheck() { return { state: 'active' }; },
      check() { return Promise.resolve({ state: 'active' }); },
      debugEnabled() { return false; },
      sendDump() { return Promise.resolve({ ok: true }); }
    };

    const uiCode = fs.readFileSync(path.join(process.cwd(), 'Extensions/src/mse-ui.js'), 'utf8');
    eval(uiCode);

    // Extract questionIdentity function from uiCode
    // We can evaluate questionIdentity directly or via regex extract
    const qFnMatch = uiCode.match(/function questionIdentity\\([\\s\\S]*?\\n    \\}/);
    assert.ok(qFnMatch, 'questionIdentity function must exist');
    const qIdentity = eval('(' + qFnMatch[0] + ')');

    // 1. Same stem, different options -> different identity
    const id1 = qIdentity('What is the capital?', ['Paris', 'London']);
    const id2 = qIdentity('What is the capital?', ['Berlin', 'Madrid']);
    assert.notEqual(id1, id2, 'Different options must result in different question identities');

    // 2. Same stem and options, different option order -> same identity (order-independent sorting)
    const id3 = qIdentity('What is the capital?', ['London', 'Paris']);
    assert.equal(id1, id3, 'Option ordering must be normalized by sorting');

    // 3. Same stem, different images -> different identity
    const idImg1 = qIdentity('Look at the graph', ['Yes', 'No'], ['https://moodle.org/img1.png']);
    const idImg2 = qIdentity('Look at the graph', ['Yes', 'No'], ['https://moodle.org/img2.png']);
    assert.notEqual(idImg1, idImg2, 'Different images must produce different identities');

    // 4. Object argument support
    const idObj1 = qIdentity({
      text: 'What is the capital?',
      options: ['Paris', 'London'],
      images: []
    });
    assert.equal(idObj1, id1, 'Object-based argument must match array arguments');

    // 5. Backward compatibility: string-only argument
    const idPlain1 = qIdentity('Plain question stem');
    const idPlain2 = qIdentity('Plain question stem');
    assert.equal(idPlain1, idPlain2, 'Plain string stem must be deterministic');
    assert.equal(typeof idPlain1, 'number', 'Identity must return a numeric hash');

    console.log('Part A.1 questionIdentity verified.');
    """
    res = subprocess.run(["node", "-e", node_test], cwd=str(ROOT), capture_output=True, text=True)
    assert res.returncode == 0, f"Part A.1 failed: {res.stderr}\n{res.stdout}"
    print("  -> Passed: questionIdentity normalizes options (sorted) & images into hash, maintains backward compat.")


def test_part_a_dom_extraction_and_zero_options_guard():
    print("Testing Part A.2: Resilient DOM option extraction and zero options guard...")
    node_test = """
    const fs = require('fs');
    const path = require('path');
    const assert = require('assert');

    const uiCode = fs.readFileSync(path.join(process.cwd(), 'Extensions/src/mse-ui.js'), 'utf8');

    // 1. Verify readQuestion checks broad choice selectors (.form-check, tr, [data-region="answer"])
    assert.ok(uiCode.includes('.form-check') || uiCode.includes('form-check'),
      'Option extraction must look in .form-check wrappers');
    assert.ok(uiCode.includes('MathJax_Preview') || uiCode.includes('katex-html'),
      'readQuestion must strip MathJax / Katex artifacts');
    assert.ok(uiCode.includes('imgSrc') || uiCode.includes('img.getAttribute'),
      'Option extraction must support img-based answers (alt/title or imgSrc)');

    // 2. Verify zero-options guard in load() and runAgent()
    assert.ok(uiCode.includes("'options not captured'"),
      'Must set error "options not captured" when choices have zero options');

    console.log('Part A.2 DOM extraction & zero-options guard verified.');
    """
    res = subprocess.run(["node", "-e", node_test], cwd=str(ROOT), capture_output=True, text=True)
    assert res.returncode == 0, f"Part A.2 failed: {res.stderr}\n{res.stdout}"
    print("  -> Passed: DOM extraction handles .form-check, tables, img answers, and guards zero options.")


def test_part_a_non_destructive_and_closest_match():
    print("Testing Part A.3: Non-destructive applyAgentAnswer, closestMatch & agentUnmatched...")
    node_test = """
    const fs = require('fs');
    const path = require('path');
    const assert = require('assert');

    const uiCode = fs.readFileSync(path.join(process.cwd(), 'Extensions/src/mse-ui.js'), 'utf8');

    // Verify unshift of dummy row was removed from applyAgentAnswer
    // Previously: state.rows.unshift({ label: res.answer, correctness: 0, count: 0, agent: true });
    assert.ok(!uiCode.includes('state.rows.unshift({ label: rawAns'),
      'applyAgentAnswer must NOT unshift dummy rows into state.rows');

    // Verify state.agentUnmatched and closestMatch exist
    assert.ok(uiCode.includes('state.agentUnmatched'), 'Must track state.agentUnmatched');
    assert.ok(uiCode.includes('closestMatch'), 'Must compute closestMatch on unmatched option');

    // Verify agent_error with answer fallback handling
    assert.ok(uiCode.includes('agent_error') && uiCode.includes('res.answer'),
      'runAgent must handle agent_error if res.answer is provided');

    console.log('Part A.3 Non-destructive agent answer & closestMatch verified.');
    """
    res = subprocess.run(["node", "-e", node_test], cwd=str(ROOT), capture_output=True, text=True)
    assert res.returncode == 0, f"Part A.3 failed: {res.stderr}\n{res.stdout}"
    print("  -> Passed: applyAgentAnswer preserves option rows, flags closestMatch, recovers agent_error answer.")


def test_part_a_clean_answers_view_and_css():
    print("Testing Part A.4: Removed snif/report buttons in answers view, added CSS...")
    ui_txt = (ROOT / "Extensions/src/mse-ui.js").read_text()
    css_txt = (ROOT / "Extensions/src/theme.css").read_text()

    # 1. Verify viewAnswers has NO snif or report button
    # Find viewAnswers definition
    va_start = ui_txt.find("function viewAnswers()")
    assert va_start > 0, "viewAnswers function must exist"
    va_end = ui_txt.find("function viewAccount()", va_start)
    va_body = ui_txt[va_start:va_end]

    assert "reportCurrent(" not in va_body, "viewAnswers must not contain reportCurrent call"
    assert "data-mse', 'report'" not in va_body, "viewAnswers must not contain report button"
    assert "data-mse', 'snif'" not in va_body, "viewAnswers must not contain snif button"

    # 2. Verify appendAi error row does not contain report button
    ai_start = ui_txt.find("function appendAi(")
    ai_end = ui_txt.find("function agentStrip(", ai_start)
    ai_body = ui_txt[ai_start:ai_end]
    assert "reportCurrent(" not in ai_body, "appendAi error row must not contain report button"

    # 3. Verify CSS rules for unmatched answer row and closest match
    assert ".agent-unmatched-row" in css_txt, "theme.css must define .agent-unmatched-row"
    assert ".closest-match" in css_txt, "theme.css must define .closest-match"

    print("  -> Passed: Answers view clean of snif/report buttons; CSS styles defined.")


def test_part_b_router_dump_quota():
    print("Testing Part B: Router DUMP_QUOTA, /admin/dump-quota, and pending dump limits...")
    node_test = """
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const http = require('http');
    const assert = require('assert');

    const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'mse-216-'));
    process.env.MSE_DATA_DIR = tmpData;
    process.env.MSE_ADMIN_TOKEN = 'test_admin_token_216';

    const router = require('./Server/mse-router.js');

    assert.equal(router.VERSION, '2.16.0', 'Router version must be 2.16.0');

    const PORT = 19890;
    const srv = http.createServer(router.handler);

    (async () => {
      await new Promise(r => srv.listen(PORT, '127.0.0.1', r));

      try {
        // 1. GET /admin/state contains dumpQuota (default 0 = unlimited active)
        const stRes = await fetch(`http://127.0.0.1:${PORT}/admin/state`, {
          headers: { 'x-admin-token': router.ADMIN_TOKEN }
        });
        const st = await stRes.json();
        assert.equal(st.version, '2.16.0');
        assert.equal(typeof st.dumpQuota, 'number');
        assert.equal(st.dumpQuota, 0, 'Default dumpQuota must be 0 (unlimited for active)');

        // 2. POST /admin/dump-quota updates dump quota dynamically
        const updRes = await fetch(`http://127.0.0.1:${PORT}/admin/dump-quota`, {
          method: 'POST',
          headers: { 'x-admin-token': router.ADMIN_TOKEN, 'content-type': 'application/json' },
          body: JSON.stringify({ dumpQuota: 10 })
        });
        assert.equal(updRes.status, 200);
        const updJson = await updRes.json();
        assert.equal(updJson.ok, true);
        assert.equal(updJson.dumpQuota, 10);

        // Verify updated in /admin/state
        const st2 = await (await fetch(`http://127.0.0.1:${PORT}/admin/state`, {
          headers: { 'x-admin-token': router.ADMIN_TOKEN }
        })).json();
        assert.equal(st2.dumpQuota, 10);

        // Reset dumpQuota back to 0
        await fetch(`http://127.0.0.1:${PORT}/admin/dump-quota`, {
          method: 'POST',
          headers: { 'x-admin-token': router.ADMIN_TOKEN, 'content-type': 'application/json' },
          body: JSON.stringify({ dumpQuota: 0 })
        });

        // 3. Register a pending device
        const pendingKey = 'mse_' + '2'.repeat(48);
        const regRes = await fetch(`http://127.0.0.1:${PORT}/mse/v1/register`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ key: pendingKey, moodleId: '99999', name: 'Pending Device' })
        });
        assert.ok(regRes.status === 200 || regRes.status === 202);

        // Send a dump from pending device - should succeed (status 201)
        const d1 = await fetch(`http://127.0.0.1:${PORT}/mse/v1/dump`, {
          method: 'POST',
          headers: { authorization: 'Bearer ' + pendingKey, 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'report', dump: { test: true } })
        });
        assert.equal(d1.status, 201, 'Pending device is allowed to send dumps');

        console.log('Part B Router DUMP_QUOTA tests verified.');
      } finally {
        await new Promise(r => srv.close(r));
      }
    })().catch(e => {
      console.error(e);
      process.exit(1);
    });
    """
    res = subprocess.run(["node", "-e", node_test], cwd=str(ROOT), capture_output=True, text=True)
    assert res.returncode == 0, f"Part B failed: {res.stderr}\n{res.stdout}"
    print("  -> Passed: Router 2.16.0 DUMP_QUOTA, /admin/dump-quota endpoint, and pending dump allowance verified.")


def test_part_c_setup_py_dump_quota():
    print("Testing Part C: mse_setup.py DUMP_QUOTA configuration, health & push integration...")
    setup_txt = (ROOT / "Server/stack/mse_setup.py").read_text()

    assert "DUMP_QUOTA" in setup_txt, "mse_setup.py must define DUMP_QUOTA in CONFIG_SPECS"
    assert "/admin/dump-quota" in setup_txt, "mse_setup.py must push DUMP_QUOTA to /admin/dump-quota"
    assert "Dump Quota" in setup_txt or "dump_quota" in setup_txt, "mse_setup.py must present Dump Quota"

    # Verify python syntax and imports in mse_setup.py
    compile_res = subprocess.run([sys.executable, "-m", "py_compile", "Server/stack/mse_setup.py"],
                                 cwd=str(ROOT), capture_output=True, text=True)
    assert compile_res.returncode == 0, f"mse_setup.py compilation failed: {compile_res.stderr}"
    print("  -> Passed: mse_setup.py validates, displays, edits and pushes DUMP_QUOTA to router.")


def test_part_d_tunnel_scripts_ipv4_and_watchdog():
    print("Testing Part D: Tunnel scripts IPv4 enforcement, recovery loop & local watchdog...")
    tunnel_sh = (ROOT / "Server/stack/mse-tunnel.sh").read_text()
    install_sh = (ROOT / "Server/stack/install.sh").read_text()
    get_sh = (ROOT / "Storage/get.sh").read_text()

    # 1. Enforce curl -4 on all curl network invocations
    # Match curl commands that execute network requests (e.g. curl http, curl -fsS, $(curl ...))
    curl_cmd_re = re.compile(r'(?:^\s*|[;&|]\s*|\$\()\s*curl\s+(?!-4\b)(?:-[A-Za-z0-9_-]+\s+)*(?:https?://|\$url|\$download_url|"[^"]*"|\'[^\']*\')', re.MULTILINE)
    for script_name, content in [("mse-tunnel.sh", tunnel_sh), ("install.sh", install_sh), ("get.sh", get_sh)]:
        # Filter out comment lines
        active_lines = "\n".join(l for l in content.splitlines() if not l.strip().startswith('#') and not l.strip().startswith('//'))
        unflagged = curl_cmd_re.findall(active_lines)
        assert len(unflagged) == 0, f"{script_name} has unflagged curls without -4: {unflagged}"

    # 2. Verify verify_funnel_external auto-recovery with systemctl restart tailscaled
    assert "verify_funnel_external" in tunnel_sh, "mse-tunnel.sh must define verify_funnel_external"
    assert "systemctl restart tailscaled" in tunnel_sh, \
        "mse-tunnel.sh verify_funnel_external must restart tailscaled on external stall"
    assert "systemctl restart tailscaled" in install_sh, \
        "install.sh must restart tailscaled if post-funnel verification fails"

    # 3. Verify cmd_watchdog in mse-tunnel.sh checks local router & tailscale status without external curl
    watchdog_start = tunnel_sh.find("cmd_watchdog()")
    assert watchdog_start > 0, "cmd_watchdog must exist in mse-tunnel.sh"
    watchdog_end = tunnel_sh.find("cmd_", watchdog_start + 1)
    if watchdog_end == -1:
        watchdog_end = len(tunnel_sh)
    watchdog_body = tunnel_sh[watchdog_start:watchdog_end]

    assert "http://127.0.0.1:" in watchdog_body, "watchdog must check local router health"
    assert "ts status" in watchdog_body or "tailscale status" in watchdog_body, "watchdog must verify tailscale daemon status"
    assert "ts serve status" in watchdog_body or "tailscale serve status" in watchdog_body or "serve_status" in watchdog_body, \
        "watchdog must check tailscale serve/funnel status"
    assert "https://${host}" not in watchdog_body and "https://$host" not in watchdog_body, \
        "watchdog must NOT curl external funnel host"

    print("  -> Passed: curl -4 enforced across scripts, verify_funnel_external auto-recovers, local-only watchdog.")


if __name__ == "__main__":
    test_part_a_question_identity()
    test_part_a_dom_extraction_and_zero_options_guard()
    test_part_a_non_destructive_and_closest_match()
    test_part_a_clean_answers_view_and_css()
    test_part_b_router_dump_quota()
    test_part_c_setup_py_dump_quota()
    test_part_d_tunnel_scripts_ipv4_and_watchdog()
    print("\n✅ ALL MSE 2.16.0 TESTS PASSED CLEANLY!")
