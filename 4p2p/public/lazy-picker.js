// lazy-picker.js -- avatar pickers only download the pictures you can actually see.
//
// Why not just loading="lazy"? Chrome pre-loads everything within ~1250 px of a scrolling box, and an avatar picker (a 260 px
// tall scroller) is shorter than that, so the browser fetched every avatar anyway. This loader watches the picker's own scroll
// box instead: a picture is requested only when it is inside the box (plus one row of margin), and the rest follow as you scroll.
// Adding more avatars therefore costs almost nothing for someone who never scrolls that far.
(function () {
  var BLANK = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
  function scroller(el) {
    for (var n = el; n && n !== document.body; n = n.parentElement) {
      var oy = getComputedStyle(n).overflowY;
      if (oy === 'auto' || oy === 'scroll') return n;
    }
    return null;                                          // not in a scroll box: the viewport decides
  }
  function load(img) { var s = img.getAttribute('data-src'); if (s) { img.src = s; img.removeAttribute('data-src'); } }
  window.LAZY_BLANK = BLANK;
  window.lazyPickerImages = function (root) {
    if (!root) return;
    var imgs = root.querySelectorAll('img[data-src]');
    if (!imgs.length) return;
    if (!('IntersectionObserver' in window)) { imgs.forEach(load); return; }     // very old browser: load them all, as before
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { if (e.isIntersecting) { load(e.target); io.unobserve(e.target); } });
    }, { root: scroller(root), rootMargin: '90px 0px' });
    imgs.forEach(function (i) { io.observe(i); });
  };
})();
