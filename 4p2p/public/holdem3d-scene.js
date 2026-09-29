// ============================================================================
// holdem3d-scene.js
//
// Full 3D table/cards/chips visualization for the offline holdem3d.html
// testing sandbox, built with Three.js. This never touches server.js, the
// real holdem.html, or the 28gulan game files.
//
// It hooks in non-invasively: holdem3d.html's own render code
// (renderGameTable, defined in the huge inline <script> that this file
// loads AFTER) is left completely untouched. This file just wraps that one
// global function so every real state update also updates the 3D scene,
// and swaps the flat 2D felt/cards for a WebGL canvas + generated 3D scene.
// ============================================================================
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

(function () {
  'use strict';

  // ---------------------------------------------------------------------
  // Small canvas-texture helpers
  // ---------------------------------------------------------------------
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  const textureCache = new Map();
  function getCardTexture(card) {
    const key = card && card.rank ? card.rank + card.suit : 'BACK';
    if (textureCache.has(key)) return textureCache.get(key);
    const c = document.createElement('canvas');
    c.width = 256; c.height = 358;
    const ctx = c.getContext('2d');
    roundRect(ctx, 4, 4, 248, 350, 22);
    if (key === 'BACK') {
      ctx.fillStyle = '#7a1f1f'; ctx.fill();
      ctx.lineWidth = 8; ctx.strokeStyle = '#f4c430'; ctx.stroke();
      ctx.fillStyle = 'rgba(244,196,48,0.28)';
      for (let yy = 24; yy < 336; yy += 30) {
        for (let xx = 24; xx < 232; xx += 30) { ctx.beginPath(); ctx.arc(xx, yy, 4, 0, Math.PI * 2); ctx.fill(); }
      }
      ctx.fillStyle = '#f4c430';
      ctx.font = 'bold 46px sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('28', 128, 179);
    } else {
      ctx.fillStyle = '#fdf6e3'; ctx.fill();
      ctx.lineWidth = 6; ctx.strokeStyle = '#c9a227'; ctx.stroke();
      const isRed = card.suit === '♥' || card.suit === '♦';
      ctx.fillStyle = isRed ? '#c62828' : '#1a1a1a';
      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.font = 'bold 54px sans-serif';
      ctx.fillText(card.rank, 18, 12);
      ctx.font = '46px sans-serif';
      ctx.fillText(card.suit, 18, 72);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = '120px sans-serif';
      ctx.fillText(card.suit, 128, 200);
      ctx.save();
      ctx.translate(238, 346);
      ctx.rotate(Math.PI);
      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.font = 'bold 54px sans-serif';
      ctx.fillText(card.rank, 0, 0);
      ctx.font = '46px sans-serif';
      ctx.fillText(card.suit, 0, 58);
      ctx.restore();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.anisotropy = 4;
    textureCache.set(key, tex);
    return tex;
  }
  function makeLabelSprite(text, opts) {
    const c = document.createElement('canvas');
    c.width = 320; c.height = 80;
    const ctx = c.getContext('2d');
    ctx.fillStyle = 'rgba(10,20,32,0.78)';
    roundRect(ctx, 2, 2, 316, 76, 16); ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = (opts && opts.active) ? '#4aa3ff' : '#f4c430';
    roundRect(ctx, 3, 3, 314, 74, 16); ctx.stroke();
    ctx.fillStyle = '#fdf6e3';
    ctx.font = 'bold 26px sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, 160, 40, 300);
    const tex = new THREE.CanvasTexture(c);
    const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
    const spr = new THREE.Sprite(mat);
    spr.scale.set(1.5, 0.38, 1);
    spr.renderOrder = 10;
    return spr;
  }

  // ---------------------------------------------------------------------
  // Scene bootstrap
  // ---------------------------------------------------------------------
  let scene, camera, renderer, controls, canvas, tableWrapEl;
  let seatAnchors = [];
  let dynamicGroup;
  let staticBuilt = false;
  let rafId = null;

  function ensureInit() {
    if (staticBuilt) return true;
    tableWrapEl = document.querySelector('.table-wrap');
    if (!tableWrapEl) return false;

    canvas = document.createElement('canvas');
    canvas.id = 'holdem3dCanvas';
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border-radius:50%;display:block;';
    tableWrapEl.insertBefore(canvas, tableWrapEl.firstChild);
    document.body.classList.add('holdem3d-active');

    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
    camera.position.set(0, 6.2, 6.6);
    camera.lookAt(0, 0, 0);

    scene.add(new THREE.AmbientLight(0xffffff, 0.65));
    const dir = new THREE.DirectionalLight(0xfff2d0, 0.9);
    dir.position.set(3, 8, 4);
    scene.add(dir);
    const dir2 = new THREE.DirectionalLight(0xbfd9ff, 0.25);
    dir2.position.set(-4, 5, -3);
    scene.add(dir2);

    const feltGeo = new THREE.CylinderGeometry(1, 1, 0.12, 64);
    feltGeo.scale(3.6, 1, 2.4);
    const felt = new THREE.Mesh(feltGeo, new THREE.MeshStandardMaterial({ color: 0x0b6b3a, roughness: 0.9 }));
    felt.position.y = -0.06;
    scene.add(felt);

    const rimGeo = new THREE.TorusGeometry(1, 0.18, 16, 64);
    rimGeo.scale(3.75, 2.55, 1);
    const rim = new THREE.Mesh(rimGeo, new THREE.MeshStandardMaterial({ color: 0x3d2510, roughness: 0.7 }));
    rim.rotation.x = Math.PI / 2;
    scene.add(rim);

    if (OrbitControls) {
      controls = new OrbitControls(camera, canvas);
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;
      controls.minDistance = 3.5;
      controls.maxDistance = 11;
      controls.maxPolarAngle = Math.PI * 0.47;
      controls.enablePan = false;
      controls.target.set(0, 0, 0);
      // Per Web Interface Guidelines: no autoplay motion beyond user input,
      // and reduced-motion users get a fully static table.
      const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      controls.enableDamping = !reduceMotion;
    }

    dynamicGroup = new THREE.Group();
    scene.add(dynamicGroup);

    seatAnchors = [];
    for (let slot = 0; slot < 9; slot++) {
      const angle = (slot / 9) * Math.PI * 2;
      const x = Math.sin(angle) * 3.15;
      const z = Math.cos(angle) * 2.15;
      const anchor = new THREE.Group();
      anchor.position.set(x, 0.02, z);
      anchor.lookAt(0, 0.02, 0);
      scene.add(anchor);
      seatAnchors[slot] = anchor;
    }

    window.addEventListener('resize', onResize);
    staticBuilt = true;
    onResize();
    animate();
    return true;
  }

  function onResize() {
    if (!renderer || !tableWrapEl) return;
    const w = tableWrapEl.clientWidth, h = tableWrapEl.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  function animate() {
    rafId = requestAnimationFrame(animate);
    if (controls) controls.update();
    if (renderer && scene && camera) renderer.render(scene, camera);
  }

  function clearGroup(g) {
    while (g.children.length) {
      const obj = g.children.pop();
      if (obj.children && obj.children.length) clearGroup(obj);
      if (obj.geometry) obj.geometry.dispose();
      // Note: material.map textures are cached/shared (see getCardTexture)
      // and intentionally NOT disposed here -- only the mesh's own material.
      if (obj.material) obj.material.dispose();
    }
  }

  // ---------------------------------------------------------------------
  // Per-state-update rebuild (small table, rebuilding is cheap)
  // ---------------------------------------------------------------------
  function updateHoldem3DScene(state) {
    if (!ensureInit() || !state || !state.seats) return;
    // Also clear leftover per-seat dynamic content from the previous update.
    seatAnchors.forEach((a) => clearGroup(a));
    clearGroup(dynamicGroup);

    state.seats.forEach((s, pos) => {
      if (!s) return;
      const slot = (typeof slotFor === 'function') ? slotFor(pos) : pos;
      const anchor = seatAnchors[slot];
      if (!anchor) return;
      const isActive = state.currentPlayer === pos && state.phase !== 'handEnd';

      const disc = new THREE.Mesh(
        new THREE.CylinderGeometry(0.34, 0.34, 0.06, 24),
        new THREE.MeshStandardMaterial({
          color: s.isBot ? 0x2c4a63 : 0xf4c430,
          emissive: isActive ? 0x4aa3ff : 0x000000,
          emissiveIntensity: isActive ? 0.7 : 0,
        })
      );
      disc.position.set(0, 0.15, 0.55);
      anchor.add(disc);

      const chipsLabel = `${s.name}  ${s.chips}`;
      const label = makeLabelSprite(chipsLabel, { active: isActive });
      label.position.set(0, 0.55, 0.55);
      anchor.add(label);

      if (s.lastAction) {
        const actLabel = makeLabelSprite(s.lastAction, { active: false });
        actLabel.scale.set(1.15, 0.3, 1);
        actLabel.position.set(0, 0.88, 0.55);
        anchor.add(actLabel);
      }

      if (pos === state.dealerSeat) {
        const dBtn = new THREE.Mesh(
          new THREE.CylinderGeometry(0.13, 0.13, 0.05, 16),
          new THREE.MeshStandardMaterial({ color: 0xfdf6e3 })
        );
        dBtn.position.set(0.42, 0.16, 0.55);
        anchor.add(dBtn);
      }

      if (!s.folded && s.hand && s.hand.length) {
        s.hand.forEach((c, i) => {
          const tex = getCardTexture(c && c.rank ? c : null);
          const card = new THREE.Mesh(
            new THREE.PlaneGeometry(0.34, 0.48),
            new THREE.MeshStandardMaterial({ map: tex, side: THREE.DoubleSide, roughness: 0.6 })
          );
          card.rotation.x = -Math.PI / 2 + 0.35;
          card.position.set((i - 0.5) * 0.28, 0.1, 0.18);
          anchor.add(card);
        });
      } else if (s.folded) {
        const foldLabel = makeLabelSprite('FOLDED', { active: false });
        foldLabel.scale.set(1, 0.26, 1);
        foldLabel.position.set(0, 0.15, 0.18);
        anchor.add(foldLabel);
      }
      if (s.allIn) {
        const allInLabel = makeLabelSprite('ALL-IN', { active: true });
        allInLabel.scale.set(1, 0.26, 1);
        allInLabel.position.set(0.4, 0.4, 0.55);
        anchor.add(allInLabel);
      }
    });

    (state.board || []).forEach((c, i) => {
      const tex = getCardTexture(c);
      const card = new THREE.Mesh(
        new THREE.PlaneGeometry(0.46, 0.65),
        new THREE.MeshStandardMaterial({ map: tex, side: THREE.DoubleSide, roughness: 0.6 })
      );
      card.rotation.x = -Math.PI / 2 + 0.15;
      card.position.set((i - 2) * 0.55, 0.05, -0.1);
      dynamicGroup.add(card);
    });

    const potAmount = (state.pots || []).reduce((s, p) => s + p.amount, 0)
      + (state.seats || []).reduce((s, seat) => s + (seat ? (seat.bettedThisRound || 0) : 0), 0);
    if (potAmount > 0) {
      const discs = Math.max(1, Math.min(8, Math.round(potAmount / Math.max(1, (state.bigBlind || 10) * 2))));
      for (let i = 0; i < discs; i++) {
        const chip = new THREE.Mesh(
          new THREE.CylinderGeometry(0.22, 0.22, 0.045, 20),
          new THREE.MeshStandardMaterial({ color: i % 2 === 0 ? 0xf4c430 : 0xe74040 })
        );
        chip.position.set(0, 0.03 + i * 0.045, 0.75);
        dynamicGroup.add(chip);
      }
      const potLabel = makeLabelSprite('Pot ' + potAmount, { active: false });
      potLabel.position.set(0, 0.5, 0.75);
      dynamicGroup.add(potLabel);
    }
  }
  window.updateHoldem3DScene = updateHoldem3DScene;

  // ---------------------------------------------------------------------
  // Non-invasive hook into the existing renderGameTable() -- defined by
  // holdem3d.html's own (untouched) main script, which this file loads
  // after.
  // ---------------------------------------------------------------------
  function patch() {
    if (typeof window.renderGameTable !== 'function' || window.renderGameTable.__holdem3dPatched) return false;
    const orig = window.renderGameTable;
    window.renderGameTable = function (state) {
      orig(state);
      try { updateHoldem3DScene(state); } catch (e) { console.error('[holdem3d-scene]', e); }
    };
    window.renderGameTable.__holdem3dPatched = true;
    return true;
  }
  if (!patch()) {
    // Script order guarantees renderGameTable already exists by the time
    // this file loads (it's inserted right before </body>), but fall back
    // to a short poll just in case load order ever changes.
    let tries = 0;
    const iv = setInterval(() => { if (patch() || ++tries > 50) clearInterval(iv); }, 100);
  }
})();
