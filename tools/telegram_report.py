"""Post the round's report and the built files to the owner's Telegram chat (bot API, python3 only).

    python3 tools/telegram_report.py            # sends the report text and the archive
    python3 tools/telegram_report.py --text     # the report only

curl on this machine cannot reach api.telegram.org (HTTP 000), so everything goes through urllib.
"""
from __future__ import annotations

import argparse
import json
import mimetypes
import os
import sys
import urllib.error
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT.parent / "deliverables"   # "out" is not kept in a snapshot; "deliverables" is
API = "https://api.telegram.org/bot%s/%s"
LIMIT = 3900

REPORT = """<b>MSE 2.4 — агент отвечает, модели приходят из бэкенда, одна кнопка на действие</b>

<b>Баг 1 (критический) — <code>/mse/v1/agent</code> обслуживает роутер.</b> Было: путь целиком уходил в прокси на <code>127.0.0.1:8799</code>, и на каждый вопрос с вариантами приходило <code>not found: /mse/v1/agent</code> да ещё три ретрая подряд. Теперь <code>handleAgent</code> в <code>mse-router.js</code> сам строит <code>POST /v1/chat/completions</code> к локальному бэкенду, разбирает ответ и сверяет его с вариантами: 401 чужой ключ, 403 не active, 429 квота с <code>retry-after</code>, 503 «бэкенд не назвал модель», 502 бэкенд молчит/мусор, 200 с <code>answer</code> из списка, а вариант «не из задачи» — честный <code>agent_error</code>. Проверка: <code>tests/agent_models.test.js</code> — мок-бэкенд знает только <code>/v1/*</code>, дальше register → allow → agent; <code>answer</code> из предложенных, ни один путь <code>/mse/*</code> до бэкенда не дошёл.

<b>Баг 3 — ноль хардкода моделей.</b> Было <code>MSE_MODEL || 'gemini-3-flash'</code> в роутере, список в <code>install.sh</code>, дефолт в TUI, <code>model: 'mse'</code> в расширении. Теперь источник истины — бэкенд: роутер спрашивает <code>GET /v1/models</code> при старте и по кнопке (<code>POST /admin/models</code>), кэширует в состоянии, отдаёт в <code>/v1/models</code>, <code>/health</code> (<code>models</code>, <code>modelsCount</code>, <code>modelsSource</code>) и <code>/admin/models</code>. <code>MSE_MODEL</code> — только дефолт: нет в списке → предупреждение в журнал и первая доступная модель. Расширение о моделях не знает вовсе: ни списка на экране шлюза, ни имени модели в строке ответа. Проверка: тот же тест, второй сценарий — бэкенд A даёт три модели, бэкенд B одну, список меняется БЕЗ правки кода, а дефолт не из списка заменяется с записью в лог.

<b>Баг 4 — экран модели в боте в манере обхода.</b> Список как CheckMenu: иконка на активной строке, <code>is on/is off</code>, подпись «source: … · N offered», кнопки <code>model:set:&lt;имя&gt;</code> по пять в ряд, «ask the backend again» и ручной ввод. Живые значения из <code>/v1/models</code>: <code>gw.models()</code>, <code>gw.models(True)</code>, <code>gw.set_model()</code>. Проверка: <code>tests/bot_selftest.py</code> — 14 экранов, 29 колбэков, все отвечают.

<b>Баг 5 — тексты без слопа.</b> Прошёл все строки расширения, бота, TUI и установщика: без «please note», «that is expected», канцелярита и смеси языков. Таблица «было → стало» — в <code>PR-DESCRIPTION.md</code>.

<b>Баг 6 — одна кнопка на действие.</b> Таблица кнопок снята с живого DOM: <code>evidence/b6-buttons.md</code>. Слито/удалено: второй путь к модели <code>ask AI</code> (целая функция <code>runAi</code>, ~60 строк) — остался один <code>/mse/v1/agent</code>; нижняя полоса агента больше не кнопка (действие уже есть строкой выше); название «AI» → «agent» везде; значение в аккаунте получило значок <code>copy</code> вместо неявного тапа; <code>AI gateway</code> → <code>open</code>. Проверка: <code>tests/b6_buttons.test.js</code> обходит все четыре экрана, вычисляет ключ действия и падает, если два элемента делают одно; отдельно — «check» ровно один, в шапке не больше двух кнопок.

<b>Баг 7 — установка и TUI спрашивают ключи.</b> Без терминала install.sh печатает точную команду с <code>MSE_BOT_TOKEN=…</code>, <code>MSE_OWNER_ID=…</code>, <code>MSE_TAILSCALE_KEY=…</code> и говорит, что спросить не может. С терминалом спрашивает все три с проверкой формата и тремя попытками. Порядок по журналу вызовов: файлы → <code>up</code> → <code>funnel</code> → <code>wait</code> → адрес в <code>MSE_PUBLIC_URL</code> → рестарт роутера последним. TUI на чистой машине перед установкой открывает «Model, Quota &amp; Keys», где пустые ключи помечены и обязательны. Проверка: <code>tests/install_dialog.py</code> — 28/28.

<b>Прогоны 2.4:</b> агент/модели 2/2, кнопки 2/2, роутер 9/9, шлюз 14/14, one-file 4/4, M1–M13 по одному 13/13, B1 2/2, B2/B3 2/2, состояние 24/24, туннель 10/10, инлайн зелёный, формат инлайна ok, установка 28/28, TUI 19/19, бот 14 экранов/29 колбэков, <code>audit --strict</code> 0 hits ×3 — и всё это ещё раз с нуля из архива после <code>npm install</code>. Версия 2.4.0, <code>mse.user.js</code> 2.4.0.

<b>Что осталось тебе (живой стенд):</b> настоящий tailnet и Telegram — за мной только код. Сценарий: <code>sudo mse</code> → Install, доставить <code>MSE-2.4-source.tar.gz</code>, открыть страницу попытки, нажать пилюлю «MSE», посмотреть строки базы и ответ агента, тапнуть по ответу и убедиться, что он встал в форму; затем <code>sudo mse</code> → Model, Quota &amp; Keys → «ask the backend again» и переключить модель тапом в боте.

<b>Ветка:</b> <code>release/2.4</code> (от <code>44affc2</code>), коммит <code>12666a1</code>.
<b>Чего не проверить здесь:</b> настоящий tailnet (нужен рабочий ключ и разрешённый Funnel) и живой Telegram. Полный прогон <code>mse.test.js</code> одним процессом падает по памяти песочницы (2 ГБ без swap) — каждый тест по отдельности зелёный.
"""


def token() -> str:
    return (os.environ.get("MSE_BOT_TOKEN") or os.environ.get("TELEGRAM_BOT_TOKEN") or "").strip()


def chat() -> str:
    return (os.environ.get("MSE_OWNER_ID") or os.environ.get("TELEGRAM_CHAT_ID") or "").strip()


def call(method: str, payload: dict | None = None, files: dict | None = None) -> dict:
    url = API % (token(), method)
    if not files:
        data = json.dumps(payload or {}).encode("utf-8")
        req = urllib.request.Request(url, data=data, headers={"content-type": "application/json"})
    else:
        boundary = "----mse" + uuid.uuid4().hex
        body = b""
        for key, value in (payload or {}).items():
            body += ("--%s\r\nContent-Disposition: form-data; name=\"%s\"\r\n\r\n%s\r\n"
                     % (boundary, key, value)).encode("utf-8")
        for key, path in files.items():
            path = Path(path)
            kind = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
            body += ("--%s\r\nContent-Disposition: form-data; name=\"%s\"; filename=\"%s\"\r\n"
                     "Content-Type: %s\r\n\r\n" % (boundary, key, path.name, kind)).encode("utf-8")
            body += path.read_bytes() + b"\r\n"
        body += ("--%s--\r\n" % boundary).encode("utf-8")
        req = urllib.request.Request(url, data=body,
                                     headers={"content-type": "multipart/form-data; boundary=" + boundary})
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return json.loads(resp.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as exc:
        return {"ok": False, "error": exc.read().decode("utf-8", "replace")[:400]}
    except (urllib.error.URLError, OSError) as exc:
        return {"ok": False, "error": str(exc)}


def send_text(text: str) -> bool:
    ok = True
    chunk = ""
    for para in text.split("\n\n"):
        if len(chunk) + len(para) + 2 > LIMIT:
            res = call("sendMessage", {"chat_id": chat(), "text": chunk, "parse_mode": "HTML",
                                       "disable_web_page_preview": True})
            ok = ok and bool(res.get("ok"))
            if not res.get("ok"):
                print("text failed:", res.get("error"), file=sys.stderr)
            chunk = para
        else:
            chunk = para if not chunk else chunk + "\n\n" + para
    if chunk:
        res = call("sendMessage", {"chat_id": chat(), "text": chunk, "parse_mode": "HTML",
                                   "disable_web_page_preview": True})
        ok = ok and bool(res.get("ok"))
        if not res.get("ok"):
            print("text failed:", res.get("error"), file=sys.stderr)
    return ok


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--text", action="store_true", help="the report only, no files")
    args = ap.parse_args()
    if not token() or not chat():
        print("set MSE_BOT_TOKEN (or TELEGRAM_BOT_TOKEN) and MSE_OWNER_ID (or TELEGRAM_CHAT_ID)", file=sys.stderr)
        return 2

    good = send_text(REPORT)
    print("report: " + ("sent" if good else "failed"))

    files = [OUT / "MSE-2.4-source.tar.gz", OUT / "MSE-release-2.4.bundle", ROOT / "PR-DESCRIPTION.md"]
    files += sorted((ROOT / "Storage" / "screenshots").glob("*-bw.png"))
    for path in files:
        if args.text or not path.exists():
            continue
        res = call("sendDocument", {"chat_id": chat(), "caption": path.name}, {"document": path})
        print(path.name + ": " + ("sent" if res.get("ok") else "failed " + str(res.get("error"))[:200]))
    return 0 if good else 1


if __name__ == "__main__":
    raise SystemExit(main())
