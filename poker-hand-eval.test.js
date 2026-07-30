const { evaluate5, evaluateBest, compareScores, rankPlayers, HAND_NAMES } = require('./poker-hand-eval');

let pass = 0, fail = 0;
function C(rank, suit) { return { rank, suit }; }
function assertHandType(cards, expectedTypeIndex, label) {
  const { score, handName } = evaluateBest(cards);
  if (score[0] === expectedTypeIndex) {
    pass++;
  } else {
    fail++;
    console.error(`FAIL [${label}]: expected ${HAND_NAMES[expectedTypeIndex]}, got ${handName} (score ${JSON.stringify(score)})`);
  }
}
function assertBeats(handA, handB, label) {
  const a = evaluateBest(handA), b = evaluateBest(handB);
  if (compareScores(a.score, b.score) > 0) {
    pass++;
  } else {
    fail++;
    console.error(`FAIL [${label}]: expected A(${a.handName} ${JSON.stringify(a.score)}) to beat B(${b.handName} ${JSON.stringify(b.score)})`);
  }
}
function assertTie(handA, handB, label) {
  const a = evaluateBest(handA), b = evaluateBest(handB);
  if (compareScores(a.score, b.score) === 0) {
    pass++;
  } else {
    fail++;
    console.error(`FAIL [${label}]: expected TIE, got A(${JSON.stringify(a.score)}) vs B(${JSON.stringify(b.score)})`);
  }
}

// ---- Hand type identification, one per category ----
assertHandType([C('A','♠'),C('K','♠'),C('Q','♠'),C('J','♠'),C('10','♠'),C('2','♥'),C('3','♦')], 8, 'Royal flush (a Straight Flush, A-high)');
assertHandType([C('9','♣'),C('8','♣'),C('7','♣'),C('6','♣'),C('5','♣'),C('2','♥'),C('3','♦')], 8, 'Straight flush 9-high');
assertHandType([C('K','♠'),C('K','♥'),C('K','♦'),C('K','♣'),C('2','♠'),C('3','♥'),C('4','♦')], 7, 'Four of a kind');
assertHandType([C('Q','♠'),C('Q','♥'),C('Q','♦'),C('7','♣'),C('7','♠'),C('2','♥'),C('3','♦')], 6, 'Full house');
assertHandType([C('A','♠'),C('J','♠'),C('9','♠'),C('6','♠'),C('2','♠'),C('K','♥'),C('3','♦')], 5, 'Flush');
assertHandType([C('10','♠'),C('9','♥'),C('8','♦'),C('7','♣'),C('6','♠'),C('2','♥'),C('K','♦')], 4, 'Straight (10-high)');
assertHandType([C('A','♠'),C('2','♥'),C('3','♦'),C('4','♣'),C('5','♠'),C('9','♥'),C('K','♦')], 4, 'Wheel straight (A-2-3-4-5, ace plays low)');
assertHandType([C('9','♠'),C('9','♥'),C('9','♦'),C('K','♣'),C('2','♠'),C('5','♥'),C('7','♦')], 3, 'Three of a kind');
assertHandType([C('J','♠'),C('J','♥'),C('4','♦'),C('4','♣'),C('K','♠'),C('2','♥'),C('7','♦')], 2, 'Two pair');
assertHandType([C('8','♠'),C('8','♥'),C('K','♦'),C('Q','♣'),C('4','♠'),C('2','♥'),C('7','♦')], 1, 'One pair');
assertHandType([C('A','♠'),C('K','♥'),C('9','♦'),C('6','♣'),C('4','♠'),C('2','♥'),C('7','♦')], 0, 'High card');

// Fix the mislabeled wheel-straight-flush test above with a genuine same-suit version
assertHandType([C('A','♣'),C('2','♣'),C('3','♣'),C('4','♣'),C('5','♣'),C('9','♥'),C('K','♦')], 8, 'Wheel straight flush (A-2-3-4-5 same suit)');

// ---- Ranking / comparison correctness ----
assertBeats(
  [C('A','♠'),C('A','♥'),C('A','♦'),C('A','♣'),C('2','♠'),C('3','♥'),C('4','♦')], // quad aces
  [C('K','♠'),C('K','♥'),C('K','♦'),C('K','♣'),C('Q','♠'),C('3','♥'),C('4','♦')], // quad kings
  'Quad aces beat quad kings'
);
assertBeats(
  [C('K','♠'),C('K','♥'),C('K','♦'),C('9','♣'),C('9','♠'),C('3','♥'),C('4','♦')], // KKK99 full house
  [C('9','♠'),C('9','♥'),C('9','♦'),C('K','♣'),C('K','♠'),C('3','♥'),C('4','♦')], // 999KK full house (same cards actually -- fix below)
  'Full house comparison placeholder'
);
// Proper distinct full-house comparison: trips rank decides, not the pair
assertBeats(
  [C('K','♠'),C('K','♥'),C('K','♦'),C('2','♣'),C('2','♠'),C('3','♥'),C('4','♦')], // KKK22
  [C('Q','♠'),C('Q','♥'),C('Q','♦'),C('A','♣'),C('A','♠'),C('3','♥'),C('4','♦')], // QQQAA
  'KKK22 full house beats QQQAA full house (trip rank decides, not pair rank)'
);
assertBeats(
  [C('2','♠'),C('5','♠'),C('9','♠'),C('J','♠'),C('K','♠'),C('3','♥'),C('4','♦')], // K-high flush
  [C('2','♥'),C('5','♥'),C('9','♥'),C('J','♥'),C('Q','♥'),C('3','♦'),C('4','♠')], // Q-high flush
  'K-high flush beats Q-high flush'
);
assertBeats(
  [C('A','♠'),C('K','♠'),C('Q','♠'),C('J','♠'),C('10','♠'),C('2','♥'),C('3','♦')], // royal flush
  [C('K','♣'),C('K','♥'),C('K','♦'),C('K','♠'),C('A','♣'),C('2','♥'),C('3','♦')], // quad kings
  'Royal flush beats quad kings'
);
assertBeats(
  [C('A','♦'),C('A','♣'),C('K','♠'),C('K','♥'),C('2','♦'),C('3','♣'),C('5','♠')], // AA KK two pair, kicker 5
  [C('A','♠'),C('A','♥'),C('K','♦'),C('K','♣'),C('2','♠'),C('3','♥'),C('4','♦')], // AA KK two pair, kicker 4
  'Same two pair, higher kicker wins'
);
assertBeats(
  [C('A','♠'),C('K','♥'),C('Q','♦'),C('J','♣'),C('9','♠'),C('3','♥'),C('4','♦')], // A high card
  [C('K','♠'),C('Q','♥'),C('J','♦'),C('9','♣'),C('8','♠'),C('3','♥'),C('4','♦')], // K high card
  'A-high beats K-high (high card)'
);
assertBeats(
  [C('10','♠'),C('9','♥'),C('8','♦'),C('7','♣'),C('6','♠'),C('2','♥'),C('3','♦')], // 10-high straight
  [C('9','♠'),C('8','♥'),C('7','♦'),C('6','♣'),C('5','♠'),C('2','♥'),C('3','♦')], // 9-high straight
  '10-high straight beats 9-high straight'
);
assertBeats(
  [C('6','♠'),C('7','♥'),C('8','♦'),C('9','♣'),C('10','♠'),C('J','♥'),C('2','♦')], // J-high straight (uses the J from 7 cards)
  [C('A','♠'),C('2','♥'),C('3','♦'),C('4','♣'),C('5','♠'),C('9','♥'),C('K','♦')], // wheel, 5-high straight
  'J-high straight beats the wheel (5-high straight) -- ace-low wheel is the WORST straight'
);

// ---- Ties (genuinely identical strength, different cards) ----
assertTie(
  [C('A','♠'),C('A','♥'),C('K','♦'),C('K','♣'),C('2','♠'),C('3','♥'),C('4','♦')],
  [C('A','♦'),C('A','♣'),C('K','♠'),C('K','♥'),C('2','♦'),C('3','♣'),C('4','♠')],
  'Identical two-pair-plus-kicker across different suits ties exactly'
);
assertTie(
  [C('A','♠'),C('K','♠'),C('Q','♠'),C('J','♠'),C('10','♠'),C('2','♥'),C('3','♦')],
  [C('A','♥'),C('K','♥'),C('Q','♥'),C('J','♥'),C('10','♥'),C('5','♣'),C('6','♦')],
  'Two different royal flushes tie (suit doesn\'t break ties)'
);

// ---- Board plays scenario: both players use the same 5-card board, kicker in hole cards doesn't matter ----
{
  const board = [C('A','♠'),C('K','♠'),C('Q','♠'),C('J','♠'),C('10','♠')]; // royal flush ON the board
  const p1hole = [C('2','♥'),C('3','♦')];
  const p2hole = [C('4','♣'),C('5','♦')];
  assertTie([...p1hole, ...board], [...p2hole, ...board], 'Royal flush on the board plays for both -- hole cards irrelevant, must tie');
}

// ---- rankPlayers integration test with a realistic multi-way scenario ----
{
  const board = [C('9','♠'),C('9','♥'),C('4','♦'),C('2','♣'),C('7','♠')];
  const players = [
    [C('9','♦'),C('9','♣')], // quad nines -- clear winner
    [C('A','♠'),C('K','♠')], // just a pair of nines with AK kickers
    [C('4','♠'),C('4','♥')], // full house 44499 -- wait, only two 4s + trip 9s from board = 999 44, should be full house
  ];
  const ranked = rankPlayers(players, board);
  if (ranked[0].index === 0 && ranked[0].handName === 'Four of a Kind') {
    pass++;
  } else {
    fail++;
    console.error('FAIL [rankPlayers integration]: expected player 0 (quad nines) to win, got', JSON.stringify(ranked));
  }
  if (ranked[1].index === 2 && ranked[1].handName === 'Full House') {
    pass++;
  } else {
    fail++;
    console.error('FAIL [rankPlayers integration, 2nd place]: expected player 2 (full house) in 2nd, got', JSON.stringify(ranked[1]));
  }
}

// ---- Straight edge case: does NOT wrap around (K-A-2-3-4 is not a straight) ----
assertHandType([C('K','♠'),C('A','♥'),C('2','♦'),C('3','♣'),C('4','♠'),C('9','♥'),C('7','♦')], 0, 'K-A-2-3-4 is NOT a straight (no wraparound) -- all distinct ranks, so this is just High Card');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
