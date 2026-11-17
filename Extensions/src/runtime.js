/*
 * SyncShare -> Stay compatibility runtime.
 *
 * Emulates the small part of the WebExtension API that the original SyncShare
 * extension uses (runtime, storage, i18n, tabs, contextMenus, permissions,
 * extension, action, management) on top of userscript GM_* APIs, and runs the
 * original, unmodified bundles (background + content scripts + popup) inside
 * one page.
 *
 * NOTE: this file is processed by build.js (comments are stripped, slashes in
 * literals are escaped), so it must stay plain ES2019 without `window.` text.
 */
function createSyncShareRuntime(env) {
  'use strict';

  var win = env.win;
  var doc = env.doc;
  var nav = env.nav || win.navigator;
  var gm = env.gm || {};
  var RES = env.resources || {};
  var PAGES = env.pages || {};
  var MANIFEST = env.manifest || { name: 'SyncShare', version: '0' };
  var LOCALES = env.locales || {};
  var CONFIG = Object.assign(
    {
      extId: 'syncshare-stay',
      extScheme: 'safari-web-extension',
      keyPrefix: 'ss:',
      sessionGapMs: 8 * 60 * 60 * 1000,
      bgReadyTimeoutMs: 12000,
      gmWatchdogMs: 4000,
      transport: 'auto',
      storageProbeTimeoutMs: 2500,
      lazyFlushMs: 2000,
      noTelemetry: true,
      consentGate: true,
      debug: false,
      popupHash: '#syncshare',
      leaveGraceMs: 4000,
      journalMaxAgeMs: 7 * 24 * 60 * 60 * 1000,
      journalForeignAgeMs: 30000,
      journalMaxChars: 1500000,
      contentCss: true
    },
    env.config || {}
  );
  var EXT_BASE = (CONFIG.extScheme || 'safari-web-extension') + ':' + '/' + '/' + CONFIG.extId + '/';
  var TAB = { id: 1, index: 0, windowId: 1, active: true, highlighted: true, pinned: false, incognito: false };
  var setT = function (fn, ms) { return win.setTimeout(fn, ms); };
  var clearT = function (id) { return win.clearTimeout(id); };

  function dbg() {
    if (!CONFIG.debug) return;
    try {
      var a = Array.prototype.slice.call(arguments);
      a.unshift('[SyncShare/Stay]');
      win.console.log.apply(win.console, a);
    } catch (e) {}
  }
  function warn() {
    try {
      var a = Array.prototype.slice.call(arguments);
      a.unshift('[SyncShare/Stay]');
      win.console.warn.apply(win.console, a);
    } catch (e) {}
  }

  /* ------------------------------------------------------------------ */
  /* helpers                                                            */
  /* ------------------------------------------------------------------ */
  function clone(v) {
    if (v === undefined) return undefined;
    var s = JSON.stringify(v);
    return s === undefined ? undefined : JSON.parse(s);
  }
  function sameJson(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  function withTimeout(promise, ms, label) {
    return new Promise(function (resolve, reject) {
      var t = setT(function () { reject(new Error('timeout: ' + label)); }, ms);
      Promise.resolve(promise).then(
        function (v) { clearT(t); resolve(v); },
        function (e) { clearT(t); reject(e); }
      );
    });
  }
  function defer() {
    var d = {};
    d.promise = new Promise(function (res, rej) { d.resolve = res; d.reject = rej; });
    return d;
  }
  function makeEvent(onAdd) {
    var ls = [];
    return {
      addListener: function (fn) {
        if (typeof fn !== 'function' || ls.indexOf(fn) >= 0) return;
        ls.push(fn);
        if (onAdd) onAdd(fn);
      },
      removeListener: function (fn) {
        var i = ls.indexOf(fn);
        if (i >= 0) ls.splice(i, 1);
      },
      hasListener: function (fn) { return ls.indexOf(fn) >= 0; },
      hasListeners: function () { return ls.length > 0; },
      _ls: ls,
      _fire: function () {
        var args = arguments;
        ls.slice().forEach(function (fn) {
          try {
            var r = fn.apply(null, args);
            if (r && typeof r.then === 'function') r.then(null, function (e) { warn('listener rejected', e); });
          } catch (e) {
            warn('listener failed', e);
          }
        });
      }
    };
  }
  function isCtorLike(fn) {
    return typeof fn === 'function' && fn.prototype !== undefined;
  }
  /* Object that reads through to `base` (binding native methods), while
     overrides and writes stay local. Used as window/self/globalThis for the
     background and for extension pages. */
  function facade(base, overrides) {
    var bound = new Map();
    var self = new Proxy(overrides, {
      get: function (t, k) {
        if (k in t) return t[k];
        var v = base[k];
        if (typeof v === 'function' && !isCtorLike(v)) {
          var b = bound.get(v);
          if (!b) { b = v.bind(base); bound.set(v, b); }
          return b;
        }
        return v;
      },
      set: function (t, k, v) { t[k] = v; return true; },
      has: function (t, k) { return k in t || k in base; },
      deleteProperty: function (t, k) { delete t[k]; return true; }
    });
    /* `window.window === window` and friends must hold for the stand-in as well */
    ['window', 'self', 'globalThis', 'frames'].forEach(function (k) { if (!(k in overrides)) overrides[k] = self; });
    return self;
  }

  /* ------------------------------------------------------------------ */
  /* persistent key-value backends                                      */
  /* ------------------------------------------------------------------ */
  function normList(x, prefix) {
    var keys = [];
    if (Array.isArray(x)) keys = x;
    else if (x && typeof x === 'object') {
      keys = Object.keys(x).filter(function (k) { return x[k] !== null && x[k] !== undefined; });
    }
    return keys.filter(function (k) { return typeof k === 'string' && k.indexOf(prefix) === 0; });
  }
  /* Stay's page-mode GM.getValue resolves with the raw bridge envelope {type, body}. */
  function unwrapGm(v) {
    if (v && typeof v === 'object' && typeof v.type === 'string' && v.type.indexOf('GM_') === 0 && 'body' in v) return v.body;
    return v;
  }
  function gmAsyncBackend() {
    if (!gm.getValue || !gm.setValue) return null;
    return {
      name: 'gm-async',
      get: function (k) { return attempt(function () { return gm.getValue(k); }).then(unwrapGm); },
      set: function (k, v) { return attempt(function () { return gm.setValue(k, v); }); },
      del: function (k) {
        if (gm.deleteValue) return attempt(function () { return gm.deleteValue(k); });
        return attempt(function () { return gm.setValue(k, ''); });
      },
      list: gm.listValues ? function () { return attempt(function () { return gm.listValues(); }); } : null
    };
  }
  function gmSyncBackend() {
    if (!gm.getValueSync || !gm.setValueSync) return null;
    return {
      name: 'gm-sync',
      get: function (k) { return attempt(function () { return gm.getValueSync(k); }); },
      set: function (k, v) { return attempt(function () { return gm.setValueSync(k, v); }); },
      del: function (k) {
        if (gm.deleteValueSync) return attempt(function () { return gm.deleteValueSync(k); });
        return attempt(function () { return gm.setValueSync(k, ''); });
      },
      list: gm.listValuesSync ? function () { return attempt(function () { return gm.listValuesSync(); }); } : null
    };
  }
  function attempt(fn) {
    try { return Promise.resolve(fn()); } catch (e) { return Promise.reject(e); }
  }
  function localStorageBackend() {
    var ls;
    try { ls = env.localStorage || win.localStorage; } catch (e) { return null; }
    if (!ls) return null;
    return {
      name: 'localStorage',
      /* every call may throw (private mode, storage disabled, quota) */
      get: function (k) { return attempt(function () { return ls.getItem(k); }); },
      set: function (k, v) { return attempt(function () { ls.setItem(k, v); }); },
      del: function (k) { return attempt(function () { ls.removeItem(k); }); },
      list: function () {
        return attempt(function () {
          var out = [];
          for (var i = 0; i < ls.length; i++) out.push(ls.key(i));
          return out;
        });
      }
    };
  }
  function memoryBackend() {
    var m = {};
    return {
      name: 'memory',
      get: function (k) { return Promise.resolve(k in m ? m[k] : undefined); },
      set: function (k, v) { m[k] = v; return Promise.resolve(); },
      del: function (k) { delete m[k]; return Promise.resolve(); },
      list: function () { return Promise.resolve(Object.keys(m)); }
    };
  }

  var kv = null;
  var kvIndexFallback = false;

  function probeBackend(b) {
    var key = CONFIG.keyPrefix + 'probe';
    var val = 'p' + Date.now() + Math.random().toString(36).slice(2, 8);
    return withTimeout(
      attempt(function () { return b.set(key, val); }).then(function () { return b.get(key); }).then(function (got) {
        if (got !== val) throw new Error('probe mismatch');
        return true;
      }),
      CONFIG.storageProbeTimeoutMs,
      'storage probe ' + b.name
    );
  }
  /* the page script keeps out of the stand-in api: the layer that runs beside it reads the same keys through the
     storage it is handed, and that storage is the very backend chosen here */
  function pageStorage() {
    return {
      get: function (k) { return kv.get(k).then(function (v) { return v === undefined ? null : v; }, function () { return null; }); },
      set: function (k, v) { return kv.set(k, v).then(function () { return true; }, function () { return false; }); },
      del: function (k) { return kv.del(k).then(function () { return true; }, function () { return false; }); },
      keys: function () { return (kv.list ? kv.list() : Promise.resolve([])).then(function (x) { return normList(x, ''); }, function () { return []; }); }
    };
  }

  function pickBackend() {
    var candidates = [gmAsyncBackend(), gmSyncBackend(), localStorageBackend(), memoryBackend()].filter(Boolean);
    var i = 0;
    function next() {
      var b = candidates[i++];
      if (!b) return Promise.resolve(memoryBackend());
      return probeBackend(b).then(
        function () { return b; },
        function (e) { dbg('backend rejected', b.name, e && e.message); return next(); }
      );
    }
    return next().then(function (b) {
      kv = b;
      kvIndexFallback = !b.list;
      dbg('storage backend:', b.name);
      return b;
    });
  }
  function kvGetJson(key) {
    return kv.get(key).then(function (raw) {
      if (typeof raw !== 'string' || raw === '') return undefined;
      try { return JSON.parse(raw); } catch (e) { return undefined; }
    });
  }
  function kvSetJson(key, value) {
    return kv.set(key, JSON.stringify(value));
  }
  function kvKeys(prefix) {
    if (kv.list) {
      return kv.list().then(function (x) { return normList(x, prefix); }, function () { return []; });
    }
    return kvGetJson(CONFIG.keyPrefix + 'index').then(function (idx) {
      return (Array.isArray(idx) ? idx : []).filter(function (k) { return k.indexOf(prefix) === 0; });
    });
  }
  var indexQueue = Promise.resolve();
  function indexTouch(key, present) {
    if (!kvIndexFallback) return Promise.resolve();
    indexQueue = indexQueue.then(function () {
      var ik = CONFIG.keyPrefix + 'index';
      return kvGetJson(ik).then(function (idx) {
        idx = Array.isArray(idx) ? idx : [];
        var i = idx.indexOf(key);
        if (present && i < 0) idx.push(key);
        else if (!present && i >= 0) idx.splice(i, 1);
        else return;
        return kvSetJson(ik, idx);
      });
    }).then(null, function () {});
    return indexQueue;
  }

  /* ------------------------------------------------------------------ */
  /* contexts & messaging                                               */
  /* ------------------------------------------------------------------ */
  var contexts = [];
  var bgReady = defer();
  var bgReadyDone = false;
  function markBgReady(reason) {
    if (bgReadyDone) return;
    bgReadyDone = true;
    dbg('background ready:', reason);
    bgReady.resolve();
  }

  function senderFor(ctx) {
    var s = { id: CONFIG.extId, url: ctx.url };
    if (ctx.kind === 'content') {
      s.frameId = 0;
      s.tab = currentTab();
      s.origin = win.location.origin;
    }
    return s;
  }
  function currentTab() {
    return Object.assign({}, TAB, { url: String(win.location.href), title: String(doc.title || '') });
  }

  function deliver(from, targets, message, senderOverride) {
    var listeners = [];
    targets.forEach(function (c) {
      c.api.runtime.onMessage._ls.forEach(function (fn) { listeners.push(fn); });
    });
    if (!listeners.length) {
      return Promise.reject(new Error('Could not establish connection. Receiving end does not exist.'));
    }
    var sender = senderOverride || senderFor(from);
    return new Promise(function (resolve, reject) {
      var settled = false;
      var pending = 0;
      var looped = false;
      function respond(v) {
        if (settled) return;
        settled = true;
        var out;
        try { out = clone(v); } catch (e) { reject(new Error('Could not serialize response')); return; }
        resolve(out);
      }
      function fail(e) {
        if (settled) return;
        settled = true;
        reject(new Error((e && e.message) || String(e)));
      }
      function check() {
        if (!settled && looped && pending === 0) { settled = true; resolve(undefined); }
      }
      listeners.forEach(function (fn) {
        var r;
        try {
          r = fn(clone(message), clone(sender), respond);
        } catch (e) {
          warn('onMessage listener failed', e);
          return;
        }
        if (r === true) {
          pending++;
        } else if (r && typeof r.then === 'function') {
          pending++;
          r.then(
            function (v) { respond(v); pending--; check(); },
            function (e) { fail(e); pending--; check(); }
          );
        }
      });
      looped = true;
      check();
    });
  }

  function runtimeSend(from, message) {
    var payload;
    try { payload = clone(message); } catch (e) { return Promise.reject(new Error('Could not serialize message')); }
    if (leaving && from.kind === 'content') {
      /* the page is going away: the "background" of this page dies with it, so the message is put
         into the departure journal and handed to the background of the next page (see below) */
      journalAdd(from, payload);
      return Promise.resolve(undefined);
    }
    var gate = from.kind === 'background' ? Promise.resolve() : bgReady.promise;
    return gate.then(function () {
      var targets = contexts.filter(function (c) {
        return c !== from && c.alive && (c.kind === 'background' || c.kind === 'page');
      });
      return deliver(from, targets, payload);
    });
  }
  /* ------------------------------------------------------------------ */
  /* departure journal                                                  */
  /* ------------------------------------------------------------------ */
  /* In a browser extension the background outlives the page, so a content script may hand data over
     while the page is being left (the original sends the attempt data from a "beforeunload" listener).
     Here the background lives inside the page. Messages sent while the page is being left are therefore
     written down synchronously (sessionStorage of the tab; script-manager storage when that is not
     available) and delivered by the background of the next page, or by this page if it stays alive.
     iOS Safari does not fire "beforeunload", so listeners the content script registers for it are also
     called on "pagehide" when no "beforeunload" has been seen. */
  var JOURNAL_PREFIX = CONFIG.keyPrefix + 'O:';
  var journalSlot = null;
  var leaving = false;
  var departHandled = false;
  var departListeners = [];
  var ownJournal = [];
  var journalStats = { written: 0, replayed: 0, flushed: 0, dropped: 0 };
  function tabStore() {
    try { var st = win.sessionStorage; if (!st) return null; st.getItem('x'); return st; } catch (e) { return null; }
  }
  function slotRead(st) {
    try {
      var raw = st.getItem(journalSlot);
      var list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list : [];
    } catch (e) { return []; }
  }
  function slotWrite(st, list) {
    if (!list.length) { st.removeItem(journalSlot); return true; }
    var text = JSON.stringify(list);
    while (text.length > CONFIG.journalMaxChars && list.length > 1) {
      list.shift(); journalStats.dropped++;
      text = JSON.stringify(list);
    }
    if (text.length > CONFIG.journalMaxChars) return false;
    st.setItem(journalSlot, text);
    return true;
  }
  function journalAdd(from, payload) {
    var entry = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 10),
      t: Date.now(),
      s: senderFor(from),
      m: payload
    };
    var where = null;
    var st = journalSlot ? tabStore() : null;
    if (st) {
      try {
        var list = slotRead(st);
        list.push(entry);
        if (slotWrite(st, list)) where = 'tab';
      } catch (e) { where = null; }
    }
    if (!where) {
      where = 'gm';
      try { kvSetJson(JOURNAL_PREFIX + entry.id, entry).then(null, function () {}); } catch (e) {}
    }
    ownJournal.push({ id: entry.id, where: where, entry: entry });
    journalStats.written++;
    dbg('journal: kept', entry.id, where);
    return where;
  }
  function journalHandOver(entry) {
    var targets = contexts.filter(function (c) { return c.alive && c.kind === 'background'; });
    return deliver(null, targets, entry.m, entry.s).then(null, function (e) { warn('journal: delivery failed', e); });
  }
  function journalUsable(entry) {
    return entry && typeof entry === 'object' && entry.s && 'm' in entry && Date.now() - Number(entry.t || 0) < CONFIG.journalMaxAgeMs;
  }
  /* next page: deliver what the previous page of this tab (or a closed tab) left behind */
  function journalReplay() {
    var list = [];
    var st = journalSlot ? tabStore() : null;
    if (st) {
      try { list = slotRead(st); st.removeItem(journalSlot); } catch (e) { list = []; }
    }
    return kvKeys(JOURNAL_PREFIX).then(function (keys) {
      return Promise.all(keys.map(function (k) {
        return kvGetJson(k).then(function (entry) {
          if (!entry || typeof entry !== 'object') return kv.del(k).then(function () { return indexTouch(k, false); });
          /* a fresh entry may belong to a page that is still alive and will deliver it itself */
          if (Date.now() - Number(entry.t || 0) < CONFIG.journalForeignAgeMs) return null;
          list.push(entry);
          return kv.del(k).then(function () { return indexTouch(k, false); });
        }).then(null, function () {});
      }));
    }, function () {}).then(function () {
      list = list.filter(journalUsable).sort(function (a, b) { return a.t - b.t; });
      return list.reduce(function (p, entry) {
        return p.then(function () { journalStats.replayed++; return journalHandOver(entry); });
      }, Promise.resolve()).then(function () { return list.length; });
    });
  }
  /* this page is still here some time after it was supposed to go (leaving was cancelled, the page came
     back from the back/forward cache, or the next page is slow): deliver now what is still in the journal */
  function journalFlushOwn() {
    var mine = ownJournal; ownJournal = [];
    if (!mine.length) return Promise.resolve(0);
    var todo = [];
    var st = journalSlot ? tabStore() : null;
    var list = null;
    if (st) { try { list = slotRead(st); } catch (e) { list = null; } }
    mine.forEach(function (o) {
      if (o.where === 'tab') {
        if (!list) return;
        var i = -1;
        list.forEach(function (x, n) { if (x && x.id === o.id) i = n; });
        if (i < 0) return;                 /* already delivered by another page */
        list.splice(i, 1);
        todo.push(o.entry);
      } else {
        todo.push(o.entry);
        kv.del(JOURNAL_PREFIX + o.id).then(function () { return indexTouch(JOURNAL_PREFIX + o.id, false); }).then(null, function () {});
      }
    });
    if (st && list) { try { slotWrite(st, list); } catch (e) {} }
    return bgReady.promise.then(function () {
      return todo.reduce(function (p, entry) {
        return p.then(function () { journalStats.flushed++; return journalHandOver(entry); });
      }, Promise.resolve());
    }).then(function () { return todo.length; });
  }
  var departTimer = null;
  var departingUntil = 0;
  function onDeparture(ev) {
    leaving = true;
    departingUntil = Date.now() + 15000;
    if (ev.type === 'beforeunload') {
      departHandled = true;
    } else if (!departHandled) {
      departHandled = true;
      departListeners.slice().forEach(function (fn) {
        var fake;
        try { fake = new win.Event('beforeunload', { cancelable: true }); } catch (e) { fake = { type: 'beforeunload', preventDefault: function () {} }; }
        try { if (typeof fn === 'function') fn.call(win, fake); else if (fn && typeof fn.handleEvent === 'function') fn.handleEvent(fake); } catch (e) { warn('departure listener failed', e); }
      });
    }
    /* listeners of the content script run in this same event dispatch (and its microtasks) */
    setT(function () { leaving = false; }, 0);
    if (departTimer) clearT(departTimer);
    departTimer = setT(function () {
      departTimer = null;
      journalFlushOwn().then(null, function (e) { warn('journal: flush failed', e); });
    }, CONFIG.leaveGraceMs);
  }
  function watchDeparture() {
    win.addEventListener('beforeunload', onDeparture, true);
    win.addEventListener('pagehide', onDeparture, true);
    win.addEventListener('pageshow', function () { departHandled = false; leaving = false; }, true);
  }
  /* What content scripts get for `window.<member>`: the real window, except that "beforeunload"
     listeners are remembered (see above). Bare `window` stays the real object. */
  function contentWindowMembers(w) {
    var bound = new Map();
    var over = {
      addEventListener: function (type, fn, opts) {
        if (type === 'beforeunload' && fn && departListeners.indexOf(fn) < 0) departListeners.push(fn);
        return w.addEventListener(type, fn, opts);
      },
      removeEventListener: function (type, fn, opts) {
        if (type === 'beforeunload') { var i = departListeners.indexOf(fn); if (i >= 0) departListeners.splice(i, 1); }
        return w.removeEventListener(type, fn, opts);
      },
      /* New tabs are opened by the script manager when it can do that: the original calls window.open()
         in reply to a message from its background (no user gesture left), which Safari would block. */
      open: function (url, target, features) {
        var abs = null;
        try { abs = new w.URL(String(url), w.location.href); } catch (e) { abs = null; }
        if (gm.openInTab && abs && /^https?:$/.test(abs.protocol) && (target === undefined || target === '_blank')) {
          try { gm.openInTab(abs.href, { active: true, insert: true, setParent: true }); return null; } catch (e) {}
        }
        return w.open.apply(w, arguments);
      }
    };
    return new Proxy({}, {
      get: function (t, k) {
        if (Object.prototype.hasOwnProperty.call(over, k)) return over[k];
        var v = w[k];
        if (typeof v === 'function' && !isCtorLike(v)) {
          var b = bound.get(v);
          if (!b) { b = v.bind(w); bound.set(v, b); }
          return b;
        }
        return v;
      },
      set: function (t, k, v) { w[k] = v; return true; },
      has: function (t, k) { return k in w; },
      deleteProperty: function (t, k) { return delete w[k]; }
    });
  }

  function tabsSend(from, tabId, message) {
    var payload;
    try { payload = clone(message); } catch (e) { return Promise.reject(new Error('Could not serialize message')); }
    return Promise.resolve().then(function () {
      if (tabId !== TAB.id) throw new Error('Could not establish connection. Receiving end does not exist.');
      var targets = contexts.filter(function (c) { return c.alive && c.kind === 'content'; });
      return deliver(from, targets, payload);
    });
  }

  /* ------------------------------------------------------------------ */
  /* storage areas                                                      */
  /* ------------------------------------------------------------------ */
  var AREA_CODE = { local: 'L:', session: 'S:', sync: 'Y:' };
  var LAZY = { session: { syncshare_logs: true } };
  var lazyCache = {};
  var lazyDirty = {};
  var lazyTimer = null;

  function areaKey(area, key) { return CONFIG.keyPrefix + AREA_CODE[area] + key; }
  function applyPolicy(area, key, value) {
    if (CONFIG.noTelemetry && area === 'local' && key === 'settings' && value && typeof value === 'object') {
      if ('allowTechnicalDataCollection' in value) value.allowTechnicalDataCollection = false;
      /* the starting settings, as the build declares them: no welcome card, no notifications, no host widget */
      var preset = CONFIG.settingsPreset;
      if (preset && typeof preset === 'object') {
        Object.keys(preset).forEach(function (k) { value[k] = preset[k]; });
      }
    }
    return value;
  }
  function isLazy(area, key) { return !!(LAZY[area] && LAZY[area][key]); }
  function flushLazy() {
    if (lazyTimer !== null) { clearT(lazyTimer); lazyTimer = null; }
    var keys = Object.keys(lazyDirty);
    lazyDirty = {};
    return Promise.all(keys.map(function (full) {
      var v = lazyCache[full];
      if (v === undefined) return kv.del(full).then(function () { return indexTouch(full, false); });
      return kvSetJson(full, v).then(function () { return indexTouch(full, true); });
    })).then(null, function (e) { dbg('lazy flush failed', e); });
  }
  function scheduleLazy() {
    if (lazyTimer !== null) return;
    lazyTimer = setT(function () { lazyTimer = null; flushLazy(); }, CONFIG.lazyFlushMs);
  }
  /* the welcome card reads storage.local.installationMessage and hands out the modal while it is "none": the
     build preset writes it ahead of time, so the modal never has a reason to appear */
  function seedPreset() {
    var preset = CONFIG.settingsPreset;
    if (!preset || typeof preset !== 'object') return Promise.resolve();
    return rawGet('local', 'installationMessage').then(function (cur) {
      if (cur === undefined || cur === null || cur === 'none') {
        return rawSet('local', 'installationMessage', String(preset.installationMessage || 'mse'));
      }
      return null;
    }).then(function () { return rawGet('local', 'settings'); }).then(function (cur) {
      var next = Object.assign({}, (cur && typeof cur === 'object') ? cur : {}, preset);
      return rawSet('local', 'settings', next);
    }).then(null, function () {});
  }

  function rawGet(area, key) {
    var full = areaKey(area, key);
    if (isLazy(area, key) && Object.prototype.hasOwnProperty.call(lazyCache, full)) {
      return Promise.resolve(clone(lazyCache[full]));
    }
    return kvGetJson(full).then(function (v) {
      if (isLazy(area, key)) lazyCache[full] = v;
      return applyPolicy(area, key, v);
    });
  }
  function rawSet(area, key, value) {
    var full = areaKey(area, key);
    if (isLazy(area, key)) {
      lazyCache[full] = value;
      lazyDirty[full] = true;
      scheduleLazy();
      return Promise.resolve();
    }
    return kvSetJson(full, value).then(function () { return indexTouch(full, true); });
  }
  function rawDel(area, key) {
    var full = areaKey(area, key);
    if (isLazy(area, key)) {
      lazyCache[full] = undefined;
      lazyDirty[full] = true;
      scheduleLazy();
      return Promise.resolve();
    }
    return kv.del(full).then(function () { return indexTouch(full, false); });
  }
  function areaKeys(area) {
    var prefix = CONFIG.keyPrefix + AREA_CODE[area];
    return kvKeys(prefix).then(function (keys) {
      var out = keys.map(function (k) { return k.slice(prefix.length); });
      Object.keys(lazyCache).forEach(function (full) {
        if (full.indexOf(prefix) !== 0) return;
        var k = full.slice(prefix.length);
        var i = out.indexOf(k);
        if (lazyCache[full] === undefined) { if (i >= 0) out.splice(i, 1); }
        else if (i < 0) out.push(k);
      });
      return out;
    });
  }
  var consentGranted = defer();
  function hasConsent(settings) {
    return !!(settings && typeof settings === 'object' && settings.privacyPolicyAcceptedByUser === true);
  }
  function fireChanged(area, changes) {
    if (!Object.keys(changes).length) return;
    if (area === 'local' && changes.settings && hasConsent(changes.settings.newValue)) consentGranted.resolve(true);
    contexts.forEach(function (c) {
      if (!c.alive) return;
      c.api.storage.onChanged._fire(clone(changes), area);
      c.api.storage[area].onChanged._fire(clone(changes));
    });
  }
  var areaQueues = {};
  function enqueue(area, fn) {
    var q = (areaQueues[area] || Promise.resolve()).then(fn, fn);
    areaQueues[area] = q.then(null, function () {});
    return q;
  }
  function makeArea(area, onChangedEvent) {
    function get(keys) {
      var wanted;
      var defaults = {};
      var p;
      if (keys === null || keys === undefined) {
        p = areaKeys(area);
      } else if (typeof keys === 'string') {
        p = Promise.resolve([keys]);
      } else if (Array.isArray(keys)) {
        p = Promise.resolve(keys.slice());
      } else if (typeof keys === 'object') {
        defaults = keys;
        p = Promise.resolve(Object.keys(keys));
      } else {
        return Promise.reject(new TypeError('Incorrect argument types for StorageArea.get.'));
      }
      return p.then(function (list) {
        wanted = list;
        return Promise.all(list.map(function (k) { return rawGet(area, k); }));
      }).then(function (values) {
        var out = {};
        wanted.forEach(function (k, i) {
          if (values[i] !== undefined) out[k] = values[i];
          else if (Object.prototype.hasOwnProperty.call(defaults, k)) out[k] = clone(defaults[k]);
        });
        return out;
      });
    }
    function set(items) {
      if (!items || typeof items !== 'object') {
        return Promise.reject(new TypeError('Incorrect argument types for StorageArea.set.'));
      }
      var data;
      try { data = clone(items); } catch (e) { return Promise.reject(e); }
      return enqueue(area, function () {
        var changes = {};
        var keys = Object.keys(data);
        return keys.reduce(function (chain, k) {
          return chain.then(function () {
            var nv = applyPolicy(area, k, data[k]);
            return rawGet(area, k).then(function (ov) {
              return rawSet(area, k, nv).then(function () {
                if (!sameJson(ov, nv)) {
                  changes[k] = { newValue: nv };
                  if (ov !== undefined) changes[k].oldValue = ov;
                }
              });
            });
          });
        }, Promise.resolve()).then(function () { fireChanged(area, changes); });
      });
    }
    function remove(keys) {
      var list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys.slice() : null;
      if (!list) return Promise.reject(new TypeError('Incorrect argument types for StorageArea.remove.'));
      return enqueue(area, function () {
        var changes = {};
        return list.reduce(function (chain, k) {
          return chain.then(function () {
            return rawGet(area, k).then(function (ov) {
              if (ov === undefined) return;
              return rawDel(area, k).then(function () { changes[k] = { oldValue: ov }; });
            });
          });
        }, Promise.resolve()).then(function () { fireChanged(area, changes); });
      });
    }
    function clear() {
      return areaKeys(area).then(function (keys) { return remove(keys); });
    }
    return { get: get, set: set, remove: remove, clear: clear, onChanged: onChangedEvent };
  }
  function wipeArea(area) {
    return areaKeys(area).then(function (keys) {
      return Promise.all(keys.map(function (k) { return rawDel(area, k); }));
    }).then(function () { return flushLazy(); });
  }

  /* ------------------------------------------------------------------ */
  /* i18n                                                               */
  /* ------------------------------------------------------------------ */
  function uiLanguage() {
    try { return String(nav.language || 'en'); } catch (e) { return 'en'; }
  }
  function pickLocale() {
    var lang = uiLanguage().toLowerCase().replace('-', '_');
    var names = Object.keys(LOCALES);
    var i;
    for (i = 0; i < names.length; i++) if (names[i].toLowerCase() === lang) return names[i];
    var short = lang.split('_')[0];
    for (i = 0; i < names.length; i++) if (names[i].toLowerCase() === short) return names[i];
    return MANIFEST.default_locale || 'en';
  }
  var activeLocale = null;
  function lookupMessage(name) {
    if (activeLocale === null) activeLocale = pickLocale();
    var lower = String(name).toLowerCase();
    var tables = [LOCALES[activeLocale], LOCALES[MANIFEST.default_locale || 'en']];
    for (var t = 0; t < tables.length; t++) {
      var table = tables[t];
      if (!table) continue;
      if (Object.prototype.hasOwnProperty.call(table, name)) return table[name];
      var ks = Object.keys(table);
      for (var i = 0; i < ks.length; i++) if (ks[i].toLowerCase() === lower) return table[ks[i]];
    }
    return null;
  }
  function getMessage(name, subs) {
    if (name === '@@extension_id') return CONFIG.extId;
    if (name === '@@ui_locale') return uiLanguage().replace('-', '_');
    if (name === '@@bidi_dir') return 'ltr';
    var entry = lookupMessage(name);
    if (!entry || typeof entry.message !== 'string') return '';
    var list = subs === undefined || subs === null ? [] : Array.isArray(subs) ? subs : [subs];
    var placeholders = entry.placeholders || {};
    return entry.message.replace(/\$([a-zA-Z0-9_@]+)\$|\$(\d)|\$\$/g, function (m, named, idx) {
      if (m === '$$') return '$';
      if (idx) return list[Number(idx) - 1] !== undefined ? String(list[Number(idx) - 1]) : '';
      var ph = placeholders[String(named).toLowerCase()];
      if (!ph || typeof ph.content !== 'string') return '';
      return ph.content.replace(/\$(\d)/g, function (_, d) {
        return list[Number(d) - 1] !== undefined ? String(list[Number(d) - 1]) : '';
      });
    });
  }

  /* ------------------------------------------------------------------ */
  /* fetch                                                              */
  /* ------------------------------------------------------------------ */
  var netState = { route: null, gmEverWorked: false };
  var NULL_BODY = { 101: 1, 204: 1, 205: 1, 304: 1 };

  function resourceResponse(R, url) {
    var path = url.slice(EXT_BASE.length).split('?')[0].split('#')[0];
    var res = RES[path];
    if (!res) return Promise.resolve(new R.Response('', { status: 404, statusText: 'Not Found' }));
    return Promise.resolve(new R.Response(res.text, { status: 200, headers: { 'Content-Type': res.type || 'text/plain' } }));
  }
  function abortError(R) {
    try { return new R.DOMException('The operation was aborted.', 'AbortError'); }
    catch (e) { var err = new Error('The operation was aborted.'); err.name = 'AbortError'; return err; }
  }
  function headersToObject(R, h) {
    var out = {};
    if (!h) return out;
    if (typeof h.forEach === 'function' && !Array.isArray(h)) {
      h.forEach(function (v, k) { out[k] = v; });
    } else if (Array.isArray(h)) {
      h.forEach(function (p) { out[p[0]] = p[1]; });
    } else {
      Object.keys(h).forEach(function (k) { out[k] = String(h[k]); });
    }
    return out;
  }
  function parseRawHeaders(raw) {
    var out = [];
    if (raw && typeof raw === 'object') {
      Object.keys(raw).forEach(function (k) { out.push([k, String(raw[k])]); });
      return out;
    }
    String(raw || '').split(/\r?\n/).forEach(function (line) {
      var i = line.indexOf(':');
      if (i <= 0) return;
      out.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]);
    });
    return out;
  }
  function describeRequest(R, input, init) {
    init = init || {};
    var isReq = input && typeof input === 'object' && typeof input.url === 'string' && typeof input.method === 'string';
    var d = {
      url: isReq ? input.url : String(input),
      method: String(init.method || (isReq ? input.method : 'GET')).toUpperCase(),
      headers: headersToObject(R, init.headers || (isReq ? input.headers : null)),
      signal: init.signal || (isReq ? input.signal : null) || null,
      body: init.body
    };
    var bodyP;
    if (d.body === undefined || d.body === null) {
      bodyP = isReq && d.method !== 'GET' && d.method !== 'HEAD' && typeof input.clone === 'function'
        ? input.clone().text()
        : Promise.resolve(undefined);
    } else if (typeof d.body === 'string') {
      bodyP = Promise.resolve(d.body);
    } else if (typeof d.body.toString === 'function' && R.URLSearchParams && d.body instanceof R.URLSearchParams) {
      if (!hasHeader(d.headers, 'content-type')) d.headers['Content-Type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
      bodyP = Promise.resolve(d.body.toString());
    } else {
      bodyP = Promise.reject(new TypeError('unsupported body type'));
    }
    return bodyP.then(function (b) { d.body = b; return d; });
  }
  function hasHeader(h, name) {
    return Object.keys(h).some(function (k) { return k.toLowerCase() === name; });
  }
  function gmRequest(R, d) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var handle = null;
      var onAbort = null;
      function cleanup() {
        if (d.signal && onAbort) { try { d.signal.removeEventListener('abort', onAbort); } catch (e) {} }
      }
      function ok(r) {
        if (done) return;
        var resp;
        try { resp = toResponse(R, r, d.url); } catch (e) { done = true; cleanup(); reject(transport('bad response: ' + (e && e.message))); return; }
        done = true; cleanup(); netState.gmEverWorked = true; resolve(resp);
      }
      function bad(kind) {
        if (done) return;
        done = true; cleanup(); reject(transport(kind));
      }
      function transport(kind) {
        var e = new TypeError('Failed to fetch');
        e.ssTransport = kind;
        return e;
      }
      if (d.signal) {
        if (d.signal.aborted) { reject(abortError(R)); return; }
        onAbort = function () {
          if (done) return;
          done = true; cleanup();
          try { if (handle && typeof handle.abort === 'function') handle.abort(); } catch (e) {}
          reject(abortError(R));
        };
        d.signal.addEventListener('abort', onAbort);
      }
      var details = {
        method: d.method,
        url: d.url,
        headers: d.headers,
        anonymous: true,
        onload: function (r) { ok(r || {}); },
        onerror: function () { bad('error'); },
        ontimeout: function () { bad('timeout'); },
        onabort: function () { bad('abort'); },
        onloadend: function () {}
      };
      if (d.body !== undefined) details.data = d.body;
      try {
        handle = gm.xhr(details);
        if (handle && typeof handle.then === 'function') {
          handle.then(function (r) { if (r && typeof r.status === 'number') ok(r); }, function () { bad('error'); });
        }
      } catch (e) {
        bad('throw');
      }
    });
  }
  function toResponse(R, r, reqUrl) {
    var status = Number(r.status) || 0;
    if (status < 200 || status > 599) throw new Error('status ' + status);
    var text = typeof r.responseText === 'string' ? r.responseText
      : typeof r.response === 'string' ? r.response
      : r.response !== undefined && r.response !== null ? JSON.stringify(r.response) : '';
    var headers = new R.Headers();
    parseRawHeaders(r.responseHeaders).forEach(function (p) {
      try { headers.append(p[0], p[1]); } catch (e) {}
    });
    var resp = new R.Response(NULL_BODY[status] ? null : text, {
      status: status,
      statusText: String(r.statusText || ''),
      headers: headers
    });
    try { Object.defineProperty(resp, 'url', { value: String(r.finalUrl || r.responseURL || reqUrl) }); } catch (e) {}
    return resp;
  }
  /* Background requests.
     transport 'auto': the page's own fetch first (the SyncShare server answers CORS for any
     origin and fetch reports exact statuses, aborts and time-outs); if the page blocks it
     (Content-Security-Policy, mixed content, ...) the request is repeated through the script
     manager (GM_xmlhttpRequest), which is not bound by the page. Whichever worked is remembered
     for the rest of the page's life. 'native' / 'gm' force one of the two. */
  /* requests started while the page is being left should survive the page (small bodies only: the
     browsers limit such requests to 64 KiB) */
  function surviving(init) {
    if (!(Date.now() < departingUntil)) return init;
    var i = init || {};
    if ('keepalive' in i) return init;
    if (i.body !== undefined && i.body !== null && (typeof i.body !== 'string' || i.body.length > 20000)) return init;
    return Object.assign({}, i, { keepalive: true });
  }
  function backgroundFetch(R, nativeFetch, input, init) {
    var mode = CONFIG.transport;
    if (!gm.xhr || mode === 'native' || (mode !== 'gm' && netState.route === 'native')) {
      return nativeFetch(input, typeof input === 'string' ? surviving(init) : init);
    }
    return describeRequest(R, input, init).then(function (d) {
      function viaGm() {
        var p = gmRequest(R, d);
        var guard = new Promise(function (resolve, reject) {
          var t = setT(function () { reject(Object.assign(new TypeError('Failed to fetch'), { ssTransport: 'watchdog' })); }, CONFIG.gmWatchdogMs);
          p.then(function () { clearT(t); }, function () { clearT(t); });
        });
        return netState.gmEverWorked ? p : Promise.race([p, guard]);
      }
      function replay() {
        var i2 = { method: d.method, headers: d.headers };
        if (d.body !== undefined) i2.body = d.body;
        if (d.signal) i2.signal = d.signal;
        return nativeFetch(d.url, surviving(i2));
      }
      if (mode === 'gm' || netState.route === 'gm') return viaGm();
      return replay().then(function (resp) {
        netState.route = 'native';
        return resp;
      }, function (err) {
        if ((err && err.name === 'AbortError') || (d.signal && d.signal.aborted)) throw err;
        dbg('fetch failed, trying GM_xmlhttpRequest:', d.url, err && err.message);
        return viaGm().then(function (resp) {
          netState.route = 'gm';
          return resp;
        }, function (e2) {
          if (e2 && e2.name === 'AbortError') throw e2;
          throw err;
        });
      });
    }, function () {
      return nativeFetch(input, init);
    });
  }
  function makeFetch(kind, R, nativeFetch) {
    return function fetch(input, init) {
      var url;
      try { url = typeof input === 'string' ? input : input && typeof input.url === 'string' ? input.url : String(input); }
      catch (e) { url = ''; }
      if (url.indexOf(EXT_BASE) === 0) return resourceResponse(R, url);
      var debug = false;
      try { debug = win.localStorage.getItem('mse.debug.enabled') === '1'; } catch (_) {}
      var result = kind === 'background' ? backgroundFetch(R, nativeFetch, input, init) : nativeFetch(input, init);
      if (!debug) return result;
      var request = {url:url, method:String((init && init.method) || (input && input.method) || 'GET'), body:init && typeof init.body === 'string' ? init.body : null};
      function publish(record) {
        if (win.__mse && win.__mse.onDebugTraffic) win.__mse.onDebugTraffic(record);
        else { win.__msePendingTraffic = win.__msePendingTraffic || []; if (win.__msePendingTraffic.length < 20) win.__msePendingTraffic.push(record); }
      }
      return result.then(function (response) {
        try { response.clone().text().then(function (body) { publish({request:request,response:{status:response.status,body:body}}); }, function () {}); } catch (_) {}
        return response;
      }, function (err) { publish({request:request,error:String(err && err.message || 'network')}); throw err; });
    };
  }

  /* ------------------------------------------------------------------ */
  /* menus                                                              */
  /* ------------------------------------------------------------------ */
  var menuItems = {};
  var menuClicked = makeEvent();
  function matchPatternToRegExp(p) {
    if (p === '<all_urls>') return /^(https?|file|ftp):/;
    var m = /^(\*|https?|file|ftp):\/\/([^\/]*)(\/.*)$/.exec(p);
    if (!m) return null;
    var esc = function (s) { return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*'); };
    var scheme = m[1] === '*' ? 'https?' : m[1];
    var host = m[2] === '*' ? '[^/]*' : m[2].indexOf('*.') === 0 ? '(?:[^/]*\\.)?' + esc(m[2].slice(2)) : esc(m[2]);
    return new RegExp('^' + scheme + ':\\/\\/' + host + esc(m[3]) + '$');
  }
  function urlMatchesAny(patterns) {
    if (!patterns || !patterns.length) return true;
    var href = String(win.location.href).split('#')[0];
    return patterns.some(function (p) {
      var re = matchPatternToRegExp(p);
      return re ? re.test(href) : false;
    });
  }
  function registerMenu(title, fn) {
    if (!gm.registerMenuCommand) return null;
    try { return gm.registerMenuCommand(title, fn); } catch (e) { dbg('registerMenuCommand failed', e); return null; }
  }
  function unregisterMenu(handle) {
    if (handle === null || handle === undefined || !gm.unregisterMenuCommand) return;
    try { gm.unregisterMenuCommand(handle); } catch (e) {}
  }
  function menusCreate(props, cb) {
    var id = props && props.id !== undefined ? props.id : 'menu-' + Math.random().toString(36).slice(2);
    if (menuItems[id]) unregisterMenu(menuItems[id].handle);
    var item = { props: clone(props), handle: null };
    menuItems[id] = item;
    if (urlMatchesAny(props.documentUrlPatterns)) {
      item.handle = registerMenu(String(props.title || MANIFEST.name), function () {
        menuClicked._fire({ menuItemId: id, pageUrl: String(win.location.href), editable: false }, currentTab());
      });
    }
    if (typeof cb === 'function') setT(cb, 0);
    return id;
  }
  function menusRemove(id) {
    if (menuItems[id]) { unregisterMenu(menuItems[id].handle); delete menuItems[id]; }
    return Promise.resolve();
  }
  function menusRemoveAll() {
    Object.keys(menuItems).forEach(function (id) { unregisterMenu(menuItems[id].handle); });
    menuItems = {};
    return Promise.resolve();
  }

  /* ------------------------------------------------------------------ */
  /* WebExtension API object per context                                */
  /* ------------------------------------------------------------------ */
  var installedEvent = { pending: null };
  var startupEvent = { pending: false };

  function makeApi(ctx) {
    var onMessage = makeEvent();
    var storageChanged = makeEvent();
    var onInstalled = makeEvent(function (fn) {
      if (ctx.kind !== 'background' || !installedEvent.pending) return;
      var details = installedEvent.pending;
      setT(function () { try { fn(clone(details)); } catch (e) { warn(e); } }, 0);
    });
    var onStartup = makeEvent(function (fn) {
      if (ctx.kind !== 'background' || !startupEvent.pending) return;
      setT(function () { try { fn(); } catch (e) { warn(e); } }, 0);
    });
    var action = {
      openPopup: function () { return openExtensionPage('html/popup/popup.html').then(function () {}); },
      setBadgeText: function () { return Promise.resolve(); },
      setBadgeBackgroundColor: function () { return Promise.resolve(); },
      setTitle: function () { return Promise.resolve(); },
      setIcon: function () { return Promise.resolve(); },
      onClicked: makeEvent()
    };
    var menus = {
      create: function (props, cb) {
        var id = menusCreate(props, cb);
        if (ctx.kind === 'background') setT(function () { setT(function () { markBgReady('menus.create'); }, 0); }, 0);
        return id;
      },
      update: function () { return Promise.resolve(); },
      remove: menusRemove,
      removeAll: function () {
        var p = menusRemoveAll();
        if (ctx.kind === 'background') setT(function () { setT(function () { markBgReady('menus.removeAll'); }, 0); }, 0);
        return p;
      },
      onClicked: menuClicked
    };
    var api = {
      runtime: {
        id: CONFIG.extId,
        lastError: undefined,
        getURL: function (path) { return EXT_BASE + String(path || '').replace(/^\/+/, ''); },
        getManifest: function () { return clone(MANIFEST); },
        sendMessage: function (a, b) {
          var message = arguments.length >= 2 && typeof a === 'string' && a === CONFIG.extId ? b : a;
          return runtimeSend(ctx, message);
        },
        onMessage: onMessage,
        onInstalled: onInstalled,
        onStartup: onStartup,
        onSuspend: makeEvent(),
        onUpdateAvailable: makeEvent(),
        onConnect: makeEvent(),
        getPlatformInfo: function () { return Promise.resolve({ os: 'ios', arch: 'arm' }); },
        getBrowserInfo: function () { return Promise.resolve({ name: 'Safari', vendor: 'Apple', version: '', buildID: '' }); },
        openOptionsPage: function () { return openExtensionPage('html/popup/popup.html').then(function () {}); },
        setUninstallURL: function () { return Promise.resolve(); },
        reload: function () { win.location.reload(); }
      },
      storage: {
        local: makeArea('local', makeEvent()),
        session: makeArea('session', makeEvent()),
        sync: makeArea('sync', makeEvent()),
        onChanged: storageChanged
      },
      i18n: {
        getMessage: getMessage,
        getUILanguage: uiLanguage,
        getAcceptLanguages: function () { return Promise.resolve((nav.languages || [uiLanguage()]).slice()); },
        detectLanguage: function () { return Promise.resolve({ isReliable: false, languages: [] }); }
      },
      extension: {
        inIncognitoContext: false,
        getURL: function (path) { return api.runtime.getURL(path); }
      },
      permissions: {
        getAll: function () { return Promise.resolve({ permissions: ['storage', 'contextMenus'], origins: ['*:/' + '/*/*'] }); },
        contains: function () { return Promise.resolve(true); },
        request: function () { return Promise.resolve(true); },
        remove: function () { return Promise.resolve(false); },
        onAdded: makeEvent(),
        onRemoved: makeEvent()
      }
    };
    if (ctx.kind !== 'content') {
      api.tabs = {
        query: function () { return Promise.resolve([currentTab()]); },
        get: function () { return Promise.resolve(currentTab()); },
        getCurrent: function () { return Promise.resolve(ctx.kind === 'page' ? undefined : currentTab()); },
        sendMessage: function (tabId, message) { return tabsSend(ctx, tabId, message); },
        create: function (props) {
          openUrl(props && props.url);
          return Promise.resolve(Object.assign({}, TAB, { id: 2, index: 1, url: props && props.url }));
        },
        update: function (a, b) {
          var props = typeof a === 'object' ? a : b;
          if (props && props.url) win.location.href = props.url;
          return Promise.resolve(currentTab());
        },
        reload: function () { win.location.reload(); return Promise.resolve(); },
        remove: function () { return Promise.resolve(); },
        onUpdated: makeEvent(),
        onRemoved: makeEvent(),
        onActivated: makeEvent()
      };
      api.contextMenus = menus;
      api.menus = menus;
      api.action = action;
      api.browserAction = action;
      api.management = {
        uninstallSelf: function () { return disableSelf(); },
        getSelf: function () {
          return Promise.resolve({ id: CONFIG.extId, name: MANIFEST.name, version: MANIFEST.version, enabled: true, installType: 'normal' });
        }
      };
      api.windows = {
        getCurrent: function () { return Promise.resolve({ id: 1, focused: true }); },
        create: function (props) { openUrl(props && props.url); return Promise.resolve({ id: 2 }); }
      };
      api.extension.getBackgroundPage = function () { return backgroundGlobal; };
      api.extension.getViews = function () { return []; };
      api.runtime.getBackgroundPage = function () { return Promise.resolve(backgroundGlobal); };
    }
    return api;
  }

  function openUrl(url) {
    if (!url) return;
    url = String(url);
    if (url.indexOf(EXT_BASE) === 0) {
      openExtensionPage(url.slice(EXT_BASE.length).split('?')[0].split('#')[0]);
      return;
    }
    try {
      if (gm.openInTab) { gm.openInTab(url, { active: true, insert: true, setParent: true }); return; }
    } catch (e) {}
    try { win.open(url, '_blank', 'noopener'); } catch (e) { warn('cannot open', url); }
  }

  /* ------------------------------------------------------------------ */
  /* running the original bundles                                       */
  /* ------------------------------------------------------------------ */
  var backgroundGlobal = null;
  var REALM_NAMES = [
    'Element', 'HTMLElement', 'HTMLInputElement', 'HTMLAnchorElement', 'HTMLDivElement', 'HTMLOptionElement',
    'HTMLUListElement', 'HTMLLIElement', 'HTMLFormElement', 'HTMLCanvasElement', 'HTMLImageElement', 'Node',
    'Document', 'Event', 'CustomEvent', 'MouseEvent', 'ShadowRoot', 'getComputedStyle'
  ];

  function realmOf(w) {
    return {
      Response: w.Response, Headers: w.Headers, DOMException: w.DOMException, URLSearchParams: w.URLSearchParams
    };
  }
  function newContext(kind, url) {
    var ctx = { kind: kind, url: url, alive: true, api: null };
    ctx.api = makeApi(ctx);
    contexts.push(ctx);
    return ctx;
  }
  function scopeEnv(ctx, w, d, globalObj, fetchImpl) {
    var E = {
      ctx: { chunks: [] },
      browser: ctx.api,
      chrome: ctx.api,
      fetch: fetchImpl,
      window: globalObj,
      self: globalObj,
      globalThis: globalObj,
      document: d
    };
    REALM_NAMES.forEach(function (n) {
      var v = w[n];
      E[n] = typeof v === 'function' && !isCtorLike(v) ? v.bind(w) : v;
    });
    return E;
  }
  function runScripts(E, names, label) {
    var scope = env.vendorScope(E);
    names.forEach(function (n) {
      if (typeof scope[n] !== 'function') throw new Error('unknown bundle ' + n);
      try {
        scope[n].call(E.globalThis);
      } catch (e) {
        warn(label + ': ' + n + ' failed', e);
        throw e;
      }
    });
    return scope;
  }
  function nativeFetchOf(w) {
    return function (input, init) { return w.fetch(input, init); };
  }

  function startBackground() {
    var ctx = newContext('background', EXT_BASE + '_generated_background_page.html');
    var fetchImpl = makeFetch('background', realmOf(win), env.nativeFetch || nativeFetchOf(win));
    var g = facade(win, { fetch: fetchImpl, browser: ctx.api, chrome: ctx.api });
    backgroundGlobal = g;
    var E = scopeEnv(ctx, win, doc, g, fetchImpl);
    setT(function () { markBgReady('timeout'); }, CONFIG.bgReadyTimeoutMs);
    try {
      runScripts(E, ['commons', 'background'], 'background');
    } catch (e) {
      markBgReady('failed');
    }
    return ctx;
  }

  function contentScriptsFor(loc) { return null; }
  function whenIdle() {
    return new Promise(function (resolve) {
      if (doc.readyState === 'complete') { resolve(); return; }
      var done = false;
      var fin = function () { if (!done) { done = true; resolve(); } };
      win.addEventListener('load', fin, { once: true });
      var afterDom = function () { setT(fin, 200); };
      if (doc.readyState === 'interactive') afterDom();
      else doc.addEventListener('DOMContentLoaded', afterDom, { once: true });
    });
  }
  function injectCss(path) {
    var res = RES[path];
    if (!res) return;
    var style = doc.createElement('style');
    style.textContent = res.text;
    (doc.head || doc.documentElement).appendChild(style);
  }
  /* Sub-menus of the original open on CSS ":hover" only. Touch browsers emulate hover in different ways (iOS Safari
     keeps it after a tap on something that reveals content, other engines do not), and with some of them the
     sub-menu is gone again the moment the finger goes down on one of its items. So, for taps only: a tap on an
     item that has a sub-menu also pins that sub-menu open until another item is tapped or the menu is closed.
     Mouse users get exactly the behaviour of the original. The menus live in closed shadow roots created by the
     original code, the only way to reach them is to see those roots being created. */
  var touchMenusOn = false;
  function touchMenus() {
    if (touchMenusOn || CONFIG.touchMenus === false) return;
    touchMenusOn = true;
    var proto = win.Element && win.Element.prototype;
    var attach = proto && proto.attachShadow;
    if (typeof attach !== 'function') return;
    var PIN = 'data-ss-open';
    var child = function (li) {
      for (var c = li.firstElementChild; c; c = c.nextElementSibling) if (c.classList.contains('sub-menu')) return c;
      return null;
    };
    var unpin = function (scope) {
      var list = scope.querySelectorAll('[' + PIN + ']');
      for (var i = 0; i < list.length; i++) {
        list[i].removeAttribute(PIN);
        var sub = child(list[i]);
        if (sub) { sub.style.removeProperty('display'); if (!sub.getAttribute('style')) sub.removeAttribute('style'); }
      }
    };
    var watch = function (root) {
      var touchedAt = 0;
      var watched = [];
      var touched = function () { touchedAt = Date.now(); };
      root.addEventListener('touchstart', touched, { capture: true, passive: true });
      root.addEventListener('pointerdown', function (ev) { if (ev.pointerType === 'touch') touched(); }, { capture: true, passive: true });
      root.addEventListener('click', function (ev) {
        var t = ev.target;
        var item = t && t.closest ? t.closest('.syncshare-cm .menu-item') : null;
        if (!item || Date.now() - touchedAt > 1500) return;
        var menu = item.closest('.syncshare-cm');
        unpin(item.parentNode);
        var sub = child(item);
        if (!sub) return;
        item.setAttribute(PIN, '');
        sub.style.setProperty('display', 'flex');
        if (menu && watched.indexOf(menu) < 0 && win.MutationObserver) {
          watched.push(menu);
          new win.MutationObserver(function () { if (menu.hidden) unpin(menu); }).observe(menu, { attributes: true, attributeFilter: ['hidden'] });
        }
      }, true);
    };
    var wrapped = function attachShadow(init) {
      var root = attach.apply(this, arguments);
      try { if (init && init.mode === 'closed' && root) watch(root); } catch (e) {}
      return root;
    };
    try { proto.attachShadow = wrapped; } catch (e) {}
  }
  function startContent(spec) {
    touchMenus();
    var ctx = newContext('content', String(win.location.href));
    var fetchImpl = makeFetch('content', realmOf(win), nativeFetchOf(win));
    var E = scopeEnv(ctx, win, doc, win, fetchImpl);
    E.windowMembers = contentWindowMembers(win);
    if (CONFIG.contentCss === true || CONFIG.contentCss === 'always') spec.css.forEach(injectCss);
    runScripts(E, spec.js, 'content');
    return ctx;
  }

  /* ------------------------------------------------------------------ */
  /* extension pages (popup, consent) rendered in an overlay iframe     */
  /* ------------------------------------------------------------------ */
  var openPages = {};

  function closeExtensionPage(path) {
    var p = openPages[path];
    if (!p) return;
    delete openPages[path];
    p.ctx.alive = false;
    var i = contexts.indexOf(p.ctx);
    if (i >= 0) contexts.splice(i, 1);
    try { p.host.remove(); } catch (e) {}
  }
  /* The few places where the original pages say something that is not true for a userscript. */
  function patchPage(path, fd) {
    /* without the consent gate there is no consent page: its menu entry is not shown either
       (a CSS rule, because the popup re-renders its dropdown after start) */
    if (path === POPUP_PAGE && !CONFIG.consentGate) {
      var hide = fd.createElement('style');
      hide.setAttribute('data-ss-stay-no-consent', '');
      hide.textContent = '#privacy{display:none!important}';
      try { fd.head.appendChild(hide); } catch (e) {}
    }
    if (path !== PRIVACY_PAGE) return;
    var warnText = fd.querySelector('.warning-text');
    if (warnText) {
      var icon = warnText.querySelector('i');
      warnText.textContent = ' / If you decline, SyncShare is switched off (it can be re-enabled from the Stay menu)';
      if (icon) warnText.insertBefore(icon, warnText.firstChild);
    }
    if (CONFIG.noTelemetry) {
      var box = fd.querySelector('#technicalConsent');
      if (box) {
        box.checked = false;
        box.removeAttribute('checked');
        box.disabled = true;
        /* the page script ticks the box when it starts; here it must stay off, visibly and when read */
        try { Object.defineProperty(box, 'checked', { configurable: true, get: function () { return false; }, set: function () {} }); } catch (e) {}
        var opt = box.closest('.consent-option');
        var desc = opt && opt.querySelector('.option-description');
        if (desc) {
          var note = fd.createElement('div');
          note.setAttribute('data-ss-stay-note', 'telemetry');
          note.setAttribute('style', 'margin-top:.5rem;font-weight:600;');
          note.textContent = 'The Stay port never collects or sends technical data.';
          desc.parentNode.insertBefore(note, desc.nextSibling);
        }
      }
    }
  }
  function openExtensionPage(path) {
    if (CONFIG.hideHostWidget) return Promise.resolve(null);
    var page = PAGES[path];
    if (!page) {
      /* the consent page is not packaged when the gate is off: its opening is a no-op, not an error */
      if (path === PRIVACY_PAGE && !CONFIG.consentGate) return Promise.resolve(null);
      return Promise.reject(new Error('unknown extension page ' + path));
    }
    if (openPages[path]) return Promise.resolve(openPages[path]);
    var isPopup = !!page.popup;

    var host = doc.createElement('div');
    host.setAttribute('style', 'all:initial;position:fixed;left:0;top:0;right:0;bottom:0;width:100%;height:100%;z-index:2147483647;');
    var root;
    try { root = host.attachShadow({ mode: 'closed' }); } catch (e) { root = host; }
    var backdrop = doc.createElement('div');
    backdrop.setAttribute('style', 'position:absolute;left:0;top:0;right:0;bottom:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:env(safe-area-inset-top,8px) 8px env(safe-area-inset-bottom,8px) 8px;box-sizing:border-box;');
    var box = doc.createElement('div');
    box.setAttribute('style', 'position:relative;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 10px 40px rgba(0,0,0,.35);max-width:100%;max-height:100%;' +
      (isPopup ? 'width:300px;height:450px;' : 'width:720px;height:92%;'));
    var frame = doc.createElement('iframe');
    frame.setAttribute('style', 'display:block;border:0;width:100%;height:100%;background:#fff;');
    frame.setAttribute('title', MANIFEST.name);
    var closeBtn = doc.createElement('button');
    closeBtn.setAttribute('type', 'button');
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.setAttribute('style', 'position:absolute;right:10px;top:max(10px, env(safe-area-inset-top,10px));width:40px;height:40px;border-radius:20px;border:0;background:rgba(255,255,255,.92);color:#222;font:600 22px/40px -apple-system,system-ui,sans-serif;padding:0;cursor:pointer;');
    closeBtn.textContent = '\u00d7';
    box.appendChild(frame);
    backdrop.appendChild(box);
    backdrop.appendChild(closeBtn);
    root.appendChild(backdrop);

    var ctx = newContext('page', EXT_BASE + path);
    var entry = { host: host, frame: frame, ctx: ctx, path: path };
    openPages[path] = entry;
    var close = function () { closeExtensionPage(path); };
    closeBtn.addEventListener('click', close);
    if (isPopup) backdrop.addEventListener('click', function (ev) { if (ev.target === backdrop) close(); });

    var ready = defer();
    frame.addEventListener('load', function () { ready.resolve(); }, { once: true });
    (doc.body || doc.documentElement).appendChild(host);
    setT(function () { ready.resolve(); }, 1500);

    return ready.promise.then(function () {
      var fw = frame.contentWindow;
      var fd = frame.contentDocument || (fw && fw.document);
      if (!fw || !fd) throw new Error('overlay frame is not accessible');
      var css = page.css.map(function (p) { return RES[p] ? RES[p].text : ''; }).join('\n');
      fd.open();
      fd.write('<!doctype html><html lang="' + (page.lang || 'en') + '"><head><meta charset="utf-8">' +
        '<meta name="viewport" content="width=device-width,initial-scale=1"><title></title></head><body></body></html>');
      fd.close();
      fd.title = page.title || MANIFEST.name;
      var style = fd.createElement('style');
      style.textContent = css;
      fd.head.appendChild(style);
      /* webpack's runtime looks for the <script> it was loaded from to learn its own URL. This is an
         inert data block (never fetched or executed) that carries that URL. */
      page.js.forEach(function (name) {
        var tag = fd.createElement('script');
        tag.setAttribute('type', 'text/plain');
        tag.setAttribute('src', EXT_BASE + 'js/' + name + '.js');
        fd.head.appendChild(tag);
      });
      Object.keys(page.bodyAttrs || {}).forEach(function (k) { fd.body.setAttribute(k, page.bodyAttrs[k]); });
      fd.body.innerHTML = page.bodyHtml;
      if (!isPopup) fd.documentElement.style.overflow = 'auto';
      try { patchPage(path, fd); } catch (e) { warn('page patch failed', e); }

      var fetchImpl = makeFetch('page', realmOf(fw), nativeFetchOf(fw));
      var g = facade(fw, {
        fetch: fetchImpl,
        browser: ctx.api,
        chrome: ctx.api,
        close: close,
        open: function (url) { openUrl(url); return null; }
      });
      var E = scopeEnv(ctx, fw, fd, g, fetchImpl);
      runScripts(E, page.js, path);
      return entry;
    }).then(null, function (e) {
      warn('cannot open ' + path, e);
      closeExtensionPage(path);
      throw e;
    });
  }

  /* ------------------------------------------------------------------ */
  /* lifecycle                                                          */
  /* ------------------------------------------------------------------ */
  var PRIVACY_PAGE = 'html/privacy_policy/index.html';
  var POPUP_PAGE = 'html/popup/popup.html';
  var META_KEY = CONFIG.keyPrefix + 'meta';
  var DISABLED_KEY = CONFIG.keyPrefix + 'disabled';

  function disableSelf() {
    return kvSetJson(DISABLED_KEY, { at: Date.now() }).then(function () {
      Object.keys(openPages).forEach(closeExtensionPage);
      contexts.forEach(function (c) { c.alive = false; });

    });
  }
  function enableSelf() {
    return kv.del(DISABLED_KEY).then(function () { return kv.del(META_KEY); }).then(function () { win.location.reload(); });
  }

  function lifecycle() {
    return kvGetJson(META_KEY).then(function (meta) {
      var now = Date.now();
      var prev = meta && typeof meta === 'object' ? meta : null;
      var next = { version: MANIFEST.version, touch: now, installedAt: prev && prev.installedAt ? prev.installedAt : now };
      /* name of the per-tab journal slot: random for every installation, says nothing about its owner */
      next.slot = prev && typeof prev.slot === 'string' && prev.slot ? prev.slot : '_' + Math.random().toString(36).slice(2, 12);
      journalSlot = next.slot;
      var p = Promise.resolve();
      if (!prev || !prev.version) {
        installedEvent.pending = { reason: 'install', temporary: false };
        p = wipeArea('session');
      } else {
        if (prev.version !== MANIFEST.version) {
          installedEvent.pending = { reason: 'update', previousVersion: prev.version, temporary: false };
        }
        if (!(now - Number(prev.touch || 0) < CONFIG.sessionGapMs)) {
          startupEvent.pending = true;
          p = wipeArea('session');
        }
      }
      return p.then(function () { return kvSetJson(META_KEY, next); }).then(function () {
        var beat = function () {
          kvSetJson(META_KEY, Object.assign({}, next, { touch: Date.now() })).then(null, function () {});
        };
        win.setInterval(beat, 5 * 60 * 1000);
      });
    });
  }

  function watchHash() {
    var check = function () {
      if (CONFIG.popupHash && String(win.location.hash) === CONFIG.popupHash) {
        openExtensionPage('html/popup/popup.html').then(null, function () {});
      }
    };
    win.addEventListener('hashchange', check);
    check();
  }

  function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* One-time welcome card: replaces the consent / data-collection page of the original
     for builds with `consentGate:false, welcomePage:true`. Shown once per tab session,
     closed by a tap on the button, the backdrop or the Esc key. */
  function showWelcome() {
    try { if (sessionStorage.getItem('ss:welcomeShown')) return; } catch (e) { return; }
    var ru = uiLanguage().toLowerCase().indexOf('ru') === 0;
    var T = ru ? {
      title: 'Welcome to SyncShare',
      text: 'Hints for Moodle quiz questions from people who have already taken them. The SyncShare button appears next to every question.',
      hint: 'Stay menu → “SyncShare” opens sign-in and settings.',
      button: 'Start'
    } : {
      title: 'Welcome to SyncShare',
      text: 'Hints for Moodle quiz questions from people who have already taken them. A SyncShare button appears next to every question.',
      hint: 'Stay menu \u2192 \u201cSyncShare\u201d opens sign-in and settings.',
      button: 'Start'
    };
    var host = doc.createElement('div');
    host.setAttribute('style', 'all:initial;position:fixed;left:0;top:0;right:0;bottom:0;width:100%;height:100%;z-index:2147483647;');
    var root;
    try { root = host.attachShadow({ mode: 'closed' }); } catch (e) { root = host; }
    var box = doc.createElement('div');
    box.setAttribute('style', 'position:absolute;left:0;top:0;right:0;bottom:0;display:flex;align-items:center;justify-content:center;' +
      'padding:calc(env(safe-area-inset-top,0px) + 16px) 16px calc(env(safe-area-inset-bottom,0px) + 16px);box-sizing:border-box;' +
      'background:rgba(16,18,27,.55);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);' +
      'font-family:-apple-system,system-ui,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;');
    var card = doc.createElement('div');
    card.setAttribute('style', 'width:100%;max-width:340px;background:linear-gradient(160deg,#ffffff 0%,#f4f6ff 100%);' +
      'border-radius:20px;box-shadow:0 18px 60px rgba(10,15,40,.35);padding:28px 22px 22px;box-sizing:border-box;text-align:center;' +
      'color:#1b2033;animation:ss-welcome-in .28s cubic-bezier(.2,.8,.3,1) both;');
    card.innerHTML =
      '<div style="width:64px;height:64px;margin:0 auto 16px;border-radius:18px;display:flex;align-items:center;justify-content:center;' +
        'background:linear-gradient(145deg,#667eea,#5b8def);box-shadow:0 8px 20px rgba(102,126,234,.35);">' +
        '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M20 6 9 17l-5-5"/></svg></div>' +
      '<div style="font-size:20px;font-weight:700;letter-spacing:-.2px;margin:0 0 10px;">' + escHtml(T.title) + '</div>' +
      '<div style="font-size:15px;line-height:1.45;color:#4b5166;margin:0 0 14px;">' + escHtml(T.text) + '</div>' +
      '<div style="font-size:13px;line-height:1.4;color:#7a8095;background:#eef1fa;border-radius:12px;padding:10px 12px;margin:0 0 18px;">' +
        escHtml(T.hint) + '</div>' +
      '<button type="button" id="ss-welcome-ok" style="width:100%;border:0;border-radius:14px;padding:15px 16px;' +
        'font-size:17px;font-weight:600;color:#fff;background:linear-gradient(145deg,#667eea,#5b8def);cursor:pointer;' +
        '-webkit-appearance:none;appearance:none;">' + escHtml(T.button) + '</button>';
    var style = doc.createElement('style');
    style.textContent = '@keyframes ss-welcome-in{from{opacity:0;transform:translateY(14px) scale(.97)}to{opacity:1;transform:none}}' +
      '@media (prefers-reduced-motion:reduce){div{animation:none!important}}';
    box.appendChild(card);
    root.appendChild(style);
    root.appendChild(box);

    var done = false;
    var close = function () {
      if (done) return;
      done = true;
      try { host.remove(); } catch (e) {}
      try { sessionStorage.setItem('ss:welcomeShown', '1'); } catch (e) {}
      try { doc.removeEventListener('keydown', onKey, true); } catch (e) {}
    };
    var onKey = function (ev) { if (ev && (ev.key === 'Escape' || ev.key === 'Esc')) close(); };
    var ok = card.querySelector('#ss-welcome-ok');
    if (ok) ok.addEventListener('click', close);
    box.addEventListener('click', function (ev) { if (ev.target === box) close(); });
    try { doc.addEventListener('keydown', onKey, true); } catch (e) {}
    try { (doc.body || doc.documentElement).appendChild(host); } catch (e) {}
  }

  var bootPromise = null;
  var contentCtxPromise = null;
  function boot() {
    if (bootPromise) return bootPromise;
    bootPromise = Promise.resolve().then(function () {
      var top = true;
      try { top = win.top === win.self; } catch (e) { top = false; }
      if (!top) return { skipped: 'frame' };
      var marker = typeof Symbol === 'function' ? Symbol.for('ss.stay.runtime') : '__ss_stay_runtime';
      if (doc[marker]) return { skipped: 'duplicate' };
      try { Object.defineProperty(doc, marker, { value: true, enumerable: false, configurable: true }); } catch (e) {}

      return pickBackend().then(function () {
        return seedPreset();
      }).then(function () {
        return kvGetJson(DISABLED_KEY);
      }).then(function (disabled) {
        if (disabled) {
          registerMenu('SyncShare: enable', function () { enableSelf(); });
          return { skipped: 'disabled' };
        }
        return lifecycle().then(function () {
          watchDeparture();
          win.addEventListener('pagehide', function () { flushLazy(); });
          doc.addEventListener('visibilitychange', function () { if (doc.visibilityState === 'hidden') flushLazy(); });

          var bg = startBackground();
          bgReady.promise.then(function () { return rawGet('local', 'settings'); }).then(function (st) {
            if (hasConsent(st) || !CONFIG.consentGate) return journalReplay();
          }).then(null, function (e) { warn('journal: replay failed', e); });
          registerMenu(MANIFEST.name, function () { if (win.__mse) win.__mse.open(); });
          watchHash();

          if (CONFIG.welcomePage) showWelcome();

          var spec = contentScriptsFor(win.location);
          var contentStarted = Promise.resolve(null);
          if (spec) {
            /* Nothing is read from the quiz page or sent anywhere before the user has answered the
               consent page. (The original shows that page in a tab right after installation, i.e.
               before the first quiz page can be visited; a userscript first runs on the quiz page.) */
            contentStarted = rawGet('local', 'settings').then(function (st) {
              if (hasConsent(st) || !CONFIG.consentGate) return whenIdle().then(function () { return startContent(spec); });
              openExtensionPage(PRIVACY_PAGE).then(null, function () {});
              contentCtxPromise = consentGranted.promise.then(whenIdle).then(function () { return startContent(spec); });
              contentCtxPromise.then(null, function (e) { warn('content start failed', e); });
              return null;
            });
          }
          return contentStarted.then(function (ct) {
            return { background: bg, content: ct, backend: kv.name };
          });
        });
      });
    });
    bootPromise.then(null, function (e) { warn('boot failed', e); });
    return bootPromise;
  }

  return {
    boot: boot,
    openPopup: function () { return openExtensionPage('html/popup/popup.html'); },
    openExtensionPage: openExtensionPage,
    closeExtensionPage: closeExtensionPage,
    bgReady: bgReady.promise,
    pageStorage: pageStorage,
    _internals: {
      contexts: contexts,
      newContext: newContext,
      makeFetch: makeFetch,
      realmOf: realmOf,
      pickBackend: pickBackend,
      lifecycle: lifecycle,
      flushLazy: flushLazy,
      markBgReady: markBgReady,
      installedEvent: installedEvent,
      startupEvent: startupEvent,
      contentScriptsFor: contentScriptsFor,
      getMessage: getMessage,
      matchPatternToRegExp: matchPatternToRegExp,
      netState: netState,
      journal: { add: journalAdd, replay: journalReplay, flushOwn: journalFlushOwn, stats: journalStats, onDeparture: onDeparture, listeners: departListeners, members: contentWindowMembers, slot: function () { return journalSlot; }, prefix: JOURNAL_PREFIX, isLeaving: function () { return leaving; } },
      EXT_BASE: EXT_BASE,
      config: CONFIG,
      facade: facade
    }
  };
}
