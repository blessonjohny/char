// ============================================================================
// layout-editor.js
//
// Drives the standalone Visual Layout Editor (layout-editor.html). This
// script never touches game logic -- it iframes the REAL index.html
// (unmodified, loaded exactly as any player would see it) and, once you've
// navigated inside the frame to an actual table (e.g. a Learn Table), lets
// you drag/resize/nudge the elements Layout4P knows about (see
// layout-engine-4p.js), building up a plain positioning config that gets
// saved to the server and picked up by every real player's page via
// layout-apply.js.
// ============================================================================
(function () {
  'use strict';
  const L4P = window.Layout4P;

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

  // ---------------------------------------------------------------------
  // Layers dropdown -- replaces the old permanent sidebar (see
  // layout-editor-4p.css), matching the same pattern the Hold'em editor
  // uses: positioned in real viewport coordinates from the trigger
  // button's actual on-screen spot, clamped so it can never run off
  // either edge, closes on its own toggle, on picking a layer, or on
  // clicking anywhere else on the page.
  // ---------------------------------------------------------------------
  function closeLayersDropdown() {
    layersPanel.style.display = 'none';
    btnLayersToggle.classList.remove('active');
  }
  function positionLayersPanel() {
    const btnRect = btnLayersToggle.getBoundingClientRect();
    const panelWidth = Math.min(210, window.innerWidth - 16);
    let left = btnRect.left;
    left = Math.max(8, Math.min(left, window.innerWidth - panelWidth - 8));
    layersPanel.style.width = panelWidth + 'px';
    layersPanel.style.left = left + 'px';
    layersPanel.style.top = (btnRect.bottom + 8) + 'px';
  }
  btnLayersToggle.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const isOpen = layersPanel.style.display !== 'none';
    closeLayersDropdown();
    if (!isOpen) {
      positionLayersPanel();
      layersPanel.style.display = 'block';
      btnLayersToggle.classList.add('active');
    }
  });
  window.addEventListener('resize', () => { if (layersPanel.style.display !== 'none') positionLayersPanel(); });
  document.addEventListener('click', (ev) => { if (!ev.target.closest('.ed-dropdown-wrap')) closeLayersDropdown(); });

  let config = { portrait: {}, desktopWide: {} };
  window.__editorGetConfig = () => config;                // lets editor-nav.js tell whether there are unsaved changes
  let currentBp = L4P.BREAKPOINTS[0].key;
  let editMode = false;
  let selectedKey = null;
  let undoStack = [];
  let redoStack = [];
  let overlays = {}; // key -> { box, handle, target }
  let dragState = null; // active drag/resize info
  let rafId = null;

  function bpInfo(key) { return L4P.BREAKPOINTS.find((b) => b.key === key); }
  function cloneConfig() { return JSON.parse(JSON.stringify(config)); }
  function setStatus(text, kind) {
    statusEl.textContent = text;
    statusEl.className = kind || '';
  }

  // ---------------------------------------------------------------------
  // Breakpoint selector
  // ---------------------------------------------------------------------
  L4P.BREAKPOINTS.forEach((bp) => {
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

  // The iframe's own intrinsic size always stays the real breakpoint size (bp.previewWidth x
  // previewHeight) -- zoom never touches this. fitFrameToStage() below visually scales the
  // WHOLE iframe down/up with a CSS transform on top of that, same split Hold'em's editor uses:
  // click/drag coordinates inside the iframe's own document are completely unaffected by the
  // outer page's CSS transform (both the overlay boxes and the real elements they track live in
  // that same iframe document, so they move together regardless of how the outer page scales
  // the iframe visually) -- only the zoom UI itself (stepZoom/zoomByFactor/pinch) needs to know
  // about the current scale, to convert a screen-space anchor point into iframe-space.
  function applyFrameSize() {
    const bp = bpInfo(currentBp);
    frame.width = bp.previewWidth;
    frame.height = bp.previewHeight;
    frame.style.width = bp.previewWidth + 'px';
    frame.style.height = bp.previewHeight + 'px';
    try { frame.contentWindow.dispatchEvent(new Event('resize')); } catch (e) {}
    fitFrameToStage();
  }

  let manualZoom = null;
  let currentScale = 1;
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
  }
  window.addEventListener('resize', () => { if (manualZoom == null) fitFrameToStage(); });

  // ---------------------------------------------------------------------
  // Zoom -- +/-/Fit buttons, ctrl+scroll, and pinch, all driving the same
  // manualZoom/fitFrameToStage this editor already uses. Keeps whatever
  // point you're zooming around (screen center for the buttons, the
  // cursor for ctrl+scroll, the pinch midpoint for pinch) visually fixed
  // by adjusting scroll position after rescaling, rather than relying on
  // CSS layout to do it (see layout-editor-holdem.js's identical function
  // for the fuller reasoning -- same technique, ported here verbatim).
  // ---------------------------------------------------------------------
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
      dragState = null; // a second finger always means pinch -- cancel any in-progress drag
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
  fetch('/api/layout-config/4p')
    .then((r) => r.json())
    .then((data) => {
      if (data && data.ok && data.config) config = Object.assign({ portrait: {}, desktopWide: {} }, data.config);
      setStatus('Layout loaded. Navigate inside the frame to a table (e.g. Learn Table), then turn on Edit Table.');
    })
    .catch(() => setStatus('Could not load saved layout (starting from the default table look).', 'error'))
    .finally(() => {
      applyFrameSize();
      renderLayers();
    });

  frame.addEventListener('load', () => {
    try {
      L4P.applyConfig(frame.contentDocument, config);
    } catch (e) { /* cross-origin or not-yet-ready -- ignore */ }
    try { wireIframeZoomGestures(frame.contentDocument); } catch (e) {}
    applyPopupPreview();
    scheduleRebuildOverlays();
  });

  // ---------------------------------------------------------------------
  // Popup declutter -- popups (category 'Popups' in L4P.POPUP_KEYS) are
  // normally hidden on the real page until a real game moment shows them.
  // Showing every single one at once in Edit Table mode (4-player has
  // enough of them now) would overlap into unreadable clutter, so only
  // the CURRENTLY SELECTED popup -- if any, and only while Edit Table is
  // on -- is force-shown here; every other one stays exactly as hidden as
  // it is on the live page. Call this any time `selectedKey` or `editMode`
  // changes, before rebuildOverlays() (which needs the element actually
  // visible/non-zero-size to build a box for it at all).
  // ---------------------------------------------------------------------
  function applyPopupPreview() {
    let doc; try { doc = frame.contentDocument; } catch (e) { doc = null; }
    if (!doc || !L4P.setPreviewPopup) return;
    try { L4P.setPreviewPopup(doc, editMode ? selectedKey : null); } catch (e) {}
  }

  // ---------------------------------------------------------------------
  // Edit mode toggle
  // ---------------------------------------------------------------------
  btnEditToggle.addEventListener('click', () => {
    editMode = !editMode;
    btnEditToggle.textContent = editMode ? '✏️ Edit Table: ON' : '✏️ Edit Table: OFF';
    btnEditToggle.classList.toggle('active', editMode);
    frame.classList.toggle('editing', editMode);
    applyPopupPreview();
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
    setTimeout(() => { rebuildScheduled = false; rebuildOverlays(); }, 50);
  }

  // ---------------------------------------------------------------------
  // Overlay boxes -- live inside the iframe's own document (same-origin),
  // so their coordinates always match the real elements' pixels exactly.
  // The editor page's own stylesheet (layout-editor.css) never reaches
  // into the iframe's separate document, so the .led-box/.led-label/.led-
  // handle rules are injected directly into the iframe here -- without
  // this the boxes exist in the DOM at the right coordinates but render
  // completely unstyled (no position:fixed, no visible border), making
  // them invisible and unclickable.
  // ---------------------------------------------------------------------
  const OVERLAY_CSS = `
    .led-box{position:fixed;border:3px dashed #4aa3ff;background:rgba(74,163,255,0.18);box-shadow:0 0 0 1px rgba(0,0,0,0.6),0 0 14px rgba(74,163,255,0.7);z-index:2147483000;cursor:move;box-sizing:border-box;animation:led-pulse 1.6s ease-in-out infinite}
    .led-box.led-nodrag{cursor:default}
    .led-box.led-selected{border-color:#f4c430;border-style:solid;background:rgba(244,196,48,0.22);box-shadow:0 0 0 1px rgba(0,0,0,0.6),0 0 18px rgba(244,196,48,0.9);z-index:2147483001;animation:none}
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
    let doc;
    try { doc = frame.contentDocument; } catch (e) { return; }
    if (!doc || !doc.body) return;
    clearOverlays();
    if (!editMode) return;
    ensureOverlayStyles(doc);
    L4P.ELEMENTS.forEach((el) => {
      const target = doc.querySelector(el.selector);
      if (!target) return;
      const rect = target.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return; // not currently on screen
      const box = doc.createElement('div');
      box.className = 'led-box' + (el.kind === 'size' ? '' : '');
      const label = doc.createElement('div');
      label.className = 'led-label';
      label.textContent = el.label;
      box.appendChild(label);
      let handle = null;
      if (el.kind === 'size' || el.kind === 'nudge+size' || el.kind === 'position+size') {
        handle = doc.createElement('div');
        handle.className = 'led-handle led-br';
        box.appendChild(handle);
      }
      doc.body.appendChild(box);
      overlays[el.key] = { box, handle, target, el };
      wireBoxEvents(doc, el, box, handle);
    });
    repositionOverlays();
    if (selectedKey) setSelected(selectedKey);
  }

  function repositionOverlays() {
    Object.values(overlays).forEach(({ box, target }) => {
      const r = target.getBoundingClientRect();
      box.style.left = r.left + 'px';
      box.style.top = r.top + 'px';
      box.style.width = r.width + 'px';
      box.style.height = r.height + 'px';
    });
  }

  // ---------------------------------------------------------------------
  // Drag / resize
  // ---------------------------------------------------------------------
  function wireBoxEvents(doc, el, box, handle) {
    box.addEventListener('pointerdown', (ev) => {
      if (activeTouchPoints >= 2) return; // a pinch already in progress -- never also start a drag
      if (ev.target === handle) return; // handled separately below
      selectElement(el.key);
      if (el.kind === 'size') return; // size-only elements have no body-drag
      beginDrag(doc, el, ev, 'move');
    });
    if (handle) {
      handle.addEventListener('pointerdown', (ev) => {
        if (activeTouchPoints >= 2) return;
        ev.stopPropagation();
        selectElement(el.key);
        beginDrag(doc, el, ev, 'resize');
      });
    }
  }

  // Base rect that a 'position+size' element's percent/px fields are
  // measured against: the full viewport for `viewportRelative` entries
  // (matching their forced position:fixed override), or #tableArea for
  // everything else (matching how every other percent-based kind here --
  // seats, etc -- already works).
  function computeBaseRect(el, doc) {
    const tableArea = doc.getElementById('tableArea');
    const tableRect = tableArea ? tableArea.getBoundingClientRect() : { left: 0, top: 0, width: doc.documentElement.clientWidth, height: doc.documentElement.clientHeight };
    if (el.viewportRelative) return { left: 0, top: 0, width: doc.documentElement.clientWidth, height: doc.documentElement.clientHeight };
    return { left: tableRect.left || 0, top: tableRect.top || 0, width: tableRect.width, height: tableRect.height };
  }

  // A 'position+size' element has no DEFAULTS entry (unlike the original
  // seat/avatar/etc elements) -- until the very first drag or manual edit,
  // `startVal` can be missing some/all of left/top/width/height. Rather
  // than leave those as NaN (which would corrupt every subsequent drag
  // math), fill any missing field from the element's own CURRENT on-screen
  // box, converted into the same unit (% or px) that field is saved in --
  // self-correcting the same way every other kind here already is.
  function fillMissingPositionSize(el, startVal, baseRect) {
    const ov = overlays[el.key];
    if (!ov) return startVal;
    const r = ov.target.getBoundingClientRect();
    const out = Object.assign({}, startVal);
    Object.keys(el.cssProps).forEach((field) => {
      if (out[field] !== undefined && out[field] !== null) return;
      const unit = (el.fieldUnits && el.fieldUnits[field]) || 'px';
      if (field === 'left') out.left = unit === '%' ? round2(((r.left - baseRect.left) / baseRect.width) * 100) : Math.round(r.left - baseRect.left);
      else if (field === 'top') out.top = unit === '%' ? round2(((r.top - baseRect.top) / baseRect.height) * 100) : Math.round(r.top - baseRect.top);
      else if (field === 'width') out.width = Math.round(r.width);
      else if (field === 'height') out.height = Math.round(r.height);
    });
    return out;
  }

  function beginDrag(doc, el, ev, mode) {
    ev.preventDefault();
    pushUndoSnapshot();
    const startX = ev.clientX, startY = ev.clientY;
    const tableArea = doc.getElementById('tableArea');
    const tableRect = tableArea ? tableArea.getBoundingClientRect() : { width: doc.documentElement.clientWidth, height: doc.documentElement.clientHeight };
    let startVal = Object.assign({}, L4P.effectiveValue(config, currentBp, el.key));
    const baseRect = el.kind === 'position+size' ? computeBaseRect(el, doc) : null;
    if (el.kind === 'position+size') startVal = fillMissingPositionSize(el, startVal, baseRect);
    dragState = { el, mode, startX, startY, startVal, tableRect, baseRect, doc, pointerId: ev.pointerId };
    const onMove = (mv) => { if (mv.pointerId === dragState.pointerId) handleDragMove(mv); };
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

  function ensureBpBucket(bpKey) { if (!config[bpKey]) config[bpKey] = {}; return config[bpKey]; }

  function handleDragMove(ev) {
    if (!dragState) return;
    const { el, mode, startX, startY, startVal, tableRect, baseRect } = dragState;
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    const bucket = ensureBpBucket(currentBp);
    const cur = Object.assign({}, startVal);

    if (el.unit === 'percent' && el.kind === 'position') {
      cur.left = round2(startVal.left + (dx / tableRect.width) * 100);
      cur.top = round2(startVal.top + (dy / tableRect.height) * 100);
    } else if (el.kind === 'size') {
      cur.width = Math.max(8, Math.round(startVal.width + dx));
      cur.height = Math.max(8, Math.round(startVal.height + dy));
    } else if (el.kind === 'position+size') {
      // Generic position+size drag: each field moves/resizes in whatever
      // unit it's actually saved in (el.fieldUnits[field], % or px),
      // matching layout-engine-holdem.js's own per-field unit handling.
      const fields = mode === 'resize' ? ['width', 'height'] : ['left', 'top'];
      fields.forEach((field) => {
        if (!(field in el.cssProps)) return;
        const unit = (el.fieldUnits && el.fieldUnits[field]) || 'px';
        const delta = (field === 'left' || field === 'width') ? dx : dy;
        const dim = (field === 'left' || field === 'width') ? baseRect.width : baseRect.height;
        const base = startVal[field] || 0;
        const minVal = (field === 'width' || field === 'height') ? (unit === '%' ? 2 : 8) : -Infinity;
        const raw = unit === '%' ? base + (delta / dim) * 100 : base + delta;
        cur[field] = unit === '%' ? Math.max(minVal, round2(raw)) : Math.max(minVal, Math.round(raw));
      });
    } else if (el.kind === 'nudge+size') {
      if (mode === 'move') { cur.left = Math.round(startVal.left + dx); cur.top = Math.round(startVal.top + dy); }
      else { cur.width = Math.max(8, Math.round(startVal.width + dx)); cur.height = Math.max(8, Math.round(startVal.height + dy)); }
    } else if (el.kind === 'corner') {
      // Each corner prop moves opposite to the visual drag direction for
      // right/bottom-anchored props (dragging right means a SMALLER "right"
      // px offset), and same-direction for left/top-anchored ones.
      Object.keys(el.cssProps).forEach((field) => {
        const sign = (field === 'right' || field === 'bottom') ? -1 : 1;
        const delta = (field === 'left' || field === 'right') ? dx : dy;
        cur[field] = Math.round(startVal[field] + sign * delta);
      });
    }
    bucket[el.key] = cur;
    L4P.applyConfig(dragState.doc, config);
    repositionOverlays();
    if (selectedKey === el.key) renderInspector();
    markLayerEdited(el.key);
  }

  function round2(n) { return Math.round(n * 100) / 100; }

  // ---------------------------------------------------------------------
  // Selection + Layers panel
  // ---------------------------------------------------------------------
  function selectElement(key) {
    selectedKey = key;
    // Picking a popup forces it visible (see applyPopupPreview); picking
    // anything else hides whichever popup was previously forced-shown.
    // Either way the set of on-screen boxes can change, so a full
    // rebuild (not just setSelected) is needed -- cheap enough for the
    // handful of elements this editor has.
    applyPopupPreview();
    if (editMode) rebuildOverlays(); else setSelected(key);
    renderInspector();
    renderLayers();
  }
  function setSelected(key) {
    Object.entries(overlays).forEach(([k, o]) => o.box.classList.toggle('led-selected', k === key));
  }

  function renderLayers() {
    const byCategory = {};
    L4P.ELEMENTS.forEach((el) => { (byCategory[el.category] = byCategory[el.category] || []).push(el); });
    layersEl.innerHTML = '';
    Object.entries(byCategory).forEach(([cat, els]) => {
      const group = document.createElement('div');
      group.className = 'ed-layer-group';
      const label = document.createElement('div');
      label.className = 'ed-layer-group-label';
      label.textContent = cat;
      group.appendChild(label);
      els.forEach((el) => {
        const row = document.createElement('div');
        const hasOverride = config[currentBp] && config[currentBp][el.key];
        row.className = 'ed-layer-row' + (el.key === selectedKey ? ' selected' : '') + (hasOverride ? ' edited' : '');
        row.innerHTML = '<span class="ed-dot"></span><span>' + el.label + '</span>';
        row.addEventListener('click', () => { selectElement(el.key); closeLayersDropdown(); });
        group.appendChild(row);
      });
      layersEl.appendChild(group);
    });
  }
  function markLayerEdited(key) {
    const row = [...layersEl.querySelectorAll('.ed-layer-row')].find((r) => r.textContent.trim() === L4P.elementByKey(key).label);
    if (row) row.classList.add('edited');
  }

  // ---------------------------------------------------------------------
  // Inspector (precise numeric entry -- works with or without Edit Table on)
  // ---------------------------------------------------------------------
  const FIELD_META = {
    left: { label: 'X' }, top: { label: 'Y' }, right: { label: 'Right' }, bottom: { label: 'Bottom' },
    width: { label: 'W' }, height: { label: 'H' },
  };
  function renderInspector() {
    if (!selectedKey) { inspectorEl.innerHTML = '<div class="ed-inspector-empty">Turn on Edit Table, then click an element on the table (or pick one from Layers) to adjust it here.</div>'; return; }
    const el = L4P.elementByKey(selectedKey);
    let val = L4P.effectiveValue(config, currentBp, selectedKey);
    if (el.kind === 'position+size' && overlays[selectedKey]) {
      let doc; try { doc = frame.contentDocument; } catch (e) { doc = null; }
      if (doc) val = fillMissingPositionSize(el, Object.assign({}, val), computeBaseRect(el, doc));
    }
    let html = '<div id="edInspectorTitle">' + el.label + '</div>';
    html += '<div id="edInspectorMeta">' + el.category + ' · ' + bpInfo(currentBp).label + '</div>';
    Object.keys(el.cssProps).forEach((field) => {
      const meta = FIELD_META[field] || { label: field };
      const unit = (el.fieldUnits && el.fieldUnits[field]) || (el.unit === 'percent' ? '%' : 'px');
      html += '<div class="ed-field-row"><label>' + meta.label + '</label><input type="number" step="any" data-field="' + field + '" value="' + (val[field] !== undefined ? val[field] : '') + '"><span class="ed-unit">' + unit + '</span></div>';
    });
    inspectorEl.innerHTML = html;
    inspectorEl.querySelectorAll('input[data-field]').forEach((input) => {
      input.addEventListener('focus', () => { input.dataset.pristine = input.value; });
      input.addEventListener('change', () => {
        pushUndoSnapshot();
        const bucket = ensureBpBucket(currentBp);
        const cur = Object.assign({}, L4P.effectiveValue(config, currentBp, selectedKey));
        cur[input.dataset.field] = Number(input.value) || 0;
        bucket[selectedKey] = cur;
        let doc; try { doc = frame.contentDocument; } catch (e) { doc = null; }
        if (doc) L4P.applyConfig(doc, config);
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
    let doc; try { doc = frame.contentDocument; } catch (e) { doc = null; }
    if (doc) L4P.applyConfig(doc, config);
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
    // First pick up the Pro editor's latest changes (if any were saved since this page loaded), so this save never wipes them.
    fetch('/api/layout-config/4p').then((r) => (r.ok ? r.json() : null)).then((d) => { if (d && d.ok && d.config && d.config.__pro) config.__pro = d.config.__pro; }).catch(() => {}).then(() => fetch('/api/admin/layout-config/4p', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-password': pw },
      body: JSON.stringify({ config }),
    }))
      .then((r) => r.json())
      .then((data) => {
        if (data && data.ok) setStatus('Saved — live for every player now.', 'saved');
        else setStatus('Save failed: ' + (data && data.error === 'bad_password' ? 'wrong password' : (data && data.error) || 'unknown error'), 'error');
      })
      .catch(() => setStatus('Save failed: network error.', 'error'));
  });

  updateUndoRedoButtons();
})();
