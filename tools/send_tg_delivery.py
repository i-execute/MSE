#!/usr/bin/env python3
"""Send MSE 2.8.0 delivery files and summary to Telegram owner.
Usage:
    MSE_BOT_TOKEN=... python3 tools/send_tg_delivery.py
"""

import os
import sys
import json
import uuid
import mimetypes
import urllib.request
import urllib.error
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / "Storage" / "artifacts"
CHAT_ID = os.environ.get("MSE_OWNER_ID") or os.environ.get("TELEGRAM_CHAT_ID") or "7610246474"
TOKEN = (os.environ.get("MSE_BOT_TOKEN") or os.environ.get("TELEGRAM_BOT_TOKEN") or "").strip()

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
    if not TOKEN:
        print("ERROR: MSE_BOT_TOKEN is not set", file=sys.stderr)
        return 1

    report_text = """<b>MSE 2.10.0 Release Delivered</b>

<b>Key Highlights:</b>
• <b>UI Polish (A1–A10)</b>: Header restored to <code>question N</code>; <code>login</code> field removed; cached key check status (no 'key not checked'); 'settings' button; compact DEBG toggle; copyable device ID; strictly English UI (0 Cyrillic strings); monochrome gear SVG icon; unified single-line status.
• <b>SSE Agent Streaming</b>: Stage events (reasoning, looking at image, writing answer), heartbeat pings every ~10s, abort on client disconnect, zero comments in router agent code, and plain JSON fallback.
• <b>Multi-Account Support (2.10-B)</b>: One device associates with multiple Moodle IDs; 'Integrate request' button in UI; separate approval/revocation and disassociation in bot.
• <b>Sniffer Schema Layers (2.10-A)</b>: <code>schema_layer=1</code> and <code>is_known_layer</code> boolean in diagnostic dumps.
• <b>Endpoint Hardening (C & 2.10-E)</b>: Minimal public <code>/health</code> (<code>{"name":"MSE","version":"2.10.0","layer":1}</code>); <code>/v1/models</code> restricted to admin (403 for client keys); extension does not call /v1/models.
• <b>Network Resilience (D1–D3)</b>: 2 automatic retry attempts on network failure with UI stage updates; structured <code>agent_bad_image</code> logging.
• <b>Bot & Unified Proxy (D4–D5)</b>: Quiet single notification on new registration; silent dumps; standardized <code>AI_PROXY</code> naming.
• <b>Strict Audit</b>: 117 files audited, 0 hits (clean)."""

    print(f"Sending message to chat {CHAT_ID}...")
    res = call("sendMessage", {"chat_id": CHAT_ID, "text": report_text, "parse_mode": "HTML"})
    if not res.get("ok"):
        print("sendMessage failed:", res)
        return 1
    print("Message sent successfully.")

    files_to_send = [
        ARTIFACTS / "mse-2.10.0-delivery.zip",
        ARTIFACTS / "mse.user.js",
        ARTIFACTS / "mse-2.10.0.patch",
        ROOT / "RELEASE_2.10.0.md"
    ]

    for p in files_to_send:
        if not p.exists():
            print(f"File not found: {p}", file=sys.stderr)
            continue
        print(f"Sending {p.name} ({p.stat().st_size} bytes)...")
        res = call("sendDocument", {"chat_id": CHAT_ID, "caption": f"MSE 2.10.0 — {p.name}"}, {"document": p})
        if res.get("ok"):
            print(f"Successfully sent {p.name}")
        else:
            print(f"Failed to send {p.name}: {res.get('error')}", file=sys.stderr)

    return 0

if __name__ == "__main__":
    sys.exit(main())
