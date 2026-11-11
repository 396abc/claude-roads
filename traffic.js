// shared traffic: a 1D sim along the road. every client builds the same road from the seed, so the server only tracks
// distance-along-road (s, metres) + lane per NPC and clients turn that into world positions. tiny CPU + bandwidth.
//   lane +1 drives toward increasing s and sits at lateral -1.6m; lane -1 is oncoming at +1.6m
//   NPCs follow with IDM, each with its own personality: some tailgate, some are reckless, some zone out for a second.
//   they overtake slow traffic and blockers, and when someone misjudges it they actually crash and the road jams up.

const LANE = 1.6, WIN = 2000, DESPAWN = 2600, MAX_NPC = 180, REC = 11, SIM_HZ = 10, SEND_HZ = 5;
const AHEAD_MIN = 700, BEHIND_MIN = 140; // spawn out of sight: far up the road, or just behind (everyone looks forward)
const TYPES = [ // c = car index (coupe/coach/bike), w = spawn weight, v = desired speed m/s, len = length m, a = max accel
  { c: 0, w: 0.62, v: [17, 34], len: 4.4, a: 1.7 },
  { c: 1, w: 0.18, v: [13, 23], len: 10.5, a: 0.9 },
  { c: 2, w: 0.20, v: [15, 33], len: 2.2, a: 2.4 }
];
const pickType = () => { let r = Math.random(); for (const t of TYPES) if ((r -= t.w) <= 0) return t; return TYPES[0]; };
const rand = (a, b) => a + Math.random() * (b - a);

module.exports = function traffic({ online, clock, send }) {
  const cfg = { on: process.env.TRAFFIC !== '0', density: +process.env.DENSITY || 4, crashes: process.env.CRASHES !== '0' };
  const npcs = new Map();
  let nextId = 1;

  const roadPlayers = () => online().filter(p => p.road && clock() - p.road.t < 3000);
  const laneOf = p => Math.abs(p.road.lat) > 3.6 ? null : (p.road.lat < 0 ? 1 : -1); // which lane a player is in (null = off road)
  const headingOf = p => Math.abs(p.road.vs) > 2 ? Math.sign(p.road.vs) : (laneOf(p) || 1);
  const occLane = n => n.over ? -n.lane : n.lane;
  const latOf = n => n.crashT > 0 ? n.crashLat : -LANE * occLane(n) * (n.squeeze ? (n.over ? 0.15 : 1.85) : 1);

  const spawn = (s, lane) => {
    const T = pickType(), reckless = cfg.crashes && Math.random() < 0.05, v0 = rand(...T.v) * (reckless ? 1.12 : 1);
    const id = nextId; nextId = nextId % 65535 + 1;
    npcs.set(id, {
      id, T, lane, s, v: v0 * rand(0.85, 1), v0, color: (Math.random() * 8) | 0,
      // personality
      reckless, hw: reckless ? rand(0.5, 0.9) : rand(0.9, 1.9), s0: reckless ? rand(1.5, 3) : rand(2.5, 6), aMul: rand(0.8, 1.3),
      disRate: !cfg.crashes ? 0 : reckless ? 1 / 600 : 1 / 2500, dis: 0,
      over: false, stuck: 0, blocker: null, brake: false, squeeze: false, crashT: 0, crashLat: 0, yaw: 0
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
        const all = [...npcs.values()];
        const have = all.filter(n => n.lane === lane && Math.abs(n.s - p.road.s) < WIN).length;
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

  const crash = (n, yawSign, sev, why) => {
    if (n.crashT > 0) return;
    if (process.env.TRAFFIC_TEST) (module.exports.log ||= []).push(why);
    n.crashLat = latOf(n) + rand(-0.9, 0.9);
    n.crashT = rand(14, 26);
    n.v = 0; n.dis = 0; n.squeeze = false;
    n.yaw = yawSign * rand(15, 25 + 55 * Math.min(1, sev / 20)); // harder hit, bigger spin
  };

  function step(dt, players) {
    // everything that occupies a lane right now: NPCs + players on the road
    const occ = [];
    for (const n of npcs.values()) occ.push({ ref: n, lane: occLane(n), s: n.s, vs: n.v * n.lane, len: n.T.len, crashed: n.crashT > 0 });
    for (const p of players) { const l = laneOf(p); if (l) occ.push({ ref: p, player: true, lane: l, s: p.road.s, vs: p.road.vs, len: 4.4 }); }

    // careful overtakers meeting oncoming cars: overtaker hugs the centre line, oncoming car squeezes onto its shoulder and slows.
    // reckless overtakers don't get that courtesy: oncoming cars brake hard and it may well end in a head-on
    for (const n of npcs.values()) n.squeeze = false;
    for (const n of npcs.values()) {
      if (!n.over || (n.reckless && !n.lucky) || n.crashT > 0) continue;
      for (const m of npcs.values())
        if (m.lane === -n.lane && !m.over && m.crashT <= 0 && Math.abs(m.s - n.s) < 35) n.squeeze = m.squeeze = true;
    }

    for (const n of npcs.values()) {
      if (n.crashT > 0) { // wrecked: sit there blocking the lane, then limp off (backing away from whatever it's tangled with)
        n.v = 0; n.crashT -= dt; n.wreckT = (n.wreckT || 0) + dt;
        if (n.crashT <= 0) {
          n.over = false; n.blocker = null; n.yaw = 0;
          for (const o of occ) {
            if (o.ref === n || o.lane !== n.lane) continue;
            const need = (o.len + n.T.len) / 2 + 1.5, d = (o.s - n.s) * n.lane;
            if (Math.abs(d) < need) n.s -= n.lane * (need - d); // back off behind it
          }
        }
        continue;
      }
      n.wreckT = 0;
      if (n.dis > 0) n.dis -= dt; else if (Math.random() < n.disRate * dt) n.dis = rand(1.2, 3.2); // zoned out

      const dir = n.lane, myLane = occLane(n);
      let lead = null, gap = Infinity;
      for (const o of occ) {
        if (o.ref === n || o.lane !== myLane || (n.over && o.ref === n.blocker)) continue;
        if (n.over && !o.crashed && (o.player || o.ref.lane !== n.lane)) continue; // overtaking: ignore oncoming (they deal with us)
        if (!n.over && !o.player && o.ref.over && o.ref.lane !== n.lane && (!o.ref.reckless || o.ref.lucky)) continue; // careful oncoming overtaker: squeeze past
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
      acc = Math.max(-9, Math.min(a, acc));
      n.brake = acc < -1.5;
      n.v = Math.max(0, n.v + acc * dt);
      n.s += dir * n.v * dt;

      if (!n.over) {
        // stuck behind something stopped, or stuck behind something slow and impatient
        const leadV = lead ? lead.vs * dir : 0;
        n.stuck = lead && n.v < 1.5 && gap < 30 && leadV < 1.5 ? n.stuck + dt : 0;
        const slow = lead && !lead.crashed && gap < 45 && leadV < n.v0 * 0.8 && n.v0 - leadV > 4;
        const want = (n.stuck > 3) || (slow && Math.random() < (n.reckless ? 0.03 : 0.02));
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
          if (danger && space) { n.over = false; n.blocker = null; n.stuck = 0; continue; }
        }
        // pull back in once past the blocker with a real gap (not mid stopped-queue); 25s hard limit
        const roomy = !occ.some(o => {
          if (o.ref === n || o.lane !== n.lane) return false;
          const d = (o.s - n.s) * dir;
          return (d > -15 && d < 25) || (d >= 25 && d < 70 && Math.abs(o.vs) < 2);
        });
        if (((n.s - bS) * dir > 8 + bLen && roomy) || n.overT > 25) { n.over = false; n.blocker = null; }
      }
    }

    // collisions: anything overlapping in the same lateral position crashes (sorted sweep, cheap)
    if (cfg.crashes) {
      const list = [...npcs.values()].sort((x, y) => x.s - y.s);
      for (let i = 0; i < list.length; i++) {
        const A = list[i];
        for (let j = i + 1; j < list.length && list[j].s - A.s < 12; j++) {
          const B = list[j];
          if (A.crashT > 0 && B.crashT > 0) continue;
          if (Math.abs(latOf(A) - latOf(B)) > 1.7 || B.s - A.s > (A.T.len + B.T.len) / 2 - 0.2) continue;
          const closing = Math.abs(A.v * A.lane - B.v * B.lane);
          const why = (A.crashT > 0 || B.crashT > 0) ? 'into-wreck' : (A.lane !== B.lane ? 'head-on' : ((A.dis > 0 || B.dis > 0) ? 'distracted' : (A.over || B.over ? 'overtake' : 'following'))) + (A.reckless || B.reckless ? '/reckless' : '');
          crash(A, Math.random() < 0.5 ? 1 : -1, closing, why); crash(B, Math.random() < 0.5 ? 1 : -1, closing, why);
          B.s = Math.max(B.s, A.s + (A.T.len + B.T.len) / 2 - 0.2); // no interpenetration
        }
      }
      // an NPC driving into a player crashes too (the player gets shoved client-side)
      for (const p of players) {
        const l = laneOf(p); if (!l) continue;
        for (const n of npcs.values())
          if (n.crashT <= 0 && Math.abs(latOf(n) - p.road.lat) < 1.6 && Math.abs(n.s - p.road.s) < (n.T.len + 4.4) / 2 - 0.5)
            crash(n, Math.random() < 0.5 ? 1 : -1, Math.abs(n.v * n.lane - p.road.vs), 'into-player');
      }
    }

    // despawn: far from every player, off the start of the road, or nobody around.
    // tow truck: wrecks older than 40s and cars gridlocked for 60s get cleared once no player is close enough to see it
    for (const n of npcs.values()) {
      n.jam = n.v < 0.5 && n.crashT <= 0 ? (n.jam || 0) + dt : 0;
      const unseen = players.every(p => Math.abs(p.road.s - n.s) > 250);
      if (n.s < 0 || !players.some(p => Math.abs(p.road.s - n.s) < DESPAWN) || (unseen && (n.wreckT > 40 || n.jam > 60))) npcs.delete(n.id);
    }
  }

  // per client: NPCs within range of them, 11 bytes each
  function broadcast(players) {
    const t = clock() >>> 0;
    for (const r of players) {
      const list = [];
      for (const n of npcs.values()) if (Math.abs(n.s - r.road.s) < WIN + 200) list.push(n);
      const buf = Buffer.allocUnsafe(7 + list.length * REC);
      buf[0] = 6; buf.writeUInt32LE(t, 1); buf.writeUInt16LE(list.length, 5);
      list.forEach((n, i) => {
        const o = 7 + i * REC;
        buf.writeUInt16LE(n.id, o);
        buf.writeFloatLE(n.s, o + 2);
        buf.writeInt16LE(Math.round(n.v * n.lane * 100), o + 6);
        buf.writeInt8(Math.max(-127, Math.min(127, Math.round(latOf(n) * 40))), o + 8);
        buf[o + 9] = n.T.c | (n.color << 2) | (n.brake ? 32 : 0) | (n.crashT > 0 ? 64 : 0) | (n.lane < 0 ? 128 : 0);
        buf.writeInt8(Math.round(n.yaw / 1.5), o + 10);
      });
      send(r, buf);
    }
  }

  // a player reported hitting an NPC: hard hits wreck it, soft bumps make it brake
  function hit(p, id, v) {
    const n = npcs.get(id), now = clock();
    if (!n || !p.road || !(v > 0) || now - (p.lastHit || 0) < 150) return;
    if (Math.abs(n.s - p.road.s) > 25) return; // must actually be next to it
    p.lastHit = now;
    v = Math.min(v, 60);
    if (v > 6 && cfg.crashes) crash(n, Math.random() < 0.5 ? 1 : -1, v);
    else n.v = Math.max(0, n.v - v * 0.6);
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
      const wrecks = [...npcs.values()].filter(n => n.crashT > 0).length;
      return `traffic: ${cfg.on ? 'on' : 'off'}, density ${cfg.density}, crashes ${cfg.crashes ? 'on' : 'off'}, ${npcs.size} npcs (${wrecks} wrecked) | usage: traffic on|off|density <0-20>|crashes on|off`;
    },
    get count() { return npcs.size; },
    _sim: { npcs, populate, step, cfg, hit } // for offline tests
  };
};
