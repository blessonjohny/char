// ============================================================================
// teach-info.js -- the short "Learn more" popup for "Teach my partner" (28 four-player + six-player lobbies).
//   K28TeachInfo.open('4p' | '6p')
// Also makes every  a.k28-teach-more  link blink (gently; not at all if the device asks for reduced motion).
// ============================================================================
(function () {
  'use strict';
  var st = document.createElement('style');
  st.textContent =
    '@keyframes k28TeachBlink{0%,100%{opacity:1}50%{opacity:.25}}' +
    'a.k28-teach-more{display:inline-block;margin-top:6px;font-size:.78rem;font-weight:800;color:#f7e09a;text-decoration:underline;cursor:pointer;animation:k28TeachBlink 1.1s ease-in-out infinite}' +
    '@media (prefers-reduced-motion:reduce){a.k28-teach-more{animation:none}}';
  document.head.appendChild(st);

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  function row(icon, title, text) {
    return '<div style="display:flex;gap:10px;margin-bottom:11px"><div style="font-size:1.15rem;line-height:1.3;flex-shrink:0">' + icon + '</div>' +
      '<div style="font-size:.84rem;line-height:1.45"><b style="color:#f7e09a">' + esc(title) + '</b><br><span style="opacity:.9">' + text + '</span></div></div>';
  }

  function open(mode) {
    if (document.getElementById('k28TeachInfoOverlay')) return;
    var six = mode === '6p';
    var ov = document.createElement('div');
    ov.id = 'k28TeachInfoOverlay';
    ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true');
    ov.style.cssText = 'position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(5,2,14,.82);-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif';
    var learns = six
      ? 'Your two mates (Mate 1 and Mate 2) copy how you <b>bid</b>, which <b>trump</b> you pick, and how you <b>lead</b> and <b>feed points</b> to a winning partner.'
      : 'Your partner bot copies how you <b>bid</b>, which <b>trump</b> you pick, and how you <b>lead</b> and <b>feed points</b> to a winning partner.';
    ov.innerHTML =
      '<div style="max-width:390px;width:100%;max-height:92vh;overflow:auto;background:linear-gradient(160deg,#2a1257,#12062b);border:2px solid #d4a62a;border-radius:18px;padding:20px 20px 16px;color:#efe7fb;box-shadow:0 18px 50px rgba(0,0,0,.6)">' +
      '<div style="font-size:1.2rem;font-weight:800;color:#f7e09a;margin-bottom:12px">🧠 Teach my ' + (six ? 'mates' : 'partner bot') + '</div>' +
      row('🎓', 'What it does', learns) +
      row('📈', 'Gets better as you play', 'It learns after every round. After about 10 hands you’ll see how often it makes the same call as you on bidding, trump and card play.') +
      row('🙈', 'Your cards stay private', 'Nobody — bot or human — ever sees your hand. It only saves simple numbers about your habits, never the actual cards you were dealt.') +
      row('🛡️', 'Plays safe', 'If it over-bids twice, it plays a little safer for a few rounds, then goes back to your style.') +
      (six ? row('🔁', 'Seat taken?', 'If someone sits in a Mate seat and later leaves, it goes back to your learning bot.') : '') +
      '<div id="k28TeachInfoAcct" style="margin:14px 0 4px;padding:10px 12px;border-radius:12px;background:rgba(247,224,154,.09);border:1px solid rgba(247,224,154,.3);font-size:.82rem;line-height:1.45">Checking your account…</div>' +
      '<div style="display:flex;gap:10px;margin-top:14px">' +
      '<button type="button" id="k28TeachInfoSign" style="display:none;flex:1;padding:12px;border-radius:99px;border:1px solid rgba(247,224,154,.5);background:transparent;color:#f7e09a;font-weight:700;font-size:.9rem;cursor:pointer">Sign in</button>' +
      '<button type="button" id="k28TeachInfoOk" style="flex:1.4;padding:12px;border-radius:99px;border:0;background:linear-gradient(180deg,#f7e09a,#d4a62a);color:#12062b;font-weight:800;font-size:.95rem;cursor:pointer">Got it</button>' +
      '</div></div>';
    document.body.appendChild(ov);
    function close() { if (ov.parentNode) ov.parentNode.removeChild(ov); document.removeEventListener('keydown', onKey, true); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey, true);
    ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
    ov.querySelector('#k28TeachInfoOk').addEventListener('click', close);

    var acct = ov.querySelector('#k28TeachInfoAcct'), signBtn = ov.querySelector('#k28TeachInfoSign');
    function guestMsg() {
      acct.innerHTML = '<b style="color:#f7e09a">Guest:</b> your bot is saved on this device for 30 days after you last play (and is lost if you clear your browser data).<br>' +
        '<b style="color:#f7e09a">Signed in:</b> it’s saved to your account for good and follows you to any device. Free.';
      var a = window.__k28Account;
      if (a && a.openAuth) {
        signBtn.style.display = 'block';
        signBtn.onclick = function () { close(); a.openAuth('in'); };
      }
    }
    fetch('/api/account/socket-token', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (j) {
      if (j && j.ok) acct.innerHTML = '✅ <b style="color:#f7e09a">You’re signed in</b> — your ' + (six ? 'mates are' : 'partner bot is') + ' saved to your account and follow you to any device. Switch Teach on once and it stays on every time you play. Your bots are named with the first 3 letters of whatever name you play under, so nobody can tell which account they belong to.';
      else guestMsg();
    }).catch(guestMsg);
  }

  window.K28TeachInfo = { open: open };
})();
