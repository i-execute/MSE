'use strict';
/*
 * MSE — the link to the owner's own gateway (the "bridge" to the personal AI).
 *
 * What it does, in the order the user meets it:
 *
 *   1. The address. The user pastes the URL of the gateway (a Cloudflare tunnel address, usually) into the
 *      panel. It is checked at once — GET /health must answer `{ ok: true, name: "MSE gateway" }` — and only
 *      then remembered. It is stored twice (localStorage and the Stay storage), so it survives a reload, a
 *      restart of Safari and a reinstall of the script, and the panel never asks for it again.
 *   2. The key. Nobody types it. The extension makes one up on the first run: 32 random bytes, base64url,
 *      prefixed `mse_`. The gateway stores sha256(key) and derives the device id from it, so the same key is
 *      always the same device, and the key itself is never stored anywhere but this device.
 *   3. The identity. The gateway is told the Moodle id and the name — and it does not trust them: the record
 *      starts as "pending" until the owner adds that id on their side (/admin/allow) or approves the device.
 *      The id on the server comes from the record, never from the request body, so a forged id in a request
 *      changes nothing: the quota and the log are those of the device.
 *   4. The check. `check()` asks GET /mse/v1/me with the key and says plainly what the status is:
 *      active / pending / revoked / unreachable / not registered.
 *
 * Only the gateway knows the upstream model key. The extension never sees it.
 */
(function () {
  'use strict';

  var CONFIG = Object.assign({
    urlKey: 'mse.gateway.url',
    urlMirrorKey: 'mse:local:gatewayUrl',
    keyKey: 'mse.gateway.key',
    keyMirrorKey: 'mse:local:gatewayKey',
    metaKey: 'mse.gateway.meta',
    timeoutMs: 8000
  }, (typeof __MSE_CONFIG__ === 'object' && __MSE_CONFIG__) || {});

  /* ------------------------------------------------------------ storage: twice, so nothing is lost */
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }
  function dig(obj, p) {
    try {
      for (var i = 0; i < p.length; i++) { if (obj == null) return null; obj = obj[p[i]]; }
      return obj == null ? null : obj;
    } catch (e) { return null; }
  }

  function randomKey() {
    var b = new Uint8Array(32);
    crypto.getRandomValues(b);
    var s = '';
    for (var i = 0; i < b.length; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16);
    /* hex is enough for 256 bits and keeps the key readable when the user copies it */
    return 'mse_' + s;
  }

  var MSEBridge = {
    /* ---------------- the address ---------------- */
    url: function () {
      var fromLs = lsGet(CONFIG.urlKey);
      if (fromLs) return fromLs;
      var fromStay = dig(window, CONFIG.urlMirrorKey.split(':'));
      if (fromStay) { lsSet(CONFIG.urlKey, fromStay); return fromStay; }
      return null;
    },
    setUrl: function (raw) {
      var url = String(raw || '').trim().replace(/\/+$/, '');
      if (!url) { lsDel(CONFIG.urlKey); lsDel(CONFIG.urlMirrorKey); return null; }
      if (!/^https?:\/\/[^\s\/]+\.[^\s\/]+/.test(url) && !/^http:\/\/127\.0\.0\.1(:\d+)?$/.test(url) && !/^http:\/\/localhost(:\d+)?$/.test(url)) {
        throw new Error('это не похоже на адрес: нужен http:// или https:// с доменом');
      }
      if (!/^https:/.test(url) && !/^http:\/\/(127\.0\.0\.1|localhost)/.test(url)) {
        throw new Error('без https только localhost: в туннеле всегда https');
      }
      lsSet(CONFIG.urlKey, url);
      lsSet(CONFIG.urlMirrorKey, url);
      return url;
    },

    /* ---------------- health: is that address a gateway of ours ---------------- */
    probe: function (raw) {
      var url = String(raw || this.url() || '').trim().replace(/\/+$/, '');
      if (!url) return Promise.reject(new Error('адрес не задан'));
      var started = Date.now();
      var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, CONFIG.timeoutMs);
      return fetch(url + '/health', { method: 'GET', headers: { accept: 'application/json' }, signal: ctrl ? ctrl.signal : undefined })
        .then(function (r) {
          return r.json().then(function (j) { return { ok: r.ok, status: r.status, json: j }; }, function () { return { ok: r.ok, status: r.status, json: null }; });
        })
        .then(function (res) {
          clearTimeout(timer);
          var j = res.json || {};
          var mine = !!(j && (j.name === 'MSE gateway' || j.gateway === 'mse' || j.ok === true));
          return {
            ok: !!res.ok && mine,
            reachable: true,
            mine: mine,
            status: res.status,
            ms: Date.now() - started,
            version: j.version || null,
            model: j.model || null,
            quota: j.quota || null,
            upstream: j.upstream || null,
            message: !res.ok ? 'адрес ответил ' + res.status
              :!mine ? 'по этому адресу кто-то есть, но это не шлюз MSE'
              : 'шлюз на связи'
          };
        }, function (e) {
          clearTimeout(timer);
          return { ok: false, reachable: false, mine: false, ms: Date.now() - started, message: 'адрес не отвечает: ' + (e && e.name === 'AbortError' ? 'таймаут' : (e && e.message) || 'сеть') };
        });
    },

    /* ---------------- the key ---------------- */
    key: function () {
      var k = lsGet(CONFIG.keyKey) || dig(window, CONFIG.keyMirrorKey.split(':'));
      if (k) { if (!lsGet(CONFIG.keyKey)) lsSet(CONFIG.keyKey, k); return k; }
      k = randomKey();
      lsSet(CONFIG.keyKey, k);
      lsSet(CONFIG.keyMirrorKey, k);
      return k;
    },
    ensureKey: function () { return this.key(); },
    maskedKey: function () {
      var k = this.key();
      return k ? k.slice(0, 8) + '…' + k.slice(-4) : null;
    },
    forgetKey: function () {
      lsDel(CONFIG.keyKey); lsDel(CONFIG.keyMirrorKey); lsDel(CONFIG.metaKey);
      try { window[CONFIG.keyMirrorKey] = null; } catch (e) {}
    },
    reset: function () {
      this.forgetKey();
      try { window[CONFIG.urlMirrorKey] = null; } catch (e) {}
    },

    /* ---------------- the call that matters: register this device with the gateway ---------------- */
    register: function (identity) {
      var self = this;
      var url = self.url();
      if (!url) return Promise.reject(new Error('сначала адрес шлюза'));
      var key = self.key();
      identity = identity || {};
      var body = { key: key, moodleId: String(identity.id || ''), name: String(identity.name || ''), site: String(identity.site || '') };
      if (!body.moodleId) return Promise.reject(new Error('не видно ID пользователя: откройте страницу, где виден профиль'));
      return fetch(url + '/mse/v1/register', {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key }, body: JSON.stringify(body)
      }).then(function (r) {
        return r.json().then(function (j) {
          if (!r.ok) throw new Error((j && j.error && j.error.message) || ('шлюз ответил ' + r.status));
          return self.saveMeta(j, body);
        });
      });
    },

    saveMeta: function (j, body) {
      var meta = {
        at: Date.now(),
        key: body ? body.key : null,
        device: (j && j.device) ? j.device.deviceId : null,
        moodleId: (j && j.device) ? j.device.moodleId : (body ? body.moodleId : null),
        name: (j && j.device) ? j.device.name : (body ? body.name : null),
        status: (j && j.device) ? j.device.status : null,
        hint: (j && j.hint) || null,
        quota: (j && j.device) ? j.device.quota : null
      };
      lsSet(CONFIG.metaKey, JSON.stringify(meta));
      return meta;
    },
    meta: function () {
      try { return JSON.parse(lsGet(CONFIG.metaKey) || 'null'); } catch (e) { return null; }
    },

    /* ---------------- is this key live? ---------------- */
    check: function () {
      var self = this;
      var url = self.url();
      if (!url) return Promise.resolve({ state: 'no-url', message: 'адрес шлюза не задан' });
      var key = self.key();
      return fetch(url + '/mse/v1/me', { method: 'GET', headers: { authorization: 'Bearer ' + key, accept: 'application/json' } })
        .then(function (r) {
          return r.json().then(function (j) {
            var d = (j && j.device) || {};
            var st = (j && j.ok === false) ? (d.status || 'error') : (d.status || (r.ok ? 'active' : 'error'));
            var meta = self.saveMeta({ device: d, ok: r.ok }, { key: key, moodleId: d.moodleId, name: d.name });
            if (r.status === 401 || st === 'unknown') return { state: 'unregistered', message: 'ключ не привязан', device: d, meta: meta };
            if (!r.ok || st !== 'active') {
              return { state: st === 'revoked' ? 'revoked' : 'pending', message: st === 'revoked' ? 'ключ отозван' : 'ждёт подтверждения', device: d, meta: meta };
            }
            return { state: 'active', message: 'ключ принят', device: d, meta: meta };
          });
        }, function (e) {
          return { state: 'unreachable', message: 'шлюз не отвечает: ' + (e && e.message ? e.message : 'сеть') };
        });
    },

    /* ---------------- what models the gateway offers (the server decides, we only show) ---------------- */
    models: function () {
      var self = this;
      var url = self.url();
      if (!url) return Promise.resolve({ ok: false, models: [], message: 'адрес не задан' });
      var started = Date.now();
      return fetch(url + '/v1/models', { method: 'GET', headers: { authorization: 'Bearer ' + self.key(), accept: 'application/json' } })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, status: r.status, json: j, ms: Date.now() - started }; }); })
        .then(function (res) {
          var list = (res.json && Array.isArray(res.json.data) ? res.json.data : []).map(function (m) { return String(m.id || m); }).filter(Boolean);
          return { ok: res.ok && list.length > 0, models: list, ms: res.ms, status: res.status, message: res.ok ? 'доступно моделей: ' + list.length : 'шлюз ответил ' + res.status };
        }, function (e) {
          return { ok: false, models: [], ms: Date.now() - started, message: 'шлюз не ответил: ' + ((e && e.message) || 'сеть') };
        });
    },

    /* ---------------- the agent: the question goes out, the chosen answer comes back ---------------- */
    agent: function (payload) {
      var self = this;
      var url = self.url();
      if (!url) return Promise.resolve({ ok: false, code: 'no_gateway', message: 'шлюз не настроен' });
      var started = Date.now();
      var body = {
        host: String(payload.host || ''),
        question: String(payload.question || '').slice(0, 4000),
        type: String(payload.type || ''),
        options: (payload.options || []).slice(0, 20).map(function (o) { return String(o).slice(0, 300); }),
        multiple: !!payload.multiple,
        image: payload.image || null,
        prior: payload.prior || null
      };
      var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, 45000);
      return fetch(url + '/mse/v1/agent', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + self.key() },
        body: JSON.stringify(body),
        signal: ctrl ? ctrl.signal : undefined
      }).then(function (r) {
        return r.json().then(function (j) { return { status: r.status, j: j, retryAfter: Number(r.headers.get('retry-after') || 0) }; });
      }).then(function (res) {
        clearTimeout(timer);
        var j = res.j || {};
        var ms = Date.now() - started;
        if (res.status === 429 || j.code === 'rate_limited') {
          return { ok: false, code: 'rate_limited', ms: ms, retryAfter: j.retry_after || res.retryAfter || 5, message: 'агент занят, лимит' };
        }
        if (!j.ok) return { ok: false, code: j.code || 'agent_error', ms: ms, message: j.message || ('шлюз ответил ' + res.status) };
        return { ok: true, code: 'ok', ms: ms, answer: j.answer || null, confidence: j.confidence == null ? null : j.confidence, model: j.model || null, reasoning: j.reasoning ? String(j.reasoning).slice(0, 400) : null };
      }, function (e) {
        clearTimeout(timer);
        return { ok: false, code: (e && e.name === 'AbortError') ? 'timeout' : 'network', ms: Date.now() - started, message: (e && e.name === 'AbortError') ? 'агент не ответил за 45 с' : 'запрос не ушёл: ' + ((e && e.message) || 'сеть') };
      });
    },

    /* ---------------- one chat call, for the «дополнительно» view: proves the whole chain ---------------- */
    chat: function (text, onChunk) {
      var self = this;
      var url = self.url();
      if (!url) return Promise.reject(new Error('адрес шлюза не задан'));
      var body = { model: 'mse', stream: !!onChunk, messages: [{ role: 'user', content: String(text || 'ping') }] };
      return fetch(url + '/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + self.key() },
        body: JSON.stringify(body)
      }).then(function (r) {
        if (!r.ok) return r.json().then(function (j) { throw new Error((j && j.error && j.error.message) || ('шлюз ответил ' + r.status)); });
        if (!onChunk) return r.json();
        /* SSE: one line at a time, the delta of each chunk goes to the caller */
        var reader = r.body.getReader();
        var dec = new TextDecoder();
        var buf = '';
        function pump() {
          return reader.read().then(function (step) {
            if (step.done) return true;
            buf += dec.decode(step.value, { stream: true });
            var lines = buf.split('\n');
            buf = lines.pop();
            lines.forEach(function (line) {
              var m = /^data: (.*)$/.exec(line.trim());
              if (!m) return;
              if (m[1] === '[DONE]') return;
              try {
                var j = JSON.parse(m[1]);
                var d = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
                if (d) onChunk(d);
              } catch (e) {}
            });
            return pump();
          });
        }
        return pump();
      });
    },

    /* ---------------- copy: the panel flashes the value, the clipboard gets it ---------------- */
    copy: function (text) {
      var s = String(text == null ? '' : text);
      if (!s) return Promise.resolve(false);
      if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(s).then(function () { return true; }, function () { return legacyCopy(s); });
      }
      return Promise.resolve(legacyCopy(s));
    },

    /* ---------------- what the panel shows ---------------- */
    status: function () {
      return {
        url: this.url(),
        key: this.maskedKey(),
        registered: !!this.meta(),
        meta: this.meta()
      };
    }
  };

  function legacyCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', 'readonly');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, text.length);
      var ok = document.execCommand('copy');
      ta.parentNode.removeChild(ta);
      return !!ok;
    } catch (e) { return false; }
  }

  (typeof window !== 'undefined' ? window : globalThis).MSEBridge = MSEBridge;
  if (typeof module !== 'undefined' && module.exports) module.exports = { MSEBridge: MSEBridge };
})();
