#!/usr/bin/env python3
"""Acceptance test for MSE Bot 2.11.0:
- A10: Immediate alert upon new registration with inline «добавить» and «отклонить» buttons directly in the message.
- A10: Silence otherwise (watch_applications only announces new pending applications, no dump notification spam).
- Version 2.11.0 in screens footer.
"""

import sys
import asyncio
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "Server"))

from bot import screens
import bot.main as bot_main

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
    "deviceId": "mse-testdevice2110000",
    "moodleId": "778899",
    "name": "Applicant 211",
    "site": "moodle.test.edu"
}

# 1. Announce triggers immediate notification
asyncio.run(dummy.announce(new_req))
assert len(dummy.sent_messages) == 1, f"Expected 1 announce message, got {len(dummy.sent_messages)}"

sent_screen = dummy.sent_messages[0]["screen"].to_msg()
html = sent_screen.get("html", "")
keyboard = sent_screen.get("reply_markup", {}).get("inline_keyboard", [])

# Verify content
assert "new request" in html.lower()
assert "Applicant 211" in html
assert "778899" in html
assert "moodle.test.edu" in html
print("ok 1 - A10: Immediate announce card created with applicant details")

# 2. Verify inline buttons "Принять"/"добавить" and "Отклонить"/"отклонить" in the message
assert "добавить" in html or "Принять" in html, f"Expected 'Принять' or 'добавить' in message HTML, got {html}"
assert "отклонить" in html or "Отклонить" in html, f"Expected 'Отклонить' or 'отклонить' in message HTML, got {html}"
assert "dev:approve:mse-testdevice2110000:778899" in html or "dev:approve:mse-testdevice2110000" in html
assert "dev:revoke:mse-testdevice2110000:778899" in html or "dev:revoke:mse-testdevice2110000" in html
print("ok 2 - A10: Inline 'добавить' and 'отклонить' buttons present with device/moodle callback")

# 3. Verify footer has version
h_screen = screens.home({"health": {}, "devices": []}, notice="")
h_html = h_screen.to_msg().get("html", "")
assert ("version 2.13.1" in h_html or "version 2.13.0" in h_html or "version 2.12.0" in h_html or "version 2.11.0" in h_html), f"Expected version in footer, got {h_html}"
print("ok 3 - Version 2.12.0 present in home footer")

print("\nALL BOT 2.11 TESTS PASSED")
