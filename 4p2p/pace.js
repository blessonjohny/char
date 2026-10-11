// Human-like pacing for bots and ghost players (shared by the 4p / 6p engines).
// Bots: a thinking pause of ~2-4s when bidding or choosing trump (card plays keep their own pace).
// Ghosts: keep the existing 1-2s rhythm for card plays; bidding gets 1.8-3.2s; and roughly once every 2-3 rounds a ghost
// takes one longer 3-4.5s "hmm, let me think" pause (at most once per round, so it never feels laggy).
function isBidPhase(phase) { return phase === 'bidding1' || phase === 'bidding2' || phase === 'choosingTrump'; }
function botDelay(phase) {
  if (!isBidPhase(phase)) return 900;
  const r = Math.random();
  if (r < 0.55) return 2000 + Math.floor(Math.random() * 1000);   // 2-3s
  if (r < 0.9) return 3000 + Math.floor(Math.random() * 700);     // 3-3.7s
  return 3700 + Math.floor(Math.random() * 500);                  // up to ~4.2s
}
function ghostDelay(engine, phase) {
  if (engine._bluePauseRound !== engine.round && Math.random() < 0.045) {
    engine._bluePauseRound = engine.round;
    return 3000 + Math.floor(Math.random() * 1500);
  }
  if (isBidPhase(phase)) return 1800 + Math.floor(Math.random() * 1400);
  const r = Math.random();
  if (r < 0.90) return 1000 + Math.floor(Math.random() * 1000);
  if (r < 0.95) return 300 + Math.floor(Math.random() * 700);
  return 2000 + Math.floor(Math.random() * 1000);
}
module.exports = { botDelay, ghostDelay, isBidPhase };
