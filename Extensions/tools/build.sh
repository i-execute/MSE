#!/usr/bin/env bash
# The userscript build — the one place that produces the same file for every client.
#
#     bash Extensions/tools/build.sh            → Storage/artifacts/mse.user.js
#     MSE_VENDOR=/path/to/syncshare-2.22.0 …    → a different vendor layer (see below)
#
# What it needs: node 18+ and the vendor folder of the original build (syncshare-2.22.0). It is not in the
# repository and cannot be — it is somebody else's build. The path comes from MSE_VENDOR, default: vendor/syncshare-2.22.0, then
# ../vendor/syncshare-2.22.0 (next to the repository).
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
error: the vendor folder was not found.

The build wraps the userscript around the original build (syncshare-2.22.0). It is not in the repository:
it is somebody else's build and must not be put into a public repository.

  MSE_VENDOR=/path/to/syncshare-2.22.0 bash Extensions/tools/build.sh

if the folder is not there at all, an already built userscript is in Storage/artifacts/mse.user.js.
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
