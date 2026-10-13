// ============================================================================
// partner-bot.js -- "Teach my partner" profiles for the 28 (4-player) table.
//
// A player who turns on "Teach my partner" at the lobby gets a partner bot that
// copies HOW THEY BID: for every round the server notes the shape of the hand
// they held (points, high cards, suit-strength ceiling) and what they bid
// (a pass counts). When the partner bot has a similar hand it leans toward
// what that player did -- more as it has seen more.
//
//   - Opponent bots never see any of this: it goes only into this profile.
//   - Profile = small summary (<= MAX_OBS observations, a few KB). Oldest
//     observations drop off, so the memory is capped and recent play counts most.
//   - Over-bid safety: if the partner bot fails 2 of its last 3 bids it drops to
//     "safe mode" (ignores the learned style, bids a notch under normal) for a few
//     rounds, then goes back to learning.
//   - Key = 'u:<account id>' for signed-in players, 'g:<browser id>' for guests.
//     Guest profiles unused for 30 days are deleted.
// ============================================================================
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || __dirname;
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
const FILE = path.join(DATA_DIR, 'partner-bots.json');

const MAX_OBS = 80;            // observations kept per player
const MAX_PROFILES = 5000;     // hard cap on stored profiles
const GUEST_TTL = 30 * 24 * 3600 * 1000;
const SAFE_ROUNDS = 5;
const MIN_NEIGHBOURS = 3;

let profiles = {};
let dirty = false;

function load() {
  try {
    if (fs.existsSync(FILE)) profiles = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {};
  } catch (e) { console.error('[partner-bot] load failed, starting fresh:', e.message); profiles = {}; }
  prune();
  console.log(`[partner-bot] ${Object.keys(profiles).length} profile(s) loaded.`);
}
function save() {
  if (!dirty) return;
  try { fs.writeFileSync(FILE, JSON.stringify(profiles)); dirty = false; }
  catch (e) { console.error('[partner-bot] save failed:', e.message); }
}
function prune() {
  const now = Date.now();
  for (const k of Object.keys(profiles)) {
    if (k.charAt(0) === 'g' && now - (profiles[k].updated || 0) > GUEST_TTL) { delete profiles[k]; dirty = true; }
  }
  const keys = Object.keys(profiles);
  if (keys.length > MAX_PROFILES) {
    keys.sort((a, b) => (profiles[a].updated || 0) - (profiles[b].updated || 0));
    for (let i = 0; i < keys.length - MAX_PROFILES; i++) { delete profiles[keys[i]]; dirty = true; }
  }
}
setInterval(save, 10000);
setInterval(prune, 6 * 3600 * 1000);
process.on('SIGTERM', save);
process.on('SIGINT', save);

function validKey(k) { return typeof k === 'string' && /^[ug]:[A-Za-z0-9_-]{6,64}(~6)?$/.test(k); }

function get(key, create) {
  if (!validKey(key)) return null;
  if (!profiles[key] && create) {
    profiles[key] = { created: Date.now(), updated: Date.now(), hands: 0, obs: [], agree: [], botRecent: [], safeRounds: 0 };
    dirty = true;
  }
  return profiles[key] || null;
}

function near(o, f) {
  return Math.abs(o.p - f.p) <= 2 && Math.abs(o.h - f.h) <= 1 && Math.abs(o.c - f.c) <= 2;
}
// pass = 13 so it averages sensibly with real bids; a bid that FAILED counts as 2 lower (the player went too high).
function value(o) { return (o.b === 0 ? 13 : o.b) - (o.m === 0 ? 2 : 0); }

// What would this player's style bid on a hand like f? { bid, weight, n } or null if not enough history.
function suggest(key, f) {
  const pr = get(key, false);
  if (!pr || pr.safeRounds > 0) return null;
  const nb = pr.obs.filter((o) => near(o, f));
  if (nb.length < MIN_NEIGHBOURS) return null;
  const bid = nb.reduce((s, o) => s + value(o), 0) / nb.length;
  return { bid, weight: Math.min(0.85, 0.25 + nb.length * 0.05), n: nb.length };
}

// The teacher made a bid/pass with hand-shape f. made: true/false if they were the bidder and it's decided, else null.
function observe(key, f, bid, made) {
  const pr = get(key, true);
  if (!pr) return;
  // How close was the bot's style to what the player really did? (rolling agreement for the skill %)
  const s = suggest(key, f);
  if (s) { pr.agree.push(Math.abs(Math.round(s.bid) - (bid === 0 ? 13 : bid)) <= 1 ? 1 : 0); if (pr.agree.length > 30) pr.agree.shift(); }
  pr.obs.push({ p: f.p, h: f.h, c: f.c, b: bid, m: made === true ? 1 : made === false ? 0 : -1 });
  if (pr.obs.length > MAX_OBS) pr.obs.shift();
  pr.hands++;
  pr.updated = Date.now();
  dirty = true;
}

// The partner bot itself was the bidder and it was decided. Failing 2 of the last 3 -> safe mode.
function botOutcome(key, made) {
  const pr = get(key, false);
  if (!pr) return;
  pr.botRecent.push(made ? 1 : 0);
  if (pr.botRecent.length > 3) pr.botRecent.shift();
  if (!made && pr.botRecent.filter((x) => x === 0).length >= 2) { pr.safeRounds = SAFE_ROUNDS; pr.botRecent = []; }
  pr.updated = Date.now();
  dirty = true;
}
// Called once per finished round for a table that has this teacher.
function roundDone(key) {
  const pr = get(key, false);
  if (pr && pr.safeRounds > 0) { pr.safeRounds--; dirty = true; }
}
function isSafe(key) { const pr = get(key, false); return !!(pr && pr.safeRounds > 0); }

// What the lobby shows: hands seen + "how much like you" % (null until enough data).
function status(key) {
  const pr = get(key, false);
  if (!pr) return { hands: 0, skill: null, safe: false };
  const n = pr.agree.length;
  return { hands: pr.hands, skill: n >= 10 ? Math.round(100 * pr.agree.reduce((a, b) => a + b, 0) / n) : null, safe: pr.safeRounds > 0 };
}
function reset(key) {
  if (validKey(key) && profiles[key]) { delete profiles[key]; dirty = true; save(); }
}

module.exports = { load, save, validKey, suggest, observe, botOutcome, roundDone, isSafe, status, reset };
