/* account.js -- optional player accounts (sign in, saved name + avatar).
 * Loaded by index.html, play6.html, 56.html and holdem.html.
 *   - On every page: if the player is signed in, their saved name and avatar are filled in
 *     (so they skip the "type a name / pick an avatar" step), and window.__k28Account.openAuth()
 *     opens the sign-in dialog (used by the voice chat button).
 *   - On index.html only: a small "Sign in" pill and the nudge line.
 * Guests are never interrupted: nothing here opens by itself except the links people click in
 * their confirmation / reset emails.
 */
(function () {
  'use strict';
  if (window.__k28Account) return;
  var IS_HOME = !!document.getElementById('welcomeScreen');
  var cfg = { google: null, open: true, max: 100, mail: true };
  var me = null;

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function api(method, url, body) {
    var o = { method: method, credentials: 'same-origin', headers: { 'x-k28': '1' } };
    if (body !== undefined) { o.headers['content-type'] = 'application/json'; o.body = JSON.stringify(body); }
    return fetch(url, o).then(function (r) { return r.json().catch(function () { return { ok: false, error: 'server_error' }; }); })
      .catch(function () { return { ok: false, error: 'network' }; });
  }
  var ERR = {
    bad_login: 'Wrong email or password.', unverified: 'Please confirm your email first -- check your inbox.',
    exists: 'That email already has an account. Try signing in.', bad_email: 'That email address does not look right.',
    bad_password: 'Password must be 8 to 100 characters.', bad_name: 'Please enter your name.', need_agree: 'Please tick the box to continue.',
    name_not_allowed: 'That name is not allowed. Please pick another.', name_taken: 'Another player already uses that name.',
    bad_player_name: 'Player name needs 2 to 12 characters.', full: 'Sorry, we are full for now. You can still play as a guest!',
    too_many: 'Too many tries. Please wait a little and try again.', disabled: 'This account is switched off. Contact the site owner.',
    mail_not_configured: 'Email sign-up is not switched on yet. Please play as a guest for now.', network: 'No connection. Please try again.',
    bad_token: 'That link has expired. Please ask for a new one.', bad_image: 'That picture could not be used. Try a different one.',
    too_big: 'That picture is too big. Try a smaller one.', no_converter: 'Your browser could not prepare that picture. Try another browser.',
    google_unreachable: 'Could not reach Google. Try again.', google_not_configured: 'Google sign-in is not switched on yet.', server_error: 'Something went wrong. Please try again.'
  };
  function errText(code) { return ERR[code] || ERR.server_error; }
  function toast(msg) {
    try { if (typeof showToast === 'function') { showToast(msg, 'info', 3500); return; } } catch (e) {}
    var t = document.createElement('div'); t.className = 'k28a-toast'; t.textContent = msg; document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 3800);
  }

  /* ------------------------------------------------------------------ apply saved profile everywhere */
  function setPickerSelection(key) {
    document.querySelectorAll('.my-avatar-choice[data-key]').forEach(function (el) { el.classList.toggle('picked', el.dataset.key === key); });
  }
  function chooseAvatar(key) {
    try { localStorage.setItem('k28_player_avatar', key); } catch (e) {}
    try { if (typeof MY_AVATAR_KEY !== 'undefined') MY_AVATAR_KEY = key; } catch (e) {}
    try { if (typeof myAvatar !== 'undefined') myAvatar = key; } catch (e) {}
    setPickerSelection(key);
  }
  function addPhotoToPickers() {
    var key = me && me.photoKey; if (!key) return;
    document.querySelectorAll('.my-avatar-picker').forEach(function (box) {
      if (box.querySelector('[data-k28a-photo]')) return;
      var d = document.createElement('div');
      d.className = 'my-avatar-choice' + (me.avatar === key ? ' picked' : '');
      d.dataset.key = key; d.setAttribute('data-k28a-photo', '1');
      d.innerHTML = '<img src="/images/hero-avatars/' + key + '.png" alt="" decoding="async">';
      d.addEventListener('click', function () { chooseAvatar(key); });
      box.insertBefore(d, box.firstChild);
    });
  }
  function apply() {
    if (!me) return;
    if (me.playerName) {
      try { localStorage.setItem('k28_player_name', me.playerName); } catch (e) {}
      try { if (typeof MY_NAME !== 'undefined' && !MY_NAME) MY_NAME = me.playerName; } catch (e) {}
      ['playerNameInput', 'nameInput'].forEach(function (id) { var el = $(id); if (el && !el.value) el.value = me.playerName; });
    }
    if (me.avatar) chooseAvatar(me.avatar);
    addPhotoToPickers();
  }
  function watchPickers() {
    document.querySelectorAll('.my-avatar-picker').forEach(function (box) {
      if (box.__k28a) return; box.__k28a = true;
      new MutationObserver(function () { if (me) { addPhotoToPickers(); if (me.avatar) setPickerSelection(me.avatar); } }).observe(box, { childList: true });
    });
  }
  function setMe(u) {
    me = u || null;
    if (me) me.photoKey = me.photo || null;
    apply(); watchPickers(); renderPill(); renderNudge();
  }
  function loadMe() {
    return api('GET', '/api/account/me').then(function (r) {
      var u = r && r.ok ? r.user : null;
      setMe(u); return u;
    });
  }
  function keepPhotoKey(u) { return u; }

  /* ------------------------------------------------------------------ styles */
  var css = document.createElement('style');
  css.textContent =
    '.k28a-pill{position:fixed;top:10px;right:10px;z-index:1450;display:flex;align-items:center;gap:7px;max-width:56vw;padding:6px 13px 6px 8px;border-radius:999px;border:1.5px solid rgba(255,215,0,.55);background:rgba(26,18,10,.78);color:#ffe9a8;font:600 .8rem/1 system-ui,sans-serif;cursor:pointer;backdrop-filter:blur(4px);box-shadow:0 2px 10px rgba(0,0,0,.4)}' +
    '.k28a-pill:active{transform:scale(.96)}.k28a-pill img{width:26px;height:26px;border-radius:50%;object-fit:cover;background:#3a2a18;flex-shrink:0}' +
    '.k28a-pill span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
    '.k28a-nudge{margin:6px 0 0;font-size:.74rem;color:#e8d3a2;opacity:.9;text-align:center}.k28a-nudge a{color:#ffd700;text-decoration:underline;cursor:pointer}' +
    '.k28a-ov{position:fixed;inset:0;z-index:2147482000;background:rgba(0,0,0,.72);display:flex;align-items:center;justify-content:center;padding:14px;overflow-y:auto}' +
    '.k28a-box{width:100%;max-width:380px;max-height:94vh;overflow-y:auto;background:linear-gradient(160deg,#2b1f14,#1b130b);border:1.5px solid rgba(255,215,0,.5);border-radius:16px;padding:20px 18px;color:#f5ead0;font-family:system-ui,sans-serif;box-shadow:0 12px 40px rgba(0,0,0,.6);position:relative}' +
    '.k28a-box h2{margin:0 0 4px;font-size:1.2rem;color:#ffd700;text-align:center}.k28a-sub{margin:0 0 14px;font-size:.8rem;color:#cdbb92;text-align:center}' +
    '.k28a-x{position:absolute;top:8px;right:10px;background:none;border:0;color:#cdbb92;font-size:1.5rem;cursor:pointer;line-height:1}' +
    '.k28a-tabs{display:flex;gap:6px;margin-bottom:14px}.k28a-tabs button{flex:1;padding:9px 4px;border-radius:9px;border:1px solid rgba(255,215,0,.3);background:transparent;color:#cdbb92;font-weight:700;font-size:.85rem;cursor:pointer}' +
    '.k28a-tabs button.on{background:rgba(255,215,0,.16);color:#ffd700;border-color:rgba(255,215,0,.7)}' +
    '.k28a-in{width:100%;box-sizing:border-box;margin:0 0 9px;padding:11px 12px;border-radius:9px;border:1px solid rgba(255,255,255,.22);background:rgba(0,0,0,.35);color:#fff;font-size:16px;outline:none}.k28a-in:focus{border-color:#ffd700}' +
    '.k28a-btn{width:100%;padding:12px;border-radius:10px;border:0;background:linear-gradient(180deg,#ffd84a,#d4a512);color:#2a1d05;font-weight:800;font-size:.95rem;cursor:pointer;margin-top:2px}.k28a-btn:disabled{opacity:.55}' +
    '.k28a-btn.alt{background:transparent;border:1px solid rgba(255,215,0,.5);color:#ffd700}.k28a-btn.dng{background:transparent;border:1px solid #d9534f;color:#ff8a85}' +
    '.k28a-err{min-height:1.1em;margin:2px 0 8px;font-size:.78rem;color:#ff8a85;text-align:center}.k28a-ok{color:#8fe3a0}' +
    '.k28a-link{background:none;border:0;color:#ffd700;text-decoration:underline;cursor:pointer;font-size:.8rem;padding:4px}' +
    '.k28a-or{display:flex;align-items:center;gap:8px;color:#9c8a62;font-size:.72rem;margin:10px 0}.k28a-or:before,.k28a-or:after{content:"";flex:1;height:1px;background:rgba(255,255,255,.15)}' +
    '.k28a-agree{display:flex;gap:8px;align-items:flex-start;font-size:.74rem;color:#cdbb92;margin:2px 0 10px;line-height:1.35}.k28a-agree input{margin-top:2px;flex-shrink:0}.k28a-agree a{color:#ffd700}' +
    '.k28a-av{display:flex;align-items:center;gap:12px;margin-bottom:12px}.k28a-av img{width:76px;height:76px;border-radius:50%;object-fit:cover;border:2.5px solid #ffd700;background:#3a2a18;flex-shrink:0}' +
    '.k28a-grid{display:grid;grid-template-columns:repeat(auto-fill,52px);gap:7px;justify-content:center;max-height:190px;overflow-y:auto;padding:4px;margin:6px 0 10px;border:1px solid rgba(255,255,255,.1);border-radius:10px}' +
    '.k28a-grid div{width:52px;height:52px;border-radius:50%;overflow:hidden;border:2.5px solid transparent;cursor:pointer;background:#3a2a18}.k28a-grid div.on{border-color:#ffd700;box-shadow:0 0 8px rgba(255,215,0,.6)}.k28a-grid img{width:100%;height:100%;object-fit:cover;display:block}' +
    '.k28a-lbl{font-size:.74rem;color:#cdbb92;margin:6px 0 3px;display:block}.k28a-mini{font-size:.7rem;color:#9c8a62;text-align:center;margin:10px 0 0}' +
    '.k28a-toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147482100;background:#241a12;color:#ffe9a8;border:1px solid #ffd700;padding:10px 16px;border-radius:10px;font:600 .85rem system-ui}';
  document.head.appendChild(css);

  /* ------------------------------------------------------------------ pill + nudge */
  var pill = null;
  function renderPill() {
    if (!IS_HOME) return;
    if (!pill) {
      pill = document.createElement('button'); pill.type = 'button'; pill.className = 'k28a-pill'; pill.id = 'k28aPill';
      pill.addEventListener('click', function () { me ? openProfile(false) : openAuth('in'); });
      var host = $('welcomeScreen') || document.body; host.insertBefore(pill, host.firstChild);
    }
    if (me) {
      var src = me.avatar ? '/images/hero-avatars/' + esc(me.avatar) + '.png' : '/favicon-32x32.png';
      pill.innerHTML = '<img src="' + src + '" alt=""><span>' + esc(me.playerName || me.name) + '</span>';
      pill.setAttribute('aria-label', 'My profile');
    } else {
      pill.innerHTML = '<span>👤 Sign in</span>';
      pill.setAttribute('aria-label', 'Sign in');
    }
  }
  function renderNudge() {
    if (!IS_HOME) return;
    var card = $('nameCard'), n = $('k28aNudge');
    var off = false; try { off = localStorage.getItem('k28_nudge_off') === '1'; } catch (e) {}
    if (me || off || !card) { if (n) n.remove(); return; }
    if (n) return;
    n = document.createElement('div'); n.id = 'k28aNudge'; n.className = 'k28a-nudge';
    n.innerHTML = '<a>Sign in</a> to save your name &amp; avatar for next time';
    n.querySelector('a').addEventListener('click', function () { openAuth('in'); });
    card.appendChild(n);
  }

  /* ------------------------------------------------------------------ dialog plumbing */
  var ov = null;
  function closeQuiet() { if (ov) { ov.remove(); ov = null; } }
  function close() { if (ov) { closeQuiet(); try { window.dispatchEvent(new CustomEvent('k28:authclosed')); } catch (e) {} } }
  function open(title, sub, bodyHtml, allowClose) {
    closeQuiet();
    ov = document.createElement('div'); ov.className = 'k28a-ov';
    ov.innerHTML = '<div class="k28a-box" role="dialog" aria-modal="true">' + (allowClose === false ? '' : '<button class="k28a-x" aria-label="Close">&times;</button>') +
      '<h2>' + esc(title) + '</h2>' + (sub ? '<p class="k28a-sub">' + sub + '</p>' : '') + bodyHtml + '</div>';
    var x = ov.querySelector('.k28a-x'); if (x) x.addEventListener('click', close);
    document.body.appendChild(ov);
    return ov.querySelector('.k28a-box');
  }
  function setErr(box, msg, ok) { var e = box.querySelector('.k28a-err'); if (e) { e.textContent = msg || ''; e.className = 'k28a-err' + (ok ? ' k28a-ok' : ''); } }
  function busy(btn, on, label) { if (!btn) return; if (on) { btn.dataset.t = btn.textContent; btn.textContent = label || 'Please wait...'; btn.disabled = true; } else { btn.textContent = btn.dataset.t || btn.textContent; btn.disabled = false; } }

  /* ------------------------------------------------------------------ sign in / sign up */
  var gsiLoading = null;
  function loadGsi() {
    if (window.google && google.accounts && google.accounts.id) return Promise.resolve();
    if (gsiLoading) return gsiLoading;
    gsiLoading = new Promise(function (res, rej) {
      var s = document.createElement('script'); s.src = 'https://accounts.google.com/gsi/client'; s.async = true; s.defer = true;
      s.onload = res; s.onerror = rej; document.head.appendChild(s);
    });
    return gsiLoading;
  }
  function afterLogin(u, isNew) {
    setMe(keepPhotoKey(u));
    try { window.dispatchEvent(new CustomEvent('k28:signedin')); } catch (e) {}
    var a = $('authScreen'), w = $('welcomeScreen');
    if (a && w && getComputedStyle(a).display !== 'none') { a.style.display = 'none'; w.style.display = 'flex'; }
    if (!u.playerName) openProfile(true);
    else { close(); toast('Welcome back, ' + u.playerName + '!'); }
  }
  function mountGoogle(box) {
    var slot = box.querySelector('#k28aG'); if (!slot) return;
    loadGsi().then(function () {
      google.accounts.id.initialize({
        client_id: cfg.google, ux_mode: 'popup', auto_select: false,
        callback: function (resp) {
          api('POST', '/api/auth/google', { credential: resp.credential }).then(function (r) {
            if (r.ok) afterLogin(r.user, r.isNew); else setErr(box, errText(r.error));
          });
        }
      });
      google.accounts.id.renderButton(slot, { theme: 'filled_black', size: 'large', shape: 'pill', text: 'continue_with', width: Math.min(300, slot.clientWidth || 300) });
    }).catch(function () { slot.innerHTML = ''; });
  }
  function openAuth(tab) {
    tab = tab || 'in';
    var box = open(tab === 'up' ? 'Create your account' : 'Sign in', 'Save your name &amp; avatar. Playing as a guest is always fine too.',
      '<div class="k28a-tabs"><button data-t="in" class="' + (tab === 'in' ? 'on' : '') + '">Sign in</button><button data-t="up" class="' + (tab === 'up' ? 'on' : '') + '">Create account</button></div>' +
      (cfg.google ? '<div id="k28aG" style="display:flex;justify-content:center;min-height:44px"></div><div class="k28a-or">or use email</div>' : '') +
      '<form id="k28aForm" novalidate>' +
      (tab === 'up' ? '<input class="k28a-in" name="name" placeholder="Your name" maxlength="40" autocomplete="name">' : '') +
      '<input class="k28a-in" name="email" type="email" placeholder="Email" autocomplete="email" maxlength="120">' +
      '<input class="k28a-in" name="password" type="password" placeholder="Password' + (tab === 'up' ? ' (8+ characters)' : '') + '" autocomplete="' + (tab === 'up' ? 'new-password' : 'current-password') + '" maxlength="100">' +
      (tab === 'up' ? '<label class="k28a-agree"><input type="checkbox" name="agree"><span>I agree that 28gulan.com stores my name, email and avatar to run my account. <a href="/privacy.html" target="_blank" rel="noopener">Privacy</a></span></label>' : '') +
      '<div class="k28a-err"></div><button class="k28a-btn" type="submit">' + (tab === 'up' ? 'Create account' : 'Sign in') + '</button></form>' +
      (tab === 'in' ? '<div style="text-align:center;margin-top:8px"><button class="k28a-link" id="k28aForgot" type="button">Forgot password?</button></div>' : '') +
      (!cfg.open && tab === 'up' ? '<p class="k28a-mini">We are full for now -- you can still play as a guest.</p>' : ''));
    box.querySelectorAll('.k28a-tabs button').forEach(function (b) { b.addEventListener('click', function () { openAuth(b.dataset.t); }); });
    var f = box.querySelector('#k28aForm');
    f.addEventListener('submit', function (e) {
      e.preventDefault();
      var v = function (n) { var el = f.elements[n]; return el ? el.value.trim() : ''; };
      var btn = f.querySelector('.k28a-btn'); setErr(box, '');
      if (tab === 'up') {
        if (v('name').length < 2) return setErr(box, errText('bad_name'));
        if (typeof NameFilter !== 'undefined' && NameFilter.isBad && NameFilter.isBad(v('name'))) return setErr(box, errText('name_not_allowed'));
        if (!f.elements.agree.checked) return setErr(box, errText('need_agree'));
        busy(btn, true, 'Creating...');
        api('POST', '/api/auth/signup', { name: v('name'), email: v('email'), password: f.elements.password.value, agree: true }).then(function (r) {
          busy(btn, false);
          if (!r.ok) return setErr(box, errText(r.error));
          openCheckEmail(v('email'), r.sent !== false);
        });
      } else {
        busy(btn, true, 'Signing in...');
        api('POST', '/api/auth/login', { email: v('email'), password: f.elements.password.value }).then(function (r) {
          busy(btn, false);
          if (r.ok) return afterLogin(keepPhotoKey(r.user));
          if (r.error === 'unverified') return openCheckEmail(v('email'), true, true);
          setErr(box, errText(r.error));
        });
      }
    });
    var fg = box.querySelector('#k28aForgot'); if (fg) fg.addEventListener('click', function () { openForgot(); });
    if (cfg.google) mountGoogle(box);
    setTimeout(function () { var i = f.querySelector('input'); if (i) i.focus(); }, 50);
  }
  function openCheckEmail(email, sent, fromLogin) {
    var box = open('Check your email', (fromLogin ? 'Your email is not confirmed yet. ' : '') + (sent ? 'We sent a confirmation link to <b>' + esc(email) + '</b>.' : 'We could not send the email right now.'),
      '<p class="k28a-sub">Open the email and tap <b>Confirm my email</b>. Not there? Look in Spam/Promotions.</p><div class="k28a-err"></div>' +
      '<button class="k28a-btn" id="k28aResend" type="button">Send it again</button><button class="k28a-btn alt" id="k28aDone" type="button" style="margin-top:8px">Close</button>');
    box.querySelector('#k28aDone').addEventListener('click', close);
    box.querySelector('#k28aResend').addEventListener('click', function () {
      var b = this; busy(b, true, 'Sending...');
      api('POST', '/api/auth/resend', { email: email }).then(function (r) { busy(b, false); r.ok ? setErr(box, 'Sent! Check your inbox.', true) : setErr(box, errText(r.error)); });
    });
  }
  function openForgot() {
    var box = open('Forgot password?', 'Enter your email and we will send you a link to choose a new one.',
      '<form id="k28aF2" novalidate><input class="k28a-in" name="email" type="email" placeholder="Email" autocomplete="email" maxlength="120"><div class="k28a-err"></div><button class="k28a-btn" type="submit">Send reset link</button></form>' +
      '<div style="text-align:center;margin-top:8px"><button class="k28a-link" id="k28aBack" type="button">Back to sign in</button></div>');
    box.querySelector('#k28aBack').addEventListener('click', function () { openAuth('in'); });
    box.querySelector('#k28aF2').addEventListener('submit', function (e) {
      e.preventDefault(); var em = this.elements.email.value.trim(); var btn = this.querySelector('.k28a-btn');
      busy(btn, true, 'Sending...');
      api('POST', '/api/auth/forgot', { email: em }).then(function (r) {
        busy(btn, false);
        if (r.ok) setErr(box, 'If that email has an account, a reset link is on its way. Check your inbox.', true); else setErr(box, errText(r.error));
      });
    });
  }
  function openReset(token) {
    var box = open('Choose a new password', 'Pick something you will remember (8+ characters).',
      '<form id="k28aF3" novalidate><input class="k28a-in" name="password" type="password" placeholder="New password" autocomplete="new-password" maxlength="100"><div class="k28a-err"></div><button class="k28a-btn" type="submit">Save password &amp; sign in</button></form>');
    box.querySelector('#k28aF3').addEventListener('submit', function (e) {
      e.preventDefault(); var btn = this.querySelector('.k28a-btn'); busy(btn, true, 'Saving...');
      api('POST', '/api/auth/reset', { token: token, password: this.elements.password.value }).then(function (r) {
        busy(btn, false); if (r.ok) afterLogin(keepPhotoKey(r.user)); else setErr(box, errText(r.error));
      });
    });
  }

  /* ------------------------------------------------------------------ profile */
  function galleryKeys() {
    var c = window.AVATAR_CATALOG;
    if (c && c.keys && c.keys.length) return c.keys.slice();
    var a = []; for (var i = 1; i <= 90; i++) a.push('toon' + i); return a;
  }
  /* ------------------------------------------------------------------ my stats */
  function openStats() {
    var box = open('📊 My stats', 'Your results while signed in at 4-player and 6-player tables', '<div id="k28aStBody" style="font-size:.85rem;color:#cdbf9a">Loading…</div>');
    api('GET', '/api/my-stats').then(function (r) {
      var body = box.querySelector('#k28aStBody'); if (!body) return;
      if (!r || !r.ok) { body.textContent = 'Could not load your stats. Please try again.'; return; }
      var P = r.stats.periods, cur = '7';
      function cell(v) { return '<td style="text-align:right;padding:5px 6px">' + (v || 0) + '</td>'; }
      function draw() {
        var p = P[cur];
        var rows = [['Games played', 'games'], ['Games won', 'champWon'], ['Games lost', 'champLost'], ['Left unfinished', 'unfinished'], ['Rounds won', 'roundsWon'], ['Rounds lost', 'roundsLost']];
        var tabs = [['7', 'Last 7 days'], ['30', 'Last 30 days'], ['life', 'All time']].map(function (t) {
          return '<button type="button" data-p="' + t[0] + '" style="flex:1;padding:7px 4px;border-radius:8px;border:1.5px solid ' + (cur === t[0] ? '#d4a62a' : 'rgba(255,255,255,.18)') + ';background:' + (cur === t[0] ? 'rgba(212,166,42,.18)' : 'transparent') + ';color:#f7e09a;font-weight:700;font-size:.74rem;cursor:pointer">' + t[1] + '</button>';
        }).join('');
        body.innerHTML = '<div style="display:flex;gap:6px;margin-bottom:10px">' + tabs + '</div>' +
          '<table style="width:100%;border-collapse:collapse;color:#efe7fb"><thead><tr style="opacity:.75;font-size:.72rem"><th style="text-align:left;padding:4px 6px"></th><th style="text-align:right;padding:4px 6px">4-player</th><th style="text-align:right;padding:4px 6px">6-player</th><th style="text-align:right;padding:4px 6px">Total</th></tr></thead><tbody>' +
          rows.map(function (x) { return '<tr style="border-top:1px solid rgba(255,255,255,.1)"><td style="padding:5px 6px">' + x[0] + '</td>' + cell(p['4p'][x[1]]) + cell(p['6p'][x[1]]) + '<td style="text-align:right;padding:5px 6px;font-weight:800;color:#f7e09a">' + (p.all[x[1]] || 0) + '</td></tr>'; }).join('') +
          '</tbody></table><div style="font-size:.7rem;opacity:.65;margin-top:10px;line-height:1.4">A game is a full championship (first to 15). “Left unfinished” = a game you started that has no result, for example you left or the table closed (one still in progress shows here until it ends). Only games played while signed in are counted. Daily detail is kept for ' + r.stats.keepDays + ' days; “All time” keeps running totals.</div>';
        Array.prototype.forEach.call(body.querySelectorAll('button[data-p]'), function (b) { b.addEventListener('click', function () { cur = b.getAttribute('data-p'); draw(); }); });
      }
      draw();
    });
  }
  function openProfile(first) {
    if (!me) return openAuth('in');
    var chosen = me.avatar || '';
    var keys = galleryKeys();
    var box = open(first ? 'Pick your player name' : 'My profile', first ? 'This is how other players see you. You only do this once.' : esc(me.email),
      '<div class="k28a-av"><img id="k28aPrev" alt=""><div style="flex:1"><label class="k28a-lbl">Player name</label><input class="k28a-in" id="k28aPN" maxlength="12" placeholder="e.g. Raju" style="margin:0" value="' + esc(me.playerName) + '"></div></div>' +
      '<label class="k28a-lbl">Choose an avatar</label><div class="k28a-grid" id="k28aGrid"></div>' +
      '<div style="display:flex;gap:8px"><button class="k28a-btn alt" id="k28aUp" type="button" style="margin:0">📷 Upload photo</button>' +
      '<button class="k28a-btn alt" id="k28aRm" type="button" style="margin:0;display:' + (me.hasPhoto ? 'block' : 'none') + '">Remove photo</button></div><input type="file" id="k28aFile" accept="image/*" hidden>' +
      '<label style="display:flex;align-items:flex-start;gap:8px;margin:8px 0 0;font-size:.82rem;color:#cdbf9a;cursor:pointer"><input type="checkbox" id="k28aBg" checked style="margin-top:2px"><span>Remove my photo background <span style="opacity:.7">(first time downloads a small helper, about 40 MB. Wi-Fi is best.)</span></span></label>' +
      '<div class="k28a-err" style="margin-top:8px"></div><button class="k28a-btn" id="k28aSave" type="button">' + (first ? 'Save &amp; start playing' : 'Save') + '</button>' +
      (first ? '' : '<button class="k28a-btn alt" id="k28aStats" type="button" style="margin:10px 0 0">📊 My stats</button>') +
      (first ? '' : '<div style="display:flex;gap:8px;margin-top:10px"><button class="k28a-btn alt" id="k28aOut" type="button" style="margin:0">Sign out</button><button class="k28a-btn dng" id="k28aDel" type="button" style="margin:0">Delete account</button></div>'),
      !first);
    var prev = box.querySelector('#k28aPrev'), grid = box.querySelector('#k28aGrid');
    function showPrev() { prev.src = chosen ? '/images/hero-avatars/' + chosen + '.png' : '/favicon-32x32.png'; }
    function mark() { grid.querySelectorAll('div').forEach(function (d) { d.classList.toggle('on', d.dataset.key === chosen); }); }
    function cell(k, front) {
      var d = document.createElement('div'); d.dataset.key = k; d.innerHTML = '<img loading="lazy" decoding="async" alt="" src="/images/hero-avatars/' + k + '.png">';
      d.addEventListener('click', function () { chosen = k; showPrev(); mark(); });
      front ? grid.insertBefore(d, grid.firstChild) : grid.appendChild(d);
    }
    keys.forEach(function (k) { cell(k, false); });
    if (me.photoKey) cell(me.photoKey, true);
    if (!chosen) { chosen = keys[Math.floor(Math.random() * keys.length)]; }
    showPrev(); mark();

    var file = box.querySelector('#k28aFile');
    box.querySelector('#k28aUp').addEventListener('click', function () { file.click(); });
    file.addEventListener('change', function () {
      var f = file.files && file.files[0]; file.value = ''; if (!f) return;
      if (f.size > 10 * 1024 * 1024) return setErr(box, errText('too_big'));
      var wantBg = !!(box.querySelector('#k28aBg') && box.querySelector('#k28aBg').checked);
      setErr(box, wantBg ? 'Removing background... the first time can take up to a minute.' : 'Preparing photo...', true);
      var note = ''; squarePhoto(f, wantBg, function (m) { if (/^Could not/.test(m)) note = m; setErr(box, m, true); }).then(function (dataUrl) {
        return api('POST', '/api/account/photo', { data: dataUrl });
      }).then(function (r) {
        if (!r || !r.ok) return setErr(box, errText(r && r.error));
        me = r.user; me.photoKey = r.user.photo;
        chosen = me.photoKey;
        grid.querySelectorAll('div').forEach(function (d) { if (/^pic_/.test(d.dataset.key)) d.remove(); });
        cell(me.photoKey, true); showPrev(); mark();
        box.querySelector('#k28aRm').style.display = 'block';
        addPhotoToPickers(); renderPill(); setErr(box, note || 'Photo added!', true);
      }).catch(function () { setErr(box, errText('bad_image')); });
    });
    box.querySelector('#k28aRm').addEventListener('click', function () {
      api('DELETE', '/api/account/photo').then(function (r) {
        if (!r.ok) return setErr(box, errText(r.error));
        grid.querySelectorAll('div').forEach(function (d) { if (/^pic_/.test(d.dataset.key)) d.remove(); });
        document.querySelectorAll('[data-k28a-photo]').forEach(function (e) { e.remove(); });
        var was = me.photoKey; me = r.user; me.photoKey = null;
        if (chosen === was) { chosen = keys[0]; showPrev(); mark(); }
        box.querySelector('#k28aRm').style.display = 'none'; setErr(box, 'Photo removed.', true);
      });
    });
    box.querySelector('#k28aSave').addEventListener('click', function () {
      var pn = box.querySelector('#k28aPN').value.trim(), btn = this;
      if (pn.length < 2) return setErr(box, errText('bad_player_name'));
      if (typeof NameFilter !== 'undefined' && NameFilter.isBad && NameFilter.isBad(pn)) return setErr(box, errText('name_not_allowed'));
      busy(btn, true, 'Saving...'); setErr(box, '');
      api('PUT', '/api/account/profile', { playerName: pn, avatar: chosen }).then(function (r) {
        busy(btn, false);
        if (!r.ok) return setErr(box, errText(r.error));
        setMe(r.user); close(); toast(first ? 'All set, ' + me.playerName + '! 🎴' : 'Saved!');
      });
    });
    var stBtn = box.querySelector('#k28aStats');
    if (stBtn) stBtn.addEventListener('click', openStats);
    var out = box.querySelector('#k28aOut');
    if (out) out.addEventListener('click', function () {
      api('POST', '/api/auth/logout', {}).then(function () {
        try { localStorage.removeItem('k28_player_avatar'); localStorage.removeItem('k28_player_name'); } catch (e) {}
        me = null; close(); location.reload();
      });
    });
    var del = box.querySelector('#k28aDel');
    if (del) del.addEventListener('click', function () {
      var box2 = open('Delete account?', 'This permanently removes your account, name, email and photo. Type <b>DELETE</b> to confirm.',
        '<input class="k28a-in" id="k28aDC" placeholder="DELETE" autocomplete="off"><div class="k28a-err"></div><button class="k28a-btn dng" id="k28aDGo" type="button">Delete my account</button><button class="k28a-btn alt" id="k28aDNo" type="button" style="margin-top:8px">Keep it</button>');
      box2.querySelector('#k28aDNo').addEventListener('click', function () { openProfile(false); });
      box2.querySelector('#k28aDGo').addEventListener('click', function () {
        api('POST', '/api/account/delete', { confirm: box2.querySelector('#k28aDC').value.trim() }).then(function (r) {
          if (!r.ok) return setErr(box2, r.error === 'need_confirm' ? 'Type DELETE exactly.' : errText(r.error));
          try { localStorage.removeItem('k28_player_avatar'); localStorage.removeItem('k28_player_name'); } catch (e) {}
          me = null; close(); toast('Your account was deleted.'); setTimeout(function () { location.reload(); }, 900);
        });
      });
    });
  }
  // center-crop to a square, 256px, WebP when the browser can (server re-checks and re-encodes)
  var BG_URL = 'https://cdn.jsdelivr.net/npm/@imgly/background-removal@1.5.5/+esm';
  var bgLib = null;
  function loadBg() {
    if (!bgLib) bgLib = new Function('u', 'return import(u)')(BG_URL).then(function (m) { return m.removeBackground || (m.default && m.default.removeBackground) || m.default; });
    return bgLib;
  }
  function withTimeout(p, ms) {
    return new Promise(function (res, rej) { var t = setTimeout(function () { rej(new Error('timeout')); }, ms); p.then(function (v) { clearTimeout(t); res(v); }, function (e) { clearTimeout(t); rej(e); }); });
  }
  function toBitmap(src) {
    if (window.createImageBitmap) return createImageBitmap(src);
    return new Promise(function (resolve, reject) {
      var u = URL.createObjectURL(src), im = new Image();
      im.onload = function () { URL.revokeObjectURL(u); resolve(im); };
      im.onerror = function () { URL.revokeObjectURL(u); reject(new Error('bad')); };
      im.src = u;
    });
  }
  function dim(b) { return [b.naturalWidth || b.width, b.naturalHeight || b.height]; }
  /* cut-out picture: crop a square around the person (alpha bounding box) so they fill the frame */
  function cutoutSquare(bm) {
    var d = dim(bm), w = d[0], h = d[1], k = Math.min(1, 512 / Math.max(w, h));
    var c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
    var g = c.getContext('2d'); g.drawImage(bm, 0, 0, c.width, c.height);
    var px = g.getImageData(0, 0, c.width, c.height).data, x0 = c.width, y0 = c.height, x1 = -1, y1 = -1;
    for (var y = 0; y < c.height; y++) for (var x = 0; x < c.width; x++) if (px[(y * c.width + x) * 4 + 3] > 24) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (x1 < 0) throw new Error('empty');
    var bw = x1 - x0 + 1, bh = y1 - y0 + 1, side = Math.max(bw, bh) * 1.08;
    var sx = x0 + bw / 2 - side / 2, sy = y0 + bh / 2 - side / 2;
    var o = document.createElement('canvas'); o.width = o.height = 256;
    var og = o.getContext('2d'); og.imageSmoothingQuality = 'high'; og.drawImage(c, sx, sy, side, side, 0, 0, 256, 256);
    var url = o.toDataURL('image/webp', 0.85);
    if (url.indexOf('data:image/webp') !== 0) url = o.toDataURL('image/png');
    return url;
  }
  function plainSquare(file) {
    return toBitmap(file).then(function (bm) {
      var d = dim(bm), w = d[0], h = d[1], side = Math.min(w, h), sx = (w - side) / 2, sy = (h - side) / 2;
      var c = document.createElement('canvas'); c.width = c.height = 256;
      var g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(bm, sx, sy, side, side, 0, 0, 256, 256);
      var url = c.toDataURL('image/webp', 0.82);
      if (url.indexOf('data:image/webp') !== 0) url = c.toDataURL('image/jpeg', 0.86);
      return url;
    });
  }
  /* wantBg: remove the background first (in the browser). If anything goes wrong the normal square photo is used instead. */
  function squarePhoto(file, wantBg, say) {
    if (!wantBg) return plainSquare(file);
    return withTimeout(loadBg().then(function (remove) {
      if (typeof remove !== 'function') throw new Error('nolib');
      var shown = 0;
      return remove(file, {
        model: 'isnet_quint8',
        output: { format: 'image/png' },
        progress: function (key, cur, tot) {
          if (!say || !tot) return; var pct = Math.floor(cur / tot * 100);
          if (/fetch/.test(String(key)) && pct >= shown + 10) { shown = pct; say('Downloading helper... ' + pct + '%'); }
          else if (/compute|inference/.test(String(key))) say('Removing background...');
        }
      });
    }), 120000).then(function (blob) { return toBitmap(blob); }).then(cutoutSquare).catch(function () {
      if (say) say('Could not remove the background, using your photo as is.');
      return plainSquare(file);
    });
  }

  /* ------------------------------------------------------------------ start */
  function handleUrl() {
    var q = new URLSearchParams(location.search), clean = false;
    if (q.has('verified')) {
      clean = true;
      if (q.get('verified') === '1') { toast('Email confirmed! You are signed in. ✅'); loadMe().then(function (u) { if (u && !u.playerName) openProfile(true); }); }
      else toast('That confirmation link has expired. Sign in and tap "Send it again".');
    }
    if (q.has('reset')) { clean = true; openReset(q.get('reset')); }
    if (clean) { try { history.replaceState(null, '', location.pathname); } catch (e) {} }
  }
  window.__k28Account = { me: function () { return me; }, openAuth: openAuth, openProfile: function () { openProfile(false); } };
  // The first-visit screen already had "Sign in" buttons marked "Coming Soon" -- wire them to the real thing
  // (a clone drops the old, dormant Auth0 click handlers).
  ['btnGoogleSignIn', 'btnEmailSignIn'].forEach(function (id) {
    var b = $(id); if (!b) return;
    var c = b.cloneNode(true); b.parentNode.replaceChild(c, b);
    c.addEventListener('click', function () { openAuth('in'); });
  });
  // Someone who is already signed in never needs that first-visit screen.
  function skipAuthScreen() {
    var a = $('authScreen'), w = $('welcomeScreen');
    if (!me || !a || !w || getComputedStyle(a).display === 'none') return;
    a.style.display = 'none'; w.style.display = 'flex';
    try { localStorage.setItem('k28_guestModeChosen', '1'); } catch (e) {}
  }
  renderPill(); renderNudge();
  api('GET', '/api/auth/config').then(function (c) {
    if (c && c.ok) cfg = c;
    var g = $('btnGoogleSignIn'); if (g && cfg.google) g.style.display = '';
  });
  loadMe().then(function () { handleUrl(); skipAuthScreen(); setTimeout(skipAuthScreen, 400); setTimeout(skipAuthScreen, 1500); });
})();
