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
//    first bidder (dealer's left) must bid at least 16 and cannot pass.
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
// Matches the source file's own nextPlayer() convention exactly: seats
// count DOWN, wrapping from 0 back to 5. Not the same as the 4-player
// game's special non-sequential order — that fix was specific to a
// reported real-multiplayer bug in THAT game; this one faithfully
// preserves whatever convention the uploaded 6-player file already used
// and had presumably already been played/tested with.
function nextPos(p) { return (p + SEATS - 1) % SEATS; }

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
    let p = margin >= 0 ? 0.97 - 0.25 * Math.exp(-margin / 3) : 0.97 * Math.exp(margin / 3);
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
    this.dealer = Math.floor(Math.random() * SEATS);
    this.resetRoundState();
    this.phase = 'lobby'; // lobby | bidding1 | choosingTrump | play | roundEnd
    this.log = [];
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
    this.hiddenTrump = null;
    this.hiddenTrumpOwner = -1;
    this.mustPlayTrumpBy = -1;
    this.trickCards = [];
    this.trickSuit = '';
    this.playedCardsThisRound = [];
    this.voidSuits = Array.from({ length: SEATS }, () => new Set());
    this.tricksPlayed = 0;
    this.teamPoints = [0, 0];
    this.lastTrick = null;
    this.roundWinnerAnnounced = null;
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

  seatHuman(pos, name, playerId) {
    this.seats[pos] = { name, isBot: false, connected: true, playerId, hand: [] };
  }

  seatBot(pos, name) {
    this.seats[pos] = { name, isBot: true, connected: true, playerId: null, hand: [] };
  }

  removeSeat(pos) { this.seats[pos] = null; }

  replaceBot(pos, playerId, name) {
    const seat = this.seats[pos];
    if (!seat || !seat.isBot) return false;
    seat.isBot = false; seat.connected = true; seat.playerId = playerId; seat.name = name;
    return true;
  }

  takeOverSeat(pos, playerId, name) {
    const seat = this.seats[pos];
    if (!seat) return false;
    if (!seat.isBot && seat.connected) return false;
    seat.isBot = false; seat.connected = true; seat.playerId = playerId; seat.name = name;
    return true;
  }

  markConnected(pos, connected) { if (this.seats[pos]) this.seats[pos].connected = connected; }
  findSeatByPlayerId(playerId) { return this.seats.findIndex(s => s && s.playerId === playerId); }

  // ---------------- Round lifecycle ----------------

  canStart() { return this.seats.filter(Boolean).length >= 2; }

  startRound() {
    this.round++;
    this.resetRoundState();
    this.dealer = nextPos(this.dealer);
    this.currentPlayer = nextPos(this.dealer);
    this.deck = freshDeck();
    for (let i = 0; i < SEATS; i++) if (this.seats[i]) this.seats[i].hand = [];
    this.dealCards(6); // all 6 cards, all at once — no split deal in this variant
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
    this.phase = 'play';
    this.trumpExposed = false;
    this.trickCards = [];
    this.trickSuit = '';
    this.currentPlayer = nextPos(this.dealer); // dealer's left always leads, same as the 4p game
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
    if (this.trickSuit === '') this.trickSuit = played.suit;

    // Same rule as the 4-player game: a trump-suited card played as an
    // ordinary discard (couldn't follow suit, never explicitly called
    // trump) does not expose trump and can never win this trick, even if
    // trump gets legitimately exposed later in the same trick by someone
    // else. See game-engine.js's playCard for the full reasoning.
    const isIncidentalTrumpDiscard = !this.trumpExposed && played.suit === this.trumpSuit && this.trickSuit !== this.trumpSuit;
    this.trickCards.push({ pos, card: played, powerless: isIncidentalTrumpDiscard });

    this.addLog(`Seat ${pos} played ${played.rank}${played.suit}.`);

    if (this.trickCards.length === SEATS) {
      this._resolveTrick();
    } else {
      this.currentPlayer = nextPos(this.currentPlayer);
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
    if (this.trickSuit === '') this.trickSuit = card.suit;
    this.trickCards.push({ pos, card });
    this.addLog(`Seat ${pos} played the hidden trump ${card.rank}${card.suit}!`);
    if (this.trickCards.length === SEATS) this._resolveTrick();
    else { this.currentPlayer = nextPos(this.currentPlayer); this._notify(); this.maybeAutoAct(); }
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

    if (this.trickSuit) {
      for (const tc of this.trickCards) {
        if (tc.card.suit !== this.trickSuit) this.voidSuits[tc.pos].add(this.trickSuit);
      }
    }
    for (const tc of this.trickCards) {
      const seatTc = this.seats[tc.pos];
      if (!seatTc || !seatTc.isBot) continue;
      brain.recordTrickOutcome(seatTc.name, { trickLen: this.trickCards.length }, tc.card, tc.pos === winner.pos, points);
    }

    this.tricksPlayed++;
    this.playedCardsThisRound.push(...this.trickCards.map(tc => tc.card));
    this.trickCards = [];
    this.trickSuit = '';
    this.mustPlayTrumpBy = -1;

    const cardsLeft = this.seats.reduce((s, seat) => s + (seat ? seat.hand.length : 0), 0);
    if (cardsLeft === 0 && this.hiddenTrump) {
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

    for (let i = 0; i < SEATS; i++) {
      const seatI = this.seats[i];
      if (!seatI || !seatI.isBot) continue;
      const wonRound = (getTeam(i) === bT) === made;
      if (i === this.bidder && this._bidderHandProfileForLearning) {
        brain.recordBidOutcome(seatI.name, this._bidderHandProfileForLearning, this.highestBid, made, wonRound);
      }
      brain.recordRound(seatI.name, wonRound);
    }
    this._bidderHandProfileForLearning = null;
    brain.saveBrains();

    // No championship/King meta-game in this variant — the match just
    // ends outright the moment either team hits 12 or drops to 0.
    if (this.gameScore[0] >= 12 || this.gameScore[1] >= 12 || this.gameScore[0] <= 0 || this.gameScore[1] <= 0) {
      const winningTeam = this.gameScore[0] > this.gameScore[1] ? 0 : 1;
      this.gameOver = { winningTeam, finalScore: this.gameScore.slice() };
      this.addLog(`Match over — team ${winningTeam} wins ${this.gameScore[winningTeam]}-${this.gameScore[1 - winningTeam]}.`);
    }

    this._notify();
  }

  // ---------------- Bots ----------------

  maybeAutoAct() {
    const seat = this.seats[this.currentPlayer];
    if (!seat) return;
    if (seat.isBot || !seat.connected) {
      const capturedPos = this.currentPlayer;
      const capturedRound = this.round;
      const delay = seat.isBot ? 900 : 10000;
      setTimeout(() => {
        if (this.round !== capturedRound) return;
        if (this.currentPlayer !== capturedPos) return;
        const seatNow = this.seats[capturedPos];
        if (!seatNow || (!seatNow.isBot && seatNow.connected)) return;
        this._botAct(capturedPos);
      }, delay);
    }
  }

  _botAct(pos) {
    if (this.phase === 'bidding1' && this.currentPlayer === pos) {
      const b = brain.getBrain(this.seats[pos].name);
      const hand = this.seats[pos].hand;
      const first = this.isFirstBidder(pos);
      const minBid = this.highestBid > 0 ? this.highestBid + 1 : 16;
      const ev = evaluateHand(hand);
      const comfortThreshold = Math.max(0.45, 0.85 - (b.level - 1) * 0.08 - (b.bidWeights.aggression - 1) * 0.1);
      let target = 16;
      for (let bidLevel = 16; bidLevel <= 28; bidLevel++) {
        if (ev.probByBid[bidLevel] >= comfortThreshold) target = bidLevel;
        else break;
      }
      if (ev.defensive > ev.offensive * 1.3) target = Math.max(16, target - 3);
      let pb = 0;
      if (this.bidder >= 0 && getTeam(this.bidder) === getTeam(pos)) pb = 1 * b.bidWeights.partnerSupport;
      target = Math.min(28, Math.round(target + pb));

      let bid = 0;
      if (first) {
        bid = Math.max(16, Math.min(target, 22));
      } else if (minBid <= target && minBid <= 28) {
        bid = minBid <= target - 2 ? minBid + 1 : minBid;
      }
      if (first && bid === 0) bid = 16;

      const result = this.placeBid(pos, bid);
      if (!result.ok) this.placeBid(pos, 0);
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
        if (pos === this.bidder) callTrumpNow = true;
        else if (isLast && wt !== myTeam && tPts > 0) callTrumpNow = true;
        else if (wt !== myTeam && tPts >= 2) callTrumpNow = true;
        else if (trumps.some(t => t.rank === 'J' || t.rank === '9')) callTrumpNow = true;
        else if (this.trickCards.some(tc => tc.card.points > 0 || tc.card.rank === 'J' || tc.card.rank === '9')) callTrumpNow = true;
        if (callTrumpNow) {
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
        let sc = -voidOpponentPenalty;
        if (isEarly) {
          if (low.rank === 'J' || low.rank === '9') {
            if (bySuit[s].length > 1) { candidates.push({ card: bySuit[s][1], score: bySuit[s].length * 5 - voidOpponentPenalty, suit: s }); continue; }
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
      const worthTrumping = tPts >= 2 || isLast || (isBidder && tPts >= 1);
      if (trumpWinning && wt !== myTeam && worthTrumping) {
        let wtr = trumps[0];
        if (cwc && cwc.suit === this.trumpSuit) {
          for (let i = trumps.length - 1; i >= 0; i--) {
            if (RANK_ORDER[trumps[i].rank] > RANK_ORDER[cwc.rank]) { wtr = trumps[i]; break; }
          }
        }
        return wtr;
      }
      return trumps[trumps.length - 1];
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
      trumpSuit: this.trumpSuit,
      trumpExposed: this.trumpExposed,
      mustPlayTrump: this.mustPlayTrumpBy === viewerPos,
      hasHiddenTrump: !!this.hiddenTrump,
      myHiddenTrumpCard: (this.hiddenTrump && this.hiddenTrumpOwner === viewerPos) ? this.hiddenTrump : null,
      trickCards: this.trickCards,
      trickSuit: this.trickSuit,
      teamPoints: this.teamPoints,
      gameScore: this.gameScore,
      gameOver: this.gameOver,
      lastTrick: this.lastTrick,
      roundWinnerAnnounced: this.roundWinnerAnnounced,
      phase: this.phase,
      seats: this.seats.map((s, i) => {
        if (!s) return null;
        return {
          name: s.name, isBot: s.isBot, connected: s.connected,
          cardCount: s.hand.length,
          hand: i === viewerPos ? s.hand : undefined
        };
      })
    };
  }
}

module.exports = { GameEngine6P, SUITS, RANKS, POINTS, RANK_ORDER, getTeam, freshDeck, evaluateHand, SEATS };
