// Loaded only on the real, live play6.html, after layout-engine-6p.js and
// after six.js (so window.enforceSeatAvatarSizing6p already exists). Fetches
// the saved layout (if any) and applies it. Fully silent on any failure --
// an unreachable endpoint or missing config just means the table looks
// exactly like it always has.
//
// Skipped entirely when this play6.html is being iframed by the Visual
// Layout Editor (layout-editor-6p.html): the editor always applies the
// config to its own iframe itself (see layout-editor-6p.js), and since
// enforceSeatAvatarSizing6p() can only be patched ONCE
// (window.__layout6pAvatarPatched guards against re-patching), whichever
// patch call landed first would otherwise permanently "win" the race --
// this script's own fetch is a one-time snapshot, fine for a real player
// who never changes it, but if IT won the race inside the editor's iframe,
// the editor's own live-updating config (which needs to keep reading
// in-progress edits, not a frozen snapshot) would silently never reach the
// DOM again, even though every edit still looked like it saved correctly in
// the editor's own UI. Same guard Hold'em and the 4-player table both use.
(function () {
  if (window !== window.top) return;
  fetch('/api/layout-config/6p')
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (data) {
      if (!data || !data.ok || !data.config || !window.LayoutSix) return;
      window.LayoutSix.applyAll(document, window, data.config);
    })
    .catch(function () {});
})();
