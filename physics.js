// tiny 2D rigid-body engine for crashed / shoved NPCs, in road space (x = s along the road, y = lateral).
// boxes with real mass + inertia, tyre grip (rolls easily, resists sliding sideways, resists spinning), impulse collisions
// with restitution + friction + spin from off-centre hits, positional correction so nothing sinks in, and wall planes.
// cheap: a handful of bodies, 4-axis SAT per nearby pair, 3 substeps per server tick.

const G = 9.81;
// kg. bike = bike + rider. grip: mu along the car (rolling/braking) and across it (tyres scrubbing sideways)
const SPEC = {
  0: { m: 1300, muL: 0.45, muS: 0.85 },   // coupe
  1: { m: 12000, muL: 0.4, muS: 0.75 },   // coach
  2: { m: 330, muL: 0.35, muS: 0.9 }      // bike (upright). knocked over it slides on its side: muL = muS = 0.55
};
const mass = c => (SPEC[c] || SPEC[0]).m;

function body(x, y, a, vx, vy, w, T) {
  const S = SPEC[T.c] || SPEC[0], hl = T.len / 2, hw = T.wid / 2;
  return { x, y, a, vx, vy, w, hl, hw, m: S.m, im: 1 / S.m, iI: 12 / (S.m * (T.len ** 2 + T.wid ** 2)), muL: S.muL, muS: S.muS, bike: T.c === 2 };
}

const axes = b => { const c = Math.cos(b.a), s = Math.sin(b.a); return [c, s, -s, c]; }; // forward (fx,fy), right (rx,ry)
function corners(b) {
  const [fx, fy, rx, ry] = axes(b), out = [];
  for (const [i, j] of [[1, 1], [1, -1], [-1, -1], [-1, 1]]) out.push([b.x + fx * b.hl * i + rx * b.hw * j, b.y + fy * b.hl * i + ry * b.hw * j]);
  return out;
}
const inside = (b, p) => {
  const [fx, fy, rx, ry] = axes(b), dx = p[0] - b.x, dy = p[1] - b.y;
  return Math.abs(dx * fx + dy * fy) <= b.hl + 0.02 && Math.abs(dx * rx + dy * ry) <= b.hw + 0.02;
};

// SAT between two boxes. returns { nx, ny (from A to B), depth, px, py (contact point) } or null
function contact(A, B) {
  if (Math.abs(A.x - B.x) > A.hl + B.hl + 1 || Math.abs(A.y - B.y) > A.hl + B.hl + 1) return null;
  const CA = corners(A), CB = corners(B), [a1, a2, a3, a4] = axes(A), [b1, b2, b3, b4] = axes(B);
  let depth = Infinity, nx = 0, ny = 0;
  for (const [ax, ay] of [[a1, a2], [a3, a4], [b1, b2], [b3, b4]]) {
    let mnA = Infinity, mxA = -Infinity, mnB = Infinity, mxB = -Infinity;
    for (const p of CA) { const d = p[0] * ax + p[1] * ay; mnA = Math.min(mnA, d); mxA = Math.max(mxA, d); }
    for (const p of CB) { const d = p[0] * ax + p[1] * ay; mnB = Math.min(mnB, d); mxB = Math.max(mxB, d); }
    const ov = Math.min(mxA, mxB) - Math.max(mnA, mnB);
    if (ov <= 0) return null;
    if (ov < depth) { depth = ov; nx = ax; ny = ay; }
  }
  if ((B.x - A.x) * nx + (B.y - A.y) * ny < 0) { nx = -nx; ny = -ny; }
  // contact point: B's corners poking into A and A's corners poking into B, averaged
  let px = 0, py = 0, k = 0;
  for (const p of CB) if (inside(A, p)) { px += p[0]; py += p[1]; k++; }
  for (const p of CA) if (inside(B, p)) { px += p[0]; py += p[1]; k++; }
  if (!k) { px = (A.x + B.x) / 2; py = (A.y + B.y) / 2; } else { px /= k; py /= k; }
  return { nx, ny, depth, px, py };
}

// impulse between A and B at contact c (normal A->B). either may be static (im = iI = 0). e = bounce, mu = metal-on-metal
function resolve(A, B, c, e = 0.2, mu = 0.4, correct = true) {
  const rax = c.px - A.x, ray = c.py - A.y, rbx = c.px - B.x, rby = c.py - B.y;
  const vax = A.vx - A.w * ray, vay = A.vy + A.w * rax, vbx = B.vx - B.w * rby, vby = B.vy + B.w * rbx;
  const rvx = vbx - vax, rvy = vby - vay, vn = rvx * c.nx + rvy * c.ny;
  if (vn < 0) {
    const ran = rax * c.ny - ray * c.nx, rbn = rbx * c.ny - rby * c.nx;
    const j = -(1 + (vn < -1 ? e : 0)) * vn / (A.im + B.im + ran * ran * A.iI + rbn * rbn * B.iI);
    apply(A, -j * c.nx, -j * c.ny, rax, ray); apply(B, j * c.nx, j * c.ny, rbx, rby);
    // friction along the contact
    let tx = rvx - vn * c.nx, ty = rvy - vn * c.ny; const tl = Math.hypot(tx, ty);
    if (tl > 1e-4) {
      tx /= tl; ty /= tl;
      const rat = rax * ty - ray * tx, rbt = rbx * ty - rby * tx;
      const jt = Math.max(-mu * j, Math.min(mu * j, -tl / (A.im + B.im + rat * rat * A.iI + rbt * rbt * B.iI)));
      apply(A, -jt * tx, -jt * ty, rax, ray); apply(B, jt * tx, jt * ty, rbx, rby);
    }
  }
  if (correct && A.im + B.im > 0) { // push apart out of the overlap, by inverse mass (heavy one barely moves)
    const k = Math.max(c.depth - 0.01, 0) * 0.8 / (A.im + B.im);
    A.x -= c.nx * k * A.im; A.y -= c.ny * k * A.im; B.x += c.nx * k * B.im; B.y += c.ny * k * B.im;
  }
  return vn;
}
function apply(b, jx, jy, rx, ry) {
  if (!b.im) return;
  b.vx += jx * b.im; b.vy += jy * b.im; b.w += (rx * jy - ry * jx) * b.iI;
}

// tyres: coulomb friction along and across the body, and against spinning. a knocked-over bike slides on its side
function tyres(b, dt, offroad) {
  const [fx, fy, rx, ry] = axes(b), k = offroad ? 1.3 : 1;
  const muL = (b.down ? 0.55 : b.muL) * k, muS = (b.down ? 0.55 : b.muS) * k;
  let u = b.vx * fx + b.vy * fy, s = b.vx * rx + b.vy * ry;
  const du = muL * G * dt, ds = muS * G * dt;
  u = Math.abs(u) <= du ? 0 : u - Math.sign(u) * du;
  s = Math.abs(s) <= ds ? 0 : s - Math.sign(s) * ds;
  b.vx = fx * u + rx * s; b.vy = fy * u + ry * s;
  // spinning drags all four tyres sideways: torque ~ mu m g * (half length / 2)
  const dw = muS * G * (b.hl / 2) * b.m * b.iI * dt;
  b.w = Math.abs(b.w) <= dw ? 0 : b.w - Math.sign(b.w) * dw;
}

// walls: half-planes at lateral wr (+ side) and wl (- side). corners past them get pushed back with a static-body impulse
const WALL = { im: 0, iI: 0, vx: 0, vy: 0, w: 0, x: 0, y: 0 };
function walls(b, wl, wr) {
  for (const [lim, sgn] of [[wr, 1], [wl, -1]]) {
    if (!lim) continue;
    let worst = 0, px = 0, py = 0;
    for (const p of corners(b)) { const d = (p[1] - lim) * sgn; if (d > worst) { worst = d; px = p[0]; py = p[1]; } }
    if (worst > 0) { WALL.x = px; WALL.y = py + sgn * 1; resolve(WALL, b, { nx: 0, ny: -sgn, depth: worst, px, py }, 0.15, 0.5); }
  }
}

// advance a set of bodies. each body: { ...body, wl, wr, offroad(y) }. pairs found by sorting along x
function step(bodies, dt, minSub = 3, edge = 6) {
  // substeps so nothing moves more than ~15cm per step (no tunnelling through a thin bike), capped for cost
  let vmax = 0;
  for (const b of bodies) vmax = Math.max(vmax, Math.hypot(b.vx, b.vy) + Math.abs(b.w) * b.hl);
  const sub = Math.min(30, Math.max(minSub, Math.ceil(vmax * dt / 0.15))), h = dt / sub;
  for (let k = 0; k < sub; k++) {
    for (const b of bodies) {
      tyres(b, h, Math.abs(b.y) > edge - 2);
      b.x += b.vx * h; b.y += b.vy * h; b.a += b.w * h;
    }
    bodies.sort((p, q) => p.x - q.x);
    for (let i = 0; i < bodies.length; i++)
      for (let j = i + 1; j < bodies.length && bodies[j].x - bodies[i].x < 14; j++) {
        const c = contact(bodies[i], bodies[j]);
        if (c) { const vn = resolve(bodies[i], bodies[j], c); if (bodies[i].onHit) bodies[i].onHit(bodies[j], -vn); if (bodies[j].onHit) bodies[j].onHit(bodies[i], -vn); }
      }
    for (const b of bodies) walls(b, b.wl || -edge, b.wr || edge);
  }
}

module.exports = { body, contact, resolve, step, mass, SPEC };
