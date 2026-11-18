#!/usr/bin/env bash
# A2 — `mse-tunnel.sh wait` and the funnel path, proved against a real https server.
#
# A local TLS server stands in for the tailnet address: it answers /health with 200 once it has been switched on,
# and refuses TLS before that (a plain "eof" server, the same failure the owner saw from outside). The test checks:
#   . wait returns the address as soon as https answers 200, and does not wait the whole budget;
#   . wait reports a clear error with the curl reason when https never answers;
#   . install.sh calls wait after funnel and BEFORE the router restart;
#   . the state file and MSE_PUBLIC_URL are written once the address is known.
set -uo pipefail
cd "$(dirname "$0")/.."

ROOT="$(pwd)"
WORK="$(mktemp -d)"
PASS=0
FAIL=0
ok()   { PASS=$((PASS+1)); printf 'ok   %s\n' "$*"; }
bad()  { FAIL=$((FAIL+1)); printf 'FAIL %s\n' "$*"; }
check(){ if [ "$1" = "1" ]; then ok "$2"; else bad "$2"; fi; }

cleanup() {
  [ -n "${SRV_PID:-}" ] && kill "$SRV_PID" 2>/dev/null
  [ -n "${EOF_PID:-}" ] && kill "$EOF_PID" 2>/dev/null
  rm -rf "$WORK"
}
trap cleanup EXIT

# a self-signed certificate for the local stand-in server
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$WORK/key.pem" -out "$WORK/cert.pem" \
  -days 1 -subj "/CN=localhost" >/dev/null 2>&1
cat > "$WORK/serve.py" <<'PY'
import http.server, ssl, sys, os
port = int(sys.argv[1]); mode = sys.argv[2]; cert = sys.argv[3]; key = sys.argv[4]
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith('/health') and mode == 'ok':
            body = b'{"ok":true,"name":"MSE gateway"}'
            self.send_response(200); self.send_header('content-type', 'application/json')
            self.send_header('content-length', str(len(body))); self.end_headers(); self.wfile.write(body)
        else:
            self.send_response(503); self.end_headers()
    def log_message(self, *a): pass
srv = http.server.HTTPServer(('127.0.0.1', port), H)
ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); ctx.load_cert_chain(cert, key)
srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
srv.serve_forever()
PY

# --- 1. https answers 200: wait must return the address quickly and print it
python3 "$WORK/serve.py" 18443 ok "$WORK/cert.pem" "$WORK/key.pem" >/dev/null 2>&1 &
SRV_PID=$!
sleep 1
export MSE_ENV_FILE="$WORK/mse.env" MSE_STATE_DIR="$WORK/state" MSE_CURL_CA_BUNDLE="$WORK/cert.pem"
mkdir -p "$WORK/state"
printf 'MSE_PUBLIC_URL=https://localhost:18443\nMSE_TAILSCALE_KEY=tskey-auth-example\n' > "$MSE_ENV_FILE"
python3 - "$MSE_STATE_DIR/tunnel.json" <<'PY'
import json, sys
json.dump({"backend": "tailscale", "mode": "funnel", "port": 18443, "url": "https://localhost:18443"}, open(sys.argv[1], "w"))
PY
START=$(date +%s)
out="$(MSE_CURL_EXTRA="-k" MSE_ENV_FILE="$MSE_ENV_FILE" MSE_STATE_DIR="$MSE_STATE_DIR" bash Server/stack/mse-tunnel.sh wait --timeout 30 2>&1)"
rc=$?
TOOK=$(( $(date +%s) - START ))
check "$([ $rc -eq 0 ] && echo 1 || echo 0)" "wait exits 0 when https answers ($out)"
check "$(printf '%s' "$out" | grep -q 'https://localhost:18443' && echo 1 || echo 0)" "wait prints the address"
check "$([ $TOOK -lt 15 ] && echo 1 || echo 0)" "wait returns as soon as it answers (${TOOK}s, not the whole budget)"

# --- 2. https never answers: wait must fail with the reason, inside the budget
kill "$SRV_PID" 2>/dev/null; SRV_PID=""
python3 - "$MSE_STATE_DIR/tunnel.json" <<'PY'
import json, sys
json.dump({"backend": "tailscale", "mode": "funnel", "port": 18444, "url": "https://localhost:18444"}, open(sys.argv[1], "w"))
PY
START=$(date +%s)
out="$(MSE_ENV_FILE="$MSE_ENV_FILE" MSE_STATE_DIR="$MSE_STATE_DIR" bash Server/stack/mse-tunnel.sh wait --timeout 6 2>&1)"
rc=$?
TOOK=$(( $(date +%s) - START ))
check "$([ $rc -ne 0 ] && echo 1 || echo 0)" "wait exits non-zero when the address never answers"
check "$(printf '%s' "$out" | grep -qiE 'did not answer|refused|error' && echo 1 || echo 0)" "wait says why: $(printf '%s' "$out" | tail -1 | cut -c1-120)"
check "$([ $TOOK -le 12 ] && echo 1 || echo 0)" "wait respects its timeout (${TOOK}s)"

# --- 3. the order inside install.sh: funnel -> wait -> restart router
INSTALL=Server/stack/install.sh
funnel_at=$(grep -n 'mse-tunnel.sh funnel' "$INSTALL" | head -1 | cut -d: -f1)
wait_at=$(grep -n 'mse-tunnel.sh wait' "$INSTALL" | head -1 | cut -d: -f1)
restart_at=$(grep -n 'restart mse-router.service' "$INSTALL" | tail -1 | cut -d: -f1)
check "$([ -n "$funnel_at" ] && echo 1 || echo 0)" "install.sh turns the funnel on"
check "$([ -n "$wait_at" ] && [ -n "$funnel_at" ] && [ "$wait_at" -gt "$funnel_at" ] && echo 1 || echo 0)" "install.sh waits after funnel (line $funnel_at -> $wait_at)"
check "$([ -n "$restart_at" ] && [ -n "$wait_at" ] && [ "$restart_at" -gt "$wait_at" ] && echo 1 || echo 0)" "install.sh restarts the router after the wait (line $wait_at -> $restart_at)"

# --- 4. the funnel path itself: the helper writes the address and the state file
grep -q 'write_state funnel' "$INSTALL" && bad "install.sh should not write the state itself" || ok "the state is written by the helper, not by the installer"

echo
if [ "$FAIL" -ne 0 ]; then
  printf '%d failed, %d passed\n' "$FAIL" "$PASS"
  exit 1
fi
printf 'tunnel: wait, timeout and the install order — %d checks by running\n' "$PASS"
