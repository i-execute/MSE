# MSE 2.2 — инлайн работает, iOS одним файлом, установка сама спрашивает ключи и поднимает туннель

Ветка `release/2.2`. Владелец прогнал 2.1 вживую и нашёл пять багов; здесь каждый починен и проверен запуском.

## Что было и что починено

### Баг 1 — инлайн-режим бота не работал вообще

**Было.** Живой лог: `messages.setInlineBotResults:results: nested object missing _` на каждый inline-запрос.
Причина: `Server/bot/inline.py` собирал результаты в формате **Bot API** (`input_message_content`), а goygram
отправляет инлайн по **MTProto**, где в каждом вложенном объекте должен стоять конструктор в поле `_`.

**Стало.** `article()` собирает `{"_": "inputBotInlineResult", …, "send_message": {"_": "inputBotInlineMessageText",
"no_webpage": True, "message": …}}` — ровно как `BOT/inline.py` в OBHOD (ветка `src == "mt"`). Bot API-вариант
остался отдельной веткой для клиента без MTProto.

**Проверка.** `tests/test_inline_format.py` собирает реальные результаты и прогоняет их через **настоящий**
`goygram.types.obj.Obj.answer()` с подменённым `mt_req`: перехватывается точный payload
`messages.setInlineBotResults`, и каждый вложенный объект обходится рекурсивно — 32 проверки, все зелёные.
Плюс `tools/live_inline_check.py` спрашивает Telegram про сам бот.

### Баг 2 — проверки inline при старте не было

**Стало.** `Bot.check_inline_mode()` (как `check_inline_mode()` в OBHOD): `getMe(refresh=True)` →
`supports_inline_queries`, запасной признак — `bot_inline_placeholder`, затем сырой `getMe`. Три состояния:
`True`, `False`, `None` («не смог определить» — без ложных тревог). Если `False`:
- в журнал и stderr одна строка `INLINE_WARN`,
- владельцу в чат **одна понятная строка**: «turn it on in @BotFather → Bot Settings → Inline Mode»,
- эта же строка появляется в `self_check()` и на панели в блоке «check these first».

**Проверка.** В `tests/test_inline_format.py` — пять сценариев probe (включён / выключен / placeholder / без флага /
сеть упала) и проверка, что владельцу уходит ровно одна строка и она попадает в `self_check()`.
Живой прогон: `check_inline_mode -> False`, `owner told` (у тестового бота инлайн действительно выключен).

### Баг 3 — iOS собирался как пять отдельных скриптов

**Было.** Оболочка собиралась в один файл, но рантайм создавал **четыре лишних `<script>`** в рантайме
(интерфейс, авторизация, мост, отладчик). На Stay это ломкий путь: теги транзитные, CSP страницы может их выкинуть,
и пользователь остаётся без панели.

**Стало.** Все четыре части лежат в том же файле четырьмя изолированными блоками `;(function(){…})()`, каждый со
своей областью (свои хелперы не текут), работают в одном скрипте — **одна вставка, как в 0.2**. Сборка сама
защищает инвариант: падает, если наш код создаёт `<script>`, если в файле больше одного userscript-заголовка или
есть `@require`/`@resource`.

**Проверка.** `build-report.json → oneFile {scripts: 1, headers: 1, requires: 0}`; новый `tests/onefile.test.js`
(4 теста: один заголовок, нет динамической инъекции наших частей, все части на месте, отчёт честный);
`tests/mse.test.js` 13/13 — панель, пилюля, ответы, AI-строка работают на собранном файле.

### Баг 4 — интерактивный first-run

**Стало.** `install.sh` спрашивает три обязательных значения в одном диалоге: bot token (формат
`1234567890:AAH...`, три попытки), owner telegram id (число), tailscale auth key (`tskey-auth-...`). Каждое
валидируется, всё пишется в `/etc/mse/mse.env` (0600), затем стартуют сервисы. Уже заданные значения (env или
конфиг) не переспрашиваются.

**Пайп.** Нет терминала — нет вопросов: печатаются **точные команды** (`MSE_BOT_TOKEN=… MSE_OWNER_ID=…
MSE_TAILSCALE_KEY=… bash install.sh --update --yes`), плюс откуда взять owner id (`@userinfobot`) и ключ
tailscale (`login.tailscale.com/admin/settings/keys`), и установка продолжается без них.

**TUI.** «Install / Self-Heal» передаёт установщику `MSE_BOT_TOKEN`, `MSE_OWNER_ID`, `MSE_TAILSCALE_KEY`,
`MSE_API_ID/HASH`, модель, квоту, порт бэкенда (`Setup.installer_env()`), а перед запуском пишет, что всё ещё
будет спрошено (`Setup.missing_keys()`).

**Проверка.** `tests/install_dialog.py` — три прогона установщика в песочнице (`PREFIX/ENV_DIR/STATE_DIR/UNIT_DIR`
во `/tmp`, поддельные `systemctl`/`curl`/`tailscale`/`mse-tunnel.sh` с логом вызовов): пайп (24 проверки),
pty-прогон с реальным вводом (три попытки, отказ на мусоре, значения в файле, режим 0600), порядок вызовов,
dry-run. 24/24.

### Баг 5 — туннель не поднимался сам

**Стало.** Порядок стал явным: `install → setup_tunnel (up + funnel) → env_set MSE_PUBLIC_URL →
restart_router_after_tunnel → final_report`. Роутер больше не остаётся с пустым адресом: рестарт идёт **после**
появления URL, потом `/health` подтверждается. В конце установщик печатает состояние: `mse-router: active`,
`mse-bot: active`, есть ли адрес в `mse-tunnel.sh status --json`.

**Проверка.** Тот же `tests/install_dialog.py`: по логу вызовов `mse-tunnel up` → `funnel` →
`systemctl restart mse-router` (рестарт позже funnel), `MSE_PUBLIC_URL` в конфиге начинается с `https://`,
`/health` подтверждён, `mse-bot: active`.

## Что не трогал

- Архитектура роутера/бэкенда та же, ключи модели живут только в бэкенде.
- Безопасность не ослаблена: sha256 ключей устройств, allow-list по Moodle ID, квоты — как были.
- В `main` не пушил: всё в `release/2.2`.

## Как проверить вживую

```bash
# 1. инлайн у бота: сначала включи inline в @BotFather (/mybots -> Bot Settings -> Inline Mode)
MSE_BOT_TOKEN=... python3 tools/live_inline_check.py      # supports_inline_queries: True
# затем в чате с ботом: /config -> tailscale key -> в поле появится токен -> дописать ключ -> тап
# значение применится, сообщение-маркер удалится

# 2. iOS одним файлом
bash Extensions/tools/build.sh          # Storage/artifacts/mse.user.js, в отчёте oneFile.scripts = 1
node --test tests/onefile.test.js
# Stay -> + -> Install from file: один файл, одно поле

# 3. установка
curl -fsSL .../Storage/get.sh | bash    # спросит токен, owner id, tailscale key; поднимет туннель
curl -s localhost:8788/health           # version 2.2.0 и publicUrl не пустой
systemctl is-active mse-router mse-bot
```

## Тесты

| что | как | результат |
|---|---|---|
| расширение | `SS_BROWSER=webkit node --test --test-concurrency=1 tests/mse.test.js` | 13/13 |
| один файл | `node --test tests/onefile.test.js` | 4/4 |
| роутер | `node --test tests/router.test.js` | 9/9 |
| шлюз | `node --test tests/gateway.test.js` | 14/14 |
| TUI | `python3 tests/tui_smoke.py` | 19/19 |
| бот | `python3 tests/bot_selftest.py` | 14 экранов / 28 кнопок |
| формат инлайна | `python3 tests/test_inline_format.py` | 32/32 |
| установка | `python3 tests/install_dialog.py` | 24/24 |
| отпечатки | `python3 scripts/audit.py --strict` ×3 | 0 hits (81 файл) |

Логи всех прогонов — в `evidence/`.

## Не проверено вживую (и почему)

- **Тап по инлайн-результату в настоящем Telegram.** Нужен вход в аккаунт по MTProto (`MSE_API_ID/HASH` и
  сессия), которых в этой среде нет; `messages.setInlineBotResults` — не bot-api метод. Формат проверен тем, что
  payload уходит через **настоящий** код goygram (`Obj.answer`), и каждый вложенный объект имеет `_`.
  У тестового бота инлайн сейчас **выключен** — это видно живьём, и бот теперь честно об этом пишет.
- **Полная установка на реальный сервер с настоящим tailscale.** Прогон шёл в песочнице с поддельными
  `systemctl/curl/tailscale/mse-tunnel.sh`: проверен порядок, диалог, запись конфига, ожидание `/health`.
  Сам tailnet-логин требует реального ключа владельца.
- **Stay на iPhone.** Сборка проверена тестами и браузерным эмулятором Stay (webkit); установка файла в само
  приложение — за владельцем.
