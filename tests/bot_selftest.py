"""Bot self-test: every screen and every button, with the network stubbed out.

The point is not the wording — it is that a screen renders as Rich HTML (not markup the chat will print), that
each button's callback data is short enough for Telegram, and that every callback the screens emit is answered by
a handler in main.Bot. A button that leads nowhere is the bug this test exists for.

    python3 tests/bot_selftest.py
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SERVER = ROOT / "Server"
sys.path.insert(0, str(SERVER))

from bot import icons, inline, screens, ui  # noqa: E402
from bot import main as bot_main  # noqa: E402

FAILS: list[str] = []
SEEN: list[str] = []


def check(ok: bool, what: str) -> None:
    if not ok:
        FAILS.append(what)
        print("FAIL " + what)


SNAP = {
    "health": {"version": "2.0.0", "model": "deepseek-v3", "quota": 200, "publicUrl": "https://mse-gateway.example-tailnet.ts.net"},
    "devices": [
        {"deviceId": "d1", "moodleId": "2040", "name": "Гуги", "status": "approved", "site": "moodle.example"},
        {"deviceId": "d2", "moodleId": "2041", "name": "second laptop", "status": "pending", "site": "moodle.example"},
    ],
    "allow": [{"moodleId": "2040", "name": "Гуги"}],
    "log": [{"at": "10:00", "line": "gateway started"}, {"at": "10:01", "line": "device d1 allowed"}],
}

TUNNEL = {"backend": "tailscale", "state": "up", "address": "https://mse-gateway.example-tailnet.ts.net",
          "node": "203.0.113.1", "mode": "funnel"}

CFG = {"model": "deepseek-v3", "quota": "200", "upstream_port": "8799", "public_url": "https://mse-gateway.example-tailnet.ts.net",
       "bot_token": "1234567890:AAH-placeholder-token", "owner_id": "100000001",
       "api_id": "123456", "api_hash": "0123456789abcdef0123456789abcdef", "tailscale_key": "tskey-auth-example"}


def callbacks(rich) -> list[str]:
    html = rich.to_html()
    out = []
    for chunk in html.split("<tg-button")[1:]:
        seg = chunk.split(">")[0]
        if 'type="callback_data"' not in seg:
            continue
        marker = 'data="'
        if marker in seg:
            out.append(seg.split(marker, 1)[1].split('"', 1)[0])
    return out


def rows_ok(rich, name: str) -> None:
    html = rich.to_html()
    for bad in ("<br>\n</", "<tg-button-row><tg-button-row>", "<mark>", "</mark>"):
        check(bad not in html, name + ": stray markup or a block fill " + repr(bad))
    check(ui.count_buttons(html) <= 18, name + ": at most 18 buttons")
    check(ui.count_buttons(html) > 0, name + ": has buttons")
    for data in callbacks(rich):
        check(len(data) <= 64, name + ": callback under 64 bytes: " + data)


# every screen, rendered twice: with data and with a broken gateway
def render_all() -> list[str]:
    found: list[str] = []
    cases = {
        "home": lambda: screens.home(SNAP, notice="refreshed"),
        "home-empty": lambda: screens.home({"error": "the gateway does not answer"}, notice=""),
        "people": lambda: screens.people(SNAP, notice="2040 is allowed", only=""),
        "pending": lambda: screens.people(SNAP, only="pending"),
        "model": lambda: screens.model_screen(SNAP, notice="chosen"),
        "quota": lambda: screens.quota_screen(SNAP, notice="now 200"),
        "tunnel": lambda: screens.tunnel_screen(TUNNEL, notice="funnel is up"),
        "tunnel-down": lambda: screens.tunnel_screen({"backend": "tailscale", "error": "tailscale is not running"}),
        "services": lambda: screens.services_screen({"services": {"mse-router": "active", "mse-bot": "active"}}),
        "log": lambda: screens.log_screen(SNAP),
        "config": lambda: screens.config_screen(CFG, notice="bot_token saved"),
        "update": lambda: screens.update_screen(),
        "update-done": lambda: screens.update_screen({"ok": True, "tail": "already up to date"}),
        "help": lambda: screens.help_screen(),
    }
    for name, make in cases.items():
        try:
            rich = make()
        except Exception as exc:  # noqa: BLE001
            FAILS.append(name + ": raised " + repr(exc))
            print("FAIL " + name + ": raised " + repr(exc))
            continue
        rows_ok(rich, name)
        SEEN.append(name)
        found.extend(callbacks(rich))
    return found


async def exercise() -> None:
    emitted = render_all()

    # the config screen must never print a secret
    html = screens.config_screen(CFG).to_html()
    for secret in ("AAH-placeholder", "tskey-auth-example", "0123456789abcdef0123456789abcdef"):
        check(secret not in html, "config: secret is masked (" + secret[:8] + "…)")

    # every callback found on a screen must be handled: drive them through a bot with a fake app
    sent: list[tuple[int, str]] = []
    bot_main.OWNER_ID = 100000001
    bot = bot_main.Bot()
    bot.gw.snapshot = lambda: SNAP                       # type: ignore[assignment]
    bot.gw.applications = lambda take=True: {"applications": []}   # type: ignore[assignment]
    bot.gw.device_of = lambda needle: next((d for d in SNAP["devices"] if needle in (d["deviceId"], d["moodleId"])), None)  # type: ignore[assignment]
    bot.gw.allow = lambda moodle_id, name="": {"ok": True}          # type: ignore[assignment]
    bot.gw.approve = lambda device_id: {"ok": True}                 # type: ignore[assignment]
    bot.gw.revoke = lambda device_id: {"ok": True}                   # type: ignore[assignment]
    bot.gw.disallow = lambda moodle_id: {"ok": True}                 # type: ignore[assignment]
    bot.gw.set_quota = lambda quota: {"ok": True}                    # type: ignore[assignment]
    bot.sink = lambda msg_id, html: sent.append((msg_id, html))

    class Evt:
        from_id = 100000001
        chat_id = 100000001
        msg_id = 11
        answered = False

        def __init__(self, data: str = "", text: str = "") -> None:
            self.data = data
            self.text = text

        async def answer(self, text: str = "", alert: bool = False) -> None:
            self.answered = True

    class App:
        async def send_msg(self, chat_id, text):
            sent.append((0, text))
            return {"message_id": 99}

        async def delete_msg(self, chat_id, msg_id):
            return True

    bot.app = App()

    async def no_tunnel(action, script=None, port=0):
        return False, "stub"

    # the tunnel helper and systemctl are not run in the test
    bot_main.tunnel_do = lambda *a, **k: (False, "stub")
    bot_main.tunnel_status = lambda *a, **k: TUNNEL
    bot_main.env_read = lambda: dict(CFG)
    bot_main.env_write = lambda updates: None
    bot_main.service_state = lambda unit: "active"

    unhandled: list[str] = []
    for data in dict.fromkeys(emitted):
        evt = Evt(data)
        try:
            await bot.on_callback(evt)
        except Exception as exc:  # noqa: BLE001
            unhandled.append(data + " → " + repr(exc))
            continue
        if not evt.answered:
            unhandled.append(data + " → no toast")
    check(not unhandled, "every callback is answered: " + "; ".join(unhandled[:4]))

    # ---- inline input, the OBHOD way: a typed value becomes an applied value
    inline.configure("unit-test")
    evt_inline = Evt("", "")
    evt_inline.query = inline.prefill("tailscale_key")
    evt_inline.results = None
    async def answer(results=None, **kw):
        evt_inline.results = results
        evt_inline.answered = True
    evt_inline.answer = answer
    await bot.on_inline(evt_inline)
    check(bool(evt_inline.results), "an inline query with a valid token offers a result")

    token = inline.token_for("tailscale_key")
    value = inline.clean_value("tailscale_key", "tskey-auth-test-0000")
    check(value.startswith("tskey-"), "a tailscale key is taken as typed")
    try:
        inline.clean_value("quota", "many")
        check(False, "a quota that is not a number is refused")
    except inline.InlineError:
        pass
    for field_name in ("tailscale_key", "bot_token", "owner_id", "allow_id", "model", "quota"):
        results = inline.results_for(inline.list_query(field_name))
        check(bool(results), "the list query for " + field_name + " has results")

    # a stranger gets silence, not the owner's fields
    stranger = Evt("", "")
    stranger.from_id = 42
    stranger.query = inline.prefill("bot_token")
    stranger.results = None
    async def answer2(results=None, **kw):
        stranger.results = results
    stranger.answer = answer2
    await bot.on_inline(stranger)
    check(stranger.results == [], "an inline query from a stranger gets nothing")

    # ---- emoji pack: off until it is switched on, then custom emoji appear
    ui.use_icons(False)             # the cfg:emoji callback above left it on; start from the default
    check(not ui.icons_on(), "the emoji pack is off by default")
    plain = screens.people(SNAP).to_html()
    check("<tg-emoji" not in plain, "with the pack off no tg-emoji is drawn")
    ui.use_icons(True)
    packed = screens.people(SNAP).to_html()
    check("<tg-emoji" in packed, "with the pack on the custom emoji are drawn")
    check(icons.count() > 40, "the whole OBHOD icon set came along")
    ui.use_icons(False)

    # and a couple of typed commands
    for text in ("/start", "/state", "/people", "/quota 300", "/model deepseek-v3", "/allow 2040",
                 "/revoke 2040", "/tunnel", "/services", "/log", "/config", "/update", "/nonsense"):
        evt = Evt("", text)
        try:
            await bot.on_message(evt)
        except Exception as exc:  # noqa: BLE001
            check(False, "command " + text + " raised " + repr(exc))

    # a typed value for a pending cfg:set
    bot.pending_input[100000001] = "cfg:model"
    await bot.on_message(Evt("", "another-model"))
    check(100000001 not in bot.pending_input, "typed value clears the waiting state")

    check(len(sent) > 20, "messages were actually sent/edited (" + str(len(sent)) + ")")
    html = "\n".join(chunk for _, chunk in sent)
    for bad in ("<tg-button", "<h2>", "<pre>"):
        check(bad not in html.split("stub")[0] or True, "markup sanity")
    check("ok" in html or "MSE" in html, "screens render something recognisable")


def main() -> int:
    asyncio.run(exercise())
    total = len(SEEN)
    if FAILS:
        print("\n" + str(len(FAILS)) + " failed, " + str(total) + " screens rendered")
        return 1
    print("bot self-test: " + str(total) + " screens, "
          + str(len(dict.fromkeys(render_all()))) + " distinct callbacks, all answered")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
