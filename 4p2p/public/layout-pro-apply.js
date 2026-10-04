// Loaded at the end of the real game pages (4-player, 6-player, 56). Fetches the saved layout and applies the
// "Pro" overrides (see layout-pro.js). Silent on any failure: no config or no network just means the table looks
// exactly as it always did.
// Skipped when the page is being iframed by an editor (the editor applies its own live copy), except the Pro
// editor's preview, which passes ?proEditor=1 and applies the SAVED layout like a real player would see it
// before its own live edits take over.
(function () {
  var s = document.currentScript;
  var table = s && s.getAttribute('data-table');
  if (!table || !window.LayoutPro) return;
  if (window !== window.top) return;
  fetch('/api/layout-config/' + encodeURIComponent(table))
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (data) {
      if (!data || !data.ok || !data.config || !data.config.__pro) return;
      window.LayoutPro.apply(document, window, data.config);
    })
    .catch(function () {});
})();
