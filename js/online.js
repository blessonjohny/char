// ===== FIREBASE CONFIG =====
// Replace these with your own Firebase project credentials
// Get them from: https://console.firebase.google.com/ → Project Settings → General → Your apps → SDK setup and configuration
const FIREBASE_CONFIG = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  databaseURL: "https://YOUR_PROJECT_ID-default-rtdb.firebaseio.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID"
};

let firebaseApp = null;
let firebaseDB = null;
let online = { tables: [], myTable: null, mySeat: 0, playerName: '', tableRef: null, syncInterval: null };
let isFirebaseReady = false;

// ===== INITIALIZE FIREBASE =====
function initFirebase() {
  try {
    if (typeof firebase === 'undefined') {
      console.log('Firebase SDK not loaded yet, retrying...');
      setTimeout(initFirebase, 500);
      return;
    }

    // Check if config is still default
    if (FIREBASE_CONFIG.apiKey === 'YOUR_API_KEY') {
      updateFirebaseStatus('disconnected', '⚠️ Please set up Firebase config in js/online.js');
      return;
    }

    firebaseApp = firebase.initializeApp(FIREBASE_CONFIG);
    firebaseDB = firebase.database();
    isFirebaseReady = true;
    updateFirebaseStatus('connected', '🟢 Online - Connected to server');

    // Start listening for tables
    listenForTables();
  } catch(e) {
    console.error('Firebase init error:', e);
    updateFirebaseStatus('disconnected', '🔴 Connection failed');
  }
}

function updateFirebaseStatus(status, text) {
  let el = document.getElementById('firebaseStatus');
  if (el) {
    el.className = 'firebase-status ' + status;
    el.textContent = text;
  }
}

// ===== TABLE SYNC =====
function listenForTables() {
  if (!firebaseDB) return;

  let tablesRef = firebaseDB.ref('tables');
  tablesRef.on('value', (snapshot) => {
    let data = snapshot.val();
    online.tables = data ? Object.values(data) : [];
    // Filter out tables older than 2 hours
    let cutoff = Date.now() - (2 * 60 * 60 * 1000);
    online.tables = online.tables.filter(t => t.createdAt > cutoff);
    renderLobby();
  });
}

function createTableOnline() {
  try {
    if (!isFirebaseReady) {
      alert('Not connected to server. Please check Firebase config.');
      return;
    }

    let name = document.getElementById('lobbyName').value.trim() || 'Player';
    online.playerName = name;

    let tableId = 'table_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    let tableData = {
      id: tableId,
      name: 'Table #' + (online.tables.length + 1),
      createdAt: Date.now(),
      host: name,
      seats: [name, null, null, null],
      types: ['human', null, null, null],
      status: 'waiting', // waiting, playing, ended
      gameState: null,
      lastUpdate: Date.now()
    };

    firebaseDB.ref('tables/' + tableId).set(tableData);
    online.myTable = tableData;
    online.mySeat = 0;
    online.tableRef = firebaseDB.ref('tables/' + tableId);

    // Listen for changes to this table
    online.tableRef.on('value', (snapshot) => {
      let data = snapshot.val();
      if (data) {
        online.myTable = data;
        renderTable();

        // If game started and we're in it
        if (data.status === 'playing' && data.gameState) {
          syncGameState(data.gameState);
        }
      }
    });

    showPage('page3');
  } catch(e) {
    dbg('CREATE TABLE ERROR: ' + e.message);
  }
}

function joinTableOnline(tableId) {
  try {
    if (!isFirebaseReady) {
      alert('Not connected to server.');
      return;
    }

    let name = document.getElementById('lobbyName').value.trim() || 'Player';
    online.playerName = name;

    let tableRef = firebaseDB.ref('tables/' + tableId);

    tableRef.once('value').then((snapshot) => {
      let table = snapshot.val();
      if (!table) {
        alert('Table not found!');
        return;
      }

      // Find first empty seat
      let joined = false;
      for (let i = 0; i < 4; i++) {
        if (!table.seats[i]) {
          table.seats[i] = name;
          table.types[i] = 'human';
          online.mySeat = i;
          joined = true;
          break;
        }
      }

      if (!joined) {
        alert('Table is full!');
        return;
      }

      table.lastUpdate = Date.now();
      tableRef.set(table);

      online.myTable = table;
      online.tableRef = tableRef;

      // Listen for changes
      online.tableRef.on('value', (snapshot) => {
        let data = snapshot.val();
        if (data) {
          online.myTable = data;
          renderTable();

          if (data.status === 'playing' && data.gameState) {
            syncGameState(data.gameState);
          }
        }
      });

      showPage('page3');
    });
  } catch(e) {
    dbg('JOIN ERROR: ' + e.message);
  }
}

function addBotOnline(seatIndex) {
  try {
    if (!online.myTable || !online.tableRef) return;

    let botName = BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)] + ' ' + (seatIndex + 1);

    // Make sure bot name doesn't conflict with existing players
    let existingNames = online.myTable.seats.filter(s => s);
    while (existingNames.includes(botName)) {
      botName = BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)] + ' ' + Math.floor(Math.random() * 99);
    }

    online.myTable.seats[seatIndex] = botName;
    online.myTable.types[seatIndex] = 'bot';
    online.myTable.lastUpdate = Date.now();

    online.tableRef.set(online.myTable);
  } catch(e) {
    dbg('ADD BOT ERROR: ' + e.message);
  }
}

function startOnlineGame() {
  try {
    if (!online.myTable || !online.tableRef) return;

    let filled = online.myTable.seats.filter(x => x).length;
    if (filled < 4) {
      alert('Need 4 players! Add bots to fill empty seats.');
      return;
    }

    // Initialize game state
    online.myTable.status = 'playing';
    online.myTable.lastUpdate = Date.now();

    // Set up players in G
    G.mode = 'online';
    G.players = online.myTable.seats.map((n, i) => ({
      name: n,
      type: online.myTable.types[i],
      team: i % 2
    }));
    G.mySeat = online.mySeat;
    G.matchScore = [MATCH_START, MATCH_START];
    G.round = 1;
    G.dealer = Math.floor(Math.random() * 4);

    online.myTable.gameState = {
      mode: 'online',
      players: G.players,
      matchScore: G.matchScore,
      round: G.round,
      dealer: G.dealer,
      phase: 'deal1'
    };

    online.tableRef.set(online.myTable);

    // Start local game
    document.body.classList.add('game-active');
    document.getElementById('page4').classList.add('active');
    showPage('page4');
    let overlay = document.getElementById('startOverlay');
    if (overlay) overlay.style.display = 'none';
    newRound();

    // Start syncing game state
    startGameSync();
  } catch(e) {
    dbg('START ONLINE ERROR: ' + e.message);
  }
}

// ===== GAME STATE SYNC =====
function startGameSync() {
  // Host (seat 0) syncs game state to Firebase
  // Others listen for changes

  if (online.mySeat === 0) {
    // Host: sync every 2 seconds
    online.syncInterval = setInterval(() => {
      if (online.tableRef && G.phase !== 'end') {
        let state = exportGameState();
        online.tableRef.child('gameState').set(state);
      }
    }, 2000);
  } else {
    // Others: listen for game state changes
    online.tableRef.child('gameState').on('value', (snapshot) => {
      let state = snapshot.val();
      if (state) {
        syncGameState(state);
      }
    });
  }
}

function exportGameState() {
  return {
    hands: G.hands,
    tricks: G.tricks,
    trickPoints: G.trickPoints,
    matchScore: G.matchScore,
    dealer: G.dealer,
    bidder: G.bidder,
    bid: G.bid,
    trump: G.trump,
    trumpRevealed: G.trumpRevealed,
    phase: G.phase,
    turn: G.turn,
    trick: G.trick,
    trickSuit: G.trickSuit,
    round: G.round,
    lastUpdate: Date.now()
  };
}

function syncGameState(state) {
  // Only sync if we're not the host (host already has the state)
  if (online.mySeat === 0) return;

  // Update local game state from server
  G.hands = state.hands || G.hands;
  G.tricks = state.tricks || G.tricks;
  G.trickPoints = state.trickPoints || G.trickPoints;
  G.matchScore = state.matchScore || G.matchScore;
  G.dealer = state.dealer !== undefined ? state.dealer : G.dealer;
  G.bidder = state.bidder !== undefined ? state.bidder : G.bidder;
  G.bid = state.bid || G.bid;
  G.trump = state.trump || G.trump;
  G.trumpRevealed = state.trumpRevealed || G.trumpRevealed;
  G.phase = state.phase || G.phase;
  G.turn = state.turn !== undefined ? state.turn : G.turn;
  G.trick = state.trick || G.trick;
  G.trickSuit = state.trickSuit || G.trickSuit;
  G.round = state.round || G.round;

  updateUI();
}

function leaveTable() {
  try {
    if (online.tableRef && online.myTable) {
      // Remove player from seat
      online.myTable.seats[online.mySeat] = null;
      online.myTable.types[online.mySeat] = null;
      online.myTable.lastUpdate = Date.now();

      // If table is empty, delete it
      let remaining = online.myTable.seats.filter(x => x).length;
      if (remaining === 0) {
        online.tableRef.remove();
      } else {
        online.tableRef.set(online.myTable);
      }

      // Stop listening
      online.tableRef.off();
      if (online.syncInterval) {
        clearInterval(online.syncInterval);
        online.syncInterval = null;
      }
    }

    online.myTable = null;
    online.mySeat = 0;
    online.tableRef = null;
    showPage('page2');
  } catch(e) {
    dbg('LEAVE ERROR: ' + e.message);
  }
}

// ===== RENDER FUNCTIONS =====
function renderLobby() {
  try {
    let list = document.getElementById('lobbyTables');
    if (!list) return;

    if (!online.tables.length) {
      list.innerHTML = '<div style="text-align:center;color:#aa8866;padding:15px;">No tables. Create one!</div>';
      return;
    }

    list.innerHTML = online.tables.map(t => {
      let f = t.seats.filter(x => x).length;
      return '<div class="table-item"><div><div style="font-weight:700;color:#ffcc66">' + t.name + '</div><div style="font-size:0.85rem;color:#aa8866">' + f + '/4 • Host: ' + t.host + '</div></div><a href="javascript:void(0)" class="join-link" onclick="joinTableOnline('' + t.id + '')" ' + (f >= 4 ? 'style="background:#664400"' : '') + '>' + (f >= 4 ? 'Full' : 'Join') + '</a></div>';
    }).join('');
  } catch(e) {
    dbg('LOBBY ERROR: ' + e.message);
  }
}

function renderTable() {
  try {
    let t = online.myTable;
    if (!t) return;

    let titleEl = document.getElementById('tableTitle');
    if (titleEl) titleEl.textContent = t.name;

    let g = document.getElementById('seatGrid');
    let filled = 0;
    if (!g) return;

    g.innerHTML = '';
    for (let i = 0; i < 4; i++) {
      let div = document.createElement('div');
      div.className = 'seat-box';
      if (t.seats[i]) {
        div.classList.add(t.types[i] == 'bot' ? 'bot-seat' : 'taken');
        let isMe = (i === online.mySeat) ? ' 👤 YOU' : '';
        div.innerHTML = '<div class="seat-player">' + t.seats[i] + '</div><div class="seat-role">' + (t.types[i] == 'bot' ? '🤖 Bot' : '👤 Player') + isMe + '</div>';
        filled++;
      } else {
        div.innerHTML = '<div style="color:#664400">Empty</div><button class="add-bot" onclick="addBotOnline(' + i + ')">+ Bot</button>';
      }
      g.appendChild(div);
    }

    let btn = document.getElementById('startBtn');
    let wait = document.getElementById('waitText');
    if (wait) wait.textContent = filled == 4 ? 'Ready!' : 'Add bots to fill seats';
    if (btn) {
      btn.textContent = filled == 4 ? '🎮 START GAME!' : 'Start (' + filled + '/4)';
      btn.style.background = filled == 4 ? '#ff6600' : '#664400';
      btn.onclick = filled == 4 ? startOnlineGame : null;
    }
  } catch(e) {
    dbg('RENDER TABLE ERROR: ' + e.message);
  }
}
