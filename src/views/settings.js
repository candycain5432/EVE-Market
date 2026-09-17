// Settings: fees, trading assumptions, networking and cache maintenance.

import { h, mount, toast } from '../util/dom.js';
import { num } from '../util/fmt.js';
import { settings, saveSettings, resetSettings } from '../core/store.js';
import { fees } from '../core/calc.js';
import { idbClear, idbStats } from '../core/idb.js';
import { ensureTypeIndex, indexSize } from '../core/types.js';
import { currentModeId, resetMode, serverStatus } from '../core/esi.js';
import { HUBS } from '../data/hubs.js';
import { panel, numberField, selectField, checkField, stat } from '../ui/controls.js';
import { startJob, endJob, setProgress, isAbort } from '../ui/progress.js';

export function renderSettings(root) {
  const s = settings();
  const f = fees(s);
  const rerender = () => renderSettings(root);
  const set = (patch) => { saveSettings(patch); };

  const cacheInfo = h('div.stats', {}, stat('Cache', '…', 'reading'));
  idbStats().then((info) => mount(cacheInfo,
    stat('Cached objects', num(info.keys), info.backend === 'memory' ? 'in-memory fallback' : 'IndexedDB'),
    stat('Storage used', info.bytes ? `${(info.bytes / 1e6).toFixed(1)} MB` : 'n/a', 'browser estimate'),
    stat('Item index', num(indexSize()), indexSize() ? 'items searchable' : 'not built yet'),
    stat('ESI endpoint', currentModeId() || 'probing…', 'addressing scheme in use'),
  ));

  mount(root,
    h('div.page-head', {}, h('div', {},
      h('h1', {}, 'Settings'),
      h('p', {}, 'Everything is stored in this browser only — no account, no server, nothing leaves the machine except calls to ESI.'))),

    panel('Fees and skills',
      checkField('Enter fees manually', s.manualFees, (v) => { set({ manualFees: v }); rerender(); }),
      s.manualFees
        ? h('div.controls', {},
          numberField('Broker fee %', s.brokerFeePct, (v) => set({ brokerFeePct: v ?? 0 }), { min: 0, max: 10, step: 0.01, width: '120px' }),
          numberField('Sales tax %', s.salesTaxPct, (v) => set({ salesTaxPct: v ?? 0 }), { min: 0, max: 10, step: 0.01, width: '120px' }))
        : h('div.controls', {},
          numberField('Accounting level', s.accounting, (v) => { set({ accounting: v ?? 0 }); rerender(); }, { min: 0, max: 5, step: 1, width: '100px' }),
          numberField('Broker Relations', s.brokerRelations, (v) => { set({ brokerRelations: v ?? 0 }); rerender(); }, { min: 0, max: 5, step: 1, width: '100px' }),
          numberField('Faction standing', s.factionStanding, (v) => { set({ factionStanding: v ?? 0 }); rerender(); }, { min: -10, max: 10, step: 0.1, width: '110px' }),
          numberField('Corp standing', s.corpStanding, (v) => { set({ corpStanding: v ?? 0 }); rerender(); }, { min: -10, max: 10, step: 0.1, width: '110px' }),
          numberField('Base broker %', s.baseBrokerFee, (v) => { set({ baseBrokerFee: v ?? 3 }); rerender(); }, { min: 0, max: 10, step: 0.05, width: '110px' }),
          numberField('Base sales tax %', s.baseSalesTax, (v) => { set({ baseSalesTax: v ?? 4.5 }); rerender(); }, { min: 0, max: 10, step: 0.05, width: '120px' }),
          numberField('Accounting per level %', s.accountingPerLevel, (v) => { set({ accountingPerLevel: v ?? 11 }); rerender(); }, { min: 0, max: 30, step: 0.5, width: '140px' }),
          numberField('Broker pp per level', s.brokerPerLevel, (v) => { set({ brokerPerLevel: v ?? 0.3 }); rerender(); }, { min: 0, max: 1, step: 0.05, width: '130px' })),
      h('div.stats', { style: { marginTop: '12px' } },
        stat('Effective broker fee', `${(f.brokerFee * 100).toFixed(3)}%`, 'charged on each order you place'),
        stat('Effective sales tax', `${(f.salesTax * 100).toFixed(3)}%`, 'charged when a sale completes'),
        stat('Round trip cost', `${((f.brokerFee * 2 + f.salesTax) * 100).toFixed(3)}%`, 'buy order + sell order + tax')),
      h('div.note', { style: { marginTop: '12px' } },
        'CCP has changed these rates and the skill coefficients more than once. Open the market window in game, look at the fee it quotes you on a real order, and if it differs from the numbers above, switch on ',
        h('em', {}, 'Enter fees manually'), ' and type in what the client says. Every profit figure in this tool depends on it.')),

    panel('Trading assumptions', null,
      h('div.controls', {},
        selectField('Home hub', s.homeHub, HUBS.map((x) => ({ value: x.id, label: `${x.name} — ${x.region}` })), (v) => set({ homeHub: Number(v) })),
        numberField('Capital (ISK)', s.capital, (v) => set({ capital: v ?? 0 }), { min: 0, width: '160px' }),
        numberField('Cargo (m³)', s.cargo, (v) => set({ cargo: v ?? 0 }), { min: 1, width: '120px' }),
        numberField('Volume share', s.volumeShare, (v) => set({ volumeShare: v ?? 0.15 }), { min: 0, max: 1, step: 0.01, width: '110px', hint: 'share of daily units you win' }),
        numberField('History window (days)', s.historyDays, (v) => set({ historyDays: Math.max(5, v ?? 30) }), { min: 5, max: 365, step: 1, width: '140px' }),
        numberField('Min competing orders', s.minOrderCount, (v) => set({ minOrderCount: v ?? 0 }), { min: 0, width: '150px', hint: 'skip dead items' })),
      h('div.note', { style: { marginTop: '12px' } },
        'Volume share is the honest knob: 0.15 assumes you win about 15% of an item\'s daily turnover against the other traders camping it. Lower it if you are being 0.01-ISK undercut around the clock.')),

    panel('Network and data', null,
      h('div.controls', {},
        numberField('Parallel requests', s.concurrency, (v) => set({ concurrency: Math.min(32, Math.max(1, v ?? 12)) }), { min: 1, max: 32, step: 1, width: '120px', hint: 'higher = faster scans' }),
        selectField('ESI addressing', s.esiMode, [
          { value: 'auto', label: 'Auto-detect' },
          { value: 'latest', label: '/latest/ paths' },
          { value: 'compat-query', label: 'compatibility_date query' },
          { value: 'compat-header', label: 'X-Compatibility-Date header' },
        ], (v) => { set({ esiMode: v }); resetMode(); toast('Endpoint style changed — reloading', 'info'); setTimeout(() => window.location.reload(), 600); }),
        h('label.field', {}, h('label', {}, 'Contact (optional)'),
          h('input', {
            type: 'text', value: s.contact, placeholder: 'you@example.com',
            oninput: (ev) => set({ contact: ev.target.value.trim() }),
          }),
          h('span.hint', {}, 'sent to ESI as a courtesy identifier'))),
      h('div.btn-row', { style: { marginTop: '12px' } },
        h('button.btn.btn-ghost', { onclick: () => probe() }, 'Test ESI connection'),
        h('button.btn.btn-ghost', { onclick: () => rebuildIndex() }, 'Rebuild item index'),
        h('button.btn.btn-ghost', { onclick: () => clearCache('orders.') }, 'Clear order snapshots'),
        h('button.btn.btn-ghost', { onclick: () => clearCache('history.') }, 'Clear price history'),
        h('button.btn.btn-ghost', { onclick: () => clearCache('') }, 'Clear all cached data'),
        h('button.btn.btn-ghost', {
          onclick: () => { resetSettings(); toast('Settings reset to defaults', 'ok'); rerender(); },
        }, 'Reset settings')),
      h('div', { style: { marginTop: '12px' } }, cacheInfo)),

    panel('How the numbers are built', null,
      h('div.note', {}, h('strong', {}, 'Station trading'), ' — every order page for the hub\'s region is downloaded and filtered to the station, then each candidate gets its real traded volume from market history. Profit assumes you place a buy order and a sell order, paying broker fee twice and sales tax once.'),
      h('div.note', {}, h('strong', {}, '5% depth prices'), ' — instead of the single best order (often one unit priced to bait), the tool can use the price at which 5% of the book\'s volume has been consumed. Slower to trigger, much harder to fool.'),
      h('div.note', {}, h('strong', {}, 'Units/day'), ' — average daily traded units × your volume share, capped by the depth near the best price and by your capital.'),
      h('div.note', {}, h('strong', {}, 'Score'), ' — modelled daily profit, damped for thin markets, volatile prices and heavy order competition. Sort by profit/day if you would rather judge crowding yourself.'),
      h('div.note', {}, h('strong', {}, 'What it cannot see'), ' — orders inside player structures (Citadels and the like) need an authenticated ESI session, so hub figures cover NPC stations. Region-wide prices on the item page do include structures that publish their market publicly.')),
  );

  async function probe() {
    const signal = startJob('Testing ESI…');
    try {
      const status = await serverStatus({ signal });
      toast(`ESI is up — ${num(status.players)} players online, ${status.server_version}`, 'ok', 6000);
      rerender();
    } catch (err) {
      if (!isAbort(err)) toast(err.message || 'ESI unreachable', 'err', 8000);
    } finally {
      endJob();
    }
  }

  async function rebuildIndex() {
    const signal = startJob('Rebuilding item index…');
    try {
      await ensureTypeIndex({ signal, force: true, onProgress: setProgress });
      toast(`Item index rebuilt — ${num(indexSize())} items`, 'ok');
      rerender();
    } catch (err) {
      if (!isAbort(err)) toast(err.message || 'Rebuild failed', 'err');
    } finally {
      endJob();
    }
  }

  async function clearCache(prefix) {
    await idbClear(prefix);
    toast(prefix ? `Cleared "${prefix}*" cache` : 'Cleared all cached data', 'ok');
    rerender();
  }
}
