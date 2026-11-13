"""MSE bot: the owner's control panel in Telegram, in the manner of OBHOD.

    sudo mse-bot            (or: python3 -m bot)
    systemctl status mse-bot

What it does: takes the device applications (a key registered with a Moodle id, waiting), lets the owner allow
them by /allow <moodleId> or with one tap, shows the state of the gateway (devices, quota, log), changes the
model and the quota through the router's admin API, and turns the tailscale funnel on and off.

Everything it can do is done through the admin API of the router on the loopback and through mse-tunnel.sh —
never by editing files, never with the model key (which it does not have and cannot read).
"""
from __future__ import annotations

import asyncio
import logging
import os
import sys
from typing import Any

from goygram import GoyGram

from . import ui
from .client import Gateway, GatewayError, tunnel_do, tunnel_status

log = logging.getLogger("mse.bot")

GATEWAY_URL = os.environ.get("MSE_ADMIN_URL", "http://127.0.0.1:8788").rstrip("/")
ADMIN_TOKEN = os.environ.get("MSE_ADMIN_TOKEN", "")
BOT_TOKEN = os.environ.get("MSE_BOT_TOKEN", "")
OWNER_ID = int(os.environ.get("MSE_OWNER_ID", "0") or 0)
OWNER_USERNAME = os.environ.get("MSE_OWNER_USERNAME", "").lstrip("@").lower()
TUNNEL_SCRIPT = os.environ.get("MSE_TUNNEL_SCRIPT", "/usr/local/bin/mse-tunnel.sh")
GATEWAY_PORT = int(os.environ.get("MSE_PORT", "8788") or 8788)


def is_owner(evt: object) -> bool:
    who = int(getattr(evt, "from_id", 0) or 0)
    if OWNER_ID and who == OWNER_ID:
        return True
    if OWNER_USERNAME:
        user = getattr(evt, "from_user", None) or getattr(evt, "user", None)
        username = ""
        if isinstance(user, dict):
            username = str(user.get("username") or "")
        else:
            username = str(getattr(user, "username", "") or "")
        if username and username.lower() == OWNER_USERNAME:
            return True
    # with neither an id nor a username configured the bot stays closed: silence is the safe default
    return False


class Bot:
    def __init__(self) -> None:
        self.gw = Gateway(GATEWAY_URL, ADMIN_TOKEN)
        self.app: Any = None
        self.pending_input: dict[int, str] = {}

    # ------------------------------------------------------------------ rendering
    async def snap(self) -> dict[str, Any]:
        try:
            return await asyncio.to_thread(self.gw.snapshot)
        except Exception as exc:  # never let a screen fail: a bot that dies on a bad gateway is useless
            return {"health": {}, "devices": [], "log": [], "error": str(exc)}

    async def render(self, chat_id: int, msg_id: int, screen: Any) -> int:
        html = screen.to_html() if hasattr(screen, "to_html") else str(screen)
        if msg_id:
            try:
                await self.app.edit_msg(chat_id, msg_id, html)
                return msg_id
            except Exception as exc:
                log.debug("edit failed, sending a new one: %s", exc)
        sent = await self.app.send_msg(chat_id, html)
        return int(getattr(sent, "message_id", 0) or (sent.get("message_id") if isinstance(sent, dict) else 0) or 0)

    async def toast(self, evt: object, text: str, alert: bool = False) -> None:
        try:
            await asyncio.wait_for(evt.answer(text, alert=alert), 6)
        except Exception as exc:
            log.debug("toast failed: %s", exc)

    # ------------------------------------------------------------------ screens
    async def home(self, chat_id: int, msg_id: int = 0) -> None:
        snap = await self.snap()
        error = snap.get("error")
        blocks_ok = ui.home(snap)
        if error and not snap.get("health"):
            blocks_ok = ui.screen("MSE · шлюз", subtitle="шлюз не отвечает", blocks=[f"<p>{ui.esc(error)}</p>"],
                                  buttons=[ui.row(ui.button("ещё раз", "home"))])
        await self.render(chat_id, msg_id, blocks_ok)

    # ------------------------------------------------------------------ handlers
    async def on_message(self, evt: object) -> None:
        if not is_owner(evt):
            return
        chat_id = int(getattr(evt, "chat_id", 0) or 0)
        text = str(getattr(evt, "text", "") or "").strip()
        if not text:
            return
        if chat_id in self.pending_input and not text.startswith("/"):
            await self.handle_input(chat_id, self.pending_input.pop(chat_id), text)
            return
        if not text.startswith("/"):
            await self.home(chat_id)
            return
        word = text.split()[0][1:].split("@")[0].lower()
        rest = text[len(word) + 1:].strip()
        if word in ("start", "menu", "home"):
            await self.home(chat_id)
        elif word == "state":
            await self.text_state(chat_id)
        elif word == "pending":
            snap = await self.snap()
            await self.render(chat_id, 0, ui.devices(snap, only="pending"))
        elif word == "devices":
            snap = await self.snap()
            await self.render(chat_id, 0, ui.devices(snap))
        elif word == "allow":
            if not rest:
                await self.app.send_msg(chat_id, "формат: /allow <moodleId>")
                return
            await self.allow(chat_id, 0, rest)
        elif word in ("revoke", "disallow"):
            if not rest:
                await self.app.send_msg(chat_id, "формат: /revoke <moodleId|deviceId>")
                return
            await self.revoke(chat_id, 0, rest)
        elif word == "quota":
            if not rest:
                snap = await self.snap()
                await self.render(chat_id, 0, ui.quota_screen(snap))
                return
            await self.set_quota(chat_id, 0, rest)
        elif word == "model":
            if not rest:
                snap = await self.snap()
                await self.render(chat_id, 0, ui.model_screen(snap))
                return
            await self.set_model(chat_id, 0, rest)
        elif word == "tunnel":
            await self.tunnel(chat_id, 0, "show")
        elif word == "log":
            snap = await self.snap()
            await self.render(chat_id, 0, ui.log(snap))
        else:
            await self.app.send_msg(chat_id, ui.help_screen(True).to_html())

    async def handle_input(self, chat_id: int, kind: str, value: str) -> None:
        if kind == "allow":
            await self.allow(chat_id, 0, value)
        elif kind == "model":
            await self.set_model(chat_id, 0, value)

    async def text_state(self, chat_id: int) -> None:
        snap = await self.snap()
        health = snap.get("health") or {}
        devices = snap.get("devices") or []
        lines = [
            "адрес: " + str(health.get("publicUrl") or "—"),
            "модель: " + str(health.get("model") or "—") + " · квота " + str(health.get("quota") or "—"),
            "устройств: " + str(len(devices)) + " · работают " + str(len([d for d in devices if d.get("status") == "active"]))
            + " · ждут " + str(len([d for d in devices if d.get("status") == "pending"])),
        ]
        if snap.get("error"):
            lines.append("ошибка: " + str(snap["error"]))
        await self.app.send_msg(chat_id, ui.pre("\n".join(lines)).replace("<pre>", "").replace("</pre>", ""))

    async def allow(self, chat_id: int, msg_id: int, moodle_id: str) -> None:
        moodle_id = str(moodle_id or "").strip()
        if not moodle_id.isdigit():
            await self.app.send_msg(chat_id, "moodleId — это число, например 12345")
            return
        try:
            await asyncio.to_thread(self.gw.allow, moodle_id)
        except GatewayError as exc:
            snap = await self.snap()
            await self.render(chat_id, msg_id, ui.devices(snap, only="pending"))
            await self.app.send_msg(chat_id, "не вышло: " + exc.message)
            return
        snap = await self.snap()
        await self.render(chat_id, msg_id, ui.devices(snap, only="pending"))
        await self.app.send_msg(chat_id, "ID " + moodle_id + " пущен")

    async def revoke(self, chat_id: int, msg_id: int, needle: str) -> None:
        try:
            dev = await asyncio.to_thread(self.gw.device_of, needle)
            if dev is None:
                await self.disallow(chat_id, str(needle))
                return
            await asyncio.to_thread(self.gw.revoke, str(dev.get("deviceId")))
        except GatewayError as exc:
            await self.app.send_msg(chat_id, "не вышло: " + exc.message)
            return
        snap = await self.snap()
        await self.render(chat_id, msg_id, ui.devices(snap))

    async def disallow(self, chat_id: int, moodle_id: str) -> None:
        await asyncio.to_thread(self.gw.disallow, str(moodle_id))
        await self.app.send_msg(chat_id, "ID " + str(moodle_id) + " убран из списка")

    async def set_quota(self, chat_id: int, msg_id: int, value: str) -> None:
        try:
            quota = int(str(value).strip())
            if quota < 0:
                raise ValueError("negative")
        except ValueError:
            await self.app.send_msg(chat_id, "квота — целое число, например 200")
            return
        await asyncio.to_thread(self.gw.set_quota, quota)
        snap = await self.snap()
        await self.render(chat_id, msg_id, ui.quota_screen(snap, notice="теперь " + str(quota)))

    async def set_model(self, chat_id: int, msg_id: int, value: str) -> None:
        """The model belongs to the backend; the router only reports what it offers, so the bot remembers the
        choice in the env file of the stack and asks for a restart of the backend."""
        model = str(value or "").strip()
        if not model:
            return
        env_path = os.environ.get("MSE_ENV_FILE", "/etc/mse/mse.env")
        try:
            with open(env_path, "r", encoding="utf-8") as fh:
                lines = [l.rstrip("\n") for l in fh]
        except OSError:
            lines = []
        lines = [l for l in lines if not l.startswith("MSE_MODEL=")]
        lines.append("MSE_MODEL=" + model)
        try:
            with open(env_path, "w", encoding="utf-8") as fh:
                fh.write("\n".join(lines) + "\n")
        except OSError as exc:
            await self.app.send_msg(chat_id, "не вышло записать " + env_path + ": " + str(exc))
            return
        snap = await self.snap()
        await self.render(chat_id, msg_id, ui.model_screen(snap, notice="выбрано " + model + " · перезапустите бэкенд"))

    async def tunnel(self, chat_id: int, msg_id: int, action: str) -> None:
        if action == "show":
            info = await asyncio.to_thread(tunnel_status, TUNNEL_SCRIPT)
            await self.render(chat_id, msg_id, ui.tunnel_screen(info))
            return
        ok, text = await asyncio.to_thread(tunnel_do, action, TUNNEL_SCRIPT, GATEWAY_PORT)
        info = await asyncio.to_thread(tunnel_status, TUNNEL_SCRIPT)
        await self.render(chat_id, msg_id, ui.tunnel_screen(info, notice=text if ok else "", error="" if ok else text))

    async def on_command(self, evt: object) -> None:
        await self.on_message(evt)

    async def on_callback(self, evt: object) -> None:
        if not is_owner(evt):
            await self.toast(evt, "не для вас")
            return
        data = str(getattr(evt, "data", "") or "")
        chat_id = int(getattr(evt, "chat_id", 0) or 0)
        msg_id = int(getattr(evt, "msg_id", 0) or 0)
        parts = data.split(":")
        head = parts[0] if parts else ""
        try:
            if data == "home" or head == "home":
                await self.toast(evt, "обновлено")
                await self.home(chat_id, msg_id)
            elif data == "dev:list":
                await self.toast(evt, "")
                await self.render(chat_id, msg_id, ui.devices(await self.snap()))
            elif data == "dev:pending":
                await self.toast(evt, "")
                await self.render(chat_id, msg_id, ui.devices(await self.snap(), only="pending"))
            elif data == "dev:allowask":
                self.pending_input[chat_id] = "allow"
                await self.toast(evt, "пришлите ID")
                await self.app.send_msg(chat_id, "пришлите Moodle ID одним сообщением")
            elif head == "dev" and len(parts) >= 3 and parts[1] == "approve":
                await asyncio.to_thread(self.gw.approve, parts[2])
                await self.toast(evt, "пущен")
                await self.render(chat_id, msg_id, ui.devices(await self.snap()))
            elif head == "dev" and len(parts) >= 3 and parts[1] == "revoke":
                await asyncio.to_thread(self.gw.revoke, parts[2])
                await self.toast(evt, "отозван", alert=False)
                await self.render(chat_id, msg_id, ui.devices(await self.snap()))
            elif data == "model:show":
                await self.toast(evt, "")
                await self.render(chat_id, msg_id, ui.model_screen(await self.snap()))
            elif head == "model" and len(parts) >= 3 and parts[1] == "set":
                await self.toast(evt, "запомнил")
                await self.set_model(chat_id, msg_id, ":".join(parts[2:]))
            elif data == "quota:show":
                await self.toast(evt, "")
                await self.render(chat_id, msg_id, ui.quota_screen(await self.snap()))
            elif head == "quota" and len(parts) >= 3 and parts[1] == "set":
                await self.toast(evt, "квота " + parts[2])
                await self.set_quota(chat_id, msg_id, parts[2])
            elif data == "log:show":
                await self.toast(evt, "")
                await self.render(chat_id, msg_id, ui.log(await self.snap()))
            elif data == "tunnel:show":
                await self.toast(evt, "")
                await self.tunnel(chat_id, msg_id, "show")
            elif head == "tunnel":
                await self.toast(evt, "делаю…")
                await self.tunnel(chat_id, msg_id, parts[1] if len(parts) > 1 else "show")
            else:
                await self.toast(evt, "не знаю такой кнопки")
        except GatewayError as exc:
            await self.toast(evt, "ошибка: " + exc.message, alert=True)
        except Exception as exc:  # a broken screen must not take the bot down
            log.exception("callback failed: %s", exc)
            await self.toast(evt, "ошибка: " + str(exc)[:120], alert=True)

    # ------------------------------------------------------------------ run
    def build(self) -> GoyGram:
        app = GoyGram(bot_token=BOT_TOKEN, app_name="MSE", app_version="2.0", device_model="server", system_version="linux")
        app.on_msg(fn=self.on_message)
        app.on_cb(fn=self.on_callback)
        self.app = app
        return app

    async def run(self) -> None:
        app = self.build()
        await self.notify_start()
        await app.run()

    async def notify_start(self) -> None:
        if not OWNER_ID:
            return
        try:
            snap = await self.snap()
            await self.render(OWNER_ID, 0, ui.home(snap))
        except Exception as exc:
            log.debug("start notice failed: %s", exc)


def main() -> int:
    logging.basicConfig(level=os.environ.get("MSE_LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    if not BOT_TOKEN:
        print("MSE_BOT_TOKEN is not set: nothing to run", file=sys.stderr)
        return 2
    bot = Bot()
    asyncio.run(bot.run())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
