'use strict';
/* The same sequence of user actions, performed on a page no matter who put the widgets there
   (original extension or userscript). Works through CDP, so closed shadow roots are not a problem. */
const D = require('./cdp-dom.js');

const isMagic = (n, a, ctx) => n.nodeName === 'SPAN' && D.hasClass(a, 'icon') && !D.hasClass(a, 'prefix') && !D.hasClass(a, 'suffix') && ctx.host && ctx.host.nodeName !== 'BODY';

/** Waits until the extension has stopped changing what it drew (content, not only the number of widgets). */
async function waitForWidgets(page, min = 1, timeout = 20000) {
  const t0 = Date.now(); let last = ''; let n = 0; let stableSince = Date.now();
  for (;;) {
    const w = await D.shadowWidgets(page);
    const now = JSON.stringify(w); n = w.length;
    if (now !== last) { last = now; stableSince = Date.now(); }
    if (n >= min && Date.now() - stableSince > 1500) return n;
    if (Date.now() - t0 > timeout) return n;
    await page.waitForTimeout(250);
  }
}
async function visibleMenu(page) {
  const menus = await D.contextMenus(page);
  return menus.filter((m) => !m.hidden);
}
async function openMagicMenu(page, que, index = 0) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await D.clickInShadow(page, isMagic, { que, index });
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(150);
      const m = await visibleMenu(page);
      if (m.length) return m;
    }
  }
  return [];
}
async function closeMenu(page) {
  /* the menu hides itself when the page is scrolled */
  await page.evaluate(() => { window.dispatchEvent(new Event('scroll')); });
  for (let i = 0; i < 10; i++) { if (!(await visibleMenu(page)).length) return; await page.waitForTimeout(100); }
  throw new Error('menu did not close');
}
const labelIs = (label) => (n, a) => n.nodeName === 'LI' && D.hasClass(a, 'menu-item') && D.textOf({ children: (n.children || []).filter((k) => !(k.nodeType === 1 && D.hasClass(D.attrsOf(k), 'sub-menu'))) }).replace(/\s+/g, ' ').trim() === label;
/** Walks the menu: point at each label in turn (sub-menus open on :hover); the last one is clicked. */
async function chooseInMenu(page, labels) {
  for (let i = 0; i < labels.length; i++) {
    const last = i === labels.length - 1;
    let done = false;
    for (let attempt = 0; attempt < 12 && !done; attempt++) {
      const { cdp, found } = await D.findInShadow(page, labelIs(labels[i]));
      /* several menus may contain the same label: take the one that is actually laid out */
      for (const f of found) {
        const c = await D.centerOf(cdp, f.backendNodeId, { noScroll: true }).catch(() => null);
        if (!c || c.width === 0 || c.height === 0) continue;
        await page.mouse.move(c.x - 3, c.y - 1);
        await page.mouse.move(c.x, c.y, { steps: 3 });
        await page.waitForTimeout(150);
        if (last) await page.mouse.click(c.x, c.y);
        done = true; break;
      }
      await cdp.detach();
      if (!done) await page.waitForTimeout(150);
    }
    if (!done) throw new Error('menu item not visible: ' + labels.slice(0, i + 1).join(' > '));
  }
  await page.waitForTimeout(250);
}
/** State of the quiz form as the user (and Moodle) would see it. */
async function formState(page) {
  return page.evaluate(() => {
    const out = {};
    for (const q of document.querySelectorAll('.que')) {
      const s = {};
      q.querySelectorAll('input[type=radio], input[type=checkbox]').forEach((i) => { if (i.checked) s[i.name] = (s[i.name] ? s[i.name] + ',' : '') + i.value; });
      q.querySelectorAll('input[type=text], textarea').forEach((i) => { if (i.value) s[i.name] = i.value; });
      q.querySelectorAll('select').forEach((i) => { if (i.selectedIndex > 0) s[i.name] = i.options[i.selectedIndex].text; });
      out[q.id] = s;
    }
    return out;
  });
}
/** Requests in a comparable form: method, path, sorted query, JSON body. */
function normalizeApi(log, opts = {}) {
  return log.map((r) => {
    const u = new URL('https://syncshare.ru' + r.path);
    const q = [...u.searchParams.entries()].sort((a, b) => (a[0] + a[1] < b[0] + b[1] ? -1 : 1)).map((e) => e.join('=')).join('&');
    let body = r.json === undefined ? r.body : r.json;
    if (opts.mapBody) body = opts.mapBody(u.pathname, body);
    return { req: r.method + ' ' + u.pathname + (q ? '?' + q : ''), body: body === null || body === undefined ? null : body, apiKey: r.headers['x-api-key'] || r.headers['X-Api-Key'] || null };
  });
}
const sortApi = (list) => list.slice().sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));

module.exports = { isMagic, waitForWidgets, visibleMenu, openMagicMenu, closeMenu, chooseInMenu, formState, normalizeApi, sortApi, D };
