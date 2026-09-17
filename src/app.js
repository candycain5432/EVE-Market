// App shell: hash router, global item search and the ESI status line.

import { h, mount, $, $$, debounce, toast } from './util/dom.js';
import { num } from './util/fmt.js';
import { settings } from './core/store.js';
import { detectMode, currentModeId, serverStatus } from './core/esi.js';
import { ensureTypeIndex, searchTypes, indexSize, isIndexed } from './core/types.js';
import { renderScanner } from './views/scanner.js';
import { renderHauling } from './views/hauling.js';
import { renderItem } from './views/item.js';
import { renderWatchlist } from './views/watchlist.js';
import { renderSettings } from './views/settings.js';
import { cancelJob } from './ui/progress.js';

const view = () => document.getElementById('view');

// ---- routing ---------------------------------------------------------------

function parseHash() {
  const raw = (window.location.hash || '#/scanner').replace(/^#\/?/, '');
  const [path, ...rest] = raw.split('/');
  return { route: path || 'scanner', arg: rest[0] ? decodeURIComponent(rest[0]) : null };
}

const ROUTES = {
  scanner: (root) => renderScanner(root),
  hauling: (root) => renderHauling(root),
  item: (root, arg) => renderItem(root, arg),
  watchlist: (root) => renderWatchlist(root),
  settings: (root) => renderSettings(root),
};

let currentRoute = null;

function route() {
  const { route: name, arg } = parseHash();
  const render = ROUTES[name] || ROUTES.scanner;

  // Leaving a page cancels whatever it had in flight.
  if (currentRoute !== name) cancelJob();
  currentRoute = name;

  $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === name));
  document.title = name === 'item' ? 'Capsuleer Market' : `${name[0].toUpperCase()}${name.slice(1)} — Capsuleer Market`;

  const root = view();
  try {
    const out = render(root, arg);
    if (out && typeof out.catch === 'function') out.catch(reportFailure);
  } catch (err) {
    reportFailure(err);
  }
  window.scrollTo({ top: 0 });
}

function reportFailure(err) {
  console.error(err);
  toast(err.message || 'Something went wrong', 'err', 7000);
  mount(view(), h('div.panel', {}, h('div.empty', {},
    h('strong', {}, 'This page failed to load'),
    err.message || String(err),
    h('div', { style: { marginTop: '14px' } },
      h('button.btn.btn-ghost', { onclick: () => route() }, 'Try again')))));
}

// ---- global search ---------------------------------------------------------

function setupSearch() {
  const input = $('#global-search');
  const panel = $('#search-results');
  let items = [];
  let cursor = -1;
  let indexing = false;

  const close = () => { panel.hidden = true; cursor = -1; };

  const paint = () => {
    if (!items.length) {
      mount(panel, h('div.sr-empty', {}, indexing
        ? h('span', {}, h('span.spinner'), ' Building the item index (one-off, a few seconds)…')
        : 'No matching items.'));
      panel.hidden = false;
      return;
    }
    mount(panel, items.map((item, i) => h('div', {
      role: 'option',
      class: i === cursor ? 'sel' : '',
      onclick: () => go(item),
    }, h('span', {}, item.name), h('span.sr-meta', {}, `#${item.id}`))));
    panel.hidden = false;
  };

  const go = (item) => {
    close();
    input.value = '';
    window.location.hash = `#/item/${item.id}`;
  };

  const run = debounce(async () => {
    const q = input.value.trim();
    if (q.length < 2) { close(); return; }

    if (!isIndexed()) {
      indexing = true;
      items = [];
      paint();
      try {
        await ensureTypeIndex({});
      } catch (err) {
        indexing = false;
        mount(panel, h('div.sr-empty', {}, `Could not build the item index: ${err.message}`));
        return;
      }
      indexing = false;
    }

    items = searchTypes(q, 30);
    cursor = items.length ? 0 : -1;
    paint();
  }, 140);

  input.addEventListener('input', run);
  input.addEventListener('focus', () => { if (items.length) panel.hidden = false; });

  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') { close(); input.blur(); return; }
    if (!items.length) return;
    if (ev.key === 'ArrowDown') { cursor = (cursor + 1) % items.length; paint(); ev.preventDefault(); }
    else if (ev.key === 'ArrowUp') { cursor = (cursor - 1 + items.length) % items.length; paint(); ev.preventDefault(); }
    else if (ev.key === 'Enter' && cursor >= 0) { go(items[cursor]); ev.preventDefault(); }
  });

  document.addEventListener('click', (ev) => {
    if (!ev.target.closest('.search-wrap')) close();
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.key === '/' && document.activeElement !== input && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) {
      ev.preventDefault();
      input.focus();
      input.select();
    }
  });
}

// ---- status line -----------------------------------------------------------

async function checkEsi() {
  const el = document.getElementById('esi-status');
  try {
    await detectMode();
    const status = await serverStatus();
    el.className = 'esi-status ok';
    el.textContent = `ESI ok · ${num(status.players)} pilots online · ${currentModeId()}`;
  } catch (err) {
    el.className = 'esi-status err';
    el.textContent = `ESI unreachable — ${err.message}`;
    toast('Could not reach ESI. Check your connection, or try a different addressing mode in Settings.', 'err', 9000);
  }
}

/** Warm the item index quietly so the first search is instant. */
async function warmIndex() {
  try {
    await ensureTypeIndex({});
    const el = document.getElementById('esi-status');
    if (el && el.classList.contains('ok')) el.title = `${indexSize()} items indexed`;
  } catch { /* the search box will retry and report */ }
}

// ---- boot ------------------------------------------------------------------

window.addEventListener('hashchange', route);

setupSearch();
route();
checkEsi().then(warmIndex);

// Surface the current fee configuration in the console for anyone poking around.
console.info('Capsuleer Market — settings:', settings());
