// ============================================================================
// player-stats.js -- small per-player stats for SIGNED-IN players (28 four-player + 28 six-player).
//
// Per player per day (UTC) and per mode, six counters:
//   [roundsWon, roundsLost, champStarted, champWon, champLost]   (+ games = champWon + champLost)
// "Unfinished" championships are worked out when reading: started - won - lost (never stored separately).
// Only the last KEEP_DAYS days are kept, plus one running lifetime total per mode, so a player is ~4 KB at most.
// Bots and guests are never recorded. Stats for deleted accounts are dropped by prune().
// File: DATA_DIR/player-stats.json  (same volume as the leaderboard).
// ============================================================================
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || __dirname;
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
const FILE = path.join(DATA_DIR, 'player-stats.json');
const KEEP_DAYS = 30;
const MODES = ['4p', '6p'];

let users = {};          // { acctId: { days: { 'YYYY-MM-DD': { '4p': [5], '6p': [5] } }, total: { '4p': [5], '6p': [5] }, updated } }
let dirty = false;

function today() { return new Date().toISOString().slice(0, 10); }
function load() {
  try { if (fs.existsSync(FILE)) users = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; }
  catch (e) { console.error('[player-stats] load failed, starting fresh:', e.message); users = {}; }
  prune();
  console.log(`[player-stats] ${Object.keys(users).length} player(s) loaded.`);
}
function save() {
  if (!dirty) return;
  try { fs.writeFileSync(FILE, JSON.stringify(users)); dirty = false; }
  catch (e) { console.error('[player-stats] save failed:', e.message); }
}
let knownUsers = null;   // optional () => object of existing accounts, so deleted accounts' stats get dropped
function prune() {
  const cutoff = new Date(Date.now() - KEEP_DAYS * 86400000).toISOString().slice(0, 10);
  let existing = null;
  try { existing = knownUsers ? knownUsers() : null; } catch (e) {}
  for (const id of Object.keys(users)) {
    if (existing && !existing[id]) { delete users[id]; dirty = true; continue; }
    const d = users[id].days || {};
    for (const day of Object.keys(d)) if (day < cutoff) { delete d[day]; dirty = true; }
  }
}
setInterval(save, 15000);
setInterval(prune, 6 * 3600 * 1000);
process.on('SIGTERM', save);
process.on('SIGINT', save);

function row(id, mode) {
  if (!id || MODES.indexOf(mode) < 0) return null;
  const u = users[id] || (users[id] = { days: {}, total: {}, updated: 0 });
  const day = today();
  if (!u.days[day]) u.days[day] = {};
  if (!u.days[day][mode]) u.days[day][mode] = [0, 0, 0, 0, 0];
  if (!u.total[mode]) u.total[mode] = [0, 0, 0, 0, 0];
  u.updated = Date.now();
  dirty = true;
  return { d: u.days[day][mode], t: u.total[mode] };
}
function bump(id, mode, idx) { const r = row(id, mode); if (r) { r.d[idx]++; r.t[idx]++; } }

// Human seats on a team that have a signed-in account.
function acctsOf(engine, seatCount, teamOf, team) {
  const out = [];
  for (let i = 0; i < seatCount; i++) {
    const s = engine.seats[i];
    if (s && !s.isBot && s.acctId && teamOf(i) === team) out.push(s.acctId);
  }
  return out;
}
// A round just finished: roundsWon/Lost for everyone, and "championship started" the first time we see each player this one.
function onRound(mode, engine, seatCount, teamOf, winningTeam) {
  try {
    if (!engine._statsStarted) engine._statsStarted = {};
    for (let i = 0; i < seatCount; i++) {
      const s = engine.seats[i];
      if (!s || s.isBot || !s.acctId) continue;
      bump(s.acctId, mode, teamOf(i) === winningTeam ? 0 : 1);
      if (!engine._statsStarted[s.acctId]) { engine._statsStarted[s.acctId] = 1; bump(s.acctId, mode, 2); }
    }
  } catch (e) { console.error('[player-stats] onRound failed:', e.message); }
}
// A championship (4p) / match (6p) was decided.
function onChampEnd(mode, engine, seatCount, teamOf, winningTeam) {
  try {
    for (let i = 0; i < seatCount; i++) {
      const s = engine.seats[i];
      if (!s || s.isBot || !s.acctId) continue;
      // a player who only just sat down and never finished a round of this one still counts as having played it
      if (!engine._statsStarted || !engine._statsStarted[s.acctId]) bump(s.acctId, mode, 2);
      bump(s.acctId, mode, teamOf(i) === winningTeam ? 3 : 4);
    }
    engine._statsStarted = {};
  } catch (e) { console.error('[player-stats] onChampEnd failed:', e.message); }
}

function sum(rows) { const a = [0, 0, 0, 0, 0]; rows.forEach((r) => { for (let i = 0; i < 5; i++) a[i] += r[i] || 0; }); return a; }
function shape(a) {
  return { roundsWon: a[0], roundsLost: a[1], champStarted: a[2], champWon: a[3], champLost: a[4],
           games: a[3] + a[4], unfinished: Math.max(0, a[2] - a[3] - a[4]) };
}
// What "My stats" shows: last 7 days, last 30 days, lifetime -- each split by mode and combined.
function summary(id) {
  const u = users[id];
  const out = { keepDays: KEEP_DAYS, periods: {} };
  const periods = { '7': 7, '30': KEEP_DAYS };
  const days = u ? Object.keys(u.days) : [];
  for (const k of Object.keys(periods)) {
    const cutoff = new Date(Date.now() - (periods[k] - 1) * 86400000).toISOString().slice(0, 10);
    const sel = days.filter((d) => d >= cutoff);
    const per = {};
    MODES.forEach((m) => { per[m] = shape(sum(sel.map((d) => u.days[d][m]).filter(Boolean))); });
    per.all = shape(sum(MODES.map((m) => { const s = sum(sel.map((d) => u.days[d][m]).filter(Boolean)); return s; })));
    out.periods[k] = per;
  }
  const per = {};
  MODES.forEach((m) => { per[m] = shape((u && u.total[m]) || [0, 0, 0, 0, 0]); });
  per.all = shape(sum(MODES.map((m) => (u && u.total[m]) || [0, 0, 0, 0, 0])));
  out.periods.life = per;
  return out;
}
function setKnownUsers(fn) { knownUsers = fn; }
module.exports = { load, save, onRound, onChampEnd, summary, setKnownUsers };
