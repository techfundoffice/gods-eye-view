import puppeteer from 'puppeteer';
const browser = await puppeteer.launch({
  headless: 'new', executablePath: '/repl/tools/bin/chromium', protocolTimeout: 180000,
  args: ['--no-sandbox','--disable-setuid-sandbox','--use-gl=swiftshader',
    '--enable-unsafe-swiftshader','--disable-dev-shm-usage','--window-size=1600,1000',
    '--autoplay-policy=no-user-gesture-required'],
});
try {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    window.__byPlayer = {};
    window.addEventListener('message', (e) => {
      if (!String(e.origin).includes('youtube')) return;
      try {
        const d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
        if (!d?.info || typeof d.info.muted !== 'boolean') return;
        for (const f of document.querySelectorAll('.gev-home-video-iframe')) {
          if (f.contentWindow === e.source) {
            window.__byPlayer[f.closest('section').id] = { muted: d.info.muted, volume: d.info.volume };
          }
        }
      } catch {}
    });
  });
  await page.setViewport({ width: 1600, height: 1000 });
  await page.goto('http://localhost:4173/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('#gev-split-view .gev-home-video-iframe', { timeout: 40000 });
  await new Promise((r) => setTimeout(r, 11000));
  console.log('per-player audio:', JSON.stringify(await page.evaluate(() => window.__byPlayer)));
  console.log('geometry:', JSON.stringify(await page.evaluate(() => {
    const b = (id) => { const r = document.getElementById(id).getBoundingClientRect();
      return { x: Math.round(r.x), w: Math.round(r.width) }; };
    return { player1: b('gev-home-video'), splitView: b('gev-split-view'),
      iframes: document.querySelectorAll('.gev-home-video-iframe').length };
  })));
} finally { await browser.close(); }
