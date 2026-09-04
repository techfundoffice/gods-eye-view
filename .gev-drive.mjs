import puppeteer from 'puppeteer';
const browser = await puppeteer.launch({
  headless: 'new', executablePath: '/repl/tools/bin/chromium', protocolTimeout: 180000,
  args: ['--no-sandbox','--disable-setuid-sandbox','--use-gl=swiftshader',
    '--enable-unsafe-swiftshader','--disable-dev-shm-usage','--window-size=1600,1000'],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  await page.goto('http://localhost:4173/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('#gev-home-video-2', { timeout: 30000 });
  await new Promise((r) => setTimeout(r, 4000));
  await page.click('#gev-home-video-2 [data-home-video-size="md"]');
  await new Promise((r) => setTimeout(r, 1000));
  console.log(JSON.stringify(await page.evaluate(() => {
    const el = document.getElementById('gev-home-video-2');
    const cs = getComputedStyle(el);
    const root = getComputedStyle(document.documentElement);
    return {
      dataSize: el.dataset.size,
      matchesMd: el.matches('.gev-home-video[data-size="md"]'),
      className: el.className,
      computedWidth: cs.width,
      flexBasis: cs.flexBasis,
      flexShrink: cs.flexShrink,
      maxWidth: cs.maxWidth,
      varSm: root.getPropertyValue('--gev-home-video-sm').trim(),
      varMd: root.getPropertyValue('--gev-home-video-md').trim(),
      railWidth: getComputedStyle(document.querySelector('.gev-home-video-rail')).width,
      titleBarWidth: getComputedStyle(document.getElementById('title-bar')).width,
    };
  }), null, 2));
} finally { await browser.close(); }
