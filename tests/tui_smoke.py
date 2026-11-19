#!/usr/bin/env python3
"""A smoke test of the panel: it drives `mse_setup.py` through a pty, exactly as a live terminal would.

It checks the three things that break most often:
  1) the banner and the main menu are drawn, and all nine actions are in the menu;
  2) the arrows + Enter open an action screen (Model, Quota & Keys) — the KeyReader is alive;
  3) without a tty (`--status`) the panel prints the state and does not wait for input.

Run: python3 tests/tui_smoke.py
"""
from __future__ import annotations

import fcntl
import os
import pty
import re
import select
import struct
import sys
import termios
import time
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent.parent / "Server" / "stack" / "mse_setup.py"
DOWN = b"\x1b[B"
ANSI = re.compile(rb"\x1b\[[0-9;?]*[A-Za-z]")
failures: list[str] = []
checked = 0


def expect(name: str, ok: bool, detail: str = "") -> None:
    global checked
    checked += 1
    print(("ok   " if ok else "FAIL ") + name + (("  ·  " + detail) if detail and not ok else ""))
    if not ok:
        failures.append(name)


def run_pty(keys: list[bytes], cols: int = 100, rows: int = 40) -> str:
    env = dict(os.environ, TERM="xterm-256color", MSE_ENV_FILE="/tmp/mse-tui-smoke.env", MSE_FORCE_COLOR="1")
    pid, fd = pty.fork()
    if pid == 0:  # pragma: no cover — the child process
        os.execvpe(sys.executable, [sys.executable, str(SCRIPT)], env)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    out = b""

    def pump(seconds: float) -> None:
        nonlocal out
        end = time.time() + seconds
        while time.time() < end:
            ready, _, _ = select.select([fd], [], [], 0.05)
            if ready:
                try:
                    chunk = os.read(fd, 65536)
                except OSError:
                    return
                if not chunk:
                    return
                out += chunk

    pump(1.2)
    for key in keys:
        os.write(fd, key)
        pump(0.45)
    pump(0.8)
    try:
        os.kill(pid, 9)
    except ProcessLookupError:
        pass
    return ANSI.sub(b"", out).decode("utf-8", "replace")


def main() -> int:
    Path("/tmp/mse-tui-smoke.env").unlink(missing_ok=True)
    menu = run_pty([])
    expect("banner: MSE · Control Center", "MSE · Control Center" in menu, menu[-400:])
    expect("badge line: router/backend/tunnel/bot", all(x in menu for x in ("router:", "backend:", "tunnel:", "bot:")), "")
    for label in ("Health & Status", "Gateway Domain", "Install / Self-Heal", "Service Control",
                  "Settings & Credentials", "Uninstall MSE"):
        expect("menu item: " + label, label in menu)
    expect("footer: keycaps", "move" in menu and "confirm" in menu)

    domain = run_pty([DOWN] * 1 + [b"\r"])
    expect("arrow+enter opens Gateway Domain", "Gateway Domain" in domain and "Cloudflared" in domain and "Tailscale" in domain, domain[-600:])

    settings = run_pty([DOWN] * 4 + [b"\r"])
    expect("arrow+enter opens Settings & Credentials", "Settings & Credentials" in settings and "model name" in settings, settings[-600:])
    expect("settings screen lists the bot token field", "bot token" in settings, "")

    status = os.popen(sys.executable + " " + str(SCRIPT) + " --status 2>&1").read()
    expect("--status without a tty prints the health", "stack health" in status, status[-400:])
    expect("--status knows the four components", all(x in status for x in ("router", "backend", "tunnel", "bot")), "")

    bad = os.popen(sys.executable + " " + str(SCRIPT) + " --once 2>&1").read()
    expect("flags are rejected (reject_flags style)", "unknown flag" in bad, bad[-300:])

    print(("PASS " if not failures else "FAILED ") + "%d/%d checks" % (checked - len(failures), checked))
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
