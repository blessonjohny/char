// ============================================================================
// layout-engine-holdem.js
//
// Shared between the live Hold'em table (holdem.html, via
// layout-apply-holdem.js) and the standalone visual editor
// (layout-editor-holdem.html). Positioning-only: it never reads or writes
// any game state and never calls any game function other than wrapping the
// existing seatPositions() to optionally nudge its RETURN VALUE.
//
// Hold'em's own code already gives us the cleanest hook of any of the three
// tables: seatPositions() is a real function, called fresh on every render,
// returning one {x,y} percent pair per seat SLOT (0-8, already relative to
// whichever player is viewing -- see slotFor() in holdem.html). Overriding
// seat position here means wrapping that one function, not fighting CSS.
//
// Everything else editable here (avatar size, the dealer figure, community
// card position/size, hand-card size) IS plain CSS in the existing
// stylesheet, scoped by a body class (body.k28-in-game / body.k28-
// portrait-photo) rather than a media query -- so our override rules only
// need the same body-class scoping, appended last, with !important.
//
// Scope (v1): two breakpoints -- "portraitPhoto" (phone portrait) and
// "landscape" (everything else: mobile landscape AND desktop share one set
// of values here). The real stylesheet additionally re-tunes a few of these
// values specifically for a real mouse/trackpad (`@media (hover:hover) and
// (pointer:fine)`, computed once at page load into the `isDesktopPointer`
// flag) and for short viewports -- deliberately left alone in v1 rather
// than risk an editor that can't actually preview a real touch device's
// input-capability media features (a plain same-origin iframe can emulate a
// viewport SIZE, but not a device's hover/pointer capability). Editing
// "Landscape / Desktop" here sets the layout for every k28-in-game visitor;
// see the code comment on BREAKPOINTS for how this could be split further
// later without changing the save format.
// ============================================================================
(function (global) {
  'use strict';

  const SEAT_COUNT = 9;

  const BREAKPOINTS = [
    { key: 'portraitPhoto', label: 'Mobile Portrait', bodyClass: 'k28-portrait-photo', previewWidth: 430, previewHeight: 860 },
    { key: 'landscape', label: 'Landscape / Desktop', bodyClass: 'k28-in-game', previewWidth: 1400, previewHeight: 900 },
  ];

  // Non-seat elements. `fieldUnits` gives each CSS field its own unit since
  // position fields (left/top) are % of .table-wrap and size fields
  // (width/height) are px, on the very same element (the dealer figure).
  const ELEMENTS = [
    { key: 'avatarSize', label: 'Player Avatars (all seats)', category: 'Avatars', selector: '.seat-avatar-wrap', kind: 'size', cssProps: { width: 'width', height: 'height' }, fieldUnits: { width: 'px', height: 'px' } },
    { key: 'dealer', label: 'Dealer', category: 'Dealer', selector: '.house-dealer', kind: 'position+size', cssProps: { left: 'left', top: 'top', width: 'width', height: 'height' }, fieldUnits: { left: '%', top: '%', width: 'px', height: 'px' }, extraDecls: 'transform:translate(-50%,-50%) !important;' },
    { key: 'boardArea', label: 'Community Cards (position)', category: 'Cards', selector: '.board-area', kind: 'position', cssProps: { left: 'left', top: 'top' }, fieldUnits: { left: '%', top: '%' }, extraDecls: 'transform:translate(-50%,-50%) !important;' },
    { key: 'boardCard', label: 'Community Cards (size)', category: 'Cards', selector: '.board-area .card', kind: 'size', cssProps: { width: 'width', height: 'height' }, fieldUnits: { width: 'px', height: 'px' } },
    { key: 'handCard', label: 'Your Hand (card size)', category: 'Cards', selector: '.hand-strip .card', kind: 'size', cssProps: { width: 'width', height: 'height' }, fieldUnits: { width: 'px', height: 'px' } },
  ];

  function elementByKey(key) { return ELEMENTS.find((e) => e.key === key) || null; }

  function bpForDoc(doc) {
    if (!doc || !doc.body) return null;
    if (doc.body.classList.contains('k28-portrait-photo')) return 'portraitPhoto';
    if (doc.body.classList.contains('k28-in-game')) return 'landscape';
    return null;
  }

  function declsFor(el, values) {
    if (!values) return '';
    let out = '';
    for (const [field, cssProp] of Object.entries(el.cssProps)) {
      const v = values[field];
      if (v === undefined || v === null || v === '') continue;
      const unit = (el.fieldUnits && el.fieldUnits[field]) || 'px';
      out += `${cssProp}:${v}${unit} !important;`;
    }
    if (out && el.extraDecls) out += el.extraDecls;
    return out;
  }

  // Builds the CSS override string for the non-seat elements. Rules are
  // scoped by the same body class the real stylesheet itself uses for that
  // breakpoint (not a media query -- see the file header) so they only ever
  // take effect at the matching breakpoint, on every visitor's own device.
  function buildOverrideCSS(config) {
    if (!config || typeof config !== 'object') return '';
    let css = "/* Generated by the Hold'em Visual Layout Editor -- positioning only. */\n";
    for (const bp of BREAKPOINTS) {
      const values = config[bp.key];
      if (!values || typeof values !== 'object') continue;
      let body = '';
      for (const el of ELEMENTS) {
        const decls = declsFor(el, values[el.key]);
        if (!decls) continue;
        body += `body.${bp.bodyClass} ${el.selector}{${decls}}\n`;
      }
      if (body) css += body;
    }
    return css;
  }

  // Injects (or re-appends, to stay last) the override <style> tag.
  function applyCSSConfig(doc, config) {
    if (!doc || !doc.head) return;
    let tag = doc.getElementById('layout-overrides-holdem');
    const css = buildOverrideCSS(config);
    if (!tag) {
      tag = doc.createElement('style');
      tag.id = 'layout-overrides-holdem';
      doc.head.appendChild(tag);
    } else if (doc.head.lastElementChild !== tag) {
      doc.head.appendChild(tag);
    }
    tag.textContent = css;
  }

  // Wraps window.seatPositions() exactly once so it keeps calling the real,
  // original function every time (preserving all existing per-device/per-
  // breakpoint game logic) and only overwrites the fields that have an
  // explicit saved override for the CURRENT breakpoint's slot. `getConfig`
  // is a function so the editor can keep mutating the same live config
  // object and have in-progress (unsaved) edits reflected on the very next
  // re-render, without needing to re-patch anything.
  function patchSeatPositions(win, getConfig) {
    if (!win || typeof win.seatPositions !== 'function' || win.__layoutHoldemPatched) return;
    const original = win.seatPositions;
    win.__layoutHoldemPatched = true;
    win.__layoutHoldemOriginalSeatPositions = original;
    win.seatPositions = function () {
      const base = original.apply(this, arguments);
      const config = getConfig ? getConfig() : null;
      if (!config) return base;
      const bpKey = bpForDoc(win.document);
      if (!bpKey) return base;
      const seatOverrides = config[bpKey] && config[bpKey].seats;
      if (!seatOverrides) return base;
      return base.map((p, i) => (seatOverrides[i] ? Object.assign({}, p, seatOverrides[i]) : p));
    };
  }

  function applyAll(doc, win, config) {
    applyCSSConfig(doc, config);
    patchSeatPositions(win, () => config);
  }

  // Seat position is only ever (re)written to the DOM inside the page's own
  // renderGameTable(), driven by whatever hand state it last received --
  // there is no separate reactive binding to poke. This file is itself
  // loaded as a plain classic <script> inside holdem.html (live or
  // iframed), so it shares that page's real global scope and can safely
  // call its existing render function with its existing last-known state to
  // force an immediate on-screen refresh after a seat is dragged, without
  // touching any game logic or requesting anything from the server. A
  // no-op (silently) whenever there's no game in progress to redraw yet
  // (e.g. still on the lobby screen).
  function forceRerender() {
    try {
      if (typeof latestState !== 'undefined' && latestState && typeof renderGameTable === 'function') {
        renderGameTable(latestState);
      }
    } catch (e) { /* not ready / not applicable right now -- ignore */ }
  }

  global.LayoutHoldem = {
    SEAT_COUNT, BREAKPOINTS, ELEMENTS,
    elementByKey, bpForDoc, buildOverrideCSS, applyCSSConfig, patchSeatPositions, applyAll, forceRerender,
  };
})(window);
