#!/usr/bin/env bash
# MSE 2.2 — one-line server install (router + AI bridge + telegram bot + tailscale tunnel).
#
#     curl -fsSL https://raw.githubusercontent.com/i-execute/MSE/main/Storage/get.sh | bash
#
# No arguments are required. The installer:
#   . installs what is missing (node, python3, git, curl, openssl, tailscale) with the system package manager;
#   . asks for sudo itself when it needs root — you do not have to remember it;
#   . the first run asks for the three values it cannot invent — the bot token, the owner id and the tailscale
#     auth key — and starts everything with them; a pipe gets the same three as exact commands instead;
#   . takes the values from the environment when they are already there, so a fully unattended install is:
#       MSE_BOT_TOKEN=... MSE_OWNER_ID=... MSE_API_ID=... MSE_API_HASH=... MSE_TAILSCALE_KEY=... \
#         bash install.sh
#   . brings the tailscale tunnel up and turns the funnel on as soon as a key is present.
#
# What it places:
#   /opt/mse/            the code (router, bot, panel, tunnel script)
#   /opt/mse/venv/       python environment of the bot (goygram)
#   /etc/mse/mse.env     the only settings file (mode 600)
#   /var/lib/mse/        state (devices, allow list, log, admin token)
#   /usr/local/bin/mse           the panel (`sudo mse`)
#   /usr/local/bin/mse-tunnel.sh tailscale: up / funnel / serve / status
#   systemd: mse-router.service, mse-bot.service
#
# Flags: --yes  --update  --dry-run  --no-bot  --no-tunnel  --no-venv
set -euo pipefail

REPO="${MSE_REPO:-i-execute/MSE}"
REF="${MSE_REF:-}"
SRC_DIR="${MSE_SRC_DIR:-}"
PREFIX="${MSE_PREFIX:-/opt/mse}"
ENV_DIR="${MSE_ENV_DIR:-/etc/mse}"
ENV_FILE="$ENV_DIR/mse.env"
STATE_DIR="${MSE_STATE_DIR:-/var/lib/mse}"
UNIT_DIR="${MSE_UNIT_DIR:-/etc/systemd/system}"
BIN_DIR="${MSE_BIN_DIR:-/usr/local/bin}"
ASSUME_YES=0
WITH_VENV=1
WITH_BOT=1
WITH_TUNNEL=1
DRY=0
UPDATE=0

for arg in "$@"; do
  case "$arg" in
    --yes|-y) ASSUME_YES=1 ;;
    --update|--upgrade) UPDATE=1; ASSUME_YES=1 ;;
    --no-venv) WITH_VENV=0 ;;
    --no-bot) WITH_BOT=0 ;;
    --no-tunnel) WITH_TUNNEL=0 ;;
    --dry-run) DRY=1 ;;
    -h|--help) sed -n '2,28p' "$0"; exit 0 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
note() { printf '%s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
run() { if [ "$DRY" = "1" ]; then say "  [dry] $*"; else "$@"; fi; }

# ------------------------------------------------------------------ root, without the ritual
# The script is written for root, but nobody has to remember sudo: when it is started as a normal user and sudo
# exists, it re-runs itself under sudo. Only if there is no sudo at all does it continue with a warning.
ensure_root() {
  if [ "$DRY" = "1" ]; then return 0; fi
  [ "$(id -u)" = "0" ] && return 0
  [ "${MSE_ALLOW_NONROOT:-0}" = "1" ] && return 0
  if have sudo; then
    say "root is needed for /opt/mse and systemd: re-running under sudo"
    exec sudo -E bash "$0" "$@"
  fi
  note "warning: no root and no sudo — continuing, but systemd units and /opt/mse may fail"
  note "warning: run the same command with sudo for a complete install"
}

# ------------------------------------------------------------------ first run: the values the stack cannot start without
# Three things are required and the installer asks for all of them, in one session, before anything starts:
#   1. the bot token   1234567890:AAH...  (@BotFather -> /newbot, or /token)
#   2. the owner id    the numeric telegram id the bot answers
#   3. the tailscale auth key   tskey-auth-...  (fed straight into mse-tunnel.sh up)
# A pipe (curl | bash) cannot answer, so the same three are printed as exact commands to run later, and anything
# already present in the environment or in /etc/mse/mse.env is taken as the answer.
valid_token() {
  case "${1:-}" in
    "" | *" "* | *$'\t'*) return 1 ;;
    *:*) [ "${#1}" -ge 20 ] ;;
    *) return 1 ;;
  esac
}

valid_owner() {
  case "${1:-}" in
    "" | *[!0-9-]*) return 1 ;;
    -*) [ "${#1}" -ge 2 ] ;;
    *) [ "${#1}" -ge 5 ] ;;
  esac
}

valid_tskey() {
  case "${1:-}" in
    "" | *" "* | *$'\t'*) return 1 ;;
    tskey-*) [ "${#1}" -ge 20 ] ;;
    *) return 1 ;;
  esac
}

# ask_one KEY "prompt" "hint" VALIDATOR CURRENT -> prints the accepted value on stdout (empty when nothing was given)
ask_one() {
  key="$1"; prompt="$2"; hint="$3"; validator="$4"; current="$5"
  if [ -n "$current" ] && "$validator" "$current"; then
    printf '%s\n' "$current"
    return 0
  fi
  [ -n "$current" ] && note "  $key in the settings does not look right: it will be asked again"
  i=0
  while [ "$i" -lt 3 ]; do
    printf '  %s: ' "$prompt" >&2
    IFS= read -r answer || answer=""
    if "$validator" "$answer"; then
      printf '%s\n' "$answer"
      return 0
    fi
    [ -n "$answer" ] && note "  that does not look like $hint"
    i=$((i + 1))
  done
  note "  three tries, nothing accepted for $key"
  printf '\n'
  return 1
}

first_run_dialogue() {
  # a value already given through the environment wins: that is what makes the install unattended
  MSE_BOT_TOKEN="${MSE_BOT_TOKEN:-$(env_get MSE_BOT_TOKEN)}"
  MSE_OWNER_ID="${MSE_OWNER_ID:-$(env_get MSE_OWNER_ID)}"
  MSE_TAILSCALE_KEY="${MSE_TAILSCALE_KEY:-$(env_get MSE_TAILSCALE_KEY)}"

  [ "$WITH_TUNNEL" = "1" ] || MSE_TAILSCALE_KEY="${MSE_TAILSCALE_KEY:-skip}"
  [ "$WITH_BOT" = "1" ] || MSE_BOT_TOKEN="${MSE_BOT_TOKEN:-skip}"

  if valid_token "$MSE_BOT_TOKEN" && valid_owner "$MSE_OWNER_ID" && { [ "$WITH_TUNNEL" != "1" ] || valid_tskey "$MSE_TAILSCALE_KEY"; }; then
    say "  keys:      bot token, owner id and tailscale key are already in place"
    return 0
  fi

  say ""
  say "  ── first run: three values, and the stack comes up complete ──────────────"
  say "  1. bot token        @BotFather -> /newbot (or /token), the line 1234567890:AAH..."
  say "  2. owner id         your numeric telegram id; the bot answers only this account"
  say "  3. tailscale key    the keys page of your tailnet, tskey-auth-... (the tunnel comes up at once)"
  say ""

  if [ "$ASSUME_YES" = "1" ] || ! { [ -t 0 ] && [ -t 1 ]; }; then
    # nobody to ask: say exactly what to run, and install everything that does not need these values
    if ! valid_token "$MSE_BOT_TOKEN"; then
      note "the bot token is required, and this shell cannot ask for it."
      note "  run:  MSE_BOT_TOKEN=1234567890:AAH... MSE_OWNER_ID=<your id> MSE_TAILSCALE_KEY=tskey-auth-... bash install.sh --update --yes"
      note "  or:   sudo mse   ->  Model, Quota & Keys   (bot token, owner id, tailscale key)"
    fi
    if ! valid_owner "$MSE_OWNER_ID"; then
      note "the owner id is required (the numeric telegram id the bot answers)."
      note "  find it: message @userinfobot once, it answers with your id"
    fi
    if [ "$WITH_TUNNEL" = "1" ] && ! valid_tskey "$MSE_TAILSCALE_KEY"; then
      note "the tailscale auth key is required for the tunnel (https://login.tailscale.com/admin/settings/keys)."
      note "  without it the router installs and answers on 127.0.0.1 only"
    fi
    FIRST_RUN_UNANSWERED=1
    return 0
  fi

  if ! valid_token "$MSE_BOT_TOKEN"; then
    MSE_BOT_TOKEN="$(ask_one bot_token "bot token" "a bot token (1234567890:AAH...)" valid_token "$MSE_BOT_TOKEN")" || true
  fi
  if ! valid_owner "$MSE_OWNER_ID"; then
    MSE_OWNER_ID="$(ask_one owner_id "owner telegram id" "a telegram id (a number, e.g. 100000001)" valid_owner "$MSE_OWNER_ID")" || true
  fi
  if [ "$WITH_TUNNEL" = "1" ] && ! valid_tskey "$MSE_TAILSCALE_KEY"; then
    note "  the tailscale auth key: press Enter to skip the tunnel for now (it can be added later in the panel)"
    MSE_TAILSCALE_KEY="$(ask_one tailscale_key "tailscale auth key" "a tailscale auth key (tskey-auth-...)" valid_tskey "$MSE_TAILSCALE_KEY")" || true
  fi
  say ""
  say "  keys:      bot token $([ -n "$MSE_BOT_TOKEN" ] && echo ok || echo missing)" \
      "· owner id $([ -n "$MSE_OWNER_ID" ] && echo ok || echo missing)" \
      "· tailscale key $([ -n "$MSE_TAILSCALE_KEY" ] && echo ok || echo missing)"
  return 0
}
# ------------------------------------------------------------------ packages
PKG=""
pkg_manager() {
  for m in apt-get dnf yum apk zypper pacman; do have "$m" && { PKG="$m"; return 0; }; done
  return 1
}
pkg_install() {
  [ -z "$PKG" ] && return 1
  if [ "$DRY" = "1" ]; then say "  [dry] $PKG install $*"; return 0; fi
  case "$PKG" in
    apt-get)
      # a broken third-party repository must never stop the install: its errors are printed, not fatal
      apt-get update -q 2>&1 | grep -E '^(Err|E:|W:)' | sed 's/^/  apt: /' || true
      DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends "$@" >/dev/null 2>&1
      ;;
    dnf|yum) "$PKG" install -y -q "$@" >/dev/null 2>&1 ;;
    apk) apk add --quiet "$@" >/dev/null 2>&1 ;;
    zypper) zypper --quiet install -y "$@" >/dev/null 2>&1 ;;
    pacman) pacman -S --noconfirm --needed "$@" >/dev/null 2>&1 ;;
  esac
}

NODE_BIN=""
NODE_MAJOR=0
PY_BIN=""
find_node() {
  NODE_BIN="$(command -v node || true)"
  [ -n "$NODE_BIN" ] || return 1
  NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [ "$NODE_MAJOR" -ge 18 ]
}

install_deps() {
  pkg_manager || note "no known package manager: dependencies must already be in place"
  find_node || {
    say "  deps:      node is missing or older than 18 — installing"
    if [ -n "$PKG" ]; then
      pkg_install ca-certificates curl git || true
      case "$PKG" in
        apt-get)
          # the distribution node is old on many images: the NodeSource setup script is the reliable way
          if have curl; then
            curl -fsSL "https://deb.nodesource.com/setup_20.x" -o /tmp/mse-nodesource.sh 2>/dev/null \
              && run bash /tmp/mse-nodesource.sh >/dev/null 2>&1 && run rm -f /tmp/mse-nodesource.sh || true
          fi
          pkg_install nodejs || true
          ;;
        *) pkg_install nodejs npm || pkg_install node || true ;;
      esac
    fi
    find_node || die "node 18+ could not be installed: install it and run this again"
  }
  say "  node:      $("$NODE_BIN" -v)"

  if [ "$WITH_BOT" = "1" ] && [ "$WITH_VENV" = "1" ]; then
    PY_BIN="$(command -v python3 || true)"
    if [ -z "$PY_BIN" ]; then
      say "  deps:      python3 is missing — installing"
      pkg_install python3 python3-venv python3-pip || pkg_install python3 || true
      PY_BIN="$(command -v python3 || true)"
    fi
    [ -n "$PY_BIN" ] || die "python3 could not be installed (needed by the bot; use --no-bot to skip it)"
    # Debian splits venv out of the main package: without it `python3 -m venv` fails with a long confusing error
    "$PY_BIN" -c 'import venv, ensurepip' >/dev/null 2>&1 || pkg_install python3-venv python3-pip || true
    say "  python:    $("$PY_BIN" -V 2>&1)"
  fi

  have curl || pkg_install curl || note "curl is missing: the tunnel and updates may not work"
  have git || pkg_install git || true
}

# ------------------------------------------------------------------ source tree
fetch_source() {
  TMP=""
  if [ -n "$SRC_DIR" ]; then
    SRC="$SRC_DIR"
    say "  code:      from $SRC (local)"
  else
    have git || die "git is required to fetch the code"
    TMP="$(mktemp -d)"
    URL="https://github.com/$REPO.git"
    say "  code:      $URL${REF:+ @ $REF}"
    if [ "$DRY" = "1" ]; then
      say "  [dry] git clone --depth 1 ${REF:+--branch $REF }$URL <tmp>/src"
      SRC="$(cd "$(dirname "$0")/../.." && pwd)"
    else
      git clone --depth 1 ${REF:+--branch "$REF"} "$URL" "$TMP/src" >/dev/null 2>&1 || die "could not clone $URL"
      SRC="$TMP/src"
    fi
  fi
  if [ -d "$SRC/Server" ]; then SRC="$SRC/Server"; fi
  if [ ! -f "$SRC/mse-router.js" ]; then
    found="$(find "$SRC" -maxdepth 3 -type f -name mse-router.js 2>/dev/null | head -1)"
    if [ -n "$found" ]; then SRC="$(dirname "$found")"; fi
  fi
  [ -f "$SRC/mse-router.js" ] || die "$SRC has no mse-router.js — this is not the MSE tree"
}

gen_token() {
  if have openssl; then openssl rand -hex 24
  elif [ -n "$NODE_BIN" ]; then "$NODE_BIN" -e 'console.log(require("crypto").randomBytes(24).toString("hex"))'
  else head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'; fi
}

env_get() { # env_get KEY -> current value from the file (empty when absent)
  [ -f "$ENV_FILE" ] || return 0
  sed -n "s/^$1=//p" "$ENV_FILE" | tail -1
}
env_set() { # env_set KEY VALUE — replace in place, never duplicates a key
  local k="$1" v="$2"
  [ -f "$ENV_FILE" ] || return 0
  if grep -q "^$k=" "$ENV_FILE"; then
    local tmp="$ENV_FILE.tmp"
    awk -v k="$k" -v v="$v" 'BEGIN{FS=OFS="="} $1==k{print k "=" v; next} {print}' "$ENV_FILE" > "$tmp" && mv "$tmp" "$ENV_FILE"
  else
    printf '%s=%s\n' "$k" "$v" >> "$ENV_FILE"
  fi
  chmod 600 "$ENV_FILE"
}

# Bind-test candidates before persisting them. The sockets are released before service startup;
# another process could still claim a selected port in that interval.
free_port() {
  "$NODE_BIN" - "$1" <<'NODE'
const net = require('net');
const crypto = require('crypto');
const exclude = Number(process.argv[2]);
let attempts = 0;
function pick() {
  if (++attempts > 1000) { console.error('no free port found'); process.exit(1); }
  const port = crypto.randomInt(20000, 60001);
  if (port === exclude) return pick();
  const s = net.createServer();
  s.once('error', pick);
  s.listen(port, '127.0.0.1', () => s.close(() => console.log(port)));
}
pick();
NODE
}
valid_port() { [[ "$1" =~ ^[0-9]+$ ]] && (( 10#$1 >= 1 && 10#$1 <= 65535 )); }
choose_ports() {
  MSE_PORT="${MSE_PORT:-$(env_get MSE_PORT)}"
  MSE_UPSTREAM_PORT="${MSE_UPSTREAM_PORT:-$(env_get MSE_UPSTREAM_PORT)}"
  if [ -n "$MSE_PORT" ]; then valid_port "$MSE_PORT" || die "invalid MSE_PORT"; MSE_PORT="$((10#$MSE_PORT))"; fi
  if [ -n "$MSE_UPSTREAM_PORT" ]; then valid_port "$MSE_UPSTREAM_PORT" || die "invalid MSE_UPSTREAM_PORT"; MSE_UPSTREAM_PORT="$((10#$MSE_UPSTREAM_PORT))"; fi
  [ -n "$MSE_PORT" ] || MSE_PORT="$(free_port "$MSE_UPSTREAM_PORT")"
  [ -n "$MSE_UPSTREAM_PORT" ] || MSE_UPSTREAM_PORT="$(free_port "$MSE_PORT")"
  [ "$MSE_PORT" != "$MSE_UPSTREAM_PORT" ] || die "router and backend ports must differ"
}

write_env() {
  if [ -f "$ENV_FILE" ]; then
    say "  settings:  already there, keeping it ($ENV_FILE)"
    UPDATE=1
    return 0
  fi
  run install -m 600 /dev/null "$ENV_FILE"
  if [ "$DRY" = "1" ]; then say "  settings:  [dry] would create $ENV_FILE"; return 0; fi
  cat > "$ENV_FILE" <<ENV
# MSE 2.0 · the only settings file. Mode 600, owner root.
#
# router (the outside world reaches it only through tailscale)
MSE_PORT=${MSE_PORT}
MSE_HOST=127.0.0.1
MSE_PUBLIC_URL=
MSE_ADMIN_TOKEN=$(gen_token)
MSE_DAILY_QUOTA=${MSE_DAILY_QUOTA:-200}
MSE_ALLOW_ORIGINS=*
# AI backend: a local port; the model key lives there and nowhere else
MSE_UPSTREAM_HOST=127.0.0.1
MSE_UPSTREAM_PORT=${MSE_UPSTREAM_PORT}
MSE_UPSTREAM_KEY=
# empty means "the default the local backend offers first": the list itself is never written down here
MSE_MODEL=${MSE_MODEL:-}
# tailscale instead of cloudflared
MSE_TAILSCALE_KEY=${MSE_TAILSCALE_KEY:-}
MSE_TAILSCALE_HOSTNAME=${MSE_TAILSCALE_HOSTNAME:-mse-gateway}
MSE_TAILSCALE_TAGS=
# telegram bot (goygram)
MSE_BOT_TOKEN=${MSE_BOT_TOKEN:-}
MSE_OWNER_ID=${MSE_OWNER_ID:-}
# optional: the MTProto transport of the bot (my.telegram.org). The bot itself needs only the token.
MSE_API_ID=${MSE_API_ID:-}
MSE_API_HASH=${MSE_API_HASH:-}
MSE_OWNER_USERNAME=${MSE_OWNER_USERNAME:-}
# the custom emoji pack (tgiosicons, as in the obhod panel): off by default, on from the bot's config screen
MSE_EMOJI=${MSE_EMOJI:-0}
MSE_ADMIN_URL=http://127.0.0.1:${MSE_PORT}
ENV
  chmod 600 "$ENV_FILE"
  say "  settings:  created ($ENV_FILE)"
}

# values handed in through the environment win over an empty file — that is what makes the install unattended
merge_env_from_environment() {
  if [ "$DRY" = "1" ]; then return 0; fi
  [ -f "$ENV_FILE" ] || return 0
  for key in MSE_BOT_TOKEN MSE_OWNER_ID MSE_OWNER_USERNAME MSE_API_ID MSE_API_HASH MSE_TAILSCALE_KEY MSE_MODEL MSE_DAILY_QUOTA MSE_UPSTREAM_PORT MSE_PORT MSE_EMOJI; do
    val="${!key:-}"
    [ -n "$val" ] || continue
    [ "$(env_get "$key")" = "$val" ] && continue
    env_set "$key" "$val"
    say "  settings:  $key taken from the environment"
  done
}

# ------------------------------------------------------------------ bot
setup_bot_env() {
  [ "$WITH_BOT" = "1" ] || return 0
  if [ "$WITH_VENV" = "1" ]; then
    [ -x "$PREFIX/venv/bin/python" ] || run "$PY_BIN" -m venv "$PREFIX/venv"
    if [ "$DRY" = "0" ]; then
      "$PREFIX/venv/bin/pip" install --quiet --upgrade pip >/dev/null 2>&1 || true
      say "  bot:       installing goygram"
      "$PREFIX/venv/bin/pip" install --quiet goygram || note "goygram did not install: the bot will not start, everything else works"
    fi
    say "  bot:       venv $PREFIX/venv"
  else
    say "  bot:       system python"
  fi
}

# ------------------------------------------------------------------ systemd
write_units() {
  have systemctl || { note "no systemctl: the router is not registered as a service"; return 0; }
  if [ "$DRY" != "0" ]; then say "  [dry] would write mse-router.service and mse-bot.service"; return 0; fi
  cat > $UNIT_DIR/mse-router.service <<UNIT
[Unit]
Description=MSE router (tailscale funnel -> local AI backend)
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=$ENV_FILE
Environment=HOME=$STATE_DIR
Environment=MSE_DATA_DIR=$STATE_DIR
Environment=MSE_STATE_DIR=$STATE_DIR
Environment=GOYGRAM_VAULT=$STATE_DIR/default.vault
WorkingDirectory=$PREFIX
ExecStart=$NODE_BIN $PREFIX/mse-router.js
Restart=always
RestartSec=3
UMask=0077
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=$STATE_DIR
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT
  cat > $UNIT_DIR/mse-bot.service <<UNIT
[Unit]
Description=MSE telegram control panel (goygram)
After=network-online.target mse-router.service
Wants=network-online.target mse-router.service

[Service]
Type=simple
EnvironmentFile=$ENV_FILE
Environment=HOME=$STATE_DIR
Environment=MSE_DATA_DIR=$STATE_DIR
Environment=MSE_STATE_DIR=$STATE_DIR
Environment=GOYGRAM_VAULT=$STATE_DIR/default.vault
Environment=MSE_ENV_FILE=$ENV_FILE
Environment=MSE_TUNNEL_SCRIPT=$BIN_DIR/mse-tunnel.sh
# goygram writes <session>.vault into the working directory: it must be the data directory, never the code tree
# (an update replaces /opt/mse, and the vault holds the mt session). The package is found through PYTHONPATH.
Environment=PYTHONPATH=$PREFIX
WorkingDirectory=$STATE_DIR
ExecStart=$PREFIX/venv/bin/python -m bot.main
Restart=always
RestartSec=5
UMask=0077
NoNewPrivileges=true
ProtectHome=read-only
ReadWritePaths=$ENV_DIR $STATE_DIR
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT
}

prepare_data_dir() {
  # one place for state.json, admin-token.txt, the tunnel state and the goygram vault: mode 700, made before the
  # units start, so nothing ever logs "state not saved: ENOENT mkdir"
  [ "$DRY" = "1" ] && { say "  [dry] data directory $STATE_DIR (mode 700)"; return 0; }
  mkdir -p "$STATE_DIR"
  chmod 700 "$STATE_DIR" 2>/dev/null || true
  # an older layout kept the vault inside the code: move it once, keep it
  if [ -f "$PREFIX/default.vault" ] && [ ! -f "$STATE_DIR/default.vault" ]; then
    mv "$PREFIX/default.vault" "$STATE_DIR/default.vault" && chmod 600 "$STATE_DIR/default.vault" 2>/dev/null || true
    say "  data:      the vault moved to $STATE_DIR/default.vault"
  fi
  say "  data:      $STATE_DIR (mode 700)"
}

start_services() {
  have systemctl || return 0
  run systemctl daemon-reload
  run systemctl enable mse-router.service >/dev/null 2>&1 || true
  run systemctl restart mse-router.service || note "mse-router did not start: journalctl -u mse-router -n 40"
  # the router is the health probe the panel and the bot read: give it a moment, then say what really happened
  if have curl; then
    ready=0
    for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
      if curl -fsS "http://127.0.0.1:${MSE_PORT}/health" >/dev/null 2>&1; then ready=1; break; fi
      sleep 1
    done
    if [ "$ready" = "1" ]; then
      say "  router:    http://127.0.0.1:${MSE_PORT}/health answers"
    else
      note "the router did not answer on 127.0.0.1:${MSE_PORT} after 15 s"
      note "look at it with:  journalctl -u mse-router -n 40 --no-pager"
      note "restart it with:  sudo mse  ->  Service Control  ->  Restart mse-router"
    fi
  fi
  if [ "$WITH_BOT" = "1" ] && [ -n "$(env_get MSE_BOT_TOKEN)" ]; then
    run systemctl enable mse-bot.service >/dev/null 2>&1 || true
    run systemctl restart mse-bot.service || note "mse-bot did not start: journalctl -u mse-bot -n 40"
    say "  bot:       mse-bot.service is running"
  elif [ "$WITH_BOT" = "1" ]; then
    note "the bot was NOT started: it has no token, and the token is required."
    note "one step to fix it:  MSE_BOT_TOKEN=1234567890:AAH... bash $PREFIX/stack/install.sh --update --yes"
    note "or from the panel:   sudo mse  ->  Keys  ->  bot token"
  fi
}

# ------------------------------------------------------------------ tunnel
wait_for_router() {
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    curl -fsS "http://127.0.0.1:${MSE_PORT}/health" >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 0
}

setup_tunnel() {
  [ "$WITH_TUNNEL" = "1" ] || return 0
  if [ "$DRY" = "1" ]; then say "  [dry] tailscale install / up / funnel / wait for the url"; return 0; fi
  have mse-tunnel.sh || { note "mse-tunnel.sh is not in PATH: skipping the tunnel"; return 0; }

  if ! have tailscale; then
    say "  tunnel:    installing tailscale"
    # the official repository only, with an isolated sourcelist: a broken third-party mirror cannot break it
    if [ "$PKG" = "apt-get" ] && have curl; then
      distro="$(. /etc/os-release 2>/dev/null && echo "$ID")"
      codename="$(. /etc/os-release 2>/dev/null && echo "$VERSION_CODENAME")"
      if [ -n "$distro" ] && [ -n "$codename" ]; then
        curl -fsSL "https://pkgs.tailscale.com/stable/$distro/$codename.noarmor.gpg" \
          | tee /usr/share/keyrings/tailscale-archive-keyring.gpg >/dev/null 2>&1 || true
        echo "deb [signed-by=/usr/share/keyrings/tailscale-archive-keyring.gpg] https://pkgs.tailscale.com/stable/$distro $codename main" \
          > /etc/apt/sources.list.d/tailscale.list
        apt-get update -q -o Dir::Etc::sourcelist=/etc/apt/sources.list.d/tailscale.list \
          -o Dir::Etc::sourceparts=- -o APT::Get::List-Cleanup=0 >/dev/null 2>&1 || true
        DEBIAN_FRONTEND=noninteractive apt-get install -y -q tailscale >/dev/null 2>&1 || true
      fi
    else
      pkg_install tailscale || true
    fi
  fi
  if have tailscale; then
    say "  tunnel:    tailscale $(tailscale version 2>/dev/null | head -1)"
  else
    note "tailscale could not be installed: the tunnel stays off (https://tailscale.com/download)"
    return 0
  fi

  key="$(env_get MSE_TAILSCALE_KEY)"
  if [ -z "$key" ]; then
    note "no tailscale key: the tunnel stays down, the router answers on 127.0.0.1 only"
    note "  add it later:  sudo mse  ->  Tunnel  ->  tailscale up   (or MSE_TAILSCALE_KEY=tskey-auth-... then --update)"
    return 0
  fi

  say "  tunnel:    tailscale up"
  MSE_ENV_FILE="$ENV_FILE" MSE_STATE_DIR="$STATE_DIR" mse-tunnel.sh up \
    || note "tailscale up failed: the panel shows why (Tunnel -> Status)"

  say "  tunnel:    funnel -> 127.0.0.1:${MSE_PORT}"
  url=""
  i=0
  while [ "$i" -lt 3 ]; do
    url="$(MSE_ENV_FILE="$ENV_FILE" MSE_STATE_DIR="$STATE_DIR" mse-tunnel.sh funnel "${MSE_PORT}" 2>/dev/null | tail -1 || true)"
    case "$url" in https://*) break ;; esac
    i=$((i + 1))
    sleep 2
  done
  case "$url" in
    https://*)
      env_set MSE_PUBLIC_URL "$url"
      say "  tunnel:    $url"
      # the certificate of a fresh node is not ready the second funnel comes on: wait for the outside to answer,
      # and only then let the router read the address (its /health must carry it, and the owner checks it from a phone)
      say "  tunnel:    waiting for https from the outside (up to 60s)"
      if have mse-tunnel.sh MSE_ENV_FILE="$ENV_FILE" MSE_STATE_DIR="$STATE_DIR" mse-tunnel.sh wait --timeout 60 --quiet; then
        # the address the tunnel reports after the wait is the same one: take it only if it is really an address, so a
        # silent helper can never blank what the funnel already wrote
        fresh="$(MSE_ENV_FILE="$ENV_FILE" MSE_STATE_DIR="$STATE_DIR" mse-tunnel.sh url 2>/dev/null | tail -1 || true)"
        case "$fresh" in
          https://*) url="$fresh"; env_set MSE_PUBLIC_URL "$url" ;;
        esac
        say "  tunnel:    https answers from the outside"
      else
        note "the address does not answer from the outside yet"
        note "  this is usually the tailnet certificate: allow Funnel for this node, then  mse-tunnel.sh wait --timeout 180"
        note "  the panel repeats it in one step: sudo mse -> Tunnel -> Status"
      fi
      PUBLIC_URL_SET=1
      ;;
    *)
      note "funnel did not report an address: allow Funnel for this node in the tailnet ACL"
      note "  the panel does the same in one step: sudo mse -> Tunnel -> funnel"
      ;;
  esac
}

# after the address exists the router has to read it again: it starts before the tunnel could possibly be up
restart_router_after_tunnel() {
  [ "${PUBLIC_URL_SET:-0}" = "1" ] || return 0
  have systemctl || return 0
  say "  router:    restarting to pick up the public address"
  run systemctl restart mse-router.service || note "mse-router did not restart: journalctl -u mse-router -n 40"
  if have curl; then
    ok=0
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      if curl -fsS "http://127.0.0.1:${MSE_PORT}/health" >/dev/null 2>&1; then ok=1; break; fi
      sleep 1
    done
    [ "$ok" = "1" ] && say "  router:    answers, with the address in /health" \
                    || note "the router does not answer after the restart: journalctl -u mse-router -n 40"
  fi
}

# the last thing the installer does: check that what it promised is actually running
final_report() {
  [ "$DRY" = "1" ] && return 0
  have systemctl || return 0
  say ""
  for unit in mse-router mse-bot; do
    [ "$unit" = "mse-bot" ] && [ "$WITH_BOT" != "1" ] && continue
    state="$(systemctl is-active "$unit" 2>/dev/null || echo unknown)"
    if [ "$state" = "active" ]; then
      say "  $unit: active"
    elif [ "$unit" = "mse-bot" ] && [ -z "$(env_get MSE_BOT_TOKEN)" ]; then
      say "  $unit: off (no token: add it with sudo mse -> Model, Quota & Keys)"
    else
      note "$unit: $state — journalctl -u $unit -n 40 --no-pager"
    fi
  done
  if [ "$WITH_TUNNEL" = "1" ] && have mse-tunnel.sh; then
    status="$(MSE_ENV_FILE="$ENV_FILE" MSE_STATE_DIR="$STATE_DIR" mse-tunnel.sh status --json 2>/dev/null || true)"
    case "$status" in
      *'"url": null'* | *'"url":null'* | "")
        note "tunnel: no address yet (panel -> Tunnel -> up / funnel)"
        ;;
      *)
        say "  tunnel: address in place"
        ;;
    esac
  fi
}

# ------------------------------------------------------------------ main
ensure_root "$@"
say "MSE 2.2 · installer"
say "  prefix:    $PREFIX"
say "  settings:  $ENV_FILE"
say "  state:     $STATE_DIR"
if [ "$UPDATE" = "1" ]; then say "  mode:      update (settings and state are kept)"; fi

install_deps
fetch_source

run mkdir -p "$PREFIX" "$ENV_DIR" "$STATE_DIR" "$PREFIX/logs" "$UNIT_DIR" "$BIN_DIR"
if [ "$UPDATE" = "1" ] && [ "$DRY" = "0" ]; then
  # an update replaces the code only: settings, devices and the allow list stay where they are
  find "$PREFIX" -mindepth 1 -maxdepth 1 ! -name venv ! -name logs -exec rm -rf {} + 2>/dev/null || true
fi
run cp -r "$SRC/." "$PREFIX/"
run chmod 755 "$PREFIX/stack/mse-tunnel.sh" "$PREFIX/stack/install.sh"
run ln -sf "$PREFIX/stack/mse-tunnel.sh" "$BIN_DIR/mse-tunnel.sh"
say "  code:      installed into $PREFIX"

first_run_dialogue
choose_ports
write_env
merge_env_from_environment
if [ "$DRY" = "0" ]; then
  env_set MSE_ADMIN_URL "http://127.0.0.1:${MSE_PORT}"
fi
setup_bot_env
prepare_data_dir
write_units
start_services

# the panel: `sudo mse` opens it, `sudo mse update` updates the stack, `sudo mse --status` reports and exits
if [ "$DRY" = "0" ]; then
  rm -f "$PREFIX/stack/tui.py" 2>/dev/null || true
  cat > "$BIN_DIR/mse" <<PANEL
#!/usr/bin/env bash
# MSE panel — the control screen, run it as: sudo mse
case "\${1:-}" in
  update|upgrade) shift; exec bash $PREFIX/stack/install.sh --update "\$@" ;;
esac
exec $PY_BIN $PREFIX/stack/mse_setup.py "\$@"
PANEL
  chmod 755 "$BIN_DIR/mse"
fi
say "  panel:     sudo mse   (update: sudo mse update)"

# install -> tunnel up + funnel -> router restart (the router starts before the address can exist)
setup_tunnel
restart_router_after_tunnel
final_report

if [ -n "${TMP:-}" ]; then rm -rf "$TMP"; fi

say ""
if [ "$UPDATE" = "1" ]; then
  say "updated. Settings, devices and the allow list were kept."
else
  say "done. Next:"
fi
say "  sudo mse                     panel: health, install, services, tunnel, model and keys"
say "  sudo mse update              update the code and dependencies in place"
say "  curl localhost:${MSE_PORT}/health"
say "  journalctl -u mse-router -f"
