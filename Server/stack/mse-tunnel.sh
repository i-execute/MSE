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
  local cf_path
  cf_path="$(command -v "$CF_BIN" 2>/dev/null || true)"
  if [ -z "$cf_path" ]; then
    [ -x "/usr/local/bin/cloudflared" ] && cf_path="/usr/local/bin/cloudflared"
    [ -x "/opt/mse/bin/cloudflared" ] && cf_path="/opt/mse/bin/cloudflared"
  fi
  [ -n "$cf_path" ] || die "cloudflared is not installed: mse-tunnel.sh cloudflared-install"
  mkdir -p "$STATE_DIR" 2>/dev/null || true
  local log_file="$STATE_DIR/cloudflared.log"
  pkill -f "cloudflared tunnel --url" 2>/dev/null || true
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
  write_state_cf "cloudflared" "$port" "$url"
  if [ "$prev_url" != "$url" ]; then
    cmd_notify_bot "🌐 Gateway URL updated:
$url"
  fi
  say "$url"
}

cmd_cf_off() {
  pkill -f "cloudflared tunnel --url" 2>/dev/null || true
  write_state_cf off "$GATEWAY_PORT" ""
  say "cloudflared is off"
}

write_state_cf() {
  local mode="$1" port="$2" url="$3"
  mkdir -p "$STATE_DIR" 2>/dev/null || true
  python3 - "$TUNNEL_BACKEND_FILE" "$mode" "$port" "$url" <<'PY' 2>/dev/null || true
import json,sys,datetime
path,mode,port,url=sys.argv[1:5]
rec={"backend":"cloudflared","mode":mode,"port":int(port or 0),"url":url,
     "at":datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00","Z")}
try:
    old=json.load(open(path))
    if isinstance(old,dict): rec={**old,**rec}
except Exception:
    pass
json.dump(rec,open(path,"w"),indent=1)
PY
  if [ -f "$ENV_FILE" ] && [ -n "$url" ]; then
    python3 - "$ENV_FILE" "MSE_PUBLIC_URL" "$url" <<'PY' 2>/dev/null || true
import sys
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
      if body="$(curl -fsSk --max-time 8 "$url/health" 2>"$TMP_REASON")"; then
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

main() {
  local cmd="${1:-status}"; shift || true
  case "$cmd" in
    install) cmd_install ;;
    cloudflared-install|cf-install) cmd_cf_install ;;
    cloudflared|cf) cmd_cf_run "${1:-$GATEWAY_PORT}" ;;
    cloudflared-off|cf-off) cmd_cf_off ;;
    notify) cmd_notify_bot "$*" ;;
    up) cmd_up "$@" ;;
    funnel) cmd_funnel "${1:-$GATEWAY_PORT}" ;;
    serve) cmd_serve "${1:-$GATEWAY_PORT}" ;;
    off) cmd_off "${1:-$GATEWAY_PORT}" ;;
    url) cmd_url ;;
    status|state) cmd_status "$@" ;;
    wait) cmd_wait "$@" ;;
    dns) dns_name ;;
    *) die "unknown command: $cmd (install|cloudflared-install|cloudflared|cloudflared-off|notify|up|funnel|serve|off|url|status|wait|dns)" ;;
  esac
}
main "$@"
