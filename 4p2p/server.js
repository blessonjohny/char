const express = require('express');
const { ExpressPeerServer } = require('peer');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 9000;

// Serve the game HTML from the "public" folder
app.use(express.static(path.join(__dirname, 'public')));

// Health check
app.get('/status', (req, res) => {
  res.send('28 Kerala Gulan — PeerJS Server running ✅');
});

// Start HTTP server
const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Attach PeerJS
const peerServer = ExpressPeerServer(server, {
  debug: true,
  allow_discovery: false,
});

app.use('/peerjs', peerServer);

peerServer.on('connection', (client) => {
  console.log(`[PeerJS] Connected: ${client.getId()}`);
});
peerServer.on('disconnect', (client) => {
  console.log(`[PeerJS] Disconnected: ${client.getId()}`);
});
