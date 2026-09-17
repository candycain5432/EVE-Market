// Hub-to-hub hauling: what is worth buying in one trade hub and selling in another.

import { h, mount, toast, copy } from '../util/dom.js';
import { isk, iskShort, num, numShort, pct, m3, ago, signClass } from '../util/fmt.js';
import { settings, saveSettings } from '../core/store.js';
import { fees, haulTrade, feeSummary, trips } from '../core/calc.js';
import { fetchSnapshot, fetchHistories, historyStats, routeJumps } from '../core/market.js';
import { ensureTypeIndex, learnNames, nameOf, typeDetails } from '../core/types.js';
import { HUBS, hub } from '../data/hubs.js';
import { DataTable } from '../ui/table.js';
import { panel, flushPanel, numberField, selectField, segment, stat } from '../ui/controls.js';
import { startJob, endJob, setProgress, isAbort } from '../ui/progress.js';

const state = {
  rows: [],
  meta: null,
  src: 60003760,          // Jita
  dst: 60008494,          // Amarr
  buyMode: 'instant',
  sellMode: 'instant',
  busy: false,
};

export function renderHauling(root) {
  const s = settings();
  const results = h('div');
  const summary = h('div');

  const hubOptions = HUBS.map((x) => ({ value: x.id, label: `${x.name} — ${x.region}` }));

  const controls = panel('Route setup', null,
    h('div.controls', {},
      selectField('Buy at', state.src, hubOptions, (v) => { state.src = Number(v); }),
      selectField('Sell at', state.dst, hubOptions, (v) => { state.dst = Number(v); }),
      h('div.field', {}, h('label', {}, 'Buy side'), segment(state.buyMode, [
        { value: 'instant', label: 'Off sell orders' },
        { value: 'order', label: 'Place buy order' },
      ], (v) => { state.buyMode = v; renderHauling(root); })),
      h('div.field', {}, h('label', {}, 'Sell side'), segment(state.sellMode, [
        { value: 'instant', label: 'Into buy orders' },
        { value: 'order', label: 'Place sell order' },
      ], (v) => { state.sellMode = v; renderHauling(root); })),
      numberField('Capital (ISK)', s.capital, (v) => saveSettings({ capital: v || 0 }), { min: 0, width: '150px' }),
      numberField('Cargo (m³)', s.cargo, (v) => saveSettings({ cargo: v || 0 }), { min: 1, width: '120px', hint: 'per trip' }),
      numberField('Min profit/unit', s.minProfitPerUnit, (v) => saveSettings({ minProfitPerUnit: v || 0 }), { min: 0, width: '130px' }),
      numberField('Min margin %', (s.minMargin * 100).toFixed(1), (v) => saveSettings({ minMargin: (v || 0) / 100 }), { min: 0, width: '110px' }),
      numberField('Candidates', s.historyCandidates, (v) => saveSettings({ historyCandidates: Math.max(10, v || 200) }), { min: 10, max: 600, width: '100px', hint: 'get volume + history' }),
      h('div.field', {}, h('label', {}, ' '), h('div.btn-row', {},
        h('button.btn', { onclick: () => runScan(results, summary, false) }, 'Find cargo'),
        h('button.btn.btn-ghost', { onclick: () => runScan(results, summary, true) }, 'Force refresh'))),
    ),
    h('div.note', {}, `Fees applied: ${feeSummary()}. `,
      state.sellMode === 'instant'
        ? 'Selling into buy orders pays sales tax only, and is limited by the buy orders actually sitting there.'
        : 'Placing sell orders at the destination pays broker fee + sales tax, and assumes you can hold the position until it fills.'),
    h('div.note', {}, 'Both regions have to be downloaded, so the first run of a new pair takes roughly twice as long as a single-hub scan. Snapshots are reused for 10 minutes.'),
  );

  mount(root,
    h('div.page-head', {}, h('div', {},
      h('h1', {}, 'Hauling & hub arbitrage'),
      h('p', {}, 'Compares two hubs order-book to order-book, then ranks by ISK per m³ — the number that decides what actually fits in your hold.'))),
    controls,
    summary,
    results,
  );

  if (state.rows.length) paint(results, summary);
  else mount(results, flushPanel('Cargo list', null, h('div.empty', {},
    h('strong', {}, 'No route scanned yet'),
    'Pick two hubs and hit ', h('em', {}, 'Find cargo'), '.')));
}

async function runScan(results, summary, force) {
  if (state.busy) return;
  if (state.src === state.dst) { toast('Pick two different hubs', 'err'); return; }
  state.busy = true;

  const s = settings();
  const srcHub = hub(state.src);
  const dstHub = hub(state.dst);
  const signal = startJob(`${srcHub.name} → ${dstHub.name}`);
  const started = performance.now();

  try {
    await ensureTypeIndex({ signal, onProgress: setProgress });

    const srcSnap = await fetchSnapshot({
      regionId: srcHub.regionId, stationIds: [srcHub.id], signal, force,
      onProgress: (d, t, l) => setProgress(d, t, `${srcHub.name}: ${l}`),
    });
    const dstSnap = await fetchSnapshot({
      regionId: dstHub.regionId, stationIds: [dstHub.id], signal, force,
      onProgress: (d, t, l) => setProgress(d, t, `${dstHub.name}: ${l}`),
    });

    const f = fees(s);
    const prelim = [];

    for (const src of srcSnap.rows) {
      const dst = dstSnap.byType.get(src.t);
      if (!dst) continue;

      const srcAsk = state.buyMode === 'order' ? (src.bid5 ?? src.bid) : (src.ask5 ?? src.ask);
      const trade = haulTrade(srcAsk, dst.bid5 ?? dst.bid, dst.ask5 ?? dst.ask, {
        buyMode: state.buyMode,
        sellMode: state.sellMode,
        f,
      });
      if (!trade || !(trade.profit > 0)) continue;
      if (trade.margin < s.minMargin) continue;
      if (trade.profit < s.minProfitPerUnit) continue;

      // Units you can actually source and place at the far end.
      const supply = state.buyMode === 'order' ? Infinity : src.askQtyNear;
      const demand = state.sellMode === 'instant' ? dst.bidQtyNear : Infinity;
      const affordable = trade.cost > 0 ? s.capital / trade.cost : 0;
      const units = Math.floor(Math.max(0, Math.min(supply, demand, affordable)));
      if (units < 1) continue;

      prelim.push({ src, dst, trade, units, potential: units * trade.profit });
    }

    prelim.sort((a, b) => b.potential - a.potential);
    const candidates = prelim.slice(0, s.historyCandidates);

    if (!candidates.length) {
      state.rows = [];
      state.meta = { srcHub, dstHub, srcSnap, dstSnap, elapsed: performance.now() - started, kept: 0, jumps: null };
      paint(results, summary);
      toast('Nothing profitable on this route with these filters.', 'info');
      return;
    }

    await learnNames(candidates.map((c) => c.src.t), { signal, onProgress: setProgress });

    const details = await typeDetails(candidates.map((c) => c.src.t), { signal, onProgress: setProgress });
    const histories = await fetchHistories(dstHub.regionId, candidates.map((c) => c.src.t), {
      signal,
      onProgress: (d, t, l) => setProgress(d, t, `${dstHub.name}: ${l}`),
    });
    const jumps = await routeJumps(srcHub.systemId, dstHub.systemId, { signal });

    const rows = [];
    for (const c of candidates) {
      const detail = details.get(c.src.t);
      const vol = detail ? detail.packagedVolume : null;
      const stats = historyStats(histories.get(c.src.t), s.historyDays);

      // When you have to sell via orders, the destination's daily throughput is
      // the real constraint, not how much you can cram into the hold.
      const absorbable = state.sellMode === 'order'
        ? Math.max(1, stats.avgVolume * s.volumeShare)
        : Infinity;
      const units = Math.floor(Math.min(c.units, absorbable));
      if (units < 1) continue;

      const totalProfit = units * c.trade.profit;
      const totalM3 = vol ? units * vol : null;
      const perM3 = vol && vol > 0 ? c.trade.profit / vol : null;
      const tripCount = vol ? trips(units, vol, s.cargo) : null;
      const unitsPerTrip = vol && vol > 0 ? Math.floor(s.cargo / vol) : null;

      rows.push({
        typeId: c.src.t,
        name: nameOf(c.src.t) || `Type ${c.src.t}`,
        buyPrice: c.trade.buyPrice,
        sellPrice: c.trade.sellPrice,
        profit: c.trade.profit,
        margin: c.trade.margin,
        units,
        volume: vol,
        totalM3,
        perM3,
        totalProfit,
        tripCount,
        profitPerTrip: unitsPerTrip ? Math.min(units, unitsPerTrip) * c.trade.profit : totalProfit,
        investment: units * c.trade.cost,
        dstDailyIsk: stats.avgIsk,
        dstDailyVolume: stats.avgVolume,
        srcDepth: c.src.askQtyNear,
        dstDepth: c.dst.bidQtyNear,
      });
    }

    rows.sort((a, b) => (b.perM3 ?? -1) - (a.perM3 ?? -1));
    state.rows = rows;
    state.meta = {
      srcHub, dstHub, srcSnap, dstSnap, jumps,
      kept: rows.length,
      candidates: candidates.length,
      elapsed: performance.now() - started,
    };
    paint(results, summary);
    toast(`${rows.length} haulable items ${srcHub.name} → ${dstHub.name}`, 'ok');
  } catch (err) {
    if (isAbort(err)) toast('Scan cancelled', 'info');
    else { console.error(err); toast(err.message || 'Scan failed', 'err'); }
  } finally {
    endJob();
    state.busy = false;
  }
}

function paint(results, summary) {
  const meta = state.meta;
  const s = settings();

  if (meta) {
    // What one full hold of the best cargo is worth, greedily filled by ISK/m³.
    let space = s.cargo;
    let holdProfit = 0;
    let holdCost = 0;
    for (const r of [...state.rows].sort((a, b) => (b.perM3 ?? 0) - (a.perM3 ?? 0))) {
      if (!r.volume || space <= 0) continue;
      const fit = Math.min(r.units, Math.floor(space / r.volume));
      if (fit < 1) continue;
      space -= fit * r.volume;
      holdProfit += fit * r.profit;
      holdCost += fit * (r.investment / r.units);
    }

    mount(summary, panel(null, null, h('div.stats', {},
      stat('Route', `${meta.srcHub.name} → ${meta.dstHub.name}`, meta.jumps != null ? `${meta.jumps} jumps (shortest)` : 'jump count unavailable'),
      stat('Haulable items', num(meta.kept), `from ${num(meta.candidates || 0)} candidates`),
      stat('One full hold', iskShort(holdProfit), `${m3(s.cargo - space)} of ${m3(s.cargo)} filled`),
      stat('Hold buy-in', iskShort(holdCost), 'ISK needed up front'),
      stat('Snapshots', ago(Math.min(meta.srcSnap.fetchedAt, meta.dstSnap.fetchedAt)), `scan took ${(meta.elapsed / 1000).toFixed(1)}s`),
    )));
  }

  const host = h('div');
  const table = new DataTable(host, {
    sortKey: 'perM3',
    sortDir: 'desc',
    limit: 300,
    empty: 'Nothing profitable on this route.',
    onRowClick: (row) => { window.location.hash = `#/item/${row.typeId}`; },
    columns: [
      { key: 'name', label: 'Item', numeric: false, align: 'left', value: (r) => r.name, render: (r) => h('span.name', {}, r.name) },
      { key: 'buyPrice', label: 'Buy @', value: (r) => r.buyPrice, render: (r) => h('span.buy', {}, isk(r.buyPrice)) },
      { key: 'sellPrice', label: 'Sell @', value: (r) => r.sellPrice, render: (r) => h('span.sell', {}, isk(r.sellPrice)) },
      { key: 'profit', label: 'Profit/unit', value: (r) => r.profit, render: (r) => isk(r.profit) },
      { key: 'margin', label: 'Margin', value: (r) => r.margin, render: (r) => h(`span.${signClass(r.margin)}`, {}, pct(r.margin, 1)) },
      { key: 'perM3', label: 'ISK / m³', value: (r) => r.perM3, render: (r) => h('span.pos', {}, r.perM3 == null ? '—' : isk(r.perM3, 0)), title: 'Profit per cubic metre — the number that decides what to carry' },
      { key: 'units', label: 'Units', value: (r) => r.units, render: (r) => numShort(r.units), title: 'Limited by source depth, destination demand and your capital' },
      { key: 'volume', label: 'm³ each', value: (r) => r.volume, render: (r) => (r.volume == null ? '—' : r.volume.toFixed(2)) },
      { key: 'totalProfit', label: 'Total profit', value: (r) => r.totalProfit, render: (r) => h('span.pos', {}, iskShort(r.totalProfit)) },
      { key: 'profitPerTrip', label: 'Per trip', value: (r) => r.profitPerTrip, render: (r) => iskShort(r.profitPerTrip), title: `Profit from one ${num(s.cargo)} m³ hold of this item alone` },
      { key: 'tripCount', label: 'Trips', value: (r) => r.tripCount, render: (r) => (r.tripCount == null ? '—' : num(r.tripCount)) },
      { key: 'investment', label: 'Buy-in', value: (r) => r.investment, render: (r) => iskShort(r.investment) },
      { key: 'dstDailyIsk', label: 'Dest ISK/day', value: (r) => r.dstDailyIsk, render: (r) => iskShort(r.dstDailyIsk), title: 'How much of this item the destination region actually trades per day' },
      { key: 'dstDepth', label: 'Dest depth', value: (r) => r.dstDepth, render: (r) => numShort(r.dstDepth), title: 'Units wanted by buy orders near the best price' },
    ],
  });
  table.setRows(state.rows);

  const actions = h('div.btn-row', {},
    h('button.btn.btn-ghost.btn-sm', {
      title: 'Copy a multibuy list of the best cargo that fits one hold',
      onclick: () => copyManifest(),
    }, 'Copy hold manifest'),
  );

  mount(results, flushPanel(`Cargo list${state.rows.length ? ` (${state.rows.length})` : ''}`, actions, host));
}

/** Greedy fill of one hold by ISK/m³, formatted for the in-game multibuy window. */
function copyManifest() {
  const s = settings();
  let space = s.cargo;
  const lines = [];
  for (const r of [...state.rows].sort((a, b) => (b.perM3 ?? 0) - (a.perM3 ?? 0))) {
    if (!r.volume || space <= 0) continue;
    const fit = Math.min(r.units, Math.floor(space / r.volume));
    if (fit < 1) continue;
    space -= fit * r.volume;
    lines.push(`${r.name} ${fit}`);
  }
  if (!lines.length) { toast('No cargo to copy yet', 'info'); return; }
  copy(lines.join('\n'));
}
