const { preflopHandScore, positionCategory, detectDraws, botDecideAction, botAct } = require('./poker-bot');
const { PokerEngine } = require('./poker-engine');

let pass = 0, fail = 0;
function ok(cond, label) { if (cond) { pass++; } else { fail++; console.error('FAIL:', label); } }
function C(rank, suit) { return { rank, suit }; }

// ---- Preflop hand ranking sanity checks against well-known theory ----
{
  const aa = preflopHandScore([C('A', '♠'), C('A', '♥')]);
  const kk = preflopHandScore([C('K', '♠'), C('K', '♥')]);
  const twos = preflopHandScore([C('2', '♠'), C('2', '♥')]);
  const akSuited = preflopHandScore([C('A', '♠'), C('K', '♠')]);
  const akOff = preflopHandScore([C('A', '♠'), C('K', '♥')]);
  const trash = preflopHandScore([C('7', '♠'), C('2', '♥')]);
  const suitedConnector = preflopHandScore([C('9', '♠'), C('8', '♠')]);
  const gappedOffsuit = preflopHandScore([C('9', '♠'), C('4', '♥')]);

  ok(aa > kk, 'AA scores higher than KK');
  ok(kk > twos, 'KK scores higher than 22 (pairs scale with rank)');
  ok(akSuited > akOff, 'Suited AK scores higher than offsuit AK');
  ok(aa > akSuited, 'Pocket aces beats even AK suited (pairs are the top tier)');
  ok(akOff > trash, 'AK offsuit is a far better hand than 72 offsuit');
  ok(suitedConnector > gappedOffsuit, 'Suited connector (98s) beats a gapped offsuit hand (94o)');
  ok(trash < 25, '72 offsuit scores clearly in trash territory, got ' + trash);
  ok(aa > 95, 'AA scores near the top of the chart, got ' + aa);
}

// ---- Position categorization ----
{
  const e = new PokerEngine('postest', { smallBlind: 5, bigBlind: 10 });
  for (let i = 0; i < 9; i++) e.seatBot(i, 'Bot' + i);
  e.dealerSeat = 0;
  const order = e._seatOrderFrom(0);
  const earlyPos = positionCategory(e, order[2]);
  const latePos = positionCategory(e, order[order.length - 1]);
  ok(earlyPos === 'early' || earlyPos === 'blinds', 'A seat right after the blinds is categorized as early/blinds position, got ' + earlyPos);
  ok(latePos === 'late', 'The last seat to act (near the button) is categorized as late position, got ' + latePos);
}

// ---- Draw detection ----
{
  const flushDrawHole = [C('A', '♠'), C('K', '♠')];
  const flushDrawBoard = [C('9', '♠'), C('4', '♠'), C('2', '♥')];
  const { flushDraw } = detectDraws(flushDrawHole, flushDrawBoard);
  ok(flushDraw === true, 'Four spades across hole+board correctly detected as a flush draw');

  const noFlushHole = [C('A', '♦'), C('K', '♥')];
  const noFlushBoard = [C('9', '♠'), C('4', '♣'), C('2', '♥')];
  const { flushDraw: noFlush } = detectDraws(noFlushHole, noFlushBoard);
  ok(noFlush === false, 'Three different suits scattered correctly does NOT register as a flush draw');

  const oesdHole = [C('9', '♦'), C('8', '♥')];
  const oesdBoard = [C('7', '♠'), C('6', '♣'), C('2', '♥')];
  const { openEndedDraw } = detectDraws(oesdHole, oesdBoard);
  ok(openEndedDraw === true, '9-8 on a 7-6-2 board correctly detected as an open-ended straight draw');
}

// ---- Preflop folding behavior: trash hands in early position should fold to a raise ----
{
  const e = new PokerEngine('foldtest', { smallBlind: 5, bigBlind: 10, startingChips: 1000 });
  for (let i = 0; i < 9; i++) e.seatBot(i, 'Bot' + i);
  e.dealerSeat = 0;
  e.phase = 'preflop';
  const order = e._seatOrderFrom(0);
  const earlySeat = order[2];
  e.currentPlayer = earlySeat;
  e.currentBet = 30; // someone raised preflop
  e.seats[earlySeat].bettedThisRound = 0;
  e.seats[earlySeat].hand = [C('7', '♠'), C('2', '♥')]; // genuine trash

  let foldCount = 0;
  for (let i = 0; i < 20; i++) {
    const decision = botDecideAction(e, earlySeat);
    if (decision.action === 'fold') foldCount++;
  }
  ok(foldCount >= 18, `72 offsuit facing a raise in early position folds the overwhelming majority of the time (${foldCount}/20)`);
}

// ---- Preflop premium hands should not fold ----
{
  const e = new PokerEngine('premiumtest', { smallBlind: 5, bigBlind: 10, startingChips: 1000 });
  for (let i = 0; i < 9; i++) e.seatBot(i, 'Bot' + i);
  e.dealerSeat = 0;
  e.phase = 'preflop';
  const order = e._seatOrderFrom(0);
  const earlySeat = order[2];
  e.currentPlayer = earlySeat;
  e.currentBet = 30;
  e.seats[earlySeat].bettedThisRound = 0;
  e.seats[earlySeat].hand = [C('A', '♠'), C('A', '♥')]; // pocket aces

  let foldCount = 0;
  for (let i = 0; i < 20; i++) {
    const decision = botDecideAction(e, earlySeat);
    if (decision.action === 'fold') foldCount++;
  }
  ok(foldCount === 0, `Pocket aces never folds preflop even in early position (folded ${foldCount}/20 times)`);
}

// ---- Personality stability: same seat gets a consistent personality across calls ----
{
  const e = new PokerEngine('persontest', { smallBlind: 5, bigBlind: 10, startingChips: 1000 });
  e.seatBot(0, 'Bot0');
  e.tableId = 'persontest';
  const { botDecideAction: bda } = require('./poker-bot');
  // Personality is keyed by tableId+pos internally; just confirm repeated
  // calls for the same seat don't throw and behave consistently enough
  // (this is more of a smoke test since personality itself isn't exposed
  // directly here).
  e.phase = 'preflop';
  e.currentPlayer = 0;
  e.currentBet = 0;
  e.seats[0].hand = [C('K', '♠'), C('K', '♥')];
  let crashed = false;
  try {
    for (let i = 0; i < 10; i++) botDecideAction(e, 0);
  } catch (err) { crashed = true; console.error(err); }
  ok(!crashed, 'Repeated decisions for the same bot seat run without crashing');
}

// ---- Extended simulation: no crashes, chips conserved, across many hands ----
{
  const e = new PokerEngine('simtest', { smallBlind: 5, bigBlind: 10, startingChips: 1000 });
  for (let i = 0; i < 9; i++) e.seatBot(i, 'Bot' + i);
  let crashed = false;
  try {
    for (let hand = 0; hand < 150; hand++) {
      e.checkReloads();
      e.startHand();
      if (e.phase === 'lobby') break;
      let guard = 0;
      while (e.phase !== 'handEnd' && guard < 500) {
        if (e.currentPlayer === -1) break;
        botAct(e, e.currentPlayer);
        guard++;
      }
      if (guard >= 500) { crashed = true; console.error('STUCK at hand', hand); break; }
    }
  } catch (err) {
    crashed = true;
    console.error('CRASHED:', err.message, err.stack);
  }
  ok(!crashed, '150-hand simulation with the new bot AI completes without crashing or getting stuck');
  const totalChips = e.occupiedSeats().reduce((sum, p) => sum + e.seats[p].chips, 0);
  ok(totalChips === 9000, 'Total chips conserved across 150 hands with the new bot AI, got ' + totalChips);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
