import puppeteer from 'puppeteer';
const CHROME = '/nix/store/0n9rl5l9syy808xi9bk4f6dhnfrvhkww-playwright-browsers-chromium/chromium-1080/chrome-linux/chrome';
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new', protocolTimeout: 600000,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1440,900',
    '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
const tileReqs = [];
page.on('request', (r) => { if (/tile\.googleapis\.com/.test(r.url())) tileReqs.push(r.url()); });
page.goto('http://localhost:5000/', { waitUntil: 'domcontentloaded', timeout: 120000 }).catch(() => {});

for (let i = 0; i < 40; i += 1) {
  await new Promise((r) => setTimeout(r, 2000));
  if (await page.evaluate(() => !!window.__godsEyeView?.viewer).catch(() => false)) break;
}
await new Promise((r) => setTimeout(r, 20000));

const state = await page.evaluate(() => {
  const g = window.__godsEyeView;
  const v = g?.viewer;
  const t = g?.tileset;
  const prims = v?.scene?.primitives;
  let inPrimitives = false;
  for (let i = 0; prims && i < prims.length; i += 1) if (prims.get(i) === t) inPrimitives = true;
  return {
    hasTileset: !!t,
    inPrimitives,
    primitiveCount: prims?.length ?? null,
    tilesetShow: t?.show ?? null,
    tilesetReady: t?.ready ?? null,
    tilesLoaded: t?.tilesLoaded ?? null,
    maxSSE: t?.maximumScreenSpaceError ?? null,
    rootAvailable: !!t?.root,
    rootChildren: t?.root?.children?.length ?? null,
    statsSelected: t?.statistics?.selected ?? null,
    statsVisited: t?.statistics?.visited ?? null,
    statsNumberOfPendingRequests: t?.statistics?.numberOfPendingRequests ?? null,
    globeShow: v?.scene?.globe?.show ?? null,
    requestRenderMode: v?.scene?.requestRenderMode ?? null,
    mapStackActive: g?.mapStackController?.getState?.()?.activeId ?? null,
    mapStackError: g?.mapStackController?.getState?.()?.lastError ?? null,
    cameraHeight: v?.camera?.positionCartographic?.height ?? null,
    governor: g?.getRenderGovernorDiagnostics?.() ?? null,
  };
}).catch((e) => ({ evaluateFailed: String(e.message) }));

console.log('tile.googleapis.com requests:', tileReqs.length);
console.log(tileReqs.slice(0, 6).map((u) => u.replace(/key=[^&]+/, 'key=***').slice(0, 130)).join('\n'));
console.log(JSON.stringify(state, null, 2));
process.exit(0);
