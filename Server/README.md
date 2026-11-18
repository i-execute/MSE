# MSE router

The OpenAI-compatible gateway behind the MSE extension: a device key on the client, an allow list by Moodle id,
quotas, streaming, a log. The outside world reaches it only through tailscale.

```bash
# Load the installer's settings before starting the router by hand.
set -a; . /etc/mse/mse.env; set +a
node mse-router.js
```

Health check: `curl -s http://127.0.0.1:$MSE_PORT/health` → `"role":"router"`.

Allow a person by id:

```bash
curl -X POST http://127.0.0.1:$MSE_PORT/admin/allow \
  -H "x-admin-token: $MSE_ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"moodleId":"12345"}'
```

A fresh install selects distinct available loopback ports and saves them in `mse.env`; updates retain them.
The OpenAI-compatible backend is separate from this repository and must itself listen on `MSE_UPSTREAM_PORT`.
The bind probe cannot reserve a port until services start, so another process could claim it in between.

A new application is queued (`/admin/applications`), and the bot drains that queue to ping the owner in Telegram.

Flags: none of this is meant to be typed by hand on a fresh machine — `Storage/get.sh` installs everything and
`sudo mse` is the panel. The full brief for an agent that brings it up is in `AGENT-TASK.md`.

`mse-server.js` is the older 1.0 gateway (no proxying); the tests keep it working as a reference.


## Диагностика 2.6

POST `/mse/v1/dump` требует активный ключ устройства. Квота — 50 дампов в сутки на устройство; результат до 256 KiB, большие снимки усечены с `truncated`. Данные лежат в `$MSE_DATA_DIR/dumps` (на установке `/var/lib/mse/dumps`, при ручном запуске `~/.local/share/mse/dumps`; каталог 0700, файлы 0600), сохраняется до 100. Список и чтение доступны только через админ API, бот уведомляет владельца и выдаёт файл. Дампы не помещать в git.

Регистрация нового ключа всегда ожидает отдельного решения владельца; существующая привязка ключа к ID неизменна. Первая заявка содержит Moodle ID, заявленный клиентом: это не криптографическое подтверждение с сервера Moodle, владелец должен проверять заявку перед одобрением.

Удаляются известные секретные поля, видимые cookie и значения скрытых/парольных полей; произвольные секреты в текстах и HTML невозможно гарантированно распознать автоматически. Дампы могут содержать личные данные.

## AI backend (AI_PROXY, SOCKS5 & Geo-block)

Для подключения к AI-бэкендам (Google Antigravity, OpenAI, Claude и др.):
* `AI_PROXY` — параметр SOCKS5 прокси для AI-бэкенда (формат: `socks5://<host>:<port>`, например `socks5://127.0.0.1:1080`).
* По умолчанию: пусто (прямое соединение).
* Датацентровые IP провайдеров (например, Google) могут блокироваться с ошибкой `User location is not supported` — в таком случае требуется указать `AI_PROXY`.
* Проверка geo-блока: проверка ответа модели напрямую и через SOCKS5 (`curl --socks5-hostname <host>:<port> ...`).
* Память про ШТАММ: python-хелпер бэкенда использует PySocks (пакет `pysocks` в venv) и требует IPv4-only getaddrinfo (PySocks не поддерживает IPv6).
