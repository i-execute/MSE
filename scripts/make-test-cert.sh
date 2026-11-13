#!/usr/bin/env bash
# Самоподписанный сертификат ТОЛЬКО для тестов: шлюз слушает https на 127.0.0.1, браузер ему доверяет
# (ignoreHTTPSErrors). В репозитории сертификата нет и быть не может: ключ генерируется на месте и не
# коммитится.
#
#   bash scripts/make-test-cert.sh [каталог]
set -euo pipefail
DIR="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/tests/fixtures/tls}"
mkdir -p "$DIR"
if [ -f "$DIR/cert.pem" ] && [ -f "$DIR/key.pem" ]; then
  printf '%s\n' "$DIR"
  exit 0
fi
command -v openssl >/dev/null 2>&1 || { echo "нужен openssl" >&2; exit 2; }
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -keyout "$DIR/key.pem" -out "$DIR/cert.pem" \
  -subj "/CN=127.0.0.1" -addext "subjectAltName=IP:127.0.0.1,DNS:localhost" >/dev/null 2>&1
chmod 600 "$DIR/key.pem"
printf '%s\n' "$DIR"
