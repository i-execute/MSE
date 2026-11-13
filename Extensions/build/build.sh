#!/usr/bin/env bash
# Сборка userscript — одно место, из которого получается один и тот же файл для всех клиентов.
#
#     bash Extensions/build/build.sh            → Storage/artifacts/mse.user.js
#     MSE_VENDOR=/path/to/syncshare-2.22.0 …    → другой вендорский слой (см. ниже)
#
# Что нужно: node 18+ и вендорская папка исходной сборки (syncshare-2.22.0). В репозитории её нет и быть не
# может — это чужая сборка. Путь берётся из MSE_VENDOR, по умолчанию: vendor/syncshare-2.22.0, затем
# ../vendor/syncshare-2.22.0 (рядом с репозиторием).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT_DIR="$ROOT/Storage/artifacts"

find_vendor() {
  local candidate
  for candidate in "${MSE_VENDOR:-}" "$ROOT/vendor/syncshare-2.22.0" "$ROOT/../vendor/syncshare-2.22.0" "$ROOT/../syncshare-stay/vendor/syncshare-2.22.0"; do
    [ -n "$candidate" ] && [ -f "$candidate/manifest.json" ] && { printf '%s' "$candidate"; return 0; }
  done
  return 1
}

VENDOR="$(find_vendor || true)"
if [ -z "$VENDOR" ]; then
  cat >&2 <<'MSG'
error: вендорская папка не найдена.

Сборщик собирает userscript поверх сборки-оригинала (syncshare-2.22.0). Её нет в репозитории:
это чужая сборка, и раскладывать её по публичному репозиторию нельзя.

  MSE_VENDOR=/path/to/syncshare-2.22.0 bash Extensions/build/build.sh

если папки нет совсем — уже собранный userscript лежит в Storage/artifacts/mse.user.js.
MSG
  exit 2
fi

export MSE_ROOT="$ROOT"
export MSE_VENDOR_DIR="$VENDOR"
export MSE_OUT_DIR="$OUT_DIR/mse.user.js"
mkdir -p "$OUT_DIR"
node "$HERE/build-mse.js"
ls -l "$OUT_DIR/mse.user.js"
msg=$(grep -m1 '^// @version' "$OUT_DIR/mse.user.js" || true)
[ -n "$msg" ] && printf '%s\n' "$msg"
