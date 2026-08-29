import puppeteer from 'puppeteer';
const browser = await puppeteer.launch({
  headless: 'new', executablePath: process.env.CHROME_PATH,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE-ERR:', m.text().slice(0, 200)); });
page.on('requestfailed', (r) => console.log('REQFAIL:', r.url(), r.failure()?.errorText));
await page.goto('http://127.0.0.1:4207/', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#admin-launch');
await page.click('#admin-launch');
await page.waitForSelector('#admin-console:not([hidden])');
const signedIn = await page.evaluate(() => !document.getElementById('admin-dashboard').hidden);
if (!signedIn) {
  await page.type('#admin-password', 'verify-pass');
  await page.click('#admin-login-form button[type=submit]');
  await page.waitForFunction(() => !document.getElementById('admin-dashboard').hidden);
}
await new Promise((r) => setTimeout(r, 2500));
console.log('MENU BUTTONS:', await page.$$eval('#admin-menu [data-admin-generated]', (ns) => ns.map((n) => n.dataset.adminView)));

console.log('IN-PAGE menu fetch:', await page.evaluate(async () => {
  const res = await fetch('/api/admin/menu', { credentials: 'same-origin' });
  return `${res.status} ${(await res.text()).slice(0, 200)}`;
}));

for (const file of ['good.js', 'angry.js', 'explodes.js', 'shapeless.js']) {
  console.log(`IN-PAGE import ${file}:`, await page.evaluate(async (f) => {
    const started = performance.now();
    try {
      const mod = await Promise.race([
        import(/* @vite-ignore */ `/src/adminPlugins/${f}`),
        new Promise((_, reject) => setTimeout(() => reject(new Error('TIMED OUT after 5s')), 5000)),
      ]);
      return `ok in ${Math.round(performance.now() - started)}ms, default=${typeof mod.default}, render=${typeof mod.default?.render}`;
    } catch (error) {
      return `threw in ${Math.round(performance.now() - started)}ms: ${error.message}`;
    }
  }, file));
}
await browser.close();
