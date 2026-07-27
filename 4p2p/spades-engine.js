// ============================================================
// Spades — authoritative server-side engine.
// Ported from a client-only, host-authoritative P2P build (whichever
// player's browser was "host" ran the real rules and broadcast deltas
// to everyone else) into the same server-authoritative pattern already
// proven for the other games here: the SERVER runs every rule, deals
// every card, and each client only ever gets sent its own hand plus a
// public view of everything else. Matches game-engine.js's exact
// conventions (seatHuman/seatBot/replaceBot/takeOverSeat/stateFor)
// intentionally, so the table/socket wiring on the server side and the
// reconnect-by-token behavior on the client side work identically to
// every other game already on this platform.
// ============================================================

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
const WINSCORE = 300;
const NILBON = 100;
const BAGPEN = 10;

function freshDeck() {
  const d = [];
  for (let s = 0; s < 4; s++) for (const r of RANKS) d.push({ suit: s, rank: r });
  return d;
}
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function sameCard(a, b) { return a.suit === b.suit && a.rank === b.rank; }
function team(pos) { return pos % 2; }

class SpadesEngine {
  constructor(tableId) {
    this.tableId = tableId;
    this.seats = [null, null, null, null]; // { name, isBot, connected, playerId, hand }
    this.dealer = Math.floor(Math.random() * 4);
    this.handN = 0;
    this.tScore = [0, 0];
    this.tBags = [0, 0];
    this.phase = 'lobby'; // lobby | bidding | playing | roundEnd
    this.bids = [null, null, null, null];
    this.trkTaken = [0, 0, 0, 0];
    this.trkCards = []; // [{player, card}]
    this.trkSuit = null;
    this.spdBroken = false;
    this.curP = 0;
    this.lastTrick = null;
    this.lastHandSummary = null; // rows + winner, built once per completed hand for the client to show
    this.log = [];
    this.onChange = null;
  }

  _notify() {
    if (this.onChange) { try { this.onChange(); } catch (e) { console.error('Spades onChange handler error:', e); } }
    this.maybeAutoAct();
  }

  emptySeats() {
    const out = [];
    for (let i = 0; i < 4; i++) if (!this.seats[i]) out.push(i);
    return out;
  }
  humanCount() { return this.seats.filter(s => s && !s.isBot).length; }

  seatHuman(pos, name, playerId) { this.seats[pos] = { name, isBot: false, connected: true, playerId, hand: [] }; }
  seatBot(pos, name) { this.seats[pos] = { name, isBot: true, connected: true, playerId: null, hand: [] }; }
  removeSeat(pos) { this.seats[pos] = null; }

  convertToBot(pos) {
    const seat = this.seats[pos];
    if (!seat || seat.isBot) return false;
    seat.isBot = true; seat.connected = true; seat.playerId = null;
    return true;
  }
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

  canStart() { return this.seats.filter(Boolean).length === 4; } // fixed partnerships -- Spades needs all 4 seats filled (human or bot), not just 2

  // ---------------- Round lifecycle ----------------

  startRound() {
    const deck = shuffle(freshDeck());
    const hands = [[], [], [], []];
    for (let i = 0; i < 52; i++) hands[(this.dealer + 1 + i) % 4].push(deck[i]);
    // Display order left-to-right: hearts, clubs, diamonds, spades (suit
    // indices are 0=spades, 1=hearts, 2=diamonds, 3=clubs).
    const suitDisplayOrder = { 1: 0, 3: 1, 2: 2, 0: 3 };
    for (const h of hands) h.sort((a, b) => (a.suit !== b.suit ? suitDisplayOrder[a.suit] - suitDisplayOrder[b.suit] : b.rank - a.rank));
    for (let i = 0; i < 4; i++) if (this.seats[i]) this.seats[i].hand = hands[i];
    this.phase = 'bidding';
    this.bids = [null, null, null, null];
    this.trkTaken = [0, 0, 0, 0];
    this.trkCards = [];
    this.trkSuit = null;
    this.spdBroken = false;
    this.lastTrick = null;
    this.lastHandSummary = null;
    this.curP = (this.dealer + 1) % 4;
    this.handN++;
    this.log.push(`Hand ${this.handN} dealt, dealer seat ${this.dealer}.`);
    this._notify();
  }

  restartGame() {
    this.tScore = [0, 0]; this.tBags = [0, 0]; this.handN = 0;
    this.dealer = Math.floor(Math.random() * 4);
    this.startRound();
  }

  placeBid(pos, bid) {
    if (this.phase !== 'bidding' || pos !== this.curP || this.bids[pos] !== null) return false;
    if (bid !== 'nil') {
      const n = parseInt(bid, 10);
      if (!Number.isFinite(n) || n < 0 || n > 13) return false;
      bid = n;
    }
    this.bids[pos] = bid;
    this.log.push(`${this.seats[pos] ? this.seats[pos].name : 'Seat ' + pos} bids ${bid === 'nil' ? 'NIL' : bid}.`);
    if (this.bids.every(b => b !== null)) {
      this.phase = 'playing';
      this.curP = (this.dealer + 1) % 4;
      this.trkCards = [];
    } else {
      this.curP = (this.curP + 1) % 4;
    }
    this._notify();
    return true;
  }

  canPlayCard(pos, card) {
    if (this.phase !== 'playing' || pos !== this.curP) return false;
    const seat = this.seats[pos];
    if (!seat) return false;
    const idx = seat.hand.findIndex(c => sameCard(c, card));
    if (idx < 0) return false;
    if (this.trkCards.length === 0) {
      // Leading a trick: can't lead spades until they've been "broken"
      // (played on a non-spade-led trick before), unless the hand is
      // literally nothing but spades.
      if (card.suit === 0 && !this.spdBroken && seat.hand.some(c => c.suit !== 0)) return false;
      return true;
    }
    const hasSuit = seat.hand.some(c => c.suit === this.trkSuit);
    if (hasSuit && card.suit !== this.trkSuit) return false;
    return true;
  }

  playCard(pos, card) {
    if (!this.canPlayCard(pos, card)) return false;
    const seat = this.seats[pos];
    const idx = seat.hand.findIndex(c => sameCard(c, card));
    seat.hand.splice(idx, 1);
    if (this.trkCards.length === 0) this.trkSuit = card.suit;
    if (card.suit === 0) this.spdBroken = true;
    this.trkCards.push({ player: pos, card });
    this.log.push(`${seat.name} plays ${card.rank}${SUITS[card.suit]}.`);
    if (this.trkCards.length === 4) {
      this._endTrick();
    } else {
      this.curP = (this.curP + 1) % 4;
    }
    this._notify();
    return true;
  }

  _trickWinner() {
    let w = this.trkCards[0];
    for (const tc of this.trkCards) {
      const c = tc.card, wc = w.card;
      if (c.suit === 0 && wc.suit !== 0) { w = tc; continue; }
      if (c.suit === wc.suit && c.rank > wc.rank) w = tc;
    }
    return w;
  }

  _endTrick() {
    const winner = this._trickWinner();
    this.trkTaken[winner.player]++;
    this.lastTrick = { cards: this.trkCards.slice(), winner: winner.player };
    this.log.push(`${this.seats[winner.player].name} wins the trick.`);
    this.trkCards = [];
    this.trkSuit = null;
    this.curP = winner.player;
    if (this.seats.every(s => s && s.hand.length === 0)) {
      this._scoreRound();
    }
  }

  _scoreRound() {
    this.phase = 'roundEnd';
    const rows = [];
    const delta = [0, 0];
    for (let t = 0; t < 2; t++) {
      const members = [0, 1, 2, 3].filter(p => team(p) === t);
      const teamBid = members.reduce((s, p) => s + (this.bids[p] === 'nil' ? 0 : (this.bids[p] || 0)), 0);
      const teamTricks = members.reduce((s, p) => s + this.trkTaken[p], 0);
      let pts = 0;
      if (teamTricks >= teamBid) {
        pts = teamBid * 10;
        const bags = teamTricks - teamBid;
        pts += bags;
        this.tBags[t] += bags;
        if (this.tBags[t] >= BAGPEN) { pts -= 100; this.tBags[t] -= BAGPEN; }
      } else {
        pts = -(teamBid * 10);
      }
      delta[t] += pts;
      rows.push({ team: t, label: `Team ${t === 0 ? 'A' : 'B'} bid ${teamBid}, got ${teamTricks}`, pts });
    }
    for (let p = 0; p < 4; p++) {
      if (this.bids[p] === 'nil') {
        const made = this.trkTaken[p] === 0;
        const pts = made ? NILBON : -NILBON;
        delta[team(p)] += pts;
        rows.push({ team: team(p), label: `${this.seats[p].name} NIL ${made ? 'made' : 'failed'}`, pts });
      }
    }
    this.tScore[0] += delta[0]; this.tScore[1] += delta[1];
    const winner = (this.tScore[0] >= WINSCORE && this.tScore[0] > this.tScore[1]) ? 0
      : (this.tScore[1] >= WINSCORE && this.tScore[1] > this.tScore[0]) ? 1 : -1;
    this.lastHandSummary = { rows, tScore: this.tScore.slice(), winner };
    this.log.push(`Hand complete. Score: ${this.tScore[0]} - ${this.tScore[1]}${winner >= 0 ? ` — Team ${winner === 0 ? 'A' : 'B'} wins!` : ''}`);
    if (winner < 0) this.dealer = (this.dealer + 1) % 4; // only advance the dealer if the match continues
    this._notify();
  }

  nextHand() {
    if (this.phase !== 'roundEnd') return false;
    if (this.lastHandSummary && this.lastHandSummary.winner >= 0) { this.restartGame(); return true; }
    this.startRound();
    return true;
  }

  // ---------------- Bots (and disconnected humans, same auto-play path) ----------------

  _botBid(pos) {
    const hand = this.seats[pos].hand;
    let est = 0;
    for (const c of hand) {
      if (c.rank === 14) est += 1;
      else if (c.rank === 13) est += 0.75;
      else if (c.rank === 12) est += 0.4;
    }
    const spadeCount = hand.filter(c => c.suit === 0).length;
    est += Math.max(0, spadeCount - 2) * 0.6;
    for (let s = 1; s < 4; s++) if (!hand.some(c => c.suit === s)) est += 0.5;
    let bid = Math.round(est);
    bid = Math.max(1, Math.min(bid, hand.length));
    if (est < 0.5 && Math.random() < 0.3) return 'nil';
    return bid;
  }

  _botPlay(pos) {
    const hand = this.seats[pos].hand;
    if (!hand.length) return null;
    let card = null;
    if (this.trkCards.length === 0) {
      const nonSpades = hand.filter(c => c.suit !== 0);
      const pool = (!this.spdBroken && nonSpades.length) ? nonSpades : hand;
      card = pool.slice().sort((a, b) => b.rank - a.rank)[0];
    } else {
      const canFollow = hand.filter(c => c.suit === this.trkSuit);
      if (canFollow.length) {
        const tw = this._trickWinner();
        if (team(tw.player) === team(pos)) {
          card = canFollow.slice().sort((a, b) => a.rank - b.rank)[0];
        } else {
          const canWin = canFollow.filter(c => c.rank > tw.card.rank);
          card = canWin.length ? canWin.slice().sort((a, b) => a.rank - b.rank)[0] : canFollow.slice().sort((a, b) => a.rank - b.rank)[0];
        }
      } else {
        const spades = hand.filter(c => c.suit === 0);
        const tw = this._trickWinner();
        if (spades.length && team(tw.player) !== team(pos)) {
          card = spades.slice().sort((a, b) => a.rank - b.rank)[0];
        } else {
          const discard = hand.filter(c => c.suit !== 0);
          card = (discard.length ? discard : hand).slice().sort((a, b) => a.rank - b.rank)[0];
        }
      }
    }
    if (this.bids[pos] === 'nil' && this.trkCards.length > 0) {
      const tw = this._trickWinner();
      if (team(tw.player) !== team(pos)) card = hand.slice().sort((a, b) => a.rank - b.rank)[0];
    }
    return card;
  }

  // Self-schedules: called once after any state change (via onChange),
  // and re-arms itself after every bot/auto action too, so the table
  // keeps moving on its own without the server needing to remember to
  // re-check after every single event. Re-validates everything at
  // fire-time, not just at schedule-time, since a human could reconnect
  // or the round could move on during the delay.
  maybeAutoAct() {
    const seat = this.seats[this.curP];
    if (!seat) return false;
    if (!(seat.isBot || !seat.connected)) return false;
    if (this._autoActTimer) return false; // already scheduled, don't double-arm
    const capturedPos = this.curP;
    const capturedHand = this.handN;
    const capturedPhase = this.phase;
    this._autoActTimer = setTimeout(() => {
      this._autoActTimer = null;
      if (this.handN !== capturedHand || this.phase !== capturedPhase) return;
      if (this.curP !== capturedPos) return;
      const seatNow = this.seats[capturedPos];
      if (!seatNow || (!seatNow.isBot && seatNow.connected)) return;
      if (this.phase === 'bidding') this.placeBid(capturedPos, this._botBid(capturedPos));
      else if (this.phase === 'playing') {
        const card = this._botPlay(capturedPos);
        if (card) this.playCard(capturedPos, card);
      }
    }, seat.isBot ? 900 : 20000); // bots act at a watchable pace; a disconnected human gets a real grace period for a brief network blip before anything is played for them
    return true;
  }

  stateFor(viewerPos) {
    return {
      tableId: this.tableId,
      handN: this.handN,
      phase: this.phase,
      dealer: this.dealer,
      curP: this.curP,
      bids: this.bids,
      trkTaken: this.trkTaken,
      trkCards: this.trkCards,
      trkSuit: this.trkSuit,
      spdBroken: this.spdBroken,
      lastTrick: this.lastTrick,
      lastHandSummary: this.lastHandSummary,
      tScore: this.tScore,
      tBags: this.tBags,
      seats: this.seats.map((s, i) => s ? {
        name: s.name, isBot: s.isBot, connected: s.connected,
        cardCount: s.hand.length,
        hand: i === viewerPos ? s.hand : undefined
      } : null)
    };
  }
}

module.exports = { SpadesEngine, SUITS, RANKS, WINSCORE, NILBON, BAGPEN, freshDeck };
