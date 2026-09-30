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
  const bpSelect = document.getElementById('edBreakpointSelect');
  const btnEditToggle = document.getElementById('edBtnEditToggle');
  const btnUndo = document.getElementById('edBtnUndo');
  const btnRedo = document.getElementById('edBtnRedo');
  const btnReset = document.getElementById('edBtnReset');
  const btnSave = document.getElementById('edBtnSave');
  const statusEl = document.getElementById('edStatus');
  const layersEl = document.getElementById('edLayers');
  const inspectorEl = document.getElementById('edInspector');

  let config = { portrait: {}, desktopWide: {} };
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
      if (el.kind === 'size' || el.kind === 'nudge+size') {
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
      if (ev.target === handle) return; // handled separately below
      selectElement(el.key);
      if (el.kind === 'size') return; // size-only elements have no body-drag
      beginDrag(doc, el, ev, 'move');
    });
    if (handle) {
      handle.addEventListener('pointerdown', (ev) => {
        ev.stopPropagation();
        selectElement(el.key);
        beginDrag(doc, el, ev, 'resize');
      });
    }
  }

  function beginDrag(doc, el, ev, mode) {
    ev.preventDefault();
    pushUndoSnapshot();
    const startX = ev.clientX, startY = ev.clientY;
    const tableArea = doc.getElementById('tableArea');
    const tableRect = tableArea ? tableArea.getBoundingClientRect() : { width: doc.documentElement.clientWidth, height: doc.documentElement.clientHeight };
    const startVal = Object.assign({}, L4P.effectiveValue(config, currentBp, el.key));
    dragState = { el, mode, startX, startY, startVal, tableRect, doc };
    const onMove = (mv) => handleDragMove(mv);
    const onUp = () => {
      doc.removeEventListener('pointermove', onMove);
      doc.removeEventListener('pointerup', onUp);
      dragState = null;
    };
    doc.addEventListener('pointermove', onMove);
    doc.addEventListener('pointerup', onUp);
  }

  function ensureBpBucket(bpKey) { if (!config[bpKey]) config[bpKey] = {}; return config[bpKey]; }

  function handleDragMove(ev) {
    if (!dragState) return;
    const { el, mode, startX, startY, startVal, tableRect } = dragState;
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
  function selectElement(key) { selectedKey = key; setSelected(key); renderInspector(); renderLayers(); }
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
        row.addEventListener('click', () => selectElement(el.key));
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
    const val = L4P.effectiveValue(config, currentBp, selectedKey);
    let html = '<div id="edInspectorTitle">' + el.label + '</div>';
    html += '<div id="edInspectorMeta">' + el.category + ' · ' + bpInfo(currentBp).label + '</div>';
    Object.keys(el.cssProps).forEach((field) => {
      const meta = FIELD_META[field] || { label: field };
      const unit = el.unit === 'percent' ? '%' : 'px';
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
    fetch('/api/admin/layout-config/4p', {
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
