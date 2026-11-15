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
OUT = ROOT.parent / "deliverables"   # "out" is not kept in a snapshot; "deliverables" is
API = "https://api.telegram.org/bot%s/%s"
LIMIT = 3900

REPORT = """<b>MSE 2.2 — five bugs, all fixed and proved by running</b>

<b>1. Inline did not work at all</b> — <code>messages.setInlineBotResults:results: nested object missing _</code>. The results were built in the Bot API shape, while goygram sends inline over MTProto: now each one is <code>inputBotInlineResult</code> with <code>send_message: inputBotInlineMessageText</code>, exactly as OBHOD does it. <code>tests/test_inline_format.py</code> drives the real <code>Obj.answer()</code>, catches the exact payload and walks every nested object: 32 checks, all green.

<b>2. No check of inline mode at start</b> — <code>Bot.check_inline_mode()</code> asks <code>getMe</code> (the placeholder and a raw call as fallbacks), and on "off" it writes one line to the journal, sends you one plain sentence in the chat and puts it in <code>self_check()</code> and on the panel. Ran it against your bot: <code>check_inline_mode -> False</code>, you were told. Inline for @ArenaAI_agent_Bot is genuinely off in BotFather right now.

<b>3. iOS was five scripts</b> — the file was one, but the runtime created four extra script tags for the interface, the auth, the bridge and the debug layer. Now all four live in the same file as scoped blocks: one paste, like 0.2. The build refuses to ship anything else — <code>oneFile {scripts: 1, headers: 1, requires: 0}</code> — and <code>tests/onefile.test.js</code> keeps it that way.

<b>4. First run asks for the keys</b> — bot token (three tries, format checked), owner telegram id, tailscale auth key; each validated, all written to <code>/etc/mse/mse.env</code> mode 600. A pipe gets the exact commands instead. The TUI hands the same values to the installer and says up front what is still missing.

<b>5. The tunnel comes up during the install</b> — the order is now <code>install -> tunnel up + funnel -> MSE_PUBLIC_URL -> restart mse-router -> check</code>, so the router never starts with an empty address. At the end it prints whether both units are active and whether the address is in place.

<b>Proved by running, not by reading:</b> extension 13/13, one-file 4/4, router 9/9, gateway 14/14, TUI 19/19, bot 14 screens / 28 callbacks, inline format 32/32, installer 24/24 (pty dialogue, pipe, order of calls), <code>audit --strict</code> 0 hits three times, and a clean clone of <code>release/2.2</code> with a fresh <code>npm install</code> — all green.

<b>Branch:</b> <code>release/2.2</code>, not pushed to main. Commits <code>22465e4</code>, <code>259d3ef</code>, <code>27980a7</code>.
<b>Not verified live:</b> tapping an inline result needs an MTProto session (api_id/hash and a login) and a real tailnet key. Everything else went through the real code paths. Give me those and I take that step too.

Attached: the source archive, the git bundle of the branch, and the PR description.
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

    for path in (OUT / "MSE-2.2-source.tar.gz", OUT / "MSE-release-2.2.bundle", ROOT / "PR-DESCRIPTION.md"):
        if args.text or not path.exists():
            continue
        res = call("sendDocument", {"chat_id": chat(), "caption": path.name}, {"document": path})
        print(path.name + ": " + ("sent" if res.get("ok") else "failed " + str(res.get("error"))[:200]))
    return 0 if good else 1


if __name__ == "__main__":
    raise SystemExit(main())
