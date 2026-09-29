// ============================================================================
// holdem3d-engine.js
//
// A fully OFFLINE, client-only Texas Hold'em engine that stands in for the
// real Socket.IO server, purely for the "holdem3d.html" 3D testing sandbox.
// This file is NOT used by the real online Hold'em (holdem.html) and never
// talks to server.js / poker-engine.js in any way.
//
// It defines a global `io()` function (the same name the real socket.io
// client script normally provides) that returns a fake "socket" object with
// .on()/.emit(). holdem3d.html's own huge inline script is completely
// unmodified -- it just calls `const socket = io();` and then
// socket.on(...)/socket.emit(...) exactly as it always has, with no idea
// it's talking to a local bot-driven engine instead of a real server.
//
// Scope, deliberately kept simple since this is a visual/testing sandbox,
// not a production poker server:
//   - Single local table, 9 seats, seat 0 is always the human.
//   - Cash-style play only (blinds/buy-in options are honored for display,
//     but there's no real tournament elimination -- any seat that busts to
//     0 chips is auto reloaded before the next hand so the sandbox never
//     dead-ends).
//   - Side pots are computed correctly at showdown/award time from each
///     seat's whole-hand contribution, but the live "Pot" display during a
//     hand is shown as a single running total rather than broken out per
//     layer (that per-layer breakdown is a display nicety for the rare
//     all-in-for-less case, not a fairness issue -- payouts are correct
//     either way).
//   - Bots use a simple heuristic (hand-strength estimate + randomness),
//     not real GTO play -- good enough to exercise every phase of a hand
//     for testing the 3D visuals.
// ============================================================================
(function () {
  'use strict';

  // ---------------------------------------------------------------------
  // Fake socket.io client
  // ---------------------------------------------------------------------
  const handlers = {};
  function on(evt, cb) { (handlers[evt] = handlers[evt] || []).push(cb); return fakeSocket; }
  function off(evt, cb) { if (handlers[evt]) handlers[evt] = handlers[evt].filter((h) => h !== cb); }
  function fire(evt, data) {
    (handlers[evt] || []).forEach((h) => {
      try { h(data); } catch (e) { console.error('[holdem3d-engine]', evt, e); }
    });
  }
  // The real socket.io-client Socket exposes its Manager as `.io` (used by
  // the page for low-level transport/reconnect logging via
  // `socket.io.on('error', ...)` etc.) -- this sandbox never disconnects,
  // so a harmless stub is enough to keep those call sites from throwing.
  const fakeManager = { on() { return fakeManager; }, off() { return fakeManager; } };
  const fakeSocket = {
    on, off,
    emit(evt, payload, cb) { try { handleEmit(evt, payload, cb); } catch (e) { console.error('[holdem3d-engine] emit', evt, e); } },
    connected: true,
    io: fakeManager,
  };
  window.io = function () { return fakeSocket; };
  window.__holdem3dEngineDebug = { fire, get table() { return tbl; } };

  // ---------------------------------------------------------------------
  // Deck / cards
  // ---------------------------------------------------------------------
  const SUITS = ['♠', '♥', '♦', '♣'];
  const RANKS = [
    { r: '2', v: 2 }, { r: '3', v: 3 }, { r: '4', v: 4 }, { r: '5', v: 5 }, { r: '6', v: 6 },
    { r: '7', v: 7 }, { r: '8', v: 8 }, { r: '9', v: 9 }, { r: '10', v: 10 }, { r: 'J', v: 11 },
    { r: 'Q', v: 12 }, { r: 'K', v: 13 }, { r: 'A', v: 14 },
  ];
  function freshShuffledDeck() {
    const d = [];
    for (const s of SUITS) for (const rk of RANKS) d.push({ rank: rk.r, suit: s, v: rk.v });
    for (let i = d.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = d[i]; d[i] = d[j]; d[j] = t;
    }
    return d;
  }

  // ---------------------------------------------------------------------
  // Hand evaluation (best 5-of-7)
  // ---------------------------------------------------------------------
  function kCombinations(arr, k) {
    const res = []; const combo = [];
    (function rec(start) {
      if (combo.length === k) { res.push(combo.slice()); return; }
      for (let i = start; i < arr.length; i++) { combo.push(arr[i]); rec(i + 1); combo.pop(); }
    })(0);
    return res;
  }
  function evaluate5(cards) {
    const vals = cards.map((c) => c.v).sort((a, b) => b - a);
    const suits = cards.map((c) => c.suit);
    const isFlush = suits.every((s) => s === suits[0]);
    const uniq = [...new Set(vals)];
    let isStraight = false, straightHigh = 0;
    if (uniq.length === 5) {
      if (uniq[0] - uniq[4] === 4) { isStraight = true; straightHigh = uniq[0]; }
      else if (uniq.join(',') === '14,5,4,3,2') { isStraight = true; straightHigh = 5; }
    }
    const counts = {};
    for (const v of vals) counts[v] = (counts[v] || 0) + 1;
    const groups = Object.entries(counts).map(([v, c]) => ({ v: Number(v), c })).sort((a, b) => b.c - a.c || b.v - a.v);
    if (isStraight && isFlush) return { cat: 8, tie: [straightHigh], name: straightHigh === 14 ? 'Royal Flush' : 'Straight Flush' };
    if (groups[0].c === 4) return { cat: 7, tie: [groups[0].v, groups[1].v], name: 'Four of a Kind' };
    if (groups[0].c === 3 && groups[1] && groups[1].c >= 2) return { cat: 6, tie: [groups[0].v, groups[1].v], name: 'Full House' };
    if (isFlush) return { cat: 5, tie: vals, name: 'Flush' };
    if (isStraight) return { cat: 4, tie: [straightHigh], name: 'Straight' };
    if (groups[0].c === 3) return { cat: 3, tie: [groups[0].v, ...groups.slice(1).map((g) => g.v)], name: 'Three of a Kind' };
    if (groups[0].c === 2 && groups[1] && groups[1].c === 2) return { cat: 2, tie: [Math.max(groups[0].v, groups[1].v), Math.min(groups[0].v, groups[1].v), groups[2].v], name: 'Two Pair' };
    if (groups[0].c === 2) return { cat: 1, tie: [groups[0].v, ...groups.slice(1).map((g) => g.v)], name: 'Pair' };
    return { cat: 0, tie: vals, name: 'High Card' };
  }
  function compareHand(a, b) {
    if (a.cat !== b.cat) return a.cat - b.cat;
    const len = Math.max(a.tie.length, b.tie.length);
    for (let i = 0; i < len; i++) { const d = (a.tie[i] || 0) - (b.tie[i] || 0); if (d) return d; }
    return 0;
  }
  function evaluate7(cards7) {
    let best = null;
    for (const c of kCombinations(cards7, 5)) {
      const r = evaluate5(c);
      if (!best || compareHand(r, best) > 0) best = r;
    }
    return best;
  }

  // ---------------------------------------------------------------------
  // Table state
  // ---------------------------------------------------------------------
  let tbl = null;
  const myPos = 0; // human is always seat 0 in this solo sandbox
  const BOT_NAMES = ['Bot Ace', 'Bot Raven', 'Bot Luna', 'Bot Diesel', 'Bot Marble', 'Bot Nova', 'Bot Junco', 'Bot Ivy'];

  function sumField(field) { return tbl.seats.reduce((s, seat) => s + (seat ? (seat[field] || 0) : 0), 0); }

  function nextOccupied(from, occupiedList) {
    const sorted = occupiedList.slice().sort((a, b) => a - b);
    const found = sorted.find((p) => p > from);
    return found !== undefined ? found : sorted[0];
  }
  function occupiedSeats() { return tbl.seats.map((s, i) => (s ? i : null)).filter((i) => i !== null); }
  function playersRemaining() { return tbl.seats.filter((s) => s && !s.folded).length; }
  function nextActiveSeat(from) {
    for (let i = 1; i <= 9; i++) {
      const p = (from + i) % 9;
      const s = tbl.seats[p];
      if (s && !s.folded && !s.allIn && (!s.roundActed || s.bettedThisRound !== tbl.currentBet)) return p;
    }
    return -1;
  }
  function bettingRoundComplete() {
    const active = tbl.seats.filter((s) => s && !s.folded && !s.allIn);
    if (active.length === 0) return true;
    return active.every((s) => s.roundActed && s.bettedThisRound === tbl.currentBet);
  }

  // ---------------------------------------------------------------------
  // Broadcasting state to the (fake) client
  // ---------------------------------------------------------------------
  function seatForBroadcast(s, pos) {
    if (!s) return null;
    const revealAtShowdown = tbl.phase === 'handEnd' && tbl.showdownResult && tbl.showdownResult.boardShown;
    const revealHand = pos === myPos || tbl.allInShowdown || (revealAtShowdown && !s.folded);
    return {
      name: s.name,
      chips: s.chips,
      isBot: s.isBot,
      avatar: s.avatar,
      connected: true,
      hand: revealHand ? s.hand.map((c) => ({ rank: c.rank, suit: c.suit })) : (s.hand || []).map(() => ({})),
      folded: s.folded,
      allIn: s.allIn,
      eliminated: false,
      bustedAt: null,
      bettedThisRound: s.bettedThisRound || 0,
      lastAction: s.lastAction || '',
    };
  }
  function computeMyHandName() {
    if (!tbl) return null;
    const me = tbl.seats[myPos];
    if (!me || !me.hand || me.hand.length < 2 || tbl.board.length < 3) return null;
    try { return evaluate7([...me.hand, ...tbl.board]).name; } catch (e) { return null; }
  }
  function broadcastState() {
    if (!tbl) return;
    const potsSwept = Math.max(0, sumField('totalContributed') - sumField('bettedThisRound'));
    const state = {
      tableId: tbl.tableId,
      phase: tbl.phase,
      seats: tbl.seats.map((s, i) => seatForBroadcast(s, i)),
      pots: [{ amount: potsSwept }],
      currentBet: tbl.currentBet,
      currentPlayer: tbl.currentPlayer,
      dealerSeat: tbl.dealerSeat,
      board: tbl.board.map((c) => ({ rank: c.rank, suit: c.suit })),
      handNumber: tbl.handNumber,
      smallBlind: tbl.smallBlind,
      bigBlind: tbl.bigBlind,
      minRaise: tbl.minRaise,
      buyInType: tbl.buyInType,
      mode: tbl.mode,
      blindLevel: 0,
      myHandName: computeMyHandName(),
      showdownResult: tbl.showdownResult,
      allInShowdown: !!tbl.allInShowdown,
      continueStatus: tbl.continueStatus,
      log: tbl.log || [],
      isHost: true,
      isRealHost: true,
      isAdminWatch: false,
      pendingJoinRequests: [],
    };
    fire('poker_state', state);
  }

  // ---------------------------------------------------------------------
  // Emits from the client -> local engine
  // ---------------------------------------------------------------------
  function handleEmit(evt, payload, cb) {
    switch (evt) {
      case 'poker_listRooms': fire('poker_roomList', []); break;
      case 'poker_createTable': doCreateTable(payload || {}); break;
      case 'poker_joinTable': break; // solo sandbox: nothing else to join
      case 'poker_fillBots': doFillBots((payload && payload.count) || 0); break;
      case 'poker_startHand': startNewHand(); break;
      case 'poker_act': doPlayerAct(payload || {}); break;
      case 'poker_readyForNextHand': doReadyForNextHand(); break;
      case 'poker_leaveTable': tbl = null; break;
      case 'healthPing': if (cb) cb(); break;
      // Multiplayer/admin-only actions -- no-ops in this offline sandbox.
      case 'poker_hostChangeAvatar':
      case 'poker_respondJoinRequest':
      case 'poker_hostRequestRestart':
      case 'poker_hostKick':
      case 'poker_cancelRestart':
      case 'poker_confirmRestart':
      case 'poker_adminWatch':
        break;
      default: break;
    }
  }

  function doCreateTable(payload) {
    const startingChips = payload.startingChips || 1000;
    tbl = {
      tableId: 'LOCAL3D',
      seats: new Array(9).fill(null),
      deck: [],
      board: [],
      currentBet: 0,
      currentPlayer: -1,
      dealerSeat: 0,
      handNumber: 0,
      phase: 'lobby',
      smallBlind: payload.smallBlind || 5,
      bigBlind: payload.bigBlind || 10,
      minRaise: payload.bigBlind || 10,
      buyInType: payload.buyInType || 'nolimit',
      mode: payload.mode || 'cash',
      startingChips,
      reloadChips: payload.reloadChips || Math.round(startingChips / 2) || 500,
      showdownResult: null,
      continueStatus: null,
      allInShowdown: false,
      log: [],
    };
    tbl.seats[0] = {
      name: payload.name || 'Player',
      chips: startingChips,
      isBot: false,
      avatar: payload.avatar || null,
      hand: [], folded: false, allIn: false,
      bettedThisRound: 0, totalContributed: 0, lastAction: '', roundActed: false,
    };
    fire('poker_joined', { pos: 0, playerId: 'local-human', tableId: tbl.tableId, isHost: true, isRealHost: true, wasCoveredByBot: false });
    broadcastState();
  }

  function doFillBots(count) {
    if (!tbl) return;
    const emptySlots = tbl.seats.map((s, i) => (i > 0 && !s ? i : null)).filter((i) => i !== null);
    const n = Math.max(0, Math.min(count, emptySlots.length));
    for (let i = 0; i < n; i++) {
      const pos = emptySlots[i];
      tbl.seats[pos] = {
        name: BOT_NAMES[pos % BOT_NAMES.length],
        chips: tbl.startingChips,
        isBot: true,
        avatar: null,
        hand: [], folded: false, allIn: false,
        bettedThisRound: 0, totalContributed: 0, lastAction: '', roundActed: false,
      };
    }
    broadcastState();
  }

  function doPlayerAct(payload) {
    if (!tbl || tbl.phase === 'lobby' || tbl.phase === 'handEnd' || tbl.currentPlayer !== myPos) {
      fire('poker_actionError', { reason: 'not_your_turn' });
      return;
    }
    performAction(myPos, payload.action, payload.amount);
  }

  function doReadyForNextHand() {
    if (!tbl || !tbl.continueStatus) return;
    tbl.continueStatus.youClicked = true;
    tbl.continueStatus.clickedCount = 1;
    broadcastState();
    setTimeout(() => startNewHand(), 500);
  }

  // ---------------------------------------------------------------------
  // Hand lifecycle
  // ---------------------------------------------------------------------
  function postBlind(pos, amt) {
    const s = tbl.seats[pos]; if (!s) return;
    const pay = Math.min(amt, s.chips);
    s.chips -= pay; s.bettedThisRound = pay; s.totalContributed = pay;
    if (s.chips === 0) s.allIn = true;
    s.lastAction = (amt === tbl.smallBlind ? 'Small Blind ' : 'Big Blind ') + pay;
  }

  function startNewHand() {
    if (!tbl) return;
    let occupied = occupiedSeats();
    // A sandbox with too few players is a dead end -- auto-top-up bots so
    // testing the 3D view never requires manually refilling seats.
    if (occupied.length < 2) {
      doFillBots(Math.max(0, 5 - occupied.length));
      occupied = occupiedSeats();
      if (occupied.length < 2) return;
    }
    tbl.handNumber++;
    tbl.board = [];
    tbl.showdownResult = null;
    tbl.continueStatus = null;
    tbl.allInShowdown = false;
    tbl.deck = freshShuffledDeck();
    tbl.seats.forEach((s) => {
      if (!s) return;
      s.hand = []; s.folded = false; s.allIn = false;
      s.bettedThisRound = 0; s.totalContributed = 0; s.lastAction = ''; s.roundActed = false;
      if (s.chips <= 0) s.chips = tbl.reloadChips || tbl.startingChips || 1000;
    });
    tbl.dealerSeat = nextOccupied(tbl.dealerSeat, occupied);
    for (let r = 0; r < 2; r++) for (const i of occupied) tbl.seats[i].hand.push(tbl.deck.pop());
    let sbPos, bbPos;
    if (occupied.length === 2) { sbPos = tbl.dealerSeat; bbPos = nextOccupied(tbl.dealerSeat, occupied); }
    else { sbPos = nextOccupied(tbl.dealerSeat, occupied); bbPos = nextOccupied(sbPos, occupied); }
    postBlind(sbPos, tbl.smallBlind);
    postBlind(bbPos, tbl.bigBlind);
    tbl.currentBet = tbl.bigBlind;
    tbl.minRaise = tbl.bigBlind;
    tbl.phase = 'preflop';
    tbl.currentPlayer = occupied.length === 2 ? sbPos : nextOccupied(bbPos, occupied);
    broadcastState();
    maybeBotAct();
  }

  function performAction(pos, action, amount) {
    const seat = tbl.seats[pos];
    if (!seat || seat.folded || seat.allIn) return;
    const toCall = tbl.currentBet - seat.bettedThisRound;
    if (action === 'check' && toCall > 0) action = 'call'; // safety fallback
    if (action === 'fold') {
      seat.folded = true; seat.lastAction = 'Folded';
    } else if (action === 'check') {
      seat.lastAction = 'Checked';
    } else if (action === 'call') {
      const amt = Math.min(toCall, seat.chips);
      seat.chips -= amt; seat.bettedThisRound += amt; seat.totalContributed = (seat.totalContributed || 0) + amt;
      if (seat.chips === 0) seat.allIn = true;
      seat.lastAction = amt > 0 ? ('Called ' + amt) : 'Checked';
    } else if (action === 'bet' || action === 'raise') {
      let target = Math.max(amount || 0, tbl.currentBet + Math.max(tbl.minRaise, tbl.bigBlind));
      target = Math.min(target, seat.chips + seat.bettedThisRound);
      const amt = target - seat.bettedThisRound;
      const raiseIncrement = target - tbl.currentBet;
      seat.chips -= amt; seat.bettedThisRound = target; seat.totalContributed = (seat.totalContributed || 0) + amt;
      if (raiseIncrement > tbl.minRaise) tbl.minRaise = raiseIncrement;
      tbl.currentBet = target;
      if (seat.chips === 0) seat.allIn = true;
      seat.lastAction = (action === 'bet' ? 'Bet ' : 'Raised to ') + target;
      tbl.seats.forEach((s, i) => { if (s && i !== pos && !s.folded && !s.allIn) s.roundActed = false; });
    } else if (action === 'allin') {
      const amt = seat.chips;
      const target = seat.bettedThisRound + amt;
      seat.chips = 0; seat.bettedThisRound = target; seat.totalContributed = (seat.totalContributed || 0) + amt; seat.allIn = true;
      if (target > tbl.currentBet) {
        const raiseIncrement = target - tbl.currentBet;
        if (raiseIncrement > tbl.minRaise) tbl.minRaise = raiseIncrement;
        tbl.currentBet = target;
        tbl.seats.forEach((s, i) => { if (s && i !== pos && !s.folded && !s.allIn) s.roundActed = false; });
      }
      seat.lastAction = 'All-In ' + target;
    }
    seat.roundActed = true;
    advanceAfterAction(pos);
  }

  function advanceAfterAction(actorPos) {
    broadcastState();
    if (playersRemaining() <= 1) { setTimeout(endHandByFold, 600); return; }
    if (bettingRoundComplete()) { setTimeout(advanceStreet, 900); return; }
    const next = nextActiveSeat(actorPos);
    if (next === -1) { setTimeout(advanceStreet, 900); return; }
    tbl.currentPlayer = next;
    broadcastState();
    maybeBotAct();
  }

  function advanceStreet() {
    if (!tbl) return;
    tbl.seats.forEach((s) => { if (s) { s.bettedThisRound = 0; s.roundActed = !!(s.folded || s.allIn); } });
    tbl.currentBet = 0; tbl.minRaise = tbl.bigBlind;
    if (tbl.board.length === 0) { tbl.board.push(...draw(3)); tbl.phase = 'flop'; }
    else if (tbl.board.length === 3) { tbl.board.push(...draw(1)); tbl.phase = 'turn'; }
    else if (tbl.board.length === 4) { tbl.board.push(...draw(1)); tbl.phase = 'river'; }
    else { showdown(); return; }
    if (playersRemaining() <= 1) { endHandByFold(); return; }
    const canAct = tbl.seats.filter((s) => s && !s.folded && !s.allIn);
    if (canAct.length <= 1) {
      tbl.allInShowdown = true;
      broadcastState();
      setTimeout(advanceStreet, 1200);
      return;
    }
    tbl.currentPlayer = nextOccupied(tbl.dealerSeat, occupiedSeats().filter((i) => !tbl.seats[i].folded));
    broadcastState();
    maybeBotAct();
  }

  function draw(n) { const out = []; for (let i = 0; i < n; i++) out.push(tbl.deck.pop()); return out; }

  function setupContinueStatus() { tbl.continueStatus = { needed: 1, clickedCount: 0, youClicked: false }; }

  function endHandByFold() {
    if (!tbl) return;
    const winnerPos = tbl.seats.findIndex((s) => s && !s.folded);
    const totalPot = sumField('totalContributed');
    if (winnerPos !== -1) tbl.seats[winnerPos].chips += totalPot;
    tbl.showdownResult = { winners: winnerPos !== -1 ? [{ seat: winnerPos, amount: totalPot, handName: null }] : [], boardShown: false };
    tbl.phase = 'handEnd';
    tbl.currentPlayer = -1;
    setupContinueStatus();
    broadcastState();
  }

  function buildPots() {
    const entries = tbl.seats.map((s, i) => (s && (s.totalContributed || 0) > 0 ? { pos: i, amt: s.totalContributed, folded: s.folded } : null)).filter(Boolean);
    if (!entries.length) return [];
    const levels = [...new Set(entries.map((e) => e.amt))].sort((a, b) => a - b);
    const pots = [];
    let prev = 0;
    for (const lvl of levels) {
      const layerSize = lvl - prev;
      if (layerSize <= 0) { prev = lvl; continue; }
      let amount = 0;
      const eligible = [];
      for (const e of entries) {
        if (e.amt > prev) {
          amount += Math.min(e.amt, lvl) - prev;
          if (e.amt >= lvl && !e.folded) eligible.push(e.pos);
        }
      }
      pots.push({ amount, eligible });
      prev = lvl;
    }
    return pots;
  }

  function showdown() {
    if (!tbl) return;
    const pots = buildPots();
    const winners = [];
    for (const pot of pots) {
      if (pot.amount <= 0 || !pot.eligible.length) continue;
      if (pot.eligible.length === 1) {
        const pos = pot.eligible[0];
        tbl.seats[pos].chips += pot.amount;
        winners.push({ seat: pos, amount: pot.amount, handName: evaluate7([...tbl.seats[pos].hand, ...tbl.board]).name });
        continue;
      }
      let best = null; let bestSeats = [];
      for (const pos of pot.eligible) {
        const res = evaluate7([...tbl.seats[pos].hand, ...tbl.board]);
        if (!best || compareHand(res, best) > 0) { best = res; bestSeats = [pos]; }
        else if (compareHand(res, best) === 0) { bestSeats.push(pos); }
      }
      const share = Math.floor(pot.amount / bestSeats.length);
      const remainder = pot.amount - share * bestSeats.length;
      bestSeats.forEach((pos, idx) => {
        const amt = share + (idx < remainder ? 1 : 0);
        tbl.seats[pos].chips += amt;
        winners.push({ seat: pos, amount: amt, handName: evaluate7([...tbl.seats[pos].hand, ...tbl.board]).name });
      });
    }
    tbl.showdownResult = { winners, boardShown: true };
    tbl.phase = 'handEnd';
    tbl.currentPlayer = -1;
    setupContinueStatus();
    broadcastState();
  }

  // ---------------------------------------------------------------------
  // Bot AI
  // ---------------------------------------------------------------------
  function preflopStrength(hand) {
    if (!hand || hand.length < 2) return 0.3;
    const [a, b] = hand;
    const hi = Math.max(a.v, b.v), lo = Math.min(a.v, b.v);
    let s = (hi + lo) / 28;
    if (a.v === b.v) s += 0.28 + (a.v / 14) * 0.15;
    if (a.suit === b.suit) s += 0.08;
    const gap = hi - lo;
    if (gap <= 1) s += 0.06; else if (gap <= 3) s += 0.02;
    return Math.min(1, s);
  }
  function botDecide(pos) {
    const seat = tbl.seats[pos];
    const toCall = tbl.currentBet - seat.bettedThisRound;
    const canCheck = toCall <= 0;
    let strength;
    if (tbl.board.length === 0) strength = preflopStrength(seat.hand);
    else { const r = evaluate7([...seat.hand, ...tbl.board]); strength = Math.min(1, (r.cat + 0.4) / 8.4); }
    const rand = Math.random();
    let action, amount;
    if (canCheck) {
      if (strength > 0.62 && rand < 0.55) { action = 'bet'; amount = tbl.currentBet + Math.max(tbl.minRaise, tbl.bigBlind); }
      else action = 'check';
    } else {
      const callCost = Math.min(toCall, seat.chips);
      const costRatio = callCost / Math.max(1, seat.chips + seat.bettedThisRound);
      if (strength > 0.75 && rand < 0.5) { action = 'raise'; amount = tbl.currentBet + Math.max(tbl.minRaise, tbl.bigBlind); }
      else if (strength > 0.4 || costRatio < 0.15 || rand < 0.2) action = 'call';
      else action = 'fold';
    }
    if (action === 'bet' || action === 'raise') {
      const maxBet = seat.chips + seat.bettedThisRound;
      if (amount >= maxBet) { action = 'allin'; amount = undefined; }
      else amount = Math.min(amount, maxBet);
    }
    if (action === 'call' && toCall >= seat.chips) action = 'allin';
    return { action, amount };
  }
  function maybeBotAct() {
    if (!tbl) return;
    const s = tbl.seats[tbl.currentPlayer];
    if (s && s.isBot && !s.folded && !s.allIn) {
      const actingPos = tbl.currentPlayer;
      setTimeout(() => {
        if (!tbl || tbl.phase === 'handEnd' || tbl.currentPlayer !== actingPos) return;
        const { action, amount } = botDecide(actingPos);
        performAction(actingPos, action, amount);
      }, 700 + Math.random() * 900);
    }
  }

  setTimeout(() => fire('connect'), 30);
})();
