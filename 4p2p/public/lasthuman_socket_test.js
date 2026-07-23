const { io } = require('socket.io-client');

function connect() {
  return io('http://localhost:9000', { transports: ['websocket'] });
}

async function testSixPlayer() {
  return new Promise((resolve) => {
    const s = connect();
    let tableId;
    s.on('connect', () => s.emit('sixp_createTable', { name: 'Tester' }));
    s.on('sixp_joined', (info) => {
      tableId = info.tableId;
      s.emit('sixp_fillBots', { count: 5 });
      setTimeout(() => s.emit('sixp_startGame'), 500);
      setTimeout(() => s.emit('sixp_leaveTable'), 1500);
      setTimeout(() => {
        const s2 = connect();
        s2.on('connect', () => s2.emit('sixp_joinTable', { tableId, name: 'Rejoiner' }));
        s2.on('sixp_joined', (info2) => resolve({ game: '6-Player', deleted: false, info: info2 }));
        s2.on('sixp_joinError', (err) => resolve({ game: '6-Player', deleted: true, err }));
        setTimeout(() => resolve({ game: '6-Player', timedOut: true }), 3000);
      }, 2200);
    });
  });
}

async function test56() {
  return new Promise((resolve) => {
    const s = connect();
    let code;
    s.on('connect', () => s.emit('l56_createTable', { name: 'Tester' }));
    s.on('l56_created', (info) => {
      code = info.code;
      setTimeout(() => s.emit('l56_leaveTable', { code }), 500);
      setTimeout(() => {
        const s2 = connect();
        s2.on('connect', () => s2.emit('l56_joinTable', { code, name: 'Rejoiner' }));
        s2.on('l56_joined', (info2) => resolve({ game: '56', deleted: false, info: info2 }));
        s2.on('l56_joinError', (err) => resolve({ game: '56', deleted: true, err }));
        setTimeout(() => resolve({ game: '56', timedOut: true }), 3000);
      }, 1200);
    });
    s.on('l56_createError', (err) => resolve({ game: '56', createFailed: true, err }));
  });
}

async function testPoker() {
  return new Promise((resolve) => {
    const s = connect();
    let tableId;
    s.on('connect', () => s.emit('poker_createTable', { name: 'Tester' }));
    s.on('poker_joined', (info) => {
      tableId = info.tableId;
      setTimeout(() => s.emit('poker_leaveTable'), 500);
      setTimeout(() => {
        const s2 = connect();
        s2.on('connect', () => s2.emit('poker_joinTable', { tableId, name: 'Rejoiner' }));
        s2.on('poker_joined', (info2) => resolve({ game: "Hold'em", deleted: false, info: info2 }));
        s2.on('poker_joinError', (err) => resolve({ game: "Hold'em", deleted: true, err }));
        setTimeout(() => resolve({ game: "Hold'em", timedOut: true }), 3000);
      }, 1200);
    });
  });
}

(async () => {
  console.log(JSON.stringify(await testSixPlayer(), null, 2));
  console.log(JSON.stringify(await test56(), null, 2));
  console.log(JSON.stringify(await testPoker(), null, 2));
  process.exit(0);
})();
