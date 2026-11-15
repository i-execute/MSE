"""MSE bot: the owner's control panel in Telegram, rendered as Rich screens (a port of the OBHOD panel).

    sudo mse-bot            (or: python3 -m bot.main)
    systemctl status mse-bot

Every screen goes out through `send_rich`/`edit_rich`, so Telegram draws real headings, tables and a row of
buttons instead of the raw `<tg-button>` markup. What the buttons do: people (let in, decline, revoke), requests,
model, quota, tailscale (up, funnel, serve, off), services (start, stop, restart), log, config (masked secrets,
edit one value), update, refresh.

It never touches files it does not own: the router is reached through its admin API on the loopback, the tunnel
through mse-tunnel.sh, the services through systemctl, the update through install.sh --update.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

from goygram import GoyGram

from . import icons, inline, screens, ui
from .client import Gateway, GatewayError, tunnel_do, tunnel_status

log = logging.getLogger("mse.bot")

GATEWAY_URL = os.environ.get("MSE_ADMIN_URL", "http://127.0.0.1:8788").rstrip("/")
ADMIN_TOKEN = os.environ.get("MSE_ADMIN_TOKEN", "")
BOT_TOKEN = os.environ.get("MSE_BOT_TOKEN", "")
OWNER_ID = int(os.environ.get("MSE_OWNER_ID", "0") or 0)
OWNER_USERNAME = os.environ.get("MSE_OWNER_USERNAME", "").lstrip("@").lower()
TUNNEL_SCRIPT = os.environ.get("MSE_TUNNEL_SCRIPT", "/usr/local/bin/mse-tunnel.sh")
GATEWAY_PORT = int(os.environ.get("MSE_PORT", "8788") or 8788)
ENV_FILE = os.environ.get("MSE_ENV_FILE", "/etc/mse/mse.env")
DATA_DIR = os.environ.get("MSE_DATA_DIR", os.environ.get("MSE_STATE_DIR", "/var/lib/mse"))
SESSION_NAME = str(Path(DATA_DIR) / "mse-bot")   # goygram appends .vault: the session stays in the data directory
INSTALL_SCRIPT = os.environ.get("MSE_INSTALL_SCRIPT", "/opt/mse/stack/install.sh")
API_ID = int(os.environ.get("MSE_API_ID", "0") or 0)
API_HASH = os.environ.get("MSE_API_HASH", "")
PING_EVERY = float(os.environ.get("MSE_PING_EVERY", "15") or 15)
EMOJI = str(os.environ.get("MSE_EMOJI", "0") or "0").strip().lower() in ("1", "on", "yes", "true")
UPDATE_TIMEOUT = float(os.environ.get("MSE_UPDATE_TIMEOUT", "900") or 900)
INLINE_WARN = ("inline mode is off for this bot: turn it on in @BotFather (/mybots -> your bot -> Bot Settings -> "
               "Inline Mode -> Turn on), or the inline input buttons do nothing")


def is_owner(evt: object) -> bool:
    who = int(getattr(evt, "from_id", 0) or 0)
    if OWNER_ID and who == OWNER_ID:
        return True
    if OWNER_USERNAME:
        user = getattr(evt, "from_user", None) or getattr(evt, "user", None)
        if isinstance(user, dict):
            username = str(user.get("username") or "")
        else:
            username = str(getattr(user, "username", "") or "")
        if username and username.lower() == OWNER_USERNAME:
            return True
    # with neither an id nor a username configured the bot stays closed: silence is the safe default
    return False


# ------------------------------------------------------------------ the env file, read and written
def env_read() -> dict[str, str]:
    data: dict[str, str] = {}
    try:
        for line in Path(ENV_FILE).read_text(encoding="utf-8", errors="replace").splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("#") or "=" not in stripped:
                continue
            key, value = stripped.split("=", 1)
            data[key.strip()] = value.strip().strip('"').strip("'")
    except OSError:
        pass
    return data


def env_write(updates: dict[str, str]) -> None:
    managed = set(updates)
    path = Path(ENV_FILE)
    keep: list[str] = []
    try:
        for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("#") or "=" not in stripped:
                continue
            if stripped.split("=", 1)[0].strip() not in managed:
                keep.append(stripped)
    except OSError:
        keep = []
    body = [f"{key}={value}" for key, value in updates.items()] + keep
    tmp = path.with_suffix(".env.tmp")
    handle = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(handle, "w", encoding="utf-8") as stream:
        stream.write("\n".join(body) + "\n")
    os.replace(tmp, path)


def service_state(unit: str) -> str:
    try:
        out = subprocess.run(["systemctl", "is-active", unit], capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.SubprocessError):
        return "unknown"
    return (out.stdout or "").strip() or "inactive"


def services_state() -> dict[str, str]:
    return {unit: service_state(unit) for unit in ("mse-router", "mse-bot")}


class Bot:
    def __init__(self) -> None:
        ui.use_icons(EMOJI)
        self.gw = Gateway(GATEWAY_URL, ADMIN_TOKEN)
        self.app: Any = None
        self.pending_input: dict[int, str] = {}
        # a test can put a callable here and get every rendered message instead of a network call
        self.sink: Any = None
        self.inline_enabled: bool | None = None

    # ------------------------------------------------------------------ transport
    async def snap(self) -> dict[str, Any]:
        try:
            data = await asyncio.to_thread(self.gw.snapshot)
        except Exception as exc:  # noqa: BLE001 — a bot that dies on a bad gateway is useless
            data = {"health": {}, "devices": [], "allow": [], "log": [], "error": str(exc)}
        data.setdefault("services", services_state())
        return data

    def _msg_id(self, result: Any) -> int:
        if isinstance(result, dict):
            return int(result.get("message_id") or result.get("msg_id") or result.get("id") or 0)
        return int(getattr(result, "message_id", 0) or getattr(result, "id", 0) or 0)

    async def deliver(self, chat_id: int, msg_id: int, rich: Any) -> int:
        """Send or edit a Rich message. Rich is the whole point: plain text shows the markup as text."""
        if self.sink is not None:
            html = rich.to_html() if hasattr(rich, "to_html") else str(rich)
            self.sink(msg_id, html)
            return msg_id or 1
        if self.app is None:
            return 0
        if msg_id:
            try:
                await self.app.edit_rich(chat_id, msg_id, rich, via="mt")
                return msg_id
            except Exception as exc:  # noqa: BLE001 — an edit can fail on an old message
                log.debug("edit_rich failed, sending a new one: %s", exc)
        result = await self.app.send_rich(chat_id, rich, via="mt")
        return self._msg_id(result)

    async def render(self, chat_id: int, msg_id: int, rich: Any) -> int:
        return await self.deliver(chat_id, msg_id, rich)

    async def toast(self, evt: object, text: str = "", alert: bool = False) -> None:
        if getattr(evt, "_mse_answered", False):
            return
        try:
            setattr(evt, "_mse_answered", True)
        except (AttributeError, TypeError):
            pass
        try:
            await asyncio.wait_for(evt.answer(text or "done", alert=alert), 6)
        except Exception as exc:  # noqa: BLE001
            log.debug("toast failed: %s", exc)

    # ------------------------------------------------------------------ screens
    async def home(self, chat_id: int, msg_id: int = 0, notice: str = "") -> int:
        snap = await self.snap()
        problems = await self.self_check()
        if problems:
            snap["problems"] = problems
        return await self.render(chat_id, msg_id, screens.home(snap, notice=notice))

    async def people(self, chat_id: int, msg_id: int = 0, only: str = "", notice: str = "") -> int:
        return await self.render(chat_id, msg_id, screens.people(await self.snap(), notice=notice, only=only))

    async def config(self, chat_id: int, msg_id: int = 0, notice: str = "") -> int:
        env = env_read()
        cfg = {
            "model": env.get("MSE_MODEL"),
            "quota": env.get("MSE_DAILY_QUOTA"),
            "upstream_port": env.get("MSE_UPSTREAM_PORT"),
            "public_url": env.get("MSE_PUBLIC_URL"),
            "bot_token": env.get("MSE_BOT_TOKEN") or BOT_TOKEN,
            "owner_id": env.get("MSE_OWNER_ID") or (str(OWNER_ID) if OWNER_ID else ""),
            "api_id": env.get("MSE_API_ID"),
            "api_hash": env.get("MSE_API_HASH"),
            "tailscale_key": env.get("MSE_TAILSCALE_KEY"),
            "emoji": ui.icons_on(),
        }
        return await self.render(chat_id, msg_id, screens.config_screen(cfg, notice=notice))

    # ------------------------------------------------------------------ commands
    async def on_message(self, evt: object) -> None:
        if not is_owner(evt):
            return
        chat_id = int(getattr(evt, "chat_id", 0) or 0)
        text = str(getattr(evt, "text", "") or "").strip()
        if not text:
            return
        if text.startswith(inline.MARKER):
            # the client posted the picked value as a message: apply it and take the message away
            msg_id = int(getattr(evt, "msg_id", 0) or getattr(evt, "id", 0) or 0)
            token, kind, index, body = inline.parse_payload(text)
            if not token:
                token, kind, index, body = inline.consume_pending()
            try:
                ident, ctx, value = inline.value_from_payload(token, kind, index, body)
            except inline.InlineError as exc:
                await self.deliver_raw(chat_id, str(exc))
                return
            await self.drop_message(chat_id, msg_id)
            await self.apply_inline_value(chat_id, ident, ctx, value)
            return
        if chat_id in self.pending_input and not text.startswith("/"):
            await self.take_input(chat_id, self.pending_input.pop(chat_id), text)
            return
        if not text.startswith("/"):
            await self.home(chat_id)
            return
        word = text.split()[0][1:].split("@")[0].lower()
        rest = text[len(text.split()[0]) - 1:].strip()
        rest = rest[1:].strip() if rest.startswith("/") else rest
        if word in ("start", "menu", "home"):
            await self.home(chat_id)
        elif word == "state":
            await self.text_state(chat_id)
        elif word in ("people", "devices"):
            await self.people(chat_id)
        elif word in ("pending", "requests"):
            await self.people(chat_id, only="pending")
        elif word == "allow":
            if rest:
                await self.allow(chat_id, 0, rest)
            else:
                self.pending_input[chat_id] = "allow"
                await self.render(chat_id, 0, screens.people(await self.snap(), only="pending", notice="send the Moodle id in one message"))
        elif word in ("revoke", "disallow"):
            if not rest:
                await self.deliver_raw(chat_id, "format: /revoke <moodleId|deviceId>")
                return
            await self.revoke(chat_id, 0, rest)
        elif word == "quota":
            if rest:
                await self.set_quota(chat_id, 0, rest)
            else:
                await self.render(chat_id, 0, screens.quota_screen(await self.snap()))
        elif word == "model":
            if rest:
                await self.set_model(chat_id, 0, rest)
            else:
                await self.render(chat_id, 0, screens.model_screen(await self.snap()))
        elif word == "tunnel":
            info = await asyncio.to_thread(tunnel_status, TUNNEL_SCRIPT)
            await self.render(chat_id, 0, screens.tunnel_screen(info))
        elif word == "services":
            await self.render(chat_id, 0, screens.services_screen(await self.snap()))
        elif word == "log":
            await self.render(chat_id, 0, screens.log_screen(await self.snap()))
        elif word == "config":
            await self.config(chat_id)
        elif word == "update":
            await self.render(chat_id, 0, screens.update_screen())
        else:
            await self.render(chat_id, 0, screens.help_screen())

    async def drop_message(self, chat_id: int, msg_id: int) -> None:
        """A message that carried a value (or a secret) does not stay in the chat."""
        if not msg_id or self.app is None:
            return
        try:
            await self.app.delete_msg(chat_id, int(msg_id))
        except Exception as exc:  # noqa: BLE001
            log.debug("the message was not deleted: %s", exc)

    async def deliver_raw(self, chat_id: int, text: str) -> None:
        if self.sink is not None:
            self.sink(0, text)
            return
        await self.app.send_msg(chat_id, ui.esc(text))

    async def on_command(self, evt: object) -> None:
        await self.on_message(evt)

    async def text_state(self, chat_id: int) -> None:
        snap = await self.snap()
        health = snap.get("health") or {}
        devices = snap.get("devices") or []
        active, pending = screens._counts(devices)
        lines = [
            "address: " + str(health.get("publicUrl") or "—"),
            "model: " + str(health.get("model") or "—") + " · quota " + str(health.get("quota") or "—") + "/day",
            "people: " + str(len(devices)) + " · active " + str(active) + " · waiting " + str(pending),
        ]
        if snap.get("error"):
            lines.append("error: " + str(snap["error"]))
        await self.deliver_raw(chat_id, "\n".join(lines))

    # ------------------------------------------------------------------ people
    async def allow(self, chat_id: int, msg_id: int, moodle_id: str) -> None:
        moodle_id = str(moodle_id or "").strip()
        if not moodle_id.isdigit():
            await self.deliver_raw(chat_id, "a Moodle id is a number, for example 12345")
            return
        try:
            await asyncio.to_thread(self.gw.allow, moodle_id)
        except GatewayError as exc:
            await self.people(chat_id, msg_id, only="pending", notice="")
            await self.deliver_raw(chat_id, "failed: " + exc.message)
            return
        await self.people(chat_id, msg_id, notice="id " + moodle_id + " is allowed")

    async def approve(self, chat_id: int, msg_id: int, needle: str) -> None:
        needle = str(needle or "").strip()
        try:
            device = None
            if needle.isdigit():
                device = await asyncio.to_thread(self.gw.device_of, needle)
            if device is None:
                await self.allow(chat_id, msg_id, needle)
                return
            await asyncio.to_thread(self.gw.approve, str(device.get("deviceId")))
        except GatewayError as exc:
            await self.people(chat_id, msg_id, notice="")
            await self.deliver_raw(chat_id, "failed: " + exc.message)
            return
        await self.people(chat_id, msg_id, notice="allowed")

    async def revoke(self, chat_id: int, msg_id: int, needle: str) -> None:
        needle = str(needle or "").strip()
        try:
            device = None
            if needle.isdigit():
                device = await asyncio.to_thread(self.gw.device_of, needle)
            if device is None:
                await asyncio.to_thread(self.gw.disallow, needle)
            else:
                await asyncio.to_thread(self.gw.revoke, str(device.get("deviceId")))
        except GatewayError as exc:
            await self.deliver_raw(chat_id, "failed: " + exc.message)
            return
        await self.people(chat_id, msg_id, notice="revoked " + needle)

    # ------------------------------------------------------------------ model & quota
    async def set_quota(self, chat_id: int, msg_id: int, value: str) -> None:
        try:
            quota = int(str(value).strip())
            if quota < 0:
                raise ValueError("negative")
        except ValueError:
            await self.deliver_raw(chat_id, "a quota is a whole number, for example 200")
            return
        try:
            await asyncio.to_thread(self.gw.set_quota, quota)
        except GatewayError as exc:
            await self.deliver_raw(chat_id, "failed: " + exc.message)
            return
        await self.render(chat_id, msg_id, screens.quota_screen(await self.snap(), notice="now " + str(quota)))

    async def set_model(self, chat_id: int, msg_id: int, value: str) -> None:
        model = str(value or "").strip()
        if not model:
            return
        try:
            env_write({"MSE_MODEL": model})
        except OSError as exc:
            await self.deliver_raw(chat_id, "could not write " + ENV_FILE + ": " + str(exc))
            return
        try:
            await asyncio.to_thread(self.gw.set_quota, int(env_read().get("MSE_DAILY_QUOTA") or 200))
        except Exception:  # noqa: BLE001 — the model lives in the env; the router does not need to care
            pass
        await self.render(chat_id, msg_id, screens.model_screen(await self.snap(), notice="chosen " + model + " · restart the backend to apply"))

    # ------------------------------------------------------------------ tunnel & services & update
    async def tunnel(self, chat_id: int, msg_id: int, action: str) -> None:
        if action != "show":
            ok, text = await asyncio.to_thread(tunnel_do, action, TUNNEL_SCRIPT, GATEWAY_PORT)
            info = await asyncio.to_thread(tunnel_status, TUNNEL_SCRIPT)
            if action in ("funnel", "serve") and ok and text.startswith("http"):
                try:
                    env_write({"MSE_PUBLIC_URL": text.strip().splitlines()[0]})
                except OSError as exc:
                    log.debug("could not save the address: %s", exc)
            await self.render(chat_id, msg_id, screens.tunnel_screen(info, notice=text if ok else "", error="" if ok else text))
            return
        info = await asyncio.to_thread(tunnel_status, TUNNEL_SCRIPT)
        await self.render(chat_id, msg_id, screens.tunnel_screen(info))

    async def service(self, chat_id: int, msg_id: int, verb: str, unit: str) -> None:
        if verb not in ("start", "stop", "restart") or unit not in ("mse-router", "mse-bot"):
            await self.deliver_raw(chat_id, "unknown service action")
            return
        try:
            await asyncio.to_thread(lambda: subprocess.run(["systemctl", verb, unit], capture_output=True, timeout=60))
        except (OSError, subprocess.SubprocessError) as exc:
            await self.deliver_raw(chat_id, "systemctl failed: " + str(exc))
            return
        await self.render(chat_id, msg_id, screens.services_screen(await self.snap(), notice=unit + " " + verb + "ed"))

    async def update(self, chat_id: int, msg_id: int, run: bool) -> None:
        if not run:
            await self.render(chat_id, msg_id, screens.update_screen())
            return
        await self.render(chat_id, msg_id, screens.update_screen(notice="updating, this may take a minute"))
        script = INSTALL_SCRIPT if Path(INSTALL_SCRIPT).exists() else ""
        if not script:
            await self.render(chat_id, msg_id, screens.update_screen(error="install.sh is not where it was expected: " + INSTALL_SCRIPT))
            return
        try:
            proc = await asyncio.to_thread(
                lambda: subprocess.run(["bash", script, "--update", "--yes"], capture_output=True, text=True, timeout=UPDATE_TIMEOUT)
            )
        except (OSError, subprocess.SubprocessError) as exc:
            await self.render(chat_id, msg_id, screens.update_screen(error=str(exc)))
            return
        tail = (proc.stdout or "") + (("\n" + proc.stderr) if proc.stderr else "")
        await self.render(chat_id, msg_id, screens.update_screen({"ok": proc.returncode == 0, "tail": tail}))

    # ------------------------------------------------------------------ inline input (the OBHOD way)
    async def on_inline(self, evt: object) -> None:
        """A button of type switch_inline_query_current_chat lands here: the owner is typing a value in the field."""
        who = int(getattr(evt, "from_id", 0) or 0)
        query = str(getattr(evt, "query", "") or "")
        results: list[dict[str, Any]] = []
        if inline.allowed(who, OWNER_ID):
            try:
                results = inline.results_for(query, self.current_values())
            except Exception as exc:  # noqa: BLE001
                log.debug("inline query failed: %s", exc)
        try:
            await inline.answer(evt, results)
        except Exception as exc:  # noqa: BLE001
            log.warning("the inline answer did not go out: %s", exc)

    async def on_chosen(self, evt: object) -> None:
        """The owner tapped one of the inline results: apply the value, then remove the marker message."""
        payload = getattr(evt, "raw", None)
        raw = payload if isinstance(payload, dict) else {}
        inner = raw.get("chosen_inline_result")
        inner = inner if isinstance(inner, dict) else raw
        who = int(inner.get("from_id") or (inner.get("from") or {}).get("id") or getattr(evt, "from_id", 0) or 0)
        if not inline.allowed(who, OWNER_ID):
            return
        rid = str(inner.get("result_id") or "")
        query = str(inner.get("query") or getattr(evt, "query", "") or "")
        kind, token, index = inline.parse_option_id(rid)
        if not kind:
            kind, token, index = inline.parse_result_id(rid)
        if not kind:
            return
        try:
            ident, ctx, value = inline.value_for(kind, token, index, query)
        except inline.InlineError as exc:
            await self.deliver_raw(OWNER_ID, str(exc))
            return
        inline.consume_pending()
        await self.apply_inline_value(OWNER_ID, ident, ctx, value)

    def current_values(self) -> dict[str, str]:
        env = env_read()
        return {
            "model": env.get("MSE_MODEL", ""),
            "quota": env.get("MSE_DAILY_QUOTA", ""),
            "owner_id": env.get("MSE_OWNER_ID", ""),
            "api_id": env.get("MSE_API_ID", ""),
            "bot_token": (env.get("MSE_BOT_TOKEN") or BOT_TOKEN)[:4] + "…" if (env.get("MSE_BOT_TOKEN") or BOT_TOKEN) else "",
            "api_hash": "set" if env.get("MSE_API_HASH") else "",
            "tailscale_key": "set" if env.get("MSE_TAILSCALE_KEY") else "",
        }

    async def apply_inline_value(self, chat_id: int, ident: str, ctx: str, value: str) -> None:
        """Where a typed value goes. One entry point for the inline field and for a plain reply."""
        if ident == "model":
            await self.set_model(chat_id, 0, value)
        elif ident == "quota":
            await self.set_quota(chat_id, 0, value)
        elif ident == "allow_id":
            await self.allow(chat_id, 0, value)
        elif ident == "name":
            await self.deliver_raw(chat_id, "names are taken from Moodle on the first request")
        elif ident == "revoke_id":
            await self.revoke(chat_id, 0, value)
        elif ident in ("bot_token", "owner_id", "api_id", "api_hash", "tailscale_key"):
            await self.set_config(chat_id, 0, ident, value)
        else:
            await self.deliver_raw(chat_id, "unknown field: " + ident)

    # ------------------------------------------------------------------ typed values
    async def take_input(self, chat_id: int, kind: str, value: str) -> None:
        value = str(value or "").strip()
        if kind == "allow":
            await self.allow(chat_id, 0, value)
        elif kind == "model":
            await self.set_model(chat_id, 0, value)
        elif kind == "quota":
            await self.set_quota(chat_id, 0, value)
        elif kind.startswith("cfg:"):
            await self.set_config(chat_id, 0, kind.split(":", 1)[1], value)

    async def set_config(self, chat_id: int, msg_id: int, key: str, value: str) -> None:
        field = {
            "bot_token": "MSE_BOT_TOKEN", "owner_id": "MSE_OWNER_ID", "api_id": "MSE_API_ID",
            "api_hash": "MSE_API_HASH", "tailscale_key": "MSE_TAILSCALE_KEY",
        }.get(key)
        if key == "tailscale_key" and field:
            # a new key means a new login: run it through the tunnel helper and report what it says
            try:
                env_write({field: value})
            except OSError as exc:
                await self.deliver_raw(chat_id, "could not write " + ENV_FILE + ": " + str(exc))
                return
            ok, text = await asyncio.to_thread(tunnel_do, "up", TUNNEL_SCRIPT, GATEWAY_PORT)
            info = await asyncio.to_thread(tunnel_status, TUNNEL_SCRIPT)
            await self.render(chat_id, msg_id, screens.tunnel_screen(info, notice="key saved, tailscale up" if ok else "",
                                                                      error="" if ok else text))
            return
        if not field:
            await self.deliver_raw(chat_id, "unknown setting")
            return
        if not value:
            await self.deliver_raw(chat_id, "an empty value is not saved")
            return
        if field == "MSE_OWNER_ID" and not value.lstrip("-").isdigit():
            await self.deliver_raw(chat_id, "the owner id is a number")
            return
        if field == "MSE_API_ID" and not value.isdigit():
            await self.deliver_raw(chat_id, "the api id is a number")
            return
        if field == "MSE_BOT_TOKEN" and ":" not in value:
            await self.deliver_raw(chat_id, "a bot token looks like 123456:ABC-DEF")
            return
        try:
            env_write({field: value})
        except OSError as exc:
            await self.deliver_raw(chat_id, "could not write " + ENV_FILE + ": " + str(exc))
            return
        # the message that carried a secret is not kept in the chat
        try:
            await self.app.delete_msg(chat_id, int(getattr(self, "_last_user_msg", 0) or 0))
        except Exception:  # noqa: BLE001
            pass
        need_restart = field in ("MSE_BOT_TOKEN", "MSE_API_ID", "MSE_API_HASH")
        if need_restart:
            await asyncio.to_thread(lambda: subprocess.run(["systemctl", "restart", "mse-bot"], capture_output=True, timeout=60))
        await self.config(chat_id, msg_id, notice=field + " saved" + (" · the bot restarted" if need_restart else ""))

    # ------------------------------------------------------------------ callbacks
    async def on_callback(self, evt: object) -> None:
        if not is_owner(evt):
            await self.toast(evt, "not for you")
            return
        data = str(getattr(evt, "data", "") or "")
        chat_id = int(getattr(evt, "chat_id", 0) or 0)
        msg_id = int(getattr(evt, "msg_id", 0) or 0)
        parts = data.split(":")
        head = parts[0] if parts else ""
        try:
            if data in ("home", "") or head == "home":
                await self.toast(evt, "refreshed")
                await self.home(chat_id, msg_id)
            elif data == "dev:list":
                await self.toast(evt, "")
                await self.people(chat_id, msg_id)
            elif data == "dev:pending":
                await self.toast(evt, "")
                await self.people(chat_id, msg_id, only="pending")
            elif data == "dev:allowask":
                self.pending_input[chat_id] = "allow"
                await self.toast(evt, "send the id")
                await self.deliver_raw(chat_id, "send the Moodle id in one message")
            elif head == "dev" and len(parts) >= 3 and parts[1] == "approve":
                await self.toast(evt, "allowed")
                await self.approve(chat_id, msg_id, ":".join(parts[2:]))
            elif head == "dev" and len(parts) >= 3 and parts[1] == "revoke":
                await self.toast(evt, "revoked")
                await self.revoke(chat_id, msg_id, ":".join(parts[2:]))
            elif data == "model:show":
                await self.toast(evt, "")
                await self.render(chat_id, msg_id, screens.model_screen(await self.snap()))
            elif data == "model:ask":
                self.pending_input[chat_id] = "model"
                await self.toast(evt, "type the name")
                await self.deliver_raw(chat_id, "send the model name in one message")
            elif head == "model" and len(parts) >= 3 and parts[1] == "set":
                await self.toast(evt, "saved")
                await self.set_model(chat_id, msg_id, ":".join(parts[2:]))
            elif data == "quota:show":
                await self.toast(evt, "")
                await self.render(chat_id, msg_id, screens.quota_screen(await self.snap()))
            elif data == "quota:ask":
                self.pending_input[chat_id] = "quota"
                await self.toast(evt, "type a number")
                await self.deliver_raw(chat_id, "send the quota in one message")
            elif head == "quota" and len(parts) >= 3 and parts[1] == "set":
                await self.toast(evt, "quota " + parts[2])
                await self.set_quota(chat_id, msg_id, parts[2])
            elif data == "tunnel:show":
                await self.toast(evt, "")
                await self.tunnel(chat_id, msg_id, "show")
            elif head == "tunnel":
                await self.toast(evt, "working…")
                await self.tunnel(chat_id, msg_id, parts[1] if len(parts) > 1 else "show")
            elif data == "svc:show":
                await self.toast(evt, "")
                await self.render(chat_id, msg_id, screens.services_screen(await self.snap()))
            elif head == "svc" and len(parts) >= 3:
                unit = parts[2]
                await self.toast(evt, parts[1] + " " + unit)
                await self.service(chat_id, msg_id, parts[1], unit)
            elif data == "log:show":
                await self.toast(evt, "")
                await self.render(chat_id, msg_id, screens.log_screen(await self.snap()))
            elif data == "cfg:show":
                await self.toast(evt, "")
                await self.config(chat_id, msg_id)
            elif head == "cfg" and len(parts) >= 3 and parts[1] == "set":
                key = parts[2]
                self.pending_input[chat_id] = "cfg:" + key
                await self.toast(evt, "send the value")
                await self.deliver_raw(chat_id, "send the new value for " + key + " in one message; it will be saved to "
                                                 + ENV_FILE + " and the message will be deleted")
            elif data == "cfg:emoji":
                on = not ui.icons_on()
                ui.use_icons(on)
                try:
                    env_write({"MSE_EMOJI": "1" if on else "0"})
                except OSError as exc:
                    log.debug("the emoji switch was not saved: %s", exc)
                await self.toast(evt, "emoji " + ("on" if on else "off"))
                await self.config(chat_id, msg_id, notice="emoji pack " + ("on" if on else "off")
                                  + " · the pack is at " + icons.PACK_LINK)
            elif data == "upd:check":
                await self.toast(evt, "")
                await self.update(chat_id, msg_id, False)
            elif data == "upd:run":
                await self.toast(evt, "updating…")
                await self.update(chat_id, msg_id, True)
            else:
                await self.toast(evt, "unknown button")
        except GatewayError as exc:
            await self.toast(evt, "error: " + exc.message, alert=True)
        except Exception as exc:  # noqa: BLE001 — never let a handler die silently
            log.warning("callback %s failed: %s", data, exc)
            await self.toast(evt, "error: " + str(exc)[:120], alert=True)

    # ------------------------------------------------------------------ new applications
    async def watch_applications(self) -> None:
        """Polls the router for people who knocked and nobody answered yet, and pings the owner about each one."""
        if not OWNER_ID:
            log.info("no MSE_OWNER_ID: the application watch is off")
            return
        while True:
            try:
                res = await asyncio.to_thread(self.gw.applications, True)
                for item in res.get("applications") or []:
                    await self.announce(item)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                log.debug("application watch: %s", exc)
            await asyncio.sleep(max(3.0, PING_EVERY))

    async def announce(self, item: dict[str, Any]) -> None:
        moodle_id = str(item.get("moodleId") or "?")
        name = str(item.get("name") or "").strip() or "a new device"
        html = screens.home(
            {"health": {}, "devices": [{"deviceId": str(item.get("deviceId") or moodle_id), "moodleId": moodle_id,
                                        "name": name, "status": "pending", "site": item.get("site") or ""}]},
            notice="",
        )
        rich = screens.screen(
            "new request",
            ui.muted("someone is waiting for you"),
            [
                ui.facts([("person", ui.bold(name)), ("Moodle id", ui.code(moodle_id)),
                          ("site", ui.code(item.get("site") or "—"))], icon="bell"),
                ui.quote(ui.muted("give them the answer database, or let them in to the AI row as well"), "allow or decline"),
            ],
            [
                ui.row(ui.button("allow", "dev:approve:" + moodle_id, icon="ok"),
                       ui.button("decline", "dev:revoke:" + moodle_id, icon="fail")),
                ui.row(ui.button("all requests", "dev:pending", icon="bell")),
            ],
            icon="bell",
        )
        del html
        try:
            await self.render(OWNER_ID, 0, rich)
        except Exception as exc:  # noqa: BLE001
            log.debug("announce failed: %s", exc)

    # ------------------------------------------------------------------ run
    def build(self) -> GoyGram:
        app = GoyGram(
            bot_token=BOT_TOKEN,
            api_id=API_ID or None,
            api_hash=API_HASH or None,
            app_name="MSE",
            app_version="2.0",
            device_model="server",
            system_version="linux",
            session_name=SESSION_NAME,
        )
        app.on_msg(fn=self.on_message)
        app.on_cb(fn=self.on_callback)
        app.on_inline(fn=self.on_inline)
        app.on_update(fn=self.on_chosen)
        self.app = app
        return app

    async def check_inline_mode(self) -> bool | None:
        """Is inline mode on in BotFather? None means "could not tell", which must never raise a false alarm."""
        if self.app is None:
            return None
        app = self.app
        for name in ("get_me", "getMe"):
            getter = getattr(app, name, None)
            if not callable(getter):
                continue
            try:
                me = await asyncio.wait_for(getter(refresh=True), 20)
            except TypeError:
                try:
                    me = await asyncio.wait_for(getter(), 20)
                except Exception:  # noqa: BLE001
                    return None
            except Exception as exc:  # noqa: BLE001
                log.debug("getMe failed: %s", exc)
                return None
            if not isinstance(me, dict):
                return None
            supports = me.get("supports_inline_queries")
            if supports is None and "bot_inline_placeholder" in me:
                supports = me.get("bot_inline_placeholder") is not None
            if supports is None:
                supports = me.get("supports_inline")
            if supports is None:
                # the bot api in front of the account may hide it: try the raw method once
                raw = await self.bot_call("getMe")
                if isinstance(raw, dict):
                    supports = raw.get("supports_inline_queries")
            if supports is None:
                return None
            self.inline_enabled = bool(supports)
            return bool(supports)
        return None

    async def bot_call(self, method: str, **kwargs: Any) -> Any:
        """A raw bot api call, whichever of the names this goygram build exposes."""
        if self.app is None:
            return None
        for name in ("bot_req", "call_bot", "bot_api"):
            fn = getattr(self.app, name, None)
            if callable(fn):
                try:
                    return await asyncio.wait_for(fn(method, **kwargs), 20)
                except Exception as exc:  # noqa: BLE001
                    log.debug("bot %s failed: %s", method, exc)
                    return None
        return None

    async def self_check(self) -> list[str]:
        """What would keep the panel from working. Printed at start and shown on the panel as a notice."""
        problems: list[str] = []
        if not ADMIN_TOKEN:
            problems.append("MSE_ADMIN_TOKEN is empty: the router will refuse every admin call")
        else:
            try:
                await asyncio.to_thread(self.gw.health)
            except GatewayError as exc:
                problems.append("the router does not answer on " + GATEWAY_URL + ": " + exc.message)
        if not OWNER_ID and not OWNER_USERNAME:
            problems.append("no owner: set MSE_OWNER_ID (or MSE_OWNER_USERNAME), or the bot answers nobody")
        if not BOT_TOKEN:
            problems.append("no bot token: nothing to run")
        if not ui.icons_on():
            problems.append("")          # not a problem: the emoji pack is off by design
        env = env_read()
        if not env.get("MSE_BOT_TOKEN"):
            problems.append("MSE_BOT_TOKEN is not in " + ENV_FILE + ": the installer never got a token")
        if not env.get("MSE_TAILSCALE_KEY"):
            problems.append("no tailscale key: the tunnel has to be brought up by hand (panel -> Tailscale)")
        if self.inline_enabled is False:
            problems.append(INLINE_WARN)
        return [p for p in problems if p]

    async def run(self) -> None:
        app = self.build()
        inline.configure(ADMIN_TOKEN or BOT_TOKEN)
        self.inline_enabled = await self.check_inline_mode()
        if self.inline_enabled is False:
            log.warning("%s", INLINE_WARN)
            print(INLINE_WARN, file=sys.stderr, flush=True)
            await self.tell_owner(INLINE_WARN)
        problems = await self.self_check()
        for problem in problems:
            log.warning("start check: %s", problem)
        if problems:
            print("start checks:\n  - " + "\n  - ".join(problems), file=sys.stderr)
        await self.notify_start()
        watcher = asyncio.create_task(self.watch_applications())
        try:
            await app.run()
        finally:
            watcher.cancel()

    async def tell_owner(self, line: str) -> None:
        """One plain sentence in the chat, no screen: this is about the bot itself, not about the gateway."""
        if not OWNER_ID:
            return
        try:
            await self.deliver_raw(OWNER_ID, line)
        except Exception as exc:  # noqa: BLE001
            log.debug("the owner was not told: %s", exc)

    async def notify_start(self) -> None:
        if not OWNER_ID:
            return
        try:
            await self.home(OWNER_ID, 0)
        except Exception as exc:  # noqa: BLE001
            log.debug("start notice failed: %s", exc)


def main() -> int:
    logging.basicConfig(level=os.environ.get("MSE_LOG_LEVEL", "INFO"),
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    if not BOT_TOKEN:
        print("MSE_BOT_TOKEN is not set: nothing to run", file=sys.stderr)
        return 2
    bot = Bot()
    asyncio.run(bot.run())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
