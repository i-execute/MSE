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
#   mse-tunnel.sh funnel-reset [port]     reset serve/funnel mappings and restart tailscaled
#   mse-tunnel.sh doctor [--json]         diagnose DNS, edge 443, port match, and journal drops
#   mse-tunnel.sh watchdog [--once]       auto-recover tunnel on 3 consecutive /health failures
#   mse-tunnel.sh cloudflared-named <tok> run permanent Cloudflare tunnel using account token
#   mse-tunnel.sh cloudflared [port]      run temporary Cloudflare quick-tunnel
#   mse-tunnel.sh off                     stop the funnel, keep the node in the tailnet
#   mse-tunnel.sh status [--json]         what is on, and which address it answers on
#   mse-tunnel.sh url                     just the address (empty if there is none yet)
#   mse-tunnel.sh wait [--timeout N]      wait until the address answers /health
set -euo pipefail

ENV_FILE="${MSE_ENV_FILE:-/etc/mse/mse.env}"
STATE_DIR="${MSE_STATE_DIR:-/var/lib/mse}"
GATEWAY_PORT="${MSE_GATEWAY_PORT:-${MSE_PORT:-}}"
TUNNEL_BACKEND_FILE="$STATE_DIR/tunnel.json"
CF_BIN="${MSE_CLOUDFLARED_BIN:-cloudflared}"
TS_BIN="${MSE_TAILSCALE_BIN:-tailscale}"
TS_SOCK="${MSE_TAILSCALE_SOCKET:-}"
LOG_TAG="mse-tunnel"
TMP_REASON="$(mktemp 2>/dev/null || echo /tmp/mse-tunnel-reason.$$)"
trap 'rm -f "$TMP_REASON"' EXIT

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

# Prefer the explicit override; otherwise use the router port persisted by the installer.
GATEWAY_PORT="${GATEWAY_PORT:-$(env_get MSE_PORT)}"

ts() {
  if [ -n "$TS_SOCK" ]; then "$TS_BIN" --socket="$TS_SOCK" "$@"; else "$TS_BIN" "$@"; fi
}

cmd_notify_bot() {
  local msg="$1"
  local token owner
  token="$(env_get MSE_BOT_TOKEN)"
  owner="$(env_get MSE_OWNER_ID)"
  if [ -n "$token" ] && [ -n "$owner" ] && have curl; then
    curl -fsS -X POST "https://api.telegram.org/bot${token}/sendMessage" \
      -d "chat_id=${owner}" \
      --data-urlencode "text=${msg}" >/dev/null 2>&1 || true
  fi
}

cmd_cf_install() {
  local arch
  case "$(uname -m)" in
    x86_64) arch="amd64" ;;
    aarch64|arm64) arch="arm64" ;;
    *) die "unsupported architecture: $(uname -m)" ;;
  esac
  say "cloudflared: checking latest release from GitHub..."
  local download_url=""
  if have curl; then
    download_url="$(curl -fsSL https://api.github.com/repos/cloudflare/cloudflared/releases/latest 2>/dev/null | grep -o "https://github.com/cloudflare/cloudflared/releases/download/[^\"]*/cloudflared-linux-${arch}" | head -1 || true)"
  fi
  if [ -z "$download_url" ]; then
    # Pinned fallback
    download_url="https://github.com/cloudflare/cloudflared/releases/download/2024.10.1/cloudflared-linux-${arch}"
    note "using pinned fallback: $download_url"
  else
    say "found latest release: $download_url"
  fi
  local target_bin="/usr/local/bin/cloudflared"
  if [ ! -w "/usr/local/bin" ] 2>/dev/null; then
    target_bin="/opt/mse/bin/cloudflared"
  fi
  mkdir -p "$(dirname "$target_bin")" 2>/dev/null || true
  curl -fsSL "$download_url" -o "$target_bin" || die "failed to download cloudflared"
  chmod +x "$target_bin"
  say "cloudflared: installed to $target_bin"
}

cmd_cf_run() {
  local port="${1:-$GATEWAY_PORT}"
  [ -n "$port" ] || die "MSE_PORT is not configured"
  note "warning: trycloudflare.com provides a temporary dynamic URL that changes on restart"
  note "for a permanent address, use: mse-tunnel.sh cloudflared-named <token> <domain>"
  local cf_path
  cf_path="$(command -v "$CF_BIN" 2>/dev/null || true)"
  if [ -z "$cf_path" ]; then
    [ -x "/usr/local/bin/cloudflared" ] && cf_path="/usr/local/bin/cloudflared"
    [ -x "/opt/mse/bin/cloudflared" ] && cf_path="/opt/mse/bin/cloudflared"
  fi
  [ -n "$cf_path" ] || die "cloudflared is not installed: mse-tunnel.sh cloudflared-install"
  mkdir -p "$STATE_DIR" 2>/dev/null || true
  local log_file="$STATE_DIR/cloudflared.log"
  pkill -f "cloudflared tunnel" 2>/dev/null || true
  nohup "$cf_path" tunnel --url "http://127.0.0.1:$port" >"$log_file" 2>&1 &
  local url="" waited=0 max_wait=25
  while [ "$waited" -lt "$max_wait" ]; do
    if grep -E -o "https://[a-zA-Z0-9-]+\.trycloudflare\.com" "$log_file" 2>/dev/null | tail -1 > "$TMP_REASON"; then
      url="$(cat "$TMP_REASON")"
      [ -n "$url" ] && break
    fi
    sleep 1
    waited=$((waited+1))
  done
  [ -n "$url" ] || die "cloudflared did not provide a URL within ${max_wait}s"
  local prev_url
  prev_url="$(env_get MSE_PUBLIC_URL)"
  write_state_cf "cloudflared-quick" "$port" "$url"
  if [ "$prev_url" != "$url" ]; then
    cmd_notify_bot "🌐 Gateway URL updated (Cloudflare Quick Tunnel — temporary):
$url"
  fi
  say "$url"
}

cmd_cf_named() {
  local token="${1:-$(env_get MSE_CF_TOKEN)}"
  local domain="${2:-$(env_get MSE_CF_DOMAIN)}"
  local port="${3:-$GATEWAY_PORT}"
  [ -n "$token" ] || die "Cloudflare tunnel token required (pass as argument or set MSE_CF_TOKEN)"
  [ -n "$port" ] || die "MSE_PORT is not configured"

  if [ -z "$domain" ]; then
    domain="$(env_get MSE_PUBLIC_URL)"
  fi
  if [ -n "$domain" ] && [[ ! "$domain" =~ ^https?:// ]]; then
    domain="https://$domain"
  fi
  [ -n "$domain" ] || die "Tunnel domain required (e.g. gateway.example.com or https://gateway.example.com)"

  local cf_path
  cf_path="$(command -v "$CF_BIN" 2>/dev/null || true)"
  if [ -z "$cf_path" ]; then
    [ -x "/usr/local/bin/cloudflared" ] && cf_path="/usr/local/bin/cloudflared"
    [ -x "/opt/mse/bin/cloudflared" ] && cf_path="/opt/mse/bin/cloudflared"
  fi
  if [ -z "$cf_path" ]; then
    cmd_cf_install
    cf_path="/usr/local/bin/cloudflared"
    [ -x "$cf_path" ] || cf_path="/opt/mse/bin/cloudflared"
  fi
  [ -n "$cf_path" ] && [ -x "$cf_path" ] || die "cloudflared binary not found"

  mkdir -p "$STATE_DIR" 2>/dev/null || true
  local log_file="$STATE_DIR/cloudflared-named.log"
  pkill -f "cloudflared tunnel" 2>/dev/null || true
  nohup "$cf_path" tunnel --no-autoupdate run --token "$token" >"$log_file" 2>&1 &
  sleep 2

  if ! pgrep -f "cloudflared tunnel" >/dev/null 2>&1; then
    note "warning: cloudflared process did not stay running, see $log_file"
  fi

  local prev_url
  prev_url="$(env_get MSE_PUBLIC_URL)"
  write_state_cf "cloudflared-named" "$port" "$domain" "$token"
  if [ "$prev_url" != "$domain" ]; then
    cmd_notify_bot "🌐 Gateway URL updated (Cloudflare Named Tunnel — permanent):
$domain"
  fi
  say "$domain"
}

cmd_cf_off() {
  pkill -f "cloudflared tunnel" 2>/dev/null || true
  write_state_cf off "$GATEWAY_PORT" ""
  say "cloudflared is off"
}

write_state_cf() {
  local mode="$1" port="$2" url="$3" token="${4:-}"
  mkdir -p "$STATE_DIR" 2>/dev/null || true
  python3 - "$TUNNEL_BACKEND_FILE" "$mode" "$port" "$url" "$token" <<'PY' 2>/dev/null || true
import json,sys,datetime
path,mode,port,url,token=sys.argv[1:6]
rec={"backend":"cloudflared","mode":mode,"port":int(port or 0),"url":url,
     "at":datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00","Z")}
if token: rec["token"]=token
try:
    old=json.load(open(path))
    if isinstance(old,dict): rec={**old,**rec}
except Exception:
    pass
json.dump(rec,open(path,"w"),indent=1)
PY
  if [ -f "$ENV_FILE" ]; then
    python3 - "$ENV_FILE" "MSE_PUBLIC_URL" "$url" "MSE_CF_TOKEN" "$token" <<'PY' 2>/dev/null || true
import sys
path,k1,v1,k2,v2=sys.argv[1:6]
try:
    lines=open(path).read().splitlines()
except Exception:
    lines=[]
keys={k1:v1}
if v2: keys[k2]=v2
out=[l for l in lines if not any(l.startswith(k+"=") for k in keys)]
for k,v in keys.items():
    if v: out.append(f'{k}={v}')
open(path,"w").write("\n".join(out)+"\n")
PY
  fi
}

cmd_install() {
  if have "$TS_BIN"; then say "tailscale: already installed ($(ts version 2>/dev/null | head -1))"; return 0; fi
  say "tailscale: installing…"
  if have curl; then
    curl -fsSL https://tailscale.com/install.sh | sh
  else
    die "no curl: install tailscale by hand (https://tailscale.com/download)"
  fi
  have "$TS_BIN" || die "the install produced no tailscale binary"
  say "tailscale: installed"
}

cmd_up() {
  local exit_node=0
  for a in "$@"; do [ "$a" = "--exit-node" ] && exit_node=1; done
  have "$TS_BIN" || die "tailscale is not installed: mse-tunnel.sh install"
  local key tags hostname args
  key="$(env_get MSE_TAILSCALE_KEY)"
  tags="$(env_get MSE_TAILSCALE_TAGS)"
  hostname="$(env_get MSE_TAILSCALE_HOSTNAME "mse-gateway")"
  if ts status >/dev/null 2>&1 && ts status --json 2>/dev/null | grep -q '"BackendState":"Running"'; then
    say "tailscale: already up"; return 0
  fi
  args=(up --hostname="$hostname")
  [ -n "$key" ] && args+=("--auth-key=$key") || note "no MSE_TAILSCALE_KEY: a browser login link is printed instead"
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
  [ -n "$port" ] || die "MSE_PORT is not configured"
  have "$TS_BIN" || die "tailscale is not installed"
  ts funnel --bg --yes "$port" >/dev/null 2>&1 || ts funnel --bg "$port" || die "funnel did not turn on: check that Funnel is allowed in the tailnet ACL"
  local host url
  host="$(dns_name)"
  [ -n "$host" ] || die "tailscale did not report the node address (tailscale status --json)"
  url="https://$host"
  write_state funnel "$port" "$url"
  say "$url"
}

cmd_serve() {
  local port="${1:-$GATEWAY_PORT}"
  [ -n "$port" ] || die "MSE_PORT is not configured"
  have "$TS_BIN" || die "tailscale is not installed"
  ts serve --bg --https=443 "http://127.0.0.1:$port" >/dev/null 2>&1 || ts serve --bg "http://127.0.0.1:$port" || die "serve did not turn on"
  local host url
  host="$(dns_name)"
  [ -n "$host" ] || die "tailscale did not report the node address"
  url="https://$host"
  write_state serve "$port" "$url"
  say "$url"
}

cmd_off() {
  have "$TS_BIN" || { say "tailscale is not installed"; return 0; }
  local port="${1:-$GATEWAY_PORT}"
  [ -n "$port" ] || die "MSE_PORT is not configured"
  ts funnel --bg "$port" off >/dev/null 2>&1 || ts funnel off >/dev/null 2>&1 || true
  ts serve --bg "$port" off >/dev/null 2>&1 || ts serve off >/dev/null 2>&1 || true
  write_state off "$port" ""
  say "funnel is off"
}

cmd_url() {
  if [ -f "$TUNNEL_BACKEND_FILE" ]; then
    local u
    u="$(python3 -c '
import json,sys
try: print(json.load(open(sys.argv[1])).get("url") or "")
except Exception: print("")
' "$TUNNEL_BACKEND_FILE")"
    if [ -n "$u" ]; then printf '%s\n' "$u"; return 0; fi
  fi
  local env_u; env_u="$(env_get MSE_PUBLIC_URL)"
  if [ -n "$env_u" ]; then printf '%s\n' "$env_u"; return 0; fi
  local host; host="$(dns_name)"
  [ -n "$host" ] && printf 'https://%s\n' "$host" || true
}

cmd_status() {
  local json=0
  for a in "$@"; do [ "$a" = "--json" ] && json=1; done
  local installed=0 running=0 backend="" url="" ip="" expiry=""
  local cf_running=0
  if pgrep -f "cloudflared tunnel" >/dev/null 2>&1; then
    cf_running=1
  fi
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
  local saved_backend="" saved_mode="" saved_url=""
  if [ -f "$TUNNEL_BACKEND_FILE" ]; then
    eval "$(python3 -c '
import json,sys,shlex
try: d=json.load(open(sys.argv[1]))
except Exception: d={}
print("saved_backend=%s" % shlex.quote(str(d.get("backend") or "")))
print("saved_mode=%s" % shlex.quote(str(d.get("mode") or "")))
print("saved_url=%s" % shlex.quote(str(d.get("url") or "")))
' "$TUNNEL_BACKEND_FILE" 2>/dev/null || true)"
  fi
  if [ "${saved_backend:-}" = "cloudflared" ]; then
    backend="${saved_mode:-cloudflared}"
    url="${saved_url:-}"
    running=$cf_running
    installed=1
    if [ "$json" = "1" ]; then
      python3 - "$installed" "$running" "$backend" "$url" "$GATEWAY_PORT" <<'PY'
import json,sys
installed,running,backend,url,port=sys.argv[1:6]
print(json.dumps({"backend":"cloudflared","installed":installed=="1","running":running=="1",
  "mode":backend or None,"url":url or None,"ip":None,"expiry":None,
  "gateway_port":int(port) if port.isdigit() else None},indent=1))
PY
      return 0
    fi
    say "tunnel:    cloudflared · $([ "$running" = 1 ] && echo up || echo down)"
    say "mode:      ${backend:-none}"
    say "address:   ${url:-none}"
    return 0
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
  "gateway_port":int(port) if port.isdigit() else None},indent=1))
PY
    return 0
  fi
  say "tailscale: $([ "$installed" = 1 ] && echo installed || echo no) · $([ "$running" = 1 ] && echo up || echo down)"
  say "mode:      ${backend:-none}"
  say "address:   ${url:-none}"
  say "ip:        ${ip:-none}"
  [ -n "$stage" ] && say "node key:  ${stage}"
  return 0
}

cmd_wait() {
  # Wait until the public address really answers from the outside. Right after `funnel` the tailnet certificate
  # may not be issued yet: the handshake then fails with "unexpected eof while reading", which is normal for a
  # few seconds. That case is retried; anything else is reported with its reason.
  local timeout=60 quiet=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --timeout) timeout="$2"; shift 2 ;;
      --quiet) quiet=1; shift ;;
      *) shift ;;
    esac
  done
  local url; url="$(cmd_url)"
  [ -n "$url" ] || die "no address yet: run funnel/serve first"
  [ "$quiet" = "1" ] || note "waiting for $url/health (up to ${timeout}s)"
  local waited=0 step=3 body reason=""
  while [ "$waited" -lt "$timeout" ]; do
    if have curl; then
      # -k: the certificate of a fresh node can still be in flight; the check is "it answers", not "it is trusted"
      # -4: bypass broken host IPv6 routing
      if body="$(curl -4 -fsSk --max-time 8 "$url/health" 2>"$TMP_REASON")"; then
        case "$body" in
          *'"name"'*|*'"ok"'*|*'gateway'*)
            say "$url"
            return 0
            ;;
          *) reason="the address answers, but not like the gateway: ${body:0:80}" ;;
        esac
      else
        reason="$(tail -1 "$TMP_REASON" 2>/dev/null | cut -c1-160)"
      fi
    else
      die "curl is required to check the address"
    fi
    sleep "$step"
    waited=$((waited+step))
    if [ "$quiet" != "1" ] && [ "$waited" -lt "$timeout" ]; then
      printf '  … %ss: %s\n' "$waited" "${reason:-no answer yet}" >&2
    fi
  done
  note "the address $url did not answer within ${timeout}s"
  [ -n "$reason" ] && note "  last reason: $reason"
  case "$reason" in
    *"unexpected eof"*|*"handshake"*|*"certificate"*|*"SSL"*)
      note "  the tailnet certificate is not ready yet: allow Funnel for this node in the ACL, then"
      note "  run again:  mse-tunnel.sh wait --timeout 180"
      ;;
    *"refused"*|*"resolve"*|*"timed out"*)
      note "  the address does not reach this node: check that tailscale is up and the funnel is on"
      ;;
  esac
  return 1
}

cmd_funnel_reset() {
  local port="${1:-$GATEWAY_PORT}"
  [ -n "$port" ] || die "MSE_PORT is not configured"
  say "funnel reset: resetting serve and funnel mappings..."
  ts serve reset 2>/dev/null || true
  ts funnel --bg "$port" off 2>/dev/null || ts funnel off 2>/dev/null || true
  sleep 1
  ts funnel --bg --yes "$port" 2>/dev/null || ts funnel --bg "$port" 2>/dev/null || true
  if have systemctl; then
    say "restarting tailscaled to clear stale socket connections..."
    systemctl restart tailscaled 2>/dev/null || true
  fi
  local host; host="$(dns_name)"
  local url="https://$host"
  write_state funnel "$port" "$url"
  say "funnel reset complete: $url"
}

log_to_router() {
  local msg="$1"
  local log_file="$STATE_DIR/mse-router.log"
  mkdir -p "$STATE_DIR" 2>/dev/null || true
  local ts
  ts="$(python3 -c 'import datetime; print(datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00","Z"))' 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '[%s] [INFO] [watchdog] %s\n' "$ts" "$msg" >> "$log_file" 2>/dev/null || true
  say "tunnel watchdog: $msg"
}

cmd_watchdog() {
  local once=0 interval=60
  while [ $# -gt 0 ]; do
    case "$1" in
      --once) once=1; shift ;;
      --interval) interval="$2"; shift 2 ;;
      *) shift ;;
    esac
  done

  local watchdog_state_file="$STATE_DIR/watchdog.json"
  mkdir -p "$STATE_DIR" 2>/dev/null || true

  watchdog_step() {
    local url; url="$(cmd_url)"
    if [ -z "$url" ]; then
      return 0
    fi
    local prev_fails=0
    if [ -f "$watchdog_state_file" ]; then
      prev_fails="$(python3 -c 'import json,sys; print(int(json.load(open(sys.argv[1])).get("failures", 0)))' "$watchdog_state_file" 2>/dev/null || echo 0)"
    fi
    local health_code=0
    if have curl; then
      health_code="$(curl -4 -k -fsS -o /dev/null -w "%{http_code}" --max-time 8 "$url/health" 2>/dev/null || echo 0)"
    fi
    local now_ts
    now_ts="$(python3 -c 'import datetime; print(datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00","Z"))' 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)"

    if [ "$health_code" = "200" ]; then
      python3 - "$watchdog_state_file" "0" "ok" "$url" "$now_ts" <<'PY' 2>/dev/null || true
import json,sys
path,fails,status,url,at=sys.argv[1:6]
json.dump({"failures":int(fails),"status":status,"url":url,"at":at}, open(path,"w"), indent=1)
PY
      return 0
    fi

    local fails=$((prev_fails + 1))
    python3 - "$watchdog_state_file" "$fails" "fail" "$url" "$now_ts" <<'PY' 2>/dev/null || true
import json,sys
path,fails,status,url,at=sys.argv[1:6]
json.dump({"failures":int(fails),"status":status,"url":url,"at":at}, open(path,"w"), indent=1)
PY

    if [ "$fails" -ge 3 ]; then
      log_to_router "tunnel watchdog: recovered"
      local backend="tailscale"
      if [ -f "$TUNNEL_BACKEND_FILE" ]; then
        backend="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("backend","tailscale"))' "$TUNNEL_BACKEND_FILE" 2>/dev/null || echo tailscale)"
      fi
      if [ "$backend" = "cloudflared" ]; then
        local mode="cloudflared-quick"
        if [ -f "$TUNNEL_BACKEND_FILE" ]; then
          mode="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("mode","cloudflared-quick"))' "$TUNNEL_BACKEND_FILE" 2>/dev/null || echo cloudflared-quick)"
        fi
        if [ "$mode" = "cloudflared-named" ]; then
          cmd_cf_named "$(env_get MSE_CF_TOKEN)" "$(env_get MSE_CF_DOMAIN)" "$GATEWAY_PORT" >/dev/null 2>&1 || true
        else
          cmd_cf_run "$GATEWAY_PORT" >/dev/null 2>&1 || true
        fi
      else
        cmd_funnel_reset "$GATEWAY_PORT" >/dev/null 2>&1 || true
      fi
      python3 - "$watchdog_state_file" "0" "recovered" "$url" "$now_ts" <<'PY' 2>/dev/null || true
import json,sys
path,fails,status,url,at=sys.argv[1:6]
json.dump({"failures":int(fails),"status":status,"url":url,"recovered_at":at}, open(path,"w"), indent=1)
PY
    fi
  }

  if [ "$once" = "1" ]; then
    watchdog_step
    return 0
  fi

  while true; do
    watchdog_step || true
    sleep "$interval"
  done
}

cmd_doctor() {
  local json=0 log_file="${MSE_DOCTOR_LOG:-}"
  while [ $# -gt 0 ]; do
    case "$1" in
      --json) json=1; shift ;;
      --log-file) log_file="$2"; shift 2 ;;
      *) shift ;;
    esac
  done

  local url; url="$(cmd_url)"
  [ -n "$url" ] || url="$(env_get MSE_PUBLIC_URL)"
  local backend="none"
  if [ -f "$TUNNEL_BACKEND_FILE" ]; then
    backend="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("backend","tailscale"))' "$TUNNEL_BACKEND_FILE" 2>/dev/null || echo tailscale)"
  elif [[ "$url" =~ \.ts\.net ]]; then
    backend="tailscale"
  elif [[ "$url" =~ \.trycloudflare\.com ]] || [[ "$url" =~ \.cloudflare ]]; then
    backend="cloudflared"
  elif have "$TS_BIN"; then
    backend="tailscale"
  fi

  local journal_logs=""
  if [ -n "$log_file" ] && [ -f "$log_file" ]; then
    journal_logs="$(cat "$log_file")"
  elif have journalctl; then
    journal_logs="$(journalctl -u tailscaled -n 250 --no-pager 2>/dev/null || true)"
  fi

  local serve_status=""
  if [ "$backend" = "tailscale" ] && have "$TS_BIN"; then
    serve_status="$(ts serve status --json 2>/dev/null || ts serve status 2>/dev/null || true)"
  fi

  local cf_running=0
  if pgrep -f "cloudflared tunnel" >/dev/null 2>&1; then
    cf_running=1
  fi

  JOURNAL_LOGS_RAW="$journal_logs" SERVE_STATUS_RAW="$serve_status" python3 - "$json" "$backend" "$url" "$GATEWAY_PORT" "$cf_running" <<'PY'
import sys, json, socket, subprocess, re, urllib.parse, os

json_mode = (sys.argv[1] == "1")
backend = sys.argv[2]
url = sys.argv[3]
gateway_port = int(sys.argv[4]) if sys.argv[4].isdigit() else 0
cf_running = (sys.argv[5] == "1")

domain = ""
if url:
    try:
        domain = urllib.parse.urlparse(url).netloc.split(':')[0]
    except Exception:
        domain = url.replace('https://','').replace('http://','').split('/')[0]

dns_v4, dns_v6 = [], []
if domain:
    try:
        for res in socket.getaddrinfo(domain, 443, socket.AF_INET):
            ip = res[4][0]
            if ip not in dns_v4: dns_v4.append(ip)
    except Exception:
        pass
    try:
        for res in socket.getaddrinfo(domain, 443, socket.AF_INET6):
            ip = res[4][0]
            if ip not in dns_v6: dns_v6.append(ip)
    except Exception:
        pass

http_ok = False
http_code = 0
latency = 0.0
http_err = ""
if url:
    health_url = url.rstrip('/') + '/health'
    try:
        proc = subprocess.run(
            ['curl', '-k', '-fsS', '-o', '/dev/null', '-w', '%{http_code}:%{time_total}', '--max-time', '6', health_url],
            capture_output=True, text=True, timeout=8
        )
        if proc.returncode == 0:
            parts = proc.stdout.strip().split(':')
            http_code = int(parts[0]) if parts[0].isdigit() else 200
            latency = float(parts[1]) if len(parts) > 1 else 0.0
            http_ok = (http_code == 200)
        else:
            http_err = proc.stderr.strip()[:100] or "connection failed"
    except Exception as e:
        http_err = str(e)

port_match = True
funnel_port = None
serve_raw = os.environ.get("SERVE_STATUS_RAW", "")
if serve_raw:
    m = re.findall(r'127\.0\.0\.1:([0-9]+)', serve_raw)
    if m:
        funnel_port = int(m[0])
        if gateway_port and funnel_port != gateway_port:
            port_match = False

journal_raw = os.environ.get("JOURNAL_LOGS_RAW", "")
drops = []
tls_eofs = []
if journal_raw:
    for line in journal_raw.splitlines():
        line_clean = line.strip()
        if "no rules matched" in line_clean:
            drops.append(line_clean)
        elif ("TLS" in line_clean or "handshake" in line_clean) and ("EOF" in line_clean or "eof" in line_clean) and "fd7a:" in line_clean:
            tls_eofs.append(line_clean)
        elif "TLS: EOF from fd7a:" in line_clean or "EOF from fd7a:" in line_clean:
            tls_eofs.append(line_clean)

ok = True
verdict = "healthy"
diagnosis = "Все проверки пройдены: DNS резолвится, порт совпадает, внешний 443 отвечает."
command = ""

if backend == "tailscale":
    has_drops = (len(drops) > 0 or len(tls_eofs) > 0)
    if has_drops or (port_match is False) or (not http_ok and has_drops):
        ok = False
        verdict = "ts.net-edge протух, сделай funnel reset"
        reasons = []
        if not port_match and funnel_port:
            reasons.append(f"порт funnel ({funnel_port}) не совпадает с портом роутера ({gateway_port})")
        if drops:
            reasons.append(f"в журнале tailscaled {len(drops)} дропов 'no rules matched'")
        if tls_eofs:
            reasons.append(f"в журнале {len(tls_eofs)} TLS EOF от прокси fd7a:")
        if not http_ok:
            reasons.append(f"внешний 443 не отвечает ({http_err or http_code})")
        diagnosis = "Обнаружены неполадки edge-кэша: " + "; ".join(reasons)
        command = f"sudo mse-tunnel.sh funnel-reset {gateway_port}"
    elif not dns_v4 and not dns_v6 and domain:
        ok = False
        verdict = "DNS не резолвит имя туннеля"
        diagnosis = f"Для домена {domain} не найдены записи A/AAAA."
        command = f"sudo mse-tunnel.sh up && sudo mse-tunnel.sh funnel {gateway_port}"
    elif not http_ok:
        ok = False
        verdict = "Внешний 443 не отвечает"
        diagnosis = f"Запрос к {url}/health вернул {http_code or http_err}"
        command = f"sudo mse-tunnel.sh funnel-reset {gateway_port}"
    else:
        diagnosis = f"DNS A/AAAA в норме (v4: {len(dns_v4)}, v6: {len(dns_v6)}), 443 ответил за {latency:.3f}s, порты совпадают, дропов нет."
elif backend == "cloudflared":
    if not cf_running:
        ok = False
        verdict = "cloudflared не запущен"
        diagnosis = "Процесс cloudflared отсутствует в системе."
        command = f"sudo mse-tunnel.sh cloudflared {gateway_port}"
    elif not http_ok:
        ok = False
        verdict = "Cloudflare Edge не отвечает"
        diagnosis = f"Запрос к {url}/health вернул {http_code or http_err}"
        command = f"sudo mse-tunnel.sh cloudflared {gateway_port}"
    else:
        diagnosis = f"Cloudflared активен, DNS доступен, 443 ответил за {latency:.3f}s."
else:
    ok = False
    verdict = "Туннель не настроен"
    diagnosis = "Активный туннель отсутствует."
    command = f"sudo mse-tunnel.sh funnel {gateway_port}"

result = {
    "ok": ok,
    "verdict": verdict,
    "diagnosis": diagnosis,
    "command": command,
    "backend": backend,
    "domain": domain,
    "url": url,
    "checks": {
        "dns_v4": dns_v4,
        "dns_v6": dns_v6,
        "http_443": http_ok,
        "http_code": http_code,
        "latency": latency,
        "port_match": port_match,
        "funnel_port": funnel_port,
        "router_port": gateway_port,
        "drops_count": len(drops),
        "tls_eof_count": len(tls_eofs),
        "cf_running": cf_running
    }
}

if json_mode:
    print(json.dumps(result, indent=2, ensure_ascii=False))
else:
    print("Tunnel Doctor:")
    print(f"  Backend:      {backend}")
    print(f"  Domain:       {domain or '—'}")
    print(f"  DNS A (v4):   {', '.join(dns_v4) if dns_v4 else ('none' if domain else '—')}")
    print(f"  DNS AAAA (v6):{', '.join(dns_v6) if dns_v6 else ('none' if domain else '—')}")
    lat_str = f" ({latency:.3f}s)" if http_ok else ""
    http_stat = f"{http_code} OK{lat_str}" if http_ok else f"FAIL ({http_err or http_code or 'no response'})"
    print(f"  Edge 443:     {http_stat}")
    if backend == "tailscale":
        pm_str = "OK" if port_match else f"MISMATCH (funnel={funnel_port}, router={gateway_port})"
        print(f"  Port match:   {pm_str}")
        print(f"  Log drops:    {len(drops)} 'no rules matched', {len(tls_eofs)} TLS EOF from fd7a:")
    elif backend == "cloudflared":
        print(f"  CF process:   {'running' if cf_running else 'stopped'}")
    print("  " + "-" * 56)
    print(f"  ВЕРДИКТ:      {verdict}")
    print(f"  ДИАГНОЗ:      {diagnosis}")
    if command:
        print(f"  ЛЕЧЕНИЕ:      {command}")
PY
}

main() {
  local cmd="${1:-status}"; shift || true
  case "$cmd" in
    install) cmd_install ;;
    cloudflared-install|cf-install) cmd_cf_install ;;
    cloudflared-named|cf-named) cmd_cf_named "$@" ;;
    cloudflared|cf|cloudflared-quick|cf-quick) cmd_cf_run "${1:-$GATEWAY_PORT}" ;;
    cloudflared-off|cf-off) cmd_cf_off ;;
    funnel-reset|reset) cmd_funnel_reset "${1:-$GATEWAY_PORT}" ;;
    watchdog) cmd_watchdog "$@" ;;
    doctor) cmd_doctor "$@" ;;
    notify) cmd_notify_bot "$*" ;;
    up) cmd_up "$@" ;;
    funnel) cmd_funnel "${1:-$GATEWAY_PORT}" ;;
    serve) cmd_serve "${1:-$GATEWAY_PORT}" ;;
    off) cmd_off "${1:-$GATEWAY_PORT}" ;;
    url) cmd_url ;;
    status|state) cmd_status "$@" ;;
    wait) cmd_wait "$@" ;;
    dns) dns_name ;;
    *) die "unknown command: $cmd (install|cloudflared-install|cloudflared-named|cloudflared|cloudflared-off|funnel-reset|watchdog|doctor|notify|up|funnel|serve|off|url|status|wait|dns)" ;;
  esac
}
main "$@"
