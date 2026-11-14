'use strict';
/*
 * A tiny stand-in for the upstream model: it speaks the OpenAI shape, both plain and streaming, so the gateway
 * can be run end to end on a laptop without a key and without the internet.
 *
 *   node server-mse/mock-upstream.js       # listens on 127.0.0.1:8799, answers /v1/chat/completions
 */
const http = require('http');

const PORT = Number(process.env.MOCK_PORT || 8799);

function reply(body) {
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  const sys = msgs.filter((m) => m && m.role === 'system').map((m) => String(m.content || '')).join(' ');
  const last = msgs.filter((m) => m && m.role === 'user').pop();
  const text = last && typeof last.content === 'string' ? last.content : 'nothing';
  /* the agent shape: the mock plays the model that must answer with one of the options */
  if (/ONE JSON object/.test(sys)) {
    const options = [...text.matchAll(/^\s*\d+\.\s*(.+)$/gm)].map((m) => m[1].trim());
    const answer = options[0] || '';
    if (!answer) return JSON.stringify({ error: 'no options in the task' });
    return JSON.stringify({ answer, confidence: 0.82, reason: 'mock: the first option' });
  }
  /* the fallback answer of the extension: "answer with exactly one line" — the first option of the block */
  if (/Answer with exactly one line/i.test(text)) {
    const options = [...text.matchAll(/^\s*\d+\.\s*(.+)$/gm)].map((m) => m[1].trim());
    if (options[0]) return options[0];
  }
  return 'MSE mock upstream (model ' + (body.model || '?') + ') heard: ' + text.slice(0, 200);
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  if (req.url === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model', object: 'model' }] }));
  }
  if (req.url !== '/v1/chat/completions' || req.method !== 'POST') {
    res.writeHead(404, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: 'mock: not found' } }));
  }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) {}
    const text = reply(body);
    const id = 'chatcmpl-mock-' + Math.random().toString(36).slice(2, 10);
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
      const parts = text.match(/.{1,12}/g) || [''];
      let i = 0;
      const tick = () => {
        if (i < parts.length) {
          res.write('data: ' + JSON.stringify({
            id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model,
            choices: [{ index: 0, delta: { content: parts[i++] }, finish_reason: null }]
          }) + '\n\n');
          setTimeout(tick, 10);
        } else {
          res.write('data: ' + JSON.stringify({
            id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
          }) + '\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
        }
      };
      return tick();
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: body.model || 'mock-model',
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }
    }));
  });
});

if (require.main === module) {
  server.listen(PORT, '127.0.0.1', () => console.log('mock upstream on http://127.0.0.1:' + PORT + '/v1'));
}
module.exports = { server };
