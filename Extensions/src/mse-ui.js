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
    agentRetryMs: 5000,
    agentAllowWithoutImages: false
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
    matching: { label: 'matching', kind: 'select' },
    gapselect: { label: 'choose from a list', kind: 'select' },
    multianswer: { label: 'nested questions', kind: 'select' },
    gapfill: { label: 'gaps', kind: 'text' },
    coderunner: { label: 'code', kind: 'text' },
    calculated: { label: 'calculated', kind: 'text' },
    calculatedsimple: { label: 'calculated', kind: 'text' },
    calculatedmulti: { label: 'calculated', kind: 'choice' },
    ddwtos: { label: 'drag into text', kind: 'ddwtos' }
  };
  /* the ones nobody can answer through their service: said plainly instead of a silent failure */
  var UNSUPPORTED = {
    ddimageortext: 'drag onto an image',
    ddmarker: 'markers on an image',
    dragdrop: 'drag and drop',
    ordering: 'ordering',
    essay: 'essay',
    description: 'description (not a question)'
  };

  /* Layer 1 schema registry: questions conforming to constructor specification */
  var LAYER_1_TYPES = [
    'multichoice',
    'truefalse',
    'shortanswer',
    'numerical',
    'essay',
    'matching',
    'match',
    'multianswer',
    'ddwtos',
    'ddmarker',
    'ddimageortext',
    'dragdrop',
    'calculated',
    'calculatedmulti',
    'calculatedsimple',
    'multichoiceset',
    'gapselect',
    'gapfill'
  ];

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
        .replace(/^(\([a-zа-я0-9]{1,2}\)|[a-zа-я0-9]{1,2}[\.\)\:\-])\s*/i, '')
        .replace(/[.,;:!?'"«»()]/g, '')
        .trim();
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
    function learnId(id, name) {
      if (id) ls.set(learnedKey(), String(id));
      if (name) ls.set(learnedKey() + '.name', String(name));
    }

    function identity() {
      var out = { id: null, idSource: null, name: null, nameSource: null, site: null };
      var cfg = null;
      try { cfg = win.M && win.M.cfg; } catch (e) { cfg = null; }
      if (cfg) {
        if (cfg.siteId) out.site = String(cfg.siteId);
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
      if (out.id) learnId(out.id, out.name);
      return out;
    }

    function debugAuxFetch(url, options) {
      return fetch(url, options).then(function (response) {
        debugTraffic({request:{url:String(url),method:(options && options.method) || 'GET'}, response:{status:response.status, body:'omitted: private page or binary'}});
        return response;
      }, function (error) { debugTraffic({request:{url:String(url)}, error:String(error && error.message || 'network')}); throw error; });
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
      return debugAuxFetch('/my/', { method: 'GET', credentials: 'same-origin', headers: { accept: 'text/html' } })
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
      if (!node) node = input.closest('label');
      if (!node) {
        var holder = input.closest('.r0, .r1, [data-region="answer"], .answer > div') || input.parentNode;
        node = holder && (holder.querySelector('[data-region="answer-label"], label') || holder);
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
      if (m2) return m2[1];
      var m3 = /(?:^|-)(?:q|question-?)(\d+)(?:-|$)/i.exec(block.id || '');
      return m3 ? m3[1] : null;
    }

    function readQuestion(block) {
      var qtext = block.querySelector('.qtext');
      if (!qtext) return null;
      var clone = qtext.cloneNode(true);
      Array.prototype.forEach.call(clone.querySelectorAll('.accesshide'), function (x) {
        if (x.parentNode) x.parentNode.removeChild(x);
      });
      var text = textOf(clone);
      if (!text && clone.querySelector('img')) text = '[image question]';
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
        if (!/^q\d+:\d+(_sub\d+)?_(answer|choice\d*)/.test(inp.name || '')) continue;
        if (String(inp.getAttribute('value')) === '-1') continue; /* the hidden "clear my choice" */
        if (inp.closest && inp.closest('.qtype_multichoice_clearchoice, .clearchoice')) continue;
        var caption = answerText(inp);
        if (!caption) {
          var holder = inp.closest('.r0, .r1, [data-region="answer"], label') || inp.parentNode;
          var image = holder && holder.querySelector('img');
          if (image) caption = image.getAttribute('alt') || ('image ' + (q.answers.length + 1));
        }
        if (/^(очистить мой выбор|clear my choice)$/i.test(String(caption || '').trim())) continue;
        q.answers.push({ input: inp, kind: 'choice', text: caption, letter: LETTERS[q.answers.length] || '', checked: !!inp.checked });
      }

      /* ddwtos drag items */
      var dragHomes = block.querySelectorAll('.draggrouphomes .draghome, .draghome');
      var seenDrag = {};
      for (var dh = 0; dh < dragHomes.length; dh++) {
        var dNode = dragHomes[dh];
        if (dNode.classList.contains('dragplaceholder')) continue;
        var cloneD = dNode.cloneNode(true);
        Array.prototype.forEach.call(cloneD.querySelectorAll('.accesshide'), function (x) {
          if (x.parentNode) x.parentNode.removeChild(x);
        });
        var dCaption = textOf(cloneD);
        if (!dCaption) continue;
        var cMatch = /choice(\d+)/.exec(dNode.className || '');
        var choiceIdx = cMatch ? parseInt(cMatch[1], 10) : (q.answers.length + 1);
        var key = choiceIdx + ':' + dCaption;
        if (!seenDrag[key]) {
          seenDrag[key] = true;
          q.answers.push({ node: dNode, kind: 'drag', text: dCaption, choiceIndex: choiceIdx, letter: LETTERS[q.answers.length] || '' });
        }
      }

      /* interactive controls in DOM order: select, text, hidden placeinput */
      var controlNodes = block.querySelectorAll('select, input[type=text][name], textarea[name], input.placeinput');
      for (var cn = 0; cn < controlNodes.length; cn++) {
        var node = controlNodes[cn];
        var tag = node.tagName.toLowerCase();
        if (tag === 'select') {
          if (!/^q\d+:\d+_/.test(node.name || '')) continue;
          q.controls.push({ kind: 'select', node: node });
        } else if (tag === 'input' && node.classList.contains('placeinput')) {
          var pMatch = /place(\d+)/.exec(node.className || '') || /_p(\d+)/.exec(node.name || '');
          var pNo = pMatch ? parseInt(pMatch[1], 10) : (q.controls.filter(function (c) { return c.kind === 'place'; }).length + 1);
          q.controls.push({ kind: 'place', placeNo: pNo, node: node });
        } else {
          if (!/^q\d+:\d+_/.test(node.name || '')) continue;
          if (/_:flagged|_:sequencecheck|_:qaid|_:qubaid/.test(node.name || '')) continue;
          q.controls.push({ kind: 'text', node: node });
        }
      }
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
      meta.identity = { id: id.id, name: id.name, source: id.idSource };
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
    var lastSyncRequest = null;
    function fetchSolution(q, meta) {
      var started = Date.now();
      if (meta.missing.length) {
        var why = missingSentence(meta);
        logAdd('answers', false, why + ' — request not sent');
        return Promise.reject(new Error(why));
      }
      var url = serviceUrl(q, meta);
      var params = {};
      try {
        new URL(url).searchParams.forEach(function (value, key) { params[key] = value; });
      } catch (_) {}
      var record = { questionIdentity: q.identity, request: { method: 'GET', url: url, params: params }, response: null };
      lastSyncRequest = record;

      var controller = typeof AbortController === 'function' ? new AbortController() : null;
      var timer = null;
      var timeoutPromise = new Promise(function (_, reject) {
        timer = win.setTimeout(function () {
          if (controller) try { controller.abort(); } catch (_) {}
          reject(new Error('database timed out'));
        }, 10000);
      });

      var fetchPromise = fetch(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: controller ? controller.signal : undefined
      }).then(function (r) {
        if (timer) { win.clearTimeout(timer); timer = null; }
        r.clone().text().then(function (raw) {
          var value; try { value = JSON.parse(raw); } catch (e) { value = raw; }
          record.response = { status: r.status, json: value };
          debugTraffic(record);
        }, function () { record.response = { status: r.status, error: 'unreadable response' }; });
        var ms = Date.now() - started;
        if (r.status === 400) {
          return r.text().then(function (body) {
            logAdd('answers', false, 'database 400 · check page data', { ms: ms });
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
        if (timer) { win.clearTimeout(timer); timer = null; }
        var isTimeout = e && (e.name === 'AbortError' || e.message === 'database timed out');
        var errText = isTimeout ? 'database timed out' : 'no connection to the answer database';
        record.response = { error: isTimeout ? 'timeout' : ((e && e.name) || 'network') };
        debugTraffic(record);
        logAdd('answers', false, isTimeout ? 'database timed out' : ('database offline: ' + ((e && e.message) || 'network')), { ms: Date.now() - started });
        throw new Error(errText);
      });

      return Promise.race([fetchPromise, timeoutPromise]).catch(function (e) {
        if (timer) { win.clearTimeout(timer); timer = null; }
        var isTimeout = e && (e.name === 'AbortError' || e.message === 'database timed out');
        if (isTimeout) throw new Error('database timed out');
        throw e;
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
      var parts = String(row.label || '').split('|').map(function (x) { return x.trim(); }).filter(Boolean);
      if (!parts.length) return {ok:false};

      /* ddwtos: drag into text */
      var places = q.controls.filter(function (c) { return c.kind === 'place'; });
      if (!places.length) {
        var rawPlaces = q.node.querySelectorAll('input.placeinput');
        if (rawPlaces.length) {
          places = Array.prototype.map.call(rawPlaces, function (p, idx) {
            var m = /place(\d+)/.exec(p.className || '') || /_p(\d+)/.exec(p.name || '');
            return { kind: 'place', placeNo: m ? parseInt(m[1], 10) : (idx + 1), node: p };
          });
        }
      }
      if (places.length) {
        if (parts.length !== places.length) return {ok:false};
        var dragHomes = q.answers.filter(function (a) { return a.kind === 'drag'; });
        if (!dragHomes.length) {
          var rawHomes = q.node.querySelectorAll('.draggrouphomes .draghome, .draghome');
          dragHomes = Array.prototype.filter.call(rawHomes, function (d) { return !d.classList.contains('dragplaceholder'); }).map(function (d, idx) {
            var m = /choice(\d+)/.exec(d.className || '');
            return { kind: 'drag', text: (d.textContent || '').trim(), choiceIndex: m ? parseInt(m[1], 10) : (idx + 1), node: d };
          });
        }
        var matched = parts.map(function (part) {
          var hit = dragHomes.find(function (d) { return norm(d.text) === norm(part); });
          if (!hit && /^\d+$/.test(part)) {
            var num = parseInt(part, 10);
            hit = dragHomes.find(function (d) { return d.choiceIndex === num; });
          }
          return hit || null;
        });
        if (matched.some(function (x) { return !x; })) return {ok:false};
        places.forEach(function (p, i) {
          var choiceVal = String(matched[i].choiceIndex);
          p.node.value = choiceVal;
          p.node.dispatchEvent(new win.Event('input', {bubbles:true}));
          p.node.dispatchEvent(new win.Event('change', {bubbles:true}));
          var placeNo = p.placeNo || (i + 1);
          var dropZone = q.node.querySelector('.place' + placeNo + '.drop') || p.node.closest('.place' + placeNo) || (p.node.parentNode && p.node.parentNode.classList && p.node.parentNode.classList.contains('drop') ? p.node.parentNode : null);
          if (dropZone) {
            dropZone.classList.add('active', 'filled');
            var existingText = dropZone.querySelector('.draghome');
            if (existingText) {
              existingText.textContent = matched[i].text;
            } else {
              var span = doc.createElement('span');
              span.className = 'draghome choice' + choiceVal + ' placed';
              span.textContent = matched[i].text;
              dropZone.appendChild(span);
            }
          }
        });
        return {ok:true, how:'ddwtos'};
      }

      /* choice questions: checkboxes */
      var checks = q.answers.filter(function (a) { return a.kind === 'choice' && a.input && a.input.type === 'checkbox'; });
      if (checks.length && (!q.controls.length || q.type === 'multichoiceset')) {
        var chosen = parts.map(function (part) {
          var hits = checks.filter(function (a) { return norm(a.text) === norm(part); });
          if (!hits.length) {
            var pTrim = String(part || '').trim();
            hits = checks.filter(function (a, idx) {
              return (a.letter && a.letter.toLowerCase() === pTrim.toLowerCase()) || String(idx + 1) === pTrim;
            });
          }
          return hits.length === 1 ? hits[0] : null;
        });
        if (chosen.some(function (x) { return !x; })) return {ok:false};
        if (parts.length === 1) {
          chosen[0].input.click();
        } else {
          checks.forEach(function (a) { var selected = chosen.indexOf(a) >= 0; if (a.input.checked !== selected) a.input.click(); });
        }
        return {ok:true, how:'choice'};
      }

      /* choice questions: single radio */
      var radios = q.answers.filter(function (a) { return a.kind === 'choice' && a.input && a.input.type === 'radio'; });
      if (radios.length && (!q.controls.length || q.type === 'multichoice' || q.type === 'truefalse' || q.type === 'calculatedmulti')) {
        if (parts.length === 1) {
          var hits = radios.filter(function (a) { return norm(a.text) === norm(parts[0]); });
          if (!hits.length) {
            var pTrim = String(parts[0] || '').trim();
            hits = radios.filter(function (a, idx) {
              return (a.letter && a.letter.toLowerCase() === pTrim.toLowerCase()) || String(idx + 1) === pTrim;
            });
          }
          if (hits.length === 1) { if (!hits[0].input.checked) hits[0].input.click(); return {ok:true, how:'choice'}; }
        }
      }

      /* single dropdown target via selectIndex */
      var selects = q.controls.filter(function (c) { return c.kind === 'select'; });
      if (typeof row.selectIndex === 'number' && selects[row.selectIndex]) {
        var target = selects[row.selectIndex];
        var matches = Array.prototype.filter.call(target.node.options, function (o) {
          return norm(o.textContent) === norm(parts[0]) || String(o.value) === parts[0];
        });
        if (!matches.length && /^\d+$/.test(parts[0])) {
          var numIdx = parseInt(parts[0], 10);
          if (numIdx >= 0 && numIdx < target.node.options.length) matches = [target.node.options[numIdx]];
        }
        if (matches.length === 1) {
          target.node.value = matches[0].value;
          target.node.dispatchEvent(new win.Event('change', {bubbles:true}));
          return {ok:true, how:'select'};
        }
        return {ok:false};
      }

      /* multi-control or mixed controls (Cloze, Matching, Gapselect, Gapfill) */
      var interactive = q.controls.filter(function (c) { return c.kind === 'select' || c.kind === 'text'; });
      if (interactive.length && interactive.length === parts.length) {
        var planned = [];
        for (var idx = 0; idx < interactive.length; idx++) {
          var ctrl = interactive[idx];
          var val = parts[idx];
          if (ctrl.kind === 'select') {
            var opts = Array.prototype.filter.call(ctrl.node.options, function (o) {
              return norm(o.textContent) === norm(val) || String(o.value) === val;
            });
            if (!opts.length && /^\d+$/.test(val)) {
              var nIdx = parseInt(val, 10);
              if (nIdx >= 0 && nIdx < ctrl.node.options.length) opts = [ctrl.node.options[nIdx]];
            }
            if (opts.length !== 1) return {ok:false};
            planned.push({ kind: 'select', node: ctrl.node, value: opts[0].value });
          } else if (ctrl.kind === 'text') {
            planned.push({ kind: 'text', node: ctrl.node, value: val });
          }
        }
        planned.forEach(function (act) {
          if (act.kind === 'select') {
            act.node.value = act.value;
            act.node.dispatchEvent(new win.Event('change', {bubbles:true}));
          } else if (act.kind === 'text') {
            act.node.value = act.value;
            act.node.dispatchEvent(new win.Event('input', {bubbles:true}));
            act.node.dispatchEvent(new win.Event('change', {bubbles:true}));
            try {
              var parentBox = act.node.closest('.answer, .formulation, label') || act.node.parentNode;
              var richEd = parentBox && parentBox.querySelector('[contenteditable="true"], .editor_atto_content');
              if (richEd) {
                richEd.innerHTML = '<p>' + act.value + '</p>';
                richEd.dispatchEvent(new win.Event('input', {bubbles:true}));
              }
              if (act.node.tagName.toLowerCase() === 'textarea' && win.ace && typeof win.ace.edit === 'function') {
                var aceId = act.node.id || (act.node.parentNode && act.node.parentNode.id);
                var ed = aceId ? win.ace.edit(aceId) : null;
                if (ed && ed.setValue) ed.setValue(act.value, 1);
              }
            } catch (_) {}
          }
        });
        return {ok:true, how: interactive.every(function (c) { return c.kind === 'select'; }) ? 'select' : (interactive.every(function (c) { return c.kind === 'text'; }) ? 'text' : 'multi')};
      }

      /* single interactive control fallback */
      if (parts.length === 1 && interactive.length === 1) {
        var solo = interactive[0];
        if (solo.kind === 'select') {
          var sOpts = Array.prototype.filter.call(solo.node.options, function (o) {
            return norm(o.textContent) === norm(parts[0]) || String(o.value) === parts[0];
          });
          if (!sOpts.length && /^\d+$/.test(parts[0])) {
            var sNum = parseInt(parts[0], 10);
            if (sNum >= 0 && sNum < solo.node.options.length) sOpts = [solo.node.options[sNum]];
          }
          if (sOpts.length === 1) {
            solo.node.value = sOpts[0].value;
            solo.node.dispatchEvent(new win.Event('change', {bubbles:true}));
            return {ok:true, how:'select'};
          }
        } else if (solo.kind === 'text') {
          solo.node.value = parts[0];
          solo.node.dispatchEvent(new win.Event('input', {bubbles:true}));
          solo.node.dispatchEvent(new win.Event('change', {bubbles:true}));
          try {
            var pBox = solo.node.closest('.answer, .formulation, label') || solo.node.parentNode;
            var rEd = pBox && pBox.querySelector('[contenteditable="true"], .editor_atto_content');
            if (rEd) {
              rEd.innerHTML = '<p>' + parts[0] + '</p>';
              rEd.dispatchEvent(new win.Event('input', {bubbles:true}));
            }
            if (solo.node.tagName.toLowerCase() === 'textarea' && win.ace && typeof win.ace.edit === 'function') {
              var aId = solo.node.id || (solo.node.parentNode && solo.node.parentNode.id);
              var aEd = aId ? win.ace.edit(aId) : null;
              if (aEd && aEd.setValue) aEd.setValue(parts[0], 1);
            }
          } catch (_) {}
          return {ok:true, how:'text'};
        }
      }

      /* fallback for single radio / single checkbox when parts.length === 1 */
      if (parts.length === 1) {
        var anyHits = q.answers.filter(function (a) { return a.kind === 'choice' && a.input && norm(a.text) === norm(parts[0]); });
        if (!anyHits.length) {
          var aTrim = String(parts[0] || '').trim();
          anyHits = q.answers.filter(function (a, idx) {
            return (a.letter && a.letter.toLowerCase() === aTrim.toLowerCase()) || String(idx + 1) === aTrim;
          });
        }
        if (anyHits.length === 1) {
          if (!anyHits[0].input.checked) anyHits[0].input.click();
          return {ok:true, how:'choice'};
        }
      }

      return {ok:false, how:null};
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
      gatewayModel: ls.get('mse.gateway.lastModel', null), modelEpoch: 0,
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
      refreshHeaderModel();
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

    function statusDotClass() {
      var last = log[log.length - 1];
      var okAll = true, worst = null;
      ['answers', 'gateway'].forEach(function (k) {
        var l = logLast(k);
        if (l && !l.ok) { okAll = false; worst = l; }
      });
      return !last ? '' : (okAll ? 'ok' : (worst && Date.now() - worst.t < 60000 ? 'bad' : 'warn'));
    }

    function statusShortText() {
      var last = log[log.length - 1];
      var okAll = true;
      ['answers', 'gateway'].forEach(function (k) {
        var l = logLast(k);
        if (l && !l.ok) { okAll = false; }
      });
      if (!last) return 'status';
      if (!okAll) return 'error';
      return 'status';
    }

    function head(titleText, sub, leading) {
      var h = el('div', 'ph');
      var lead;
      if (leading === 'back') {
        lead = press(el('button', 'ib back', '←'), function () { state.route = state.route === 'status' ? 'answers' : 'account'; render(); });
        lead.setAttribute('aria-label', 'back');
      } else {
        lead = press(el('button', 'ib settings-btn'), function () { state.route = state.route === 'account' ? 'answers' : 'account'; render(); });
        lead.setAttribute('aria-label', 'settings');
        lead.setAttribute('data-mse', 'settings-gear');
        lead.innerHTML = '<span style="display:none">i</span><svg class="gear-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>';
      }
      h.appendChild(lead);
      var t = el('div', 't', titleText);
      if (sub) t.appendChild(el('em', '', sub));
      h.appendChild(t);
      var br = win.MSEBridge;
      var brMeta = br && br.meta && br.meta();
      var activeKey = state.tier === 'owner' || (brMeta && (brMeta.status === 'active' || (brMeta.device && brMeta.device.status === 'active'))) || (state.gw && state.gw.check && state.gw.check.state === 'active') || (br && br.cachedCheck && br.cachedCheck() && br.cachedCheck().state === 'active');
      var displayModel = state.gatewayModel || ls.get('mse.gateway.lastModel');
      var showChip = displayModel && br && br.url() && (activeKey || state.route === 'gateway');
      if (showChip) {
        var chip = el('span', 'model-chip', displayModel);
        chip.setAttribute('data-mse', 'model-chip');
        chip.setAttribute('title', displayModel);
        chip.setAttribute('aria-label', 'AI model: ' + displayModel);
        h.appendChild(chip);
      }
      var mini = el('button', 'mini-status');
      mini.setAttribute('type', 'button');
      mini.setAttribute('aria-label', 'status');
      mini.setAttribute('data-mse', 'mini-status');
      var dotCls = statusDotClass();
      mini.appendChild(el('span', 'dot ' + dotCls));
      mini.appendChild(el('span', 'mini-txt', statusShortText()));
      mini.addEventListener('click', function () {
        state.route = state.route === 'status' ? 'answers' : 'status';
        render();
      });
      h.appendChild(mini);
      var x = press(el('button', 'ib x', '×'), closePop);
      x.setAttribute('aria-label', 'close');
      h.appendChild(x);
      return h;
    }

    function viewStatus() {
      body.appendChild(N(el('div', 'sec', 'status'), 0));
      var grid = el('div', 'status-grid');
      var last = log[log.length - 1];
      var okNet = !last || last.ok;
      var ag = state.agent || { state: 'idle' };
      var gw = state.gw && state.gw.check;
      var items = [
        { k: 'network', v: okNet ? 'ok' : 'error' },
        { k: 'agent', v: ag.state === 'ok' ? 'ok' : ag.state === 'running' ? (ag.stage || 'running') : ag.state === 'error' ? 'error' : 'idle' },
        { k: 'gateway', v: gw && gw.state === 'active' ? 'active' : (win.MSEBridge && win.MSEBridge.url() ? 'set' : 'none') },
        { k: 'model', v: state.gatewayModel || '—' },
        { k: 'last event', v: last ? last.text : 'no events' }
      ];
      items.forEach(function (it) {
        var row = el('div', 'status-item');
        row.appendChild(el('span', 'k', it.k));
        row.appendChild(el('span', 'v', it.v));
        grid.appendChild(row);
      });
      body.appendChild(N(grid, 0));
      var frow = el('div', 'frow');
      var openLogs = press(el('button', 'btn', 'network log'), function () { state.route = 'net'; render(); });
      var back = press(el('button', 'btn solid', 'back'), function () { state.route = 'answers'; render(); });
      frow.appendChild(openLogs);
      frow.appendChild(back);
      body.appendChild(N(frow, 1));
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
        return;
      }
      if (!q.supported) {
        body.appendChild(N(el('div', 'empty', 'unsupported: ' + (q.unsupported || q.type))));
        if (aiAllowed()) appendAi(q);
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
        return;
      }
      var rows = (state.rows || []).slice();
      if (!rows.length && q.answers.length) rows = q.answers.map(function (answer) { return {label:answer.text, correctness:0}; });
      if (!rows.length && q.controls.some(function (c) { return c.kind === 'select'; })) {
        q.controls.filter(function (c) { return c.kind === 'select'; }).forEach(function (c, index) {
          Array.prototype.forEach.call(c.node.options, function (o) { if (o.value && !o.disabled) rows.push({label:o.textContent.trim(), selectIndex:index, correctness:0}); });
        });
      }
      if (!rows.length) {
        body.appendChild(N(el('div', 'empty', 'no answers yet')));
      } else {
        var list = el('div', 'group');
        body.appendChild(N(list, 0));
        rows.slice(0, 40).forEach(function (r, i) {
          var a = el('button', 'ans press' + (r.agent ? ' agent' : '') + (r.correctness > 0 ? ' best' : ''));
          a.setAttribute('type', 'button');
          var mark = el('span', 'mark' + (r.agent ? ' agent' : ''));
          a.appendChild(mark);
          a.appendChild(el('span', 'lbl', r.label));
          if (!r.agent) {
            if (r.share != null) a.appendChild(el('span', 'pct', r.share + '%'));
            else if (r.count) a.appendChild(el('span', 'pct', r.count + '×'));
          }
          if (r.agent) {
            var tag = el('span', 'tag agent', 'agent');
            a.appendChild(tag);
          }
          if (r.correctness > 0) a.classList.add('lit');
          a.addEventListener('click', function () {
            flash(a);
            win.setTimeout(function () {
              var res = applyAnswer(q, r);
              if (res.ok) { setBadge(0); closePop(); }
              else { state.error = 'not in the form'; render(); }
            }, 60);
          });
          list.appendChild(N(a, i));
        });
      }
      if (aiAllowed() && (!state.agent || state.agent.state !== 'ok')) appendAi(q);
    }

    /* There is ONE way to ask the model: the agent route. This is its single button, drawn in the answer list;
       the strip under the list only reports the state, it is not a control. */
    function appendAi(q) {
      var ai = state.agent || { state: 'idle' };
      if (ai.state === 'running' || ai.state === 'retry') {
        var run = el('div', 'agent-status-strip');
        run.setAttribute('data-mse', 'agent-status');
        run.appendChild(el('span', 'dot ok'));
        var stageText = ai.state === 'retry' ? 'agent busy · retry in ' + ai.retryIn + ' s' : (ai.stage ? ai.stage + '…' : 'reasoning…');
        run.appendChild(el('span', 'txt', stageText));
        body.appendChild(N(run, 1));
        return;
      }
      if (ai.state === 'error') {
        var errRow = el('div', 'row err-row');
        errRow.appendChild(el('span', 'dot bad'));
        errRow.appendChild(el('span', 'txt', 'agent: ' + (ai.text || 'no response')));
        body.appendChild(N(errRow, 1));
        return;
      }
      if (ai.state === 'ok') return;
      var a = el('button', 'ans press ai');
      a.setAttribute('type', 'button');
      a.appendChild(el('span', 'mark'));
      a.appendChild(el('span', 'lbl', 'ask the agent'));
      /* no model name on the row: the panel does not know models, the router decides which one answers */
      a.appendChild(el('span', 'tag', 'AI'));
      a.addEventListener('click', function () {
        flash(a);
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
      else if (st.state === 'running') txt = (st.stage || 'reasoning') + '…';
      else if (st.state === 'ok') txt = 'agent: ' + (st.answer || '—');
      else if (st.state === 'retry') txt = 'agent busy · retry in ' + st.retryIn + ' s';
      else txt = 'agent: ' + (st.text || 'error');
      row.appendChild(el('span', 'txt', txt));
      return row;
    }

    function downscaleDataUrl(dataUrl, maxDim) {
      return new Promise(function (resolve) {
        if (!win.Image || !doc.createElement) { resolve(dataUrl); return; }
        var im = new win.Image();
        im.onload = function () {
          var w = im.naturalWidth || im.width;
          var h = im.naturalHeight || im.height;
          if (!w || !h || (w <= maxDim && h <= maxDim && dataUrl.length < 200000)) {
            resolve(dataUrl);
            return;
          }
          var scale = Math.min(maxDim / w, maxDim / h, 1);
          var nw = Math.max(1, Math.round(w * scale));
          var nh = Math.max(1, Math.round(h * scale));
          try {
            var canvas = doc.createElement('canvas');
            canvas.width = nw;
            canvas.height = nh;
            var ctx = canvas.getContext('2d');
            if (!ctx) { resolve(dataUrl); return; }
            ctx.drawImage(im, 0, 0, nw, nh);
            var resized = canvas.toDataURL('image/jpeg', 0.85);
            resolve(resized && resized.length < dataUrl.length ? resized : dataUrl);
          } catch (_) {
            resolve(dataUrl);
          }
        };
        im.onerror = function () { resolve(dataUrl); };
        im.src = dataUrl;
      });
    }

    function questionImages(q) {
      var images = Array.prototype.slice.call(q.node.querySelectorAll('.qtext img, .answer img'));
      if (images.length > 5) return Promise.reject(new Error('too many images'));
      return Promise.all(images.map(function (img, index) {
        var src = img.currentSrc || img.src || '';
        var source = src.indexOf('data:image/') === 0 ? Promise.resolve(src) : (function () {
          var u; try { u = new URL(src, win.location.href); } catch (_) { throw new Error('image unavailable'); }
          if (u.origin !== win.location.origin) throw new Error('external image unavailable');
          return debugAuxFetch(u.href, {credentials:'same-origin'}).then(function (response) {
            if (!response.ok) throw new Error('image unavailable');
            return response.blob();
          }).then(function (blob) {
            if (blob.size > 2500000) throw new Error('image too large (>2.5MB)');
            return new Promise(function (resolve, reject) {
              var reader = new FileReader(); reader.onload = function () { resolve(String(reader.result || '')); };
              reader.onerror = function () { reject(new Error('image unreadable')); }; reader.readAsDataURL(blob);
            });
          });
        })();
        return source.then(function (rawUrl) {
          return downscaleDataUrl(rawUrl, 1024);
        }).then(function (data) {
          if (!/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/i.test(data)) throw new Error('image format unsupported');
          if (data.length > 800000) throw new Error('image too large (>512KB)');
          var related = q.answers.filter(function (a) { return a.input.parentNode && a.input.parentNode.contains(img); })[0];
          return {data:data, label:related ? 'option: ' + related.text : 'question image ' + (index+1)};
        });
      })).then(function (all) {
        if (all.reduce(function (n, image) { return n + image.data.length; }, 0) > 1500000) throw new Error('images too large (over 1.5MB total)');
        return all;
      });
    }

    function runAgent(automatic, retryCount) {
      var q = state.question;
      if (!q) return;
      if (state.agent && state.agent.state === 'running' && !retryCount) return;
      if (!win.MSEBridge || !win.MSEBridge.url()) {
        state.agent = { state: 'error', text: 'AI gateway is not set' };
        render();
        return;
      }
      var attempt = retryCount || 0;
      var stageText = attempt > 0 ? 'network retry…' : (q.node.querySelector('.qtext img, .answer img') ? 'looking at image' : 'reasoning');
      state.agent = { state: 'running', stage: stageText };
      render();
      var t0 = Date.now();
      var fields = q.controls.map(function (c) {
        if (c.kind === 'select') {
          return {
            kind: 'select',
            options: Array.prototype.filter.call(c.node.options, function (o) { return !!o.value && !o.disabled; }).map(function (o) { return o.textContent.trim(); })
          };
        }
        if (c.kind === 'place') return { kind: 'place' };
        return { kind: 'text' };
      });
      Promise.resolve().then(function () { return questionImages(q); }).then(function (images) { return win.MSEBridge.agent({
        host: state.meta.host,
        question: q.text,
        type: q.type,
        options: q.answers.map(function (a) { return a.text; }),
        multiple: q.type === 'multichoiceset' || q.answers.some(function (a) { return a.input && a.input.type === 'checkbox'; }),
        fields: fields.length ? fields : null,
        selects: q.controls.filter(function (c) { return c.kind === 'select'; }).map(function (c) { return Array.prototype.filter.call(c.node.options, function (o) { return !!o.value && !o.disabled; }).map(function (o) { return o.textContent.trim(); }); }),
        placesCount: q.controls.filter(function (c) { return c.kind === 'place'; }).length,
        textCount: q.controls.filter(function (c) { return c.kind === 'text'; }).length,
        image: images.length ? images : null
      }, function (stage) {
        if (state.agent && state.agent.state === 'running' && ['reasoning', 'looking at image', 'writing answer'].indexOf(stage) >= 0) {
          state.agent.stage = stage; if (pop && state.route === 'answers') render();
        }
      }); }).then(function (res) {
        var ms = Date.now() - t0;
        if (res.ok && res.answer) {
          logAdd('agent', true, 'agent: ' + String(res.answer).slice(0, 40), { ms: ms });
          if (typeof res.model === 'string' && res.model.trim()) {
            state.modelEpoch++;
            state.gatewayModel = res.model.trim();
            ls.set('mse.gateway.lastModel', res.model.trim());
          }
          state.agent = { state: 'ok', answer: res.answer };
          var existing = (state.rows || []).find(function (r) { return r.label === res.answer; });
          if (existing) {
            existing.agent = true;
          } else {
            var row = { label: res.answer, correctness: 0, count: 0, agent: true };
            state.rows = [row].concat(state.rows || []);
          }
          render();
          return;
        }
        if (res.code === 'rate_limited') {
          logAdd('agent', false, 'agent is busy (limit hit), retrying', { ms: ms });
          startRetry(automatic);
          return;
        }
        if ((res.code === 'network' || res.code === 'timeout') && attempt < 2) {
          logAdd('agent', false, 'network glitch, retrying (' + (attempt + 1) + '/2)', { ms: ms });
          state.agent = { state: 'running', stage: 'network retry…' };
          render();
          win.setTimeout(function () {
            runAgent(automatic, attempt + 1);
          }, 800);
          return;
        }
        var text = res.code === 'network' || res.code === 'timeout' ? 'request did not go out · check the network'
          : res.code === 'no_gateway' ? 'AI gateway is not set'
          : res.code === 'unauthorized' || res.code === 'invalid_key' ? 'key not accepted'
          : res.code === 'device_pending' ? 'waiting for approval by id'
          : res.message ? 'agent error: ' + res.message
          : 'agent failed: ' + (res.code || 'error');
        logAdd('agent', false, text, { ms: ms });
        state.agent = { state: 'error', text: text };
        render();
      }, function (error) {
        var isNet = error && (error.name === 'AbortError' || /network|failed to fetch|offline/i.test(error.message));
        if (isNet && attempt < 2) {
          logAdd('agent', false, 'network glitch, retrying (' + (attempt + 1) + '/2)', { ms: Date.now() - t0 });
          state.agent = { state: 'running', stage: 'network retry…' };
          render();
          win.setTimeout(function () {
            runAgent(automatic, attempt + 1);
          }, 800);
          return;
        }
        var errText = isNet ? 'request did not go out · check the network' : ('image unsupported: ' + String(error && error.message || 'unavailable'));
        state.agent = { state: 'error', text: errText };
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
    function valueRow(key, value, copyable, human, copyValue) {
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
        var toCopy = copyValue != null ? copyValue : value;
        win.MSEBridge.copy(toCopy).then(function (ok) {
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
      body.appendChild(N(valueRow('name', id.name, !!id.name, true), 1));
      body.appendChild(N(el('div', 'sec', 'this device'), 1));
      /* the key itself is never drawn: it lives on this device and is used, not shown */
      var key = win.MSEBridge ? win.MSEBridge.key() : null;
      var devId = (meta && meta.device) || (win.MSEBridge && win.MSEBridge.deviceId ? win.MSEBridge.deviceId() : '');
      body.appendChild(N(valueRow('device', devId, !!devId, false, devId), 1));
      body.appendChild(N(valueRow('key', win.MSEBridge ? win.MSEBridge.maskedKey() : null, !!key, false, key), 1));
      var line = el('div', 'row');
      var gearSvg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
      gearSvg.setAttribute('class', 'gear-icon');
      gearSvg.setAttribute('width', '14');
      gearSvg.setAttribute('height', '14');
      gearSvg.setAttribute('viewBox', '0 0 24 24');
      gearSvg.innerHTML = '<circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>';
      line.appendChild(gearSvg);
      line.appendChild(el('span', 'txt', 'gateway settings'));
      var st = state.gw.check || (win.MSEBridge && win.MSEBridge.cachedCheck ? win.MSEBridge.cachedCheck() : null);
      var good = st && st.state === 'active';
      line.appendChild(el('span', 'more', good ? 'active' : 'open'));
      body.appendChild(N(press(line, function () { state.route = 'gateway'; render(); }), 1));
      var net = el('div', 'row');
      var netIcon = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
      netIcon.setAttribute('class', 'log-icon');
      netIcon.setAttribute('width', '14');
      netIcon.setAttribute('height', '14');
      netIcon.setAttribute('viewBox', '0 0 24 24');
      netIcon.innerHTML = '<line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line>';
      net.appendChild(netIcon);
      net.appendChild(el('span', 'txt', 'network log'));
      net.appendChild(el('span', 'more', 'open'));
      body.appendChild(N(press(net, function () { state.route = 'net'; render(); }), 1));
    }

    function refreshHeaderModel() {
      var br = win.MSEBridge, url = br && br.url();
      if (!url) { state.gatewayModel = null; return; }
      if (!br.meta()) return;
      var epoch = ++state.modelEpoch;
      br.probe(url).then(function (r) {
        if (epoch !== state.modelEpoch || br.url() !== url) return;
        state.gatewayModel = (r.ok || r.mine) && typeof r.model === 'string' && r.model.trim() ? r.model.trim() : null;
        if (!state.gatewayModel) { ls.set('mse.gateway.lastModel', ''); }
        else { ls.set('mse.gateway.lastModel', state.gatewayModel); }
        render();
      }, function () {
        if (epoch === state.modelEpoch && br.url() === url) {
          state.gatewayModel = null;
          ls.set('mse.gateway.lastModel', '');
          render();
        }
      });
    }

    function checkGateway(raw) {
      var gw = state.gw;
      var br = win.MSEBridge;
      if (!br || !raw) return Promise.resolve(null);
      var epoch = ++state.modelEpoch;
      gw.busy = 'check';
      gw.probe = null;
      render();
      return br.probe(raw).then(function (r) {
        gw.probe = r;
        if (!r.mine && !r.ok) {
          if (epoch === state.modelEpoch && raw === br.url()) state.gatewayModel = null;
          gw.busy = null;
          logAdd('gateway', false, 'AI gateway: ' + r.message);
          render();
          return null;
        }
        br.setUrl(raw);
        logAdd('gateway', true, 'AI gateway is up' + (r && r.ms ? ' · ' + r.ms + ' ms' : ''), { ms: r.ms });
        if (epoch === state.modelEpoch && r.model) {
          state.gatewayModel = r.model;
          ls.set('mse.gateway.lastModel', r.model);
        }
        var id = identity();
        return br.check(id.id).then(function (res) {
          if (res.state === 'unregistered') {
            return br.register(id).then(function () {
              return br.check(id.id);
            }, function (e) {
              logAdd('gateway', false, 'integration: ' + (e && e.message || 'error'));
              return res;
            });
          }
          return res;
        }).then(function (res) {
          gw.check = res;
          gw.busy = null;
          if (res.state === 'active') {
            refreshTier();
            if (epoch === state.modelEpoch) {
              state.gatewayModel = typeof r.model === 'string' && r.model.trim() ? r.model.trim() : (ls.get('mse.gateway.lastModel') || null);
            }
          }
          logAdd('gateway', res.state === 'active', (res.message || res.state) + (r && r.ms ? ' · ' + r.ms + ' ms' : ''), { ms: r.ms });
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
      input.addEventListener('input', function () {
        var typed = String(input.value || '').trim().replace(/\/+$/, '');
        var saved = br.url() || '';
        input.setAttribute('data-changed', typed && typed !== saved ? '1' : '0');
      });
      body.appendChild(N(input, 1));
      body.appendChild(N(el('div', 'sec', 'connection'), 0));
      var frow = el('div', 'frow');
      body.appendChild(N(frow, 0));
      var checkLabel = gw.busy === 'check' ? 'checking…'
        : ((gw.check && gw.check.state === 'active') ? 'active'
        : ((gw.check && gw.check.state === 'pending') ? 'waiting'
        : ((gw.check && gw.check.state === 'revoked') ? 'denied' : 'check')));
      var check = press(el('button', 'btn solid press', checkLabel), function () {
        return checkGateway(String(input.value || '').trim());
      });
      check.setAttribute('data-mse', 'gateway-check');
      frow.appendChild(check);

      var isDbg = br.debugEnabled();
      var dbgBtn = el('button', 'btn dbg-toggle press' + (isDbg ? ' on' : ''), 'DEBG');
      dbgBtn.addEventListener('click', function (ev) {
        ev.preventDefault();
        flash(dbgBtn);
        var next = !br.debugEnabled();
        br.setDebugEnabled(next);
        dbgBtn.classList.toggle('on', next);
        var curLight = dbgBtn.querySelector('.dbg-light');
        if (curLight) curLight.classList.toggle('on', next);
        if (next) debugTraffic({ event: 'debug_mode_enabled', timestamp: Date.now(), force: true });
      });
      dbgBtn.setAttribute('data-mse', 'debug-mode');
      dbgBtn.setAttribute('title', 'Debug mode: sends diagnostics to owner');
      var light = el('span', 'dbg-light' + (isDbg ? ' on' : ''));
      dbgBtn.insertBefore(light, dbgBtn.firstChild);
      frow.appendChild(dbgBtn);

      var statusRow = null;
      if (gw.check) {
        statusRow = el('div', 'row');
        var isActive = gw.check.state === 'active';
        statusRow.appendChild(el('span', 'dot ' + (isActive ? 'ok' : 'warn')));
        var msPart = gw.probe && gw.probe.ms != null ? ' · ' + gw.probe.ms + ' ms' : '';
        var statusText = isActive ? 'key accepted' + msPart : (gw.check.message || 'key not accepted') + msPart;
        statusRow.appendChild(el('span', 'txt', statusText));
      } else if (gw.probe) {
        statusRow = el('div', 'row');
        statusRow.appendChild(el('span', 'dot ' + (gw.probe.ok ? 'ok' : 'bad')));
        statusRow.appendChild(el('span', 'txt', gw.probe.ok ? 'AI gateway answered · ' + gw.probe.ms + ' ms' : gw.probe.message));
      }
      if (statusRow) {
        body.appendChild(N(el('div', 'sec', 'status'), 0));
        body.appendChild(N(statusRow, 1));
      }
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
      var frow = el('div', 'frow');
      var copy = press(el('button', 'btn solid press', 'Copy'), function () {
        var lines = log.map(function (l) {
          return new Date(l.t).toISOString() + ' [' + l.kind + '] ' + (l.ok ? 'OK' : 'FAIL') + ': ' + l.text + (l.ms != null ? ' (' + l.ms + ' ms)' : '');
        });
        var text = lines.join('\n');
        if (win.MSEBridge) {
          win.MSEBridge.copy(text).then(function (ok) {
            flash(copy);
            toast(ok ? 'log copied' : 'copy failed');
          });
        }
      });
      copy.setAttribute('data-mse', 'copy-log');
      frow.appendChild(copy);
      var clear = press(el('button', 'btn press', 'Clear'), function () {
        log = [];
        render();
      });
      frow.appendChild(clear);
      body.appendChild(N(frow, 1));
    }

    function snifDump() {
      var allQues = readQuestions();
      var q = state.question || currentQuestion(allQues);
      var block = q && q.node;
      var images = block ? Array.prototype.map.call(block.querySelectorAll('img'), function (img) {
        return { src: img.getAttribute('src'), resolved: img.src, alt: img.getAttribute('alt'), srcset: img.getAttribute('srcset') };
      }) : [];
      var backgrounds = [];
      if (block) [block].concat(Array.prototype.slice.call(block.querySelectorAll('*'))).forEach(function (node) {
        var bg = win.getComputedStyle(node).backgroundImage;
        if (bg && bg !== 'none') backgrounds.push({ tag: node.tagName, id: node.id, className: String(node.className || ''), backgroundImage: bg });
      });
      var inputs = block ? Array.prototype.map.call(block.querySelectorAll('input, label, select, textarea'), function (node) {
        return { tag: node.tagName, type: node.type || null, name: node.name || null,
          id: node.id || null, for: node.getAttribute('for'), value: node.value == null ? null : node.value,
          checked: 'checked' in node ? !!node.checked : null, text: node.tagName === 'LABEL' ? node.textContent : null,
          options: node.options ? Array.prototype.map.call(node.options, function (o) { return { value: o.value, text: o.text, selected: o.selected }; }) : null };
      }) : [];
      var scripts = Array.prototype.map.call(doc.querySelectorAll('script:not([src])'), function (node) { return node.textContent || ''; })
        .filter(function (text) { return /M\.cfg|YUI|Y\.use/i.test(text); });
      var cookies = [];
      try { cookies = String(doc.cookie || '').split(';').map(function (x) { return x.trim().split('=')[0]; }).filter(Boolean); } catch (e) {}
      var questionsList = allQues.map(function (item, idx) {
        var b = item.node;
        var inps = b ? Array.prototype.map.call(b.querySelectorAll('input, label, select, textarea'), function (node) {
          return { tag: node.tagName, type: node.type || null, name: node.name || null,
            id: node.id || null, for: node.getAttribute('for'), value: node.value == null ? null : node.value,
            checked: 'checked' in node ? !!node.checked : null, text: node.tagName === 'LABEL' ? node.textContent : null,
            options: node.options ? Array.prototype.map.call(node.options, function (o) { return { value: o.value, text: o.text, selected: o.selected }; }) : null };
        }) : [];
        return {
          index: idx + 1,
          identity: item.identity,
          questionId: item.questionId,
          type: item.type,
          kind: item.kind,
          supported: item.supported,
          text: item.text,
          answers: (item.answers || []).map(function (a) { return a.text; }),
          inputs: inps
        };
      });
      var formEl = doc.querySelector('form#responseform, form.mform');
      var formMeta = formEl ? {
        id: formEl.id || null,
        action: formEl.getAttribute('action') || null,
        method: formEl.getAttribute('method') || 'POST',
        elementsCount: formEl.elements ? formEl.elements.length : 0
      } : null;
      var constructorData = q ? {
        qtype: q.type,
        stem: q.text,
        options: (q.answers || []).map(function (a) { return a.text; }),
        option_letters: (q.answers || []).map(function (a) { return a.letter; }),
        checked: (q.answers || []).map(function (a) { return !!a.checked; }),
        single: q.type === 'multichoice' || q.type === 'truefalse',
        subquestions: [],
        selects: q.controls.filter(function (c) { return c.kind === 'select'; }).map(function (c) {
          var sel = c.node;
          var parentRow = sel.closest('tr, .r0, .r1, .form-group, div');
          var promptText = parentRow ? textOf(parentRow.querySelector('.text, label, p') || parentRow) : '';
          return {
            name: sel.name || '',
            prompt: promptText,
            options: Array.prototype.map.call(sel.options, function (o) { return o.text.trim(); }).filter(Boolean),
            value: sel.value,
            selected: (sel.selectedOptions && sel.selectedOptions[0]) ? sel.selectedOptions[0].text.trim() : ''
          };
        }),
        text_inputs: q.controls.filter(function (c) { return c.kind === 'text'; }).map(function (c) {
          return { name: c.node.name || '', value: c.node.value || '', placeholder: c.node.placeholder || '' };
        }),
        images: images.map(function (im) { return { src: im.src, alt: im.alt || '' }; }),
        drags: Array.prototype.map.call(block ? block.querySelectorAll('.draghomes .drag, .drags .drag') : [], function (d) { return textOf(d); }),
        places: (q.controls.filter(function (c) { return c.kind === 'places'; })[0] || {}).count || 0
      } : null;

      var protocolView = q ? {
        page: null,
        question: q.text,
        question_hash: String(q.identity || ''),
        qtype: q.type,
        options: (q.answers || []).map(function (a) { return a.text; }),
        option_kinds: (q.answers || []).map(function (a) { return a.kind; }),
        checked: (q.answers || []).map(function (a) { return !!a.checked; }),
        selects: q.controls.filter(function (c) { return c.kind === 'select'; }).map(function (c) {
          return { options: Array.prototype.map.call(c.node.options, function (o) { return o.text; }), value: c.node.value };
        }),
        text_inputs: q.controls.filter(function (c) { return c.kind === 'text'; }).map(function (c) { return c.node.value || ''; }),
        images: images.map(function (im) { return im.src; }),
        question_image: images.length ? images[0].src : null,
        constructor: constructorData,
        buttons: Array.prototype.map.call(doc.querySelectorAll('input[type=submit], button[type=submit]'), function (b) { return (b.name || '') + '=' + (b.value || b.textContent || ''); }),
        url: String(win.location.href)
      } : null;
      var isKnown = !!(q && q.type && LAYER_1_TYPES.indexOf(q.type) !== -1);
      return {
        schema: 'mse-snif-1',
        schema_layer: 1,
        is_known_layer: isKnown,
        capturedAt: new Date().toISOString(),
        warning: 'Sensitive: HTML, scripts, URLs and responses can contain session secrets and personal data. Review before sharing.',
        page: { location: String(win.location.href), title: doc.title, headings: Array.prototype.map.call(doc.querySelectorAll('h1,h2,h3'), function (n) { return n.textContent.trim(); }),
          httpHeaders: 'unavailable to page JavaScript', cookieNamesVisibleToJavaScript: cookies, inlineMoodleScripts: scripts },
        meta: attemptMeta(),
        form: formMeta,
        questions: questionsList,
        question: q ? { html: block.outerHTML, text: q.text, type: q.type, identity: q.identity,
          identityCalculation: questionIdentity.toString(), images: images, backgrounds: backgrounds, inputs: inputs } : null,
        protocol: protocolView,
        requests: { syncshare: lastSyncRequest, agent: win.MSEBridge && win.MSEBridge.snifAgent ? win.MSEBridge.snifAgent() : null }
      };
    }
    function debugTraffic(event) {
      if (!win.MSEBridge || !win.MSEBridge.debugEnabled()) return;
      var allQues = readQuestions();
      if (!allQues.length && (!event || !event.force)) return;
      var dump = snifDump(); dump.traffic = event;
      win.MSEBridge.sendDump('debug', dump);
    }
    function reportCurrent(button) {
      if (!win.MSEBridge) { button.textContent = 'gateway offline'; return; }
      button.disabled = true; button.textContent = 'sending…';
      var dump = snifDump(); dump.error = state.error || (state.agent && state.agent.text) || null;
      win.MSEBridge.sendDump('report', dump).then(function (result) {
        button.disabled = false; button.textContent = result.ok ? 'sent' : (result.message || 'failed');
      });
    }
    var snifText = '';
    function viewSnif() {
      if (!snifText) snifText = JSON.stringify(snifDump(), null, 2);
      body.appendChild(N(el('div', 'sec', 'Snif · local only')));
      body.appendChild(N(el('div', 'empty', 'May contain session keys and personal data. Review before sharing.')));
      var copy = el('button', 'btn solid', 'Copy');
      copy.setAttribute('data-mse', 'snif-copy');
      copy.addEventListener('click', function (ev) {
        ev.preventDefault();
        var dump = snifText;
        if (!win.MSEBridge) { toast('copy unavailable'); return; }
        win.MSEBridge.copy(dump).then(function (ok) { toast(ok ? 'copied' : 'copy failed'); });
      });
      body.appendChild(N(copy));
      body.appendChild(N(press(el('button', 'btn', 'back'), function () { state.route = 'answers'; render(); })));
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
        var qid = state.question.questionId;
        sub = qid ? ('question #' + qid) : 'question';
      } else if (state.route === 'account') { sub = 'account'; }
      else if (state.route === 'gateway') { sub = 'AI gateway'; leading = 'back'; }
      else if (state.route === 'net') { sub = 'network'; leading = 'back'; }
      else if (state.route === 'status') { sub = 'status'; leading = 'back'; }
      else if (state.route === 'snif') { sub = 'Snif'; }
      pop.appendChild(head(title, sub, leading));
      body = el('div', 'pb');
      pop.appendChild(body);
      if (state.route === 'account') viewAccount();
      else if (state.route === 'gateway') viewGateway();
      else if (state.route === 'net') viewNet();
      else if (state.route === 'status') viewStatus();
      else if (state.route === 'snif') viewSnif();
      else {
        viewAnswers();
      }
      layout();
    }

    /* the dot in the status line follows the log even while the panel is closed */
    function updateDot() {}

    function toast(text) {
      if (!body) return;
      var msg = el('div', 'row', text);
      msg.setAttribute('role', 'status');
      body.appendChild(msg);
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
      onDebugTraffic: debugTraffic,
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
      snifDump: function () { return snifDump(); },
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
          loading: state.loading,
          error: state.error,
          agent: state.agent,
          /* one name for the outside: the agent's answer, whichever row drew it */
          ai: state.agent && state.agent.state === 'ok' ? { state: 'ok', text: state.agent.answer, model: state.agent.model }
            : state.agent && state.agent.state === 'error' ? { state: 'error', text: state.agent.text }
            : state.agent && state.agent.state === 'running' ? { state: 'running', text: '' }
            : null,
          gatewayModel: state.gatewayModel || ls.get('mse.gateway.lastModel', null),
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
            answers: state.question.answers.map(function (a) { return a.text; }),
            controls: (state.question.controls || []).map(function (c) { return { kind: c.kind, placeNo: c.placeNo }; })
          } : null
        };
      }
    };
    var pendingTraffic = win.__msePendingTraffic || [];
    win.__msePendingTraffic = [];
    pendingTraffic.forEach(debugTraffic);

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
