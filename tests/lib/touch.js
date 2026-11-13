'use strict';
/* What a person with a phone does and sees (WebKit, touch). Needs harness option openShadow. */
const overlay = (page) => page.frames().find((f) => f !== page.mainFrame());
async function waitOverlay(page, timeout = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { const f = overlay(page); if (f) { await f.waitForLoadState('domcontentloaded').catch(() => {}); return f; } await page.waitForTimeout(100); }
  return null;
}
async function waitNoOverlay(page, timeout = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { if (!overlay(page)) return true; await page.waitForTimeout(100); }
  return false;
}
/** widgets drawn by the script, per question */
const widgets = (page) => page.evaluate(() => (window.__roots || []).filter((h) => h.isConnected && h !== document.body && h.shadowRoot && h.shadowRoot.querySelector('span.icon')).map((h) => { const q = h.closest('.que'); return { que: q ? q.id : null, type: q ? q.className.split(/\s+/)[1] : null, host: h.tagName.toLowerCase() }; }));
async function waitWidgets(page, min = 1, timeout = 15000) {
  const t0 = Date.now(); let w = [];
  while (Date.now() - t0 < timeout) { w = await widgets(page); if (w.length >= min) { await page.waitForTimeout(1200); return widgets(page); } await page.waitForTimeout(200); }
  return w;
}
const magic = (page, que, index = 0) => page.locator('#' + que + ' span.icon:not(.prefix)').nth(index);
/** the open menu as nested labels, or null */
const menu = (page) => page.evaluate(() => {
  const root = document.body.shadowRoot; if (!root) return null;
  const m = [...root.querySelectorAll('ul.syncshare-cm')].find((x) => !x.hidden); if (!m) return null;
  const item = (li) => { const o = { label: [...li.children].filter((c) => !c.classList.contains('sub-menu')).map((c) => c.textContent).join(' ').replace(/\s+/g, ' ').trim() }; const sub = li.querySelector(':scope > ul.sub-menu'); if (sub) o.items = [...sub.children].map(item); return o; };
  const r = m.getBoundingClientRect();
  return { items: [...m.children].map(item), box: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }, viewport: { w: innerWidth, h: innerHeight } };
});
async function tapMagic(page, que, index = 0) {
  const b = magic(page, que, index);
  /* keep the button in the upper part of the screen so that the menu fits below it */
  await b.evaluate((e) => { const r = e.getBoundingClientRect(); window.scrollBy({ top: r.top - innerHeight * 0.3, behavior: 'instant' }); });
  for (let i = 0, last = -1; i < 20; i++) { const y = await page.evaluate(() => scrollY); if (y === last) break; last = y; await page.waitForTimeout(150); }
  await page.waitForTimeout(150);
  await b.tap();
  for (let i = 0; i < 20; i++) { const m = await menu(page); if (m) return m; await page.waitForTimeout(100); }
  return null;
}
/** Chooses an item of an open menu the way a mouse user does: hover over the parents, click the last item. */
async function choosePath(page, labels) {
  let scope = page.locator('ul.syncshare-cm:not([hidden])');
  for (let i = 0; i < labels.length; i++) {
    const li = scope.locator(':scope > li.menu-item').filter({ has: page.locator(':scope > .item-label', { hasText: new RegExp('^\\s*' + labels[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$') }) }).first();
    const target = li.locator(':scope > .item-label');
    await target.hover();
    await page.waitForTimeout(200);
    if (i === labels.length - 1) await target.click();
    scope = li.locator(':scope > ul.sub-menu');
  }
  await page.waitForTimeout(300);
}
/** taps the items of the open menu one after another (a tap on a parent item opens its sub-menu) */
async function tapPath(page, labels) {
  let scope = page.locator('ul.syncshare-cm:not([hidden])');
  for (const label of labels) {
    const li = scope.locator(':scope > li.menu-item').filter({ has: page.locator(':scope > .item-label', { hasText: new RegExp('^\\s*' + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$') }) }).first();
    await li.locator(':scope > .item-label').tap();
    await page.waitForTimeout(350);
    scope = li.locator(':scope > ul.sub-menu');
  }
}
const formState = (page) => page.evaluate(() => {
  const out = {};
  for (const q of document.querySelectorAll('.que')) {
    const s = {};
    q.querySelectorAll('input[type=radio], input[type=checkbox]').forEach((i) => { if (i.checked) s[i.name] = i.value; });
    q.querySelectorAll('input[type=text], textarea').forEach((i) => { if (i.value) s[i.name] = i.value; });
    q.querySelectorAll('select').forEach((i) => { if (i.selectedIndex > 0) s[i.name] = i.options[i.selectedIndex].text; });
    out[q.id] = s;
  }
  return out;
});
module.exports = { overlay, waitOverlay, waitNoOverlay, widgets, waitWidgets, magic, menu, tapMagic, tapPath, choosePath, formState };
