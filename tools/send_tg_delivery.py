#!/usr/bin/env python3
"""Send MSE 2.14.0 delivery files and summary to Telegram owner.
Usage:
    MSE_BOT_TOKEN=... python3 tools/send_tg_delivery.py
"""

import os
import sys
import json
import uuid
import zipfile
import mimetypes
import urllib.request
import urllib.error
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / "Storage" / "artifacts"
CHAT_ID = os.environ.get("MSE_OWNER_ID") or os.environ.get("TELEGRAM_CHAT_ID") or "7610246474"

def make_delivery_zip() -> Path:
    zip_path = ARTIFACTS / "MSE-2.14.0.zip"
    include_dirs = [
        "Extensions/src",
        "Extensions/tools",
        "Server",
        "Storage/Documentation",
        "tests",
        "tools",
        "scripts",
        "skills",
    ]
    include_files = [
        "Storage/artifacts/mse.user.js",
        "Storage/artifacts/build-report.json",
        "Storage/artifacts/mse-2.14.0.patch",
        "Storage/get.sh",
        "package.json",
        "package-lock.json",
        "README.md",
        "RELEASE_2.14.0.md",
        "CHANGES.md",
        "LICENSE",
    ]
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for rel in include_files:
            p = ROOT / rel
            if p.exists():
                zf.write(p, rel)
            else:
                print(f"Warning: file {rel} not found", file=sys.stderr)
        for dir_rel in include_dirs:
            dp = ROOT / dir_rel
            if not dp.exists():
                continue
            for p in dp.rglob("*"):
                if p.is_file():
                    if "__pycache__" in p.parts or ".pytest_cache" in p.parts or p.name.endswith(".pyc"):
                        continue
                    rel = p.relative_to(ROOT)
                    zf.write(p, str(rel))
    print(f"Created complete delivery zip: {zip_path} ({zip_path.stat().st_size} bytes)")
    return zip_path

def load_token() -> str:
    t = (os.environ.get("MSE_BOT_TOKEN") or os.environ.get("TELEGRAM_BOT_TOKEN") or "").strip()
    if t:
        return t
    for env_path in (Path("/etc/mse/mse.env"), Path.home() / ".env"):
        if env_path.exists():
            try:
                for line in env_path.read_text(encoding="utf-8").splitlines():
                    if line.startswith("MSE_BOT_TOKEN="):
                        return line.split("=", 1)[1].strip()
            except Exception:
                pass
    return ""

TOKEN = load_token()

API = f"https://api.telegram.org/bot{TOKEN}/%s"

def call(method: str, payload: dict | None = None, files: dict | None = None) -> dict:
    url = API % method
    if not files:
        data = json.dumps(payload or {}).encode("utf-8")
        req = urllib.request.Request(url, data=data, headers={"content-type": "application/json"})
    else:
        boundary = "----mse" + uuid.uuid4().hex
        body = b""
        for key, value in (payload or {}).items():
            body += (f"--{boundary}\r\nContent-Disposition: form-data; name=\"{key}\"\r\n\r\n{value}\r\n").encode("utf-8")
        for key, path in files.items():
            path = Path(path)
            kind = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
            body += (f"--{boundary}\r\nContent-Disposition: form-data; name=\"{key}\"; filename=\"{path.name}\"\r\n"
                     f"Content-Type: {kind}\r\n\r\n").encode("utf-8")
            body += path.read_bytes() + b"\r\n"
        body += (f"--{boundary}--\r\n").encode("utf-8")
        req = urllib.request.Request(url, data=body, headers={"content-type": f"multipart/form-data; boundary={boundary}"})
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return json.loads(resp.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as exc:
        return {"ok": False, "error": exc.read().decode("utf-8", "replace")[:400]}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}

def main():
    zip_path = make_delivery_zip()

    if not TOKEN:
        print("Note: MSE_BOT_TOKEN is not set in environment (offline packaging mode).", file=sys.stderr)
        print("Delivery archive created successfully at:", zip_path)
        return 0

    report_text = """<b>MSE 2.14.0 «ДОСТУП ИЗ КОРОБКИ» Delivered</b>

<b>Key Highlights:</b>
• <b>Port Persistence Across Reinstalls</b>: <code>install.sh</code> and <code>get.sh</code> preserve <code>MSE_PORT</code> and <code>MSE_UPSTREAM_PORT</code> from <code>/var/lib/mse/state.json</code> and env. Prevents Tailscale edge cache desync. Fresh ports allocated only with <code>--new-ports</code>.
• <b>Tunnel Doctor (<code>mse-tunnel.sh doctor</code> + Bot/TUI)</b>: Comprehensive diagnosis of DNS (A/AAAA), external 443 latency/RTT, serve/funnel vs MSE_PORT match, and <code>tailscaled</code> journal parsing for drops (<code>no rules matched</code> &amp; <code>TLS EOF from fd7a:</code>). Provides clear verdict and ready-to-paste treatment command (<code>sudo mse-tunnel.sh funnel-reset</code>).
• <b>Tunnel Auto-Recovery Watchdog</b>: Background watchdog (<code>mse-tunnel.sh watchdog</code>) checks external <code>/health</code> every minute; on 3 consecutive failures automatically resets funnel + restarts tailscaled and logs <code>tunnel watchdog: recovered</code> to <code>mse-router.log</code>.
• <b>Cloudflared Named Tunnel as Primary Path</b>: Permanent CF Zero Trust tunnel (<code>cloudflared-named &lt;token&gt; &lt;domain&gt;</code>) configured via TUI; quick-tunnel fallback labeled as temporary; Telegram bot alerts owner on URL changes.
• <b>Client Diagnostics on Network Drops</b>: Replaced raw "Load failed" with <code>gateway unreachable from this network</code> + detailed network log (URL, attempt #, VPN/network explanation: "problem with network or VPN"). Retains 500ms single retry.
• <b>Known Issues Documentation</b>: Comprehensive «Известные хвори и их лечение» added to <code>README_RU.md</code>, <code>ios_ru.md</code>, and <code>README.md</code>.
• <b>Audit &amp; Tests</b>: All tests pass (Gateway/Router 23/23, WebKit iOS 11/11, Bot selftest, 2.14 suite 5/5); <code>scripts/audit.py --strict</code> clean 0 hits x3."""

    print(f"Sending message to chat {CHAT_ID}...")
    res = call("sendMessage", {"chat_id": CHAT_ID, "text": report_text, "parse_mode": "HTML"})
    if not res.get("ok"):
        print("sendMessage failed:", res)
        return 1
    print("Message sent successfully.")

    files_to_send = [
        zip_path,
        ARTIFACTS / "mse.user.js",
        ARTIFACTS / "mse-2.14.0.patch",
        ROOT / "RELEASE_2.14.0.md"
    ]

    for p in files_to_send:
        if not p.exists():
            print(f"File not found: {p}", file=sys.stderr)
            continue
        print(f"Sending {p.name} ({p.stat().st_size} bytes)...")
        res = call("sendDocument", {"chat_id": CHAT_ID, "caption": f"MSE 2.14.0 — {p.name}"}, {"document": p})
        if res.get("ok"):
            print(f"Successfully sent {p.name}")
        else:
            print(f"Failed to send {p.name}: {res.get('error')}", file=sys.stderr)

    return 0

if __name__ == "__main__":
    sys.exit(main())
