'use strict';
/* Reads and clicks things inside CLOSED shadow roots through the DevTools protocol (Chromium only).
   Used to compare what the original extension and the userscript draw on the page. */

async function tree(page) {
  const cdp = await page.context().newCDPSession(page);
  const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
  return { cdp, root };
}
/* the toast library of the original gives every toast a random id */
const RANDOM_ID = /eggy-[a-z0-9]{4}\b/g;
const attrsOf = (n) => { const o = {}; const a = n.attributes || []; for (let i = 0; i < a.length; i += 2) o[a[i]] = a[i + 1]; return o; };
function walk(node, fn, ctx = { que: null, inShadow: false, host: null }) {
  let c = ctx;
  if (node.nodeType === 1) {
    const a = attrsOf(node);
    if (/(^|\s)que(\s|$)/.test(a.class || '') && a.id) c = Object.assign({}, c, { que: a.id });
  }
  fn(node, c);
  for (const sr of node.shadowRoots || []) walk(sr, fn, Object.assign({}, c, { inShadow: true, host: node }));
  for (const ch of node.children || []) walk(ch, fn, c);
  if (node.contentDocument) { /* frames are not part of the comparison */ }
}
function serialize(node) {
  if (node.nodeType === 3) return node.nodeValue.replace(/\s+/g, ' ');
  if (node.nodeType === 8) return '';
  if (node.nodeType === 11) return (node.children || []).map(serialize).join('');
  if (node.nodeType !== 1) return '';
  const name = node.nodeName.toLowerCase();
  const a = attrsOf(node);
  if (name === 'style') {
    /* the only allowed difference: the address of the extension itself */
    const css = (node.children || []).map((c) => c.nodeValue || '').join('').replace(/(chrome-extension|moz-extension|safari-web-extension):\/\/[^\/"')\s]+\//g, 'EXT/').replace(RANDOM_ID, 'eggy-ID');
    return '<style len=' + css.length + ' sha=' + require('crypto').createHash('sha256').update(css).digest('hex').slice(0, 16) + '/>';
  }
  if (name === 'svg') return '<svg viewBox="' + (a.viewBox || '') + '" paths=' + JSON.stringify((node.children || []).filter((c) => c.nodeName.toLowerCase() === 'path').map((c) => (attrsOf(c).d || '').slice(0, 24))) + '/>';
  const attrs = Object.keys(a).sort().map((k) => ' ' + k + '="' + a[k].replace(/\s+/g, ' ').trim().replace(RANDOM_ID, 'eggy-ID') + '"').join('');
  return '<' + name + attrs + '>' + (node.children || []).map(serialize).join('') + '</' + name + '>';
}
const describeHost = (n) => { const a = attrsOf(n); return n.nodeName.toLowerCase() + (a.id && !/^yui_|^single_button|^url_select|^action-menu/.test(a.id) ? '#' + a.id : '') + (a.class ? '.' + a.class.trim().split(/\s+/).slice(0, 3).join('.') : ''); };

/** Everything the extension attached through shadow roots: [{que, host, html}] in document order. */
async function shadowWidgets(page) {
  const { cdp, root } = await tree(page);
  const out = [];
  walk(root, (node, ctx) => {
    for (const sr of node.shadowRoots || []) {
      if (sr.shadowRootType === 'user-agent') continue;
      out.push({ que: ctx.que, host: describeHost(node), mode: sr.shadowRootType, html: serialize(sr) });
    }
  });
  await cdp.detach();
  return out;
}

/** Finds nodes inside author shadow roots. pred(node, attrs, ctx) -> bool */
async function findInShadow(page, pred) {
  const { cdp, root } = await tree(page);
  const found = [];
  walk(root, (node, ctx) => { if (ctx.inShadow && node.nodeType === 1 && pred(node, attrsOf(node), ctx)) found.push({ backendNodeId: node.backendNodeId, que: ctx.que, node }); });
  return { cdp, found };
}
async function centerOf(cdp, backendNodeId, opts = {}) {
  /* (menus must not be scrolled to: the menu closes itself when the page scrolls) */
  if (!opts.noScroll) await cdp.send('DOM.scrollIntoViewIfNeeded', { backendNodeId }).catch(() => {});
  const { quads } = await cdp.send('DOM.getContentQuads', { backendNodeId });
  if (!quads || !quads.length) throw new Error('not rendered');
  const q = quads[0];
  const xs = [q[0], q[2], q[4], q[6]]; const ys = [q[1], q[3], q[5], q[7]];
  return { x: (xs[0] + xs[1] + xs[2] + xs[3]) / 4, y: (ys[0] + ys[1] + ys[2] + ys[3]) / 4, width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}
/** Clicks the first shadow node matching pred (optionally inside question `que`). */
async function clickInShadow(page, pred, opts = {}) {
  const { cdp, found } = await findInShadow(page, pred);
  const list = opts.que ? found.filter((f) => f.que === opts.que) : found;
  const target = list[opts.index || 0];
  if (!target) { await cdp.detach(); throw new Error('no shadow node to click (' + found.length + ' candidates, que=' + opts.que + ')'); }
  let c = await centerOf(cdp, target.backendNodeId);
  /* keep the target in the upper part of the screen, so that what it opens fits below it */
  const vh = await page.evaluate(() => window.innerHeight);
  if (c.y > vh * 0.45 || c.y < 90) {
    await page.evaluate((dy) => window.scrollBy(0, dy), Math.round(c.y - vh * 0.3));
    await page.waitForTimeout(150);
    c = await centerOf(cdp, target.backendNodeId, { noScroll: true });
  }
  await cdp.detach();
  if (opts.hover) await page.mouse.move(c.x, c.y); else await page.mouse.click(c.x, c.y);
  return c;
}
const textOf = (n) => (n.nodeType === 3 ? n.nodeValue : (n.children || []).map(textOf).join(''));
const hasClass = (a, c) => (' ' + (a.class || '') + ' ').includes(' ' + c + ' ');

/** The SyncShare context menu (ul.syncshare-cm) as nested labels; hidden menus are skipped. */
async function contextMenus(page) {
  const { cdp, root } = await tree(page);
  const menus = [];
  const item = (li) => {
    const kids = li.children || [];
    const label = kids.filter((k) => k.nodeType === 1 && !hasClass(attrsOf(k), 'sub-menu')).map(textOf).join('').replace(/\s+/g, ' ').trim();
    const sub = kids.find((k) => k.nodeType === 1 && hasClass(attrsOf(k), 'sub-menu'));
    const o = { label };
    if (sub) o.items = (sub.children || []).filter((k) => k.nodeName === 'LI').map(item);
    return o;
  };
  walk(root, (node, ctx) => {
    if (!ctx.inShadow || node.nodeType !== 1) return;
    const a = attrsOf(node);
    if (hasClass(a, 'syncshare-cm')) menus.push({ hidden: 'hidden' in a, items: (node.children || []).filter((k) => k.nodeName === 'LI').map(item) });
  });
  await cdp.detach();
  return menus;
}

module.exports = { shadowWidgets, findInShadow, clickInShadow, contextMenus, centerOf, attrsOf, hasClass, textOf };
