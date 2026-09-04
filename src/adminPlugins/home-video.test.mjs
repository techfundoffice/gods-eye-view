import test from 'node:test';
import assert from 'node:assert/strict';
import plugin, { HOME_VIDEO_PLUGIN_ID, renderHomeVideoPane } from './home-video.js';
import { normalizePluginManifest } from '../adminPluginRegistry.js';
import { readFileSync } from 'node:fs';

/** Enough of a Document for the pane to build itself. */
function fakeDoc() {
  const make = (tag) => {
    const node = {
      tagName: String(tag).toUpperCase(),
      children: [],
      className: '',
      textContent: '',
      value: '',
      type: '',
      rows: 0,
      hidden: false,
      disabled: false,
      placeholder: '',
      listeners: new Map(),
      classList: { toggle() {} },
      append(...kids) { this.children.push(...kids); },
      addEventListener(name, fn) { this.listeners.set(name, fn); },
      removeEventListener(name) { this.listeners.delete(name); },
    };
    return node;
  };
  return { createElement: make };
}

function mount(client) {
  const doc = fakeDoc();
  const container = {
    ownerDocument: doc,
    children: [],
    replaceChildren(...kids) { this.children = kids; },
  };
  const cleanup = renderHomeVideoPane(container, { document: doc, client });
  return { container, cleanup, doc };
}

/** Depth-first walk of the built node tree. */
function walk(node, out = []) {
  out.push(node);
  for (const child of node.children || []) walk(child, out);
  return out;
}

const findByTag = (root, tag) => walk(root).filter((n) => n.tagName === tag);

test('the plugin satisfies the ADMIN plugin contract', () => {
  assert.equal(plugin.id, HOME_VIDEO_PLUGIN_ID);
  assert.equal(typeof plugin.render, 'function');
  assert.ok(plugin.label);
  assert.ok(plugin.description);
  assert.match(plugin.id, /^[a-z0-9][a-z0-9-]*$/);
});

test('the manifest entry is registrable', () => {
  const manifest = normalizePluginManifest(JSON.parse(readFileSync('src/adminPlugins/manifest.json', 'utf8')));
  const entry = manifest.find((item) => item.id === HOME_VIDEO_PLUGIN_ID);
  assert.ok(entry, 'home-video must survive manifest normalization');
  assert.equal(entry.module, './home-video.js');
});

test('the pane loads current settings and returns a working teardown', async () => {
  let saved = null;
  const { container, cleanup } = mount({
    homeVideo: async () => ({
      defaultVideoUrl: 'https://youtu.be/aqz-KE-bpKQ',
      defaultPlaylistUrl: '',
      approvedChannels: ['UCSMOQeBJ2RAnuFungnQOxLg'],
    }),
    saveHomeVideo: async (body) => { saved = body; return body; },
  });
  await new Promise((resolve) => setImmediate(resolve));

  const root = container.children[0];
  assert.ok(root, 'the pane mounts into the container');
  const [videoField, playlistField] = findByTag(root, 'INPUT');
  assert.equal(videoField.value, 'https://youtu.be/aqz-KE-bpKQ');
  assert.equal(findByTag(root, 'TEXTAREA')[0].value, 'UCSMOQeBJ2RAnuFungnQOxLg');
  assert.equal(playlistField.value, '');

  cleanup();
  assert.deepEqual(container.children, []);
});

test('a malformed URL is named rather than silently replaced', async () => {
  let saveCalls = 0;
  const { container } = mount({
    homeVideo: async () => ({}),
    saveHomeVideo: async (body) => { saveCalls += 1; return body; },
  });
  await new Promise((resolve) => setImmediate(resolve));

  const root = container.children[0];
  const [videoField] = findByTag(root, 'INPUT');
  const saveBtn = findByTag(root, 'BUTTON')[0];

  videoField.value = 'https://vimeo.com/12345';
  await saveBtn.listeners.get('click')();
  assert.equal(saveCalls, 0, 'a bad URL must not reach the server');
  const message = walk(root).find((n) => n.tagName === 'P' && /must be a single YouTube video/.test(n.textContent));
  assert.ok(message, 'the operator is told which field is wrong');

  videoField.value = 'https://youtu.be/aqz-KE-bpKQ';
  await saveBtn.listeners.get('click')();
  assert.equal(saveCalls, 1);
});

test('an empty approved list is called out, not glossed over', async () => {
  const { container } = mount({
    homeVideo: async () => ({}),
    saveHomeVideo: async (body) => ({ ...body, approvedChannels: [] }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  const root = container.children[0];
  await findByTag(root, 'BUTTON')[0].listeners.get('click')();
  const message = walk(root).find((n) => n.tagName === 'P' && /refused/.test(n.textContent));
  assert.ok(message, 'the operator learns recommendations cannot pass yet');
});
