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
    return {"active": "работает", "pending": "ждёт", "revoked": "отозван"}.get(status, status)


def device_line(device: dict[str, Any]) -> str:
    name = str(device.get("name") or "без имени")[:28]
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
        "<p>адрес: " + code(url) + "</p>",
        "<p>бэкенд: " + code(f"{up.get('host', '127.0.0.1')}:{up.get('port', '?')}") + " · модель " + code(health.get("model") or "—") + "</p>",
        "<p>квота: " + code(str(health.get("quota", "—")) + "/сутки") + " · устройств " + code(len(devices))
        + " · работают " + code(len(active)) + " · ждут " + code(len(pending)) + "</p>",
    ]
    if pending:
        blocks.append("<p>ждут решения:</p>")
        for d in pending[:6]:
            blocks.append("<p>" + device_line(d) + "</p>")
    buttons = [row(button("устройства", "dev:list"), button("заявки" + (f" ({len(pending)})" if pending else ""), "dev:pending"))]
    buttons.append(row(button("модель", "model:show"), button("квота", "quota:show"), button("лог", "log:show")))
    buttons.append(row(button("туннель", "tunnel:show"), button("обновить", "home")))
    return screen("MSE · шлюз", subtitle="управление сервером", blocks=blocks, buttons=buttons,
                  footer=muted("версия " + str(health.get("version") or "?")))


def devices(snap: dict[str, Any], only: str = "") -> Rich:
    items = [d for d in (snap.get("devices") or []) if not only or str(d.get("status")) == only]
    blocks = []
    if not items:
        blocks.append("<p>пока никого</p>")
    for d in items[:10]:
        blocks.append("<p>" + device_line(d) + "</p>")
    buttons = []
    for d in items[:6]:
        did = str(d.get("deviceId") or "")
        if str(d.get("status")) == "pending":
            buttons.append(row(button("пустить " + str(d.get("moodleId")), "dev:approve:" + did),
                               button("отказ", "dev:revoke:" + did)))
        elif str(d.get("status")) == "active":
            buttons.append(row(button("отозвать " + str(d.get("moodleId")), "dev:revoke:" + did)))
        else:
            buttons.append(row(button("вернуть " + str(d.get("moodleId")), "dev:approve:" + did)))
    buttons.append(row(button("по ID…", "dev:allowask"), button("назад", "home")))
    return screen("устройства", subtitle=("ждут" if only == "pending" else "все"), blocks=blocks, buttons=buttons)


def log(snap: dict[str, Any]) -> Rich:
    lines = (snap.get("log") or [])[-20:]
    body = "\n".join(f"{str(l.get('at') or '')[11:19]}  {l.get('text') or ''}" for l in lines) or "пусто"
    return screen("журнал", subtitle="последние 20 записей",
                  blocks=[pre(body)], buttons=[row(button("обновить", "log:show"), button("назад", "home"))])


def model_screen(snap: dict[str, Any], notice: str = "", error: str = "") -> Rich:
    health = snap.get("health") or {}
    models = health.get("models") or []
    blocks = ["<p>сейчас: " + code(health.get("model") or "—") + "</p>"]
    if models:
        blocks.append("<p>доступны: " + esc(", ".join(str(m) for m in models)) + "</p>")
    if notice:
        blocks.append("<p>" + esc(notice) + "</p>")
    if error:
        blocks.append("<p>ошибка: " + esc(error) + "</p>")
    buttons = [row(button(str(m), "model:set:" + str(m))) for m in models[:8]]
    buttons.append(row(button("назад", "home")))
    return screen("модель", subtitle="выбор сервером", blocks=blocks, buttons=buttons)


def quota_screen(snap: dict[str, Any], notice: str = "", error: str = "") -> Rich:
    health = snap.get("health") or {}
    blocks = ["<p>сейчас: " + code(str(health.get("quota", "—")) + " запросов в сутки на устройство") + "</p>"]
    if notice:
        blocks.append("<p>" + esc(notice) + "</p>")
    if error:
        blocks.append("<p>ошибка: " + esc(error) + "</p>")
    buttons = [row(button("50", "quota:set:50"), button("100", "quota:set:100"), button("200", "quota:set:200"), button("500", "quota:set:500")),
               row(button("назад", "home"))]
    return screen("квота", subtitle="дневная, на устройство", blocks=blocks, buttons=buttons)


def tunnel_screen(info: dict[str, Any], notice: str = "", error: str = "") -> Rich:
    blocks = [
        "<p>бэкенд: " + code(str(info.get("backend") or "tailscale")) + "</p>",
        "<p>режим: " + code(str(info.get("mode") or "нет")) + "</p>",
        "<p>адрес: " + code(str(info.get("url") or "—")) + "</p>",
        "<p>ip в tailnet: " + code(str(info.get("ip") or "—")) + "</p>",
    ]
    if info.get("installed") is not None:
        blocks.append("<p>tailscale: " + esc("установлен" if info.get("installed") else "не установлен")
                      + " · " + esc("поднят" if info.get("running") else "не поднят") + "</p>")
    if notice:
        blocks.append("<p>" + esc(notice) + "</p>")
    if error:
        blocks.append("<p>ошибка: " + esc(error) + "</p>")
    url = str(info.get("url") or "")
    buttons = [row(button("funnel", "tunnel:funnel"), button("serve", "tunnel:serve"), button("выключить", "tunnel:off"))]
    if url.startswith("https://"):
        buttons.append(row(url_button("открыть", url + "/health")))
    buttons.append(row(button("обновить", "tunnel:show"), button("назад", "home")))
    return screen("туннель", subtitle="tailscale вместо cloudflared", blocks=blocks, buttons=buttons)


def help_screen(admin: bool) -> Rich:
    commands = "/start — эта панель\n/state — состояние шлюза\n/pending — заявки устройств\n/devices — все устройства"
    if admin:
        commands += "\n/allow <moodleId> — пустить по ID\n/revoke <moodleId|deviceId> — отозвать\n/quota <N> — квота в сутки\n/model <id> — модель"
    return screen("MSE · команды", blocks=[pre(commands)], buttons=[row(button("панель", "home"))])
