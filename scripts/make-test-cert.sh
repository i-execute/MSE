#!/usr/bin/env bash
# A self-signed certificate for the tests ONLY: the gateway serves https on 127.0.0.1 and the browser is told to
# trust it (ignoreHTTPSErrors). No certificate lives in the repository, and none can: the key is generated on the
# spot and is never committed.
#
#   bash scripts/make-test-cert.sh [directory]
set -euo pipefail
DIR="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/tests/fixtures/tls}"
mkdir -p "$DIR"
if [ -f "$DIR/cert.pem" ] && [ -f "$DIR/key.pem" ]; then
  printf '%s\n' "$DIR"
  exit 0
fi
command -v openssl >/dev/null 2>&1 || { echo "openssl is required" >&2; exit 2; }
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -keyout "$DIR/key.pem" -out "$DIR/cert.pem" \
  -subj "/CN=127.0.0.1" -addext "subjectAltName=IP:127.0.0.1,DNS:localhost" >/dev/null 2>&1
chmod 600 "$DIR/key.pem"
printf '%s\n' "$DIR"
