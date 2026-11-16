# MSE 2.4 — агент перестал быть прокси, модели приходят из бэкенда, кнопки по одной на действие

Ветка `release/2.4` (от `44affc2`, то есть от финала 2.3). Раунд про три вещи, которые владелец увидел на живом
стенде: каждая кнопка «ответ ИИ» уходила в `not found: /mse/v1/agent`, модель в коде была вписана руками, а в
панели расширения несколько кнопок делали одно и то же. Здесь каждый пункт закрыт **запуском**, а не чтением кода.

## Баг 1 (критический) — `/mse/v1/agent` обслуживает роутер, а не бэкенд

**Было.** `/mse/*` целиком уходил в прокси на `127.0.0.1:8799`, а у локального AI-бэкенда таких путей нет. Ответ
на каждый вопрос с вариантами:

```json
{"error":{"message":"not found: /mse/v1/agent","code":"agy_upstream"}}
```

и три ретрая подряд, все с тем же результатом.

**Стало.** `handleAgent` живёт в `Server/mse-router.js` и сам собирает запрос к локальному бэкенду — тем же
способом, что шлюз: `POST {upstream}/v1/chat/completions`, `temperature: 0`, таймаут из `CFG.timeoutMs`, ответ
разбирается и сверяется со списком `options`.

| код | когда | тело |
| --- | --- | --- |
| 401 | ключа нет среди устройств | `invalid_key` |
| 403 | устройство не `active` | `device_pending` / `device_revoked` |
| 429 | квота на сегодня кончилась | `rate_limited` + `retry-after` |
| 400 | нет `question` | `bad_request` |
| 503 | бэкенд не назвал ни одной модели | `no_model` |
| 502 | бэкенд не ответил / ответил мусором | `upstream_down` / `upstream_bad` |
| 200 | всё хорошо | `{ok:true, answer, confidence, reasoning, model}` |
| 200 | модель назвала вариант, которого нет в списке | `{ok:false, code:'agent_error'}` |

**Проверка.** `tests/agent_models.test.js`, тест «bug 1»: мок-бэкенд знает только `/v1/*`, роутер поднят
отдельным процессом, дальше `register → /admin/allow → POST /mse/v1/agent {question, options}`.
Утверждается: `ok:true`, `answer` — из предложенных вариантов, `model` назван; в мок **не пришёл ни один** путь
`/mse/*`; в промпте, который ушёл в бэкенд, есть все варианты; чужой вариант в ответе модели даёт `agent_error`
с текстом «not in the task»; незнакомый ключ получает 401 и до модели не доходит.

## Баг 2 — повтор кнопки = повтор запроса

Не баг: так и задумано. Ничего не менялось, дебаунс осознанные повторы не режет (он только склеивает двойной тап
по одному и тому же ответу).

## Баг 3 — ноль хардкода моделей

**Было.** `MSE_MODEL || 'gemini-3-flash'` в роутере, `MSE_MODELS` со списком в `install.sh`, дефолт в TUI,
`'gpt-4o-mini'` в `mse-server.js`, `model: 'mse'` в расширении.

**Стало.** Источник истины — локальный OpenAI-совместимый бэкенд.

- `refreshModels()`: `GET {upstream}/v1/models`, таймаут 8 с, результат в `CFG.models` и в `state.settings.models`
  (переживает рестарт, `modelsSource: 'state'`, когда бэкенд молчит).
- Роутер спрашивает при старте (`modelsReady`) и по кнопке: `POST /admin/models` — обновить,
  `GET /admin/models` — что в кэше. `GET /v1/models` роутера отдаёт список из бэкенда, `owned_by: 'backend'`.
- `MSE_MODEL` — только дефолт. Нет в списке → `console.error` + строка в журнал + авто-фолбэк на первую
  доступную модель бэкенда. Пусто → берётся первая.
- `/health` и `/admin/state` показывают `models`, `modelsCount`, `modelsSource`.
- Расширение о моделях не знает: в `chat()` имени модели больше нет, роутер решает сам.
- Бот: `gw.models()` / `gw.models(True)`, `gw.set_model(name)` (`POST /admin/model`, валидация против живого
  списка), выбор — в экране модели.
- TUI: дефолт модели больше не вписан — `MSE_MODEL` пустой, а `probe_backend()` уже читает `/v1/models`.
- `Server/stack/.env.example` — единственное место, где вообще упоминается дефолт (`MSE_MODEL=`).

**Проверка.** `tests/agent_models.test.js`, тест «bug 3»: бэкенд A отдаёт `alpha-1..3` → `/health.models` ровно
эти три, `modelsCount: 3`, `modelsSource: 'backend'`, дефолт из env заменён на первый доступный; бэкенд B отдаёт
`beta-9` → список стал `['beta-9']` **без правки кода**, а в логе строка «is not offered by the backend»;
`POST /admin/models` возвращает живой список. `tests/router.test.js` (9/9) — `MSE_MODELS` больше не читается,
список берётся у мока, `R9` сверяет его дословно. `grep` по репозиторию: `gemini|gpt-4o|deepseek` есть только в
тестах и моках.

## Баг 4 — экран модели в боте, в манере OBHOD

`BOT/screens.py:model_screen` — тот же CheckMenu-стиль, что в обходе: `table(rows, ("model of the backend", "now"))`,
иконка `ok` у активной строки, `code("is on"/"off")`, подпись `muted("source: … · N offered")`, кнопки
`model:set:<name>` по пять в ряд (не больше десяти), «ask the backend again» (`model:refresh`), ручной ввод
(`model:ask`), «back». Живое значение приходит из `/v1/models`, а не из константы:

- `client.py`: `models(refresh=False)` (GET, `refresh=True` → `POST /admin/models`), `set_model(name)`.
- `main.py`: `live_models()` (сначала роутер, потом фолбэк на `snap()["health"]["models"]`), `refresh_models()`,
  колбэк `model:refresh`, `set_model` пишет `MSE_MODEL` в env и перерисовывает экран.

**Проверка.** `tests/bot_selftest.py`: 14 экранов, 29 колбэков, все отвечают.

## Баг 5 — тексты без слопа

Прошёлся по всем строкам расширения, бота, TUI и установщика. Стиль телеграфный: без «please note», без
«this is expected», без канцелярита, без смеси языков в одной строке. Переписанные строки:

| где | было | стало |
| --- | --- | --- |
| `Extensions/src/debug.js` | `Sources: the page (M.cfg, profile links, avatar) and the server responses captured by the sniffer. The full list is on the “Who am I” tab.` | `Sources: the page · M.cfg, profile links, avatar. Server responses: the sniffer. Full list: “Who am I”.` |
| `Extensions/src/debug.js` | `Enter the key once on the “Key” tab and reload the page: it must stay. This checks that the extension remembers it.` | `Key entered on “Key”, page reloaded: it must survive. This checks that the script remembers it.` |
| `Extensions/src/debug.js` | `Requests made before the script was installed show up by timing only (no status codes) — that is expected.` | `Requests from before the script was installed carry timing only, no status.` |
| `Extensions/src/debug.js` | `Enter the key once. It is kept in the script storage and in the site localStorage, survives reloads and navigation. The check uses SHA-256: the key itself is never stored in the script — the server will work the same way.` | `The key lives in script storage and site localStorage, survives reloads and navigation. The check is SHA-256: the key itself never lands in the script.` |
| `Server/stack/mse_setup.py` | `Up/down — the row, Space — edit, Enter — save everything. Secrets are masked and never land in the shell history.` | `Up/down — row · Space — edit · Enter — save. Secrets are masked, never in the shell history.` |
| `Server/stack/mse_setup.py` | `Model name on the local backend (OpenAI-compatible)` | `model name on the local backend (OpenAI-compatible)` |
| `Extensions/src/mse-ui.js` | `AI: …` / строка-кнопка `agent: ask` | одна строка `ask the agent`, состояние — `agent is thinking…` / `agent is busy, retrying in N s` |
| `Extensions/src/mse-ui.js` | `ask AI`, `AI is thinking…`, `agent failed: …` | `ask the agent`, `agent is thinking…`, `agent: <причина>` |
| экран шлюза в расширении | блок `models` со списком имён чипами | списка нет: панель о моделях не знает, в журнале только «N models» |
| `tools/preview_rich.py` | демо-данные с реальными именами моделей | `demo-model-a`, `demo-model-b` |

## Баг 6 — одна кнопка на действие

Таблица снята **с живого DOM** (`tests/b6_buttons.test.js` пишет `evidence/b6-buttons.md`), экран за экраном:

| экран | кнопка | что делает | обработчик |
| --- | --- | --- | --- |
| все | `MSE2` (pill) | открыть/закрыть панель | `openPop` / `closePop` |
| все | `×` | закрыть панель | `closePop` |
| ответы | `i` | дверь в аккаунт | `state.route = 'account'` |
| аккаунт | `←` | назад к ответам | `state.route = 'answers'` |
| аккаунт | `ID` / `login` / `name` / `key` | скопировать значение (`copy` — значок, не отдельная кнопка) | `MSEBridge.copy` |
| аккаунт | `open` (AI gateway) | открыть экран шлюза | `state.route = 'gateway'` |
| ответы | строка ответа | вставить ответ в форму Moodle | `applyAnswer` |
| ответы | `ask the agent` / строка с ответом ИИ | спросить агента; повторный тап по готовому ответу — вставить его | `runAgent` |
| шлюз | `check` | проверить адрес и ключ | `checkGateway` |
| шлюз | `bind to my id` | привязать устройство (только при `unregistered`) | `MSEBridge.register` |
| журнал | `clear` | очистить журнал | `log = []` |

Что слито или удалено:

| было | стало |
| --- | --- |
| `ask AI` (стриминг через `/v1/chat/completions`) **и** строка агента `agent: ask` — два разных пути к одной модели | один путь: `/mse/v1/agent`; строка `ask the agent` — кнопка, нижняя полоса — только состояние (у неё больше нет `press`) |
| строка состояния агента была кнопкой с подписью `run` / `again` | не кнопка вовсе: действие уже есть выше, дубликат убран |
| пустая база: одна и та же модель вызывалась дважды (строка `ask AI` и авто-запуск агента) | авто-запуск один, повтор — осознанным тапом |
| `AI: …` в списке ответов и `agent: …` в полосе — два названия одного | везде `agent` |
| значение в аккаунте без указания, что оно копируется | значок `copy` прямо в строке, `disabled` для пустых |
| `AI gateway` как подпись ссылки в аккаунте | `open` (подпись — действие, а не имя экрана) |
| `runAi()` (целая вторая функция вызова модели, ~60 строк) | удалена |

**Проверка.** `tests/b6_buttons.test.js`: обходит `answers`/`account`/`gateway`/`net`, собирает все видимые
кнопки, вычисляет ключ действия и **падает**, если два элемента на одном экране дают одно действие; отдельно
проверяет, что «check» на шлюзе ровно один, что в шапке не больше двух кнопок (`i`/`←` и `×`), что
`ask the agent` не больше одной и что полосы состояния больше не кнопки.

## Баг 7 — установка и TUI спрашивают ключи

- `install.sh` (без терминала — печатает точные команды):

```
the bot token is required, and this shell cannot ask for it.
  run:  MSE_BOT_TOKEN=1234567890:AAH... MSE_OWNER_ID=<your id> MSE_TAILSCALE_KEY=tskey-auth-... bash install.sh --update --yes
```

- С терминалом спрашивает `bot token`, `owner telegram id`, `tailscale auth key` — с проверкой формата и тремя
  попытками на каждое.
- Порядок (проверен по журналу вызовов): файлы и права → `mse-tunnel.sh up` → `funnel` → `wait 200` → адрес в
  `MSE_PUBLIC_URL` → **последним** `systemctl restart mse-router.service`.
- TUI (`mse_setup.py`): на чистой машине перед установкой открывается экран `4 · Model, Quota & Keys`, где
  пустые `bot token` / `owner id` / `tailscale key` помечены `○` и обязательны.

**Проверка.** `tests/install_dialog.py` — 28 проверок: пайп печатает команды и «cannot ask»; pty спрашивает все три,
бракует `not-a-token` и `abc`, пишет значения в `mse.env` с режимом `600`, не светит их в командной строке;
по журналу `funnel < up < restart`, адрес `https://…` в `MSE_PUBLIC_URL`; панель на чистой коробке показывает все
три поля; `--dry-run` ничего не пишет.

## Отдельно: один и тот же список моделей для теста и для живого роутера

`Server/mse-router.js` как модуль раньше не спрашивал бэкенд о моделях — живой роутер спрашивал, тест нет.
Теперь спрашивает в обоих случаях (`modelsReady`), а `mock-upstream.js` умеет отдавать свой список
(`MSE_MOCK_MODELS`), чтобы тест мог проверить смену списка без правки кода.

## Проверки 2.4

| что | результат |
| --- | --- |
| `tests/agent_models.test.js` (баги 1 и 3) | 2/2 |
| `tests/b6_buttons.test.js` (баг 6) | 2/2 |
| `tests/router.test.js` | 9/9 |
| `tests/gateway.test.js` | 14/14 |
| `tests/onefile.test.js` | 4/4 |
| `tests/mse.test.js` M1–M13 | по одному, 13/13 |
| `tests/b1_address.test.js`, `tests/b2_b3_theme.test.js` | 2/2, 2/2 |
| `tests/state_persistence.py` | 24/24 |
| `tests/tunnel_test.sh` | 10/10 |
| `tests/install_dialog.py` | 28/28 |
| `tests/tui_smoke.py` | 19/19 |
| `tests/bot_selftest.py` | 14 экранов / 29 колбэков |
| `tests/inline_mode_check.py`, `tests/test_inline_format.py` | зелёные |
| `scripts/audit.py --strict` ×3 | 0 hits |

## Что осталось за рамками

- Версия в `package.json` / `mse-router.js` поднимается до 2.4.0 отдельным коммитом вместе с этим описанием.
- Живой стенд (реальные tailscale, бэкенд и Telegram) — за владельцем: что именно нажимать, в отчёте.
