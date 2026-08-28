import puppeteer from 'puppeteer';
const CHROME = '/nix/store/0n9rl5l9syy808xi9bk4f6dhnfrvhkww-splats-placeholder/chromium-1080/chrome-linux/chrome';
const REAL = '/nix/store/0n9rl5l9syy808xi9bk4f6dhnfrvhkww-playwright-browsers-chromium/chromium-1080/chrome-linux/chrome';
const browser = await puppeteer.launch({
  executablePath: REAL,
  headless: 'new',
  protocolTimeout: 600000,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1440,900',
    '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
page.goto('http://localhost:5000/', { waitUntil: 'domcontentloaded', timeout: 120000 }).catch(() => {});

let booted = false;
for (let i = 0; i < 40; i += 1) {
  await new Promise((r) => setTimeout(r, 2000));
  booted = await page.evaluate(() => !!window.__godsEyeView?.dataManager).catch(() => false);
  if (booted) break;
}
console.log('booted:', booted);

console.log('enable:', await page.evaluate(async () => {
  const dm = window.__godsEyeView.dataManager;
  try { await dm.setEnabled('rocket-launches', true); return 'ok'; }
  catch (e) { return 'threw: ' + e.message; }
}).catch((e) => 'evaluate failed: ' + e.message));

// Let the mission data land and the orbit entities get created.
await new Promise((r) => setTimeout(r, 25000));

console.log(JSON.stringify(await page.evaluate(async () => {
  const urls = [...new Set(performance.getEntriesByType('resource')
    .map((e) => e.name).filter((n) => /deps\/cesium\.js/.test(n)))];
  const out = { cesiumDepUrls: urls.map((u) => u.split('/').pop()) };
  const Cesium = await import(urls[0]);
  out.typeInCache = !!Cesium.Material._materialCache.getMaterial('GevMissionOrbitTactical');
  out.registeredTypes = Object.keys(Cesium.Material._materialCache._materials || {}).filter((t) => /Gev/.test(t));
  const ds = window.__godsEyeView.viewer.dataSources;
  let orbitEntities = 0;
  for (let i = 0; i < ds.length; i += 1) {
    orbitEntities += ds.get(i).entities.values.filter((e) => String(e.id).startsWith('rocket-orbit:')).length;
  }
  out.orbitEntities = orbitEntities;
  return out;
}, {}).catch((e) => ({ evaluateFailed: String(e.message) })), null, 2));
process.exit(0);
