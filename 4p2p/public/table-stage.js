/* K28Stage -- the 20 table pictures for the 6-player and 56 tables.
   All 20 pictures share one room/camera/stool layout, so ONE set of stool coordinates places every seat.
   The picture is drawn on the game screen scaled by width (anchored to the bottom), and each seat, played-card
   slot, avatar size and corner light is computed from that same scale -- so alignment holds on every screen shape.
   The chosen picture per game comes from /api/table-themes (set in the admin). */
(function () {
  'use strict';
  /* picture files are 1152 wide; IMG.add = dark wall added on top so it fits a tall phone, IMG.oh = original height */
  var IMG = { w: 1152, h: 2495, add: 447, oh: 2048 };
  /* top-surface centre of each stool, % of the ORIGINAL picture. slot0=me/bottom, 1=lower-right, 2=upper-right, 3=top, 4=upper-left, 5=lower-left */
  var STOOL = [[50, 75], [89, 60], [86, 39.8], [50, 31.5], [15, 38.5], [10.5, 58.5]];
  var CENTRE = [50, 45.5];
  /* where each seat's played card lands on the felt (% of the original picture): spread so six cards don't cover each other */
  var TRICK = [[50, 55.5], [66, 53], [66, 41.5], [50, 39.5], [34, 41.5], [34, 53]];
  var LAMPS = { tl: [13, 17.9], tr: [88, 17.9], bl: [3.5, 11], br: [96.5, 11] };  /* 2 lamps + the warm wall glow behind each */
  var SIZE = { 0: [132, 170, 3.6], 1: [100, 128, 2.8], 2: [92, 118, 2.6], 3: [80, 102, 2.2], 4: [92, 118, 2.6], 5: [100, 128, 2.8] };
  var LIFT = [0.10, 0.02, 0.28, 0.42, 0.28, 0.02];   /* seat sits this fraction of its avatar height above the stool top */
  var NAMES = ['Royal Blue Velvet', 'Tan Leather', 'Black & Emerald', 'Crimson Velvet', 'Slate Grey', 'Navy & Silver', 'Purple Velvet', 'Black & Gold',
    'Ivory', 'Ruby Red', 'Teal Velvet', 'White Marble', 'Violet', 'Sapphire', 'Red & Black Leather', 'Deep Teal', 'Forest Green', 'Emerald & Silver',
    'Ivory & Green', 'Cream & Burgundy'];
  var themes = { six: 1, k56: 17 };
  var subs = [];
  var ok = function (n) { return typeof n === 'number' && n >= 1 && n <= 20 && n === Math.floor(n); };
  var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
  var url = function (n) { return '/images/tables/t' + pad(n) + '.jpg'; };

  function load() {
    try {
      fetch('/api/table-themes', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) {
        if (!j || !j.ok) return;
        var ch = false;
        if (ok(j.six) && j.six !== themes.six) { themes.six = j.six; ch = true; }
        if (ok(j.k56) && j.k56 !== themes.k56) { themes.k56 = j.k56; ch = true; }
        if (ch) subs.forEach(function (f) { try { f(); } catch (e) {} });
      }).catch(function () {});
    } catch (e) {}
  }
  load();
  /* a table already open picks up a change made in the admin within a minute */
  setInterval(load, 60000);

  function imp(el, k, v) { el.style.setProperty(k, v, 'important'); }

  /* gs = the game screen element. o = { seats:[6], tricks:[6], avs:[6], glows:{tl,tr,bl,br}, column:bool }.
     column:true = the screen is a centred phone-shaped column on wide displays (56); false = use the element's own size. */
  function place(game, gs, o) {
    if (!gs) return;
    var W, H;
    if (o.column) {
      var vw = window.innerWidth, vh = window.innerHeight;
      var Ws = vw < 521 ? vw : Math.min(vw, vh * IMG.w / IMG.h);
      imp(gs, 'left', ((vw - Ws) / 2) + 'px'); imp(gs, 'right', 'auto'); imp(gs, 'width', Ws + 'px');
      W = Ws; H = vh;
    } else { W = gs.clientWidth; H = gs.clientHeight; }
    if (!W || !H) return;
    if (o.column) document.documentElement.style.setProperty('--tbl-bg', 'url(' + url(themes[game]) + ')');
    var S = Math.max(W / IMG.w, H / IMG.h), ox = (W - IMG.w * S) / 2, oy = H - IMG.h * S;
    imp(gs, 'background-image', 'linear-gradient(to bottom,rgba(0,0,0,.72) 0%,rgba(0,0,0,.35) 9%,rgba(0,0,0,0) 17%),url(' + url(themes[game]) + ')');
    imp(gs, 'background-size', '100% 100%,' + (IMG.w * S) + 'px ' + (IMG.h * S) + 'px');
    imp(gs, 'background-position', '0 0,' + ox + 'px ' + oy + 'px');
    imp(gs, 'background-repeat', 'no-repeat');
    imp(gs, 'background-color', '#120a08');
    var px = function (fx, fy) { return [ox + fx / 100 * IMG.w * S, oy + (IMG.add + fy / 100 * IMG.oh) * S]; };
    var m = Math.max(0.85, Math.min(1.4, W / 390));
    for (var i = 0; i < 6; i++) {
      var sz = SIZE[i], h = Math.round(sz[1] * m), sp = px(STOOL[i][0], STOOL[i][1]);
      var av = o.avs && o.avs[i];
      if (av) { imp(av, 'width', Math.round(sz[0] * m) + 'px'); imp(av, 'height', h + 'px'); imp(av, 'font-size', (sz[2] * m) + 'rem'); }
      var sw = o.seats[i];
      if (sw) { imp(sw, 'left', sp[0] + 'px'); imp(sw, 'top', (sp[1] - h * LIFT[i]) + 'px'); }
      var ts = o.tricks && o.tricks[i];
      if (ts) {
        var tp = px(TRICK[i][0], TRICK[i][1]);
        imp(ts, 'left', tp[0] + 'px'); imp(ts, 'top', tp[1] + 'px');
      }
    }
    if (o.glows) {
      Object.keys(LAMPS).forEach(function (k) {
        var g = o.glows[k]; if (!g) return;
        var gp = px(LAMPS[k][0], LAMPS[k][1]);
        imp(g, 'left', gp[0] + 'px'); imp(g, 'top', gp[1] + 'px');
        imp(g, 'width', Math.round(110 * m) + 'px'); imp(g, 'height', Math.round(110 * m) + 'px');
        imp(g, 'mix-blend-mode', 'screen'); imp(g, 'display', 'block');
      });
    }
  }
  window.K28Stage = {
    place: place, names: NAMES, url: url, pad: pad,
    theme: function (game) { return themes[game]; },
    onChange: function (f) { subs.push(f); },
    refresh: load
  };
})();
