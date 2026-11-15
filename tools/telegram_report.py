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

REPORT = """<b>MSE 2.3 — сервер и расширение переделаны, всё проверено запуском</b>

<b>A1/A2 — установка сама поднимает туннель и ЖДЁТ внешний https.</b> Было: tailscale не залогинен, url null, а снаружи <code>SSL routines::unexpected eof</code>. Теперь <code>mse-tunnel.sh wait --timeout 60</code> (повтор на eof/handshake/сертификат, понятная причина отказа) вызывается после <code>funnel</code> и до рестарта роутера, а адрес после ожидания принимается только если он <code>https://…</code>. Проверка запуском: <code>tests/tunnel_test.sh</code> — 10/10 (локальный TLS-сервер, отказ в бюджете, порядок строк install.sh).

<b>A3/A4 — один каталог данных.</b> Было <code>state not saved: ENOENT mkdir /opt/mse/data</code> и vault в <code>/opt/mse</code>. Теперь <code>/var/lib/mse</code> (режим 700, создаётся до старта юнитов): state.json, admin-token.txt и vault goygram. По ходу нашёлся и починен настоящий баг потери настроек — квота из панели не попадала в состояние и рестарт её откатывал. Проверка: <code>tests/state_persistence.py</code> на настоящем роутере — 24/24 (создал каталог сам, три цикла старт/стоп/старт, «обновление» сносит код и данные на месте).

<b>A5 — инлайн проверяется при старте.</b> <code>check_inline_mode()</code>: off → строка в журнал, одно сообщение тебе в чат, то же в self_check и на панели; сервер молчит → тревоги нет. <code>tests/inline_mode_check.py</code> — 16/16.

<b>B1 — новый адрес заменяет старый во всех хранилищах.</b> Новый адрес пишется в оба хранилища, затем сканируются все ключи, похожие на адрес (localStorage сайта, хранилище расширения через рантайм, зеркало, старый ключ), и всё чужое удаляется; сохраняется только ПРОВЕРЕННЫЙ адрес, а список вычищенного уходит строкой в журнал панели. Проверка: <code>tests/b1_address.test.js</code> — 2/2 против двух настоящих https-шлюзов со счётчиками: старый не получает ни одного запроса, после перезагрузки старого нет нигде.

<b>B2 — воздух.</b> 8 px между строками, паддинги внутри строк, именованные группы (address/connection/answer, account/this device, journal), шапка в две строки вместо стены текста, ширина панели от реального вьюпорта и всегда внутри экрана (это нашлось на скриншоте — панель вылезала за правый край). Проверка: <code>tests/b2_b3_theme.test.js</code> измеряет всё это на живой панели.

<b>B3 — строго ч/б.</b> Один файл темы <code>Extensions/src/theme.css</code> вставляется сборкой (второй копии нет, старая палитра удалена): бумага #0a0a0a, чернила #f2f2f2, единственный акцент — белая рамка выбранной строки, свечение только на буквах «MSE», системный шрифт. Ключ устройства на экране аккаунта теперь замаскирован. Проверка: тест обходит ВСЕ элементы всех четырёх экранов и требует ни одного цветного значения; скриншоты в <code>Storage/screenshots/</code> (приложены).

<b>Прогоны:</b> расширение M1–M13 13/13, one-file 4/4, B1 2/2, B2/B3 2/2, роутер 9/9, шлюз 14/14, состояние 24/24, туннель 10/10, инлайн 16/16, бот 14 экранов/28 callback, формат инлайна ok, установка 24/24, TUI 19/19, <code>audit --strict</code> 0 hits ×3 — и всё это ещё раз с нуля из архива после свежего <code>npm install</code>.

<b>Ветка:</b> <code>release/2.3</code> (от <code>release/2.2</code>), коммиты <code>37d4b6e</code>, <code>a683d8f</code>, <code>a76e850</code>.
<b>Не проверено живьём:</b> настоящий tailnet (нужен рабочий ключ tailscale и разрешённый Funnel) и реальный Telegram — всё остальное шло настоящим кодом. Прогон всего mse.test.js одним процессом падает по памяти песочницы (2 ГБ без swap) — каждый тест по отдельности зелёный.
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

    files = [OUT / "MSE-2.3-source.tar.gz", OUT / "MSE-release-2.3.bundle", ROOT / "PR-DESCRIPTION.md"]
    files += sorted((ROOT / "Storage" / "screenshots").glob("*-bw.png"))
    for path in files:
        if args.text or not path.exists():
            continue
        res = call("sendDocument", {"chat_id": chat(), "caption": path.name}, {"document": path})
        print(path.name + ": " + ("sent" if res.get("ok") else "failed " + str(res.get("error"))[:200]))
    return 0 if good else 1


if __name__ == "__main__":
    raise SystemExit(main())
