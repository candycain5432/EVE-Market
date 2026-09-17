// Price history chart: high/low band, daily average, moving averages and volume.
// Plain SVG in a viewBox so it scales to any container width.

import { h, svg } from '../util/dom.js';
import { iskShort, numShort, shortDate, isk, num } from '../util/fmt.js';

const W = 1000;
const H = 340;
const M = { top: 14, right: 14, bottom: 26, left: 66 };
const PRICE_H = 230;
const VOL_TOP = PRICE_H + 34;
const VOL_H = H - M.bottom - VOL_TOP;

function movingAverage(values, window) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= window) sum -= values[i - window];
    if (i >= window - 1) out[i] = sum / window;
  }
  return out;
}

function niceTicks(min, max, count = 4) {
  if (!(max > min)) return [min];
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || mag * 10;
  const start = Math.ceil(min / step) * step;
  const ticks = [];
  for (let v = start; v <= max + step * 0.001; v += step) ticks.push(v);
  return ticks;
}

/**
 * @param {Array} history ESI market history rows, oldest first
 * @param {{days?:number, title?:string}} opts
 * @returns {HTMLElement} a positioned wrapper containing the SVG + tooltip
 */
export function priceChart(history, { days = 90 } = {}) {
  const data = (history || []).slice(-days);
  if (data.length < 2) {
    return h('div.empty', {}, 'Not enough price history for this item in this region.');
  }

  const prices = data.map((d) => d.average);
  const lows = data.map((d) => d.lowest);
  const highs = data.map((d) => d.highest);
  const vols = data.map((d) => d.volume);

  const pMin = Math.min(...lows);
  const pMax = Math.max(...highs);
  const pad = (pMax - pMin) * 0.08 || pMax * 0.05 || 1;
  const yMin = Math.max(0, pMin - pad);
  const yMax = pMax + pad;
  const vMax = Math.max(...vols, 1);

  const plotW = W - M.left - M.right;
  const x = (i) => M.left + (data.length === 1 ? plotW / 2 : (i / (data.length - 1)) * plotW);
  const y = (v) => M.top + PRICE_H - ((v - yMin) / (yMax - yMin || 1)) * PRICE_H;
  const vy = (v) => VOL_TOP + VOL_H - (v / vMax) * VOL_H;

  const line = (vals) => vals
    .map((v, i) => (v == null ? null : `${i === 0 || vals[i - 1] == null ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`))
    .filter(Boolean)
    .join(' ');

  const bandPath = [
    ...highs.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)}`),
    ...lows.map((v, i) => `L${x(lows.length - 1 - i).toFixed(1)},${y(lows[lows.length - 1 - i]).toFixed(1)}`).slice(1),
    'Z',
  ].join(' ');

  const areaPath = `${line(prices)} L${x(data.length - 1).toFixed(1)},${(M.top + PRICE_H).toFixed(1)} L${x(0).toFixed(1)},${(M.top + PRICE_H).toFixed(1)} Z`;

  const ma5 = movingAverage(prices, 5);
  const ma20 = movingAverage(prices, 20);

  const gridLines = niceTicks(yMin, yMax).map((t) => svg('g', {}, [
    svg('line', { class: 'grid-line', x1: M.left, x2: W - M.right, y1: y(t).toFixed(1), y2: y(t).toFixed(1) }),
    svg('text', { class: 'axis-text', x: M.left - 8, y: (y(t) + 3).toFixed(1), 'text-anchor': 'end' }, iskShort(t)),
  ]));

  const xStep = Math.max(1, Math.floor(data.length / 6));
  const xLabels = data.map((d, i) => (i % xStep === 0 || i === data.length - 1
    ? svg('text', { class: 'axis-text', x: x(i).toFixed(1), y: H - 8, 'text-anchor': 'middle' }, shortDate(d.date))
    : null)).filter(Boolean);

  const barW = Math.max(1, (plotW / data.length) * 0.72);
  const volBars = data.map((d, i) => svg('rect', {
    class: 'vol-bar',
    x: (x(i) - barW / 2).toFixed(1),
    y: vy(d.volume).toFixed(1),
    width: barW.toFixed(1),
    height: Math.max(0.5, VOL_TOP + VOL_H - vy(d.volume)).toFixed(1),
  }));

  const crossV = svg('line', { class: 'cross', x1: 0, x2: 0, y1: M.top, y2: VOL_TOP + VOL_H, opacity: 0 });
  const dot = svg('circle', { r: 3.2, fill: 'var(--accent)', opacity: 0 });

  const chartSvg = svg('svg', {
    class: 'chart',
    viewBox: `0 0 ${W} ${H}`,
    preserveAspectRatio: 'none',
    height: H,
    role: 'img',
    'aria-label': 'Price history',
  }, [
    svg('defs', {}, svg('linearGradient', { id: 'priceGrad', x1: 0, y1: 0, x2: 0, y2: 1 }, [
      svg('stop', { offset: '0%', 'stop-color': 'rgba(240,169,59,.26)' }),
      svg('stop', { offset: '100%', 'stop-color': 'rgba(240,169,59,0)' }),
    ])),
    ...gridLines,
    svg('path', { class: 'band', d: bandPath }),
    svg('path', { class: 'price-area', d: areaPath }),
    svg('path', { class: 'price-line', d: line(prices) }),
    svg('path', { class: 'ma5', d: line(ma5) }),
    svg('path', { class: 'ma20', d: line(ma20) }),
    ...volBars,
    svg('text', { class: 'axis-text', x: M.left - 8, y: VOL_TOP + 10, 'text-anchor': 'end' }, numShort(vMax)),
    svg('text', { class: 'axis-text', x: M.left, y: VOL_TOP - 8 }, 'Daily volume'),
    ...xLabels,
    crossV,
    dot,
  ]);

  const tip = h('div.chart-tip', { style: { display: 'none' } });
  const wrap = h('div', { style: { position: 'relative' } }, chartSvg, tip);

  const hide = () => {
    tip.style.display = 'none';
    crossV.setAttribute('opacity', 0);
    dot.setAttribute('opacity', 0);
  };

  chartSvg.addEventListener('mousemove', (ev) => {
    const box = chartSvg.getBoundingClientRect();
    const px = ((ev.clientX - box.left) / box.width) * W;
    const ratio = (px - M.left) / plotW;
    const i = Math.max(0, Math.min(data.length - 1, Math.round(ratio * (data.length - 1))));
    const d = data[i];

    crossV.setAttribute('x1', x(i).toFixed(1));
    crossV.setAttribute('x2', x(i).toFixed(1));
    crossV.setAttribute('opacity', 1);
    dot.setAttribute('cx', x(i).toFixed(1));
    dot.setAttribute('cy', y(d.average).toFixed(1));
    dot.setAttribute('opacity', 1);

    tip.style.display = 'block';
    tip.innerHTML = '';
    tip.append(
      h('div', {}, h('strong', {}, shortDate(d.date))),
      h('div', {}, `avg  ${isk(d.average)}`),
      h('div', {}, `high ${isk(d.highest)}`),
      h('div', {}, `low  ${isk(d.lowest)}`),
      h('div', {}, `vol  ${num(d.volume)}`),
      h('div.faint', {}, `${num(d.order_count)} orders`),
    );
    const left = (x(i) / W) * box.width;
    tip.style.left = `${Math.min(Math.max(8, left + 14), box.width - tip.offsetWidth - 8)}px`;
    tip.style.top = `${Math.max(4, (y(d.average) / H) * box.height - 20)}px`;
  });
  chartSvg.addEventListener('mouseleave', hide);

  return h('div', {}, wrap, h('div.chart-legend', {},
    h('span', {}, h('i', { style: { background: 'var(--accent)' } }), 'daily average'),
    h('span', {}, h('i', { style: { background: 'var(--cyan)' } }), '5-day MA'),
    h('span', {}, h('i', { style: { background: '#9a7bd6' } }), '20-day MA'),
    h('span', {}, h('i', { style: { background: 'rgba(240,169,59,.35)' } }), 'daily high/low range'),
  ));
}
