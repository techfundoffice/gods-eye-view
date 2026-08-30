import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ADMIN_MENU_ITEMS,
  ADMIN_REQUEST_HEADER,
  ADMIN_UNLOCKED_CLASS,
  adminMcpClientSnippet,
  applyAdminLockPaint,
  createAdminClient,
  describeSessionState,
  hasRunningBuild,
  isAdminUnlocked,
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

test('the dashboard menu is the three shipped items and has no Composio surface', () => {
  assert.deepEqual(
    ADMIN_MENU_ITEMS.map((item) => item.id),
    ['create-plugin', 'mcp-server', 'live-stream'],
  );
  assert.deepEqual(
    ADMIN_MENU_ITEMS.map((item) => item.label),
    ['Create New Admin Menu Plugin', 'MCP Server', 'Go Live (ffmpeg)'],
  );
  for (const item of ADMIN_MENU_ITEMS) {
    assert.ok(item.id && item.description, `${item.label} has an id and a description`);
  }

  const menuBlob = JSON.stringify(ADMIN_MENU_ITEMS);
  assert.equal(/composio/i.test(menuBlob), false, 'ADMIN_MENU_ITEMS must not name Composio');

  const dashboard = html.match(/<div id="admin-dashboard"[\s\S]*?<div id="admin-plugin-host"/);
  assert.ok(dashboard, 'the dashboard markup is missing from index.html');
  assert.equal(/composio/i.test(dashboard[0]), false, 'index.html dashboard must not name Composio');
  assert.match(dashboard[0], /data-admin-view="create-plugin"/);
  assert.match(dashboard[0], /data-admin-view="mcp-server"/);
  assert.match(dashboard[0], /data-admin-view="live-stream"/);

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const depNames = [
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
  ].join('\n');
  assert.equal(/composio/i.test(depNames), false, 'package.json must not declare a Composio package');
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

test('mutating calls carry the anti-CSRF header and a JSON body', async () => {
  const { fetchImpl, calls } = fakeFetch([{ body: { authenticated: true } }]);
  const client = createAdminClient({ fetchImpl });
  await client.login('hunter2');

  assert.equal(calls[0].url, '/api/admin/login');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers[ADMIN_REQUEST_HEADER], '1');
  assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].options.body), { password: 'hunter2' });
});

test('a bodyless POST still carries the header but no content type', async () => {
  const { fetchImpl, calls } = fakeFetch([{ body: {} }]);
  await createAdminClient({ fetchImpl }).logout();
  assert.equal(calls[0].options.headers[ADMIN_REQUEST_HEADER], '1');
  assert.equal(calls[0].options.headers['Content-Type'], undefined);
  assert.equal(calls[0].options.body, undefined);
});

test('every route the console needs is addressed and escaped', async () => {
  const { fetchImpl, calls } = fakeFetch(new Array(9).fill({ body: {} }));
  const client = createAdminClient({ fetchImpl });
  await client.listPlugins();
  await client.createPlugin('Watchlist', 'track ships');
  await client.getPlugin('job/1');
  await client.sendPluginMessage('job/1', 'more');
  await client.mcpSettings();
  await client.setMcpEnabled(true);
  await client.createMcpKey('Laptop');
  await client.revokeMcpKey('key 1');

  assert.deepEqual(calls.map((entry) => `${entry.options.method} ${entry.url}`), [
    'GET /api/admin/plugins',
    'POST /api/admin/plugins',
    'GET /api/admin/plugins/job%2F1',
    'POST /api/admin/plugins/job%2F1/messages',
    'GET /api/admin/mcp/settings',
    'POST /api/admin/mcp/settings',
    'POST /api/admin/mcp/keys',
    'DELETE /api/admin/mcp/keys/key%201',
  ]);
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
  assert.match(consoleSource, /if \(!unlocked\) \{\n {6}this\._clearGeneratedMenu\(\);\n {6}return;/);
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
  const dashboard = makeNode('admin-dashboard', { hidden: true, classes: ['admin-dashboard'] });
  const createPane = makeNode('', { hidden: true, dataset: { adminPane: 'create-plugin' } });
  const mcpPane = makeNode('', { hidden: true, dataset: { adminPane: 'mcp-server' } });
  const livePane = makeNode('', { hidden: true, dataset: { adminPane: 'live-stream' } });
  root.children.push(gate, signout, dashboard);
  dashboard.children.push(createPane, mcpPane, livePane);
  return { root, gate, signout, dashboard, createPane, mcpPane, livePane };
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
  assert.equal(overlay.createPane.hidden, true);
  assert.equal(overlay.mcpPane.hidden, true);
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
  assert.equal(overlay.createPane.hidden, true);
  assert.equal(overlay.mcpPane.hidden, false);
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
  assert.match(css, /\.admin-console:not\(\.admin-unlocked\) #admin-signout/);
  assert.match(css, /\.admin-console:not\(\.admin-unlocked\) \[data-admin-pane\]/);
  assert.match(css, /\.admin-console\.admin-unlocked #admin-gate/);
  assert.match(css, /display: none !important;/);
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
    '_provisionLive',
    '_startLive',
    '_stopLive',
  ]) {
    // Anchor on the method definition, not on a call site inside `_bind`.
    const definition = new RegExp(`\\n  (?:async )?${method}\\(`).exec(consoleSource);
    assert.ok(definition, `${method} is missing from the console`);
    const body = consoleSource.slice(definition.index, definition.index + 240);
    assert.match(body, /_requireUnlocked\(\)/, `${method} must check the gate first`);
  }
});
