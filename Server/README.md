# MSE gateway

OpenAI-совместимый шлюз для расширения MSE: свой ключ устройства на клиенте, allow-list по Moodle ID,
квоты, стриминг, лог. Наружу — через Cloudflare Tunnel.

```bash
cp .env.example .env && $EDITOR .env
set -a; . ./.env; set +a
node mse-server.js                 # http://127.0.0.1:8788
cloudflared tunnel --url http://127.0.0.1:8788
```

Проверка: `curl -s http://127.0.0.1:8788/health` → `"name":"MSE gateway"`.

Разрешить человека по ID: `curl -X POST $GW/admin/allow -H "x-admin-token: $MSE_ADMIN_TOKEN" -H 'content-type: application/json' -d '{"moodleId":"12345"}'`

Полное задание для агента, который это поднимает: `AGENT-TASK.md`.
