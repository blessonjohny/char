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
  if (!pr) return { hands: 0, skill: null, trumpSkill: null, playSkill: null, safe: false, autoOn: false, signedIn: !!(key && key.charAt(0) === 'u') };
  const pct = (arr) => (arr && arr.length >= 10) ? Math.round(100 * arr.reduce((a, b) => a + b, 0) / arr.length) : null;
  return { hands: pr.hands, skill: pct(pr.agree), trumpSkill: pct(pr.agreeTrump), playSkill: pct(pr.agreePlay),
           trumpN: (pr.agreeTrump || []).length, playN: (pr.agreePlay || []).length,
           safe: pr.safeRounds > 0, autoOn: !!pr.autoOn, signedIn: key.charAt(0) === 'u' };
}
// ---- Play style (card play + trump choice): a handful of small counters, not a game log -------------------------------
// style = { feedYes, feedTotal, leadHigh, leadLow, leadTotal, tn, td:[4] }
//   feed*  : partner was winning the trick -- did the player load it with their highest point card?
//   lead*  : player led a suit they held 2+ cards of -- highest card, lowest card, or in between?
//   tn/td  : trump choice -- running total of (chosen suit's features - the other suits' average), 4 features.
const STYLE_CAP = 60;   // counters are halved past this so recent play counts more and the profile never grows
function styleOf(pr) {
  if (!pr.style) pr.style = { feedYes: 0, feedTotal: 0, leadHigh: 0, leadLow: 0, leadTotal: 0, tn: 0, td: [0, 0, 0, 0] };
  return pr.style;
}
function decay(st) {
  if (st.feedTotal > STYLE_CAP) { st.feedYes /= 2; st.feedTotal /= 2; }
  if (st.leadTotal > STYLE_CAP) { st.leadHigh /= 2; st.leadLow /= 2; st.leadTotal /= 2; }
  if (st.tn > 30) { st.tn /= 2; st.td = st.td.map((x) => x / 2); }
}
// kind 'feed' (yes: boolean) | 'lead' (rank: 'high'|'low'|'mid')
function observePlay(key, kind, v) {
  const pr = get(key, true);
  if (!pr) return;
  const st = styleOf(pr);
  // Honest score: before learning from this play, would the style learned so far have made the same call?
  try {
    let hit = null;
    if (kind === 'feed' && st.feedTotal >= MIN_STYLE) hit = ((st.feedYes / st.feedTotal) >= 0.5) === !!v ? 1 : 0;
    else if (kind === 'lead' && st.leadTotal >= MIN_STYLE) {
      const mid = st.leadTotal - st.leadHigh - st.leadLow;
      const best = st.leadHigh >= st.leadLow && st.leadHigh >= mid ? 'high' : (st.leadLow >= mid ? 'low' : 'mid');
      hit = best === v ? 1 : 0;
    }
    if (hit !== null) { if (!pr.agreePlay) pr.agreePlay = []; pr.agreePlay.push(hit); if (pr.agreePlay.length > 30) pr.agreePlay.shift(); }
  } catch (e) {}
  if (kind === 'feed') { st.feedTotal++; if (v) st.feedYes++; }
  else if (kind === 'lead') { st.leadTotal++; if (v === 'high') st.leadHigh++; else if (v === 'low') st.leadLow++; }
  decay(st);
  pr.updated = Date.now();
  dirty = true;
}
// diff = 4-number vector: chosen suit's features minus the other suits' average.
function observeTrump(key, diff, feats, chosenIdx) {
  const pr = get(key, true);
  if (!pr) return;
  const st = styleOf(pr);
  // Honest score: would the style learned so far have picked the same suit as the player did?
  try {
    if (st.tn >= MIN_STYLE && Array.isArray(feats) && feats.length === 4) {
      const w = st.td.map((x) => x / st.tn);
      let best = 0, bs = -1e9;
      feats.forEach((f, i) => { const sc = f[0] * w[0] + f[1] * w[1] + f[2] * w[2] + f[3] * w[3]; if (sc > bs) { bs = sc; best = i; } });
      if (!pr.agreeTrump) pr.agreeTrump = [];
      pr.agreeTrump.push(best === chosenIdx ? 1 : 0);
      if (pr.agreeTrump.length > 30) pr.agreeTrump.shift();
    }
  } catch (e) {}
  st.tn++;
  for (let i = 0; i < 4; i++) st.td[i] += diff[i];
  decay(st);
  pr.updated = Date.now();
  dirty = true;
}
const MIN_STYLE = 8;
// What this player tends to do. Each field is null until there are enough examples.
function playStyle(key) {
  const pr = get(key, false);
  if (!pr || !pr.style || pr.safeRounds > 0) return null;
  const st = pr.style;
  return {
    feed: st.feedTotal >= MIN_STYLE ? st.feedYes / st.feedTotal : null,
    leadHigh: st.leadTotal >= MIN_STYLE ? st.leadHigh / st.leadTotal : null,
    leadLow: st.leadTotal >= MIN_STYLE ? st.leadLow / st.leadTotal : null,
    trump: st.tn >= MIN_STYLE ? { weights: st.td.map((x) => x / st.tn), strength: Math.min(1, st.tn / 20) } : null,
  };
}
// Signed-in players: remember that they want Teach switched on every time (follows them to any device).
function setAuto(key, on) {
  if (!validKey(key) || key.charAt(0) !== 'u') return;
  const pr = get(key, true);
  if (!pr) return;
  pr.autoOn = !!on;
  dirty = true;
}
function reset(key) {
  if (validKey(key) && profiles[key]) { delete profiles[key]; dirty = true; save(); }
}

module.exports = { load, save, validKey, suggest, observe, botOutcome, roundDone, isSafe, status, reset, observePlay, observeTrump, playStyle, setAuto };
