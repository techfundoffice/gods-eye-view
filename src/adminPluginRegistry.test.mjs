import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ADMIN_MAX_MENU_PLUGINS,
  ADMIN_PLUGIN_ROUTE_BASE,
  adoptPluginModule,
  createPluginRegistry,
  mountPlugin,
  normalizePluginManifest,
  pluginModuleUrl,
} from './adminPluginRegistry.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A manifest entry the agent would write for a healthy plugin. */
function entry({ id = 'fleet-watchlist', ...overrides } = {}) {
  return { id, label: 'Fleet Watchlist', module: `./${id}.js`, ...overrides };
}

test('a well-formed manifest becomes menu entries', () => {
  const entries = normalizePluginManifest([entry({ description: 'Watch a fleet.' })]);
  assert.deepEqual(entries, [{
    id: 'fleet-watchlist',
    label: 'Fleet Watchlist',
    description: 'Watch a fleet.',
    module: './fleet-watchlist.js',
  }]);
});

test('a manifest wrapped in an object is read the same as a bare array', () => {
  assert.equal(normalizePluginManifest({ plugins: [entry()] }).length, 1);
});

test('entries without a usable slug id are dropped rather than rendered', () => {
  const entries = normalizePluginManifest([
    entry({ id: '' }),
    entry({ id: '../escape' }),
    entry({ id: 'Has Spaces' }),
    entry({ id: '-leading-dash' }),
    null,
    'not-an-object',
    entry({ id: 'kept' }),
  ]);
  assert.deepEqual(entries.map((item) => item.id), ['kept']);
});

test('an uppercase id is accepted as its lowercase slug', () => {
  assert.equal(normalizePluginManifest([entry({ id: 'Fleet-Watchlist' })])[0].id, 'fleet-watchlist');
});

test('a duplicate id keeps the first entry so one plugin owns one menu slot', () => {
  const entries = normalizePluginManifest([
    entry({ label: 'First' }),
    entry({ label: 'Second' }),
  ]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].label, 'First');
});

test('a missing label falls back to the id, and a missing module to the conventional path', () => {
  const [item] = normalizePluginManifest([{ id: 'traffic-notes' }]);
  assert.equal(item.label, 'traffic-notes');
  assert.equal(item.module, './traffic-notes.js');
  assert.equal(item.description, '');
});

test('a runaway manifest cannot flood the nav', () => {
  const many = Array.from({ length: ADMIN_MAX_MENU_PLUGINS + 15 }, (_, index) => entry({ id: `plugin-${index}` }));
  assert.equal(normalizePluginManifest(many).length, ADMIN_MAX_MENU_PLUGINS);
});

test('a non-array manifest degrades to no plugins instead of throwing', () => {
  for (const raw of [null, undefined, 42, 'nope', {}]) {
    assert.deepEqual(normalizePluginManifest(raw), []);
  }
});

test('a module path resolves inside the plugin directory', () => {
  assert.equal(pluginModuleUrl(entry()), `${ADMIN_PLUGIN_ROUTE_BASE}fleet-watchlist.js`);
  assert.equal(pluginModuleUrl(entry({ module: 'fleet-watchlist.js' })), `${ADMIN_PLUGIN_ROUTE_BASE}fleet-watchlist.js`);
});

test('a module path that escapes the plugin directory is refused, not rewritten', () => {
  const refused = [
    '../main.js',
    './../main.js',
    'nested/deep.js',
    '/src/main.js',
    '\\src\\main.js',
    'https://example.com/evil.js',
    'http://example.com/evil.js',
    'data:text/javascript,alert(1)',
    'javascript:alert(1)',
    '//example.com/evil.js',
    'fleet-watchlist.mjs',
    'fleet-watchlist.js.txt',
    '',
  ];
  for (const module of refused) {
    assert.equal(pluginModuleUrl(entry({ module })), '', `expected ${module} to be refused`);
  }
});

test('a default export with render() is adopted, and its own label wins', () => {
  const adopted = adoptPluginModule(
    { default: { id: 'ignored', label: 'Live Fleet', description: 'From the module.', render() {} } },
    normalizePluginManifest([entry()])[0],
  );
  assert.equal(adopted.id, 'fleet-watchlist', 'the manifest id stays authoritative');
  assert.equal(adopted.label, 'Live Fleet');
  assert.equal(adopted.description, 'From the module.');
  assert.equal(typeof adopted.render, 'function');
});

test('a module exporting the plugin object directly is still adopted', () => {
  const adopted = adoptPluginModule({ render() {} }, normalizePluginManifest([entry()])[0]);
  assert.ok(adopted);
  assert.equal(adopted.label, 'Fleet Watchlist', 'manifest label fills the gap');
});

test('a module without a render function is not adopted', () => {
  const item = normalizePluginManifest([entry()])[0];
  assert.equal(adoptPluginModule({ default: {} }, item), null);
  assert.equal(adoptPluginModule({ default: { render: 'nope' } }, item), null);
  assert.equal(adoptPluginModule({ default: null }, item), null);
  assert.equal(adoptPluginModule(null, item), null);
});

test('render keeps its own object as `this`', () => {
  let seen = null;
  const plugin = {
    marker: 'self',
    render() { seen = this.marker; },
  };
  const adopted = adoptPluginModule({ default: plugin }, normalizePluginManifest([entry()])[0]);
  adopted.render({}, {});
  assert.equal(seen, 'self');
});

test('mounting hands back the plugin cleanup function', () => {
  let torn = 0;
  const container = {};
  const context = { client: {} };
  let sawContainer = null;
  let sawContext = null;
  const { cleanup, error } = mountPlugin({
    id: 'fleet-watchlist',
    render(target, ctx) {
      sawContainer = target;
      sawContext = ctx;
      return () => { torn += 1; };
    },
  }, container, context);
  assert.equal(error, '');
  assert.equal(sawContainer, container);
  assert.equal(sawContext, context);
  cleanup();
  assert.equal(torn, 1);
});

test('a plugin that throws while rendering reports the error and still unmounts cleanly', () => {
  const { cleanup, error } = mountPlugin({
    id: 'broken',
    render() { throw new Error('boom'); },
  }, {}, {});
  assert.equal(error, 'boom');
  assert.doesNotThrow(() => cleanup());
});

test('a plugin whose cleanup throws cannot trap the operator in its menu item', () => {
  const { cleanup } = mountPlugin({
    id: 'bad-teardown',
    render: () => () => { throw new Error('teardown failed'); },
  }, {}, {});
  assert.doesNotThrow(() => cleanup());
});

test('a plugin returning a non-function still yields a callable cleanup', () => {
  const { cleanup, error } = mountPlugin({ id: 'quiet', render: () => 'not a function' }, {}, {});
  assert.equal(error, '');
  assert.doesNotThrow(() => cleanup());
});

test('the registry loads every healthy plugin in the manifest', async () => {
  const imported = [];
  const registry = createPluginRegistry({
    loadManifest: async () => [entry(), entry({ id: 'traffic-notes', label: 'Traffic Notes' })],
    importModule: async (url) => {
      imported.push(url);
      return { default: { render() {} } };
    },
  });
  const { plugins, errors } = await registry.load();
  assert.deepEqual(plugins.map((plugin) => plugin.id), ['fleet-watchlist', 'traffic-notes']);
  assert.deepEqual(errors, []);
  assert.deepEqual(imported, [
    `${ADMIN_PLUGIN_ROUTE_BASE}fleet-watchlist.js`,
    `${ADMIN_PLUGIN_ROUTE_BASE}traffic-notes.js`,
  ]);
});

test('one broken plugin costs itself its menu slot and nothing more', async () => {
  const registry = createPluginRegistry({
    loadManifest: async () => [
      entry({ id: 'escapes', module: '../main.js' }),
      entry({ id: 'throws' }),
      entry({ id: 'shapeless' }),
      entry({ id: 'healthy' }),
    ],
    importModule: async (url) => {
      if (url.includes('throws')) throw new Error('Failed to fetch dynamically imported module');
      if (url.includes('shapeless')) return { default: { label: 'No render' } };
      return { default: { render() {} } };
    },
  });
  const { plugins, errors } = await registry.load();
  assert.deepEqual(plugins.map((plugin) => plugin.id), ['healthy']);
  assert.deepEqual(errors.map((item) => item.id), ['escapes', 'throws', 'shapeless']);
  assert.match(errors[0].message, /plugin directory/);
  assert.match(errors[1].message, /dynamically imported/);
  assert.match(errors[2].message, /render\(\)/);
});

test('an unreachable manifest leaves the console with no plugins and one error', async () => {
  const registry = createPluginRegistry({
    loadManifest: async () => { throw new Error('Admin sign-in required'); },
    importModule: async () => { throw new Error('should not be reached'); },
  });
  const { plugins, errors } = await registry.load();
  assert.deepEqual(plugins, []);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].message, 'Admin sign-in required');
});

test('the registry refuses to be built without its two collaborators', () => {
  assert.throws(() => createPluginRegistry({ importModule: () => {} }), TypeError);
  assert.throws(() => createPluginRegistry({ loadManifest: () => {} }), TypeError);
});

test('a plugin written to disk the way the agent is told to write one loads and renders', async (t) => {
  // End to end over the real contract: a manifest file, a real ES module, a
  // real dynamic import, and the mount/cleanup handshake.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-admin-plugins-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(root, 'manifest.json'),
    JSON.stringify([{ id: 'fleet-watchlist', label: 'Fleet Watchlist', module: './fleet-watchlist.js' }]),
  );
  fs.writeFileSync(path.join(root, 'fleet-watchlist.js'), `
    export default {
      id: 'fleet-watchlist',
      label: 'Fleet Watchlist',
      description: 'Saved vessels.',
      render(container) {
        container.painted = true;
        return () => { container.painted = false; };
      },
    };
  `);

  const registry = createPluginRegistry({
    loadManifest: () => JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')),
    importModule: (url) => import(url),
    base: `${new URL(`file://${root}/`).href}`,
  });

  const { plugins, errors } = await registry.load();
  assert.deepEqual(errors, []);
  assert.equal(plugins.length, 1);
  assert.equal(plugins[0].label, 'Fleet Watchlist');

  const container = {};
  const { cleanup, error } = mountPlugin(plugins[0], container, {});
  assert.equal(error, '');
  assert.equal(container.painted, true);
  cleanup();
  assert.equal(container.painted, false);
});

test('the console markup and controller carry the generated-plugin menu', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const console_ = fs.readFileSync(path.join(ROOT, 'src', 'adminConsole.js'), 'utf8');

  assert.match(html, /<nav id="admin-menu"/, 'the menu needs an id to append generated items to');
  assert.equal((html.match(/id="admin-plugin-host"/g) || []).length, 1, 'one owner for the plugin pane');
  assert.match(html, /id="admin-plugin-host"[^>]*data-admin-pane=""/, 'the pane starts unclaimed and hidden');
  assert.match(html, /id="admin-menu-errors"/, 'load failures need somewhere to be reported');

  // Menu clicks are delegated, or plugin items appended later would be inert.
  assert.match(console_, /this\.root\.addEventListener\('click'[\s\S]{0,220}data-admin-view/);
  assert.doesNotMatch(console_, /querySelectorAll\('\[data-admin-view\]'\)\.forEach\(\(button\) => \{\s*button\.addEventListener/);
  // A finished build refreshes the menu without a page reload.
  assert.match(console_, /_stopPolling\(\);\s*void this\._loadPlugins\(\);[\s\S]{0,120}void this\._loadMenu\(\);/);
});
