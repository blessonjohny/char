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
    app: { rx: 0, tx: 0 },               // bytes the server's listening sockets read/wrote (everything above TCP)
    cost: { minutes: 0, memGBmin: 0, cpuMin: 0, volGBmin: 0 },   // sampled once a minute: what Railway bills by the minute
  };
}
// A day saved by an EARLIER version of this file is missing the newer fields (out, net, app). Without this, adding to
// them threw and was silently swallowed, so e.g. packets and the server's own requests stayed at zero all day.
function ensureDay(d) {
  const e = emptyDay();
  for (const k of Object.keys(e)) if (d[k] == null) d[k] = e[k];
  for (const k of Object.keys(e.time)) if (d.time[k] == null) d.time[k] = e.time[k];
  for (const k of Object.keys(e.voice)) if (d.voice[k] == null) d.voice[k] = e.voice[k];
  for (const k of Object.keys(e.net)) if (d.net[k] == null) d.net[k] = e.net[k];
  for (const k of Object.keys(e.app)) if (d.app[k] == null) d.app[k] = e.app[k];
  for (const k of Object.keys(e.cost)) if (d.cost[k] == null) d.cost[k] = e.cost[k];
  return d;
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
  const ctr = { req: 0, err: 0, msgs: 0 };   // running totals: web requests, failed (5xx) requests, live game messages -- the sampler turns them into per-minute counts
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

  // ---- Railway bill: settings -------------------------------------------------
  // Rates are the ones shown on the owner's Railway "Project Cost" screen (per minute / per GB).
  // Railway bills MEMORY and CPU and VOLUME by the minute, and NETWORK by the GB that leaves (egress).
  function defaultBill() {
    return {
      cycleDay: 1,                                    // day of the month Railway's usage resets -- set to yours
      rates: { memPerGBmin: 0.000231, cpuPerVcpuMin: 0.000463, egressPerGB: 0.05, volPerGBmin: 0.00000347 },
      planFee: 0, includedCredit: 0,                  // optional: monthly plan price and the usage credit it includes
      egressOffsetBytes: 0, offsetCycleStart: null,   // set when you type Railway's egress GB (covers traffic before tracking began)
      usdOffset: 0,                                   // set when you type Railway's current $ (covers memory/CPU/volume before tracking began)
      reading: null,                                  // { usd, asOf, ourUsd } -- Railway's own number, to check accuracy
    };
  }
  let bill = null;
  const GIB = 1024 * 1024 * 1024;

  // ---- RAM history (what the Railway RAM graph shows, plus the things that explain it) --------------------------------
  // Sampled every ~15 s; kept per MINUTE for 48 h (max + average), older history per 10 MINUTES for 30 days. Each record
  // also stores how many people were connected at the time and how the memory splits (JS objects / buffers / total process),
  // so a spike can be matched against players joining, restarts and GitHub backups instead of guessed at.
  const MIN_MS = 60000, KEEP_MIN_MS = 48 * 3600000, KEEP_10_MS = 30 * 86400000;
  const memFile = (opts && opts.memFile) || (file ? require('path').join(require('path').dirname(file), 'memory-history.json') : null);
  // Per-minute server health, stored with each RAM record: data in / out (bytes), CPU (seconds of one core), web requests, failed
  // requests, live game messages -- added up over the minute; and voice people, live tables, server delay -- the highest in the minute.
  const SUM_KEYS = ['rx', 'tx', 'cpu', 'req', 'err', 'msgs'], MAX_KEYS = ['voice', 'tables', 'lag'];
  let memMin = [], mem10 = [], memMarkers = [], memCur = null, memDirty = false, lastMemSave = 0;
  let hPrev = null;                       // previous sample's totals, for the deltas
  function addMarker(type, label, bytes) {
    memMarkers.push({ t: now(), type, label: String(label || '').slice(0, 80), bytes: bytes || 0 });
    if (memMarkers.length > 300) memMarkers.splice(0, memMarkers.length - 300);
    memDirty = true;
  }
  function loadMem() {
    try {
      if (memFile && fs.existsSync(memFile)) {
        const p = JSON.parse(fs.readFileSync(memFile, 'utf8'));
        if (Array.isArray(p.memMin)) memMin = p.memMin; if (Array.isArray(p.mem10)) mem10 = p.mem10; if (Array.isArray(p.markers)) memMarkers = p.markers;
      }
    } catch (e) { console.error('[usage-stats] could not read the RAM history, starting fresh:', e.message); }
    addMarker('boot', 'Server started');                          // a restart/deploy is the most common cause of a spike
  }
  function saveMem(force) {
    if (!memFile || (!memDirty && !force)) return;
    const t = now(); if (!force && t - lastMemSave < 5 * MIN_MS) return;
    try { fs.writeFileSync(memFile, JSON.stringify({ version: 1, memMin, mem10, markers: memMarkers })); memDirty = false; lastMemSave = t; }
    catch (e) { console.error('[usage-stats] could not save the RAM history:', e.message); }
  }
  function rollOld() {
    const cut = now() - KEEP_MIN_MS;
    while (memMin.length && memMin[0].t < cut) {
      const r = memMin.shift(), b = Math.floor(r.t / (10 * MIN_MS)) * 10 * MIN_MS;
      const last = mem10[mem10.length - 1];
      if (last && last.t === b) {
        last.avg = Math.round((last.avg * last.n + r.avg) / (last.n + 1)); last.n += 1;
        last.max = Math.max(last.max, r.max); last.rss = Math.max(last.rss, r.rss); last.heap = Math.max(last.heap, r.heap);
        last.ext = Math.max(last.ext, r.ext); last.conns = Math.max(last.conns, r.conns); last.seated = Math.max(last.seated, r.seated);
        for (const k of SUM_KEYS) last[k] = (last[k] || 0) + (r[k] || 0);                      // data, CPU, requests... add up over the minutes
        for (const k of MAX_KEYS) last[k] = Math.max(last[k] || 0, r[k] || 0);
      } else {
        const o = { t: b, n: 1, avg: r.avg, max: r.max, rss: r.rss, heap: r.heap, ext: r.ext, conns: r.conns, seated: r.seated };
        for (const k of SUM_KEYS) o[k] = r[k] || 0; for (const k of MAX_KEYS) o[k] = r[k] || 0; mem10.push(o);
      }
    }
    const cut10 = now() - KEEP_10_MS; while (mem10.length && mem10[0].t < cut10) mem10.shift();
  }
  function pushMem(c) {
    const rec = { t: c.t, n: 1, avg: Math.round(c.sum / c.n), max: c.max, rss: c.rss, heap: c.heap, ext: c.ext, conns: c.conns, seated: c.seated };
    for (const k of SUM_KEYS) rec[k] = Math.round(c[k] * 100) / 100; for (const k of MAX_KEYS) rec[k] = c[k];
    memMin.push(rec);
    rollOld(); memDirty = true;
  }
  function sampleMemory(readers) {
    try {
      const t = now(), minute = Math.floor(t / MIN_MS) * MIN_MS;
      const ws = readers && readers.mem ? readers.mem() : readMemoryBytes();
      const pm = readers && readers.proc ? readers.proc() : process.memoryUsage();
      if (memCur && memCur.t !== minute) { pushMem(memCur); memCur = null; }
      if (!memCur) memCur = { t: minute, n: 0, sum: 0, max: 0, rss: 0, heap: 0, ext: 0, conns: 0, seated: 0, rx: 0, tx: 0, cpu: 0, req: 0, err: 0, msgs: 0, voice: 0, tables: 0, lag: 0 };
      // ---- server health since the previous sample (data, CPU, requests, messages) and right-now readings (voice, tables, delay)
      const hn = readers && readers.health ? readers.health() : { net: readNet(), cpu: readCpuSeconds() };
      const cur = { t, rx: hn.net ? hn.net.rx : 0, tx: hn.net ? hn.net.tx : 0, cpu: hn.cpu || 0, req: ctr.req, err: ctr.err, msgs: ctr.msgs };
      if (hPrev) {
        for (const k of SUM_KEYS) memCur[k] += Math.max(0, cur[k] - hPrev[k]);
        memCur.lag = Math.max(memCur.lag, Math.max(0, (t - hPrev.t) - 15000));          // the sampler runs every 15 s: anything later is the server being too busy to run it on time
      }
      hPrev = cur;
      let vc = 0; for (const c of live.values()) if (c.voiceSince) vc += 1;
      memCur.voice = Math.max(memCur.voice, vc);
      try { const lc = opts && opts.liveCounts ? opts.liveCounts() : null; if (lc && Number.isFinite(lc.tables)) memCur.tables = Math.max(memCur.tables, lc.tables); } catch (_) {}
      memCur.n += 1; memCur.sum += ws; if (ws > memCur.max) memCur.max = ws;
      if (pm.rss > memCur.rss) memCur.rss = pm.rss; if (pm.heapUsed > memCur.heap) memCur.heap = pm.heapUsed; if ((pm.external || 0) > memCur.ext) memCur.ext = pm.external || 0;
      let seated = 0; for (const c of live.values()) if (c.table) seated += 1;
      if (live.size > memCur.conns) memCur.conns = live.size; if (seated > memCur.seated) memCur.seated = seated;
    } catch (_) {}
  }

  // ---- what the container is using right now (for the per-minute costs) -------
  const readText = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch (_) { return null; } };
  function readMemoryBytes() {
    // working set = usage minus easily-reclaimable file cache, which is what a "RAM" graph normally shows
    let cur = readText('/sys/fs/cgroup/memory.current');
    let stat = readText('/sys/fs/cgroup/memory.stat');
    let inactive = stat ? Number((stat.match(/^inactive_file\s+(\d+)/m) || [])[1] || 0) : 0;
    if (cur == null) {
      cur = readText('/sys/fs/cgroup/memory/memory.usage_in_bytes');
      stat = readText('/sys/fs/cgroup/memory/memory.stat');
      inactive = stat ? Number((stat.match(/^total_inactive_file\s+(\d+)/m) || [])[1] || 0) : 0;
    }
    const n = Number(cur);
    if (Number.isFinite(n) && n > 0) return Math.max(0, n - inactive);
    return process.memoryUsage().rss;
  }
  function readCpuSeconds() {
    let t = readText('/sys/fs/cgroup/cpu.stat');
    if (t) { const m = t.match(/^usage_usec\s+(\d+)/m); if (m) return Number(m[1]) / 1e6; }
    for (const f of ['/sys/fs/cgroup/cpuacct/cpuacct.usage', '/sys/fs/cgroup/cpu/cpuacct.usage']) {
      const v = Number(readText(f)); if (Number.isFinite(v) && v > 0) return v / 1e9;
    }
    const c = process.cpuUsage(); return (c.user + c.system) / 1e6;
  }
  function readVolumeBytes() {
    // only a volume that is a SEPARATE disk counts; if the data folder is on the container's own disk it is free
    try {
      const dir = (opts && opts.dataDir) || (file ? require('path').dirname(file) : null);
      if (!dir) return 0;
      if (fs.statSync(dir).dev === fs.statSync('/').dev) return 0;
      const st = fs.statfsSync(dir);
      return Math.max(0, (st.blocks - st.bfree) * st.bsize);
    } catch (_) { return 0; }
  }
  let prevCost = null;
  function sampleCost(readers) {
    const R = readers || { mem: readMemoryBytes, cpu: readCpuSeconds, vol: readVolumeBytes };
    const t = now();
    const cpu = R.cpu();
    if (prevCost) {
      const dtMin = Math.min((t - prevCost.t) / 60000, 5);          // a long gap (restart) is never credited as usage
      if (dtMin > 0) {
        const d = day(t);
        d.cost.minutes += dtMin;
        d.cost.memGBmin += (R.mem() / GIB) * dtMin;
        d.cost.cpuMin += Math.max(0, cpu - prevCost.cpu) / 60;     // vCPU-minutes actually used
        d.cost.volGBmin += (R.vol() / GIB) * dtMin;
        dirty = true;
      }
    }
    prevCost = { t, cpu };
  }

  // ---- persistence --------------------------------------------------------
  function load() {
    try {
      if (file && fs.existsSync(file)) {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (parsed && parsed.days && typeof parsed.days === 'object') { days = parsed.days; for (const k of Object.keys(days)) { try { ensureDay(days[k]); } catch (_) {} } }
        if (parsed && parsed.quota) quota = parsed.quota;
        if (parsed && parsed.bill) bill = parsed.bill;
      }
    } catch (e) { console.error('[usage-stats] could not load saved data, starting fresh:', e.message); days = {}; }
    // Older builds stored a Metered.ca note (512 MB, no cycle day). The relay is Cloudflare Realtime now,
    // so anything without the new fields is replaced by the Cloudflare defaults below.
    if (!quota || typeof quota.cycleDay !== 'number') { quota = defaultQuota(); dirty = true; }
    const db = defaultBill();
    bill = Object.assign(db, bill || {}); bill.rates = Object.assign(db.rates, (bill && bill.rates) || {});
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
    try { trim(); fs.writeFileSync(file, JSON.stringify({ version: 1, days, quota, bill })); dirty = false; }
    catch (e) { console.error('[usage-stats] could not save:', e.message); }
  }

  function day(t) {
    const k = dayKey(t == null ? now() : t);
    if (k !== todayKey) { todayKey = k; today = ensureDay(days[k] || (days[k] = emptyDay())); }
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
          x.bytes += bytes; x.n += 1; ctr.req += 1; if (res.statusCode >= 500) ctr.err += 1;
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
      ctr.msgs += 1;
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
    try { sampleCost(); } catch (_) {}
    try { saveMem(); } catch (_) {}
    for (const rec of conns.values()) { try { rec.settle(); } catch (_) {} }
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
      if (/^GitHub/.test(label) && sent + recv >= 100 * 1024) addMarker('github', label, sent + recv);   // a big backup builds big strings in memory
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
  // Everything the server's LISTENING sockets read and wrote -- HTTP headers and bodies, WebSocket frames, Socket.IO
  // pings and handshakes: all of it, counted by the socket itself rather than guessed from a category. Anything the
  // categories above explain is subtracted in the report; what remains here is WebSocket/engine overhead.
  const conns = new Map();
  function trackSocket(sock) {
    try {
      const rec = { r: 0, w: 0 };
      const settle = () => {
        const r = sock.bytesRead || 0, w = sock.bytesWritten || 0;
        const d = day();
        d.app.rx += Math.max(0, r - rec.r); d.app.tx += Math.max(0, w - rec.w);
        rec.r = r; rec.w = w; dirty = true;
      };
      rec.settle = settle;
      conns.set(sock, rec);
      sock.on('close', () => { try { settle(); } catch (_) {} conns.delete(sock); });
    } catch (_) {}
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

  // ---- Railway bill (estimate, per Railway billing cycle) ------------------------------------------------------
  // Egress is the GB that LEAVE the server (the share of the container's total that is outgoing, measured from the
  // interface counters), memory/CPU/volume come from the once-a-minute samples. All priced with Railway's own rates.
  const DAY_MS = 86400000;
  function prevCycleStart(startMs, cycleDay) {
    const d = new Date(startMs); let y = d.getUTCFullYear(), m = d.getUTCMonth() - 1;
    if (m < 0) { m = 11; y -= 1; }
    return Date.UTC(y, m, dayInMonth(y, m, cycleDay));
  }
  function egressShare() {
    let tx = 0, tot = 0;
    for (const d of Object.values(days)) { const n = d.net || {}; tx += n.tx || 0; tot += (n.tx || 0) + (n.rx || 0); }
    return tot > 1e6 ? Math.min(1, Math.max(0.5, tx / tot)) : 0.96;     // until enough is sampled, assume ~96% is outgoing
  }
  // add up one window [startMs, endMs) day by day
  function sumWindow(startMs, endMs, netMap, share) {
    const out = { egressBytes: 0, memGBmin: 0, cpuMin: 0, volGBmin: 0, minutes: 0, byDay: [], firstNet: null, firstCost: null };
    for (let t0 = startMs; t0 < endMs; t0 += DAY_MS) {
      const key = dayKey(t0), nd = netMap[key], dd = days[key];
      const eg = nd != null ? nd * share : ((dd && dd.net && dd.net.tx) || 0);
      const c = (dd && dd.cost) || { minutes: 0, memGBmin: 0, cpuMin: 0, volGBmin: 0 };
      out.egressBytes += eg; out.memGBmin += c.memGBmin || 0; out.cpuMin += c.cpuMin || 0; out.volGBmin += c.volGBmin || 0; out.minutes += c.minutes || 0;
      if (nd != null && out.firstNet == null) out.firstNet = t0;
      if ((c.minutes || 0) > 0 && out.firstCost == null) out.firstCost = t0;
      out.byDay.push({ key, eg, c });
    }
    return out;
  }
  function priceParts(w, R, offsetBytes) {
    const eg = w.egressBytes + (offsetBytes || 0);
    return {
      memory: w.memGBmin * R.memPerGBmin, cpu: w.cpuMin * R.cpuPerVcpuMin,
      egress: (eg / 1e9) * R.egressPerGB, volume: w.volGBmin * R.volPerGBmin,
    };
  }
  const totalOf = (p) => p.memory + p.cpu + p.egress + p.volume;
  function billReport(t, networkDays) {
    const R = bill.rates;
    const netMap = {}; (networkDays || []).forEach((x) => { netMap[x.date] = x.bytes; });
    const share = egressShare();
    const cyc = cycleAt(bill.cycleDay, t);
    const sameCycle = bill.offsetCycleStart === dayKey(cyc.start);
    const offset = sameCycle ? (bill.egressOffsetBytes || 0) : 0;
    const usdOffset = sameCycle ? (bill.usdOffset || 0) : 0;      // money already spent before tracking began, from Railway's own number
    const w = sumWindow(cyc.start, Math.min(cyc.next, t + 1), netMap, share);
    const parts = priceParts(w, R, offset);
    const soFar = totalOf(parts) + usdOffset;
    // projection: keep spending at the pace measured so far for the rest of the cycle
    const remainMs = Math.max(0, cyc.next - t), remainMin = remainMs / 60000;
    const trackedNetMs = w.firstNet != null ? Math.max(1, t - w.firstNet) : 0;
    const proj = {
      memory: w.minutes > 0 ? parts.memory + (w.memGBmin / w.minutes) * remainMin * R.memPerGBmin : parts.memory,
      cpu: w.minutes > 0 ? parts.cpu + (w.cpuMin / w.minutes) * remainMin * R.cpuPerVcpuMin : parts.cpu,
      egress: trackedNetMs > 6 * 3600000 ? parts.egress + ((w.egressBytes / 1e9) * R.egressPerGB / trackedNetMs) * remainMs : parts.egress,
      volume: w.minutes > 0 ? parts.volume + (w.volGBmin / w.minutes) * remainMin * R.volPerGBmin : parts.volume,
    };
    const projected = totalOf(proj) + usdOffset;
    const todayKey2 = dayKey(t);
    const dayUsd = (b) => (b.c.memGBmin * R.memPerGBmin) + (b.c.cpuMin * R.cpuPerVcpuMin) + (b.eg / 1e9) * R.egressPerGB + (b.c.volGBmin * R.volPerGBmin);
    const byDay = w.byDay.map((b) => ({ date: b.key, usd: dayUsd(b), egressBytes: b.eg })).slice(-14).reverse();
    const todayUsd = (w.byDay.find((b) => b.key === todayKey2) ? dayUsd(w.byDay.find((b) => b.key === todayKey2)) : 0);
    // history: this cycle and the 11 before it
    const history = [];
    let start = cyc.start, next = cyc.next;
    const trackStart = Math.min(...[w.firstNet, w.firstCost].filter((x) => x != null), Infinity);
    for (let k = 0; k < 12; k++) {
      const ww = sumWindow(start, Math.min(next, t + 1), netMap, share);
      const pp = priceParts(ww, R, k === 0 ? offset : 0);
      const any = ww.egressBytes > 0 || ww.minutes > 0;
      if (any || k === 0) history.push({ start: dayKey(start), end: dayKey(next - DAY_MS), usd: totalOf(pp) + (k === 0 ? usdOffset : 0), egressBytes: ww.egressBytes + (k === 0 ? offset : 0), partial: Number.isFinite(trackStart) && start < trackStart, current: k === 0 });
      next = start; start = prevCycleStart(start, bill.cycleDay);
    }
    // calendar year to date
    const y0 = Date.UTC(new Date(t).getUTCFullYear(), 0, 1);
    const wy = sumWindow(y0, t + 1, netMap, share);
    const yearUsd = totalOf(priceParts(wy, R, 0));
    const last12 = history.reduce((a, h) => a + h.usd, 0);
    const credit = bill.includedCredit || 0, fee = bill.planFee || 0;
    return {
      cycleStartDate: dayKey(cyc.start), cycleEndDate: dayKey(cyc.next - DAY_MS), nextDate: dayKey(cyc.next),
      daysLeft: Math.max(0, Math.round((cyc.next - Date.UTC(new Date(t).getUTCFullYear(), new Date(t).getUTCMonth(), new Date(t).getUTCDate())) / DAY_MS)),
      rates: R, settings: { cycleDay: bill.cycleDay, planFee: fee, includedCredit: credit },
      components: [
        { key: 'memory', label: 'Memory', qty: w.memGBmin, unit: 'GB-minutes', usd: parts.memory, projectedUsd: proj.memory },
        { key: 'cpu', label: 'CPU', qty: w.cpuMin, unit: 'vCPU-minutes', usd: parts.cpu, projectedUsd: proj.cpu },
        { key: 'egress', label: 'Network (egress)', qty: w.egressBytes + offset, unit: 'bytes', usd: parts.egress, projectedUsd: proj.egress },
        { key: 'volume', label: 'Volume', qty: w.volGBmin, unit: 'GB-minutes', usd: parts.volume, projectedUsd: proj.volume },
      ].concat(usdOffset > 0.005 ? [{ key: 'before', label: 'Before tracking began (from Railway)', qty: 0, unit: '', usd: usdOffset, projectedUsd: usdOffset }] : []),
      usdOffsetApplied: usdOffset,
      totalUsd: soFar, projectedUsd: projected, todayUsd,
      invoiceEstimate: (fee > 0 || credit > 0) ? fee + Math.max(0, projected - credit) : null,
      byDay, history, yearUsd, yearLabel: String(new Date(t).getUTCFullYear()), last12Usd: last12,
      egressShare: share, offsetBytes: offset,
      coverage: { network: w.firstNet != null ? dayKey(w.firstNet) : null, cost: w.firstCost != null ? dayKey(w.firstCost) : null },
      reading: bill.reading ? Object.assign({}, bill.reading) : null,
    };
  }
  function setBill(b, networkDays) {
    b = b || {};
    const num = (v, d) => { v = Number(v); return Number.isFinite(v) && v >= 0 ? v : d; };
    const before = bill.cycleDay;
    const cd = Math.round(num(b.cycleDay, bill.cycleDay));
    bill.cycleDay = cd >= 1 && cd <= 31 ? cd : bill.cycleDay;
    if (b.rates && typeof b.rates === 'object') for (const k of Object.keys(bill.rates)) bill.rates[k] = num(b.rates[k], bill.rates[k]);
    bill.planFee = num(b.planFee, bill.planFee); bill.includedCredit = num(b.includedCredit, bill.includedCredit);
    if (bill.cycleDay !== before) { bill.egressOffsetBytes = 0; bill.usdOffset = 0; bill.offsetCycleStart = null; bill.reading = null; }
    const t = now();
    // Railway's own numbers, typed in: a check on accuracy, and (for egress) a correction for traffic before tracking began
    const cyc = cycleAt(bill.cycleDay, t);
    if (b.clearReading) { bill.reading = null; bill.egressOffsetBytes = 0; bill.usdOffset = 0; bill.offsetCycleStart = null; }
    if (b.readingEgressGB != null && b.readingEgressGB !== '' && Number(b.readingEgressGB) >= 0) {
      const netMap = {}; (networkDays || []).forEach((x) => { netMap[x.date] = x.bytes; });
      const w = sumWindow(cyc.start, t + 1, netMap, egressShare());
      bill.egressOffsetBytes = Math.max(0, Number(b.readingEgressGB) * 1e9 - w.egressBytes);
      bill.offsetCycleStart = dayKey(cyc.start);
    }
    if (b.readingUsd != null && b.readingUsd !== '' && Number(b.readingUsd) >= 0) {
      if (bill.offsetCycleStart !== dayKey(cyc.start)) { bill.offsetCycleStart = dayKey(cyc.start); bill.egressOffsetBytes = bill.egressOffsetBytes || 0; }
      const rep = billReport(t, networkDays);
      const base = rep.totalUsd - (rep.usdOffsetApplied || 0);      // our own estimate, without any earlier correction
      bill.usdOffset = Math.max(0, Number(b.readingUsd) - base);    // the rest of Railway's number = what was spent before tracking
      bill.reading = { usd: Number(b.readingUsd), asOf: t, ourUsd: base };
    }
    dirty = true; save();
    return billReport(t, networkDays);
  }

  // ---- RAM report: the chart series, the spikes and what most likely caused each one ---------------------------------------
  const median = (a) => { if (!a.length) return 0; const b = a.slice().sort((x, y) => x - y); const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
  function detectSpikes(pts, win) {
    const flagged = [];
    for (let i = 0; i < pts.length; i++) {
      const prev = pts.slice(Math.max(0, i - win), i).map((p) => p.avg);
      if (prev.length < 5) continue;
      const base = median(prev), p = pts[i];
      if (p.max > base * 1.25 && p.max - base > 50e6) flagged.push({ i, base });   // a quarter above normal AND at least 50 MB
    }
    const groups = [];
    for (const f of flagged) {
      const g = groups[groups.length - 1];
      if (g && f.i - g.last <= 2) { g.last = f.i; g.bases.push(f.base); } else groups.push({ first: f.i, last: f.i, bases: [f.base] });
    }
    return groups;
  }
  function memoryReport(range) {
    range = ['1h', '6h', '24h', '7d', '30d'].includes(range) ? range : '6h';
    const span = { '1h': 3600e3, '6h': 6 * 3600e3, '24h': 24 * 3600e3, '7d': 7 * 86400e3, '30d': 30 * 86400e3 }[range];
    const t = now(), from = t - span;
    const cur = memCur ? [{ t: memCur.t, avg: Math.round(memCur.sum / memCur.n), max: memCur.max, rss: memCur.rss, heap: memCur.heap, ext: memCur.ext, conns: memCur.conns, seated: memCur.seated }] : [];
    const firstMin = memMin.length ? memMin[0].t : Infinity;
    const pts = [];
    for (const r of mem10) if (r.t < firstMin && r.t >= from - 10 * MIN_MS) pts.push(r);
    for (const r of memMin) if (r.t >= from) pts.push(r);
    for (const r of cur) if (r.t >= from) pts.push(r);
    const stepMs = pts.length > 1 ? Math.max(MIN_MS, median(pts.slice(1).map((p, i) => p.t - pts[i].t))) : MIN_MS;
    // ---- spikes (computed on the full-resolution series, not the downsampled one)
    const groups = detectSpikes(pts, stepMs >= 5 * MIN_MS ? 6 : 60);
    const spikes = groups.map((g) => {
      const seg = pts.slice(g.first, g.last + 1);
      let pk = seg[0]; for (const p of seg) if (p.max > pk.max) pk = p;
      const before = pts.slice(Math.max(0, g.first - (stepMs >= 5 * MIN_MS ? 6 : 60)), g.first);
      const base = median(g.bases), start = seg[0].t, end = seg[seg.length - 1].t + stepMs;
      const connsBase = median(before.map((p) => p.conns)), heapBase = median(before.map((p) => p.heap)), extBase = median(before.map((p) => p.ext));
      const delta = pk.max - base, heapDelta = pk.heap - heapBase, extDelta = pk.ext - extBase;
      const near = memMarkers.filter((m) => m.t >= start - 4 * MIN_MS && m.t <= end + 2 * MIN_MS);
      const boot = near.find((m) => m.type === 'boot'), backup = near.find((m) => m.type === 'github');
      let kind, why;
      if (boot) { kind = 'restart'; why = 'A restart / deploy happened just before. While a new copy starts, Railway runs it next to the old one, so memory briefly doubles.'; }
      else if (backup) { kind = 'backup'; why = 'A GitHub backup (' + backup.label.replace(/^GitHub: /, '') + ', about ' + Math.round(backup.bytes / 1024) + ' KB) ran at the same time — it builds the whole file as text in memory.'; }
      else if (pk.conns - connsBase >= Math.max(3, connsBase * 0.5)) { kind = 'players'; why = 'More people connected at that moment (' + Math.round(connsBase) + ' → ' + pk.conns + ' connections).'; }
      else if (extDelta > 0.5 * delta && extDelta > 20e6) { kind = 'buffers'; why = 'Large buffers (files, images or big JSON) rather than game objects — something read or built a big block of data.'; }
      else if (heapDelta > 0.5 * delta && heapDelta > 20e6) { kind = 'heap'; why = 'The game\'s own objects grew (state, logs, history) — normally cleared again by Node\'s garbage collection.'; }
      else { kind = 'unexplained'; why = 'Not explained by players, a restart or a backup. Usually the container\'s file cache or garbage-collection timing, not your code.'; }
      return { start, end, peak: pk.max, peakAt: pk.t, base, delta, connsBase: Math.round(connsBase), connsPeak: pk.conns, seatedPeak: pk.seated, heapDelta, extDelta, kind, why };
    }).sort((a, b) => b.delta - a.delta).slice(0, 12);
    // ---- relation between players and memory (last 24 h of the series, per-minute points only)
    const rel = pts.filter((p) => p.t >= t - 24 * 3600e3);
    let correlation = null;
    if (rel.length >= 30) {
      const n = rel.length, mx = rel.reduce((a, p) => a + p.conns, 0) / n, my = rel.reduce((a, p) => a + p.avg, 0) / n;
      let sxx = 0, syy = 0, sxy = 0;
      for (const p of rel) { sxx += (p.conns - mx) ** 2; syy += (p.avg - my) ** 2; sxy += (p.conns - mx) * (p.avg - my); }
      const minC = Math.min(...rel.map((p) => p.conns)), maxC = Math.max(...rel.map((p) => p.conns));
      const r = sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
      const slope = sxx > 0 ? sxy / sxx : 0;
      correlation = { n, r: Math.round(r * 100) / 100, mbPerPlayer: Math.round(slope / 1e6 * 10) / 10, baselineMb: Math.round((my - slope * mx) / 1e6), minConns: minC, maxConns: maxC };
    }
    let verdict;
    if (!correlation) verdict = { level: 'wait', text: 'Not enough history yet to say. Leave it running for a few hours; this fills in by itself.' };
    else if (correlation.maxConns - correlation.minConns <= 1) verdict = { level: 'no', text: 'The number of people connected barely changed, so RAM changes are not coming from player count.' };
    else if (correlation.r >= 0.6 && correlation.mbPerPlayer >= 1) verdict = { level: 'yes', text: 'Yes — memory rises with players: about ' + correlation.mbPerPlayer + ' MB per connected person on top of a base of about ' + correlation.baselineMb + ' MB (match strength ' + correlation.r + ').' };
    else if (correlation.r >= 0.3) verdict = { level: 'partly', text: 'Partly — more players tends to mean more RAM (about ' + correlation.mbPerPlayer + ' MB each, match strength ' + correlation.r + '), but most of the movement has other causes.' };
    else verdict = { level: 'no', text: 'No — memory does not follow the number of players (match strength ' + correlation.r + '). Look at the spike causes below instead.' };
    // ---- the chart series, thinned to <= 360 points while keeping each bucket's PEAK so spikes are never smoothed away
    const buckets = 360, bw = Math.max(stepMs, span / buckets);
    const out = [];
    for (const p of pts) {
      const b = Math.floor((p.t - from) / bw);
      const last = out[out.length - 1];
      const mins = p.n || 1;
      if (last && last.b === b) { for (const k of SUM_KEYS) last['s_' + k] += (p[k] || 0); for (const k of MAX_KEYS) last[k] = Math.max(last[k], p[k] || 0); last.mins += mins; last.max = Math.max(last.max, p.max); last.sum += p.avg; last.n += 1; last.rss = Math.max(last.rss, p.rss); last.heap = Math.max(last.heap, p.heap); last.ext = Math.max(last.ext, p.ext); last.conns = Math.max(last.conns, p.conns); last.seated = Math.max(last.seated, p.seated); }
      else { const o = { b, t: p.t, max: p.max, sum: p.avg, n: 1, rss: p.rss, heap: p.heap, ext: p.ext, conns: p.conns, seated: p.seated, mins }; for (const k of SUM_KEYS) o['s_' + k] = p[k] || 0; for (const k of MAX_KEYS) o[k] = p[k] || 0; out.push(o); }
    }
    // point = [time, RAM peak, RAM average, process, game objects, buffers, connected, seated,
    //          data in /min, data out /min, CPU % of one core, web requests /min, failed requests /min, live messages /min, people on voice, live tables, server delay ms]
    const rate = (o, k) => Math.round((o['s_' + k] / Math.max(1, o.mins)) * 100) / 100;
    const points = out.map((o) => [o.t, o.max, Math.round(o.sum / o.n), o.rss, o.heap, o.ext, o.conns, o.seated,
      Math.round(rate(o, 'rx')), Math.round(rate(o, 'tx')), Math.round(rate(o, 'cpu') / 60 * 1000) / 10, Math.round(rate(o, 'req') * 10) / 10, Math.round(rate(o, 'err') * 10) / 10, Math.round(rate(o, 'msgs') * 10) / 10, o.voice, o.tables, Math.round(o.lag)]);
    const peak = pts.reduce((a, p) => (p.max > a.max ? p : a), pts[0] || { max: 0, t: t, conns: 0 });
    return {
      ok: true, range, from, to: t, resolution: stepMs >= 5 * MIN_MS ? '10 minutes' : '1 minute', points,
      stats: { count: pts.length, now: pts.length ? pts[pts.length - 1].max : 0, nowConns: live.size, peak: peak.max, peakAt: peak.t, peakConns: peak.conns || 0, avg: pts.length ? Math.round(pts.reduce((a, p) => a + p.avg, 0) / pts.length) : 0, baseline: Math.round(median(pts.map((p) => p.avg))) },
      spikes, correlation, verdict,
      markers: memMarkers.filter((m) => m.t >= from),
    };
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
    const outAgg = {}, net = { packets: 0, rx: 0, tx: 0 }, app = { rx: 0, tx: 0 };
    for (const k of dates) {
      const d = days[k]; if (!d) continue;
      for (const [c, v] of Object.entries(d.http || {})) { bump(sum.http, c, 'bytes', v.bytes); bump(sum.http, c, 'n', v.n); bump(sum.http, c, 'head', v.head || 0); bump(sum.http, c, 'in', v.in || 0); }
      for (const [label, v] of Object.entries(d.out || {})) { bump(outAgg, label, 'n', v.n || 0); bump(outAgg, label, 'sent', v.sent || 0); bump(outAgg, label, 'recv', v.recv || 0); }
      app.rx += (d.app || {}).rx || 0; app.tx += (d.app || {}).tx || 0;
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
    // what the listening sockets really moved, versus what the categories explain
    const appTotal = app.rx + app.tx;
    const categorised = httpBytes + sockIn + sockOut;
    const engineOverhead = appTotal > categorised ? appTotal - categorised : 0;   // WebSocket frames, pings, handshakes
    const attributed = Math.max(appTotal, categorised) + outboundBytes + headerEstimate;
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
      server: { containerBytes, attributedBytes: attributed, unattributedBytes: Math.max(0, containerBytes - attributed), http: sum.http, sock: sum.sock, outbound, outboundBytes,
        app: { rx: app.rx, tx: app.tx, total: appTotal, engineOverhead },
        net: { packets: net.packets, rx: net.rx, tx: net.tx, headerEstimate,
               avgPacket: net.packets ? Math.round((net.rx + net.tx) / net.packets) : 0,
               impliedPerPacket: net.packets ? Math.max(0, ((net.rx + net.tx) - appTotal - outboundBytes) / net.packets) : 0 } },
      voice: Object.assign({ wireBytes: sum.voice.sent, phoneBytes: sum.voice.sent + sum.voice.recv, relayBytes: sum.voice.relaySent + sum.voice.relayRecv }, sum.voice),
      combinedBytes: containerBytes + sum.voice.sent,
      time: sum.time,
      games,
      chat: sum.chat,
      tables: Object.values(tables).sort((a, b) => b.ms - a.ms).slice(0, 15),
      bill: billReport(t, networkDays),
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

  load(); loadMem();
  return { httpMiddleware, attachIo, tick, save, voiceJoined, voiceLeft, report, getQuota, setQuota, setBill, wrapFetch, trackSocket, sampleMemory, memoryReport, saveMem,
    _internals: { addMarker, onPacket, accrue, live, days: () => days, day, addVoiceReport, addOutbound, sampleNet, sampleCost, labelForUrl } };
}

module.exports = { createUsageStats, eventName, catOfHttp, catOfEvent, gameOfRoom, gameOfEvent, GAMES, GAME_LABEL };
