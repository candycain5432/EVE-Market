// Item type index: fuzzy name search, name lookup and per-type details (volume).
//
// ESI has no public fuzzy search route, so the index is built once from
// /markets/prices/ (every type with a market price) + /universe/names/ and
// cached in IndexedDB.

import { get, post, pool } from './esi.js';
import { idbGet, idbSet } from './idb.js';
import { settings } from './store.js';

const INDEX_KEY = 'types.index.v2';
const INDEX_TTL = 21 * 24 * 3600 * 1000;   // 3 weeks
const DETAIL_KEY = (id) => `type.detail.${id}`;
const DETAIL_TTL = 60 * 24 * 3600 * 1000;  // types change rarely
const NAME_BATCH = 1000;

/** @type {{ids:number[], names:string[], lower:string[]} | null} */
let index = null;
let byId = new Map();
let building = null;

function adopt(ids, names) {
  index = { ids, names, lower: names.map((n) => n.toLowerCase()) };
  byId = new Map(ids.map((id, i) => [id, names[i]]));
  return index;
}

async function persist() {
  if (!index) return;
  await idbSet(INDEX_KEY, { ids: index.ids, names: index.names }, INDEX_TTL);
}

/** Resolve ids -> names via /universe/names/, splitting batches that 404. */
async function resolveBatch(ids, signal) {
  if (!ids.length) return [];
  const data = await post('/universe/names/', ids, {}, { signal });
  if (data) return data;
  // A single bad id poisons the whole batch; bisect to salvage the rest.
  if (ids.length === 1) return [];
  const mid = Math.floor(ids.length / 2);
  const [a, b] = await Promise.all([
    resolveBatch(ids.slice(0, mid), signal),
    resolveBatch(ids.slice(mid), signal),
  ]);
  return [...a, ...b];
}

/**
 * Build (or load) the searchable type index.
 * `onProgress(done, total, label)` reports build progress.
 */
export async function ensureTypeIndex({ signal = null, onProgress = null, force = false } = {}) {
  if (index && !force) return index;
  if (building) return building;

  building = (async () => {
    if (!force) {
      const cached = await idbGet(INDEX_KEY);
      if (cached && cached.value && cached.value.ids && cached.value.ids.length) {
        return adopt(cached.value.ids, cached.value.names);
      }
    }

    if (onProgress) onProgress(0, 1, 'Fetching market prices');
    const prices = (await get('/markets/prices/', {}, { signal })) || [];
    const ids = [...new Set(prices.map((p) => p.type_id))].sort((a, b) => a - b);

    const batches = [];
    for (let i = 0; i < ids.length; i += NAME_BATCH) batches.push(ids.slice(i, i + NAME_BATCH));

    const resolvedIds = [];
    const resolvedNames = [];
    let done = 0;
    await pool(batches, async (batch) => {
      const rows = await resolveBatch(batch, signal);
      for (const row of rows) {
        if (row && row.category === 'inventory_type' && row.name) {
          resolvedIds.push(row.id);
          resolvedNames.push(row.name);
        }
      }
      done++;
      if (onProgress) onProgress(done, batches.length, 'Building item index');
    }, { concurrency: Math.min(6, settings().concurrency), signal });

    const order = resolvedIds.map((_, i) => i).sort((a, b) => resolvedNames[a].localeCompare(resolvedNames[b]));
    adopt(order.map((i) => resolvedIds[i]), order.map((i) => resolvedNames[i]));
    await persist();
    return index;
  })();

  try {
    return await building;
  } finally {
    building = null;
  }
}

export function indexSize() {
  return index ? index.ids.length : 0;
}

export function isIndexed() {
  return !!index;
}

/**
 * Fuzzy-ish item search: exact match first, then prefix, then substring,
 * then all-words-present. Ranked shortest-name-first within each tier.
 */
export function searchTypes(query, limit = 40) {
  if (!index) return [];
  const q = String(query || '').trim().toLowerCase();
  if (q.length < 2) return [];
  const words = q.split(/\s+/).filter(Boolean);
  const hits = [];

  for (let i = 0; i < index.lower.length; i++) {
    const name = index.lower[i];
    let rank;
    if (name === q) rank = 0;
    else if (name.startsWith(q)) rank = 1;
    else if (name.includes(q)) rank = 2;
    else if (words.length > 1 && words.every((w) => name.includes(w))) rank = 3;
    else continue;
    hits.push({ id: index.ids[i], name: index.names[i], rank, len: name.length });
    if (hits.length > 4000) break;
  }

  hits.sort((a, b) => a.rank - b.rank || a.len - b.len || a.name.localeCompare(b.name));
  return hits.slice(0, limit);
}

/** Synchronous name lookup; returns null when the id is not in the index. */
export function nameOf(typeId) {
  return byId.get(Number(typeId)) || null;
}

/** Name lookup that falls back to the API (and caches the result). */
export async function typeName(typeId, signal = null) {
  const cached = nameOf(typeId);
  if (cached) return cached;
  const detail = await typeDetail(typeId, signal);
  return detail ? detail.name : `Type ${typeId}`;
}

/**
 * Learn names for ids that were not in the index (new items, non-priced items).
 * Mutates the in-memory index and persists it.
 */
export async function learnNames(typeIds, { signal = null, onProgress = null } = {}) {
  if (!index) await ensureTypeIndex({ signal });
  const unknown = [...new Set(typeIds.map(Number))].filter((id) => id && !byId.has(id));
  if (!unknown.length) return 0;

  const batches = [];
  for (let i = 0; i < unknown.length; i += NAME_BATCH) batches.push(unknown.slice(i, i + NAME_BATCH));

  let learned = 0;
  let done = 0;
  await pool(batches, async (batch) => {
    const rows = await resolveBatch(batch, signal);
    for (const row of rows) {
      if (row && row.category === 'inventory_type' && row.name && !byId.has(row.id)) {
        index.ids.push(row.id);
        index.names.push(row.name);
        index.lower.push(row.name.toLowerCase());
        byId.set(row.id, row.name);
        learned++;
      }
    }
    done++;
    if (onProgress) onProgress(done, batches.length, 'Resolving new item names');
  }, { concurrency: Math.min(4, settings().concurrency), signal });

  if (learned) await persist();
  return learned;
}

/** Full type record, cached long-term. Returns null for unknown ids. */
export async function typeDetail(typeId, signal = null) {
  const id = Number(typeId);
  const cached = await idbGet(DETAIL_KEY(id));
  if (cached) return cached.value;

  const data = await get(`/universe/types/${id}/`, {}, { signal });
  if (!data) return null;

  const detail = {
    id,
    name: data.name,
    volume: data.volume,
    // Ships/containers pack down; packaged_volume is what a hauler actually carries.
    packagedVolume: data.packaged_volume != null ? data.packaged_volume : data.volume,
    groupId: data.group_id,
    marketGroupId: data.market_group_id,
    description: data.description,
    capacity: data.capacity,
    published: data.published,
  };
  await idbSet(DETAIL_KEY(id), detail, DETAIL_TTL);
  if (detail.name && !byId.has(id)) byId.set(id, detail.name);
  return detail;
}

/** Details for many types at once, honouring the concurrency setting. */
export async function typeDetails(typeIds, { signal = null, onProgress = null } = {}) {
  const ids = [...new Set(typeIds.map(Number))];
  const out = new Map();
  await pool(ids, async (id) => {
    try {
      const detail = await typeDetail(id, signal);
      if (detail) out.set(id, detail);
    } catch { /* one missing type should not sink the batch */ }
  }, {
    concurrency: settings().concurrency,
    signal,
    onProgress: onProgress ? (done, total) => onProgress(done, total, 'Loading item volumes') : null,
  });
  return out;
}
