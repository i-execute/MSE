'use strict';
/*
 * MSE debug v2 — the diagnostic edition for Stay (iPhone/iPad/macOS Safari).
 *
 * Two jobs, one panel:
 *
 *   1. TRAFFIC. Records every request the page makes (fetch, XHR, resource timings, navigations) and
 *      looking across all of them for whatever the site uses to name the person: user ids, logins,
 *      full names, emails. Two sources: fields in JSON answers, and ids visible in the DOM.
 *
 *   2. KEY. A field where a secret key can be entered once; it is kept in the storage of the userscript
 *      and in the localStorage of the site, survives page changes and reloads, and is checked against a
 *      hash that is baked into this build (the same scheme a server would use: it never stores the key
 *      itself, only its SHA-256).
 *
 * Read-only towards the site: nothing is posted, nothing is changed; the requests the page makes are
 * observed, never altered or repeated.
 */
(function () {
  'use strict';

  var CONFIG = Object.assign({
    hotkey: 'd',
    bottomOffset: 96,
    maxEntries: 400,
    maxBody: 6000,
    showFab: true /* false when the MSE shell draws its own pill */
  }, (typeof __SS_DEBUG_CONFIG__ === 'object' && __SS_DEBUG_CONFIG__) || {});

  /* the SHA-256 of the key this build expects, replaced at build time (the key itself is never in the file) */
  var EXPECTED_SHA = '__SS_EXPECT_SHA256__';

  function boot() {
    var win = window;
    var doc = document;
    if (win.__ssDebugPanel) return;
    try { Object.defineProperty(win, '__ssDebugPanel', { value: true, enumerable: false }); } catch (e) { win.__ssDebugPanel = true; }

    /* ------------------------------------------------------------ tiny helpers */
    var LS = 'ssdbg.';
    function lsGet(k, dflt) {
      try { var v = win.localStorage.getItem(LS + k); return v === null ? dflt : v; } catch (e) { return dflt; }
    }
    function lsSet(k, v) {
      try { win.localStorage.setItem(LS + k, v); return true; } catch (e) { return false; }
    }
    function lsDel(k) {
      try { win.localStorage.removeItem(LS + k); } catch (e) {}
    }
    function bytes(n) {
      if (!n && n !== 0) return '—';
      if (n < 1024) return n + ' B';
      if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
      return (n / 1048576).toFixed(1) + ' MB';
    }
    function pad(n) { return n < 10 ? '0' + n : String(n); }
    function hhmmss(t) {
      var d = new Date(t);
      return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    }
    function shortUrl(u) {
      try {
        var x = new URL(u, String(win.location.href));
        return x.pathname + (x.search ? '?' + x.search.slice(1) : '');
      } catch (e) { return String(u); }
    }
    function clip(s, n) {
      s = String(s == null ? '' : s);
      return s.length > n ? s.slice(0, n) + '…' : s;
    }
    function sha256Hex(text) {
      var subtle = win.crypto && win.crypto.subtle;
      if (subtle && win.TextEncoder) {
        return subtle.digest('SHA-256', new win.TextEncoder().encode(text)).then(function (buf) {
          var b = new Uint8Array(buf), h = '';
          for (var i = 0; i < b.length; i++) h += (b[i] < 16 ? '0' : '') + b[i].toString(16);
          return h;
        });
      }
      return Promise.resolve(fnv(text));
    }
    /* a weak fallback for plain-http pages, where WebCrypto is not available: enough to show the idea */
    function fnv(s) {
      var a = 2166136261, b = 2166136261;
      for (var i = 0; i < s.length; i++) {
        a = (a ^ s.charCodeAt(i)) * 16777619 >>> 0;
        b = (b + s.charCodeAt(i) * (i + 7)) >>> 0;
      }
      var out = '';
      for (var k = 0; k < 4; k++) out += ('0000000' + ((a >>> (k * 8)) & 255).toString(16)).slice(-2);
      for (var j = 0; j < 4; j++) out += ('0000000' + ((b >>> (j * 8)) & 255).toString(16)).slice(-2);
      return 'fnv-' + out;
    }

    /* ------------------------------------------------------------ 1. traffic */
    var state = {
      net: [],
      seq: 0,
      enabled: lsGet('enabled', '1') === '1',
      recordBodies: lsGet('bodies', '1') === '1',
      identity: null,
      key: null,
      visits: []
    };

    var seen = new Set();

    function addEntry(e) {
      if (!state.enabled) return null;
      var key = e.method + ' ' + e.url + ' ' + (e.status || '') + ' ' + (e.from || '');
      if (seen.has(key)) return null;
      seen.add(key);
      e.id = ++state.seq;
      e.t = e.t || Date.now();
      state.net.push(e);
      if (state.net.length > CONFIG.maxEntries) state.net.shift();
      return e;
    }

    function bodyText(v) {
      if (v == null) return '';
      if (typeof v === 'string') return clip(v, CONFIG.maxBody);
      try { return clip(JSON.stringify(v), CONFIG.maxBody); } catch (e) { return ''; }
    }

    /* the answer of the site is worth keeping only as far as it may name the person */
    function sniffJson(text) {
      if (!text) return null;
      var s = String(text).trim();
      if (!s || (s[0] !== '{' && s[0] !== '[')) return null;
      try { return JSON.parse(s); } catch (e) { return null; }
    }

    function installSniffer() {
      /* fetch */
      try {
        var origFetch = win.fetch;
        if (typeof origFetch === 'function') {
          win.fetch = function (input, init) {
            var url = typeof input === 'string' ? input : (input && input.url) || String(input);
            var method = (init && init.method) || (input && input.method) || 'GET';
            var started = Date.now();
            var p = origFetch.apply(this, arguments);
            p.then(function (res) {
              var e = addEntry({ from: 'fetch', method: String(method).toUpperCase(), url: url, status: res.status, type: res.headers && res.headers.get ? (res.headers.get('content-type') || '') : '', ms: Date.now() - started });
              if (e && state.recordBodies) {
                try {
                  res.clone().text().then(function (t) {
                    e.size = t.length;
                    var j = sniffJson(t);
                    if (j) e.json = j;
                    renderIfOpen();
                  }, function () {});
                } catch (x) {}
              } else if (e) renderIfOpen();
            }, function () {
              addEntry({ from: 'fetch', method: String(method).toUpperCase(), url: url, status: 0, error: 'failed', ms: Date.now() - started });
              renderIfOpen();
            });
            return p;
          };
        }
      } catch (e) {}

      /* XMLHttpRequest */
      try {
        var XHR = win.XMLHttpRequest;
        if (XHR && XHR.prototype) {
          var open = XHR.prototype.open;
          var send = XHR.prototype.send;
          XHR.prototype.open = function (method, url) {
            this.__ssm = String(method || 'GET').toUpperCase();
            this.__ssu = String(url || '');
            this.__sst = Date.now();
            return open.apply(this, arguments);
          };
          XHR.prototype.send = function () {
            var self = this;
            self.addEventListener('loadend', function () {
              var ct = '';
              try { ct = self.getResponseHeader('content-type') || ''; } catch (e) {}
              var e = addEntry({ from: 'xhr', method: self.__ssm, url: self.__ssu, status: self.status, type: ct, ms: Date.now() - (self.__sst || Date.now()) });
              if (e && state.recordBodies) {
                try {
                  var t = self.responseType === '' || self.responseType === 'text' ? self.responseText : '';
                  if (t) {
                    e.size = t.length;
                    var j = sniffJson(t);
                    if (j) e.json = j;
                  }
                } catch (x) {}
              }
              renderIfOpen();
            });
            return send.apply(this, arguments);
          };
        }
      } catch (e) {}

      /* resource timings: every request of the page, including those made before this script ran */
      try {
        var collectPerf = function () {
          var list = [];
          try { list = win.performance.getEntriesByType('resource') || []; } catch (e) { list = []; }
          for (var i = 0; i < list.length; i++) {
            var r = list[i];
            addEntry({ from: 'perf', method: 'GET', url: r.name, status: null, type: r.initiatorType || '', ms: Math.round(r.duration || 0), size: r.transferSize || 0, t: Date.now() - Math.round(win.performance.now() - (r.responseEnd || 0)) });
          }
          var nav = [];
          try { nav = win.performance.getEntriesByType('navigation') || []; } catch (e) { nav = []; }
          for (var j = 0; j < nav.length; j++) {
            addEntry({ from: 'nav', method: 'GET', url: String(win.location.href), status: null, type: 'document', ms: Math.round(nav[j].duration || 0), t: Date.now() - Math.round(win.performance.now()) });
          }
        };
        collectPerf();
        if (win.PerformanceObserver) {
          try {
            var po = new win.PerformanceObserver(function () { collectPerf(); });
            po.observe({ entryTypes: ['resource', 'navigation'] });
          } catch (e) {}
        }
        win.setTimeout(collectPerf, 1200);
        win.setTimeout(collectPerf, 3500);
      } catch (e) {}

      /* where this browser has been: kept across pages, so a login step is visible from the quiz page too */
      try {
        var seenUrls = JSON.parse(lsGet('visits', '[]') || '[]');
        var here = String(win.location.href).split('#')[0];
        seenUrls.push({ t: Date.now(), url: here, title: String(doc.title || '') });
        if (seenUrls.length > 60) seenUrls = seenUrls.slice(-60);
        lsSet('visits', JSON.stringify(seenUrls));
        state.visits = seenUrls;
      } catch (e) {}
    }

    /* ------------------------------------------------------------ 2. who is it */
    var ID_KEYS = /(^|[_.-])(userid|user_id|useridnumber|idnumber|studentid|student_id|studentnumber|personid|person_id|authid|memberid|accountid|uid)$/i;
    var NAME_KEYS = /(fullname|full_name|firstname|lastname|first_name|last_name|username|displayname|display_name|nickname|email)$/i;
    var SKIP = /(sesskey|token|password|secret|csrf)/i;

    function harvest(obj, path, out, depth) {
      if (!obj || typeof obj !== 'object' || depth > 5 || out.length > 80) return out;
      var keys = Array.isArray(obj) ? null : Object.keys(obj);
      if (!keys) {
        for (var i = 0; i < Math.min(obj.length, 12); i++) harvest(obj[i], path + '[' + i + ']', out, depth + 1);
        return out;
      }
      keys.forEach(function (k) {
        if (SKIP.test(k)) return;
        var v = obj[k];
        var p = path ? path + '.' + k : k;
        if (v && typeof v === 'object') { harvest(v, p, out, depth + 1); return; }
        if (v === null || v === undefined) return;
        if (typeof v !== 'string' && typeof v !== 'number') return;
        var s = String(v);
        if (!s || s.length > 160) return;
        var isId = ID_KEYS.test(k);
        var isName = NAME_KEYS.test(k) || (typeof v === 'string' && /[\u0410-\u044f\u0401\u0451]{2,}\s+[\u0410-\u044f\u0401\u0451]{2,}/.test(s) && /name/i.test(k));
        if (isId || isName) out.push({ where: p, key: k, value: s, kind: isId ? 'id' : 'name' });
      });
      return out;
    }

    function fromPage() {
      var found = [];
      var cfg = null;
      try { cfg = win.M && win.M.cfg ? win.M.cfg : null; } catch (e) {}
      if (cfg) {
        if (cfg.userid != null) found.push({ where: 'M.cfg.userid', key: 'userid', value: String(cfg.userid), kind: 'id', src: 'page' });
        if (cfg.username) found.push({ where: 'M.cfg.username', key: 'username', value: String(cfg.username), kind: 'name', src: 'page' });
        if (cfg.siteId || cfg.siteid) found.push({ where: 'M.cfg.siteId', key: 'siteId', value: String(cfg.siteId || cfg.siteid), kind: 'id', src: 'page' });
      }
      /* ids that Moodle puts straight into the page */
      try {
        var links = doc.querySelectorAll('a[href*="user/profile.php"], a[href*="user/view.php"]');
        var ids = {};
        for (var i = 0; i < links.length && i < 40; i++) {
          var m = /[?&]id=(\d+)/.exec(links[i].getAttribute('href') || '');
          if (m && !ids[m[1]]) { ids[m[1]] = 1; found.push({ where: 'link ' + clip(shortUrl(links[i].getAttribute('href')), 60), key: 'id', value: m[1], kind: 'id', src: 'dom' }); }
        }
      } catch (e) {}
      /* the name usually sits in the avatar alt or in the user menu */
      try {
        var pics = doc.querySelectorAll('img.userpicture, img[src*="/user/icon"], img[src*="/user/pix"]');
        for (var j = 0; j < pics.length && j < 6; j++) {
          var alt = String(pics[j].getAttribute('alt') || '').trim();
          if (alt && !/^picture of/i.test(alt)) found.push({ where: 'avatar alt', key: 'alt', value: alt, kind: 'name', src: 'dom' });
          else if (alt) found.push({ where: 'avatar alt', key: 'alt', value: alt.replace(/^picture of\s*/i, ''), kind: 'name', src: 'dom' });
        }
        var ut = doc.querySelector('.usertext, [data-region="user-menu"] .usertext, #nav-user-menu');
        if (ut) {
          var txt = String(ut.textContent || '').replace(/\s+/g, ' ').trim();
          if (txt && txt.length < 120) found.push({ where: 'user menu', key: 'text', value: txt, kind: 'name', src: 'dom' });
        }
      } catch (e) {}
      /* inline scripts on this page, when M.cfg was not published to the page object */
      try {
        var scripts = doc.querySelectorAll('script:not([src])');
        for (var k = 0; k < scripts.length && k < 20; k++) {
          var t = scripts[k].textContent || '';
          if (t.length > 200000) continue;
          var mm = /"userid"\s*:\s*"?(\d+)/.exec(t) || /'userid'\s*:\s*'?(\d+)/.exec(t);
          if (mm) found.push({ where: 'inline script', key: 'userid', value: mm[1], kind: 'id', src: 'page' });
        }
      } catch (e) {}
      return found;
    }

    function fromTraffic() {
      var out = [];
      state.net.forEach(function (e) {
        if (e.json) harvest(e.json, shortUrl(e.url), out, 0);
      });
      /* the same id found in many answers is the strongest candidate */
      var byValue = {};
      out.forEach(function (f) {
        if (f.kind !== 'id') return;
        var v = byValue[f.value] || (byValue[f.value] = { value: f.value, count: 0, where: [] });
        v.count++;
        if (v.where.length < 5 && v.where.indexOf(f.where) < 0) v.where.push(f.where);
      });
      return { hits: out, candidates: Object.keys(byValue).map(function (k) { return byValue[k]; }).sort(function (a, b) { return b.count - a.count; }) };
    }

    function analyseIdentity() {
      var page = fromPage();
      var traffic = fromTraffic();
      var merged = page.concat(traffic.hits.filter(function (h) {
        return !page.some(function (p) { return p.value === h.value && p.key === h.key; });
      }));
      state.identity = { at: Date.now(), page: page, traffic: traffic.hits, candidates: traffic.candidates, merged: merged };
      return state.identity;
    }

    /* ------------------------------------------------------------ 3. the key */
    var KEY_LS = 'key';
    var KEY_META = 'key.meta';

    function gmGet(k) {
      try { if (typeof GM_getValue === 'function') return GM_getValue(k, null); } catch (e) {}
      return null;
    }
    function gmSet(k, v) {
      try { if (typeof GM_setValue === 'function') { GM_setValue(k, v); return true; } } catch (e) {}
      return false;
    }
    function gmDel(k) {
      try { if (typeof GM_deleteValue === 'function') { GM_deleteValue(k); } } catch (e) {}
    }

    function maskKey(k) {
      if (!k) return '';
      if (k.length <= 8) return k[0] + '•••' + k[k.length - 1];
      /* the first and the last group stay readable, so the owner can tell one key from another */
      var cut = k.lastIndexOf('-');
      var head = cut > 0 ? k.slice(0, cut + 1) : k.slice(0, k.length - 4);
      return head + '••••' + k.slice(-4);
    }

    function loadKey() {
      var fromGm = gmGet('ssdbg_key');
      var fromLs = lsGet(KEY_LS, '');
      var meta = {};
      try { meta = JSON.parse(lsGet(KEY_META, '{}') || '{}'); } catch (e) { meta = {}; }
      var value = fromGm || fromLs || '';
      /* every page load with a key in memory counts: this is what proves the key is remembered */
      if (value && !state.pagesBumped) {
        state.pagesBumped = true;
        if (meta.value === value) meta.pages = (meta.pages || 1) + 1;
        else { meta.value = value; meta.pages = 1; }
        meta.savedAt = meta.savedAt || Date.now();
        lsSet(KEY_META, JSON.stringify(meta));
      }
      state.key = {
        value: value,
        masked: maskKey(value),
        source: fromGm ? 'script storage (GM)' : (fromLs ? 'site localStorage' : '—'),
        inGm: !!fromGm,
        inLs: !!fromLs,
        savedAt: meta.savedAt || null,
        pages: meta.pages || 0
      };
      return state.key;
    }

    function saveKey(value) {
      var okGm = gmSet('ssdbg_key', value);
      var okLs = lsSet(KEY_LS, value);
      var meta = { savedAt: Date.now(), pages: 1 };
      /* how many page loads this key has seen: the real proof that it is remembered */
      try {
        var prev = JSON.parse(lsGet(KEY_META, '{}') || '{}');
        if (prev.value === value) meta.pages = (prev.pages || 1) + 1;
        meta.value = value;
      } catch (e) { meta.value = value; }
      lsSet(KEY_META, JSON.stringify(meta));
      loadKey();
      state.key.savedOk = { gm: okGm, ls: okLs };
      return state.key;
    }

    function forgetKey() {
      gmDel('ssdbg_key');
      lsDel(KEY_LS);
      lsDel(KEY_META);
      loadKey();
      return state.key;
    }

    function checkKey(value) {
      if (!value) return Promise.resolve({ ok: false, reason: 'empty' });
      var shaped = /^SS-DBG-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(value);
      return sha256Hex(value).then(function (h) {
        return { ok: h === EXPECTED_SHA, shape: shaped, sha: h.slice(0, 16) + '…', expected: EXPECTED_SHA.slice(0, 16) + '…' };
      });
    }

    /* ------------------------------------------------------------ cookies (kept from v1, compactly) */
    function readCookies() {
      var out = [];
      try {
        var raw = String(doc.cookie || '');
        if (raw) raw.split(';').forEach(function (part) {
          var i = part.indexOf('=');
          out.push({ name: (i < 0 ? part : part.slice(0, i)).trim(), value: (i < 0 ? '' : part.slice(i + 1)).trim(), source: 'document.cookie' });
        });
      } catch (e) {}
      return out;
    }

    /* ------------------------------------------------------------ the panel */
    var host = doc.createElement('div');
    host.setAttribute('style', 'all:initial;position:fixed;inset:0;z-index:2147483647;display:none;');
    var root;
    try { root = host.attachShadow({ mode: 'closed' }); } catch (e) { root = host; }

    var CSS = [
      '*{box-sizing:border-box}',
      '.wrap{position:absolute;inset:0;display:flex;align-items:stretch;justify-content:center;',
      'background:rgba(12,14,22,.66);-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);',
      'font:15px/1.4 -apple-system,system-ui,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#e9edf7}',
      '.panel{display:flex;flex-direction:column;width:100%;max-width:860px;background:#12151f;overflow:hidden}',
      '@media (min-width:760px){.wrap{align-items:center;padding:26px}.panel{border-radius:18px;max-height:92%;box-shadow:0 24px 70px rgba(0,0,0,.55)}}',
      '.head{display:flex;align-items:center;gap:10px;padding:calc(env(safe-area-inset-top,0px) + 13px) 14px 11px;border-bottom:1px solid #262b3a}',
      '.head h1{margin:0;font-size:16px;font-weight:650;letter-spacing:-.2px;flex:1 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.host{font-size:12px;color:#8d96ad;flex:0 1 auto;min-width:0;max-width:42%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '@media (max-width:430px){.head{padding-left:12px;padding-right:12px;gap:8px}.head h1{font-size:15px}.host{max-width:36%}}',
      '.tabs{display:flex;gap:6px;padding:8px 12px;border-bottom:1px solid #262b3a;overflow:auto}',
      '.tabs button{flex:0 0 auto}',
      'button{font:inherit;color:inherit;background:#1e2433;border:1px solid #2f374b;border-radius:10px;padding:7px 11px;cursor:pointer;-webkit-appearance:none;appearance:none}',
      'button:active{transform:scale(.985)}',
      'button.on{background:linear-gradient(145deg,#667eea,#4aa3f0);border-color:transparent;font-weight:600}',
      'button.primary{background:linear-gradient(145deg,#667eea,#4aa3f0);border-color:transparent;font-weight:600}',
      'button.ghost{background:transparent}',
      'button.icon{width:36px;height:36px;padding:0;display:flex;align-items:center;justify-content:center;font-size:18px}',
      '.bar{display:flex;gap:7px;flex-wrap:wrap;padding:9px 14px;border-bottom:1px solid #262b3a;align-items:center}',
      '.stats{flex:1 1 100%;font-size:12.5px;color:#9aa3ba;line-height:1.45}',
      '.body{flex:1 1 auto;overflow:auto;-webkit-overflow-scrolling:touch;padding:10px 14px calc(env(safe-area-inset-bottom,0px) + 18px)}',
      '.card{border:1px solid #2b3247;border-radius:12px;background:#171b28;padding:10px 12px;margin:0 0 10px}',
      '.card h2{margin:0 0 6px;font-size:13.5px;font-weight:650;color:#cbd6ff;letter-spacing:.1px}',
      '.row{display:flex;gap:8px;font-size:12.5px;line-height:1.4;padding:2px 0}',
      '.row .k{color:#8d96ad;flex:0 0 40%}',
      '.row .v{color:#e9edf7;flex:1 1 auto;min-width:0;word-break:break-word}',
      '.note{font-size:11.5px;color:#7d869c;line-height:1.45;margin-top:6px}',
      '.hit{font:12px/1.35 ui-monospace,SFMono-Regular,Menlo,monospace;color:#9fe6b4;word-break:break-all}',
      '.hit b{color:#ffd479;font-weight:600}',
      '.entry{border-bottom:1px solid #212736;padding:7px 0;font-size:12px}',
      '.entry:last-child{border-bottom:0}',
      '.entry .l1{display:flex;gap:8px;align-items:baseline}',
      '.entry .m{font-weight:650;font-size:11px;color:#93a0c0;flex:0 0 auto}',
      '.entry .u{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#dfe6f6}',
      '.entry .s{flex:0 0 auto;font-size:11px;color:#7d869c}',
      '.entry .meta{color:#6f788e;font-size:11px;margin-top:2px;display:flex;gap:8px;flex-wrap:wrap}',
      '.entry .b{color:#9aa3ba;font:11px/1.35 ui-monospace,Menlo,monospace;max-height:52px;overflow:hidden;word-break:break-all;margin-top:3px}',
      '.ok{color:#7ee0a0}.bad{color:#ff8f8f}.warn{color:#ffd479}',
      'input[type=text]{font:inherit;color:#e9edf7;background:#0f1219;border:1px solid #2f374b;border-radius:10px;padding:9px 11px;width:100%;-webkit-appearance:none;appearance:none}',
      '.empty{color:#6f788e;font-size:12.5px;padding:14px 4px;text-align:center}',
      '.mini{font-size:11.5px;color:#8d96ad}'
    ].join('');

    var style = doc.createElement('style');
    style.textContent = CSS;
    root.appendChild(style);

    var wrap = doc.createElement('div');
    wrap.className = 'wrap';
    root.appendChild(wrap);

    var panel = doc.createElement('div');
    panel.className = 'panel';
    wrap.appendChild(panel);

    var tab = 'overview';

    function el(tag, cls, text) {
      var n = doc.createElement(tag);
      if (cls) n.className = cls;
      if (text != null) n.textContent = text;
      return n;
    }

    function copy(text, btn) {
      var done = function (ok) {
        if (!btn) return;
        var old = btn.textContent;
        btn.textContent = ok ? '✓' : '✗';
        win.setTimeout(function () { btn.textContent = old; }, 1200);
      };
      var nav = win.navigator || {};
      if (nav.clipboard && nav.clipboard.writeText) {
        nav.clipboard.writeText(text).then(function () { done(true); }, function () { fallback(); });
      } else fallback();
      function fallback() {
        try {
          var ta = doc.createElement('textarea');
          ta.value = text;
          ta.setAttribute('readonly', '');
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          doc.body.appendChild(ta);
          ta.select();
          var ok = false;
          try { ok = doc.execCommand('copy'); } catch (e) { ok = false; }
          doc.body.removeChild(ta);
          done(ok);
        } catch (e) { done(false); }
      }
    }

    /* ------------------------------------------------------------ export */
    function jsonText() {
      var idc = state.identity || analyseIdentity();
      return JSON.stringify({
        url: String(win.location.href),
        collectedAt: new Date().toISOString(),
        userAgent: win.navigator && win.navigator.userAgent,
        identity: { page: idc.page, fromTraffic: idc.traffic, candidates: idc.candidates },
        key: state.key ? {
          masked: state.key.masked, source: state.key.source, savedAt: state.key.savedAt,
          pages: state.key.pages, inGm: state.key.inGm, inLs: state.key.inLs
        } : null,
        cookies: readCookies(),
        globalCookies: state.storeTotal,
        traffic: state.net.map(function (e) {
          return { t: e.t, from: e.from, method: e.method, url: e.url, status: e.status, type: e.type, ms: e.ms, size: e.size, json: e.json || undefined };
        }),
        visits: state.visits
      }, null, 2);
    }

    function reportText() {
      var idc = state.identity || analyseIdentity();
      var out = [];
      out.push('MSE debug v2');
      out.push('page: ' + String(win.location.href));
      out.push('time: ' + new Date().toISOString());
      out.push('browser: ' + (win.navigator && win.navigator.userAgent));
      out.push('');
      out.push('== WHO THE USER IS ==');
      if (!idc.merged.length) out.push('  nothing found: no ids, no names (neither on the page nor in the responses)');
      idc.merged.slice(0, 40).forEach(function (f) {
        out.push('  [' + (f.kind === 'id' ? 'id  ' : 'name ') + '] ' + f.value + '   ← ' + f.where + (f.src ? ' (' + f.src + ')' : ''));
      });
      if (idc.candidates.length) {
        out.push('');
        out.push('  the most frequent ids in the server responses:');
        idc.candidates.slice(0, 8).forEach(function (c) { out.push('    ' + c.value + '  × ' + c.count + '  (' + c.where.join('; ') + ')'); });
      }
      out.push('');
      out.push('== KEY ==');
      var K = state.key || loadKey();
      if (!K.value) out.push('  not set');
      else {
        out.push('  set: ' + K.masked);
        out.push('  stored in: ' + K.source + (K.inGm ? ' + GM' : '') + (K.inLs ? ' + localStorage' : ''));
        out.push('  saved: ' + (K.savedAt ? new Date(K.savedAt).toISOString() : '—'));
        out.push('  pages with this key: ' + (K.pages || 1));
      }
      out.push('');
      out.push('== TRAFFIC (' + state.net.length + ' records) ==');
      state.net.slice(-120).forEach(function (e) {
        out.push('  ' + hhmmss(e.t) + '  ' + (e.method || 'GET') + '  ' + (e.status == null ? '—' : e.status) + '  '
          + (e.size != null ? bytes(e.size) : '') + '  ' + String(e.url).slice(0, 220));
      });
      out.push('');
      out.push('== PAGES IN THIS BROWSER ==');
      (state.visits || []).slice(-20).forEach(function (v) { out.push('  ' + hhmmss(v.t) + '  ' + String(v.url).slice(0, 200)); });
      out.push('');
      out.push('== COOKIES VISIBLE TO THE SCRIPT (' + readCookies().length + ') ==');
      readCookies().forEach(function (c) { out.push('  ' + c.name + ' = ' + c.value); });
      return out.join('\n');
    }

    /* ------------------------------------------------------------ render */
    function renderHead() {
      var head = el('div', 'head');
      var h1 = el('h1', null, 'MSE · debug');
      var hs = el('div', 'host', String(win.location.host));
      var close = el('button', 'icon', '×');
      close.setAttribute('aria-label', 'Close');
      close.addEventListener('click', hide);
      head.appendChild(h1); head.appendChild(hs); head.appendChild(close);
      panel.appendChild(head);
    }

    function renderTabs() {
      var tabs = el('div', 'tabs');
      [['overview', 'Overview'], ['traffic', 'Traffic'], ['me', 'Who am I'], ['key', 'Key']].forEach(function (t) {
        var b = el('button', tab === t[0] ? 'on' : '', t[1]);
        b.addEventListener('click', function () { tab = t[0]; render(); });
        tabs.appendChild(b);
      });
      panel.appendChild(tabs);
    }

    function renderBar() {
      var bar = el('div', 'bar');
      var stats = el('div', 'stats');
      stats.textContent = 'requests: ' + state.net.length + ' · cookies: ' + readCookies().length
        + (state.storeTotal != null ? ' · in the bank: ' + state.storeTotal : '')
        + ' · key: ' + (state.key && state.key.value ? 'set' : 'none');
      bar.appendChild(stats);
      var bJson = el('button', 'primary', 'JSON');
      bJson.addEventListener('click', function (e) { copy(jsonText(), e.target); });
      var bRep = el('button', '', 'Report');
      bRep.addEventListener('click', function (e) { copy(reportText(), e.target); });
      var bScan = el('button', '', 'Scan');
      bScan.addEventListener('click', function () { analyseIdentity(); loadKey(); render(); });
      bar.appendChild(bJson); bar.appendChild(bRep); bar.appendChild(bScan);
      panel.appendChild(bar);
    }

    function cardOverview() {
      var idc = state.identity || analyseIdentity();
      var c = el('div', 'card');
      c.appendChild(el('h2', null, 'Who the user is'));
      var best = idc.candidates[0];
      var named = idc.merged.filter(function (f) { return f.kind === 'name'; })[0];
      var simple = idc.merged.filter(function (f) { return f.kind === 'id'; })[0];
      if (!idc.merged.length) {
        c.appendChild(el('div', 'hit', 'nothing yet — open a page where you are signed in and press “Scan”'));
      } else {
        if (named) { var r1 = el('div', 'row'); r1.appendChild(el('span', 'k', 'name')); r1.appendChild(el('span', 'v', clip(named.value, 60))); c.appendChild(r1); }
        if (simple) { var r2 = el('div', 'row'); r2.appendChild(el('span', 'k', 'id')); r2.appendChild(el('span', 'v', simple.value)); c.appendChild(r2); }
        if (best) { var r3 = el('div', 'row'); r3.appendChild(el('span', 'k', 'most often')); r3.appendChild(el('span', 'v', best.value + '  × ' + best.count)); c.appendChild(r3); }
      }
      c.appendChild(el('div', 'note', 'Sources: the page · M.cfg, profile links, avatar. Server responses: the sniffer. Full list: “Who am I”.'));
      return c;
    }

    function cardKeyShort() {
      var K = state.key || loadKey();
      var c = el('div', 'card');
      c.appendChild(el('h2', null, 'Key'));
      var r = el('div', 'row');
      r.appendChild(el('span', 'k', 'state'));
      r.appendChild(el('span', 'v ' + (K.value ? 'ok' : 'warn'), K.value ? 'set: ' + K.masked : 'not set'));
      c.appendChild(r);
      var r2 = el('div', 'row');
      r2.appendChild(el('span', 'k', 'pages with the key'));
      r2.appendChild(el('span', 'v', String(K.pages || (K.value ? 1 : 0))));
      c.appendChild(r2);
      c.appendChild(el('div', 'note', 'Key entered on “Key”, page reloaded: it must survive. This checks that the script remembers it.'));
      return c;
    }

    function cardTrafficShort() {
      var c = el('div', 'card');
      c.appendChild(el('h2', null, 'Traffic'));
      var withJson = state.net.filter(function (e) { return e.json; }).length;
      var r = el('div', 'row');
      r.appendChild(el('span', 'k', 'requests recorded'));
      r.appendChild(el('span', 'v', String(state.net.length)));
      c.appendChild(r);
      var r2 = el('div', 'row');
      r2.appendChild(el('span', 'k', 'with a JSON response'));
      r2.appendChild(el('span', 'v', String(withJson)));
      c.appendChild(r2);
      c.appendChild(el('div', 'note', 'Requests from before the script was installed carry timing only, no status.'));
      return c;
    }

    function renderOverview() {
      var body = el('div', 'body');
      body.appendChild(cardOverview());
      body.appendChild(cardKeyShort());
      body.appendChild(cardTrafficShort());
      /* which requests look like the ones that name the user */
      var interesting = state.net.filter(function (e) { return /\/(api|user|profile|login|auth|session|my)\b|userid|\/my\/|dashboard/i.test(String(e.url)); });
      var c = el('div', 'card');
      c.appendChild(el('h2', null, 'Looks like “who am I” (' + interesting.length + ')'));
      if (!interesting.length) c.appendChild(el('div', 'empty', 'nothing similar'));
      interesting.slice(-12).reverse().forEach(function (e) { c.appendChild(entryRow(e)); });
      body.appendChild(c);
      panel.appendChild(body);
    }

    function entryRow(e) {
      var d = el('div', 'entry');
      var l1 = el('div', 'l1');
      l1.appendChild(el('span', 'm', e.method || 'GET'));
      l1.appendChild(el('span', 'u', shortUrl(e.url)));
      l1.appendChild(el('span', 's', (e.status == null ? '—' : e.status)));
      d.appendChild(l1);
      var meta = el('div', 'meta');
      meta.appendChild(el('span', null, hhmmss(e.t)));
      meta.appendChild(el('span', null, e.from));
      if (e.type) meta.appendChild(el('span', null, clip(String(e.type).split(';')[0], 28)));
      if (e.ms) meta.appendChild(el('span', null, e.ms + ' ms'));
      if (e.size) meta.appendChild(el('span', null, bytes(e.size)));
      d.appendChild(meta);
      if (e.json) {
        var hits = harvest(e.json, '', [], 0);
        if (hits.length) {
          var b = el('div', 'b');
          b.textContent = hits.slice(0, 4).map(function (h) { return h.key + '=' + clip(h.value, 40); }).join('  ');
          d.appendChild(b);
        }
      }
      return d;
    }

    function renderTraffic() {
      var body = el('div', 'body');
      var c = el('div', 'card');
      c.appendChild(el('h2', null, 'Requests'));
      if (!state.net.length) c.appendChild(el('div', 'empty', 'empty — reload the page with the panel open'));
      state.net.slice(-80).reverse().forEach(function (e) { c.appendChild(entryRow(e)); });
      body.appendChild(c);

      var d = el('div', 'card');
      d.appendChild(el('h2', null, 'Pages in this browser'));
      (state.visits || []).slice(-14).reverse().forEach(function (v) {
        var r = el('div', 'row');
        r.appendChild(el('span', 'k', hhmmss(v.t)));
        r.appendChild(el('span', 'v', clip(shortUrl(v.url), 70)));
        d.appendChild(r);
      });
      body.appendChild(d);
      panel.appendChild(body);
    }

    function renderMe() {
      var body = el('div', 'body');
      var idc = state.identity || analyseIdentity();
      var c = el('div', 'card');
      c.appendChild(el('h2', null, 'Found on the page (' + idc.page.length + ')'));
      if (!idc.page.length) c.appendChild(el('div', 'empty', 'nothing'));
      idc.page.forEach(function (f) {
        var r = el('div', 'row');
        r.appendChild(el('span', 'k', f.kind === 'id' ? 'id' : 'name'));
        var v = el('span', 'v', clip(f.value, 70));
        r.appendChild(v);
        c.appendChild(r);
        var n = el('div', 'mini', '← ' + f.where);
        r.appendChild(n);
      });
      body.appendChild(c);

      var d = el('div', 'card');
      d.appendChild(el('h2', null, 'Found in the server responses (' + idc.traffic.length + ')'));
      if (!idc.traffic.length) d.appendChild(el('div', 'empty', 'nothing — is “record response bodies” on?'));
      idc.traffic.slice(0, 40).forEach(function (f) {
        var r = el('div', 'row');
        r.appendChild(el('span', 'k', f.kind === 'id' ? 'id' : 'name'));
        r.appendChild(el('span', 'v', clip(f.value, 70)));
        d.appendChild(r);
        d.appendChild(el('div', 'mini', '← ' + f.where));
      });
      body.appendChild(d);

      var e2 = el('div', 'card');
      e2.appendChild(el('h2', null, 'Candidates (id)'));
      if (!idc.candidates.length) e2.appendChild(el('div', 'empty', 'none'));
      idc.candidates.slice(0, 10).forEach(function (cd) {
        var r = el('div', 'row');
        r.appendChild(el('span', 'k', cd.value));
        r.appendChild(el('span', 'v', '× ' + cd.count + '  ' + clip(cd.where.join('; '), 40)));
        e2.appendChild(r);
      });
      e2.appendChild(el('div', 'note', 'The most frequent id in the server responses is usually the “student number” in this system.'));
      body.appendChild(e2);
      panel.appendChild(body);
    }

    function renderKey() {
      var K = state.key || loadKey();
      var body = el('div', 'body');

      var c = el('div', 'card');
      c.appendChild(el('h2', null, 'Secret key'));
      c.appendChild(el('div', 'note', 'The key lives in script storage and site localStorage, survives reloads and navigation. The check is SHA-256: the key itself never lands in the script.'));

      var input = doc.createElement('input');
      input.type = 'text';
      input.setAttribute('autocapitalize', 'off');
      input.setAttribute('autocorrect', 'off');
      input.setAttribute('spellcheck', 'false');
      input.setAttribute('placeholder', 'SS-DBG-XXXX-XXXX-XXXX');
      input.value = K.value || '';
      var pad = el('div');
      pad.style.marginTop = '8px';
      pad.appendChild(input);
      c.appendChild(pad);

      var buttons = el('div', 'bar');
      buttons.style.padding = '10px 0 0';
      buttons.style.borderBottom = '0';
      var verdict = el('div', 'note', '');

      var bSave = el('button', 'primary', 'Save');
      bSave.addEventListener('click', function () {
        var v = String(input.value || '').trim();
        if (!v) { verdict.className = 'note bad'; verdict.textContent = 'empty'; return; }
        saveKey(v);
        checkKey(v).then(function (r) {
          verdict.className = 'note ' + (r.ok ? 'ok' : 'warn');
          verdict.textContent = r.ok
            ? 'saved · the key matches the expected one (' + r.sha + ')'
            : 'saved · but this is not the key this build expects (' + r.sha + ' vs ' + r.expected + ')';
          render();
        });
      });
      var bCheck = el('button', '', 'Check');
      bCheck.addEventListener('click', function () {
        checkKey(String(input.value || '').trim()).then(function (r) {
          verdict.className = 'note ' + (r.ok ? 'ok' : 'bad');
          verdict.textContent = r.ok ? 'correct key (' + r.sha + ')' : (r.shape ? 'right format, wrong key' : 'wrong format') + ' (' + r.sha + ')';
        });
      });
      var bForget = el('button', 'ghost', 'Forget');
      bForget.addEventListener('click', function () { forgetKey(); input.value = ''; verdict.className = 'note'; verdict.textContent = 'key removed'; render(); });

      buttons.appendChild(bSave); buttons.appendChild(bCheck); buttons.appendChild(bForget);
      c.appendChild(buttons);
      c.appendChild(verdict);
      body.appendChild(c);

      var s = el('div', 'card');
      s.appendChild(el('h2', null, 'What is in memory now'));
      [['set', K.value ? K.masked : '—'],
       ['stored in', K.value ? K.source : '—'],
       ['saved', K.savedAt ? new Date(K.savedAt).toLocaleString() : '—'],
       ['pages with this key', String(K.pages || (K.value ? 1 : 0))]
      ].forEach(function (p) {
        var r = el('div', 'row');
        r.appendChild(el('span', 'k', p[0]));
        r.appendChild(el('span', 'v', p[1]));
        s.appendChild(r);
      });
      s.appendChild(el('div', 'note', '“Pages with this key” grows with every page load: a number above 1 means the extension really remembers the key across pages.'));
      body.appendChild(s);

      /* the same view as v1: what the site tells a script about the session */
      var ck = el('div', 'card');
      var cc = readCookies();
      ck.appendChild(el('h2', null, 'Cookies visible to the script (' + cc.length + ')'));
      if (!cc.length) ck.appendChild(el('div', 'empty', 'none'));
      cc.forEach(function (x) {
        var r = el('div', 'row');
        r.appendChild(el('span', 'k', x.name));
        r.appendChild(el('span', 'v', x.value));
        ck.appendChild(r);
      });
      ck.appendChild(el('div', 'note', 'Safari does not hand HttpOnly cookies to scripts — neither this script nor any other can read their values.'));
      body.appendChild(ck);
      panel.appendChild(body);
    }

    function renderIfOpen() {
      if (host.style.display === 'none') return;
      if (tab !== 'traffic' && tab !== 'overview') return;
      render();
    }

    function render() {
      panel.innerHTML = '';
      renderHead();
      renderTabs();
      renderBar();
      if (tab === 'overview') renderOverview();
      else if (tab === 'traffic') renderTraffic();
      else if (tab === 'me') renderMe();
      else renderKey();
    }

    function open() {
      host.style.display = 'block';
      if (!host.isConnected) doc.documentElement.appendChild(host);
      loadKey();
      analyseIdentity();
      render();
      return true;
    }
    function hide() {
      host.style.display = 'none';
      return true;
    }

    /* ------------------------------------------------------------ the floating button */
    var fab = doc.createElement('div');
    fab.setAttribute('style', 'all:initial;position:fixed;right:12px;bottom:calc(env(safe-area-inset-bottom,0px) + ' +
      (Number(CONFIG.bottomOffset) || 96) + 'px);z-index:2147483646;');
    var fabRoot;
    try { fabRoot = fab.attachShadow({ mode: 'closed' }); } catch (e) { fabRoot = fab; }
    var fabBtn = doc.createElement('button');
    fabBtn.setAttribute('type', 'button');
    fabBtn.setAttribute('aria-label', 'MSE debug');
    fabBtn.setAttribute('style', 'all:initial;display:flex;align-items:center;justify-content:center;width:46px;height:46px;border-radius:50%;' +
      'background:rgba(18,21,31,.92);border:1px solid rgba(255,255,255,.16);box-shadow:0 8px 22px rgba(0,0,0,.35);cursor:pointer;' +
      '-webkit-appearance:none;appearance:none;');
    fabBtn.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#9ec1ff" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round"><path d="M3 17l5-6 4 4 3-3 6 5"></path><circle cx="7" cy="7" r="2"></circle></svg>';
    fabRoot.appendChild(fabBtn);

    /* ------------------------------------------------------------ the entry points */
    function mountFab() {
      if (CONFIG.showFab === false) return;
      if (!fab.isConnected && doc.documentElement) doc.documentElement.appendChild(fab);
    }
    fabBtn.addEventListener('click', function () { open(); });

    try { if (typeof GM_registerMenuCommand === 'function') GM_registerMenuCommand('MSE debug: open', function () { open(); }); } catch (e) {}

    doc.addEventListener('keydown', function (ev) {
      var t = ev.target && ev.target.tagName;
      if (/INPUT|TEXTAREA|SELECT/.test(t || '')) return;
      if (ev.key === 'Escape' && host.style.display !== 'none') { hide(); return; }
      if ((ev.key === CONFIG.hotkey || ev.key === CONFIG.hotkey.toUpperCase()) && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
        ev.preventDefault();
        open();
      }
    }, true);

    /* public entry points: the panel lives in a closed shadow root, so the page (and the tests) use these */
    win.__ssDebugOpen = open;
    win.__ssDebugHide = hide;
    win.__ssDebugCollect = function () {
      loadKey();
      return Promise.resolve().then(analyseIdentity).then(function () { return { identity: state.identity, key: state.key, net: state.net.length }; });
    };
    win.__ssDebugState = function () {
      var px = panel.querySelector('.panel') ? panel : null;
      var txt = function (sel) { var n = px && px.querySelector(sel); return n ? String(n.textContent || '').replace(/\s+/g, ' ').trim() : ''; };
      return {
        host: txt('.host'),
        stats: txt('.stats'),
        tab: tab,
        visible: host.style.display !== 'none',
        root: root,
        panelText: String(panel.textContent || '').replace(/\s+/g, ' ').trim(),
        identity: state.identity,
        key: state.key,
        net: state.net.length,
        entries: state.net.slice(-30).map(function (e) { return { method: e.method, url: e.url, status: e.status, from: e.from }; }),
        hasFab: !!fab.isConnected
      };
    };
    /* the whole thing as the two buttons export it, for the tests and the console */
    win.__ssDebugExport = function () { return { json: jsonText(), report: reportText() }; };
    win.__ssDebugKey = function (value) {
      if (value === undefined) return state.key || loadKey();
      if (value === null) return forgetKey();
      return saveKey(String(value));
    };

    /* ------------------------------------------------------------ go */
    installSniffer();
    loadKey();
    mountFab();
    /* the jar total, when Safari lets a script count it */
    try {
      if (win.cookieStore && typeof win.cookieStore.getAll === 'function') {
        win.cookieStore.getAll().then(function (all) { state.storeTotal = (all || []).length; renderIfOpen(); }, function () {});
      }
    } catch (e) {}
    analyseIdentity();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
