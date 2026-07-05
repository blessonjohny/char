const { GameEngine } = require('./game-engine');

function runOneGame(gameNum) {
  const g = new GameEngine('test-' + gameNum);
  for (let i = 0; i < 4; i++) g.seatBot(i, 'Bot' + i);

  for (let round = 1; round <= 6; round++) {
    g.startRound();
    let guard = 0;
    while (g.phase !== 'roundEnd' && guard < 500) {
      // In real use, humans act via socket events; here everyone's a bot
      // so maybeAutoAct() (already triggered by startRound/state changes)
      // drives everything. This loop just waits for it to settle since
      // _botAct is synchronous-ish via setImmediate in this single-threaded
      // test — drain the microtask/macrotask queue manually.
      guard++;
      if (g.phase === 'bidding1' || g.phase === 'choosingTrump' || g.phase === 'bidding2' || g.phase === 'play') {
        g._botAct(g.currentPlayer);
      } else break;
    }
    if (g.phase !== 'roundEnd') {
      throw new Error(`Game ${gameNum} round ${round}: never reached roundEnd (stuck in ${g.phase}, guard=${guard})`);
    }
    const totalCards = g.seats.reduce((s, seat) => s + seat.hand.length, 0);
    if (totalCards !== 0) throw new Error(`Game ${gameNum} round ${round}: ${totalCards} cards leaked, not dealt/played correctly`);
    const r = g.roundWinnerAnnounced;
    console.log(`  [game ${gameNum}] Round ${round}: bidder=seat${r.bidder} bid=${r.highestBid} made=${r.made} teamPts=${r.teamPoints} matchScore=${g.gameScore}`);
  }
  return true;
}

let failures = 0;
for (let i = 1; i <= 25; i++) {
  try {
    runOneGame(i);
  } catch (e) {
    failures++;
    console.error('FAILURE:', e.message);
  }
}
console.log(failures === 0 ? '\n✅ All 25 simulated games completed cleanly (6 rounds each, no stuck states, no leaked cards).'
                            : `\n❌ ${failures} game(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
