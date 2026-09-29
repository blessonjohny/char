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
  const bpSelect = document.getElementById('edBreakpointSelect');
  const btnEditToggle = document.getElementById('edBtnEditToggle');
  const btnUndo = document.getElementById('edBtnUndo');
  const btnRedo = document.getElementById('edBtnRedo');
  const btnReset = document.getElementById('edBtnReset');
  const btnSave = document.getElementById('edBtnSave');
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

  // ---------------------------------------------------------------------
  // Layer definitions: 9 seats (bespoke, JS-driven) + the CSS elements
  // LayoutHoldem already knows about.
  // ---------------------------------------------------------------------
  const SEAT_LAYERS = [];
  for (let i = 0; i < LH.SEAT_COUNT; i++) {
    SEAT_LAYERS.push({ key: 'seat' + i, slot: i, label: 'Seat — Slot ' + i + (i === 0 ? ' (You)' : ''), category: 'Seats', type: 'seat' });
  }
  const CSS_DRAG_KIND = {
    avatarSize: 'size',
    dealer: 'posPercent+sizePx',
    boardArea: 'posPercent',
    boardCard: 'size',
    handCard: 'size',
    potAnchor: 'posPercent',
    chipPileSize: 'size',
    chipDiscSize: 'size',
  };
  const CSS_LAYERS = LH.ELEMENTS.map((el) => Object.assign({ type: 'css', dragKind: CSS_DRAG_KIND[el.key] || 'size' }, el));
  const ALL_LAYERS = SEAT_LAYERS.concat(CSS_LAYERS);
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
  }

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
      if (win.LayoutHoldem) win.LayoutHoldem.applyAll(frame.contentDocument, win, config);
    } catch (e) { /* cross-origin or not-yet-ready -- ignore */ }
    scheduleRebuildOverlays();
  });

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
    setTimeout(() => { rebuildScheduled = false; rebuildOverlays(); }, 50);
  }

  // ---------------------------------------------------------------------
  // Find the real DOM element a layer refers to right now (may not exist
  // yet -- e.g. no hand in progress, or no community cards dealt).
  // ---------------------------------------------------------------------
  function targetFor(doc, win, def) {
    if (def.type === 'seat') {
      const seats = [...doc.querySelectorAll('.seat[data-pos]')];
      for (const el of seats) {
        const pos = Number(el.dataset.pos);
        let slot = pos;
        try { if (typeof win.slotFor === 'function') slot = win.slotFor(pos); } catch (e) {}
        if (slot === def.slot) return el;
      }
      return null;
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
      if (def.dragKind === 'size' || def.dragKind === 'posPercent+sizePx') {
        handle = doc.createElement('div');
        handle.className = 'led-handle led-br';
        box.appendChild(handle);
      }
      doc.body.appendChild(box);
      overlays[def.key] = { box, handle, target, def };
      wireBoxEvents(doc, win, def, box, handle);
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
  function wireBoxEvents(doc, win, def, box, handle) {
    box.addEventListener('pointerdown', (ev) => {
      if (ev.target === handle) return;
      selectElement(def.key);
      if (def.dragKind === 'size') return; // resize-only elements have no body-drag
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

  function beginDrag(doc, win, def, ev, mode) {
    ev.preventDefault();
    pushUndoSnapshot();
    const startX = ev.clientX, startY = ev.clientY;
    const tableRect = tableRectOf(doc);
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
      cur.x = round2(startVal.x + (dx / tableRect.width) * 100);
      cur.y = round2(startVal.y + (dy / tableRect.height) * 100);
      const seats = ensureSeatsBucket(currentBp);
      seats[def.slot] = cur;
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
  // on-screen measurement over any hardcoded number, so it's automatically
  // correct even if the game's own CSS/positions get retuned later.
  // ---------------------------------------------------------------------
  function effectiveValue(doc, win, def) {
    const bucket = config[currentBp] || {};
    if (def.type === 'seat') {
      const saved = bucket.seats && bucket.seats[def.slot];
      if (saved) return saved;
      const target = targetFor(doc, win, def);
      if (target && target.style.left && target.style.top) {
        return { x: parseFloat(target.style.left) || 0, y: parseFloat(target.style.top) || 0 };
      }
      return { x: 50, y: 50 };
    }
    const saved = bucket[def.key];
    const target = targetFor(doc, win, def);
    let live = {};
    if (target) {
      const rect = target.getBoundingClientRect();
      const tableRect = tableRectOf(doc);
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
      }
    } else if (def.dragKind === 'size') {
      // Reasonable fallbacks for when nothing's on screen yet to measure
      // (e.g. no hand dealt, no bets placed) -- overwritten the instant a
      // real element shows up, and self-correcting on the very next read.
      const SIZE_FALLBACKS = { boardCard: { width: 44, height: 62 }, handCard: { width: 44, height: 62 }, chipPileSize: { width: 9, height: 16 }, chipDiscSize: { width: 9, height: 9 } };
      live = SIZE_FALLBACKS[def.key] || { width: 44, height: 62 };
    }
    return Object.assign({}, live, saved || {});
  }

  // ---------------------------------------------------------------------
  // Selection + Layers panel
  // ---------------------------------------------------------------------
  function selectElement(key) { selectedKey = key; setSelected(key); renderInspector(); renderLayers(); }
  function setSelected(key) {
    Object.entries(overlays).forEach(([k, o]) => o.box.classList.toggle('led-selected', k === key));
  }

  function isEdited(def) {
    const bucket = config[currentBp];
    if (!bucket) return false;
    if (def.type === 'seat') return !!(bucket.seats && bucket.seats[def.slot]);
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
  const FIELD_META = { x: { label: 'X', unit: '%' }, y: { label: 'Y', unit: '%' }, left: { label: 'X', unit: '%' }, top: { label: 'Y', unit: '%' }, width: { label: 'W', unit: 'px' }, height: { label: 'H', unit: 'px' } };
  function fieldsFor(def) {
    if (def.type === 'seat') return ['x', 'y'];
    if (def.dragKind === 'size') return ['width', 'height'];
    if (def.dragKind === 'posPercent') return ['left', 'top'];
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
          ensureSeatsBucket(currentBp)[def.slot] = cur;
          try { if (w && w.LayoutHoldem) w.LayoutHoldem.forceRerender(); } catch (e) {}
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
