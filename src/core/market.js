// Market data: region order snapshots, per-item order books and price history.

import { get, getAllPages, pool } from './esi.js';
import { idbGet, idbSet, idbDel } from './idb.js';
import { settings } from './store.js';

const SNAPSHOT_TTL = 10 * 60 * 1000;   // ESI caches market orders for 5 minutes
const HISTORY_TTL = 6 * 3600 * 1000;   // history only moves once a day
const BOOK_TTL = 90 * 1000;            // per-item books, kept fresh

const snapshotKey = (regionId, stationIds) =>
  `orders.${regionId}.${stationIds && stationIds.length ? [...stationIds].sort().join('-') : 'region'}`;

const bookMemo = new Map();

/**
 * Aggregates raw orders into one row per item while pages stream in, so the
 * full order list is never held in memory.
 */
class Aggregator {
  constructor(stationIds) {
    this.filter = stationIds && stationIds.length ? new Set(stationIds.map(Number)) : null;
    this.types = new Map();
    this.kept = 0;
    this.seen = 0;
  }

  add(orders) {
    for (const o of orders) {
      this.seen++;
      if (this.filter && !this.filter.has(o.location_id)) continue;
      this.kept++;
      let row = this.types.get(o.type_id);
      if (!row) {
        row = { t: o.type_id, asks: [], bids: [] };
        this.types.set(o.type_id, row);
      }
      (o.is_buy_order ? row.bids : row.asks).push([o.price, o.volume_remain]);
    }
  }

  /** Collapse the per-order arrays into the compact row the UI consumes. */
  finish() {
    const rows = [];
    for (const row of this.types.values()) {
      const asks = row.asks.sort((a, b) => a[0] - b[0]);
      const bids = row.bids.sort((a, b) => b[0] - a[0]);
      const askQty = asks.reduce((s, x) => s + x[1], 0);
      const bidQty = bids.reduce((s, x) => s + x[1], 0);
      rows.push({
        t: row.t,
        ask: asks.length ? asks[0][0] : null,
        bid: bids.length ? bids[0][0] : null,
        // Depth-weighted prices ignore a single lowball/troll order.
        ask5: depthPrice(asks, askQty, 0.05),
        bid5: depthPrice(bids, bidQty, 0.05),
        askQty,
        bidQty,
        askQtyNear: nearBestQty(asks, 0.05),
        bidQtyNear: nearBestQty(bids, 0.05),
        askOrders: asks.length,
        bidOrders: bids.length,
      });
    }
    return rows;
  }
}

/**
 * Aggregate a flat list of raw ESI orders into one row per item.
 * Exported so the aggregation maths can be tested without the network.
 */
export function aggregateOrders(orders, stationIds = null) {
  const agg = new Aggregator(stationIds);
  agg.add(orders);
  return agg.finish();
}

/** Price at which `share` of the book's volume has been consumed. */
function depthPrice(sorted, totalQty, share) {
  if (!sorted.length) return null;
  const target = Math.max(1, totalQty * share);
  let cum = 0;
  for (const [price, qty] of sorted) {
    cum += qty;
    if (cum >= target) return price;
  }
  return sorted[sorted.length - 1][0];
}

/** Units available within `tol` of the best price — the tradeable depth. */
function nearBestQty(sorted, tol) {
  if (!sorted.length) return 0;
  const best = sorted[0][0];
  const lo = best * (1 - tol);
  const hi = best * (1 + tol);
  let qty = 0;
  for (const [price, v] of sorted) {
    if (price < lo || price > hi) break;
    qty += v;
  }
  return qty;
}

/**
 * Best bid/ask per item for a region, optionally filtered to station(s).
 * Returns `{ regionId, stationIds, fetchedAt, rows, orderCount, byType }`.
 */
export async function fetchSnapshot({
  regionId,
  stationIds = null,
  signal = null,
  onProgress = null,
  force = false,
  maxAgeMs = SNAPSHOT_TTL,
} = {}) {
  const key = snapshotKey(regionId, stationIds);

  if (!force) {
    const cached = await idbGet(key);
    if (cached && Date.now() - cached.storedAt < maxAgeMs) {
      return hydrate(cached.value, cached.storedAt);
    }
  }

  const agg = new Aggregator(stationIds);
  let pagesDone = 0;

  await getAllPages(`/markets/${regionId}/orders/`, { order_type: 'all' }, {
    concurrency: settings().concurrency,
    signal,
    onPage: (orders) => {
      agg.add(orders);
      pagesDone++;
    },
    onProgress: onProgress
      ? (done, total) => onProgress(done, total, `Scanning orders · page ${done}/${total}`)
      : null,
  });

  const snapshot = {
    regionId: Number(regionId),
    stationIds: stationIds ? stationIds.map(Number) : null,
    rows: agg.finish(),
    orderCount: agg.kept,
    totalOrders: agg.seen,
    pages: pagesDone,
  };

  await idbSet(key, snapshot, 24 * 3600 * 1000);
  return hydrate(snapshot, Date.now());
}

function hydrate(snapshot, storedAt) {
  const byType = new Map(snapshot.rows.map((r) => [r.t, r]));
  return { ...snapshot, fetchedAt: storedAt, byType };
}

/** Age of a cached snapshot in ms, or null when there is none. */
export async function snapshotAge(regionId, stationIds) {
  const cached = await idbGet(snapshotKey(regionId, stationIds));
  return cached ? Date.now() - cached.storedAt : null;
}

export async function dropSnapshot(regionId, stationIds) {
  await idbDel(snapshotKey(regionId, stationIds));
}

/** Raw order book for a single item in one region (cheap: one request). */
export async function fetchBook(regionId, typeId, { signal = null, force = false } = {}) {
  const key = `${regionId}:${typeId}`;
  const memo = bookMemo.get(key);
  if (!force && memo && Date.now() - memo.at < BOOK_TTL) return memo.data;

  const orders = (await getAllPages(`/markets/${regionId}/orders/`, {
    order_type: 'all',
    type_id: typeId,
  }, { concurrency: 4, signal })) || [];

  const data = {
    regionId: Number(regionId),
    typeId: Number(typeId),
    orders,
    fetchedAt: Date.now(),
  };
  bookMemo.set(key, { at: Date.now(), data });
  return data;
}

/** Split a raw book into sorted buy/sell sides, optionally station-filtered. */
export function splitBook(book, stationId = null) {
  const orders = stationId ? book.orders.filter((o) => o.location_id === Number(stationId)) : book.orders;
  const buys = orders.filter((o) => o.is_buy_order).sort((a, b) => b.price - a.price);
  const sells = orders.filter((o) => !o.is_buy_order).sort((a, b) => a.price - b.price);
  return {
    buys,
    sells,
    bestBid: buys.length ? buys[0].price : null,
    bestAsk: sells.length ? sells[0].price : null,
    bidQty: buys.reduce((s, o) => s + o.volume_remain, 0),
    askQty: sells.reduce((s, o) => s + o.volume_remain, 0),
  };
}

/** Daily price history for an item in a region. Empty array when unknown. */
export async function fetchHistory(regionId, typeId, { signal = null } = {}) {
  const key = `history.${regionId}.${typeId}`;
  const cached = await idbGet(key);
  if (cached) return cached.value;

  const data = (await get(`/markets/${regionId}/history/`, { type_id: typeId }, { signal })) || [];
  await idbSet(key, data, HISTORY_TTL);
  return data;
}

/** History for many items, pooled. Returns Map<typeId, history[]>. */
export async function fetchHistories(regionId, typeIds, { signal = null, onProgress = null } = {}) {
  const out = new Map();
  await pool(typeIds, async (typeId) => {
    try {
      out.set(typeId, await fetchHistory(regionId, typeId, { signal }));
    } catch {
      out.set(typeId, []);
    }
  }, {
    concurrency: settings().concurrency,
    signal,
    onProgress: onProgress ? (done, total) => onProgress(done, total, 'Loading price history') : null,
  });
  return out;
}

/**
 * Summarise a history series over the last `days` entries:
 * average daily units + ISK, price trend, volatility and spread of the range.
 */
export function historyStats(history, days = 30) {
  if (!history || !history.length) {
    return { days: 0, avgVolume: 0, avgIsk: 0, avgPrice: 0, lastPrice: 0, trend: 0, volatility: 0, orderCount: 0 };
  }
  const slice = history.slice(-days);
  const n = slice.length;
  const sum = (f) => slice.reduce((s, d) => s + f(d), 0);

  const avgVolume = sum((d) => d.volume) / n;
  const avgPrice = sum((d) => d.average) / n;
  const avgIsk = sum((d) => d.volume * d.average) / n;
  const orderCount = sum((d) => d.order_count) / n;
  const lastPrice = slice[n - 1].average;

  // Trend: last third vs first third, so a single spike does not dominate.
  const third = Math.max(1, Math.floor(n / 3));
  const early = slice.slice(0, third).reduce((s, d) => s + d.average, 0) / third;
  const late = slice.slice(-third).reduce((s, d) => s + d.average, 0) / third;
  const trend = early > 0 ? (late - early) / early : 0;

  const variance = sum((d) => (d.average - avgPrice) ** 2) / n;
  const volatility = avgPrice > 0 ? Math.sqrt(variance) / avgPrice : 0;

  return { days: n, avgVolume, avgIsk, avgPrice, lastPrice, trend, volatility, orderCount };
}

/** Jump count between two systems (shortest route), cached for a week. */
export async function routeJumps(originSystemId, destSystemId, { signal = null } = {}) {
  if (originSystemId === destSystemId) return 0;
  const key = `route.${originSystemId}.${destSystemId}`;
  const cached = await idbGet(key);
  if (cached) return cached.value;
  try {
    const route = await get(`/route/${originSystemId}/${destSystemId}/`, { flag: 'shortest' }, { signal });
    const jumps = Array.isArray(route) ? Math.max(0, route.length - 1) : null;
    if (jumps != null) await idbSet(key, jumps, 7 * 24 * 3600 * 1000);
    return jumps;
  } catch {
    return null;
  }
}
