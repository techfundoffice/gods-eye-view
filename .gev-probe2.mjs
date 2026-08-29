import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const SHOTS = process.env.SHOTS;
const DIR = path.join(process.cwd(), 'src', 'adminPlugins');
fs.mkdirSync(DIR, { recursive: true });
const write = (n, b) => fs.writeFileSync(path.join(DIR, n), b);
const manifest = (e) => write('manifest.json', typeof e === 'string' ? e : `${JSON.stringify(e, null, 2)}\n`);
const LAUNCH = {
  headless: 'new', executablePath: process.env.CHROME_PATH,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=swiftshader',
    '--enable-unsafe-swiftshader', '--disable-dev-shm-usage', '--window-size=1440,900'],
};

async function scenario(name, body) {
  const browser = await puppeteer.launch(LAUNCH);
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const frames = [];
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) frames.push(f.url()); });
  try {
    await page.goto('http://127.0.0.1:4207/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#admin-launch');
    await page.click('#admin-launch');
    await page.waitForSelector('#admin-console:not([hidden])');
    await page.type('#admin-password', 'verify-pass');
    await page.click('#admin-login-form button[type=submit]');
    await page.waitForFunction(() => !document.getElementById('admin-dashboard').hidden, { timeout: 20000 });
    await new Promise((r) => setTimeout(r, 5000));
    await body(page, frames);
  } catch (error) {
    console.log(`${name} ERROR: ${error.message.split('\n')[0]}`);
  } finally {
    await browser.close();
  }
}

const menuState = (page) => page.evaluate(() => ({
  items: [...document.querySelectorAll('#admin-menu [data-admin-generated]')].map((n) => n.dataset.adminView),
  errors: document.getElementById('admin-menu-errors')?.hidden ? '' : document.getElementById('admin-menu-errors')?.textContent.trim(),
  dashboardUp: !document.getElementById('admin-dashboard').hidden,
}));

write('good.js', "export default { id:'good', label:'Good', description:'A healthy plugin.', render(c){ c.textContent='healthy plugin content'; } };\n");
write('shapeless.js', "export default { id:'shapeless', label:'Shapeless' };\n");
write('explodes.js', "throw new Error('module blew up at import');\n");

manifest([
  { id: 'escapes', label: 'Escapes', module: '../main.js' },
  { id: 'remote', label: 'Remote', module: 'https://example.com/evil.js' },
  { id: 'good', label: 'Good', module: './good.js' },
]);
await scenario('A', async (page) => {
  console.log('PROBE-A path escape ->', JSON.stringify(await menuState(page)));
  await page.screenshot({ path: `${SHOTS}/05-probe-path-escape.png` });
});

manifest([
  { id: 'shapeless', label: 'Shapeless', module: './shapeless.js' },
  { id: 'explodes', label: 'Explodes', module: './explodes.js' },
  { id: 'good', label: 'Good', module: './good.js' },
]);
await scenario('B', async (page) => {
  console.log('PROBE-B bad modules ->', JSON.stringify(await menuState(page)));
  await page.screenshot({ path: `${SHOTS}/06-probe-bad-modules.png` });
});

// PROBE G — a SECOND build, with the console already open. The agent rewrites
// src/adminPlugins/manifest.json, which Vite already knows about.
manifest([{ id: 'good', label: 'Good', module: './good.js' }]);
await scenario('G', async (page, frames) => {
  await page.evaluate(() => { window.__probeMarker = 'alive'; });
  const before = frames.length;
  await page.type('#admin-plugin-name', 'Second Build');
  await page.click('#admin-plugin-submit');
  await new Promise((r) => setTimeout(r, 12000));
  const state = await page.evaluate(() => ({
    marker: window.__probeMarker || null,
    consoleOpen: !document.getElementById('admin-console').hidden,
    dashboardUp: !document.getElementById('admin-dashboard').hidden,
    generated: [...document.querySelectorAll('#admin-menu [data-admin-generated]')].map((n) => n.dataset.adminView),
  })).catch((e) => ({ evaluateFailed: e.message.split('\n')[0] }));
  console.log('PROBE-G second build ->', JSON.stringify({ navigations: frames.length - before, ...state }));
  await page.screenshot({ path: `${SHOTS}/09-probe-second-build.png` });
});
