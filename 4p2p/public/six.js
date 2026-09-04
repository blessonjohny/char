// ============================================================
// 28 KERALA GULAN — 6 PLAYER — CLIENT
// Server-authoritative from the start (no P2P here at all) — this talks
// to the sixp_ socket events in server.js / the GameEngine6P in
// game-engine-6p.js. The server is the only source of truth; this file
// just renders whatever state it's sent and forwards button clicks as
// intents.
// ============================================================

let socket = null;
let MY_TABLE_ID = null;
let MY_PLAYER_ID = null;
try { MY_PLAYER_ID = localStorage.getItem('k28six_player_token'); } catch (e) {}
let MY_NAME = '';
let MY_POS = -1;
// Haptic-only feedback for this table - explicitly no sound engine here, per request. Same
// pattern as the 4-player table's own vibrate()/playHaptic(), just without any of the Web
// Audio API sound synthesis alongside it. navigator.vibrate doesn't exist at all on iOS
// Safari (Apple has never implemented it) and is unsupported in some other browsers too -
// both cases should silently do nothing rather than error, since this is a nice-to-have
// enhancement, never a requirement.
function vibrate(pattern) {
  try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (e) {}
}
const HAPTIC_PATTERNS = {
  cardPlayed: 15,
  trickWin: [20, 40, 20],
  trickLose: 30,
  bidConfirm: 12,
  trumpExposed: [30, 60, 30, 60, 40],
  yourTurn: [15, 30, 15],
};
function playHaptic(kind) {
  const pattern = HAPTIC_PATTERNS[kind];
  if (pattern) vibrate(pattern);
}
// True only for the one automatic reconnect attempt made on a fresh page
// load when a recent session is found -- lets sixp_joinError show a
// genuinely different, apologetic message for "the server was restarted
// and lost your table" instead of the generic "that code doesn't exist"
// wording meant for someone manually mistyping a room code.
let isAutoReconnectAttempt6p = false;
// The avatar the player picked on the name-entry screen -- same pattern
// and same localStorage key as the 4-player table, so a returning
// player's choice carries over between tables instead of resetting.
let MY_AVATAR_KEY = '';
try { MY_AVATAR_KEY = localStorage.getItem('k28_player_avatar') || ''; } catch (e) {}
const ALL_AVATAR_KEYS = Array.from({length:106}, (_,i) => 'toon'+(i+1));
// Per explicit request: these 5 are personal, PIN-protected avatars
// (see pickMyAvatar/confirmSixpChangeAvatar for the actual PIN check)
// and must never be handed to anyone automatically -- not as a bot,
// and not even as a brand-new visitor's random starting avatar before
// they've chosen anything at all. PUBLIC_AVATAR_KEYS is ALL_AVATAR_KEYS
// with just these 5 removed, used for every random/automatic pick;
// ALL_AVATAR_KEYS itself stays the full set, since the picker grid
// still needs to show and offer them for a human to deliberately
// select.
const PROTECTED_AVATAR_KEYS = new Set(['toon101', 'toon102', 'toon103', 'toon104', 'toon105', 'toon106']);
// Per explicit request: these 5 personal avatars require a 4-digit PIN
// before a human can actually select them (JCK's own PIN is distinct;
// the other 4 share 0000 for now, per explicit instruction). This is a
// lightweight gate against a stranger picking someone else's face by
// accident or on a whim, not real cryptographic security -- anyone
// reading this client-side source can see the PINs. That's an
// accepted tradeoff for what this is actually protecting against.
const AVATAR_PINS = {
  toon101: '0719', // JCK
  toon102: '0000', // LJ
  toon103: '0000', // JK
  toon104: '0000', // Santhosh
  toon105: '0000', // Jose
  toon106: '0000', // Bless
};
// Per explicit request: same as index.html's identical addition, see
// there for the fuller reasoning.
const PROTECTED_NAME_TO_AVATAR = {
  jck: 'toon101',
  lj: 'toon102',
  jk: 'toon103',
  santhosh: 'toon104',
  jose: 'toon105',
  bless: 'toon106',
};
function checkAvatarPin(key) {
  if (!AVATAR_PINS[key]) return Promise.resolve(true);
  return new Promise((resolve) => {
    const overlay = document.getElementById('pinModalOverlay');
    const box = document.getElementById('pinModalBox');
    const errEl = document.getElementById('pinModalError');
    const digits = Array.from(document.querySelectorAll('.pin-digit'));
    const cancelBtn = document.getElementById('pinCancelBtn');
    const submitBtn = document.getElementById('pinSubmitBtn');
    digits.forEach(d => d.value = '');
    errEl.textContent = '';
    overlay.classList.add('on');
    setTimeout(() => digits[0].focus(), 50);

    function cleanup() {
      overlay.classList.remove('on');
      digits.forEach(d => { d.oninput = null; d.onkeydown = null; });
      cancelBtn.onclick = null;
      submitBtn.onclick = null;
    }
    function tryDigit(i, e) {
      const v = e.target.value.replace(/\D/g, '').slice(0, 1);
      e.target.value = v;
      if (v && i < 3) digits[i + 1].focus();
    }
    function tryKeydown(i, e) {
      if (e.key === 'Backspace' && !e.target.value && i > 0) digits[i - 1].focus();
      if (e.key === 'Enter') attemptSubmit();
    }
    function attemptSubmit() {
      const entered = digits.map(d => d.value).join('');
      if (entered.length < 4) {
        errEl.textContent = 'Enter all 4 digits';
        return;
      }
      if (entered !== AVATAR_PINS[key]) {
        errEl.textContent = 'Incorrect PIN';
        box.classList.remove('shake'); void box.offsetWidth; box.classList.add('shake');
        digits.forEach(d => d.value = '');
        digits[0].focus();
        return;
      }
      cleanup();
      resolve(true);
    }
    digits.forEach((d, i) => {
      d.oninput = (e) => tryDigit(i, e);
      d.onkeydown = (e) => tryKeydown(i, e);
    });
    submitBtn.onclick = attemptSubmit;
    cancelBtn.onclick = () => { cleanup(); resolve(false); };
  });
}
const PUBLIC_AVATAR_KEYS = ALL_AVATAR_KEYS.filter(k => !PROTECTED_AVATAR_KEYS.has(k));
if (!MY_AVATAR_KEY || !ALL_AVATAR_KEYS.includes(MY_AVATAR_KEY) || PROTECTED_AVATAR_KEYS.has(MY_AVATAR_KEY)) {
  MY_AVATAR_KEY = PUBLIC_AVATAR_KEYS[Math.floor(Math.random() * PUBLIC_AVATAR_KEYS.length)];
}
function heroAvatarHtml(key) {
  // Falls back to a deterministic, guaranteed-valid key on any invalid
  // or out-of-range key -- see index.html's identical function for the
  // full reasoning (a large hardcoded bot list references avatar
  // numbers from before the set was trimmed multiple times).
  const TOON_COUNT = 106;
  const m = typeof key === 'string' && key.match(/^toon(\d+)$/);
  // Per explicit correction: validNum must NOT reject protected keys --
  // this function also renders a human's own CORRECTLY, PIN-validated
  // choice of toon101-105 (see confirmChangeAvatar/
  // confirmSixpChangeAvatar), and rejecting them here would silently
  // remap that legitimate choice to something else every time it's
  // rendered. The exclusion only belongs in the FALLBACK path below
  // (an already-invalid key getting remapped to something guaranteed-
  // valid), which is exactly where PUBLIC_AVATAR_KEYS is used instead
  // of the full range.
  const validNum = m && Number(m[1]) >= 1 && Number(m[1]) <= TOON_COUNT;
  if (!validNum) {
    const src = key || 'x';
    let h = 0;
    for (let i = 0; i < src.length; i++) h = (h * 31 + src.charCodeAt(i)) >>> 0;
    const n = h % PUBLIC_AVATAR_KEYS.length;
    key = PUBLIC_AVATAR_KEYS[n];
  }
  // Single image only -- see index.html's identical function for the
  // full reasoning. The .avatar.has-q CSS (dim filter + crying-emoji
  // overlay) already applies to the whole container regardless of what
  // image class is inside it, so no dual-image markup is needed.
  return `<img src="/images/hero-avatars/${key}.png" class="hero-avatar-face" alt="">`;
}
// Genuine per-visit randomization -- see index.html's identical helper
// for the full reasoning. Never mutates ALL_AVATAR_KEYS itself.
function shuffledAvatarKeys() {
  const arr = ALL_AVATAR_KEYS.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
function renderMyAvatarPicker6p() {
  const el = document.getElementById('myAvatarPicker6p');
  if (!el) return;
  el.innerHTML = shuffledAvatarKeys().map(key =>
    `<div class="my-avatar-choice${key === MY_AVATAR_KEY ? ' picked' : ''}" data-key="${key}" onclick="pickMyAvatar6p('${key}')">
      <img src="/images/hero-avatars/${key}.png" alt="">
    </div>`
  ).join('');
}
async function pickMyAvatar6p(key) {
  if (!(await checkAvatarPin(key))) return;
  MY_AVATAR_KEY = key;
  try { localStorage.setItem('k28_player_avatar', key); } catch (e) {}
  document.querySelectorAll('#myAvatarPicker6p .my-avatar-choice').forEach(el => el.classList.toggle('picked', el.dataset.key === key));
}
document.addEventListener('DOMContentLoaded', renderMyAvatarPicker6p);

// Keeps the screen from timing out/locking while this page is open --
// without this, the device's own screen-off timer (often as short as
// ~30s) would dim and lock the phone mid-game, which can cost a missed
// turn or a disconnect entirely. The Screen Wake Lock API is what
// actually solves this (not a fake "keep clicking" trick or an invisible
// looping video, which is how this used to have to be faked before real
// browser support existed). Not supported on every browser -- fails
// silently and harmlessly if so, since there's no good fallback that
// doesn't come with its own downsides (battery drain, an actual hidden
// video element, etc.) worth adding for this. The lock is automatically
// released by the browser itself whenever the tab/app loses visibility
// (backgrounded, screen manually locked, switched away from) -- so this
// re-acquires it every time the page becomes visible again, rather than
// only once on load, which would otherwise silently stop protecting the
// screen the very first time the user glanced away and came back.
let screenWakeLock = null;
async function requestScreenWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    screenWakeLock = await navigator.wakeLock.request('screen');
  } catch (e) {
    // Commonly just means the tab wasn't visible at the exact moment of
    // the request, or the OS/browser declined for its own reasons --
    // not worth surfacing to the player, the visibilitychange listener
    // below will simply try again the next time it's actually visible.
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') requestScreenWakeLock();
});
requestScreenWakeLock();
if (document.readyState === 'interactive' || document.readyState === 'complete') renderMyAvatarPicker6p();

// Same name-to-portrait mapping the 4-player table uses for its bots --
// shared bot name pools across every table mean the same bot name should
// always show the same face wherever it appears, not a different one
// per table. Static, never mood-reactive -- matches the 4-player table's
// own approach exactly, not the mood-face system 56 has separately.
const ALL_BOT_AVATARS_6P = [
  // Per explicit request: the 5 personal, PIN-protected avatars
  // (JCK/LJ/JK/Santhosh/Jose) are deliberately NOT entries in this
  // array. Every bot name/avatar in the game gets drawn from here --
  // by removing them entirely rather than adding an exclusion check at
  // each of the many places this array gets indexed for bot selection,
  // there's no separate list to keep in sync and no way for a bot to
  // end up wearing a real person's face. They're still fully available
  // for an actual human to pick for themselves, via the separate
  // ALL_AVATAR_KEYS-driven picker grid and its PIN gate (see
  // pickMyAvatar/confirmSixpChangeAvatar).
  {name:'Ancy',emoji:heroAvatarHtml('toon31'),bg:'linear-gradient(135deg,linear-gradient(135deg,#ff8fab,#e0648a))'},
  {name:'Ajai',emoji:heroAvatarHtml('toon1'),bg:'linear-gradient(135deg,linear-gradient(135deg,#e17055,#c44536))'},
  {name:'Alok',emoji:heroAvatarHtml('toon2'),bg:'linear-gradient(135deg,linear-gradient(135deg,#00b894,#00a085))'},
  {name:'Anup',emoji:heroAvatarHtml('toon3'),bg:'linear-gradient(135deg,linear-gradient(135deg,#8e44ad,#6c3483))'},
  {name:'Anjali',emoji:heroAvatarHtml('toon32'),bg:'linear-gradient(135deg,linear-gradient(135deg,#1abc9c,#16a085))'},
  {name:'Appu',emoji:heroAvatarHtml('toon4'),bg:'linear-gradient(135deg,linear-gradient(135deg,#4a90d9,#2a5a9a))'},
  {name:'Arun',emoji:heroAvatarHtml('toon5'),bg:'linear-gradient(135deg,linear-gradient(135deg,#f0932b,#c26e0f))'},
  {name:'Meera',emoji:heroAvatarHtml('toon33'),bg:'linear-gradient(135deg,linear-gradient(135deg,#00cec9,#00a8a3))'},
  {name:'Benson',emoji:heroAvatarHtml('toon6'),bg:'linear-gradient(135deg,linear-gradient(135deg,#e84393,#c2266f))'},
  {name:'Neha',emoji:heroAvatarHtml('toon34'),bg:'linear-gradient(135deg,linear-gradient(135deg,#6c5ce7,#4834b0))'},
  {name:'Binchu',emoji:heroAvatarHtml('toon7'),bg:'linear-gradient(135deg,linear-gradient(135deg,#fdcb6e,#e0a83c))'},
  {name:'Charlie',emoji:heroAvatarHtml('toon8'),bg:'linear-gradient(135deg,linear-gradient(135deg,#00a8ff,#0077b3))'},
  {name:'Jerin',emoji:heroAvatarHtml('toon9'),bg:'linear-gradient(135deg,linear-gradient(135deg,#ff8fab,#e0648a))'},
  {name:'Priya',emoji:heroAvatarHtml('toon35'),bg:'linear-gradient(135deg,linear-gradient(135deg,#e17055,#c44536))'},
  {name:'Johny',emoji:heroAvatarHtml('toon10'),bg:'linear-gradient(135deg,linear-gradient(135deg,#00b894,#00a085))'},
  {name:'Reena',emoji:heroAvatarHtml('toon36'),bg:'linear-gradient(135deg,linear-gradient(135deg,#8e44ad,#6c3483))'},
  {name:'Koshy',emoji:heroAvatarHtml('toon11'),bg:'linear-gradient(135deg,linear-gradient(135deg,#1abc9c,#16a085))'},
  {name:'Nate',emoji:heroAvatarHtml('toon12'),bg:'linear-gradient(135deg,linear-gradient(135deg,#4a90d9,#2a5a9a))'},
  {name:'Divya',emoji:heroAvatarHtml('toon37'),bg:'linear-gradient(135deg,linear-gradient(135deg,#f0932b,#c26e0f))'},
  {name:'Peter',emoji:heroAvatarHtml('toon13'),bg:'linear-gradient(135deg,linear-gradient(135deg,#00cec9,#00a8a3))'},
  {name:'Lakshmi',emoji:heroAvatarHtml('toon38'),bg:'linear-gradient(135deg,linear-gradient(135deg,#e84393,#c2266f))'},
  {name:'Rahul',emoji:heroAvatarHtml('toon14'),bg:'linear-gradient(135deg,linear-gradient(135deg,#6c5ce7,#4834b0))'},
  {name:'Rajesh',emoji:heroAvatarHtml('toon15'),bg:'linear-gradient(135deg,linear-gradient(135deg,#fdcb6e,#e0a83c))'},
  {name:'Randall',emoji:heroAvatarHtml('toon16'),bg:'linear-gradient(135deg,linear-gradient(135deg,#00a8ff,#0077b3))'},
  {name:'Sarah',emoji:heroAvatarHtml('toon39'),bg:'linear-gradient(135deg,linear-gradient(135deg,#ff8fab,#e0648a))'},
  {name:'Renji',emoji:heroAvatarHtml('toon17'),bg:'linear-gradient(135deg,linear-gradient(135deg,#e17055,#c44536))'},
  {name:'Roji',emoji:heroAvatarHtml('toon18'),bg:'linear-gradient(135deg,linear-gradient(135deg,#00b894,#00a085))'},
  {name:'Nisha',emoji:heroAvatarHtml('toon40'),bg:'linear-gradient(135deg,linear-gradient(135deg,#8e44ad,#6c3483))'},
  {name:'Roney',emoji:heroAvatarHtml('toon19'),bg:'linear-gradient(135deg,linear-gradient(135deg,#1abc9c,#16a085))'},
  {name:'Sanjay',emoji:heroAvatarHtml('toon20'),bg:'linear-gradient(135deg,linear-gradient(135deg,#4a90d9,#2a5a9a))'},
  {name:'Shyam',emoji:heroAvatarHtml('toon21'),bg:'linear-gradient(135deg,linear-gradient(135deg,#f0932b,#c26e0f))'},
  {name:'Deepa',emoji:heroAvatarHtml('toon41'),bg:'linear-gradient(135deg,linear-gradient(135deg,#00cec9,#00a8a3))'},
  {name:'Stev',emoji:heroAvatarHtml('toon22'),bg:'linear-gradient(135deg,linear-gradient(135deg,#e84393,#c2266f))'},
  {name:'Vinod',emoji:heroAvatarHtml('toon23'),bg:'linear-gradient(135deg,linear-gradient(135deg,#6c5ce7,#4834b0))'},
  {name:'Wesley',emoji:heroAvatarHtml('toon24'),bg:'linear-gradient(135deg,linear-gradient(135deg,#fdcb6e,#e0a83c))'},
  {name:'Elsa',emoji:heroAvatarHtml('toon42'),bg:'linear-gradient(135deg,linear-gradient(135deg,#00a8ff,#0077b3))'},
  {name:'Abin',emoji:heroAvatarHtml('toon25'),bg:'linear-gradient(135deg,linear-gradient(135deg,#ff8fab,#e0648a))'},
  {name:'Maya',emoji:heroAvatarHtml('toon43'),bg:'linear-gradient(135deg,linear-gradient(135deg,#e17055,#c44536))'},
  {name:'Bibin',emoji:heroAvatarHtml('toon26'),bg:'linear-gradient(135deg,linear-gradient(135deg,#00b894,#00a085))'},
  {name:'Sherin',emoji:heroAvatarHtml('toon44'),bg:'linear-gradient(135deg,linear-gradient(135deg,#8e44ad,#6c3483))'},
  {name:'Cibin',emoji:heroAvatarHtml('toon27'),bg:'linear-gradient(135deg,linear-gradient(135deg,#1abc9c,#16a085))'},
  {name:'Denny',emoji:heroAvatarHtml('toon28'),bg:'linear-gradient(135deg,linear-gradient(135deg,#4a90d9,#2a5a9a))'},
  {name:'Eldho',emoji:heroAvatarHtml('toon29'),bg:'linear-gradient(135deg,linear-gradient(135deg,#f0932b,#c26e0f))'},
  {name:'Teena',emoji:heroAvatarHtml('toon45'),bg:'linear-gradient(135deg,linear-gradient(135deg,#00cec9,#00a8a3))'},
  {name:'Frankie',emoji:heroAvatarHtml('toon30'),bg:'linear-gradient(135deg,linear-gradient(135deg,#e84393,#c2266f))'},
  {name:'George',emoji:heroAvatarHtml('toon52'),bg:'linear-gradient(135deg,linear-gradient(135deg,#6c5ce7,#4834b0))'},
  {name:'Anu',emoji:heroAvatarHtml('toon46'),bg:'linear-gradient(135deg,linear-gradient(135deg,#fdcb6e,#e0a83c))'},
  {name:'Hari',emoji:heroAvatarHtml('toon54'),bg:'linear-gradient(135deg,linear-gradient(135deg,#00a8ff,#0077b3))'},
  {name:'Ivan',emoji:heroAvatarHtml('toon56'),bg:'linear-gradient(135deg,linear-gradient(135deg,#ff8fab,#e0648a))'},
  {name:'Reshma',emoji:heroAvatarHtml('toon47'),bg:'linear-gradient(135deg,linear-gradient(135deg,#e17055,#c44536))'},
  {name:'Jibin',emoji:heroAvatarHtml('toon58'),bg:'linear-gradient(135deg,linear-gradient(135deg,#00b894,#00a085))'},
  {name:'Kevin',emoji:heroAvatarHtml('toon60'),bg:'linear-gradient(135deg,linear-gradient(135deg,#8e44ad,#6c3483))'},
  {name:'Libin',emoji:heroAvatarHtml('toon62'),bg:'linear-gradient(135deg,linear-gradient(135deg,#1abc9c,#16a085))'},
  {name:'Jisha',emoji:heroAvatarHtml('toon48'),bg:'linear-gradient(135deg,linear-gradient(135deg,#4a90d9,#2a5a9a))'},
  {name:'Manoj',emoji:heroAvatarHtml('toon64'),bg:'linear-gradient(135deg,linear-gradient(135deg,#f0932b,#c26e0f))'},
  {name:'Nibin',emoji:heroAvatarHtml('toon67'),bg:'linear-gradient(135deg,linear-gradient(135deg,#00cec9,#00a8a3))'},
  {name:'Oommen',emoji:heroAvatarHtml('toon69'),bg:'linear-gradient(135deg,linear-gradient(135deg,#e84393,#c2266f))'},
  {name:'Nimmy',emoji:heroAvatarHtml('toon49'),bg:'linear-gradient(135deg,linear-gradient(135deg,#6c5ce7,#4834b0))'},
  {name:'Pauly',emoji:heroAvatarHtml('toon70'),bg:'linear-gradient(135deg,linear-gradient(135deg,#fdcb6e,#e0a83c))'},
  {name:'Robin',emoji:heroAvatarHtml('toon76'),bg:'linear-gradient(135deg,linear-gradient(135deg,#00a8ff,#0077b3))'},
  {name:'Beena',emoji:heroAvatarHtml('toon50'),bg:'linear-gradient(135deg,linear-gradient(135deg,#ff8fab,#e0648a))'},
  {name:'Sibin',emoji:heroAvatarHtml('toon77'),bg:'linear-gradient(135deg,linear-gradient(135deg,#e17055,#c44536))'},
  {name:'Tibin',emoji:heroAvatarHtml('toon78'),bg:'linear-gradient(135deg,linear-gradient(135deg,#00b894,#00a085))'},
  {name:'Unni',emoji:heroAvatarHtml('toon79'),bg:'linear-gradient(135deg,linear-gradient(135deg,#8e44ad,#6c3483))'},
  {name:'Soumya',emoji:heroAvatarHtml('toon51'),bg:'linear-gradient(135deg,linear-gradient(135deg,#1abc9c,#16a085))'},
  {name:'Vishnu',emoji:heroAvatarHtml('toon80'),bg:'linear-gradient(135deg,linear-gradient(135deg,#4a90d9,#2a5a9a))'},
  {name:'Wilson',emoji:heroAvatarHtml('toon82'),bg:'linear-gradient(135deg,linear-gradient(135deg,#f0932b,#c26e0f))'},
  {name:'Liya',emoji:heroAvatarHtml('toon53'),bg:'linear-gradient(135deg,linear-gradient(135deg,#00cec9,#00a8a3))'},
  {name:'Xavier',emoji:heroAvatarHtml('toon84'),bg:'linear-gradient(135deg,linear-gradient(135deg,#e84393,#c2266f))'},
  {name:'Yohan',emoji:heroAvatarHtml('toon86'),bg:'linear-gradient(135deg,linear-gradient(135deg,#6c5ce7,#4834b0))'},
  {name:'Merin',emoji:heroAvatarHtml('toon55'),bg:'linear-gradient(135deg,linear-gradient(135deg,#fdcb6e,#e0a83c))'},
  {name:'Zachariah',emoji:heroAvatarHtml('toon89'),bg:'linear-gradient(135deg,linear-gradient(135deg,#00a8ff,#0077b3))'},
  {name:'Aby',emoji:heroAvatarHtml('toon96'),bg:'linear-gradient(135deg,linear-gradient(135deg,#ff8fab,#e0648a))'},
  {name:'Bijoy',emoji:heroAvatarHtml('toon97'),bg:'linear-gradient(135deg,linear-gradient(135deg,#e17055,#c44536))'},
  {name:'Asha',emoji:heroAvatarHtml('toon57'),bg:'linear-gradient(135deg,linear-gradient(135deg,#00b894,#00a085))'},
  {name:'Anita',emoji:heroAvatarHtml('toon59'),bg:'linear-gradient(135deg,linear-gradient(135deg,#8e44ad,#6c3483))'},
  {name:'Cyriac',emoji:heroAvatarHtml('toon98'),bg:'linear-gradient(135deg,linear-gradient(135deg,#1abc9c,#16a085))'},
  {name:'Davis',emoji:heroAvatarHtml('toon99'),bg:'linear-gradient(135deg,linear-gradient(135deg,#4a90d9,#2a5a9a))'},
  {name:'Betty',emoji:heroAvatarHtml('toon61'),bg:'linear-gradient(135deg,linear-gradient(135deg,#f0932b,#c26e0f))'},
  {name:'Ebin',emoji:heroAvatarHtml('toon100'),bg:'linear-gradient(135deg,linear-gradient(135deg,#00cec9,#00a8a3))'},
  {name:'Fenil',emoji:heroAvatarHtml('toon1'),bg:'linear-gradient(135deg,linear-gradient(135deg,#e84393,#c2266f))'},
  {name:'Gibin',emoji:heroAvatarHtml('toon2'),bg:'linear-gradient(135deg,linear-gradient(135deg,#6c5ce7,#4834b0))'},
  {name:'Celine',emoji:heroAvatarHtml('toon63'),bg:'linear-gradient(135deg,linear-gradient(135deg,#fdcb6e,#e0a83c))'},
  {name:'Diya',emoji:heroAvatarHtml('toon65'),bg:'linear-gradient(135deg,linear-gradient(135deg,#00a8ff,#0077b3))'},
  {name:'Hillary',emoji:heroAvatarHtml('toon66'),bg:'linear-gradient(135deg,linear-gradient(135deg,#ff8fab,#e0648a))'},
  {name:'Fiona',emoji:heroAvatarHtml('toon68'),bg:'linear-gradient(135deg,linear-gradient(135deg,#e17055,#c44536))'},
  {name:'Ittoop',emoji:heroAvatarHtml('toon3'),bg:'linear-gradient(135deg,linear-gradient(135deg,#00b894,#00a085))'},
  {name:'Gracy',emoji:heroAvatarHtml('toon71'),bg:'linear-gradient(135deg,linear-gradient(135deg,#8e44ad,#6c3483))'},
  {name:'Hema',emoji:heroAvatarHtml('toon72'),bg:'linear-gradient(135deg,linear-gradient(135deg,#1abc9c,#16a085))'},
  {name:'Jaison',emoji:heroAvatarHtml('toon4'),bg:'linear-gradient(135deg,linear-gradient(135deg,#4a90d9,#2a5a9a))'},
  {name:'Indu',emoji:heroAvatarHtml('toon73'),bg:'linear-gradient(135deg,linear-gradient(135deg,#f0932b,#c26e0f))'},
  {name:'Jessy',emoji:heroAvatarHtml('toon74'),bg:'linear-gradient(135deg,linear-gradient(135deg,#00cec9,#00a8a3))'},
  {name:'Kurian',emoji:heroAvatarHtml('toon5'),bg:'linear-gradient(135deg,linear-gradient(135deg,#e84393,#c2266f))'},
  {name:'Lijo',emoji:heroAvatarHtml('toon6'),bg:'linear-gradient(135deg,linear-gradient(135deg,#6c5ce7,#4834b0))'},
  {name:'Kavya',emoji:heroAvatarHtml('toon75'),bg:'linear-gradient(135deg,linear-gradient(135deg,#fdcb6e,#e0a83c))'},
  {name:'Mathew',emoji:heroAvatarHtml('toon7'),bg:'linear-gradient(135deg,linear-gradient(135deg,#00a8ff,#0077b3))'},
  {name:'Leena',emoji:heroAvatarHtml('toon81'),bg:'linear-gradient(135deg,linear-gradient(135deg,#ff8fab,#e0648a))'},
  {name:'Ninan',emoji:heroAvatarHtml('toon8'),bg:'linear-gradient(135deg,linear-gradient(135deg,#e17055,#c44536))'},
  {name:'Mariya',emoji:heroAvatarHtml('toon83'),bg:'linear-gradient(135deg,linear-gradient(135deg,#00b894,#00a085))'},
  {name:'Babi',emoji:heroAvatarHtml('toon85'),bg:'linear-gradient(135deg,linear-gradient(135deg,#c2266f,#8e1c52))'},
  {name:'Oliver',emoji:heroAvatarHtml('toon9'),bg:'linear-gradient(135deg,linear-gradient(135deg,#8e44ad,#6c3483))'},
  {name:'Linda',emoji:heroAvatarHtml('toon87'),bg:'linear-gradient(135deg,#ff8fab,#e0648a)'},
  {name:'Babitha',emoji:heroAvatarHtml('toon88'),bg:'linear-gradient(135deg,#e17055,#c44536)'},
  {name:'Maria',emoji:heroAvatarHtml('toon90'),bg:'linear-gradient(135deg,#00b894,#00a085)'},
  {name:'Leela',emoji:heroAvatarHtml('toon91'),bg:'linear-gradient(135deg,#8e44ad,#6c3483)'},
  {name:'Anna',emoji:heroAvatarHtml('toon92'),bg:'linear-gradient(135deg,#1abc9c,#16a085)'},
  {name:'Thankam',emoji:heroAvatarHtml('toon93'),bg:'linear-gradient(135deg,#4a90d9,#2a5a9a)'},
  {name:'Lincy',emoji:heroAvatarHtml('toon94'),bg:'linear-gradient(135deg,#f0932b,#c26e0f)'},
  {name:'Princy',emoji:heroAvatarHtml('toon95'),bg:'linear-gradient(135deg,#00cec9,#00a8a3)'},
  {name:'Easo',emoji:heroAvatarHtml('toon10'),bg:'linear-gradient(135deg,#e84393,#c2266f)'},
  {name:'Joseph',emoji:heroAvatarHtml('toon11'),bg:'linear-gradient(135deg,#6c5ce7,#4834b0)'},
];

// Requests fullscreen -- hides the browser's own address bar and nav
// bars on mobile -- the moment someone actually creates or joins a
// table. Only works when called synchronously from within a real tap
// (btnNameContinue's click handler below qualifies). Tries every
// vendor-prefixed version for broad browser coverage. Wrapped in
// try/catch either way -- if none are available (genuinely the case for
// Safari on iPhone specifically, see maybeShowIosInstallHint() below),
// the game still works completely normally, just without the
// chrome-hiding effect.
function requestFullscreen6p(){
  try {
    const el = document.documentElement;
    const fn = el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen || el.msRequestFullscreen;
    if (fn) {
      const result = fn.call(el);
      if (result && result.catch) result.catch(() => {});
    }
  } catch (e) { /* not available here -- fine, just skip it */ }
}

// iOS Safari does not let ANY web page hide its own browser chrome via
// JavaScript -- Apple restricts the Fullscreen API on iPhone
// specifically, so requestFullscreen6p() above silently does nothing
// there. "Add to Home Screen" (the apple-mobile-web-app-capable meta
// tag in <head> makes that launch standalone, no Safari bars at all) is
// the one real fix -- shown once, dismissible, only to genuine
// iPhone/iPad Safari visitors who haven't already installed it.
function maybeShowIosInstallHint6p(){
  try {
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
    const isSafari = /^((?!chrome|android|crios|fxios).)*safari/i.test(navigator.userAgent);
    const isStandalone = window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
    if (!isIOS || !isSafari || isStandalone) return;
    if (sessionStorage.getItem('k28six_seenIosInstallHint')) return;
    sessionStorage.setItem('k28six_seenIosInstallHint', '1');
  } catch (e) { return; }
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;bottom:16px;left:50%;transform:translateX(-50%);max-width:320px;width:calc(100% - 32px);background:rgba(20,20,30,0.97);border:1px solid rgba(244,196,48,0.5);border-radius:14px;padding:14px 16px;z-index:3000;box-shadow:0 8px 24px rgba(0,0,0,0.5);text-align:left;color:#fff;font-size:0.85rem;line-height:1.4';
  el.innerHTML = `📱 For a full-screen, app-like table with no Safari bars: tap <b>Share</b> ⬆️ then <b>Add to Home Screen</b>.
    <div style="text-align:right;margin-top:8px"><button id="iosHintDismiss6p" style="padding:6px 12px;border-radius:8px;border:1px solid rgba(255,255,255,0.2);background:transparent;color:rgba(255,255,255,0.8);font-size:0.8rem">Got it</button></div>`;
  document.body.appendChild(el);
  document.getElementById('iosHintDismiss6p').addEventListener('click', () => el.remove());
}
maybeShowIosInstallHint6p();
// Matches game-engine-6p.js's getTeam() exactly: even seats vs odd seats.
function sixpGetTeam(pos) { return pos % 2 === 0 ? 0 : 1; }

// A vintage grandfather-clock face built into the table felt — sits at
// z-index:0, behind every seat and card. Hands snap to position each
// second (no continuous glide); the only motion is a brief brass flash
// exactly when a hand reaches a new minute/hour.
let sixpClockLastMinuteMark = -1, sixpClockLastHourMark = -1;
function sixpFlashClockHand(el) {
  if (!el) return;
  el.classList.remove('clock-hand-flash');
  void el.getBBox && el.getBBox();
  el.classList.add('clock-hand-flash');
  setTimeout(() => el.classList.remove('clock-hand-flash'), 700);
}
// Fills the day/date apertures and the moon-phase sub-dial — these only
// change once a day (moon phase effectively so), so this only actually
// touches the DOM when the calendar day changes, not on every 1s tick.
let sixpClockLastDay = -1;
let sixpLastMoonPhase = null;
let sixpLastWeather = null; // {temp, code}
function sixpMoonPhaseName(phase) {
  if (phase < 0.03 || phase > 0.97) return 'New Moon';
  if (phase < 0.22) return 'Waxing Crescent';
  if (phase < 0.28) return 'First Quarter (Half Moon)';
  if (phase < 0.47) return 'Waxing Gibbous';
  if (phase < 0.53) return 'Full Moon';
  if (phase < 0.72) return 'Waning Gibbous';
  if (phase < 0.78) return 'Last Quarter (Half Moon)';
  return 'Waning Crescent';
}
function sixpMoonPath(phase, cx, cy, R) {
  const theta = phase * 2 * Math.PI;
  const rx = R * Math.abs(Math.cos(theta));
  const top = [cx, cy - R], bottom = [cx, cy + R];
  let outerSweep, termSweep;
  if (phase <= 0.5) { outerSweep = 1; termSweep = phase < 0.25 ? 1 : 0; }
  else { outerSweep = 0; termSweep = phase < 0.75 ? 0 : 1; }
  return 'M ' + top[0].toFixed(2) + ',' + top[1].toFixed(2) +
    ' A ' + R + ',' + R + ' 0 0,' + outerSweep + ' ' + bottom[0].toFixed(2) + ',' + bottom[1].toFixed(2) +
    ' A ' + rx.toFixed(2) + ',' + R + ' 0 0,' + termSweep + ' ' + top[0].toFixed(2) + ',' + top[1].toFixed(2) + ' Z';
}
// Tapping a city on the ring shows its current local time in a toast —
// wired once, the first time the clock SVG is actually in the DOM.
let sixpCityClicksWired = false;
// Animates the hour/minute hands to actually show a clicked city's
// time for a few seconds, then eases them back to real local time —
// always via the shortest rotation direction so they never spin the
// long way around.
function sixpGetCurrentHandAngle(el) {
  const t = el.getAttribute('transform') || '';
  const m = t.match(/rotate\(([-\d.]+)/);
  return m ? parseFloat(m[1]) : 0;
}
function sixpSetHandShortest(el, targetDeg) {
  const cur = sixpGetCurrentHandAngle(el);
  const curNorm = ((cur % 360) + 360) % 360;
  const tgtNorm = ((targetDeg % 360) + 360) % 360;
  let diff = tgtNorm - curNorm;
  if (diff > 180) diff -= 360;
  if (diff < -180) diff += 360;
  el.setAttribute('transform', 'rotate(' + (cur + diff) + ' 100 100)');
}
// The 12 city markers sit 30° apart around the dial, in this clockwise
// order starting from the 12 o'clock position (NYC's original spot).
const SIXP_CITY_ORDER = ['NYC','LON','PAR','VGS','IST','DXB','CHI','KIR','KOC','DAL','BEI','TOK'];
const SIXP_CITY_NAMES = { NYC: 'New York', LON: 'London', PAR: 'Paris', IST: 'Istanbul', DXB: 'Dubai', KIR: 'Kiritimati', KOC: 'Kochi', BEI: 'Beijing', TOK: 'Tokyo', VGS: 'Las Vegas', CHI: 'Chicago', DAL: 'Dallas' };
const SIXP_RING_CENTER = 100, SIXP_RING_RADIUS = 78;
// Rotates the whole ring of city markers so `selectedCode` lands at 12
// o'clock. Only the marker that ends up at 12 shows its full city name
// (e.g. "New York"); every other marker shows its 3-letter code.
function sixpRotateCityRing(selectedCode) {
  const homeIdx = SIXP_CITY_ORDER.indexOf(selectedCode);
  if (homeIdx === -1) return;
  const offsetDeg = -(homeIdx * 30);
  document.querySelectorAll('.vclk6CityLabel, .vclk6CityText').forEach(el => {
    const code = el.getAttribute('data-code');
    const idx = SIXP_CITY_ORDER.indexOf(code);
    if (idx === -1) return;
    const angleDeg = ((idx * 30 + offsetDeg) % 360 + 360) % 360;
    const rad = angleDeg * Math.PI / 180;
    const cx = SIXP_RING_CENTER + SIXP_RING_RADIUS * Math.sin(rad);
    const cy = SIXP_RING_CENTER - SIXP_RING_RADIUS * Math.cos(rad);
    const isAtTwelve = (code === selectedCode);
    if (el.classList.contains('vclk6CityLabel')) {
      el.setAttribute('cx', cx.toFixed(2));
      el.setAttribute('cy', cy.toFixed(2));
    } else {
      el.setAttribute('x', cx.toFixed(2));
      el.setAttribute('y', cy.toFixed(2));
      el.setAttribute('font-size', isAtTwelve ? '10.5' : '8.5');
      el.setAttribute('font-weight', isAtTwelve ? '900' : '700');
      el.textContent = isAtTwelve ? (SIXP_CITY_NAMES[code] || code) : code;
    }
  });
}
// Switches the whole clock over to a new city — hands, day/date, and
// weather all update, and it STAYS there (no auto-revert) until a
// different city is tapped.
function sixpSelectCity(code, tz, lat, lon) {
  sixpSelectedCity = { code, tz, lat, lon };
  sixpClockLastDay = -1; // force complications to recompute for the new city right away
  sixpFetchWeather();
  sixpRotateCityRing(code);
  const hourEl = document.getElementById('vclk6HourHand'), minEl = document.getElementById('vclk6MinuteHand');
  if (hourEl && minEl) {
    const { hour, minute } = sixpGetHourMinuteInTz(tz);
    hourEl.classList.add('clock-hand-preview');
    minEl.classList.add('clock-hand-preview');
    sixpSetHandShortest(hourEl, ((hour % 12) + minute / 60) * 30);
    sixpSetHandShortest(minEl, minute * 6);
    setTimeout(() => { hourEl.classList.remove('clock-hand-preview'); minEl.classList.remove('clock-hand-preview'); }, 1200);
  }
  updateTableClock();
}
function sixpGetHourMinuteInTz(tz) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(new Date());
  const h = parseInt(parts.find(p => p.type === 'hour').value, 10);
  const m = parseInt(parts.find(p => p.type === 'minute').value, 10);
  return { hour: h, minute: m };
}

function sixpWireCityClicks() {
  if (sixpCityClicksWired) return;
  const labels = document.querySelectorAll('.vclk6CityLabel');
  const overlay = document.getElementById('vclk6FaceClickOverlay');
  if (!labels.length && !overlay) return;
  sixpCityClicksWired = true;
  sixpRotateCityRing(sixpSelectedCity.code); // show the correct full name at 12 o'clock right away
  const cityNames = SIXP_CITY_NAMES;
  function showCityTime(code, tz, lat, lon) {
    try {
      const timeStr = new Date().toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
      showToast('🌍 ' + (cityNames[code] || code) + ': ' + timeStr, 'info', 2500);
      sixpSelectCity(code, tz, lat, lon);
    } catch (e) {}
  }
  labels.forEach(el => {
    el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const lat = parseFloat(el.getAttribute('data-lat'));
      const lon = parseFloat(el.getAttribute('data-lon'));
      showCityTime(el.getAttribute('data-code'), el.getAttribute('data-tz'), lat, lon);
    });
  });
  // Tapping a blank part of the dial does nothing — New York only shows
  // when its own city marker (at 12) is actually tapped, same as any
  // other city. No silent "everything defaults to NYC" fallback.

  const moonClick = document.getElementById('vclk6MoonClick');
  if (moonClick) {
    moonClick.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const phase = sixpLastMoonPhase;
      if (phase === null) return;
      const pct = Math.round((phase <= 0.5 ? phase * 2 : (1 - phase) * 2) * 100);
      showToast('🌙 ' + sixpMoonPhaseName(phase) + ' — ' + pct + '% illuminated', 'info', 3000);
    });
  }
  const weatherClick = document.getElementById('vclk6WeatherClick');
  if (weatherClick) {
    weatherClick.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (!sixpLastWeather || typeof sixpLastWeather.temp !== 'number') {
        showToast('🌦️ Weather still loading...', 'info', 2000);
        return;
      }
      const cityLabel = cityNames[sixpSelectedCity.code] || sixpSelectedCity.code;
      showToast(sixpWeatherIcon(sixpLastWeather.code) + ' ' + cityLabel + ': ' + Math.round(sixpLastWeather.temp) + '°F, ' + sixpWeatherDesc(sixpLastWeather.code), 'info', 3000);
      sixpPlayWeatherAnimation(sixpLastWeather.code);
    });
  }
  const leapClick = document.getElementById('vclk6LeapClick');
  if (leapClick) {
    leapClick.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const year = new Date().getFullYear();
      const isLeap = (year % 4 === 0 && year % 100 !== 0) || (year % 400 === 0);
      let nextLeap = year;
      while (!((nextLeap % 4 === 0 && nextLeap % 100 !== 0) || (nextLeap % 400 === 0))) nextLeap++;
      if (isLeap) showToast('📅 ' + year + ' is a leap year — 366 days, Feb has 29', 'win', 3000);
      else showToast('📅 ' + year + ' is not a leap year — next one is ' + nextLeap, 'info', 3000);
    });
  }
}

let sixpClockLastCityCode = null;
function sixpUpdateClockComplications(nowInCity, city) {
  const cityParts = new Intl.DateTimeFormat('en-US', { timeZone: city.tz, year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short' }).formatToParts(new Date());
  const cityDay = cityParts.find(p => p.type === 'day').value;
  const cityYear = parseInt(cityParts.find(p => p.type === 'year').value, 10);
  const cityWeekday = cityParts.find(p => p.type === 'weekday').value.toUpperCase();
  const dayNum = cityYear * 1000 + parseInt(cityDay, 10);
  if (dayNum === sixpClockLastDay && city.code === sixpClockLastCityCode) return;
  sixpClockLastDay = dayNum;
  sixpClockLastCityCode = city.code;
  const dayEl = document.getElementById('vclk6DayText'), dateEl = document.getElementById('vclk6DateText');
  if (dayEl) dayEl.textContent = cityWeekday;
  if (dateEl) dateEl.textContent = cityDay;
  // Simple synodic-month approximation: known new moon reference
  // (Jan 6, 2000 18:14 UTC) plus the 29.53059-day cycle length. This is
  // a real astronomical fact, so it's the same regardless of which
  // city's clock is being shown — computed from the actual current
  // moment, not the selected city's local calendar.
  const now = new Date();
  const synodic = 29.530588853;
  const knownNewMoon = Date.UTC(2000, 0, 6, 18, 14);
  const daysSince = (now.getTime() - knownNewMoon) / 86400000;
  const phase = ((daysSince % synodic) + synodic) % synodic / synodic;
  const shadowEl = document.getElementById('vclk6MoonShadow');
  if (shadowEl) shadowEl.setAttribute('d', sixpMoonPath(phase, 100, 140, 11));
  sixpLastMoonPhase = phase;

  const isLeap = (cityYear % 4 === 0 && cityYear % 100 !== 0) || (cityYear % 400 === 0);
  const leapNumEl = document.getElementById('vclk6LeapYear'), leapLblEl = document.getElementById('vclk6LeapLbl');
  if (leapNumEl) leapNumEl.textContent = String(cityYear);
  if (leapLblEl) leapLblEl.textContent = isLeap ? 'LEAP YEAR' : 'not leap';
  if (leapLblEl) leapLblEl.setAttribute('fill', isLeap ? '#2e7d32' : '#6b4a12');
}

// One-time weather fetch (Open-Meteo — free, no API key) for New York,
// refreshed roughly hourly. Fails silently and leaves the placeholder if
// there's no network access, rather than blocking anything.
let sixpWeatherFetched = false;
// A brief, condition-matched flourish over the clock whenever the
// weather window is tapped — falling rain/snow, radiating sun rays,
// drifting clouds, or a lightning flash, depending on the actual code.
let sixpWeatherFxTimer = null;
function sixpClearWeatherFx() {
  const host = document.getElementById('weatherFx');
  if (host) host.innerHTML = '';
}
function sixpMakeParticle(host, style, animName, durationMs, delayMs, iterations) {
  const el = document.createElement('div');
  el.style.cssText = style + ';position:absolute;animation:' + animName + ' ' + durationMs + 'ms ease-in ' + delayMs + 'ms ' + (iterations || 1);
  host.appendChild(el);
  return el;
}
function sixpPlayWeatherAnimation(code) {
  code = Number(code);
  const host = document.getElementById('weatherFx');
  if (!host) return;
  if (sixpWeatherFxTimer) { clearTimeout(sixpWeatherFxTimer); sixpWeatherFxTimer = null; }
  sixpClearWeatherFx();
  let totalDuration = 2600;

  if (code === 0 || code <= 2) {
    // Clear / partly cloudy — sun rays pulsing outward from center
    for (let i = 0; i < 8; i++) {
      const ang = i * 45;
      sixpMakeParticle(host,
        'left:50%;top:50%;width:3px;height:34px;margin:-17px 0 0 -1.5px;transform-origin:50% 100%;background:linear-gradient(to top,rgba(255,210,90,0.95),transparent);border-radius:2px;--ang:' + ang + 'deg',
        'weatherSunRay', 1300, i * 60, 1);
    }
    if (code >= 1) {
      for (let i = 0; i < 3; i++) {
        sixpMakeParticle(host,
          'top:' + (30 + i * 25) + 'px;width:44px;height:16px;border-radius:50%;background:rgba(255,255,255,0.5);filter:blur(2px)',
          'weatherCloudDrift', 2400, i * 300, 1);
      }
      totalDuration = 2400;
    } else {
      totalDuration = 1300 + 8 * 60;
    }
  } else if (code === 3) {
    // Overcast — soft drifting cloud puffs
    for (let i = 0; i < 4; i++) {
      sixpMakeParticle(host,
        'top:' + (24 + i * 30) + 'px;width:56px;height:20px;border-radius:50%;background:rgba(210,210,210,0.55);filter:blur(2px)',
        'weatherCloudDrift', 2600, i * 260, 1);
    }
    totalDuration = 2600 + 4 * 260;
  } else if (code >= 45 && code <= 48) {
    // Fog — slow, hazy, low-opacity bands
    for (let i = 0; i < 4; i++) {
      sixpMakeParticle(host,
        'top:' + (20 + i * 34) + 'px;width:200px;height:26px;left:0;background:rgba(230,230,230,0.35);filter:blur(4px)',
        'weatherCloudDrift', 3400, i * 220, 1);
    }
    totalDuration = 3400 + 4 * 220;
  } else if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82) || code >= 95) {
    // Rain / rain showers / thunderstorm — falling raindrops
    const dropCount = code >= 95 ? 16 : 12;
    for (let i = 0; i < dropCount; i++) {
      sixpMakeParticle(host,
        'left:' + (6 + Math.random() * 188) + 'px;top:-20px;width:2px;height:16px;background:linear-gradient(to bottom,transparent,rgba(120,180,255,0.9));border-radius:2px',
        'weatherRainFall', 900 + Math.random() * 300, Math.random() * 900, 2);
    }
    if (code >= 95) {
      sixpMakeParticle(host, 'inset:0;background:#fff', 'weatherLightning', 1800, 100, 1);
    }
    totalDuration = 2400;
  } else if (code >= 71 && code <= 77) {
    // Snow — drifting snowflakes
    for (let i = 0; i < 14; i++) {
      const size = 3 + Math.random() * 3;
      sixpMakeParticle(host,
        'left:' + (6 + Math.random() * 188) + 'px;top:-16px;width:' + size + 'px;height:' + size + 'px;border-radius:50%;background:rgba(255,255,255,0.95)',
        'weatherSnowFall', 1800 + Math.random() * 500, Math.random() * 900, 1);
    }
    totalDuration = 2700;
  }

  sixpWeatherFxTimer = setTimeout(sixpClearWeatherFx, totalDuration + 200);
}

function sixpWeatherIcon(code) {
  code = Number(code);
  if (code === 0) return '☀️';
  if (code <= 2) return '🌤️';
  if (code === 3) return '☁️';
  if (code >= 51 && code <= 67) return '🌧️';
  if (code >= 71 && code <= 77) return '❄️';
  if (code >= 80 && code <= 82) return '🌦️';
  if (code >= 95) return '⛈️';
  return '🌤️';
}
function sixpWeatherDesc(code) {
  code = Number(code);
  if (code === 0) return 'Clear sky';
  if (code <= 2) return 'Partly cloudy';
  if (code === 3) return 'Overcast';
  if (code >= 45 && code <= 48) return 'Foggy';
  if (code >= 51 && code <= 67) return 'Rainy';
  if (code >= 71 && code <= 77) return 'Snowy';
  if (code >= 80 && code <= 82) return 'Rain showers';
  if (code >= 95) return 'Thunderstorm';
  return 'Fair';
}
function sixpFetchWeather() {
  const lat = sixpSelectedCity.lat, lon = sixpSelectedCity.lon;
  fetch('https://api.open-meteo.com/v1/forecast?latitude=' + lat + '&longitude=' + lon + '&current=temperature_2m,weather_code&temperature_unit=fahrenheit')
    .then(r => r.json())
    .then(data => {
      const t = data && data.current && data.current.temperature_2m;
      const code = data && data.current && data.current.weather_code;
      const tempEl = document.getElementById('vclk6WeatherTemp');
      if (tempEl && typeof t === 'number') tempEl.textContent = Math.round(t) + '\u00B0F';
      const iconEl = document.getElementById('vclk6WeatherIcon');
      if (iconEl) iconEl.textContent = sixpWeatherIcon(code);
      sixpLastWeather = { temp: t, code: code };
    })
    .catch(() => {});
}
function sixpMaybeFetchWeather() {
  if (sixpWeatherFetched) return;
  sixpWeatherFetched = true;
  sixpFetchWeather();
  setInterval(sixpFetchWeather, 60 * 60 * 1000);
}

// Hands shift color with the time of day: whitish through the morning,
// a warm amber for evening, back to the standard dark wood tone for the
// One combined lookup for both the dial face AND the hands, so they're
// always deliberately complementary — light hands on a dark dial, dark
// hands on a light one — rather than two systems that could drift out
// of sync. True black at night, true white through the day, with warm
// transitional tones for dawn and evening.
function sixpColorsForHour(hour) {
  if (hour >= 21 || hour < 5) {
    return { face: ['#2a241a', '#1a1610', '#0c0a06'], hand: ['#f5f0e0', '#e0d5b8'], text: '#f0e8d0', tickMajor: '#e8dcb8', tickMinor: '#b8a878' }; // night — black dial, light lettering
  } else if (hour >= 5 && hour < 7) {
    return { face: ['#e8c8a0', '#d4a870', '#b8875a'], hand: ['#3a2a12', '#1a1206'], text: '#3d2a08', tickMajor: '#4d3608', tickMinor: '#8a6218' }; // dawn — soft peach
  } else if (hour >= 7 && hour < 17) {
    return { face: ['#fdfbf5', '#f6efd8', '#e9dcc0'], hand: ['#1a1206', '#000000'], text: '#3d2a08', tickMajor: '#4d3608', tickMinor: '#8a6218' }; // day — white dial, dark lettering
  } else {
    return { face: ['#e8a860', '#cf8740', '#a76a28'], hand: ['#2a1a08', '#140b04'], text: '#2a1a08', tickMajor: '#2a1a08', tickMinor: '#5a3f18' }; // evening — amber
  }
}
let sixpLastColorHour = -1;
function sixpUpdateClockColors(hour) {
  if (hour === sixpLastColorHour) return;
  sixpLastColorHour = hour;
  const { face, hand, text, tickMajor, tickMinor } = sixpColorsForHour(hour);
  const s1 = document.getElementById('vclk6HandGradStop1'), s2 = document.getElementById('vclk6HandGradStop2');
  if (s1) s1.setAttribute('stop-color', hand[0]);
  if (s2) s2.setAttribute('stop-color', hand[1]);
  const stops = document.querySelectorAll('#vclk6Face stop');
  if (stops.length >= 3) {
    stops[0].setAttribute('stop-color', face[0]);
    stops[1].setAttribute('stop-color', face[1]);
    stops[2].setAttribute('stop-color', face[2]);
  }
  document.querySelectorAll('.vclk6Numeral').forEach(el => el.setAttribute('fill', text));
  document.querySelectorAll('.vclk6CityText').forEach(el => el.setAttribute('fill', text));
  document.querySelectorAll('.vclk6Tick').forEach(el => {
    el.setAttribute('stroke', el.getAttribute('data-major') === '1' ? tickMajor : tickMinor);
  });
}

// The clock always shows ONE city's time — New York by default, or
// whichever city was last tapped. This persists until a different city
// is tapped; it does not auto-revert.
let sixpSelectedCity = { code: 'NYC', tz: 'America/New_York', lat: 40.7128, lon: -74.006 };
function sixpGetNowInTz(tz) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23' }).formatToParts(new Date());
  return {
    hour: parseInt(parts.find(p => p.type === 'hour').value, 10),
    minute: parseInt(parts.find(p => p.type === 'minute').value, 10),
    second: parseInt(parts.find(p => p.type === 'second').value, 10)
  };
}

function updateTableClock() {
  sixpWireCityClicks();
  sixpMaybeFetchWeather();
  const nowInCity = sixpGetNowInTz(sixpSelectedCity.tz);
  sixpUpdateClockColors(nowInCity.hour);
  sixpUpdateClockComplications(nowInCity, sixpSelectedCity);
  const hourEl = document.getElementById('vclk6HourHand'), minEl = document.getElementById('vclk6MinuteHand'), secEl = document.getElementById('vclk6SecondHand');
  if (!hourEl || !minEl) return;
  const hourAngle = ((nowInCity.hour % 12) + nowInCity.minute / 60) * 30;
  const minAngle = nowInCity.minute * 6;
  const secAngle = nowInCity.second * 6;
  hourEl.setAttribute('transform', 'rotate(' + hourAngle + ' 100 100)');
  minEl.setAttribute('transform', 'rotate(' + minAngle + ' 100 100)');
  if (secEl) secEl.setAttribute('transform', 'rotate(' + secAngle + ' 100 100)');

  const minuteMark = nowInCity.hour * 60 + nowInCity.minute;
  if (sixpClockLastMinuteMark !== -1 && minuteMark !== sixpClockLastMinuteMark) {
    sixpFlashClockHand(secEl);
    sixpFlashClockHand(minEl);
  }
  sixpClockLastMinuteMark = minuteMark;

  const hourMark = nowInCity.hour;
  if (sixpClockLastHourMark !== -1 && hourMark !== sixpClockLastHourMark) {
    sixpFlashClockHand(hourEl);
  }
  sixpClockLastHourMark = hourMark;
}
// The vintage clock face has been removed from the table (replaced by a plain wooden-rail
// oval matching the 4-player table's design) - disabling its driver here rather than tracing
// through every downstream function it calls (weather fetch, city click wiring, complications,
// hand rotation) is the safe way to retire it: those functions were written assuming the
// clock's DOM elements exist, and several touch the DOM before their own internal null-checks
// would catch a missing element. Not calling them at all avoids relying on every one of those
// checks being airtight.
// updateTableClock();
// setInterval(updateTableClock, 1000);

// Mirrors the 4-player table's score-box treatment exactly: pop-bounce on
// every value change, plus a continuous ambient green/red glow for
// whichever side is currently ahead in the match score (gameScore), with
// intensity scaling with how big the lead is. "Your Team" / "Opp Team"
// always means relative to MY_POS, not a fixed team index, since which
// raw team (0 or 1) is "mine" depends on which seat I'm sitting in.
function updateSixpScoreDisplay(state) {
  const myTeam = sixpGetTeam(MY_POS);
  const yScore = state.gameScore[myTeam];
  const oScore = state.gameScore[1 - myTeam];
  const ys = $('scoreA'), os = $('scoreB');
  const yBox = $('scoreBoxYours'), oBox = $('scoreBoxOpp');

  if (ys.textContent !== String(yScore)) {
    ys.textContent = yScore;
    ys.classList.remove('pop-anim');
    void ys.offsetWidth;
    ys.classList.add('pop-anim');
    setTimeout(() => ys.classList.remove('pop-anim'), 500);
  }
  if (os.textContent !== String(oScore)) {
    os.textContent = oScore;
    os.classList.remove('pop-anim');
    void os.offsetWidth;
    os.classList.add('pop-anim');
    setTimeout(() => os.classList.remove('pop-anim'), 500);
  }

  // Fixed convention now, not "whoever's currently ahead" - your box is always green,
  // opponent's always red, matching the same viewer-relative color convention used
  // elsewhere. Set once and left alone; nothing to recompute on every score change anymore.
  if (yBox) yBox.classList.add('you-box');
  if (oBox) oBox.classList.add('opp-box');
}
const SUIT_NAMES = { '♠': 'Spades', '♥': 'Hearts', '♦': 'Diamonds', '♣': 'Clubs' };
function suitName(suit) { return SUIT_NAMES[suit] || suit; }
// Relative label for any seat from MY_POS's point of view — a bot's name
// tells a player nothing about whether a bid is good or bad news for them.
function sixpRelLabel(pos, seats) {
  if (pos === MY_POS) return 'You';
  const seat = seats && seats[pos];
  const name = seat ? seat.name : null;
  const rel = sixpGetTeam(pos) === sixpGetTeam(MY_POS) ? 'your partner' : 'your opponent';
  return name ? rel + ' (' + name + ')' : rel;
}
// Renders the "so far this round" bid/pass list, in the order actions
// actually happened, using relative labels throughout.
function sixpRenderBidHistory(history, seats) {
  if (!history || !history.length) return '';
  const rows = history.map(h => {
    const who = sixpRelLabel(h.pos, seats);
    return h.bid > 0
      ? '<span style="color:var(--text-primary)">' + who + '</span> bid <b style="color:var(--accent)">' + h.bid + '</b>'
      : '<span style="color:var(--text-secondary)">' + who + ' passed</span>';
  });
  return '<div style="margin-top:8px;padding:8px 10px;background:rgba(255,255,255,0.04);border-radius:8px;font-size:0.72rem;line-height:1.6;text-align:left">' +
    '<b style="color:var(--text-secondary);font-size:0.65rem;letter-spacing:0.5px">SO FAR THIS ROUND</b><br>' +
    rows.join('<br>') + '</div>';
}
// Same pool the server picks from when auto-filling bot seats — kept in
// sync manually since this is just for the Change Bot picker's option
// list, not anything server-authoritative.
const BOT_NAME_POOL = ['Charlie', 'Wesley', 'Benson', 'Rahul', 'Anjali', 'Neha', 'Nate', 'Koshy', 'Meera', 'Priya', 'Sanjay', 'Johny', 'Vinod', 'Jean', 'Randall', 'Rajesh', 'Stev', 'Alok', 'Jerin', 'Binchu', 'Ajai', 'Peter', 'Shyam', 'Appu', 'Anup', 'Arun', 'Vilphy', 'Roji'];
let IS_HOST = false;
let pendingJoinCode = null;
let latestState = null;
let lastAnnouncedTrumpExposed = false;
let lastHiddenTrumpAutoFired6p = false; // see renderHand() -- guards the forced-last-card auto-play against firing more than once per turn
let lastMarkedWinnerRound = -1; // tracks which round's winning-bidder blink has already been applied, so it fires exactly once per round
let lastShownRoundVoidMessage = null;
let lastShownReshuffleReasonTs6p = null;
let lastShownPartnerSignalKey6p = null;
let lastShownEarlyWinChoice6p = false; // true while a popup is already showing for the CURRENT pendingEarlyWinChoice
let lastShownQuoteDeclaredForTeam6p = null; // which team's COT/MaruCOT declaration has already been announced this round
let lastSeenTricksPlayed = -1; // detects exactly when a new trick has just completed
let trickHoldBusy = false;     // a trick is currently mid-reveal (its full pause hasn't elapsed yet)
let sixpTrickRevealQueue = []; // completed tricks still waiting their turn — nothing in here is ever dropped
let lastRoundSeen = -1;
let roundTrickHistory = []; // every completed trick so far THIS round, for the "played so far" view
let roundHistorySeenFor = -1; // which round roundTrickHistory currently belongs to
let lastRenderedTrickSlot = [null, null, null, null, null, null]; // for the card-landing animation diff
let lastHapticCurrentPlayer = null; // tracks a genuine transition INTO my turn, not every re-render while it's already my turn
let lastAppliedTableId6p = null; // see applyState -- forces a full trick-slot reset the moment the table itself changes
let gameOverShownFor = false;

const SUITS = ['♠', '♦', '♥', '♣'];
// The order a hand gets arranged in on screen specifically - spades, diamonds, clubs, hearts.
// Deliberately separate from SUITS above (which is ♠♦♥♣, used elsewhere for things like trump
// selection) rather than reordering that shared constant, since this ordering is specific to
// how a hand displays, not a general suit-priority list.
const HAND_SUIT_ORDER = ['♠', '♦', '♣', '♥'];
const RANK_ORDER = { J: 8, '9': 7, A: 6, '10': 5, K: 4, Q: 3, '8': 2, '7': 1, '6': 0 };
const POINTS = { J: 3, '9': 2, A: 1, '10': 1, K: 0, Q: 0, '8': 0, '7': 0, '6': 0 };
const SUIT_ICON_ID = { '♠': 'spade', '♣': 'club', '♥': 'heart', '♦': 'diamond' };

function $(id) { return document.getElementById(id); }
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
  $(id).classList.remove('hidden');
}
function showToast(msg, kind, ms) {
  const el = document.createElement('div');
  el.textContent = msg;
  el.style.cssText = 'background:rgba(26,5,5,0.35);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);border:1.5px solid ' + (kind === 'lose' ? '#ff5c5c' : '#f4c430') + ';border-radius:12px;padding:8px 16px;color:' + (kind === 'lose' ? '#ff5c5c' : '#f4c430') + ';font-size:0.85rem;font-weight:700;white-space:nowrap;margin-bottom:8px;text-shadow:0 1px 3px rgba(0,0,0,0.8)';
  $('toastHost').appendChild(el);
  setTimeout(() => el.remove(), ms || 2000);
}

// Reusable "big moment" popup -- identical to index.html's own version,
// see there for the full reasoning.
// Small "actual playing card" HTML -- identical to index.html's own
// version, see there for the full reasoning.
function miniCardHtml(rank, suit) {
  const isRed = (suit === '♥' || suit === '♦');
  const ink = isRed ? '#d32f2f' : '#111';
  return `<div class="game-event-minicard"><div class="mc-rank" style="color:${ink}">${rank}</div><div class="mc-suit" style="color:${ink}">${suit}</div></div>`;
}

function showGameEvent(icon, title, detail, color, opts) {
  const overlay = document.createElement('div');
  overlay.className = 'game-event-overlay';
  overlay.style.setProperty('--evt-color', color);
  overlay.style.setProperty('--evt-glow', color + '66');
  const boxClass = 'game-event-box' + (opts && opts.trumpEvent ? ' trump-event' : '');
  const iconClass = 'game-event-icon' + (opts && opts.blackSuitIcon ? ' icon-black-suit' : '');
  // Trump-exposed gets a split title - "TRUMP" always gold, the second word always a metallic
  // silver-chrome regardless of which suit was exposed (the suit's own color lives entirely
  // in the icon symbol instead). Every other event type (Honors Bid, Raise, etc.) keeps a
  // plain single-color title exactly as before - this only branches for the trump case.
  const titleHtml = (opts && opts.splitTitle)
    ? title.split(' ').map((w, i) => `<span class="${i === 0 ? 'trump-word-gold' : 'trump-word-chrome'}">${w}</span>`).join(' ')
    : title;
  overlay.innerHTML = `<div class="${boxClass}">
    <div class="${iconClass}">${icon}</div>
    <div class="game-event-title">${titleHtml}</div>
    <div class="game-event-detail">${detail}</div>
  </div>`;
  document.body.appendChild(overlay);
  // Per explicit request: reshuffle/void-round events need to actually be readable, not just
  // glanced at - they explain something that just changed everyone's hand, not a quick flair
  // moment like a trump reveal. holdMs (defaulting to the original 2800/3250 pair when not
  // given) lets a caller ask for a longer, fully-visible period before the same fade-out
  // begins; the ~450ms gap between "start leaving" and "fully removed" stays constant either
  // way, since that's just the CSS transition duration, not part of the readable time itself.
  const holdMs = (opts && opts.holdMs) || 2800;
  setTimeout(() => overlay.classList.add('leaving'), holdMs);
  setTimeout(() => overlay.remove(), holdMs + 450);
}

// The 5-second vetoable kick popup -- see index.html's identical
// implementation for the full reasoning. Two different messages
// depending on which side of the kick you're on: the target gets the
// reject button, the admin who initiated it gets their own countdown.
let kickNoticeCountdownTimer = null;
function showKickNotice(info) {
  let el = document.getElementById('kickNoticeToast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'kickNoticeToast';
    el.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:3000;background:rgba(20,20,30,0.97);border:2px solid #e74c3c;border-radius:16px;padding:22px 26px;text-align:center;box-shadow:0 12px 40px rgba(0,0,0,0.6);min-width:240px;max-width:88vw';
    document.body.appendChild(el);
  }
  let remaining = info.seconds || 5;
  const render = () => {
    if (info.isInitiator) {
      el.innerHTML = `
        <div style="font-size:1.2rem;font-weight:800;color:#e74c3c;margin-bottom:6px">🚪 Kicking ${escapeHtml(info.targetName)}…</div>
        <div style="font-size:0.85rem;color:#ccc">They have ${remaining}s to fight back before it's final.</div>
      `;
    } else {
      el.innerHTML = `
        <div style="font-size:1.3rem;font-weight:800;color:#e74c3c;margin-bottom:6px">🚪 You've been kicked!</div>
        <div style="font-size:0.85rem;color:#ccc;margin-bottom:14px">Gone in ${remaining}s unless you fight back right now…</div>
        <button id="kickNoticeVetoBtn" style="padding:9px 22px;border-radius:8px;border:none;background:linear-gradient(135deg,#27ae60,#1e8449);color:#fff;font-weight:700;font-size:0.9rem;cursor:pointer">🙅 No way, I'm playing!</button>
      `;
      document.getElementById('kickNoticeVetoBtn').onclick = () => {
        socket.emit('sixp_vetoKick');
        hideKickNotice();
      };
    }
  };
  render();
  el.style.display = 'block';
  clearInterval(kickNoticeCountdownTimer);
  kickNoticeCountdownTimer = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) { clearInterval(kickNoticeCountdownTimer); return; }
    render();
  }, 1000);
}
function hideKickNotice() {
  clearInterval(kickNoticeCountdownTimer);
  const el = document.getElementById('kickNoticeToast');
  if (el) el.style.display = 'none';
}

function connectSocket() {
  if (socket) return;
  socket = io();
  if (window.K28Voice) K28Voice.attach(socket, { getName: () => MY_NAME || 'Player' });

  // Free-tier hosts (Render, etc.) put the whole server to sleep after a
  // stretch of no HTTP traffic -- and since every table lives in that
  // process's memory, waking it back up wipes them all out. Keep pinging
  // a lightweight endpoint so the server counts as "active" while this
  // tab is open. Same fix index.html already had.
  if (!window.__sixpKeepAlive) {
    window.__sixpKeepAlive = setInterval(() => {
      fetch('/status').catch(() => {});
    }, 4 * 60 * 1000);
  }

  socket.on('sixp_roomList', (rooms) => renderRoomList(rooms));

  // A real network drop can happen mid-hold or mid-staggered-reveal —
  // whatever local trick-rendering state existed at that exact instant
  // (trickHoldBusy stuck true, a stagger sequence half-finished, etc.)
  // has no way to recover on its own once the connection comes back,
  // since it was designed assuming a continuous, unbroken stream of
  // state updates. Treat every reconnect as a clean slate for rendering
  // purposes — the very next 'state' broadcast will draw the table
  // correctly from scratch regardless of whatever was happening before
  // the drop.
  let hasDisconnectedOnce6p = false;
  socket.on('connect', () => {
    trickHoldBusy = false;
    sixpTrickRevealQueue = [];
    lastRenderedTrickSlot = [null, null, null, null, null, null];
    sixpCatchUpGen++;
    if (MY_TABLE_ID && MY_PLAYER_ID) {
      socket.emit('sixp_joinTable', { tableId: MY_TABLE_ID, playerId: MY_PLAYER_ID });
    }
    // The "connection lost" toast never had a matching "you're back"
    // confirmation -- meaning even a perfectly successful reconnect
    // gave the player no positive signal anything actually recovered.
    // Only shown for a real recovery, not the very first page load.
    if (hasDisconnectedOnce6p) {
      showToast('✅ Reconnected!', 'win', 2000);
    }
  });
  socket.on('disconnect', () => {
    hasDisconnectedOnce6p = true;
    showToast('⚠️ Lost connection to server — trying to reconnect...', 'lose', 3000);
  });

  // The connect handler above only fires if Socket.IO's own reconnection
  // timers get a chance to run at all -- but mobile browsers routinely
  // fully suspend JavaScript execution in a backgrounded tab, meaning
  // those timers can simply never fire while the tab is away. Checking
  // explicitly the instant the tab becomes visible again catches this
  // immediately instead of waiting on a timer that was never going to run.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      // Per explicit request: fired immediately, before the health-ping
      // round-trip below even starts -- that existing check can take a
      // moment (ping + possible reconnect + rejoin), and an already-
      // scheduled bot-takeover timer for this seat's turn doesn't wait
      // for any of that to finish. This is a direct, fire-and-forget
      // "I'm back" signal that resets the stuck-turn clock the instant
      // the tab is visible again, independent of whether the socket
      // itself ever actually needed reconnecting at all. Harmless if
      // it isn't genuinely this player's turn right now -- see
      // reclaimTurn() in game-engine-6p.js.
      if (socket && socket.connected) socket.emit('sixp_reclaimTurn');
      // Trusting socket.connected alone here was the actual gap:
      // repeatedly switching apps ("in and out of network a few times")
      // was reported to leave a tab permanently zombied -- looking
      // connected client-side, receiving nothing -- even though the SAME
      // table was completely fine and playable from a different
      // browser/session at the same time, proof the server-side game was
      // never actually stuck. A single hidden stretch or a flag that can
      // lie isn't a reliable enough signal on its own. This asks the
      // server directly instead: a real round-trip acknowledgment
      // (healthPing, handled in the shared connection block in
      // server.js -- works the same for every game on this server), with
      // a short timeout. Only a genuine, current response counts as
      // "still connected"; no ack in time means force a fresh connection.
      if (!socket.connected) {
        socket.connect();
        return;
      }
      let settled = false;
      const forceReconnect = () => {
        if (settled) return;
        settled = true;
        try { socket.disconnect(); } catch (e) {}
        socket.connect();
      };
      const healthCheckTimeout = setTimeout(forceReconnect, 3000);
      socket.emit('healthPing', () => {
        if (settled) return; // the 3s timeout already fired and force-reconnected
        settled = true;
        clearTimeout(healthCheckTimeout);
        if (MY_TABLE_ID && MY_PLAYER_ID) {
          socket.emit('sixp_joinTable', { tableId: MY_TABLE_ID, playerId: MY_PLAYER_ID });
        }
      });
    }
  });

  socket.on('sixp_joined', (info) => {
    isAutoReconnectAttempt6p = false;
    MY_TABLE_ID = info.tableId;
    MY_PLAYER_ID = info.playerId;
    MY_POS = info.pos;
    IS_HOST = info.isHost;
    try {
      localStorage.setItem('k28six_player_token', info.playerId);
      localStorage.setItem('k28six_table_id', info.tableId);
      localStorage.setItem('k28six_session_time', String(Date.now()));
    } catch (e) {}
    $('seatPickerOverlay').classList.remove('on');
    showScreen('lobbyScreen');
    $('roomCodeDisplay').textContent = info.tableId;
  });

  socket.on('sixp_joinError', (err) => {
    if (isAutoReconnectAttempt6p) {
      isAutoReconnectAttempt6p = false;
      try {
        localStorage.removeItem('k28six_table_id');
        localStorage.removeItem('k28six_session_time');
      } catch (e) {}
      // Genuine reconnect failures like this are almost always the
      // server having been restarted for a deployment -- which wipes
      // every in-memory table, since none of that state is persisted to
      // disk. The generic "that code doesn't exist" wording below is
      // meant for someone mistyping a room code by hand, not this --
      // this deserves an actual apology and a clear next step.
      alert('😔 We\'re sorry — the server was recently updated, which means your previous game session was lost in the process.\n\nThis wasn\'t anything you did wrong. Please log back in and create or join a table to keep playing. Thanks for your patience!');
      return;
    }
    const messages = {
      table_full: 'That table is already full.',
      seat_taken: 'Someone just took that seat — pick another.',
      not_a_bot_seat: "That seat isn't a bot anymore — pick another.",
      replace_failed: 'Could not take that seat — pick another.'
    };
    // Per explicit request: table_not_found gets its own clearer,
    // dedicated popup instead of folding into the same generic toast
    // as every other join error -- see #roomGoneOverlay for the
    // fuller reasoning.
    if (err.reason === 'table_not_found') {
      $('roomGoneOverlay').classList.add('on');
      return;
    }
    showToast('❌ ' + (messages[err.reason] || 'Could not join.'), 'lose', 2500);
  });

  // Per explicit request: OK on the "room no longer available" popup
  // Real, confirmed fix per explicit follow-up report: this used to
  // land back on the welcome screen, not the actual create-a-room
  // screen (name + avatar entry) the popup's own message points to --
  // matches the 4-player table's identical fix. Deliberately does NOT
  // set pendingJoinCode/pendingAction/the invite banner the way a real
  // invite link does above -- there's no live invite to honor anymore,
  // this is a brand new room, not a rejoin attempt on the dead one.
  const btnRoomGoneOk = $('btnRoomGoneOk');
  if (btnRoomGoneOk) {
    btnRoomGoneOk.addEventListener('click', () => {
      $('roomGoneOverlay').classList.remove('on');
      showScreen('nameScreen');
    });
  }

  socket.on('sixp_actionError', (err) => {
    console.log('[server] action rejected:', err.reason);
    // Short, specific messages per rejection reason instead of one generic "that card can't
    // be played right now" for every case - the person gets an actual explanation of why,
    // not just that something went wrong. Kept brief and quick (1.4s) like the other toasts,
    // not a long-winded popup.
    const REASON_MESSAGES = {
      must_follow_suit: "You must follow suit",
      must_play_trump: "You called for trump — you must cut",
      bidder_hidden_trump: "You're the bidder — trump stays hidden until asked for",
      not_your_turn: "It's not your turn",
      not_playing: "Not in the play phase right now",
      not_in_hand: "That card isn't in your hand",
    };
    const msg = REASON_MESSAGES[err.reason] || err.reason || "That action can't be done right now";
    showToast('⚠️ ' + msg, 'lose', 1400);
  });

  socket.on('sixp_chooseSeat', (info) => showSeatPicker(info));

  socket.on('sixp_kicked', () => {
    // Same fix as index.html's identical handler -- the countdown/veto
    // popup was still showing right up until this exact moment and
    // needs to be explicitly dismissed, or it just stays frozen on
    // screen underneath the home screen leaveToWelcome() navigates back
    // to. The toast below already correctly lingers a few seconds on
    // its own past that transition.
    hideKickNotice();
    showToast('You were removed from the table by the host.', 'lose', 3000);
    leaveToWelcome();
  });

  // The 5-second vetoable kick -- same event names/pattern as the
  // 4-player table (server.js emits these unprefixed on every table,
  // same as the existing 'kicked' event already was), just the veto
  // itself needs this table's own 'sixp_vetoKick' emit to reach the
  // right handler server-side.
  socket.on('kickPending', (info) => showKickNotice(info));
  socket.on('kickVetoedSelf', () => {
    hideKickNotice();
    showToast("😅 Phew — you're staying at the table!", 'win', 2500);
  });
  socket.on('kickVetoedByTarget', ({ name }) => {
    hideKickNotice();
    showToast(`✋ ${name} said no — they're staying.`, 'info', 3000);
  });
  socket.on('kickProceeded', ({ targetName }) => {
    hideKickNotice();
    showToast(`🚪 ${targetName} has been removed from the table.`, 'info', 3000);
  });

  socket.on('sixp_state', (state) => {
    // Same stray-state rejection as the 4-player table: only render
    // states for the table we're actually at.
    if (state && state.tableId && MY_TABLE_ID && state.tableId !== MY_TABLE_ID) return;
    applyState(state);
    // Per explicit request: mirrors the 4-player table's identical
    // hook -- the live game state changing at all is exactly the
    // "whatever is live" moment the idle screensaver should snap back
    // for. No-op whenever the screensaver isn't currently running.
    if (typeof window.k28WakeTableScreensaver6p === 'function') window.k28WakeTableScreensaver6p();
  });

  socket.on('sixp_chat', ({ from, msg, senderId }) => {
    addChatMessage(from, msg, senderId === socket.id);
  });

  // Per explicit instruction: same feature as index.html's identical
  // handler, see there for the fuller reasoning -- only shows for the
  // two people actually involved, not the whole table.
  socket.on('sixp_buddyGreeting', ({ fromPos, toPos }) => {
    // fromPos is the clicker, toPos is whose avatar got clicked -- but
    // the MESSAGE is written the other way around (as if the clicked
    // player is greeting the clicker), so {from}/{to} in the template
    // are the reverse of the socket's fromPos/toPos.
    if (MY_POS === fromPos || MY_POS === toPos) {
      const nameAt = (pos) => (pos === MY_POS ? (MY_NAME || 'You') : ((latestState && latestState.seats[pos] && latestState.seats[pos].name) || 'Someone'));
      window.showBuddyGreeting(nameAt(toPos), nameAt(fromPos));
    }
  });

  // Per explicit instruction: a nice, visible popup for everyone
  // already seated when someone new joins -- reuses the same
  // showGameEvent "big moment" popup already used elsewhere on this
  // table (bid made/failed, trump exposed) rather than a plain toast,
  // so this reads as a genuinely welcoming moment, not routine text.
  socket.on('sixp_playerJoinedNotice', ({ name }) => {
    showGameEvent('👋', 'New Player!', (name || 'Someone') + ' just joined the table', '#f4c430');
  });

  // Mirrors the join popup above, for the other direction -- fires the
  // same moment the departing seat's avatar ring flips red (isBot
  // becomes true server-side), so the departure is just as visible as
  // an arrival rather than only a passive border color change.
  socket.on('sixp_playerLeftNotice', ({ name }) => {
    showGameEvent('🔌', 'Player Left', (name || 'Someone') + ' left the table — a bot has taken over', '#e74c3c');
  });

  socket.on('sixp_stillPlayingCheck', ({ seconds }) => showStillPlayingPopup(seconds || 60));
  socket.on('sixp_stillPlayingResolved', () => hideStillPlayingPopup());
  socket.on('sixp_tableClosed', ({ reason }) => {
    hideStillPlayingPopup();
    const msg = reason === 'idle' ? '⏱️ Table closed — nobody confirmed they were still there'
      : reason === 'lastPlayerLeft' ? '🚪 Table closed — no real players left'
      : 'Table closed';
    showToast(msg, 'lose', 4000);
    leaveToWelcome();
  });
  socket.on('createBlocked', ({ maxRooms }) => {
    showToast(`🚧 Room Restricted for now to ${maxRooms} — will reopen in a few.`, 'lose', 4000);
  });
}
connectSocket(); // connect right away so every landing on this page gets logged as a visitor, not just the ones who go on to create/join a table

// ---------------- Welcome / name / create / join flow ----------------

let pendingAction = null; // 'create' | 'join'

$('btnCreate').addEventListener('click', () => {
  pendingAction = 'create';
  const inviteBanner6pCreate = $('inviteBanner6p');
  if (inviteBanner6pCreate) inviteBanner6pCreate.classList.add('hidden');
  showScreen('nameScreen');
});
$('btnShowJoin').addEventListener('click', () => { showScreen('joinScreen'); refreshRoomList(); });
$('btnNameBack').addEventListener('click', () => showScreen('welcomeScreen'));
$('btnNameContinue').addEventListener('click', submitPlayerName6p);
// Real bug fix, per explicit report: hitting Enter/"Go" on the mobile
// keyboard while in this field did nothing at all -- same fix as
// index.html's identical addition.
$('nameInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); submitPlayerName6p(); }
});
async function submitPlayerName6p() {
  const name = $('nameInput').value.trim();
  if (!name || name.length < 2) {
    showToast('Enter a name (2+ chars)', 'lose', 1500);
    return;
  }
  // Per explicit request: same auto-match + PIN-gate as index.html's
  // identical addition, see there for the fuller reasoning.
  const matchedAvatar = PROTECTED_NAME_TO_AVATAR[name.toLowerCase()];
  if (matchedAvatar) {
    if (!(await checkAvatarPin(matchedAvatar))) return;
    MY_AVATAR_KEY = matchedAvatar;
    try { localStorage.setItem('k28_player_avatar', matchedAvatar); } catch (e) {}
  }
  MY_NAME = name;
  const inviteBanner6pDone = $('inviteBanner6p');
  if (inviteBanner6pDone) inviteBanner6pDone.classList.add('hidden');
  requestFullscreen6p();
  connectSocket();
  if (pendingAction === 'create') {
    socket.emit('sixp_createTable', { name, avatar: MY_AVATAR_KEY });
  } else if (pendingAction === 'join' && pendingJoinCode) {
    socket.emit('sixp_joinTable', { tableId: pendingJoinCode, name, avatar: MY_AVATAR_KEY });
  }
}
$('btnJoinBack').addEventListener('click', () => showScreen('welcomeScreen'));
$('btnJoinByCode').addEventListener('click', () => {
  const code = $('joinCodeInput').value.trim().toUpperCase();
  if (!code) { showToast('Enter a room code first', 'lose', 1500); return; }
  pendingJoinCode = code;
  pendingAction = 'join';
  const inviteBanner6pManual = $('inviteBanner6p');
  if (inviteBanner6pManual) inviteBanner6pManual.classList.add('hidden');
  showScreen('nameScreen');
});

function refreshRoomList() {
  connectSocket();
  socket.emit('sixp_listRooms');
}
function renderRoomList(rooms) {
  // Populates BOTH the existing joinScreen list and the one on the main
  // welcomeScreen itself -- previously this list only ever showed up
  // after clicking "Join Table" first, tucked away on a separate
  // screen, unlike the 4-player table which shows its running-tables
  // list directly on the main menu. Same live data, same click-to-join
  // behavior, just also visible immediately without that extra step.
  const targets = [$('roomList'), $('welcomeRoomList')].filter(Boolean);
  if (!targets.length) return;
  const html = !rooms.length
    ? '<div style="color:var(--text-secondary);font-size:0.8rem;padding:10px">No open tables right now.</div>'
    : rooms.map(r => `
    <div class="room-row">
      <div><b>${escapeHtml(r.name)}</b><br><span style="color:var(--text-secondary)">${r.players}/6 · ${r.isPlaying ? 'Playing' : 'Lobby'}</span></div>
      <button class="btn btn-outline" style="width:auto;margin:0;padding:8px 14px" data-code="${r.tableId}" ${r.canJoinSeat ? '' : 'disabled'}>JOIN</button>
    </div>`).join('');
  for (const list of targets) {
    list.innerHTML = html;
    list.querySelectorAll('button[data-code]').forEach(btn => {
      btn.addEventListener('click', () => {
        pendingJoinCode = btn.getAttribute('data-code');
        pendingAction = 'join';
        const inviteBanner6pList = $('inviteBanner6p');
        if (inviteBanner6pList) inviteBanner6pList.classList.add('hidden');
        showScreen('nameScreen');
      });
    });
  }
}
function escapeHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

// Turns any URL-looking text in an ALREADY-escaped chat message into a
// real, clickable link. Order matters -- this must only ever run on
// text already through escapeHtml(), never the reverse. Quotes are
// re-escaped here specifically for the href attribute, independent of
// whatever escapeHtml above already did -- that one only encodes
// &, <, > (via textContent -> innerHTML serialization), not quotes,
// since quotes aren't syntactically special in plain text content.
// Without this, a literal " in a URL could break straight out of the
// href="..." attribute and inject a live, working event-handler
// attribute onto the link (confirmed exploitable before this was
// added). target="_blank" is the actual point of this feature: opens
// in a new tab instead of navigating the current one away, so clicking
// a link in table chat can never disconnect anyone from the game.
function linkifyEscaped(escapedText) {
  return escapedText.replace(/(https?:\/\/[^\s<]+|www\.[^\s<]+)/gi, (raw) => {
    let url = raw;
    let trailing = '';
    const trailMatch = url.match(/([.,!?;:)\]]+)$/);
    if (trailMatch) { trailing = trailMatch[1]; url = url.slice(0, -trailing.length); }
    if (!url) return raw;
    const href = /^https?:\/\//i.test(url) ? url : 'https://' + url;
    const hrefSafe = href.replace(/"/g, '&quot;');
    return `<a href="${hrefSafe}" target="_blank" rel="noopener noreferrer" style="color:#6db3ff;text-decoration:underline;word-break:break-all">${url}</a>${trailing}`;
  });
}

// ---------------- Seat picker ----------------

function showSeatPicker(info) {
  const body = $('seatPickerBody');
  body.innerHTML = '';
  const opts = $('seatPickerOptions');

  const openSet = new Set(info.openSeats);
  const botSet = new Set(info.botSeats);
  const discMap = new Map(info.disconnectedSeats.map(d => [d.pos, d.name]));
  const seatsByPos = info.seats;

  function kindFor(pos) {
    if (openSet.has(pos)) return 'open';
    if (discMap.has(pos)) return 'disconnected';
    if (botSet.has(pos)) return 'bot';
    return 'taken';
  }

  // Same absolute oval layout the real table uses (SLOT_POS), just not
  // rotated to any particular viewer yet since you're not seated —
  // seat 1 at the bottom working clockwise, exactly like it'll look
  // once you're actually playing.
  let diagram = '<div class="mini-table-wrap"><div class="mini-table-surface"></div>';
  for (let pos = 0; pos < 6; pos++) {
    const p = SLOT_POS[pos];
    const seat = seatsByPos[pos];
    const kind = kindFor(pos);
    const clickable = kind !== 'taken';
    const team = (pos % 2 === 0) ? 'A' : 'B';
    const label = kind === 'open' ? 'Open'
      : kind === 'bot' ? `🤖 ${escapeHtml(seat ? seat.name : 'Bot')}`
      : kind === 'disconnected' ? `🔌 ${escapeHtml(discMap.get(pos))}`
      : (seat ? escapeHtml(seat.name) : '');
    const hostTag = seat && seat.isHost ? ' 👑' : '';
    diagram += `<div class="mini-seat six team-${team} ${clickable ? 'clickable' : 'blocked'}" style="left:${p.left};top:${p.top}" ${clickable ? `onclick="socket.emit('sixp_claimSeat',{choice:${pos}})"` : ''}>
      <div class="mini-seat-num">Seat ${pos + 1}</div>
      <div class="mini-seat-label">${label}${hostTag}</div>
    </div>`;
  }
  diagram += '</div>';
  diagram += '<div class="mini-table-legend"><span><i class="dot open"></i>Open</span><span><i class="dot bot"></i>Replace bot</span><span><i class="dot disc"></i>Reclaim</span><span><i class="dot taken"></i>Taken</span></div>';
  diagram += '<div style="font-size:0.7rem;opacity:0.7;margin-top:6px">Seats 1‑3‑5 are one team, 2‑4‑6 are the other.</div>';

  opts.innerHTML = diagram;
  $('seatPickerOverlay').classList.add('on');
}

// ---------------- Lobby ----------------

$('btnLeaveLobby').addEventListener('click', leaveToWelcome);
$('btnGameOverLeave').addEventListener('click', leaveToWelcome);
function leaveToWelcome() {
  if (window.K28Voice) K28Voice.hideButton();
  if (socket) socket.emit('sixp_leaveTable');
  try {
    localStorage.removeItem('k28six_table_id');
    localStorage.removeItem('k28six_session_time');
  } catch (e) {}
  MY_TABLE_ID = null;
  document.querySelectorAll('.modal-overlay,.overlay').forEach(o => o.classList.remove('on'));
  $('gameScreen').style.display = 'none';
  showScreen('welcomeScreen');
  // Leaving doesn't reload the page here (unlike some other tables in
  // this app), so fullscreen wouldn't otherwise drop on its own --
  // exit it explicitly instead of leaving someone stuck in it back on
  // the welcome screen. Safe no-op if fullscreen was never entered.
  try {
    if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
  } catch (e) {}
}

const botSelect = $('botFillSelect');
for (let i = 0; i <= 5; i++) { const o = document.createElement('option'); o.value = i; o.textContent = i + ' bots'; botSelect.appendChild(o); }
botSelect.value = 5;

$('btnStartGame').addEventListener('click', () => {
  socket.emit('sixp_fillBots', { count: parseInt(botSelect.value, 10) });
  socket.emit('sixp_startGame');
});

function renderLobby(state) {
  const seated = state.seats.filter(Boolean).length;
  $('lobbySub').textContent = `${seated}/6 players`;
  $('lobbyPlayerList').innerHTML = state.seats.filter(Boolean).map((s, i) => {
    const realIdx = state.seats.indexOf(s);
    return `<div style="display:flex;justify-content:space-between;padding:8px 12px;background:var(--panel);border-radius:8px;margin-bottom:6px;font-size:0.82rem">
      <span>${s.isBot ? '🤖' : '👤'} ${escapeHtml(s.name)}</span>
      <span style="color:var(--accent)">${realIdx === MY_POS ? 'YOU' : ''}</span>
    </div>`;
  }).join('');
  $('btnStartGame').style.display = IS_HOST ? 'flex' : 'none';
  $('botFillRow').style.display = IS_HOST ? 'flex' : 'none';
}

// ---------------- Main state application ----------------

function applyState(state) {
  // Detect any genuinely new bid entries (not passes, and never the
  // forced opening bid at index 0) to fire a big event for a real raise
  // or an honors-level bid -- same logic as index.html's identical
  // detection, just reading straight from state.seats since six.js
  // doesn't keep a separate bidHistory global the way index.html does.
  // Must run BEFORE latestState gets overwritten just below, since it
  // compares against the previous state's own bidHistory.

  latestState = state;

  // A genuinely different table (not just a new round on the SAME table)
  // is a much more definitive signal than any per-field staleness check
  // further down could ever be -- leaving one table and starting a
  // completely different one could leave a leftover card from the old
  // table's last trick visually stuck on screen, since nothing had told
  // the renderer anything actually changed. Directly clearing every slot
  // element here (not just resetting the tracking array) matters: if the
  // NEW table's own first real state also wants an empty slot (the
  // common case, nothing played yet), a reset tracker comparing
  // null===null would still skip the actual DOM-clearing step in
  // renderTrickSlots below.
  if (MY_TABLE_ID && MY_TABLE_ID !== lastAppliedTableId6p) {
    lastAppliedTableId6p = MY_TABLE_ID;
    lastRenderedTrickSlot = [null, null, null, null, null, null];
    for (let i = 0; i < 6; i++) {
      const slotEl = document.getElementById('trickSlot' + i);
      if (slotEl) slotEl.innerHTML = '';
    }
  }

  if (state.roundVoidMessage && state.roundVoidMessage !== lastShownRoundVoidMessage) {
    lastShownRoundVoidMessage = state.roundVoidMessage;
    showToast('🚫 ' + state.roundVoidMessage, 'lose', 3500);
  } else if (!state.roundVoidMessage) {
    lastShownRoundVoidMessage = null;
  }

  // Same event as the 4-player table's reshuffleReason -- explains why
  // everyone's hand suddenly changed (all four Jacks in one hand, the
  // first bidder stuck with an unplayable hand of nothing but 7s/8s,
  // the whole defending side holding zero trump, or anyone dealt a
  // hand of nothing but 6s/7s/8s). ts makes each event unique even if
  // the exact same situation repeats.
  // Per explicit request: switched from the small, generic showToast to the same "big
  // moment" showGameEvent overlay already used for trump reveals and honors bids elsewhere
  // in this file - a reshuffle changes everyone's hand and deserves the same visual weight,
  // not a quiet corner notification easy to miss. Each reason gets its own icon, color, and
  // specific wording rather than one shared generic message, and holdMs is set well past 5s
  // of fully-visible time since this needs to actually be read, not just glimpsed.
  if (state.reshuffleReason && state.reshuffleReason.ts !== lastShownReshuffleReasonTs6p) {
    lastShownReshuffleReasonTs6p = state.reshuffleReason.ts;
    const r = state.reshuffleReason;
    let icon, title, detail, color;
    if (r.type === 'all78') {
      icon = '😬'; title = 'Unplayable Hand!';
      detail = `${escapeHtml(r.name)} was forced to bid with nothing but 7s and 8s — reshuffling with the same dealer.`;
      color = '#e67e22';
    } else if (r.type === 'allJacks') {
      icon = '🃏'; title = 'All Four Jacks!';
      detail = `${escapeHtml(r.name)} was dealt every single Jack in one hand — reshuffling with the same dealer.`;
      color = '#f4c430';
    } else if (r.type === 'all678') {
      icon = '💤'; title = 'Dead Hand!';
      detail = `${escapeHtml(r.name)} was dealt nothing but 6s, 7s, and 8s — not a single card worth playing. Reshuffling with the same dealer.`;
      color = '#95a5a6';
    } else if (r.type === 'noTrump') {
      icon = '🚫'; title = 'No Trump To Contest!';
      detail = `The defending team holds zero ${escapeHtml(r.suit || '')} between them — nothing to fight over. Round voided, same dealer.`;
      color = '#e74c3c';
    }
    if (title) showGameEvent(icon, title, detail, color, { holdMs: 5200 });
  }

  const mySignal6p = state.partnerSignals && state.partnerSignals[MY_POS];
  const mySignalKey6p = mySignal6p ? (mySignal6p.fromSeat + ':' + mySignal6p.signal + ':' + mySignal6p.forRound) : null;
  if (mySignalKey6p && mySignalKey6p !== lastShownPartnerSignalKey6p) {
    lastShownPartnerSignalKey6p = mySignalKey6p;
    const label = mySignal6p.signal === 'same' ? 'bid the same as usual' : mySignal6p.signal === 'higher' ? 'bid more aggressively' : 'bid less aggressively';
    showToast(`💬 ${mySignal6p.fromName} signals: ${label} next hand`, 'info', 4000);
  } else if (!mySignalKey6p) {
    lastShownPartnerSignalKey6p = null;
  }

  // Each of these is wrapped individually rather than left to run bare: renderHand() (which
  // actually draws the clickable cards with their tap handlers) runs later in this same
  // function, and if any handler between here and there throws, renderHand() never runs for
  // this update - the hand keeps showing whatever it last successfully rendered, looking
  // completely normal while doing nothing when tapped, since the server has already moved on.
  // This exact failure mode has a documented precedent in this file already (see the comment
  // in canPlay() about a past bug with the same "looks fine, does nothing" symptom) - a
  // rendering glitch in a toast/popup should never be able to freeze actual gameplay.
  try { handleEarlyWinPopup(state); } catch (e) { console.error('[handleEarlyWinPopup] threw:', e); }
  try { updateQuoteButton(state); } catch (e) { console.error('[updateQuoteButton] threw:', e); }
  try { updateAskMidTrickButton(state); } catch (e) { console.error('[updateAskMidTrickButton] threw:', e); }
  try { handleQuoteDeclaredToast(state); } catch (e) { console.error('[handleQuoteDeclaredToast] threw:', e); }
  try { handleMidTrickQuoteOffer(state); } catch (e) { console.error('[handleMidTrickQuoteOffer] threw:', e); }

  if (state.phase === 'lobby') {
    $('gameScreen').style.display = 'none';
    document.querySelector('.link-back').style.display = 'block';
    showScreen('lobbyScreen');
    $('roomCodeDisplay').textContent = MY_TABLE_ID;
    renderLobby(state);
    if (window.K28Voice) K28Voice.hideButton();
    return;
  }

  // Any non-lobby phase means we're in the game screen.
  document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
  $('gameScreen').style.display = 'block';
  if (window.K28Voice) K28Voice.showButton();
  document.querySelector('.link-back').style.display = 'none'; // was overlapping the info bar during play

  $('roundNum').textContent = state.round;
  try { updateSixpScoreDisplay(state); } catch (e) { console.error('[updateSixpScoreDisplay] threw:', e); }
  $('btnHostMenu').style.display = IS_HOST ? 'inline-flex' : 'none';

  try {
    const dealerSeat = state.seats[state.dealer];
    $('dealerDisplay').textContent = state.dealer === MY_POS ? 'You' : (dealerSeat ? dealerSeat.name : '—');
    const bidderSeat = state.bidder >= 0 ? state.seats[state.bidder] : null;
    $('bidderDisplay').textContent = bidderSeat
      ? (state.bidder === MY_POS ? 'You' : bidderSeat.name) + (state.highestBid > 0 ? ' (' + (state.highestBid >= 29 ? 'THANI' : state.highestBid) + ')' : '')
      : '—';
    // Points display: always YOUR team's number first and in green, the opponents' second and
    // in red - previously this was hardcoded teamPoints[0]-then-[1] regardless of which team
    // the viewer was actually on, so a Team-1 player would see the opponent's total listed
    // first and everything in one flat color, backwards from their own perspective. Every
    // player at the table now sees this consistently framed as "mine, then theirs," matching
    // the same viewer-relative convention already used for the round-end popup.
    const tp = $('teamPointsDisplay');
    const myTeam = sixpGetTeam(MY_POS);
    const myPts = state.teamPoints ? state.teamPoints[myTeam] : 0;
    const oppPts = state.teamPoints ? state.teamPoints[1 - myTeam] : 0;
    const rawVal = myPts + '-' + oppPts;
    if (tp.dataset.rawVal !== rawVal) {
      tp.dataset.rawVal = rawVal;
      tp.innerHTML = `<span style="color:var(--success)">${myPts}</span> - <span style="color:var(--danger)">${oppPts}</span>`;
      tp.classList.remove('pop-anim');
      void tp.offsetWidth;
      tp.classList.add('pop-anim');
      setTimeout(() => tp.classList.remove('pop-anim'), 500);
    }
  } catch (e) { console.error('[dealer/bidder/points display] threw:', e); }
  try { renderLastTrick(state); } catch (e) { console.error('[renderLastTrick] threw:', e); }

  // The trump-exposed block below is a large, multi-step DOM/animation sequence (chip text,
  // toast, table-wide pop/shake/glow) - exactly the kind of thing a rendering glitch could
  // hide inside. Wrapped as a whole rather than every line individually, but the effect is the
  // same: nothing in here can prevent renderHand() (further down this same function) from
  // running for this update.
  try {
    const tr = $('trumpChip');
    if (state.trumpExposed) {
      // Suit symbol instead of a dartboard emoji, colored to match the actual suit (red for
      // diamonds/hearts, a clean dark tone for clubs/spades) rather than a generic accent
      // color unrelated to what's actually being announced.
      // "Trump" in gold, the suit name in a metallic silver-chrome regardless of which suit
      // (matching the same convention as the popup banner), and the suit symbol icon colored
      // red for hearts/diamonds or real black (with a light outline for contrast against the
      // now-transparent chip) for spades/clubs.
      const isRedSuit = state.trumpSuit === '♦' || state.trumpSuit === '♥';
      const iconClass = 'trump-chip-icon' + (isRedSuit ? ' icon-red-suit' : ' icon-black-suit-chip');
      // "Dice" specifically for diamonds in this one chip only - a local naming preference for
      // this particular display, not a change to the suit's name everywhere else in the game
      // (toasts, the big trump-exposed banner, bid announcements all still say "Diamonds").
      // Just "Trump [heartbeating icon] [bid number]" now, per explicit request - dropped the
      // spelled-out suit name text entirely (it was doing double duty with the icon, which
      // already conveys the suit on its own), and added the actual bid amount so this chip
      // carries genuinely new information instead of repeating the suit twice.
      tr.innerHTML = '<span class="trump-word-gold">Trump</span> <span class="' + iconClass + '">' + state.trumpSuit + '</span> <span class="trump-word-chrome">' + state.highestBid + '</span>';
      tr.style.color = '';
      tr.classList.add('trump-active');
      if (!lastAnnouncedTrumpExposed) {
        // Same fix as the 4-player table: a brief, deliberate pause before
        // the announcement rather than firing in the exact same instant
        // the card lands, which effectively covered up the very card that
        // just caused it with no moment to register what happened first.
        const exposedSuitAtCall = state.trumpSuit;
        const rc = state.revealedTrumpCard;
        const trumpDetail = rc ? miniCardHtml(rc.rank, rc.suit) : (exposedSuitAtCall + ' ' + suitName(exposedSuitAtCall));
        setTimeout(() => {
          showToast(exposedSuitAtCall + ' Trump exposed: ' + suitName(exposedSuitAtCall) + '!', 'win', 2200);
          // Real suit symbol as the icon instead of a generic emoji, and the color matches
          // the actual suit that was exposed instead of one fixed purple regardless of suit -
          // same window size as before (showGameEvent's box dimensions are untouched), just a
          // more precise, less cartoonish look for what's actually being announced.
          const isRedSuitForIcon = exposedSuitAtCall === '♦' || exposedSuitAtCall === '♥';
          const popupSuitColor = isRedSuitForIcon ? '#dc2626' : '#e2e8f0';
          showGameEvent(exposedSuitAtCall, 'Trump Exposed', trumpDetail, popupSuitColor, {
            trumpEvent: true, splitTitle: true, blackSuitIcon: !isRedSuitForIcon
          });
          playHaptic('trumpExposed');
        }, 550);
        // Same table-wide pop/shake/glow reveal as the 4-player table - see the CSS comment
        // next to .table-oval.trump-exposed for why this touches two elements at once.
        const ovalEl = document.querySelector('.table-oval');
        const railEl = document.querySelector('.six-oval-rail');
        if (ovalEl && railEl) {
          ovalEl.classList.remove('trump-exposed'); railEl.classList.remove('trump-exposed');
          void ovalEl.offsetWidth; // force reflow so re-adding the class restarts the animation
          ovalEl.classList.add('trump-exposed'); railEl.classList.add('trump-exposed');
          setTimeout(() => { ovalEl.classList.remove('trump-exposed'); railEl.classList.remove('trump-exposed'); }, 5000);
        }
      }
      lastAnnouncedTrumpExposed = true;
    } else if (state.bidder === MY_POS && state.myHiddenTrumpCard && state.myHiddenTrumpCard.suit) {
      // Per explicit instruction: the bidder already knows their own
      // hidden trump suit (they're the one who chose it), so there's
      // no real secrecy left to protect by showing them the same
      // generic "Hidden" every other player sees. Gated explicitly on
      // state.bidder === MY_POS (not just on myHiddenTrumpCard being
      // populated, even though the server should already only ever
      // send that field to the bidder themselves) to be doubly certain
      // this can never show the suit to anyone but the bidder --
      // everyone else still sees plain "Hidden" exactly as before.
      // Same technique as index.html's identical rule.
      const mySuit = state.myHiddenTrumpCard.suit;
      const isRedSuit = mySuit === '♦' || mySuit === '♥';
      const iconClass = 'trump-chip-icon' + (isRedSuit ? ' icon-red-suit' : ' icon-black-suit-chip');
      tr.innerHTML = '<span class="' + iconClass + '">' + mySuit + '</span>';
      tr.style.color = '';
      tr.classList.remove('trump-active');
      lastAnnouncedTrumpExposed = false;
    } else if (state.thaniCaller >= 0) {
      // Real bug fix, per explicit report: a Thani call skips trump
      // entirely (see callThani() -- trumpSuit is set to '', no hidden
      // card exists at all), but neither of the two branches above ever
      // matched that case, so it fell all the way through to the plain
      // "Trump: Hidden" fallback below -- implying a trump exists and
      // is just concealed, when actually there's no trump this round
      // at all. Every player sees this, not just the bidder, since
      // there's no secret left to protect once nobody has a hidden
      // trump card to begin with.
      tr.innerHTML = '🚫 No Trump — Thani!';
      tr.style.color = '';
      tr.classList.remove('trump-active');
      lastAnnouncedTrumpExposed = false;
    } else {
      tr.innerHTML = 'Trump: Hidden';
      tr.style.color = '';
      tr.classList.remove('trump-active');
      lastAnnouncedTrumpExposed = false;
    }
  } catch (e) { console.error('[trump-exposed block] threw:', e); }

  // Defensively isolated: renderSeats does a lot of per-seat DOM work (avatars, badges, the
  // bidding call-bubbles), and this function runs BEFORE the round-end/game-over logic further
  // down in this same applyState call, with nothing between them to catch a thrown error.
  // Any uncaught exception in here would silently abort the rest of applyState too - including
  // the code that actually shows the round summary and lets the game continue - which matches
  // exactly the "stuck after a round" symptom reported. Whatever the precise cause turns out to
  // be, a rendering glitch in one seat's avatar should never be able to freeze the whole table.
  try { renderSeats(state); } catch (e) { console.error('[renderSeats] threw, table would have frozen here without this guard:', e); }
  try { renderBidStatusBanner6p(state); } catch (e) { console.error('[renderBidStatusBanner6p] threw:', e); }
  try {
    if (state.round !== roundHistorySeenFor) {
      roundHistorySeenFor = state.round;
      roundTrickHistory = [];
      lastSeenTricksPlayed = state.tricksPlayed || 0;
    }
    const tricksPlayed = state.tricksPlayed || 0;
    if (tricksPlayed > lastSeenTricksPlayed && state.lastTrick) {
      // A trick just completed since the last render. Queue it rather than
      // showing it immediately — if a trick is already mid-reveal, starting
      // this one right now would cancel it early. Every trick gets its own
      // full, uninterrupted pause, in order.
      lastSeenTricksPlayed = tricksPlayed;
      sixpTrickRevealQueue.push(state.lastTrick);
      processNextSixpTrickReveal();
    } else {
      // Self-correcting catch-all: keeps lastSeenTricksPlayed in step with
      // reality on every render, not just when a trick just resolved — so a
      // new round's tricksPlayed resetting to 0 (below whatever the previous
      // round ended at) can never leave this counter stuck above the new
      // round's real count, which would otherwise silently suppress every
      // future trick-completion animation for the rest of the game. Mirrors
      // the 4-player table's renderTrickSlotsWithWinnerPause exactly.
      lastSeenTricksPlayed = tricksPlayed;
      if (!trickHoldBusy && sixpTrickRevealQueue.length === 0) renderTrick(state);
    }
  } catch (e) { console.error('[trick-reveal queue] threw:', e); }
  // Hand restrictions must never update ahead of what the circle is
  // showing — if the circle is still holding the previous completed
  // trick, leave the hand as it was too, and only refresh it once the
  // hold finishes and the circle catches up (see processNextSixpTrickReveal).
  if (!trickHoldBusy && sixpTrickRevealQueue.length === 0) renderHand(state);
  try { updateTurnLabel(state); } catch (e) { console.error('[updateTurnLabel] threw:', e); }
  if ($('hostMenuOverlay').classList.contains('on') && $('hostMenuMainView').style.display !== 'none') renderHostMenuPlayerList();

  // Per explicit instruction: with the individual "HONORS CALLED"/
  // raise/bid popups removed as redundant now that the call bubble
  // already shows that information, the winning bidder's own bubble
  // instead blinks/pulses once bidding actually concludes -- fires
  // once per round, same reasoning and pattern as index.html's
  // identical markWinningBidder4p trigger.
  if (state.phase !== 'bidding1' && state.bidder >= 0 &&
      state.round !== lastMarkedWinnerRound) {
    lastMarkedWinnerRound = state.round;
    markWinningBidder6p(state.bidder);
    // Per explicit request: same persistent, heartbeat-pulsing bubble
    // as the 4-player table -- see showBidWinnerCelebration6p, and
    // dismissBidWinnerCelebration6p wherever this table's own actual
    // "play begins" moment is (phase transitions off bidding entirely).
    if (state.highestBid > 0) showBidWinnerCelebration6p(state.bidder, state.highestBid, state);
  }
  // Per explicit report: runs on every state update, outside the
  // round-gate above, specifically so the "whose turn" line inside the
  // bubble stays current for the whole window it's visible (bidder
  // choosing trump, then whoever leads first) rather than freezing at
  // whatever was true the one time the bubble's main content got set.
  // No-ops harmlessly if the bubble isn't currently showing at all.
  updateBidWinnerTurnText6p(state);
  // Per explicit follow-up report: dismissing the instant phase flips to 'play' fired too
  // early - that's the moment the play STAGE begins, broadcast immediately once trump is
  // chosen, before anyone has actually played a single card yet (see _startPlay() in
  // game-engine-6p.js - phase='play' and trickCards=[] both happen in the very same
  // synchronous block, then _notify() fires right away). Now also requires trickCards to be
  // non-empty, i.e. someone - bot or human - has genuinely played the first card of the
  // round, which is what "stay until a player plays a card" actually meant.
  if (state.phase === 'play' && state.trickCards && state.trickCards.length > 0) dismissBidWinnerCelebration6p();
  if (state.phase === 'bidding1' && state.currentPlayer === MY_POS) showBidPanel(state);
  else $('bidOverlay').classList.remove('on');

  if (state.phase === 'choosingTrump' && state.currentPlayer === MY_POS && state.bidder === MY_POS) {
    // Show the player's actual hand while they decide, and disable any suit they don't hold
    // at all - same two fixes already present on the 4-player table's identical picker,
    // brought over here to match. A suit with zero cards in hand was previously still
    // clickable and would silently ask the server to pick a card on the player's behalf with
    // no card-selection step at all - confusing for a decision this significant.
    const myHand = (latestState && latestState.seats[MY_POS] && latestState.seats[MY_POS].hand) || [];
    const handDisplay = $('trumpHandDisplay6p');
    if (handDisplay) {
      handDisplay.innerHTML = '';
      myHand.forEach(card => { handDisplay.innerHTML += cardHTML(card, false, false, ''); });
    }
    const availableSuits = new Set(myHand.map(c => c.suit));
    document.querySelectorAll('#trumpPickButtons button').forEach(b => {
      const suit = b.getAttribute('data-suit');
      const hasSuit = availableSuits.has(suit);
      b.disabled = !hasSuit;
      b.style.opacity = hasSuit ? '1' : '0.3';
      b.style.cursor = hasSuit ? 'pointer' : 'not-allowed';
      b.style.filter = hasSuit ? 'none' : 'grayscale(0.8)';
      b.title = hasSuit ? '' : ("You have no " + suit + " cards");
      b.classList.remove('on');
    });
    $('trumpCardSelectSection').style.display = 'none';
    $('trumpOverlay').classList.add('on');
  } else {
    $('trumpOverlay').classList.remove('on');
  }

  // The round-end overlay should only ever be showing while the phase
  // genuinely IS roundEnd -- if the host has already advanced (or a
  // reconnect landed mid-way through a later phase), force it closed
  // for everyone here rather than leaving a non-host player stuck
  // looking at a stale summary with a real turn now waiting on them
  // underneath it. Same fix already applied to the Hold'em table for
  // the identical class of bug.
  if (state.phase !== 'roundEnd') {
    stopRoundEndAutoContinue();
    $('roundEndOverlay').classList.remove('on');
  }

  // Real, confirmed bug fix per explicit report ("2 popups at the end,
  // only need the 1 main one"): this condition never checked
  // state.gameOver at all, so on the specific round that both ends a
  // round AND wins the whole championship, this fired regardless --
  // showing the round summary popup right alongside (or just before)
  // the separate game-over popup below, which is a completely
  // independent `if` block with no awareness of this one. Skips the
  // round-end popup entirely once the match itself has ended; the
  // game-over popup already carries the final result, so there's
  // nothing the round-end popup would add at that specific point.
  if (state.phase === 'roundEnd' && state.round !== lastRoundSeen && !state.gameOver) {
    lastRoundSeen = state.round;
    // Same big event as index.html's identical hook -- fires exactly
    // once per round-end, right alongside the existing lastRoundSeen
    // guard above so it can't double-fire on a later re-render.
    const rw = state.roundWinnerAnnounced;
    if (rw) {
      const bidderName = (state.seats && state.seats[rw.bidder]) ? state.seats[rw.bidder].name : 'The bidder';
      if (rw.bidderWon) showGameEvent('🏆', 'Bid Made', bidderName + ' — ' + rw.highestBid, '#2ecc71');
      else showGameEvent('💥', 'Bid Failed', bidderName + ' — ' + rw.highestBid, '#e74c3c');
    }
    // The round can end right on the last trick, whose own 2s-hold +
    // fly-to-winner animation (~3.2s total) may still be playing. Wait for
    // it to actually finish instead of popping the round summary over it.
    // Hard ceiling: this used to poll forever with no escape hatch — if
    // trickHoldBusy or the queue ever got stuck for any reason, the round
    // summary would just never appear, leaving the table stuck needing a
    // manual restart. Now it force-proceeds after 8s regardless.
    const waitStartedAt = Date.now();
    (function waitThenShowRoundEnd() {
      if (trickHoldBusy || sixpTrickRevealQueue.length > 0) {
        if (Date.now() - waitStartedAt > 8000) {
          console.warn('[waitThenShowRoundEnd] gave up waiting after 8s — forcing forward');
          trickHoldBusy = false;
          sixpTrickRevealQueue = [];
          safelyShowRoundEnd(state);
          return;
        }
        setTimeout(waitThenShowRoundEnd, 150);
        return;
      }
      safelyShowRoundEnd(state);
    })();
  }

  if (state.gameOver && !gameOverShownFor) {
    gameOverShownFor = true;
    const waitStartedAt2 = Date.now();
    (function waitThenShowGameOver() {
      if (trickHoldBusy || sixpTrickRevealQueue.length > 0) {
        if (Date.now() - waitStartedAt2 > 8000) {
          console.warn('[waitThenShowGameOver] gave up waiting after 8s — forcing forward');
          trickHoldBusy = false;
          sixpTrickRevealQueue = [];
          safelyShowGameOver(state);
          return;
        }
        setTimeout(waitThenShowGameOver, 150);
        return;
      }
      safelyShowGameOver(state);
    })();
  } else if (!state.gameOver && gameOverShownFor) {
    // gameOverShownFor previously had no reset anywhere in this file at all - it latched
    // true the first time a match ended and stayed true permanently, for the rest of the
    // page's lifetime. That's fine for the very first match, but the moment a second match
    // starts (after a restart) and ALSO reaches its own game-over condition, this guard was
    // already tripped from the first one, so the game-over screen could never show again -
    // the match would just end silently with no summary and no way to start a third one.
    // Resetting here, the moment the current state genuinely shows no gameOver (i.e. a fresh
    // match is underway), re-arms it correctly for the next time one actually ends.
    gameOverShownFor = false;
  }

  // Per explicit request: triggers the new Bot Mode auto-play the same
  // way index.html's own state handler triggers serverBotPlayForMe() --
  // purely additive, doesn't touch any of the branches above.
  if (state.phase === 'play' && state.currentPlayer === MY_POS && sixpBotModeActive) {
    setTimeout(() => sixpBotPlayForMe(), 600);
  }
}

function slotFor(pos) { return (pos - MY_POS + 6) % 6; }
// Hexagon layout, slot 0 (me) at the bottom-center.
const SLOT_POS = [
  { left: '50%', top: '78%' },   // 0 me
  { left: '82%', top: '68%' },   // 1
  { left: '82%', top: '33%' },   // 2
  { left: '50%', top: '23%' },   // 3
  { left: '18%', top: '33%' },   // 4
  { left: '18%', top: '68%' }    // 5
];
// The actual avatar/seat position - separate from SLOT_POS above (which TRICK_SLOT_POS is
// still derived from, for the played-card layout). Moving avatars further out from the table
// needed its own array specifically so it couldn't also drag the trick cards along with it -
// those were carefully tuned for a verified zero-overlap layout, and piggybacking this change
// onto the same source array would have silently disturbed that. Left/right seats only (0/3,
// the top/bottom seats, stay put - there's no unused horizontal margin for them to use).
// Randomized, personality-filled things a seat "says" when they pass or
// bid, instead of just the flat "Pass"/"Bid 17" label. {bid} gets
// replaced with the actual number for messages that reference it -- not
// every bid message needs to, some are just attitude with no number.
const PASS_MESSAGES = [
  "Crappy hands.", "No hands.", "Dead cards.",
  "Not today.", "I fold.", "Cards hate me.",
  "Zero help.", "Can't work.", "Skip me.",
  "Rough draw.", "I got nothing.", "Not my hand.",
  "Save myself.", "No trump.", "Sit out.",
  "No bid.", "Try next round.", "Hand's a mess.",
  "Not worth it.", "I'm out.", "Cards are cold.",
  "No shot.", "Nothing here.", "Empty hand.",
  "Too risky.", "I'll wait.", "Luck's off.",
  "Bad cut.", "Can't do it.", "Not strong.",
  "Folding.", "No points.", "Better luck.",
  "Hand's cursed.", "No support.", "Nothing to bid.",
  "Let it go.", "Off-suit hand.", "Bad hand.",
  "No good.", "Need better.", "Not mine.",
  "Not my hand.", "No cards.", "Bad hand.",
  "Weak hand."
];
const BID_MESSAGES = [
  "I raise.", "Reraise you.", "Honors, go!",
  "Taking a shot.", "Minimum bid.", "Watch me.",
  "Pushing it.", "Going for it.", "I mean it.",
  "Let's raise.", "I got this.", "Feeling good.",
  "Beat that.", "Staying in.", "Strong hand.",
  "Take it.", "Raising up.", "I'll call it.",
  "Going big.", "No fear.", "Hand's mine.",
  "Like my odds.", "Trust me.", "Let's see it.",
  "I'm confident.", "Come at me.", "Solid cards.",
  "Pushing up.", "Easy pick.", "Taking it up.",
  "Not folding.", "Hand's loaded.", "Found a gap.",
  "Locked in.", "Hand's ready.", "Calling it.",
  "Raising it.", "Getting good.", "Feeling lucky.",
  "I'm in.", "No hesitation.", "Taking lead.",
  "Mean business.", "Big bid.", "Betting big.",
  "All in."
];

// A simple deterministic hash of (seat position + which bid-in-the-
// sequence this is + the bid value itself) picks the same message every
// time this exact call gets re-rendered, instead of re-rolling a fresh
// random pick on every state update -- otherwise the text would visibly
// flicker between different lines each time the table re-renders while
// this same bubble is still showing.
// Per explicit instruction: singles out the winning bidder's own
// call-badge with a blink/pulse once bidding concludes, replacing the
// separate "HONORS CALLED"/raise popups that used to announce this.
// Same reasoning and pattern as index.html's identical
// markWinningBidder4p, just using this table's own slotFor/seatWrap
// lookup instead of #av0-3.
function showBidWinnerCelebration6p(pos, winningBid, state) {
  const el = $('bidWinnerBubble6p');
  if (!el) return;
  const seat = state.seats[pos];
  const name = pos === MY_POS ? 'You' : (seat ? seat.name : 'Player');
  const bidText = winningBid >= 29 ? 'THANI!' : ('Bid ' + winningBid);
  el.innerHTML = '<div class="bwb-name">' + escapeHtml(name) + ' won the bid</div><div class="bwb-bid">' + bidText + '</div><div class="bwb-turn" id="bwbTurnLine"></div>';
  el.style.display = 'block';
  el.classList.remove('leaving', 'settled');
  void el.offsetWidth;
  el.style.animation = 'none';
  void el.offsetWidth;
  el.style.animation = '';
  setTimeout(() => el.classList.add('settled'), 650);
  updateBidWinnerTurnText6p(state);
}
// Per explicit report: the bubble stays up through trump selection and
// into the moment before the first card, but who's actually being
// waited on can change during that window (bidder choosing trump, then
// whoever leads first) -- the bubble's main content only ever gets set
// once per round (see the round-gated call site below), so without
// this separate, lightweight update the turn line would go stale the
// instant the active player changed. Deliberately only touches the
// turn line itself, not the whole bubble, so it can run on every state
// update without re-triggering the pop-in/heartbeat animation.
function updateBidWinnerTurnText6p(state) {
  const turnEl = document.getElementById('bwbTurnLine');
  if (!turnEl) return;
  const bubble = $('bidWinnerBubble6p');
  if (!bubble || bubble.style.display === 'none') return;
  const cp = state.currentPlayer;
  if (typeof cp !== 'number' || cp < 0) { turnEl.textContent = ''; turnEl.classList.remove('bwb-turn-mine', 'bwb-turn-partner', 'bwb-turn-opp', 'bwb-turn-pop'); return; }
  const seat = state.seats[cp];
  const isMe = cp === MY_POS;
  const isPartner = !isMe && sixpGetTeam(cp) === sixpGetTeam(MY_POS);
  const possessive = isMe ? 'Your' : (seat ? escapeHtml(seat.name) + "'s" : "Their");
  const verb = state.phase === 'choosingTrump' ? 'turn to choose trump...' : 'turn to play';
  const newText = `${possessive} ${verb}`;
  // Per explicit request, same "only replay on a genuine change, not
  // every call" logic as the 4-player table's identical addition.
  const changed = turnEl.textContent !== newText;
  turnEl.textContent = newText;
  turnEl.classList.toggle('bwb-turn-mine', isMe);
  turnEl.classList.toggle('bwb-turn-partner', isPartner);
  turnEl.classList.toggle('bwb-turn-opp', !isMe && !isPartner);
  if (changed) {
    turnEl.classList.remove('bwb-turn-pop');
    void turnEl.offsetWidth;
    turnEl.classList.add('bwb-turn-pop');
  }
}
function dismissBidWinnerCelebration6p() {
  const el = $('bidWinnerBubble6p');
  if (!el || el.style.display === 'none') return;
  el.classList.add('leaving');
  setTimeout(() => { el.style.display = 'none'; el.classList.remove('leaving', 'settled'); }, 400);
}
function markWinningBidder6p(pos) {
  for (let slot = 0; slot < 6; slot++) {
    const wrap = $('seatWrap' + slot);
    const callEl = wrap && wrap.querySelector('.call-badge');
    if (callEl) callEl.classList.toggle('call-badge-winner', slotFor(pos) === slot);
  }
}

function pickCallMessage(pool, pos, seq, bid) {
  const seed = pos * 7919 + seq * 104729 + bid * 31;
  const idx = Math.abs(seed) % pool.length;
  return pool[idx];
}

// Which compass direction each seat's call-badge should be offset
// toward, computed from that seat's own actual SEAT_POS coordinates
// (see below) relative to the table's center -- seat 0 sits due south
// of center so its bubble goes north (above) pointing back down at it,
// seat 1 sits southeast of center so its bubble goes northwest, and so
// on. Replaces the old two-way (above seats 0/1/5, below seats 2/3/4)
// split with a direction for every seat individually.
const CALL_BADGE_DIR = ['n', 'nw', 'sw', 's', 'se', 'ne'];
// Per non-negotiable instruction: one single object, oval+tail as ONE
// path, not a shape plus a separately-attached piece. Same technique
// as index.html's identical constant -- see there for the full
// reasoning. The oval portion is byte-for-byte identical in all six;
// only the tail portion differs, computed programmatically and each
// one actually rendered and visually verified before use.
// Per explicit instruction: no tail/arrow at all - the oval alone is enough. Every direction
// key still exists (so the positioning CSS classes and JS lookups elsewhere don't need to
// change), they just all point at the identical plain-oval path now instead of six different
// tail shapes.
const OVAL_ONLY_PATH = "M6,40 a44,20 0 1,0 88,0 a44,20 0 1,0 -88,0 Z";
const CALL_BADGE_PATHS = {
  n: OVAL_ONLY_PATH, ne: OVAL_ONLY_PATH, se: OVAL_ONLY_PATH,
  s: OVAL_ONLY_PATH, sw: OVAL_ONLY_PATH, nw: OVAL_ONLY_PATH,
};

const SEAT_POS = [
  { left: '50%', top: '78%' },   // 0 me
  { left: '90%', top: '68%' },   // 1 - moved right, was 82%
  { left: '90%', top: '33%' },   // 2 - moved right, was 82%
  { left: '50%', top: '23%' },   // 3
  { left: '10%', top: '33%' },   // 4 - moved left, was 18%
  { left: '10%', top: '68%' }    // 5 - moved left, was 18%
];
// Each played card sits just slightly closer to the center than its seat - a small nudge,
// not a converging pile. Two earlier attempts at this (0.72, then 0.87) kept pushing further
// toward the center and made it worse each time - at 0.87 especially, cards ended up
// overlapping so heavily that some were genuinely no longer visible at all, which is a real
// regression, not a style preference. Pulled back to barely more than the original 0.55 -
// just enough that immediately-adjacent cards touch slightly, with every single card still
// fully identifiable at a glance.
// Each played card sits closer to the center than its seat - but only slightly. Every
// earlier attempt at this (0.55 originally, then 0.72, then 0.87, then 0.6) was picked by
// eye rather than actually measured, and every one of them had real overlap somewhere -
// even the original 0.55 overlapped by 7px between two adjacent slots, and 0.6 (the last
// value shipped) is worse still. This value was chosen differently: computed the actual
// on-screen gap between every pair of the 6 slots (not just visually-adjacent ones) across
// several candidate factors, and picked the smallest one with a comfortable, confirmed-safe
// margin (~30px) at every single pair, not just the ones that looked fine in one screenshot.
// Horizontal and vertical compression toward center are handled separately, not with one
// uniform factor. Started as "vertical only" (X left at 0.25) since the first request was
// specifically about the left/right pairs getting close together vertically - a later
// follow-up asked for the left/right pairs to also close in horizontally toward the center
// top/bottom cards, hence X increasing to 0.42. Every value change here has been verified
// the same way: measuring the actual gap between all 15 possible pairs of the 6 slots (not
// just visually-adjacent ones), confirming zero real overlap anywhere at a safe margin
// (~9px+) rather than cutting it down to a couple of risky pixels that could tip into actual
// overlap on a slightly different device/browser.
const TRICK_SLOT_X_FACTOR = 0.42;
const TRICK_SLOT_Y_FACTOR = 0.6;
const TRICK_SLOT_POS = SLOT_POS.map(p => {
  const l = parseFloat(p.left), t = parseFloat(p.top);
  return { left: (l + (50 - l) * TRICK_SLOT_X_FACTOR) + '%', top: (t + (50 - t) * TRICK_SLOT_Y_FACTOR) + '%' };
});
function ensureSeatPositions() {
  for (let slot = 0; slot < 6; slot++) {
    const el = $('seatWrap' + slot);
    el.style.left = SEAT_POS[slot].left;
    el.style.top = SEAT_POS[slot].top;
    el.style.transform = 'translate(-50%,-50%)';
    const ts = $('trickSlot' + slot);
    ts.style.left = TRICK_SLOT_POS[slot].left;
    ts.style.top = TRICK_SLOT_POS[slot].top;
  }
}
ensureSeatPositions();

// Same detection scheme as the other two games: compares incoming
// qMarks to what was last seen, throws a big combined event banner for
// whoever changed. First-ever call just syncs the baseline silently.
let lastSeenQMarksSix = null;
function detectQMarkChangesSix(state) {
  const newMarks = state.qMarks || {};
  if (lastSeenQMarksSix === null) { lastSeenQMarksSix = { ...newMarks }; return; }
  const gained = [], lost = [];
  const allNames = new Set([...Object.keys(lastSeenQMarksSix), ...Object.keys(newMarks)]);
  for (const name of allNames) {
    const before = lastSeenQMarksSix[name] || 0;
    const after = newMarks[name] || 0;
    if (after > before) gained.push(name);
    else if (after < before) lost.push(name);
  }
  lastSeenQMarksSix = { ...newMarks };
  if (gained.length > 0) showQMarkEventSix(gained, 'gained');
  if (lost.length > 0) showQMarkEventSix(lost, 'lost');
}
// Themed replacement for window.confirm() - a plain OS/browser dialog box looked completely
// out of place against everything else in this game's visual style. Async by nature (a custom
// DOM modal can't block execution the way the native confirm() does), so this takes a
// callback for the "yes" case instead of returning a boolean directly - callers that used to
// write `if (!window.confirm(...)) return;` need to move whatever ran after that line inside
// the callback instead.
function showThemedConfirm(message, onConfirm) {
  const overlay = document.createElement('div');
  overlay.className = 'themed-confirm-overlay';
  overlay.innerHTML = `<div class="themed-confirm-box">
    <div class="themed-confirm-message">${message}</div>
    <div class="themed-confirm-btns">
      <button class="themed-confirm-btn-no">Cancel</button>
      <button class="themed-confirm-btn-yes">Confirm</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('on'));
  function close() {
    overlay.classList.remove('on');
    setTimeout(() => overlay.remove(), 200);
  }
  overlay.querySelector('.themed-confirm-btn-no').addEventListener('click', close);
  overlay.querySelector('.themed-confirm-btn-yes').addEventListener('click', () => {
    close();
    onConfirm();
  });
}
function showQMarkEventSix(names, direction) {
  const overlay = document.createElement('div');
  overlay.className = 'qmark-event-overlay ' + direction;
  const isGained = direction === 'gained';
  const durationMs = isGained ? 7000 : 5000;
  // Explicitly celebratory framing for BOTH directions, per the request - getting a Kunukku
  // is still a real, notable event worth marking with a real moment on screen, not just the
  // relief of shedding one. Different tone (title/emoji/color palette), same energy.
  const title = isGained ? '🎉 KUNUKKU!' : '🎉 KUNUKKU SHED!';
  const namesText = names.map(escapeHtml).join(', ');
  const subtitle = isGained
    ? `${namesText} ${names.length > 1 ? 'each get' : 'gets'} a Kunukku — shut out!`
    : `${namesText} ${names.length > 1 ? 'shed' : 'sheds'} a Kunukku — free at last!`;
  overlay.innerHTML = `<div class="qmark-event-box"><div class="qmark-event-emoji">${isGained ? '😭' : '🎉'}</div><div class="qmark-event-title">${title}</div><div class="qmark-event-sub">${subtitle}</div></div>`;
  document.body.appendChild(overlay);
  spawnQmarkParticles(overlay, isGained, durationMs);
  setTimeout(() => overlay.classList.add('leaving'), durationMs - 500);
  setTimeout(() => overlay.remove(), durationMs);
}
// Floods the screen with falling confetti/firework-style particles for the full duration of
// the event - explicitly requested ("fireworks or something that will flood the screen with
// all kinda goodies"). Plain DOM elements with randomized inline styles rather than canvas -
// simpler, and plenty fast enough for a burst this size that only runs for a few seconds.
function spawnQmarkParticles(overlay, isGained, durationMs) {
  const goldPalette = ['#f4c430', '#ffd700', '#ffe066', '#e6b800', '#fff3b0'];
  const rainbowPalette = ['#f4c430', '#e08a9a', '#7ec8e3', '#9adba0', '#c99ae3', '#ff9f6b'];
  const palette = isGained ? rainbowPalette : goldPalette;
  const particleCount = 70;
  for (let i = 0; i < particleCount; i++) {
    const p = document.createElement('div');
    p.className = 'qmark-particle';
    const startLeft = Math.random() * 100;
    const size = 6 + Math.random() * 10;
    const fallDuration = 1.8 + Math.random() * 1.6;
    const delay = Math.random() * (durationMs / 1000 - 2);
    const drift = (Math.random() - 0.5) * 160;
    const spin = 360 + Math.random() * 720;
    const color = palette[Math.floor(Math.random() * palette.length)];
    const isRound = Math.random() > 0.5;
    p.style.left = startLeft + 'vw';
    p.style.width = size + 'px';
    p.style.height = size + 'px';
    p.style.background = color;
    p.style.borderRadius = isRound ? '50%' : '2px';
    p.style.setProperty('--fall-distance', '115vh');
    p.style.setProperty('--drift', drift + 'px');
    p.style.setProperty('--spin', spin + 'deg');
    p.style.animationDuration = fallDuration + 's';
    p.style.animationDelay = delay + 's';
    overlay.appendChild(p);
  }
}

let lastKnownIsBotPerPos = [null, null, null, null, null, null]; // tracks each position's isBot status to detect a genuine join/leave transition, not just any re-render
// Per explicit request: some browsers (confirmed via a real side-by-side comparison, not just
// a guess - measured avatar widths directly from screenshots) don't evaluate the CSS
// `orientation: portrait` media feature the same way Chrome does, which is what the whole
// depth-hierarchy sizing block above is gated behind - on at least one such browser the
// hierarchy came out essentially inverted (top seat larger than several side seats, own seat
// smaller than the lower-side seats). `window.innerWidth`/`innerHeight` are plain JS
// properties with far more consistent cross-browser behavior than that CSS media feature, so
// this enforces the exact same sizes directly and unconditionally whenever they'd apply,
// using setProperty(...,'important') so it wins over the CSS regardless of whether that CSS
// happened to match or not in this particular browser. Deliberately mirrors the CSS values
// exactly rather than replacing them - this is a safety net for browsers where the CSS
// condition misfires, not a new source of truth.
function enforceSeatAvatarSizing6p() {
  const isPortraitish = window.innerHeight >= window.innerWidth || window.innerWidth >= 521;
  if (!isPortraitish) return;
  const sizes = {
    0: { w: 128, h: 164, fs: 3.5 },
    3: { w: 68, h: 87, fs: 1.9 },
    2: { w: 82, h: 105, fs: 2.3 },
    4: { w: 82, h: 105, fs: 2.3 },
    1: { w: 104, h: 133, fs: 2.9 },
    5: { w: 104, h: 133, fs: 2.9 },
  };
  for (const slot in sizes) {
    const av = document.getElementById('av' + slot);
    if (!av) continue;
    const s = sizes[slot];
    av.style.setProperty('width', s.w + 'px', 'important');
    av.style.setProperty('height', s.h + 'px', 'important');
    av.style.setProperty('font-size', s.fs + 'rem', 'important');
  }
}
window.addEventListener('resize', enforceSeatAvatarSizing6p);

function renderSeats(state) {
  detectQMarkChangesSix(state);
  enforceSeatAvatarSizing6p();
  const folded = state.foldedSeats || [];
  for (let pos = 0; pos < 6; pos++) {
    const slot = slotFor(pos);
    const seat = state.seats[pos];
    const av = $('av' + slot), nm = $('nm' + slot), cc = $('cc' + slot), wrap = $('seatWrap' + slot);
    if (!seat) { av.textContent = ''; nm.textContent = ''; cc.textContent = ''; wrap.style.opacity = '0.25'; continue; }
    const isFolded = folded.includes(pos);
    wrap.style.opacity = isFolded ? '0.4' : '1';
    const qCount = (state.qMarks && state.qMarks[seat.name]) || 0;
    // A human who picked one of the 20 hero portraits gets their own
    // choice rendered here (with the matching _sad variant swapped in
    // automatically by the .has-q CSS rule below on a Kunukku) --
    // otherwise falls back to the simple emoji scheme this table
    // already had. Folded (a Thani partner sitting out) always shows
    // the "peeking away" face regardless, same as before.
    if (isFolded) {
      av.innerHTML = '🙈';
      av.classList.remove('has-q');
    } else {
      // Per explicit follow-up: the coconut no longer replaces the
      // character's own portrait -- it's appended as a small pendant
      // overlay on top of the normal avatar content instead, so the
      // face stays visible underneath it like a necklace charm. Base
      // avatar content is computed first (exactly the same seat.avatar
      // / isBot / fallback chain as before), then the pendant is
      // appended on top if there's an active Kunukku.
      let baseHtml;
      if (seat.avatar) {
        baseHtml = heroAvatarHtml(seat.avatar);
      } else if (seat.isBot) {
        const botMeta = ALL_BOT_AVATARS_6P.find(b => b.name === seat.name) || ALL_BOT_AVATARS_6P[pos % ALL_BOT_AVATARS_6P.length];
        baseHtml = botMeta.emoji;
        av.style.background = botMeta.bg;
      } else {
        baseHtml = pos === MY_POS ? '😊' : '👤';
      }
      const pendantHtml = qCount > 0
        ? '<img src="/images/kunukku/sad-coconut.png" class="kunukku-avatar-img" alt="Kunukku">' +
          '<div class="kunukku-count-badge">' + qCount + '</div>'
        : '';
      av.innerHTML = baseHtml + pendantHtml;
      av.classList.remove('has-q');
    }
    // Green ring for a connected real human, red for a bot - a brief brighter flash plays
    // exactly once at the moment a seat actually transitions from one to the other, not on
    // every render while it's already settled into one state. Separate element (av) from the
    // yellow turn-active ring (applied to the .seat wrapper above/below), so the two can never
    // conflict even when both are true at once (it's your turn AND you're human).
    const isBotNow = !!seat.isBot;
    av.classList.toggle('human-status', !isBotNow);
    av.classList.toggle('bot-status', isBotNow);
    // Per explicit request: same small colored dot as the 4-player
    // table (green=human, red=bot) -- this table never had one before,
    // it only ever relied on the avatar's own border color for this,
    // which the earlier "no edges" change removed entirely in photo
    // mode, silently leaving no bot/human indicator at all here.
    let dotEl = av.querySelector('.tdot');
    if (!dotEl) {
      dotEl = document.createElement('span');
      dotEl.className = 'tdot';
      av.appendChild(dotEl);
    }
    dotEl.classList.toggle('tyou', !isBotNow);
    dotEl.classList.toggle('topp', isBotNow);
    const prevIsBot = lastKnownIsBotPerPos[pos];
    if (prevIsBot !== null && prevIsBot !== isBotNow) {
      av.classList.remove('flash-join', 'flash-leave');
      void av.offsetWidth; // force reflow so re-adding the class restarts the animation
      const flashClass = isBotNow ? 'flash-leave' : 'flash-join';
      av.classList.add(flashClass);
      setTimeout(() => av.classList.remove(flashClass), 1300);
    }
    lastKnownIsBotPerPos[pos] = isBotNow;
    nm.textContent = seat.name;
    // Partner (same team as the viewer) shown in a deep royal green, opponent in a deep royal
    // red - a consistent viewer-relative color convention, same principle as the "your points
    // always shown first and in green" fix from earlier, just applied to the seat labels too.
    // Class-based, not inline style - lets the same pulse animation CSS rule apply here too
    // (an inline color would still work alongside a class-based animation, but keeping this
    // consistent with the 4-player table's own approach for the identical feature).
    nm.classList.toggle('name-teammate', sixpGetTeam(pos) === sixpGetTeam(MY_POS));
    nm.classList.toggle('name-opponent', sixpGetTeam(pos) !== sixpGetTeam(MY_POS));
    cc.textContent = isFolded ? 'Folded (Thani)' : (seat.cardCount + 'c');
    wrap.classList.toggle('on', state.currentPlayer === pos && (state.phase === 'bidding1' || state.phase === 'play' || state.phase === 'choosingTrump'));
    let badge = '';
    if (pos === state.dealer) badge = 'D';
    if (pos === state.bidder && state.highestBid > 0) badge = 'B' + (state.highestBid >= 29 ? 'THANI' : state.highestBid);
    let bdgEl = wrap.querySelector('.bdg');
    if (badge) {
      if (!bdgEl) { bdgEl = document.createElement('div'); bdgEl.className = 'bdg'; av.appendChild(bdgEl); }
      bdgEl.textContent = badge;
    } else if (bdgEl) { bdgEl.remove(); }

    // "Q" penalty marks — a running shame counter, separate from the
    // dealer/bidder badge above (opposite corner) so it never overlaps
    // it. The avatar itself already swapped to a loser face above; this
    // badge spells out the actual count.
    let qEl = wrap.querySelector('.bdg-q');
    if (qCount > 0 && !isFolded) {
      if (!qEl) { qEl = document.createElement('div'); qEl.className = 'bdg-q'; av.appendChild(qEl); }
      qEl.textContent = qCount + ' Kunukku' + (qCount > 1 ? 's' : '');
      qEl.title = qCount + ' Kunukku — must personally call and win a bid to shed one';
    } else if (qEl) { qEl.remove(); }

    // The bidding "call" bubble above the avatar - what this seat actually said (Bid 17 /
    // Pass / Bid Thani), left visible through the rest of the auction and trump selection so
    // a player joining the conversation partway through (or who just looks away for a
    // second) can still see what already happened, not just whoever is currently deciding.
    // Derived straight from bidHistory (already sent to every client for the bid-history
    // strip) rather than needing any new server-side state - the last entry for this seat is
    // exactly what they last called, in order.
    let callEl = wrap.querySelector('.call-badge');
    // "Until someone plays a card" means genuinely that - not just "until phase becomes
    // 'play'", since phase actually flips to 'play' the instant trump gets chosen, before
    // anyone has played a single card yet. Checking tricksPlayed and an empty trick (nobody
    // partway through leading yet either) instead correctly keeps every call bubble up
    // through trump selection AND that brief window after, right up until the very first
    // card of the round actually lands.
    const nobodyHasPlayedYet = (state.tricksPlayed || 0) === 0 && (!state.trickCards || state.trickCards.length === 0);
    const showCalls = state.phase === 'bidding1' || state.phase === 'choosingTrump' || (state.phase === 'play' && nobodyHasPlayedYet);
    const lastCallIdx = showCalls && state.bidHistory ? state.bidHistory.map((h,i)=>({h,i})).reverse().find(x => x.h.pos === pos) : null;
    const lastCall = lastCallIdx ? lastCallIdx.h : null;
    if (lastCall && !isFolded) {
      const isPass = lastCall.bid === 0;
      const isThani = lastCall.bid >= 29;
      // Per explicit instruction: first line is always the plain, clear
      // "Pass" or "Bid 17" -- the flavor line goes on its own line right
      // below it, instead of blending the number into the middle of a
      // sentence. Thani stays its own fixed line rather than picking a
      // flavor line from the regular bid pool, since a random attitude
      // line built around a plain number wouldn't read sensibly for
      // this specific, special call. Seeded off this bid's own position
      // in bidHistory (lastCallIdx.i) so the exact same flavor line
      // keeps showing every re-render of this same call, not a new
      // random pick each time.
      const header = isThani ? 'Thani!' : isPass ? 'Pass' : 'Bid ' + lastCall.bid;
      // Per explicit follow-up: same simplification as the 4-player
      // table's identical change -- no more custom flavor lines, just
      // the plain call itself.
      const flavor = '';
      const label = header + (flavor ? '\n' + flavor : '');
      if (!callEl) { callEl = document.createElement('div'); callEl.className = 'call-badge'; wrap.appendChild(callEl); }
      // Per explicit instruction: each seat's bubble is now offset
      // toward the table from that seat's own specific position around
      // the oval (see CALL_BADGE_DIR above), not just a simple two-way
      // above/below split. Combined into the same className string as
      // the pass/bid color so both apply in one assignment -- but only
      // written when something's actually different from last render
      // (dataset.cls), same guard already used for the text content
      // just below, so this doesn't reassign className (and restart the
      // pop-in animation) on every single re-render while the same call
      // is still showing.
      const cls = 'call-badge' + (isPass ? ' call-badge-pass' : '') + ' call-badge-' + CALL_BADGE_DIR[slot];
      if (callEl.dataset.cls !== cls) { callEl.dataset.cls = cls; callEl.className = cls; }
      if (callEl.dataset.v !== label) {
        callEl.dataset.v = label;
        // Per explicit request: no more oval bubble background at all - just the animated
        // text itself now, letters only. The SVG bubble+tail path that used to render behind
        // this text (see CALL_BADGE_PATHS above) is intentionally no longer built here.
        callEl.innerHTML = flavor
          ? `<div class="call-badge-header">${header}</div><div class="call-badge-flavor">${flavor}</div>`
          : `<div class="call-badge-header">${header}</div>`;
      }
    } else if (callEl) { callEl.remove(); }
  }
}

function renderTrick(state) {
  // Clear every slot first, then fill in only the seats that have
  // actually played into the current trick — each card sits near the
  // seat that played it, not bunched into one static center pile.
  // Only slots that are newly filled since the last render get the
  // landing-pop animation — re-rendering an already-settled card (e.g.
  // from an unrelated state update) shouldn't replay it.
  const desired = [null, null, null, null, null, null];
  for (const tc of (state.trickCards || [])) {
    desired[slotFor(tc.pos)] = tc.card.suit + tc.card.rank;
  }
  for (let slot = 0; slot < 6; slot++) {
    if (desired[slot] === lastRenderedTrickSlot[slot]) continue;
    lastRenderedTrickSlot[slot] = desired[slot];
    const el = $('trickSlot' + slot);
    if (desired[slot] === null) { el.innerHTML = ''; continue; }
    const tc = (state.trickCards || []).find(t => slotFor(t.pos) === slot);
    if (tc) el.innerHTML = cardHTML(tc.card, false, false, 'tiny trick-card-landing');
  }
}

function renderCompletedTrick(lastTrick) {
  lastRenderedTrickSlot = [null, null, null, null, null, null];
  for (let slot = 0; slot < 6; slot++) $('trickSlot' + slot).innerHTML = '';
  for (const tc of lastTrick.cards) {
    const slot = slotFor(tc.pos);
    const isWinner = tc.pos === lastTrick.winner;
    $('trickSlot' + slot).innerHTML = cardHTML(tc.card, false, false, 'tiny' + (isWinner ? ' trick-winner' : ''));
  }
  // A trick just fully resolved - single, reliable trigger point for this (only called once
  // per completed trick, via the reveal queue below), so it's the right place for the
  // win/lose haptic rather than anywhere state gets re-rendered.
  if (MY_POS !== -1) {
    playHaptic(sixpGetTeam(lastTrick.winner) === sixpGetTeam(MY_POS) ? 'trickWin' : 'trickLose');
  }
}

function processNextSixpTrickReveal() {
  if (trickHoldBusy || sixpTrickRevealQueue.length === 0) return;
  trickHoldBusy = true;
  const lastTrick = sixpTrickRevealQueue.shift();

  renderCompletedTrick(lastTrick);
  roundTrickHistory.push(lastTrick);

  // Hold the completed trick fully visible and still for 2s BEFORE
  // flying the cards to the winner — online, especially on a slow
  // connection, cards can otherwise start flying away before everyone's
  // even finished seeing what was played.
  setTimeout(() => {
    animateCardsToWinner(lastTrick.winner);
  }, 2000);

  setTimeout(() => {
    if (sixpTrickRevealQueue.length > 0) {
      // Another trick completed while this one was showing — reveal it
      // next, with its own full, uninterrupted pause. trickHoldBusy stays
      // true throughout (processNextSixpTrickReveal keeps it set).
      processNextSixpTrickReveal();
      return;
    }
    // Nothing else queued — catch up to whatever's actually current now.
    // Bots don't wait for this hold; by the time it's over, several of
    // them may have already played into the new trick. Reveal those one
    // at a time (staggered) instead of dumping them all in at once, so
    // their turns are still visible instead of being silently swallowed.
    const real = latestState;
    if (!real) { trickHoldBusy = false; return; }
    catchUpSixpTrickStaggered(real);
  }, 3200);
}

// Reveals whichever cards are already sitting in a new trick one at a
// time, at roughly the server's own bot "thinking" pace, instead of
// slapping them all into the circle in a single instant frame. Keeps
// trickHoldBusy held the whole time so the player's hand only unlocks
// once they've actually seen what happened, in order — mirrors the
// 4-player table's catchUpTrickSlotsStaggered exactly.
let sixpCatchUpGen = 0;
function catchUpSixpTrickStaggered(real) {
  for (let slot = 0; slot < 6; slot++) {
    $('trickSlot' + slot).innerHTML = '';
    lastRenderedTrickSlot[slot] = null;
  }
  const myGen = ++sixpCatchUpGen;
  function revealNext() {
    if (myGen !== sixpCatchUpGen) return; // superseded by a newer trick completing mid-catch-up
    // Re-check against whatever's ACTUALLY current on every tick, not a
    // fixed snapshot taken when catch-up started — bots keep playing
    // during this whole reveal (up to 6 players' worth), and the earlier
    // version dumped whichever of their cards had piled up by the time
    // the original snapshot finished revealing all in one instant frame
    // with no gap. Now every card, however late it arrives, gets its own
    // properly-spaced reveal.
    const current = latestState || real;
    const cardsToShow = current.trickCards || [];
    const nextCard = cardsToShow.find(tc => lastRenderedTrickSlot[slotFor(tc.pos)] !== (tc.card.suit + tc.card.rank));
    if (!nextCard) {
      trickHoldBusy = false;
      if (sixpTrickRevealQueue.length > 0) {
        // A full trick completed while this staggered catch-up was still
        // running — show it next with its own full pause.
        processNextSixpTrickReveal();
        return;
      }
      if (latestState) renderHand(latestState);
      return;
    }
    const slot = slotFor(nextCard.pos);
    $('trickSlot' + slot).innerHTML = cardHTML(nextCard.card, false, false, 'tiny trick-card-landing');
    lastRenderedTrickSlot[slot] = nextCard.card.suit + nextCard.card.rank;
    setTimeout(revealNext, 550);
  }
  revealNext();
}

function renderLastTrick(state) {
  const el = $('lastTrickContent');
  const titleEl = $('lastTrickTitle');
  if (!el) return;
  if (titleEl) titleEl.textContent = 'Last Trick';
  if (!state.lastTrick || !state.lastTrick.cards || !state.lastTrick.cards.length) {
    el.innerHTML = '<div class="lt-empty">None yet</div>';
    return;
  }
  const lt = state.lastTrick;
  let h = '<div class="lt-cards">';
  for (const tc of lt.cards) {
    const c = tc.card;
    const color = cardColor(c.suit);
    const isWinningCard = tc.pos === lt.winner;
    h += `<div class="lt-card${isWinningCard ? ' lt-card-won' : ''}"><span class="ltr" style="color:${color}">${c.rank}</span><span class="lts" style="color:${color}">${c.suit}</span></div>`;
  }
  h += '</div>';
  // Per explicit instruction: also shows who actually led/started the
  // trick, not just who won it -- lt.cards is in play order, so its
  // first entry is always whoever led. Combined onto the same compact
  // line (not a second line/bigger box) since the window itself isn't
  // meant to grow to fit this.
  const starterSeat = state.seats[lt.cards[0].pos];
  const starterName = lt.cards[0].pos === MY_POS ? 'You' : (starterSeat ? starterSeat.name : ('Seat ' + lt.cards[0].pos));
  const winnerSeat = state.seats[lt.winner];
  const winnerName = lt.winner === MY_POS ? 'You' : (winnerSeat ? winnerSeat.name : ('Seat ' + lt.winner));
  h += `<div class="lt-win">${starterName} ➜ ${winnerName} +${lt.points}pt</div>`;
  el.innerHTML = h;
}

// Full list of every trick played so far this round, shown inside the
// enlarged Last Trick view — the compact corner panel only ever has room
// for the most recent one.
function renderLastTrickHistory() {
  const el = $('lastTrickHistory');
  if (!el) return;
  if (!roundTrickHistory.length) { el.innerHTML = ''; return; }
  let h = '<div class="lt-history-title">Played so far this round</div>';
  roundTrickHistory.forEach((t, i) => {
    const seat = latestState && latestState.seats ? latestState.seats[t.winner] : null;
    const winnerName = t.winner === MY_POS ? 'You' : (seat ? seat.name : ('Seat ' + t.winner));
    h += `<div class="lt-history-row"><span class="lt-history-num">#${i + 1}</span>`;
    for (const tc of t.cards) {
      const c = tc.card, color = cardColor(c.suit);
      const isWinningCard = tc.pos === t.winner;
      h += `<div class="lt-card${isWinningCard ? ' lt-card-won' : ''}"><span class="ltr" style="color:${color}">${c.rank}</span><span class="lts" style="color:${color}">${c.suit}</span></div>`;
    }
    h += `<span class="lt-history-win">${escapeHtml(winnerName)} +${t.points}</span></div>`;
  });
  el.innerHTML = h;
}

function toggleLastTrickEnlarged() {
  const panel = $('lastTrickPanel');
  const backdrop = $('ltrickBackdrop');
  if (!panel || !backdrop) return;
  const enlarging = !panel.classList.contains('enlarged');
  panel.classList.toggle('enlarged', enlarging);
  backdrop.classList.toggle('on', enlarging);
}
$('lastTrickPanel') && $('lastTrickPanel').addEventListener('click', toggleLastTrickEnlarged);
$('ltrickBackdrop') && $('ltrickBackdrop').addEventListener('click', toggleLastTrickEnlarged);

// Cards flying from each seat to whoever won the trick — the 4-player
// table has always had this; the 6-player one was just wiping the trick
// in place with no sense of who actually took it.
function animateCardsToWinner(winnerPos) {
  const winnerSlot = slotFor(winnerPos);
  const winnerAv = $('av' + winnerSlot);
  if (!winnerAv) return;

  winnerAv.style.animation = 'none';
  void winnerAv.offsetHeight;
  winnerAv.style.animation = 'winnerTrickReceive 1.2s cubic-bezier(0.34,1.56,0.64,1) forwards';

  const ring = document.createElement('div');
  ring.style.cssText = 'position:absolute;inset:-15px;border-radius:50%;border:3px solid var(--accent);z-index:100;pointer-events:none;animation:winnerRingBurst 1s ease-out forwards';
  winnerAv.style.position = 'relative';
  winnerAv.appendChild(ring);
  setTimeout(() => ring.remove(), 1200);

  const wRect = winnerAv.getBoundingClientRect();
  const wCx = wRect.left + wRect.width / 2;
  const wCy = wRect.top + wRect.height / 2;

  for (let slot = 0; slot < 6; slot++) {
    const el = $('trickSlot' + slot);
    if (!el || !el.firstElementChild) continue;
    const card = el.firstElementChild;
    card.style.animation = 'none';
    void card.offsetWidth;
    const cRect = card.getBoundingClientRect();
    const cCx = cRect.left + cRect.width / 2;
    const cCy = cRect.top + cRect.height / 2;
    const tx = wCx - cCx;
    const ty = wCy - cCy;
    card.style.transition = `transform 0.7s cubic-bezier(0.4,0,0.2,1) ${slot * 60}ms, opacity 0.5s ease ${slot * 60 + 200}ms`;
    card.style.transform = `translate(${tx}px, ${ty}px) scale(0.15) rotate(${20 + slot * 12}deg)`;
    card.style.opacity = '0';
    card.style.position = 'relative';
    card.style.zIndex = '500';
  }

  winnerAv.classList.add('winner-pulse');
  setTimeout(() => {
    winnerAv.classList.remove('winner-pulse');
    winnerAv.style.animation = '';
  }, 1200);
}

function updateTurnLabel(state) {
  const lbl = $('turnLabel');
  if (state.phase === 'roundEnd' || state.gameOver) { lbl.textContent = ''; return; }
  // While a mid-trick COT/MaruCOT offer is pending, currentPlayer still points at whoever
  // JUST played (the game deliberately doesn't advance turns until the offer is answered) -
  // showing that as "Ajai's turn" (the person who just played, not the one actually deciding
  // anything right now) was genuinely misleading, not just stale. This takes priority over
  // the normal currentPlayer-based label whenever an offer is actually pending.
  if (state.pendingMidTrickQuote) {
    const offeredSeat = state.seats[state.pendingMidTrickQuote.offeredToPos];
    if (state.pendingMidTrickQuote.offeredToPos === MY_POS) {
      lbl.textContent = 'Your decision — COT/MaruCOT?';
    } else {
      lbl.textContent = offeredSeat ? `Waiting for ${offeredSeat.name}'s decision...` : 'Waiting for a decision...';
    }
    return;
  }
  if (state.currentPlayer === MY_POS) {
    lbl.textContent = state.phase === 'bidding1' ? 'Your turn to bid' : state.phase === 'choosingTrump' ? 'Choose trump' : 'Your turn';
    if (lastHapticCurrentPlayer !== MY_POS && state.phase !== 'lobby') playHaptic('yourTurn');
  } else {
    const seat = state.seats[state.currentPlayer];
    lbl.textContent = seat ? (seat.name + "'s turn") : '';
  }
  lastHapticCurrentPlayer = state.currentPlayer;
}

// ---------------- Card rendering (same crisp SVG suit design as the 4p game) ----------------

function suitIconSvg(suit, cls) {
  const id = SUIT_ICON_ID[suit] || 'spade';
  return `<svg class="${cls}" viewBox="0 0 100 100" aria-hidden="true"><use href="#suit-${id}"></use></svg>`;
}
function cardColor(suit) { return (suit === '♥' || suit === '♦') ? '#c0392b' : '#111'; }
// Per explicit bug report ("can't see all the cards from left and right,
// overflow") -- same function as index.html's identical one, see there
// for the fuller reasoning. The small hand preview inside the bid modal
// (#bidHandDisplay) should show full playing-card size with real
// spacing, only overlapping at all if the actual number of cards
// genuinely can't fit the container's real width otherwise -- measured
// live at render time (varies by device), not a fixed CSS value.
function layoutHandPreviewCards(container) {
  const cards = container.querySelectorAll('.card');
  if (cards.length === 0) return;
  const cardWidth = cards[0].getBoundingClientRect().width;
  if (cardWidth === 0) { requestAnimationFrame(() => layoutHandPreviewCards(container)); return; }
  const gap = 6;
  const naturalTotalWidth = cards.length * cardWidth + (cards.length - 1) * gap;
  const availableWidth = container.clientWidth;
  cards.forEach((card, i) => {
    if (i === 0) { card.style.marginLeft = '0'; return; }
    if (naturalTotalWidth <= availableWidth) {
      card.style.marginLeft = gap + 'px';
    } else {
      const neededOverlapTotal = naturalTotalWidth - availableWidth;
      const perCardOverlap = neededOverlapTotal / (cards.length - 1);
      card.style.marginLeft = '-' + Math.min(cardWidth - 8, perCardOverlap).toFixed(1) + 'px';
    }
  });
}
// Per explicit instruction ("all tables"): same buddy-greeting feature
// Per explicit instruction: clicking on another player's own avatar at
// the table (not your own) pops a big, warm "Cheers!" toast with a
// large drink glyph for a few seconds then fades away on its own --
// purely social/fun, no gameplay effect. Same random drink pool as
// index.html's identical feature -- see there for the fuller reasoning;
// this file needs its own actual copy since the two pages are separate
// loads, not a shared browser context.
window.K28_CHEERS_DRINKS = [
  { emoji: '🥂', label: 'a glass' },
  { emoji: '🧋', label: 'bubble tea' },
  { emoji: '🥤', label: 'red soda water' },
  { emoji: '🥤', label: 'blue soda water' },
  { emoji: '☕', label: 'coffee' },
  { emoji: '🍵', label: 'tea' },
  { emoji: '🧃', label: 'juice' },
  { emoji: '🍋', label: 'lemonade' },
  { emoji: '🍷', label: 'a toast' },
  { emoji: '🍺', label: 'a cold one' },
  { emoji: '🍾', label: 'a celebration' },
  { emoji: '🥃', label: 'the good stuff' }
];
window.showBuddyGreeting = function(fromName, toName) {
  const pool = window.K28_CHEERS_DRINKS;
  const drink = pool[Math.floor(Math.random() * pool.length)];
  const msg = (fromName || 'Someone') + ' toasts ' + (toName || 'you') + ' with ' + drink.label + ' — Cheers!';
  const bubble = document.createElement('div');
  bubble.innerHTML = '<div style="font-size:3rem;line-height:1;margin-bottom:8px">' + drink.emoji + '</div><div>' + escapeHtml(msg) + '</div>';
  bubble.style.cssText = 'position:fixed;left:50%;top:42%;transform:translate(-50%,-50%) scale(0.7);' +
    'background:linear-gradient(135deg,#f4c430,#c99a1e);color:#241a12;font-weight:900;' +
    'font-family:var(--display-font, serif);font-size:1.4rem;padding:20px 32px;border-radius:20px;' +
    'box-shadow:0 12px 40px rgba(0,0,0,0.5),0 0 0 3px rgba(255,255,255,0.25);' +
    'z-index:9500;text-align:center;max-width:80vw;opacity:0;' +
    'transition:opacity 0.25s ease,transform 0.25s cubic-bezier(0.34,1.56,0.64,1);pointer-events:none';
  document.body.appendChild(bubble);
  requestAnimationFrame(() => { bubble.style.opacity = '1'; bubble.style.transform = 'translate(-50%,-50%) scale(1)'; });
  setTimeout(() => {
    bubble.style.opacity = '0';
    bubble.style.transform = 'translate(-50%,-50%) scale(0.85)';
    setTimeout(() => bubble.remove(), 300);
  }, 2200);
};
['av1', 'av2', 'av3', 'av4', 'av5'].forEach(id => {
  const el = document.getElementById(id);
  if (!el) return;
  const slotIndex = parseInt(id.replace('av', ''), 10);
  el.style.cursor = 'pointer';
  el.addEventListener('click', () => {
    // slotFor(pos) maps an actual game position to a screen slot;
    // there's no ready-made inverse, so find whichever position
    // currently maps to the slot that was actually clicked.
    let targetPos = -1;
    for (let pos = 0; pos < 6; pos++) { if (slotFor(pos) === slotIndex) { targetPos = pos; break; } }
    if (targetPos === -1) return;
    if (typeof socket !== 'undefined' && socket && socket.connected) {
      socket.emit('sixp_buddyGreeting', { toPos: targetPos });
    } else {
      // Offline (bots): no round trip needed, show it immediately.
      // {from} = the avatar that got clicked, {to} = the local player.
      const clickedName = (latestState && latestState.seats[targetPos] && latestState.seats[targetPos].name) || 'Someone';
      window.showBuddyGreeting(clickedName, MY_NAME || 'You');
    }
  });
});
function cardHTML(c, clickable, disabled, extraClass) {
  const clk = clickable ? `onclick="playHandCard('${c.suit}','${c.rank}')"` : '';
  const color = cardColor(c.suit);
  return `<div class="card ${disabled ? 'disabled' : ''} ${extraClass || ''}" ${clk}>
    <span class="cr" style="color:${color}"><span>${c.rank}</span>${suitIconSvg(c.suit, 'suit-icon-corner')}</span>
    <span class="cs" style="color:${color}">${suitIconSvg(c.suit, 'suit-icon-center')}</span>
    <span class="crb" style="color:${color}"><span>${c.rank}</span>${suitIconSvg(c.suit, 'suit-icon-corner')}</span>
  </div>`;
}

function canPlay(state, card) {
  if (state.phase !== 'play') return false;
  if (state.currentPlayer !== MY_POS) return false;
  const hand = (state.seats[MY_POS] && state.seats[MY_POS].hand) || [];
  if (state.trickSuit === '') return true;
  const hasSuit = hand.some(c => c.suit === state.trickSuit);
  if (hasSuit && card.suit !== state.trickSuit) return false;
  // Whoever just called for trump to be revealed must play a trump card
  // next if they have one and can't follow the led suit — matches the
  // server's canPlayCard exactly (game-engine-6p.js). Missing this was
  // the actual bug: the client showed every card as tappable, the server
  // silently rejected the illegal ones, and nothing visibly happened.
  if (state.mustPlayTrump && !hasSuit && card.suit !== state.trumpSuit) {
    const hasTrump = hand.some(c => c.suit === state.trumpSuit);
    if (hasTrump) return false;
  }
  return true;
}

function renderHand(state) {
  const mySeat = state.seats[MY_POS];
  const hand = (mySeat && mySeat.hand) || [];
  const sorted = hand.slice().sort((a, b) => HAND_SUIT_ORDER.indexOf(a.suit) - HAND_SUIT_ORDER.indexOf(b.suit) || RANK_ORDER[b.rank] - RANK_ORDER[a.rank]);
  const myTurn = state.phase === 'play' && state.currentPlayer === MY_POS;
  // A visibly thick left border on the first card of each new suit group (not the very first
  // card overall) - matches the same divider treatment as the 4-player table, so a sorted
  // hand actually reads as spades/diamonds/clubs/hearts groups, not one undifferentiated row.
  let prevSuit = null;
  $('handCards').innerHTML = sorted.map(c => {
    const isFirstOfGroup = prevSuit !== null && c.suit !== prevSuit;
    prevSuit = c.suit;
    return cardHTML(c, myTurn, myTurn && !canPlay(state, c), isFirstOfGroup ? 'suit-group-start' : '');
  }).join('');

  // Hidden trump card (mine to play, once trump chosen) shows as an extra
  // face-up card at the end of the hand once nothing else can legally be led.
  if (state.myHiddenTrumpCard && myTurn && hand.length === 0) {
    $('handCards').innerHTML += `<div class="card" style="border:2px solid var(--accent)" onclick="playHiddenTrumpCard()">
      <span class="cr" style="color:${cardColor(state.myHiddenTrumpCard.suit)}">${state.myHiddenTrumpCard.rank}</span>
      <span class="cs" style="color:${cardColor(state.myHiddenTrumpCard.suit)}">${suitIconSvg(state.myHiddenTrumpCard.suit, 'suit-icon-center')}</span>
    </div>`;
    // Forced last card: the hand is empty and this hidden card is
    // genuinely all that's left, so playing it isn't a real decision to
    // weigh -- there's no alternative. Auto-play it rather than making
    // the player find and tap this one specific card with nothing else
    // on screen to compare it against. lastHiddenTrumpAutoFired6p guards
    // against firing more than once for the same turn while waiting on
    // the server's own follow-up state to arrive.
    // Real, confirmed bug fix per explicit live report: a real player's
    // last card appeared to just vanish mid-game. Root cause -- this
    // auto-play fired after only 400ms, fast enough that a real person
    // could easily never even see the card render before it was already
    // gone, since they still had to notice it, recognize it, and decide
    // not to act, all inside less than half a second. The card was never
    // actually missing or lost -- it played itself correctly -- but from
    // the player's side that's functionally indistinguishable from data
    // loss if they never got a chance to perceive it happening at all.
    // Slowed to 1.4s and paired with an explicit toast explaining what's
    // about to happen, so this reads as a deliberate, visible action
    // instead of something that just silently happened to their hand.
    if (!lastHiddenTrumpAutoFired6p) {
      lastHiddenTrumpAutoFired6p = true;
      showToast('🃏 Playing your last card (hidden trump)...', 'info', 1600);
      setTimeout(() => { playHiddenTrumpCard(); }, 1400);
    }
  } else if (!(state.myHiddenTrumpCard && myTurn)) {
    lastHiddenTrumpAutoFired6p = false;
  }

  // Can't follow suit and trump not exposed yet -> offer Call Trump.
  const hasSuit = hand.some(c => c.suit === state.trickSuit);
  if (myTurn && state.trickSuit !== '' && !hasSuit && !state.trumpExposed) {
    const tc = state.trickCards || [];
    let trickHtml = '';
    if (tc.length > 0) {
      trickHtml = '<div style="margin:10px 0;padding:10px;background:rgba(255,215,0,0.08);border:1.5px solid var(--accent);border-radius:10px">' +
        '<div style="font-size:0.68rem;color:var(--accent);font-weight:700;margin-bottom:8px;text-align:center">🃏 CARDS PLAYED THIS TRICK</div>' +
        '<div style="display:flex;justify-content:center;gap:6px;flex-wrap:wrap">' +
        tc.map(t => {
          const seat = state.seats[t.pos];
          const pName = seat ? seat.name : ('Seat ' + t.pos);
          return '<div style="text-align:center">' + cardHTML(t.card, false, false, '') +
            '<div style="font-size:0.55rem;color:var(--text-secondary);margin-top:3px">' + (t.pos === MY_POS ? 'You' : escapeHtml(pName)) + '</div></div>';
        }).join('') +
        '</div></div>';
    }
    $('callTrumpTrickCards').innerHTML = trickHtml;
    $('callTrumpOverlay').classList.add('on');
  } else {
    $('callTrumpOverlay').classList.remove('on');
  }
}

function playHandCard(suit, rank) {
  if (!latestState || latestState.currentPlayer !== MY_POS) return;
  playHaptic('cardPlayed');
  socket.emit('sixp_playCard', { card: { suit, rank, points: POINTS[rank] } });
}
function playHiddenTrumpCard() { socket.emit('sixp_playHiddenTrump'); }

// ---------------- Bot Mode (auto-play, 6-player) ----------------
// Per explicit request: same feature as the 4-player table's own Bot
// Mode toggle (see index.html's toggleBotMode()/serverBotPlayForMe()
// for the original this mirrors) -- purely new code, calling only the
// existing playHandCard()/playHiddenTrumpCard()/canPlay() functions
// above rather than duplicating or modifying any of their logic. Same
// "just submit a legal card, let the server's own authoritative engine
// handle everything else" approach as the 4-player version: no local
// trump-exposure or hidden-trump decisions made here at all.
let sixpBotModeActive = false;
function sixpToggleBotMode() {
  sixpBotModeActive = !sixpBotModeActive;
  const btn = document.getElementById('sixpBotToggle');
  const label = document.getElementById('sixpBotLabel');
  if (sixpBotModeActive) {
    btn.classList.add('on');
    label.textContent = 'ON';
    showToast('🤖 Bot Mode ON — Auto-playing');
    if (latestState && latestState.phase === 'play' && latestState.currentPlayer === MY_POS) {
      setTimeout(() => sixpBotPlayForMe(), 400);
    }
  } else {
    btn.classList.remove('on');
    label.textContent = 'BOT';
    showToast('🎮 Manual Mode — You control');
  }
}
function sixpBotPlayForMe() {
  if (!sixpBotModeActive) return;
  if (!latestState || latestState.phase !== 'play' || latestState.currentPlayer !== MY_POS) return;
  const mySeat = latestState.seats[MY_POS];
  const hand = (mySeat && mySeat.hand) || [];
  if (hand.length === 0) {
    // Only remaining move is the forced hidden trump, if it's ours to play.
    playHiddenTrumpCard();
    return;
  }
  const legal = hand.filter(c => canPlay(latestState, c));
  if (legal.length === 0) return; // shouldn't happen; server rejects anything illegal anyway
  // Simple heuristic matching the 4-player version: lowest legal card.
  legal.sort((a, b) => RANK_ORDER[a.rank] - RANK_ORDER[b.rank]);
  playHandCard(legal[0].suit, legal[0].rank);
}

$('btnCallTrumpYes').addEventListener('click', () => {
  $('callTrumpOverlay').classList.remove('on');
  socket.emit('sixp_callTrump');
});
$('btnCallTrumpNo').addEventListener('click', () => {
  $('callTrumpOverlay').classList.remove('on');
  // Just close the overlay — the player picks their own card from the
  // normal hand UI below. Auto-playing the lowest card for them here was
  // the actual bug: declining to call trump doesn't mean "let the
  // computer choose", it means "let me pick what to discard myself".
});

// ---------------- Bidding UI ----------------

// Per explicit request: unlike showBidPanel (only ever shown to whoever's turn it currently
// is to bid), this shows to EVERY player at the table throughout the entire bidding phase,
// updating live with every single bid or pass - including someone who just joined mid-auction,
// since this reads straight from the current state on every render rather than reacting to a
// one-time event. Deliberately hands off to showBidWinnerCelebration6p (which already
// correctly persists its own "who won" announcement until a card is actually played) the
// moment bidding concludes, rather than trying to cover that same window itself - avoids two
// overlapping banners saying similar things at once.
function renderBidStatusBanner6p(state) {
  const el = document.getElementById('bidStatusBanner6p');
  if (!el) return;
  if (state.phase !== 'bidding1') { el.style.display = 'none'; return; }
  const seats = state.seats;
  let html;
  if (state.highestBid > 0 && state.bidder >= 0) {
    const bidderLabel = sixpRelLabel(state.bidder, seats);
    html = `<b>${bidderLabel}</b> bid <b>${state.highestBid}</b> — current highest bidder.`;
  } else {
    html = `Bidding has started — no bids yet.`;
  }
  if (state.currentPlayer >= 0) {
    const turnLabel = state.currentPlayer === MY_POS ? 'Your turn' : sixpRelLabel(state.currentPlayer, seats) + "'s turn";
    html += `<span class="bsb-turn">${turnLabel}</span>`;
  }
  el.innerHTML = html;
  el.style.display = 'block';
}

function showBidPanel(state) {
  const isFirst = state.highestBid === 0 && state.passes === 0;
  // Honors restriction: if it's genuinely your turn and your OWN
  // partner already holds the current highest bid, the minimum you can
  // call jumps to 20 (or higher, if the bid's already past 19) instead
  // of the normal highestBid+1 -- same rule game-engine-6p.js's
  // placeBid() actually enforces server-side. This UI previously never
  // reflected that at all: it always offered every number down to
  // highestBid+1, including ones the server would reject outright the
  // instant they were tapped, which is exactly the confusing
  // "why did my legal-looking tap just fail" bug reported.
  const honorsRestricted = !isFirst && state.highestBid > 0 && (state.bidder % 2) === (MY_POS % 2);
  // Per explicit instruction: a further restriction on top of the
  // honors-restriction above -- once the partner's own bid has ALREADY
  // reached honors level (20+), placeBid() now only accepts exactly 28
  // as a numeric raise (Thani remains available separately, rendered
  // below regardless of this). Mirrors game-engine-6p.js's identical
  // placeBid() check exactly, so this UI never offers a button the
  // server would actually reject.
  const partnerAlreadyHonors = honorsRestricted && state.highestBid >= 20;
  const minBid = honorsRestricted ? Math.max(20, state.highestBid + 1) : (state.highestBid > 0 ? state.highestBid + 1 : 16);
  $('bidTitle').textContent = 'Place Your Bid';
  $('bidText').innerHTML = (state.highestBid > 0
    ? `Current highest: <b style="color:var(--accent)">${state.highestBid}</b> by ${sixpRelLabel(state.bidder, state.seats)}`
    : 'You are the first bidder — must bid at least 16.')
    + (partnerAlreadyHonors ? `<br><span style="color:var(--accent)">Your partner is already at honors — you can only call 28 or Thani.</span>`
       : honorsRestricted ? `<br><span style="color:var(--accent)">Your partner is already highest — you can only call ${minBid} or above.</span>` : '')
    + sixpRenderBidHistory(state.bidHistory, state.seats);
  const btns = $('bidButtons');
  btns.innerHTML = '';
  btns.className = 'bid-grid';
  if (!isFirst) {
    const alreadyHighest = state.bidder === MY_POS;
    const pass = document.createElement('button');
    pass.className = 'bid-btn pass-btn';
    pass.textContent = alreadyHighest ? 'STAY AT ' + state.highestBid : 'PASS';
    pass.addEventListener('click', () => showBidConfirm(state, 0, true));
    btns.appendChild(pass);
  }
  if (partnerAlreadyHonors) {
    const btn = document.createElement('button');
    btn.className = 'bid-btn';
    btn.textContent = 28;
    btn.addEventListener('click', () => showBidConfirm(state, 28, false));
    btns.appendChild(btn);
  } else {
    for (let b = minBid; b <= 28; b++) {
      const btn = document.createElement('button');
      btn.className = 'bid-btn';
      btn.textContent = b;
      btn.addEventListener('click', () => showBidConfirm(state, b, false));
      btns.appendChild(btn);
    }
  }
  // THANI -- the last, highest bid option, beating any numeric bid.
  // Going it alone: both other teammates fold out of the round entirely
  // (3-a-side teams here, so two fold, not just one), caller leads the
  // first trick immediately, no trump at all, and needs to win every
  // single trick (not points) to succeed. See callThani() in
  // game-engine-6p.js for the full rule.
  const thaniBtn = document.createElement('button');
  thaniBtn.className = 'bid-btn';
  thaniBtn.style.cssText = 'background:linear-gradient(135deg,#8b2020,#4a0f0f);border-color:#c94f4f';
  thaniBtn.textContent = '🔥 THANI (Solo)';
  thaniBtn.addEventListener('click', () => showBidConfirm(state, 'THANI', false));
  btns.appendChild(thaniBtn);
  const mySeat = state.seats[MY_POS];
  const hand = (mySeat && mySeat.hand) || [];
  const sorted = hand.slice().sort((a, b) => SUITS.indexOf(a.suit) - SUITS.indexOf(b.suit) || RANK_ORDER[b.rank] - RANK_ORDER[a.rank]);
  $('bidHandDisplay').innerHTML = sorted.map(c => cardHTML(c, false, false, '')).join('');
  $('bidOverlay').classList.add('on');
  // Per explicit bug report ("can't see all the cards, overflow"): same
  // fix as index.html's identical function -- must run AFTER the modal
  // is actually visible (a display:none container's children have no
  // layout box, so measuring width before this point would read 0 and
  // produce broken math), and wrapped in requestAnimationFrame so the
  // browser has genuinely painted a frame with the real layout first.
  requestAnimationFrame(() => layoutHandPreviewCards($('bidHandDisplay')));
}

// A confirm step before the bid actually goes to the server — a
// mis-tap on a bid number was otherwise irreversible the instant it
// registered, with real match points on the line.
function showBidConfirm(state, bid, isPass) {
  const alreadyHighest = state.bidder === MY_POS;
  const isThani = bid === 'THANI';
  $('bidTitle').textContent = isThani ? 'Confirm THANI — Going Solo' : (isPass ? (alreadyHighest ? 'Stay With Your Bid?' : 'Confirm Pass?') : 'Confirm Your Bid');
  if (isThani) {
    $('bidText').innerHTML = "You are about to call <b style='color:#e05555;font-size:1.6rem'>THANI</b> — going it completely alone.<br><br>" +
      "<b>Both your teammates fold out of this round</b> — neither will play a single card. " +
      "You'll lead the very first trick immediately, and you must win <b>every single trick</b> yourself to succeed — not points, tricks. No trump this round at all.<br><br>" +
      "<b style='color:var(--success)'>+3</b> if you win everything. <b style='color:#e05555'>-4</b> if you lose even one trick.";
  } else {
    $('bidText').innerHTML = isPass
      ? (alreadyHighest
          ? `You'll <b>stay at your bid of ${state.highestBid}</b> — you're already the highest bidder, this just locks it in.`
          : `You are about to <b>PASS</b>.<br>Current highest: <b style="color:var(--accent)">${state.highestBid}</b>`)
      : `You are about to bid: <b style="color:var(--accent);font-size:1.8rem">${bid}</b>` +
        (state.highestBid > 0 ? `<br>Raising from: <b>${state.highestBid}</b> by ${state.seats[state.bidder] ? state.seats[state.bidder].name : '—'}` : '');
  }
  const btns = $('bidButtons');
  btns.innerHTML = '';
  btns.className = 'bid-grid';
  btns.style.gridTemplateColumns = '1fr 1fr';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'bid-btn';
  cancelBtn.style.background = 'transparent';
  cancelBtn.style.border = '1.5px solid var(--border)';
  cancelBtn.textContent = '✕ Cancel';
  cancelBtn.addEventListener('click', () => showBidPanel(state));
  btns.appendChild(cancelBtn);

  const confirmBtn = document.createElement('button');
  confirmBtn.className = 'bid-btn';
  confirmBtn.style.background = 'var(--success, #2ecc71)';
  confirmBtn.style.color = '#0a1628';
  confirmBtn.style.fontWeight = '800';
  confirmBtn.textContent = isThani ? '🔥 Confirm THANI' : (isPass ? (alreadyHighest ? `✓ Stay at ${state.highestBid}` : '✓ Confirm Pass') : `✓ Confirm Bid ${bid}`);
  confirmBtn.addEventListener('click', () => {
    $('bidOverlay').classList.remove('on');
    playHaptic('bidConfirm');
    if (isThani) socket.emit('sixp_callThani');
    else socket.emit('sixp_placeBid', { bid: isPass ? 0 : bid });
  });
  btns.appendChild(confirmBtn);
}

// ---------------- Trump choice UI ----------------

let selectedHiddenTrumpCard = null;

document.querySelectorAll('#trumpPickButtons button').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.disabled) return; // matches the 4-player table's identical guard
    const suit = btn.getAttribute('data-suit');
    document.querySelectorAll('#trumpPickButtons button').forEach(b => b.classList.remove('on'));
    btn.classList.add('on');
    showTrumpCardSelect(suit);
  });
});

function showTrumpCardSelect(suit) {
  const section = $('trumpCardSelectSection');
  const area = $('trumpCardSelectArea');
  const confirmBtn = $('btnConfirmHiddenTrump');
  selectedHiddenTrumpCard = null;
  confirmBtn.disabled = true;
  const hand = (latestState && latestState.seats[MY_POS] && latestState.seats[MY_POS].hand) || [];
  const trumps = hand.filter(c => c.suit === suit);
  if (trumps.length === 0) {
    section.style.display = 'none';
    // No cards of this suit at all (rare, but possible) — nothing to hide from hand, server picks.
    socket.emit('sixp_chooseTrump', { suit, hiddenCard: null });
    $('trumpOverlay').classList.remove('on');
    return;
  }
  section.style.display = 'block';
  area.innerHTML = '';
  trumps.forEach(card => {
    const div = document.createElement('div');
    div.innerHTML = cardHTML(card, true, false, '');
    const cardEl = div.firstElementChild;
    cardEl.removeAttribute('onclick');
    cardEl.addEventListener('click', () => {
      selectedHiddenTrumpCard = card;
      area.querySelectorAll('.card').forEach(c => c.classList.remove('selected'));
      cardEl.classList.add('selected');
      confirmBtn.disabled = false;
    });
    area.appendChild(cardEl);
  });
  confirmBtn.onclick = () => {
    const suitBtn = document.querySelector('#trumpPickButtons button.on');
    const chosenSuit = suitBtn ? suitBtn.getAttribute('data-suit') : suit;
    // Explicit confirmation before this actually submits - trump can't be changed once chosen
    // (short of the separate mid-round "change trump" flow, if this table even has one), so a
    // misclick here is costly. Themed to match the rest of this game instead of a plain
    // window.confirm() browser dialog.
    showThemedConfirm('Set ' + suitName(chosenSuit) + ' ' + chosenSuit + ' as trump for this round?', () => {
      $('trumpOverlay').classList.remove('on');
      const ht = selectedHiddenTrumpCard ? { suit: selectedHiddenTrumpCard.suit, rank: selectedHiddenTrumpCard.rank, points: selectedHiddenTrumpCard.points } : null;
      socket.emit('sixp_chooseTrump', { suit: chosenSuit, hiddenCard: ht });
      section.style.display = 'none';
    });
  };
}

// ---------------- Round end / game over ----------------

// Wraps showRoundEnd() in a try/catch specifically because of a real bug this exposed: this
// function is invoked from inside a setTimeout-driven retry loop, and by the time it's called,
// lastRoundSeen has ALREADY been updated to the new round number (that update has to happen
// early, before the wait loop even starts, to prevent the wait loop itself from double-firing
// on a later re-render of the same round). That means if showRoundEnd() ever threw for any
// reason - a missing element, an unexpected field on roundWinnerAnnounced, anything - the
// exception would propagate straight out of this uncaught, the overlay would never appear,
// and there would be no way for the guard condition to ever re-trigger for that round, since
// the round number the guard checks against had already moved on. The player would be stuck
// on a dead table with no summary, no Continue button, and nothing left to click - exactly
// this report. The fallback here at minimum still shows the score change directly rather than
// silently doing nothing, and still lets the round actually end.
function safelyShowRoundEnd(state) {
  try {
    showRoundEnd(state);
  } catch (e) {
    console.error('[safelyShowRoundEnd] showRoundEnd() threw - falling back so the round can still end:', e);
    try {
      const rw = state.roundWinnerAnnounced;
      $('roundEndTitle').textContent = 'Round Over';
      $('roundEndTitle').style.color = '';
      $('roundEndBody').innerHTML = rw
        ? `Team points: ${rw.teamPoints ? rw.teamPoints[0] + ' - ' + rw.teamPoints[1] : '—'}<br>Match score: ${state.gameScore[0]} - ${state.gameScore[1]}`
        : `Match score: ${state.gameScore[0]} - ${state.gameScore[1]}`;
      $('btnContinueRound').style.display = 'flex';
      $('btnAckRoundEnd').style.display = 'none';
      $('roundEndOverlay').classList.add('on');
      startRoundEndAutoContinue();
    } catch (e2) {
      // If even the minimal fallback can't render, at least auto-advance directly rather than
      // leaving the person on a table with genuinely nothing left to interact with.
      console.error('[safelyShowRoundEnd] fallback also failed - auto-continuing directly:', e2);
      socket.emit('sixp_continueRound');
    }
  }
}
function showRoundEnd(state) {
  const r = state.roundWinnerAnnounced;
  if (!r) return;
  const myTeam = MY_POS % 2 === 0 ? 0 : 1;
  const bidTeam = r.bidder % 2 === 0 ? 0 : 1;
  // Whether the bid was "made" only tells you how the BIDDING team did —
  // a defending player's own result is the opposite of that. Frame this
  // from each viewer's own side, not the same bidder-centric text for
  // everyone regardless of which team they're actually on.
  const myTeamWon = (bidTeam === myTeam) ? r.made : !r.made;
  $('roundEndTitle').textContent = myTeamWon ? '🎉 Your Team Won This Round!' : '😢 Your Team Lost This Round';
  $('roundEndTitle').style.color = myTeamWon ? 'var(--success)' : 'var(--danger)';
  const bidderName = state.seats[r.bidder] ? state.seats[r.bidder].name : ('Seat ' + r.bidder);
  let body = `${bidderName} bid ${r.thani ? 'THANI' : r.highestBid} — ${r.made ? 'made it' : 'fell short'}.<br>Team points: ${r.teamPoints[0]} - ${r.teamPoints[1]}<br><b style="color:${myTeamWon ? 'var(--success)' : 'var(--danger)'}">${myTeamWon ? '+' : '-'}${r.pts} match points for your team</b>`;
  $('roundEndBody').innerHTML = body;
  // Any seated player can trigger this now, not host-only -- see the
  // matching server.js handler for the full reasoning. Everyone gets
  // the same real "Continue" button now; the separate passive
  // "acknowledge and wait for host" button isn't needed anymore, since
  // there's no longer anything to actually wait for.
  $('btnContinueRound').style.display = 'flex';
  $('btnAckRoundEnd').style.display = 'none';
  const signalNote6p = $('partnerSignalSentNote6p');
  if (signalNote6p) signalNote6p.style.display = 'none';
  $('roundEndOverlay').classList.add('on');
  startRoundEndAutoContinue();
}
let roundEndAutoContinueTimer = null;
let roundEndAutoContinueSecondsLeft = 10;
let roundEndAutoContinuePaused = false;
function startRoundEndAutoContinue() {
  stopRoundEndAutoContinue();
  roundEndAutoContinueSecondsLeft = 10;
  roundEndAutoContinuePaused = false;
  const row = $('roundEndAutoContinueRow');
  const text = $('roundEndAutoContinueText');
  const secEl = $('roundEndAutoContinueSeconds');
  const pauseBtn = $('btnPauseAutoContinue');
  if (row) row.style.display = 'flex';
  if (pauseBtn) pauseBtn.textContent = '⏸ Pause';
  if (secEl) secEl.textContent = roundEndAutoContinueSecondsLeft;
  roundEndAutoContinueTimer = setInterval(() => {
    if (roundEndAutoContinuePaused) return;
    roundEndAutoContinueSecondsLeft -= 1;
    if (secEl) secEl.textContent = Math.max(0, roundEndAutoContinueSecondsLeft);
    if (roundEndAutoContinueSecondsLeft <= 0) {
      stopRoundEndAutoContinue();
      // Same action as tapping Continue - see the click handler right below this.
      $('roundEndOverlay').classList.remove('on');
      socket.emit('sixp_continueRound');
    }
  }, 1000);
}
function stopRoundEndAutoContinue() {
  if (roundEndAutoContinueTimer) { clearInterval(roundEndAutoContinueTimer); roundEndAutoContinueTimer = null; }
}
const pauseAutoContinueBtn = $('btnPauseAutoContinue');
if (pauseAutoContinueBtn) {
  pauseAutoContinueBtn.addEventListener('click', () => {
    roundEndAutoContinuePaused = !roundEndAutoContinuePaused;
    pauseAutoContinueBtn.textContent = roundEndAutoContinuePaused ? '▶ Resume' : '⏸ Pause';
    const text = $('roundEndAutoContinueText');
    if (text) text.style.opacity = roundEndAutoContinuePaused ? '0.5' : '1';
  });
}
$('btnContinueRound').addEventListener('click', () => {
  stopRoundEndAutoContinue();
  $('roundEndOverlay').classList.remove('on');
  socket.emit('sixp_continueRound');
});
$('btnAckRoundEnd').addEventListener('click', () => {
  stopRoundEndAutoContinue();
  $('roundEndOverlay').classList.remove('on');
});
// Partner bidding signal — tell your teammates how to approach next
// hand's bidding. Doesn't close the round-end modal, just a quick tap
// with a brief confirmation.
function wireSignalBtn6p(id, signal, label) {
  const btn = $(id);
  if (!btn) return;
  btn.addEventListener('click', () => {
    socket.emit('sixp_sendPartnerSignal', { signal });
    const note = $('partnerSignalSentNote6p');
    if (note) { note.textContent = `✓ Signaled: ${label}`; note.style.display = 'block'; }
  });
}
wireSignalBtn6p('btnSignalSame6p', 'same', 'bid the same');
wireSignalBtn6p('btnSignalHigher6p', 'higher', 'bid more aggressively');
wireSignalBtn6p('btnSignalLower6p', 'lower', 'bid less aggressively');

// Same defensive wrapping as safelyShowRoundEnd() above, for the identical reason - see that
// function's comment for the full explanation. showGameOver() gets called from inside this
// same kind of setTimeout-driven retry loop, after gameOverShownFor has already latched true,
// so an uncaught exception here would permanently block the match-over screen for the rest of
// this match too.
function safelyShowGameOver(state) {
  try {
    showGameOver(state);
  } catch (e) {
    console.error('[safelyShowGameOver] showGameOver() threw - falling back so the match-over screen can still appear:', e);
    try {
      const myTeam = sixpGetTeam(MY_POS);
      const won = state.gameOver.winningTeam === myTeam;
      $('gameOverTitle').textContent = won ? 'You Win!' : 'Defeat';
      $('gameOverBody').textContent = 'Final score: ' + state.gameOver.finalScore[0] + ' - ' + state.gameOver.finalScore[1];
      $('btnGameOverRestart').style.display = IS_HOST ? 'flex' : 'none';
      $('gameOverOverlay').classList.add('on');
    } catch (e2) {
      console.error('[safelyShowGameOver] fallback also failed:', e2);
    }
  }
}
function showGameOver(state) {
  $('roundEndOverlay').classList.remove('on');
  const myTeam = sixpGetTeam(MY_POS);
  const won = state.gameOver.winningTeam === myTeam;
  $('gameOverTitle').textContent = won ? '🏆 You Win!' : '😢 Defeat';
  $('gameOverBody').innerHTML = `Final score — Your Team: ${state.gameOver.finalScore[myTeam]}, Opp Team: ${state.gameOver.finalScore[1 - myTeam]}`;
  $('btnGameOverRestart').style.display = IS_HOST ? 'flex' : 'none';
  $('gameOverOverlay').classList.add('on');
}
$('btnGameOverRestart').addEventListener('click', () => {
  $('gameOverOverlay').classList.remove('on');
  socket.emit('sixp_restartGame');
});

// ---------------- Auto-reconnect (same staleness rule as the 4p game) ----------------

window.addEventListener('DOMContentLoaded', () => {
  showScreen('welcomeScreen');
  // The room list now shows directly on this screen (not just after
  // clicking "Join Table"), so it needs to actually be populated the
  // moment the page loads too, not only when that button gets clicked.
  refreshRoomList();

  const inviteCode = new URLSearchParams(window.location.search).get('invite');
  if (inviteCode) {
    history.replaceState({}, '', window.location.pathname); // don't re-trigger on refresh
    pendingJoinCode = inviteCode.trim().toUpperCase();
    pendingAction = 'join';
    const inviteBanner6p = $('inviteBanner6p');
    if (inviteBanner6p) inviteBanner6p.classList.remove('hidden');
    showScreen('nameScreen');
    return; // skip auto-reconnect — they're here to join a specific friend's table
  }

  let tableId = null, sessionTime = 0;
  try {
    tableId = localStorage.getItem('k28six_table_id');
    sessionTime = parseInt(localStorage.getItem('k28six_session_time') || '0', 10);
  } catch (e) {}
  const RECENT_WINDOW_MS = 3 * 60 * 1000;
  if (tableId && MY_PLAYER_ID && sessionTime && (Date.now() - sessionTime) < RECENT_WINDOW_MS) {
    isAutoReconnectAttempt6p = true;
    connectSocket();
    socket.emit('sixp_joinTable', { tableId, playerId: MY_PLAYER_ID });
  } else {
    try {
      localStorage.removeItem('k28six_table_id');
      localStorage.removeItem('k28six_session_time');
    } catch (e) {}
  }
});

// ==================== CHAT ====================
let chatUnread = 0;
let chatPanelInited = false;
function initChatPanelPosition() {
  const panel = $('chatPanel');
  if (!panel) return;
  const vw = window.innerWidth, vh = window.innerHeight;
  const w = Math.min(340, vw - 20);
  const h = Math.min(420, vh - 100);
  panel.style.width = w + 'px';
  panel.style.height = h + 'px';
  panel.style.left = Math.max(8, vw - w - 12) + 'px';
  panel.style.top = Math.max(8, vh - h - 90) + 'px';
  chatPanelInited = true;
}
function clampChatPanelToViewport() {
  const panel = $('chatPanel');
  if (!panel) return;
  const vw = window.innerWidth, vh = window.innerHeight;
  const rect = panel.getBoundingClientRect();
  let left = rect.left, top = rect.top;
  left = Math.min(Math.max(left, -rect.width + 60), vw - 60);
  top = Math.min(Math.max(top, 0), vh - 44);
  panel.style.left = left + 'px';
  panel.style.top = top + 'px';
}
function openChat() {
  $('chatOverlay').classList.add('on');
  if (!chatPanelInited) initChatPanelPosition();
  else clampChatPanelToViewport();
  chatUnread = 0;
  const badge = $('chatBadge');
  if (badge) { badge.textContent = ''; badge.classList.remove('on'); }
  const msgs = $('chatMessages');
  if (msgs) msgs.scrollTop = msgs.scrollHeight;
  setTimeout(() => { const inp = $('chatInput'); if (inp) inp.focus(); }, 100);
}
function closeChat() { $('chatOverlay').classList.remove('on'); }

(function setupChatDragResize() {
  const panel = $('chatPanel');
  const hdr = $('chatHdr');
  const grip = $('chatResizeHandle');
  if (!panel || !hdr || !grip) return;

  let dragging = false, dragStartX = 0, dragStartY = 0, panelStartLeft = 0, panelStartTop = 0;
  hdr.addEventListener('pointerdown', (e) => {
    if (e.target.closest('#btnCloseChat')) return;
    dragging = true;
    hdr.setPointerCapture(e.pointerId);
    const rect = panel.getBoundingClientRect();
    dragStartX = e.clientX; dragStartY = e.clientY;
    panelStartLeft = rect.left; panelStartTop = rect.top;
  });
  hdr.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const vw = window.innerWidth, vh = window.innerHeight;
    const rect = panel.getBoundingClientRect();
    let newLeft = panelStartLeft + (e.clientX - dragStartX);
    let newTop = panelStartTop + (e.clientY - dragStartY);
    newLeft = Math.min(Math.max(newLeft, -rect.width + 60), vw - 60);
    newTop = Math.min(Math.max(newTop, 0), vh - 44);
    panel.style.left = newLeft + 'px';
    panel.style.top = newTop + 'px';
  });
  const endDrag = (e) => { dragging = false; try { hdr.releasePointerCapture(e.pointerId); } catch (err) {} };
  hdr.addEventListener('pointerup', endDrag);
  hdr.addEventListener('pointercancel', endDrag);

  let resizing = false, resizeStartX = 0, resizeStartY = 0, panelStartW = 0, panelStartH = 0;
  grip.addEventListener('pointerdown', (e) => {
    resizing = true;
    grip.setPointerCapture(e.pointerId);
    const rect = panel.getBoundingClientRect();
    resizeStartX = e.clientX; resizeStartY = e.clientY;
    panelStartW = rect.width; panelStartH = rect.height;
    e.stopPropagation();
  });
  grip.addEventListener('pointermove', (e) => {
    if (!resizing) return;
    const vw = window.innerWidth, vh = window.innerHeight;
    const rect = panel.getBoundingClientRect();
    let newW = panelStartW + (e.clientX - resizeStartX);
    let newH = panelStartH + (e.clientY - resizeStartY);
    newW = Math.min(Math.max(newW, 220), vw - rect.left - 8);
    newH = Math.min(Math.max(newH, 180), vh - rect.top - 8);
    panel.style.width = newW + 'px';
    panel.style.height = newH + 'px';
    e.stopPropagation();
  });
  const endResize = (e) => { resizing = false; try { grip.releasePointerCapture(e.pointerId); } catch (err) {} };
  grip.addEventListener('pointerup', endResize);
  grip.addEventListener('pointercancel', endResize);

  window.addEventListener('resize', () => { if (chatPanelInited) clampChatPanelToViewport(); });
})();

function addChatMessage(from, msg, isMine) {
  const container = $('chatMessages');
  if (!container) return;
  const div = document.createElement('div');
  div.className = 'chat-msg ' + (isMine ? 'mine' : 'theirs');
  div.innerHTML = '<div class="chat-from">' + (isMine ? 'You' : escapeHtml(from)) + '</div>' + linkifyEscaped(escapeHtml(msg));
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
  if (!$('chatOverlay').classList.contains('on') && !isMine) {
    chatUnread++;
    const badge = $('chatBadge');
    if (badge) { badge.textContent = chatUnread > 9 ? '9+' : chatUnread; badge.classList.add('on'); }
    showComicChatPopup(from, msg);
  }
}

// A brief, old-comic-book-style speech bubble so a new message is
// impossible to miss even with the chat panel closed, without forcing
// it open. Auto-dismisses on its own after 3 seconds.
function showComicChatPopup(from, msg) {
  document.querySelectorAll('.comic-chat-popup').forEach(el => el.remove());
  const el = document.createElement('div');
  el.className = 'comic-chat-popup';
  el.innerHTML = '<div class="comic-from">' + escapeHtml(from) + '</div>' + linkifyEscaped(escapeHtml(msg));
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

function sendChat() {
  const inp = $('chatInput');
  if (!inp || !socket) return;
  const msg = inp.value.trim();
  if (!msg) return;
  inp.value = '';
  socket.emit('sixp_chat', { msg: msg });
}

$('btnChat').addEventListener('click', openChat);
$('btnInvite').addEventListener('click', shareInviteLink);
$('btnInviteFromLobby').addEventListener('click', shareInviteLink);

// ==================== STILL PLAYING? (idle check) ====================
let stillPlayingInterval = null;
function showStillPlayingPopup(seconds) {
  const overlay = $('stillPlayingOverlay');
  const countEl = $('stillPlayingCountdown');
  if (!overlay) return;
  let remaining = seconds;
  if (countEl) countEl.textContent = remaining;
  overlay.classList.add('on');
  if (stillPlayingInterval) clearInterval(stillPlayingInterval);
  stillPlayingInterval = setInterval(() => {
    remaining -= 1;
    if (countEl) countEl.textContent = Math.max(remaining, 0);
    if (remaining <= 0) clearInterval(stillPlayingInterval);
  }, 1000);
}
function hideStillPlayingPopup() {
  const overlay = $('stillPlayingOverlay');
  if (overlay) overlay.classList.remove('on');
  if (stillPlayingInterval) { clearInterval(stillPlayingInterval); stillPlayingInterval = null; }
}
$('btnStillPlaying').addEventListener('click', () => {
  if (socket) socket.emit('sixp_stillPlaying');
  hideStillPlayingPopup();
});

// "Already won" early-round-end. Shown to everyone the moment it appears
// (so the whole table knows why things paused), but only the winning
// team gets real action buttons -- everyone else gets an informational
// dismiss. Mirrors the 4-player table's equivalent popup exactly, just
// using this file's own static-overlay pattern (see leaveConfirmOverlay
// for the same style) instead of a dynamically-built modal.
function handleEarlyWinPopup(state) {
  if (state.pendingEarlyWinChoice && !lastShownEarlyWinChoice6p) {
    lastShownEarlyWinChoice6p = true;
    const ew = state.pendingEarlyWinChoice;
    const onWinningTeam = sixpGetTeam(MY_POS) === ew.team;
    const iAmWinner = onWinningTeam ? 'Your team' : 'The other team';
    const outcome = ew.made ? 'already reached the bid' : 'made the bid impossible to reach';
    $('earlyWinText').innerHTML = `${iAmWinner} has ${outcome} — the outcome of this round is already decided.` +
      (onWinningTeam
        ? '<br><br>Keep playing out the remaining tricks, or skip straight to the next round?'
        : '<br><br>Waiting for the winning team to decide whether to keep playing or move on.');
    $('btnEarlyWinKeepPlaying').style.display = onWinningTeam ? '' : 'none';
    $('btnEarlyWinNextRound').style.display = onWinningTeam ? '' : 'none';
    $('btnEarlyWinOk').style.display = onWinningTeam ? 'none' : '';
    $('earlyWinOverlay').classList.add('on');
  } else if (!state.pendingEarlyWinChoice) {
    lastShownEarlyWinChoice6p = false;
    $('earlyWinOverlay').classList.remove('on');
  }
}
$('btnEarlyWinKeepPlaying').addEventListener('click', () => {
  $('earlyWinOverlay').classList.remove('on');
  socket.emit('sixp_respondToEarlyWin', { continuePlay: true });
});
$('btnEarlyWinNextRound').addEventListener('click', () => {
  $('earlyWinOverlay').classList.remove('on');
  socket.emit('sixp_respondToEarlyWin', { continuePlay: false });
});
$('btnEarlyWinOk').addEventListener('click', () => {
  $('earlyWinOverlay').classList.remove('on');
});

// Mid-trick COT/MaruCOT offer - see respondToMidTrickQuote()/_endRoundByMidTrickDecline() in
// game-engine-6p.js for the actual mechanics. Only ever shown to the one specific player it
// was offered to (state.pendingMidTrickQuote.offeredToPos === MY_POS) - everyone else at the
// table just sees the trick paused until they respond, no popup of their own.
let lastShownMidTrickQuoteOffer6p = false;
function handleMidTrickQuoteOffer(state) {
  const overlay = $('midTrickQuoteOverlay');
  if (!overlay) return;
  const offer = state.pendingMidTrickQuote;
  if (offer && offer.offeredToPos === MY_POS && !lastShownMidTrickQuoteOffer6p) {
    lastShownMidTrickQuoteOffer6p = true;
    const isBidderTeam = sixpGetTeam(MY_POS) === sixpGetTeam(state.bidder);
    const label = isBidderTeam ? 'COT' : 'MaruCOT';
    const madePts = isBidderTeam ? 2 : 3;
    const failPts = isBidderTeam ? 3 : 2;
    const declinePts = isBidderTeam ? 1 : 2;
    $('midTrickQuoteTitle').textContent = `🎯 Declare ${label}?`;
    $('midTrickQuoteText').innerHTML = `Your card is winning this trick right now. Declare ${label}: +${madePts} if your team sweeps everything from here, -${failPts} if not.<br><br>Or take the safe option — decline, and your team wins the round outright for a flat +${declinePts}.`;
    overlay.style.display = 'block';
  } else if (!offer) {
    lastShownMidTrickQuoteOffer6p = false;
    overlay.style.display = 'none';
  }
}
$('btnMidTrickQuoteYes').addEventListener('click', () => {
  $('midTrickQuoteOverlay').style.display = 'none';
  socket.emit('sixp_respondMidTrickQuote', { accepted: true });
});
$('btnMidTrickQuoteNo').addEventListener('click', () => {
  $('midTrickQuoteOverlay').style.display = 'none';
  socket.emit('sixp_respondMidTrickQuote', { accepted: false });
});

// COT/MaruCOT button -- persistent, visible to everyone at the table
// during play, but only genuinely clickable ("active") when it's this
// exact viewer's turn and their team hasn't lost a trick yet this
// round. See declareQuote() / _isQuoteEligibleFor() in
// game-engine-6p.js for the authoritative rule -- this is purely a
// reflection of server state. Whether it reads "COT" or "MaruCOT"
// depends purely on whether MY OWN team is the bidding team or not --
// same button, same underlying action, different label (and different
// scoring) depending on which side is looking at it.
function updateQuoteButton(state) {
  const btn = $('btnQuoteDeclare');
  if (!btn) return;
  if (state.phase !== 'play' && !state.quoteState) {
    btn.style.display = 'none';
    return;
  }
  btn.style.display = '';
  const myLabel = sixpGetTeam(MY_POS) === sixpGetTeam(state.bidder) ? 'COT' : 'MaruCOT';
  if (state.quoteState) {
    const onThatTeam = sixpGetTeam(MY_POS) === state.quoteState.team;
    btn.textContent = onThatTeam ? `🎯 ${myLabel} (yours!)` : `🎯 ${myLabel} (active)`;
    btn.classList.remove('quote-btn-active');
    btn.classList.add('quote-btn-disabled');
    return;
  }
  btn.textContent = `🎯 ${myLabel}`;
  const iAmEligible = !!(state.quoteEligible && state.currentPlayer === MY_POS);
  btn.classList.toggle('quote-btn-active', iAmEligible);
  btn.classList.toggle('quote-btn-disabled', !iAmEligible);
}
$('btnQuoteDeclare').addEventListener('click', () => {
  if (!latestState || !latestState.quoteEligible || latestState.currentPlayer !== MY_POS) return;
  const isBidderTeam = sixpGetTeam(MY_POS) === sixpGetTeam(latestState.bidder);
  const label = isBidderTeam ? 'COT' : 'MaruCOT';
  const madePts = isBidderTeam ? 2 : 3;
  const failPts = isBidderTeam ? 3 : 2;
  if (!confirm(`Declare ${label}?\n\nYour team hasn't lost a single trick yet this round. This bets on sweeping EVERY remaining trick: +${madePts} if you win everything, -${failPts} if you lose even one trick from here -- even if you've already made your bid.`)) return;
  socket.emit('sixp_declareQuote');
});

// The manual "ask" button - a real player presses this to send the mid-trick COT/MaruCOT
// question to whoever currently holds the lead, rather than the game deciding on its own.
// Only ever active for an opponent of the current leader, while a trick is genuinely still in
// progress - see game-engine-6p.js's _getMidTrickAskTarget() for the exact rule this button's
// state is driven by (the server computes it fresh per-viewer on every state update).
function updateAskMidTrickButton(state) {
  const btn = $('btnAskMidTrickQuote');
  if (!btn) return;
  if (state.phase !== 'play') { btn.style.display = 'none'; return; }
  btn.style.display = '';
  const targetPos = state.midTrickAskTargetPos;
  const canAsk = targetPos !== null && targetPos !== undefined;
  btn.classList.toggle('quote-btn-active', canAsk);
  btn.classList.toggle('quote-btn-disabled', !canAsk);
  if (canAsk) {
    const targetSeat = state.seats[targetPos];
    const isBidderTeam = sixpGetTeam(targetPos) === sixpGetTeam(state.bidder);
    const label = isBidderTeam ? 'COT' : 'MaruCOT';
    // The visible button text itself needs the actual COT/MaruCOT label, not just a name -
    // a title="..." tooltip (which is all this used to carry the label in) never shows up on
    // a mobile tap at all, only on desktop hover, so a phone user would never actually see
    // which one they were about to ask for.
    btn.textContent = `❓ Ask ${label}?`;
    btn.title = `Ask ${targetSeat ? targetSeat.name : 'them'} to declare ${label}`;
  } else {
    btn.textContent = '❓ Ask COT?';
    btn.title = 'Ask them to declare';
  }
}
$('btnAskMidTrickQuote').addEventListener('click', () => {
  if (!latestState || latestState.midTrickAskTargetPos === null || latestState.midTrickAskTargetPos === undefined) return;
  const targetPos = latestState.midTrickAskTargetPos;
  const targetSeat = latestState.seats[targetPos];
  const isBidderTeam = sixpGetTeam(targetPos) === sixpGetTeam(latestState.bidder);
  const label = isBidderTeam ? 'COT' : 'MaruCOT';
  if (!confirm(`Ask ${targetSeat ? targetSeat.name : 'them'} to declare ${label}?\n\nTheir card is currently winning this trick. They'll get to choose: bet on sweeping everything from here, or take a smaller guaranteed win right now.`)) return;
  socket.emit('sixp_requestMidTrickQuote');
});

// COT/MaruCOT declared -- a one-time, purely informational announcement
// to the whole table, tracked by team so it only fires once per
// declaration. Which word applies is decided by whether the declaring
// team is the bidding team or not -- same underlying action either way,
// just a different label and different scoring. No challenge option
// anymore -- that entire mechanic was replaced outright with this
// simpler two-label system.
function handleQuoteDeclaredToast(state) {
  if (state.quoteState && lastShownQuoteDeclaredForTeam6p !== state.quoteState.team) {
    lastShownQuoteDeclaredForTeam6p = state.quoteState.team;
    const onThatTeam = sixpGetTeam(MY_POS) === state.quoteState.team;
    const isBidderTeam = state.quoteState.team === sixpGetTeam(state.bidder);
    const label = isBidderTeam ? 'COT' : 'MaruCOT';
    const madePts = isBidderTeam ? 2 : 3;
    const failPts = isBidderTeam ? 3 : 2;
    showToast(`🎯 ${onThatTeam ? 'Your team' : 'The other team'} declared ${label}! +${madePts} if they sweep everything, -${failPts} if not.`, 'info', 4500);
  } else if (!state.quoteState) {
    lastShownQuoteDeclaredForTeam6p = null;
  }
}
// Deliberately the branded custom domain, not window.location.origin --
// see index.html's identical constant for the full reasoning.
const BRAND_ORIGIN = 'https://28gulan.com';
async function shareInviteLink() {
  if (!MY_TABLE_ID) { showToast('Join a table first', 'lose', 1500); return; }
  const link = BRAND_ORIGIN + window.location.pathname + '?invite=' + encodeURIComponent(MY_TABLE_ID);
  // Same fix as index.html's identical function -- see there for the
  // full reasoning. createdAt comes from the server-tracked value now
  // included in every state push (see sixpBroadcastTable in server.js).
  const createdMs = (latestState && latestState.createdAt) || Date.now();
  const createdTime = new Date(createdMs).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    + ' ' + new Date(createdMs).toLocaleDateString([], { year: '2-digit', month: 'numeric', day: 'numeric' });
  const text = `🟢 Live now — created at ${createdTime}. Join 28 Kerala Gulan 6 Player table! Room code: ${MY_TABLE_ID}`;
  if (navigator.share) {
    try { await navigator.share({ title: '28 Kerala Gulan', text, url: link }); return; }
    catch (e) { /* cancelled the share sheet — fall through to copy */ }
  }
  try {
    await navigator.clipboard.writeText(link);
    showToast('🔗 Invite link copied — send it to a friend!', 'win', 3000);
  } catch (e) {
    showToast(`Room code: ${MY_TABLE_ID} — share this with a friend`, 'info', 4000);
  }
}
// A second, plainer kind of invite -- not pointing at any specific
// table (nothing exists yet at the moment this button is shown, right
// on the name-entry screen before anyone's created or joined anything).
// Just a share of this game's own landing page, so whoever opens it
// lands on this exact same "enter your name" screen with both Create
// and Join fully open to them -- as opposed to shareInviteLink() above,
// which is for "come join the specific table I'm already sitting at."
const inviteGeneric6pBtn = $('btnInviteGeneric6p');
if (inviteGeneric6pBtn) inviteGeneric6pBtn.addEventListener('click', async () => {
  const link = BRAND_ORIGIN + window.location.pathname;
  const text = `Come play 28 Kerala Gulan (6 Player) with me!`;
  if (navigator.share) {
    try { await navigator.share({ title: '28 Kerala Gulan — 6 Player', text, url: link }); return; }
    catch (e) { /* cancelled the share sheet — fall through to copy */ }
  }
  try {
    await navigator.clipboard.writeText(link);
    showToast('🔗 Invite link copied — send it to a friend!', 'win', 3000);
  } catch (e) {
    showToast(`Link: ${link}`, 'info', 4000);
  }
});
$('btnCloseChat').addEventListener('click', closeChat);
$('chatOverlay').addEventListener('click', function (e) { if (e.target === this) closeChat(); });
$('btnSendChat').addEventListener('click', sendChat);
$('chatInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); sendChat(); } });

// ==================== HOME / LEAVE MID-GAME ====================
// There was previously no way to exit once a game had actually started —
// "Leave Table" only existed on the pre-game lobby screen. Uses a proper
// rendered warning overlay (leaveConfirmOverlay, see six.html) instead of
// the native browser confirm() this used to show, matching the same
// simplified two-button exit dialog (Leave Table / Continue Playing) the
// 4-player table already uses.
$('btnGameHome').addEventListener('click', () => {
  $('leaveConfirmOverlay').classList.add('on');
});
$('btnLeaveConfirmCancel').addEventListener('click', () => {
  $('leaveConfirmOverlay').classList.remove('on');
});
$('btnLeaveConfirmOk').addEventListener('click', () => {
  $('leaveConfirmOverlay').classList.remove('on');
  leaveToWelcome();
});

// ==================== HOST MENU ====================
$('btnHostMenu').addEventListener('click', openHostMenu);
$('btnCloseHostMenu').addEventListener('click', closeHostMenu);
$('btnCloseBotPicker').addEventListener('click', () => {
  $('hostMenuBotPickerView').style.display = 'none';
  $('hostMenuMainView').style.display = 'block';
});

function openHostMenu() {
  if (!IS_HOST) return;
  $('hostMenuBotPickerView').style.display = 'none';
  $('hostMenuMainView').style.display = 'block';
  renderHostMenuPlayerList();
  refreshHostMenuLeaderboard();
  $('hostMenuOverlay').classList.add('on');
}
// Per explicit request, same addition as the 4-player table's identical
// function -- see there for the fuller reasoning. Shows only this
// table's own mode (6-player).
async function refreshHostMenuLeaderboard() {
  const el = $('hostMenuLeaderboard');
  if (!el) return;
  el.innerHTML = 'Loading…';
  try {
    const res = await fetch('/api/leaderboard');
    const data = await res.json();
    const lb = data.leaderboard;
    const fmtEntry = (e) => {
      if (!e) return 'None yet';
      const names = e.names.map(n => String(n).replace(/</g, '&lt;')).join(', ');
      const roundLabel = e.rounds === 1 ? 'round' : 'rounds';
      return `${names} enforced Kunukku in ${e.rounds} ${roundLabel}`;
    };
    el.innerHTML = `🏆 All-Time: ${fmtEntry(lb.allTime['6p'][0])}<br>📅 Today: ${fmtEntry(lb.today['6p'][0])}`;
  } catch (e) {
    el.innerHTML = 'Could not load.';
  }
}
function closeHostMenu() {
  $('hostMenuOverlay').classList.remove('on');
}

function renderHostMenuPlayerList() {
  const container = $('hostMenuPlayerList');
  if (!container || !latestState) return;
  const seats = latestState.seats || [];
  let html = '';
  seats.forEach((s, pos) => {
    if (!s) return;
    const isSelf = pos === MY_POS;
    const tag = s.isBot ? '🤖' : (s.connected ? '🟢' : '🔌');
    let actionBtn = '';
    if (!isSelf && !s.isBot) {
      actionBtn = `<button class="btn btn-outline btn-sm" onclick="sixpKickPlayer(${pos})" style="padding:4px 10px;font-size:0.7rem;width:auto">Kick</button>`;
    } else if (s.isBot) {
      actionBtn = `<button class="btn btn-outline btn-sm" onclick="openSixpChangeBotPicker(${pos})" style="padding:4px 10px;font-size:0.7rem;width:auto">🔄 Change</button>`;
    }
    // Per explicit request: avatar-change available for every seat, not
    // just bots -- same reasoning as the identical 4-player change.
    const avatarBtn = `<button class="btn btn-outline btn-sm" onclick="openSixpChangeAvatarPicker(${pos})" style="padding:4px 10px;font-size:0.7rem;width:auto;margin-left:4px">🖼️ Avatar</button>`;
    html += `<div style="display:flex;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.05)">
      <span style="font-size:0.8rem">${tag} ${escapeHtml(s.name)}${isSelf ? ' (you)' : ''}</span>
      <span>${actionBtn}${avatarBtn}</span>
    </div>`;
  });
  container.innerHTML = html || '<p style="color:var(--text-secondary);font-size:0.75rem">No one seated yet.</p>';
}

// Swapping a bot's personality mid-game only ever changes which name is
// behind the seat, never the cards or whose turn it is — safe any time.
// Uses a sub-view within the SAME overlay (rather than a separate modal)
// so there's no z-index stacking to get wrong.
function openSixpChangeBotPicker(pos) {
  const takenNames = new Set((latestState.seats || []).filter(Boolean).map(s => s.name));
  const options = BOT_NAME_POOL.filter(n => !takenNames.has(n));
  if (options.length === 0) { showToast('No other bot names available right now', 'info', 2000); return; }
  const listHtml = options.map(name =>
    `<button class="btn btn-outline" style="width:100%;margin-bottom:6px;text-align:left" onclick="confirmSixpChangeBot(${pos}, '${name}')">🤖 ${name}</button>`
  ).join('');
  $('botPickerList').innerHTML = listHtml;
  $('hostMenuMainView').style.display = 'none';
  $('hostMenuBotPickerView').style.display = 'block';
}
function confirmSixpChangeBot(pos, newName) {
  socket.emit('sixp_changeBotName', { pos, newName });
  showToast(`🔄 Bot changed to ${newName}`, 'win', 2200);
  $('hostMenuBotPickerView').style.display = 'none';
  $('hostMenuMainView').style.display = 'block';
  setTimeout(renderHostMenuPlayerList, 300); // give the server's confirming state a moment to arrive
}

// Mid-game avatar change per explicit request -- reuses the exact same
// sub-view swap technique (and even the same botPickerList/
// hostMenuBotPickerView container) as openSixpChangeBotPicker right
// above, just filling it with the avatar grid instead of a name list.
function openSixpChangeAvatarPicker(pos) {
  const gridHtml = shuffledAvatarKeys().map(key =>
    `<div class="my-avatar-choice" data-key="${key}" onclick="confirmSixpChangeAvatar(${pos}, '${key}')" style="display:inline-block">
      <img src="/images/hero-avatars/${key}.png" alt="">
    </div>`
  ).join('');
  $('botPickerList').innerHTML = `<div class="my-avatar-picker">${gridHtml}</div>`;
  $('hostMenuMainView').style.display = 'none';
  $('hostMenuBotPickerView').style.display = 'block';
}
async function confirmSixpChangeAvatar(pos, key) {
  if (!(await checkAvatarPin(key))) return;
  socket.emit('sixp_hostChangeAvatar', { targetPos: pos, avatar: key });
  showToast('🖼️ Avatar changed', 'win', 2000);
  $('hostMenuBotPickerView').style.display = 'none';
  $('hostMenuMainView').style.display = 'block';
  setTimeout(renderHostMenuPlayerList, 300);
}

function sixpKickPlayer(pos) {
  const seat = latestState && latestState.seats && latestState.seats[pos];
  const name = seat ? seat.name : 'this player';
  if (!confirm(`Remove ${name} from the table?`)) return;
  socket.emit('sixp_kickPlayer', { pos });
  setTimeout(renderHostMenuPlayerList, 300);
}

let pendingSixpRestartAction = null; // 'round' | 'game'
function confirmSixpRestart(kind) {
  pendingSixpRestartAction = kind;
  $('restartConfirmText').textContent = kind === 'round'
    ? "Restart this round? Everyone's current hand will be reshuffled and redealt."
    : 'Restart the entire game? Match score and everything else will reset to the very start.';
  $('hostMenuOverlay').classList.remove('on');
  $('restartConfirmOverlay').classList.add('on');
}
$('btnHostRestartRound').addEventListener('click', () => confirmSixpRestart('round'));
$('btnHostRestartGame').addEventListener('click', () => confirmSixpRestart('game'));
$('btnRestartConfirmCancel').addEventListener('click', () => {
  $('restartConfirmOverlay').classList.remove('on');
  pendingSixpRestartAction = null;
});
$('btnRestartConfirmOk').addEventListener('click', () => {
  $('restartConfirmOverlay').classList.remove('on');
  if (pendingSixpRestartAction === 'round') socket.emit('sixp_restartRound');
  else if (pendingSixpRestartAction === 'game') socket.emit('sixp_restartGame');
  pendingSixpRestartAction = null;
});

(function startLiveTypewriter6p(){
  const el = document.getElementById('liveTagline6p');
  if (!el) return;
  const full = '▶ Start now with smart bots — invite friends anytime, even mid-game!';
  el.innerHTML = '';
  const words = full.split(' ');
  const cycleMs = 3000;
  const step = cycleMs / full.length;
  let idx = 0;
  const frag = document.createDocumentFragment();
  words.forEach((word, wi) => {
    const wordSpan = document.createElement('span');
    wordSpan.style.whiteSpace = 'nowrap';
    wordSpan.style.display = 'inline-block';
    for (const ch of word) {
      const span = document.createElement('span');
      span.className = 'pop-letter';
      span.style.animationDelay = (idx * step) + 'ms';
      span.textContent = ch;
      wordSpan.appendChild(span);
      idx++;
    }
    frag.appendChild(wordSpan);
    if (wi < words.length - 1) {
      frag.appendChild(document.createTextNode(' '));
      idx++;
    }
  });
  el.appendChild(frag);
})();

// Same fullscreen helper as the 4-player table (public/index.html's requestFullscreen28) -
// duplicated here rather than shared via an import, since six.html/six.js don't share a
// module system with index.html, but functionally identical: standard requestFullscreen with
// the usual vendor prefixes, wrapped so a browser that doesn't support it (or silently
// restricts it, like iOS Safari) just does nothing instead of throwing.
function requestFullscreen28() {
  try {
    const el = document.documentElement;
    const fn = el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen || el.msRequestFullscreen;
    if (fn) {
      const result = fn.call(el);
      if (result && result.catch) result.catch(() => {});
    }
  } catch (e) { /* not available here -- fine, just skip it */ }
}


// ==================== IDLE SCREENSAVER (live 6-player game table) ====================
// This table had no idle screensaver at all before -- this mirrors the
// 4-player table's real-object version (see index.html's identical
// block for the fuller reasoning): every seat (".seat" -- avatar, name,
// call-badge, all as one unit) and every card currently sitting in a
// trick slot in the middle physically bounces around the screen,
// DVD-logo style. Snaps everything back to its exact original spot the
// instant there's real activity (a click/tap, or the live game state
// changing underneath -- see the sixp_state hook above), so nothing
// about the actual game can be disturbed, only how it looks while
// genuinely idle. 1 minute idle, only while the game screen is showing.
(function() {
  const K28_TABLE_IDLE_MS = 60 * 1000;
  let idleTimer = null;
  let bouncers = null;
  let rafId = null;
  let watermark = null;

  function isGameTableVisible() {
    const el = document.getElementById('gameScreen');
    return !!el && el.style.display !== 'none' && getComputedStyle(el).display !== 'none';
  }

  // Every seat (avatar + name + call badge, the whole ".seat" unit) plus
  // every trick slot currently holding a played card. Deliberately NOT
  // the local player's own hand at the bottom -- that stays put and
  // interactive the whole time.
  // Per explicit request: also includes the top bar's own chips -- see
  // index.html's identical change for the full reasoning on why the
  // trump chip needs no special handling (its content is already
  // gated per viewer before this ever runs).
  function collectTargets() {
    const targets = [];
    document.querySelectorAll('.seat').forEach(el => {
      if (el.offsetParent && el.querySelector('.av')) targets.push(el);
    });
    document.querySelectorAll('.trickslot').forEach(el => {
      if (el.offsetParent && el.children.length > 0) targets.push(el);
    });
    ['roundNumBox', 'scoreBoxYours', 'scoreBoxOpp', 'trumpChip',
     'sixInfoDealerWrap', 'sixInfoPointsWrap', 'sixInfoBidderWrap'].forEach(id => {
      const el = document.getElementById(id);
      if (el && el.offsetParent) targets.push(el);
    });
    return targets;
  }

  function startScreensaver() {
    if (!isGameTableVisible() || bouncers) return;
    const targets = collectTargets();
    if (!targets.length) return;

    const vw = window.innerWidth, vh = window.innerHeight;
    bouncers = targets.map(el => {
      const rect = el.getBoundingClientRect();
      const original = {
        position: el.style.position, left: el.style.left, top: el.style.top,
        margin: el.style.margin, zIndex: el.style.zIndex,
        width: el.style.width, transition: el.style.transition,
        transform: el.style.transform
      };
      el.style.transition = 'none';
      el.style.position = 'fixed';
      el.style.left = rect.left + 'px';
      el.style.top = rect.top + 'px';
      el.style.margin = '0';
      el.style.width = rect.width + 'px';
      el.style.zIndex = '99999';
      const angle = Math.random() * Math.PI * 2;
      const speed = 40 + Math.random() * 50;
      // Per explicit request: same spin-on-impact physics as the
      // 4-player table's identical change -- see there for the fuller
      // reasoning.
      return {
        el, original, x: rect.left, y: rect.top, w: rect.width, h: rect.height,
        vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
        rot: 0, spin: (Math.random() - 0.5) * 90
      };
    });

    // Per explicit request: 28GULAN.COM is now one of the bouncing
    // objects itself, starting dead center, bold and large -- same
    // treatment as the 4-player table's identical change, see there
    // for the fuller reasoning.
    const brand = document.createElement('div');
    brand.textContent = '28GULAN.COM';
    // Per explicit request: matches the exact font/color/engraved style
    // of the "28GULAN.COM" watermark already carved into this table's
    // felt (see .table-oval::after in six.html) -- this table uses a
    // fixed gold tone rather than a live theme variable (six-player
    // doesn't rotate felt colors the way 4-player does). Also shrunk
    // further per follow-up request.
    // Per explicit follow-up: same border-instead-of-shadow, smaller
    // treatment as the 4-player table's identical change -- see there
    // for the fuller reasoning.
    brand.style.cssText = 'position:fixed;color:#8a6d1f;font-family:\'Cinzel Decorative\',\'Fraunces\',serif;font-weight:700;letter-spacing:1.5px;font-size:clamp(8px,1.8vw,12px);border:1.5px solid #8a6d1f;border-radius:8px;padding:3px 8px;background:rgba(10,10,10,0.35);white-space:nowrap;pointer-events:none;z-index:99999';
    document.body.appendChild(brand);
    const brandRect = brand.getBoundingClientRect();
    const brandAngle = Math.random() * Math.PI * 2;
    const brandSpeed = 40 + Math.random() * 50;
    const brandStartX = vw / 2 - brandRect.width / 2;
    const brandStartY = vh / 2 - brandRect.height / 2;
    brand.style.left = brandStartX + 'px';
    brand.style.top = brandStartY + 'px';
    bouncers.push({
      el: brand, isBrand: true,
      x: brandStartX, y: brandStartY, w: brandRect.width, h: brandRect.height,
      vx: Math.cos(brandAngle) * brandSpeed, vy: Math.sin(brandAngle) * brandSpeed,
      rot: 0, spin: (Math.random() - 0.5) * 90
    });

    watermark = document.createElement('div');
    watermark.id = 'k28TableScreensaverBg6p';
    watermark.style.cssText = 'position:fixed;inset:0;background:radial-gradient(ellipse at center,rgba(8,14,26,0.25) 0%,rgba(4,9,18,0.35) 100%);z-index:100000;cursor:pointer';
    document.body.appendChild(watermark);
    watermark.addEventListener('click', stopScreensaver);
    watermark.addEventListener('touchstart', stopScreensaver, { passive: true });

    let lastT = performance.now();
    // Per explicit request: same proper impulse-based physics with
    // torque as the 4-player table's identical change -- see there for
    // the fuller reasoning.
    function resolveCollision(A, B) {
      const overlapX = Math.min(A.x + A.w, B.x + B.w) - Math.max(A.x, B.x);
      const overlapY = Math.min(A.y + A.h, B.y + B.h) - Math.max(A.y, B.y);
      let nx, ny, contactX, contactY;
      if (overlapX < overlapY) {
        const sign = (A.x + A.w / 2 < B.x + B.w / 2) ? -1 : 1;
        nx = sign; ny = 0;
        A.x += sign * overlapX / 2; B.x -= sign * overlapX / 2;
        contactX = sign > 0 ? A.x : A.x + A.w;
        contactY = (Math.max(A.y, B.y) + Math.min(A.y + A.h, B.y + B.h)) / 2;
      } else {
        const sign = (A.y + A.h / 2 < B.y + B.h / 2) ? -1 : 1;
        nx = 0; ny = sign;
        A.y += sign * overlapY / 2; B.y -= sign * overlapY / 2;
        contactX = (Math.max(A.x, B.x) + Math.min(A.x + A.w, B.x + B.w)) / 2;
        contactY = sign > 0 ? A.y : A.y + A.h;
      }
      const rvx = A.vx - B.vx, rvy = A.vy - B.vy;
      const velAlongNormal = rvx * nx + rvy * ny;
      if (velAlongNormal > 0) return;
      const restitution = 0.85;
      const j = -(1 + restitution) * velAlongNormal / 2;
      const jx = j * nx, jy = j * ny;
      A.vx += jx; A.vy += jy;
      B.vx -= jx; B.vy -= jy;
      const centerAx = A.x + A.w / 2, centerAy = A.y + A.h / 2;
      const centerBx = B.x + B.w / 2, centerBy = B.y + B.h / 2;
      const rAx = contactX - centerAx, rAy = contactY - centerAy;
      const rBx = contactX - centerBx, rBy = contactY - centerBy;
      const torqueA = rAx * jy - rAy * jx;
      const torqueB = -(rBx * jy - rBy * jx);
      const IA = (A.w * A.w + A.h * A.h) / 12 || 1;
      const IB = (B.w * B.w + B.h * B.h) / 12 || 1;
      const spinScale = 55;
      A.spin += (torqueA / IA) * spinScale;
      B.spin += (torqueB / IB) * spinScale;
      A.spin = Math.max(-260, Math.min(260, A.spin));
      B.spin = Math.max(-260, Math.min(260, B.spin));
    }
    function frame(t) {
      if (!bouncers) return;
      const dt = Math.min(0.05, (t - lastT) / 1000);
      lastT = t;
      // Per explicit urgent report: same fix as the 4-player table's
      // identical change -- wall bounces now also kick spin, scaled to
      // impact speed, same as an object-vs-object hit. See there for
      // the fuller reasoning on why this was making rotation look
      // stuck in one direction.
      for (const b of bouncers) {
        b.x += b.vx * dt;
        b.y += b.vy * dt;
        let bounced = false;
        if (b.x < 0) { b.x = 0; b.vx = Math.abs(b.vx); bounced = true; }
        else if (b.x + b.w > vw) { b.x = vw - b.w; b.vx = -Math.abs(b.vx); bounced = true; }
        if (b.y < 0) { b.y = 0; b.vy = Math.abs(b.vy); bounced = true; }
        else if (b.y + b.h > vh) { b.y = vh - b.h; b.vy = -Math.abs(b.vy); bounced = true; }
        if (bounced) {
          const impactSpeed = Math.hypot(b.vx, b.vy);
          b.spin += (Math.random() - 0.5) * impactSpeed * 0.6;
          b.spin = Math.max(-260, Math.min(260, b.spin));
        }
      }
      for (let i = 0; i < bouncers.length; i++) {
        for (let j = i + 1; j < bouncers.length; j++) {
          const A = bouncers[i], B = bouncers[j];
          if (A.x < B.x + B.w && A.x + A.w > B.x && A.y < B.y + B.h && A.y + A.h > B.y) {
            resolveCollision(A, B);
          }
        }
      }
      for (const b of bouncers) {
        b.rot += b.spin * dt;
        b.el.style.left = b.x.toFixed(1) + 'px';
        b.el.style.top = b.y.toFixed(1) + 'px';
        b.el.style.transform = 'rotate(' + b.rot.toFixed(1) + 'deg)';
      }
      rafId = requestAnimationFrame(frame);
    }
    rafId = requestAnimationFrame(frame);
  }

  function stopScreensaver() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    if (bouncers) {
      for (const b of bouncers) {
        if (b.isBrand) { b.el.remove(); continue; }
        b.el.style.position = b.original.position;
        b.el.style.left = b.original.left;
        b.el.style.top = b.original.top;
        b.el.style.margin = b.original.margin;
        b.el.style.zIndex = b.original.zIndex;
        b.el.style.width = b.original.width;
        b.el.style.transition = b.original.transition;
        b.el.style.transform = b.original.transform;
      }
    }
    bouncers = null;
    if (watermark) { watermark.remove(); watermark = null; }
  }


  function resetIdleTimer() {
    clearTimeout(idleTimer);
    idleTimer = isGameTableVisible() ? setTimeout(startScreensaver, K28_TABLE_IDLE_MS) : null;
  }

  function handleActivity(e) { if (e.isTrusted) { stopScreensaver(); resetIdleTimer(); } }
  ['click', 'touchstart'].forEach(evt => document.addEventListener(evt, handleActivity, { passive: true }));
  setInterval(() => { if (idleTimer === null && isGameTableVisible()) resetIdleTimer(); }, 2000);
  window.addEventListener('resize', () => { if (bouncers) stopScreensaver(); resetIdleTimer(); });
  resetIdleTimer();
  window.k28WakeTableScreensaver6p = function() { stopScreensaver(); resetIdleTimer(); };
})();

// Holiday greeting popup -- one-time per browser session, not a
// continuous effect. Replaces the always-on seasonal particle system
// that was removed per explicit request: this only shows a single
// popup once when the table is first entered during a holiday window,
// then never again for the rest of that browser session (sessionStorage
// flag, not localStorage -- a genuinely new session, e.g. a new tab or
// browser restart, is allowed to show it again, but reloading or
// rejoining the SAME table within the same session will not re-trigger
// it). Covers Kerala/Indian holidays, Christian/Western holidays, and
// major US holidays. Movable-date holidays (Onam, Diwali, Thanksgiving,
// Easter) use an approximate fixed window since their real dates shift
// year to year on lunar/lunisolar calendars -- these may need manual
// adjustment in future years to stay accurate.
(function() {
  const HOLIDAYS = [
    { key: 'newyear',    emoji: '🎉', title: 'Happy New Year!',        sub: 'Wishing you a great year of cards ahead',        start: [1,1],  end: [1,2] },
    { key: 'valentines', emoji: '💝', title: "Happy Valentine's Day!", sub: 'Wishing you and your partner good luck today',   start: [2,14], end: [2,14] },
    { key: 'vishu',      emoji: '🌼', title: 'Happy Vishu!',           sub: 'Kerala New Year greetings from 28gulan.com',     start: [4,14], end: [4,16] },
    { key: 'mayday',     emoji: '🌷', title: 'Happy May Day!',         sub: '',                                               start: [5,1],  end: [5,1] },
    { key: 'julyfourth', emoji: '🎆', title: 'Happy Independence Day!',sub: '',                                               start: [7,4],  end: [7,4] },
    { key: 'indiaindep', emoji: '🇮🇳', title: 'Happy Independence Day!',sub: 'Jai Hind',                                       start: [8,15], end: [8,16] },
    { key: 'onam',       emoji: '🌸', title: 'Happy Onam!',            sub: 'Wishing you a joyful Onam from 28gulan.com',     start: [8,20], end: [9,10] },
    { key: 'halloween',  emoji: '🎃', title: 'Happy Halloween!',       sub: '',                                               start: [10,30],end: [11,2] },
    { key: 'diwali',     emoji: '🪔', title: 'Happy Diwali!',          sub: 'Wishing you light and prosperity',               start: [11,1], end: [11,6] },
    { key: 'thanksgiving',emoji:'🦃', title: 'Happy Thanksgiving!',    sub: '',                                               start: [11,24],end: [11,28] },
    { key: 'christmas',  emoji: '🎄', title: 'Merry Christmas!',       sub: 'Happy holidays from 28gulan.com',                start: [12,24],end: [12,26] },
    { key: 'yearend',    emoji: '🥳', title: "Happy New Year's Eve!",  sub: '',                                               start: [12,31],end: [12,31] },
  ];

  function findActiveHoliday() {
    const now = new Date();
    const m = now.getMonth() + 1, d = now.getDate();
    const asNum = (mo, da) => mo * 100 + da;
    const today = asNum(m, d);
    for (const h of HOLIDAYS) {
      const start = asNum(h.start[0], h.start[1]);
      const end = asNum(h.end[0], h.end[1]);
      if (start <= end ? (today >= start && today <= end) : (today >= start || today <= end)) {
        return h;
      }
    }
    return null;
  }

  function spawnConfetti() {
    const host = document.createElement('div');
    host.id = 'k28ConfettiBurst';
    const colors = ['#ffd700','#ff6b6b','#4ecdc4','#f4c430','#e8a33d','#ffffff'];
    for (let i = 0; i < 60; i++) {
      const c = document.createElement('div');
      c.className = 'bit';
      const size = 6 + Math.random() * 7;
      c.style.left = Math.random() * 100 + 'vw';
      c.style.width = size + 'px';
      c.style.height = size + 'px';
      c.style.background = colors[i % colors.length];
      c.style.borderRadius = (i % 2 === 0) ? '0' : '50%';
      c.style.setProperty('--fall', (100 + Math.random() * 25) + 'vh');
      c.style.setProperty('--spin', (Math.random() * 720 - 360) + 'deg');
      c.style.animation = 'k28ConfettiFall ' + (2.6 + Math.random() * 1.8) + 's ease-in ' + (Math.random() * 0.6) + 's forwards';
      host.appendChild(c);
    }
    document.body.appendChild(host);
    setTimeout(() => host.remove(), 4700);
  }

  function showHolidayGreetingIfNeeded() {
    const holiday = findActiveHoliday();
    if (!holiday) return;
    const sessionKey = 'k28_holiday_shown_' + holiday.key;
    if (sessionStorage.getItem(sessionKey)) return; // already shown this session -- don't repeat
    const el = document.getElementById('k28HolidayGreeting');
    if (!el) return;
    document.getElementById('k28hgEmoji').textContent = holiday.emoji;
    document.getElementById('k28hgTitle').textContent = holiday.title;
    document.getElementById('k28hgSub').textContent = holiday.sub;
    sessionStorage.setItem(sessionKey, '1');
    setTimeout(() => {
      el.classList.add('on');
      spawnConfetti();
      setTimeout(() => el.classList.remove('on'), 3800);
    }, 500); // small delay so it doesn't pop in before the table has finished rendering
  }

  showHolidayGreetingIfNeeded();
})();const ALL_PLAYERS = [
  {name:'Ancy',emoji:heroAvatarHtml('toon1'),bg:'linear-gradient(135deg,#ff8fab,#e0648a)'},
  {name:'Ajai',emoji:heroAvatarHtml('toon2'),bg:'linear-gradient(135deg,#e17055,#c44536)'},
  {name:'Alok',emoji:heroAvatarHtml('toon4'),bg:'linear-gradient(135deg,#00b894,#00a085)'},
  {name:'Anup',emoji:heroAvatarHtml('toon10'),bg:'linear-gradient(135deg,#8e44ad,#6c3483)'},
  {name:'Anjali',emoji:heroAvatarHtml('toon3'),bg:'linear-gradient(135deg,#1abc9c,#16a085)'},
  {name:'Appu',emoji:heroAvatarHtml('toon12'),bg:'linear-gradient(135deg,#4a90d9,#2a5a9a)'},
  {name:'Arun',emoji:heroAvatarHtml('toon16'),bg:'linear-gradient(135deg,#f0932b,#c26e0f)'},
  {name:'Meera',emoji:heroAvatarHtml('toon5'),bg:'linear-gradient(135deg,#00cec9,#00a8a3)'},
  {name:'Benson',emoji:heroAvatarHtml('toon18'),bg:'linear-gradient(135deg,#e84393,#c2266f)'},
  {name:'Neha',emoji:heroAvatarHtml('toon6'),bg:'linear-gradient(135deg,#6c5ce7,#4834b0)'},
  {name:'Binchu',emoji:heroAvatarHtml('toon21'),bg:'linear-gradient(135deg,#fdcb6e,#e0a83c)'},
  {name:'Charlie',emoji:heroAvatarHtml('toon23'),bg:'linear-gradient(135deg,#00a8ff,#0077b3)'},
  {name:'Jerin',emoji:heroAvatarHtml('toon25'),bg:'linear-gradient(135deg,#ff8fab,#e0648a)'},
  {name:'Priya',emoji:heroAvatarHtml('toon7'),bg:'linear-gradient(135deg,#e17055,#c44536)'},
  {name:'Johny',emoji:heroAvatarHtml('toon28'),bg:'linear-gradient(135deg,#00b894,#00a085)'},
  {name:'Reena',emoji:heroAvatarHtml('toon8'),bg:'linear-gradient(135deg,#8e44ad,#6c3483)'},
  {name:'Koshy',emoji:heroAvatarHtml('toon31'),bg:'linear-gradient(135deg,#1abc9c,#16a085)'},
  {name:'Nate',emoji:heroAvatarHtml('toon33'),bg:'linear-gradient(135deg,#4a90d9,#2a5a9a)'},
  {name:'Divya',emoji:heroAvatarHtml('toon9'),bg:'linear-gradient(135deg,#f0932b,#c26e0f)'},
  {name:'Peter',emoji:heroAvatarHtml('toon38'),bg:'linear-gradient(135deg,#00cec9,#00a8a3)'},
  {name:'Lakshmi',emoji:heroAvatarHtml('toon11'),bg:'linear-gradient(135deg,#e84393,#c2266f)'},
  {name:'Rahul',emoji:heroAvatarHtml('toon41'),bg:'linear-gradient(135deg,#6c5ce7,#4834b0)'},
  {name:'Rajesh',emoji:heroAvatarHtml('toon46'),bg:'linear-gradient(135deg,#fdcb6e,#e0a83c)'},
  {name:'Randall',emoji:heroAvatarHtml('toon48'),bg:'linear-gradient(135deg,#00a8ff,#0077b3)'},
  {name:'Sarah',emoji:heroAvatarHtml('toon13'),bg:'linear-gradient(135deg,#ff8fab,#e0648a)'},
  {name:'Renji',emoji:heroAvatarHtml('toon50'),bg:'linear-gradient(135deg,#e17055,#c44536)'},
  {name:'Roji',emoji:heroAvatarHtml('toon53'),bg:'linear-gradient(135deg,#00b894,#00a085)'},
  {name:'Nisha',emoji:heroAvatarHtml('toon14'),bg:'linear-gradient(135deg,#8e44ad,#6c3483)'},
  {name:'Roney',emoji:heroAvatarHtml('toon54'),bg:'linear-gradient(135deg,#1abc9c,#16a085)'},
  {name:'Sanjay',emoji:heroAvatarHtml('toon63'),bg:'linear-gradient(135deg,#4a90d9,#2a5a9a)'},
  {name:'Shyam',emoji:heroAvatarHtml('toon67'),bg:'linear-gradient(135deg,#f0932b,#c26e0f)'},
  {name:'Deepa',emoji:heroAvatarHtml('toon15'),bg:'linear-gradient(135deg,#00cec9,#00a8a3)'},
  {name:'Stev',emoji:heroAvatarHtml('toon70'),bg:'linear-gradient(135deg,#e84393,#c2266f)'},
  {name:'Vinod',emoji:heroAvatarHtml('toon74'),bg:'linear-gradient(135deg,#6c5ce7,#4834b0)'},
  {name:'Wesley',emoji:heroAvatarHtml('toon79'),bg:'linear-gradient(135deg,#fdcb6e,#e0a83c)'},
  {name:'Elsa',emoji:heroAvatarHtml('toon17'),bg:'linear-gradient(135deg,#00a8ff,#0077b3)'},
  {name:'Abin',emoji:heroAvatarHtml('toon80'),bg:'linear-gradient(135deg,#ff8fab,#e0648a)'},
  {name:'Maya',emoji:heroAvatarHtml('toon19'),bg:'linear-gradient(135deg,#e17055,#c44536)'},
  {name:'Bibin',emoji:heroAvatarHtml('toon84'),bg:'linear-gradient(135deg,#00b894,#00a085)'},
  {name:'Sherin',emoji:heroAvatarHtml('toon20'),bg:'linear-gradient(135deg,#8e44ad,#6c3483)'},
  {name:'Cibin',emoji:heroAvatarHtml('toon87'),bg:'linear-gradient(135deg,#1abc9c,#16a085)'},
  {name:'Denny',emoji:heroAvatarHtml('toon89'),bg:'linear-gradient(135deg,#4a90d9,#2a5a9a)'},
  {name:'Eldho',emoji:heroAvatarHtml('toon92'),bg:'linear-gradient(135deg,#f0932b,#c26e0f)'},
  {name:'Teena',emoji:heroAvatarHtml('toon22'),bg:'linear-gradient(135deg,#00cec9,#00a8a3)'},
  {name:'Frankie',emoji:heroAvatarHtml('toon94'),bg:'linear-gradient(135deg,#e84393,#c2266f)'},
  {name:'George',emoji:heroAvatarHtml('toon2'),bg:'linear-gradient(135deg,#6c5ce7,#4834b0)'},
  {name:'Anu',emoji:heroAvatarHtml('toon24'),bg:'linear-gradient(135deg,#fdcb6e,#e0a83c)'},
  {name:'Hari',emoji:heroAvatarHtml('toon4'),bg:'linear-gradient(135deg,#00a8ff,#0077b3)'},
  {name:'Ivan',emoji:heroAvatarHtml('toon10'),bg:'linear-gradient(135deg,#ff8fab,#e0648a)'},
  {name:'Reshma',emoji:heroAvatarHtml('toon26'),bg:'linear-gradient(135deg,#e17055,#c44536)'},
  {name:'Jibin',emoji:heroAvatarHtml('toon12'),bg:'linear-gradient(135deg,#00b894,#00a085)'},
  {name:'Kevin',emoji:heroAvatarHtml('toon16'),bg:'linear-gradient(135deg,#8e44ad,#6c3483)'},
  {name:'Libin',emoji:heroAvatarHtml('toon18'),bg:'linear-gradient(135deg,#1abc9c,#16a085)'},
  {name:'Jisha',emoji:heroAvatarHtml('toon27'),bg:'linear-gradient(135deg,#4a90d9,#2a5a9a)'},
  {name:'Manoj',emoji:heroAvatarHtml('toon21'),bg:'linear-gradient(135deg,#f0932b,#c26e0f)'},
  {name:'Nibin',emoji:heroAvatarHtml('toon23'),bg:'linear-gradient(135deg,#00cec9,#00a8a3)'},
  {name:'Oommen',emoji:heroAvatarHtml('toon25'),bg:'linear-gradient(135deg,#e84393,#c2266f)'},
  {name:'Nimmy',emoji:heroAvatarHtml('toon29'),bg:'linear-gradient(135deg,#6c5ce7,#4834b0)'},
  {name:'Pauly',emoji:heroAvatarHtml('toon28'),bg:'linear-gradient(135deg,#fdcb6e,#e0a83c)'},
  {name:'Robin',emoji:heroAvatarHtml('toon31'),bg:'linear-gradient(135deg,#00a8ff,#0077b3)'},
  {name:'Beena',emoji:heroAvatarHtml('toon30'),bg:'linear-gradient(135deg,#ff8fab,#e0648a)'},
  {name:'Sibin',emoji:heroAvatarHtml('toon33'),bg:'linear-gradient(135deg,#e17055,#c44536)'},
  {name:'Tibin',emoji:heroAvatarHtml('toon38'),bg:'linear-gradient(135deg,#00b894,#00a085)'},
  {name:'Unni',emoji:heroAvatarHtml('toon41'),bg:'linear-gradient(135deg,#8e44ad,#6c3483)'},
  {name:'Soumya',emoji:heroAvatarHtml('toon32'),bg:'linear-gradient(135deg,#1abc9c,#16a085)'},
  {name:'Vishnu',emoji:heroAvatarHtml('toon46'),bg:'linear-gradient(135deg,#4a90d9,#2a5a9a)'},
  {name:'Wilson',emoji:heroAvatarHtml('toon48'),bg:'linear-gradient(135deg,#f0932b,#c26e0f)'},
  {name:'Liya',emoji:heroAvatarHtml('toon34'),bg:'linear-gradient(135deg,#00cec9,#00a8a3)'},
  {name:'Xavier',emoji:heroAvatarHtml('toon50'),bg:'linear-gradient(135deg,#e84393,#c2266f)'},
  {name:'Yohan',emoji:heroAvatarHtml('toon53'),bg:'linear-gradient(135deg,#6c5ce7,#4834b0)'},
  {name:'Merin',emoji:heroAvatarHtml('toon35'),bg:'linear-gradient(135deg,#fdcb6e,#e0a83c)'},
  {name:'Zachariah',emoji:heroAvatarHtml('toon54'),bg:'linear-gradient(135deg,#00a8ff,#0077b3)'},
  {name:'Aby',emoji:heroAvatarHtml('toon63'),bg:'linear-gradient(135deg,#ff8fab,#e0648a)'},
  {name:'Bijoy',emoji:heroAvatarHtml('toon67'),bg:'linear-gradient(135deg,#e17055,#c44536)'},
  {name:'Asha',emoji:heroAvatarHtml('toon36'),bg:'linear-gradient(135deg,#00b894,#00a085)'},
  {name:'Anita',emoji:heroAvatarHtml('toon37'),bg:'linear-gradient(135deg,#8e44ad,#6c3483)'},
  {name:'Cyriac',emoji:heroAvatarHtml('toon70'),bg:'linear-gradient(135deg,#1abc9c,#16a085)'},
  {name:'Davis',emoji:heroAvatarHtml('toon74'),bg:'linear-gradient(135deg,#4a90d9,#2a5a9a)'},
  {name:'Betty',emoji:heroAvatarHtml('toon39'),bg:'linear-gradient(135deg,#f0932b,#c26e0f)'},
  {name:'Ebin',emoji:heroAvatarHtml('toon79'),bg:'linear-gradient(135deg,#00cec9,#00a8a3)'},
  {name:'Fenil',emoji:heroAvatarHtml('toon80'),bg:'linear-gradient(135deg,#e84393,#c2266f)'},
  {name:'Gibin',emoji:heroAvatarHtml('toon84'),bg:'linear-gradient(135deg,#6c5ce7,#4834b0)'},
  {name:'Celine',emoji:heroAvatarHtml('toon40'),bg:'linear-gradient(135deg,#fdcb6e,#e0a83c)'},
  {name:'Diya',emoji:heroAvatarHtml('toon42'),bg:'linear-gradient(135deg,#00a8ff,#0077b3)'},
  {name:'Hillary',emoji:heroAvatarHtml('toon43'),bg:'linear-gradient(135deg,#ff8fab,#e0648a)'},
  {name:'Fiona',emoji:heroAvatarHtml('toon44'),bg:'linear-gradient(135deg,#e17055,#c44536)'},
  {name:'Ittoop',emoji:heroAvatarHtml('toon87'),bg:'linear-gradient(135deg,#00b894,#00a085)'},
  {name:'Gracy',emoji:heroAvatarHtml('toon45'),bg:'linear-gradient(135deg,#8e44ad,#6c3483)'},
  {name:'Hema',emoji:heroAvatarHtml('toon47'),bg:'linear-gradient(135deg,#1abc9c,#16a085)'},
  {name:'Jaison',emoji:heroAvatarHtml('toon89'),bg:'linear-gradient(135deg,#4a90d9,#2a5a9a)'},
  {name:'Indu',emoji:heroAvatarHtml('toon49'),bg:'linear-gradient(135deg,#f0932b,#c26e0f)'},
  {name:'Jessy',emoji:heroAvatarHtml('toon51'),bg:'linear-gradient(135deg,#00cec9,#00a8a3)'},
  {name:'Kurian',emoji:heroAvatarHtml('toon92'),bg:'linear-gradient(135deg,#e84393,#c2266f)'},
  {name:'Lijo',emoji:heroAvatarHtml('toon94'),bg:'linear-gradient(135deg,#6c5ce7,#4834b0)'},
  {name:'Kavya',emoji:heroAvatarHtml('toon52'),bg:'linear-gradient(135deg,#fdcb6e,#e0a83c)'},
  {name:'Mathew',emoji:heroAvatarHtml('toon2'),bg:'linear-gradient(135deg,#00a8ff,#0077b3)'},
  {name:'Leena',emoji:heroAvatarHtml('toon55'),bg:'linear-gradient(135deg,#ff8fab,#e0648a)'},
  {name:'Ninan',emoji:heroAvatarHtml('toon4'),bg:'linear-gradient(135deg,#e17055,#c44536)'},
  {name:'Mariya',emoji:heroAvatarHtml('toon56'),bg:'linear-gradient(135deg,#00b894,#00a085)'},
  {name:'Babi',emoji:heroAvatarHtml('toon57'),bg:'linear-gradient(135deg,#c2266f,#8e1c52)'},
  {name:'Oliver',emoji:heroAvatarHtml('toon10'),bg:'linear-gradient(135deg,#8e44ad,#6c3483)'},
];
