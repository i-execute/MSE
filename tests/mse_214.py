#!/usr/bin/env python3
"""Comprehensive test suite for MSE 2.14.0 features:
1. Port persistence across reinstall (preserving ports vs --new-ports)
2. Tunnel doctor diagnostics and log parsing (drops, TLS EOFs, port mismatch)
3. Auto-recovery watchdog (3 failures -> recovery + log to mse-router.log)
4. Cloudflared named tunnel configuration (token, custom domain, env/json state)
5. Client diagnostic on TypeError (gateway unreachable from this network, network log details, retry)
"""

import os
import sys
import json
import tempfile
import subprocess
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TUNNEL_SCRIPT = ROOT / "Server" / "stack" / "mse-tunnel.sh"
INSTALL_SCRIPT = ROOT / "Server" / "stack" / "install.sh"
BRIDGE_SRC = ROOT / "Extensions" / "src" / "mse-bridge.js"
UI_SRC = ROOT / "Extensions" / "src" / "mse-ui.js"


def test_1_port_preservation():
    print("Testing 1: Port preservation across reinstalls...")
    with tempfile.TemporaryDirectory() as td:
        tdp = Path(td)
        state_dir = tdp / "state"
        env_dir = tdp / "etc"
        state_dir.mkdir()
        env_dir.mkdir()

        state_file = state_dir / "state.json"
        env_file = env_dir / "mse.env"

        # Pre-seed state.json and mse.env with specific ports
        initial_router_port = 34567
        initial_upstream_port = 34568
        state_file.write_text(json.dumps({
            "settings": {
                "msePort": initial_router_port,
                "upstreamPort": initial_upstream_port
            }
        }))
        env_file.write_text(f"MSE_PORT={initial_router_port}\nMSE_UPSTREAM_PORT={initial_upstream_port}\n")

        # Run install.sh in dry-run mode without --new-ports
        test_env = {
            "PATH": os.environ["PATH"],
            "MSE_STATE_DIR": str(state_dir),
            "MSE_ENV_DIR": str(env_dir),
            "MSE_ENV_FILE": str(env_file),
            "MSE_BOT_TOKEN": "1234567890:AAH_test",
            "MSE_OWNER_ID": "12345678",
            "HOME": td
        }
        res = subprocess.run(
            ["bash", str(INSTALL_SCRIPT), "--dry-run", "--no-bot", "--no-tunnel"],
            env=test_env,
            capture_output=True,
            text=True
        )
        assert res.returncode == 0, f"install.sh dry-run failed: {res.stderr}\n{res.stdout}"
        assert f"reusing existing router port {initial_router_port}" in res.stdout, f"Expected reuse of router port in stdout, got:\n{res.stdout}"
        assert f"reusing existing backend port {initial_upstream_port}" in res.stdout, f"Expected reuse of backend port in stdout, got:\n{res.stdout}"

        # Now test with --new-ports flag
        res_new = subprocess.run(
            ["bash", str(INSTALL_SCRIPT), "--dry-run", "--no-bot", "--no-tunnel", "--new-ports"],
            env=test_env,
            capture_output=True,
            text=True
        )
        assert res_new.returncode == 0, f"install.sh --new-ports failed: {res_new.stderr}"
        assert "--new-ports specified, allocating fresh ports" in res_new.stdout, f"Expected fresh allocation message, got:\n{res_new.stdout}"
        assert "allocated router port" in res_new.stdout
        assert "allocated backend port" in res_new.stdout
    print("  -> Passed: Reinstall preserves ports; --new-ports allocates fresh ports.")


def test_2_tunnel_doctor():
    print("Testing 2: Tunnel doctor diagnostics and edge log parsing...")
    with tempfile.TemporaryDirectory() as td:
        tdp = Path(td)
        log_file = tdp / "tailscaled.log"
        log_sample = """
Nov 20 12:00:01 server tailscaled[100]: drop: in proto=tcp s=fd7a:115c:a1e0::1:443 d=192.0.2.1:29000: no rules matched
Nov 20 12:00:02 server tailscaled[100]: packet drop: drop: in proto=tcp s=fd7a:115c:a1e0::2:443 d=192.0.2.1:29000: no rules matched
Nov 20 12:00:03 server tailscaled[100]: 2026/11/20 12:00:03 TLS: EOF from fd7a:115c:a1e0::3:1234
Nov 20 12:00:04 server tailscaled[100]: normal traffic
"""
        log_file.write_text(log_sample)

        # Pre-seed tunnel.json with backend tailscale
        (tdp / "tunnel.json").write_text(json.dumps({
            "backend": "tailscale",
            "mode": "funnel",
            "url": "https://gateway.example.com",
            "port": 34851
        }))

        # Run doctor with --json flag
        res = subprocess.run(
            ["bash", str(TUNNEL_SCRIPT), "doctor", "--json", "--log-file", str(log_file)],
            env={
                "PATH": os.environ["PATH"],
                "MSE_STATE_DIR": td,
                "MSE_PORT": "34851",
                "MSE_PUBLIC_URL": "https://gateway.example.com"
            },
            capture_output=True,
            text=True
        )
        assert res.returncode == 0, f"doctor --json failed: {res.stderr}"
        report = json.loads(res.stdout)

        assert report["ok"] is False, "Expected ok=False due to edge drops"
        assert "ts.net-edge протух, сделай funnel reset" in report["verdict"]
        assert "no rules matched" in report["diagnosis"]
        assert report["checks"]["drops_count"] == 2
        assert report["checks"]["tls_eof_count"] == 1
        assert "sudo mse-tunnel.sh funnel-reset 34851" in report["command"]

        # Run doctor in human-readable mode
        res_hr = subprocess.run(
            ["bash", str(TUNNEL_SCRIPT), "doctor", "--log-file", str(log_file)],
            env={
                "PATH": os.environ["PATH"],
                "MSE_STATE_DIR": td,
                "MSE_PORT": "34851",
                "MSE_PUBLIC_URL": "https://gateway.example.com"
            },
            capture_output=True,
            text=True
        )
        assert "ts.net-edge протух, сделай funnel reset" in res_hr.stdout
        assert "sudo mse-tunnel.sh funnel-reset 34851" in res_hr.stdout
    print("  -> Passed: Tunnel doctor parses journal drops, reports edge failure and treatment command.")


def test_3_watchdog_auto_recovery():
    print("Testing 3: Watchdog auto-recovery on 3 consecutive failures...")
    with tempfile.TemporaryDirectory() as td:
        tdp = Path(td)
        state_file = tdp / "watchdog.json"
        router_log = tdp / "mse-router.log"
        env = {
            "PATH": os.environ["PATH"],
            "MSE_STATE_DIR": td,
            "MSE_PORT": "34851",
            "MSE_PUBLIC_URL": "http://127.0.0.1:9999",  # unrouted port -> health fail
            "MSE_CLOUDFLARED_BIN": "/bin/true",
            "MSE_TAILSCALE_BIN": "/bin/true"
        }

        # Iteration 1: failure 1
        subprocess.run(["bash", str(TUNNEL_SCRIPT), "watchdog", "--once"], env=env, check=True)
        st1 = json.loads(state_file.read_text())
        assert st1["failures"] == 1, f"Expected 1 failure, got {st1}"
        assert not router_log.exists()

        # Iteration 2: failure 2
        subprocess.run(["bash", str(TUNNEL_SCRIPT), "watchdog", "--once"], env=env, check=True)
        st2 = json.loads(state_file.read_text())
        assert st2["failures"] == 2, f"Expected 2 failures, got {st2}"
        assert not router_log.exists()

        # Iteration 3: failure 3 -> triggers recovery and logs to mse-router.log
        subprocess.run(["bash", str(TUNNEL_SCRIPT), "watchdog", "--once"], env=env, check=True)
        st3 = json.loads(state_file.read_text())
        assert st3["failures"] == 0, f"Expected failures reset to 0, got {st3}"
        assert st3["status"] == "recovered"
        assert router_log.exists(), "Expected mse-router.log to exist"
        log_content = router_log.read_text()
        assert "tunnel watchdog: recovered" in log_content, f"Expected recovery log, got:\n{log_content}"
    print("  -> Passed: Watchdog triggers recovery at 3 failures and appends to mse-router.log.")


def test_4_cloudflared_named_tunnel():
    print("Testing 4: Cloudflared named tunnel configuration...")
    with tempfile.TemporaryDirectory() as td:
        tdp = Path(td)
        env_file = tdp / "mse.env"
        env_file.write_text("MSE_PORT=34851\n")

        # Fake cloudflared binary that sleeps in background
        fake_cf = tdp / "fake-cloudflared"
        fake_cf.write_text("#!/bin/sh\nwhile true; do sleep 1; done\n")
        fake_cf.chmod(0o755)

        test_token = "eyJhIjoiYWJjZGVmZ2hpamsiLCJ0IjoidGVzdC11dWlkIiwicyI6InNlY3JldCJ9"
        test_domain = "https://gw.mycorp.example.com"

        res = subprocess.run(
            ["bash", str(TUNNEL_SCRIPT), "cloudflared-named", test_token, test_domain, "34851"],
            env={
                "PATH": os.environ["PATH"],
                "MSE_STATE_DIR": td,
                "MSE_ENV_FILE": str(env_file),
                "MSE_PORT": "34851",
                "MSE_CLOUDFLARED_BIN": str(fake_cf)
            },
            capture_output=True,
            text=True
        )
        assert res.returncode == 0, f"cloudflared-named failed: {res.stderr}"
        assert test_domain in res.stdout

        # Verify tunnel.json
        tunnel_json = json.loads((tdp / "tunnel.json").read_text())
        assert tunnel_json["backend"] == "cloudflared"
        assert tunnel_json["mode"] == "cloudflared-named"
        assert tunnel_json["url"] == test_domain
        assert tunnel_json["token"] == test_token

        # Verify mse.env was updated
        env_text = env_file.read_text()
        assert f"MSE_PUBLIC_URL={test_domain}" in env_text
        assert f"MSE_CF_TOKEN={test_token}" in env_text

        # Verify status --json reflects named tunnel
        res_st = subprocess.run(
            ["bash", str(TUNNEL_SCRIPT), "status", "--json"],
            env={
                "PATH": os.environ["PATH"],
                "MSE_STATE_DIR": td,
                "MSE_ENV_FILE": str(env_file),
                "MSE_PORT": "34851",
                "MSE_CLOUDFLARED_BIN": str(fake_cf)
            },
            capture_output=True,
            text=True
        )
        st = json.loads(res_st.stdout)
        assert st["backend"] == "cloudflared"
        assert st["mode"] == "cloudflared-named"
        assert st["url"] == test_domain

        # Kill any lingering fake process
        subprocess.run(["bash", str(TUNNEL_SCRIPT), "cloudflared-off"], env={"MSE_STATE_DIR": td, "MSE_PORT": "34851"}, capture_output=True)
    print("  -> Passed: Cloudflared named tunnel configures permanently, updates state and env.")


def test_5_client_diagnostics():
    print("Testing 5: Client diagnostics on TypeError instead of Load failed...")
    # Run a node snippet that simulates fetch failure with TypeError and checks MSEBridge.check() & probe()
    node_test = """
    const fs = require('fs');
    const path = require('path');
    const assert = require('assert');

    // Setup browser mocks
    global.window = global;
    global.localStorage = {
      _data: {},
      getItem(k) { return this._data[k] || null; },
      setItem(k, v) { this._data[k] = String(v); },
      removeItem(k) { delete this._data[k]; }
    };

    let fetchCount = 0;
    global.fetch = async function (url, opts) {
      fetchCount++;
      // Throw TypeError ('Load failed') as Safari does when VPN/network blocks request
      const err = new TypeError('Load failed');
      throw err;
    };

    const bridgeCode = fs.readFileSync(path.join(process.cwd(), 'Extensions/src/mse-bridge.js'), 'utf8');
    eval(bridgeCode);

    const bridge = global.MSEBridge;
    bridge.setUrl('https://mygw.example.com');

    (async () => {
      // 1. probe() check
      const pr = await bridge.probe();
      assert.equal(pr.ok, false);
      assert.equal(pr.reachable, false);
      assert.equal(pr.netError, true);
      assert.equal(pr.message, 'gateway unreachable');
      assert.ok(pr.diag && pr.diag.includes('transport:'));

      // 2. check() check
      const ch = await bridge.check('12345');
      assert.equal(ch.state, 'unreachable');
      assert.equal(ch.netError, true);
      assert.equal(ch.message, 'gateway unreachable');
      assert.ok(ch.diag && ch.diag.includes('transport:'));

      console.log('Client diagnostics validated successfully in Node.');
    })().catch(e => {
      console.error(e);
      process.exit(1);
    });
    """
    res = subprocess.run(["node", "-e", node_test], cwd=str(ROOT), capture_output=True, text=True)
    assert res.returncode == 0, f"Node client diag test failed: {res.stderr}\n{res.stdout}"
    print("  -> Passed: Client transforms TypeError into 'gateway unreachable' with transport diagnostics.")


if __name__ == "__main__":
    test_1_port_preservation()
    test_2_tunnel_doctor()
    test_3_watchdog_auto_recovery()
    test_4_cloudflared_named_tunnel()
    test_5_client_diagnostics()
    print("\n✅ ALL MSE 2.14.0 FEATURE TESTS PASSED CLEANLY!")
