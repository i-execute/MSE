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
let upstream, base, lastPayload, mockReply;
const key = 'mse_' + '8'.repeat(48);

test.before(async () => {
  upstream = http.createServer((req, res) => {
    if (req.url === '/v1/models') return res.end('{"data":[{"id":"mock"}]}');
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', () => {
      lastPayload = JSON.parse(raw);
      let answer = 'Alpha';
      if (mockReply != null) {
        answer = mockReply;
      } else {
        const userMsg = lastPayload.messages[1].content;
        const text = Array.isArray(userMsg)
          ? ((userMsg.find(c => c.type === 'text') || {}).text || '')
          : String(userMsg || '');
        if (text.includes('numerical') || text.includes('number (e.g.')) {
          answer = '42.5';
        } else if (text.includes('drag-and-drop') || text.includes('dropdown') || text.includes('all that apply')) {
          answer = 'Alpha | Beta';
        } else if (text.includes('fill in the field')) {
          answer = 'Paris';
        }
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
  mockReply = null;
  const multi = await ask({ question: 'q', options: ['Alpha', 'Beta', 'Gamma'], multiple: true });
  assert.equal(multi.body.answer, 'Alpha | Beta');
  const selects = await ask({ question: 'q', selects: [['Alpha', 'Gamma'], ['Beta', 'Gamma']] });
  assert.equal(selects.body.answer, 'Alpha | Beta');
  const invalid = await ask({ question: 'q', selects: [['Gamma'], ['Beta']] });
  assert.equal(invalid.body.ok, false);
  assert.match(invalid.body.message, /not in/);
});

test('fuzzy option matching handles A., (A), trailing dots and indices', async () => {
  const options = ['First option', 'Second option', 'Third option'];

  // Test "A. First option"
  mockReply = 'A. First option';
  let res = await ask({ question: 'Which one?', options });
  assert.equal(res.body.ok, true);
  assert.equal(res.body.answer, 'First option');

  // Test "First option." (trailing dot)
  mockReply = 'First option.';
  res = await ask({ question: 'Which one?', options });
  assert.equal(res.body.ok, true);
  assert.equal(res.body.answer, 'First option');

  // Test "A" (letter index)
  mockReply = 'A';
  res = await ask({ question: 'Which one?', options });
  assert.equal(res.body.ok, true);
  assert.equal(res.body.answer, 'First option');

  // Test "(B) Second option"
  mockReply = '(B) Second option';
  res = await ask({ question: 'Which one?', options });
  assert.equal(res.body.ok, true);
  assert.equal(res.body.answer, 'Second option');

  // Test "2" (numeric index)
  mockReply = '2';
  res = await ask({ question: 'Which one?', options });
  assert.equal(res.body.ok, true);
  assert.equal(res.body.answer, 'Second option');

  mockReply = null;
});

test('Russian letter option matching: а), б), в)', async () => {
  const options = ['Москва', 'Санкт-Петербург', 'Казань'];
  mockReply = 'б) Санкт-Петербург';
  let res = await ask({ question: 'Столица?', options });
  assert.equal(res.body.ok, true);
  assert.equal(res.body.answer, 'Санкт-Петербург');

  mockReply = 'а';
  res = await ask({ question: 'Столица?', options });
  assert.equal(res.body.ok, true);
  assert.equal(res.body.answer, 'Москва');

  mockReply = null;
});

test('True/False cross-lingual synonym matching', async () => {
  // Russian options, English model reply
  mockReply = 'True';
  let res = await ask({ question: 'Земля круглая?', options: ['Верно', 'Неверно'] });
  assert.equal(res.body.ok, true);
  assert.equal(res.body.answer, 'Верно');

  // English options, Russian model reply
  mockReply = 'Ложь';
  res = await ask({ question: 'Sky is green?', options: ['True', 'False'] });
  assert.equal(res.body.ok, true);
  assert.equal(res.body.answer, 'False');

  mockReply = null;
});

test('Model returning array or number 0', async () => {
  // Array response
  mockReply = ['Alpha', 'Beta'];
  let res = await ask({ question: 'Which ones?', options: ['Alpha', 'Beta', 'Gamma'], multiple: true });
  assert.equal(res.body.ok, true);
  assert.equal(res.body.answer, 'Alpha | Beta');

  // Answer is 0
  mockReply = 0;
  res = await ask({ question: 'What is 2 - 2?', type: 'numerical' });
  assert.equal(res.body.ok, true);
  assert.equal(res.body.answer, '0');

  // Comma-separated multiple choice
  mockReply = 'Alpha, Beta';
  res = await ask({ question: 'Which ones?', options: ['Alpha', 'Beta', 'Gamma'], multiple: true });
  assert.equal(res.body.ok, true);
  assert.equal(res.body.answer, 'Alpha | Beta');

  mockReply = null;
});

test('sequential mixed fields (Cloze) prompt and validation', async () => {
  mockReply = '2.1 million | Paris';
  const res = await ask({
    question: 'France info',
    type: 'multianswer',
    fields: [
      { kind: 'text' },
      { kind: 'select', options: ['Lyon', 'Paris', 'Marseille'] }
    ]
  });
  assert.equal(res.body.ok, true);
  assert.equal(res.body.answer, '2.1 million | Paris');

  // Prompt verified
  const userMsg = lastPayload.messages[1].content;
  assert.match(userMsg, /2 inputs in order/);
  assert.match(userMsg, /\[Text field\]/);
  assert.match(userMsg, /\[Dropdown\]/);

  mockReply = null;
});

test('numerical and calculated questions do not forbid digits and accept number answer', async () => {
  mockReply = null;
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
  mockReply = null;
  const res = await ask({
    question: 'Capital of France?',
    type: 'shortanswer'
  });
  assert.equal(res.body.ok, true);
  assert.equal(res.body.answer, 'Paris');
});

test('ddwtos drag-and-drop into text prompt and validator', async () => {
  mockReply = null;
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
  mockReply = null;
  const image = 'data:image/png;base64,aGVsbG8=';
  const r = await ask({ question: 'image?', options: ['Alpha'], image: [{ data: image, label: 'question' }] });
  assert.equal(r.body.ok, true);
  const imgObj = lastPayload.messages[1].content.find(c => c.type === 'image_url');
  assert.equal(imgObj.image_url.url, image);
  const invalid = await ask({ question: 'image?', image: [{ data: 'https://other.example.edu/secret' }] });
  assert.equal(invalid.status, 400);
});
