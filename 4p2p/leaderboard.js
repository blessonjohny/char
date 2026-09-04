// ============================================================
// LEADERBOARD — fastest championship win, tracked separately for
// the 4-player and 6-player tables.
// ============================================================
// Per explicit request: ranks by fewest rounds taken to win a
// championship (reach the match target score -- 12 for 4-player,
// 15 for 6-player), with fewest round-losses along the way as the
// tiebreak when two entries took the same number of rounds.
//
// Two sections per mode, both top-3 lists per explicit request
// (all-time was originally a single best entry, then explicitly
// changed to top-3 to match today's structure):
//   - allTime: the best 3 entries ever recorded, kept forever.
//   - today: up to the top 3 entries recorded since the last daily
//     reset, resetting fresh every day. Uses the same 5am US Eastern
//     boundary as the rest of the app's own daily reset (see
//     dailyCloseAllTables() in server.js), not UTC midnight or the
//     server process's own local time, so "today" means the same
//     thing here as it does everywhere else in this app.
//
// Per explicit request: each entry now also carries the opponent
// team's names alongside the winners -- previously only the winning
// side was ever recorded at all.
//
// Persists to a JSON file on disk, same pattern as bot-brain.js.
// ============================================================

const fs = require('fs');
const path = require('path');

const LEADERBOARD_FILE = path.join(__dirname, 'leaderboard-data.json');

let data = {
  allTime: { '4p': [], '6p': [] },
  today: { '4p': [], '6p': [] },
  todayDateKey: null // e.g. "2026-09-03", in America/New_York -- see currentDateKey()
};
let dirty = false;

function currentDateKey() {
  // en-CA locale formats as YYYY-MM-DD, which sorts/compares correctly
  // as a plain string -- matches the same America/New_York boundary
  // dailyCloseAllTables() already uses elsewhere in this app.
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

// Per explicit change: allTime used to be a single {entry}-or-null per
// mode; now it's a top-3 list, same shape as today. Migrates an
// existing on-disk file from the old shape rather than discarding it
// or crashing on it -- a real player's genuine best record from before
// this change shouldn't just vanish.
function _migrateAllTimeShape(loaded) {
  if (!loaded || !loaded.allTime) return;
  for (const mode of ['4p', '6p']) {
    const v = loaded.allTime[mode];
    if (Array.isArray(v)) continue; // already the new shape
    loaded.allTime[mode] = v ? [v] : [];
  }
}

// Per explicit change: older entries (recorded before opponents were
// tracked at all) won't have an opponentNames field -- backfills an
// empty array rather than leaving it undefined, so display code never
// has to special-case a missing field.
function _migrateOpponentNames(loaded) {
  if (!loaded) return;
  for (const section of [loaded.allTime, loaded.today]) {
    if (!section) continue;
    for (const mode of ['4p', '6p']) {
      const list = section[mode];
      if (!Array.isArray(list)) continue;
      for (const entry of list) {
        if (!Array.isArray(entry.opponentNames)) entry.opponentNames = [];
      }
    }
  }
}

function loadLeaderboard() {
  try {
    if (fs.existsSync(LEADERBOARD_FILE)) {
      const loaded = JSON.parse(fs.readFileSync(LEADERBOARD_FILE, 'utf8'));
      _migrateAllTimeShape(loaded);
      _migrateOpponentNames(loaded);
      data = Object.assign({ allTime: { '4p': [], '6p': [] }, today: { '4p': [], '6p': [] }, todayDateKey: null }, loaded);
      console.log(`[leaderboard] Loaded existing leaderboard data from disk.`);
    }
  } catch (e) {
    console.error('[leaderboard] Failed to load leaderboard file, starting fresh:', e.message);
  }
  _rolloverIfNeeded();
}

function saveLeaderboard() {
  if (!dirty) return;
  try {
    fs.writeFileSync(LEADERBOARD_FILE, JSON.stringify(data));
    dirty = false;
  } catch (e) {
    console.error('[leaderboard] Failed to save leaderboard file:', e.message);
  }
}

function _rolloverIfNeeded() {
  const key = currentDateKey();
  if (data.todayDateKey !== key) {
    data.todayDateKey = key;
    data.today = { '4p': [], '6p': [] };
    dirty = true;
  }
}

// Inserts entry into the given top-3 list (today or allTime for one
// mode), re-sorts by rounds then roundLosses, and truncates back to 3.
function _insertIntoTop3(list, entry) {
  list.push(entry);
  list.sort((x, y) => x.rounds !== y.rounds ? x.rounds - y.rounds : x.roundLosses - y.roundLosses);
  return list.slice(0, 3);
}

// mode is '4p' or '6p'. playerNames is an array of the winning team's
// player names. rounds is how many rounds this specific championship
// took. roundLosses is how many of those rounds the winning team lost.
// opponentNames (per explicit request) is an array of the losing
// team's names -- optional/backward-compatible, defaults to empty.
function recordChampionshipWin(mode, playerNames, rounds, roundLosses, opponentNames) {
  if (mode !== '4p' && mode !== '6p') return;
  _rolloverIfNeeded();
  const entry = {
    names: playerNames.slice(),
    opponentNames: Array.isArray(opponentNames) ? opponentNames.slice() : [],
    rounds,
    roundLosses,
    ts: Date.now()
  };

  data.allTime[mode] = _insertIntoTop3(data.allTime[mode], entry);
  data.today[mode] = _insertIntoTop3(data.today[mode], entry);
  dirty = true;
  saveLeaderboard();
}

function getLeaderboard() {
  _rolloverIfNeeded();
  return {
    allTime: { '4p': data.allTime['4p'].slice(), '6p': data.allTime['6p'].slice() },
    today: { '4p': data.today['4p'].slice(), '6p': data.today['6p'].slice() }
  };
}

// Per explicit request: a way to clear out stale/test data on an
// already-deployed server, since Claude can only ever delete its own
// local sandbox copy of this file -- a fresh zip doesn't touch
// whatever's already sitting on the actual live server's disk. mode
// is '4p', '6p', or omitted/undefined to reset both.
function resetLeaderboard(mode) {
  if (mode === '4p' || mode === undefined) {
    data.allTime['4p'] = [];
    data.today['4p'] = [];
  }
  if (mode === '6p' || mode === undefined) {
    data.allTime['6p'] = [];
    data.today['6p'] = [];
  }
  dirty = true;
  saveLeaderboard();
}

loadLeaderboard();
setInterval(saveLeaderboard, 10000);
process.on('SIGTERM', () => { saveLeaderboard(); });
process.on('SIGINT', () => { saveLeaderboard(); });

module.exports = { recordChampionshipWin, getLeaderboard, resetLeaderboard, loadLeaderboard, saveLeaderboard };
