// ============================================================================
// mybots.js -- "My trained bots on any seat" (28 four-player + six-player).
//   * Lobby: a checkbox under "Teach my partner" -> every bot at the table plays with my style.
//   * In game: a small 🧠 button -> pick any bot seat to play with my style (or turn it off again).
// Opponent bots use my style but never teach it: my profile only learns while one of them is my teammate.
// Nobody ever sees my cards. Hooks in by bare global names: gameSocket/latestServerState (4p), socket/latestState (6p).
// ============================================================================
(function () {
  'use strict';
  var six = (typeof sixpGetTeam === 'function');
  var EV = six ? { scope: 'sixp_setTeachScope', status: 'sixp_botStyleStatus', set: 'sixp_setBotStyle' }
               : { scope: 'setTeachScope', status: 'botStyleStatus', set: 'setBotStyle' };
  function sock() { try { return six ? socket : gameSocket; } catch (e) { return null; } }
  function state() { try { return six ? latestState : latestServerState; } catch (e) { return null; } }
  function myPos() { try { return MY_POS; } catch (e) { return -1; } }
  function gid() {
    try {
      var g = localStorage.getItem('k28_teach_id');
      if (!g) { g = 'g' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36); localStorage.setItem('k28_teach_id', g); }
      return g;
    } catch (e) { return 'tmp' + Math.random().toString(36).slice(2, 12); }
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function inGame() { var s = state(); return !!(s && s.phase && s.phase !== 'lobby' && myPos() >= 0 && myPos() < (six ? 6 : 4)); }
  function teammate(a, b) { return six ? (a % 2 === b % 2) : ([3, 2, 1, 0][a] === b); }

  // ---------------- lobby checkbox ----------------
  var scopeEl = null, scopeSent = '';
  function ensureScopeRow() {
    if (scopeEl) return scopeEl;
    var info = document.getElementById('teachStatus');
    if (!info || !info.parentNode) return null;
    scopeEl = document.createElement('label');
    scopeEl.id = 'teachScopeRow';
    scopeEl.style.cssText = 'display:none;align-items:flex-start;gap:8px;margin-top:8px;font-size:.76rem;line-height:1.4;cursor:pointer';
    scopeEl.innerHTML = '<input type="checkbox" id="teachAllToggle" style="width:17px;height:17px;margin-top:1px;flex-shrink:0">' +
      '<span><b>Use my style on every bot at the table</b><br><span style="opacity:.8">Opponent bots play like you too, but only learn while they are on your team. You can also change any bot seat during the game with the 🧠 button.</span></span>';
    info.parentNode.insertBefore(scopeEl, info.nextSibling);
    var cb = scopeEl.querySelector('input');
    try { cb.checked = localStorage.getItem('k28_teach_all') === '1'; } catch (e) {}
    cb.addEventListener('change', function () {
      try { localStorage.setItem('k28_teach_all', cb.checked ? '1' : '0'); } catch (e) {}
      scopeSent = ''; syncScope();
    });
    return scopeEl;
  }
  function syncScope() {
    var tog = document.getElementById('teachToggle'), row = ensureScopeRow();
    if (!tog || !row) return;
    var show = !!tog.checked;
    row.style.display = show ? 'flex' : 'none';
    if (!show) { scopeSent = ''; return; }
    var s = sock(); if (!s) return;
    var all = row.querySelector('input').checked;
    var sig = (all ? 1 : 0) + '|' + myPos();
    if (sig === scopeSent) return;
    scopeSent = sig;
    s.emit(EV.scope, { all: all, guestId: gid() }, function (r) { if (!r || !r.ok) scopeSent = ''; });
  }

  // ---------------- in-game button + panel ----------------
  var btn = null, mine = [], lastFetch = 0;
  function ensureBtn() {
    if (btn) return btn;
    btn = document.createElement('button');
    btn.type = 'button'; btn.id = 'k28MyBotsBtn'; btn.textContent = '🧠 My bots';
    btn.style.cssText = 'position:fixed;left:8px;bottom:calc(8px + env(safe-area-inset-bottom,0px));z-index:900;display:none;padding:6px 10px;border-radius:999px;border:1.5px solid rgba(196,181,253,.7);background:rgba(30,12,60,.88);color:#e9ddff;font:800 .72rem system-ui,sans-serif;cursor:pointer';
    btn.addEventListener('click', openPanel);
    // 6-player table: sit in the turn row (left of the turn label, level with the Help button); elsewhere stay a floating pill
    var row = document.getElementById('turnRow6p');
    if (row) { btn.dataset.inrow = '1'; row.insertBefore(btn, row.firstChild); } else document.body.appendChild(btn);
    return btn;
  }
  function openPanel() {
    var s = sock(); if (!s || document.getElementById('k28MyBotsOv')) return;
    s.emit(EV.status, { guestId: gid() }, function (r) {
      mine = (r && r.ok && r.mine) || [];
      render();
    });
  }
  function render() {
    var old = document.getElementById('k28MyBotsOv'); if (old) old.remove();
    var st = state(), seats = (st && st.seats) || [], me = myPos();
    var ov = document.createElement('div');
    ov.id = 'k28MyBotsOv';
    ov.style.cssText = 'position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(5,2,14,.82);font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif';
    var rows = '', any = false;
    seats.forEach(function (sd, i) {
      if (!sd || !sd.isBot) return;
      any = true;
      var on = mine.indexOf(i) >= 0;
      var role = teammate(me, i) ? 'your partner' : 'opponent';
      rows += '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:9px 10px;border:1px solid rgba(255,255,255,.14);border-radius:10px;margin-bottom:7px">' +
        '<div style="font-size:.82rem"><b>' + esc(sd.name) + '</b><br><span style="opacity:.7;font-size:.7rem">' + role + (on ? (teammate(me, i) ? ' · learning from you' : ' · uses your style, not learning') : '') + '</span></div>' +
        '<button type="button" data-pos="' + i + '" data-on="' + (on ? 0 : 1) + '" style="padding:6px 10px;border-radius:8px;border:none;font-weight:800;font-size:.7rem;cursor:pointer;background:' + (on ? 'rgba(248,113,113,.2)' : 'rgba(167,139,250,.3)') + ';color:' + (on ? '#f87171' : '#e9ddff') + '">' + (on ? 'Turn off' : 'Use my style') + '</button></div>';
    });
    if (!any) rows = '<div style="font-size:.8rem;opacity:.8;padding:6px 2px">There are no bots at this table.</div>';
    ov.innerHTML = '<div style="max-width:380px;width:100%;max-height:90vh;overflow:auto;background:linear-gradient(160deg,#2a1257,#12062b);border:2px solid #d4a62a;border-radius:16px;padding:18px;color:#efe7fb">' +
      '<div style="font-size:1.05rem;font-weight:800;color:#f7e09a;margin-bottom:6px">🧠 My bots</div>' +
      '<div style="font-size:.75rem;opacity:.85;line-height:1.4;margin-bottom:12px">Pick any bot to play with your style. Bots on the other team use your style but do not learn — your profile only learns while a bot is on your team. Nobody ever sees your cards.</div>' +
      rows +
      '<div id="k28MyBotsMsg" style="font-size:.72rem;color:#fca5a5;min-height:1em"></div>' +
      '<button type="button" id="k28MyBotsClose" style="width:100%;margin-top:8px;padding:10px;border-radius:10px;border:1.5px solid rgba(255,255,255,.2);background:transparent;color:#cbbbe8;font-weight:700;cursor:pointer">Close</button></div>';
    document.body.appendChild(ov);
    ov.addEventListener('click', function (e) { if (e.target === ov || e.target.id === 'k28MyBotsClose') ov.remove(); });
    Array.prototype.forEach.call(ov.querySelectorAll('button[data-pos]'), function (b) {
      b.addEventListener('click', function () {
        var s = sock(); if (!s) return;
        s.emit(EV.set, { botPos: +b.getAttribute('data-pos'), on: b.getAttribute('data-on') === '1', guestId: gid() }, function (r) {
          if (r && r.ok) { mine = r.mine || []; render(); return; }
          var m = document.getElementById('k28MyBotsMsg');
          if (m) m.textContent = (r && r.error === 'someone_else_teaching') ? 'Someone else at this table is already teaching their bots.' : 'Could not change that seat.';
        });
      });
    });
  }
  function tick() {
    try { syncScope(); } catch (e) {}
    try { var b0 = ensureBtn(); b0.style.display = inGame() ? (b0.dataset.inrow ? 'inline-flex' : 'block') : 'none'; } catch (e) {}
  }
  setInterval(tick, 700);
  window.K28MyBots = { open: openPanel };
})();
