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
    // Free, shared community TURN relay (Open Relay Project) — no signup.
    // Needed whenever a direct connection can't be made — most commonly
    // when someone is on mobile data, since carriers almost always sit
    // everyone behind carrier-grade NAT that blocks direct peer audio
    // even though the two devices can still "find" each other via STUN.
    // Being a shared public relay it can occasionally be slow/rate-limited;
    // if voice still misbehaves for someone, swap these 3 lines for a free
    // personal Metered.ca account (2-minute signup, 20GB/month free,
    // dedicated to just this game): https://www.metered.ca/tools/openrelay/
    { urls: 'stun:openrelay.metered.ca:80' },
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
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

  const blockedAudio = new Set();
  function attemptPlay(audio) {
    const p = audio.play();
    if (p && p.catch) {
      p.then(() => {
        blockedAudio.delete(audio);
        updateSoundBanner();
      }).catch((err) => {
        blockedAudio.add(audio);
        updateSoundBanner();
        console.warn('[voice] autoplay blocked, waiting for a tap to enable sound:', err.message);
      });
    }
  }
  function retryBlockedAudio() {
    for (const audio of Array.from(blockedAudio)) attemptPlay(audio);
  }
  function updateSoundBanner() {
    if (!ui) return;
    ui.soundBanner.style.display = blockedAudio.size > 0 ? 'block' : 'none';
  }

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
      #k28vActiveLight{position:absolute;top:-2px;right:-2px;width:12px;height:12px;border-radius:50%;
        background:#3ddc84;border:2px solid #0a1628;display:none;animation:k28vBlink 1.3s ease-in-out infinite}
      #k28vBtn.has-active-light #k28vActiveLight{display:block}
      @keyframes k28vBlink{0%,100%{opacity:1;box-shadow:0 0 6px #3ddc84}50%{opacity:0.35;box-shadow:0 0 2px #3ddc84}}
      #k28vPanel{position:fixed;left:10px;top:106px;width:118px;max-height:150px;overflow-y:auto;
        background:rgba(15,25,40,0.55);backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);
        border:1px solid rgba(255,255,255,0.12);border-radius:10px;
        padding:6px;z-index:150;display:none;font-family:inherit}
      #k28vPanel.on{display:block}
      #k28vPanel h4{margin:0 0 4px;font-size:0.56rem;color:#f4c430;letter-spacing:0.3px;text-transform:uppercase}
      .k28v-row{display:flex;align-items:center;gap:5px;padding:2px 1px;font-size:0.66rem;color:#dfe8f5}
      .k28v-dot{width:6px;height:6px;border-radius:50%;background:#555;flex-shrink:0;transition:background 0.15s,box-shadow 0.15s}
      .k28v-dot.on{background:#3ddc84;box-shadow:0 0 5px #3ddc84}
      .k28v-empty{font-size:0.62rem;color:#8a98ac;padding:2px 1px}
      #k28vSoundBanner{position:fixed;left:64px;right:10px;top:60px;z-index:160;display:none;
        background:linear-gradient(135deg,#e6a817,#f4c430);color:#0a1628;font-weight:800;font-size:0.8rem;
        border-radius:10px;padding:10px 14px;text-align:center;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,0.4)}
    `;
    document.head.appendChild(style);

    const btn = document.createElement('button');
    btn.id = 'k28vBtn';
    btn.title = 'Voice chat';
    btn.textContent = '🎙️';
    const activeLight = document.createElement('span');
    activeLight.id = 'k28vActiveLight';
    btn.appendChild(activeLight);
    document.body.appendChild(btn);

    const panel = document.createElement('div');
    panel.id = 'k28vPanel';
    panel.innerHTML = '<h4>🔊 On voice</h4><div id="k28vList"></div>';
    document.body.appendChild(panel);

    const soundBanner = document.createElement('div');
    soundBanner.id = 'k28vSoundBanner';
    soundBanner.textContent = '🔇 Tap here to enable voice sound';
    soundBanner.addEventListener('click', retryBlockedAudio);
    document.body.appendChild(soundBanner);

    btn.addEventListener('click', async () => {
      retryBlockedAudio(); // a real tap — good moment to also unstick any blocked playback
      if (!inCall) {
        const ok = await join();
        if (ok) { btn.classList.add('live'); panel.classList.add('on'); renderList(); }
      } else {
        leave();
        btn.classList.remove('live', 'speaking');
        panel.classList.remove('on');
      }
    });

    ui = { btn, panel, list: panel.querySelector('#k28vList'), soundBanner };
    return ui;
  }

  // Deliberately the ONLY thing a non-participant ever learns about voice
  // activity: that at least one person is currently in the call. No
  // names, no speaking status, no count — just a generic "someone's on"
  // signal, same spirit as the rest of this file's privacy stance. Shown
  // whenever there's anyone in the call besides (or including) yourself;
  // once you've joined, your own button already shows the red "live"
  // pulse, so this light only really matters for people who haven't.
  function updateActiveLight() {
    if (!ui) return;
    const someoneActive = inCall || names.size > 0;
    ui.btn.classList.toggle('has-active-light', someoneActive);
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
        audio.volume = 1;
        audio.muted = false;
        audio.style.display = 'none';
        document.body.appendChild(audio);
        audioEls.set(id, audio);
      }
      audio.srcObject = e.streams[0];
      // Browsers can silently refuse to actually play an <audio> element
      // even though the track is arriving fine — the level meter below
      // reads straight off the incoming stream, so it lights up whether
      // or not this succeeds, which is exactly why voice can look
      // "connected" while staying silent. If play() is blocked, surface
      // an explicit "tap to enable sound" prompt (a real tap always
      // satisfies the browser's autoplay gesture requirement).
      attemptPlay(audio);
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
    if (audio) { blockedAudio.delete(audio); audio.remove(); audioEls.delete(id); }
    analysers.delete(id);
    names.delete(id);
    renderList();
    updateSoundBanner();
    updateActiveLight();
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
    updateActiveLight();
    return true;
  }

  function leave() {
    if (!inCall) return;
    inCall = false;
    if (socket) socket.emit('voiceLeave');
    for (const id of Array.from(peers.keys())) removePeer(id);
    if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
    analysers.delete('me');
    blockedAudio.clear();
    updateSoundBanner();
    updateActiveLight();
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
    if (ui.soundBanner) ui.soundBanner.style.top = top + 'px';
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
    socket.on('voicePeers', (list) => { list.forEach(p => { names.set(p.id, p.name); makePeer(p.id, true); }); renderList(); updateActiveLight(); });
    socket.on('voicePeerJoined', (p) => { names.set(p.id, p.name); renderList(); updateActiveLight(); });
    socket.on('voicePeerLeft', ({ id }) => removePeer(id));
    socket.on('voiceSignal', ({ from, signal }) => handleSignal(from, signal));
    document.addEventListener('click', retryBlockedAudio, { passive: true });
  }

  window.K28Voice = { attach, showButton, hideButton, join, leave, get inCall() { return inCall; } };
})();
