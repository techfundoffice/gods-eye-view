import puppeteer from 'puppeteer';
const CHROME = '/nix/store/0n9rl5l9syy808xi9bk4f6dhnfrvhkww-playwright-browsers-chromium/chromium-1080/chrome-linux/chrome';
const layerId = process.argv[2] || 'rocket-launches';
const seconds = Number(process.argv[3] || 45);

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  protocolTimeout: 600000,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1440,900',
    '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
const lines = [];
page.on('console', (m) => lines.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => lines.push(`[pageerror] ${String(e.message || e).split('\n')[0]}`));
page.goto('http://localhost:5000/', { waitUntil: 'domcontentloaded', timeout: 120000 }).catch(() => {});

// Wait for bootstrap without evaluate-blocking the busy page.
let booted = false;
for (let i = 0; i < 40; i += 1) {
  await new Promise((r) => setTimeout(r, 2000));
  booted = await page.evaluate(() => !!window.__godsEyeView?.dataManager).catch(() => false);
  if (booted) break;
}
console.log('booted:', booted);

if (booted) {
  const enabled = await page.evaluate(async (id) => {
    const dm = window.__godsEyeView.dataManager;
    const layer = dm.getAll().find((l) => l.id === id);
    if (!layer) return 'layer not found: ' + dm.getAll().map((l) => l.id).join(',');
    try { await dm.setEnabled(layer.id, true); return 'enabled ' + layer.id; }
    catch (e) { return 'enable threw: ' + e.message; }
  }, layerId).catch((e) => 'evaluate failed: ' + e.message);
  console.log('enable:', enabled);
}

await new Promise((r) => setTimeout(r, seconds * 1000));
const interesting = lines.filter((l) => /error|Error|does not exist|Rendering has stopped|GPU|warn/i.test(l));
console.log('=== INTERESTING (' + interesting.length + '/' + lines.length + ') ===');
console.log(interesting.join('\n'));
process.exit(0);
