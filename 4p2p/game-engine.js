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

class GameEngine {
  constructor(tableId) {
    this.tableId = tableId;
    // seats[i] = { name, isBot, connected, hand: [cards] } for i in 0..3
    this.seats = [null, null, null, null];
    this.round = 0;
    this.gameScore = [6, 6]; // match score, team 0 / team 1 (mirrors client default)
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
    this.hiddenTrump = null; // {suit, rank, points}
    this.hiddenTrumpOwner = -1; // who physically hid it — NOT necessarily this.bidder, since a phase-2 raise can change the bidder while the original chooser still holds the hidden card
    this.trickCards = []; // [{pos, card}]
    this.trickSuit = '';
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
    this._startPhase2();
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
    return this._afterPhase2Action();
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
    return true;
  }

  playCard(pos, card) {
    if (!this.canPlayCard(pos, card)) return { ok: false, reason: 'illegal_card' };
    const hand = this.seats[pos].hand;
    const idx = hand.findIndex(c => cardEq(c, card));
    const played = hand.splice(idx, 1)[0];
    if (this.trickSuit === '') this.trickSuit = played.suit;
    this.trickCards.push({ pos, card: played });

    // Trump exposure: playing a trump card while unable to follow the led
    // suit exposes it automatically (the classic forced-reveal case).
    if (!this.trumpExposed && played.suit === this.trumpSuit && this.trickSuit !== this.trumpSuit) {
      this.exposeTrump();
    }

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
    let w = this.trickCards[0];
    for (let i = 1; i < this.trickCards.length; i++) {
      const tc = this.trickCards[i];
      if (this.trumpExposed) {
        if (tc.card.suit === this.trumpSuit && w.card.suit !== this.trumpSuit) w = tc;
        else if (tc.card.suit === w.card.suit && RANK_ORDER[tc.card.rank] > RANK_ORDER[w.card.rank]) w = tc;
      } else if (tc.card.suit === w.card.suit && RANK_ORDER[tc.card.rank] > RANK_ORDER[w.card.rank]) {
        w = tc;
      }
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

    // Every bot that played into this trick learns from the outcome —
    // won it or didn't, and how many points were on the line.
    for (const tc of this.trickCards) {
      const seatTc = this.seats[tc.pos];
      if (!seatTc || !seatTc.isBot) continue;
      const won = tc.pos === winner.pos;
      brain.recordTrickOutcome(seatTc.name, { trickLen: this.trickCards.length }, tc.card, won, points);
    }

    this.tricksPlayed++;
    this.trickCards = [];
    this.trickSuit = '';

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
      }
      brain.recordRound(seatI.name, wonRound);
    }
    this._bidderHandProfileForLearning = null;
    // Flush to disk right here rather than relying purely on the periodic
    // timer — round-ends are infrequent enough that this costs nothing
    // meaningful, and frequent enough that an unexpected restart (a Render
    // redeploy, a crash, anything that skips the graceful-shutdown save
    // handlers) can never lose more than the tricks within a single round.
    brain.saveBrains();

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
      setTimeout(() => {
        // If the round has already moved on (shouldn't happen mid-trick,
        // but safe to guard against a stale timer from something like a
        // fast-forwarded test), don't act on outdated state.
        if (this.round === capturedRound) this._botAct(capturedPos);
      }, 650);
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

      // Same hand analysis as the original client's botBid1WithBrain.
      let totalPoints = 0, hasJ = false, has9 = false, aceCount = 0, tenCount = 0, jSuit = '';
      for (const c of hand) {
        totalPoints += c.points;
        if (c.rank === 'J') { hasJ = true; jSuit = c.suit; }
        if (c.rank === '9') has9 = true;
        if (c.rank === 'A') aceCount++;
        if (c.rank === '10') tenCount++;
      }
      let est = totalPoints * 2 * b.bidWeights.pointCards;
      if (hasJ && has9 && jSuit && hand.some(c => c.suit === jSuit && c.rank === '9')) {
        est += 3 * b.bidWeights.highCards;
      } else if (has9 && !hasJ) {
        est -= 2;
      }
      if (aceCount >= 2) est += 2 * b.bidWeights.highCards;
      if (tenCount >= 2) est += 1 * b.bidWeights.highCards;
      let pb = 0;
      if (this.bidder >= 0 && getTeam(this.bidder) === getTeam(pos)) pb = 2 * b.bidWeights.partnerSupport;
      est += (b.level - 1) * b.bidWeights.aggression;
      let target = Math.min(28, Math.max(14, Math.floor(est + pb)));

      // Pattern memory: has this bot seen a similar hand work out before?
      // A higher level leans on learned patterns more often, mirroring the
      // original's Math.random() < 0.3*level.
      const handProfile = brain.getHandProfile(hand);
      const similarBids = b.patterns.successfulBids.filter(sb => {
        const hp = sb.handProfile;
        return Math.abs(hp.totalPoints - handProfile.totalPoints) <= 2 &&
               Math.abs(hp.highCardCount - handProfile.highCardCount) <= 1;
      });
      if (similarBids.length > 0 && Math.random() < 0.3 * b.level) {
        const avgBid = similarBids.reduce((s, sb) => s + sb.bid, 0) / similarBids.length;
        target = Math.round(avgBid);
      }

      let bid = 0;
      if (first) {
        bid = Math.max(14, Math.min(target, 20));
      } else if (minBid <= target && minBid <= 28) {
        bid = minBid <= target - 2 ? minBid + 1 : minBid;
      }
      // First bidder cannot pass — must bid at least 14 regardless of what
      // the brain's estimate came out to.
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
      // Faithful port of the reference's botPhase2WithBrain.
      const b = brain.getBrain(this.seats[pos].name);
      const hand = this.seats[pos].hand; // full 8 cards by now
      const myTeam = getTeam(pos), bidTeam = getTeam(this.bidder), isBT = myTeam === bidTeam;
      let tp = 0;
      const ss = {};
      for (const s of SUITS) ss[s] = { points: 0, hasJ: false, has9: false };
      for (const c of hand) {
        tp += c.points;
        ss[c.suit].points += c.points;
        if (c.rank === 'J') ss[c.suit].hasJ = true;
        if (c.rank === '9') ss[c.suit].has9 = true;
      }
      let est = tp;
      if (ss[this.trumpSuit] && ss[this.trumpSuit].hasJ) est += 2 * b.bidWeights.highCards;
      if (ss[this.trumpSuit] && ss[this.trumpSuit].has9) { est += ss[this.trumpSuit].hasJ ? 1 : -1; }
      est += (b.level - 1) * b.bidWeights.aggression;

      const minRaise = Math.max(20, this.highestBid + 1);
      let raised = false;
      if (isBT) {
        let tr = 0;
        if (est >= 22 && minRaise <= 20) tr = 20;
        else if (est >= 24 && minRaise <= 22) tr = 22;
        else if (est >= 26 && minRaise <= 24) tr = 24;
        else if (est >= 27 && minRaise <= 26) tr = 26;
        else if (est >= 28 && minRaise <= 28) tr = 28;
        if (tr > 0 && tr >= minRaise) raised = !!this.raiseBid(pos, tr).ok;
      } else if (est >= 24 && minRaise <= 22 && Math.random() < 0.3 * b.level) {
        raised = !!this.raiseBid(pos, Math.max(22, minRaise)).ok;
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

  // Who's winning the CURRENT (in-progress) trick so far — used by bot
  // play logic to decide whether to contest it. Not to be confused with
  // _trickWinner(), which is only called once a trick is complete.
  _currentTrickWinnerSoFar() {
    if (this.trickCards.length === 0) return null;
    let w = this.trickCards[0];
    for (let i = 1; i < this.trickCards.length; i++) {
      const tc = this.trickCards[i];
      if (this.trumpExposed) {
        if (tc.card.suit === this.trumpSuit && w.card.suit !== this.trumpSuit) w = tc;
        else if (tc.card.suit === w.card.suit && RANK_ORDER[tc.card.rank] > RANK_ORDER[w.card.rank]) w = tc;
      } else if (tc.card.suit === w.card.suit && RANK_ORDER[tc.card.rank] > RANK_ORDER[w.card.rank]) {
        w = tc;
      }
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
        let sc = 0;
        if (isEarly) {
          if (low.rank === 'J' || low.rank === '9') {
            if (bySuit[s].length > 1) { candidates.push({ card: bySuit[s][1], score: bySuit[s].length * 5, suit: s }); continue; }
          }
          sc = bySuit[s].length * 5;
          if (low.points === 0) sc += 20;
          if (low.rank === '7' || low.rank === '8') sc += 15;
          if (high.points > 0) sc -= 10;
          if (s === this.trumpSuit) sc -= 30;
          candidates.push({ card: low, score: sc, suit: s });
        } else {
          sc = bySuit[s].reduce((a, c) => a + c.points, 0) * 10 + bySuit[s].length * 3;
          if (high.rank === 'J') sc += 25;
          if (high.rank === '9') sc += 15;
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
      return follow[follow.length - 1];
    }

    const trumps = hand.filter(c => c.suit === this.trumpSuit);
    if (this.trumpExposed && trumps.length > 0) {
      trumps.sort((a, c) => RANK_ORDER[c.rank] - RANK_ORDER[a.rank]);
      let trumpWinning;
      if (!cwc) trumpWinning = true;
      else if (cwc.suit !== this.trumpSuit) trumpWinning = true;
      else trumpWinning = RANK_ORDER[trumps[0].rank] > RANK_ORDER[cwc.rank];
      if (trumpWinning && wt !== myTeam) {
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
      trumpSuit: this.trumpSuit, // the chosen SUIT is known to everyone once picked — only the specific hidden CARD stays secret until exposure
      trumpExposed: this.trumpExposed,
      hasHiddenTrump: !!this.hiddenTrump,
      trickCards: this.trickCards,
      trickSuit: this.trickSuit,
      teamPoints: this.teamPoints,
      gameScore: this.gameScore,
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

module.exports = { GameEngine, SUITS, RANKS, POINTS, RANK_ORDER, getTeam, freshDeck };
