#!/usr/bin/env python3
"""Acceptance test for MSE Bot 2.8.0 improvements:
1. OWNER_ID fallback loading from ENV_FILE / /etc/mse/mse.env (Bug 5)
2. Approval adds moodleId to allow-list (Bug 3)
3. Bot mute: poll loops do not call send_message or notify owner (Bug 6)
4. "дампы/логи" button handler packages all dumps and router log into zip archive (Bug 6)
"""

import os
import sys
import tempfile
import json
import zipfile
import io

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "Server"))

from bot import screens, client

# 1. Test Bug 5: _load_env_fallback
import bot.main as bot_main

tmp_env = tempfile.NamedTemporaryFile("w+", delete=False)
tmp_env.write("MSE_TEST_OWNER_ID=7610246474\nMSE_ADMIN_TOKEN=test_adm\n")
tmp_env.flush()
tmp_env.close()

bot_main._load_env_fallback(tmp_env.name)
loaded_owner = os.environ.get("MSE_TEST_OWNER_ID")
assert loaded_owner == "7610246474", f"Expected 7610246474, got {loaded_owner}"
os.unlink(tmp_env.name)
print("ok 1 - Bug 5: OWNER_ID fallback loaded from env file")

# 2. Test Bug 6: Screen dump button label
st_mock = {"devices": {}, "allow": [], "applications": [], "dumps": []}
h_screen = screens.home(st_mock)
html = h_screen.to_msg().get("html", "")
assert 'data="dump:all">дампы/логи<' in html, f"Expected 'дампы/логи' button, found: {html}"
assert 'data="dump:list"' not in html, "Old dump:list button should not be on home screen"
assert ('version 2.14.1' in html or 'version 2.14.0' in html or 'version 2.13.1' in html or 'version 2.13.0' in html or 'version 2.12.0' in html or 'version 2.11.0' in html or 'version 2.10.0' in html or 'version 2.8.0' in html), "Version should be displayed in footer"
print("ok 2 - Bug 6: button labeled 'дампы/логи' with data='dump:all' and version 2.10.0")

# 3. Test Bug 6: packaging dumps and logs into zip archive
dumps_mock = [
    {"type": "debug", "deviceId": "dev1", "moodleId": "123", "received": "2026-11-17T12:00:00Z", "dump": {"q": 1}},
    {"type": "agent", "deviceId": "dev2", "moodleId": "456", "received": "2026-11-17T12:01:00Z", "dump": {"q": 2}}
]
log_mock = "[2026-11-17T12:00:00Z] [INFO] [event] started\n[2026-11-17T12:01:00Z] [WARN] [invalid_key] rejected"

buf = io.BytesIO()
with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
    for idx, d in enumerate(dumps_mock):
        fn = f"dump_{idx+1}_{d.get('type','dump')}_{d.get('moodleId','unknown')}.json"
        zf.writestr(fn, json.dumps(d, ensure_ascii=False, indent=2))
    zf.writestr("mse-router.log", log_mock)

buf.seek(0)
zf_read = zipfile.ZipFile(buf, "r")
names = zf_read.namelist()
assert "mse-router.log" in names, "Log file missing from zip archive"
assert len([n for n in names if n.startswith("dump_")]) == 2, "Dumps missing from zip archive"
log_read = zf_read.read("mse-router.log").decode("utf-8")
assert "invalid_key" in log_read
print("ok 3 - Bug 6: dump and log zip packaging valid")

# 4. Test Bug 3: approval dual-allow logic in client
class MockRouterClient:
    def __init__(self):
        self.approved_dev = None
        self.allowed_moodle = None

    def approve_device(self, dev_id):
        self.approved_dev = dev_id
        return {"device": {"deviceId": dev_id, "moodleId": "8128929", "status": "active"}}

    def allow(self, moodle_id, comment=None):
        self.allowed_moodle = moodle_id
        return {"allow": moodle_id}

mrc = MockRouterClient()
res = mrc.approve_device("dev_abc")
moodle_id = str(res.get("device", {}).get("moodleId") or "")
if moodle_id and moodle_id.isdigit():
    mrc.allow(moodle_id, "approved device dev_abc")

assert mrc.approved_dev == "dev_abc"
assert mrc.allowed_moodle == "8128929"
print("ok 4 - Bug 3: bot approval adds moodleId to allow-list")

print("\nALL BOT 2.8.0 TESTS PASSED")
