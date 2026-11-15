<div align="center">

# MSE

**Панель ответов для Moodle: пилюля на странице, ответы из базы и от своей модели.**
Расширение-юзерскрипт + шлюз, который живёт на вашей машине и снаружи виден только через tailscale.

`userscript` · `node` · `python` · `tailscale` · `systemd`

</div>

## Что это

MSE — две части, которые работают вместе:

| часть | что делает | где лежит |
|---|---|---|
| **Расширение** | маленькая пилюля `MSE` на странице попытки Moodle: варианты ответов из общей базы, тап — и ответ в форме. Интерфейс расширения — на английском, в светлых голубых тонах | `Extensions/` |
| **Шлюз** | принимает запросы снаружи, решает кому можно (ключ устройства + allow-лист по Moodle ID), считает квоту и проксирует на локальный AI-бэкенд | `Server/` |

Ключ модели живёт только в AI-бэкенде на вашей машине. В расширении и в шлюзе его нет.

## Клиенты

| клиент | как ставится | инструкция |
|---|---|---|
| **iOS / iPadOS / macOS** | Stay for Safari → файл `mse.user.js` | [`Extensions/iOS`](Extensions/iOS/README.md) |
| **Android** | Kiwi (расширения) или Firefox + Violentmonkey | [`Extensions/Android`](Extensions/Android/README.md) |
| **Desktop** | Tampermonkey в Chrome / Edge / Brave | [`Extensions/Desktop`](Extensions/Desktop/README.md) |

Один и тот же файл `Storage/artifacts/mse.user.js` — для всех трёх.

## Установка сервера

```bash
curl -fsSL https://raw.githubusercontent.com/i-execute/MSE/main/Storage/get.sh | sudo bash
```

Скрипт ставит:

```
/opt/mse/            код (роутер, бот, панель, туннель)
/etc/mse/mse.env     настройки, права 600
/var/lib/mse/        состояние: устройства, allow-лист, журнал
systemd              mse-router.service, mse-bot.service
sudo mse             панель управления (меню, экраны, живые проверки)
```

Установщик не требует ни одного флага и сам решает всё, что можно решить:
ставит недостающие пакеты (node, python3, git, curl, tailscale), сам вызывает `sudo`, если его не было,
а как только в настройках есть ключ tailscale — сразу поднимает узел и включает funnel.

Полностью без вопросов, одним заходом (как в обходе: вставил значения — и установка пошла):

```bash
MSE_BOT_TOKEN=123456:ABC-DEF \
MSE_OWNER_ID=12345 \
MSE_API_ID=1234567 MSE_API_HASH=0123456789abcdef0123456789abcdef \
MSE_TAILSCALE_KEY=tskey-auth-… \
  curl -fsSL https://raw.githubusercontent.com/i-execute/MSE/main/Storage/get.sh | bash
```

**Токен бота обязателен.** Без него бот не запускается, поэтому установщик спрашивает его сам (шаг
«the bot token is required», до трёх попыток, формат `1234567890:AAH...` проверяется). Если команда запущена без
терминала (`curl | bash`), установщик не молчит, а пишет точную строку:

```bash
MSE_BOT_TOKEN=1234567890:AAH... bash install.sh        # всё остальное встанет, бот — с токеном
```

Токен берётся у [@BotFather](https://t.me/BotFather): `/newbot` или `/token`. Добавить позже тоже можно:
`sudo mse` → Model, Quota & Keys → bot token, или кнопка **bot token** в конфиге бота.

`MSE_API_ID` и `MSE_API_HASH` (my.telegram.org → App) — необязательные: боту достаточно токена, они нужны
только для MTProto-транспорта. Всё это можно ввести и потом, в панели.

Дальше:

```bash
sudo mse                          # панель: Health, Install/Self-Heal, Services, Tunnel, Model & Keys, Uninstall
sudo mse update                   # обновить код и зависимости, не трогая устройства и allow-лист
sudo mse --status                 # то же без вопросов: таблица здоровья (для скриптов)
curl -s localhost:8788/health     # что шлюз о себе думает
```

Панель — порт установщика [OBHOD](https://github.com/i-execute/OBHOD): стрелки двигают выбор, Space отмечает,
Enter выполняет; флагов нет, всё делается в меню. Работа показывается спиннером, а не блоками заливки: шаг — это
галочка, название и короткая линейка. Тема — светлый ненасыщенный голубой по синему фону,
сами экраны и все сообщения — на английском.

Бот сам сообщает о новых заявках: человек постучался → в Telegram приходит Rich-карточка «кто, какой Moodle ID»
с кнопками `allow` / `decline`. Заявка выдаётся один раз, повторов нет.

Бот устроен так же, как панель [OBHOD](https://github.com/i-execute/OBHOD): экран — это объект `Rich`, который
уходит через `send_rich`/`edit_rich`, поэтому Telegram рисует заголовки, таблицы и ряд кнопок. Кнопки на месте:
люди и заявки, модель, квота, tailscale (up / funnel / serve / off), сервисы (restart / stop / start), журнал,
конфиг, обновление, refresh. Никаких `<mark>`-заливок: состояние — это иконка и цветные слова.

**Ввод значений — инлайн, как в обходе.** Кнопка открывает поле сообщения, в котором уже стоит короткий запрос с
подписанным токеном (10 символов, HMAC); владелец дописывает значение, видит его живым результатом и тапает —
значение применяется. Так вводится новый ключ tailscale, токен бота, owner id, Moodle ID человека (разрешить или
отозвать), модель и квота. Значение не попадает в чат, а сообщение-маркер после применения удаляется.

**Эмодзи-пак выключен по умолчанию.** Набор `tgiosicons` (тот же, что в обходе) — это кастомные эмодзи: включить
можно на экране конфига (`emoji pack`) или `MSE_EMOJI=1` в `/etc/mse/mse.env`. Пока выключено, рисуются обычные
юникод-заменители, так что экран читается на любом клиенте.

При старте бот проверяет себя и говорит, чего не хватает: пустой `MSE_ADMIN_TOKEN`, роутер не отвечает, нет
owner id, нет токена бота или ключа tailscale — это видно в журнале и одной строкой на панели. Проверить, как всё
выглядит, можно одной командой: `python3 tools/preview_rich.py` пришлёт все 14 экранов в личку
(`--out screens.html` — без Telegram, `--emoji` — с паком).

## Архитектура

```
iPhone / Android / Desktop
        │  https  (tailscale funnel, стабильный адрес)
        ▼
  <host>.<tailnet>.ts.net
        │  127.0.0.1:8788
  mse-router.js ──── ключ устройства, allow-лист по Moodle ID, квота, журнал
        │  127.0.0.1:8799 (только loopback)
  AI-бэкенд (OpenAI-совместимый; здесь и только здесь — ключ модели)
```

Роутер ничего не знает про модели и их ключи: он проверяет, кому можно, и стримит ответ как есть.
Telegram-бот (`Server/bot`) — та же админка шлюза, но в чате: заявки устройств, `/allow`, `/revoke`, квота,
модель, журнал, включение funnel.

## Приёмка (curl)

```bash
curl -s localhost:8788/health | jq '{name,version,role,backend,model,quota}'
# → {"name":"MSE gateway","version":"2.0.0","role":"router","backend":"tailscale",…}

KEY=mse_$(openssl rand -hex 32)
curl -s -X POST localhost:8788/mse/v1/register -H 'content-type: application/json' \
  -d "{\"key\":\"$KEY\",\"moodleId\":\"12345\",\"name\":\"Test User\"}" | jq '.device.status'
# → "pending"

curl -s -o /dev/null -w '%{http_code}\n' localhost:8788/v1/chat/completions \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"hi"}]}'
# → 403  (никто не пустил — модель недоступна)

TOKEN=$(grep '^MSE_ADMIN_TOKEN=' /etc/mse/mse.env | cut -d= -f2)
curl -s -X POST localhost:8788/admin/allow -H "x-admin-token: $TOKEN" \
  -H 'content-type: application/json' -d '{"moodleId":"12345"}' | jq '.allow'

curl -s localhost:8788/v1/chat/completions -H "authorization: Bearer $KEY" \
  -H 'content-type: application/json' -d '{"stream":true,"messages":[{"role":"user","content":"hi"}]}' | head -3
# → data: {"choices":[{"delta":{"content":"…"}}]} …
```

## Разработка

```bash
npm i                      # acorn, playwright — для сборки и тестов расширения
python3 scripts/audit.py --strict      # «ноль отпечатков», это же гоняет CI
node --test tests/gateway.test.js tests/router.test.js
python3 tests/bot_selftest.py
SS_BROWSER=webkit node --test --test-concurrency=1 tests/mse.test.js
bash Extensions/tools/build.sh         # → Storage/artifacts/mse.user.js
```

Сборка userscript-а требует вендорскую папку исходной сборки (её нет в репозитории):

```bash
MSE_VENDOR_DIR=/path/to/syncshare-<ver> bash Extensions/tools/build.sh
```

## Структура

```
Server/          роутер, бот, панель (mse_setup.py), туннель, установка, гайд агента
Extensions/      iOS · Android · Desktop (инструкции) + src/ (наш слой) + tools/ (сборка)
Storage/         get.sh, релизные артефакты, суммы оригиналов
scripts/         audit.py (ноль отпечатков)
tests/           роутер, шлюз, расширение (WebKit), бот
.github/         CI: audit + тесты
```

## Лицензия

См. [`LICENSE`](LICENSE).
