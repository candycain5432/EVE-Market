// ESI client: endpoint-style probing, retries, error-limit backoff, pagination
// and a small concurrency pool. Everything runs in the browser against
// https://esi.evetech.net, which serves `Access-Control-Allow-Origin: *`.

import { settings } from './store.js';

const DEFAULT_ROOT = 'https://esi.evetech.net';

/**
 * The API root. Overridable from the console via
 * `localStorage.setItem('cm.esi.root', 'http://localhost:8788')`, which is how
 * the offline test harness points the app at a mock ESI. Deliberately not a URL
 * parameter, so a crafted link cannot redirect anyone's client elsewhere.
 */
const ROOT = (() => {
  try {
    return localStorage.getItem('cm.esi.root') || DEFAULT_ROOT;
  } catch {
    return DEFAULT_ROOT;
  }
})();
const COMPAT_DATE = '2025-08-26';
const MODE_KEY = 'cm.esi.mode.v1';
const MODE_TTL = 6 * 3600 * 1000;

/**
 * CCP has run two addressing schemes for ESI: versioned path prefixes
 * (`/latest/...`, `/v1/...`) and a compatibility-date scheme on the bare root.
 * Rather than betting on one, probe them and remember what answered.
 */
const MODES = [
  { id: 'latest', prefix: '/latest', params: {}, headers: {} },
  { id: 'compat-query', prefix: '', params: { compatibility_date: COMPAT_DATE }, headers: {} },
  { id: 'compat-header', prefix: '', params: {}, headers: { 'X-Compatibility-Date': COMPAT_DATE } },
];

let activeMode = null;
let probePromise = null;

export class EsiError extends Error {
  constructor(message, { status = 0, path = '', body = null } = {}) {
    super(message);
    this.name = 'EsiError';
    this.status = status;
    this.path = path;
    this.body = body;
  }
}

function modeById(id) {
  return MODES.find((m) => m.id === id) || null;
}

function buildUrl(mode, path, params = {}) {
  const url = new URL(`${ROOT}${mode.prefix}${path}`);
  url.searchParams.set('datasource', 'tranquility');
  for (const [k, v] of Object.entries({ ...mode.params, ...params })) {
    if (v == null || v === '') continue;
    url.searchParams.set(k, v);
  }
  // Optional courtesy identification. Browsers cannot set User-Agent, and ESI
  // accepts this hint as a query parameter.
  const contact = settings().contact;
  if (contact) url.searchParams.set('user_agent', `capsuleer-market (${contact})`);
  return url.toString();
}

/** Decide which addressing scheme works, once per session (cached 6h). */
export async function detectMode() {
  if (activeMode) return activeMode;
  if (probePromise) return probePromise;

  const forced = settings().esiMode;
  if (forced && forced !== 'auto' && modeById(forced)) {
    activeMode = modeById(forced);
    return activeMode;
  }

  try {
    const saved = JSON.parse(localStorage.getItem(MODE_KEY) || 'null');
    if (saved && Date.now() - saved.t < MODE_TTL && modeById(saved.id)) {
      activeMode = modeById(saved.id);
      return activeMode;
    }
  } catch { /* ignore */ }

  probePromise = (async () => {
    const failures = [];
    for (const mode of MODES) {
      try {
        const res = await fetch(buildUrl(mode, '/status/'), {
          headers: { Accept: 'application/json', ...mode.headers },
        });
        if (res.ok) {
          activeMode = mode;
          try { localStorage.setItem(MODE_KEY, JSON.stringify({ id: mode.id, t: Date.now() })); } catch { /* ignore */ }
          return mode;
        }
        failures.push(`${mode.id}: HTTP ${res.status}`);
      } catch (err) {
        failures.push(`${mode.id}: ${err.message}`);
      }
    }
    // Nothing answered: fall back to the classic scheme so the app still tries.
    activeMode = MODES[0];
    throw new EsiError(`Could not reach ESI (${failures.join('; ')})`, { path: '/status/' });
  })();

  try {
    return await probePromise;
  } finally {
    probePromise = null;
  }
}

export function currentModeId() {
  return activeMode ? activeMode.id : null;
}

export function resetMode() {
  activeMode = null;
  try { localStorage.removeItem(MODE_KEY); } catch { /* ignore */ }
}

// ---- error limit -----------------------------------------------------------

let errorLimitUntil = 0;

function noteErrorLimit(res) {
  const remain = Number(res.headers.get('x-esi-error-limit-remain'));
  const reset = Number(res.headers.get('x-esi-error-limit-reset'));
  if (Number.isFinite(remain) && remain <= 5) {
    const waitSec = Number.isFinite(reset) && reset > 0 ? reset : 30;
    errorLimitUntil = Date.now() + waitSec * 1000;
  }
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  if (signal) {
    signal.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
  }
});

async function respectErrorLimit(signal) {
  const wait = errorLimitUntil - Date.now();
  if (wait > 0) await sleep(Math.min(wait, 60000), signal);
}

// ---- core request ----------------------------------------------------------

/**
 * Perform one ESI request with retries.
 * Returns `{ data, headers, status }`.
 */
export async function request(path, {
  params = {},
  method = 'GET',
  body = null,
  signal = null,
  retries = 3,
  timeoutMs = 30000,
} = {}) {
  const mode = await detectMode();
  let attempt = 0;

  for (;;) {
    await respectErrorLimit(signal);
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    if (signal) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      signal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);

    try {
      const res = await fetch(buildUrl(mode, path, params), {
        method,
        signal: ctrl.signal,
        headers: {
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...mode.headers,
        },
        body: body ? JSON.stringify(body) : undefined,
      });

      if (!res.ok) noteErrorLimit(res);

      if (res.status === 404) {
        return { data: null, headers: res.headers, status: 404 };
      }

      if (res.status === 420 || res.status === 429) {
        const reset = Number(res.headers.get('x-esi-error-limit-reset')) || 30;
        errorLimitUntil = Date.now() + reset * 1000;
        if (attempt++ < retries) { await sleep(Math.min(reset * 1000, 60000), signal); continue; }
        throw new EsiError('ESI error limit reached — pause for a minute and retry', { status: res.status, path });
      }

      if (res.status >= 500 || res.status === 408) {
        if (attempt++ < retries) { await sleep(400 * 2 ** attempt + Math.random() * 300, signal); continue; }
        throw new EsiError(`ESI server error (HTTP ${res.status})`, { status: res.status, path });
      }

      if (!res.ok) {
        let detail = '';
        try { detail = (await res.json()).error || ''; } catch { /* body may be empty */ }
        throw new EsiError(`HTTP ${res.status} on ${path}${detail ? ` — ${detail}` : ''}`, { status: res.status, path });
      }

      const data = res.status === 204 ? null : await res.json();
      return { data, headers: res.headers, status: res.status };
    } catch (err) {
      if (err.name === 'AbortError') {
        // A caller-driven cancel propagates; a timeout is retryable.
        if (signal && signal.aborted) throw err;
        if (attempt++ < retries) { await sleep(500 * attempt, signal); continue; }
        throw new EsiError(`Request timed out: ${path}`, { path });
      }
      if (err instanceof EsiError) throw err;
      if (attempt++ < retries) { await sleep(400 * 2 ** attempt + Math.random() * 300, signal); continue; }
      throw new EsiError(`Network error on ${path}: ${err.message}`, { path });
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }
}

/** GET returning just the parsed body. */
export async function get(path, params = {}, opts = {}) {
  const { data } = await request(path, { ...opts, params });
  return data;
}

/** POST returning just the parsed body. */
export async function post(path, body, params = {}, opts = {}) {
  const { data } = await request(path, { ...opts, method: 'POST', body, params });
  return data;
}

// ---- concurrency pool ------------------------------------------------------

/**
 * Map `items` through async `fn` with bounded concurrency.
 * `onProgress(done, total)` fires after each settled item.
 */
export async function pool(items, fn, { concurrency = 8, signal = null, onProgress = null } = {}) {
  const list = [...items];
  const results = new Array(list.length);
  let next = 0;
  let done = 0;

  const worker = async () => {
    for (;;) {
      if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const i = next++;
      if (i >= list.length) return;
      results[i] = await fn(list[i], i);
      done++;
      if (onProgress) onProgress(done, list.length);
    }
  };

  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, list.length)) }, worker);
  await Promise.all(workers);
  return results;
}

/**
 * Fetch every page of a paginated endpoint.
 * Uses the `x-pages` header when the browser can see it, and otherwise walks
 * pages until one comes back empty.
 */
export async function getAllPages(path, params = {}, {
  concurrency = 10,
  signal = null,
  onProgress = null,
  onPage = null,
  maxPages = 2000,
} = {}) {
  const first = await request(path, { params: { ...params, page: 1 }, signal });
  const firstData = first.data || [];
  if (onPage) onPage(firstData, 1);

  const pagesHeader = Number(first.headers.get('x-pages'));
  const out = onPage ? null : [...firstData];

  if (Number.isFinite(pagesHeader) && pagesHeader >= 1) {
    const total = Math.min(pagesHeader, maxPages);
    if (onProgress) onProgress(1, total);
    if (total <= 1) return out;

    const pages = Array.from({ length: total - 1 }, (_, i) => i + 2);
    let done = 1;
    await pool(pages, async (page) => {
      const data = (await get(path, { ...params, page }, { signal })) || [];
      if (onPage) onPage(data, page);
      else out.push(...data);
      done++;
      if (onProgress) onProgress(done, total);
    }, { concurrency, signal });
    return out;
  }

  // No visible `x-pages` (a proxy stripped it, or the route is unpaginated):
  // walk forward in batches until a page comes back short/empty.
  if (firstData.length === 0) return out;
  let page = 2;
  for (;;) {
    if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const batch = Array.from({ length: concurrency }, (_, i) => page + i);
    const datas = await pool(batch, (p) => get(path, { ...params, page: p }, { signal }).catch(() => []), { concurrency, signal });
    let empty = false;
    datas.forEach((data, i) => {
      const rows = data || [];
      if (rows.length === 0) empty = true;
      else if (onPage) onPage(rows, batch[i]);
      else out.push(...rows);
    });
    page += concurrency;
    if (onProgress) onProgress(page, page + concurrency);
    if (empty || page > maxPages) break;
  }
  return out;
}

/** Server status — also used as the connectivity probe. */
export function serverStatus(opts = {}) {
  return get('/status/', {}, opts);
}
