// ============================================================
// 56 — SERVER-AUTHORITATIVE GAME ENGINE
// ============================================================
// Ported faithfully from public/56.html's own game logic (dealing,
// bidding incl. the full bot AI, doubling, card play incl. the full bot
// AI with suit-safety tracking, trick resolution, hand scoring) so the
// SERVER is the one true source of truth for a 56 table -- exactly how
// game-engine.js already works for the 4-player table. The client is a
// thin renderer: it sends actions in, and renders whatever full state
// the server pushes back. This means a 56 game now keeps running
// perfectly regardless of any single player's connection, tab focus, or
// phone being locked -- there is no "driver" anymore, because there is
// nothing for any browser to drive. The server does it.
// ============================================================

const SUITS = ['S', 'H', 'D', 'C'];
const SUIT_SYM = { S: '♠', H: '♥', D: '♦', C: '♣' };
const RANKS = ['J', '9', 'A', '10', 'K', 'Q']; // power order, highest first
const RANK_PTS = { J: 3, '9': 2, A: 1, '10': 1, K: 0, Q: 0 };
const TEAM_OF = seat => (seat % 2 === 0 ? 'A' : 'B');
const THEME_COUNT = 6; // must match THEMES.length in public/56.html

function bandFor(value) {
  if (value >= 28 && value <= 39) return { win: 1, lose: 2 };
  if (value >= 40 && value <= 47) return { win: 2, lose: 3 };
  if (value >= 48 && value <= 55) return { win: 3, lose: 4 };
  if (value === 56) return { win: 4, lose: 5 };
  return { win: 1, lose: 2 };
}

function freshDeck() {
  const deck = [];
  let id = 0;
  for (let copy = 0; copy < 2; copy++) {
    for (const s of SUITS) {
      for (const r of RANKS) {
        deck.push({ r, s, id: 'c' + (id++) });
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
function dealHands(startSeat) {
  const start = startSeat || 0;
  const deck = shuffle(freshDeck());
  const hands = [[], [], [], [], [], []];
  for (let i = 0; i < deck.length; i++) {
    hands[(start + i) % 6].push(deck[i]);
  }
  return hands;
}

function addLog(state, text, seat) {
  state.log = state.log || [];
  state.log.unshift({ text, ts: Date.now(), seat: (seat !== undefined ? seat : null) });
  if (state.log.length > 60) state.log.length = 60;
}

// Formats a stored bid {value, trump, kind, order} into the traditional
// notation, matching public/56.html's formatBidLabel/formatBidLogLabel.
function formatBidLabel(cb) {
  if (!cb) return '';
  if (cb.kind === 'nt') return cb.value + ' No Trump';
  if (cb.kind === 'ns') return cb.value + ' NOS';
  const sym = SUIT_SYM[cb.trump];
  return cb.order === 'reverse' ? `${sym} ${cb.value}` : `${cb.value} ${sym}`;
}
function formatBidLogLabel(cb) {
  if (!cb) return '';
  if (cb.kind === 'nt' || cb.kind === 'ns') return formatBidLabel(cb);
  if (cb.increment) {
    const sym = SUIT_SYM[cb.trump];
    const inc = cb.order === 'reverse' ? `${sym} +${cb.increment}` : `+${cb.increment} ${sym}`;
    return `${inc} (${cb.value})`;
  }
  return formatBidLabel(cb);
}

function legalCardsForSeat(state, seat) {
  const hand = state.hands[seat] || [];
  if (!state.leadSuit) return hand.slice();
  const followers = hand.filter(c => c.s === state.leadSuit);
  return followers.length > 0 ? followers : hand.slice();
}
function cardPower(card, state) {
  const isTrump = state.currentBid.trump && card.s === state.currentBid.trump;
  return { isTrump, rankIdx: RANKS.indexOf(card.r) };
}

// ---------------- trick resolution / hand scoring ----------------
function resolveTrick(state) {
  let winner = state.table[0];
  let winPow = cardPower(winner.card, state);
  for (let i = 1; i < state.table.length; i++) {
    const play = state.table[i];
    const pow = cardPower(play.card, state);
    let better = false;
    if (pow.isTrump && !winPow.isTrump) {
      better = true;
    } else if (pow.isTrump === winPow.isTrump) {
      if (pow.isTrump) {
        better = pow.rankIdx < winPow.rankIdx;
      } else if (play.card.s === state.leadSuit && winner.card.s === state.leadSuit) {
        better = pow.rankIdx < winPow.rankIdx;
      } else if (play.card.s === state.leadSuit && winner.card.s !== state.leadSuit) {
        better = true;
      }
    }
    if (better) { winner = play; winPow = pow; }
  }
  const points = state.table.reduce((sum, p) => sum + RANK_PTS[p.card.r], 0);
  const winTeam = TEAM_OF(winner.seat);
  state.teamPoints[winTeam] += points;
  state.tricksLog = state.tricksLog || [];
  state.tricksLog.push({ cards: state.table, winnerSeat: winner.seat, points });
  addLog(state, `${state.seats[winner.seat].name} wins the trick (+${points} pts) for Team ${winTeam}.`);
  state.pendingTrick = { winnerSeat: winner.seat, points, team: winTeam, ts: Date.now() };
  state.turn = null;
}
function settlePendingTrick(state) {
  if (!state.pendingTrick) return;
  const winnerSeat = state.pendingTrick.winnerSeat;
  state.table = [];
  state.leadSuit = null;
  state.turn = winnerSeat;
  state.pendingTrick = null;
  const cardsLeft = state.hands.reduce((a, h) => a + h.length, 0);
  if (cardsLeft === 0) finishHand(state);
}
function finishHand(state) {
  const cb = state.currentBid;
  const biddingTeam = TEAM_OF(cb.seat);
  const oppTeam = biddingTeam === 'A' ? 'B' : 'A';
  const made = state.teamPoints[biddingTeam] >= cb.value;
  const band = bandFor(cb.value);
  const mult = state.doubled === 2 ? 4 : state.doubled === 1 ? 2 : 1;
  if (made) {
    const amt = Math.min(band.win * mult, state.matchScore[oppTeam]);
    state.matchScore[biddingTeam] += amt;
    state.matchScore[oppTeam] -= amt;
    addLog(state, `Team ${biddingTeam} made their bid of ${cb.value}. Receive ${amt} table${amt !== 1 ? 's' : ''} from Team ${oppTeam}.`);
  } else {
    const amt = Math.min(band.lose * mult, state.matchScore[biddingTeam]);
    state.matchScore[biddingTeam] -= amt;
    state.matchScore[oppTeam] += amt;
    addLog(state, `Team ${biddingTeam} fell short of ${cb.value}. Pay ${amt} table${amt !== 1 ? 's' : ''} to Team ${oppTeam}.`);
  }
  state.qMarks = state.qMarks || {};
  if (made) {
    const bidderSeatInfo = state.seats[cb.seat];
    if (bidderSeatInfo && state.qMarks[bidderSeatInfo.name] > 0) {
      state.qMarks[bidderSeatInfo.name]--;
      if (state.qMarks[bidderSeatInfo.name] <= 0) delete state.qMarks[bidderSeatInfo.name];
      addLog(state, `${bidderSeatInfo.name} shed a Q by calling and winning the bid.`);
    }
    if (state.isFirstHandOfChampionship) {
      for (let i = 0; i < 6; i++) {
        if (i === cb.seat || TEAM_OF(i) !== biddingTeam) continue;
        const teammateInfo = state.seats[i];
        if (teammateInfo && state.qMarks[teammateInfo.name] > 0) {
          state.qMarks[teammateInfo.name]--;
          if (state.qMarks[teammateInfo.name] <= 0) delete state.qMarks[teammateInfo.name];
          addLog(state, `${teammateInfo.name} also shed a Q — first hand of the match, teammate's bid came through.`);
        }
      }
    }
  }
  state.isFirstHandOfChampionship = false;
  if (state.matchScore.A <= 0 || state.matchScore.B <= 0) {
    state.matchOver = true;
    state.matchWinner = state.matchScore.A <= 0 ? 'B' : 'A';
    state.sessionWins = state.sessionWins || { A: 0, B: 0 };
    state.sessionWins[state.matchWinner] = (state.sessionWins[state.matchWinner] || 0) + 1;
    addLog(state, `Team ${state.matchWinner} wins the match — Team ${state.matchWinner === 'A' ? 'B' : 'A'} is out of tables!`);
    const losingTeam = state.matchWinner === 'A' ? 'B' : 'A';
    for (let i = 0; i < 6; i++) {
      const s = state.seats[i];
      if (!s || TEAM_OF(i) !== losingTeam) continue;
      state.qMarks[s.name] = (state.qMarks[s.name] || 0) + 1;
    }
    addLog(state, `Team ${losingTeam} shut out — every player picks up a Q.`);
  }
  state.phase = 'handEnd';
}

// ---------------- bidding mechanics ----------------
function advanceBiddingTurn(state) {
  let next = (state.turn + 1) % 6;
  let guard = 0;
  while (state.passedSeats.includes(next) && guard < 6) {
    next = (next + 1) % 6;
    guard++;
  }
  state.turn = next;
}
function closeBidding(state) {
  const cb = state.currentBid;
  state.phase = 'auctionClosed';
  state.auctionClosedAt = Date.now();
  state.turn = null;
  state.leadSuit = null;
  state.table = [];
  state.forcedSeat = null;
  const trumpTxt = cb.trump ? SUIT_SYM[cb.trump] + ' trump' : 'No Trump';
  const leaderSeat = (state.dealer + 1) % 6;
  addLog(state, `Bidding closed. ${state.seats[cb.seat].name} won with ${cb.value} (${trumpTxt}). ${state.seats[leaderSeat].name} leads the first trick.`);
}

// ---------------- bot AI: bidding ----------------
function suitStats(hand) {
  const jacks = { S: 0, H: 0, D: 0, C: 0 }, nines = { S: 0, H: 0, D: 0, C: 0 }, count = { S: 0, H: 0, D: 0, C: 0 };
  hand.forEach(c => {
    count[c.s]++;
    if (c.r === 'J') jacks[c.s]++;
    if (c.r === '9') nines[c.s]++;
  });
  return { jacks, nines, count };
}
function suitOpenValue(jacksN, ninesN) {
  if (jacksN >= 2) return 28 + 1 + ninesN;
  return 28;
}
function botDecideBid(state, seat) {
  const hand = state.hands[seat] || [];
  const cb = state.currentBid;
  const minAllowed = cb ? cb.value + 1 : 28;
  const { jacks, nines, count } = suitStats(hand);
  const isForced = state.forcedSeat === seat && !cb;

  const biddableSuits = SUITS.filter(s => jacks[s] >= 1 && count[s] >= 4);
  const bestOf = (suits) => {
    let best = null, bestVal = -1;
    suits.forEach(s => {
      const v = suitOpenValue(jacks[s], nines[s]);
      if (v > bestVal) { bestVal = v; best = s; }
    });
    return { suit: best, value: bestVal };
  };

  if (cb && TEAM_OF(cb.seat) !== TEAM_OF(seat) && state.doubled === 0 && cb.value >= 44 && Math.random() < 0.25) {
    return { action: 'double' };
  }
  if (cb && TEAM_OF(cb.seat) === TEAM_OF(seat) && state.doubled === 1 && cb.trump && jacks[cb.trump] >= 1 && Math.random() < 0.3) {
    return { action: 'redouble' };
  }

  if (cb && state.openerSeat === seat && state.openerSuit && cb.trump !== state.openerSuit &&
    TEAM_OF(cb.seat) === TEAM_OF(seat) && jacks[state.openerSuit] >= 1 && count[state.openerSuit] >= 4) {
    if (state.openerReassertCount >= 2 && !state.openerProbeSuit) {
      const probeCandidates = biddableSuits.filter(s => s !== state.openerSuit);
      if (probeCandidates.length > 0) {
        const { suit, value: probeVal } = bestOf(probeCandidates);
        const value = Math.max(minAllowed, Math.min(56, probeVal));
        if (value <= 56) return { action: 'bid', value, trump: suit, kind: 'suit', order: 'forward', isProbe: true };
      }
    }
    const value = Math.min(56, cb.value + 1);
    if (value >= minAllowed) return { action: 'bid', value, trump: state.openerSuit, kind: 'suit', order: 'forward', isReassert: true };
  }

  if (cb && state.openerProbeSuit && cb.trump === state.openerProbeSuit && cb.seat === state.openerSeat &&
    TEAM_OF(cb.seat) === TEAM_OF(seat) && seat === (state.openerSeat - 1 + 6) % 6) {
    const s = cb.trump;
    const canSupportProbe = count[s] > 0 && jacks[s] >= 1;
    if (!canSupportProbe && minAllowed <= 56) {
      return { action: 'bid', value: minAllowed, trump: null, kind: 'ns', order: null };
    }
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

  const isPartnerBid = TEAM_OF(cb.seat) === TEAM_OF(seat);
  if (isPartnerBid && cb.trump) {
    const s = cb.trump;
    const alreadySaidVoid = state.nsBySeat && state.nsBySeat[seat];
    const alreadyBidThisSuit = state.suitBidBySeat && state.suitBidBySeat[seat + '-' + s];
    if (count[s] === 0 && !alreadySaidVoid) {
      if (minAllowed <= 56) return { action: 'bid', value: minAllowed, trump: null, kind: 'ns', order: null };
      return { action: 'pass' };
    }
    if (count[s] > 0 && jacks[s] >= 1 && !alreadyBidThisSuit) {
      const supportBump = jacks[s] + nines[s];
      const value = Math.min(56, cb.value + supportBump);
      if (value >= minAllowed) return { action: 'bid', value, trump: s, kind: 'suit', order: 'forward' };
    }
    const isProbeSuit = state.openerProbeSuit && s === state.openerProbeSuit;
    if (!isProbeSuit) {
      const others = biddableSuits.filter(x => x !== s);
      if (others.length > 0) {
        const { suit, value } = bestOf(others);
        if (value >= minAllowed && value <= 56) return { action: 'bid', value, trump: suit, kind: 'suit', order: 'forward' };
      }
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

// ---------------- bot AI: card play ----------------
function getPlayedCardsThisHand(state) {
  const played = [];
  (state.tricksLog || []).forEach(t => t.cards.forEach(p => played.push(p.card)));
  (state.table || []).forEach(p => played.push(p.card));
  return played;
}
function suitLeadSafety(state, seat) {
  const myTeam = TEAM_OF(seat);
  const oppSeats = [0, 1, 2, 3, 4, 5].filter(s => TEAM_OF(s) !== myTeam);
  const played = getPlayedCardsThisHand(state);
  const safe = new Set();
  SUITS.forEach(s => {
    const jacksPlayed = played.filter(c => c.s === s && c.r === 'J').length;
    let jacksMyTeam = 0, jacksOpponent = 0;
    for (let sIdx = 0; sIdx < 6; sIdx++) {
      const claim = state.suitBidBySeat ? state.suitBidBySeat[sIdx + '-' + s] : null;
      if (claim === 'forward') {
        if (TEAM_OF(sIdx) === myTeam) jacksMyTeam++;
        else jacksOpponent++;
      }
    }
    const allOppsRevealedVoid = oppSeats.length > 0 && oppSeats.every(os =>
      state.revealedVoidBySeat && state.revealedVoidBySeat[os] && state.revealedVoidBySeat[os].includes(s));
    if (jacksOpponent === 0 && ((jacksPlayed + jacksMyTeam) >= 2 || allOppsRevealedVoid)) {
      safe.add(s);
    }
  });
  return safe;
}
function chooseDiscard(state, seat, legalCards) {
  const safeSuits = suitLeadSafety(state, seat);
  const unsafeCards = legalCards.filter(c => !safeSuits.has(c.s));
  const pool = unsafeCards.length > 0 ? unsafeCards : legalCards;
  const sorted = pool.slice().sort((a, b) => RANK_PTS[a.r] - RANK_PTS[b.r]);
  return sorted[0];
}
function botChooseCard(state, seat, legalCards) {
  if (state.table.length === 0) {
    const safeSuits = suitLeadSafety(state, seat);
    const bySuit = {};
    legalCards.forEach(c => { (bySuit[c.s] = bySuit[c.s] || []).push(c); });
    const candidateSuits = Object.keys(bySuit).filter(s => safeSuits.has(s));
    const pool = candidateSuits.length > 0 ? candidateSuits.flatMap(s => bySuit[s]) : legalCards;
    const sorted = pool.slice().sort((a, b) => RANKS.indexOf(a.r) - RANKS.indexOf(b.r));
    return sorted[0];
  }

  let winner = state.table[0];
  let winPow = cardPower(winner.card, state);
  for (let i = 1; i < state.table.length; i++) {
    const p = state.table[i];
    const pow = cardPower(p.card, state);
    let better = false;
    if (pow.isTrump && !winPow.isTrump) better = true;
    else if (pow.isTrump === winPow.isTrump) {
      if (pow.isTrump) better = pow.rankIdx < winPow.rankIdx;
      else if (p.card.s === state.leadSuit && winner.card.s === state.leadSuit) better = pow.rankIdx < winPow.rankIdx;
      else if (p.card.s === state.leadSuit && winner.card.s !== state.leadSuit) better = true;
    }
    if (better) { winner = p; winPow = pow; }
  }

  const partnerWinning = TEAM_OF(winner.seat) === TEAM_OF(seat);
  if (partnerWinning) return chooseDiscard(state, seat, legalCards);

  const winners = legalCards.filter(c => {
    const pow = cardPower(c, state);
    if (pow.isTrump && !winPow.isTrump) return true;
    if (pow.isTrump === winPow.isTrump) {
      if (pow.isTrump) return pow.rankIdx < winPow.rankIdx;
      if (c.s === state.leadSuit && winner.card.s === state.leadSuit) return pow.rankIdx < winPow.rankIdx;
      if (c.s === state.leadSuit && winner.card.s !== state.leadSuit) return true;
    }
    return false;
  });
  if (winners.length > 0) {
    const sortedAsc = winners.slice().sort((a, b) => RANKS.indexOf(a.r) - RANKS.indexOf(b.r));
    return sortedAsc[sortedAsc.length - 1];
  }
  return chooseDiscard(state, seat, legalCards);
}

// ---------------- fresh room / new hand ----------------
function newRoomState(roomCode) {
  return {
    roomCode,
    hostPlayerId: null,
    seats: [null, null, null, null, null, null],
    phase: 'lobby',
    dealer: 0,
    turn: null,
    hands: [[], [], [], [], [], []],
    bidHistory: [],
    currentBid: null,
    doubled: 0,
    doubledBySeat: null,
    passedSeats: [],
    forcedSeat: null,
    openerSeat: null,
    openerSuit: null,
    openerReassertCount: 0,
    openerProbeSuit: null,
    nsBySeat: {},
    lastActionBySeat: {},
    revealedVoidBySeat: {},
    suitBidBySeat: {},
    table: [],
    leadSuit: null,
    pendingTrick: null,
    tricksLog: [],
    teamPoints: { A: 0, B: 0 },
    matchScore: { A: 12, B: 12 },
    matchOver: false,
    matchWinner: null,
    handNumber: 1,
    themeIndex: 0,
    sessionWins: { A: 0, B: 0 },
    qMarks: {},
    isFirstHandOfChampionship: true,
    partnerSignals: {},
    reviewHold: false,
    log: [],
    lastNote: null,
    updatedAt: Date.now()
  };
}
// Shared reset logic for startGame/nextHand/startNewMatch -- all three
// deal a fresh hand and clear the same per-hand fields; only what
// happens to dealer/handNumber/matchScore/themeIndex differs between them.
function dealFreshHand(state) {
  state.turn = (state.dealer + 1) % 6;
  state.themeIndex = (() => { let i; do { i = Math.floor(Math.random() * THEME_COUNT); } while (i === state.themeIndex && THEME_COUNT > 1); return i; })();
  state.hands = dealHands(state.turn);
  state.phase = 'bidding';
  state.currentBid = null;
  state.doubled = 0;
  state.doubledBySeat = null;
  state.passedSeats = [];
  state.forcedSeat = null;
  state.openerSeat = null;
  state.openerSuit = null;
  state.openerReassertCount = 0;
  state.openerProbeSuit = null;
  state.nsBySeat = {};
  state.lastActionBySeat = {};
  state.revealedVoidBySeat = {};
  state.reviewHold = false;
  state.suitBidBySeat = {};
  state.bidHistory = [];
  state.table = [];
  state.leadSuit = null;
  state.pendingTrick = null;
  state.tricksLog = [];
  state.teamPoints = { A: 0, B: 0 };
  state.lastNote = null;
}
function startGame(state) {
  state.dealer = Math.floor(Math.random() * 6);
  dealFreshHand(state);
  addLog(state, `Cards dealt for hand ${state.handNumber}. ${state.seats[state.dealer].name} is dealer. ${state.seats[state.turn].name} opens the bidding.`);
}
function restartRound(state) {
  // Same reset as dealFreshHand -- fresh deal, bidding starts over --
  // but dealer/handNumber/match score are deliberately left untouched:
  // this hand gets redealt, not replaced by the next one.
  dealFreshHand(state);
  addLog(state, `Host restarted hand ${state.handNumber} — fresh deal.`);
}
function nextHand(state) {
  state.dealer = (state.dealer + 1) % 6;
  state.handNumber += 1;
  dealFreshHand(state);
  addLog(state, `Hand ${state.handNumber} dealt. ${state.seats[state.turn].name} opens the bidding.`);
}
function startNewMatch(state) {
  state.matchScore = { A: 12, B: 12 };
  state.matchOver = false;
  state.matchWinner = null;
  state.handNumber = 1;
  state.dealer = Math.floor(Math.random() * 6);
  dealFreshHand(state);
  state.isFirstHandOfChampionship = true;
  addLog(state, `New match started — each team back to 12 tables. Hand 1 dealt.`);
}

module.exports = {
  SUITS, SUIT_SYM, RANKS, RANK_PTS, TEAM_OF, THEME_COUNT,
  bandFor, freshDeck, shuffle, dealHands, addLog,
  formatBidLabel, formatBidLogLabel, legalCardsForSeat, cardPower,
  resolveTrick, settlePendingTrick, finishHand,
  advanceBiddingTurn, closeBidding,
  suitStats, suitOpenValue, botDecideBid,
  getPlayedCardsThisHand, suitLeadSafety, chooseDiscard, botChooseCard,
  newRoomState, dealFreshHand, startGame, nextHand, startNewMatch, restartRound,
};
