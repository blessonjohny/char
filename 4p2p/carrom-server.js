// ============================================================
// CARROM SERVER — completely standalone. Runs as its own process, on
// its own port, with its own Socket.IO server. Deliberately isolated
// from the card-game server (server.js) after a bug in this game's own
// code (a too-frequent GitHub sync timer) ended up disrupting that
// server too, since they used to share one process — anything that
// destabilizes one game destabilizes every game sharing its process.
// This file now owns its own process entirely: nothing in here can
// ever again touch the card games, no matter what bugs turn up here in
// the future.
// ============================================================

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const PORT = process.env.CARROM_PORT || process.env.PORT || 9001;

const SERVER_START_TIME = Date.now();

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '32kb' }));

// CORS: this server is deployed separately from the card-game server,
// so the carrom.html page (served by the OTHER server, or by this one
// directly) needs to be able to reach this one cross-origin. Wide open
// by design -- this endpoint only ever handles casual-game table data,
// nothing sensitive, matching the trust model already used everywhere
// else in this project.
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.get('/status', (req, res) => {
  res.json({
    ok: true,
    message: 'Carrom Server running',
    activeTables: Object.keys(carromTables).length,
    serverStartTime: SERVER_START_TIME,
    buildTag: 'carrom-standalone · 2026-07-23'
  });
});

const io = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 25000,
  pingTimeout: 60000
});

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO = process.env.GITHUB_REPO || '';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const GITHUB_ENABLED = !!(GITHUB_TOKEN && GITHUB_REPO);

// ============================================================
// CARROM — 2-seat (1v1) or 4-seat (2v2 teams) online table. The actual
// physics simulation stays entirely client-side, exactly as the
// original single-player build works — this table only tracks WHO is
// in which seat, and relays each completed shot's resulting state
// (coin positions, score, whose turn) from whoever just took the shot
// to everyone else at the table. Nobody re-simulates anyone else's
// shot; they just render the result they're sent.
const carromTables = {};
const carromPlayerIndex = {}; // playerId -> { tableId, pos }

// ---------------- Carrom table persistence ----------------
// Every reconnect-logic fix so far, however solid, is powerless against
// the actual root cause behind tables vanishing on their own: they only
// ever existed in this process's memory, with zero backup. A server
// restart -- a crash, a redeploy, routine host maintenance, anything --
// wipes every table instantly, completely bypassing every disconnect/
// reconnect code path, since a process restart doesn't run through any
// application-level cleanup logic at all. This mirrors the same GitHub-
// backed persistence already proven for the visitor log and comments,
// so a restart no longer means every in-progress game is gone.
// Only the `sockets` Map is deliberately excluded from what's saved --
// live socket connections are never valid after any restart regardless
// of persistence, so there's nothing worth saving there; reconnecting
// clients repopulate it themselves through the normal join flow.
// carromPlayerIndex isn't saved separately either, since it's fully
// derivable from the restored seats and gets rebuilt from them on load.
const CARROM_TABLES_FILE = path.join(__dirname, 'carrom-tables-data.json');
const GITHUB_CARROM_TABLES_PATH = '4p2p/data/carrom-tables.json';
let carromTablesFileSha = null;
let carromTablesDirty = false;

let carromPushDebounceTimer = null;
let carromPushMaxWaitTimer = null;
function carromMarkDirty() {
  carromTablesDirty = true;
  if (!GITHUB_ENABLED) return;
  if (carromPushDebounceTimer) clearTimeout(carromPushDebounceTimer);
  carromPushDebounceTimer = setTimeout(runScheduledCarromPush, 20000);
  if (!carromPushMaxWaitTimer) {
    carromPushMaxWaitTimer = setTimeout(runScheduledCarromPush, 60000);
  }
}
function runScheduledCarromPush() {
  if (carromPushDebounceTimer) { clearTimeout(carromPushDebounceTimer); carromPushDebounceTimer = null; }
  if (carromPushMaxWaitTimer) { clearTimeout(carromPushMaxWaitTimer); carromPushMaxWaitTimer = null; }
  githubPushCarromTables().catch(e => console.error('[carrom] Scheduled GitHub push failed:', e.message));
}

function githubCarromTablesUrl() {
  return `https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_CARROM_TABLES_PATH}`;
}
async function githubFetchCarromTables() {
  if (!GITHUB_ENABLED) return null;
  try {
    const res = await fetch(`${githubCarromTablesUrl()}?ref=${GITHUB_BRANCH}`, {
      headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' }
    });
    if (res.status === 404) { console.log('[carrom] No existing carrom-tables.json in the repo yet — starting fresh.'); return {}; }
    if (!res.ok) { console.error('[carrom] GitHub fetch failed:', res.status, await res.text()); return null; }
    const json = await res.json();
    carromTablesFileSha = json.sha;
    const decoded = Buffer.from(json.content, 'base64').toString('utf8');
    return JSON.parse(decoded);
  } catch (e) {
    console.error('[carrom] GitHub fetch error:', e.message);
    return null;
  }
}
async function githubPushCarromTables() {
  if (!GITHUB_ENABLED) return;
  try {
    const serializable = {};
    for (const [id, t] of Object.entries(carromTables)) {
      const { sockets, ...rest } = t;
      serializable[id] = rest;
    }
    const body = {
      message: `Update carrom tables (${Object.keys(serializable).length} active)`,
      content: Buffer.from(JSON.stringify(serializable)).toString('base64'),
      branch: GITHUB_BRANCH
    };
    if (carromTablesFileSha) body.sha = carromTablesFileSha;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    let res;
    try {
      res = await fetch(githubCarromTablesUrl(), {
        method: 'PUT',
        headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeoutId);
    }
    if (!res.ok) { console.error('[carrom] GitHub push failed:', res.status, await res.text()); return; }
    const json = await res.json();
    carromTablesFileSha = json.content.sha;
    console.log(`[carrom] Synced ${Object.keys(serializable).length} table(s) to GitHub.`);
  } catch (e) {
    console.error('[carrom] GitHub push error:', e.message);
  }
}
function saveCarromTablesLocal() {
  if (!carromTablesDirty) return;
  try {
    const serializable = {};
    for (const [id, t] of Object.entries(carromTables)) {
      const { sockets, ...rest } = t;
      serializable[id] = rest;
    }
    fs.writeFileSync(CARROM_TABLES_FILE, JSON.stringify(serializable));
    carromTablesDirty = false;
  } catch (e) {
    console.error('[carrom] Failed to save local carrom tables:', e.message);
  }
}
function carromRestoreFromData(data) {
  for (const [id, t] of Object.entries(data)) {
    t.sockets = new Map(); // no live connections survive a restart regardless; reconnecting clients repopulate this themselves
    carromTables[id] = t;
    (t.seats || []).forEach((seat, pos) => {
      if (seat && seat.playerId) carromPlayerIndex[seat.playerId] = { tableId: id, pos };
    });
  }
}
async function loadCarromTables() {
  if (GITHUB_ENABLED) {
    const fromGithub = await githubFetchCarromTables();
    if (fromGithub) {
      carromRestoreFromData(fromGithub);
      console.log(`[carrom] Restored ${Object.keys(fromGithub).length} table(s) from GitHub.`);
      return;
    }
    console.log('[carrom] Falling back to local file for this boot (GitHub fetch failed).');
  } else {
    console.log('[carrom] GITHUB_TOKEN/GITHUB_REPO not set — carrom tables will only persist locally, which Render\'s free tier does not keep across a spin-down.');
  }
  try {
    if (fs.existsSync(CARROM_TABLES_FILE)) {
      const data = JSON.parse(fs.readFileSync(CARROM_TABLES_FILE, 'utf8'));
      carromRestoreFromData(data);
      console.log(`[carrom] Restored ${Object.keys(data).length} table(s) from local disk.`);
    }
  } catch (e) {
    console.error('[carrom] Failed to load local carrom tables, starting fresh:', e.message);
  }
}
// Local save every 10s if dirty (cheap, matches the visitor-log
// Local save every 10s if dirty (cheap, matches the visitor-log
// pattern, no network call). GitHub push is debounced off actual table
// activity via carromMarkDirty -> scheduleCarromPush, NOT a fixed
// interval -- the exact fixed-interval GitHub-sync pattern this project
// already learned, the hard way, causes real disconnects: see the
// comment above finalVisitorLogFlush describing two independent
// disconnect reports traced to a periodic GitHub sync running on a
// fixed clock, since removed for the visitor log. Reusing that same
// pattern here, at a much more frequent 20s instead of 11 minutes,
// most likely reintroduced that exact class of bug -- for every game
// sharing this process, not just Carrom.
setInterval(saveCarromTablesLocal, 10000);
loadCarromTables();

function carromSeatOrder(playerCount) {
  return playerCount === 4 ? ['bottom', 'right', 'top', 'left'] : ['bottom', 'top'];
}

function carromSeatSnapshot(t) {
  return t.seats.map(s => s ? { name: s.name, isBot: !!s.isBot, connected: !!s.connected, side: s.side } : null);
}

function carromIsEffectiveHost(t, playerId) {
  if (t.hostPlayerId === playerId) return true;
  const seat = t.seats.find(s => s && s.playerId === playerId);
  return !!(seat && !seat.isBot && seat.connected);
}

function carromEnsureHumanHost(t, preferPlayerId) {
  const hostSeat = t.seats.find(s => s && s.playerId === t.hostPlayerId);
  if (hostSeat && !hostSeat.isBot && hostSeat.connected) return;
  const preferred = t.seats.find(s => s && s.playerId === preferPlayerId && !s.isBot);
  const fallback = t.seats.find(s => s && !s.isBot && s.connected);
  const newHost = preferred || fallback;
  t.hostPlayerId = newHost ? newHost.playerId : null;
}

function carromPublicList() {
  return Object.values(carromTables)
    .filter(t => t.seats.some(Boolean))
    .map(t => {
      const botSeatIndices = t.seats.map((s,i) => (s && s.isBot) ? i : null).filter(i => i !== null);
      return {
        id: t.id,
        playerCount: t.playerCount,
        openSeats: t.seats.filter(s => !s).length,
        botSeats: botSeatIndices.length,
        botSeatIndices,
        phase: t.phase,
        hostName: (t.seats.find(s => s && s.playerId === t.hostPlayerId) || {}).name || '?'
      };
    });
}

function carromBroadcast(t) {
  carromMarkDirty();
  const payload = {
    tableId: t.id,
    playerCount: t.playerCount,
    seats: carromSeatSnapshot(t),
    phase: t.phase,
    hostPlayerId: t.hostPlayerId,
    boardState: t.boardState || null
  };
  for (const [socketId, info] of t.sockets) {
    const sock = io.sockets.sockets.get(socketId);
    if (!sock) continue;
    sock.emit('carrom_state', { ...payload, myPos: info.pos, isHost: carromIsEffectiveHost(t, info.playerId) });
  }
  io.emit('carrom_roomList', carromPublicList());
}

io.on('connection', (socket) => {
  let carromTableId = null;

  // A client that just connected (selected "Play Online" but hasn't
  // created or joined anything yet) needs the CURRENT list immediately
  // -- the broadcast-on-change model alone means they'd only see
  // updates from things that happen AFTER they connect, missing any
  // table that already existed.
  socket.on('carrom_listRooms', () => {
    socket.emit('carrom_roomList', carromPublicList());
  });

  // Cleanly removes this socket from whatever table it's currently
  // registered at, if any -- shared by the explicit "leave table"
  // handler below AND by create/join, which must call this first.
  // Without this, a socket that ends up registered at table A (say,
  // from a stale auto-rejoin on connect) and then creates or joins a
  // different table B would leave a ghost registration behind in A:
  // still counted as a connected human there, so A never properly
  // closes even though nobody is actually using it anymore.
  function carromLeaveCurrentTableIfAny() {
    const t = carromTables[carromTableId];
    if (t) {
      const info = t.sockets.get(socket.id);
      t.sockets.delete(socket.id);
      if (info && t.seats[info.pos] && t.seats[info.pos].playerId === info.playerId) {
        if (t.phase === 'lobby') {
          t.seats[info.pos] = null;
        } else {
          t.seats[info.pos].isBot = true;
          t.seats[info.pos].connected = true;
          t.seats[info.pos].playerId = null;
        }
        if (info.playerId) delete carromPlayerIndex[info.playerId];
      }
      carromEnsureHumanHost(t);
      carromBroadcast(t);
    }
    carromTableId = null;
  }

  socket.on('carrom_createTable', ({ name, playerCount }) => {
    carromLeaveCurrentTableIfAny();
    const pc = playerCount === 4 ? 4 : 2;
    const id = 'C' + crypto.randomBytes(4).toString('hex').toUpperCase();
    const playerId = crypto.randomBytes(8).toString('hex');
    const seats = new Array(pc).fill(null);
    const sides = carromSeatOrder(pc);
    seats[0] = { side: sides[0], playerId, name: name || 'Player', isBot: false, connected: true };
    const t = { id, playerCount: pc, seats, hostPlayerId: playerId, phase: 'lobby', boardState: null, sockets: new Map(), lastActivityAt: Date.now() };
    carromTables[id] = t;
    carromPlayerIndex[playerId] = { tableId: id, pos: 0 };
    t.sockets.set(socket.id, { playerId, pos: 0 });
    socket.join('carrom_' + id);
    carromTableId = id;
    socket.emit('carrom_joined', { tableId: id, playerId, pos: 0, isHost: true });
    carromBroadcast(t);
    console.log(`[carrom] table ${id} created by ${name} (${pc}-seat)`);
  });

  socket.on('carrom_joinTable', ({ tableId, name, playerId: existingPlayerId }) => {
    // If this exact socket is already registered with this exact
    // playerId, it's re-announcing itself (e.g. a lightweight
    // re-confirm after the tab was briefly hidden), not actually
    // switching tables. Calling carromLeaveCurrentTableIfAny() here
    // would destructively bot-convert this socket's own seat before
    // the reconnect-via-token check below ever runs, since that check
    // depends on carromPlayerIndex, which the leave step deletes as
    // part of its own cleanup -- kicking a still-connected player out
    // of their own seat via what was meant to be a harmless re-confirm.
    const currentTable = carromTables[carromTableId];
    if (!(currentTable && currentTable.sockets.get(socket.id)?.playerId === existingPlayerId)) {
      carromLeaveCurrentTableIfAny();
    }
    // Reconnect via saved token first.
    if (existingPlayerId && carromPlayerIndex[existingPlayerId]) {
      const idx = carromPlayerIndex[existingPlayerId];
      const t = carromTables[idx.tableId];
      if (t && t.seats[idx.pos] && t.seats[idx.pos].playerId === existingPlayerId) {
        t.seats[idx.pos].connected = true;
        if (name) t.seats[idx.pos].name = name;
        t.sockets.set(socket.id, { playerId: existingPlayerId, pos: idx.pos });
        socket.join('carrom_' + idx.tableId);
        carromTableId = idx.tableId;
        carromEnsureHumanHost(t, existingPlayerId);
        socket.emit('carrom_joined', { tableId: idx.tableId, playerId: existingPlayerId, pos: idx.pos, isHost: carromIsEffectiveHost(t, existingPlayerId) });
        t.lastActivityAt = Date.now();
        carromBroadcast(t);
        return;
      }
    }
    // Fresh join: take the first open seat.
    const t = carromTables[tableId];
    if (!t) { socket.emit('carrom_joinError', { reason: 'table_not_found' }); return; }
    const pos = t.seats.findIndex(s => !s || (s.isBot));
    if (pos === -1) { socket.emit('carrom_joinError', { reason: 'table_full' }); return; }
    const playerId = crypto.randomBytes(8).toString('hex');
    const side = t.seats[pos] ? t.seats[pos].side : carromSeatOrder(t.playerCount)[pos];
    t.seats[pos] = { side, playerId, name: name || 'Player', isBot: false, connected: true };
    carromPlayerIndex[playerId] = { tableId, pos };
    t.sockets.set(socket.id, { playerId, pos });
    socket.join('carrom_' + tableId);
    carromTableId = tableId;
    carromEnsureHumanHost(t, playerId);
    socket.emit('carrom_joined', { tableId, playerId, pos, isHost: carromIsEffectiveHost(t, playerId) });
    t.lastActivityAt = Date.now();
    carromBroadcast(t);
    console.log(`[carrom] ${name} joined table ${tableId} at seat ${pos}`);
  });

  socket.on('carrom_fillBots', () => {
    const t = carromTables[carromTableId];
    if (!t) return;
    const info = t.sockets.get(socket.id);
    if (!info || !carromIsEffectiveHost(t, info.playerId)) return;
    const sides = carromSeatOrder(t.playerCount);
    const botNames = ['Bot A', 'Bot B', 'Bot C'];
    let n = 0;
    for (let i = 0; i < t.playerCount; i++) {
      if (!t.seats[i]) {
        t.seats[i] = { side: sides[i], playerId: null, name: botNames[n++] || `Bot ${i}`, isBot: true, connected: true };
      }
    }
    t.lastActivityAt = Date.now();
    carromBroadcast(t);
  });

  socket.on('carrom_startGame', () => {
    const t = carromTables[carromTableId];
    if (!t) return;
    const info = t.sockets.get(socket.id);
    if (!info || !carromIsEffectiveHost(t, info.playerId)) return;
    if (t.seats.some(s => !s)) return; // every seat must be filled (human or bot) before starting
    t.phase = 'playing';
    t.lastActivityAt = Date.now();
    carromBroadcast(t);
    console.log(`[carrom] table ${t.id} started`);
  });

  // Restart used to only reset whoever clicked it locally -- everyone
  // else at the table stayed on the old board, then immediately went
  // out of sync the moment a new shot's result got broadcast against a
  // board state they never actually had. This makes restart a real
  // sync point: only the effective host can trigger it, and every
  // player's client resets together, at the same signal, at once.
  socket.on('carrom_restartMatch', () => {
    const t = carromTables[carromTableId];
    if (!t) return;
    const info = t.sockets.get(socket.id);
    if (!info || !carromIsEffectiveHost(t, info.playerId)) return;
    t.boardState = null; // the old board is no longer valid for anyone
    t.lastActivityAt = Date.now();
    for (const [socketId] of t.sockets) {
      const sock = io.sockets.sockets.get(socketId);
      if (sock) sock.emit('carrom_restartMatch');
    }
    console.log(`[carrom] table ${t.id} restarted by host`);
  });

  // The core sync point: whoever's turn it was just finished a shot
  // locally (their own browser ran the exact same physics the original
  // single-player build always used) and sends the RESULT here — final
  // coin positions, updated scores, whose turn is next. This does not
  // re-simulate anything; it just relays the outcome to every other
  // seat at the table, who apply it directly to their own board.
  // Live, in-progress shot positions -- fires many times per second while
  // a shot is animating, so this is deliberately as cheap as possible: no
  // per-seat payload construction, no room-list broadcast, just a direct
  // relay of ephemeral visual data to every other socket at the table.
  // The authoritative result still comes from carrom_shotResult above;
  // this only makes the shot visible AS it happens instead of only after
  // it's already fully resolved.
  // Deliberately trivial -- the client-side watchdog uses this purely
  // to confirm THIS socket can genuinely round-trip a message right
  // now, which is the one thing a local .connected flag can't reliably
  // tell it after a real network interruption. No table lookup, no
  // state, just an immediate echo back.
  socket.on('carrom_ping', () => {
    socket.emit('carrom_pong');
  });

  socket.on('carrom_liveShot', (snapshot) => {
    const t = carromTables[carromTableId];
    if (!t || t.phase !== 'playing') return;
    for (const [socketId] of t.sockets) {
      if (socketId === socket.id) continue;
      const sock = io.sockets.sockets.get(socketId);
      if (sock) sock.emit('carrom_liveShot', snapshot);
    }
  });

  socket.on('carrom_shotResult', ({ boardState }) => {
    const t = carromTables[carromTableId];
    if (!t || t.phase !== 'playing') return;
    const info = t.sockets.get(socket.id);
    if (!info) return;
    // Trust boundary: only the seat whose turn it currently is (per the
    // last broadcast board state) may submit a result. Casual-game
    // trust model, same spirit as the rest of this platform — not
    // meant to survive a determined cheater, meant to stop accidental
    // cross-talk between seats.
    if (t.boardState && typeof t.boardState.turnPos === 'number' && t.boardState.turnPos !== info.pos) return;
    t.boardState = boardState;
    t.lastActivityAt = Date.now();
    carromBroadcast(t);
  });

  socket.on('carrom_leaveTable', () => {
    const t = carromTables[carromTableId];
    if (t) {
      const info = t.sockets.get(socket.id);
      t.sockets.delete(socket.id);
      if (info && t.seats[info.pos] && t.seats[info.pos].playerId === info.playerId) {
        if (t.phase === 'lobby') {
          t.seats[info.pos] = null;
        } else {
          t.seats[info.pos].isBot = true;
          t.seats[info.pos].connected = true;
          t.seats[info.pos].playerId = null;
        }
        if (info.playerId) delete carromPlayerIndex[info.playerId];
      }
      carromEnsureHumanHost(t);
      carromBroadcast(t);
    }
    carromTableId = null;
  });

  socket.on('disconnect', () => {
    const t = carromTables[carromTableId];
    if (!t) return;
    const info = t.sockets.get(socket.id);
    t.sockets.delete(socket.id);
    if (info && t.seats[info.pos] && t.seats[info.pos].playerId === info.playerId) {
      // Keep the seat (reconnect-friendly), just mark it disconnected —
      // same pattern as every other table on this platform. BUT — a
      // brief network flap can mean the client's new socket already
      // reconnected and re-marked this seat connected BEFORE this old
      // socket's disconnect event finished processing (event ordering
      // isn't guaranteed). If that's already happened, some other
      // socket is now registered for this exact seat — leaving it
      // stuck marked disconnected here would make the server treat an
      // actively-connected player as abandoned. Only mark disconnected
      // if nothing newer has already taken this seat over.
      const alreadyReclaimed = [...t.sockets.values()].some(v => v.pos === info.pos);
      if (!alreadyReclaimed) {
        t.seats[info.pos].connected = false;
      }
      carromEnsureHumanHost(t);
    }
    carromBroadcast(t);
  });
});

// ---------------- Crash protection ----------------
// Logs and keeps running rather than letting the whole process die on
// an unexpected error -- one bad shot payload or malformed message
// shouldn't take every active Carrom table down with it.
process.on('uncaughtException', (err) => {
  console.error('[carrom] Uncaught exception:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[carrom] Unhandled rejection:', reason);
});

// ---------------- Graceful shutdown ----------------
// Flushes the latest table state before actually exiting -- this is
// what makes the persistence above meaningful for a genuine SIGTERM
// (a graceful restart, e.g. shortly after a deploy while the host
// settles), not just an ungraceful crash the periodic interval save
// happens to catch. The GitHub push gets a bounded grace window rather
// than blocking shutdown forever if GitHub is slow or unreachable
// right at that moment.
async function finalCarromFlush() {
  saveCarromTablesLocal();
  if (GITHUB_ENABLED) {
    await Promise.race([
      githubPushCarromTables(),
      new Promise(resolve => setTimeout(resolve, 4000))
    ]);
  }
}
process.on('SIGTERM', async () => { await finalCarromFlush(); process.exit(0); });
process.on('SIGINT', async () => { await finalCarromFlush(); process.exit(0); });

server.listen(PORT, () => {
  console.log(`Carrom server running on port ${PORT}`);
  console.log(`[startup] Server process started at ${new Date(SERVER_START_TIME).toISOString()} — every table currently in memory was created after this moment.`);
});
