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
    this.gameScore = [6, 6];
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
    this.bidHistory = [];
    this.trumpSuit = '';
    this.trumpExposed = false;
    this.roundVoidMessage = null;
    this.hiddenTrump = null;
    this.hiddenTrumpOwner = -1;
    this.mustPlayTrumpBy = -1;
    this.trickCards = [];
    this.trickSuit = '';
    this.suitLeadCount = { '♠': 0, '♥': 0, '♦': 0, '♣': 0 };
    this.playedCardsThisRound = [];
    this.voidSuits = Array.from({ length: SEATS }, () => new Set());
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
    return true;
  }

  replaceBot(pos, playerId, name, avatar) {
    const seat = this.seats[pos];
    if (!seat || !seat.isBot) return false;
    seat.isBot = false; seat.connected = true; seat.playerId = playerId; seat.name = name;
    seat.avatar = avatar || null;
    return true;
  }

  takeOverSeat(pos, playerId, name, avatar) {
    const seat = this.seats[pos];
    if (!seat) return false;
    if (!seat.isBot && seat.connected) return false;
    seat.isBot = false; seat.connected = true; seat.playerId = playerId; seat.name = name;
    seat.avatar = avatar || null;
    return true;
  }

  markConnected(pos, connected) {
    if (!this.seats[pos]) return;
    this.seats[pos].connected = connected;
    if (!connected) this.seats[pos].disconnectedAt = Date.now();
    else this.seats[pos].disconnectedAt = null;
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
      if (!isAll78 && allJacksSeat === -1) break; // this deal is fine, stop here
      if (!reason) {
        reason = isAll78
          ? { type: 'all78', seat: firstBidderSeat, name: this.seats[firstBidderSeat] ? this.seats[firstBidderSeat].name : ('Seat ' + firstBidderSeat), round: this.round, ts: Date.now() }
          : { type: 'allJacks', seat: allJacksSeat, name: this.seats[allJacksSeat].name, round: this.round, ts: Date.now() };
        this.addLog(`Reshuffling — ${reason.name} ${reason.type === 'all78' ? "was forced to bid with a hand of only 7s and 8s" : "was dealt all four Jacks"}. Same dealer, fresh deal.`);
      }
      for (let i = 0; i < SEATS; i++) { if (this.seats[i]) this.seats[i].hand = []; }
      this.deck = freshDeck();
      this.dealCards(6);
    }
    return reason;
  }

  startRound() {
    this.round++;
    this.resetRoundState();
    this.dealer = nextPos(this.dealer);
    this.currentPlayer = nextPos(this.dealer);
    this.deck = freshDeck();
    for (let i = 0; i < SEATS; i++) if (this.seats[i]) this.seats[i].hand = [];
    this.dealCards(6); // all 6 cards, all at once — no split deal in this variant
    this.reshuffleReason = this._dealSameHandUntilValid();
    this.phase = 'bidding1';
    this.addLog(`Round ${this.round} started. Dealer seat ${this.dealer}.`);
    this._notify();
    this.maybeAutoAct();
  }

  restartRound() {
    const keepRound = this.round, keepDealer = this.dealer;
    this.resetRoundState();
    this.round = keepRound; this.dealer = keepDealer;
    this.currentPlayer = nextPos(this.dealer);
    this.deck = freshDeck();
    for (let i = 0; i < SEATS; i++) if (this.seats[i]) this.seats[i].hand = [];
    this.dealCards(6);
    this.reshuffleReason = this._dealSameHandUntilValid();
    this.phase = 'bidding1';
    this.addLog(`Round ${this.round} restarted by the host — fresh shuffle.`);
    this._notify();
    this.maybeAutoAct();
  }

  restartGame() {
    this.gameScore = [6, 6];
    this.gameOver = null;
    this.round = 0;
    this.dealer = Math.floor(Math.random() * SEATS);
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
    if (bid === 0) {
      if (first) bid = 16; // first bidder cannot pass
      else {
        this.passes++;
        this.bidHistory.push({ pos, bid: 0 });
        this.addLog(`Seat ${pos} passed.`);
        return this._afterBidAction();
      }
    }
    const minBid = this.highestBid > 0 ? this.highestBid + 1 : 16;
    if (bid < minBid || bid > 28) return { ok: false, reason: 'invalid_bid_amount' };
    this.highestBid = bid;
    this.bidder = pos;
    this.passes = 0;
    this.bidHistory.push({ pos, bid });
    if (this.seats[pos]) this._bidderHandProfileForLearning = brain.getHandProfile(this.seats[pos].hand);
    this.addLog(`Seat ${pos} bid ${bid}.`);
    return this._afterBidAction();
  }

  _afterBidAction() {
    // Ends once everyone-but-the-bidder has passed, or everyone passed
    // outright (no valid bid at all — a redeal is needed).
    if ((this.passes >= SEATS - 1 && this.highestBid > 0) || this.passes >= SEATS) {
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
    this.currentPlayer = nextPos(this.currentPlayer);
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
    const defendingHasTrump = this.thaniCaller >= 0 || this.seats.some((s, i) => s && getTeam(i) !== bidTeam && s.hand.some(c => c.suit === this.trumpSuit));
    if (!defendingHasTrump) {
      this.roundVoidMessage = `The defending team has no ${this.trumpSuit} at all this round — nothing to contest. Round voided, moving to the next dealer.`;
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

  canPlayCard(pos, card) {
    if (this.phase !== 'play') return false;
    if (pos !== this.currentPlayer) return false;
    const hand = this.seats[pos].hand;
    if (!hand.some(c => cardEq(c, card))) return false;
    if (this.trickSuit === '') {
      if (pos === this.hiddenTrumpOwner && !this.trumpExposed && card.suit === this.trumpSuit) {
        if (hand.some(c => c.suit !== this.trumpSuit)) return false;
      }
      return true;
    }
    const hasSuit = hand.some(c => c.suit === this.trickSuit);
    if (hasSuit && card.suit !== this.trickSuit) return false;
    if (this.mustPlayTrumpBy === pos && !hasSuit && card.suit !== this.trumpSuit) {
      if (hand.some(c => c.suit === this.trumpSuit)) return false;
    }
    return true;
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
    if (!this.canPlayCard(pos, card)) return { ok: false, reason: 'illegal_card' };
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

  playHiddenTrump(pos) {
    if (this.phase !== 'play') return { ok: false, reason: 'not_playing' };
    if (pos !== this.currentPlayer || pos !== this.hiddenTrumpOwner) return { ok: false, reason: 'not_your_turn' };
    if (!this.hiddenTrump) return { ok: false, reason: 'no_hidden_card' };
    const card = this.hiddenTrump;
    this.hiddenTrump = null; this.hiddenTrumpOwner = -1;
    if (this.mustPlayTrumpBy === pos) this.mustPlayTrumpBy = -1;
    if (!this.trumpExposed) this.exposeTrump();
    if (this.trickSuit === '') { this.trickSuit = card.suit; this.suitLeadCount[card.suit]++; }
    this.trickCards.push({ pos, card });
    this.addLog(`Seat ${pos} played the hidden trump ${card.rank}${card.suit}!`);
    if (this.trickCards.length === SEATS - this.foldedSeats.length) this._resolveTrick();
    else { this.currentPlayer = this._nextActivePos(this.currentPlayer); this._notify(); this.maybeAutoAct(); }
    return { ok: true };
  }

  exposeTrump() {
    this.trumpExposed = true;
    this.addLog(`Trump exposed: ${this.trumpSuit}!`);
    if (this.hiddenTrump && this.hiddenTrumpOwner >= 0 && this.seats[this.hiddenTrumpOwner]) {
      this.seats[this.hiddenTrumpOwner].hand.push(this.hiddenTrump);
      this.hiddenTrump = null;
      this.hiddenTrumpOwner = -1;
    }
  }

  // See game-engine.js for the full reasoning -- identical helper here,
  // except this table's cutoff is 2 cards left, not 3 -- confirmed
  // deliberately different from the 4-player table's threshold, not a
  // scaling mistake.
  _isQuoteEligibleFor(pos) {
    if (pos === null || pos === undefined || !this.seats[pos]) return false;
    if (this.seats[pos].hand.length < 2) return false; // cutoff: must still have at least 2 cards of your own left
    if (this.trickCards.length !== 0) return false; // only the trick's opener can declare
    if (this.quoteState) return false;
    if (this.phase !== 'play') return false;
    if (this.highestBid > 19) return false;
    if (this.pendingEarlyWinChoice) return false;
    return !!this.teamStillClean[getTeam(pos)];
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
        const hasHuman = Array.from({ length: SEATS }, (_, p) => p).some(p => getTeam(p) === winningTeam && this.seats[p] && !this.seats[p].isBot);
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

    // No championship/King meta-game in this variant — the match just
    // ends outright the moment either team hits 12 or drops to 0.
    if (this.gameScore[0] >= 12 || this.gameScore[1] >= 12 || this.gameScore[0] <= 0 || this.gameScore[1] <= 0) {
      const winningTeam = this.gameScore[0] > this.gameScore[1] ? 0 : 1;
      const losingTeam = 1 - winningTeam;
      this.gameOver = { winningTeam, finalScore: this.gameScore.slice() };
      this.addLog(`Match over — team ${winningTeam} wins ${this.gameScore[winningTeam]}-${this.gameScore[1 - winningTeam]}.`);
      // Zero-sum scoring means this is always a shutout — every player
      // on the losing side picks up a Q.
      for (let i = 0; i < SEATS; i++) {
        const s = this.seats[i];
        if (!s || getTeam(i) !== losingTeam) continue;
        this.qMarks[s.name] = (this.qMarks[s.name] || 0) + 1;
      }
      this.addLog(`Team ${losingTeam} shut out — every player picks up a Q.`);
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
      const stillHasHuman = Array.from({ length: SEATS }, (_, p) => p).some(p => getTeam(p) === team && this.seats[p] && !this.seats[p].isBot && this.seats[p].connected);
      if (!stillHasHuman) {
        const anyPosOnTeam = Array.from({ length: SEATS }, (_, p) => p).find(p => getTeam(p) === team);
        this.respondToEarlyWin(anyPosOnTeam, true);
      }
      return;
    }
    const seat = this.seats[this.currentPlayer];
    if (!seat) return;
    if (this._turnTrackedPlayer !== this.currentPlayer || this._turnTrackedRound !== this.round) {
      this._turnTrackedPlayer = this.currentPlayer;
      this._turnTrackedRound = this.round;
      this.turnStartedAt = Date.now();
    }
    const turnAgeMs = Date.now() - (this.turnStartedAt || Date.now());
    const CONNECTED_BUT_STUCK_MS = 120000;
    const treatAsStuck = seat.isBot || !seat.connected || turnAgeMs >= CONNECTED_BUT_STUCK_MS;
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
      const delay = seat.isBot ? 900 : (turnAgeMs >= CONNECTED_BUT_STUCK_MS ? 900 : 35000);
      setTimeout(() => {
        if (this.round !== capturedRound) return;
        if (this.currentPlayer !== capturedPos) return;
        const seatNow = this.seats[capturedPos];
        if (!seatNow) return;
        const stillStuck = seatNow.isBot || !seatNow.connected || (Date.now() - (capturedTurnStartedAt || Date.now())) >= CONNECTED_BUT_STUCK_MS;
        if (!stillStuck) return;
        this._botAct(capturedPos);
      }, delay);
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
            const legal = hand.find(c => this.canPlayCard(pos, c));
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
      const ev = evaluateHand(hand);
      const totalDecidedBids = b.stats.bidsWon + b.stats.bidsLost;
      const performanceAdjustment = totalDecidedBids >= 5
        ? Math.max(0, 0.5 - (b.stats.bidsWon / totalDecidedBids)) * 0.6
        : 0;
      const comfortThreshold = Math.min(0.9, Math.max(0.45,
        0.85 - (b.level - 1) * 0.08 - (b.bidWeights.aggression - 1) * 0.1 + performanceAdjustment));
      let target = 16;
      for (let bidLevel = 16; bidLevel <= 28; bidLevel++) {
        // Bids of 20+ ("Honors") pay and cost more per point than
        // sub-20 bids — a bad guess up there is a bigger absolute swing
        // on the scoreboard, so crossing into that territory (and again
        // into 28) needs a bit more confidence than the plain curve
        // alone would ask for, on top of the ordinary comfort bar.
        const honorsPremium = bidLevel >= 28 ? 0.08 : bidLevel >= 20 ? 0.05 : 0;
        if (ev.probByBid[bidLevel] >= comfortThreshold + honorsPremium) target = bidLevel;
        else break;
      }
      if (ev.defensive > ev.offensive * 1.3) target = Math.max(16, target - 3);

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
        // None of these reasons justify exposing trump and cutting in if
        // our OWN partner already has this trick won for free — pure
        // waste of a trump card and revealed information for nothing.
        if (wt !== myTeam) {
          if (pos === this.bidder) callTrumpNow = true;
          else if (isLast && tPts > 0) callTrumpNow = true;
          else if (tPts >= 2) callTrumpNow = true;
          else if ((this.suitLeadCount[this.trickSuit] || 0) >= 2 && tPts >= 1) callTrumpNow = true;
          else if (trumps.some(t => t.rank === 'J' || t.rank === '9')) callTrumpNow = true;
          else if (this.trickCards.some(tc => tc.card.points > 0 || tc.card.rank === 'J' || tc.card.rank === '9')) callTrumpNow = true;
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
  _isRankSeen(suit, rank) { return this._cardsSeenSoFar().some(c => c.suit === suit && c.rank === rank); }

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
        let voidOpponentPenalty = 0;
        for (let p = 0; p < SEATS; p++) {
          if (p === pos || getTeam(p) === myTeam) continue;
          if (this.voidSuits[p].has(s)) { voidOpponentPenalty = this.trumpExposed ? 20 : 10; break; }
        }
        // The flip side: a PARTNER known to be void in this suit can
        // trump straight in and win it for the team once trump is
        // exposed — leading into that is a genuine team tactic ("what
        // can my partner cut"), not just a read on this bot's own hand.
        let partnerVoidBonus = 0;
        for (let p = 0; p < SEATS; p++) {
          if (p === pos || getTeam(p) !== myTeam) continue;
          if (this.voidSuits[p].has(s) && this.trumpExposed) { partnerVoidBonus = 18; break; }
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
            // A lone 9 with no second card of that suit to lead instead —
            // this is exactly the risky "leading a point card into a suit
            // where the opponent may still hold the Jack" case if that
            // Jack hasn't been seen yet.
            if (low.rank === '9' && !jSeen) sc -= 25;
          }
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
            sc -= 25;
          }
          sc += bySuit[s].reduce((a, c) => a + c.points, 0) * 10 + bySuit[s].length * 3;
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
      // When genuinely desperate for points (myTeamDesperate above), the
      // bar for "is this trick worth trump" drops from 2 to 1 -- same
      // adjustment as the 4-player engine.
      const worthTrumping = tPts >= (myTeamDesperate ? 1 : 2) || isLast || (isBidder && tPts >= 1) || (suitRepeat >= 2 && tPts >= 1);
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
          const zeroPt = trumps.filter(c => c.points === 0);
          wtr = zeroPt.length > 0 ? zeroPt[zeroPt.length - 1] : trumps[trumps.length - 1];
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
