// ============================================================================
// editor-nav.js  --  one shared "Exit" and "Switch editor" bar for every layout editor
// (4-player, 6-player, 56 and Hold'em, classic and Pro).
//
//   * Exit goes back to the admin panel's Edit › Tables page (the page you came from),
//     where you can pick another table. The admin keeps you logged in for this tab.
//   * Switch editor jumps straight to another table's editor.
//   * Both ask first if you have changes that are not saved yet, so nothing is lost by accident.
//   * An editor's own preview table needs no proper exit: the server closes it by itself the
//     moment the editor page goes away, and it is never shown to players.
//
// How "unsaved" is known: each editor exposes window.__editorGetConfig(); this file remembers what
// the server last gave (on load) or accepted (on save) and compares.
// ============================================================================
(function () {
  'use strict';
  var EDITORS = [
    ['🎴 4-Player · Pro editor', '/layout-editor-pro.html?table=4p'],
    ['🎲 6-Player · Pro editor', '/layout-editor-pro.html?table=6p'],
    ['🂡 56 · Pro editor', '/layout-editor-pro.html?table=56'],
    ['🎰 Hold\'em editor', '/layout-editor-holdem.html'],
    ['🎴 4-Player · classic editor', '/layout-editor.html'],
    ['🎲 6-Player · classic editor', '/layout-editor-6p.html'],
    ['🂡 56 · classic editor', '/layout-editor-56.html'],
  ];
  var baseline = null, leaving = false, here = location.pathname + location.search;

  function snap() { try { return JSON.stringify(window.__editorGetConfig ? window.__editorGetConfig() : null); } catch (e) { return null; } }
  function dirty() { var now = snap(); return baseline !== null && now !== null && now !== baseline; }
  // An editor may set window.__editorBaselineOverride (the layout as the server has it) when it restores unsaved work from a draft, so that
  // restored-but-unsaved work still counts as unsaved. A successful save clears it.
  function markClean() { baseline = (window.__editorBaselineOverride != null) ? window.__editorBaselineOverride : snap(); }

  // Learn when the editor has loaded / saved its layout by watching its own requests.
  var realFetch = window.fetch;
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    var isCfg = /\/api\/(admin\/)?layout-config\//.test(url);
    var isPost = isCfg && init && String(init.method || '').toUpperCase() === 'POST';
    var p = realFetch.apply(this, arguments);
    if (isCfg) p.then(function (r) { try { if (r && r.ok) { if (isPost) window.__editorBaselineOverride = null; setTimeout(markClean, isPost ? 50 : 700); } } catch (e) {} }, function () {});
    return p;
  };

  function confirmLeave() {
    if (!dirty()) return true;
    // The Pro editor also keeps every change as a draft on this device and offers it back next time, so it can say so truthfully;
    // the older editors have no draft, so there the warning is plain.
    if (window.__editorKeepsDraft) return confirm('You have changes that are not saved yet.\n\nLeave anyway? They are kept as a draft on this device, and you will be asked next time whether to bring them back.');
    return confirm('You have changes that are not saved yet.\n\nLeave anyway and lose them?');
  }
  function go(url) { leaving = true; location.href = url; }
  function exit() { if (confirmLeave()) go('/admin.html#/edit/tables'); }
  function switchTo(url) {
    if (url === here) return;
    if (confirmLeave()) go(url);
  }
  window.addEventListener('beforeunload', function (ev) { if (!leaving && dirty()) { ev.preventDefault(); ev.returnValue = ''; return ''; } });
  window.__editorNav = { confirmLeave: confirmLeave, exit: exit, switchTo: switchTo, isDirty: dirty, markClean: markClean };

  function build() {
    var bar = document.getElementById('edTopbar'); if (!bar || document.getElementById('edBtnExit')) return;
    var st = document.createElement('style');
    st.textContent = '#edBtnExit{flex:none}#edEditorSwitch{background:#243040;color:#e8edf2;border:1px solid #2c3947;border-radius:6px;padding:6px 8px;font-size:0.76rem;max-width:150px;flex:none}';
    document.head.appendChild(st);
    var b = document.createElement('button'); b.id = 'edBtnExit'; b.className = 'ed-btn'; b.type = 'button';
    b.textContent = '⬅ Exit'; b.title = 'Back to the admin panel (Layout Editors)';
    b.addEventListener('click', exit);
    var sel = document.createElement('select'); sel.id = 'edEditorSwitch'; sel.title = 'Switch to another table\'s editor';
    sel.innerHTML = '<option value="">⇄ Switch editor…</option>' + EDITORS.map(function (e) { return '<option value="' + e[1] + '"' + (e[1] === here ? ' disabled' : '') + '>' + e[0] + '</option>'; }).join('');
    sel.addEventListener('change', function () { var v = sel.value; sel.value = ''; if (v) switchTo(v); });
    bar.insertBefore(sel, bar.firstChild); bar.insertBefore(b, bar.firstChild);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build); else build();
})();
