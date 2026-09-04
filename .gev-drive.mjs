import puppeteer from 'puppeteer';
const browser = await puppeteer.launch({
  headless: 'new',
  executablePath: '/repl/tools/bin/chromium',
  protocolTimeout: 180000,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=swiftshader',
    '--enable-unsafe-swiftshader', '--disable-dev-shm-usage', '--window-size=1440,900'],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto('http://localhost:4173/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('#gev-home-video', { timeout: 30000 });
  await new Promise((r) => setTimeout(r, 2500));

  const report = await page.evaluate(() => {
    const cs = (sel, prop) => {
      const el = document.querySelector(sel);
      if (!el) return `MISSING ${sel}`;
      return getComputedStyle(el)[prop];
    };
    const ph = () => {
      const el = document.getElementById('gev-home-video-url');
      return getComputedStyle(el, '::placeholder').color;
    };
    const status = document.getElementById('gev-home-video-status');
    status.textContent = 'probe';
    status.dataset.tone = 'ok';
    const okColor = getComputedStyle(status).color;
    status.dataset.tone = 'warn';
    const warnColor = getComputedStyle(status).color;
    status.dataset.tone = '';
    status.textContent = '';
    return {
      urlColor: cs('#gev-home-video-url', 'color'),
      urlBg: cs('#gev-home-video-url', 'backgroundColor'),
      urlBorder: cs('#gev-home-video-url', 'borderTopColor'),
      urlDisplay: cs('#gev-home-video-url', 'display'),
      placeholderColor: ph(),
      sourceColor: cs('#gev-home-video-source', 'color'),
      hintColor: cs('#gev-home-video .gev-home-video-hint', 'color'),
      hintCodeColor: cs('#gev-home-video .gev-home-video-hint code', 'color'),
      nowColor: cs('#gev-home-video-now', 'color'),
      statusOk: okColor,
      statusWarn: warnColor,
      smlPressedColor: cs('#gev-home-video [data-home-video-size="sm"]', 'color'),
      panelBg: cs('#gev-home-video', 'backgroundColor'),
    };
  });
  console.log(JSON.stringify(report, null, 2));
  await page.screenshot({ path: '.gev-shot-player.png', clip: await page.evaluate(() => {
    const r = document.getElementById('gev-home-video').getBoundingClientRect();
    return { x: Math.max(0, r.x - 20), y: Math.max(0, r.y - 60), width: Math.min(700, r.width + 40), height: r.height + 80 };
  })});
  console.log('screenshot written');
} finally { await browser.close(); }
