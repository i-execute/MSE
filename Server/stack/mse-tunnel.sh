#!/usr/bin/env bash
# MSE tunnel: tailscale instead of cloudflared.
#
# Cloudflare gave us a random *.trycloudflare.com address that changed on every restart. Tailscale gives a
# stable name inside our own tailnet, HTTPS by tailscale's own certificate, and the same address forever:
#
#     https://<host>.<tailnet>.ts.net        →  127.0.0.1:<port>   (the MSE gateway)
#
# What the owner does once: `tailscale up --auth-key=tskey-…` (the key is taken from /etc/mse/mse.env),
# `tailscale funnel --bg <port>` (or `serve` for the tailnet only), and the address is written into the
# gateway config so the extension and the documents always show the right one.
#
# Everything here is idempotent: calling it twice changes nothing, and no call ever fails because something
# was already done.
#
#   mse-tunnel.sh install                 install tailscale if it is missing
#   mse-tunnel.sh up [--exit-node]        tailscale up with the auth key from the env file
#   mse-tunnel.sh funnel <port>           https funnel to the local port (public address)
#   mse-tunnel.sh serve <port>            https inside the tailnet only
#   mse-tunnel.sh off                     stop the funnel, keep the node in the tailnet
#   mse-tunnel.sh status [--json]         what is on, and which address it answers on
#   mse-tunnel.sh url                     just the address (empty if there is none yet)
#   mse-tunnel.sh wait [--timeout N]      wait until the address answers /health
set -euo pipefail

ENV_FILE="${MSE_ENV_FILE:-/etc/mse/mse.env}"
STATE_DIR="${MSE_STATE_DIR:-/var/lib/mse}"
GATEWAY_PORT="${MSE_GATEWAY_PORT:-8788}"
TUNNEL_BACKEND_FILE="$STATE_DIR/tunnel.json"
TS_BIN="${MSE_TAILSCALE_BIN:-tailscale}"
TS_SOCK="${MSE_TAILSCALE_SOCKET:-}"
LOG_TAG="mse-tunnel"

say() { printf '%s\n' "$*"; }
note() { printf '%s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

env_get() {
  local key="$1" fallback="${2:-}"
  local value=""
  if [ -f "$ENV_FILE" ]; then
    value="$(grep -E "^${key}=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- || true)"
    value="${value%\"}"; value="${value#\"}"; value="${value%\'}"; value="${value#\'}"
  fi
  if [ -z "$value" ]; then value="${!key:-$fallback}"; fi
  printf '%s' "$value"
}

ts() {
  if [ -n "$TS_SOCK" ]; then "$TS_BIN" --socket="$TS_SOCK" "$@"; else "$TS_BIN" "$@"; fi
}

cmd_install() {
  if have "$TS_BIN"; then say "tailscale: уже установлен ($(ts version 2>/dev/null | head -1))"; return 0; fi
  say "tailscale: ставлю…"
  if have curl; then
    curl -fsSL https://tailscale.com/install.sh | sh
  else
    die "нет curl: поставьте tailscale вручную (https://tailscale.com/download)"
  fi
  have "$TS_BIN" || die "установка не дала бинарник tailscale"
  say "tailscale: установлен"
}

cmd_up() {
  local exit_node=0
  for a in "$@"; do [ "$a" = "--exit-node" ] && exit_node=1; done
  have "$TS_BIN" || die "tailscale не установлен: mse-tunnel.sh install"
  local key tags hostname args
  key="$(env_get MSE_TAILSCALE_KEY)"
  tags="$(env_get MSE_TAILSCALE_TAGS)"
  hostname="$(env_get MSE_TAILSCALE_HOSTNAME "mse-gateway")"
  if ts status >/dev/null 2>&1 && ts status --json 2>/dev/null | grep -q '"BackendState":"Running"'; then
    say "tailscale: уже поднят"; return 0
  fi
  args=(up --hostname="$hostname")
  [ -n "$key" ] && args+=("--auth-key=$key") || note "нет MSE_TAILSCALE_KEY: будет ссылка на вход в браузере"
  [ -n "$tags" ] && args+=("--advertise-tags=$tags")
  [ "$exit_node" = "1" ] && args+=("--advertise-exit-node")
  # accept-dns=false: the node must not start resolving through the tailnet just because it joined one
  args+=(--accept-dns=false)
  ts "${args[@]}"
  say "tailscale: $(ts status 2>/dev/null | head -1)"
}

dns_name() {
  # the machine name inside the tailnet: from `tailscale status --json` (Self.DNSName), trailing dot removed
  ts status --json 2>/dev/null | python3 -c '
import json,sys
try:
    d=json.load(sys.stdin)
except Exception:
    sys.exit(0)
self_=d.get("Self") or {}
name=str(self_.get("DNSName") or "").strip().rstrip(".")
if not name:
    name=str(d.get("MagicDNSSuffix") or "").strip().rstrip(".")
    host=str(self_.get("HostName") or "").strip()
    if name and host: name=host+"."+name
print(name)
' 2>/dev/null || true
}

write_state() {
  local mode="$1" port="$2" url="$3"
  mkdir -p "$STATE_DIR" 2>/dev/null || true
  python3 - "$TUNNEL_BACKEND_FILE" "$mode" "$port" "$url" <<'PY' 2>/dev/null || true
import json,sys,datetime
path,mode,port,url=sys.argv[1:5]
rec={"backend":"tailscale","mode":mode,"port":int(port or 0),"url":url,
     "at":datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00","Z")}
try:
    old=json.load(open(path))
    if isinstance(old,dict): rec={**old,**rec}
except Exception:
    pass
json.dump(rec,open(path,"w"),indent=1)
PY
  # the address is mirrored into the env file, so every other tool reads it from one place
  if [ -f "$ENV_FILE" ] && [ -n "$url" ]; then
    python3 - "$ENV_FILE" "MSE_PUBLIC_URL" "$url" <<'PY' 2>/dev/null || true
import sys,re
path,key,value=sys.argv[1:4]
try:
    lines=open(path).read().splitlines()
except Exception:
    lines=[]
out=[l for l in lines if not l.startswith(key+"=")]
out.append(f'{key}={value}')
open(path,"w").write("\n".join(out)+"\n")
PY
  fi
}

cmd_funnel() {
  local port="${1:-$GATEWAY_PORT}"
  have "$TS_BIN" || die "tailscale не установлен"
  ts funnel --bg --yes "$port" >/dev/null 2>&1 || ts funnel --bg "$port" || die "funnel не включился: проверьте, что funnel разрешён в ACL tailnet"
  local host url
  host="$(dns_name)"
  [ -n "$host" ] || die "tailscale не назвал адрес узла (tailscale status --json)"
  url="https://$host"
  write_state funnel "$port" "$url"
  say "$url"
}

cmd_serve() {
  local port="${1:-$GATEWAY_PORT}"
  have "$TS_BIN" || die "tailscale не установлен"
  ts serve --bg --https=443 "http://127.0.0.1:$port" >/dev/null 2>&1 || ts serve --bg "http://127.0.0.1:$port" || die "serve не включился"
  local host url
  host="$(dns_name)"
  [ -n "$host" ] || die "tailscale не назвал адрес узла"
  url="https://$host"
  write_state serve "$port" "$url"
  say "$url"
}

cmd_off() {
  have "$TS_BIN" || { say "tailscale не установлен"; return 0; }
  local port="${1:-$GATEWAY_PORT}"
  ts funnel --bg "$port" off >/dev/null 2>&1 || ts funnel off >/dev/null 2>&1 || true
  ts serve --bg "$port" off >/dev/null 2>&1 || ts serve off >/dev/null 2>&1 || true
  write_state off "$port" ""
  say "funnel выключен"
}

cmd_url() {
  if [ -f "$TUNNEL_BACKEND_FILE" ]; then
    python3 -c '
import json,sys
try: print(json.load(open(sys.argv[1])).get("url") or "")
except Exception: print("")
' "$TUNNEL_BACKEND_FILE"
    return 0
  fi
  local host; host="$(dns_name)"
  [ -n "$host" ] && printf 'https://%s\n' "$host" || true
}

cmd_status() {
  local json=0
  for a in "$@"; do [ "$a" = "--json" ] && json=1; done
  local installed=0 running=0 backend="" url="" ip="" expiry=""
  have "$TS_BIN" && installed=1
  if [ "$installed" = "1" ]; then
    local raw; raw="$(ts status --json 2>/dev/null || true)"
    if [ -n "$raw" ]; then
      eval "$(printf '%s' "$raw" | python3 -c '
import json,sys,shlex
try: d=json.load(sys.stdin)
except Exception: d={}
self_=d.get("Self") or {}
print("running=%d" % (1 if d.get("BackendState")=="Running" else 0))
print("url=%s" % shlex.quote(("https://"+str(self_.get("DNSName") or "").rstrip(".")) if self_.get("DNSName") else ""))
ips=self_.get("TailscaleIPs") or []
print("ip=%s" % shlex.quote(str(ips[0]) if ips else ""))
print("expiry=%s" % shlex.quote(str(self_.get("KeyExpiry") or "")))
' 2>/dev/null || true)"
    fi
  fi
  if [ -f "$TUNNEL_BACKEND_FILE" ]; then
    eval "$(python3 -c '
import json,sys,shlex
try: d=json.load(open(sys.argv[1]))
except Exception: d={}
print("backend=%s" % shlex.quote(str(d.get("mode") or "")))
print("saved_url=%s" % shlex.quote(str(d.get("url") or "")))
' "$TUNNEL_BACKEND_FILE" 2>/dev/null || true)"
  fi
  [ -n "${saved_url:-}" ] && url="$saved_url"
  local stage days
  stage="$(python3 - "$expiry" <<'PY'
import sys,datetime
raw=(sys.argv[1] or "").strip()
if not raw or raw=="never":
    print(""); raise SystemExit
try:
    t=datetime.datetime.fromisoformat(raw.replace("Z","+00:00"))
except Exception:
    print(""); raise SystemExit
d=(t-datetime.datetime.now(datetime.timezone.utc)).days
if d<0: print("expired 0")
elif d<=7: print("7d %d"%d)
elif d<=30: print("30d %d"%d)
else: print(" %d"%d)
PY
)"
  if [ "$json" = "1" ]; then
    python3 - "$installed" "$running" "$backend" "$url" "$ip" "$expiry" "$GATEWAY_PORT" <<'PY'
import json,sys
installed,running,backend,url,ip,expiry,port=sys.argv[1:8]
print(json.dumps({"backend":"tailscale","installed":installed=="1","running":running=="1",
  "mode":backend or None,"url":url or None,"ip":ip or None,"expiry":expiry or None,
  "gateway_port":int(port)},indent=1))
PY
    return 0
  fi
  say "tailscale: $([ "$installed" = 1 ] && echo установлен || echo нет) · $([ "$running" = 1 ] && echo поднят || echo не поднят)"
  say "режим:     ${backend:-нет}"
  say "адрес:     ${url:-нет}"
  say "ip:        ${ip:-нет}"
  [ -n "$stage" ] && say "ключ узла: ${stage}"
  return 0
}

cmd_wait() {
  local timeout=90
  while [ $# -gt 0 ]; do case "$1" in --timeout) timeout="$2"; shift 2;; *) shift;; esac; done
  local url; url="$(cmd_url)"
  [ -n "$url" ] || die "адреса ещё нет: сначала funnel/serve"
  local step=2 waited=0
  while [ "$waited" -lt "$timeout" ]; do
    if have curl && curl -fsS --max-time 5 "$url/health" >/dev/null 2>&1; then say "$url"; return 0; fi
    sleep "$step"; waited=$((waited+step))
  done
  die "адрес $url не ответил за ${timeout}s"
}

main() {
  local cmd="${1:-status}"; shift || true
  case "$cmd" in
    install) cmd_install ;;
    up) cmd_up "$@" ;;
    funnel) cmd_funnel "${1:-$GATEWAY_PORT}" ;;
    serve) cmd_serve "${1:-$GATEWAY_PORT}" ;;
    off) cmd_off "${1:-$GATEWAY_PORT}" ;;
    url) cmd_url ;;
    status|state) cmd_status "$@" ;;
    wait) cmd_wait "$@" ;;
    dns) dns_name ;;
    *) die "неизвестная команда: $cmd (install|up|funnel|serve|off|url|status|wait|dns)" ;;
  esac
}
main "$@"
