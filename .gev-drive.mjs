/**
 * One-off evidence dump: #location-search in #location-bar inside #command-dock.
 * Deleted after the run — not repository content.
 */
import puppeteer from 'puppeteer';
import fs from 'node:fs';

const url = process.env.GEV_URL || 'http://127.0.0.1:4207/';
const chrome = process.env.CHROME_PATH
  || '/nix/store/5afrhwm7zqn1vb7p5z1mc2rkh2grsfgz-ungoogled-chromium-138.0.7204.100/bin/chromium';
const out = process.env.GEV_LAUNCH_LOG || '/tmp/grok-goal-e3aa377070e6/implementer/ui-launch.log';

function log(line) {
  fs.appendFileSync(out, `${line}\n`);
  process.stdout.write(`${line}\n`);
}

fs.writeFileSync(out, '');
log(`chrome=${chrome}`);
log(`url=${url}`);

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
  const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
  log(`http=${response?.status()}`);
  const dump = await page.evaluate(() => {
    const dock = document.getElementById('command-dock');
    const bar = document.getElementById('location-bar');
    const search = document.getElementById('location-search');
    const list = document.getElementById('location-suggestions');
    return {
      title: document.title,
      webglGate: Boolean(document.getElementById('webgl-compatibility')),
      commandDock: Boolean(dock),
      locationBar: Boolean(bar),
      locationSearch: Boolean(search),
      locationSuggestions: Boolean(list),
      searchInBar: Boolean(bar && search && bar.contains(search)),
      barInDock: Boolean(dock && bar && dock.contains(bar)),
      listInBar: Boolean(bar && list && bar.contains(list)),
    };
  });
  log(`dump=${JSON.stringify(dump)}`);
  if (!dump.commandDock || !dump.searchInBar || !dump.barInDock) {
    process.exitCode = 2;
  }
} catch (err) {
  log(`launcher-failure=${err?.message || err}`);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
}
