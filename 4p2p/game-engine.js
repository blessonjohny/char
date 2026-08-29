// ============================================================
// 28 KERALA GULAN — AUTHORITATIVE GAME ENGINE
// ============================================================
// This runs on the SERVER, not in any player's browser. That's the whole
// point: previously the "host" player's browser ran this exact logic
// locally, and if their tab died, the entire game died with it — nobody
// else had a copy of the truth. Now the truth lives here, in one place,
// for as long as the table exists, independent of any single player's
// connection. Players are thin clients: they send intents (bid, playCard,
// chooseTrump...) and receive back a sanitized view of the current state
// (their own hand in full, everyone else's hand as a card-count only).
//
// Rules implemented, ported from the original client's engine:
//  - 32-card deck (7,8,9,10,J,Q,K,A x 4 suits). J=3pts, 9=2pts, A=1pt,
//    10=1pt, everything else 0pts. 28 points in the deck total.
//  - Teams are fixed by seat: seats 0 & 3 vs seats 1 & 2 (partners sit
//    directly across the table from each other, not next to each other).
//  - Bidding: 4 cards dealt first. First bidder (dealer's right) must bid
//    at least 14 and cannot pass. Bids strictly increase. Bidding ends
//    once 3 players in a row have passed after some bid exists.
//  - Bid winner picks a trump suit and sets aside ("hides") one trump
//    card from their hand face-down. Everyone is then dealt 4 more cards
//    (8 total; the bidder plays with 7 in hand + 1 hidden).
//  - Play: must follow the led suit if able. The bidder may not lead with
//    the trump suit before it's exposed unless it's their only suit.
//    Trump is "exposed" the moment anyone plays a trump card (forced,
//    because they couldn't follow suit) or the bidder deliberately plays
//    their hidden card. Once exposed, the hidden card returns to the
//    bidder's hand and trump beats every other suit for the rest of the
//    round.
//  - If the bidder's 7 in-hand cards run out before trump was ever
//    exposed, their hidden card becomes forced-playable as their final
//    card of the round.
//  - Trick winner: highest card of the led suit, unless a trump was
//    played (post-exposure), in which case highest trump wins.
//  - Scoring: bidding team's captured points vs their bid.
//      bid < 18  : make = +1 / fail = -2 (opponent +2)
//      bid 18-27 : make = +2 / fail = -3 (opponent +3)
//      bid >= 28 : make = +3 / fail = -4 (opponent +4)
// ============================================================

const SUITS = ['♥', '♠', '♦', '♣'];
const RANKS = ['7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const POINTS = { J: 3, '9': 2, A: 1, '10': 1, K: 0, Q: 0, '8': 0, '7': 0 };
const RANK_ORDER = { J: 8, '9': 7, A: 6, '10': 5, K: 4, Q: 3, '8': 2, '7': 1 };
const brain = require('./bot-brain');
brain.loadBrains();

// These two lines were wrong for this entire rewrite, and are the true
// root cause of the "illogical"/"wrong order"/"stuck" reports: teams are
// NOT {0,2} vs {1,3} the way I'd assumed, and turn order does NOT simply
// increment (0→1→2→3) — it follows this specific non-sequential seating
// pattern instead. Every "the play order is scrambled" report was this,
// not a downstream bug — the whole engine was internally self-consistent
// with the WRONG convention, so my own tests never caught it (they only
// verify the engine agrees with itself, not that it matches the real game).
const SEAT_ROTATION = [3, 2, 0, 1];
function getTeam(pos) { return (pos === 0 || pos === 3) ? 1 : 0; }
function nextPos(p) { return SEAT_ROTATION[(SEAT_ROTATION.indexOf(p) + 1) % 4]; }
function partnerOf(pos) { return pos === 0 ? 3 : pos === 3 ? 0 : pos === 1 ? 2 : 1; }

function freshDeck() {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) {
    deck.push({ suit: s, rank: r, points: POINTS[r] });
  }
  // Fisher-Yates shuffle
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function cardEq(a, b) { return a.suit === b.suit && a.rank === b.rank; }

// ============================================================
// PHASE 1 BIDDING EVALUATION (first 4 cards, before the rest are dealt)
// ============================================================
// The old approach just summed card point values (J=3, 9=2, A=1, 10=1),
// which badly misjudges hands where those points are spread across
// different suits instead of concentrated in one. Four Jacks in four
// different suits adds up to 12 raw points — more than a genuine J-9-A-10
// lock on a single suit (3+2+1+1=7) — but the Jacks-only hand has no
// actual suit control at all: it can't reliably win tricks, it just
// stops other people's high cards from winning. That's a real, useful
// hand, just for defense, not for declaring a high contract.
//
// This models suit CONTROL directly (how much of one suit's top end you
// personally hold), separates that offensive read from a separate
// defensive read (how good this hand is at spoiling someone else's
// contract), and turns the offensive score into a per-bid-level
// probability curve computed from the actual cards — not a fixed table.
function evaluatePhase1Hand(hand) {
  const bySuit = {};
  for (const s of SUITS) bySuit[s] = [];
  for (const c of hand) bySuit[c.suit].push(c);

  // Hard ceiling based on actual cards held, not a probability curve.
  // Real-game feedback: bots kept bidding well past what their hand
  // could support because a continuous "confidence" estimate can always
  // be nudged a little further by aggression, learned patterns, or a
  // partner bonus. A structural ceiling tied directly to concrete card
  // composition can't be talked past that way - it's an actual cap, not
  // a starting point.
  let eligibleToRaise = false;
  let jSuitCeiling = 14;
  let jPlusOneCompanionSuits = 0;
  // Suits where this hand holds ONLY a lone Jack (no companion at all in
  // that suit) -- tracked for the 9-A-10-no-Jack rule further below,
  // which needs to know about a genuinely separate bonus Jack elsewhere.
  const loneJackSuits = [];
  for (const s of SUITS) {
    const cards = bySuit[s];
    if (cards.length === 0) continue;
    const hasJ = cards.some(c => c.rank === 'J');
    const has9 = cards.some(c => c.rank === '9');
    const hasA = cards.some(c => c.rank === 'A');
    if (!hasJ) {
      // No Jack in this suit: only justifies raising at all if it's a
      // real 3+ card suit that also includes the 9 - a genuine strong
      // suit, not just a pile of low cards.
      if (cards.length >= 3 && has9) { eligibleToRaise = true; jSuitCeiling = Math.max(jSuitCeiling, 15); }
      continue;
    }
    eligibleToRaise = true;
    const companions = cards.filter(c => c.rank !== 'J');
    let suitCeiling;
    if (companions.length === 0) {
      suitCeiling = 14; // a lone Jack, no companion - not enough to raise on its own
      loneJackSuits.push(s);
    } else if (has9 && hasA) {
      // Jack+9+Ace (with or without the 10 too) is the single strongest
      // hand type here - full command of the suit's point structure PLUS
      // the Jack itself locking the suit down. Raised from 20 to 23 per
      // updated tuning; still a real ceiling, not a starting point, so
      // the confidence/pullback logic elsewhere still decides how close
      // to it a given bot actually commits.
      suitCeiling = 23;
    } else if (companions.length >= 2) {
      const hasPointCompanion = companions.some(c => c.points > 0);
      suitCeiling = hasPointCompanion ? 20 : 18;
    } else {
      suitCeiling = 15;
      jPlusOneCompanionSuits++;
    }
    jSuitCeiling = Math.max(jSuitCeiling, suitCeiling);
  }
  // Two separate suits each with a Jack + one companion reads as
  // slightly more than either alone, even though neither individually
  // clears the next tier up.
  if (jPlusOneCompanionSuits >= 2) jSuitCeiling = Math.max(jSuitCeiling, 16);

  // Three of a kind (same rank, spread across three different suits) is
  // its own real signal, independent of the same-suit Jack reasoning
  // above -- a trio of 10s/Aces/9s isn't captured by anything above,
  // since none of those individually needs a Jack of its own suit.
  const rankCounts = {};
  for (const c of hand) rankCounts[c.rank] = (rankCounts[c.rank] || 0) + 1;
  if ((rankCounts['10'] || 0) >= 3 || (rankCounts['A'] || 0) >= 3) {
    eligibleToRaise = true;
    jSuitCeiling = Math.max(jSuitCeiling, 16);
  }
  if ((rankCounts['9'] || 0) >= 3) {
    eligibleToRaise = true;
    jSuitCeiling = Math.max(jSuitCeiling, 18);
  }

  // 9-A-10 of one suit, with NO Jack of that suit, plus a separate bonus
  // Jack sitting alone in a different suit. Deliberately kept just under
  // the J+9+A ceiling above (19 vs 23) -- this hand has full command of
  // the suit's points but no Jack to actually lock the suit itself, so
  // it reads as very strong rather than the single best hand type.
  // suggestedTrumpSuit tells the bot's trump-suit choice (a separate
  // function) which suit to actually call, rather than leaving it to
  // fall back on generic point-counting.
  let suggestedTrumpSuit = null;
  for (const s of SUITS) {
    const cards = bySuit[s];
    const hasJ = cards.some(c => c.rank === 'J');
    const has9 = cards.some(c => c.rank === '9');
    const hasA = cards.some(c => c.rank === 'A');
    const has10 = cards.some(c => c.rank === '10');
    if (!hasJ && has9 && hasA && has10 && loneJackSuits.some(js => js !== s)) {
      eligibleToRaise = true;
      jSuitCeiling = Math.max(jSuitCeiling, 19);
      suggestedTrumpSuit = s;
    }
  }

  const hardCeiling = eligibleToRaise ? jSuitCeiling : 14;

  // Suit-dominance scoring retained for the existing defensive-vs-
  // offensive read elsewhere - no longer drives the bid ceiling itself.
  let bestSuit = null, bestSuitScore = -1, bestSuitCount = 0;
  for (const s of SUITS) {
    const cards = bySuit[s];
    if (cards.length === 0) continue;
    const hasJ = cards.some(c => c.rank === 'J');
    const has9 = cards.some(c => c.rank === '9');
    const hasA = cards.some(c => c.rank === 'A');
    const has10 = cards.some(c => c.rank === '10');
    let score = cards.reduce((s2, c) => s2 + RANK_ORDER[c.rank], 0);
    if (hasJ) score += 4;
    if (hasJ && has9) score += 6;
    if (hasJ && has9 && hasA) score += 8;
    if (hasJ && has9 && hasA && has10) score += 10;
    if (score > bestSuitScore) { bestSuitScore = score; bestSuit = s; bestSuitCount = cards.length; }
  }
  if (bestSuit === null) bestSuitScore = 0;

  const jacks = hand.filter(c => c.rank === 'J');
  const jackSuits = new Set(jacks.map(c => c.suit));
  const jacksScattered = jacks.length >= 2 && jackSuits.size === jacks.length;
  const highCardCount = hand.filter(c => ['J', '9', 'A', '10'].includes(c.rank)).length;
  let offensive = bestSuitScore * 3 + Math.min(6, highCardCount * 1.5);
  if (jacksScattered) offensive -= (jacks.length - 1) * 4;
  const defensive = jacks.length * 10 + hand.filter(c => c.points === 0).length * 2;

  return {
    offensive, defensive, bestSuit, bestSuitScore, bestSuitCount,
    jacksScattered, jackCount: jacks.length, highCardCount, hardCeiling, eligibleToRaise,
    suggestedTrumpSuit
  };
}

// ============================================================
// PHASE 2 BIDDING EVALUATION (full 8-card hand, trump suit known)
// ============================================================
// Completely different problem from Phase 1: there's no more uncertainty
// about future cards, so this should read the hand's actual
// trick-winning power — trump quality (not just trump count), suit
// control across the whole hand, how many tricks are genuinely
// guaranteed vs merely likely vs merely possible, and how much of a
// stretch target bid actually depends on partner coming through too.
function evaluatePhase2Hand(hand, trumpSuit) {
  const bySuit = {};
  for (const s of SUITS) bySuit[s] = [];
  for (const c of hand) bySuit[c.suit].push(c);

  const suitControl = {};
  for (const s of SUITS) {
    const cards = bySuit[s];
    const hasJ = cards.some(c => c.rank === 'J');
    const has9 = cards.some(c => c.rank === '9');
    const hasA = cards.some(c => c.rank === 'A');
    const has10 = cards.some(c => c.rank === '10');
    const topCount = [hasJ, has9, hasA, has10].filter(Boolean).length;
    const control = topCount >= 3 ? 'complete' : topCount >= 1 ? 'partial' : 'none';
    suitControl[s] = { hasJ, has9, hasA, has10, topCount, count: cards.length, control };
  }

  const trump = suitControl[trumpSuit];

  // Trump quality: holding J+9 of trump with only 2 total trumps is
  // stronger than holding 4 low trumps with neither — quality over count.
  let trumpQuality = 0;
  if (trump.hasJ) trumpQuality += 5;
  if (trump.hasJ && trump.has9) trumpQuality += 6;
  if (trump.hasJ && trump.has9 && trump.hasA) trumpQuality += 4;
  if (trump.hasJ && trump.has9 && trump.hasA && trump.has10) trumpQuality += 4; // full lock on trump
  trumpQuality += Math.max(0, trump.count - trump.topCount); // extra low trumps still help control rounds

  // How many rounds of trump this hand can safely force/survive — if we
  // don't hold trump's Jack ourselves, our own trumps risk being beaten
  // while trying to draw the suit out.
  const safeTrumpRounds = trump.hasJ ? trump.count : Math.max(0, trump.count - 1);

  // Guaranteed / likely / possible tricks, suit by suit. A suit's Jack is
  // effectively a guaranteed trick (nothing beats it barring a trump cut);
  // its 9 is guaranteed only once the Jack is accounted for (ours or
  // otherwise unlikely to still be out); Aces and 10s are more
  // speculative since plenty can still beat them.
  let guaranteedTricks = 0, likelyTricks = 0, possibleTricks = 0;
  for (const s of SUITS) {
    const sc = suitControl[s];
    if (sc.hasJ) guaranteedTricks += 1;
    if (sc.has9) { if (sc.hasJ) guaranteedTricks += 1; else likelyTricks += 1; }
    if (sc.hasA) { if (sc.hasJ && sc.has9) likelyTricks += 1; else possibleTricks += 1; }
    if (sc.has10 && sc.hasJ && sc.has9 && sc.hasA) guaranteedTricks += 1; // the full 4-card lock
  }

  const weakSuits = SUITS.filter(s => s !== trumpSuit && suitControl[s].count === 0);

  // Rough own-hand point contribution — different tricks carry different
  // point values (J=3, 9=2, A=1, 10=1), so weight guaranteed/likely tricks
  // toward the higher end and possible ones toward the lower end.
  const ownPointEstimate = guaranteedTricks * 2.4 + likelyTricks * 1.6 + possibleTricks * 0.8;

  const offensive = trumpQuality * 2 + guaranteedTricks * 6 + likelyTricks * 3 + possibleTricks * 1.5 - weakSuits.length * 2;

  return {
    suitControl, trump, trumpQuality, safeTrumpRounds,
    guaranteedTricks, likelyTricks, possibleTricks, weakSuits,
    ownPointEstimate, offensive
  };
}

// Raising in Phase 2 hands the bid — and a completely fresh trump choice
// — to whoever raises (see raiseBid: it resets trumpSuit and makes the
// raiser the new bidder, even when re-raising their own earlier bid). So
// the question "should I raise" isn't "is the CURRENT trump good for
// me", it's "is my best possible suit, as my own trump, good enough" —
// this tries every suit and returns the strongest reading.
function bestPhase2Evaluation(hand) {
  let best = null;
  for (const s of SUITS) {
    const ev = evaluatePhase2Hand(hand, s);
    if (!best || ev.offensive > best.offensive) best = ev;
  }
  return best;
}

// Must match the length of TABLE_THEMES in public/index.html (Royal Red,
// Royal Blue, Emerald Green, Royal Purple, Onyx & Gold, Sapphire Teal) —
// the server just picks an index each round, the client owns the colors.
const TABLE_THEME_COUNT = 6;

class GameEngine {
  constructor(tableId) {
    this.tableId = tableId;
    // seats[i] = { name, isBot, connected, hand: [cards] } for i in 0..3
    this.seats = [null, null, null, null];
    this.round = 0;
    // Random table felt theme, rerolled once per round (see startRound()),
    // synced to every client via stateFor() so everyone sees the same color.
    this.tableTheme = Math.floor(Math.random() * TABLE_THEME_COUNT);
    this.gameScore = [6, 6]; // match score, team 0 / team 1 (mirrors client default)
    this.championshipNumber = 1;
    this.kingStreak = [0, 0]; // consecutive championships won by each team
    // "Q" penalty marks: a shame counter that sticks to a player (by
    // name) across championships within this table's lifetime, not just
    // within one match. Every loss (this scoring system is zero-sum, so
    // every championship literally ends 12-0/0-12 — there's no partial
    // loss) adds one Q to everyone on the losing side. Comes off only by
    // personally calling and winning a bid — see _endRound() for the
    // exact rule, including the first-hand-of-a-new-championship
    // exception where a successful bidder's partner can shed one too.
    this.qMarks = {};
    // Cumulative running total of Kunukku marks ever acquired, per
    // player, for this table's whole lifetime - unlike qMarks above,
    // this NEVER decreases when a Q gets shed by winning a bid. Only
    // resets on a genuine new game (constructor or restartGame()), not
    // on shedding a Q or starting a new championship.
    this.qTotalEver = {};
    this.isFirstHandOfChampionship = true;
    // Partner bidding signals: a human tells their partner (bot or
    // human) how to approach the NEXT hand's bidding relative to normal
    // -- same, more aggressive, or less aggressive. For a bot partner
    // this actually nudges their bid target; for a human partner it's
    // just delivered as a message, never enforced. One-shot: consumed
    // (or expires) after that one hand's bidding.
    this.partnerSignals = {}; // seat -> {signal:'same'|'higher'|'lower', fromSeat, fromName}
    this.KING_TARGET = 10; // win 10 championships in a row to be crowned King of the Table
    this.lastChampionshipResult = null; // set only on the round that just decided a championship
    // Dealer starts at a genuinely random seat for a fresh table, then
    // advances by one seat each round via startRound() — it must NOT be
    // reset here again on every round, or the dealer role would never
    // actually rotate at all (this was a real bug: resetRoundState() used
    // to hard-reset it to a fixed seat every single round, silently
    // undoing the rotation and making one specific seat "dealer" forever).
    this.dealer = Math.floor(Math.random() * 4);
    this.resetRoundState();
    this.phase = 'lobby'; // lobby | bidding1 | choosingTrump | play | roundEnd
    this.log = [];
    // Ticks up every time any bot's brain actually records something
    // (trick outcome, bid outcome, round outcome) — clients watch this
    // counter to know exactly when to flash their "bot is learning"
    // indicator, without needing the full brain payload sent over the
    // wire each time.
    this.learningPulseCount = 0;
    this.lastLearningBotName = '';
    // Bot moves happen asynchronously via setImmediate (see maybeAutoAct),
    // completely outside any socket event handler's normal flow — without
    // this hook, nobody would ever be told a bot just acted, and every
    // connected client would silently freeze on stale state the instant a
    // bot's turn came up, even though the engine itself kept working fine
    // internally. The server attaches to this after creating the engine.
    this.onChange = null;
  }

  _notify() { if (this.onChange) { try { this.onChange(); } catch (e) { console.error('onChange handler error:', e); } } }

  resetRoundState() {
    this.currentPlayer = 0;
    this.deck = [];
    this.bidder = -1;
    this.highestBid = 0;
    this.passes = 0;
    this.bidHistory = []; // [{pos, bid}]
    this.p2History = []; // [{pos, bid}] — phase 2 raises/passes, reset again when phase 2 actually starts
    // Phase 1 bidding flow: the first bidder's partner doesn't get their
    // turn in the normal seating order — it's deferred until the seat
    // right before them (going around the table) has actually acted,
    // and depending on how that plays out, their eventual turn is either
    // completely normal or pre-restricted to Honors (20) or higher. See
    // _afterBidAction() for the full flow this supports.
    this.partnerTurnDeferred = false; // true from the first forced bid until the partner actually gets a turn
    this.partnerTurnRestrictedWhenReached = false; // true only in the "both opponents passed" branch
    this._partnerTurnWasDelayed = false; // true only between partner's delayed turn finishing and the redirect back to the first bidder
    this.firstBidderPos = -1;
    this.p1SeatsActed = {}; // {seatPos: true} - anyone who's had a genuine turn already this phase 1 round
    // Tracks total phase-1 bidding actions taken (bid OR pass, including
    // the forced first bid), separate from `passes` above -- `passes`
    // resets to 0 every time someone raises, which meant the auction
    // could effectively restart its own clock mid-round and let a seat
    // get asked to act a genuine second time, as long as enough people
    // happened to bid instead of pass along the way. The real rule,
    // matching what 6-player already correctly does: one turn per seat,
    // four turns total, then it's over however the bids landed.
    this.p1TurnsTaken = 0;
    this.trumpSuit = '';
    this.trumpExposed = false;
    this.roundVoidMessage = null;
    this.hiddenTrump = null; // {suit, rank, points}
    this.revealedTrumpCard = null; // {rank, suit} -- set once, publicly, the moment trump is exposed; unlike hiddenTrump this is never cleared again until the next round resets it here
    this.hiddenTrumpOwner = -1; // who physically hid it — NOT necessarily this.bidder, since a phase-2 raise can change the bidder while the original chooser still holds the hidden card
    this.mustPlayTrumpBy = -1; // seat that just ASKED for trump to be opened (callTrump) — Kerala rule: having asked, they must play a trump card this trick if they hold one
    this.trickCards = []; // [{pos, card}]
    this.trickSuit = '';
    // How many times each suit has already been led THIS round — used by
    // the bot AI's cut-decision below: the more times a suit has come
    // around, the more of the table has had a chance to run out of it,
    // so a defender void in it is increasingly likely to be one of
    // several such players rather than a rare exception, making a cut
    // both safer (less likely another defender is about to steal it
    // right back) and more urgent (an opponent void in it is just as
    // likely, and they get to act too).
    this.suitLeadCount = { '♠': 0, '♥': 0, '♦': 0, '♣': 0 };
    // Every card played so far THIS round, in play order — the bot AI's
    // memory for "has the Jack of this suit already been played", "which
    // trumps remain", etc. (see _cardsSeenSoFar). Doesn't include the
    // current trick's cards, which live in trickCards until resolved.
    this.playedCardsThisRound = [];
    // Per-seat set of suits that seat has PROVABLY run out of — populated
    // in _resolveTrick() whenever someone fails to follow the led suit
    // (the only reason that's ever legal is genuinely holding none left).
    // Lets bot leading/discard decisions reason about who's likely to
    // trump in on a given suit, not just what's in their own hand.
    this.voidSuits = [new Set(), new Set(), new Set(), new Set()];
    this.tricksPlayed = 0;
    this.teamPoints = [0, 0]; // points captured THIS round
    this.lastTrick = null; // {cards:[{pos,card}], winner, points, team}
    this.roundWinnerAnnounced = null; // {bidderWon, made, bidder, highestBid}
    // "Already won" early-round-end feature: once EITHER team's outcome
    // becomes mathematically certain (the bidding team has already
    // captured >= their bid, or the defense has captured enough that the
    // bidder can no longer reach it even with every remaining point),
    // the winning team (if it includes a real human -- bots don't need
    // this) is offered the choice to skip the now-meaningless remaining
    // tricks. See the early-win check in _resolveTrick() and
    // respondToEarlyWin().
    this.pendingEarlyWinChoice = null; // {team, made} while awaiting a human choice
    this.earlyWinDeclined = false; // true once the winning team has chosen "keep playing" -- suppresses re-prompting every subsequent trick this round
    // Quote: available to WHICHEVER team is currently "clean" (hasn't
    // lost a single trick yet this round -- trivially true for BOTH
    // teams before the first trick, so it's live from the very start),
    // valid for ANY player on that team on their own turn (leading or
    // following), as long as the bid was <=19. Declaring it is a bet on
    // the FULL 8-trick, 28-point sweep, evaluated as an absolute fact
    // regardless of when it's declared -- calling it on trick 1 is a
    // much bigger bet than calling it on trick 7, since either way the
    // requirement is the same: every single trick, no exceptions.
    // Success replaces normal scoring with a flat +2 for the declaring
    // team; losing even one trick afterward replaces it with a flat -3
    // against them, however many points they'd already banked. See
    // _isQuoteEligibleFor(), the quote checks in _resolveTrick(), and
    // declareQuote()/_endRound().
    this.teamStillClean = [true, true]; // per-team: has this team won every trick so far (both start true, at most one stays true past trick 1)
    this.quoteState = null; // {team} once COT/MaruCOT has actually been declared this round
    // Thani: a Phase-2 bid that beats any numeric raise (effectively
    // "above 28"). Whoever calls it leads the very first trick
    // immediately, regardless of normal turn order; their partner
    // folds out of the round entirely -- never dealt into any trick,
    // never taking a turn. It's a genuinely different win condition
    // from every other bid: not points, just tricks -- the caller must
    // win literally every trick played (their own hand size worth),
    // failing the instant they lose even one. Scoring reuses the
    // existing >=28 tier (+3/-4) since highestBid gets set to a value
    // that already falls in it -- see callThani()/_resolveTrick()/
    // _endRound().
    this.thaniCaller = -1; // -1 = no thani this round, else the seat who called it
    this.foldedSeats = []; // seats sitting out entirely this round (the thani caller's partner)
    // Phase 2 (the "second chance to raise" round after trump is chosen,
    // once everyone's holding their full 8 cards). p2LastRaiser stays -1
    // for the whole phase if nobody ever raises.
    this.p2Cur = -1;
    this.p2LastRaiser = -1;
    this.p2Passes = 0;
    this.p2TotalPasses = 0;
    this.resumePhase2After = false; // set true when a raise mid-phase-2 interrupts for a fresh trump choice
  }

  addLog(msg) {
    this.log.push({ t: Date.now(), msg });
    if (this.log.length > 200) this.log.shift();
    // Also print to stdout — this is what actually shows up in Render's
    // dashboard logs. Without this, every phase transition happens
    // invisibly; if something freezes live, there's no way to see what
    // the server actually did versus what a screenshot of the client can
    // show. With this, the exact sequence of events (dealing, bids, phase
    // transitions) is visible in Render's log viewer in real time.
    console.log(`[table ${this.tableId}] ${msg}`);
  }

  // ---------------- Seating ----------------

  emptySeats() {
    const out = [];
    for (let i = 0; i < 4; i++) if (!this.seats[i]) out.push(i);
    return out;
  }

  humanCount() {
    return this.seats.filter(s => s && !s.isBot).length;
  }

  seatHuman(pos, name, playerId, avatar) {
    this.seats[pos] = { name, isBot: false, connected: true, playerId, hand: [], avatar: avatar || null };
  }

  seatBot(pos, name) {
    this.seats[pos] = { name, isBot: true, connected: true, playerId: null, hand: [] };
  }

  removeSeat(pos) {
    this.seats[pos] = null;
  }

  // A human explicitly exiting mid-game (not just disconnecting) — the
  // reverse of replaceBot below. Rather than nulling the seat out (which
  // would leave a hole an engine built for a fixed player count can't
  // sensibly play around), the seat keeps its exact current hand and
  // state and simply becomes bot-controlled, so the table keeps running
  // exactly as before instead of breaking or needing to stop.
  convertToBot(pos) {
    const seat = this.seats[pos];
    if (!seat || seat.isBot) return false;
    seat.isBot = true;
    seat.connected = true;
    seat.playerId = null;
    // Clears any leftover ghost-player flag (see maybeAutoAct()) - isBot alone is already
    // sufficient to drive bot-speed auto-play from here on, and leaving this stale would
    // incorrectly follow the seat if a real human later takes it over via replaceBot(),
    // forcing artificial few-second auto-play on their own genuine turns.
    seat.ghostPlayer = false;
    return true;
  }

  // A human taking over a bot's seat mid-game — inherits the bot's exact
  // current hand and state rather than starting fresh, since the round
  // may already be well underway. Fails if that seat isn't currently a bot.
  replaceBot(pos, playerId, name, avatar) {
    const seat = this.seats[pos];
    if (!seat || !seat.isBot) return false;
    seat.isBot = false;
    seat.connected = true;
    seat.playerId = playerId;
    seat.name = name;
    seat.avatar = avatar || null;
    // Explicitly cleared, not just left unset - a bot seat can be the leftover remains of a
    // previously-stopped ghost player (see convertToBot()), and a genuine real human taking
    // it over here must never inherit that flag, or their own real turns would get forced
    // into the ghost's artificial few-second auto-play instead of waiting on them normally.
    seat.ghostPlayer = false;
    return true;
  }

  // A seat left behind by a human who disconnected is neither "empty"
  // (the seat object still exists, mid-round, with a real hand) nor a
  // "bot seat" (isBot stays false — the engine just auto-plays for them
  // via maybeAutoAct same as it would a bot). That meant it was invisible
  // to every new joiner forever: not in emptySeats(), not in the bot-seat
  // list, so a friend trying to rejoin after a dropped connection had
  // nowhere to go even though that exact seat was sitting there idle.
  // This lets a new joiner step into any seat that's either a bot OR
  // simply disconnected, inheriting whatever hand/state is already there.
  takeOverSeat(pos, playerId, name, avatar) {
    const seat = this.seats[pos];
    if (!seat) return false;
    if (!seat.isBot && seat.connected) return false; // seat is a real, present human — not up for grabs
    seat.isBot = false;
    seat.connected = true;
    seat.playerId = playerId;
    seat.name = name;
    seat.avatar = avatar || null;
    // See convertToBot()/replaceBot() above for the full reasoning.
    seat.ghostPlayer = false;
    return true;
  }

  markConnected(pos, connected) {
    if (!this.seats[pos]) return;
    this.seats[pos].connected = connected;
    // Timestamp of the most recent disconnect, cleared the moment they
    // reconnect -- used by the server's table-name logic (see
    // getSeatBasedTableName in server.js) to know whether a disconnected
    // seat has genuinely been gone long enough (2 minutes) to switch the
    // table's public listing away from their name.
    if (!connected) this.seats[pos].disconnectedAt = Date.now();
    else this.seats[pos].disconnectedAt = null;
  }

  findSeatByPlayerId(playerId) {
    return this.seats.findIndex(s => s && s.playerId === playerId);
  }

  // ---------------- Round lifecycle ----------------

  canStart() {
    return this.seats.filter(Boolean).length >= 2;
  }

  startRound() {
    this.round++;
    this.tableTheme = Math.floor(Math.random() * TABLE_THEME_COUNT);
    this.resetRoundState();
    this.dealer = nextPos(this.dealer);
    this.currentPlayer = nextPos(this.dealer);
    this.deck = freshDeck();
    for (let i = 0; i < 4; i++) {
      if (this.seats[i]) this.seats[i].hand = [];
    }
    this.dealCards(4);
    this.phase = 'bidding1';
    // Silently redeals (no intermediate notify) until neither
    // auto-reshuffle condition holds, so clients only ever see ONE clean
    // final state -- with reshuffleReason explaining what happened, if
    // anything did. Same dealer throughout, per round of edits.
    this.reshuffleReason = this._dealSameHandUntilValid();
    this.addLog(`Round ${this.round} started. Dealer seat ${this.dealer}.`);
    this._notify();
    this.maybeAutoAct();
  }

  // Redeals (same dealer, no notify/side effects per attempt) until
  // neither auto-reshuffle condition is true: the forced first bidder
  // holding nothing but 7s/8s (an unplayable hand they'd otherwise be
  // forced to bid on), or any single seat holding all four Jacks.
  // Returns the reason for the FIRST bad deal hit in the chain (or null
  // if the original deal was already fine) -- that first reason is the
  // one actually worth telling players about; anything after it is just
  // this same safety net doing its job again on the replacement deal.
  _dealSameHandUntilValid() {
    let reason = null;
    let guard = 0;
    while (guard++ < 100) { // effectively unbounded in practice; just a hard safety cap
      const firstBidderSeat = nextPos(this.dealer);
      const firstBidderHand = this.seats[firstBidderSeat] ? this.seats[firstBidderSeat].hand : [];
      const isAll78 = firstBidderHand.length === 4 && firstBidderHand.every(c => c.rank === '7' || c.rank === '8');
      let allJacksSeat = -1;
      if (!isAll78) {
        for (let i = 0; i < 4; i++) {
          const hand = this.seats[i] ? this.seats[i].hand : [];
          if (hand.filter(c => c.rank === 'J').length === 4) { allJacksSeat = i; break; }
        }
      }
      // Per explicit request: same broader "genuinely worthless hand" check as the 6-player
      // engine's identical addition - see there for the full reasoning. Adjusted for this
      // game's 4-card hand instead of 6.
      let all678Seat = -1;
      if (!isAll78 && allJacksSeat === -1) {
        for (let i = 0; i < 4; i++) {
          const hand = this.seats[i] ? this.seats[i].hand : [];
          if (hand.length === 4 && hand.every(c => c.rank === '6' || c.rank === '7' || c.rank === '8')) { all678Seat = i; break; }
        }
      }
      if (!isAll78 && allJacksSeat === -1 && all678Seat === -1) break; // this deal is fine, stop here
      if (!reason) {
        reason = isAll78
          ? { type: 'all78', seat: firstBidderSeat, name: this.seats[firstBidderSeat] ? this.seats[firstBidderSeat].name : ('Seat ' + firstBidderSeat), round: this.round, ts: Date.now() }
          : allJacksSeat !== -1
          ? { type: 'allJacks', seat: allJacksSeat, name: this.seats[allJacksSeat].name, round: this.round, ts: Date.now() }
          : { type: 'all678', seat: all678Seat, name: this.seats[all678Seat].name, round: this.round, ts: Date.now() };
        const reasonText = reason.type === 'all78' ? "was forced to bid with a hand of only 7s and 8s"
          : reason.type === 'allJacks' ? "was dealt all four Jacks"
          : "was dealt a hand of nothing but 6s, 7s, and 8s";
        this.addLog(`Reshuffling — ${reason.name} ${reasonText}. Same dealer, fresh deal.`);
      }
      for (let i = 0; i < 4; i++) { if (this.seats[i]) this.seats[i].hand = []; }
      this.deck = freshDeck();
      this.dealCards(4);
    }
    return reason;
  }

  // Host control: reshuffle and redeal the CURRENT round from scratch —
  // same round number, same dealer, brand new cards. Works from any phase
  // (bidding, mid-trick, whatever) since resetRoundState()/dealCards()
  // fully overwrite everything round-specific; nothing carries over.
  restartRound() {
    const keepRound = this.round;
    const keepDealer = this.dealer;
    this.resetRoundState();
    this.round = keepRound;
    this.dealer = keepDealer;
    this.currentPlayer = nextPos(this.dealer);
    this.deck = freshDeck();
    for (let i = 0; i < 4; i++) {
      if (this.seats[i]) this.seats[i].hand = [];
    }
    this.dealCards(4);
    this.phase = 'bidding1';
    // Always reflects what happened during THIS specific redeal -- never
    // left stale from an earlier, unrelated trigger. _startPlay()'s
    // no-trump check already broadcasts its OWN reshuffleReason once,
    // directly, right before calling this -- so resetting it here based
    // on this fresh deal (null if it's clean) is correct, not a loss.
    this.reshuffleReason = this._dealSameHandUntilValid();
    this.addLog(`Round ${this.round} restarted — fresh shuffle.`);
    this._notify();
    this.maybeAutoAct();
  }

  // Host control: abandon the whole match — scores, championship count,
  // and king streak all reset — and deal a fresh round 1. Also works from
  // any phase for the same reason as restartRound().
  restartGame() {
    this.gameScore = [6, 6];
    this.championshipNumber = 1;
    this.kingStreak = [0, 0];
    this.qMarks = {};
    this.qTotalEver = {};
    this.isFirstHandOfChampionship = true;
    this.lastChampionshipResult = null;
    this.round = 0;
    this.dealer = Math.floor(Math.random() * 4);
    this.addLog('Host restarted the game — starting a fresh match.');
    this.startRound();
  }

  // Host control: remove someone from their seat. Before the game starts
  // this frees the seat outright (same as a deliberate leave); mid-game it
  // converts them to a bot instead of leaving a hole no other part of the
  // engine expects (dealCards/turn order/etc. all assume 4 real-or-bot
  // seats once play has begun).
  kickPlayer(pos) {
    const seat = this.seats[pos];
    if (!seat) return false;
    if (this.phase === 'lobby') {
      this.seats[pos] = null;
    } else {
      seat.isBot = true;
      seat.connected = true;
      seat.playerId = null;
    }
    this.addLog(`${seat.name} was removed by the host.`);
    this._notify();
    this.maybeAutoAct();
    return true;
  }

  // Swaps which named bot personality is playing a seat — e.g. picking a
  // different bot to take over from the current one. Deliberately touches
  // ONLY the name string: hand, cards played, turn order, and phase are
  // all completely untouched, so this is safe to call at any point in a
  // round, including mid-trick, without any risk to game state. The only
  // real effect is that future decisions for this seat look up a
  // different bot's learned brain (see _botAct, which always reads
  // this.seats[pos].name fresh — never cached), so a rename mid-round
  // does mean whichever personality is at the seat AFTER the swap plays
  // out the rest of the round, using its own learned tendencies.
  renameBotSeat(pos, newName) {
    const seat = this.seats[pos];
    if (!seat) return { ok: false, reason: 'no_seat' };
    if (!seat.isBot) return { ok: false, reason: 'not_a_bot' };
    if (!newName || typeof newName !== 'string' || !newName.trim()) return { ok: false, reason: 'invalid_name' };
    const trimmed = newName.trim();
    if (this.seats.some((s, i) => i !== pos && s && s.name === trimmed)) {
      return { ok: false, reason: 'name_in_use' };
    }
    const oldName = seat.name;
    seat.name = trimmed;
    this.addLog(`Host changed seat ${pos} from ${oldName} to ${trimmed}.`);
    this._notify();
    return { ok: true };
  }

  dealCards(count) {
    for (let n = 0; n < count; n++) {
      for (let i = 0; i < 4; i++) {
        if (!this.seats[i]) continue;
        const card = this.deck.pop();
        if (card) this.seats[i].hand.push(card);
      }
    }
  }

  // ---------------- Bidding ----------------

  isFirstBidder(pos) {
    return this.highestBid === 0 && this.passes === 0 && pos === nextPos(this.dealer);
  }

  // Whether pos's NEXT bid must be Honors (20) or higher rather than a
  // normal one-higher-than-the-current-bid raise. Three conditions,
  // any one of which is enough:
  // 1. Already had a genuine turn this phase 1 round and is now
  //    cycling back.
  // 2. The first bidder's partner specifically, when their delayed
  //    turn was reached via both opponents passing.
  // 3. The core rule, confirmed and traced turn-by-turn against the
  //    real engine before adding this: whenever it's genuinely pos's
  //    turn and pos's own partner already holds the current highest
  //    bid (regardless of how the turn got to them), a plain raise
  //    isn't the point anymore -- their own side is already ahead, so
  //    only a genuine honors-level bid makes sense. This was the
  //    actual gap: conditions 1 and 2 above are specific edge cases,
  //    neither one actually covers this general situation, which is
  //    exactly what let a completely unrestricted "Min: 16" show up
  //    on screen with a player's own partner already sitting on top.
  _isBidRestrictedToHonors(pos) {
    if (this.p1SeatsActed[pos]) return true;
    if (pos === partnerOf(this.firstBidderPos) && this.partnerTurnRestrictedWhenReached) return true;
    if (this.highestBid > 0 && getTeam(this.bidder) === getTeam(pos)) return true;
    return false;
  }

  // A human telling their partner how to approach the next hand's
  // bidding -- same, more aggressive, or less aggressive than usual.
  // Only meaningful between the seat that just finished a round and
  // its partner; validated here rather than trusted from the client.
  sendPartnerSignal(fromSeat, signal) {
    if (!['same', 'higher', 'lower'].includes(signal)) return { ok: false, reason: 'bad_signal' };
    const fromSeatInfo = this.seats[fromSeat];
    if (!fromSeatInfo) return { ok: false, reason: 'no_seat' };
    const toSeat = fromSeat === 0 ? 3 : fromSeat === 3 ? 0 : fromSeat === 1 ? 2 : 1;
    this.partnerSignals[toSeat] = { signal, fromSeat, fromName: fromSeatInfo.name, forRound: this.round + 1 };
    this.addLog(`${fromSeatInfo.name} signaled their partner: bid ${signal === 'same' ? 'the same' : signal === 'higher' ? 'more aggressively' : 'less aggressively'} next hand.`);
    this._notify();
    return { ok: true, toSeat };
  }

  placeBid(pos, bid) {
    if (this.phase !== 'bidding1') return { ok: false, reason: 'not_bidding' };
    if (pos !== this.currentPlayer) return { ok: false, reason: 'not_your_turn' };
    const first = this.isFirstBidder(pos);
    if (first) {
      this.firstBidderPos = pos;
      this.partnerTurnDeferred = true;
    }
    const restricted = this._isBidRestrictedToHonors(pos);
    if (bid === 0) {
      if (first) bid = 14; // first bidder cannot pass
      else {
        this.passes++;
        this.p1SeatsActed[pos] = true;
        this.p1TurnsTaken++;
        this.bidHistory.push({ pos, bid: 0 });
        this.addLog(`Seat ${pos} passed.`);
        return this._afterBidAction(pos, false);
      }
    }
    const minBid = restricted ? Math.max(20, this.highestBid + 1) : (this.highestBid > 0 ? this.highestBid + 1 : 14);
    if (bid < minBid || bid > 28) return { ok: false, reason: 'invalid_bid_amount' };
    this.highestBid = bid;
    this.bidder = pos;
    this.passes = 0;
    this.p1SeatsActed[pos] = true;
    this.p1TurnsTaken++;
    this.bidHistory.push({ pos, bid });
    // Snapshot the hand profile now, at bid-time — by round end this
    // hand will be empty, too late to learn anything from it.
    if (this.seats[pos]) this._bidderHandProfileForLearning = brain.getHandProfile(this.seats[pos].hand);
    this.addLog(`Seat ${pos} bid ${bid}.`);
    return this._afterBidAction(pos, true);
  }

  _afterBidAction(actingPos, wasABid) {
    // Ends once every seat has had exactly one turn (bid or pass) --
    // p1TurnsTaken tracks that directly and is the only thing gating
    // this now. `passes` is left fully alone for everything else that
    // still depends on it (isFirstBidder(), _isBidRestrictedToHonors()'s
    // first condition, the client's bid display).
    if (this.p1TurnsTaken >= 4) {
      if (this.highestBid === 0) {
        // Shouldn't be reachable in practice (the first bidder is
        // always forced to bid, never pass), but matches the same
        // defensive redeal check 6-player has for the equivalent case.
        this.addLog('No valid bids. Redealing...');
        this.startRound();
        return { ok: true };
      }
      this.phase = 'choosingTrump';
      this.currentPlayer = this.bidder;
      this.addLog(`Bidding done. Seat ${this.bidder} won with ${this.highestBid}.`);
      this._notify();
      this.maybeAutoAct();
      return { ok: true };
    }

    const partnerSeat = partnerOf(this.firstBidderPos);
    const p2Seat = nextPos(this.firstBidderPos);
    const p4Seat = nextPos(nextPos(p2Seat));

    if (actingPos === partnerSeat && this._partnerTurnWasDelayed) {
      // Partner's delayed turn (normal or Honors-restricted) just
      // finished. The natural continuation is back to the very start
      // of the round - not the seat that would come next in an
      // uninterrupted rotation, since in this branch that seat (P4)
      // already had its own turn just before partner's delayed one.
      this._partnerTurnWasDelayed = false;
      this.currentPlayer = this.firstBidderPos;
    } else if (this.partnerTurnDeferred) {
      if (actingPos === this.firstBidderPos) {
        this.currentPlayer = nextPos(actingPos); // -> P2, normal
      } else if (actingPos === p2Seat) {
        if (wasABid) {
          // P2 bid - partner gets a completely normal, in-sequence turn.
          this.partnerTurnDeferred = false;
          this.currentPlayer = partnerSeat;
        } else {
          // P2 passed - skip partner entirely, straight to P4.
          this.currentPlayer = p4Seat;
        }
      } else if (actingPos === p4Seat) {
        // Only reached when P2 passed (partner still deferred).
        this.partnerTurnDeferred = false;
        this._partnerTurnWasDelayed = true;
        this.partnerTurnRestrictedWhenReached = !wasABid; // true only if P4 also passed
        this.currentPlayer = partnerSeat;
      } else {
        this.currentPlayer = nextPos(actingPos);
      }
    } else {
      this.currentPlayer = nextPos(actingPos);
    }

    this._notify();
    this.maybeAutoAct();
    return { ok: true };
  }

  // ---------------- Trump selection ----------------

  chooseTrump(pos, suit, hiddenCard) {
    if (this.phase !== 'choosingTrump') return { ok: false, reason: 'not_choosing_trump' };
    if (pos !== this.bidder) return { ok: false, reason: 'not_the_bidder' };
    if (!SUITS.includes(suit)) return { ok: false, reason: 'invalid_suit' };
    this.trumpSuit = suit;
    const hand = this.seats[pos].hand;
    let idx = -1;
    if (hiddenCard) {
      idx = hand.findIndex(c => cardEq(c, hiddenCard));
    }
    if (idx === -1) {
      // Default: lowest trump card in hand, matching the original client's
      // fallback behavior when the player doesn't pick one explicitly.
      const trumps = hand.filter(c => c.suit === suit)
        .sort((a, b) => RANK_ORDER[a.rank] - RANK_ORDER[b.rank]);
      if (trumps.length > 0) idx = hand.findIndex(c => cardEq(c, trumps[0]));
    }
    if (idx > -1) {
      this.hiddenTrump = hand.splice(idx, 1)[0];
      this.hiddenTrumpOwner = pos;
    }
    this.addLog(`Seat ${pos} chose ${suit} as trump.`);
    if (this.resumePhase2After) {
      // This trump choice was triggered by a raise mid-phase-2 — resume
      // the raise round from the seat after the new bidder, rather than
      // treating this as the original once-per-round trump choice (which
      // would incorrectly re-deal cards and restart phase 2 from scratch).
      this.resumePhase2After = false;
      this.phase = 'bidding2';
      this.p2Cur = nextPos(pos);
      this.currentPlayer = this.p2Cur;
      this._notify();
      this.maybeAutoAct();
    } else {
      this._startPhase2();
    }
    return { ok: true };
  }

  // ---------------- Phase 2: the "second chance to raise" round ----------------
  // Once trump is picked, everyone gets dealt up to their full 8 cards, then
  // starting from the dealer's right again, each player may either raise the
  // bid (becoming the new bidder — the trump already chosen stays as-is) or
  // pass. Ends once everyone's passed with no raise at all, or 3 straight
  // passes follow whoever raised last.
  _startPhase2() {
    this.dealCards(4); // everyone now has their full 8
    this.phase = 'bidding2';
    this.p2Cur = nextPos(this.dealer);
    this.p2LastRaiser = -1;
    this.p2Passes = 0;
    this.p2TotalPasses = 0;
    this.p2History = [];
    this.currentPlayer = this.p2Cur;
    this.addLog('Phase 2: anyone may raise the bid. Min 20.');
    this._notify();
    this.maybeAutoAct();
  }

  isPhase2RaiseOption(bid) {
    const minBid = Math.max(20, this.highestBid + 1);
    return [24, 25, 26, 27, 28].includes(bid) && bid >= minBid;
  }

  raiseBid(pos, bid) {
    if (this.phase !== 'bidding2') return { ok: false, reason: 'not_phase2' };
    if (pos !== this.currentPlayer) return { ok: false, reason: 'not_your_turn' };
    if (!this.isPhase2RaiseOption(bid)) return { ok: false, reason: 'invalid_raise_amount' };
    this.highestBid = bid;
    this.bidder = pos;
    this.p2LastRaiser = pos;
    this.p2Passes = 0;
    this.p2History.push({ pos, bid });
    if (this.seats[pos]) this._bidderHandProfileForLearning = brain.getHandProfile(this.seats[pos].hand);
    this.addLog(`Seat ${pos} raised to ${bid}.`);
    // Any raise in phase 2 — even the original bidder re-raising their own
    // bid — means whatever trump was chosen before is no longer settled.
    // The card currently hidden goes back to whoever actually hid it (that
    // may or may not be this same seat), and the new/raising bidder must
    // pick a fresh trump suit and hide a new card before phase 2 resumes.
    if (this.hiddenTrump && this.hiddenTrumpOwner >= 0 && this.seats[this.hiddenTrumpOwner]) {
      this.seats[this.hiddenTrumpOwner].hand.push(this.hiddenTrump);
    }
    this.hiddenTrump = null;
    this.hiddenTrumpOwner = -1;
    this.trumpSuit = '';
    this.resumePhase2After = true;
    this.phase = 'choosingTrump';
    this.currentPlayer = pos;
    this.addLog(`Seat ${pos} must choose a new trump before phase 2 continues.`);
    this._notify();
    this.maybeAutoAct();
    return { ok: true };
  }

  // Thani: available any time it's genuinely someone's turn in Phase 2 --
  // it always beats any numeric bid (effectively "above 28"), so unlike
  // isPhase2RaiseOption there's no threshold to check beyond it not
  // having already been called this round.
  isThaniOption() {
    return this.thaniCaller === -1;
  }

  // Calling Thani: locks in the caller as bidder with a bid that already
  // falls in the existing >=28 scoring tier (+3/-4), folds their partner
  // out of the round entirely (never dealt into any trick again), and --
  // like an ordinary raise -- sends them to choose a fresh trump, except
  // afterward it skips straight to play instead of returning to more
  // Phase 2 bidding (see chooseTrump() above). _startPlay() itself
  // handles making the caller lead the very first trick, overriding the
  // normal "dealer's right leads" rule.
  callThani(pos) {
    if (this.phase !== 'bidding2') return { ok: false, reason: 'not_phase2' };
    if (pos !== this.currentPlayer) return { ok: false, reason: 'not_your_turn' };
    if (!this.isThaniOption()) return { ok: false, reason: 'thani_already_called' };
    this.highestBid = 29; // deliberately just above 28, so it naturally falls in the existing >=28 scoring tier
    this.bidder = pos;
    this.thaniCaller = pos;
    const partnerPos = pos === 0 ? 3 : pos === 3 ? 0 : pos === 1 ? 2 : 1;
    this.foldedSeats = [partnerPos];
    this.p2LastRaiser = pos;
    this.p2Passes = 0;
    this.p2History.push({ pos, bid: 'THANI' });
    if (this.seats[pos]) this._bidderHandProfileForLearning = brain.getHandProfile(this.seats[pos].hand);
    const callerSeat = this.seats[pos];
    const partnerSeat = this.seats[partnerPos];
    this.addLog(`Seat ${pos} called THANI — going it alone, needing to win every single trick! ${partnerSeat ? partnerSeat.name : 'Their partner'} folds out of this round.`);
    // Thani plays with NO trump suit at all -- not hidden, not chosen,
    // not contestable. Whatever trump was in play before (if this
    // followed an earlier ordinary raise) simply stops mattering: the
    // hidden card, if any, returns to whoever actually hid it, and
    // trumpSuit stays permanently empty for the rest of this round.
    // isRealTrump() throughout the engine already gates on
    // this.trumpExposed, and exposeTrump() is never called during a
    // Thani round, so every trick this round is naturally decided by
    // "highest card of the led suit," with nothing able to cut it.
    if (this.hiddenTrump && this.hiddenTrumpOwner >= 0 && this.seats[this.hiddenTrumpOwner]) {
      this.seats[this.hiddenTrumpOwner].hand.push(this.hiddenTrump);
    }
    this.hiddenTrump = null;
    this.hiddenTrumpOwner = -1;
    this.trumpSuit = '';
    this._startPlay();
    return { ok: true };
  }

  passPhase2(pos) {
    if (this.phase !== 'bidding2') return { ok: false, reason: 'not_phase2' };
    if (pos !== this.currentPlayer) return { ok: false, reason: 'not_your_turn' };
    this.p2Passes++;
    this.p2TotalPasses++;
    this.p2History.push({ pos, bid: 0 });
    this.addLog(`Seat ${pos} passed (phase 2).`);
    return this._afterPhase2Action();
  }

  _afterPhase2Action() {
    const noOneEverRaised = this.p2LastRaiser === -1 && this.p2TotalPasses >= 4;
    const threeStraightPassesAfterARaise = this.p2LastRaiser !== -1 && this.p2Passes >= 3;
    if (noOneEverRaised || threeStraightPassesAfterARaise) {
      // Safety net matching the original rule: if raising happened at all
      // but somehow left the final bid under 20, floor it at 20.
      if (this.highestBid > 0 && this.highestBid < 20 && this.p2LastRaiser !== -1) {
        this.highestBid = 20;
      }
      this.addLog(`Phase 2 done. Final bid: ${this.highestBid} by seat ${this.bidder}.`);
      this._startPlay();
      return { ok: true };
    }
    this.p2Cur = nextPos(this.p2Cur);
    this.currentPlayer = this.p2Cur;
    this._notify();
    this.maybeAutoAct();
    return { ok: true };
  }

  _startPlay() {
    // Rule: if NEITHER player on the defending team (the team that didn't
    // win the bid) holds even a single card of the trump suit, they have
    // no way to ever contest trump at all — the round is void. Reshuffle
    // with the SAME dealer (matching the other two auto-reshuffle rules
    // in _checkAndHandleBadDeal()) rather than playing out something
    // that was never really contestable. (The bidder's own hidden trump
    // card doesn't count here — this check is specifically about the
    // DEFENDING side having zero trump between them.) Thani rounds have
    // no trump suit at all by design (trumpSuit stays permanently
    // empty), so this check is meaningless for them and must be skipped
    // entirely -- otherwise "no card matches an empty suit string" would
    // incorrectly look identical to "genuinely no trump," voiding and
    // reshuffling every single Thani round without exception.
    const bidTeam = getTeam(this.bidder);
    const defendingTeam = bidTeam === 0 ? 1 : 0;
    const defendingHasTrump = this.thaniCaller >= 0 || this.seats.some((s, i) => s && getTeam(i) !== bidTeam && s.hand.some(c => c.suit === this.trumpSuit));
    if (!defendingHasTrump) {
      this.roundVoidMessage = `The defending team has no ${this.trumpSuit} at all this round — nothing to contest. Reshuffling with the same dealer.`;
      this.reshuffleReason = { type: 'noTrump', team: defendingTeam, suit: this.trumpSuit, round: this.round, ts: Date.now() };
      this.addLog(this.roundVoidMessage);
      // Broadcast the void message FIRST — restartRound() immediately
      // clears it again as part of resetting for the new deal, so
      // without this explicit notify the client would never actually
      // see it before it's already gone.
      this._notify();
      // Redeal immediately rather than pausing the engine on a timer —
      // a bare setTimeout here would leave the round permanently stuck
      // if the server ever restarted during that window, and doesn't
      // play well with synchronous testing either. The client's toast
      // for this message already stays up for a few seconds on its own,
      // which is what actually gives players time to read it.
      this.restartRound();
      return;
    }

    this.phase = 'play';
    this.trumpExposed = false;
    this.trickCards = [];
    this.trickSuit = '';
    this.suitLeadCount = { '♠': 0, '♥': 0, '♦': 0, '♣': 0 };
    // Play is always led by the dealer's right — the same seat phase-1
    // bidding started with — regardless of who ended up winning the bid.
    // Thani is the one deliberate exception: the caller leads the very
    // first trick themselves, immediately, no matter whose turn it would
    // otherwise have been.
    this.currentPlayer = this.thaniCaller >= 0 ? this.thaniCaller : nextPos(this.dealer);
    this.addLog(`Play begins. Seat ${this.currentPlayer} leads.`);
    this._notify();
    this.maybeAutoAct();
  }

  // ---------------- Playing cards ----------------

  canPlayCard(pos, card) {
    if (this.phase !== 'play') return false;
    if (pos !== this.currentPlayer) return false;
    const hand = this.seats[pos].hand;
    const has = hand.some(c => cardEq(c, card));
    if (!has) return false;
    if (this.trickSuit === '') {
      // Leading: the bidder can't open with trump before it's exposed,
      // unless trump is literally their only suit left.
      if (pos === this.hiddenTrumpOwner && !this.trumpExposed && card.suit === this.trumpSuit) {
        const hasOther = hand.some(c => c.suit !== this.trumpSuit);
        if (hasOther) return false;
      }
      return true;
    }
    const hasSuit = hand.some(c => c.suit === this.trickSuit);
    if (hasSuit && card.suit !== this.trickSuit) return false;
    // New rule: void in the led suit, a player may cut with trump or
    // discard - but a discard (anything that isn't trump) can never be
    // a Jack of any suit. Cutting with the trump Jack itself is still
    // completely fine, since that's a cut, not a discard. Falls back to
    // allowing it only if there's truly no other legal option (no trump
    // to cut with, and every other card outside the led suit is also a
    // Jack).
    if (!hasSuit && card.suit !== this.trumpSuit && card.rank === 'J') {
      const hasAlternative = hand.some(c => c.suit === this.trumpSuit || (c.suit !== this.trickSuit && c.rank !== 'J'));
      if (hasAlternative) return false;
    }
    // Same restriction as the leading case above, but for following while
    // void: the hidden-trump owner can't discard from the trump suit
    // before it's properly exposed, even when they're not leading -
    // unless trump is genuinely their only option left (every card they
    // hold outside the led suit is trump).
    if (!hasSuit && pos === this.hiddenTrumpOwner && !this.trumpExposed && card.suit === this.trumpSuit) {
      const hasOtherOption = hand.some(c => c.suit !== this.trumpSuit && c.suit !== this.trickSuit);
      if (hasOtherOption) return false;
    }
    // If this player just ASKED for the trump to be opened (callTrump),
    // they're bound by the classic rule: having demanded the reveal, they
    // must play a trump card this trick if they're holding one.
    if (this.mustPlayTrumpBy === pos && !hasSuit && card.suit !== this.trumpSuit) {
      if (hand.some(c => c.suit === this.trumpSuit)) return false;
    }
    return true;
  }

  // A player who cannot follow the led suit may formally ask for the trump
  // to be opened WITHOUT playing a trump card in the same motion — the
  // classic Kerala "open the trick" right. This exposes the trump (and
  // returns the hidden card to its owner's hand); the asker must then play
  // a trump card this trick if they hold one, enforced in canPlayCard.
  // Previously only bots could effectively do this (their auto-play calls
  // exposeTrump() directly); humans had no server action for it at all.
  callTrump(pos) {
    if (this.phase !== 'play') return { ok: false, reason: 'not_playing' };
    if (pos !== this.currentPlayer) return { ok: false, reason: 'not_your_turn' };
    if (this.thaniCaller >= 0) return { ok: false, reason: 'no_trump_this_round' }; // Thani has no trump at all -- nothing to open
    if (this.trumpExposed) return { ok: false, reason: 'already_exposed' };
    if (this.trickSuit === '') return { ok: false, reason: 'cannot_call_when_leading' };
    const hand = this.seats[pos].hand;
    if (hand.some(c => c.suit === this.trickSuit)) return { ok: false, reason: 'must_follow_suit' };
    this.exposeTrump();
    this.mustPlayTrumpBy = pos;
    this.addLog(`Seat ${pos} asked for the trump to be opened.`);
    this._notify();
    return { ok: true };
  }

  playCard(pos, card) {
    if (!this.canPlayCard(pos, card)) return { ok: false, reason: 'illegal_card' };
    const hand = this.seats[pos].hand;
    const idx = hand.findIndex(c => cardEq(c, card));
    const played = hand.splice(idx, 1)[0];
    if (this.mustPlayTrumpBy === pos) this.mustPlayTrumpBy = -1; // obligation satisfied (or they held no trump)
    if (this.trickSuit === '') { this.trickSuit = played.suit; this.suitLeadCount[played.suit]++; }

    // Playing a trump-suited card while unable to follow the led suit,
    // WITHOUT having explicitly called for trump first, is just an
    // ordinary discard that happens to share the trump suit — it does
    // NOT expose trump, and must never be able to win this trick, even
    // retroactively if someone else exposes trump later in this same
    // trick. Cutting with trump is a deliberate act (callTrump, or the
    // bidder's playHiddenTrump) — accidentally holding/discarding a
    // trump card isn't the same thing and shouldn't be treated as one.
    const isIncidentalTrumpDiscard = !this.trumpExposed && played.suit === this.trumpSuit && this.trickSuit !== this.trumpSuit;
    this.trickCards.push({ pos, card: played, powerless: isIncidentalTrumpDiscard });

    this.addLog(`Seat ${pos} played ${played.rank}${played.suit}.`);

    // A folded seat (Thani's partner) never plays, so a trick is
    // complete once every ACTIVE player has played, not always
    // literally 4 -- normally still 4, but 3 during a Thani round.
    if (this.trickCards.length === 4 - this.foldedSeats.length) {
      this._resolveTrick();
    } else {
      this.currentPlayer = this._nextActivePos(this.currentPlayer);
      this._notify();
      this.maybeAutoAct();
    }
    return { ok: true };
  }

  // The person who actually hid the trump card may deliberately play it
  // directly (exposing trump in the process) instead of a card from their
  // visible hand. This is the original chooser, NOT necessarily the
  // current bidder — those can differ after a phase-2 raise.
  playHiddenTrump(pos) {
    if (this.phase !== 'play') return { ok: false, reason: 'not_playing' };
    if (pos !== this.currentPlayer || pos !== this.hiddenTrumpOwner) return { ok: false, reason: 'not_your_turn' };
    if (!this.hiddenTrump) return { ok: false, reason: 'no_hidden_card' };
    const card = this.hiddenTrump;
    // Captured here too, same reasoning as inside exposeTrump() itself
    // -- this path clears hiddenTrump BEFORE calling exposeTrump() below,
    // so that function's own capture would never fire for this specific
    // path (the card being played directly rather than just revealed).
    this.revealedTrumpCard = { rank: card.rank, suit: card.suit };
    this.hiddenTrump = null;
    this.hiddenTrumpOwner = -1;
    if (this.mustPlayTrumpBy === pos) this.mustPlayTrumpBy = -1;
    if (!this.trumpExposed) this.exposeTrump();
    if (this.trickSuit === '') { this.trickSuit = card.suit; this.suitLeadCount[card.suit]++; }
    this.trickCards.push({ pos, card });
    this.addLog(`Seat ${pos} played the hidden trump ${card.rank}${card.suit}!`);
    if (this.trickCards.length === 4 - this.foldedSeats.length) {
      this._resolveTrick();
    } else {
      this.currentPlayer = this._nextActivePos(this.currentPlayer);
      this._notify();
      this.maybeAutoAct();
    }
    return { ok: true };
  }

  exposeTrump() {
    this.trumpExposed = true;
    this.addLog(`Trump exposed: ${this.trumpSuit}!`);
    // Return the hidden card to whoever actually hid it — NOT this.bidder,
    // which may have changed to a different seat via a phase-2 raise while
    // the original chooser is still the one physically missing a card.
    if (this.hiddenTrump && this.hiddenTrumpOwner >= 0 && this.seats[this.hiddenTrumpOwner]) {
      // Per explicit instruction, the exact card is now public knowledge
      // the moment it's exposed, not just its suit -- captured here
      // BEFORE hiddenTrump gets cleared below, since the card itself
      // goes back into the owner's private hand and would otherwise
      // have no public record of which specific card it was at all.
      // Deliberately a separate field from hiddenTrump (which stays
      // cleared/private as before) rather than reusing it, so this
      // doesn't accidentally leak into any of hiddenTrump's other,
      // legitimately-private uses elsewhere in this file.
      this.revealedTrumpCard = { rank: this.hiddenTrump.rank, suit: this.hiddenTrump.suit };
      this.seats[this.hiddenTrumpOwner].hand.push(this.hiddenTrump);
      this.hiddenTrump = null;
      this.hiddenTrumpOwner = -1;
    }
  }

  // Reusable, always-computed-fresh check (never a stored flag that
  // could go stale) -- true iff Quote is genuinely available for THIS
  // exact player, right now: they still have a real cutoff window left
  // (at least 3 cards still in their own hand on this table -- the
  // 6-player table uses 2 instead, confirmed deliberately different,
  // not scaled proportionally to hand size either way; miss it and
  // Quote is gone for the rest of the round, no matter how clean their
  // team stays), they're the one OPENING the trick (the first card of
  // it, not following into one already started), their team is still
  // clean (hasn't lost a trick), it's actually the play phase (not
  // bidding, not between rounds), the bid qualifies, nobody's already
  // declared it this round, and there isn't a paused early-win decision
  // blocking normal play at this exact moment (declaring into that
  // pause would create two simultaneous, conflicting decisions).
  _isQuoteEligibleFor(pos) {
    if (pos === null || pos === undefined || !this.seats[pos]) return false;
    if (this.seats[pos].hand.length < 3) return false; // cutoff: must still have at least 3 cards of your own left
    if (this.trickCards.length !== 0) return false; // only the trick's opener can declare, not someone following mid-trick
    if (this.quoteState) return false;
    if (this.phase !== 'play') return false;
    if (this.highestBid > 19) return false;
    if (this.pendingEarlyWinChoice) return false;
    return !!this.teamStillClean[getTeam(pos)];
  }

  // During a Thani round, the caller's partner is folded out entirely --
  // never gets a turn, never gets dealt into any trick. This is what
  // every "move to the next player" step during actual play uses
  // instead of the plain nextPos() (which bidding still uses normally,
  // since Thani can only ever be called during bidding, before anyone's
  // folded yet). Outside of a Thani round, foldedSeats is always empty
  // and this behaves identically to nextPos().
  _nextActivePos(p) {
    let n = nextPos(p);
    let guard = 0;
    while (this.foldedSeats.includes(n) && guard++ < 4) n = nextPos(n);
    return n;
  }

  _trickWinner() {
    // A card only has genuine trump-beating power if it's actually the
    // trump suit AND wasn't just an incidental discard played before
    // trump was ever legitimately exposed (see playCard's
    // isIncidentalTrumpDiscard) — such a card stays powerless for this
    // trick forever, even if someone else legitimately exposes trump
    // later in this same trick.
    const isRealTrump = (tc) => this.trumpExposed && tc.card.suit === this.trumpSuit && !tc.powerless;
    let w = this.trickCards[0];
    for (let i = 1; i < this.trickCards.length; i++) {
      const tc = this.trickCards[i];
      const tcTrump = isRealTrump(tc), wTrump = isRealTrump(w);
      if (tcTrump && !wTrump) { w = tc; }
      else if (tcTrump && wTrump && RANK_ORDER[tc.card.rank] > RANK_ORDER[w.card.rank]) { w = tc; }
      else if (!tcTrump && !wTrump && tc.card.suit === w.card.suit && RANK_ORDER[tc.card.rank] > RANK_ORDER[w.card.rank]) { w = tc; }
    }
    return w;
  }

  _resolveTrick() {
    const winner = this._trickWinner();
    const points = this.trickCards.reduce((s, tc) => s + tc.card.points, 0);
    const team = getTeam(winner.pos);
    this.teamPoints[team] += points;
    this.lastTrick = {
      cards: this.trickCards.slice(),
      winner: winner.pos,
      points,
      team
    };
    this.addLog(`Seat ${winner.pos} won the trick (+${points}pts).`);

    // Per-team clean tracking for Quote eligibility -- whichever team
    // did NOT win this trick permanently loses their "still clean"
    // status for the rest of the round (it can never come back once
    // lost). At most one team can remain clean past trick 1, since a
    // trick always goes to exactly one side.
    const bidTeamThisRound = getTeam(this.bidder);
    this.teamStillClean[1 - team] = false;

    // Anyone who didn't follow the led suit just proved they're out of
    // it entirely (following suit is mandatory whenever you can) — a
    // permanent, useful fact for the rest of this round.
    if (this.trickSuit) {
      for (const tc of this.trickCards) {
        if (tc.card.suit !== this.trickSuit) this.voidSuits[tc.pos].add(this.trickSuit);
      }
    }

    // Every bot that played into this trick learns from the outcome —
    // won it or didn't, and how many points were on the line.
    for (const tc of this.trickCards) {
      const seatTc = this.seats[tc.pos];
      if (!seatTc || !seatTc.isBot) continue;
      const won = tc.pos === winner.pos;
      brain.recordTrickOutcome(seatTc.name, { trickLen: this.trickCards.length }, tc.card, won, points);
      this.learningPulseCount++;
      this.lastLearningBotName = seatTc.name;
    }

    this.tricksPlayed++;
    this.playedCardsThisRound.push(...this.trickCards.map(tc => tc.card));
    this.trickCards = [];
    this.trickSuit = '';
    this.mustPlayTrumpBy = -1; // never carries across tricks

    // Quote resolution: if quote is already active, its outcome is
    // decided the instant the declaring team loses ANY trick (fails
    // immediately -- no reason to keep playing out a bet that's already
    // lost). Success isn't specially checked here at all -- it just
    // falls through to the normal cardsLeft===0 path below like any
    // other round ending, since _endRound() already correctly checks
    // "did the declaring team capture all 28 points" regardless of
    // whether quote was ever involved.
    if (this.quoteState && team !== this.quoteState.team) {
      this._endRound();
      return;
    }

    // Thani resolution -- same "fail immediately" shape as COT above,
    // except the win condition is tricks, not points: the instant
    // anyone other than the caller wins a trick, it's over. Success,
    // like COT, isn't specially checked here -- it just falls through
    // to the normal cardsLeft===0 ending below, and by construction
    // that can only be reached having never failed this check on any
    // earlier trick, i.e. the caller won every single one.
    if (this.thaniCaller >= 0 && winner.pos !== this.thaniCaller) {
      this._endRound();
      return;
    }

    // Folded seats (Thani's partner) never play a single card, so their
    // hand sits untouched, full, for the entire round -- counting it
    // here would mean this could never reach 0 even after every ACTIVE
    // player has played out their whole hand.
    const cardsLeft = this.seats.reduce((s, seat, i) => s + (seat && !this.foldedSeats.includes(i) ? seat.hand.length : 0), 0);
    if (cardsLeft === 0 && this.hiddenTrump) {
      // Everyone else is out of cards but the hidden card's owner never
      // got to expose it — it becomes their forced final play. This is
      // whoever actually hid it, not necessarily the current bidder.
      this.currentPlayer = this.hiddenTrumpOwner;
      this._notify();
      this.maybeAutoAct();
    } else if (cardsLeft === 0) {
      this._endRound();
    } else if (this.thaniCaller >= 0) {
      // Thani has no early-win concept of its own -- its win condition
      // is handled entirely by the two checks above (fail the instant
      // anyone but the caller wins a trick; succeed by reaching
      // cardsLeft===0 without ever failing). The normal early-win math
      // below assumes a numeric highestBid<=28 (it computes
      // 28-highestBid, which goes negative and breaks completely once
      // highestBid is Thani's 29 sentinel) -- skipping it here avoids
      // that outright, not just working around its symptom.
      this.currentPlayer = winner.pos;
      this._notify();
      this.maybeAutoAct();
    } else {
      // Early-win offer: the outcome of this round just became
      // mathematically certain -- either the bidding team has already
      // captured enough to have made their bid regardless of what's
      // left, or the defense has captured enough that the bidder can
      // no longer reach their bid even by winning every remaining
      // point. Only offered once per round (earlyWinDeclined).
      const oT = 1 - bidTeamThisRound;
      const bidderClinched = this.teamPoints[bidTeamThisRound] >= this.highestBid;
      const defenseClinched = this.teamPoints[oT] > (28 - this.highestBid);
      const winningTeam = bidderClinched ? bidTeamThisRound : oT;
      // If the winning team (whichever one it is -- Quote is no longer
      // bidder-only) is STILL clean and their bid qualifies, don't
      // interrupt them with this popup -- Quote is available to them
      // right now (or will be the instant it's their turn), and forcing
      // the early-win choice first would cut across that. Once their
      // sweep actually breaks, this stops applying and the popup fires
      // normally.
      const stillQuoteCandidate = this.teamStillClean[winningTeam] && this.highestBid <= 19;
      if (!stillQuoteCandidate && !this.earlyWinDeclined && (bidderClinched || defenseClinched)) {
        // Ghost-controlled seats (isBot:false, per explicit request) can't answer this prompt
        // either - excluded here for the same reason as the stillHasHuman check inside
        // maybeAutoAct(), and critically important here specifically: this branch returns
        // without ever calling maybeAutoAct() itself, so if this check alone were wrong, a
        // ghost-only winning team would set this choice and then wait forever with nothing
        // left to ever re-check or resolve it.
        const hasHuman = [0, 1, 2, 3].some(p => getTeam(p) === winningTeam && this.seats[p] && !this.seats[p].isBot && !this.seats[p].ghostPlayer);
        if (hasHuman) {
          // A real person is on the winning team -- offer them the
          // choice and wait, however long it takes, for an actual
          // answer (see respondToEarlyWin()).
          this.pendingEarlyWinChoice = { team: winningTeam, made: bidderClinched };
          this.currentPlayer = winner.pos;
          this._notify();
          return;
        }
        // Nobody who'd need to see the remaining tricks is even
        // watching -- skip straight to ending the round instead of
        // pointlessly playing out an outcome that's already decided
        // with no one around who needs it. _endRound()'s scoring is a
        // pure threshold check either way, so this is exactly as
        // correct as playing it all the way out would have been.
        this._endRound();
        return;
      }

      this.currentPlayer = winner.pos;
      this._notify();
      this.maybeAutoAct();
    }
  }

  // Either player on the team that's just been offered the early-win
  // choice can respond for their team -- it affects the whole team, and
  // either partner making the call is reasonable. continuePlay=true just
  // resumes normal play (and won't be asked again this round);
  // continuePlay=false ends the round right now using the CURRENT,
  // already-decided point totals -- correct because _endRound()'s
  // scoring is a pure threshold check (did the bidding team's points
  // reach their bid), not dependent on how many tricks were actually
  // played.
  respondToEarlyWin(pos, continuePlay) {
    if (!this.pendingEarlyWinChoice) return false;
    if (getTeam(pos) !== this.pendingEarlyWinChoice.team) return false;
    this.pendingEarlyWinChoice = null;
    if (continuePlay) {
      this.earlyWinDeclined = true;
      this._notify();
      this.maybeAutoAct();
    } else {
      this._endRound();
    }
    return true;
  }

  // Declares COT (or MaruCOT, if declared by the non-bidding team -- see
  // the client for how the button's own LABEL reflects this; the
  // underlying mechanic is identical either way) -- a pure declaration,
  // not a card play. The player still plays their card normally
  // afterward via the usual playCard() flow; this just locks in the bet
  // before they do. Any player, on either team, can call it on their
  // own turn as long as their team is still clean -- see
  // _isQuoteEligibleFor() for the full check. Scoring differs by which
  // team declares it -- see _endRound() for the actual numbers.
  declareQuote(pos) {
    if (pos !== this.currentPlayer) return false;
    if (!this._isQuoteEligibleFor(pos)) return false;
    this.quoteState = { team: getTeam(pos) };
    const seat = this.seats[pos];
    const isBidderTeam = getTeam(pos) === getTeam(this.bidder);
    this.addLog(`${seat ? seat.name : 'Seat ' + pos} declared ${isBidderTeam ? 'COT' : 'MaruCOT'} — betting on a full sweep of all 8 tricks!`);
    this._notify();
    return true;
  }

  _endRound() {
    const bT = getTeam(this.bidder);
    const oT = 1 - bT;
    const isQuote = !!this.quoteState;
    const isThani = this.thaniCaller >= 0;
    let made, pts;
    if (isThani) {
      // Thani's win condition is tricks, not points -- highestBid was
      // deliberately set to 29 (unreachable by points alone, max is 28),
      // so the normal teamPoints>=highestBid check literally could never
      // be true and isn't used here at all. By the time _endRound() runs
      // for a Thani round, _resolveTrick() has already guaranteed one of
      // exactly two things happened: either it early-failed the instant
      // anyone but the caller won a trick, or every single trick
      // (including this last one) went to the caller -- so simply
      // checking who won the most recent trick correctly tells us which.
      made = !!(this.lastTrick && this.lastTrick.winner === this.thaniCaller);
      pts = made ? 3 : 4;
      const isHonors = true;
      if (made) { this.gameScore[bT] += pts; this.gameScore[oT] -= pts; }
      else { this.gameScore[oT] += pts; this.gameScore[bT] -= pts; }
      this.roundWinnerAnnounced = {
        bidderWon: made, made, bidder: this.bidder, highestBid: this.highestBid,
        teamPoints: this.teamPoints.slice(), pts, bidTeam: bT, isHonors,
        thani: true, thaniSuccess: made, tricksPlayed: this.tricksPlayed
      };
      this.phase = 'roundEnd';
      this.addLog(`Round ${this.round} over. Thani ${made ? 'succeeded — every trick won!' : 'failed'} (${made ? '+' : '-'}${pts}).`);
      this._finishRoundBookkeeping(bT, made);
      return;
    }
    if (isQuote) {
      // COT/MaruCOT replaces normal scoring entirely, evaluated as a
      // simple absolute fact -- did the DECLARING team (this.quoteState.
      // team -- NOT necessarily the bidder; either team can declare)
      // capture every one of the 28 points (a full 8-trick sweep).
      // Scoring depends on which side declared it: the bidding team's
      // own COT is +2 on success / -3 on failure (unchanged from
      // before); the non-bidding team's MaruCOT is +3 on success / -2
      // on failure -- a deliberately different risk/reward, not the
      // same numbers mirrored. This replaced an earlier "challenge"
      // system entirely (one team declares, the other optionally
      // challenges to escalate the stakes) -- there is no challenge
      // anymore, no escalation, just two different fixed payouts
      // depending on who declares.
      const cotTeam = this.quoteState.team;
      const otherTeam = 1 - cotTeam;
      const cotTeamIsBidder = cotTeam === bT;
      made = this.teamPoints[cotTeam] >= 28;
      if (cotTeamIsBidder) pts = made ? 2 : 3;
      else pts = made ? 3 : 2;
      const isHonors = this.highestBid >= 20;
      if (made) { this.gameScore[cotTeam] += pts; this.gameScore[otherTeam] -= pts; }
      else { this.gameScore[otherTeam] += pts; this.gameScore[cotTeam] -= pts; }
      this.roundWinnerAnnounced = {
        bidderWon: getTeam(this.bidder) === cotTeam ? made : !made,
        made, bidder: this.bidder, highestBid: this.highestBid,
        teamPoints: this.teamPoints.slice(), pts, bidTeam: bT, isHonors,
        quote: true, quoteSuccess: made, cotTeam, cotTeamIsBidder
      };
      this.phase = 'roundEnd';
      this.addLog(`Round ${this.round} over. ${cotTeamIsBidder ? 'COT' : 'MaruCOT'} ${made ? 'succeeded — full sweep!' : 'failed'} (${made ? '+' : '-'}${pts}).`);
      // The Q-mark/bot-learning logic below is entirely about whether
      // the BIDDER personally succeeded, which isn't the same question
      // as "did the COT-declaring team win their bet" -- if the DEFENSE
      // was the one who declared COT, their success means the bidder
      // was completely shut out, the opposite of the bidder succeeding.
      // Converting to the bidder's own true outcome here keeps
      // _finishRoundBookkeeping()'s bT/made parameters meaning exactly
      // what they've always meant, regardless of any of this COT
      // complexity above it.
      const bidderMadeIt = (getTeam(this.bidder) === cotTeam) ? made : !made;
      this._finishRoundBookkeeping(bT, bidderMadeIt);
      return;
    }
    made = this.teamPoints[bT] >= this.highestBid;
    if (this.highestBid >= 28) pts = made ? 3 : 4;
    else if (this.highestBid >= 20) pts = made ? 2 : 3;
    else pts = made ? 1 : 2;
    const isHonors = this.highestBid >= 20;
    if (made) { this.gameScore[bT] += pts; this.gameScore[oT] -= pts; }
    else { this.gameScore[oT] += pts; this.gameScore[bT] -= pts; }
    this.roundWinnerAnnounced = {
      bidderWon: made, made, bidder: this.bidder, highestBid: this.highestBid,
      teamPoints: this.teamPoints.slice(), pts, bidTeam: bT, isHonors,
      quote: false, quoteSuccess: undefined
    };
    this.phase = 'roundEnd';
    this.addLog(`Round ${this.round} over. ${made ? 'Bid made' : 'Bid failed'} (+/-${pts}).`);
    this._finishRoundBookkeeping(bT, made);
  }

  // Shared tail end of _endRound() -- Q-mark shedding, bot learning,
  // and whatever else follows scoring, factored out so both the COT and
  // normal scoring branches above can share it without duplicating it
  // or risking the two copies drifting apart later. bT/made here are
  // always BIDDER-centric ("did the bidder's own team come out ahead"),
  // never COT-team-centric -- see the conversion in the COT branch above
  // for why that distinction matters.
  _finishRoundBookkeeping(bT, made) {
    // Q-mark removal: personally calling and winning a bid sheds one Q
    // from yourself, if you're carrying any. On the very first hand of a
    // new championship specifically, a successful bidder ALSO sheds one
    // Q from their partner (if the partner has one) — everywhere else,
    // it's strictly self-service only. Never more than one Q removed per
    // player per hand, however many they're carrying.
    if (made) {
      const bidderSeat = this.seats[this.bidder];
      if (bidderSeat && this.qMarks[bidderSeat.name] > 0) {
        this.qMarks[bidderSeat.name]--;
        if (this.qMarks[bidderSeat.name] <= 0) delete this.qMarks[bidderSeat.name];
        this.addLog(`${bidderSeat.name} shed a Q by calling and winning the bid.`);
      }
      if (this.isFirstHandOfChampionship) {
        const partnerPos = this.bidder === 0 ? 3 : this.bidder === 3 ? 0 : this.bidder === 1 ? 2 : 1;
        const partnerSeat = this.seats[partnerPos];
        if (partnerSeat && this.qMarks[partnerSeat.name] > 0) {
          this.qMarks[partnerSeat.name]--;
          if (this.qMarks[partnerSeat.name] <= 0) delete this.qMarks[partnerSeat.name];
          this.addLog(`${partnerSeat.name} also shed a Q — first hand of the championship, partner's bid came through.`);
        }
      }
    }
    this.isFirstHandOfChampionship = false;

    // Feed every bot's brain the outcome — this is what makes them
    // actually improve over time instead of repeating the same static
    // heuristic forever. The bidder learns specifically from whether
    // their bid succeeded; every bot (bidding team or not) logs a round
    // outcome based on whether their own team came out ahead.
    const bidderSeat = this.seats[this.bidder];
    const bidderIsHuman = bidderSeat && !bidderSeat.isBot;
    for (let i = 0; i < 4; i++) {
      const seatI = this.seats[i];
      if (!seatI || !seatI.isBot) continue;
      const wonRound = (getTeam(i) === bT) === made;
      if (i === this.bidder && this._bidderHandProfileForLearning) {
        brain.recordBidOutcome(seatI.name, this._bidderHandProfileForLearning, this.highestBid, made, wonRound);
        this.learningPulseCount++;
        this.lastLearningBotName = seatI.name;
      }
      // Every OTHER bot at the table (not the bidder itself, that's a
      // different bot's own outcome above) builds its own read on this
      // specific human if the bidder was one -- as a partner if same
      // team, as an opponent otherwise.
      if (bidderIsHuman && i !== this.bidder) {
        brain.recordHumanBidObservation(seatI.name, bidderSeat.playerId, getTeam(i) === bT, this.highestBid, made);
      }
      brain.recordRound(seatI.name, wonRound);
      this.learningPulseCount++;
      this.lastLearningBotName = seatI.name;
    }
    this._bidderHandProfileForLearning = null;
    // Flush to disk right here rather than relying purely on the periodic
    // timer — round-ends are infrequent enough that this costs nothing
    // meaningful, and frequent enough that an unexpected restart (a Render
    // redeploy, a crash, anything that skips the graceful-shutdown save
    // handlers) can never lose more than the tricks within a single round.
    brain.saveBrains();

    // Championship check: matches the reference exactly — a championship
    // ends when either team reaches 12, OR when either team's score drops
    // to 0 or below (losing badly enough counts as the other side winning
    // outright, not just a very low score).
    this.lastChampionshipResult = null;
    if (this.gameScore[0] >= 12 || this.gameScore[1] >= 12 || this.gameScore[0] <= 0 || this.gameScore[1] <= 0) {
      const winningTeam = this.gameScore[0] > this.gameScore[1] ? 0 : 1;
      const losingTeam = 1 - winningTeam;
      this.kingStreak[winningTeam]++;
      this.kingStreak[losingTeam] = 0;
      const isKing = this.kingStreak[winningTeam] >= this.KING_TARGET;
      this.lastChampionshipResult = {
        championshipNumber: this.championshipNumber,
        winningTeam, finalScore: this.gameScore.slice(),
        kingStreak: this.kingStreak.slice(), isKing
      };
      this.addLog(`Championship ${this.championshipNumber} won by team ${winningTeam} (streak: ${this.kingStreak[winningTeam]})${isKing ? ' — KING OF THE TABLE!' : ''}.`);
      // This scoring system is zero-sum (every point gained by one team
      // is lost by the other), so every championship necessarily ends
      // 12-0/0-12 — there's no such thing as a "close" loss here. Every
      // player on the losing side picks up a Q.
      for (let i = 0; i < 4; i++) {
        const s = this.seats[i];
        if (!s || getTeam(i) !== losingTeam) continue;
        this.qMarks[s.name] = (this.qMarks[s.name] || 0) + 1;
        this.qTotalEver[s.name] = (this.qTotalEver[s.name] || 0) + 1;
      }
      this.addLog(`Team ${losingTeam} shut out — every player picks up a Q.`);
      // Start the next championship: reset the match score, keep everyone
      // seated exactly as they are, and keep counting. If someone just
      // became King, the streak naturally starts back at 0 next time
      // (matches the reference: winning again after being crowned just
      // starts building a fresh streak, it doesn't lock the table).
      this.gameScore = [6, 6];
      this.championshipNumber++;
      this.isFirstHandOfChampionship = true;
    }

    this._notify();
  }

  // ---------------- Bots ----------------
  // Deliberately simple — legal-move heuristics, not the client's learning
  // brain system. Good enough to keep an empty seat playing sensibly while
  // authority lives here; the client can still layer its own smarter bot
  // presentation/flavor on top if desired.

  maybeAutoAct() {
    // A pending early-win choice isn't a card-play turn at all -- it's a
    // yes/no decision offered to a specific team, and the normal
    // stuck-seat logic below (which assumes currentPlayer owes a CARD)
    // doesn't apply to it. But the same underlying risk still exists: if
    // the human this was offered to disconnects before responding, the
    // whole table would otherwise wait forever for an answer that's
    // never coming. If literally everyone on the winning team is now a
    // bot or disconnected (checked fresh here, since that can change
    // after the prompt was first shown), auto-resolve with "keep
    // playing" -- the safest, least-surprising default that just
    // continues the round normally, exactly as if this feature didn't
    // exist for them.
    if (this.pendingEarlyWinChoice) {
      const team = this.pendingEarlyWinChoice.team;
      // A ghost-controlled seat (isBot:false, per explicit request) can't actually respond to
      // this prompt any more than a real bot can - there's no client to send the choice back.
      // Excluded here the same way isBot seats already are, otherwise a team made up of only
      // ghosts and bots would leave this waiting forever for an answer nobody can send.
      const stillHasHuman = [0, 1, 2, 3].some(p => getTeam(p) === team && this.seats[p] && !this.seats[p].isBot && !this.seats[p].ghostPlayer && this.seats[p].connected);
      if (!stillHasHuman) {
        const anyPosOnTeam = [0, 1, 2, 3].find(p => getTeam(p) === team);
        this.respondToEarlyWin(anyPosOnTeam, true);
      }
      return;
    }
    const seat = this.seats[this.currentPlayer];
    if (!seat) return; // truly empty seat — caller must fill or skip
    // Track how long the current seat has actually been on the clock,
    // not how long ago maybeAutoAct() happened to last be called (which
    // can be re-invoked many times for the same turn, e.g. once per
    // reconnect) - only a genuine turn change resets this.
    if (this._turnTrackedPlayer !== this.currentPlayer || this._turnTrackedRound !== this.round) {
      this._turnTrackedPlayer = this.currentPlayer;
      this._turnTrackedRound = this.round;
      this.turnStartedAt = Date.now();
    }
    const turnAgeMs = Date.now() - (this.turnStartedAt || Date.now());
    // A seat that LOOKS connected but hasn't actually acted in a very
    // long time is almost certainly a zombie connection (a network
    // transition the socket layer never cleanly detected as a
    // disconnect) rather than a human genuinely still thinking - no
    // real turn takes 2 minutes. Once past that, treat it exactly like
    // an explicitly disconnected seat so the table can recover on its
    // own instead of staying stuck until someone happens to reconnect
    // in a way that coincidentally un-sticks it.
    const CONNECTED_BUT_STUCK_MS = 120000;
    // A ghost-player seat (admin-run, per explicit request) is deliberately kept isBot:false
    // so it displays and behaves as a genuine connected human everywhere else in the game
    // (green "live" status dot, counted as a real player for room listings, etc.) - but still
    // needs the engine to actually play it, since there's no real socket ever sending moves
    // for it. Checked as its own separate condition here rather than folded into isBot itself.
    const isGhost = seat.ghostPlayer === true;
    const treatAsStuck = seat.isBot || isGhost || !seat.connected || turnAgeMs >= CONNECTED_BUT_STUCK_MS;
    if (treatAsStuck) {
      // A disconnected human gets covered the same way a bot seat does —
      // otherwise their turn just freezes the whole table indefinitely
      // waiting for them to come back. The moment they reconnect, control
      // returns to them completely normally on their next turn.
      //
      // The delay here matters for a reason beyond just "feels nicer": bots
      // used to act via setImmediate (zero delay). When 2-3 bots play in a
      // row, all of that could happen within milliseconds — faster than a
      // client can render each intermediate state. The player would only
      // ever see the LATEST card, making it look like other players' turns
      // were being silently skipped when they weren't; the engine was
      // correct, the human just never got a chance to see the steps.
      const capturedPos = this.currentPlayer;
      const capturedRound = this.round;
      const capturedTurnStartedAt = this.turnStartedAt;
      // Bots always act at a comfortable, watchable pace. A disconnected
      // HUMAN gets a real grace period instead — brief network hiccups are
      // common and often invisible to the person experiencing them (their
      // client silently reconnects a second later). Treating that the same
      // as "gone for good" meant a hiccup at exactly the wrong moment could
      // make a one-time decision like choosing trump get made for them
      // before they even noticed anything happened.
      // Same reasoning as the 6-player engine: 10s was too tight to
      // absorb a brief mobile connectivity blip before a bot takes over
      // an actively-present human's seat.
      // A seat that's already past the connected-but-stuck threshold has
      // used up its grace period already - act promptly rather than
      // making the table wait out a full fresh 35s on top of the 2
      // minutes it's already been stuck.
      const delay = seat.isBot ? 900
        // Per explicit request: a ghost seat should "sometimes take a few sec to play" rather
        // than react instantly like a bot or wait out a long human grace period - a randomized
        // 2-6s window reads as someone actually thinking about their move, not a script.
        : isGhost ? (2000 + Math.floor(Math.random() * 4000))
        : (turnAgeMs >= CONNECTED_BUT_STUCK_MS ? 900 : 35000);
      setTimeout(() => {
        // Re-check everything at fire-time, not just at schedule-time:
        // - the round hasn't moved on
        // - it's still actually this seat's turn
        // - this seat is STILL a bot, STILL disconnected, or STILL past
        //   the connected-but-stuck threshold (re-derived fresh here,
        //   not reused from schedule-time) — if a human reconnected AND
        //   genuinely resumed play during this delay, they should get
        //   to act themselves now, not have a card auto-played out from
        //   under them the moment they came back.
        if (this.round !== capturedRound) return;
        if (this.currentPlayer !== capturedPos) return;
        const seatNow = this.seats[capturedPos];
        if (!seatNow) return;
        const stillStuck = seatNow.isBot || seatNow.ghostPlayer === true || !seatNow.connected || (Date.now() - (capturedTurnStartedAt || Date.now())) >= CONNECTED_BUT_STUCK_MS;
        if (!stillStuck) return;
        this._botAct(capturedPos);
      }, delay);
    }
    // Connected human seats just wait for a client message; nothing to do here.
  }

  _botAct(pos) {
    try {
      this._botActInner(pos);
    } catch (e) {
      // Never let a bad bot decision permanently freeze the table. The
      // server's global uncaughtException handler keeps the PROCESS alive
      // on an unhandled throw here, but it does nothing to un-stick THIS
      // seat's turn - nothing else was going to retry it, so the table
      // would otherwise wait forever for an action that will never come.
      // Fall back to the simplest guaranteed-legal action for whatever
      // phase we're actually in, so the round always keeps moving even
      // when the "smart" logic above hits something it didn't expect.
      console.error(`[bot-safety] _botAct threw for seat ${pos} in phase ${this.phase} (round ${this.round}) - falling back to a safe default action:`, e && e.stack || e);
      try {
        if (this.phase === 'bidding1' && this.currentPlayer === pos) {
          const bid = this.isFirstBidder(pos) ? 14 : 0;
          const result = this.placeBid(pos, bid);
          if (!result.ok) this.placeBid(pos, 0);
        } else if (this.phase === 'choosingTrump' && pos === this.bidder) {
          this.chooseTrump(pos, SUITS[0], null);
        } else if (this.phase === 'bidding2' && this.currentPlayer === pos) {
          this.passPhase2(pos);
        } else if (this.phase === 'play' && this.currentPlayer === pos) {
          const hand = this.seats[pos].hand;
          if (hand.length === 0 && this.hiddenTrump && pos === this.hiddenTrumpOwner) {
            this.playHiddenTrump(pos);
          } else {
            const legal = hand.find(c => this.canPlayCard(pos, c));
            if (legal) this.playCard(pos, legal);
          }
        }
      } catch (e2) {
        // If even the fallback fails, log it clearly rather than throwing
        // again silently - at minimum this gives a concrete trace to chase.
        console.error(`[bot-safety] fallback action ALSO threw for seat ${pos}:`, e2 && e2.stack || e2);
      }
    }
  }

  _botActInner(pos) {
    if (this.phase === 'bidding1' && this.currentPlayer === pos) {
      const botName = this.seats[pos].name;
      const b = brain.getBrain(botName);
      const hand = this.seats[pos].hand;
      const first = this.isFirstBidder(pos);
      const restricted = this._isBidRestrictedToHonors(pos);
      const minBid = restricted ? Math.max(20, this.highestBid + 1) : (this.highestBid > 0 ? this.highestBid + 1 : 14);

      // Suit-dominance based evaluation (see evaluatePhase1Hand above) —
      // replaces flat point-counting, which badly overrated hands like
      // four scattered Jacks (12 raw points, but zero suit control) over
      // a genuine same-suit J-9-A-10 lock (only 7 raw points, but total
      // command of one suit).
      const ev = evaluatePhase1Hand(hand);

      // How comfortable this particular bot is committing depends on its
      // brain's personality: a cautious/low-level bot wants a much safer
      // margin before bidding than a confident, aggressive one.
      // Raised from 0.75 after real-game reports of bots committing to
      // bids their actual hand didn't support and losing badly — even a
      // confident, high-level bot should want real odds before bidding.
      // Leveling up (and the aggression increase that comes with it) is
      // driven purely by accumulated experience, which grows from EVERY
      // bid outcome including failures - so on its own this had no way
      // to ever pull a bot back toward caution, only push it further
      // toward confidence the more it played, regardless of whether its
      // bids were actually working. This performance term is the missing
      // other half: once there's enough real history to judge (5+
      // decided bids), an actual success rate running below break-even
      // raises the threshold back up, proportional to how badly it's
      // missing - a bot that's been failing most of its bids gets
      // meaningfully more cautious here, not just plateaued at whatever
      // aggression its level happened to unlock.
      const totalDecidedBids = b.stats.bidsWon + b.stats.bidsLost;
      const performanceAdjustment = totalDecidedBids >= 5
        ? Math.max(0, 0.5 - (b.stats.bidsWon / totalDecidedBids)) * 0.6
        : 0;
      const comfortThreshold = Math.min(0.9, Math.max(0.45,
        0.85 - (b.level - 1) * 0.08 - (b.bidWeights.aggression - 1) * 0.1 + performanceAdjustment));

      // The hand itself sets a hard ceiling (see evaluatePhase1Hand) -
      // confidence only decides how close to it this bot actually
      // commits, never past it. A high comfortThreshold (cautious/
      // unproven bot) holds back a little even on a strong hand; a low
      // one (confident, proven bot) commits to the full ceiling the
      // cards support. Real-game reports of bots bidding well past what
      // their hand justified were exactly this: a confidence estimate
      // that could keep climbing on its own, disconnected from what was
      // actually in hand. Now the cards decide the ceiling; confidence
      // only ever pulls back from it, never past it.
      const confidenceFactor = Math.max(0, Math.min(1, (0.9 - comfortThreshold) / (0.9 - 0.45)));
      // Modest pullback (at most 2) for a cautious/unproven bot, not a
      // full rescale of the whole range - the hand's own composition is
      // the dominant factor here, personality is a small nudge around
      // it, not something that can swamp what the cards actually support.
      const pullback = Math.round((1 - confidenceFactor) * 2);
      let target = ev.eligibleToRaise ? Math.max(14, ev.hardCeiling - pullback) : 14;

      // A hand that reads as much better for DEFENSE than OFFENSE — the
      // classic "scattered Jacks, no suit control" case — should pull the
      // bot back from committing high even if the ceiling itself looked
      // OK, mirroring the real distinction between a good bidding hand
      // and a good defending hand.
      if (ev.defensive > ev.offensive * 1.3) {
        target = Math.max(14, target - 3);
      }

      // Partner bidding signal from last round. "higher" stays a light
      // nudge here, folded in with everything else below. "lower" is
      // handled separately, much later (see after pattern memory) - a
      // small nudge this early was getting overridden by the partner-
      // support bonus and pattern-memory blend that both run afterward,
      // so a human explicitly asking their bot partner to stay
      // cautious could still end up watching it bid high anyway,
      // especially with a high-confidence bot on a winning streak. A
      // deliberate "stay low" ask from the human deserves to actually
      // hold, not get quietly walked back up by the bot's own
      // enthusiasm a few lines later.
      const wantsLower = this.partnerSignals[pos] && this.partnerSignals[pos].forRound === this.round &&
        this.partnerSignals[pos].signal === 'lower';
      if (this.partnerSignals[pos] && this.partnerSignals[pos].forRound === this.round) {
        const sig = this.partnerSignals[pos].signal;
        if (sig === 'higher') target = Math.min(ev.hardCeiling, target + 3);
      }

      // Partner already winning the bidding is worth leaning into a
      // little further, same spirit as before -- and if that partner is
      // a specific human this bot has a track record with, lean in
      // further still for a proven partner or pull back slightly for one
      // who's often missed (see bot-brain's partnerTrustMultiplier).
      let pb = 0;
      if (this.bidder >= 0 && getTeam(this.bidder) === getTeam(pos)) {
        const partnerSeat = this.seats[this.bidder];
        const trust = (partnerSeat && !partnerSeat.isBot) ? brain.partnerTrustMultiplier(b, partnerSeat.playerId) : 1.0;
        pb = 1 * b.bidWeights.partnerSupport * trust;
      }
      target = Math.min(ev.hardCeiling, Math.round(target + pb));

      // Pattern memory: has this bot seen a similar hand work out before?
      // Blended with (rather than fully overriding) the principled target
      // above, since the target itself is now grounded in real hand
      // features rather than a guess pattern memory needs to correct for.
      const handProfile = brain.getHandProfile(hand);
      const similarBids = b.patterns.successfulBids.filter(sb => {
        const hp = sb.handProfile;
        return Math.abs(hp.totalPoints - handProfile.totalPoints) <= 2 &&
               Math.abs(hp.highCardCount - handProfile.highCardCount) <= 1;
      });
      if (similarBids.length > 0 && Math.random() < 0.3 * b.level) {
        const avgBid = similarBids.reduce((s, sb) => s + sb.bid, 0) / similarBids.length;
        // Only ever pull DOWN toward a more conservative memory, never up -
        // see the comment above this block for why.
        target = Math.min(target, Math.round((target + avgBid) / 2));
      }

      // "Stay low" is the deliberate last word on this bid, applied
      // after every other adjustment above (partner-support bonus,
      // pattern memory) so nothing downstream of the signal can walk
      // the target back up again. Capped low enough that a non-first
      // bidder will correctly pass rather than still committing to
      // something well above what the human explicitly asked for.
      if (wantsLower) target = Math.min(target, 16);

      let bid = 0;
      if (first) {
        bid = Math.max(14, Math.min(target, 20));
      } else if (minBid <= target && minBid <= 28) {
        bid = minBid <= target - 2 ? minBid + 1 : minBid;
      }
      // First bidder cannot pass — must bid at least 14 regardless of what
      // the evaluation came out to.
      if (first && bid === 0) bid = 14;

      const result = this.placeBid(pos, bid);
      if (!result.ok) this.placeBid(pos, 0); // never leave the table stuck on a rejected bid
      delete this.partnerSignals[pos]; // one-shot: consumed the moment this seat actually bids
    } else if (this.phase === 'choosingTrump' && pos === this.bidder) {
      // Faithful port of the reference's botChooseTrumpWithBrain.
      const b = brain.getBrain(this.seats[pos].name);
      const hand = this.seats[pos].hand;
      // The hand is still the original 4 cards here -- the second batch
      // of 4 isn't dealt until after trump is chosen (see the rules
      // comment at the top of this file) -- so this is the exact same
      // hand evaluatePhase1Hand already scored during bidding. If it
      // flagged a specific suit (9-A-10 of one suit, no Jack of that
      // suit, plus a separate bonus Jack elsewhere), that's a strong
      // enough signal to just call it directly rather than leave the
      // choice to the generic point-counting below.
      const ev = evaluatePhase1Hand(hand);
      if (ev.suggestedTrumpSuit) {
        this.chooseTrump(pos, ev.suggestedTrumpSuit, null);
        return;
      }
      const ss = {};
      for (const s of SUITS) ss[s] = { points: 0, hasJ: false, has9: false, hasK: false, hasQ: false, count: 0 };
      for (const c of hand) {
        ss[c.suit].points += c.points;
        ss[c.suit].count++;
        if (c.rank === 'J') ss[c.suit].hasJ = true;
        if (c.rank === '9') ss[c.suit].has9 = true;
        if (c.rank === 'K') ss[c.suit].hasK = true;
        if (c.rank === 'Q') ss[c.suit].hasQ = true;
      }
      let best = SUITS[0], bs = -1;
      for (const s of SUITS) {
        let sc = ss[s].points * 3 * b.bidWeights.pointCards;
        sc += (ss[s].hasJ ? 8 : 0) * b.bidWeights.highCards;
        sc += (ss[s].has9 ? 5 : 0) * b.bidWeights.highCards;
        sc += (ss[s].hasK && ss[s].hasQ ? 6 : 0) * b.bidWeights.trumpPotential;
        sc += (ss[s].count >= 3 ? 4 : 0);
        sc += (ss[s].count * b.level * 0.5);
        if (sc > bs) { bs = sc; best = s; }
      }
      this.chooseTrump(pos, best, null);
    } else if (this.phase === 'bidding2' && this.currentPlayer === pos) {
      const b = brain.getBrain(this.seats[pos].name);
      const hand = this.seats[pos].hand; // full 8 cards by now
      const myTeam = getTeam(pos), bidTeam = getTeam(this.bidder), isBT = myTeam === bidTeam;

      // Raising always means picking a fresh trump (see raiseBid), so the
      // real question is "how strong is my hand at its OWN best suit" —
      // not how strong it happens to be at whatever trump is currently
      // set (that may not even be a suit this bot holds well).
      const ev = bestPhase2Evaluation(hand);

      // Every trick this hand can't be expected to cover itself has to
      // come from partner or from opponents' unavoidable discards. The
      // latter is a fairly stable, modest baseline; anything beyond that
      // is a real partner-dependency gap, and the further a target bid
      // reaches past this hand's own estimate, the shakier it gets —
      // "hands that need significant help should receive lower
      // confidence" and doubling especially "should never be automatic".
      const baselineOpponentLeakage = 3;
      const ownEstimate = ev.ownPointEstimate + baselineOpponentLeakage;

      const probByBid = {};
      for (const lvl of [20, 22, 24, 26, 28]) {
        const margin = ownEstimate - lvl; // positive = own hand comfortably covers this bid already
        let p = margin >= 0
          ? 0.95 - 0.2 * Math.exp(-margin / 3.5)
          : 0.75 * Math.exp(margin / 3.5); // continues smoothly from the ~0.75 the positive branch reaches at margin=0 (0.95-0.2), not a jump to ~0.95
        probByBid[lvl] = Math.max(0.03, Math.min(0.97, p));
      }

      // A cautious/low-level bot wants a safer read before committing to
      // these high-stakes bids, where failing costs far more than a
      // Phase 1 miss — risk vs. reward, not just "bid as high as
      // possible". Taking the contract AWAY from the current bidder
      // (not already on their team) is a bigger commitment than merely
      // extending your own side's existing bid, so it needs a clearly
      // higher bar.
      const totalDecidedBids2 = b.stats.bidsWon + b.stats.bidsLost;
      const performanceAdjustment2 = totalDecidedBids2 >= 5
        ? Math.max(0, 0.5 - (b.stats.bidsWon / totalDecidedBids2)) * 0.6
        : 0;
      const baseThreshold = Math.min(0.92, Math.max(0.48,
        0.86 - (b.level - 1) * 0.08 - (b.bidWeights.aggression - 1) * 0.1 + performanceAdjustment2));
      const riskThreshold = isBT ? baseThreshold : baseThreshold + 0.15;

      const minRaise = Math.max(20, this.highestBid + 1);
      let raised = false;
      let tr = 0;
      for (const lvl of [20, 22, 24, 26, 28]) {
        const topTierPremium = lvl >= 28 ? 0.05 : 0;
        if (lvl >= minRaise && probByBid[lvl] >= riskThreshold + topTierPremium) tr = lvl;
      }
      // Some randomness even when the read is favorable, and only ever
      // for genuinely live opportunities (never as a pure bluff) —
      // mirrors the previous behavior's occasional contested raise.
      if (tr > 0 && (isBT || Math.random() < 0.3 * b.level)) {
        raised = !!this.raiseBid(pos, tr).ok;
      }
      if (!raised) this.passPhase2(pos);
    } else if (this.phase === 'play' && this.currentPlayer === pos) {
      // Faithful port of the reference's botPlayWithBrain + chooseBotCardBase.
      const b = brain.getBrain(this.seats[pos].name);
      const hand = this.seats[pos].hand;
      if (hand.length === 0 && this.hiddenTrump && pos === this.hiddenTrumpOwner) {
        this.playHiddenTrump(pos);
        return;
      }
      const myTeam = getTeam(pos), bidTeam = getTeam(this.bidder), isBT = myTeam === bidTeam;
      const hasSuit = hand.some(c => c.suit === this.trickSuit);
      const trumps = hand.filter(c => c.suit === this.trumpSuit);
      const tPts = this.trickCards.reduce((s, tc) => s + tc.card.points, 0);
      const cw = this._currentTrickWinnerSoFar();
      const wt = cw ? getTeam(cw.pos) : -1;
      const cwc = cw ? cw.card : null;
      const isLast = this.trickCards.length === 3;

      // Trump-calling decision: can't follow suit, trump not yet exposed.
      if (!hasSuit && !this.trumpExposed && this.trickSuit !== '' && trumps.length >= 0) {
        const goodExposures = b.patterns.trumpExposures.filter(te => te.exposed && te.goodOutcome);
        let callTrump = false;
        // None of the reasons below justify exposing trump and cutting in
        // if our OWN partner already has this trick won for free — that's
        // pure waste: we'd be spending a trump card (and giving away
        // where trump lives, information the whole table can use against
        // us) to "win" a trick our team already had. This was the actual
        // bug behind repeated "why did my partner cut over me" reports —
        // holding a J/9 of trump, or simply seeing points already on the
        // table, used to trigger a call regardless of who was winning.
        if (wt !== myTeam) {
          if (goodExposures.length > 0 && Math.random() < 0.4 * b.level) callTrump = true;
          else if (pos === this.bidder) callTrump = true;
          else if (isLast && tPts > 0) callTrump = true;
          else if (tPts >= 2) callTrump = true;
          else if ((this.suitLeadCount[this.trickSuit] || 0) >= 2 && tPts >= 1) callTrump = true;
          else if (trumps.some(t => t.rank === 'J' || t.rank === '9')) callTrump = true;
          else if (this.trickCards.some(tc => tc.card.points > 0 || tc.card.rank === 'J' || tc.card.rank === '9')) callTrump = true;
          // Same "first time this suit's been led this round" trigger
          // added to the post-exposure cutting decision — but that fix
          // alone didn't cover this actual reported case, since trump
          // hadn't been exposed yet at all when it happened. This is
          // the real decision point for that: whether to be the one who
          // calls for trump to be opened in the first place. wt !==
          // myTeam above still applies regardless of this new trigger,
          // same reasoning as before — never call trump just to win a
          // trick our own partner already has for free.
          else if ((this.suitLeadCount[this.trickSuit] || 0) === 1) callTrump = true;
        }
        if (callTrump) {
          const goodOutcome = wt !== myTeam; // calling trump to steal back a trick the other team was winning
          brain.recordTrumpExposure(this.seats[pos].name, { trickLen: this.trickCards.length }, true, goodOutcome);
          if (pos === this.hiddenTrumpOwner && this.hiddenTrump) {
            // The hidden-trump owner reveals by playing their specific
            // hidden card, not an arbitrary trump card from their open
            // hand - that's the whole point of it being hidden. Any
            // other trump cards this bot happens to also be holding
            // openly stay subject to the normal incidental-discard /
            // now-illegal-until-exposed rules, same as anyone else's.
            this.playHiddenTrump(pos);
            return;
          }
          this.exposeTrump();
          if (trumps.length > 0) {
            trumps.sort((a, c) => RANK_ORDER[c.rank] - RANK_ORDER[a.rank]);
            // This is always a FIRST cut — trump wasn't exposed before this
            // exact moment, and any earlier same-trick trump card would
            // only have been an "incidental," powerless discard (see
            // playCard's isIncidentalTrumpDiscard) that can't currently be
            // winning. So any trump we hold wins this outright, and
            // reflexively playing our best one (often the Jack) to win a
            // trick a King or 7 would have won just as well is exactly the
            // waste reported — a bidder doing this on their own last turn
            // with cheaper trump sitting right there in hand.
            const nonJackTrumps = trumps.filter(c => c.rank !== 'J');
            const zeroPt = nonJackTrumps.filter(c => c.points === 0);
            let cutCard = zeroPt.length > 0 ? zeroPt[zeroPt.length - 1]
              : nonJackTrumps.length > 0 ? nonJackTrumps[nonJackTrumps.length - 1]
              : trumps[trumps.length - 1];
            // Still respect real overtake risk: if other players still
            // act after us in this same trick and the trump Jack hasn't
            // been seen yet, a big enough trick is worth committing our
            // strongest trump to make sure it actually holds up.
            if (!isLast && !this._isRankSeen(this.trumpSuit, 'J') && cutCard.rank !== 'J' && tPts >= 3) {
              cutCard = trumps[0];
            }
            this.playCard(pos, cutCard);
          } else {
            const allCards = [...hand].sort((a, c) => a.points !== c.points ? a.points - c.points : RANK_ORDER[a.rank] - RANK_ORDER[c.rank]);
            this.playCard(pos, allCards[0]);
          }
          return;
        }
      }

      const chosen = this._chooseBotCardBase(pos, hand, myTeam, bidTeam, isBT, isLast, cw, wt, cwc, tPts);
      this.playCard(pos, chosen);
    }
  }

  // Every card accounted for so far this round — completed tricks plus
  // whatever's already down in the trick currently being played. The
  // bot AI's memory: "has this suit's Jack already appeared", "which
  // trumps are still unaccounted for", etc.
  _cardsSeenSoFar() {
    return this.playedCardsThisRound.concat(this.trickCards.map(tc => tc.card));
  }
  _isRankSeen(suit, rank) {
    return this._cardsSeenSoFar().some(c => c.suit === suit && c.rank === rank);
  }

  // Who's winning the CURRENT (in-progress) trick so far — used by bot
  // play logic to decide whether to contest it. Not to be confused with
  // _trickWinner(), which is only called once a trick is complete.
  _currentTrickWinnerSoFar() {
    if (this.trickCards.length === 0) return null;
    const isRealTrump = (tc) => this.trumpExposed && tc.card.suit === this.trumpSuit && !tc.powerless;
    let w = this.trickCards[0];
    for (let i = 1; i < this.trickCards.length; i++) {
      const tc = this.trickCards[i];
      const tcTrump = isRealTrump(tc), wTrump = isRealTrump(w);
      if (tcTrump && !wTrump) { w = tc; }
      else if (tcTrump && wTrump && RANK_ORDER[tc.card.rank] > RANK_ORDER[w.card.rank]) { w = tc; }
      else if (!tcTrump && !wTrump && tc.card.suit === w.card.suit && RANK_ORDER[tc.card.rank] > RANK_ORDER[w.card.rank]) { w = tc; }
    }
    return { pos: w.pos, card: w.card };
  }

  // Faithful port of the reference's chooseBotCardBase — the actual card-
  // selection strategy (leading, following suit, trumping in, discarding).
  _chooseBotCardBase(pos, hand, myTeam, bidTeam, isBT, isLast, cw, wt, cwc, tPts) {
    const b = brain.getBrain(this.seats[pos].name);
    const isBidder = pos === this.bidder;
    // Bid-target awareness: teamPoints was already tracked live (updated
    // after every trick) but never actually READ by any decision here --
    // the bots had no notion of whether their own side was falling
    // behind what it needs, or had already secured the round's outcome.
    // myTeamTarget/myTeamNeeds is generic across both roles: the bidding
    // team needs teamPoints >= highestBid; the defending team's
    // equivalent goal is capturing enough to guarantee the bid fails
    // (more than 28-highestBid, i.e. at least 29-highestBid).
    const myTeamTarget = isBT ? this.highestBid : (29 - this.highestBid);
    const myTeamNeeds = myTeamTarget - this.teamPoints[myTeam];
    const pointsRemainingInPlay = 28 - this.teamPoints[0] - this.teamPoints[1];
    // "Desperate": genuinely needs most of what's mathematically still
    // available, not just "behind by a little" -- a low bar here would
    // make bots panic-spend trump on ordinary tricks constantly, which
    // isn't what real urgency looks like. 70% of what's left is a real,
    // meaningful threshold: comfortably still gettable with a normal
    // strategy stays under it, genuinely at-risk situations clear it.
    const myTeamDesperate = myTeamNeeds > 0 && pointsRemainingInPlay > 0 && myTeamNeeds >= pointsRemainingInPlay * 0.7;
    // "Already secured": this side's own goal is already mathematically
    // locked in regardless of what happens in the remaining tricks.
    // Deliberately gated on !quoteState -- Quote/COT is a completely
    // separate bet, either side can declare it, and its win condition is
    // a full 28-point sweep of every trick, not the original bid number.
    // A bot that eased off the instant its base bid was merely satisfied
    // would actively sabotage that separate, still-live commitment --
    // this must stay fully engaged for every remaining point whenever
    // Quote is in play, no matter how "safe" the base bid already looks.
    const myTeamSecured = myTeamNeeds <= 0 && !this.quoteState;
    if (this.trickSuit === '') {
      const isEarly = this.tricksPlayed < 4;
      const bySuit = {};
      for (const s of SUITS) bySuit[s] = [];
      for (const c of hand) bySuit[c.suit].push(c);
      // Absolute rule, not a scored preference: if this bot holds a Jack
      // it's legitimately allowed to lead, it leads it - full stop,
      // before any other leading logic (including the bidder's own
      // trump-concealment strategy below) even runs. The Jack is
      // unbeatable in its own suit barring trump, and this should never
      // lose out to some other candidate happening to score higher, or
      // get skipped because some other special case returned first.
      for (const s of SUITS) {
        if (bySuit[s].length === 0) continue;
        const holdsJackHere = bySuit[s].some(c => c.rank === 'J');
        if (holdsJackHere && (s !== this.trumpSuit || this.trumpExposed)) {
          return bySuit[s].find(c => c.rank === 'J');
        }
      }
      if (!this.trumpExposed && isBidder) {
        const nt = hand.filter(c => c.suit !== this.trumpSuit);
        if (nt.length > 0) {
          const ntBySuit = {};
          for (const s of SUITS) ntBySuit[s] = [];
          for (const c of nt) ntBySuit[c.suit].push(c);
          let bestSuit = '', bestLen = -1;
          for (const s of SUITS) { if (ntBySuit[s].length > bestLen) { bestLen = ntBySuit[s].length; bestSuit = s; } }
          if (bestSuit && ntBySuit[bestSuit].length > 0) {
            ntBySuit[bestSuit].sort((a, c) => RANK_ORDER[a.rank] - RANK_ORDER[c.rank]);
            return isEarly ? ntBySuit[bestSuit][0] : ntBySuit[bestSuit][ntBySuit[bestSuit].length - 1];
          }
        }
      }
      const candidates = [];
      for (const s of SUITS) {
        if (bySuit[s].length === 0) continue;
        bySuit[s].sort((a, c) => RANK_ORDER[a.rank] - RANK_ORDER[c.rank]);
        const low = bySuit[s][0], high = bySuit[s][bySuit[s].length - 1];
        const jSeen = this._isRankSeen(s, 'J');
        const nineSeen = this._isRankSeen(s, '9');
        const iHold9 = bySuit[s].some(c => c.rank === '9');
        // A known opponent (not partner — partner being void isn't a
        // threat to us) already out of this suit can trump straight over
        // whatever we lead here. Provable and serious once trump is
        // exposed (they can cut in freely); still a real, if smaller,
        // risk even before exposure (they may call trump specifically to
        // do it). Applies even to leading the Jack — nothing beats a
        // Jack in its own suit, but a trump still can.
        let voidOpponentPenalty = 0;
        for (let p = 0; p < 4; p++) {
          if (p === pos || getTeam(p) === myTeam) continue;
          if (this.voidSuits[p].has(s)) { voidOpponentPenalty = this.trumpExposed ? 20 : 10; break; }
        }
        // A higher learned risk tolerance makes this specific penalty
        // sting a little less (more willing to lead into it anyway); a
        // more risk-averse bot weighs it a little more heavily. Bounded
        // to a mild +/-20% either side of the base penalty on purpose —
        // this is flavor on top of the tuned heuristic, not a new rule.
        voidOpponentPenalty = Math.round(voidOpponentPenalty * (1.2 - b.playWeights.riskTaking * 0.4));
        // The flip side of the same idea: a PARTNER known to be void in
        // this suit can trump straight in and win it for the team once
        // trump is exposed — leading into that is a genuine team tactic
        // ("what can my partner cut"), not just a read on this bot's own
        // hand. Only counts once trump is actually exposed; before that
        // a partner "void" here hasn't been proven safe to exploit yet.
        let partnerVoidBonus = 0;
        for (let p = 0; p < 4; p++) {
          if (p === pos || getTeam(p) !== myTeam) continue;
          if (this.voidSuits[p].has(s) && this.trumpExposed) { partnerVoidBonus = 18; break; }
        }
        let sc = -voidOpponentPenalty + partnerVoidBonus;
        if (isEarly) {
          if (low.rank === 'J' || low.rank === '9') {
            if (bySuit[s].length > 1) {
              // Given RANK_ORDER, the ONLY way low.rank can be '9' with
              // more than one card in the suit is holding J+9 together
              // (nothing ranks between them) -- the strongest possible
              // holding in a suit, since the Jack is unbeatable in its
              // own suit and the 9 becomes safe the moment the Jack is
              // seen. This was previously scored as barely more than a
              // generic length bonus (~length*5, same as any random
              // 2-card suit with nothing special in it) -- badly
              // undervaluing a genuine J+9 lock and letting a short,
              // merely-safe suit with zero real strength outscore it.
              // Matches the same +60 baseline the non-early branch
              // already gives a bare Jack below -- holding the 9
              // alongside it is worth at least as much, not less.
              candidates.push({ card: bySuit[s][1], score: 60 + bySuit[s].length * 5 - voidOpponentPenalty + partnerVoidBonus, suit: s }); continue;
            }
            // A LONE 9 (or J) with nothing else in that suit — there's no
            // second card to lead instead, so this exact card is the only
            // option if this suit gets picked at all. A lone Jack is
            // still fine (nothing beats it barring trump), but a lone 9
            // is exactly the "leading a point card into a suit where the
            // opponent may still hold the Jack" mistake if that Jack
            // hasn't been seen yet — this was previously falling through
            // with zero penalty just because there was no second card to
            // swap in instead.
            if (low.rank === '9' && !jSeen) sc -= 40;
          }
          sc += bySuit[s].length * 5;
          if (low.points === 0) sc += 20;
          if (low.rank === '7' || low.rank === '8') sc += 15;
          if (high.points > 0) sc -= 10;
          if (s === this.trumpSuit) sc -= 30;
          // The lowest-ranked card this bot holds in this suit can still
          // itself be a point card (J,9,A,10) if it holds NOTHING below
          // point-card rank in this suit at all -- e.g. holding only
          // "10, A" with no K/Q/8/7 to lead instead. That case was
          // falling through with none of the jSeen/nineSeen safety
          // checks the rest of this scoring already applies elsewhere.
          // J itself is always safe to lead (nothing beats it, so it
          // never reaches this check at all -- see the lone-J/9 case
          // above). A 9 is only genuinely at risk from an unseen Jack;
          // an Ace or 10 is at risk from BOTH an unseen Jack and an
          // unseen 9, since either one still beats it. Scaled by BOTH
          // how many ranks above this card are still unseen (more
          // threats still out there = more likely to actually get
          // captured) AND this card's own point value (losing a 2-point
          // 9 stings more than losing a 1-point Ace or 10) -- not a flat
          // penalty either way, since neither dimension alone is the
          // whole story: this is exactly what makes "if I have to risk
          // a point card at all, prefer the lowest-value one" emerge
          // naturally from the scoring instead of needing a separate
          // override bolted on afterward.
          if (low.points > 0) {
            let unseenThreats = 0;
            if (low.rank === '9' && !jSeen) unseenThreats = 1;
            else if (low.rank === 'A' || low.rank === '10') {
              if (!jSeen) unseenThreats++;
              if (!nineSeen) unseenThreats++;
            }
            if (unseenThreats > 0) sc -= unseenThreats * low.points * 20;
          }
          candidates.push({ card: low, score: sc, suit: s });
        } else {
          const trumpIneligibleHere = s === this.trumpSuit && !this.trumpExposed;
          if (trumpIneligibleHere && high.rank === 'J') {
            // The generic "lead your best card in a suit" scoring below
            // would otherwise offer the Jack anyway just because it's
            // this suit's highest card - even though this bot isn't
            // actually eligible to know this suit is trump. Fall back to
            // a lower card from the same suit if one exists; otherwise
            // this suit isn't a safe option to lead from at all here.
            if (bySuit[s].length > 1) {
              candidates.push({ card: bySuit[s][bySuit[s].length - 2], score: sc + bySuit[s].length * 2, suit: s });
            }
            continue;
          }
          // Holding the 9 without the Jack is only a safe, strong lead
          // once that suit's Jack has genuinely been accounted for —
          // otherwise it's exactly the "leading a point card into a suit
          // where the opponent may still hold the Jack" mistake, and
          // often just gives points away for nothing. If a safer, lower
          // card in this SAME suit exists (e.g. holding 9+7 of trump —
          // the 9 unsafe, the 7 completely safe), lead that instead of
          // the 9 outright: the -40 penalty below only ever affected
          // whether this suit got chosen over other suits, never which
          // actual card got played once it was — meaning a bot with
          // only that one risky suit left to lead from was always stuck
          // committing to the 9 anyway, even holding a strictly safer
          // card in the exact same suit the whole time.
          if (iHold9) {
            if (jSeen) {
              candidates.push({ card: bySuit[s].find(c => c.rank === '9'), score: 45 + bySuit[s].length * 3 - voidOpponentPenalty, suit: s });
              continue;
            }
            sc -= 40; // real risk, not a lead to favor -- 1 threat (unseen J) * 2 points * 20, matching the isEarly branch's formula
            const saferInSuit = bySuit[s].find(c => c.rank !== '9' && c.points === 0);
            if (saferInSuit) {
              candidates.push({ card: saferInSuit, score: sc + bySuit[s].length * 3, suit: s });
              continue;
            }
          }
          sc += bySuit[s].reduce((a, c) => a + c.points, 0) * 10 + bySuit[s].length * 3;
          // Aces and 10s carry real points but are still beaten by an
          // unseen Jack or 9 of the same suit — only lead them with
          // confidence once both are already accounted for. Same
          // threats*points*20 formula as the isEarly branch above, so a
          // 9 and an Ace/10 facing the same number of unseen threats are
          // penalized consistently by their actual point value either way.
          // Same "prefer a safer card in the same suit if one exists"
          // fallback as the 9 case above, for the identical reason.
          if (high.rank === 'A' || high.rank === '10') {
            let unseenThreats = 0;
            if (!jSeen) unseenThreats++;
            if (!nineSeen) unseenThreats++;
            if (unseenThreats > 0) {
              sc -= unseenThreats * high.points * 20;
              const saferInSuit = bySuit[s].find(c => c !== high && c.points === 0);
              if (saferInSuit) {
                if (s === this.trumpSuit) sc -= 10;
                candidates.push({ card: saferInSuit, score: sc, suit: s });
                continue;
              }
            }
          }
          if (s === this.trumpSuit) sc -= 10;
          candidates.push({ card: high, score: sc, suit: s });
        }
      }
      candidates.sort((a, c) => c.score - a.score);
      if (candidates.length > 0) return candidates[0].card;
      hand.sort((a, c) => RANK_ORDER[a.rank] - RANK_ORDER[c.rank]);
      return isEarly ? hand[0] : hand[hand.length - 1];
    }

    const follow = hand.filter(c => c.suit === this.trickSuit);
    if (follow.length > 0) {
      follow.sort((a, c) => RANK_ORDER[c.rank] - RANK_ORDER[a.rank]);
      let canWin = false;
      if (!cwc) canWin = true;
      else if (cwc.suit === this.trickSuit) canWin = RANK_ORDER[follow[0].rank] > RANK_ORDER[cwc.rank];
      else if (this.trumpExposed && cwc.suit === this.trumpSuit) canWin = false;
      if (canWin) {
        const hasJ = follow.some(c => c.rank === 'J'), has9 = follow.some(c => c.rank === '9');
        if (hasJ) return follow.find(c => c.rank === 'J');
        if (has9) {
          // A 9 beats everything else in this suit — but not the Jack.
          // If the Jack hasn't shown up yet and someone still acts after
          // us this trick, spending the 9 here risks exactly the mistake
          // reported: winning the trick only for a later opponent's
          // unseen Jack to steal it right back, for nothing. Worth the
          // risk once it's genuinely the last word (isLast), the Jack's
          // already accounted for, or the trick carries enough points to
          // justify it regardless — same threshold already used for this
          // same tradeoff elsewhere in this file (trump cut-in).
          const jackRisk = !isLast && !this._isRankSeen(this.trickSuit, 'J');
          if (jackRisk && tPts < 3) return follow[follow.length - 1];
          return follow.find(c => c.rank === '9');
        }
        let winner = follow[0];
        if (cwc && cwc.suit === this.trickSuit) {
          for (let i = follow.length - 1; i >= 0; i--) {
            if (RANK_ORDER[follow[i].rank] > RANK_ORDER[cwc.rank]) { winner = follow[i]; break; }
          }
        }
        if (wt === myTeam && tPts < 2 && !isLast && !hasJ && !has9) return follow[follow.length - 1];
        return winner;
      }
      // Can't beat what's on the table. If partner is the one currently
      // winning, our card is going to their pile either way — feeding a
      // point card (Ace/10) instead of the bare lowest hands over the
      // same points to our own team rather than wasting the opportunity,
      // as long as it isn't a Jack/9 we'd rather keep for later.
      // BUT: that's only genuinely free value if the trick is actually
      // secure. If someone still acts after us this trick AND this
      // suit's Jack hasn't been seen yet, a later opponent could still
      // steal the trick out from under our partner with it -- in which
      // case our fed point card just handed the opponent extra points
      // instead of our own team. Same jackRisk concept already used for
      // the 9-lead case above, and the same tPts>=3 override: worth
      // feeding anyway once enough points are already on the table to
      // justify the risk regardless.
      // Also skipped entirely once myTeamSecured -- our own side's goal
      // this round is already mathematically locked in (and Quote/COT
      // isn't in play, or this would stay fully engaged regardless per
      // myTeamSecured's own definition), so there's no actual benefit
      // left to optimizing exactly which card feeds our partner the most
      // -- any legal card is equally fine at that point.
      if (wt === myTeam && !myTeamSecured) {
        const jackRisk = !isLast && !this._isRankSeen(this.trickSuit, 'J');
        if (!jackRisk || tPts >= 3) {
          const feedable = follow.filter(c => c.points > 0 && c.rank !== 'J' && c.rank !== '9');
          if (feedable.length > 0) {
            feedable.sort((a, c) => c.points - a.points);
            return feedable[0];
          }
        }
      }
      return follow[follow.length - 1];
    }

    const trumps = hand.filter(c => c.suit === this.trumpSuit);
    // Having personally asked for trump to be opened, this bot owes a
    // trump card this trick if it's holding one at all — a flat Kerala
    // rule, not a strategic choice weighed against trick value or who's
    // currently winning. This was a real gap: the strategic cut/discard
    // decision below (worthTrumping, trumpWinning, wt !== myTeam) had no
    // awareness of this obligation at all, so a bot that had just asked
    // to see trump could still walk right past it and discard instead
    // whenever the trick wasn't judged worth spending trump on — exactly
    // the "bot asked to see trump but didn't play it" bug reported. The
    // rule only requires playing A trump card, not necessarily the
    // strongest one, so the cheapest zero-point trump (falling back to
    // the weakest non-Jack, then the weakest overall) satisfies it while
    // still not wasting more than necessary.
    if (this.mustPlayTrumpBy === pos && trumps.length > 0) {
      trumps.sort((a, c) => RANK_ORDER[c.rank] - RANK_ORDER[a.rank]);
      const nonJackTrumps = trumps.filter(c => c.rank !== 'J');
      const zeroPt = nonJackTrumps.filter(c => c.points === 0);
      return zeroPt.length > 0 ? zeroPt[zeroPt.length - 1]
        : nonJackTrumps.length > 0 ? nonJackTrumps[nonJackTrumps.length - 1]
        : trumps[trumps.length - 1];
    }
    if (this.trumpExposed && trumps.length > 0) {
      trumps.sort((a, c) => RANK_ORDER[c.rank] - RANK_ORDER[a.rank]);
      let trumpWinning;
      if (!cwc) trumpWinning = true;
      else if (cwc.suit !== this.trumpSuit) trumpWinning = true;
      else trumpWinning = RANK_ORDER[trumps[0].rank] > RANK_ORDER[cwc.rank];
      // Trump is limited and valuable — using one to win a trick worth
      // almost nothing is a poor trade, unless it's the last trick of the
      // round (every point matters for the exact count right at the end)
      // or this bot is the bidder protecting their own contract, who can
      // reasonably justify spending more to keep tricks away from the
      // defense even when the immediate point value is small.
      const suitRepeat = this.suitLeadCount[this.trickSuit] || 0;
      // At the default, never-yet-learned weight (1.0) this is exactly
      // "tPts >= 2", unchanged. A bot whose trump calls have actually
      // gone well learns to be a little pickier (higher bar); one whose
      // calls have gone poorly stays looser, same as before it learned
      // anything at all.
      // When genuinely desperate for points (see myTeamDesperate above),
      // that bar drops to 1 -- even a single point is worth spending
      // trump on when this side needs nearly everything that's left to
      // still have a shot. Still gated on tPts (a genuinely zero-point
      // trick gets no benefit from this at all -- there's nothing there
      // to capture regardless of how desperate this side is).
      const trumpPtsThreshold = myTeamDesperate ? 1 : Math.round(2 * b.playWeights.trumpManagement);
      // A suit being led for the very first time this round (suitRepeat
      // === 1, counting this exact lead) is now its own trigger to cut,
      // independent of the trick's point value — added per specific
      // request, layered alongside the existing triggers rather than
      // replacing them. trumpWinning and wt !== myTeam above still both
      // apply regardless of why we're cutting: never spend trump that
      // wouldn't actually win the trick, and never cut over our own
      // partner who's already winning it for free.
      const firstTimeSuitLed = suitRepeat === 1;
      const worthTrumping = tPts >= trumpPtsThreshold || isLast || (isBidder && tPts >= 1) || (suitRepeat >= 2 && tPts >= 1) || firstTimeSuitLed;
      if (trumpWinning && wt !== myTeam && worthTrumping) {
        let wtr;
        if (cwc && cwc.suit === this.trumpSuit) {
          // Over-cutting another trump that's currently winning. Same
          // "prefer a zero-point trump, not just the rank-cheapest one"
          // philosophy as the first-cut branch below -- this used to only
          // search for the rank-minimal card that beats cwc, with no
          // regard for point value at all. That happened to work out most
          // of the time since Q/K generally rank below the point cards,
          // but not always: if cwc.rank is high enough, the rank-minimal
          // winner can skip straight past every zero-point option and
          // land on a point card, or the Jack, when a cheaper win was
          // sitting right there just because it wasn't the very next
          // rank up.
          const zeroPtBeats = trumps.filter(c => c.points === 0 && RANK_ORDER[c.rank] > RANK_ORDER[cwc.rank]);
          if (zeroPtBeats.length > 0) {
            wtr = zeroPtBeats.sort((a, c) => RANK_ORDER[a.rank] - RANK_ORDER[c.rank])[0];
          } else {
            wtr = trumps[0];
            for (let i = trumps.length - 1; i >= 0; i--) {
              if (RANK_ORDER[trumps[i].rank] > RANK_ORDER[cwc.rank]) { wtr = trumps[i]; break; }
            }
          }
          // The minimal sufficient trump only stays safe if no one still
          // to act in this trick can hold a bigger one — in practice,
          // whether the trump Jack is still unaccounted for. Spending our
          // ONLY realistic winner (a bare 9, say) into a trick a live
          // Jack can still take away is exactly the kind of waste this
          // was meant to avoid — better to commit the strongest trump we
          // have when that risk is real and there's still real value on
          // the table for it.
          if (!isLast && !this._isRankSeen(this.trumpSuit, 'J') && wtr.rank !== 'J' && tPts >= 3) {
            wtr = trumps[0];
          }
        } else {
          // The FIRST cut in this trick — nothing on the table is trump
          // yet, so literally any trump we hold wins it. Reflexively
          // reaching for our best trump (often the Jack — the single most
          // valuable card in the game) to win a trick a King or 7 would
          // have won exactly as well is a real, common waste. Use the
          // cheapest trump we have, preferring a zero-point one so we're
          // not even giving up bonus points to do it.
          const nonJackTrumps = trumps.filter(c => c.rank !== 'J');
          const zeroPt = nonJackTrumps.filter(c => c.points === 0);
          wtr = zeroPt.length > 0 ? zeroPt[zeroPt.length - 1]
            : nonJackTrumps.length > 0 ? nonJackTrumps[nonJackTrumps.length - 1]
            : trumps[trumps.length - 1];
          // Going cheap here is only safe once there's no real chance of
          // getting over-cut right back by someone still left to act
          // this same trick. That risk isn't fixed -- it's read directly
          // off how many times the LED suit (the one actually being cut,
          // not the trump suit) has already been led this round:
          // suitRepeat===0 means this is its first time out, so the odds
          // another player is also already void in it (and holding a
          // trump ready to cut) are genuinely low -- go cheap regardless
          // of who's left to act. Once that suit has been led multiple
          // times, though, players who followed it earlier have shown
          // they hold it, narrowing down who's actually still void — and
          // the more it's been led, the likelier it becomes that someone
          // still to act this trick is void too and holding their own
          // cut. On the actual last turn this never applies at all --
          // nobody's left to over-cut regardless of any of this.
          if (!isLast && suitRepeat >= 2 && tPts >= 2 && wtr.rank !== 'J') {
            const jSeenTrump = this._isRankSeen(this.trumpSuit, 'J');
            if (jSeenTrump) {
              // The Jack's already accounted for, so nothing left can
              // beat a 9 -- a genuinely safe upgrade, not a big spend.
              const nine = trumps.find(c => c.rank === '9');
              if (nine) wtr = nine;
            } else {
              // The Jack itself is still unaccounted for and could still
              // be sitting with whoever's left to act -- worth committing
              // our strongest trump to make sure this cut actually holds.
              wtr = trumps[0];
            }
          }
        }
        return wtr;
      }
      // Not spending trump to win this one — most commonly because our
      // OWN partner is already winning it (wt === myTeam), where cutting
      // in over our own teammate would just waste a trump for nothing, or
      // because the trick isn't worth the trump at all. Either way, a
      // trump card is not automatically the right thing to throw away
      // just because we happen to be void in the led suit — a non-trump
      // discard (ideally a point card, per the same "feed partner points
      // rather than waste the chance" logic used when following suit
      // above) preserves trump for when it actually matters later.
      const nonTrumpDiscard = hand.filter(c => c.suit !== this.trumpSuit);
      if (nonTrumpDiscard.length > 0) {
        const feedablePts = nonTrumpDiscard.filter(c => c.points > 0 && c.rank !== 'J' && c.rank !== '9');
        // Same myTeamSecured skip as the equivalent feed-partner blocks
        // elsewhere in this function.
        if (wt === myTeam && !myTeamSecured && feedablePts.length > 0) {
          feedablePts.sort((a, c) => c.points - a.points);
          return feedablePts[0];
        }
        // A Jack can never be played as a plain discard (see canPlayCard) -
        // exclude it from consideration here the same way, so the bot
        // doesn't pick one and then have it rejected as illegal.
        const nonJackDiscard = nonTrumpDiscard.filter(c => c.rank !== 'J');
        if (nonJackDiscard.length > 0) {
          nonJackDiscard.sort((a, c) => a.points !== c.points ? a.points - c.points : RANK_ORDER[a.rank] - RANK_ORDER[c.rank]);
          return nonJackDiscard[0];
        }
        // Every remaining non-trump card is a Jack. If trump is still
        // available, cutting with it is the legal alternative (canPlayCard
        // would reject a Jack discard here) - only fall through to
        // actually playing the Jack when there's genuinely no trump left
        // either, matching canPlayCard's own last-resort exception.
        if (trumps.length > 0) return trumps[trumps.length - 1];
        nonTrumpDiscard.sort((a, c) => a.points !== c.points ? a.points - c.points : RANK_ORDER[a.rank] - RANK_ORDER[c.rank]);
        return nonTrumpDiscard[0];
      }
      return trumps[trumps.length - 1]; // genuinely nothing else left to throw
    }

    if (!this.trumpExposed && trumps.length > 0 && this.trickSuit !== this.trumpSuit) {
      // Same reasoning as the other "first cut" spots above: trump isn't
      // exposed yet, so literally any trump card wins this trick outright
      // - reflexively reaching for the highest one (often the Jack) to
      // win with a King or 7 just as easily is the same unnecessary
      // waste, not a special case just because exposing trump is also
      // happening here.
      const cutForWin = pos !== this.hiddenTrumpOwner &&
        ((isLast && wt !== myTeam && tPts >= 2) || (isBidder && wt !== myTeam && tPts >= 3));
      if (cutForWin) {
        trumps.sort((a, c) => RANK_ORDER[c.rank] - RANK_ORDER[a.rank]);
        const nonJackTrumps = trumps.filter(c => c.rank !== 'J');
        const zeroPt = nonJackTrumps.filter(c => c.points === 0);
        return zeroPt.length > 0 ? zeroPt[zeroPt.length - 1]
          : nonJackTrumps.length > 0 ? nonJackTrumps[nonJackTrumps.length - 1]
          : trumps[trumps.length - 1];
      }
    }

    // Final fallback: void in the led suit AND holding no trump at all
    // (a very common situation, not a rare edge case) -- everything
    // above this point specifically required trumps.length>0 to even
    // run, so this was the one discard path with no awareness at all of
    // whether our own partner is already winning the trick. Same "feed
    // points to a winning partner rather than waste the chance" logic
    // used everywhere else in this function above, applied here too --
    // team points are what wins the game, so a partner who's already
    // won this trick should get every safe point we can hand them
    // rather than have us just dump our cheapest card on reflex.
    let disc = hand.filter(c => c.suit !== this.trumpSuit);
    if (!disc.length) disc = hand;
    // Same myTeamSecured skip as the equivalent block above -- once our
    // own goal is already locked in (and Quote/COT isn't live), there's
    // nothing left to optimize here either.
    if (wt === myTeam && !myTeamSecured) {
      const feedablePts = disc.filter(c => c.points > 0 && c.rank !== 'J' && c.rank !== '9');
      if (feedablePts.length > 0) {
        feedablePts.sort((a, c) => c.points - a.points);
        return feedablePts[0];
      }
    }
    disc.sort((a, c) => a.points !== c.points ? a.points - c.points : RANK_ORDER[a.rank] - RANK_ORDER[c.rank]);
    return disc[0];
  }

  // ---------------- Serialization ----------------
  // Every connected player gets their OWN hand in full and everyone else's
  // hand as a count only — the server is the only place that ever holds
  // the full deal.

  stateFor(viewerPos) {
    return {
      tableId: this.tableId,
      round: this.round,
      tableTheme: this.tableTheme,
      phase: this.phase,
      dealer: this.dealer,
      tricksPlayed: this.tricksPlayed,
      currentPlayer: this.currentPlayer,
      bidder: this.bidder,
      highestBid: this.highestBid,
      passes: this.passes,
      bidHistory: this.bidHistory,
      p2History: this.p2History,
      p2LastRaiser: this.p2LastRaiser,
      p2MinRaise: this.phase === 'bidding2' ? Math.max(20, this.highestBid + 1) : null,
      p1MinBid: this.phase === 'bidding1' ? (this._isBidRestrictedToHonors(this.currentPlayer) ? Math.max(20, this.highestBid + 1) : (this.highestBid > 0 ? this.highestBid + 1 : 14)) : null,
      p1CurrentTurnRestricted: this.phase === 'bidding1' ? this._isBidRestrictedToHonors(this.currentPlayer) : false,
      learningPulseCount: this.learningPulseCount,
      lastLearningBotName: this.lastLearningBotName,
      trumpSuit: this.trumpSuit, // the chosen SUIT is known to everyone once picked — only the specific hidden CARD stays secret until exposure
      trumpExposed: this.trumpExposed,
      roundVoidMessage: this.roundVoidMessage,
      reshuffleReason: this.reshuffleReason || null,
      mustPlayTrump: this.mustPlayTrumpBy === viewerPos, // viewer just asked for the reveal and owes a trump card this trick if holding one
      hasHiddenTrump: !!this.hiddenTrump,
      revealedTrumpCard: this.revealedTrumpCard,
      myHiddenTrumpCard: (this.hiddenTrump && viewerPos === this.hiddenTrumpOwner) ? this.hiddenTrump : null,
      trickCards: this.trickCards,
      trickSuit: this.trickSuit,
      teamPoints: this.teamPoints,
      gameScore: this.gameScore,
      qMarks: this.qMarks,
      qTotalEver: this.qTotalEver,
      partnerSignals: this.partnerSignals,
      championshipNumber: this.championshipNumber,
      kingStreak: this.kingStreak,
      lastChampionshipResult: this.lastChampionshipResult,
      lastTrick: this.lastTrick,
      roundWinnerAnnounced: this.roundWinnerAnnounced,
      pendingEarlyWinChoice: this.pendingEarlyWinChoice,
      // Computed fresh every time (never a stored flag) -- true iff
      // it's genuinely valid for whoever's turn it currently is to
      // declare Quote right now. The client combines this with its own
      // currentPlayer===MY_POS check to decide whether ITS OWN quote
      // button should be enabled -- the button itself stays visible to
      // everyone at the table regardless, per how this was designed.
      quoteEligible: this._isQuoteEligibleFor(this.currentPlayer),
      teamStillClean: this.teamStillClean,
      quoteState: this.quoteState,
      thaniCaller: this.thaniCaller,
      foldedSeats: this.foldedSeats,
      seats: this.seats.map((s, i) => s ? {
        name: s.name, isBot: s.isBot, connected: s.connected,
        cardCount: s.hand.length,
        hand: i === viewerPos ? s.hand : undefined,
        avatar: s.avatar || null
      } : null)
    };
  }
}

module.exports = { GameEngine, SUITS, RANKS, POINTS, RANK_ORDER, getTeam, freshDeck, evaluatePhase1Hand, evaluatePhase2Hand, bestPhase2Evaluation };
