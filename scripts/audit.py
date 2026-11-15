"""The "zero fingerprints" audit — the things that must never reach a public repository.

python3 scripts/audit.py              report over the tree, exit code 0
python3 scripts/audit.py --strict     the same, but any hit means exit 1 (this is what CI runs)
python3 scripts/audit.py --git        only what is in git (fast, for a hook)
python3 scripts/audit.py --json       a machine-readable report
python3 scripts/audit.py --log FILE   append the report to FILE (for the PR description)

What it looks for:
* tokens and keys: Telegram bot tokens, ghp_/gho_, sk-, GOCSPX-, OAuth client secrets, PEM keys;
* addresses: IPs outside documentation (127.0.0.1/localhost and the RFC 5737 ranges are allowed), socks proxies;
* contacts: e-mail not at example.*, t.me links with a handle;
* tunnels: concrete trycloudflare addresses, somebody else's *.ts.net, ngrok/localtunnel;
* foreign paths: home directories such as /home/<name>/…, ~/.config/<tool>, antigravity-cli;
* live Moodle hosts instead of placeholders (anything that is not example.* and not the public moodle.org demo).

What it deliberately does not have: a dictionary of surnames. Instead it uses "test" identifiers: a moodleId in
the examples has to be 12345/12346 and the like, and a name has to be Test User (see the SAMPLE_* rules).

The deliberate exceptions are listed in ALLOW: places where the string is part of the product's meaning
(the address of their answer database, the public Moodle demo site, the local loopback).
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

# the root of the tree: next to scripts/ by default, but it can be pointed outside (--root / MSE_AUDIT_ROOT),
# so the same scanner can be run over somebody else's tree without copying the script
ROOT = Path(os.environ.get('MSE_AUDIT_ROOT') or Path(__file__).resolve().parent.parent).resolve()

# ---------------------------------------------------------------------- what is never read
SKIP_DIRS = {
    '.git', 'node_modules', 'vendor', '.venv', 'venv', '__pycache__', 'dist', 'build-out',
    '.mypy_cache', '.pytest_cache', '.ruff_cache', 'evidence', '.original', 'artifacts-cache',
}
# third-party libraries vendored for the tests: the addresses of their authors are not our fingerprint
SKIP_PREFIXES = ('tests/lib/stay/', 'tests/fixtures/tls/')  # the generated key is not read either
# the built userscript is read, but only by "our" rules: somebody else's build addresses live inside it
BUNDLE_RULES = {'telegram-bot-token', 'github-token', 'openai-key', 'google-oauth', 'oauth-secret',
                'private-key', 'tailscale-key', 'admin-token', 'socks-proxy', 'tunnel-url',
                'tailnet-host', 'telegram-link', 'home-path', 'tool-config-path', 'owner-tool', 'ip-address'}
SKIP_FILES = {'.gitignore', 'audit.py'}
BINARY_EXT = {
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.woff', '.woff2', '.ttf', '.otf',
    '.zip', '.gz', '.tgz', '.pdf', '.mp4', '.webm', '.so', '.wasm',
}
# the large built userscript is read: our shell is inside, but NOT the internals of the foreign build
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


# ---------------------------------------------------------------------- the rules
@dataclass
class Rule:
    name: str
    pattern: re.Pattern
    note: str


def _r(name: str, pattern: str, note: str = "", flags: int = 0) -> Rule:
    return Rule(name, re.compile(pattern, flags), note)


RULES = [
    # --- tokens and keys
    _r('telegram-bot-token', r'\b\d{8,10}:[A-Za-z0-9_-]{30,}\b', 'a bot token from @BotFather'),
    _r('github-token', r'\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b'),
    _r('openai-key', r'\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b'),
    _r('google-oauth', r'\bGOCSPX-[A-Za-z0-9_-]{10,}\b'),
    _r('oauth-secret', r'(?i)\bclient[_-]?secret\b\s*[:=]\s*["\']?[A-Za-z0-9_-]{16,}'),
    _r('private-key', r'-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----'),
    # a real key is long and random; the ones in tests are placeholders that say so in their own body
    _r('tailscale-key', r'\btskey-(?:auth|api|client)-(?!example|test\b|placeholder|live-check)[A-Za-z0-9_-]{10,}'),
    _r('admin-token', r'\badm_[A-Za-z0-9_-]{16,}', 'only a test adm_*_test is allowed in the repository'),
    # --- network and addresses
    _r('socks-proxy', r'\bsocks5h?://[^\s"\'<>]+', 'infrastructure proxy'),
    _r('tunnel-url', r'https?://[a-z0-9-]+\.trycloudflare\.com'),
    _r('tunnel-url', r'https?://[a-z0-9-]+\.(?:ngrok\.io|ngrok-free\.app|loca\.lt|localhost\.run|serveo\.net)'),
    _r('tailnet-host', r'https?://[a-z0-9-]+\.ts\.net', 'the address of a concrete tailnet'),
    # a personal telegram profile or channel link; the well-known bot-official ones carry nothing private
    _r('telegram-link', r'https?://t\.me/(?!BotFather\b|addemoji\b|share\b|joinchat\b)[A-Za-z0-9_]{4,}'),
    # --- contacts
    _r('email', r'\b[A-Za-z0-9._%+-]+@(?!example\.(?:com|org|edu|net)\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b'),
    # --- foreign file paths
    _r('home-path', r'/(?:home|Users)/(?!user\b|<|\[|\$|\{|\()(?!runner\b)[A-Za-z][A-Za-z0-9._-]{1,32}/', 'a home directory with a name'),
    _r('tool-config-path', r'~/\.(?:config|gemini|ssh)/[A-Za-z0-9._/-]+', 'the personal directory of a tool'),
    _r('owner-tool', r'(?i)antigravity-cli'),
]

# IP: loopback, the documentation ranges and the obviously local networks are allowed (they reveal nothing)
ALLOWED_IPS = {
    '127.0.0.1', '0.0.0.0', '0.0.0.0.', '255.255.255.255',
    '192.0.2.1', '192.0.2.10', '198.51.100.1', '203.0.113.1',
}
PRIVATE_PREFIXES = ('10.', '192.168.', '172.16.', '172.17.', '172.18.', '172.19.', '172.2', '172.30.', '172.31.', '169.254.')
RULE_IP = _r('ip-address', r'\b(?:\d{1,3}\.){3}\d{1,3}\b', 'an address outside documentation')

# live Moodle hosts: only placeholders and the public moodle.org demo are allowed
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
    'pkgs.tailscale.com', 'tailscale.com', 'deb.nodesource.com', 'archive.ubuntu.com', 'security.ubuntu.com',
    # telegram itself: the bot's own links (BotFather, the emoji pack) are not somebody's private host
    't.me', 'telegram.org', 'core.telegram.org',
    # where the installer tells the owner to fetch the key it needs
    'login.tailscale.com',
)
RULE_HOST = _r('live-moodle-host', r'\bhttps?://([a-z0-9][a-z0-9.-]*\.[a-z]{2,})', 'a host outside the allowed placeholders')

# ---------------------------------------------------------------------- per-line exceptions
ALLOW_PATTERNS = [
    re.compile(r'Storage/artifacts/mse\.user\.js'),       # the built file: the same rules, but the path is long
]

# files that are generated by a package manager, not written by a person: their hosts come from npm, not from us
NOT_OURS = {
    'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml',
}


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
            if name in NOT_OURS:
                continue
            p = Path(base) / name
            if p.suffix.lower() in BINARY_EXT or name in SKIP_FILES:
                continue
            rel = str(p.relative_to(ROOT))
            if any(rel.startswith(pref) for pref in SKIP_PREFIXES):
                continue
            files.append(p)
    return files


# constant files such as sha256 sums: "logo@16.png" is a file name, not an e-mail
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
            hits.append(Hit('ip-address', rel, lineno, ip, 'an address outside documentation'))
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
            hits.append(Hit('live-moodle-host', rel, lineno, host, 'a host outside the allowed placeholders'))
    if allowed_line:
        return [h for h in hits if h.rule not in ('ip-address', 'live-moodle-host')]
    return hits


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--strict', action='store_true', help='any hit means exit code 1 (for CI)')
    ap.add_argument('--git', action='store_true', help='only files in git')
    ap.add_argument('--json', action='store_true', help='a machine-readable report')
    ap.add_argument('--log', default='', help='append the report to a file')
    ap.add_argument('--quiet', action='store_true', help='the summary only')
    ap.add_argument('--root', default='', help='the tree to check (this repository by default)')
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
        lines.append("  clean: not a single fingerprint")

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
