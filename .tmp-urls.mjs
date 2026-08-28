import puppeteer from 'puppeteer';
const CHROME = '/nix/store/0n9rl5l9syy808xi9bk4f6dhnfrvhkww-playwright-browsers-chromium/chromium-1080/chrome-linux/chrome';
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new', protocolTimeout: 300000,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage();
page.goto('http://localhost:5000/', { waitUntil: 'domcontentloaded', timeout: 120000 }).catch(() => {});
for (let i = 0; i < 30; i += 1) {
  await new Promise((r) => setTimeout(r, 2000));
  if (await page.evaluate(() => !!window.__godsEyeView).catch(() => false)) break;
}
const urls = await page.evaluate(() => [...new Set(
  performance.getEntriesByType('resource').map((e) => e.name)
    .filter((n) => /cesium/i.test(n) && /\.js(\?|$)/.test(n)),
)].map((u) => u.replace(/^https?:\/\/[^/]+/, ''))).catch((e) => 'failed: ' + e.message);
console.log(JSON.stringify(urls, null, 2));
process.exit(0);
