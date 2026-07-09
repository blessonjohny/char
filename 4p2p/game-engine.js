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
//  - Teams are fixed by seat: seats 0 & 2 vs seats 1 & 3.
//  - Bidding: 4 cards dealt first. First bidder (dealer's left) must bid
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

  let bestSuit = null, bestSuitScore = -1, bestSuitCount = 0;
  for (const s of SUITS) {
    const cards = bySuit[s];
    if (cards.length === 0) continue;
    const hasJ = cards.some(c => c.rank === 'J');
    const has9 = cards.some(c => c.rank === '9');
    const hasA = cards.some(c => c.rank === 'A');
    const has10 = cards.some(c => c.rank === '10');
    // Raw rank strength of what's held in this suit...
    let score = cards.reduce((s2, c) => s2 + RANK_ORDER[c.rank], 0);
    // ...plus a CONTROL bonus that compounds the more of the suit's top
    // end you hold together — owning J+9+A+10 of one suit isn't just
    // "4 good cards", it's near-total command of that suit, which is
    // worth far more than the individual card values suggest.
    if (hasJ) score += 4;
    if (hasJ && has9) score += 6;
    if (hasJ && has9 && hasA) score += 8;
    if (hasJ && has9 && hasA && has10) score += 10;
    if (score > bestSuitScore) { bestSuitScore = score; bestSuit = s; bestSuitCount = cards.length; }
  }
  if (bestSuit === null) bestSuitScore = 0;

  const jacks = hand.filter(c => c.rank === 'J');
  const jackSuits = new Set(jacks.map(c => c.suit));
  // Jacks scattered one-per-suit contribute almost nothing to suit
  // control (each is an island), even though they're individually the
  // highest card of their own suit.
  const jacksScattered = jacks.length >= 2 && jackSuits.size === jacks.length;

  const highCardCount = hand.filter(c => ['J', '9', 'A', '10'].includes(c.rank)).length;

  // Offensive score: mostly driven by how dominant the single best suit
  // is, with a modest allowance for genuine uncertainty about the 4
  // still-unseen cards (more high cards already in hand -> more likely
  // the rest helps too, but this is capped since it's still a guess).
  let offensive = bestSuitScore * 3 + Math.min(6, highCardCount * 1.5);
  if (jacksScattered) offensive -= (jacks.length - 1) * 4; // scattered Jacks don't buy suit control

  // Defensive score: raw stopping power — every Jack is a guaranteed
  // trick-stopper regardless of suit, and low filler cards are safe
  // discards while waiting to spring them.
  const defensive = jacks.length * 10 + hand.filter(c => c.points === 0).length * 2;

  // Convert the offensive score into a "comfortable ceiling" bid, then a
  // full probability curve around it — smooth and continuous, not a
  // lookup table, so it genuinely reflects THESE cards.
  const ceiling = 14 + offensive / 8;
  const winProbAtBid = (bid) => {
    const margin = ceiling - bid; // positive = comfortably within range, negative = stretching past it
    let p = margin >= 0
      ? 0.97 - 0.25 * Math.exp(-margin / 3)   // approaches ~97% the more comfortable margin there is
      : 0.97 * Math.exp(margin / 3);          // decays smoothly the further past the ceiling
    return Math.max(0.02, Math.min(0.97, p));
  };
  const probByBid = {};
  for (let bid = 14; bid <= 28; bid++) probByBid[bid] = winProbAtBid(bid);

  return {
    offensive, defensive, bestSuit, bestSuitScore, bestSuitCount,
    jacksScattered, jackCount: jacks.length, highCardCount, ceiling, probByBid
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

class GameEngine {
  constructor(tableId) {
    this.tableId = tableId;
    // seats[i] = { name, isBot, connected, hand: [cards] } for i in 0..3
    this.seats = [null, null, null, null];
    this.round = 0;
    this.gameScore = [6, 6]; // match score, team 0 / team 1 (mirrors client default)
    this.championshipNumber = 1;
    this.kingStreak = [0, 0]; // consecutive championships won by each team
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
    this.trumpSuit = '';
    this.trumpExposed = false;
    this.roundVoidMessage = null;
    this.hiddenTrump = null; // {suit, rank, points}
    this.hiddenTrumpOwner = -1; // who physically hid it — NOT necessarily this.bidder, since a phase-2 raise can change the bidder while the original chooser still holds the hidden card
    this.mustPlayTrumpBy = -1; // seat that just ASKED for trump to be opened (callTrump) — Kerala rule: having asked, they must play a trump card this trick if they hold one
    this.trickCards = []; // [{pos, card}]
    this.trickSuit = '';
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

  seatHuman(pos, name, playerId) {
    this.seats[pos] = { name, isBot: false, connected: true, playerId, hand: [] };
  }

  seatBot(pos, name) {
    this.seats[pos] = { name, isBot: true, connected: true, playerId: null, hand: [] };
  }

  removeSeat(pos) {
    this.seats[pos] = null;
  }

  // A human taking over a bot's seat mid-game — inherits the bot's exact
  // current hand and state rather than starting fresh, since the round
  // may already be well underway. Fails if that seat isn't currently a bot.
  replaceBot(pos, playerId, name) {
    const seat = this.seats[pos];
    if (!seat || !seat.isBot) return false;
    seat.isBot = false;
    seat.connected = true;
    seat.playerId = playerId;
    seat.name = name;
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
  takeOverSeat(pos, playerId, name) {
    const seat = this.seats[pos];
    if (!seat) return false;
    if (!seat.isBot && seat.connected) return false; // seat is a real, present human — not up for grabs
    seat.isBot = false;
    seat.connected = true;
    seat.playerId = playerId;
    seat.name = name;
    return true;
  }

  markConnected(pos, connected) {
    if (this.seats[pos]) this.seats[pos].connected = connected;
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
    this.resetRoundState();
    this.dealer = nextPos(this.dealer);
    this.currentPlayer = nextPos(this.dealer);
    this.deck = freshDeck();
    for (let i = 0; i < 4; i++) {
      if (this.seats[i]) this.seats[i].hand = [];
    }
    this.dealCards(4);
    this.phase = 'bidding1';
    this.addLog(`Round ${this.round} started. Dealer seat ${this.dealer}.`);
    this._notify();
    this.maybeAutoAct();
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
    this.addLog(`Round ${this.round} restarted by the host — fresh shuffle.`);
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

  placeBid(pos, bid) {
    if (this.phase !== 'bidding1') return { ok: false, reason: 'not_bidding' };
    if (pos !== this.currentPlayer) return { ok: false, reason: 'not_your_turn' };
    const first = this.isFirstBidder(pos);
    if (bid === 0) {
      if (first) bid = 14; // first bidder cannot pass
      else {
        this.passes++;
        this.bidHistory.push({ pos, bid: 0 });
        this.addLog(`Seat ${pos} passed.`);
        return this._afterBidAction();
      }
    }
    const minBid = this.highestBid > 0 ? this.highestBid + 1 : 14;
    if (bid < minBid || bid > 28) return { ok: false, reason: 'invalid_bid_amount' };
    this.highestBid = bid;
    this.bidder = pos;
    this.passes = 0;
    this.bidHistory.push({ pos, bid });
    // Snapshot the hand profile now, at bid-time — by round end this
    // hand will be empty, too late to learn anything from it.
    if (this.seats[pos]) this._bidderHandProfileForLearning = brain.getHandProfile(this.seats[pos].hand);
    this.addLog(`Seat ${pos} bid ${bid}.`);
    return this._afterBidAction();
  }

  _afterBidAction() {
    if ((this.passes >= 3 && this.highestBid > 0) || this.passes >= 4) {
      this.phase = 'choosingTrump';
      this.currentPlayer = this.bidder;
      this.addLog(`Bidding done. Seat ${this.bidder} won with ${this.highestBid}.`);
      this._notify();
      this.maybeAutoAct();
      return { ok: true };
    }
    this.currentPlayer = nextPos(this.currentPlayer);
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
  // starting from the dealer's left again, each player may either raise the
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

  passPhase2(pos) {
    if (this.phase !== 'bidding2') return { ok: false, reason: 'not_phase2' };
    if (pos !== this.currentPlayer) return { ok: false, reason: 'not_your_turn' };
    this.p2Passes++;
    this.p2TotalPasses++;
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
    // no way to ever contest trump at all — the round is void. Redeal
    // with the next dealer rather than playing out something that was
    // never really contestable. (The bidder's own hidden trump card
    // doesn't count here — this check is specifically about the
    // DEFENDING side having zero trump between them.)
    const bidTeam = getTeam(this.bidder);
    const defendingHasTrump = this.seats.some((s, i) => s && getTeam(i) !== bidTeam && s.hand.some(c => c.suit === this.trumpSuit));
    if (!defendingHasTrump) {
      this.roundVoidMessage = `The defending team has no ${this.trumpSuit} at all this round — nothing to contest. Round voided, moving to the next dealer.`;
      this.addLog(this.roundVoidMessage);
      // Broadcast the void message FIRST — startRound() immediately
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
      this.startRound();
      return;
    }

    this.phase = 'play';
    this.trumpExposed = false;
    this.trickCards = [];
    this.trickSuit = '';
    // Play is always led by the dealer's left — the same seat phase-1
    // bidding started with — regardless of who ended up winning the bid.
    this.currentPlayer = nextPos(this.dealer);
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
    if (this.trickSuit === '') this.trickSuit = played.suit;

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

    if (this.trickCards.length === 4) {
      this._resolveTrick();
    } else {
      this.currentPlayer = nextPos(this.currentPlayer);
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
    this.hiddenTrump = null;
    this.hiddenTrumpOwner = -1;
    if (this.mustPlayTrumpBy === pos) this.mustPlayTrumpBy = -1;
    if (!this.trumpExposed) this.exposeTrump();
    if (this.trickSuit === '') this.trickSuit = card.suit;
    this.trickCards.push({ pos, card });
    this.addLog(`Seat ${pos} played the hidden trump ${card.rank}${card.suit}!`);
    if (this.trickCards.length === 4) {
      this._resolveTrick();
    } else {
      this.currentPlayer = nextPos(this.currentPlayer);
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
      this.seats[this.hiddenTrumpOwner].hand.push(this.hiddenTrump);
      this.hiddenTrump = null;
      this.hiddenTrumpOwner = -1;
    }
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

    const cardsLeft = this.seats.reduce((s, seat) => s + (seat ? seat.hand.length : 0), 0);
    if (cardsLeft === 0 && this.hiddenTrump) {
      // Everyone else is out of cards but the hidden card's owner never
      // got to expose it — it becomes their forced final play. This is
      // whoever actually hid it, not necessarily the current bidder.
      this.currentPlayer = this.hiddenTrumpOwner;
      this._notify();
      this.maybeAutoAct();
    } else if (cardsLeft === 0) {
      this._endRound();
    } else {
      this.currentPlayer = winner.pos;
      this._notify();
      this.maybeAutoAct();
    }
  }

  _endRound() {
    const bT = getTeam(this.bidder);
    const oT = 1 - bT;
    const made = this.teamPoints[bT] >= this.highestBid;
    let pts;
    if (this.highestBid >= 28) pts = made ? 3 : 4;
    else if (this.highestBid >= 18) pts = made ? 2 : 3;
    else pts = made ? 1 : 2;
    if (made) { this.gameScore[bT] += pts; this.gameScore[oT] -= pts; }
    else { this.gameScore[oT] += pts; this.gameScore[bT] -= pts; }
    this.roundWinnerAnnounced = {
      bidderWon: made, made, bidder: this.bidder, highestBid: this.highestBid,
      teamPoints: this.teamPoints.slice(), pts, bidTeam: bT
    };
    this.phase = 'roundEnd';
    this.addLog(`Round ${this.round} over. ${made ? 'Bid made' : 'Bid failed'} (+/-${pts}).`);

    // Feed every bot's brain the outcome — this is what makes them
    // actually improve over time instead of repeating the same static
    // heuristic forever. The bidder learns specifically from whether
    // their bid succeeded; every bot (bidding team or not) logs a round
    // outcome based on whether their own team came out ahead.
    for (let i = 0; i < 4; i++) {
      const seatI = this.seats[i];
      if (!seatI || !seatI.isBot) continue;
      const wonRound = (getTeam(i) === bT) === made;
      if (i === this.bidder && this._bidderHandProfileForLearning) {
        brain.recordBidOutcome(seatI.name, this._bidderHandProfileForLearning, this.highestBid, made, wonRound);
        this.learningPulseCount++;
        this.lastLearningBotName = seatI.name;
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
      // Start the next championship: reset the match score, keep everyone
      // seated exactly as they are, and keep counting. If someone just
      // became King, the streak naturally starts back at 0 next time
      // (matches the reference: winning again after being crowned just
      // starts building a fresh streak, it doesn't lock the table).
      this.gameScore = [6, 6];
      this.championshipNumber++;
    }

    this._notify();
  }

  // ---------------- Bots ----------------
  // Deliberately simple — legal-move heuristics, not the client's learning
  // brain system. Good enough to keep an empty seat playing sensibly while
  // authority lives here; the client can still layer its own smarter bot
  // presentation/flavor on top if desired.

  maybeAutoAct() {
    const seat = this.seats[this.currentPlayer];
    if (!seat) return; // truly empty seat — caller must fill or skip
    if (seat.isBot || !seat.connected) {
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
      // Bots always act at a comfortable, watchable pace. A disconnected
      // HUMAN gets a real grace period instead — brief network hiccups are
      // common and often invisible to the person experiencing them (their
      // client silently reconnects a second later). Treating that the same
      // as "gone for good" meant a hiccup at exactly the wrong moment could
      // make a one-time decision like choosing trump get made for them
      // before they even noticed anything happened.
      const delay = seat.isBot ? 900 : 10000;
      setTimeout(() => {
        // Re-check everything at fire-time, not just at schedule-time:
        // - the round hasn't moved on
        // - it's still actually this seat's turn
        // - this seat is STILL a bot or STILL disconnected — if a human
        //   reconnected during this delay, they should get to act
        //   themselves now, not have a card auto-played out from under
        //   them the moment they came back.
        if (this.round !== capturedRound) return;
        if (this.currentPlayer !== capturedPos) return;
        const seatNow = this.seats[capturedPos];
        if (!seatNow || (!seatNow.isBot && seatNow.connected)) return;
        this._botAct(capturedPos);
      }, delay);
    }
    // Connected human seats just wait for a client message; nothing to do here.
  }

  _botAct(pos) {
    if (this.phase === 'bidding1' && this.currentPlayer === pos) {
      const botName = this.seats[pos].name;
      const b = brain.getBrain(botName);
      const hand = this.seats[pos].hand;
      const first = this.isFirstBidder(pos);
      const minBid = this.highestBid > 0 ? this.highestBid + 1 : 14;

      // Suit-dominance based evaluation (see evaluatePhase1Hand above) —
      // replaces flat point-counting, which badly overrated hands like
      // four scattered Jacks (12 raw points, but zero suit control) over
      // a genuine same-suit J-9-A-10 lock (only 7 raw points, but total
      // command of one suit).
      const ev = evaluatePhase1Hand(hand);

      // How comfortable this particular bot is committing depends on its
      // brain's personality: a cautious/low-level bot wants a much safer
      // win probability before bidding than a confident, aggressive one.
      // Raised from 0.75 after real-game reports of bots committing to
      // bids their actual hand didn't support and losing badly — even a
      // confident, high-level bot should want real odds before bidding.
      const comfortThreshold = Math.max(0.45,
        0.85 - (b.level - 1) * 0.08 - (b.bidWeights.aggression - 1) * 0.1);

      // Walk the dynamically-computed probability curve and take the
      // highest bid level that still clears this bot's comfort bar.
      let target = 14;
      for (let bidLevel = 14; bidLevel <= 28; bidLevel++) {
        if (ev.probByBid[bidLevel] >= comfortThreshold) target = bidLevel;
        else break;
      }

      // A hand that reads as much better for DEFENSE than OFFENSE — the
      // classic "scattered Jacks, no suit control" case — should pull the
      // bot back from committing high even if the raw curve alone looked
      // OK, mirroring the real distinction between a good bidding hand
      // and a good defending hand.
      if (ev.defensive > ev.offensive * 1.3) {
        target = Math.max(14, target - 3);
      }

      // Partner already winning the bidding is worth leaning into a
      // little further, same spirit as before.
      let pb = 0;
      if (this.bidder >= 0 && getTeam(this.bidder) === getTeam(pos)) pb = 1 * b.bidWeights.partnerSupport;
      target = Math.min(28, Math.round(target + pb));

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
        target = Math.round((target + avgBid) / 2);
      }

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
    } else if (this.phase === 'choosingTrump' && pos === this.bidder) {
      // Faithful port of the reference's botChooseTrumpWithBrain.
      const b = brain.getBrain(this.seats[pos].name);
      const hand = this.seats[pos].hand;
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
          : 0.95 * Math.exp(margin / 3.5);
        probByBid[lvl] = Math.max(0.03, Math.min(0.97, p));
      }

      // A cautious/low-level bot wants a safer read before committing to
      // these high-stakes bids, where failing costs far more than a
      // Phase 1 miss — risk vs. reward, not just "bid as high as
      // possible". Taking the contract AWAY from the current bidder
      // (not already on their team) is a bigger commitment than merely
      // extending your own side's existing bid, so it needs a clearly
      // higher bar.
      const baseThreshold = Math.max(0.48, 0.86 - (b.level - 1) * 0.08 - (b.bidWeights.aggression - 1) * 0.1);
      const riskThreshold = isBT ? baseThreshold : baseThreshold + 0.15;

      const minRaise = Math.max(20, this.highestBid + 1);
      let raised = false;
      let tr = 0;
      for (const lvl of [20, 22, 24, 26, 28]) {
        if (lvl >= minRaise && probByBid[lvl] >= riskThreshold) tr = lvl;
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
        if (goodExposures.length > 0 && Math.random() < 0.4 * b.level) callTrump = true;
        else if (pos === this.bidder) callTrump = true;
        else if (isLast && wt !== myTeam && tPts > 0) callTrump = true;
        else if (wt !== myTeam && tPts >= 2) callTrump = true;
        else if (trumps.some(t => t.rank === 'J' || t.rank === '9')) callTrump = true;
        else if (this.trickCards.some(tc => tc.card.points > 0 || tc.card.rank === 'J' || tc.card.rank === '9')) callTrump = true;
        if (callTrump) {
          const goodOutcome = wt !== myTeam; // calling trump to steal back a trick the other team was winning
          brain.recordTrumpExposure(this.seats[pos].name, { trickLen: this.trickCards.length }, true, goodOutcome);
          this.exposeTrump();
          if (trumps.length > 0) {
            trumps.sort((a, c) => RANK_ORDER[c.rank] - RANK_ORDER[a.rank]);
            this.playCard(pos, trumps[0]);
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
    const isBidder = pos === this.bidder;
    if (this.trickSuit === '') {
      const isEarly = this.tricksPlayed < 4;
      const bySuit = {};
      for (const s of SUITS) bySuit[s] = [];
      for (const c of hand) bySuit[c.suit].push(c);
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
        const iHoldJ = bySuit[s].some(c => c.rank === 'J');
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
            if (bySuit[s].length > 1) { candidates.push({ card: bySuit[s][1], score: bySuit[s].length * 5 - voidOpponentPenalty + partnerVoidBonus, suit: s }); continue; }
            // A LONE 9 (or J) with nothing else in that suit — there's no
            // second card to lead instead, so this exact card is the only
            // option if this suit gets picked at all. A lone Jack is
            // still fine (nothing beats it barring trump), but a lone 9
            // is exactly the "leading a point card into a suit where the
            // opponent may still hold the Jack" mistake if that Jack
            // hasn't been seen yet — this was previously falling through
            // with zero penalty just because there was no second card to
            // swap in instead.
            if (low.rank === '9' && !jSeen) sc -= 25;
          }
          sc += bySuit[s].length * 5;
          if (low.points === 0) sc += 20;
          if (low.rank === '7' || low.rank === '8') sc += 15;
          if (high.points > 0) sc -= 10;
          if (s === this.trumpSuit) sc -= 30;
          candidates.push({ card: low, score: sc, suit: s });
        } else {
          // The Jack is the single most valuable card in the game — if
          // this hand actually holds it, leading it is close to a free
          // trick (nothing beats it barring trump) and should be strongly
          // preferred over anything else on offer.
          if (iHoldJ) {
            candidates.push({ card: bySuit[s].find(c => c.rank === 'J'), score: 60 + bySuit[s].length * 3 - voidOpponentPenalty, suit: s });
            continue;
          }
          // Holding the 9 without the Jack is only a safe, strong lead
          // once that suit's Jack has genuinely been accounted for —
          // otherwise it's exactly the "leading a point card into a suit
          // where the opponent may still hold the Jack" mistake, and
          // often just gives points away for nothing.
          if (iHold9) {
            if (jSeen) {
              candidates.push({ card: bySuit[s].find(c => c.rank === '9'), score: 45 + bySuit[s].length * 3 - voidOpponentPenalty, suit: s });
              continue;
            }
            sc -= 25; // real risk, not a lead to favor
          }
          sc += bySuit[s].reduce((a, c) => a + c.points, 0) * 10 + bySuit[s].length * 3;
          // Aces and 10s carry real points but are still beaten by an
          // unseen Jack or 9 of the same suit — only lead them with
          // confidence once both are already accounted for.
          if ((high.rank === 'A' || high.rank === '10') && (!jSeen || !nineSeen)) sc -= 15;
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
        if (has9) return follow.find(c => c.rank === '9');
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
      if (wt === myTeam) {
        const feedable = follow.filter(c => c.points > 0 && c.rank !== 'J' && c.rank !== '9');
        if (feedable.length > 0) {
          feedable.sort((a, c) => c.points - a.points);
          return feedable[0];
        }
      }
      return follow[follow.length - 1];
    }

    const trumps = hand.filter(c => c.suit === this.trumpSuit);
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
      const worthTrumping = tPts >= 2 || isLast || (isBidder && tPts >= 1);
      if (trumpWinning && wt !== myTeam && worthTrumping) {
        let wtr = trumps[0];
        if (cwc && cwc.suit === this.trumpSuit) {
          for (let i = trumps.length - 1; i >= 0; i--) {
            if (RANK_ORDER[trumps[i].rank] > RANK_ORDER[cwc.rank]) { wtr = trumps[i]; break; }
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
        if (wt === myTeam && feedablePts.length > 0) {
          feedablePts.sort((a, c) => c.points - a.points);
          return feedablePts[0];
        }
        nonTrumpDiscard.sort((a, c) => a.points !== c.points ? a.points - c.points : RANK_ORDER[a.rank] - RANK_ORDER[c.rank]);
        return nonTrumpDiscard[0];
      }
      return trumps[trumps.length - 1]; // genuinely nothing else left to throw
    }

    if (!this.trumpExposed && trumps.length > 0 && this.trickSuit !== this.trumpSuit) {
      if (isLast && wt !== myTeam && tPts >= 2) { trumps.sort((a, c) => RANK_ORDER[c.rank] - RANK_ORDER[a.rank]); return trumps[0]; }
      if (isBidder && tPts >= 3) { trumps.sort((a, c) => RANK_ORDER[c.rank] - RANK_ORDER[a.rank]); return trumps[0]; }
    }

    let disc = hand.filter(c => c.suit !== this.trumpSuit);
    if (!disc.length) disc = hand;
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
      phase: this.phase,
      dealer: this.dealer,
      tricksPlayed: this.tricksPlayed,
      currentPlayer: this.currentPlayer,
      bidder: this.bidder,
      highestBid: this.highestBid,
      passes: this.passes,
      bidHistory: this.bidHistory,
      p2LastRaiser: this.p2LastRaiser,
      p2MinRaise: this.phase === 'bidding2' ? Math.max(20, this.highestBid + 1) : null,
      learningPulseCount: this.learningPulseCount,
      lastLearningBotName: this.lastLearningBotName,
      trumpSuit: this.trumpSuit, // the chosen SUIT is known to everyone once picked — only the specific hidden CARD stays secret until exposure
      trumpExposed: this.trumpExposed,
      roundVoidMessage: this.roundVoidMessage,
      mustPlayTrump: this.mustPlayTrumpBy === viewerPos, // viewer just asked for the reveal and owes a trump card this trick if holding one
      hasHiddenTrump: !!this.hiddenTrump,
      myHiddenTrumpCard: (this.hiddenTrump && viewerPos === this.hiddenTrumpOwner) ? this.hiddenTrump : null,
      trickCards: this.trickCards,
      trickSuit: this.trickSuit,
      teamPoints: this.teamPoints,
      gameScore: this.gameScore,
      championshipNumber: this.championshipNumber,
      kingStreak: this.kingStreak,
      lastChampionshipResult: this.lastChampionshipResult,
      lastTrick: this.lastTrick,
      roundWinnerAnnounced: this.roundWinnerAnnounced,
      seats: this.seats.map((s, i) => s ? {
        name: s.name, isBot: s.isBot, connected: s.connected,
        cardCount: s.hand.length,
        hand: i === viewerPos ? s.hand : undefined
      } : null)
    };
  }
}

module.exports = { GameEngine, SUITS, RANKS, POINTS, RANK_ORDER, getTeam, freshDeck, evaluatePhase1Hand, evaluatePhase2Hand, bestPhase2Evaluation };
