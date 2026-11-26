#!/usr/bin/env python3
"""Send MSE 2.16.0 delivery files and summary to Telegram owner.
Usage:
    python3 tools/send_tg_delivery.py
"""

import os
import sys
import json
import uuid
import zipfile
import mimetypes
import urllib.request
import urllib.error
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / "Storage" / "artifacts"
CHAT_ID = os.environ.get("MSE_OWNER_ID") or os.environ.get("TELEGRAM_CHAT_ID") or "7610246474"

def make_delivery_zip() -> Path:
    zip_path = ARTIFACTS / "MSE-2.16.0.zip"
    include_dirs = [
        "Extensions/src",
        "Extensions/tools",
        "Server",
        "Storage/Documentation",
        "tests",
        "tools",
        "scripts",
        "skills",
    ]
    include_files = [
        "Storage/artifacts/mse.user.js",
        "Storage/artifacts/build-report.json",
        "Storage/artifacts/mse-2.16.0.patch",
        "Storage/get.sh",
        "package.json",
        "package-lock.json",
        "README.md",
        "RELEASE_2.16.0.md",
        "RELEASE_2.15.0.md",
        "CHANGES.md",
        "LICENSE",
    ]
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for rel in include_files:
            p = ROOT / rel
            if p.exists():
                zf.write(p, rel)
            else:
                print(f"Warning: file {rel} not found", file=sys.stderr)
        for dir_rel in include_dirs:
            dp = ROOT / dir_rel
            if not dp.exists():
                continue
            for p in dp.rglob("*"):
                if p.is_file():
                    if "__pycache__" in p.parts or ".pytest_cache" in p.parts or p.name.endswith(".pyc"):
                        continue
                    rel = p.relative_to(ROOT)
                    zf.write(p, str(rel))
    print(f"Created complete delivery zip: {zip_path} ({zip_path.stat().st_size} bytes)")
    return zip_path

def load_token() -> str:
    t = (os.environ.get("MSE_BOT_TOKEN") or os.environ.get("TELEGRAM_BOT_TOKEN") or "").strip()
    if t:
        return t
    for env_path in (Path("/etc/mse/mse.env"), Path.home() / ".env"):
        if env_path.exists():
            try:
                for line in env_path.read_text(encoding="utf-8").splitlines():
                    if line.startswith("MSE_BOT_TOKEN="):
                        return line.split("=", 1)[1].strip()
            except Exception:
                pass
    return ""

TOKEN = load_token()
API = f"https://api.telegram.org/bot{TOKEN}/%s"

def call(method: str, payload: dict | None = None, files: dict | None = None) -> dict:
    url = API % method
    if not files:
        data = json.dumps(payload or {}).encode("utf-8")
        req = urllib.request.Request(url, data=data, headers={"content-type": "application/json"})
    else:
        boundary = "----mse" + uuid.uuid4().hex
        body = b""
        for key, value in (payload or {}).items():
            body += (f"--{boundary}\r\nContent-Disposition: form-data; name=\"{key}\"\r\n\r\n{value}\r\n").encode("utf-8")
        for key, path in files.items():
            path = Path(path)
            kind = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
            body += (f"--{boundary}\r\nContent-Disposition: form-data; name=\"{key}\"; filename=\"{path.name}\"\r\n"
                     f"Content-Type: {kind}\r\n\r\n").encode("utf-8")
            body += path.read_bytes() + b"\r\n"
        body += (f"--{boundary}--\r\n").encode("utf-8")
        req = urllib.request.Request(url, data=body, headers={"content-type": f"multipart/form-data; boundary={boundary}"})
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return json.loads(resp.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as exc:
        return {"ok": False, "error": exc.read().decode("utf-8", "replace")[:400]}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}

def main():
    zip_path = make_delivery_zip()

    if not TOKEN:
        print("Note: MSE_BOT_TOKEN is not set in environment (offline packaging mode).", file=sys.stderr)
        print("Delivery archive created successfully at:", zip_path)
        return 0

    report_text = """<b>🚀 MSE 2.16.0 Full Kit Delivered</b>

<b>Ключевые изменения релиза 2.16.0:</b>
• <b>Part A. Комбинированный хеш и надёжный DOM</b>:
  - <code>questionIdentity</code> включает текст, отсортированные варианты (с картинками) и изображения вопроса — нет коллизий при одинаковом вопросе.
  - Устойчивый парсинг: поддержка <code>.form-check</code>, таблиц, картинок-ответов, чистка MathJax/Katex.
  - Неразрушающий ответ: исключены фиктивные строки в списке, вычисляется <code>closestMatch</code>, несопоставленный ответ выводится в блоке <code>.agent-unmatched-row</code>.
  - Zero-Options Guard: при 0 распознанных опциях вызов агента блокируется с <code>options not captured</code>.
  - Из экрана ответов удалены кнопки Snif и Report (нет случайных нажатий).
• <b>Part B &amp; C. Квотирование дампов (DUMP_QUOTA)</b>:
  - По умолчанию <code>0</code> (безлимитно для одобренных устройств).
  - До 50 дампов/день для неодобренных (pending) устройств для диагностики.
  - Эндпоинт <code>POST /admin/dump-quota</code> для изменения на лету без рестарта.
  - Поддержка в TUI: валидация, отображение в Health &amp; Status, редактирование и пуш в роутер.
• <b>Part D. Стабильность туннеля и принудительный IPv4</b>:
  - Флаг <code>curl -4</code> на всех запросах — нет зависаний на IPv6.
  - Автовосстановление Funnel при зависании TLS (перезапуск tailscaled).
  - Автономный локальный вотчдог без сетевых запросов наружу.
• <b>Part E. Вопросы на соответствие (Matching / Multi-Select)</b>:
  - Фильтрация плейсхолдеров (<code>Выберите...</code>, <code>Choose...</code>, <code>0</code>, <code>--</code>) из списков вариантов и промпта.
  - Очистка подвопросов от меток доступности Moodle (<code>Answer 1 Question 4</code>).
  - Нажатие на ответ заполняет ВСЕ селекты вопроса на соответствие (а не только первый).
  - Лишние невыбранные дистракторы автоматически исчезают из попапа после ответа агента.

<b>Инструкция по обновлению на GitHub и сервере:</b>
1. <b>Залить на GitHub:</b>
   Распакуйте архив в репозиторий (или примените <code>git apply mse-2.16.0.patch</code>), сделайте коммит и пуш:
   <code>git commit -am "MSE 2.16.0 release" &amp;&amp; git push</code>
2. <b>Переустановка на сервере:</b>
   <code>bash -c "$(curl -4 -fsSL https://raw.githubusercontent.com/i-execute/MSE/main/Storage/get.sh)"</code>
   <i>(или в локальной папке: <code>sudo ./Server/stack/install.sh</code>)</i>
3. <b>В браузере (Safari / Tampermonkey):</b>
   Установите обновлённый userscript <code>mse.user.js</code> (v2.16.0)."""

    print(f"Sending message to chat {CHAT_ID}...")
    res = call("sendMessage", {"chat_id": CHAT_ID, "text": report_text, "parse_mode": "HTML"})
    if not res.get("ok"):
        print("sendMessage failed:", res)
        return 1
    print("Message sent successfully.")

    files_to_send = [
        (zip_path, "MSE 2.16.0 — Полный архив проекта (Ready for GitHub push)"),
        (ARTIFACTS / "mse.user.js", "MSE 2.16.0 — Пользовательский скрипт (Userscript)"),
        (ARTIFACTS / "mse-2.16.0.patch", "MSE 2.16.0 — Git Patch для быстрого применения"),
        (ROOT / "RELEASE_2.16.0.md", "MSE 2.16.0 — Описание релиза и документация")
    ]

    for p, caption in files_to_send:
        if not p.exists():
            print(f"File not found: {p}", file=sys.stderr)
            continue
        print(f"Sending {p.name} ({p.stat().st_size} bytes)...")
        res = call("sendDocument", {"chat_id": CHAT_ID, "caption": caption}, {"document": p})
        if res.get("ok"):
            print(f"Successfully sent {p.name}")
        else:
            print(f"Failed to send {p.name}: {res.get('error')}", file=sys.stderr)

    return 0

if __name__ == "__main__":
    sys.exit(main())
