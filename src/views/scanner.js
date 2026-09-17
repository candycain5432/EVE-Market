// Station trading scanner: find items worth buying and re-selling in one hub.

import { h, mount, toast, copy } from '../util/dom.js';
import { isk, iskShort, num, numShort, pct, ago, signClass } from '../util/fmt.js';
import { settings, saveSettings, isWatched, toggleWatch } from '../core/store.js';
import { fees, stationTrade, instantFlip, project, score, feeSummary } from '../core/calc.js';
import { fetchSnapshot, fetchHistories, historyStats } from '../core/market.js';
import { ensureTypeIndex, learnNames, nameOf } from '../core/types.js';
import { HUBS, hub } from '../data/hubs.js';
import { DataTable } from '../ui/table.js';
import { panel, flushPanel, numberField, selectField, segment, checkField, stat } from '../ui/controls.js';
import { startJob, endJob, setProgress, isAbort } from '../ui/progress.js';

// Survives navigation so flipping to an item and back keeps the results.
const state = {
  rows: [],
  meta: null,
  mode: 'station',
  depthPrices: true,
  wholeRegion: false,
  busy: false,
};

export function renderScanner(root) {
  const s = settings();
  const results = h('div');
  const summary = h('div');

  const controls = panel('Scan setup', null,
    h('div.controls', {},
      selectField('Trade hub', s.homeHub, HUBS.map((x) => ({ value: x.id, label: `${x.name} — ${x.region}` })),
        (v) => saveSettings({ homeHub: Number(v) })),
      h('div.field', {}, h('label', {}, 'Strategy'), segment(state.mode, [
        { value: 'station', label: 'Buy order → sell order' },
        { value: 'instant', label: 'Instant flip' },
      ], (v) => { state.mode = v; renderScanner(root); })),
      numberField('Capital (ISK)', s.capital, (v) => saveSettings({ capital: v || 0 }), { min: 0, width: '150px' }),
      numberField('Min margin %', (s.minMargin * 100).toFixed(1), (v) => saveSettings({ minMargin: (v || 0) / 100 }), { min: 0, width: '110px' }),
      numberField('Min profit/unit', s.minProfitPerUnit, (v) => saveSettings({ minProfitPerUnit: v || 0 }), { min: 0, width: '130px' }),
      numberField('Min ISK/day traded', s.minDailyIsk, (v) => saveSettings({ minDailyIsk: v || 0 }), { min: 0, width: '150px' }),
      numberField('Max unit price', s.maxBuyPrice, (v) => saveSettings({ maxBuyPrice: v || 0 }), { min: 0, width: '140px', hint: '0 = no cap' }),
      numberField('Volume share', s.volumeShare, (v) => saveSettings({ volumeShare: v == null ? 0.15 : v }), { min: 0, max: 1, step: 0.01, width: '100px', hint: 'of daily units you win' }),
      numberField('Candidates', s.historyCandidates, (v) => saveSettings({ historyCandidates: Math.max(10, v || 200) }), { min: 10, max: 1000, width: '100px', hint: 'items given a history lookup' }),
      h('div.field', {}, h('label', {}, 'Pricing'),
        checkField('Use 5% depth prices', state.depthPrices, (v) => { state.depthPrices = v; }),
        checkField('Whole region', state.wholeRegion, (v) => { state.wholeRegion = v; })),
      h('div.field', {}, h('label', {}, ' '),
        h('div.btn-row', {},
          h('button.btn', { onclick: () => runScan(root, results, summary, false) }, 'Scan market'),
          h('button.btn.btn-ghost', { onclick: () => runScan(root, results, summary, true), title: 'Ignore the cached snapshot and re-download every order page' }, 'Force refresh'))),
    ),
    state.wholeRegion
      ? h('div.note', {}, h('strong', {}, 'Whole-region mode'), ' — prices come from anywhere in the region, public player structures included. Good for spotting what the freeport markets are doing, but the two sides of a trade may be twenty jumps apart.')
      : null,
    h('div.note', {}, `Fees applied: ${feeSummary()}. `,
      state.mode === 'station'
        ? 'Buy-order → sell-order pays the broker fee twice plus sales tax on the sale.'
        : 'Instant flip buys off a sell order and dumps into a buy order — sales tax only, but you cross the spread.'),
  );

  mount(root,
    h('div.page-head', {},
      h('div', {},
        h('h1', {}, 'Station trading scanner'),
        h('p', {}, 'Downloads every market order in the hub\'s region, keeps the ones at your station, and ranks what is actually worth flipping after fees, competition and real traded volume.')),
    ),
    controls,
    summary,
    results,
  );

  if (state.rows.length) paint(results, summary);
  else mount(results, flushPanel('Results', null, h('div.empty', {},
    h('strong', {}, 'No scan yet'),
    'Hit ', h('em', {}, 'Scan market'), ' — the first run for a region downloads a few hundred order pages (roughly 10–40 seconds) and is then cached for 10 minutes.')));
}

async function runScan(root, results, summary, force) {
  if (state.busy) return;
  state.busy = true;
  const s = settings();
  const hubDef = hub(s.homeHub);
  const signal = startJob(`Scanning ${hubDef.name}…`);
  const started = performance.now();

  try {
    await ensureTypeIndex({ signal, onProgress: (d, t, l) => setProgress(d, t, l) });

    const snapshot = await fetchSnapshot({
      regionId: hubDef.regionId,
      stationIds: state.wholeRegion ? null : [hubDef.id],
      signal,
      force,
      onProgress: (d, t, l) => setProgress(d, t, l),
    });

    const f = fees(s);
    const useDepth = state.depthPrices;
    const prelim = [];

    for (const row of snapshot.rows) {
      const bid = useDepth ? (row.bid5 ?? row.bid) : row.bid;
      const ask = useDepth ? (row.ask5 ?? row.ask) : row.ask;
      if (!(bid > 0) || !(ask > 0)) continue;
      if (row.askOrders + row.bidOrders < s.minOrderCount) continue;

      const trade = state.mode === 'station' ? stationTrade(bid, ask, f) : instantFlip(bid, ask, f);
      if (!trade || !(trade.profit > 0)) continue;
      if (trade.margin < s.minMargin) continue;
      if (trade.profit < s.minProfitPerUnit) continue;
      if (s.maxBuyPrice > 0 && trade.cost > s.maxBuyPrice) continue;

      const depth = Math.max(0, Math.min(row.askQtyNear, row.bidQtyNear));
      prelim.push({ row, trade, depth, potential: trade.profit * Math.max(1, depth) });
    }

    prelim.sort((a, b) => b.potential - a.potential);
    const candidates = prelim.slice(0, s.historyCandidates);

    if (!candidates.length) {
      state.rows = [];
      state.meta = { hubDef, snapshot, scanned: snapshot.rows.length, elapsed: performance.now() - started, kept: 0 };
      paint(results, summary);
      toast('No items passed the filters — try lowering min margin or min ISK/day.', 'info');
      return;
    }

    await learnNames(candidates.map((c) => c.row.t), { signal, onProgress: (d, t, l) => setProgress(d, t, l) });

    const histories = await fetchHistories(hubDef.regionId, candidates.map((c) => c.row.t), {
      signal,
      onProgress: (d, t, l) => setProgress(d, t, l),
    });

    const rows = [];
    for (const c of candidates) {
      const stats = historyStats(histories.get(c.row.t), s.historyDays);
      if (stats.avgIsk < s.minDailyIsk) continue;

      const outlook = project(c.trade, {
        dailyVolume: stats.avgVolume,
        depth: c.depth,
        capital: s.capital,
        volumeShare: s.volumeShare,
      });

      rows.push({
        typeId: c.row.t,
        name: nameOf(c.row.t) || `Type ${c.row.t}`,
        bid: c.row.bid,
        ask: c.row.ask,
        bid5: c.row.bid5,
        ask5: c.row.ask5,
        cost: c.trade.cost,
        profit: c.trade.profit,
        margin: c.trade.margin,
        dailyVolume: stats.avgVolume,
        dailyIsk: stats.avgIsk,
        trend: stats.trend,
        volatility: stats.volatility,
        depth: c.depth,
        sellOrders: c.row.askOrders,
        buyOrders: c.row.bidOrders,
        unitsPerDay: outlook.unitsPerDay,
        profitPerDay: outlook.profitPerDay,
        iskInvested: outlook.iskInvested,
        limitedBy: outlook.limitedBy,
        score: score({
          profitPerDay: outlook.profitPerDay,
          margin: c.trade.margin,
          dailyIsk: stats.avgIsk,
          volatility: stats.volatility,
          competition: c.row.askOrders,
        }),
      });
    }

    rows.sort((a, b) => b.score - a.score);
    state.rows = rows;
    state.meta = {
      hubDef,
      snapshot,
      scanned: snapshot.rows.length,
      candidates: candidates.length,
      kept: rows.length,
      elapsed: performance.now() - started,
    };
    paint(results, summary);
    toast(`${rows.length} opportunities in ${hubDef.name}`, 'ok');
  } catch (err) {
    if (isAbort(err)) toast('Scan cancelled', 'info');
    else {
      console.error(err);
      toast(err.message || 'Scan failed', 'err');
    }
  } finally {
    endJob();
    state.busy = false;
  }
}

function paint(results, summary) {
  const meta = state.meta;
  const s = settings();

  if (meta) {
    // Each row's profit/day assumes it gets the whole wallet, so summing them
    // would be fiction. Spend the capital once, best return on ISK first.
    let remaining = s.capital;
    let deployed = 0;
    let portfolioDaily = 0;
    let picked = 0;
    const byReturn = [...state.rows]
      .filter((r) => r.iskInvested > 0 && r.profitPerDay > 0)
      .sort((a, b) => (b.profitPerDay / b.iskInvested) - (a.profitPerDay / a.iskInvested));
    for (const r of byReturn) {
      if (remaining <= 0) break;
      const invest = Math.min(r.iskInvested, remaining);
      portfolioDaily += r.profitPerDay * (invest / r.iskInvested);
      remaining -= invest;
      deployed += invest;
      picked++;
    }

    mount(summary, panel(null, null, h('div.stats', {},
      stat(state.wholeRegion ? 'Region' : 'Hub',
        state.wholeRegion ? meta.hubDef.region : meta.hubDef.name,
        state.wholeRegion ? 'every station and public structure' : meta.hubDef.station),
      stat('Items with a book', num(meta.scanned),
        `${num(meta.snapshot.orderCount)} orders ${state.wholeRegion ? 'in region' : 'at station'}`),
      stat('Opportunities', num(meta.kept), `from ${num(meta.candidates || 0)} candidates`),
      stat('Profit/day on your capital', iskShort(portfolioDaily),
        `${num(picked)} items · ${iskShort(deployed)} deployed`),
      stat('Snapshot', ago(meta.snapshot.fetchedAt), `scan took ${(meta.elapsed / 1000).toFixed(1)}s`),
    )));
  }

  const host = h('div');
  const table = new DataTable(host, {
    sortKey: 'score',
    sortDir: 'desc',
    limit: 300,
    empty: 'No rows passed your filters.',
    onRowClick: (row) => { window.location.hash = `#/item/${row.typeId}`; },
    columns: [
      {
        key: 'name', label: 'Item', numeric: false, align: 'left',
        value: (r) => r.name,
        render: (r) => h('span', {},
          h(`button.star${isWatched(r.typeId) ? '.on' : ''}`, {
            title: 'Watchlist',
            onclick: (ev) => { ev.stopPropagation(); const on = toggleWatch(r.typeId); ev.target.classList.toggle('on', on); },
          }, '★'),
          h('span.name', {}, r.name)),
      },
      { key: 'bid', label: 'Buy @', value: (r) => r.bid, render: (r) => h('span.buy', {}, isk(r.bid)), title: 'Best buy order price at this station' },
      { key: 'ask', label: 'Sell @', value: (r) => r.ask, render: (r) => h('span.sell', {}, isk(r.ask)), title: 'Best sell order price at this station' },
      { key: 'profit', label: 'Profit/unit', value: (r) => r.profit, render: (r) => isk(r.profit), title: 'After broker fee and sales tax' },
      { key: 'margin', label: 'Margin', value: (r) => r.margin, render: (r) => h(`span.${signClass(r.margin)}`, {}, pct(r.margin, 1)) },
      { key: 'dailyVolume', label: 'Units/day', value: (r) => r.dailyVolume, render: (r) => numShort(r.dailyVolume), title: `Average daily units traded over ${s.historyDays} days` },
      { key: 'dailyIsk', label: 'ISK/day', value: (r) => r.dailyIsk, render: (r) => iskShort(r.dailyIsk), title: 'Average daily ISK turnover in this region' },
      { key: 'unitsPerDay', label: 'Your units', value: (r) => r.unitsPerDay, render: (r) => numShort(r.unitsPerDay), title: 'Units/day you could realistically move, given volume share, depth and capital' },
      {
        key: 'profitPerDay', label: 'Profit/day', value: (r) => r.profitPerDay,
        render: (r) => h('span.pos', {}, iskShort(r.profitPerDay)),
        title: 'Modelled daily profit',
      },
      { key: 'iskInvested', label: 'Capital used', value: (r) => r.iskInvested, render: (r) => iskShort(r.iskInvested), title: 'ISK tied up per day at that rate' },
      { key: 'sellOrders', label: 'Comp.', value: (r) => r.sellOrders, render: (r) => h('span', { title: `${r.sellOrders} sell / ${r.buyOrders} buy orders` }, num(r.sellOrders)), title: 'Competing sell orders at this station' },
      {
        key: 'trend', label: 'Trend', value: (r) => r.trend,
        render: (r) => h(`span.${signClass(r.trend)}`, {}, `${r.trend > 0 ? '+' : ''}${(r.trend * 100).toFixed(1)}%`),
        title: 'Price drift across the history window',
      },
      { key: 'volatility', label: 'Vol.', value: (r) => r.volatility, render: (r) => pct(r.volatility, 1), title: 'Price volatility — high means risky inventory' },
      { key: 'score', label: 'Score', value: (r) => r.score, render: (r) => h('span.badge' + (r.score > 0 ? '.good' : ''), {}, iskShort(r.score)), title: 'Profit/day damped by liquidity, volatility and competition' },
    ],
  });
  table.setRows(state.rows);

  const actions = h('div.btn-row', {},
    h('button.btn.btn-ghost.btn-sm', { onclick: () => exportCsv(state.rows) }, 'Export CSV'),
    h('button.btn.btn-ghost.btn-sm', {
      title: 'Copy the top 40 item names — paste straight into the in-game multibuy window',
      onclick: () => copy(state.rows.slice(0, 40).map((r) => r.name).join('\n')),
    }, 'Copy top names'),
  );

  mount(results, flushPanel(`Opportunities${state.rows.length ? ` (${state.rows.length})` : ''}`, actions, host));
}

function exportCsv(rows) {
  if (!rows.length) { toast('Nothing to export', 'info'); return; }
  const cols = ['typeId', 'name', 'bid', 'ask', 'profit', 'margin', 'dailyVolume', 'dailyIsk', 'unitsPerDay', 'profitPerDay', 'sellOrders', 'buyOrders', 'trend', 'volatility', 'score'];
  const csv = [cols.join(',')]
    .concat(rows.map((r) => cols.map((c) => {
      const v = r[c];
      return typeof v === 'string' ? `"${v.replace(/"/g, '""')}"` : (v == null ? '' : Number(v).toFixed(4));
    }).join(',')))
    .join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  const a = h('a', { href: url, download: `station-trading-${Date.now()}.csv` });
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
