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
    /* the one address of an older build: it is cleared on the first read and on every setUrl, so nothing can pick
       it up again by itself */
    urlLegacyKey: 'mse.gateway.url.legacy',
    keyKey: 'mse.gateway.key',
    keyMirrorKey: 'mse:local:gatewayKey',
    metaKey: 'mse.gateway.meta',
    timeoutMs: 8000,
    agentTimeoutMs: 120000
  }, (typeof __MSE_CONFIG__ === 'object' && __MSE_CONFIG__) || {});

  /* every place the address can hide: the site localStorage, the Stay storage (`ss:L:` area, the same keys the
     panel writes through chrome.storage) and the two mirrors above */
  var URL_PLACES = [
    { where: 'localStorage', key: CONFIG.urlKey },
    { where: 'localStorage', key: CONFIG.urlMirrorKey },
    { where: 'localStorage', key: CONFIG.urlLegacyKey },
    { where: 'stay', key: CONFIG.urlKey },
    { where: 'stay', key: CONFIG.urlMirrorKey },
    { where: 'stay', key: 'mse:L:' + CONFIG.urlKey }
  ];
  var LEGACY_URLS = ['https://syncshare.ru/api/', 'https://mse-gateway.example-tailnet.ts.net'];

  /* ------------------------------------------------------------ storage: twice, so nothing is lost */
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }

  /* the Stay side of the storage. The page script does not see the extension api object: the runtime hands out its
     chosen backend (script storage, the site localStorage or memory — the same one the panel writes through), and
     that is what the second store is. A synchronous cache keeps the address readable without a tick. */
  var stayCache = {};
  var stayQueue = Promise.resolve();
  function stayStore() {
    var rt = window.__mseRuntime;
    if (rt && typeof rt.pageStorage === 'function') return rt.pageStorage();
    try {
      var api = window.browser || window.chrome;
      if (api && api.storage && api.storage.local) {
        return {
          get: function (k) { return Promise.resolve(api.storage.local.get(k)).then(function (o) { return o && o[k] !== undefined ? o[k] : null; }); },
          set: function (k, v) { var o = {}; o[k] = v; return Promise.resolve(api.storage.local.set(o)); },
          del: function (k) { return Promise.resolve(api.storage.local.remove ? api.storage.local.remove(k) : null); },
          keys: function () { return Promise.resolve(api.storage.local.get(null)).then(function (o) { return Object.keys(o || {}); }); }
        };
      }
    } catch (e) {}
    return null;
  }
  /* one name for the second store: the runtime prefix it uses for its own local area */
  function stayPrefixed(k) { return /^(mse|ss):L:/.test(k) ? k : 'mse:L:' + k; }
  function stayGet(k) {
    var full = stayPrefixed(k);
    if (Object.prototype.hasOwnProperty.call(stayCache, full)) return stayCache[full];
    var st = stayStore();
    if (st) {
      try {
        st.get(full).then(function (v) {
          if (v !== undefined && v !== null && v !== '') stayCache[full] = String(v);
          else delete stayCache[full];
        }, function () {});
      } catch (e) {}
    }
    return null;
  }
  function staySet(k, v) {
    var full = stayPrefixed(k);
    stayCache[full] = String(v);
    stayQueue = stayQueue.then(function () {
      var st = stayStore();
      if (!st) return null;
      try { return st.set(full, String(v)); } catch (e) { return null; }
    }).then(null, function () {});
    return stayQueue;
  }
  function stayDel(k) {
    var full = stayPrefixed(k);
    delete stayCache[full];
    stayQueue = stayQueue.then(function () {
      var st = stayStore();
      if (!st) return null;
      try { return st.del(full); } catch (e) { return null; }
    }).then(null, function () {});
    return stayQueue;
  }
  /* the truth on disk, not the cache: what the audit and the test read */
  function stayRead(k) {
    var st = stayStore();
    if (!st) return Promise.resolve(stayCache[stayPrefixed(k)] || null);
    return Promise.resolve(st.get(stayPrefixed(k))).then(function (v) { return v === undefined ? null : v; }, function () { return null; });
  }
  function stayKeys() {
    var st = stayStore();
    if (!st) return Promise.resolve(Object.keys(stayCache));
    return Promise.resolve(st.keys()).then(function (x) { return x || []; }, function () { return []; });
  }

  /* the address, from the one place it is allowed to be */
  function normUrl(raw) { return String(raw || '').trim().replace(/\/+$/, ''); }
  function sameUrl(a, b) { return normUrl(a) !== '' && normUrl(a) === normUrl(b); }
  /* after the address changes, the old one must not be left anywhere. This is a scan, not a fixed list: every key
     that looks like an address in every store is compared with the one that counts, and anything else is deleted. */
  var lastScrub = [];
  var urlGeneration = 0;
  function scrubUrl(keep) {
    var generation = urlGeneration;
    var kept = normUrl(keep);
    var dropped = [];
    function consider(where, key, value, del) {
      if (value === null || value === undefined || value === '') { if (where) del(); return; }
      if (kept && sameUrl(value, kept)) return;
      del();
      dropped.push(where + ':' + key);
    }
    var lsList = [];
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var lk = localStorage.key(i);
        if (/url/i.test(lk) && lsList.indexOf(lk) < 0) lsList.push(lk);
      }
    } catch (e) {}
    [CONFIG.urlKey, CONFIG.urlMirrorKey, CONFIG.urlLegacyKey].forEach(function (k) { if (lsList.indexOf(k) < 0) lsList.push(k); });
    lsList.forEach(function (k) {
      consider('localStorage', k, lsGet(k), function () { lsDel(k); });
    });
    return stayQueue.then(function () { return stayKeys(); }).then(function (all) {
      if (generation !== urlGeneration) return [];
      var mine = (all || []).filter(function (k) { return /url/i.test(k); });
      [CONFIG.urlKey, CONFIG.urlMirrorKey, CONFIG.urlLegacyKey].map(stayPrefixed).forEach(function (k) {
        if (mine.indexOf(k) < 0) mine.push(k);
      });
      return Promise.all(mine.map(function (k) { return stayRead(k); })).then(function (vals) {
        if (generation !== urlGeneration) return [];
        mine.forEach(function (k, i) {
          consider('stay', k, vals[i], function () { stayDel(k); });
        });
        try {
          var mirror = dig(window, CONFIG.urlMirrorKey.split(':'));
          if (mirror && (!kept || !sameUrl(mirror, kept))) {
            window[CONFIG.urlMirrorKey] = null;
            dropped.push('window:' + CONFIG.urlMirrorKey);
          }
        } catch (e) {}
        lastScrub = dropped;
        return dropped;
      });
    }, function () {
      lastScrub = dropped;
      return dropped;
    });
  }
  /* the places the address was removed from at the last change: the panel writes this line to its journal */
  function scrubLog() { return lastScrub.slice(); }
  /* every place, read for the audit the panel and the test use: what is really stored right now */
  function urlPlaces() {
    return URL_PLACES.map(function (place) {
      var v = place.where === 'localStorage' ? lsGet(place.key) : stayGet(place.key);
      return { where: place.where, key: place.key, value: v === undefined ? null : v };
    });
  }
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

  function sha256Hex(ascii) {
    function rightRotate(value, amount) { return (value >>> amount) | (value << (32 - amount)); }
    var mathPow = Math.pow; var maxWord = mathPow(2, 32); var lengthProperty = 'length';
    var i, j; var result = ''; var words = []; var asciiBitLength = ascii[lengthProperty] * 8;
    var hash = sha256Hex.h = sha256Hex.h || []; var k = sha256Hex.k = sha256Hex.k || [];
    var primeCounter = k[lengthProperty]; var isComposite = {};
    for (var candidate = 2; primeCounter < 64; candidate++) {
      if (!isComposite[candidate]) {
        for (i = candidate * candidate; i < 313; i += candidate) isComposite[i] = candidate;
        hash[primeCounter] = (mathPow(candidate, .5) * maxWord) | 0;
        k[primeCounter++] = (mathPow(candidate, 1 / 3) * maxWord) | 0;
      }
    }
    hash = hash.slice(0);
    ascii += '\x80';
    while (ascii[lengthProperty] % 64 - 56) ascii += '\x00';
    for (i = 0; i < ascii[lengthProperty]; i++) {
      j = ascii.charCodeAt(i);
      if (j >> 8) return '';
      words[i >> 2] |= j << ((3 - i) % 4) * 8;
    }
    words[words[lengthProperty]] = ((asciiBitLength / maxWord) | 0);
    words[words[lengthProperty]] = (asciiBitLength | 0);
    for (j = 0; j < words[lengthProperty];) {
      var w = words.slice(j, j += 16);
      var oldHash = hash;
      hash = hash.slice(0, 8);
      for (i = 0; i < 64; i++) {
        var w15 = w[i - 15], w2 = w[i - 2];
        var s0 = rightRotate(w15, 7) ^ rightRotate(w15, 18) ^ (w15 >>> 3);
        var s1 = rightRotate(w2, 17) ^ rightRotate(w2, 19) ^ (w2 >>> 10);
        var ch = (hash[4] & hash[5]) ^ (~hash[4] & hash[6]);
        var maj = (hash[0] & hash[1]) ^ (hash[0] & hash[2]) ^ (hash[1] & hash[2]);
        var temp1 = (hash[7] + (rightRotate(hash[4], 6) ^ rightRotate(hash[4], 11) ^ rightRotate(hash[4], 25)) + ch + k[i] + (w[i] = (i < 16) ? w[i] : (w[i - 16] + s0 + w[i - 7] + s1) | 0)) | 0;
        var temp2 = ((rightRotate(hash[0], 2) ^ rightRotate(hash[0], 13) ^ rightRotate(hash[0], 22)) + maj) | 0;
        hash = [(temp1 + temp2) | 0, hash[0], hash[1], hash[2], (hash[3] + temp1) | 0, hash[4], hash[5], hash[6]];
      }
      for (i = 0; i < 8; i++) hash[i] = (hash[i] + oldHash[i]) | 0;
    }
    for (i = 0; i < 8; i++) {
      for (var b = 3; b >= 0; b--) {
        var byte = (hash[i] >> (8 * b)) & 255;
        result += (byte < 16 ? '0' : '') + byte.toString(16);
      }
    }
    return result;
  }

  function tracedFetch(url, options) {
    var opts = options || {};
    var request = {method: opts.method || 'GET', url: String(url), body: opts.body || null};
    return window.fetch(url, opts).then(function (response) {
      if (window.__mse && window.__mse.onDebugTraffic && window.MSEBridge && window.MSEBridge.debugEnabled()) {
        response.clone().text().then(function (raw) {
          var parsed; try { parsed = JSON.parse(raw); } catch (_) { parsed = raw; }
          window.__mse.onDebugTraffic({request:request, response:{status:response.status, body:parsed}});
        }, function () {});
      }
      return response;
    }, function (error) {
      if (window.__mse && window.__mse.onDebugTraffic && window.MSEBridge && window.MSEBridge.debugEnabled()) window.__mse.onDebugTraffic({request:request, error:String(error && error.message || 'network')});
      throw error;
    });
  }
  function redactDump(value, key, depth, secrets) {
    if (depth > 30) return '[depth limit]';
    if (typeof value === 'string') {
      var text = value;
      if (key) text = text.split(key).join('[redacted]');
      (secrets || []).forEach(function (secret) { if (secret && secret.length >= 4) text = text.split(secret).join('[redacted]'); });
      return text.replace(/mse_[A-Za-z0-9_-]{20,}/g, '[redacted]')
        .replace(/\bBearer\s+[A-Za-z0-9_.-]+/gi, 'Bearer [redacted]')
        .replace(/(https?:\/\/[^\s"'<>?#]+)[?#][^\s"'<>]*/gi, '$1?[redacted]')
        .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '[script removed]')
        .replace(/<input\b[^>]*(?:type\s*=\s*["']?(?:hidden|password)|name\s*=\s*["']?(?:sesskey|token|password|csrf))[^>]*>/gi, '[hidden input removed]')
        .replace(/((?:sesskey|password|token|secret|csrf|session|authorization)\s*["']?\s*[:=]\s*["']?)[^\s"'&,<>}]+/gi, '$1[redacted]');
    }
    if (Array.isArray(value)) return value.map(function (v) { return redactDump(v,key,depth+1,secrets); });
    if (!value || typeof value !== 'object') return value;
    var out = {};
    var sensitiveInput = /^(hidden|password)$/i.test(String(value.type || '')) || /sess|token|secret|pass|csrf|auth|cookie/i.test(String(value.name || ''));
    Object.keys(value).forEach(function (name) {
      out[name] = (sensitiveInput && /^(value|text)$/i.test(name)) || /^(authorization|cookie|cookies|set-cookie|key|devicekey|api[-_]?key|password|passwd|secret|token|sesskey|session|csrf|xsrf|inlineMoodleScripts)$/i.test(name)
        ? '[redacted]' : redactDump(value[name],key,depth+1,secrets);
    });
    return out;
  }
  var lastAgentRequest = null;
  var MSEBridge = {
    /* ---------------- the address ---------------- */
    url: function () {
      var fromLs = lsGet(CONFIG.urlKey) || lsGet(CONFIG.urlMirrorKey);
      if (fromLs) {
        /* one address, one place: whatever is left elsewhere is cleared here, before it can be read again */
        scrubUrl(fromLs);
        return fromLs;
      }
      var fromStay = stayGet(CONFIG.urlKey) || stayGet(CONFIG.urlMirrorKey);
      if (fromStay) {
        var kept = normUrl(fromStay);
        lsSet(CONFIG.urlKey, kept);
        scrubUrl(kept);
        return kept;
      }
      return null;
    },
    /* where the address is stored right now, and every place that still holds something else — read from disk,
       not from the cache, so the answer is the truth after a reload */
    audit: function () {
      var current = this.url();
      var keys = [CONFIG.urlKey, CONFIG.urlMirrorKey, CONFIG.urlLegacyKey];
      var lsKeys = [];
      try {
        for (var i = 0; i < localStorage.length; i++) {
          var lk = localStorage.key(i);
          if (/url/i.test(lk) && lsKeys.indexOf(lk) < 0) lsKeys.push(lk);
        }
      } catch (e) {}
      var lsPlaces = lsKeys.map(function (k) { return { where: 'localStorage', key: k, value: lsGet(k) }; });
      return stayKeys().then(function (all) {
        var stayPlaces = (all || []).filter(function (k) { return /url/i.test(k); }).map(function (k) {
          return { where: 'stay', key: k, value: stayCache[k] === undefined ? null : stayCache[k] };
        });
        return Promise.all((all || []).filter(function (k) { return /url/i.test(k); }).map(function (k) { return stayRead(k); })).then(function (vals) {
          vals.forEach(function (v, i) { stayPlaces[i].value = v; });
          var places = lsPlaces.concat(stayPlaces);
          var strays = places.filter(function (p) { return p.value && !sameUrl(p.value, current); });
          return { url: current, places: places, strays: strays };
        });
      }, function () {
        var places = lsPlaces.concat(urlPlaces().filter(function (p) { return p.where === 'stay'; }));
        var strays = places.filter(function (p) { return p.value && !sameUrl(p.value, current); });
        return { url: current, places: places, strays: strays };
      });
    },
    setUrl: function (raw) {
      var url = normUrl(raw);
      urlGeneration++;
      if (!url) {
        lsDel(CONFIG.urlKey); lsDel(CONFIG.urlMirrorKey);
        stayDel(CONFIG.urlKey); stayDel(CONFIG.urlMirrorKey);
        scrubUrl(null);
        return null;
      }
      if (!/^https?:\/\/[^\s\/]+\.[^\s\/]+/.test(url) && !/^http:\/\/127\.0\.0\.1(:\d+)?$/.test(url) && !/^http:\/\/localhost(:\d+)?$/.test(url)) {
        throw new Error('this does not look like an address: an http:// or https:// with a domain is needed');
      }
      if (!/^https:/.test(url) && !/^http:\/\/(127\.0\.0\.1|localhost)/.test(url)) {
        throw new Error('without https only localhost works: the tunnel is always https');
      }
      /* the new address replaces the old one everywhere: written to both stores, then every other place is
         cleared, so there is exactly one address and no way back to the one before */
      staySet(CONFIG.urlKey, url);
      lsSet(CONFIG.urlKey, url);
      lsSet(CONFIG.urlMirrorKey, url);
      try { window[CONFIG.urlMirrorKey] = url; } catch (e) {}
      scrubUrl(url);
      return url;
    },

    /* ---------------- health: is that address a gateway of ours ---------------- */
    probe: function (raw) {
      var url = String(raw || this.url() || '').trim().replace(/\/+$/, '');
      if (!url) return Promise.reject(new Error('address is not set'));
      var started = Date.now();
      var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, CONFIG.timeoutMs);
      return tracedFetch(url + '/health', { method: 'GET', cache: 'no-store', headers: { accept: 'application/json' }, signal: ctrl ? ctrl.signal : undefined })
        .then(function (r) {
          return r.json().then(function (j) { return { ok: r.ok, status: r.status, json: j }; }, function () { return { ok: r.ok, status: r.status, json: null }; });
        })
        .then(function (res) {
          clearTimeout(timer);
          var j = res.json || {};
          var mine = !!(j && (j.name === 'MSE' || j.name === 'MSE gateway' || j.gateway === 'mse' || j.ok === true));
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
            message: !res.ok ? 'the address answered ' + res.status
              :!mine ? 'something answers at this address, but it is not an MSE gateway'
              : 'AI gateway is up'
          };
        }, function (e) {
          clearTimeout(timer);
          return { ok: false, reachable: false, mine: false, ms: Date.now() - started, message: 'address offline: ' + (e && e.name === 'AbortError' ? 'timeout' : (e && e.message) || 'network') };
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
    deviceId: function () {
      var m = this.meta();
      if (m && m.device) return m.device;
      var k = this.key();
      return k ? ('mse-' + sha256Hex(k).slice(0, 16)) : '';
    },
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
      this.setUrl('');
    },
    /* the api the panel and the test reach: no window property is the source of truth any more */
    places: urlPlaces,
    scrub: scrubUrl,
    cleared: scrubLog,

    /* ---------------- the call that matters: register this device with the gateway ---------------- */
    register: function (identity) {
      var self = this;
      var url = self.url();
      if (!url) return Promise.reject(new Error('the gateway address comes first'));
      var key = self.key();
      identity = identity || {};
      var body = { key: key, moodleId: String(identity.id || ''), name: String(identity.name || ''), site: String(identity.site || ''), deviceName: String((window.navigator && window.navigator.userAgent) || '').slice(0, 120) };
      if (!body.moodleId) return Promise.reject(new Error('user ID missing · open profile'));
      return tracedFetch(url + '/mse/v1/register', {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key }, body: JSON.stringify(body)
      }).then(function (r) {
        return r.json().then(function (j) {
          if (!r.ok) throw new Error((j && j.error && j.error.message) || ('the gateway answered ' + r.status));
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
    check: function (moodleId) {
      var self = this;
      var url = self.url();
      if (!url) return Promise.resolve({ state: 'no-url', message: 'gateway address is not set' });
      var key = self.key();
      var path = '/mse/v1/me' + (moodleId ? ('?moodleId=' + encodeURIComponent(moodleId)) : '');
      var headers = { authorization: 'Bearer ' + key, accept: 'application/json' };
      if (moodleId) headers['x-moodle-id'] = String(moodleId);
      return tracedFetch(url + path, { method: 'GET', headers: headers })
        .then(function (r) {
          return r.json().then(function (j) {
            var d = (j && j.device) || {};
            var headerStatus = r.headers.get('x-mse-status');
            var effState = headerStatus || (j && j.status) || (j && j.state) || (d && d.status) || (r.ok ? 'active' : (d.status === 'revoked' ? 'revoked' : 'pending'));
            var meta = self.saveMeta({ device: d, ok: r.ok }, { key: key, moodleId: d.moodleId || moodleId, name: d.name });
            var resObj;
            var qLeft = (j && j.quota != null) ? j.quota : (d && d.quota != null ? d.quota : null);
            var qLimit = (j && j.quotaLimit != null) ? j.quotaLimit : 200;
            var qUsed = (j && j.quotaUsed != null) ? j.quotaUsed : 0;
            var qResets = (j && (j.resets_after || j.quotaResetsAfter)) || null;
            if (r.status === 401 || effState === 'unregistered' || effState === 'unknown') {
              resObj = { state: 'unregistered', message: 'key is not bound', device: d, meta: meta };
            } else if (effState === 'revoked') {
              resObj = { state: 'revoked', message: 'key revoked', device: d, meta: meta };
            } else if (effState === 'pending') {
              resObj = { state: 'pending', message: 'waiting for approval', device: d, meta: meta };
            } else if (effState === 'active') {
              resObj = { state: 'active', message: 'key accepted', device: d, meta: meta, quota: qLeft, quotaLimit: qLimit, quotaUsed: qUsed, quotaResetsAfter: qResets };
            } else {
              resObj = { state: effState, message: (j && j.hint) || (j && j.message) || 'key not accepted', device: d, meta: meta };
            }
            try {
              lsSet('mse.cache.gw_check', JSON.stringify({ key: key, check: resObj, t: Date.now() }));
            } catch (_) {}
            return resObj;
          });
        }, function (e) {
          return { state: 'unreachable', message: 'the gateway does not answer: ' + (e && e.message ? e.message : 'network') };
        });
    },

    cachedCheck: function () {
      try {
        var raw = lsGet('mse.cache.gw_check');
        if (!raw) return null;
        var parsed = JSON.parse(raw);
        if (parsed && parsed.key === this.key() && parsed.check) return parsed.check;
      } catch (_) {}
      return null;
    },

    quota: function () {
      var self = this;
      var url = self.url();
      if (!url) return Promise.resolve({ ok: false, message: 'no gateway' });
      return tracedFetch(url + '/mse/v1/quota', {
        method: 'GET',
        headers: { authorization: 'Bearer ' + self.key(), accept: 'application/json' }
      }).then(function (r) {
        return r.json().then(function (j) {
          return Object.assign({ ok: r.ok, status: r.status }, j);
        });
      }, function (err) {
        return { ok: false, message: err.message };
      });
    },

    /* ---------------- the agent: the question goes out, the chosen answer comes back ---------------- */
    agent: function (payload, onStage) {
      var self = this;
      var url = self.url();
      if (!url) return Promise.resolve({ ok: false, code: 'no_gateway', message: 'gateway is not configured' });
      var started = Date.now();
      var body = {
        host: String(payload.host || ''),
        question: String(payload.question || '').slice(0, 4000),
        type: String(payload.type || ''),
        options: (payload.options || []).slice(0, 20).map(function (o) { return String(o).slice(0, 300); }),
        multiple: !!payload.multiple,
        selects: Array.isArray(payload.selects) ? payload.selects : [],
        textCount: Number(payload.textCount) || 0,
        image: payload.image || null,
        prior: payload.prior || null,
        moodleId: payload.moodleId || null
      };
      var timeoutMs = Number(payload.timeoutMs || CONFIG.agentTimeoutMs || 120000);
      var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, timeoutMs);
      var record = { request: { method: 'POST', url: url + '/mse/v1/agent', json: body }, response: null };
      lastAgentRequest = record;
      var reqHeaders = { 'content-type': 'application/json', accept: 'text/event-stream, application/json', authorization: 'Bearer ' + self.key() };
      if (payload.moodleId) reqHeaders['x-moodle-id'] = String(payload.moodleId);
      return tracedFetch(url + '/mse/v1/agent', {
        method: 'POST',
        headers: reqHeaders,
        body: JSON.stringify(body),
        signal: ctrl ? ctrl.signal : undefined
      }).then(function (r) {
        if (/text\/event-stream/i.test(String(r.headers.get('content-type') || '')) && r.body && r.body.getReader) {
          var reader = r.body.getReader(), decoder = new TextDecoder(), pending = '', result = null;
          function handle(block) {
            var name = '', data = [];
            block.split(/\r?\n/).forEach(function (line) {
              if (line.indexOf(':') === 0) return;
              if (line.indexOf('event:') === 0) name = line.slice(6).trim();
              if (line.indexOf('data:') === 0) data.push(line.slice(5).trim());
            });
            var value; try { value = JSON.parse(data.join('\n')); } catch (_) { return; }
            if (name === 'stage' && typeof onStage === 'function') onStage(value.stage);
            if (name === 'result') result = value;
          }
          function read() {
            return reader.read().then(function (part) {
              pending += decoder.decode(part.value || new Uint8Array(), {stream:!part.done});
              var blocks = pending.split(/\r?\n\r?\n/); pending = blocks.pop(); blocks.forEach(handle);
              if (!part.done) return read();
              if (pending) handle(pending);
              record.response = {status:r.status, json:result};
              return {status:r.status, j:result, retryAfter:Number(r.headers.get('retry-after') || 0)};
            });
          }
          return read();
        }
        return r.text().then(function (raw) {
          var j = null;
          try { j = JSON.parse(raw); } catch (e) {}
          record.response = { status: r.status, json: j, body: j === null ? raw : undefined };
          return { status: r.status, j: j, retryAfter: Number(r.headers.get('retry-after') || 0) };
        });
      }).then(function (res) {
        clearTimeout(timer);
        var j = res.j || {};
        var ms = Date.now() - started;
        if (res.status === 503 && !j.ok) {
          return { ok: false, code: j.code || 'model_unavailable', ms: ms, message: j.message || 'model unavailable, try another model' };
        }
        if (res.status === 429 || j.code === 'rate_limited') {
          return { ok: false, code: 'rate_limited', ms: ms, retryAfter: j.retry_after || res.retryAfter || 5, message: 'agent is busy, at the limit' };
        }
        if (!j.ok) return { ok: false, code: j.code || 'agent_error', ms: ms, message: j.message || ('the gateway answered ' + res.status) };
        return { ok: true, code: 'ok', ms: ms, answer: j.answer || null, confidence: j.confidence == null ? null : j.confidence, model: j.model || null, reasoning: j.reasoning ? String(j.reasoning).slice(0, 400) : null };
      }, function (e) {
        clearTimeout(timer);
        record.response = { error: (e && e.name) || 'network' };
        return { ok: false, code: (e && e.name === 'AbortError') ? 'timeout' : 'network', ms: Date.now() - started, message: (e && e.name === 'AbortError') ? ('the agent did not answer in ' + Math.round(timeoutMs / 1000) + ' s') : 'the request did not go out: ' + ((e && e.message) || 'network') };
      });
    },
    debugEnabled: function () { return lsGet('mse.debug.enabled') === '1'; },
    setDebugEnabled: function (on) { lsSet('mse.debug.enabled', on ? '1' : '0'); },
    sendDump: function (type, dump) {
      var self = this, url = self.url(), key = self.key();
      if (!url || !key) return Promise.resolve({ok:false, message:'gateway not set'});
      var secrets = [];
      try { String(document.cookie || '').split(';').forEach(function (part) {
        var n = part.indexOf('='); if (n >= 0) { var v = part.slice(n+1).trim(); secrets.push(v); try { secrets.push(decodeURIComponent(v)); } catch (_) {} }
      }); } catch (_) {}
      try { Array.prototype.forEach.call(document.querySelectorAll('input[type=hidden], input[type=password]'), function (input) { if (input.value) secrets.push(input.value); }); } catch (_) {}
      try { if (window.M && window.M.cfg && window.M.cfg.sesskey) secrets.push(String(window.M.cfg.sesskey)); } catch (_) {}
      secrets.slice().forEach(function (v) { if (v) secrets.push(encodeURIComponent(v)); });
      var safe = redactDump(dump, key, 0, secrets);
      var json = JSON.stringify(safe);
      if (json.length > 2000000) safe = {clientTruncated:true, preview:json.slice(0,160000)};
      return window.fetch(url + '/mse/v1/dump', {
        method:'POST', headers:{'content-type':'application/json', authorization:'Bearer '+key},
        body:JSON.stringify({type:type, dump:safe})
      }).then(function (r) { return r.json().then(function (j) {
        return r.ok && j.ok ? j : {ok:false,message:(j.error && j.error.message) || 'dump failed'};
      }); }, function () { return {ok:false,message:'gateway offline'}; });
    },
    snifAgent: function () { return lastAgentRequest; },

    /* ---------------- one chat call, for the “advanced” view: proves the whole chain ---------------- */
    chat: function (text, onChunk) {
      var self = this;
      var url = self.url();
      if (!url) return Promise.reject(new Error('gateway address is not set'));
      /* no model name here: the router decides which model the backend serves, the client never names one */
      var body = { stream: !!onChunk, messages: [{ role: 'user', content: String(text || 'ping') }] };
      return tracedFetch(url + '/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + self.key() },
        body: JSON.stringify(body)
      }).then(function (r) {
        if (!r.ok) return r.json().then(function (j) { throw new Error((j && j.error && j.error.message) || ('the gateway answered ' + r.status)); });
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
