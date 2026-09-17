// Trade maths: fees, margins and opportunity scoring.
//
// Baselines follow EVE's published numbers (3.00% broker fee, 4.50% sales tax)
// reduced by skills and standings. Every input is user-editable in Settings, so
// the tool stays honest if CCP changes the rates.

import { settings } from './store.js';

/** Effective fee ratios (0.015 == 1.5%) for the current settings. */
export function fees(s = settings()) {
  if (s.manualFees) {
    return {
      brokerFee: Math.max(0, (s.brokerFeePct || 0) / 100),
      salesTax: Math.max(0, (s.salesTaxPct || 0) / 100),
      source: 'manual',
    };
  }
  // Accounting removes a share of the sales tax per level.
  const perLevel = (Number(s.accountingPerLevel) || 0) / 100;
  const salesTax = Math.max(0, (s.baseSalesTax / 100) * (1 - perLevel * clampLevel(s.accounting)));
  // Broker Relations removes percentage points per level; standings shave more.
  const brokerPct = s.baseBrokerFee
    - (Number(s.brokerPerLevel) || 0) * clampLevel(s.brokerRelations)
    - 0.03 * clampStanding(s.factionStanding)
    - 0.02 * clampStanding(s.corpStanding);
  return {
    brokerFee: Math.max(0, brokerPct / 100),
    salesTax,
    source: 'skills',
  };
}

const clampLevel = (v) => Math.min(5, Math.max(0, Number(v) || 0));
const clampStanding = (v) => Math.min(10, Math.max(-10, Number(v) || 0));

/**
 * Station trading: place a buy order at the best bid, sell with a sell order at
 * the best ask. Broker fee is paid on both orders, sales tax on the sale.
 */
export function stationTrade(bid, ask, f = fees()) {
  if (!(bid > 0) || !(ask > 0)) return null;
  const cost = bid * (1 + f.brokerFee);
  const revenue = ask * (1 - f.brokerFee - f.salesTax);
  const profit = revenue - cost;
  return { cost, revenue, profit, margin: cost > 0 ? profit / cost : 0, spread: ask - bid };
}

/**
 * Instant flip: buy from a sell order (no broker fee), immediately sell into a
 * buy order (sales tax only). Usually negative at the same station — it is the
 * benchmark for whether a market is crossed.
 */
export function instantFlip(bid, ask, f = fees()) {
  if (!(bid > 0) || !(ask > 0)) return null;
  const cost = ask;
  const revenue = bid * (1 - f.salesTax);
  const profit = revenue - cost;
  return { cost, revenue, profit, margin: cost > 0 ? profit / cost : 0, spread: ask - bid };
}

/**
 * Hauling: buy at the source (instantly off a sell order, or with a buy order)
 * and sell at the destination (instantly into a buy order, or with a sell order).
 */
export function haulTrade(srcAsk, dstBid, dstAsk, {
  buyMode = 'instant',   // 'instant' | 'order'
  sellMode = 'instant',  // 'instant' | 'order'
  f = fees(),
} = {}) {
  const buyPrice = srcAsk;
  if (!(buyPrice > 0)) return null;
  const cost = buyMode === 'order' ? buyPrice * (1 + f.brokerFee) : buyPrice;

  let revenue;
  let sellPrice;
  if (sellMode === 'order') {
    sellPrice = dstAsk;
    if (!(sellPrice > 0)) return null;
    revenue = sellPrice * (1 - f.brokerFee - f.salesTax);
  } else {
    sellPrice = dstBid;
    if (!(sellPrice > 0)) return null;
    revenue = sellPrice * (1 - f.salesTax);
  }

  const profit = revenue - cost;
  return { cost, revenue, profit, buyPrice, sellPrice, margin: cost > 0 ? profit / cost : 0 };
}

/**
 * Turn a per-unit trade into a realistic daily outlook.
 *
 * `dailyVolume` is the market's average daily units; `volumeShare` is the slice
 * you expect to win against competing orders. Capital caps how many units you
 * can actually front.
 */
export function project(trade, { dailyVolume = 0, depth = Infinity, capital = 0, volumeShare = 0.15 } = {}) {
  if (!trade) return null;
  const byMarket = dailyVolume * volumeShare;
  const byCapital = capital > 0 && trade.cost > 0 ? capital / trade.cost : Infinity;
  const units = Math.max(0, Math.min(byMarket, depth, byCapital));
  return {
    unitsPerDay: units,
    profitPerDay: units * trade.profit,
    iskInvested: units * trade.cost,
    limitedBy: units === byCapital && byCapital < byMarket ? 'capital'
      : units === depth && depth < byMarket ? 'depth'
        : 'volume',
  };
}

/**
 * Composite score used to rank scanner rows: daily profit, damped by thin or
 * highly volatile markets so a 900% margin on two units a week does not win.
 */
export function score({ profitPerDay = 0, margin = 0, dailyIsk = 0, volatility = 0, competition = 0 }) {
  if (!(profitPerDay > 0)) return 0;
  const liquidity = Math.log10(Math.max(10, dailyIsk)) / 10;          // 0.1 … ~1.2
  const stability = 1 / (1 + Math.max(0, volatility) * 3);            // punishes erratic prices
  const crowding = 1 / (1 + Math.max(0, competition) / 25);           // punishes 200-order walls
  const sanity = margin > 1.5 ? 0.35 : 1;                             // absurd margins are usually traps
  return profitPerDay * liquidity * stability * crowding * sanity;
}

/** Cargo trips needed to move `units` of an item with volume `m3Each`. */
export function trips(units, m3Each, cargo) {
  if (!(m3Each > 0) || !(cargo > 0)) return null;
  return Math.ceil((units * m3Each) / cargo);
}

/** Human-readable summary of the fee configuration, for the settings page. */
export function feeSummary(s = settings()) {
  const f = fees(s);
  return `${(f.brokerFee * 100).toFixed(2)}% broker · ${(f.salesTax * 100).toFixed(2)}% sales tax`;
}
