// User settings + watchlist, persisted in localStorage.

const KEY = 'cm.settings.v1';
const WATCH_KEY = 'cm.watchlist.v1';

export const DEFAULT_SETTINGS = {
  // Fees. EVE's published baselines are 3.00% broker fee and 4.50% sales tax;
  // skills and standings reduce them. Everything here is user-editable so the
  // tool stays correct when CCP changes the numbers.
  accounting: 5,            // Accounting skill level
  accountingPerLevel: 11,   // % of the sales tax removed per Accounting level
  brokerRelations: 5,       // Broker Relations skill level
  brokerPerLevel: 0.30,     // percentage points removed per Broker Relations level
  factionStanding: 0,       // -0.03 pp per point
  corpStanding: 0,          // -0.02 pp per point
  baseSalesTax: 4.5,        // percent, before skills
  baseBrokerFee: 3.0,       // percent, before skills
  manualFees: false,        // when true, use salesTaxPct / brokerFeePct verbatim
  salesTaxPct: 2.25,
  brokerFeePct: 1.5,

  // Trading assumptions
  homeHub: 60003760,        // Jita IV-4
  capital: 1_000_000_000,   // ISK available
  cargo: 60000,             // m³ per haul (freighter-ish)
  volumeShare: 0.15,        // share of daily volume you realistically capture
  historyDays: 30,          // window used for average daily volume

  // Scanner filters
  minMargin: 0.06,          // 6%
  minProfitPerUnit: 10000,
  minDailyIsk: 100_000_000,
  maxBuyPrice: 0,           // 0 = no cap
  minOrderCount: 3,
  historyCandidates: 200,   // how many candidates get a history lookup

  // Networking
  concurrency: 12,
  esiMode: 'auto',          // auto | latest | compat-query | compat-header
  contact: '',              // optional contact string sent as a user-agent hint
};

let cache = null;

export function settings() {
  if (cache) return cache;
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { saved = {}; }
  cache = { ...DEFAULT_SETTINGS, ...saved };
  return cache;
}

export function saveSettings(patch) {
  cache = { ...settings(), ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch { /* quota / private mode */ }
  window.dispatchEvent(new CustomEvent('settings-changed', { detail: cache }));
  return cache;
}

export function resetSettings() {
  cache = { ...DEFAULT_SETTINGS };
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent('settings-changed', { detail: cache }));
  return cache;
}

// ---- watchlist -------------------------------------------------------------

export function watchlist() {
  try {
    const raw = JSON.parse(localStorage.getItem(WATCH_KEY) || '[]');
    return Array.isArray(raw) ? raw.filter((n) => Number.isInteger(n)) : [];
  } catch {
    return [];
  }
}

export function isWatched(typeId) {
  return watchlist().includes(Number(typeId));
}

export function toggleWatch(typeId) {
  const id = Number(typeId);
  const list = watchlist();
  const idx = list.indexOf(id);
  if (idx >= 0) list.splice(idx, 1);
  else list.push(id);
  try { localStorage.setItem(WATCH_KEY, JSON.stringify(list)); } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent('watchlist-changed'));
  return idx < 0;
}
