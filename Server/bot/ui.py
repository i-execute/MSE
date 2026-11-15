"""Screens of the MSE bot.

The same look as OBHOD: a Roboto-rich screen through goygram's Rich, one line per fact, inline buttons by
`callback_data`, the answer of a callback always acknowledged. Nothing here talks to the network — every screen
is built from a plain dict the client (`client.py`) returns, so a screen can be rendered in a test without a
gateway and without Telegram.
"""
from __future__ import annotations

from dataclasses import dataclass
from html import escape
import re
from typing import Any, Iterable

from goygram.rich import Rich

MAX_BUTTONS = 24
MAX_CALLBACK = 64
SEP = " · "
CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def esc(value: Any) -> str:
    return escape(CONTROL.sub("", str(value)), quote=True)


def code(value: Any) -> str:
    return f"<code>{esc(value)}</code>"


def bold(value: Any) -> str:
    return f"<b>{esc(value)}</b>"


def muted(value: Any) -> str:
    return f"<i>{esc(value)}</i>"


def pre(value: Any) -> str:
    return f"<pre>{esc(value)}</pre>"


def row(*buttons: Any) -> list[str]:
    return [b.html() if isinstance(b, Button) else str(b) for b in buttons]


@dataclass
class Button:
    label: str
    data: str
    style: str = ""

    def html(self) -> str:
        if len(self.data.encode("utf-8")) > MAX_CALLBACK:
            raise ValueError("callback data is too long: " + self.data)
        style = f' style="{esc(self.style)}"' if self.style else ""
        return f'<tg-button type="callback_data"{style} data="{esc(self.data)}">{esc(self.label)}</tg-button>'


def button(label: str, data: str, style: str = "") -> Button:
    return Button(label=label, data=data, style=style)


def url_button(label: str, url: str) -> str:
    return f'<tg-button type="url" url="{esc(url)}">{esc(label)}</tg-button>'


def screen(title: str, subtitle: str = "", blocks: Iterable[str] = (), buttons: Iterable[Any] = (), footer: str = "") -> Rich:
    root = Rich()
    root.add(f"<h2>{esc(title)}</h2>")
    if subtitle:
        root.add(f"<p>{subtitle}</p>")
    for block in blocks:
        if block:
            root.add(block)
    flat: list[str] = []
    for item in buttons:
        if isinstance(item, (list, tuple)):
            flat.extend(x.html() if isinstance(x, Button) else str(x) for x in item)
        elif item:
            flat.append(item.html() if isinstance(item, Button) else str(item))
    if flat:
        root.add("<p>" + "".join(flat[:MAX_BUTTONS]) + "</p>")
    if footer:
        root.add(f"<p>{footer}</p>")
    return root


def state_of(device: dict[str, Any]) -> str:
    status = str(device.get("status") or "?")
    return {"active": "active", "pending": "pending", "revoked": "revoked"}.get(status, status)


def device_line(device: dict[str, Any]) -> str:
    name = str(device.get("name") or "no name")[:28]
    moodle = device.get("moodleId") or "—"
    left = device.get("quota")
    used = device.get("quotaUsed") or 0
    quota = f"{used}/{used + int(left)}" if isinstance(left, int) else f"{used}"
    return f"{esc(name)} · ID {code(moodle)} · {esc(state_of(device))} · {esc(quota)}"


def home(snap: dict[str, Any]) -> Rich:
    """The one screen the owner starts from: what the gateway is doing, and what waits for a decision."""
    health = snap.get("health") or {}
    devices = snap.get("devices") or []
    pending = [d for d in devices if str(d.get("status")) == "pending"]
    active = [d for d in devices if str(d.get("status")) == "active"]
    up = snap.get("upstream") or {}
    url = health.get("publicUrl") or "—"
    blocks = [
        "<p>address: " + code(url) + "</p>",
        "<p>backend: " + code(f"{up.get('host', '127.0.0.1')}:{up.get('port', '?')}") + " · model " + code(health.get("model") or "—") + "</p>",
        "<p>quota: " + code(str(health.get("quota", "—")) + "/day") + " · devices " + code(len(devices))
        + " · active " + code(len(active)) + " · pending " + code(len(pending)) + "</p>",
    ]
    if pending:
        blocks.append("<p>waiting for a decision:</p>")
        for d in pending[:6]:
            blocks.append("<p>" + device_line(d) + "</p>")
    buttons = [row(button("devices", "dev:list"), button("requests" + (f" ({len(pending)})" if pending else ""), "dev:pending"))]
    buttons.append(row(button("model", "model:show"), button("quota", "quota:show"), button("log", "log:show")))
    buttons.append(row(button("tunnel", "tunnel:show"), button("refresh", "home")))
    return screen("MSE · gateway", subtitle="server control", blocks=blocks, buttons=buttons,
                  footer=muted("version " + str(health.get("version") or "?")))


def devices(snap: dict[str, Any], only: str = "") -> Rich:
    items = [d for d in (snap.get("devices") or []) if not only or str(d.get("status")) == only]
    blocks = []
    if not items:
        blocks.append("<p>nobody yet</p>")
    for d in items[:10]:
        blocks.append("<p>" + device_line(d) + "</p>")
    buttons = []
    for d in items[:6]:
        did = str(d.get("deviceId") or "")
        if str(d.get("status")) == "pending":
            buttons.append(row(button("allow " + str(d.get("moodleId")), "dev:approve:" + did),
                               button("decline", "dev:revoke:" + did)))
        elif str(d.get("status")) == "active":
            buttons.append(row(button("revoke " + str(d.get("moodleId")), "dev:revoke:" + did)))
        else:
            buttons.append(row(button("restore " + str(d.get("moodleId")), "dev:approve:" + did)))
    buttons.append(row(button("by id…", "dev:allowask"), button("back", "home")))
    return screen("devices", subtitle=("waiting" if only == "pending" else "all"), blocks=blocks, buttons=buttons)


def log(snap: dict[str, Any]) -> Rich:
    lines = (snap.get("log") or [])[-20:]
    body = "\n".join(f"{str(l.get('at') or '')[11:19]}  {l.get('text') or ''}" for l in lines) or "empty"
    return screen("log", subtitle="the last 20 records",
                  blocks=[pre(body)], buttons=[row(button("refresh", "log:show"), button("back", "home"))])


def model_screen(snap: dict[str, Any], notice: str = "", error: str = "") -> Rich:
    health = snap.get("health") or {}
    models = health.get("models") or []
    blocks = ["<p>now: " + code(health.get("model") or "—") + "</p>"]
    if models:
        blocks.append("<p>available: " + esc(", ".join(str(m) for m in models)) + "</p>")
    if notice:
        blocks.append("<p>" + esc(notice) + "</p>")
    if error:
        blocks.append("<p>error: " + esc(error) + "</p>")
    buttons = [row(button(str(m), "model:set:" + str(m))) for m in models[:8]]
    buttons.append(row(button("back", "home")))
    return screen("model", subtitle="chosen by the server", blocks=blocks, buttons=buttons)


def quota_screen(snap: dict[str, Any], notice: str = "", error: str = "") -> Rich:
    health = snap.get("health") or {}
    blocks = ["<p>now: " + code(str(health.get("quota", "—")) + " requests per day per device") + "</p>"]
    if notice:
        blocks.append("<p>" + esc(notice) + "</p>")
    if error:
        blocks.append("<p>error: " + esc(error) + "</p>")
    buttons = [row(button("50", "quota:set:50"), button("100", "quota:set:100"), button("200", "quota:set:200"), button("500", "quota:set:500")),
               row(button("back", "home"))]
    return screen("quota", subtitle="daily, per device", blocks=blocks, buttons=buttons)


def tunnel_screen(info: dict[str, Any], notice: str = "", error: str = "") -> Rich:
    blocks = [
        "<p>backend: " + code(str(info.get("backend") or "tailscale")) + "</p>",
        "<p>mode: " + code(str(info.get("mode") or "none")) + "</p>",
        "<p>address: " + code(str(info.get("url") or "—")) + "</p>",
        "<p>tailnet ip: " + code(str(info.get("ip") or "—")) + "</p>",
    ]
    if info.get("installed") is not None:
        blocks.append("<p>tailscale: " + esc("installed" if info.get("installed") else "not installed")
                      + " · " + esc("up" if info.get("running") else "not up") + "</p>")
    if notice:
        blocks.append("<p>" + esc(notice) + "</p>")
    if error:
        blocks.append("<p>error: " + esc(error) + "</p>")
    url = str(info.get("url") or "")
    buttons = [row(button("funnel", "tunnel:funnel"), button("serve", "tunnel:serve"), button("turn off", "tunnel:off"))]
    if url.startswith("https://"):
        buttons.append(row(url_button("open", url + "/health")))
    buttons.append(row(button("refresh", "tunnel:show"), button("back", "home")))
    return screen("tunnel", subtitle="tailscale instead of cloudflared", blocks=blocks, buttons=buttons)


def help_screen(admin: bool) -> Rich:
    commands = "/start — this panel\n/state — gateway state\n/pending — device requests\n/devices — all devices"
    if admin:
        commands += "\n/allow <moodleId> — allow by id\n/revoke <moodleId|deviceId> — revoke\n/quota <N> — quota per day\n/model <id> — model"
    return screen("MSE · commands", blocks=[pre(commands)], buttons=[row(button("panel", "home"))])
