# MSE router

The OpenAI-compatible gateway behind the MSE extension: a device key on the client, an allow list by Moodle id,
quotas, streaming, a log. The outside world reaches it only through tailscale.

```bash
MSE_ADMIN_TOKEN=$(openssl rand -hex 24) node mse-router.js     # http://127.0.0.1:8788
```

Health check: `curl -s http://127.0.0.1:8788/health` → `"role":"router"`.

Allow a person by id:

```bash
curl -X POST http://127.0.0.1:8788/admin/allow \
  -H "x-admin-token: $MSE_ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"moodleId":"12345"}'
```

A new application is queued (`/admin/applications`), and the bot drains that queue to ping the owner in Telegram.

Flags: none of this is meant to be typed by hand on a fresh machine — `Storage/get.sh` installs everything and
`sudo mse` is the panel. The full brief for an agent that brings it up is in `AGENT-TASK.md`.

`mse-server.js` is the older 1.0 gateway (no proxying); the tests keep it working as a reference.
