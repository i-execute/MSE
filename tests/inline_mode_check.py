"""A5: when inline mode is off, the owner must be told in the chat, the panel must say it, and the log must show it.

The panel is checked as it is really drawn: the notice comes from self_check() through Bot.home(), which is the same
path the start of the bot takes. Nothing here talks to Telegram: the app is a stand-in that answers getMe.

    python3 tests/inline_mode_check.py
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "Server"))

from bot import main as bot_main  # noqa: E402
from bot import screens  # noqa: E402

FAILS: list[str] = []


def check(ok: bool, what: str) -> None:
    print(("ok   " if ok else "FAIL ") + what)
    if not ok:
        FAILS.append(what)


SNAP = {
    "health": {"version": "2.3.0", "model": "deepseek-v3", "quota": 200,
               "publicUrl": "https://mse-gateway.example-tailnet.ts.net"},
    "devices": [], "allow": [], "log": [],
}


class App:
    """A goygram stand-in: getMe says what BotFather says about inline mode."""

    def __init__(self, me: dict) -> None:
        self.me = me
        self.calls: list[str] = []
        self.sent: list[str] = []

    async def get_me(self, refresh: bool = False) -> dict:
        self.calls.append("get_me")
        return self.me

    async def send_msg(self, chat_id, text):
        self.sent.append(text)
        return {"message_id": 1}

    async def delete_msg(self, chat_id, msg_id):
        return True


def panel_html(bot: "bot_main.Bot") -> str:
    """The home screen exactly as Bot.home() builds it, with the real self_check()."""
    async def render() -> str:
        snap = dict(SNAP)
        problems = await bot.self_check()
        if problems:
            snap["problems"] = problems
        return screens.home(snap).to_html()
    return asyncio.run(render())


def main() -> int:
    bot_main.OWNER_ID = 100000001
    bot_main.env_read = lambda: {"MSE_BOT_TOKEN": "x", "MSE_TAILSCALE_KEY": "tskey-x"}  # type: ignore[assignment]
    bot_main.ADMIN_TOKEN = "adm_test"                                                     # type: ignore[assignment]

    def health() -> dict:          # gw.health is a plain call, it is the router call the bot makes synchronously
        return SNAP["health"]
    bot_main.BOT_TOKEN = "1234567890:AAH-placeholder-token"                               # type: ignore[assignment]
    check(True, "setup")

    print("\n== inline mode is off: the bot says so, in the log, in the chat and on the panel")
    bot = bot_main.Bot()
    bot.app = App({"id": 1, "username": "mse_bot", "supports_inline_queries": False})
    bot.gw.health = health                                        # type: ignore[assignment]
    says: list[str] = []

    async def tell_owner(line: str) -> None:
        says.append(line)
    bot.tell_owner = tell_owner                                   # type: ignore[assignment]

    enabled = asyncio.run(bot.check_inline_mode())
    check(enabled is False, "check_inline_mode() returns False when BotFather has inline mode off")
    check(bot.inline_enabled is False, "the bot remembers it is off")

    async def on_start() -> None:
        # the same three lines run() does at start
        bot.inline_enabled = await bot.check_inline_mode()
        if bot.inline_enabled is False:
            print("     (the log line below is the one the bot writes at start)")
            await bot.tell_owner(bot_main.INLINE_WARN)
    asyncio.run(on_start())
    check(len(says) == 1 and "inline" in says[0].lower(), "the owner got one message in the chat")
    check("BotFather" in says[0], "the chat message says where to switch it on")

    problems = asyncio.run(bot.self_check())
    check(bot_main.INLINE_WARN in problems, "self_check() lists the inline problem")

    html = panel_html(bot)
    check("check these first" in html, "the panel shows a 'check these first' block")
    check("Inline Mode" in html or "inline" in html.lower(), "the panel names inline mode")
    check("BotFather" in html, "the panel says where to switch inline mode on")

    print("\n== a fallback: the server only gives bot_inline_placeholder")
    bot2 = bot_main.Bot()
    bot2.app = App({"id": 1, "username": "mse_bot", "bot_inline_placeholder": "type something"})
    check(asyncio.run(bot2.check_inline_mode()) is True, "a placeholder means inline mode is on")
    bot3 = bot_main.Bot()
    bot3.app = App({"id": 1, "username": "mse_bot", "bot_inline_placeholder": None})
    check(asyncio.run(bot3.check_inline_mode()) is False, "an empty placeholder means inline mode is off")

    print("\n== no answer from the server: no false alarm")
    class Dead(App):
        async def get_me(self, refresh: bool = False) -> dict:
            raise RuntimeError("network is down")
    bot4 = bot_main.Bot()
    bot4.app = Dead({})
    bot4.gw.health = health                                       # type: ignore[assignment]
    check(asyncio.run(bot4.check_inline_mode()) is None, "a failed getMe returns None, not False")
    check(bot_main.INLINE_WARN not in asyncio.run(bot4.self_check()), "a failed getMe does not nag the owner")

    print("\n== inline mode on: nothing is said")
    bot5 = bot_main.Bot()
    bot5.app = App({"id": 1, "username": "mse_bot", "supports_inline_queries": True})
    bot5.gw.health = health                                       # type: ignore[assignment]
    check(asyncio.run(bot5.check_inline_mode()) is True, "check_inline_mode() returns True when it is on")
    check(bot_main.INLINE_WARN not in asyncio.run(bot5.self_check()), "self_check() is quiet")
    html5 = panel_html(bot5)
    check("check these first" not in html5, "the panel has no 'check these first' block")

    print()
    if FAILS:
        print(str(len(FAILS)) + " failed")
        return 1
    print("inline check: off -> chat + self_check + panel; on -> silence; no answer -> no false alarm")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
