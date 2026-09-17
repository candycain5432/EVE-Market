// Watchlist: the items you care about, priced at your home hub.

import { h, mount, toast } from '../util/dom.js';
import { isk, iskShort, numShort, pct, signClass } from '../util/fmt.js';
import { settings, saveSettings, watchlist, toggleWatch } from '../core/store.js';
import { fees, stationTrade } from '../core/calc.js';
import { fetchBook, splitBook, fetchHistory, historyStats } from '../core/market.js';
import { typeDetail, nameOf } from '../core/types.js';
import { pool } from '../core/esi.js';
import { HUBS, hub } from '../data/hubs.js';
import { DataTable } from '../ui/table.js';
import { flushPanel, selectField } from '../ui/controls.js';
import { startJob, endJob, setProgress, isAbort } from '../ui/progress.js';

export async function renderWatchlist(root) {
  const s = settings();
  const hubDef = hub(s.homeHub);
  const ids = watchlist();
  const host = h('div');

  mount(root,
    h('div.page-head', {},
      h('div', {},
        h('h1', {}, 'Watchlist'),
        h('p', {}, 'Live prices for the items you starred, at your home hub. Cheap to refresh — one request per item.')),
      h('div.controls', {},
        selectField('Home hub', s.homeHub, HUBS.map((x) => ({ value: x.id, label: x.name })),
          (v) => { saveSettings({ homeHub: Number(v) }); renderWatchlist(root); }),
        h('div.field', {}, h('label', {}, ' '),
          h('button.btn.btn-ghost', { onclick: () => renderWatchlist(root) }, 'Refresh')))),
    flushPanel(`Watched items (${ids.length})`, null, host));

  if (!ids.length) {
    mount(host, h('div.empty', {},
      h('strong', {}, 'Nothing watched yet'),
      'Star an item from the scanner, the hauling list or an item page and it shows up here.'));
    return;
  }

  const signal = startJob('Pricing watchlist…');
  try {
    const f = fees(s);
    let done = 0;
    const rows = await pool(ids, async (id) => {
      try {
        const [book, history, detail] = await Promise.all([
          fetchBook(hubDef.regionId, id, { signal }),
          fetchHistory(hubDef.regionId, id, { signal }),
          typeDetail(id, signal),
        ]);
        const sides = splitBook(book, hubDef.id);
        const stats = historyStats(history, s.historyDays);
        const trade = stationTrade(sides.bestBid, sides.bestAsk, f);
        return {
          typeId: id,
          name: (detail && detail.name) || nameOf(id) || `Type ${id}`,
          bid: sides.bestBid,
          ask: sides.bestAsk,
          bidQty: sides.bidQty,
          askQty: sides.askQty,
          profit: trade ? trade.profit : null,
          margin: trade ? trade.margin : null,
          avgPrice: stats.avgPrice,
          dailyIsk: stats.avgIsk,
          dailyVolume: stats.avgVolume,
          trend: stats.trend,
          // Where the current ask sits inside the historical average — a rough
          // "is this cheap right now?" tell.
          vsAvg: stats.avgPrice > 0 && sides.bestAsk > 0 ? (sides.bestAsk - stats.avgPrice) / stats.avgPrice : null,
        };
      } catch {
        return { typeId: id, name: nameOf(id) || `Type ${id}`, bid: null, ask: null };
      } finally {
        done++;
        setProgress(done, ids.length, 'Pricing watchlist');
      }
    }, { concurrency: Math.min(6, s.concurrency), signal });

    const table = new DataTable(host, {
      sortKey: 'margin',
      sortDir: 'desc',
      onRowClick: (row) => { window.location.hash = `#/item/${row.typeId}`; },
      columns: [
        { key: 'name', label: 'Item', numeric: false, align: 'left', value: (r) => r.name, render: (r) => h('span.name', {}, r.name) },
        { key: 'bid', label: 'Best buy', value: (r) => r.bid, render: (r) => h('span.buy', {}, isk(r.bid)) },
        { key: 'ask', label: 'Best sell', value: (r) => r.ask, render: (r) => h('span.sell', {}, isk(r.ask)) },
        { key: 'profit', label: 'Profit/unit', value: (r) => r.profit, render: (r) => isk(r.profit) },
        { key: 'margin', label: 'Margin', value: (r) => r.margin, render: (r) => h(`span.${signClass(r.margin)}`, {}, r.margin == null ? '—' : pct(r.margin, 1)) },
        { key: 'avgPrice', label: `${s.historyDays}d avg`, value: (r) => r.avgPrice, render: (r) => isk(r.avgPrice) },
        {
          key: 'vsAvg', label: 'vs avg', value: (r) => r.vsAvg,
          render: (r) => (r.vsAvg == null ? '—' : h(`span.${r.vsAvg < 0 ? 'pos' : 'neg'}`, {}, `${r.vsAvg > 0 ? '+' : ''}${(r.vsAvg * 100).toFixed(1)}%`)),
          title: 'Current sell price against the historical average — negative means it is cheap right now',
        },
        { key: 'dailyIsk', label: 'ISK/day', value: (r) => r.dailyIsk, render: (r) => iskShort(r.dailyIsk) },
        { key: 'dailyVolume', label: 'Units/day', value: (r) => r.dailyVolume, render: (r) => numShort(r.dailyVolume) },
        {
          key: 'trend', label: 'Trend', value: (r) => r.trend,
          render: (r) => h(`span.${signClass(r.trend)}`, {}, r.trend == null ? '—' : `${r.trend > 0 ? '+' : ''}${(r.trend * 100).toFixed(1)}%`),
        },
        {
          key: 'remove', label: '', sortable: false, numeric: false,
          render: (r) => h('button.btn.btn-ghost.btn-sm', {
            onclick: (ev) => { ev.stopPropagation(); toggleWatch(r.typeId); renderWatchlist(root); },
          }, 'Remove'),
        },
      ],
    });
    table.setRows(rows);
  } catch (err) {
    if (!isAbort(err)) { console.error(err); toast(err.message || 'Could not price the watchlist', 'err'); }
  } finally {
    endJob();
  }
}
