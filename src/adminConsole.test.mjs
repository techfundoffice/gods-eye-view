import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ADMIN_MENU_ITEMS,
  ADMIN_NAV_COMPACT_CLASS,
  ADMIN_NAV_COMPACT_MAX_WIDTH,
  ADMIN_NAV_DRAWER_OPEN_CLASS,
  ADMIN_REQUEST_HEADER,
  ADMIN_UNLOCKED_CLASS,
  AdminConsoleController,
  adminEscapeAction,
  adminMcpClientSnippet,
  applyAdminLockPaint,
  applyAdminNavLayout,
  createAdminClient,
  composioStatusLabel,
  composioStatusMessage,
  describeSessionState,
  hasRunningBuild,
  initAdminConsole,
  isAdminUnlocked,
  nextAdminNavItem,
  pluginNavStatus,
  pluginNavStatusMessage,
  pluginStatusLabel,
  transcriptRoleLabel,
} from './adminConsole.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
const consoleSource = fs.readFileSync(path.join(ROOT, 'src', 'adminConsole.js'), 'utf8');

/** Record every call and answer with a scripted response. */
function fakeFetch(responses = []) {
  const calls = [];
  const queue = [...responses];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const next = queue.shift() || { ok: true, status: 200, body: {} };
    return {
      ok: next.ok !== false,
      status: next.status || (next.ok === false ? 400 : 200),
      json: async () => {
        if (next.invalidJson) throw new Error('not json');
        return next.body ?? {};
      },
    };
  };
  return { fetchImpl, calls };
}

test('the dashboard menu includes the gated Composio control plane', () => {
  assert.deepEqual(
    ADMIN_MENU_ITEMS.map((item) => item.id),
    ['create-plugin', 'mcp-server', 'live-stream', 'openrouter', 'gev-api'],
  );
  assert.deepEqual(
    ADMIN_MENU_ITEMS.map((item) => item.label),
    ['Create Plugin', 'MCP Server', 'Go Live', 'OpenRouter', 'GEV API'],
  );
  for (const item of ADMIN_MENU_ITEMS) {
    assert.ok(item.id && item.description, `${item.label} has an id and a description`);
  }

  const dashboard = html.match(/<div id="admin-dashboard"[\s\S]*?<div id="admin-plugin-host"/);
  assert.ok(dashboard, 'the dashboard markup is missing from index.html');
  assert.match(dashboard[0], /data-admin-view="gev-api"/);
  assert.match(dashboard[0], /data-admin-pane="gev-api"/);
  assert.match(dashboard[0], /id="admin-gev-api-status"/);
  assert.match(dashboard[0], /id="admin-gev-api-list"/);
  assert.match(dashboard[0], /id="admin-gev-api-curl"/);
  assert.match(dashboard[0], /id="admin-gev-api-mcp"/);
  assert.match(dashboard[0], /data-admin-view="openrouter"/);
  assert.match(dashboard[0], /data-admin-view="create-plugin"/);
  assert.match(dashboard[0], /data-admin-view="mcp-server"/);
  assert.match(dashboard[0], /data-admin-view="live-stream"/);
  assert.match(dashboard[0], /data-admin-nav-group="core"/);
  assert.match(dashboard[0], /data-admin-nav-group="plugins"/);
  assert.match(dashboard[0], /id="admin-nav"/);
  assert.match(dashboard[0], /id="admin-workspace"/);
  assert.match(dashboard[0], /<strong>Create Plugin<\/strong>/);
  assert.match(dashboard[0], /<strong>Go Live<\/strong>/);

  assert.match(dashboard[0], /APPROVED SITE CAPABILITY/);
});

test('build status and transcript roles get operator-readable labels', () => {
  assert.equal(pluginStatusLabel('running'), 'BUILDING');
  assert.equal(pluginStatusLabel('ready'), 'READY');
  assert.equal(pluginStatusLabel('failed'), 'FAILED');
  assert.equal(pluginStatusLabel('something-else'), 'UNKNOWN');

  assert.equal(transcriptRoleLabel('admin'), 'ADMIN');
  assert.equal(transcriptRoleLabel('agent'), 'CLAUDE');
  assert.equal(transcriptRoleLabel('tool'), 'AGENT · TOOL');
  assert.equal(transcriptRoleLabel('anything'), 'SYSTEM');
});

test('the status line distinguishes unconfigured, locked, and signed in', () => {
  assert.match(describeSessionState({ configured: false }), /NOT CONFIGURED/);
  assert.match(describeSessionState({ configured: true, authenticated: false }), /LOCKED/);
  assert.equal(describeSessionState({ configured: true, authenticated: true }), 'SIGNED IN');
  assert.equal(
    describeSessionState({ configured: true, authenticated: true, mcpEnabled: true }),
    'SIGNED IN · MCP ONLINE',
  );
});

test('Composio UI states distinguish loading, setup, disconnect, allowlist, and errors', () => {
  assert.equal(composioStatusLabel('connected', false), 'CHECKING');
  assert.equal(composioStatusLabel('unconfigured'), 'NOT CONFIGURED');
  assert.equal(composioStatusLabel('disconnected'), 'DISCONNECTED');
  assert.equal(composioStatusLabel('no-capabilities'), 'NO APPROVED TOOLS');
  assert.equal(composioStatusLabel('connection-error'), 'CONNECTION ERROR');
  assert.equal(composioStatusLabel('connected'), 'CONNECTED');
  assert.match(composioStatusMessage({ configured: false }), /COMPOSIO_API_KEY/);
  assert.match(composioStatusMessage({ configured: true, state: 'disconnected' }), /Connect an app/);
  assert.match(composioStatusMessage({ configured: true, state: 'no-capabilities' }), /COMPOSIO_ALLOWED_TOOLS/);
  assert.equal(composioStatusMessage({ configured: true, error: 'Safe failure' }), 'Safe failure');
});

test('a running build anywhere in the list keeps the console polling', () => {
  assert.equal(hasRunningBuild([{ status: 'ready' }, { status: 'running' }]), true);
  assert.equal(hasRunningBuild([{ status: 'ready' }, { status: 'failed' }]), false);
  assert.equal(hasRunningBuild([]), false);
  assert.equal(hasRunningBuild(undefined), false);
});

test('the MCP snippet is valid client config with an absolute URL', () => {
  const snippet = adminMcpClientSnippet({ origin: 'https://example.repl.co/', token: 'gev_admin_abc' });
  const parsed = JSON.parse(snippet);
  const server = parsed.mcpServers['gods-eye-view-admin'];
  assert.equal(server.url, 'https://example.repl.co/api/admin/mcp');
  assert.equal(server.headers.Authorization, 'Bearer gev_admin_abc');
  assert.equal(server.type, 'http');
});

test('with no key on screen the snippet shows a placeholder, never a real token', () => {
  const parsed = JSON.parse(adminMcpClientSnippet({ origin: 'http://localhost:5000' }));
  assert.match(parsed.mcpServers['gods-eye-view-admin'].headers.Authorization, /<YOUR_ADMIN_API_KEY>/);
});

test('the client requires a fetch implementation', () => {
  assert.throws(() => createAdminClient({ fetchImpl: null }), /requires fetch/);
});

test('reads are plain same-origin GETs without the write header', async () => {
  const { fetchImpl, calls } = fakeFetch([{ body: { configured: true } }]);
  const client = createAdminClient({ fetchImpl });
  assert.deepEqual(await client.session(), { configured: true });

  assert.equal(calls[0].url, '/api/admin/session');
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.credentials, 'same-origin');
  assert.equal(calls[0].options.headers[ADMIN_REQUEST_HEADER], undefined);
});

test('native login URL preserves the safe ADMIN return location', () => {
  const { fetchImpl, calls } = fakeFetch([]);
  const client = createAdminClient({ fetchImpl });
  assert.equal(client.loginUrl('/?admin=1'), '/api/admin/login?returnTo=%2F%3Fadmin%3D1');
  assert.equal(calls.length, 0, 'login is a browser redirect, not a credential-bearing fetch');
});

test('a typed password is posted to /login with the write header', async () => {
  const { fetchImpl, calls } = fakeFetch([{ body: { authenticated: true } }]);
  const client = createAdminClient({ fetchImpl });
  assert.deepEqual(await client.login('secret'), { authenticated: true });
  assert.equal(calls[0].url, '/api/admin/login');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers[ADMIN_REQUEST_HEADER], '1');
  assert.equal(JSON.parse(calls[0].options.body).password, 'secret');
});

test('a bodyless POST still carries the header but no content type', async () => {
  const { fetchImpl, calls } = fakeFetch([{ body: {} }]);
  await createAdminClient({ fetchImpl }).logout();
  assert.equal(calls[0].options.headers[ADMIN_REQUEST_HEADER], '1');
  assert.equal(calls[0].options.headers['Content-Type'], undefined);
  assert.equal(calls[0].options.body, undefined);
});

test('every route the console needs is addressed and escaped', async () => {
  const { fetchImpl, calls } = fakeFetch(new Array(12).fill({ body: {} }));
  const client = createAdminClient({ fetchImpl });
  await client.listPlugins();
  await client.createPlugin('Watchlist', 'track ships');
  await client.getPlugin('job/1');
  await client.sendPluginMessage('job/1', 'more');
  await client.mcpSettings();
  await client.setMcpEnabled(true);
  await client.createMcpKey('Laptop');
  await client.revokeMcpKey('key 1');
  await client.composioStatus();
  await client.validateComposio('composio:GITHUB_GET_ME', {});
  await client.runComposioAction('composio:GITHUB_GET_ME', {}, 'account/1');

  assert.deepEqual(calls.map((entry) => `${entry.options.method} ${entry.url}`), [
    'GET /api/admin/plugins',
    'POST /api/admin/plugins',
    'GET /api/admin/plugins/job%2F1',
    'POST /api/admin/plugins/job%2F1/messages',
    'GET /api/admin/mcp/settings',
    'POST /api/admin/mcp/settings',
    'POST /api/admin/mcp/keys',
    'DELETE /api/admin/mcp/keys/key%201',
    'GET /api/admin/composio/status',
    'POST /api/admin/composio/validate',
    'POST /api/admin/composio/actions/run',
  ]);
  assert.deepEqual(JSON.parse(calls[9].options.body), {
    capabilityId: 'composio:GITHUB_GET_ME',
    arguments: {},
  });
  assert.equal(calls[9].options.headers[ADMIN_REQUEST_HEADER], '1');
});

test('a server error surfaces its message, kind, and status', async () => {
  const { fetchImpl } = fakeFetch([{
    ok: false,
    status: 401,
    body: { error: { kind: 'auth', message: 'Admin sign-in required' } },
  }]);
  await assert.rejects(
    () => createAdminClient({ fetchImpl }).listPlugins(),
    (error) => {
      assert.equal(error.message, 'Admin sign-in required');
      assert.equal(error.kind, 'auth');
      assert.equal(error.status, 401);
      return true;
    },
  );
});

test('a failure with an unreadable body still rejects with a usable message', async () => {
  const { fetchImpl } = fakeFetch([{ ok: false, status: 500, invalidJson: true }]);
  await assert.rejects(() => createAdminClient({ fetchImpl }).session(), /Admin request failed/);
});

test('the MCP toggle is not derivable from client state until settings load', async () => {
  // Reproduces the race the browser harness caught: opening the pane starts
  // `GET /mcp/settings` without awaiting it, so a toggle computed from the
  // placeholder `enabled: false` could tell an already-online endpoint to go
  // online — or, with the placeholder stale in the other direction, switch off
  // an endpoint the screen still labelled ONLINE.
  const { fetchImpl, calls } = fakeFetch([
    { body: { enabled: true, endpoint: '/api/admin/mcp', keys: [] } },
  ]);
  const client = createAdminClient({ fetchImpl });

  const placeholder = { enabled: false, endpoint: '/api/admin/mcp', keys: [] };
  const loaded = await client.mcpSettings();
  assert.notEqual(loaded.enabled, placeholder.enabled,
    'the server disagrees with the placeholder, which is what makes the race visible');

  // Deriving from the loaded value asks for the correct transition.
  await client.setMcpEnabled(!loaded.enabled);
  assert.deepEqual(JSON.parse(calls[1].options.body), { enabled: false });
});

test('only a signed-in session on a configured server counts as unlocked', () => {
  assert.equal(isAdminUnlocked({ configured: true, authenticated: true }), true);
  assert.equal(isAdminUnlocked({ configured: true, authenticated: false }), false);
  // An unconfigured server refuses every admin route, so a dashboard painted
  // there would offer controls that cannot work.
  assert.equal(isAdminUnlocked({ configured: false, authenticated: true }), false);
  assert.equal(isAdminUnlocked({}), false);
  assert.equal(isAdminUnlocked(null), false);
});

test('the admin dashboard ships hidden and stays hidden until the password lands', () => {
  const dashboard = html.match(/<div id="admin-dashboard"[^>]*>/);
  assert.ok(dashboard, 'the dashboard is missing from index.html');
  assert.match(dashboard[0], /\bhidden\b/, 'the dashboard must be hidden before any session check');

  const signout = html.match(/<button id="admin-signout"[^>]*>/);
  assert.ok(signout, 'sign-out is missing from index.html');
  assert.match(signout[0], /\bhidden\b/, 'sign-out must not ship painted on the login page');

  const createPane = html.match(/<div class="admin-pane" data-admin-pane="create-plugin"[^>]*>/);
  assert.ok(createPane, 'the create-plugin pane is missing from index.html');
  assert.match(createPane[0], /\bhidden\b/, 'the plugin builder pane must ship hidden');

  // `_render` must call the same helper the tests drive — not a parallel copy.
  assert.match(consoleSource, /applyAdminLockPaint\(this\.root, session/);
  assert.match(consoleSource, /if \(!unlocked\) \{[\s\S]*?this\._clearGeneratedMenu\(\);[\s\S]*?return;/);
});

/**
 * Mini overlay with the real element ids `applyAdminLockPaint` walks.
 * Not a browser: just hidden / classList / querySelector so the shipped
 * helper is the thing under test.
 */
function makeAdminOverlay() {
  const classList = (initial) => {
    const set = new Set(initial);
    return {
      add: (name) => set.add(name),
      remove: (name) => set.delete(name),
      contains: (name) => set.has(name),
      toggle(name, force) {
        const on = force === undefined ? !set.has(name) : Boolean(force);
        if (on) set.add(name);
        else set.delete(name);
        return on;
      },
    };
  };
  const makeNode = (id, { hidden = false, classes = [], dataset = {} } = {}) => {
    const node = {
      id,
      hidden,
      dataset,
      classList: classList(classes),
      children: [],
      querySelector(selector) {
        if (selector.startsWith('#')) {
          const want = selector.slice(1);
          const walk = (current) => {
            if (current.id === want) return current;
            for (const child of current.children) {
              const hit = walk(child);
              if (hit) return hit;
            }
            return null;
          };
          return walk(node);
        }
        return null;
      },
      querySelectorAll(selector) {
        const found = [];
        const walk = (current) => {
          if (selector === '[data-admin-pane]' && current.dataset?.adminPane) found.push(current);
          for (const child of current.children) walk(child);
        };
        walk(node);
        return found;
      },
    };
    return node;
  };
  const root = makeNode('admin-console', { hidden: true, classes: ['admin-console'] });
  const gate = makeNode('admin-gate');
  const signout = makeNode('admin-signout', { hidden: true });
  const toggle = makeNode('admin-nav-toggle', { hidden: true });
  const scrim = makeNode('admin-nav-drawer-scrim', { hidden: true });
  const nav = makeNode('admin-nav', { hidden: false });
  const dashboard = makeNode('admin-dashboard', { hidden: true, classes: ['admin-dashboard'] });
  const workspace = makeNode('admin-workspace');
  const createPane = makeNode('', { hidden: true, dataset: { adminPane: 'create-plugin' } });
  const mcpPane = makeNode('', { hidden: true, dataset: { adminPane: 'mcp-server' } });
  const livePane = makeNode('', { hidden: true, dataset: { adminPane: 'live-stream' } });
  const composioPane = makeNode('', { hidden: true, dataset: { adminPane: 'composio' } });
  root.children.push(gate, signout, toggle, dashboard);
  dashboard.children.push(scrim, nav, workspace);
  workspace.children.push(createPane, mcpPane, composioPane, livePane);
  return {
    root, gate, signout, toggle, scrim, nav, dashboard, workspace,
    createPane, mcpPane, composioPane, livePane,
  };
}

test('applyAdminLockPaint withholds dashboard, panes, and sign-out while locked', () => {
  const overlay = makeAdminOverlay();
  overlay.dashboard.hidden = false;
  overlay.createPane.hidden = false;
  overlay.signout.hidden = false;
  overlay.root.classList.add(ADMIN_UNLOCKED_CLASS);

  const paint = applyAdminLockPaint(overlay.root, { configured: true, authenticated: false }, {
    view: 'create-plugin',
  });

  assert.equal(paint.unlocked, false);
  assert.equal(paint.showGate, true);
  assert.equal(paint.showDashboard, false);
  assert.equal(overlay.gate.hidden, false);
  assert.equal(overlay.dashboard.hidden, true);
  assert.equal(overlay.signout.hidden, true);
  assert.equal(overlay.toggle.hidden, true);
  assert.equal(overlay.scrim.hidden, true);
  assert.equal(overlay.createPane.hidden, true);
  assert.equal(overlay.mcpPane.hidden, true);
  assert.equal(overlay.composioPane.hidden, true);
  assert.equal(overlay.livePane.hidden, true);
  assert.equal(overlay.root.classList.contains(ADMIN_UNLOCKED_CLASS), false);
});

test('applyAdminLockPaint reveals the dashboard only after a signed-in session', () => {
  const overlay = makeAdminOverlay();

  const paint = applyAdminLockPaint(overlay.root, { configured: true, authenticated: true }, {
    view: 'mcp-server',
  });

  assert.equal(paint.unlocked, true);
  assert.equal(paint.showGate, false);
  assert.equal(paint.showDashboard, true);
  assert.equal(overlay.gate.hidden, true);
  assert.equal(overlay.dashboard.hidden, false);
  assert.equal(overlay.signout.hidden, false);
  assert.equal(overlay.toggle.hidden, false);
  assert.equal(overlay.createPane.hidden, true);
  assert.equal(overlay.mcpPane.hidden, false);
  assert.equal(overlay.composioPane.hidden, true);
  assert.equal(overlay.livePane.hidden, true);
  assert.equal(overlay.root.classList.contains(ADMIN_UNLOCKED_CLASS), true);
});

test('an unconfigured session stays on the login gate, never the plugin dashboard', () => {
  const overlay = makeAdminOverlay();
  const paint = applyAdminLockPaint(overlay.root, { configured: false, authenticated: true }, {
    view: 'create-plugin',
  });
  assert.equal(paint.unlocked, false);
  assert.equal(overlay.dashboard.hidden, true);
  assert.equal(overlay.createPane.hidden, true);
  assert.equal(overlay.root.classList.contains(ADMIN_UNLOCKED_CLASS), false);
});

test('`hidden` outranks every display an admin class sets', () => {
  // The regression this pins: `.admin-dashboard { display: flex }` is a class
  // selector and the UA's `[hidden] { display: none }` is not, so without an
  // admin-scoped `[hidden]` rule the dashboard painted in full for a visitor
  // who never typed the password — plugin builder, MCP keys, and the Go Live
  // pane whose YouTube provisioning rides on the operator's own sign-in.
  assert.match(css, /\.admin-console \[hidden\] \{ display: none !important; \}/);
  assert.match(css, /\.admin-dashboard \{[\s\S]*?display: flex;/,
    'the dashboard still sets a display, which is what makes the rule necessary');
});

test('locked CSS hides operator chrome without relying on the hidden attribute', () => {
  assert.match(css, /\.admin-console:not\(\.admin-unlocked\) #admin-dashboard/);
  assert.match(css, /\.admin-console:not\(\.admin-unlocked\) #admin-menu/);
  assert.match(css, /\.admin-console:not\(\.admin-unlocked\) #admin-nav\b/);
  assert.match(css, /\.admin-console:not\(\.admin-unlocked\) #admin-nav-toggle/);
  assert.match(css, /\.admin-console:not\(\.admin-unlocked\) #admin-nav-drawer-scrim/);
  assert.match(css, /\.admin-console:not\(\.admin-unlocked\) #admin-workspace/);
  assert.match(css, /\.admin-console:not\(\.admin-unlocked\) \[data-admin-nav-group\]/);
  assert.match(css, /\.admin-console:not\(\.admin-unlocked\) #admin-signout/);
  assert.match(css, /\.admin-console:not\(\.admin-unlocked\) \[data-admin-pane\]/);
  assert.match(css, /\.admin-console\.admin-unlocked #admin-gate/);
  assert.match(css, /display: none !important;/);
  assert.match(css, new RegExp(`${ADMIN_NAV_COMPACT_CLASS}`));
  assert.match(css, new RegExp(`${ADMIN_NAV_DRAWER_OPEN_CLASS}`));
});

test('plugin and menu payloads are not fetched while locked', () => {
  assert.match(
    consoleSource,
    /async _loadPlugins\(\) \{\n {4}if \(!isAdminUnlocked\(this\.state\.session\)\) return;/,
  );
  assert.match(
    consoleSource,
    /async _loadMenu\(\) \{\n {4}if \(!isAdminUnlocked\(this\.state\.session\)\) return;/,
  );
});

test('every operator action refuses to run while the console is locked', () => {
  assert.match(consoleSource, /_requireUnlocked\(\) \{\n {4}if \(isAdminUnlocked\(this\.state\.session\)\) return true;/);
  for (const method of [
    '_setView',
    '_openPlugin',
    '_submitPluginTurn',
    '_toggleMcp',
    '_createKey',
    '_revokeKey',
    '_loadComposio',
    '_validateComposio',
    '_runComposio',
    '_provisionLive',
    '_startLive',
    '_stopLive',
    '_toggleNavDrawer',
  ]) {
    // Anchor on the method definition, not on a call site inside `_bind`.
    const definition = new RegExp(`\\n  (?:async )?${method}\\(`).exec(consoleSource);
    assert.ok(definition, `${method} is missing from the console`);
    const body = consoleSource.slice(definition.index, definition.index + 240);
    assert.match(body, /_requireUnlocked\(\)/, `${method} must check the gate first`);
  }
});

test('plugin nav status distinguishes loading, empty, error, and ready', () => {
  assert.equal(pluginNavStatus({ loaded: false, plugins: [], errors: [] }), 'loading');
  assert.equal(pluginNavStatus({ loaded: true, plugins: [], errors: [] }), 'empty');
  assert.equal(pluginNavStatus({
    loaded: true,
    plugins: [],
    errors: [{ message: 'Could not read the plugin manifest' }],
  }), 'error');
  assert.equal(pluginNavStatus({ loaded: true, plugins: [{ id: 'fleet-watchlist' }], errors: [] }), 'ready');
  // Partial import failures still list the plugins that loaded.
  assert.equal(pluginNavStatus({
    loaded: true,
    plugins: [{ id: 'fleet-watchlist' }],
    errors: [{ message: 'other: failed to load' }],
  }), 'ready');
  assert.equal(pluginNavStatusMessage('loading'), 'Loading plugins…');
  assert.equal(pluginNavStatusMessage('empty'), 'No plugins yet.');
  assert.equal(pluginNavStatusMessage('error'), 'Could not load plugins.');
});

test('Escape closes the compact drawer first, then the console', () => {
  assert.equal(adminEscapeAction({ consoleOpen: false, compact: true, drawerOpen: true }), null);
  assert.equal(adminEscapeAction({ consoleOpen: true, compact: true, drawerOpen: true }), 'close-drawer');
  assert.equal(adminEscapeAction({ consoleOpen: true, compact: true, drawerOpen: false }), 'close-console');
  assert.equal(adminEscapeAction({ consoleOpen: true, compact: false, drawerOpen: true }), 'close-console');
});

test('the global ADMIN Escape handler captures before the globe handler', () => {
  assert.match(
    consoleSource,
    /document\?\.addEventListener\('keydown',[\s\S]*?this\._onDocumentKeydown\(event\), true\)/,
  );
  assert.match(consoleSource, /this\.state\.navDrawerOpen[\s\S]*?ADMIN_NAV_DRAWER_OPEN_CLASS/);
});

test('applyAdminNavLayout sets compact and drawer classes, and refuses a drawer on a wide rail', () => {
  const overlay = makeAdminOverlay();
  const wide = applyAdminNavLayout(overlay.root, { compact: false, drawerOpen: true });
  assert.equal(wide.compact, false);
  assert.equal(wide.drawerOpen, false);
  assert.equal(overlay.root.classList.contains(ADMIN_NAV_COMPACT_CLASS), false);
  assert.equal(overlay.root.classList.contains(ADMIN_NAV_DRAWER_OPEN_CLASS), false);

  const compact = applyAdminNavLayout(overlay.root, { compact: true, drawerOpen: true });
  assert.equal(compact.compact, true);
  assert.equal(compact.drawerOpen, true);
  assert.equal(overlay.root.classList.contains(ADMIN_NAV_COMPACT_CLASS), true);
  assert.equal(overlay.root.classList.contains(ADMIN_NAV_DRAWER_OPEN_CLASS), true);
  assert.equal(ADMIN_NAV_COMPACT_MAX_WIDTH, 900);
});

test('nextAdminNavItem walks arrow, home, and end keys', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.equal(nextAdminNavItem(items, items[0], 'ArrowDown'), items[1]);
  assert.equal(nextAdminNavItem(items, items[2], 'ArrowDown'), items[0]);
  assert.equal(nextAdminNavItem(items, items[0], 'ArrowUp'), items[2]);
  assert.equal(nextAdminNavItem(items, items[1], 'Home'), items[0]);
  assert.equal(nextAdminNavItem(items, items[0], 'End'), items[2]);
  assert.equal(nextAdminNavItem(items, null, 'ArrowDown'), items[0]);
  assert.equal(nextAdminNavItem([], items[0], 'ArrowDown'), null);
});

test('the two-column shell is in markup and CSS, without WordPress assets', () => {
  assert.match(html, /id="admin-nav"/);
  assert.match(html, /id="admin-workspace"/);
  assert.match(html, /id="admin-nav-toggle"/);
  assert.match(html, /id="admin-plugins-list"/);
  assert.match(html, /id="admin-plugins-loading"/);
  assert.match(html, /id="admin-plugins-empty"/);
  assert.match(css, /\.admin-dashboard \{[\s\S]*?flex-direction: row;/);
  assert.match(css, /\.admin-workspace \{/);
  assert.doesNotMatch(html, /dashicon|wp-admin|wpadminbar|wordpress/i);
  assert.doesNotMatch(css, /dashicon|#2271b1|#1d2327|#135e96/i);
});

/**
 * Small DOM used to drive the shipped controller: ids, data attributes,
 * classList, bubbling clicks, and createElement — not a browser.
 */
class MiniNode {
  constructor(tagName = 'div') {
    this.tagName = String(tagName).toLowerCase();
    this.children = [];
    this.parentNode = null;
    this.attrs = {};
    this._text = '';
    this._hidden = false;
    this._dataset = {};
    this.listeners = {};
    this.ownerDocument = null;
    this.classList = {
      names: new Set(),
      add: (name) => { this.classList.names.add(name); },
      remove: (name) => { this.classList.names.delete(name); },
      contains: (name) => this.classList.names.has(name),
      toggle: (name, force) => {
        const on = force === undefined ? !this.classList.names.has(name) : Boolean(force);
        if (on) this.classList.names.add(name);
        else this.classList.names.delete(name);
        return on;
      },
    };
    this.dataset = new Proxy(this._dataset, {
      set: (target, key, value) => {
        target[key] = String(value);
        this.attrs[`data-${String(key).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`] = String(value);
        return true;
      },
      get: (target, key) => target[key],
      has: (target, key) => key in target,
    });
  }

  get id() { return this.attrs.id || ''; }
  set id(value) { this.attrs.id = String(value); }
  get className() { return [...this.classList.names].join(' '); }
  set className(value) {
    this.classList.names = new Set(String(value || '').split(/\s+/).filter(Boolean));
  }
  get hidden() { return this._hidden; }
  set hidden(value) { this._hidden = Boolean(value); }
  get textContent() {
    if (this.children.length) return this.children.map((child) => child.textContent).join('');
    return this._text;
  }
  set textContent(value) {
    this._text = String(value ?? '');
    for (const child of this.children) child.parentNode = null;
    this.children = [];
  }

  setAttribute(name, value) {
    this.attrs[name] = String(value);
    if (name === 'class') this.className = value;
    if (name === 'id') this.attrs.id = String(value);
    if (name.startsWith('data-')) {
      const camel = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      this._dataset[camel] = String(value);
    }
  }
  getAttribute(name) { return this.attrs[name] ?? null; }

  append(...nodes) {
    for (const node of nodes) this.appendChild(node);
  }
  appendChild(node) {
    node.parentNode = this;
    this.children.push(node);
    return node;
  }
  replaceChildren(...nodes) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    for (const node of nodes) this.appendChild(node);
  }
  remove() {
    this.parentNode?.removeChild?.(this);
  }
  removeChild(node) {
    const index = this.children.indexOf(node);
    if (index >= 0) this.children.splice(index, 1);
    node.parentNode = null;
    return node;
  }

  matches(selector) {
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    const eq = /^\[data-([a-z0-9-]+)="([^"]*)"\]$/i.exec(selector);
    if (eq) {
      const camel = eq[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      return String(this._dataset[camel] ?? '') === eq[2];
    }
    const has = /^\[data-([a-z0-9-]+)\]$/i.exec(selector);
    if (has) {
      const camel = has[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      return Object.prototype.hasOwnProperty.call(this._dataset, camel)
        || Object.prototype.hasOwnProperty.call(this.attrs, `data-${has[1]}`);
    }
    if (selector[0] === '.') return this.classList.contains(selector.slice(1));
    return this.tagName === selector.toLowerCase();
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
  querySelectorAll(selector) {
    const found = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (child.matches(selector)) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }
  closest(selector) {
    let node = this;
    while (node) {
      if (node.matches?.(selector)) return node;
      node = node.parentNode;
    }
    return null;
  }

  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
  dispatchEvent(event) {
    const payload = event || {};
    if (!payload.target) payload.target = this;
    if (!payload.preventDefault) payload.preventDefault = () => { payload.defaultPrevented = true; };
    if (!payload.stopImmediatePropagation) payload.stopImmediatePropagation = () => { payload._stopped = true; };
    let node = this;
    while (node && !payload._stopped) {
      for (const fn of node.listeners[payload.type] || []) {
        fn(payload);
        if (payload._stopped) break;
      }
      node = node.parentNode;
    }
    return true;
  }
  click() {
    this.dispatchEvent({ type: 'click' });
  }
  focus() { this.focused = true; }
}

function mini(tag, attrs = {}, children = []) {
  const node = new MiniNode(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'id') node.id = value;
    else if (key === 'className') node.className = value;
    else if (key === 'hidden') node.hidden = value;
    else if (key === 'dataset') {
      for (const [dataKey, dataValue] of Object.entries(value)) node.dataset[dataKey] = dataValue;
    } else if (key === 'text') node.textContent = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) node.appendChild(child);
  return node;
}

function menuItem(id, label, description, { active = false } = {}) {
  return mini('button', {
    className: `admin-menu-item${active ? ' active' : ''}`,
    type: 'button',
    dataset: { adminView: id },
    'aria-current': active ? 'page' : 'false',
  }, [
    mini('strong', { text: label }),
    mini('small', { text: description }),
  ]);
}

function makeLiveAdminTree() {
  const createItem = menuItem('create-plugin', 'Create Plugin', 'Describe a plugin', { active: true });
  const mcpItem = menuItem('mcp-server', 'MCP Server', 'Expose this console');
  const liveItem = menuItem('live-stream', 'Go Live', 'Capture the globe');
  const coreGroup = mini('div', { className: 'admin-nav-group', dataset: { adminNavGroup: 'core' } }, [
    mini('h3', { id: 'admin-nav-core-heading', className: 'admin-nav-heading', text: 'Core' }),
    createItem,
    mcpItem,
    liveItem,
  ]);
  const pluginList = mini('div', { id: 'admin-plugins-list', className: 'admin-plugins-list' });
  const loading = mini('p', { id: 'admin-plugins-loading', className: 'admin-nav-status', hidden: true, text: 'Loading plugins…' });
  const empty = mini('p', { id: 'admin-plugins-empty', className: 'admin-nav-status', hidden: true, text: 'No plugins yet.' });
  const errors = mini('p', { id: 'admin-menu-errors', className: 'admin-menu-errors', hidden: true });
  const pluginsGroup = mini('div', { className: 'admin-nav-group', dataset: { adminNavGroup: 'plugins' } }, [
    mini('h3', { id: 'admin-nav-plugins-heading', className: 'admin-nav-heading', text: 'Plugins' }),
    pluginList,
    loading,
    empty,
    errors,
  ]);
  const menu = mini('nav', { id: 'admin-menu', className: 'admin-menu' }, [coreGroup, pluginsGroup]);
  const nav = mini('aside', { id: 'admin-nav', className: 'admin-nav' }, [
    mini('div', { className: 'admin-nav-brand' }, [
      mini('strong', { text: "GOD'S EYE VIEW" }),
    ]),
    menu,
  ]);
  const createPane = mini('div', { className: 'admin-pane', hidden: true, dataset: { adminPane: 'create-plugin' } }, [
    mini('ul', { id: 'admin-plugin-list', className: 'admin-plugin-list' }),
    mini('h3', { id: 'admin-chat-heading', text: 'Create Plugin' }),
    mini('div', { id: 'admin-transcript' }),
    mini('label', { id: 'admin-plugin-name-field' }),
    mini('button', { id: 'admin-plugin-submit', type: 'submit' }),
  ]);
  const mcpPane = mini('div', {
    className: 'admin-pane admin-pane-mcp',
    hidden: true,
    dataset: { adminPane: 'mcp-server' },
  }, [
    mini('span', { id: 'admin-mcp-state', text: 'OFF' }),
    mini('button', { id: 'admin-mcp-toggle' }),
    mini('pre', { id: 'admin-mcp-snippet' }),
    mini('p', { id: 'admin-mcp-fresh', hidden: true }),
    mini('ul', { id: 'admin-mcp-keys' }),
  ]);
  const livePane = mini('div', {
    className: 'admin-pane admin-pane-live',
    hidden: true,
    dataset: { adminPane: 'live-stream' },
  }, [
    mini('span', { id: 'admin-live-state', text: 'OFFLINE' }),
    mini('button', { id: 'admin-live-start' }),
    mini('button', { id: 'admin-live-stop' }),
    mini('button', { id: 'admin-live-provision' }),
    mini('p', { id: 'admin-live-summary' }),
    mini('a', { id: 'admin-live-watch', hidden: true }),
    mini('pre', { id: 'admin-live-log' }),
  ]);
  const host = mini('div', {
    id: 'admin-plugin-host',
    className: 'admin-pane admin-pane-plugin',
    hidden: true,
    dataset: { adminPane: '' },
  });
  const workspace = mini('div', { id: 'admin-workspace', className: 'admin-workspace' }, [
    createPane, mcpPane, livePane, host,
  ]);
  const dashboard = mini('div', { id: 'admin-dashboard', className: 'admin-dashboard', hidden: true }, [
    mini('div', { id: 'admin-nav-drawer-scrim', className: 'admin-nav-drawer-scrim', hidden: true }),
    nav,
    workspace,
  ]);
  const root = mini('div', { id: 'admin-console', className: 'admin-console', hidden: true }, [
    mini('header', { className: 'admin-console-header' }, [
      mini('button', { id: 'admin-nav-toggle', className: 'admin-nav-toggle', hidden: true, text: 'MENU' }),
      mini('h2', { id: 'admin-console-title', text: 'ADMIN' }),
      mini('span', { id: 'admin-status', text: 'LOCKED' }),
      mini('button', { id: 'admin-signout', hidden: true, text: 'SIGN OUT' }),
      mini('button', { id: 'admin-close', text: 'CLOSE' }),
    ]),
    mini('p', { id: 'admin-message', hidden: true }),
    mini('div', { id: 'admin-gate', className: 'admin-gate' }, [
      mini('p', { id: 'admin-unconfigured', hidden: true }),
      mini('form', { id: 'admin-login-form', className: 'admin-login-form' }),
    ]),
    dashboard,
  ]);
  return {
    root, dashboard, nav, menu, coreGroup, pluginsGroup, pluginList,
    loading, empty, errors, createPane, mcpPane, livePane, host,
    createItem, mcpItem, liveItem,
    signout: root.querySelector('#admin-signout'),
    toggle: root.querySelector('#admin-nav-toggle'),
    gate: root.querySelector('#admin-gate'),
  };
}

function installAdminGlobals(root) {
  const hadDocument = Object.prototype.hasOwnProperty.call(globalThis, 'document');
  const hadWindow = Object.prototype.hasOwnProperty.call(globalThis, 'window');
  const previous = { document: globalThis.document, window: globalThis.window };
  const location = {
    href: 'http://localhost:4173/',
    pathname: '/',
    search: '',
    hash: '',
    origin: 'http://localhost:4173',
    assigned: null,
    replaced: null,
    assign(...args) { this.assigned = args; },
    replace(...args) { this.replaced = args; },
  };
  const document = {
    getElementById(id) {
      if (root.id === id) return root;
      return root.querySelector(`#${id}`);
    },
    addEventListener() {},
    body: { classList: { add() {}, remove() {} } },
    createElement(tag) {
      const node = new MiniNode(tag);
      node.ownerDocument = document;
      return node;
    },
  };
  const stamp = (node) => {
    node.ownerDocument = document;
    for (const child of node.children) stamp(child);
  };
  stamp(root);
  globalThis.document = document;
  globalThis.window = {
    location,
    history: {
      replaceState() { location.replacedState = true; },
      pushState() { location.pushedState = true; },
    },
    setInterval() { return 0; },
    clearInterval() {},
    setTimeout() { return 0; },
    clearTimeout() {},
    matchMedia() {
      return {
        matches: false,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
      };
    },
  };
  return {
    location,
    restore() {
      if (hadDocument) globalThis.document = previous.document;
      else delete globalThis.document;
      if (hadWindow) globalThis.window = previous.window;
      else delete globalThis.window;
    },
  };
}

function stubClient() {
  return {
    session: async () => ({ configured: true, authenticated: true, mcpEnabled: false }),
    loginUrl: () => '/api/admin/login?returnTo=%2F',
    logout: async () => ({}),
    menu: async () => ({ plugins: [] }),
    listPlugins: async () => ({ plugins: [] }),
    mcpSettings: async () => ({ enabled: false, endpoint: '/api/admin/mcp', keys: [] }),
    liveStatus: async () => ({ live: { status: 'idle', log: [], framesSent: 0 } }),
    listLiveBroadcasts: async () => ({ broadcasts: [] }),
    provisionLive: async () => ({ broadcast: {}, live: { status: 'idle' } }),
    selectLive: async () => ({ broadcast: {}, live: { status: 'idle' } }),
    startLive: async () => ({ live: { status: 'idle' } }),
    stopLive: async () => ({ live: { status: 'stopped' } }),
  };
}

function labelsIn(group) {
  return group.querySelectorAll('[data-admin-view]').map((button) => {
    const strong = button.querySelector('strong');
    return strong ? strong.textContent : button.textContent;
  });
}

test('locked then unlocked console paints the two-column shell and core nav', (t) => {
  const tree = makeLiveAdminTree();
  const globals = installAdminGlobals(tree.root);
  t.after(globals.restore);

  const controller = initAdminConsole({
    root: tree.root,
    client: stubClient(),
    registry: { load: async () => ({ plugins: [], errors: [] }) },
  });
  assert.ok(controller instanceof AdminConsoleController);
  controller._render();

  assert.equal(tree.root.classList.contains(ADMIN_UNLOCKED_CLASS), false);
  assert.equal(tree.dashboard.hidden, true);
  assert.equal(tree.signout.hidden, true);
  assert.equal(tree.toggle.hidden, true);
  assert.equal(tree.createPane.hidden, true);
  assert.equal(tree.mcpPane.hidden, true);
  assert.equal(tree.nav.querySelectorAll('[data-admin-generated]').length, 0);

  controller.state.session = { configured: true, authenticated: true, mcpEnabled: false };
  controller._render();

  assert.equal(tree.root.classList.contains(ADMIN_UNLOCKED_CLASS), true);
  assert.equal(tree.dashboard.hidden, false);
  assert.equal(tree.signout.hidden, false);
  assert.deepEqual(labelsIn(tree.coreGroup), ['Create Plugin', 'MCP Server', 'Go Live']);
  assert.equal(tree.createItem.classList.contains('active'), true);
  assert.equal(tree.loading.hidden, false, 'plugins group starts in the loading state');
  assert.equal(tree.empty.hidden, true);
  assert.equal(tree.errors.hidden, true);
  assert.equal(tree.createPane.hidden, false);
});

test('selecting left-nav items switches existing panes without changing the URL', async (t) => {
  const tree = makeLiveAdminTree();
  const globals = installAdminGlobals(tree.root);
  t.after(globals.restore);
  const fleet = {
    id: 'fleet-watchlist',
    label: 'Fleet Watchlist',
    description: 'Saved vessels.',
    render(container) {
      container.mounted = true;
      const mark = (container.ownerDocument || globalThis.document).createElement('span');
      mark.textContent = 'fleet-ui';
      container.append(mark);
    },
  };
  const controller = initAdminConsole({
    root: tree.root,
    client: stubClient(),
    registry: { load: async () => ({ plugins: [fleet], errors: [] }) },
  });

  controller._render();
  const lockedView = controller.state.view;
  controller._setView('mcp-server');
  assert.equal(controller.state.view, lockedView, 'locked sessions refuse to switch views');
  assert.equal(tree.mcpPane.hidden, true);
  assert.match(controller.state.message, /Log in/);

  controller.state.session = { configured: true, authenticated: true, mcpEnabled: false };
  await controller._loadMenu();

  const href = globalThis.window.location.href;
  tree.mcpItem.click();
  assert.equal(controller.state.view, 'mcp-server');
  assert.equal(tree.mcpPane.hidden, false);
  assert.equal(tree.createPane.hidden, true);
  assert.equal(tree.mcpItem.classList.contains('active'), true);
  assert.equal(tree.createItem.classList.contains('active'), false);
  assert.equal(globalThis.window.location.href, href);
  assert.equal(globalThis.window.location.assigned, null);
  assert.equal(globalThis.window.history.replacedState, undefined);

  tree.liveItem.click();
  assert.equal(controller.state.view, 'live-stream');
  assert.equal(tree.livePane.hidden, false);
  assert.equal(tree.mcpPane.hidden, true);
  assert.equal(tree.liveItem.classList.contains('active'), true);

  const generated = tree.pluginList.querySelector('[data-admin-view="fleet-watchlist"]');
  assert.ok(generated, 'generated plugins render in the Plugins list');
  assert.equal(generated.querySelector('strong').textContent, 'Fleet Watchlist');
  assert.equal(tree.coreGroup.querySelectorAll('[data-admin-generated]').length, 0);
  generated.click();
  assert.equal(controller.state.view, 'fleet-watchlist');
  assert.equal(tree.host.hidden, false);
  assert.equal(tree.host.dataset.adminPane, 'fleet-watchlist');
  assert.equal(tree.livePane.hidden, true);
  assert.equal(tree.host.mounted, true);
  assert.equal(globalThis.window.location.href, href);
});

test('the shipped Google Earth plugin mounts in the Plugins pane and reports DISPLAYING', async (t) => {
  const tree = makeLiveAdminTree();
  const globals = installAdminGlobals(tree.root);
  t.after(globals.restore);
  const { default: plugin } = await import('./adminPlugins/google-earth.js');
  globalThis.window.__godsEyeView = {
    googleApiKey: 'AIzaSy-test-key',
    tileset: { show: true, isDestroyed: () => false },
    mapStackController: {
      getActiveId: () => 'photoreal',
      setStack: async () => ({ activeId: 'photoreal' }),
    },
    viewer: { scene: { globe: { show: false } } },
  };
  const controller = initAdminConsole({
    root: tree.root,
    client: stubClient(),
    registry: { load: async () => ({ plugins: [plugin], errors: [] }) },
  });
  controller.state.session = { configured: true, authenticated: true, mcpEnabled: false };
  await controller._loadMenu();
  const item = tree.pluginList.querySelector('[data-admin-view="google-earth"]');
  assert.ok(item, 'Google Earth is listed under Plugins');
  item.click();
  assert.equal(controller.state.view, 'google-earth');
  assert.equal(tree.host.hidden, false);
  assert.equal(tree.host.dataset.adminPane, 'google-earth');
  const status = tree.host.querySelector('#admin-google-earth-status');
  assert.ok(status, 'the plugin painted its status into the pane');
  assert.equal(status.dataset.googleEarthState, 'DISPLAYING');
  assert.match(status.textContent, /DISPLAYING/);
});

test('a missing manifest is empty and a failed manifest is an error, not a plugin list', async (t) => {
  const missingTree = makeLiveAdminTree();
  const missingGlobals = installAdminGlobals(missingTree.root);
  try {
    const missing = initAdminConsole({
      root: missingTree.root,
      client: stubClient(),
      registry: { load: async () => ({ plugins: [], errors: [] }) },
    });
    missing.state.session = { configured: true, authenticated: true };
    await missing._loadMenu();
    assert.equal(missingTree.empty.hidden, false);
    assert.equal(missingTree.loading.hidden, true);
    assert.equal(missingTree.errors.hidden, true);
    assert.equal(missingTree.pluginList.querySelectorAll('[data-admin-generated]').length, 0);
  } finally {
    missingGlobals.restore();
  }

  const failedTree = makeLiveAdminTree();
  const failedGlobals = installAdminGlobals(failedTree.root);
  t.after(failedGlobals.restore);
  const failed = initAdminConsole({
    root: failedTree.root,
    client: stubClient(),
    registry: { load: async () => ({ plugins: [], errors: [{ id: '', message: 'disk gone' }] }) },
  });
  failed.state.session = { configured: true, authenticated: true };
  await failed._loadMenu();
  assert.equal(failedTree.errors.hidden, false);
  assert.match(failedTree.errors.textContent, /disk gone/);
  assert.equal(failedTree.empty.hidden, true);
  assert.equal(failedTree.loading.hidden, true);
  assert.equal(failedTree.pluginList.querySelectorAll('[data-admin-generated]').length, 0,
    'a failed manifest must not paint a successful plugin list');

  const thrown = initAdminConsole({
    root: failedTree.root,
    client: stubClient(),
    registry: { load: async () => { throw new Error('manifest exploded'); } },
  });
  thrown.state.session = { configured: true, authenticated: true };
  await thrown._loadMenu();
  assert.equal(failedTree.errors.hidden, false);
  assert.match(failedTree.errors.textContent, /manifest exploded/);
  assert.equal(failedTree.pluginList.querySelectorAll('[data-admin-generated]').length, 0);
});

test('compact layout opens a drawer and Escape closes the drawer without closing ADMIN', (t) => {
  const tree = makeLiveAdminTree();
  const globals = installAdminGlobals(tree.root);
  t.after(globals.restore);
  const controller = initAdminConsole({
    root: tree.root,
    client: stubClient(),
    registry: { load: async () => ({ plugins: [], errors: [] }) },
  });
  controller.state.session = { configured: true, authenticated: true };
  controller._navMedia = { matches: true };
  controller._syncNavLayout();
  assert.equal(tree.root.classList.contains(ADMIN_NAV_COMPACT_CLASS), true);
  assert.equal(tree.root.classList.contains(ADMIN_NAV_DRAWER_OPEN_CLASS), false);

  tree.root.hidden = false;
  controller._setNavDrawerOpen(true);
  assert.equal(tree.root.classList.contains(ADMIN_NAV_DRAWER_OPEN_CLASS), true);
  assert.equal(controller.state.navDrawerOpen, true);
  assert.equal(tree.toggle.getAttribute('aria-expanded'), 'true');

  let stopped = false;
  const event = {
    key: 'Escape',
    preventDefault() { this.defaultPrevented = true; },
    stopImmediatePropagation() { stopped = true; },
  };
  controller._onDocumentKeydown(event);
  assert.equal(controller.state.navDrawerOpen, false);
  assert.equal(tree.root.classList.contains(ADMIN_NAV_DRAWER_OPEN_CLASS), false);
  assert.equal(tree.root.hidden, false, 'Escape on an open drawer must not close the console');
  assert.equal(stopped, true);

  controller._onDocumentKeydown({ key: 'Escape' });
  assert.equal(tree.root.hidden, true);
});

test('locking the console hides dashboard, nav, panes, and sign-out after they were painted', (t) => {
  const tree = makeLiveAdminTree();
  const globals = installAdminGlobals(tree.root);
  t.after(globals.restore);
  const controller = initAdminConsole({
    root: tree.root,
    client: stubClient(),
    registry: { load: async () => ({ plugins: [{ id: 'fleet-watchlist', label: 'Fleet Watchlist', render() {} }], errors: [] }) },
  });
  controller.state.session = { configured: true, authenticated: true };
  controller.state.menuPlugins = [{ id: 'fleet-watchlist', label: 'Fleet Watchlist', render() {} }];
  controller.state.menuLoaded = true;
  controller._render();
  assert.equal(tree.dashboard.hidden, false);
  assert.equal(tree.pluginList.querySelectorAll('[data-admin-generated]').length, 1);

  controller.state.session = { configured: true, authenticated: false };
  controller._render();
  assert.equal(tree.root.classList.contains(ADMIN_UNLOCKED_CLASS), false);
  assert.equal(tree.dashboard.hidden, true);
  assert.equal(tree.signout.hidden, true);
  assert.equal(tree.toggle.hidden, true);
  assert.equal(tree.createPane.hidden, true);
  assert.equal(tree.pluginList.querySelectorAll('[data-admin-generated]').length, 0);
  assert.equal(tree.loading.hidden, true);
  assert.equal(tree.empty.hidden, true);
  assert.equal(tree.errors.hidden, true);
  assert.equal(tree.root.classList.contains(ADMIN_NAV_DRAWER_OPEN_CLASS), false);
});

test('view switching does not assign or replace the page URL', () => {
  const definition = /\n  _setView\(view\) \{/.exec(consoleSource);
  assert.ok(definition, '_setView is missing');
  const body = consoleSource.slice(definition.index, definition.index + 900);
  assert.doesNotMatch(body, /location\.(assign|replace|href)\s*=/);
  assert.doesNotMatch(body, /history\.(pushState|replaceState)/);
  assert.match(body, /_requireUnlocked\(\)/);
});
