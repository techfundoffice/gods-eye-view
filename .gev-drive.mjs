import fs from 'node:fs';
import puppeteer from 'puppeteer';

const SHOTS = process.env.SHOTS;
const BASE = 'http://127.0.0.1:4207/';
fs.mkdirSync(SHOTS, { recursive: true });

const browser = await puppeteer.launch({
  headless: 'new',
  executablePath: process.env.CHROME_PATH,
  protocolTimeout: 180000,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=swiftshader',
    '--enable-unsafe-swiftshader', '--disable-dev-shm-usage', '--window-size=1440,900'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

const log = (...a) => console.log(...a);
const shot = async (name) => { await page.screenshot({ path: `${SHOTS}/${name}.png` }); return `${SHOTS}/${name}.png`; };

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#admin-launch', { timeout: 90000 });
await new Promise((r) => setTimeout(r, 3000));

// 1. Open the console and sign in as the operator.
await page.click('#admin-launch');
await page.waitForSelector('#admin-console:not([hidden])', { timeout: 10000 });
await page.type('#admin-password', 'verify-pass');
await page.click('#admin-login-form button[type=submit]');
await page.waitForFunction(() => !document.getElementById('admin-dashboard').hidden, { timeout: 10000 });
log('STEP1 signed in; status chip =', await page.$eval('#admin-status', (n) => n.textContent.trim()));
log('STEP1 menu items =', JSON.stringify(await page.$$eval('#admin-menu [data-admin-view]',
  (ns) => ns.map((n) => n.dataset.adminView))));
await shot('01-dashboard-before-build');

// 2. Build a plugin through the console, exactly as an operator would.
await page.type('#admin-plugin-name', 'Fleet Watchlist');
await page.type('#admin-plugin-message', 'Track a saved list of vessels.');
await page.click('#admin-plugin-submit');
await page.waitForFunction(
  () => [...document.querySelectorAll('#admin-menu [data-admin-generated]')].length > 0,
  { timeout: 40000 },
);
log('STEP2 build status =', await page.$eval('#admin-plugin-list .admin-plugin-state', (n) => n.textContent.trim()));
log('STEP2 reloads since load =', await page.evaluate(() => performance.getEntriesByType('navigation').length));
log('STEP2 menu items now =', JSON.stringify(await page.$$eval('#admin-menu [data-admin-view]',
  (ns) => ns.map((n) => ({ view: n.dataset.adminView, label: n.querySelector('strong')?.textContent })))));
await shot('02-menu-after-build');

// 3. Open the generated plugin.
await page.click('#admin-menu [data-admin-generated]');
await page.waitForSelector('#fleet-watchlist-heading', { timeout: 10000 });
log('STEP3 pane =', JSON.stringify(await page.$eval('#admin-plugin-host',
  (n) => ({ hidden: n.hidden, pane: n.dataset.adminPane, text: n.textContent.trim() }))));
log('STEP3 other panes hidden =', await page.$$eval('[data-admin-pane]',
  (ns) => ns.filter((n) => !n.hidden).map((n) => n.dataset.adminPane).join(',')));
await shot('03-plugin-rendered');

// 4. Leave the plugin: its cleanup must run and the pane must empty.
await page.click('#admin-menu [data-admin-view="mcp-server"]');
await page.waitForFunction(() => document.getElementById('admin-plugin-host').hidden, { timeout: 5000 });
log('STEP4 teardown count =', await page.evaluate(() => window.__fleetWatchlistTornDown || 0));
log('STEP4 pane =', JSON.stringify(await page.$eval('#admin-plugin-host',
  (n) => ({ hidden: n.hidden, pane: n.dataset.adminPane, text: n.textContent.trim() }))));
await shot('04-after-leaving-plugin');

// 5. Re-enter, then close the whole console — cleanup must run again.
await page.click('#admin-menu [data-admin-generated]');
await page.waitForSelector('#fleet-watchlist-heading', { timeout: 5000 });
await page.click('#admin-close');
log('STEP5 teardown count after close =', await page.evaluate(() => window.__fleetWatchlistTornDown || 0));

log('ERRORS', JSON.stringify(errors.slice(0, 10)));
await browser.close();
