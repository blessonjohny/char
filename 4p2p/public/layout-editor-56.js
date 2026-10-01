// ============================================================================
// layout-editor-56.js
//
// Drives the standalone 56 Visual Layout Editor (layout-editor-56.html).
// Never touches game logic -- it iframes the REAL 56.html (unmodified) and,
// once you've joined/hosted a table inside the frame, lets you drag the
// elements LayoutFiftySix knows about (see layout-engine-56.js), building up
// a plain positioning config that gets saved to the server and picked up by
// every real player's page via layout-apply-56.js.
//
// Adapted from layout-editor-6p.js (the proven toolbar/dropdown/zoom/drag
// logic is reused as-is) with two real differences, both explained in full
// in layout-engine-56.js's header comment:
//  - Seats are a SEPARATE layer type ('seatSlot', by DISPLAY SLOT, not by
//    raw seat) applied via LH.applySeatSlotPositions()/LH.elementForSlot()
//    instead of the CSS-injection LH.applyCSSConfig() path every other
//    element here uses -- 56.html keys its seat DOM by raw seat index while
//    the on-screen position is a per-viewer remap, which a plain CSS
//    selector can't express.
//  - No avatar-size layer, no chip piles (same non-betting trick/point game
//    shape as 6p), and only ONE combined "Overlay / Popup Box" layer for the
//    single shared `#overlay` element every 56.html popup funnels through.
// ============================================================================
(function () {
  'use strict';
  const LH = window.LayoutFiftySix;

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
  const btnLayersToggle = document.getElementById('edBtnLayersToggle');
  const layersPanel = document.getElementById('edLayersPanel');

  let config = { mobile: {}, desktop: {} };
  let currentBp = LH.BREAKPOINTS[0].key;
  let editMode = false;
  let selectedKey = null;
  let undoStack = [];
  let redoStack = [];
  let overlays = {}; // key -> { box, handle, target, def }
  let dragState = null;
  let rafId = null;
  let manualZoom = null;
  let currentScale = 1;

  // ---------------------------------------------------------------------
  // Toolbar dropdown (Layers) -- positioned in real viewport coordinates
  // from the trigger button's actual on-screen position, clamped so the
  // panel can never run off either edge. Same technique as the other editors.
  // ---------------------------------------------------------------------
  function closeDropdowns() {
    layersPanel.style.display = 'none';
    btnLayersToggle.classList.remove('active');
  }
  function positionDropdownPanel(panel, btn) {
    const btnRect = btn.getBoundingClientRect();
    const panelWidth = Math.min(210, window.innerWidth - 16);
    let left = btnRect.left;
    left = Math.max(8, Math.min(left, window.innerWidth - panelWidth - 8));
    panel.style.width = panelWidth + 'px';
    panel.style.left = left + 'px';
    panel.style.top = (btnRect.bottom + 8) + 'px';
  }
  function toggleDropdown(panel, btn) {
    const isOpen = panel.style.display !== 'none';
    closeDropdowns();
    if (!isOpen) {
      positionDropdownPanel(panel, btn);
      panel.style.display = 'block';
      btn.classList.add('active');
    }
  }
  window.addEventListener('resize', () => {
    if (layersPanel.style.display !== 'none') positionDropdownPanel(layersPanel, btnLayersToggle);
  });
  btnLayersToggle.addEventListener('click', (ev) => { ev.stopPropagation(); toggleDropdown(layersPanel, btnLayersToggle); });
  document.addEventListener('click', (ev) => {
    if (!ev.target.closest('.ed-dropdown-wrap')) closeDropdowns();
  });

  // ---------------------------------------------------------------------
  // Layer definitions: seat slots (type 'seatSlot', move-only, position
  // applied in JS) plus the CSS elements LayoutFiftySix already knows
  // about (hand, bid panel, overlay/popup box, chat panel).
  // ---------------------------------------------------------------------
  const SEAT_LAYERS = LH.SEAT_SLOTS.map((s) => Object.assign({ type: 'seatSlot', dragKind: 'posPercent' }, s));
  const CSS_LAYERS = LH.ELEMENTS.map((el) => Object.assign({ type: 'css', dragKind: 'posPercent+sizePx' }, el));
  const ALL_LAYERS = SEAT_LAYERS.concat(CSS_LAYERS);
  function layerByKey(key) { return ALL_LAYERS.find((l) => l.key === key) || null; }

  function bpInfo(key) { return LH.BREAKPOINTS.find((b) => b.key === key); }
  function cloneConfig() { return JSON.parse(JSON.stringify(config)); }
  function setStatus(text, kind) { statusEl.textContent = text; statusEl.className = kind || ''; }
  function round2(n) { return Math.round(n * 100) / 100; }
  function ensureBpBucket(bpKey) { if (!config[bpKey]) config[bpKey] = {}; return config[bpKey]; }

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

  function fitFrameToStage() {
    const bp = bpInfo(currentBp);
    frame.style.transform = 'none';
    frame.style.transformOrigin = 'top left';
    frameWrap.style.width = bp.previewWidth + 'px';
    frameWrap.style.height = bp.previewHeight + 'px';
    let scale;
    if (manualZoom != null) {
      scale = manualZoom;
    } else {
      const availW = stage.clientWidth - 4;
      const availH = stage.clientHeight - 4;
      scale = Math.min(1, availW / bp.previewWidth, availH / bp.previewHeight);
    }
    if (scale > 0 && scale !== 1) {
      frame.style.transform = 'scale(' + scale + ')';
      frameWrap.style.width = Math.round(bp.previewWidth * scale) + 'px';
      frameWrap.style.height = Math.round(bp.previewHeight * scale) + 'px';
    }
    currentScale = scale > 0 ? scale : 1;
    zoomLabel.textContent = Math.round(scale * 100) + '%';
    scheduleRebuildOverlays();
  }
  window.addEventListener('resize', () => { if (manualZoom == null) fitFrameToStage(); });

  function applyManualZoom(newZoom, anchorVX, anchorVY) {
    if (anchorVX == null) anchorVX = stage.clientWidth / 2;
    if (anchorVY == null) anchorVY = stage.clientHeight / 2;
    const oldWidth = frameWrap.offsetWidth || 1;
    const oldHeight = frameWrap.offsetHeight || 1;
    const fracX = (stage.scrollLeft + anchorVX) / oldWidth;
    const fracY = (stage.scrollTop + anchorVY) / oldHeight;
    manualZoom = newZoom;
    fitFrameToStage();
    const newWidth = frameWrap.offsetWidth || 1;
    const newHeight = frameWrap.offsetHeight || 1;
    stage.scrollLeft = Math.max(0, fracX * newWidth - anchorVX);
    stage.scrollTop = Math.max(0, fracY * newHeight - anchorVY);
  }

  const ZOOM_STEPS = [0.25, 0.35, 0.5, 0.66, 0.75, 1, 1.25, 1.5, 2];
  function stepZoom(dir) {
    const bp = bpInfo(currentBp);
    const current = manualZoom != null ? manualZoom : Math.min(1, (stage.clientWidth - 4) / bp.previewWidth, (stage.clientHeight - 4) / bp.previewHeight);
    let next;
    if (dir > 0) next = ZOOM_STEPS.find((s) => s > current + 0.001) || ZOOM_STEPS[ZOOM_STEPS.length - 1];
    else next = [...ZOOM_STEPS].reverse().find((s) => s < current - 0.001) || ZOOM_STEPS[0];
    applyManualZoom(next, stage.clientWidth / 2, stage.clientHeight / 2);
  }
  btnZoomOut.addEventListener('click', () => stepZoom(-1));
  btnZoomIn.addEventListener('click', () => stepZoom(1));
  btnZoomFit.addEventListener('click', () => { manualZoom = null; fitFrameToStage(); stage.scrollLeft = 0; stage.scrollTop = 0; });

  // ---------------------------------------------------------------------
  // Pinch / ctrl+scroll zoom -- scoped to just the table (see Hold'em's
  // identical function for the fuller reasoning; ported verbatim).
  // ---------------------------------------------------------------------
  function clampZoom(z) { return Math.min(3, Math.max(0.1, z)); }
  function currentEffectiveZoom() {
    const bp = bpInfo(currentBp);
    return manualZoom != null ? manualZoom : Math.min(1, (stage.clientWidth - 4) / bp.previewWidth, (stage.clientHeight - 4) / bp.previewHeight);
  }
  function clientPointToStageViewport(clientX, clientY, sourceIsIframe) {
    const stageRect = stage.getBoundingClientRect();
    if (!sourceIsIframe) return { x: clientX - stageRect.left, y: clientY - stageRect.top };
    const frameRect = frame.getBoundingClientRect();
    return { x: (frameRect.left + clientX * currentScale) - stageRect.left, y: (frameRect.top + clientY * currentScale) - stageRect.top };
  }
  function zoomByFactor(factor, anchorVX, anchorVY) {
    applyManualZoom(clampZoom(currentEffectiveZoom() * factor), anchorVX, anchorVY);
  }
  function handleZoomWheel(ev) {
    if (!ev.ctrlKey) return;
    ev.preventDefault();
    const sourceIsIframe = !!(ev.target && ev.target.ownerDocument && ev.target.ownerDocument !== document);
    const pt = clientPointToStageViewport(ev.clientX, ev.clientY, sourceIsIframe);
    zoomByFactor(ev.deltaY < 0 ? 1.08 : 1 / 1.08, pt.x, pt.y);
  }
  window.addEventListener('wheel', handleZoomWheel, { passive: false });

  let pinchStartDist = null;
  let pinchStartZoom = 1;
  let activeTouchPoints = 0;
  function touchDist(touches) {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.hypot(dx, dy);
  }
  function handleTouchStart(ev) {
    activeTouchPoints = ev.touches.length;
    if (ev.touches.length === 2) {
      pinchStartDist = touchDist(ev.touches);
      pinchStartZoom = currentEffectiveZoom();
      dragState = null;
    }
  }
  function handleTouchMove(ev) {
    activeTouchPoints = ev.touches.length;
    if (ev.touches.length === 2 && pinchStartDist) {
      ev.preventDefault();
      const sourceIsIframe = !!(ev.target && ev.target.ownerDocument && ev.target.ownerDocument !== document);
      const midX = (ev.touches[0].clientX + ev.touches[1].clientX) / 2;
      const midY = (ev.touches[0].clientY + ev.touches[1].clientY) / 2;
      const pt = clientPointToStageViewport(midX, midY, sourceIsIframe);
      applyManualZoom(clampZoom(pinchStartZoom * (touchDist(ev.touches) / pinchStartDist)), pt.x, pt.y);
    }
  }
  function handleTouchEnd(ev) {
    activeTouchPoints = ev.touches.length;
    if (ev.touches.length < 2) pinchStartDist = null;
  }
  stage.addEventListener('touchstart', handleTouchStart, { passive: true });
  stage.addEventListener('touchmove', handleTouchMove, { passive: false });
  stage.addEventListener('touchend', handleTouchEnd, { passive: true });
  stage.addEventListener('touchcancel', handleTouchEnd, { passive: true });

  function wireIframeZoomGestures(doc) {
    if (!doc) return;
    const win = doc.defaultView;
    if (!win || win.__ledZoomGesturesWired) return;
    win.__ledZoomGesturesWired = true;
    doc.addEventListener('wheel', handleZoomWheel, { passive: false });
    doc.addEventListener('touchstart', handleTouchStart, { passive: true });
    doc.addEventListener('touchmove', handleTouchMove, { passive: false });
    doc.addEventListener('touchend', handleTouchEnd, { passive: true });
    doc.addEventListener('touchcancel', handleTouchEnd, { passive: true });
  }

  // ---------------------------------------------------------------------
  // Load existing saved config, then boot the frame
  // ---------------------------------------------------------------------
  fetch('/api/layout-config/56')
    .then((r) => r.json())
    .then((data) => {
      if (data && data.ok && data.config) config = Object.assign({ mobile: {}, desktop: {} }, data.config);
      setStatus('Layout loaded. Join/host a table inside the frame, then turn on Edit Table.');
    })
    .catch(() => setStatus('Could not load saved layout (starting from the default table look).', 'error'))
    .finally(() => {
      applyFrameSize();
      renderLayers();
    });

  frame.addEventListener('load', () => {
    try {
      const win = frame.contentWindow;
      if (win.LayoutFiftySix) win.LayoutFiftySix.applyAll(frame.contentDocument, win, () => config);
      setupOverlayMutationObserver(frame.contentDocument, win);
      wireIframeZoomGestures(frame.contentDocument);
      if (editMode && win.LayoutFiftySix) win.LayoutFiftySix.setPreviewOn(frame.contentDocument, true);
    } catch (e) { /* cross-origin or not-yet-ready -- ignore */ }
    scheduleRebuildOverlays();
  });

  // Watches #game (everything seat/card/popup-related lives inside it) and
  // rebuilds overlays on any change -- 56.html keeps rebuilding parts of the
  // table on its own (a bot plays a card, a trick resolves), which can
  // detach the nodes our overlay boxes were tracking. Same technique as the
  // other editors' identical observer.
  let overlayMutationObserver = null;
  function setupOverlayMutationObserver(doc, win) {
    if (win.__ledMutationObserverSet) return;
    const gameRoot = doc.getElementById('game');
    if (!gameRoot) return;
    win.__ledMutationObserverSet = true;
    overlayMutationObserver = new MutationObserver(() => scheduleRebuildOverlays());
    overlayMutationObserver.observe(gameRoot, { childList: true, subtree: true });
  }

  // ---------------------------------------------------------------------
  // Edit mode toggle
  // ---------------------------------------------------------------------
  btnEditToggle.addEventListener('click', () => {
    editMode = !editMode;
    btnEditToggle.classList.toggle('active', editMode);
    frame.classList.toggle('editing', editMode);
    try {
      const win = frame.contentWindow;
      if (win && win.LayoutFiftySix) win.LayoutFiftySix.setPreviewOn(frame.contentDocument, editMode);
    } catch (e) {}
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
      if (dragState) { scheduleRebuildOverlays(); return; }
      rebuildOverlays();
    }, 50);
  }

  // ---------------------------------------------------------------------
  // Find the real DOM element a layer refers to right now (may not exist
  // yet -- e.g. no hand in progress, or a popup not currently triggered).
  // A seat slot's target is resolved through LH.elementForSlot(), which
  // asks the live page's own window.displaySlot() which raw seat is
  // CURRENTLY showing at that slot for this viewer (see
  // layout-engine-56.js's header comment).
  // ---------------------------------------------------------------------
  function targetFor(doc, win, def) {
    if (def.type === 'seatSlot') return LH.elementForSlot(doc, win, def.slot);
    return doc.querySelector(def.selector);
  }

  // Seat slots are positioned as a percent of #table's own box (the same
  // coordinate space 56.html's own SEAT_POS array uses). Every other
  // layer here is a position:fixed popup/strip, positioned as a percent
  // of the full viewport.
  function referenceRectOf(doc, def) {
    if (def && def.type === 'seatSlot') {
      const table = doc.getElementById('table');
      if (table) return table.getBoundingClientRect();
    }
    return { left: 0, top: 0, width: doc.documentElement.clientWidth, height: doc.documentElement.clientHeight };
  }

  // ---------------------------------------------------------------------
  // Overlay boxes -- live inside the iframe's own document (same-origin).
  // Injected directly into the iframe (see Hold'em's identical comment for
  // why: the parent editor's own stylesheet never reaches in there).
  // ---------------------------------------------------------------------
  const OVERLAY_CSS = `
    .led-box{position:fixed;border:3px dashed #4aa3ff;background:rgba(74,163,255,0.18);box-shadow:0 0 0 1px rgba(0,0,0,0.6),0 0 14px rgba(74,163,255,0.7);z-index:2147483000;cursor:move;box-sizing:border-box;animation:led-pulse 1.6s ease-in-out infinite;touch-action:none;-ms-touch-action:none}
    .led-box.led-nodrag{cursor:default}
    .led-box.led-selected{border-color:#f4c430;border-style:solid;background:rgba(244,196,48,0.22);box-shadow:0 0 0 1px rgba(0,0,0,0.6),0 0 18px rgba(244,196,48,0.9);z-index:2147483001;animation:none}
    .led-box.led-dimmed{opacity:0.2;animation:none}
    @keyframes led-pulse{0%,100%{opacity:1}50%{opacity:0.6}}
    .led-label{position:absolute;top:-22px;left:-3px;background:#12181f;color:#e8edf2;font:800 11px -apple-system,sans-serif;padding:3px 7px;border-radius:4px;white-space:nowrap;pointer-events:none;box-shadow:0 2px 6px rgba(0,0,0,0.6);border:1px solid rgba(74,163,255,0.6)}
    .led-box.led-selected .led-label{background:#f4c430;color:#241a12;border-color:#f4c430}
    .led-handle{position:absolute;width:20px;height:20px;background:#f4c430;border:2.5px solid #241a12;border-radius:4px;cursor:nwse-resize;z-index:2147483002;box-shadow:0 2px 8px rgba(0,0,0,0.6);touch-action:none;-ms-touch-action:none}
    .led-handle.led-br{right:-22px;bottom:-22px}
    .led-box.led-selected .led-handle{z-index:2147483003}
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
    try { if (win.LayoutFiftySix) win.LayoutFiftySix.setPreviewOn(doc, true); } catch (e) {}
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
      if (def.dragKind === 'posPercent+sizePx') {
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

  function wireBackgroundDeselect(doc, win) {
    if (win.__ledDeselectWired) return;
    win.__ledDeselectWired = true;
    doc.body.addEventListener('pointerdown', (ev) => {
      const hitBox = ev.target && ev.target.closest && ev.target.closest('.led-box');
      if (!hitBox) selectElement(null);
    });
  }

  const MIN_TOUCH_TARGET = 30;
  function repositionOverlays() {
    Object.values(overlays).forEach(({ box, target }) => {
      const r = target.getBoundingClientRect();
      if (r.width === 0 && r.height === 0 && r.left === 0 && r.top === 0) {
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
      if (activeTouchPoints >= 2) return;
      beginDrag(doc, win, def, ev, 'move');
    });
    if (handle) {
      handle.addEventListener('pointerdown', (ev) => {
        ev.stopPropagation();
        if (activeTouchPoints >= 2) return;
        selectElement(def.key);
        beginDrag(doc, win, def, ev, 'resize');
      });
    }
  }

  const DRAG_THRESHOLD_PX = 4;

  function beginDrag(doc, win, def, ev, mode) {
    ev.preventDefault();
    const startX = ev.clientX, startY = ev.clientY;
    const refRect = referenceRectOf(doc, def);
    const startVal = Object.assign({}, effectiveValue(doc, win, def));
    dragState = { def, mode, startX, startY, startVal, refRect, doc, win, crossedThreshold: false, pointerId: ev.pointerId };
    const onMove = (mv) => handleDragMove(mv);
    const onUp = (upEv) => {
      if (upEv && dragState && upEv.pointerId !== dragState.pointerId) return;
      doc.removeEventListener('pointermove', onMove);
      doc.removeEventListener('pointerup', onUp);
      doc.removeEventListener('pointercancel', onUp);
      dragState = null;
    };
    doc.addEventListener('pointermove', onMove);
    doc.addEventListener('pointerup', onUp);
    doc.addEventListener('pointercancel', onUp);
  }

  function handleDragMove(ev) {
    if (!dragState) return;
    if (ev.pointerId !== dragState.pointerId) return;
    const { def, mode, startX, startY, startVal, refRect, doc, win } = dragState;
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    if (!dragState.crossedThreshold) {
      const screenDist = Math.hypot(dx, dy) * currentScale;
      if (screenDist < DRAG_THRESHOLD_PX) return;
      dragState.crossedThreshold = true;
      pushUndoSnapshot();
    }
    const cur = Object.assign({}, startVal);

    if (def.type === 'seatSlot') {
      cur.left = round2(startVal.left + (dx / refRect.width) * 100);
      cur.top = round2(startVal.top + (dy / refRect.height) * 100);
      ensureBpBucket(currentBp)['slot' + def.slot] = { left: cur.left, top: cur.top };
      try { LH.applySeatSlotPositions(doc, win, config); } catch (e) {}
    } else {
      const bucket = ensureBpBucket(currentBp);
      if (mode === 'move') {
        cur.left = round2(startVal.left + (dx / refRect.width) * 100);
        cur.top = round2(startVal.top + (dy / refRect.height) * 100);
      } else {
        cur.width = Math.max(8, Math.round(startVal.width + dx));
        cur.height = Math.max(8, Math.round(startVal.height + dy));
      }
      bucket[def.key] = cur;
      try { LH.applyCSSConfig(doc, config); } catch (e) {}
    }
    repositionOverlays();
    if (selectedKey === def.key) renderInspector();
    markLayerEdited(def.key);
  }

  // ---------------------------------------------------------------------
  // Reading the live/current value of a layer (used as the drag start
  // point and to pre-fill the inspector) -- always prefers a real
  // on-screen measurement over any hardcoded number.
  // ---------------------------------------------------------------------
  function effectiveValue(doc, win, def) {
    const bucket = config[currentBp] || {};
    if (def.type === 'seatSlot') {
      const saved = bucket['slot' + def.slot];
      const target = targetFor(doc, win, def);
      const refRect = referenceRectOf(doc, def);
      let live = { left: 50, top: 50 };
      if (target) {
        const rect = target.getBoundingClientRect();
        const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
        live = { left: round2(((cx - refRect.left) / refRect.width) * 100), top: round2(((cy - refRect.top) / refRect.height) * 100) };
      }
      return Object.assign({}, live, saved || {});
    }
    const saved = bucket[def.key];
    const target = targetFor(doc, win, def);
    let live = {};
    if (target) {
      const rect = target.getBoundingClientRect();
      const refRect = referenceRectOf(doc, def);
      const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
      let sizeRect = rect;
      if (def.sizeSelector) {
        const sizeTarget = doc.querySelector(def.sizeSelector);
        if (sizeTarget) sizeRect = sizeTarget.getBoundingClientRect();
      }
      live = {
        left: round2(((cx - refRect.left) / refRect.width) * 100), top: round2(((cy - refRect.top) / refRect.height) * 100),
        width: Math.round(sizeRect.width), height: Math.round(sizeRect.height),
      };
    } else {
      live = { left: 50, top: 50, width: 44, height: 62 };
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
      o.box.classList.toggle('led-dimmed', !!key && !isSel);
    });
  }

  function isEdited(def) {
    const bucket = config[currentBp];
    if (!bucket) return false;
    if (def.type === 'seatSlot') return !!bucket['slot' + def.slot];
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
        row.addEventListener('click', () => { selectElement(def.key); closeDropdowns(); });
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
  const FIELD_META = { left: { label: 'X', unit: '%' }, top: { label: 'Y', unit: '%' }, width: { label: 'W', unit: 'px' }, height: { label: 'H', unit: 'px' } };
  function fieldsFor(def) {
    if (def.type === 'seatSlot') return ['left', 'top'];
    return ['left', 'top', 'width', 'height'];
  }
  function savedValueFor(def) {
    const bucket = config[currentBp] || {};
    if (def.type === 'seatSlot') return Object.assign({}, bucket['slot' + def.slot] || {});
    return Object.assign({}, bucket[def.key] || {});
  }

  function renderInspector() {
    if (!selectedKey) { inspectorEl.innerHTML = '<div class="ed-inspector-empty">Join or host a table inside the frame, turn on Edit Table, then click an element (or pick one from Layers) to adjust it here.</div>'; return; }
    const def = layerByKey(selectedKey);
    let doc, win;
    try { doc = frame.contentDocument; win = frame.contentWindow; } catch (e) { doc = null; win = null; }
    const val = doc ? effectiveValue(doc, win, def) : savedValueFor(def);
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
        const cur = Object.assign({}, d ? effectiveValue(d, w, def) : savedValueFor(def));
        cur[input.dataset.field] = Number(input.value) || 0;
        if (def.type === 'seatSlot') {
          ensureBpBucket(currentBp)['slot' + def.slot] = { left: cur.left, top: cur.top };
          if (d && w) { try { LH.applySeatSlotPositions(d, w, config); } catch (e) {} }
        } else {
          ensureBpBucket(currentBp)[def.key] = cur;
          if (d) { try { LH.applyCSSConfig(d, config); } catch (e) {} }
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
      try { if (win) LH.applySeatSlotPositions(doc, win, config); } catch (e) {}
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
    fetch('/api/admin/layout-config/56', {
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
