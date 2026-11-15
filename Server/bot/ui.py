"""Rich screens for the MSE bot — a port of `BOT/ui.py` and `BOT/icons.py` from i-execute/OBHOD.

The whole point: a screen is a `Rich` object that goes out through `send_rich`/`edit_rich`. Telegram then renders
real headings, tables, chips, dividers and a row of buttons — not a wall of `<tg-button>` markup (which is exactly
what a plain `send_msg` shows when the payload is not a rich message).

Everything here works on HTML strings: helpers return a fragment, `screen()` wraps them into one message.
"""
from __future__ import annotations

import re
from html import escape
from typing import Any, Iterable

from goygram.rich import Rich

MAX_BUTTONS = 18
MAX_CALLBACK = 64
CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
PRE_BLOCK = re.compile(r"(<pre(?:\s[^>]*)?>.*?</pre>)", re.S)
INTER_BLOCK_NL = re.compile(r"(</(?:p|blockquote|details|table|ul|ol|h[1-6])>|<hr\s*/?>)\s*\n+\s*(?=<)")
SEP = " · "


class ScreenRich(Rich):
    """A Rich that does not turn the newline after a block tag into an extra <br>."""

    def to_html(self) -> str:
        html = self.build()
        parts = PRE_BLOCK.split(html)
        out: list[str] = []
        for idx, chunk in enumerate(parts):
            if idx % 2 == 1:                     # inside <pre>: keep it exactly as it is
                out.append(chunk)
            else:
                cleaned = INTER_BLOCK_NL.sub(r"\1", chunk)
                out.append(re.sub(r"\n(?![^<]*>)", "<br>", cleaned))
        return "".join(out)


# ------------------------------------------------------------------ icons
# The same pack OBHOD uses (tgiosicons): a custom emoji id plus the plain unicode fallback, so a client without
# the pack still sees a readable glyph instead of an empty box.
ICONS: dict[str, tuple[int, str]] = {
    "home": (6042137469204303531, "\U0001F3E0"),
    "server": (5942734685976138521, "\U0001F5A5"),
    "cpu": (5884428842780594914, "\U000026A1"),
    "tunnel": (6048723247501938454, "\U0001F6DC"),
    "calls": (6039605143601680423, "\U0001F4DE"),
    "settings": (6032742198179532882, "\U00002699"),
    "update": (5769248574499983619, "\U0001F504"),
    "language": (5776233299424843260, "\U0001F310"),
    "back": (5960671702059848143, "\U00002B05\U0000FE0F"),
    "add": (6032924188828767321, "\U00002795"),
    "ok": (5774022692642492953, "\U00002705"),
    "fail": (6030757850274336631, "\U0000274C"),
    "warn": (6030563507299160824, "\U00002757\U0000FE0F"),
    "info": (6028435952299413210, "\U00002139"),
    "idea": (5891120964468480450, "\U0001F4A1"),
    "lock": (6037249452824072506, "\U0001F512"),
    "unlock": (6037496202990194718, "\U0001F513"),
    "shield": (6030537007350944596, "\U0001F6E1"),
    "link": (6028171274939797252, "\U0001F517"),
    "copy": (6039451237743595514, "\U0001F4CE"),
    "refresh": (6030657343744644592, "\U0001F501"),
    "restart": (5767310088255576068, "\U0001F503"),
    "delete": (6039522349517115015, "\U0001F5D1"),
    "stop": (5938215362473496448, "\U0001F6AB"),
    "play": (5773626993010546707, "\U000025B6\U0000FE0F"),
    "save": (6041730074376410123, "\U0001F4E5"),
    "user": (6032994772321309200, "\U0001F464"),
    "users": (6032609071373226027, "\U0001F465"),
    "bot": (6030400221232501136, "\U0001F916"),
    "clock": (5850317551090800862, "\U000023F0"),
    "logs": (5895519358871932592, "\U0001F4F0"),
    "file": (6034969813032374911, "\U0001F4C4"),
    "box": (5778672437122045013, "\U0001F4E6"),
    "tag": (5888620056551625531, "\U0001F3F7"),
    "chart": (5936143551854285132, "\U0001F4CA"),
    "docs": (6037286673010660132, "\U0001F4D6"),
    "compass": (6030687898141987254, "\U0001F9ED"),
    "scan": (6032850693348399258, "\U0001F50E"),
    "star": (6028338546736107668, "\U00002B50\U0000FE0F"),
    "tools": (5962952497197748583, "\U0001F527"),
    "target": (6032949275732742941, "\U0001F3AF"),
    "bell": (6039486778597970865, "\U0001F514"),
    "key": (6037249452824072506, "\U0001F512"),
    "world": (5776233299424843260, "\U0001F310"),
    "bug": (5962952497197748583, "\U0001F41B"),
    "loading": (5850317551090800862, "\U000023F3"),
    "plug": (6048723247501938454, "\U0001F50C"),
    "route": (6030687898141987254, "\U0001F6E4"),
}

# the pack is off unless the owner turns it on: the plain unicode fallback is what a fresh install shows
_ICONS_ON = False


def use_icons(value: bool) -> None:
    global _ICONS_ON
    _ICONS_ON = bool(value)


def icons_on() -> bool:
    return _ICONS_ON


def ico(name: object, tail: str = " ") -> str:
    if not _ICONS_ON:
        return ""
    ident, alt = ICONS.get(str(name or ""), (0, ""))
    if not ident:
        return ""
    return '<tg-emoji emoji-id="' + str(ident) + '">' + alt + "</tg-emoji>" + tail


# ------------------------------------------------------------------ primitives
def esc(value: Any) -> str:
    return escape(CONTROL.sub("", str(value)), quote=True)


def code(value: Any) -> str:
    return f"<code>{esc(value)}</code>"


def bold(value: Any) -> str:
    return f"<b>{esc(value)}</b>"


def muted(value: Any) -> str:
    return f'<span style="color: #8a8a8a">{esc(value)}</span>'


def muted_html(body: str) -> str:
    return f'<span style="color: #8a8a8a">{body}</span>'


CHIP_OPEN = '<span style="color: #4a7fb5"><b>'
CHIP_SHUT = "</b></span>"


def chip(value: Any) -> str:
    """A state in words. No <mark>: the yellow block is loud and ugly, so a chip is just quiet bold blue."""
    return CHIP_OPEN + esc(value) + CHIP_SHUT


def chip_html(body: str) -> str:
    return CHIP_OPEN + body + CHIP_SHUT


def status_chip(ok: bool, text: str, icon: str = "") -> str:
    """A state, marked by an icon (when the pack is on) and coloured words: green for yes, coral for no."""
    tag = icon or ("ok" if ok else "fail")
    tone = "#3f8f5f" if ok else "#b4553f"
    return f'<span style="color: {tone}"><b>{ico(tag, "")}{esc(text)}</b></span>'


def link(label: Any, url: str) -> str:
    return f'<a href="{esc(url)}">{esc(label)}</a>'


def pre(text: Any, lang: str = "") -> str:
    raw = str(text or "").replace("\r\n", "\n").replace("\r", "\n")
    if lang:
        return f'<pre><code class="language-{esc(lang)}">{esc(raw)}</code></pre>'
    return f"<pre>{esc(raw)}</pre>"


def heading(text: str, level: int = 3, icon: str = "") -> str:
    return f"<h{level}>{ico(icon, '')}{esc(text)}</h{level}>"


def divider() -> str:
    return "<hr/>"


def quote(body: str, cite: str = "") -> str:
    if cite:
        return f"<blockquote>{body}<cite>{esc(cite)}</cite></blockquote>"
    return f"<blockquote>{body}</blockquote>"


def bullet_list(items: Iterable[str]) -> str:
    return "<ul>" + "".join(f"<li>{item}</li>" for item in items) + "</ul>"


def details(title: str, body: str, open_: bool = False) -> str:
    flag = " open" if open_ else ""
    return f"<details{flag}><summary>{esc(title)}</summary>{body}</details>"


# ------------------------------------------------------------------ buttons
class Button:
    __slots__ = ("label", "data", "style", "icon")

    def __init__(self, label: str, data: str, style: str = "", icon: str = "") -> None:
        self.label = label
        self.data = data
        self.style = style
        self.icon = icon

    def html(self) -> str:
        if len(self.data.encode("utf-8")) > MAX_CALLBACK:
            raise ValueError("callback data is too long: " + self.data)
        style = f' style="{esc(self.style)}"' if self.style else ""
        body = ico(self.icon, "") + esc(self.label)
        return f'<tg-button type="callback_data"{style} data="{esc(self.data)}">{body}</tg-button>'


def button(label: str, data: str, style: str = "", icon: str = "") -> Button:
    return Button(label, data, style, icon)


def link_button(label: str, url: str, icon: str = "link") -> str:
    return f'<tg-button type="url" url="{esc(url)}">{ico(icon, "")}{esc(label)}</tg-button>'


def copy_button(label: str, text: str, icon: str = "copy") -> str:
    return f'<tg-button type="copy_text" text="{esc(text)}">{ico(icon, "")}{esc(label)}</tg-button>'


def inline_button(label: str, query: str, style: str = "", icon: str = "") -> str:
    """A button that opens the message field with `query` already in it — the OBHOD way to ask for a value.

    The owner types the value there, sees it as a live result and taps it; no /command, no stray reply to guess at.
    """
    attr = f' style="{esc(style)}"' if style else ""
    return f'<tg-button type="switch_inline_query_current_chat"{attr} query="{esc(query)}">{ico(icon, "")}{esc(label)}</tg-button>'


def input_row(label: str, ident: str, ctx: object = "-", icon: str = "tag") -> str:
    """One button for a field: the inline field, plus a list button when the field has a few usual values."""
    from . import inline

    buttons: list[str] = [inline_button(label, inline.prefill(ident, ctx), icon=icon)]
    if inline.has_options(ident):
        buttons.append(inline_button("pick", inline.list_query(ident, ctx), icon="compass"))
    return row(*buttons)


def row(*buttons: "Button | str", align: str = "left") -> str:
    flat: list[Any] = []
    for item in buttons:
        if isinstance(item, (list, tuple)):
            flat.extend(item)
        else:
            flat.append(item)
    inner = "".join(b.html() if isinstance(b, Button) else b for b in flat if b)
    if not inner:
        return ""
    return f'<tg-button-row align="{esc(align)}">{inner}</tg-button-row>'


def rows(items: Iterable[str]) -> str:
    return "".join(item for item in items if item)


# ------------------------------------------------------------------ screen
def screen(
    title: str,
    subtitle: str = "",
    blocks: Iterable[str] = (),
    buttons: Iterable[str] = (),
    footer: str = "",
    icon: str = "",
) -> Rich:
    root = ScreenRich()
    root.add(f"<h2>{ico(icon, '')}{esc(title)}</h2>")
    if subtitle:
        root.add(f"<p>{subtitle}</p>")
    for block in blocks:
        if block:
            root.add(block)
    button_html = [item for item in buttons if item]
    if button_html:
        root.add(divider())
        for item in button_html:
            root.add(item)
    if footer:
        root.add(f"<footer>{footer}</footer>")
    return root


def table(pairs: Iterable[Any], headers: tuple[str, str] | None = None) -> str:
    head = ""
    if headers:
        head = f'<tr><th align="center">{esc(headers[0])}</th><th align="center">{esc(headers[1])}</th></tr>'
    cells = []
    for item in pairs:
        if isinstance(item, (list, tuple)):
            values = list(item)
            icon = str(values[0] or "") if len(values) >= 3 else ""
            key = str(values[1]) if len(values) >= 3 else str(values[0])
            value = values[2] if len(values) >= 3 else values[1]
        else:
            icon, key, value = "", str(item), ""
        cells.append(f'<tr><td align="center">{ico(icon, "")}{esc(key)}</td><td align="center">{value}</td></tr>')
    return f'<table bordered="false" striped="false">{head}{"".join(cells)}</table>'


def facts(pairs: Iterable[tuple[str, Any]], icon: str = "") -> str:
    """Two-column facts: what it is, and what it says. The everyday building block of a MSE screen."""
    return table([(icon, key, value) for key, value in pairs])


def count_buttons(html: str) -> int:
    return html.count("<tg-button ")


def validate(html: str) -> None:
    total = count_buttons(html)
    if total > MAX_BUTTONS:
        raise ValueError(f"too many buttons: {total}")
