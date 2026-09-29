// ============================================================================
// layout-editor-holdem.js
//
// Drives the standalone Hold'em Visual Layout Editor
// (layout-editor-holdem.html). Never touches game logic -- it iframes the
// REAL holdem.html (unmodified) and, once you've joined/hosted a table
// inside the frame and a hand is actually in progress (so the real seats
// are on screen), lets you drag the elements LayoutHoldem knows about (see
// layout-engine-holdem.js), building up a plain positioning config that
// gets saved to the server and picked up by every real player's page via
// layout-apply-holdem.js.
//
// Two kinds of editable thing here:
//  - Seats (0-8): position only, applied by wrapping the page's own
//    seatPositions() function (see layout-engine-holdem.js) -- moving one
//    calls forceRerender() so the change shows immediately.
//  - Everything else (avatars, dealer, community cards, hand cards): plain
//    CSS, applied the same way the 4-player editor does it.
// ============================================================================
(function () {
  'use strict';
  const LH = window.LayoutHoldem;

  const frame = document.getElementById('edFrame');
  const frameWrap = document.getElementById('edFrameWrap');
  const stage = document.getElementById('edStage');
  const bpSelect = document.getElementById('edBreakpointSelect');
  const btnEditToggle = document.getElementById('edBtnEditToggle');
  const btnUndo = document.getElementById('edBtnUndo');
  const btnRedo = document.getElementById('edBtnRedo');
  const btnReset = document.getElementById('edBtnReset');
  const btnSave = document.getElementById('edBtnSave');
  const btnZoomOut = document.getElementById('edBtnZoomOut');
  const btnZoomIn = document.getElementById('edBtnZoomIn');
  const btnZoomFit = document.getElementById('edBtnZoomFit');
  const zoomLabel = document.getElementById('edZoomLabel');
  const statusEl = document.getElementById('edStatus');
  const layersEl = document.getElementById('edLayers');
  const inspectorEl = document.getElementById('edInspector');

  let config = { portraitPhoto: {}, landscape: {} };
  let currentBp = LH.BREAKPOINTS[0].key;
  let editMode = false;
  let selectedKey = null;
  let undoStack = [];
  let redoStack = [];
  let overlays = {}; // key -> { box, handle, target, def }
  let dragState = null;
  let rafId = null;
  // null = auto-fit-to-screen (the default); a number = the person picked
  // their own zoom level with the +/-/Fit buttons, and it stays put across
  // resizes/breakpoint switches until they hit Fit again.
  let manualZoom = null;

  // ---------------------------------------------------------------------
  // Layer definitions: 9 seats (bespoke, JS-driven) + the CSS elements
  // LayoutHoldem already knows about.
  // ---------------------------------------------------------------------
  // Seat layers: drag the BODY to move the seat (position, as before);
  // drag the corner HANDLE to resize just THAT seat's avatar. One overlay
  // per seat, so clicking any one avatar only ever affects that one --
  // fixes the earlier bug where a single global "all avatars" control sat
  // visually on top of one seat and resized every seat at once.
  const SEAT_LAYERS = [];
  for (let i = 0; i < LH.SEAT_COUNT; i++) {
    SEAT_LAYERS.push({ key: 'seat' + i, slot: i, label: 'Seat — Slot ' + i + (i === 0 ? ' (You)' : ''), category: 'Seats', type: 'seat', dragKind: 'seatPosSize' });
  }
  // Chip piles: one per seat, position + size, independent of every other
  // seat's pile and of the center table pot (potAnchor, in CSS_LAYERS).
  const CHIP_LAYERS = [];
  for (let i = 0; i < LH.SEAT_COUNT; i++) {
    CHIP_LAYERS.push({ key: 'chipPile' + i, slot: i, label: 'Chip Pile — Slot ' + i + (i === 0 ? ' (You)' : ''), category: 'Chips (per seat)', type: 'chipPile', dragKind: 'posPercent+sizePx' });
  }
  // Dealt (hole) cards at each OTHER seat -- your own two cards are the
  // existing "Your Hand" card size instead, since those render in the
  // hand strip, not at your own seat.
  const CARD_LAYERS = [];
  for (let i = 1; i < LH.SEAT_COUNT; i++) {
    CARD_LAYERS.push({ key: 'cards' + i, slot: i, label: 'Dealt Cards — Slot ' + i, category: 'Dealt Cards (per seat)', type: 'cards', dragKind: 'size' });
  }
  // The numeric chip-count label under each player's name/avatar (e.g.
  // "985") -- text, not a chip disc, so its "size" is just font size.
  const CHIP_LABEL_LAYERS = [];
  for (let i = 0; i < LH.SEAT_COUNT; i++) {
    CHIP_LABEL_LAYERS.push({ key: 'chipLabel' + i, slot: i, label: 'Chip Count — Slot ' + i + (i === 0 ? ' (You)' : ''), category: 'Chip Count (per seat)', type: 'chipLabel', dragKind: 'fontSize' });
  }
  const CSS_DRAG_KIND = {
    dealer: 'posPercent+sizePx',
    boardArea: 'posPercent',
    boardCard: 'size',
    handCard: 'size',
    handStrip: 'posPercent',
    potAnchor: 'posPercent',
    actionBar: 'posPercent+sizePx',
    winnerPopup: 'posPercent',
    tiltPopup: 'posPercent',
  };
  const CSS_LAYERS = LH.ELEMENTS.map((el) => Object.assign({ type: 'css', dragKind: CSS_DRAG_KIND[el.key] || 'size' }, el));
  const ALL_LAYERS = SEAT_LAYERS.concat(CHIP_LAYERS, CARD_LAYERS, CHIP_LABEL_LAYERS, CSS_LAYERS);
  function layerByKey(key) { return ALL_LAYERS.find((l) => l.key === key) || null; }

  function bpInfo(key) { return LH.BREAKPOINTS.find((b) => b.key === key); }
  function cloneConfig() { return JSON.parse(JSON.stringify(config)); }
  function setStatus(text, kind) { statusEl.textContent = text; statusEl.className = kind || ''; }
  function round2(n) { return Math.round(n * 100) / 100; }
  function ensureBpBucket(bpKey) { if (!config[bpKey]) config[bpKey] = {}; return config[bpKey]; }
  function ensureSeatsBucket(bpKey) { const b = ensureBpBucket(bpKey); if (!b.seats) b.seats = {}; return b.seats; }

  // ---------------------------------------------------------------------
  // Breakpoint selector
  // ---------------------------------------------------------------------
  LH.BREAKPOINTS.forEach((bp) => {
    const opt = document.createElement('option');
    opt.value = bp.key; opt.textContent = bp.label;
    bpSelect.appendChild(opt);
  });
  bpSelect.value = currentBp;
  bpSelect.addEventListener('change', () => {
    currentBp = bpSelect.value;
    applyFrameSize();
    selectedKey = null;
    renderInspector();
    renderLayers();
    scheduleRebuildOverlays();
  });

  function applyFrameSize() {
    const bp = bpInfo(currentBp);
    frame.width = bp.previewWidth;
    frame.height = bp.previewHeight;
    frame.style.width = bp.previewWidth + 'px';
    frame.style.height = bp.previewHeight + 'px';
    try { frame.contentWindow.dispatchEvent(new Event('resize')); } catch (e) {}
    fitFrameToStage();
  }

  // The iframe is always rendered at the breakpoint's real device size
  // (e.g. 430x860 for Mobile Portrait) so the page inside sees a real,
  // accurate viewport -- but that's routinely bigger than the actual
  // screen this editor itself is open on (a phone showing "Mobile
  // Portrait" can't fit a 430x860 box without cropping). This scales the
  // WHOLE iframe down visually (CSS transform) to fit whatever room the
  // stage actually has, so the entire table is visible on screen without
  // side-to-side or up-down scrolling -- without changing anything the
  // game itself sees (it still measures/renders at the real 430x860).
  // Click/drag coordinates keep working unmodified: getBoundingClientRect()
  // and mouse events both already reflect the CSS transform automatically.
  function fitFrameToStage() {
    const bp = bpInfo(currentBp);
    frame.style.transform = 'none';
    frame.style.transformOrigin = 'top left';
    frameWrap.style.width = bp.previewWidth + 'px';
    frameWrap.style.height = bp.previewHeight + 'px';
    let scale;
    if (manualZoom != null) {
      // The person picked their own zoom -- respect it exactly, even if
      // that means the table is now bigger than the stage (scrolling
      // inside #edStage, which stays overflow:auto, takes over from there
      // so they can pan to whatever part they're working on).
      scale = manualZoom;
    } else {
      const availW = stage.clientWidth - 4; // small safety margin
      const availH = stage.clientHeight - 4;
      scale = Math.min(1, availW / bp.previewWidth, availH / bp.previewHeight);
    }
    if (scale > 0 && scale !== 1) {
      frame.style.transform = 'scale(' + scale + ')';
      frameWrap.style.width = Math.round(bp.previewWidth * scale) + 'px';
      frameWrap.style.height = Math.round(bp.previewHeight * scale) + 'px';
    }
    zoomLabel.textContent = Math.round(scale * 100) + '%';
    scheduleRebuildOverlays();
  }
  window.addEventListener('resize', () => { if (manualZoom == null) fitFrameToStage(); });

  const ZOOM_STEPS = [0.25, 0.35, 0.5, 0.66, 0.75, 1, 1.25, 1.5, 2];
  function stepZoom(dir) {
    const bp = bpInfo(currentBp);
    const current = manualZoom != null ? manualZoom : Math.min(1, (stage.clientWidth - 4) / bp.previewWidth, (stage.clientHeight - 4) / bp.previewHeight);
    let next;
    if (dir > 0) next = ZOOM_STEPS.find((s) => s > current + 0.001) || ZOOM_STEPS[ZOOM_STEPS.length - 1];
    else next = [...ZOOM_STEPS].reverse().find((s) => s < current - 0.001) || ZOOM_STEPS[0];
    manualZoom = next;
    fitFrameToStage();
  }
  btnZoomOut.addEventListener('click', () => stepZoom(-1));
  btnZoomIn.addEventListener('click', () => stepZoom(1));
  btnZoomFit.addEventListener('click', () => { manualZoom = null; fitFrameToStage(); });

  // ---------------------------------------------------------------------
  // Load existing saved config, then boot the frame
  // ---------------------------------------------------------------------
  fetch('/api/layout-config/holdem')
    .then((r) => r.json())
    .then((data) => {
      if (data && data.ok && data.config) config = Object.assign({ portraitPhoto: {}, landscape: {} }, data.config);
      setStatus("Layout loaded. Join/host a table inside the frame and start a hand, then turn on Edit Table.");
    })
    .catch(() => setStatus('Could not load saved layout (starting from the default table look).', 'error'))
    .finally(() => {
      applyFrameSize();
      renderLayers();
    });

  frame.addEventListener('load', () => {
    try {
      const win = frame.contentWindow;
      // Pass a getter, not `config` itself -- `config` gets reassigned
      // wholesale (loading a saved layout, undo, redo), and the patched
      // seatPositions()/renderGameTable() need to keep reading whatever
      // it CURRENTLY points to, not a snapshot frozen at this moment.
      if (win.LayoutHoldem) win.LayoutHoldem.applyAll(frame.contentDocument, win, () => config);
      setupOverlayMutationObserver(frame.contentDocument, win);
    } catch (e) { /* cross-origin or not-yet-ready -- ignore */ }
    scheduleRebuildOverlays();
  });

  // The live game keeps rebuilding parts of the table on its own (a bot
  // acts, a card lands, chips change) -- most of the time it just updates
  // text/attributes on the SAME DOM nodes, but sometimes (see
  // renderGameTable()'s own innerHTML diffing) it throws away and
  // recreates a seat's inner elements (avatar wrap, chip piles, mini
  // cards, chip-count label) even when nothing WE'RE tracking visually
  // changed. When that happens, the overlay boxes built by rebuildOverlays
  // are still pointing at the OLD, now-detached nodes -- they silently
  // stop tracking position (getBoundingClientRect on a detached node is
  // all-zero) and become unclickable, which is exactly what "I can't go
  // back to editing chips/cards after touching something else" looks
  // like: it's not really about avatars specifically, it's that ANY live
  // update in between can quietly break other overlays' targets. Watching
  // .table-wrap (everything seat/chip/card/dealer/board-related lives
  // inside it; our own .led-box overlays are appended to doc.body, OUTSIDE
  // it, so this can't ever trigger itself) and rebuilding on any change
  // keeps every overlay pointed at a real, current element.
  let overlayMutationObserver = null;
  function setupOverlayMutationObserver(doc, win) {
    if (win.__ledMutationObserverSet) return;
    const tableWrap = doc.querySelector('.table-wrap');
    if (!tableWrap) return;
    win.__ledMutationObserverSet = true;
    overlayMutationObserver = new MutationObserver(() => scheduleRebuildOverlays());
    overlayMutationObserver.observe(tableWrap, { childList: true, subtree: true });
  }

  // ---------------------------------------------------------------------
  // Edit mode toggle
  // ---------------------------------------------------------------------
  btnEditToggle.addEventListener('click', () => {
    editMode = !editMode;
    btnEditToggle.textContent = editMode ? '✏️ Edit Table: ON' : '✏️ Edit Table: OFF';
    btnEditToggle.classList.toggle('active', editMode);
    frame.classList.toggle('editing', editMode);
    if (editMode) { rebuildOverlays(); startLoop(); }
    else { stopLoop(); clearOverlays(); }
  });

  function startLoop() {
    if (rafId) return;
    const tick = () => { repositionOverlays(); rafId = requestAnimationFrame(tick); };
    rafId = requestAnimationFrame(tick);
  }
  function stopLoop() { if (rafId) cancelAnimationFrame(rafId); rafId = null; }

  let rebuildScheduled = false;
  function scheduleRebuildOverlays() {
    if (!editMode || rebuildScheduled) return;
    rebuildScheduled = true;
    setTimeout(() => {
      rebuildScheduled = false;
      // Never yank the DOM out from under an in-progress drag -- rebuilding
      // replaces every overlay element, which would abandon whatever the
      // person is currently mid-drag on. Just retry shortly; a drag is
      // never more than a couple seconds.
      if (dragState) { scheduleRebuildOverlays(); return; }
      rebuildOverlays();
    }, 50);
  }

  // ---------------------------------------------------------------------
  // Find the real DOM element a layer refers to right now (may not exist
  // yet -- e.g. no hand in progress, or no community cards dealt).
  // ---------------------------------------------------------------------
  // Finds which PHYSICAL seat (data-pos) currently sits at a given visual
  // SLOT for this viewer -- the same mapping the real game uses
  // (slotFor()), needed because a slot's physical seat differs per viewer.
  function physicalPosForSlot(doc, win, slot) {
    const seats = [...doc.querySelectorAll('.seat[data-pos]')];
    for (const el of seats) {
      const pos = Number(el.dataset.pos);
      let s = pos;
      try { if (typeof win.slotFor === 'function') s = win.slotFor(pos); } catch (e) {}
      if (s === slot) return pos;
    }
    return null;
  }

  function targetFor(doc, win, def) {
    if (def.type === 'seat') {
      const pos = physicalPosForSlot(doc, win, def.slot);
      return pos == null ? null : doc.querySelector(`.seat[data-pos="${pos}"]`);
    }
    if (def.type === 'chipPile') {
      const pos = physicalPosForSlot(doc, win, def.slot);
      return pos == null ? null : doc.getElementById('railChips' + pos);
    }
    if (def.type === 'cards') {
      const pos = physicalPosForSlot(doc, win, def.slot);
      if (pos == null) return null;
      const seatEl = doc.querySelector(`.seat[data-pos="${pos}"]`);
      return seatEl ? seatEl.querySelector('.seat-cards') : null;
    }
    if (def.type === 'chipLabel') {
      const pos = physicalPosForSlot(doc, win, def.slot);
      if (pos == null) return null;
      const seatEl = doc.querySelector(`.seat[data-pos="${pos}"]`);
      return seatEl ? seatEl.querySelector('.seat-chips') : null;
    }
    return doc.querySelector(def.selector);
  }

  // ---------------------------------------------------------------------
  // Overlay boxes -- live inside the iframe's own document (same-origin).
  // The parent editor page's own stylesheet (layout-editor.css) never
  // reaches into the iframe's separate document, so the .led-box/.led-
  // label/.led-handle rules are injected directly into the iframe here --
  // without this, the boxes exist in the DOM with the right coordinates
  // but render unstyled (no position:fixed, no visible border), making
  // them invisible and unclickable even though everything else works.
  // ---------------------------------------------------------------------
  const OVERLAY_CSS = `
    .led-box{position:fixed;border:3px dashed #4aa3ff;background:rgba(74,163,255,0.18);box-shadow:0 0 0 1px rgba(0,0,0,0.6),0 0 14px rgba(74,163,255,0.7);z-index:2147483000;cursor:move;box-sizing:border-box;animation:led-pulse 1.6s ease-in-out infinite}
    .led-box.led-nodrag{cursor:default}
    .led-box.led-selected{border-color:#f4c430;border-style:solid;background:rgba(244,196,48,0.22);box-shadow:0 0 0 1px rgba(0,0,0,0.6),0 0 18px rgba(244,196,48,0.9);z-index:2147483001;animation:none}
    .led-box.led-dimmed{opacity:0.2;animation:none}
    @keyframes led-pulse{0%,100%{opacity:1}50%{opacity:0.6}}
    .led-label{position:absolute;top:-22px;left:-3px;background:#12181f;color:#e8edf2;font:800 11px -apple-system,sans-serif;padding:3px 7px;border-radius:4px;white-space:nowrap;pointer-events:none;box-shadow:0 2px 6px rgba(0,0,0,0.6);border:1px solid rgba(74,163,255,0.6)}
    .led-box.led-selected .led-label{background:#f4c430;color:#241a12;border-color:#f4c430}
    .led-handle{position:absolute;width:18px;height:18px;background:#f4c430;border:2.5px solid #241a12;border-radius:4px;cursor:nwse-resize;z-index:2147483002;box-shadow:0 2px 8px rgba(0,0,0,0.6)}
    .led-handle.led-br{right:-10px;bottom:-10px}
  `;
  function ensureOverlayStyles(doc) {
    if (!doc || !doc.head) return;
    let tag = doc.getElementById('led-overlay-styles');
    if (!tag) {
      tag = doc.createElement('style');
      tag.id = 'led-overlay-styles';
      doc.head.appendChild(tag);
    }
    tag.textContent = OVERLAY_CSS;
  }

  function clearOverlays() {
    let doc;
    try { doc = frame.contentDocument; } catch (e) { doc = null; }
    if (doc) doc.querySelectorAll('.led-box').forEach((n) => n.remove());
    overlays = {};
  }

  function rebuildOverlays() {
    let doc, win;
    try { doc = frame.contentDocument; win = frame.contentWindow; } catch (e) { return; }
    if (!doc || !doc.body) return;
    clearOverlays();
    if (!editMode) return;
    ensureOverlayStyles(doc);
    ALL_LAYERS.forEach((def) => {
      const target = targetFor(doc, win, def);
      if (!target) return;
      const rect = target.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return;
      const box = doc.createElement('div');
      box.className = 'led-box';
      const label = doc.createElement('div');
      label.className = 'led-label';
      label.textContent = def.label;
      box.appendChild(label);
      let handle = null;
      if (def.dragKind === 'size' || def.dragKind === 'posPercent+sizePx' || def.dragKind === 'seatPosSize' || def.dragKind === 'fontSize') {
        handle = doc.createElement('div');
        handle.className = 'led-handle led-br';
        box.appendChild(handle);
      }
      doc.body.appendChild(box);
      overlays[def.key] = { box, handle, target, def };
      wireBoxEvents(doc, win, def, box, handle);
    });
    repositionOverlays();
    setSelected(selectedKey);
    wireBackgroundDeselect(doc, win);
  }

  // Overlapping boxes are unavoidable on a crowded 9-seat table (an
  // avatar, its chip pile, its dealt cards and its chip-count label can
  // all sit in nearly the same spot), and whichever box happened to be on
  // top used to "win" every click there -- resizing the avatar could
  // actually grab the cards box underneath it instead. Once something is
  // selected, every OTHER box stops accepting pointer events (still
  // visible, just dimmed and click-through) so a drag can only ever reach
  // the one element you picked. Tapping the empty table background (or
  // the selected box itself, to re-drag it) is unaffected; to switch to a
  // different overlapping element, use the Layers list, which is always
  // unambiguous, or tap empty space first to deselect.
  function wireBackgroundDeselect(doc, win) {
    if (win.__ledDeselectWired) return;
    win.__ledDeselectWired = true;
    doc.body.addEventListener('pointerdown', (ev) => {
      const hitBox = ev.target && ev.target.closest && ev.target.closest('.led-box');
      if (!hitBox) selectElement(null);
    });
  }

  // Comfortable minimum touch/click target -- several real elements (a
  // single chip disc, a mini card back) are only 8-20px on screen, which
  // is unusable to tap precisely, worse once the whole table is scaled
  // down to fit a phone screen. The VISIBLE border still traces the real
  // element, but the box is inflated (symmetrically, around the same
  // center) to at least this size so it's actually possible to hit.
  const MIN_TOUCH_TARGET = 30;
  function repositionOverlays() {
    Object.values(overlays).forEach(({ box, target }) => {
      const r = target.getBoundingClientRect();
      if (r.width === 0 && r.height === 0 && r.left === 0 && r.top === 0) {
        // Detached/gone (e.g. the game re-rendered and replaced this DOM
        // node before a rebuild caught up) -- hide rather than show a
        // bogus box pinned to the corner. scheduleRebuildOverlays (driven
        // by the MutationObserver below) will drop or replace this entry
        // shortly.
        box.style.display = 'none';
        return;
      }
      box.style.display = '';
      let left = r.left, top = r.top, width = r.width, height = r.height;
      if (width < MIN_TOUCH_TARGET) { left -= (MIN_TOUCH_TARGET - width) / 2; width = MIN_TOUCH_TARGET; }
      if (height < MIN_TOUCH_TARGET) { top -= (MIN_TOUCH_TARGET - height) / 2; height = MIN_TOUCH_TARGET; }
      box.style.left = left + 'px';
      box.style.top = top + 'px';
      box.style.width = width + 'px';
      box.style.height = height + 'px';
    });
  }

  // ---------------------------------------------------------------------
  // Drag / resize
  // ---------------------------------------------------------------------
  function wireBoxEvents(doc, win, def, box, handle) {
    box.addEventListener('pointerdown', (ev) => {
      if (ev.target === handle) return;
      selectElement(def.key);
      if (def.dragKind === 'size' || def.dragKind === 'fontSize') return; // resize-only elements have no body-drag
      beginDrag(doc, win, def, ev, 'move');
    });
    if (handle) {
      handle.addEventListener('pointerdown', (ev) => {
        ev.stopPropagation();
        selectElement(def.key);
        beginDrag(doc, win, def, ev, 'resize');
      });
    }
  }

  function tableRectOf(doc) {
    const tw = doc.querySelector('.table-wrap');
    if (tw) return tw.getBoundingClientRect();
    return { left: 0, top: 0, width: doc.documentElement.clientWidth, height: doc.documentElement.clientHeight };
  }
  // A few real elements (the action bar, your hand, the two popups) use
  // position:fixed in the actual game CSS, not position:absolute inside
  // .table-wrap -- their left/top percentages are relative to the whole
  // viewport, not the table. Dragging them with table-relative percentages
  // would compute a plausible-looking number that lands somewhere else
  // entirely once applied (a different % of a different box). `def`s for
  // those set `viewportRelative: true` (see layout-engine-holdem.js).
  function referenceRectOf(doc, def) {
    if (def && def.viewportRelative) {
      return { left: 0, top: 0, width: doc.documentElement.clientWidth, height: doc.documentElement.clientHeight };
    }
    return tableRectOf(doc);
  }

  function beginDrag(doc, win, def, ev, mode) {
    ev.preventDefault();
    pushUndoSnapshot();
    const startX = ev.clientX, startY = ev.clientY;
    const tableRect = referenceRectOf(doc, def);
    const startVal = Object.assign({}, effectiveValue(doc, win, def));
    dragState = { def, mode, startX, startY, startVal, tableRect, doc, win };
    const onMove = (mv) => handleDragMove(mv);
    const onUp = () => {
      doc.removeEventListener('pointermove', onMove);
      doc.removeEventListener('pointerup', onUp);
      dragState = null;
    };
    doc.addEventListener('pointermove', onMove);
    doc.addEventListener('pointerup', onUp);
  }

  function handleDragMove(ev) {
    if (!dragState) return;
    const { def, mode, startX, startY, startVal, tableRect, doc, win } = dragState;
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    const cur = Object.assign({}, startVal);

    if (def.type === 'seat') {
      if (mode === 'resize') {
        // Corner handle: resize just THIS seat's avatar. Stored
        // separately from seat position (its own flat key, 'avatar'+slot)
        // so moving a seat never touches its size and vice versa.
        cur.width = Math.max(8, Math.round(startVal.width + dx));
        cur.height = Math.max(8, Math.round(startVal.height + dy));
        ensureBpBucket(currentBp)['avatar' + def.slot] = { width: cur.width, height: cur.height };
      } else {
        // Body drag: move just this seat (unchanged from before).
        cur.x = round2(startVal.x + (dx / tableRect.width) * 100);
        cur.y = round2(startVal.y + (dy / tableRect.height) * 100);
        ensureSeatsBucket(currentBp)[def.slot] = { x: cur.x, y: cur.y };
      }
      try { if (win.LayoutHoldem) win.LayoutHoldem.forceRerender(); } catch (e) {}
    } else {
      const bucket = ensureBpBucket(currentBp);
      if (def.dragKind === 'size') {
        cur.width = Math.max(8, Math.round(startVal.width + dx));
        cur.height = Math.max(8, Math.round(startVal.height + dy));
      } else if (def.dragKind === 'posPercent') {
        cur.left = round2(startVal.left + (dx / tableRect.width) * 100);
        cur.top = round2(startVal.top + (dy / tableRect.height) * 100);
      } else if (def.dragKind === 'posPercent+sizePx') {
        if (mode === 'move') {
          cur.left = round2(startVal.left + (dx / tableRect.width) * 100);
          cur.top = round2(startVal.top + (dy / tableRect.height) * 100);
        } else {
          cur.width = Math.max(8, Math.round(startVal.width + dx));
          cur.height = Math.max(8, Math.round(startVal.height + dy));
        }
      } else if (def.dragKind === 'fontSize') {
        cur.fontSize = Math.max(6, Math.round(startVal.fontSize + dy));
      }
      bucket[def.key] = cur;
      if (def.type === 'css') {
        try { LH.applyCSSConfig(doc, config); } catch (e) {}
      } else {
        // Per-seat chip pile / dealt-card overrides aren't CSS-selector
        // based (see layout-engine-holdem.js) -- re-apply directly.
        try { if (win.LayoutHoldem) win.LayoutHoldem.applySeatStyles(doc, win, config); } catch (e) {}
      }
    }
    repositionOverlays();
    if (selectedKey === def.key) renderInspector();
    markLayerEdited(def.key);
  }

  // ---------------------------------------------------------------------
  // Reading the live/current value of a layer (used as the drag start
  // point and to pre-fill the inspector) -- always prefers a real
  // on-screen measurement over any hardcoded number, so it's automatically
  // correct even if the game's own CSS/positions get retuned later.
  // ---------------------------------------------------------------------
  function effectiveValue(doc, win, def) {
    const bucket = config[currentBp] || {};
    if (def.type === 'seat') {
      const savedPos = bucket.seats && bucket.seats[def.slot];
      const savedSize = bucket['avatar' + def.slot];
      const target = targetFor(doc, win, def);
      let x = 50, y = 50;
      if (savedPos) { x = savedPos.x; y = savedPos.y; }
      else if (target && target.style.left && target.style.top) { x = parseFloat(target.style.left) || 0; y = parseFloat(target.style.top) || 0; }
      let width = 46, height = 46;
      const avatarEl = target && target.querySelector('.seat-avatar-wrap');
      if (savedSize) { width = savedSize.width; height = savedSize.height; }
      else if (avatarEl) { const r = avatarEl.getBoundingClientRect(); width = Math.round(r.width); height = Math.round(r.height); }
      return { x, y, width, height };
    }
    const saved = bucket[def.key];
    const target = targetFor(doc, win, def);
    let live = {};
    if (target) {
      const rect = target.getBoundingClientRect();
      const tableRect = referenceRectOf(doc, def);
      if (def.dragKind === 'size') {
        live = { width: Math.round(rect.width), height: Math.round(rect.height) };
      } else if (def.dragKind === 'posPercent') {
        const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
        live = { left: round2(((cx - tableRect.left) / tableRect.width) * 100), top: round2(((cy - tableRect.top) / tableRect.height) * 100) };
      } else if (def.dragKind === 'posPercent+sizePx') {
        const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
        live = {
          left: round2(((cx - tableRect.left) / tableRect.width) * 100), top: round2(((cy - tableRect.top) / tableRect.height) * 100),
          width: Math.round(rect.width), height: Math.round(rect.height),
        };
      } else if (def.dragKind === 'fontSize') {
        live = { fontSize: Math.round(parseFloat(win.getComputedStyle(target).fontSize)) || 10 };
      }
    } else if (def.dragKind === 'size') {
      // Reasonable fallbacks for when nothing's on screen yet to measure
      // (e.g. no hand dealt, no cards dealt to that seat yet) -- overwritten
      // the instant a real element shows up, and self-correcting on the
      // very next read.
      const SIZE_FALLBACKS = { boardCard: { width: 44, height: 62 }, handCard: { width: 44, height: 62 } };
      live = SIZE_FALLBACKS[def.key] || { width: 44, height: 62 };
    } else if (def.dragKind === 'fontSize') {
      live = { fontSize: 10 };
    }
    return Object.assign({}, live, saved || {});
  }

  // ---------------------------------------------------------------------
  // Selection + Layers panel
  // ---------------------------------------------------------------------
  function selectElement(key) { selectedKey = key; setSelected(key); renderInspector(); renderLayers(); }
  function setSelected(key) {
    Object.entries(overlays).forEach(([k, o]) => {
      const isSel = k === key;
      o.box.classList.toggle('led-selected', isSel);
      if (key) {
        // Only the selected box can be clicked/dragged -- see
        // wireBackgroundDeselect above for why this matters.
        o.box.style.pointerEvents = isSel ? 'auto' : 'none';
        o.box.classList.toggle('led-dimmed', !isSel);
      } else {
        o.box.style.pointerEvents = 'auto';
        o.box.classList.remove('led-dimmed');
      }
    });
  }

  function isEdited(def) {
    const bucket = config[currentBp];
    if (!bucket) return false;
    if (def.type === 'seat') return !!(bucket.seats && bucket.seats[def.slot]) || !!bucket['avatar' + def.slot];
    return !!bucket[def.key];
  }

  function renderLayers() {
    const byCategory = {};
    ALL_LAYERS.forEach((def) => { (byCategory[def.category] = byCategory[def.category] || []).push(def); });
    layersEl.innerHTML = '';
    Object.entries(byCategory).forEach(([cat, defs]) => {
      const group = document.createElement('div');
      group.className = 'ed-layer-group';
      const label = document.createElement('div');
      label.className = 'ed-layer-group-label';
      label.textContent = cat;
      group.appendChild(label);
      defs.forEach((def) => {
        const row = document.createElement('div');
        row.className = 'ed-layer-row' + (def.key === selectedKey ? ' selected' : '') + (isEdited(def) ? ' edited' : '');
        row.dataset.key = def.key;
        row.innerHTML = '<span class="ed-dot"></span><span>' + def.label + '</span>';
        row.addEventListener('click', () => selectElement(def.key));
        group.appendChild(row);
      });
      layersEl.appendChild(group);
    });
  }
  function markLayerEdited(key) {
    const row = layersEl.querySelector('.ed-layer-row[data-key="' + key + '"]');
    if (row) row.classList.add('edited');
  }

  // ---------------------------------------------------------------------
  // Inspector (precise numeric entry -- works with or without Edit Table on)
  // ---------------------------------------------------------------------
  const FIELD_META = { x: { label: 'X', unit: '%' }, y: { label: 'Y', unit: '%' }, left: { label: 'X', unit: '%' }, top: { label: 'Y', unit: '%' }, width: { label: 'W', unit: 'px' }, height: { label: 'H', unit: 'px' }, fontSize: { label: 'Size', unit: 'px' } };
  function fieldsFor(def) {
    if (def.type === 'seat') return ['x', 'y', 'width', 'height'];
    if (def.dragKind === 'size') return ['width', 'height'];
    if (def.dragKind === 'posPercent') return ['left', 'top'];
    if (def.dragKind === 'fontSize') return ['fontSize'];
    return ['left', 'top', 'width', 'height'];
  }
  function renderInspector() {
    if (!selectedKey) { inspectorEl.innerHTML = '<div class="ed-inspector-empty">Join or host a table inside the frame and start a hand so the real seats are on screen, turn on Edit Table, then click an element (or pick one from Layers) to adjust it here.</div>'; return; }
    const def = layerByKey(selectedKey);
    let doc, win;
    try { doc = frame.contentDocument; win = frame.contentWindow; } catch (e) { doc = null; win = null; }
    const val = doc ? effectiveValue(doc, win, def) : {};
    let html = '<div id="edInspectorTitle">' + def.label + '</div>';
    html += '<div id="edInspectorMeta">' + def.category + ' · ' + bpInfo(currentBp).label + '</div>';
    fieldsFor(def).forEach((field) => {
      const meta = FIELD_META[field];
      html += '<div class="ed-field-row"><label>' + meta.label + '</label><input type="number" step="any" data-field="' + field + '" value="' + (val[field] !== undefined ? val[field] : '') + '"><span class="ed-unit">' + meta.unit + '</span></div>';
    });
    inspectorEl.innerHTML = html;
    inspectorEl.querySelectorAll('input[data-field]').forEach((input) => {
      input.addEventListener('change', () => {
        pushUndoSnapshot();
        let d, w;
        try { d = frame.contentDocument; w = frame.contentWindow; } catch (e) { d = null; w = null; }
        const cur = Object.assign({}, d ? effectiveValue(d, w, def) : {});
        cur[input.dataset.field] = Number(input.value) || 0;
        if (def.type === 'seat') {
          const field = input.dataset.field;
          if (field === 'x' || field === 'y') {
            ensureSeatsBucket(currentBp)[def.slot] = { x: cur.x, y: cur.y };
          } else {
            ensureBpBucket(currentBp)['avatar' + def.slot] = { width: cur.width, height: cur.height };
          }
          try { if (w && w.LayoutHoldem) w.LayoutHoldem.forceRerender(); } catch (e) {}
        } else {
          ensureBpBucket(currentBp)[def.key] = cur;
          if (d) {
            if (def.type === 'css') { try { LH.applyCSSConfig(d, config); } catch (e) {} }
            else { try { if (w && w.LayoutHoldem) w.LayoutHoldem.applySeatStyles(d, w, config); } catch (e) {} }
          }
        }
        repositionOverlays();
        renderLayers();
      });
    });
  }

  // ---------------------------------------------------------------------
  // Undo / Redo
  // ---------------------------------------------------------------------
  function pushUndoSnapshot() {
    undoStack.push(cloneConfig());
    if (undoStack.length > 100) undoStack.shift();
    redoStack = [];
    updateUndoRedoButtons();
  }
  function updateUndoRedoButtons() {
    btnUndo.disabled = undoStack.length === 0;
    btnRedo.disabled = redoStack.length === 0;
  }
  btnUndo.addEventListener('click', () => {
    if (!undoStack.length) return;
    redoStack.push(cloneConfig());
    config = undoStack.pop();
    afterConfigReplaced();
  });
  btnRedo.addEventListener('click', () => {
    if (!redoStack.length) return;
    undoStack.push(cloneConfig());
    config = redoStack.pop();
    afterConfigReplaced();
  });
  function afterConfigReplaced() {
    updateUndoRedoButtons();
    let doc, win;
    try { doc = frame.contentDocument; win = frame.contentWindow; } catch (e) { doc = null; win = null; }
    if (doc) {
      try { LH.applyCSSConfig(doc, config); } catch (e) {}
      try { if (win && win.LayoutHoldem) win.LayoutHoldem.forceRerender(); } catch (e) {}
    }
    repositionOverlays();
    renderLayers();
    renderInspector();
  }

  // ---------------------------------------------------------------------
  // Reset / Save
  // ---------------------------------------------------------------------
  btnReset.addEventListener('click', () => {
    if (!confirm('Reset the "' + bpInfo(currentBp).label + '" layout back to the default table look? This clears your edits for this breakpoint only (Undo still works if you change your mind).')) return;
    pushUndoSnapshot();
    config[currentBp] = {};
    afterConfigReplaced();
  });

  btnSave.addEventListener('click', () => {
    const pw = prompt('Admin password to publish this layout for every player:');
    if (pw === null) return;
    setStatus('Saving…');
    fetch('/api/admin/layout-config/holdem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-password': pw },
      body: JSON.stringify({ config }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data && data.ok) setStatus('Saved — live for every player now.', 'saved');
        else setStatus('Save failed: ' + (data && data.error === 'bad_password' ? 'wrong password' : (data && data.error) || 'unknown error'), 'error');
      })
      .catch(() => setStatus('Save failed: network error.', 'error'));
  });

  updateUndoRedoButtons();
})();
