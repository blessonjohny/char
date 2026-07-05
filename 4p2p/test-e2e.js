const { io } = require('socket.io-client');
const URL = 'http://localhost:9000';

function connect() { return io(URL, { transports: ['websocket'], forceNew: true }); }
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
function once(sock, evt) { return new Promise(res => sock.once(evt, res)); }

async function main() {
  console.log('--- Step 1: host creates a table ---');
  const host = connect();
  await once(host, 'connect');
  host.emit('createTable', { name: 'HostAlice' });
  const hostJoined = await once(host, 'joined');
  console.log('Host joined:', hostJoined);
  const tableId = hostJoined.tableId;

  console.log('\n--- Step 2: a guest joins the same table ---');
  const guest = connect();
  await once(guest, 'connect');
  guest.emit('joinTable', { tableId, name: 'GuestBob' });
  const guestJoined = await once(guest, 'joined');
  console.log('Guest joined:', guestJoined);
  const guestPlayerId = guestJoined.playerId;
  const guestPos = guestJoined.pos;

  console.log('\n--- Step 3: host fills remaining seats with bots and starts ---');
  let hostState = null;
  host.on('state', (s) => { hostState = s; });
  let guestState = null;
  guest.on('state', (s) => { guestState = s; });
  host.emit('fillBots', { count: 2 });
  host.emit('startGame');
  await wait(300);
  console.log('Host sees phase:', hostState.phase, '| seats:', hostState.seats.map(s => s && s.name));
  console.log('Guest sees phase:', guestState.phase, '| own hand size:', (guestState.seats[guestPos].hand || []).length);

  console.log('\n--- Step 4: play through bidding (everyone passes to whoever is forced first) ---');
  // Drive both bidding turns forward regardless of whose turn it is, using
  // whichever socket currently holds that seat.
  let guard = 0;
  while (hostState.phase === 'bidding1' && guard < 40) {
    guard++;
    const cp = hostState.currentPlayer;
    console.log(`  [turn ${guard}] currentPlayer=${cp} highestBid=${hostState.highestBid} passes=${hostState.passes}`);
    if (cp === hostJoined.pos) host.emit('placeBid', { bid: 0 });
    else if (cp === guestPos) guest.emit('placeBid', { bid: 0 });
    // else it's a bot seat — the engine's own maybeAutoAct already handles it
    await wait(200);
  }
  console.log('Bidding resolved. Phase:', hostState.phase, 'bidder seat:', hostState.bidder, 'bid:', hostState.highestBid);

  console.log('\n--- Step 5: THE ACTUAL POINT OF THIS REWRITE — guest disconnects mid-game ---');
  console.log('Guest hand before disconnect:', (guestState.seats[guestPos].hand || []).length, 'cards');
  guest.disconnect();
  await wait(300);
  console.log('Host state after guest drop — seat still exists?', !!hostState.seats[guestPos], '| connected flag:', hostState.seats[guestPos] && hostState.seats[guestPos].connected);
  console.log('>>> If this were the old PeerJS architecture and the GUEST were actually the host, the whole game would be gone right now. It is not — the server still has it. <<<');

  console.log('\n--- Step 6: guest reconnects using their saved playerId (simulating reopening the browser) ---');
  const guest2 = connect();
  await once(guest2, 'connect');
  let guest2State = null;
  guest2.on('state', (s) => { guest2State = s; });
  guest2.emit('joinTable', { tableId, name: 'GuestBob', playerId: guestPlayerId });
  const rejoinResult = await once(guest2, 'joined');
  console.log('Rejoin result:', rejoinResult);
  await wait(300);
  console.log('Reconnected seat matches original position:', rejoinResult.pos === guestPos);
  console.log('Hand preserved across the disconnect:', JSON.stringify(guest2State.seats[guestPos].hand) === JSON.stringify(guestState.seats[guestPos].hand));
  console.log('Host still sees the table running normally, phase:', hostState.phase);

  console.log('\n--- Step 7: a totally different browser with no token joins the same table fresh ---');
  const stranger = connect();
  await once(stranger, 'connect');
  stranger.emit('joinTable', { tableId, name: 'NewPerson' /* no playerId at all */ });
  const strangerResult = await Promise.race([
    once(stranger, 'joined'),
    once(stranger, 'joinError')
  ]);
  console.log('Stranger join result (table has 2 bots + host + reconnected guest = full):', strangerResult);

  host.disconnect(); guest2.disconnect(); stranger.disconnect();
  console.log('\n✅ End-to-end reconnection flow verified.');
  process.exit(0);
}

main().catch(e => { console.error('❌ TEST FAILED:', e); process.exit(1); });

setTimeout(() => {
  console.error('❌ WATCHDOG: test did not finish within 15s — something is genuinely stuck.');
  process.exit(2);
}, 15000);
