# tls

Здесь тесты ждут самоподписанный сертификат для `127.0.0.1` — и **ничего не коммитится**: ключ генерируется
на месте.

```bash
bash scripts/make-test-cert.sh
# → tests/fixtures/tls/{cert,key}.pem   (в .gitignore)
```

Тесты (`tests/mse.test.js`, M11/M13) зовут `tests/lib/tls.js`, который делает это сам при первом запуске.
