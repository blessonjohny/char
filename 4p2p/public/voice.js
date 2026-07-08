// ============================================================
// 28 KERALA GULAN — GROUP VOICE CHAT (WebRTC mesh)
// ============================================================
// Open mic, table-wide: tap the mic button, allow the browser's
// microphone permission prompt, and everyone else at the table who has
// also joined voice can hear you live — same as everyone hearing you at
// a real table. Works for both the 4-player and 6-player tables.
//
// How it works: this device opens a direct audio connection to every
// other device at the table ("mesh"). The Socket.IO connection the game
// already uses is reused just to say "here's my connection info" to the
// others (a few hundred bytes of text) — the actual voice audio then
// flows straight between browsers, never through the game server. That's
// why it's free: no server relay, no per-minute cost, just the two free
// Google STUN servers below to help browsers find each other across
// different networks.
//
// One caveat: a small number of restrictive networks (some corporate
// wifi, some mobile carriers) block direct peer connections outright. On
// those, voice can fail to connect for just that one player even though
// everyone else is fine. The fix is a free TURN relay account — see the
// TURN_SERVERS note below. Not required to ship this; only add it if
// someone reports voice not connecting for them specifically.
// ============================================================
(function () {
  const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    // Optional free TURN relay for players on restrictive networks.
    // Free options: https://www.metered.ca/tools/openrelay/ (community,
    // no signup) or a free Metered.ca account (bigger free quota). Paste
    // the credentials they give you here, e.g.:
    // { urls: 'turn:standard.relay.metered.ca:80', username: '...', credential: '...' },
  ];

  let socket = null;
  let localStream = null;
  let inCall = false;
  let getName = () => 'Player';
  const peers = new Map();       // socketId -> RTCPeerConnection
  const audioEls = new Map();    // socketId -> <audio>
  const names = new Map();       // socketId -> display name
  const analysers = new Map();   // socketId -> {analyser, data}
  let audioCtx = null;
  let micAnalyser = null;

  // ---------------- UI ----------------
  let ui = null;
  function buildUI() {
    if (ui) return ui;
    const style = document.createElement('style');
    style.textContent = `
      #k28vBtn{position:fixed;left:10px;top:60px;width:44px;height:44px;border-radius:50%;
        background:linear-gradient(135deg,#2a3f5f,#1a2942);border:2px solid rgba(255,255,255,0.15);
        color:#fff;font-size:1.15rem;display:none;align-items:center;justify-content:center;
        z-index:150;box-shadow:0 4px 14px rgba(0,0,0,0.4);cursor:pointer;transition:transform 0.15s}
      #k28vBtn:active{transform:scale(0.92)}
      #k28vBtn.live{background:linear-gradient(135deg,#e74040,#c93030);animation:k28vPulse 1.8s ease-in-out infinite}
      #k28vBtn.speaking{box-shadow:0 0 0 4px rgba(61,220,132,0.55),0 4px 14px rgba(0,0,0,0.4)}
      @keyframes k28vPulse{0%,100%{box-shadow:0 4px 14px rgba(231,64,64,0.5)}50%{box-shadow:0 4px 22px rgba(231,64,64,0.9)}}
      #k28vPanel{position:fixed;left:10px;top:110px;width:170px;max-height:220px;overflow-y:auto;
        background:rgba(15,25,40,0.97);border:1px solid rgba(255,255,255,0.15);border-radius:12px;
        padding:8px;z-index:150;display:none;font-family:inherit}
      #k28vPanel.on{display:block}
      #k28vPanel h4{margin:0 0 6px;font-size:0.65rem;color:#f4c430;letter-spacing:0.5px;text-transform:uppercase}
      .k28v-row{display:flex;align-items:center;gap:6px;padding:4px 2px;font-size:0.78rem;color:#dfe8f5}
      .k28v-dot{width:8px;height:8px;border-radius:50%;background:#555;flex-shrink:0;transition:background 0.15s,box-shadow 0.15s}
      .k28v-dot.on{background:#3ddc84;box-shadow:0 0 6px #3ddc84}
      .k28v-empty{font-size:0.72rem;color:#8a98ac;padding:4px 2px}
    `;
    document.head.appendChild(style);

    const btn = document.createElement('button');
    btn.id = 'k28vBtn';
    btn.title = 'Voice chat';
    btn.textContent = '🎙️';
    document.body.appendChild(btn);

    const panel = document.createElement('div');
    panel.id = 'k28vPanel';
    panel.innerHTML = '<h4>🔊 On voice</h4><div id="k28vList"></div>';
    document.body.appendChild(panel);

    btn.addEventListener('click', async () => {
      if (!inCall) {
        const ok = await join();
        if (ok) { btn.classList.add('live'); panel.classList.add('on'); renderList(); }
      } else {
        leave();
        btn.classList.remove('live', 'speaking');
        panel.classList.remove('on');
      }
    });

    ui = { btn, panel, list: panel.querySelector('#k28vList') };
    return ui;
  }

  function renderList() {
    if (!ui) return;
    const rows = [];
    rows.push(`<div class="k28v-row"><span class="k28v-dot on" id="k28vMeDot"></span><span>${escapeHtml(getName())} (you)</span></div>`);
    for (const [id, name] of names) {
      rows.push(`<div class="k28v-row"><span class="k28v-dot" id="k28vDot-${id}"></span><span>${escapeHtml(name)}</span></div>`);
    }
    ui.list.innerHTML = rows.length ? rows.join('') : '<div class="k28v-empty">Just you so far</div>';
  }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function setDotSpeaking(id, on) {
    const dot = document.getElementById(id === 'me' ? 'k28vMeDot' : ('k28vDot-' + id));
    if (dot) dot.classList.toggle('on', on);
    if (id === 'me' && ui) ui.btn.classList.toggle('speaking', on);
  }

  // ---------------- Mic capture ----------------
  async function ensureMic() {
    if (localStream) return localStream;
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    watchLevel('me', localStream);
    return localStream;
  }

  function watchLevel(id, stream) {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const src = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    analysers.set(id, true);
    let speaking = false;
    const tick = () => {
      if (!analysers.has(id)) return;
      analyser.getByteFrequencyData(data);
      const avg = data.reduce((a, b) => a + b, 0) / data.length;
      const now = avg > 16;
      if (now !== speaking) { speaking = now; setDotSpeaking(id, now); }
      requestAnimationFrame(tick);
    };
    tick();
  }

  // ---------------- Peer connections ----------------
  function makePeer(id, isInitiator) {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    peers.set(id, pc);
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

    pc.onicecandidate = (e) => {
      if (e.candidate) socket.emit('voiceSignal', { to: id, signal: { candidate: e.candidate } });
    };
    pc.ontrack = (e) => {
      let audio = audioEls.get(id);
      if (!audio) {
        audio = document.createElement('audio');
        audio.autoplay = true;
        audio.playsInline = true;
        audio.style.display = 'none';
        document.body.appendChild(audio);
        audioEls.set(id, audio);
      }
      audio.srcObject = e.streams[0];
      watchLevel(id, e.streams[0]);
    };
    pc.onconnectionstatechange = () => {
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) removePeer(id);
    };
    if (isInitiator) {
      pc.onnegotiationneeded = async () => {
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          socket.emit('voiceSignal', { to: id, signal: { sdp: pc.localDescription } });
        } catch (e) { console.warn('[voice] negotiation error', e); }
      };
    }
    return pc;
  }

  function removePeer(id) {
    const pc = peers.get(id);
    if (pc) { pc.close(); peers.delete(id); }
    const audio = audioEls.get(id);
    if (audio) { audio.remove(); audioEls.delete(id); }
    analysers.delete(id);
    names.delete(id);
    renderList();
  }

  async function handleSignal(from, signal) {
    let pc = peers.get(from);
    if (!pc) pc = makePeer(from, false);
    if (signal.sdp) {
      await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
      if (signal.sdp.type === 'offer') {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('voiceSignal', { to: from, signal: { sdp: pc.localDescription } });
      }
    } else if (signal.candidate) {
      try { await pc.addIceCandidate(new RTCIceCandidate(signal.candidate)); } catch (e) {}
    }
  }

  // ---------------- Public API ----------------
  async function join() {
    if (inCall) return true;
    try {
      await ensureMic();
    } catch (e) {
      alert('Voice chat needs microphone access. Please allow it in your browser, then tap the mic button again.');
      return false;
    }
    inCall = true;
    socket.emit('voiceJoin', { name: getName() });
    return true;
  }

  function leave() {
    if (!inCall) return;
    inCall = false;
    if (socket) socket.emit('voiceLeave');
    for (const id of Array.from(peers.keys())) removePeer(id);
    if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
    analysers.delete('me');
  }

  function positionTopLeft() {
    if (!ui) return;
    const topbar = document.getElementById('topBar') || document.querySelector('.topbar');
    let top = 60;
    if (topbar) {
      const rect = topbar.getBoundingClientRect();
      if (rect.height > 0 && getComputedStyle(topbar).display !== 'none') top = rect.bottom + 8;
    }
    ui.btn.style.top = top + 'px';
    ui.panel.style.top = (top + 58) + 'px';
  }
  window.addEventListener('resize', positionTopLeft);

  function showButton() { buildUI().btn.style.display = 'flex'; positionTopLeft(); setTimeout(positionTopLeft, 300); }
  function hideButton() {
    leave();
    if (ui) { ui.btn.style.display = 'none'; ui.panel.classList.remove('on'); ui.btn.classList.remove('live', 'speaking'); }
  }

  let attached = false;
  function attach(sock, opts) {
    socket = sock;
    if (opts && opts.getName) getName = opts.getName;
    buildUI();
    if (attached) return;
    attached = true;
    socket.on('voicePeers', (list) => { list.forEach(p => { names.set(p.id, p.name); makePeer(p.id, true); }); renderList(); });
    socket.on('voicePeerJoined', (p) => { names.set(p.id, p.name); renderList(); });
    socket.on('voicePeerLeft', ({ id }) => removePeer(id));
    socket.on('voiceSignal', ({ from, signal }) => handleSignal(from, signal));
  }

  window.K28Voice = { attach, showButton, hideButton, join, leave, get inCall() { return inCall; } };
})();
