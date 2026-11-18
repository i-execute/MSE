#!/usr/bin/env bash
# MSE 2.2 — one-line install of the server (router + AI bridge + telegram bot + tailscale tunnel).
#
#     curl -fsSL https://raw.githubusercontent.com/i-execute/MSE/main/Storage/get.sh | bash
#
# This file is a small launcher: it finds Server/stack/install.sh in the repository (or in a local checkout) and
# hands the work over to it, so the install lives in exactly one place.
#
# Nothing but a shell is required. install.sh installs the missing packages itself (node, python3, git, curl,
# tailscale), asks for sudo when it needs root, and on the first run asks for the three values it cannot invent:
# the bot token, the owner id and the tailscale auth key. With them in hand it starts the router, brings the
# tailscale tunnel up, turns the funnel on, restarts the router so it picks the public address up, and then
# checks that both units are active and the address is in place — one session, a working stack at the end.
#
# A pipe cannot answer questions, so in that case the same three values are printed as exact commands to run
# later. Passing them straight through makes the whole install unattended:
#
#     MSE_BOT_TOKEN=123:ABC MSE_OWNER_ID=12345 MSE_TAILSCALE_KEY=tskey-auth-... \
#       bash -c "$(curl -fsSL .../Storage/get.sh)"
#
# What ends up on the machine:
#   /opt/mse/            the code (router, bot, panel, tunnel script)
#   /opt/mse/venv/       python environment of the bot (goygram)
#   /etc/mse/mse.env     the only settings file (mode 600)
#   /var/lib/mse/        state (devices, allow list, log, admin token)
#   /usr/local/bin/mse           the panel (`sudo mse`, `sudo mse update`)
#   /usr/local/bin/mse-tunnel.sh tailscale: up / funnel / serve / status
#   systemd: mse-router.service, mse-bot.service
#
# Flags are passed to install.sh: --yes, --update, --dry-run, --no-bot, --no-tunnel, --no-venv.
set -euo pipefail

# A pipe has no terminal: the installer must know that before it tries to ask anything.
: "${MSE_UNATTENDED:=}"

REPO="${MSE_REPO:-i-execute/MSE}"
REF="${MSE_REF:-main}"
say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# a local checkout next to this file wins: it is faster and works offline
self_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || echo .)"
for candidate in "$self_dir/../Server/stack/install.sh" "$self_dir/Server/stack/install.sh"; do
  if [ -f "$candidate" ]; then
    say "MSE · using the local tree: $candidate"
    exec bash "$candidate" "$@"
  fi
done

have curl || { pkg=apt-get; have dnf && pkg=dnf; have apk && pkg=apk; "$pkg" install -y curl >/dev/null 2>&1 || true; }
have curl || die "curl is required (and could not be installed)"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
say "MSE · fetching the installer"
curl -fsSL "https://raw.githubusercontent.com/$REPO/$REF/Server/stack/install.sh" -o "$TMP/install.sh" \
  || die "could not download the installer from $REPO@$REF"

# the installer runs from a pipe above, so it may not be able to read stdin: give it an empty one
exec bash "$TMP/install.sh" "$@" < /dev/null
