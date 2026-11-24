#!/usr/bin/env python3
"""Send MSE 2.14.1 delivery files and summary to Telegram owner.
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
    zip_path = ARTIFACTS / "MSE-2.14.1.zip"
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
        "Storage/artifacts/mse-2.14.1.patch",
        "Storage/get.sh",
        "package.json",
        "package-lock.json",
        "README.md",
        "RELEASE_2.14.1.md",
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

    report_text = """<b>MSE 2.14.1 CRITICAL HOTFIX Delivered</b>

<b>Key Highlights:</b>
• <b>Privileged GM_xmlhttpRequest Transport</b>: All gateway calls (<code>probe</code>, <code>check</code>, <code>register</code>, <code>agent</code>, <code>quota</code>, <code>dump</code>, <code>chat</code>) now execute via <code>GM_xmlhttpRequest</code>. Completely bypasses Safari/Stay page-level CSP (<code>connect-src</code>) and WebKit ITP cross-origin restrictions.
• <b>Fallback to window.fetch</b>: Retained strictly as fallback when runner lacks GM capabilities (order: <code>GM -> window.fetch</code>).
• <b>Upgraded Timeouts &amp; AbortController</b>: 30s standard timeout, 120s for agent/chat SSE. Proper cancellation via <code>signal.abort()</code> calling <code>handle.abort()</code>.
• <b>Anti-Avalanche Queue Protection</b>: Strict cap of 1 retry (max 2 attempts per request); button debouncing prevents duplicate concurrent checks.
• <b>Transport Diagnostic Tag</b>: Network log and diagnostics explicitly report active transport (<code>transport: gm</code> vs <code>transport: fetch</code>).
• <b>Purged False VPN Errors &amp; Cringe Messages</b>: Removed all misleading "VPN problem / disable VPN" text and Russian strings; replaced with clean, objective English status and error indicators.
• <b>Watchdog IPv6 Routing Fix</b>: Tunnel health checks enforce <code>curl -4</code> to avoid false failures on hosts with broken IPv6 default routes.
• <b>Quality &amp; Tests</b>: Unit &amp; integration tests passed (<code>tests/mse_2141.py</code>, <code>tests/mse_214.py</code>, <code>tests/onefile.test.js</code>, <code>npm test</code>); <code>audit.py --strict</code> clean 0 hits x3."""

    print(f"Sending message to chat {CHAT_ID}...")
    res = call("sendMessage", {"chat_id": CHAT_ID, "text": report_text, "parse_mode": "HTML"})
    if not res.get("ok"):
        print("sendMessage failed:", res)
        return 1
    print("Message sent successfully.")

    files_to_send = [
        zip_path,
        ARTIFACTS / "mse.user.js",
        ARTIFACTS / "mse-2.14.1.patch",
        ROOT / "RELEASE_2.14.1.md"
    ]

    for p in files_to_send:
        if not p.exists():
            print(f"File not found: {p}", file=sys.stderr)
            continue
        print(f"Sending {p.name} ({p.stat().st_size} bytes)...")
        res = call("sendDocument", {"chat_id": CHAT_ID, "caption": f"MSE 2.14.1 — {p.name}"}, {"document": p})
        if res.get("ok"):
            print(f"Successfully sent {p.name}")
        else:
            print(f"Failed to send {p.name}: {res.get('error')}", file=sys.stderr)

    return 0

if __name__ == "__main__":
    sys.exit(main())
