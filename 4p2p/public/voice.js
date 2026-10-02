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
// One caveat: most real-world networks (mobile data, plenty of home/office
// wifi) need a TURN relay to get audio through at all -- STUN alone only
// covers direct peer-to-peer connections, which carrier-grade NAT and many
// routers block outright. TURN_USERNAME/TURN_CREDENTIAL below are this
// game's own DEDICATED Metered.ca account (free tier, 500MB/month, used
// only by this game -- not shared with any other app), which replaced the
// previous setup here: Open Relay Project's free SHARED community login,
// the same public username/password every other app on their free tier
// also used, worldwide, all drawing against the same pool. That's exactly
// why voice used to look "connected" (mic goes live) but carry no audio
// only some of the time -- whether a given connection got through depended
// on how loaded that shared relay happened to be at that moment for
// everyone using it, not on this game specifically.
// ============================================================
(function () {
  // Switched from Metered.ca (free tier: 500MB/month -- too small a
  // ceiling once real usage picks up) to Cloudflare's Realtime TURN
  // service (free tier: 1,000GB/month). Unlike Metered's setup, the
  // real Cloudflare credential is a powerful, permanent secret that
  // must never be shipped in this public file -- it lives ONLY on the
  // server (server.js, as the CF_TURN_KEY_ID/CF_TURN_API_TOKEN
  // environment variables) and is never visible to anyone viewing this
  // site's source. This file instead asks the server for a temporary,
  // short-lived (24h) username/password every time voice loads, via
  // /api/turn-credentials -- see that route in server.js for the full
  // reasoning. Starts as STUN-only and gets replaced once the fetch
  // below resolves; if the fetch fails for any reason, voice chat still
  // works for anyone whose connection doesn't need TURN, it just won't
  // get the relay fallback that flaky mobile/wifi connections need.
  let ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];
  const iceServersReady = fetch('/api/turn-credentials')
    .then(r => r.json())
    .then(data => {
      if (data && Array.isArray(data.iceServers) && data.iceServers.length) {
        ICE_SERVERS = data.iceServers;
      }
    })
    .catch((e) => {
      console.warn('[voice] Could not fetch TURN credentials, falling back to STUN-only:', e.message);
    });

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
      #k28vBtn{position:fixed;left:10px;bottom:40px;width:44px;height:44px;border-radius:50%;
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
      #k28vPanel{position:fixed;left:10px;bottom:92px;width:118px;max-height:150px;overflow-y:auto;
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
        // Password first -- the microphone isn't touched until it's accepted.
        if (!(await ensureVoiceAccess())) return;
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

  // ---------------- Voice password ----------------
  // Voice is behind a short password (checked by the SERVER, never stored in
  // this file, so editing the page can't skip it). Asked when voice is
  // switched on; once it's been entered correctly it is remembered for this
  // browser tab only (sessionStorage), so toggling the mic or refreshing
  // doesn't ask again -- closing the tab does.
  let voiceCode = '';
  try { voiceCode = sessionStorage.getItem('k28v_code') || ''; } catch (e) {}
  function serverAcceptsCode(code) {
    return new Promise((resolve) => {
      if (!socket) { resolve(false); return; }
      let settled = false;
      const t = setTimeout(() => { if (!settled) { settled = true; resolve(false); } }, 6000);
      try {
        socket.emit('voiceCheck', { code: code }, (res) => {
          if (settled) return; settled = true; clearTimeout(t);
          resolve(!!(res && res.ok));
        });
      } catch (e) { if (!settled) { settled = true; clearTimeout(t); resolve(false); } }
    });
  }
  // Resolves true once a correct password has been given (or was already
  // given earlier in this tab); false if cancelled.
  async function ensureVoiceAccess() {
    if (voiceCode && await serverAcceptsCode(voiceCode)) return true;
    voiceCode = '';
    try { sessionStorage.removeItem('k28v_code'); } catch (e) {}
    return new Promise((resolve) => {
      if (document.getElementById('k28vPwOverlay')) { resolve(false); return; }
      if (!document.getElementById('k28vPwStyle')) {
        const st = document.createElement('style');
        st.id = 'k28vPwStyle';
        st.textContent = `
          #k28vPwOverlay{position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,0.72);display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box}
          #k28vPwBox{width:100%;max-width:320px;background:#12181f;color:#e8edf2;border:1px solid #f4c430;border-radius:14px;padding:18px;box-shadow:0 10px 40px rgba(0,0,0,0.6);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
          #k28vPwBox h3{margin:0 0 12px;font-size:1.05rem;color:#f4c430}
          #k28vPwInput{width:100%;box-sizing:border-box;padding:11px 12px;border-radius:9px;border:1px solid rgba(255,255,255,0.25);background:#0e141b;color:#fff;font-size:1.05rem;letter-spacing:3px;text-align:center}
          #k28vPwErr{min-height:18px;margin:6px 0 0;font-size:0.78rem;color:#ff7b7b;text-align:center}
          #k28vPwBtns{display:flex;gap:10px;margin-top:8px}
          #k28vPwBtns button{flex:1;padding:11px 8px;border-radius:9px;font-weight:800;font-size:0.85rem;cursor:pointer;border:1px solid rgba(255,255,255,0.25);background:#243040;color:#e8edf2}
          #k28vPwBtns button.go{background:linear-gradient(135deg,#f4c430,#c99a1e);border-color:#f4c430;color:#241a12}
        `;
        document.head.appendChild(st);
      }
      const ov = document.createElement('div');
      ov.id = 'k28vPwOverlay';
      ov.innerHTML = `
        <div id="k28vPwBox" role="dialog" aria-modal="true" aria-labelledby="k28vPwTitle">
          <h3 id="k28vPwTitle">🎙️ Voice chat</h3>
          <input id="k28vPwInput" type="password" inputmode="numeric" autocomplete="off" placeholder="Password" maxlength="40">
          <div id="k28vPwErr"></div>
          <div id="k28vPwBtns">
            <button type="button" id="k28vPwCancel">Cancel</button>
            <button type="button" id="k28vPwGo" class="go">Join voice</button>
          </div>
        </div>`;
      const input = () => ov.querySelector('#k28vPwInput');
      const err = (m) => { ov.querySelector('#k28vPwErr').textContent = m; };
      const done = (val) => { document.removeEventListener('keydown', onKey, true); ov.remove(); resolve(val); };
      const submit = async () => {
        const code = input().value.trim();
        if (!code) { err('Enter the password'); return; }
        const goBtn = ov.querySelector('#k28vPwGo'); goBtn.disabled = true;
        const ok = await serverAcceptsCode(code);
        goBtn.disabled = false;
        if (ok) {
          voiceCode = code;
          try { sessionStorage.setItem('k28v_code', code); } catch (e) {}
          done(true);
        } else { err('Wrong password'); input().value = ''; input().focus(); }
      };
      const onKey = (e) => {
        if (e.key === 'Escape') { e.stopPropagation(); done(false); }
        else if (e.key === 'Enter' && document.activeElement === input()) { e.preventDefault(); submit(); }
      };
      document.addEventListener('keydown', onKey, true);
      ov.addEventListener('click', (e) => { if (e.target === ov) done(false); });
      document.body.appendChild(ov);
      ov.querySelector('#k28vPwCancel').addEventListener('click', () => done(false));
      ov.querySelector('#k28vPwGo').addEventListener('click', submit);
      setTimeout(() => input().focus(), 50);
    });
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
    // Real-world networks (mobile data, restrictive wifi) can leave a peer
    // connection stuck exactly the way it's been reported live: the mic
    // button goes "live" (that only means the local mic + signaling
    // succeeded, not that audio is actually flowing both ways) while the
    // ICE/media path itself never completes or drops silently -- same-
    // machine testing can't reproduce this because localhost never needs
    // STUN/TURN to begin with. WebRTC's standard recovery for that is an
    // ICE restart on the existing connection rather than tearing the peer
    // down immediately and hoping it reconnects some other way.
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') {
        try { pc.restartIce(); } catch (e) {}
        return;
      }
      if (['closed', 'disconnected'].includes(pc.connectionState)) removePeer(id);
    };
    // Both sides can end up needing to originate a fresh offer later (an
    // ICE restart from either end fires this same event), but the very
    // first time this fires on the ANSWER side it's just the browser
    // reacting to addTrack() before any negotiation has happened at all --
    // that initial handshake is already driven explicitly by the incoming
    // offer in handleSignal() below, so it's ignored here via the
    // pc._answered guard, which only flips true once that first answer has
    // actually been sent.
    pc.onnegotiationneeded = async () => {
      if (!isInitiator && !pc._answered) return;
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('voiceSignal', { to: id, signal: { sdp: pc.localDescription } });
      } catch (e) { console.warn('[voice] negotiation error', e); }
    };
    return pc;
  }

  // A brief real-world network drop (wifi hiccup, phone locking, a
  // carrier tower handoff) can take the underlying Socket.IO connection
  // down along with it. The server correctly can't tell that's temporary
  // -- from its side that socket is simply gone -- so the moment it
  // happens, it already removes this player from the voice room and
  // tells every other peer they left (see the 'disconnect' handler in
  // server.js). Reconnecting gets a brand-new socket id, so unless this
  // device also rejoins voice specifically, everyone else's side stays
  // torn down forever even though the game itself reconnected fine --
  // exactly the reported "have to rejoin manually" symptom. This clears
  // out the now-stale peer connections left over from before the drop
  // (the other ends already closed theirs) so a fresh join can rebuild
  // them cleanly.
  function clearStalePeers() {
    for (const id of Array.from(peers.keys())) removePeer(id);
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
        pc._answered = true;
        socket.emit('voiceSignal', { to: from, signal: { sdp: pc.localDescription } });
      }
    } else if (signal.candidate) {
      try { await pc.addIceCandidate(new RTCIceCandidate(signal.candidate)); } catch (e) {}
    }
  }

  // ---------------- Public API ----------------
  async function join() {
    if (inCall) return true;
    // Make sure the real TURN credentials (not just the STUN-only
    // starting value above) have arrived before anyone actually tries
    // to connect -- this resolves almost instantly in practice since
    // the fetch kicked off the moment this script loaded, well before
    // a player taps the mic button.
    await iceServersReady;
    try {
      await ensureMic();
    } catch (e) {
      alert('Voice chat needs microphone access. Please allow it in your browser, then tap the mic button again.');
      return false;
    }
    inCall = true;
    socket.emit('voiceJoin', { name: getName(), code: voiceCode });
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

  // Anchors the mic button (bottom-left) and the chat button (bottom-right,
  // see #btnChat in index.html) just ABOVE the actual card row. Earlier
  // this measured from #tableArea's own bottom edge, but the hand-area
  // (the cards) is the last row INSIDE #tableArea, not below it -- so that
  // measurement landed right at the cards instead of above them, and the
  // buttons overlapped the hand. Measuring from #handArea's own top edge
  // (with a real clearance buffer for the cards that visually poke up
  // above their row) fixes that regardless of screen size or how tall the
  // card row currently is.
  let headerWatchedEl = null;
  let headerResizeObserver = null;

  function positionButtons() {
    if (!ui) return;
    const table = document.getElementById('tableArea');
    const hand = document.getElementById('handArea');

    if (!table && !hand) {
      // #tableArea/#handArea only exist on the 4-player page. The
      // 6-player and 56 tables don't have them, so the code below used
      // to silently fall through to a generic hardcoded bottom-left
      // spot with no idea where those pages' actual cards are -- which
      // is exactly why the mic ended up sitting on top of the hand
      // there. Rather than guess at each page's differently-shaped
      // hand-of-cards layout, anchor just below whichever header/topbar
      // element that page actually has instead -- every game page has
      // one, in some form, and it's never near the cards. This also
      // means #btnChat is left completely untouched on these pages
      // (see the early return below) -- unlike the 4-player page, it
      // already lives correctly docked in that page's own topbar/header
      // and was never meant to float in a corner there.
      const header = document.querySelector('.topbar') || document.getElementById('gameHeader') || document.querySelector('header');
      let topY = 60;
      if (header) {
        const hdrRect = header.getBoundingClientRect();
        if (hdrRect.height > 0 && getComputedStyle(header).display !== 'none') {
          topY = hdrRect.bottom + 40;
        }
        // Real, confirmed bug fix per explicit live report: six-player's
        // trump indicator (.trump-chip) is a SEPARATE element, its own
        // independently-positioned fixed spot below the topbar -- not
        // part of the topbar's own measured height at all. Once that
        // chip's own position/size grew (bigger text, moved further
        // down to clear a taller topbar), this button's clearance,
        // still based purely on the topbar's own bottom edge, was no
        // longer enough to also clear the chip sitting below it, and
        // the two started overlapping. Extends topY to also clear the
        // trump chip's own actual bottom edge, whenever that element
        // exists on this page, instead of a fixed +40 that only ever
        // knew about the topbar itself.
        const trumpChip = document.querySelector('.trump-chip');
        if (trumpChip) {
          const chipRect = trumpChip.getBoundingClientRect();
          if (chipRect.height > 0 && getComputedStyle(trumpChip).display !== 'none') {
            topY = Math.max(topY, chipRect.bottom + 16);
          }
        }
        // 56's header (and possibly others) has a second row -- dealer,
        // trump, score -- that only expands once an actual hand starts,
        // which can easily happen well after this first ran (it depends
        // on game state loading over the network, not a fixed delay).
        // Positioning once/twice on a timer isn't enough to catch that
        // later height change, which is exactly why the mic ended up
        // overlapping that second row. Watching the header itself keeps
        // this correct no matter when or how many times its height
        // actually changes.
        if (headerWatchedEl !== header) {
          if (headerResizeObserver) headerResizeObserver.disconnect();
          if (window.ResizeObserver) {
            headerResizeObserver = new ResizeObserver(positionButtons);
            headerResizeObserver.observe(header);
            headerWatchedEl = header;
          }
        }
      }
      ui.btn.style.left = '8px';
      ui.btn.style.right = 'auto';
      ui.btn.style.top = topY + 'px';
      ui.btn.style.bottom = 'auto';
      ui.panel.style.left = '8px';
      ui.panel.style.right = 'auto';
      ui.panel.style.top = (topY + 52) + 'px';
      ui.panel.style.bottom = 'auto';
      return;
    }

    let leftEdge = 8, rightEdge = 8, bottomOffset = 40;
    if (table) {
      const tRect = table.getBoundingClientRect();
      if (tRect.width > 0 && getComputedStyle(table).display !== 'none') {
        leftEdge = tRect.left + 6;
        rightEdge = window.innerWidth - tRect.right + 6;
        // Default clearance off the table's own bottom, used only if the
        // hand-area can't be measured (e.g. not dealt yet).
        bottomOffset = Math.max(8, window.innerHeight - tRect.bottom) + 32;
      }
    }
    if (hand) {
      const hRect = hand.getBoundingClientRect();
      if (hRect.height > 0) {
        // 44px clears a fanned card poking up above the hand-area's own
        // box, plus a 10px gap so the button doesn't touch the card tips.
        bottomOffset = Math.max(8, window.innerHeight - hRect.top) + 44;
      }
    }
    ui.btn.style.left = leftEdge + 'px';
    ui.btn.style.right = 'auto';
    ui.btn.style.top = 'auto';
    ui.btn.style.bottom = bottomOffset + 'px';
    ui.panel.style.left = leftEdge + 'px';
    ui.panel.style.top = 'auto';
    ui.panel.style.bottom = (bottomOffset + 52) + 'px';

    // Sound mute button - sits directly to the right of the mic, same size, same dynamic
    // bottomOffset the mic itself just got. It used to have its own static bottom:40px
    // guess (matching the mic's own old static value), which is exactly why it ended up
    // sitting on top of the hand of cards on a real device with a full 8-card hand instead
    // of the near-empty test hand it was originally checked against - the hand-area's real
    // height varies enough that only measuring it directly (like the mic already does) is
    // actually reliable.
    const muteBtn = document.getElementById('btnSoundMute');
    if (muteBtn) {
      muteBtn.style.left = (leftEdge + 54) + 'px';
      muteBtn.style.right = 'auto';
      muteBtn.style.top = 'auto';
      muteBtn.style.bottom = bottomOffset + 'px';
    }

    const chatBtn = document.getElementById('btnChat');
    if (chatBtn) {
      chatBtn.style.position = 'fixed';
      chatBtn.style.right = rightEdge + 'px';
      chatBtn.style.left = 'auto';
      chatBtn.style.top = 'auto';
      chatBtn.style.bottom = bottomOffset + 'px';
    }
    // COT ("declare COT") sits just to the left of the chat button and had its own static
    // bottom:150px in the HTML, never touched by this function - which is exactly why it
    // could drift out of alignment with chat on any device where chat's real (dynamic)
    // clearance off the hand-of-cards ends up landing somewhere other than 150px. Tying it
    // to the same bottomOffset chat just got keeps them level on every screen, not just the
    // ones where 150px happened to line up by coincidence.
    const cotBtn = document.getElementById('btnQuoteDeclare');
    if (cotBtn) {
      cotBtn.style.position = 'fixed';
      cotBtn.style.right = (rightEdge + 40) + 'px';
      cotBtn.style.left = 'auto';
      cotBtn.style.top = 'auto';
      cotBtn.style.bottom = bottomOffset + 'px';
    }
  }
  window.addEventListener('resize', positionButtons);

  function showButton() { buildUI().btn.style.display = 'flex'; positionButtons(); setTimeout(positionButtons, 300); }
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
    socket.on('voiceDenied', () => {
      voiceCode = ''; try { sessionStorage.removeItem('k28v_code'); } catch (e) {}
      if (inCall) { leave(); if (ui) { ui.btn.classList.remove('live', 'speaking'); ui.panel.classList.remove('on'); } }
    });
    socket.on('voiceSignal', ({ from, signal }) => handleSignal(from, signal));
    // Fires on every successful (re)connection of the underlying game
    // socket, including the very first one -- inCall is still false at
    // that point (nobody's tapped the mic yet) so this is a harmless
    // no-op then. It only does something on a genuine RECONNECT after an
    // actual voice call was already underway, silently rebuilding it
    // with the still-held microphone stream (no new permission prompt,
    // no visible interruption) instead of leaving voice quietly dead
    // until the person notices and manually retaps the mic button.
    socket.on('connect', () => {
      if (!inCall) return;
      clearStalePeers();
      socket.emit('voiceJoin', { name: getName(), code: voiceCode });
    });
    document.addEventListener('click', retryBlockedAudio, { passive: true });
  }

  window.K28Voice = { attach, showButton, hideButton, join, leave, get inCall() { return inCall; } };
})();
