"""MSE setup — панель управления сервером в терминале, в духе `sudo obhod` из OBHOD.

    sudo mse

Что показывает: адрес туннеля, состояние роутера, AI-бэкенда, бота, устройств, квоты и модели.
Что делает: поднимает tailscale и funnel, меняет модель и квоту, включает и выключает бота, перезапускает
сервисы, пишет ключи в /etc/mse/mse.env. Ключа модели тут нет и быть не может — он в бэкенде.

Ничего не импортирует из goygram и ничего не пишет в сеть, кроме localhost-проверок, поэтому запускается и в
контейнере, и по ssh.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

PREFIX = Path(os.environ.get("MSE_PREFIX", "/opt/mse"))
ENV_FILE = Path(os.environ.get("MSE_ENV_FILE", "/etc/mse/mse.env"))
STATE_DIR = Path(os.environ.get("MSE_STATE_DIR", "/var/lib/mse"))
TUNNEL = os.environ.get("MSE_TUNNEL_SCRIPT", "/usr/local/bin/mse-tunnel.sh")

OK, BAD, WARN, INFO = "ok", "bad", "warn", "info"
TITLE = "MSE 2.0 · обход + AI-мост"


# ---------------------------------------------------------------------- env file
def env_read() -> dict[str, str]:
    data: dict[str, str] = {}
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text(errors="replace").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            data[key.strip()] = value.strip().strip('"').strip("'")
    for key, value in os.environ.items():
        if key.startswith("MSE_") and key not in data:
            data[key] = value
    return data


def env_write(key: str, value: str) -> None:
    lines: list[str] = []
    if ENV_FILE.exists():
        lines = [l for l in ENV_FILE.read_text(errors="replace").splitlines() if not l.startswith(key + "=")]
    lines.append(f"{key}={value}")
    ENV_FILE.parent.mkdir(parents=True, exist_ok=True)
    ENV_FILE.write_text("\n".join(lines) + "\n")
    try:
        os.chmod(ENV_FILE, 0o600)
    except OSError:
        pass


# ---------------------------------------------------------------------- probes
def http_json(url: str, timeout: float = 4.0) -> dict:
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        return json.loads(resp.read(1 << 20).decode("utf-8", "replace") or "{}")


def probe_router(env: dict[str, str]) -> tuple[str, str]:
    port = env.get("MSE_PORT", "8788")
    try:
        health = http_json(f"http://127.0.0.1:{port}/health")
    except (urllib.error.URLError, OSError, ValueError) as exc:
        return BAD, f"роутер не отвечает на 127.0.0.1:{port} ({getattr(exc, 'reason', exc)})"
    devices = health.get("devices", 0)
    allow = health.get("allow", 0)
    return OK, f"роутер 2.0 · модель {health.get('model', '—')} · устройств {devices} · в allow-листе {allow}"


def probe_backend(env: dict[str, str]) -> tuple[str, str]:
    host = env.get("MSE_UPSTREAM_HOST", "127.0.0.1")
    port = env.get("MSE_UPSTREAM_PORT", "8799")
    try:
        body = http_json(f"http://{host}:{port}/v1/models")
    except (urllib.error.URLError, OSError, ValueError) as exc:
        return WARN, f"AI-бэкенд {host}:{port} не отвечает ({getattr(exc, 'reason', exc)}) — запустите его отдельно"
    ids = [str(m.get("id")) for m in body.get("data") or [] if m.get("id")]
    return OK, f"AI-бэкенд {host}:{port} · моделей {len(ids)}" + ((" · " + ", ".join(ids[:4])) if ids else "")


def probe_tunnel() -> tuple[str, str, dict]:
    if not shutil.which(TUNNEL) and not Path(TUNNEL).exists():
        return WARN, "mse-tunnel.sh не установлен", {}
    try:
        out = subprocess.run([TUNNEL, "status", "--json"], capture_output=True, text=True, timeout=20, check=False)
        info = json.loads(out.stdout or "{}")
    except (OSError, subprocess.SubprocessError, ValueError) as exc:
        return BAD, f"туннель не отвечает: {exc}", {}
    if not info.get("installed"):
        return WARN, "tailscale не установлен", info
    if not info.get("running"):
        return WARN, "tailscale установлен, но узел не поднят", info
    url = info.get("url") or "—"
    return OK, f"туннель {info.get('mode') or 'нет'} · {url}", info


def probe_bot(env: dict[str, str]) -> tuple[str, str]:
    if not env.get("MSE_BOT_TOKEN"):
        return WARN, "бот выключен: MSE_BOT_TOKEN пуст"
    if shutil.which("systemctl"):
        out = subprocess.run(["systemctl", "is-active", "mse-bot"], capture_output=True, text=True, check=False)
        state = (out.stdout or "").strip()
        return (OK if state == "active" else BAD), f"бот: {state or 'неизвестно'}"
    return INFO, "бот: systemctl нет, состояние не проверить"


# ---------------------------------------------------------------------- actions
def run(cmd: list[str], timeout: float = 120.0) -> tuple[bool, str]:
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, check=False)
    except (OSError, subprocess.SubprocessError) as exc:
        return False, str(exc)
    return out.returncode == 0, ((out.stdout or "") + (out.stderr or "")).strip()[:400]


def service(env: dict[str, str], name: str, action: str) -> tuple[bool, str]:
    return run(["systemctl", action, name])


def admin_post(env: dict[str, str], path: str, body: dict) -> tuple[bool, str]:
    port = env.get("MSE_PORT", "8788")
    token = env.get("MSE_ADMIN_TOKEN", "")
    data = json.dumps(body).encode()
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=data, method="POST",
                                 headers={"content-type": "application/json", "x-admin-token": token})
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            return True, resp.read(4096).decode("utf-8", "replace")
    except (urllib.error.URLError, OSError) as exc:
        return False, str(exc)


# ---------------------------------------------------------------------- the screen
def render(notice: str = "", error: str = "", env: dict[str, str] | None = None) -> str:
    env = env or env_read()
    rows: list[tuple[str, str, str]] = []
    status, text = probe_router(env)
    rows.append(("роутер", status, text))
    status, text = probe_backend(env)
    rows.append(("модель", status, text))
    status, text, info = probe_tunnel()
    rows.append(("туннель", status, text))
    status, text = probe_bot(env)
    rows.append(("бот", status, text))
    rows.append(("квота", INFO, f"{env.get('MSE_DAILY_QUOTA', '200')} запросов в сутки на устройство"))
    keys = [k for k in ("MSE_TAILSCALE_KEY", "MSE_BOT_TOKEN", "MSE_OWNER_ID", "MSE_UPSTREAM_KEY") if env.get(k)]
    missing = [k for k in ("MSE_TAILSCALE_KEY", "MSE_BOT_TOKEN", "MSE_OWNER_ID") if not env.get(k)]
    rows.append(("ключи", OK if not missing else WARN, f"задано {len(keys)}" + ((" · не задано " + ", ".join(missing)) if missing else "")))
    marks = {OK: "[ ok ]", BAD: "[fail]", WARN: "[warn]", INFO: "[info]"}
    lines = ["", TITLE, "─" * 62]
    for name, status, text in rows:
        lines.append(f"{marks.get(status, '[    ]')} {name:<8} {text}")
    lines.append("─" * 62)
    if notice:
        lines.append(f"  {notice}")
    if error:
        lines.append(f"  ошибка: {error}")
    lines.append("  1 туннель · 2 модель · 3 квота · 4 токен бота · 5 ключ tailscale · 6 бот вкл/выкл")
    lines.append("  7 перезапуск роутера · 8 обновить · 0 выход")
    return "\n".join(lines)


def ask(prompt: str, default: str = "") -> str:
    try:
        value = input(prompt + (f" [{default}]" if default else "") + ": ").strip()
    except (EOFError, KeyboardInterrupt):
        return default
    return value or default


def main(argv: list[str]) -> int:
    env = env_read()
    notice, error = "", ""
    once = "--once" in argv or not sys.stdin.isatty()
    while True:
        print(render(notice, error, env))
        notice = error = ""
        if once:
            return 0
        choice = ask("выбор", "0")
        if choice in ("0", "q", ""):
            return 0
        if choice == "1":
            action = ask("туннель: up / funnel / serve / off", "funnel")
            if action == "up":
                ok, text = run([TUNNEL, "up"], timeout=180)
            elif action in ("funnel", "serve"):
                ok, text = run([TUNNEL, action, env.get("MSE_PORT", "8788")], timeout=180)
            elif action == "off":
                ok, text = run([TUNNEL, "off"])
            else:
                ok, text = False, "не знаю такого"
            if ok:
                notice = "туннель: " + text.splitlines()[-1][:120]
                if text.startswith("https://"):
                    env_write("MSE_PUBLIC_URL", text.strip())
                    service(env, "mse-router", "restart")
            else:
                error = text
        elif choice == "2":
            current = env.get("MSE_MODEL", "")
            models = env.get("MSE_MODELS", "")
            value = ask(f"модель (доступны: {models})", current)
            if value:
                env_write("MSE_MODEL", value)
                notice = "модель записана; бэкенд читает её при старте"
        elif choice == "3":
            value = ask("квота в сутки на устройство", env.get("MSE_DAILY_QUOTA", "200"))
            if value.isdigit():
                env_write("MSE_DAILY_QUOTA", value)
                ok, text = admin_post(env, "/admin/quota", {"quota": int(value)})
                notice = "квота " + value + ("" if ok else " (роутер не принял: " + text[:80] + ", применится после перезапуска)")
        elif choice == "4":
            value = ask("токен бота (BotFather)", "")
            if value:
                env_write("MSE_BOT_TOKEN", value)
                service(env, "mse-bot", "restart")
                notice = "токен записан, бот перезапущен"
        elif choice == "5":
            value = ask("ключ tailscale (tskey-auth-…)", "")
            if value:
                env_write("MSE_TAILSCALE_KEY", value)
                ok, text = run([TUNNEL, "up"], timeout=180)
                notice = "tailscale up: " + ("ok" if ok else text[:120])
        elif choice == "6":
            if env.get("MSE_BOT_TOKEN"):
                state = "stop" if "active" in (subprocess.run(["systemctl", "is-active", "mse-bot"], capture_output=True, text=True).stdout or "") else "start"
                ok, text = service(env, "mse-bot", state)
                notice = f"бот: {state} " + ("ok" if ok else text[:100])
            else:
                error = "нет MSE_BOT_TOKEN: сначала пункт 4"
        elif choice == "7":
            ok, text = service(env, "mse-router", "restart")
            notice = "роутер перезапущен" if ok else text
        elif choice == "8":
            env = env_read()
        else:
            error = "нет такого пункта"


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
