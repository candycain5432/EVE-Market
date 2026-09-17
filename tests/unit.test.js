// Pure-logic tests: node --test tests/
//
// These cover the maths that decides whether a trade is worth taking, which is
// the part that must not quietly drift.

import test from 'node:test';
import assert from 'node:assert/strict';

import { fees, stationTrade, instantFlip, haulTrade, project, score, trips } from '../src/core/calc.js';
import { historyStats, aggregateOrders } from '../src/core/market.js';
import { iskShort, numShort, pct, ago } from '../src/util/fmt.js';

const SKILLED = {
  manualFees: false,
  baseSalesTax: 4.5,
  baseBrokerFee: 3.0,
  accounting: 5,
  accountingPerLevel: 11,
  brokerRelations: 5,
  brokerPerLevel: 0.3,
  factionStanding: 0,
  corpStanding: 0,
};

test('fees: skills reduce the published baselines', () => {
  const f = fees(SKILLED);
  assert.equal(Number((f.brokerFee * 100).toFixed(4)), 1.5);        // 3.00 - 5 × 0.30
  assert.equal(Number((f.salesTax * 100).toFixed(4)), 2.025);       // 4.50 × (1 - 5 × 0.11)
});

test('fees: untrained character pays the full baseline', () => {
  const f = fees({ ...SKILLED, accounting: 0, brokerRelations: 0 });
  assert.equal(Number((f.brokerFee * 100).toFixed(4)), 3);
  assert.equal(Number((f.salesTax * 100).toFixed(4)), 4.5);
});

test('fees: standings shave the broker fee further, never below zero', () => {
  const withStandings = fees({ ...SKILLED, factionStanding: 10, corpStanding: 10 });
  assert.ok(withStandings.brokerFee < fees(SKILLED).brokerFee);
  const absurd = fees({ ...SKILLED, baseBrokerFee: 0.5, factionStanding: 10, corpStanding: 10 });
  assert.ok(absurd.brokerFee >= 0);
});

test('fees: manual mode is used verbatim', () => {
  const f = fees({ manualFees: true, brokerFeePct: 1.234, salesTaxPct: 3.21 });
  assert.equal(f.brokerFee, 0.01234);
  assert.equal(f.salesTax, 0.0321);
  assert.equal(f.source, 'manual');
});

test('stationTrade: fees are charged on both orders plus tax on the sale', () => {
  const f = { brokerFee: 0.02, salesTax: 0.04 };
  const t = stationTrade(100, 200, f);
  assert.equal(t.cost, 102);                       // 100 + 2% broker
  assert.equal(t.revenue, 188);                    // 200 - 2% broker - 4% tax
  assert.equal(t.profit, 86);
  assert.equal(Number(t.margin.toFixed(6)), Number((86 / 102).toFixed(6)));
});

test('stationTrade: a market with only one side yields nothing', () => {
  assert.equal(stationTrade(0, 200), null);
  assert.equal(stationTrade(100, null), null);
});

test('instantFlip: crossing the spread at one station is a loss', () => {
  const f = { brokerFee: 0.02, salesTax: 0.04 };
  const t = instantFlip(100, 130, f);
  assert.equal(t.cost, 130);
  assert.equal(t.revenue, 96);
  assert.ok(t.profit < 0);
});

test('haulTrade: instant sell pays tax only, order sell also pays broker', () => {
  const f = { brokerFee: 0.02, salesTax: 0.04 };
  const instant = haulTrade(100, 150, 170, { sellMode: 'instant', f });
  const order = haulTrade(100, 150, 170, { sellMode: 'order', f });
  assert.equal(instant.revenue, 144);              // 150 - 4%
  assert.equal(order.revenue, 170 * 0.94);         // 170 - 2% - 4%
  assert.equal(instant.cost, 100);                 // bought off a sell order: no broker fee
  assert.equal(haulTrade(100, 150, 170, { buyMode: 'order', sellMode: 'instant', f }).cost, 102);
});

test('haulTrade: a missing destination side is not a trade', () => {
  const f = { brokerFee: 0.02, salesTax: 0.04 };
  assert.equal(haulTrade(100, 0, 0, { sellMode: 'instant', f }), null);
  assert.equal(haulTrade(0, 150, 170, { sellMode: 'instant', f }), null);
});

test('project: units are capped by volume share, depth and capital in turn', () => {
  const trade = { cost: 100, profit: 10 };

  const byVolume = project(trade, { dailyVolume: 1000, volumeShare: 0.1, capital: 1e9 });
  assert.equal(byVolume.unitsPerDay, 100);
  assert.equal(byVolume.profitPerDay, 1000);
  assert.equal(byVolume.limitedBy, 'volume');

  const byDepth = project(trade, { dailyVolume: 1000, volumeShare: 0.5, depth: 12, capital: 1e9 });
  assert.equal(byDepth.unitsPerDay, 12);
  assert.equal(byDepth.limitedBy, 'depth');

  const byCapital = project(trade, { dailyVolume: 1e6, volumeShare: 1, capital: 550 });
  assert.equal(byCapital.unitsPerDay, 5.5);
  assert.equal(byCapital.limitedBy, 'capital');
});

test('score: liquidity and calm prices win over a thin jackpot', () => {
  const thin = score({ profitPerDay: 1e6, margin: 0.4, dailyIsk: 5e6, volatility: 0.6, competition: 2 });
  const liquid = score({ profitPerDay: 1e6, margin: 0.1, dailyIsk: 5e10, volatility: 0.02, competition: 2 });
  assert.ok(liquid > thin);
});

test('score: absurd margins are treated as traps', () => {
  const sane = score({ profitPerDay: 1e6, margin: 0.3, dailyIsk: 1e9, volatility: 0.05, competition: 5 });
  const absurd = score({ profitPerDay: 1e6, margin: 4, dailyIsk: 1e9, volatility: 0.05, competition: 5 });
  assert.ok(absurd < sane);
  assert.equal(score({ profitPerDay: -5, margin: 0.2, dailyIsk: 1e9 }), 0);
});

test('trips: rounds up to whole hauls', () => {
  assert.equal(trips(100, 10, 1000), 1);
  assert.equal(trips(101, 10, 1000), 2);
  assert.equal(trips(100, 0, 1000), null);
});

test('aggregateOrders: best prices, depth and station filtering', () => {
  const orders = [
    // station 1
    { type_id: 34, location_id: 1, price: 10, volume_remain: 100, is_buy_order: false },
    { type_id: 34, location_id: 1, price: 11, volume_remain: 500, is_buy_order: false },
    { type_id: 34, location_id: 1, price: 40, volume_remain: 900, is_buy_order: false },
    { type_id: 34, location_id: 1, price: 8, volume_remain: 300, is_buy_order: true },
    { type_id: 34, location_id: 1, price: 5, volume_remain: 700, is_buy_order: true },
    // a different station, must be ignored
    { type_id: 34, location_id: 2, price: 1, volume_remain: 999, is_buy_order: false },
  ];

  const [row] = aggregateOrders(orders, [1]);
  assert.equal(row.t, 34);
  assert.equal(row.ask, 10);
  assert.equal(row.bid, 8);
  assert.equal(row.askQty, 1500);
  assert.equal(row.bidQty, 1000);
  assert.equal(row.askOrders, 3);
  assert.equal(row.bidOrders, 2);
  // 5% of 1500 units is 75, covered by the first (100-unit) order at 10.
  assert.equal(row.ask5, 10);
  // Depth near the best ask: 10 and 11 are outside 5% of each other, so only 10.
  assert.equal(row.askQtyNear, 100);

  const unfiltered = aggregateOrders(orders, null);
  assert.equal(unfiltered[0].ask, 1);
});

test('aggregateOrders: the 5% depth price ignores a token bait order', () => {
  const orders = [
    { type_id: 7, location_id: 1, price: 1, volume_remain: 1, is_buy_order: false },
    { type_id: 7, location_id: 1, price: 100, volume_remain: 10000, is_buy_order: false },
  ];
  const [row] = aggregateOrders(orders, [1]);
  assert.equal(row.ask, 1);      // the naive best price is the bait
  assert.equal(row.ask5, 100);   // the depth price is what you can really buy
});

test('historyStats: averages, trend and volatility over the window', () => {
  const history = Array.from({ length: 30 }, (_, i) => ({
    date: `2026-01-${String(i + 1).padStart(2, '0')}`,
    average: 100 + i,       // steadily rising
    highest: 105 + i,
    lowest: 95 + i,
    order_count: 10,
    volume: 1000,
  }));

  const stats = historyStats(history, 30);
  assert.equal(stats.days, 30);
  assert.equal(stats.avgVolume, 1000);
  assert.equal(stats.avgPrice, 114.5);
  assert.equal(stats.lastPrice, 129);
  // First third averages 104.5, last third 124.5 -> +19.1%.
  assert.equal(Number(stats.trend.toFixed(4)), Number((20 / 104.5).toFixed(4)));
  assert.ok(stats.volatility > 0 && stats.volatility < 0.1);
  assert.equal(Math.round(stats.avgIsk), 114500);
});

test('historyStats: an empty series is zeroed, not NaN', () => {
  for (const stats of [historyStats([], 30), historyStats(null, 30), historyStats(undefined, 30)]) {
    assert.equal(stats.days, 0);
    assert.equal(stats.avgVolume, 0);
    assert.equal(stats.avgIsk, 0);
    assert.ok(Number.isFinite(stats.trend));
  }
});

test('historyStats: honours a shorter window', () => {
  const history = Array.from({ length: 60 }, (_, i) => ({
    date: `d${i}`, average: i < 53 ? 10 : 100, highest: 1, lowest: 1, order_count: 1, volume: 5,
  }));
  assert.equal(historyStats(history, 7).avgPrice, 100);
  assert.equal(historyStats(history, 7).days, 7);
});

test('formatters: compact values promote instead of printing four digits', () => {
  assert.equal(iskShort(999999999), '1.00b');
  assert.equal(iskShort(1_500_000), '1.50m');
  assert.equal(iskShort(-4_500_000), '-4.50m');
  assert.equal(iskShort(null), '—');
  assert.equal(numShort(999999), '1.0m');
  assert.equal(pct(0.1234), '12.34%');
  assert.equal(ago(null), 'never');
  assert.match(ago(Date.now() - 120000), /^2m ago$/);
});
