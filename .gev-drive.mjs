import puppeteer from 'puppeteer';
import { writeFileSync } from 'node:fs';

const url = process.env.GEV_URL || 'http://127.0.0.1:4207/';
const chrome = process.env.CHROME_PATH
  || '/nix/store/5afrhwm7zqn1vb7p5z1mc2rkh2grsfgz-ungoogled-chromium-138.0.7204.100/bin/chromium';
const out = process.env.GEV_LAUNCH_LOG || 'nextchat-launch.log';

const lines = [];
const log = (msg) => {
  lines.push(msg);
  console.log(msg);
};

let browser;
try {
  browser = await puppeteer.launch({
    headless: 'new',
    executablePath: chrome,
    protocolTimeout: 180000,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--use-gl=swiftshader',
      '--enable-unsafe-swiftshader',
      '--disable-dev-shm-usage',
      '--window-size=1440,900',
    ],
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(30000);
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  await page.setViewport({ width: 1440, height: 900 });
  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  log(`status: ${response?.status()}`);
  await page.waitForSelector('#cesiumContainer', { timeout: 15000 });
  await page.waitForSelector('#gev-nextchat-composer', { timeout: 15000 });
  const chromeIds = await page.evaluate(() => ({
    cesium: Boolean(document.getElementById('cesiumContainer')),
    composer: Boolean(document.getElementById('gev-nextchat-composer')),
    send: Boolean(document.getElementById('gev-nextchat-send')),
    sessions: Boolean(document.getElementById('gev-nextchat-sessions')),
    thread: Boolean(document.getElementById('gev-nextchat-thread')),
    newChat: Boolean(document.getElementById('gev-nextchat-new')),
    micMarkup: Boolean(document.getElementById('command-dock')),
    nextchatInit: Boolean(window.__gevNextchat),
    webgl: Boolean(window.__gevGpuCompatibility),
    webglReason: window.__gevGpuCompatibility?.reason || null,
  }));
  log(`chrome: ${JSON.stringify(chromeIds)}`);
  await page.type('#gev-nextchat-composer', 'zoom to the globe');
  await page.click('#gev-nextchat-send');
  await new Promise((resolve) => setTimeout(resolve, 800));
  const afterSend = await page.evaluate(() => {
    const thread = document.getElementById('gev-nextchat-thread');
    const status = document.getElementById('gev-nextchat-status');
    const roles = [...(thread?.querySelectorAll('[data-role]') || [])].map((el) => ({
      role: el.dataset.role,
      text: el.querySelector('.gev-nextchat-text')?.textContent || '',
    }));
    return {
      status: status?.textContent || '',
      roles,
      composer: document.getElementById('gev-nextchat-composer')?.value || '',
    };
  });
  log(`afterSend: ${JSON.stringify(afterSend)}`);
  const shot = process.env.GEV_SHOT || '';
  if (shot) {
    await page.screenshot({ path: shot, fullPage: true });
    log(`screenshot: ${shot}`);
  }
  if (pageErrors.length) log(`pageErrors: ${pageErrors.join(' | ')}`);
  const ok = chromeIds.cesium && chromeIds.composer && chromeIds.send
    && chromeIds.sessions && chromeIds.thread && chromeIds.newChat;
  log(ok ? 'LAUNCH_OK' : 'LAUNCH_FAIL missing chrome');
} catch (error) {
  log(`LAUNCH_FAIL ${error?.message || error}`);
} finally {
  if (browser) await browser.close();
  writeFileSync(out, `${lines.join('\n')}\n`);
}
