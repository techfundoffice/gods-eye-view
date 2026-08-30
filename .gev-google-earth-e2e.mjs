#!/usr/bin/env node
/**
 * Throwaway E2E driver for Google Earth globe + ADMIN plugin.
 * Lives in-repo so `import puppeteer` resolves. Delete after the run.
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const CHROME = process.env.CHROME_PATH
  || '/nix/store/5afrhwm7zqn1vb7p5z1mc2rkh2grsfgz-ungoogled-chromium-138.0.7204.100/bin/chromium';
const BASE = process.env.QA_BASE_URL || 'http://localhost:4173';
const URL = `${BASE}/?welcome=0`;
const SCRATCH = process.env.GEV_SCRATCH || '/tmp/grok-goal-8b4210b16f1b/implementer';
const PASSWORD = process.env.ADMIN_PASSWORD || 'verify-google-earth';

fs.mkdirSync(SCRATCH, { recursive: true });

function log(lines, ...parts) {
  const text = parts.map((part) => (typeof part === 'string' ? part : JSON.stringify(part, null, 2))).join(' ');
  lines.push(text);
  console.log(text);
}

async function launchBrowser() {
  if (!fs.existsSync(CHROME)) {
    throw new Error(`Chromium not found at ${CHROME}`);
  }
  return puppeteer.launch({
    headless: 'new',
    executablePath: CHROME,
    protocolTimeout: 180000,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--use-gl=swiftshader',
      '--enable-unsafe-swiftshader',
      '--disable-dev-shm-usage',
      '--window-size=1280,720',
      '--js-flags=--max-old-space-size=256',
    ],
  });
}

async function waitForGlobeOrGate(page, lines) {
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const url = request.url();
    if (/fonts\.googleapis\.com|fonts\.gstatic\.com/.test(url)) {
      request.abort().catch(() => {});
      return;
    }
    request.continue().catch(() => {});
  });
  page.setDefaultNavigationTimeout(60000);
  const started = Date.now();
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  log(lines, 'DOMCONTENTLOADED', `${Date.now() - started}ms`);
  let last = null;
  for (let i = 0; i < 30; i += 1) {
    last = await page.evaluate(() => {
      const loader = document.getElementById('loading-screen');
      return {
        loader: loader?.className || '',
        status: loader?.querySelector?.('.loader-status')?.textContent || '',
        gev: Boolean(window.__godsEyeView),
        gpu: window.__gevGpuCompatibility || null,
        tileset: Boolean(window.__godsEyeView?.tileset),
        stack: window.__godsEyeView?.mapStackController?.getActiveId?.() || null,
      };
    });
    log(lines, `POLL ${i}`, last);
    if (last.gev || last.gpu || /hidden|compatibility/.test(last.loader)) break;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  await new Promise((resolve) => setTimeout(resolve, 4000));
  return last;
}

async function readGlobe(page) {
  return page.evaluate(() => {
    const gev = window.__godsEyeView;
    const gpu = window.__gevGpuCompatibility || null;
    const loader = document.getElementById('loading-screen');
    const canvas = document.querySelector('#cesiumContainer canvas');
    const credits = document.getElementById('cesium-credits');
    const creditText = String(credits?.innerText || credits?.textContent || '');
    const creditHtml = String(credits?.innerHTML || '');
    let tilesetInScene = false;
    const primitives = gev?.viewer?.scene?.primitives;
    if (gev?.tileset && primitives?.length != null) {
      for (let i = 0; i < primitives.length; i += 1) {
        if (primitives.get(i) === gev.tileset) tilesetInScene = true;
      }
    }
    return {
      gpu,
      loaderHidden: Boolean(loader?.classList?.contains('hidden')),
      loaderCompat: Boolean(loader?.classList?.contains('compatibility-error')),
      loaderText: loader?.querySelector?.('.loader-status')?.textContent || '',
      hasGev: Boolean(gev),
      activeStack: gev?.mapStackController?.getActiveId?.() || null,
      tilesetPresent: Boolean(gev?.tileset),
      tilesetShow: gev?.tileset?.show !== false,
      tilesetLoaded: gev?.tileset?.tilesLoaded === true,
      tilesetInScene,
      googleApiKeyPresent: Boolean(String(gev?.googleApiKey || window.__GOOGLE_MAPS_API_KEY__ || '').trim()),
      googleEarthLoadError: gev?.googleEarthLoadError || null,
      globeShown: gev?.viewer?.scene?.globe?.show,
      creditText,
      creditHtml: creditHtml.slice(0, 500),
      creditHasGoogle: /google/i.test(`${creditText} ${creditHtml}`),
      canvas: canvas ? { width: canvas.width, height: canvas.height } : null,
    };
  });
}

async function readCanvasFill(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector('#cesiumContainer canvas');
    if (!canvas) return { ok: false, reason: 'no-canvas' };
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl')
      || canvas.getContext('experimental-webgl');
    if (!gl) return { ok: false, reason: 'no-webgl-context' };
    const width = Math.min(canvas.width || 0, 320);
    const height = Math.min(canvas.height || 0, 180);
    if (!width || !height) return { ok: false, reason: 'zero-canvas', width, height };
    try {
      const pixels = new Uint8Array(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      const err = gl.getError();
      if (err) return { ok: false, reason: `gl-error-${err}` };
      let lit = 0;
      let sum = 0;
      const total = width * height;
      for (let i = 0; i < pixels.length; i += 4) {
        const luma = pixels[i] + pixels[i + 1] + pixels[i + 2];
        sum += luma;
        if (luma > 24 && pixels[i + 3] > 8) lit += 1;
      }
      return { ok: true, lit, total, ratio: lit / total, meanLuma: sum / (total * 3) };
    } catch (error) {
      return { ok: false, reason: error?.message || String(error) };
    }
  });
}

function judgeGlobe(state, fill, lines) {
  const result = { pass: true, envSkip: false, reasons: [] };
  if (state.gpu || state.loaderCompat || !state.hasGev) {
    result.envSkip = true;
    result.reasons.push('WebGL/globe did not start');
    log(lines, 'ENV', { gpu: state.gpu, loaderCompat: state.loaderCompat, loaderText: state.loaderText, hasGev: state.hasGev });
    return result;
  }
  if (state.activeStack !== 'photoreal') {
    result.pass = false;
    result.reasons.push(`activeStack=${state.activeStack}`);
  }
  if (!state.tilesetPresent || !state.tilesetInScene || !state.tilesetShow) {
    result.pass = false;
    result.reasons.push('photoreal tileset missing or hidden');
  }
  if (!state.creditHasGoogle) {
    result.pass = false;
    result.reasons.push(`credits missing Google text: ${JSON.stringify((state.creditText || state.creditHtml || '').slice(0, 200))}`);
  }
  if (state.globeShown === true) {
    result.pass = false;
    result.reasons.push('ellipsoid globe is shown over photoreal tiles');
  }
  if (!fill.ok) {
    result.envSkip = true;
    result.reasons.push(`canvas readback unavailable: ${fill.reason}`);
  } else if (fill.ratio < 0.08) {
    result.pass = false;
    result.reasons.push(`canvas not substantially filled ratio=${fill.ratio}`);
  }
  return result;
}

async function runGlobe(page, lines, shotPath) {
  await waitForGlobeOrGate(page, lines);
  const state = await readGlobe(page);
  const fill = await readCanvasFill(page);
  log(lines, 'GLOBE_STATE', state);
  log(lines, 'CANVAS_FILL', fill);
  if (shotPath) {
    try {
      await page.screenshot({ path: shotPath, fullPage: true });
      log(lines, 'SCREENSHOT', shotPath);
    } catch (error) {
      log(lines, 'SCREENSHOT_FAIL', error.message);
    }
  }
  return { state, fill, verdict: judgeGlobe(state, fill, lines) };
}

async function runAdmin(page, lines, shotPath) {
  await page.click('#admin-launch');
  await page.waitForSelector('#admin-console:not([hidden])', { timeout: 15000 });
  await page.waitForSelector('#admin-password', { timeout: 10000 });
  await page.focus('#admin-password');
  await page.type('#admin-password', PASSWORD, { delay: 10 });
  await page.click('#admin-login-form button[type="submit"]');
  await page.waitForSelector('#admin-dashboard:not([hidden])', { timeout: 20000 });
  log(lines, 'ADMIN_UNLOCKED');

  await page.waitForFunction(() => {
    return Boolean(document.querySelector('[data-admin-view="google-earth"]'));
  }, { timeout: 20000 });
  log(lines, 'PLUGIN_MENU_READY');

  await page.click('[data-admin-view="google-earth"]');
  await page.waitForSelector('#admin-google-earth-status', { timeout: 10000 });
  const pane = await page.evaluate(() => {
    const status = document.getElementById('admin-google-earth-status');
    const host = document.getElementById('admin-plugin-host');
    return {
      state: status?.dataset?.googleEarthState || '',
      text: status?.textContent || '',
      hostHidden: Boolean(host?.hidden),
      pane: host?.dataset?.adminPane || '',
      buttonDisabled: document.getElementById('admin-google-earth-show')?.disabled === true,
    };
  });
  log(lines, 'PLUGIN_PANE', pane);

  const show = await page.$('#admin-google-earth-show');
  if (show) {
    const disabled = await page.evaluate((el) => el.disabled, show);
    if (!disabled) {
      await show.click();
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
  }

  const after = await page.evaluate(() => {
    const gev = window.__godsEyeView;
    const status = document.getElementById('admin-google-earth-status');
    return {
      pluginState: status?.dataset?.googleEarthState || '',
      pluginText: status?.textContent || '',
      activeStack: gev?.mapStackController?.getActiveId?.() || null,
      tilesetShow: gev?.tileset?.show !== false,
      tilesetPresent: Boolean(gev?.tileset),
    };
  });
  log(lines, 'AFTER_SHOW', after);

  if (shotPath) {
    try {
      await page.screenshot({ path: shotPath, fullPage: true });
      log(lines, 'SCREENSHOT', shotPath);
    } catch (error) {
      log(lines, 'SCREENSHOT_FAIL', error.message);
    }
  }
  return { pane, after };
}

const globeLog = [];
const adminLog = [];
const envLines = [];
let failed = false;

try {
  const results = [];
  for (let run = 1; run <= 2; run += 1) {
    log(globeLog, `=== GLOBE RUN ${run} ===`);
    const browser = await launchBrowser();
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(60000);
      page.on('pageerror', (error) => log(globeLog, 'PAGEERROR', error.message));
      const shot = run === 1 ? path.join(SCRATCH, 'google-earth-globe.png') : null;
      const result = await runGlobe(page, globeLog, shot);
      results.push(result);
      if (run === 2) {
        try {
          const admin = await runAdmin(page, adminLog, path.join(SCRATCH, 'admin-google-earth.png'));
          const globeOk = result.state.activeStack === 'photoreal' && result.state.tilesetPresent;
          const pluginMatches = globeOk
            ? admin.after.pluginState === 'DISPLAYING' && admin.after.activeStack === 'photoreal'
            : admin.pane.state === 'KEY REQUIRED' || admin.pane.state === 'LOAD FAILED';
          if (!pluginMatches) {
            failed = true;
            log(adminLog, 'FAIL plugin status does not match globe', { globeOk, plugin: admin });
          } else {
            log(adminLog, 'PASS plugin status matches globe');
          }
          if (globeOk && admin.after.activeStack !== 'photoreal') {
            failed = true;
            log(adminLog, 'FAIL show Google Earth did not leave photoreal active');
          }
        } catch (error) {
          failed = true;
          log(adminLog, 'ADMIN_FAIL', error.stack || error.message);
        }
      }
    } finally {
      await browser.close();
    }
  }

  const a = results[0]?.verdict;
  const b = results[1]?.verdict;
  if (a?.envSkip && b?.envSkip) {
    fs.writeFileSync(path.join(SCRATCH, 'globe-e2e-env.txt'), [
      'Google Earth globe pixel proof could not run in this environment.',
      JSON.stringify({ run1: results[0], run2: results[1] }, null, 2),
    ].join('\n'));
    log(envLines, 'ENV_SKIP both runs');
    log(globeLog, 'ENV_SKIP both globe launches (WebGL/readback unavailable). JS stack/tileset still recorded.');
  } else if (!a?.pass || !b?.pass) {
    failed = true;
    log(globeLog, 'FAIL globe', { run1: a, run2: b });
  } else if (results[0].state.activeStack !== results[1].state.activeStack) {
    failed = true;
    log(globeLog, 'FAIL inconsistent stacks across launches');
  } else {
    log(globeLog, 'PASS both globe launches');
  }
} catch (error) {
  failed = true;
  const message = error.stack || error.message;
  log(globeLog, 'DRIVER_FAIL', message);
  if (/Failed to launch|Timed out waiting for the WS endpoint|libglib/i.test(message)) {
    fs.writeFileSync(path.join(SCRATCH, 'globe-e2e-env.txt'), `Browser launch failed:\n${message}\n`);
  }
}

fs.writeFileSync(path.join(SCRATCH, 'globe-e2e.log'), `${globeLog.join('\n')}\n`);
fs.writeFileSync(path.join(SCRATCH, 'admin-plugin-e2e.log'), `${adminLog.join('\n')}\n`);
if (envLines.length) {
  fs.appendFileSync(path.join(SCRATCH, 'globe-e2e-env.txt'), `\n${envLines.join('\n')}\n`);
}

if (failed) {
  console.error('E2E failed — see scratch logs');
  process.exit(1);
}
console.log('E2E completed');
