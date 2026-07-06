// ============================================================
// 28 KERALA GULAN — AUTHORITATIVE SERVER
// ============================================================
// This replaces the old PeerJS signaling-only server. Previously this
// process just introduced two browsers to each other and then got out of
// the way — the actual game lived entirely in whichever player's tab
// created the room. If that tab died, the game died with it, and there
// was nothing else in existence to reconnect to.
//
// Now the game itself runs HERE, in the `tables` map below, for as long
// as the table exists. Browsers are thin clients: they send an intent
// (bid, playCard, chooseTrump...) over a socket and get back their own
// sanitized view of the current state. Nobody's individual disconnect —
// not even the player who created the table — can destroy it anymore.
//
// Reconnection is identity-based, not name-based: each browser is given a
// persistent `playerId` (a random token) the first time it connects,
// which it stores in localStorage and sends on every future connection.
// If that token matches a seat that's currently marked disconnected, the
// player reclaims that exact seat (same hand, same turn, same everything)
// under whatever name they show up with this time. If the token is new
// or doesn't match anything live, they're just a new player looking for
// an open seat — exactly as requested.
// ============================================================

const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');
const { GameEngine } = require('./game-engine');

const app = express();
const PORT = process.env.PORT || 9000;

// Browsers (especially mobile) cache static files aggressively by default,
// which means a redeploy can silently NOT reach a returning player — they
// keep seeing whatever old version their browser already cached. The game
// is small enough, and changes often enough during active development,
// that it's worth explicitly telling every browser never to cache it.
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res) => { res.setHeader('Cache-Control', 'no-store, must-revalidate'); }
}));
app.get('/status', (req, res) => {
  res.send('28 Kerala Gulan — Authoritative Server running ✅ | ' + Object.keys(tables).length + ' active table(s)');
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// ---------------- Table registry ----------------
// tableId -> {
//   engine: GameEngine,
//   name: string (display name for discovery lists),
//   hostPlayerId: string,       // who can Start/Manage Seats — a lobby
//                                // permission only, NOT game authority
//   botFill: number,
//   createdAt: number,
//   lastActivityAt: number,     // bumped on every real player action
//   sockets: Map(socketId -> { playerId, pos })  // pos === -1 = spectator
// }
const tables = {};

// playerId -> { tableId, pos } — lets a reconnecting browser find its old
// seat immediately without having to know/remember the table id itself.
const playerIndex = {};

// Tracks a join in progress that's waiting on the joiner to actually pick
// a seat/bot-to-replace/watch — keyed by the joining socket's id. Set
// either immediately (lobby, no approval needed) or after the host
// approves a mid-game join request.
const pendingSeatChoice = {};

// Server-wide entry lock, set/cleared by the admin panel. When set, brand
// new table creations and brand new joins require this code — but anyone
// already seated, and anyone reconnecting to a seat they already hold,
// is completely unaffected. This gates NEW entry only, never continuation.
let serverLockCode = null;

// Matches the client's ADMIN_PASSWORD default (0000) — that's the panel
// this lock feature actually lives in — so it works out of the box, but
// can be overridden per-deployment via an environment variable without
// touching either file.
const ADMIN_SECRET = process.env.ADMIN_SECRET || '0000';

function newId() { return crypto.randomBytes(8).toString('hex'); }
function newTableId() { return crypto.randomBytes(4).toString('hex').toUpperCase(); }

// Seats a new joiner can step into beyond the fully-empty ones: real bot
// seats, plus any seat left behind by a human who disconnected (still a
// real occupied seat with a hand and a turn — just nobody there to act on
// it beyond the engine's own auto-play fallback). Keeping these as two
// separate lists lets the client label them honestly ("Replace Bot" vs
// "Take Over so-and-so's seat") instead of pretending a dropped player's
// spot is just another bot.
function joinableSeats(t) {
  const botSeats = [];
  const disconnectedSeats = [];
  t.engine.seats.forEach((s, i) => {
    if (!s) return;
    if (s.isBot) botSeats.push(i);
    else if (!s.connected) disconnectedSeats.push({ pos: i, name: s.name });
  });
  return { botSeats, disconnectedSeats };
}

// A snapshot of who's sitting where right now, so a joiner picking a seat
// can see the existing roster and — since 28 is partnered, seats 0&3 vs
// 1&2 — who they'd be teamed up with before committing to a seat, instead
// of just picking a bare seat number blind.
function seatSnapshot(t) {
  return t.engine.seats.map((s, i) => s ? { pos: i, name: s.name, isBot: s.isBot, connected: s.connected, isHost: s.playerId === t.hostPlayerId } : null);
}

// If every human has left/disconnected and only bots remain, there's no one
// for the game to actually be for — it would otherwise just keep playing
// bot-vs-bot forever, burning server resources with nobody watching.
function hasAnyHuman(t) {
  return t.engine.seats.some(s => s && !s.isBot);
}

function publicTableList() {
  return Object.values(tables)
    .filter(t => t.engine.seats.some(Boolean))
    .map(t => {
      const openSeats = t.engine.emptySeats().length;
      const botSeats = t.engine.seats.filter(s => s && s.isBot).length;
      return {
        tableId: t.engine.tableId,
        name: t.name,
        players: t.engine.seats.filter(Boolean).length,
        isPlaying: t.engine.phase !== 'lobby',
        openSeats, botSeats,
        spectators: t.spectators ? t.spectators.size : 0,
        canJoinSeat: openSeats > 0 || botSeats > 0
      };
    });
}

function broadcastTable(t) {
  for (const [socketId, info] of t.sockets) {
    const sock = io.sockets.sockets.get(socketId);
    if (!sock) continue;
    const state = t.engine.stateFor(info.pos);
    state.isHost = (info.playerId === t.hostPlayerId);
    sock.emit('state', state);
  }
  if (t.spectators) {
    for (const [socketId] of t.spectators) {
      const sock = io.sockets.sockets.get(socketId);
      if (sock) {
        const state = t.engine.stateFor(-1); // never matches a real seat — naturally produces a hand-free view
        state.isHost = false;
        sock.emit('state', state);
      }
    }
  }
  io.emit('roomList', publicTableList()); // cheap enough at this scale; trims a room's "Playing" badge live
}

function touch(t) { t.lastActivityAt = Date.now(); }

// If a table has zero real humans left (everyone who's left is a bot, or
// the table is just empty), don't let it sit around playing bot-vs-bot for
// the full 5-minute idle window — give a short grace period in case someone
// reconnects quickly, then close it. Called after every disconnect/leave;
// cancelled automatically the moment a human is present again.
const NO_HUMAN_GRACE_MS = 60 * 1000;
function scheduleNoHumanShutdown(t, id) {
  if (t.noHumanShutdownTimer) { clearTimeout(t.noHumanShutdownTimer); t.noHumanShutdownTimer = null; }
  if (hasAnyHuman(t)) return; // someone's still here — nothing to schedule
  console.log(`[cleanup] Table ${id} has no humans left — closing in ${NO_HUMAN_GRACE_MS / 1000}s unless someone reconnects`);
  t.noHumanShutdownTimer = setTimeout(() => {
    const stillThere = tables[id];
    if (!stillThere || hasAnyHuman(stillThere)) return; // a human came back in the meantime
    console.log(`[cleanup] Closing table ${id} — no humans left, only bots (60s grace period elapsed)`);
    for (const s of stillThere.engine.seats) if (s && s.playerId) delete playerIndex[s.playerId];
    delete tables[id];
    io.emit('roomList', publicTableList());
  }, NO_HUMAN_GRACE_MS);
}

// Reap tables that have had no real (human) activity for 5 minutes AND
// currently have nobody connected at all — mirrors the "close after 5 min
// idle" policy from the old client, but now enforced centrally instead of
// depending on any one browser's timer still being alive to do it.
const IDLE_LIMIT_MS = 5 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const id of Object.keys(tables)) {
    const t = tables[id];
    const anyoneConnected = t.engine.seats.some(s => s && s.connected);
    if (!anyoneConnected && now - t.lastActivityAt > IDLE_LIMIT_MS) {
      console.log(`[cleanup] Closing idle table ${id} (${now - t.lastActivityAt}ms since last activity)`);
      for (const s of t.engine.seats) if (s && s.playerId) delete playerIndex[s.playerId];
      delete tables[id];
    }
  }
  io.emit('roomList', publicTableList());
}, 30000);

io.on('connection', (socket) => {
  let playerId = null;
  let tableId = null;

  // Every fresh connection immediately learns whether the server is
  // locked, so the client can show the code prompt before even attempting
  // create/join rather than after a round-trip failure.
  socket.emit('lockStatus', { locked: !!serverLockCode });

  socket.on('listRooms', () => {
    socket.emit('roomList', publicTableList());
  });

  // Admin-only: set or clear the server-wide entry lock. Verified against
  // a server-side secret so this can't just be called from devtools by
  // anyone who noticed the event name — the client's own password prompt
  // is a convenience, not the actual security boundary.
  socket.on('adminSetLock', ({ adminPassword, code }) => {
    if (adminPassword !== ADMIN_SECRET) return;
    const trimmed = String(code || '').trim();
    if (!trimmed) return;
    serverLockCode = trimmed;
    io.emit('lockStatus', { locked: true });
    console.log(`[admin] server locked with a new entry code`);
  });

  socket.on('adminClearLock', ({ adminPassword }) => {
    if (adminPassword !== ADMIN_SECRET) return;
    serverLockCode = null;
    io.emit('lockStatus', { locked: false });
    console.log('[admin] server lock cleared');
  });

  socket.on('createTable', ({ name, code }) => {
    if (serverLockCode && code !== serverLockCode) {
      socket.emit('lockRequired', { action: 'create' });
      return;
    }
    const id = newTableId();
    const engine = new GameEngine(id);
    playerId = newId();
    engine.seatHuman(3, name || 'Player', playerId);
    const t = {
      engine, name: name || 'Player', hostPlayerId: playerId,
      botFill: 3, createdAt: Date.now(), lastActivityAt: Date.now(),
      sockets: new Map()
    };
    // This is the fix that makes bot moves actually reach players: bots
    // act asynchronously via setImmediate, completely outside any socket
    // event handler, so nothing would otherwise tell connected clients a
    // bot just moved. Every state mutation inside the engine — human or
    // bot-triggered — now funnels through here.
    engine.onChange = () => { touch(t); broadcastTable(t); };
    tables[id] = t;
    tableId = id;
    playerIndex[playerId] = { tableId: id, pos: 3 };
    t.sockets.set(socket.id, { playerId, pos: 3 });
    socket.join(id);
    socket.emit('joined', { tableId: id, playerId, pos: 3, isHost: true });
    broadcastTable(t);
    scheduleNoHumanShutdown(t, id);
    io.emit('roomList', publicTableList());
    console.log(`[table ${id}] created by ${name}`);
  });

  socket.on('joinTable', ({ tableId: reqTableId, name, playerId: existingPlayerId, code }) => {
    // Reconnect path: known token pointing at a real, still-existing seat.
    if (existingPlayerId && playerIndex[existingPlayerId]) {
      const idx = playerIndex[existingPlayerId];
      const t = tables[idx.tableId];
      if (t && t.engine.seats[idx.pos] && t.engine.seats[idx.pos].playerId === existingPlayerId) {
        playerId = existingPlayerId;
        tableId = idx.tableId;
        t.engine.markConnected(idx.pos, true);
        if (name) t.engine.seats[idx.pos].name = name;
        t.sockets.set(socket.id, { playerId, pos: idx.pos });
        socket.join(tableId);
        socket.emit('joined', { tableId, playerId, pos: idx.pos, isHost: t.hostPlayerId === playerId });
        touch(t);
        broadcastTable(t);
        scheduleNoHumanShutdown(t, tableId);
        console.log(`[table ${tableId}] ${name} reconnected to seat ${idx.pos}`);
        return;
      }
      // Token pointed at a table/seat that's gone — fall through and
      // treat this as a brand new join, exactly as requested.
    }

    // Past this point it's a genuinely new join (never a reconnect), so
    // the entry lock applies — a locked server still lets anyone already
    // seated keep playing and reconnecting freely, this only stops brand
    // new people from getting in without the code.
    if (serverLockCode && code !== serverLockCode) {
      socket.emit('lockRequired', { action: 'join' });
      return;
    }

    const t = tables[reqTableId];
    if (!t) { socket.emit('joinError', { reason: 'table_not_found' }); return; }
    const openSeats = t.engine.emptySeats();
    const { botSeats, disconnectedSeats } = joinableSeats(t);
    const isPlaying = t.engine.phase !== 'lobby';
    const canWatch = true; // watching is always offered as a fallback, but still needs the same approval gate as everything else once a game is running

    if (!isPlaying) {
      // Table hasn't started — no approval needed, straight to picking a seat.
      pendingSeatChoice[socket.id] = { tableId: reqTableId, name: name || 'Player' };
      socket.emit('chooseSeat', { tableId: reqTableId, openSeats, botSeats, disconnectedSeats, seats: seatSnapshot(t), canWatch: false, needsApproval: false });
      return;
    }

    // Table is already playing — the host must approve this join before
    // any seat/watch choice is even offered.
    if (openSeats.length === 0 && botSeats.length === 0 && disconnectedSeats.length === 0 && !canWatch) {
      socket.emit('joinError', { reason: 'table_full' });
      return;
    }
    const reqId = newId();
    t.pendingJoinRequests = t.pendingJoinRequests || new Map();
    t.pendingJoinRequests.set(reqId, { socketId: socket.id, name: name || 'Player' });
    socket.emit('joinPending', { tableId: reqTableId, message: 'Waiting for the host to let you in...' });
    for (const [hostSockId, info] of t.sockets) {
      if (info.playerId !== t.hostPlayerId) continue;
      const hostSocket = io.sockets.sockets.get(hostSockId);
      if (hostSocket) {
        hostSocket.emit('joinRequest', {
          reqId, name: name || 'Player', openSeats, botSeats, disconnectedSeats,
          tableFull: openSeats.length === 0 && botSeats.length === 0 && disconnectedSeats.length === 0
        });
      }
    }
    console.log(`[table ${reqTableId}] ${name} requested to join a table already in progress — awaiting host approval`);
  });

  // An existing spectator asking to convert to a player — reuses the same
  // approval pipeline as a fresh joiner arriving at a live table, just
  // entered from "already watching" instead of "just connected".
  socket.on('requestSeat', () => {
    const t = tables[tableId];
    if (!t || !t.spectators || !t.spectators.has(socket.id)) return;
    const spec = t.spectators.get(socket.id);
    const openSeats = t.engine.emptySeats();
    const { botSeats, disconnectedSeats } = joinableSeats(t);
    if (openSeats.length === 0 && botSeats.length === 0 && disconnectedSeats.length === 0) {
      socket.emit('joinError', { reason: 'table_full' });
      return;
    }
    const reqId = newId();
    t.pendingJoinRequests = t.pendingJoinRequests || new Map();
    t.pendingJoinRequests.set(reqId, { socketId: socket.id, name: spec.name, fromSpectator: true });
    socket.emit('seatRequestSent', { message: 'Seat request sent — waiting for the host...' });
    for (const [hostSockId, info] of t.sockets) {
      if (info.playerId !== t.hostPlayerId) continue;
      const hostSocket = io.sockets.sockets.get(hostSockId);
      if (hostSocket) {
        hostSocket.emit('joinRequest', {
          reqId, name: spec.name, openSeats, botSeats, disconnectedSeats,
          fromSpectator: true, tableFull: false
        });
      }
    }
    console.log(`[table ${tableId}] spectator ${spec.name} asked the host for a seat`);
  });

  socket.on('respondJoinRequest', ({ reqId, approved }) => {
    const t = tables[tableId];
    if (!t || t.hostPlayerId !== playerId || !t.pendingJoinRequests) return;
    const reqInfo = t.pendingJoinRequests.get(reqId);
    if (!reqInfo) return;
    t.pendingJoinRequests.delete(reqId);
    const reqSocket = io.sockets.sockets.get(reqInfo.socketId);
    if (!reqSocket) return;
    if (!approved) {
      reqSocket.emit('joinDenied');
      console.log(`[table ${tableId}] host denied ${reqInfo.name}'s join request`);
      return;
    }
    // If this request came from an existing spectator, they're about to
    // become a seat-picker candidate instead — drop the spectator entry so
    // they don't briefly show up as both.
    if (reqInfo.fromSpectator && t.spectators) t.spectators.delete(reqInfo.socketId);
    const openSeats = t.engine.emptySeats();
    const { botSeats, disconnectedSeats } = joinableSeats(t);
    pendingSeatChoice[reqInfo.socketId] = { tableId, name: reqInfo.name };
    reqSocket.emit('chooseSeat', { tableId, openSeats, botSeats, disconnectedSeats, seats: seatSnapshot(t), canWatch: true, needsApproval: false });
    console.log(`[table ${tableId}] host approved ${reqInfo.name}'s join request`);
  });

  // A seat claim can lose a race — most commonly the host clicking "Start
  // Game" (which auto-fills every still-empty seat with bots) in the same
  // moment a guest is submitting their seat choice. Previously this just
  // sent a 'joinError' toast while the client had *already* closed its
  // seat-picker optimistically on click, so the guest was left stranded
  // with no seat and no way to retry — the game would run on with a bot
  // sitting in what should've been their spot. Re-sending a fresh
  // 'chooseSeat' with current availability lets the client's existing
  // chooseSeat handler just reopen the picker with up-to-date options.
  function rejectClaim(t, pending, reason) {
    socket.emit('joinError', { reason });
    const openSeats = t.engine.emptySeats();
    const { botSeats, disconnectedSeats } = joinableSeats(t);
    if (openSeats.length > 0 || botSeats.length > 0 || disconnectedSeats.length > 0) {
      socket.emit('chooseSeat', { tableId: pending.tableId, openSeats, botSeats, disconnectedSeats, seats: seatSnapshot(t), canWatch: true, needsApproval: false });
    }
  }

  socket.on('claimSeat', ({ choice }) => {
    const pending = pendingSeatChoice[socket.id];
    if (!pending) return;
    const t = tables[pending.tableId];
    if (!t) return;

    if (choice.type === 'watch') {
      playerId = newId();
      tableId = pending.tableId;
      t.spectators = t.spectators || new Map();
      t.spectators.set(socket.id, { playerId, name: pending.name });
      socket.join(tableId);
      socket.emit('joinedAsSpectator', { tableId, playerId });
      broadcastTable(t);
      delete pendingSeatChoice[socket.id];
      console.log(`[table ${tableId}] ${pending.name} joined as a spectator`);
      return;
    }

    let pos = choice.pos;
    if (choice.type === 'openSeat') {
      if (!t.engine.emptySeats().includes(pos)) { rejectClaim(t, pending, 'seat_taken'); return; }
      playerId = newId();
      t.engine.seatHuman(pos, pending.name, playerId);
    } else if (choice.type === 'replaceBot') {
      if (!t.engine.seats[pos] || !t.engine.seats[pos].isBot) { rejectClaim(t, pending, 'not_a_bot_seat'); return; }
      playerId = newId();
      if (!t.engine.replaceBot(pos, playerId, pending.name)) { rejectClaim(t, pending, 'replace_failed'); return; }
    } else if (choice.type === 'takeOverSeat') {
      // Reclaiming a seat left behind by a disconnected human (or a bot —
      // this covers both, same as replaceBot but also for the orphaned-
      // human case). The old occupant's reconnect token, if they ever
      // come back, will simply no longer match this seat and they'll be
      // routed through a brand new join instead — handled already.
      const seat = t.engine.seats[pos];
      const oldPlayerId = seat ? seat.playerId : null;
      playerId = newId();
      if (!t.engine.takeOverSeat(pos, playerId, pending.name)) { rejectClaim(t, pending, 'replace_failed'); return; }
      if (oldPlayerId) delete playerIndex[oldPlayerId];
    } else {
      return;
    }
    tableId = pending.tableId;
    playerIndex[playerId] = { tableId, pos };
    t.sockets.set(socket.id, { playerId, pos });
    socket.join(tableId);
    socket.emit('joined', { tableId, playerId, pos, isHost: t.hostPlayerId === playerId });
    touch(t);
    broadcastTable(t);
    scheduleNoHumanShutdown(t, tableId);
    delete pendingSeatChoice[socket.id];
    console.log(`[table ${tableId}] ${pending.name} took seat ${pos}${choice.type === 'replaceBot' ? ' (replacing a bot)' : ''}`);

    // Let the host know a new person just joined — this is a brand new
    // seat claim (never a reconnect, which goes through a different path
    // entirely), so this always represents someone genuinely new arriving.
    for (const [hostSockId, info] of t.sockets) {
      if (info.playerId !== t.hostPlayerId || info.playerId === playerId) continue;
      const hostSocket = io.sockets.sockets.get(hostSockId);
      if (hostSocket) hostSocket.emit('playerJoinedNotice', { name: pending.name });
    }
  });

  function withTable(fn) {
    const t = tables[tableId];
    const info = t && t.sockets.get(socket.id);
    if (!t || !info || info.pos < 0) return;
    fn(t, info.pos);
  }

  socket.on('fillBots', ({ count }) => {
    withTable((t, pos) => {
      if (t.hostPlayerId !== playerId) return; // lobby-only permission
      t.botFill = Math.max(0, Math.min(3, count | 0));
    });
  });

  socket.on('startGame', () => {
    withTable((t, pos) => {
      if (t.hostPlayerId !== playerId) return;
      if (t.engine.phase !== 'lobby') return;
      const open = t.engine.emptySeats();
      const botNamePool = ['Charlie', 'Koshy', 'Johny', 'Neha', 'Benson', 'Nate', 'Priya', 'Rahul', 'Anjali', 'Vinod', 'Meera', 'Sanjay'];
      // Shuffle so repeated games don't always show the same first few
      // names in the list — previously toFill was always 3, so seats
      // always got names[0], names[1], names[2] and nothing past that.
      const shuffled = [...botNamePool].sort(() => Math.random() - 0.5);
      let toFill = Math.min(t.botFill, open.length);
      for (let i = 0; i < toFill; i++) {
        t.engine.seatBot(open[i], shuffled[i % shuffled.length]);
      }
      if (!t.engine.canStart()) return;
      t.engine.startRound(); // fires onChange itself once dealing is done
      console.log(`[table ${tableId}] game started`);
    });
  });

  socket.on('placeBid', ({ bid }) => {
    withTable((t, pos) => {
      const r = t.engine.placeBid(pos, bid);
      if (!r.ok) socket.emit('actionError', r);
    });
  });

  socket.on('chooseTrump', ({ suit, hiddenCard }) => {
    withTable((t, pos) => {
      const r = t.engine.chooseTrump(pos, suit, hiddenCard);
      if (!r.ok) socket.emit('actionError', r);
    });
  });

  socket.on('raiseBid', ({ bid }) => {
    withTable((t, pos) => {
      const r = t.engine.raiseBid(pos, bid);
      if (!r.ok) socket.emit('actionError', r);
    });
  });

  socket.on('passPhase2', () => {
    withTable((t, pos) => {
      const r = t.engine.passPhase2(pos);
      if (!r.ok) socket.emit('actionError', r);
    });
  });

  socket.on('playCard', ({ card }) => {
    withTable((t, pos) => {
      const r = t.engine.playCard(pos, card);
      if (!r.ok) socket.emit('actionError', r);
    });
  });

  // "Open the trick": a player who can't follow suit formally asks for the
  // trump to be revealed, without having to commit a card in the same
  // motion. The engine validates the right and binds them to play trump
  // this trick if they hold one.
  socket.on('callTrump', () => {
    withTable((t, pos) => {
      const r = t.engine.callTrump(pos);
      if (!r.ok) socket.emit('actionError', r);
    });
  });

  socket.on('playHiddenTrump', () => {
    withTable((t, pos) => {
      const r = t.engine.playHiddenTrump(pos);
      if (!r.ok) socket.emit('actionError', r);
    });
  });

  socket.on('continueRound', () => {
    withTable((t, pos) => {
      if (t.hostPlayerId !== playerId) return;
      if (t.engine.phase !== 'roundEnd') return;
      t.engine.startRound();
    });
  });

  // Host controls, available at any point in the game (not just at round
  // end) — restarting reshuffles and redeals regardless of what phase the
  // table is currently in.
  socket.on('restartGame', () => {
    withTable((t, pos) => {
      if (t.hostPlayerId !== playerId) return;
      if (t.engine.phase === 'lobby') return; // nothing to restart yet
      t.engine.restartGame();
      console.log(`[table ${tableId}] host restarted the game`);
    });
  });

  socket.on('restartRound', () => {
    withTable((t, pos) => {
      if (t.hostPlayerId !== playerId) return;
      if (t.engine.phase === 'lobby') return;
      t.engine.restartRound();
      console.log(`[table ${tableId}] host restarted round ${t.engine.round}`);
    });
  });

  socket.on('kickPlayer', ({ pos }) => {
    withTable((t, myPos) => {
      if (t.hostPlayerId !== playerId) return;
      const target = t.engine.seats[pos];
      if (!target || target.isBot) return;
      if (target.playerId === t.hostPlayerId) return; // can't kick yourself
      // If they're currently connected, tell their client directly and
      // disconnect their seat mapping before touching the engine, so a
      // stray action from them can't land mid-kick.
      for (const [sockId, info] of t.sockets) {
        if (info.pos === pos) {
          const kickedSock = io.sockets.sockets.get(sockId);
          if (kickedSock) kickedSock.emit('kicked');
          t.sockets.delete(sockId);
          if (target.playerId) delete playerIndex[target.playerId];
        }
      }
      t.engine.kickPlayer(pos);
      console.log(`[table ${tableId}] host kicked seat ${pos}`);
    });
  });

  // Chat is available to everyone at the table, seated players and
  // spectators alike — both join the same Socket.IO room, so a single
  // room-wide emit reaches both. The sender's display name is looked up
  // server-side (from their actual seat or spectator entry) rather than
  // trusted from the client, so nobody can spoof being someone else.
  socket.on('chat', ({ msg }) => {
    const t = tables[tableId];
    if (!t) return;
    const trimmed = String(msg || '').slice(0, 300).trim();
    if (!trimmed) return;
    let from = null;
    const seatInfo = t.sockets.get(socket.id);
    if (seatInfo && t.engine.seats[seatInfo.pos]) {
      from = t.engine.seats[seatInfo.pos].name;
    } else if (t.spectators && t.spectators.has(socket.id)) {
      from = t.spectators.get(socket.id).name + ' (watching)';
    }
    if (!from) return;
    io.to(tableId).emit('chat', { from, msg: trimmed, senderId: socket.id });
    touch(t);
  });

  socket.on('leaveTable', () => {
    handleDisconnectOrLeave(true);
  });

  socket.on('disconnect', () => {
    handleDisconnectOrLeave(false);
  });

  function handleDisconnectOrLeave(explicitLeave) {
    const t = tables[tableId];
    delete pendingSeatChoice[socket.id];
    if (!t) return;
    if (t.spectators && t.spectators.has(socket.id)) {
      t.spectators.delete(socket.id);
      broadcastTable(t);
      return;
    }
    const info = t.sockets.get(socket.id);
    t.sockets.delete(socket.id);
    if (!info) return;
    if (info.pos >= 0 && t.engine.seats[info.pos]) {
      if (explicitLeave) {
        // Deliberate leave: free the seat immediately rather than holding
        // it for a reconnect that was never going to come.
        t.engine.removeSeat(info.pos);
        delete playerIndex[info.playerId];
      } else {
        // Silent drop (crash, lost signal, closed tab): keep the seat and
        // hand exactly as they were. The whole point of this rewrite —
        // they can come back (same browser/token) and pick up exactly
        // where they left off, and everyone else at the table keeps
        // playing in the meantime instead of the game freezing.
        //
        // BUT — a brief network flap can mean the client's new socket
        // already reconnected and re-marked this seat connected BEFORE
        // this old socket's disconnect event finished processing (event
        // ordering isn't guaranteed). If that's already happened, some
        // other socket is now registered for this exact seat — leaving
        // it stuck marked disconnected here would make the server treat
        // an actively-connected player as abandoned and auto-play their
        // seat forever, even though they're right there. Only mark
        // disconnected if nothing newer has already taken this seat over.
        const alreadyReclaimed = [...t.sockets.values()].some(v => v.pos === info.pos);
        if (!alreadyReclaimed) {
          t.engine.markConnected(info.pos, false);
        }
      }
      // Host migration: whoever was hosting just left/dropped, so every
      // host-only control (start, kick, restart, approve joins) would
      // otherwise be permanently stuck waiting on someone who's gone.
      // Hand it to another currently-connected human, by seat order — a
      // one-way transfer, not a temporary delegation, so it doesn't flip
      // back and forth if the original host's connection is just flaky.
      if (t.hostPlayerId === info.playerId) {
        const newHostSeat = t.engine.seats.find(s => s && !s.isBot && s.connected && s.playerId !== info.playerId);
        if (newHostSeat) {
          t.hostPlayerId = newHostSeat.playerId;
          t.engine.addLog(`${newHostSeat.name} is now the host.`);
          console.log(`[table ${tableId}] host left — ${newHostSeat.name} is now host`);
        }
      }
      touch(t);
      broadcastTable(t);
    }
    if (!t.engine.seats.some(Boolean)) {
      // Nobody left at all (everyone explicitly left) — no reason to keep
      // an empty table around waiting for the 5-minute idle sweep.
      delete tables[tableId];
    } else {
      scheduleNoHumanShutdown(t, tableId);
    }
    io.emit('roomList', publicTableList());
  }
});

server.listen(PORT, () => {
  console.log(`28 Kerala Gulan authoritative server running on port ${PORT}`);
});
