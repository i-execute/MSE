"""The one thing the bot knows about the gateway: its admin API on the loopback.

Nothing else is imported here — no goygram, no Telegram — so the client can be exercised against a real router
in a test without a network and without a token.
"""
from __future__ import annotations

import json
import subprocess
import urllib.error
import urllib.request
from typing import Any


class GatewayError(Exception):
    def __init__(self, message: str, status: int = 0):
        super().__init__(message)
        self.message = message
        self.status = int(status or 0)


class Gateway:
    def __init__(self, base_url: str, admin_token: str, timeout: float = 12.0):
        self.base = str(base_url or "").rstrip("/")
        self.token = str(admin_token or "")
        self.timeout = timeout

    # ------------------------------------------------------------------ plumbing
    def _call(self, method: str, path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(self.base + path, method=method, data=data, headers={
            "x-admin-token": self.token,
            "content-type": "application/json",
            "accept": "application/json",
        })
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                raw = resp.read(1024 * 1024)
        except urllib.error.HTTPError as exc:
            raw = exc.read(65536) if hasattr(exc, "read") else b""
            try:
                payload = json.loads(raw.decode("utf-8", "replace") or "{}")
                message = ((payload.get("error") or {}).get("message")) or str(exc)
            except Exception:
                message = str(exc)
            raise GatewayError(str(message), exc.code)
        except (urllib.error.URLError, OSError) as exc:
            raise GatewayError("шлюз не отвечает: " + str(getattr(exc, "reason", exc)), 0)
        try:
            return json.loads(raw.decode("utf-8", "replace") or "{}")
        except Exception:
            raise GatewayError("шлюз ответил не по формату", 0)

    def health(self) -> dict[str, Any]:
        req = urllib.request.Request(self.base + "/health", headers={"accept": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                return json.loads(resp.read(1 << 20).decode("utf-8", "replace") or "{}")
        except urllib.error.HTTPError as exc:
            raise GatewayError("шлюз ответил " + str(exc.code), exc.code)
        except (urllib.error.URLError, OSError) as exc:
            raise GatewayError("шлюз не отвечает: " + str(getattr(exc, "reason", exc)), 0)

    def admin_state(self) -> dict[str, Any]:
        return self._call("GET", "/admin/state")

    def snapshot(self) -> dict[str, Any]:
        """health + state in one dict: what a screen needs, and nothing else."""
        out: dict[str, Any] = {"health": {}, "devices": [], "allow": [], "log": []}
        try:
            out["health"] = self.health()
        except GatewayError as exc:
            out["error"] = exc.message
        try:
            state = self.admin_state()
        except GatewayError as exc:
            out.setdefault("error", exc.message)
            return out
        out.update({
            "devices": state.get("devices") or [],
            "allow": state.get("allow") or [],
            "log": state.get("log") or [],
        })
        health = out.get("health") or {}
        for key in ("model", "models", "quota", "version"):
            if state.get(key) is not None and health.get(key) is None:
                health[key] = state[key]
        health.setdefault("model", state.get("model"))
        health.setdefault("quota", state.get("quota"))
        health.setdefault("version", state.get("version"))
        health.setdefault("publicUrl", state.get("publicUrl"))
        out["health"] = health
        return out

    # ------------------------------------------------------------------ decisions
    def allow(self, moodle_id: str, name: str = "") -> dict[str, Any]:
        return self._call("POST", "/admin/allow", {"moodleId": str(moodle_id), "name": name})

    def approve(self, device_id: str) -> dict[str, Any]:
        return self._call("POST", "/admin/approve", {"deviceId": device_id})

    def revoke(self, device_id: str) -> dict[str, Any]:
        return self._call("POST", "/admin/revoke", {"deviceId": device_id})

    def disallow(self, moodle_id: str) -> dict[str, Any]:
        return self._call("POST", "/admin/disallow", {"moodleId": str(moodle_id)})

    def set_quota(self, quota: int) -> dict[str, Any]:
        return self._call("POST", "/admin/quota", {"quota": int(quota)})

    def device_of(self, needle: str) -> dict[str, Any] | None:
        """A device by its id or by its Moodle id — the owner thinks in the second one."""
        needle = str(needle or "").strip()
        if not needle:
            return None
        for d in self.admin_state().get("devices") or []:
            if str(d.get("deviceId")) == needle or str(d.get("moodleId")) == needle:
                return d
        return None


# ---------------------------------------------------------------------- the tunnel (tailscale, not cloudflared)
def tunnel_status(script: str = "/usr/local/bin/mse-tunnel.sh", timeout: float = 20.0) -> dict[str, Any]:
    """Ask the tunnel helper what it is doing. The helper is the only place that talks to tailscale."""
    try:
        out = subprocess.run([script, "status", "--json"], capture_output=True, text=True, timeout=timeout, check=False)
    except (OSError, subprocess.SubprocessError) as exc:
        return {"backend": "tailscale", "error": str(exc)}
    if out.returncode != 0:
        return {"backend": "tailscale", "error": (out.stderr or out.stdout or "mse-tunnel.sh failed").strip()[:200]}
    try:
        return json.loads(out.stdout or "{}")
    except Exception:
        return {"backend": "tailscale", "error": "mse-tunnel.sh answered with something that is not JSON"}


def tunnel_do(action: str, script: str = "/usr/local/bin/mse-tunnel.sh", port: int = 8788, timeout: float = 120.0) -> tuple[bool, str]:
    """funnel | serve | off. Returns (ok, text): the address when it came up, the reason when it did not."""
    args = [script, action]
    if action in ("funnel", "serve"):
        args.append(str(port))
    try:
        out = subprocess.run(args, capture_output=True, text=True, timeout=timeout, check=False)
    except (OSError, subprocess.SubprocessError) as exc:
        return False, str(exc)
    text = (out.stdout or "").strip() or (out.stderr or "").strip()
    return out.returncode == 0, text[:300]
