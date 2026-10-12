// ============================================================================
// safety-notice.js -- the "be respectful / don't share personal details" notice
// for table CHAT and VOICE, shared by the 28 (4-player), 28 (6-player) and 56 tables.
//
//   K28Safety.accepted()  -> true once this browser has already tapped "I understand"
//   K28Safety.ask()       -> Promise<boolean>: resolves true straight away if already
//                            accepted, otherwise shows the notice and resolves with the
//                            player's choice (true = I understand, false = Not now)
//
// Shown ONCE per browser (localStorage). If storage is blocked it simply shows again
// each time -- never an error. Also drops a small permanent reminder line above the
// chat box on every page that has one.
// ============================================================================
(function () {
  'use strict';
  var KEY = 'k28_safety_ok_v1';

  function accepted() {
    try { return localStorage.getItem(KEY) === '1'; } catch (e) { return false; }
  }
  function remember() {
    try { localStorage.setItem(KEY, '1'); } catch (e) {}
  }

  var pending = null;

  function ask() {
    if (accepted()) return Promise.resolve(true);
    if (pending) return pending;
    pending = new Promise(function (resolve) {
      var ov = document.createElement('div');
      ov.id = 'k28SafetyOverlay';
      ov.setAttribute('role', 'dialog');
      ov.setAttribute('aria-modal', 'true');
      ov.style.cssText = 'position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;' +
        'padding:16px;background:rgba(5,2,14,.82);-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif';
      ov.innerHTML =
        '<div style="max-width:380px;width:100%;max-height:92vh;overflow:auto;background:linear-gradient(160deg,#2a1257,#12062b);' +
        'border:2px solid #d4a62a;border-radius:18px;padding:20px 20px 16px;color:#efe7fb;box-shadow:0 18px 50px rgba(0,0,0,.6)">' +
        '<div style="font-size:1.25rem;font-weight:800;color:#f7e09a;margin-bottom:10px">🛡️ Before you chat or talk</div>' +
        '<ul style="margin:0 0 12px 18px;padding:0;font-size:.92rem;line-height:1.5">' +
        '<li style="margin-bottom:7px"><b>Be respectful.</b> No hate speech, harassment, bullying or discrimination of any kind.</li>' +
        '<li style="margin-bottom:7px"><b>Never share personal details</b> with people you don’t know — phone number, home address, school, workplace, passwords, or photos of yourself.</li>' +
        '<li style="margin-bottom:7px">Chat and voice are for <b>ages 13 and over</b>.</li>' +
        '<li>Voice isn’t recorded, but everyone at the table can hear you. You can switch your mic off or leave the table at any time.</li>' +
        '</ul>' +
        '<div style="font-size:.78rem;opacity:.75;margin-bottom:14px">More in our <a href="/privacy.html#house-rules" target="_blank" rel="noopener" style="color:#f7e09a">house rules</a>.</div>' +
        '<div style="display:flex;gap:10px">' +
        '<button type="button" id="k28SafetyNo" style="flex:1;padding:12px;border-radius:99px;border:1px solid rgba(247,224,154,.5);background:transparent;color:#f7e09a;font-weight:700;font-size:.9rem;cursor:pointer">Not now</button>' +
        '<button type="button" id="k28SafetyYes" style="flex:1.4;padding:12px;border-radius:99px;border:0;background:linear-gradient(180deg,#f7e09a,#d4a62a);color:#12062b;font-weight:800;font-size:.95rem;cursor:pointer">I understand</button>' +
        '</div></div>';
      document.body.appendChild(ov);
      function done(ok) {
        if (ok) remember();
        if (ov.parentNode) ov.parentNode.removeChild(ov);
        pending = null;
        resolve(ok);
      }
      ov.querySelector('#k28SafetyYes').addEventListener('click', function () { done(true); });
      ov.querySelector('#k28SafetyNo').addEventListener('click', function () { done(false); });
    });
    return pending;
  }

  // Small permanent reminder above the chat box.
  function addChatNotes() {
    var rows = document.querySelectorAll('.chat-input-row');
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (row.previousElementSibling && row.previousElementSibling.className === 'k28-chat-note') continue;
      var n = document.createElement('div');
      n.className = 'k28-chat-note';
      n.style.cssText = 'flex-shrink:0;padding:5px 12px 0;font-size:11px;line-height:1.35;opacity:.7;text-align:center';
      n.textContent = 'Be kind — no hate or harassment. Never share personal details.';
      row.parentNode.insertBefore(n, row);
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addChatNotes);
  else addChatNotes();

  window.K28Safety = { accepted: accepted, ask: ask };
})();
