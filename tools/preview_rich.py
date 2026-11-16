"""Send every MSE screen to the owner's Telegram, so the Rich rendering can be checked on a real client.

This is not the bot: no polling, no handlers. It builds the same `Rich` screens the bot builds, wraps them with the
same `ScreenRich` (no stray <br> after a block tag), and hands them to `send_rich` one by one. Anything that shows
up as raw `<h2>` or `<tg-button>` text is then a transport problem, not a screen problem.

    MSE_BOT_TOKEN=... MSE_OWNER_ID=... python3 tools/preview_rich.py
    python3 tools/preview_rich.py --out preview.html      # write the HTML instead of sending anything
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "Server"))

from bot import inline, screens, ui  # noqa: E402
from bot.ui import ScreenRich  # noqa: E402

SNAP = {
    "health": {"version": "2.0.0", "model": "demo-model-a", "quota": 200, "publicUrl": "https://mse-gateway.example-tailnet.ts.net",
               "models": ["demo-model-a", "demo-model-b"]},
    "devices": [
        {"deviceId": "d1", "moodleId": "2040", "name": "Гуги", "status": "approved", "site": "moodle.example", "requests": 37, "quota": 200},
        {"deviceId": "d2", "moodleId": "2041", "name": "второй ноутбук", "status": "pending", "site": "moodle.example", "requests": 2, "quota": 200},
    ],
    "allow": [{"moodleId": "2040", "name": "Гуги"}],
    "log": [{"at": "10:00", "line": "router started on 127.0.0.1:8788"},
            {"at": "10:02", "line": "device 2040 allowed"},
            {"at": "10:04", "line": "funnel https://mse-gateway.example-tailnet.ts.net"}],
    "services": {"mse-router": "active", "mse-bot": "active"},
}

TUNNEL = {"backend": "tailscale", "state": "up", "mode": "funnel", "address": "https://mse-gateway.example-tailnet.ts.net",
          "node": "203.0.113.1", "expires": "2027-05-01"}

CFG = {"model": "demo-model-a", "quota": "200", "upstream_port": "8799", "public_url": "https://mse-gateway.example-tailnet.ts.net",
       "bot_token": "1234567890:AAH-placeholder-token", "owner_id": "100000001",
       "api_id": "10000001", "api_hash": "0123456789abcdef0123456789abcdef", "tailscale_key": "tskey-auth-example"}


def every_screen() -> list[tuple[str, object]]:
    return [
        ("the panel", screens.home(SNAP, notice="refreshed just now")),
        ("the panel, gateway down", screens.home({"error": "the gateway does not answer: connection refused"}, notice="")),
        ("people", screens.people(SNAP, notice="id 2040 is allowed")),
        ("requests", screens.people(SNAP, only="pending")),
        ("model", screens.model_screen(SNAP, notice="chosen demo-model-a")),
        ("quota", screens.quota_screen(SNAP, notice="now 200")),
        ("tailscale", screens.tunnel_screen(TUNNEL, notice="funnel is up")),
        ("tailscale, down", screens.tunnel_screen({"backend": "tailscale", "error": "tailscale is not running"})),
        ("services", screens.services_screen(SNAP, notice="mse-router restarted")),
        ("log", screens.log_screen(SNAP)),
        ("config", screens.config_screen(CFG, notice="MSE_MODEL saved")),
        ("update", screens.update_screen()),
        ("update, done", screens.update_screen({"ok": True, "tail": "already up to date\nservices restarted"})),
        ("help", screens.help_screen()),
    ]


def absorb(rich: object) -> ScreenRich:
    """Fold any screen into one ScreenRich, so the newline handling is the one the bot uses."""
    out = ScreenRich()
    out.add(rich.build() if hasattr(rich, "build") else str(rich))
    return out


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", help="write the HTML to this file instead of sending")
    ap.add_argument("--only", default="", help="send just the screens whose name contains this")
    ap.add_argument("--emoji", action="store_true", help="draw the tgiosicons pack instead of the plain fallbacks")
    args = ap.parse_args()

    ui.use_icons(args.emoji)
    inline.configure("preview")
    items = [(name, absorb(rich)) for name, rich in every_screen()]
    if args.only:
        items = [(n, r) for n, r in items if args.only.lower() in n.lower()]

    if args.out:
        body = "\n\n".join(f"<!-- {name} -->\n<div class=\"mse-screen\">{rich.to_html()}</div>" for name, rich in items)
        Path(args.out).write_text(
            "<!doctype html><meta charset=utf-8><title>MSE screens</title>"
            "<style>body{font:15px/1.5 system-ui;margin:24px;background:#eef4fb;color:#10243c}"
            ".mse-screen{background:#fff;border-radius:14px;padding:16px 18px;margin:0 0 18px;box-shadow:0 1px 3px #0002}"
            "blockquote{margin:8px 0;padding:6px 12px;border-left:3px solid #9ec8ef;color:#33506f}"
            "table{border-collapse:collapse}td,th{padding:4px 8px;border-bottom:1px solid #e3ecf5}"
            "code{background:#eef4fb;padding:1px 5px;border-radius:5px;font-size:13px}"
            "tg-button{display:inline-block;margin:4px 6px 0 0;padding:6px 12px;border-radius:9px;background:#dceaf9}"
            "h2{margin:0 0 6px;font-size:20px}footer{margin-top:10px;color:#7d94ad;font-size:12px}hr{border:0;border-top:1px solid #e3ecf5;margin:12px 0}</style>"
            + body,
            encoding="utf-8")
        print("wrote " + args.out + " (" + str(len(items)) + " screens)")
        return 0

    token = os.environ.get("MSE_BOT_TOKEN", "")
    owner = int(os.environ.get("MSE_OWNER_ID", "0") or 0)
    if not token or not owner:
        print("set MSE_BOT_TOKEN and MSE_OWNER_ID, or use --out", file=sys.stderr)
        return 2

    from goygram import GoyGram

    app = GoyGram(bot_token=token, app_name="MSE", app_version="2.0", device_model="server", system_version="linux",
                  default_transport="api", intake="api")
    sent = 0
    for name, rich in items:
        try:
            res = await app.send_rich(owner, rich, via="bot")
            sent += 1
            print("sent  " + name + "  → " + str(getattr(res, "message_id", res))[:40])
        except Exception as exc:  # noqa: BLE001 — one screen failing must not stop the rest
            print("FAIL  " + name + ": " + str(exc)[:200], file=sys.stderr)
        await asyncio.sleep(0.6)          # a bot may not post faster than about 20 messages a minute
    print(str(sent) + "/" + str(len(items)) + " screens delivered to " + str(owner))
    return 0 if sent else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
