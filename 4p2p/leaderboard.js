// ============================================================
// LEADERBOARD — fastest championship win, tracked separately for
// the 4-player and 6-player tables.
// ============================================================
// Per explicit request: ranks by fewest rounds taken to win a
// championship (reach the match target score -- 12 for 4-player,
// 15 for 6-player), with fewest round-losses along the way as the
// tiebreak when two entries took the same number of rounds.
//
// Two sections per mode, per explicit request:
//   - allTime: the single best entry ever recorded, kept forever.
//   - today: up to the top 3 entries recorded since the last daily
//     reset, resetting fresh every day. Uses the same 5am US Eastern
//     boundary as the rest of the app's own daily reset (see
//     dailyCloseAllTables() in server.js), not UTC midnight or the
//     server process's own local time, so "today" means the same
//     thing here as it does everywhere else in this app.
//
// Persists to a JSON file on disk, same pattern as bot-brain.js.
// ============================================================

const fs = require('fs');
const path = require('path');

const LEADERBOARD_FILE = path.join(__dirname, 'leaderboard-data.json');

let data = {
  allTime: { '4p': null, '6p': null },
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

function loadLeaderboard() {
  try {
    if (fs.existsSync(LEADERBOARD_FILE)) {
      const loaded = JSON.parse(fs.readFileSync(LEADERBOARD_FILE, 'utf8'));
      data = Object.assign({ allTime: { '4p': null, '6p': null }, today: { '4p': [], '6p': [] }, todayDateKey: null }, loaded);
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

// Returns true if entry A is a strictly better (faster) championship
// than entry B: fewer rounds first, fewer round-losses as the tiebreak.
// Equal on both counts is NOT better -- ties keep the earlier record
// (first to achieve it holds the spot), matching how records normally
// work.
function _isBetter(a, b) {
  if (!b) return true;
  if (a.rounds !== b.rounds) return a.rounds < b.rounds;
  return a.roundLosses < b.roundLosses;
}

// mode is '4p' or '6p'. playerNames is an array of the winning team's
// player names. rounds is how many rounds this specific championship
// took. roundLosses is how many of those rounds the winning team lost.
function recordChampionshipWin(mode, playerNames, rounds, roundLosses) {
  if (mode !== '4p' && mode !== '6p') return;
  _rolloverIfNeeded();
  const entry = {
    names: playerNames.slice(),
    rounds,
    roundLosses,
    ts: Date.now()
  };

  if (_isBetter(entry, data.allTime[mode])) {
    data.allTime[mode] = entry;
    dirty = true;
  }

  const list = data.today[mode];
  list.push(entry);
  list.sort((x, y) => x.rounds !== y.rounds ? x.rounds - y.rounds : x.roundLosses - y.roundLosses);
  data.today[mode] = list.slice(0, 3);
  dirty = true;
  saveLeaderboard();
}

function getLeaderboard() {
  _rolloverIfNeeded();
  return {
    allTime: { '4p': data.allTime['4p'], '6p': data.allTime['6p'] },
    today: { '4p': data.today['4p'].slice(), '6p': data.today['6p'].slice() }
  };
}

loadLeaderboard();
setInterval(saveLeaderboard, 10000);
process.on('SIGTERM', () => { saveLeaderboard(); });
process.on('SIGINT', () => { saveLeaderboard(); });

module.exports = { recordChampionshipWin, getLeaderboard, loadLeaderboard, saveLeaderboard };
