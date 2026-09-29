// Loaded only on the real, live holdem.html, after layout-engine-holdem.js
// and after the game's own scripts (so window.seatPositions already
// exists). Fetches the saved layout (if any) and applies it. Fully silent
// on any failure -- an unreachable endpoint or missing config just means
// the table looks exactly like it always has.
//
// Skipped entirely when this holdem.html is being iframed by the Visual
// Layout Editor (layout-editor-holdem.html): the editor iframes the real,
// unmodified page, so this script still runs there too -- and since
// window.seatPositions()/renderGameTable() can only be patched ONCE
// (window.__layoutHoldemPatched guards against re-patching), whichever
// patch call landed first used to "win" the race, permanently. This
// script's own fetch is a one-time snapshot, fine for a real player who
// never changes it -- but if IT won the race inside the editor's iframe,
// the editor's own live-updating config (which needs to keep reading
// in-progress edits, not a frozen snapshot) would silently never reach
// the DOM again, even though every edit still looked like it saved
// correctly in the editor's own UI. The editor always applies the
// config to its own iframe itself, so there's nothing for this script to
// do there.
(function () {
  if (window !== window.top) return;
  fetch('/api/layout-config/holdem')
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (data) {
      if (!data || !data.ok || !data.config || !window.LayoutHoldem) return;
      window.LayoutHoldem.applyAll(document, window, data.config);
    })
    .catch(function () {});
})();
