'use strict';
/*
 * MSE — the whole interface.
 *
 * Design rules, taken from the reference site (hotaruproject.github.io) to the letter:
 *   . the pill is tiny and quiet: dark, thin border, and only its three letters glow, faintly;
 *   . nothing glows around the pill — no halo, no light on the sides;
 *   . every control inside the panel takes the light on press: the same curve the reference uses
 *     (--press 0→1 in 60 ms, then .52 → .3 → .15 → 0 over 1.5 s), the same two layers
 *     (:before for the outer glow, :after for the inner one) and the same text glow;
 *   . the panel opens smoothly: the frame first, then the rows one after another (a short stagger),
 *     and closes the same way.
 *
 * Navigation is one level deep and has no duplicates:
 *   answers (main) ──ⓘ──▶ account ──▶ gateway
 *                                  └─▶ network log
 *
 * Read-only towards the site: nothing is posted anywhere; the form is filled only when the user taps an answer.
 */
(function () {
  'use strict';

  var CONFIG = Object.assign({
    brand: 'MSE',
    version: '0.3.0',
    apiBase: 'https://syncshare.ru/api/',
    client: '2.22.0',
    posKey: 'mse.pos',
    logKey: 'mse.log',
    width: 300,
    agentRetryMs: 5000
  }, (typeof __MSE_CONFIG__ === 'object' && __MSE_CONFIG__) || {});

  /* ------------------------------------------------------------------ styles */
  var CSS = [ /* @theme */ ];

  /* ------------------------------------------------------------------ per-type knowledge */
  /* the types the answer service of the original understands, and how each is read and filled here */
  var TYPE_INFO = {
    multichoice: { label: 'one answer', kind: 'choice' },
    multichoiceset: { label: 'several answers', kind: 'choice' },
    truefalse: { label: 'true/false', kind: 'choice' },
    shortanswer: { label: 'short answer', kind: 'text' },
    numerical: { label: 'number', kind: 'text' },
    match: { label: 'matching', kind: 'select' },
    gapselect: { label: 'choose from a list', kind: 'select' },
    multianswer: { label: 'nested questions', kind: 'select' },
    gapfill: { label: 'gaps', kind: 'text' },
    coderunner: { label: 'code', kind: 'text' },
    calculated: { label: 'calculated', kind: 'text' },
    calculatedsimple: { label: 'calculated', kind: 'text' },
    calculatedmulti: { label: 'calculated', kind: 'text' }
  };
  /* the ones nobody can answer through their service: said plainly instead of a silent failure */
  var UNSUPPORTED = {
    ddwtos: 'drag into text',
    ddimageortext: 'drag onto an image',
    ddmarker: 'markers on an image',
    dragdrop: 'drag and drop',
    ordering: 'ordering',
    essay: 'essay',
    description: 'description (not a question)'
  };

  function boot() {
    var win = window;
    var doc = document;
    if (win.__mse) return;

    var ls = {
      get: function (k, d) { try { var v = win.localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } },
      set: function (k, v) { try { win.localStorage.setItem(k, v); return true; } catch (e) { return false; } }
    };
    function el(tag, cls, text) {
      var n = doc.createElement(tag);
      if (cls) n.className = cls;
      if (text != null) n.textContent = text;
      return n;
    }
    function norm(s) {
      return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase()
        .replace(/^[a-zа-я]\.\s*/i, '').replace(/[.,;:!?"'«»()]/g, '');
    }

    /* ---------------------------------------------------------------- the network log */
    var log = [];
    try { log = JSON.parse(ls.get(CONFIG.logKey, '[]')) || []; } catch (e) { log = []; }
    function logAdd(kind, ok, text, extra) {
      var line = { t: Date.now(), kind: kind, ok: ok, text: String(text || '') };
      if (extra && extra.ms != null) line.ms = extra.ms;
      log.push(line);
      if (log.length > 120) log.splice(0, log.length - 120);
      ls.set(CONFIG.logKey, JSON.stringify(log));
      if (pop && state.route === 'net') render();
      updateDot();
      return line;
    }
    function logLast(kind) {
      for (var i = log.length - 1; i >= 0; i--) if (!kind || log[i].kind === kind) return log[i];
      return null;
    }
    function ago(ts) {
      var s = Math.round((Date.now() - ts) / 1000);
      if (s < 60) return s + ' s';
      if (s < 3600) return Math.round(s / 60) + ' min';
      return Math.round(s / 3600) + ' h';
    }

    /* ---------------------------------------------------------------- identity */
    /*
     * The id of the signed-in user. Themes differ wildly: some keep it only in `M.cfg`, some only in the user
     * menu, some only in a link, some in a data attribute. Every source known to work is tried, in the order of
     * reliability, and the one that answered is remembered for the host — so a theme that hides it once is
     * covered on every later attempt page, even if the attempt page itself has nothing.
     */
    function idFromValue(v) {
      if (v === null || v === undefined) return null;
      var s = String(v).trim();
      if (!/^\d{1,12}$/.test(s)) return null;
      if (s === '0') return null;
      return s;
    }
    function learnedKey() { return 'mse.id.' + String(win.location.host); }
    function learnId(id, name, login) {
      if (id) ls.set(learnedKey(), String(id));
      if (name) ls.set(learnedKey() + '.name', String(name));
      if (login) ls.set(learnedKey() + '.login', String(login));
    }

    function identity() {
      var out = { id: null, idSource: null, name: null, nameSource: null, login: null, site: null };
      var cfg = null;
      try { cfg = win.M && win.M.cfg; } catch (e) { cfg = null; }
      if (cfg) {
        if (cfg.siteId) out.site = String(cfg.siteId);
        if (cfg.username) out.login = String(cfg.username);
      }
      /* 1. the global config of Moodle — the most reliable place, and the first thing to try */
      var candidates = [];
      if (cfg) {
        candidates.push([idFromValue(cfg.userid), 'M.cfg.userid']);
        candidates.push([idFromValue(cfg.userId), 'M.cfg.userId']);
        candidates.push([idFromValue(cfg.user && cfg.user.id), 'M.cfg.user.id']);
      }
      /* 2. data attributes on the page */
      ['html', 'body'].forEach(function (sel) {
        var node = doc.querySelector(sel);
        if (!node) return;
        candidates.push([idFromValue(node.getAttribute('data-userid')), sel + '@data-userid']);
        candidates.push([idFromValue(node.getAttribute('data-user-id')), sel + '@data-user-id']);
      });
      var anyData = doc.querySelector('[data-userid], [data-user-id]');
      if (anyData) {
        candidates.push([idFromValue(anyData.getAttribute('data-userid')), 'data-userid']);
        candidates.push([idFromValue(anyData.getAttribute('data-user-id')), 'data-user-id']);
      }
      /* 3. a link to the profile or to the user page */
      var links = doc.querySelectorAll('a[href*="profile.php"], a[href*="user/view.php"], a[href*="/user/profile"], a[href*="user/index.php?id="]');
      for (var i = 0; i < links.length && i < 12; i++) {
        var href = links[i].getAttribute('href') || '';
        var m = /[?&](?:id|userid)=(\d+)/.exec(href) || /\/user\/(?:profile|view)\/(\d+)/.exec(href);
        if (m) { candidates.push([idFromValue(m[1]), 'profile link']); break; }
      }
      /* 4. a hidden field of some form (course, profile, message) */
      var hidden = doc.querySelector('input[name="userid"], input[name="user_id"], input[name="id"][type="hidden"]');
      if (hidden) {
        var ctx = String(hidden.form && hidden.form.getAttribute('action') || '');
        if (/user|profile|message|course/.test(ctx) || hidden.name !== 'id') candidates.push([idFromValue(hidden.value), 'hidden field']);
      }
      /* 5. what this host answered before on /my/ or anywhere else */
      candidates.push([idFromValue(ls.get(learnedKey(), null)), 'remembered from /my/']);

      for (var c = 0; c < candidates.length; c++) {
        if (candidates[c][0]) { out.id = candidates[c][0]; out.idSource = candidates[c][1]; break; }
      }

      /* the name: the user menu of any theme, then the avatar */
      var nameSel = [
        '.usertext', '[data-region="user-menu"] .usertext', '.userbutton .usertext', '#nav-user-menu .usertext',
        '[data-region="user-menu"] .fw-bold', '.usermenu .usertext', 'a.dropdown-toggle .usertext'
      ];
      for (var n = 0; n < nameSel.length && !out.name; n++) {
        var node = doc.querySelector(nameSel[n]);
        var t = node ? String(node.textContent || '').replace(/\s+/g, ' ').trim() : '';
        if (t && t.length > 1 && t.length < 120) { out.name = t; out.nameSource = 'user menu'; }
      }
      if (!out.name) {
        var pic = doc.querySelector('img.userpicture, img.avatar, img[src*="/user/icon"], img[src*="u/"]');
        var alt = pic && String(pic.getAttribute('alt') || pic.getAttribute('title') || '').replace(/^picture of\s*/i, '').trim();
        if (alt && alt.length > 1 && alt.length < 120) { out.name = alt; out.nameSource = 'avatar'; }
      }
      if (!out.name) {
        var kept = ls.get(learnedKey() + '.name', null);
        if (kept) { out.name = kept; out.nameSource = 'remembered'; }
      }
      if (!out.login) {
        var keptLogin = ls.get(learnedKey() + '.login', null);
        if (keptLogin) out.login = keptLogin;
      }
      if (out.id) learnId(out.id, out.name, out.login);
      return out;
    }

    /* the id is not on this page at all: the personal cabinet of the same site knows it, and it is one fetch away */
    /*
     * The id out of a page we fetched ourselves. The strong signals are read in order of trust:
     *   . the inline `M.cfg` of Moodle — `M.cfg = {"userid": 12345, ...}` (the one Moodle itself writes);
     *   . a link to the profile of the signed-in user (`/user/profile.php?id=`);
     *   . the avatar link in the user menu;
     *   . a data attribute.
     * A bare `userid` anywhere in the markup is only the last resort: demo sites and plugins keep ids of other
     * things in there (a course of id 1 is not the user of id 12345).
     */
    function readIdFromHtml(text) {
      var html = String(text || '');
      var m = /M\.cfg\s*=\s*(\{[\s\S]{0,4000}?\})\s*;/.exec(html);
      if (m) {
        var cfg = null;
        try { cfg = JSON.parse(m[1]); } catch (e) { cfg = null; }
        if (cfg) {
          var fromCfg = idFromValue(cfg.userid) || idFromValue(cfg.userId) || idFromValue(cfg.user && cfg.user.id);
          if (fromCfg) return fromCfg;
        } else {
          var loose = /"userid"\s*:\s*"?(\d{1,12})/.exec(m[1]);
          if (loose) return loose[1];
        }
      }
      var userBlock = /"user"\s*:\s*\{[^{}]{0,400}"id"\s*:\s*"?(\d{1,12})/.exec(html);
      if (userBlock) return userBlock[1];
      var profile = /(?:user\/profile|user\/view)\.php\?(?:[^"'\s]*?&)?id=(\d{1,12})/.exec(html)
        || /\/user\/(?:profile|view)\/(\d{1,12})/.exec(html);
      if (profile) return profile[1];
      var dataAttr = /data-user-?id=["'](\d{1,12})/.exec(html);
      if (dataAttr) return dataAttr[1];
      var last = /\buserid\s*[:=]\s*"?[\"']?(\d{1,12})(?!\d)/.exec(html);
      return last ? last[1] : null;
    }

    /* the name on a fetched page: the user menu text, the avatar alt, the title of the profile link */
    function readNameFromHtml(text) {
      var html = String(text || '');
      var m = /class="[^"]*\busertext\b[^"]*"[^>]*>([^<]{2,120})</.exec(html);
      if (m) return m[1].replace(/\s+/g, ' ').trim();
      var alt = /<img[^>]+class="[^"]*userpicture[^"]*"[^>]*alt="([^"]{2,120})"/.exec(html);
      if (alt) return alt[1].replace(/^picture of\s*/i, '').trim();
      var title = /<a[^>]+href="[^"]*user\/profile\.php[^"]*"[^>]*>([^<]{2,120})</.exec(html);
      if (title) return title[1].replace(/\s+/g, ' ').trim();
      return null;
    }

    function learnFromCabinet() {
      var started = Date.now();
      return fetch('/my/', { method: 'GET', credentials: 'same-origin', headers: { accept: 'text/html' } })
        .then(function (r) { return r.text(); })
        .then(function (html) {
          var id = readIdFromHtml(html);
          var name = readNameFromHtml(html);
          if (!id) {
            logAdd('gateway', false, 'no id on /my/ either', { ms: Date.now() - started });
            return { ok: false, message: 'no id on /my/ either' };
          }
          learnId(id, name, null);
          logAdd('gateway', true, 'id taken from /my/: ' + id, { ms: Date.now() - started });
          return { ok: true, id: id, name: name };
        }, function (e) {
          logAdd('gateway', false, '/my/ page did not open: ' + ((e && e.message) || 'network'), { ms: Date.now() - started });
          return { ok: false, message: '/my/ page did not open' };
        });
    }

    /* ---------------------------------------------------------------- questions */
    var LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'];

    /* the identity of a question, exactly as the original computes it */
    function questionIdentity(text) {
      var t = String(text || '').trim().toLowerCase().replace(/[\s:.,!?*+\/-]/g, '');
      var n = 7;
      for (var i = 0; i < t.length; i++) {
        var c = t.charCodeAt(i);
        n = n + (c << 5) - c;
      }
      return n;
    }
    function textOf(node) {
      if (!node) return '';
      return String(node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
    }
    /* the caption of a choice, without the "a." of Moodle */
    function answerText(input) {
      var node = null;
      var byRef = input.getAttribute('aria-labelledby');
      if (byRef) {
        byRef.split(/\s+/).forEach(function (id) {
          if (node || !id) return;
          var n = doc.getElementById(id);
          if (n) node = n;
        });
      }
      if (!node && input.id) node = doc.querySelector('label[for="' + input.id + '"]');
      if (!node) {
        var holder = input.closest('.answer, .r0, .r1, [class^="r"]') || input.parentNode;
        node = holder && holder.querySelector('[data-region="answer-label"], label');
      }
      if (!node) return String(input.getAttribute('value') || '');
      var flex = node.querySelector('.flex-fill');
      if (flex) return textOf(flex);
      var copy = node.cloneNode(true);
      Array.prototype.forEach.call(copy.querySelectorAll('.answernumber, .accesshide'), function (x) {
        if (x.parentNode) x.parentNode.removeChild(x);
      });
      return textOf(copy);
    }
    function typeOf(block) {
      var cls = String(block.className || '').split(/\s+/);
      for (var i = 0; i < cls.length; i++) {
        if (cls[i] === 'que' || !cls[i]) continue;
        return cls[i];
      }
      return 'multichoice';
    }
    function qidOf(block) {
      var post = block.querySelector('input.questionflagpostdata');
      if (post) {
        var v = String(post.getAttribute('value') || '');
        var m = /(?:^|&)qid=(\d+)/.exec(v);
        if (m) return m[1];
      }
      var m2 = /^question-(\d+)-/.exec(block.id || '');
      return m2 ? null : null;
    }

    function readQuestion(block) {
      var qtext = block.querySelector('.qtext');
      if (!qtext) return null;
      var clone = qtext.cloneNode(true);
      Array.prototype.forEach.call(clone.querySelectorAll('.accesshide'), function (x) {
        if (x.parentNode) x.parentNode.removeChild(x);
      });
      var text = textOf(clone);
      var type = typeOf(block);
      var q = {
        node: block,
        text: text,
        type: type,
        label: (TYPE_INFO[type] || {}).label || null,
        kind: (TYPE_INFO[type] || {}).kind || null,
        supported: !!TYPE_INFO[type],
        unsupported: UNSUPPORTED[type] || null,
        identity: questionIdentity(text),
        questionId: qidOf(block),
        answers: [],
        controls: []
      };
      /* radios and checkboxes: the choice types */
      var inputs = block.querySelectorAll('input[type=radio], input[type=checkbox]');
      for (var i = 0; i < inputs.length; i++) {
        var inp = inputs[i];
        if (!/^q\d+:\d+_answer/.test(inp.name || '')) continue;
        if (String(inp.getAttribute('value')) === '-1') continue; /* the hidden "clear my choice" */
        if (inp.closest && inp.closest('.qtype_multichoice_clearchoice, .clearchoice')) continue;
        q.answers.push({ input: inp, kind: 'choice', text: answerText(inp), letter: LETTERS[q.answers.length] || '', checked: !!inp.checked });
      }
      /* selects: match, gapselect, cloze */
      var selects = block.querySelectorAll('select');
      for (var s = 0; s < selects.length; s++) {
        var sel = selects[s];
        if (!/^q\d+:\d+_/.test(sel.name || '')) continue;
        q.controls.push({ kind: 'select', node: sel });
      }
      /* text fields: shortanswer, numerical, gapfill, coderunner */
      var texts = block.querySelectorAll('input[type=text][name], textarea[name]');
      for (var t2 = 0; t2 < texts.length; t2++) {
        var box = texts[t2];
        if (!/^q\d+:\d+_/.test(box.name || '')) continue;
        if (/_:flagged|_:sequencecheck/.test(box.name)) continue;
        q.controls.push({ kind: 'text', node: box });
      }
      // ddwtos and friends keep their state in hidden inputs nobody can set for the user
      var places = block.querySelectorAll('input.placeinput');
      if (places.length) q.controls.push({ kind: 'places', count: places.length });
      return q;
    }

    function readQuestions() {
      var out = [];
      var blocks = doc.querySelectorAll('.que');
      for (var i = 0; i < blocks.length; i++) {
        var q = readQuestion(blocks[i]);
        if (q) out.push(q);
      }
      return out;
    }

    function currentQuestion(all) {
      if (!all.length) return null;
      var mid = win.innerHeight / 2;
      var best = null, bestD = Infinity;
      all.forEach(function (q) {
        var r = q.node.getBoundingClientRect();
        if (r.bottom < 0 || r.top > win.innerHeight) return;
        var d = Math.abs((r.top + r.bottom) / 2 - mid);
        if (d < bestD) { bestD = d; best = q; }
      });
      return best || all[0];
    }

    /* ---------------------------------------------------------------- the quiz the user is in */
    /* every parameter their service asks for, taken from as many places of the page as exist:
       a missing one is the reason of their 400, so it is named in the panel instead of guessed */
    function attemptMeta() {
      var meta = { host: String(win.location.host), courseId: null, quizId: null, attemptId: null, moodleId: null, missing: [] };
      var id = identity();
      meta.identity = { id: id.id, name: id.name, login: id.login, source: id.idSource };
      if (id.id) meta.moodleId = id.id;
      var bodyCls = (doc.body && doc.body.className) || '';
      var bodyId = (doc.body && doc.body.id) || '';
      var url = String(win.location.href);

      var m;
      if ((m = /[?&]attempt=(\d+)/.exec(url))) meta.attemptId = m[1];
      if (!meta.attemptId) {
        var hi = doc.querySelector('form#responseform input[name="attempt"], form input[name="attempt"]');
        if (hi && /^\d+$/.test(hi.value || '')) meta.attemptId = hi.value;
      }
      if (!meta.attemptId) {
        var form = doc.querySelector('form#responseform');
        var action = form && (form.getAttribute('action') || '');
        if ((m = /[?&]attempt=(\d+)/.exec(action || ''))) meta.attemptId = m[1];
      }

      if ((m = /[?&]cmid=(\d+)/.exec(url))) meta.quizId = m[1];
      if (!meta.quizId) {
        var link = doc.querySelector('a[href*="/mod/quiz/view.php?id="]');
        if (link) {
          var q = /[?&]id=(\d+)/.exec(link.getAttribute('href') || '');
          if (q) meta.quizId = q[1];
        }
      }
      if (!meta.quizId) {
        try { if (win.M && win.M.cfg && win.M.cfg.cmid != null) meta.quizId = String(win.M.cfg.cmid); } catch (e) {}
      }
      if (!meta.quizId && (m = /\bcmid-(\d+)\b/.exec(bodyCls))) meta.quizId = m[1];
      if (!meta.quizId && (m = /-(\d+)$/.exec(bodyId)) && /quiz/.test(bodyId)) meta.quizId = m[1];

      try { if (win.M && win.M.cfg && win.M.cfg.courseId != null) meta.courseId = String(win.M.cfg.courseId); } catch (e) {}
      if (!meta.courseId && (m = /\bcourse-(\d+)\b/.exec(bodyCls))) meta.courseId = m[1];
      if (!meta.courseId) {
        var cl = doc.querySelector('a[href*="/course/view.php?id="]');
        if (cl && (m = /[?&]id=(\d+)/.exec(cl.getAttribute('href') || ''))) meta.courseId = m[1];
      }

      ['courseId', 'quizId', 'attemptId', 'moodleId'].forEach(function (k) {
        if (!meta[k]) meta.missing.push(k);
      });
      return meta;
    }

    /* ---------------------------------------------------------------- their answer service */
    function serviceUrl(q, meta) {
      var params = [
        'client=' + encodeURIComponent(CONFIG.client),
        'host=' + encodeURIComponent(meta.host),
        'courseId=' + encodeURIComponent(meta.courseId),
        'quizId=' + encodeURIComponent(meta.quizId),
        'attemptId=' + encodeURIComponent(meta.attemptId),
        'moodleId=' + encodeURIComponent(meta.moodleId),
        'questionIdentity=' + encodeURIComponent(q.identity),
        'questionType=' + encodeURIComponent(q.type)
      ];
      if (q.questionId) params.push('questionId=' + encodeURIComponent(q.questionId));
      return CONFIG.apiBase.replace(/\/$/, '') + '/v2/quiz/solution?' + params.join('&');
    }

    /* GET only, and only to the answer service of the original */
    function fetchSolution(q, meta) {
      var started = Date.now();
      if (meta.missing.length) {
        var why = missingSentence(meta);
        logAdd('answers', false, why + ' — request not sent');
        return Promise.reject(new Error(why));
      }
      var url = serviceUrl(q, meta);
      return fetch(url, { method: 'GET', headers: { accept: 'application/json' } }).then(function (r) {
        var ms = Date.now() - started;
        if (r.status === 400) {
          return r.text().then(function (body) {
            logAdd('answers', false, 'answer database: 400 (page data incomplete or the service rejected the request)', { ms: ms });
            throw new Error('answer database: 400 — ' + String(body || '').slice(0, 120));
          });
        }
        if (!r.ok) {
          logAdd('answers', false, 'answer database: ' + r.status, { ms: ms });
          throw new Error('answer database: ' + r.status);
        }
        return r.json().then(function (json) {
          logAdd('answers', true, 'answer database: ' + (Array.isArray(json) ? json.length : 0) + ' records', { ms: ms });
          return json;
        });
      }, function (e) {
        logAdd('answers', false, 'answer database did not respond: ' + ((e && e.message) || 'network'), { ms: Date.now() - started });
        throw new Error('no connection to the answer database');
      });
    }
    function nameOfParam(k) {
      return {
        courseId: 'course',
        quizId: 'quiz',
        attemptId: 'attempt',
        moodleId: 'user id'
      }[k] || k;
    }
    /* a readable sentence: «page data missing: user id» — and, for the id, what was tried */
    function missingSentence(meta) {
      var names = meta.missing.map(nameOfParam).join(', ');
      return 'page data missing: ' + names;
    }

    /* their answer, turned into rows of ours */
    function toRows(json) {
      var rows = [];
      var groups = Array.isArray(json) ? json : [json];
      groups.forEach(function (g) {
        if (!g || typeof g !== 'object') return;
        var pool = (g.suggestions || []).concat(g.submissions || []);
        pool.forEach(function (s) {
          if (!s || s.label == null) return;
          var label = String(s.label).trim();
          if (!label) return;
          var hit = rows.filter(function (r) { return r.label.toLowerCase() === label.toLowerCase(); })[0];
          var correctness = typeof s.correctness === 'number' ? s.correctness : 0;
          var count = typeof s.count === 'number' ? s.count : 0;
          var confidence = typeof s.confidence === 'number' ? s.confidence : null;
          if (!hit) rows.push({ label: label, correctness: correctness, count: count, confidence: confidence });
          else {
            hit.count = Math.max(hit.count, count);
            hit.correctness = Math.max(hit.correctness, correctness);
            if (confidence != null) hit.confidence = Math.max(hit.confidence || 0, confidence);
          }
        });
      });
      var total = rows.reduce(function (a, r) { return a + (r.count || 0); }, 0);
      rows.forEach(function (r) { r.share = total ? Math.round(((r.count || 0) / total) * 100) : null; });
      rows.sort(function (a, b) {
        if (b.correctness !== a.correctness) return b.correctness - a.correctness;
        return (b.count || 0) - (a.count || 0);
      });
      return rows.filter(function (r) { return r.correctness > -1; });
    }

    /* ---------------------------------------------------------------- applying an answer */
    function applyAnswer(q, row) {
      var want = norm(row.label);
      var done = false;
      /* choice: the option with the same caption */
      var hit = null;
      q.answers.forEach(function (a) {
        if (hit) return;
        var n = norm(a.text);
        if (n === want || (want.length > 3 && (n.indexOf(want) >= 0 || want.indexOf(n) >= 0))) hit = a;
      });
      if (hit) {
        if (hit.input.type === 'radio') hit.input.checked = true;
        else hit.input.checked = row.checked === undefined ? true : !!row.checked;
        try { hit.input.click(); } catch (e) {}
        try { hit.input.dispatchEvent(new win.Event('change', { bubbles: true })); } catch (e) {}
        return { ok: true, how: 'choice' };
      }
      /* select: the option with the same caption, in any of the selects of the question */
      var selDone = false;
      q.controls.forEach(function (c) {
        if (selDone || c.kind !== 'select') return;
        var opts = c.node.options || [];
        for (var i = 0; i < opts.length; i++) {
          var n = norm(opts[i].textContent);
          if (!n) continue;
          if (n === want || (want.length > 3 && (n.indexOf(want) >= 0 || want.indexOf(n) >= 0))) {
            c.node.selectedIndex = opts[i].index;
            try { c.node.dispatchEvent(new win.Event('change', { bubbles: true })); } catch (e) {}
            selDone = true;
            return;
          }
        }
      });
      if (selDone) return { ok: true, how: 'select' };
      /* text boxes: the answer goes in as it came */
      var boxes = q.controls.filter(function (c) { return c.kind === 'text' && !c.node.value; });
      if (!boxes.length) boxes = q.controls.filter(function (c) { return c.kind === 'text'; });
      if (boxes.length) {
        boxes[0].node.value = row.label;
        try { boxes[0].node.dispatchEvent(new win.Event('input', { bubbles: true })); } catch (e) {}
        try { boxes[0].node.dispatchEvent(new win.Event('change', { bubbles: true })); } catch (e) {}
        return { ok: true, how: 'text' };
      }
      return { ok: false, how: null, done: done };
    }

    /* ---------------------------------------------------------------- the shell */
    var host = doc.createElement('div');
    host.setAttribute('style', 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483640;');
    var root;
    try { root = host.attachShadow({ mode: 'closed' }); } catch (e) { root = host; }
    var style = doc.createElement('style');
    style.textContent = CSS;
    root.appendChild(style);
    var wrap = el('div', 'mse');
    root.appendChild(wrap);

    var pill = el('button', 'pill');
    pill.setAttribute('type', 'button');
    pill.setAttribute('aria-label', CONFIG.brand);
    pill.innerHTML = '<span>' + CONFIG.brand + '</span>';
    pill.style.pointerEvents = 'auto';
    wrap.appendChild(pill);

    var badge = null;
    function setBadge(n) {
      if (!n) { if (badge && badge.parentNode) badge.parentNode.removeChild(badge); badge = null; return; }
      if (!badge) { badge = el('span', 'num'); badge.setAttribute('data-mse-badge', '1'); pill.appendChild(badge); }
      badge.textContent = String(n);
    }
    /* the light on press: the same flash the reference gives its controls */
    function flash(node) {
      if (!node) return;
      node.classList.remove('hot');
      /* a reflow between two identical animations: without it the second tap would not restart it */
      void node.offsetWidth;
      node.classList.add('hot');
      win.setTimeout(function () { node.classList.remove('hot'); }, 1500);
    }

    var pos = { x: null, y: null };
    try { var saved = JSON.parse(ls.get(CONFIG.posKey, 'null') || 'null'); if (saved && typeof saved.x === 'number') { pos.x = saved.x; pos.y = saved.y; } } catch (e) {}

    function viewport() {
      /* what the phone really shows: the visual viewport shrinks when the browser bars come in */
      var vv = win.visualViewport;
      var w = Math.round((vv && vv.width) || win.innerWidth);
      var h = Math.round((vv && vv.height) || win.innerHeight);
      return { w: w, h: h };
    }

    function place() {
      var vp = viewport(), w = vp.w, h = vp.h;
      var pw = pill.offsetWidth || 44, ph = pill.offsetHeight || 28;
      var x = pos.x == null ? w - 12 - pw : pos.x;
      var y = pos.y == null ? h - 76 : pos.y;
      x = Math.max(6, Math.min(x, w - pw - 6));
      y = Math.max(6, Math.min(y, h - ph - 6));
      pos.x = x; pos.y = y;
      pill.style.left = x + 'px';
      pill.style.top = y + 'px';
      if (pop) layout();
    }

    /* drag moves it; a drag never opens anything, and there is no long press at all */
    var drag = null;
    pill.addEventListener('pointerdown', function (ev) {
      drag = { id: ev.pointerId, sx: ev.clientX, sy: ev.clientY, ox: pos.x, oy: pos.y, moved: false };
      pill.classList.add('dragging');
      try { pill.setPointerCapture(ev.pointerId); } catch (e) {}
      ev.preventDefault();
    });
    pill.addEventListener('pointermove', function (ev) {
      if (!drag) return;
      var dx = ev.clientX - drag.sx, dy = ev.clientY - drag.sy;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) drag.moved = true;
      if (!drag.moved) return;
      pos.x = drag.ox + dx; pos.y = drag.oy + dy;
      place();
      ev.preventDefault();
    });
    pill.addEventListener('pointerup', function () {
      if (!drag) return;
      var moved = drag.moved;
      try { pill.releasePointerCapture(drag.id); } catch (e) {}
      drag = null;
      pill.classList.remove('dragging');
      if (moved) { ls.set(CONFIG.posKey, JSON.stringify({ x: pos.x, y: pos.y })); return; }
      pill.classList.add('lit');
      win.setTimeout(function () { pill.classList.remove('lit'); }, 900);
      toggle();
    });
    pill.addEventListener('pointercancel', function () { drag = null; pill.classList.remove('dragging'); });
    pill.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    win.addEventListener('resize', place);
    win.addEventListener('orientationchange', function () { win.setTimeout(place, 120); });

    /* ---------------------------------------------------------------- the panel */
    var pop = null;
    var state = {
      route: 'answers',        /* answers | account | gateway | net */
      question: null,
      rows: null,
      loading: false,
      error: null,
      meta: null,
      agent: null,             /* { state: 'idle'|'running'|'ok'|'error'|'retry', text, retryIn } */
      agentTimer: null,
      gw: { busy: null, probe: null, models: null, check: null, reg: null },
      ai: null,                /* { state: 'idle'|'running'|'ok'|'error', text, model } — the AI row, owner tier only */
      tier: null,              /* 'base' | 'owner' — base sees only their answer service, owner also the AI row */
      t0: 0
    };

    function closePop() {
      if (!pop) return;
      var p = pop;
      pop = null;
      state.t0 = 0;
      if (state.agentTimer) { win.clearInterval(state.agentTimer); state.agentTimer = null; }
      p.classList.remove('in');
      p.classList.add('out');
      win.setTimeout(function () { if (p.parentNode) p.parentNode.removeChild(p); }, 300);
    }

    function toggle() { if (pop) closePop(); else openPop(); }

    function layout() {
      if (!pop) return;
      var vp = viewport(), vw = vp.w, vh = vp.h;
      /* never wider than the screen with a gutter on both sides: a phone is 390 wide, two of those have 8px each */
      var w = Math.min(CONFIG.width, vw - 16);
      pop.style.width = w + 'px';
      var r = pill.getBoundingClientRect();
      var gap = 8;
      var h = pop.offsetHeight || 180;
      var left = Math.max(8, Math.min(r.right - w, vw - w - 8));
      pop.style.left = left + 'px';
      var above = r.top - gap - 6, below = vh - r.bottom - gap - 6;
      var top;
      if (above >= h || above >= below) {
        top = Math.max(6, r.top - gap - h);
        pop.style.setProperty('--oy', '100%');
      } else {
        top = r.bottom + gap;
        pop.style.setProperty('--oy', '0%');
      }
      /* it stays inside the screen even when there is not enough room on either side */
      top = Math.max(6, Math.min(top, vh - h - 6));
      pop.style.top = top + 'px';
      pop.style.setProperty('--ox', Math.max(0, Math.min(100, ((r.right - 24 - left) / w) * 100)) + '%');
    }

    /* one press handler for every control: the light, then the action */
    function press(node, action) {
      node.classList.add('press');
      node.addEventListener('click', function (ev) {
        ev.preventDefault();
        flash(node);
        win.setTimeout(function () { try { action(ev); } catch (e) {} }, 70);
      });
      return node;
    }

    function openPop() {
      closePop();
      pop = el('div', 'pop');
      wrap.appendChild(pop);
      state.route = 'answers';
      state.rows = null;
      state.error = null;
      state.agent = null;
      state.t0 = Date.now();
      var all = readQuestions();
      state.question = currentQuestion(all);
      state.meta = attemptMeta();
      render();
      win.requestAnimationFrame(function () { if (pop) pop.classList.add('in'); });
      load();
    }

    var rise = 0;
    function N(node, index) {
      /* the stagger index of a row inside the panel: 0 is a valid index, undefined is "no stagger". A row that
         already went up does not do it twice, so a redraw keeps its place instead of flashing the whole panel. */
      if (!node.__mseRisen) {
        node.__mseRisen = true;
        node.classList.add('rise');
      }
      node.style.setProperty('--i', String(index === undefined ? rise++ : index));
      return node;
    }

    function head(titleText, sub, leading) {
      var h = el('div', 'ph');
      var lead = leading === 'back'
        ? press(el('button', 'ib back', '←'), function () { state.route = 'account'; render(); })
        : press(el('button', 'ib', 'i'), function () { state.route = state.route === 'account' ? 'answers' : 'account'; render(); });
      lead.setAttribute('aria-label', leading === 'back' ? 'back' : 'your id');
      lead.style.fontFamily = leading === 'back' ? '' : 'Georgia,serif';
      h.appendChild(lead);
      var t = el('div', 't', titleText);
      if (sub) t.appendChild(el('em', '', sub));
      h.appendChild(t);
      var x = press(el('button', 'ib x', '×'), closePop);
      x.setAttribute('aria-label', 'close');
      h.appendChild(x);
      return h;
    }

    function statusLine() {
      /* one line: what the last request did. Tapping it opens the log. */
      var last = log[log.length - 1];
      var okAll = true, worst = null;
      ['answers', 'gateway'].forEach(function (k) {
        var l = logLast(k);
        if (l && !l.ok) { okAll = false; worst = l; }
      });
      var dotCls = !last ? '' : (okAll ? 'ok' : (worst && Date.now() - worst.t < 60000 ? 'bad' : 'warn'));
      var text;
      if (!last) text = 'network: no requests yet';
      else if (okAll) text = last.kind === 'agent' ? 'agent answered' : 'network ok';
      else {
        var bad = logLast('agent') && !logLast('agent').ok && logLast('agent').t > (logLast('answers') || {}).t ? logLast('agent')
          : (logLast('gateway') && !logLast('gateway').ok && logLast('gateway').t > (logLast('answers') || {}).t ? logLast('gateway') : logLast('answers'));
        text = (bad && bad.text ? bad.text : 'network error');
        if (bad && bad.ms) text += ' · ' + bad.ms + ' ms';
      }
      var row = el('div', 'row');
      row.appendChild(el('span', 'dot ' + dotCls));
      row.appendChild(el('span', 'txt', text));
      row.appendChild(el('span', 'more', 'log'));
      return press(row, function () { state.route = 'net'; render(); });
    }

    /* ---------------------------------------------------------------- two tiers

       base  — no key at all, or the gateway has not accepted it: the answers of their service and nothing else.
               The gateway is never even asked for the AI row.
       owner — the owner let this key in (`/mse/v1/me` says active): the same rows, and when the service has
               nothing to say (empty list, error, unsupported type) one more row comes from the model, marked
               «AI», filled into the form on a tap like any other answer.                        */

    function isActive(st) { return !!(st && st.state === 'active'); }

    /* who we are for the gateway: cached, refreshed on every `load()`; never a request for a base user */
    function tierNow() {
      if (state.tier === 'owner') return Promise.resolve('owner');
      return Promise.resolve(state.tier || 'base');
    }

    function refreshTier() {
      var br = win.MSEBridge;
      /* no address, or a device that never even applied: base, and the gateway is not called at all — a user
         who has not registered a key produces not one byte of traffic towards it */
      if (!br || !br.url() || !br.meta()) { state.tier = 'base'; return Promise.resolve('base'); }
      if (state.tier === 'owner') return Promise.resolve('owner');
      return br.check().then(function (res) {
        state.gw.check = res;
        state.tier = isActive(res) ? 'owner' : 'base';
        return state.tier;
      }, function () { state.tier = 'base'; return 'base'; });
    }

    /* the full context of the question: what it asks, what it offers, what kind of thing it is */
    function aiPrompt(q) {
      var lines = [String(q.text || '').slice(0, 2000)];
      var opts = (q.answers || []).map(function (a) { return String(a.text || '').trim(); }).filter(Boolean);
      if (opts.length) {
        lines.push('');
        lines.push('Options:');
        opts.forEach(function (o, i) { lines.push((i + 1) + '. ' + o); });
        lines.push('');
        lines.push('Answer with exactly one line — the text of the correct option, no numbering and no explanation.');
      } else {
        lines.push('');
        lines.push('Answer only with the short answer to the task, no explanation.');
      }
      return lines.join('\n');
    }

    function aiRow(text, busy) {
      return { label: String(text || '').trim(), correctness: 0, count: 0, agent: true, busy: !!busy };
    }

    /* base: no gateway, no AI row, no request to it */
    function aiAllowed() { return state.tier === 'owner'; }

    /* ---------------- the answers ---------------- */
    function viewAnswers() {
      var q = state.question;
      if (!q) {
        body.appendChild(N(el('div', 'empty', 'no question on this page')));
        body.appendChild(N(statusLine()));
        return;
      }
      if (!q.supported) {
        body.appendChild(N(el('div', 'empty', '«' + (q.unsupported || q.type) + '” — the answer database cannot parse this question type')));
        if (aiAllowed()) appendAi(q);
        body.appendChild(N(statusLine()));
        return;
      }
      if (state.loading) {
        body.appendChild(N(el('div', 'spin')));
        body.appendChild(N(el('div', 'empty', 'asking the database…')));
        return;
      }
      if (state.error) {
        body.appendChild(N(el('div', 'empty', state.error)));
        var missingId = state.meta && state.meta.missing && state.meta.missing.indexOf('moodleId') >= 0;
        var again = press(el('button', 'btn', missingId ? 'take the id from /my/' : 'retry'), function () {
          if (missingId) {
            learnFromCabinet().then(function (r) {
              if (r.ok) { toast('ID: ' + r.id); }
              else toast(r.message);
              state.error = null;
              cabinetTried = false;
              load();
            });
            return;
          }
          load();
        });
        body.appendChild(N(again, 1));
        if (aiAllowed()) appendAi(q);
        body.appendChild(N(statusLine(), 1));
        return;
      }
      var rows = state.rows || [];
      if (!rows.length) {
        body.appendChild(N(el('div', 'empty', 'no answers yet')));
        if (aiAllowed()) appendAi(q);
      } else {
        var list = el('div', 'group');
        body.appendChild(N(list, 0));
        rows.slice(0, 6).forEach(function (r, i) {
          var a = el('button', 'ans press' + (r.correctness > 0 ? ' best' : ''));
          a.setAttribute('type', 'button');
          a.appendChild(el('span', 'mark', r.correctness > 0 ? '✓' : ''));
          a.appendChild(el('span', 'lbl', r.label));
          if (r.share != null) a.appendChild(el('span', 'pct', r.share + '%'));
          else if (r.count) a.appendChild(el('span', 'pct', r.count + '×'));
          if (r.agent) a.appendChild(el('span', 'tag', 'agent'));
          if (r.correctness > 0) a.classList.add('lit');
          a.addEventListener('click', function () {
            flash(a);
            win.setTimeout(function () {
              var res = applyAnswer(q, r);
              if (res.ok) { toast('selected: ' + r.label); setBadge(0); win.setTimeout(closePop, 420); }
              else toast('no such option in the form');
            }, 70);
          });
          list.appendChild(N(a, i));
        });
      }
      if (aiAllowed()) body.appendChild(N(agentStrip(), 1));
      body.appendChild(N(statusLine(), 1));
    }

    /* There is ONE way to ask the model: the agent route. This is its single button, drawn in the answer list;
       the strip under the list only reports the state, it is not a control. */
    function appendAi(q) {
      var ai = state.agent || { state: 'idle' };
      if (ai.state === 'running' || ai.state === 'retry') {
        var run = el('div', 'ans ai busy');
        run.appendChild(el('span', 'mark', '✦'));
        run.appendChild(el('span', 'lbl', ai.state === 'retry' ? 'agent is busy, retrying in ' + ai.retryIn + ' s' : 'agent is thinking…'));
        run.appendChild(el('span', 'tag', 'AI'));
        body.appendChild(N(run, 1));
        return;
      }
      var label = ai.state === 'ok' ? ai.answer
        : ai.state === 'error' ? 'agent: ' + (ai.text || 'error')
        : 'ask the agent';
      var a = el('button', 'ans press ai' + (ai.state === 'ok' ? ' best' : ''));
      a.setAttribute('type', 'button');
      a.appendChild(el('span', 'mark', '✦'));
      a.appendChild(el('span', 'lbl', label));
      /* no model name on the row: the panel does not know models, the router decides which one answers */
      a.appendChild(el('span', 'tag', 'AI'));
      a.addEventListener('click', function () {
        flash(a);
        if (ai.state === 'ok' && ai.answer) {
          win.setTimeout(function () {
            var res = applyAnswer(q, { label: ai.answer, correctness: 0, count: 0, agent: true });
            if (res.ok) { toast(res.how === 'text' ? 'filled in' : 'selected: ' + String(ai.answer).slice(0, 40)); setBadge(0); win.setTimeout(closePop, 420); }
            else toast('not in the form');
          }, 70);
          return;
        }
        runAgent(false);
      });
      body.appendChild(N(a, 1));
    }

    /* the agent's state, one line, no button: the action is the row in the list above */
    function agentStrip() {
      var st = state.agent || { state: 'idle' };
      var row = el('div', 'row');
      row.appendChild(el('span', 'dot ' + (st.state === 'ok' ? 'ok' : st.state === 'error' ? 'bad' : st.state === 'retry' || st.state === 'running' ? 'warn' : '')));
      var txt;
      if (st.state === 'idle') txt = 'agent: not asked';
      else if (st.state === 'running') txt = 'agent is thinking…';
      else if (st.state === 'ok') txt = 'agent: ' + (st.answer || '—');
      else if (st.state === 'retry') txt = 'agent is busy, retrying in ' + st.retryIn + ' s';
      else txt = 'agent: ' + (st.text || 'error');
      row.appendChild(el('span', 'txt', txt));
      return row;
    }

    function runAgent(automatic) {
      var q = state.question;
      if (!q) return;
      if (!win.MSEBridge || !win.MSEBridge.url()) {
        state.agent = { state: 'error', text: 'AI gateway is not set' };
        render();
        return;
      }
      state.agent = { state: 'running' };
      render();
      var t0 = Date.now();
      win.MSEBridge.agent({
        host: state.meta.host,
        question: q.text,
        type: q.type,
        options: q.answers.map(function (a) { return a.text; }),
        multiple: q.type === 'multichoiceset'
      }).then(function (res) {
        var ms = Date.now() - t0;
        if (res.ok && res.answer) {
          logAdd('agent', true, 'agent: ' + String(res.answer).slice(0, 40), { ms: ms });
          /* the model's name stays in the journal; the panel has no business naming models */
          state.agent = { state: 'ok', answer: res.answer };
          var row = { label: res.answer, correctness: 0, count: 0, agent: true };
          if (!(state.rows || []).some(function (r) { return r.label === row.label && r.agent; })) {
            state.rows = [row].concat(state.rows || []);
          }
          render();
          var applied = applyAnswer(q, row);
          if (applied.ok) toast('agent picked: ' + String(res.answer).slice(0, 40));
          return;
        }
        if (res.code === 'rate_limited') {
          logAdd('agent', false, 'agent is busy (limit hit), retrying', { ms: ms });
          startRetry(automatic);
          return;
        }
        var text = res.code === 'network' || res.code === 'timeout' ? 'request did not go out · check the network'
          : res.code === 'no_gateway' ? 'AI gateway is not set'
          : res.code === 'unauthorized' || res.code === 'invalid_key' ? 'key not accepted'
          : res.code === 'device_pending' ? 'waiting for approval by id'
          : 'agent failed: ' + (res.message || 'error');
        logAdd('agent', false, text, { ms: ms });
        state.agent = { state: 'error', text: text };
        render();
      });
    }
    function startRetry(automatic) {
      if (state.agentTimer) { win.clearInterval(state.agentTimer); state.agentTimer = null; }
      var left = Math.round(CONFIG.agentRetryMs / 1000);
      state.agent = { state: 'retry', retryIn: left };
      render();
      state.agentTimer = win.setInterval(function () {
        left -= 1;
        if (left <= 0) {
          win.clearInterval(state.agentTimer);
          state.agentTimer = null;
          runAgent(true);
          return;
        }
        if (state.agent) { state.agent.retryIn = left; if (pop && state.route === 'answers') render(); }
      }, 1000);
    }

    function load() {
      var q = state.question;
      if (!q) { render(); return; }
      state.loading = true;
      state.ai = null;
      state.agent = null;
      render();
      /* who we are for the gateway comes first: a base user must not see a single request towards it */
      var tier = refreshTier();
      if (!q.supported) {
        /* their base cannot read this type at all: nothing to ask it, the AI row (owner only) is the answer */
        state.loading = false;
        state.rows = [];
        state.error = null;
        tier.then(function () { render(); });
        return;
      }
      /* the id may be missing on a theme where only the cabinet knows it: one fetch, and the questions follow */
      var ready = state.meta && state.meta.moodleId ? Promise.resolve(state.meta) : withIdentity();
      ready.then(function (meta) {
        state.meta = meta;
        return fetchSolution(q, meta);
      }).then(function (json) {
        state.rows = toRows(json);
        state.loading = false;
        state.error = null;
        setBadge(state.rows.length);
        return tier.then(function () {
          /* their base came back empty: for an owner the model answers in a row of its own, by itself */
          if (!state.rows.length && aiAllowed() && (!state.agent || state.agent.state === 'idle')) runAgent(true);
          render();
        });
      }, function (e) {
        state.loading = false;
        state.error = e.message;
        return tier.then(function () {
          if (aiAllowed() && (!state.agent || state.agent.state === 'idle')) runAgent(true);
          render();
        });
      });
    }

    /* the identity, completed from the personal cabinet when the page has none */
    var cabinetTried = false;
    function withIdentity() {
      var meta = attemptMeta();
      if (meta.moodleId || cabinetTried || !meta.missing.length || meta.missing.indexOf('moodleId') < 0) return Promise.resolve(meta);
      cabinetTried = true;
      return learnFromCabinet().then(function () {
        return attemptMeta();
      });
    }

    /* ---------------- the account: the only place with the id, the name and the key ---------------- */
    function valueRow(key, value, copyable, human) {
      var row = el('button', 'val press' + (human ? ' human' : ''));
      row.setAttribute('type', 'button');
      row.appendChild(el('span', 'k', key));
      row.appendChild(el('span', 'v', value == null || value === '' ? '—' : String(value)));
      var hint = el('span', 'copy', '');
      row.appendChild(hint);
      if (!copyable) { row.classList.remove('press'); row.disabled = true; return row; }
      /* a row that copies says so before it is tapped: one icon, the same meaning everywhere in the panel */
      hint.textContent = 'copy';
      row.addEventListener('click', function () {
        flash(row);
        win.MSEBridge.copy(value).then(function (ok) {
          hint.textContent = ok ? 'copied' : 'failed';
          win.setTimeout(function () { hint.textContent = ''; }, 1600);
        });
      });
      return row;
    }

    function viewAccount() {
      var id = identity();
      var meta = win.MSEBridge ? win.MSEBridge.meta() : null;
      body.appendChild(N(el('div', 'sec', 'account')));
      body.appendChild(N(valueRow('ID', id.id, !!id.id), 1));
      body.appendChild(N(valueRow('login', id.login, !!id.login), 1));
      body.appendChild(N(valueRow('name', id.name, !!id.name, true), 1));
      body.appendChild(N(el('div', 'sec', 'this device'), 1));
      /* the key itself is never drawn: it lives on this device and is used, not shown */
      var key = win.MSEBridge ? win.MSEBridge.key() : null;
      body.appendChild(N(valueRow('key', win.MSEBridge ? win.MSEBridge.maskedKey() : null, !!key), 1));
      var st = state.gw.check;
      var line = el('div', 'row');
      var good = st && st.state === 'active';
      line.appendChild(el('span', 'dot ' + (good ? 'ok' : st ? 'warn' : '')));
      line.appendChild(el('span', 'txt', good ? 'key accepted' : st ? (st.message || 'key not checked') : 'key not checked'));
      line.appendChild(el('span', 'more', 'open'));
      body.appendChild(N(press(line, function () { state.route = 'gateway'; render(); }), 1));
      var net = el('div', 'row');
      net.appendChild(el('span', 'dot'));
      net.appendChild(el('span', 'txt', 'network log'));
      net.appendChild(el('span', 'more', 'open'));
      body.appendChild(N(press(net, function () { state.route = 'net'; render(); }), 1));
    }

    /* the one path an address takes: checked, then it replaces the old one everywhere, then it is used */
    function checkGateway(raw) {
      var gw = state.gw;
      var br = win.MSEBridge;
      if (!br || !raw) return Promise.resolve(null);
      gw.busy = 'check';
      gw.probe = null;
      gw.models = null;
      render();
      return br.probe(raw).then(function (r) {
        gw.probe = r;
        if (!r.ok) { gw.busy = null; logAdd('gateway', false, 'AI gateway: ' + r.message); render(); return null; }
        /* the new address replaces the old one in every store before anything else can read it */
        br.setUrl(raw);
        (br.audit ? br.audit() : Promise.resolve({ strays: [] })).then(function (audit) {
          var cleared = br.cleared ? br.cleared() : [];
          if (audit && audit.strays.length) logAdd('gateway', false, 'the old address is still in ' + audit.strays.length + ' place(s)');
          else if (cleared.length) logAdd('gateway', true, 'the old address was cleared from ' + cleared.length + ' place(s)');
        }, function () {});
        /* the address answers: now ask it what it accepts and whether this key is welcome */
        return Promise.all([br.models(), br.check()]).then(function (out) {
          gw.models = out[0];
          gw.check = out[1];
          gw.busy = null;
          /* the count is enough for the journal: which models there are is the router's and the bot's business */
          logAdd('gateway', true, 'AI gateway is up · ' + (out[0].models.length || 0) + ' models', { ms: r.ms });
          render();
          return r;
        });
      }, function (e) {
        gw.busy = null;
        gw.probe = { ok: false, message: (e && e.message) || 'error' };
        render();
        return null;
      });
    }

    /* ---------------- the gateway: address, one check, the model that will help ---------------- */
    function viewGateway() {
      var gw = state.gw;
      var br = win.MSEBridge;
      if (!br) { body.appendChild(N(el('div', 'empty', 'the AI gateway layer did not load'))); return; }

      body.appendChild(N(el('div', 'sec', 'address'), 0));
      var input = el('input', 'inp');
      input.type = 'url';
      input.inputMode = 'url';
      input.autocapitalize = 'off';
      input.spellcheck = false;
      input.placeholder = 'https://…';
      input.value = br.url() || '';
      /* a typed address is not used until it is checked: the saved one is the only one that counts */
      input.addEventListener('input', function () {
        var typed = String(input.value || '').trim().replace(/\/+$/, '');
        var saved = br.url() || '';
        input.setAttribute('data-changed', typed && typed !== saved ? '1' : '0');
      });
      body.appendChild(N(input, 1));
      body.appendChild(N(el('div', 'sec', 'connection'), 0));
      var frow = el('div', 'frow');
      body.appendChild(N(frow, 0));
      var check = press(el('button', 'btn solid', gw.busy ? 'checking…' : 'check'), function () {
        return checkGateway(String(input.value || '').trim());
      });
      frow.appendChild(check);
      if (gw.busy === 'check') check.textContent = 'checking…';

      if (gw.probe) {
        body.appendChild(N(el('div', 'sec', 'answer'), 0));
        var p = el('div', 'row');
        p.appendChild(el('span', 'dot ' + (gw.probe.ok ? 'ok' : 'bad')));
        p.appendChild(el('span', 'txt', gw.probe.ok ? 'AI gateway answered · ' + gw.probe.ms + ' ms' : gw.probe.message));
        body.appendChild(N(p, 1));
      }
      if (gw.check) {
        var c = el('div', 'row');
        c.appendChild(el('span', 'dot ' + (gw.check.state === 'active' ? 'ok' : 'warn')));
        c.appendChild(el('span', 'txt', gw.check.state === 'active' ? 'key accepted' : gw.check.message || 'key not accepted'));
        body.appendChild(N(c, 1));
        if (gw.check.state === 'unregistered') {
          body.appendChild(N(press(el('button', 'btn', 'bind to my id'), function () {
            gw.busy = 'reg';
            render();
            br.register(identity()).then(function () { return br.check(); }).then(function (res) {
              gw.check = res;
              gw.busy = null;
              logAdd('gateway', res.state === 'active', 'binding: ' + res.state);
              render();
            }, function (e) {
              gw.busy = null;
              logAdd('gateway', false, 'binding: ' + e.message);
              render();
            });
          }), 1));
        }
      }
      body.appendChild(N(statusLine(), 1));
    }

    /* ---------------- the network log ---------------- */
    function viewNet() {
      body.appendChild(N(el('div', 'sec', 'journal'), 0));
      if (!log.length) { body.appendChild(N(el('div', 'empty', 'empty so far'))); return; }
      var box = el('div', 'log');
      log.slice(-40).reverse().forEach(function (l, i) {
        var ln = el('div', 'ln ' + (l.ok ? 'ok' : 'warn'));
        ln.appendChild(el('span', 'g'));
        ln.appendChild(el('span', 't', ago(l.t)));
        ln.appendChild(el('span', 'm', l.text + (l.ms != null ? ' · ' + l.ms + ' ms' : '')));
        box.appendChild(ln);
      });
      body.appendChild(N(box, 1));
      body.appendChild(N(press(el('button', 'btn', 'clear'), function () {
        log = [];
        logAdd('answers', true, 'log cleared');
        render();
      }), 1));
    }

    /* ---------------- render ---------------- */
    var body = null;
    function render() {
      if (!pop) return;
      rise = 0;
      pop.innerHTML = '';
      /* head: the question number on the main view, the name of the view on the others */
      var sub = null;
      var title = CONFIG.brand;
      var leading = 'info';
      if (state.route === 'answers' && state.question) {
        var idx = Array.prototype.indexOf.call(doc.querySelectorAll('.que'), state.question.node) + 1;
        sub = 'question ' + (idx || 1);
      } else if (state.route === 'account') { sub = 'account'; }
      else if (state.route === 'gateway') { sub = 'AI gateway'; leading = 'back'; }
      else if (state.route === 'net') { sub = 'network'; leading = 'back'; }
      pop.appendChild(head(title, sub, leading));
      body = el('div', 'pb');
      pop.appendChild(body);
      if (state.route === 'account') viewAccount();
      else if (state.route === 'gateway') viewGateway();
      else if (state.route === 'net') viewNet();
      else viewAnswers();
      layout();
    }

    /* the dot in the status line follows the log even while the panel is closed */
    function updateDot() {}

    var toastTimer = null, toastEl = null;
    function toast(text) {
      if (!toastEl) { toastEl = el('div', 'toast'); wrap.appendChild(toastEl); }
      toastEl.textContent = text;
      toastEl.classList.add('on');
      if (toastTimer) win.clearTimeout(toastTimer);
      toastTimer = win.setTimeout(function () { toastEl.classList.remove('on'); }, 2000);
    }

    /* a tap outside closes it; the shadow root is closed, so only the host can be tested here */
    doc.addEventListener('pointerdown', function (e) {
      if (!pop) return;
      var path = e.composedPath ? e.composedPath() : [];
      if (path.indexOf(host) >= 0 || e.target === host) return;
      closePop();
    }, true);
    doc.addEventListener('keydown', function (e) { if (e.key === 'Escape' && pop) closePop(); }, true);

    /* ---------------------------------------------------------------- go */
    place();
    (doc.body || doc.documentElement).appendChild(host);

    win.__mse = {
      open: function () { openPop(); return true; },
      close: closePop,
      identity: identity,
      questions: readQuestions,
      types: function () {
        /* the checklist: which Moodle types this build can fill, and which it names as unsupported */
        var out = { supported: Object.keys(TYPE_INFO), unsupported: Object.keys(UNSUPPORTED) };
        return out;
      },
      current: function () { return currentQuestion(readQuestions()); },
      rows: function () { return state.rows; },
      meta: function () { return attemptMeta(); },
      learnId: function () { return learnFromCabinet(); },
      apply: function (label) {
        var q = state.question || currentQuestion(readQuestions());
        if (!q) return false;
        return applyAnswer(q, { label: label });
      },
      agent: function () { return state.agent; },
      runAgent: function () { runAgent(false); return true; },
      log: function () { return log.slice(-40); },
      clearLog: function () { log = []; render(); return true; },
      copy: function (t) { return win.MSEBridge ? win.MSEBridge.copy(t) : Promise.resolve(false); },
      bridge: function () { return win.MSEBridge || null; },
      settings: function (open) {
        if (open) { if (!pop) openPop(); state.route = 'gateway'; render(); }
        return win.MSEBridge ? win.MSEBridge.status() : null;
      },
      /* the panel's own check, reachable the way the panel reaches it: the same function the button calls */
      gateway: function (url) { return checkGateway(String(url || '').trim()).then(function (r) { return r ? { ok: true } : { ok: false, probe: state.gw.probe }; }); },
      route: function (r) { if (r) { if (!pop) openPop(); state.route = r; render(); } return state.route; },
      pos: function () { return { x: pos.x, y: pos.y }; },
      move: function (x, y) { pos.x = x; pos.y = y; place(); ls.set(CONFIG.posKey, JSON.stringify({ x: pos.x, y: pos.y })); return { x: pos.x, y: pos.y }; },
      toast: toast,
      /* the panel itself, for a test that has to measure it: the shadow root is closed on purpose, so the element is
         handed out here rather than opened to the page's own scripts */
      root: function () {
        /* the panel element itself: the shadow root is closed on purpose, and a node handed out from inside it can
           still be measured and queried, which is all a test needs */
        return wrap || root || null;
      },
      state: function () {
        return {
          visible: !!pop,
          route: state.route,
          pill: {
            text: String((pill.querySelector('span:not([data-mse-badge])') || pill).textContent || '').trim(),
            left: pill.style.left, top: pill.style.top, w: pill.offsetWidth, h: pill.offsetHeight,
            badge: badge ? String(badge.textContent) : null
          },
          pop: pop ? {
            left: pop.style.left, top: pop.style.top, w: pop.offsetWidth, h: pop.offsetHeight,
            text: String(pop.textContent || '').replace(/\s+/g, ' ').trim(),
            controls: controls()
          } : null,
          rows: state.rows,
          error: state.error,
          agent: state.agent,
          /* one name for the outside: the agent's answer, whichever row drew it */
          ai: state.agent && state.agent.state === 'ok' ? { state: 'ok', text: state.agent.answer, model: state.agent.model }
            : state.agent && state.agent.state === 'error' ? { state: 'error', text: state.agent.text }
            : state.agent && state.agent.state === 'running' ? { state: 'running', text: '' }
            : null,
          tier: state.tier,
          meta: state.meta,
          identity: identity(),
          bridge: win.MSEBridge ? win.MSEBridge.status() : null,
          log: log.slice(-12),
          question: state.question ? {
            text: state.question.text.slice(0, 120),
            type: state.question.type,
            kind: state.question.kind,
            supported: state.question.supported,
            identity: state.question.identity,
            questionId: state.question.questionId,
            answers: state.question.answers.map(function (a) { return a.text; })
          } : null
        };
      }
    };

    function controls() {
      var out = {};
      if (!pop) return out;
      Array.prototype.forEach.call(pop.querySelectorAll('[data-mse]'), function (n) {
        var r = n.getBoundingClientRect();
        out[n.getAttribute('data-mse')] = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      });
      Array.prototype.forEach.call(pop.querySelectorAll('.ans, .btn, .val, .row, .ib'), function (n, i) {
        var r = n.getBoundingClientRect();
        out['c' + i] = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), text: String(n.textContent || '').trim().slice(0, 40) };
      });
      return out;
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
