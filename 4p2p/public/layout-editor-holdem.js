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
  const bgPanelEl = document.getElementById('edBgPanel');
  const btnLayersToggle = document.getElementById('edBtnLayersToggle');
  const layersPanel = document.getElementById('edLayersPanel');
  const btnBgToggle = document.getElementById('edBtnBgToggle');
  const bgDropdownPanel = document.getElementById('edBgDropdownPanel');

  let config = { portraitPhoto: {}, landscape: {} };
  let bgConfig = {}; // { landscape?: url, portrait?: url } -- custom uploaded photos, separate from config above
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
  // Kept in sync by fitFrameToStage() -- lets the drag-threshold check
  // below convert real iframe-pixel movement into actual on-screen pixels,
  // so "has the person moved far enough to mean a drag" feels the same
  // whether the table is currently shown at 50% or 150%.
  let currentScale = 1;

  // ---------------------------------------------------------------------
  // Toolbar dropdown menus (Layers, Background) -- replace the old
  // always-visible sidebar panels. Only one open at a time; either closes
  // on its own toggle button, on picking something inside it, or by
  // clicking anywhere else on the page.
  // ---------------------------------------------------------------------
  function closeDropdowns() {
    layersPanel.style.display = 'none';
    bgDropdownPanel.style.display = 'none';
    // Reuses the exact same "active" styling Edit Table uses -- one single
    // consistent color means "this is on/open" everywhere in the toolbar,
    // instead of a different accent per button (real complaint: the gold
    // Edit Table button next to a differently-colored Layers button read
    // as inconsistent/unpolished).
    btnLayersToggle.classList.remove('active');
    btnBgToggle.classList.remove('active');
  }
  // Positions a dropdown panel in real viewport coordinates from its
  // trigger button's actual on-screen position, clamped so the panel can
  // NEVER extend past either edge of the screen. Real, concrete bug this
  // replaces: a plain CSS `right:0` guess (relative to the button's own
  // wrapper) put the panel partway off the LEFT edge of the screen
  // whenever the button wasn't already flush against the right edge --
  // the page hides horizontal overflow, so that silently clipped the
  // first few letters of every line inside it ("the fuckin letters").
  // Computed fresh every time the panel opens, using getBoundingClientRect
  // (viewport coordinates), so it's correct regardless of the topbar's
  // own horizontal scroll position or the button's actual spot on screen.
  function positionDropdownPanel(panel, btn) {
    const btnRect = btn.getBoundingClientRect();
    const panelWidth = Math.min(320, window.innerWidth - 16);
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
  // Re-clamp on resize/orientation-change while a panel is open -- a phone
  // rotating mid-edit shouldn't leave the panel stranded off-screen.
  window.addEventListener('resize', () => {
    if (layersPanel.style.display !== 'none') positionDropdownPanel(layersPanel, btnLayersToggle);
    if (bgDropdownPanel.style.display !== 'none') positionDropdownPanel(bgDropdownPanel, btnBgToggle);
  });
  btnLayersToggle.addEventListener('click', (ev) => { ev.stopPropagation(); toggleDropdown(layersPanel, btnLayersToggle); });
  btnBgToggle.addEventListener('click', (ev) => { ev.stopPropagation(); toggleDropdown(bgDropdownPanel, btnBgToggle); });
  document.addEventListener('click', (ev) => {
    if (!ev.target.closest('.ed-dropdown-wrap')) closeDropdowns();
  });

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
    CARD_LAYERS.push({ key: 'cards' + i, slot: i, label: 'Dealt Cards — Slot ' + i, category: 'Dealt Cards (per seat)', type: 'cards', dragKind: 'cardsPosSize' });
  }
  // The numeric chip-count label under each player's name/avatar (e.g.
  // "985") -- text, not a chip disc, so its "size" is just font size.
  const CHIP_LABEL_LAYERS = [];
  for (let i = 0; i < LH.SEAT_COUNT; i++) {
    CHIP_LABEL_LAYERS.push({ key: 'chipLabel' + i, slot: i, label: 'Chip Count — Slot ' + i + (i === 0 ? ' (You)' : ''), category: 'Chip Count (per seat)', type: 'chipLabel', dragKind: 'fontSize' });
  }
  // Every CSS-type element now carries both position AND size (see the
  // comment above LH.ELEMENTS), so they all use the same drag kind.
  const CSS_DRAG_KIND = {
    dealer: 'posPercent+sizePx',
    boardArea: 'posPercent+sizePx',
    handStrip: 'posPercent+sizePx',
    potAnchor: 'posPercent+sizePx',
    actionBar: 'posPercent+sizePx',
    winnerPopup: 'posPercent+sizePx',
    tiltPopup: 'posPercent+sizePx',
    topbar: 'posPercent+sizePx',
    soundMute: 'posPercent+sizePx',
    betSlider: 'posPercent+sizePx',
    streetBanner: 'posPercent+sizePx',
    levelUpBanner: 'posPercent+sizePx',
    tableWinningHand: 'posPercent+sizePx',
    actBtnAllIn: 'posPercent+sizePx',
    actBtnBet: 'posPercent+sizePx',
    actBtnFold: 'posPercent+sizePx',
    actBtnCheck: 'posPercent+sizePx',
    potDisplayPot: 'posPercent+sizePx',
    potDisplayBet: 'posPercent+sizePx',
    // Position-only, and deliberately its own dragKind ('bgPosPercent',
    // not 'posPercent') -- see the effectiveValue/handleDragMove
    // branches below for why: .table-wrap is always full-screen, so
    // reading/writing its own bounding-box position (what 'posPercent'
    // does) would be meaningless here. This reads/writes the CSS
    // background-position-x/-y of the photo itself instead.
    tableBgPhoto: 'bgPosPercent',
  };
  const CSS_LAYERS = LH.ELEMENTS.map((el) => Object.assign({ type: 'css', dragKind: CSS_DRAG_KIND[el.key] || 'size' }, el));
  const ALL_LAYERS = SEAT_LAYERS.concat(CHIP_LAYERS, CARD_LAYERS, CHIP_LABEL_LAYERS, CSS_LAYERS);
  function layerByKey(key) { return ALL_LAYERS.find((l) => l.key === key) || null; }

  function bpInfo(key) { return LH.BREAKPOINTS.find((b) => b.key === key); }
  function cloneConfig() { return JSON.parse(JSON.stringify(config)); }
  function setStatus(text, kind) { statusEl.textContent = text; statusEl.className = kind || ''; }
  function round2(n) { return Math.round(n * 100) / 100; }
  function r1(n) { return Math.round(n * 10) / 10; }
  // px-per-design-unit of the preview right now (see unitFor in the engine):
  // saved sizes are stored in design units, measured/dragged px are divided
  // by this, so what you see in the editor is exactly what any phone shows.
  // The nudge applied to a seat's dealt cards / chip count (the CSS
  // `translate` property -- see nudgeOrNull in the engine for why).
  function readTranslate(win, el) {
    try {
      const t = win.getComputedStyle(el).translate;
      if (!t || t === 'none') return [0, 0];
      const p = t.split(/\s+/).map(parseFloat);
      return [p[0] || 0, p[1] || 0];
    } catch (e) { return [0, 0]; }
  }
  // The point an element's saved left/top place on screen. Elements the
  // engine re-centres (extraDecls translate(-50%,-50%)) are placed by their
  // CENTRE; everything else is placed by its top-left corner (+ any
  // translate its own stylesheet already applies). Measuring a corner-placed
  // element by its centre -- what this used to do for the action buttons,
  // bet slider, top bar, mute button and popups -- made it jump by half its
  // own size the first time it was touched.
  function anchorOf(win, el, rect, def) {
    if (def && /translate\(\s*-50%/.test(def.extraDecls || '')) return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    let tx = 0, ty = 0;
    try {
      const m = new win.DOMMatrix(win.getComputedStyle(el).transform);
      if (Math.abs(m.a - 1) < 1e-3 && Math.abs(m.d - 1) < 1e-3 && Math.abs(m.b) < 1e-3 && Math.abs(m.c) < 1e-3) { tx = m.e; ty = m.f; }
    } catch (e) {}
    return { x: rect.left - tx, y: rect.top - ty };
  }
  function uNow() { try { return LH.unitFor(frame.contentWindow) || 1; } catch (e) { return 1; } }
  // Merge ONLY the fields you actually changed into this element's saved
  // override. (Before, any drag/edit saved all four of left/top/width/
  // height from whatever was measured at that instant -- silently freezing
  // sizes you never touched, measured on whatever device the editor was
  // running on.)
  function patchSaved(key, patch) {
    const b = ensureBpBucket(currentBp);
    b[key] = Object.assign({}, b[key] || {}, patch);
    return b[key];
  }
  let moveTogether = false;
  try { moveTogether = localStorage.getItem('ledHoldemMoveTogether') === '1'; } catch (e) {}
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
    renderDeviceSelect();
    applyFrameSize();
    selectedKey = null;
    renderInspector();
    renderLayers();
    scheduleRebuildOverlays();
  });

  // ---------------------------------------------------------------------
  // Device preview. The preview used to be ONE fixed size (430x860 phone /
  // 1400x900 landscape), so what you perfected there was a different shape
  // from your own phone -- the background photo crops differently and
  // percentage positions land elsewhere. Now you pick the screen you are
  // designing for: common phones, "This device" (the exact size of the
  // screen you opened the editor on -- best choice when editing on your own
  // phone), or any custom width x height. Phone-landscape sizes also switch
  // the preview into touch mode (no mouse-only CSS), like a real phone.
  // ---------------------------------------------------------------------
  const deviceSelect = document.getElementById('edDeviceSelect');
  const DEVICES = {
    portraitPhoto: [
      { id: 'default', label: '430 × 860 (default)', w: 430, h: 860 },
      { id: 'p430', label: '430 × 932 · large iPhone', w: 430, h: 932 },
      { id: 'p412', label: '412 × 915 · Android', w: 412, h: 915 },
      { id: 'p393', label: '393 × 852 · iPhone 15', w: 393, h: 852 },
      { id: 'p390', label: '390 × 844 · iPhone 12–14', w: 390, h: 844 },
      { id: 'p375', label: '375 × 812 · iPhone mini/X', w: 375, h: 812 },
      { id: 'p360', label: '360 × 740 · small Android', w: 360, h: 740 },
    ],
    landscape: [
      { id: 'default', label: '1400 × 900 (default desktop)', w: 1400, h: 900 },
      { id: 'l1280', label: '1280 × 720 · laptop', w: 1280, h: 720 },
      { id: 'l915', label: '915 × 412 · phone (touch)', w: 915, h: 412, touch: true },
      { id: 'l844', label: '844 × 390 · phone (touch)', w: 844, h: 390, touch: true },
      { id: 'l740', label: '740 × 360 · small phone (touch)', w: 740, h: 360, touch: true },
    ],
  };
  let deviceChoice = {};           // bp -> { id, w, h, touch }
  try { deviceChoice = JSON.parse(localStorage.getItem('ledHoldemDevice') || '{}') || {}; } catch (e) { deviceChoice = {}; }
  function thisDeviceFits(bpKey) {
    const w = window.innerWidth, h = window.innerHeight;
    return bpKey === 'portraitPhoto' ? (w < 521 && h > w) : (w >= 521);
  }
  function deviceList(bpKey) {
    const list = DEVICES[bpKey].slice();
    if (thisDeviceFits(bpKey)) list.push({ id: 'device', label: '📱 This device (' + window.innerWidth + ' × ' + window.innerHeight + ')', w: window.innerWidth, h: window.innerHeight });
    const c = deviceChoice[bpKey];
    if (c && c.id === 'custom') list.push({ id: 'custom', label: 'Custom (' + c.w + ' × ' + c.h + ')', w: c.w, h: c.h, touch: !!c.touch });
    return list;
  }
  function previewDevice() {
    const list = deviceList(currentBp);
    const wantId = (deviceChoice[currentBp] && deviceChoice[currentBp].id) || 'default';
    let d = list.find((x) => x.id === wantId) || list[0];
    if (d.id === 'device') d = Object.assign({}, d, { w: window.innerWidth, h: window.innerHeight });
    return d;
  }
  function pv() { const d = previewDevice(); return { w: d.w, h: d.h, touch: !!d.touch }; }
  function renderDeviceSelect() {
    if (!deviceSelect) return;
    const list = deviceList(currentBp);
    const cur = previewDevice().id;
    deviceSelect.innerHTML = list.map((d) => '<option value="' + d.id + '">' + d.label + '</option>').join('') + '<option value="__custom">Custom size…</option>';
    deviceSelect.value = cur;
  }
  if (deviceSelect) {
    deviceSelect.addEventListener('change', () => {
      if (deviceSelect.value === '__custom') {
        const cur = pv();
        const raw = prompt('Preview size as WIDTH x HEIGHT in CSS pixels (e.g. 390x844):', cur.w + 'x' + cur.h);
        const m = raw && raw.match(/^\s*(\d{2,4})\s*[x×*,]\s*(\d{2,4})\s*$/i);
        if (!m) { renderDeviceSelect(); return; }
        const w = +m[1], h = +m[2];
        const fits = currentBp === 'portraitPhoto' ? (w < 521 && h > w) : (w >= 521);
        if (!fits) { alert(currentBp === 'portraitPhoto' ? 'Mobile Portrait needs a width under 521 and a height taller than the width.' : 'Landscape needs a width of 521 or more.'); renderDeviceSelect(); return; }
        deviceChoice[currentBp] = { id: 'custom', w, h, touch: currentBp === 'landscape' && w < 1000 };
      } else {
        deviceChoice[currentBp] = { id: deviceSelect.value };
      }
      try { localStorage.setItem('ledHoldemDevice', JSON.stringify(deviceChoice)); } catch (e) {}
      renderDeviceSelect();
      applyFrameSize();
    });
  }
  let frameTouchMode = false;      // is the iframe currently loaded in touch-emulation mode?
  function applyFrameSize() {
    const d = pv();
    // Touch emulation needs a fresh page load (the page reads ?emulate=touch
    // once, at start-up) -- only happens when switching between desktop-style
    // and phone-landscape previews.
    if (d.touch !== frameTouchMode) {
      frameTouchMode = d.touch;
      try { frame.src = 'holdem.html?editorPreview=1' + (d.touch ? '&emulate=touch' : ''); } catch (e) {}
    }
    frame.width = d.w;
    frame.height = d.h;
    frame.style.width = d.w + 'px';
    frame.style.height = d.h + 'px';
    try { frame.contentWindow.dispatchEvent(new Event('resize')); } catch (e) {}
    try { const cw = frame.contentWindow; if (cw && cw.LayoutHoldem) cw.LayoutHoldem.setScaleVar(frame.contentDocument); } catch (e) {}
    fitFrameToStage();
    scheduleRebuildOverlays();
    renderInspector();
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
    const bp = pv();
    frame.style.transform = 'none';
    frame.style.transformOrigin = 'top left';
    frameWrap.style.width = bp.w + 'px';
    frameWrap.style.height = bp.h + 'px';
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
      scale = Math.min(1, availW / bp.w, availH / bp.h);
    }
    if (scale > 0 && scale !== 1) {
      frame.style.transform = 'scale(' + scale + ')';
      frameWrap.style.width = Math.round(bp.w * scale) + 'px';
      frameWrap.style.height = Math.round(bp.h * scale) + 'px';
    }
    currentScale = scale > 0 ? scale : 1;
    zoomLabel.textContent = Math.round(scale * 100) + '%';
    scheduleRebuildOverlays();
  }
  window.addEventListener('resize', () => { if (manualZoom == null) fitFrameToStage(); });

  // Real, confirmed live report ("it's zooming to top left corner"): switching #edStage from
  // `justify-content:center` to `flex-start` + `margin:auto` on #edFrameWrap (see
  // layout-editor-holdem.css -- that change fixed a real bug where the left edge became
  // permanently unreachable after zooming in) only centers the frame while it's SMALLER than
  // the stage. The moment zooming in makes it bigger than the stage, `margin:auto` collapses to
  // 0 on both sides (there's no leftover space left to split), so the frame now starts flush
  // against the stage's top-left corner instead -- every zoom step was visibly jumping there.
  // CSS alignment was never actually "zooming toward the center" on its own; it only looked
  // that way before because centering a same-sized-both-ways box happens to do that. The real
  // fix is what every zoom UI actually does: explicitly keep one chosen point -- the stage's own
  // center for the +/-/Fit buttons, the cursor for ctrl+scroll, the pinch midpoint for pinch --
  // visually fixed by adjusting scroll position to match, regardless of how the box is aligned.
  function applyManualZoom(newZoom, anchorVX, anchorVY) {
    if (anchorVX == null) anchorVX = stage.clientWidth / 2;
    if (anchorVY == null) anchorVY = stage.clientHeight / 2;
    const oldWidth = frameWrap.offsetWidth || 1;
    const oldHeight = frameWrap.offsetHeight || 1;
    // Where the anchor point currently sits, as a fraction of the (pre-zoom) frame size --
    // this fraction is what has to stay under the same screen position after rescaling.
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
    const bp = pv();
    const current = manualZoom != null ? manualZoom : Math.min(1, (stage.clientWidth - 4) / bp.w, (stage.clientHeight - 4) / bp.h);
    let next;
    if (dir > 0) next = ZOOM_STEPS.find((s) => s > current + 0.001) || ZOOM_STEPS[ZOOM_STEPS.length - 1];
    else next = [...ZOOM_STEPS].reverse().find((s) => s < current - 0.001) || ZOOM_STEPS[0];
    applyManualZoom(next, stage.clientWidth / 2, stage.clientHeight / 2);
  }
  btnZoomOut.addEventListener('click', () => stepZoom(-1));
  btnZoomIn.addEventListener('click', () => stepZoom(1));
  btnZoomFit.addEventListener('click', () => { manualZoom = null; fitFrameToStage(); stage.scrollLeft = 0; stage.scrollTop = 0; });

  // ---------------------------------------------------------------------
  // Pinch / ctrl+scroll zoom -- scoped to just the table, never the
  // browser's own page zoom. Real, repeated report: using the normal
  // pinch or ctrl+scroll gesture zoomed the WHOLE page -- toolbar,
  // dropdowns, bottom bar and all -- instead of just the table being
  // edited, because the browser's native page-zoom was handling that
  // gesture by default (the viewport meta tag now stops that outright).
  // Every such gesture is caught here and redirected to this editor's own
  // zoom instead -- the exact same one the +/-/Fit buttons already drive
  // -- wired on both the outer page AND inside the iframe's own document
  // (a wheel/touch event that starts over the iframed table fires inside
  // ITS document, never reaching a listener on the outer page at all).
  // ---------------------------------------------------------------------
  function clampZoom(z) { return Math.min(3, Math.max(0.1, z)); }
  function currentEffectiveZoom() {
    const bp = pv();
    return manualZoom != null ? manualZoom : Math.min(1, (stage.clientWidth - 4) / bp.w, (stage.clientHeight - 4) / bp.h);
  }
  // A wheel/touch event that starts INSIDE the iframe reports clientX/clientY in the iframe's
  // own (unscaled) coordinate space, not the outer page's -- converts that into "pixels from
  // #edStage's own top-left", the same space applyManualZoom's anchor expects, by locating the
  // iframe element's own on-screen rect (which DOES already reflect the CSS scale transform)
  // and scaling the in-iframe point by the current zoom before adding it in.
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
    if (!ev.ctrlKey) return; // an ordinary scroll/trackpad pan is left completely alone
    ev.preventDefault();
    const sourceIsIframe = !!(ev.target && ev.target.ownerDocument && ev.target.ownerDocument !== document);
    const pt = clientPointToStageViewport(ev.clientX, ev.clientY, sourceIsIframe);
    zoomByFactor(ev.deltaY < 0 ? 1.08 : 1 / 1.08, pt.x, pt.y);
  }
  window.addEventListener('wheel', handleZoomWheel, { passive: false });

  let pinchStartDist = null;
  let pinchStartZoom = 1;
  // Real, confirmed live report ("when I pinch to zoom it only zoom in
  // one dimension...if not released move left right zoom left right"):
  // a genuine, real bug, not a perception thing. Pinching with two
  // fingers fires TWO separate 'pointerdown' events (one per finger) in
  // addition to the touch events this pinch handler already used -- so
  // if either finger landed on or near a seat/chip overlay box, that
  // box's own pointerdown handler (see wireBoxEvents/beginDrag below)
  // started a genuine element DRAG at the same time as the pinch. Worse,
  // that drag's own pointermove listener was never filtered to the ONE
  // finger that started it, so once two fingers were both moving, it
  // was reading a chaotic MIX of both fingers' coordinates as if they
  // were one continuous finger -- producing exactly the reported
  // "moves left/right, zooms left/right" erratic, one-axis-at-a-time
  // behavior, on top of (and fighting with) the real, correct 2D pinch
  // scale this code was already computing correctly the whole time.
  // `activeTouchPoints` lets both sides of that conflict be shut down
  // the instant a second finger appears -- see beginDrag/handleDragMove.
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
      // A second finger touching down always means "this is a pinch,"
      // even if the first finger had already started dragging an
      // element a moment earlier -- cancel that drag outright rather
      // than let it keep running alongside the pinch.
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
  fetch('/api/layout-config/holdem')
    .then((r) => r.json())
    .then((data) => {
      if (data && data.ok && data.config) config = Object.assign({ portraitPhoto: {}, landscape: {} }, data.config);
      setStatus("Layout loaded. Join/host a table inside the frame and start a hand, then turn on Edit Table.");
    })
    .catch(() => setStatus('Could not load saved layout (starting from the default table look).', 'error'))
    .finally(() => {
      renderDeviceSelect();
      applyFrameSize();
      renderLayers();
    });

  // Separate system, separate fetch -- see applyBackgroundConfig's own
  // comment in layout-engine-holdem.js. Loaded independently of the
  // position config above so one failing never blocks the other.
  fetch('/api/background-config/holdem')
    .then((r) => r.json())
    .then((data) => { if (data && data.ok) bgConfig = data; })
    .catch(() => {})
    .finally(() => renderBgPanel());

  frame.addEventListener('load', () => {
    try {
      const win = frame.contentWindow;
      // Phone-landscape preview: behave like a touch phone (see emulateTouch).
      if (frameTouchMode && win.LayoutHoldem) win.LayoutHoldem.emulateTouch(frame.contentDocument);
      // Pass a getter, not `config` itself -- `config` gets reassigned
      // wholesale (loading a saved layout, undo, redo), and the patched
      // seatPositions()/renderGameTable() need to keep reading whatever
      // it CURRENTLY points to, not a snapshot frozen at this moment.
      if (win.LayoutHoldem) win.LayoutHoldem.applyAll(frame.contentDocument, win, () => config);
      if (win.LayoutHoldem) win.LayoutHoldem.applyBackgroundConfig(frame.contentDocument, bgConfig);
      setupOverlayMutationObserver(frame.contentDocument, win);
      wireIframeZoomGestures(frame.contentDocument);
      // The frame can reload (e.g. leaving/rejoining a table) while Edit
      // Table is still switched on -- keep the forced-visible popups/
      // banners (see setPreviewOnClasses below) in sync with that.
      if (editMode && win.LayoutHoldem) win.LayoutHoldem.setPreviewOnClasses(frame.contentDocument, true);
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
  stage.addEventListener('pointerdown', (ev) => { if (ev.target === stage || ev.target === document.getElementById('edFrameWrap')) selectElement(null); });

  btnEditToggle.addEventListener('click', () => {
    editMode = !editMode;
    // The active/gold highlight alone says whether this is on -- no
    // ON/OFF text swap needed, one less thing for the label to shout.
    btnEditToggle.classList.toggle('active', editMode);
    frame.classList.toggle('editing', editMode);
    // Street Banner / Level-Up Banner / Winning Hand Reveal are normally
    // only shown by the real game for a moment, at specific points in a
    // hand -- at rest they're display:none/opacity:0 and invisible to
    // rebuildOverlays entirely (a zero-size element is skipped, same as
    // "nothing dealt there yet"), which is exactly why they were never
    // selectable/editable before ("animations I cannot edit"). Forcing
    // their `.on` class ONLY while Edit Table is on makes them render at
    // their configured spot so they can be selected/dragged here, same as
    // everything else -- and it's undone the instant Edit Table goes back
    // off, so it never touches what a real player sees mid-hand.
    try {
      const win = frame.contentWindow;
      if (win && win.LayoutHoldem) win.LayoutHoldem.setPreviewOnClasses(frame.contentDocument, editMode);
    } catch (e) {}
    if (editMode) { rebuildOverlays(); startLoop(); }
    else { stopLoop(); clearOverlays(); Object.keys(sentBack).forEach((k) => delete sentBack[k]); selectedKey = null; renderInspector(); }
  });

  // ---------------------------------------------------------------------
  // Pause / Play: freezes every running animation & transition on the
  // table (card deals, chip slides, glows, pulses...) so things hold still
  // while you position them. Editor-only -- injected into the preview
  // iframe, never saved, and Play (or leaving the page) restores it all.
  // The hand itself still advances on the server; only visuals freeze.
  // ---------------------------------------------------------------------
  const btnPause = document.getElementById('edBtnPause');
  let paused = false, pauseTimer = null;
  function freezeNow() {
    let doc;
    try { doc = frame.contentDocument; } catch (e) { return; }
    if (!doc) return;
    if (!doc.getElementById('led-pause-style') && doc.head) {
      const st = doc.createElement('style');
      st.id = 'led-pause-style';
      st.textContent = '*,*::before,*::after{animation-play-state:paused !important;transition:none !important}';
      doc.head.appendChild(st);
    }
    try { doc.getAnimations().forEach((a) => { try { a.pause(); } catch (e) {} }); } catch (e) {}
  }
  function setPaused(on) {
    paused = on;
    btnPause.classList.toggle('active', on);
    btnPause.textContent = on ? '▶ Play' : '⏸ Pause';
    let doc;
    try { doc = frame.contentDocument; } catch (e) { doc = null; }
    if (pauseTimer) { clearInterval(pauseTimer); pauseTimer = null; }
    if (on) {
      freezeNow();
      // animations started AFTER pausing (new deals, popups) get frozen too
      pauseTimer = setInterval(freezeNow, 120);
    } else if (doc) {
      const st = doc.getElementById('led-pause-style');
      if (st) st.remove();
      try { doc.getAnimations().forEach((a) => { try { a.play(); } catch (e) {} }); } catch (e) {}
    }
  }
  btnPause.addEventListener('click', () => setPaused(!paused));
  // a reloaded preview (breakpoint switch) starts un-frozen -- re-apply if still paused
  frame.addEventListener('load', () => { if (paused) setPaused(true); });

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
    // Real, confirmed fix for the new chip-color layers: these have no
    // `selector` at all (there's no single DOM element a chip's color
    // lives on -- see applyChipTierColors in layout-engine-holdem.js) --
    // without this, the generic `doc.querySelector(def.selector)` below
    // would be called with undefined and throw.
    if (def.type === 'chipTier') return null;
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
    /* touch-action:none is the fix for a real, live-phone-only bug: without
       it, a finger-drag that starts on one of these boxes can get claimed
       by the browser's own native scroll/pan gesture instead of reaching
       our pointermove handler at all -- it LOOKS like "nothing drags,"
       because from the browser's point of view the whole page (or iframe)
       just panned a few pixels under your finger and swallowed the
       gesture. A mouse has no such native gesture to compete with, which
       is exactly why this never showed up in mouse-driven testing. */
    /* Boxes are INVISIBLE until you hover (mouse) or select them -- still
       hit-testable so a tap/click lands, but nothing glows on the table by
       default. Hover = blue outline + the element's name; selected = gold
       outline + name + resize handle. */
    .led-box{position:fixed;border:2px solid transparent;background:transparent;box-shadow:none;z-index:2147483000;cursor:pointer;box-sizing:border-box;animation:none;touch-action:none;-ms-touch-action:none}
    .led-box.led-nodrag{cursor:default}
    .led-box.led-hover{border:2px dashed #4aa3ff;background:rgba(74,163,255,0.14);box-shadow:0 0 0 1px rgba(0,0,0,0.5),0 0 10px rgba(74,163,255,0.6);cursor:move}
    .led-box.led-selected{border:3px solid #f4c430;background:rgba(244,196,48,0.18);box-shadow:0 0 0 1px rgba(0,0,0,0.6),0 0 16px rgba(244,196,48,0.9);z-index:2147483001;cursor:move}
    .led-box.led-dimmed{opacity:1;animation:none}
    .led-label{display:none;position:absolute;top:-24px;left:-3px;z-index:2;background:#12181f;color:#e8edf2;font:800 11px -apple-system,sans-serif;padding:3px 7px;border-radius:4px;white-space:nowrap;pointer-events:none;box-shadow:0 2px 6px rgba(0,0,0,0.6);border:1px solid rgba(74,163,255,0.6)}
    .led-box.led-hover .led-label,.led-box.led-selected .led-label{display:block}
    .led-box.led-selected .led-label{background:#f4c430;color:#241a12;border-color:#f4c430}
    .led-handle{display:none;position:absolute;width:20px;height:20px;background:#f4c430;border:2.5px solid #241a12;border-radius:4px;cursor:nwse-resize;z-index:2147483002;box-shadow:0 2px 8px rgba(0,0,0,0.6);touch-action:none;-ms-touch-action:none}
    /* Real, concrete bug this fixes: a small element (a chip pile is only
       ~9px on screen) gets its BOX inflated up to 30x30 for tappability
       (MIN_TOUCH_TARGET below), but the resize handle used to sit at
       right:-10px/bottom:-10px -- measured from that INFLATED box's own
       corner, not the tiny real element -- which put the handle
       overlapping the box's own bottom-right ~8x8px region. Reported
       symptom: "when I move the chips it's changing width" -- dragging
       what looked like the middle of the chip was actually landing on
       the resize handle sitting on top of it. Offsetting the handle by
       its own full width/height (instead of half) means it never
       overlaps the box at all -- it sits fully outside it, corner-
       adjacent but with zero shared pixels, so a move-drag anywhere
       inside the box can never be mistaken for a resize-drag again. */
    .led-handle.led-br{right:-22px;bottom:-22px}
    /* On a crowded seat, two elements' resize handles can sit almost on
       top of each other (an avatar's corner and its own seat's dealt
       cards, say). Once you've selected one of them, ITS handle always
       wins that overlap -- so the second tap-and-drag (the actual
       resize gesture) reliably lands on the element you meant, even
       though the very first tap that picked it was itself ambiguous. */
    .led-box.led-selected .led-handle{display:block;z-index:2147483003}
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
    // A real game re-render (renderGameTable's own innerHTML diffing, same
    // mechanism the MutationObserver above watches for) can recreate the
    // street/level-up/winning-hand nodes from scratch, dropping the forced
    // `.on` class this same toggle set a moment ago -- reapplying it on
    // every rebuild (cheap, a no-op once it's already set) keeps them
    // visible/selectable the whole time Edit Table stays on.
    try { if (win.LayoutHoldem) win.LayoutHoldem.setPreviewOnClasses(doc, true); } catch (e) {}
    ALL_LAYERS.forEach((def) => {
      // The background photo is a special case: its real element
      // (.table-wrap) covers the ENTIRE table full-screen, underneath
      // everything else. Real report: giving it a canvas overlay box like
      // every other layer meant that box -- being full-screen -- sat on
      // top of and intercepted taps meant for seats/chips/cards beneath
      // it ("when I touch other items it will click background"). It's
      // no longer given a box on the canvas at all -- still fully
      // selectable and editable, just only through the Background/Layers
      // dropdown menus and the X/Y fields that opens, never by tapping
      // the table itself.
      if (def.key === 'tableBgPhoto') return;
      const target = targetFor(doc, win, def);
      if (!target) return;
      // Real report, confirmed by screenshot: selecting a Seat highlighted
      // "the whole thing including chips cards" -- because `target` for a
      // seat is the ENTIRE .seat container (name, chip-count label, dealt
      // cards and the fold badge all live inside it too, each with its
      // own separate layer already). The box/handle shown and dragged
      // here now traces just the avatar photo instead -- matching what
      // resizing actually changes -- while MOVING a seat still correctly
      // repositions the whole group together underneath (handleDragMove
      // still operates on `target`, the real seat element, unchanged).
      let visualTarget = target;
      if (def.type === 'seat') {
        const avatarWrap = target.querySelector('.seat-avatar-wrap');
        if (avatarWrap) visualTarget = avatarWrap;
      }
      const rect = visualTarget.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return;
      const box = doc.createElement('div');
      box.className = 'led-box';
      box.title = def.label;
      const label = doc.createElement('div');
      label.className = 'led-label';
      label.textContent = def.label;
      box.appendChild(label);
      let handle = null;
      if (def.dragKind === 'size' || def.dragKind === 'posPercent+sizePx' || def.dragKind === 'seatPosSize' || def.dragKind === 'cardsPosSize' || def.dragKind === 'fontSize') {
        handle = doc.createElement('div');
        handle.className = 'led-handle led-br';
        box.appendChild(handle);
      }
      doc.body.appendChild(box);
      overlays[def.key] = { box, handle, target, visualTarget, def };
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
    // Tap/click anywhere that is NOT an element box = deselect everything.
    doc.body.addEventListener('pointerdown', (ev) => {
      const hitBox = ev.target && ev.target.closest && ev.target.closest('.led-box');
      if (!hitBox) selectElement(null);
    });
    // Mouse hover: outline + name of the ONE element under the pointer
    // (touch has no hover -- a tap selects and shows the name instead).
    doc.addEventListener('pointermove', (ev) => {
      if (ev.pointerType !== 'mouse' || dragState) return;
      setHover(pickAt(ev.clientX, ev.clientY));
    });
    doc.addEventListener('pointerleave', () => setHover(null));
    doc.documentElement.addEventListener('mouseleave', () => setHover(null));
  }
  // When boxes overlap (avatar / cards / chips on a seat), the SMALLEST box
  // under the pointer wins -- so small things stay pickable under big ones.
  // EDIT-ONLY stacking: double-click (or double-tap) an element to send it
  // to the BOTTOM of whatever it overlaps, so the next one underneath can be
  // picked. Never touches the real table's z-order or the saved layout, and
  // is forgotten when Edit Table is turned off.
  const sentBack = {};      // key -> order it was sent back (higher = further back)
  let sentBackCounter = 0;
  function pickAt(x, y) {
    let best = null, bestScore = null;
    Object.values(overlays).forEach((o) => {
      if (o.box.style.display === 'none') return;
      const r = o.box.getBoundingClientRect();
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) return;
      const area = r.width * r.height;
      // not-sent-back first, then (among those) smallest; sent-back ones
      // rank behind everything, most recently sent = furthest back.
      const score = [sentBack[o.def.key] || 0, area];
      if (!bestScore || score[0] < bestScore[0] || (score[0] === bestScore[0] && score[1] < bestScore[1])) { bestScore = score; best = o; }
    });
    return best;
  }
  function sendToBack(key) {
    sentBack[key] = ++sentBackCounter;
    // If everything under the pointer has been sent back, start the cycle over.
  }
  let lastTap = { t: 0, x: 0, y: 0 };
  let hoverKey = null;
  function setHover(o) {
    const key = o && o.def.key !== selectedKey ? o.def.key : null;
    if (key === hoverKey) return;
    hoverKey = key;
    Object.entries(overlays).forEach(([k, ov]) => ov.box.classList.toggle('led-hover', k === key));
  }

  // Comfortable minimum touch/click target -- several real elements (a
  // single chip disc, a mini card back) are only 8-20px on screen, which
  // is unusable to tap precisely, worse once the whole table is scaled
  // down to fit a phone screen. The VISIBLE border still traces the real
  // element, but the box is inflated (symmetrically, around the same
  // center) to at least this size so it's actually possible to hit.
  const MIN_TOUCH_TARGET = 30;
  function repositionOverlays() {
    Object.values(overlays).forEach(({ box, target, visualTarget }) => {
      const r = (visualTarget || target).getBoundingClientRect();
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
      // Overlapping boxes: act on the smallest one under the pointer, not
      // just whichever happens to be on top. The already-selected element
      // keeps priority so re-dragging it never jumps to something else.
      const hit = pickAt(ev.clientX, ev.clientY);
      const selO = selectedKey && overlays[selectedKey];
      let useDef = def;
      if (selO) {
        const sr = selO.box.getBoundingClientRect();
        const inSel = ev.clientX >= sr.left && ev.clientX <= sr.right && ev.clientY >= sr.top && ev.clientY <= sr.bottom;
        if (inSel) useDef = selO.def; else if (hit) useDef = hit.def;
      } else if (hit) useDef = hit.def;
      selectElement(useDef.key);
      // Double-click / double-tap = send this element to the BOTTOM of the
      // overlap stack (edit-only) and pick whatever is now on top. Decided
      // on RELEASE, and only when that press never turned into a drag -- so
      // "tap to select, then immediately drag" can never be mistaken for a
      // double-click (the earlier version decided on the second PRESS and
      // swallowed such drags).
      const downX = ev.clientX, downY = ev.clientY, downKey = useDef.key;
      const onTapUp = (up) => {
        if (up.pointerId !== ev.pointerId) return;
        doc.removeEventListener('pointerup', onTapUp, true);
        doc.removeEventListener('pointercancel', onTapUp, true);
        if (up.type === 'pointercancel') { lastTap = { t: 0, x: 0, y: 0 }; return; }
        const wasDrag = !!(dragState && dragState.def.key === downKey && dragState.crossedThreshold) || dragMovedSinceDown;
        if (wasDrag) { lastTap = { t: 0, x: 0, y: 0 }; return; }
        const now = Date.now();
        const isDouble = (now - lastTap.t) < 380 && Math.abs(downX - lastTap.x) < 12 && Math.abs(downY - lastTap.y) < 12;
        if (!isDouble) { lastTap = { t: now, x: downX, y: downY }; return; }
        lastTap = { t: 0, x: 0, y: 0 };
        const under = selectedKey && overlays[selectedKey] ? overlays[selectedKey].def.key : downKey;
        sendToBack(under);
        const next = pickAt(downX, downY);
        selectElement(next ? next.def.key : null);
      };
      let dragMovedSinceDown = false;
      const onTapMove = (mv) => {
        if (mv.pointerId !== ev.pointerId) return;
        if (Math.hypot(mv.clientX - downX, mv.clientY - downY) * currentScale >= DRAG_THRESHOLD_PX) dragMovedSinceDown = true;
      };
      doc.addEventListener('pointermove', onTapMove, true);
      doc.addEventListener('pointerup', (u) => { doc.removeEventListener('pointermove', onTapMove, true); }, { once: true, capture: true });
      doc.addEventListener('pointerup', onTapUp, true);
      doc.addEventListener('pointercancel', onTapUp, true);
      // A pinch's SECOND finger lands its own separate pointerdown too --
      // never let that one start (or fight) a drag; two fingers down
      // always means "zoom," never "move this element" (see
      // activeTouchPoints above).
      if (activeTouchPoints >= 2) return;
      if (useDef.dragKind === 'size') return; // resize-only elements have no body-drag
      beginDrag(doc, win, useDef, ev, 'move');
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

  // A real, deliberate drag distance before anything actually moves or
  // gets written to the config -- measured in true on-screen pixels
  // (divided back out of currentScale so it feels the same at any zoom
  // level). Fixes a real report ("when I try to select to move it down the
  // items are catching right away and moving"): with no threshold, a
  // plain click to just SELECT something -- any tiny 1-2px hand-shake
  // between pointerdown and pointerup, completely normal with a mouse or
  // a finger -- was read as a genuine drag, silently nudging the element
  // and recording an undo step for a click that was never meant to move
  // anything. Now a click that doesn't clear this distance changes
  // nothing at all; only a real drag does.
  const DRAG_THRESHOLD_PX = 4;

  function beginDrag(doc, win, def, ev, mode) {
    ev.preventDefault();
    const startX = ev.clientX, startY = ev.clientY;
    const tableRect = referenceRectOf(doc, def);
    const startVal = Object.assign({}, effectiveValue(doc, win, def));
    // Real, confirmed live report ("if not released move left right zoom
    // left right...one dimension"): pointermove was never filtered to
    // the ONE finger/pointer that actually started this drag, so once a
    // second finger came down to pinch-zoom, ITS pointermove events were
    // also reaching this same handler and getting blended into the same
    // dx/dy math as the first finger's -- two different fingers' motion
    // read as if they were one, producing exactly that erratic,
    // one-axis-at-a-time behavior. Recording which pointer started this
    // drag, and ignoring every other pointer's events in handleDragMove,
    // is what actually fixes it (activeTouchPoints above additionally
    // stops a drag from starting at all once a pinch is already under way).
    dragState = { def, mode, startX, startY, startVal, tableRect, doc, win, crossedThreshold: false, pointerId: ev.pointerId };
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
    // A pinch beginning mid-drag (or the OS claiming the gesture for
    // something else) fires 'pointercancel', not 'pointerup', on the
    // pointer that was dragging -- without also cleaning up here, that
    // pointer's onMove listener never got removed, leaking a stale
    // listener that could still react to a completely different,
    // later pointer reusing the same id.
    doc.addEventListener('pointercancel', onUp);
  }

  // ---- seat parts: independent by default -------------------------------
  // A seat's dealt cards, chip count and chip pile all live INSIDE (or are
  // anchored to) the seat, so moving the seat used to drag every one of them
  // along ("elements are attached -- when one moves the next moves"). By
  // default the parts now stay exactly where they are on screen while the
  // avatar moves: we pin their current spot and cancel out the seat's own
  // movement. Tick "Move seat parts together" to get the old group move.
  function capturePartStart(doc, win, def) {
    const ps = {};
    const cd = layerByKey('cards' + def.slot);
    if (cd) { const v = effectiveValue(doc, win, cd); ps.cards = { offsetX: v.offsetX, offsetY: v.offsetY }; }
    const ld = layerByKey('chipLabel' + def.slot);
    if (ld) { const v = effectiveValue(doc, win, ld); ps.chipLabel = { offsetX: v.offsetX, offsetY: v.offsetY }; }
    return ps;
  }
  // Pins the chip pile at its CURRENT on-screen spot (position only -- its
  // size is left as the game draws it) so it stops tracking its seat.
  function pinChipPile(doc, win, slot) {
    const chipDef = layerByKey('chipPile' + slot);
    const bucket = config[currentBp] || {};
    if (!chipDef || bucket['chipPile' + slot]) return;
    const pinned = effectiveValue(doc, win, chipDef);
    if (pinned.left == null || pinned.top == null || isNaN(pinned.left) || isNaN(pinned.top)) return;
    patchSaved('chipPile' + slot, { left: pinned.left, top: pinned.top });
    try { if (win.LayoutHoldem) win.LayoutHoldem.applySeatStyles(doc, win, config); } catch (e) {}
    markLayerEdited('chipPile' + slot);
  }
  // The four action buttons live side by side in ONE flex row. Taking a single
  // button out of that row (position:fixed, which is what moving it does)
  // makes the other three reflow into the gap -- they visibly jump/stretch,
  // which looks exactly like "when I move one, the next one moves too".
  // The first time any of them is touched, all four are pinned at their
  // CURRENT on-screen spot and size, so nothing reflows and each one is
  // truly independent from then on.
  const ACTION_GROUP = ['actBtnAllIn', 'actBtnBet', 'actBtnFold', 'actBtnCheck'];
  function pinActionGroup(doc, win, def) {
    if (!def || ACTION_GROUP.indexOf(def.key) < 0) return;
    const b = config[currentBp] || {};
    if (ACTION_GROUP.some((k) => b[k] && b[k].left !== undefined)) return; // already detached together
    const vals = ACTION_GROUP.map((k) => ({ k, v: effectiveValue(doc, win, layerByKey(k)) }));
    if (vals.some((x) => x.v.left == null || isNaN(x.v.left) || isNaN(x.v.width))) return;
    vals.forEach((x) => patchSaved(x.k, { left: x.v.left, top: x.v.top, width: x.v.width, height: x.v.height }));
    try { LH.applyCSSConfig(doc, config); } catch (e) {}
    ACTION_GROUP.forEach(markLayerEdited);
  }

  // Single place that moves a seat (drag AND the X/Y boxes use it).
  function setSeatPosition(doc, win, def, startVal, partStart, newX, newY) {
    ensureSeatsBucket(currentBp)[def.slot] = { x: newX, y: newY };
    if (moveTogether || !partStart) return;
    const tr = tableRectOf(doc), u = uNow();
    const mvX = ((newX - startVal.x) / 100) * tr.width / u;
    const mvY = ((newY - startVal.y) / 100) * tr.height / u;
    if (partStart.cards) patchSaved('cards' + def.slot, { offsetX: r1(partStart.cards.offsetX - mvX), offsetY: r1(partStart.cards.offsetY - mvY) });
    if (partStart.chipLabel) patchSaved('chipLabel' + def.slot, { offsetX: r1(partStart.chipLabel.offsetX - mvX), offsetY: r1(partStart.chipLabel.offsetY - mvY) });
  }

  function handleDragMove(ev) {
    if (!dragState) return;
    if (ev.pointerId !== dragState.pointerId) return; // a second finger's own movement -- never this drag's
    const { def, mode, startX, startY, startVal, tableRect, doc, win } = dragState;
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    if (!dragState.crossedThreshold) {
      const screenDist = Math.hypot(dx, dy) * currentScale;
      if (screenDist < DRAG_THRESHOLD_PX) return; // still just a click/jitter -- do nothing yet
      dragState.crossedThreshold = true;
      pushUndoSnapshot(); // record the undo step only once a real drag actually starts
      // Seat body-drag: freeze the parts that should stay put BEFORE the
      // seat moves at all (gated on the real threshold, so a plain
      // click-to-select never pins or edits anything).
      if (def.type === 'css') pinActionGroup(doc, win, def);
      if (def.type === 'seat' && mode === 'move') {
        dragState.partStart = capturePartStart(doc, win, def);
        if (!moveTogether) pinChipPile(doc, win, def.slot);
      }
    }
    // px moved in the page -> design units (so a saved size means the same
    // thing on every phone width).
    const u = uNow();
    const dxu = dx / u, dyu = dy / u;
    const cur = Object.assign({}, startVal);

    if (def.type === 'seat') {
      if (mode === 'resize') {
        cur.width = Math.max(8, r1(startVal.width + dxu));
        cur.height = Math.max(8, r1(startVal.height + dyu));
        ensureBpBucket(currentBp)['avatar' + def.slot] = { width: cur.width, height: cur.height };
      } else {
        cur.x = round2(startVal.x + (dx / tableRect.width) * 100);
        cur.y = round2(startVal.y + (dy / tableRect.height) * 100);
        setSeatPosition(doc, win, def, startVal, dragState.partStart, cur.x, cur.y);
      }
      try { if (win.LayoutHoldem) win.LayoutHoldem.forceRerender(); } catch (e) {}
    } else if (def.type === 'cards') {
      // Dealt (hole) cards at another seat: a plain pixel nudge from the
      // card-back's own default spot (it is positioned relative to its own
      // small .seat box, not the whole table), plus size.
      if (mode === 'resize') {
        cur.width = Math.max(8, r1(startVal.width + dxu));
        cur.height = Math.max(8, r1(startVal.height + dyu));
        patchSaved(def.key, { width: cur.width, height: cur.height });
      } else {
        cur.offsetX = r1(startVal.offsetX + dxu);
        cur.offsetY = r1(startVal.offsetY + dyu);
        patchSaved(def.key, { offsetX: cur.offsetX, offsetY: cur.offsetY });
      }
      try { if (win.LayoutHoldem) win.LayoutHoldem.applySeatStyles(doc, win, config); } catch (e) {}
    } else {
      let patch = null;
      if (def.dragKind === 'size') {
        patch = { width: Math.max(8, r1(startVal.width + dxu)), height: Math.max(8, r1(startVal.height + dyu)) };
      } else if (def.dragKind === 'posPercent' || def.dragKind === 'bgPosPercent') {
        patch = { left: round2(startVal.left + (dx / tableRect.width) * 100), top: round2(startVal.top + (dy / tableRect.height) * 100) };
      } else if (def.dragKind === 'posPercent+sizePx') {
        if (mode === 'move') {
          patch = { left: round2(startVal.left + (dx / tableRect.width) * 100), top: round2(startVal.top + (dy / tableRect.height) * 100) };
        } else {
          patch = { width: Math.max(8, r1(startVal.width + dxu)), height: Math.max(8, r1(startVal.height + dyu)) };
        }
      } else if (def.dragKind === 'fontSize') {
        if (mode === 'move') patch = { offsetX: r1(startVal.offsetX + dxu), offsetY: r1(startVal.offsetY + dyu) };
        else patch = { fontSize: Math.max(6, r1(startVal.fontSize + dyu)) };
      }
      if (patch) patchSaved(def.key, patch);
      if (def.type === 'css') {
        try { LH.applyCSSConfig(doc, config); } catch (e) {}
      } else {
        // Per-seat chip pile / chip-count overrides aren't CSS-selector
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
      else if (avatarEl) { const r = avatarEl.getBoundingClientRect(); const u = uNow(); width = r1(r.width / u); height = r1(r.height / u); }
      return { x, y, width, height };
    }
    // Real, confirmed feature per the chip-colors request: no live DOM
    // target to measure at all (a chip's color is computed in JS per
    // instance, not sitting as one element's style) -- reads straight
    // from the live page's own CHIP_COLOR_STOPS array for this tier's
    // current 3 stops, falling back to the plain saved value if the
    // iframe isn't reachable for whatever reason.
    if (def.type === 'chipTier') {
      const saved = bucket[def.key];
      const stop = win && win.CHIP_COLOR_STOPS && win.CHIP_COLOR_STOPS[def.tierIndex];
      const live = stop ? { chipColorA: stop.colors[0], chipColorB: stop.colors[1], chipColorC: stop.colors[2] } : {};
      return Object.assign({}, live, saved || {});
    }
    if (def.type === 'cards') {
      const saved = bucket[def.key];
      const target = targetFor(doc, win, def);
      let offsetX = 0, offsetY = 0, width = 40, height = 57;
      if (target) {
        { const u = uNow(); const tr = readTranslate(win, target); offsetX = r1(tr[0] / u); offsetY = r1(tr[1] / u); }
        // Measure the actual mini card, not the two-card container (which
        // includes both cards plus the gap between them) -- otherwise the
        // inspector would show roughly double the real per-card size.
        const cm = target.querySelector('.card.mini');
        if (cm) { const r = cm.getBoundingClientRect(); const u = uNow(); width = r1(r.width / u); height = r1(r.height / u); }
      }
      return Object.assign({ offsetX, offsetY, width, height }, saved || {});
    }
    const saved = bucket[def.key];
    const target = targetFor(doc, win, def);
    let live = {};
    if (target) {
      const rect = target.getBoundingClientRect();
      const tableRect = referenceRectOf(doc, def);
      const U = uNow();
      if (def.dragKind === 'size') {
        live = { width: r1(rect.width / U), height: r1(rect.height / U) };
      } else if (def.dragKind === 'posPercent') {
        const an = anchorOf(win, target, rect, def);
        live = { left: round2(((an.x - tableRect.left) / tableRect.width) * 100), top: round2(((an.y - tableRect.top) / tableRect.height) * 100) };
      } else if (def.dragKind === 'bgPosPercent') {
        // .table-wrap's own box is always the full screen -- there's no
        // meaningful "where is this element" to measure via its rect, so
        // unlike posPercent above, this reads the actual CSS
        // background-position-x/-y of the photo instead. Chromium (and
        // every other engine tested) reports this back as a percentage
        // when it was set as one, matching the % this same value gets
        // written as on save -- parseFloat handles that directly; a
        // keyword fallback ('center' etc, which some engines could in
        // principle report) falls back to 50 (dead center), matching the
        // base stylesheet's own default.
        const cs = win.getComputedStyle(target);
        const parsePct = (raw) => { const n = parseFloat(raw); return isNaN(n) ? 50 : n; };
        live = { left: parsePct(cs.backgroundPositionX), top: parsePct(cs.backgroundPositionY) };
      } else if (def.dragKind === 'posPercent+sizePx') {
        const an = anchorOf(win, target, rect, def);
        // Community Cards / Your Hand: position is measured off the
        // container (`rect`, above), but size needs to come from an
        // actual card inside it (`sizeSelector`) -- the container's own
        // rect spans BOTH cards plus the gap between them, which would
        // show roughly double the real per-card size otherwise.
        let sizeRect = rect;
        if (def.sizeSelector) {
          const sizeTarget = doc.querySelector(def.sizeSelector);
          if (sizeTarget) sizeRect = sizeTarget.getBoundingClientRect();
        }
        live = {
          left: round2(((an.x - tableRect.left) / tableRect.width) * 100), top: round2(((an.y - tableRect.top) / tableRect.height) * 100),
          width: r1(sizeRect.width / U), height: r1(sizeRect.height / U),
        };
      } else if (def.dragKind === 'fontSize') {
        const trl = readTranslate(win, target);
        live = {
          offsetX: r1(trl[0] / U),
          offsetY: r1(trl[1] / U),
          fontSize: r1((parseFloat(win.getComputedStyle(target).fontSize) || 10 * U) / U),
        };
      } else if (def.dragKind === 'fontSizeRotate') {
        // Same measurement as fontSize above, plus rotate -- deliberately
        // NOT read back from the live computed transform (that reports a
        // full matrix(...), not a plain degrees number, and parsing one
        // back out reliably isn't worth it here) -- 0 unless already
        // saved, same fallback shape as every other field on this type.
        live = {
          offsetX: r1((parseFloat(win.getComputedStyle(target).marginLeft) || 0) / U),
          offsetY: r1((parseFloat(win.getComputedStyle(target).marginTop) || 0) / U),
          fontSize: r1((parseFloat(win.getComputedStyle(target).fontSize) || 10 * U) / U),
          rotate: 0,
        };
      } else if (def.dragKind === 'cardStyle') {
        const cs = win.getComputedStyle(target);
        live = {
          bgColor: rgbToHex(cs.backgroundColor) || '#fff8e7',
          borderColor: rgbToHex(cs.borderColor) || '#000000',
          borderWidth: r1((parseFloat(cs.borderWidth) || 0) / U),
          shadowDepth: 2,
        };
      } else if (def.dragKind === 'suitTextColor') {
        live = { suitColor: rgbToHex(win.getComputedStyle(target).color) || '#000000' };
      }
    } else if (def.dragKind === 'size') {
      // Reasonable fallbacks for when nothing's on screen yet to measure
      // (e.g. no hand dealt, no cards dealt to that seat yet) -- overwritten
      // the instant a real element shows up, and self-correcting on the
      // very next read.
      const SIZE_FALLBACKS = { boardArea: { width: 44, height: 62 }, handStrip: { width: 44, height: 62 } };
      live = SIZE_FALLBACKS[def.key] || { width: 44, height: 62 };
    } else if (def.dragKind === 'fontSize') {
      live = { offsetX: 0, offsetY: 0, fontSize: 10 };
    } else if (def.dragKind === 'fontSizeRotate') {
      live = { offsetX: 0, offsetY: 0, fontSize: 10, rotate: 0 };
    } else if (def.dragKind === 'cardStyle') {
      live = { bgColor: '#fff8e7', borderColor: '#000000', borderWidth: 0, shadowDepth: 2 };
    } else if (def.dragKind === 'suitTextColor') {
      live = { suitColor: '#000000' };
    }
    return Object.assign({}, live, saved || {});
  }
  // Real, confirmed helper for the color-picker fields above: reading a
  // live computed style back gives "rgb(r, g, b)" (or "rgba(...)"),
  // never a hex string -- but <input type="color"> only accepts hex, so
  // this converts one to the other. Returns null (letting the caller's
  // own fallback hex take over) for anything it can't parse, including
  // "transparent"/"rgba(0,0,0,0)", since a color picker can't represent
  // "no color" anyway.
  function rgbToHex(rgbStr) {
    if (!rgbStr) return null;
    const m = rgbStr.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
    if (!m) return null;
    if (m[4] !== undefined && parseFloat(m[4]) === 0) return null;
    const toHex = (n) => Number(n).toString(16).padStart(2, '0');
    return '#' + toHex(m[1]) + toHex(m[2]) + toHex(m[3]);
  }

  // ---------------------------------------------------------------------
  // Selection + Layers panel
  // ---------------------------------------------------------------------
  function selectElement(key) { selectedKey = key; setSelected(key); renderInspector(); renderLayers(); }
  function setSelected(key) {
    // Earlier version of this made every OTHER box pointer-events:none
    // while one was selected, to stop an overlapping handle from
    // stealing a drag. Real report after shipping that: tapping a
    // different, unselected avatar directly on the table then did
    // nothing at all ("I cannot move avatars") whenever something else
    // had been selected moments before -- worse than the bug it fixed.
    // Every box stays tappable now. What actually protects a drag from
    // landing on the wrong overlapping element is z-index: the selected
    // element (and its resize handle) always sorts on top, so once
    // you've selected the one you mean, dragging it again reliably hits
    // IT even if something else visually overlaps at that spot.
    Object.entries(overlays).forEach(([k, o]) => {
      const isSel = k === key;
      o.box.classList.toggle('led-selected', isSel);
      if (isSel) o.box.classList.remove('led-hover');
    });
  }

  function isEdited(def) {
    const bucket = config[currentBp];
    if (!bucket) return false;
    if (def.type === 'seat') return !!(bucket.seats && bucket.seats[def.slot]) || !!bucket['avatar' + def.slot] || !!bucket['avatarOverlap' + def.slot];
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
  const FIELD_META = { x: { label: 'X', unit: '%' }, y: { label: 'Y', unit: '%' }, left: { label: 'X', unit: '%' }, top: { label: 'Y', unit: '%' }, width: { label: 'W', unit: 'px' }, height: { label: 'H', unit: 'px' }, fontSize: { label: 'Size', unit: 'px' }, offsetX: { label: 'X', unit: 'px' }, offsetY: { label: 'Y', unit: 'px' }, rotate: { label: 'Rotate', unit: '°' },
    // Real, confirmed feature per explicit request ("card colors
    // borders... depth tilt design... color changes"): color fields are
    // a genuinely different kind of input from every field above (a
    // color swatch, not a number+unit), marked with isColor so
    // renderInspector below knows to render <input type="color"> and
    // skip appending a unit or coercing the value through Number(...).
    suitColor: { label: 'Color', isColor: true },
    bgColor: { label: 'Background', isColor: true },
    borderColor: { label: 'Border Color', isColor: true },
    borderWidth: { label: 'Border Width', unit: 'px' },
    shadowDepth: { label: 'Depth (Shadow)', unit: 'px' },
    chipColorA: { label: 'Color (center)', isColor: true },
    chipColorB: { label: 'Color (mid)', isColor: true },
    chipColorC: { label: 'Color (edge)', isColor: true },
  };
  function fieldsFor(def) {
    if (def.type === 'seat') return ['x', 'y', 'width', 'height'];
    if (def.type === 'cards') return ['offsetX', 'offsetY', 'width', 'height'];
    if (def.dragKind === 'size') return ['width', 'height'];
    if (def.dragKind === 'posPercent' || def.dragKind === 'bgPosPercent') return ['left', 'top'];
    // The chip-count number: X/Y move it, "Size" is its font size (a
    // literal width/height on a bare number wouldn't mean anything).
    if (def.dragKind === 'fontSize') return ['offsetX', 'offsetY', 'fontSize'];
    // Real, confirmed feature per explicit request ("rotate... move
    // positions inside the cards"): same as fontSize above, plus a
    // rotate field -- used for the card rank text and suit symbol, the
    // one case so far where "how this text sits" needs an actual angle,
    // not just a position and a size.
    if (def.dragKind === 'fontSizeRotate') return ['offsetX', 'offsetY', 'fontSize', 'rotate'];
    // Real, confirmed feature per the same request: card face styling
    // (background, border, depth) has no position/size at all -- it's a
    // single shared look applied to every card everywhere, not something
    // you'd drag around.
    if (def.dragKind === 'cardStyle') return ['bgColor', 'borderColor', 'borderWidth', 'shadowDepth'];
    // Suit text color -- separate from rankColor/suitColor fonts above
    // (those are offsetX/fontSize/rotate) because this is purely a color
    // swatch with nothing to drag.
    if (def.dragKind === 'suitTextColor') return ['suitColor'];
    // One chip "tier" (a value range -- see CHIP_COLOR_STOPS in
    // holdem.html): the 3 stops of its radial gradient, center to edge.
    if (def.dragKind === 'chipTierColor') return ['chipColorA', 'chipColorB', 'chipColorC'];
    return ['left', 'top', 'width', 'height'];
  }
  // Fallback for the rare moment the iframe's document isn't reachable
  // (e.g. it's mid-reload) when a field gets edited -- reads whatever is
  // ALREADY saved for this element instead of an empty object. Real bug
  // this fixes: editing just one field (say X) used to always start from
  // `{}` in that situation, so every OTHER field (Y, width, height...)
  // silently went missing from the saved config the moment you changed
  // anything -- "my values weren't proper" after a single edit quietly
  // dropped everything else already set for that element.
  function savedValueFor(def) {
    const bucket = config[currentBp] || {};
    if (def.type === 'seat') {
      return Object.assign({ x: 50, y: 50, width: 46, height: 46 }, (bucket.seats && bucket.seats[def.slot]) || {}, bucket['avatar' + def.slot] || {});
    }
    return Object.assign({}, bucket[def.key] || {});
  }

  // Which parts of an element have something SAVED that can be reset.
  const POS_FIELDS = ['left', 'top', 'offsetX', 'offsetY'];
  const SIZE_FIELDS = ['width', 'height', 'fontSize'];
  function resetGroupsFor(def) {
    const b = config[currentBp] || {};
    if (def.type === 'seat') {
      return { pos: !!(b.seats && b.seats[def.slot]), size: !!b['avatar' + def.slot] };
    }
    if (def.type === 'chipTier') return { pos: false, size: false };
    const sv = b[def.key];
    if (!sv) return { pos: false, size: false };
    return { pos: POS_FIELDS.some((f) => sv[f] !== undefined), size: SIZE_FIELDS.some((f) => sv[f] !== undefined) };
  }
  function resetGroup(def, which) {
    pushUndoSnapshot();
    const b = ensureBpBucket(currentBp);
    let d0, w0;
    try { d0 = frame.contentDocument; w0 = frame.contentWindow; } catch (e) { d0 = null; w0 = null; }
    if (def.type === 'seat') {
      if (which === 'pos') {
        // Send the seat back to the game's own spot using the SAME rule as a
        // drag (parts stay put unless "move together" is on), so its dealt
        // cards / chip count end up exactly where they visibly were, then
        // drop the now-redundant saved numbers.
        let base = null;
        try { const fn = w0 && w0.__layoutHoldemOriginalSeatPositions; if (fn) base = fn()[def.slot]; } catch (e) {}
        if (d0 && base && b.seats && b.seats[def.slot]) {
          const startVal = effectiveValue(d0, w0, def);
          const partStart = capturePartStart(d0, w0, def);
          setSeatPosition(d0, w0, def, startVal, partStart, base.x, base.y);
          ['cards', 'chipLabel'].forEach((k) => {
            const e = b[k + def.slot];
            if (!e) return;
            ['offsetX', 'offsetY'].forEach((f) => { if (e[f] !== undefined && Math.abs(e[f]) < 0.06) delete e[f]; });
            if (!Object.keys(e).length) delete b[k + def.slot];
          });
        }
        if (b.seats) delete b.seats[def.slot];
        // The chip pile was pinned when the seat first moved; if it now sits
        // exactly where the game would put it anyway, drop the pin too.
        const pin = b['chipPile' + def.slot];
        if (pin && pin.left !== undefined && Object.keys(pin).every((k) => k === 'left' || k === 'top') && d0 && w0) {
          const saved = Object.assign({}, pin);
          delete b['chipPile' + def.slot];
          try { w0.LayoutHoldem.applySeatStyles(d0, w0, config); w0.LayoutHoldem.forceRerender(); } catch (e) {}
          const cd = layerByKey('chipPile' + def.slot);
          const now = cd ? effectiveValue(d0, w0, cd) : null;
          if (!now || Math.abs(now.left - saved.left) > 0.3 || Math.abs(now.top - saved.top) > 0.3) b['chipPile' + def.slot] = saved;
        }
      } else delete b['avatar' + def.slot];
    } else if (b[def.key]) {
      const fields = which === 'pos' ? POS_FIELDS : SIZE_FIELDS;
      fields.forEach((f) => { delete b[def.key][f]; });
      if (!Object.keys(b[def.key]).length) delete b[def.key];
    }
    let d, w;
    try { d = frame.contentDocument; w = frame.contentWindow; } catch (e) { d = null; w = null; }
    if (d) {
      try { LH.applyCSSConfig(d, config); } catch (e) {}
      try { if (w && w.LayoutHoldem) w.LayoutHoldem.applySeatStyles(d, w, config); } catch (e) {}
      try { if (w && w.LayoutHoldem) w.LayoutHoldem.forceRerender(); } catch (e) {}
    }
    repositionOverlays();
    renderLayers();
    renderInspector();
  }

  let suppressUndoSnapshot = false;
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
      // Real, confirmed feature per explicit request ("color changes"):
      // a color field renders as a real color swatch picker instead of a
      // number box, and skips the little unit suffix (ed-unit) entirely
      // since a hex color has no unit to show.
      if (meta.isColor) {
        html += '<div class="ed-field-row"><label>' + meta.label + '</label><input type="color" data-field="' + field + '" data-color="1" value="' + (val[field] || '#ffffff') + '"></div>';
      } else {
        html += '<div class="ed-field-row"><label>' + meta.label + '</label><input type="number" step="any" data-field="' + field + '" value="' + (val[field] !== undefined ? val[field] : '') + '"><span class="ed-stepper"><button type="button" tabindex="-1" data-step="1" aria-label="Increase by 1">&#9650;</button><button type="button" tabindex="-1" data-step="-1" aria-label="Decrease by 1">&#9660;</button></span><span class="ed-unit">' + meta.unit + '</span></div>';
      }
    });
    if (def.type === 'seat') {
      html += '<div class="ed-field-row ed-check-row"><label>Move seat parts together</label><input type="checkbox" data-together="1"' + (moveTogether ? ' checked' : '') + ' title="Off: dealt cards, chip count and chips stay put when you move the avatar. On: they travel with it."></div>';
    }
    {
      const rg = resetGroupsFor(def);
      if (rg.pos) html += '<div class="ed-field-row ed-reset-row"><button type="button" class="ed-btn ed-mini" data-reset="pos" title="Forget the saved position and go back to the game\'s own">↺ Position</button></div>';
      if (rg.size) html += '<div class="ed-field-row ed-reset-row"><button type="button" class="ed-btn ed-mini" data-reset="size" title="Forget the saved size and go back to the game\'s own">↺ Size</button></div>';
    }
    if (def.type === 'seat') {
      const ov = (config[currentBp] && config[currentBp]['avatarOverlap' + def.slot]) || {};
      html += '<div class="ed-field-row ed-check-row"><label>Overlap top avatar</label><input type="checkbox" data-overlap="top"' + (ov.top ? ' checked' : '') + '></div>';
      html += '<div class="ed-field-row ed-check-row"><label>Overlap bottom avatar</label><input type="checkbox" data-overlap="bottom"' + (ov.bottom ? ' checked' : '') + '></div>';
    }
    inspectorEl.innerHTML = html;
    inspectorEl.querySelectorAll('input[data-together]').forEach((cb) => {
      cb.addEventListener('change', () => {
        moveTogether = cb.checked;
        try { localStorage.setItem('ledHoldemMoveTogether', moveTogether ? '1' : '0'); } catch (e) {}
      });
    });
    inspectorEl.querySelectorAll('button[data-reset]').forEach((btn) => {
      btn.addEventListener('click', () => resetGroup(def, btn.dataset.reset));
    });
    inspectorEl.querySelectorAll('input[data-overlap]').forEach((cb) => {
      cb.addEventListener('change', () => {
        pushUndoSnapshot();
        const b = ensureBpBucket(currentBp);
        const cur = Object.assign({ top: false, bottom: false }, b['avatarOverlap' + def.slot] || {});
        cur[cb.dataset.overlap] = cb.checked;
        if (!cur.top && !cur.bottom) delete b['avatarOverlap' + def.slot]; else b['avatarOverlap' + def.slot] = cur;
        try { const w = frame.contentWindow; if (w && w.LayoutHoldem) w.LayoutHoldem.forceRerender(); } catch (e) {}
        repositionOverlays();
        renderLayers();
      });
    });
    inspectorEl.querySelectorAll('input[data-field]').forEach((input) => {
      input.addEventListener('change', () => {
        if (!suppressUndoSnapshot) pushUndoSnapshot();
        let d, w;
        try { d = frame.contentDocument; w = frame.contentWindow; } catch (e) { d = null; w = null; }
        const field = input.dataset.field;
        const value = input.dataset.color ? input.value : (Number(input.value) || 0);
        if (d && def.type === 'css') pinActionGroup(d, w, def);
        const cur = Object.assign({}, d ? effectiveValue(d, w, def) : savedValueFor(def));
        if (def.type === 'seat') {
          if (field === 'x' || field === 'y') {
            const startVal = Object.assign({}, cur);
            const partStart = d ? capturePartStart(d, w, def) : null;
            if (d && !moveTogether) pinChipPile(d, w, def.slot);
            cur[field] = value;
            setSeatPosition(d, w, def, startVal, partStart, cur.x, cur.y);
          } else {
            cur[field] = value;
            ensureBpBucket(currentBp)['avatar' + def.slot] = { width: cur.width, height: cur.height };
          }
          try { if (w && w.LayoutHoldem) w.LayoutHoldem.forceRerender(); } catch (e) {}
        } else if (def.type === 'chipTier') {
          patchSaved(def.key, { [field]: value });
          if (w) { try { if (w.LayoutHoldem) w.LayoutHoldem.applyChipTierColors(w, config); } catch (e) {} }
        } else {
          patchSaved(def.key, { [field]: value });
          if (d) {
            if (def.type === 'css') { try { LH.applyCSSConfig(d, config); } catch (e) {} }
            else { try { if (w && w.LayoutHoldem) w.LayoutHoldem.applySeatStyles(d, w, config); } catch (e) {} }
          }
        }
        repositionOverlays();
        renderLayers();
      });
    });
    // Up/down steppers (1 by 1) -- phones have no native spinner arrows on a
    // number box, so these give touch the same +/-1 control a mouse gets.
    // Tap = one step; hold = repeats (one undo step for the whole hold).
    inspectorEl.querySelectorAll('.ed-stepper').forEach((box) => {
      const input = box.parentElement.querySelector('input[type=number]');
      if (!input) return;
      const nudge = (dir) => {
        const cur = parseFloat(input.value);
        const next = Math.round(((isNaN(cur) ? 0 : cur) + dir) * 1000) / 1000;
        input.value = next;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      };
      box.querySelectorAll('button').forEach((btn) => {
        const dir = Number(btn.dataset.step);
        let holdTimer = null, repeatTimer = null;
        const stop = () => {
          clearTimeout(holdTimer); clearInterval(repeatTimer);
          holdTimer = repeatTimer = null; suppressUndoSnapshot = false;
        };
        btn.addEventListener('pointerdown', (ev) => {
          ev.preventDefault();            // keep the phone keyboard from popping up
          try { btn.setPointerCapture(ev.pointerId); } catch (e) {}
          nudge(dir);                     // first step records the undo snapshot
          suppressUndoSnapshot = true;    // ...held repeats don't spam undo
          holdTimer = setTimeout(() => { repeatTimer = setInterval(() => nudge(dir), 70); }, 400);
        });
        ['pointerup', 'pointercancel', 'lostpointercapture', 'pointerleave'].forEach((e) => btn.addEventListener(e, stop));
        btn.addEventListener('contextmenu', (ev) => ev.preventDefault());
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

  // ---------------------------------------------------------------------
  // Background Photos panel -- upload a replacement photo, or restore the
  // built-in default. Separate from the drag-based layers above (see
  // applyBackgroundConfig's comment in layout-engine-holdem.js): this
  // swaps the actual image file; the "Table Background Photo" layer's
  // X/Y drag still controls where that photo (custom or default) is
  // cropped/centered, and keeps working exactly the same either way.
  // ---------------------------------------------------------------------
  const BG_PANEL_ITEMS = [
    { key: 'holdem-landscape', field: 'landscape', label: 'Landscape / Desktop' },
    { key: 'holdem-portrait', field: 'portrait', label: 'Mobile Portrait' },
  ];
  function renderBgPanel() {
    bgPanelEl.innerHTML = BG_PANEL_ITEMS.map((item) => {
      const custom = !!bgConfig[item.field];
      return `
        <div class="ed-bg-row" data-key="${item.key}" style="margin-bottom:10px;padding-bottom:10px;border-bottom:1px solid rgba(255,255,255,0.08)">
          <div style="font-weight:700;font-size:0.8rem;margin-bottom:4px">${item.label}</div>
          <div style="font-size:0.72rem;opacity:0.75;margin-bottom:6px">${custom ? '📷 Custom photo uploaded' : '🖼️ Using the default photo'}</div>
          <input type="file" accept="image/jpeg,image/png,image/webp" class="ed-bg-file" style="font-size:0.72rem;max-width:100%">
          <div style="display:flex;gap:6px;margin-top:6px">
            <button class="ed-btn ed-bg-upload" type="button" style="font-size:0.72rem;padding:5px 8px">⬆️ Upload</button>
            ${custom ? '<button class="ed-btn danger ed-bg-restore" type="button" style="font-size:0.72rem;padding:5px 8px">↺ Restore Default</button>' : ''}
          </div>
          <div class="ed-bg-status" style="font-size:0.7rem;margin-top:4px"></div>
        </div>
      `;
    }).join('');

    bgPanelEl.querySelectorAll('.ed-bg-row').forEach((row) => {
      const key = row.dataset.key;
      const item = BG_PANEL_ITEMS.find((i) => i.key === key);
      const statusEl2 = row.querySelector('.ed-bg-status');
      const fileInput = row.querySelector('.ed-bg-file');
      row.querySelector('.ed-bg-upload').addEventListener('click', () => {
        const file = fileInput.files && fileInput.files[0];
        if (!file) { statusEl2.textContent = 'Choose a photo first.'; return; }
        const pw = prompt('Admin password to publish this background for every player:');
        if (pw === null) return;
        statusEl2.textContent = 'Uploading…';
        const fd = new FormData();
        fd.append('image', file);
        fetch('/api/admin/upload-background/' + key, {
          method: 'POST',
          headers: { 'x-admin-password': pw },
          body: fd,
        })
          .then((r) => r.json())
          .then((data) => {
            if (data && data.ok) {
              statusEl2.textContent = 'Uploaded — live for every player now.';
              return fetch('/api/background-config/holdem').then((r) => r.json()).then((d) => { if (d && d.ok) bgConfig = d; });
            } else {
              const errMsgs = { bad_password: 'wrong password', unsupported_type: 'unsupported file type (use JPG/PNG/WebP)', file_too_large: 'file too large (8MB max)', no_file: 'file was not saved (too large, over 8MB, or an unsupported type)' };
              statusEl2.textContent = 'Upload failed: ' + (errMsgs[data && data.error] || (data && data.error) || 'unknown error');
            }
          })
          .then(() => {
            renderBgPanel();
            try { if (frame.contentWindow && frame.contentWindow.LayoutHoldem) frame.contentWindow.LayoutHoldem.applyBackgroundConfig(frame.contentDocument, bgConfig); } catch (e) {}
          })
          .catch(() => { statusEl2.textContent = 'Upload failed: network error.'; });
      });
      const restoreBtn = row.querySelector('.ed-bg-restore');
      if (restoreBtn) {
        restoreBtn.addEventListener('click', () => {
          if (!confirm('Remove the custom ' + item.label + ' photo and go back to the default?')) return;
          const pw = prompt('Admin password to publish this change for every player:');
          if (pw === null) return;
          statusEl2.textContent = 'Restoring…';
          fetch('/api/admin/upload-background/' + key, { method: 'DELETE', headers: { 'x-admin-password': pw } })
            .then((r) => r.json())
            .then((data) => {
              if (data && data.ok) { delete bgConfig[item.field]; statusEl2.textContent = 'Restored default.'; }
              else statusEl2.textContent = 'Failed: ' + (data && data.error === 'bad_password' ? 'wrong password' : (data && data.error) || 'unknown error');
            })
            .then(() => {
              renderBgPanel();
              try { if (frame.contentWindow && frame.contentWindow.LayoutHoldem) frame.contentWindow.LayoutHoldem.applyBackgroundConfig(frame.contentDocument, bgConfig); } catch (e) {}
            })
            .catch(() => { statusEl2.textContent = 'Failed: network error.'; });
        });
      }
    });
  }

  updateUndoRedoButtons();
})();
