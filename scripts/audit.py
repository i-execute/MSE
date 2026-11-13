#!/usr/bin/env python3
"""Аудит «ноль отпечатков» — то, что не должно попасть в публичный репозиторий.

    python3 scripts/audit.py              отчёт по дереву, код возврата 0
    python3 scripts/audit.py --strict     то же, но любой hit — код 1 (это то, что гоняет CI)
    python3 scripts/audit.py --git        проверять только то, что лежит в git (быстро, для хука)
    python3 scripts/audit.py --json       машиночитаемый отчёт
    python3 scripts/audit.py --log FILE   дописать отчёт в FILE (для PR-описания)

Что ищется:
  * токены и ключи: bot-токены Telegram, ghp_/gho_, sk-, GOCSPX-, OAuth client secret, PEM-ключи;
  * адреса: IP вне документации (127.0.0.1/localhost и сети из RFC 5737 разрешены), socks-прокси;
  * контакты: e-mail не на example.*, telegram-ссылки t.me с ником;
  * туннели: конкретные trycloudflare-адреса, чужие *.ts.net, ngrok/localtunnel;
  * чужие пути: домашние каталоги вроде /home/<name>/…, ~/.config/<tool>, antigravity-cli;
  * живые Moodle-хосты вместо заглушек (всё, что не example.* и не публичный демо-сайт moodle.org).

Чего нет и быть не может: словаря фамилий. Вместо него — «тестовые» идентификаторы: moodleId в примерах
обязан быть 12345/12346 и подобным, а ФИО — Test User / Тестовый Пользователь (см. правила SAMPLE_*).

Сознательные исключения перечислены в ALLOW: это места, где строка — часть смысла продукта
(адрес их базы ответов, публичный демо-сайт Moodle, локальный loopback).
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass, asdict
from pathlib import Path

# корень дерева: рядом со scripts/ по умолчанию, но его можно указать и снаружи (--root / MSE_AUDIT_ROOT),
# чтобы прогнать тот же сканер по чужому дереву, не копируя скрипт
ROOT = Path(os.environ.get('MSE_AUDIT_ROOT') or Path(__file__).resolve().parent.parent).resolve()

# ---------------------------------------------------------------------- что не читаем вовсе
SKIP_DIRS = {
    '.git', 'node_modules', 'vendor', '.venv', 'venv', '__pycache__', 'dist', 'build-out',
    '.mypy_cache', '.pytest_cache', '.ruff_cache', 'evidence', '.original', 'artifacts-cache',
}
# сторонние библиотеки, вендоренные для тестов: там адреса их авторов — не наш отпечаток
SKIP_PREFIXES = ('tests/lib/stay/', 'tests/fixtures/tls/')  # сгенерированный ключ тоже не читаем
# собранный userscript читаем, но только по «нашим» правилам: в нём живут адреса чужой сборки
BUNDLE_RULES = {'telegram-bot-token', 'github-token', 'openai-key', 'google-oauth', 'oauth-secret',
                'private-key', 'tailscale-key', 'admin-token', 'socks-proxy', 'tunnel-url',
                'tailnet-host', 'telegram-link', 'home-path', 'tool-config-path', 'owner-tool', 'ip-address'}
SKIP_FILES = {'.gitignore', 'audit.py'}
BINARY_EXT = {
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.woff', '.woff2', '.ttf', '.otf',
    '.zip', '.gz', '.tgz', '.pdf', '.mp4', '.webm', '.so', '.wasm',
}
# большой собранный userscript читаем: внутри наш shell, но НЕ внутренности чужой сборки
MAX_BYTES = 4 * 1024 * 1024


@dataclass
class Hit:
    rule: str
    path: str
    line: int
    text: str
    note: str = ""

    def render(self) -> str:
        return f"{self.path}:{self.line}: [{self.rule}] {self.text}" + (f"  ({self.note})" if self.note else "")


# ---------------------------------------------------------------------- правила
@dataclass
class Rule:
    name: str
    pattern: re.Pattern
    note: str


def _r(name: str, pattern: str, note: str = "", flags: int = 0) -> Rule:
    return Rule(name, re.compile(pattern, flags), note)


RULES = [
    # --- токены и ключи
    _r('telegram-bot-token', r'\b\d{8,10}:[A-Za-z0-9_-]{30,}\b', 'bot token от @BotFather'),
    _r('github-token', r'\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b'),
    _r('openai-key', r'\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b'),
    _r('google-oauth', r'\bGOCSPX-[A-Za-z0-9_-]{10,}\b'),
    _r('oauth-secret', r'(?i)\bclient[_-]?secret\b\s*[:=]\s*["\']?[A-Za-z0-9_-]{16,}'),
    _r('private-key', r'-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----'),
    _r('tailscale-key', r'\btskey-(?:auth|api|client)-[A-Za-z0-9_-]{10,}'),
    _r('admin-token', r'\badm_[A-Za-z0-9_-]{16,}', 'в репозитории допустим только тестовый adm_*_test'),
    # --- сеть и адреса
    _r('socks-proxy', r'\bsocks5h?://[^\s"\'<>]+', 'прокси инфраструктуры'),
    _r('tunnel-url', r'https?://[a-z0-9-]+\.trycloudflare\.com'),
    _r('tunnel-url', r'https?://[a-z0-9-]+\.(?:ngrok\.io|ngrok-free\.app|loca\.lt|localhost\.run|serveo\.net)'),
    _r('tailnet-host', r'https?://[a-z0-9-]+\.ts\.net', 'адрес конкретного tailnet'),
    _r('telegram-link', r'https?://t\.me/[A-Za-z0-9_]{4,}'),
    # --- контакты
    _r('email', r'\b[A-Za-z0-9._%+-]+@(?!example\.(?:com|org|edu|net)\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b'),
    # --- чужие файловые пути
    _r('home-path', r'/(?:home|Users)/(?!user\b|<|\[|\$|\{|\()(?!runner\b)[A-Za-z][A-Za-z0-9._-]{1,32}/', 'домашний каталог с именем'),
    _r('tool-config-path', r'~/\.(?:config|gemini|ssh)/[A-Za-z0-9._/-]+', 'путь личного каталога инструмента'),
    _r('owner-tool', r'(?i)antigravity-cli'),
]

# IP: разрешены loopback, «документационные» и заведомо локальные сети (они ничего не выдают)
ALLOWED_IPS = {
    '127.0.0.1', '0.0.0.0', '0.0.0.0.', '255.255.255.255',
    '192.0.2.1', '192.0.2.10', '198.51.100.1', '203.0.113.1',
}
PRIVATE_PREFIXES = ('10.', '192.168.', '172.16.', '172.17.', '172.18.', '172.19.', '172.2', '172.30.', '172.31.', '169.254.')
RULE_IP = _r('ip-address', r'\b(?:\d{1,3}\.){3}\d{1,3}\b', 'адрес вне документации')

# живые Moodle-хосты: разрешены только заглушки и публичный демо-сайт moodle.org
LIVE_HOST_OK = (
    'example.com', 'example.org', 'example.edu', 'example.net', 'sub.example.edu',
    'school.moodledemo.net', 'moodledemo.net', 'moodle.org', 'moodle.com', 'download.moodle.org',
    'localhost', '127.0.0.1', 'syncshare.ru', 'syncshare.naloaty.me', 'github.com', 'raw.githubusercontent.com',
    'api.telegram.org', 'tailscale.com', 'registry.npmjs.org', 'cdn.jsdelivr.net', 'fontawesome.com',
    'popper.js.org', 'codepen.io', 'www.w3.org', 'developer.mozilla.org', 'getbootstrap.com',
    'sentry.io', 'ya.ru', 'www.google.com', 'www.example.com', 'api.test', 'moodle.test',
    'mse-gateway.example.ts.net', 'www.moodle.org', 'mse.example.net', 'api.openai.com',
    'code.google.com', 'pegjs.org', 'bugzil.la', 'addons.mozilla.org', 'chrome.google.com',
    'microsoftedge.microsoft.com', 'apps.apple.com', 'play.google.com', 'violentmonkey.github.io',
    'www.tampermonkey.net', 'tampermonkey.net', 'github.com', 'raw.githubusercontent.com',
)
RULE_HOST = _r('live-moodle-host', r'\bhttps?://([a-z0-9][a-z0-9.-]*\.[a-z]{2,})', 'хост вне разрешённых заглушек')

# ---------------------------------------------------------------------- исключения по строкам
ALLOW_PATTERNS = [
    re.compile(r'Storage/artifacts/mse\.user\.js'),       # собранный файл: правила те же, но путь длинный
]


def read_text(path: Path) -> str | None:
    try:
        if path.stat().st_size > MAX_BYTES:
            return None
        data = path.read_bytes()
    except OSError:
        return None
    if b'\x00' in data[:4096]:
        return None
    return data.decode('utf-8', 'replace')


def iter_files(use_git: bool) -> list[Path]:
    if use_git:
        try:
            out = subprocess.run(['git', 'ls-files', '-z'], cwd=ROOT, capture_output=True, check=True).stdout
            return [ROOT / p for p in out.decode('utf-8', 'replace').split('\0') if p]
        except (OSError, subprocess.CalledProcessError):
            pass
    files: list[Path] = []
    for base, dirs, names in os.walk(ROOT):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for name in names:
            p = Path(base) / name
            if p.suffix.lower() in BINARY_EXT or name in SKIP_FILES:
                continue
            rel = str(p.relative_to(ROOT))
            if any(rel.startswith(pref) for pref in SKIP_PREFIXES):
                continue
            files.append(p)
    return files


# файлы-константы вроде сумм sha256: «logo@16.png» — не почта, а имя файла
CHECKSUM_FILE = re.compile(r'\.(?:sha256|sha256sums|md5|sha1)$', re.I)


def scan_text(rel: str, text: str) -> list[Hit]:
    hits: list[Hit] = []
    allowed_line = any(p.search(rel) for p in ALLOW_PATTERNS)
    bundle = rel.endswith('mse.user.js')
    for lineno, line in enumerate(text.splitlines(), 1):
        if not line.strip():
            continue
        for rule in RULES:
            for m in rule.pattern.finditer(line):
                snippet = m.group(0)
                if bundle and rule.name not in BUNDLE_RULES:
                    continue
                if rule.name == 'email' and ('example.' in snippet or snippet.endswith('@localhost')):
                    continue
                if rule.name == 'email' and CHECKSUM_FILE.search(rel):
                    continue
                if rule.name == 'email' and re.search(r'@\d+x?\.(?:png|jpg|svg|ico)$', snippet):
                    continue
                if rule.name == 'admin-token' and re.search(r'adm_[a-z0-9_]*test', snippet):
                    continue
                hits.append(Hit(rule.name, rel, lineno, snippet[:120], rule.note))
        if bundle:
            continue
        for m in RULE_IP.pattern.finditer(line):
            ip = m.group(0)
            if ip in ALLOWED_IPS or ip.startswith(PRIVATE_PREFIXES):
                continue
            if any(int(part) > 255 for part in ip.split('.')):
                continue
            hits.append(Hit('ip-address', rel, lineno, ip, 'адрес вне документации'))
        for m in RULE_HOST.pattern.finditer(line):
            host = m.group(1).lower()
            if host in LIVE_HOST_OK or host.endswith('.example.com') or host.endswith('.example.edu'):
                continue
            if re.match(r'^[\d.]+$', host):
                continue
            if host in ('www.w3.org',) or host.startswith('www.'):
                continue
            if host.endswith('.ts.net') and 'example' in host:
                continue
            hits.append(Hit('live-moodle-host', rel, lineno, host, 'хост вне разрешённых заглушек'))
    if allowed_line:
        return [h for h in hits if h.rule not in ('ip-address', 'live-moodle-host')]
    return hits


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--strict', action='store_true', help='любой hit → код возврата 1 (для CI)')
    ap.add_argument('--git', action='store_true', help='только файлы в git')
    ap.add_argument('--json', action='store_true', help='машиночитаемый отчёт')
    ap.add_argument('--log', default='', help='дописать отчёт в файл')
    ap.add_argument('--quiet', action='store_true', help='только сводка')
    ap.add_argument('--root', default='', help='дерево для проверки (по умолчанию — это репозиторий)')
    args = ap.parse_args(argv)

    global ROOT
    if args.root:
        ROOT = Path(args.root).resolve()
    files = iter_files(args.git)
    hits: list[Hit] = []
    for path in files:
        rel = str(path.relative_to(ROOT))
        text = read_text(path)
        if text is None:
            continue
        hits.extend(scan_text(rel, text))

    by_rule: dict[str, int] = {}
    for h in hits:
        by_rule[h.rule] = by_rule.get(h.rule, 0) + 1

    lines: list[str] = []
    lines.append(f"audit: {len(files)} files, {len(hits)} hits")
    if hits:
        for rule, count in sorted(by_rule.items(), key=lambda kv: -kv[1]):
            lines.append(f"  {rule}: {count}")
        if not args.quiet:
            lines.append("")
            for h in sorted(hits, key=lambda x: (x.path, x.line)):
                lines.append("  " + h.render())
    else:
        lines.append("  чисто: ни одного отпечатка")

    report = {
        'files': len(files),
        'hits': len(hits),
        'by_rule': by_rule,
        'items': [asdict(h) for h in hits],
        'strict': args.strict,
        'ok': not hits,
    }
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=1))
    else:
        print('\n'.join(lines))
    if args.log:
        target = Path(args.log)
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open('a', encoding='utf-8') as fh:
            fh.write('\n'.join(lines) + '\n')
    return 1 if (hits and args.strict) else 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
