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
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');
const { GameEngine } = require('./game-engine');
const brain = require('./bot-brain');
const geoip = require('geoip-lite');

// ============================================================
// GLOBAL CRASH PROTECTION — this is not optional polish, it's the
// actual fix for tables intermittently disappearing across every game
// at once. Without this, Node's default behavior is: any single
// uncaught exception, anywhere -- one bad socket event, one edge case
// in one specific table's state, one null reference nobody hit before
// -- kills the ENTIRE process immediately. Every table in every game
// currently in memory is gone the instant that happens, and whatever
// auto-restarts the process (Render, a process manager, etc.) comes
// back up with nothing. That matches exactly "all tables disappearing,
// not always though" -- it only takes ONE rare bug anywhere to lose
// everything, so it looks random even though each individual crash has
// a real, specific cause.
//
// Node's own docs caution that "resuming normal operation after an
// uncaught exception" can leave things in an inconsistent state, and
// that's true in general -- but for this application, the alternative
// (losing every single active table across every game on any isolated
// bug) is unambiguously worse. A logged, contained failure in whatever
// one action triggered it is far better than a silent, total outage.
process.on('uncaughtException', (err) => {
  console.error('[FATAL-CAUGHT] Uncaught exception (server stayed up):', err && err.stack || err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL-CAUGHT] Unhandled promise rejection (server stayed up):', reason && reason.stack || reason);
});

const app = express();
const PORT = process.env.PORT || 9000;

// Render (and most hosts) sit behind a proxy/load balancer -- without this,
// every connection looks like it's coming from the proxy's internal IP
// instead of the actual visitor, which would make the location tracking
// below useless.
app.set('trust proxy', true);

// Browsers (especially mobile) cache static files aggressively by default,
// which means a redeploy can silently NOT reach a returning player — they
// keep seeing whatever old version their browser already cached. The game
// is small enough, and changes often enough during active development,
// that it's worth explicitly telling every browser never to cache it.
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res) => { res.setHeader('Cache-Control', 'no-store, must-revalidate'); }
}));
app.get('/status', (req, res) => {
  res.send('28 Kerala Gulan — Authoritative Server running ✅ | ' + totalActiveRooms() + ' active table(s) across all games');
});

// ============================================================
// COMMENT BOX — lets a player leave a message from the welcome screen
// without needing any email server. Readable only through /api/comments
// with the admin password -- that's the "admin panel" this feeds; see
// public/admin.html.
//
// This used to just be a local JSON file, with a comment here claiming
// that was "durable across restarts" -- that claim was wrong. Render's
// free tier wipes the local disk on every restart AND on every routine
// spin-down after 15 minutes idle (confirmed directly from Render's own
// docs earlier), so a plain local file quietly loses everything on a
// normal day of nobody using the site for a bit. Same fix as the
// visitor log: back it up to this project's own GitHub repo, which
// isn't going anywhere. Local file kept too, as a fast cache so every
// single comment doesn't trigger its own GitHub commit.
// ============================================================
app.use(express.json({ limit: '32kb' }));

const COMMENTS_FILE = path.join(__dirname, 'comments-data.json');
const GITHUB_COMMENTS_PATH = '4p2p/data/comments.json';
let comments = [];
let commentsDirty = false;
let githubCommentsFileSha = null;

async function githubFetchComments() {
  if (!GITHUB_ENABLED) return null;
  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_COMMENTS_PATH}?ref=${GITHUB_BRANCH}`, {
      headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' }
    });
    if (res.status === 404) { console.log('[comments] No existing comments.json in the repo yet — starting fresh.'); return []; }
    if (!res.ok) { console.error('[comments] GitHub fetch failed:', res.status, await res.text()); return null; }
    const json = await res.json();
    githubCommentsFileSha = json.sha;
    return JSON.parse(Buffer.from(json.content, 'base64').toString('utf8'));
  } catch (e) {
    console.error('[comments] GitHub fetch error:', e.message);
    return null;
  }
}
async function githubPushComments() {
  if (!GITHUB_ENABLED) return;
  try {
    const body = {
      message: `Update comments (${comments.length} entries)`,
      content: Buffer.from(JSON.stringify(comments)).toString('base64'),
      branch: GITHUB_BRANCH
    };
    if (githubCommentsFileSha) body.sha = githubCommentsFileSha;
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_COMMENTS_PATH}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) { console.error('[comments] GitHub push failed:', res.status, await res.text()); return; }
    const json = await res.json();
    githubCommentsFileSha = json.content.sha;
    console.log(`[comments] Synced ${comments.length} comments to GitHub.`);
  } catch (e) {
    console.error('[comments] GitHub push error:', e.message);
  }
}
async function loadComments() {
  if (GITHUB_ENABLED) {
    const fromGithub = await githubFetchComments();
    if (fromGithub) { comments = fromGithub; console.log(`[comments] Loaded ${comments.length} comment(s) from GitHub.`); return; }
    console.log('[comments] Falling back to local file for this boot (GitHub fetch failed).');
  }
  try {
    if (fs.existsSync(COMMENTS_FILE)) {
      comments = JSON.parse(fs.readFileSync(COMMENTS_FILE, 'utf8'));
      console.log(`[comments] Loaded ${comments.length} comment(s) from local disk.`);
    }
  } catch (e) {
    console.error('[comments] failed to load local comments file, starting fresh:', e.message);
    comments = [];
  }
}
function saveCommentsLocal() {
  if (!commentsDirty) return;
  try { fs.writeFileSync(COMMENTS_FILE, JSON.stringify(comments)); commentsDirty = false; }
  catch (e) { console.error('[comments] failed to save local comments file:', e.message); }
}
setInterval(saveCommentsLocal, 10000);
let lastGithubCommentsSyncCount = 0;
setInterval(() => {
  if (GITHUB_ENABLED && comments.length !== lastGithubCommentsSyncCount) {
    lastGithubCommentsSyncCount = comments.length;
    githubPushComments();
  }
}, 3 * 60 * 1000);

app.post('/api/comments', (req, res) => {
  const name = String((req.body && req.body.name) || 'Anonymous').slice(0, 40).trim() || 'Anonymous';
  const message = String((req.body && req.body.message) || '').slice(0, 2000).trim();
  if (!message) return res.status(400).json({ ok: false, error: 'empty_message' });
  comments.unshift({ id: crypto.randomBytes(6).toString('hex'), name, message, time: Date.now() });
  if (comments.length > 500) comments.length = 500; // cap growth — this is a comment box, not a database
  commentsDirty = true;
  saveCommentsLocal();
  console.log(`[comments] new message from ${name}`);
  res.json({ ok: true });
  // Push to GitHub right away rather than waiting for the periodic
  // sync -- a comment is a rare enough event (unlike the visitor log,
  // which could fire constantly) that pushing on every single one is
  // completely safe and won't come close to any rate limit, and it
  // closes the real gap where a free-tier spin-down between periodic
  // syncs could wipe a comment that was never actually backed up yet.
  if (GITHUB_ENABLED) { lastGithubCommentsSyncCount = comments.length; githubPushComments(); }
});

app.get('/api/comments', (req, res) => {
  if (req.query.password !== ADMIN_SECRET) return res.status(401).json({ ok: false, error: 'bad_password' });
  res.json({ ok: true, comments });
});

app.delete('/api/comments/:id', (req, res) => {
  if (req.query.password !== ADMIN_SECRET) return res.status(401).json({ ok: false, error: 'bad_password' });
  comments = comments.filter(c => c.id !== req.params.id);
  commentsDirty = true;
  saveCommentsLocal();
  if (GITHUB_ENABLED) { lastGithubCommentsSyncCount = comments.length; githubPushComments(); }
  res.json({ ok: true });
});

const server = http.createServer(app);
// Mobile browsers routinely throttle JavaScript timers even in a tab
// that's still technically foreground -- screen dimming, brief loss of
// focus, aggressive power management -- and Socket.IO's own defaults
// (ping every 25s, 20s to respond before giving up) only allow about a
// 45-second window for the client to answer a ping before it's
// considered dead and disconnected. That's close enough to "around a
// minute or under" to be the actual cause: not a real network drop,
// just the client's JS being briefly too throttled to answer in time.
// Longer, more forgiving values give a throttled tab room to catch up
// instead of losing the connection over a momentary stall.
const io = new Server(server, {
  cors: { origin: '*' },
  pingInterval: 25000,
  pingTimeout: 60000
});

// ---------------- Visitor location log (admin-only, anti-cheat visibility) ----------------
// The previous "visitor stats" in the admin panel were purely client-side
// (localStorage on whoever's viewing the dashboard), so they only ever
// reflected that one person's own browsing history -- not real traffic.
// This is the actual server-side version: every socket connection gets its
// real IP resolved to a rough location (country/region/city) via a local
// GeoIP database, no external calls, no per-request latency.
//
// Persistence: Render's free tier wipes the local disk on every spin-down
// (confirmed in their own docs — restarts happen after just 15 minutes of
// no traffic), so a plain local file doesn't actually survive in practice.
// Instead this uses the GitHub repo this project already lives in as the
// durable store — a small JSON file, updated via the GitHub API. That
// repo isn't going anywhere on a restart. The local file is kept too, as
// a fast in-between cache so every single visitor doesn't trigger its own
// GitHub commit; only a periodic sync (and a best-effort one on shutdown)
// actually pushes to GitHub.
//
// Requires two environment variables set on Render for this to activate:
//   GITHUB_TOKEN — a personal access token with "repo" (or fine-grained
//     "Contents: read and write") permission on the repo below.
//   GITHUB_REPO  — "owner/repo-name", e.g. "yourname/28-kerala-gulan".
// Without them, this quietly falls back to local-file-only (same
// unreliable-on-restart behavior as before) rather than crashing.
const fs2 = require('fs');
const VISITOR_LOG_FILE = path.join(__dirname, 'visitor-log-data.json');
const VISITOR_LOG_MAX = 500;
const VISITOR_LOG_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO = process.env.GITHUB_REPO || '';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const GITHUB_VISITOR_LOG_PATH = '4p2p/data/visitor-log.json';
const GITHUB_ENABLED = !!(GITHUB_TOKEN && GITHUB_REPO);
let visitorLog = [];
let visitorLogDirty = false;
let githubFileSha = null; // required by GitHub's API to update an existing file

function githubApiUrl() {
  return `https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_VISITOR_LOG_PATH}`;
}
async function githubFetchVisitorLog() {
  if (!GITHUB_ENABLED) return null;
  try {
    const res = await fetch(`${githubApiUrl()}?ref=${GITHUB_BRANCH}`, {
      headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' }
    });
    if (res.status === 404) { console.log('[visitor] No existing visitor-log.json in the repo yet — starting fresh.'); return []; }
    if (!res.ok) { console.error('[visitor] GitHub fetch failed:', res.status, await res.text()); return null; }
    const json = await res.json();
    githubFileSha = json.sha;
    const decoded = Buffer.from(json.content, 'base64').toString('utf8');
    return JSON.parse(decoded);
  } catch (e) {
    console.error('[visitor] GitHub fetch error:', e.message);
    return null;
  }
}
async function githubPushVisitorLog() {
  if (!GITHUB_ENABLED) return;
  try {
    const body = {
      message: `Update visitor log (${visitorLog.length} entries)`,
      content: Buffer.from(JSON.stringify(visitorLog)).toString('base64'),
      branch: GITHUB_BRANCH
    };
    if (githubFileSha) body.sha = githubFileSha;
    const res = await fetch(githubApiUrl(), {
      method: 'PUT',
      headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) { console.error('[visitor] GitHub push failed:', res.status, await res.text()); return; }
    const json = await res.json();
    githubFileSha = json.content.sha;
    console.log(`[visitor] Synced ${visitorLog.length} visits to GitHub.`);
  } catch (e) {
    console.error('[visitor] GitHub push error:', e.message);
  }
}

async function loadVisitorLog() {
  if (GITHUB_ENABLED) {
    const fromGithub = await githubFetchVisitorLog();
    if (fromGithub) {
      visitorLog = fromGithub;
      console.log(`[visitor] Loaded ${visitorLog.length} logged visit(s) from GitHub.`);
      return;
    }
    console.log('[visitor] Falling back to local file for this boot (GitHub fetch failed).');
  } else {
    console.log('[visitor] GITHUB_TOKEN/GITHUB_REPO not set — visitor log will only persist locally, which Render\'s free tier does not keep across a spin-down.');
  }
  try {
    if (fs2.existsSync(VISITOR_LOG_FILE)) {
      visitorLog = JSON.parse(fs2.readFileSync(VISITOR_LOG_FILE, 'utf8'));
      console.log(`[visitor] Loaded ${visitorLog.length} logged visit(s) from local disk.`);
    }
  } catch (e) {
    console.error('[visitor] Failed to load local visitor log, starting fresh:', e.message);
    visitorLog = [];
  }
}
function saveVisitorLogLocal() {
  if (!visitorLogDirty) return;
  try {
    fs2.writeFileSync(VISITOR_LOG_FILE, JSON.stringify(visitorLog));
    visitorLogDirty = false;
  } catch (e) {
    console.error('[visitor] Failed to save local visitor log:', e.message);
  }
}
// Local save is cheap and frequent (matches every other module's pattern
// here). The GitHub sync is deliberately much less frequent — it's a real
// network call and a real commit, so hammering it on every visitor would
// both spam the repo's history and risk GitHub's rate limits for no
// benefit; a few minutes of possible loss on an ungraceful crash is an
// acceptable tradeoff for "actually survives a normal restart" at all.
setInterval(saveVisitorLogLocal, 10000);
let lastGithubSyncCount = 0;
setInterval(() => {
  if (GITHUB_ENABLED && visitorLog.length !== lastGithubSyncCount) {
    lastGithubSyncCount = visitorLog.length;
    githubPushVisitorLog();
  }
}, 3 * 60 * 1000);
loadVisitorLog();
loadComments();

// Consolidated graceful shutdown -- every module with something to save
// (bot brains, visitor log, anything added later) registers its own
// SIGTERM/SIGINT listener that just saves, without exiting; this is the
// one place that actually calls process.exit(), after everyone's had a
// chance to flush to disk. The GitHub push is a real network round trip,
// so it gets a bounded grace window rather than blocking shutdown forever
// if GitHub is slow or unreachable right at that moment.
async function finalVisitorLogFlush() {
  saveVisitorLogLocal();
  saveCommentsLocal();
  if (GITHUB_ENABLED) {
    await Promise.race([
      Promise.all([githubPushVisitorLog(), githubPushComments()]),
      new Promise(resolve => setTimeout(resolve, 4000))
    ]);
  }
}
process.on('SIGTERM', async () => { await finalVisitorLogFlush(); process.exit(0); });
process.on('SIGINT', async () => { await finalVisitorLogFlush(); process.exit(0); });

function clientIpFor(socket) {
  // x-forwarded-for can be a comma-separated chain (proxy hops) -- the
  // first entry is the original client.
  const xff = socket.handshake.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return socket.handshake.address || '';
}

function logVisitor(socket) {
  const ip = clientIpFor(socket);
  const geo = ip ? geoip.lookup(ip) : null;
  const entry = {
    ip,
    country: geo ? geo.country : null,
    region: geo ? geo.region : null,
    city: geo ? geo.city : null,
    timezone: geo ? geo.timezone : null,
    ts: Date.now(),
    socketId: socket.id
  };
  visitorLog.unshift(entry);
  const cutoff = Date.now() - VISITOR_LOG_MAX_AGE_MS;
  visitorLog = visitorLog.filter(e => e.ts >= cutoff);
  if (visitorLog.length > VISITOR_LOG_MAX) visitorLog.length = VISITOR_LOG_MAX;
  visitorLogDirty = true;
  return entry;
}

function visitorLogFilteredAndSummary(filter) {
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  const cutoffs = { today: now - DAY, week: now - 7 * DAY, month: now - 30 * DAY, all: 0 };
  const cutoff = cutoffs[filter] !== undefined ? cutoffs[filter] : 0;
  const entries = visitorLog.filter(e => e.ts >= cutoff);
  const summary = {
    today: visitorLog.filter(e => e.ts >= cutoffs.today).length,
    week: visitorLog.filter(e => e.ts >= cutoffs.week).length,
    month: visitorLog.filter(e => e.ts >= cutoffs.month).length,
    all: visitorLog.length
  };
  return { entries, summary };
}

io.on('connection', (socket) => {
  const entry = logVisitor(socket);
  console.log(`[visitor] ${entry.ip} — ${entry.city || '?'}, ${entry.region || '?'}, ${entry.country || '?'}`);
  // Kept around for as long as the socket is connected so the admin
  // panel's live-players view can show "where from" for anyone
  // currently seated at any table, without needing every single game
  // to independently do its own geo lookup.
  socketLocations.set(socket.id, { ip: entry.ip, city: entry.city, region: entry.region, country: entry.country });
  socket.on('disconnect', () => socketLocations.delete(socket.id));

  socket.on('adminGetVisitorLog', ({ adminPassword, filter }) => {
    if (adminPassword !== ADMIN_SECRET) { socket.emit('adminActionResult', { ok: false, action: 'visitorLog', reason: 'wrong_password' }); return; }
    const { entries, summary } = visitorLogFilteredAndSummary(filter || 'all');
    socket.emit('adminVisitorLog', { entries, summary, filter: filter || 'all' });
  });
});

const socketLocations = new Map(); // socket.id -> {ip, city, region, country}, for as long as connected

// Walks every game's table registry and returns a flat list of
// currently-connected human players -- who they are, which game and
// table, and where they're connecting from. Deliberately reads each
// registry directly rather than needing every game to separately
// publish this, since the shape (a Map of socket.id -> seat info,
// plus named seats) is already consistent across all four games.
function getAllLivePlayers() {
  const rows = [];
  function addFromSocketsMap(socketsMap, gameLabel, tableId, seatLookup) {
    if (!socketsMap) return;
    for (const [socketId, info] of socketsMap) {
      const seat = seatLookup(info);
      if (!seat || seat.isBot) continue;
      const loc = socketLocations.get(socketId);
      rows.push({
        name: seat.name || 'Player',
        game: gameLabel,
        tableId,
        connected: seat.connected !== false,
        location: loc ? [loc.city, loc.region, loc.country].filter(Boolean).join(', ') || loc.ip : '?',
        ip: loc ? loc.ip : '?'
      });
    }
  }
  for (const t of Object.values(tables)) {
    addFromSocketsMap(t.sockets, '4-Player', t.id, (info) => t.engine.seats[info.pos]);
  }
  for (const t of Object.values(sixpTables)) {
    addFromSocketsMap(t.sockets, '6-Player', t.id, (info) => t.engine.seats[info.pos]);
  }
  for (const r of Object.values(l56Rooms)) {
    addFromSocketsMap(r.sockets, '56', r.code, (info) => r.state && r.state.seats && r.state.seats[info.pos]);
  }
  for (const t of Object.values(pokerTables)) {
    addFromSocketsMap(t.sockets, "Hold'em", t.engine.tableId, (info) => t.engine.seats[info.pos]);
  }
  return rows;
}

app.get('/api/live-players', (req, res) => {
  if (req.query.password !== ADMIN_SECRET) return res.status(401).json({ ok: false, error: 'bad_password' });
  res.json({ ok: true, players: getAllLivePlayers() });
});

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

// Room cap, set/cleared by the admin panel. When enabled, brand new table
// creations (4-player or 6-player, counted together) are refused once
// roomCapMax tables already exist — but joining/watching any table that
// already exists is completely unaffected, and so is anyone reconnecting
// to a seat they already hold. This only throttles NEW room creation.
let roomCapEnabled = false;
let roomCapMax = 3;
function totalActiveRooms() { return Object.keys(tables).length + Object.keys(sixpTables).length + Object.keys(l56Rooms).length; }

// Matches the client's ADMIN_PASSWORD default (0000) — that's the panel
// this lock feature actually lives in — so it works out of the box, but
// can be overridden per-deployment via an environment variable without
// touching either file.
let ADMIN_SECRET = process.env.ADMIN_SECRET || '0000';
// In-memory only, on purpose -- resets to the env var/default on every
// server restart or redeploy. That's the honest tradeoff of a password
// you can change without editing files: there's no persistent store
// backing it here, same as the room cap and other admin toggles.

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

function touch(t) {
  t.lastActivityAt = Date.now();
  if (t.stillPlayingTimer) {
    clearTimeout(t.stillPlayingTimer);
    t.stillPlayingTimer = null;
    if (t.id) io.to(t.id).emit('stillPlayingResolved');
  }
}

// If a table has zero real humans left (everyone who's left is a bot, or
// the table is just empty), don't let it sit around playing bot-vs-bot
// forever -- give a real window in case someone (the original player, or
// anyone else) comes back, then close it. Called after every
// disconnect/leave; cancelled automatically the moment a human is
// present again. 30 minutes so a traveling player with spotty signal, or
// someone just stepping away for a bit, doesn't lose their table to a
// timer that was really meant for "actually abandoned."
const NO_HUMAN_GRACE_MS = 30 * 60 * 1000;
function scheduleNoHumanShutdown(t, id) {
  if (t.noHumanShutdownTimer) { clearTimeout(t.noHumanShutdownTimer); t.noHumanShutdownTimer = null; }
  if (hasAnyHuman(t)) return; // someone's still here — nothing to schedule
  console.log(`[cleanup] Table ${id} has no humans left — closing in ${NO_HUMAN_GRACE_MS / 1000}s unless someone reconnects`);
  t.noHumanShutdownTimer = setTimeout(() => {
    const stillThere = tables[id];
    if (!stillThere || hasAnyHuman(stillThere)) return; // a human came back in the meantime
    console.log(`[cleanup] Closing table ${id} — no humans left, only bots (30min grace period elapsed)`);
    for (const s of stillThere.engine.seats) if (s && s.playerId) delete playerIndex[s.playerId];
    delete tables[id];
    io.emit('roomList', publicTableList());
  }, NO_HUMAN_GRACE_MS);
}

// Reap tables that have had no real (human) activity for 5 minutes AND
// currently have nobody connected at all — mirrors the "close after 5 min
// idle" policy from the old client, but now enforced centrally instead of
// depending on any one browser's timer still being alive to do it.
//
// For tables where people ARE still connected but nothing has actually
// happened in 5 minutes (nobody's bid, played, or so on — maybe everyone
// just wandered off with the tab open), don't silently close it or let it
// sit there forever either: ask. Everyone gets a 60-second countdown to
// tap "Still here" — any real game action, or that tap, cancels it and
// resets the clock. Nobody answering closes the table.
const IDLE_LIMIT_MS = 30 * 60 * 1000;
const STILL_PLAYING_COUNTDOWN_MS = 60 * 1000;

function startStillPlayingCheck(t, id) {
  if (t.stillPlayingTimer) return; // already asking
  io.to(id).emit('stillPlayingCheck', { seconds: STILL_PLAYING_COUNTDOWN_MS / 1000 });
  t.stillPlayingTimer = setTimeout(() => {
    const stillThere = tables[id];
    if (!stillThere) return;
    stillThere.stillPlayingTimer = null;
    console.log(`[idle] Closing table ${id} — nobody confirmed still playing`);
    io.to(id).emit('tableClosed', { reason: 'idle' });
    for (const s of stillThere.engine.seats) if (s && s.playerId) delete playerIndex[s.playerId];
    delete tables[id];
    io.emit('roomList', publicTableList());
  }, STILL_PLAYING_COUNTDOWN_MS);
}

setInterval(() => {
  const now = Date.now();
  for (const id of Object.keys(tables)) {
    const t = tables[id];
    const anyoneConnected = t.engine.seats.some(s => s && s.connected);
    if (!anyoneConnected && now - t.lastActivityAt > IDLE_LIMIT_MS) {
      console.log(`[cleanup] Closing idle table ${id} (${now - t.lastActivityAt}ms since last activity)`);
      for (const s of t.engine.seats) if (s && s.playerId) delete playerIndex[s.playerId];
      delete tables[id];
    } else if (anyoneConnected && now - t.lastActivityAt > IDLE_LIMIT_MS) {
      startStillPlayingCheck(t, id);
    }
  }
  io.emit('roomList', publicTableList());
}, 30000);

io.on('connection', (socket) => {
  let playerId = null;
  let tableId = null;

  // Every fresh connection immediately learns the current room-cap status,
  // mainly so the admin panel can show it — regular players never need to
  // act on this themselves, since creating is the only thing it can block
  // and that comes back as its own friendly 'createBlocked' message.
  socket.emit('lockStatus', { capped: roomCapEnabled, maxRooms: roomCapMax, currentRooms: totalActiveRooms() });

  socket.on('listRooms', () => {
    socket.emit('roomList', publicTableList());
  });

  // Admin-only: enable/change or clear the room cap. Verified against a
  // server-side secret so this can't just be called from devtools by
  // anyone who noticed the event name — the client's own password prompt
  // is a convenience, not the actual security boundary.
  socket.on('adminSetLock', ({ adminPassword, maxRooms }) => {
    if (adminPassword !== ADMIN_SECRET) { socket.emit('adminActionResult', { ok: false, action: 'setLock', reason: 'wrong_password' }); return; }
    const n = parseInt(maxRooms, 10);
    roomCapMax = Number.isFinite(n) && n >= 0 ? Math.min(n, 50) : 3;
    roomCapEnabled = true;
    io.emit('lockStatus', { capped: true, maxRooms: roomCapMax, currentRooms: totalActiveRooms() });
    socket.emit('adminActionResult', { ok: true, action: 'setLock' });
    console.log(`[admin] room cap enabled — max ${roomCapMax} concurrent rooms`);
  });

  socket.on('adminClearLock', ({ adminPassword }) => {
    if (adminPassword !== ADMIN_SECRET) { socket.emit('adminActionResult', { ok: false, action: 'clearLock', reason: 'wrong_password' }); return; }
    roomCapEnabled = false;
    io.emit('lockStatus', { capped: false, maxRooms: roomCapMax, currentRooms: totalActiveRooms() });
    socket.emit('adminActionResult', { ok: true, action: 'clearLock' });
    console.log('[admin] room cap disabled');
  });

  // Verifies a password against the real server-side secret -- used right
  // when the admin panel is opened, so a stale cached password (e.g. after
  // a server restart reset it back to default, or someone changed it from
  // another device) gets caught and corrected up front, instead of
  // silently failing on every single action taken inside the panel.
  socket.on('adminVerifyPassword', ({ password }) => {
    socket.emit('adminVerifyResult', { ok: password === ADMIN_SECRET });
  });

  socket.on('adminChangePassword', ({ adminPassword, newPassword }) => {
    if (adminPassword !== ADMIN_SECRET) { socket.emit('adminPasswordChangeResult', { ok: false, reason: 'wrong_current' }); return; }
    const trimmed = String(newPassword || '').trim();
    if (trimmed.length < 4) { socket.emit('adminPasswordChangeResult', { ok: false, reason: 'too_short' }); return; }
    ADMIN_SECRET = trimmed;
    console.log('[admin] password changed');
    socket.emit('adminPasswordChangeResult', { ok: true, newPassword: trimmed });
  });

  socket.on('createTable', ({ name }) => {
    if (roomCapEnabled && totalActiveRooms() >= roomCapMax) {
      socket.emit('createBlocked', { maxRooms: roomCapMax });
      return;
    }
    const id = newTableId();
    const engine = new GameEngine(id);
    playerId = newId();
    engine.seatHuman(3, name || 'Player', playerId);
    const t = {
      id, engine, name: name || 'Player', hostPlayerId: playerId,
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
        // A vacant host slot (nobody connected to hold it) goes to
        // whoever's the first human to actually show up -- doesn't
        // matter if it's the original host coming back or someone else
        // entirely; the table shouldn't sit unusable waiting on one
        // specific person.
        if (!t.hostPlayerId) {
          t.hostPlayerId = playerId;
          t.engine.addLog(`${t.engine.seats[idx.pos].name} is now the host.`);
          console.log(`[table ${tableId}] ${name} reconnected and took the vacant host slot`);
        }
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

    // Past this point it's a genuinely new join (never a reconnect). The
    // room cap only throttles brand new CREATE requests — joining or
    // watching a table that already exists is always allowed, cap or not.
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

    // A vacant host slot means there's genuinely nobody left who could
    // ever approve a join request -- waiting for one would mean waiting
    // forever. Skip straight to seat selection the same way a
    // not-yet-started table already works; whichever seat they take,
    // they'll become host automatically once they're actually seated.
    if (!t.hostPlayerId) {
      pendingSeatChoice[socket.id] = { tableId: reqTableId, name: name || 'Player' };
      socket.emit('chooseSeat', { tableId: reqTableId, openSeats, botSeats, disconnectedSeats, seats: seatSnapshot(t), canWatch: false, needsApproval: false });
      console.log(`[table ${reqTableId}] ${name} joining directly — host slot was vacant, no approval needed`);
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
    // A vacant host slot goes to whoever's the first human to actually
    // take a seat -- same reasoning as the reconnect path above.
    if (!t.hostPlayerId) {
      t.hostPlayerId = playerId;
      t.engine.addLog(`${pending.name} is now the host.`);
      console.log(`[table ${tableId}] ${pending.name} took the vacant host slot`);
    }
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
      const botNamePool = ['Charlie', 'Wesley', 'Benson', 'Rahul', 'Anjali', 'Neha', 'Nate', 'Koshy', 'Meera', 'Priya', 'Sanjay', 'Johny', 'Vinod', 'Jean', 'Randall', 'Rajesh', 'Stev', 'Alok', 'Jerin', 'Binchu', 'Ajai', 'Peter', 'Shyam', 'Appu', 'Anup', 'Arun', 'Vilphy', 'Roji'];
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

  // Read-only: lets the Brain Manager panel show REAL server-side
  // learning data for online bots, instead of only ever showing the
  // player's own local browser data (which online bots never touch at
  // all — they learn through the server's persistent bot-brain.js store,
  // a completely separate place from local mode's localStorage).
  socket.on('getTableBrains', () => {
    const t = tables[tableId];
    if (!t) { socket.emit('tableBrains', { brains: {} }); return; }
    const brains = {};
    for (const seat of t.engine.seats) {
      if (!seat || !seat.isBot) continue;
      const b = brain.getBrain(seat.name);
      brains[seat.name] = {
        level: b.level, experience: b.experience, totalGames: b.totalGames,
        totalRounds: b.totalRounds, totalBids: b.totalBids,
        bidsWon: b.stats.bidsWon, bidsLost: b.stats.bidsLost,
        tricksWon: b.stats.tricksWon, tricksLost: b.stats.tricksLost
      };
    }
    socket.emit('tableBrains', { brains });
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

  // Any seated player can signal their partner between rounds -- not
  // host-restricted like the controls below, since this is between two
  // teammates, not a table-admin action.
  socket.on('sendPartnerSignal', ({ signal }) => {
    withTable((t, pos) => {
      if (pos === null || pos === undefined) return;
      if (t.engine.phase !== 'roundEnd') return;
      t.engine.sendPartnerSignal(pos, signal);
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

  // Host-only: swap which named bot is playing a seat, any time during
  // the game — safe because it only ever changes the name string (see
  // renameBotSeat in game-engine.js), never touches cards or turn state.
  socket.on('changeBotName', ({ pos, newName }) => {
    withTable((t) => {
      if (t.hostPlayerId !== playerId) return;
      const result = t.engine.renameBotSeat(pos, newName);
      if (!result.ok) socket.emit('actionError', result);
      else console.log(`[table ${tableId}] host renamed bot at seat ${pos} to ${newName}`);
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

  // A tap of "Still here" on the idle-check popup — just counts as
  // activity, which touch() already turns into cancelling the countdown
  // and telling everyone in the room to dismiss the popup.
  socket.on('stillPlaying', () => {
    const t = tables[tableId];
    if (t) touch(t);
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
      // If nobody else is connected right now (bots fill the rest of the
      // table, or everyone else already dropped too), the host slot goes
      // vacant rather than staying stuck pointing at someone who can no
      // longer act -- a vacant slot is what lets ANY human who shows up
      // next (the same player reconnecting, or someone brand new) become
      // host automatically instead of the table being unusable until
      // that one specific person comes back.
      if (t.hostPlayerId === info.playerId) {
        const newHostSeat = t.engine.seats.find(s => s && !s.isBot && s.connected && s.playerId !== info.playerId);
        if (newHostSeat) {
          t.hostPlayerId = newHostSeat.playerId;
          t.engine.addLog(`${newHostSeat.name} is now the host.`);
          console.log(`[table ${tableId}] host left — ${newHostSeat.name} is now host`);
        } else {
          t.hostPlayerId = null;
          t.engine.addLog(`The host disconnected — the table is being kept open, and whoever joins next becomes host.`);
          console.log(`[table ${tableId}] host left — no other human present, host slot vacant`);
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

// ============================================================
// VOICE CHAT — WebRTC signaling relay only.
// This server never touches actual audio; it just shuttles small JSON
// offer/answer/ICE messages between browsers sitting at the same table so
// they can open direct peer-to-peer audio connections with each other
// (a "mesh" call). Works for both the 4-player and 6-player tables
// without knowing anything about either — it just uses whichever room
// the socket already joined via socket.join(...) above (the table id for
// 4-player, 'sixp_'+id for 6-player), so voice is automatically scoped to
// "everyone currently at this table".
// ============================================================
const voiceRooms = new Map(); // roomName -> Map(socketId -> displayName)

function voiceRoomOf(socket) {
  for (const r of socket.rooms) if (r !== socket.id) return r;
  return null;
}

io.on('connection', (socket) => {
  socket.on('voiceJoin', ({ name }) => {
    const room = voiceRoomOf(socket);
    if (!room) return;
    let peers = voiceRooms.get(room);
    if (!peers) { peers = new Map(); voiceRooms.set(room, peers); }
    const existing = Array.from(peers.entries()).map(([id, n]) => ({ id, name: n }));
    peers.set(socket.id, String(name || 'Player').slice(0, 20));
    socket.emit('voicePeers', existing);
    socket.to(room).emit('voicePeerJoined', { id: socket.id, name: peers.get(socket.id) });
  });

  socket.on('voiceSignal', ({ to, signal }) => {
    if (!to || !signal) return;
    io.to(to).emit('voiceSignal', { from: socket.id, signal });
  });

  socket.on('voiceLeave', () => {
    const room = voiceRoomOf(socket);
    if (room && voiceRooms.has(room)) voiceRooms.get(room).delete(socket.id);
    if (room) socket.to(room).emit('voicePeerLeft', { id: socket.id });
  });

  socket.on('disconnect', () => {
    for (const [room, peers] of voiceRooms) {
      if (peers.has(socket.id)) {
        peers.delete(socket.id);
        socket.to(room).emit('voicePeerLeft', { id: socket.id });
        if (peers.size === 0) voiceRooms.delete(room);
      }
    }
  });
});

// ============================================================
// 6-PLAYER VARIANT — completely separate table registry, separate socket
// connection handler, separate (sixp_-prefixed) event names. Deliberately
// NOT sharing a single line of state with the 4-player system above —
// the two games run side by side on this same server/process, but
// nothing in here can affect the 4-player tables, and nothing in the
// 4-player handlers above can affect these.
// ============================================================
const { GameEngine6P } = require('./game-engine-6p');

const sixpTables = {};
const sixpPlayerIndex = {};
const sixpPendingSeatChoice = {};

function newSixpTableId() { return 'S' + crypto.randomBytes(4).toString('hex').toUpperCase(); }

function sixpJoinableSeats(t) {
  const botSeats = [];
  const disconnectedSeats = [];
  t.engine.seats.forEach((s, i) => {
    if (!s) return;
    if (s.isBot) botSeats.push(i);
    else if (!s.connected) disconnectedSeats.push({ pos: i, name: s.name });
  });
  return { botSeats, disconnectedSeats };
}

function sixpSeatSnapshot(t) {
  return t.engine.seats.map((s, i) => s ? { pos: i, name: s.name, isBot: s.isBot, connected: s.connected, isHost: s.playerId === t.hostPlayerId } : null);
}

function sixpHasAnyHuman(t) { return t.engine.seats.some(s => s && !s.isBot); }

function sixpPublicTableList() {
  return Object.values(sixpTables)
    .filter(t => t.engine.seats.some(Boolean))
    .map(t => {
      const openSeats = t.engine.emptySeats().length;
      const botSeats = t.engine.seats.filter(s => s && s.isBot).length;
      return {
        tableId: t.engine.tableId, name: t.name,
        players: t.engine.seats.filter(Boolean).length,
        isPlaying: t.engine.phase !== 'lobby',
        openSeats, botSeats,
        canJoinSeat: openSeats > 0 || botSeats > 0
      };
    });
}

function sixpBroadcastTable(t) {
  for (const [socketId, info] of t.sockets) {
    const sock = io.sockets.sockets.get(socketId);
    if (!sock) continue;
    const state = t.engine.stateFor(info.pos);
    state.isHost = (info.playerId === t.hostPlayerId);
    sock.emit('sixp_state', state);
  }
  io.emit('sixp_roomList', sixpPublicTableList());
}

function sixpTouch(t) {
  t.lastActivityAt = Date.now();
  if (t.stillPlayingTimer) {
    clearTimeout(t.stillPlayingTimer);
    t.stillPlayingTimer = null;
    if (t.id) io.to('sixp_' + t.id).emit('sixp_stillPlayingResolved');
  }
}

const SIXP_NO_HUMAN_GRACE_MS = 30 * 60 * 1000;
function sixpScheduleNoHumanShutdown(t, id) {
  if (t.noHumanShutdownTimer) { clearTimeout(t.noHumanShutdownTimer); t.noHumanShutdownTimer = null; }
  if (sixpHasAnyHuman(t)) return;
  t.noHumanShutdownTimer = setTimeout(() => {
    const stillThere = sixpTables[id];
    if (!stillThere || sixpHasAnyHuman(stillThere)) return;
    console.log(`[6p cleanup] Closing table ${id} — no humans left`);
    for (const s of stillThere.engine.seats) if (s && s.playerId) delete sixpPlayerIndex[s.playerId];
    delete sixpTables[id];
    io.emit('sixp_roomList', sixpPublicTableList());
  }, SIXP_NO_HUMAN_GRACE_MS);
}

const SIXP_IDLE_LIMIT_MS = 30 * 60 * 1000;
const SIXP_STILL_PLAYING_COUNTDOWN_MS = 60 * 1000;
function sixpStartStillPlayingCheck(t, id) {
  if (t.stillPlayingTimer) return;
  io.to('sixp_' + id).emit('sixp_stillPlayingCheck', { seconds: SIXP_STILL_PLAYING_COUNTDOWN_MS / 1000 });
  t.stillPlayingTimer = setTimeout(() => {
    const stillThere = sixpTables[id];
    if (!stillThere) return;
    stillThere.stillPlayingTimer = null;
    console.log(`[6p idle] Closing table ${id} — nobody confirmed still playing`);
    io.to('sixp_' + id).emit('sixp_tableClosed', { reason: 'idle' });
    for (const s of stillThere.engine.seats) if (s && s.playerId) delete sixpPlayerIndex[s.playerId];
    delete sixpTables[id];
    io.emit('sixp_roomList', sixpPublicTableList());
  }, SIXP_STILL_PLAYING_COUNTDOWN_MS);
}

setInterval(() => {
  const now = Date.now();
  for (const id of Object.keys(sixpTables)) {
    const t = sixpTables[id];
    const anyoneConnected = t.engine.seats.some(s => s && s.connected);
    if (!anyoneConnected && now - t.lastActivityAt > SIXP_IDLE_LIMIT_MS) {
      console.log(`[6p cleanup] Closing idle table ${id}`);
      for (const s of t.engine.seats) if (s && s.playerId) delete sixpPlayerIndex[s.playerId];
      delete sixpTables[id];
    } else if (anyoneConnected && now - t.lastActivityAt > SIXP_IDLE_LIMIT_MS) {
      sixpStartStillPlayingCheck(t, id);
    }
  }
  io.emit('sixp_roomList', sixpPublicTableList());
}, 30000);

io.on('connection', (socket) => {
  let sixpPlayerId = null;
  let sixpTableId = null;

  socket.on('sixp_listRooms', () => { socket.emit('sixp_roomList', sixpPublicTableList()); });

  socket.on('sixp_createTable', ({ name }) => {
    if (roomCapEnabled && totalActiveRooms() >= roomCapMax) {
      socket.emit('createBlocked', { maxRooms: roomCapMax });
      return;
    }
    const id = newSixpTableId();
    const engine = new GameEngine6P(id);
    sixpPlayerId = newId();
    engine.seatHuman(0, name || 'Player', sixpPlayerId);
    const t = {
      id, engine, name: name || 'Player', hostPlayerId: sixpPlayerId,
      botFill: 5, createdAt: Date.now(), lastActivityAt: Date.now(),
      sockets: new Map()
    };
    engine.onChange = () => { sixpTouch(t); sixpBroadcastTable(t); };
    sixpTables[id] = t;
    sixpTableId = id;
    sixpPlayerIndex[sixpPlayerId] = { tableId: id, pos: 0 };
    t.sockets.set(socket.id, { playerId: sixpPlayerId, pos: 0 });
    socket.join('sixp_' + id);
    socket.emit('sixp_joined', { tableId: id, playerId: sixpPlayerId, pos: 0, isHost: true });
    sixpBroadcastTable(t);
    sixpScheduleNoHumanShutdown(t, id);
    io.emit('sixp_roomList', sixpPublicTableList());
    console.log(`[6p table ${id}] created by ${name}`);
  });

  socket.on('sixp_joinTable', ({ tableId: reqTableId, name, playerId: existingPlayerId }) => {
    if (existingPlayerId && sixpPlayerIndex[existingPlayerId]) {
      const idx = sixpPlayerIndex[existingPlayerId];
      const t = sixpTables[idx.tableId];
      if (t && t.engine.seats[idx.pos] && t.engine.seats[idx.pos].playerId === existingPlayerId) {
        sixpPlayerId = existingPlayerId;
        sixpTableId = idx.tableId;
        t.engine.markConnected(idx.pos, true);
        if (name) t.engine.seats[idx.pos].name = name;
        t.sockets.set(socket.id, { playerId: sixpPlayerId, pos: idx.pos });
        socket.join('sixp_' + sixpTableId);
        // A vacant host slot (nobody connected to hold it) goes to
        // whoever's the first human to actually show up.
        if (!t.hostPlayerId) {
          t.hostPlayerId = sixpPlayerId;
          t.engine.addLog(`${t.engine.seats[idx.pos].name} is now the host.`);
        }
        socket.emit('sixp_joined', { tableId: sixpTableId, playerId: sixpPlayerId, pos: idx.pos, isHost: t.hostPlayerId === sixpPlayerId });
        sixpTouch(t);
        sixpBroadcastTable(t);
        sixpScheduleNoHumanShutdown(t, sixpTableId);
        return;
      }
    }
    const t = sixpTables[reqTableId];
    if (!t) { socket.emit('sixp_joinError', { reason: 'table_not_found' }); return; }
    const openSeats = t.engine.emptySeats();
    const { botSeats, disconnectedSeats } = sixpJoinableSeats(t);
    if (openSeats.length === 0 && botSeats.length === 0 && disconnectedSeats.length === 0) {
      socket.emit('sixp_joinError', { reason: 'table_full' });
      return;
    }
    // Simpler than the 4p game for this first pass: no host-approval gate
    // for joining a table already in progress — straight to seat picking.
    sixpPendingSeatChoice[socket.id] = { tableId: reqTableId, name: name || 'Player' };
    socket.emit('sixp_chooseSeat', { tableId: reqTableId, openSeats, botSeats, disconnectedSeats, seats: sixpSeatSnapshot(t) });
  });

  socket.on('sixp_claimSeat', ({ choice }) => {
    const pending = sixpPendingSeatChoice[socket.id];
    if (!pending) return;
    const t = sixpTables[pending.tableId];
    if (!t) { socket.emit('sixp_joinError', { reason: 'table_not_found' }); return; }
    delete sixpPendingSeatChoice[socket.id];

    let pos = -1;
    if (choice === 'bot' || choice === undefined) {
      const { botSeats } = sixpJoinableSeats(t);
      pos = botSeats[0];
      if (pos === undefined) { socket.emit('sixp_joinError', { reason: 'not_a_bot_seat' }); return; }
      if (!t.engine.replaceBot(pos, newId(), pending.name)) { socket.emit('sixp_joinError', { reason: 'replace_failed' }); return; }
      sixpPlayerId = t.engine.seats[pos].playerId;
    } else if (typeof choice === 'number') {
      pos = choice;
      const seat = t.engine.seats[pos];
      if (!seat) {
        sixpPlayerId = newId();
        t.engine.seatHuman(pos, pending.name, sixpPlayerId);
      } else if (seat.isBot) {
        sixpPlayerId = newId();
        if (!t.engine.replaceBot(pos, sixpPlayerId, pending.name)) { socket.emit('sixp_joinError', { reason: 'replace_failed' }); return; }
      } else if (!seat.connected) {
        sixpPlayerId = newId();
        if (!t.engine.takeOverSeat(pos, sixpPlayerId, pending.name)) { socket.emit('sixp_joinError', { reason: 'seat_taken' }); return; }
      } else {
        socket.emit('sixp_joinError', { reason: 'seat_taken' });
        return;
      }
    }
    sixpTableId = pending.tableId;
    sixpPlayerIndex[sixpPlayerId] = { tableId: sixpTableId, pos };
    t.sockets.set(socket.id, { playerId: sixpPlayerId, pos });
    socket.join('sixp_' + sixpTableId);
    // A vacant host slot goes to whoever's the first human to actually
    // take a seat.
    if (!t.hostPlayerId) {
      t.hostPlayerId = sixpPlayerId;
      t.engine.addLog(`${pending.name} is now the host.`);
    }
    socket.emit('sixp_joined', { tableId: sixpTableId, playerId: sixpPlayerId, pos, isHost: t.hostPlayerId === sixpPlayerId });
    sixpTouch(t);
    sixpBroadcastTable(t);
    sixpScheduleNoHumanShutdown(t, sixpTableId);
    io.emit('sixp_roomList', sixpPublicTableList());
  });

  function withSixpTable(fn) {
    const t = sixpTables[sixpTableId];
    if (!t) return;
    const info = t.sockets.get(socket.id);
    if (!info) return;
    fn(t, info.pos);
  }

  socket.on('sixp_chat', ({ msg }) => {
    withSixpTable((t, pos) => {
      const trimmed = String(msg || '').slice(0, 300).trim();
      if (!trimmed) return;
      const seat = t.engine.seats[pos];
      if (!seat) return;
      io.to('sixp_' + sixpTableId).emit('sixp_chat', { from: seat.name, msg: trimmed, senderId: socket.id });
      sixpTouch(t);
    });
  });

  socket.on('sixp_stillPlaying', () => {
    withSixpTable((t) => { sixpTouch(t); });
  });

  socket.on('sixp_fillBots', ({ count }) => {
    withSixpTable((t, pos) => {
      if (t.hostPlayerId !== sixpPlayerId) return;
      t.botFill = Math.max(0, Math.min(5, count));
    });
  });

  socket.on('sixp_startGame', () => {
    withSixpTable((t) => {
      if (t.hostPlayerId !== sixpPlayerId) return;
      if (t.engine.phase !== 'lobby') return;
      const empties = t.engine.emptySeats();
      const botNamePool = ['Charlie', 'Wesley', 'Benson', 'Rahul', 'Anjali', 'Neha', 'Nate', 'Koshy', 'Meera', 'Priya', 'Sanjay', 'Johny', 'Vinod', 'Jean', 'Randall', 'Rajesh', 'Stev', 'Alok', 'Jerin', 'Binchu', 'Ajai', 'Peter', 'Shyam', 'Appu', 'Anup', 'Arun', 'Vilphy', 'Roji'];
      const shuffled = [...botNamePool].sort(() => Math.random() - 0.5);
      let botNum = 0;
      for (const pos of empties) {
        t.engine.seatBot(pos, shuffled[botNum % shuffled.length]);
        botNum++;
      }
      t.engine.startRound();
      sixpTouch(t);
      sixpBroadcastTable(t);
      io.emit('sixp_roomList', sixpPublicTableList());
    });
  });

  socket.on('sixp_placeBid', ({ bid }) => {
    withSixpTable((t, pos) => { t.engine.placeBid(pos, bid); sixpTouch(t); });
  });

  socket.on('sixp_chooseTrump', ({ suit, hiddenCard }) => {
    withSixpTable((t, pos) => { t.engine.chooseTrump(pos, suit, hiddenCard); sixpTouch(t); });
  });

  socket.on('sixp_callTrump', () => {
    withSixpTable((t, pos) => { t.engine.callTrump(pos); sixpTouch(t); });
  });

  socket.on('sixp_playCard', ({ card }) => {
    withSixpTable((t, pos) => {
      const result = t.engine.playCard(pos, card);
      if (!result.ok) socket.emit('sixp_actionError', { reason: result.reason });
      sixpTouch(t);
    });
  });

  socket.on('sixp_playHiddenTrump', () => {
    withSixpTable((t, pos) => { t.engine.playHiddenTrump(pos); sixpTouch(t); });
  });

  socket.on('sixp_continueRound', () => {
    withSixpTable((t) => {
      if (t.hostPlayerId !== sixpPlayerId) return;
      if (t.engine.phase !== 'roundEnd') return;
      if (t.engine.gameOver) return;
      t.engine.startRound();
      sixpTouch(t);
      sixpBroadcastTable(t);
    });
  });

  // Any seated player can signal their teammates between rounds -- not
  // host-restricted, since this is between teammates, not a table-admin
  // action.
  socket.on('sixp_sendPartnerSignal', ({ signal }) => {
    withSixpTable((t, pos) => {
      if (pos === null || pos === undefined) return;
      if (t.engine.phase !== 'roundEnd') return;
      t.engine.sendPartnerSignal(pos, signal);
      sixpTouch(t);
      sixpBroadcastTable(t);
    });
  });

  socket.on('sixp_restartGame', () => {
    withSixpTable((t) => {
      if (t.hostPlayerId !== sixpPlayerId) return;
      t.engine.restartGame();
      sixpTouch(t);
      sixpBroadcastTable(t);
    });
  });

  socket.on('sixp_restartRound', () => {
    withSixpTable((t) => {
      if (t.hostPlayerId !== sixpPlayerId) return;
      t.engine.restartRound();
      sixpTouch(t);
      sixpBroadcastTable(t);
    });
  });

  socket.on('sixp_kickPlayer', ({ pos }) => {
    withSixpTable((t) => {
      if (t.hostPlayerId !== sixpPlayerId) return;
      const seat = t.engine.seats[pos];
      const kickedPlayerId = seat ? seat.playerId : null;
      t.engine.kickPlayer(pos);
      if (kickedPlayerId) {
        for (const [sockId, info] of t.sockets) {
          if (info.playerId === kickedPlayerId) {
            const kickedSocket = io.sockets.sockets.get(sockId);
            if (kickedSocket) kickedSocket.emit('sixp_kicked');
            t.sockets.delete(sockId);
          }
        }
        delete sixpPlayerIndex[kickedPlayerId];
      }
      sixpTouch(t);
      sixpBroadcastTable(t);
    });
  });

  // Host-only: swap which named bot is playing a seat, same safety
  // guarantee as the 4-player version — only the name string changes.
  socket.on('sixp_changeBotName', ({ pos, newName }) => {
    withSixpTable((t) => {
      if (t.hostPlayerId !== sixpPlayerId) return;
      const result = t.engine.renameBotSeat(pos, newName);
      if (!result.ok) { socket.emit('sixp_actionError', result); return; }
      sixpTouch(t);
      sixpBroadcastTable(t);
    });
  });

  socket.on('sixp_leaveTable', () => {
    withSixpTable((t, pos) => {
      t.sockets.delete(socket.id);
      t.engine.markConnected(pos, false);
      sixpTouch(t);
      sixpBroadcastTable(t);
      if (!t.engine.seats.some(Boolean)) delete sixpTables[sixpTableId];
      else sixpScheduleNoHumanShutdown(t, sixpTableId);
      io.emit('sixp_roomList', sixpPublicTableList());
    });
    sixpTableId = null;
  });

  socket.on('disconnect', () => {
    const t = sixpTables[sixpTableId];
    if (!t) return;
    const info = t.sockets.get(socket.id);
    if (!info) return;
    t.sockets.delete(socket.id);
    if (t.engine.seats[info.pos]) {
      t.engine.markConnected(info.pos, false);
      if (t.hostPlayerId === info.playerId) {
        const newHostSeat = t.engine.seats.find(s => s && !s.isBot && s.connected && s.playerId !== info.playerId);
        if (newHostSeat) {
          t.hostPlayerId = newHostSeat.playerId;
          t.engine.addLog(`${newHostSeat.name} is now the host.`);
        } else {
          t.hostPlayerId = null;
          t.engine.addLog(`The host disconnected — the table is being kept open, and whoever joins next becomes host.`);
        }
      }
      sixpTouch(t);
      sixpBroadcastTable(t);
    }
    if (!t.engine.seats.some(Boolean)) {
      delete sixpTables[sixpTableId];
    } else {
      sixpScheduleNoHumanShutdown(t, sixpTableId);
    }
    io.emit('sixp_roomList', sixpPublicTableList());
  });
});

// ============================================================
// 56 — LOBBY-AWARE STATE SYNC RELAY
// ============================================================
// public/56.html is still the user's own original file, completely
// unmodified in its actual game logic (bidding, dealing, play, scoring,
// bot AI all still run 100% client-side, exactly as written). What this
// block adds is everything AROUND that: table discovery, requesting to
// join a table (gated by host approval), picking a seat (including
// replacing a bot), host-only kick, automatic host handoff if the host
// leaves, and a 5-minute-idle "still playing?" warning before a table
// closes. None of that is game logic — it's connection/session
// management, same category of thing as the equivalent features on the
// 4-player and 6-player 28 tables elsewhere in this file.
//
// The actual in-game state (seats, hands, bids, tricks, scores) is still
// exactly the same single JSON blob the client already builds via
// newRoomState()/render(state) — this server just stores that blob per
// room code and pushes it to everyone in the room whenever it changes,
// the same as before. The only NEW thing the server actually looks
// inside the blob for is `seats` and `phase`, purely to answer "how many
// people are at this table / has it started" for the room list — it
// still has zero opinion about what a legal bid or a legal card is.
// ============================================================
const l56Rooms = {}; // code -> { state, lastActivityAt, hostPlayerId, creatorName, sockets, pendingRequests, stillPlayingTimer }

// Global, admin-controlled: whether the 👁 "reveal all hands" testing
// button shows up at all in the 56 game (single site-wide switch, same
// pattern as the 4p/6p room cap).
// Defaults to DISABLED (hidden for everyone) — the admin has to
// explicitly turn it on for it to show up at all.
let reveal56Disabled = true;

function newL56Id() { return crypto.randomBytes(4).toString('hex').toUpperCase(); }
function l56SocketRoom(code) { return 'l56_' + code; }

function l56PublicList() {
  return Object.entries(l56Rooms).map(([code, r]) => {
    const seats = (r.state && r.state.seats) || [];
    const players = seats.filter(Boolean).length;
    const phase = (r.state && r.state.phase) || 'lobby';
    return {
      code,
      name: r.creatorName || 'Table',
      players,
      seats: 6,
      isPlaying: phase !== 'lobby',
      full: players >= 6
    };
  }).filter(r => r.players > 0);
}

function l56Broadcast(code) {
  const r = l56Rooms[code];
  if (!r) return;
  // Server-initiated mutations (kick, host reassignment on disconnect)
  // still need a fresh updatedAt, or the client's own "is this actually
  // a new state?" dedup check in pollLoop() will silently ignore the
  // push since the timestamp looks unchanged.
  if (r.state) r.state.updatedAt = Date.now();
  io.to(l56SocketRoom(code)).emit('sync56_state', { room: code, state: r.state });
  io.emit('l56_roomList', l56PublicList());
}

function l56Touch(r) {
  r.lastActivityAt = Date.now();
  if (r.stillPlayingTimer) {
    clearTimeout(r.stillPlayingTimer);
    r.stillPlayingTimer = null;
    io.to(l56SocketRoom(r.code)).emit('l56_stillPlayingResolved');
  }
}

// Picks the next host when the current one disconnects/leaves: lowest
// seat index that's a currently-connected human. If nobody qualifies,
// the room is left without a host until someone (re)connects — kick
// and approval actions just have no effect until then, nothing crashes.
function l56ReassignHost(r) {
  if (!r.state || !r.state.seats) { r.hostPlayerId = null; l56CheckNoHumanTimer(r); return; }
  let best = null;
  for (const [, info] of r.sockets) {
    if (info.pos == null || info.pos < 0) continue;
    const seat = r.state.seats[info.pos];
    if (!seat || seat.bot) continue;
    if (best === null || info.pos < best.pos) best = info;
  }
  r.hostPlayerId = best ? best.playerId : null;
  if (r.state) r.state.hostPlayerId = r.hostPlayerId;
  l56CheckNoHumanTimer(r);
}

const L56_NO_HUMAN_TIMEOUT_MS = 30 * 60 * 1000;
// A table with no connected human host is just bots playing each other for
// no one -- give a real person 30 minutes to claim a seat (which makes
// them host automatically) before the table closes itself. IMPORTANT:
// this only applies in the lobby, before anything valuable is at stake.
// Once a game is actually underway, a disconnected host might just be a
// backgrounded mobile tab (very common) rather than someone who's
// actually left -- closing their live game out from under them is worse
// than leaving a hostless table running for a while. Mid-game, the
// existing general idle timer (which warns everyone first) is the
// backstop instead.
function l56CheckNoHumanTimer(r) {
  if (r.hostPlayerId || (r.state && r.state.phase && r.state.phase !== 'lobby')) {
    if (r.noHumanTimer) { clearTimeout(r.noHumanTimer); r.noHumanTimer = null; }
    return;
  }
  if (r.noHumanTimer) return; // already counting down
  const code = r.code;
  r.noHumanTimer = setTimeout(() => {
    const stillThere = l56Rooms[code];
    if (!stillThere) return;
    stillThere.noHumanTimer = null;
    if (stillThere.hostPlayerId) return; // someone claimed it in the meantime
    if (stillThere.state && stillThere.state.phase && stillThere.state.phase !== 'lobby') return; // a game started while we waited -- leave it alone
    console.log(`[56 lobby] closing table ${code} — no human host within 30 minutes`);
    io.to(l56SocketRoom(code)).emit('l56_tableClosed', { reason: 'no_host' });
    delete l56Rooms[code];
    io.emit('l56_roomList', l56PublicList());
  }, L56_NO_HUMAN_TIMEOUT_MS);
}

const L56_IDLE_LIMIT_MS = 30 * 60 * 1000;
const L56_STILL_PLAYING_COUNTDOWN_MS = 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const code of Object.keys(l56Rooms)) {
    const r = l56Rooms[code];
    if (r.stillPlayingTimer) continue; // already mid-countdown
    if (now - r.lastActivityAt <= L56_IDLE_LIMIT_MS) continue;
    io.to(l56SocketRoom(code)).emit('l56_stillPlayingCheck', { seconds: L56_STILL_PLAYING_COUNTDOWN_MS / 1000 });
    r.stillPlayingTimer = setTimeout(() => {
      const stillThere = l56Rooms[code];
      if (!stillThere) return;
      stillThere.stillPlayingTimer = null;
      console.log(`[56 lobby] closing idle table ${code} — nobody confirmed still playing`);
      io.to(l56SocketRoom(code)).emit('l56_tableClosed', { reason: 'idle' });
      delete l56Rooms[code];
      io.emit('l56_roomList', l56PublicList());
    }, L56_STILL_PLAYING_COUNTDOWN_MS);
  }
}, 30 * 1000);

io.on('connection', (socket) => {
  socket.data.l56 = null; // { code, playerId, pos }

  socket.emit('reveal56Policy', { disabled: reveal56Disabled });
  socket.on('admin56SetRevealDisabled', ({ adminPassword, disabled }) => {
    if (adminPassword !== ADMIN_SECRET) { socket.emit('adminActionResult', { ok: false, action: 'reveal56', reason: 'wrong_password' }); return; }
    reveal56Disabled = !!disabled;
    io.emit('reveal56Policy', { disabled: reveal56Disabled });
    socket.emit('adminActionResult', { ok: true, action: 'reveal56' });
    console.log(`[admin] 56 reveal button ${reveal56Disabled ? 'disabled' : 'enabled'}`);
  });

  socket.on('l56_listRooms', () => { socket.emit('l56_roomList', l56PublicList()); });

  socket.on('l56_createTable', ({ name }) => {
    if (roomCapEnabled && totalActiveRooms() >= roomCapMax) {
      socket.emit('createBlocked', { maxRooms: roomCapMax });
      return;
    }
    const code = newL56Id();
    const playerId = newId();
    const r = {
      code, state: null, lastActivityAt: Date.now(),
      hostPlayerId: playerId, creatorName: name || 'Player',
      sockets: new Map(), pendingRequests: new Map(), stillPlayingTimer: null
    };
    r.sockets.set(socket.id, { playerId, pos: 0, name: name || 'Player' });
    l56Rooms[code] = r;
    socket.join(l56SocketRoom(code));
    socket.data.l56 = { code, playerId, pos: 0 };
    socket.emit('l56_created', { code, playerId, pos: 0, isHost: true });
    io.emit('l56_roomList', l56PublicList());
    console.log(`[56 lobby] table ${code} created by ${name}`);
  });

  // Reconnect path: a known token pointing at a seat that's still there.
  socket.on('l56_reconnect', ({ code, playerId, name }) => {
    const r = l56Rooms[code];
    if (!r || !r.state) { socket.emit('l56_reconnectFailed'); return; }
    const pos = (r.state.seats || []).findIndex(s => s && s.playerId === playerId);
    if (pos === -1) { socket.emit('l56_reconnectFailed'); return; }
    r.sockets.set(socket.id, { playerId, pos, name: name || r.state.seats[pos].name });
    if (r.state.seats[pos]) r.state.seats[pos].connected = true;
    socket.join(l56SocketRoom(code));
    socket.data.l56 = { code, playerId, pos };
    if (!r.hostPlayerId) l56ReassignHost(r);
    const isHost = r.hostPlayerId === playerId;
    socket.emit('l56_created', { code, playerId, pos, isHost });
    l56Touch(r);
    l56Broadcast(code);
  });

  socket.on('l56_requestJoin', ({ code, name }) => {
    const r = l56Rooms[code];
    if (!r) { socket.emit('l56_joinDenied', { reason: 'not_found' }); return; }
    const seats = (r.state && r.state.seats) || [];
    const openSeats = seats.map((s, i) => s ? null : i).filter(i => i !== null);
    const botSeats = seats.map((s, i) => (s && s.bot) ? i : null).filter(i => i !== null);
    const hostSeat = seats.findIndex(s => s && s.playerId === r.hostPlayerId);
    const hostName = hostSeat !== -1 ? seats[hostSeat].name : null;
    if (openSeats.length === 0 && botSeats.length === 0) {
      socket.emit('l56_joinDenied', { reason: 'full' });
      return;
    }
    const reqId = newId();
    r.pendingRequests.set(reqId, { socketId: socket.id, name: name || 'Player' });
    let hostSocketId = null;
    for (const [sockId, info] of r.sockets) if (info.playerId === r.hostPlayerId) hostSocketId = sockId;
    if (!hostSocketId) {
      // No host currently connected -- don't make someone wait forever
      // for a popup nobody can answer; let them straight through to the
      // seat picker instead.
      r.pendingRequests.delete(reqId);
      socket.emit('l56_joinApproved', { code, openSeats, botSeats, hostSeat, hostName });
      return;
    }
    const hostSocket = io.sockets.sockets.get(hostSocketId);
    if (hostSocket) hostSocket.emit('l56_joinRequest', { reqId, code, name: name || 'Player', openSeats, botSeats });
    socket.emit('l56_joinPending');
  });

  socket.on('l56_respondJoinRequest', ({ code, reqId, approved }) => {
    const r = l56Rooms[code];
    if (!r || !r.pendingRequests.has(reqId)) return;
    const info = socket.data.l56;
    if (!info || info.code !== code || r.hostPlayerId !== info.playerId) return; // only the host may respond
    const reqInfo = r.pendingRequests.get(reqId);
    r.pendingRequests.delete(reqId);
    const reqSocket = io.sockets.sockets.get(reqInfo.socketId);
    if (!reqSocket) return;
    if (!approved) { reqSocket.emit('l56_joinDenied', { reason: 'host_declined' }); return; }
    const seats = (r.state && r.state.seats) || [];
    const openSeats = seats.map((s, i) => s ? null : i).filter(i => i !== null);
    const botSeats = seats.map((s, i) => (s && s.bot) ? i : null).filter(i => i !== null);
    const hostSeat = seats.findIndex(s => s && s.playerId === r.hostPlayerId);
    const hostName = hostSeat !== -1 ? seats[hostSeat].name : null;
    reqSocket.emit('l56_joinApproved', { code, openSeats, botSeats, hostSeat, hostName });
  });

  // Purely for lobby bookkeeping (who's connected, at which seat) -- the
  // actual seat assignment in the shared state blob is written by the
  // client itself via the existing saveState(), same as it always was.
  socket.on('l56_claimSeat', ({ code, pos, playerId, name }) => {
    const r = l56Rooms[code];
    if (!r) return;
    r.sockets.set(socket.id, { playerId, pos, name });
    socket.join(l56SocketRoom(code));
    socket.data.l56 = { code, playerId, pos };
    const hadHost = !!r.hostPlayerId;
    if (!hadHost) l56ReassignHost(r);
    l56Touch(r);
    // If this claim just made someone the new host, everyone (including
    // the joiner, whose own optimistic save happened before the server
    // could react) needs the corrected state pushed to them right away.
    if (!hadHost && r.hostPlayerId) l56Broadcast(code);
  });

  socket.on('l56_kick', ({ code, pos }) => {
    const r = l56Rooms[code];
    if (!r || !r.state || !r.state.seats) return;
    const info = socket.data.l56;
    if (!info || info.code !== code || r.hostPlayerId !== info.playerId) return; // host-only
    const seat = r.state.seats[pos];
    if (!seat) return;
    const kickedPlayerId = seat.playerId;
    if (r.state.phase === 'lobby') {
      r.state.seats[pos] = null;
    } else {
      r.state.seats[pos] = { name: seat.name, bot: true };
    }
    for (const [sockId, sInfo] of r.sockets) {
      if (sInfo.playerId === kickedPlayerId) {
        const kSocket = io.sockets.sockets.get(sockId);
        if (kSocket) kSocket.emit('l56_kicked');
        r.sockets.delete(sockId);
      }
    }
    if (r.hostPlayerId === kickedPlayerId) l56ReassignHost(r);
    l56Touch(r);
    l56Broadcast(code);
  });

  socket.on('l56_stillPlaying', ({ code }) => {
    const r = l56Rooms[code];
    if (r) l56Touch(r);
  });

  socket.on('l56_chat', ({ msg }) => {
    const info = socket.data.l56;
    if (!info) return;
    const r = l56Rooms[info.code];
    if (!r) return;
    const trimmed = String(msg || '').slice(0, 300).trim();
    if (!trimmed) return;
    const seat = r.state && r.state.seats && r.state.seats[info.pos];
    const name = seat ? seat.name : 'Player';
    io.to(l56SocketRoom(info.code)).emit('l56_chat', { from: name, msg: trimmed, senderId: socket.id });
    l56Touch(r);
  });

  socket.on('l56_leaveTable', ({ code }) => {
    const r = l56Rooms[code];
    if (!r) return;
    const info = r.sockets.get(socket.id);
    r.sockets.delete(socket.id);
    socket.leave(l56SocketRoom(code));
    if (info && r.hostPlayerId === info.playerId) l56ReassignHost(r);
    socket.data.l56 = null;
    l56Touch(r);
    l56Broadcast(code);
  });

  // ---------------- Shared state blob sync (unchanged mechanics) ----------------
  socket.on('sync56_join', ({ room }) => {
    if (!room || typeof room !== 'string') return;
    const code = room.trim().toUpperCase().slice(0, 20);
    socket.join(l56SocketRoom(code));
    const r = l56Rooms[code];
    socket.emit('sync56_state', { room: code, state: r ? r.state : null });
  });

  socket.on('sync56_load', ({ room }, ack) => {
    if (typeof ack !== 'function') return;
    if (!room || typeof room !== 'string') { ack(null); return; }
    const code = room.trim().toUpperCase().slice(0, 20);
    const r = l56Rooms[code];
    ack(r ? r.state : null);
  });

  socket.on('sync56_save', ({ room, state }) => {
    if (!room || typeof room !== 'string') return;
    const code = room.trim().toUpperCase().slice(0, 20);
    let r = l56Rooms[code];
    if (!r) {
      // Extremely rare race (room deleted between create and first save) --
      // recreate a minimal entry rather than silently dropping the save.
      r = l56Rooms[code] = { code, state: null, lastActivityAt: Date.now(), hostPlayerId: null, creatorName: 'Player', sockets: new Map(), pendingRequests: new Map(), stillPlayingTimer: null };
    }
    r.state = state;
    if (r.hostPlayerId && (!state.hostPlayerId)) state.hostPlayerId = r.hostPlayerId;
    l56Touch(r);
    io.to(l56SocketRoom(code)).emit('sync56_state', { room: code, state });
    io.emit('l56_roomList', l56PublicList());
  });

  socket.on('sync56_leave', ({ room }) => {
    if (!room) return;
    socket.leave(l56SocketRoom(room.trim().toUpperCase().slice(0, 20)));
  });

  socket.on('disconnect', (reason) => {
    const info = socket.data.l56;
    if (!info) return;
    const r = l56Rooms[info.code];
    if (!r) return;
    console.log(`[56] socket ${socket.id} disconnected from table ${info.code} (seat ${info.pos}), reason: ${reason}`);
    r.sockets.delete(socket.id);
    if (r.state && r.state.seats && r.state.seats[info.pos] && r.state.seats[info.pos].playerId === info.playerId) {
      // Silent drop: keep the seat (same reconnect-friendly behavior as
      // the other tables) -- just mark it disconnected so the host
      // badge / UI can show it, but don't free the seat outright.
      r.state.seats[info.pos].connected = false;
    }
    if (r.hostPlayerId === info.playerId) l56ReassignHost(r);
    l56Touch(r);
    l56Broadcast(info.code);
  });
});

// ============================================================
// TEXAS HOLD'EM (9-seat, Zynga-style) -- fully isolated from every
// other game in this file, same spirit as the 6-player/56 sections:
// nothing in here can affect any other table type, and nothing
// elsewhere can affect this.
// ============================================================
const { PokerEngine, SEATS: POKER_SEATS } = require('./poker-engine');
const { botAct: pokerBotAct } = require('./poker-bot');

const pokerTables = {};

function newPokerTableId() { return 'P' + crypto.randomBytes(4).toString('hex').toUpperCase(); }

function pokerPublicTableList() {
  return Object.values(pokerTables)
    .filter(t => t.engine.seats.some(Boolean))
    .map(t => ({
      tableId: t.engine.tableId, name: t.name, mode: t.engine.mode,
      smallBlind: t.engine.smallBlind, bigBlind: t.engine.bigBlind,
      players: t.engine.occupiedSeats().length,
      openSeats: POKER_SEATS - t.engine.occupiedSeats().length,
      isPlaying: t.engine.phase !== 'lobby'
    }));
}

function pokerBroadcast(t) {
  for (const [socketId, info] of t.sockets) {
    const sock = io.sockets.sockets.get(socketId);
    if (!sock) continue;
    const state = t.engine.getStateFor(info.pos);
    state.isHost = (info.playerId === t.hostPlayerId);
    sock.emit('poker_state', state);
  }
  io.emit('poker_roomList', pokerPublicTableList());
}

function pokerTouch(t) { t.lastActivityAt = Date.now(); }

// Bots act on a short, human-feeling delay, same pacing pattern as the
// other games. Re-arms itself after every broadcast as long as it's
// still a bot's turn -- if a human's turn comes up, it naturally stops
// and waits for their actual input instead.
function pokerMaybeBotAct(t) {
  const p = t.engine.currentPlayer;
  if (p === -1) return;
  const seat = t.engine.seats[p];
  if (!seat || !seat.isBot || t.engine.phase === 'handEnd' || t.engine.phase === 'lobby') return;
  setTimeout(() => {
    if (!pokerTables[t.engine.tableId]) return; // table closed in the meantime
    if (t.engine.currentPlayer !== p) return; // already moved on somehow
    pokerBotAct(t.engine, p);
    pokerTouch(t);
    pokerBroadcast(t);
    // This was the actual bug behind "table freezes after a few rounds":
    // if THIS bot action is what ends the hand (e.g. it's the fold that
    // leaves one player standing, or the call that completes the last
    // betting round into showdown), nothing was scheduling the next
    // deal -- that only ever happened from the human poker_act handler.
    // Whenever a bot happened to be the one whose action closed out a
    // hand, the table would sit at handEnd forever. Same handling as
    // poker_act now applies here too.
    if (t.engine.phase === 'handEnd') pokerMaybeAutoDeal(t);
    else pokerMaybeBotAct(t);
  }, 900 + Math.random() * 700);
}

// Auto-deals the next hand a couple seconds after one ends, as long as
// there are still at least 2 players with chips (or waiting to reload)
// -- keeps the table moving without needing a manual "continue" click
// every single hand, the way a real cash game would just keep going.
function pokerMaybeAutoDeal(t) {
  if (t.engine.phase !== 'handEnd') return;
  setTimeout(() => {
    if (!pokerTables[t.engine.tableId]) return;
    if (t.engine.phase !== 'handEnd') return;
    t.engine.checkReloads();
    t.engine.startHand();
    pokerTouch(t);
    pokerBroadcast(t);
    pokerMaybeBotAct(t);
  }, 3000);
}

// Background reload-timer sweep -- catches a player whose 1-minute wait
// finished while nobody happened to trigger a state change in the
// meantime (e.g. everyone else stepped away too).
setInterval(() => {
  for (const t of Object.values(pokerTables)) {
    const before = JSON.stringify(t.engine.seats.map(s => s && s.chips));
    t.engine.checkReloads();
    const after = JSON.stringify(t.engine.seats.map(s => s && s.chips));
    if (before !== after) { pokerTouch(t); pokerBroadcast(t); }
  }
}, 5000);

io.on('connection', (socket) => {
  let pokerTableId = null;
  let pokerPlayerId = null;

  function withPokerTable(fn) {
    const t = pokerTables[pokerTableId];
    if (!t) return;
    const info = t.sockets.get(socket.id);
    if (!info) return;
    fn(t, info.pos);
  }

  socket.on('poker_listRooms', () => socket.emit('poker_roomList', pokerPublicTableList()));

  socket.on('poker_createTable', ({ name, mode, buyInType, smallBlind, bigBlind, startingChips, reloadChips }) => {
    const tableId = newPokerTableId();
    const engine = new PokerEngine(tableId, {
      mode: mode === 'tournament' ? 'tournament' : 'cash',
      buyInType: buyInType === 'fixed' ? 'fixed' : 'nolimit',
      smallBlind: Math.max(1, Math.min(1000, Number.isFinite(Number(smallBlind)) && smallBlind !== undefined ? Number(smallBlind) : 5)),
      bigBlind: Math.max(2, Math.min(2000, Number.isFinite(Number(bigBlind)) && bigBlind !== undefined ? Number(bigBlind) : 10)),
      startingChips: Math.max(100, Math.min(1000000, Number.isFinite(Number(startingChips)) && startingChips !== undefined ? Number(startingChips) : 1000)),
      reloadChips: Math.max(0, Math.min(1000000, Number.isFinite(Number(reloadChips)) && reloadChips !== undefined ? Number(reloadChips) : 500))
    });
    const playerId = crypto.randomBytes(8).toString('hex');
    engine.seatHuman(0, String(name || 'Host').slice(0, 20), playerId);
    const t = {
      engine, name: `${name || 'Host'}'s table`, hostPlayerId: playerId,
      sockets: new Map(), lastActivityAt: Date.now()
    };
    pokerTables[tableId] = t;
    t.sockets.set(socket.id, { pos: 0, playerId });
    pokerTableId = tableId; pokerPlayerId = playerId;
    socket.join('poker_' + tableId);
    socket.emit('poker_joined', { tableId, pos: 0, playerId, isHost: true });
    pokerBroadcast(t);
  });

  socket.on('poker_joinTable', ({ tableId, name, playerId: existingPlayerId, pos: requestedPos }) => {
    const t = pokerTables[tableId];
    if (!t) { socket.emit('poker_joinFailed', { reason: 'not_found' }); return; }

    // Reconnect: same playerId claiming their existing seat back.
    if (existingPlayerId) {
      const existingPos = t.engine.seats.findIndex(s => s && s.playerId === existingPlayerId);
      if (existingPos >= 0) {
        t.engine.seats[existingPos].connected = true;
        t.sockets.set(socket.id, { pos: existingPos, playerId: existingPlayerId });
        pokerTableId = tableId; pokerPlayerId = existingPlayerId;
        socket.join('poker_' + tableId);
        // A vacant host slot goes to whoever's the first human to
        // actually show up.
        if (!t.hostPlayerId) {
          t.hostPlayerId = existingPlayerId;
          t.engine.addLog(`${t.engine.seats[existingPos].name} is now the host.`);
        }
        socket.emit('poker_joined', { tableId, pos: existingPos, playerId: existingPlayerId, isHost: existingPlayerId === t.hostPlayerId });
        pokerTouch(t);
        pokerBroadcast(t);
        return;
      }
    }

    const openSeats = t.engine.seats.map((s, i) => s ? null : i).filter(i => i !== null);
    const botSeats = t.engine.seats.map((s, i) => (s && s.isBot) ? i : null).filter(i => i !== null);
    // A seat left behind by a human who disconnected and never came back
    // is neither "open" (the seat object is still there) nor a "bot
    // seat" -- without this, that seat was simply unreachable forever,
    // and once every seat at a table had been through this once, no new
    // player could ever join even though half the table might be
    // sitting there abandoned. Offered as a fallback the same way a bot
    // seat already was, same spirit as the 4p/6p tables' handling of
    // reclaiming a disconnected player's seat.
    const ghostSeats = t.engine.seats.map((s, i) => (s && !s.isBot && !s.connected) ? i : null).filter(i => i !== null);
    let pos = (typeof requestedPos === 'number' && openSeats.includes(requestedPos)) ? requestedPos
      : (openSeats.length > 0 ? openSeats[0]
        : (typeof requestedPos === 'number' && botSeats.includes(requestedPos)) ? requestedPos
          : botSeats.length > 0 ? botSeats[0]
            : (typeof requestedPos === 'number' && ghostSeats.includes(requestedPos)) ? requestedPos
              : ghostSeats[0]);
    if (pos === undefined) { socket.emit('poker_joinFailed', { reason: 'table_full' }); return; }

    // Taking over a bot seat -- the bot is simply replaced, keeping its
    // chip stack (matches "host can kick bots out if a human joins").
    // Taking over a ghost (disconnected human) seat works the same way,
    // keeping whatever chip stack that seat had.
    if (t.engine.seats[pos] && (t.engine.seats[pos].isBot || !t.engine.seats[pos].connected)) {
      const existingChips = t.engine.seats[pos].chips;
      t.engine.removeSeat(pos);
      t.engine.seatHuman(pos, String(name || 'Player').slice(0, 20), null);
      t.engine.seats[pos].chips = existingChips;
    } else {
      t.engine.seatHuman(pos, String(name || 'Player').slice(0, 20), null);
    }
    const newPlayerId = crypto.randomBytes(8).toString('hex');
    t.engine.seats[pos].playerId = newPlayerId;
    t.sockets.set(socket.id, { pos, playerId: newPlayerId });
    pokerTableId = tableId; pokerPlayerId = newPlayerId;
    socket.join('poker_' + tableId);
    // A vacant host slot goes to whoever's the first human to actually
    // take a seat.
    if (!t.hostPlayerId) {
      t.hostPlayerId = newPlayerId;
      t.engine.addLog(`${t.engine.seats[pos].name} is now the host.`);
    }
    socket.emit('poker_joined', { tableId, pos, playerId: newPlayerId, isHost: newPlayerId === t.hostPlayerId });
    pokerTouch(t);
    pokerBroadcast(t);
  });

  socket.on('poker_fillBots', ({ count }) => {
    withPokerTable((t, pos) => {
      if (t.hostPlayerId !== pokerPlayerId) return;
      const openSeats = t.engine.seats.map((s, i) => s ? null : i).filter(i => i !== null);
      const n = Math.max(0, Math.min(openSeats.length, Number(count) || 0));
      for (let i = 0; i < n; i++) t.engine.seatBot(openSeats[i], `Bot ${openSeats[i] + 1}`);
      pokerTouch(t);
      pokerBroadcast(t);
    });
  });

  socket.on('poker_startHand', () => {
    withPokerTable((t) => {
      if (t.hostPlayerId !== pokerPlayerId) return;
      if (t.engine.phase !== 'lobby' && t.engine.phase !== 'handEnd') return;
      t.engine.startHand();
      pokerTouch(t);
      pokerBroadcast(t);
      pokerMaybeBotAct(t);
    });
  });

  socket.on('poker_act', ({ action, amount }) => {
    withPokerTable((t, pos) => {
      const result = t.engine.act(pos, action, amount);
      if (!result.ok) { socket.emit('poker_actionError', result); return; }
      pokerTouch(t);
      pokerBroadcast(t);
      if (t.engine.phase === 'handEnd') pokerMaybeAutoDeal(t);
      else pokerMaybeBotAct(t);
    });
  });

  // Host can kick anyone, but per the design it only actually applies
  // once the current hand finishes -- the engine itself enforces this
  // timing, this handler just exposes request/cancel.
  socket.on('poker_requestKick', ({ pos: kickPos }) => {
    withPokerTable((t, pos) => {
      if (t.hostPlayerId !== pokerPlayerId) return;
      t.engine.requestKick(kickPos, pokerPlayerId);
      pokerTouch(t);
      pokerBroadcast(t);
    });
  });
  socket.on('poker_cancelKick', ({ pos: kickPos }) => {
    withPokerTable((t) => {
      if (t.hostPlayerId !== pokerPlayerId) return;
      t.engine.cancelKick(kickPos);
      pokerTouch(t);
      pokerBroadcast(t);
    });
  });

  socket.on('poker_leaveTable', () => {
    withPokerTable((t, pos) => {
      t.engine.removeSeat(pos);
      t.sockets.delete(socket.id);
      socket.leave('poker_' + pokerTableId);
      pokerTouch(t);
      pokerBroadcast(t);
    });
    pokerTableId = null; pokerPlayerId = null;
  });

  socket.on('disconnect', (reason) => {
    if (!pokerTableId) return;
    const t = pokerTables[pokerTableId];
    if (!t) return;
    const info = t.sockets.get(socket.id);
    console.log(`[poker] socket ${socket.id} disconnected from table ${pokerTableId} (seat ${info ? info.pos : '?'}), reason: ${reason}`);
    t.sockets.delete(socket.id);
    if (info && t.engine.seats[info.pos] && t.engine.seats[info.pos].playerId === info.playerId) {
      // Keep the seat (reconnect-friendly, same as the other tables),
      // just mark it disconnected.
      t.engine.seats[info.pos].connected = false;
      // Host migration: hand it to another connected human if one
      // exists, one-way (not a temporary delegation). If nobody else is
      // connected, the slot goes vacant rather than staying stuck
      // pointing at someone who can no longer act -- a vacant slot lets
      // any human who shows up next (the same player, or someone brand
      // new) become host automatically instead of the table being
      // unusable until that one specific person comes back.
      if (t.hostPlayerId === info.playerId) {
        const newHostSeat = t.engine.seats.find(s => s && !s.isBot && s.connected && s.playerId !== info.playerId);
        if (newHostSeat) {
          t.hostPlayerId = newHostSeat.playerId;
          t.engine.addLog(`${newHostSeat.name} is now the host.`);
        } else {
          t.hostPlayerId = null;
          t.engine.addLog(`The host disconnected — the table is being kept open, and whoever joins next becomes host.`);
        }
      }
    }
    pokerTouch(t);
    pokerBroadcast(t);
  });
});

// Idle poker tables get cleaned up the same way the other games do.
setInterval(() => {
  const now = Date.now();
  for (const id of Object.keys(pokerTables)) {
    const t = pokerTables[id];
    if (now - t.lastActivityAt > 30 * 60 * 1000) delete pokerTables[id];
  }
}, 5 * 60 * 1000);

server.listen(PORT, () => {
  console.log(`28 Kerala Gulan authoritative server running on port ${PORT}`);
});
