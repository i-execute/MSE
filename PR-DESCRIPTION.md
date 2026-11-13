# MSE 2.0 — расширение с двумя уровнями доступа, шлюз-роутер, tailscale, TG-панель

Ветка: `release/2.0` → `main`. Один коммит «MSE 2.0» (история пересоздана чистой, секретов в ней нет).

## Что в этом PR

**Расширение (`Extensions/`)**

- Пилюля `MSE` на странице попытки: варианты ответов из базы, тап — и ответ в форме Moodle.
- Два уровня: без регистрации/до подтверждения — только база, к шлюзу **ни одного запроса**; после того как
  владелец пустил Moodle ID — строка **AI**, когда база пуста (растёт по мере ответа, тап ставит в форму).
- ID пользователя: `M.cfg.userid` → `data-userid` → ссылки профиля → скрытые поля → запомненное; если страница
  попытки не знает ID — один раз тянется `/my/`; неполный запрос не отправляется, панель называет, чего нет.

**Сервер (`Server/`)**

- `mse-router.js`: ключ устройства + allow-лист по Moodle ID, квота, журнал, прокси `/v1/*` на локальный
  AI-бэкенд (127.0.0.1:8799) со стримом. Ключ модели живёт только в бэкенде.
- tailscale вместо cloudflared: `stack/mse-tunnel.sh` (`install/up/funnel/serve/off/status/url/wait`).
- `stack/install.sh` → `/opt/mse`, `/etc/mse/mse.env` (600), `/var/lib/mse`, systemd; `Storage/get.sh` —
  одна строка установки. `stack/mse_setup.py` → `sudo mse`.
- Панель `sudo mse` — **порт установщика OBHOD** (`Storage/obhod_setup.py`): тот же движок (глифы `◆ ◉ ✔ ┃`,
  256-цветная тема, `panel/frame/pill/keycap`, `Menu`/`CheckMenu`/`FieldEditor`, `Spinner`, cbreak-сессия с
  `KeyReader`, баннер с badge-строкой, шаги и живой прогресс). Своих меню с цифрами больше нет; флаги, как и в
  OBHOD, не поддерживаются — только `--status`/`--version` для скриптов и CI.
- `bot/`: goygram-панель — заявки, `/allow`, `/approve`, `/revoke`, `/disallow`, квота, модель, журнал, funnel.

**Репозиторий**

- Структура: `Server/ · Extensions/{iOS,Android,Desktop} · Storage/ · scripts/ · tests/ · .github/`.
- `scripts/audit.py --strict` — сканер отпечатков (токены, адреса, чужие пути, живые хосты), обязательный шаг CI.
- `.gitignore`: состояние шлюза, токены, env, node_modules, архивы, сгенерированные ключи.

## Аудит отпечатков: 3 прогона (как просили)

| № | когда | дерево | результат | лог |
|---|---|---|---|---|
| 1 | до чистки | исходное рабочее дерево (171 файл) | **68 hits**: 47 e-mail, 14 хостов, 7 «IP» | `audit-logs/1-before.log` |
| 2 | после чистки Части 0 | то же дерево, отпечатки убраны | **0 hits** | `audit-logs/2-after-cleanup.log` |
| 3 | после реструктуризации | новый репозиторий `MSE/` (61 файл) | **0 hits**, `--strict` exit 0 | `audit-logs/3-after-restructure.log` |
| 4 | после замены панели на порт OBHOD | тот же репозиторий (59 файлов) | **0 hits**, `--strict` exit 0 | `audit-logs/4-after-tui.log` |

Что убрано по Части 0: реальные ФИО и Moodle ID (в примерах теперь `12345` / `Test User`), адреса вузов
(реальный хост вуза → `moodle.example.edu`), путь личного каталога инструмента, `trycloudflare` из подсказки адреса,
PEM-ключ теста (теперь генерируется `scripts/make-test-cert.sh` и в git не попадает). Осталось сознательно:
адрес их базы ответов (`syncshare.ru`) — без него код необъясним, и публичный демо-сайт moodle.org для
живого теста.

## Приёмки (все зелёные, прогон в этой ветке)

| что | команда | итог |
|---|---|---|
| роутер | `node --test tests/router.test.js` | R1–R9, 9/9 |
| шлюз 1.0.0 | `node --test tests/gateway.test.js` | G1–G14, 14/14 |
| расширение (WebKit, iPhone) | `SS_BROWSER=webkit node --test tests/mse.test.js` | M1–M13, 13/13 |
| бот | `python3 tests/bot_selftest.py` | 15/15 |
| установка | `bash Server/stack/install.sh --dry-run` (3×) | exit 0, `Server/` найдена из любой точки дерева |
| панель `sudo mse` | `python3 tests/tui_smoke.py` (гоняет pty) | **19/19**: баннер, badge-строка router/backend/tunnel/bot, 9 пунктов меню, arrow+Enter открывают экран настроек, Custom → пути, Full Wipe → подтверждение, `--status` без tty, флаги отвергаются |
| панель без tty | `python3 Server/stack/mse_setup.py --status` | таблица здоровья стека, exit 0 когда всё up |
| роутер живьём | `node Server/mse-router.js` + `curl /health` | `{"name":"MSE gateway","role":"router","backend":"tailscale"}` |
| аудит | `python3 scripts/audit.py --strict` | 0 hits |

## Что поменялось в установке после живой проверки

Живая установка на машине владельца падала на `apt-get update`: сторонний репозиторий
(`packagecloud.io/ookla/speedtest-cli`) отдаёт `404 Release` на noble, apt выходит с ошибкой, и установщик
сдавался со словами «поставьте tailscale вручную». Теперь:

- `apt_get_update` терпимый: ошибки чужих репозиториев только печатаются, установка продолжается;
- tailscale ставится пакетом из официального репозитория с **изолированным `sourcelist`**
  (`-o Dir::Etc::sourcelist=…/tailscale.list -o Dir::Etc::sourceparts=-`), поэтому сломанное зеркало Ookla
  на него не влияет; если пакет всё равно не встал — стек поднимается без туннеля, а панель пишет, чего не хватает;
- `--dry-run` больше не пытается клонировать GitHub: берёт дерево, из которого запущен скрипт, — поэтому
  preview честный (9 строк `[dry]`, exit 0, трижды).

## Решение по `mse.user.js` (1.5 МБ)

Пушим целиком, но **только в `Storage/artifacts/`** — это готовый артефакт, который ставят клиенты, и CI гоняет
по нему тот же аудит (в собранном файле проверяются наши правила: токены, адреса, чужие пути). При этом
**вендорская сборка-оригинал в репозиторий не попадает**: `Extensions/build/build.sh` берёт её путь из
`MSE_VENDOR_DIR`, и без него честно объясняет, что нужно.

## Как проверить локально

```bash
python3 scripts/audit.py --strict
node --test tests/router.test.js tests/gateway.test.js
python3 tests/bot_selftest.py
npm i && npx playwright install --with-deps webkit
SS_BROWSER=webkit node --test --test-concurrency=1 tests/mse.test.js
```
