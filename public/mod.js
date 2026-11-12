(() => {
  'use strict';
  // bump MOD_VERSION on every push to server/public/mod.js; bump NEEDS_LOADER only if loader.js/manifest changed
  const MOD_VERSION = 15;
  const NEEDS_LOADER = 1;
  if (window.__srmpRan) return; // newer cached copy already running
  window.__srmpRan = MOD_VERSION;
  const SERVER = window.SRMP_SERVER;

  const PROTO = 3;
  const CARS = ['coupe', 'coach', 'bike', 'drift'];
  const PICK = [['coupe', 'Coupe'], ['coach', 'Coach'], ['bike', 'Bike']]; // index = game's setVehicle index
  const DELAY = 100, EXTRAP = 250, CULL2 = 1500 ** 2, TAG_DIST = 800, REC = 29;
  const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const hashWorld = () => location.hash.slice(1).split('@')[0];

  // runs before the game reads the url: drop straight into the server's last known world, so joining never reloads
  if (localStorage.srmpWorld && hashWorld() !== localStorage.srmpWorld)
    history.replaceState(null, '', location.pathname + '#' + localStorage.srmpWorld + '@0');
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const until = async (fn, ms) => { for (const end = Date.now() + ms; Date.now() < end; await wait(100)) if (fn()) return true; return false; };

  let joined = false, applying = false, settingsHooked = false;
  let car, cam, canvas, rect, ws, me, env, carSel = 'coupe', retry = 2000, kicked = false, wakeTries = 0;
  let tagsEl, statusEl, nameIn, overlay;
  const scenes = [], ghosts = new Map(), models = {}, locks = {}, insts = new Set();
  const V = {}; // scratch vectors, made once the game's Vector3/Quaternion classes are known

  // ================= settings lock =================
  // every game setting is an instance of one class; its constructor for-in's over _defaults,
  // so an enumerable accessor on Object.prototype fires once with `this` = the first instance.
  // we grab its prototype, remove the probe, and wrap set/load so locked values can't change.
  const isTuning = s => s._defaults && ('steerAssist' in s._defaults || 'tyreFriction' in s._defaults);
  const blocked = (s, k, v) => joined && !applying && (isTuning(s) || (locks[s._type] && k in locks[s._type] && locks[s._type][k] !== v));

  const patch = inst => {
    let p = inst;
    while (p && !hasOwn(p, 'setMany')) p = Object.getPrototypeOf(p);
    if (!p) return;
    const { set, load, addListener } = p;
    p.set = function (k, v, ...r) { insts.add(this); if (!blocked(this, k, v)) return set.call(this, k, v, ...r); };
    p.load = function (e, ...r) {
      insts.add(this);
      if (e && joined && !applying) { e = { ...e }; for (const k in e) if (blocked(this, k, e[k])) delete e[k]; }
      return load.call(this, e, ...r);
    };
    p.addListener = function (...a) { insts.add(this); return addListener.apply(this, a); };
    insts.add(inst);
    settingsHooked = true;
  };
  Object.defineProperty(Object.prototype, '__srmp', {
    enumerable: true, configurable: true, get() {},
    set() { if (hasOwn(this, '_listeners') && hasOwn(this, '_defaults')) { delete Object.prototype.__srmp; patch(this); } }
  });
  addEventListener('load', () => delete Object.prototype.__srmp);

  const setLocks = () => {
    Object.assign(locks, {
      Hills: { season: env.season, time: env.time, weather: env.weather },
      OffWorld: { location: env.location, time: env.time === 'night' ? 'night' : 'day' },
      Woods: { time: env.time },
      Vehicle: { speedFactor: 1 }
    });
  };
  const enforce = () => {
    applying = true;
    for (const s of insts) {
      const L = locks[s._type];
      if (L) for (const k in L) if (s[k] !== L[k]) s.set(k, L[k]);
    }
    applying = false;
  };
  const lockWorld = () => {
    for (const s of insts) {
      if (s._type === 'World') locks.World = { seed: s.seed, scene: s.scene, roadStyle: s.roadStyle };
      if (s._type === 'Scene') locks.Scene = { scene: s.scene };
      if (isTuning(s)) { applying = true; s.resetToDefault(); applying = false; }
    }
  };
  const worldOk = () => hashWorld() === env.world;
  const gotoWorld = () => {
    localStorage.srmpWorld = env.world;
    sessionStorage.srmpAuto = 1;
    if (ws) ws.onclose = null;
    location.hash = env.world + '@0';
    location.reload();
  };

  // ================= three.js hook =================
  const dt = window.__THREE_DEVTOOLS__ ||= new EventTarget();
  dt.addEventListener('observe', ({ detail: d }) => {
    if (d.isScene) return scenes.push(d);
    if (!d.isWebGLRenderer) return;
    const render = d.render;
    d.render = function (s, c) {
      if (!car?.parent) car = findCar();
      const main = car && s === car.parent;
      let tilted = false;
      if (main) { pre(); tilted = tiltCam(c); }
      render.call(this, s, c);
      if (main) {
        cam = c; canvas = d.domElement; post();
        if (tilted) { c.position.copy(V.sp); c.quaternion.copy(V.sq); c.updateMatrixWorld(); }
      }
    };
  });

  // ---- camera tilt: the game already orbits sideways on left-drag; vertical drag (mouse or touch) now tilts too.
  // touch drags also orbit sideways. applied only for the frame's render, then undone, so the game's camera smoothing never sees it
  let tilt = 0, tiltT = 0, yawT = 0, yaw = 0, drag = null, lastF = performance.now();
  const onCanvas = e => e.target?.tagName === 'CANVAS' && e.target !== MM.big; // not while dragging the full map
  addEventListener('pointerdown', e => {
    if (overlay || !onCanvas(e) || (e.pointerType === 'mouse' && e.button !== 0)) return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, touch: e.pointerType !== 'mouse' };
  }, true);
  addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.id) return;
    tiltT = Math.max(-0.3, Math.min(1.1, tiltT + (e.clientY - drag.y) * 0.004));
    if (drag.touch) yawT -= (e.clientX - drag.x) * 0.006;
    drag.x = e.clientX; drag.y = e.clientY;
  }, true);
  for (const ev of ['pointerup', 'pointercancel']) addEventListener(ev, e => { if (drag?.id === e.pointerId) drag = null; }, true);

  const tiltCam = c => {
    const now = performance.now(), dt = Math.min((now - lastF) / 1000, 0.1);
    lastF = now;
    if (!drag) { tiltT *= Math.exp(-dt * 1.5); yawT *= Math.exp(-dt * 1.5); } // ease back once you let go
    const k = 1 - Math.exp(-dt * 12);
    tilt += (tiltT - tilt) * k; yaw += (yawT - yaw) * k;
    if (Math.abs(tilt) < 0.002 && Math.abs(yaw) < 0.002) return false;
    if (!V.sp) { V.sp = c.position.clone(); V.sq = c.quaternion.clone(); V.pv = c.position.clone(); V.of = c.position.clone(); V.ax = c.position.clone(); V.rq = c.quaternion.clone(); V.yq = c.quaternion.clone(); V.pq = c.quaternion.clone(); }
    V.sp.copy(c.position); V.sq.copy(c.quaternion);
    c.updateMatrixWorld();
    const piv = V.pv.copy(car.position); piv.y += 1;
    const off = V.of.copy(c.getWorldPosition(V.ax)).sub(piv), r = off.length();
    V.yq.setFromAxisAngle(V.ax.set(0, 1, 0), yaw);
    if (r < 1.5) { // interior camera: look around instead of orbiting
      off.copy(V.ax.set(0, 0, -1).applyQuaternion(c.getWorldQuaternion(V.rq)));
      V.ax.set(off.z, 0, -off.x).normalize();
      V.rq.setFromAxisAngle(V.ax, tilt).premultiply(V.yq);
    } else {
      const e0 = Math.asin(Math.max(-1, Math.min(1, off.y / r)));
      const e1 = Math.max(-0.15, Math.min(1.35, e0 + tilt));
      V.ax.set(-off.z, 0, off.x);
      if (V.ax.lengthSq() < 1e-8) return false;
      V.ax.normalize();
      V.rq.setFromAxisAngle(V.ax, e1 - e0).premultiply(V.yq);
      off.applyQuaternion(V.rq).add(piv);
      if (c.parent) c.parent.worldToLocal(off);
      c.position.copy(off);
    }
    if (c.parent) { c.parent.getWorldQuaternion(V.pq); V.rq.premultiply(V.pq.clone().invert()).multiply(V.pq); }
    c.quaternion.premultiply(V.rq);
    c.updateMatrixWorld();
    return true;
  };
  addEventListener('resize', () => rect = null);

  const findCar = () => {
    for (const s of scenes) for (const c of s.children) if (c.velocity && c.controller && c.setVehicle && c.container) return c;
  };
  const isReady = () => car?.parent && car.hasInit && !car.isLoading;
  const O3D = () => { let p = Object.getPrototypeOf(car); while (!hasOwn(p, 'traverse')) p = Object.getPrototypeOf(p); return p.constructor; };

  // ghost model: deep copy of the local car minus interior/dash/steering/lights, frozen matrices, plus its footprint
  const snap = () => {
    if (!isReady() || models[car.type]) return;
    const m = car.container.clone(true);
    m.position.set(0, 0, 0); m.quaternion.identity(); m.scale.set(1, 1, 1);
    const drop = [];
    m.traverse(o => (o.isLight || (o.isMesh && /interior|dash|steer/i.test(o.name))) && drop.push(o));
    drop.forEach(o => o.removeFromParent());
    m.updateMatrixWorld(true);
    const v = car.position.clone(), pts = [], ys = [];
    m.traverse(o => {
      o.matrixAutoUpdate = false;
      if (!o.isMesh) return;
      o.geometry = o.geometry.clone();
      // materials are shared with the game, NOT cloned: a clone loses slowroads' shader patch (onBeforeCompile), which is what
      // darkens tyres/underbodies, so they'd render neon white. sharing was verified to render correctly with instancing
      // (if the game disposes them on a vehicle swap, three.js just re-uploads them on next use)
      // hitbox = the solid body only: shadows and light/glow meshes (headlight beams etc.) reach well past the car
      if (/shadow|light|lamp|glow|flare|beam|indicator|window/i.test(o.name)) return;
      const pos = o.geometry.attributes.position, step = Math.max(1, Math.floor(pos.count / 1500));
      for (let i = 0; i < pos.count; i += step) { v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld); pts.push([v.x, v.z]); ys.push(v.y); }
    });
    // footprint = 2D convex hull of the real mesh (seen from above), simplified to <=16 corners: a coupe's rounded nose,
    // a bus's long box, a bike's thin sliver. ys give its height range
    let hull = pts.length > 2 ? convexHull(pts) : [[-1, -0.8], [3, -0.8], [3, 0.8], [-1, 0.8]];
    while (hull.length > 16) { // drop the corner that changes the shape least
      let best = 0, bestA = Infinity;
      for (let i = 0; i < hull.length; i++) {
        const a = hull[(i + hull.length - 1) % hull.length], b = hull[i], c = hull[(i + 1) % hull.length];
        const area = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]));
        if (area < bestA) { bestA = area; best = i; }
      }
      hull.splice(best, 1);
    }
    const xs = hull.map(p => p[0]), zs = hull.map(p => p[1]);
    const mnx = Math.min(...xs), mxx = Math.max(...xs), mnz = Math.min(...zs), mxz = Math.max(...zs);
    const ymax = ys.length ? Math.max(...ys) : 1.3;
    models[car.type] = { m, hull, cx: (mnx + mxx) / 2, cz: (mnz + mxz) / 2, hx: (mxx - mnx) / 2, hz: (mxz - mnz) / 2, h: ymax };
  };
  // monotone-chain convex hull of [x,z] points, counter-clockwise
  const convexHull = P => {
    P = P.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [], hi = [];
    for (const p of P) { while (lo.length > 1 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
    for (let i = P.length - 1; i >= 0; i--) { const p = P[i]; while (hi.length > 1 && cross(hi[hi.length - 2], hi[hi.length - 1], p) <= 0) hi.pop(); hi.push(p); }
    lo.pop(); hi.pop();
    return lo.concat(hi);
  };
  const modelFor = t => models[t] || models.coupe || Object.values(models)[0];

  // ================= ghosts =================
  const addPlayer = p => {
    if (ghosts.has(p.id) || (me && p.id === me.id)) return;
    const tag = tagsEl.appendChild(document.createElement('div'));
    tag.className = 'srmp-tag';
    tag.textContent = p.name;
    tag.style.display = 'none';
    ghosts.set(p.id, { pose: {}, name: p.name, type: CARS[p.c] || 'coupe', tag, buf: [], pool: [], last: 0, shown: false, tx: 0, ty: 0, op: 0 });
  };
  const removePlayer = id => {
    const g = ghosts.get(id);
    if (!g) return;
    g.root?.removeFromParent();
    g.tag.remove();
    ghosts.delete(id);
  };
  const clearGhosts = () => [...ghosts.keys()].forEach(removePlayer);

  // server-clock sync: offset = smallest (local - server) seen, re-measured every 5s
  let off = Infinity, winMin = Infinity, winStart = 0;
  const syncClock = (now, st) => {
    const o0 = now - st;
    if (o0 < off) off = o0;
    if (o0 < winMin) winMin = o0;
    if (now - winStart > 5000) { off = winMin; winMin = Infinity; winStart = now; }
  };
  const onTick = dv => {
    const now = performance.now(), st = dv.getUint32(1, true), n = dv.getUint16(5, true);
    syncClock(now, st);
    for (let i = 0, o = 7; i < n; i++, o += REC) {
      const g = ghosts.get(dv.getUint16(o, true));
      if (!g) continue;
      const s = g.buf.length >= 8 ? g.buf.shift() : (g.pool.pop() || { p: [0, 0, 0], q: [0, 0, 0, 1], v: [0, 0, 0] });
      s.t = st;
      s.p[0] = dv.getFloat32(o + 2, true); s.p[1] = dv.getFloat32(o + 6, true); s.p[2] = dv.getFloat32(o + 10, true);
      let qx = dv.getInt16(o + 14, true), qy = dv.getInt16(o + 16, true), qz = dv.getInt16(o + 18, true), qw = dv.getInt16(o + 20, true);
      const ql = Math.hypot(qx, qy, qz, qw) || 1;
      s.q[0] = qx / ql; s.q[1] = qy / ql; s.q[2] = qz / ql; s.q[3] = qw / ql;
      s.v[0] = dv.getInt16(o + 22, true) / 100; s.v[1] = dv.getInt16(o + 24, true) / 100; s.v[2] = dv.getInt16(o + 26, true) / 100;
      g.type = CARS[dv.getUint8(o + 28)] || 'coupe';
      if (g.buf.length && st <= g.buf[g.buf.length - 1].t) { g.pool.push(s); continue; } // out of order
      g.buf.push(s);
      g.last = now;
    }
  };

  // cubic hermite between snapshots using their velocities, extrapolate briefly past the newest
  const sample = (g, rt) => {
    const b = g.buf, P = g.root.position;
    let k = b.length - 1;
    if (rt >= b[k].t) {
      const s = b[k], e = Math.min(rt - s.t, EXTRAP) / 1000;
      P.set(s.p[0] + s.v[0] * e, s.p[1] + s.v[1] * e, s.p[2] + s.v[2] * e);
      g.root.quaternion.fromArray(s.q);
      g.vel = s.v;
      return;
    }
    while (k > 0 && b[k - 1].t > rt) k--;
    if (k === 0) { P.fromArray(b[0].p); g.root.quaternion.fromArray(b[0].q); g.vel = b[0].v; return; }
    const a = b[k - 1], c = b[k], u = (rt - a.t) / (c.t - a.t), T = (c.t - a.t) / 1000;
    const jump = (a.p[0] - c.p[0]) ** 2 + (a.p[1] - c.p[1]) ** 2 + (a.p[2] - c.p[2]) ** 2 > 3600;
    if (jump) { const s = u < 0.5 ? a : c; P.fromArray(s.p); g.root.quaternion.fromArray(s.q); g.vel = s.v; return; }
    const u2 = u * u, u3 = u2 * u, h00 = 2 * u3 - 3 * u2 + 1, h10 = (u3 - 2 * u2 + u) * T, h01 = -2 * u3 + 3 * u2, h11 = (u3 - u2) * T;
    P.set(
      h00 * a.p[0] + h10 * a.v[0] + h01 * c.p[0] + h11 * c.v[0],
      h00 * a.p[1] + h10 * a.v[1] + h01 * c.p[1] + h11 * c.v[1],
      h00 * a.p[2] + h10 * a.v[2] + h01 * c.p[2] + h11 * c.v[2]
    );
    g.root.quaternion.copy(V.qa.fromArray(a.q).slerp(V.qb.fromArray(c.q), u));
    g.vel = u < 0.5 ? a.v : c.v;
  };

  // pose = where a car sits on the ground plane: position + its local X (forward) and Z (side) axes, plus its model
  const poseFromQuat = (pos, quat, M, o) => {
    V.t.set(1, 0, 0).applyQuaternion(quat); o.ax = V.t.x; o.az = V.t.z;
    V.t.set(0, 0, 1).applyQuaternion(quat); o.bx = V.t.x; o.bz = V.t.z;
    o.x = pos.x; o.y = pos.y; o.z = pos.z; o.M = M;
    return o;
  };
  // its real footprint (hull of the mesh) placed in the world
  const worldPoly = (P, out) => {
    const h = P.M.hull;
    out.length = h.length;
    for (let i = 0; i < h.length; i++) {
      const p = h[i], q = out[i] || (out[i] = [0, 0]);
      q[0] = P.x + P.ax * p[0] + P.bx * p[1]; q[1] = P.z + P.az * p[0] + P.bz * p[1];
    }
    return out;
  };

  // crash feedback on the first frame of a contact: the game's own impact sound, and tell the server we hit an NPC
  const onImpact = (g, cv, x, y, z) => {
    if (cv < 2) return;
    const C = car.controller;
    C.collisionStrength = Math.max(C.collisionStrength || 0, Math.min(1, cv / 15));
    C.collisionPos?.set?.(x, y + 0.5, z);
  };
  // rough masses (a coupe = 1): a coach shrugs you off, a bike gets launched
  const MASS = { coupe: 1300, coach: 12000, bike: 330 }; // kg, bike includes the rider. same numbers as the server's engine
  // contact with an NPC: we show the shove straight away (prediction), and send the server the contact itself (where on
  // the NPC, which way, how fast we were going). the server's rigid-body engine works out the real result (mass, spin,
  // tyre grip) and that's what everyone sees a moment later
  const sendPush = (N, first, now, c) => {
    const dvx = N.pdx || 0, dvz = N.pdz || 0, sp = N.pspin || 0;
    N.pdx = N.pdz = N.pspin = 0; N.lastPush = now;
    // keep our prediction until the server confirms it has applied this hit (op 9). a fixed timer isn't enough: the
    // round trip to the server can be 300ms+, and a stale update from before the hit would snap the car back
    N.pending = (N.pending || 0) + 1; N.hold = now + 2500;
    if (!roadPoint(N.rs, N.rlat)) return;
    const R = (x, z) => [x * RP.fx + z * RP.fz, x * RP.nx + z * RP.nz]; // world xz -> road (along s, lateral)
    const [dvs, dvl] = R(dvx, dvz);
    const srvNow = performance.now() - off;
    N.s = N.rs; N.lat = N.rlat; N.t = srvNow; N.vs += dvs; N.vl = Math.max(-15, Math.min(15, N.vl + dvl));
    if (first && Math.hypot(dvs, dvl) > (N.type === 'bike' ? 2.5 : 4)) { N.wreck = true; N.tyaw = N.ryaw + sp * Math.PI / 180; }
    const [cs, cl] = R(c.px - c.ox, c.pz - c.oz), [ns, nl] = R(c.nx, c.nz), [pvs, pvl] = R(c.vx, c.vz), f = v => +v.toFixed(2);
    if (ws?.readyState === 1) ws.send(JSON.stringify({ t: 'hit', id: N.id, cs: f(cs), cl: f(cl), ns: f(ns), nl: f(nl), pvs: f(pvs), pvl: f(pvl), wl: N.wl, wr: N.wr }));
  };

  // our car's physics state, for both kinds of vehicle in slowroads:
  //   cars: a chassis with chassisVel (+ chassisPComPos etc.)
  //   bikes: NO chassis velocity at all - two wheels integrated verlet-style, velocity = (worldPos - pWorldPos) / pdT
  // nudge() moves the car without touching its speed: every position the physics keeps shifts together, so the solver's
  // position->velocity maths sees no motion. addVel() changes its speed. both verified live in slowroads (car + bike)
  const isBikeCtl = C => !C.chassisVel && C.wheels?.length;
  const nudge = (dx, dz) => {
    const C = car.controller, add = v => { if (v?.isVector3) { v.x += dx; v.z += dz; } };
    add(car.position); add(car.pPosition); add(car.com);
    add(C.comPos); add(C.comPosLerped); add(C.chassisPComPos); add(C.chassisCandidatePos); add(C.chassisCandidateComPos);
    if (C.wheels) for (const w of C.wheels) { add(w.worldPos); add(w.pWorldPos); add(w.contactPoint); if (isBikeCtl(C)) { add(w.groundPoint); add(w.tPos); } }
  };
  const addVel = (dx, dz) => {
    const C = car.controller;
    if (C.chassisVel) { C.chassisVel.x += dx; C.chassisVel.z += dz; return; }
    const dt = C.pdT || 1 / 60;
    for (const w of C.wheels) { w.pWorldPos.x -= dx * dt; w.pWorldPos.z -= dz * dt; }
  };
  const myVel = () => car.controller.chassisVel || car.velocity;

  // ---- collisions: solid bodies ----
  // footprints are the convex hulls of the actual meshes. when they overlap (SAT) we
  //   1. push our car straight back out of the overlap by moving its position (solid: no sinking in, and no speed added)
  //   2. remove only the speed we're driving INTO them with (inelastic, no bounce): a hit stops you or carries you along
  //   3. bleed a little speed when scraping, add a little spin for off-centre hits
  // NPCs are server-driven and solid, so we resolve all of it; vs a player each side resolves half (their client does theirs)
  const PA = [], PB = [], ME = {};
  const collide = g => {
    const MA = models[car.type], C = car.controller, P2 = g.pose;
    if (!MA || !P2?.M || !C || !(C.chassisVel || C.wheels?.length) || car.isAirborne) { g.contact = false; return; }
    const P1 = poseFromQuat(car.position, car.quaternion, MA, ME);
    if (Math.abs(P1.y - P2.y) > Math.max(MA.h, P2.M.h) + 0.3) { g.contact = false; return; }
    const A = worldPoly(P1, PA), B = worldPoly(P2, PB);
    let depth = Infinity, nx = 0, nz = 0;
    for (const poly of [A, B]) {
      for (let i = 0; i < poly.length; i++) {
        const p = poly[i], q = poly[(i + 1) % poly.length];
        let ax = q[1] - p[1], az = p[0] - q[0];
        const l = Math.hypot(ax, az); if (l < 1e-6) continue; ax /= l; az /= l;
        let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
        for (const r of A) { const d = r[0] * ax + r[1] * az; if (d < a0) a0 = d; if (d > a1) a1 = d; }
        for (const r of B) { const d = r[0] * ax + r[1] * az; if (d < b0) b0 = d; if (d > b1) b1 = d; }
        const ov = Math.min(a1, b1) - Math.max(a0, b0);
        if (ov <= 0) { g.contact = false; return; }
        if (ov < depth) { depth = ov; nx = ax; nz = az; }
      }
    }
    // normal points from them to us
    let cAx = 0, cAz = 0, cBx = 0, cBz = 0;
    for (const r of A) { cAx += r[0]; cAz += r[1]; } for (const r of B) { cBx += r[0]; cBz += r[1]; }
    cAx /= A.length; cAz /= A.length; cBx /= B.length; cBz /= B.length;
    if ((cAx - cBx) * nx + (cAz - cBz) * nz < 0) { nx = -nx; nz = -nz; }

    const v = myVel(), gv = g.vel || [0, 0, 0], bike = car.type === 'bike' || isBikeCtl(C);
    // momentum: vs an NPC we keep m_them/(m_us+m_them) of the hit and they take the rest. vs a player each side does half
    const mMe = MASS[car.type] || 1, mThem = MASS[g.type] || 1;
    const share = g.isNpc ? mThem / (mMe + mThem) : 0.5;
    const rx = v.x - gv[0], rz = v.z - gv[2], vr = rx * nx + rz * nz; // vr < 0: closing
    const now = performance.now();
    if (!g.contact) { g.contact = true; g.spun = 0; g.used = 0; g.cv = Math.max(0, -vr); g.hitV = g.cv; g.first = true; onImpact(g, g.cv, (cAx + cBx) / 2, P1.y, (cAz + cBz) / 2); }

    // 1. solid: step out of the overlap (deep overlaps from spawns/teleports resolve over a few frames, not one jump).
    // NPCs only move when the server says so, so we always take the whole positional fix ourselves
    const push = Math.min(depth * (g.isNpc ? 1 : 0.5) + 0.005, 0.5);
    nudge(nx * push, nz * push);

    // 2. inelastic: cancel our share of the closing speed (vs a player: our fair half of the hit in total)
    let j = vr < 0 ? -vr * share * (g.first ? 1.2 : 1) : 0, jN = 0;
    if (!g.isNpc && j > 0) { const left = g.cv * share + 0.5 - g.used; j = Math.min(j, Math.max(left, 0.3)); g.used += j; }
    if (g.isNpc && vr < 0) {
      // their tyres grip the road: a parked/wrecked car is braked (~0.7g), a driving one rolls (~0.15g). the ground soaks up
      // that much per frame, so slow pushes barely move them and you have to really shove. on impact it's negligible
      const al = Math.abs(nx * P2.ax + nz * P2.az) / (Math.hypot(P2.ax, P2.az) || 1); // 1 = pushing along the car, 0 = sideways
      const u = -vr * (g.first ? 1.2 : 1), fdt = (g.wreck ? 7 : Math.abs(g.vs) < 1 ? 7 : 1.5 * al * al + 8 * (1 - al * al)) * (C.pdT || 1 / 60);
      j = (u + fdt) * share; jN = j * mMe / mThem - fdt;
      if (jN < 0) { jN = 0; j = -vr; } // didn't budge: it's a wall this frame
    }
    let ix = nx * j, iz = nz * j;
    // 3. scraping friction
    const tx = rx - nx * vr, tz = rz - nz * vr;
    ix -= tx * 0.04 * share; iz -= tz * 0.04 * share;
    if (g.isNpc && (ix || iz)) {
      // equal and opposite: whatever we lost they gain, scaled by mass (lighter one moves more)
      const k = -mMe / mThem, tfx = (ix - nx * j) * k, tfz = (iz - nz * j) * k; // scrape part, then the normal push
      g.pdx = (g.pdx || 0) - nx * jN + tfx; g.pdz = (g.pdz || 0) - nz * jN + tfz;
      // off-centre hits spin them: torque about their centre from where we hit, + = anticlockwise (their yaw sign)
      const ox = (cAx + cBx) / 2 - P2.x, oz = (cAz + cBz) / 2 - P2.z;
      const Ib = (P2.M.hx * P2.M.hx + P2.M.hz * P2.M.hz) / 3;
      const px = -nx * jN + tfx, pz = -nz * jN + tfz;
      g.pspin = Math.max(-80, Math.min(80, (g.pspin || 0) + (oz * px - ox * pz) / Ib * 57.3 * 0.6));
      if (g.first || (now - (g.lastPush || 0) > 150 && vr < -0.2)) {
        // contact point, the push direction onto them (= -our normal), and our velocity before this frame's response
        sendPush(g, g.first, now, { px: (cAx + cBx) / 2, pz: (cAz + cBz) / 2, ox: P2.x + P2.ax * P2.M.cx + P2.bx * P2.M.cz, oz: P2.z + P2.az * P2.M.cx + P2.bz * P2.M.cz, nx: -nx, nz: -nz, vx: v.x, vz: v.z });
        g.first = false;
      }
    }
    addVel(ix, iz);
    g.first = false;
    // a little spin from off-centre hits (cars only), capped per contact
    if (!bike && C.chassisRotVel && j > 0.5 && g.spun < 0.6) {
      const ox = (cBx - cAx) / 2, oz = (cBz - cAz) / 2, I = (MA.hx * MA.hx + MA.hz * MA.hz) / 3;
      const dw = Math.max(-0.3, Math.min(0.3, (oz * ix - ox * iz) / I * 0.35));
      C.chassisRotVel.y += dw; g.spun += Math.abs(dw);
    }
  };

  // ================= road =================
  // the road is a linked list of nodes exactly 10m apart: {i, p (centre, Vector3), n {x,z} (unit normal), next, prev}.
  // the autodriver always holds some of them, which is our way in. distance along the road: s = i * 10.
  // every client builds the same road from the seed, so (s, lateral offset) means the same spot for everyone.
  const NODE = 10;
  const road = { by: new Map(), at: -1e9, near: null };
  const roadRef = () => {
    const ad = car?.controller?.autodriver;
    return ad && (ad.midlineLookup?.n || ad.targetNode || ad.speedAnnotationNode || ad.bridgeLookaheadNode);
  };
  const refreshRoad = now => {
    if (now - road.at < 1500) return road.by.size > 0;
    road.at = now;
    // the autodriver holds several nodes; one can be a node the game already trimmed off (dead end), so walk from each
    // and keep the longest live list
    const ad = car?.controller?.autodriver;
    const refs = ad ? [ad.midlineLookup?.n, ad.targetNode, ad.speedAnnotationNode, ad.bridgeLookaheadNode, road.near] : [];
    let best = null, bestLen = 0;
    for (const r of refs) {
      if (!r?.p) continue;
      let a = r, k = 0;
      while (a.prev && k++ < 20000) a = a.prev;
      let len = 0;
      for (let x = a; x && len < 20000; x = x.next) len++;
      if (len > bestLen) { bestLen = len; best = a; }
    }
    if (!best) return road.by.size > 0;
    road.by.clear();
    for (let x = best; x && road.by.size < 20000; x = x.next) {
      road.by.set(x.i, x);
      // the game keeps smoothing fresh road near its head for a while, so live nodes always overwrite the history
      const h = roadHist.get(x.i);
      if (h) { h[0] = x.p.x; h[1] = x.p.z; }
      else { roadHist.set(x.i, [x.p.x, x.p.z]); if (x.i < histMin) histMin = x.i; if (x.i > histMax) histMax = x.i; }
    }
    return true;
  };
  // centre-line point + forward tangent at distance s (catmull-rom through the nodes), shifted sideways by lat
  const RP = { x: 0, y: 0, z: 0, fx: 1, fy: 0, fz: 0 };
  const roadPoint = (s, lat) => {
    const u = s / NODE, i = Math.floor(u), f = u - i;
    const b = road.by.get(i), c = road.by.get(i + 1);
    if (!b || !c) return false;
    const a = road.by.get(i - 1) || b, d = road.by.get(i + 2) || c;
    const f2 = f * f, f3 = f2 * f;
    const cr = (p0, p1, p2, p3) => 0.5 * (2 * p1 + (p2 - p0) * f + (2 * p0 - 5 * p1 + 4 * p2 - p3) * f2 + (3 * p1 - p0 - 3 * p2 + p3) * f3);
    const dr = (p0, p1, p2, p3) => 0.5 * ((p2 - p0) + 2 * (2 * p0 - 5 * p1 + 4 * p2 - p3) * f + 3 * (3 * p1 - p0 - 3 * p2 + p3) * f2);
    const ap = a.p, bp = b.p, cp = c.p, dp = d.p;
    let fx = dr(ap.x, bp.x, cp.x, dp.x), fy = dr(ap.y, bp.y, cp.y, dp.y), fz = dr(ap.z, bp.z, cp.z, dp.z);
    const fl = Math.hypot(fx, fy, fz) || 1;
    fx /= fl; fy /= fl; fz /= fl;
    const hl = Math.hypot(fx, fz) || 1, nx = -fz / hl, nz = fx / hl; // horizontal normal, same side as node.n
    const sideSign = (b.n.x * nx + b.n.z * nz) < 0 ? -1 : 1;
    RP.x = cr(ap.x, bp.x, cp.x, dp.x) + nx * lat * sideSign;
    RP.y = cr(ap.y, bp.y, cp.y, dp.y);
    RP.z = cr(ap.z, bp.z, cp.z, dp.z) + nz * lat * sideSign;
    RP.fx = fx; RP.fy = fy; RP.fz = fz; RP.nx = nx * sideSign; RP.nz = nz * sideSign;
    return true;
  };
  // where we are on the road: nearest node (walked from last time), then distance along + sideways offset
  const myRoad = () => {
    let n = road.near && road.by.get(road.near.i) === road.near ? road.near : roadRef();
    if (!n?.p) return null;
    const P = car.position, dist = x => (x.p.x - P.x) ** 2 + (x.p.z - P.z) ** 2;
    for (let k = 0; k < 400; k++) {
      const dn = n.next && dist(n.next) < dist(n) ? n.next : n.prev && dist(n.prev) < dist(n) ? n.prev : null;
      if (!dn) break;
      n = dn;
    }
    road.near = n;
    const m = n.next || n, dx = m.p.x - n.p.x, dz = m.p.z - n.p.z, l = Math.hypot(dx, dz) || 1;
    const rx = P.x - n.p.x, rz = P.z - n.p.z, lat = rx * n.n.x + rz * n.n.z;
    if (Math.abs(lat) > 40) return null;
    return { s: n.i * NODE + (rx * dx + rz * dz) / l, lat };
  };

  // ================= traffic =================
  // the server runs a 1D traffic sim along the road and sends (s, speed, lateral, type, colour) per NPC 5x/sec.
  // we predict between packets, place them on our copy of the road, and draw them all with InstancedMesh:
  // one draw call per car part per type, no matter how many NPCs. no nametags, so you can tell them from players.
  const npcs = new Map(), fleets = {};
  const PALETTE = [[1, 1, 1], [0.75, 0.77, 0.8], [0.22, 0.23, 0.26], [0.85, 0.16, 0.12], [0.18, 0.33, 0.75], [0.2, 0.5, 0.3], [0.95, 0.75, 0.2], [0.55, 0.15, 0.4]];
  const NPC_CULL2 = 1400 ** 2;
  let IM = null, M4 = null, imChecked = false, lastNpcF = performance.now();
  const findIM = () => {
    if (imChecked) return IM;
    imChecked = true;
    for (const s of scenes) s.traverse(o => { if (!IM && o.isInstancedMesh) IM = o.constructor; });
    M4 = car.matrix.constructor;
    return IM;
  };
  // op 8: per NPC 12 bytes: id u16, s f32, speed along road i16 (cm/s), lateral i8 (/35 m), lateral speed i8 (/20 m/s),
  // flags u8, yaw i8 (*1.5 deg). flags: bits 0-1 type, 2-4 colour, 5 braking, 6 wrecked, 7 drives toward -s
  const onTraffic = dv => {
    const now = performance.now(), st = dv.getUint32(1, true), n = dv.getUint16(5, true);
    syncClock(now, st);
    for (let i = 0, o = 7; i < n; i++, o += 12) {
      const id = dv.getUint16(o, true), s = dv.getFloat32(o + 2, true), vs = dv.getInt16(o + 6, true) / 100;
      const lat = dv.getInt8(o + 8) / 35, vl = dv.getInt8(o + 9) / 20, fl = dv.getUint8(o + 10), yaw = dv.getInt8(o + 11) * 1.5 * Math.PI / 180;
      let N = npcs.get(id);
      if (!N) npcs.set(id, N = { id, isNpc: true, type: CARS[fl & 3] || 'coupe', color: (fl >> 2) & 7, rs: s, rlat: lat, rvl: 0, ryaw: yaw, pose: {}, vel: [0, 0, 0] });
      N.seen = now; N.dir = fl & 128 ? -1 : 1;
      if (N.pending > 0 && now < N.hold) continue; // we shoved it and the server hasn't confirmed yet: keep our prediction
      N.s = s; N.vs = vs; N.lat = lat; N.vl = vl; N.t = st; N.tyaw = yaw; N.wreck = !!(fl & 64);
    }
  };
  // a wheel = a round mesh low down (as tall as it is long, thin across). front ones steer. if a model packs its wheels
  // into one mesh it just won't match and those wheels stay still, no harm done
  const wheelOf = (p, M) => {
    p.g.computeBoundingBox?.();
    const b = p.g.boundingBox; if (!b) return null;
    const c = b.min.clone(), lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < 8; i++) {
      c.set(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z).applyMatrix4(p.local);
      [c.x, c.y, c.z].forEach((v, a) => { lo[a] = Math.min(lo[a], v); hi[a] = Math.max(hi[a], v); });
    }
    const dx = hi[0] - lo[0], dy = hi[1] - lo[1], dz = hi[2] - lo[2], cy = (lo[1] + hi[1]) / 2;
    if (dy < 0.35 || dy > 1.4 || Math.abs(dx - dy) > dy * 0.25 || dz > dy * 0.75 || cy > M.h * 0.45) return null;
    const cx = (lo[0] + hi[0]) / 2, cz = (lo[2] + hi[2]) / 2;
    return { front: cx > M.cx + M.hx * 0.2, r: dy / 2, cx, cy, cz, dz };
  };
  // tyre, rim and shadow of one corner are separate meshes (rim sits ~8cm outboard): turn them all about the tyre's centre
  const pivotWheels = (ws, mk) => {
    for (const w of ws) {
      let hub = w;
      for (const o of ws) if (Math.abs(o.cx - w.cx) < 0.15 && Math.abs(o.cy - w.cy) < 0.15 && Math.abs(o.cz - w.cz) < 0.3 && o.dz > hub.dz) hub = o;
      w.r = Math.max(w.r, hub.r);
      w.T = mk().makeTranslation(hub.cx, hub.cy, hub.cz); w.Ti = mk().makeTranslation(-hub.cx, -hub.cy, -hub.cz);
    }
  };
  const WR = {};
  const fleetFor = (type, need) => {
    const M = models[type];
    if (!M || !findIM()) return null;
    let F = fleets[type];
    if (F && F.M === M && F.cap >= need) return F;
    if (F) for (const p of F.parts) { p.im.removeFromParent(); p.im.dispose(); }
    const cap = Math.max(32, 2 ** Math.ceil(Math.log2(need || 1)));
    const parts = [];
    M.m.traverse(o => o.isMesh && parts.push({ g: o.geometry, mat: o.material, local: o.matrixWorld.clone(), name: o.name }));
    let bi = parts.findIndex(p => /_map$|_metal_2$/.test(p.name));
    if (bi < 0) bi = 0;
    F = fleets[type] = { M, cap, parts: parts.map((p, k) => {
      const im = new IM(p.g, p.mat, cap);
      im.frustumCulled = false; im.count = 0; im.matrixAutoUpdate = false;
      return { im, local: p.local, body: k === bi, wheel: wheelOf(p, M) };
    }) };
    pivotWheels(F.parts.map(p => p.wheel).filter(Boolean), () => parts[0].local.clone());
    const Col = parts[bi].mat.color?.constructor;
    F.colors = Col ? PALETTE.map(c => new Col(...c)) : null;
    return F;
  };
  const NM = {};
  const updateTraffic = (now, dt) => {
    for (const F of Object.values(fleets)) for (const p of F.parts) p.im.count = 0;
    if (!npcs.size || !refreshRoad(now)) return;
    if (!NM.m) { NM.m = car.matrix.clone(); NM.t = car.matrix.clone(); NM.x = car.position.clone(); NM.y = car.position.clone(); NM.z = car.position.clone(); }
    const counts = {}, srvNow = now - off;
    for (const N of npcs.values()) {
      if (now - N.seen > 1500) { npcs.delete(N.id); continue; }
      // predict from the last packet (server sim is smooth: speed along the road + a steering-limited sideways speed)
      const age = Math.max(0, Math.min(1, (srvNow - N.t) / 1000));
      // wrecks are braking/scrubbing on the server (~5.5 m/s2), predict that too so a shoved car doesn't overshoot
      const sg = Math.sign(N.vs), dec = N.wreck ? 5.5 : 0, ta = dec ? Math.min(age, Math.abs(N.vs) / dec) : age;
      const ps = N.s + N.vs * ta - sg * 0.5 * dec * ta * ta, pl = N.lat + N.vl * Math.min(age, 0.5);
      const vNow = dec ? N.vs - sg * dec * ta : N.vs;
      N.rs += vNow * dt;
      N.rs = Math.abs(ps - N.rs) > 30 ? ps : N.rs + (ps - N.rs) * Math.min(1, dt * 4);
      const err = pl - N.rlat, spd = Math.abs(vNow), Mb = models[N.type] || models.coupe, L = Mb ? Mb.hx * 1.25 : 2.6;
      if (N.wreck || Math.abs(err) > 2.5 || spd < 0.8) {
        // sliding wreck / big correction / crawling: move sideways directly (a skidding car really does go sideways)
        N.rlat += N.vl * dt * (age < 0.5 ? 1 : 0) + err * Math.min(1, dt * 5);
        N.hd = (N.hd || 0) * Math.pow(0.1, dt);
      } else {
        // driving: aim the nose where it needs to go (server's sideways speed + closing the gap), turn no faster than
        // the front wheels allow at this speed (max ~35 deg lock), and move only where the nose points. no crabbing
        const want = Math.max(-0.6, Math.min(0.6, Math.atan2(N.vl + Math.max(-2, Math.min(2, err * 1.5)), spd)));
        const rate = spd / L * 0.7 * dt;
        N.hd = (N.hd || 0) + Math.max(-rate, Math.min(rate, (want - (N.hd || 0)) * Math.min(1, dt * 8)));
        N.rlat += spd * Math.sin(N.hd) * dt;
      }
      { let da = N.tyaw - N.ryaw; da -= Math.round(da / (2 * Math.PI)) * 2 * Math.PI; N.ryaw += da * Math.min(1, dt * (N.wreck ? 7 : 2)); }
      N.tilt = (N.tilt || 0) + ((N.wreck && N.type === 'bike' ? 1.4 : 0) - (N.tilt || 0)) * Math.min(1, dt * 5); // bikes go down
      // walls: where the game has barriers on this stretch, NPCs (skidding wrecks, swerves) stop at them instead of passing
      // through. it's the game's own road data and identical for everyone, so every client stops them in the same place
      // stone walls (dswl/dswr, along fields) count too: they're signed lateral positions, guardrails are distances
      const Mw = models[N.type] || models.coupe, ni = Math.floor(N.rs / NODE);
      let wr = Infinity, wl = -Infinity;
      for (const nb of [road.by.get(ni), road.by.get(ni + 1)]) {
        if (!nb) continue;
        if (nb.rWallDist > 0) wr = Math.min(wr, nb.rWallDist); if (nb.dswr > 3) wr = Math.min(wr, nb.dswr);
        if (nb.lWallDist > 0) wl = Math.max(wl, -nb.lWallDist); if (nb.dswl < -3) wl = Math.max(wl, nb.dswl);
      }
      N.wr = wr < 30 ? +wr.toFixed(1) : 0; N.wl = wl > -30 ? +wl.toFixed(1) : 0;
      if (Mw) {
        const ys = Math.abs(Math.sin(N.ryaw)), hw = ys * Mw.hx + (1 - ys) * Mw.hz + 0.1; // wider when spun sideways
        if (N.rlat > wr - hw) { N.rlat = wr - hw; if (N.vl > 0) N.vl = N.rvl = 0; }
        if (N.rlat < wl + hw) { N.rlat = wl + hw; if (N.vl < 0) N.vl = N.rvl = 0; }
      }
      N.near = false;
      if (!roadPoint(N.rs, N.rlat)) continue;
      const dx = RP.x - car.position.x, dz = RP.z - car.position.z, d2 = dx * dx + dz * dz;
      if (d2 > NPC_CULL2) continue;
      const M = models[N.type] || models.coupe;
      if (!M) continue;
      // basis: X = where it's actually heading = along the road + its sideways speed, so lane changes and dodges
      // visibly steer (nose turns into the move) instead of sliding. Y = up, Z = X × Y
      const ch = Math.cos(N.hd || 0), sh = Math.sin(N.hd || 0);
      const X = NM.x.set(RP.fx * N.dir * ch + RP.nx * sh, RP.fy * N.dir * ch, RP.fz * N.dir * ch + RP.nz * sh).normalize();
      if (Math.abs(N.ryaw) > 0.001) { const c = Math.cos(N.ryaw), sn = Math.sin(N.ryaw), x = X.x; X.x = x * c + X.z * sn; X.z = -x * sn + X.z * c; }
      const ang = Math.atan2(-X.z, X.x);
      if (N.ang != null && dt > 0) {
        let da = ang - N.ang; da -= Math.round(da / (2 * Math.PI)) * 2 * Math.PI;
        const st = N.wreck || spd < 0.5 ? 0 : Math.max(-0.6, Math.min(0.6, Math.atan(da / dt * L / spd)));
        N.steer = (N.steer || 0) + (st - (N.steer || 0)) * Math.min(1, dt * 10);
      }
      N.ang = ang; N.roll = (N.roll || 0) - (N.wreck ? 0 : vNow * N.dir) * dt / 0.5;
      const Y = NM.y.set(0, 1, 0).addScaledVector(X, -X.y).normalize();
      const Z = NM.z.crossVectors(X, Y);
      // the server's s/lat is the vehicle's CENTRE (that's what its physics boxes use), models have their origin at the
      // rear axle: shift so the middle of the car sits on the spot
      const M0 = models[N.type] || models.coupe, ocx = M0 ? M0.cx : 0, ocz = M0 ? M0.cz : 0;
      NM.m.makeBasis(X, Y, Z).setPosition(RP.x - X.x * ocx - Z.x * ocz, RP.y - X.y * ocx, RP.z - X.z * ocx - Z.z * ocz);
      if (N.tilt > 0.01) NM.m.multiply((WR.r ||= NM.m.clone()).makeRotationX(N.tilt)); // lying on its side
      const type = models[N.type] ? N.type : 'coupe';
      const idx = counts[type] = (counts[type] || 0) + 1;
      const F = fleetFor(type, Math.max(idx, (fleets[type]?.cap || 0)));
      if (!F) continue;
      for (const p of F.parts) {
        if (p.im.parent !== car.parent) car.parent.add(p.im);
        if (p.wheel && d2 < 22500) { // close enough to see: front wheels steer, all of them roll
          const W = p.wheel;
          WR.a ||= NM.m.clone(); WR.b ||= NM.m.clone();
          WR.a.makeRotationZ(N.roll / W.r * 0.5); // roll was integrated as distance/0.5m radius: rescale to this wheel
          if (W.front && N.steer) WR.a.premultiply(WR.b.makeRotationY(N.steer));
          NM.t.multiplyMatrices(NM.m, W.T).multiply(WR.a).multiply(W.Ti).multiply(p.local);
        } else NM.t.multiplyMatrices(NM.m, p.local);
        p.im.setMatrixAt(idx - 1, NM.t);
        if (p.body && F.colors) p.im.setColorAt(idx - 1, F.colors[N.color]);
      }
      const lv = N.wreck ? N.vl : spd * sh; // how it's actually moving on screen
      N.vel[0] = RP.fx * vNow + RP.nx * lv; N.vel[1] = 0; N.vel[2] = RP.fz * vNow + RP.nz * lv;
      N.wx = RP.x; N.wz = RP.z; N.mapT = now; // for the minimap
      if (joined && d2 < 900) { // close enough to touch: real footprint pose for collisions
        const P = N.pose;
        P.x = RP.x - X.x * ocx - Z.x * ocz; P.y = RP.y; P.z = RP.z - X.z * ocx - Z.z * ocz; P.ax = X.x; P.az = X.z; P.bx = Z.x; P.bz = Z.z; P.M = M;
        N.near = true;
      }
    }
    for (const [type, F] of Object.entries(fleets)) {
      const c = counts[type] || 0;
      for (const p of F.parts) {
        p.im.count = c;
        if (!c) continue;
        p.im.instanceMatrix.needsUpdate = true;
        if (p.body && p.im.instanceColor) p.im.instanceColor.needsUpdate = true;
      }
    }
  };

  // ================= minimap + full map =================
  // the game unloads road far behind you, so every node we ever see is kept (just x,z: tiny) and the map can show your
  // whole drive. players come from a once-a-second feed with no distance limit, so nobody drops off the map
  const roadHist = new Map();
  let histMin = Infinity, histMax = -Infinity;
  const MM = { mini: null, mctx: null, big: null, bctx: null, open: false, scale: 0.05, cx: 0, cz: 0, follow: true, drag: null };
  const onMapFeed = dv => {
    const now = performance.now(), n = dv.getUint16(1, true);
    for (let i = 0, o = 3; i < n; i++, o += 12) {
      const g = ghosts.get(dv.getUint16(o, true));
      if (!g) continue;
      g.mx = dv.getFloat32(o + 2, true); g.mz = dv.getFloat32(o + 6, true);
      g.mfx = dv.getInt8(o + 10) / 127; g.mfz = dv.getInt8(o + 11) / 127; g.mapT = now;
    }
  };
  // players to draw: live ghost position when we have one, otherwise the map feed
  const mapPlayers = now => {
    const out = [];
    for (const g of ghosts.values()) {
      if (g.root?.visible && now - g.last < 2000) out.push({ x: g.root.position.x, z: g.root.position.z, name: g.name });
      else if (g.mapT && now - g.mapT < 15000) out.push({ x: g.mx, z: g.mz, name: g.name });
    }
    return out;
  };
  // world -> screen. heading-up (minimap) uses our forward/right axes, north-up (full map) is plain x/z
  const drawMap = (ctx, W, H, cx, cz, scale, heading, full) => {
    if (!ctx) return;
    const now = performance.now(), dpr = devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = full ? 'rgba(12,14,18,.92)' : 'rgba(12,14,18,.62)';
    ctx.fillRect(0, 0, W, H);
    const fx = heading ? heading[0] : 0, fz = heading ? heading[1] : -1, rx = heading ? heading[2] : 1, rz = heading ? heading[3] : 0;
    const S = (x, z, o) => { const dx = x - cx, dz = z - cz; o[0] = W / 2 + (dx * rx + dz * rz) * scale; o[1] = H / 2 - (dx * fx + dz * fz) * scale; return o; };
    const q = [0, 0];
    // road
    if (roadHist.size) {
      const near = road.near?.i ?? 0, span = full ? Infinity : Math.ceil(Math.max(W, H) / scale / NODE);
      const lo = Math.max(histMin, near - span), hi = Math.min(histMax, near + span);
      const stride = Math.max(1, Math.floor(2 / (NODE * scale)));
      ctx.strokeStyle = 'rgba(235,235,235,.85)'; ctx.lineWidth = full ? 2 : 3; ctx.lineJoin = 'round';
      ctx.beginPath();
      let pen = false;
      for (let i = lo; i <= hi; i += stride) {
        const p = roadHist.get(i);
        if (!p) { pen = false; continue; }
        S(p[0], p[1], q);
        if (pen) ctx.lineTo(q[0], q[1]); else { ctx.moveTo(q[0], q[1]); pen = true; }
      }
      ctx.stroke();
    }
    // traffic
    ctx.fillStyle = 'rgba(160,165,175,.9)';
    for (const N of npcs.values()) {
      if (!N.mapT || now - N.mapT > 1000) continue;
      S(N.wx, N.wz, q);
      if (q[0] < -5 || q[1] < -5 || q[0] > W + 5 || q[1] > H + 5) continue;
      ctx.fillRect(q[0] - 1.5, q[1] - 1.5, 3, 3);
    }
    // players
    ctx.font = `${full ? 12 : 10}px Sono,monospace`; ctx.textAlign = 'center';
    for (const p of mapPlayers(now)) {
      S(p.x, p.z, q);
      const ex = Math.max(8, Math.min(W - 8, q[0])), ey = Math.max(8, Math.min(H - 8, q[1])); // pinned to the edge if off-map
      ctx.fillStyle = '#4fc3ff'; ctx.beginPath(); ctx.arc(ex, ey, full ? 5 : 4, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.fillText(p.name, ex, ey - 8);
    }
    // us: arrow
    if (car?.parent) {
      S(car.position.x, car.position.z, q);
      const f = car.forwardDir || V.t?.set(1, 0, 0).applyQuaternion(car.quaternion) || { x: 1, z: 0 };
      let ax = f.x * rx + f.z * rz, ay = -(f.x * fx + f.z * fz); const al = Math.hypot(ax, ay) || 1; ax /= al; ay /= al;
      const s = full ? 9 : 8;
      ctx.fillStyle = '#ffd34f'; ctx.beginPath();
      ctx.moveTo(q[0] + ax * s, q[1] + ay * s);
      ctx.lineTo(q[0] - ax * s * 0.6 - ay * s * 0.6, q[1] - ay * s * 0.6 + ax * s * 0.6);
      ctx.lineTo(q[0] - ax * s * 0.6 + ay * s * 0.6, q[1] - ay * s * 0.6 - ax * s * 0.6);
      ctx.closePath(); ctx.fill();
    }
    if (full) {
      ctx.fillStyle = 'rgba(255,255,255,.6)'; ctx.textAlign = 'left'; ctx.font = '12px Sono,monospace';
      ctx.fillText('M / esc close · scroll zoom · drag pan · double-click recentre', 14, H - 14);
    }
  };
  const sizeCanvas = (c, w, h) => { const d = devicePixelRatio || 1; if (c.width !== w * d) { c.width = w * d; c.height = h * d; } };
  const MINI = 190;
  const drawMaps = () => {
    if (!joined || !car?.parent || !MM.mini) return;
    MM.mini.style.display = MM.open ? 'none' : '';
    if (!MM.open) {
      sizeCanvas(MM.mini, MINI, MINI);
      const f = car.forwardDir || V.t?.set(1, 0, 0).applyQuaternion(car.quaternion) || { x: 1, z: 0 };
      const fl = Math.hypot(f.x, f.z) || 1, fx = f.x / fl, fz = f.z / fl;
      drawMap(MM.mctx, MINI, MINI, car.position.x, car.position.z, MINI / 2 / 450, [fx, fz, -fz, fx], false);
    } else {
      const W = innerWidth, H = innerHeight;
      sizeCanvas(MM.big, W, H);
      if (MM.follow) { MM.cx = car.position.x; MM.cz = car.position.z; }
      drawMap(MM.bctx, W, H, MM.cx, MM.cz, MM.scale, null, true);
    }
  };
  setInterval(drawMaps, 100);
  const toggleMap = force => {
    MM.open = force ?? !MM.open;
    MM.big.style.display = MM.open ? '' : 'none';
    if (MM.open) { MM.follow = true; drawMaps(); }
  };
  addEventListener('keydown', e => {
    if (overlay || !joined || e.repeat || e.ctrlKey || e.metaKey || e.altKey || e.target?.tagName === 'INPUT') return;
    if (e.code === 'KeyM' || (e.code === 'Escape' && MM.open)) { e.stopImmediatePropagation(); e.preventDefault(); toggleMap(e.code === 'Escape' ? false : undefined); }
  }, true);
  const buildMaps = () => {
    MM.mini = document.createElement('canvas');
    MM.mini.style.cssText = `position:fixed;top:16px;right:16px;width:${MINI}px;height:${MINI}px;border-radius:14px;z-index:2147483644;pointer-events:none;display:none`;
    MM.big = document.createElement('canvas');
    MM.big.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;z-index:2147483646;display:none;cursor:grab';
    MM.mctx = MM.mini.getContext('2d'); MM.bctx = MM.big.getContext('2d');
    document.documentElement.append(MM.mini, MM.big);
    MM.big.addEventListener('wheel', e => {
      e.preventDefault();
      const k = Math.exp(-e.deltaY * 0.0015), W = innerWidth, H = innerHeight;
      // zoom around the cursor
      const wx = MM.cx + (e.clientX - W / 2) / MM.scale, wz = MM.cz + (e.clientY - H / 2) / MM.scale;
      MM.scale = Math.max(0.002, Math.min(4, MM.scale * k));
      MM.cx = wx - (e.clientX - W / 2) / MM.scale; MM.cz = wz - (e.clientY - H / 2) / MM.scale;
      MM.follow = false; drawMaps();
    }, { passive: false });
    MM.big.addEventListener('pointerdown', e => { MM.drag = { x: e.clientX, y: e.clientY }; MM.big.style.cursor = 'grabbing'; });
    addEventListener('pointermove', e => {
      if (!MM.drag) return;
      MM.cx -= (e.clientX - MM.drag.x) / MM.scale; MM.cz -= (e.clientY - MM.drag.y) / MM.scale;
      MM.drag = { x: e.clientX, y: e.clientY }; MM.follow = false; drawMaps();
    });
    addEventListener('pointerup', () => { MM.drag = null; if (MM.big) MM.big.style.cursor = 'grab'; });
    MM.big.addEventListener('dblclick', () => { MM.follow = true; drawMaps(); });
  };

  const pre = () => {
    snap();
    if (!V.t) { V.t = car.position.clone(); V.qa = car.quaternion.clone(); V.qb = car.quaternion.clone(); V.cp = car.position.clone(); }
    const C = car.controller;
    if (joined) {
      if (C?.fly) C.fly.up = C.fly.right = C.fly.back = 0; // debug fly mode
      if (car.type === 'debug' && isReady()) car.setVehicle(0);
    }
    const now = performance.now(), rt = now - off - DELAY;
    for (const g of ghosts.values()) {
      const live = g.buf.length && now - g.last < 5000;
      if (!live) { if (g.root) g.root.visible = false; continue; }
      const M = modelFor(g.type);
      if (!M) continue;
      if (!g.root) { g.root = new (O3D())(); }
      if (g.root.parent !== car.parent) car.parent.add(g.root);
      if (g.model !== M) { g.body?.removeFromParent(); g.body = M.m.clone(true); g.model = M; g.root.add(g.body); }
      sample(g, rt);
      const d2 = g.root.position.distanceToSquared(car.position);
      g.root.visible = d2 < CULL2;
      if (joined && d2 < 900) { poseFromQuat(g.root.position, g.root.quaternion, M, g.pose); collide(g); } else g.contact = false;
    }
    const dt = Math.min((now - lastNpcF) / 1000, 0.1);
    lastNpcF = now;
    updateTraffic(now, dt);
    for (const N of npcs.values()) if (N.near) collide(N); else N.contact = false;
  };

  const post = () => {
    rect ||= canvas.getBoundingClientRect();
    cam.getWorldPosition(V.cp);
    for (const g of ghosts.values()) {
      const s = g.tag.style;
      let show = !overlay && g.root?.visible && g.root.parent;
      let d = 0;
      if (show) {
        V.t.copy(g.root.position); V.t.y += g.model.h + 0.6;
        d = V.t.distanceTo(V.cp);
        V.t.project(cam);
        show = V.t.z < 1 && d < TAG_DIST;
      }
      if (show !== g.shown) { s.display = show ? '' : 'none'; g.shown = show; }
      if (!show) continue;
      const x = Math.round(rect.left + (V.t.x + 1) / 2 * rect.width), y = Math.round(rect.top + (1 - V.t.y) / 2 * rect.height);
      if (x !== g.tx || y !== g.ty) { s.transform = `translate3d(${x}px,${y}px,0) translate(-50%,-100%)`; g.tx = x; g.ty = y; }
      const op = Math.round(Math.max(0.35, 1 - d / TAG_DIST) * 20) / 20;
      if (op !== g.op) { s.opacity = op; g.op = op; }
    }
  };

  // ================= network =================
  const out = new DataView(new ArrayBuffer(34));
  const i16 = x => Math.max(-32767, Math.min(32767, Math.round(x)));
  let sentAt = 0, lp = [0, 0, 0], lq = [0, 0, 0, 0];
  setInterval(() => {
    if (!joined || ws?.readyState !== 1 || !car?.parent || ws.bufferedAmount > 16384) return;
    const p = car.position, q = car.quaternion, v = car.velocity, now = performance.now();
    const moved = Math.abs(p.x - lp[0]) + Math.abs(p.y - lp[1]) + Math.abs(p.z - lp[2]) > 0.02 ||
      Math.abs(q.x * lq[0] + q.y * lq[1] + q.z * lq[2] + q.w * lq[3]) < 0.99999;
    if (!moved && now - sentAt < 1000) return;
    sentAt = now; lp = [p.x, p.y, p.z]; lq = [q.x, q.y, q.z, q.w];
    out.setUint8(0, 1);
    out.setFloat32(1, p.x, true); out.setFloat32(5, p.y, true); out.setFloat32(9, p.z, true);
    out.setInt16(13, i16(q.x * 32767), true); out.setInt16(15, i16(q.y * 32767), true);
    out.setInt16(17, i16(q.z * 32767), true); out.setInt16(19, i16(q.w * 32767), true);
    out.setInt16(21, i16(v.x * 100), true); out.setInt16(23, i16(v.y * 100), true); out.setInt16(25, i16(v.z * 100), true);
    out.setUint8(27, Math.max(0, CARS.indexOf(car.type)));
    // road position for traffic (NaN when we can't tell / off-road)
    const r = refreshRoad(now) ? myRoad() : null;
    out.setFloat32(28, r ? r.s : NaN, true);
    out.setInt16(32, r ? i16(r.lat * 100) : 0, true);
    ws.send(out.buffer);
  }, 66);

  const connect = name => {
    ws = new WebSocket(SERVER);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', v: PROTO, name, car: carSel, mod: MOD_VERSION, loader: window.SRMP_LOADER || 0 }));
    ws.onmessage = e => {
      if (typeof e.data === 'string') return onMsg(JSON.parse(e.data));
      if (e.data.byteLength < 7) return;
      const dv = new DataView(e.data), op = dv.getUint8(0);
      if (op === 2) onTick(dv); else if (op === 8) onTraffic(dv); else if (op === 7) onMapFeed(dv);
      else if (op === 9) { const N = npcs.get(dv.getUint16(1, true)); if (N && N.pending > 0) N.pending--; } // hit applied: updates from here on include it
    };
    ws.onclose = e => {
      clearGhosts();
      npcs.clear();
      if (e.code >= 4000) { kicked = true; return say(e.reason || 'disconnected by server'); }
      if (!me) { // free hosts sleep when idle and take ~1 min to wake, keep knocking
        if (++wakeTries > 18) { wakeTries = 0; overlay?.classList.remove('auto'); return status("can't reach server"); }
        status(`waking server up... (${wakeTries * 5}s)`);
        return setTimeout(() => connect(name), 5000);
      }
      toast('disconnected, reconnecting...');
      setTimeout(() => connect(me.name), retry);
      retry = Math.min(retry * 2, 15000);
    };
  };

  const onMsg = m => {
    if (m.t === 'error') { overlay?.classList.remove('auto'); return status(m.msg); }
    if (m.t === 'welcome') {
      env = m.env;
      localStorage.srmpWorld = env.world;
      if (!worldOk()) {
        if (sessionStorage.srmpMoved) return status('world sync failed, refresh');
        sessionStorage.srmpMoved = 1;
        return gotoWorld();
      }
      retry = 2000;
      const first = !me;
      me = m;
      m.players.forEach(addPlayer);
      if (first) start(); else toast('reconnected');
      return;
    }
    if (m.t === 'env') {
      const moved = m.env.world !== env.world;
      env = m.env;
      if (moved) return gotoWorld();
      setLocks(); enforce();
      return toast('server changed the weather');
    }
    if (m.t === 'join') { addPlayer(m); return toast(m.name + ' joined'); }
    if (m.t === 'leave') { const g = ghosts.get(m.id); g && toast(g.name + ' left'); return removePlayer(m.id); }
    if (m.t === 'toast') toast(m.msg);
  };

  // ================= join flow =================
  const join = () => {
    if (kicked || (ws && ws.readyState < 2)) return;
    const name = nameIn.value.trim();
    if (!/^\w{3,16}$/.test(name)) return status('3-16 letters, numbers or _');
    localStorage.srmp = JSON.stringify({ name, car: carSel });
    status('connecting...');
    connect(name);
  };

  const start = async () => {
    sessionStorage.removeItem('srmpMoved');
    status('loading world...');
    let clicked = false;
    await until(() => {
      if (!clicked) {
        const b = [...document.querySelectorAll('div,button,span,a')].find(e => e.textContent.trim().toLowerCase() === 'begin');
        if (b) { b.click(); clicked = true; }
      }
      return isReady();
    }, 30000);
    if (!isReady()) return status('game failed to load, refresh');

    // never touch the vehicle while slowroads is still loading the environment: a vehicle swap mid-load can break its
    // terrain load queue (invisible terrain). wait for the loading screen to go and things to settle first
    const gameLoading = () => /\bLOADING\b/.test(document.body?.innerText || '');
    await until(() => !gameLoading(), 90000);
    await wait(1500);
    status('loading cars...');
    for (const [i, [key]] of PICK.entries()) {
      if (models[key]) continue;
      if (gameLoading()) await until(() => !gameLoading(), 30000);
      car.setVehicle(i);
      await until(() => isReady() && car.type === key && !gameLoading(), 15000);
      if (!isReady() || car.type !== key) break;
      snap();
    }
    if (isReady() && car.type !== carSel) { car.setVehicle(PICK.findIndex(c => c[0] === carSel)); await until(isReady, 15000); }

    setLocks(); lockWorld(); joined = true; enforce();
    setInterval(() => { if (kicked) return; if (!worldOk()) return gotoWorld(); enforce(); }, 1000);

    overlay.remove(); overlay = null;
    toast(`joined as ${me.name} · ${ghosts.size} other${ghosts.size === 1 ? '' : 's'} online`);
    if (!settingsHooked) toast('settings lock unavailable on this game version');
  };

  const status = t => statusEl && (statusEl.textContent = t);
  const say = t => overlay ? status(t) : toast(t, 1e9);
  const toast = (t, ms = 4000) => {
    const el = tagsEl.appendChild(document.createElement('div'));
    el.className = 'srmp-toast';
    el.textContent = t;
    setTimeout(() => el.remove(), ms);
  };

  // eat game input while the join screen is up (window capture runs before the game's listeners)
  for (const ev of ['keydown', 'keyup', 'keypress', 'mousedown', 'pointerdown', 'wheel', 'touchstart'])
    addEventListener(ev, e => {
      if (!overlay) return;
      e.stopImmediatePropagation();
      if (ev === 'keydown' && e.key === 'Enter') join();
    }, true);

  const boot = () => {
    const css = document.createElement('style');
    css.textContent = `
#srmp{position:fixed;inset:0;z-index:2147483646;display:flex;align-items:center;justify-content:center;background:rgba(10,12,16,.85);backdrop-filter:blur(6px);font:14px Sono,monospace;color:#eee}
#srmp .box{display:flex;flex-direction:column;gap:12px;width:280px}
#srmp h1{margin:0;font-size:22px;letter-spacing:6px;font-weight:400;text-align:center}
#srmp input,#srmp button{font:inherit;padding:10px;border-radius:8px;border:1px solid #444;background:#1a1d23;color:#eee;outline:none;cursor:pointer}
#srmp .cars{display:flex;gap:6px}#srmp .cars button{flex:1}
#srmp button.on,#srmp .go{background:#eee;color:#111}
#srmp .st{min-height:18px;text-align:center;opacity:.7}
#srmp.auto input,#srmp.auto .cars,#srmp.auto .go{display:none}
#srmp-tags{position:fixed;inset:0;pointer-events:none;z-index:2147483645;overflow:hidden;font:13px Sono,monospace;contain:strict}
.srmp-tag{position:absolute;left:0;top:0;padding:2px 8px;border-radius:6px;background:rgba(0,0,0,.55);color:#fff;white-space:nowrap;will-change:transform}
.srmp-toast{position:absolute;left:50%;top:16px;transform:translateX(-50%);padding:6px 12px;border-radius:8px;background:rgba(0,0,0,.6);color:#fff}`;
    document.head.append(css);

    tagsEl = document.createElement('div');
    tagsEl.id = 'srmp-tags';
    overlay = document.createElement('div');
    overlay.id = 'srmp';
    overlay.innerHTML = `<div class="box"><h1>s l o w  r o a d s<br><small>multiplayer</small></h1>
      <input maxlength="16" placeholder="username" spellcheck="false">
      <div class="cars">${PICK.map(([k, n]) => `<button data-k="${k}">${n}</button>`).join('')}</div>
      <button class="go">join</button><div class="st"></div></div>`;
    document.documentElement.append(tagsEl, overlay);
    buildMaps();

    nameIn = overlay.querySelector('input');
    statusEl = overlay.querySelector('.st');
    let saved = {};
    try { saved = JSON.parse(localStorage.srmp || '{}'); } catch {}
    nameIn.value = saved.name || '';
    const pick = k => { carSel = k; overlay.querySelectorAll('.cars button').forEach(b => b.classList.toggle('on', b.dataset.k === k)); };
    pick(PICK.some(c => c[0] === saved.car) ? saved.car : 'coupe');
    overlay.querySelector('.cars').addEventListener('click', e => e.target.dataset.k && pick(e.target.dataset.k));
    overlay.querySelector('.go').addEventListener('click', join);
    nameIn.focus();
    if (!SERVER || SERVER.includes('your-server')) return status('set your server in config.js');
    if (sessionStorage.srmpAuto) { // came back from a world switch: no second join screen, just carry on
      sessionStorage.removeItem('srmpAuto');
      overlay.classList.add('auto');
      return join();
    }
    // check the server's world while the player types (also wakes a sleeping host early);
    // if it moved, swap now, before anyone has joined or loaded cars
    fetch(SERVER.replace(/^ws/, 'http') + '/info').then(r => r.json()).then(i => {
      if (!i.world || ws) return;
      localStorage.srmpWorld = i.world;
      if (hashWorld() !== i.world) { status('syncing world...'); location.hash = i.world + '@0'; location.reload(); }
    }).catch(() => {});
  };

  document.readyState === 'loading' ? addEventListener('DOMContentLoaded', boot) : boot();
})();
