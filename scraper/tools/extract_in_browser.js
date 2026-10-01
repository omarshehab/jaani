/*
 * JAANI RTI officer page -> JSON (section 12, route S4c).
 * For hosts that refuse automated access: open the officer page normally in your browser, open the DevTools
 * console, paste this whole file and press Enter. It reads ONLY the page you are looking at and downloads
 * <host>.json. It does not fetch anything, click anything or touch any other page.
 * Then: python -m jaani_scraper import-html <folder with the .json files>
 */
(() => {
  const squash = (s) => (s || '').normalize('NFC').replace(/[\s:：\-–—]+/g, '').replace(/[‌‍]/g, '')
    .replace(/আপিল/g, 'আপীল').replace(/দ্বায়িত্ব/g, 'দায়িত্ব').replace(/পদবী/g, 'পদবি').toLowerCase().replace(/[ঃ:]+$/, '');
  const norm = (s) => (s || '').normalize('NFC').replace(/[​⁠﻿­]/g, '').replace(/ /g, ' ')
    .replace(/\s+/g, ' ').trim();
  // Same rules as scraper/config/role_aliases.yaml
  const roleOf = (text) => {
    const t = norm(text);
    if (!t || t.length > 70) return null;
    const s = squash(t);
    if (/কর্মকর্তাগণ|কর্মকর্তাবৃন্দ|officers/.test(s)) return 'container';
    if (/(আপীল|appellate)/.test(s) && /(কর্তৃপক্ষ|authority)/.test(s)) return 'appellate';
    if (/(বিকল্প|alternat)/.test(s) && /(দায়িত্বপ্রাপ্ত|তথ্যপ্রদানকারী|designated|responsible|তথ্যকর্মকর্তা)/.test(s)) return 'alternate';
    if (/(দায়িত্বপ্রাপ্তকর্মকর্তা|তথ্যপ্রদানকারীকর্মকর্তা|তথ্যকর্মকর্তা|designatedofficer|responsibleofficer)/.test(s)
        && !/(বিকল্প|alternat|আপীল|appellate)/.test(s)) return 'primary';
    return null;
  };
  const labelOf = (text) => {
    const s = squash(text);
    if (!s || s.length > 25) return null;
    if (/মোবাইল|mobile/.test(s)) return 'mobile';
    if (/ফোন|টেলিফোন|phone/.test(s)) return 'phone';
    if (/ইমেইল|ইমেল|email|mail/.test(s)) return 'email';
    if (/^(পদবি|designation)/.test(s)) return 'designation';
    if (/^(নাম|কর্মকর্তারনাম|name)/.test(s)) return 'name';
    if (/^(ঠিকানা|অফিস|কার্যালয়|address|office)/.test(s)) return 'address';
    return null;
  };
  const inNav = (el) => !!el.closest('nav, header, footer, a[href]:not([href="#"])');
  const all = [...document.body.querySelectorAll('*')].filter((el) => !inNav(el) && !['SCRIPT', 'STYLE'].includes(el.tagName));
  // smallest element whose whole text is a role heading
  const heads = all.filter((el) => {
    const r = roleOf(el.innerText);
    if (!r) return false;
    return ![...el.querySelectorAll('*')].some((c) => roleOf(c.innerText) === r);
  }).map((el) => ({ el, role: roleOf(el.innerText) }));
  const roles = {};
  heads.filter((h) => h.role !== 'container').forEach((h, i, arr) => {
    if (roles[h.role]) return;
    let box = h.el.parentElement;
    while (box && box !== document.body && norm(box.innerText) === norm(h.el.innerText) && !box.querySelector('img')) box = box.parentElement;
    const others = heads.filter((o) => o !== h && box.contains(o.el));
    const next = arr.slice(i + 1).map((o) => o.el).find((o) => box.contains(o));
    const inBlock = (node) => {
      if (!box.contains(node) || h.el.contains(node)) return false;
      if (others.length === 0) return true;
      const afterHead = h.el.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING;
      const beforeNext = !next || (node.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING);
      return afterHead && beforeNext;
    };
    const out = {};
    box.querySelectorAll('tr, p, li, dt, div').forEach((row) => {
      if (!inBlock(row)) return;
      const cells = row.tagName === 'TR' ? [...row.children].map((c) => norm(c.innerText)) : null;
      let label; let value;
      if (cells && cells.length >= 2 && labelOf(cells[0])) { label = labelOf(cells[0]); value = cells.slice(1).join(' '); }
      else if (!cells && row.children.length === 0) {
        const m = norm(row.innerText).match(/^([^:ঃ]{1,30}?)\s*[:ঃ]\s*(.*)$/);
        if (m && labelOf(m[1])) { label = labelOf(m[1]); value = m[2]; }
      }
      if (label && !(label in out)) out[label] = norm(value);
    });
    const img = [...box.querySelectorAll('img')].find((im) => inBlock(im) && !/logo|banner|placeholder|default|avatar|icon/i.test(im.src));
    if (img) out.image = new URL(img.getAttribute('src'), location.href).href;
    roles[h.role] = out;
  });
  const payload = { url: location.href, title: document.title, captured_at: new Date().toISOString(), roles };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 1)], { type: 'application/json' }));
  a.download = `${location.hostname}.json`;
  a.click();
  console.log('JAANI: saved', a.download, payload);
})();
