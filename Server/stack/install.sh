#!/usr/bin/env bash
# MSE 2.0 — установка сервера «обход + AI-мост» одной командой:
#
#     curl -fsSL https://raw.githubusercontent.com/i-execute/MSE/main/Storage/get.sh | sudo bash
#
# (get.sh скачивает релиз и зовёт этот файл; руками его тоже можно: MSE_SRC_DIR=<клон репозитория> bash install.sh)
#
# Что ставится:
#   /opt/mse/            код (роутер, бот, TUI, скрипт туннеля)
#   /opt/mse/venv/       python-окружение бота (goygram)
#   /etc/mse/mse.env     единственный файл настроек (права 600)
#   /var/lib/mse/        состояние (устройства, allow-лист, журнал, admin-токен)
#   /usr/local/bin/mse           TUI (как `sudo obhod` в OBHOD)
#   /usr/local/bin/mse-tunnel.sh tailscale: up / funnel / serve / status
#   systemd: mse-router.service, mse-bot.service
#
# Флаги: --yes (без вопросов, всё из env или по умолчанию), --no-venv, --no-bot, --no-tunnel, --dry-run.
set -euo pipefail

REPO="${MSE_REPO:-i-execute/MSE}"
REF="${MSE_REF:-}"
SRC_DIR="${MSE_SRC_DIR:-}"
PREFIX="${MSE_PREFIX:-/opt/mse}"
ENV_DIR="/etc/mse"
ENV_FILE="$ENV_DIR/mse.env"
STATE_DIR="/var/lib/mse"
ASSUME_YES=0
WITH_VENV=1
WITH_BOT=1
WITH_TUNNEL=1
DRY=0

for arg in "$@"; do
  case "$arg" in
    --yes|-y) ASSUME_YES=1 ;;
    --no-venv) WITH_VENV=0 ;;
    --no-bot) WITH_BOT=0 ;;
    --no-tunnel) WITH_TUNNEL=0 ;;
    --dry-run) DRY=1 ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "неизвестный флаг: $arg" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
note() { printf '%s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
run() { if [ "$DRY" = "1" ]; then say "  [dry] $*"; else "$@"; fi; }
need_root() {
  if [ "$DRY" = "1" ] || [ "${MSE_ALLOW_NONROOT:-0}" = "1" ]; then return 0; fi
  [ "$(id -u)" = "0" ] || die "нужен root: sudo bash install.sh"
}
have() { command -v "$1" >/dev/null 2>&1; }

need_root
say "MSE 2.0 · установка"
say "  префикс:  $PREFIX"
say "  настройки: $ENV_FILE"
say "  состояние: $STATE_DIR"

# ---------------------------------------------------------------- 1. что уже есть на машине
have node || die "нужен node (18+): apt-get install -y nodejs"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || die "node слишком старый: $NODE_MAJOR (нужен 18+)"
say "  node:      $(node -v)"

if [ "$WITH_BOT" = "1" ] && [ "$WITH_VENV" = "1" ]; then
  have python3 || die "нужен python3 (для бота) или запустите с --no-bot"
  say "  python:    $(python3 -V)"
fi

# ---------------------------------------------------------------- 2. код
TMP=""
if [ -n "$SRC_DIR" ]; then
  SRC="$SRC_DIR"
  say "  код:       из $SRC (локально)"
else
  have git || die "нужен git (или --src через MSE_SRC_DIR)"
  TMP="$(mktemp -d)"
  URL="https://github.com/$REPO.git"
  say "  код:       $URL${REF:+ @ $REF}"
  run git clone --depth 1 ${REF:+--branch "$REF"} "$URL" "$TMP/src" >/dev/null 2>&1 || die "не удалось клонировать $URL"
  SRC="$TMP/src"
fi
# the tree may be the repository root, Server/ itself, or a release archive that unpacked to mse-<ver>/
[ -d "$SRC/Server" ] && SRC="$SRC/Server"
if [ ! -f "$SRC/mse-router.js" ]; then
  found="$(find "$SRC" -maxdepth 3 -type f -name mse-router.js 2>/dev/null | head -1)"
  [ -n "$found" ] && SRC="$(dirname "$found")"
fi
[ -f "$SRC/mse-router.js" ] || die "в $SRC нет mse-router.js — это не дерево MSE"
run mkdir -p "$PREFIX" "$ENV_DIR" "$STATE_DIR" /opt/mse/logs
run cp -r "$SRC/." "$PREFIX/"
run chmod 755 "$PREFIX/stack/mse-tunnel.sh" "$PREFIX/stack/install.sh"
run ln -sf "$PREFIX/stack/mse-tunnel.sh" /usr/local/bin/mse-tunnel.sh
say "  код:       установлен в $PREFIX"

# ---------------------------------------------------------------- 3. настройки
gen_token() { if have openssl; then openssl rand -hex 24; else node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"; fi; }
if [ -f "$ENV_FILE" ]; then
  say "  настройки: уже есть, не трогаю"
else
  ADMIN="$(gen_token)"
  run install -m 600 /dev/null "$ENV_FILE"
  if [ "$DRY" = "0" ]; then
    cat > "$ENV_FILE" <<ENV
# MSE 2.0 · единственный файл настроек. Права 600, владелец root.
#
# роутер (снаружи только через tailscale)
MSE_PORT=8788
MSE_HOST=127.0.0.1
MSE_PUBLIC_URL=
MSE_ADMIN_TOKEN=$ADMIN
MSE_DAILY_QUOTA=200
MSE_ALLOW_ORIGINS=*
# AI-бэкенд: локальный порт, ключ модели живёт ТОЛЬКО там
MSE_UPSTREAM_HOST=127.0.0.1
MSE_UPSTREAM_PORT=8799
MSE_UPSTREAM_KEY=
MSE_MODEL=gemini-3-flash
MSE_MODELS=gemini-3-flash,gpt-4o-mini
# tailscale вместо cloudflared
MSE_TAILSCALE_KEY=
MSE_TAILSCALE_HOSTNAME=mse-gateway
MSE_TAILSCALE_TAGS=
# бот (goygram)
MSE_BOT_TOKEN=
MSE_OWNER_ID=
MSE_OWNER_USERNAME=
MSE_ADMIN_URL=http://127.0.0.1:8788
ENV
  fi
  say "  настройки: созданы ($ENV_FILE)"
  if [ "$ASSUME_YES" = "0" ] && [ -t 0 ]; then
    note ""
    note "Впишите значения в $ENV_FILE (или запустите TUI: sudo mse)."
    note "Минимум: MSE_TAILSCALE_KEY, MSE_BOT_TOKEN, MSE_OWNER_ID, MSE_MODEL."
  fi
fi

# ---------------------------------------------------------------- 4. окружение бота
if [ "$WITH_BOT" = "1" ]; then
  if [ "$WITH_VENV" = "1" ]; then
    if [ ! -x "$PREFIX/venv/bin/python" ]; then
      run python3 -m venv "$PREFIX/venv"
    fi
    if [ "$DRY" = "0" ]; then
      "$PREFIX/venv/bin/pip" install --quiet --upgrade pip >/dev/null 2>&1 || true
      "$PREFIX/venv/bin/pip" install --quiet goygram || note "goygram не установился: бот не поднимется, остальное работает"
    fi
    say "  бот:       venv $PREFIX/venv"
  else
    say "  бот:       системный python"
  fi
fi

# ---------------------------------------------------------------- 5. systemd
if have systemctl; then
  if [ "$DRY" = "0" ]; then
    cat > /etc/systemd/system/mse-router.service <<UNIT
[Unit]
Description=MSE router (tailscale funnel → local AI backend)
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=$ENV_FILE
Environment=HOME=/root
WorkingDirectory=$PREFIX
ExecStart=$(command -v node) $PREFIX/mse-router.js
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
    cat > /etc/systemd/system/mse-bot.service <<UNIT
[Unit]
Description=MSE telegram control panel (goygram)
After=network-online.target mse-router.service
Wants=network-online.target mse-router.service

[Service]
Type=simple
EnvironmentFile=$ENV_FILE
Environment=HOME=/root
Environment=MSE_ENV_FILE=$ENV_FILE
Environment=MSE_TUNNEL_SCRIPT=/usr/local/bin/mse-tunnel.sh
WorkingDirectory=$PREFIX
ExecStart=$PREFIX/venv/bin/python -m bot
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
  fi
  run systemctl daemon-reload
  run systemctl enable mse-router.service >/dev/null 2>&1 || true
  [ "$WITH_BOT" = "1" ] && run systemctl enable mse-bot.service >/dev/null 2>&1 || true
  run systemctl restart mse-router.service || note "mse-router не стартовал: journalctl -u mse-router"
  if [ "$WITH_BOT" = "1" ] && grep -q '^MSE_BOT_TOKEN=..*' "$ENV_FILE" 2>/dev/null; then
    run systemctl restart mse-bot.service || note "mse-bot не стартовал: journalctl -u mse-bot"
  else
    note "бот не запущен: MSE_BOT_TOKEN пуст (или --no-bot)"
  fi
  say "  systemd:   mse-router.service, mse-bot.service"
else
  note "systemctl нет: роутер не зарегистрирован как сервис"
fi

# ---------------------------------------------------------------- 6. TUI
if [ "$DRY" = "0" ]; then
  cat > /usr/local/bin/mse <<TUI
#!/usr/bin/env bash
exec python3 $PREFIX/stack/tui.py "\$@"
TUI
  chmod 755 /usr/local/bin/mse
fi
say "  TUI:       sudo mse"

# ---------------------------------------------------------------- 7. туннель
if [ "$WITH_TUNNEL" = "1" ]; then
  if [ "$DRY" = "0" ] && have mse-tunnel.sh; then
    mse-tunnel.sh install || note "tailscale не установился: поставьте вручную"
    if grep -q '^MSE_TAILSCALE_KEY=..*' "$ENV_FILE"; then
      MSE_ENV_FILE="$ENV_FILE" MSE_STATE_DIR="$STATE_DIR" mse-tunnel.sh up || note "tailscale up не сработал: sudo mse → туннель"
      MSE_ENV_FILE="$ENV_FILE" MSE_STATE_DIR="$STATE_DIR" mse-tunnel.sh funnel "${MSE_PORT:-8788}" >/dev/null \
        && say "  tunnel:    $(MSE_ENV_FILE="$ENV_FILE" MSE_STATE_DIR="$STATE_DIR" mse-tunnel.sh url)" \
        || note "funnel не включился: разрешите его в ACL tailnet (sudo mse → туннель)"
    else
      note "адрес появится после MSE_TAILSCALE_KEY (или tailscale up в TUI)"
    fi
  fi
fi

[ -n "$TMP" ] && rm -rf "$TMP" || true

say ""
say "готово. Дальше:"
say "  sudo mse                 — панель управления (туннель, модель, токены, статус)"
say "  curl localhost:8788/health"
say "  journalctl -u mse-router -f"
