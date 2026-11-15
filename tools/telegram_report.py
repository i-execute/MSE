"""Post the round's report and the built files to the owner's Telegram chat (bot API, python3 only).

    python3 tools/telegram_report.py            # sends the report text and the archive
    python3 tools/telegram_report.py --text     # the report only

curl on this machine cannot reach api.telegram.org (HTTP 000), so everything goes through urllib.
"""
from __future__ import annotations

import argparse
import json
import mimetypes
import os
import sys
import urllib.error
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT.parent / "out"
API = "https://api.telegram.org/bot%s/%s"
LIMIT = 3900

REPORT = """<b>MSE 2.1 — the round is done</b>

<b>1. Bot = the OBHOD panel</b>
Screens are <code>Rich</code> objects sent through <code>send_rich</code>/<code>edit_rich</code>, so Telegram draws headings, tables and button rows instead of printing <code>&lt;tg-button&gt;</code> as text. 14 screens: panel, people/requests, model, quota, tailscale, services, log, config, update, help. 28 buttons, every one answered by a handler (checked by a test, not by eye).

<b>2. No more block fills</b>
<code>&lt;mark&gt;</code> chips are gone: a state is an icon plus coloured words ("#3f8f5f" for yes, "#b4553f" for no).

<b>3. The emoji pack, borrowed whole, off by default</b>
<code>Server/bot/icons.py</code> is the OBHOD set — <code>tgiosicons</code>, 401 ids and 61 named icons, each with a unicode fallback. <code>MSE_EMOJI=0</code> in <code>/etc/mse/mse.env</code>; switch it on with the <b>emoji pack</b> button on the config screen, or <code>MSE_EMOJI=1</code>. Off means plain emoji that every client can draw.

<b>4. Inline input, the OBHOD way</b>
A button opens the message field with a signed 10-character token already in it (HMAC of mode|field|context). You type the value, see it as a live result, tap it — the value is applied and the marker message is deleted. That is how you now enter a <b>new tailscale key</b> (it is fed straight into <code>mse-tunnel.sh up</code> and the tunnel screen shows the result), a bot token, owner id, api id/hash, a Moodle id to allow or revoke, the model and the quota. A stranger's inline query gets an empty answer.

<b>5. Checks at start</b>
<code>Bot.self_check()</code> looks at the admin token, the router (<code>/health</code>), owner id, bot token and tailscale key. Anything missing goes to the journal and shows as one quiet "check these first" line on the panel.

<b>6. Installer</b>
The bot token is required: the installer asks for it (three tries, format 1234567890:AAH... checked), and without a terminal it prints the exact command instead of "no bot token". <code>sudo: 'obhod': command not found</code> is gone (backticks in a heredoc). The bot unit is <code>python -m bot.main</code> with <code>HOME=/var/lib/mse</code>. After the services start the installer waits up to 15 s for <code>/health</code> and says whether the router answered.

<b>7. TUI</b>
The <code>████</code> progress fills are gone: a step is a check mark, its name and a short dotted rail; work runs behind a spinner. The token field is marked as required and saving without one warns instead of going quiet.

<b>Tests:</b> extension 13/13, router 9/9, gateway 14/14, TUI 19/19, bot 14 screens / 28 callbacks, <code>audit --strict</code> 0 hits.
<b>Commit:</b> <code>7999e46</code>

The screens are in this chat (the 14 messages above), <code>mse-screens.html</code> renders them as a page, and the source archive is attached.
"""


def token() -> str:
    return (os.environ.get("MSE_BOT_TOKEN") or os.environ.get("TELEGRAM_BOT_TOKEN") or "").strip()


def chat() -> str:
    return (os.environ.get("MSE_OWNER_ID") or os.environ.get("TELEGRAM_CHAT_ID") or "").strip()


def call(method: str, payload: dict | None = None, files: dict | None = None) -> dict:
    url = API % (token(), method)
    if not files:
        data = json.dumps(payload or {}).encode("utf-8")
        req = urllib.request.Request(url, data=data, headers={"content-type": "application/json"})
    else:
        boundary = "----mse" + uuid.uuid4().hex
        body = b""
        for key, value in (payload or {}).items():
            body += ("--%s\r\nContent-Disposition: form-data; name=\"%s\"\r\n\r\n%s\r\n"
                     % (boundary, key, value)).encode("utf-8")
        for key, path in files.items():
            path = Path(path)
            kind = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
            body += ("--%s\r\nContent-Disposition: form-data; name=\"%s\"; filename=\"%s\"\r\n"
                     "Content-Type: %s\r\n\r\n" % (boundary, key, path.name, kind)).encode("utf-8")
            body += path.read_bytes() + b"\r\n"
        body += ("--%s--\r\n" % boundary).encode("utf-8")
        req = urllib.request.Request(url, data=body,
                                     headers={"content-type": "multipart/form-data; boundary=" + boundary})
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return json.loads(resp.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as exc:
        return {"ok": False, "error": exc.read().decode("utf-8", "replace")[:400]}
    except (urllib.error.URLError, OSError) as exc:
        return {"ok": False, "error": str(exc)}


def send_text(text: str) -> bool:
    ok = True
    chunk = ""
    for para in text.split("\n\n"):
        if len(chunk) + len(para) + 2 > LIMIT:
            res = call("sendMessage", {"chat_id": chat(), "text": chunk, "parse_mode": "HTML",
                                       "disable_web_page_preview": True})
            ok = ok and bool(res.get("ok"))
            if not res.get("ok"):
                print("text failed:", res.get("error"), file=sys.stderr)
            chunk = para
        else:
            chunk = para if not chunk else chunk + "\n\n" + para
    if chunk:
        res = call("sendMessage", {"chat_id": chat(), "text": chunk, "parse_mode": "HTML",
                                   "disable_web_page_preview": True})
        ok = ok and bool(res.get("ok"))
        if not res.get("ok"):
            print("text failed:", res.get("error"), file=sys.stderr)
    return ok


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--text", action="store_true", help="the report only, no files")
    args = ap.parse_args()
    if not token() or not chat():
        print("set MSE_BOT_TOKEN (or TELEGRAM_BOT_TOKEN) and MSE_OWNER_ID (or TELEGRAM_CHAT_ID)", file=sys.stderr)
        return 2

    good = send_text(REPORT)
    print("report: " + ("sent" if good else "failed"))

    for path in (OUT / "MSE-2.1-source.tar.gz", OUT / "mse-screens.html"):
        if args.text or not path.exists():
            continue
        res = call("sendDocument", {"chat_id": chat(), "caption": path.name}, {"document": path})
        print(path.name + ": " + ("sent" if res.get("ok") else "failed " + str(res.get("error"))[:200]))
    return 0 if good else 1


if __name__ == "__main__":
    raise SystemExit(main())
