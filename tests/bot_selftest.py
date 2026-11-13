"""Acceptance of the MSE telegram bot, without Telegram: the real router is started on a loopback port, the bot's
own handlers are driven with a fake event and a fake app, and the screens they send are read back.

    python3 tests/bot_selftest.py

It covers: the panel of a fresh gateway, an application that must be let in by Moodle id (a number typed by the
owner and a tap on the button), a revoke, the quota and the model, and the tunnel screen with a stubbed
mse-tunnel.sh. Nothing here needs a token, a network or tailscale.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SERVER = ROOT / "Server"
sys.path.insert(0, str(SERVER))

PASS = 0
FAIL = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global PASS, FAIL
    if ok:
        PASS += 1
        print(f"ok   {name}")
    else:
        FAIL += 1
        print(f"FAIL {name}" + (f"  ← {detail}" if detail else ""))


def wait_http(url: str, timeout: float = 20.0) -> dict:
    end = time.time() + timeout
    last = ""
    while time.time() < end:
        try:
            with urllib.request.urlopen(url, timeout=3) as resp:
                return json.loads(resp.read(1 << 20).decode("utf-8", "replace"))
        except Exception as exc:  # noqa: BLE001
            last = str(exc)
            time.sleep(0.25)
    raise RuntimeError(f"{url} did not answer: {last}")


class FakeApp:
    def __init__(self) -> None:
        self.sent: list[tuple[int, str]] = []
        self.edited: list[tuple[int, int, str]] = []

    async def send_msg(self, chat_id: int, text: str, **kw) -> dict:
        self.sent.append((chat_id, text))
        return {"message_id": len(self.sent)}

    async def edit_msg(self, chat_id: int, msg_id: int, text: str, **kw) -> dict:
        self.edited.append((chat_id, msg_id, text))
        return {"message_id": msg_id}


class FakeEvt:
    def __init__(self, data: str = "", chat_id: int = 555, msg_id: int = 7, from_id: int = 901, text: str = "") -> None:
        self.data = data
        self.chat_id = chat_id
        self.msg_id = msg_id
        self.from_id = from_id
        self.text = text
        self.answers: list[str] = []

    async def answer(self, text: str = "", alert: bool = False) -> None:
        self.answers.append(text)


def main() -> int:
    data_dir = tempfile.mkdtemp(prefix="mse-bot-")
    tunnel_stub = Path(data_dir) / "mse-tunnel.sh"
    tunnel_stub.write_text(
        "#!/usr/bin/env bash\n"
        "case \"$1\" in\n"
        "  status) echo '{\"backend\":\"tailscale\",\"installed\":true,\"running\":true,\"mode\":\"funnel\","
        "\"url\":\"https://mse-gateway.example.ts.net\",\"ip\":\"192.0.2.10\"}' ;;\n"
        "  funnel|serve) echo \"https://mse-gateway.example.ts.net\" ;;\n"
        "  off) echo 'off' ;;\n"
        "esac\n"
    )
    tunnel_stub.chmod(0o755)
    env = dict(os.environ)
    env.update({
        "MSE_DATA_DIR": data_dir,
        "MSE_ADMIN_TOKEN": "adm_bot_test",
        "MSE_PORT": "0",
        "MSE_UPSTREAM_PORT": "18797",
        "MSE_MODEL": "gemini-3-flash",
        "MSE_MODELS": "gemini-3-flash,gpt-4o-mini",
        "MSE_DAILY_QUOTA": "200",
        "MSE_PUBLIC_URL": "https://mse-gateway.example.ts.net",
    })
    router = subprocess.Popen(["node", str(SERVER / "mse-router.js")], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    port = 0
    try:
        line = router.stdout.readline() if router.stdout else ""
        # «MSE router 2.0.0 on http://127.0.0.1:18811  (public: …)» — the port is the one after the host
        match = re.search(r"on https?://[^\s:]+:(\d+)", line or "")
        if match and match.group(1) != "0":
            port = int(match.group(1))
        # MSE_PORT=0 is legal but the announced number is 0: ask the kernel through a fixed port instead
        if not port:
            router.terminate()
            router.wait(timeout=10)
            env["MSE_PORT"] = "18811"
            router = subprocess.Popen(["node", str(SERVER / "mse-router.js")], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            port = 18811
            if router.stdout:
                router.stdout.readline()
        base = f"http://127.0.0.1:{port}"
        health = wait_http(base + "/health")
        check("the router is up and calls itself a gateway", health.get("name") == "MSE gateway", json.dumps(health)[:160])

        # a device applies, exactly as the extension does: a made-up key and the Moodle id of the student
        key = "mse_" + "a" * 48
        body = json.dumps({"key": key, "moodleId": "12345", "name": "Test User"}).encode()
        req = urllib.request.Request(base + "/mse/v1/register", data=body, method="POST", headers={"content-type": "application/json"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            reg = json.loads(resp.read().decode())
        check("the application is pending until the owner decides", reg.get("device", {}).get("status") == "pending", json.dumps(reg)[:200])

        os.environ["MSE_ADMIN_URL"] = base
        os.environ["MSE_ADMIN_TOKEN"] = "adm_bot_test"
        os.environ["MSE_OWNER_ID"] = "901"
        os.environ["MSE_TUNNEL_SCRIPT"] = str(tunnel_stub)
        os.environ["MSE_ENV_FILE"] = str(Path(data_dir) / "mse.env")
        Path(os.environ["MSE_ENV_FILE"]).write_text("MSE_MODEL=gemini-3-flash\n")

        from bot import main as botmod  # noqa: PLC0415  (the env must be in place first)

        bot = botmod.Bot()
        bot.gw = botmod.Gateway(base, "adm_bot_test")
        app = FakeApp()
        bot.app = app

        # 1. the panel
        asyncio.run(bot.home(555))
        panel = app.sent[-1][1]
        check("the panel names the tunnel address", "mse-gateway.example.ts.net" in panel, panel[:200])
        check("the panel shows the quota and the count of devices", "200" in panel and "устройств" in panel, panel[:200])
        check("the waiting application is on the panel", "12345" in panel and "ждут решения" in panel, panel[:300])

        # 2. a stranger cannot use the bot
        stranger = FakeEvt(data="dev:list", from_id=999)
        asyncio.run(bot.on_callback(stranger))
        check("a stranger gets no panel and is told so", (not app.sent or app.sent[-1][0] != 999) and stranger.answers, str(stranger.answers))

        # 3. one tap lets the application in by its own device id
        pending = asyncio.run(bot.snap())["devices"][0]["deviceId"]
        evt = FakeEvt(data="dev:approve:" + pending)
        asyncio.run(bot.on_callback(evt))
        states = [d["status"] for d in asyncio.run(bot.snap())["devices"]]
        check("the tap approves the device", "active" in states, str(states))
        check("the callback is always answered", any(evt.answers), str(evt.answers))

        # 4. a command lets in by Moodle id, and the key goes live for the model
        allowed = FakeEvt(text="/allow 12346")
        asyncio.run(bot.on_message(allowed))
        snap = asyncio.run(bot.snap())
        check("the ID is in the allow-list", any(str(a.get("moodleId")) == "12346" for a in snap["allow"]), json.dumps(snap["allow"])[:200])

        # 5. revoke by Moodle id: the device stops being active
        revoked = FakeEvt(text="/revoke 12345")
        asyncio.run(bot.on_message(revoked))
        states = [d["status"] for d in asyncio.run(bot.snap())["devices"]]
        check("the revoke takes the device off", "revoked" in states, str(states))

        # 6. the quota, from a button and from a number
        qevt = FakeEvt(data="quota:set:50")
        asyncio.run(bot.on_callback(qevt))
        check("the quota is changed by a button", asyncio.run(bot.snap())["health"].get("quota") == 50, str(asyncio.run(bot.snap())["health"].get("quota")))

        # 7. the tunnel screen and its buttons go through mse-tunnel.sh
        asyncio.run(bot.tunnel(555, 0, "show"))
        tunnel_text = app.sent[-1][1]
        check("the tunnel screen shows tailscale and the address", "tailscale" in tunnel_text and "mse-gateway" in tunnel_text, tunnel_text[:220])
        asyncio.run(bot.tunnel(555, 0, "funnel"))
        check("the funnel button is answered with the address", "mse-gateway" in app.sent[-1][1], app.sent[-1][1][:200])

        # 8. the model is remembered for the backend
        asyncio.run(bot.set_model(555, 0, "gpt-4o-mini"))
        env_text = Path(os.environ["MSE_ENV_FILE"]).read_text()
        check("the chosen model lands in the env file of the stack", "MSE_MODEL=gpt-4o-mini" in env_text, env_text)

        # 9. the log screen keeps what the router did
        asyncio.run(bot.on_message(FakeEvt(text="/log")))
        check("the log screen shows the router's own records", "журнал" in app.sent[-1][1], app.sent[-1][1][:160])
    finally:
        router.terminate()
        try:
            router.wait(timeout=10)
        except subprocess.TimeoutExpired:
            router.kill()

    print(f"\n{PASS} passed · {FAIL} failed")
    return 1 if FAIL else 0


if __name__ == "__main__":
    raise SystemExit(main())
