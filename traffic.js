// shared traffic: a 1D sim along the road. every client builds the same road from the seed, so the server only tracks
// distance-along-road (s, metres) + lane per NPC and clients turn that into world positions. tiny CPU + bandwidth.
//   lane +1 drives toward increasing s and sits at lateral -1.6m; lane -1 is oncoming at +1.6m
//   NPCs follow with IDM (intelligent driver model), queue behind players/NPCs, overtake a blocker when the other lane is clear

const LANE = 1.6, WIN = 2000, SPAWN_MIN = 1100, DESPAWN = 2600, MAX_NPC = 160, REC = 10, SIM_HZ = 10, SEND_HZ = 5;
const TYPES = [ // c = car index (coupe/coach/bike), w = spawn weight, v = desired speed range m/s, len = length m
  { c: 0, w: 0.62, v: [21, 29], len: 4.4, a: 1.6 },
  { c: 1, w: 0.18, v: [16, 22], len: 10.5, a: 0.9 },
  { c: 2, w: 0.20, v: [19, 30], len: 2.2, a: 2.2 }
];
const pickType = () => { let r = Math.random(); for (const t of TYPES) if ((r -= t.w) <= 0) return t; return TYPES[0]; };
const rand = (a, b) => a + Math.random() * (b - a);

module.exports = function traffic({ online, clock, send }) {
  const cfg = { on: process.env.TRAFFIC !== '0', density: +process.env.DENSITY || 4 }; // cars per km per lane
  const npcs = new Map();
  let nextId = 1;

  const roadPlayers = () => online().filter(p => p.road && clock() - p.road.t < 3000);
  // which lane a player occupies (null = off the road)
  const laneOf = p => Math.abs(p.road.lat) > 3.6 ? null : (p.road.lat < 0 ? 1 : -1);

  const spawn = (s, lane) => {
    const T = pickType(), v0 = rand(...T.v);
    const id = nextId; nextId = nextId % 65535 + 1;
    npcs.set(id, { id, T, lane, s, v: v0 * rand(0.8, 1), v0, color: (Math.random() * 8) | 0, over: false, stuck: 0, blocker: null, brake: false });
  };

  const occupied = (lane, s, gap, list) => list.some(o => o.lane === lane && Math.abs(o.s - s) < gap);

  function populate(players) {
    const target = Math.round(cfg.density * 2 * WIN / 1000);
    for (const p of players) {
      for (const lane of [1, -1]) {
        if (npcs.size >= MAX_NPC) return;
        const vehicles = [...npcs.values()];
        const have = vehicles.filter(n => n.lane === lane && Math.abs(n.s - p.road.s) < WIN).length;
        let tries = p.road.fresh ? target - have : Math.min(2, target - have); // first time: fill the window at once
        const minDist = p.road.fresh ? 250 : SPAWN_MIN; // otherwise only spawn out of sight
        while (tries-- > 0 && npcs.size < MAX_NPC) {
          const s = p.road.s + (Math.random() < 0.5 ? -1 : 1) * rand(minDist, WIN);
          if (s < 30) continue;
          if (players.some(o => Math.abs(o.road.s - s) < minDist)) continue;
          if (occupied(lane, s, 60, [...npcs.values()])) continue;
          spawn(s, lane);
        }
      }
      p.road.fresh = false;
    }
  }

  function step(dt, players) {
    // everything that occupies a lane right now: NPCs (an overtaking NPC sits in the other lane) + players on the road
    const occ = [];
    for (const n of npcs.values()) occ.push({ ref: n, lane: n.over ? -n.lane : n.lane, s: n.s, vs: n.v * n.lane, len: n.T.len });
    for (const p of players) { const l = laneOf(p); if (l) occ.push({ ref: p, player: true, lane: l, s: p.road.s, vs: p.road.vs, len: 4.4 }); }

    // an overtaker meeting oncoming cars: it hugs the centre line, they squeeze onto their shoulder and slow, both pass
    for (const n of npcs.values()) n.squeeze = false;
    for (const n of npcs.values()) {
      if (!n.over) continue;
      for (const m of npcs.values())
        if (m.lane === -n.lane && !m.over && Math.abs(m.s - n.s) < 35) { n.squeeze = m.squeeze = true; }
    }

    for (const n of npcs.values()) {
      const dir = n.lane, myLane = n.over ? -n.lane : n.lane;
      let lead = null, gap = Infinity;
      for (const o of occ) {
        if (o.ref === n || o.lane !== myLane || (n.over && o.ref === n.blocker)) continue;
        if (n.over && (o.player || o.ref.lane !== n.lane)) continue; // overtaking: oncoming lane was clear when we pulled out
        if (!n.over && !o.player && o.ref.over && o.ref.lane !== n.lane) continue; // oncoming overtaker: squeeze past instead of braking
        const d = (o.s - n.s) * dir;
        if (d <= 0 || d > 300) continue;
        const g = d - (o.len + n.T.len) / 2;
        if (g < gap) { gap = g; lead = o; }
      }
      // IDM
      const a = n.T.a, b = 2.5, T = 1.3, s0 = 5;
      const v0 = n.squeeze && !n.over ? n.v0 * 0.55 : n.v0;
      let acc = a * (1 - (n.v / v0) ** 4);
      if (lead) {
        const dv = n.v - lead.vs * dir;
        const sStar = s0 + Math.max(0, n.v * T + n.v * dv / (2 * Math.sqrt(a * b)));
        acc -= a * (sStar / Math.max(gap, 0.5)) ** 2;
      }
      acc = Math.max(-9, Math.min(a, acc));
      n.brake = acc < -1.5;
      n.v = Math.max(0, n.v + acc * dt);
      n.s += dir * n.v * dt;

      // overtaking a stopped blocker (a parked player or a stalled queue) once the other lane is clear
      if (!n.over) {
        n.stuck = lead && n.v < 1.5 && gap < 30 && lead.vs * dir < 1.5 ? n.stuck + dt : 0;
        const otherOut = [...npcs.values()].some(m => m.over && m.lane === n.lane && Math.abs(m.s - n.s) < 60); // one at a time
        if (n.stuck > 3 && !otherOut && !occ.some(o => o.lane === -n.lane && (o.s - n.s) * dir > -20 && (o.s - n.s) * dir < 220)) {
          n.over = true; n.blocker = lead.ref; n.overS = lead.s; n.overT = 0; n.stuck = 0;
        }
      } else {
        // pull back in once past where the blocker was AND there's a real gap (not the middle of a stopped queue); 25s hard limit
        n.overT += dt;
        // abort if oncoming traffic shows up before we've reached the blocker (once alongside we're committed, they brake)
        if ((n.s - n.overS) * dir < 0) {
          const danger = occ.some(o => {
            if (o.ref === n || o.lane !== -n.lane || (!o.player && o.ref.lane === n.lane)) return false;
            const d = (o.s - n.s) * dir;
            return d > 0 && d < (n.v - o.vs * dir) * 3 + 25;
          });
          const space = !occ.some(o => o.ref !== n && o.lane === n.lane && Math.abs(o.s - n.s) < (o.len + n.T.len) / 2 + 2);
          if (danger && space) { n.over = false; n.blocker = null; n.stuck = 0; continue; }
        }
        const roomy = !occ.some(o => {
          if (o.ref === n || o.lane !== n.lane) return false;
          const d = (o.s - n.s) * dir;
          return (d > -15 && d < 25) || (d >= 25 && d < 70 && Math.abs(o.vs) < 2);
        });
        if (((n.s - n.overS) * dir > 18 && roomy) || n.overT > 25) { n.over = false; n.blocker = null; }
      }
    }

    // despawn: far from every player, off the start of the road, or nobody around
    for (const n of npcs.values())
      if (n.s < 0 || !players.some(p => Math.abs(p.road.s - n.s) < DESPAWN)) npcs.delete(n.id);
  }

  // per client: NPCs within range of them, 10 bytes each
  function broadcast(players) {
    const t = clock() >>> 0;
    for (const r of players) {
      const list = [];
      for (const n of npcs.values()) if (Math.abs(n.s - r.road.s) < WIN + 200) list.push(n);
      const buf = Buffer.allocUnsafe(7 + list.length * REC);
      buf[0] = 4; buf.writeUInt32LE(t, 1); buf.writeUInt16LE(list.length, 5);
      list.forEach((n, i) => {
        const o = 7 + i * REC;
        buf.writeUInt16LE(n.id, o);
        buf.writeFloatLE(n.s, o + 2);
        buf.writeInt16LE(Math.round(n.v * n.lane * 100), o + 6);
        const lat = -LANE * (n.over ? -n.lane : n.lane) * (n.squeeze ? (n.over ? 0.15 : 1.85) : 1);
        buf.writeInt8(Math.round(lat * 40), o + 8);
        buf[o + 9] = n.T.c | (n.color << 2) | (n.brake ? 32 : 0);
      });
      send(r, buf);
    }
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
    command(a, b) {
      if (a === 'on' || a === 'off') { cfg.on = a === 'on'; if (!cfg.on) { npcs.clear(); broadcast(roadPlayers()); } return 'traffic ' + a; }
      if (a === 'density' && +b >= 0 && +b <= 20) { cfg.density = +b; return 'density ' + b + ' cars/km/lane'; }
      return `traffic: ${cfg.on ? 'on' : 'off'}, density ${cfg.density}, ${npcs.size} npcs | usage: traffic on|off|density <0-20>`;
    },
    get count() { return npcs.size; },
    _sim: { npcs, populate, step, cfg } // for offline tests
  };
};
