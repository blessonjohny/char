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
    out: {},             // the SERVER'S OWN requests to other services: label -> { n, sent, recv }
    net: { packets: 0, rx: 0, tx: 0 },   // interface counters sampled once a minute
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

  // The voice relay is Cloudflare Realtime TURN (confirmed on the owner's dashboard: Realtime = Active, Workers Free,
  // Billable usage $0.00 "all usage is within included tier limits", billing cycle 30 Sep - 29 Oct 2026, so each cycle
  // starts on the 30th). Cloudflare gives 1,000 GB of TURN traffic free per month, then (as far as I know) $0.05 per GB.
  // Cloudflare bills the data the relay SENDS to players (egress), so the estimate counts relayed audio RECEIVED.
  function defaultQuota() {
    return {
      provider: 'Cloudflare Realtime (TURN)',
      limitBytes: 1000 * 1e9,                 // 1,000 GB free per month (decimal GB, like Cloudflare's own dashboard)
      pricePerGB: 0.05,                       // USD per GB beyond the free allowance
      cycleDay: 30,                           // billing cycle starts on this day of each month
      cycleStart: '2026-09-30',
      basis: 'egress',                        // 'egress' = relayed audio received by players; 'both' = sent + received
      usedBytes: 0,                           // optional reading typed in from the provider (0 = none)
      asOf: now(),
      relaySinceAsOf: 0,
      note: 'Cloudflare Billable usage (4 Oct 2026): $0.00, all usage within included tier limits.',
    };
  }

  // ---- persistence --------------------------------------------------------
  function load() {
    try {
      if (file && fs.existsSync(file)) {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (parsed && parsed.days && typeof parsed.days === 'object') days = parsed.days;
        if (parsed && parsed.quota) quota = parsed.quota;
      }
    } catch (e) { console.error('[usage-stats] could not load saved data, starting fresh:', e.message); days = {}; }
    // Older builds stored a Metered.ca note (512 MB, no cycle day). The relay is Cloudflare Realtime now,
    // so anything without the new fields is replaced by the Cloudflare defaults below.
    if (!quota || typeof quota.cycleDay !== 'number') { quota = defaultQuota(); dirty = true; }
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
      const sock = req.socket;
      const rbBase = (sock && sock.__usageLast) || 0;          // bytes already read on this connection by earlier requests
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
          const x = d.http[cat] || (d.http[cat] = { bytes: 0, n: 0, head: 0, in: 0 });
          x.bytes += bytes; x.n += 1;
          x.head = (x.head || 0) + (res._header ? Buffer.byteLength(String(res._header)) : 0);   // response headers
          const rb1 = (sock && sock.bytesRead) || 0;
          x.in = (x.in || 0) + Math.max(0, rb1 - rbBase);                                         // what the browser sent (headers + body)
          if (sock) sock.__usageLast = rb1;
          dirty = true;
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
    try { sampleNet(); } catch (_) {}
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

  // ---- the server's OWN requests to other services (GitHub backups, TURN keys, ...) ----
  // These never touch a player, yet they cross the network interface, so they were part of the
  // "unattributed" remainder. Every fetch() the server makes is counted and labelled by where it went
  // (for GitHub: which file), e.g. "GitHub: data/visitor-log.json".
  function labelForUrl(u) {
    try {
      const url = new URL(String(u));
      if (url.hostname === 'api.github.com') {
        const m = url.pathname.match(/\/contents\/(.+)$/);
        return 'GitHub: ' + (m ? decodeURIComponent(m[1]) : url.pathname);
      }
      if (url.hostname.endsWith('cloudflare.com')) return 'Cloudflare TURN keys';
      return url.host;
    } catch (_) { return 'other'; }
  }
  function addOutbound(label, sent, recv) {
    try {
      const d = day();
      const x = d.out[label] || (d.out[label] = { n: 0, sent: 0, recv: 0 });
      x.n += 1; x.sent += sent; x.recv += recv; dirty = true;
    } catch (_) {}
  }
  function wrapFetch(g) {
    g = g || globalThis;
    if (!g.fetch || g.fetch.__usageWrapped) return false;
    const orig = g.fetch.bind(g);
    const wrapped = async function (input, init) {
      const url = typeof input === 'string' ? input : (input && (input.url || String(input)));
      const label = labelForUrl(url);
      let sent = 350;                                    // typical request line + headers
      try {
        const b = init && init.body;
        if (typeof b === 'string') sent += Buffer.byteLength(b);
        else if (b && typeof b.length === 'number') sent += b.length;
        else if (b && typeof b.byteLength === 'number') sent += b.byteLength;
      } catch (_) {}
      let res;
      try { res = await orig(input, init); }
      catch (e) { addOutbound(label, sent, 0); throw e; }
      try {
        const clh = res.headers && res.headers.get ? res.headers.get('content-length') : null;   // null when the body is chunked
        const cl = clh == null || clh === '' ? NaN : Number(clh);
        if (Number.isFinite(cl) && cl >= 0) addOutbound(label, sent, cl + 300);
        else res.clone().arrayBuffer().then((buf) => addOutbound(label, sent, buf.byteLength + 300), () => addOutbound(label, sent, 300));
      } catch (_) { addOutbound(label, sent, 300); }
      return res;
    };
    wrapped.__usageWrapped = true;
    g.fetch = wrapped;
    return true;
  }
  // interface counters: bytes in/out and PACKET counts (every packet carries ~52 bytes of IP+TCP header)
  let prevNet = null;
  function readNet() {
    try {
      const raw = fs.readFileSync('/proc/net/dev', 'utf8').split('\n').slice(2);
      let rx = 0, tx = 0, packets = 0;
      for (const line of raw) {
        if (!line.trim()) continue;
        const [name, rest] = line.split(':');
        if (!name || name.trim() === 'lo') continue;
        const c = rest.trim().split(/\s+/).map(Number);
        rx += c[0] || 0; packets += (c[1] || 0); tx += c[8] || 0; packets += (c[9] || 0);
      }
      return { rx, tx, packets };
    } catch (_) { return null; }
  }
  function sampleNet(reader) {
    const cur = (reader || readNet)();
    if (!cur) return;
    if (prevNet) {
      const d = day();
      d.net.rx += Math.max(0, cur.rx - prevNet.rx); d.net.tx += Math.max(0, cur.tx - prevNet.tx);
      d.net.packets += Math.max(0, cur.packets - prevNet.packets); dirty = true;
    }
    prevNet = cur;
  }

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
    if (quota) quota.relaySinceAsOf = (quota.relaySinceAsOf || 0) + (quota.basis === 'both' ? relaySent + relayRecv : relayRecv);
    dirty = true;
  }

  // ---- TURN relay allowance (provider, free allowance, price, billing cycle) ----
  function getQuota() { return Object.assign({}, quota); }
  const dayInMonth = (y, m, d) => Math.min(d, new Date(Date.UTC(y, m + 1, 0)).getUTCDate());   // 30th -> 28th in February
  // the cycle that contains time t: { start, next } (UTC dates as ms); cycles start on cycleDay each month
  function cycleAt(cycleDay, t) {
    const dt = new Date(t);
    let y = dt.getUTCFullYear(), m = dt.getUTCMonth();
    let start = Date.UTC(y, m, dayInMonth(y, m, cycleDay));
    const todayMs = Date.UTC(y, m, dt.getUTCDate());
    if (start > todayMs) { m -= 1; if (m < 0) { m = 11; y -= 1; } start = Date.UTC(y, m, dayInMonth(y, m, cycleDay)); }
    let ny = y, nm = m + 1; if (nm > 11) { nm = 0; ny += 1; }
    return { start, next: Date.UTC(ny, nm, dayInMonth(ny, nm, cycleDay)) };
  }
  function setQuota(q) {
    q = q || {};
    const num = (v, d) => { v = Number(v); return Number.isFinite(v) && v >= 0 ? v : d; };
    const provider = String(q.provider || quota.provider || 'TURN relay').slice(0, 60);
    let cycleStart = quota.cycleStart, cycleDay = quota.cycleDay;
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(q.cycleStart || ''))) { cycleStart = String(q.cycleStart); cycleDay = Number(cycleStart.slice(8, 10)); }
    quota = {
      provider,
      limitBytes: num(q.limitBytes, quota.limitBytes) || quota.limitBytes,
      pricePerGB: num(q.pricePerGB, quota.pricePerGB),
      cycleDay, cycleStart,
      basis: /cloudflare/i.test(provider) ? 'egress' : (q.basis === 'egress' ? 'egress' : 'both'),
      usedBytes: num(q.usedBytes, 0),
      asOf: now(),
      relaySinceAsOf: 0,                    // a fresh reading restarts the running estimate
      note: q.note != null ? String(q.note).slice(0, 200) : quota.note,
    };
    dirty = true; save();
    return getQuota();
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
    const outAgg = {}, net = { packets: 0, rx: 0, tx: 0 };
    for (const k of dates) {
      const d = days[k]; if (!d) continue;
      for (const [c, v] of Object.entries(d.http || {})) { bump(sum.http, c, 'bytes', v.bytes); bump(sum.http, c, 'n', v.n); bump(sum.http, c, 'head', v.head || 0); bump(sum.http, c, 'in', v.in || 0); }
      for (const [label, v] of Object.entries(d.out || {})) { bump(outAgg, label, 'n', v.n || 0); bump(outAgg, label, 'sent', v.sent || 0); bump(outAgg, label, 'recv', v.recv || 0); }
      net.packets += (d.net || {}).packets || 0; net.rx += (d.net || {}).rx || 0; net.tx += (d.net || {}).tx || 0;
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
    const httpBytes = sumObj(sum.http, 'bytes') + sumObj(sum.http, 'head') + sumObj(sum.http, 'in');
    const sockIn = sumObj(sum.sock, 'in'), sockOut = sumObj(sum.sock, 'out');
    const outbound = Object.entries(outAgg).map(([label, v]) => ({ label, n: v.n, sent: v.sent, recv: v.recv, total: v.sent + v.recv })).sort((a, b) => b.total - a.total);
    const outboundBytes = outbound.reduce((s2, x) => s2 + x.total, 0);
    const headerEstimate = net.packets * 52;      // IPv4 (20) + TCP with timestamps (32) per packet
    const attributed = httpBytes + sockIn + sockOut + outboundBytes + headerEstimate;
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
    const cyc = cycleAt(q.cycleDay, t);
    const todayUtc = Date.UTC(new Date(t).getUTCFullYear(), new Date(t).getUTCMonth(), new Date(t).getUTCDate());
    // relayed audio this cycle, from the per-day player reports (egress = what players received through the relay)
    let cycleRelay = 0;
    for (const [k, d] of Object.entries(days)) {
      if (Date.parse(k + 'T00:00:00Z') < cyc.start) continue;
      const v = (d && d.voice) || {};
      cycleRelay += q.basis === 'both' ? (v.relaySent || 0) + (v.relayRecv || 0) : (v.relayRecv || 0);
    }
    const typedThisCycle = q.usedBytes > 0 && q.asOf >= cyc.start;
    const estimatedUsedBytes = typedThisCycle ? q.usedBytes + (q.relaySinceAsOf || 0) : cycleRelay;
    const overBytes = Math.max(0, estimatedUsedBytes - q.limitBytes);
    return {
      ok: true, range, from: dates[0], to: dates[dates.length - 1],
      trackingSince: Object.keys(days).sort()[0] || null,
      server: { containerBytes, attributedBytes: attributed, unattributedBytes: Math.max(0, containerBytes - attributed), http: sum.http, sock: sum.sock, outbound, outboundBytes, net: { packets: net.packets, rx: net.rx, tx: net.tx, headerEstimate } },
      voice: Object.assign({ wireBytes: sum.voice.sent, phoneBytes: sum.voice.sent + sum.voice.recv, relayBytes: sum.voice.relaySent + sum.voice.relayRecv }, sum.voice),
      combinedBytes: containerBytes + sum.voice.sent,
      time: sum.time,
      games,
      chat: sum.chat,
      tables: Object.values(tables).sort((a, b) => b.ms - a.ms).slice(0, 15),
      turnQuota: Object.assign({}, q, {
        cycleStartDate: dayKey(cyc.start),
        cycleEndDate: dayKey(cyc.next - 86400000),
        nextRenewalDate: dayKey(cyc.next),
        daysToRenewal: Math.max(0, Math.round((cyc.next - todayUtc) / 86400000)),
        estimatedUsedBytes,
        estimatedOverBytes: overBytes,
        estimatedCharge: (overBytes / 1e9) * (q.pricePerGB || 0),
        usedFromReading: typedThisCycle,
        readingIsFromEarlierPeriod: q.usedBytes > 0 && q.asOf < cyc.start,
      }),
    };
  }

  load();
  return { httpMiddleware, attachIo, tick, save, voiceJoined, voiceLeft, report, getQuota, setQuota, wrapFetch,
    _internals: { onPacket, accrue, live, days: () => days, day, addVoiceReport, addOutbound, sampleNet, labelForUrl } };
}

module.exports = { createUsageStats, eventName, catOfHttp, catOfEvent, gameOfRoom, gameOfEvent, GAMES, GAME_LABEL };
