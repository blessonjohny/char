// ============================================================
// 28 KERALA GULAN — 6-PLAYER VARIANT — AUTHORITATIVE GAME ENGINE
// ============================================================
// Sibling to game-engine.js (the 4-player engine), NOT a modification of
// it — this is a genuinely different ruleset, not just "more seats":
//  - 6 players, 2 teams of 3 (seats 0,2,4 vs 1,3,5).
//  - 36-card deck: the usual 7,8,9,10,J,Q,K,A of each suit PLUS a 6 of
//    each suit (worth 0 points, like 7/8/K/Q). 6 cards dealt per player,
//    all at once — no split "4 now, 4 more after trump" like the 4p game.
//  - Single bidding phase, 16-28 (no phase-2 raise round at all). The
//    first bidder (dealer's right) must bid at least 16 and cannot pass.
//  - No Pair (K+Q of trump) bonus — deliberately left out.
//  - No championship/King-of-the-Table meta-game — the match simply ends
//    the moment either team's score reaches 12 or drops to 0.
//  - Otherwise the same core mechanics as the 4p game: hidden trump card,
//    forced-exposure on an off-suit trump play or an explicit callTrump,
//    follow-suit requirement, same point values and same scoring curve
//    (bid<18: +1/-2, bid 18-27: +2/-3, bid>=28: +3/-4).
// ============================================================

const SUITS = ['♥', '♠', '♦', '♣'];
const RANKS = ['7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const POINTS = { J: 3, '9': 2, A: 1, '10': 1, K: 0, Q: 0, '8': 0, '7': 0, '6': 0 };
const RANK_ORDER = { J: 8, '9': 7, A: 6, '10': 5, K: 4, Q: 3, '8': 2, '7': 1, '6': 0 };
const SEATS = 6;
const brain = require('./bot-brain');
brain.loadBrains();

// Alternating seats form each team: 0,2,4 vs 1,3,5 — matches the source
// file's own getTeam() exactly, not assumed.
function getTeam(pos) { return pos % 2 === 0 ? 0 : 1; }
// Turn order goes to the right around the table: seat numbers count UP,
// wrapping from 5 back to 0. The very first dealer of a match is chosen
// at random (see the constructor / restartGame below); every dealer
// after that is simply whoever is one seat to the right of the last one,
// and bidding/play always starts from the seat to the right of whoever
// is currently acting — so the whole table rotates consistently in one
// direction, right around from the random starting point.
function nextPos(p) { return (p + 1) % SEATS; }

function freshDeck() {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) deck.push({ suit: s, rank: r, points: POINTS[r] });
  for (const s of SUITS) deck.push({ suit: s, rank: '6', points: 0 }); // the 36th-card extras
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

// Per explicit request: models how a real physical deck actually behaves between rounds --
// the cards from the last round don't reset to a fresh factory order before the next shuffle,
// they start from however they ended up stacked as tricks were collected (folded on top of
// each other) one after another. foldOrder is exactly that: this.playedCardsThisRound from the
// round that just ended, in the order each trick was gathered up.
//
// Worth being explicit about what this changes and what it doesn't: a proper Fisher-Yates
// shuffle (the same one freshDeck() already runs) produces a uniformly random result
// regardless of what order the cards were in before it started -- so this isn't a fairness fix
// and the deck was never biased to begin with. It's specifically about matching the physical
// mental model of how a real deck moves from round to round, which is the actual thing asked
// for here, not a claim that the old approach was somehow less fair.
//
// Falls back to the plain freshDeck() factory order whenever foldOrder isn't a genuinely
// complete 36-card stack -- the very first round of a new game (nothing has been played yet to
// build a fold order from at all) being the main case, exactly as expected.
function freshDeckFromFoldOrder(foldOrder) {
  const base = (Array.isArray(foldOrder) && foldOrder.length === 36) ? foldOrder.slice() : null;
  const deck = base || (() => {
    const d = [];
    for (const s of SUITS) for (const r of RANKS) d.push({ suit: s, rank: r, points: POINTS[r] });
    for (const s of SUITS) d.push({ suit: s, rank: '6', points: 0 });
    return d;
  })();
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function cardEq(a, b) { return a.suit === b.suit && a.rank === b.rank; }

// ============================================================
// BIDDING EVALUATION — reuses the same suit-dominance model built for
// the 4-player game (see game-engine.js for the full reasoning), just
// re-scaled for a 6-card hand and a 16+ bid floor instead of 14+.
// ============================================================
function evaluateHand(hand) {
  const bySuit = {};
  for (const s of SUITS) bySuit[s] = [];
  for (const c of hand) bySuit[c.suit].push(c);

  let bestSuit = null, bestSuitScore = -1;
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
    if (score > bestSuitScore) { bestSuitScore = score; bestSuit = s; }
  }
  if (bestSuit === null) bestSuitScore = 0;

  const jacks = hand.filter(c => c.rank === 'J');
  const jackSuits = new Set(jacks.map(c => c.suit));
  const jacksScattered = jacks.length >= 2 && jackSuits.size === jacks.length;
  const highCardCount = hand.filter(c => ['J', '9', 'A', '10'].includes(c.rank)).length;

  let offensive = bestSuitScore * 3 + Math.min(6, highCardCount * 1.5);
  if (jacksScattered) offensive -= (jacks.length - 1) * 4;
  const defensive = jacks.length * 10 + hand.filter(c => c.points === 0).length * 2;

  const ceiling = 16 + offensive / 8;
  const probByBid = {};
  for (let bid = 16; bid <= 28; bid++) {
    const margin = ceiling - bid;
    let p = margin >= 0 ? 0.97 - 0.25 * Math.exp(-margin / 3) : 0.72 * Math.exp(margin / 3);
    probByBid[bid] = Math.max(0.02, Math.min(0.97, p));
  }
  return { offensive, defensive, bestSuit, ceiling, probByBid };
}

class GameEngine6P {
  constructor(tableId) {
    this.tableId = tableId;
    this.seats = new Array(SEATS).fill(null);
    this.round = 0;
    this.gameScore = [0, 0];
    this.gameOver = null; // {winningTeam, finalScore} once the match ends
    // "Q" penalty marks: same rule as the 4-player game. This engine has
    // no automatic championship-to-championship continuation (a match
    // just ends outright and needs an explicit restartGame() to begin
    // the next one) -- that restart is treated as "the next championship
    // starting" for the first-hand partner-bonus exception.
    this.qMarks = {};
    this.isFirstHandOfChampionship = true;
    // Partner bidding signals: same rule as the 4-player game, but sent
    // to every teammate at once since teams are 3-a-side here.
    this.partnerSignals = {}; // seat -> {signal:'same'|'higher'|'lower', fromSeat, fromName, forRound}
    this.dealer = Math.floor(Math.random() * SEATS);
    this.resetRoundState();
    this.phase = 'lobby'; // lobby | bidding1 | choosingTrump | play | roundEnd
    this.log = [];
    this.learningPulseCount = 0;
    this.lastLearningBotName = '';
    this.onChange = null;
  }

  _notify() { if (this.onChange) { try { this.onChange(); } catch (e) { console.error('onChange handler error:', e); } } }

  resetRoundState() {
    this.currentPlayer = 0;
    this.deck = [];
    this.bidder = -1;
    this.highestBid = 0;
    this.passes = 0;
    // Tracks total bidding actions taken this auction (bid OR pass,
    // including the forced first bid), separate from `passes` above --
    // `passes` resets to 0 every time someone raises, which meant the
    // auction could effectively restart its own clock mid-round and
    // cycle back for a SECOND turn from someone who already acted, as
    // long as enough people happened to bid instead of pass along the
    // way. The real rule is a single pass around the table: every seat
    // gets exactly one turn, then it's over, however the bids landed.
    this.bidTurnsTaken = 0;
    // Which seats have already taken their one bidding turn this
    // auction -- needed by _nextBidTurn's team-reactive lookups (finding
    // "the next unacted seat on team X"), since the turn order is no
    // longer a simple physical rotation.
    this.bidActed = [false, false, false, false, false, false];
    // Per-team "where did OUR side leave off" pointer -- the seat of the
    // last member of that team to actually act (bid or pass) this
    // auction, or -1 if nobody on that team has gone yet. Needed so
    // _nextBidTurn can continue each team's own internal rotation from
    // its own last actor, instead of measuring distance from whoever
    // most recently acted overall (see _nextBidTurn for the full bug
    // this fixes: measuring from an opponent's seat can skip over a
    // teammate who's been waiting since earlier in the round in favor
    // of one who merely sits seat-adjacent to that opponent).
    this.teamLastBidActor = [-1, -1];
    this.bidHistory = [];
    this.trumpSuit = '';
    this.trumpExposed = false;
    this.roundVoidMessage = null;
    this.hiddenTrump = null;
    this.revealedTrumpCard = null; // {rank, suit} -- public once exposed, unlike hiddenTrump; see exposeTrump()
    this.hiddenTrumpOwner = -1;
    this.mustPlayTrumpBy = -1;
    this.trickCards = [];
    this.trickSuit = '';
    this.suitLeadCount = { '♠': 0, '♥': 0, '♦': 0, '♣': 0 };
    this.playedCardsThisRound = [];
    this.voidSuits = Array.from({ length: SEATS }, () => new Set());
    // Per explicit report, same fix as the 4-player engine's identical
    // addition -- see there for the fuller reasoning. Which suits have
    // already been cut (led, then won by trump instead of the led suit
    // itself) this round, populated in _resolveTrick() below.
    this.suitsCutThisRound = new Set();
    this.tricksPlayed = 0;
    this.teamPoints = [0, 0];
    this.lastTrick = null;
    this.roundWinnerAnnounced = null;
    // "Already won" early-round-end and Quote -- see game-engine.js
    // (the 4-player engine) for the full reasoning behind both, now
    // redesigned there to be always-live rather than tied to a fixed
    // trick number: available to WHICHEVER team is currently clean
    // (hasn't lost a trick yet, true for both teams from the start),
    // for any player on that team on their own turn, as long as the bid
    // was <=19. Ported here identically -- only the full-sweep total
    // matters for success (28, confirmed unchanged for this variant's
    // 36-card deck), not any trick-count trigger.
    this.pendingEarlyWinChoice = null;
    this.earlyWinDeclined = false;
    this.teamStillClean = [true, true];
    this.quoteState = null;
    // Mid-trick COT/MaruCOT offer: while a trick is still in progress, if the CURRENT leading
    // card belongs to the opposing team from whoever just played, and that leader is otherwise
    // eligible, they get offered the same declare-or-not choice a normal trick-opener would get
    // - just triggered mid-trick instead of only at the moment of leading. Declining isn't a
    // no-op like it would be at trick-open: it ends the round immediately with a flat,
    // guaranteed reward (1pt on the COT path, 2pt on the MaruCOT path) instead of playing out
    // the rest of the round normally - see respondToMidTrickQuote() and
    // _endRoundByMidTrickDecline() for the actual mechanics.
    this.pendingMidTrickQuote = null;
    this.midTrickQuoteDeclinedThisTrick = false;
    // Thani -- see game-engine.js (the 4-player table) for the full
    // reasoning, identical rule here except folding: this table's teams
    // are 3-a-side, so BOTH of the caller's other teammates fold, not
    // just one. No trump at all this round either way -- see callThani()
    // below.
    this.thaniCaller = -1;
    this.foldedSeats = [];
  }

  addLog(msg) {
    this.log.push({ t: Date.now(), msg });
    if (this.log.length > 200) this.log.shift();
    console.log(`[6p table ${this.tableId}] ${msg}`);
  }

  // ---------------- Seating ----------------

  emptySeats() {
    const out = [];
    for (let i = 0; i < SEATS; i++) if (!this.seats[i]) out.push(i);
    return out;
  }

  humanCount() { return this.seats.filter(s => s && !s.isBot).length; }

  seatHuman(pos, name, playerId, avatar) {
    this.seats[pos] = { name, isBot: false, connected: true, playerId, hand: [], avatar: avatar || null };
  }

  seatBot(pos, name) {
    this.seats[pos] = { name, isBot: true, connected: true, playerId: null, hand: [] };
  }

  removeSeat(pos) { this.seats[pos] = null; }

  // A human explicitly exiting mid-game — the reverse of replaceBot
  // below. Keeps the seat's exact current hand/state and simply makes
  // it bot-controlled, so the table keeps running instead of breaking
  // or leaving a hole. Same as game-engine.js's version, needed here
  // too since 6-player uses this entirely separate engine file.
  convertToBot(pos) {
    const seat = this.seats[pos];
    if (!seat || seat.isBot) return false;
    seat.isBot = true; seat.connected = true; seat.playerId = null;
    // See game-engine.js's identical fix for the full reasoning - clears any leftover
    // ghost-player flag so it can't follow this seat if a real human takes it over later.
    seat.ghostPlayer = false;
    return true;
  }

  replaceBot(pos, playerId, name, avatar) {
    const seat = this.seats[pos];
    if (!seat || !seat.isBot) return false;
    seat.isBot = false; seat.connected = true; seat.playerId = playerId; seat.name = name;
    seat.avatar = avatar || null;
    // See game-engine.js's identical fix - a bot seat can be the leftover remains of a
    // stopped ghost player, and a genuine human taking it over must never inherit this.
    seat.ghostPlayer = false;
    return true;
  }

  takeOverSeat(pos, playerId, name, avatar) {
    const seat = this.seats[pos];
    if (!seat) return false;
    if (!seat.isBot && seat.connected) return false;
    seat.isBot = false; seat.connected = true; seat.playerId = playerId; seat.name = name;
    seat.avatar = avatar || null;
    seat.ghostPlayer = false;
    return true;
  }

  markConnected(pos, connected) {
    if (!this.seats[pos]) return;
    this.seats[pos].connected = connected;
    if (!connected) this.seats[pos].disconnectedAt = Date.now();
    else this.seats[pos].disconnectedAt = null;
    // Real bug fix, per explicit report: reconnecting/resuming while it's
    // STILL this same seat's own unfinished turn never reset
    // turnStartedAt at all -- that only happens when currentPlayer or
    // round actually changes. A genuine pause (tab backgrounded, app
    // minimized, etc. -- the socket can stay alive through all of that,
    // this isn't only about a hard disconnect) that ran past the
    // CONNECTED_BUT_STUCK_MS threshold in maybeAutoAct() left that
    // turn's "stuck" status permanent for the rest of it: turnAgeMs kept
    // counting from the ORIGINAL start of the turn, long since past
    // the threshold, no matter how promptly the player actually came
    // back and tried to act. maybeAutoAct() runs from many different
    // places (after every broadcast, essentially), so it kept re-firing
    // and re-scheduling an auto-act regardless of what the returning
    // player did. Resetting the clock here, specifically when THIS is
    // the seat whose turn is currently active, gives a genuine fresh
    // grace window from the actual moment they're back, rather than
    // inheriting an already-expired one.
    if (connected && this.currentPlayer === pos) {
      this.turnStartedAt = Date.now();
    }
  }
  findSeatByPlayerId(playerId) { return this.seats.findIndex(s => s && s.playerId === playerId); }

  // ---------------- Round lifecycle ----------------

  canStart() { return this.seats.filter(Boolean).length >= 2; }

  // Redeals (same dealer, no notify/side effects per attempt) until
  // neither auto-reshuffle condition is true: the forced first bidder
  // holding nothing but 7s/8s (an unplayable hand they'd otherwise be
  // forced to bid on), or any single seat holding all four Jacks. Same
  // rule and same reasoning as the 4-player table's own version -- this
  // engine just never had it at all until now. Returns the reason for
  // the FIRST bad deal hit in the chain (or null if the original deal
  // was already fine).
  _dealSameHandUntilValid() {
    let reason = null;
    let guard = 0;
    while (guard++ < 100) { // effectively unbounded in practice; just a hard safety cap
      const firstBidderSeat = nextPos(this.dealer);
      const firstBidderHand = this.seats[firstBidderSeat] ? this.seats[firstBidderSeat].hand : [];
      const isAll78 = firstBidderHand.length === 6 && firstBidderHand.every(c => c.rank === '7' || c.rank === '8');
      let allJacksSeat = -1;
      if (!isAll78) {
        for (let i = 0; i < SEATS; i++) {
          const hand = this.seats[i] ? this.seats[i].hand : [];
          if (hand.filter(c => c.rank === 'J').length === 4) { allJacksSeat = i; break; }
        }
      }
      // Per explicit request: a new, broader "genuinely worthless hand" check - ANY seat
      // (not just the forced first bidder) dealt all 6 cards from just {6,7,8} - the three
      // lowest ranks in this deck, worth 0 points and barely able to win a trick against
      // anything. Checked after the two existing conditions above and skipped entirely if
      // either already matched, since isAll78 is a strict subset of this (7s/8s only, no 6,
      // first bidder only) and would otherwise double-report the exact same hand under two
      // different reasons.
      let all678Seat = -1;
      if (!isAll78 && allJacksSeat === -1) {
        for (let i = 0; i < SEATS; i++) {
          const hand = this.seats[i] ? this.seats[i].hand : [];
          if (hand.length === 6 && hand.every(c => c.rank === '6' || c.rank === '7' || c.rank === '8')) { all678Seat = i; break; }
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
      for (let i = 0; i < SEATS; i++) { if (this.seats[i]) this.seats[i].hand = []; }
      this.deck = freshDeck();
      // Per explicit instruction: dealt as two passes of 3 (going all
      // the way around the table each pass) rather than one pass of 6,
      // even though there's only a single bidding phase here and both
      // passes happen back to back with nothing in between them --
      // bidding only starts once both passes are done either way, so
      // this doesn't change when bidding begins or what anyone ends up
      // holding, just how the deal itself is structured.
      this.dealCards(3);
      this.dealCards(3);
    }
    return reason;
  }

  startRound() {
    // Captured BEFORE resetRoundState() wipes playedCardsThisRound back
    // to [] -- this is the previous round's actual fold order (all 36
    // cards, in the order each trick was collected), used as this new
    // round's pre-shuffle starting stack. See freshDeckFromFoldOrder for
    // the full reasoning.
    const priorFoldOrder = this.playedCardsThisRound;
    this.round++;
    this.resetRoundState();
    this.dealer = nextPos(this.dealer);
    this.currentPlayer = nextPos(this.dealer);
    this.deck = freshDeckFromFoldOrder(priorFoldOrder);
    for (let i = 0; i < SEATS; i++) if (this.seats[i]) this.seats[i].hand = [];
    // Per explicit instruction: two passes of 3 around the table, not
    // one pass of 6 -- see the identical change/reasoning in
    // _dealSameHandUntilValid above. Still only one bidding phase,
    // still starts only once both passes finish.
    this.dealCards(3);
    this.dealCards(3);
    this.reshuffleReason = this._dealSameHandUntilValid();
    this._validateCardIntegrity('startRound, right after dealing');
    this.phase = 'bidding1';
    this.addLog(`Round ${this.round} started. Dealer seat ${this.dealer}.`);
    this._notify();
    this.maybeAutoAct();
  }

  restartRound() {
    // Same reasoning as startRound() -- captured before resetRoundState()
    // wipes it, so a mid-round restart still bases its fresh shuffle on
    // whatever was actually played of THIS round before the restart, not
    // a blank factory order.
    const priorFoldOrder = this.playedCardsThisRound;
    const keepRound = this.round, keepDealer = this.dealer;
    this.resetRoundState();
    this.round = keepRound; this.dealer = keepDealer;
    this.currentPlayer = nextPos(this.dealer);
    this.deck = freshDeckFromFoldOrder(priorFoldOrder);
    for (let i = 0; i < SEATS; i++) if (this.seats[i]) this.seats[i].hand = [];
    // Per explicit instruction: same two-passes-of-3 dealing as
    // startRound() -- see there for the fuller reasoning.
    this.dealCards(3);
    this.dealCards(3);
    this.reshuffleReason = this._dealSameHandUntilValid();
    this._validateCardIntegrity('restartRound, right after dealing');
    this.phase = 'bidding1';
    this.addLog(`Round ${this.round} restarted by the host — fresh shuffle.`);
    this._notify();
    this.maybeAutoAct();
  }

  restartGame() {
    this.gameScore = [0, 0];
    this.gameOver = null;
    this.round = 0;
    this.dealer = Math.floor(Math.random() * SEATS);
    // A brand new game's first round has no legitimate prior round to
    // base a fold order on -- explicitly cleared here so startRound()'s
    // own capture-before-reset sees an empty array (not 36 leftover
    // cards from the game that just ended) and correctly falls back to
    // freshDeckFromFoldOrder's plain factory order for this one round.
    this.playedCardsThisRound = [];
    // Q marks deliberately NOT cleared here -- this is the only path to
    // a new match in this engine (there's no automatic continuation
    // like the 4-player game has), so clearing on every restart would
    // mean a Q could never actually survive into "the next
    // championship" at all. It carries over; only the first-hand flag
    // resets for the fresh match.
    this.isFirstHandOfChampionship = true;
    this.addLog('Host restarted the game — starting a fresh match.');
    this.startRound();
  }

  kickPlayer(pos) {
    const seat = this.seats[pos];
    if (!seat) return false;
    if (this.phase === 'lobby') { this.seats[pos] = null; }
    else { seat.isBot = true; seat.connected = true; seat.playerId = null; }
    this.addLog(`${seat.name} was removed by the host.`);
    this._notify();
    this.maybeAutoAct();
    return true;
  }

  // Same safe bot-personality swap as the 4-player engine — touches only
  // the name string, never hand/turn/phase, so it's safe mid-round.
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
      for (let i = 0; i < SEATS; i++) {
        if (!this.seats[i]) continue;
        const card = this.deck.pop();
        if (card) this.seats[i].hand.push(card);
      }
    }
  }

  // ---------------- Bidding (single phase, 16-28) ----------------

  isFirstBidder(pos) {
    return this.highestBid === 0 && this.passes === 0 && pos === nextPos(this.dealer);
  }

  // Per explicit instruction: replaces the old continuous EV/comfort-
  // threshold bid target with an explicit table based on exact hand
  // composition, confirmed line-by-line:
  //   J + 3 more of that suit (4 total)              -> 17
  //   J + 9 + 2 more of that suit (4 total, incl J+9) -> 18
  //   J + 9 + A + anything (4+ total, incl J+9+A)     -> 20
  //   the above, PLUS a second Jack (different suit)  -> was Thani
  // Per further explicit instruction: bots must never call Thani at
  // all now -- where a hand would previously have qualified for it,
  // the bot bids a number instead, capped at 26 (not the game's true
  // max of 28, left as headroom above a bot's own ceiling), and NOT a
  // flat jump straight to that cap every time. Scaled by how strong
  // the qualifying hand actually is: a bare second Jack (no matching
  // 9 in that second suit) bids toward the lower end of this tier
  // (22); a second Jack that ALSO brings its own suit's 9 -- genuinely
  // two strong suits, not just an extra high card -- bids at the full
  // 26 cap. Default with no qualifying suit at all is the game's own
  // bidding minimum (16), not some intermediate guess -- "goes to
  // bidding minimum" was explicit. Checks every suit the bot holds a
  // Jack in and uses whichever qualifies for the strongest tier, since
  // the bidder chooses trump later and would naturally pick their best
  // suit.
  _tableBid(hand) {
    const bySuit = {};
    for (const c of hand) { (bySuit[c.suit] = bySuit[c.suit] || []).push(c); }
    const jackSuits = Object.keys(bySuit).filter(s => bySuit[s].some(c => c.rank === 'J'));
    let bestSuit = null, bestTier = 0;
    for (const s of jackSuits) {
      const cards = bySuit[s];
      const hasNine = cards.some(c => c.rank === '9');
      const hasAce = cards.some(c => c.rank === 'A');
      const len = cards.length;
      let tier = 0;
      if (hasNine && hasAce && len >= 4) tier = 3;
      else if (hasNine && len >= 4) tier = 2;
      else if (len >= 4) tier = 1;
      if (tier > bestTier) { bestTier = tier; bestSuit = s; }
    }
    const secondJackSuit = bestTier === 3 ? jackSuits.find(s => s !== bestSuit) : null;
    if (secondJackSuit) {
      const secondSuitHasNine = bySuit[secondJackSuit].some(c => c.rank === '9');
      const bidValue = secondSuitHasNine ? 26 : 22;
      return { bidValue, isThani: false };
    }
    const bidValue = bestTier === 3 ? 20 : bestTier === 2 ? 18 : bestTier === 1 ? 17 : 16;
    return { bidValue, isThani: false };
  }

  // A human telling their teammates how to approach the next hand's
  // bidding -- same, more aggressive, or less aggressive. Sent to every
  // teammate at once (3-a-side teams here, no single "partner").
  sendPartnerSignal(fromSeat, signal) {
    if (!['same', 'higher', 'lower'].includes(signal)) return { ok: false, reason: 'bad_signal' };
    const fromSeatInfo = this.seats[fromSeat];
    if (!fromSeatInfo) return { ok: false, reason: 'no_seat' };
    const myTeam = getTeam(fromSeat);
    const toSeats = [];
    for (let i = 0; i < SEATS; i++) {
      if (i === fromSeat || getTeam(i) !== myTeam) continue;
      this.partnerSignals[i] = { signal, fromSeat, fromName: fromSeatInfo.name, forRound: this.round + 1 };
      toSeats.push(i);
    }
    this.addLog(`${fromSeatInfo.name} signaled their team: bid ${signal === 'same' ? 'the same' : signal === 'higher' ? 'more aggressively' : 'less aggressively'} next hand.`);
    this._notify();
    return { ok: true, toSeats };
  }

  placeBid(pos, bid) {
    if (this.phase !== 'bidding1') return { ok: false, reason: 'not_bidding' };
    if (pos !== this.currentPlayer) return { ok: false, reason: 'not_your_turn' };
    const first = this.isFirstBidder(pos);
    // Honors restriction: triggers whenever it's genuinely your turn and
    // your OWN PARTNER already holds the current highest bid -- whether
    // that's because the whole opposing team passed and the turn fell
    // through back to your side, or simply because it's your normal
    // turn and your partner already happens to be on top. Either way,
    // your team is already ahead, so a plain raise isn't the point --
    // only a genuine honors-level bid (20+) is allowed.
    const honorsRestricted = !first && this.highestBid > 0 && getTeam(this.bidder) === getTeam(pos);
    // Per explicit instruction: a further, tighter restriction within
    // the honors-restriction case above -- once your OWN partner's
    // bid has ALREADY reached honors level (20+), there's no point
    // incrementally raising your own team's bid a point or two at a
    // time anymore (17->20 already had to jump straight to honors via
    // the rule above; from 20 onward there's nothing left to gain by
    // going to 21, 22, etc. against yourself). The only two moves that
    // still mean anything at that point are going all the way to 28,
    // or calling Thani instead (handled entirely separately by
    // callThani/isThaniOption, unaffected by this numeric bid check).
    const partnerAlreadyHonors = honorsRestricted && this.highestBid >= 20;
    if (bid === 0) {
      if (first) bid = 16; // first bidder cannot pass
      else {
        this.bidActed[pos] = true;
        this.passes++;
        this.bidTurnsTaken++;
        this.bidHistory.push({ pos, bid: 0 });
        this.addLog(`Seat ${pos} passed.`);
        return this._afterBidAction(pos, false);
      }
    }
    if (partnerAlreadyHonors && bid !== 28) return { ok: false, reason: 'partner_already_honors_28_or_thani_only' };
    const minBid = honorsRestricted ? Math.max(20, this.highestBid + 1) : (this.highestBid > 0 ? this.highestBid + 1 : 16);
    if (bid < minBid || bid > 28) return { ok: false, reason: 'invalid_bid_amount' };
    this.highestBid = bid;
    this.bidder = pos;
    this.bidActed[pos] = true;
    this.passes = 0;
    this.bidTurnsTaken++;
    this.bidHistory.push({ pos, bid });
    if (this.seats[pos]) this._bidderHandProfileForLearning = brain.getHandProfile(this.seats[pos].hand);
    this.addLog(`Seat ${pos} bid ${bid}.`);
    return this._afterBidAction(pos, true);
  }

  // Per explicit, carefully worked-through instruction: this is NOT a
  // simple seat-by-seat rotation around the table (that's the PLAYING
  // order later, which is unchanged) -- the BIDDING order is reactive
  // and team-based. A bid sends the turn to the OTHER team's next seat
  // that hasn't acted yet; a pass keeps the turn on the passer's OWN
  // team's next unacted seat. If that target team has nobody left
  // unacted, it falls through to the other team's next unacted seat
  // instead. One further refinement, confirmed against multiple full
  // worked-through sequences: within their OWN team's own search order
  // specifically, the dealer is always considered last, not in plain
  // seat-number order -- they still take part in the normal reactive
  // rotation like anyone else (not held out of the whole auction until
  // everyone everywhere else is done, which was an earlier, wrong guess
  // corrected by the actual sequences worked through), they're just the
  // final consideration within their own side specifically, since they
  // already got the advantage of dealing the hand.
  // Per explicit bug report with a full worked sequence: the order
  // within a team was always a FIXED ascending seat order ([0,2,4] or
  // [1,3,5], dealer pushed last), regardless of where the rotation
  // actually was. That's wrong whenever the lowest-numbered unacted
  // teammate isn't the one physically next in clockwise rotation from
  // wherever the last action happened -- e.g. seat 4 bids, and the
  // target team's remaining seats are 1 and 5: seat 5 is the one
  // actually clockwise-adjacent to seat 4, but the old fixed order
  // checked seat 1 first regardless, since 1 < 5. Now takes fromPos
  // (the seat that just acted) and rotates the team's own seat list to
  // start the search clockwise from fromPos+1, wrapping around --
  // dealer-last-within-own-team is still preserved exactly as before,
  // applied as a final sort AFTER the clockwise rotation, not instead
  // of it.
  _bidTeamOrder(team, fromPos) {
    const seats = team === 0 ? [0, 2, 4] : [1, 3, 5];
    let rotated = seats;
    if (typeof fromPos === 'number') {
      // Sort by clockwise distance from fromPos (1..SEATS-1 steps away), not raw seat number.
      rotated = seats.slice().sort((a, b) => ((a - fromPos + SEATS) % SEATS) - ((b - fromPos + SEATS) % SEATS));
    }
    return rotated.slice().sort((a, b) => (a === this.dealer ? 1 : 0) - (b === this.dealer ? 1 : 0));
  }
  // Per explicit bug report (full worked sequence: opponent bids, turn
  // reactively returns to your team, and the seat physically adjacent
  // to the OPPONENT gets picked over a teammate who'd been waiting
  // since earlier in the round): the anchor for "clockwise distance"
  // within the target team must be THAT team's own last actor, not
  // whoever just acted overall. lastActor may belong to the opposite
  // team entirely (that's exactly what triggers a reactive flip back to
  // you) -- using their seat as the distance anchor measures adjacency
  // to the opponent's seat, not continuity of your own team's rotation,
  // and can leap over a teammate sitting earlier in line in favor of
  // one who just happens to sit next to the opponent. Falls back to
  // lastActor only the very first time a given team is asked to act
  // this auction (it has no anchor of its own yet).
  _nextBidTurn(lastActor, wasABid) {
    const lastTeam = getTeam(lastActor);
    const targetTeam = wasABid ? (1 - lastTeam) : lastTeam;
    const targetAnchor = this.teamLastBidActor[targetTeam] >= 0 ? this.teamLastBidActor[targetTeam] : lastActor;
    for (const s of this._bidTeamOrder(targetTeam, targetAnchor)) if (!this.bidActed[s]) return s;
    const otherTeam = 1 - targetTeam;
    const otherAnchor = this.teamLastBidActor[otherTeam] >= 0 ? this.teamLastBidActor[otherTeam] : lastActor;
    for (const s of this._bidTeamOrder(otherTeam, otherAnchor)) if (!this.bidActed[s]) return s;
    return -1;
  }

  _afterBidAction(lastActor, wasABid) {
    this.teamLastBidActor[getTeam(lastActor)] = lastActor;
    // Ends once every seat has had exactly one turn (bid or pass) --
    // the ORDER they act in is now reactive (see _nextBidTurn above),
    // but the ending condition itself is unchanged: six total turns,
    // however they land, and it's over.
    if (this.bidTurnsTaken >= SEATS) {
      if (this.highestBid === 0) {
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
    this.currentPlayer = this._nextBidTurn(lastActor, wasABid);
    this._notify();
    this.maybeAutoAct();
    return { ok: true };
  }

  // Thani: available any time it's genuinely someone's turn during
  // bidding -- always beats any numeric bid (effectively "above 28"),
  // so unlike a normal bid there's no threshold to check beyond it not
  // having already been called this round. This table has no separate
  // "phase 2" the way the 4-player table does -- there's only one
  // bidding phase here, so Thani is offered as an option throughout it.
  isThaniOption() {
    return this.thaniCaller === -1;
  }

  // See game-engine.js (the 4-player table) for the full reasoning --
  // identical rule here, except the fold: this table's teams are
  // 3-a-side, so BOTH of the caller's other teammates fold, not just
  // one. No trump at all this round either way -- skips choosingTrump
  // entirely and goes straight to play, same as the 4-player table.
  callThani(pos) {
    if (this.phase !== 'bidding1') return { ok: false, reason: 'not_bidding' };
    if (pos !== this.currentPlayer) return { ok: false, reason: 'not_your_turn' };
    if (!this.isThaniOption()) return { ok: false, reason: 'thani_already_called' };
    this.highestBid = 29; // deliberately just above 28, so it naturally falls in the existing >=28 scoring tier
    this.bidder = pos;
    this.thaniCaller = pos;
    const myTeam = getTeam(pos);
    this.foldedSeats = [];
    for (let i = 0; i < SEATS; i++) {
      if (i !== pos && getTeam(i) === myTeam) this.foldedSeats.push(i);
    }
    this.bidHistory.push({ pos, bid: 'THANI' });
    if (this.seats[pos]) this._bidderHandProfileForLearning = brain.getHandProfile(this.seats[pos].hand);
    const foldedNames = this.foldedSeats.map(i => this.seats[i] ? this.seats[i].name : `Seat ${i}`).join(' and ');
    this.addLog(`Seat ${pos} called THANI — going it alone, needing to win every single trick! ${foldedNames} fold out of this round.`);
    this.hiddenTrump = null;
    this.hiddenTrumpOwner = -1;
    this.trumpSuit = '';
    this._startPlay();
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
    if (hiddenCard) idx = hand.findIndex(c => cardEq(c, hiddenCard));
    if (idx === -1) {
      const trumps = hand.filter(c => c.suit === suit).sort((a, b) => RANK_ORDER[a.rank] - RANK_ORDER[b.rank]);
      if (trumps.length > 0) idx = hand.findIndex(c => cardEq(c, trumps[0]));
    }
    if (idx > -1) {
      this.hiddenTrump = hand.splice(idx, 1)[0];
      this.hiddenTrumpOwner = pos;
    }
    this.addLog(`Seat ${pos} chose ${suit} as trump.`);
    this._validateCardIntegrity('chooseTrump, right after pulling the hidden card out of the hand');
    this._startPlay();
    return { ok: true };
  }

  _startPlay() {
    // Same rule as the 4-player engine: if the whole defending team (both
    // of them, in this variant — seats alternate 0/2/4 vs 1/3/5) holds
    // zero cards of the trump suit between them, there's no way for them
    // to ever contest it. Void the round and move on. Thani rounds have
    // no trump suit at all by design (trumpSuit stays permanently
    // empty), so this check is meaningless for them and must be skipped
    // entirely -- see game-engine.js for the full reasoning.
    const bidTeam = getTeam(this.bidder);
    const defendingTeam = bidTeam === 0 ? 1 : 0;
    const defendingHasTrump = this.thaniCaller >= 0 || this.seats.some((s, i) => s && getTeam(i) !== bidTeam && s.hand.some(c => c.suit === this.trumpSuit));
    if (!defendingHasTrump) {
      this.roundVoidMessage = `The defending team has no ${this.trumpSuit} at all this round — nothing to contest. Round voided, moving to the next dealer.`;
      // Per explicit request: this event existed and correctly voided the round already, but
      // never actually set reshuffleReason the way the 4-player engine's identical check
      // does - so the client's popup system never had a distinct, named event to show a real
      // explanation for, just the generic roundVoidMessage log line. Added to match.
      this.reshuffleReason = { type: 'noTrump', team: defendingTeam, suit: this.trumpSuit, round: this.round, ts: Date.now() };
      this.addLog(this.roundVoidMessage);
      this._notify();
      this.startRound();
      return;
    }

    this.phase = 'play';
    this.trumpExposed = false;
    this.trickCards = [];
    this.trickSuit = '';
    this.suitLeadCount = { '♠': 0, '♥': 0, '♦': 0, '♣': 0 };
    // Dealer's right always leads -- except Thani, where the caller
    // leads the very first trick themselves, immediately, no matter
    // whose turn it would otherwise have been.
    this.currentPlayer = this.thaniCaller >= 0 ? this.thaniCaller : nextPos(this.dealer);
    this.addLog(`Play begins. Seat ${this.currentPlayer} leads.`);
    this._notify();
    this.maybeAutoAct();
  }

  // ---------------- Playing cards ----------------

  // Returns {ok:true} or {ok:false, reason:'...'} instead of a plain boolean - the reason
  // string lets the client show the person a specific, short explanation (e.g. "You must
  // follow suit" vs "You're the bidder - trump stays hidden until asked for") instead of one
  // generic "that card can't be played right now" for every possible rejection cause.
  canPlayCard(pos, card) {
    if (this.phase !== 'play') return { ok: false, reason: 'not_playing' };
    if (pos !== this.currentPlayer) return { ok: false, reason: 'not_your_turn' };
    const hand = this.seats[pos].hand;
    if (!hand.some(c => cardEq(c, card))) return { ok: false, reason: 'not_in_hand' };
    if (this.trickSuit === '') {
      if (pos === this.hiddenTrumpOwner && !this.trumpExposed && card.suit === this.trumpSuit) {
        if (hand.some(c => c.suit !== this.trumpSuit)) return { ok: false, reason: 'bidder_hidden_trump' };
      }
      return { ok: true };
    }
    const hasSuit = hand.some(c => c.suit === this.trickSuit);
    if (hasSuit && card.suit !== this.trickSuit) return { ok: false, reason: 'must_follow_suit' };
    if (this.mustPlayTrumpBy === pos && !hasSuit && card.suit !== this.trumpSuit) {
      if (hand.some(c => c.suit === this.trumpSuit)) return { ok: false, reason: 'must_play_trump' };
    }
    return { ok: true };
  }

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
    const chk = this.canPlayCard(pos, card);
    if (!chk.ok) return chk;
    const hand = this.seats[pos].hand;
    const idx = hand.findIndex(c => cardEq(c, card));
    const played = hand.splice(idx, 1)[0];
    if (this.mustPlayTrumpBy === pos) this.mustPlayTrumpBy = -1;
    if (this.trickSuit === '') { this.trickSuit = played.suit; this.suitLeadCount[played.suit]++; }

    // Same rule as the 4-player game: a trump-suited card played as an
    // ordinary discard (couldn't follow suit, never explicitly called
    // trump) does not expose trump and can never win this trick, even if
    // trump gets legitimately exposed later in the same trick by someone
    // else. See game-engine.js's playCard for the full reasoning.
    const isIncidentalTrumpDiscard = !this.trumpExposed && played.suit === this.trumpSuit && this.trickSuit !== this.trumpSuit;
    this.trickCards.push({ pos, card: played, powerless: isIncidentalTrumpDiscard });

    this.addLog(`Seat ${pos} played ${played.rank}${played.suit}.`);

    // A folded seat (Thani's teammates) never plays, so a trick is
    // complete once every ACTIVE player has played, not always
    // literally SEATS -- normally still 6, but 4 during a Thani round
    // (caller + 3 opponents, since 2 teammates fold).
    if (this.trickCards.length === SEATS - this.foldedSeats.length) {
      this._resolveTrick();
    } else {
      this.currentPlayer = this._nextActivePos(this.currentPlayer);
      this._notify();
      this.maybeAutoAct();
    }
    return { ok: true };
  }

  // Computes who a given player COULD ask right now, if anyone - shared between exposing this
  // to the client (so the "Ask COT/MaruCOT?" button knows when to light up) and validating an
  // actual request. Returns the position of a valid target, or null if there's nobody the
  // asker could currently ask.
  _getMidTrickAskTarget(askerPos) {
    if (this.pendingMidTrickQuote || this.quoteState || this.midTrickQuoteDeclinedThisTrick) return null;
    if (this.phase !== 'play') return null;
    // The Ask button specifically (not the regular Declare button, which is untouched by this)
    // is unavailable entirely during a round's very first trick - it only ever activates
    // starting from the second trick onward, once tricksPlayed > 0.
    if (this.tricksPlayed === 0) return null;
    if (this.trickCards.length === 0 || this.trickCards.length >= SEATS - this.foldedSeats.length) return null; // trick must be genuinely in progress - not empty, not already resolved
    const currentLeader = this._trickWinner();
    // No opener exclusion here - whoever currently holds the lead can be asked, including the
    // trick's own opener. The only thing that actually gates this is the "not during trick 1"
    // rule above and "must be an opponent of the leader" rule below.
    if (!currentLeader) return null;
    // Only an opponent of the current leader can ask - mirrors a real player noticing "their
    // team is sweeping everything, let's see if they'll commit to it" - not something a
    // teammate of the leader would ever want to bring up themselves.
    if (askerPos === undefined || askerPos === null || getTeam(currentLeader.pos) === getTeam(askerPos)) return null;
    if (!this._isQuoteEligibleCore(currentLeader.pos, true)) return null;
    // Bots are excluded on both sides - this offer (and the round-ending consequence of
    // declining it) is a human-vs-human mechanic. A bot can't be asked, and a bot can't ask.
    // Ghost-controlled seats (isBot:false, per explicit request) are excluded the same way -
    // there's no real client behind one to actually press the ask button or respond to being
    // asked, so treating it as eligible here would leave a real opponent's question waiting
    // for an answer that will never come.
    const askerSeat = this.seats[askerPos];
    if (!askerSeat || askerSeat.isBot || askerSeat.ghostPlayer) return null;
    const leaderSeat = this.seats[currentLeader.pos];
    if (!leaderSeat || leaderSeat.isBot || leaderSeat.ghostPlayer) return null;
    return currentLeader.pos;
  }

  // The manual "ask" action - a real player presses a button to send this question to whoever
  // currently holds the lead mid-trick, rather than the game deciding to pop it up on its own.
  // Reuses _getMidTrickAskTarget for the exact same validation the client's button visibility
  // is already based on, so a request can only ever succeed when the button would genuinely
  // have been lit up for this asker.
  requestMidTrickQuote(askerPos) {
    const targetPos = this._getMidTrickAskTarget(askerPos);
    if (targetPos === null) return false;
    this.pendingMidTrickQuote = { offeredToPos: targetPos, askedByPos: askerPos };
    const leaderSeat = this.seats[targetPos];
    const askerSeat = this.seats[askerPos];
    this.addLog(`${askerSeat.name} asked ${leaderSeat.name} to declare mid-trick COT/MaruCOT.`);
    this._notify();
    // Bug this fixes (from the earlier automatic version): without calling maybeAutoAct()
    // here too, if a genuine timing gap ever let this land on a bot, nothing would ever check
    // again - though _getMidTrickAskTarget already excludes bots entirely, so this call is
    // purely a defensive safety net now, not something that should ever actually fire.
    this.maybeAutoAct();
    return true;
  }

  // The mid-trick offer's response. Accepting behaves exactly like declareQuote() (play simply
  // resumes with quoteState now set, same stakes as always). Declining is NOT a no-op the way
  // it is when nobody gets asked at all - it ends the round immediately with a flat guaranteed
  // reward instead of playing out the rest of the round: see _endRoundByMidTrickDecline().
  respondToMidTrickQuote(pos, accepted) {
    if (!this.pendingMidTrickQuote || this.pendingMidTrickQuote.offeredToPos !== pos) return false;
    this.pendingMidTrickQuote = null;
    if (accepted) {
      this.quoteState = { team: getTeam(pos) };
      const seat = this.seats[pos];
      const isBidderTeam = getTeam(pos) === getTeam(this.bidder);
      this.addLog(`${seat ? seat.name : 'Seat ' + pos} declared ${isBidderTeam ? 'COT' : 'MaruCOT'} mid-trick — betting on a full sweep of all remaining tricks!`);
      this._notify();
      this.currentPlayer = this._nextActivePos(this.currentPlayer);
      this._notify();
      this.maybeAutoAct();
    } else {
      this.midTrickQuoteDeclinedThisTrick = true;
      this._endRoundByMidTrickDecline(pos);
    }
    return true;
  }

  // Declining the mid-trick offer: the round ends right there, no more tricks played, the bid
  // outcome (made/failed) is irrelevant. The declining player's team wins the round outright
  // with a flat, guaranteed reward - 1pt if they're the bidding team (the COT path), 2pt if
  // they're the defending team (the MaruCOT path). Deliberately smaller than a full COT/MaruCOT
  // payout (2/3 or 3/2) since this is the safe, guaranteed choice instead of the full gamble.
  _endRoundByMidTrickDecline(declinedByPos) {
    const bT = getTeam(this.bidder);
    const oT = 1 - bT;
    const declineTeam = getTeam(declinedByPos);
    const otherTeam = 1 - declineTeam;
    const declineTeamIsBidder = declineTeam === bT;
    const pts = declineTeamIsBidder ? 1 : 2;
    // Only the declining team's score increases now, matching the same rule applied to every
    // other scoring path in this file - see the normal-bid path in _endRound() for the full
    // reasoning behind dropping the other side's deduction.
    this.gameScore[declineTeam] += pts;
    const seat = this.seats[declinedByPos];
    this.roundWinnerAnnounced = {
      bidderWon: declineTeamIsBidder, made: true, bidder: this.bidder, highestBid: this.highestBid,
      teamPoints: this.teamPoints.slice(), pts, bidTeam: bT, isHonors: false,
      quote: false, quoteSuccess: undefined,
      midTrickDecline: true, declineTeam, declineTeamIsBidder, declinedByName: seat ? seat.name : ('Seat ' + declinedByPos)
    };
    this.phase = 'roundEnd';
    this.addLog(`Round ${this.round} over. ${seat ? seat.name : 'Seat ' + declinedByPos} declined the mid-trick offer — Team ${declineTeam} takes the round outright (+${pts}).`);
    this._finishRoundBookkeeping(bT, declineTeamIsBidder);
  }

  playHiddenTrump(pos) {
    if (this.phase !== 'play') return { ok: false, reason: 'not_playing' };
    if (pos !== this.currentPlayer || pos !== this.hiddenTrumpOwner) return { ok: false, reason: 'not_your_turn' };
    if (!this.hiddenTrump) return { ok: false, reason: 'no_hidden_card' };
    const card = this.hiddenTrump;
    // Same capture-before-clear fix as game-engine.js's identical path
    // -- exposeTrump() below has no visibility into the card once
    // hiddenTrump is cleared, since this path clears it first.
    this.revealedTrumpCard = { rank: card.rank, suit: card.suit };
    this.hiddenTrump = null; this.hiddenTrumpOwner = -1;
    if (this.mustPlayTrumpBy === pos) this.mustPlayTrumpBy = -1;
    if (!this.trumpExposed) this.exposeTrump();
    if (this.trickSuit === '') { this.trickSuit = card.suit; this.suitLeadCount[card.suit]++; }
    this.trickCards.push({ pos, card });
    this.addLog(`Seat ${pos} played the hidden trump ${card.rank}${card.suit}!`);
    this._validateCardIntegrity('playHiddenTrump, right after the hidden card enters the current trick');
    if (this.trickCards.length === SEATS - this.foldedSeats.length) this._resolveTrick();
    else { this.currentPlayer = this._nextActivePos(this.currentPlayer); this._notify(); this.maybeAutoAct(); }
    return { ok: true };
  }

  exposeTrump() {
    this.trumpExposed = true;
    this.addLog(`Trump exposed: ${this.trumpSuit}!`);
    if (this.hiddenTrump && this.hiddenTrumpOwner >= 0 && this.seats[this.hiddenTrumpOwner]) {
      // Same public-record capture as game-engine.js's identical
      // function -- see there for the full reasoning.
      this.revealedTrumpCard = { rank: this.hiddenTrump.rank, suit: this.hiddenTrump.suit };
      this.seats[this.hiddenTrumpOwner].hand.push(this.hiddenTrump);
      this.hiddenTrump = null;
      this.hiddenTrumpOwner = -1;
    }
    this._validateCardIntegrity('exposeTrump, right after returning the hidden card to its owner\'s hand');
  }

  // See game-engine.js for the full reasoning -- identical helper here,
  // except this table's cutoff is 2 cards left, not 3 -- confirmed
  // deliberately different from the 4-player table's threshold, not a
  // scaling mistake.
  // Split into a shared "core" (rules that apply no matter how the offer is reached) plus the
  // opener-only check layered on top, since the new mid-trick offer needs every rule EXCEPT
  // "must be the one leading the trick" - duplicating the other six checks in a second
  // function would just be the same list drifting out of sync over time.
  //
  // Per explicit follow-up: the hand.length<2 cutoff is now conditional on a new
  // relaxHandLengthCutoff param, defaulting to false so the ORIGINAL voluntary-declare path
  // (_isQuoteEligibleFor, called with no second argument) is completely unaffected — that one
  // stays exactly as it was, per explicit instruction that declaring is a different thing not
  // being touched here. Only the opponent-initiated mid-trick ASK path
  // (_getMidTrickAskTarget) passes true, so asking stays available for the rest of the round
  // once it's unlocked (tricksPlayed>0), all the way through the final tricks, not just until
  // the leader's hand gets down to 2 cards.
  _isQuoteEligibleCore(pos, relaxHandLengthCutoff) {
    if (pos === null || pos === undefined || !this.seats[pos]) return false;
    if (!relaxHandLengthCutoff && this.seats[pos].hand.length < 2) return false; // cutoff: must still have at least 2 cards of your own left
    if (relaxHandLengthCutoff && this.seats[pos].hand.length < 1) return false; // still needs at least a card actually in hand to mean anything
    if (this.quoteState) return false;
    if (this.phase !== 'play') return false;
    if (this.highestBid > 19) return false;
    if (this.pendingEarlyWinChoice) return false;
    return !!this.teamStillClean[getTeam(pos)];
  }
  _isQuoteEligibleFor(pos) {
    if (this.trickCards.length !== 0) return false; // only the trick's opener can declare this way
    return this._isQuoteEligibleCore(pos);
  }

  // See game-engine.js for the full reasoning -- identical helper here.
  _nextActivePos(p) {
    let n = nextPos(p);
    let guard = 0;
    while (this.foldedSeats.includes(n) && guard++ < SEATS) n = nextPos(n);
    return n;
  }

  _trickWinner() {
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
    // Per explicit report, same fix as the 4-player engine's identical
    // addition -- see there for the fuller reasoning. Checked before
    // trickSuit gets reset for the next trick elsewhere.
    if (this.trickSuit && winner.card.suit !== this.trickSuit) {
      this.suitsCutThisRound.add(this.trickSuit);
    }
    this.lastTrick = { cards: this.trickCards.slice(), winner: winner.pos, points, team };
    this.addLog(`Seat ${winner.pos} won the trick (+${points}pts).`);

    // Per-team clean tracking for Quote eligibility -- see
    // game-engine.js for the full reasoning, identical logic here.
    const bidTeamThisRound = getTeam(this.bidder);
    this.teamStillClean[1 - team] = false;

    if (this.trickSuit) {
      for (const tc of this.trickCards) {
        if (tc.card.suit !== this.trickSuit) this.voidSuits[tc.pos].add(this.trickSuit);
      }
    }
    for (const tc of this.trickCards) {
      const seatTc = this.seats[tc.pos];
      if (!seatTc || !seatTc.isBot) continue;
      brain.recordTrickOutcome(seatTc.name, { trickLen: this.trickCards.length }, tc.card, tc.pos === winner.pos, points);
      this.learningPulseCount++;
      this.lastLearningBotName = seatTc.name;
    }

    this.tricksPlayed++;
    this.playedCardsThisRound.push(...this.trickCards.map(tc => tc.card));
    this.trickCards = [];
    this.trickSuit = '';
    this.mustPlayTrumpBy = -1;
    this.midTrickQuoteDeclinedThisTrick = false; // a fresh trick gets a fresh chance to be offered

    // Quote resolution -- see game-engine.js for the full reasoning,
    // identical logic here: fails immediately on losing any trick,
    // success just falls through to the normal cardsLeft===0 ending.
    if (this.quoteState && team !== this.quoteState.team) {
      this._endRound();
      return;
    }

    // Thani resolution -- see game-engine.js for the full reasoning,
    // identical logic here: fails immediately the instant anyone other
    // than the caller wins a trick; success just falls through to the
    // normal cardsLeft===0 ending below.
    if (this.thaniCaller >= 0 && winner.pos !== this.thaniCaller) {
      this._endRound();
      return;
    }

    // Folded seats (Thani's teammates) never play a single card, so
    // their hands sit untouched, full, for the entire round -- counting
    // them here would mean this could never reach 0 even after every
    // ACTIVE player has played out their whole hand.
    const cardsLeft = this.seats.reduce((s, seat, i) => s + (seat && !this.foldedSeats.includes(i) ? seat.hand.length : 0), 0);
    if (cardsLeft === 0 && this.hiddenTrump) {
      this.currentPlayer = this.hiddenTrumpOwner;
      this._notify();
      this.maybeAutoAct();
    } else if (cardsLeft === 0) {
      this._endRound();
    } else if (this.thaniCaller >= 0) {
      // Thani has no early-win concept of its own -- see game-engine.js
      // for the full reasoning, identical here. The normal early-win
      // math below assumes a numeric highestBid<=28 (28-highestBid goes
      // negative once highestBid is Thani's 29 sentinel, breaking it
      // completely) -- skipping it here avoids that outright.
      this.currentPlayer = winner.pos;
      this._notify();
      this.maybeAutoAct();
    } else {
      // See game-engine.js for the full reasoning -- identical logic
      // here: early-win suppressed while the winning team (whichever
      // one it is) is still clean and their bid qualifies for Quote.
      const oT = 1 - bidTeamThisRound;
      const bidderClinched = this.teamPoints[bidTeamThisRound] >= this.highestBid;
      const defenseClinched = this.teamPoints[oT] > (28 - this.highestBid);
      const winningTeam = bidderClinched ? bidTeamThisRound : oT;
      const stillQuoteCandidate = this.teamStillClean[winningTeam] && this.highestBid <= 19;
      if (!stillQuoteCandidate && !this.earlyWinDeclined && (bidderClinched || defenseClinched)) {
        // Ghost-controlled seats can't answer this prompt either - see game-engine.js's
        // identical fix for the full reasoning (this branch returns without ever calling
        // maybeAutoAct(), so an incorrect check here would wait forever with nothing left to
        // ever re-check or resolve it).
        const hasHuman = Array.from({ length: SEATS }, (_, p) => p).some(p => getTeam(p) === winningTeam && this.seats[p] && !this.seats[p].isBot && !this.seats[p].ghostPlayer);
        if (hasHuman) {
          this.pendingEarlyWinChoice = { team: winningTeam, made: bidderClinched };
          this.currentPlayer = winner.pos;
          this._notify();
          return;
        }
        this._endRound();
        return;
      }

      this.currentPlayer = winner.pos;
      this._notify();
      this.maybeAutoAct();
    }
  }

  // See game-engine.js for the full reasoning -- identical logic here,
  // just using SEATS (6) instead of the 4-player game's hardcoded 4.
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

  declareQuote(pos) {
    if (pos !== this.currentPlayer) return false;
    if (!this._isQuoteEligibleFor(pos)) return false;
    this.quoteState = { team: getTeam(pos) };
    const seat = this.seats[pos];
    const isBidderTeam = getTeam(pos) === getTeam(this.bidder);
    this.addLog(`${seat ? seat.name : 'Seat ' + pos} declared ${isBidderTeam ? 'COT' : 'MaruCOT'} — betting on a full sweep of all 6 tricks!`);
    this._notify();
    return true;
  }

  _endRound() {
    this._validateCardIntegrity('_endRound, at the very start -- before this round\'s state gets reset for the next one');
    const bT = getTeam(this.bidder);
    const oT = 1 - bT;
    const isQuote = !!this.quoteState;
    const isThani = this.thaniCaller >= 0;
    let made, pts;
    if (isThani) {
      // See game-engine.js for the full reasoning -- identical logic
      // here. Thani's win condition is tricks, not points -- highestBid
      // was deliberately set to 29 (unreachable by points alone, max is
      // 28), so the normal teamPoints>=highestBid check could never be
      // true and isn't used here at all. By the time _endRound() runs
      // for a Thani round, _resolveTrick() has already guaranteed one of
      // exactly two things happened: either it early-failed the instant
      // anyone but the caller won a trick, or every single trick
      // (including this last one) went to the caller -- so simply
      // checking who won the most recent trick correctly tells us which.
      made = !!(this.lastTrick && this.lastTrick.winner === this.thaniCaller);
      pts = made ? 3 : 4;
      const isHonors = true;
      // Only the winning side's score ever changes now - the losing side keeps whatever
      // they'd already accumulated rather than having it reduced. See the matching comment
      // on the normal-bid path below for the full reasoning.
      if (made) { this.gameScore[bT] += pts; }
      else { this.gameScore[oT] += pts; }
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
      // See game-engine.js for the full reasoning -- identical logic
      // here. Scoring depends on which side declares: the bidding
      // team's own COT is +2/-3 (unchanged); the non-bidding team's
      // MaruCOT is +3/-2, a deliberately different risk/reward, not the
      // same numbers mirrored. No challenge mechanic anymore -- this
      // fully replaced the earlier "declare then the other team can
      // challenge" system.
      const cotTeam = this.quoteState.team;
      const otherTeam = 1 - cotTeam;
      const cotTeamIsBidder = cotTeam === bT;
      made = this.teamPoints[cotTeam] >= 28;
      if (cotTeamIsBidder) pts = made ? 2 : 3;
      else pts = made ? 3 : 2;
      const isHonors = this.highestBid >= 20;
      // Only the winning side gains now - see the normal-bid path below for the full
      // reasoning behind dropping the losing side's deduction.
      if (made) { this.gameScore[cotTeam] += pts; }
      else { this.gameScore[otherTeam] += pts; }
      this.roundWinnerAnnounced = {
        bidderWon: getTeam(this.bidder) === cotTeam ? made : !made,
        made, bidder: this.bidder, highestBid: this.highestBid,
        teamPoints: this.teamPoints.slice(), pts, bidTeam: bT, isHonors,
        quote: true, quoteSuccess: made, cotTeam, cotTeamIsBidder
      };
      this.phase = 'roundEnd';
      this.addLog(`Round ${this.round} over. ${cotTeamIsBidder ? 'COT' : 'MaruCOT'} ${made ? 'succeeded — full sweep!' : 'failed'} (${made ? '+' : '-'}${pts}).`);
      const bidderMadeIt = (getTeam(this.bidder) === cotTeam) ? made : !made;
      this._finishRoundBookkeeping(bT, bidderMadeIt);
      return;
    }
    made = this.teamPoints[bT] >= this.highestBid;
    if (this.highestBid >= 28) pts = made ? 3 : 4;
    else if (this.highestBid >= 20) pts = made ? 2 : 3;
    else pts = made ? 1 : 2;
    const isHonors = this.highestBid >= 20;
    // Only the winning team's score ever changes - a made bid adds to the bidding team, a
    // failed bid adds to the defending team, but nobody's existing total ever gets reduced
    // for losing. Previously this was zero-sum (the loser's score dropped by the same amount
    // the winner gained), which meant a team's own hard-earned points could get erased by a
    // later loss that had nothing to do with how they earned them.
    if (made) { this.gameScore[bT] += pts; }
    else { this.gameScore[oT] += pts; }
    this.roundWinnerAnnounced = {
      bidderWon: made, made, bidder: this.bidder, highestBid: this.highestBid,
      teamPoints: this.teamPoints.slice(), pts, bidTeam: bT, isHonors,
      quote: false, quoteSuccess: undefined
    };
    this.phase = 'roundEnd';
    this.addLog(`Round ${this.round} over. ${made ? 'Bid made' : 'Bid failed'} (+/-${pts}).`);
    this._finishRoundBookkeeping(bT, made);
  }

  // Shared tail end of _endRound() -- see game-engine.js for the full
  // reasoning. bT/made here are always BIDDER-centric.
  _finishRoundBookkeeping(bT, made) {
    // Q-mark removal: same rule as the 4-player game — personally
    // calling and winning a bid sheds one Q from yourself; on the very
    // first hand of a new match specifically, your partner sheds one
    // too (if they're carrying any). Self-only every hand after that.
    if (made) {
      const bidderSeat = this.seats[this.bidder];
      if (bidderSeat && this.qMarks[bidderSeat.name] > 0) {
        this.qMarks[bidderSeat.name]--;
        if (this.qMarks[bidderSeat.name] <= 0) delete this.qMarks[bidderSeat.name];
        this.addLog(`${bidderSeat.name} shed a Q by calling and winning the bid.`);
      }
      if (this.isFirstHandOfChampionship) {
        // No single "partner" here — teams are 3-a-side (even seats vs
        // odd seats), so the first-hand bonus generalizes to "every
        // teammate," not just one designated partner.
        const myTeam = getTeam(this.bidder);
        for (let i = 0; i < SEATS; i++) {
          if (i === this.bidder || getTeam(i) !== myTeam) continue;
          const teammateSeat = this.seats[i];
          if (teammateSeat && this.qMarks[teammateSeat.name] > 0) {
            this.qMarks[teammateSeat.name]--;
            if (this.qMarks[teammateSeat.name] <= 0) delete this.qMarks[teammateSeat.name];
            this.addLog(`${teammateSeat.name} also shed a Q — first hand of the match, teammate's bid came through.`);
          }
        }
      }
    }
    this.isFirstHandOfChampionship = false;

    for (let i = 0; i < SEATS; i++) {
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
    brain.saveBrains();

    // No championship/King meta-game in this variant — the match just ends outright the
    // moment either team reaches the target. Previously this also checked "<= 0" as an
    // equivalent trigger, which only worked because the old zero-sum scoring guaranteed
    // hitting the target on one side always meant the other was at exactly 0 (6+6=12,
    // always). Losing-side deductions are gone now (see the three _endRound() scoring
    // branches above), so scores only ever go up - the <=0 check is meaningless from here on
    // and is removed rather than left in as dead code that could misfire on a fresh 0-0 start.
    if (this.gameScore[0] >= 15 || this.gameScore[1] >= 15) {
      const winningTeam = this.gameScore[0] > this.gameScore[1] ? 0 : 1;
      const losingTeam = 1 - winningTeam;
      this.gameOver = { winningTeam, finalScore: this.gameScore.slice() };
      this.addLog(`Match over — team ${winningTeam} wins ${this.gameScore[winningTeam]}-${this.gameScore[1 - winningTeam]}.`);
      // Every player on the losing team picks up a Q at match end, regardless of their exact
      // final score - not restricted to a true zero-point shutout. An earlier version of this
      // only fired the Q on a genuine 0-score loss, reasoning that a close 12-15 finish isn't
      // really a "shutout" in the traditional sense - but that made the Q so rare under this
      // no-deduction scoring system that it stopped happening in practice at all, which is not
      // what was wanted. The Q is simply "you lost the match," full stop.
      for (let i = 0; i < SEATS; i++) {
        const s = this.seats[i];
        if (!s || getTeam(i) !== losingTeam) continue;
        this.qMarks[s.name] = (this.qMarks[s.name] || 0) + 1;
      }
      this.addLog(`Team ${losingTeam} lost the match — every player picks up a Q.`);
    }

    this._notify();
  }

  // ---------------- Bots ----------------

  maybeAutoAct() {
    // See game-engine.js for the full reasoning -- identical guard here.
    // If literally everyone on the winning team is now a bot or
    // disconnected (can change after the prompt was first shown),
    // auto-resolve with "keep playing" rather than risk the table
    // waiting forever for an answer that's never coming.
    if (this.pendingEarlyWinChoice) {
      const team = this.pendingEarlyWinChoice.team;
      // Ghost-controlled seats can't respond to this prompt either - see game-engine.js's
      // identical fix for the full reasoning.
      const stillHasHuman = Array.from({ length: SEATS }, (_, p) => p).some(p => getTeam(p) === team && this.seats[p] && !this.seats[p].isBot && !this.seats[p].ghostPlayer && this.seats[p].connected);
      if (!stillHasHuman) {
        const anyPosOnTeam = Array.from({ length: SEATS }, (_, p) => p).find(p => getTeam(p) === team);
        this.respondToEarlyWin(anyPosOnTeam, true);
      }
      return;
    }
    // Mid-trick COT/MaruCOT offer: bots are excluded entirely from ever being offered this
    // (see _checkMidTrickQuoteOffer), so pendingMidTrickQuote can only ever be set for a real
    // human now - this just makes sure maybeAutoAct() doesn't try to act on their behalf while
    // their response is still pending.
    if (this.pendingMidTrickQuote) return;
    const seat = this.seats[this.currentPlayer];
    if (!seat) return;
    if (this._turnTrackedPlayer !== this.currentPlayer || this._turnTrackedRound !== this.round) {
      this._turnTrackedPlayer = this.currentPlayer;
      this._turnTrackedRound = this.round;
      this.turnStartedAt = Date.now();
    }
    const turnAgeMs = Date.now() - (this.turnStartedAt || Date.now());
    const CONNECTED_BUT_STUCK_MS = 120000;
    // A ghost-player seat (admin-run, per explicit request) is deliberately kept isBot:false -
    // see game-engine.js's identical fix for the full reasoning.
    const isGhost = seat.ghostPlayer === true;
    const treatAsStuck = seat.isBot || isGhost || !seat.connected || turnAgeMs >= CONNECTED_BUT_STUCK_MS;
    if (treatAsStuck) {
      const capturedPos = this.currentPlayer;
      const capturedRound = this.round;
      const capturedTurnStartedAt = this.turnStartedAt;
      // Bots pace themselves at a natural ~900ms. A disconnected HUMAN
      // seat gets a much longer grace window before a bot steps in for
      // them — 10s turned out to be too tight: a brief mobile network
      // blip (tunnel, elevator, a few seconds of spotty signal) can flip
      // a seat to disconnected, and since this timer isn't reset on
      // reconnect (only re-checked once, right when it fires), someone
      // who reconnects with only a couple seconds left doesn't get a
      // real chance to notice and act before the bot takes over anyway.
      // A seat already past the connected-but-stuck threshold has used
      // up its grace period - act promptly instead of waiting a fresh 35s.
      const delay = seat.isBot ? 900
        : isGhost ? (2000 + Math.floor(Math.random() * 4000))
        : (turnAgeMs >= CONNECTED_BUT_STUCK_MS ? 900 : 35000);
      setTimeout(() => {
        if (this.round !== capturedRound) return;
        if (this.currentPlayer !== capturedPos) return;
        const seatNow = this.seats[capturedPos];
        if (!seatNow) return;
        // Real bug fix, per explicit report: this re-check used to
        // compare against capturedTurnStartedAt -- a value frozen the
        // moment THIS timer was scheduled. If the player reconnected
        // (or otherwise had their turn genuinely resume) any time after
        // that but before this timeout fired, markConnected() resets
        // the LIVE this.turnStartedAt correctly, but this already-
        // in-flight timeout had no way to know that -- it kept using
        // its own frozen snapshot from before the reset, so it still
        // concluded "still stuck" and handed the turn to a bot anyway,
        // regardless of how promptly the player actually came back.
        // Reading this.turnStartedAt live here instead means a reset
        // that happens at any point before this fires is actually
        // honored, not silently ignored by a stale closure.
        const stillStuck = seatNow.isBot || seatNow.ghostPlayer === true || !seatNow.connected || (Date.now() - (this.turnStartedAt || Date.now())) >= CONNECTED_BUT_STUCK_MS;
        if (!stillStuck) return;
        this._botAct(capturedPos);
      }, delay);
      // Per explicit bug report: a bot's turn was observed getting
      // skipped entirely in live play with real + bot players mixed --
      // the seat's own turn-order tracking was later confirmed correct
      // (the engine still correctly returned to that seat once its
      // team's other members had acted, since it had genuinely never
      // recorded any action for them), which points to the ~900ms timer
      // above simply never firing or getting raced out by something
      // else changing currentPlayer in that same window, not a flaw in
      // whose turn it is. Rather than guess at the exact race without
      // being able to reproduce it, this adds a second, independent
      // safety check a few seconds later: if it's STILL that bot's
      // uncompleted turn by then, retry via maybeAutoAct() itself
      // (not a direct _botAct call), so it goes through every one of
      // the normal guards again with a fresh view of the current state,
      // rather than assuming the original captured values still apply.
      if (seat.isBot) {
        const watchdogPos = this.currentPlayer;
        const watchdogRound = this.round;
        setTimeout(() => {
          if (this.round !== watchdogRound) return;
          if (this.currentPlayer !== watchdogPos) return;
          const seatNow = this.seats[watchdogPos];
          if (!seatNow || !seatNow.isBot) return;
          this.addLog(`[bot-watchdog] Seat ${watchdogPos} still hadn't acted after 3s -- retrying.`);
          this.maybeAutoAct();
        }, 3000);
      }
    }
  }

  _botAct(pos) {
    try {
      this._botActInner(pos);
    } catch (e) {
      console.error(`[bot-safety] _botAct threw for seat ${pos} in phase ${this.phase} (round ${this.round}) - falling back to a safe default action:`, e && e.stack || e);
      try {
        if (this.phase === 'bidding1' && this.currentPlayer === pos) {
          const bid = this.isFirstBidder(pos) ? 16 : 0;
          const result = this.placeBid(pos, bid);
          if (!result.ok) this.placeBid(pos, 0);
        } else if (this.phase === 'choosingTrump' && this.currentPlayer === pos) {
          this.chooseTrump(pos, SUITS[0], null);
        } else if (this.phase === 'play' && this.currentPlayer === pos) {
          const hand = this.seats[pos].hand;
          if (hand.length === 0 && this.hiddenTrump && pos === this.hiddenTrumpOwner) {
            this.playHiddenTrump(pos);
          } else {
            const legal = hand.find(c => this.canPlayCard(pos, c).ok);
            if (legal) this.playCard(pos, legal);
          }
        }
      } catch (e2) {
        console.error(`[bot-safety] fallback action ALSO threw for seat ${pos}:`, e2 && e2.stack || e2);
      }
    }
  }

  _botActInner(pos) {
    if (this.phase === 'bidding1' && this.currentPlayer === pos) {
      const b = brain.getBrain(this.seats[pos].name);
      const hand = this.seats[pos].hand;
      const first = this.isFirstBidder(pos);
      const minBid = this.highestBid > 0 ? this.highestBid + 1 : 16;
      // Per explicit instruction: the old continuous EV/comfort-
      // threshold system below this point is replaced entirely by the
      // explicit table in _tableBid -- see that method for the full,
      // confirmed rule set. Thani is handled as an immediate bypass
      // here, before any of the numeric bid-submission logic further
      // down even runs, since it's a fundamentally different action
      // (its own dedicated method) rather than a number on the same
      // 16-28 scale the rest of this function works with.
      const tableBid = this._tableBid(hand);
      if (tableBid.isThani && this.isThaniOption()) {
        this.callThani(pos);
        return;
      }
      let target = tableBid.bidValue;

      // Partner bidding signal from last round -- same rule as the
      // 4-player game, just sent to ALL teammates at once here since
      // teams are 3-a-side, not a single designated partner. "lower" is
      // applied later as a hard cap (see below, after the partner-
      // support bonus) rather than here, so the bonus can't quietly
      // walk the target back up past what was explicitly asked for.
      const wantsLower = this.partnerSignals[pos] && this.partnerSignals[pos].forRound === this.round &&
        this.partnerSignals[pos].signal === 'lower';
      if (this.partnerSignals[pos] && this.partnerSignals[pos].forRound === this.round) {
        const sig = this.partnerSignals[pos].signal;
        if (sig === 'higher') target = Math.min(28, target + 3);
      }

      let pb = 0;
      if (this.bidder >= 0 && getTeam(this.bidder) === getTeam(pos)) pb = 1 * b.bidWeights.partnerSupport;
      target = Math.min(28, Math.round(target + pb));

      // Deliberate last word on this bid - see the 4-player game's
      // identical comment for the full reasoning.
      if (wantsLower) target = Math.min(target, 18);

      let bid = 0;
      if (first) {
        bid = Math.max(16, Math.min(target, 22));
      } else if (minBid <= target && minBid <= 28) {
        bid = minBid <= target - 2 ? minBid + 1 : minBid;
      }
      if (first && bid === 0) bid = 16;
      // Per explicit instruction: once a bot's own partner is already
      // the high bidder at honors level (20+), placeBid() now only
      // accepts exactly 28 as a numeric raise (Thani is the other
      // option, handled entirely separately below via
      // isThaniOption()/callThani). Without this, a bot computing some
      // intermediate target like 22 here would have that bid rejected
      // and silently fall back to passing even on a hand strong enough
      // to reasonably push to 28 -- clamp up to 28 specifically when
      // the bot's own target was already high enough to suggest real
      // confidence, rather than always collapsing to a pass.
      if (!first && this.bidder >= 0 && getTeam(this.bidder) === getTeam(pos) && this.highestBid >= 20 && bid !== 0 && bid !== 28) {
        bid = target >= 24 ? 28 : 0;
      }

      const result = this.placeBid(pos, bid);
      if (!result.ok) this.placeBid(pos, 0);
      delete this.partnerSignals[pos]; // one-shot: consumed the moment this seat actually bids
    } else if (this.phase === 'choosingTrump' && this.currentPlayer === pos) {
      const hand = this.seats[pos].hand;
      const bySuit = {};
      for (const s of SUITS) bySuit[s] = [];
      for (const c of hand) bySuit[c.suit].push(c);
      let bestSuit = SUITS[0], bestLen = -1;
      for (const s of SUITS) if (bySuit[s].length > bestLen) { bestLen = bySuit[s].length; bestSuit = s; }
      this.chooseTrump(pos, bestSuit, null);
    } else if (this.phase === 'play' && this.currentPlayer === pos) {
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
      const isLast = this.trickCards.length === SEATS - 1;

      if (!hasSuit && !this.trumpExposed && this.trickSuit !== '' && trumps.length >= 0) {
        let callTrumpNow = false;
        // None of these reasons justify exposing trump and cutting in if our OWN partner
        // already has this trick won for free - pure waste of a trump card and revealed
        // information for nothing.
        if (wt !== myTeam) {
          if (pos === this.bidder) callTrumpNow = true;
          // Per explicit request: the very first time a suit gets led, cut in regardless of
          // whether this particular trick happens to be carrying any points yet - even with
          // nothing better than a zero-point 6 of trump. Waiting for "worth it" points to
          // show up before ever committing trump was leaving opponents free to run a suit
          // the bot is void in without ever being contested early, which is worse for the
          // team than spending a cheap trump now (see the zeroPt preference below - this
          // never actually costs a valuable trump card, just commits to *a* cut happening).
          // The two-tier "first time always, second+ time needs a reason" split below this
          // is deliberate, not an oversight - see the next two conditions for how a repeat
          // lead of the same suit is judged differently (needs actual value on the table or
          // real trump strength in hand, not just "it's this suit again").
          else if ((this.suitLeadCount[this.trickSuit] || 0) === 1) callTrumpNow = true;
          else if (isLast && tPts > 0) callTrumpNow = true;
          else if (tPts >= 2) callTrumpNow = true;
          else if ((this.suitLeadCount[this.trickSuit] || 0) >= 2 && tPts >= 1) callTrumpNow = true;
          else if (trumps.some(t => t.rank === 'J' || t.rank === '9')) callTrumpNow = true;
          else if (this.trickCards.some(tc => tc.card.points > 0 || tc.card.rank === 'J' || tc.card.rank === '9')) callTrumpNow = true;
        } else if (!isLast && cwc.suit === this.trickSuit && this._higherCardOfSuitStillOut(this.trickSuit, cwc.rank)) {
          // Partner is currently winning WITH A PLAIN CARD OF THE LED SUIT (not already a
          // trump cut themselves - overcutting your own partner's trump is a different,
          // generally bad idea and not what this covers) - but not necessarily safely. If
          // some player still to act could still be holding a plain card of the led suit
          // that beats our partner's, sitting on our hands (discarding, "trusting" the
          // partner) is a real gamble, not free money. Cut it in to actually secure the
          // trick instead of hoping nobody still holds the one card that beats it. isLast is
          // excluded on purpose - if this is genuinely the trick's last card, nobody else is
          // left to act, so the "still out there" card can only be sitting harmlessly in a
          // hand that will never get a turn to play it into THIS trick.
          callTrumpNow = true;
        }
        if (callTrumpNow) {
          this.exposeTrump();
          if (trumps.length > 0) {
            trumps.sort((a, c) => RANK_ORDER[c.rank] - RANK_ORDER[a.rank]);
            // Always a FIRST cut — any trump we hold wins this outright,
            // so reflexively playing our best one (often the Jack) is
            // pure waste when a King or 7 would win it just as well.
            const zeroPt = trumps.filter(c => c.points === 0);
            let cutCard = zeroPt.length > 0 ? zeroPt[zeroPt.length - 1] : trumps[trumps.length - 1];
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
      const chosen = this._chooseBotCard(pos, hand, myTeam, isBT, isLast, wt, cwc, tPts);
      this.playCard(pos, chosen);
    }
  }

  _cardsSeenSoFar() { return this.playedCardsThisRound.concat(this.trickCards.map(tc => tc.card)); }

  // Per explicit request: a real integrity check, not just a comment
  // claiming things are fine -- sums every location a card can
  // legitimately be at any moment (a player's hand, the hidden-trump
  // holding spot, the current unresolved trick, and every card already
  // collected from finished tricks this round) and confirms the total
  // is exactly the full 36-card set with no duplicates and nothing
  // missing. Doesn't throw or interrupt play -- logs a clear, specific
  // error so a real problem is immediately visible and debuggable
  // instead of silently corrupting a deal, without turning a caught bug
  // into a second, louder bug of its own (a thrown exception here mid-
  // game would crash the table outright, which is worse than a logged
  // warning for something that should never happen but needs to be
  // caught if it somehow does).
  _validateCardIntegrity(where) {
    const all = [];
    for (const seat of this.seats) if (seat) all.push(...seat.hand);
    if (this.hiddenTrump) all.push(this.hiddenTrump);
    all.push(...this.trickCards.map(tc => tc.card));
    all.push(...this.playedCardsThisRound);
    const key = c => c.suit + c.rank;
    const keys = all.map(key);
    const uniqueKeys = new Set(keys);
    const ok = all.length === 36 && uniqueKeys.size === 36;
    if (!ok) {
      const counts = {};
      for (const k of keys) counts[k] = (counts[k] || 0) + 1;
      const duplicates = Object.keys(counts).filter(k => counts[k] > 1);
      const fullDeckKeys = new Set();
      for (const s of SUITS) for (const r of RANKS) fullDeckKeys.add(s + r);
      for (const s of SUITS) fullDeckKeys.add(s + '6');
      const missing = [...fullDeckKeys].filter(k => !uniqueKeys.has(k));
      console.error(`[card integrity FAILED at ${where}] total=${all.length} (expected 36), unique=${uniqueKeys.size}, duplicates=${JSON.stringify(duplicates)}, missing=${JSON.stringify(missing)}`);
    }
    return ok;
  }
  _isRankSeen(suit, rank) { return this._cardsSeenSoFar().some(c => c.suit === suit && c.rank === rank); }
  // Is there still a card of `suit` ranked higher than `aboveRank` that hasn't been played yet
  // this round? Used specifically for the "should I cut in even though my partner is
  // currently winning" decision - the bot has none of this suit itself (that's the only way
  // it's even considering a cut), so any unseen card of this suit can only be sitting in some
  // other player's hand, not its own - a genuine live threat to the partner's lead, not a
  // false alarm from a card the bot happens to be holding.
  _higherCardOfSuitStillOut(suit, aboveRank) {
    const aboveOrder = RANK_ORDER[aboveRank];
    return RANKS.some(r => RANK_ORDER[r] > aboveOrder && !this._isRankSeen(suit, r));
  }

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

  // Same leading/following/trumping strategy as the 4-player engine's
  // _chooseBotCardBase (Jack preservation, point-aware trump usage, void
  // tracking) — see game-engine.js for the full reasoning on each piece.
  _chooseBotCard(pos, hand, myTeam, isBT, isLast, wt, cwc, tPts) {
    const isBidder = pos === this.bidder;
    // Bid-target awareness -- same as the 4-player engine, see there for
    // the full reasoning. Total points remain 28 even with this
    // variant's 36-card deck (the extra 6s are all worth 0), so these
    // constants transfer directly unchanged.
    const myTeamTarget = isBT ? this.highestBid : (29 - this.highestBid);
    const myTeamNeeds = myTeamTarget - this.teamPoints[myTeam];
    const pointsRemainingInPlay = 28 - this.teamPoints[0] - this.teamPoints[1];
    const myTeamDesperate = myTeamNeeds > 0 && pointsRemainingInPlay > 0 && myTeamNeeds >= pointsRemainingInPlay * 0.7;
    const myTeamSecured = myTeamNeeds <= 0 && !this.quoteState;
    if (this.trickSuit === '') {
      const isEarly = this.tricksPlayed < 2; // 6 tricks total this variant, not 8
      const bySuit = {};
      for (const s of SUITS) bySuit[s] = [];
      for (const c of hand) bySuit[c.suit].push(c);
      // Per explicit bug report: this whole "bidder leading before trump
      // exposure" branch right below used to run BEFORE any Jack/9
      // safety check at all -- it picks the longest non-trump suit and
      // returns its low/high card completely blindly, with a `return`
      // that exits before ever reaching the checks further down. A bot
      // in this exact situation could lead a lone 9 with its Jack still
      // unseen, or skip a Jack it was actually holding, with nothing in
      // this specific code path stopping either. Moved the same
      // uncut-Jack priority check up here, ahead of that branch, so it
      // applies universally to every way a lead can happen, not just
      // the ones that fall through to the main per-suit loop below.
      const uncutJackSuits = SUITS.filter(s =>
        bySuit[s].some(c => c.rank === 'J') && !this.suitsCutThisRound.has(s)
      );
      if (uncutJackSuits.length > 0) {
        uncutJackSuits.sort((a, b) => bySuit[b].length - bySuit[a].length);
        return bySuit[uncutJackSuits[0]].find(c => c.rank === 'J');
      }
      if (!this.trumpExposed && isBidder) {
        const nt = hand.filter(c => c.suit !== this.trumpSuit);
        if (nt.length > 0) {
          const ntBySuit = {};
          for (const s of SUITS) ntBySuit[s] = [];
          for (const c of nt) ntBySuit[c.suit].push(c);
          // Per explicit bug report: this used to always pick the
          // single longest non-trump suit with no regard at all for
          // what card that would actually mean leading -- a bot could
          // end up leading a lone 9 with its Jack still unseen (or an
          // Ace/10 with J/9 unseen) just because that suit happened to
          // be the longest one available. Now checks EVERY non-trump
          // suit, longest first, and skips any whose lead card would
          // violate the same safety rules used everywhere else in this
          // function, rather than blindly committing to the first
          // (longest) one regardless of content.
          const suitsByLength = SUITS.filter(s => ntBySuit[s].length > 0)
            .sort((a, b) => ntBySuit[b].length - ntBySuit[a].length);
          for (const s of suitsByLength) {
            const sorted = [...ntBySuit[s]].sort((a, c) => RANK_ORDER[a.rank] - RANK_ORDER[c.rank]);
            const candidate = isEarly ? sorted[0] : sorted[sorted.length - 1];
            const jSeenHere = this._isRankSeen(s, 'J');
            const nineSeenHere = this._isRankSeen(s, '9');
            const unsafe = (candidate.rank === '9' && !jSeenHere) ||
              ((candidate.rank === 'A' || candidate.rank === '10') && (!jSeenHere || !nineSeenHere));
            if (!unsafe) return candidate;
          }
        }
      }
      // Per explicit instruction: same rule as the 4-player engine's
      // identical addition -- see there for the fuller reasoning. One
      // real structural difference handled here: 4-player has an
      // earlier, separate "holds a leadable Jack" absolute return
      // before this point, so reaching here already guarantees no Jack
      // is available. 6-player doesn't have that same early return (its
      // Jack-leading happens naturally within the per-suit scoring loop
      // below instead), so this must explicitly check for a leadable
      // Jack itself -- without that check, this new rule would fire
      // even when the bot DOES hold a Jack it should lead instead,
      // exactly the case this whole rule is meant to only apply once
      // that's no longer true.
      if (this.trumpExposed && !isBidder && getTeam(this.bidder) === myTeam) {
        const holdsLeadableJack = SUITS.some(s => bySuit[s].some(c => c.rank === 'J') && (s !== this.trumpSuit || this.trumpExposed));
        if (!holdsLeadableJack) {
          const nonAceTrumps = hand.filter(c => c.suit === this.trumpSuit && c.rank !== 'A');
          if (nonAceTrumps.length > 0) {
            nonAceTrumps.sort((a, c) => RANK_ORDER[a.rank] - RANK_ORDER[c.rank]);
            return nonAceTrumps[0];
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
        let voidOpponentPenalty = 0;
        for (let p = 0; p < SEATS; p++) {
          if (p === pos || getTeam(p) === myTeam) continue;
          if (this.voidSuits[p].has(s)) { voidOpponentPenalty = this.trumpExposed ? 20 : 10; break; }
        }
        // The flip side: a PARTNER known to be void in this suit can
        // trump straight in and win it for the team once trump is
        // exposed — leading into that is a genuine team tactic ("what
        // can my partner cut"), not just a read on this bot's own hand.
        // Per explicit follow-up: also worth doing BEFORE trump is
        // exposed, but only when that void partner specifically is
        // this.hiddenTrumpOwner (always the bidder -- see chooseTrump)
        // -- they're the one and only player who can act on this
        // pre-exposure at all, via playHiddenTrump(), since every other
        // seat genuinely doesn't know the trump suit yet. Extending this
        // bonus to a non-bidder partner pre-exposure would have the bot
        // acting on information it has no legitimate way to know.
        let partnerVoidBonus = 0;
        for (let p = 0; p < SEATS; p++) {
          if (p === pos || getTeam(p) !== myTeam) continue;
          if (this.voidSuits[p].has(s) && (this.trumpExposed || p === this.hiddenTrumpOwner)) { partnerVoidBonus = 18; break; }
        }
        let sc = -voidOpponentPenalty + partnerVoidBonus;
        if (isEarly) {
          if (low.rank === 'J' || low.rank === '9') {
            // Given RANK_ORDER, low.rank can only be '9' with more than
            // one card in the suit by holding J+9 together (the
            // strongest possible holding in a suit) -- previously
            // scored as barely more than a generic length bonus,
            // undervaluing it against a merely-safe short suit with no
            // real strength. Matches the same +60 baseline given a bare
            // Jack below -- holding the 9 alongside it is worth at
            // least as much. Same fix as the 4-player engine.
            if (bySuit[s].length > 1) { candidates.push({ card: bySuit[s][1], score: 60 + bySuit[s].length * 5 - voidOpponentPenalty + partnerVoidBonus, suit: s }); continue; }
            // A lone 9 with no second card of that suit to lead instead.
            // Per explicit instruction, this is now an absolute "never" —
            // not a steep score penalty that a sufficiently bad hand
            // could still lose out to, an outright exclusion from the
            // candidates this bot will even consider leading, whenever
            // the Jack of this suit hasn't been played yet this round.
            // Skips straight to the next suit rather than pushing this
            // one onto candidates at all.
            if (low.rank === '9' && !jSeen) continue;
          }
          // Per explicit instruction, extending the same "never" rule to
          // the Ace and 10 -- the next two highest point-carrying ranks
          // after J/9 (see RANK_ORDER: J=8, 9=7, A=6, 10=5). Leading
          // either one while BOTH the 9 and J of this suit are still
          // unaccounted for risks losing it the exact same way leading a
          // lone 9 does. Deliberately requires both to be unseen, not
          // either -- once even one of the two bigger cards is out, the
          // risk this rule exists to prevent has already passed. A
          // separate check from the J/9 block above (not merged into
          // it), since this one triggers on a different low.rank value
          // entirely and has no "J+9 together" special case to share.
          if ((low.rank === 'A' || low.rank === '10') && (!jSeen || !nineSeen)) continue;
          sc += bySuit[s].length * 5;
          if (low.points === 0) sc += 20;
          if (low.rank === '7' || low.rank === '8' || low.rank === '6') sc += 15;
          if (high.points > 0) sc -= 10;
          if (s === this.trumpSuit) sc -= 30;
          candidates.push({ card: low, score: sc, suit: s });
        } else {
          if (iHoldJ) {
            candidates.push({ card: bySuit[s].find(c => c.rank === 'J'), score: 60 + bySuit[s].length * 3 - voidOpponentPenalty, suit: s });
            continue;
          }
          if (iHold9) {
            if (jSeen) {
              candidates.push({ card: bySuit[s].find(c => c.rank === '9'), score: 45 + bySuit[s].length * 3 - voidOpponentPenalty, suit: s });
              continue;
            }
            // Per explicit instruction, an absolute "never" -- same as
            // the early-game branch above (see there for the fuller
            // reasoning). Given RANK_ORDER, iHoldJ was already ruled out
            // just above, so holding a 9 here always means it's this
            // suit's `high` card -- the exact card that would otherwise
            // get pushed as a candidate right below. Skip the suit
            // entirely instead.
            continue;
          }
          // Per explicit instruction, upgraded from a -15 score penalty
          // to an absolute "never" -- matches the same fix already
          // applied to the early-trick branch above for the exact same
          // reason (a steep penalty can still lose out to a
          // sufficiently bad hand; an outright exclusion can't).
          if ((high.rank === 'A' || high.rank === '10') && (!jSeen || !nineSeen)) continue;
          sc += bySuit[s].reduce((a, c) => a + c.points, 0) * 10 + bySuit[s].length * 3;
          if (s === this.trumpSuit) sc -= 10;
          candidates.push({ card: high, score: sc, suit: s });
        }
      }
      candidates.sort((a, c) => c.score - a.score);
      if (candidates.length > 0) return candidates[0].card;
      // Real edge-case bug found and fixed: this fallback only runs
      // when every suit got excluded above (typically because every
      // remaining suit's lead would be a 9 with its Jack unseen) --
      // but it used to pick straight from RANK_ORDER across the WHOLE
      // hand with no awareness of that exclusion at all, meaning a
      // hand like [9,10] of a single suit would have its 9 correctly
      // excluded by the main loop above, only for this fallback to
      // turn right around and pick that same 9 anyway (9 outranks 10
      // in RANK_ORDER, so hand[hand.length-1] was the 9 specifically).
      // Filter out any 9 whose suit's Jack hasn't been seen first, and
      // only fall through to a literal last-resort (that 9 really is
      // the only card left at all) if nothing else remains.
      // Per explicit instruction, extending this same fallback
      // protection to the new Ace/10 restriction above -- without this,
      // a hand where every suit got excluded from the main loop could
      // have this same fallback turn around and pick an Ace or 10 that
      // violates the exact rule that excluded it in the first place,
      // the same category of bug the 9-specific filter below already
      // exists to prevent.
      const safeHand = hand.filter(c =>
        !(c.rank === '9' && !this._isRankSeen(c.suit, 'J')) &&
        !((c.rank === 'A' || c.rank === '10') && (!this._isRankSeen(c.suit, 'J') || !this._isRankSeen(c.suit, '9')))
      );
      const pool = safeHand.length > 0 ? safeHand : hand;
      pool.sort((a, c) => RANK_ORDER[a.rank] - RANK_ORDER[c.rank]);
      return isEarly ? pool[0] : pool[pool.length - 1];
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
          // Same fix as the 4-player engine: don't automatically spend
          // the 9 to win a small trick when the Jack of this suit hasn't
          // been seen yet and someone still acts after us -- that's
          // exactly the "wins the trick, then a later Jack steals it
          // back for nothing" mistake. Safe once it's the last word,
          // the Jack's accounted for, or the trick's worth the risk.
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
      // Can't beat what's on the table. If partner is currently winning,
      // feeding a point card is only genuinely free value once the
      // trick is actually secure -- if someone still acts after us and
      // this suit's Jack hasn't been seen, a later opponent could still
      // steal the trick with it, handing our fed points to them instead
      // of our own team. Same jackRisk concept and tPts>=3 override
      // already used for the 9-lead case above. Same fix as the
      // 4-player engine.
      // Same myTeamSecured skip as the 4-player engine's equivalent.
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
    // Same fix as the 4-player table's engine: having personally asked
    // for trump to be opened, this bot owes a trump card this trick if
    // holding one — a flat rule, not weighed against trick value or who's
    // winning. See game-engine.js for the full reasoning.
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
      const suitRepeat = this.suitLeadCount[this.trickSuit] || 0;
      // Per explicit instruction: a bot void in the led suit should
      // always cut with a trump if holding one, regardless of the
      // trick's value -- UNLESS this suit has already been led before
      // this round (suitRepeat >= 2, i.e. this is its second-or-later
      // opening) or the J or 9 of it has already been played, in which
      // case the situational judgment below (trick value, position,
      // etc.) still applies same as before. This replaces the previous
      // firstTimeSuitLed-only trigger, which forced a cut on a suit's
      // first lead even once its J/9 were already accounted for --
      // exactly the case this new rule's exception is meant to exempt.
      const jOrNineSeenInTrickSuit = this._isRankSeen(this.trickSuit, 'J') || this._isRankSeen(this.trickSuit, '9');
      const mustTrumpRegardless = suitRepeat < 2 && !jOrNineSeenInTrickSuit;
      const worthTrumping = mustTrumpRegardless || tPts >= (myTeamDesperate ? 1 : 2) || isLast || (isBidder && tPts >= 1) || (suitRepeat >= 2 && tPts >= 1);
      if (trumpWinning && wt !== myTeam && worthTrumping) {
        let wtr;
        if (cwc && cwc.suit === this.trumpSuit) {
          // Over-cutting another trump that's currently winning — find the
          // minimal trump that still beats it, not necessarily our best.
          wtr = trumps[0];
          for (let i = trumps.length - 1; i >= 0; i--) {
            if (RANK_ORDER[trumps[i].rank] > RANK_ORDER[cwc.rank]) { wtr = trumps[i]; break; }
          }
          // The minimal sufficient trump is only safe if no one still to
          // act in this trick can hold a bigger one — in practice, whether
          // the trump Jack is still unaccounted for. Spending our only
          // realistic winner into a trick a live Jack can still take away
          // is exactly the waste this was meant to avoid.
          if (!isLast && !this._isRankSeen(this.trumpSuit, 'J') && wtr.rank !== 'J' && tPts >= 3) {
            wtr = trumps[0];
          }
        } else {
          // The FIRST cut in this trick — nothing on the table is trump
          // yet, so literally any trump wins it. Reflexively reaching for
          // our best trump (often the Jack) to win a trick a King or 7
          // would have won exactly as well is a real, common waste. Use
          // the cheapest trump we have, preferring a zero-point one.
          // Real bug fix, per explicit report: this branch was missing
          // the explicit nonJackTrumps exclusion the 4-player engine's
          // identical branch already has -- it only filtered by
          // zero-point value, with no separate safeguard keeping the
          // Jack specifically off the table whenever any other trump
          // (zero-point or not) was available instead. Matches
          // game-engine.js's own logic now.
          const nonJackTrumps = trumps.filter(c => c.rank !== 'J');
          const zeroPt = nonJackTrumps.filter(c => c.points === 0);
          wtr = zeroPt.length > 0 ? zeroPt[zeroPt.length - 1]
            : nonJackTrumps.length > 0 ? nonJackTrumps[nonJackTrumps.length - 1]
            : trumps[trumps.length - 1];
        }
        return wtr;
      }
      // Not spending trump to win this one — most commonly because our
      // OWN partner is already winning it (wt === myTeam), where cutting
      // in over our own teammate would just waste a trump for nothing. A
      // trump card is not automatically the right thing to throw away
      // just because we're void in the led suit — a non-trump discard
      // (ideally a point card, feeding our own partner the same way the
      // follow-suit logic above does) preserves trump for later.
      const nonTrumpDiscard = hand.filter(c => c.suit !== this.trumpSuit);
      if (nonTrumpDiscard.length > 0) {
        const feedablePts = nonTrumpDiscard.filter(c => c.points > 0 && c.rank !== 'J' && c.rank !== '9');
        // Same myTeamSecured skip as the 4-player engine's equivalent.
        if (wt === myTeam && !myTeamSecured && feedablePts.length > 0) {
          feedablePts.sort((a, c) => c.points - a.points);
          return feedablePts[0];
        }
        // Per explicit instruction: when discarding (not cutting, not
        // feeding partner), actively look for a discard that VOIDS a
        // suit entirely -- this is the bot's own last card of that
        // suit -- since being void sets up cutting that suit with
        // trump the next time it's led. Worth spending up to a 1-point
        // card (a 10 or an Ace) to buy that future cutting opportunity;
        // deliberately excludes the 9 and J (2/3 points) even if one of
        // those happens to be the last card of a suit too, since
        // sacrificing that much value for a maybe-later cut isn't the
        // same trade. Checked before the plain lowest-point sort below,
        // since a targeted void is worth more than just being cheap.
        const suitCounts = {};
        for (const c of hand) suitCounts[c.suit] = (suitCounts[c.suit] || 0) + 1;
        const voidCandidates = nonTrumpDiscard.filter(c => suitCounts[c.suit] === 1 && c.points <= 1);
        if (voidCandidates.length > 0) {
          voidCandidates.sort((a, c) => a.points - c.points);
          return voidCandidates[0];
        }
        nonTrumpDiscard.sort((a, c) => a.points !== c.points ? a.points - c.points : RANK_ORDER[a.rank] - RANK_ORDER[c.rank]);
        return nonTrumpDiscard[0];
      }
      return trumps[trumps.length - 1]; // genuinely nothing else left to throw
    }

    if (!this.trumpExposed && trumps.length > 0 && this.trickSuit !== this.trumpSuit) {
      // Same reasoning as elsewhere: trump isn't exposed yet, so any
      // trump card wins this trick outright - reflexively grabbing the
      // highest one (often the Jack) is unnecessary waste, not a
      // special case just because exposing trump is also happening here.
      const cutForWin = (isLast && wt !== myTeam && tPts >= 2) || (isBidder && wt !== myTeam && tPts >= 3);
      if (cutForWin) {
        trumps.sort((a, c) => RANK_ORDER[c.rank] - RANK_ORDER[a.rank]);
        const nonJackTrumps = trumps.filter(c => c.rank !== 'J');
        const zeroPt = nonJackTrumps.filter(c => c.points === 0);
        return zeroPt.length > 0 ? zeroPt[zeroPt.length - 1]
          : nonJackTrumps.length > 0 ? nonJackTrumps[nonJackTrumps.length - 1]
          : trumps[trumps.length - 1];
      }
    }

    // Final fallback: void in the led suit and holding no trump at all.
    // Same "feed partner points rather than waste the chance" logic used
    // above, ported here too -- this specific path had none of it at
    // all (a leftover gap from the earlier 4-player fix never having
    // been carried over to this engine). Also skipped once myTeamSecured,
    // same as the other feed-partner spots above.
    let disc = hand.filter(c => c.suit !== this.trumpSuit);
    if (!disc.length) disc = hand;
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

  stateFor(viewerPos) {
    return {
      tableId: this.tableId,
      round: this.round,
      dealer: this.dealer,
      tricksPlayed: this.tricksPlayed,
      currentPlayer: this.currentPlayer,
      bidder: this.bidder,
      highestBid: this.highestBid,
      passes: this.passes,
      bidHistory: this.bidHistory,
      learningPulseCount: this.learningPulseCount,
      lastLearningBotName: this.lastLearningBotName,
      trumpSuit: this.trumpSuit,
      trumpExposed: this.trumpExposed,
      roundVoidMessage: this.roundVoidMessage,
      mustPlayTrump: this.mustPlayTrumpBy === viewerPos,
      hasHiddenTrump: !!this.hiddenTrump,
      revealedTrumpCard: this.revealedTrumpCard,
      myHiddenTrumpCard: (this.hiddenTrump && this.hiddenTrumpOwner === viewerPos) ? this.hiddenTrump : null,
      trickCards: this.trickCards,
      trickSuit: this.trickSuit,
      teamPoints: this.teamPoints,
      gameScore: this.gameScore,
      qMarks: this.qMarks,
      partnerSignals: this.partnerSignals,
      gameOver: this.gameOver,
      lastTrick: this.lastTrick,
      roundWinnerAnnounced: this.roundWinnerAnnounced,
      pendingEarlyWinChoice: this.pendingEarlyWinChoice,
      pendingMidTrickQuote: this.pendingMidTrickQuote,
      // The ask-button's activation state, computed fresh for whichever specific viewer this
      // state is being built for - null means nothing to ask right now (button greyed out for
      // them), otherwise it's who they'd be asking if they pressed it.
      midTrickAskTargetPos: this._getMidTrickAskTarget(viewerPos),
      quoteEligible: this._isQuoteEligibleFor(this.currentPlayer),
      teamStillClean: this.teamStillClean,
      quoteState: this.quoteState,
      thaniCaller: this.thaniCaller,
      foldedSeats: this.foldedSeats,
      reshuffleReason: this.reshuffleReason || null,
      phase: this.phase,
      seats: this.seats.map((s, i) => {
        if (!s) return null;
        return {
          name: s.name, isBot: s.isBot, connected: s.connected,
          cardCount: s.hand.length,
          hand: i === viewerPos ? s.hand : undefined,
          avatar: s.avatar || null
        };
      })
    };
  }
}

module.exports = { GameEngine6P, SUITS, RANKS, POINTS, RANK_ORDER, getTeam, freshDeck, evaluateHand, SEATS };
