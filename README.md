# Capsuleer Market

A market and trading tool for EVE Online that runs entirely in your browser and
talks straight to [ESI](https://esi.evetech.net/ui/). No account, no server, no
API key — open the page and it starts pulling live order books.

It exists because the good third-party market tools either went dark, went
subscription, or only answer the easy question ("what does this cost in Jita?")
rather than the one that pays ("what should I actually put ISK into today, after
fees, competition and real traded volume?").

## What it does

**Station trading scanner** — downloads every market order in a hub's region,
keeps the ones at your station, and ranks what is worth flipping. Profit is
computed after broker fee on both orders and sales tax on the sale, then damped
by how much of the item genuinely trades per day, how many other traders are
camping it, and how volatile the price is. A 900% margin on two units a week
sorts below a 9% margin on ten thousand.

**Hauling & hub arbitrage** — compares two hubs order-book to order-book and
ranks by ISK per m³, with packaged volumes pulled per item, trip counts for your
hold size, and a "copy hold manifest" button that greedily fills one cargo hold
and gives you a list you can paste into the in-game multibuy window.

**Item view** — every trade hub's best bid/ask side by side, a live order book
with depth bars for the hub you pick, and a price-history chart with 5- and
20-day moving averages, the daily high/low band and daily volume.

**Watchlist** — star items anywhere in the app; the watchlist prices them at your
home hub and flags whether the current sell price is above or below its own
historical average.

**Settings** — your skills and standings drive the fee model, or you can type in
the exact rates your client quotes you. Capital, cargo size, history window and
the volume share you expect to win are all knobs, because they change which
opportunities are real for *you*.

## Quick start

```bash
npm start            # serves the app on http://localhost:8787
```

Any static server works — the app is plain ES modules with no build step — but it
must be served over HTTP. Opening `index.html` from the filesystem will not work,
because browsers refuse to load ES modules from `file://`.

To put it online, push this repo to GitHub and turn on **Settings → Pages →
Deploy from a branch**, root folder. It is static files; there is nothing to
build and nothing to configure.

## How the numbers are built

| Number | How it is computed |
| --- | --- |
| Profit per unit (station trading) | `sell × (1 − broker − tax) − buy × (1 + broker)` |
| Profit per unit (instant flip) | `bid × (1 − tax) − ask` |
| Profit per unit (hauling) | Buy off sell orders or with a buy order at the source, sell into buy orders or with a sell order at the destination — fees applied per side |
| Units per day | Average daily traded units × your volume share, capped by the depth near the best price and by your capital |
| 5% depth price | The price at which 5% of that side's volume has been consumed, instead of the single best order. Much harder to fool with a one-unit bait order |
| Score | Modelled daily profit, damped for thin markets, volatile prices and heavy order competition |

Fees default to EVE's published baselines (3.00% broker, 4.50% sales tax) reduced
by Accounting, Broker Relations and standings. **CCP has changed these rates and
the skill coefficients more than once.** Check the fee your client quotes on a
real order; if it differs, switch on *Enter fees manually* in Settings and type in
what the game says. Every profit figure depends on it.

## What it cannot see

- **Player structures.** Citadel and Sotiyo markets need an authenticated ESI
  session, so hub scans cover NPC stations only. The item page's "region sell"
  column does include structures that publish their orders publicly.
- **Your assets, orders or wallet.** Those are authenticated endpoints too. This
  tool is deliberately read-only and login-free.
- **The future.** History tells you what traded, not what will.

## Performance notes

The first scan of a region downloads every order page ESI has for it — a few
hundred requests for The Forge, roughly 10–40 seconds on a normal connection.
After that, snapshots are cached for 10 minutes, price history for 6 hours and
item metadata for weeks, all in IndexedDB. The item index (used by the search
box) is built once from `/markets/prices/` plus `/universe/names/` and kept for
three weeks. Raise *Parallel requests* in Settings if your connection can take it.

Everything cached is local. The only network traffic is to `esi.evetech.net`.

## Development

```bash
npm start        # dev server on :8787
npm run mock     # deterministic fake ESI on :8788, for working offline
npm test         # end-to-end browser test against the mock (needs Playwright)
npm run lint     # ESLint
```

`npm test` boots the mock ESI, serves the site, drives it in headless Chromium
and fails on any console error. `npm run test:shots` also writes screenshots of
every page to `.shots/`.

To point the app at the mock by hand, from the browser console:

```js
localStorage.setItem('cm.esi.root', 'http://localhost:8788'); location.reload();
```

### Layout

```
index.html              app shell
assets/css/app.css      all styling
src/app.js              hash router, global search, status line
src/core/esi.js         ESI client: endpoint probing, retries, pagination, pooling
src/core/market.js      order snapshots, order books, price history
src/core/types.js       item index, search, per-item metadata
src/core/calc.js        fees, margins, projections, scoring
src/core/idb.js         IndexedDB cache with TTLs
src/core/store.js       settings + watchlist (localStorage)
src/views/              scanner, hauling, item, watchlist, settings
src/ui/                 table, chart, progress bar, form controls
tools/                  dev server, mock ESI, end-to-end test
```

### A note on ESI addressing

CCP has run two addressing schemes for ESI: versioned path prefixes (`/latest/…`)
and a compatibility-date scheme on the bare root. Rather than betting on one, the
client probes `/status/` under each scheme on first load and remembers what
answered for six hours. If ESI changes under you, Settings → *ESI addressing* lets
you pin a specific scheme, and *Test ESI connection* tells you what is happening.

## Licence

MIT. Do what you like with it.

*EVE Online and all related material are property of CCP hf. This is an
unofficial third-party tool.*
