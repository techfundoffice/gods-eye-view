#!/usr/bin/env node
/**
 * qa-admin-console — the ADMIN console's contract, proved in the real app.
 *
 * The unit suite pins the auth math, the middleware routes, the MCP protocol,
 * and the agent stream parser against fakes. This harness answers what only a
 * running browser can: does the ADMIN label actually open the console, does a
 * wrong password actually stay locked, does a plugin build actually stream an
 * agent transcript into the chat, and do the MCP settings actually mint and
 * revoke a key on screen.
 *
 * The dev server it drives should be started with a throwaway `ADMIN_PASSWORD`
 * and with `ADMIN_AGENT_COMMAND` pointed at a stub agent, so a QA run never
 * spends a real Claude Code turn or edits the checkout.
 *
 * Usage:
 *   node scripts/qa-admin-console.mjs --url http://localhost:5199 --password '...'
 *   node scripts/qa-admin-console.mjs --url http://localhost:5199 --password '...' --teeth
 *
 * `--teeth` is the negative control: it never submits the password, so every
 * signed-in assertion below must go RED. A green --teeth run means the
 * assertions are not measuring what they claim to.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const args = process.argv.slice(2);
const getOpt = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const APP_URL = getOpt('--url', 'http://localhost:5199').replace(/\/$/, '');
const PASSWORD = getOpt('--password', process.env.ADMIN_PASSWORD || '');
const TEETH = args.includes('--teeth');
const HEADFUL = args.includes('--headful');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOT_DIR = path.join(ROOT, 'qa-shots', 'admin');

/**
 * Browsers to try, best first. Puppeteer's own Chrome-for-Testing download
 * needs system libraries a bare Nix/Replit container does not ship, so an
 * explicit `PUPPETEER_EXECUTABLE_PATH` (or `--chrome`) has to win outright.
 */
const CHROME_CANDIDATES = [
  getOpt('--chrome', ''),
  process.env.PUPPETEER_EXECUTABLE_PATH,
  (() => { try { return puppeteer.executablePath(); } catch { return null; } })(),
].filter(Boolean);

const results = [];
let currentSection = 'setup';
function record(name, ok, detail) {
  results.push({ name, ok, detail, section: currentSection });
  console.log(`  [${ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

/** Run one independent section; a throw fails that section, not the run. */
async function section(name, body) {
  currentSection = name;
  console.log(`\n  \x1b[2m── ${name} ──\x1b[0m`);
  try {
    await body();
  } catch (error) {
    record(`[${name}] section completed without throwing`, false, error.message);
  }
}

/** Poll `read` until it satisfies `predicate` or the budget runs out. */
async function waitUntil(page, read, predicate, { timeoutMs = 15000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await page.evaluate(read);
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for ${label}; last value ${JSON.stringify(last)?.slice(0, 200)}`);
}

/** Read the visible state of the console in one hop. */
const readConsole = () => {
  const el = (id) => document.getElementById(id);
  // `offsetParent` is null for a position:fixed element even when it is on
  // screen, so measure the painted box instead.
  const visible = (node) => {
    if (!node) return false;
    const style = getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
      return false;
    }
    const box = node.getBoundingClientRect();
    return box.width > 0 && box.height > 0;
  };
  const anyVisible = (nodes) => nodes.some((node) => visible(node));
  return {
    launcherText: el('admin-launch')?.textContent?.trim() || '',
    consoleOpen: Boolean(el('admin-console') && !el('admin-console').hidden),
    status: el('admin-status')?.textContent?.trim() || '',
    gateVisible: visible(el('admin-gate')),
    dashboardVisible: visible(el('admin-dashboard')),
    signOutVisible: visible(el('admin-signout')),
    pluginChromeVisible: visible(el('admin-dashboard'))
      || anyVisible([...document.querySelectorAll('#admin-menu [data-admin-view], [data-admin-pane]')]),
    message: el('admin-message')?.hidden === false ? el('admin-message').textContent.trim() : '',
    menu: [...document.querySelectorAll('#admin-menu [data-admin-view]')]
      .map((node) => node.querySelector('strong')?.textContent?.trim() || ''),
    activeView: document.querySelector('#admin-menu [data-admin-view].active')?.dataset.adminView || '',
    transcript: [...document.querySelectorAll('#admin-transcript .admin-chat-entry')].map((node) => ({
      role: node.querySelector('.admin-chat-role')?.textContent?.trim() || '',
      text: node.querySelector('.admin-chat-text')?.textContent?.trim() || '',
    })),
    chatHeading: el('admin-chat-heading')?.textContent?.trim() || '',
    builds: [...document.querySelectorAll('#admin-plugin-list .admin-plugin-row')].map((node) => ({
      name: node.querySelector('.admin-plugin-name')?.textContent?.trim() || '',
      state: node.querySelector('.admin-plugin-state')?.textContent?.trim() || '',
    })),
    mcpState: el('admin-mcp-state')?.textContent?.trim() || '',
    mcpToggle: el('admin-mcp-toggle')?.textContent?.trim() || '',
    mcpToggleEnabled: el('admin-mcp-toggle') ? !el('admin-mcp-toggle').disabled : false,
    mcpKeys: [...document.querySelectorAll('#admin-mcp-keys .admin-key-row')]
      .map((node) => node.querySelector('.admin-key-label')?.textContent?.trim() || ''),
    freshToken: el('admin-mcp-fresh')?.hidden === false ? el('admin-mcp-fresh').textContent.trim() : '',
    snippet: el('admin-mcp-snippet')?.textContent?.trim() || '',
  };
};

/**
 * Type into a field, replacing whatever is there.
 *
 * Clearing via focus + assignment rather than a triple-click: the console
 * re-renders on every state change, and a click handle taken before a re-render
 * can be stale by the time it is used.
 */
async function fill(page, selector, value) {
  await page.waitForSelector(selector, { timeout: 10000 });
  await page.evaluate((sel) => {
    const field = document.querySelector(sel);
    field.value = '';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.focus();
  }, selector);
  if (value) await page.type(selector, value);
}

async function main() {
  if (!PASSWORD) {
    console.error('qa-admin-console needs --password (or ADMIN_PASSWORD in the environment).');
    process.exitCode = 1;
    return;
  }
  fs.mkdirSync(SHOT_DIR, { recursive: true });

  let browser = null;
  let launchError = null;
  for (const executablePath of CHROME_CANDIDATES) {
    try {
      browser = await puppeteer.launch({
        headless: !HEADFUL,
        executablePath,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1440,900'],
        defaultViewport: { width: 1440, height: 900 },
      });
      console.log(`  browser: ${executablePath}`);
      break;
    } catch (error) {
      launchError = error;
    }
  }
  if (!browser) throw launchError || new Error('No usable browser found');
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error.message || error)));

  try {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('#admin-launch', { timeout: 30000 });

    await section('launcher', async () => {
      const state = await page.evaluate(readConsole);
      record('the ADMIN label is rendered', /ADMIN/.test(state.launcherText), state.launcherText);
      record('the console starts closed', state.consoleOpen === false);
      // The console must not depend on the globe: a browser that cannot run
      // Cesium still has to be able to sign in.
      record('the label survives a GPU-less page', await page.evaluate(() => {
        const box = document.getElementById('admin-launch')?.getBoundingClientRect();
        return Boolean(box && box.width > 0 && box.height > 0);
      }));
    });

    await section('gate', async () => {
      await page.click('#admin-launch');
      const state = await waitUntil(page, readConsole, (s) => s.consoleOpen, { label: 'the console to open' });
      record('clicking ADMIN opens the console', state.consoleOpen);
      record('the password gate is shown', state.gateVisible);
      record('the dashboard is withheld while locked', state.dashboardVisible === false);
      record('plugin menu and panes are not painted while locked', state.pluginChromeVisible === false);
      record('sign-out is withheld until unlock', state.signOutVisible === false);
      record('the status reads locked', /LOCKED/.test(state.status), state.status);
    });

    await section('wrong-password', async () => {
      await fill(page, '#admin-password', 'definitely-not-the-password');
      await page.click('#admin-login-form button[type="submit"]');
      const state = await waitUntil(page, readConsole,
        (s) => Boolean(s.message) && !/Verifying/.test(s.message),
        { label: 'a settled rejection message' });
      record('a wrong password is refused', /Incorrect admin password/i.test(state.message), state.message);
      record('the dashboard stays closed after a refusal', state.dashboardVisible === false);
      record('plugin chrome stays unpainted after a refusal', state.pluginChromeVisible === false);
    });

    await section('sign-in', async () => {
      await fill(page, '#admin-password', PASSWORD);
      if (!TEETH) await page.click('#admin-login-form button[type="submit"]');
      const state = await waitUntil(page, readConsole, (s) => s.dashboardVisible, {
        label: 'the dashboard to open',
        timeoutMs: TEETH ? 4000 : 15000,
      });
      record('a correct password opens the dashboard', state.dashboardVisible);
      record('plugin menu and panes paint after sign-in', state.pluginChromeVisible);
      record('sign-out is available after sign-in', state.signOutVisible);
      record('the status reads signed in', /SIGNED IN/.test(state.status), state.status);
      record('the menu offers Create New Admin Menu Plugin',
        state.menu.includes('Create New Admin Menu Plugin'), state.menu.join(' | '));
      record('the menu offers MCP Server', state.menu.includes('MCP Server'));
    });

    await section('session-cookie', async () => {
      const cookies = await page.cookies();
      const session = cookies.find((cookie) => cookie.name === 'gev_admin_session');
      record('a session cookie exists', Boolean(session));
      record('the session cookie is HttpOnly', Boolean(session?.httpOnly));
      record('the session cookie is SameSite=Strict', session?.sameSite === 'Strict', session?.sameSite);
      const visibleToJs = await page.evaluate(() => document.cookie.includes('gev_admin_session'));
      record('page JavaScript cannot read the session', visibleToJs === false);
    });

    await section('plugin-build', async () => {
      await fill(page, '#admin-plugin-name', 'QA Fleet Watchlist');
      await fill(page, '#admin-plugin-message', 'Track a saved list of vessels.');
      await page.click('#admin-plugin-submit');

      const state = await waitUntil(page, readConsole,
        (s) => s.transcript.some((entry) => entry.role === 'CLAUDE'),
        { label: 'an agent reply in the transcript', timeoutMs: 30000 });

      record('the operator turn is echoed into the chat',
        state.transcript.some((entry) => entry.role === 'ADMIN' && /Fleet Watchlist/.test(entry.text)));
      record('the agent transcript streams back',
        state.transcript.some((entry) => entry.role === 'CLAUDE' && entry.text.length > 0),
        state.transcript.filter((e) => e.role === 'CLAUDE')[0]?.text?.slice(0, 60));
      record('tool activity is surfaced',
        state.transcript.some((entry) => /TOOL/.test(entry.role)));

      const settled = await waitUntil(page, readConsole,
        (s) => s.builds.some((build) => build.state !== 'BUILDING'),
        { label: 'the build to settle', timeoutMs: 30000 });
      const build = settled.builds.find((entry) => /QA Fleet Watchlist/.test(entry.name));
      record('the build is listed under its name', Boolean(build), settled.builds.map((b) => b.name).join(' | '));
      record('the build reaches READY', build?.state === 'READY', build?.state);
      record('the chat heading names the build',
        /QA Fleet Watchlist/.test(settled.chatHeading), settled.chatHeading);
    });

    await section('follow-up', async () => {
      const before = (await page.evaluate(readConsole)).transcript.length;
      await fill(page, '#admin-plugin-message', 'Also add a CSV export.');
      await page.click('#admin-plugin-submit');
      const state = await waitUntil(page, readConsole,
        (s) => s.transcript.length > before
          && s.transcript.some((entry) => /CSV export/.test(entry.text)),
        { label: 'the follow-up turn', timeoutMs: 30000 });
      record('a follow-up message continues the same conversation',
        state.transcript.some((entry) => entry.role === 'ADMIN' && /CSV export/.test(entry.text)));
      record('the follow-up gets its own agent reply',
        state.transcript.filter((entry) => entry.role === 'CLAUDE').length >= 2);
    });

    await section('mcp-settings', async () => {
      await page.click('#admin-menu [data-admin-view="mcp-server"]');
      // Wait for the settings to actually land: the pane switches synchronously
      // and reads CHECKING until then, so asserting immediately would be
      // measuring the placeholder rather than the server.
      let state = await waitUntil(page, readConsole,
        (s) => s.activeView === 'mcp-server' && s.mcpState !== 'CHECKING',
        { label: 'the MCP pane to load its settings' });
      record('the MCP pane opens from the menu', state.activeView === 'mcp-server');
      record('the endpoint starts switched off', state.mcpState === 'OFF', state.mcpState);
      record('the toggle is live once the settings have loaded', state.mcpToggleEnabled === true);
      record('the snippet shows a placeholder before a key exists',
        /<YOUR_ADMIN_API_KEY>/.test(state.snippet));
      record('the snippet points at this origin',
        state.snippet.includes(`${APP_URL}/api/admin/mcp`), state.snippet.slice(0, 120));

      await page.click('#admin-mcp-toggle');
      state = await waitUntil(page, readConsole, (s) => s.mcpState === 'ONLINE',
        { label: 'MCP to come online' });
      record('the operator can bring the endpoint online', state.mcpState === 'ONLINE');
      record('the toggle offers to disable it again', /DISABLE/.test(state.mcpToggle), state.mcpToggle);

      await fill(page, '#admin-mcp-key-label', 'QA client');
      await page.click('#admin-mcp-key-form button[type="submit"]');
      state = await waitUntil(page, readConsole, (s) => s.mcpKeys.length === 1,
        { label: 'the new key to be listed' });
      record('a new key is listed under its label', /QA client/.test(state.mcpKeys[0]), state.mcpKeys[0]);
      record('the plaintext key is shown exactly once',
        /gev_admin_/.test(state.freshToken), state.freshToken.slice(0, 40));
      record('the snippet is filled in with that key',
        state.snippet.includes(state.freshToken.split(': ').pop()));
    });

    await section('mcp-key-works', async () => {
      const token = (await page.evaluate(readConsole)).freshToken.split(': ').pop();
      const rpc = await page.evaluate(async (url, key) => {
        const response = await fetch(`${url}/api/admin/mcp`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
        });
        return { status: response.status, body: await response.json() };
      }, APP_URL, token);
      record('the minted key authenticates a real MCP call', rpc.status === 200, String(rpc.status));
      record('the endpoint advertises the plugin tools',
        (rpc.body?.result?.tools || []).some((tool) => tool.name === 'create_admin_plugin'),
        (rpc.body?.result?.tools || []).map((tool) => tool.name).join(', '));
    });

    await section('revoke', async () => {
      await page.click('#admin-mcp-keys [data-revoke-key]');
      const state = await waitUntil(page, readConsole, (s) => s.mcpKeys.length === 0,
        { label: 'the key list to empty' });
      record('revoking removes the key from the list', state.mcpKeys.length === 0);
    });

    await page.screenshot({ path: path.join(SHOT_DIR, `admin-console${TEETH ? '-teeth' : ''}.png`) });

    await section('sign-out', async () => {
      await page.click('#admin-signout');
      const state = await waitUntil(page, readConsole, (s) => s.gateVisible,
        { label: 'the gate to return' });
      record('signing out returns the password gate', state.gateVisible);
      record('the dashboard is withheld again', state.dashboardVisible === false);
      record('plugin chrome is unpainted after sign-out', state.pluginChromeVisible === false);
      const stillAuthorized = await page.evaluate(async (url) => {
        const response = await fetch(`${url}/api/admin/plugins`, { credentials: 'same-origin' });
        return response.status;
      }, APP_URL);
      record('the server rejects the signed-out session', stillAuthorized === 401, String(stillAuthorized));
    });

    currentSection = 'page-health';
    const relevantErrors = pageErrors.filter((message) => /admin/i.test(message));
    record('no admin-related page errors', relevantErrors.length === 0, relevantErrors.join(' | '));
  } finally {
    await browser.close();
  }

  const failed = results.filter((entry) => !entry.ok);
  console.log(`\n  ${results.length - failed.length}/${results.length} checks passed`
    + `${TEETH ? ' (teeth run: failures are the expected outcome)' : ''}`);
  console.log(`  Screenshot: ${path.relative(ROOT, SHOT_DIR)}/`);

  if (TEETH) {
    // The control passes only when the signed-in assertions actually went red.
    const signedInFailures = failed.filter((entry) => entry.section !== 'launcher'
      && entry.section !== 'gate' && entry.section !== 'wrong-password');
    const ok = signedInFailures.length > 0;
    console.log(`  Teeth control: ${ok ? 'RED as required' : 'GREEN — assertions have no teeth'}`);
    process.exitCode = ok ? 0 : 1;
    return;
  }
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
