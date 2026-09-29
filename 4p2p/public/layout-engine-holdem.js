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
  // Per-seat elements (avatar size, chip pile, dealt cards) are NOT listed
  // here -- unlike these, a single CSS class selector can't target "seat 3
  // as this viewer sees it" (each viewer's own seatPositions()/slotFor()
  // rotation puts a different PHYSICAL seat at any given visual slot), so
  // they're applied per-render in JS instead (see applySeatStyles below),
  // keyed by slot the same way seat positions already are.
  // Every entry below carries all 4 controls (X, Y, W, H) by explicit
  // design decision: some real elements naturally split "where the group
  // sits" (a container) from "how big each piece is" (children inside
  // it) -- Community Cards and Your Hand are both a positioned container
  // plus individually-sized card elements. Rather than leave those as
  // two half-empty layers (position-only / size-only, like this used to
  // work), `sizeSelector` lets ONE layer drive both: left/top apply to
  // `selector` (the container), width/height apply to `sizeSelector`
  // (the children) -- see buildOverrideCSS below for how that's split
  // into two separate CSS rules. Elements that are already one single
  // element for both (a button, a popup) just reuse `selector` for both
  // and don't need it.
  const ELEMENTS = [
    { key: 'dealer', label: 'Dealer', category: 'Dealer', selector: '.house-dealer', kind: 'position+size', cssProps: { left: 'left', top: 'top', width: 'width', height: 'height' }, fieldUnits: { left: '%', top: '%', width: 'px', height: 'px' }, extraDecls: 'transform:translate(-50%,-50%) !important;' },
    { key: 'boardArea', label: 'Community Cards', category: 'Cards', selector: '.board-area', sizeSelector: '.board-area .card', kind: 'position+size', cssProps: { left: 'left', top: 'top', width: 'width', height: 'height' }, fieldUnits: { left: '%', top: '%', width: 'px', height: 'px' }, extraDecls: 'transform:translate(-50%,-50%) !important;' },
    // `.hand-strip` positions itself with position:fixed (viewport, not
    // the table -- see the file-level `viewportRelative` note below);
    // its individual cards (`.hand-strip .card`) are sized separately via
    // sizeSelector, same pattern as Community Cards above.
    { key: 'handStrip', label: 'Your Hand', category: 'Cards', selector: '.hand-strip', sizeSelector: '.hand-strip .card', kind: 'position+size', cssProps: { left: 'left', top: 'top', width: 'width', height: 'height' }, fieldUnits: { left: '%', top: '%', width: 'px', height: 'px' }, extraDecls: 'transform:translate(-50%,-50%) !important;', viewportRelative: true },
    { key: 'potAnchor', label: 'Table Pot', category: 'Chips', selector: '.pot-anchor', kind: 'position+size', cssProps: { left: 'left', top: 'top', width: 'width', height: 'height' }, fieldUnits: { left: '%', top: '%', width: 'px', height: 'px' } },
    // Also position:fixed (viewport-relative), same reasoning as handStrip.
    { key: 'actionBar', label: 'Action Buttons (Fold/Check/Bet)', category: 'Action Bar', selector: '#actionBar', kind: 'position+size', cssProps: { left: 'left', top: 'top', width: 'width', height: 'height' }, fieldUnits: { left: '%', top: '%', width: 'px', height: 'px' }, viewportRelative: true },
    // Table-relative (position:absolute, set inline in the HTML) -- no
    // viewportRelative flag, our !important override wins over the
    // inline style the same way it does for every other element here.
    { key: 'winnerPopup', label: 'Winner "Continue" Popup', category: 'Popups', selector: '#winningHandContinueWrap', kind: 'position+size', cssProps: { left: 'left', top: 'top', width: 'width', height: 'height' }, fieldUnits: { left: '%', top: '%', width: 'px', height: 'px' } },
    // position:fixed (viewport-relative) -- the "rotate your phone" hint.
    { key: 'tiltPopup', label: 'Rotate-Device Popup', category: 'Popups', selector: '.tilt-suggest-popup', kind: 'position+size', cssProps: { left: 'left', top: 'top', width: 'width', height: 'height' }, fieldUnits: { left: '%', top: '%', width: 'px', height: 'px' }, extraDecls: 'transform:translate(-50%,-50%) !important;', viewportRelative: true },
    // The top strip (hand number/blinds, Fullscreen/Invite/Host/Log/Leave
    // buttons) normally just sits in the page's own document flow at the
    // very top -- it doesn't use position:fixed/absolute at all, so plain
    // left/top would do nothing to it. Forcing position:fixed here (this
    // element only, via extraDecls) is what makes it moveable the same
    // way as everything else.
    { key: 'topbar', label: 'Top Bar (Host / Log / Leave / Invite)', category: 'Top Bar', selector: '.topbar', kind: 'position+size', cssProps: { left: 'left', top: 'top', width: 'width', height: 'height' }, fieldUnits: { left: '%', top: '%', width: 'px', height: 'px' }, extraDecls: 'position:fixed !important;z-index:120 !important;', viewportRelative: true },
    // The round sound on/off button. Its own CSS normally anchors it by
    // right/bottom instead of left/top -- extraDecls clears those so our
    // left/top override isn't fighting a leftover right/bottom value.
    { key: 'soundMute', label: 'Sound Mute Button', category: 'Top Bar', selector: '#btnSoundMute', kind: 'position+size', cssProps: { left: 'left', top: 'top', width: 'width', height: 'height' }, fieldUnits: { left: '%', top: '%', width: 'px', height: 'px' }, extraDecls: 'right:auto !important;bottom:auto !important;', viewportRelative: true },
  ];

  function elementByKey(key) { return ELEMENTS.find((e) => e.key === key) || null; }

  function bpForDoc(doc) {
    if (!doc || !doc.body) return null;
    if (doc.body.classList.contains('k28-portrait-photo')) return 'portraitPhoto';
    if (doc.body.classList.contains('k28-in-game')) return 'landscape';
    return null;
  }

  // fieldsSubset (optional) restricts which of el.cssProps get emitted --
  // used to split a merged position+size element's fields across its two
  // different real selectors (see sizeSelector note above ELEMENTS).
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
        const v = values[el.key];
        if (!v) continue;
        if (el.sizeSelector) {
          // Position fields go on the container (`selector`), size fields
          // go on the children (`sizeSelector`) -- two separate rules from
          // one saved value, since they're two different real elements.
          let posDecls = declsFor(el, v, ['left', 'top']);
          if (posDecls && el.extraDecls) posDecls += el.extraDecls;
          const sizeDecls = declsFor(el, v, ['width', 'height']);
          if (posDecls) body += `body.${bp.bodyClass} ${el.selector}{${posDecls}}\n`;
          if (sizeDecls) body += `body.${bp.bodyClass} ${el.sizeSelector}{${sizeDecls}}\n`;
        } else {
          let decls = declsFor(el, v);
          if (decls && el.extraDecls) decls += el.extraDecls;
          if (decls) body += `body.${bp.bodyClass} ${el.selector}{${decls}}\n`;
        }
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

  // ---------------------------------------------------------------------
  // Per-seat overrides (avatar size, chip pile position/size, dealt-card
  // size). Keyed by SLOT (not physical data-pos) so "seat 3" always means
  // the same visual seat for every viewer, exactly like seat positions:
  //   config[bp]['avatar'+slot]    = { width, height }
  //   config[bp]['chipPile'+slot]  = { left, top, width, height }
  //   config[bp]['cards'+slot]     = { width, height }
  // Applied as inline styles with !important (wins over both the base
  // stylesheet and our own class-based CSS overrides above), directly on
  // the real DOM elements for that seat -- safe to call as often as
  // needed since it's a pure re-apply, never touches game state.
  // ---------------------------------------------------------------------
  function applySeatStyles(doc, win, config) {
    if (!doc || !doc.body || !config) return;
    const bpKey = bpForDoc(doc);
    if (!bpKey) return;
    const bucket = config[bpKey];
    if (!bucket) return;
    const seats = doc.querySelectorAll('.seat[data-pos]');
    seats.forEach((seatEl) => {
      const pos = Number(seatEl.dataset.pos);
      let slot = pos;
      try { if (typeof win.slotFor === 'function') slot = win.slotFor(pos); } catch (e) {}

      const avatar = bucket['avatar' + slot];
      if (avatar) {
        const av = seatEl.querySelector('.seat-avatar-wrap');
        if (av) {
          if (avatar.width != null) av.style.setProperty('width', avatar.width + 'px', 'important');
          if (avatar.height != null) av.style.setProperty('height', avatar.height + 'px', 'important');
        }
      }

      const chipPile = bucket['chipPile' + slot];
      if (chipPile) {
        const rail = doc.getElementById('railChips' + pos);
        if (rail) {
          if (chipPile.left != null) rail.style.setProperty('left', chipPile.left + '%', 'important');
          if (chipPile.top != null) rail.style.setProperty('top', chipPile.top + '%', 'important');
          if (chipPile.width != null || chipPile.height != null) {
            rail.querySelectorAll('.pot-stack-chip').forEach((c) => {
              if (chipPile.width != null) c.style.setProperty('width', chipPile.width + 'px', 'important');
              if (chipPile.height != null) c.style.setProperty('height', chipPile.height + 'px', 'important');
            });
          }
        }
      }

      const cards = bucket['cards' + slot];
      if (cards) {
        const cardsEl = seatEl.querySelector('.seat-cards');
        if (cardsEl) {
          // .seat-cards is positioned relative to its own (small) .seat
          // box via left:50%/bottom:4%/transform:translateX(-50%) in the
          // real stylesheet, not relative to the whole table -- so a
          // table-relative left/top percentage (like chipPile above)
          // would mean something different once applied here. margin
          // just nudges it a fixed number of pixels from wherever it
          // already sits, independent of any containing-block math, and
          // matches 1:1 with how far you actually dragged it in the
          // editor.
          if (cards.offsetX != null) cardsEl.style.setProperty('margin-left', cards.offsetX + 'px', 'important');
          if (cards.offsetY != null) cardsEl.style.setProperty('margin-top', cards.offsetY + 'px', 'important');
          cardsEl.querySelectorAll('.card.mini').forEach((c) => {
            if (cards.width != null) c.style.setProperty('width', cards.width + 'px', 'important');
            if (cards.height != null) c.style.setProperty('height', cards.height + 'px', 'important');
          });
        }
      }

      // The numeric chip-count label under each player's name (e.g. "985")
      // -- a plain text element, so "size" here just means font size;
      // position is a margin nudge, same technique as dealt cards above.
      const chipLabel = bucket['chipLabel' + slot];
      if (chipLabel) {
        const chipsEl = seatEl.querySelector('.seat-chips');
        if (chipsEl) {
          if (chipLabel.offsetX != null) chipsEl.style.setProperty('margin-left', chipLabel.offsetX + 'px', 'important');
          if (chipLabel.offsetY != null) chipsEl.style.setProperty('margin-top', chipLabel.offsetY + 'px', 'important');
          if (chipLabel.fontSize != null) chipsEl.style.setProperty('font-size', chipLabel.fontSize + 'px', 'important');
        }
      }
    });
  }

  // Wraps window.renderGameTable() exactly once so every real re-render
  // (a new hand, a bet, a fold, cards being dealt -- anything that
  // rebuilds seat DOM) re-applies the per-seat overrides above right
  // after the game's own render finishes, the same "wrap the original,
  // call it, then layer our own change on top" pattern as
  // patchSeatPositions.
  function patchRenderGameTable(win, getConfig) {
    if (!win || typeof win.renderGameTable !== 'function' || win.__layoutHoldemRenderPatched) return;
    const original = win.renderGameTable;
    win.__layoutHoldemRenderPatched = true;
    win.renderGameTable = function () {
      const result = original.apply(this, arguments);
      try {
        const config = getConfig ? getConfig() : null;
        if (config) applySeatStyles(win.document, win, config);
      } catch (e) { /* not ready / not applicable -- ignore */ }
      return result;
    };
  }

  // `configOrGetter` accepts either a plain config object (the live page,
  // layout-apply-holdem.js -- fetched once, never reassigned afterward) or
  // a function returning the CURRENT config (the editor, whose own
  // `config` variable gets reassigned wholesale on load / undo / redo --
  // patchSeatPositions/patchRenderGameTable close over this getter and
  // must always read the live value, not a snapshot taken once at page
  // load, or edits made after that snapshot would silently never reach
  // the real DOM even though they're saved correctly).
  function applyAll(doc, win, configOrGetter) {
    const getConfig = typeof configOrGetter === 'function' ? configOrGetter : () => configOrGetter;
    applyCSSConfig(doc, getConfig());
    patchSeatPositions(win, getConfig);
    patchRenderGameTable(win, getConfig);
    applySeatStyles(doc, win, getConfig());
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
    elementByKey, bpForDoc, buildOverrideCSS, applyCSSConfig, patchSeatPositions,
    applySeatStyles, patchRenderGameTable, applyAll, forceRerender,
  };
})(window);
