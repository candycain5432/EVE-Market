// Number / date formatting helpers. Everything here is display-only.

const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Full ISK value with thousands separators, e.g. 1,234,567.89 */
export function isk(v, decimals = 2) {
  if (v == null || !isFinite(v)) return '—';
  return (decimals === 0 ? nf0 : nf2).format(v);
}

const ISK_UNITS = [[1e12, 't', 2], [1e9, 'b', 2], [1e6, 'm', 2], [1e3, 'k', 1]];

/**
 * Compact ISK, e.g. 4.31b / 812.40m / 95.2k. Keeps sign.
 * A value that rounds up into four digits is promoted to the next unit, so
 * 999,999,999 prints as 1.00b rather than 1000.00m.
 */
export function iskShort(v) {
  if (v == null || !isFinite(v)) return '—';
  const sign = v < 0 ? '-' : '';
  const a = Math.abs(v);
  for (let i = 0; i < ISK_UNITS.length; i++) {
    const [scale, suffix, decimals] = ISK_UNITS[i];
    if (a < scale) continue;
    if (Number((a / scale).toFixed(decimals)) >= 1000 && i > 0) {
      const [upScale, upSuffix, upDecimals] = ISK_UNITS[i - 1];
      return `${sign}${(a / upScale).toFixed(upDecimals)}${upSuffix}`;
    }
    return `${sign}${(a / scale).toFixed(decimals)}${suffix}`;
  }
  const small = a.toFixed(a < 10 ? 2 : 0);
  return Number(small) >= 1000 ? `${sign}1.0k` : `${sign}${small}`;
}

/** Plain integer count, e.g. 12,904 */
export function num(v) {
  if (v == null || !isFinite(v)) return '—';
  return nf0.format(Math.round(v));
}

/** Compact unit count, e.g. 1.2m. Promotes on rounding like iskShort. */
export function numShort(v) {
  if (v == null || !isFinite(v)) return '—';
  const sign = v < 0 ? '-' : '';
  const a = Math.abs(v);
  const units = [[1e12, 't'], [1e9, 'b'], [1e6, 'm'], [1e3, 'k']];
  for (let i = 0; i < units.length; i++) {
    const [scale, suffix] = units[i];
    if (a < scale) continue;
    if (Number((a / scale).toFixed(1)) >= 1000 && i > 0) {
      const [upScale, upSuffix] = units[i - 1];
      return `${sign}${(a / upScale).toFixed(1)}${upSuffix}`;
    }
    return `${sign}${(a / scale).toFixed(1)}${suffix}`;
  }
  return nf0.format(Math.round(v));
}

/** Ratio (0.1234) -> "12.34%" */
export function pct(v, decimals = 2) {
  if (v == null || !isFinite(v)) return '—';
  return `${(v * 100).toFixed(decimals)}%`;
}

/** Cubic metres. */
export function m3(v) {
  if (v == null || !isFinite(v)) return '—';
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}m m³`;
  if (v >= 1000) return `${nf0.format(Math.round(v))} m³`;
  if (v >= 1) return `${v.toFixed(1)} m³`;
  return `${v.toFixed(2)} m³`;
}

/** Seconds/ms -> "3m ago" style relative time. Accepts epoch ms. */
export function ago(ts) {
  if (!ts) return 'never';
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 45) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/** "2026-09-17" -> "17 Sep" */
export function shortDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d} ${months[(m || 1) - 1]}${y !== new Date().getFullYear() ? ` ${String(y).slice(2)}` : ''}`;
}

/** Duration in ms -> "1m 04s" */
export function dur(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

/** Signed-value CSS class helper. */
export function signClass(v) {
  if (!isFinite(v) || v === 0) return 'dim';
  return v > 0 ? 'pos' : 'neg';
}
