// Pacing for bots (fast) and ghost players (human-like) (shared by the 4p / 6p engines).
// Regular bots: quick (about 1s card play, 1-2s bidding / trump). Only ghost players get the slow human-like bidding pause.
// Ghosts: card plays 2-3s; bidding 2.8-4.4s; and roughly once every 2-3 rounds a ghost
// takes one longer 4-5.5s "hmm, let me think" pause (at most once per round, so it never feels laggy).
function isBidPhase(phase) { return phase === 'bidding1' || phase === 'bidding2' || phase === 'choosingTrump'; }
function botDelay(phase) {
  // Regular bots on normal tables: quick and regular. (The slow, human-like bidding pause is ghost-only.)
  if (!isBidPhase(phase)) return 900;
  return 1000 + Math.floor(Math.random() * 1000);   // 1-2s
}
function ghostDelay(engine, phase) {
  // A fast player who really knows the game: about a second slower than before so it never looks machine-quick.
  if (engine._bluePauseRound !== engine.round && Math.random() < 0.045) {
    engine._bluePauseRound = engine.round;
    return 4000 + Math.floor(Math.random() * 1500);
  }
  if (isBidPhase(phase)) return 2800 + Math.floor(Math.random() * 1600);
  const r = Math.random();
  if (r < 0.90) return 2000 + Math.floor(Math.random() * 1000);   // 2-3s
  if (r < 0.95) return 1300 + Math.floor(Math.random() * 700);    // quicker: 1.3-2s
  return 3000 + Math.floor(Math.random() * 1000);                 // slower: 3-4s
}
module.exports = { botDelay, ghostDelay, isBidPhase };
