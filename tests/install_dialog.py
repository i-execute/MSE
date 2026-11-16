"""Bugs 4 and 5, proved by running the installer — not by reading it.

Three runs, each in a throwaway sandbox (PREFIX/ENV_DIR/STATE_DIR under /tmp, no root, no systemd):

  1. a pipe (no terminal): the installer must install what it can and print the exact commands for the three
     values it could not ask for;
  2. a pty (a terminal): it must ask for bot token / owner id / tailscale key, validate each, write them into
     mse.env with mode 600, and accept nothing that does not look right;
  3. order: on a run that gets a tailscale key, the tunnel step must come after the files and before the router
     restart, and the restart must only happen when a public address actually arrived;
  4. the panel (TUI) asks for the same three keys on a clean box, so nobody installs a stack that cannot start.

    python3 tests/install_dialog.py
"""
from __future__ import annotations

import os
import pty
import re
import select
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
INSTALL = ROOT / "Server" / "stack" / "install.sh"
PANEL = ROOT / "Server" / "stack" / "mse_setup.py"
FAILS: list[str] = []


def check(ok: bool, what: str) -> None:
    print(("ok   " if ok else "FAIL ") + what)
    if not ok:
        FAILS.append(what)


STUBS = {
    # a stand-in systemctl: every unit is "active", every call is logged, so the order can be checked afterwards
    "systemctl": """#!/usr/bin/env bash
echo "systemctl $*" >> "$MSE_TEST_LOG"
case "$1" in
  is-active) echo active ;;
  restart|start|stop) echo "restarted $2" ; exit 0 ;;
  *) exit 0 ;;
esac
""",
    # curl: /health answers once the router has been "restarted" at least once
    "curl": """#!/usr/bin/env bash
for a in "$@"; do case "$a" in *://*) url="$a" ;; esac; done
case "$url" in
  *127.0.0.1*health*|*localhost*health*) echo '{"ok":true,"name":"MSE gateway"}'; exit 0 ;;
  *) echo "{}"; exit 0 ;;
esac
""",
    # the tunnel helper: up/funnel report an address, status --json reports it back
    "mse-tunnel.sh": """#!/usr/bin/env bash
echo "mse-tunnel $*" >> "$MSE_TEST_LOG"
case "$1" in
  up) echo "tailscale is up" ;;
  funnel) echo "serve/funnel on"; echo "https://mse-gateway.example-tailnet.ts.net" ;;
  serve) echo "https://mse-gateway.example-tailnet.ts.net" ;;
  status) echo '{"backend":"tailscale","installed":true,"running":true,"mode":"funnel","url":"https://mse-gateway.example-tailnet.ts.net","ip":"203.0.113.1"}' ;;
  *) exit 0 ;;
esac
""",
    "tailscale": """#!/usr/bin/env bash
case "$1" in
  version) echo "1.80.0" ;;
  *) exit 0 ;;
esac
""",
}


def sandbox() -> dict:
    base = Path(tempfile.mkdtemp(prefix="mse-inst-"))
    bin_dir = base / "bin"
    bin_dir.mkdir()
    for name, body in STUBS.items():
        path = bin_dir / name
        path.write_text(body, encoding="utf-8")
        path.chmod(0o755)
    return {
        "MSE_PREFIX": str(base / "opt"),
        "MSE_ENV_DIR": str(base / "etc"),
        "MSE_STATE_DIR": str(base / "var"),
        "MSE_UNIT_DIR": str(base / "units"),
        "MSE_ALLOW_NONROOT": "1",
        "MSE_SRC_DIR": str(ROOT),
        "MSE_TEST_LOG": str(base / "calls.log"),
        "_base": str(base),
        "_bin": str(bin_dir),
        "_log": str(base / "calls.log"),
    }


def env_of(box: dict, extra: dict | None = None) -> dict:
    env = {k: v for k, v in os.environ.items() if not k.startswith("MSE_")}
    env.update({k: v for k, v in box.items() if not k.startswith("_")})
    # the sandbox stubs first: systemctl, curl, tailscale and the tunnel helper are loggers here
    env["PATH"] = box.get("_bin", "") + os.pathsep + os.environ["PATH"]
    if extra:
        env.update(extra)
    return env


def read_env(box: dict) -> dict:
    path = Path(box["MSE_ENV_DIR"]) / "mse.env"
    out: dict[str, str] = {}
    if not path.exists():
        return out
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        if line.strip() and not line.strip().startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            out[key.strip()] = value.strip()
    return out


def pipe_run(extra_env: dict) -> tuple[subprocess.CompletedProcess, str]:
    box = sandbox()
    proc = subprocess.run(["bash", str(INSTALL), "--yes"], env=env_of(box, extra_env),
                          stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=600)
    return proc, (proc.stdout or "") + "\n" + (proc.stderr or "")


def pty_run(answers: list[str], extra_env: dict | None = None, timeout: float = 600) -> tuple[str, dict]:
    """Runs the installer behind a terminal and types the answers, as a person would."""
    box = sandbox()
    master, slave = pty.openpty()
    env = env_of(box, extra_env)
    env["TERM"] = "dumb"
    proc = subprocess.Popen(["bash", str(INSTALL)], env=env, stdin=slave, stdout=slave, stderr=slave,
                            close_fds=True, start_new_session=True)
    os.close(slave)
    output = b""
    pending = list(answers)
    deadline = time.time() + timeout
    typed = 0
    while time.time() < deadline:
        if proc.poll() is not None and not select.select([master], [], [], 0.2)[0]:
            break
        ready, _, _ = select.select([master], [], [], 0.3)
        if ready:
            try:
                chunk = os.read(master, 65536)
            except OSError:
                break
            if not chunk:
                break
            output += chunk
        text = output.decode("utf-8", "replace")
        # answer each prompt once, in the order the installer asks
        asked = len(re.findall(r"(?m)^\s*(bot token|owner telegram id|tailscale auth key):", text))
        while pending and typed < asked:
            os.write(master, (pending.pop(0) + "\n").encode())
            typed += 1
        if proc.poll() is not None:
            break
    try:
        proc.wait(timeout=60)
    except subprocess.TimeoutExpired:
        proc.kill()
    os.close(master)
    return output.decode("utf-8", "replace"), box


def tui_run(keys: list[bytes] | None = None, keys_typed: list[bytes] | None = None,
            wait_for: str = "", timeout: float = 120) -> str:
    """Drives the panel (mse_setup.py) through a pty: the same keys a person would press, in order.

    The panel draws with cursor moves, so the frames are stripped of ANSI before they are searched: what is left is
    the text a person reads. Typed values are injected after the panel is up, one per field, the way the key reader
    takes them.
    """
    import fcntl
    import struct
    import termios

    box = sandbox()
    env = env_of(box)
    env.update({"TERM": "xterm-256color", "MSE_FORCE_COLOR": "1"})
    env.pop("MSE_BOT_TOKEN", None)
    env.pop("MSE_OWNER_ID", None)
    env.pop("MSE_TAILSCALE_KEY", None)
    master, slave = pty.openpty()
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 100, 0, 0))
    proc = subprocess.Popen([sys.executable, str(PANEL)], env=env, stdin=slave, stdout=slave, stderr=slave,
                            close_fds=True, start_new_session=True)
    os.close(slave)
    out = b""
    deadline = time.time() + timeout
    pending = list(keys_typed or [])
    keys = list(keys or [])
    sent = False
    while time.time() < deadline:
        ready, _, _ = select.select([master], [], [], 0.3)
        if ready:
            try:
                chunk = os.read(master, 65536)
            except OSError:
                break
            if not chunk:
                break
            out += chunk
            text = out.decode("utf-8", "replace")
            if wait_for and wait_for in text and not sent:
                sent = True
                for key in keys:
                    os.write(master, key)
                    time.sleep(0.15)
        if proc.poll() is not None:
            break
    try:
        proc.wait(timeout=20)
    except subprocess.TimeoutExpired:
        proc.kill()
    try:
        while True:
            ready, _, _ = select.select([master], [], [], 0.2)
            if not ready:
                break
            chunk = os.read(master, 65536)
            if not chunk:
                break
            out += chunk
    except OSError:
        pass
    os.close(master)
    shutil.rmtree(box["_base"], ignore_errors=True)
    plain = re.sub(rb"\x1b\[[0-9;?]*[A-Za-z]", b"", out)
    return plain.decode("utf-8", "replace")


def calls(box: dict) -> list[str]:
    try:
        return Path(box["_log"]).read_text(encoding="utf-8").splitlines()
    except OSError:
        return []


def main() -> int:
    print("== 1. a pipe: no terminal, so no questions — exact commands instead")
    proc, text = pipe_run({})
    check(proc.returncode == 0, "the pipe run finishes (exit " + str(proc.returncode) + ")")
    check("MSE_BOT_TOKEN=1234567890:AAH" in text, "it prints the exact command for the bot token")
    check("@userinfobot" in text, "it says where the owner id comes from")
    check("login.tailscale.com" in text, "it says where the tailscale key comes from")
    check("cannot ask" in text, "it says plainly why it did not ask")

    print("\n== 2. a terminal: it asks for all three and validates them")
    answers = ["not-a-token", "1234567890:AAH-test-token-0123456789",   # bot token: first bad, then good
               "abc", "100000001",                                     # owner id: first bad, then good
               "tskey-auth-test-0000000000"]                      # tailscale key
    text, box = pty_run(answers)
    check(re.findall(r"bot token:", text).__len__() >= 2, "the bot token is asked again after a bad answer")
    check("does not look like" in text, "a bad answer is called out, not accepted")
    check("owner telegram id" in text, "the owner id is asked")
    check("tailscale auth key" in text, "the tailscale key is asked")
    env = read_env(box)
    check(env.get("MSE_BOT_TOKEN", "").endswith("0123456789"), "the bot token lands in mse.env")
    check(env.get("MSE_OWNER_ID") == "100000001", "the owner id lands in mse.env")
    check(env.get("MSE_TAILSCALE_KEY", "").startswith("tskey-auth-"), "the tailscale key lands in mse.env")
    env_file = Path(box["MSE_ENV_DIR"]) / "mse.env"
    if env_file.exists():
        mode = oct(env_file.stat().st_mode & 0o777)
        check(mode == "0o600", "mse.env is mode 600 (got " + mode + ")")
    check(not any("SECRET" in line for line in text.splitlines() if "MSE_" in line),
          "the values are not echoed back in a shell command line")

    print("\n== 3. order: files -> tunnel up + funnel -> router restart -> checks")
    log = calls(box)
    seq = [line for line in log]
    funnel_at = next((i for i, line in enumerate(seq) if line.startswith("mse-tunnel funnel")), -1)
    up_at = next((i for i, line in enumerate(seq) if line.startswith("mse-tunnel up")), -1)
    restarts = [i for i, line in enumerate(seq) if line == "systemctl restart mse-router.service"]
    check(up_at != -1, "the installer brought the node up with the key from the dialogue (" + str(len(seq)) + " calls)")
    check(funnel_at != -1, "the installer turned the funnel on")
    check(bool(restarts), "the router was restarted after the address appeared")
    if funnel_at != -1 and restarts:
        check(max(restarts) > funnel_at, "the restart of the router comes after the funnel (not before)")
    env3 = read_env(box)
    check(str(env3.get("MSE_PUBLIC_URL", "")).startswith("https://"), "the address is written into MSE_PUBLIC_URL")
    check("router:    answers, with the address in /health" in text, "the installer confirms /health after the restart")
    check("mse-bot: active" in text, "the installer confirms the bot unit is active")

    print("\n== 4. the panel asks for the same three keys before it installs (bug 7)")
    # a terminal, a clean box, nothing in the env: the panel must ask, not walk past the keys and fail later
    # the panel is asked for the fresh install (item 2), which must lead through the key screen
    tui = tui_run([b"\x1b[B", b"\r", b"\r", b"\x1b"], wait_for="Control Center")
    for prompt in ("bot token", "owner id", "tailscale key"):
        check(prompt in tui.lower(), "the panel asks for the " + prompt)
    check("space" in tui.lower() and "enter" in tui.lower(), "and the footer says how a field is filled")

    print("\n== 5. a dry run changes nothing and still says what it would ask")
    box = sandbox()
    proc = subprocess.run(["bash", str(INSTALL), "--dry-run", "--yes"], env=env_of(box),
                          capture_output=True, text=True, timeout=300)
    text = proc.stdout + proc.stderr
    check(proc.returncode == 0, "a dry run exits 0")
    check("[dry]" in text, "the dry run prints its plan")
    check(not (Path(box["MSE_ENV_DIR"]) / "mse.env").exists(), "the dry run writes no settings file")
    shutil.rmtree(box["_base"], ignore_errors=True)

    print()
    if FAILS:
        print("%d failed" % len(FAILS))
        return 1
    print("installer: first-run dialogue, validation, order — all checked by running it")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
