#!/usr/bin/env node
// End-to-end smoke test: boots the mock ESI, serves the site, drives it in a
// real browser and fails on any console error or missing result.
//
//   NODE_PATH=$(npm root -g) node tools/e2e.mjs [--headed] [--shots <dir>]

import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { serveStatic } from './serve.js';

// Playwright may only be installed globally (as it is in the dev container),
// and ESM does not honour NODE_PATH — so fall back to the global root.
const chromium = await (async () => {
  let mod;
  try {
    mod = await import('playwright');
  } catch {
    const globalRoot = execSync('npm root -g').toString().trim();
    mod = await import(pathToFileURL(path.join(globalRoot, 'playwright', 'index.js')).href);
  }
  // Playwright ships CommonJS, so a dynamic import can land it under `default`.
  return mod.chromium || (mod.default && mod.default.chromium);
})();

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE_PORT = 8787;
const ESI_PORT = 8788;
const shotsArg = process.argv.indexOf('--shots');
const SHOTS = shotsArg > -1 ? process.argv[shotsArg + 1] : null;

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function shot(page, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
}

const run = async () => {
  const esi = spawn('node', [path.join(ROOT, 'tools/mock-esi.js'), String(ESI_PORT)], { stdio: 'ignore' });
  const site = await serveStatic(SITE_PORT);
  await new Promise((r) => setTimeout(r, 600));

  const browser = await chromium.launch({ headless: !process.argv.includes('--headed') });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });

  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

  await page.addInitScript((port) => {
    localStorage.setItem('cm.esi.root', `http://localhost:${port}`);
  }, ESI_PORT);

  try {
    // ---- boot ------------------------------------------------------------
    await page.goto(`http://localhost:${SITE_PORT}/`, { waitUntil: 'load' });
    await page.waitForSelector('#esi-status.ok', { timeout: 20000 });
    check('ESI status line goes green', true, await page.textContent('#esi-status'));
    await shot(page, '01-boot');

    // ---- search ----------------------------------------------------------
    await page.fill('#global-search', 'Tritanium');
    await page.waitForSelector('#search-results div[role="option"]', { timeout: 25000 });
    const hits = await page.locator('#search-results div[role="option"]').count();
    check('item search returns hits', hits > 0, `${hits} results`);
    await shot(page, '02-search');

    await page.locator('#search-results div[role="option"]').first().click();
    await page.waitForSelector('.book-row.buy', { timeout: 25000 });
    const hubRows = await page.locator('.panel table.data tbody tr').first().count();
    check('item page renders hub comparison', hubRows > 0);
    check('item page renders an order book', (await page.locator('.book-row.buy').count()) > 1);
    await page.waitForSelector('svg.chart', { timeout: 30000 });
    check('item page renders the history chart', (await page.locator('svg.chart').count()) === 1);
    await shot(page, '03-item');

    // hover the chart to exercise the tooltip path
    const chart = page.locator('svg.chart');
    await chart.hover({ position: { x: 400, y: 100 } });
    check('chart tooltip appears on hover', await page.locator('.chart-tip').isVisible());

    // ---- station trading scanner ----------------------------------------
    await page.click('a[data-route="scanner"]');
    await page.waitForSelector('button:has-text("Scan market")');
    await page.click('button:has-text("Scan market")');
    // Wait on a scanner-specific marker, not just any table: the previous
    // view's DOM can still be on screen the instant after a route change.
    await page.waitForSelector('.stat:has-text("Opportunities")', { timeout: 90000 });
    await page.waitForSelector('.panel table.data tbody tr', { timeout: 90000 });
    const scanRows = await page.locator('.panel table.data tbody tr').count();
    check('scanner finds opportunities', scanRows > 0, `${scanRows} rows`);
    const statText = await page.locator('.stat').first().innerText();
    check('scanner shows a summary', statText.length > 0, statText.replace(/\n/g, ' '));
    await shot(page, '04-scanner');

    // sorting must not explode
    await page.locator('table.data th', { hasText: 'Margin' }).first().click();
    check('scanner table re-sorts', (await page.locator('.panel table.data tbody tr').count()) > 0);

    // ---- hauling ---------------------------------------------------------
    await page.click('a[data-route="hauling"]');
    await page.waitForSelector('button:has-text("Find cargo")');
    await page.click('button:has-text("Find cargo")');
    await page.waitForSelector('.stat:has-text("One full hold")', { timeout: 120000 });
    await page.waitForSelector('.panel table.data tbody tr', { timeout: 120000 });
    const haulRows = await page.locator('.panel table.data tbody tr').count();
    check('hauling finds cargo', haulRows > 0, `${haulRows} rows`);
    const holdStat = await page.locator('.stat:has-text("One full hold") .v').innerText();
    check('hauling computes a full hold', holdStat !== '—', holdStat);
    await shot(page, '05-hauling');

    // ---- watchlist -------------------------------------------------------
    await page.click('a[data-route="scanner"]');
    await page.waitForSelector('button.star');
    await page.locator('button.star').first().click();
    await page.click('a[data-route="watchlist"]');
    await page.waitForSelector('button:has-text("Remove")', { timeout: 30000 });
    check('watchlist prices a starred item', (await page.locator('.panel table.data tbody tr').count()) > 0);
    await shot(page, '06-watchlist');

    // ---- settings --------------------------------------------------------
    await page.click('a[data-route="settings"]');
    await page.waitForSelector('button:has-text("Test ESI connection")');
    await page.click('button:has-text("Test ESI connection")');
    const esiToast = page.locator('.toast.ok', { hasText: 'ESI is up' });
    await esiToast.first().waitFor({ timeout: 20000 });
    check('settings can test the ESI connection', true, await esiToast.first().innerText());
    const effective = await page.locator('.stat:has-text("Effective broker fee") .v').innerText();
    check('settings shows effective fees', /%/.test(effective), effective);
    await shot(page, '07-settings');

    // ---- mobile layout ---------------------------------------------------
    await page.setViewportSize({ width: 390, height: 844 });
    await page.click('a[data-route="scanner"]');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check('no horizontal overflow at phone width', overflow <= 1, `${overflow}px`);
    await shot(page, '08-mobile');
  } catch (err) {
    check('test run completed', false, err.message);
  } finally {
    check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 5).join(' | '));
    await browser.close();
    site.close();
    esi.kill();
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
};

run();
