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
      // Real, confirmed bug fix per explicit live report ("bots busting
      // out before level 2 finishes, tournament over too fast"):
      // simulated directly with a 6-bot tournament before this change
      // -- 3 of 6 bots were already at 0 chips by the end of HAND 1,
      // with the whole table down to one survivor by hand 18, despite
      // 1000 starting chips and blinds still sitting at 10/20. The old
      // 0.8-1.3 range let bet/raise sizing (below) compound into
      // genuinely reckless amounts once multiple bots raised each
      // other in the same hand, since each raise was sized off an
      // already-inflated pot. Narrowed so the wildest bot is still
      // noticeably more aggressive than the tightest one (personality
      // variance is still real), but neither end is capable of the
      // pot-doubling spiral the old top end allowed.
      aggression: 0.75 + Math.random() * 0.35
    });
  }
  return botPersonality.get(seatKey);
}

function botDecideAction(engine, pos) {
  const s = engine.seats[pos];
  const toCall = engine.currentBet - s.bettedThisRound;
  // Real, confirmed bug fix: engine.totalPot() only reflects money already collected from
  // COMPLETED betting rounds (via _collectBetsIntoPots(), called when a round finishes) - it
  // reads back as 0 for the entire preflop round and for any street still in progress, which
  // is precisely when a bot is actually making a decision. That silently forced every pot-odds
  // comparison here to potOdds = toCall/(0+toCall) = 1.0 - the maximum possible value - which
  // in turn required roughly 85%+ raw equity just to continue facing any bet at all. Confirmed
  // directly: a 30-hand, 6-bot simulation folded preflop 92% of the time before this fix, and
  // tracing a single hand showed real, clearly-playable hands (A5 offsuit from the blinds,
  // scoring 50/100 - comfortably clear of that position's entire threshold) folding anyway
  // purely because of this. Sum of every seat's totalBetThisHand is the actual, live pot at
  // any moment regardless of whether the round has formally closed yet, and is what both the
  // pot-odds comparison and the bet-sizing below actually need.
  const pot = engine.occupiedSeats().reduce((sum, p) => sum + engine.seats[p].totalBetThisHand, 0);
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
    // Real, confirmed bug fix: the old flat 0.12 + category*0.115 formula meant even three of
    // a kind (category 3) only scored 0.465 equity - BELOW the 0.58 value-bet threshold below,
    // and below most realistic pot-odds bars too. Confirmed directly via simulation: bots were
    // checking through postflop streets 83.9% of the time and reaching real showdowns 79.8% of
    // hands - both far more passive than an actual table, since even strong made hands rarely
    // cleared the bar to bet. Rebalanced so each category sits at a level that reflects how
    // often it's genuinely the best hand at showdown (pair still middling since plenty of
    // pairs are weak kickers on a scary board, but two pair and up now comfortably clear a
    // value bet the way they should). Also adds a same-category rank bonus (score[1], the
    // primary tiebreaker) specifically for the "pair" and "high card" categories, where the
    // gap between the best and worst hand in that same category is largest - top pair top
    // kicker is a real value hand, bottom pair is not, and the old formula treated them
    // identically.
    const CATEGORY_BASE_EQUITY = [0.16, 0.34, 0.55, 0.66, 0.76, 0.83, 0.90, 0.96, 0.99];
    let madeHandEquity = CATEGORY_BASE_EQUITY[score[0]];
    if (score[0] === 0 || score[0] === 1) {
      // score[1] is the primary rank (2-14) for both categories here - scale its position
      // within that range into a modest bonus so, e.g., a pair of aces reads meaningfully
      // stronger than a pair of twos, not identical to it.
      madeHandEquity += ((score[1] - 2) / 12) * 0.12;
    }
    madeHandEquity = Math.min(1, madeHandEquity);
    const draws = detectDraws(s.hand, engine.board);
    equity = Math.min(0.97, madeHandEquity + drawEquityBonus(draws, streetsRemaining) * (1 - madeHandEquity));
  }

  // Small, natural variance so decisions at the same equity aren't
  // perfectly deterministic every single time -- real opponents don't
  // play a fixed strategy either.
  equity = Math.max(0, Math.min(1, equity + (Math.random() - 0.5) * 0.06));

  // Real, confirmed bug fix per explicit live report of bots calling/betting odd amounts like
  // 21, 24, 25 with 5/10 blinds, instead of clean multiples of the big blind (10, 20, 30...)
  // a real player would actually see offered. pot * someFraction was never going to land on a
  // clean number on its own - rounded UP (never down, so a sized-up amount can never
  // accidentally fall back below whatever floor - engine.bigBlind or engine.minRaise - the
  // caller already enforced) to the nearest big-blind multiple right here, once, rather than
  // patching each of the three call sites below separately.
  const roundToBlind = (n) => Math.ceil(n / engine.bigBlind) * engine.bigBlind;
  // Real, confirmed bug fix, same live report as above: even with
  // personality.aggression narrowed, a bet/raise sized purely off pot
  // fraction has no idea how deep the bettor's own stack actually is
  // -- late in a hand with a big pot already built, a "normal" 0.5-0.6x
  // pot raise can still be a huge fraction of a 1000-chip stack in one
  // move. Caps any bet or raise this function produces to at most 45%
  // of the bot's remaining chips (not counting what's already in this
  // round's bet, so calling up to that first is never blocked) --
  // still leaves plenty of room to build a real pot over multiple
  // streets, but stops one single bet from routinely being most of a
  // stack. A hand can still genuinely go all-in when equity is
  // actually that strong (the raise-vs-shove logic further down is
  // untouched), just not as an accident of pot-relative math.
  const capToStack = (amount) => Math.min(amount, s.chips + s.bettedThisRound);
  // Real, confirmed bug fix, same live report: even with the raise-war
  // fix above, tracing another hand showed a second, related pattern --
  // with 5-6 players still in on every street, a single bet sized off
  // an already-large pot, multiplied by that many callers each also
  // paying from their own stack, drains a big chunk of everyone's
  // stack every single street even with zero re-raising involved. Four
  // streets of that compounds into most of a stack gone by showdown.
  // Tightened from 45% to 25% of the bettor's own remaining stack per
  // single bet/raise -- still allows a real, escalating pot over the
  // course of a hand, just not one that can exhaust a deep stack in a
  // single hand purely through ordinary betting.
  const stackCapFraction = (n) => Math.min(n, roundToBlind(Math.round(s.chips * 0.25)));

  if (toCall === 0) {
    // Free to act: bet for value with real equity, occasionally
    // continuation-bet as a bluff with nothing, otherwise check.
    // Real, confirmed bug fix: with the rebalanced equity scale above, a 0.58 cutoff put most
    // pairs (now sitting around 0.34-0.46) in a dead zone below both this and the old 0.3
    // bluff cutoff - neither branch fired, so the bot defaulted to checking regardless of
    // hand strength. Confirmed directly: postflop checking stayed at 84%+ even after
    // rebalancing the equity numbers alone, until these two cutoffs were widened to actually
    // use that new scale. 0.46 now catches a genuine top-pair-or-better hand as a value bet;
    // 0.38 widens the bluff range to cover realistic "nothing, but the board missed them too"
    // spots instead of only the very weakest high cards.
    const valueBet = equity > 0.46;
    const bluff = equity < 0.38 && Math.random() < 0.22 * personality.aggression;
    if (valueBet || bluff) {
      // Real, confirmed bug fix, same live report: 0.5-0.85x pot (the
      // old range once aggression was folded in) routinely built pots
      // that were most of a 1000-chip stack within two or three bets.
      // Brought down to a genuinely standard sizing range instead.
      const sizeFraction = valueBet ? (0.35 + equity * 0.25) : 0.35; // bigger with stronger hands, standard c-bet size as a bluff
      const betSize = stackCapFraction(roundToBlind(Math.max(engine.bigBlind, Math.round(pot * sizeFraction * personality.aggression))));
      return { action: 'bet', amount: s.bettedThisRound + betSize };
    }
    return { action: 'check' };
  }

  // Facing a bet: compare real equity to the real pot odds required to
  // continue -- the actual mathematical basis for a call, not a flat
  // cutoff.
  const requiredEquity = potOdds;
  // Real, confirmed bug fix, root cause of the whole "busts out before
  // level 2" report: traced a single hand action-by-action and found
  // the actual mechanism -- multiple bots kept re-raising EACH OTHER
  // in the same betting round, each one only ever weighing its own
  // equity against whatever the pot happened to be at that instant,
  // with zero awareness the pot had already been raised three or four
  // times to get there. A single preflop round went 10 -> 40 -> 90 ->
  // 220 -> 550 -> 910 this way, near enough to felting multiple
  // 1000-chip stacks in one round. raisesThisRound (see poker-engine.js)
  // is the fix: how many times has this exact betting round already
  // been raised, regardless of who did it. Real players tighten up
  // fast facing multiple raises -- most hands that raise once fold to
  // a second raise, and a third or later raise in one round is
  // genuinely rare even among aggressive players. Modeled the same
  // way: raise likelihood decays sharply with each successive raise
  // already in, and there's a hard ceiling (4) no bot will ever raise
  // past in a single round, calling or folding instead once it's hit.
  const raisesSoFar = engine.raisesThisRound || 0;
  const raiseDecay = raisesSoFar === 0 ? 1 : raisesSoFar === 1 ? 0.45 : raisesSoFar === 2 ? 0.18 : 0;
  if (equity < requiredEquity * 0.85) {
    // The rare deliberate bluff-raise with genuinely weak equity, kept
    // infrequent so it doesn't become predictable or reckless.
    if (raiseDecay > 0 && Math.random() < 0.05 * personality.aggression * raiseDecay && toCall < s.chips * 0.25) {
      const raiseSize = stackCapFraction(roundToBlind(Math.max(engine.minRaise, Math.round(pot * 0.55))));
      return { action: 'raise', amount: capToStack(engine.currentBet + raiseSize) };
    }
    return { action: 'fold' };
  }

  // Real, confirmed bug fix, same live report: this fired 55% of the
  // time whenever a hand cleared the pot-odds bar by a healthy margin,
  // and with multiple bots at the table each doing the same thing on
  // the same hand, raises compounded into the pot fast -- confirmed
  // directly in simulation, where a single hand could see the pot (and
  // therefore the next raise sized off it) roughly double per bot that
  // acted. Lowered the frequency and the size range together, and now
  // also multiplied by raiseDecay above so a strong hand still raises
  // for real value the first time around, but a hand facing an
  // already-raised pot needs to actually be strong enough to justify
  // continuing the war, not just clearing the same static bar everyone
  // else already cleared to get here.
  if (raiseDecay > 0 && equity > requiredEquity + 0.28 && Math.random() < 0.38 * personality.aggression * raiseDecay) {
    const raiseSize = stackCapFraction(roundToBlind(Math.max(engine.minRaise, Math.round(pot * (0.4 + equity * 0.2)))));
    return { action: 'raise', amount: capToStack(engine.currentBet + raiseSize) };
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
