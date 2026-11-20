"""The MSE screens: home, people (allow list), model, quota, tunnel, services, log, config, update, help.

Every screen is a Rich message with a row of real buttons, in the manner of `BOT/screens.py` from OBHOD: a heading,
a short table of facts, a divider, then big tappable rows. Nothing here talks to the network — screens only
describe a snapshot, so the tests can render them without a gateway.
"""
from __future__ import annotations

from typing import Any, Iterable

from goygram.rich import Rich

from .ui import (
    SEP, bold, bullet_list, button, chip, chip_html, code, copy_button, divider, esc, facts, heading, ico,
    input_row, link_button, muted, pre, quote, row, rows, screen, status_chip, table,
)

STATE_WORD = {"active": "active", "pending": "pending", "revoked": "revoked", "banned": "revoked"}


def device_state(device: dict[str, Any]) -> str:
    return STATE_WORD.get(str(device.get("status") or ""), str(device.get("status") or "unknown"))


def _health(snap: dict[str, Any]) -> dict[str, Any]:
    return snap.get("health") or {}


def _devices(snap: dict[str, Any]) -> list[dict[str, Any]]:
    return list(snap.get("devices") or [])


def _counts(devices: list[dict[str, Any]]) -> tuple[int, int]:
    active = len([d for d in devices if d.get("status") == "active"])
    pending = len([d for d in devices if d.get("status") == "pending"])
    return active, pending


# ------------------------------------------------------------------ home
def home(snap: dict[str, Any], notice: str = "") -> Rich:
    health = _health(snap)
    devices = _devices(snap)
    active, pending = _counts(devices)
    url = str(health.get("publicUrl") or "")

    blocks: list[str] = []
    if notice:
        blocks.append(f"<p>{status_chip(True, notice)}</p>")

    router_ok = bool(health) and not snap.get("error")
    blocks.append(
        facts(
            [
                ("address", code(url) if url else chip("not published")),
                ("model", code(health.get("model") or "—")),
                ("quota", code(str(health.get("quota") or "—")) + muted(" / day / device")),
                ("people", code(str(len(devices))) + muted(SEP) + code(str(active)) + muted(" active")),
                ("waiting", code(str(pending)) + muted(SEP) + (chip(ico("bell", "") + " " + str(pending)) if pending else muted("nobody"))),
            ],
            icon="server",
        )
    )

    if snap.get("error") and not health:
        blocks.append(quote(esc(snap.get("error")), "the router does not answer"))
    problems = [str(p) for p in (snap.get("problems") or []) if str(p).strip()]
    if problems:
        blocks.append(quote(bullet_list([esc(p) for p in problems[:6]]), "check these first"))
    if pending:
        blocks.append(heading("waiting for a decision", 3, icon="bell"))
        blocks.append(_pending_list(devices))

    buttons = [
        row(button("people", "dev:list", icon="users"), button("requests", "dev:pending", icon="bell")),
        row(button("tailscale", "tunnel:show", icon="tunnel"), button("services", "svc:show", icon="restart")),
        row(button("model", "model:show", icon="cpu"), button("quota", "quota:show", icon="chart")),
        row(button("config", "cfg:show", icon="settings"), button("log", "log:show", icon="logs")),
        row(button("дампы/логи", "dump:all", icon="logs")),
        row(button("update", "upd:check", icon="update"), button("refresh", "home", icon="refresh")),
    ]
    subtitle = muted("Moodle answer panel " + SEP + " router, AI backend, tailscale, telegram")
    if not router_ok:
        subtitle = status_chip(False, "router is not answering") + " " + muted(SEP + " everything below may be stale")
    return screen("MSE", subtitle, blocks, buttons, footer=muted("version 2.13.1"), icon="bot")


def _pending_list(devices: list[dict[str, Any]]) -> str:
    items = []
    for device in devices:
        if device.get("status") != "pending":
            continue
        name = device.get("name") or "a new device"
        items.append(
            f"<li>{bold(name)} {muted('Moodle id')} {code(device.get('moodleId') or '?')} "
            f"{muted(SEP)} {muted(str(device.get('site') or ''))}</li>"
        )
    return bullet_list(items) if items else ""


def dumps_screen(items: list[dict[str, Any]]) -> Rich:
    blocks: list[str] = []
    buttons: list[str] = []
    for item in items[:10]:
        dump_id = str(item.get("id") or "")
        blocks.append(quote(f"{code(item.get('at') or '?')} {muted(item.get('type') or '?')} "
                            f"ID {code(item.get('moodleId') or '?')} {code(item.get('deviceId') or '?')}"))
        buttons.append(row(button("get dump", "dump:get:" + dump_id, icon="logs")))
    if not items:
        blocks.append(quote(muted("no dumps yet"), "empty"))
    buttons.append(row(button("back", "home", icon="back")))
    return screen("dumps", muted("last 10 · sensitive data"), blocks, buttons, icon="logs")


# ------------------------------------------------------------------ people
def people(snap: dict[str, Any], notice: str = "", only: str = "") -> Rich:
    devices = _devices(snap)
    if only == "pending":
        shown = [d for d in devices if d.get("status") == "pending"]
    else:
        shown = devices
    allow = list(snap.get("allow") or [])

    blocks: list[str] = []
    if notice:
        blocks.append(f"<p>{status_chip(True, notice)}</p>")

    if not shown:
        blocks.append(quote(muted("nobody here yet: a device appears as soon as the extension registers"), "empty"))
    else:
        for device in shown[:12]:
            state = device_state(device)
            icon = {"active": "ok", "pending": "bell", "revoked": "fail"}.get(state, "info")
            name = device.get("name") or "a device"
            dev_id = str(device.get("deviceId") or "?")
            lines = [
                f"{ico(icon, '')}{bold(name)} {muted('Moodle id')} {code(device.get('moodleId') or '?')}",
                f"{muted('device')} {code(dev_id)} {muted(str(device.get('deviceName') or ''))}",
                muted(f"{state} {SEP} last seen {device.get('seen') or '—'} {SEP} quota {device.get('quota') or 0}"),
            ]
            accounts = list(device.get("accounts") or [])
            acc_btns = []
            if len(accounts) > 1:
                acc_lines = []
                for acc in accounts:
                    acc_st = acc.get("status") or "pending"
                    m_id = str(acc.get("moodleId") or "")
                    acc_lines.append(f"• ID {code(m_id or '?')} {muted(acc.get('name') or '')} [{acc_st}]")
                    if m_id:
                        if acc_st == "active":
                            acc_btns.append(button(f"revoke {m_id}", f"dev:revoke:{dev_id}:{m_id}", icon="stop"))
                        else:
                            acc_btns.append(button(f"allow {m_id}", f"dev:approve:{dev_id}:{m_id}", icon="ok"))
                lines.append("<br>".join(acc_lines))
            blocks.append(quote("<br>".join(lines)))
            if acc_btns:
                blocks.append(row(*acc_btns[:4], align="left"))
            elif state == "pending":
                blocks.append(
                    row(
                        button("allow", "dev:approve:" + dev_id, icon="ok"),
                        button("decline", "dev:revoke:" + dev_id, icon="fail"),
                        align="left",
                    )
                )
            elif state == "active":
                blocks.append(row(button("revoke", "dev:revoke:" + dev_id, icon="stop")))

    if allow:
        ids = ", ".join(code(a.get("moodleId") if isinstance(a, dict) else a) for a in allow[:20]
                       if (a.get("moodleId") if isinstance(a, dict) else a))
        blocks.append(heading("allowed Moodle ids", 3, icon="ok"))
        blocks.append(f"<p>{ids}</p>")

    buttons = [
        row(button("waiting", "dev:pending", icon="bell"), button("all", "dev:list", icon="users")),
        input_row("allow by id", "allow_id", icon="add"),
        input_row("revoke", "revoke_id", icon="stop"),
        row(button("back", "home", icon="back")),
    ]
    title = "requests" if only == "pending" else "people"
    return screen(title, muted("who may use the answer database, and who is still waiting"), blocks, buttons, icon="users")


# ------------------------------------------------------------------ model
def model_screen(snap: dict[str, Any], notice: str = "", error: str = "") -> Rich:
    """Pick the model, the OBHOD way: a numbered table of what the backend offers, the live one marked, and one
    numbered button per row — a tap switches, nothing is typed unless the owner wants to type it."""
    health = _health(snap)
    offered = [str(m) for m in (health.get("models") or [])]
    current = str(health.get("model") or "")
    source = str(health.get("modelsSource") or "")
    blocks: list[str] = []
    if notice:
        blocks.append(f"<p>{status_chip(True, notice)}</p>")
    if error:
        blocks.append(quote(esc(error), "the router did not take it"))

    if not offered:
        blocks.append(quote(muted("the backend named no model"), "nothing to pick"))
        return screen(
            "model", muted("the local backend is not answering"),
            blocks,
            [row(button("ask the backend", "model:refresh", icon="refresh"),
                 input_row("type a name", "model", icon="tag")),
             row(button("back", "home", icon="back"))],
            icon="cpu",
        )

    rows: list[tuple[str, str, str]] = []
    for idx, name in enumerate(offered[:10], start=1):
        live = "is on" if name == current else "off"
        rows.append(("ok" if name == current else "cpu", f"{idx} · {name}", code(live)))
    blocks.append(table(rows, ("model of the backend", "now")))
    blocks.append(muted("source: " + (source or "unknown") + " · " + str(len(offered)) + " offered"))

    numbers = [button(str(idx), "model:set:" + name, icon="ok" if name == current else "cpu")
               for idx, name in enumerate(offered[:10], start=1)]
    buttons = [row(*numbers[:5])]
    if len(numbers) > 5:
        buttons.append(row(*numbers[5:10]))
    buttons.append(
        row(
            button("ask the backend again", "model:refresh", icon="refresh"),
            input_row("type a name", "model", icon="tag"),
        )
    )
    buttons.append(row(button("back", "home", icon="back")))
    return screen("model", muted("the list is the backend's; the router only reports it"), blocks, buttons, icon="cpu")


# ------------------------------------------------------------------ quota
def quota_screen(snap: dict[str, Any], notice: str = "") -> Rich:
    health = _health(snap)
    now = health.get("quota")
    blocks = [facts([("now", code(str(now) if now is not None else "—") + muted(" requests / day / device"))], icon="chart")]
    if notice:
        blocks.append(f"<p>{status_chip(True, notice)}</p>")
    steps = [str(v) for v in (50, 100, 200, 500, 1000, 2000)]
    buttons = [row(*[button(v, "quota:set:" + v, icon="chart") for v in steps])]
    buttons.append(input_row("type a number", "quota", icon="tag"))
    buttons.append(row(button("back", "home", icon="back")))
    return screen("quota", muted("how many requests a device may make per day"), blocks, buttons, icon="chart")


# ------------------------------------------------------------------ tunnel
def tunnel_screen(info: dict[str, Any], notice: str = "", error: str = "") -> Rich:
    url = str(info.get("url") or "")
    installed = bool(info.get("installed"))
    running = bool(info.get("running"))
    mode = str(info.get("mode") or "off")
    ip = str(info.get("ip") or "")

    blocks = [
        facts(
            [
                ("tailscale", status_chip(installed, "installed" if installed else "not installed", "ok" if installed else "fail")),
                ("node", status_chip(running, "up" if running else "down", "ok" if running else "fail")),
                ("mode", code(mode)),
                ("tailnet ip", code(ip or "—")),
                ("address", code(url) if url else chip("not published")),
            ],
            icon="tunnel",
        )
    ]
    if notice:
        blocks.append(f"<p>{status_chip(True, notice)}</p>")
    if error:
        blocks.append(quote(esc(error), "the tunnel did not comply"))
    if url:
        blocks.append(row(copy_button("copy the address", url, icon="copy")))
        blocks.append(row(link_button("open /health", url.rstrip("/") + "/health", icon="world")))

    buttons = [
        row(button("tailscale up", "tunnel:up", icon="plug"), button("funnel", "tunnel:funnel", icon="world")),
        row(button("serve", "tunnel:serve", icon="route"), button("turn off", "tunnel:off", icon="stop")),
        row(button("refresh", "tunnel:show", icon="refresh"), button("back", "home", icon="back")),
    ]
    return screen("tailscale", muted("the only way in from outside " + SEP + " funnel gives a stable https address"),
                  blocks, buttons, icon="tunnel")


# ------------------------------------------------------------------ services
def services_screen(snap: dict[str, Any], notice: str = "") -> Rich:
    services = snap.get("services") or {}
    rows_data = []
    for name in ("mse-router", "mse-bot"):
        state = str(services.get(name) or "unknown")
        rows_data.append(("ok" if state == "active" else "fail", name, code(state)))
    blocks = [table(rows_data, ("service", "state")), ]
    if notice:
        blocks.append(f"<p>{status_chip(True, notice)}</p>")
    buttons = [
        row(button("restart router", "svc:restart:mse-router", icon="restart"),
            button("restart bot", "svc:restart:mse-bot", icon="restart")),
        row(button("stop router", "svc:stop:mse-router", icon="stop"),
            button("start router", "svc:start:mse-router", icon="play")),
        row(button("journal", "log:show", icon="logs"), button("back", "home", icon="back")),
    ]
    return screen("services", muted("systemd units of the stack"), blocks, buttons, icon="restart")


# ------------------------------------------------------------------ log
def log_screen(snap: dict[str, Any]) -> Rich:
    records = list(snap.get("log") or [])[-20:]
    if not records:
        blocks: list[str] = [quote(muted("nothing yet"), "log")]
    else:
        lines = []
        for record in records:
            when = str(record.get("t") or "")
            when = when[11:19] if len(when) > 19 else when
            text = str(record.get("what") or record.get("text") or "")
            lines.append(f"{muted(when)}  {esc(text)}")
        blocks = [pre("\n".join(lines))]
    buttons = [row(button("refresh", "log:show", icon="refresh"), button("back", "home", icon="back"))]
    return screen("log", muted("what the router has done lately"), blocks, buttons, icon="logs")


# ------------------------------------------------------------------ config
def config_screen(cfg: dict[str, Any], notice: str = "") -> Rich:
    def masked(value: Any, keep: int = 4) -> str:
        text = str(value or "")
        if not text:
            return chip("not set")
        if len(text) <= keep + 2:
            return code("*" * len(text))
        return code(text[:keep] + "*" * 6 + text[-2:])

    blocks = [
        heading("gateway", 3, icon="server"),
        facts(
            [
                ("model", code(cfg.get("model") or "—")),
                ("quota", code(str(cfg.get("quota") or "—"))),
                ("backend port", code(str(cfg.get("upstream_port") or "—"))),
                ("public url", code(cfg.get("public_url") or "—")),
                ("notify step", code(str(cfg.get("notify_step") or "20") + " reqs")),
            ],
            icon="settings",
        ),
        heading("secrets", 3, icon="lock"),
        facts(
            [
                ("bot token", masked(cfg.get("bot_token"))),
                ("owner id", code(cfg.get("owner_id") or "—")),
                ("api id", code(cfg.get("api_id") or "—")),
                ("api hash", masked(cfg.get("api_hash"))),
                ("tailscale key", masked(cfg.get("tailscale_key"))),
            ],
            icon="key",
        ),
    ]
    if notice:
        blocks.insert(0, f"<p>{status_chip(True, notice)}</p>")
    blocks.append(quote(muted("a value is typed in the message field: tap a button, type, and pick the result — it is "
                              "never sent to the chat. A secret is shown masked here only."), "how it works"))
    blocks.append(quote(muted("the emoji pack (tgiosicons, the same as the obhod panel) is off by default: "
                              "turn it on when the custom emoji show up for you"), "emoji"))
    buttons = [
        input_row("bot token", "bot_token", icon="bot"),
        input_row("owner id", "owner_id", icon="user"),
        input_row("notify interval", "notify_step", icon="bell"),
        input_row("api id", "api_id", icon="tag"),
        input_row("api hash", "api_hash", icon="lock"),
        input_row("tailscale key", "tailscale_key", icon="key"),
        row(button("emoji pack " + ("on" if cfg.get("emoji") else "off"), "cfg:emoji",
                   icon="star", style=""), button("refresh", "cfg:show", icon="refresh")),
        row(button("back", "home", icon="back")),
    ]
    return screen("config", muted("what the stack is running on " + SEP + "/etc/mse/mse.env"), blocks, buttons, icon="settings")


# ------------------------------------------------------------------ update
def update_screen(result: dict[str, Any] | None = None, notice: str = "", error: str = "") -> Rich:
    blocks: list[str] = []
    if result:
        ok = bool(result.get("ok"))
        blocks.append(f"<p>{status_chip(ok, 'updated' if ok else 'update failed', 'ok' if ok else 'fail')}</p>")
        tail = str(result.get("tail") or "").strip()
        if tail:
            blocks.append(pre("\n".join(tail.splitlines()[-12:])))
    else:
        blocks.append(quote(muted("this pulls the code again, reinstalls the dependencies and restarts the services. "
                                  "People, the allow list and every key stay exactly where they are."), "update"))
    if notice:
        blocks.insert(0, f"<p>{status_chip(True, notice)}</p>")
    if error:
        blocks.append(quote(esc(error), "the update did not go through"))
    buttons = [
        row(button("update now", "upd:run", icon="update"), button("refresh", "upd:check", icon="refresh")),
        row(button("services", "svc:show", icon="restart"), button("back", "home", icon="back")),
    ]
    return screen("update", muted("code and dependencies, in place"), blocks, buttons, icon="update")


# ------------------------------------------------------------------ help
def help_screen() -> Rich:
    commands = [
        "/start " + muted("this panel"),
        "/state " + muted("the state in plain lines"),
        "/people, /pending " + muted("who is in and who is waiting"),
        "/allow <moodleId>, /revoke <moodleId> " + muted("let in, take out"),
        "/quota <N>, /model <id> " + muted("the quota and the model"),
        "/tunnel, /services, /log " + muted("tailscale, systemd, the journal"),
        "/config " + muted("the settings, secrets masked"),
        "/update " + muted("update the stack"),
    ]
    blocks = [bullet_list(commands)]
    buttons = [row(button("panel", "home", icon="home"))]
    return screen("commands", muted("everything the buttons do, typed"), blocks, buttons, icon="docs")
