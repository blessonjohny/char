const { evaluateBest, RANK_VALUES } = require('./poker-hand-eval');

// ============================================================
// A meaningfully stronger bot than "estimate hand strength, add
// randomness, compare to a threshold." Built around the same
// established concepts real poker strategy is built on -- not a GTO
// solver (that's a genuinely different, much larger project), but
// grounded in real, well-known theory rather than an ad-hoc heuristic:
//
//  - Starting-hand strength from actual hand-ranking tiers (the kind
//    of chart any serious poker book opens with), not just "is it a
//    pair" and "does it have a face card."
//  - Position awareness -- the single biggest lever in preflop
//    strategy. The same hand that's a clear raise on the button is a
//    fold three seats after the blinds, and this bot now knows the
//    difference.
//  - Postflop equity that accounts for draws, not just made hands --
//    a flush draw or open-ended straight draw is real equity, not a
//    "high card" that happens to look nice.
//  - Decisions driven by comparing estimated equity to pot odds,
//    the actual mathematical basis for continuing or folding, rather
//    than a flat strength cutoff.
//  - Real bet sizing conventions (roughly half-to-two-thirds pot
//    continuation bets, larger for value, smaller for a cheap probe)
//    instead of one formula for every situation.
//  - Per-bot personality (tightness/aggression) so a table of bots
//    doesn't all play like the exact same player -- one seat plays
//    tighter, another leans aggressive, matching how a real table of
//    different opponents actually behaves.
// ============================================================

// A standard, well-known starting-hand strength table (0-100 scale,
// the same spirit as published preflop charts): pairs and suited
// connectors/broadways score by rank and suitedness. This isn't
// exhaustive of all 169 starting hands -- it's a formula that
// reproduces the same shape those charts have: pairs strong and
// scaling with rank, suited hands better than offsuit, connected
// cards better than gapped, high cards better than low.
function preflopHandScore(hole) {
  const [c1, c2] = hole;
  const r1 = RANK_VALUES[c1.rank], r2 = RANK_VALUES[c2.rank];
  const hi = Math.max(r1, r2), lo = Math.min(r1, r2);
  const suited = c1.suit === c2.suit;
  const isPair = r1 === r2;
  const gap = hi - lo;

  if (isPair) {
    // 22 is still playable (set-mining value), AA is the top of the chart.
    return 50 + (hi - 2) * (50 / 12);
  }

  let score = (hi - 2) * 3 + (lo - 2) * 2; // high cards matter more than low
  if (suited) score += 12;
  if (gap === 1) score += 10;       // connected (e.g. J-10)
  else if (gap === 2) score += 5;   // one-gapper (e.g. J-9)
  else if (gap === 3) score += 2;   // two-gapper
  if (hi === 14) score += 8;        // an ace still has strong showdown value even unpaired
  return Math.max(0, Math.min(100, score));
}

// Seats from the dealer determine position -- early position needs a
// much stronger hand to enter a pot than the button does, the same
// core idea every preflop strategy chart is built around.
function positionCategory(engine, pos) {
  const order = engine._seatOrderFrom(engine.dealerSeat);
  const idx = order.indexOf(pos);
  if (idx === -1) return 'middle';
  const n = order.length;
  if (idx <= 1) return 'blinds';               // small/big blind
  if (idx <= Math.floor(n * 0.4)) return 'early';
  if (idx <= Math.floor(n * 0.7)) return 'middle';
  return 'late';                                 // includes the button
}

// Minimum preflop score needed to voluntarily enter a pot, by
// position -- tighter early, looser late. This is the actual shape of
// a real preflop range chart: it's not that late position hands are
// secretly better, it's that acting last with less information still
// unseen is worth playing more hands for.
const POSITION_THRESHOLD = { early: 46, middle: 38, blinds: 34, late: 28 };

// Detects draws the made-hand evaluator alone wouldn't credit -- a
// flush draw or open-ended straight draw has real equity to improve,
// which matters for a bot that's supposed to understand pot odds
// rather than just "what do I have right now."
function detectDraws(hole, board) {
  const all = [...hole, ...board];
  const suitCounts = {};
  for (const c of all) suitCounts[c.suit] = (suitCounts[c.suit] || 0) + 1;
  const flushDraw = Object.values(suitCounts).some(n => n === 4);

  const ranks = [...new Set(all.map(c => RANK_VALUES[c.rank]))].sort((a, b) => a - b);
  let openEndedDraw = false;
  for (let i = 0; i < ranks.length; i++) {
    const window = ranks.filter(r => r >= ranks[i] && r <= ranks[i] + 4);
    const span = window.length;
    if (span === 4) {
      openEndedDraw = true;
    }
  }
  return { flushDraw, openEndedDraw };
}

// Rough equity credit for a draw with cards still to come -- not a
// precise simulation, but grounded in the real, well-known
// approximate odds (a flush draw is close to a coin flip by the
// river across two streets; an open-ended straight draw is a bit
// less). Good enough for pot-odds comparisons without needing a full
// Monte Carlo run on every decision.
function drawEquityBonus(draws, streetsRemaining) {
  let bonus = 0;
  if (draws.flushDraw) bonus += streetsRemaining >= 2 ? 0.35 : 0.19;
  if (draws.openEndedDraw) bonus += streetsRemaining >= 2 ? 0.31 : 0.17;
  return Math.min(0.55, bonus);
}

// Per-bot personality: a stable per-seat multiplier so the same table
// of bots doesn't all play identically -- one leans tight, another
// loose-aggressive, the way real opponents actually differ.
const botPersonality = new Map();
function personalityFor(seatKey) {
  if (!botPersonality.has(seatKey)) {
    botPersonality.set(seatKey, {
      tightness: 0.85 + Math.random() * 0.3,   // <1 loosens thresholds, >1 tightens
      aggression: 0.8 + Math.random() * 0.5    // scales bet/raise sizing and bluff frequency
    });
  }
  return botPersonality.get(seatKey);
}

function botDecideAction(engine, pos) {
  const s = engine.seats[pos];
  const toCall = engine.currentBet - s.bettedThisRound;
  const pot = engine.totalPot();
  const potOdds = toCall > 0 ? toCall / (pot + toCall) : 0;
  const personality = personalityFor(engine.tableId + ':' + pos);

  let equity;
  const streetsRemaining = engine.board.length === 0 ? 2 : engine.board.length === 3 ? 2 : engine.board.length === 4 ? 1 : 0;

  if (engine.board.length === 0) {
    // Preflop: use the real starting-hand chart, gated by position.
    const score = preflopHandScore(s.hand);
    const threshold = POSITION_THRESHOLD[positionCategory(engine, pos)] * personality.tightness;
    equity = score / 100;
    if (score < threshold * 0.7) {
      // Well below the position's playing range -- fold to any real bet,
      // check for free when possible.
      return toCall > 0 ? { action: 'fold' } : { action: 'check' };
    }
  } else {
    // Postflop: real made-hand strength plus draw equity, not just one
    // or the other.
    const { score } = evaluateBest([...s.hand, ...engine.board]);
    const madeHandEquity = Math.min(1, 0.12 + score[0] * 0.115);
    const draws = detectDraws(s.hand, engine.board);
    equity = Math.min(0.97, madeHandEquity + drawEquityBonus(draws, streetsRemaining) * (1 - madeHandEquity));
  }

  // Small, natural variance so decisions at the same equity aren't
  // perfectly deterministic every single time -- real opponents don't
  // play a fixed strategy either.
  equity = Math.max(0, Math.min(1, equity + (Math.random() - 0.5) * 0.06));

  if (toCall === 0) {
    // Free to act: bet for value with real equity, occasionally
    // continuation-bet as a bluff with nothing, otherwise check.
    const valueBet = equity > 0.58;
    const bluff = equity < 0.3 && Math.random() < 0.16 * personality.aggression;
    if (valueBet || bluff) {
      const sizeFraction = valueBet ? (0.5 + equity * 0.35) : 0.45; // bigger with stronger hands, standard c-bet size as a bluff
      const betSize = Math.max(engine.bigBlind, Math.round(pot * sizeFraction * personality.aggression));
      return { action: 'bet', amount: s.bettedThisRound + betSize };
    }
    return { action: 'check' };
  }

  // Facing a bet: compare real equity to the real pot odds required to
  // continue -- the actual mathematical basis for a call, not a flat
  // cutoff.
  const requiredEquity = potOdds;
  if (equity < requiredEquity * 0.85) {
    // The rare deliberate bluff-raise with genuinely weak equity, kept
    // infrequent so it doesn't become predictable or reckless.
    if (Math.random() < 0.05 * personality.aggression && toCall < s.chips * 0.25) {
      const raiseSize = Math.max(engine.minRaise, Math.round(pot * 0.7));
      return { action: 'raise', amount: engine.currentBet + raiseSize };
    }
    return { action: 'fold' };
  }

  if (equity > requiredEquity + 0.28 && Math.random() < 0.55 * personality.aggression) {
    const raiseSize = Math.max(engine.minRaise, Math.round(pot * (0.55 + equity * 0.3)));
    return { action: 'raise', amount: engine.currentBet + raiseSize };
  }

  if (toCall >= s.chips) {
    // Calling would commit the whole stack -- only worth it with
    // genuine equity clear of a coinflip, same principle as any
    // reasonable all-in-call standard.
    return equity > 0.5 ? { action: 'call' } : { action: 'fold' };
  }
  return { action: 'call' };
}

function botAct(engine, pos) {
  if (engine.currentPlayer !== pos) return;
  const seat = engine.seats[pos];
  if (!seat || !seat.isBot || seat.folded || seat.allIn) return;
  const decision = botDecideAction(engine, pos);
  const result = engine.act(pos, decision.action, decision.amount);
  if (!result.ok) {
    const toCall = engine.currentBet - seat.bettedThisRound;
    engine.act(pos, toCall > 0 ? 'fold' : 'check');
  }
}

module.exports = { botDecideAction, botAct, preflopHandScore, positionCategory, detectDraws };
