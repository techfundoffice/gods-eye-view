import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPluginRegistry, mountPlugin, normalizePluginManifest } from '../adminPluginRegistry.js';
import { isAdminUnlocked } from '../adminConsole.js';
import youtubeGoLivePlugin, {
  renderYoutubeGoLivePane,
  sharedLiveVideoFromSession,
  STUDIO_GO_LIVE_URL,
  YOUTUBE_GO_LIVE_LABEL,
  YOUTUBE_GO_LIVE_PLUGIN_ID,
} from './youtube-go-live.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));

class Node {
  constructor(tagName = 'div') {
    this.tagName = String(tagName).toLowerCase();
    this.children = [];
    this.parentNode = null;
    this.attrs = {};
    this._text = '';
    this._hidden = false;
    this.listeners = {};
    this.disabled = false;
    this.value = '';
    this.selected = false;
    this.ownerDocument = null;
    this.id = '';
    this.className = '';
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
    this.dataset = {};
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
    node.ownerDocument = this.ownerDocument;
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
    if (selector.startsWith('[data-live-phase')) {
      const value = selector.match(/data-live-phase="([^"]+)"/)?.[1];
      return value ? this.dataset.livePhase === value : Boolean(this.dataset.livePhase);
    }
    return this.tagName === selector.toLowerCase();
  }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn) {
    this.listeners[type] = (this.listeners[type] || []).filter((entry) => entry !== fn);
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

test('manifest registers YouTube Go Live as an ADMIN plugin', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));
  const plugins = normalizePluginManifest(raw);
  const entry = plugins.find((item) => item.id === YOUTUBE_GO_LIVE_PLUGIN_ID);
  assert.ok(entry);
  assert.equal(entry.label, YOUTUBE_GO_LIVE_LABEL);
  assert.equal(entry.module, './youtube-go-live.js');
});

test('plugin module loads through the registry', async () => {
  const registry = createPluginRegistry({
    loadManifest: async () => JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8')),
    importModule: (url) => import(url),
    base: `${pathToFileURL(DIR).href}/`,
  });
  const { plugins, errors } = await registry.load();
  assert.deepEqual(errors, []);
  const plugin = plugins.find((item) => item.id === YOUTUBE_GO_LIVE_PLUGIN_ID);
  assert.ok(plugin);
  assert.equal(typeof plugin.render, 'function');
  assert.equal(youtubeGoLivePlugin.id, YOUTUBE_GO_LIVE_PLUGIN_ID);
});

test('locked ADMIN sees no broadcast controls', () => {
  assert.equal(isAdminUnlocked({ configured: true, authenticated: false }), false);
  const document = makeDocument();
  const container = document.createElement('div');
  const cleanup = renderYoutubeGoLivePane(container, {
    document,
    session: { configured: true, authenticated: false },
  });
  assert.ok(container.querySelector('#ygl-locked'));
  assert.equal(container.querySelector('#ygl-key'), null);
  cleanup();
});

test('unlocked pane ships Studio QR, readiness including ODBC, and start/stop', async () => {
  const document = makeDocument();
  const container = document.createElement('div');
  const calls = [];
  const cleanup = renderYoutubeGoLivePane(container, {
    document,
    session: { configured: true, authenticated: true },
    client: {
      async liveStatus() {
        calls.push('status');
        return {
          live: {
            status: 'idle',
            log: [],
            phases: {
              account: { ready: false, message: 'Sign in' },
              odbc: { ready: false, message: 'Optional audit is not configured.' },
            },
          },
        };
      },
      async listLiveBroadcasts() { return { broadcasts: [] }; },
      async startLive() { throw new Error('should not start'); },
      async stopLive() { return { live: { status: 'stopped' } }; },
    },
  });
  await Promise.resolve();
  assert.ok(container.querySelector('#ygl-studio-qr'));
  assert.equal(container.querySelector('#ygl-studio-link').href, STUDIO_GO_LIVE_URL);
  assert.ok(container.querySelector('#ygl-key'));
  assert.ok(container.querySelector('#ygl-start'));
  assert.ok(container.querySelector('#ygl-stop'));
  const phases = container.querySelectorAll('[data-live-phase]').map((row) => row.dataset.livePhase);
  for (const id of ['account', 'broadcast', 'capture', 'encoder', 'ingest', 'youtube', 'odbc']) {
    assert.ok(phases.includes(id), id);
  }
  assert.ok(calls.includes('status'));
  const mounted = mountPlugin(youtubeGoLivePlugin, container, {
    document,
    session: { configured: true, authenticated: true },
    client: {
      async liveStatus() { return { live: { status: 'idle', log: [] } }; },
      async listLiveBroadcasts() { return { broadcasts: [] }; },
    },
  });
  mounted.cleanup();
  cleanup();
});

test('shared live video identity is taken from the redacted broadcast', () => {
  const shared = sharedLiveVideoFromSession({
    broadcast: { id: 'CVSB4QJhVTU', title: 'Cloud Computer AI.com', watchUrl: 'https://www.youtube.com/watch?v=CVSB4QJhVTU' },
  });
  assert.equal(shared.id, 'CVSB4QJhVTU');
  assert.equal(sharedLiveVideoFromSession({}), null);
});
