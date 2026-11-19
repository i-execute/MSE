"""Test applicant approve/decline buttons and request milestone notification in MSE bot."""
import asyncio
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "Server"))

from bot import main as bot_main
from bot import screens, ui

async def test_applicant_announce():
    bot = bot_main.Bot()
    rendered = []
    async def fake_render(chat_id, msg_id, screen):
        rendered.append(screen)
        return 1

    bot.render = fake_render
    bot_main.OWNER_ID = 123456

    # Test announce
    item = {
        "moodleId": "99999",
        "name": "Иван Иванов",
        "deviceId": "dev-abcdef1234567890",
        "site": "moodle.example.edu"
    }
    await bot.announce(item)
    assert len(rendered) == 1
    screen = rendered[0]
    # Check that buttons include Принять and Отклонить
    html = screen.to_html()
    assert "Принять" in html, f"HTML: {html}"
    assert "Отклонить" in html, f"HTML: {html}"

async def test_notify_interval_config():
    bot = bot_main.Bot()
    chat_id = 123456
    messages = []
    async def fake_deliver(cid, text):
        messages.append(text)
    bot.deliver_raw = fake_deliver
    bot.config = lambda *args, **kwargs: asyncio.sleep(0)

    # Test invalid notify step
    await bot.set_config(chat_id, 0, "notify_step", "-5")
    assert any("positive number" in m for m in messages)

    # Test valid notify step
    test_env = "/tmp/mse-test-bot.env"
    bot_main.ENV_FILE = test_env
    Path(test_env).write_text("")
    await bot.set_config(chat_id, 0, "notify_step", "40")
    env = bot_main.env_read()
    assert env.get("MSE_REQUEST_NOTIFY_EVERY") == "40"

if __name__ == "__main__":
    asyncio.run(test_applicant_announce())
    asyncio.run(test_notify_interval_config())
    print("PASS: bot applicant & notify milestone tests passed")
