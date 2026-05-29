const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const SUIT_VAL = { '♠': 0, '♥': 1, '♦': 2, '♣': 3 };
const RANK_VAL = { '7': 0, '8': 1, '9': 2, '10': 3, 'J': 4, 'Q': 5, 'K': 6, 'A': 7 };
const CARD_PTS = { 'J': 3, '9': 2, 'A': 1, '10': 1 };
const RANK_POWER = { 'J': 8, '9': 7, 'A': 6, '10': 5, 'K': 4, 'Q': 3, '8': 2, '7': 1 };
const BOT_NAMES = ['Charlie', 'Johny', 'Nate', 'Neha', 'Koshy', 'Sam', 'Benson', 'Babu', 'Wesley', 'Roby', 'Niya', 'Alex', 'Raju'];
const MATCH_WIN = 12, MATCH_START = 6;
const PHASE1_MIN = 14, PHASE2_MIN = 21, PHASE2_SECOND_MIN = 24;

let G = {
  mode: 'offline', players: [], hands: [[], [], [], []], tricks: [0, 0, 0, 0],
  trickPoints: [0, 0, 0, 0], matchScore: [MATCH_START, MATCH_START], dealer: 0,
  bidder: -1, bid: 0, trump: '', trumpRevealed: false, phase: '', turn: 0,
  trick: [], trickSuit: '', round: 1, mySeat: 0, seenCards: [[], [], [], []],
  allPlayed: [], bidPassCount: [0, 0, 0, 0], hasBidBefore: [false, false, false, false],
  deck: [], trumpCard: null, discardMode: false
};

let gameLogEntries = [];
const MAX_LOG_ENTRIES = 50;

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    let j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function makeDeck() {
  let d = [];
  for (let s of SUITS) for (let r of RANKS) d.push({ suit: s, rank: r, id: r + s });
  return shuffle(d);
}

function pts(c) { return CARD_PTS[c.rank] || 0; }
function power(c) { return RANK_POWER[c.rank] || 0; }
function isRed(s) { return s == '♥' || s == '♦'; }
function dbg(m) {
  let el = document.getElementById('debug');
  if (el) el.textContent = m;
}

function showPage(pageId) {
  try {
    document.querySelectorAll('.page').forEach(p => p.style.display = 'none');
    let target = document.getElementById(pageId);
    if (target) target.style.display = 'block';
    window.scrollTo(0, 0);
  } catch (e) {}
}

function addLog(type, text) {
  let entry = {
    type: type,
    text: text,
    time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  };
  gameLogEntries.push(entry);
  if (gameLogEntries.length > MAX_LOG_ENTRIES) gameLogEntries.shift();
  renderLog();
}

function renderLog() {
  let el = document.getElementById('gameLogContent');
  if (!el) return;
  el.innerHTML = gameLogEntries.map(e =>
    '<div class="game-log-entry ' + e.type + '"><span style="color:#664400">[' + e.time + ']</span> ' + e.text + '</div>'
  ).join('');
  el.scrollTop = el.scrollHeight;
}

function clearLog() {
  gameLogEntries = [];
  renderLog();
}

let selectedOfflineName = 'You';

function renderNamePicker() {
  try {
    let container = document.getElementById('namePicker');
    if (!container) return;
    container.innerHTML = '';
    BOT_NAMES.forEach(name => {
      let btn = document.createElement('button');
      btn.className = 'name-pick-btn' + (name === selectedOfflineName ? ' selected' : '');
      btn.textContent = name;
      btn.onclick = function () {
        selectedOfflineName = name;
        document.getElementById('offlineName').value = name;
        document.querySelectorAll('.name-pick-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
      };
      container.appendChild(btn);
    });
    let youBtn = document.createElement('button');
    youBtn.className = 'name-pick-btn' + ('You' === selectedOfflineName ? ' selected' : '');
    youBtn.textContent = 'You';
    youBtn.onclick = function () {
      selectedOfflineName = 'You';
      document.getElementById('offlineName').value = 'You';
      document.querySelectorAll('.name-pick-btn').forEach(b => b.classList.remove('selected'));
      youBtn.classList.add('selected');
    };
    container.appendChild(youBtn);
  } catch (e) { dbg('NAMEPICKER ERROR: ' + e.message); }
}

function startOfflineWithName() {
  try {
    let name = document.getElementById('offlineName').value.trim() || 'You';
    G.mode = 'offline';
    let availableBots = BOT_NAMES.filter(n => n !== name);
    let shuffled = availableBots.sort(() => Math.random() - 0.5);
    G.players = [
      { name: name, type: 'human', team: 0 },
      { name: shuffled[0] || 'Bot1', type: 'bot', team: 1 },
      { name: shuffled[1] || 'Bot2', type: 'bot', team: 0 },
      { name: shuffled[2] || 'Bot3', type: 'bot', team: 1 }
    ];
    G.mySeat = 0;
    G.matchScore = [MATCH_START, MATCH_START];
    G.round = 1;
    G.dealer = Math.floor(Math.random() * 4);
    document.body.classList.add('game-active');
    document.getElementById('page4').classList.add('active');
    showPage('page4');
    let overlay = document.getElementById('startOverlay');
    if (overlay) overlay.style.display = 'none';
    newRound();
  } catch (e) { dbg('STARTOFFLINE NAME ERROR: ' + e.message); }
}

function startOffline() {
  try {
    G.mode = 'offline';
    let shuffled = BOT_NAMES.slice().sort(() => Math.random() - 0.5);
    G.players = [
      { name: 'You', type: 'human', team: 0 },
      { name: shuffled[0], type: 'bot', team: 1 },
      { name: shuffled[1], type: 'bot', team: 0 },
      { name: shuffled[2], type: 'bot', team: 1 }
    ];
    G.mySeat = 0;
    G.matchScore = [MATCH_START, MATCH_START];
    G.round = 1;
    G.dealer = Math.floor(Math.random() * 4);
    document.body.classList.add('game-active');
    document.getElementById('page4').classList.add('active');
    showPage('page4');
    let overlay = document.getElementById('startOverlay');
    if (overlay) overlay.style.display = 'none';
    newRound();
  } catch (e) { dbg('START ERROR: ' + e.message); }
}

function manualStartGame() {
  try {
    let overlay = document.getElementById('startOverlay');
    if (overlay) overlay.style.display = 'none';
    if (G.mode === 'offline' && G.players.length === 0) {
      startOfflineWithName();
    } else if (G.players.length === 0) {
      startOffline();
    } else {
      newRound();
    }
  } catch (e) { dbg('MANUAL START ERROR: ' + e.message); }
}

function newRound() {
  try {
    clearLog();
    G.hands = [[], [], [], []];
    G.tricks = [0, 0, 0, 0];
    G.trickPoints = [0, 0, 0, 0];
    G.bid = 0;
    G.bidder = -1;
    G.trump = '';
    G.trumpRevealed = false;
    G.trumpCard = null;
    G.trick = [];
    G.trickSuit = '';
    G.phase = 'deal1';
    G.seenCards = [[], [], [], []];
    G.allPlayed = [];
    G.bidPassCount = [0, 0, 0, 0];
    G.hasBidBefore = [false, false, false, false];
    G.deck = makeDeck();
    for (let p = 0; p < 4; p++) for (let i = 0; i < 4; i++) G.hands[p].push(G.deck.pop());
    for (let p = 0; p < 4; p++) G.hands[p].sort((a, b) => SUIT_VAL[a.suit] - SUIT_VAL[b.suit] || RANK_VAL[a.rank] - RANK_VAL[b.rank]);
    G.phase = 'bid1';
    G.turn = (G.dealer + 1) % 4;
    updateUI();
    addLog('system', '🃏 Round ' + G.round + ' started. Dealer: ' + G.players[G.dealer].name);
    addLog('system', 'Phase 1: 4 cards dealt. Bidding from ' + PHASE1_MIN + '+');
    showMsg('🃏 Round ' + G.round + ' | Dealer: ' + G.players[G.dealer].name + ' | Phase 1: Bid from ' + PHASE1_MIN + '+');
    if (G.turn === G.mySeat) { showBid(); }
    else { hideBid(); setTimeout(botBid, 800); }
  } catch (e) { dbg('ROUND ERROR: ' + e.message); }
}

function showBid() {
  try {
    let panel = document.getElementById('bidPanel');
    if (panel) panel.style.display = 'block';
    let minBid = getMinBid(G.turn);
    let current = G.bid > 0 ? '🏆 ' + G.bid + ' by ' + G.players[G.bidder].name : 'None';
    let phaseName = G.phase === 'bid1' ? 'Phase 1 (4 cards)' : 'Phase 2 (8 cards)';
    let extraRule = (G.phase === 'bid2' && G.hasBidBefore[G.turn]) ? ' | Must bid 24+' : '';
    let startPlayer = (G.dealer + 1) % 4;
    let isFirstBidPhase1 = (G.phase === 'bid1' && G.turn === startPlayer && G.bid === 0);
    let info = document.getElementById('bidInfo');
    if (info) {
      let msg = phaseName + ' | Min: ' + minBid + ' | Highest: ' + current + extraRule;
      if (isFirstBidPhase1) msg = '🎯 FIRST BIDDER - Must bid ' + PHASE1_MIN + '+ | ' + msg;
      info.textContent = msg;
    }
    let btns = document.getElementById('bidButtons');
    if (btns) {
      btns.innerHTML = '';
      if (!isFirstBidPhase1) {
        let pass = document.createElement('button');
        pass.className = 'bid-btn pass';
        pass.textContent = 'PASS';
        pass.onclick = () => doBid(0);
        btns.appendChild(pass);
      }
      for (let b = minBid; b <= 28; b++) {
        let btn = document.createElement('button');
        btn.className = 'bid-btn';
        btn.textContent = b;
        if (G.phase === 'bid2' && G.hasBidBefore[G.turn] && b < PHASE2_SECOND_MIN) {
          btn.disabled = true;
          btn.style.opacity = '0.3';
        }
        btn.onclick = () => doBid(b);
        btns.appendChild(btn);
      }
    }
  } catch (e) { dbg('SHOWBID ERROR: ' + e.message); }
}

function hideBid() {
  let el = document.getElementById('bidPanel');
  if (el) el.style.display = 'none';
}

function getMinBid(player) {
  if (G.phase === 'bid1') {
    if (G.bid === 0) return PHASE1_MIN;
    return G.bid + 1;
  }
  if (G.hasBidBefore[player]) return Math.max(PHASE2_SECOND_MIN, G.bid + 1);
  return Math.max(PHASE2_MIN, G.bid + 1);
}

function doBid(amt) {
  try {
    hideBid();
    if (amt === 0) {
      G.bidPassCount[G.turn]++;
      showMsg(G.players[G.turn].name + ' passed');
      addLog('bid', G.players[G.turn].name + ' passed');
    } else {
      G.bid = amt;
      G.bidder = G.turn;
      G.hasBidBefore[G.turn] = true;
      showMsg(G.players[G.turn].name + ' bids ' + amt);
      addLog('bid', '🏆 ' + G.players[G.turn].name + ' bids ' + amt);
    }
    G.turn = (G.turn + 1) % 4;
    let startPlayer = (G.dealer + 1) % 4;
    if (G.turn === startPlayer) {
      if (G.bidder < 0) {
        showMsg('No bids! Redealing...');
        setTimeout(newRound, 1500);
        return;
      }
      if (G.phase === 'bid1') { trumpPhase(); return; }
      else { startPlay(); return; }
    }
    if (G.turn === G.mySeat) { showBid(); }
    else { hideBid(); setTimeout(botBid, 800); }
  } catch (e) { dbg('DOBID ERROR: ' + e.message); }
}

function botBid() {
  try {
    let p = G.turn, hand = G.hands[p];
    let myPoints = hand.reduce((s, c) => s + pts(c), 0);
    let minBid = getMinBid(p);
    let startPlayer = (G.dealer + 1) % 4;
    let isFirstBidPhase1 = (G.phase === 'bid1' && p === startPlayer && G.bid === 0);
    let jacks = hand.filter(c => c.rank === 'J').length;
    let nines = hand.filter(c => c.rank === '9').length;
    let powerCards = jacks + nines;
    let suitCounts = {};
    SUITS.forEach(s => suitCounts[s] = 0);
    hand.forEach(c => suitCounts[c.suit]++);
    let maxSuitCount = Math.max(...Object.values(suitCounts));

    if (G.phase === 'bid1') {
      if (isFirstBidPhase1) {
        let bid = PHASE1_MIN;
        if (myPoints >= 5 && powerCards >= 2) bid = Math.min(18, PHASE1_MIN + 2);
        if (myPoints >= 7 && powerCards >= 2) bid = Math.min(20, PHASE1_MIN + 4);
        if (myPoints >= 9 && powerCards >= 3) bid = Math.min(22, PHASE1_MIN + 6);
        if (myPoints >= 11 && jacks >= 2) bid = Math.min(24, PHASE1_MIN + 8);
        if (myPoints >= 13 && jacks >= 3) bid = Math.min(26, PHASE1_MIN + 10);
        doBid(bid);
        return;
      }
      let conservativeEstimate = myPoints * 0.6;
      if (powerCards >= 2) conservativeEstimate += 2;
      if (maxSuitCount >= 3) conservativeEstimate += 1;
      let partnerEstimate = 3.5;
      let teamEstimate = conservativeEstimate + partnerEstimate;
      let safeBid = Math.floor(teamEstimate * 0.7);
      if (myPoints < 4 || powerCards === 0) { doBid(0); return; }
      if (safeBid < PHASE1_MIN) { doBid(0); return; }
      if (powerCards === 1 && safeBid > 16) safeBid = 16;
      if (powerCards === 2 && safeBid > 20) safeBid = 20;
      if (powerCards >= 3 && safeBid > 24) safeBid = 24;
      let bid = Math.max(minBid, Math.min(safeBid, minBid + 1));
      doBid(Math.min(bid, 28));
      return;
    }

    let partner = (p + 2) % 4;
    let partnerPoints = G.hands[partner].reduce((s, c) => s + pts(c), 0);
    let partnerPower = G.hands[partner].filter(c => c.rank === 'J' || c.rank === '9').length;
    let teamPoints = myPoints + partnerPoints;
    let teamPower = powerCards + partnerPower;
    let opp1 = (p + 1) % 4, opp2 = (p + 3) % 4;
    let oppPoints = G.hands[opp1].reduce((s, c) => s + pts(c), 0) + G.hands[opp2].reduce((s, c) => s + pts(c), 0);
    let oppPower = G.hands[opp1].filter(c => c.rank === 'J' || c.rank === '9').length + G.hands[opp2].filter(c => c.rank === 'J' || c.rank === '9').length;
    let powerAdvantage = teamPower - oppPower;
    let pointAdvantage = teamPoints - oppPoints;
    let safeBid = Math.floor(teamPoints * 0.65);
    if (powerAdvantage >= 2) safeBid += 2;
    else if (powerAdvantage <= -2) safeBid -= 3;
    if (pointAdvantage > 4) safeBid += 1;
    else if (pointAdvantage < -4) safeBid -= 2;
    let isBidderTeam = (p % 2 === G.bidder % 2);
    if (!isBidderTeam && G.bid > 0) safeBid = Math.min(safeBid, G.bid - 1);
    if (safeBid < minBid) { doBid(0); return; }
    if (G.hasBidBefore[p]) {
      if (safeBid < PHASE2_SECOND_MIN || teamPower < 3) { doBid(0); return; }
      safeBid = Math.max(safeBid, PHASE2_SECOND_MIN);
    }
    if (teamPower < 2 && safeBid > 20) safeBid = 20;
    if (teamPoints < 12 && safeBid > 22) safeBid = 22;
    if (teamPoints < 16 && safeBid > 25) safeBid = 25;
    let bid = Math.max(minBid, Math.min(safeBid, minBid + 2));
    doBid(Math.min(bid, 28));
  } catch (e) { dbg('BOTBID ERROR: ' + e.message); }
}

function trumpPhase() {
  try {
    G.phase = 'trump';
    G.turn = G.bidder;
    showMsg('🏆 ' + G.players[G.bidder].name + ' won bid at ' + G.bid + '! Set trump (face down).');
    addLog('bid', '🏆 ' + G.players[G.bidder].name + ' won bid at ' + G.bid);
    if (G.bidder === G.mySeat) {
      let el = document.getElementById('trumpPanel');
      if (el) el.style.display = 'block';
    } else {
      let el = document.getElementById('trumpPanel');
      if (el) el.style.display = 'none';
      setTimeout(botTrump, 1000);
    }
  } catch (e) { dbg('TRUMPPHASE ERROR: ' + e.message); }
}

function setTrump(s) {
  try {
    G.trump = s;
    let bidderHand = G.hands[G.bidder];
    let trumpCards = bidderHand.filter(c => c.suit === s);
    if (trumpCards.length) {
      let idx = bidderHand.findIndex(c => c.suit === s);
      G.trumpCard = bidderHand.splice(idx, 1)[0];
    } else {
      G.trumpCard = { suit: s, rank: '7', id: '7' + s };
    }
    let el = document.getElementById('trumpPanel');
    if (el) el.style.display = 'none';
    let ts = document.getElementById('trumpShow');
    if (ts) ts.textContent = '?';
    showMsg('🎺 Trump set! Dealing 4 more cards...');
    addLog('trump', '🎺 Trump set (hidden). Dealing 4 more cards...');
    setTimeout(() => {
      for (let p = 0; p < 4; p++) for (let i = 0; i < 4; i++) G.hands[p].push(G.deck.pop());
      for (let p = 0; p < 4; p++) G.hands[p].sort((a, b) => SUIT_VAL[a.suit] - SUIT_VAL[b.suit] || RANK_VAL[a.rank] - RANK_VAL[b.rank]);
      G.phase = 'bid2';
      G.turn = (G.dealer + 1) % 4;
      G.bidPassCount = [0, 0, 0, 0];
      updateUI();
      showMsg('🃏 Phase 2: Bid from ' + PHASE2_MIN + '+ (rebid must be 24+)');
      addLog('system', 'Phase 2: 4 more cards dealt. Bidding from ' + PHASE2_MIN + '+');
      if (G.turn === G.mySeat) { showBid(); }
      else { hideBid(); setTimeout(botBid, 800); }
    }, 800);
  } catch (e) { dbg('SETTRUMP ERROR: ' + e.message); }
}

function botTrump() {
  try {
    let hand = G.hands[G.bidder];
    let suitCounts = {};
    SUITS.forEach(s => suitCounts[s] = 0);
    hand.forEach(c => suitCounts[c.suit] += pts(c) + 0.5);
    let best = SUITS.reduce((a, b) => suitCounts[a] > suitCounts[b] ? a : b);
    setTrump(best);
  } catch (e) { dbg('BOTTRUMP ERROR: ' + e.message); }
}

function startPlay() {
  try {
    G.phase = 'play';
    G.trumpRevealed = false;
    showMsg('🎮 Play begins! ' + G.players[G.bidder].name + ' leads. Trump is hidden.');
    addLog('system', '🎮 Play begins! ' + G.players[G.bidder].name + ' leads.');
    G.turn = G.bidder;
    updateUI();
    if (G.turn === G.mySeat) { humanTurn(); }
    else { setTimeout(botPlay, 1000); }
  } catch (e) { dbg('STARTPLAY ERROR: ' + e.message); }
}

function playTurn() {
  try {
    updateUI();
    G.discardMode = false;
    let atp = document.getElementById('askTrumpPanel');
    if (atp) atp.style.display = 'none';
    let hl = document.getElementById('handLabel');
    if (hl) hl.textContent = 'YOUR CARDS - Tap to play';
    if (G.turn === G.mySeat) { humanTurn(); }
    else { showMsg('🤖 ' + G.players[G.turn].name + ' thinking...'); setTimeout(botPlay, 1000); }
  } catch (e) { dbg('PLAYTURN ERROR: ' + e.message); }
}

function humanTurn() {
  try {
    let hand = G.hands[G.mySeat];
    let hasLedSuit = G.trickSuit && hand.some(c => c.suit === G.trickSuit);
    if (G.trick.length === 0 || hasLedSuit) {
      showMsg('👆 Your turn! Tap card.');
      enableCards();
      return;
    }
    if (G.trumpRevealed) {
      showMsg('🤔 No ' + G.trickSuit + '. Play any card (trump wins!)');
      let cards = document.querySelectorAll('#hand .card');
      cards.forEach((el, i) => {
        el.classList.remove('disabled', 'playable');
        el.classList.add('playable');
        el.onclick = () => playCard(i);
      });
      return;
    }
    showMsg('🤔 No ' + G.trickSuit + '. Ask for trump or discard?');
    let atp = document.getElementById('askTrumpPanel');
    if (atp) atp.style.display = 'block';
    let cards = document.querySelectorAll('#hand .card');
    cards.forEach(el => { el.classList.remove('disabled', 'playable'); el.classList.add('disabled'); el.onclick = null; });
  } catch (e) { dbg('HUMANTURN ERROR: ' + e.message); }
}

function askRevealTrump() {
  try {
    G.trumpRevealed = true;
    if (G.trumpCard) {
      G.hands[G.bidder].push(G.trumpCard);
      G.hands[G.bidder].sort((a, b) => SUIT_VAL[a.suit] - SUIT_VAL[b.suit] || RANK_VAL[a.rank] - RANK_VAL[b.rank]);
      G.trumpCard = null;
    }
    let ts = document.getElementById('trumpShow');
    if (ts) ts.textContent = G.trump;
    let atp = document.getElementById('askTrumpPanel');
    if (atp) atp.style.display = 'none';
    showMsg('🎺 TRUMP REVEALED: ' + G.trump + '! You must play trump if you have one.');
    addLog('trump', '🎺 TRUMP REVEALED: ' + G.trump + '!');
    let hand = G.hands[G.mySeat];
    let hasTrump = hand.some(c => c.suit === G.trump);
    let cards = document.querySelectorAll('#hand .card');
    cards.forEach((el, i) => {
      let c = hand[i];
      el.classList.remove('disabled', 'playable');
      if (hasTrump && c.suit !== G.trump) { el.classList.add('disabled'); el.onclick = null; }
      else { el.classList.add('playable'); el.onclick = () => playCard(i); }
    });
    let hl = document.getElementById('handLabel');
    if (hl) hl.textContent = hasTrump ? 'MUST PLAY TRUMP' : 'No trump - discard any';
  } catch (e) { dbg('ASKTRUMP ERROR: ' + e.message); }
}

function enableDiscardMode() {
  try {
    G.discardMode = true;
    let atp = document.getElementById('askTrumpPanel');
    if (atp) atp.style.display = 'none';
    showMsg('🗑️ Discard any card');
    let hl = document.getElementById('handLabel');
    if (hl) hl.textContent = 'DISCARD - Tap any card';
    let hand = G.hands[G.mySeat];
    let cards = document.querySelectorAll('#hand .card');
    cards.forEach((el, i) => {
      el.classList.remove('disabled', 'playable');
      el.classList.add('playable');
      el.onclick = () => playCard(i);
    });
  } catch (e) { dbg('DISCARD ERROR: ' + e.message); }
}

function enableCards() {
  try {
    let hand = G.hands[G.mySeat], cards = document.querySelectorAll('#hand .card');
    cards.forEach((el, i) => {
      let c = hand[i];
      el.classList.remove('disabled', 'playable');
      if (!validPlay(c, G.mySeat)) { el.classList.add('disabled'); el.onclick = null; }
      else { el.classList.add('playable'); el.onclick = () => playCard(i); }
    });
  } catch (e) { dbg('ENABLE ERROR: ' + e.message); }
}

function validPlay(card, pIdx) {
  if (G.trick.length === 0) {
    if (!G.trumpRevealed && pIdx === G.bidder && card.suit === G.trump) {
      let hasNonTrump = G.hands[pIdx].some(c => c.suit !== G.trump);
      if (hasNonTrump) return false;
    }
    return true;
  }
  let hasSuit = G.hands[pIdx].some(c => c.suit === G.trickSuit);
  if (hasSuit && card.suit !== G.trickSuit) return false;
  return true;
}

function playCard(idx) {
  try {
    let c = G.hands[G.mySeat][idx];
    G.hands[G.mySeat].splice(idx, 1);
    G.trick.push({ player: G.mySeat, card: c });
    if (G.trick.length === 1) G.trickSuit = c.suit;
    showMsg('You: ' + c.rank + c.suit);
    addLog('play', 'You played ' + c.rank + c.suit);
    updateUI();
    G.turn = (G.turn + 1) % 4;
    if (G.trick.length === 4) setTimeout(resolveTrick, 1000);
    else setTimeout(playTurn, 600);
  } catch (e) { dbg('PLAYCARD ERROR: ' + e.message); }
}

function botPlay() {
  try {
    let p = G.turn, hand = G.hands[p];
    let canFollowSuit = G.trickSuit && hand.some(c => c.suit === G.trickSuit);
    let isBidder = (p === G.bidder);
    if (G.trickSuit && !canFollowSuit && !G.trumpRevealed) {
      let shouldAsk = botShouldAskTrump(p, hand);
      if (shouldAsk) {
        G.trumpRevealed = true;
        if (G.trumpCard) {
          G.hands[G.bidder].push(G.trumpCard);
          G.hands[G.bidder].sort((a, b) => SUIT_VAL[a.suit] - SUIT_VAL[b.suit] || RANK_VAL[a.rank] - RANK_VAL[b.rank]);
          G.trumpCard = null;
        }
        let ts = document.getElementById('trumpShow');
        if (ts) ts.textContent = G.trump;
        showMsg(G.players[p].name + ' asks for TRUMP! ' + G.trump + ' revealed!');
        addLog('trump', G.players[p].name + ' asks for TRUMP! ' + G.trump + ' revealed!');
        let hasTrump = hand.some(c => c.suit === G.trump);
        if (hasTrump) {
          let trumpIdxs = [];
          for (let i = 0; i < hand.length; i++) if (hand[i].suit === G.trump) trumpIdxs.push(i);
          let chosen = trumpIdxs.sort((a, b) => power(hand[b]) - power(hand[a]))[0];
          playBotCard(p, chosen);
          return;
        }
        let chosen = hand.map((c, i) => ({ i, p: power(c) })).sort((a, b) => a.p - b.p)[0].i;
        playBotCard(p, chosen);
        return;
      }
    }
    let valid = [];
    for (let i = 0; i < hand.length; i++) if (validPlay(hand[i], p)) valid.push(i);
    if (!valid.length) valid = [0];
    let chosen = G.trick.length === 0 ? botLead(p, hand, valid) : botFollow(p, hand, valid);
    playBotCard(p, chosen);
  } catch (e) { dbg('BOTPLAY ERROR: ' + e.message); }
}

function botShouldAskTrump(p, hand) {
  let isBidder = (p === G.bidder);
  let team = p % 2;
  let current = trickWinner();
  let winningTeam = current ? current.player % 2 : -1;
  if (winningTeam === team && current.player !== p) return false;
  if (isBidder) {
    let hasTrump = hand.some(c => c.suit === G.trump);
    if (!hasTrump) return false;
    let ourBestTrump = hand.filter(c => c.suit === G.trump).sort((a, b) => power(b) - power(a))[0];
    let trumpPlayed = G.trick.some(t => t.card.suit === G.trump);
    if (!trumpPlayed) return true;
    let bestTrumpPlayed = G.trick.filter(t => t.card.suit === G.trump).sort((a, b) => power(b.card) - power(a.card))[0];
    if (power(ourBestTrump) > power(bestTrumpPlayed.card)) return true;
    return false;
  }
  let trickValue = G.trick.reduce((s, t) => s + pts(t.card), 0);
  let myPowerCards = hand.filter(c => power(c) >= 6).length;
  let isBidderTeam = (team === G.bidder % 2);
  let myTeamPts = G.trickPoints[p] + G.trickPoints[(p + 2) % 4];
  let ptsNeeded = Math.max(0, G.bid - myTeamPts);
  if (myPowerCards === 0) return false;
  if (isBidderTeam && ptsNeeded <= 4 && trickValue >= 2) return Math.random() < 0.6;
  let oppTeamPts = G.trickPoints[(p + 1) % 4] + G.trickPoints[(p + 3) % 4];
  if (!isBidderTeam && oppTeamPts >= G.bid - 3 && trickValue >= 1) return Math.random() < 0.5;
  return Math.random() < 0.15;
}

function playBotCard(p, chosen) {
  try {
    let hand = G.hands[p];
    let c = hand[chosen];
    hand.splice(chosen, 1);
    G.trick.push({ player: p, card: c });
    if (G.trick.length === 1) G.trickSuit = c.suit;
    G.seenCards[p].push(c);
    G.allPlayed.push(c);
    showMsg(G.players[p].name + ': ' + c.rank + c.suit);
    addLog('play', G.players[p].name + ' played ' + c.rank + c.suit);
    updateUI();
    G.turn = (G.turn + 1) % 4;
    if (G.trick.length === 4) setTimeout(resolveTrick, 1200);
    else setTimeout(playTurn, 700);
  } catch (e) { dbg('PLAYBOT ERROR: ' + e.message); }
}

function botLead(p, hand, valid) {
  let team = p % 2, partner = (p + 2) % 4;
  let myTeamPts = G.trickPoints[p] + G.trickPoints[partner];
  let isBidderTeam = (team === G.bidder % 2);
  let ptsNeeded = Math.max(0, G.bid - myTeamPts);
  let isBidder = (p === G.bidder);
  let leadOptions = valid.slice();
  if (isBidder && !G.trumpRevealed) {
    let nonTrump = valid.filter(i => hand[i].suit !== G.trump);
    if (nonTrump.length) leadOptions = nonTrump;
  }
  if (!leadOptions.length) leadOptions = valid;
  let jacks = leadOptions.filter(i => hand[i].rank === 'J');
  if (jacks.length) {
    jacks.sort((a, b) => {
      let suitA = hand[a].suit, suitB = hand[b].suit;
      let backupA = hand.filter(c => c.suit === suitA && c.rank !== 'J').length;
      let backupB = hand.filter(c => c.suit === suitB && c.rank !== 'J').length;
      return backupB - backupA;
    });
    return jacks[0];
  }
  let safeOptions = [];
  for (let i of leadOptions) {
    let c = hand[i];
    if (c.rank === '9') {
      let jackGone = G.allPlayed.some(card => card.suit === c.suit && card.rank === 'J');
      if (jackGone) safeOptions.push(i);
    } else {
      safeOptions.push(i);
    }
  }
  if (!safeOptions.length) safeOptions = leadOptions;
  let byPower = safeOptions.slice().sort((a, b) => power(hand[b]) - power(hand[a]));
  if (isBidderTeam && ptsNeeded > 0) return byPower[0];
  let oppTeamPts = G.trickPoints[(p + 1) % 4] + G.trickPoints[(p + 3) % 4];
  if (!isBidderTeam && oppTeamPts >= G.bid - 3) return byPower[0];
  let suitCounts = {};
  SUITS.forEach(s => suitCounts[s] = 0);
  safeOptions.forEach(i => suitCounts[hand[i].suit]++);
  let bestSuit = Object.keys(suitCounts).reduce((a, b) => suitCounts[a] > suitCounts[b] ? a : b);
  let suitCards = safeOptions.filter(i => hand[i].suit === bestSuit);
  suitCards.sort((a, b) => power(hand[b]) - power(hand[a]));
  return suitCards[0];
}

function botFollow(p, hand, valid) {
  let led = G.trickSuit, team = p % 2, partner = (p + 2) % 4;
  let current = trickWinner();
  if (!current) return valid.sort((a, b) => power(hand[a]) - power(hand[b]))[0];
  let winningTeam = current.player % 2;
  if (winningTeam === team && current.player !== p) {
    return valid.sort((a, b) => power(hand[a]) - power(hand[b]))[0];
  }
  let candidates = [];
  for (let i of valid) {
    let c = hand[i];
    let canBeat = false;
    if (G.trumpRevealed && c.suit === G.trump) {
      if (current.card.suit !== G.trump) canBeat = true;
      else if (power(c) > power(current.card)) canBeat = true;
    } else if (c.suit === led) {
      if (current.card.suit !== G.trump && power(c) > power(current.card)) canBeat = true;
      else if (!G.trumpRevealed && power(c) > power(current.card)) canBeat = true;
    }
    if (canBeat) candidates.push({ idx: i, power: power(c) });
  }
  if (candidates.length) {
    candidates.sort((a, b) => a.power - b.power);
    return candidates[0].idx;
  }
  return valid.sort((a, b) => power(hand[a]) - power(hand[b]))[0];
}

function trickWinner() {
  let t = G.trick;
  if (!t.length) return null;
  let w = t[0];
  for (let i = 1; i < t.length; i++) {
    let c = t[i];
    if (G.trumpRevealed && c.card.suit === G.trump && w.card.suit !== G.trump) w = c;
    else if (c.card.suit === w.card.suit && power(c.card) > power(w.card)) w = c;
  }
  return w;
}

function resolveTrick() {
  try {
    let w = trickWinner(), wp = w.player;
    G.tricks[wp]++;
    let trickPts = G.trick.reduce((s, t) => s + pts(t.card), 0);
    G.trickPoints[wp] += trickPts;
    G.turn = wp;
    let area = document.getElementById('playArea');
    let div = document.createElement('div');
    div.className = 'trick-winner-anim';
    div.textContent = '🏆 ' + G.players[wp].name + ' +' + trickPts + 'pts';
    if (area) area.appendChild(div);
    G.trick.forEach(t => { G.seenCards[t.player].push(t.card); G.allPlayed.push(t.card); });
    showMsg(G.players[wp].name + ' wins trick! (+' + trickPts + ' pts)');
    addLog('trick', '🏆 ' + G.players[wp].name + ' wins trick (+' + trickPts + ' pts)');
    updateUI();
    setTimeout(() => {
      G.trick = [];
      G.trickSuit = '';
      if (area) area.innerHTML = '';
      if (!G.hands[0].length) endRound();
      else playTurn();
    }, 1800);
  } catch (e) { dbg('RESOLVE ERROR: ' + e.message); }
}

function endRound() {
  try {
    G.phase = 'end';
    let teamAPts = G.trickPoints[0] + G.trickPoints[2];
    let teamBPts = G.trickPoints[1] + G.trickPoints[3];
    let teamATricks = G.tricks[0] + G.tricks[2];
    let teamBTricks = G.tricks[1] + G.tricks[3];
    let bidTeam = G.bidder % 2;
    let madeIt = bidTeam === 0 ? teamAPts >= G.bid : teamBPts >= G.bid;
    let winPts = 1, losePts = 2;
    if (G.bid >= 20 && G.bid <= 24) { winPts = 2; losePts = 3; }
    else if (G.bid >= 25) { winPts = 3; losePts = 4; }
    let winTeam = madeIt ? bidTeam : (1 - bidTeam);
    let ptsChange = madeIt ? winPts : losePts;
    G.matchScore[winTeam] = Math.min(MATCH_WIN, G.matchScore[winTeam] + ptsChange);
    G.matchScore[1 - winTeam] = Math.max(0, G.matchScore[1 - winTeam] - ptsChange);
    let title = madeIt ? '🎉 Team ' + (winTeam === 0 ? 'A' : 'B') + ' Wins!' : '🛡️ Team ' + (winTeam === 0 ? 'A' : 'B') + ' Defends!';
    let detail = 'Bid: ' + G.bid + ' by ' + G.players[G.bidder].name + '<br>Team A: ' + teamAPts + ' pts (' + teamATricks + ' tricks)<br>Team B: ' + teamBPts + ' pts (' + teamBTricks + ' tricks)<br>Points: ' + (madeIt ? '+' : '-') + ptsChange + '<br><br>Match: A=' + G.matchScore[0] + ' | B=' + G.matchScore[1];
    if (G.matchScore[0] >= MATCH_WIN || G.matchScore[1] >= MATCH_WIN) detail += '<br><br>🏆 MATCH WINNER: Team ' + (G.matchScore[0] >= MATCH_WIN ? 'A' : 'B') + '!';
    let reTitle = document.getElementById('reTitle');
    if (reTitle) reTitle.textContent = title;
    let reDetail = document.getElementById('reDetail');
    if (reDetail) reDetail.innerHTML = detail;
    let roundEnd = document.getElementById('roundEnd');
    if (roundEnd) roundEnd.classList.add('show');
    addLog('system', 'Round ' + G.round + ' over. ' + (madeIt ? 'Bidder team made ' + G.bid : 'Bidder team failed ' + G.bid) + '. Match: A=' + G.matchScore[0] + ' B=' + G.matchScore[1]);
    updateUI();
  } catch (e) { dbg('ENDROUND ERROR: ' + e.message); }
}

function nextRound() {
  let roundEnd = document.getElementById('roundEnd');
  if (roundEnd) roundEnd.classList.remove('show');
  if (G.matchScore[0] >= MATCH_WIN || G.matchScore[1] >= MATCH_WIN) {
    G.round = 1;
    G.dealer = 0;
    G.matchScore = [MATCH_START, MATCH_START];
    let overlay = document.getElementById('startOverlay');
    if (overlay) overlay.style.display = 'flex';
    document.body.classList.remove('game-active');
    let p4 = document.getElementById('page4');
    if (p4) p4.classList.remove('active');
    showPage('page1');
    return;
  }
  G.round++;
  G.dealer = (G.dealer + 1) % 4;
  newRound();
}

function updateUI() {
  try {
    let stDealer = document.getElementById('stDealer');
    if (stDealer) stDealer.textContent = G.players[G.dealer] ? G.players[G.dealer].name : '-';
    let stBidder = document.getElementById('stBidder');
    if (stBidder) stBidder.textContent = G.bidder >= 0 ? G.players[G.bidder].name + '(' + G.bid + ')' : '-';
    let stCurrent = document.getElementById('stCurrent');
    if (stCurrent) {
      if (G.phase === 'bid1' || G.phase === 'bid2' || G.phase === 'trump') {
        stCurrent.textContent = G.bidder >= 0 ? G.players[G.bidder].name + ' (' + G.bid + ')' : '-';
      } else {
        stCurrent.textContent = G.players[G.turn] ? G.players[G.turn].name : '-';
      }
    }
    let stPhase = document.getElementById('stPhase');
    if (stPhase) stPhase.textContent = G.phase === 'bid1' ? 'Bid 1' : G.phase === 'trump' ? 'Trump' : G.phase === 'bid2' ? 'Bid 2' : G.phase === 'play' ? 'Play' : 'End';
    let scoreA = document.getElementById('scoreA');
    if (scoreA) scoreA.textContent = G.matchScore[0];
    let scoreB = document.getElementById('scoreB');
    if (scoreB) scoreB.textContent = G.matchScore[1];
    let teamAPlayers = document.getElementById('teamAPlayers');
    if (teamAPlayers) teamAPlayers.textContent = (G.players[0] ? G.players[0].name : '') + ' & ' + (G.players[2] ? G.players[2].name : '');
    let teamBPlayers = document.getElementById('teamBPlayers');
    if (teamBPlayers) teamBPlayers.textContent = (G.players[1] ? G.players[1].name : '') + ' & ' + (G.players[3] ? G.players[3].name : '');
    let ptsA = document.getElementById('ptsA');
    if (ptsA) ptsA.textContent = G.trickPoints[0] + G.trickPoints[2];
    let ptsB = document.getElementById('ptsB');
    if (ptsB) ptsB.textContent = G.trickPoints[1] + G.trickPoints[3];
    let tricksA = document.getElementById('tricksA');
    if (tricksA) tricksA.textContent = G.tricks[0] + G.tricks[2];
    let tricksB = document.getElementById('tricksB');
    if (tricksB) tricksB.textContent = G.tricks[1] + G.tricks[3];
    let trumpShow = document.getElementById('trumpShow');
    if (trumpShow) trumpShow.textContent = G.trumpRevealed ? G.trump : (G.trump ? '?' : '-');
    for (let i = 0; i < 4; i++) {
      let pos = (i - G.mySeat + 4) % 4;
      let nEl = document.getElementById('n' + pos);
      if (nEl) nEl.textContent = G.players[i] ? G.players[i].name : '';
      let cEl = document.getElementById('c' + pos);
      if (cEl) cEl.textContent = (G.hands[i] ? G.hands[i].length : 0) + ' cards';
      let pEl = document.getElementById('pos' + pos);
      if (pEl) pEl.classList.toggle('pos-active', G.turn === i);
    }
    let pa = document.getElementById('playArea');
    if (pa) pa.innerHTML = '';
    G.trick.forEach(t => {
      let d = document.createElement('div');
      let pos = (t.player - G.mySeat + 4) % 4;
      let posClass = pos === 0 ? 'pos-bottom' : pos === 1 ? 'pos-left' : pos === 2 ? 'pos-top' : 'pos-right';
      d.className = 'played-card-pos ' + (isRed(t.card.suit) ? 'red' : 'black') + ' ' + posClass;
      d.innerHTML = '<div style="font-size:1.3rem">' + t.card.suit + '</div><div style="font-size:1rem">' + t.card.rank + '</div>';
      if (pa) pa.appendChild(d);
    });
    let hd = document.getElementById('hand');
    if (hd) hd.innerHTML = '';
    let myHand = G.hands[G.mySeat] || [];
    myHand.forEach((c, i) => {
      let d = document.createElement('div');
      d.className = 'card ' + (isRed(c.suit) ? 'red' : 'black');
      d.innerHTML = '<div class="rank">' + c.rank + '</div><div class="suit">' + c.suit + '</div>';
      if (hd) hd.appendChild(d);
    });
  } catch (e) { dbg('UI ERROR: ' + e.message); }
}

function showMsg(m) {
  let el = document.getElementById('msg');
  if (el) el.textContent = m;
}

// ===== PASS & PLAY MODE =====
let passPlayPlayers = ['Player 1', 'Player 2', 'Player 3', 'Player 4'];

function renderPassPlayPicker() {
  try {
    let container = document.getElementById('passPlaySetup');
    if (!container) return;
    container.innerHTML = '';
    for (let i = 0; i < 4; i++) {
      let div = document.createElement('div');
      div.style.margin = '8px 0';
      div.innerHTML = '<div style="color:#ffaa00; font-size:0.85rem; margin-bottom:4px;">Player ' + (i + 1) + ' Name:</div>' +
        '<input type="text" class="name-input" id="passName' + i + '" placeholder="Name" maxlength="12" value="' + passPlayPlayers[i] + '" style="margin-bottom:0;">';
      container.appendChild(div);
    }
  } catch (e) { dbg('PASSPLAY RENDER ERROR: ' + e.message); }
}

function startPassPlay() {
  try {
    let names = [];
    for (let i = 0; i < 4; i++) {
      let name = document.getElementById('passName' + i).value.trim() || 'Player ' + (i + 1);
      names.push(name);
    }
    G.mode = 'passplay';
    G.players = [
      { name: names[0], type: 'human', team: 0 },
      { name: names[1], type: 'human', team: 1 },
      { name: names[2], type: 'human', team: 0 },
      { name: names[3], type: 'human', team: 1 }
    ];
    G.mySeat = 0;
    G.matchScore = [MATCH_START, MATCH_START];
    G.round = 1;
    G.dealer = Math.floor(Math.random() * 4);
    document.body.classList.add('game-active');
    document.getElementById('page4').classList.add('active');
    showPage('page4');
    let overlay = document.getElementById('startOverlay');
    if (overlay) overlay.style.display = 'none';
    newRound();
  } catch (e) { dbg('PASSPLAY START ERROR: ' + e.message); }
}
