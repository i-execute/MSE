'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'mse-types-'));
Object.assign(process.env, {
  MSE_DATA_DIR: data,
  MSE_ADMIN_TOKEN: 'adm_test',
  MSE_UPSTREAM_PORT: '1',
  MSE_MODEL: 'mock'
});
const router = require('../Server/mse-router');
let upstream, base, lastPayload;
const key = 'mse_' + '8'.repeat(48);

test.before(async () => {
  upstream = http.createServer((req, res) => {
    if (req.url === '/v1/models') return res.end('{"data":[{"id":"mock"}]}');
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', () => {
      lastPayload = JSON.parse(raw);
      const userMsg = lastPayload.messages[1].content;
      const text = Array.isArray(userMsg)
        ? ((userMsg.find(c => c.type === 'text') || {}).text || '')
        : String(userMsg || '');
      let answer = 'Alpha';
      if (text.includes('numerical') || text.includes('number (e.g.')) {
        answer = '42.5';
      } else if (text.includes('drag-and-drop') || text.includes('dropdown') || text.includes('all that apply')) {
        answer = 'Alpha | Beta';
      } else if (text.includes('fill in the field')) {
        answer = 'Paris';
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ answer }) } }] }));
    });
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  router.CFG.upstreamUrl = 'http://127.0.0.1:' + upstream.address().port;
  await new Promise(r => router.server.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + router.server.address().port;
  const d = await (await post('/mse/v1/register', { key, moodleId: '9' })).json();
  await post('/admin/approve', { deviceId: d.device.deviceId }, { 'x-admin-token': 'adm_test' });
});

test.after(() => {
  router.server.close();
  upstream.close();
});

const post = (url, b, h = {}) => fetch(base + url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...h },
  body: JSON.stringify(b)
});
const ask = async (body) => {
  const r = await post('/mse/v1/agent', body, { authorization: 'Bearer ' + key });
  return { status: r.status, body: await r.json() };
};

test('multi and dropdown answers are validated against every option', async () => {
  const multi = await ask({ question: 'q', options: ['Alpha', 'Beta', 'Gamma'], multiple: true });
  assert.equal(multi.body.answer, 'Alpha | Beta');
  const selects = await ask({ question: 'q', selects: [['Alpha', 'Gamma'], ['Beta', 'Gamma']] });
  assert.equal(selects.body.answer, 'Alpha | Beta');
  const invalid = await ask({ question: 'q', selects: [['Gamma'], ['Beta']] });
  assert.equal(invalid.body.ok, false);
  assert.match(invalid.body.message, /not in/);
});

test('numerical and calculated questions do not forbid digits and accept number answer', async () => {
  const res = await ask({
    question: 'Calculate acceleration',
    type: 'numerical'
  });
  assert.equal(res.body.ok, true);
  assert.equal(res.body.answer, '42.5');

  // Verify prompt does NOT forbid digits or numbers
  const sysMsg = lastPayload.messages[0].content;
  const userMsg = lastPayload.messages[1].content;
  assert.doesNotMatch(sysMsg, /Numbering is strictly forbidden/);
  assert.doesNotMatch(sysMsg, /Do NOT return numbers/);
  assert.match(userMsg, /exact numerical answer as a number/);
});

test('shortanswer accepts free text answers', async () => {
  const res = await ask({
    question: 'Capital of France?',
    type: 'shortanswer'
  });
  assert.equal(res.body.ok, true);
  assert.equal(res.body.answer, 'Paris');
});

test('ddwtos drag-and-drop into text prompt and validator', async () => {
  const res = await ask({
    question: 'The [[1]] and [[2]]',
    type: 'ddwtos',
    options: ['Alpha', 'Beta', 'Gamma'],
    placesCount: 2
  });
  assert.equal(res.body.ok, true);
  assert.equal(res.body.answer, 'Alpha | Beta');

  const userMsg = lastPayload.messages[1].content;
  assert.match(userMsg, /drag-and-drop into text/);
  assert.match(userMsg, /2 blank\(s\)/);

  // When agent returns an option not in options
  const invalid = await ask({
    question: 'The [[1]] and [[2]]',
    type: 'ddwtos',
    options: ['Gamma', 'Delta'],
    placesCount: 2
  });
  assert.equal(invalid.body.ok, false);
  assert.match(invalid.body.message, /not in the task/);
});

test('images travel as data only to the backend; a remote URL is rejected', async () => {
  const image = 'data:image/png;base64,aGVsbG8=';
  const r = await ask({ question: 'image?', options: ['Alpha'], image: [{ data: image, label: 'question' }] });
  assert.equal(r.body.ok, true);
  const imgObj = lastPayload.messages[1].content.find(c => c.type === 'image_url');
  assert.equal(imgObj.image_url.url, image);
  const invalid = await ask({ question: 'image?', image: [{ data: 'https://other.example.edu/secret' }] });
  assert.equal(invalid.status, 400);
});
