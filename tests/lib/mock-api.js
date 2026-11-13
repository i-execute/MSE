'use strict';
/* Mock of https://syncshare.ru/api/ built from answers recorded from the real server
   (tools/capture-api.js -> tests/fixtures/api/recorded.json). */
const path = require('path');
const recorded = require(path.join(__dirname, '..', 'fixtures', 'api', 'recorded.json'));

function key(method, p) {
  const u = new URL('https://syncshare.ru' + p);
  const q = [...u.searchParams.entries()].filter(([k]) => k !== 'attemptId').sort().map((e) => e.join('=')).join('&');
  return method + ' ' + u.pathname + '?' + q;
}
const table = new Map();
for (const r of recorded) if (r.forwarded) table.set(key(r.method, r.path), r);

/** overrides: { 'METHOD /api/path': (req) => response | response } - matched on pathname only */
function mockApi(overrides = {}) {
  return async (req) => {
    const u = new URL('https://syncshare.ru' + req.path);
    const o = overrides[req.method + ' ' + u.pathname];
    if (o !== undefined) { const r = typeof o === 'function' ? await o(req) : o; if (r) return r; }
    const r = table.get(key(req.method, req.path));
    if (r) return { status: r.status, json: r.json, headers: r.etag ? { etag: r.etag } : {} };
    if (req.method === 'POST' && /^\/api\/v2\/quiz\/(attempt|review|attempt\/summary)$/.test(u.pathname)) return { status: 200, json: {} };
    if (u.pathname === '/api/v2/quiz/solution') return { status: 200, json: [] };
    return { status: 404, json: { detail: 'not mocked: ' + req.method + ' ' + u.pathname } };
  };
}
module.exports = { mockApi, recorded };
