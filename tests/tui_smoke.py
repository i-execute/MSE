#!/usr/bin/env python3
"""Smoke-тест панели: гоняет `mse_setup.py` в pty, как это делает живой терминал.

Проверяет три вещи, которые ломаются чаще всего:
  1) баннер и главное меню рисуются, в меню есть все девять действий;
  2) стрелки + Enter открывают экран действия (Model, Quota & Keys) — KeyReader живой;
  3) без tty (`--status`) панель печатает состояние и не висит на вводе.

Запуск: python3 tests/tui_smoke.py
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
    if pid == 0:  # pragma: no cover — дочерний процесс
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
    expect("badge-строка: router/backend/tunnel/bot", all(x in menu for x in ("router:", "backend:", "tunnel:", "bot:")), "")
    for label in ("Health & Status", "Install / Self-Heal", "Update & Repair", "Service Control",
                  "Tunnel (tailscale)", "Model, Quota & Keys", "Custom / Advanced Setup",
                  "Uninstall MSE", "Full Wipe"):
        expect("menu item: " + label, label in menu)
    expect("footer: keycaps", "move" in menu and "confirm" in menu)

    settings = run_pty([DOWN] * 5 + [b"\r"])
    expect("arrow+enter открывает Model, Quota & Keys", "Model, Quota & Keys" in settings and "Имя модели" in settings, settings[-600:])
    expect("в настройках есть поле токена и предупреждение о маске", "токен бота" in settings, "")

    custom = run_pty([DOWN] * 6 + [b"\r"])
    expect("Custom → Target Paths & Runtime", "Target Paths & Runtime" in custom, custom[-600:])

    wipe = run_pty([DOWN] * 8 + [b"\r"])
    expect("Full Wipe просит подтверждение", "Confirm Full Wipe" in wipe and "delete MSE completely" in wipe, wipe[-600:])

    status = os.popen(sys.executable + " " + str(SCRIPT) + " --status 2>&1").read()
    expect("--status без tty печатает здоровье", "здоровье стека" in status, status[-400:])
    expect("--status знает четыре компонента", all(x in status for x in ("router", "backend", "tunnel", "bot")), "")

    bad = os.popen(sys.executable + " " + str(SCRIPT) + " --once 2>&1").read()
    expect("флаги не поддерживаются (в духе reject_flags)", "unknown flag" in bad, bad[-300:])

    print(("PASS " if not failures else "FAILED ") + "%d/%d checks" % (checked - len(failures), checked))
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
