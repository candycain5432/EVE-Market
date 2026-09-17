#!/usr/bin/env node
// Deterministic stand-in for ESI, used by the end-to-end test and handy for
// working on the UI offline. It speaks the same shapes as the real API:
// paginated market orders with an x-pages header, market history, type names
// and the routes this app touches.
//
//   node tools/mock-esi.js [port]
//
// Point the app at it from the browser console:
//   localStorage.setItem('cm.esi.root', 'http://localhost:8788'); location.reload()

import http from 'node:http';

const PORT = Number(process.argv[2] || 8788);

const REGIONS = {
  10000002: { station: 60003760, name: 'The Forge', bias: 1.00 },
  10000043: { station: 60008494, name: 'Domain', bias: 1.14 },
  10000032: { station: 60011866, name: 'Sinq Laison', bias: 1.08 },
  10000030: { station: 60004588, name: 'Heimatar', bias: 1.11 },
  10000042: { station: 60005686, name: 'Metropolis', bias: 1.06 },
};

const TYPE_COUNT = 420;
const FIRST_TYPE = 34;
const TYPE_IDS = Array.from({ length: TYPE_COUNT }, (_, i) => FIRST_TYPE + i * 7);
const PAGE_SIZE = 1000;

const NOUNS = ['Tritanium', 'Pyerite', 'Mexallon', 'Isogen', 'Nocxium', 'Zydrine', 'Megacyte', 'Morphite',
  'Antimatter Charge', 'Scourge Rocket', 'Warrior II', 'Hobgoblin II', 'Damage Control II', 'Large Shield Extender II',
  'Gyrostabilizer II', 'Heat Sink II', 'Magnetic Field Stabilizer II', 'Ballistic Control System II',
  'Caldari Navy Antimatter', 'Republic Fleet EMP', 'Imperial Navy Multifrequency', 'Federation Navy Antimatter',
  'Nanite Repair Paste', 'Cap Booster 800', 'Mobile Depot', 'Core Probe Launcher II', 'Rifter', 'Merlin', 'Punisher',
  'Vexor Navy Issue', 'Drake', 'Hurricane', 'Megathron', 'Raven', 'Apocalypse', 'Tengu', 'Loki', 'Proteus'];
const SUFFIX = ['', ' Blueprint', ' I', ' II', ' Compressed', ' Crate', ' Kit', ' Module'];

/** Cheap deterministic hash -> [0,1). */
function rand(seed) {
  const x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

function typeName(typeId) {
  const noun = NOUNS[typeId % NOUNS.length];
  const suffix = SUFFIX[Math.floor(rand(typeId * 3) * SUFFIX.length)];
  return `${noun}${suffix} ${typeId}`;
}

function basePrice(typeId) {
  const magnitude = 10 ** (1 + Math.floor(rand(typeId) * 6));
  return Math.round((0.5 + rand(typeId * 1.7) * 9.5) * magnitude * 100) / 100;
}

function typeVolume(typeId) {
  const roll = rand(typeId * 5.3);
  if (roll < 0.35) return 0.01;
  if (roll < 0.7) return Math.round(rand(typeId * 2.1) * 50) / 10 + 0.5;
  if (roll < 0.95) return Math.round(rand(typeId * 2.9) * 500) + 5;
  return 27289;
}

/** Orders for one type at one region's hub station, plus a little region noise. */
function ordersFor(regionId, typeId) {
  const region = REGIONS[regionId];
  const base = basePrice(typeId) * region.bias * (0.85 + rand(typeId + regionId) * 0.3);
  const spread = 0.04 + rand(typeId * 1.3 + regionId) * 0.35;
  const sellCount = 2 + Math.floor(rand(typeId * 7 + regionId) * 12);
  const buyCount = 2 + Math.floor(rand(typeId * 11 + regionId) * 12);
  const out = [];
  let orderId = typeId * 1000 + regionId % 1000;

  for (let i = 0; i < sellCount; i++) {
    const price = base * (1 + spread / 2) * (1 + i * 0.012 + rand(orderId + i) * 0.01);
    out.push(mkOrder(orderId++, typeId, region.station, price, false, i));
  }
  for (let i = 0; i < buyCount; i++) {
    const price = base * (1 - spread / 2) * (1 - i * 0.012 - rand(orderId + i) * 0.01);
    out.push(mkOrder(orderId++, typeId, region.station, price, true, i));
  }
  // A couple of orders in a player structure, to prove station filtering works.
  if (rand(typeId + 0.5) > 0.7) {
    out.push(mkOrder(orderId++, typeId, 1035466617946, base * 0.8, false, 0));
    out.push(mkOrder(orderId++, typeId, 1035466617946, base * 0.6, true, 0));
  }
  return out;
}

function mkOrder(orderId, typeId, locationId, price, isBuy, i) {
  return {
    order_id: orderId,
    type_id: typeId,
    location_id: locationId,
    system_id: 30000142,
    region_id: 10000002,
    price: Math.round(price * 100) / 100,
    volume_remain: Math.max(1, Math.round((1 + rand(orderId) * 400) * (i === 0 ? 0.3 : 1))),
    volume_total: 1000,
    min_volume: 1,
    is_buy_order: isBuy,
    duration: 90,
    issued: new Date(Date.now() - rand(orderId) * 6e8).toISOString(),
    range: isBuy ? 'region' : 'station',
  };
}

function historyFor(regionId, typeId, days = 400) {
  const base = basePrice(typeId) * REGIONS[regionId].bias;
  const rows = [];
  let price = base;
  for (let d = days; d > 0; d--) {
    const date = new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
    price *= 1 + (rand(typeId + d) - 0.5) * 0.06;
    const volume = Math.round((50 + rand(typeId * d) * 5000) * (1 + rand(typeId) * 4));
    rows.push({
      date,
      average: Math.round(price * 100) / 100,
      highest: Math.round(price * 1.04 * 100) / 100,
      lowest: Math.round(price * 0.96 * 100) / 100,
      order_count: 5 + Math.round(rand(typeId + d * 2) * 400),
      volume,
    });
  }
  return rows;
}

function send(res, status, body, extraHeaders = {}) {
  const payload = body == null ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Compatibility-Date, Accept',
    'Access-Control-Expose-Headers': 'x-pages, x-esi-error-limit-remain, x-esi-error-limit-reset, expires',
    'Cache-Control': 'public, max-age=30',
    ...extraHeaders,
  });
  res.end(payload);
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, null);

  const url = new URL(req.url, `http://localhost:${PORT}`);
  // Accept both addressing schemes so either probe succeeds.
  const path = url.pathname.replace(/^\/(latest|v\d+)/, '');

  if (path === '/status/') {
    return send(res, 200, { players: 24135, server_version: 'mock-1.0', start_time: new Date().toISOString() });
  }

  if (path === '/markets/prices/') {
    return send(res, 200, TYPE_IDS.map((id) => ({
      type_id: id,
      average_price: basePrice(id),
      adjusted_price: basePrice(id) * 0.98,
    })));
  }

  if (path === '/universe/names/' && req.method === 'POST') {
    const body = await readBody(req);
    const ids = JSON.parse(body || '[]');
    return send(res, 200, ids.map((id) => ({ id, name: typeName(id), category: 'inventory_type' })));
  }

  let m = path.match(/^\/universe\/types\/(\d+)\/$/);
  if (m) {
    const id = Number(m[1]);
    return send(res, 200, {
      type_id: id,
      name: typeName(id),
      description: 'Mock item used by the offline test harness.',
      volume: typeVolume(id),
      packaged_volume: typeVolume(id),
      group_id: 18,
      market_group_id: 1857,
      published: true,
    });
  }

  m = path.match(/^\/markets\/(\d+)\/orders\/$/);
  if (m) {
    const regionId = Number(m[1]);
    if (!REGIONS[regionId]) return send(res, 404, { error: 'Unknown region' });
    const typeId = url.searchParams.get('type_id');
    if (typeId) return send(res, 200, ordersFor(regionId, Number(typeId)), { 'x-pages': '1' });

    const all = TYPE_IDS.flatMap((id) => ordersFor(regionId, id));
    const pages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
    const page = Number(url.searchParams.get('page') || 1);
    if (page > pages) return send(res, 200, [], { 'x-pages': String(pages) });
    return send(res, 200, all.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), { 'x-pages': String(pages) });
  }

  m = path.match(/^\/markets\/(\d+)\/history\/$/);
  if (m) {
    const typeId = Number(url.searchParams.get('type_id'));
    if (!typeId) return send(res, 400, { error: 'type_id required' });
    return send(res, 200, historyFor(Number(m[1]), typeId));
  }

  m = path.match(/^\/route\/(\d+)\/(\d+)\/$/);
  if (m) {
    const hops = 4 + (Number(m[1]) + Number(m[2])) % 12;
    return send(res, 200, Array.from({ length: hops + 1 }, (_, i) => 30000142 + i));
  }

  return send(res, 404, { error: `No mock route for ${path}` });
});

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

server.listen(PORT, () => {
  console.log(`mock ESI listening on http://localhost:${PORT} (${TYPE_IDS.length} types, ${Object.keys(REGIONS).length} regions)`);
});
