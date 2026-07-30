// ============================================================
// Texas Hold'em hand evaluator — finds the best 5-card hand out
// of any 7 cards (2 hole + 5 community), and can compare hands.
//
// A card is {rank, suit} where rank is one of
// '2','3','4','5','6','7','8','9','10','J','Q','K','A'
// and suit is one of '♠','♥','♦','♣'.
//
// This is the single most safety-critical piece of the whole
// poker build — a bug here means the wrong hand wins money — so
// it's brute-force-simple (try every 5-card combo out of 7,
// score each one, take the best) rather than clever, and is
// exhaustively unit-tested in poker-hand-eval.test.js before
// anything else in this feature gets built on top of it.
// ============================================================

const RANK_VALUES = { '2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14 };
const HAND_NAMES = [
  'High Card', 'Pair', 'Two Pair', 'Three of a Kind', 'Straight',
  'Flush', 'Full House', 'Four of a Kind', 'Straight Flush'
];

function rv(card) { return RANK_VALUES[card.rank]; }

// Evaluates exactly 5 cards. Returns a comparable score array:
// [handRankIndex, tiebreaker1, tiebreaker2, ...] where a
// lexicographically larger array is always a strictly better hand,
// regardless of hand type — this makes comparison trivial and safe.
function evaluate5(cards) {
  const ranks = cards.map(rv).sort((a, b) => b - a); // descending
  const suits = cards.map(c => c.suit);
  const isFlush = suits.every(s => s === suits[0]);

  // Count occurrences of each rank value, e.g. {14:2, 9:1, 5:1, 3:1}
  const counts = {};
  for (const r of ranks) counts[r] = (counts[r] || 0) + 1;
  // Groups sorted by (count desc, rank desc) -- e.g. a full house's
  // groups come out as [[3, tripRank], [2, pairRank]]
  const groups = Object.entries(counts)
    .map(([r, c]) => [c, Number(r)])
    .sort((a, b) => b[0] - a[0] || b[1] - a[1]);

  // Straight detection, including the wheel (A-2-3-4-5) where the Ace
  // plays LOW -- the one genuine special case in the whole evaluator.
  const uniqueRanksDesc = [...new Set(ranks)];
  let straightHigh = null;
  if (uniqueRanksDesc.length === 5) {
    if (uniqueRanksDesc[0] - uniqueRanksDesc[4] === 4) {
      straightHigh = uniqueRanksDesc[0];
    } else if (uniqueRanksDesc.join(',') === '14,5,4,3,2') {
      straightHigh = 5; // wheel: plays as a 5-high straight, not ace-high
    }
  }

  if (straightHigh && isFlush) return [8, straightHigh];
  if (groups[0][0] === 4) {
    const kicker = groups[1][1];
    return [7, groups[0][1], kicker];
  }
  if (groups[0][0] === 3 && groups[1][0] === 2) {
    return [6, groups[0][1], groups[1][1]];
  }
  if (isFlush) return [5, ...ranks];
  if (straightHigh) return [4, straightHigh];
  if (groups[0][0] === 3) {
    const kickers = groups.slice(1).map(g => g[1]).sort((a, b) => b - a);
    return [3, groups[0][1], ...kickers];
  }
  if (groups[0][0] === 2 && groups[1][0] === 2) {
    const pairHigh = Math.max(groups[0][1], groups[1][1]);
    const pairLow = Math.min(groups[0][1], groups[1][1]);
    const kicker = groups[2][1];
    return [2, pairHigh, pairLow, kicker];
  }
  if (groups[0][0] === 2) {
    const kickers = groups.slice(1).map(g => g[1]).sort((a, b) => b - a);
    return [1, groups[0][1], ...kickers];
  }
  return [0, ...ranks];
}

function compareScores(a, b) {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i] === undefined ? -1 : a[i];
    const bv = b[i] === undefined ? -1 : b[i];
    if (av !== bv) return av - bv;
  }
  return 0;
}

function combinations(arr, k) {
  const results = [];
  function go(start, combo) {
    if (combo.length === k) { results.push(combo.slice()); return; }
    for (let i = start; i < arr.length; i++) {
      combo.push(arr[i]);
      go(i + 1, combo);
      combo.pop();
    }
  }
  go(0, []);
  return results;
}

// Evaluates the best possible 5-card hand out of 5, 6, or 7 cards
// (hole cards + however much of the board is out). Returns
// {score, hand, handName} where hand is the actual best 5 cards.
function evaluateBest(cards) {
  if (cards.length < 5) throw new Error('evaluateBest needs at least 5 cards, got ' + cards.length);
  const combos = cards.length === 5 ? [cards] : combinations(cards, 5);
  let best = null, bestScore = null;
  for (const combo of combos) {
    const score = evaluate5(combo);
    if (!bestScore || compareScores(score, bestScore) > 0) {
      bestScore = score;
      best = combo;
    }
  }
  return { score: bestScore, hand: best, handName: HAND_NAMES[bestScore[0]] };
}

// Ranks multiple players' hole cards against a shared board. Returns
// an array of {index, score, hand, handName} sorted best-first, with
// ties genuinely tied (same score) so pot-splitting logic can group
// them correctly rather than arbitrarily picking one winner.
function rankPlayers(playerHoleCards, board) {
  const results = playerHoleCards.map((hole, index) => {
    const { score, hand, handName } = evaluateBest([...hole, ...board]);
    return { index, score, hand, handName };
  });
  results.sort((a, b) => compareScores(b.score, a.score));
  return results;
}

module.exports = { evaluate5, evaluateBest, compareScores, rankPlayers, HAND_NAMES, RANK_VALUES };
