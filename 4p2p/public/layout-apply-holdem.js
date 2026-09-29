// Loaded only on the real, live holdem.html, after layout-engine-holdem.js
// and after the game's own scripts (so window.seatPositions already
// exists). Fetches the saved layout (if any) and applies it. Fully silent
// on any failure -- an unreachable endpoint or missing config just means
// the table looks exactly like it always has.
(function () {
  fetch('/api/layout-config/holdem')
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (data) {
      if (!data || !data.ok || !data.config || !window.LayoutHoldem) return;
      window.LayoutHoldem.applyAll(document, window, data.config);
    })
    .catch(function () {});
})();
