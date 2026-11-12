// npm i && node server.js     env: PORT, WORLD, TRUST_PROXY=1 (behind render/cloudflared/nginx), ADMIN_KEY, BANS (comma list of ips)
// commands (stdin locally, or: curl -H "x-admin-key: KEY" -d "list" https://host/admin):
//   list | kick <name> | ban <name> | unban <ip> | env <season|time|weather|location|world> <value> | say <msg> | traffic on|off|density <n>
// env TRAFFIC=0 disables traffic, DENSITY=<cars per km per lane> (default 4)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const readline = require('readline');

const PORT = +process.env.PORT || 8080;
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const PUBLIC_URL = (process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL || 'https://slowroads-mp.onrender.com').replace(/\/$/, '');
const PROTO = 3, TICK = 66, REC = 29, CARS = 4;
const MAX_PLAYERS = 32, PER_IP = 3, MAX_SPEED = 120, VIEW2 = 3000 ** 2, TP_COOLDOWN = 8000;
const ORIGINS = new Set(['https://slowroads.io']);
const VALID = {
  season: ['spring', 'summer', 'autumn', 'winter'],
  time: ['morning', 'day', 'evening', 'night'],
  weather: ['clear', 'overcast'],
  location: ['mars', 'moon', 'venus'],
  world: /^[A-Z]\d-[0-9a-f]{8}$/i
};
const ENV = { world: process.env.WORLD || 'A2-6e7ef869', season: 'summer', time: 'day', weather: 'clear', location: 'mars' };

// latest client code, read once (files only change on redeploy)
const PUB = path.join(__dirname, 'public');
const MOD = (() => {
  try {
    const code = fs.readFileSync(path.join(PUB, 'mod.js'), 'utf8');
    return { code, mod: +(code.match(/const MOD_VERSION = (\d+);/) || [])[1] || 0, loader: +(code.match(/const NEEDS_LOADER = (\d+);/) || [])[1] || 1 };
  } catch { return null; }
})();

// tampermonkey/violentmonkey version: same config + loader + mod as the extension, glued into one userscript that points at
// whichever server served it. built at startup so it can never drift from the extension
const USERSCRIPT = (() => {
  try {
    const read = f => fs.readFileSync(path.join(PUB, f), 'utf8');
    const loaderV = +(read('config.js').match(/SRMP_LOADER = (\d+)/) || [])[1] || 1;
    const config = read('config.js').replace(/window\.SRMP_SERVER = '[^']*';/, `window.SRMP_SERVER = '${PUBLIC_URL.replace(/^http/, 'ws')}';`);
    return `// ==UserScript==
// @name         slowroads multiplayer
// @namespace    slowroads-mp
// @version      ${MOD?.mod || 0}.${loaderV}
// @description  multiplayer, traffic and crashes for slowroads.io (unofficial)
// @match        https://slowroads.io/*
// @run-at       document-start
// @grant        none
// @inject-into  page
// @sandbox      raw
// @updateURL    ${PUBLIC_URL}/slowroads-mp.user.js
// @downloadURL  ${PUBLIC_URL}/slowroads-mp.user.js
// ==/UserScript==

window.SRMP_USERSCRIPT = true;
${config}
${read('loader.js')}
${read('mod.js')}`;
  } catch { return null; }
})();

const players = new Map(); // ws -> player
const bans = new Set((process.env.BANS || '').split(',').map(s => s.trim()).filter(Boolean)), perIp = new Map();
const t0 = Date.now(), clock = () => Date.now() - t0;
let nextId = 1;

const json = (ws, m) => ws.readyState === 1 && ws.send(JSON.stringify(m));
const bcast = (m, skip) => { const s = JSON.stringify(m); for (const p of players.values()) if (p.name && p.ws !== skip && p.ws.readyState === 1) p.ws.send(s); };
const kick = (p, why) => { json(p.ws, { t: 'error', msg: why }); p.ws.close(4001, why); };
const online = () => [...players.values()].filter(p => p.name);
const newId = () => { const used = new Set(online().map(p => p.id)); while (used.has(nextId)) nextId = nextId % 65535 + 1; const id = nextId; nextId = nextId % 65535 + 1; return id; };

// plain http for render's health check + admin endpoint, websockets upgrade on the same port
const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/admin') {
    if (!ADMIN_KEY || req.headers['x-admin-key'] !== ADMIN_KEY) { res.writeHead(403).end('forbidden\n'); return; }
    let body = '';
    req.on('data', c => { body += c; if (body.length > 500) req.destroy(); });
    req.on('end', () => res.writeHead(200, { 'content-type': 'text/plain' }).end(command(body) + '\n'));
    return;
  }
  // auto-update: the extension polls /version and pulls /mod.js; /extension.zip for loader updates
  if (req.url === '/version' || req.url === '/mod.js') {
    const cors = { 'access-control-allow-origin': 'https://slowroads.io', 'cache-control': 'no-store' };
    if (!MOD) { res.writeHead(404, cors).end(); return; }
    if (req.url === '/version') res.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify({ mod: MOD.mod, loader: MOD.loader }));
    else res.writeHead(200, { ...cors, 'content-type': 'text/javascript; charset=utf-8' }).end(MOD.code);
    return;
  }
  if (req.url === '/slowroads-mp.user.js') {
    if (!USERSCRIPT) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' }).end(USERSCRIPT);
    return;
  }
  if (req.url === '/extension.zip') {
    fs.readFile(path.join(PUB, 'extension.zip'), (err, buf) => {
      if (err) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="slowroads-mp-extension.zip"' }).end(buf);
    });
    return;
  }
  if (req.url === '/info') {
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': 'https://slowroads.io', 'cache-control': 'no-store' })
      .end(JSON.stringify({ world: ENV.world, online: online().length }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain' }).end(`slowroads mp · ${online().length} online · ${traffic.count} npcs\n`);
});
const wss = new WebSocketServer({ server, maxPayload: 512, perMessageDeflate: false });
server.listen(PORT, '0.0.0.0');

wss.on('connection', (ws, req) => {
  const ip = (TRUST_PROXY && (req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim())) || req.socket.remoteAddress;
  if (bans.has(ip)) return ws.close(4001, 'banned');
  if (!ORIGINS.has(req.headers.origin)) return ws.close(4002, 'bad origin');
  if ((perIp.get(ip) || 0) >= PER_IP) return ws.close(4003, 'too many connections from your ip');
  perIp.set(ip, (perIp.get(ip) || 0) + 1);

  const p = { ws, ip, id: 0, name: null, pos: null, rec: Buffer.alloc(REC), dirty: false, budget: MAX_SPEED, lastT: 0, lastTp: -1e9, msgs: 0, speedHits: 0, alive: true };
  players.set(ws, p);
  const helloTimer = setTimeout(() => !p.name && ws.close(4004, 'no hello'), 10000);
  ws.on('pong', () => p.alive = true);

  ws.on('message', (data, bin) => {
    if (++p.msgs > 100) return kick(p, 'spam');
    if (p.msgs > 50) return; // 15/s state + 10/s owned-NPC updates + hit reports
    if (!p.name) return bin ? ws.close(4004, 'bad hello') : hello(p, data);
    if (bin && (data.length === 28 || data.length === 34) && data[0] === 1) return state(p, data);
    if (!bin && data.length < 480) { // small json events after join: hit reports for traffic crashes
      let m; try { m = JSON.parse(data); } catch { return; }
      if (m.t === 'hit') traffic.hit(p, m);
      else if (m.t === 'claim') traffic.claim(p, m);
      else if (m.t === 'own') traffic.own(p, m);
    }
  });

  ws.on('close', () => {
    clearTimeout(helloTimer);
    players.delete(ws);
    const n = perIp.get(ip) - 1;
    n > 0 ? perIp.set(ip, n) : perIp.delete(ip);
    if (p.name) bcast({ t: 'leave', id: p.id });
  });
});

function hello(p, raw) {
  let m;
  try { m = JSON.parse(raw); } catch { return p.ws.close(4004, 'bad hello'); }
  if (m.t !== 'hello') return p.ws.close(4004, 'bad hello');
  if (m.v !== PROTO) return kick(p, 'mod is outdated, update it');
  if (online().length >= MAX_PLAYERS) return kick(p, 'server full');
  const base = String(m.name || '');
  if (!/^\w{3,16}$/.test(base)) return json(p.ws, { t: 'error', msg: 'name must be 3-16 letters, numbers or _' }), p.ws.close();
  const taken = new Set(online().map(o => o.name.toLowerCase()));
  let name = base, i = 2;
  while (taken.has(name.toLowerCase())) name = base.slice(0, 14) + i++;
  const list = online().map(o => ({ id: o.id, name: o.name, c: o.rec[28] }));
  p.id = newId();
  p.name = name;
  p.rec.writeUInt16LE(p.id, 0);
  p.rec[28] = Math.max(0, ['coupe', 'coach', 'bike', 'drift'].indexOf(m.car));
  json(p.ws, { t: 'welcome', id: p.id, name, env: ENV, players: list });
  bcast({ t: 'join', id: p.id, name, c: p.rec[28] }, p.ws);
  // extensions from before the auto-updater (no loader) can't update themselves: nag them via toasts until they reinstall
  p.outdated = !(m.loader >= (MOD?.loader || 1));
  if (p.outdated) setTimeout(() => p.outdated && players.has(p.ws) && nag(p), 20000); // loader-era clients usually update first
  console.log(`+ ${name} (${p.ip})${p.outdated ? ' [old extension]' : ''}`);
}

const nag = p => json(p.ws, { t: 'toast', msg: `no 'update ready' prompt? your extension is too old, get the new one: ${PUBLIC_URL}/extension.zip → unzip → chrome://extensions → remove old → load unpacked` });
setInterval(() => online().filter(p => p.outdated).forEach(nag), 60000);

function state(p, d) {
  const x = d.readFloatLE(1), y = d.readFloatLE(5), z = d.readFloatLE(9);
  if (!Number.isFinite(x + y + z) || Math.abs(x) > 1e7 || Math.abs(y) > 1e5 || Math.abs(z) > 1e7) return;
  const t = clock();

  // movement budget: refills at MAX_SPEED m/s, so bunched packets are fine but sustained speed hacks aren't.
  // a big jump is accepted at most once per TP_COOLDOWN (the game's reset key teleports you back to the road)
  if (p.pos) {
    p.budget = Math.min(p.budget + MAX_SPEED * Math.min((t - p.lastT) / 1000, 2), MAX_SPEED);
    const dist = Math.hypot(x - p.pos[0], y - p.pos[1], z - p.pos[2]);
    if (dist > p.budget) {
      if (t - p.lastTp < TP_COOLDOWN) { p.lastT = t; if (++p.speedHits > 350) kick(p, 'moving too fast'); return; }
      p.lastTp = t; p.budget = MAX_SPEED;
    } else p.budget -= dist;
  }
  p.lastT = t;
  p.pos = [x, y, z];

  d.copy(p.rec, 2, 1, 28);
  let vx = d.readInt16LE(21) / 100, vy = d.readInt16LE(23) / 100, vz = d.readInt16LE(25) / 100;
  const sp = Math.hypot(vx, vy, vz);
  if (sp > MAX_SPEED) {
    const k = MAX_SPEED / sp;
    p.rec.writeInt16LE(Math.round(vx * k * 100), 22); p.rec.writeInt16LE(Math.round(vy * k * 100), 24); p.rec.writeInt16LE(Math.round(vz * k * 100), 26);
  }
  if (p.rec[28] >= CARS) p.rec[28] = 0;
  p.dirty = true;

  // road position (34-byte packets): distance along the road + lateral offset, used by traffic
  if (d.length === 34) {
    const s = d.readFloatLE(28), lat = d.readInt16LE(32) / 100;
    if (Number.isFinite(s) && Math.abs(s) < 1e7) {
      const r = p.road;
      // speed along the road, smoothed from successive positions (no extra field needed)
      const vs = r && t > r.t ? Math.max(-MAX_SPEED, Math.min(MAX_SPEED, (s - r.s) / ((t - r.t) / 1000))) : 0;
      p.road = { s, lat, t, vs: r && Math.abs(s - r.s) < 200 ? r.vs * 0.6 + vs * 0.4 : 0, fresh: !r };
    } else p.road = null;
  }
}

// one batched packet per client per tick, only players that moved and are within view range
setInterval(() => {
  const dirty = online().filter(p => p.dirty && p.pos);
  if (!dirty.length) return;
  dirty.forEach(p => p.dirty = false);
  const t = clock() >>> 0;
  for (const r of online()) {
    if (r.ws.readyState !== 1 || r.ws.bufferedAmount > 65536) continue;
    const list = dirty.filter(p => p !== r && (!r.pos || (p.pos[0] - r.pos[0]) ** 2 + (p.pos[2] - r.pos[2]) ** 2 < VIEW2));
    if (!list.length) continue;
    const buf = Buffer.allocUnsafe(7 + list.length * REC);
    buf[0] = 2;
    buf.writeUInt32LE(t, 1);
    buf.writeUInt16LE(list.length, 5);
    list.forEach((p, i) => p.rec.copy(buf, 7 + i * REC));
    r.ws.send(buf);
  }
}, TICK);

const traffic = require('./traffic')({
  online, clock,
  send: (p, buf) => p.ws.readyState === 1 && p.ws.bufferedAmount < 65536 && p.ws.send(buf)
});

// map feed: every player's position to everyone once a second, no distance limit, so the minimap never loses anyone.
// op 7, per player 12 bytes: id u16, x f32, z f32, facing x/z i8 (unit vector *127)
setInterval(() => {
  const list = online().filter(p => p.pos);
  if (!list.length) return;
  const buf = Buffer.allocUnsafe(3 + list.length * 12);
  buf[0] = 7; buf.writeUInt16LE(list.length, 1);
  list.forEach((p, i) => {
    const o = 3 + i * 12, q = [13, 15, 17, 19].map(k => p.rec.readInt16LE(k + 1) / 32767);
    const [x, y, z, w] = q, fx = 1 - 2 * (y * y + z * z), fz = 2 * (x * z - w * y), fl = Math.hypot(fx, fz) || 1;
    buf.writeUInt16LE(p.id, o); buf.writeFloatLE(p.pos[0], o + 2); buf.writeFloatLE(p.pos[2], o + 6);
    buf.writeInt8(Math.round(fx / fl * 127), o + 10); buf.writeInt8(Math.round(fz / fl * 127), o + 11);
  });
  for (const r of list) if (r.ws.readyState === 1 && r.ws.bufferedAmount < 65536) r.ws.send(buf);
}, 1000);

setInterval(() => { for (const p of players.values()) p.msgs = 0; }, 1000);
setInterval(() => { for (const p of players.values()) p.speedHits = Math.max(0, p.speedHits - 100); }, 30000);
setInterval(() => {
  for (const p of players.values()) {
    if (!p.alive) { p.ws.terminate(); continue; }
    p.alive = false;
    p.ws.ping();
  }
}, 15000);

function command(line) {
  const [cmd, a, ...rest] = String(line).trim().split(/\s+/);
  const find = n => online().find(p => p.name.toLowerCase() === String(n).toLowerCase());
  if (cmd === 'list') return online().map(p => `${p.id}\t${p.name}\t${p.ip}`).join('\n') || 'nobody online';
  if (cmd === 'kick' || cmd === 'ban') {
    const p = find(a);
    if (!p) return 'not found';
    if (cmd === 'ban') bans.add(p.ip);
    kick(p, cmd === 'ban' ? 'banned' : 'kicked');
    return `${cmd}ed ${p.name}` + (cmd === 'ban' ? ` (${p.ip}, add to BANS env to keep it after restarts)` : '');
  }
  if (cmd === 'traffic') return traffic.command(a, rest[0]);
  if (cmd === 'unban') return bans.delete(a) ? 'unbanned' : 'not banned';
  if (cmd === 'say') { bcast({ t: 'toast', msg: ('[server] ' + [a, ...rest].join(' ')).slice(0, 120) }); return 'sent'; }
  if (cmd === 'env') {
    const b = rest[0], ok = VALID[a] instanceof RegExp ? VALID[a].test(b) : VALID[a]?.includes(b);
    if (!ok) return 'usage: env season|time|weather|location|world <value>';
    ENV[a] = b;
    bcast({ t: 'env', env: ENV });
    return 'env ' + JSON.stringify(ENV);
  }
  return 'commands: list, kick <name>, ban <name>, unban <ip>, env <key> <value>, say <msg>, traffic on|off|density <n>';
}
if (process.stdin.isTTY) readline.createInterface({ input: process.stdin }).on('line', l => console.log(command(l)));

console.log(`slowroads mp on :${PORT}, world ${ENV.world}`);
