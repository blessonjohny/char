// ============================================================================
// layout-engine-56.js
//
// Shared between the live 56 table (56.html, via layout-apply-56.js) and
// the standalone visual editor (layout-editor-56.html). Positioning-only:
// it never reads or writes any game state and never calls any game
// function other than wrapping window.renderTable() to optionally layer
// our own seat-position overrides on top of whatever it just set.
//
// 56.html has no breakpoint/body-class system at all (unlike Hold'em/4p/
// 6p) -- this engine invents one, but ties its boundary to 56.html's OWN
// existing `@media (max-width:600px)` rule (the one that already resizes
// #table/.seat for a phone), instead of a fresh number pulled out of thin
// air. Rather than toggling a body class and racing 56.html's own layout
// to keep it in sync, each breakpoint's override CSS is emitted inside
// its own native `@media` block (see buildOverrideCSS) -- the browser
// itself decides which one applies, exactly the way 56.html's own rule
// already does, with nothing to keep synchronized on resize.
//
// SEATS are the one genuinely special case here. 56.html keys its 6 seat
// DOM elements by RAW SEAT INDEX (table.appendChild() in seat order
// 0..5, once, inside ensureTableSkeleton() -- #table's child order never
// changes after that), but the VISUAL layout position assigned to each
// one is the per-viewer DISPLAY SLOT: displaySlot(seat) = (seat - mySeat
// + 6) % 6, so "seat 2" can land at the bottom for one viewer and at the
// top for another. A plain CSS selector keyed to a fixed DOM child
// (`#table > div:nth-child(3)` say) can only ever mean "raw seat 2" --
// it can't express "whichever seat is currently showing at the bottom
// slot for THIS viewer", which is what a layout editor actually needs to
// let an admin position. So seats are handled in JS instead of CSS: this
// file wraps window.renderTable() (a real, top-level `function
// renderTable(state){...}` declaration -- which DOES land on `window` in
// a classic, non-module script, unlike the top-level `let`/`const`
// bindings such as SEAT_POS/seatEls/mySeat that an iframe parent simply
// cannot reach) so that right after every real render, it walks all 6
// raw seats, asks window.displaySlot(seat) -- also a reachable top-level
// function -- which slot each one is CURRENTLY showing at for this
// viewer, and applies that slot's saved override straight onto that
// seat's own DOM node (`#table > div:nth-child(seat+1)`) as an
// !important inline style, which always beats 56.html's own plain
// (non-important) `div.style.left = ...` set a moment earlier in the
// very same renderTable() call. Same "wrap original, call it, then layer
// our own change on top" pattern layout-engine-holdem.js's
// patchRenderGameTable and layout-engine-6p.js's
// patchEnforceAvatarSizing both use.
//
// Scope (v1, mirrors the task's own minimum ask): the 6 seats (by
// DISPLAY SLOT, via the technique above), the hand strip (#hand-area),
// the bid panel (#bid-panel), and ONE combined "Overlay / Popup Box"
// slot for the single shared `#overlay` element 56.html reuses for
// lobby/bidWonReview/auctionClosed/handEnd/etc -- there is no stable
// per-popup DOM to offer finer-grained slots for, so offering one here
// honestly reflects that rather than faking granularity that doesn't
// exist. The table chat panel (#chatPanel56) is included too as a cheap,
// low-risk bonus -- it's a single stable always-present element, same
// shape as Hold'em/6p's own chat panel layer. Per-seat PLAYED CARDS are
// deliberately NOT offered: 56.html recreates each `.trick-card` element
// from scratch on every trick (no persistent per-slot node the way 6p's
// #trickSlot0..5 are), so a per-seat slot here would need the exact same
// raw-seat/display-slot remap as the seats above layered on top of
// elements that don't durably exist between renders -- a combined
// "whole trick area" box was considered but dropped too: unlike the
// popups, `.center-trick` has no transform-based center point (it's a
// plain inset:0 box, not a translate(-50%,-50%) one), which would need
// its own separate box-model math throughout this file and the editor
// for one low-value slot. Left out rather than faked.
// ============================================================================
(function (global) {
  'use strict';

  const SEAT_COUNT = 6;
  const SLOT_LABELS = ['Bottom (You)', 'Bottom-Right', 'Top-Right', 'Top', 'Top-Left', 'Bottom-Left'];

  const BREAKPOINTS = [
    { key: 'mobile', label: 'Mobile (≤600px)', media: 'max-width:600px', previewWidth: 390, previewHeight: 844 },
    { key: 'desktop', label: 'Desktop (>600px)', media: 'min-width:601px', previewWidth: 1400, previewHeight: 900 },
  ];

  // Seat slots -- position-only (left/top %, relative to #table's own
  // box, same coordinate space 56.html's own SEAT_POS array uses), one
  // per DISPLAY SLOT (not raw seat -- see header comment).
  const SEAT_SLOTS = [];
  for (let i = 0; i < SEAT_COUNT; i++) {
    SEAT_SLOTS.push({
      key: 'slot' + i, slot: i, label: 'Seat — ' + SLOT_LABELS[i], category: 'Seats',
      kind: 'position', cssProps: { left: 'left', top: 'top' }, fieldUnits: { left: '%', top: '%' },
    });
  }
  function slotByKey(key) { return SEAT_SLOTS.find((s) => s.key === key) || null; }

  // CSS-injectable elements (viewer-independent, stable selectors --
  // handled exactly like Hold'em/6p's own popups: an !important override
  // stylesheet, detached to position:fixed, centered via
  // translate(-50%,-50%) against the saved left/top percent of the
  // VIEWPORT).
  const ELEMENTS = [
    { key: 'handArea', label: 'Your Hand', category: 'Cards', selector: '#hand-area', sizeSelector: '#hand-strip .card', kind: 'position+size', cssProps: { left: 'left', top: 'top', width: 'width', height: 'height' }, fieldUnits: { left: '%', top: '%', width: 'px', height: 'px' }, extraDecls: 'position:fixed !important;right:auto !important;bottom:auto !important;transform:translate(-50%,-50%) !important;', viewportRelative: true },
    { key: 'bidPanel', label: 'Bid Panel', category: 'Bidding', selector: '#bid-panel', previewToggleSelector: '#bid-panel-overlay', previewToggleMode: 'hiddenClass', kind: 'position+size', cssProps: { left: 'left', top: 'top', width: 'width', height: 'height' }, fieldUnits: { left: '%', top: '%', width: 'px', height: 'px' }, extraDecls: 'position:fixed !important;margin:0 !important;transform:translate(-50%,-50%) !important;', viewportRelative: true },
    // Only ONE combined slot for every popup 56.html funnels through
    // `#overlay` (lobby / bidWonReview / auctionClosed / handEnd / etc) --
    // see header comment for why finer-grained slots aren't offered here.
    { key: 'popupBox', label: 'Overlay / Popup Box', category: 'Popups', selector: '#overlay .box', previewToggleSelector: '#overlay', previewToggleMode: 'hiddenClass', kind: 'position+size', cssProps: { left: 'left', top: 'top', width: 'width', height: 'height' }, fieldUnits: { left: '%', top: '%', width: 'px', height: 'px' }, extraDecls: 'position:fixed !important;margin:0 !important;transform:translate(-50%,-50%) !important;', viewportRelative: true },
    { key: 'chatPanel', label: 'Chat Panel', category: 'Popups', selector: '#chatPanel56', previewToggleSelector: '#chatOverlay56', kind: 'position+size', cssProps: { left: 'left', top: 'top', width: 'width', height: 'height' }, fieldUnits: { left: '%', top: '%', width: 'px', height: 'px' }, extraDecls: 'position:fixed !important;transform:translate(-50%,-50%) !important;', viewportRelative: true },
  ];
  function elementByKey(key) { return ELEMENTS.find((e) => e.key === key) || null; }

  const PREVIEW_ON_KEYS = ELEMENTS.filter((e) => e.previewToggleSelector).map((e) => e.key);

  // Unlike 6p's popups (shown/hidden via a `.on` class ADDED to reveal),
  // 56.html's #overlay/#bid-panel-overlay are shown by REMOVING a
  // `.hidden` class -- previewToggleMode 'hiddenClass' flips that
  // direction; 'style' (unused here, kept for parity with 6p) forces
  // style.display; anything else (chatPanel) falls back to the `.on`
  // pattern like six.js/play6.html's own chat panel.
  function setPreviewOn(doc, on) {
    if (!doc) return;
    for (const key of PREVIEW_ON_KEYS) {
      const def = elementByKey(key);
      if (!def) continue;
      const el = doc.querySelector(def.previewToggleSelector);
      if (!el) continue;
      if (def.previewToggleMode === 'hiddenClass') {
        el.classList.toggle('hidden', !on);
      } else if (def.previewToggleMode === 'style') {
        if (on) el.style.setProperty('display', 'block', 'important');
        else el.style.removeProperty('display');
      } else {
        el.classList.toggle('on', !!on);
      }
    }
  }

  function bpForWin(win) {
    try { return (win.innerWidth <= 600) ? 'mobile' : 'desktop'; } catch (e) { return 'mobile'; }
  }
  function bpForDoc(doc) {
    return bpForWin((doc && doc.defaultView) || global);
  }

  function declsFor(el, values, fieldsSubset) {
    if (!values) return '';
    let out = '';
    for (const [field, cssProp] of Object.entries(el.cssProps)) {
      if (fieldsSubset && !fieldsSubset.includes(field)) continue;
      const v = values[field];
      if (v === undefined || v === null || v === '') continue;
      const unit = (el.fieldUnits && el.fieldUnits[field]) || 'px';
      out += `${cssProp}:${v}${unit} !important;`;
    }
    return out;
  }

  function buildOverrideCSS(config) {
    if (!config || typeof config !== 'object') return '';
    let css = '/* Generated by the 56 Visual Layout Editor -- positioning only. */\n';
    for (const bp of BREAKPOINTS) {
      const values = config[bp.key];
      if (!values || typeof values !== 'object') continue;
      let body = '';
      for (const el of ELEMENTS) {
        const v = values[el.key];
        if (!v) continue;
        if (el.sizeSelector) {
          let posDecls = declsFor(el, v, ['left', 'top']);
          if (posDecls && el.extraDecls) posDecls += el.extraDecls;
          const sizeDecls = declsFor(el, v, ['width', 'height']);
          if (posDecls) body += `${el.selector}{${posDecls}}\n`;
          if (sizeDecls) body += `${el.sizeSelector}{${sizeDecls}}\n`;
        } else {
          let decls = declsFor(el, v);
          if (decls && el.extraDecls) decls += el.extraDecls;
          if (decls) body += `${el.selector}{${decls}}\n`;
        }
      }
      // Each breakpoint's block lives inside its OWN native @media query
      // (tied to 56.html's own 600px boundary) rather than a body class --
      // see header comment for why.
      if (body) css += `@media (${bp.media}){\n${body}}\n`;
    }
    return css;
  }

  function applyCSSConfig(doc, config) {
    if (!doc || !doc.head) return;
    let tag = doc.getElementById('layout-overrides-56');
    const css = buildOverrideCSS(config);
    if (!tag) {
      tag = doc.createElement('style');
      tag.id = 'layout-overrides-56';
      doc.head.appendChild(tag);
    } else if (doc.head.lastElementChild !== tag) {
      doc.head.appendChild(tag);
    }
    tag.textContent = css;
  }

  // ---------------------------------------------------------------------
  // Seat slots -- JS-applied (see header comment for why CSS can't do
  // this part). elementForSlot walks the 6 raw seats and asks the live
  // page's own window.displaySlot(seat) which slot each currently shows
  // at for THIS viewer, returning whichever DOM node that is right now.
  // ---------------------------------------------------------------------
  function elementForSlot(doc, win, slotIndex) {
    if (!doc || !win || typeof win.displaySlot !== 'function') return null;
    for (let seat = 0; seat < SEAT_COUNT; seat++) {
      let s;
      try { s = win.displaySlot(seat); } catch (e) { continue; }
      if (s === slotIndex) {
        try { return doc.querySelector('#table > div:nth-child(' + (seat + 1) + ')'); } catch (e) { return null; }
      }
    }
    return null;
  }

  function applySeatSlotPositions(doc, win, config) {
    if (!doc || !win || !config) return;
    const bucket = config[bpForWin(win)];
    if (!bucket) return;
    for (let slot = 0; slot < SEAT_COUNT; slot++) {
      const v = bucket['slot' + slot];
      if (!v) continue;
      const el = elementForSlot(doc, win, slot);
      if (!el) continue;
      if (v.left != null) el.style.setProperty('left', v.left + '%', 'important');
      if (v.top != null) el.style.setProperty('top', v.top + '%', 'important');
    }
  }

  // Wraps window.renderTable() exactly once so every real render
  // reapplies our saved per-slot seat overrides right after 56.html's
  // own renderTable() finishes setting each seat's plain (non-important)
  // left/top -- same "wrap original, call it, then layer our change on
  // top" pattern as layout-engine-6p.js's patchEnforceAvatarSizing.
  function patchRenderTable(win, getConfig) {
    if (!win || typeof win.renderTable !== 'function' || win.__layout56RenderPatched) return;
    const original = win.renderTable;
    win.__layout56RenderPatched = true;
    win.renderTable = function () {
      const result = original.apply(this, arguments);
      try {
        const config = getConfig ? getConfig() : null;
        if (config) applySeatSlotPositions(win.document, win, config);
      } catch (e) { /* not ready / not applicable -- ignore */ }
      return result;
    };
  }

  // `configOrGetter` accepts either a plain config object (the live page,
  // layout-apply-56.js -- fetched once, never reassigned) or a function
  // returning the CURRENT config (the editor, whose own `config`
  // variable gets reassigned wholesale on load / undo / redo).
  function applyAll(doc, win, configOrGetter) {
    const getConfig = typeof configOrGetter === 'function' ? configOrGetter : () => configOrGetter;
    applyCSSConfig(doc, getConfig());
    patchRenderTable(win, getConfig);
    applySeatSlotPositions(doc, win, getConfig());
  }

  // No "redraw everything from the last known state" entry point exists
  // to call here (same situation as layout-engine-6p.js's forceRerender)
  // -- for the CSS-driven elements the override stylesheet already takes
  // effect the instant applyCSSConfig writes it, with nothing left for
  // any JS to redraw. For a seat slot specifically, re-applying the
  // override directly (rather than waiting for the next real
  // window.renderTable() call) lets a drag/number-field edit show
  // immediately -- exposed so the editor can call it right after
  // updating `config`, same purpose as 6p's forceRerender.
  function forceRerender(win, configOrGetter) {
    try {
      if (!win) return;
      const config = typeof configOrGetter === 'function' ? configOrGetter() : configOrGetter;
      if (config) applySeatSlotPositions(win.document, win, config);
    } catch (e) {}
  }

  global.LayoutFiftySix = {
    SEAT_COUNT, SLOT_LABELS, BREAKPOINTS, ELEMENTS, SEAT_SLOTS, PREVIEW_ON_KEYS,
    elementByKey, slotByKey, bpForDoc, bpForWin, buildOverrideCSS, applyCSSConfig,
    elementForSlot, applySeatSlotPositions, patchRenderTable, applyAll, forceRerender, setPreviewOn,
  };
})(window);
