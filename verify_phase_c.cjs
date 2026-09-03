const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

(async () => {
  const outDir = '/tmp/gev-shots-phase-c';
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--window-size=1600,1000'],
    defaultViewport: { width: 1600, height: 1000, deviceScaleFactor: 1 },
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(60000);
  await page.goto('http://127.0.0.1:5000/?phasec=' + Date.now(), { waitUntil: 'networkidle2', timeout: 60000 });
  await page.waitForSelector('#cesiumContainer', { timeout: 30000 });
  await page.waitForSelector('#youtube-comments-panel', { timeout: 30000 });
  // give HUD placeRec / css a moment
  await new Promise((r) => setTimeout(r, 8000));

  const probe = await page.evaluate(() => {
    const cesium = document.getElementById('cesiumContainer');
    const chat = document.getElementById('youtube-comments-panel');
    const stack = document.getElementById('admin-stamp-stack');
    const cr = cesium?.getBoundingClientRect();
    const ar = chat?.getBoundingClientRect();
    const sr = stack?.getBoundingClientRect();
    const cs = cesium ? getComputedStyle(cesium) : null;
    const root = getComputedStyle(document.documentElement);
    return {
      eastBand: root.getPropertyValue('--youtube-east-band').trim(),
      chatRail: root.getPropertyValue('--youtube-chat-rail-width').trim(),
      cesiumRightCSS: cs?.right,
      cesium: cr && { left: cr.left, right: cr.right, width: cr.width, top: cr.top, bottom: cr.bottom },
      chat: ar && { left: ar.left, right: ar.right, width: ar.width, top: ar.top, bottom: ar.bottom },
      stack: sr && { left: sr.left, right: sr.right, width: sr.width },
      gap: (ar && cr) ? (ar.left - cr.right) : null,
      ok: (ar && cr) ? (ar.left >= cr.right - 1) : false,
      vw: innerWidth,
      vh: innerHeight,
      chatParent: chat?.parentElement?.id || null,
    };
  });

  fs.writeFileSync(path.join(outDir, 'probe.json'), JSON.stringify(probe, null, 2));
  await page.screenshot({ path: path.join(outDir, 'full.png'), fullPage: false });
  // top-right crop via clip
  await page.screenshot({
    path: path.join(outDir, 'topright.png'),
    clip: { x: 1100, y: 0, width: 500, height: 700 },
  });
  console.log(JSON.stringify(probe, null, 2));
  await browser.close();
})().catch((err) => {
  console.error('VERIFY_FAIL', err);
  process.exit(1);
});
