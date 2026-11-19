"""Test bot notifications: applicant cards with approve/decline and configurable request milestones."""
import asyncio
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "Server"))

from bot import main as bot_main

async def test_bot_notifications():
    bot = bot_main.Bot()
    rendered = []
    async def fake_render(chat_id, msg_id, screen):
        rendered.append(screen)
        return 1

    bot.render = fake_render
    bot_main.OWNER_ID = 123456

    # Test announce
    item = {
        "moodleId": "12345",
        "name": "Иван Иванов",
        "deviceId": "dev-0123456789abcdef",
        "site": "moodle.example.edu"
    }
    await bot.announce(item)
    assert len(rendered) == 1
    html = rendered[0].to_html()
    assert "Принять" in html, f"Принять button missing: {html}"
    assert "Отклонить" in html, f"Отклонить button missing: {html}"

    # Test inline configuration for notify interval
    test_env = "/tmp/mse-test-bot-notifications.env"
    bot_main.ENV_FILE = test_env
    Path(test_env).write_text("")
    await bot.set_config(123456, 0, "notify_step", "50")
    env = bot_main.env_read()
    assert env.get("MSE_REQUEST_NOTIFY_EVERY") == "50"

if __name__ == "__main__":
    asyncio.run(test_bot_notifications())
    print("PASS: bot_notifications passed")
