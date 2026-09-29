// ============================================================================
// layout-apply.js
//
// The ONLY piece of the Visual Layout Editor loaded on the real, live game
// page. It does exactly one thing: fetch whatever layout was last saved from
// the editor, and hand it to Layout4P.applyConfig() (layout-engine-4p.js) so
// it renders as a small CSS override. If nothing has ever been saved, this
// is a silent no-op and the page looks exactly as it always has -- no game
// state, no game function, and no gameplay element's content is touched.
// ============================================================================
(function () {
  'use strict';
  if (!window.Layout4P) return; // layout-engine-4p.js not loaded -- nothing to do
  fetch('/api/layout-config/4p')
    .then((r) => r.json())
    .then((data) => {
      if (data && data.ok && data.config) window.Layout4P.applyConfig(document, data.config);
    })
    .catch(() => {}); // never let a failed fetch affect the real game page
})();
