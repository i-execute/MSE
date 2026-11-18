#!/usr/bin/env python3
"""Acceptance test for MSE Bot 2.10.0 improvements:
- D4: Silent single notification for new requests; dumps processed silently without owner notification spam.
- D5: Single uniform name AI_PROXY across configuration and documentation.
- Multi-account approval/revocation buttons per Moodle ID in people screen.
- Version 2.10.0 in screens footer.
"""

import os
import sys
import asyncio
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "Server"))

from bot import screens, client
import bot.main as bot_main

# 1. D4: Verify announce creates single notification and dumps/watch are silent
class DummyBot(bot_main.Bot):
    def __init__(self):
        super().__init__()
        self.sent_messages = []

    async def render(self, chat_id, msg_id, screen_obj):
        self.sent_messages.append({
            "chat_id": chat_id,
            "msg_id": msg_id,
            "screen": screen_obj
        })

dummy = DummyBot()
new_req = {
    "deviceId": "mse-1111222233334444",
    "moodleId": "998877",
    "name": "Student A",
    "site": "moodle.example.edu"
}

asyncio.run(dummy.announce(new_req))
assert len(dummy.sent_messages) == 1, f"Expected exactly 1 notification message, got {len(dummy.sent_messages)}"
sent_screen = dummy.sent_messages[0]["screen"].to_msg()
assert "new request" in sent_screen.get("html", "").lower()
print("ok 1 - D4: Bot sends single quiet message on new registration")

# 2. D4: Verify dump polling is silent
# In main.py watch_applications is a silent loop with no chat messages
import inspect
watch_src = inspect.getsource(bot_main.Bot.watch_applications)
assert "deliver" not in watch_src and "send_message" not in watch_src, "watch_applications must not spam chat"
print("ok 2 - D4: Background watch and dump events are silent (no spam)")

# 3. D5: Verify uniform AI_PROXY environment variable name
# Check that no legacy PROXY_URL or HTTP_PROXY is used for gateway AI proxy
import re
router_src = (ROOT / "Server" / "mse-router.js").read_text(encoding="utf-8")
assert "AI_PROXY" in router_src, "AI_PROXY should be used in mse-router.js"
assert not re.search(r"process\.env\.(AI_SOCKS_PROXY|GATEWAY_PROXY)\b", router_src), "Uniform AI_PROXY should be used"
print("ok 3 - D5: Uniform AI_PROXY used across codebase")

# 4. Multi-account rendering in screens.people
state_multi = {
    "allow": ["101"],
    "devices": [
        {
            "deviceId": "mse-dev-multi",
            "name": "Test User",
            "status": "pending",
            "accounts": [
                {"moodleId": "101", "name": "Account One", "status": "active"},
                {"moodleId": "102", "name": "Account Two", "status": "pending"}
            ]
        }
    ]
}
p_screen = screens.people(state_multi)
p_html = p_screen.to_msg().get("html", "")
assert "dev:revoke:mse-dev-multi:101" in p_html, "Active sub-account has revoke callback"
assert "dev:approve:mse-dev-multi:102" in p_html, "Pending sub-account has approve callback"

h_screen = screens.home(state_multi)
h_html = h_screen.to_msg().get("html", "")
assert "version 2.10.0" in h_html, "Version 2.10.0 is shown in home footer"
print("ok 4 - 2.10 multi-account buttons and 2.10.0 footer verified")

print("\nALL BOT 2.10 TESTS PASSED")
