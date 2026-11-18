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
    if not TOKEN:
        print("ERROR: MSE_BOT_TOKEN is not set", file=sys.stderr)
        return 1

    report_text = """<b>MSE 2.11.0 Release Delivered</b>

<b>Key Highlights:</b>
• <b>Unified Button UI Kit (A4)</b>: Standardized 28px height, 8px border-radius, typography, and glowing borders across all screens.
• <b>Single Dynamic Check Button (A2)</b>: Merged "Integrate request" into a unified <code>check</code> control that dynamically reflects status (check / checking… / active / waiting / denied).
• <b>Instant DEBUG Light (A1)</b>: Immediate toggle of the DEBG indicator on tap; triggers instant diagnostic event.
• <b>Network Log Enhancements (A3, A5)</b>: Styled copy button with press glow/toast; monochrome list/lines icon for account menu.
• <b>Clean Question Subtitle (A7)</b>: Removed "question 1" bug; popover header displays <code>question #qid</code> or generic <code>question</code>.
• <b>Active Model Chip (A8)</b>: Caches model from agent responses into <code>localStorage</code>; persistently displayed for active verified keys without calling <code>/v1/models</code>.
• <b>Agent UI Cleanup (A6)</b>: Removed percentage/count indicators from agent answer rows; detailed stats preserved in dumps.
• <b>Gateway Settings (A9, A11)</b>: Renamed to "gateway settings" with monochrome gear icon; explicit status in API (accepted/pending/revoked).
• <b>Immediate Bot Alerts (A10)</b>: Telegram bot immediately delivers new registration alerts with inline <b>добавить</b> and <b>отклонить</b> buttons directly in the card; silent otherwise.
• <b>Schema-Layer 1 Constructor (D1–D5)</b>: Registry of 18 question types, full constructor reconstruction protocol in dumps, questionless page dump suppression, server-side qtype logging.
• <b>Live Stand Reliability (B1–B2)</b>: Probe accepts both "MSE" and "MSE gateway"; client SSE agent timeout extended to 120s.
• <b>Strict Audit</b>: 123 files audited, 0 hits (clean)."""

    print(f"Sending message to chat {CHAT_ID}...")
    res = call("sendMessage", {"chat_id": CHAT_ID, "text": report_text, "parse_mode": "HTML"})
    if not res.get("ok"):
        print("sendMessage failed:", res)
        return 1
    print("Message sent successfully.")

    files_to_send = [
        ARTIFACTS / "mse-2.11.0-delivery.zip",
        ARTIFACTS / "mse.user.js",
        ARTIFACTS / "mse-2.11.0.patch",
        ROOT / "RELEASE_2.11.0.md"
    ]

    for p in files_to_send:
        if not p.exists():
            print(f"File not found: {p}", file=sys.stderr)
            continue
        print(f"Sending {p.name} ({p.stat().st_size} bytes)...")
        res = call("sendDocument", {"chat_id": CHAT_ID, "caption": f"MSE 2.11.0 — {p.name}"}, {"document": p})
        if res.get("ok"):
            print(f"Successfully sent {p.name}")
        else:
            print(f"Failed to send {p.name}: {res.get('error')}", file=sys.stderr)

    return 0

if __name__ == "__main__":
    sys.exit(main())
