(() => {
  "use strict";

  // ==================== TABLE GEOMETRY ====================
  // Vertical/portrait orientation — the table's LONG axis runs top-to-
  // bottom, matching a phone held normally, instead of the original
  // landscape layout that scaled down to nearly nothing on a narrow
  // screen. Still a standard 2:1 pool-table ratio, just rotated 90°.
  const W = 450, H = 900;
  const RAIL = 23; // was 26 -- thinner still, close to the minimum that keeps the pocket holes (radius 21) from clipping the canvas edge, giving the playing surface more room
  const PLAY_L = RAIL, PLAY_R = W - RAIL, PLAY_T = RAIL, PLAY_B = H - RAIL;
  const BALL_R = 11;
  const POCKET_R = 21; // mouth radius a ball's center must reach to fall

  // 6 pockets: 4 corners + 2 side-middles (now on the LEFT/RIGHT rails,
  // since the table is rotated — the two "long side" pockets used to
  // sit on the top/bottom rails in the landscape layout).
  function pocketCenters() {
    return [
      { x: PLAY_L, y: PLAY_T, corner: true },
      { x: PLAY_L - 4, y: (PLAY_T+PLAY_B)/2, corner: false },
      { x: PLAY_L, y: PLAY_B, corner: true },
      { x: PLAY_R, y: PLAY_T, corner: true },
      { x: PLAY_R + 4, y: (PLAY_T+PLAY_B)/2, corner: false },
      { x: PLAY_R, y: PLAY_B, corner: true },
    ];
  }

  // ==================== PHYSICS CONSTANTS ====================
  const FRICTION = 0.9915;
  const MIN_SPEED = 0.05;
  const WALL_RESTITUTION = 0.86;
  const BALL_RESTITUTION = 0.98;
  const MAX_SHOT_SPEED = 32;
  // Spin (English) physics constants. spinTop/spinBack and spinSide are
  // tracked as their own decaying quantities, separate from the ball's
  // straight-line velocity -- this is what makes spin act like real
  // rolling friction gradually converting spin into motion, rather than
  // a single instant nudge. SPIN_DECAY controls how many frames the
  // spin lasts before fully converting/dissipating; SPIN_RATE controls
  // how strongly it pushes the ball each frame while it's active.
  const SPIN_DECAY = 0.965;
  const SPIN_RATE = 0.42;

  // ==================== BALL SETUP ====================
  const BALL_COLORS = {
    1:'#e8c33a', 2:'#2255c9', 3:'#d43a3a', 4:'#7a3ab5', 5:'#e07a1f',
    6:'#1f8a4a', 7:'#7a2e1f', 8:'#1a1a1a',
    9:'#e8c33a', 10:'#2255c9', 11:'#d43a3a', 12:'#7a3ab5', 13:'#e07a1f',
    14:'#1f8a4a', 15:'#7a2e1f'
  };
  function ballType(num) {
    if (num === 0) return 'cue';
    if (num === 8) return 'eight';
    return num <= 7 ? 'solid' : 'stripe';
  }

  // Triangle rack, apex pointing toward the far end. Cue ball breaks
  // from near the bottom of the table, matching how a real table is
  // always played "up the table" away from the player.
  function buildRack() {
    const balls = [];
    balls.push({ num: 0, x: (PLAY_L+PLAY_R)/2, y: PLAY_T + (PLAY_B-PLAY_T)*0.75, vx:0, vy:0, r:BALL_R, potted:false });

    const apexX = (PLAY_L+PLAY_R)/2;
    const apexY = PLAY_T + (PLAY_B-PLAY_T)*0.28;
    const spacing = BALL_R * 2.02;
    const rowDy = spacing * Math.sqrt(3)/2;

    const positions = [];
    for (let row = 0; row < 5; row++) {
      for (let i = 0; i <= row; i++) {
        const x = apexX - row*spacing/2 + i*spacing;
        const y = apexY - row*rowDy; // rack extends UPWARD toward the far end
        positions.push({ x, y, row, i });
      }
    }
    const eightSlotIdx = positions.findIndex(p => p.row === 2 && p.i === 1);
    const solids = [1,2,3,4,5,6,7];
    const stripes = [9,10,11,12,13,14,15];
    shuffle(solids); shuffle(stripes);
    let si = 0, ti = 0;
    const numbers = new Array(15);
    numbers[eightSlotIdx] = 8;
    for (let idx = 0; idx < 15; idx++) {
      if (idx === eightSlotIdx) continue;
      numbers[idx] = (idx % 2 === 0) ? solids[si++] : stripes[ti++];
    }
    positions.forEach((p, idx) => {
      balls.push({ num: numbers[idx], x: p.x, y: p.y, vx:0, vy:0, r:BALL_R, potted:false });
    });
    return balls;
  }
  function shuffle(arr) {
    for (let i = arr.length-1; i>0; i--) {
      const j = Math.floor(Math.random()*(i+1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  }

  // ==================== PHYSICS STEP ====================
  function stepPhysics(balls, shotState) {
    let stillMoving = false;
    const potted = [];

    balls.forEach(b => {
      if (b.potted) return;
      const hasSpin = (b.spinTop && Math.abs(b.spinTop) > 0.01) || (b.spinSide && Math.abs(b.spinSide) > 0.01);
      if (!hasSpin && Math.abs(b.vx) < MIN_SPEED && Math.abs(b.vy) < MIN_SPEED) { b.vx = 0; b.vy = 0; return; }
      stillMoving = true;
      // Spin (English): a decaying push along the ball's fixed original
      // shot-direction axis, not its current (possibly deflected)
      // velocity direction -- topspin/backspin keep pulling the ball
      // forward/backward along the line it was actually struck on,
      // exactly the same before AND after it hits another ball, since
      // this just runs every single frame regardless of what else
      // happened. This naturally produces follow (top spin continuing
      // the ball onward after contact) and draw (back spin pulling it
      // back) without any special-casing at the moment of collision.
      if (b.spinTop || b.spinSide) {
        const sdx = b.spinDirX || 0, sdy = b.spinDirY || 1;
        const perpX = -sdy, perpY = sdx;
        b.vx += sdx*(b.spinTop||0)*SPIN_RATE + perpX*(b.spinSide||0)*SPIN_RATE;
        b.vy += sdy*(b.spinTop||0)*SPIN_RATE + perpY*(b.spinSide||0)*SPIN_RATE;
        b.spinTop = (b.spinTop||0) * SPIN_DECAY;
        b.spinSide = (b.spinSide||0) * SPIN_DECAY;
        if (Math.abs(b.spinTop) < 0.01) b.spinTop = 0;
        if (Math.abs(b.spinSide) < 0.01) b.spinSide = 0;
      }
      b.x += b.vx; b.y += b.vy;
      b.vx *= FRICTION; b.vy *= FRICTION;

      if (b.x - b.r < PLAY_L) { b.x = PLAY_L + b.r; b.vx = -b.vx*WALL_RESTITUTION; }
      if (b.x + b.r > PLAY_R) { b.x = PLAY_R - b.r; b.vx = -b.vx*WALL_RESTITUTION; }
      if (b.y - b.r < PLAY_T) { b.y = PLAY_T + b.r; b.vy = -b.vy*WALL_RESTITUTION; }
      if (b.y + b.r > PLAY_B) { b.y = PLAY_B - b.r; b.vy = -b.vy*WALL_RESTITUTION; }
    });

    for (let i = 0; i < balls.length; i++) {
      if (balls[i].potted) continue;
      for (let j = i+1; j < balls.length; j++) {
        if (balls[j].potted) continue;
        const a = balls[i], b = balls[j];
        const dx = b.x-a.x, dy = b.y-a.y;
        const dist = Math.hypot(dx,dy);
        const minDist = a.r+b.r;
        if (dist < minDist && dist > 0) {
          const nx = dx/dist, ny = dy/dist;
          const overlap = minDist - dist;
          a.x -= nx*overlap/2; a.y -= ny*overlap/2;
          b.x += nx*overlap/2; b.y += ny*overlap/2;
          const relVx = b.vx-a.vx, relVy = b.vy-a.vy;
          const relSpeed = relVx*nx + relVy*ny;
          if (relSpeed < 0) {
            const impulse = -(1+BALL_RESTITUTION) * relSpeed / 2;
            a.vx -= impulse*nx; a.vy -= impulse*ny;
            b.vx += impulse*nx; b.vy += impulse*ny;
            if (shotState && shotState.firstContact === null) {
              if (a.num === 0) shotState.firstContact = b.num;
              else if (b.num === 0) shotState.firstContact = a.num;
            }
          }
        }
      }
    }

    const pockets = pocketCenters();
    balls.forEach(b => {
      if (b.potted) return;
      for (const p of pockets) {
        if (Math.hypot(b.x-p.x, b.y-p.y) < POCKET_R) {
          b.potted = true; b.vx = 0; b.vy = 0;
          potted.push(b.num);
          break;
        }
      }
    });

    return { stillMoving, potted };
  }

  window.PoolEngine = {
    W, H, RAIL, PLAY_L, PLAY_R, PLAY_T, PLAY_B, BALL_R, POCKET_R,
    FRICTION, WALL_RESTITUTION, BALL_RESTITUTION, MAX_SHOT_SPEED,
    BALL_COLORS, ballType, pocketCenters, buildRack, stepPhysics
  };
})();
