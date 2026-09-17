// Single item: hub-by-hub prices, live order book and price history.

import { h, mount, toast, copy } from '../util/dom.js';
import { isk, iskShort, num, numShort, pct, m3, ago, signClass } from '../util/fmt.js';
import { settings, isWatched, toggleWatch } from '../core/store.js';
import { fees, stationTrade, instantFlip, feeSummary } from '../core/calc.js';
import { fetchBook, splitBook, fetchHistory, historyStats } from '../core/market.js';
import { typeDetail, nameOf } from '../core/types.js';
import { HUBS, hub } from '../data/hubs.js';
import { panel, flushPanel, segment, stat } from '../ui/controls.js';
import { priceChart } from '../ui/chart.js';
import { startJob, endJob, setProgress, isAbort } from '../ui/progress.js';
import { pool } from '../core/esi.js';

const state = { days: 90, bookHub: null };

export async function renderItem(root, typeId) {
  if (!typeId) {
    mount(root, h('div.page-head', {}, h('div', {}, h('h1', {}, 'Item lookup'))),
      panel(null, null, h('div.empty', {},
        h('strong', {}, 'Search for an item'),
        'Use the search box up top (or press ', h('kbd', {}, '/'), ') to pull up prices, depth and history.')));
    return;
  }

  const id = Number(typeId);
  const s = settings();
  const viewHub = hub(state.bookHub || s.homeHub);

  const head = h('div.page-head', {}, h('div', {},
    h('h1', {}, h('span.spinner'), ' ', nameOf(id) || `Type ${id}`)));
  const hubsPanel = h('div');
  const bookPanel = h('div');
  const chartPanel = h('div');
  mount(root, head, hubsPanel, h('div.grid.grid-2', {}, bookPanel, chartPanel));

  const signal = startJob('Loading item…');
  try {
    const detail = await typeDetail(id, signal);
    const name = detail ? detail.name : (nameOf(id) || `Type ${id}`);
    document.title = `${name} — Capsuleer Market`;

    mount(head, h('div', {},
      h('h1', {},
        h(`button.star${isWatched(id) ? '.on' : ''}`, {
          title: 'Watchlist',
          onclick: (ev) => { const on = toggleWatch(id); ev.currentTarget.classList.toggle('on', on); },
        }, '★'),
        ' ', name),
      h('p', {}, detail && detail.packagedVolume != null ? `${m3(detail.packagedVolume)} packaged · ` : '',
        `type ${id} · `,
        h('a', { href: `https://evetycoon.com/market/${id}`, target: '_blank', rel: 'noreferrer noopener' }, 'EVE Tycoon'), ' · ',
        h('a', { href: `https://everef.net/type/${id}`, target: '_blank', rel: 'noreferrer noopener' }, 'EVE Ref'))),
      h('div.btn-row', {},
        h('button.btn.btn-ghost.btn-sm', { onclick: () => copy(name) }, 'Copy name'),
        h('button.btn.btn-ghost.btn-sm', { onclick: () => renderItem(root, id) }, 'Refresh')));

    // ---- every hub at once ------------------------------------------------
    setProgress(0, HUBS.length, 'Checking every trade hub');
    const f = fees(s);
    let done = 0;
    const hubRows = await pool(HUBS, async (hubDef) => {
      try {
        const book = await fetchBook(hubDef.regionId, id, { signal });
        const sides = splitBook(book, hubDef.id);
        const region = splitBook(book, null);
        done++;
        setProgress(done, HUBS.length, 'Checking every trade hub');
        return { hubDef, sides, region };
      } catch {
        done++;
        return { hubDef, sides: null, region: null };
      }
    }, { concurrency: 5, signal });

    const withAsk = hubRows.filter((r) => r.sides && r.sides.bestAsk > 0);
    const withBid = hubRows.filter((r) => r.sides && r.sides.bestBid > 0);
    const cheapest = withAsk.sort((a, b) => a.sides.bestAsk - b.sides.bestAsk)[0] || null;
    const richest = withBid.sort((a, b) => b.sides.bestBid - a.sides.bestBid)[0] || null;
    const spreadTrade = cheapest && richest && cheapest.hubDef.id !== richest.hubDef.id
      ? { from: cheapest, to: richest, profit: richest.sides.bestBid * (1 - f.salesTax) - cheapest.sides.bestAsk }
      : null;

    mount(hubsPanel, flushPanel('Prices across the trade hubs', h('span.faint', {}, feeSummary()), h('div.table-wrap', {},
      h('table.data', {},
        h('thead', {}, h('tr', {},
          h('th', {}, 'Hub'), h('th', {}, 'Best buy'), h('th', {}, 'Best sell'),
          h('th', {}, 'Spread'), h('th', {}, 'Flip margin'), h('th', {}, 'Buy depth'), h('th', {}, 'Sell depth'),
          h('th', {}, 'Region sell'), h('th', {}, ''))),
        h('tbody', {}, hubRows.map(({ hubDef, sides, region }) => {
          if (!sides) return h('tr', {}, h('td', {}, hubDef.name), h('td', { colspan: 8 }, h('span.faint', {}, 'unavailable')));
          const flip = stationTrade(sides.bestBid, sides.bestAsk, f);
          return h('tr', {},
            h('td', {}, h('strong', {}, hubDef.name), ' ', h('span.faint', {}, hubDef.region)),
            h('td.num.buy', {}, isk(sides.bestBid)),
            h('td.num.sell', {}, isk(sides.bestAsk)),
            h('td.num', {}, sides.bestAsk && sides.bestBid ? isk(sides.bestAsk - sides.bestBid) : '—'),
            h(`td.num.${flip ? signClass(flip.margin) : 'dim'}`, {}, flip ? pct(flip.margin, 1) : '—'),
            h('td.num', {}, numShort(sides.bidQty)),
            h('td.num', {}, numShort(sides.askQty)),
            h('td.num.faint', { title: 'Best sell order anywhere in the region, including player structures' }, isk(region.bestAsk)),
            h('td', {}, h('button.btn.btn-ghost.btn-sm', {
              onclick: () => { state.bookHub = hubDef.id; renderItem(root, id); },
            }, 'Book')));
        })))),
      spreadTrade && spreadTrade.profit > 0
        ? h('div.panel-body', {}, h('div.note', {},
          `Cross-hub: buy in ${spreadTrade.from.hubDef.name} at ${isk(spreadTrade.from.sides.bestAsk)}, sell into ${spreadTrade.to.hubDef.name} buy orders at ${isk(spreadTrade.to.sides.bestBid)} → `,
          h('strong.pos', {}, `${isk(spreadTrade.profit)} per unit`), ' after sales tax, before hauling.'))
        : null));

    // ---- order book at the selected hub -----------------------------------
    const book = await fetchBook(viewHub.regionId, id, { signal });
    const sides = splitBook(book, viewHub.id);
    const flip = stationTrade(sides.bestBid, sides.bestAsk, f);
    const instant = instantFlip(sides.bestBid, sides.bestAsk, f);

    mount(bookPanel, panel(`Order book · ${viewHub.name}`,
      segment(viewHub.id, HUBS.map((x) => ({ value: x.id, label: x.name.split(' ')[0] })),
        (v) => { state.bookHub = Number(v); renderItem(root, id); }),
      h('div.stats', {},
        stat('Best buy', isk(sides.bestBid), `${numShort(sides.bidQty)} units wanted`),
        stat('Best sell', isk(sides.bestAsk), `${numShort(sides.askQty)} units offered`),
        stat('Station-trade margin', flip ? pct(flip.margin, 2) : '—', flip ? `${isk(flip.profit)} per unit` : 'no two-sided market'),
        stat('Instant flip', instant ? isk(instant.profit) : '—', 'buy off sells, dump into buys'),
      ),
      h('div.book', { style: { marginTop: '12px' } },
        bookColumn('Buy orders', aggregate(sides.buys, { desc: true }), 'buy'),
        bookColumn('Sell orders', aggregate(sides.sells), 'sell')),
      h('div.note', { style: { marginTop: '12px' } }, `Book fetched ${ago(book.fetchedAt)} · station orders only. ESI caches market orders for five minutes.`)));

    // ---- history ----------------------------------------------------------
    const history = await fetchHistory(viewHub.regionId, id, { signal });
    const stats = historyStats(history, s.historyDays);

    mount(chartPanel, panel(`Price history · ${viewHub.region}`,
      segment(state.days, [
        { value: 30, label: '30d' }, { value: 90, label: '90d' },
        { value: 180, label: '180d' }, { value: 365, label: '1y' },
      ], (v) => { state.days = Number(v); renderItem(root, id); }),
      h('div.stats', {},
        stat(`${stats.days}d average`, isk(stats.avgPrice), `last ${isk(stats.lastPrice)}`),
        stat('Units/day', numShort(stats.avgVolume), `${iskShort(stats.avgIsk)} ISK/day`),
        stat('Trend', `${stats.trend > 0 ? '+' : ''}${(stats.trend * 100).toFixed(1)}%`, 'across the window'),
        stat('Volatility', pct(stats.volatility, 1), stats.volatility > 0.15 ? 'jumpy — hold carefully' : 'steady'),
      ),
      h('div', { style: { marginTop: '12px' } }, priceChart(history, { days: state.days }))));
  } catch (err) {
    if (isAbort(err)) return;
    console.error(err);
    toast(err.message || 'Could not load item', 'err');
    mount(bookPanel, panel(null, null, h('div.empty', {}, h('strong', {}, 'Load failed'), err.message || '')));
  } finally {
    endJob();
  }
}

/**
 * Collapse an order side into price levels with cumulative depth.
 * `desc` puts the best price first: highest for buys, lowest for sells.
 */
function aggregate(orders, { desc = false, levels = 12 } = {}) {
  const byPrice = new Map();
  for (const o of orders) {
    byPrice.set(o.price, (byPrice.get(o.price) || 0) + o.volume_remain);
  }
  const rows = [...byPrice.entries()].map(([price, qty]) => ({ price, qty }));
  rows.sort((a, b) => (desc ? b.price - a.price : a.price - b.price));
  const top = rows.slice(0, levels);
  let cum = 0;
  return top.map((r) => { cum += r.qty; return { ...r, cum }; });
}

function bookColumn(title, rows, kind) {
  const max = rows.length ? rows[rows.length - 1].cum : 1;
  return h('div.book-col', {},
    h('h3', {}, title),
    h('div.book-row.book-head', {}, h('span', {}, 'Price'), h('span', {}, 'Units'), h('span', {}, 'Cumulative')),
    rows.length
      ? rows.map((r) => h(`div.book-row.${kind}`, {},
        h('div.depth', { style: { width: `${Math.min(100, (r.cum / max) * 100)}%` } }),
        h(`span.${kind}`, {}, isk(r.price)),
        h('span', {}, num(r.qty)),
        h('span.faint', {}, numShort(r.cum))))
      : h('div.empty', {}, 'No orders'));
}
