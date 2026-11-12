// shared traffic: a 1D-plus sim along the road. every client builds the same road from the seed, so the server tracks
// distance-along-road (s, metres) + a real lateral position per NPC and clients turn that into world positions.
//   lane +1 drives toward increasing s, centred at lateral -1.6m; lane -1 is oncoming, centred at +1.6m
//   longitudinal: IDM with per-driver personality. lateral: a steering-limited position (lateral speed + accel caps), so lane
//   changes, overtakes and dodges are real curved paths, never jumps. NPCs swerve around players, overtake slow traffic,
//   and when someone misjudges it they crash, skid, and the road jams up until it clears.

const PHYS = require('./physics');
const LANE = 1.6, ROAD_EDGE = 3.5, WIN = 2000, DESPAWN = 2600, MAX_NPC = 180, REC = 12, SIM_HZ = 10, SEND_HZ = 5;
const AHEAD_MIN = 700, BEHIND_MIN = 140; // spawn out of sight: far up the road, or just behind (everyone looks forward)
const TYPES = [ // c = car index (coupe/coach/bike), w = spawn weight, v = desired speed m/s, len/wid = size m, a = max accel
  { c: 0, w: 0.62, v: [17, 34], len: 4.3, wid: 1.8, a: 1.7, m: 1 },
  { c: 1, w: 0.18, v: [13, 23], len: 10.5, wid: 2.5, a: 0.9, m: 4 },
  { c: 2, w: 0.20, v: [15, 33], len: 2.1, wid: 0.8, a: 2.4, m: 0.4 }
];
const pickType = () => { let r = Math.random(); for (const t of TYPES) if ((r -= t.w) <= 0) return t; return TYPES[0]; };
const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const laneCentre = l => -LANE * l;
const lanesAt = (lat, halfW) => [1, -1].filter(l => Math.abs(lat - laneCentre(l)) < LANE + halfW - 0.2); // lanes a body overlaps

module.exports = function traffic({ online, clock, send }) {
  const cfg = { on: process.env.TRAFFIC !== '0', density: +process.env.DENSITY || 4, crashes: process.env.CRASHES !== '0' };
  const npcs = new Map();
  let nextId = 1;

  const roadPlayers = () => online().filter(p => p.road && clock() - p.road.t < 3000);
  const onRoad = p => Math.abs(p.road.lat) < ROAD_EDGE + 0.5;
  const headingOf = p => Math.abs(p.road.vs) > 2 ? Math.sign(p.road.vs) : (p.road.lat < 0 ? 1 : -1);
  const occLane = n => n.over ? -n.lane : n.lane;
  // where the driver is steering to
  const targetLat = n => {
    if (n.swerveT > 0) return n.swerveLat;
    return laneCentre(occLane(n)) * (n.squeeze ? (n.over ? 0.15 : 1.85) : 1);
  };

  const spawn = (s, lane) => {
    const T = pickType(), reckless = cfg.crashes && Math.random() < 0.05, v0 = rand(...T.v) * (reckless ? 1.12 : 1);
    const id = nextId; nextId = nextId % 65535 + 1;
    npcs.set(id, {
      id, T, lane, s, v: v0 * rand(0.85, 1), v0, color: (Math.random() * 8) | 0,
      lat: laneCentre(lane), vl: 0,
      // personality
      reckless, hw: reckless ? rand(0.5, 0.9) : rand(0.9, 1.9), s0: reckless ? rand(1.5, 3) : rand(2.5, 6), aMul: rand(0.8, 1.3),
      disRate: !cfg.crashes ? 0 : reckless ? 1 / 600 : 1 / 2500, dis: 0, react: rand(0.6, 1.3),
      over: false, stuck: 0, blocker: null, brake: false, squeeze: false, crashT: 0, yaw: 0, swerveT: 0, swerveLat: 0
    });
  };

  // a spot is spawnable if no player can see it (not within AHEAD_MIN in front of anyone, not right next to anyone)
  const hidden = (s, players) => players.every(q => {
    const d = (s - q.road.s) * headingOf(q);
    return d > AHEAD_MIN || d < -BEHIND_MIN;
  });

  function populate(players) {
    const target = Math.round(cfg.density * 2 * WIN / 1000);
    for (const p of players) {
      const hd = headingOf(p);
      for (const lane of [1, -1]) {
        if (npcs.size >= MAX_NPC) return;
        const have = [...npcs.values()].filter(n => n.lane === lane && Math.abs(n.s - p.road.s) < WIN).length;
        let tries = p.road.fresh ? (target - have) * 2 : Math.min(3, target - have);
        while (tries-- > 0 && npcs.size < MAX_NPC) {
          // same-direction traffic: half spawn just behind you (they catch up / you see them in mirrors) so your side isn't empty
          const behind = Math.random() < (lane === hd ? 0.5 : 0.25);
          const s = p.road.s + hd * (behind ? -rand(BEHIND_MIN, WIN) : rand(p.road.fresh ? 250 : AHEAD_MIN, WIN));
          if (s < 30) continue;
          if (!p.road.fresh && !hidden(s, players)) continue;
          if (players.some(q => Math.abs(q.road.s - s) < 60)) continue;
          if ([...npcs.values()].some(o => occLane(o) === lane && Math.abs(o.s - s) < 70)) continue;
          spawn(s, lane);
        }
      }
      p.road.fresh = false;
    }
  }

  // velocity along the road (signed, +s) right now: driving, or the rigid body's if it's wrecked
  const vAlong = n => n.b ? n.b.vx : n.v * n.lane;
  const laneAng = n => n.lane > 0 ? 0 : Math.PI;
  const wrap = a => a - Math.round(a / (2 * Math.PI)) * 2 * Math.PI;
  // a rigid body matching where the NPC is and how it's moving (driving NPCs too: used for contact tests)
  const bodyOf = n => n.b || PHYS.body(n.s, n.lat, laneAng(n) + n.yaw * Math.PI / 180, n.v * n.lane, n.vl, 0, n.T);
  // wreck it: from now until it stops it's a physics body (mass, grip, spin, collisions, walls). bikes go down
  const crash = (n, why, B) => {
    if (n.b) { n.crashT = Math.max(n.crashT, 8); return n.b; }
    if (process.env.TRAFFIC_TEST) (module.exports.log ||= []).push(why);
    n.b = B || bodyOf(n);
    n.b.w += rand(-0.25, 0.25); // nothing lines up perfectly
    if (n.T.c === 2) n.b.down = true;
    n.crashT = rand(14, 26); n.dis = 0; n.squeeze = false; n.swerveT = 0; n.v = 0;
    return n.b;
  };

  function step(dt, players) {
    // occupancy per lane: a body overlapping both lanes (mid lane change, straddling the line) blocks both
    const occ = [];
    for (const n of npcs.values())
      for (const l of lanesAt(n.lat, n.T.wid / 2)) occ.push({ ref: n, lane: l, s: n.s, vs: vAlong(n), len: n.T.len, wid: n.T.wid, crashed: n.crashT > 0, lat: n.lat });
    for (const p of players)
      if (onRoad(p)) for (const l of lanesAt(p.road.lat, 0.9)) occ.push({ ref: p, player: true, lane: l, s: p.road.s, vs: p.road.vs, len: 4.4, wid: 1.8, lat: p.road.lat });

    // careful overtakers meeting oncoming cars: overtaker hugs the centre line, oncoming car squeezes onto its shoulder and slows.
    // reckless overtakers don't get that courtesy: oncoming cars brake hard and it may well end in a head-on
    for (const n of npcs.values()) n.squeeze = false;
    for (const n of npcs.values()) {
      if (!n.over || (n.reckless && !n.lucky) || n.crashT > 0) continue;
      for (const m of npcs.values())
        if (m.lane === -n.lane && !m.over && m.crashT <= 0 && Math.abs(m.s - n.s) < 40) n.squeeze = m.squeeze = true;
    }

    for (const n of npcs.values()) {
      if (n.ghostT > 0) n.ghostT -= dt;
      if (n.b) continue; // wrecked: the physics pass below moves it
      n.wreckT = 0;
      n.yaw *= Math.pow(0.05, dt); // straighten up after recovering
      if (n.dis > 0) n.dis -= dt; else if (Math.random() < n.disRate * dt) n.dis = rand(1.2, 3.2); // zoned out
      if (n.swerveT > 0) n.swerveT -= dt;

      // watch every lane our body is physically in, plus the one we're steering into
      const dir = n.lane, myLanes = new Set([lanesAt(targetLat(n), 0)[0] ?? occLane(n), ...lanesAt(n.lat, n.T.wid / 2)]);
      let lead = null, gap = Infinity;
      for (const o of occ) {
        if (o.ref === n || !myLanes.has(o.lane) || (n.over && o.ref === n.blocker)) continue;
        if (n.over && !o.crashed && (o.player || o.ref.lane !== n.lane)) continue; // overtaking: ignore oncoming (they deal with us)
        if (!n.over && !o.player && o.ref.over && o.ref.lane !== n.lane && (!o.ref.reckless || o.ref.lucky)) continue; // careful oncoming overtaker: squeeze past
        if (n.swerveT > 0 && Math.abs(o.lat - n.swerveLat) > 2) continue; // dodging around it
        const d = (o.s - n.s) * dir;
        if (d <= 0 || d > 300) continue;
        const g = d - (o.len + n.T.len) / 2;
        if (g < gap) { gap = g; lead = o; }
      }

      // IDM, personalised. a distracted driver doesn't react to what's ahead
      const a = n.T.a * n.aMul, b = 2.5;
      const v0 = n.squeeze && !n.over ? n.v0 * 0.55 : n.v0;
      let acc = a * (1 - (n.v / v0) ** 4);
      if (lead && n.dis <= 0) {
        const dv = n.v - lead.vs * dir;
        const sStar = n.s0 + Math.max(0, n.v * n.hw + n.v * dv / (2 * Math.sqrt(a * b)));
        acc -= a * (sStar / Math.max(gap, 0.5)) ** 2;
      }
      if (n.swerveT > 2) acc = Math.min(acc, -3.5); // real dodges brake and steer at once
      acc = Math.max(-9, Math.min(a, acc));
      n.brake = acc < -1.5;
      n.v = Math.max(0, n.v + acc * dt);
      n.s += dir * n.v * dt;

      // emergency swerve: a player (they don't follow the rules) is in the way and braking alone won't make it.
      // steer around them toward whichever side has room, like a real driver would
      if (lead?.player && n.dis <= 0 && n.swerveT <= 0) {
        const closing = n.v - lead.vs * dir;
        if (closing > 3 && gap < closing * closing / (2 * 7) + closing * n.react * 0.5 + 2) {
          const free = lat => !occ.some(o => o.ref !== n && Math.abs(o.lat - lat) < 1.8 && Math.abs(o.s - n.s) < 30 && o.ref !== lead.ref);
          const opts = [lead.lat - 2.4, lead.lat + 2.4].map(l => clamp(l, -ROAD_EDGE + 0.4, ROAD_EDGE - 0.4))
            .filter(l => Math.abs(l - lead.lat) > 1.6 && free(l))
            .sort((x, y) => Math.abs(x - n.lat) - Math.abs(y - n.lat));
          if (opts.length) { n.swerveLat = opts[0]; n.swerveT = 3.5; }
        }
      }

      if (!n.over) {
        // stuck behind something stopped, or stuck behind something slow and impatient
        const leadV = lead ? lead.vs * dir : 0;
        n.stuck = lead && n.v < 1.5 && gap < 30 && leadV < 1.5 ? n.stuck + dt : 0;
        const slow = lead && !lead.crashed && gap < 45 && leadV < n.v0 * 0.8 && n.v0 - leadV > 4;
        const want = n.swerveT <= 0 && ((n.stuck > 3) || (slow && Math.random() < (n.reckless ? 0.03 : 0.02)));
        const clear = n.reckless && !n.stuck ? 170 : n.stuck > 3 ? 220 : 300;
        const otherOut = [...npcs.values()].some(m => m.over && m.lane === n.lane && Math.abs(m.s - n.s) < 60);
        if (want && !otherOut && !occ.some(o => o.lane === -n.lane && (o.s - n.s) * dir > -20 && (o.s - n.s) * dir < clear)) {
          n.over = true; n.blocker = lead.ref; n.overS = lead.s; n.overT = 0; n.stuck = 0;
          n.lucky = Math.random() < 0.7; // even reckless overtakes usually get away with it
        }
      } else {
        n.overT += dt;
        const bS = n.blocker?.road ? n.blocker.road.s : (n.blocker?.s ?? n.overS);
        const bLen = n.blocker?.T?.len || 4.4;
        // careful drivers abort if oncoming traffic appears before they're alongside; reckless ones floor it
        if (!n.reckless && (n.s - bS) * dir < 0) {
          const danger = occ.some(o => {
            if (o.ref === n || o.lane !== -n.lane || (!o.player && o.ref.lane === n.lane)) return false;
            const d = (o.s - n.s) * dir;
            return d > 0 && d < (n.v - o.vs * dir) * 3 + 25;
          });
          const space = !occ.some(o => o.ref !== n && o.lane === n.lane && Math.abs(o.s - n.s) < (o.len + n.T.len) / 2 + 2);
          if (danger && space) { n.over = false; n.blocker = null; n.stuck = 0; }
        }
        if (n.over) {
          // pull back in once past the blocker with a real gap (not mid stopped-queue); 25s hard limit
          const roomy = !occ.some(o => {
            if (o.ref === n || o.lane !== n.lane) return false;
            const d = (o.s - n.s) * dir;
            return (d > -15 && d < 25) || (d >= 25 && d < 70 && Math.abs(o.vs) < 2);
          });
          if (((n.s - bS) * dir > 8 + bLen && roomy) || n.overT > 25) { n.over = false; n.blocker = null; }
        }
      }

      // lateral: steer toward the target with a lateral speed + accel limit (can't slide sideways when slow, quick at speed)
      const vmax = Math.min(3.2, 0.14 * n.v + 0.3) * (n.swerveT > 0 ? 1.6 : 1);
      const want = clamp((targetLat(n) - n.lat) * 1.6, -vmax, vmax);
      n.vl += clamp(want - n.vl, -4.5 * dt, 4.5 * dt);
      // mirror check: never steer sideways into something that's beside us (only into space that's actually free)
      const nl = n.lat + n.vl * dt;
      const blocked = occ.some(o => o.ref !== n &&
        Math.abs(o.s - n.s) < (o.len + n.T.len) / 2 + 0.5 &&
        Math.abs(o.lat - nl) < (o.wid + n.T.wid) / 2 + 0.15 &&
        Math.abs(o.lat - nl) < Math.abs(o.lat - n.lat)); // only blocks moving TOWARD it
      if (blocked) n.vl = 0; else n.lat = clamp(nl, Math.min(-ROAD_EDGE - 1, n.lat), Math.max(ROAD_EDGE + 1, n.lat)); // off-road: steers back, no snap
    }

    // collisions on the real 2D footprints (lateral position + width), sorted sweep so it stays cheap
    if (cfg.crashes) {
      const list = [...npcs.values()].sort((x, y) => x.s - y.s);
      for (let i = 0; i < list.length; i++) {
        const A = list[i];
        for (let j = i + 1; j < list.length && list[j].s - A.s < 12; j++) {
          const B = list[j];
          if ((A.b && B.b) || A.ghostT > 0 || B.ghostT > 0) continue;
          if (Math.abs(A.lat - B.lat) > (A.T.wid + B.T.wid) / 2 - 0.1 || B.s - A.s > (A.T.len + B.T.len) / 2 - 0.2) continue;
          if (!PHYS.contact(bodyOf(A), bodyOf(B))) continue;
          const why = (A.b || B.b) ? 'into-wreck' : (A.lane !== B.lane ? 'head-on' : ((A.dis > 0 || B.dis > 0) ? 'distracted' : (A.over || B.over ? 'overtake' : 'following'))) + (A.reckless || B.reckless ? '/reckless' : '');
          crash(A, why); crash(B, why);
        }
      }
      const wrecks = [...npcs.values()].filter(n => n.b);
      if (wrecks.length) for (const n of npcs.values()) {
        if (n.b || n.ghostT > 0) continue;
        for (const w of wrecks) if (Math.abs(w.s - n.s) < 14 && PHYS.contact(w.b, bodyOf(n))) { crash(n, 'into-wreck'); break; }
      }
      // NPC-into-player contacts are reported by that player's client (real mesh contact), not guessed here
    }

    // physics: every wreck is a rigid body. step them (collisions between wrecks, walls, tyre grip), then copy back
    const bodies = [];
    for (const n of npcs.values()) if (n.b) {
      const W = n.walls, b = n.b;
      b.wl = W && Math.abs(n.s - W.s) < 40 ? W.wl : 0; b.wr = W && Math.abs(n.s - W.s) < 40 ? W.wr : 0;
      bodies.push(b);
    }
    if (bodies.length) {
      PHYS.step(bodies, dt, 3, ROAD_EDGE + 2.5);
      for (const n of npcs.values()) if (n.b) {
        const b = n.b, still = Math.hypot(b.vx, b.vy) < 0.3 && Math.abs(b.w) < 0.1;
        n.s = b.x; n.lat = b.y; n.vl = b.vy; n.yaw = wrap(b.a - laneAng(n)) * 180 / Math.PI;
        n.crashT -= dt; n.wreckT = (n.wreckT || 0) + dt;
        if (n.crashT <= 0 && still) { // limps off, untangling from the wreck
          n.b = null; n.crashT = 0; n.over = false; n.blocker = null; n.ghostT = 4; n.v = 0;
          if (Math.abs(n.yaw) > 100) n.yaw = 0; // facing backwards: (off camera, it's long past) just point it the right way
        } else if (n.crashT <= 0) n.crashT = 0.5;
      }
    }

    // despawn: far from every player, off the start of the road, or nobody around.
    // tow truck: wrecks older than 40s and cars gridlocked for 60s get cleared once no player is close enough to see it
    for (const n of npcs.values()) {
      n.jam = n.v < 0.5 && n.crashT <= 0 ? (n.jam || 0) + dt : 0;
      const unseen = players.every(p => Math.abs(p.road.s - n.s) > 250);
      if (n.s < 0 || !players.some(p => Math.abs(p.road.s - n.s) < DESPAWN) || (unseen && (n.wreckT > 40 || n.jam > 60)) || n.jam > 120) npcs.delete(n.id);
    }
  }

  // per client: NPCs within range of them. 12 bytes each:
  // id u16, s f32, speed along road i16 (cm/s), lateral i8 (/35 m), lateral speed i8 (/20 m/s), flags u8, yaw i8 (*1.5 deg)
  // flags: bits 0-1 type, 2-4 colour, 5 braking, 6 wrecked, 7 drives toward -s
  function broadcast(players) {
    const t = clock() >>> 0;
    for (const r of players) {
      const list = [];
      for (const n of npcs.values()) if (Math.abs(n.s - r.road.s) < WIN + 200) list.push(n);
      const buf = Buffer.allocUnsafe(7 + list.length * REC);
      buf[0] = 8; buf.writeUInt32LE(t, 1); buf.writeUInt16LE(list.length, 5);
      list.forEach((n, i) => {
        const o = 7 + i * REC;
        buf.writeUInt16LE(n.id, o);
        buf.writeFloatLE(n.s, o + 2);
        buf.writeInt16LE(clamp(Math.round(vAlong(n) * 100), -32767, 32767), o + 6);
        buf.writeInt8(clamp(Math.round(n.lat * 35), -127, 127), o + 8);
        buf.writeInt8(clamp(Math.round(n.vl * 20), -127, 127), o + 9);
        buf[o + 10] = n.T.c | (n.color << 2) | (n.brake ? 32 : 0) | (n.b ? 64 : 0) | (n.lane < 0 ? 128 : 0);
        buf.writeInt8(clamp(Math.round(n.yaw / 1.5), -127, 127), o + 11); // +-190 deg covers any heading
      });
      send(r, buf);
    }
  }

  // a player touched an NPC. the client reports the contact (point relative to the NPC + normal, in road coords) and its
  // own velocity; the server works out the impulse with the NPC's real mass + inertia (so off-centre hits spin it) and
  // tyre grip. hard enough and it's a wreck (a physics body), otherwise a driving car just gets nudged and drives on.
  // everything is capped/sanity-checked so a modified client can't launch NPCs
  const PB = { im: 0, iI: 0, w: 0 };
  function hit(p, m) {
    // always confirm (op 9) so the client stops holding its prediction: anything we broadcast after this includes the hit
    const ack = Buffer.from([9, 0, 0]); ack.writeUInt16LE(m.id & 0xffff, 1);
    try { applyHit(p, m); } finally { send(p, ack); }
  }
  function applyHit(p, m) {
    const n = npcs.get(m.id | 0), now = clock();
    if (!n || !p.road || now - (p.lastHit || 0) < 100) return;
    if (Math.abs(n.s - p.road.s) > 25) return; // must actually be next to it
    p.lastHit = now;
    const num = (v, a) => clamp(Number.isFinite(+v) ? +v : 0, -a, a);
    let ns = num(m.ns, 1), nl = num(m.nl, 1); const nn = Math.hypot(ns, nl); if (nn < 0.5) return; ns /= nn; nl /= nn;
    let pvs = num(m.pvs, 70), pvl = num(m.pvl, 30);
    if (Math.abs(pvs - p.road.vs) > 12) pvs = p.road.vs; // must roughly match how fast the server has seen them going
    pvl = clamp(pvl, n.vl - 10, n.vl + 10);           // and nobody drives sideways at motorway speed
    const wr = +m.wr || 0, wl = +m.wl || 0;
    n.walls = { s: n.s, wr: wr > 1 && wr < 30 ? wr : 0, wl: wl < -1 && wl > -30 ? wl : 0 };
    const B = bodyOf(n), lim = Math.hypot(B.hl, B.hw) + 0.5;
    const c = { nx: ns, ny: nl, depth: 0, px: B.x + num(m.cs, lim), py: B.y + num(m.cl, lim) };
    // the player as a body: real mass, no spin (their own game handles that)
    PB.x = c.px - ns; PB.y = c.py - nl; PB.vx = pvs; PB.vy = pvl; PB.im = 1 / PHYS.mass(p.rec?.[28] | 0);
    const vx0 = B.vx, vy0 = B.vy, w0 = B.w;
    PHYS.resolve(PB, B, c, 0.2, 0.4, false);
    if (n.b) { n.crashT = Math.max(n.crashT, 6); return; } // already a wreck: it just took the impulse
    // driving: did that beat the tyres? along the car it rolls (a nudge just changes speed), across it the tyres hold
    // ~0.85g for the ~0.1s of contact, so small side bumps are absorbed
    const dvx = B.vx - vx0, dvy = B.vy - vy0, dw = B.w - w0;
    const side = Math.max(0, Math.abs(dvy) - 0.8);
    // a rider can catch a small shove; a real knock puts the bike down
    const hard = cfg.crashes && (Math.hypot(dvx, side) > (n.T.c === 2 ? 3 : 4) || Math.abs(dw) > 0.6 || side > (n.T.c === 2 ? 2 : 1.5));
    if (hard) { B.vy = vy0 + Math.sign(dvy) * side; crash(n, 'player-hit', B); return; }
    n.v = clamp(n.v + dvx * n.lane, 0, n.v0 * 1.3);
    n.vl = clamp(n.vl + Math.sign(dvy) * side, -4, 4);
  }

  let lastPop = 0;
  if (!process.env.TRAFFIC_TEST) setInterval(() => {
    const players = cfg.on ? roadPlayers() : [];
    if (!players.length) { npcs.clear(); return; }
    const now = clock();
    if (now - lastPop > 1000 || players.some(p => p.road.fresh)) { populate(players); lastPop = now; }
    step(1 / SIM_HZ, players);
  }, 1000 / SIM_HZ);
  if (!process.env.TRAFFIC_TEST) setInterval(() => { if (cfg.on) broadcast(roadPlayers()); }, 1000 / SEND_HZ);

  return {
    hit,
    command(a, b) {
      if (a === 'on' || a === 'off') { cfg.on = a === 'on'; if (!cfg.on) { npcs.clear(); broadcast(roadPlayers()); } return 'traffic ' + a; }
      if (a === 'density' && +b >= 0 && +b <= 20) { cfg.density = +b; return 'density ' + b + ' cars/km/lane'; }
      if (a === 'crashes' && (b === 'on' || b === 'off')) { cfg.crashes = b === 'on'; return 'crashes ' + b; }
      const wrecks = [...npcs.values()].filter(n => n.b).length;
      return `traffic: ${cfg.on ? 'on' : 'off'}, density ${cfg.density}, crashes ${cfg.crashes ? 'on' : 'off'}, ${npcs.size} npcs (${wrecks} wrecked) | usage: traffic on|off|density <0-20>|crashes on|off`;
    },
    get count() { return npcs.size; },
    _sim: { npcs, populate, step, cfg, hit } // for offline tests
  };
};
