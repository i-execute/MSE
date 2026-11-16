"""Inline input, the way the OBHOD panel does it.

A button of type `switch_inline_query_current_chat` opens the message field with a short query already in it. That
query carries a signed token (10 chars, HMAC of "kind|field|context") and nothing else, so the owner types the value
right where he would type a message, sees it as a live result, and taps it to send. Telegram then hands the bot a
`chosen_inline_result` with the result id, the bot answers the payload, and the value is applied.

Why not /command <value>: a token never goes into the chat history, a value is never guessed from a stray message,
and the same button works for a 60-character tailscale key as well as for a number. A secret is typed in the inline
field, applied on the tap, and the message the client posts is deleted.

Nothing here imports the bot: it is a pure translation layer, so it can be tested without a network.
"""
from __future__ import annotations

import hashlib
import hmac
import os
import re
from dataclasses import dataclass
from typing import Any, Callable

TOKEN_LEN = 10
MAX_QUERY = 256
MAX_VALUE = MAX_QUERY - TOKEN_LEN - 1
MAX_REGISTRY = 256
MAX_RESULTS = 20
ALPHABET = "abcdefghijklmnopqrstuvwxyz234567"
MARKER = "\U0001F4DD"                 # what a chosen value is prefixed with when the client sends it
SEPARATOR = "\u2063"
MODE_INPUT = "i"
MODE_LIST = "l"
KIND_INPUT = "i"
KIND_OPTION = "o"
KIND_STALE = "s"
CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
TOKEN_RE = re.compile(r"^[a-z2-7]{10}$")
PAYLOAD_RE = re.compile(r"^([a-z2-7]{10})([ios])([a-z2-7])([a-z2-7]*)$")

_SECRET = os.urandom(32)
_REGISTRY: dict[str, tuple[str, str, str]] = {}
_PENDING: list[tuple[str, str, int, str]] = []


class InlineError(Exception):
    pass


@dataclass(frozen=True)
class Field:
    ident: str
    label: str
    hint: str
    example: str = ""
    secret: bool = False
    check: str = ""       # "" | "digits" | "token" | "signed"


# every value the owner can type, and where it lands
FIELDS: dict[str, Field] = {
    "bot_token": Field("bot_token", "bot token", "from @BotFather: /newbot, then copy 1234567890:AAH...",
                       "1234567890:AAH...", True, "token"),
    "owner_id": Field("owner_id", "owner id", "your numeric telegram id, the account the bot answers",
                      "100000001", False, "signed"),
    "api_id": Field("api_id", "api id", "my.telegram.org -> App api_id (optional, only for the mt transport)",
                    "10000001", False, "digits"),
    "api_hash": Field("api_hash", "api hash", "my.telegram.org -> App api_hash (optional, masked)",
                      "0123456789abcdef", True),
    "tailscale_key": Field("tailscale_key", "tailscale key", "tskey-auth-... from the keys page of the tailnet",
                           "tskey-auth-xxxx", True),
    "model": Field("model", "model", "the model the local AI backend serves", ""),
    "quota": Field("quota", "quota", "requests per day per device", "200", False, "digits"),
    "allow_id": Field("allow_id", "Moodle id", "the id of the person to let in", "2040", False, "digits"),
    "revoke_id": Field("revoke_id", "Moodle id or device", "whose access to take away", "2040"),
    "name": Field("name", "name", "how the person is called in the list", "Gugi"),
}

OPTIONS: dict[str, tuple[str, ...]] = {
    "quota": ("50", "100", "200", "500", "1000"),
    # the model list is never written down here: the bot fills it from the backend before it offers the inline query
    "model": (),
}


def set_options(ident: str, values: tuple[str, ...] | list[str]) -> None:
    """Fill a live list (the models of the backend, for instance) right before the query is offered."""
    OPTIONS[ident] = tuple(str(v) for v in values if str(v).strip())


# ------------------------------------------------------------------ registry
def configure(secret: str = "") -> None:
    """Key the tokens. Called once at start with MSE_ADMIN_TOKEN (or a random key when it is empty)."""
    global _SECRET
    token = str(secret or "").strip().lower()
    if re.fullmatch(r"[0-9a-f]{64}", token):
        _SECRET = bytes.fromhex(token)
    elif token:
        _SECRET = hashlib.sha256(token.encode("utf-8")).digest()
    else:
        _SECRET = os.urandom(32)
    _REGISTRY.clear()
    _PENDING.clear()


def field(ident: str) -> Field:
    item = FIELDS.get(ident)
    if item is None:
        raise InlineError("unknown input field: " + str(ident)[:32])
    return item


def _digest(text: str) -> str:
    payload = hmac.new(_SECRET, text.encode("utf-8"), hashlib.sha256).digest()
    out = ""
    for byte in payload:
        out += ALPHABET[byte % 32]
        if len(out) >= TOKEN_LEN:
            break
    return out


def token_for(ident: str, ctx: object = "", mode: str = MODE_INPUT) -> str:
    field(ident)
    clean = normalize_ctx(ctx)
    kind = MODE_LIST if str(mode) == MODE_LIST else MODE_INPUT
    token = _digest("%s|%s|%s" % (kind, ident, clean))
    current = _REGISTRY.get(token)
    if current is not None and current[:2] != (ident, clean):
        token = _digest("%s|%s|%s|salt" % (kind, ident, clean))
    _REGISTRY[token] = (ident, clean, kind)
    while len(_REGISTRY) > MAX_REGISTRY:
        _REGISTRY.pop(next(iter(_REGISTRY)))
    return token


def resolve(token: str) -> tuple[str, str, str]:
    return _REGISTRY.get(str(token or "").strip().lower(), ("", "", ""))


def normalize_ctx(ctx: object) -> str:
    text = CONTROL.sub("", str(ctx if ctx is not None else "")).strip()
    return "" if text in ("", "-") else text[:32]


# ------------------------------------------------------------------ queries
def prefill(ident: str, ctx: object = "-") -> str:
    """What goes into the message field: the token and a space, ready for the value."""
    return token_for(ident, ctx, MODE_INPUT) + " "


def ident_of(query: str) -> str:
    """Which field an inline query is about, or "" — the bot fills live lists before it answers."""
    token, _value = parse_query(query)
    if not token:
        return ""
    ident, _ctx, _mode = resolve(token)
    return ident or ""


def list_query(ident: str, ctx: object = "-") -> str:
    return token_for(ident, ctx, MODE_LIST)


def has_options(ident: str) -> bool:
    return bool(OPTIONS.get(ident))


def options(ident: str) -> tuple[str, ...]:
    return tuple(OPTIONS.get(ident, ()))


def parse_query(query: str) -> tuple[str, str]:
    raw = CONTROL.sub("", str(query or "")).strip()
    if not raw:
        return "", ""
    parts = raw.split(None, 1)
    token = parts[0].strip().lower()
    value = parts[1].strip() if len(parts) > 1 else ""
    if not TOKEN_RE.match(token):
        return "", raw
    return token, value


def query_body(query: str) -> str:
    raw = CONTROL.sub("", str(query or ""))
    return raw[1:] if raw.startswith(" ") else raw


def clean_value(ident: str, value: str) -> str:
    item = field(ident)
    text = " ".join(CONTROL.sub("", str(value or "")).split())
    if item.secret:
        text = CONTROL.sub("", str(value or "")).strip()       # a key keeps its exact bytes
    if len(text) > MAX_VALUE:
        raise InlineError("%s is too long: %d characters at most" % (item.label, MAX_VALUE))
    if item.check == "digits" and text and not text.isdigit():
        raise InlineError("%s is a number" % item.label)
    if item.check == "signed" and text and not text.lstrip("-").isdigit():
        raise InlineError("%s is a number (a negative one for a group)" % item.label)
    if item.check == "token" and text and ":" not in text:
        raise InlineError("%s looks like 1234567890:AAH..." % item.label)
    return text


# ------------------------------------------------------------------ results
def article(rid: str, title: str, description: str, text: str, src: str = "mt") -> dict[str, Any]:
    """One inline result, in the shape the transport actually wants.

    goygram's inline answer goes out over MTProto as messages.setInlineBotResults, and there every nested object
    needs its constructor name in "_" — a bot-API shaped dict fails with "nested object missing _", which is exactly
    what happened before. MSE only ever runs on the MTProto path (the bot token is used for requests, the account
    for transport), so the MTProto shape is the only one built here; `src="bot"` stays for a plain bot-api client.
    """
    ident = rid if len(rid) <= 64 else rid[:64]
    title = " ".join(str(title or "").split())[:120]
    description = " ".join(str(description or "").split())[:240]
    if str(src) == "bot":
        return {
            "type": "article",
            "id": ident,
            "title": title,
            "description": description,
            "input_message_content": {"message_text": text, "disable_web_page_preview": True},
        }
    return {
        "_": "inputBotInlineResult",
        "id": ident,
        "type": "article",
        "title": title,
        "description": description,
        "send_message": {"_": "inputBotInlineMessageText", "no_webpage": True, "message": text},
    }


def input_article(token: str, item: Field, value: str, current: str, index: int = 0) -> dict[str, Any]:
    title = item.label + (" -> " + _short(value, item) if value else "")
    if value:
        description = "tap to save this value"
    elif current:
        description = "now " + current
    else:
        description = item.hint + (" (for example " + item.example + ")" if item.example else "")
    remember_pending(token, KIND_INPUT, -1, value)
    return article("%s:%s" % (KIND_INPUT, token), title, description, MARKER)


def option_article(token: str, index: int, value: str, item: Field) -> dict[str, Any]:
    return article("%s:%s:%d" % (KIND_OPTION, token, index), value or "empty",
                   "use this %s" % item.label, MARKER)


def stale_article(token: str) -> dict[str, Any]:
    head = token[:TOKEN_LEN] if TOKEN_RE.match(token[:TOKEN_LEN]) else ALPHABET[0] * TOKEN_LEN
    return article("%s:%s" % (KIND_STALE, head), "this button is out of date",
                   "open the panel again and use a fresh button", MARKER)


def results_for(query: str, current: dict[str, str] | None = None) -> list[dict[str, Any]]:
    shown = current or {}
    token, value = parse_query(query)
    if not token:
        return []
    ident, _ctx, mode = resolve(token)
    if not ident:
        return [stale_article(token)]
    item = field(ident)
    if len(query_body(query)) > MAX_QUERY:
        return [article("%s:%s" % (KIND_INPUT, token), item.label, "too long: %d characters at most" % MAX_VALUE, MARKER)]
    if value:
        try:
            clean = clean_value(ident, value)
        except InlineError as exc:
            return [article("%s:%s" % (KIND_INPUT, token), item.label, str(exc), MARKER)]
        return [input_article(token, item, clean, shown.get(ident, ""))]
    if mode == MODE_LIST and has_options(ident):
        head = input_article(token_for(ident, _ctx, MODE_INPUT), item, "", shown.get(ident, ""))
        head["description"] = "type a value, or pick one of these"
        out = [head]
        for index, option in enumerate(options(ident)):
            out.append(option_article(token, index, option, item))
            if len(out) >= MAX_RESULTS:
                break
        return out
    return [input_article(token, item, "", shown.get(ident, ""))]


# ------------------------------------------------------------------ values out
def value_for(kind: str, token: str, index: int, query: str = "") -> tuple[str, str, str]:
    """(ident, ctx, value) from a tapped result. Raises InlineError when the token is stale."""
    ident, ctx, _mode = resolve(token)
    if not ident:
        raise InlineError("this button is out of date: open the panel again")
    if kind == KIND_OPTION:
        items = options(ident)
        if index < 0 or index >= len(items):
            raise InlineError("this button is out of date")
        return ident, ctx, items[index]
    _token, raw = parse_query(query)
    return ident, ctx, clean_value(ident, raw)


def value_from_payload(token: str, kind: str, index: int, body: str) -> tuple[str, str, str]:
    """(ident, ctx, value) from the text the client posted after the tap (the fallback path)."""
    ident, ctx, _mode = resolve(token)
    if not ident:
        raise InlineError("this button is out of date")
    if kind == KIND_OPTION:
        items = options(ident)
        if index < 0 or index >= len(items):
            raise InlineError("this button is out of date")
        return ident, ctx, items[index]
    return ident, ctx, clean_value(ident, body)


def answer(evt: object, results: list[dict[str, Any]]) -> Any:
    """goygram's inline answer: empty list means nothing to offer, which is what a stranger must get."""
    return evt.answer(results=results, cache_time=0, is_personal=True)


# ------------------------------------------------------------------ payload (the posted message)
def remember_pending(token: str, kind: str, index: int, value: str) -> None:
    _PENDING.clear()
    _PENDING.append((str(token or ""), str(kind or KIND_INPUT), int(index), str(value or "")))


def consume_pending() -> tuple[str, str, int, str]:
    if not _PENDING:
        return "", "", -1, ""
    return _PENDING.pop(0)


def payload_text(token: str, kind: str, index: int, value: str) -> str:
    if kind == KIND_OPTION and 0 <= index < len(ALPHABET):
        return MARKER + SEPARATOR + token + KIND_OPTION + ALPHABET[index]
    return MARKER + SEPARATOR + token + KIND_INPUT + ALPHABET[0] + _encode(value)


def parse_payload(text: str) -> tuple[str, str, int, str]:
    raw = str(text or "")
    if not raw.startswith(MARKER) or SEPARATOR not in raw:
        return "", "", -1, ""
    match = PAYLOAD_RE.match(raw.split(SEPARATOR, 1)[1].strip())
    if not match:
        return "", "", -1, ""
    token, kind, slot, body = match.groups()
    if kind == KIND_OPTION:
        return token, KIND_OPTION, ALPHABET.index(slot), ""
    if kind == KIND_STALE:
        return "", "", -1, ""
    return token, KIND_INPUT, -1, _decode(body)


def _encode(value: str) -> str:
    data = str(value or "").encode("utf-8")
    out = ""
    for index in range(0, len(data), 5):
        chunk = int.from_bytes(data[index:index + 5].ljust(5, b"\x00"), "big")
        for shift in (35, 30, 25, 20, 15, 10, 5, 0):
            out += ALPHABET[(chunk >> shift) & 31]
    return out


def _decode(body: str) -> str:
    body = str(body or "").lower()
    if not body or len(body) % 8:
        return ""
    data = b""
    for index in range(0, len(body), 8):
        chunk = 0
        for char in body[index:index + 8]:
            if char not in ALPHABET:
                return ""
            chunk = (chunk << 5) | ALPHABET.index(char)
        data += chunk.to_bytes(5, "big")
    return data.rstrip(b"\x00").decode("utf-8", "replace")


def _short(value: str, item: Field) -> str:
    text = str(value)
    if item.secret and len(text) > 6:
        return text[:4] + "…" + text[-2:]
    return text if len(text) <= 28 else text[:27] + "…"


def parse_result_id(rid: str) -> tuple[str, str, int]:
    parts = str(rid or "").split(":")
    if len(parts) != 2 or parts[0] not in (KIND_INPUT, KIND_OPTION, KIND_STALE):
        return "", "", -1
    if not TOKEN_RE.match(parts[1]):
        return "", "", -1
    return parts[0], parts[1], -1


def parse_option_id(rid: str) -> tuple[str, str, int]:
    parts = str(rid or "").split(":")
    if len(parts) != 3 or parts[0] != KIND_OPTION or not parts[2].isdigit():
        return "", "", -1
    if not TOKEN_RE.match(parts[1]):
        return "", "", -1
    return KIND_OPTION, parts[1], int(parts[2])


# ------------------------------------------------------------------ who may type
def allowed(who: int, owner_id: int) -> bool:
    """Only the owner: an inline query from anybody else gets an empty answer, which is silence."""
    return bool(owner_id) and int(who or 0) == int(owner_id)


def dispatcher(owner_id: int) -> Callable[[int], bool]:
    return lambda who: allowed(who, owner_id)
