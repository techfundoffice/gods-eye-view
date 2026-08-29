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

/** One scenario = one fresh browser, so no HMR reload from a prior write hits it. */
async function scenario(name, body) {
  const browser = await puppeteer.launch(LAUNCH);
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  try {
    await page.goto('http://127.0.0.1:4207/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#admin-launch');
    await page.click('#admin-launch');
    await page.waitForSelector('#admin-console:not([hidden])');
    await page.type('#admin-password', 'verify-pass');
    await page.click('#admin-login-form button[type=submit]');
    await page.waitForFunction(() => !document.getElementById('admin-dashboard').hidden, { timeout: 20000 });
    await new Promise((r) => setTimeout(r, 5000)); // sequential module imports, ~750ms each
    await body(page);
    if (errs.length) console.log(`  ${name} page errors:`, JSON.stringify(errs.slice(0, 3)));
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
write('angry.js', "export default { id:'angry', label:'Angry', render(){ throw new Error('render exploded'); } };\n");

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

manifest([{ id: 'angry', label: 'Angry', module: './angry.js' }, { id: 'good', label: 'Good', module: './good.js' }]);
await scenario('C', async (page) => {
  await page.click('#admin-menu [data-admin-view="angry"]');
  await new Promise((r) => setTimeout(r, 500));
  console.log('PROBE-C render throw ->', JSON.stringify(await page.evaluate(() => ({
    message: document.getElementById('admin-message')?.hidden ? '' : document.getElementById('admin-message').textContent.trim(),
    paneText: document.getElementById('admin-plugin-host').textContent.trim(),
    paneShown: !document.getElementById('admin-plugin-host').hidden,
  }))));
  await page.screenshot({ path: `${SHOTS}/07-probe-render-throw.png` });
  await page.click('#admin-menu [data-admin-view="good"]');
  await new Promise((r) => setTimeout(r, 500));
  console.log('PROBE-C recovery ->', JSON.stringify(await page.evaluate(() => ({
    pane: document.getElementById('admin-plugin-host').dataset.adminPane,
    text: document.getElementById('admin-plugin-host').textContent.trim(),
  }))));
});

manifest('[{"id":"good", "module": ');
await scenario('D', async (page) => {
  console.log('PROBE-D broken manifest ->', JSON.stringify(await menuState(page)));
});

manifest([
  { id: 'good', label: 'Good', module: './good.js' },
  { id: 'good', label: 'Good Again', module: './good.js' },
]);
await scenario('E', async (page) => {
  console.log('PROBE-E duplicate ids ->', JSON.stringify(await menuState(page)));
});

manifest([{ id: 'good', label: 'Good', module: './good.js' }]);
await scenario('F', async (page) => {
  await page.click('#admin-menu [data-admin-view="good"]');
  await page.waitForFunction(() => document.getElementById('admin-plugin-host').dataset.adminPane === 'good');
  console.log('PROBE-F before ->', JSON.stringify(await page.evaluate(() => document.getElementById('admin-plugin-host').dataset.adminPane)));
  manifest([]);
  // A real operator goes back to the builder pane before starting a build.
  await page.click('#admin-menu [data-admin-view="create-plugin"]');
  await new Promise((r) => setTimeout(r, 300));
  await page.type('#admin-plugin-name', 'Second Build');
  await page.click('#admin-plugin-submit');
  await page.waitForFunction(
    () => [...document.querySelectorAll('#admin-menu [data-admin-generated]')].some((n) => n.dataset.adminView === 'second-build'),
    { timeout: 60000 },
  );
  await new Promise((r) => setTimeout(r, 1500));
  console.log('PROBE-F vanished plugin ->', JSON.stringify(await page.evaluate(() => ({
    activeView: document.querySelector('#admin-menu [data-admin-view].active')?.dataset.adminView,
    visiblePanes: [...document.querySelectorAll('[data-admin-pane]')].filter((n) => !n.hidden).map((n) => n.dataset.adminPane),
    hostPane: document.getElementById('admin-plugin-host').dataset.adminPane,
    generated: [...document.querySelectorAll('#admin-menu [data-admin-generated]')].map((n) => n.dataset.adminView),
  }))));
  await page.screenshot({ path: `${SHOTS}/08-probe-vanished.png` });
});
