"""MSE setup — the server's control panel in the terminal.

A port of `Storage/obhod_setup.py` from i-execute/OBHOD: the same engine (glyphs, theme, cbreak session, KeyReader,
Menu, CheckMenu, FieldEditor, LiveBox, Spinner) and the same manner of screens — frames, pills, steps, live
progress. Only the content changed: instead of Xray-core and FreeTurn there is the MSE router, the AI backend,
the tailscale tunnel and the bot.

    sudo mse              the interactive panel (the OBHOD menu)
    sudo mse update       update the code and dependencies in place
    sudo mse --status     the same without questions: print the state and exit (for scripts and CI)
    sudo mse --version

What it does: installs and repairs the stack, shows the health (router, backend, tunnel, bot), edits
/etc/mse/mse.env, brings tailscale and the funnel up, restarts the services and reads the journal. The model key
is never asked for and never stored here: it lives in the AI backend.
"""
from __future__ import annotations

import atexit
import json
import os
import queue
import re
import select
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path

OK = "ok"
BAD = "bad"
WARN = "warn"
INFO = "info"
TITLE = "MSE setup"
DEFAULT_PREFIX = "/opt/mse"
DEFAULT_STATE = "/var/lib/mse"
DEFAULT_ENV = "/etc/mse/mse.env"
MAX_WIDTH = 90
INLINE_WARN_TEXT = "THE BOT IS ALIVE, BUT INLINE MODE IS OFF IN BOTFATHER"


def probe_bot_inline(token: str, timeout: float = 5.0) -> tuple[bool, bool | None, str]:
    tok = str(token or "").strip()
    if not tok or ":" not in tok or "dry-run-sample" in tok:
        return False, None, ""
    url = "https://api.telegram.org/bot%s/getMe" % tok
    req = urllib.request.Request(url, headers={"User-Agent": "mse-setup/2"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            payload = json.loads(resp.read(32768).decode("utf-8", "replace"))
    except Exception:
        return False, None, ""
    if not isinstance(payload, dict) or not payload.get("ok"):
        return False, None, ""
    result = payload.get("result")
    if not isinstance(result, dict):
        return True, None, ""
    uname = str(result.get("username") or "")
    supports = result.get("supports_inline_queries")
    return True, (bool(supports) if isinstance(supports, bool) else None), uname
MIN_WIDTH = 44
ESC_TIMEOUT = 0.15
SEQ_TIMEOUT = 0.25
CRLF_TIMEOUT = 0.015
SECRET_ENV = ("BOT_TOKEN", "API_HASH", "TAILSCALE_KEY")
TOKEN_RE = re.compile(r"^[0-9]{5,}:[A-Za-z0-9_-]{30,}$")
HASH_RE = re.compile(r"^[0-9a-fA-F]{32}$")
TSKEY_RE = re.compile(r"^tskey-(?:auth|client|api)-[A-Za-z0-9_-]{10,}$")
ANSI_RE = re.compile("\033\\[[0-9;?]*[A-Za-z]")
SGR_PART_RE = re.compile("(\033\\[[0-9;?]*[A-Za-z])")


def glyph(code: str) -> str:
    return chr(int(code, 16))


class g:
    tl = glyph("256d")
    tr = glyph("256e")
    bl = glyph("2570")
    br = glyph("256f")
    ml = glyph("251c")
    mr = glyph("2524")
    h = glyph("2500")
    v = glyph("2502")
    rail = glyph("2503")
    dash = glyph("2504")
    dot_on = glyph("25c6")
    dot_off = glyph("25c7")
    radio_on = glyph("25c9")
    radio_off = glyph("25cb")
    box_on = glyph("25fc")
    box_off = glyph("25fb")
    check = glyph("2714")
    cross = glyph("2716")
    tri = glyph("25b2")
    arrow = glyph("276f")
    bullet = glyph("2022")
    bar_on = glyph("2588")
    bar_off = glyph("2591")
    spark = glyph("2726")
    ring = glyph("25cb")
    fill = glyph("25cf")
    up = glyph("2191")
    down = glyph("2193")
    left = glyph("2190")
    right = glyph("2192")
    half = glyph("00b7")
    dots = glyph("2026")


class theme:
    """Light, unsaturated blue: the accent is a soft sky blue, surfaces are a deep navy blue (never black)."""
    reset = "\033[0m"
    bold = "1"
    dim = "2"
    frame = "38;5;110"          # soft blue frame
    frame_active = "38;5;153"   # lighter blue when the screen has focus
    frame_dim = "38;5;60"       # dim blue for idle rules
    title = "1;38;5;153"        # pale blue title
    subtitle = "38;5;117"
    accent = "38;5;117"         # light blue accent
    good = "38;5;116"           # calm cyan-green, only for "ok"
    warn = "38;5;180"           # muted amber
    bad = "38;5;167"            # muted coral
    muted = "38;5;103"
    subtle = "38;5;60"
    text = "38;5;189"
    bright = "1;38;5;195"
    chip = "48;5;17;38;5;189"
    keycap = "1;48;5;24;38;5;195"
    badge_ok = "1;48;5;23;38;5;152"
    badge_warn = "1;48;5;58;38;5;223"
    badge_bad = "1;48;5;52;38;5;217"
    badge_info = "1;48;5;24;38;5;195"
    row_focus = "48;5;17"
    key = "38;5;153"
    cursor = "1;38;5;153"


def color_enabled() -> bool:
    if os.environ.get("MSE_FORCE_COLOR", "") == "1":
        return True
    if os.environ.get("NO_COLOR"):
        return False
    if os.environ.get("MSE_NO_UI") == "1":
        return False
    if os.environ.get("TERM", "") in {"dumb", ""} and not os.environ.get("COLORTERM"):
        return False
    try:
        return sys.stdout.isatty()
    except Exception:
        return False


COLOR = color_enabled()
_SAVED_ATTRS: list[tuple[int, list]] = []
_CURSOR_HIDDEN = False
_RESIZED = False


def _on_winch(_signum: int, _frame: object) -> None:
    global _RESIZED
    _RESIZED = True


def restore_terminal() -> None:
    global _CURSOR_HIDDEN
    try:
        import termios

        while _SAVED_ATTRS:
            fd, attrs = _SAVED_ATTRS.pop()
            try:
                termios.tcsetattr(fd, termios.TCSADRAIN, attrs)
            except OSError:
                pass
    except ImportError:
        _SAVED_ATTRS.clear()
    if _CURSOR_HIDDEN:
        try:
            sys.stdout.write("\033[?25h")
            sys.stdout.flush()
        except Exception:
            pass
        _CURSOR_HIDDEN = False


atexit.register(restore_terminal)


def hide_cursor() -> None:
    global _CURSOR_HIDDEN
    if COLOR and not _CURSOR_HIDDEN:
        _CURSOR_HIDDEN = True
        flush("\033[?25l")


def show_cursor() -> None:
    global _CURSOR_HIDDEN
    if _CURSOR_HIDDEN:
        _CURSOR_HIDDEN = False
        flush("\033[?25h")


def paint(text: str, *codes: str) -> str:
    if not COLOR or not codes:
        return str(text)
    return "".join("\033[%sm" % code for code in codes if code) + str(text) + theme.reset


def keycap(label: str, action: str) -> str:
    if not COLOR:
        return "[%s] %s" % (label, action)
    return paint(" " + label + " ", theme.keycap) + " " + paint(action, theme.muted)


def pill(label: str, style: str = theme.badge_info) -> str:
    if not COLOR:
        return "[%s]" % label
    return paint(" " + label + " ", style)


def vlen(text: str) -> int:
    return len(ANSI_RE.sub("", str(text)))


def term_size() -> tuple[int, int]:
    for candidate in (sys.stdout, sys.stderr, sys.stdin):
        try:
            fd = candidate.fileno()
            if os.isatty(fd):
                sz = os.get_terminal_size(fd)
                return int(sz.columns), int(sz.lines)
        except Exception:
            continue
    try:
        tty_fd = os.open("/dev/tty", os.O_RDONLY | getattr(os, "O_NOCTTY", 0))
        try:
            sz = os.get_terminal_size(tty_fd)
            return int(sz.columns), int(sz.lines)
        finally:
            os.close(tty_fd)
    except Exception:
        pass
    try:
        size = shutil.get_terminal_size(fallback=(88, 28))
        return int(size.columns), int(size.lines)
    except Exception:
        return 88, 28


def width() -> int:
    columns, _rows = term_size()
    return max(MIN_WIDTH, min(columns - 2, MAX_WIDTH))


def clip(text: str, limit: int) -> str:
    raw = str(text)
    if limit <= 0:
        return ""
    plain = ANSI_RE.sub("", raw)
    if len(plain) <= limit:
        return raw
    if limit == 1:
        return g.dots
    target = limit - 1
    parts = SGR_PART_RE.split(raw)
    out: list[str] = []
    seen = 0
    saw_ansi = False
    for part in parts:
        if not part:
            continue
        if SGR_PART_RE.fullmatch(part):
            out.append(part)
            saw_ansi = True
            continue
        remain = target - seen
        if remain <= 0:
            break
        take = part[:remain]
        out.append(take)
        seen += len(take)
        if seen >= target:
            break
    out.append(g.dots)
    if saw_ansi:
        out.append(theme.reset)
    return "".join(out)


def wrap(text: str, limit: int) -> list[str]:
    limit = max(8, limit)
    words = str(text).split(" ")
    lines: list[str] = []
    current = ""
    for word in words:
        candidate = word if not current else current + " " + word
        if vlen(candidate) <= limit:
            current = candidate
            continue
        if current:
            lines.append(current)
        plain = ANSI_RE.sub("", word)
        if len(plain) <= limit:
            current = word
            continue
        while len(plain) > limit:
            lines.append(plain[:limit])
            plain = plain[limit:]
        current = plain
    if current:
        lines.append(current)
    return lines or [""]


def pad(text: str, limit: int) -> str:
    extra = limit - vlen(text)
    return text + " " * max(0, extra)


def mask_secret(name: str, value: str) -> str:
    text = str(value or "")
    if not text:
        return ""
    if name in ("BOT_TOKEN",):
        head = text.split(":", 1)[0]
        return head + ":" + "*" * 6
    if name in SECRET_ENV:
        return text[:6] + "*" * max(0, len(text) - 10) + text[-4:] if len(text) > 12 else "*" * len(text)
    return text


def write(text: str = "") -> None:
    sys.stdout.write(text + "\n")
    sys.stdout.flush()


def flush(text: str) -> None:
    sys.stdout.write(text)
    sys.stdout.flush()


def frame_top(title: str, limit: int, tone: str = theme.frame, right_note: str = "") -> str:
    right_part = ""
    reserve = 6
    if right_note:
        clipped_right = clip(right_note, max(8, limit // 3))
        right_part = " " + clipped_right + " " + paint(g.h, tone)
        reserve += vlen(right_part)
    label = clip(title, max(6, limit - reserve))
    left_body = paint(g.h, tone) + " " + (label if "\033[" in label else paint(label, theme.title)) + " "
    rest = limit - 2 - vlen(left_body) - vlen(right_part)
    return paint(g.tl, tone) + left_body + paint(g.h * max(0, rest), tone) + right_part + paint(g.tr, tone)


def frame_rule(limit: int, tone: str = theme.frame, dashed: bool = True) -> str:
    fill = g.dash if dashed else g.h
    mid_tone = theme.frame_dim if dashed else tone
    return paint(g.ml, tone) + paint(fill * max(0, limit - 2), mid_tone) + paint(g.mr, tone)


def frame_bottom(limit: int, tone: str = theme.frame) -> str:
    return paint(g.bl + g.h * max(0, limit - 2) + g.br, tone)


def frame_line(body: str, limit: int, tone: str = theme.frame, bg: str = "") -> str:
    inner = max(4, limit - 4)
    clipped = clip(body, inner)
    spaces = " " * max(0, inner - vlen(clipped))
    cell = clipped + spaces
    if bg and COLOR:
        cell = "\033[%sm" % bg + cell.replace(theme.reset, theme.reset + "\033[%sm" % bg) + theme.reset
    return paint(g.v, tone) + " " + cell + " " + paint(g.v, tone)


def frame_lines(body: str, limit: int, tone: str = theme.frame) -> list[str]:
    if body == "":
        return [frame_line("", limit, tone)]
    return [frame_line(item, limit, tone) for item in wrap(body, max(8, limit - 4))]


def panel(title: str, rows: list[str], limit: int = 0, tone: str = theme.frame, right_note: str = "") -> None:
    limit = limit or width()
    out = ["", frame_top(title, limit, tone, right_note), frame_line("", limit, tone)]
    for row in rows:
        out.extend(frame_lines(row, limit, tone))
    out.append(frame_line("", limit, tone))
    out.append(frame_bottom(limit, tone))
    write("\n".join(out))


def fact(label: str, value: str, note: str = "") -> str:
    tail = paint("  " + note, theme.muted) if note else ""
    return paint(pad(label.strip(), 13), theme.key) + " " + paint(value, theme.text) + tail


def badge(kind: str) -> str:
    if kind == OK:
        return pill(g.check + " ok", theme.badge_ok)
    if kind == WARN:
        return pill(g.tri + " warn", theme.badge_warn)
    if kind == BAD:
        return pill(g.cross + " fail", theme.badge_bad)
    return pill(g.ring + " info", theme.badge_info)


def mark(kind: str) -> str:
    if kind == OK:
        return paint(g.check, theme.good, theme.bold)
    if kind == WARN:
        return paint(g.tri, theme.warn, theme.bold)
    if kind == BAD:
        return paint(g.cross, theme.bad, theme.bold)
    return paint(g.ring, theme.muted)


def section(number: int, title: str, rows: list[str], tone: str = theme.frame, note: str = "") -> None:
    limit = width()
    head = paint("%d" % number, theme.accent, theme.bold) + paint(" " + g.half + " ", theme.muted) + paint(title, theme.title)
    right_note = paint(note, theme.muted) if note else ""
    panel(head, rows, limit, tone, right_note)


def fd_is_tty(fd: int) -> bool:
    try:
        return os.isatty(fd)
    except OSError:
        return False


def has_tty() -> bool:
    if sys.stdin.isatty():
        return True
    try:
        fd = os.open("/dev/tty", os.O_RDONLY | getattr(os, "O_NOCTTY", 0))
        os.close(fd)
        return True
    except OSError:
        return False


_SHARED_TTY_FD: int | None = None


def open_tty_fd() -> tuple[int | None, bool]:
    global _SHARED_TTY_FD
    if _SHARED_TTY_FD is not None:
        try:
            if os.isatty(_SHARED_TTY_FD):
                return _SHARED_TTY_FD, False
        except OSError:
            _SHARED_TTY_FD = None
    try:
        fd = os.open("/dev/tty", os.O_RDONLY | getattr(os, "O_NOCTTY", 0))
        if os.isatty(fd):
            _SHARED_TTY_FD = fd
            return fd, False
        os.close(fd)
    except OSError:
        pass
    try:
        if sys.stdin.isatty():
            return sys.stdin.fileno(), False
    except Exception:
        pass
    return None, False


def tty_stream():
    if sys.stdin.isatty():
        return sys.stdin
    try:
        return open("/dev/tty", "rb", buffering=0)
    except OSError:
        return None


class CbreakSession:
    def __init__(self, fd: int, cursor_visible: bool = False) -> None:
        self.fd = fd
        self.cursor_visible = cursor_visible
        self.old: list | None = None

    def __enter__(self) -> "CbreakSession":
        if not fd_is_tty(self.fd):
            return self
        try:
            import termios

            self.old = termios.tcgetattr(self.fd)
            _SAVED_ATTRS.append((self.fd, self.old))
            attrs = termios.tcgetattr(self.fd)
            attrs[0] = attrs[0] & ~(termios.IXON | termios.IXOFF)
            attrs[0] = attrs[0] | termios.ICRNL
            attrs[3] = attrs[3] & ~(termios.ICANON | termios.ECHO | termios.IEXTEN)
            attrs[3] = attrs[3] | termios.ISIG
            attrs[6][termios.VMIN] = 1
            attrs[6][termios.VTIME] = 0
            termios.tcsetattr(self.fd, termios.TCSANOW, attrs)
        except Exception:
            self.old = None
        if self.cursor_visible:
            show_cursor()
        else:
            hide_cursor()
        return self

    def __exit__(self, *args) -> None:
        if self.old is not None:
            try:
                import termios

                termios.tcsetattr(self.fd, termios.TCSADRAIN, self.old)
            except Exception:
                pass
            if _SAVED_ATTRS and _SAVED_ATTRS[-1][0] == self.fd:
                _SAVED_ATTRS.pop()
            self.old = None
        show_cursor()


class KeyReader:
    def __init__(self, fd: int, read_fn=None, wait_fn=None) -> None:
        self.fd = fd
        self.buf = bytearray()
        self._custom_io = read_fn is not None or wait_fn is not None
        self._read = read_fn or (lambda n: os.read(self.fd, n))
        self._wait = wait_fn or self._default_wait

    def _default_wait(self, timeout: float) -> bool:
        try:
            ready, _, _ = select.select([self.fd], [], [], max(0.0, timeout))
            return bool(ready)
        except Exception:
            return False

    def _fill(self, timeout: float | None = None) -> bool:
        if timeout is None and not self._custom_io:
            while True:
                if _RESIZED:
                    return False
                if self._wait(0.25):
                    break
        elif timeout is not None and not self._wait(timeout):
            return False
        try:
            chunk = self._read(64)
        except InterruptedError:
            return False
        except OSError:
            return False
        if not chunk:
            return False
        self.buf.extend(chunk)
        return True

    def has_buffered(self) -> bool:
        if self.buf:
            return True
        return self._fill(0.0)

    def _parse_csi(self) -> str:
        idx = 2
        while True:
            while idx < len(self.buf):
                byte = self.buf[idx]
                if 0x40 <= byte <= 7 * 16 + 14:
                    seq = bytes(self.buf[2 : idx + 1])
                    del self.buf[: idx + 1]
                    return self._map_csi(seq)
                if byte < 0x20 or byte > 0x3F:
                    del self.buf[:idx]
                    return "noop"
                idx += 1
            if len(self.buf) > 20 or not self._fill(SEQ_TIMEOUT):
                del self.buf[: min(len(self.buf), max(2, idx))]
                return "noop"

    def _map_csi(self, seq: bytes) -> str:
        if not seq:
            return "noop"
        final = chr(seq[-1])
        params = seq[:-1].decode("ascii", errors="ignore")
        if final == "A":
            return "up"
        if final == "B":
            return "down"
        if final == "C":
            return "right"
        if final == "D":
            return "left"
        if final == "H":
            return "home"
        if final == "F":
            return "end"
        if final == "Z":
            return "shift_tab"
        if final == "~":
            first_num = params.split(";", 1)[0]
            if first_num in ("1", "7"):
                return "home"
            if first_num in ("4", "8"):
                return "end"
            if first_num == "3":
                return "delete"
            if first_num == "5":
                return "pgup"
            if first_num == "6":
                return "pgdn"
        return "noop"

    def _parse_ss3(self) -> str:
        if len(self.buf) < 3 and not self._fill(SEQ_TIMEOUT):
            del self.buf[:2]
            return "noop"
        if len(self.buf) < 3:
            del self.buf[:]
            return "noop"
        final = chr(self.buf[2])
        del self.buf[:3]
        mapping = {"A": "up", "B": "down", "C": "right", "D": "left", "H": "home", "F": "end", "M": "enter"}
        return mapping.get(final, "noop")

    def _parse_utf8(self, first: int) -> str:
        needed = 1
        if (first & 0xE0) == 0xC0:
            needed = 2
        elif (first & 0xF0) == 0xE0:
            needed = 3
        elif (first & 0xF8) == 0xF0:
            needed = 4
        while len(self.buf) < needed:
            if not self._fill(0.05):
                break
        take = min(len(self.buf), needed)
        raw = bytes(self.buf[:take])
        del self.buf[:take]
        return raw.decode("utf-8", errors="ignore") or "noop"

    def read(self) -> str:
        global _RESIZED
        if not self.buf:
            if _RESIZED:
                _RESIZED = False
                return "resize"
            if not self._fill(None):
                if _RESIZED:
                    _RESIZED = False
                    return "resize"
                return "eof"
        first = self.buf[0]
        if first == 0x03:
            del self.buf[:1]
            raise KeyboardInterrupt
        if first == 0x04:
            del self.buf[:1]
            return "eof"
        if first in (0x0D, 0x0A):
            del self.buf[:1]
            if first == 0x0D:
                if self.buf and self.buf[0] == 0x0A:
                    del self.buf[:1]
                elif not self.buf and self._fill(CRLF_TIMEOUT) and self.buf and self.buf[0] == 0x0A:
                    del self.buf[:1]
            return "enter"
        if first == 0x20:
            del self.buf[:1]
            return "space"
        if first == 0x09:
            del self.buf[:1]
            return "tab"
        if first in (0x7F, 0x08):
            del self.buf[:1]
            return "backspace"
        if first == 0x15:
            del self.buf[:1]
            return "ctrl_u"
        if first == 0x17:
            del self.buf[:1]
            return "ctrl_w"
        if first == 0x1B:
            if len(self.buf) == 1:
                self._fill(ESC_TIMEOUT)
            if len(self.buf) == 1:
                del self.buf[:1]
                return "esc"
            if self.buf[1] == 0x1B:
                if len(self.buf) == 2:
                    self._fill(ESC_TIMEOUT)
                if len(self.buf) > 2 and self.buf[2] in (0x5B, 0x4F):
                    del self.buf[:1]
                else:
                    del self.buf[:2]
                    return "esc"
            nxt = self.buf[1]
            if nxt == 0x5B:
                return self._parse_csi()
            if nxt == 0x4F:
                return self._parse_ss3()
            del self.buf[:2]
            return "esc"
        if first < 0x20:
            del self.buf[:1]
            return "noop"
        if first >= 0x80:
            return self._parse_utf8(first)
        del self.buf[:1]
        return chr(first)


def read_key(stream) -> str:
    fd = stream.fileno()
    with CbreakSession(fd, cursor_visible=False):
        return KeyReader(fd).read()


class LiveBox:
    def __init__(self) -> None:
        self.lines_drawn = 0

    def render(self, lines: list[str]) -> None:
        buf: list[str] = []
        if self.lines_drawn > 0:
            if self.lines_drawn > 1:
                buf.append("\r\033[%dA" % (self.lines_drawn - 1))
            else:
                buf.append("\r")
            buf.append("\033[J")
        for idx, line in enumerate(lines):
            if idx > 0:
                buf.append("\n")
            buf.append("\r\033[2K" + line)
        flush("".join(buf))
        self.lines_drawn = len(lines)

    def finalize(self, lines: list[str] | None = None) -> None:
        if lines is not None:
            self.render(lines)
        write("")
        self.lines_drawn = 0


class Spinner:
    def __init__(self, message: str) -> None:
        self.message = message
        self.stop = threading.Event()
        self.thread: threading.Thread | None = None
        self.result: tuple[str, str] = (INFO, "")
        self.frames = [
            glyph("280b"),
            glyph("2819"),
            glyph("2839"),
            glyph("2838"),
            glyph("283c"),
            glyph("2834"),
            glyph("2826"),
            glyph("2827"),
        ]
        self.plain = not COLOR or not has_tty()

    def __enter__(self) -> "Spinner":
        if self.plain:
            return self
        hide_cursor()
        self.thread = threading.Thread(target=self.run, daemon=True)
        self.thread.start()
        return self

    def run(self) -> None:
        index = 0
        while not self.stop.is_set():
            frame = self.frames[index % len(self.frames)]
            flush("\r  " + paint(frame, theme.accent, theme.bold) + " " + paint(self.message, theme.text) + "   ")
            index += 1
            time.sleep(0.08)

    def close(self, kind: str, note: str = "", quiet: bool = False) -> None:
        self.result = (kind, note)
        if self.thread is not None:
            self.stop.set()
            self.thread.join(timeout=0.4)
            self.thread = None
            flush("\r\033[2K")
        show_cursor()
        if quiet:
            return
        write("  " + mark(kind) + " " + pad(paint(self.message, theme.text), 26) + " " + paint(note, theme.muted))

    def __exit__(self, *args) -> None:
        if self.thread is not None:
            self.close(OK)


def next_interactive_key(reader: KeyReader | None, stream) -> str:
    if reader is not None:
        return reader.read()
    return read_key(stream)


class RadioOption:
    def __init__(self, key: str, label: str, description: str = "", tag: str = "") -> None:
        self.key = key
        self.label = label
        self.description = description
        self.tag = tag


class Menu:
    def __init__(self, title: str, options: list[str] | list[RadioOption], hint: str = "", subtitle: str = "", step_note: str = "") -> None:
        self.title = title
        self.items: list[RadioOption] = [
            opt if isinstance(opt, RadioOption) else RadioOption(str(i), str(opt))
            for i, opt in enumerate(options)
        ]
        self.options = [item.label for item in self.items]
        self.index = 0
        self.selected = 0
        self.subtitle = subtitle
        self.step_note = step_note
        self.hint = hint or "arrows to move, space to select, enter to confirm"

    def fallback(self, default: int = 0) -> int:
        rows = []
        if self.subtitle:
            rows.append(paint(self.subtitle, theme.muted))
        rows.append(paint(self.hint, theme.muted))
        rows.append("")
        for number, item in enumerate(self.items):
            prefix = "*" if number == default else " "
            rows.append(paint("%s %d. %s" % (prefix, number + 1, item.label), theme.text))
        panel(self.title, rows)
        fd, _owned = open_tty_fd()
        if fd is None:
            return default
        flush("  " + paint(g.arrow, theme.accent) + " ")
        buf = bytearray()
        while True:
            try:
                ch = os.read(fd, 1)
            except OSError:
                break
            if not ch or ch in (b"\n", b"\r"):
                write("")
                break
            buf.extend(ch)
        raw = buf.decode("utf-8", errors="ignore").strip()
        if not raw:
            return default
        if raw.isdigit() and 1 <= int(raw) <= len(self.items):
            return int(raw) - 1
        return default

    def _draw_lines(self) -> list[str]:
        limit = width()
        tone = theme.frame_active
        lines = [frame_top(self.title, limit, tone, self.step_note)]
        if self.subtitle:
            lines.append(frame_line("", limit, tone))
            for row in wrap(self.subtitle, limit - 6):
                lines.append(frame_line(" " + paint(row, theme.subtitle), limit, tone))
            lines.append(frame_line("", limit, tone))
            lines.append(frame_rule(limit, tone, dashed=True))
        lines.append(frame_line("", limit, tone))
        for number, item in enumerate(self.items):
            focused = number == self.index
            chosen = number == self.selected
            pointer = paint(g.arrow, theme.cursor) if focused else " "
            radio = paint(g.radio_on, theme.good, theme.bold) if chosen else paint(g.radio_off, theme.muted)
            label_style = (theme.bright,) if focused else ((theme.text,) if chosen else (theme.muted,))
            label = paint(item.label, *label_style)
            suffix = ""
            if item.tag:
                tag_style = theme.badge_bad if item.tag == "danger" else (theme.badge_ok if chosen else theme.chip)
                suffix += "  " + pill(item.tag, tag_style)
            if focused and not chosen:
                suffix += "  " + paint("[Space]", theme.accent)
            row_body = pointer + " " + radio + "  " + label + suffix
            lines.append(frame_line(row_body, limit, tone, bg=theme.row_focus if focused else ""))
        current = self.items[self.index] if self.items else None
        if current and current.description:
            lines.append(frame_line("", limit, tone))
            lines.append(frame_rule(limit, tone, dashed=True))
            desc_line = paint(g.rail, theme.accent) + " " + paint(current.description, theme.muted)
            lines.append(frame_line(desc_line, limit, tone))
        lines.append(frame_rule(limit, tone, dashed=False))
        if limit < 64:
            footer = keycap(g.up + g.down, "move") + " " + keycap("Space", "pick") + " " + keycap("Enter", "ok") + " " + keycap("Esc", "quit")
        else:
            footer = (
                keycap(g.up + g.down, "move")
                + "  "
                + keycap("Space", "select")
                + "  "
                + keycap("Enter", "confirm")
                + "  "
                + keycap("Esc", "cancel")
            )
        lines.append(frame_line(footer, limit, tone))
        lines.append(frame_bottom(limit, tone))
        return lines

    def _compact_summary(self, cancelled: bool) -> list[str]:
        limit = width()
        if cancelled:
            tone = theme.warn
            body = mark(WARN) + " " + paint("cancelled by user", theme.warn)
            return [frame_top(self.title, limit, tone, self.step_note), frame_line(body, limit, tone), frame_bottom(limit, tone)]
        chosen = self.items[self.selected]
        tone = theme.frame
        body = mark(OK) + " " + paint(chosen.label, theme.bright)
        if chosen.description:
            body += paint("  " + g.half + "  " + chosen.description, theme.muted)
        return [frame_top(self.title, limit, tone, self.step_note), frame_line(body, limit, tone), frame_bottom(limit, tone)]

    def ask(self, default: int = 0) -> int:
        self.index = max(0, min(default, len(self.items) - 1))
        self.selected = self.index
        stream = tty_stream()
        if stream is None or not COLOR or not has_tty():
            return self.fallback(default)
        fd = stream.fileno()
        if not fd_is_tty(fd):
            return self.fallback(default)
        custom_read = read_key is not _DEFAULT_READ_KEY
        box = LiveBox()
        space_used = False
        with CbreakSession(fd, cursor_visible=False):
            reader = None if custom_read else KeyReader(fd)
            write("")
            box.render(self._draw_lines())
            while True:
                key = next_interactive_key(reader, stream)
                while True:
                    if key in ("up", "k"):
                        self.index = (self.index - 1) % len(self.items)
                    elif key in ("down", "j", "tab"):
                        self.index = (self.index + 1) % len(self.items)
                    elif key == "shift_tab":
                        self.index = (self.index - 1) % len(self.items)
                    elif key in ("home", "pgup"):
                        self.index = 0
                    elif key in ("end", "pgdn"):
                        self.index = len(self.items) - 1
                    elif key == "space":
                        self.selected = self.index
                        space_used = True
                    elif key == "enter":
                        if not space_used:
                            self.selected = self.index
                        box.finalize(self._compact_summary(False))
                        return self.selected
                    elif key in ("q", "esc", "eof"):
                        box.finalize(self._compact_summary(True))
                        return -1
                    elif key.isdigit() and 1 <= int(key) <= len(self.items):
                        self.index = int(key) - 1
                        self.selected = self.index
                        space_used = True
                    if reader is not None and reader.buf:
                        peek = reader.buf[0]
                        if peek == 0x1B or peek in (ord("j"), ord("k")):
                            key = reader.read()
                            continue
                    break
                box.render(self._draw_lines())


class CheckOption:
    def __init__(self, key: str, label: str, description: str, checked: bool = False, badge_text: str = "") -> None:
        self.key = key
        self.label = label
        self.description = description
        self.checked = checked
        self.badge_text = badge_text


class CheckMenu:
    def __init__(self, title: str, options: list[CheckOption], subtitle: str = "", step_note: str = "") -> None:
        self.title = title
        self.items = list(options)
        self.index = 0
        self.subtitle = subtitle
        self.step_note = step_note

    def _draw_lines(self) -> list[str]:
        limit = width()
        tone = theme.frame_active
        lines = [frame_top(self.title, limit, tone, self.step_note)]
        if self.subtitle:
            lines.append(frame_line("", limit, tone))
            for row in wrap(self.subtitle, limit - 6):
                lines.append(frame_line(" " + paint(row, theme.subtitle), limit, tone))
            lines.append(frame_line("", limit, tone))
            lines.append(frame_rule(limit, tone, dashed=True))
        lines.append(frame_line("", limit, tone))
        for idx, item in enumerate(self.items):
            focused = idx == self.index
            pointer = paint(g.arrow, theme.cursor) if focused else " "
            if item.checked:
                box = paint("[" + g.check + "]", theme.good, theme.bold)
            else:
                box = paint("[ ]", theme.muted)
            label = paint(item.label, theme.bright if focused else (theme.text if item.checked else theme.muted))
            tail = "  " + pill(item.badge_text, theme.badge_info if item.checked else theme.chip) if item.badge_text else ""
            lines.append(frame_line(pointer + " " + box + "  " + label + tail, limit, tone, bg=theme.row_focus if focused else ""))
        if self.items:
            cur = self.items[self.index]
            lines.append(frame_line("", limit, tone))
            lines.append(frame_rule(limit, tone, dashed=True))
            lines.append(frame_line(paint(g.rail, theme.accent) + " " + paint(cur.description, theme.muted), limit, tone))
        lines.append(frame_rule(limit, tone, dashed=False))
        if limit < 70:
            footer = keycap(g.up + g.down, "move") + " " + keycap("Space", "flip") + " " + keycap("Enter", "ok") + " " + keycap("Esc", "quit")
        else:
            footer = (
                keycap(g.up + g.down, "move")
                + "  "
                + keycap("Space", "toggle")
                + "  "
                + keycap("a", "all/none")
                + "  "
                + keycap("Enter", "confirm")
                + "  "
                + keycap("Esc", "cancel")
            )
        lines.append(frame_line(footer, limit, tone))
        lines.append(frame_bottom(limit, tone))
        return lines

    def _compact_summary(self, cancelled: bool) -> list[str]:
        limit = width()
        if cancelled:
            return [
                frame_top(self.title, limit, theme.warn, self.step_note),
                frame_line(mark(WARN) + " " + paint("cancelled", theme.warn), limit, theme.warn),
                frame_bottom(limit, theme.warn),
            ]
        picked = [item.label for item in self.items if item.checked]
        summary = ", ".join(picked) if picked else "standard defaults"
        return [
            frame_top(self.title, limit, theme.frame, self.step_note),
            frame_line(mark(OK) + " " + paint(summary, theme.text), limit, theme.frame),
            frame_bottom(limit, theme.frame),
        ]

    def ask(self) -> dict[str, bool] | None:
        stream = tty_stream()
        if stream is None or not COLOR or not has_tty() or not fd_is_tty(stream.fileno()):
            return {item.key: item.checked for item in self.items}
        fd = stream.fileno()
        custom_read = read_key is not _DEFAULT_READ_KEY
        box = LiveBox()
        with CbreakSession(fd, cursor_visible=False):
            reader = None if custom_read else KeyReader(fd)
            write("")
            box.render(self._draw_lines())
            while True:
                key = next_interactive_key(reader, stream)
                if key in ("up", "k"):
                    self.index = (self.index - 1) % len(self.items)
                elif key in ("down", "j", "tab"):
                    self.index = (self.index + 1) % len(self.items)
                elif key == "shift_tab":
                    self.index = (self.index - 1) % len(self.items)
                elif key in ("home", "pgup"):
                    self.index = 0
                elif key in ("end", "pgdn"):
                    self.index = len(self.items) - 1
                elif key == "space" and self.items:
                    self.items[self.index].checked = not self.items[self.index].checked
                elif key == "a" and self.items:
                    target = not all(it.checked for it in self.items)
                    for it in self.items:
                        it.checked = target
                elif key == "enter":
                    box.finalize(self._compact_summary(False))
                    return {item.key: item.checked for item in self.items}
                elif key in ("q", "esc", "eof"):
                    box.finalize(self._compact_summary(True))
                    return None
                box.render(self._draw_lines())


class Field:
    def __init__(self, name: str, label: str, secret: bool = False, default: str = "", hint: str = "", choices: list[str] | None = None) -> None:
        self.name = name
        self.label = label
        self.secret = secret
        self.value = default
        self.default = default
        self.hint = hint
        self.choices = list(choices or [])
        self.error = ""

    def shown(self) -> str:
        if not self.value:
            return paint("not set", theme.muted)
        return paint(mask_secret(self.name, self.value) if self.secret else self.value, theme.text)

    def check(self) -> str:
        if self.name == "BOT_TOKEN" and self.value and not TOKEN_RE.match(self.value):
            return "must look like 123456:ABC-DEF"
        if self.name == "OWNER_ID" and self.value and not (self.value.lstrip("-").isdigit()):
            return "must be a numeric Telegram user id"
        if self.name == "TAILSCALE_KEY" and self.value and not TSKEY_RE.match(self.value):
            return "must look like tskey-auth-... or tskey-client-..."
        if self.name == "QUOTA" and self.value and not (self.value.isdigit() and int(self.value) >= 0):
            return "must be a number of requests per day"
        if self.name in ("UPSTREAM_PORT", "PORT") and self.value:
            if not (self.value.isdigit() and 1 <= int(self.value) <= 65535):
                return "must be a port between 1 and 65535"
        if self.name in ("PREFIX", "STATE_DIR", "ENV_FILE") and not self.value.strip().startswith("/"):
            return "must be an absolute path starting with /"
        if self.name == "PYTHON" and not self.value.strip():
            return "cannot be empty"
        for char in "\n\r\x00=":
            if char in self.value:
                return "contains a forbidden character"
        return ""


class FieldEditor:
    def __init__(self, title: str, fields: list[Field], subtitle: str = "", step_note: str = "", validate_all: bool = True) -> None:
        self.title = title
        self.fields = list(fields)
        self.subtitle = subtitle
        self.step_note = step_note
        self.validate_all = validate_all
        self.index = 0
        self.editing = False
        self.draft = ""
        self.banner_error = ""

    def _edit_preview(self, field: Field) -> str:
        if not self.draft:
            return paint("_", theme.accent, theme.bold)
        if field.secret:
            visible = self.draft[:6] + ("*" * max(0, len(self.draft) - 6))
            return paint(visible, theme.accent) + paint("_", theme.bright)
        return paint(self.draft, theme.accent) + paint("_", theme.bright)

    def _draw_lines(self) -> list[str]:
        limit = width()
        tone = theme.bad if self.banner_error else theme.frame_active
        lines = [frame_top(self.title, limit, tone, self.step_note)]
        if self.subtitle:
            lines.append(frame_line("", limit, tone))
            for row in wrap(self.subtitle, limit - 6):
                lines.append(frame_line(" " + paint(row, theme.subtitle), limit, tone))
            lines.append(frame_line("", limit, tone))
            lines.append(frame_rule(limit, tone, dashed=True))
        lines.append(frame_line("", limit, tone))
        for idx, field in enumerate(self.fields):
            focused = idx == self.index
            pointer = paint(g.arrow, theme.cursor) if focused else " "
            err = field.check() if field.value else ""
            if self.editing and focused:
                status = paint(g.dot_on, theme.accent)
            elif field.value and not err:
                status = paint(g.check, theme.good, theme.bold)
            elif err or field.error:
                status = paint(g.cross, theme.bad, theme.bold)
            else:
                status = paint(g.ring, theme.muted)
            lbl = paint(pad(field.label, 13), theme.bright if focused else theme.key)
            if self.editing and focused:
                val = self._edit_preview(field)
            else:
                val = field.shown()
                if focused:
                    val += "  " + paint("[Space]" if limit < 62 else "[Space to edit]", theme.accent)
            lines.append(frame_line(pointer + " " + status + " " + lbl + " " + val, limit, tone, bg=theme.row_focus if focused else ""))
        cur = self.fields[self.index]
        lines.append(frame_line("", limit, tone))
        lines.append(frame_rule(limit, tone, dashed=True))
        if self.banner_error:
            lines.append(frame_line(mark(BAD) + " " + paint(self.banner_error, theme.bad), limit, tone))
        elif self.editing:
            edit_hint = "Type or paste value, Enter to save, Esc to revert"
            if cur.choices:
                edit_hint = "Type path, Tab to cycle interpreters, Enter to save"
            lines.append(frame_line(paint(g.rail, theme.accent) + " " + paint(edit_hint, theme.accent), limit, tone))
        elif cur.hint:
            lines.append(frame_line(paint(g.rail, theme.accent) + " " + paint(cur.hint, theme.muted), limit, tone))
        lines.append(frame_rule(limit, tone, dashed=False))
        if self.editing:
            if limit < 64:
                footer = keycap("Enter", "save") + " " + keycap("Ctrl+U", "clear") + " " + keycap("Esc", "back")
            else:
                footer = keycap("Enter", "save field") + "  " + keycap("Ctrl+U", "clear") + "  " + keycap("Esc", "discard")
                if cur.choices:
                    footer = keycap("Tab", "cycle") + "  " + footer
        elif limit < 66:
            footer = keycap(g.up + g.down, "move") + " " + keycap("Space", "edit") + " " + keycap("Enter", "ok") + " " + keycap("Esc", "quit")
        else:
            footer = (
                keycap(g.up + g.down, "move")
                + "  "
                + keycap("Space", "edit")
                + "  "
                + keycap("Enter", "confirm all")
                + "  "
                + keycap("Esc", "cancel")
            )
        lines.append(frame_line(footer, limit, tone))
        lines.append(frame_bottom(limit, tone))
        return lines

    def _compact_summary(self, cancelled: bool) -> list[str]:
        limit = width()
        if cancelled:
            return [
                frame_top(self.title, limit, theme.warn, self.step_note),
                frame_line(mark(WARN) + " " + paint("cancelled", theme.warn), limit, theme.warn),
                frame_bottom(limit, theme.warn),
            ]
        rows = [frame_top(self.title, limit, theme.frame, self.step_note)]
        for field in self.fields:
            rows.append(frame_line(mark(OK) + " " + fact(field.label, ANSI_RE.sub("", field.shown())), limit, theme.frame))
        rows.append(frame_bottom(limit, theme.frame))
        return rows

    def ask(self) -> bool:
        stream = tty_stream()
        if stream is None or not has_tty() or not fd_is_tty(stream.fileno()):
            if not self.validate_all:
                return True
            for field in self.fields:
                field.error = field.check()
                if field.error:
                    return False
            return True
        fd = stream.fileno()
        custom_read = read_key is not _DEFAULT_READ_KEY
        box = LiveBox()
        with CbreakSession(fd, cursor_visible=False):
            reader = None if custom_read else KeyReader(fd)
            write("")
            box.render(self._draw_lines())
            while True:
                key = next_interactive_key(reader, stream)
                cur = self.fields[self.index]
                if self.editing:
                    if key == "enter":
                        if self.draft.strip():
                            cur.value = self.draft.strip()
                        cur.error = cur.check() if self.validate_all else ""
                        self.banner_error = ("%s: %s" % (cur.label, cur.error)) if cur.error else ""
                        self.editing = False
                        hide_cursor()
                    elif key in ("esc", "eof"):
                        self.editing = False
                        self.banner_error = ""
                        hide_cursor()
                    elif key == "backspace":
                        self.draft = self.draft[:-1]
                    elif key == "ctrl_u":
                        self.draft = ""
                    elif key == "ctrl_w":
                        self.draft = self.draft.rstrip()
                        pos = self.draft.rfind(" ")
                        self.draft = self.draft[: pos + 1] if pos >= 0 else ""
                    elif key == "tab" and cur.choices:
                        if self.draft in cur.choices:
                            nxt = (cur.choices.index(self.draft) + 1) % len(cur.choices)
                            self.draft = cur.choices[nxt]
                        else:
                            self.draft = cur.choices[0]
                    elif key == "space":
                        self.draft += " "
                    elif len(key) == 1 and key.isprintable():
                        self.draft += key
                        while reader is not None and reader.buf:
                            nxt_byte = reader.buf[0]
                            if 0x20 <= nxt_byte <= 0x7E:
                                ch = reader.read()
                                if ch == "space":
                                    self.draft += " "
                                elif len(ch) == 1 and ch.isprintable():
                                    self.draft += ch
                                continue
                            break
                    box.render(self._draw_lines())
                    continue
                if key in ("up", "k"):
                    self.index = (self.index - 1) % len(self.fields)
                    self.banner_error = ""
                elif key in ("down", "j", "tab"):
                    self.index = (self.index + 1) % len(self.fields)
                    self.banner_error = ""
                elif key == "shift_tab":
                    self.index = (self.index - 1) % len(self.fields)
                    self.banner_error = ""
                elif key in ("home", "pgup"):
                    self.index = 0
                elif key in ("end", "pgdn"):
                    self.index = len(self.fields) - 1
                elif key == "space":
                    self.editing = True
                    self.draft = "" if cur.secret else cur.value
                    self.banner_error = ""
                    show_cursor()
                elif key == "enter":
                    bad_idx = -1
                    for i, field in enumerate(self.fields):
                        field.error = field.check() if self.validate_all else ""
                        if field.error and bad_idx < 0:
                            bad_idx = i
                    if bad_idx >= 0:
                        self.index = bad_idx
                        target = self.fields[bad_idx]
                        if not target.value:
                            self.editing = True
                            self.draft = ""
                            self.banner_error = "%s is required, type it and press Enter" % target.label
                            show_cursor()
                        else:
                            self.banner_error = "%s: %s" % (target.label, target.error)
                        box.render(self._draw_lines())
                        continue
                    box.finalize(self._compact_summary(False))
                    return True
                elif key in ("q", "esc", "eof"):
                    box.finalize(self._compact_summary(True))
                    return False
                box.render(self._draw_lines())


_DEFAULT_READ_KEY = read_key


def detect_pythons() -> list[str]:
    found: list[str] = []
    env_py = os.environ.get("OBHOD_PYTHON", "").strip()
    for name in (env_py, "python3.14", "python3.13", "python3", sys.executable):
        if not name:
            continue
        resolved = shutil.which(name) or (name if os.path.isfile(name) else "")
        if resolved and resolved not in found:
            found.append(resolved)
    return found or ["python3"]




# ---------------------------------------------------------------------- the stack, as it is on this machine
def env_read(path: Path | None = None) -> dict[str, str]:
    data: dict[str, str] = {}
    target = path or Path(os.environ.get("MSE_ENV_FILE", DEFAULT_ENV))
    try:
        text = target.read_text(encoding="utf-8", errors="replace")
    except OSError:
        text = ""
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        data[key.strip()] = value.strip().strip('"').strip("'")
    return data


def env_write(path: Path, updates: dict[str, str]) -> None:
    managed = set(updates)
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
    body = [key + "=" + value for key, value in updates.items()] + keep
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".env.tmp")
    handle = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(handle, "w", encoding="utf-8") as stream:
        stream.write("\n".join(body) + "\n")
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def http_json(url: str, timeout: float = 3.0) -> dict:
    import urllib.request

    with urllib.request.urlopen(url, timeout=timeout) as resp:
        return json.loads(resp.read(1 << 20).decode("utf-8", "replace") or "{}")


def systemd_state(unit: str) -> str:
    if not shutil.which("systemctl"):
        return "no systemd"
    try:
        out = subprocess.run(["systemctl", "is-active", unit], capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.SubprocessError):
        return "unknown"
    return (out.stdout or "").strip() or "inactive"


class Stack:
    """Everything the panel knows about the machine: where things are and what of it is alive."""

    def __init__(self, env: dict[str, str]) -> None:
        self.env = env
        self.prefix = Path(env.get("MSE_PREFIX", DEFAULT_PREFIX))
        self.env_file = Path(os.environ.get("MSE_ENV_FILE", DEFAULT_ENV))
        self.state_dir = Path(env.get("MSE_STATE_DIR", DEFAULT_STATE))
        self.port = env.get("MSE_PORT", "8788")
        self.upstream_port = env.get("MSE_UPSTREAM_PORT", "8799")
        self.upstream_host = env.get("MSE_UPSTREAM_HOST", "127.0.0.1")
        self.tunnel = env.get("MSE_TUNNEL_SCRIPT", "/usr/local/bin/mse-tunnel.sh")

    def installed(self) -> bool:
        return (self.prefix / "mse-router.js").is_file()

    def probe_router(self) -> tuple[str, str]:
        try:
            health = http_json(f"http://127.0.0.1:{self.port}/health")
        except Exception as exc:  # noqa: BLE001 — anything at all means "not answering"
            return "down", f"127.0.0.1:{self.port} · {type(exc).__name__}"
        return "up", "v%s · model %s · devices %s · in the allow list %s" % (
            health.get("version", "?"), health.get("model", "—"),
            health.get("devices", 0), health.get("allow", 0),
        )

    def probe_backend(self) -> tuple[str, str]:
        try:
            body = http_json(f"http://{self.upstream_host}:{self.upstream_port}/v1/models")
        except Exception as exc:  # noqa: BLE001
            return "down", "%s:%s · %s" % (self.upstream_host, self.upstream_port, type(exc).__name__)
        ids = [str(m.get("id")) for m in body.get("data") or [] if m.get("id")]
        return "up", "%s:%s · models %d" % (self.upstream_host, self.upstream_port, len(ids))

    def probe_tunnel(self) -> tuple[str, str]:
        if not Path(self.tunnel).exists() and not shutil.which(self.tunnel):
            return "off", "mse-tunnel.sh is not installed"
        try:
            out = subprocess.run([self.tunnel, "status", "--json"], capture_output=True, text=True, timeout=20)
            info = json.loads(out.stdout or "{}")
        except (OSError, subprocess.SubprocessError, ValueError) as exc:
            return "down", "mse-tunnel.sh: %s" % type(exc).__name__
        if not info.get("installed"):
            return "off", "tailscale is not installed"
        if not info.get("running"):
            return "warn", "tailscale is not up"
        url = info.get("url") or "no address yet"
        return "up", "%s · %s" % (info.get("mode") or "—", url)

    def probe_bot(self) -> tuple[str, str]:
        token = self.env.get("MSE_BOT_TOKEN", "")
        if not token:
            return "off", "MSE_BOT_TOKEN is empty"
        state = systemd_state("mse-bot")
        return ("up" if state == "active" else "warn"), "mse-bot.service · " + state

    def probe_all(self) -> list[tuple[str, str, str]]:
        return [
            ("router", *self.probe_router()),
            ("backend", *self.probe_backend()),
            ("tunnel", *self.probe_tunnel()),
            ("bot", *self.probe_bot()),
        ]


class Setup:
    """The screens. The order and the look are those of `sudo obhod`; the content is about MSE."""

    def __init__(self, argv: list[str] | None = None, env: dict[str, str] | None = None) -> None:
        self.argv = list(argv or [])
        loaded = env_read()
        for key, value in os.environ.items():
            if key.startswith("MSE_") and key not in loaded:
                loaded[key] = value
        self.env = loaded if env is None else env
        self.stack = Stack(self.env)
        self.action = "menu"
        self.service_cmd = "restart"
        self.quick = True
        self.dry_run = False
        self.dev = False
        self.prefix = str(self.stack.prefix)
        self.state_dir = str(self.stack.state_dir)
        self.env_file = str(self.stack.env_file)
        self.python = (detect_pythons() or ["python3"])[0]
        self.python_choices = detect_pythons()
        self.credentials = {"BOT_TOKEN": "", "OWNER_ID": "", "API_ID": "", "API_HASH": "", "TAILSCALE_KEY": ""}
        self.settings = {"MODEL": self.env.get("MSE_MODEL", "gemini-3-flash"), "QUOTA": self.env.get("MSE_DAILY_QUOTA", "200"),
                         "UPSTREAM_PORT": self.env.get("MSE_UPSTREAM_PORT", "8799")}
        self.notes: list[str] = []
        self.started = time.time()
        self.limit = width()

    # ------------------------------------------------------------------ small helpers
    def host_label(self) -> str:
        user = "root" if os.geteuid() == 0 else (os.environ.get("USER") or "user")
        try:
            host = socket.gethostname().split(".")[0] or "server"
        except Exception:  # noqa: BLE001
            host = "server"
        return paint(user + "@" + host, theme.muted)

    def pill_for(self, kind: str) -> str:
        return {"up": pill("up", theme.badge_ok), "warn": pill("warn", theme.badge_warn),
                "down": pill("down", theme.badge_bad), "off": pill("off", theme.chip)}.get(kind, pill(kind, theme.chip))

    def badges(self) -> str:
        parts = []
        for name, kind, _note in self.stack.probe_all():
            parts.append(pill("%s: %s" % (name, kind), {"up": theme.badge_ok, "warn": theme.badge_warn,
                                                        "down": theme.badge_bad}.get(kind, theme.chip)))
        return "  ".join(parts)

    def banner(self) -> None:
        self.limit = width()
        head = paint(g.dot_on, theme.accent) + " " + paint("MSE", theme.title) + paint(" " + g.half + " Control Center", theme.subtitle)
        rows = [
            paint("Moodle answer panel " + g.half + " router, AI backend, tailscale tunnel, telegram bot", theme.bright),
            self.badges(),
            paint("Command: mse  " + g.half + "  arrows to move, space to select, enter to confirm", theme.muted),
        ]
        panel(head, rows, self.limit, theme.frame, self.host_label())

    def summary_bar(self) -> None:
        self.limit = width()
        flags = [pill("DRY RUN", theme.badge_info)] if self.dry_run else [pill("SYSTEM", theme.badge_ok)]
        rows = [
            fact("mode", " ".join(flags)),
            fact("target", self.prefix),
            fact("config", self.env_file),
            fact("state", self.state_dir),
            fact("python", self.python),
        ]
        panel("target server", rows, self.limit, theme.frame)

    def step_bar(self, current: int, total: int, label: str) -> str:
        dots = []
        for idx in range(1, total + 1):
            if idx < current:
                dots.append(paint(g.fill, theme.good))
            elif idx == current:
                dots.append(paint(g.radio_on, theme.accent, theme.bold))
            else:
                dots.append(paint(g.ring, theme.subtle))
        return paint(g.h, theme.subtle).join(dots) + "  " + paint("step %d/%d" % (current, total), theme.muted) + paint(" " + g.half + " " + label, theme.accent)

    def progress(self, done: int, total: int, label: str) -> str:
        total = max(1, total)
        done = max(0, min(done, total))
        cells = 22
        filled = int(round(cells * done / total))
        bar = paint(g.bar_on * filled, theme.accent) + paint(g.bar_off * (cells - filled), theme.subtle)
        return "  " + bar + " " + paint("%3d%%" % int(100 * done / total), theme.text) + " " + paint(label, theme.muted)

    # ------------------------------------------------------------------ step 1: the menu
    def ask_action(self) -> bool:
        installed = self.stack.installed()
        menu = Menu(
            paint("1", theme.accent, theme.bold) + paint(" " + g.half + " ", theme.muted) + paint("Control Center", theme.title),
            [
                RadioOption("health", "Health & Status", "Router, AI backend, tailscale and bot: what is alive, what is not, where it lives", "read-only"),
                RadioOption("install", "Install / Self-Heal", "Install or repair the stack: code, settings, venv, systemd, tailscale", "self-heal" if installed else "recommended"),
                RadioOption("update", "Update & Repair", "Update the code and dependencies without touching devices, the allow list or the tokens", "fast"),
                RadioOption("service", "Service Control", "Restart, start, stop and the last lines of the journal", ""),
                RadioOption("tunnel", "Tunnel (tailscale)", "tailscale up, funnel, serve, turn off: the address and the mode", ""),
                RadioOption("settings", "Model, Quota & Keys", "Model, quota, bot token, owner id, tailscale key, ports", "config"),
                RadioOption("custom", "Custom / Advanced Setup", "Paths, python, dry run: the same, but asking at every step", ""),
                RadioOption("uninstall", "Uninstall MSE", "Remove the services and /opt/mse; state and tokens optional", "safe"),
                RadioOption("wipe", "Full Wipe (Delete Everything)", "Delete everything: code, settings, state, log, tunnel", "danger"),
            ],
            subtitle="Arrows to move, Space to select, Enter to run.",
            step_note=paint("main menu", theme.muted),
        )
        choice = menu.ask(0)
        if choice < 0:
            return False
        picked = menu.items[choice].key
        if picked == "custom":
            self.action = "install"
            self.quick = False
            return True
        self.action = picked
        self.quick = True
        return True

    # ------------------------------------------------------------------ status
    def show_health(self) -> None:
        self.limit = width()
        rows = []
        for name, kind, note in self.stack.probe_all():
            rows.append(self.pill_for(kind) + " " + paint(pad(name, 9), theme.key) + paint(note, theme.text))
        rows.append("")
        rows.append(fact("model", self.env.get("MSE_MODEL", "—")) + "   " + fact("quota", self.env.get("MSE_DAILY_QUOTA", "—") + "/day"))
        rows.append(fact("address", self.env.get("MSE_PUBLIC_URL") or "not yet (3 Tunnel)"))
        rows.append(fact("exposed via", "tailscale only: funnel → 127.0.0.1:" + self.stack.port))
        panel("stack health", rows, self.limit, theme.frame, pill("read-only", theme.badge_info))

    # ------------------------------------------------------------------ install / update
    def installer_argv(self) -> list[str]:
        script = Path(self.prefix) / "stack" / "install.sh"
        if not script.is_file():
            script = Path(__file__).resolve().parent / "install.sh"
        args = ["bash", str(script)]
        args.append("--yes" if self.action in ("install", "update") else "")
        args = [a for a in args if a]
        if self.action == "update":
            args.append("--update")
        if self.dry_run:
            args.append("--dry-run")
        return args

    def run_checks(self) -> bool:
        self.limit = width()
        checks = []
        ok_root = os.geteuid() == 0 or self.dev
        checks.append(("root", ok_root, "root (or dev mode)" if ok_root else "root is needed: sudo mse"))
        ok_node = shutil.which("node") is not None
        checks.append(("node 18+", ok_node, shutil.which("node") or "node is missing"))
        ok_py = shutil.which("python3") is not None
        checks.append(("python3", ok_py, shutil.which("python3") or "python3 is missing"))
        ok_disk = os.path.isdir(os.path.dirname(self.prefix) or "/")
        checks.append(("target", ok_disk, self.prefix))
        rows = [self.pill_for("up" if ok else "down") + " " + paint(pad(name, 10), theme.key) + paint(note, theme.text if ok else theme.warn)
                for name, ok, note in checks]
        panel("preflight", rows, self.limit, theme.good if all(c[1] for c in checks) else theme.warn,
              self.step_bar(2, 4, "checks"))
        failed = [name for name, ok, _ in checks if not ok]
        if failed:
            self.notes.append("preflight: " + ", ".join(failed))
            if failed == ["node 18+"]:
                return False
        return True

    def run_installer(self) -> int:
        self.limit = width()
        argv = self.installer_argv()
        if self.dry_run:
            section(3, "Preview Command", [fact("would run", " ".join(shlex.quote(part) for part in argv)),
                                           paint("dry run: nothing on disk is changed", theme.muted)], theme.accent, "dry run")
            return 0
        rows = []
        total = 4
        names = ["code into " + self.prefix, "settings and permissions", "venv and dependencies", "systemd and the tunnel"]
        with Spinner("installing") as spin:
            proc = subprocess.run(argv, capture_output=True, text=True)
            ok = proc.returncode == 0
            spin.close(OK if ok else BAD, "install.sh")
        for idx, name in enumerate(names, 1):
            rows.append(self.progress(idx, total, name))
        if not ok:
            rows.append("")
            for line in ((proc.stderr or proc.stdout or "").splitlines())[-6:]:
                rows.append(paint(clip(line, self.limit - 6), theme.warn))
        panel("installation", rows, self.limit, theme.good if ok else theme.bad,
              self.step_bar(4, 4, "install" if ok else "stopped"))
        return proc.returncode

    # ------------------------------------------------------------------ services
    def ask_service(self) -> bool:
        sub = Menu(
            paint("2", theme.accent, theme.bold) + paint(" " + g.half + " ", theme.muted) + paint("Service Control", theme.title),
            [
                RadioOption("restart", "Restart mse-router", "systemctl restart mse-router.service"),
                RadioOption("start", "Start mse-router", "systemctl start mse-router.service"),
                RadioOption("stop", "Stop mse-router", "systemctl stop mse-router.service"),
                RadioOption("restart-bot", "Restart mse-bot", "systemctl restart mse-bot.service (needs a bot token)"),
                RadioOption("logs", "Show recent logs", "journalctl -u mse-router -n 40 and mse-bot"),
            ],
            subtitle="What to do with the service.",
            step_note=paint("service", theme.muted),
        )
        idx = sub.ask(0)
        if idx < 0:
            return False
        self.service_cmd = sub.items[idx].key
        return True

    def do_service(self) -> None:
        self.limit = width()
        cmd = self.service_cmd
        rows = []
        if cmd == "logs":
            for unit in ("mse-router", "mse-bot"):
                rows.append(paint(unit + ".service", theme.key))
                try:
                    out = subprocess.run(["journalctl", "-u", unit, "-n", "8", "--no-pager", "-q"], capture_output=True, text=True, timeout=10)
                    lines = [l for l in (out.stdout or "").splitlines() if l.strip()][-8:]
                except (OSError, subprocess.SubprocessError) as exc:
                    lines = [str(exc)]
                rows.extend(paint(clip(line, self.limit - 6), theme.muted) for line in (lines or ["empty"]))
                rows.append("")
        else:
            unit = "mse-bot" if cmd.endswith("-bot") else "mse-router"
            verb = cmd.replace("-bot", "")
            try:
                subprocess.run(["systemctl", verb, unit], capture_output=True, text=True, timeout=60)
                state = systemd_state(unit)
                ok = state == "active" or verb == "stop"
            except (OSError, subprocess.SubprocessError) as exc:
                state, ok = str(exc), False
            rows.append(self.pill_for("up" if ok else "down") + " " + paint("%s %s" % (unit, verb), theme.text) + "  " + paint(state, theme.muted))
        panel("service", rows, self.limit, theme.frame)

    # ------------------------------------------------------------------ tunnel
    def tunnel_screen(self) -> None:
        self.limit = width()
        kind, note = self.stack.probe_tunnel()
        rows = [self.pill_for(kind) + " " + paint(note, theme.text), ""]
        rows.append(fact("address", self.env.get("MSE_PUBLIC_URL") or "—"))
        rows.append(fact("port", self.stack.port))
        panel("tunnel", rows, self.limit, theme.frame, pill("tailscale", theme.badge_info))

    def ask_tunnel(self) -> bool:
        sub = Menu(
            paint("3", theme.accent, theme.bold) + paint(" " + g.half + " ", theme.muted) + paint("Tunnel (tailscale)", theme.title),
            [
                RadioOption("up", "tailscale up", "Bring the node into the tailnet with the key from the settings"),
                RadioOption("funnel", "tailscale funnel", "A public https address <host>.<tailnet>.ts.net → the local port"),
                RadioOption("serve", "tailscale serve", "The same https, but inside the tailnet only"),
                RadioOption("off", "Turn off", "Turn funnel/serve off, keep the node in the tailnet"),
                RadioOption("status", "Status", "Show the mode, the address and the ip"),
            ],
            subtitle="What to do with the tunnel.",
            step_note=paint("tunnel", theme.muted),
        )
        idx = sub.ask(0)
        if idx < 0:
            return False
        cmd = sub.items[idx].key
        if cmd == "status":
            self.tunnel_screen()
            return False
        script = self.stack.tunnel
        args = [script, "off"] if cmd == "off" else [script, cmd] + ([] if cmd == "up" else [self.stack.port])
        self.limit = width()
        with Spinner("tailscale " + cmd) as spin:
            try:
                out = subprocess.run(args, capture_output=True, text=True, timeout=180)
                ok = out.returncode == 0
                text = (out.stdout or "").strip() or (out.stderr or "").strip()
            except (OSError, subprocess.SubprocessError) as exc:
                ok, text = False, str(exc)
            spin.close(OK if ok else BAD, cmd)
        rows = [paint(clip(line, self.limit - 6), theme.text if ok else theme.warn) for line in (text.splitlines() or ["—"])[-6:]]
        if ok and text.startswith("https://"):
            env_write(self.stack.env_file, {"MSE_PUBLIC_URL": text.strip().splitlines()[0]})
            rows.append("")
            rows.append(paint("address saved into " + str(self.stack.env_file), theme.muted))
            subprocess.run(["systemctl", "restart", "mse-router"], capture_output=True, text=True, timeout=60)
        panel("tunnel · " + cmd, rows, self.limit, theme.good if ok else theme.bad)
        return False

    # ------------------------------------------------------------------ settings
    def ask_settings(self) -> bool:
        fields = [
            Field("MODEL", "model", False, self.settings["MODEL"], "The model name on the local backend (OpenAI-compatible)"),
            Field("QUOTA", "quota", False, self.settings["QUOTA"], "Requests per day per device"),
            Field("UPSTREAM_PORT", "backend port", False, self.settings["UPSTREAM_PORT"], "127.0.0.1:<port> — where the AI backend lives"),
            Field("BOT_TOKEN", "bot token", True, self.contrib_or("BOT_TOKEN"), "From @BotFather; empty means the bot is off"),
            Field("OWNER_ID", "owner id", False, self.contrib_or("OWNER_ID"), "Your numeric Telegram id (the person the bot answers)"),
            Field("API_ID", "api id", False, self.contrib_or("API_ID"), "my.telegram.org → App api_id (optional, for the MTProto transport)"),
            Field("API_HASH", "api hash", True, self.contrib_or("API_HASH"), "my.telegram.org → App api_hash (optional, masked)"),
            Field("TAILSCALE_KEY", "tailscale key", True, self.contrib_or("TAILSCALE_KEY"), "tskey-auth-… (or empty and log in by link)"),
        ]
        editor = FieldEditor(
            paint("4", theme.accent, theme.bold) + paint(" " + g.half + " ", theme.muted) + paint("Model, Quota & Keys", theme.title),
            fields,
            subtitle="Up/down — the row, Space — edit, Enter — save everything. Secrets are masked and never land in the shell history.",
            step_note=paint("step 1", theme.muted),
        )
        if not editor.ask():
            return False
        self.settings["MODEL"] = fields[0].value.strip()
        self.settings["QUOTA"] = fields[1].value.strip()
        self.settings["UPSTREAM_PORT"] = fields[2].value.strip()
        self.credentials["BOT_TOKEN"] = fields[3].value.strip()
        self.credentials["OWNER_ID"] = fields[4].value.strip()
        self.credentials["API_ID"] = fields[5].value.strip()
        self.credentials["API_HASH"] = fields[6].value.strip()
        self.credentials["TAILSCALE_KEY"] = fields[7].value.strip()
        if self.dry_run:
            self.notes.append("dry run: the settings were not written")
            return True
        updates = {
            "MSE_MODEL": self.settings["MODEL"],
            "MSE_DAILY_QUOTA": self.settings["QUOTA"],
            "MSE_UPSTREAM_PORT": self.settings["UPSTREAM_PORT"],
            "MSE_BOT_TOKEN": self.credentials["BOT_TOKEN"],
            "MSE_OWNER_ID": self.credentials["OWNER_ID"],
            "MSE_API_ID": self.credentials["API_ID"],
            "MSE_API_HASH": self.credentials["API_HASH"],
            "MSE_TAILSCALE_KEY": self.credentials["TAILSCALE_KEY"],
        }
        try:
            env_write(self.stack.env_file, updates)
        except OSError as exc:
            self.notes.append("could not write %s: %s" % (self.stack.env_file, exc))
            return False
        self.env.update(updates)
        ok, text = self.push_settings()
        self.limit = width()
        rows = [self.pill_for("up" if ok else "warn") + " " + paint(text, theme.text if ok else theme.warn),
                fact("file", str(self.stack.env_file)),
                fact("model", self.settings["MODEL"]), fact("quota", self.settings["QUOTA"] + "/day")]
        panel("settings saved", rows, self.limit, theme.good if ok else theme.warn)
        return True

    def contrib_or(self, name: str) -> str:
        return self.credentials.get(name, "") or self.env.get("MSE_" + name, "")

    def push_settings(self) -> tuple[bool, str]:
        """Some settings live in the file, some in the running router: the quota goes to it right away."""
        token = self.env.get("MSE_ADMIN_TOKEN", "")
        if not token:
            return True, "file written; the router picks it up after a restart"
        import urllib.request

        body = json.dumps({"quota": int(self.settings["QUOTA"] or 0)}).encode()
        req = urllib.request.Request(f"http://127.0.0.1:{self.stack.port}/admin/quota", data=body, method="POST",
                                     headers={"content-type": "application/json", "x-admin-token": token})
        try:
            with urllib.request.urlopen(req, timeout=8):
                pass
        except Exception as exc:  # noqa: BLE001
            return False, "the router did not accept the quota (%s), it applies after a restart" % type(exc).__name__
        subprocess.run(["systemctl", "restart", "mse-bot"], capture_output=True, text=True, timeout=60)
        return True, "quota applied, the bot restarted"

    # ------------------------------------------------------------------ removal
    def ask_uninstall(self) -> bool:
        sub = Menu(
            paint("2", theme.accent, theme.bold) + paint(" " + g.half + " ", theme.muted) + paint("Uninstall MSE", theme.title),
            [
                RadioOption("keep", "Remove services & code (keep state & keys)", "Remove the units and /opt/mse; /etc/mse and /var/lib/mse stay", "safe"),
                RadioOption("purge", "Remove everything: code, config, state", "Plus /etc/mse (tokens) and /var/lib/mse (devices, log)"),
                RadioOption("cancel", "Cancel", "Change nothing"),
            ],
            subtitle="How deep the removal goes.",
            step_note=paint("uninstall", theme.muted),
        )
        idx = sub.ask(0)
        if idx < 0 or sub.items[idx].key == "cancel":
            return False
        self.purge_all = sub.items[idx].key == "purge"
        return True

    def confirm_wipe(self) -> bool:
        self.limit = width()
        targets = [
            mark(BAD) + " " + paint("services: mse-router.service, mse-bot.service", theme.text),
            mark(BAD) + " " + paint("code: %s, /usr/local/bin/mse, /usr/local/bin/mse-tunnel.sh" % self.prefix, theme.text),
            mark(BAD) + " " + paint("settings and state: %s, %s" % (self.env_file, self.state_dir), theme.text),
            mark(BAD) + " " + paint("tunnel: tailscale funnel/serve is turned off (the node stays in the tailnet)", theme.text),
        ]
        panel("full wipe targets", targets, self.limit, theme.bad, pill("DESTRUCTIVE", theme.badge_bad))
        if not has_tty():
            return False
        sub = Menu(
            paint("!", theme.bad, theme.bold) + paint(" " + g.half + " ", theme.muted) + paint("Confirm Full Wipe", theme.title),
            [
                RadioOption("cancel", "Cancel — keep everything", "Exit without deleting anything", "safe default"),
                RadioOption("wipe", "Yes — delete MSE completely", "Stop the services and delete everything listed above", "destructive"),
            ],
            subtitle="Down + Space + Enter to confirm.",
            step_note=paint("danger", theme.bad),
        )
        idx = sub.ask(0)
        return idx >= 0 and sub.items[idx].key == "wipe"

    def do_uninstall(self, wipe: bool) -> int:
        self.limit = width()
        rows = []
        for unit in ("mse-bot", "mse-router"):
            subprocess.run(["systemctl", "stop", unit], capture_output=True, text=True, timeout=60)
            subprocess.run(["systemctl", "disable", unit], capture_output=True, text=True, timeout=60)
            rows.append(paint(g.cross + " " + unit + ".service", theme.warn))
        if wipe and Path(self.stack.tunnel).exists():
            subprocess.run([self.stack.tunnel, "off"], capture_output=True, text=True, timeout=120)
            rows.append(paint(g.cross + " funnel/serve", theme.warn))
        for target in [Path(self.prefix)] + ([Path(self.env_file).parent, Path(self.state_dir)] if (wipe or getattr(self, "purge_all", False)) else []):
            try:
                shutil.rmtree(target, ignore_errors=True)
                rows.append(paint(g.cross + " " + str(target), theme.text))
            except OSError as exc:
                rows.append(paint(g.cross + " " + str(target) + " — " + str(exc), theme.bad))
        for unit_file in ("/etc/systemd/system/mse-router.service", "/etc/systemd/system/mse-bot.service", "/usr/local/bin/mse"):
            try:
                Path(unit_file).unlink()
            except OSError:
                pass
        subprocess.run(["systemctl", "daemon-reload"], capture_output=True, text=True, timeout=60)
        panel("removed", rows or [paint("there was nothing to remove", theme.muted)], self.limit, theme.warn)
        return 0

    # ------------------------------------------------------------------ run
    def run(self) -> int:
        if "--version" in self.argv:
            write(paint("MSE setup 2.0 · " + TITLE, theme.accent))
            return 0
        if not has_tty():
            self.show_health()
            return 0 if all(kind == "up" for _n, kind, _t in self.stack.probe_all()) else 1
        self.banner()
        if not self.ask_action():
            return 130
        action = self.action
        if action == "health":
            self.show_health()
            return 0
        if action == "service":
            if not self.ask_service():
                return 130
            self.do_service()
            return 0
        if action == "tunnel":
            self.ask_tunnel()
            return 0
        if action == "settings":
            self.ask_settings()
            return 0
        if action == "uninstall":
            if not self.ask_uninstall():
                return 130
            return self.do_uninstall(wipe=False)
        if action == "wipe":
            if not self.confirm_wipe():
                return 130
            return self.do_uninstall(wipe=True)
        # install / update / custom
        if not self.quick:
            fields = [
                Field("PREFIX", "app prefix", False, self.prefix, "Where the code goes (default /opt/mse)"),
                Field("ENV_FILE", "config file", False, self.env_file, "The settings file, mode 0600"),
                Field("STATE_DIR", "state dir", False, self.state_dir, "Devices, allow list, log"),
                Field("PYTHON", "python bin", False, self.python, "The interpreter for the bot venv", choices=self.python_choices),
            ]
            editor = FieldEditor(
                paint("2", theme.accent, theme.bold) + paint(" " + g.half + " ", theme.muted) + paint("Target Paths & Runtime", theme.title),
                fields,
                subtitle="Enter — accept, Space — edit the row.",
                step_note=paint("step 1", theme.muted),
            )
            if not editor.ask():
                return 130
            self.prefix, self.env_file, self.state_dir = fields[0].value, fields[1].value, fields[2].value
            self.python = fields[3].value
            opts = CheckMenu(
                paint("3", theme.accent, theme.bold) + paint(" " + g.half + " ", theme.muted) + paint("Setup Options", theme.title),
                [CheckOption("dry_run", "Preview only (dry run)", "Show the plan without changing anything", self.dry_run, "safe")],
                subtitle="Space — toggle, Enter — continue.",
                step_note=paint("step 2", theme.muted),
            )
            picked = opts.ask()
            if picked is None:
                return 130
            self.dry_run = bool(picked.get("dry_run"))
        if not self.run_checks():
            self.limit = width()
            panel("stopped", [mark(BAD) + " " + paint("missing: " + "; ".join(self.notes[-2:]), theme.bad)], self.limit, theme.bad)
            return 2
        code = self.run_installer()
        if code == 0 and not self.dry_run:
            self.limit = width()
            kind, note = self.stack.probe_router()
            rows = [
                paint(g.check + " MSE is installed", theme.good, theme.bold),
                self.pill_for(kind) + " " + paint("router: " + note, theme.text),
                "",
                paint("address and mode: 3 Tunnel · model and keys: 6 Model, Quota & Keys", theme.muted),
                paint("live journal: journalctl -u mse-router -f", theme.muted),
            ]
            panel("done in %.1fs" % (time.time() - self.started), rows, self.limit, theme.good)
        return code


def detect_pythons() -> list[str]:
    found = []
    for name in ("python3.13", "python3.12", "python3.11", "python3"):
        path = shutil.which(name)
        if path and path not in found:
            found.append(path)
    return found


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    allowed = {"--status", "--version", "--help", "-h"}
    if [a for a in args if a not in allowed]:
        write(paint("  unknown flag: " + " ".join(a for a in args if a not in allowed), theme.bad))
        write(paint("  usage: mse [--status] [--version]", theme.muted))
        return 2
    setup = Setup(args)
    if "--status" in args:
        setup.show_health()
        return 0 if all(kind == "up" for _n, kind, _t in setup.stack.probe_all()) else 1
    prev_winch = None
    try:
        if hasattr(signal, "SIGWINCH"):
            prev_winch = signal.getsignal(signal.SIGWINCH)
            signal.signal(signal.SIGWINCH, _on_winch)
        return setup.run()
    except KeyboardInterrupt:
        restore_terminal()
        write("")
        panel("cancelled", [paint("interrupted, the terminal state is restored", theme.warn)], width(), theme.warn)
        return 130
    except Exception as exc:  # noqa: BLE001
        restore_terminal()
        write("")
        write(paint("  setup failed: %s: %s" % (type(exc).__name__, exc), theme.bad))
        return 2
    finally:
        restore_terminal()
        if prev_winch is not None and hasattr(signal, "SIGWINCH"):
            try:
                signal.signal(signal.SIGWINCH, prev_winch)
            except Exception:  # noqa: BLE001
                pass


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
