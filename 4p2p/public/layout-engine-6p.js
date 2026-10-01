// ============================================================================
// layout-engine-6p.js
//
// Shared between the live 6-player table (play6.html, via
// layout-apply-6p.js) and the standalone visual editor
// (layout-editor-6p.html). Positioning-only: it never reads or writes any
// game state and never calls any game function other than wrapping
// enforceSeatAvatarSizing6p() to optionally layer our own overrides on top
// of whatever it just set.
//
// Unlike Hold'em (9 DOM elements shared across 9 PHYSICAL seats, remapped
// per-viewer via slotFor()/seatPositions()) or 4-player (grid-area seats),
// six.js already keys every seat-related DOM element directly by SLOT
// (#seatWrap0..5, #av0..5, #trickSlot0..5) -- slotFor(pos) is only used
// internally by six.js to decide which seat's STATE goes in which slot
// element; the elements themselves never move around the DOM. That means
// a plain CSS selector like `#seatWrap3` already means "slot 3, as this
// viewer sees it" for every visitor, with no per-viewer remap needed here
// at all -- considerably simpler than Hold'em's own per-seat handling.
//
// Seat / trick-slot POSITION is set once by six.js's own
// ensureSeatPositions() (plain inline style, not !important, called once
// at page load from the SEAT_POS/TRICK_SLOT_POS arrays) -- there is no
// per-render hook to patch the way Hold'em patches seatPositions(). Per
// the project's own guidance, this is handled with a pure CSS-override
// injection (our own <style> tag, !important, appended last) instead of
// function-patching: a stylesheet rule with !important always beats a
// plain (non-important) inline style, regardless of when either one was
// set, so there's nothing to "re-apply on render" for position at all.
//
// Avatar SIZE (and font-size) *is* set through a real, repeatedly-called
// function -- enforceSeatAvatarSizing6p(), called from renderSeats() on
// every state update and from a window resize listener, which itself uses
// setProperty(...,'important') to force its own two hard-coded size sets
// (phone vs k28-in-game desktop). Since both it and our override use
// !important on the very same properties, whichever sets them LAST wins --
// so this file patches (wraps) enforceSeatAvatarSizing6p() itself,
// calling the real one first and then layering any saved override on top,
// the same "wrap original, call it, then layer our change on top" pattern
// layout-engine-holdem.js uses for applySeatStyles/patchRenderGameTable.
//
// Scope (v1): two breakpoints -- "portrait" (the default/mobile look --
// no body class) and "landscape" (body.k28-in-game, added by six.js's own
// JS once window.innerWidth >= 521 and #gameScreen is showing). Editing
// "Landscape / Desktop" here affects every k28-in-game visitor; editing
// "Mobile Portrait" affects everyone else (including a genuinely portrait
// phone). A `body.k28-in-game` prefix naturally outranks a plain selector
// in CSS specificity, so the landscape rule always wins over the portrait
// rule when both exist and the class is present -- no extra `:not()`
// scoping needed on the portrait side.
// ============================================================================
(function (global) {
  'use strict';

  const SEAT_COUNT = 6;

  const BREAKPOINTS = [
    { key: 'portrait', label: 'Mobile Portrait', bodyClass: null, previewWidth: 390, previewHeight: 844 },
    { key: 'landscape', label: 'Landscape / Desktop', bodyClass: 'k28-in-game', previewWidth: 1400, previewHeight: 900 },
  ];

  // Per-seat elements (position of #seatWrapN, #trickSlotN -- and, via
  // sizeSelector, the card sized inside a trick slot) generated in a loop
  // rather than written out 6 times each, same information Hold'em's own
  // per-seat entries carry, just without any slotFor remap step.
  const ELEMENTS = [];
  for (let i = 0; i < SEAT_COUNT; i++) {
    ELEMENTS.push({
      key: 'seat' + i, label: 'Seat — Slot ' + i + (i === 0 ? ' (You)' : ''), category: 'Seats',
      selector: '#seatWrap' + i, kind: 'position',
      cssProps: { left: 'left', top: 'top' }, fieldUnits: { left: '%', top: '%' },
      extraDecls: 'transform:translate(-50%,-50%) !important;',
    });
  }
  for (let i = 0; i < SEAT_COUNT; i++) {
    ELEMENTS.push({
      key: 'trickSlot' + i, label: 'Played Card — Slot ' + i, category: 'Played Cards',
      selector: '#trickSlot' + i, sizeSelector: '#trickSlot' + i + ' .card', kind: 'position+size',
      cssProps: { left: 'left', top: 'top', width: 'width', height: 'height' },
      fieldUnits: { left: '%', top: '%', width: 'px', height: 'px' },
      extraDecls: 'transform:translate(-50%,-50%) !important;',
    });
  }
  ELEMENTS.push(
    // .hand-bar is normally pinned to the bottom of #gameScreen via
    // position:absolute;bottom:0;left:0;right:0 (an in-flow strip, not a
    // freely positioned box) -- extraDecls detaches it with position:fixed
    // the same way Hold'em's actionBar/betSlider/topbar do, so left/top
    // become meaningful. #handCards itself has no size/position of its
    // own (a plain flex row inside .hand-bar); sizeSelector targets the
    // actual rendered cards instead, same pattern as Hold'em's handStrip.
    { key: 'handBar', label: 'Your Hand', category: 'Cards', selector: '.hand-bar', sizeSelector: '#handCards .card', kind: 'position+size', cssProps: { left: 'left', top: 'top', width: 'width', height: 'height' }, fieldUnits: { left: '%', top: '%', width: 'px', height: 'px' }, extraDecls: 'position:fixed !important;right:auto !important;bottom:auto !important;transform:translate(-50%,-50%) !important;', viewportRelative: true },

    // The six modal popups sharing `.modal-overlay > .modal-box` (or, for
    // 3 of them, a plain unclassed first child div -- see selector below).
    // `.modal-box`/that child is centered by the PARENT's flexbox
    // (align-items/justify-content:center), not by its own left/top --
    // extraDecls detaches it from that centering with position:fixed so a
    // saved left/top percent (of the viewport, same as the parent's own
    // inset:0) actually places it.
    { key: 'roundEndPopup', label: 'Round End Popup', category: 'Popups', selector: '#roundEndOverlay .modal-box', previewToggleSelector: '#roundEndOverlay', kind: 'position+size', cssProps: { left: 'left', top: 'top', width: 'width', height: 'height' }, fieldUnits: { left: '%', top: '%', width: 'px', height: 'px' }, extraDecls: 'position:fixed !important;margin:0 !important;transform:translate(-50%,-50%) !important;', viewportRelative: true },
    { key: 'gameOverPopup', label: 'Game Over Popup', category: 'Popups', selector: '#gameOverOverlay .modal-box', previewToggleSelector: '#gameOverOverlay', kind: 'position+size', cssProps: { left: 'left', top: 'top', width: 'width', height: 'height' }, fieldUnits: { left: '%', top: '%', width: 'px', height: 'px' }, extraDecls: 'position:fixed !important;margin:0 !important;transform:translate(-50%,-50%) !important;', viewportRelative: true },
    { key: 'earlyWinPopup', label: 'Early Win Popup', category: 'Popups', selector: '#earlyWinOverlay .modal-box', previewToggleSelector: '#earlyWinOverlay', kind: 'position+size', cssProps: { left: 'left', top: 'top', width: 'width', height: 'height' }, fieldUnits: { left: '%', top: '%', width: 'px', height: 'px' }, extraDecls: 'position:fixed !important;margin:0 !important;transform:translate(-50%,-50%) !important;', viewportRelative: true },
    { key: 'seatPickerPopup', label: 'Pick-a-Seat Popup', category: 'Popups', selector: '#seatPickerOverlay .modal-box', previewToggleSelector: '#seatPickerOverlay', kind: 'position+size', cssProps: { left: 'left', top: 'top', width: 'width', height: 'height' }, fieldUnits: { left: '%', top: '%', width: 'px', height: 'px' }, extraDecls: 'position:fixed !important;margin:0 !important;transform:translate(-50%,-50%) !important;', viewportRelative: true },
    // hostMenuOverlay / restartConfirmOverlay / leaveConfirmOverlay don't
    // give their inner box its own class/id -- `> div` (their one and
    // only direct child element) is a stable enough selector for it.
    { key: 'hostMenuPopup', label: 'Host Menu Popup', category: 'Popups', selector: '#hostMenuOverlay > div', previewToggleSelector: '#hostMenuOverlay', kind: 'position+size', cssProps: { left: 'left', top: 'top', width: 'width', height: 'height' }, fieldUnits: { left: '%', top: '%', width: 'px', height: 'px' }, extraDecls: 'position:fixed !important;margin:0 !important;transform:translate(-50%,-50%) !important;', viewportRelative: true },
    { key: 'restartConfirmPopup', label: 'Restart Confirm Popup', category: 'Popups', selector: '#restartConfirmOverlay > div', previewToggleSelector: '#restartConfirmOverlay', kind: 'position+size', cssProps: { left: 'left', top: 'top', width: 'width', height: 'height' }, fieldUnits: { left: '%', top: '%', width: 'px', height: 'px' }, extraDecls: 'position:fixed !important;margin:0 !important;transform:translate(-50%,-50%) !important;', viewportRelative: true },
    { key: 'leaveConfirmPopup', label: 'Leave Confirm Popup', category: 'Popups', selector: '#leaveConfirmOverlay > div', previewToggleSelector: '#leaveConfirmOverlay', kind: 'position+size', cssProps: { left: 'left', top: 'top', width: 'width', height: 'height' }, fieldUnits: { left: '%', top: '%', width: 'px', height: 'px' }, extraDecls: 'position:fixed !important;margin:0 !important;transform:translate(-50%,-50%) !important;', viewportRelative: true },

    // Already position:fixed with its own inline left/top/transform in
    // the HTML -- extraDecls only needs to re-assert the vertical
    // centering transform (our left/top override replaces its inline
    // left:10px/top:50% values, but the translateY(-50%) still applies).
    { key: 'midTrickQuotePopup', label: 'Mid-Trick Quote Popup', category: 'Popups', selector: '#midTrickQuoteOverlay', previewToggleSelector: '#midTrickQuoteOverlay', previewToggleMode: 'style', kind: 'position+size', cssProps: { left: 'left', top: 'top', width: 'width', height: 'height' }, fieldUnits: { left: '%', top: '%', width: 'px', height: 'px' }, extraDecls: 'transform:translateY(-50%) !important;', viewportRelative: true },
    // Bid-winner / bid-status: freestanding elements (not inside a
    // `.modal-overlay`), shown/hidden by six.js directly toggling
    // style.display rather than a CSS class -- previewToggleMode 'style'
    // tells the editor to force style.display (not classList) while Edit
    // Table is on, restoring it afterward (see setPreviewOn below).
    { key: 'bidWinnerBubble', label: 'Bid Winner Bubble', category: 'Popups', selector: '#bidWinnerBubble6p', previewToggleSelector: '#bidWinnerBubble6p', previewToggleMode: 'style', kind: 'position+size', cssProps: { left: 'left', top: 'top', width: 'width', height: 'height' }, fieldUnits: { left: '%', top: '%', width: 'px', height: 'px' }, extraDecls: 'position:fixed !important;transform:translate(-50%,-50%) !important;', viewportRelative: true },
    { key: 'bidStatusBanner', label: 'Bid Status Banner', category: 'Popups', selector: '#bidStatusBanner6p', previewToggleSelector: '#bidStatusBanner6p', previewToggleMode: 'style', kind: 'position+size', cssProps: { left: 'left', top: 'top', width: 'width', height: 'height' }, fieldUnits: { left: '%', top: '%', width: 'px', height: 'px' }, extraDecls: 'position:fixed !important;transform:translate(-50%,-50%) !important;', viewportRelative: true },
    // Already position:fixed, positioned/dragged by six.js's own JS
    // (initChatPanelPosition/clampChatPanelToViewport) via plain
    // (non-important) inline left/top -- our !important override wins and
    // pins it, same as every other element here. Shown via its parent
    // #chatOverlay's own `.on` class.
    { key: 'chatPanel', label: 'Chat Panel', category: 'Popups', selector: '#chatPanel', previewToggleSelector: '#chatOverlay', kind: 'position+size', cssProps: { left: 'left', top: 'top', width: 'width', height: 'height' }, fieldUnits: { left: '%', top: '%', width: 'px', height: 'px' }, extraDecls: 'position:fixed !important;' },
  );

  function elementByKey(key) { return ELEMENTS.find((e) => e.key === key) || null; }

  // Keys of popups normally hidden (display:none / no `.on` class) that
  // the editor force-shows (via previewToggleSelector/previewToggleMode)
  // only while Edit Table is on, so they can be selected/dragged here --
  // exactly mirroring Hold'em's PREVIEW_ON_KEYS/setPreviewOnClasses, just
  // generalized to cover both the `.on`-class popups and the handful of
  // plain style.display ones (midTrickQuotePopup, bidWinnerBubble,
  // bidStatusBanner) in one pass.
  const PREVIEW_ON_KEYS = ELEMENTS.filter((e) => e.previewToggleSelector).map((e) => e.key);

  function setPreviewOn(doc, on) {
    if (!doc) return;
    for (const key of PREVIEW_ON_KEYS) {
      const def = elementByKey(key);
      if (!def) continue;
      const el = doc.querySelector(def.previewToggleSelector);
      if (!el) continue;
      if (def.previewToggleMode === 'style') {
        if (on) el.style.setProperty('display', 'block', 'important');
        else el.style.removeProperty('display');
      } else {
        el.classList.toggle('on', !!on);
      }
    }
  }

  function bpForDoc(doc) {
    if (!doc || !doc.body) return 'portrait';
    return doc.body.classList.contains('k28-in-game') ? 'landscape' : 'portrait';
  }

  // Same splitting behavior as layout-engine-holdem.js's declsFor: an
  // optional fieldsSubset lets a merged position+size element (e.g.
  // Played Card — Slot N) emit its left/top onto `selector` and its
  // width/height onto `sizeSelector` as two separate rules.
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
    let css = '/* Generated by the 6-Player Visual Layout Editor -- positioning only. */\n';
    for (const bp of BREAKPOINTS) {
      const values = config[bp.key];
      if (!values || typeof values !== 'object') continue;
      const prefix = bp.bodyClass ? `body.${bp.bodyClass} ` : '';
      let body = '';
      for (const el of ELEMENTS) {
        const v = values[el.key];
        if (!v) continue;
        if (el.sizeSelector) {
          let posDecls = declsFor(el, v, ['left', 'top']);
          if (posDecls && el.extraDecls) posDecls += el.extraDecls;
          const sizeDecls = declsFor(el, v, ['width', 'height']);
          if (posDecls) body += `${prefix}${el.selector}{${posDecls}}\n`;
          if (sizeDecls) body += `${prefix}${el.sizeSelector}{${sizeDecls}}\n`;
        } else {
          let decls = declsFor(el, v);
          if (decls && el.extraDecls) decls += el.extraDecls;
          if (decls) body += `${prefix}${el.selector}{${decls}}\n`;
        }
      }
      if (body) css += body;
    }
    return css;
  }

  function applyCSSConfig(doc, config) {
    if (!doc || !doc.head) return;
    let tag = doc.getElementById('layout-overrides-6p');
    const css = buildOverrideCSS(config);
    if (!tag) {
      tag = doc.createElement('style');
      tag.id = 'layout-overrides-6p';
      doc.head.appendChild(tag);
    } else if (doc.head.lastElementChild !== tag) {
      doc.head.appendChild(tag);
    }
    tag.textContent = css;
  }

  // ---------------------------------------------------------------------
  // Avatar size overrides. Keyed per slot:
  //   config[bp]['avatar'+slot] = { width, height }
  // Applied as inline styles with !important (same priority
  // enforceSeatAvatarSizing6p itself uses, so whichever runs LAST wins --
  // see patchEnforceAvatarSizing below for why that's always us).
  // ---------------------------------------------------------------------
  function applyAvatarStyles(doc, win, config) {
    if (!doc || !config) return;
    const bpKey = bpForDoc(doc);
    const bucket = config[bpKey];
    if (!bucket) return;
    for (let slot = 0; slot < SEAT_COUNT; slot++) {
      const avatar = bucket['avatar' + slot];
      if (!avatar) continue;
      const av = doc.getElementById('av' + slot);
      if (!av) continue;
      if (avatar.width != null) av.style.setProperty('width', avatar.width + 'px', 'important');
      if (avatar.height != null) av.style.setProperty('height', avatar.height + 'px', 'important');
    }
  }

  // Wraps window.enforceSeatAvatarSizing6p() exactly once so every call
  // (every renderSeats() re-render, plus the window 'resize' listener
  // six.js itself wires up) re-applies our saved avatar-size overrides
  // right after the game's own function finishes setting its two
  // hard-coded size sets -- same "wrap original, call it, then layer our
  // own change on top" pattern as layout-engine-holdem.js's
  // patchRenderGameTable.
  function patchEnforceAvatarSizing(win, getConfig) {
    if (!win || typeof win.enforceSeatAvatarSizing6p !== 'function' || win.__layout6pAvatarPatched) return;
    const original = win.enforceSeatAvatarSizing6p;
    win.__layout6pAvatarPatched = true;
    win.enforceSeatAvatarSizing6p = function () {
      const result = original.apply(this, arguments);
      try {
        const config = getConfig ? getConfig() : null;
        if (config) applyAvatarStyles(win.document, win, config);
      } catch (e) { /* not ready / not applicable -- ignore */ }
      return result;
    };
  }

  // `configOrGetter` accepts either a plain config object (the live page,
  // layout-apply-6p.js -- fetched once, never reassigned) or a function
  // returning the CURRENT config (the editor, whose own `config` variable
  // gets reassigned wholesale on load / undo / redo).
  function applyAll(doc, win, configOrGetter) {
    const getConfig = typeof configOrGetter === 'function' ? configOrGetter : () => configOrGetter;
    applyCSSConfig(doc, getConfig());
    patchEnforceAvatarSizing(win, getConfig);
    applyAvatarStyles(doc, win, getConfig());
  }

  // Unlike Hold'em (where forceRerender() replays the last known game
  // state through renderGameTable()), there is no equivalent "redraw
  // everything from the last state" entry point worth calling here for a
  // pure CSS-override position change -- the stylesheet rule from
  // applyCSSConfig takes effect the instant it's written, with nothing
  // left for any JS to redraw. Exposed anyway (calling
  // enforceSeatAvatarSizing6p if present) purely to pick up a fresh
  // avatar-size override immediately after a drag, without waiting for
  // the next real render/resize to trigger the patched function above.
  function forceRerender(win) {
    try { if (win && typeof win.enforceSeatAvatarSizing6p === 'function') win.enforceSeatAvatarSizing6p(); } catch (e) {}
  }

  global.LayoutSix = {
    SEAT_COUNT, BREAKPOINTS, ELEMENTS, PREVIEW_ON_KEYS,
    elementByKey, bpForDoc, buildOverrideCSS, applyCSSConfig,
    applyAvatarStyles, patchEnforceAvatarSizing, applyAll, forceRerender, setPreviewOn,
  };
})(window);
