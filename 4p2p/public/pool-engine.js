(() => {
  "use strict";

  // ==================== TABLE GEOMETRY ====================
  const W = 900, H = 450; // 2:1 ratio, standard pool table proportions
  const RAIL = 28; // cushion inset from canvas edge
  const PLAY_L = RAIL, PLAY_R = W - RAIL, PLAY_T = RAIL, PLAY_B = H - RAIL;
  const BALL_R = 11;
  const POCKET_R = 21; // mouth radius a ball's center must reach to fall

  // 6 pockets: 4 corners + 2 side-middles
  function pocketCenters() {
    const midY = (PLAY_T + PLAY_B) / 2;
    return [
      { x: PLAY_L, y: PLAY_T, corner: true },
      { x: (PLAY_L+PLAY_R)/2, y: PLAY_T - 4, corner: false },
      { x: PLAY_R, y: PLAY_T, corner: true },
      { x: PLAY_L, y: PLAY_B, corner: true },
      { x: (PLAY_L+PLAY_R)/2, y: PLAY_B + 4, corner: false },
      { x: PLAY_R, y: PLAY_B, corner: true },
    ];
  }

  // ==================== PHYSICS CONSTANTS ====================
  const FRICTION = 0.9915; // rolling resistance, applied per frame
  const MIN_SPEED = 0.05;
  const WALL_RESTITUTION = 0.86;
  const BALL_RESTITUTION = 0.98; // ball-ball collisions lose very little energy
  const MAX_SHOT_SPEED = 32;

  // ==================== BALL SETUP ====================
  // Standard numbering: 1-7 solid, 8 the eight-ball, 9-15 stripe.
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

  // Triangle rack, apex toward the head spot the cue ball breaks from.
  // 8-ball goes in the exact center of the triangle (3rd row); one
  // random solid and one random stripe anchor the two back corners,
  // per standard tournament rack rules.
  function buildRack() {
    const balls = [];
    balls.push({ num: 0, x: PLAY_L + (PLAY_R-PLAY_L)*0.25, y: (PLAY_T+PLAY_B)/2, vx:0, vy:0, r:BALL_R, potted:false });

    const apexX = PLAY_L + (PLAY_R-PLAY_L)*0.72;
    const apexY = (PLAY_T+PLAY_B)/2;
    const spacing = BALL_R * 2.02;
    const rowDx = spacing * Math.sqrt(3)/2;

    // Build the 15-slot triangle order, then place numbers respecting
    // the "8-ball in the center, solids/stripes alternate-ish" rule.
    const positions = [];
    for (let row = 0; row < 5; row++) {
      for (let i = 0; i <= row; i++) {
        const x = apexX + row*rowDx;
        const y = apexY - row*spacing/2 + i*spacing;
        positions.push({ x, y, row, i });
      }
    }
    // Center of the 3rd row (index 2 within that row of 3) is the 8-ball slot.
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
  // Returns { stillMoving, pottedThisStep, cueHitOrder } — cueHitOrder
  // tracks which ball the cue ball contacts FIRST each shot, needed for
  // "did you hit your own group first" foul detection.
  function stepPhysics(balls, shotState) {
    let stillMoving = false;
    const potted = [];

    balls.forEach(b => {
      if (b.potted) return;
      if (Math.abs(b.vx) < MIN_SPEED && Math.abs(b.vy) < MIN_SPEED) { b.vx = 0; b.vy = 0; return; }
      stillMoving = true;
      b.x += b.vx; b.y += b.vy;
      b.vx *= FRICTION; b.vy *= FRICTION;

      // Cushions
      if (b.x - b.r < PLAY_L) { b.x = PLAY_L + b.r; b.vx = -b.vx*WALL_RESTITUTION; }
      if (b.x + b.r > PLAY_R) { b.x = PLAY_R - b.r; b.vx = -b.vx*WALL_RESTITUTION; }
      if (b.y - b.r < PLAY_T) { b.y = PLAY_T + b.r; b.vy = -b.vy*WALL_RESTITUTION; }
      if (b.y + b.r > PLAY_B) { b.y = PLAY_B - b.r; b.vy = -b.vy*WALL_RESTITUTION; }
    });

    // Ball-ball collisions (equal mass elastic collision along the normal)
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
              // record whichever of the pair is NOT the cue ball as the first contact
              if (a.num === 0) shotState.firstContact = b.num;
              else if (b.num === 0) shotState.firstContact = a.num;
            }
          }
        }
      }
    }

    // Pockets
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
