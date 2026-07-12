// ============================================================
// 56 — CLIENT
// Server-authoritative: this file only renders whatever `c56_state` the
// server sends and forwards button taps as intents over the c56_ socket
// events implemented in server.js / game-engine-56.js. No game logic
// (legality, scoring, bidding rules) lives here.
// ============================================================

let socket = null;
let MY_TABLE_ID = null;
let MY_PLAYER_ID = null;
try { MY_PLAYER_ID = localStorage.getItem('k56_player_token'); } catch (e) {}
let MY_NAME = '';
let MY_POS = -1;
let latestState = null;
let IS_HOST = false;

const SUIT_SYM = { S: '♠', H: '♥', D: '♦', C: '♣' };
const SUIT_RED = { S: false, H: true, D: true, C: false };
const RANKS_ORDER = ['J', '9', 'A', '10', 'K', 'Q'];

function getTeam(pos) { return pos % 2; }
function teamLetter(t) { return t === 0 ? 'A' : 'B'; }

function showToast(msg, ms) {
  const el = document.getElementById('toastEl');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.remove('show'), ms || 2200);
}

function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text).then(() => true).catch(() => false);
  }
  return Promise.resolve(false);
}

// ---------------- Screen management ----------------
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
  document.getElementById('tableScreen').classList.remove('on');
  if (id === 'table') {
    document.getElementById('tableScreen').classList.add('on');
  } else {
    document.getElementById(id).classList.remove('hidden');
  }
}

// ---------------- Socket connection ----------------
function connectSocket() {
  if (socket) return;
  socket = io();

  socket.on('connect', () => {
    document.getElementById('connStatus').textContent = '🟢 Connected';
    if (MY_TABLE_ID && MY_PLAYER_ID) {
      socket.emit('c56_joinTable', { tableId: MY_TABLE_ID, name: MY_NAME, playerId: MY_PLAYER_ID });
    } else {
      socket.emit('c56_listRooms');
    }
  });

  socket.on('disconnect', () => {
    document.getElementById('connStatus').textContent = '⚠️ Reconnecting...';
    showToast('⚠️ Lost connection — reconnecting...', 3000);
  });

  socket.on('c56_roomList', renderRoomList);

  socket.on('c56_joined', (info) => {
    MY_TABLE_ID = info.tableId;
    MY_PLAYER_ID = info.playerId;
    MY_POS = info.pos;
    IS_HOST = info.isHost;
    try { localStorage.setItem('k56_player_token', info.playerId); } catch (e) {}
    document.getElementById('seatPickerOverlay').classList.remove('on');
    showToast(info.isHost ? '🏠 Table created!' : '✅ Joined!', 1800);
  });

  socket.on('c56_joinError', (err) => {
    const msgs = {
      table_not_found: "That code doesn't exist or the table has closed.",
      table_full: 'That table is full.',
      not_a_bot_seat: 'No bot seat available.',
      replace_failed: 'Could not take that seat.',
      seat_taken: 'Someone just took that seat.'
    };
    showToast('❌ ' + (msgs[err.reason] || 'Could not join.'), 2600);
  });

  socket.on('c56_actionError', (err) => {
    const msgs = {
      not_bidding: "It's not the bidding phase.",
      not_your_turn: "It's not your turn.",
      bid_too_low: 'Your bid must be higher than the current bid.',
      invalid_suit: 'Pick a suit.',
      forced_to_open: "Everyone else passed — you're required to open, you can't pass.",
      cannot_double: "You can't double right now.",
      already_doubled: 'Already doubled.',
      cannot_redouble: "You can't redouble right now.",
      illegal_card: 'You must follow suit if you can.'
    };
    showToast('⚠️ ' + (msgs[err.reason] || 'Not allowed.'), 2200);
  });

  socket.on('c56_chooseSeat', (info) => showSeatPicker(info));
  socket.on('c56_kicked', () => { showToast('You were removed from the table.', 2500); goHome(); });
  socket.on('c56_tableClosed', () => { showToast('Table closed — everyone left.', 2500); goHome(); });
  socket.on('c56_state', (state) => applyState(state));

  socket.on('c56_chat', ({ from, msg }) => showToast(`💬 ${from}: ${msg}`, 2500));
}

function goHome() {
  MY_TABLE_ID = null;
  MY_PLAYER_ID = null;
  try { localStorage.removeItem('k56_player_token'); } catch (e) {}
  showScreen('landingScreen');
  if (socket) socket.emit('c56_listRooms');
}

// ---------------- Landing ----------------
document.getElementById('btnCreateTable').addEventListener('click', () => {
  const name = document.getElementById('nameInput').value.trim();
  if (!name) { showToast('Enter your name first'); return; }
  MY_NAME = name;
  connectSocket();
  socket.emit('c56_createTable', { name });
});

document.getElementById('btnJoinCode').addEventListener('click', () => {
  const name = document.getElementById('nameInput').value.trim();
  const code = document.getElementById('codeInput').value.trim().toUpperCase();
  if (!name) { showToast('Enter your name first'); return; }
  if (!code) { showToast('Enter a table code'); return; }
  MY_NAME = name;
  connectSocket();
  socket.emit('c56_joinTable', { tableId: code, name });
});

function renderRoomList(rooms) {
  const wrap = document.getElementById('roomList');
  if (!rooms || rooms.length === 0) {
    wrap.innerHTML = '<div style="font-size:0.75rem;color:var(--text-secondary)">No public tables right now — create one!</div>';
    return;
  }
  wrap.innerHTML = rooms.map(r => `
    <div class="player-row" style="cursor:pointer" onclick="joinRoomFromList('${r.tableId}')">
      <div class="p-avatar" style="background:linear-gradient(135deg,#9b59b6,#6c3483)">🎴</div>
      <div class="p-name">${escapeHtml(r.name)}'s Table</div>
      <span class="tag ${r.isPlaying ? 'tag-bot' : 'tag-host'}">${r.players}/6 · ${r.isPlaying ? 'Playing' : 'Lobby'}</span>
    </div>`).join('');
}

function joinRoomFromList(tableId) {
  const name = document.getElementById('nameInput').value.trim();
  if (!name) { showToast('Enter your name first'); return; }
  MY_NAME = name;
  connectSocket();
  socket.emit('c56_joinTable', { tableId, name });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------- Seat picker ----------------
function showSeatPicker(info) {
  const opts = document.getElementById('seatOptions');
  let html = '';
  (info.openSeats || []).forEach(pos => {
    html += `<button class="btn btn-primary" style="width:100%" onclick="claimSeat(${pos})">🪑 Take seat ${pos + 1} (Team ${teamLetter(getTeam(pos))})</button>`;
  });
  (info.botSeats || []).forEach(pos => {
    html += `<button class="btn btn-outline" style="width:100%" onclick="claimSeat(${pos})">🤖 Replace bot in seat ${pos + 1}</button>`;
  });
  (info.disconnectedSeats || []).forEach(d => {
    html += `<button class="btn btn-outline" style="width:100%" onclick="claimSeat(${d.pos})">🔌 Reclaim ${escapeHtml(d.name)}'s seat</button>`;
  });
  opts.innerHTML = html || '<div style="font-size:0.8rem;color:var(--text-secondary)">This table is full.</div>';
  document.getElementById('seatPickerOverlay').classList.add('on');
}

function claimSeat(pos) {
  socket.emit('c56_claimSeat', { choice: pos });
}

// ---------------- Lobby ----------------
document.getElementById('lobbyRoomCode').addEventListener('click', function () {
  copyText(MY_TABLE_ID).then(ok => {
    showToast(ok ? '✅ Code copied!' : 'Copy failed — code: ' + MY_TABLE_ID, 2000);
  });
});
document.getElementById('btnStartGame').addEventListener('click', () => {
  socket.emit('c56_fillBots', { count: parseInt(document.getElementById('botFillSelect').value, 10) });
  socket.emit('c56_startGame');
});
document.getElementById('btnLeaveLobby').addEventListener('click', () => {
  socket.emit('c56_leaveTable');
  goHome();
});

function renderLobby(state) {
  showScreen('lobbyScreen');
  document.getElementById('lobbyRoomCode').textContent = MY_TABLE_ID;
  const seatsEl = document.getElementById('lobbySeats');
  seatsEl.innerHTML = state.seats.map((s, i) => {
    if (!s) return `<div class="player-row" style="opacity:0.4"><div class="p-avatar">–</div><div class="p-name">Empty seat ${i + 1}</div><span class="tag tag-bot">Team ${teamLetter(getTeam(i))}</span></div>`;
    const tags = [];
    if (s.isBot) tags.push('<span class="tag tag-bot">Bot</span>');
    if (i === MY_POS) tags.push('<span class="tag tag-you">You</span>');
    return `<div class="player-row"><div class="p-avatar">${s.isBot ? '🤖' : '🧑'}</div><div class="p-name">${escapeHtml(s.name)} <span style="opacity:0.6;font-size:0.7rem">Team ${teamLetter(getTeam(i))}</span></div>${tags.join(' ')}</div>`;
  }).join('');
  document.getElementById('lobbyHostControls').classList.toggle('hidden', !IS_HOST);
}

// ---------------- Bidding ----------------
let bidValue = 28;
let bidKind = 'suit'; // 'suit' | 'nt' | 'ns'
let bidSuit = 'S';

document.getElementById('bidUp').addEventListener('click', () => { bidValue = Math.min(56, bidValue + 1); renderBidValue(); });
document.getElementById('bidDown').addEventListener('click', () => { bidValue = Math.max(28, bidValue - 1); renderBidValue(); });
function renderBidValue() { document.getElementById('bidValueDisplay').textContent = bidValue; }

document.querySelectorAll('.suit-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    bidKind = 'suit';
    bidSuit = btn.dataset.suit;
    document.querySelectorAll('.suit-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    document.getElementById('bidKindNT').classList.remove('btn-gold');
    document.getElementById('bidKindNS').classList.remove('btn-gold');
  });
});
document.getElementById('bidKindNT').addEventListener('click', () => {
  bidKind = 'nt';
  document.querySelectorAll('.suit-btn').forEach(b => b.classList.remove('selected'));
  document.getElementById('bidKindNT').classList.add('btn-gold');
  document.getElementById('bidKindNS').classList.remove('btn-gold');
});
document.getElementById('bidKindNS').addEventListener('click', () => {
  bidKind = 'ns';
  document.querySelectorAll('.suit-btn').forEach(b => b.classList.remove('selected'));
  document.getElementById('bidKindNS').classList.add('btn-gold');
  document.getElementById('bidKindNT').classList.remove('btn-gold');
});

document.getElementById('btnSubmitBid').addEventListener('click', () => {
  if (bidKind === 'suit') {
    socket.emit('c56_placeBid', { bid: { value: bidValue, kind: 'suit', trump: bidSuit, order: 'forward' } });
  } else {
    socket.emit('c56_placeBid', { bid: { value: bidValue, kind: bidKind } });
  }
});
document.getElementById('btnPass').addEventListener('click', () => socket.emit('c56_passBid'));
document.getElementById('btnDouble').addEventListener('click', () => socket.emit('c56_doubleBid'));
document.getElementById('btnRedouble').addEventListener('click', () => socket.emit('c56_redoubleBid'));

function renderBidPanel(state) {
  const overlay = document.getElementById('bidPanelOverlay');
  if (state.phase !== 'bidding' || state.turn !== MY_POS) { overlay.classList.remove('on'); return; }
  overlay.classList.add('on');
  const cb = state.currentBid;
  const minAllowed = cb ? cb.value + 1 : 28;
  bidValue = Math.max(bidValue, minAllowed);
  if (bidValue > 56) bidValue = 56;
  renderBidValue();
  document.getElementById('bidCurrentInfo').textContent = cb
    ? `Current: ${cb.value} ${cb.kind === 'nt' ? 'No Trump' : cb.kind === 'ns' ? 'No Suit' : SUIT_SYM[cb.trump]} — you must bid at least ${minAllowed}`
    : "You're opening the bidding — minimum 28";
  document.getElementById('btnDouble').disabled = !cb || (state.doubled !== 0);
  document.getElementById('btnRedouble').disabled = state.doubled !== 1;
  document.getElementById('btnPass').disabled = (state.forcedSeat === MY_POS && !cb);
}

function renderAuctionClosed(state) {
  const overlay = document.getElementById('auctionClosedOverlay');
  if (state.phase !== 'auctionClosed') { overlay.classList.remove('on'); return; }
  overlay.classList.add('on');
  const cb = state.currentBid;
  const seat = state.seats[cb.seat];
  const trumpTxt = cb.kind === 'nt' ? 'No Trump' : cb.kind === 'ns' ? 'No Suit' : SUIT_SYM[cb.trump] + ' Trump';
  document.getElementById('auctionClosedText').innerHTML =
    `<b>${escapeHtml(seat ? seat.name : '?')}</b> (Team ${teamLetter(getTeam(cb.seat))}) won with <b>${cb.value}</b> ${trumpTxt}` +
    (state.doubled === 1 ? ' · Doubled' : state.doubled === 2 ? ' · Redoubled' : '');
}

// ---------------- Table / seats layout ----------------
// slot 0 = bottom (me), going clockwise
const SEAT_POS = [
  { x: 50, y: 92 }, { x: 88, y: 74 }, { x: 88, y: 26 },
  { x: 50, y: 8 }, { x: 12, y: 26 }, { x: 12, y: 74 }
];
const TRICK_POS = [
  { x: 50, y: 68 }, { x: 68, y: 58 }, { x: 68, y: 40 },
  { x: 50, y: 30 }, { x: 32, y: 40 }, { x: 32, y: 58 }
];
function displaySlot(seat) { return MY_POS < 0 ? seat : (seat - MY_POS + 6) % 6; }

function renderTable(state) {
  showScreen('table');
  const myTeam = getTeam(MY_POS < 0 ? 0 : MY_POS);
  const oppTeam = 1 - myTeam;
  document.getElementById('scoreMinePill').textContent = `You ${state.matchScore[myTeam]}`;
  document.getElementById('scoreTheirsPill').textContent = `Them ${state.matchScore[oppTeam]}`;

  const seatsLayer = document.getElementById('seatsLayer');
  seatsLayer.innerHTML = state.seats.map((s, i) => {
    if (!s) return '';
    const pos = SEAT_POS[displaySlot(i)];
    const active = state.turn === i;
    return `<div class="seat ${active ? 'active' : ''}" style="left:${pos.x}%;top:${pos.y}%">
      <div class="p-avatar">${s.isBot ? '🤖' : '🧑'}</div>
      <div class="sname">${escapeHtml(s.name)}</div>
      <div class="scards">${s.cardCount != null ? s.cardCount + ' cards' : ''}</div>
    </div>`;
  }).join('');

  const trickLayer = document.getElementById('trickLayer');
  trickLayer.innerHTML = (state.table || []).map(p => {
    const pos = TRICK_POS[displaySlot(p.seat)];
    const red = SUIT_RED[p.card.suit];
    return `<div class="trick-slot" style="left:${pos.x}%;top:${pos.y}%">
      <div class="card-mini ${red ? 'red' : ''}">${p.card.rank}${SUIT_SYM[p.card.suit]}</div>
    </div>`;
  }).join('');

  document.getElementById('logStrip').textContent = (state.log && state.log[0]) || '';

  renderHand(state);
  renderBidPanel(state);
  renderAuctionClosed(state);
  renderHandEnd(state);
  renderMatchOver(state);
}

function renderHand(state) {
  const handArea = document.getElementById('handArea');
  if (MY_POS < 0 || !state.seats[MY_POS] || !state.seats[MY_POS].hand) { handArea.innerHTML = ''; return; }
  const hand = state.seats[MY_POS].hand.slice().sort((a, b) => {
    if (a.suit !== b.suit) return a.suit.localeCompare(b.suit);
    return RANKS_ORDER.indexOf(a.rank) - RANKS_ORDER.indexOf(b.rank);
  });
  const canPlay = state.phase === 'play' && state.turn === MY_POS;
  const leadSuit = state.leadSuit;
  const hasLeadSuit = leadSuit ? hand.some(c => c.suit === leadSuit) : false;
  handArea.innerHTML = hand.map(c => {
    const legal = !canPlay ? false : (!leadSuit || !hasLeadSuit || c.suit === leadSuit);
    const red = SUIT_RED[c.suit];
    return `<div class="hand-card ${red ? 'red' : ''} ${canPlay && !legal ? 'illegal' : ''}" data-suit="${c.suit}" data-rank="${c.rank}" onclick="${canPlay && legal ? `playCard('${c.suit}','${c.rank}')` : ''}">
      <div>${c.rank}</div><div>${SUIT_SYM[c.suit]}</div>
    </div>`;
  }).join('');
}

function playCard(suit, rank) {
  socket.emit('c56_playCard', { card: { suit, rank } });
}

// ---------------- Hand end / match over ----------------
document.getElementById('btnContinueHand').addEventListener('click', () => socket.emit('c56_continueRound'));
document.getElementById('btnRestartMatch').addEventListener('click', () => socket.emit('c56_restartGame'));
document.getElementById('btnBackToLanding').addEventListener('click', () => {
  socket.emit('c56_leaveTable');
  goHome();
});

function renderHandEnd(state) {
  const overlay = document.getElementById('handEndOverlay');
  if (state.phase !== 'handEnd' || state.matchOver) { overlay.classList.remove('on'); return; }
  overlay.classList.add('on');
  const r = state.handResult;
  if (r) {
    const madeTxt = r.made ? 'made their bid' : 'fell short';
    document.getElementById('handEndTitle').textContent = r.made ? '✅ Bid made!' : '❌ Bid missed';
    document.getElementById('handEndText').innerHTML =
      `Team ${teamLetter(r.biddingTeam)} ${madeTxt} of <b>${r.bidValue}</b> (scored ${r.teamPoints[r.biddingTeam]} points).<br>` +
      `${r.made ? 'Received' : 'Paid'} <b>${r.amt}</b> table${r.amt !== 1 ? 's' : ''}.`;
  }
  document.getElementById('btnContinueHand').classList.toggle('hidden', !IS_HOST);
  document.getElementById('handEndWaitMsg').classList.toggle('hidden', IS_HOST);
}

function renderMatchOver(state) {
  const overlay = document.getElementById('matchOverOverlay');
  if (!state.matchOver) { overlay.classList.remove('on'); return; }
  overlay.classList.add('on');
  const myTeam = getTeam(MY_POS < 0 ? 0 : MY_POS);
  const won = state.matchWinner === myTeam;
  document.getElementById('matchOverTitle').textContent = won ? '🏆 You won the match!' : '💔 Match lost';
  document.getElementById('matchOverText').textContent = `Team ${teamLetter(state.matchWinner)} wins ${state.matchScore[state.matchWinner]}–${state.matchScore[1 - state.matchWinner]}.`;
  document.getElementById('btnRestartMatch').classList.toggle('hidden', !IS_HOST);
}

// ---------------- State dispatch ----------------
function applyState(state) {
  latestState = state;
  if (state.isHost !== undefined) IS_HOST = state.isHost;
  if (state.phase === 'lobby') {
    renderLobby(state);
  } else {
    renderTable(state);
  }
}

// Boot
connectSocket();
