// ============================================================================
// layout-pro.js  --  "Pro" layout overrides for the 4-player, 6-player and 56 tables.
//
// WHY: the older editors could only move the elements somebody had registered in code
// (seats, hand, a few popups). Anything else -- the Kunukku coconut, banners, score
// chips, buttons, the animations -- simply wasn't editable. The Pro editor lets you pick
// ANY visible thing on the table, and this file is what makes a picked thing stay where
// you put it for every player.
//
// WHAT IT STORES (inside the same saved layout, under "__pro", so it can never collide
// with the older settings):
//   __pro: { v:1, items: { portrait:[...], landscape:[...], desktop:[...] } }
//   item  : { sel, label, dx, dy, w, h, hide }
//     sel   a CSS selector for the thing (built by the editor, validated here)
//     dx,dy how far it is moved from where the game puts it   (design pixels)
//     w,h   an optional forced size                            (design pixels)
//     hide  true = not shown at all
//
// DESIGN PIXELS: sizes and moves are saved relative to a reference screen width for
// each layout (390 / 844 / 1400) and scaled to the real screen width when applied, so a
// layout made on one phone keeps its proportions on every other phone (the same idea
// that fixed "different on my phone" in the Hold'em editor).
//
// SAFE BY CONSTRUCTION: it only ever writes `translate`, `width`, `height` and
// `display:none` rules from a validated selector -- never game logic, never markup.
// `translate` is used (not left/top) so an item keeps its place in the page flow and
// whatever centring / positioning the game already gives it.
// ============================================================================
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LayoutPro = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // The three layouts partition every possible screen, so exactly one set of rules applies at a time.
  const LAYOUTS = [
    { key: 'portrait',  label: 'Phone upright',          media: '(orientation: portrait)',                                   ref: 390,  presets: [[390, 844, 'iPhone 12–14'], [360, 740, 'Small Android'], [412, 915, 'Android'], [430, 932, 'Large iPhone'], [375, 667, 'Older iPhone']] },
    { key: 'landscape', label: 'Phone sideways',         media: '(orientation: landscape) and (max-height: 520px)',          ref: 844,  presets: [[844, 390, 'iPhone 12–14'], [915, 412, 'Android'], [740, 360, 'Small Android'], [932, 430, 'Large iPhone']] },
    { key: 'desktop',   label: 'Desktop / tablet',       media: '(orientation: landscape) and (min-height: 521px)',          ref: 1400, presets: [[1400, 900, 'Desktop'], [1280, 720, 'Laptop'], [1024, 768, 'Tablet'], [1920, 1080, 'Full HD']] },
  ];
  const layoutByKey = (k) => LAYOUTS.find((l) => l.key === k) || LAYOUTS[0];
  function layoutKeyFor(width, height) {
    if (height > width) return 'portrait';
    return height <= 520 ? 'landscape' : 'desktop';
  }
  function unitFor(layoutKey, width) {
    const l = layoutByKey(layoutKey);
    const u = width / l.ref;
    return Math.round(Math.min(1.6, Math.max(0.55, u)) * 10000) / 10000;
  }

  // ---- validation -------------------------------------------------------------------------
  function safeSelector(sel) {
    if (typeof sel !== 'string' || sel.length < 1 || sel.length > 240) return false;
    // '>' is a real CSS combinator and must stay legal; what must never get through is anything that could end the rule
    // or start another one (braces, semicolon, at-rules), HTML, comments or line breaks.
    if (/[{};@<]|\/\*|\*\/|[\r\n]/.test(sel)) return false;
    return true;
  }
  const num = (v) => { v = Number(v); return Number.isFinite(v) ? Math.round(v * 10) / 10 : null; };

  // ---- CSS --------------------------------------------------------------------------------
  function buildCSS(config) {
    const pro = config && config.__pro;
    if (!pro || !pro.items) return '';
    let css = '';
    for (const l of LAYOUTS) {
      const list = pro.items[l.key];
      if (!Array.isArray(list) || !list.length) continue;
      let body = '';
      for (const it of list) {
        if (!it || !safeSelector(it.sel)) continue;
        const d = [];
        if (it.hide) d.push('display:none !important');
        else {
          if (it.ib) d.push('display:inline-block !important');
          const dx = num(it.dx), dy = num(it.dy), w = num(it.w), h = num(it.h);
          if ((dx != null && dx !== 0) || (dy != null && dy !== 0)) d.push(`translate:calc(${dx || 0}px * var(--lpu,1)) calc(${dy || 0}px * var(--lpu,1)) !important`);
          if (w != null && w > 0) d.push(`width:calc(${w}px * var(--lpu,1)) !important;min-width:0 !important;max-width:none !important;box-sizing:border-box !important;flex-shrink:0 !important`);
          if (h != null && h > 0) d.push(`height:calc(${h}px * var(--lpu,1)) !important;min-height:0 !important;max-height:none !important`);
        }
        if (d.length) body += `${it.sel}{${d.join(';')}}\n`;
      }
      if (body) css += `@media ${l.media}{\n${body}}\n`;
    }
    return css ? '/* Generated by the Pro layout editor -- positioning only. */\n' + css : '';
  }

  // Applies the saved Pro overrides to one document and keeps the screen-scale variable current.
  function apply(doc, win, config) {
    if (!doc || !doc.head) return;
    let tag = doc.getElementById('layout-pro-overrides');
    if (!tag) { tag = doc.createElement('style'); tag.id = 'layout-pro-overrides'; doc.head.appendChild(tag); }
    else if (doc.head.lastElementChild !== tag) doc.head.appendChild(tag);          // always last so it wins the cascade
    tag.textContent = buildCSS(config);
    setUnit(doc, win);
    if (!win.__layoutProResize) {
      win.__layoutProResize = true;
      win.addEventListener('resize', () => setUnit(doc, win));
    }
  }
  function setUnit(doc, win) {
    try {
      const w = win.innerWidth, h = win.innerHeight;
      doc.documentElement.style.setProperty('--lpu', String(unitFor(layoutKeyFor(w, h), w)));
    } catch (e) {}
  }

  // ---- selector building (used by the editor) ----------------------------------------------
  const VOLATILE = /^(on|off|active|show|shown|hidden|open|opened|selected|disabled|current|my-turn|myturn|turn|live|paused|pulse|pulsing|flash|flashing|anim|animate|animating|leaving|entering|enter|exit|visible|dim|dimmed|glow|win|winner|lose|loser|fold|folded|has-q|speaking|k28-in-game|led-.*|ed-.*)$/i;
  const esc = (s) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : String(s).replace(/([^\w-])/g, '\\$1'));
  function stableClasses(el) {
    return Array.from(el.classList || []).filter((c) => c && !VOLATILE.test(c) && !/\d{3,}/.test(c));
  }
  function simple(el, withNth) {
    if (el.id && !/\d{4,}/.test(el.id)) return '#' + esc(el.id);
    const tag = el.tagName.toLowerCase();
    const cls = stableClasses(el).slice(0, 3).map((c) => '.' + esc(c)).join('');
    let s = tag + cls;
    if (withNth && el.parentElement) {
      const same = Array.from(el.parentElement.children).filter((c) => c.tagName === el.tagName && (!cls || stableClasses(c).slice(0, 3).map((x) => '.' + esc(x)).join('') === cls));
      if (same.length > 1) s += `:nth-of-type(${Array.from(el.parentElement.children).filter((c) => c.tagName === el.tagName).indexOf(el) + 1})`;
    }
    return s;
  }
  // 'one'  -> a selector that matches exactly this element
  // 'like' -> the class-level selector that also matches every similar element (e.g. all kunukku coconuts)
  function selectorFor(el, mode) {
    const doc = el.ownerDocument;
    const count = (sel) => { try { return doc.querySelectorAll(sel).length; } catch (e) { return 0; } };
    const isOnly = (sel) => { try { const m = doc.querySelectorAll(sel); return m.length === 1 && m[0] === el; } catch (e) { return false; } };
    if (mode === 'like') {
      if (el.id && !/\d{4,}/.test(el.id)) return '#' + esc(el.id);
      let s = simple(el, false);
      // climb to the nearest id ancestor to keep it scoped when the bare class would hit unrelated parts of the page
      return s;
    }
    let s = simple(el, false);
    if (isOnly(s)) return s;
    s = simple(el, true);
    if (isOnly(s)) return s;
    // build a path upward until it is unique
    let path = [simple(el, true)], cur = el.parentElement, guard = 0;
    while (cur && cur !== doc.body && cur !== doc.documentElement && guard++ < 7) {
      path.unshift(simple(cur, true));
      const sel = path.join(' > ');
      if (isOnly(sel)) return sel;
      if (cur.id && !/\d{4,}/.test(cur.id)) break;
      cur = cur.parentElement;
    }
    return path.join(' > ');
  }

  // ---- friendly names ----------------------------------------------------------------------
  const LABELS = [
    [/kunukku-avatar|sad-coconut|kunukku-count|qmark-count|\.q-badge|q-mark/i, '🥥 Kunukku coconut / count'],
    [/qmark-event|kunukku.*banner/i, '🎉 Kunukku banner'],
    [/game-event/i, '✨ Game event popup'],
    [/bidWinner/i, '🏆 Bid winner bubble'], [/bidStatus/i, '📣 Bid status banner'], [/call-?bubble|callBubble/i, '💬 Call bubble'],
    [/trump/i, '🃏 Trump display'], [/last-?trick/i, '⏮ Last trick'], [/score|points/i, '🔢 Score'],
    [/chat/i, '💬 Chat'], [/mute|sound/i, '🔊 Sound button'], [/hand/i, '🖐 Your hand'],
    [/chip/i, '🪙 Chips'], [/avatar|\bav\d|hero-avatar/i, '🙂 Avatar'], [/seat|pspot|pos\d/i, '🪑 Seat'],
    [/card/i, '🂠 Card'], [/name/i, '🏷 Name'], [/timer|clock/i, '⏱ Timer'], [/bid/i, '🔨 Bid'],
    [/overlay|modal|popup|box/i, '🪟 Popup'], [/btn|button/i, '🔘 Button'],
  ];
  function prettyLabel(el, sel) {
    const probe = (sel || '') + ' ' + (el.id || '') + ' ' + (el.className && el.className.baseVal === undefined ? el.className : '');
    for (const [re, label] of LABELS) if (re.test(probe)) return label + (el.id ? ' · #' + el.id : '');
    const t = (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title'))) || '';
    return (t ? t.slice(0, 24) + ' · ' : '') + el.tagName.toLowerCase() + (stableClasses(el)[0] ? '.' + stableClasses(el)[0] : '') + (el.id ? '#' + el.id : '');
  }

  return { LAYOUTS, layoutByKey, layoutKeyFor, unitFor, safeSelector, buildCSS, apply, setUnit, selectorFor, stableClasses, prettyLabel, simple };
}));
