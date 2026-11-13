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
  одна строка установки. `stack/tui.py` → `sudo mse`.
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
| TUI | `python3 Server/stack/tui.py --once` | панель печатается, все строки со статусом |
| роутер живьём | `node Server/mse-router.js` + `curl /health` | `{"name":"MSE gateway","role":"router","backend":"tailscale"}` |
| аудит | `python3 scripts/audit.py --strict` | 0 hits |

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
