// ============================================================
// CHALLENGE LEADERBOARD — top 10 challenge-table winners, tracked
// separately for the 4-player and 6-player tables, and separately
// from the regular fastest-championship leaderboard in leaderboard.js.
// ============================================================
// Per explicit request: a "challenge table" lets its creator start a
// deliberate deficit (5, 10, or 13 points) against their own team for
// the first championship, and be forced into the first bid of that
// first round -- beating the championship despite that deficit is the
// "challenge win" this file tracks.
//
// Ranking (per explicit request): "priority is if someone beat the
// hardest level starting 0-13... then if 2 same as before points and
// rounds" -- so entries are ranked by handicap difficulty FIRST
// (13 beats 10 beats 5, regardless of anything else), and only within
// the same handicap does it fall back to the exact same scoreDiff-
// then-rounds tiebreak leaderboard.js already uses ("as before").
//
// Persists to a JSON file on disk, same pattern as leaderboard.js and
// bot-brain.js.
// ============================================================

const fs = require('fs');
const path = require('path');

const CHALLENGE_LEADERBOARD_FILE = path.join(__dirname, 'challenge-leaderboard-data.json');
const TOP_N = 10;

let data = {
  allTime: { '4p': [], '6p': [] }
};
let dirty = false;
let nextEntryId = 1;
function _newEntryId() { return `ch-${Date.now()}-${nextEntryId++}`; }

function loadChallengeLeaderboard() {
  try {
    if (fs.existsSync(CHALLENGE_LEADERBOARD_FILE)) {
      const loaded = JSON.parse(fs.readFileSync(CHALLENGE_LEADERBOARD_FILE, 'utf8'));
      data = { allTime: { '4p': (loaded.allTime && loaded.allTime['4p']) || [], '6p': (loaded.allTime && loaded.allTime['6p']) || [] } };
      console.log('[challenge-leaderboard] Loaded existing data from disk.');
    }
  } catch (e) {
    console.error('[challenge-leaderboard] Failed to load file, starting fresh:', e.message);
  }
}

function saveChallengeLeaderboard() {
  if (!dirty) return;
  try {
    fs.writeFileSync(CHALLENGE_LEADERBOARD_FILE, JSON.stringify(data));
    dirty = false;
  } catch (e) {
    console.error('[challenge-leaderboard] Failed to save file:', e.message);
  }
}

// Inserts entry into the given top-N list for one mode, re-sorts, and
// truncates back to TOP_N. Ranks by handicap first (higher = harder =
// better), then falls back to leaderboard.js's own scoreDiff-then-
// rounds tiebreak when the handicap ties.
function _insertIntoTopN(list, entry) {
  list.push(entry);
  list.sort((x, y) => {
    if (x.handicap !== y.handicap) return y.handicap - x.handicap;
    if (x.scoreDiff !== y.scoreDiff) return y.scoreDiff - x.scoreDiff;
    return x.rounds - y.rounds;
  });
  return list.slice(0, TOP_N);
}

// mode is '4p' or '6p'. handicap is 5, 10, or 13 -- the deficit the
// challenger's team actually started with and overcame. playerNames is
// the challenger team's names, opponentNames the team they beat.
// rounds/roundLosses/scoreDiff/winningScore/losingScore mirror
// leaderboard.js's own recordChampionshipWin signature exactly, for
// the same tiebreak and display purposes.
function recordChallengeWin(mode, handicap, playerNames, opponentNames, rounds, roundLosses, scoreDiff, winningScore, losingScore) {
  if (mode !== '4p' && mode !== '6p') return;
  if (handicap !== 5 && handicap !== 10 && handicap !== 13) return;
  const entry = {
    id: _newEntryId(),
    handicap,
    names: playerNames.slice(),
    opponentNames: Array.isArray(opponentNames) ? opponentNames.slice() : [],
    rounds,
    roundLosses,
    scoreDiff,
    winningScore,
    losingScore,
    ts: Date.now()
  };
  data.allTime[mode] = _insertIntoTopN(data.allTime[mode], entry);
  dirty = true;
  saveChallengeLeaderboard();
}

function getChallengeLeaderboard() {
  return {
    allTime: { '4p': data.allTime['4p'].slice(), '6p': data.allTime['6p'].slice() }
  };
}

function resetChallengeLeaderboard(mode) {
  if (mode === '4p' || mode === undefined) data.allTime['4p'] = [];
  if (mode === '6p' || mode === undefined) data.allTime['6p'] = [];
  dirty = true;
  saveChallengeLeaderboard();
}

loadChallengeLeaderboard();
setInterval(saveChallengeLeaderboard, 30000);

module.exports = {
  recordChallengeWin,
  getChallengeLeaderboard,
  resetChallengeLeaderboard,
};
