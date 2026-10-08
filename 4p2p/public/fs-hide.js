/* Hide the browser address bar on the table pages: fullscreen can't carry over from another page, and browsers only
   allow it from a real tap, so the first tap on the page goes fullscreen once (installed-app mode is already chrome-free). */
(function () {
  try {
    if (window.navigator.standalone === true || matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches) return;
    var go = function (e) {
      if (e && e.isTrusted === false) return;
      document.removeEventListener('pointerup', go, true);
      if (document.fullscreenElement) return;
      var el = document.documentElement, fn = el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen || el.msRequestFullscreen;
      try { if (fn) { var r = fn.call(el); if (r && r.catch) r.catch(function () {}); } } catch (x) {}
    };
    document.addEventListener('pointerup', go, true);
  } catch (e) {}
})();
