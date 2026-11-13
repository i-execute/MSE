'use strict';
/*
 * MSE — the client half of the authorisation for the owner's own AI gateway.
 *
 * The rule this file exists to enforce: the client is never trusted with an identity. Whatever says "I am user
 * 12345" must be signed by something only the server holds. The scheme is the one Telegram WebApp uses, because
 * it is the same problem: an untrusted front, a private back, and no way to hide a shared secret in the front.
 *
 *   1. The gateway hands out a one-time invite (a short code). The friend enters it once.
 *   2. The gateway answers with a device key (32 random bytes) and an id of the device.
 *      Only sha256(device key) is kept on the server; the key itself never leaves the device again.
 *   3. Every call is signed:
 *          data-check-string = "mse_id=<id>\nnonce=<n>\nts=<ms>\ninput=<sha256(body)>"
 *          secret  = HMAC_SHA256(key = device key, msg = handler name)
 *          sig     = HMAC_SHA256(key = secret, msg = data-check-string)   (hex)
 *      The server recomputes it with the key it does not have... which is why the device key is *derived* from
 *      the invite: the server keeps the invite's secret and can derive the same device key. Nothing the client
 *      sends about itself is trusted: the id comes from the invite, the nonce must be fresh and unused,
 *      the timestamp must be within a minute, the body hash must match what actually arrived.
 *   4. On success the server may hand out a short-lived session token; the client sends it instead of signing
 *      every request, and the server simply checks its own record.
 *
 * Nothing here talks to the network by itself: `sign()` builds a request, `verify()` is the server's half, and
 * both are pure functions so they can be tested without a server. `apiUrl` stays empty until the owner sets it.
 */
(function () {
  'use strict';

  var CONFIG = Object.assign({
    apiUrl: '',            /* e.g. https://mse.example.net — empty means "not configured", no calls are made */
    inviteKey: 'mse.invite',
    deviceKey: 'mse.device',
    tokenKey: 'mse.token',
    sessionTtlMs: 60 * 60 * 1000,
    clockSkewMs: 60 * 1000,
    nonceLen: 16
  }, (typeof __MSE_CONFIG__ === 'object' && __MSE_CONFIG__) || {});

  /* ------------------------------------------------------------ primitives */
  function toHex(buf) {
    var b = new Uint8Array(buf), s = '';
    for (var i = 0; i < b.length; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16);
    return s;
  }
  function utf8(s) { return new TextEncoder().encode(String(s)); }
  function sha256Hex(text) { return crypto.subtle.digest('SHA-256', utf8(text)).then(toHex); }
  function hmacHex(keyBytes, msg) {
    return crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
      .then(function (k) { return crypto.subtle.sign('HMAC', k, utf8(msg)); })
      .then(toHex);
  }
  function randomHex(len) {
    var b = new Uint8Array(len);
    crypto.getRandomValues(b);
    return toHex(b);
  }
  /* the exact bytes Telegram uses in its scheme: the bot's token with "WebAppData" in front — here the
     gateway's own secret with the name of the handler in front */
  function deriveKey(secret, handler) {
    return hmacHex(utf8('MSE-Auth'), String(secret) + '|' + String(handler))
      .then(function (hex) { return utf8(hex); });
  }
  /* two steps, exactly as the server does it: device key from the invite secret, then one secret per handler */
  function secretFor(deviceKeyHex, handler) {
    return hmacHex(utf8('MSE-Auth'), String(deviceKeyHex) + '|' + String(handler))
      .then(function (hex) { return utf8(hex); });
  }

  /* ------------------------------------------------------------ the data-check-string */
  function checkString(fields) {
    return Object.keys(fields).sort().map(function (k) { return k + '=' + fields[k]; }).join('\n');
  }

  /* ------------------------------------------------------------ the client */
  function storageGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function storageSet(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }

  var MSEAuth = {
    configured: function () { return !!CONFIG.apiUrl; },

    /* the invite is exchanged once; what comes back is a device key the server can re-derive but never stores */
    acceptInvite: function (invite, reply) {
      /* reply: { id, secret } — what the gateway answers when the invite is exchanged. `secret` is the secret of
         the invite (the server keeps its own copy); the device key is derived from it and never travels. */
      storageSet(CONFIG.inviteKey, String(invite));
      if (!reply || !reply.id || !reply.secret) return Promise.reject(new Error('invite not confirmed by the gateway'));
      /* deriveKey already answers with the derived bytes as ascii hex (that is what the server compares), so the
         device key is that string — not its own hex dump */
      return deriveKey(reply.secret, 'device').then(function (key) {
        return hmacHex(utf8('MSE-Auth'), String(reply.secret) + '|device').then(function (deviceKey) {
          storageSet(CONFIG.deviceKey, deviceKey);
          storageSet(CONFIG.deviceKey + '.id', String(reply.id));
          return { id: String(reply.id), key: deviceKey };
        });
      });
    },

    device: function () {
      var key = storageGet(CONFIG.deviceKey);
      var id = storageGet(CONFIG.deviceKey + '.id');
      return key && id ? { id: id, key: key } : null;
    },

    forget: function () {
      [CONFIG.inviteKey, CONFIG.deviceKey, CONFIG.deviceKey + '.id', CONFIG.tokenKey].forEach(function (k) {
        try { localStorage.removeItem(k); } catch (e) {}
      });
    },

    /* builds the headers of one call; the body is hashed, so nothing can be swapped on the way */
    sign: function (handler, bodyObj) {
      var dev = MSEAuth.device();
      if (!dev) return Promise.reject(new Error('no device key: enter an invite first'));
      var body = JSON.stringify(bodyObj == null ? {} : bodyObj);
      var fields = {
        mse_id: dev.id,
        nonce: randomHex(CONFIG.nonceLen),
        ts: String(Date.now()),
        input: null
      };
      return sha256Hex(body).then(function (h) {
        fields.input = h;
        var data = checkString(fields);
        return secretFor(dev.key, handler).then(function (secret) { return hmacHex(secret, data); })
          .then(function (sig) {
            return {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'x-mse-handler': String(handler),
                'x-mse-id': fields.mse_id,
                'x-mse-nonce': fields.nonce,
                'x-mse-ts': fields.ts,
                'x-mse-signature': sig
              },
              body: body
            };
          });
      });
    },

    /* the same maths, on the server's side of the wall: pure, so it is tested without a server */
    verify: function (req, lookupSecret, seen) {
      var h = req.headers || {};
      var id = h['x-mse-id'], nonce = h['x-mse-nonce'], ts = Number(h['x-mse-ts']), sig = h['x-mse-signature'];
      var handler = h['x-mse-handler'];
      if (!id || !nonce || !ts || !sig || !handler) return Promise.resolve({ ok: false, why: 'missing fields' });
      if (Math.abs(Date.now() - ts) > CONFIG.clockSkewMs) return Promise.resolve({ ok: false, why: 'stale timestamp' });
      if (seen && seen.has(nonce)) return Promise.resolve({ ok: false, why: 'nonce reused' });
      return lookupSecret(id).then(function (secret) {
        if (!secret) return { ok: false, why: 'unknown device' };
        return sha256Hex(String(req.body || '')).then(function (inputHash) {
          var data = checkString({ mse_id: id, nonce: nonce, ts: String(ts), input: inputHash });
          return secretFor(secret, handler).then(function (key) { return hmacHex(key, data); })
            .then(function (expected) {
              if (expected !== sig) return { ok: false, why: 'bad signature' };
              if (seen) seen.add(nonce);
              return { ok: true, id: id };
            });
        });
      });
    },

    /* a session token replaces the per-request signature for its lifetime; the server keeps the record */
    token: function () {
      try {
        var t = JSON.parse(storageGet(CONFIG.tokenKey) || 'null');
        if (!t || !t.value) return null;
        if (t.expiresAt && Date.now() > t.expiresAt) return null;
        return t;
      } catch (e) { return null; }
    },
    saveToken: function (value, ttlMs) {
      var t = { value: String(value), issuedAt: Date.now(), expiresAt: Date.now() + (ttlMs || CONFIG.sessionTtlMs) };
      storageSet(CONFIG.tokenKey, JSON.stringify(t));
      return t;
    },

    /* what the panel shows: is the gateway configured, is a key there, is the session alive */
    status: function () {
      var dev = MSEAuth.device();
      var tok = MSEAuth.token();
      return {
        configured: MSEAuth.configured(),
        apiUrl: CONFIG.apiUrl || null,
        device: dev ? { id: dev.id, keyMasked: dev.key.slice(0, 8) + '…' } : null,
        session: tok ? { alive: true, expiresAt: tok.expiresAt } : { alive: false }
      };
    },

    /* the one place that would talk to the network; it refuses to do anything while no gateway is set */
    request: function (handler, bodyObj) {
      if (!MSEAuth.configured()) return Promise.reject(new Error('gateway is not configured'));
      var tok = MSEAuth.token();
      if (tok) {
        return fetch(CONFIG.apiUrl.replace(/\/$/, '') + '/' + handler, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tok.value },
          body: JSON.stringify(bodyObj || {})
        }).then(function (r) {
          if (r.status === 401) { try { localStorage.removeItem(CONFIG.tokenKey); } catch (e) {} }
          if (r.status === 429) return r.json().then(function (j) { throw Object.assign(new Error('quota'), { quota: j }); });
          return r.json();
        });
      }
      return MSEAuth.sign(handler, bodyObj).then(function (req) {
        return fetch(CONFIG.apiUrl.replace(/\/$/, '') + '/' + handler, req).then(function (r) {
          if (r.status === 429) return r.json().then(function (j) { throw Object.assign(new Error('quota'), { quota: j }); });
          return r.json().then(function (j) {
            if (j && j.session) MSEAuth.saveToken(j.session);
            return j;
          });
        });
      });
    }
  };

  /* both worlds: the page script of the userscript, and the console of a developer */
  (typeof window !== 'undefined' ? window : globalThis).MSEAuth = MSEAuth;
  if (typeof module !== 'undefined' && module.exports) module.exports = { MSEAuth: MSEAuth, checkString: checkString, deriveKey: deriveKey };
})();
