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
// Matches game-engine-6p.js's getTeam() exactly: even seats vs odd seats.
function sixpGetTeam(pos) { return pos % 2 === 0 ? 0 : 1; }

// A quiet, always-on analog clock built into the table's felt — sits at
// z-index:0, behind every seat and card, so it's felt more than seen: a
// bit of "this is a real table" ambiance rather than a UI element anyone
// needs to read. Updates every 15s, which is plenty for hands this size.
function updateTableClock() {
  const now = new Date();
  const hourEl = $('clockHour'), minEl = $('clockMinute'), secEl = $('clockSecond');
  if (!hourEl || !minEl) return;
  const hourAngle = ((now.getHours() % 12) + now.getMinutes() / 60) * 30;
  const minAngle = now.getMinutes() * 6;
  const secAngle = now.getSeconds() * 6;
  hourEl.style.transform = 'rotate(' + hourAngle + 'deg)';
  minEl.style.transform = 'rotate(' + minAngle + 'deg)';
  if (secEl) secEl.style.transform = 'rotate(' + secAngle + 'deg)';
}
updateTableClock();
setInterval(updateTableClock, 1000);

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

  function setScoreClass(box, diff) {
    if (!box) return;
    box.classList.remove('tie', 'winning', 'losing', 'int-1', 'int-2', 'int-3', 'int-4', 'int-5');
    if (diff === 0) { box.classList.add('tie'); return; }
    const intensity = Math.abs(diff) >= 8 ? 5 : Math.abs(diff) >= 6 ? 4 : Math.abs(diff) >= 4 ? 3 : Math.abs(diff) >= 2 ? 2 : 1;
    box.classList.add(diff > 0 ? 'winning' : 'losing', 'int-' + intensity);
  }
  setScoreClass(yBox, yScore - oScore);
  setScoreClass(oBox, oScore - yScore);
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
let lastAnnouncedHonorsRound = -1; // tracks which round's "Honors called!" toast has already fired
let lastShownRoundVoidMessage = null;
let lastSeenTricksPlayed = -1; // detects exactly when a new trick has just completed
let trickHoldBusy = false;     // a trick is currently mid-reveal (its full pause hasn't elapsed yet)
let sixpTrickRevealQueue = []; // completed tricks still waiting their turn — nothing in here is ever dropped
let lastRoundSeen = -1;
let roundTrickHistory = []; // every completed trick so far THIS round, for the "played so far" view
let roundHistorySeenFor = -1; // which round roundTrickHistory currently belongs to
let lastRenderedTrickSlot = [null, null, null, null, null, null]; // for the card-landing animation diff
let gameOverShownFor = false;

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

  // A real network drop can happen mid-hold or mid-staggered-reveal —
  // whatever local trick-rendering state existed at that exact instant
  // (trickHoldBusy stuck true, a stagger sequence half-finished, etc.)
  // has no way to recover on its own once the connection comes back,
  // since it was designed assuming a continuous, unbroken stream of
  // state updates. Treat every reconnect as a clean slate for rendering
  // purposes — the very next 'state' broadcast will draw the table
  // correctly from scratch regardless of whatever was happening before
  // the drop.
  socket.on('connect', () => {
    trickHoldBusy = false;
    sixpTrickRevealQueue = [];
    lastRenderedTrickSlot = [null, null, null, null, null, null];
    sixpCatchUpGen++;
    if (MY_TABLE_ID && MY_PLAYER_ID) {
      socket.emit('sixp_joinTable', { tableId: MY_TABLE_ID, playerId: MY_PLAYER_ID });
    }
  });
  socket.on('disconnect', () => {
    showToast('⚠️ Lost connection to server — trying to reconnect...', 'lose', 3000);
  });

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
    if (err.reason === 'illegal_card') {
      showToast("⚠️ That card can't be played right now — check what's highlighted", 'lose', 2500);
    }
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

  socket.on('sixp_stillPlayingCheck', ({ seconds }) => showStillPlayingPopup(seconds || 60));
  socket.on('sixp_stillPlayingResolved', () => hideStillPlayingPopup());
  socket.on('sixp_tableClosed', ({ reason }) => {
    hideStillPlayingPopup();
    showToast(reason === 'idle' ? '⏱️ Table closed — nobody confirmed they were still there' : 'Table closed', 'lose', 4000);
    leaveToWelcome();
  });
  socket.on('createBlocked', ({ maxRooms }) => {
    showToast(`🚧 Room Restricted for now to ${maxRooms} — will reopen in a few.`, 'lose', 4000);
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
  const name = $('nameInput').value.trim();
  if (!name || name.length < 2) {
    showToast('Enter a name (2+ chars)', 'lose', 1500);
    return;
  }
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
  updateSixpScoreDisplay(state);
  $('btnHostMenu').style.display = IS_HOST ? 'inline-flex' : 'none';

  const dealerSeat = state.seats[state.dealer];
  $('dealerDisplay').textContent = state.dealer === MY_POS ? 'You' : (dealerSeat ? dealerSeat.name : '—');
  const bidderSeat = state.bidder >= 0 ? state.seats[state.bidder] : null;
  $('bidderDisplay').textContent = bidderSeat
    ? (state.bidder === MY_POS ? 'You' : bidderSeat.name) + (state.highestBid > 0 ? ' (' + state.highestBid + ')' : '')
    : '—';
  {
    const tp = $('teamPointsDisplay');
    const newVal = (state.teamPoints ? state.teamPoints[0] : 0) + ' - ' + (state.teamPoints ? state.teamPoints[1] : 0);
    if (tp.textContent !== newVal) {
      tp.textContent = newVal;
      tp.classList.remove('pop-anim');
      void tp.offsetWidth;
      tp.classList.add('pop-anim');
      setTimeout(() => tp.classList.remove('pop-anim'), 500);
    }
  }
  renderLastTrick(state);

  const tr = $('trumpChip');
  if (state.trumpExposed) {
    tr.textContent = '🎯 Trump: ' + state.trumpSuit + ' ' + suitName(state.trumpSuit) + ' ACTIVE';
    tr.style.color = 'var(--accent)';
    if (!lastAnnouncedTrumpExposed) {
      showToast('⚡ Trump exposed: ' + state.trumpSuit + ' ' + suitName(state.trumpSuit) + '!', 'win', 2200);
    }
    lastAnnouncedTrumpExposed = true;
  } else {
    tr.textContent = '🎯 Trump: Hidden';
    tr.style.color = '';
    lastAnnouncedTrumpExposed = false;
  }

  renderSeats(state);
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
  // Hand restrictions must never update ahead of what the circle is
  // showing — if the circle is still holding the previous completed
  // trick, leave the hand as it was too, and only refresh it once the
  // hold finishes and the circle catches up (see processNextSixpTrickReveal).
  if (!trickHoldBusy && sixpTrickRevealQueue.length === 0) renderHand(state);
  updateTurnLabel(state);
  if ($('hostMenuOverlay').classList.contains('on') && $('hostMenuMainView').style.display !== 'none') renderHostMenuPlayerList();

  if (state.phase !== 'bidding1' && state.highestBid >= 20 && state.bidder >= 0 &&
      state.round !== lastAnnouncedHonorsRound) {
    lastAnnouncedHonorsRound = state.round;
    const bidderName = state.bidder === MY_POS ? 'You' : sixpRelLabel(state.bidder, state.seats);
    showToast('🏆 HONORS CALLED! ' + bidderName + ' bid ' + state.highestBid, 'win', 3200);
  }
  if (state.phase === 'bidding1' && state.currentPlayer === MY_POS) showBidPanel(state);
  else $('bidOverlay').classList.remove('on');

  if (state.phase === 'choosingTrump' && state.currentPlayer === MY_POS && state.bidder === MY_POS) {
    $('trumpOverlay').classList.add('on');
  } else {
    $('trumpOverlay').classList.remove('on');
  }

  if (state.phase === 'roundEnd' && state.round !== lastRoundSeen) {
    lastRoundSeen = state.round;
    // The round can end right on the last trick, whose own 2s-hold +
    // fly-to-winner animation (~3.2s total) may still be playing. Wait for
    // it to actually finish instead of popping the round summary over it.
    (function waitThenShowRoundEnd() {
      if (trickHoldBusy || sixpTrickRevealQueue.length > 0) { setTimeout(waitThenShowRoundEnd, 150); return; }
      showRoundEnd(state);
    })();
  }

  if (state.gameOver && !gameOverShownFor) {
    gameOverShownFor = true;
    (function waitThenShowGameOver() {
      if (trickHoldBusy || sixpTrickRevealQueue.length > 0) { setTimeout(waitThenShowGameOver, 150); return; }
      showGameOver(state);
    })();
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
}

function processNextSixpTrickReveal() {
  if (trickHoldBusy || sixpTrickRevealQueue.length === 0) return;
  trickHoldBusy = true;
  const lastTrick = sixpTrickRevealQueue.shift();

  renderCompletedTrick(lastTrick);
  roundTrickHistory.push(lastTrick);
  renderLastTrickHistory();

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
    h += `<div class="lt-card"><span class="ltr" style="color:${color}">${c.rank}</span><span class="lts" style="color:${color}">${c.suit}</span></div>`;
  }
  h += '</div>';
  const winnerSeat = state.seats[lt.winner];
  const winnerName = lt.winner === MY_POS ? 'You' : (winnerSeat ? winnerSeat.name : ('Seat ' + lt.winner));
  h += `<div class="lt-win">${winnerName} +${lt.points}pt</div>`;
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
      h += `<div class="lt-card"><span class="ltr" style="color:${color}">${c.rank}</span><span class="lts" style="color:${color}">${c.suit}</span></div>`;
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
  socket.emit('sixp_playCard', { card: { suit, rank, points: POINTS[rank] } });
}
function playHiddenTrumpCard() { socket.emit('sixp_playHiddenTrump'); }

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

function showBidPanel(state) {
  const isFirst = state.highestBid === 0 && state.passes === 0;
  const minBid = state.highestBid > 0 ? state.highestBid + 1 : 16;
  $('bidTitle').textContent = 'Place Your Bid';
  $('bidText').innerHTML = (state.highestBid > 0
    ? `Current highest: <b style="color:var(--accent)">${state.highestBid}</b> by ${sixpRelLabel(state.bidder, state.seats)}`
    : 'You are the first bidder — must bid at least 16.') + sixpRenderBidHistory(state.bidHistory, state.seats);
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
  for (let b = minBid; b <= 28; b++) {
    const btn = document.createElement('button');
    btn.className = 'bid-btn';
    btn.textContent = b;
    btn.addEventListener('click', () => showBidConfirm(state, b, false));
    btns.appendChild(btn);
  }
  const mySeat = state.seats[MY_POS];
  const hand = (mySeat && mySeat.hand) || [];
  const sorted = hand.slice().sort((a, b) => SUITS.indexOf(a.suit) - SUITS.indexOf(b.suit) || RANK_ORDER[b.rank] - RANK_ORDER[a.rank]);
  $('bidHandDisplay').innerHTML = sorted.map(c => cardHTML(c, false, false, '')).join('');
  $('bidOverlay').classList.add('on');
}

// A confirm step before the bid actually goes to the server — a
// mis-tap on a bid number was otherwise irreversible the instant it
// registered, with real match points on the line.
function showBidConfirm(state, bid, isPass) {
  const alreadyHighest = state.bidder === MY_POS;
  $('bidTitle').textContent = isPass ? (alreadyHighest ? 'Stay With Your Bid?' : 'Confirm Pass?') : 'Confirm Your Bid';
  $('bidText').innerHTML = isPass
    ? (alreadyHighest
        ? `You'll <b>stay at your bid of ${state.highestBid}</b> — you're already the highest bidder, this just locks it in.`
        : `You are about to <b>PASS</b>.<br>Current highest: <b style="color:var(--accent)">${state.highestBid}</b>`)
    : `You are about to bid: <b style="color:var(--accent);font-size:1.8rem">${bid}</b>` +
      (state.highestBid > 0 ? `<br>Raising from: <b>${state.highestBid}</b> by ${state.seats[state.bidder] ? state.seats[state.bidder].name : '—'}` : '');
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
  confirmBtn.textContent = isPass ? (alreadyHighest ? `✓ Stay at ${state.highestBid}` : '✓ Confirm Pass') : `✓ Confirm Bid ${bid}`;
  confirmBtn.addEventListener('click', () => {
    $('bidOverlay').classList.remove('on');
    socket.emit('sixp_placeBid', { bid: isPass ? 0 : bid });
  });
  btns.appendChild(confirmBtn);
}

// ---------------- Trump choice UI ----------------

let selectedHiddenTrumpCard = null;

document.querySelectorAll('#trumpPickButtons button').forEach(btn => {
  btn.addEventListener('click', () => {
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
    $('trumpOverlay').classList.remove('on');
    const suitBtn = document.querySelector('#trumpPickButtons button.on');
    const chosenSuit = suitBtn ? suitBtn.getAttribute('data-suit') : suit;
    const ht = selectedHiddenTrumpCard ? { suit: selectedHiddenTrumpCard.suit, rank: selectedHiddenTrumpCard.rank, points: selectedHiddenTrumpCard.points } : null;
    socket.emit('sixp_chooseTrump', { suit: chosenSuit, hiddenCard: ht });
    section.style.display = 'none';
  };
}

// ---------------- Round end / game over ----------------

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
  let body = `${bidderName} bid ${r.highestBid} — ${r.made ? 'made it' : 'fell short'}.<br>Team points: ${r.teamPoints[0]} - ${r.teamPoints[1]}<br><b style="color:${myTeamWon ? 'var(--success)' : 'var(--danger)'}">${myTeamWon ? '+' : '-'}${r.pts} match points for your team</b>`;
  if (!IS_HOST) {
    body += `<br><br><span style="color:var(--text-secondary);font-size:0.8rem">⏳ Waiting for the host to start the next round...</span>`;
  }
  $('roundEndBody').innerHTML = body;
  $('btnContinueRound').style.display = IS_HOST ? 'flex' : 'none';
  $('roundEndOverlay').classList.add('on');
}
$('btnContinueRound').addEventListener('click', () => {
  $('roundEndOverlay').classList.remove('on');
  socket.emit('sixp_continueRound');
});

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

  const inviteCode = new URLSearchParams(window.location.search).get('invite');
  if (inviteCode) {
    history.replaceState({}, '', window.location.pathname); // don't re-trigger on refresh
    pendingJoinCode = inviteCode.trim().toUpperCase();
    pendingAction = 'join';
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
async function shareInviteLink() {
  if (!MY_TABLE_ID) { showToast('Join a table first', 'lose', 1500); return; }
  const link = window.location.origin + window.location.pathname + '?invite=' + encodeURIComponent(MY_TABLE_ID);
  const text = `Join my 28 Kerala Gulan 6-player table! Room code: ${MY_TABLE_ID}`;
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
$('btnCloseChat').addEventListener('click', closeChat);
$('chatOverlay').addEventListener('click', function (e) { if (e.target === this) closeChat(); });
$('btnSendChat').addEventListener('click', sendChat);
$('chatInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); sendChat(); } });

// ==================== HOME / LEAVE MID-GAME ====================
// There was previously no way to exit once a game had actually started —
// "Leave Table" only existed on the pre-game lobby screen.
$('btnGameHome').addEventListener('click', () => {
  if (confirm('Leave this table? You can rejoin with the room code if the table is still running.')) {
    leaveToWelcome();
  }
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
  $('hostMenuOverlay').classList.add('on');
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
    html += `<div style="display:flex;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.05)">
      <span style="font-size:0.8rem">${tag} ${escapeHtml(s.name)}${isSelf ? ' (you)' : ''}</span>
      ${actionBtn}
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
