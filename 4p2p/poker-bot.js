const { evaluateBest } = require('./poker-hand-eval');

// Deliberately simple, functional bot logic -- not GTO-optimal poker
// strategy (that's a much bigger project on its own), just reasonable
// enough to fill empty seats and give a human something to play against.
// Bases its decision on hand strength relative to the board, position
// in the betting, and how much it costs to continue.
function botDecideAction(engine, pos) {
  const s = engine.seats[pos];
  const toCall = engine.currentBet - s.bettedThisRound;
  const potOdds = toCall > 0 ? toCall / (engine.totalPot() + toCall) : 0;

  let strength = 0.3; // baseline for an unresolved hand pre-flop
  if (engine.board.length >= 3) {
    const { score } = evaluateBest([...s.hand, ...engine.board]);
    // score[0] is the hand-type index 0-8 (High Card..Straight Flush) --
    // a crude but serviceable strength proxy for a simple bot.
    strength = Math.min(1, 0.15 + score[0] * 0.11);
  } else {
    // Preflop: rough strength from hole cards alone (pairs and high
    // cards read as stronger, same spirit as real preflop charts
    // without needing the full chart).
    const ranks = s.hand.map(c => c.rank);
    const isPair = ranks[0] === ranks[1];
    const highCardBonus = s.hand.some(c => ['A','K','Q'].includes(c.rank)) ? 0.15 : 0;
    strength = (isPair ? 0.55 : 0.25) + highCardBonus + Math.random() * 0.1;
  }

  // A little randomness so bots aren't perfectly predictable/exploitable.
  strength += (Math.random() - 0.5) * 0.15;

  if (toCall === 0) {
    // Free to check -- occasionally bet with a decent hand, otherwise check.
    if (strength > 0.55 && Math.random() < 0.6) {
      const betSize = Math.max(engine.bigBlind, Math.round(engine.totalPot() * 0.5));
      return { action: 'bet', amount: s.bettedThisRound + betSize };
    }
    return { action: 'check' };
  }

  // Facing a bet: fold weak hands that don't justify the pot odds, call
  // marginal ones, raise strong ones.
  if (strength < potOdds * 0.8 && strength < 0.35) return { action: 'fold' };
  if (strength > 0.7 && Math.random() < 0.5) {
    const raiseSize = Math.max(engine.minRaise, Math.round(engine.totalPot() * 0.6));
    return { action: 'raise', amount: engine.currentBet + raiseSize };
  }
  if (toCall >= s.chips) {
    // Calling would put them all-in anyway -- only do it with real strength.
    return strength > 0.45 ? { action: 'call' } : { action: 'fold' };
  }
  return { action: 'call' };
}

// Drives a bot's actual turn -- called by the server after a short,
// human-feeling delay, same pattern as the other games' bot pacing.
function botAct(engine, pos) {
  if (engine.currentPlayer !== pos) return;
  const seat = engine.seats[pos];
  if (!seat || !seat.isBot || seat.folded || seat.allIn) return;
  const decision = botDecideAction(engine, pos);
  const result = engine.act(pos, decision.action, decision.amount);
  if (!result.ok) {
    // Never leave the table stuck on a rejected bot action -- fall back
    // to the safest legal move.
    const toCall = engine.currentBet - seat.bettedThisRound;
    engine.act(pos, toCall > 0 ? 'fold' : 'check');
  }
}

module.exports = { botDecideAction, botAct };
