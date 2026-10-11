/* Gentle "install the app" prompt (Android/desktop Chrome + iPhone/iPad). Never during a game, never twice in one visit,
   snoozed 7 days after the first "Not now", 21 days after the second, and stops for good after the third. */
(function () {
  'use strict';
  var KEY = 'k28.install.v1';
  function load() { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; } }
  function save(s) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) {} }
  var st = load();
  var ua = navigator.userAgent || '';
  var standalone = (window.matchMedia && (matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches)) || navigator.standalone === true;
  if (standalone) return;                                              // already running as the installed app
  if (/FBAN|FBAV|Instagram|Line\/|MicroMessenger|Snapchat|; wv\)/i.test(ua)) return;   // in-app browsers can't install
  var isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (!isIOS && !/Android|Windows|Macintosh|Linux|CrOS/i.test(ua)) return;
  try { if (!sessionStorage.getItem('k28.install.counted')) { sessionStorage.setItem('k28.install.counted', '1'); st.visits = (st.visits || 0) + 1; save(st); } } catch (e) {}
  if (st.installed || (st.dismissals || 0) >= 3) return;

  var deferred = null, shownThisVisit = false, t0 = Date.now(), card = null, taps = 0;
  document.addEventListener('pointerdown', function () { taps++; }, { passive: true });
  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); deferred = e; });
  window.addEventListener('appinstalled', function () { st.installed = 1; save(st); hide(); });

  function inGame() { return document.body && document.body.classList.contains('k28-in-game'); }
  function vis(el) { return !!el && getComputedStyle(el).display !== 'none' && el.getClientRects().length > 0; }
  function lobbyVisible() { return vis(document.getElementById('welcomeScreen')) || vis(document.getElementById('lobbyScreen')); }
  // Don't pile on top of another popup (welcome box, "just updated" toast, leaderboard...): look at what's sitting over the middle and the bottom.
  function busy() {
    var pts = [[innerWidth / 2, innerHeight / 2], [innerWidth / 2, innerHeight - 60], [innerWidth / 2, innerHeight - 160]];
    return pts.some(function (p) {
      var el = document.elementFromPoint(p[0], p[1]);
      while (el && el !== document.body && el !== document.documentElement) {
        if (el.id === 'welcomeScreen' || el.id === 'lobbyScreen' || el.id === 'appPhoneFrame' || el.id === 'k28iCard') { el = el.parentElement; continue; }
        var cs = getComputedStyle(el);
        if (cs.position === 'fixed' && (parseInt(cs.zIndex, 10) || 0) >= 50) return true;
        el = el.parentElement;
      }
      return false;
    });
  }
  function eligible() {
    if (shownThisVisit || !document.body || document.hidden) return false;
    if (st.snoozeUntil && Date.now() < st.snoozeUntil) return false;
    if (isIOS) return false;                       // the site already shows its own one-time "Add to Home Screen" tip on iPhone; avoid a second nag
    if (!deferred) return false;
    if (!((st.visits || 0) >= 2 || Date.now() - t0 > 45000)) return false;   // let people play first
    return taps >= 2 && !inGame() && lobbyVisible() && !busy();   // after the welcome box is dismissed and they've tapped around a little
  }
  function dismiss() {
    st.dismissals = (st.dismissals || 0) + 1;
    st.snoozeUntil = Date.now() + (st.dismissals === 1 ? 7 : 21) * 86400000;
    save(st); hide();
  }
  function hide() { if (card && card.parentNode) card.parentNode.removeChild(card); card = null; var s = document.getElementById('k28iSheet'); if (s) s.remove(); }
  function css() {
    if (document.getElementById('k28iCss')) return;
    var s = document.createElement('style'); s.id = 'k28iCss';
    s.textContent = '#k28iCard{position:fixed;left:50%;bottom:max(14px,env(safe-area-inset-bottom));transform:translate(-50%,30px);opacity:0;transition:all .35s cubic-bezier(.2,.9,.3,1.2);z-index:2900;width:min(94vw,420px);box-sizing:border-box;display:flex;align-items:center;gap:12px;padding:10px 12px;border-radius:16px;background:linear-gradient(180deg,#14213d,#0a1628);border:1.5px solid rgba(244,196,48,.55);box-shadow:0 10px 30px rgba(0,0,0,.6);font-family:Inter,system-ui,sans-serif;color:#fff}' +
      '#k28iCard.on{transform:translate(-50%,0);opacity:1}#k28iCard img{width:46px;height:46px;border-radius:11px;flex:none}' +
      '#k28iCard .t{flex:1;min-width:0}#k28iCard b{display:block;font-size:.92rem;color:#f4c430}#k28iCard span{display:block;font-size:.72rem;opacity:.8;line-height:1.25}' +
      '#k28iCard button{border:0;cursor:pointer;font-weight:800;font-family:inherit}#k28iGo{background:linear-gradient(180deg,#f7d56a,#e0a912);color:#2a1a00;border-radius:10px;padding:9px 14px;font-size:.82rem}#k28iNo{background:transparent;color:#9fb0c8;font-size:.7rem;padding:6px 4px}' +
      '#k28iSheet{position:fixed;inset:0;z-index:3000;background:rgba(0,0,0,.6);display:flex;align-items:flex-end;justify-content:center}#k28iSheet .box{width:min(100vw,460px);box-sizing:border-box;background:#0a1628;border-top:2px solid #f4c430;border-radius:20px 20px 0 0;padding:20px 20px max(22px,env(safe-area-inset-bottom));color:#fff;font-family:Inter,system-ui,sans-serif}' +
      '#k28iSheet h3{margin:0 0 12px;color:#f4c430;font-size:1.05rem}#k28iSheet ol{margin:0 0 16px;padding-left:20px;font-size:.9rem;line-height:1.7}#k28iSheet svg{vertical-align:middle;margin:0 2px}#k28iSheet button{width:100%;border:0;border-radius:12px;padding:12px;background:#f4c430;color:#2a1a00;font-weight:800;font-size:.95rem}';
    document.head.appendChild(s);
  }
  var SHARE = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#4aa3ff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M8 7l4-4 4 4M5 12v8h14v-8"/></svg>';
  function sheet() {
    var d = document.createElement('div'); d.id = 'k28iSheet';
    d.innerHTML = '<div class="box"><h3>Add 28 Gulan to your Home Screen</h3><ol><li>Tap the Share button ' + SHARE + ' (bottom of Safari, or top right)</li><li>Scroll down and tap <b>Add to Home Screen</b></li><li>Tap <b>Add</b>. Done!</li></ol><button>Got it</button></div>';
    d.onclick = function (e) { if (e.target === d || e.target.tagName === 'BUTTON') d.remove(); };
    document.body.appendChild(d);
  }
  function show() {
    css(); shownThisVisit = true;
    card = document.createElement('div'); card.id = 'k28iCard';
    card.innerHTML = '<img src="/icon-192.png" alt=""><div class="t"><b>Get the 28 Gulan app</b><span>' + (isIOS ? 'Full screen, one tap from your Home Screen' : 'Full screen, no address bar, one tap from your home screen') + '</span></div><button id="k28iGo">' + (isIOS ? 'How?' : 'Install') + '</button><button id="k28iNo" aria-label="Not now">Not now</button>';
    document.body.appendChild(card);
    requestAnimationFrame(function () { requestAnimationFrame(function () { card.classList.add('on'); }); });
    card.querySelector('#k28iNo').onclick = dismiss;
    card.querySelector('#k28iGo').onclick = function () {
      if (isIOS || !deferred) { sheet(); return; }
      var p = deferred; deferred = null; hide();
      p.prompt(); p.userChoice.then(function (r) { if (r && r.outcome === 'accepted') { st.installed = 1; save(st); } else dismiss(); }).catch(function () {});
    };
  }
  var timer = setInterval(function () { if (shownThisVisit) return clearInterval(timer); if (eligible()) show(); }, 4000);
  window.k28ShowInstall = function () { if (isIOS || deferred) { shownThisVisit = false; st.snoozeUntil = 0; show(); } };   // for a manual "Install app" link
})();
