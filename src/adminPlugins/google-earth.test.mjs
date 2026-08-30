import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  adoptPluginModule,
  createPluginRegistry,
  mountPlugin,
  normalizePluginManifest,
} from '../adminPluginRegistry.js';
import { MapStackController } from '../mapStackController.js';
import googleEarthPlugin, {
  GOOGLE_EARTH_STATUS,
  enableGoogleEarth,
  getGoogleEarthStatus,
  renderGoogleEarthPane,
} from './google-earth.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));

/** Tiny DOM used to drive the shipped plugin render — not a browser. */
class Node {
  constructor(tagName = 'div') {
    this.tagName = String(tagName).toLowerCase();
    this.children = [];
    this.parentNode = null;
    this.attrs = {};
    this._text = '';
    this._hidden = false;
    this._dataset = {};
    this.listeners = {};
    this.disabled = false;
    this.ownerDocument = null;
    this.id = '';
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
        return true;
      },
      get: (target, key) => target[key],
    });
  }

  get textContent() {
    if (this.children.length) return this.children.map((child) => child.textContent).join('');
    return this._text;
  }
  set textContent(value) {
    this._text = String(value ?? '');
    this.children = [];
  }
  get hidden() { return this._hidden; }
  set hidden(value) { this._hidden = Boolean(value); }

  setAttribute(name, value) {
    this.attrs[name] = String(value);
    if (name === 'id') this.id = String(value);
  }
  getAttribute(name) {
    if (name === 'id') return this.id || this.attrs.id || null;
    return this.attrs[name] ?? null;
  }
  append(...nodes) { for (const node of nodes) this.appendChild(node); }
  appendChild(node) {
    node.parentNode = this;
    this.children.push(node);
    return node;
  }
  replaceChildren(...nodes) {
    this.children = [];
    for (const node of nodes) this.appendChild(node);
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
  matches(selector) {
    if (selector.startsWith('#')) return this.id === selector.slice(1) || this.attrs.id === selector.slice(1);
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
    return this.tagName === selector.toLowerCase();
  }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn) {
    this.listeners[type] = (this.listeners[type] || []).filter((entry) => entry !== fn);
  }
  click() {
    return Promise.all((this.listeners.click || []).map((fn) => fn({ type: 'click', target: this })));
  }
}

function makeDocument() {
  const document = {
    createElement(tag) {
      const node = new Node(tag);
      node.ownerDocument = document;
      return node;
    },
  };
  return document;
}

test('the shipped manifest lists Google Earth with a safe in-directory module', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));
  const entries = normalizePluginManifest(raw);
  const entry = entries.find((item) => item.id === 'google-earth');
  assert.ok(entry, 'manifest must register google-earth');
  assert.equal(entry.label, 'Google Earth');
  assert.equal(entry.module, './google-earth.js');
});

test('the plugin default export satisfies the ADMIN plugin contract', () => {
  const adopted = adoptPluginModule({ default: googleEarthPlugin }, {
    id: 'google-earth',
    label: 'Google Earth',
    description: '',
  });
  assert.ok(adopted);
  assert.equal(adopted.id, 'google-earth');
  assert.equal(adopted.label, 'Google Earth');
  assert.equal(typeof adopted.render, 'function');
});

test('the real plugin module loads through the registry contract', async () => {
  const registry = createPluginRegistry({
    loadManifest: () => JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8')),
    importModule: (url) => import(url),
    base: `${pathToFileURL(DIR).href}/`,
  });
  const { plugins, errors } = await registry.load();
  assert.deepEqual(errors, []);
  const plugin = plugins.find((item) => item.id === 'google-earth');
  assert.ok(plugin);
  assert.equal(typeof plugin.render, 'function');
});

test('plugin render reports KEY REQUIRED and does not claim displaying', () => {
  const document = makeDocument();
  const container = document.createElement('div');
  const cleanup = renderGoogleEarthPane(container, {
    document,
    readRuntime: () => ({ googleApiKey: '', tileset: null, activeStackId: 'osm' }),
  });
  const status = container.querySelector('#admin-google-earth-status');
  assert.equal(status.dataset.googleEarthState, GOOGLE_EARTH_STATUS.KEY_REQUIRED);
  assert.match(status.textContent, /KEY REQUIRED/);
  assert.equal(container.querySelector('#admin-google-earth-show').disabled, true);
  assert.match(container.textContent, /DisplayingNO|Displaying\s*NO/);
  cleanup();
});

test('plugin render reports LOAD FAILED when the keyed tileset is missing', () => {
  const document = makeDocument();
  const container = document.createElement('div');
  renderGoogleEarthPane(container, {
    document,
    readRuntime: () => ({
      googleApiKey: 'AIzaSy-test-key',
      tileset: null,
      activeStackId: 'osm',
      loadError: 'status 403',
    }),
  });
  const status = container.querySelector('#admin-google-earth-status');
  assert.equal(status.dataset.googleEarthState, GOOGLE_EARTH_STATUS.LOAD_FAILED);
  assert.match(status.textContent, /LOAD FAILED/);
  assert.doesNotMatch(status.textContent, /DISPLAYING · Google Photorealistic/);
});

test('SHOW GOOGLE EARTH drives shipped enablement onto the photoreal stack', async () => {
  const document = makeDocument();
  const container = document.createElement('div');
  const viewer = {
    scene: { globe: { show: true }, requestRender() {} },
    imageryLayers: { add() {}, remove() {} },
  };
  const tileset = { show: false, isDestroyed: () => false };
  const controller = new MapStackController(viewer, {
    googleTileset: tileset,
    cesiumToken: '',
    initialStack: 'osm',
  });
  const runtime = {
    googleApiKey: 'AIzaSy-test-key',
    tileset,
    mapStackController: controller,
    viewer,
    activeStackId: controller.getActiveId(),
    globeShown: true,
  };

  const { cleanup, error } = mountPlugin(googleEarthPlugin, container, {
    document,
    readRuntime: () => ({
      ...runtime,
      activeStackId: controller.getActiveId(),
      globeShown: viewer.scene.globe.show,
    }),
    enable: enableGoogleEarth,
  });
  assert.equal(error, '');

  const before = getGoogleEarthStatus({
    googleApiKey: runtime.googleApiKey,
    tileset,
    activeStackId: controller.getActiveId(),
    globeShown: viewer.scene.globe.show,
  });
  assert.equal(before.displaying, false);

  const button = container.querySelector('#admin-google-earth-show');
  assert.equal(button.disabled, false);
  await button.click();

  assert.equal(controller.getActiveId(), 'photoreal');
  assert.equal(tileset.show, true);
  assert.equal(viewer.scene.globe.show, false);
  const status = container.querySelector('#admin-google-earth-status');
  assert.equal(status.dataset.googleEarthState, GOOGLE_EARTH_STATUS.DISPLAYING);
  assert.match(status.textContent, /DISPLAYING/);
  cleanup();
});
