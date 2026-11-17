'use strict';
// Run the real installer's functions in an isolated directory: never touch systemd or /usr/local.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawnSync } = require('node:child_process');

const source = fs.readFileSync(path.join(__dirname, '../Server/stack/install.sh'), 'utf8');
const definitions = source.split('# ------------------------------------------------------------------ main')[0];
function run(script, env) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('MSE_')));
  return spawnSync('bash', ['-c', definitions + '\nNODE_BIN="$(command -v node)";\n' + script], {
    encoding: 'utf8', env: { ...clean, ...env }
  });
}
function parse(file) {
  return Object.fromEntries(fs.readFileSync(file, 'utf8').split('\n').filter(l => /^[A-Z_]+=/.test(l)).map(l => {
    const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)];
  }));
}

test('installer selects distinct random ports, persists them and preserves them on update', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mse-ports-'));
  try {
    const vars = { MSE_ENV_DIR: dir, MSE_UNIT_DIR: dir };
    let result = run('choose_ports; write_env; merge_env_from_environment; write_units', vars);
    assert.equal(result.status, 0, result.stderr);
    let first = parse(path.join(dir, 'mse.env'));
    for (const p of [first.MSE_PORT, first.MSE_UPSTREAM_PORT]) assert.ok(+p >= 20000 && +p <= 60000);
    assert.notEqual(first.MSE_PORT, first.MSE_UPSTREAM_PORT);
    const listeners = [];
    try {
      for (const p of [first.MSE_PORT, first.MSE_UPSTREAM_PORT]) {
        const server = net.createServer(); listeners.push(server);
        await new Promise((resolve, reject) => server.once('error', reject).listen(+p, '127.0.0.1', resolve));
      }
    } finally { for (const server of listeners) server.close(); }
    assert.equal(first.MSE_ADMIN_URL, 'http://127.0.0.1:' + first.MSE_PORT);
    if (fs.existsSync(path.join(dir, 'mse-router.service'))) assert.match(fs.readFileSync(path.join(dir, 'mse-router.service'), 'utf8'), /EnvironmentFile=/);
    result = run('choose_ports; write_env; merge_env_from_environment', vars);
    assert.equal(result.status, 0, result.stderr);
    let second = parse(path.join(dir, 'mse.env'));
    assert.equal(second.MSE_PORT, first.MSE_PORT);
    assert.equal(second.MSE_UPSTREAM_PORT, first.MSE_UPSTREAM_PORT);
    assert.equal(fs.statSync(path.join(dir, 'mse.env')).mode & 0o777, 0o600);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('explicit invalid or colliding ports are rejected', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mse-ports-'));
  try {
    for (const [port, up] of [['bad', '23001'], ['65536', '23001'], ['23000', '23000'], ['023000', '23000']]) {
      const r = run('choose_ports', { MSE_ENV_DIR: dir, MSE_PORT: port, MSE_UPSTREAM_PORT: up });
      assert.notEqual(r.status, 0, r.stdout + r.stderr);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});


test('tunnel status remains valid JSON when no port is configured', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mse-tunnel-'));
  try {
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('MSE_')));
    const r = spawnSync('bash', [path.join(__dirname, '../Server/stack/mse-tunnel.sh'), 'status', '--json'], {
      encoding: 'utf8', env: { ...clean, MSE_ENV_FILE: path.join(dir, 'none'), MSE_STATE_DIR: dir, MSE_TAILSCALE_BIN: 'missing-test-binary' }
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).gateway_port, null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
