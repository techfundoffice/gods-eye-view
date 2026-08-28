import puppeteer from 'puppeteer';
const CHROME = '/nix/store/0n9rl5l9syy808xi9bk4f6dhnfrvhkww-playwright-browsers-chromium/chromium-1080/chrome-linux/chrome';
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
page.goto('http://localhost:5000/', { waitUntil: 'domcontentloaded', timeout: 120000 }).catch(() => {});

let booted = false;
for (let i = 0; i < 40; i += 1) {
  await new Promise((r) => setTimeout(r, 2000));
  booted = await page.evaluate(() => !!window.__godsEyeView?.dataManager).catch(() => false);
  if (booted) break;
}
console.log('booted:', booted);

const diag = await page.evaluate(async () => {
  const url = performance.getEntriesByType('resource')
    .map((e) => e.name).find((n) => /deps\/cesium\.js/.test(n));
  if (!url) return { error: 'cesium dep url not found' };
  const Cesium = await import(url);
  const out = { url: url.split('/').pop() };
  out.cachedBefore = !!Cesium.Material._materialCache.getMaterial('GevMissionOrbitTactical');
  // Reproduce the app's registration verbatim and capture any throw.
  try {
    new Cesium.Material({
      fabric: {
        type: 'GevMissionOrbitTactical',
        uniforms: { color: Cesium.Color.CYAN, groupCount: 8, dashCount: 10 },
        source: `
          czm_material czm_getMaterial(czm_materialInput materialInput) {
            czm_material material = czm_getDefaultMaterial(materialInput);
            float groupPosition = fract(materialInput.st.s * groupCount);
            float markPosition = groupPosition * (dashCount + 1.0);
            float localPosition = fract(markPosition);
            float edge = max(fwidth(localPosition) * 1.35, 0.012);
            material.diffuse = color.rgb;
            material.alpha = color.a * edge;
            return material;
          }`,
      },
    });
    out.registerThrew = null;
  } catch (e) { out.registerThrew = String(e && e.message || e).split('\n')[0]; }
  out.cachedAfter = !!Cesium.Material._materialCache.getMaterial('GevMissionOrbitTactical');
  return out;
}).catch((e) => ({ evaluateFailed: String(e.message) }));

console.log(JSON.stringify(diag, null, 2));
process.exit(0);
