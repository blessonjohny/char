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
let IS_HOST = false;
let pendingJoinCode = null;
let latestState = null;
let lastAnnouncedTrumpExposed = false;
let lastShownRoundVoidMessage = null;
let lastSeenTricksPlayed = -1; // detects exactly when a new trick has just completed
let trickHoldTimer = null;     // holds the completed trick visible briefly before clearing
let lastRoundSeen = -1;

const SUITS = ['♥', '♠', '♦', '♣'];
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
  el.style.cssText = 'background:rgba(26,5,5,0.95);border:1.5px solid ' + (kind === 'lose' ? '#ff5c5c' : '#f4c430') + ';border-radius:12px;padding:8px 16px;color:' + (kind === 'lose' ? '#ff5c5c' : '#f4c430') + ';font-size:0.85rem;font-weight:700;white-space:nowrap;margin-bottom:8px';
  $('toastHost').appendChild(el);
  setTimeout(() => el.remove(), ms || 2000);
}

function connectSocket() {
  if (socket) return;
  socket = io();
  if (window.K28Voice) K28Voice.attach(socket, { getName: () => MY_NAME || 'Player' });

  socket.on('sixp_roomList', (rooms) => renderRoomList(rooms));

  socket.on('sixp_joined', (info) => {
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
    const messages = {
      table_not_found: "That room code doesn't exist.",
      table_full: 'That table is already full.',
      seat_taken: 'Someone just took that seat — pick another.',
      not_a_bot_seat: "That seat isn't a bot anymore — pick another.",
      replace_failed: 'Could not take that seat — pick another.'
    };
    showToast('❌ ' + (messages[err.reason] || 'Could not join.'), 'lose', 2500);
  });

  socket.on('sixp_actionError', (err) => {
    console.log('[server] action rejected:', err.reason);
  });

  socket.on('sixp_chooseSeat', (info) => showSeatPicker(info));

  socket.on('sixp_kicked', () => {
    showToast('You were removed from the table by the host.', 'lose', 3000);
    leaveToWelcome();
  });

  socket.on('sixp_state', (state) => applyState(state));

  socket.on('sixp_chat', ({ from, msg, senderId }) => {
    addChatMessage(from, msg, senderId === socket.id);
  });
}

// ---------------- Welcome / name / create / join flow ----------------

let pendingAction = null; // 'create' | 'join'

$('btnCreate').addEventListener('click', () => { pendingAction = 'create'; showScreen('nameScreen'); });
$('btnShowJoin').addEventListener('click', () => { showScreen('joinScreen'); refreshRoomList(); });
$('btnRules').addEventListener('click', () => {
  alert('28 Kerala Gulan — 6 Player\n\n6 players in 2 teams of 3 (alternating seats).\n36 cards (includes the 6s). J=3pts, 9=2pts, A/10=1pt.\n\nBidding: 16-28 for trump. Highest bidder picks trump and hides one trump card face down.\n\nFirst team to 12 game points wins!');
});
$('btnNameBack').addEventListener('click', () => showScreen('welcomeScreen'));
$('btnNameContinue').addEventListener('click', () => {
  const name = $('nameInput').value.trim() || 'Player';
  MY_NAME = name;
  connectSocket();
  if (pendingAction === 'create') {
    socket.emit('sixp_createTable', { name });
  } else if (pendingAction === 'join' && pendingJoinCode) {
    socket.emit('sixp_joinTable', { tableId: pendingJoinCode, name });
  }
});
$('btnJoinBack').addEventListener('click', () => showScreen('welcomeScreen'));
$('btnJoinByCode').addEventListener('click', () => {
  const code = $('joinCodeInput').value.trim().toUpperCase();
  if (!code) { showToast('Enter a room code first', 'lose', 1500); return; }
  pendingJoinCode = code;
  pendingAction = 'join';
  showScreen('nameScreen');
});

function refreshRoomList() {
  connectSocket();
  socket.emit('sixp_listRooms');
}
function renderRoomList(rooms) {
  const list = $('roomList');
  if (!list) return;
  if (!rooms.length) { list.innerHTML = '<div style="color:var(--text-secondary);font-size:0.8rem;padding:10px">No open tables right now.</div>'; return; }
  list.innerHTML = rooms.map(r => `
    <div class="room-row">
      <div><b>${escapeHtml(r.name)}</b><br><span style="color:var(--text-secondary)">${r.players}/6 · ${r.isPlaying ? 'Playing' : 'Lobby'}</span></div>
      <button class="btn btn-outline" style="width:auto;margin:0;padding:8px 14px" data-code="${r.tableId}" ${r.canJoinSeat ? '' : 'disabled'}>JOIN</button>
    </div>`).join('');
  list.querySelectorAll('button[data-code]').forEach(btn => {
    btn.addEventListener('click', () => {
      pendingJoinCode = btn.getAttribute('data-code');
      pendingAction = 'join';
      showScreen('nameScreen');
    });
  });
}
function escapeHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

// ---------------- Seat picker ----------------

function showSeatPicker(info) {
  const body = $('seatPickerBody');
  const seatsHtml = info.seats.filter(Boolean).map(s => `🟢 Seat ${s.pos + 1}: ${escapeHtml(s.name)}${s.isHost ? ' (Host)' : ''}`).join('<br>');
  body.innerHTML = 'Currently at the table:<br>' + (seatsHtml || '<i>Nobody yet</i>');
  const opts = $('seatPickerOptions');
  opts.innerHTML = '';
  for (const pos of info.openSeats) {
    const btn = document.createElement('button');
    btn.className = 'btn btn-outline'; btn.style.margin = '0';
    btn.textContent = '🪑 Take Seat ' + (pos + 1);
    btn.addEventListener('click', () => socket.emit('sixp_claimSeat', { choice: pos }));
    opts.appendChild(btn);
  }
  for (const pos of info.botSeats) {
    const btn = document.createElement('button');
    btn.className = 'btn btn-outline'; btn.style.margin = '0';
    btn.textContent = '🤖 Replace Bot at Seat ' + (pos + 1);
    btn.addEventListener('click', () => socket.emit('sixp_claimSeat', { choice: pos }));
    opts.appendChild(btn);
  }
  for (const d of info.disconnectedSeats) {
    const btn = document.createElement('button');
    btn.className = 'btn btn-outline'; btn.style.margin = '0';
    btn.textContent = '🔌 Take Over ' + escapeHtml(d.name) + "'s Seat";
    btn.addEventListener('click', () => socket.emit('sixp_claimSeat', { choice: d.pos }));
    opts.appendChild(btn);
  }
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
  latestState = state;

  if (state.roundVoidMessage && state.roundVoidMessage !== lastShownRoundVoidMessage) {
    lastShownRoundVoidMessage = state.roundVoidMessage;
    showToast('🚫 ' + state.roundVoidMessage, 'lose', 3500);
  } else if (!state.roundVoidMessage) {
    lastShownRoundVoidMessage = null;
  }

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
  $('scoreA').textContent = state.gameScore[0];
  $('scoreB').textContent = state.gameScore[1];
  $('btnHostMenu').style.display = IS_HOST ? 'inline-flex' : 'none';

  const dealerSeat = state.seats[state.dealer];
  $('dealerDisplay').textContent = state.dealer === MY_POS ? 'You' : (dealerSeat ? dealerSeat.name : '—');
  const bidderSeat = state.bidder >= 0 ? state.seats[state.bidder] : null;
  $('bidderDisplay').textContent = bidderSeat
    ? (state.bidder === MY_POS ? 'You' : bidderSeat.name) + (state.highestBid > 0 ? ' (' + state.highestBid + ')' : '')
    : '—';
  $('teamPointsDisplay').textContent = (state.teamPoints ? state.teamPoints[0] : 0) + ' - ' + (state.teamPoints ? state.teamPoints[1] : 0);
  renderLastTrick(state);

  const tr = $('trumpChip');
  if (state.trumpExposed) {
    tr.textContent = '🎯 Trump: ' + state.trumpSuit + ' ACTIVE';
    tr.style.color = 'var(--accent)';
    if (!lastAnnouncedTrumpExposed) {
      showToast('⚡ Trump exposed: ' + state.trumpSuit + '!', 'win', 2200);
    }
    lastAnnouncedTrumpExposed = true;
  } else {
    tr.textContent = '🎯 Trump: Hidden';
    tr.style.color = '';
    lastAnnouncedTrumpExposed = false;
  }

  renderSeats(state);
  const tricksPlayed = state.tricksPlayed || 0;
  if (tricksPlayed > lastSeenTricksPlayed && state.lastTrick) {
    // A trick just completed since the last render — show it fully (with
    // the winning card highlighted) and hold it on screen for a moment
    // before clearing, instead of the table wiping instantly the second
    // the last card lands with no time to actually see what happened.
    lastSeenTricksPlayed = tricksPlayed;
    renderCompletedTrick(state.lastTrick);
    if (trickHoldTimer) clearTimeout(trickHoldTimer);
    trickHoldTimer = setTimeout(() => {
      trickHoldTimer = null;
      if (latestState) renderTrick(latestState); // reflect whatever's actually current by now
    }, 1300);
  } else if (!trickHoldTimer) {
    renderTrick(state);
  }
  renderHand(state);
  updateTurnLabel(state);

  if (state.phase === 'bidding1' && state.currentPlayer === MY_POS) showBidPanel(state);
  else $('bidOverlay').classList.remove('on');

  if (state.phase === 'choosingTrump' && state.currentPlayer === MY_POS && state.bidder === MY_POS) {
    $('trumpOverlay').classList.add('on');
  } else {
    $('trumpOverlay').classList.remove('on');
  }

  if (state.phase === 'roundEnd' && state.round !== lastRoundSeen) {
    lastRoundSeen = state.round;
    showRoundEnd(state);
  }

  if (state.gameOver) {
    showGameOver(state);
  }
}

function slotFor(pos) { return (pos - MY_POS + 6) % 6; }
// Hexagon layout, slot 0 (me) at the bottom-center.
const SLOT_POS = [
  { left: '50%', top: '96%' },   // 0 me
  { left: '85%', top: '78%' },   // 1
  { left: '85%', top: '22%' },   // 2
  { left: '50%', top: '4%' },    // 3
  { left: '15%', top: '22%' },   // 4
  { left: '15%', top: '78%' }    // 5
];
// Each played card sits about 55% of the way from that seat toward the
// center of the table — radiating in front of whoever played it, same
// spirit as the 4-player game's per-seat trick slots, instead of every
// card just piling into one static row in the dead middle.
const TRICK_SLOT_POS = SLOT_POS.map(p => {
  const l = parseFloat(p.left), t = parseFloat(p.top);
  return { left: (l + (50 - l) * 0.55) + '%', top: (t + (50 - t) * 0.55) + '%' };
});
function ensureSeatPositions() {
  for (let slot = 0; slot < 6; slot++) {
    const el = $('seatWrap' + slot);
    el.style.left = SLOT_POS[slot].left;
    el.style.top = SLOT_POS[slot].top;
    el.style.transform = 'translate(-50%,-50%)';
    const ts = $('trickSlot' + slot);
    ts.style.left = TRICK_SLOT_POS[slot].left;
    ts.style.top = TRICK_SLOT_POS[slot].top;
  }
}
ensureSeatPositions();

function renderSeats(state) {
  for (let pos = 0; pos < 6; pos++) {
    const slot = slotFor(pos);
    const seat = state.seats[pos];
    const av = $('av' + slot), nm = $('nm' + slot), cc = $('cc' + slot), wrap = $('seatWrap' + slot);
    if (!seat) { av.textContent = ''; nm.textContent = ''; cc.textContent = ''; wrap.style.opacity = '0.25'; continue; }
    wrap.style.opacity = '1';
    av.textContent = seat.isBot ? '🤖' : (pos === MY_POS ? '😊' : '👤');
    nm.textContent = seat.name + (pos === MY_POS ? ' (You)' : '');
    cc.textContent = seat.cardCount + 'c';
    wrap.classList.toggle('on', state.currentPlayer === pos && (state.phase === 'bidding1' || state.phase === 'play' || state.phase === 'choosingTrump'));
    let badge = '';
    if (pos === state.dealer) badge = 'D';
    if (pos === state.bidder && state.highestBid > 0) badge = 'B' + state.highestBid;
    let bdgEl = wrap.querySelector('.bdg');
    if (badge) {
      if (!bdgEl) { bdgEl = document.createElement('div'); bdgEl.className = 'bdg'; av.appendChild(bdgEl); }
      bdgEl.textContent = badge;
    } else if (bdgEl) { bdgEl.remove(); }
  }
}

function renderTrick(state) {
  // Clear every slot first, then fill in only the seats that have
  // actually played into the current trick — each card sits near the
  // seat that played it, not bunched into one static center pile.
  for (let slot = 0; slot < 6; slot++) $('trickSlot' + slot).innerHTML = '';
  for (const tc of (state.trickCards || [])) {
    const slot = slotFor(tc.pos);
    $('trickSlot' + slot).innerHTML = cardHTML(tc.card, false, false, 'tiny');
  }
}

function renderCompletedTrick(lastTrick) {
  for (let slot = 0; slot < 6; slot++) $('trickSlot' + slot).innerHTML = '';
  for (const tc of lastTrick.cards) {
    const slot = slotFor(tc.pos);
    const isWinner = tc.pos === lastTrick.winner;
    $('trickSlot' + slot).innerHTML = cardHTML(tc.card, false, false, 'tiny' + (isWinner ? ' trick-winner' : ''));
  }
}

function renderLastTrick(state) {
  const el = $('lastTrickContent');
  if (!el) return;
  if (!state.lastTrick || !state.lastTrick.cards || !state.lastTrick.cards.length) {
    el.innerHTML = '<div class="lt-empty">None yet</div>';
    return;
  }
  const lt = state.lastTrick;
  let h = '<div class="lt-cards">';
  for (const tc of lt.cards) {
    const c = tc.card;
    const color = cardColor(c.suit);
    h += `<div class="lt-card"><span class="ltr" style="color:${color}">${c.rank}</span><span class="lts" style="color:${color}">${c.suit}</span></div>`;
  }
  h += '</div>';
  const winnerSeat = state.seats[lt.winner];
  const winnerName = lt.winner === MY_POS ? 'You' : (winnerSeat ? winnerSeat.name : ('Seat ' + lt.winner));
  h += `<div class="lt-win">${winnerName} +${lt.points}pt</div>`;
  el.innerHTML = h;
}

function updateTurnLabel(state) {
  const lbl = $('turnLabel');
  if (state.phase === 'roundEnd' || state.gameOver) { lbl.textContent = ''; return; }
  if (state.currentPlayer === MY_POS) {
    lbl.textContent = state.phase === 'bidding1' ? 'Your turn to bid' : state.phase === 'choosingTrump' ? 'Choose trump' : 'Your turn';
  } else {
    const seat = state.seats[state.currentPlayer];
    lbl.textContent = seat ? (seat.name + "'s turn") : '';
  }
}

// ---------------- Card rendering (same crisp SVG suit design as the 4p game) ----------------

function suitIconSvg(suit, cls) {
  const id = SUIT_ICON_ID[suit] || 'spade';
  return `<svg class="${cls}" viewBox="0 0 100 100" aria-hidden="true"><use href="#suit-${id}"></use></svg>`;
}
function cardColor(suit) { return (suit === '♥' || suit === '♦') ? '#c0392b' : '#111'; }
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
  return true;
}

function renderHand(state) {
  const mySeat = state.seats[MY_POS];
  const hand = (mySeat && mySeat.hand) || [];
  const sorted = hand.slice().sort((a, b) => SUITS.indexOf(a.suit) - SUITS.indexOf(b.suit) || RANK_ORDER[b.rank] - RANK_ORDER[a.rank]);
  const myTurn = state.phase === 'play' && state.currentPlayer === MY_POS;
  $('handCards').innerHTML = sorted.map(c => cardHTML(c, myTurn, myTurn && !canPlay(state, c), '')).join('');

  // Hidden trump card (mine to play, once trump chosen) shows as an extra
  // face-up card at the end of the hand once nothing else can legally be led.
  if (state.myHiddenTrumpCard && myTurn && hand.length === 0) {
    $('handCards').innerHTML += `<div class="card" style="border:2px solid var(--accent)" onclick="playHiddenTrumpCard()">
      <span class="cr" style="color:${cardColor(state.myHiddenTrumpCard.suit)}">${state.myHiddenTrumpCard.rank}</span>
      <span class="cs" style="color:${cardColor(state.myHiddenTrumpCard.suit)}">${suitIconSvg(state.myHiddenTrumpCard.suit, 'suit-icon-center')}</span>
    </div>`;
  }

  // Can't follow suit and trump not exposed yet -> offer Call Trump.
  const hasSuit = hand.some(c => c.suit === state.trickSuit);
  if (myTurn && state.trickSuit !== '' && !hasSuit && !state.trumpExposed) {
    $('callTrumpOverlay').classList.add('on');
  } else {
    $('callTrumpOverlay').classList.remove('on');
  }
}

function playHandCard(suit, rank) {
  if (!latestState || latestState.currentPlayer !== MY_POS) return;
  socket.emit('sixp_playCard', { card: { suit, rank, points: POINTS[rank] } });
}
function playHiddenTrumpCard() { socket.emit('sixp_playHiddenTrump'); }

$('btnCallTrumpYes').addEventListener('click', () => {
  $('callTrumpOverlay').classList.remove('on');
  socket.emit('sixp_callTrump');
});
$('btnCallTrumpNo').addEventListener('click', () => {
  $('callTrumpOverlay').classList.remove('on');
  // Play lowest legal card instead.
  const hand = (latestState.seats[MY_POS] && latestState.seats[MY_POS].hand) || [];
  const legal = hand.slice().sort((a, b) => RANK_ORDER[a.rank] - RANK_ORDER[b.rank]);
  if (legal[0]) playHandCard(legal[0].suit, legal[0].rank);
});

// ---------------- Bidding UI ----------------

function showBidPanel(state) {
  const isFirst = state.highestBid === 0 && state.passes === 0;
  const minBid = state.highestBid > 0 ? state.highestBid + 1 : 16;
  $('bidTitle').textContent = 'Place Your Bid';
  $('bidText').innerHTML = state.highestBid > 0
    ? `Current highest: <b style="color:var(--accent)">${state.highestBid}</b> by ${state.seats[state.bidder] ? state.seats[state.bidder].name : '—'}`
    : 'You are the first bidder — must bid at least 16.';
  const btns = $('bidButtons');
  btns.innerHTML = '';
  if (!isFirst) {
    const pass = document.createElement('button');
    pass.className = 'bid-btn pass-btn';
    pass.textContent = 'PASS';
    pass.addEventListener('click', () => { $('bidOverlay').classList.remove('on'); socket.emit('sixp_placeBid', { bid: 0 }); });
    btns.appendChild(pass);
  }
  for (let b = minBid; b <= 28; b++) {
    const btn = document.createElement('button');
    btn.className = 'bid-btn';
    btn.textContent = b;
    btn.addEventListener('click', () => { $('bidOverlay').classList.remove('on'); socket.emit('sixp_placeBid', { bid: b }); });
    btns.appendChild(btn);
  }
  const mySeat = state.seats[MY_POS];
  const hand = (mySeat && mySeat.hand) || [];
  const sorted = hand.slice().sort((a, b) => SUITS.indexOf(a.suit) - SUITS.indexOf(b.suit) || RANK_ORDER[b.rank] - RANK_ORDER[a.rank]);
  $('bidHandDisplay').innerHTML = sorted.map(c => cardHTML(c, false, false, '')).join('');
  $('bidOverlay').classList.add('on');
}

// ---------------- Trump choice UI ----------------

document.querySelectorAll('#trumpPickButtons button').forEach(btn => {
  btn.addEventListener('click', () => {
    const suit = btn.getAttribute('data-suit');
    $('trumpOverlay').classList.remove('on');
    socket.emit('sixp_chooseTrump', { suit, hiddenCard: null }); // server picks the lowest trump automatically if none specified
  });
});

// ---------------- Round end / game over ----------------

function showRoundEnd(state) {
  const r = state.roundWinnerAnnounced;
  if (!r) return;
  $('roundEndTitle').textContent = r.made ? '✅ Bid Made!' : '❌ Bid Failed';
  const bidderName = state.seats[r.bidder] ? state.seats[r.bidder].name : ('Seat ' + r.bidder);
  $('roundEndBody').innerHTML = `${bidderName} bid ${r.highestBid}.<br>Team points: ${r.teamPoints[0]} - ${r.teamPoints[1]}<br><b style="color:${r.made ? 'var(--success)' : 'var(--danger)'}">${r.made ? '+' : '-'}${r.pts} match points</b>`;
  $('btnContinueRound').style.display = IS_HOST ? 'flex' : 'none';
  $('roundEndOverlay').classList.add('on');
}
$('btnContinueRound').addEventListener('click', () => {
  $('roundEndOverlay').classList.remove('on');
  socket.emit('sixp_continueRound');
});

function showGameOver(state) {
  $('roundEndOverlay').classList.remove('on');
  const won = state.gameOver.winningTeam === (MY_POS % 2 === 0 ? 0 : 1);
  $('gameOverTitle').textContent = won ? '🏆 You Win!' : '😢 Defeat';
  $('gameOverBody').innerHTML = `Final score — Team A: ${state.gameOver.finalScore[0]}, Team B: ${state.gameOver.finalScore[1]}`;
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
  let tableId = null, sessionTime = 0;
  try {
    tableId = localStorage.getItem('k28six_table_id');
    sessionTime = parseInt(localStorage.getItem('k28six_session_time') || '0', 10);
  } catch (e) {}
  const RECENT_WINDOW_MS = 3 * 60 * 1000;
  if (tableId && MY_PLAYER_ID && sessionTime && (Date.now() - sessionTime) < RECENT_WINDOW_MS) {
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
  div.innerHTML = '<div class="chat-from">' + (isMine ? 'You' : escapeHtml(from)) + '</div>' + escapeHtml(msg);
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
  if (!$('chatOverlay').classList.contains('on') && !isMine) {
    chatUnread++;
    const badge = $('chatBadge');
    if (badge) { badge.textContent = chatUnread > 9 ? '9+' : chatUnread; badge.classList.add('on'); }
  }
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
$('btnCloseChat').addEventListener('click', closeChat);
$('chatOverlay').addEventListener('click', function (e) { if (e.target === this) closeChat(); });
$('btnSendChat').addEventListener('click', sendChat);
$('chatInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); sendChat(); } });
