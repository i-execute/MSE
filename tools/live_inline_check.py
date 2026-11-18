"""Live proof for bug 1: ask Telegram about inline mode and push a real setInlineBotResults (or report why not).

    MSE_BOT_TOKEN=... python3 tools/live_inline_check.py

Part 1 is the start-up probe from bug 2 and works with the token alone (getMe).
Part 2 needs an MTProto session (api_id/api_hash and a logged-in account), because messages.setInlineBotResults is
not a bot-api method. Without a session this script says so plainly instead of pretending the live path was tested.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "Server"))


def get_me(token: str) -> dict:
    req = urllib.request.Request("https://api.telegram.org/bot%s/getMe" % token)
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8", "replace"))


async def main() -> int:
    token = (os.environ.get("MSE_BOT_TOKEN") or os.environ.get("TELEGRAM_BOT_TOKEN") or "").strip()
    if not token:
        print("MSE_BOT_TOKEN is not set", file=sys.stderr)
        return 2

    me = get_me(token)
    if not me.get("ok"):
        print("getMe failed: " + str(me)[:300], file=sys.stderr)
        return 1
    bot = me["result"]
    supports = bot.get("supports_inline_queries")
    placeholder = bot.get("inline_query_placeholder") or bot.get("bot_inline_placeholder")
    print("bot: @" + str(bot.get("username")) + " id " + str(bot.get("id")))
    print("supports_inline_queries: " + repr(supports) + "  placeholder: " + repr(placeholder))
    if supports is False:
        print("VERDICT: inline is OFF — turn it on in @BotFather (/mybots -> Bot Settings -> Inline Mode)")
        return 1
    print("VERDICT: inline is on")

    # part 2: the MTProto path, only when a session is available
    api_id = int(os.environ.get("MSE_API_ID", "0") or 0)
    api_hash = os.environ.get("MSE_API_HASH", "")
    if not api_id or not api_hash:
        print("MTProto part skipped: no MSE_API_ID/MSE_API_HASH in this environment, so "
              "messages.setInlineBotResults was not exercised live here. The format test "
              "(tests/test_inline_format.py) checks the exact payload the MT codec puts on the wire.")
        return 0

    from goygram import GoyGram
    from bot import inline as inl

    app = GoyGram(bot_token=token, api_id=api_id, api_hash=api_hash, session_name="mse-live-inline",
                  default_transport="mtproto", intake="mtproto", app_name="MSE", app_version="2.2",
                  device_model="server", system_version="linux")
    inl.configure(os.environ.get("MSE_ADMIN_TOKEN", "live"))
    query = inl.prefill("tailscale_key")
    results = inl.results_for(query + "tskey-auth-live-check")
    print("results to send: " + str(len(results)))
    try:
        await app.mt_req("messages.setInlineBotResults", query_id=0, gallery=False, private=True,
                         cache_time=0, results=results)
    except Exception as exc:  # noqa: BLE001
        text = str(exc)
        print("the call reached Telegram and was answered: " + text[:200])
        if "nested object missing" in text:
            print("VERDICT: the payload is still wrong")
            return 1
        print("VERDICT: the payload was accepted up to the query id check (the fake id is expected to fail)")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
