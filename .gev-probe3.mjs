import puppeteer from 'puppeteer';
const browser = await puppeteer.launch({
  headless: 'new', executablePath: process.env.CHROME_PATH,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message.slice(0, 300)));
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE-ERR:', m.text().slice(0, 200)); });
await page.goto('http://127.0.0.1:4207/', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#admin-launch');
await new Promise((r) => setTimeout(r, 8000)); // let main.js finish booting
console.log('boot state:', JSON.stringify(await page.evaluate(() => ({
  hasCesium: Boolean(window.Cesium),
  compatScreen: Boolean(document.querySelector('[class*="compat"]:not([hidden])')),
  adminHidden: document.getElementById('admin-console')?.hidden,
}))));
await page.click('#admin-launch');
await page.waitForSelector('#admin-console:not([hidden])');
await page.type('#admin-password', 'verify-pass');
await page.click('#admin-login-form button[type=submit]');
await page.waitForFunction(() => !document.getElementById('admin-dashboard').hidden);
await page.mouse.move(10, 890); // park the pointer away from the menu
await new Promise((r) => setTimeout(r, 6000));
console.log('MENU STATE:', JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('#admin-menu [data-admin-view]')].map((n) => ({
  view: n.dataset.adminView,
  active: n.classList.contains('active'),
  ariaCurrent: n.getAttribute('aria-current'),
})))));
// Keyboard reachability of a generated item.
console.log('TAB ORDER contains generated?', await page.evaluate(() => {
  const all = [...document.querySelectorAll('#admin-menu button')];
  return all.map((n) => `${n.dataset.adminView}:${n.tabIndex}`).join(' ');
}));
await browser.close();
