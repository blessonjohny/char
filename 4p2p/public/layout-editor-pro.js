// ============================================================================
// layout-editor-pro.js -- the Pro layout editor for the 4-player, 6-player and 56 tables.
//
// It iframes the REAL game page and lets you pick ANY visible thing on it (not only items
// somebody registered in code): tap it, drag it, resize it, type its X / Y / W / H, hide it.
// What you change is saved as "Pro overrides" (see layout-pro.js) and shows for every player.
// Nothing here touches game logic: while Edit is on the page's own clicks are blocked, and
// the only things written into the page are a <style> tag and (while Pause / Show-hidden are
// used) a few temporary helper nodes that are removed again.
// ============================================================================
(function () {
  'use strict';
  const LP = window.LayoutPro;
  const $ = (id) => document.getElementById(id);
  const frame = $('edFrame'), frameWrap = $('edFrameWrap'), stage = $('edStage');

  // ---- per-table setup -----------------------------------------------------------------------
  const TABLES = {
    '4p': { label: '4-Player (28)', src: 'index.html?proEditor=1', kunukku: 'showQMarkEvent4p', important: ['#handArea'],
            legacy: (doc, win, cfg) => { if (window.Layout4P) window.Layout4P.applyConfig(doc, cfg); },
            hint: 'Tap "Play vs bots" in the frame (offline works), or use Quick start.' },
    '6p': { label: '6-Player', src: 'play6.html?editorPreview=1&proEditor=1', kunukku: 'showQMarkEventSix', important: ['.hand-bar'],
            legacy: (doc, win, cfg) => { if (window.LayoutSix) window.LayoutSix.applyAll(doc, win, cfg); },
            hint: 'Host a table with bots inside the frame so the real seats are on screen.' },
    '56': { label: '56', src: '56.html?proEditor=1', kunukku: 'showQMarkEvent56', important: ['#hand-area'],
            legacy: (doc, win, cfg) => { if (window.LayoutFiftySix) window.LayoutFiftySix.applyAll(doc, win, cfg); },
            hint: 'Host a table with bots inside the frame so the real seats are on screen.' },
  };
  const params = new URLSearchParams(location.search);
  const tableKey = TABLES[params.get('table')] ? params.get('table') : '4p';
  const T = TABLES[tableKey];

  // ---- state ---------------------------------------------------------------------------------
  let config = {};
  let editMode = false, paused = false;
  let device = { w: 390, h: 844 };
  let manualZoom = null, scale = 1;
  let S = null;                    // current selection: { el, sel, mode, label }
  let hoverEl = null;
  let undoStack = [], redoStack = [];
  let drag = null, lastTap = { t: 0, x: 0, y: 0 };
  const sentBack = new Map();      // element -> order (edit-only: double-tap sends it behind the next one)
  let sentCounter = 0;
  let issuesTimer = null, rafId = null;

  const doc = () => { try { return frame.contentDocument; } catch (e) { return null; } };
  const win = () => { try { return frame.contentWindow; } catch (e) { return null; } };
  const layoutKey = () => LP.layoutKeyFor(device.w, device.h);
  const items = () => { const k = layoutKey(); config.__pro.items[k] = config.__pro.items[k] || []; return config.__pro.items[k]; };
  const unit = () => { const d = doc(); return d ? (parseFloat(d.documentElement.style.getPropertyValue('--lpu')) || 1) : 1; };
  const round1 = (n) => Math.round(n * 10) / 10;
  function status(msg, kind) { const s = $('edStatus'); s.textContent = msg; s.className = kind || ''; }

  // ---- config load / save -----------------------------------------------------------------------
  function ensurePro() {
    if (!config || typeof config !== 'object') config = {};
    const p = config.__pro && typeof config.__pro === 'object' ? config.__pro : (config.__pro = {});
    p.v = 1; p.items = p.items && typeof p.items === 'object' ? p.items : {};
    LP.LAYOUTS.forEach((l) => { if (!Array.isArray(p.items[l.key])) p.items[l.key] = []; });
  }
  async function loadConfig() {
    try {
      const r = await fetch('/api/layout-config/' + tableKey);
      const d = r.ok ? await r.json() : null;
      config = d && d.ok && d.config ? d.config : {};
      status('Loaded saved layout.');
    } catch (e) { config = {}; status('Could not reach the server — starting empty.', 'error'); }
    ensurePro();
  }
  async function save() {
    const pw = prompt('Admin password to publish this layout for every player:');
    if (pw === null) return;
    status('Saving…');
    try {
      const r = await fetch('/api/admin/layout-config/' + tableKey, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-password': pw }, body: JSON.stringify({ config }) });
      const d = await r.json();
      if (d && d.ok) status('Saved — live for every player now.', 'saved');
      else status('Save failed: ' + (d && d.error === 'bad_password' ? 'wrong password' : (d && d.error) || 'unknown error'), 'error');
    } catch (e) { status('Save failed: network error.', 'error'); }
  }

  // ---- undo / redo ------------------------------------------------------------------------------
  const snapshot = () => JSON.stringify(config.__pro);
  function pushUndo() { undoStack.push(snapshot()); if (undoStack.length > 120) undoStack.shift(); redoStack = []; syncUndo(); }
  function syncUndo() { $('edBtnUndo').disabled = !undoStack.length; $('edBtnRedo').disabled = !redoStack.length; }
  function restore(json) { config.__pro = JSON.parse(json); ensurePro(); reapply(); }
  $('edBtnUndo').addEventListener('click', () => { if (!undoStack.length) return; redoStack.push(snapshot()); restore(undoStack.pop()); syncUndo(); });
  $('edBtnRedo').addEventListener('click', () => { if (!redoStack.length) return; undoStack.push(snapshot()); restore(redoStack.pop()); syncUndo(); });
  $('edBtnReset').addEventListener('click', () => {
    if (!items().length) { status('Nothing to reset for this screen size.'); return; }
    if (!confirm('Undo every change you made for "' + LP.layoutByKey(layoutKey()).label + '"? (Other screen sizes are not touched.)')) return;
    pushUndo(); config.__pro.items[layoutKey()] = []; S = null; reapply();
  });

  // ---- applying the config to the preview --------------------------------------------------------
  function reapply() {
    const d = doc(), w = win();
    if (d && w) { LP.apply(d, w, config); }
    updateAll();
    scheduleIssues();
  }
  function updateAll() { renderInspector(); renderEdited(); syncUndo(); drawOverlays(); }

  // ---- frame, device, zoom ------------------------------------------------------------------------
  const devSel = $('edDeviceSelect');
  function buildDeviceSelect() {
    let html = '';
    LP.LAYOUTS.forEach((l) => {
      html += `<optgroup label="${l.label}">` + l.presets.map(([w, h, n]) => `<option value="${w}x${h}">${w} × ${h} · ${n}</option>`).join('') + '</optgroup>';
    });
    html += `<option value="device">📱 This device (${window.innerWidth} × ${window.innerHeight})</option><option value="custom">Custom size…</option>`;
    devSel.innerHTML = html;
  }
  function setDevice(w, h, remember) {
    device = { w, h };
    const v = w + 'x' + h;
    if ([...devSel.options].some((o) => o.value === v)) devSel.value = v;
    if (remember) { try { localStorage.setItem('proEditorDevice', v); } catch (e) {} }
    applyFrameSize();
  }
  devSel.addEventListener('change', () => {
    let v = devSel.value;
    if (v === 'device') { setDevice(window.innerWidth, window.innerHeight, true); return; }
    if (v === 'custom') {
      const raw = prompt('Screen size as WIDTH x HEIGHT in pixels (e.g. 390x844):', device.w + 'x' + device.h);
      const m = raw && raw.match(/^\s*(\d{3,4})\s*[x×*,]\s*(\d{3,4})\s*$/i);
      if (!m) { devSel.value = [...devSel.options].some((o) => o.value === device.w + 'x' + device.h) ? device.w + 'x' + device.h : 'device'; return; }
      setDevice(+m[1], +m[2], true); return;
    }
    const [w, h] = v.split('x').map(Number); setDevice(w, h, true);
  });
  function applyFrameSize() {
    frame.width = device.w; frame.height = device.h; frame.style.width = device.w + 'px'; frame.style.height = device.h + 'px';
    try { win().dispatchEvent(new Event('resize')); } catch (e) {}
    const d = doc(), w = win(); if (d && w) { LP.setUnit(d, w); }
    fit(); $('edLayoutTag').textContent = 'saves to: ' + LP.layoutByKey(layoutKey()).label;
    S = S ? reselect(S) : S; updateAll(); scheduleIssues();
  }
  function fit() {
    const availW = stage.clientWidth - 8, availH = stage.clientHeight - 8;
    scale = manualZoom != null ? manualZoom : Math.min(1, availW / device.w, availH / device.h);
    frame.style.transformOrigin = 'top left'; frame.style.transform = scale === 1 ? 'none' : 'scale(' + scale + ')';
    frameWrap.style.width = Math.round(device.w * scale) + 'px'; frameWrap.style.height = Math.round(device.h * scale) + 'px';
    $('edZoomLabel').textContent = Math.round(scale * 100) + '%';
  }
  $('edBtnZoomIn').addEventListener('click', () => { manualZoom = Math.min(2, round1((manualZoom != null ? manualZoom : scale) + 0.1)); fit(); });
  $('edBtnZoomOut').addEventListener('click', () => { manualZoom = Math.max(0.2, round1((manualZoom != null ? manualZoom : scale) - 0.1)); fit(); });
  $('edBtnZoomFit').addEventListener('click', () => { manualZoom = null; fit(); });
  window.addEventListener('resize', () => { fit(); positionOpenPanel(); });

  // ---- injected helpers inside the preview -------------------------------------------------------
  const EDIT_CSS = `
    html.pro-editing,html.pro-editing body{-webkit-user-select:none!important;user-select:none!important;touch-action:none!important}
    html.pro-editing *{pointer-events:auto!important}
    #__pro_hover,#__pro_sel{position:fixed;z-index:2147483000;pointer-events:none!important;box-sizing:border-box;display:none}
    #__pro_hover{border:2px dashed #4aa3ff;background:rgba(74,163,255,.14)}
    #__pro_sel{border:3px solid #f4c430;background:rgba(244,196,48,.16);box-shadow:0 0 0 1px rgba(0,0,0,.6),0 0 14px rgba(244,196,48,.8)}
    #__pro_hover span,#__pro_sel span{position:absolute;left:-3px;top:-24px;background:#0c141d;color:#fff;font:700 11px/1 -apple-system,Segoe UI,sans-serif;padding:5px 8px;border-radius:6px;white-space:nowrap;border:1px solid #f4c430}
    #__pro_hover span{border-color:#4aa3ff}
    #__pro_handle{position:fixed;z-index:2147483002;width:24px;height:24px;background:#f4c430;border:2px solid #241a12;border-radius:6px;display:none;pointer-events:auto!important;touch-action:none}
    html.pro-paused *,html.pro-paused *::before,html.pro-paused *::after{animation-play-state:paused!important;transition:none!important}`;
  function installFrameHelpers() {
    const d = doc(); if (!d || !d.head) return;
    if (!d.getElementById('__pro_style')) { const st = d.createElement('style'); st.id = '__pro_style'; st.textContent = EDIT_CSS; d.head.appendChild(st); }
    ['__pro_hover', '__pro_sel', '__pro_handle'].forEach((id) => {
      if (d.getElementById(id)) return;
      const n = d.createElement('div'); n.id = id; n.setAttribute('data-pro-ui', '1');
      if (id !== '__pro_handle') n.innerHTML = '<span></span>';
      d.body.appendChild(n);
    });
    wireHandle();
  }

  // ---- picking -----------------------------------------------------------------------------------
  const isUi = (n) => !!(n && n.closest && n.closest('[data-pro-ui]'));
  function pickStack(x, y) {
    const d = doc(); if (!d) return [];
    const vw = d.documentElement.clientWidth, vh = d.documentElement.clientHeight;
    return d.elementsFromPoint(x, y).filter((el) => {
      if (el === d.documentElement || el === d.body || isUi(el)) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) return false;
      if (r.width * r.height > 0.85 * vw * vh) return false;                           // full-screen backdrops are never what you meant
      const cs = win().getComputedStyle(el);
      if (cs.visibility === 'hidden' || Number(cs.opacity) < 0.02) return false;
      if (cs.display === 'inline' && !/^(IMG|SVG|CANVAS|VIDEO)$/i.test(el.tagName)) return false;   // inline text runs: pick their box instead
      return true;
    });
  }
  // Something you can actually SEE: a picture, a coloured/bordered/shadowed box, a button, or text. Plain structural wrappers
  // (like the transparent layer that covers the table) are skipped when picking so they never steal the tap from the avatar or
  // card beneath; "Parent" still climbs to them.
  function isVisual(el) {
    const w = win(); let cs; try { cs = w.getComputedStyle(el); } catch (e) { return true; }
    if (/^(IMG|SVG|CANVAS|VIDEO|BUTTON|INPUT|SELECT|TEXTAREA|PICTURE)$/i.test(el.tagName)) return true;
    if (cs.backgroundImage && cs.backgroundImage !== 'none') return true;
    const m = /rgba?\(([^)]+)\)/.exec(cs.backgroundColor || ''); if (m) { const p = m[1].split(',').map(Number); if (p.length < 4 || p[3] > 0.05) return true; }
    if (['Top', 'Right', 'Bottom', 'Left'].some((k) => parseFloat(cs['border' + k + 'Width']) > 0 && cs['border' + k + 'Style'] !== 'none' && cs['border' + k + 'Color'] !== 'transparent' && !/rgba\(.*,\s*0\)/.test(cs['border' + k + 'Color']))) return true;
    if (cs.boxShadow && cs.boxShadow !== 'none') return true;
    if (cs.cursor === 'pointer') return true;
    for (const n of el.childNodes) if (n.nodeType === 3 && n.nodeValue.trim()) return true;
    return false;
  }
  function pickAt(x, y) {
    const all = pickStack(x, y);
    const vis = all.filter(isVisual);
    const st = vis.length ? vis : all;
    const area = (e) => { const r = e.getBoundingClientRect(); return r.width * r.height; };
    // TOP-MOST first (that is what you can see and what you are pointing at -- a popup in front of the table wins over
    // the table under it); anything you "sent back" with a double tap goes behind everything else.
    const order = new Map(st.map((e, i) => [e, i]));
    st.sort((a, b) => ((sentBack.get(a) || 0) - (sentBack.get(b) || 0)) || (order.get(a) - order.get(b)));
    // a picture and the named box that wraps it are usually the same size: prefer the named box (it has an id), so
    // tapping an avatar selects "the avatar", not an anonymous <img> inside it. "Inside" still reaches the picture.
    const first = st[0];
    if (first && !first.id && !(sentBack.get(first))) {
      // an anonymous piece (a picture, a bit of text) whose NAMED box (it has an id) is only a little bigger or the same
      // size: select the named box -- tapping an avatar selects "the avatar". "Inside" still reaches the piece itself.
      let anc = first.parentElement, hops = 0;
      while (anc && hops++ < 3 && anc !== doc().body) {
        if (anc.id && !/\d{4,}/.test(anc.id) && !(sentBack.get(anc)) && area(anc) <= area(first) * 2.2) return anc;
        anc = anc.parentElement;
      }
    }
    return first || null;
  }
  function entryFor(el) {
    for (const e of items()) { try { if (el.matches(e.sel)) return e; } catch (err) {} }
    return null;
  }
  function select(el) {
    if (!el) { S = null; updateAll(); return; }
    const e = entryFor(el);
    const mode = e && e.like ? 'like' : 'one';
    const sel = e ? e.sel : LP.selectorFor(el, 'one');
    S = { el, sel, mode: e ? (e.like ? 'like' : 'one') : mode, label: e ? e.label : LP.prettyLabel(el, sel) };
    updateAll();
  }
  function reselect(sel) { const d = doc(); if (!d) return null; let el = null; try { el = d.querySelector(sel.sel); } catch (e) {} return el ? Object.assign({}, sel, { el }) : sel; }
  function matchCount(sel) { const d = doc(); try { return d.querySelectorAll(sel).length; } catch (e) { return 0; } }

  // ---- entries -------------------------------------------------------------------------------------
  function ensureEntry() {
    let e = items().find((x) => x.sel === S.sel);
    if (!e) { e = { sel: S.sel, label: S.label, dx: 0, dy: 0 }; if (S.mode === 'like') e.like = true; items().push(e); }
    return e;
  }
  function tidy(e) {
    const empty = !e.hide && !e.dx && !e.dy && !(e.w > 0) && !(e.h > 0);
    if (empty) { const i = items().indexOf(e); if (i >= 0) items().splice(i, 1); }
  }
  // after a size change, slide the item back so its top-left corner is exactly where it was before
  function holdCorner(e, r0) {
    const r1 = curRect(); if (!r0 || !r1) return; const u = unit();
    if (Math.abs(r1.left - r0.left) > 0.4 || Math.abs(r1.top - r0.top) > 0.4) {
      e.dx = round1((e.dx || 0) + (r0.left - r1.left) / u); e.dy = round1((e.dy || 0) + (r0.top - r1.top) / u); LP.apply(doc(), win(), config);
    }
  }
  // how much bigger/smaller the item is DRAWN than it is laid out (a popup inside a scaled box, for example)
  function drawScale(el) {
    try { const r = el.getBoundingClientRect(); const lw = el.offsetWidth || (el.getBBox && el.getBBox().width) || 0; const f = lw > 0 ? r.width / lw : 1; return f > 0.2 && f < 5 ? f : 1; } catch (e) { return 1; }
  }
  function curRect() { return S && S.el && S.el.isConnected ? S.el.getBoundingClientRect() : null; }

  // ---- overlays (outlines inside the preview) ---------------------------------------------------------
  function place(node, el, label) {
    if (!node) return;
    if (!el || !el.isConnected) { node.style.display = 'none'; return; }
    const r = el.getBoundingClientRect();
    node.style.display = 'block'; node.style.left = r.left + 'px'; node.style.top = r.top + 'px'; node.style.width = r.width + 'px'; node.style.height = r.height + 'px';
    const s = node.querySelector('span'); if (s) s.textContent = label;
  }
  function drawOverlays() {
    const d = doc(); if (!d) return;
    if (S && S.el && !S.el.isConnected) { const re = reselect(S); if (re && re.el.isConnected) S = re; }
    const sel = d.getElementById('__pro_sel'), hov = d.getElementById('__pro_hover'), han = d.getElementById('__pro_handle');
    if (!editMode) { [sel, hov, han].forEach((n) => { if (n) n.style.display = 'none'; }); return; }
    place(sel, S && S.el, S ? S.label + (S.mode === 'like' ? ' (all like it)' : '') : '');
    place(hov, hoverEl && (!S || hoverEl !== S.el) ? hoverEl : null, hoverEl ? LP.prettyLabel(hoverEl, '') : '');
    const r = curRect();
    if (r && han) { han.style.display = 'block'; han.style.left = Math.max(0, r.right - 14) + 'px'; han.style.top = Math.max(0, r.bottom - 14) + 'px'; } else if (han) han.style.display = 'none';
  }
  function loop() { drawOverlays(); rafId = requestAnimationFrame(loop); }

  // ---- edit mode: capture pointer events inside the preview -------------------------------------------
  const BLOCKED = ['click', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'contextmenu', 'dblclick', 'auxclick'];
  function blockEvt(ev) { if (!editMode || isUi(ev.target)) return; ev.preventDefault(); ev.stopPropagation(); ev.stopImmediatePropagation(); }
  function attachEdit() {
    const d = doc(); if (!d || d.__proAttached) return;
    d.__proAttached = true;
    BLOCKED.forEach((t) => d.addEventListener(t, blockEvt, true));
    d.addEventListener('touchmove', (ev) => { if (editMode && !isUi(ev.target)) ev.preventDefault(); }, { capture: true, passive: false });
    d.addEventListener('pointermove', onMove, true);
    d.addEventListener('pointerdown', onDown, true);
    d.addEventListener('pointerup', onUp, true);
    d.addEventListener('pointercancel', onUp, true);
    d.addEventListener('keydown', onKey, true);
    d.addEventListener('pointerleave', () => { hoverEl = null; }, true);
  }
  function setEdit(on) {
    editMode = on; $('edBtnEditToggle').classList.toggle('active', on); $('edBtnEditToggle').textContent = on ? '✏️ Editing' : '✏️ Edit';
    const d = doc(); if (!d) return;
    d.documentElement.classList.toggle('pro-editing', on); frame.classList.toggle('editing', on);
    if (on) { installFrameHelpers(); attachEdit(); if (!rafId) loop(); status(T.hint); }
    else { S = null; hoverEl = null; drawOverlays(); if (rafId) { cancelAnimationFrame(rafId); rafId = null; } status(''); }
    updateAll();
  }
  $('edBtnEditToggle').addEventListener('click', () => setEdit(!editMode));

  function onMove(ev) {
    if (!editMode) return;
    if (drag) { dragMove(ev); return; }
    if (ev.pointerType === 'mouse' && !isUi(ev.target)) hoverEl = pickAt(ev.clientX, ev.clientY); else if (ev.pointerType !== 'mouse') hoverEl = null;
  }
  function onDown(ev) {
    if (!editMode || isUi(ev.target)) return;
    blockEvt(ev);
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;
    let hit = pickAt(ev.clientX, ev.clientY);
    const r = curRect();
    if (S && r && ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom) hit = S.el;   // the selected item keeps priority under your finger
    if (!hit) { select(null); closePanels(); return; }                                  // tap empty space = let go
    if (!S || hit !== S.el) select(hit);
    drag = { kind: 'move', id: ev.pointerId, x: ev.clientX, y: ev.clientY, moved: false, entry: null, dx0: 0, dy0: 0, downEl: hit, t: Date.now() };
    try { doc().documentElement.setPointerCapture(ev.pointerId); } catch (e) {}
  }
  function dragMove(ev) {
    if (!drag || ev.pointerId !== drag.id) return;
    blockEvt(ev);
    const dxs = ev.clientX - drag.x, dys = ev.clientY - drag.y;
    if (!drag.moved) { if (Math.hypot(dxs, dys) * scale < 4) return; drag.moved = true; pushUndo(); drag.entry = ensureEntry(); drag.dx0 = drag.entry.dx || 0; drag.dy0 = drag.entry.dy || 0; drag.w0 = drag.entry.w; drag.h0 = drag.entry.h; drag.r0 = curRect(); }
    const u = unit() * (S ? drawScale(S.el) : 1);
    if (drag.kind === 'move') { drag.entry.dx = round1(drag.dx0 + dxs / u); drag.entry.dy = round1(drag.dy0 + dys / u); LP.apply(doc(), win(), config); }
    else {
      drag.entry.dx = drag.dx0; drag.entry.dy = drag.dy0;
      drag.entry.w = Math.max(8, round1(((drag.r0 ? drag.r0.width : 40) + dxs) / u)); drag.entry.h = Math.max(8, round1(((drag.r0 ? drag.r0.height : 40) + dys) / u));
      LP.apply(doc(), win(), config); holdCorner(drag.entry, drag.r0);
    }
    renderInspectorValues();
  }
  function onUp(ev) {
    if (!drag || (ev.pointerId !== undefined && ev.pointerId !== drag.id)) return;
    const d = drag; drag = null;
    try { doc().documentElement.releasePointerCapture(ev.pointerId); } catch (e) {}
    if (d.entry) { tidy(d.entry); reapply(); return; }
    // a tap without movement: a second tap in the same place sends the item behind, selecting whatever is underneath it
    const now = Date.now(), near = Math.abs(ev.clientX - lastTap.x) < 12 && Math.abs(ev.clientY - lastTap.y) < 12;
    if (near && now - lastTap.t < 380 && S) {
      sentBack.set(S.el, ++sentCounter); const next = pickAt(ev.clientX, ev.clientY); select(next); lastTap = { t: 0, x: 0, y: 0 };
    } else lastTap = { t: now, x: ev.clientX, y: ev.clientY };
  }
  function wireHandle() {
    const d = doc(), h = d.getElementById('__pro_handle'); if (!h || h.__wired) return; h.__wired = true;
    h.addEventListener('pointerdown', (ev) => {
      if (!editMode || !S) return; ev.preventDefault(); ev.stopPropagation();
      drag = { kind: 'resize', id: ev.pointerId, x: ev.clientX, y: ev.clientY, moved: false, entry: null };
      try { h.setPointerCapture(ev.pointerId); } catch (e) {}
    });
    h.addEventListener('pointermove', (ev) => { if (drag && drag.kind === 'resize') dragMove(ev); });
    h.addEventListener('pointerup', onUp); h.addEventListener('pointercancel', onUp);
  }
  function onKey(ev) {
    if (!editMode || !S) return;
    if (ev.key === 'Escape') { select(null); return; }
    const step = ev.shiftKey ? 10 : 1; let dx = 0, dy = 0;
    if (ev.key === 'ArrowLeft') dx = -step; else if (ev.key === 'ArrowRight') dx = step; else if (ev.key === 'ArrowUp') dy = -step; else if (ev.key === 'ArrowDown') dy = step; else return;
    ev.preventDefault(); ev.stopPropagation(); pushUndo(); const e = ensureEntry(); e.dx = round1((e.dx || 0) + dx); e.dy = round1((e.dy || 0) + dy); tidy(e); reapply();
  }
  window.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && editMode && S && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) select(null); });

  // ---- inspector (bottom bar) ----------------------------------------------------------------------------
  const insp = $('edInspector');
  const stepperHtml = '<span class="ed-stepper"><button type="button" tabindex="-1" data-step="1">&#9650;</button><button type="button" tabindex="-1" data-step="-1">&#9660;</button></span>';
  function renderInspector() {
    if (!editMode || !S) { insp.innerHTML = '<div class="ed-inspector-empty">' + (editMode ? 'Tap anything on the table to select it. Tap empty space to let go.' : 'Turn on Edit, then tap anything on the table. Tap empty space to let go.') + '</div>'; return; }
    const e = items().find((x) => x.sel === S.sel) || {};
    const n = matchCount(S.sel), likeSel = S.el && S.el.isConnected ? LP.selectorFor(S.el, 'like') : S.sel, nLike = matchCount(likeSel);
    insp.innerHTML = `<div class="pro-line">
      <span class="pro-name" title="${esc(S.sel)}">${esc(S.label)}</span>
      <div class="ed-field-row"><label>X</label><input type="number" data-f="x" step="1">${stepperHtml}<span class="ed-unit">px</span></div>
      <div class="ed-field-row"><label>Y</label><input type="number" data-f="y" step="1">${stepperHtml}<span class="ed-unit">px</span></div>
      <div class="ed-field-row"><label>W</label><input type="number" data-f="w" step="1" min="4">${stepperHtml}<span class="ed-unit">px</span></div>
      <div class="ed-field-row"><label>H</label><input type="number" data-f="h" step="1" min="4">${stepperHtml}<span class="ed-unit">px</span></div>
      ${nLike > 1 || S.mode === 'like' ? `<button class="pro-btn ${S.mode === 'like' ? 'on' : ''}" data-act="like" title="Apply to every item that looks like this one">All ${nLike} like it</button>` : ''}
      <button class="pro-btn ${e.hide ? 'on' : ''}" data-act="hide">${e.hide ? 'Hidden' : 'Hide'}</button>
      <button class="pro-btn" data-act="parent" title="Select the box around this item">⬆ Parent</button>
      <button class="pro-btn" data-act="child" title="Select the item inside this one">⬇ Inside</button>
      <button class="pro-btn x" data-act="reset">Reset item</button>
      <button class="pro-btn" data-act="done">Done</button></div>`;
    renderInspectorValues();
    insp.querySelectorAll('input[data-f]').forEach((inp) => inp.addEventListener('change', () => fieldChanged(inp.dataset.f, Number(inp.value))));
    insp.querySelectorAll('.ed-stepper').forEach((box) => {
      const inp = box.parentElement.querySelector('input'); let hold = null, rep = null;
      let first = true;
      const nudge = (dir) => { inp.value = (Number(inp.value) || 0) + dir; fieldChanged(inp.dataset.f, Number(inp.value), first ? false : 'cont'); first = false; };
      const stop = () => { clearTimeout(hold); clearInterval(rep); hold = rep = null; stepHold = false; first = true; };
      box.querySelectorAll('button').forEach((b) => {
        const dir = Number(b.dataset.step);
        b.addEventListener('pointerdown', (ev) => { ev.preventDefault(); try { b.setPointerCapture(ev.pointerId); } catch (e) {} nudge(dir); stepHold = true; hold = setTimeout(() => { rep = setInterval(() => nudge(dir), 70); }, 400); });
        ['pointerup', 'pointercancel', 'lostpointercapture', 'pointerleave'].forEach((t) => b.addEventListener(t, stop));
      });
    });
    insp.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => action(b.dataset.act)));
  }
  let stepHold = false;
  function renderInspectorValues() {
    if (!S) return; const r = curRect(); if (!r) return;
    const set = (f, v) => { const i = insp.querySelector(`input[data-f="${f}"]`); if (i && document.activeElement !== i) i.value = Math.round(v); };
    set('x', r.left); set('y', r.top); set('w', r.width); set('h', r.height);
  }
  function fieldChanged(f, val, keepUndo) {
    if (!S || !Number.isFinite(val)) return; const r = curRect(); if (!r) return;
    if (!(stepHold && keepUndo === 'cont')) pushUndo();
    const e = ensureEntry(), u = unit() * drawScale(S.el);
    if (f === 'x') e.dx = round1((e.dx || 0) + (val - r.left) / u);
    else if (f === 'y') e.dy = round1((e.dy || 0) + (val - r.top) / u);
    else if (f === 'w') { e.w = Math.max(4, round1(val / u)); LP.apply(doc(), win(), config); holdCorner(e, r); }
    else if (f === 'h') { e.h = Math.max(4, round1(val / u)); LP.apply(doc(), win(), config); holdCorner(e, r); }
    tidy(e); reapply();
  }
  function action(a) {
    if (!S) return;
    if (a === 'done') { select(null); return; }
    if (a === 'parent') { const p = S.el.parentElement; if (p && p !== doc().body && p !== doc().documentElement) select(p); return; }
    if (a === 'child') { const c = Array.from(S.el.children).find((k) => { const r = k.getBoundingClientRect(); return r.width >= 8 && r.height >= 8; }); if (c) select(c); return; }
    if (a === 'like') {
      pushUndo(); const old = items().find((x) => x.sel === S.sel); const mode = S.mode === 'like' ? 'one' : 'like';
      const ns = LP.selectorFor(S.el, mode);
      if (old) { old.sel = ns; if (mode === 'like') old.like = true; else delete old.like; old.label = S.label; }
      S.sel = ns; S.mode = mode; reapply(); return;
    }
    if (a === 'hide') { pushUndo(); const e = ensureEntry(); e.hide = !e.hide; if (!e.hide) tidy(e); reapply(); if (e.hide) status('Hidden — it stays in "Edited" so you can bring it back.'); return; }
    if (a === 'reset') { pushUndo(); const i = items().findIndex((x) => x.sel === S.sel); if (i >= 0) items().splice(i, 1); reapply(); }
  }
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---- dropdown panels ----------------------------------------------------------------------------------------
  let openPanel = null;
  function closePanels() { ['edEditedPanel', 'edItemsPanel', 'edIssuesPanel'].forEach((id) => { $(id).style.display = 'none'; }); openPanel = null; }
  function positionOpenPanel() {
    if (!openPanel) return; const p = $(openPanel.panel), b = $(openPanel.btn), r = b.getBoundingClientRect();
    p.style.position = 'fixed'; p.style.top = (r.bottom + 4) + 'px'; p.style.maxHeight = (window.innerHeight - r.bottom - 14) + 'px'; p.style.overflowY = 'auto';
    const w = Math.min(window.innerWidth - 16, 360); p.style.width = w + 'px'; p.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left)) + 'px';
  }
  function togglePanel(panelId, btnId, onOpen) {
    const show = $(panelId).style.display === 'none'; closePanels();
    if (show) { $(panelId).style.display = 'block'; openPanel = { panel: panelId, btn: btnId }; if (onOpen) onOpen(); positionOpenPanel(); }
  }
  $('edBtnEditedToggle').addEventListener('click', () => togglePanel('edEditedPanel', 'edBtnEditedToggle', renderEdited));
  $('edBtnItemsToggle').addEventListener('click', () => togglePanel('edItemsPanel', 'edBtnItemsToggle', renderHidden));
  $('edBtnIssuesToggle').addEventListener('click', () => togglePanel('edIssuesPanel', 'edBtnIssuesToggle', () => { runIssues(); renderIssues(); }));
  document.addEventListener('pointerdown', (ev) => { if (openPanel && !ev.target.closest('.ed-dropdown-wrap')) closePanels(); });
  // tapping the dark area around the preview (outside the table) lets go of the selected item too
  stage.addEventListener('pointerdown', (ev) => { if (editMode && S && (ev.target === stage || ev.target === frameWrap)) select(null); });

  // ---- "Edited" list ---------------------------------------------------------------------------------------------
  function renderEdited() {
    const list = items(); $('edEditedCount').textContent = list.length;
    const box = $('edEditedList'); if (!box) return;
    if (!list.length) { box.innerHTML = '<div class="pro-empty">Nothing changed for this screen size yet.</div>'; return; }
    box.innerHTML = list.map((e, i) => `<div class="pro-row"><div class="l"><b>${esc(e.label || e.sel)}</b><small>${e.hide ? 'hidden' : [e.dx || e.dy ? 'moved ' + (e.dx || 0) + ', ' + (e.dy || 0) : '', e.w ? 'width ' + e.w : '', e.h ? 'height ' + e.h : ''].filter(Boolean).join(' · ')}${e.like ? ' · all like it' : ''}</small></div><button data-go="${i}">Select</button><button class="x" data-del="${i}">✕</button></div>`).join('');
    box.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => { const e = list[Number(b.dataset.go)]; const d = doc(); let el = null; try { el = d.querySelector(e.sel); } catch (x) {} if (el) { if (!editMode) setEdit(true); select(el); closePanels(); } else status('That item is not on screen right now (start a game / show it first).'); }));
    box.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => { pushUndo(); list.splice(Number(b.dataset.del), 1); if (S && !list.find((x) => x.sel === S.sel)) {} reapply(); }));
  }

  // ---- pause ------------------------------------------------------------------------------------------------------
  // One-off animations (a popup's entrance) jump to their finished look, so what you edit is how it really rests;
  // endless ones (pulses, glows) simply freeze where they are.
  function settleAnimations(root) {
    let list = []; try { list = root.getAnimations ? root.getAnimations({ subtree: true }) : []; } catch (e) { try { list = root.ownerDocument.getAnimations(); } catch (e2) {} }
    list.forEach((a) => {
      try { const it = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming().iterations : 1; if (it === Infinity) a.pause(); else a.finish(); } catch (e) { try { a.pause(); } catch (e2) {} }
    });
  }
  let heldObserver = null; const heldNodes = new Set(), candidates = new WeakSet();
  const OVERLAYISH = /overlay|bubble|banner|popup|toast|event|modal|confetti|particle|qmark/i;
  function setPause(on) {
    paused = on; $('edBtnPause').classList.toggle('active', on); $('edBtnPause').textContent = on ? '▶ Play' : '⏸ Pause';
    const d = doc(), w = win(); if (!d) return;
    d.documentElement.classList.toggle('pro-paused', on);
    if (on) settleAnimations(d); else { try { d.getAnimations().forEach((a) => { try { a.play(); } catch (e) {} }); } catch (e) {} }
    if (on) {
      installFrameHelpers();
      d.querySelectorAll('body > *').forEach((n) => { if (OVERLAYISH.test(n.className && n.className.baseVal === undefined ? n.className : '') || OVERLAYISH.test(n.id || '')) candidates.add(n); });
      heldObserver = new w.MutationObserver((muts) => muts.forEach((m) => {
        m.addedNodes.forEach((n) => { if (n.nodeType === 1 && !isUi(n) && (OVERLAYISH.test(typeof n.className === 'string' ? n.className : '') || OVERLAYISH.test(n.id || ''))) { candidates.add(n); const fin = () => { try { settleAnimations(n); } catch (e) {} }; w.requestAnimationFrame(fin); setTimeout(fin, 150); setTimeout(fin, 500); } });
        m.removedNodes.forEach((n) => { if (n.nodeType === 1 && candidates.has(n)) { heldNodes.add(n); n.classList.remove('leaving'); try { m.target.appendChild(n); } catch (e) {} } });
      }));
      heldObserver.observe(d.body, { childList: true });
      status('Paused: animations frozen, popups stay on screen so you can edit them.');
    } else {
      if (heldObserver) { heldObserver.disconnect(); heldObserver = null; }
      heldNodes.forEach((n) => { try { n.remove(); } catch (e) {} }); heldNodes.clear(); status('');
    }
  }
  $('edBtnPause').addEventListener('click', () => setPause(!paused));

  // ---- hidden things: popups, banners, the Kunukku coconut ---------------------------------------------------------
  const shown = new Map();         // element -> restore info
  function isDisplayed(el) { const r = el.getBoundingClientRect(); return r.width > 2 && r.height > 2 && win().getComputedStyle(el).display !== 'none'; }
  function showEl(el) {
    const info = { cls: el.className, style: el.getAttribute('style') };
    el.classList.add('on', 'show', 'open', 'active');
    if (!isDisplayed(el)) { const cs = win().getComputedStyle(el); el.style.setProperty('display', cs.position === 'fixed' || el.id ? 'flex' : 'block', 'important'); }
    shown.set(el, info);
  }
  function hideEl(el) { const i = shown.get(el); if (!i) return; el.className = i.cls; if (i.style == null) el.removeAttribute('style'); else el.setAttribute('style', i.style); shown.delete(el); }
  const kSamples = [];
  function kunukkuSampleOn() {
    const d = doc(); if (!d) return;
    const avs = Array.from(d.querySelectorAll('.avatar, .player-avatar, [id^="av"]')).filter((a) => a.getBoundingClientRect().width > 20).slice(0, 4);
    avs.forEach((a) => {
      if (a.querySelector('.kunukku-avatar-img')) return;
      const had = a.classList.contains('has-q'); a.classList.add('has-q');
      const img = d.createElement('img'); img.src = '/images/kunukku/sad-coconut.png'; img.className = 'kunukku-avatar-img'; img.alt = 'Kunukku'; img.setAttribute('data-pro-sample', '1');
      const b = d.createElement('div'); b.className = 'kunukku-count-badge'; b.textContent = '1'; b.setAttribute('data-pro-sample', '1');
      a.appendChild(img); a.appendChild(b); kSamples.push({ a, had, img, b });
    });
  }
  function kunukkuSampleOff() { kSamples.splice(0).forEach(({ a, had, img, b }) => { img.remove(); b.remove(); if (!had) a.classList.remove('has-q'); }); }
  function kunukkuBanner(direction) {
    const w = win(), d = doc(); if (!w || typeof w[T.kunukku] !== 'function') { status('This page cannot show the banner right now (start a game first).', 'error'); return; }
    if (!paused) setPause(true);                                     // keeps the banner from disappearing after a few seconds
    try { w[T.kunukku](['Sample player'], direction); } catch (e) { status('Could not show the banner here.', 'error'); }
  }
  function renderHidden() {
    const d = doc(), box = $('edItemsList'); if (!d) return;
    let h = `<div class="pro-row"><div class="l"><b>🥥 Kunukku coconut + count</b><small>The sad coconut shown on a shut-out player's avatar</small></div><button data-k="sample" class="${kSamples.length ? 'on' : ''}">${kSamples.length ? 'Hide' : 'Show'}</button></div>
      <div class="pro-row"><div class="l"><b>🎉 Kunukku banner (gained)</b><small>The big "KUNUKKU!" popup. Turns Pause on so it stays.</small></div><button data-k="gained">Show</button></div>
      <div class="pro-row"><div class="l"><b>🎉 Kunukku banner (shed)</b><small>The "KUNUKKU SHED!" popup</small></div><button data-k="shed">Show</button></div>`;
    const found = []; const seen = new Set();
    d.querySelectorAll('[id], [class]').forEach((el) => {
      if (found.length >= 24 || isUi(el)) return;
      const cls = typeof el.className === 'string' ? el.className : '';
      if (!(/(overlay|popup|bubble|banner|modal|toast|panel)/i.test(el.id || '') || /(overlay|popup|bubble|banner|modal|toast)/i.test(cls))) return;
      if (isDisplayed(el) && !shown.has(el)) return;
      const key = el.id || cls; if (seen.has(key) || el.tagName === 'SCRIPT') return; seen.add(key); found.push(el);
    });
    h += found.map((el, i) => `<div class="pro-row"><div class="l"><b>${esc(LP.prettyLabel(el, ''))}</b><small>${esc(el.id ? '#' + el.id : '.' + (typeof el.className === 'string' ? el.className.split(/\s+/)[0] : ''))}</small></div><button data-el="${i}" class="${shown.has(el) ? 'on' : ''}">${shown.has(el) ? 'Hide' : 'Show'}</button></div>`).join('');
    box.innerHTML = h;
    box.querySelectorAll('[data-k]').forEach((b) => b.addEventListener('click', () => {
      const k = b.dataset.k;
      if (k === 'sample') { kSamples.length ? kunukkuSampleOff() : kunukkuSampleOn(); } else kunukkuBanner(k === 'gained' ? 'gained' : 'shed');
      renderHidden();
    }));
    box.querySelectorAll('[data-el]').forEach((b) => b.addEventListener('click', () => { const el = found[Number(b.dataset.el)]; shown.has(el) ? hideEl(el) : showEl(el); renderHidden(); if (shown.has(el) && !editMode) setEdit(true); }));
  }

  // ---- problem checks --------------------------------------------------------------------------------------------------
  let issues = [];
  function rectsOf(sel) {
    const d = doc(); let list = []; try { list = Array.from(d.querySelectorAll(sel)); } catch (e) {}
    return list.map((el) => ({ el, r: el.getBoundingClientRect() })).filter((x) => x.r.width > 1 && x.r.height > 1 && win().getComputedStyle(x.el).display !== 'none');
  }
  function checkNow(deviceName) {
    const out = []; const d = doc(), w = win(); if (!d || !w) return out;
    const vw = d.documentElement.clientWidth, vh = d.documentElement.clientHeight;
    const list = items();
    const boxes = list.map((e) => ({ e, hit: rectsOf(e.sel) }));
    boxes.forEach(({ e, hit }) => {
      if (e.hide) return;
      if (!hit.length) { out.push({ sev: 'info', e, text: 'Not on screen right now, so it cannot be checked (start a game or use "Show hidden").' }); return; }
      hit.slice(0, 6).forEach(({ el, r }) => {
        const outside = Math.max(0, -r.left) + Math.max(0, r.right - vw) + Math.max(0, -r.top) + Math.max(0, r.bottom - vh);
        if (r.right < 0 || r.left > vw || r.bottom < 0 || r.top > vh) out.push({ sev: 'error', e, text: 'Completely off the screen — players cannot see it.' });
        else if (outside > 10) out.push({ sev: 'warn', e, text: 'Partly off the screen (about ' + Math.round(outside) + ' px cut off).' });
        const clickable = /^(BUTTON|A|INPUT|SELECT)$/i.test(el.tagName) || el.getAttribute('onclick') || w.getComputedStyle(el).cursor === 'pointer';
        if (clickable && (r.width < 30 || r.height < 30)) out.push({ sev: 'warn', e, text: 'Small to tap (' + Math.round(r.width) + ' × ' + Math.round(r.height) + ' px; about 30+ is comfortable).' });
        if ((e.w || e.h) && (el.scrollWidth - el.clientWidth > 14 || el.scrollHeight - el.clientHeight > 14) && w.getComputedStyle(el).overflow !== 'visible') out.push({ sev: 'warn', e, text: 'Its content is cut off at this size.' });
      });
    });
    // overlaps between two changed items
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const A = boxes[i].hit[0], B = boxes[j].hit[0]; if (!A || !B || boxes[i].e.hide || boxes[j].e.hide) continue;
      if (A.el.contains(B.el) || B.el.contains(A.el)) continue;
      const ix = Math.max(0, Math.min(A.r.right, B.r.right) - Math.max(A.r.left, B.r.left)), iy = Math.max(0, Math.min(A.r.bottom, B.r.bottom) - Math.max(A.r.top, B.r.top));
      const small = Math.min(A.r.width * A.r.height, B.r.width * B.r.height);
      if (small > 0 && (ix * iy) / small > 0.4) out.push({ sev: 'warn', e: boxes[i].e, text: 'Overlaps "' + (boxes[j].e.label || boxes[j].e.sel) + '".' });
    }
    // covering the player's own hand
    T.important.forEach((isel) => {
      const hand = rectsOf(isel)[0]; if (!hand) return;
      boxes.forEach(({ e, hit }) => { const h = hit[0]; if (!h || e.hide || h.el.contains(hand.el) || hand.el.contains(h.el)) return;
        const ix = Math.max(0, Math.min(h.r.right, hand.r.right) - Math.max(h.r.left, hand.r.left)), iy = Math.max(0, Math.min(h.r.bottom, hand.r.bottom) - Math.max(h.r.top, hand.r.top));
        if ((ix * iy) / Math.max(1, hand.r.width * hand.r.height) > 0.2) out.push({ sev: 'warn', e, text: 'Covers part of your hand — taps may go to the wrong thing.' }); });
    });
    out.forEach((o) => { o.device = deviceName || (device.w + ' × ' + device.h); });
    return out;
  }
  function runIssues() { issues = checkNow(); const real = issues.filter((i) => i.sev !== 'info').length; const c = $('edIssueCount'); c.textContent = real; c.className = 'ed-count ' + (real ? 'warn' : items().length ? 'good' : ''); }
  function scheduleIssues() { clearTimeout(issuesTimer); issuesTimer = setTimeout(runIssues, 350); }
  function renderIssues(multi) {
    const box = $('edIssuesList'); const list = multi || issues.map((i) => Object.assign({}, i));
    let h = `<div class="pro-row"><div class="l"><b>This screen (${device.w} × ${device.h})</b><small>Checked automatically after every change.</small></div><button id="edTestOthers">Test other phones</button></div>`;
    if (!list.length) h += '<div class="pro-empty">' + (items().length ? '✅ No problems found.' : 'Nothing changed yet — nothing to check.') + '</div>';
    let lastDev = null;
    list.forEach((o, i) => {
      if (multi && o.device !== lastDev) { h += `<div class="pro-dev">${esc(o.device)}</div>`; lastDev = o.device; }
      h += `<div class="pro-row"><div class="l"><b><span class="pro-sev ${o.sev}">${o.sev}</span>${esc(o.e.label || o.e.sel)}</b><small>${esc(o.text)}</small></div><button data-iss="${i}">Show</button></div>`;
    });
    box.innerHTML = h;
    box.querySelectorAll('[data-iss]').forEach((b) => b.addEventListener('click', () => { const o = list[Number(b.dataset.iss)]; const d = doc(); let el = null; try { el = d.querySelector(o.e.sel); } catch (x) {} if (el) { if (!editMode) setEdit(true); select(el); closePanels(); } }));
    const t = $('edTestOthers'); if (t) t.addEventListener('click', testOthers);
  }
  // resize the preview to each phone size in turn, measure, and put it back
  async function testOthers() {
    const orig = { w: device.w, h: device.h }; const all = []; const lay = LP.layoutByKey(layoutKey());
    $('edIssuesList').innerHTML = '<div class="pro-empty">Testing other phone sizes…</div>';
    for (const [w, h, n] of lay.presets) {
      device = { w, h }; frame.width = w; frame.height = h; frame.style.width = w + 'px'; frame.style.height = h + 'px';
      try { win().dispatchEvent(new Event('resize')); LP.setUnit(doc(), win()); } catch (e) {}
      await new Promise((r) => setTimeout(r, 220));
      all.push(...checkNow(w + ' × ' + h + ' · ' + n));
    }
    device = orig; applyFrameSize();
    const real = all.filter((i) => i.sev !== 'info');
    renderIssues(real.length ? real : []);
    if (!real.length) $('edIssuesList').insertAdjacentHTML('beforeend', '<div class="pro-empty">✅ No problems on ' + lay.presets.length + ' phone sizes.</div>');
    const b = $('edTestOthers'); if (b) b.addEventListener('click', testOthers);
  }

  // ---- quick start (4-player only: it can play offline) -------------------------------------------------------------------
  function quickStart() {
    if (tableKey !== '4p') return;
    const d = doc(); if (!d) return;
    const click = (id) => { const e = d.getElementById(id); if (e && e.getClientRects().length) { e.click(); return true; } return false; };
    ['btnGuestPlay', 'btnUpdateAnnounceOk', 'commentInviteDismiss', 'btnLeaderboardPopupOk'].forEach(click);
    setTimeout(() => { click('btnPlayLocal'); setTimeout(() => { try { const c = d.querySelectorAll('.picker-card')[8] || d.querySelector('.picker-card'); if (c) c.click(); } catch (e) {} setTimeout(() => { click('pickerStart'); ['btnLeaderboardPopupOk', 'btnUpdateAnnounceOk', 'commentInviteDismiss'].forEach((id) => setTimeout(() => click(id), 3500)); }, 400); }, 1200); }, 900);
  }

  // ---- table select + boot --------------------------------------------------------------------------------------------------
  const tSel = $('edTableSelect');
  tSel.innerHTML = Object.keys(TABLES).map((k) => `<option value="${k}">${TABLES[k].label}</option>`).join('') + (tableKey === '4p' ? '<option value="__quick">▶ Quick start (offline game)</option>' : '');
  tSel.value = tableKey;
  tSel.addEventListener('change', () => { if (tSel.value === '__quick') { tSel.value = tableKey; quickStart(); } else location.search = '?table=' + tSel.value; });
  $('edBtnSave').addEventListener('click', save);

  frame.addEventListener('load', () => {
    const d = doc(), w = win(); if (!d || !w) return;
    try { T.legacy(d, w, config); } catch (e) {}
    LP.apply(d, w, config);
    d.__proAttached = false; kSamples.length = 0; shown.clear(); if (paused) { paused = false; setPause(true); }
    if (editMode) { installFrameHelpers(); attachEdit(); d.documentElement.classList.add('pro-editing'); }
    updateAll();
  });

  (async function boot() {
    buildDeviceSelect(); await loadConfig();
    let v = null; try { v = localStorage.getItem('proEditorDevice'); } catch (e) {}
    const m = v && v.match(/^(\d+)x(\d+)$/);
    const startW = m ? +m[1] : 390, startH = m ? +m[2] : 844;
    frame.src = T.src; setDevice(startW, startH, false);
    document.title = '28 Gulan — Pro Editor · ' + T.label;
    renderEdited(); syncUndo();
  })();

  // a small test hook (read-only helpers) so the editor can be driven reliably from automated tests
  window.__proEditor = { get config() { return config; }, get selection() { return S; }, setEdit, setPause, select, pickAt, runIssues, get issues() { return issues; }, testOthers, items, setDevice, kunukkuSampleOn, kunukkuSampleOff, kunukkuBanner };
})();
