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

function newId() { return crypto.randomBytes(8).toString('hex'); }
function newTableId() { return crypto.randomBytes(4).toString('hex').toUpperCase(); }

function publicTableList() {
  return Object.values(tables)
    .filter(t => t.engine.seats.some(Boolean))
    .map(t => ({
      tableId: t.engine.tableId,
      name: t.name,
      players: t.engine.seats.filter(Boolean).length,
      isPlaying: t.engine.phase !== 'lobby'
    }));
}

function broadcastTable(t) {
  for (const [socketId, info] of t.sockets) {
    const sock = io.sockets.sockets.get(socketId);
    if (!sock) continue;
    sock.emit('state', t.engine.stateFor(info.pos));
  }
  io.emit('roomList', publicTableList()); // cheap enough at this scale; trims a room's "Playing" badge live
}

function touch(t) { t.lastActivityAt = Date.now(); }

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

  socket.on('listRooms', () => {
    socket.emit('roomList', publicTableList());
  });

  socket.on('createTable', ({ name }) => {
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
    io.emit('roomList', publicTableList());
    console.log(`[table ${id}] created by ${name}`);
  });

  socket.on('joinTable', ({ tableId: reqTableId, name, playerId: existingPlayerId }) => {
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
        console.log(`[table ${tableId}] ${name} reconnected to seat ${idx.pos}`);
        return;
      }
      // Token pointed at a table/seat that's gone — fall through and
      // treat this as a brand new join, exactly as requested.
    }

    const t = tables[reqTableId];
    if (!t) { socket.emit('joinError', { reason: 'table_not_found' }); return; }
    const open = t.engine.emptySeats();
    if (open.length === 0) {
      socket.emit('joinError', { reason: 'table_full' });
      return;
    }
    playerId = newId();
    const pos = open[0];
    t.engine.seatHuman(pos, name || 'Player', playerId);
    tableId = reqTableId;
    playerIndex[playerId] = { tableId, pos };
    t.sockets.set(socket.id, { playerId, pos });
    socket.join(tableId);
    socket.emit('joined', { tableId, playerId, pos, isHost: t.hostPlayerId === playerId });
    touch(t);
    broadcastTable(t);
    console.log(`[table ${tableId}] ${name} joined fresh at seat ${pos}`);
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
      const botNames = ['Charlie', 'Koshy', 'Johny', 'Neha', 'Benson', 'Nate'];
      let toFill = Math.min(t.botFill, open.length);
      for (let i = 0; i < toFill; i++) {
        t.engine.seatBot(open[i], botNames[i % botNames.length]);
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

  socket.on('playCard', ({ card }) => {
    withTable((t, pos) => {
      const r = t.engine.playCard(pos, card);
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

  socket.on('leaveTable', () => {
    handleDisconnectOrLeave(true);
  });

  socket.on('disconnect', () => {
    handleDisconnectOrLeave(false);
  });

  function handleDisconnectOrLeave(explicitLeave) {
    const t = tables[tableId];
    if (!t) return;
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
        t.engine.markConnected(info.pos, false);
      }
      touch(t);
      broadcastTable(t);
    }
    if (!t.engine.seats.some(Boolean)) {
      // Nobody left at all (everyone explicitly left) — no reason to keep
      // an empty table around waiting for the 5-minute idle sweep.
      delete tables[tableId];
    }
    io.emit('roomList', publicTableList());
  }
});

server.listen(PORT, () => {
  console.log(`28 Kerala Gulan authoritative server running on port ${PORT}`);
});
