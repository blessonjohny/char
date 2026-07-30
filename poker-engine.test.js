const { PokerEngine } = require('./poker-engine');

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; } else { fail++; console.error('FAIL:', label); }
}

// ---- Test 1: Basic heads-up hand, everyone checks/calls to showdown ----
{
  const e = new PokerEngine('t1', { smallBlind: 5, bigBlind: 10, startingChips: 1000 });
  e.seatBot(0, 'A');
  e.seatBot(1, 'B');
  e.startHand();
  ok(e.phase === 'preflop', 'Heads-up: starts in preflop');
  ok(e.seats[0].chips === 995 || e.seats[1].chips === 995, 'Heads-up: one seat posted small blind (5)');
  const totalChipsAtStart = e.seats[0].chips + e.seats[1].chips + e.seats[0].bettedThisRound + e.seats[1].bettedThisRound;
  ok(totalChipsAtStart === 2000, 'Heads-up: total chips conserved after blinds posted (' + totalChipsAtStart + ')');

  // Drive the hand to completion with call/check only
  let guard = 0;
  while (e.phase !== 'handEnd' && guard < 50) {
    const p = e.currentPlayer;
    const s = e.seats[p];
    const toCall = e.currentBet - s.bettedThisRound;
    e.act(p, toCall > 0 ? 'call' : 'check');
    guard++;
  }
  ok(e.phase === 'handEnd', 'Heads-up: hand reaches handEnd via check/call only (guard=' + guard + ')');
  ok(e.board.length === 5, 'Heads-up: full 5-card board dealt (' + e.board.length + ')');
  const totalChipsAfter = e.seats[0].chips + e.seats[1].chips;
  ok(totalChipsAfter === 2000, 'Heads-up: total chips conserved after full hand (' + totalChipsAfter + ')');
  ok(e.showdownResult && e.showdownResult.winners.length >= 1, 'Heads-up: showdown produced at least one winner');
}

// ---- Test 2: Everyone folds to one player preflop ----
{
  const e = new PokerEngine('t2', { smallBlind: 5, bigBlind: 10, startingChips: 1000 });
  e.seatBot(0, 'A'); e.seatBot(1, 'B'); e.seatBot(2, 'C');
  e.startHand();
  const potBefore = e.seats[0].bettedThisRound + e.seats[1].bettedThisRound + e.seats[2].bettedThisRound;
  let guard = 0;
  while (e.phase !== 'handEnd' && guard < 20) {
    e.act(e.currentPlayer, 'fold');
    guard++;
  }
  ok(e.phase === 'handEnd', '3-way fold-out: reaches handEnd (guard=' + guard + ')');
  ok(e.showdownResult.boardShown === false, '3-way fold-out: no showdown needed, board not shown');
  const totalAfter = e.seats[0].chips + e.seats[1].chips + e.seats[2].chips;
  ok(totalAfter === 3000, '3-way fold-out: total chips conserved (' + totalAfter + ')');
}

// ---- Test 3: All-in side pot math with three different stack sizes ----
{
  const e = new PokerEngine('t3', { smallBlind: 5, bigBlind: 10, startingChips: 1000 });
  e.seatBot(0, 'Short'); e.seatBot(1, 'Mid'); e.seatBot(2, 'Big');
  // Force specific stacks to create a genuine multi-way side pot
  e.startHand();
  e.seats[0].chips = 100;  // short stack (already has blind posted, adjust total conservation check accordingly)
  e.seats[1].chips = 500;
  e.seats[2].chips = 1000;
  const startTotal = e.seats[0].chips + e.seats[1].chips + e.seats[2].chips
    + e.seats[0].bettedThisRound + e.seats[1].bettedThisRound + e.seats[2].bettedThisRound;

  // Drive everyone all-in preflop regardless of turn order
  let guard = 0;
  while (e.phase === 'preflop' && guard < 20) {
    const p = e.currentPlayer;
    if (p === -1) break;
    e.act(p, 'allin');
    guard++;
  }
  // If betting round auto-completed (everyone all-in), engine should have run out remaining streets itself
  ok(e.phase === 'handEnd' || e.phase === 'showdown', 'Side pot: reaches handEnd/showdown after all going all-in (phase=' + e.phase + ', guard=' + guard + ')');
  const endTotal = e.seats[0].chips + e.seats[1].chips + e.seats[2].chips;
  ok(endTotal === startTotal, 'Side pot: total chips conserved through side-pot payout (' + endTotal + ' vs ' + startTotal + ')');
}

// ---- Test 4: Check-raise reopens action correctly ----
{
  const e = new PokerEngine('t4', { smallBlind: 5, bigBlind: 10, startingChips: 1000 });
  e.seatBot(0, 'A'); e.seatBot(1, 'B'); e.seatBot(2, 'C');
  e.startHand();
  // Get to the flop with simple calls
  let guard = 0;
  while (e.phase === 'preflop' && guard < 10) {
    const p = e.currentPlayer;
    const s = e.seats[p];
    const toCall = e.currentBet - s.bettedThisRound;
    e.act(p, toCall > 0 ? 'call' : 'check');
    guard++;
  }
  ok(e.phase === 'flop', 'Check-raise setup: reached flop (phase=' + e.phase + ')');
  if (e.phase === 'flop') {
    const firstActor = e.currentPlayer;
    e.act(firstActor, 'check');
    const secondActor = e.currentPlayer;
    e.act(secondActor, 'bet', 50);
    const thirdActor = e.currentPlayer;
    // thirdActor should now be able to act with hasActed reset for everyone else including firstActor
    ok(e.seats[firstActor].hasActed === false, 'Check-raise: raise reset hasActed for the player who already checked');
    ok(e.currentBet === 50, 'Check-raise: currentBet correctly reflects the bet before the round completes');
    e.act(thirdActor, 'call');
    e.act(firstActor, 'call'); // must be allowed to act again after the bet -- this completes the round and advances the street
    ok(e.phase === 'turn', 'Check-raise: round correctly completed and advanced to the turn after everyone matched the bet');
  }
}

// ---- Test 5: Fixed-limit mode forces bet sizes ----
{
  const e = new PokerEngine('t5', { smallBlind: 5, bigBlind: 10, startingChips: 1000, buyInType: 'fixed' });
  e.seatBot(0, 'A'); e.seatBot(1, 'B');
  e.startHand();
  const p = e.currentPlayer;
  const before = e.seats[p].bettedThisRound;
  e.act(p, 'raise', 999999); // try to raise a huge amount, should get capped to fixed sizing
  const after = e.seats[p].bettedThisRound;
  ok(after - before <= e.bigBlind * 2, 'Fixed-limit: raise amount is capped by fixed sizing, not the requested huge amount (delta=' + (after - before) + ')');
}

// ---- Test 6: Kick request only applies after hand ends, and can be cancelled ----
{
  const e = new PokerEngine('t6', { smallBlind: 5, bigBlind: 10, startingChips: 1000 });
  e.seatBot(0, 'A'); e.seatBot(1, 'B'); e.seatBot(2, 'C');
  e.startHand();
  e.requestKick(2, 'admin');
  ok(!!e.seats[2], 'Kick: seat still occupied mid-hand (not applied yet)');
  ok(!!e.kickRequests[2], 'Kick: pending kick recorded');
  e.cancelKick(2);
  ok(!e.kickRequests[2], 'Kick: cancel removes the pending request');
  ok(!!e.seats[2], 'Kick: seat still occupied after cancel');

  // Now actually request it and let the hand finish naturally, then start the next hand
  e.requestKick(2, 'admin');
  let guard = 0;
  while (e.phase !== 'handEnd' && guard < 20) {
    const p = e.currentPlayer;
    const s = e.seats[p];
    const toCall = e.currentBet - s.bettedThisRound;
    e.act(p, toCall > 0 ? 'call' : 'check');
    guard++;
  }
  ok(!!e.seats[2], 'Kick: seat still present right at handEnd (kick applies at NEXT startHand, not mid-hand)');
  e.startHand();
  ok(!e.seats[2], 'Kick: seat actually removed once the next hand starts');
}

// ---- Test 7: Reload only triggers after the wait, and only for a hand-end bust, not a mid-hand zero ----
{
  const e = new PokerEngine('t7', { smallBlind: 5, bigBlind: 10, startingChips: 1000, reloadWaitMs: 100 });
  e.seatBot(0, 'A'); e.seatBot(1, 'B');
  e.startHand();
  e.seats[0].chips = 0; // simulate a mid-hand zero from betting, NOT yet busted via markBustedPlayers
  ok(e.seats[0].bustedAt === null, 'Reload: chips at 0 mid-hand does NOT itself start the reload timer');
  e.markBustedPlayers();
  ok(e.seats[0].bustedAt !== null, 'Reload: markBustedPlayers (called at hand end) DOES start the timer');
  e.checkReloads();
  ok(e.seats[0].chips === 0, 'Reload: too early, chips still 0');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
