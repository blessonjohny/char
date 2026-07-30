const { rankPlayers, evaluateBest } = require('./poker-hand-eval');

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const SEATS = 9;

function freshDeck() {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) deck.push({ rank: r, suit: s });
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function nextOccupiedSeat(seats, from, requireActive) {
  for (let i = 1; i <= SEATS; i++) {
    const p = (from + i) % SEATS;
    const s = seats[p];
    if (!s) continue;
    if (requireActive && (s.folded || s.sittingOut || s.chips <= 0)) continue;
    return p;
  }
  return -1;
}

class PokerEngine {
  constructor(tableId, opts) {
    this.tableId = tableId;
    this.mode = (opts && opts.mode) || 'cash';
    this.buyInType = (opts && opts.buyInType) || 'nolimit';
    this.smallBlind = (opts && opts.smallBlind) ?? 5;
    this.bigBlind = (opts && opts.bigBlind) ?? 10;
    this.startingChips = (opts && opts.startingChips) ?? 1000;
    this.reloadChips = (opts && opts.reloadChips) ?? 500;
    this.reloadWaitMs = (opts && opts.reloadWaitMs) ?? 60 * 1000;

    this.seats = new Array(SEATS).fill(null);
    this.phase = 'lobby';
    this.dealerSeat = -1;
    this.currentPlayer = -1;
    this.board = [];
    this.deck = [];
    this.pots = [];
    this.currentBet = 0;
    this.minRaise = 0;
    this.lastAggressorSeat = -1;
    this.handNumber = 0;
    this.log = [];
    this.showdownResult = null;
    this.kickRequests = {};
  }

  addLog(msg) {
    this.log.unshift({ text: msg, ts: Date.now() });
    if (this.log.length > 200) this.log.length = 200;
  }

  seatHuman(pos, name, playerId) {
    if (this.seats[pos]) return { ok: false, reason: 'seat_taken' };
    this.seats[pos] = this._freshSeat(name, false, playerId);
    this.addLog(`${name} sat down in seat ${pos + 1}.`);
    return { ok: true };
  }
  seatBot(pos, name) {
    if (this.seats[pos]) return { ok: false, reason: 'seat_taken' };
    this.seats[pos] = this._freshSeat(name, true, null);
    this.addLog(`${name} (bot) sat down in seat ${pos + 1}.`);
    return { ok: true };
  }
  _freshSeat(name, isBot, playerId) {
    return {
      name, isBot, connected: true, playerId,
      chips: this.startingChips, hand: [],
      folded: false, allIn: false, sittingOut: false,
      bettedThisRound: 0, totalBetThisHand: 0, hasActed: false,
      bustedAt: null, rebuysUsed: 0, eliminated: false
    };
  }
  removeSeat(pos) {
    const s = this.seats[pos];
    if (!s) return;
    this.addLog(`${s.name} left seat ${pos + 1}.`);
    this.seats[pos] = null;
  }

  requestKick(pos, requestedBy) {
    if (!this.seats[pos]) return { ok: false, reason: 'no_seat' };
    this.kickRequests[pos] = { requestedBy, atHandNumber: this.handNumber };
    this.addLog(`${this.seats[pos].name} will be removed once this hand finishes.`);
    return { ok: true };
  }
  cancelKick(pos) {
    if (this.kickRequests[pos]) {
      delete this.kickRequests[pos];
      this.addLog(`Removal of ${this.seats[pos] ? this.seats[pos].name : 'seat ' + (pos + 1)} was cancelled.`);
      return { ok: true };
    }
    return { ok: false, reason: 'no_pending_kick' };
  }
  _applyPendingKicks() {
    for (const pos of Object.keys(this.kickRequests)) this.removeSeat(Number(pos));
    this.kickRequests = {};
  }

  occupiedSeats() { return this.seats.map((s, i) => s ? i : null).filter(i => i !== null); }
  activeSeats() { return this.seats.map((s, i) => (s && !s.sittingOut && s.chips > 0) ? i : null).filter(i => i !== null); }

  startHand() {
    this._applyPendingKicks();
    const active = this.activeSeats();
    if (active.length < 2) { this.phase = 'lobby'; this.addLog('Not enough players with chips to start a hand.'); return; }

    this.handNumber++;
    this.deck = freshDeck();
    this.board = [];
    this.pots = [];
    this.currentBet = 0;
    this.showdownResult = null;

    for (const pos of this.occupiedSeats()) {
      const s = this.seats[pos];
      s.hand = [];
      s.folded = s.sittingOut || s.chips <= 0;
      s.allIn = false;
      s.bettedThisRound = 0;
      s.totalBetThisHand = 0;
      s.hasActed = false;
    }

    this.dealerSeat = this.dealerSeat === -1 ? active[0] : nextOccupiedSeat(this.seats, this.dealerSeat, true);
    if (this.dealerSeat === -1) this.dealerSeat = active[0];

    const order = this._seatOrderFrom(this.dealerSeat);
    for (let round = 0; round < 2; round++) {
      for (const pos of order) this.seats[pos].hand.push(this.deck.pop());
    }

    const sbSeat = order[0];
    const bbSeat = order.length > 1 ? order[1] : order[0];
    this._postBlind(sbSeat, this.smallBlind);
    this._postBlind(bbSeat, this.bigBlind);
    this.currentBet = this.bigBlind;
    this.minRaise = this.bigBlind;
    this.lastAggressorSeat = bbSeat;

    this.phase = 'preflop';
    this.currentPlayer = order.length > 2 ? order[2] : order[0];
    this.addLog(`Hand ${this.handNumber} started. Dealer seat ${this.dealerSeat + 1}.`);
    this._advanceIfCurrentCantAct();
  }

  _seatOrderFrom(dealerSeat) {
    const order = [];
    let p = dealerSeat;
    for (let i = 0; i < SEATS; i++) {
      p = nextOccupiedSeat(this.seats, p, true);
      if (p === -1 || order.includes(p)) break;
      order.push(p);
    }
    return order;
  }

  _postBlind(seat, amount) {
    const s = this.seats[seat];
    const posted = Math.min(amount, s.chips);
    s.chips -= posted;
    s.bettedThisRound += posted;
    s.totalBetThisHand += posted;
    if (s.chips === 0) s.allIn = true;
    this.addLog(`${s.name} posts ${posted}${posted < amount ? ' (all-in)' : ''}.`);
  }

  act(pos, action, amount) {
    if (pos !== this.currentPlayer) return { ok: false, reason: 'not_your_turn' };
    if (!['fold', 'check', 'call', 'bet', 'raise', 'allin'].includes(action)) return { ok: false, reason: 'bad_action' };
    const s = this.seats[pos];
    if (!s || s.folded) return { ok: false, reason: 'no_seat' };

    const toCall = this.currentBet - s.bettedThisRound;

    if (action === 'fold') {
      s.folded = true;
      this.addLog(`${s.name} folds.`);
    } else if (action === 'check') {
      if (toCall > 0) return { ok: false, reason: 'must_call_or_fold' };
      this.addLog(`${s.name} checks.`);
    } else if (action === 'call') {
      const pay = Math.min(toCall, s.chips);
      s.chips -= pay; s.bettedThisRound += pay; s.totalBetThisHand += pay;
      if (s.chips === 0) s.allIn = true;
      this.addLog(`${s.name} calls ${pay}${s.allIn ? ' (all-in)' : ''}.`);
    } else if (action === 'bet' || action === 'raise') {
      if (this.buyInType === 'fixed') amount = this.currentBet > 0 ? this.currentBet + this.bigBlind : this.bigBlind;
      const targetTotal = Math.max(amount || 0, this.currentBet + this.minRaise);
      const pay = Math.min(targetTotal - s.bettedThisRound, s.chips);
      if (pay <= 0) return { ok: false, reason: 'bad_amount' };
      const newRaiseSize = (s.bettedThisRound + pay) - this.currentBet;
      s.chips -= pay; s.bettedThisRound += pay; s.totalBetThisHand += pay;
      if (s.chips === 0) s.allIn = true;
      if (s.bettedThisRound > this.currentBet) {
        this.minRaise = Math.max(this.minRaise, newRaiseSize);
        this.currentBet = s.bettedThisRound;
        this.lastAggressorSeat = pos;
        for (const p of this.occupiedSeats()) if (p !== pos && !this.seats[p].folded) this.seats[p].hasActed = false;
      }
      this.addLog(`${s.name} ${action === 'bet' ? 'bets' : 'raises to'} ${s.bettedThisRound}${s.allIn ? ' (all-in)' : ''}.`);
    } else if (action === 'allin') {
      const pay = s.chips;
      s.chips = 0; s.bettedThisRound += pay; s.totalBetThisHand += pay; s.allIn = true;
      if (s.bettedThisRound > this.currentBet) {
        this.minRaise = Math.max(this.minRaise, s.bettedThisRound - this.currentBet);
        this.currentBet = s.bettedThisRound;
        this.lastAggressorSeat = pos;
        for (const p of this.occupiedSeats()) if (p !== pos && !this.seats[p].folded) this.seats[p].hasActed = false;
      }
      this.addLog(`${s.name} goes all-in for ${pay}.`);
    }

    s.hasActed = true;
    this._afterAction();
    return { ok: true };
  }

  _stillContesting() {
    return this.occupiedSeats().filter(p => !this.seats[p].folded);
  }

  _afterAction() {
    const contesting = this._stillContesting();
    if (contesting.length === 1) { this._awardPotToSingleWinner(contesting[0]); return; }
    if (this._bettingRoundComplete()) { this._collectBetsIntoPots(); this._advanceStreet(); return; }
    this.currentPlayer = nextOccupiedSeat(this.seats, this.currentPlayer, true);
    this._advanceIfCurrentCantAct();
  }

  _bettingRoundComplete() {
    const contesting = this._stillContesting();
    for (const p of contesting) {
      const s = this.seats[p];
      if (s.allIn) continue;
      if (!s.hasActed) return false;
      if (s.bettedThisRound < this.currentBet) return false;
    }
    return true;
  }

  _advanceIfCurrentCantAct() {
    const contesting = this._stillContesting();
    if (contesting.length <= 1) { if (contesting.length === 1) this._awardPotToSingleWinner(contesting[0]); return; }
    const canAct = contesting.filter(p => !this.seats[p].allIn);
    if (canAct.length === 0) {
      this._collectBetsIntoPots();
      this._runOutRemainingStreets();
      return;
    }
    if (this.seats[this.currentPlayer] && (this.seats[this.currentPlayer].folded || this.seats[this.currentPlayer].allIn)) {
      this.currentPlayer = nextOccupiedSeat(this.seats, this.currentPlayer, true);
      this._advanceIfCurrentCantAct();
    }
  }

  _collectBetsIntoPots() {
    const contributors = this.occupiedSeats().filter(p => this.seats[p].totalBetThisHand > 0);
    if (contributors.length === 0) { for (const p of this.occupiedSeats()) this.seats[p].bettedThisRound = 0; return; }
    const levels = [...new Set(contributors.map(p => this.seats[p].totalBetThisHand))].sort((a, b) => a - b);
    this.pots = [];
    let prevLevel = 0;
    for (const level of levels) {
      const layerContributors = contributors.filter(p => this.seats[p].totalBetThisHand >= level);
      const layerAmount = (level - prevLevel) * layerContributors.length;
      if (layerAmount > 0) {
        const eligibleSeats = layerContributors.filter(p => !this.seats[p].folded);
        this.pots.push({ amount: layerAmount, eligibleSeats });
      }
      prevLevel = level;
    }
    const merged = [];
    for (const pot of this.pots) {
      const last = merged[merged.length - 1];
      if (last && last.eligibleSeats.length === pot.eligibleSeats.length && last.eligibleSeats.every(s => pot.eligibleSeats.includes(s))) {
        last.amount += pot.amount;
      } else {
        merged.push(pot);
      }
    }
    this.pots = merged;
    for (const p of this.occupiedSeats()) this.seats[p].bettedThisRound = 0;
  }

  totalPot() { return this.pots.reduce((s, p) => s + p.amount, 0); }

  _awardPotToSingleWinner(pos) {
    this._collectBetsIntoPots();
    const total = this.totalPot();
    this.seats[pos].chips += total;
    this.addLog(`${this.seats[pos].name} wins ${total} (everyone else folded).`);
    this.showdownResult = { winners: [{ seat: pos, amount: total, handName: null }], boardShown: false };
    this.phase = 'handEnd';
    this.pots = [];
    this.markBustedPlayers();
  }

  _advanceStreet() {
    if (this.phase === 'preflop') { this._dealBoard(3); this.phase = 'flop'; }
    else if (this.phase === 'flop') { this._dealBoard(1); this.phase = 'turn'; }
    else if (this.phase === 'turn') { this._dealBoard(1); this.phase = 'river'; }
    else if (this.phase === 'river') { this._goToShowdown(); return; }

    this.currentBet = 0;
    this.minRaise = this.bigBlind;
    this.lastAggressorSeat = -1;
    for (const p of this.occupiedSeats()) { this.seats[p].hasActed = false; this.seats[p].bettedThisRound = 0; }
    this.currentPlayer = nextOccupiedSeat(this.seats, this.dealerSeat, true);
    this.addLog(`-- ${this.phase} --`);
    this._advanceIfCurrentCantAct();
  }

  _runOutRemainingStreets() {
    while (this.phase !== 'river' && this.phase !== 'showdown') {
      if (this.phase === 'preflop') this._dealBoard(3);
      else this._dealBoard(1);
      this.phase = this.phase === 'preflop' ? 'flop' : this.phase === 'flop' ? 'turn' : 'river';
    }
    this._goToShowdown();
  }

  _dealBoard(n) { for (let i = 0; i < n; i++) this.board.push(this.deck.pop()); }

  _goToShowdown() {
    this.phase = 'showdown';
    const contesting = this._stillContesting();
    const ranked = rankPlayers(contesting.map(p => this.seats[p].hand), this.board);
    const rankedBySeat = ranked.map(r => ({ seat: contesting[r.index], score: r.score, handName: r.handName, hand: r.hand }));

    const winners = [];
    for (const pot of this.pots) {
      const eligibleRanked = rankedBySeat.filter(r => pot.eligibleSeats.includes(r.seat));
      if (eligibleRanked.length === 0) continue;
      const bestScore = eligibleRanked[0].score;
      const potWinners = eligibleRanked.filter(r => JSON.stringify(r.score) === JSON.stringify(bestScore));
      const share = Math.floor(pot.amount / potWinners.length);
      let remainder = pot.amount - share * potWinners.length;
      const order = this._seatOrderFrom(this.dealerSeat);
      potWinners.sort((a, b) => order.indexOf(a.seat) - order.indexOf(b.seat));
      for (const w of potWinners) {
        const amount = share + (remainder > 0 ? 1 : 0);
        if (remainder > 0) remainder--;
        this.seats[w.seat].chips += amount;
        winners.push({ seat: w.seat, amount, handName: w.handName, hand: w.hand });
        this.addLog(`${this.seats[w.seat].name} wins ${amount} with ${w.handName}.`);
      }
    }
    this.showdownResult = { winners, boardShown: true, board: this.board.slice(), allHands: rankedBySeat };
    this.phase = 'handEnd';
    this.pots = [];
    this.markBustedPlayers();
  }

  // Reload/rebuy rules are genuinely different between the two modes,
  // not just a cosmetic label:
  //  - Cash game: anyone (human or bot) can keep reloading indefinitely
  //    after the wait, at reloadChips each time -- an ordinary cash
  //    table where you can always buy back in.
  //  - Tournament: humans get exactly ONE rebuy, for the SAME amount
  //    they originally started with (not half, not double) -- standard
  //    single-rebuy tournament rules. Bots get none at all; once a bot
  //    busts in a tournament it's simply eliminated and sits out for
  //    the rest of the table, same as it would be in a real one.
  checkReloads() {
    const now = Date.now();
    for (const p of this.occupiedSeats()) {
      const s = this.seats[p];
      if (s.chips > 0 || s.sittingOut || !s.bustedAt) continue;
      if (now - s.bustedAt < this.reloadWaitMs) continue;

      if (this.mode === 'tournament') {
        if (s.isBot) {
          s.sittingOut = true;
          s.eliminated = true;
          s.bustedAt = null;
          this.addLog(`${s.name} is eliminated from the tournament.`);
        } else if (s.rebuysUsed < 1) {
          s.chips = this.startingChips;
          s.rebuysUsed++;
          s.bustedAt = null;
          this.addLog(`${s.name} rebuys for ${this.startingChips} (1 rebuy used).`);
        } else {
          s.sittingOut = true;
          s.eliminated = true;
          s.bustedAt = null;
          this.addLog(`${s.name} is eliminated from the tournament (rebuy already used).`);
        }
      } else {
        s.chips = this.reloadChips;
        s.bustedAt = null;
        this.addLog(`${s.name} reloaded with ${this.reloadChips} chips after the wait.`);
      }
    }
  }
  markBustedPlayers() {
    for (const p of this.occupiedSeats()) {
      const s = this.seats[p];
      if (s.chips <= 0 && !s.bustedAt && !s.eliminated) s.bustedAt = Date.now();
    }
  }

  getStateFor(viewerPos) {
    let myHandName = null;
    const viewerSeat = this.seats[viewerPos];
    if (viewerSeat && viewerSeat.hand.length === 2 && this.board.length >= 3 && !viewerSeat.folded) {
      myHandName = evaluateBest([...viewerSeat.hand, ...this.board]).handName;
    }
    return {
      tableId: this.tableId, mode: this.mode, buyInType: this.buyInType,
      smallBlind: this.smallBlind, bigBlind: this.bigBlind,
      phase: this.phase, dealerSeat: this.dealerSeat, currentPlayer: this.currentPlayer,
      board: this.board, pots: this.pots, currentBet: this.currentBet, minRaise: this.minRaise,
      handNumber: this.handNumber, showdownResult: this.showdownResult, myHandName,
      kickRequests: this.kickRequests,
      seats: this.seats.map((s, i) => {
        if (!s) return null;
        const isMe = i === viewerPos;
        const revealHand = isMe || (this.phase === 'handEnd' && this.showdownResult && this.showdownResult.boardShown && !s.folded);
        return {
          name: s.name, isBot: s.isBot, connected: s.connected, chips: s.chips,
          folded: s.folded, allIn: s.allIn, sittingOut: s.sittingOut,
          bettedThisRound: s.bettedThisRound, totalBetThisHand: s.totalBetThisHand,
          bustedAt: s.bustedAt, eliminated: s.eliminated, rebuysUsed: s.rebuysUsed,
          hand: revealHand ? s.hand : (s.hand.length ? s.hand.map(() => null) : [])
        };
      }),
      log: this.log.slice(0, 30)
    };
  }
}

module.exports = { PokerEngine, SEATS, freshDeck };
