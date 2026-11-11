(() => {
  'use strict';
  // bump MOD_VERSION on every push to server/public/mod.js; bump NEEDS_LOADER only if loader.js/manifest changed
  const MOD_VERSION = 4;
  const NEEDS_LOADER = 1;
  if (window.__srmpRan) return; // newer cached copy already running
  window.__srmpRan = MOD_VERSION;
  const SERVER = window.SRMP_SERVER;

  const PROTO = 3;
  const CARS = ['coupe', 'coach', 'bike', 'drift'];
  const PICK = [['coupe', 'Coupe'], ['coach', 'Coach'], ['bike', 'Bike']]; // index = game's setVehicle index
  const MASS = { coupe: 1, coach: 4, bike: 1, drift: 1 }; // bikes count as solid as a car so cars stop on them instead of shoving through
  // max speed change (m/s) one contact can give you, per frame and in total. bikes balance/lean, so a big sideways kick flings them
  const KICK = { coupe: [12, 30], coach: [12, 30], drift: [12, 30], bike: [2.5, 10] };
  const DELAY = 100, EXTRAP = 250, CULL2 = 1500 ** 2, TAG_DIST = 800, REST = 0.3, REC = 29;
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
  const onCanvas = e => e.target?.tagName === 'CANVAS';
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
    const v = car.position.clone(), mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
    m.traverse(o => {
      o.matrixAutoUpdate = false;
      if (!o.isMesh) return;
      o.geometry = o.geometry.clone();
      o.material = Array.isArray(o.material) ? o.material.map(x => x.clone()) : o.material.clone();
      if (/shadow/i.test(o.name)) return;
      o.geometry.computeBoundingBox();
      const b = o.geometry.boundingBox;
      for (let i = 0; i < 8; i++) {
        v.set(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z).applyMatrix4(o.matrixWorld);
        mn[0] = Math.min(mn[0], v.x); mn[1] = Math.min(mn[1], v.y); mn[2] = Math.min(mn[2], v.z);
        mx[0] = Math.max(mx[0], v.x); mx[1] = Math.max(mx[1], v.y); mx[2] = Math.max(mx[2], v.z);
      }
    });
    models[car.type] = { m, cx: (mn[0] + mx[0]) / 2, cz: (mn[2] + mx[2]) / 2, hx: (mx[0] - mn[0]) / 2, hz: (mx[2] - mn[2]) / 2, h: mx[1] };
  };
  const modelFor = t => models[t] || models.coupe || Object.values(models)[0];

  // ================= ghosts =================
  const addPlayer = p => {
    if (ghosts.has(p.id) || (me && p.id === me.id)) return;
    const tag = tagsEl.appendChild(document.createElement('div'));
    tag.className = 'srmp-tag';
    tag.textContent = p.name;
    tag.style.display = 'none';
    ghosts.set(p.id, { box: { wi: 60000 + p.id }, name: p.name, type: CARS[p.c] || 'coupe', tag, buf: [], pool: [], last: 0, shown: false, tx: 0, ty: 0, op: 0 });
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

  // 2D oriented-box overlap (SAT) on the ground plane, then a soft impulse on our own chassis velocity
  const box = (pos, quat, M, o) => {
    V.t.set(M.cx, 0, M.cz).applyQuaternion(quat);
    o.x = pos.x + V.t.x; o.z = pos.z + V.t.z; o.y = pos.y;
    V.t.set(1, 0, 0).applyQuaternion(quat); let l = Math.hypot(V.t.x, V.t.z) || 1; o.ux = V.t.x / l; o.uz = V.t.z / l;
    o.wx = -o.uz; o.wz = o.ux; o.hx = M.hx; o.hz = M.hz; o.h = M.h;
    return o;
  };
  // ---- ghost cars as barriers inside slowroads' own physics ----
  // every wheel's ground query writes into wheel.groundState: w (wall present), wd (signed distance), wn (normal), ws (side), wi (wall id).
  // those fields become accessors: when a ghost box is nearer than any road barrier, the wheel sees the ghost's nearest face as a
  // barrier, so the game's own collideWallEdge pushes the wheel, its solver carries the chassis, and the hit/scrape sounds play.
  const obstacles = [], myBox = { ok: false }, WALL_RANGE = 1.2;
  const hookWheel = e => {
    const gs = e.groundState;
    if (!gs || gs.__srmp) return;
    const raw = { w: gs.w, wd: gs.wd, wn: gs.wn, ws: gs.ws, wi: gs.wi };
    const o = { on: false, wd: 0, wn: null, wi: 0, dirty: true };
    const q = () => {
      if (!o.dirty) return o.on;
      o.dirty = false;
      const was = o.on;
      o.on = false;
      const p = e.contactPoint;
      if (!joined || !p || !obstacles.length || !myBox.ok || car.type === 'bike') return false; // bike: impulse only
      let best = WALL_RANGE, hit = null, nx = 0, nz = 0;
      for (const b of obstacles) {
        if (Math.abs(p.y - b.y) > b.h + 1) continue;
        const dx = p.x - b.x, dz = p.z - b.z;
        const lu = dx * b.ux + dz * b.uz, lw = dx * b.wx + dz * b.wz;
        const qx = Math.abs(lu) - b.hx, qz = Math.abs(lw) - b.hz, ox = Math.max(qx, 0), oz = Math.max(qz, 0);
        let gu, gw;
        if (ox > 0 || oz > 0) { gu = ox * Math.sign(lu); gw = oz * Math.sign(lw); }
        else if (qx > qz) { gu = Math.sign(lu); gw = 0; } else { gu = 0; gw = Math.sign(lw); }
        const l = Math.hypot(gu, gw) || 1, mx = (gu * b.ux + gw * b.wx) / l, mz = (gu * b.uz + gw * b.wz) / l;
        // wheels sit inside the body: shift the wall out by how far our own body reaches past this wheel toward the ghost
        const A = myBox, reach = (A.x - p.x) * -mx + (A.z - p.z) * -mz + A.hx * Math.abs(A.ux * mx + A.uz * mz) + A.hz * Math.abs(A.wx * mx + A.wz * mz);
        const sdf = Math.hypot(ox, oz) + Math.min(Math.max(qx, qz), 0) - Math.max(reach, 0);
        if (sdf >= best) continue;
        best = sdf; hit = b; nx = mx; nz = mz;
      }
      if (!hit) return false;
      // the game's wall response slides the wheel by wcd*tan(impact angle): fine for barriers you graze, but a nose-first
      // hit is ~90° and tan blows up and flings you. only feed it glancing contacts; the impulse solver below does the rest
      if (best < (was ? -0.8 : 0)) return false;                    // first touch from inside / deep (spawn, teleport): impulse handles it
      if (e.wi === hit.wi && e.insideWall === false) return false;  // game thinks we're past it, never trap a wheel
      if (raw.w && raw.wd > -best) return false;                    // a real barrier is closer
      const vd = e.velocityDir, glancing = vd && Math.abs(vd.x * nz - vd.z * nx) >= 0.7;
      o.on = true; o.wi = hit.wi;
      // nose-first: keep the wall registered with the wheel safely outside (no push, impulse handles it) so the game's
      // inside/outside state stays right; glancing: real distance, small per-frame push (verlet turns push into speed)
      o.wd = glancing ? Math.min(-best, -0.12) : -Math.max(best, 0.3); // push per frame = wd + margin(0.2) <= 8cm
      (o.wn ||= car.position.clone()).set(nx, 0, nz);
      return true;
    };
    const def = (k, get) => Object.defineProperty(gs, k, {
      configurable: true, enumerable: true, get,
      set(v) { raw[k] = v; if (k === 'w') o.dirty = true; }
    });
    def('w', () => q() || raw.w);
    def('wd', () => (q() ? o.wd : raw.wd));
    def('wn', () => (q() ? o.wn : raw.wn));
    def('ws', () => (q() ? 1 : raw.ws));
    def('wi', () => (q() ? o.wi : raw.wi));
    Object.defineProperty(gs, '__srmp', { value: true });
  };

  // body-vs-body impulse: head-on/rear-end hits, overlaps the wheels can't see, spawning inside someone.
  // drives relative normal speed toward a target (bounce + gentle separation) so it never stacks frame to frame
  const A = {};
  const unstick = g => {
    const MA = models[car.type], B = g.box, C = car.controller;
    if (!MA || !C?.chassisVel) return;
    box(car.position, car.quaternion, MA, A);
    if (Math.abs(A.y - B.y) > Math.max(A.h, B.h) + 0.5) return;
    const dx = A.x - B.x, dz = A.z - B.z;
    let depth = Infinity, nx = 0, nz = 0;
    for (const [lx, lz] of [[A.ux, A.uz], [A.wx, A.wz], [B.ux, B.uz], [B.wx, B.wz]]) {
      const ra = A.hx * Math.abs(A.ux * lx + A.uz * lz) + A.hz * Math.abs(A.wx * lx + A.wz * lz);
      const rb = B.hx * Math.abs(B.ux * lx + B.uz * lz) + B.hz * Math.abs(B.wx * lx + B.wz * lz);
      const d = dx * lx + dz * lz, ov = ra + rb - Math.abs(d);
      if (ov <= 0) { g.kicked = 0; return; }
      if (ov < depth) { depth = ov; const sg = d < 0 ? -1 : 1; nx = lx * sg; nz = lz * sg; }
    }
    const bike = car.type === 'bike';
    const [perFrame, perContact] = KICK[car.type] || KICK.coupe;
    const v = C.chassisVel, gv = g.vel || [0, 0, 0];
    const vr = (v.x - gv[0]) * nx + (v.z - gv[2]) * nz;
    const target = Math.max(Math.min(depth, 1) * (bike ? 2 : 3), bike ? 0 : -REST * vr); // bikes don't bounce
    if (vr >= target) return;
    const j = Math.min((target - vr) * MASS[g.type] / (MASS[car.type] + MASS[g.type]), perFrame, perContact - (g.kicked || 0));
    if (j <= 0) return;
    g.kicked = (g.kicked || 0) + j; // resets once you're apart, so one bump can't stack into a launch
    let ix = nx * j, iz = nz * j;
    if (bike) {
      // bikes balance: a sideways kick tips them into the game's crash/reset. push fully along the bike, gently across it,
      // and never while airborne. small per-frame steps but no total cap, so you still can't be driven through
      if (car.isAirborne) return;
      const lon = ix * A.ux + iz * A.uz, lat = (ix * A.wx + iz * A.wz) * 0.45;
      ix = A.ux * lon + A.wx * lat; iz = A.uz * lon + A.wz * lat;
    }
    v.x += ix; v.z += iz;
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
    const r = roadRef();
    if (!r?.p) return false;
    let a = r, k = 0;
    while (a.prev && k++ < 20000) a = a.prev;
    road.by.clear();
    for (let x = a; x && road.by.size < 20000; x = x.next) road.by.set(x.i, x);
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
    RP.fx = fx; RP.fy = fy; RP.fz = fz;
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
  const onTraffic = dv => {
    const now = performance.now(), st = dv.getUint32(1, true), n = dv.getUint16(5, true);
    syncClock(now, st);
    for (let i = 0, o = 7; i < n; i++, o += 10) {
      const id = dv.getUint16(o, true), s = dv.getFloat32(o + 2, true), vs = dv.getInt16(o + 6, true) / 100;
      const lat = dv.getInt8(o + 8) / 40, fl = dv.getUint8(o + 9);
      let N = npcs.get(id);
      if (!N) npcs.set(id, N = { id, type: CARS[fl & 3] || 'coupe', color: (fl >> 2) & 7, rs: s, rlat: lat, dir: lat < 0 ? 1 : -1, box: { wi: 50000 + id }, vel: [0, 0, 0], kicked: 0 });
      N.s = s; N.vs = vs; N.tlat = lat; N.t = st; N.seen = now;
      if (Math.abs(vs) > 0.3) N.dir = Math.sign(vs);
    }
  };
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
      return { im, local: p.local, body: k === bi };
    }) };
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
      const ps = N.s + N.vs * Math.max(0, Math.min(1, (srvNow - N.t) / 1000));
      N.rs = Math.abs(ps - N.rs) > 30 ? ps : N.rs + (ps - N.rs) * Math.min(1, dt * 6);
      N.rlat += (N.tlat - N.rlat) * Math.min(1, dt * 1.5); // lane changes / squeezing past take ~1-2s
      N.near = false;
      if (!roadPoint(N.rs, N.rlat)) continue;
      const dx = RP.x - car.position.x, dz = RP.z - car.position.z, d2 = dx * dx + dz * dz;
      if (d2 > NPC_CULL2) continue;
      const M = models[N.type] || models.coupe;
      if (!M) continue;
      // basis: X = travel direction (follows slope), Y = up, Z = X × Y
      const X = NM.x.set(RP.fx * N.dir, RP.fy * N.dir, RP.fz * N.dir);
      const Y = NM.y.set(0, 1, 0).addScaledVector(X, -X.y).normalize();
      const Z = NM.z.crossVectors(X, Y);
      NM.m.makeBasis(X, Y, Z).setPosition(RP.x, RP.y, RP.z);
      const type = models[N.type] ? N.type : 'coupe';
      const idx = counts[type] = (counts[type] || 0) + 1;
      const F = fleetFor(type, Math.max(idx, (fleets[type]?.cap || 0)));
      if (!F) continue;
      for (const p of F.parts) {
        if (p.im.parent !== car.parent) car.parent.add(p.im);
        NM.t.multiplyMatrices(NM.m, p.local);
        p.im.setMatrixAt(idx - 1, NM.t);
        if (p.body && F.colors) p.im.setColorAt(idx - 1, F.colors[N.color]);
      }
      N.vel[0] = RP.fx * N.vs; N.vel[1] = 0; N.vel[2] = RP.fz * N.vs;
      if (joined && d2 < 900) { // close enough to touch: footprint for collisions
        const B = N.box, hl = Math.hypot(X.x, X.z) || 1;
        B.ux = X.x / hl; B.uz = X.z / hl; B.wx = -B.uz; B.wz = B.ux;
        B.x = RP.x + B.ux * M.cx + Z.x * M.cz; B.z = RP.z + B.uz * M.cx + Z.z * M.cz; B.y = RP.y;
        B.hx = M.hx; B.hz = M.hz; B.h = M.h;
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

  const pre = () => {
    snap();
    if (!V.t) { V.t = car.position.clone(); V.qa = car.quaternion.clone(); V.qb = car.quaternion.clone(); V.cp = car.position.clone(); }
    const C = car.controller;
    if (joined) {
      if (C?.fly) C.fly.up = C.fly.right = C.fly.back = 0; // debug fly mode
      if (car.type === 'debug' && isReady()) car.setVehicle(0);
    }
    if (C?.wheels) for (const w of C.wheels) hookWheel(w);
    const now = performance.now(), rt = now - off - DELAY;
    obstacles.length = 0;
    myBox.ok = !!models[car.type];
    if (myBox.ok) box(car.position, car.quaternion, models[car.type], myBox);
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
      if (joined && d2 < 900) {
        obstacles.push(box(g.root.position, g.root.quaternion, M, g.box));
        unstick(g);
      }
    }
    const dt = Math.min((now - lastNpcF) / 1000, 0.1);
    lastNpcF = now;
    updateTraffic(now, dt);
    for (const N of npcs.values()) if (N.near) { obstacles.push(N.box); unstick(N); }
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
      if (op === 2) onTick(dv); else if (op === 4) onTraffic(dv);
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

    status('loading cars...');
    for (const [i, [key]] of PICK.entries()) {
      if (models[key]) continue;
      car.setVehicle(i);
      await until(() => isReady() && car.type === key, 15000);
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
