// ============================================================
// 56 — SIX-PLAYER KERALA CARD GAME — AUTHORITATIVE GAME ENGINE
// ============================================================
// Sibling to game-engine.js (28, 4-player) and game-engine-6p.js (28,
// 6-player) — a genuinely different game, not a reskin:
//  - 6 players, 2 teams of 3 (seats 0,2,4 = team 0 / "A", seats 1,3,5 =
//    team 1 / "B"), same seating convention as the 6-player 28 engine.
//  - 48-card DOUBLE deck: two full copies of a 24-card suit (J,9,A,10,K,Q
//    of each suit — no 7/8). 8 cards dealt per player, all at once.
//  - Bidding runs 28-56, opened by dealer's right, and includes suit
//    bids, No Trump ('nt'), and a signaling "no suit"/void bid ('ns'),
//    plus bridge-style Double/Redouble that multiplies the payout.
//  - No hidden-trump mechanic and no forced-trump-exposure rule at all —
//    once bidding closes, the trump suit (if any) is known to everyone
//    immediately, and play is a plain follow-suit trick-taking game.
//  - Match score is a shared pool: both teams start at 12 "tables";
//    making/missing a bid transfers tables from one side to the other,
//    multiplied by the double/redouble; the match ends the instant
//    either team's pool hits 0.
//
// Rules and both bot heuristics (bidding + card play) below are ported
// directly from the confirmed-correct offline reference file — only the
// networking/orchestration shape changes, to match how every other
// engine in this project runs: the server holds the only copy of the
// state, resolves each trick immediately (with a `lastTrick` snapshot
// for the client to animate, not a server-side display delay), and
// drives bot turns itself via a short setTimeout after every state
// change — no client ever has to be the one "driving" a bot.
// ============================================================

const SUITS = ['S', 'H', 'D', 'C'];
const RANKS = ['J', '9', 'A', '10', 'K', 'Q']; // power order, highest first (lower index = stronger)
const RANK_PTS = { J: 3, '9': 2, A: 1, '10': 1, K: 0, Q: 0 };
const SEATS = 6;

function getTeam(pos) { return pos % 2; } // 0 ("A"): seats 0,2,4 — 1 ("B"): seats 1,3,5
function nextPos(p) { return (p + 1) % SEATS; }
function teamLetter(t) { return t === 0 ? 'A' : 'B'; }

function freshDeck() {
  const deck = [];
  let id = 0;
  for (let copy = 0; copy < 2; copy++) {
    for (const s of SUITS) {
      for (const r of RANKS) {
        deck.push({ suit: s, rank: r, points: RANK_PTS[r], id: 'c' + (id++) });
      }
    }
  }
  return deck;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function cardEq(a, b) { return a.suit === b.suit && a.rank === b.rank; }

// ---------------- Scoring bands ----------------
function bandFor(value) {
  if (value >= 28 && value <= 39) return { win: 1, lose: 2 };
  if (value >= 40 && value <= 47) return { win: 2, lose: 3 };
  if (value >= 48 && value <= 55) return { win: 3, lose: 4 };
  if (value === 56) return { win: 4, lose: 5 };
  return { win: 1, lose: 2 };
}

// ============================================================
// BOT AI — ported directly from the reference file's botDecideBid /
// botChooseCard. Pure functions of engine state; no learning/leveling
// system (the reference bots didn't have one either).
// ============================================================

function suitStats(hand) {
  const jacks = { S: 0, H: 0, D: 0, C: 0 }, nines = { S: 0, H: 0, D: 0, C: 0 }, count = { S: 0, H: 0, D: 0, C: 0 };
  hand.forEach(c => { count[c.suit]++; if (c.rank === 'J') jacks[c.suit]++; if (c.rank === '9') nines[c.suit]++; });
  return { jacks, nines, count };
}

// 1 Jack + 3+ support cards = baseline 28. Only once BOTH copies of a
// suit's Jack are held (two decks are in play) do extra 9s push it up.
function suitOpenValue(jacksN, ninesN) {
  if (jacksN >= 2) return 28 + 1 + ninesN;
  return 28;
}

function botDecideBid(engine, seat) {
  const hand = engine.seats[seat].hand;
  const cb = engine.currentBid;
  const minAllowed = cb ? cb.value + 1 : 28;
  const { jacks, nines, count } = suitStats(hand);
  const isForced = engine.forcedSeat === seat && !cb;
  const biddableSuits = SUITS.filter(s => jacks[s] >= 1 && count[s] >= 4);
  const bestOf = (suits) => {
    let best = null, bestVal = -1;
    suits.forEach(s => { const v = suitOpenValue(jacks[s], nines[s]); if (v > bestVal) { bestVal = v; best = s; } });
    return { suit: best, value: bestVal };
  };

  if (cb && getTeam(cb.seat) !== getTeam(seat) && engine.doubled === 0 && cb.value >= 44 && Math.random() < 0.25) {
    return { action: 'double' };
  }
  if (cb && getTeam(cb.seat) === getTeam(seat) && engine.doubled === 1 && cb.trump && jacks[cb.trump] >= 1 && Math.random() < 0.3) {
    return { action: 'redouble' };
  }

  // Reassert my own opening suit if my team's bid has drifted off it.
  if (cb && engine.openerSeat === seat && engine.openerSuit && cb.trump !== engine.openerSuit &&
      getTeam(cb.seat) === getTeam(seat) && jacks[engine.openerSuit] >= 1 && count[engine.openerSuit] >= 4) {
    const value = Math.min(56, cb.value + 1);
    if (value >= minAllowed) return { action: 'bid', value, trump: engine.openerSuit, kind: 'suit', order: 'forward' };
  }

  if (!cb) {
    if (biddableSuits.length > 0) {
      const { suit, value } = bestOf(biddableSuits);
      return { action: 'bid', value: Math.min(56, value), trump: suit, kind: 'suit', order: 'forward' };
    }
    if (isForced) {
      const longest = SUITS.reduce((a, b) => count[b] > count[a] ? b : a, SUITS[0]);
      return { action: 'bid', value: 28, trump: longest, kind: 'suit', order: jacks[longest] >= 1 ? 'forward' : 'reverse' };
    }
    return { action: 'pass' };
  }

  const isPartnerBid = getTeam(cb.seat) === getTeam(seat);
  if (isPartnerBid && cb.trump) {
    const s = cb.trump;
    const alreadySaidVoid = engine.nsBySeat && engine.nsBySeat[seat];
    const alreadyBidThisSuit = engine.suitBidBySeat && engine.suitBidBySeat[seat + '-' + s];
    if (count[s] === 0 && !alreadySaidVoid) {
      if (minAllowed <= 56) return { action: 'bid', value: minAllowed, trump: null, kind: 'ns', order: null };
      return { action: 'pass' };
    }
    if (count[s] > 0 && jacks[s] >= 1 && !alreadyBidThisSuit) {
      const supportBump = jacks[s] + nines[s];
      const value = Math.min(56, cb.value + supportBump);
      if (value >= minAllowed) return { action: 'bid', value, trump: s, kind: 'suit', order: 'forward' };
    }
    const others = biddableSuits.filter(x => x !== s);
    if (others.length > 0) {
      const { suit, value } = bestOf(others);
      if (value >= minAllowed && value <= 56) return { action: 'bid', value, trump: suit, kind: 'suit', order: 'forward' };
    }
    return { action: 'pass' };
  }

  if (biddableSuits.length > 0) {
    const contested = cb.trump;
    let candidates = biddableSuits.filter(s => s !== contested);
    if (candidates.length === 0) candidates = biddableSuits;
    const { suit, value } = bestOf(candidates);
    if (value >= minAllowed && value <= 56) {
      return { action: 'bid', value, trump: suit, kind: 'suit', order: jacks[suit] >= 1 ? 'forward' : 'reverse' };
    }
  }
  return { action: 'pass' };
}

function cardPowerFor(card, trump) {
  return { isTrump: !!(trump && card.suit === trump), rankIdx: RANKS.indexOf(card.rank) };
}

// Which suits this seat's team can safely lead — both Jacks of it are
// already accounted for (played, or claimed via a forward-order bid by
// a teammate) and no opponent ever claimed one themselves; or every
// opponent has already been caught unable to follow that suit.
function suitLeadSafety(engine, seat) {
  const myTeam = getTeam(seat);
  const oppSeats = [0, 1, 2, 3, 4, 5].filter(s => getTeam(s) !== myTeam);
  const played = engine.playedCardsThisHand.concat(engine.table.map(p => p.card));
  const safe = new Set();
  SUITS.forEach(s => {
    const jacksPlayed = played.filter(c => c.suit === s && c.rank === 'J').length;
    let jacksMyTeam = 0, jacksOpponent = 0;
    for (let sIdx = 0; sIdx < 6; sIdx++) {
      const claim = engine.suitBidBySeat ? engine.suitBidBySeat[sIdx + '-' + s] : null;
      if (claim === 'forward') {
        if (getTeam(sIdx) === myTeam) jacksMyTeam++; else jacksOpponent++;
      }
    }
    const allOppsRevealedVoid = oppSeats.length > 0 && oppSeats.every(os =>
      engine.revealedVoidBySeat && engine.revealedVoidBySeat[os] && engine.revealedVoidBySeat[os].includes(s));
    if (jacksOpponent === 0 && ((jacksPlayed + jacksMyTeam) >= 2 || allOppsRevealedVoid)) safe.add(s);
  });
  return safe;
}

function chooseDiscard(engine, seat, legalCards) {
  const safeSuits = suitLeadSafety(engine, seat);
  const unsafeCards = legalCards.filter(c => !safeSuits.has(c.suit));
  const pool = unsafeCards.length > 0 ? unsafeCards : legalCards;
  return pool.slice().sort((a, b) => RANK_PTS[a.rank] - RANK_PTS[b.rank])[0];
}

function botChooseCard(engine, seat, legalCards) {
  const trump = engine.currentBid.trump;
  if (engine.table.length === 0) {
    const safeSuits = suitLeadSafety(engine, seat);
    const bySuit = {};
    legalCards.forEach(c => { (bySuit[c.suit] = bySuit[c.suit] || []).push(c); });
    const candidateSuits = Object.keys(bySuit).filter(s => safeSuits.has(s));
    const pool = candidateSuits.length > 0 ? candidateSuits.flatMap(s => bySuit[s]) : legalCards;
    return pool.slice().sort((a, b) => RANKS.indexOf(a.rank) - RANKS.indexOf(b.rank))[0];
  }

  let winner = engine.table[0];
  let winPow = cardPowerFor(winner.card, trump);
  for (let i = 1; i < engine.table.length; i++) {
    const p = engine.table[i];
    const pow = cardPowerFor(p.card, trump);
    let better = false;
    if (pow.isTrump && !winPow.isTrump) better = true;
    else if (pow.isTrump === winPow.isTrump) {
      if (pow.isTrump) better = pow.rankIdx < winPow.rankIdx;
      else if (p.card.suit === engine.leadSuit && winner.card.suit === engine.leadSuit) better = pow.rankIdx < winPow.rankIdx;
      else if (p.card.suit === engine.leadSuit && winner.card.suit !== engine.leadSuit) better = true;
    }
    if (better) { winner = p; winPow = pow; }
  }

  if (getTeam(winner.seat) === getTeam(seat)) return chooseDiscard(engine, seat, legalCards);

  const winners = legalCards.filter(c => {
    const pow = cardPowerFor(c, trump);
    if (pow.isTrump && !winPow.isTrump) return true;
    if (pow.isTrump === winPow.isTrump) {
      if (pow.isTrump) return pow.rankIdx < winPow.rankIdx;
      if (c.suit === engine.leadSuit && winner.card.suit === engine.leadSuit) return pow.rankIdx < winPow.rankIdx;
      if (c.suit === engine.leadSuit && winner.card.suit !== engine.leadSuit) return true;
    }
    return false;
  });
  if (winners.length > 0) {
    const sortedAsc = winners.slice().sort((a, b) => RANKS.indexOf(a.rank) - RANKS.indexOf(b.rank));
    return sortedAsc[sortedAsc.length - 1]; // weakest card that still wins
  }
  return chooseDiscard(engine, seat, legalCards);
}

function formatBidLabel(cb) {
  if (!cb) return '';
  if (cb.kind === 'nt') return cb.value + ' NT';
  if (cb.kind === 'ns') return cb.value + ' NS';
  return cb.order === 'reverse' ? `rev-${cb.value}${cb.trump}` : `${cb.value}${cb.trump}`;
}

// ============================================================
// ENGINE
// ============================================================
class GameEngine56 {
  constructor(tableId) {
    this.tableId = tableId;
    this.seats = new Array(SEATS).fill(null);
    this.handNumber = 0;
    this.matchScore = [12, 12];
    this.matchOver = false;
    this.matchWinner = null;
    this.sessionWins = [0, 0];
    this.dealer = Math.floor(Math.random() * SEATS);
    this.phase = 'lobby'; // lobby | bidding | auctionClosed | play | handEnd
    this.log = [];
    this.onChange = null;
    this._resetHandState();
  }

  _notify() { if (this.onChange) { try { this.onChange(); } catch (e) { console.error('onChange handler error:', e); } } }

  addLog(msg) {
    this.log.push({ t: Date.now(), msg });
    if (this.log.length > 200) this.log.shift();
    console.log(`[56 table ${this.tableId}] ${msg}`);
  }

  _resetHandState() {
    this.turn = null;
    this.currentBid = null;
    this.doubled = 0;
    this.doubledBySeat = null;
    this.passedSeats = [];
    this.forcedSeat = null;
    this.openerSeat = null;
    this.openerSuit = null;
    this.nsBySeat = {};
    this.suitBidBySeat = {};
    this.lastActionBySeat = {};
    this.revealedVoidBySeat = {};
    this.bidHistory = [];
    this.table = [];
    this.leadSuit = null;
    this.playedCardsThisHand = [];
    this.teamPoints = [0, 0];
    this.lastTrick = null;
    this.handResult = null;
    this.auctionClosedAt = null;
  }

  // ---------------- Seating ----------------

  emptySeats() { const out = []; for (let i = 0; i < SEATS; i++) if (!this.seats[i]) out.push(i); return out; }
  humanCount() { return this.seats.filter(s => s && !s.isBot).length; }
  seatHuman(pos, name, playerId) { this.seats[pos] = { name, isBot: false, connected: true, playerId, hand: [] }; }
  seatBot(pos, name) { this.seats[pos] = { name, isBot: true, connected: true, playerId: null, hand: [] }; }
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

  kickPlayer(pos) {
    const seat = this.seats[pos];
    if (!seat) return false;
    if (this.phase === 'lobby') { this.seats[pos] = null; }
    else { seat.isBot = true; seat.connected = true; seat.playerId = null; }
    this.addLog(`${seat.name} was removed by the host.`);
    this._notify();
    return true;
  }

  renameBotSeat(pos, newName) {
    const seat = this.seats[pos];
    if (!seat) return { ok: false, reason: 'no_seat' };
    if (!seat.isBot) return { ok: false, reason: 'not_a_bot' };
    if (!newName || typeof newName !== 'string' || !newName.trim()) return { ok: false, reason: 'invalid_name' };
    const trimmed = newName.trim();
    if (this.seats.some((s, i) => i !== pos && s && s.name === trimmed)) return { ok: false, reason: 'name_in_use' };
    seat.name = trimmed;
    this._notify();
    return { ok: true };
  }

  // ---------------- Round lifecycle ----------------

  canStart() { return this.seats.filter(Boolean).length >= 2; }

  startRound() {
    this.handNumber++;
    this._resetHandState();
    this.dealer = nextPos(this.dealer);
    this.turn = nextPos(this.dealer); // opening bidder — dealer's right
    const deck = shuffle(freshDeck());
    for (let i = 0; i < SEATS; i++) if (this.seats[i]) this.seats[i].hand = [];
    let idx = 0;
    for (let n = 0; n < 8; n++) {
      for (let i = 0; i < SEATS; i++) {
        const pos = (this.turn + i) % SEATS;
        if (this.seats[pos]) this.seats[pos].hand.push(deck[idx]);
        idx++;
      }
    }
    this.phase = 'bidding';
    this.addLog(`Hand ${this.handNumber} dealt. Dealer seat ${this.dealer}. Seat ${this.turn} opens the bidding.`);
    this._notify();
    this.maybeAutoAct();
  }

  restartRound() {
    const keepHand = this.handNumber, keepDealer = this.dealer;
    this._resetHandState();
    this.handNumber = keepHand; this.dealer = keepDealer;
    this.turn = nextPos(this.dealer);
    const deck = shuffle(freshDeck());
    for (let i = 0; i < SEATS; i++) if (this.seats[i]) this.seats[i].hand = [];
    let idx = 0;
    for (let n = 0; n < 8; n++) {
      for (let i = 0; i < SEATS; i++) {
        const pos = (this.turn + i) % SEATS;
        if (this.seats[pos]) this.seats[pos].hand.push(deck[idx]);
        idx++;
      }
    }
    this.phase = 'bidding';
    this.addLog(`Hand ${this.handNumber} restarted by the host — fresh shuffle.`);
    this._notify();
    this.maybeAutoAct();
  }

  restartGame() {
    this.matchScore = [12, 12];
    this.matchOver = false;
    this.matchWinner = null;
    this.handNumber = 0;
    this.dealer = Math.floor(Math.random() * SEATS);
    this.addLog('Host restarted the game — starting a fresh match.');
    this.startRound();
  }

  // ---------------- Bidding ----------------

  placeBid(pos, bidPayload) {
    if (this.phase !== 'bidding') return { ok: false, reason: 'not_bidding' };
    if (pos !== this.turn) return { ok: false, reason: 'not_your_turn' };
    const cb = this.currentBid;
    const minAllowed = cb ? cb.value + 1 : 28;
    let value = Math.floor(Number(bidPayload && bidPayload.value));
    if (!Number.isFinite(value)) return { ok: false, reason: 'invalid_bid_amount' };
    value = Math.max(28, Math.min(56, value));
    if (value < minAllowed) return { ok: false, reason: 'bid_too_low' };
    const kind = (bidPayload.kind === 'nt' || bidPayload.kind === 'ns') ? bidPayload.kind : 'suit';
    const trump = kind === 'suit' ? bidPayload.trump : null;
    if (kind === 'suit' && !SUITS.includes(trump)) return { ok: false, reason: 'invalid_suit' };
    const order = kind === 'suit' ? (bidPayload.order === 'reverse' ? 'reverse' : 'forward') : null;

    const newBid = { value, trump, seat: pos, kind, order };
    if (kind === 'suit' && cb && cb.trump === trump) newBid.increment = value - cb.value;

    if (!cb) { this.openerSeat = pos; this.openerSuit = trump; }
    if (kind === 'ns') this.nsBySeat[pos] = cb ? cb.trump : true;
    if (kind === 'suit') this.suitBidBySeat[pos + '-' + trump] = order;

    this.currentBid = newBid;
    this.doubled = 0; this.doubledBySeat = null; this.passedSeats = [];
    this.bidHistory.push(newBid);
    this.lastActionBySeat[pos] = formatBidLabel(newBid);
    this.forcedSeat = null;
    this.addLog(`Seat ${pos} bid ${formatBidLabel(newBid)}.`);

    this._advanceBiddingTurn();
    this._notify();
    this.maybeAutoAct();
    return { ok: true };
  }

  passBid(pos) {
    if (this.phase !== 'bidding') return { ok: false, reason: 'not_bidding' };
    if (pos !== this.turn) return { ok: false, reason: 'not_your_turn' };
    if (this.forcedSeat === pos && !this.currentBid) return { ok: false, reason: 'forced_to_open' };

    if (!this.passedSeats.includes(pos)) this.passedSeats.push(pos);
    this.lastActionBySeat[pos] = 'Pass';
    this.addLog(`Seat ${pos} passed.`);

    if (!this.currentBid && this.passedSeats.length >= SEATS) {
      this.forcedSeat = nextPos(this.dealer);
      this.passedSeats = [];
      this.turn = this.forcedSeat;
      this.addLog(`Everyone passed. Seat ${this.forcedSeat} is forced to open the bidding.`);
      this._notify();
      this.maybeAutoAct();
      return { ok: true };
    }
    if (this.currentBid && this.passedSeats.length >= SEATS - 1) {
      this._closeBidding();
      this._notify();
      this.maybeAutoAct();
      return { ok: true };
    }
    this._advanceBiddingTurn();
    this._notify();
    this.maybeAutoAct();
    return { ok: true };
  }

  doubleBid(pos) {
    if (this.phase !== 'bidding' || !this.currentBid) return { ok: false, reason: 'cannot_double' };
    if (pos !== this.turn) return { ok: false, reason: 'not_your_turn' };
    if (this.doubled !== 0) return { ok: false, reason: 'already_doubled' };
    this.doubled = 1; this.doubledBySeat = pos;
    this.lastActionBySeat[pos] = 'Double';
    this.addLog(`Seat ${pos} doubled!`);
    this._advanceBiddingTurn();
    this._notify(); this.maybeAutoAct();
    return { ok: true };
  }

  redoubleBid(pos) {
    if (this.phase !== 'bidding' || this.doubled !== 1) return { ok: false, reason: 'cannot_redouble' };
    if (pos !== this.turn) return { ok: false, reason: 'not_your_turn' };
    this.doubled = 2;
    this.lastActionBySeat[pos] = 'Redouble';
    this.addLog(`Seat ${pos} redoubled!`);
    this._advanceBiddingTurn();
    this._notify(); this.maybeAutoAct();
    return { ok: true };
  }

  _advanceBiddingTurn() {
    let next = nextPos(this.turn), guard = 0;
    while (this.passedSeats.includes(next) && guard < SEATS) { next = nextPos(next); guard++; }
    this.turn = next;
  }

  _closeBidding() {
    const cb = this.currentBid;
    this.phase = 'auctionClosed';
    this.auctionClosedAt = Date.now();
    this.turn = null;
    this.leadSuit = null;
    this.table = [];
    this.forcedSeat = null;
    const leaderSeat = nextPos(this.dealer);
    this.addLog(`Bidding closed. Seat ${cb.seat} won with ${cb.value}. Seat ${leaderSeat} leads the first trick.`);

    const capturedAt = this.auctionClosedAt, capturedHand = this.handNumber;
    setTimeout(() => {
      if (this.handNumber !== capturedHand) return;
      if (this.phase !== 'auctionClosed' || this.auctionClosedAt !== capturedAt) return;
      this.phase = 'play';
      this.turn = leaderSeat;
      this._notify();
      this.maybeAutoAct();
    }, 3000);
  }

  // ---------------- Playing cards ----------------

  _legalCardsForSeat(pos) {
    const hand = this.seats[pos].hand;
    if (!this.leadSuit) return hand.slice();
    const followers = hand.filter(c => c.suit === this.leadSuit);
    return followers.length > 0 ? followers : hand.slice();
  }

  canPlayCard(pos, card) {
    if (this.phase !== 'play') return false;
    if (pos !== this.turn) return false;
    const hand = this.seats[pos].hand;
    if (!hand.some(c => cardEq(c, card))) return false;
    if (!this.leadSuit) return true;
    const hasSuit = hand.some(c => c.suit === this.leadSuit);
    if (hasSuit && card.suit !== this.leadSuit) return false;
    return true;
  }

  playCard(pos, card) {
    if (!this.canPlayCard(pos, card)) return { ok: false, reason: 'illegal_card' };
    const hand = this.seats[pos].hand;
    const idx = hand.findIndex(c => cardEq(c, card));
    const played = hand.splice(idx, 1)[0];

    if (this.leadSuit && played.suit !== this.leadSuit) {
      if (!this.revealedVoidBySeat[pos]) this.revealedVoidBySeat[pos] = [];
      if (!this.revealedVoidBySeat[pos].includes(this.leadSuit)) this.revealedVoidBySeat[pos].push(this.leadSuit);
    }
    if (!this.leadSuit) this.leadSuit = played.suit;
    this.table.push({ seat: pos, card: played });
    this.playedCardsThisHand.push(played);
    this.addLog(`Seat ${pos} played ${played.rank}${played.suit}.`);

    if (this.table.length === SEATS) {
      this._resolveTrick();
    } else {
      this.turn = nextPos(this.turn);
      this._notify();
      this.maybeAutoAct();
    }
    return { ok: true };
  }

  _cardPower(card) {
    const trump = this.currentBid.trump;
    return { isTrump: !!(trump && card.suit === trump), rankIdx: RANKS.indexOf(card.rank) };
  }

  _resolveTrick() {
    let winner = this.table[0];
    let winPow = this._cardPower(winner.card);
    for (let i = 1; i < this.table.length; i++) {
      const p = this.table[i];
      const pow = this._cardPower(p.card);
      let better = false;
      if (pow.isTrump && !winPow.isTrump) better = true;
      else if (pow.isTrump === winPow.isTrump) {
        if (pow.isTrump) better = pow.rankIdx < winPow.rankIdx;
        else if (p.card.suit === this.leadSuit && winner.card.suit === this.leadSuit) better = pow.rankIdx < winPow.rankIdx;
        else if (p.card.suit === this.leadSuit && winner.card.suit !== this.leadSuit) better = true;
      }
      if (better) { winner = p; winPow = pow; }
    }

    const points = this.table.reduce((s, p) => s + RANK_PTS[p.card.rank], 0);
    const team = getTeam(winner.seat);
    this.teamPoints[team] += points;
    this.lastTrick = { cards: this.table.slice(), winnerSeat: winner.seat, points, team };
    this.addLog(`Seat ${winner.seat} wins the trick (+${points}pts) for Team ${teamLetter(team)}.`);

    this.table = [];
    this.leadSuit = null;

    const cardsLeft = this.seats.reduce((s, seat) => s + (seat ? seat.hand.length : 0), 0);
    if (cardsLeft === 0) {
      this._finishHand();
    } else {
      this.turn = winner.seat;
      this._notify();
      this.maybeAutoAct();
    }
  }

  _finishHand() {
    const cb = this.currentBid;
    const bT = getTeam(cb.seat);
    const oT = 1 - bT;
    const made = this.teamPoints[bT] >= cb.value;
    const band = bandFor(cb.value);
    const mult = this.doubled === 2 ? 4 : this.doubled === 1 ? 2 : 1;

    let amt;
    if (made) {
      amt = Math.min(band.win * mult, this.matchScore[oT]);
      this.matchScore[bT] += amt; this.matchScore[oT] -= amt;
      this.addLog(`Team ${teamLetter(bT)} made their bid of ${cb.value}. +${amt} table${amt !== 1 ? 's' : ''}.`);
    } else {
      amt = Math.min(band.lose * mult, this.matchScore[bT]);
      this.matchScore[bT] -= amt; this.matchScore[oT] += amt;
      this.addLog(`Team ${teamLetter(bT)} fell short of ${cb.value}. -${amt} table${amt !== 1 ? 's' : ''}.`);
    }

    this.handResult = {
      made, biddingTeam: bT, bidValue: cb.value, amt, doubled: this.doubled,
      teamPoints: this.teamPoints.slice(), matchScore: this.matchScore.slice()
    };

    if (this.matchScore[0] <= 0 || this.matchScore[1] <= 0) {
      this.matchOver = true;
      this.matchWinner = this.matchScore[0] <= 0 ? 1 : 0;
      this.sessionWins[this.matchWinner] = (this.sessionWins[this.matchWinner] || 0) + 1;
      this.addLog(`Team ${teamLetter(this.matchWinner)} wins the match!`);
    }

    this.phase = 'handEnd';
    this._notify();
  }

  // ---------------- Bots ----------------

  maybeAutoAct() {
    if (this.phase !== 'bidding' && this.phase !== 'play') return;
    const pos = this.turn;
    if (pos === null || pos === undefined) return;
    const seat = this.seats[pos];
    if (!seat) return;
    if (seat.isBot || !seat.connected) {
      const capturedHand = this.handNumber, capturedPos = pos, capturedPhase = this.phase;
      const delay = seat.isBot ? 900 : 10000;
      setTimeout(() => {
        if (this.handNumber !== capturedHand) return;
        if (this.turn !== capturedPos) return;
        if (this.phase !== capturedPhase) return;
        const seatNow = this.seats[capturedPos];
        if (!seatNow || (!seatNow.isBot && seatNow.connected)) return;
        this._botAct(capturedPos);
      }, delay);
    }
  }

  _botAct(pos) {
    if (this.phase === 'bidding' && this.turn === pos) {
      const decision = botDecideBid(this, pos);
      if (decision.action === 'pass') { this.passBid(pos); return; }
      if (decision.action === 'double') { this.doubleBid(pos); return; }
      if (decision.action === 'redouble') { this.redoubleBid(pos); return; }
      if (decision.action === 'bid') {
        const r = this.placeBid(pos, { value: decision.value, trump: decision.trump, kind: decision.kind, order: decision.order });
        if (!r.ok) this.passBid(pos);
        return;
      }
      this.passBid(pos);
    } else if (this.phase === 'play' && this.turn === pos) {
      const legal = this._legalCardsForSeat(pos);
      const card = botChooseCard(this, pos, legal);
      if (card) this.playCard(pos, card);
    }
  }

  // ---------------- Serialization ----------------

  stateFor(viewerPos) {
    return {
      tableId: this.tableId,
      handNumber: this.handNumber,
      dealer: this.dealer,
      turn: this.turn,
      phase: this.phase,
      currentBid: this.currentBid,
      doubled: this.doubled,
      doubledBySeat: this.doubledBySeat,
      passedSeats: this.passedSeats,
      forcedSeat: this.forcedSeat,
      lastActionBySeat: this.lastActionBySeat,
      table: this.table,
      leadSuit: this.leadSuit,
      teamPoints: this.teamPoints,
      matchScore: this.matchScore,
      matchOver: this.matchOver,
      matchWinner: this.matchWinner,
      sessionWins: this.sessionWins,
      lastTrick: this.lastTrick,
      handResult: this.handResult,
      log: this.log.slice(-30).map(l => l.msg),
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

module.exports = { GameEngine56, SUITS, RANKS, RANK_PTS, getTeam, freshDeck, bandFor, SEATS };
