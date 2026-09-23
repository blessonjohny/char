// ============================================================
// LEADERBOARD — fastest championship win, tracked separately for
// the 4-player and 6-player tables.
// ============================================================
// Per explicit request: ranks by fewest rounds taken to win a
// championship (reach the match target score -- 15 for both 4-player
// and 6-player, per explicit request to unify the two point systems),
// with fewest round-losses along the way as the
// tiebreak when two entries took the same number of rounds.
// Per further explicit request: both 4-player and 6-player now rank
// primarily by final score gap instead (biggest gap first), falling
// back to rounds taken only when the gap ties -- see
// _insertIntoTopN's scoreDiff branch below.
//
// Per explicit follow-up request: simplified down to a single all-time
// top-10 list per mode -- no more separate "today" section with its
// own daily reset. An earlier version of this file tracked both
// sections at top-3 each; this removes "today" entirely and widens the
// one remaining list from 3 to 10.
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
const TOP_N = 10;

let data = {
  allTime: { '4p': [], '6p': [] }
};
let dirty = false;
// Real, confirmed bug fix found while adding admin delete support: ts
// (Date.now()) was being used as each entry's de-facto unique id, but
// two entries can genuinely land in the same millisecond (confirmed
// directly -- a quick burst of recorded wins collided on the exact
// same ts), which meant deleting "one" entry by ts could silently
// delete every other entry that happened to share that same
// millisecond too. A dedicated counter-based id, unique regardless of
// timing, is generated for every new entry instead; ts itself is
// untouched and still used for display/sorting.
let nextEntryId = 1;
function _newEntryId() { return `${Date.now()}-${nextEntryId++}`; }

// Per explicit change: allTime used to be a single {entry}-or-null per
// mode, then a top-3 list; now it's top-10. Migrates an existing
// on-disk file from either older shape rather than discarding it or
// crashing on it -- a real player's genuine best record from before
// this change shouldn't just vanish.
function _migrateAllTimeShape(loaded) {
  if (!loaded || !loaded.allTime) return;
  for (const mode of ['4p', '6p']) {
    const v = loaded.allTime[mode];
    if (Array.isArray(v)) continue; // already a list
    loaded.allTime[mode] = v ? [v] : [];
  }
}

// Per explicit change: older entries (recorded before opponents were
// tracked at all) won't have an opponentNames field -- backfills an
// empty array rather than leaving it undefined, so display code never
// has to special-case a missing field.
function _migrateOpponentNames(loaded) {
  if (!loaded) return;
  const section = loaded.allTime;
  if (!section) return;
  for (const mode of ['4p', '6p']) {
    const list = section[mode];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (!Array.isArray(entry.opponentNames)) entry.opponentNames = [];
    }
  }
}

// Real, confirmed bug fix: backfills a genuinely unique "id" onto any
// entry already sitting on disk from before this field existed at all
// (every entry saved on a live server prior to this change). Without
// this, those older entries would have no id to delete by at all --
// admin delete would silently fail on exactly the entries most likely
// to be old test/junk data someone actually wants to clean up.
function _migrateEntryIds(loaded) {
  if (!loaded || !loaded.allTime) return;
  for (const mode of ['4p', '6p']) {
    const list = loaded.allTime[mode];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (!entry.id) entry.id = _newEntryId();
    }
  }
}

function loadLeaderboard() {
  try {
    if (fs.existsSync(LEADERBOARD_FILE)) {
      const loaded = JSON.parse(fs.readFileSync(LEADERBOARD_FILE, 'utf8'));
      _migrateAllTimeShape(loaded);
      _migrateOpponentNames(loaded);
      _migrateEntryIds(loaded);
      // Per explicit follow-up request: "today" is dropped entirely
      // here too, even if an older on-disk file still has it -- only
      // allTime ever gets carried forward now.
      data = { allTime: { '4p': (loaded.allTime && loaded.allTime['4p']) || [], '6p': (loaded.allTime && loaded.allTime['6p']) || [] } };
      console.log(`[leaderboard] Loaded existing leaderboard data from disk.`);
    }
  } catch (e) {
    console.error('[leaderboard] Failed to load leaderboard file, starting fresh:', e.message);
  }
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

// Inserts entry into the given top-N list for one mode, re-sorts, and
// truncates back to TOP_N.
// Per explicit request: 6-player now ranks by score gap first
// (biggest gap wins), falling back to rounds taken only when the gap
// ties -- a different rule from 4-player's existing rounds-first,
// roundLosses-tiebreak ranking, which is untouched and still used
// whenever scoreDiff isn't present on an entry (backward-compatible
// with existing 4p data and any pre-existing 6p entries recorded
// before this change).
function _insertIntoTopN(list, entry) {
  list.push(entry);
  list.sort((x, y) => {
    if (typeof x.scoreDiff === 'number' && typeof y.scoreDiff === 'number') {
      return x.scoreDiff !== y.scoreDiff ? y.scoreDiff - x.scoreDiff : x.rounds - y.rounds;
    }
    return x.rounds !== y.rounds ? x.rounds - y.rounds : x.roundLosses - y.roundLosses;
  });
  return list.slice(0, TOP_N);
}

// mode is '4p' or '6p'. playerNames is an array of the winning team's
// player names. rounds is how many rounds this specific championship
// took. roundLosses is how many of those rounds the winning team lost.
// opponentNames (per explicit request) is an array of the losing
// team's names -- optional/backward-compatible, defaults to empty.
// scoreDiff is the final point gap between the winning and losing team
// -- used for ranking only. winningScore/losingScore (per explicit
// follow-up request) are the actual final numbers themselves (e.g. 15
// and 7), used for DISPLAY so the popup can show "15-7" instead of just
// the bare gap -- all three are optional/backward-compatible, only
// present when the caller actually passes them.
function recordChampionshipWin(mode, playerNames, rounds, roundLosses, opponentNames, scoreDiff, winningScore, losingScore) {
  if (mode !== '4p' && mode !== '6p') return;
  const entry = {
    id: _newEntryId(),
    names: playerNames.slice(),
    opponentNames: Array.isArray(opponentNames) ? opponentNames.slice() : [],
    rounds,
    roundLosses,
    ts: Date.now()
  };
  if (typeof scoreDiff === 'number') entry.scoreDiff = scoreDiff;
  if (typeof winningScore === 'number' && typeof losingScore === 'number') {
    entry.winningScore = winningScore;
    entry.losingScore = losingScore;
  }

  data.allTime[mode] = _insertIntoTopN(data.allTime[mode], entry);
  dirty = true;
  saveLeaderboard();
}

function getLeaderboard() {
  return {
    allTime: { '4p': data.allTime['4p'].slice(), '6p': data.allTime['6p'].slice() }
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
  }
  if (mode === '6p' || mode === undefined) {
    data.allTime['6p'] = [];
  }
  dirty = true;
  saveLeaderboard();
}

// Per explicit request: a simple, manual way to carry leaderboard data
// across a deploy on a host with an ephemeral filesystem -- export the
// current data right before deploying, import it right back after.
// Deliberately a full overwrite, not a merge, to keep this predictable:
// whatever's imported becomes the new state exactly as given. Validates
// the shape defensively since this comes from a file an admin picked,
// not internal state -- a malformed or unrelated JSON file is ignored
// per-field rather than partially corrupting what's already there.
// Per explicit follow-up request: only ever reads the allTime section
// now, even from an older export file that still has a "today" section
// -- that section is simply ignored rather than imported.
function importLeaderboard(imported) {
  if (!imported || typeof imported !== 'object') return false;
  let touchedAnything = false;
  if (imported.allTime && typeof imported.allTime === 'object') {
    for (const mode of ['4p', '6p']) {
      const list = imported.allTime[mode];
      if (!Array.isArray(list)) continue;
      data.allTime[mode] = list
        .filter(e => e && Array.isArray(e.names) && typeof e.rounds === 'number' && typeof e.roundLosses === 'number')
        .map(e => {
          const entry = {
            id: e.id || _newEntryId(),
            names: e.names.slice(),
            opponentNames: Array.isArray(e.opponentNames) ? e.opponentNames.slice() : [],
            rounds: e.rounds,
            roundLosses: e.roundLosses,
            ts: typeof e.ts === 'number' ? e.ts : Date.now()
          };
          if (typeof e.scoreDiff === 'number') entry.scoreDiff = e.scoreDiff;
          if (typeof e.winningScore === 'number' && typeof e.losingScore === 'number') {
            entry.winningScore = e.winningScore;
            entry.losingScore = e.losingScore;
          }
          return entry;
        })
        .slice(0, TOP_N);
      touchedAnything = true;
    }
  }
  if (touchedAnything) { dirty = true; saveLeaderboard(); }
  return touchedAnything;
}

loadLeaderboard();
setInterval(saveLeaderboard, 10000);
process.on('SIGTERM', () => { saveLeaderboard(); });
process.on('SIGINT', () => { saveLeaderboard(); });

// Per explicit request: lets the admin panel remove specific entries
// (one at a time, or several at once via a checkbox-and-delete flow) --
// there was previously no way to remove a bad/test/duplicate entry
// short of wiping the entire mode's list via resetLeaderboard(). mode
// is '4p' or '6p'. ids is an array of each entry's own "id" field (see
// _newEntryId -- NOT ts, which can collide between entries recorded in
// the same millisecond). Returns how many rows actually got removed.
function deleteEntries(mode, ids) {
  if (mode !== '4p' && mode !== '6p') return 0;
  if (!Array.isArray(ids) || ids.length === 0) return 0;
  const toRemove = new Set(ids);
  const before = data.allTime[mode].length;
  data.allTime[mode] = data.allTime[mode].filter(e => !toRemove.has(e.id));
  const removed = before - data.allTime[mode].length;
  if (removed > 0) { dirty = true; saveLeaderboard(); }
  return removed;
}

module.exports = { recordChampionshipWin, getLeaderboard, resetLeaderboard, importLeaderboard, deleteEntries, loadLeaderboard, saveLeaderboard };
