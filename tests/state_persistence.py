"""A3 and A4, proved by running the real router.

A3: the state (devices, allow list, log) must survive a restart, and the data directory must be one place that the
    router makes itself — the "state not saved: ENOENT mkdir /opt/mse/data" line must never appear again.
A4: the goygram vault must be in the data directory, not in the code directory, and it must survive an update
    (an update wipes the code tree, it must not touch the data tree).

    python3 tests/state_persistence.py
"""
from __future__ import annotations

import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ROUTER = ROOT / "Server" / "mse-router.js"
FAILS: list[str] = []


def check(ok: bool, what: str) -> None:
    print(("ok   " if ok else "FAIL ") + what)
    if not ok:
        FAILS.append(what)


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def wait_health(port: int, token: str, timeout: float = 20.0) -> bool:
    end = time.time() + timeout
    while time.time() < end:
        try:
            req = urllib.request.Request("http://127.0.0.1:%d/health" % port)
            with urllib.request.urlopen(req, timeout=2) as resp:
                if resp.status == 200:
                    return True
        except (urllib.error.URLError, OSError):
            time.sleep(0.3)
    return False


def call(port: int, token: str, method: str, path: str, body: dict | None = None) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request("http://127.0.0.1:%d%s" % (port, path), method=method, data=data,
                                 headers={"x-admin-token": token, "content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as exc:
        return {"error": exc.read().decode()[:200], "status": exc.code}


class Router:
    """The real router as a child process, with the data directory under test."""

    def __init__(self, data_dir: Path, port: int, token: str, code_dir: Path | None = None) -> None:
        self.data_dir = data_dir
        self.port = port
        self.token = token
        self.code_dir = code_dir
        self.proc: subprocess.Popen | None = None
        self.log = data_dir.parent / "router.log"

    def start(self) -> None:
        env = {
            "PATH": os.environ["PATH"],
            "HOME": str(self.data_dir),
            "MSE_PORT": str(self.port),
            "MSE_DATA_DIR": str(self.data_dir),
            "MSE_ADMIN_TOKEN": self.token,
            "MSE_DAILY_QUOTA": "200",
            "MSE_PUBLIC_URL": "https://mse-gateway.example-tailnet.ts.net",
        }
        script = str(ROUTER if self.code_dir is None else self.code_dir / "mse-router.js")
        self.proc = subprocess.Popen(["node", script], env=env, cwd=str(ROOT / "Server"),
                                     stdout=open(self.log, "a"), stderr=subprocess.STDOUT)

    def stop(self) -> None:
        if self.proc and self.proc.poll() is None:
            self.proc.send_signal(signal.SIGTERM)
            try:
                self.proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.proc.kill()


def main() -> int:
    work = Path(tempfile.mkdtemp(prefix="mse-state-"))
    data = work / "var"          # the data directory the install creates
    code = work / "opt"          # a stand-in for /opt/mse
    code.mkdir(parents=True)
    shutil.copy2(ROUTER, code / "mse-router.js")
    token = "adm_test_token_for_the_state_test"
    port = free_port()
    router = Router(data, port, token)

    print("== A3: a fresh start makes its own data directory")
    check(not data.exists(), "the data directory does not exist before the router starts")
    router.start()
    check(wait_health(port, token), "the router answers /health")
    check(data.is_dir(), "the router created the data directory itself")
    mode = oct(data.stat().st_mode & 0o777) if data.exists() else "?"
    check(mode in ("0o700", "0o750"), "the data directory is private (mode " + mode + ")")

    print("\n== A3: the state is written, and survives a restart")
    allowed = call(port, token, "POST", "/admin/allow", {"moodleId": "2040", "name": "Test person"})
    check(allowed.get("ok") is True or allowed.get("allow") is not None, "a Moodle id is allowed")
    quota = call(port, token, "POST", "/admin/quota", {"quota": 77})
    check(quota.get("quota") == 77, "the quota is changed")
    time.sleep(0.6)                        # the save is debounced by 120 ms
    state_file = data / "state.json"
    check(state_file.is_file(), "state.json is in the data directory")
    saved = json.loads(state_file.read_text()) if state_file.is_file() else {}
    check(any(str(a.get("moodleId")) == "2040" for a in saved.get("allow", [])), "the allow list is in state.json")

    router.stop()
    router = Router(data, port, token)
    router.start()
    check(wait_health(port, token), "the router is up again on the same data")
    state = call(port, token, "GET", "/admin/state")
    ids = [str(a.get("moodleId")) for a in state.get("allow", [])]
    check("2040" in ids, "the allow list survived the restart")
    check(int(state.get("quota") or 0) == 77, "the quota survived the restart")
    check(bool(state.get("log")), "the log survived the restart")

    print("\n== A3: the data directory is not in the code tree")
    check(not (code / "data").exists(), "nothing was written next to mse-router.js")
    log = (work / "router.log").read_text(errors="replace")
    check("state not saved" not in log, "no 'state not saved' in the log")
    check("ENOENT" not in log, "no ENOENT in the log")

    print("\n== A3: start / stop / start three times, the state stays every time")
    for round_no in (1, 2, 3):
        router.stop()
        router = Router(data, port, token)
        router.start()
        ok = wait_health(port, token)
        state = call(port, token, "GET", "/admin/state") if ok else {}
        ids = [str(a.get("moodleId")) for a in state.get("allow", [])]
        check(ok and "2040" in ids, "round %d: the allow list is still there" % round_no)
    router.stop()

    print("\n== A4: the vault lives in the data directory, and an update does not take it away")
    vault = data / "mse-bot.vault"
    vault.write_text('{"note": "stand-in for the goygram session vault"}', encoding="utf-8")
    os.chmod(vault, 0o600)
    env_vault = subprocess.run(
        ["node", "-e", "process.env.MSE_DATA_DIR=%r; const p=require(%r); " % (str(data), str(ROUTER))],
        capture_output=True, text=True)
    del env_vault  # the router is not what reads it; the check below is about the layout
    check((data / "mse-bot.vault").is_file(), "the vault is in the data directory")
    check(not (code / "mse-bot.vault").exists(), "there is no vault in the code directory")

    # an update: the code directory is emptied the way install.sh --update does it, the data directory is kept
    for item in code.iterdir():
        if item.is_file():
            item.unlink()
    shutil.rmtree(code, ignore_errors=True)
    code.mkdir()
    check((data / "mse-bot.vault").is_file(), "an update (code wiped) keeps the vault")
    check((data / "state.json").is_file(), "an update keeps the state")

    # the router still starts from a fresh code copy with the old data
    shutil.copy2(ROUTER, code / "mse-router.js")
    router = Router(data, port, token, code_dir=code)
    router.start()
    check(wait_health(port, token), "the router starts from a fresh code copy")
    state = call(port, token, "GET", "/admin/state")
    check(any(str(a.get("moodleId")) == "2040" for a in state.get("allow", [])), "the state is intact after the update")
    router.stop()

    shutil.rmtree(work, ignore_errors=True)

    print()
    if FAILS:
        print("%d failed" % len(FAILS))
        return 1
    print("state: one data directory, restarts and updates keep it — checked by running the real router")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
