// ============================================================================
// layout-engine-4p.js
//
// Shared between the live 4-player game page (index.html, via
// layout-apply.js) and the standalone visual editor (layout-editor.html).
//
// This is PURELY a visual-positioning layer: a declarative registry of which
// existing DOM elements can be repositioned/resized/rotated, plus a function
// that turns a saved config object into a small CSS <style> override block.
// It never reads or writes any game state, never calls any game function,
// and never changes any element's content -- only position/size CSS
// properties on elements that already exist in the page today.
//
// Scope (v1): the two breakpoints that already use real absolute (%-based)
// positioning in the existing stylesheet -- "portrait" (mobile portrait /
// desktop-narrow photo table) and "desktopWide" (wide desktop photo table).
// The base/mobile-landscape mode uses CSS Grid (grid-area) for seats, which
// isn't a drag-to-percentage layout without restructuring it -- deliberately
// left untouched for now rather than risk rebuilding part of the table.
// ============================================================================
(function (global) {
  'use strict';

  const BREAKPOINTS = [
    {
      key: 'portrait',
      label: 'Mobile Portrait / Narrow Desktop',
      mediaOpen: '@media (orientation: portrait), (min-width: 521px) {',
      mediaClose: '}',
      inGameOnly: false,
      // Preview frame size used by the editor when simulating this breakpoint.
      previewWidth: 430,
      previewHeight: 860,
    },
    {
      key: 'desktopWide',
      label: 'Desktop Wide',
      mediaOpen: '@media (min-width: 700px) {',
      mediaClose: '}',
      inGameOnly: true, // rules need a `body.k28-in-game` prefix to match the original scoping
      previewWidth: 1400,
      previewHeight: 900,
    },
  ];

  // Each element: key, label, category (for the layers panel), the DOM
  // selector, which kind of edit it supports, and how its saved values map
  // to real CSS properties. `unit` 'percent' values are relative to
  // #tableArea's own box (the real containing block for every .pspot seat,
  // confirmed against the existing stylesheet); 'px' values are literal
  // pixels (used for fixed-position floating buttons and small nudges).
  const ELEMENTS = [
    { key: 'pos0', label: 'Seat — Top', category: 'Seats', selector: '#pos0', kind: 'position', unit: 'percent', cssProps: { left: 'left', top: 'top' } },
    { key: 'pos1', label: 'Seat — Left', category: 'Seats', selector: '#pos1', kind: 'position', unit: 'percent', cssProps: { left: 'left', top: 'top' } },
    { key: 'pos2', label: 'Seat — Right', category: 'Seats', selector: '#pos2', kind: 'position', unit: 'percent', cssProps: { left: 'left', top: 'top' } },
    { key: 'pos3', label: 'Seat — You (Bottom)', category: 'Seats', selector: '#pos3', kind: 'position', unit: 'percent', cssProps: { left: 'left', top: 'top' } },

    { key: 'av0', label: 'Avatar — Top', category: 'Avatars', selector: '#av0', kind: 'size', unit: 'px', cssProps: { width: 'width', height: 'height' } },
    { key: 'av1', label: 'Avatar — Left', category: 'Avatars', selector: '#av1', kind: 'size', unit: 'px', cssProps: { width: 'width', height: 'height' } },
    { key: 'av2', label: 'Avatar — Right', category: 'Avatars', selector: '#av2', kind: 'size', unit: 'px', cssProps: { width: 'width', height: 'height' } },
    { key: 'av3', label: 'Avatar — You (Bottom)', category: 'Avatars', selector: '#av3', kind: 'size', unit: 'px', cssProps: { width: 'width', height: 'height' } },

    { key: 'handAreaCard', label: 'Your Hand (Card Size)', category: 'Cards', selector: '#handArea .card', kind: 'size', unit: 'px', cssProps: { width: 'width', height: 'height' } },
    { key: 'cross', label: 'Played Cards (Center)', category: 'Cards', selector: '.center .cross', kind: 'nudge+size', unit: 'px', cssProps: { left: 'left', top: 'top', width: 'width', height: 'height' }, needsPositionRelative: true },

    { key: 'chipBL', label: 'Chip Stack — Bottom Left', category: 'Chips', selector: '.chip-stack.cs-bl', kind: 'corner', corner: 'bl', unit: 'px', cssProps: { left: 'left', bottom: 'bottom' } },
    { key: 'chipBR', label: 'Chip Stack — Bottom Right', category: 'Chips', selector: '.chip-stack.cs-br', kind: 'corner', corner: 'br', unit: 'px', cssProps: { right: 'right', bottom: 'bottom' } },

    { key: 'btnChat', label: 'Chat Button', category: 'Buttons', selector: '#btnChat', kind: 'corner', corner: 'br', unit: 'px', cssProps: { right: 'right', bottom: 'bottom' }, notBreakpointSpecific: true },
    { key: 'btnQuoteDeclare', label: 'Declare COT Button', category: 'Buttons', selector: '#btnQuoteDeclare', kind: 'corner', corner: 'br', unit: 'px', cssProps: { right: 'right', bottom: 'bottom' }, notBreakpointSpecific: true },
    { key: 'btnSoundMute', label: 'Sound Mute Button', category: 'Buttons', selector: '#btnSoundMute', kind: 'corner', corner: 'bl', unit: 'px', cssProps: { left: 'left', bottom: 'bottom' }, notBreakpointSpecific: true },
  ];

  function elementByKey(key) { return ELEMENTS.find((e) => e.key === key) || null; }

  // Best-known starting values, read directly from the existing stylesheet
  // (see the layout-mapping research this editor was built from). These are
  // ONLY used as a starting point to show in the editor's numeric inspector
  // before anything has been edited, and as the reference point for the
  // very first drag on an element -- they never overwrite the real page's
  // own CSS by themselves (only an actual saved override does that). If one
  // of these is slightly stale, the worst case is a slightly-off starting
  // number in the inspector; live dragging always reads the element's real
  // on-screen position first, so it's self-correcting the moment you touch it.
  const DEFAULTS = {
    portrait: {
      pos0: { left: 50, top: 17 }, pos1: { left: 9, top: 45 }, pos2: { left: 91, top: 45 }, pos3: { left: 50, top: 68 },
      av0: { width: 91, height: 116 }, av1: { width: 91, height: 116 }, av2: { width: 91, height: 116 }, av3: { width: 160, height: 203 },
      handAreaCard: { width: 52, height: 74 },
      cross: { left: 0, top: 0, width: 200, height: 150 },
      chipBL: { left: 6, bottom: 6 }, chipBR: { right: 6, bottom: 6 },
      btnChat: { right: 8, bottom: 110 }, btnQuoteDeclare: { right: 48, bottom: 150 }, btnSoundMute: { left: 64, bottom: 40 },
    },
    desktopWide: {
      pos0: { left: 50, top: 18 }, pos1: { left: 21, top: 44 }, pos2: { left: 79, top: 44 }, pos3: { left: 50, top: 75 },
      av0: { width: 207, height: 207 }, av1: { width: 207, height: 207 }, av2: { width: 207, height: 207 }, av3: { width: 228, height: 228 },
      handAreaCard: { width: 80, height: 105 },
      cross: { left: 0, top: 0, width: 220, height: 210 },
      chipBL: { left: 6, bottom: 6 }, chipBR: { right: 6, bottom: 6 },
      btnChat: { right: 8, bottom: 110 }, btnQuoteDeclare: { right: 48, bottom: 150 }, btnSoundMute: { left: 64, bottom: 40 },
    },
  };
  function defaultsFor(bpKey, key) { return (DEFAULTS[bpKey] && DEFAULTS[bpKey][key]) || {}; }
  // Effective value = saved override, falling back field-by-field to the
  // known default -- so a partial override (e.g. only "top" ever dragged)
  // still shows a sensible "left" starting number.
  function effectiveValue(config, bpKey, key) {
    const d = defaultsFor(bpKey, key);
    const v = (config && config[bpKey] && config[bpKey][key]) || {};
    return Object.assign({}, d, v);
  }

  // Builds one CSS declaration block's body (no selector/braces) for a given
  // element + its saved values object for one breakpoint.
  function declsFor(el, values) {
    if (!values) return '';
    let out = '';
    if (el.needsPositionRelative) out += 'position:relative !important;';
    for (const [field, cssProp] of Object.entries(el.cssProps)) {
      const v = values[field];
      if (v === undefined || v === null || v === '') continue;
      const suffix = el.unit === 'percent' ? '%' : 'px';
      out += `${cssProp}:${v}${suffix} !important;`;
    }
    return out;
  }

  // Turns a full saved config ({ portrait: {elKey:{...}}, desktopWide: {...} })
  // into one CSS string, safe to drop into a <style> tag. Each breakpoint's
  // rules are wrapped in the SAME media condition the game's own CSS already
  // uses for that breakpoint, so on a real visitor's device the override
  // naturally only takes effect exactly when the matching layout is showing
  // -- never at the wrong breakpoint, and never during the base mobile-
  // landscape grid mode (which isn't in this registry at all).
  function buildOverrideCSS(config) {
    if (!config || typeof config !== 'object') return '';
    let css = '/* Generated by the Visual Layout Editor -- positioning only. */\n';
    for (const bp of BREAKPOINTS) {
      const values = config[bp.key];
      if (!values || typeof values !== 'object') continue;
      let body = '';
      for (const el of ELEMENTS) {
        if (el.notBreakpointSpecific) continue; // handled once, below, outside any breakpoint
        const decls = declsFor(el, values[el.key]);
        if (!decls) continue;
        const selector = bp.inGameOnly ? `body.k28-in-game ${el.selector}` : el.selector;
        body += `${selector}{${decls}}\n`;
      }
      if (!body) continue;
      css += `${bp.mediaOpen}\n${body}${bp.mediaClose}\n`;
    }
    // Floating buttons are position:fixed and, per the existing CSS, are the
    // same at every breakpoint -- a single unconditional block covers them.
    let fixedBody = '';
    for (const el of ELEMENTS) {
      if (!el.notBreakpointSpecific) continue;
      // Use whichever breakpoint's saved value exists first; these are meant
      // to be edited once, not per-breakpoint, since the game itself never
      // varies them.
      const values = (config.desktopWide && config.desktopWide[el.key]) || (config.portrait && config.portrait[el.key]);
      const decls = declsFor(el, values);
      if (!decls) continue;
      fixedBody += `${el.selector}{${decls}}\n`;
    }
    if (fixedBody) css += fixedBody;
    return css;
  }

  // Injects (or replaces) the override <style> tag in the given document.
  // Always appended last in <head> so it wins the cascade against the
  // existing stylesheet without needing to reproduce its exact selectors.
  function applyConfig(doc, config) {
    if (!doc) return;
    let tag = doc.getElementById('layout-overrides-4p');
    const css = buildOverrideCSS(config);
    if (!tag) {
      tag = doc.createElement('style');
      tag.id = 'layout-overrides-4p';
      doc.head.appendChild(tag);
    } else if (tag.parentNode !== doc.head || doc.head.lastElementChild !== tag) {
      // Keep it last in <head> even if other stylesheets load after our
      // first injection (e.g. the redesign2026 layer defined later in the
      // file) -- re-append moves an existing node rather than duplicating it.
      doc.head.appendChild(tag);
    }
    tag.textContent = css;
  }

  global.Layout4P = { BREAKPOINTS, ELEMENTS, elementByKey, buildOverrideCSS, applyConfig, DEFAULTS, defaultsFor, effectiveValue };
})(window);
