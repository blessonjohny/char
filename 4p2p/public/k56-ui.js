/* K56UI -- the 56 table, drawn with the 6-player table's look inside a shadow root so the
   old 56 styles can't leak in. 56's rules/lobby/engine are untouched: this only DRAWS the
   state the server pushes and sends the same l56_* events the old UI did. */
(function () {
  'use strict';
  var SLOT_POS = [[50, 78], [82, 68], [82, 33], [50, 23], [18, 33], [18, 68]];
  var SEAT_POS = [['50%', '78%'], ['90%', '68%'], ['90%', '33%'], ['50%', '23%'], ['10%', '33%'], ['10%', '68%']];
  var TRICK = SLOT_POS.map(function (p) { return [p[0] + (50 - p[0]) * 0.42, p[1] + (50 - p[1]) * 0.6]; });
  var CALL_DIR = ['n', 'nw', 'sw', 's', 'se', 'ne'];
  var SYM = { S: '♠', H: '♥', D: '♦', C: '♣' };
  var SUITID = { S: 'spade', H: 'heart', D: 'diamond', C: 'club' };
  var RED = { S: false, H: true, D: true, C: false };
  var DESK = { 0: [321, 321, 8.25], 3: [180, 180, 4.7], 2: [225, 225, 5.8], 4: [195, 195, 5], 1: [225, 225, 5.8], 5: [250, 250, 6.4] };
  var SORT = ['S', 'H', 'C', 'D'], RANKS = ['J', '9', 'A', '10', 'K', 'Q'];
  var SPRITE = "<svg width=\"0\" height=\"0\" style=\"position:absolute\" aria-hidden=\"true\">\n  <filter id=\"cloudyEdge\" x=\"-20%\" y=\"-20%\" width=\"140%\" height=\"140%\">\n    <feTurbulence type=\"fractalNoise\" baseFrequency=\"0.018 0.05\" numOctaves=\"2\" seed=\"7\" result=\"cloudNoise\"/>\n    <feDisplacementMap in=\"SourceGraphic\" in2=\"cloudNoise\" scale=\"9\" xChannelSelector=\"R\" yChannelSelector=\"G\"/>\n  </filter>\n</svg>\n<svg width=\"0\" height=\"0\" style=\"position:absolute\" aria-hidden=\"true\">\n<defs>\n<symbol id=\"suit-spade\" viewBox=\"0 0 100 100\"><path fill=\"currentColor\" d=\"M50,8 C35,28 8,48 8,68 C8,85 22,95 37,90 C42,88.5 46,85 48.5,80.5 C47,90 42,98 30,100 L70,100 C58,98 53,90 51.5,80.5 C54,85 58,88.5 63,90 C78,95 92,85 92,68 C92,48 65,28 50,8 Z\"/></symbol>\n<symbol id=\"suit-club\" viewBox=\"0 0 100 100\"><circle cx=\"50\" cy=\"34\" r=\"24\" fill=\"currentColor\"/><circle cx=\"27\" cy=\"58\" r=\"24\" fill=\"currentColor\"/><circle cx=\"73\" cy=\"58\" r=\"24\" fill=\"currentColor\"/><path fill=\"currentColor\" d=\"M42,72 C45,85 44,94 34,100 L66,100 C56,94 55,85 58,72 C53,76 47,76 42,72 Z\"/></symbol>\n<symbol id=\"suit-heart\" viewBox=\"0 0 100 100\"><path fill=\"currentColor\" d=\"M50,92 C50,92 8,62 8,32 C8,12 24,3 38,8 C45,10.5 49,17 50,24 C51,17 55,10.5 62,8 C76,3 92,12 92,32 C92,62 50,92 50,92 Z\"/></symbol>\n<symbol id=\"suit-diamond\" viewBox=\"0 0 100 100\"><path fill=\"currentColor\" d=\"M50,4 L88,50 L50,96 L12,50 Z\"/></symbol>\n</defs>\n</svg>";

  var host = null, root = null, ctx = null, cache = {}, lastState = null;
  var bid = { mode: 'set', num: 28, kind: 'suit', suit: 'S', order: 'forward', note: '', sig: null, qtab: 'S', qview: 'grouped', qnum: 28 };
  try { if (localStorage.getItem('k56_quickview') === 'list') bid.qview = 'list'; } catch (e) {}
function crumpleFlyPopup(el, dx, dy, tint, done, fire) {
  if (el._crumple) { try { el._crumple.cancel(); } catch (e) {} }
  fire = fire || 0;
  const base = 'translate(-50%,-50%)';
  const ball = fire ? (fire > 2 ? '#ffd23a' : fire > 1 ? '#ffa000' : '#ff6a00') : (tint || '#3ddc84');
  const glow = fire ? (fire > 2 ? '0 0 22px 9px rgba(255,200,60,.95), 0 0 50px 22px rgba(255,80,0,.6)' : '0 0 12px 4px rgba(255,150,0,.85), 0 0 26px 10px rgba(255,70,0,.45)') : '';
  const me = el.dataset.me === '1';
  const ring = me ? ', 0 0 0 4px rgba(255,255,255,.9), 0 0 0 8px ' + ball + ', 0 0 18px 8px rgba(255,255,255,.35)' : '';
  const ins = (fire ? glow : 'inset -5px -5px 9px rgba(0,0,0,.35), inset 3px 3px 7px rgba(255,255,255,.25)') + ring;
  const grad = fire ? 'radial-gradient(circle at 50% 50%, #fffbe6 0%, ' + ball + ' 45%, #ff3d00 100%)' : 'none';
  const r0 = el.getBoundingClientRect(), W0 = r0.width, H0 = r0.height;
  const D = fire > 2 ? 1800 : fire ? 1400 : 1000, BS = (fire > 2 ? 92 : fire > 1 ? 64 : 54) + (el.dataset.me === '1' ? 22 : 0);
  el.style.overflow = fire ? 'visible' : 'hidden';
  const len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len, px = -uy, py = ux;
  const T = (x, y, r) => 'translate(calc(-50% + ' + x + 'px),calc(-50% + ' + y + 'px)) rotate(' + r + 'deg)';
  const ballF = (x, y, r, sz, off, ease, op) => ({ transform: T(x, y, r), width: sz + 'px', height: sz + 'px', padding: '0px', borderRadius: '50%', backgroundColor: ball, backgroundImage: grad, borderColor: ball, color: 'transparent', fontSize: '0rem', borderWidth: fire ? '0px' : '3px', backdropFilter: 'none', boxShadow: ins, opacity: op == null ? 1 : op, offset: off, easing: ease || 'ease-in-out' });
  let kf;
  if (!fire) {
    kf = [
      { transform: base + ' rotate(0deg)', width: W0 + 'px', height: H0 + 'px', borderRadius: '14px', opacity: 1, offset: 0, easing: 'ease-in' },
      { transform: base + ' rotate(-5deg)', width: (W0 * .72) + 'px', height: (H0 * .6) + 'px', borderRadius: '22px', opacity: 1, offset: .22, easing: 'ease-in' },
      { transform: base + ' rotate(9deg)', width: '90px', height: '58px', paddingLeft: '4px', paddingRight: '4px', borderRadius: '30px', fontSize: '.3rem', opacity: 1, offset: .4, easing: 'ease-in-out' },
      ballF(0, 0, -14, BS, .6, 'cubic-bezier(.45,.05,.55,.95)'),
      ballF(dx * .55, dy * .55 - 40, 280, 50, .82, 'ease-in'),
      ballF(dx, dy, 560, 40, 1, null, 0)
    ];
  } else {
    /* crumple -> ball -> pull back -> loop -> shoot at the winner */
    kf = [
      { transform: base + ' rotate(0deg)', width: W0 + 'px', height: H0 + 'px', borderRadius: '14px', opacity: 1, offset: 0, easing: 'ease-in' },
      { transform: base + ' rotate(-5deg)', width: (W0 * .72) + 'px', height: (H0 * .6) + 'px', borderRadius: '22px', opacity: 1, offset: .16, easing: 'ease-in' },
      { transform: base + ' rotate(9deg)', width: '90px', height: '58px', paddingLeft: '4px', paddingRight: '4px', borderRadius: '30px', fontSize: '.3rem', opacity: 1, offset: .29, easing: 'ease-in-out' },
      ballF(0, 0, -14, BS, .42, 'ease-out'),
      ballF(-ux * 34, -uy * 34, -200, BS - 8, .56, 'ease-in-out'),
      ballF(-ux * 18 + px * 26, -uy * 18 + py * 26, -420, BS - 6, .66, 'ease-in-out'),
      ballF(-ux * 18 - px * 26, -uy * 18 - py * 26, -640, BS - 6, .75, 'ease-in'),
      ballF(dx, dy, -1100, BS - 14, .97, 'linear', 1),
      ballF(dx, dy, -1160, BS - 20, 1, null, 0)
    ];
  }
  const num = document.createElement('span');
  num.innerHTML = el.dataset.me === '1' ? '<span style="display:block;text-align:center;line-height:1"><span style="display:block;font-size:.5rem;letter-spacing:.06em">YOU WIN</span>+' + (el.dataset.pts || '0') + '</span>' : '+' + (el.dataset.pts || '0');
  num.style.cssText = 'position:absolute;left:0;top:0;right:0;bottom:0;display:flex;align-items:center;justify-content:center;font:900 ' + (fire > 2 ? '1.6rem' : '1.15rem') + ' Inter,sans-serif;color:' + (fire ? '#4a1200' : '#fff') + ';text-shadow:' + (fire ? '0 0 4px rgba(255,255,255,.9)' : '0 1px 3px rgba(0,0,0,.9)') + ';opacity:0;pointer-events:none';
  el.appendChild(num);
  const nOn = fire ? .42 : .6, nOff = fire ? .94 : .9;
  const na = num.animate([{ opacity: 0, offset: 0 }, { opacity: 0, offset: nOn - .1 }, { opacity: 1, offset: nOn }, { opacity: 1, offset: nOff }, { opacity: 0, offset: 1 }], { duration: D, fill: 'forwards' });
  /* thin flame tail: tiny embers laid along the ball's path, shrinking to nothing */
  let raf = 0;
  if (fire) {
    const t0 = performance.now(), host = el.parentNode || document.body;
    let last = null;
    const ember = (x, y, s) => {
      const e = document.createElement('div');
      e.style.cssText = 'position:fixed;z-index:123;pointer-events:none;border-radius:50%;width:' + s + 'px;height:' + s + 'px;left:' + (x - s / 2) + 'px;top:' + (y - s / 2) + 'px;background:radial-gradient(circle,#fffbe0 0%,#ffd24a 35%,#ff6a00 70%,rgba(255,50,0,0) 100%);mix-blend-mode:screen';
      host.appendChild(e);
      const an = e.animate([{ transform: 'scale(1)', opacity: .95 }, { transform: 'scale(.08)', opacity: 0 }], { duration: fire > 2 ? 800 : fire > 1 ? 560 : 420, easing: 'ease-out' });
      an.onfinish = () => e.remove();
    };
    const loop = () => {
      const t = (performance.now() - t0) / D;
      if (t >= 1) return;
      if (t > .44) {
        const r = el.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        if (last) {
          const d = Math.hypot(cx - last[0], cy - last[1]), n = Math.max(1, Math.round(d / 5));
          for (let i = 1; i <= n; i++) ember(last[0] + (cx - last[0]) * i / n, last[1] + (cy - last[1]) * i / n, fire > 2 ? 30 : fire > 1 ? 15 : 11);
        }
        last = [cx, cy];
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
  }
  const a = el.animate(kf, { duration: D, fill: 'forwards' });
  el._crumple = a;
  a.onfinish = () => {
    try { a.cancel(); na.cancel(); num.remove(); } catch (e) {}
    if (raf) cancelAnimationFrame(raf);
    el._crumple = null; if (done) done();
  };
}
  function fireLevel(pt, st) {
    if (st.tricksLog && st.tricksLog.length >= 8) return 3;
    var log = (st.table && st.table.length ? { cards: st.table } : (st.tricksLog && st.tricksLog[st.tricksLog.length - 1])), cb = st.currentBid, tr = cb && cb.trump;
    if (!log || !log.cards || !log.cards.length || !tr) return 0;
    var lead = log.cards[0].card.s; if (lead === tr) return 0;
    var cuts = 0, wc = null;
    log.cards.forEach(function (p) { if (p.card.s === tr) cuts++; if (p.seat === pt.winnerSeat) wc = p.card; });
    if (!wc || wc.s !== tr) return 0;
    return cuts >= 2 ? 2 : 1;
  }
  var collectTimer = null, collectKey = null, winnerKey = null, resultKey = null;

  function $(id) { return root.getElementById ? root.getElementById(id) : root.querySelector('#' + id); }
  /* haptics: short phone vibration patterns (Android; iPhone doesn't allow web pages to vibrate) */
  function vib(p) { try { if (!navigator.vibrate) return; var f = function (d) { return Math.max(35, Math.round(d * 2.2)); }; navigator.vibrate(Array.isArray(p) ? p.map(function (d, i) { return i % 2 === 0 ? f(d) : Math.max(d, 40); }) : f(p)); } catch (e) {} }
  function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
  // only touch the DOM when something actually changed (this is what stops the flicker)
  function once(key, val, fn) { if (cache[key] === val) return; cache[key] = val; fn(); }
  function tog(el, c, on) { if (el && el.classList.contains(c) !== !!on) el.classList[on ? 'add' : 'remove'](c); }
  function setText(el, t) { if (el && el.textContent !== t) el.textContent = t; }
  function show(el, on, disp) { if (!el) return; var d = on ? (disp || 'block') : 'none'; if (el.style.display !== d) el.style.display = d; }
  function me() { var s = ctx.mySeat(); return s == null ? 0 : s; }
  function slotOf(seat) { return (seat - me() + 6) % 6; }
  function team(seat) { return ctx.teamOf(seat); }
  function sortHand(h) {
    return h.slice().sort(function (a, b) {
      return a.s !== b.s ? SORT.indexOf(a.s) - SORT.indexOf(b.s) : RANKS.indexOf(a.r) - RANKS.indexOf(b.r);
    });
  }
  function suitSvg(s, cls) { return '<svg class="' + cls + '" viewBox="0 0 100 100" aria-hidden="true"><use href="#suit-' + SUITID[s] + '"></use></svg>'; }
  function cardHtml(c, extra, attrs) {
    var col = RED[c.s] ? '#c0392b' : '#111';
    return '<div class="card ' + (extra || '') + '" ' + (attrs || '') + '><span class="cr" style="color:' + col + '"><span>' + c.r + '</span>' + suitSvg(c.s, 'suit-icon-corner') +
      '</span><span class="cs" style="color:' + col + '">' + suitSvg(c.s, 'suit-icon-center') + '</span><span class="crb" style="color:' + col + '"><span>' + c.r + '</span>' + suitSvg(c.s, 'suit-icon-corner') + '</span></div>';
  }

  var TPL = '' +
    '<div id="gameScreen">' +
    '<div class="fake-lamp-glow fake-lamp-glow-tl"><div class="fake-lamp-core"></div></div>' +
    '<div class="fake-lamp-glow fake-lamp-glow-tr"><div class="fake-lamp-core"></div></div>' +
    '<div class="fake-lamp-glow fake-lamp-glow-bl"><div class="fake-lamp-core"></div></div>' +
    '<div class="fake-lamp-glow fake-lamp-glow-br"><div class="fake-lamp-core"></div></div>' +
    '<button class="btn-outline" id="btnInvite" title="Invite a Friend" style="position:fixed;left:48px;bottom:114px;z-index:150;display:flex;align-items:center;gap:4px;padding:3px 9px;border-radius:7px;font-size:0.68rem;font-weight:800;white-space:nowrap">💌 Invite</button>' +
    '<div class="topbar" style="flex-direction:column;align-items:stretch;gap:2px;padding:6px 10px">' +
    '<div style="display:flex;justify-content:space-between;align-items:center;gap:4px">' +
    '<div class="score-box" style="padding:2px 5px;min-width:0;flex-shrink:0"><span class="slabel">HAND</span><span class="sval" id="roundNum">1</span></div>' +
    '<div class="score" style="display:flex;align-items:center;gap:3px;flex-shrink:0">' +
    '<div class="score-box" id="scoreBoxYours" style="padding:2px 5px;min-width:0"><span class="slabel">YOU</span><span class="sval" id="scoreA">12</span></div>' +
    '<span style="opacity:0.5;font-size:0.7rem">—</span>' +
    '<div class="score-box" id="scoreBoxOpp" style="padding:2px 5px;min-width:0"><span class="slabel">OPP</span><span class="sval" id="scoreB">12</span></div></div>' +
    '<div style="display:flex;gap:2px;align-items:center;flex-shrink:0">' +
    '<button class="btn-outline" id="btnHostMenu" style="padding:3px 9px;border-radius:7px;font-size:0.68rem;white-space:nowrap;font-weight:800">Menu</button>' +
    '<button class="btn-outline" id="btnChat" title="Chat" style="padding:3px 7px;border-radius:7px;font-size:0.68rem;position:relative">💬<span class="chat-badge" id="chatBadge"></span></button>' +
    '<button class="btn-outline" id="btnFullscreen" title="Full Screen" style="padding:3px 8px;border-radius:6px;font-size:0.85rem">⛶</button>' +
    '<button class="btn-outline" id="btnGameHome" title="Leave Table" style="margin-left:6px;padding:3px 9px;border-radius:6px;font-size:0.75rem;background:#c0392b;border-color:#c0392b;color:#fff;font-weight:800">✕</button>' +
    '</div></div>' +
    '<div style="display:grid;grid-template-columns:1fr auto 1fr;align-items:center;font-size:0.74rem;font-family:\'Cinzel\',\'Playfair Display\',serif;font-weight:600;color:var(--text-secondary)">' +
    '<div id="sixInfoDealerWrap" style="display:flex;justify-content:flex-start;overflow:hidden"><span>Dealer: <b style="color:#4ade80;text-shadow:0 0 6px rgba(74,222,128,0.4)" id="dealerDisplay">—</b></span></div>' +
    '<div id="sixInfoPointsWrap" style="display:flex;justify-content:center;white-space:nowrap;padding:0 6px"><span>Points: <b style="color:var(--accent);font-size:0.95em" id="teamPointsDisplay">0 - 0</b></span></div>' +
    '<div id="sixInfoBidderWrap" style="display:flex;justify-content:flex-end;overflow:hidden"><span>Bid: <b style="color:var(--accent);font-size:0.9em;text-shadow:0 0 6px rgba(244,196,48,0.5)" id="bidderDisplay">—</b></span></div>' +
    '</div></div>' +
    '<div class="trump-chip" id="trumpChip" style="display:none"></div>' +
    '<div class="ltrick" id="lastTrickPanel"><h6 id="lastTrickTitle">Last Trick</h6><div id="lastTrickContent"><div class="lt-empty">None yet</div></div><div class="lt-history" id="lastTrickHistory"></div></div><div class="ltrick-backdrop" id="ltrickBackdrop"></div>' +
    '<div id="bidWinnerBubble6p" style="display:none"></div>' +
    '<div id="bidStatusBanner6p" class="bid-status-banner" style="display:none"></div>' +
    '<div id="k56Trick"></div>' +
    '<div class="table-oval"><div class="six-oval-rail"></div><div class="six-oval-bevel"></div><div class="six-oval-felt"></div></div>' +
    [0, 1, 2, 3, 4, 5].map(function (i) { return '<div class="seat" id="seatWrap' + i + '"><div class="av" id="av' + i + '"></div><div class="nm" id="nm' + i + '"></div><div class="cc" id="cc' + i + '"></div></div>'; }).join('') +
    [0, 1, 2, 3, 4, 5].map(function (i) { return '<div class="trickslot" id="trickSlot' + i + '"></div>'; }).join('') +
    '<div class="hand-bar"><div class="turnlabel" id="turnLabel"></div><div class="hand-cards" id="handCards"></div></div>' +
    '</div>' +
    /* bid sheet */
    '<div class="overlay b56-ov" id="b56ov"><div class="panel b56-panel">' +
    '<div class="b56-head"><div class="b56-title">Your bid</div><div class="b56-status" id="b56Status"></div></div>' +
    '<div class="b56-scroll">' +
    '<div class="b56-sec">Calls so far</div><div class="b56-calls" id="b56Calls"></div>' +
    '<div class="b56-sec">Your hand</div><div class="b56-hand" id="b56Hand"></div>' +
    '<div class="b56-sec">Quick calls</div><div id="b56Quick"></div>' +
    '<div class="b56-sec">Custom call</div>' +
    '<div class="b56-row"><div class="b56-seg" id="b56Mode"></div>' +
    '<div class="b56-step"><button data-d="-1">−</button><input id="b56Num" type="text" inputmode="numeric"><button data-d="1">+</button></div></div>' +
    '<div class="b56-suits" id="b56Suits"></div>' +
    '<div class="b56-ord" id="b56Order"></div>' +
    '<div class="b56-explain" id="b56Explain"></div>' +
    '<input class="b56-note-in" id="b56Note" placeholder="Note to the table (optional)" maxlength="60">' +
    '<div class="b56-forced" id="b56Forced" style="display:none">Everyone else passed — you must open the bidding. You can\'t pass.</div>' +
    '<div class="b56-note" id="b56Msg"></div>' +
    '</div>' +
    '<div class="b56-actions"><button class="b56-pass" id="b56Pass">Pass</button><button class="b56-go" id="b56Go">Bid</button><button class="b56-dbl" id="b56Dbl" style="display:none">Double</button></div>' +
    '<div class="b56-cf" id="b56Cf"></div>' +
    '</div></div>' +
    /* hand result */
    '<div class="overlay r56-ov" id="res56" style="align-items:center;padding:20px"><div class="r56-box" id="res56Box"></div></div>' +
    SPRITE;

  /* ---------------- mount ---------------- */
  function sizeClass() {
    /* the table photo is portrait: on a wide screen it is shown as a centred phone-shaped column, so the
       phone layout is used everywhere (never the old wide-photo layout) */
    tog(host, 'k28-in-game', window.innerWidth >= 521);
  }
  /* The table photo, every seat, played card, avatar size and corner light come from the shared K28Stage module
     (table-stage.js), which scales them all from the same picture so alignment holds on every screen. */
  function placeStage() {
    var S = window.K28Stage; if (!S || !root) return;
    var g = {}, seats = [], tricks = [], avs = [];
    for (var i = 0; i < 6; i++) { seats.push($('seatWrap' + i)); tricks.push($('trickSlot' + i)); avs.push($('av' + i)); }
    ['tl', 'tr', 'bl', 'br'].forEach(function (k) { g[k] = root.querySelector('.fake-lamp-glow-' + k); });
    if (window.innerWidth >= 521) { S.reset($('gameScreen'), { glows: g }); return; }
    S.place('k56', $('gameScreen'), { seats: seats, tricks: tricks, avs: avs, glows: g, column: true });
  }
  function applySizes() { placeStage(); }
  function mount(c) {
    if (host) { ctx = c; return; }
    ctx = c;
    host = document.createElement('div');
    host.id = 'k56-host';
    host.hidden = true;
    root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<link rel="stylesheet" href="/k56-ui.css?v=34">' + TPL;
    document.body.appendChild(host);
    for (var i = 0; i < 6; i++) {
      var sw = $('seatWrap' + i);
      sw.style.transform = 'translate(-50%,-50%)';
    }
    // tap another player's avatar = send them a cheers (same as the 6-player table)
    [1, 2, 3, 4, 5].forEach(function (slot) {
      var a = $('av' + slot); a.style.cursor = 'pointer';
      a.addEventListener('click', function () {
        var target = (slot + me()) % 6;
        ctx.send('l56_buddyGreeting', { toPos: target });
      });
    });
    sizeClass(); applySizes();
    window.addEventListener('resize', function () { sizeClass(); applySizes(); fitHand(); });
    if (window.K28Stage) window.K28Stage.onChange(placeStage);
    var lk = root.querySelector('link');
    if (lk) lk.addEventListener('load', function () { sizeClass(); applySizes(); fitHand(); });
    wire();
    var src = document.getElementById('chatBadge56');
    if (src) {
      var mirror = function () {
        var b = $('chatBadge'); if (!b) return;
        b.textContent = src.textContent;
        b.style.display = getComputedStyle(src).display === 'none' ? 'none' : (src.textContent ? 'flex' : 'none');
      };
      new MutationObserver(mirror).observe(src, { childList: true, characterData: true, subtree: true, attributes: true });
      mirror();
    }
  }
  function wire() {
    $('btnChat').onclick = function () { ctx.chat(); };
    $('btnHostMenu').onclick = function () { ctx.menu(); };
    $('btnGameHome').onclick = function () { ctx.leave(); };
    $('btnInvite').onclick = function () { ctx.invite(); };
    var tgl = function () { var e = !$('lastTrickPanel').classList.contains('enlarged'); $('lastTrickPanel').classList.toggle('enlarged', e); $('ltrickBackdrop').classList.toggle('on', e); };
    $('lastTrickPanel').onclick = tgl; $('ltrickBackdrop').onclick = tgl;
    $('btnFullscreen').onclick = function () {
      var d = document, e = d.documentElement;
      try { if (d.fullscreenElement) d.exitFullscreen(); else if (e.requestFullscreen) e.requestFullscreen(); else if (e.webkitRequestFullscreen) e.webkitRequestFullscreen(); } catch (x) {}
    };
    $('handCards').addEventListener('click', function (ev) {
      var el = ev.target.closest ? ev.target.closest('.card') : null;
      if (!el || !el.dataset.id) return;
      vib(15);
      ctx.playCard(el.dataset.id);
    });
    var panel = root.querySelector('.b56-panel');
    panel.addEventListener('click', function (ev) {
      var b = ev.target.closest ? ev.target.closest('button') : null;
      if (!b) return;
      var st = lastState; if (!st) return;
      var cb = st.currentBid, minVal = cb ? cb.value + 1 : 28;
      if (b.dataset.qk) { var qd = (quickDefs || {})[b.dataset.qk]; if (qd) { vib(12); quickAsk(qd); } return; }
      if (b.dataset.qt) { bid.qtab = b.dataset.qt; renderBid(st, true); return; }
      if (b.dataset.qv) { bid.qview = b.dataset.qv; try { localStorage.setItem('k56_quickview', bid.qview); } catch (e) {} renderBid(st, true); return; }
      if (b.dataset.qn) { bid.qnum = Math.min(56, Math.max(minVal, bid.qnum + parseInt(b.dataset.qn, 10))); renderBid(st, true); return; }
      if (b.dataset.mode) {
        if (b.dataset.mode !== bid.mode) { bid.mode = b.dataset.mode; bid.num = bid.mode === 'inc' ? 1 : minVal; }
      } else if (b.dataset.d) {
        bid.num = Math.max(1, bid.num + parseInt(b.dataset.d, 10));
      } else if (b.dataset.suit) {
        var v = b.dataset.suit;
        if (v === 'NT') bid.kind = 'nt'; else if (v === 'NS') bid.kind = 'ns'; else { bid.kind = 'suit'; bid.suit = v; }
      } else if (b.dataset.order) {
        bid.order = b.dataset.order;
      } else if (b.dataset.cf) { return cfAnswer(b.dataset.cf); }
      else if (b.id === 'b56Go') { vib(12); return submitAsk(); }
      else if (b.id === 'b56Pass') { vib(12); return passAsk(); }
      else if (b.id === 'b56Dbl') { vib([20, 30, 20]); return dblAsk(); }
      else return;
      renderBid(st, true);
    });
    $('b56Num').addEventListener('change', function () {
      var v = parseInt(this.value, 10); if (!isNaN(v)) bid.num = v;
      if (lastState) renderBid(lastState, true);
    });
    $('b56Note').addEventListener('input', function () { bid.note = this.value; });
    $('b56Quick').addEventListener('change', function (ev) {
      var t = ev.target; if (!t || t.id !== 'b56QNum') return;
      var v = parseInt(t.value, 10), mv = lastState && lastState.currentBid ? lastState.currentBid.value + 1 : 28;
      if (!isNaN(v)) bid.qnum = Math.min(56, Math.max(mv, v));
      if (lastState) renderBid(lastState, true);
    });
  }

  /* ---------------- quick calls: one tap per call ---------------- */
  // sig = what the call tells the partner (bots read it):
  //   plus "+ ♠"/"+2 ♠"..  the Jack ("+" = just the Jack, "+2" = Jack and 1 more support, ...)   straight "28 ♠"  5 trump with the Jack
  //   rev "♠ 28"  no Jack, 4+ trump        revplus "♠ +"/"♠ +2"  2 trump (bigger + = stronger cards)
  //   nt "29 NT"   nos "29 NOS"   nosreply "+1 NOS" (answer to a partner's NOS)   nosrest "+ NOS" (none of the suits my partners have not called, any round)
  //   numpass "29 Pass"  a pass with a number: no trump, my last partner must open his strongest suit
  var quickDefs = {};
  var SUITNAME = { S: 'Spades', H: 'Hearts', D: 'Diamonds', C: 'Clubs' };
  var QCAP = { plus: 'Plus — raise the bid (+ = the Jack, each step = one more support)', straight: 'Straight call — 5 trump with the Jack', rev: 'Suit first — no Jack, 4+ trump',
    revplus: 'Suit first, plus — 2 trump (bigger + = stronger cards)', nt: 'Number + No Trump', nos: 'Number + NOS', nosplus: 'Plus NOS', numpass: 'Pass with a number (no trump — last partner opens his strongest)' };
  function qDefs(g, cb, minVal, num) {
    var base = cb ? cb.value : 27, out = [];
    if (g !== 'X') {
      var sym = SYM[g], red = RED[g];
      var mk = function (label, value, inc, order, sg, section, tip) { return { label: label, value: value, inc: inc, order: order, sig: sg, section: section, tip: tip, kind: 'suit', trump: g, red: red, ok: value >= minVal && value <= 56 }; };
      for (var n = 1; n <= 7; n++) out.push(mk(n === 1 ? '+ ' + sym + ' → ' + (base + n) : '+' + n + ' ' + sym + ' → ' + (base + n), base + n, true, 'forward', 'plus', 'plus', n === 1 ? 'Just the Jack of ' + SUITNAME[g] : 'The Jack and ' + (n - 1) + ' more support'));
      out.push(mk(num + ' ' + sym, num, false, 'forward', 'straight', 'straight', 'Straight call: 5 trump with the Jack'));
      out.push(mk(sym + ' ' + num, num, false, 'reverse', 'rev', 'rev', 'Suit first: no Jack, 4 or more trump'));
      for (var m = 1; m <= 7; m++) out.push(mk(m === 1 ? sym + ' + → ' + (base + m) : sym + ' +' + m + ' → ' + (base + m), base + m, true, 'reverse', 'revplus', 'revplus', m === 1 ? '2 trump' : '2 trump, stronger value cards'));
    } else {
      var mk2 = function (label, kind, value, inc, sg, section, tip) { return { label: label, value: value, inc: inc, order: null, sig: sg, section: section, tip: tip, kind: kind, trump: null, red: false, ok: value >= minVal && value <= 56 }; };
      out.push(mk2(num + ' NT', 'nt', num, false, 'nt', 'nt', 'Number + No Trump'));
      out.push(mk2(num + ' NOS', 'ns', num, false, 'nos', 'nos', 'Number + NOS: nothing in the suit'));
      out.push(mk2('+ NOS → ' + (base + 1), 'ns', base + 1, true, 'nosrest', 'nosplus', 'I have none of the suits my partners have not called yet (any round)'));
      out.push(mk2('+1 NOS → ' + (base + 1), 'ns', base + 1, true, 'nosreply', 'nosplus', 'Answer to my partner\u2019s NOS: nothing in it either'));
      out.push(mk2('+2 NOS → ' + (base + 2), 'ns', base + 2, true, 'nosreply', 'nosplus', 'Answer to my partner\u2019s NOS, stronger'));
      out.push({ label: num + ' Pass', value: num, inc: false, order: null, sig: 'numpass', section: 'numpass', tip: 'A pass with a number: no trump \u2014 my last partner must open his strongest suit', kind: 'pass', trump: null, red: false, ok: true });
    }
    return out;
  }
  function qButtons(defs, tag, store) {
    var html = '', last = null;
    defs.forEach(function (d, i) {
      var sec = d.section;
      var newRow = sec !== last && !((sec === 'straight' || sec === 'rev') && (last === 'straight' || last === 'rev')) && !((sec === 'nt' || sec === 'nos') && (last === 'nt' || last === 'nos'));
      if (newRow) { if (last !== null) html += '</div>'; html += '<div class="b56-qrow"><div class="b56-qcap">' + QCAP[sec] + '</div>'; }
      last = sec;
      var id = tag + ':' + i; store[id] = d;
      html += '<button type="button" class="b56-q' + (d.red ? ' red' : '') + '" title="' + esc(d.tip || '') + '" data-qk="' + id + '"' + (d.ok ? '' : ' disabled') + '>' + esc(d.label) + '</button>';
    });
    return html + '</div>';
  }
  function renderQuick(cb, minVal) {
    if (bid.qnum < minVal || bid.qnum > 56) bid.qnum = Math.min(56, Math.max(minVal, bid.qnum));
    var store = {}, body = '';
    var groups = ['S', 'H', 'D', 'C', 'X'];
    var tabName = function (g) { return g === 'X' ? 'NT · NOS · Pass' : SYM[g]; };
    if (bid.qview === 'grouped') {
      body += '<div class="b56-qtabs">' + groups.map(function (g) { return '<button type="button" class="b56-q' + (RED[g] ? ' red' : '') + (bid.qtab === g ? ' sel' : '') + '" data-qt="' + g + '">' + tabName(g) + '</button>'; }).join('') + '</div>';
      var g0 = groups.indexOf(bid.qtab) >= 0 ? bid.qtab : 'S';
      body += qButtons(qDefs(g0, cb, minVal, bid.qnum), g0, store);
    } else {
      body += '<div class="b56-qlist">' + groups.map(function (g) {
        return '<div class="b56-qgrp' + (RED[g] ? ' red' : '') + '">' + (g === 'X' ? 'No Trump · NOS · Pass' : SYM[g] + ' ' + SUITNAME[g]) + '</div>' + qButtons(qDefs(g, cb, minVal, bid.qnum), g, store);
      }).join('') + '</div>';
    }
    quickDefs = store;
    var qi = $('b56QNum'), keepFocus = qi && root.activeElement === qi;
    $('b56Quick').innerHTML = '<div class="b56-qhead"><span class="b56-qnum">Number <button type="button" data-qn="-1">−</button><input id="b56QNum" type="text" inputmode="numeric" value="' + bid.qnum + '"><button type="button" data-qn="1">+</button></span>' +
      '<span class="b56-seg"><button type="button" data-qv="grouped" class="' + (bid.qview === 'grouped' ? 'sel' : '') + '">Grouped</button><button type="button" data-qv="list" class="' + (bid.qview === 'list' ? 'sel' : '') + '">One list</button></span></div>' +
      body + '<div class="b56-qhint">One tap places that call. The number after → is the bid it makes. Press and hold a button to see what it tells your partner.</div>';
    if (keepFocus) { var n2 = $('b56QNum'); if (n2) n2.focus(); }
  }
  /* ---- confirmation: every call is shown first and only sent after Confirm ---- */
  var pendingAct = null;
  window.__k56Label = function (sp, cb, st) { lastState = st; return callLabel(sp, cb); };
  /* The exact wording the table will show for a call (mirrors l56-engine formatBidLogLabel + the server's increment rules). */
  function callLabel(sp, cb) {
    var v = sp.value, inc = sp.inc === true, n = inc ? v - (cb ? cb.value : 27) : 0, nn = n === 1 ? '' : String(n);
    if (sp.kind === 'pass') return sp.value ? sp.value + ' Pass' : 'Pass';
    if (sp.kind === 'nt') return inc ? '+' + n + ' No Trump (' + v + ')' : v + ' No Trump';
    if (sp.kind === 'ns') {
      if (sp.sig === 'nosrest') return '+ NOS (' + v + ')';
      if (inc && cb) { var ns = cb.trump || (cb.kind === 'ns' && lastState.nsBySeat && typeof lastState.nsBySeat[cb.seat] === 'string' ? lastState.nsBySeat[cb.seat] : null); return '+' + (v - cb.value) + ' NOS ' + v + (ns ? ' ' + SYM[ns] : ''); }
      return v + ' NOS';
    }
    var sym = SYM[sp.trump];
    if (inc) return (sp.order === 'reverse' ? sym + ' +' + nn : '+' + nn + ' ' + sym) + ' (' + v + ')';
    return sp.order === 'reverse' ? sym + ' ' + v : v + ' ' + sym;
  }
  function callMeaning(sp) {
    if (sp.tip) return sp.tip;
    if (sp.kind === 'nt') return 'No Trump: 3+ Jacks spread across different suits';
    if (sp.kind === 'ns') return sp.inc ? 'Plus NOS: nothing in the suit either' : 'NOS: nothing in the suit just bid';
    if (sp.order === 'reverse') return sp.inc ? 'Suit first, plus: 2 trump' : 'Suit first: no Jack, 4 or more trump';
    if (sp.inc) { var n = sp.value - (lastState && lastState.currentBid ? lastState.currentBid.value : 27); return n <= 1 ? 'Just the Jack of ' + SUITNAME[sp.trump] : 'The Jack of ' + SUITNAME[sp.trump] + ' and ' + (n - 1) + ' more support'; }
    return 'Number first: the Jack of ' + SUITNAME[sp.trump];
  }
  function askConfirm(big, red, sub, fn) {
    pendingAct = fn;
    var cf = $('b56Cf');
    cf.innerHTML = '<div class="b56-cfbox"><div class="b56-cfq">Confirm your call</div><div class="b56-cfbig' + (red ? ' red' : '') + '">' + esc(big) + '</div>' +
      '<div class="b56-cfsub">' + esc(sub) + '</div><div class="b56-cfall">Everyone at the table will see this call.</div>' +
      '<div class="b56-cfbtns"><button type="button" data-cf="no" class="b56-cfno">Cancel</button><button type="button" data-cf="yes" class="b56-cfyes">Confirm</button></div></div>';
    cf.classList.add('on');
  }
  function cfAnswer(a) {
    var fn = pendingAct; pendingAct = null; $('b56Cf').classList.remove('on');
    if (a === 'yes' && fn) { vib(15); fn(); }
  }
  function quickAsk(d) {
    var st = lastState, cb = st.currentBid, note = bid.note.trim();
    var big = callLabel(d, cb), nm = note ? ' · “' + note + '”' : '';
    var sub = d.kind === 'pass' ? 'Pass with ' + d.value + ' — no trump. ' + (d.tip || '') : 'Bid goes to ' + d.value + '. ' + callMeaning(d);
    askConfirm(big, !!d.red, sub + nm, function () { quickSubmit(d); });
  }
  function submitAsk() {
    var st = lastState, cb = st.currentBid, value = previewValue(cb), minAllowed = cb ? cb.value + 1 : 28;
    if (value < minAllowed) { msg('Your bid must be at least ' + minAllowed + '.'); return; }
    var sp = { kind: bid.kind, trump: bid.kind === 'suit' ? bid.suit : null, order: bid.kind === 'suit' ? bid.order : null, inc: bid.mode === 'inc', value: value };
    var note = bid.note.trim();
    askConfirm(callLabel(sp, cb), sp.kind === 'suit' && !!RED[sp.trump], 'Bid goes to ' + value + '. ' + callMeaning(sp) + (note ? ' · “' + note + '”' : ''), submit);
  }
  function passAsk() {
    var st = lastState;
    if (st.forcedSeat === ctx.mySeat() && !st.currentBid) { msg('You must open the bidding.'); return; }
    askConfirm(st.finalChance ? 'Finalize bid' : 'Pass', false, st.finalChance ? 'Your bid stands and the bidding ends.' : 'You are out of this round of bidding.', doPass);
  }
  function dblAsk() {
    var st = lastState;
    askConfirm(st.doubled === 1 ? 'Redouble' : 'Double', false, st.doubled === 1 ? 'Doubles the stakes again.' : 'Doubles the stakes against their bid.', doDouble);
  }
  function quickSubmit(d) {
    var st = lastState, cb = st.currentBid, note = bid.note.trim();
    if (d.kind === 'pass') {
      if (st.forcedSeat === ctx.mySeat() && !cb) { msg('You must open the bidding.'); return; }
      afterAct(); ctx.send('l56_pass', { note: note, num: d.value }); return;
    }
    var minAllowed = cb ? cb.value + 1 : 28;
    if (d.value < minAllowed || d.value > 56) { msg('Your bid must be at least ' + minAllowed + '.'); return; }
    afterAct();
    ctx.send('l56_placeBid', { value: d.value, trump: d.trump, kind: d.kind, order: d.kind === 'suit' ? d.order : null, inc: !!d.inc, sig: d.sig, note: note });
  }

  /* ---------------- bidding ---------------- */
  function previewValue(cb) {
    var v = bid.mode === 'set' ? bid.num : (cb ? cb.value : 27) + bid.num;
    return Math.min(56, v);
  }
  function msg(t) { var m = $('b56Msg'); if (m) { m.textContent = t || ''; m.style.color = t ? '#ff8f8f' : ''; } }
  function afterAct() { bid.note = ''; var n = $('b56Note'); if (n) n.value = ''; }
  function submit() {
    var st = lastState, cb = st.currentBid, value = previewValue(cb), minAllowed = cb ? cb.value + 1 : 28;
    if (value < minAllowed) { msg('Your bid must be at least ' + minAllowed + '.'); return; }
    var note = bid.note.trim(); afterAct();
    ctx.send('l56_placeBid', { value: value, trump: bid.kind === 'suit' ? bid.suit : null, kind: bid.kind, order: bid.kind === 'suit' ? bid.order : null, inc: bid.mode === 'inc', note: note });
  }
  function doPass() {
    var st = lastState;
    if (st.forcedSeat === ctx.mySeat() && !st.currentBid) { msg('You must open the bidding.'); return; }
    var note = bid.note.trim(); afterAct(); ctx.send('l56_pass', { note: note });
  }
  function doDouble() {
    var st = lastState, note = bid.note.trim(); afterAct();
    ctx.send(st.doubled === 1 ? 'l56_redouble' : 'l56_double', { note: note });
  }
  function renderBid(st, force) {
    var ov = $('b56ov'), ms = ctx.mySeat();
    var myTurn = st.phase === 'bidding' && ms != null && st.turn === ms;
    tog(ov, 'on', myTurn);
    if (!myTurn) { cache.bidSheet = null; pendingAct = null; var _cf = $('b56Cf'); if (_cf) _cf.classList.remove('on'); return; }
    var cb = st.currentBid, minVal = cb ? cb.value + 1 : 28;
    var sig = st.handNumber + ':' + (cb ? cb.seat + '-' + cb.value : 'none');
    if (sig !== bid.sig) { bid.sig = sig; bid.num = minVal; bid.mode = 'set'; bid.qnum = Math.min(56, minVal + 1); msg(''); }
    if (bid.mode === 'set' && bid.num < minVal) bid.num = Math.min(56, minVal);
    var pv = previewValue(cb);
    var oppose = cb && team(cb.seat) !== team(ms), mine = cb && team(cb.seat) === team(ms);
    var canDbl = oppose && st.doubled === 0, canRe = mine && st.doubled === 1;
    var forced = st.forcedSeat === ms && !cb;
    var log = ctx.handLog(st);
    var key = JSON.stringify([bid, pv, st.handNumber, log.length, cb && cb.value, st.doubled, forced, canDbl, canRe]);
    if (!force && cache.bidSheet === key) return;
    cache.bidSheet = key;
    $('b56Status').innerHTML = cb ? '<b>' + esc(ctx.formatBid(cb)) + '</b> held by ' + esc((st.seats[cb.seat] || {}).name) + (st.doubled ? ' · ' + (st.doubled === 2 ? 'Redoubled' : 'Doubled') : '') : 'Opening bid: <b>28</b>';
    $('b56Calls').innerHTML = log.length ? log.map(function (l) {
      var cls = l.seat == null ? '' : (team(l.seat) === team(ms) ? ' me' : ' opp');
      return '<span class="b56-chip' + cls + '">' + esc(l.text) + '</span>';
    }).join('') : '<span class="b56-chip none">No calls yet — you speak first</span>';
    var cs = $('b56Calls'); cs.scrollLeft = cs.scrollWidth;
    $('b56Hand').innerHTML = sortHand(st.hands[ms] || []).map(function (c) { return '<span class="b56-mc' + (RED[c.s] ? ' red' : '') + '"><i>' + c.r + '</i><b>' + SYM[c.s] + '</b></span>'; }).join('');
    renderQuick(cb, minVal);
    $('b56Mode').innerHTML = '<button data-mode="set" class="' + (bid.mode === 'set' ? 'sel' : '') + '">Set to</button><button data-mode="inc" class="' + (bid.mode === 'inc' ? 'sel' : '') + '">Increase by</button>';
    var ni = $('b56Num'); if (root.activeElement !== ni) ni.value = bid.num;
    $('b56Suits').innerHTML = ['S', 'H', 'D', 'C'].map(function (s) {
      return '<button data-suit="' + s + '" class="' + (RED[s] ? 'red ' : '') + (bid.kind === 'suit' && bid.suit === s ? 'sel' : '') + '">' + SYM[s] + '</button>';
    }).join('') + '<button data-suit="NT" class="txt ' + (bid.kind === 'nt' ? 'sel' : '') + '">No Trump</button><button data-suit="NS" class="txt ' + (bid.kind === 'ns' ? 'sel' : '') + '">NOS</button>';
    var sym = SYM[bid.suit], red = RED[bid.suit] ? ' red' : '';
    var nsS = cb && (cb.trump || (cb.kind === 'ns' && st.nsBySeat && typeof st.nsBySeat[cb.seat] === 'string' ? st.nsBySeat[cb.seat] : null)), nsSym = nsS ? SYM[nsS] : '';
    var incPre = (bid.mode === 'inc' && cb) ? '<span class="pre">' + esc((st.seats[cb.seat] || {}).name || '') + ' bid ' + esc(ctx.formatBid(cb)) + '</span>' : '';
    $('b56Order').innerHTML = bid.kind === 'ns' ? '<button data-order="nos" class="sel nos">' + incPre + '<span class="pv">' + (bid.mode === 'inc' ? '+' + (bid.num === 1 ? '' : bid.num) + ' NOS' : 'NOS') + '</span><span class="lb">' + (bid.mode === 'inc' ? pv + (nsSym ? ' ' + nsSym : '') : 'Nothing in your suit') + '</span></button>' : bid.kind !== 'suit' ? '' :
      '<button data-order="forward" class="' + (bid.order === 'forward' ? 'sel' : '') + '">' + incPre + '<span class="pv' + red + '">' + (bid.mode === 'inc' ? '+' + (bid.num === 1 ? '' : bid.num) + ' ' + sym : pv + ' ' + sym) + '</span><span class="lb">Have the Jack</span></button>' +
      '<button data-order="reverse" class="' + (bid.order === 'reverse' ? 'sel' : '') + '">' + incPre + '<span class="pv' + red + '">' + (bid.mode === 'inc' ? sym + ' +' + (bid.num === 1 ? '' : bid.num) : sym + ' ' + pv) + '</span><span class="lb">No Jack, 4+ cards</span></button>';
    var ex = '';
    if (bid.kind === 'nt') ex = 'No Trump — signals 3+ Jacks spread across different suits. If it wins, the hand is played with no trump.';
    else if (bid.kind === 'ns') ex = bid.mode === 'inc' ? '+N NOS — a plus call: you hold nothing in the suit either (your partner already said NOS). If it wins it plays like No Trump.' : 'NOS (No Suit) — you hold nothing in the suit just bid. If it wins it plays like No Trump.';
    else ex = 'Number first = you hold the Jack of this suit. Suit first = no Jack, but 4 or more cards in it.' + (bid.mode === 'inc' ? ' This submits a bid of ' + pv + '.' : '');
    if (cb && bid.kind === 'suit' && bid.suit === cb.trump && team(cb.seat) === team(ms)) {
      ex += bid.mode === 'inc' ? ' Plus call to your partner: honors only (+1 = the Jack, +2 = Jack and 9), no extra length.' : ' Plain number to your partner: those honors AND support (3+ cards in the suit).';
    }
    $('b56Explain').textContent = ex;
    show($('b56Forced'), forced);
    var go = $('b56Go');
    go.textContent = 'Bid ' + callLabel({ kind: bid.kind, trump: bid.kind === 'suit' ? bid.suit : null, order: bid.kind === 'suit' ? bid.order : null, inc: bid.mode === 'inc', value: pv }, cb);
    show($('b56Pass'), !forced, 'block'); setText($('b56Pass'), st.finalChance ? 'Finalize bid' : 'Pass');
    var d = $('b56Dbl'); show(d, canDbl || canRe, 'block'); d.textContent = canRe ? 'Redouble' : 'Double';
  }

  /* ---------------- hand ---------------- */
  var fitTries = 0;
  function fitHand() {
    var hc = $('handCards'), bar = root.querySelector('.hand-bar');
    if (!hc || !bar) return;
    var cards = hc.querySelectorAll('.card');
    if (!cards.length) return;
    for (var z = 0; z < cards.length; z++) cards[z].style.removeProperty('margin-left');
    var W = bar.clientWidth - 12, w = cards[0].getBoundingClientRect().width;
    if (!(W > 60) || !(w > 10)) { if (fitTries++ < 30) setTimeout(fitHand, 80); return; }
    fitTries = 0;
    var n = cards.length, m = 0;
    var natural = parseFloat(getComputedStyle(cards[Math.min(1, n - 1)]).marginLeft) || 0;
    if (n > 1) {
      var total = n * w + (n - 1) * natural;
      m = total > W ? (W - n * w) / (n - 1) : natural;
    }
    for (var i = 1; i < n; i++) cards[i].style.setProperty('margin-left', m.toFixed(1) + 'px', 'important');
    cards[0].style.setProperty('margin-left', '0', 'important');
  }
  function renderHand(st) {
    var ms = ctx.mySeat(), hand = ms == null ? [] : (st.hands[ms] || []);
    var playable = st.phase === 'playing' && st.turn === ms;
    var legal = playable ? ctx.legalIds(st) : null;
    var sorted = sortHand(hand), prev = null;
    var key = sorted.map(function (c) { return c.id + (playable ? (legal.has(c.id) ? '+' : '-') : ''); }).join(',') + '|' + playable;
    once('hand', key, function () {
      $('handCards').innerHTML = sorted.map(function (c) {
        var first = prev !== null && c.s !== prev; prev = c.s;
        return cardHtml(c, (playable && !legal.has(c.id) ? 'disabled ' : '') + (first ? 'suit-group-start' : ''), 'data-id="' + c.id + '"' + (playable && legal.has(c.id) ? ' style="cursor:pointer"' : ''));
      }).join('');
      fitHand();
    });
    var lbl = '';
    if (st.phase === 'bidding' || st.phase === 'playing') {
      var seat = st.seats[st.turn];
      if (st.turn === ms) lbl = st.phase === 'bidding' ? 'Your turn to bid' : 'Your turn to play';
      else if (seat) lbl = seat.name + "'s turn";
    }
    setText($('turnLabel'), lbl);
    (function (l) { if (!l) return; l.style.setProperty('width', 'fit-content', 'important'); l.style.setProperty('min-width', '0', 'important'); l.style.setProperty('max-width', '92vw', 'important'); if (!l.textContent) return; l.style.fontSize = ''; var fs = parseFloat(getComputedStyle(l).fontSize) || 12; while (l.scrollWidth > l.clientWidth + 1 && fs > 8) { fs -= 0.5; l.style.fontSize = fs + 'px'; } })($('turnLabel'));
    var tl = $('turnLabel'), has = !!lbl, tmine = st.turn === ms; once('turnVib', tmine ? st.phase + ':' + st.turn + ':' + st.handNumber + ':' + ((st.table && st.table.length) || 0) + ':' + ((st.tricksLog && st.tricksLog.length) || 0) : '', function () { if (tmine) vib([15, 30, 15]); });
    var tmine2 = tmine, tpart = !tmine && st.turn != null && team(st.turn) === team(me());
    tog(tl, 'tl-mine', has && tmine); tog(tl, 'tl-partner', has && tpart); tog(tl, 'tl-opp', has && !tmine && !tpart);
  }

  /* ---------------- seats / table ---------------- */
  function renderSeats(st) {
    var ms = me(), nobodyPlayed = !(st.table && st.table.length) && !(st.tricksLog && st.tricksLog.length);
    var showCalls = st.phase === 'bidding' || st.phase === 'auctionClosed' || (st.phase === 'playing' && nobodyPlayed);
    var cb = st.currentBid;
    for (var seat = 0; seat < 6; seat++) {
      var slot = slotOf(seat), occ = st.seats[seat];
      var wrap = $('seatWrap' + slot), av = $('av' + slot), nm = $('nm' + slot), cc = $('cc' + slot);
      if (!occ) {
        once('seat' + slot, 'empty', function () { av.innerHTML = ''; av.style.background = ''; nm.textContent = ''; cc.textContent = ''; });
        wrap.style.opacity = '0.25'; tog(wrap, 'on', false); continue;
      }
      wrap.style.opacity = '1';
      var q = (st.qMarks && st.qMarks[occ.name]) || 0;
      var face = ctx.face(occ, seat, st);
      var isBidder = cb && cb.seat === seat && st.phase !== 'lobby';
      var badge = isBidder ? 'B' + cb.value : '';
      var isDealer = st.dealer === seat && st.phase !== 'lobby';
      var key = [face.html, face.bg, q, !!occ.bot, badge, isDealer].join('|');
      once('seat' + slot, key, function () {
        av.style.background = face.bg || '';
        av.innerHTML = face.html +
          (q > 0 ? '<img src="/images/kunukku/sad-coconut.png" class="kunukku-avatar-img" alt="Kunukku"><div class="kunukku-count-badge">' + q + '</div>' : '') +
          '<span class="tdot ' + (occ.bot ? 'topp' : 'tyou') + '"></span>' +
          (badge ? '<div class="bdg bdg-bidder">' + esc(badge) + '</div>' : '') +
          (isDealer ? '<div class="bdg bdg-dealer">D</div>' : '') +
          (q > 0 ? '<div class="bdg-q">' + q + ' Kunukku' + (q > 1 ? 's' : '') + '</div>' : '');
      });
      tog(av, 'human-status', !occ.bot); tog(av, 'bot-status', !!occ.bot);
      setText(nm, occ.name);
      var mate = team(seat) === team(ms);
      tog(nm, 'name-teammate', mate); tog(nm, 'name-opponent', !mate);
      var cnt = (st.hands[seat] || []).length;
      setText(cc, st.phase === 'lobby' ? '' : cnt + 'c');
      tog(wrap, 'on', st.turn === seat && (st.phase === 'bidding' || st.phase === 'playing'));
      // call bubble
      var la = showCalls && st.lastActionBySeat ? st.lastActionBySeat[seat] : null;
      var callEl = wrap.querySelector('.call-badge');
      if (la) {
        var isPass = /pass/i.test(la);
        var cls = 'call-badge' + (isPass ? ' call-badge-pass' : '') + ' call-badge-' + CALL_DIR[slot];
        if (!callEl) { callEl = document.createElement('div'); wrap.appendChild(callEl); }
        if (callEl.dataset.cls !== cls) { callEl.dataset.cls = cls; callEl.className = cls; }
        if (callEl.dataset.v !== la) { callEl.dataset.v = la; callEl.innerHTML = '<div class="call-badge-header">' + esc(la) + '</div>'; }
      } else if (callEl) callEl.remove();
    }
  }
  function renderTrick(st) {
    var want = [null, null, null, null, null, null];
    (st.table || []).forEach(function (p) { want[slotOf(p.seat)] = p.card; });
    for (var s = 0; s < 6; s++) {
      var el = $('trickSlot' + s), c = want[s];
      var k = c ? c.id : '';
      once('ts' + s, k, function () {
        el.style.transition = ''; el.style.transform = ''; el.style.opacity = '';
        el.innerHTML = c ? cardHtml(c, 'tiny trick-card-landing') : '';
      });
    }
    // banner + collect animation
    var pt = st.pendingTrick, tb = $('k56Trick');
    if (pt) {
      var w = st.seats[pt.winnerSeat];
      once('trickBanner', pt.ts + ':' + pt.winnerSeat, function () {
        if (tb._crumple) { try { tb._crumple.cancel(); } catch (e) {} tb._crumple = null; }
        tb.style.transition = ''; tb.style.transform = ''; tb.style.opacity = '';
        var mineW = ctx.relTeam(pt.winnerSeat) === 'Team';
        tb.style.borderColor = mineW ? '#3ddc84' : '#ef4444'; tb.style.color = mineW ? '#3ddc84' : '#ff6b6b'; tb.style.background = mineW ? 'repeating-linear-gradient(0deg,rgba(255,255,255,.045) 0 1px,transparent 1px 3px),linear-gradient(180deg,#12512f,#0a301d 55%,#061c11)' : 'repeating-linear-gradient(0deg,rgba(255,255,255,.045) 0 1px,transparent 1px 3px),linear-gradient(180deg,#5a1a1f,#36100f 55%,#210909)'; tb.style.boxShadow = 'inset 0 0 0 2px rgba(0,0,0,.55),inset 0 0 0 3px rgba(255,255,255,.18),0 10px 26px rgba(0,0,0,.65)'; tb.style.backdropFilter = 'none'; tb.style.webkitBackdropFilter = 'none';
        var iWon = pt.winnerSeat === ctx.mySeat(); tb.dataset.me = iWon ? '1' : '0'; vib(iWon ? [20, 40, 20] : 30);
        tb.innerHTML = '<b>' + (iWon ? 'YOU' : esc(w ? w.name : '')) + '</b> ' + (iWon ? 'win' : 'wins') + ' the trick · +' + pt.points + ' pts to ' + esc(ctx.relTeam(pt.winnerSeat));
      });
      tog(tb, 'on', true);
      /* sits in the empty space above the top player's head, clear of the header and the avatar */
      var topAv = $('av3');
      if (topAv && !tb.style.transform) {
        var th = tb.offsetHeight, sw3 = $('seatWrap3'), avTop = sw3 && sw3.style.top ? parseFloat(sw3.style.top) - (parseFloat(topAv.style.height || 108) + 16) / 2 : topAv.getBoundingClientRect().top;
        tb.style.top = Math.max(avTop - 12 - th / 2, window.innerHeight * 0.23 + th / 2) + 'px';
      }
      var key = 'c' + pt.ts;
      if (collectKey !== key) {
        collectKey = key; clearTimeout(collectTimer);
        var elapsed = Date.now() - pt.ts, fire = Math.max(0, (ctx.trickMs || 1800) - 550 - elapsed);
        collectTimer = setTimeout(function () {
          var tgt = $('seatWrap' + slotOf(pt.winnerSeat)).getBoundingClientRect();
          // the green "wins the trick" card flies from the middle to the winner
          var br = tb.getBoundingClientRect();
          var cdx = (tgt.left + tgt.width / 2) - (br.left + br.width / 2), cdy = (tgt.top + tgt.height / 2) - (br.top + br.height / 2);
          // it crumples into a ball and the ball spins off to the winner
          if (tb.animate) {
            tb.dataset.pts = pt.points; tb.dataset.fire = fireLevel(pt, st);
            crumpleFlyPopup(tb, cdx, cdy, tb.style.borderColor || '#3ddc84', function () { tb.style.opacity = '0'; if (!lastState || !lastState.pendingTrick) tog(tb, 'on', false); }, +tb.dataset.fire);
          } else {
            tb.style.transition = 'transform .5s cubic-bezier(.4,.1,.6,1),opacity .5s ease-in';
            tb.style.transform = 'translate(calc(-50% + ' + cdx + 'px),calc(-50% + ' + cdy + 'px)) scale(.25)';
            tb.style.opacity = '0';
          }
          for (var i = 0; i < 6; i++) {
            var e = $('trickSlot' + i), r = e.getBoundingClientRect();
            if (!e.firstChild) continue;
            e.style.transition = 'transform .45s cubic-bezier(.4,.1,.6,1),opacity .45s ease-in';
            e.style.transform = 'translate(calc(-50% + ' + ((tgt.left + tgt.width / 2) - (r.left + r.width / 2)) + 'px),calc(-50% + ' + ((tgt.top + tgt.height / 2) - (r.top + r.height / 2)) + 'px)) scale(.3)';
            e.style.opacity = '0';
          }
        }, fire);
      }
    } else { if (!tb._crumple) tog(tb, 'on', false); collectKey = null; }
  }

  /* ---------------- header / banners / popups ---------------- */
  function renderTop(st) {
    var ms = me(), mt = team(ms), ot = mt === 'A' ? 'B' : 'A', cb = st.currentBid;
    setText($('roundNum'), String(st.handNumber));
    setText($('scoreA'), String(st.matchScore[mt])); setText($('scoreB'), String(st.matchScore[ot]));
    var dn = st.seats[st.dealer]; setText($('dealerDisplay'), dn ? dn.name : '—');
    setText($('teamPointsDisplay'), (st.teamPoints ? st.teamPoints[mt] : 0) + ' - ' + (st.teamPoints ? st.teamPoints[ot] : 0));
    var bd = '—';
    if (cb) { var bn = st.seats[cb.seat]; bd = (bn ? bn.name + ' ' : '') + ctx.formatBid(cb); }
    setText($('bidderDisplay'), bd);
    var chip = $('trumpChip');
    if (cb && st.phase !== 'bidding') {
      var t = cb.kind === 'suit' || cb.trump ? SYM[cb.trump] + ' Trump' : (cb.kind === 'ns' ? 'No Suit' : 'No Trump');
      once('chip', t + cb.value + st.doubled + ':' + cb.seat, function () { var bn2 = st.seats[cb.seat]; chip.textContent = (bn2 ? (cb.seat === ctx.mySeat() ? 'You' : bn2.name) + ' · ' : '') + cb.value + ' · ' + t + (st.doubled ? (st.doubled === 2 ? ' · Redoubled' : ' · Doubled') : ''); });
      show(chip, true);
    } else show(chip, false);
    renderLastTrick(st);
  }
  function ltCards(cards, win) {
    return cards.map(function (tc) {
      var c = tc.card, col = RED[c.s] ? '#c0392b' : '#111';
      return '<div class="lt-card' + (tc.seat === win ? ' lt-card-won' : '') + '"><span class="ltr" style="color:' + col + '">' + c.r + '</span><span class="lts" style="color:' + col + '">' + SYM[c.s] + '</span></div>';
    }).join('');
  }
  function renderLastTrick(st) {
    var el = $('lastTrickContent'), hi = $('lastTrickHistory'); if (!el) return;
    var log = st.tricksLog || [], ms = ctx.mySeat();
    var nm = function (i) { var q = st.seats[i]; return i === ms ? 'You' : (q ? q.name : 'Seat ' + i); };
    var key = log.length + ':' + (log.length ? log[log.length - 1].winnerSeat : '');
    once('lt', key, function () {
      if (!log.length || !log[log.length - 1].cards || !log[log.length - 1].cards.length) { el.innerHTML = '<div class="lt-empty">None yet</div>'; if (hi) hi.innerHTML = ''; return; }
      var lt = log[log.length - 1];
      el.innerHTML = '<div class="lt-cards">' + ltCards(lt.cards, lt.winnerSeat) + '</div><div class="lt-win">' + esc(nm(lt.cards[0].seat)) + ' ➜ ' + esc(nm(lt.winnerSeat)) + ' +' + lt.points + 'pt</div>';
      if (hi) hi.innerHTML = '<div class="lt-history-title">Played so far this round</div>' + log.map(function (t, i) {
        return '<div class="lt-history-row"><span class="lt-history-num">#' + (i + 1) + '</span>' + ltCards(t.cards, t.winnerSeat) + '<span class="lt-history-win">' + esc(nm(t.winnerSeat)) + ' +' + t.points + '</span></div>';
      }).join('');
    });
  }
  /* the mic button sits on the top-left corner of the bid popup so it looks like part of it */
  function dockMic(b) {
    var m = document.getElementById('k28vBtn'); if (!m) return;
    if (!b || b.style.display === 'none') { m.classList.remove('k28v-docked'); m.style.removeProperty('left'); m.style.removeProperty('top'); return; }
    var r = b.getBoundingClientRect();
    m.classList.add('k28v-docked');
    m.style.setProperty('left', Math.round(r.left - 16) + 'px', 'important');
    m.style.setProperty('top', Math.round(r.top - 16) + 'px', 'important');
  }
  function renderBanners(st) {
    var ms = ctx.mySeat(), b = $('bidStatusBanner6p'), cb = st.currentBid;
    if (st.phase === 'bidding') {
      var html;
      if (cb) html = '<b>' + esc((st.seats[cb.seat] || {}).name) + '</b> holds <b>' + esc(ctx.formatBid(cb)) + '</b>' + (st.doubled ? (st.doubled === 2 ? ' · Redoubled' : ' · Doubled') : '');
      else html = 'Bidding has started — no bids yet.';
      var ts = st.seats[st.turn];
      html += '<span class="bsb-turn">' + (st.turn === ms ? 'Your turn' : esc(ts ? ts.name : '') + "'s turn") + '</span>';
      if (st.lastNote && st.lastNote.text) html += '<span style="display:block;margin-top:3px;font-style:italic;color:#e8d9a8">' + esc((st.seats[st.lastNote.seat] || {}).name) + ': “' + esc(st.lastNote.text) + '”</span>';
      once('banner', html, function () { b.innerHTML = html; });
      var bm = st.turn === ms, bp = !bm && st.turn != null && team(st.turn) === team(me());
      tog(b, 'bsb-mine', bm); tog(b, 'bsb-partner', bp); tog(b, 'bsb-opp', !bm && !bp);
      show(b, !(st.turn === ms));   /* your own bid sheet already says all this */
      /* sits in the empty space above the top player's head (not over the table), like the trick popup */
      var placeBid = function () {
        if (b.style.display === 'none') return;
        var inv = $('btnInvite'), bh = b.offsetHeight, topEdge;
        var ir = inv && inv.getBoundingClientRect();
        topEdge = ir && ir.height ? ir.bottom + 10 : window.innerHeight * 0.17;
        b.style.setProperty('top', (topEdge + bh / 2) + 'px', 'important');
        dockMic(b);
      };
      placeBid(); setTimeout(placeBid, 250); setTimeout(placeBid, 900);
    } else { show(b, false); dockMic(null); }

    // winner bubble: from auction close until the first card lands
    var bub = $('bidWinnerBubble6p');
    var nobody = !(st.table && st.table.length) && !(st.tricksLog && st.tricksLog.length);
    var on = cb && (st.phase === 'auctionClosed' || (st.phase === 'playing' && nobody));
    if (on) {
      var wn = ms === cb.seat ? 'You' : (st.seats[cb.seat] || {}).name;
      var k = st.handNumber + ':' + cb.seat + ':' + cb.value + ':' + st.doubled;
      if (winnerKey !== k) {
        winnerKey = k;
        bub.innerHTML = '<div class="bwb-name">' + esc(wn) + ' won the bid</div><div class="bwb-bid">' + esc(ctx.formatBid(cb)) + '</div><div class="bwb-turn" id="bwbTurnLine"></div>';
        bub.style.display = 'block'; bub.classList.remove('leaving', 'settled');
        bub.style.animation = 'none'; void bub.offsetWidth; bub.style.animation = '';
        setTimeout(function () { bub.classList.add('settled'); }, 650);
      }
      var ln = $('bwbTurnLine'), ls = st.seats[st.turn], txt = '';
      if (st.phase === 'auctionClosed') { var lead = st.seats[(st.dealer + 1) % 6]; txt = (lead ? lead.name : '') + ' leads first…'; }
      else txt = st.turn === ms ? 'Your turn to play' : (ls ? ls.name + "'s turn to play" : '');
      var lpart = st.turn != null && st.turn !== ms && team(st.turn) === team(me());
      if (ln) { setText(ln, txt); tog(ln, 'bwb-turn-mine', st.turn === ms); tog(ln, 'bwb-turn-partner', lpart); tog(ln, 'bwb-turn-opp', st.turn != null && st.turn !== ms && !lpart); }
      var okSide = st.turn === ms || (st.turn != null && team(st.turn) === team(me()));
      tog(bub, 'bwb-border-mine', okSide); tog(bub, 'bwb-border-other', !okSide);
    } else if (bub.style.display !== 'none') {
      winnerKey = null; bub.style.display = 'none'; bub.classList.remove('leaving', 'settled');
    }
  }
  var nextTimer = null;
  function renderResult(st) {
    var ov = $('res56'), box = $('res56Box');
    if (st.phase !== 'handEnd' || !st.currentBid) { tog(ov, 'on', false); resultKey = null; clearTimeout(nextTimer); return; }
    var ms = ctx.mySeat(), b = st.currentBid, bt = team(b.seat), dt = bt === 'A' ? 'B' : 'A';
    var made = st.teamPoints[bt] >= b.value;
    var lab = ctx.relTeam(b.seat), oppLab = lab === 'Team' ? 'Opp' : 'Team';
    var iWon = (lab === 'Team' && made) || (lab === 'Opp' && !made);
    var key = [st.handNumber, st.matchOver, st.matchWinner, st.teamPoints[bt], st.teamPoints[dt]].join(':');
    tog(ov, 'on', true);
    if (resultKey === key) return;
    resultKey = key;
    var col = iWon ? '#3ddc84' : '#ef6b6b';
    box.style.setProperty('--rc', col); box.style.setProperty('--rg', 'transparent'); box.classList.toggle('r56-win', !!iWon); box.classList.toggle('r56-lose', !iWon);
    var mt = ms != null ? team(ms) : 'A', ot = mt === 'A' ? 'B' : 'A';
    var detail = esc(lab) + ' bid ' + esc(ctx.formatBid(b)) + (st.doubled ? (st.doubled === 2 ? ' (redoubled)' : ' (doubled)') : '') + ' — ' + (made ? 'made it' : 'fell short');
    var html;
    if (st.matchOver) {
      var mw = ms != null && st.matchWinner === mt;
      box.style.setProperty('--rc', mw ? '#f4c430' : '#ef6b6b');
      html = '<div class="r56-icon">🏆</div><div class="r56-title">' + (mw ? 'Your team wins the match!' : 'Opp wins the match') + '</div><div class="r56-sub">' + detail + '</div>' +
        '<div class="r56-pts"><div><span>Team</span><b>' + st.matchScore[mt] + '</b></div><div><span>Opp</span><b>' + st.matchScore[ot] + '</b></div></div>' +
        '<button class="r56-main gold" id="resNew">Start New Match</button>';
    } else {
      html = '<div class="r56-icon">' + (iWon ? '🎉' : '😔') + '</div><div class="r56-title">' + (iWon ? 'You Won!' : 'You Lost') + '</div><div class="r56-sub">' + detail + '</div>' +
        '<div class="r56-pts"><div><span>' + esc(lab) + ' collected</span><b style="color:' + (made ? '#3ddc84' : '#ef6b6b') + '">' + st.teamPoints[bt] + '</b></div><div><span>' + esc(oppLab) + ' collected</span><b>' + st.teamPoints[dt] + '</b></div></div>' +
        '<div class="r56-sub" style="margin-bottom:6px">Tables remaining — Team <b style="color:#fff">' + st.matchScore[mt] + '</b> | Opp <b style="color:#fff">' + st.matchScore[ot] + '</b></div>' +
        (ms != null ? '<div class="r56-sig"><div class="t">💬 Signal your team for next hand</div><div class="bs"><button data-sig="same">🔁 Same</button><button data-sig="higher">⬆️ More</button><button data-sig="lower">⬇️ Less</button></div><div class="n" id="resSigNote"></div></div>' : '') +
        '';
    }
    box.innerHTML = html;
    clearTimeout(nextTimer);
    if (!st.matchOver) nextTimer = setTimeout(function () { ctx.send('l56_nextHand', {}); }, 4500);   // no button: moves on by itself
    var nm = box.querySelector('#resNew'); if (nm) nm.onclick = function () { ctx.send('l56_startNewMatch', {}); };
    box.querySelectorAll('[data-sig]').forEach(function (btn) {
      btn.onclick = function () {
        ctx.signal(btn.dataset.sig);
        box.querySelectorAll('[data-sig]').forEach(function (x) { x.classList.remove('sent'); });
        btn.classList.add('sent');
        var n = box.querySelector('#resSigNote'); if (n) n.textContent = '✓ Signaled: ' + btn.textContent.replace(/^\S+\s/, '');
      };
    });
  }

  function render(st) {
    if (!host) return;
    lastState = st;
    if (host.hidden) host.hidden = false;
    sizeClass(); applySizes();
    renderTop(st); renderSeats(st); renderTrick(st); renderHand(st); renderBanners(st); renderBid(st, false); renderResult(st);
  }
  function hide() { if (host && !host.hidden) { host.hidden = true; cache = {}; winnerKey = null; resultKey = null; } }


  var DRINKS = [['🥂','a glass'],['🧋','bubble tea'],['🥤','red soda water'],['🥤','blue soda water'],['☕','coffee'],['🍵','tea'],['🧃','juice'],['🍋','lemonade'],['🍷','a toast'],['🍺','a cold one'],['🍾','a celebration'],['🥃','the good stuff']];
  function cheers(fromPos, toPos, fromName, toName) {
    if (!root) return;
    var d = DRINKS[Math.floor(Math.random() * DRINKS.length)];
    var iSend = fromPos === me();
    var msg = iSend ? 'You sent ' + (toName || 'them') + ' ' + d[1] + '! Cheers!' : (fromName || 'Someone') + ' toasted you with ' + d[1] + ' — Cheers!';
    var fe = $('av' + slotOf(fromPos)), te = $('av' + slotOf(toPos));
    function land(x, y) {
      var b = document.createElement('div');
      b.innerHTML = '<div style="font-size:1.5rem;line-height:1;margin-bottom:4px">' + d[0] + '</div><div></div>';
      b.lastChild.textContent = msg;
      b.style.cssText = 'position:fixed;left:' + x + 'px;top:' + y + 'px;transform:translate(-50%,-50%);background:#0b1220;color:#f4c430;font-weight:700;font-size:.8rem;width:max-content;min-width:170px;padding:10px 16px;border-radius:12px;border:2px solid #f4c430;z-index:9500;text-align:center;max-width:70vw;pointer-events:none;opacity:0;transition:opacity .25s';
      document.body.appendChild(b);
      requestAnimationFrame(function () { b.style.opacity = '1'; });
      setTimeout(function () { b.style.opacity = '0'; setTimeout(function () { b.remove(); }, 300); }, 2000);
    }
    if (fe && te) {
      var a = fe.getBoundingClientRect(), z = te.getBoundingClientRect();
      var fx = a.left + a.width / 2, fy = a.top + a.height / 2, tx = z.left + z.width / 2, ty = z.top + z.height / 2;
      var f = document.createElement('div'); f.textContent = d[0];
      f.style.cssText = 'position:fixed;left:' + fx + 'px;top:' + fy + 'px;font-size:1.4rem;transform:translate(-50%,-50%);z-index:9500;pointer-events:none;transition:left .55s ease,top .55s ease';
      document.body.appendChild(f);
      requestAnimationFrame(function () { f.style.left = tx + 'px'; f.style.top = (ty - 30) + 'px'; });
      setTimeout(function () { f.remove(); land(tx, ty); }, 550);
    } else land(window.innerWidth / 2, window.innerHeight * 0.42);
  }

  window.K56UI = { cheers: cheers, mount: mount, render: render, hide: hide, shadow: function () { return root; }, host: function () { return host; } };
})();
