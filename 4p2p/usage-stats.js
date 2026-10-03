'use strict';
// ============================================================================
// usage-stats.js  --  where does the data and the time actually go?
//
// The existing "Network usage" box shows ONE number (the container's total
// traffic). This module breaks that down, as far as it can be measured honestly:
//
//   SERVER DATA (measured on the server, byte-exact for the payloads)
//     * web files:  pages, scripts/css, avatars, other images, sounds, API, admin
//     * live traffic (Socket.IO): game traffic, text chat, voice signalling,
//       each also split per game (28, 6-player, 56, Hold'em, Spades, Carrom, Pool)
//     * "unattributed" = container total minus everything above (TLS, headers,
//       keep-alives -- the overhead that can't be assigned to a feature)
//
//   TIME (measured on the server from who is connected to what)
//     * table time per game and per table, voice time, page time (connected at
//       all) and wandering time (connected but not at a table)
//
//   VOICE AUDIO (REPORTED by players' browsers -- the audio goes phone to phone
//   or through the TURN relay, never through this server, so only the browsers
//   can count it; it is an estimate and a modified browser could misreport)
//
// Everything is stored per UTC day in one small JSON file so Today / 7 days /
// 30 days / All time can be added up. Failure-proof by design: every hook is
// wrapped so a bug here can never break a game.
// ============================================================================
const fs = require('fs');

const GAMES = ['28', '6p', '56', 'holdem', 'spades', 'carrom', 'pool', 'lobby'];
const GAME_LABEL = { '28': '28 / 4-player', '6p': '6-player', '56': '56', holdem: "Hold'em", spades: 'Spades', carrom: 'Carrom', pool: 'Pool', lobby: 'Lobby / no table' };
const MAX_DAYS = 400;
const MAX_TABLES_PER_DAY = 300;
const MAX_VOICE_REPORT_BYTES = 200 * 1024 * 1024;   // sanity cap for one report
const MAX_TICK_GAP_MS = 5 * 60 * 1000;               // never credit more than this to one gap (server asleep etc.)

function dayKey(ms) { return new Date(ms).toISOString().slice(0, 10); }
function emptyDay() {
  return {
    http: {},            // cat -> { bytes, n }
    sock: {},            // cat -> { in, out }
    sockGame: {},        // game -> { in, out }
    chat: {},            // game -> { msgs, bytes }
    time: { table: {}, voice: {}, page: 0, wander: 0, sessions: 0 },
    voice: { sent: 0, recv: 0, relaySent: 0, relayRecv: 0, reports: 0, byGame: {} },
    tables: {},          // 'game:room' -> { game, ms, bytes, joins, voiceSent, chatMsgs }
  };
}
function bump(o, k, f, n) { const x = o[k] || (o[k] = {}); x[f] = (x[f] || 0) + n; }

// ---- classification -------------------------------------------------------
function gameOfRoom(room) {
  const r = String(room || '');
  if (r.startsWith('sixp_')) return '6p';
  if (r.startsWith('l56_')) return '56';
  if (r.startsWith('carrom_')) return 'carrom';
  if (r.startsWith('poker_')) return 'holdem';
  if (r.startsWith('spades_')) return 'spades';
  if (r.startsWith('pool_')) return 'pool';
  return '28';
}
function gameOfEvent(name) {
  if (!name) return null;
  if (name.startsWith('sixp_')) return '6p';
  if (name.startsWith('l56_')) return '56';
  if (name.startsWith('carrom_')) return 'carrom';
  if (name.startsWith('poker_')) return 'holdem';
  if (name.startsWith('spades_')) return 'spades';
  if (name.startsWith('pool_')) return 'pool';
  return null;
}
function catOfEvent(name) {
  if (!name) return 'game';
  if (/^voice/i.test(name)) return 'voiceSig';
  if (/chat/i.test(name)) return 'chat';
  return 'game';
}
// "2["event",..." / "2/ns,12["event"..." / "51-["event"..." -> "event"
const EVENT_RE = /^\d(?:\d+-)?(?:\/[^,]*,)?(?:\d+)?\["([^"\\]+)"/;
function eventName(data) {
  if (typeof data !== 'string') return null;
  const m = EVENT_RE.exec(data);
  return m ? m[1] : null;
}
function catOfHttp(p, contentType) {
  const path = String(p || '').split('?')[0].toLowerCase();
  if (path.startsWith('/api/admin')) return 'admin';
  if (path.startsWith('/api/')) return 'api';
  if (path.startsWith('/images/hero-avatars/')) return 'avatars';
  const ext = (path.match(/\.([a-z0-9]+)$/) || [])[1] || '';
  if (path === '/' || ext === 'html' || ext === 'htm') return 'pages';
  if (['js', 'css', 'json', 'map', 'woff', 'woff2', 'ttf', 'otf', 'txt', 'xml'].includes(ext)) return 'scripts';
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'ico', 'avif'].includes(ext)) return 'images';
  if (['mp3', 'ogg', 'wav', 'm4a', 'aac', 'mp4', 'webm'].includes(ext)) return 'sounds';
  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('text/html')) return 'pages';
  if (ct.includes('javascript') || ct.includes('css') || ct.includes('json')) return 'scripts';
  if (ct.startsWith('image/')) return 'images';
  if (ct.startsWith('audio/') || ct.startsWith('video/')) return 'sounds';
  return 'other';
}

function createUsageStats(opts) {
  const file = opts && opts.file;
  const now = (opts && opts.now) || (() => Date.now());
  let days = {};
  let quota = null;
  let dirty = false;
  const live = new Map();               // socket id -> ctx
  let todayKey = null, today = null;

  // ---- persistence --------------------------------------------------------
  function load() {
    try {
      if (file && fs.existsSync(file)) {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (parsed && parsed.days && typeof parsed.days === 'object') days = parsed.days;
        if (parsed && parsed.quota) quota = parsed.quota;
      }
    } catch (e) { console.error('[usage-stats] could not load saved data, starting fresh:', e.message); days = {}; }
    if (!quota) {
      // Seeded from the Metered.ca dashboard the owner screenshotted: free plan, 68 MB of 0.5 GB used,
      // plan renews 27 Oct 2026. The admin page lets these be updated any time.
      quota = {
        provider: 'Metered.ca (free plan)',
        usedBytes: 68 * 1024 * 1024,
        limitBytes: 512 * 1024 * 1024,
        renewsOn: '2026-10-27',
        asOf: now(),
        relaySinceAsOf: 0,
        seeded: true,
      };
      dirty = true;
    }
  }
  function trim() {
    const keys = Object.keys(days).sort();
    while (keys.length > MAX_DAYS) delete days[keys.shift()];
    for (const k of keys) {
      const t = days[k] && days[k].tables;
      if (t && Object.keys(t).length > MAX_TABLES_PER_DAY) {
        const keep = Object.entries(t).sort((a, b) => (b[1].ms || 0) - (a[1].ms || 0)).slice(0, MAX_TABLES_PER_DAY);
        days[k].tables = Object.fromEntries(keep);
      }
    }
  }
  function save() {
    if (!dirty || !file) return;
    try { trim(); fs.writeFileSync(file, JSON.stringify({ version: 1, days, quota })); dirty = false; }
    catch (e) { console.error('[usage-stats] could not save:', e.message); }
  }

  function day(t) {
    const k = dayKey(t == null ? now() : t);
    if (k !== todayKey) { todayKey = k; today = days[k] || (days[k] = emptyDay()); }
    return today;
  }
  const tableRec = (d, ctx) => {
    const key = ctx.game + ':' + ctx.table;
    return d.tables[key] || (d.tables[key] = { game: ctx.game, ms: 0, bytes: 0, joins: 0, voiceSent: 0, chatMsgs: 0 });
  };

  // ---- HTTP (web files) ---------------------------------------------------
  function httpMiddleware(req, res, next) {
    try {
      let bytes = 0, done = false;
      const w = res.write, e = res.end;
      const count = (chunk, enc) => {
        if (!chunk || typeof chunk === 'function') return;
        bytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk), typeof enc === 'string' ? enc : 'utf8');
      };
      res.write = function (chunk, enc) { try { count(chunk, enc); } catch (_) {} return w.apply(this, arguments); };
      res.end = function (chunk, enc) { try { count(chunk, enc); } catch (_) {} return e.apply(this, arguments); };
      const finish = () => {
        if (done) return; done = true;
        try {
          const cat = catOfHttp(req.originalUrl || req.url, res.getHeader && res.getHeader('content-type'));
          const d = day();
          const x = d.http[cat] || (d.http[cat] = { bytes: 0, n: 0 });
          x.bytes += bytes; x.n += 1; dirty = true;
        } catch (_) {}
      };
      res.on('finish', finish); res.on('close', finish);
    } catch (_) {}
    next();
  }

  // ---- Socket.IO ----------------------------------------------------------
  function packetBytes(data) {
    if (typeof data === 'string') return Buffer.byteLength(data);
    if (data && typeof data.length === 'number') return data.length;
    return 0;
  }
  function onPacket(ctx, dir, packet) {
    try {
      if (!packet || packet.type !== 'message') return;
      const n = packetBytes(packet.data);
      if (!n) return;
      const ev = eventName(packet.data);
      const cat = catOfEvent(ev);
      const game = gameOfEvent(ev) || ctx.game || 'lobby';
      const d = day();
      bump(d.sock, cat, dir, n);
      bump(d.sockGame, game, dir, n);
      if (ctx.table) tableRec(d, ctx).bytes += n;
      if (dir === 'in' && cat === 'chat') {
        bump(d.chat, game, 'msgs', 1); bump(d.chat, game, 'bytes', n);
        if (ctx.table) tableRec(d, ctx).chatMsgs += 1;
      }
      dirty = true;
    } catch (_) {}
  }
  function accrue(ctx, t) {
    const dt = Math.max(0, Math.min(t - ctx.lastTick, MAX_TICK_GAP_MS));
    ctx.lastTick = t;
    if (!dt) return;
    const d = day(t);
    d.time.page += dt;
    if (ctx.table) {
      d.time.table[ctx.game] = (d.time.table[ctx.game] || 0) + dt;
      tableRec(d, ctx).ms += dt;
    } else d.time.wander += dt;
    if (ctx.voiceSince) d.time.voice[ctx.game || 'lobby'] = (d.time.voice[ctx.game || 'lobby'] || 0) + dt;
    dirty = true;
  }
  function tick() {
    const t = now();
    for (const ctx of live.values()) accrue(ctx, t);
    save();
  }
  function onJoin(ctx, room) {
    if (!room || room === ctx.id) return;
    const t = now();
    if (ctx.table === room) return;
    accrue(ctx, t);
    ctx.table = room; ctx.game = gameOfRoom(room);
    const d = day(t);
    tableRec(d, ctx).joins += 1; dirty = true;
  }
  function onLeave(ctx, room) {
    if (!room || room !== ctx.table) return;
    accrue(ctx, now());
    ctx.table = null; ctx.game = null; ctx.voiceSince = null;
  }
  function attachIo(io) {
    io.on('connection', (socket) => {
      try {
        const t = now();
        const ctx = { id: socket.id, table: null, game: null, voiceSince: null, lastTick: t, reports: [] };
        live.set(socket.id, ctx);
        day(t).time.sessions += 1; dirty = true;
        const origJoin = socket.join, origLeave = socket.leave;
        socket.join = function (rooms) {
          const r = origJoin.apply(this, arguments);
          try { (Array.isArray(rooms) ? rooms : [rooms]).forEach((x) => onJoin(ctx, x)); } catch (_) {}
          return r;
        };
        socket.leave = function (room) {
          const r = origLeave.apply(this, arguments);
          try { onLeave(ctx, room); } catch (_) {}
          return r;
        };
        if (socket.conn && typeof socket.conn.on === 'function') {
          socket.conn.on('packetCreate', (p) => onPacket(ctx, 'out', p));
          socket.conn.on('packet', (p) => onPacket(ctx, 'in', p));
        }
        socket.on('voiceStats', (rep) => { try { addVoiceReport(ctx, rep); } catch (_) {} });
        socket.on('disconnect', () => { try { accrue(ctx, now()); live.delete(socket.id); } catch (_) {} });
      } catch (e) { console.error('[usage-stats] attach failed for a socket:', e.message); }
    });
  }
  function voiceJoined(socket) { const c = socket && live.get(socket.id); if (c) { accrue(c, now()); c.voiceSince = now(); } }
  function voiceLeft(socket) { const c = socket && live.get(socket.id); if (c) { accrue(c, now()); c.voiceSince = null; } }

  // ---- voice audio, reported by the player's own browser -------------------
  function addVoiceReport(ctx, rep) {
    if (!rep || typeof rep !== 'object') return;
    const t = now();
    // at most ~8 reports a minute per connection (a normal client sends 2)
    ctx.reports = ctx.reports.filter((x) => t - x < 60000);
    if (ctx.reports.length >= 8) return;
    ctx.reports.push(t);
    const num = (v) => { v = Number(v); return Number.isFinite(v) && v >= 0 ? Math.min(v, MAX_VOICE_REPORT_BYTES) : 0; };
    const sent = num(rep.sent), recv = num(rep.recv), relaySent = Math.min(num(rep.relaySent), sent), relayRecv = Math.min(num(rep.relayRecv), recv);
    if (!sent && !recv) return;
    const d = day(t);
    d.voice.sent += sent; d.voice.recv += recv; d.voice.relaySent += relaySent; d.voice.relayRecv += relayRecv; d.voice.reports += 1;
    const g = ctx.game || 'lobby';
    bump(d.voice.byGame, g, 'sent', sent); bump(d.voice.byGame, g, 'recv', recv);
    bump(d.voice.byGame, g, 'relay', relaySent + relayRecv);
    if (ctx.table) tableRec(d, ctx).voiceSent += sent;
    // running estimate for the TURN-relay quota note (relayed audio passes through the relay both ways)
    if (quota) quota.relaySinceAsOf = (quota.relaySinceAsOf || 0) + relaySent + relayRecv;
    dirty = true;
  }

  // ---- TURN quota note (typed in from the provider's dashboard) -------------
  function getQuota() { return Object.assign({}, quota); }
  function setQuota(q) {
    q = q || {};
    const n = (v, d) => { v = Number(v); return Number.isFinite(v) && v >= 0 ? v : d; };
    const renews = /^\d{4}-\d{2}-\d{2}$/.test(String(q.renewsOn || '')) ? String(q.renewsOn) : quota.renewsOn;
    quota = {
      provider: String(q.provider || quota.provider || 'TURN relay').slice(0, 60),
      usedBytes: n(q.usedBytes, quota.usedBytes),
      limitBytes: n(q.limitBytes, quota.limitBytes) || quota.limitBytes,
      renewsOn: renews,
      asOf: now(),
      relaySinceAsOf: 0,                    // a fresh reading from the dashboard restarts the running estimate
    };
    dirty = true; save();
    return getQuota();
  }
  // next renewal date on/after today (renewals repeat on the same day each month)
  function nextRenewal(renewsOn, t) {
    const [y, m, d] = renewsOn.split('-').map(Number);
    let dt = new Date(Date.UTC(y, m - 1, d));
    const todayMs = Date.UTC(new Date(t).getUTCFullYear(), new Date(t).getUTCMonth(), new Date(t).getUTCDate());
    let guard = 0;
    while (dt.getTime() < todayMs && guard++ < 240) dt = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, d));
    return dt;
  }

  // ---- report for the admin page -------------------------------------------
  function datesFor(range, t) {
    const all = Object.keys(days).sort();
    if (range === 'all') return all;
    const n = range === '30d' ? 30 : range === '7d' ? 7 : 1;
    const out = [];
    for (let i = 0; i < n; i++) out.push(dayKey(t - i * 86400000));
    return out.reverse();
  }
  function report(range, networkDays) {
    range = ['today', '7d', '30d', 'all'].includes(range) ? range : 'today';
    const t = now();
    day(t); // make sure today's bucket exists and live time is current
    for (const ctx of live.values()) accrue(ctx, t);
    const dates = datesFor(range, t);
    const sum = {
      http: {}, sock: {}, sockGame: {}, chat: {},
      time: { table: {}, voice: {}, page: 0, wander: 0, sessions: 0 },
      voice: { sent: 0, recv: 0, relaySent: 0, relayRecv: 0, reports: 0, byGame: {} },
    };
    const tables = {};
    for (const k of dates) {
      const d = days[k]; if (!d) continue;
      for (const [c, v] of Object.entries(d.http || {})) { bump(sum.http, c, 'bytes', v.bytes); bump(sum.http, c, 'n', v.n); }
      for (const [c, v] of Object.entries(d.sock || {})) { bump(sum.sock, c, 'in', v.in || 0); bump(sum.sock, c, 'out', v.out || 0); }
      for (const [g, v] of Object.entries(d.sockGame || {})) { bump(sum.sockGame, g, 'in', v.in || 0); bump(sum.sockGame, g, 'out', v.out || 0); }
      for (const [g, v] of Object.entries(d.chat || {})) { bump(sum.chat, g, 'msgs', v.msgs || 0); bump(sum.chat, g, 'bytes', v.bytes || 0); }
      for (const [g, ms] of Object.entries((d.time || {}).table || {})) sum.time.table[g] = (sum.time.table[g] || 0) + ms;
      for (const [g, ms] of Object.entries((d.time || {}).voice || {})) sum.time.voice[g] = (sum.time.voice[g] || 0) + ms;
      sum.time.page += (d.time || {}).page || 0; sum.time.wander += (d.time || {}).wander || 0; sum.time.sessions += (d.time || {}).sessions || 0;
      const v = d.voice || {};
      sum.voice.sent += v.sent || 0; sum.voice.recv += v.recv || 0; sum.voice.relaySent += v.relaySent || 0; sum.voice.relayRecv += v.relayRecv || 0; sum.voice.reports += v.reports || 0;
      for (const [g, x] of Object.entries(v.byGame || {})) { bump(sum.voice.byGame, g, 'sent', x.sent || 0); bump(sum.voice.byGame, g, 'recv', x.recv || 0); bump(sum.voice.byGame, g, 'relay', x.relay || 0); }
      for (const [key, x] of Object.entries(d.tables || {})) {
        const m = tables[key] || (tables[key] = { key, game: x.game, ms: 0, bytes: 0, joins: 0, voiceSent: 0, chatMsgs: 0 });
        m.ms += x.ms || 0; m.bytes += x.bytes || 0; m.joins += x.joins || 0; m.voiceSent += x.voiceSent || 0; m.chatMsgs += x.chatMsgs || 0;
      }
    }
    const sumObj = (o, f) => Object.values(o).reduce((s, x) => s + (x[f] || 0), 0);
    const httpBytes = sumObj(sum.http, 'bytes');
    const sockIn = sumObj(sum.sock, 'in'), sockOut = sumObj(sum.sock, 'out');
    const attributed = httpBytes + sockIn + sockOut;
    const containerBytes = (networkDays || []).filter((x) => dates.includes(x.date)).reduce((s, x) => s + (x.bytes || 0), 0);
    const games = GAMES.map((g) => {
      const sg = sum.sockGame[g] || {}, ch = sum.chat[g] || {}, vg = sum.voice.byGame[g] || {};
      return {
        game: g, label: GAME_LABEL[g],
        liveBytes: (sg.in || 0) + (sg.out || 0), tableMs: sum.time.table[g] || 0, voiceMs: sum.time.voice[g] || 0,
        chatMsgs: ch.msgs || 0, chatBytes: ch.bytes || 0, voiceSent: vg.sent || 0, voiceRelay: vg.relay || 0,
      };
    });
    const q = getQuota();
    const nxt = nextRenewal(q.renewsOn, t);
    const periodStart = new Date(Date.UTC(nxt.getUTCFullYear(), nxt.getUTCMonth() - 1, nxt.getUTCDate())).getTime();
    return {
      ok: true, range, from: dates[0], to: dates[dates.length - 1],
      trackingSince: Object.keys(days).sort()[0] || null,
      server: { containerBytes, attributedBytes: attributed, unattributedBytes: Math.max(0, containerBytes - attributed), http: sum.http, sock: sum.sock },
      voice: Object.assign({ wireBytes: sum.voice.sent, phoneBytes: sum.voice.sent + sum.voice.recv, relayBytes: sum.voice.relaySent + sum.voice.relayRecv }, sum.voice),
      combinedBytes: containerBytes + sum.voice.sent,
      time: sum.time,
      games,
      chat: sum.chat,
      tables: Object.values(tables).sort((a, b) => b.ms - a.ms).slice(0, 15),
      turnQuota: Object.assign({}, q, {
        nextRenewalDate: dayKey(nxt.getTime()),
        daysToRenewal: Math.max(0, Math.round((nxt.getTime() - Date.UTC(new Date(t).getUTCFullYear(), new Date(t).getUTCMonth(), new Date(t).getUTCDate())) / 86400000)),
        estimatedUsedBytes: (q.asOf >= periodStart ? q.usedBytes : 0) + (q.relaySinceAsOf || 0),
        readingIsFromEarlierPeriod: q.asOf < periodStart,
      }),
    };
  }

  load();
  return { httpMiddleware, attachIo, tick, save, voiceJoined, voiceLeft, report, getQuota, setQuota,
    _internals: { onPacket, accrue, live, days: () => days, day, addVoiceReport } };
}

module.exports = { createUsageStats, eventName, catOfHttp, catOfEvent, gameOfRoom, gameOfEvent, GAMES, GAME_LABEL };
