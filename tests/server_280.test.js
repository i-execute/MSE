'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

function genKey() {
  return 'mse_' + crypto.randomBytes(24).toString('base64url');
}

function startMockUpstream(handler) {
  const s = http.createServer(handler);
  return new Promise(resolve => {
    s.listen(0, '127.0.0.1', () => resolve({ server: s, port: s.address().port }));
  });
}

function startRouter(upstreamPort, extraEnv = {}) {
  const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'mse-r280-'));
  const port = 30000 + Math.floor(Math.random() * 20000);
  const adminToken = 'adm_test_' + Math.random().toString(36).slice(2);
  const env = Object.assign({}, process.env, {
    MSE_PORT: String(port),
    MSE_HOST: '127.0.0.1',
    MSE_UPSTREAM_HOST: '127.0.0.1',
    MSE_UPSTREAM_PORT: String(upstreamPort),
    MSE_ADMIN_TOKEN: adminToken,
    MSE_DATA_DIR: tmpDir,
    MSE_DAILY_QUOTA: '10'
  }, extraEnv);
  const child = spawn(process.execPath, [path.join(__dirname, '../Server/mse-router.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    let started = false;
    child.stdout.on('data', d => {
      if (d.toString().includes('MSE router')) {
        started = true;
        resolve({ child, port, adminToken, tmpDir, close: () => { child.kill(); fs.rmSync(tmpDir, { recursive: true, force: true }); } });
      }
    });
    child.stderr.on('data', d => {});
    child.on('exit', code => { if (!started) reject(new Error('router exited early: ' + code)); });
  });
}

async function request(port, method, pathUrl, headers = {}, body = null) {
  return new Promise(resolve => {
    const data = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const reqHeaders = Object.assign({}, headers);
    if (data && !reqHeaders['content-type']) reqHeaders['content-type'] = 'application/json';
    const req = http.request({ hostname: '127.0.0.1', port, method, path: pathUrl, headers: reqHeaders }, res => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch (_) {}
        resolve({ status: res.statusCode, headers: res.headers, raw, json });
      });
    });
    if (data) req.write(data);
    req.end();
  });
}

test('Bug 3: approve device adds moodleId to allow-list', async () => {
  const up = await startMockUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ models: ['m1'] }));
  });
  const r = await startRouter(up.port);
  try {
    const devKey = genKey();
    // 1. Register device
    const reg = await request(r.port, 'POST', '/mse/v1/register', {}, {
      key: devKey, moodleId: '8128929', name: 'Ivan'
    });
    assert.equal(reg.status, 202);
    const deviceId = reg.json.device.deviceId;
    assert.ok(deviceId);

    // 2. Check allow list before approve
    let st = await request(r.port, 'GET', '/admin/state', { 'x-admin-token': r.adminToken });
    assert.equal(st.json.allow.some(a => String(a.moodleId) === '8128929'), false);

    // 3. Approve via /admin/approve
    const app = await request(r.port, 'POST', '/admin/approve', { 'x-admin-token': r.adminToken }, { deviceId });
    assert.equal(app.status, 200);
    assert.equal(app.json.device.status, 'active');

    // 4. Verify moodleId is now in allow list!
    st = await request(r.port, 'GET', '/admin/state', { 'x-admin-token': r.adminToken });
    assert.equal(st.json.allow.some(a => String(a.moodleId) === '8128929'), true, 'Bug 3: moodleId is present in allow list after device approval');
  } finally {
    r.close();
    up.server.close();
  }
});

test('Bug 4: dump quota is completely removed (no 429 quota reached)', async () => {
  const up = await startMockUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ models: ['m1'] }));
  });
  const r = await startRouter(up.port);
  try {
    const devKey = genKey();
    const reg = await request(r.port, 'POST', '/mse/v1/register', {}, { key: devKey, moodleId: '99999', name: 'user' });
    assert.equal(reg.status, 202);
    await request(r.port, 'POST', '/admin/allow', { 'x-admin-token': r.adminToken }, { moodleId: '99999' });

    // Send 55 dumps from the same device (previously capped at 50 with 429)
    let rejected = false;
    for (let i = 0; i < 55; i++) {
      const res = await request(r.port, 'POST', '/mse/v1/dump', { authorization: 'Bearer ' + devKey }, {
        type: 'debug',
        dump: { step: i, question: 'Q' + i }
      });
      if (res.status === 429) {
        rejected = true;
        break;
      }
      assert.equal(res.status, 201, 'Dump ' + i + ' should succeed with 201');
    }
    assert.equal(rejected, false, 'Bug 4: No 429 dump quota error occurred for 55 consecutive dumps');
  } finally {
    r.close();
    up.server.close();
  }
});

test('Bug 7: structured server error logging to mse-router.log with levels and events', async () => {
  const up = await startMockUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ models: ['m1'] }));
  });
  const r = await startRouter(up.port);
  try {
    // 1. Trigger invalid key warning
    await request(r.port, 'POST', '/mse/v1/agent', { authorization: 'Bearer mse_invalidkey12345678901234567890' }, { question: 'test' });

    // 2. Register and allow
    const devKey = genKey();
    const reg = await request(r.port, 'POST', '/mse/v1/register', {}, { key: devKey, moodleId: '77777', name: 'user' });
    assert.equal(reg.status, 202);
    await request(r.port, 'POST', '/admin/allow', { 'x-admin-token': r.adminToken }, { moodleId: '77777' });

    // 3. Trigger bad request
    await request(r.port, 'POST', '/mse/v1/agent', { authorization: 'Bearer ' + devKey }, {});

    // 4. Verify log file exists and contains structured entries
    const logPath = path.join(r.tmpDir, 'mse-router.log');
    assert.ok(fs.existsSync(logPath), 'Bug 7: mse-router.log exists on disk');
    const logContent = fs.readFileSync(logPath, 'utf8');
    assert.match(logContent, /\[WARN\]\s+\[invalid_key\]/, 'Bug 7: invalid_key logged at WARN level');
    assert.match(logContent, /\[WARN\]\s+\[agent_bad_request\]/, 'Bug 7: agent_bad_request logged at WARN level');

    // 5. Test /admin/log endpoint
    const adminLog = await request(r.port, 'GET', '/admin/log', { 'x-admin-token': r.adminToken });
    assert.equal(adminLog.status, 200);
    assert.ok(adminLog.json.log.includes('invalid_key'), '/admin/log returns file log content');
    assert.ok(Array.isArray(adminLog.json.journal), '/admin/log returns journal');
  } finally {
    r.close();
    up.server.close();
  }
});

test('Images in agent: image arrives as image_url part, model missing image falls back to candidate model', async () => {
  let callCount = 0;
  let receivedBodies = [];
  const up = await startMockUpstream((req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: [{ id: 'model-flaky' }, { id: 'model-good' }] }));
    }
    if (req.url === '/v1/chat/completions') {
      let raw = '';
      req.on('data', c => { raw += c; });
      req.on('end', () => {
        callCount++;
        const parsed = JSON.parse(raw);
        receivedBodies.push(parsed);
        res.writeHead(200, { 'content-type': 'application/json' });
        if (parsed.model === 'model-flaky') {
          // Model claims no image provided
          return res.end(JSON.stringify({
            id: 'chatcmpl-1',
            choices: [{ message: { content: '{"error": "No image provided to analyze the query type"}' } }]
          }));
        }
        // Good model answers verbatim
        return res.end(JSON.stringify({
          id: 'chatcmpl-2',
          choices: [{ message: { content: '{"answer": "1:М", "confidence": 0.8, "reason": "visible relation"}' } }]
        }));
      });
    }
  });

  const r = await startRouter(up.port, { MSE_MODEL: 'model-flaky,model-good' });
  try {
    const devKey = genKey();
    const reg = await request(r.port, 'POST', '/mse/v1/register', {}, { key: devKey, moodleId: '55555', name: 'vision_user' });
    assert.equal(reg.status, 202);
    await request(r.port, 'POST', '/admin/allow', { 'x-admin-token': r.adminToken }, { moodleId: '55555' });

    const agentRes = await request(r.port, 'POST', '/mse/v1/agent', { authorization: 'Bearer ' + devKey }, {
      question: 'СХЕМА ОТНОШЕНИЯ, ИЗОБРАЖЕННАЯ НА РИСУНКЕ, ОТОБРАЖАЕТ ОТНОШЕНИЕ',
      options: ['1:1', '1:2', '1:М', 'М:М', 'М:2'],
      image: [{ data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', label: 'question image 1' }]
    });

    assert.equal(agentRes.status, 200);
    assert.equal(agentRes.json.ok, true);
    assert.equal(agentRes.json.answer, '1:М');

    // Verify first model was called, claimed no image, and router fell back to model-good
    assert.equal(callCount, 2, 'Router tried first model then fell back to second model');
    assert.equal(receivedBodies[0].model, 'model-flaky');
    assert.equal(receivedBodies[1].model, 'model-good');

    // Verify image_url was present in payload
    const userMsg = receivedBodies[1].messages.find(m => m.role === 'user');
    assert.ok(Array.isArray(userMsg.content), 'user message content is array with multi-modal parts');
    assert.equal(userMsg.content[0].type, 'image_url', 'image_url is placed first in content array');
  } finally {
    r.close();
    up.server.close();
  }
});
