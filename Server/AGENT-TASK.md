# AGENT-TASK — MSE 2.0: доступ по уровням, AI-мост, tailscale вместо Cloudflare, TG-панель

Документ для агента (и для владельца): что построено, как это проверить вживую и что осталось на следующий этап.
Версия расширения — `2.0.0`; фикс Moodle ID из полевого отчёта (0.2 → 0.4) входит сюда же.

---

## 1. Что уже сделано и принято тестами

| часть | файл | приёмка |
|---|---|---|
| фикс «нет данных страницы: ID» | `src/mse-ui.js` — `identity()`, `learnFromCabinet()`, `withIdentity()` | M12 |
| уровни доступа + AI-фолбэк | `src/mse-ui.js` — `refreshTier()`, `runAi()`, `appendAi()`, `load()` | M13 |
| роутер 2.0 (прокси на локальный бэкенд) | `server-mse/mse-router.js` | R1–R9 |
| шлюз 1.0.0 (прежний, без прокси) | `server-mse/mse-server.js` | G1–G14 |
| tailscale вместо cloudflared | `server-mse/stack/mse-tunnel.sh` | `mse-tunnel.sh status --json` |
| установка «как OBHOD» | `server-mse/stack/install.sh` | `bash install.sh --dry-run` |
| TUI `sudo mse` | `server-mse/stack/tui.py` | `python3 tui.py --once` |
| TG-панель (goygram) | `server-mse/bot/{main,ui,client}.py` | `python3 tests/bot_selftest.py` (15/15) |

## 2. Архитектура (главное)

```
iPhone (tailscale) ──https──▶ <host>.<tailnet>.ts.net   [tailscale funnel, стабильный адрес]
                                    │ 127.0.0.1:8788
                              mse-router.js   ← доступ по ключу устройства + allow-лист по Moodle ID, квота, журнал
                                    │ 127.0.0.1:8799 (только loopback)
                              AI-бэкенд (agy-upstream.js / OpenAI-совместимый)  ← модель и её ключ живут ТОЛЬКО здесь
```

Роутер ничего не знает про ключи моделей: он принимает запрос с внешнего туннеля и проксирует его на локальный
порт. Клиент (iPhone) видит только адрес туннеля и свой ключ `mse_…`.

## 3. Приёмка вживую (curl)

```bash
# 1. шлюз жив и говорит, что он роутер за tailscale
curl -s localhost:8788/health | jq '{name,version,role,backend,publicUrl,model,quota}'
# → {"name":"MSE gateway","version":"2.0.0","role":"router","backend":"tailscale",…}

# 2. заявка устройства (так делает расширение)
KEY=mse_$(openssl rand -hex 32)
curl -s -X POST localhost:8788/mse/v1/register -H 'content-type: application/json' \
  -d "{\"key\":\"$KEY\",\"moodleId\":\"12345\",\"name\":\"Test User\"}" | jq '.device.status'
# → "pending"   (и ключ пока не значит ничего)

# 3. без разрешения владельца модель недоступна
curl -s -o /dev/null -w '%{http_code}\n' localhost:8788/v1/chat/completions \
  -H "authorization: Bearer $KEY" -H 'content-type: application/json' -d '{"messages":[{"role":"user","content":"hi"}]}'
# → 403

# 4. владелец пускает Moodle ID — и тот же ключ работает, ответ идёт стримом
TOKEN=$(grep '^MSE_ADMIN_TOKEN=' /etc/mse/mse.env | cut -d= -f2)
curl -s -X POST localhost:8788/admin/allow -H "x-admin-token: $TOKEN" -H 'content-type: application/json' \
  -d '{"moodleId":"12345"}' | jq '.allow'
curl -s localhost:8788/v1/chat/completions -H "authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"stream":true,"messages":[{"role":"user","content":"привет"}]}' | head -3
# → data: {"id":…,"choices":[{"delta":{"content":"…"}}]} …

# 5. отзыв — сразу
DEV=$(curl -s localhost:8788/admin/state -H "x-admin-token: $TOKEN" | jq -r '.devices[0].deviceId')
curl -s -X POST localhost:8788/admin/revoke -H "x-admin-token: $TOKEN" -H 'content-type: application/json' -d "{\"deviceId\":\"$DEV\"}" | jq '.device.status'
# → "revoked"

# 6. туннель
/usr/local/bin/mse-tunnel.sh status --json | jq '{installed,running,mode,url}'
```

Приёмка расширения (то же — тестами):

```bash
SS_BROWSER=webkit node --test --test-concurrency=1 --test-name-pattern="M13" tests/mse.test.js
# юзер без регистрации: 0 запросов к шлюзу; после allow — строка AI и ответ в форме
```

## 4. Уровни доступа в расширении

| уровень | условие | что видно | запросы к шлюзу |
|---|---|---|---|
| base | ключа нет / `status != active` (pending, revoked) и устройство ни разу не привязывалось | только строки их базы | 0 |
| base (pending) | ключ отправлен, владелец ещё не пустил | только строки их базы | 0 (только `/mse/v1/me` при открытии панели, чтобы узнать статус) |
| owner | `/mse/v1/me` → `active` | строки базы + строка **AI** (когда база пуста / ошибка / тип не разбирается) | `/v1/chat/completions` со стримом |

Контекст AI-запроса: полный текст вопроса, все варианты, тип; ответ просим одной строкой. Тап по строке AI
ставит ответ в форму (выбор варианта или текст в поле).

## 5. Что осталось на следующий этап (не входит в 2.0)

1. **Мост к другим бэкендам**: сейчас бэкенд один (agy-upstream, Gemini через Antigravity OAuth). Дальше —
   Claude Code и Codex как дополнительные апстримы; роутер уже готов их не замечать (`MSE_UPSTREAM_PORT`).
2. **iOS-клиент tailscale**: юзеру нужно поставить приложение tailscale, войти в tailnet и открыть
   `<host>.<tailnet>.ts.net` — персональный setup-гайд (как INCY/turn-proxy в OBHOD) ещё не написан.
3. **Funnel в ACL**: `tailscale funnel` требует разрешения в ACL tailnet; TUI и бот показывают ошибку и
   оставляют `serve`, пока владелец не разрешит.
4. **Ротация ключа модели** — только в бэкенде; в роутере и расширении его нет и не должно быть.
