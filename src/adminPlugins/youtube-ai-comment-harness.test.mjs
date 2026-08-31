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
import { isAdminUnlocked } from '../adminConsole.js';
import {
  createYoutubeCommentHarness,
  HARNESS_LABEL,
  harnessOperatorStatus,
  toolIsolationState,
} from '../youtubeCommentHarness.js';
import youtubeCommentHarnessPlugin, {
  renderYoutubeCommentHarnessPane,
} from './youtube-ai-comment-harness.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));

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
    if (name === 'aria-pressed') this.attrs['aria-pressed'] = String(value);
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
    return this.tagName === selector.toLowerCase();
  }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn) {
    this.listeners[type] = (this.listeners[type] || []).filter((entry) => entry !== fn);
  }
  click() {
    return Promise.all((this.listeners.click || []).map((fn) => fn({ type: 'click', target: this })));
  }
  change() {
    return Promise.all((this.listeners.change || []).map((fn) => fn({ type: 'change', target: this })));
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

test('the shipped manifest lists Youtube AI Comment Harness with a safe module', () => {
  const raw = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));
  const entries = normalizePluginManifest(raw);
  const entry = entries.find((item) => item.id === 'youtube-ai-comment-harness');
  assert.ok(entry, 'manifest must register youtube-ai-comment-harness');
  assert.equal(entry.label, 'Youtube AI Comment Harness');
  assert.equal(entry.module, './youtube-ai-comment-harness.js');
});

test('the plugin default export satisfies the ADMIN plugin contract', () => {
  const adopted = adoptPluginModule({ default: youtubeCommentHarnessPlugin }, {
    id: 'youtube-ai-comment-harness',
    label: 'Youtube AI Comment Harness',
    description: '',
  });
  assert.ok(adopted);
  assert.equal(adopted.id, 'youtube-ai-comment-harness');
  assert.equal(adopted.label, HARNESS_LABEL);
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
  const plugin = plugins.find((item) => item.id === 'youtube-ai-comment-harness');
  assert.ok(plugin);
  assert.equal(plugin.label, 'Youtube AI Comment Harness');
  assert.equal(typeof plugin.render, 'function');
});

test('locked ADMIN is not unlocked and does not treat generated plugins as core chrome', () => {
  assert.equal(isAdminUnlocked({ configured: true, authenticated: false }), false);
  const consoleSource = fs.readFileSync(path.join(DIR, '..', 'adminConsole.js'), 'utf8');
  assert.match(consoleSource, /async _loadMenu\(\) \{\n {4}if \(!isAdminUnlocked\(this\.state\.session\)\) return;/);
  assert.doesNotMatch(consoleSource, /Youtube AI Comment Harness/);
});

test('plugin pane paints controls, counters, and lists', () => {
  const document = makeDocument();
  const container = document.createElement('div');
  const harness = createYoutubeCommentHarness({
    supportsToolIsolation: true,
    interpret: async () => ({ kind: 'reject', reason: 'no', confidence: 0 }),
    runner: async () => ({ ok: true }),
  });
  const cleanup = renderYoutubeCommentHarnessPane(container, { document, harness, supportsToolIsolation: true });
  assert.equal(container.querySelector('#ych-enabled').textContent, 'ENABLE');
  assert.equal(container.querySelector('#ych-stop').textContent, 'STOP / CANCEL');
  assert.ok(container.querySelector('#ych-source'));
  assert.ok(container.querySelector('#ych-video'));
  assert.ok(container.querySelector('#ych-status'));
  assert.ok(container.querySelector('#ych-connection'));
  assert.equal(container.querySelector('#ych-received').textContent, '0');
  assert.equal(container.querySelector('#ych-displayed').textContent, '0');
  assert.equal(container.querySelector('#ych-accepted').textContent, '0');
  assert.equal(container.querySelector('#ych-rejected').textContent, '0');
  assert.equal(container.querySelector('#ych-rate-limited').textContent, '0');
  assert.equal(container.querySelector('#ych-failed').textContent, '0');
  assert.match(container.textContent, /Youtube AI Comment Harness/);
  cleanup();
});

test('unsafe adapter stays explained on the pane after disconnected YouTube refresh', async () => {
  const isolation = toolIsolationState(false, true);
  const document = makeDocument();
  const container = document.createElement('div');
  let statusCalls = 0;
  const cleanup = renderYoutubeCommentHarnessPane(container, {
    document,
    supportsToolIsolation: false,
    youtubeSource: {
      async status() {
        statusCalls += 1;
        return { connected: false, configured: true };
      },
      async listVideos() { return []; },
    },
    nextChat: {
      queue: [],
      available: () => true,
      publish: () => ({ ok: true }),
      setStatus() {},
    },
    interpret: async () => { throw new Error('must not start an agent session'); },
    runner: async () => { throw new Error('must not run'); },
  });
  const api = container.__gevYoutubeCommentHarness;
  assert.ok(api, 'plugin must expose the harness API');
  const snap = await api.refreshYoutube();
  assert.ok(statusCalls >= 1, 'plugin mount must refresh YouTube status');
  assert.equal(snap.isolationOk, false);
  assert.equal(snap.enabled, false);
  assert.equal(snap.connection, 'disconnected');
  const status = container.querySelector('#ych-status').textContent;
  assert.equal(status, harnessOperatorStatus(snap));
  assert.equal(status, `DISABLED · ${isolation.reason}`);
  assert.match(status, /tool-less/i);
  assert.doesNotMatch(status, /YOUTUBE DISCONNECTED/);
  assert.match(container.querySelector('#ych-connection').textContent, /YOUTUBE DISCONNECTED/);
  assert.equal(container.querySelector('#ych-enabled').disabled, true);
  cleanup();
});

test('unsafe adapter stays explained on the pane after unavailable YouTube refresh', async () => {
  const isolation = toolIsolationState(false, true);
  const document = makeDocument();
  const container = document.createElement('div');
  const cleanup = renderYoutubeCommentHarnessPane(container, {
    document,
    supportsToolIsolation: false,
    youtubeSource: {
      async status() {
        return { connected: false, configured: false };
      },
      async listVideos() { return []; },
    },
    nextChat: {
      queue: [],
      available: () => true,
      publish: () => ({ ok: true }),
      setStatus() {},
    },
    interpret: async () => { throw new Error('must not start an agent session'); },
    runner: async () => { throw new Error('must not run'); },
  });
  const api = container.__gevYoutubeCommentHarness;
  const snap = await api.refreshYoutube();
  assert.equal(snap.isolationOk, false);
  assert.equal(snap.enabled, false);
  assert.equal(snap.connection, 'unavailable');
  const status = container.querySelector('#ych-status').textContent;
  assert.equal(status, `DISABLED · ${isolation.reason}`);
  assert.match(status, /tool-less/i);
  assert.doesNotMatch(status, /YOUTUBE UNAVAILABLE/);
  assert.match(container.querySelector('#ych-connection').textContent, /YOUTUBE UNAVAILABLE/);
  assert.equal(container.querySelector('#ych-enabled').disabled, true);
  cleanup();
});

test('unconfigured unsafe adapter names both reasons on STATUS', () => {
  const isolation = toolIsolationState(false, false);
  const document = makeDocument();
  const container = document.createElement('div');
  const cleanup = renderYoutubeCommentHarnessPane(container, {
    document,
    supportsToolIsolation: false,
    configured: false,
    interpret: async () => { throw new Error('must not start an agent session'); },
    runner: async () => { throw new Error('must not run'); },
  });
  const status = container.querySelector('#ych-status').textContent;
  assert.equal(status, `DISABLED · ${isolation.reason}`);
  assert.match(status, /not configured/i);
  assert.match(status, /tool-less/i);
  assert.equal(container.querySelector('#ych-enabled').disabled, true);
  cleanup();
});

test('plugin render returns cleanup that stops pending work', async () => {
  let resolveIntent;
  const runnerCalls = [];
  const harness = createYoutubeCommentHarness({
    supportsToolIsolation: true,
    now: () => 10_000,
    interpret: () => new Promise((resolve) => { resolveIntent = resolve; }),
    runner: async (...args) => { runnerCalls.push(args); return { ok: true }; },
    nextChat: {
      queue: [],
      available: () => true,
      publish: () => ({ ok: true }),
      setStatus() {},
    },
  });
  const document = makeDocument();
  const container = document.createElement('div');
  const { cleanup, error } = mountPlugin(youtubeCommentHarnessPlugin, container, {
    document,
    harness,
    supportsToolIsolation: true,
  });
  assert.equal(error, '');
  harness.setEnabled(true);
  const pending = harness.ingest([{ id: 'one', author: 'Ada', text: '#Task zoom to the globe' }]);
  for (let i = 0; i < 10 && typeof resolveIntent !== 'function'; i += 1) await Promise.resolve();
  assert.equal(typeof resolveIntent, 'function');
  cleanup();
  resolveIntent({
    kind: 'view_request',
    intent: { action: 'zoom_to_globe', args: {} },
    reason: 'late',
    confidence: 1,
  });
  await pending;
  assert.equal(runnerCalls.length, 0);
  assert.equal(container.children.length, 0);
});

test('stop/cancel and disable halt the harness from the painted controls', async () => {
  const document = makeDocument();
  const container = document.createElement('div');
  const harness = createYoutubeCommentHarness({
    supportsToolIsolation: true,
    interpret: async () => ({
      kind: 'view_request',
      intent: { action: 'zoom_to_globe', args: {} },
      reason: 'Globe',
      confidence: 0.9,
    }),
    runner: async () => ({ ok: true }),
    nextChat: {
      queue: [],
      available: () => true,
      publish: () => ({ ok: true }),
      setStatus() {},
    },
  });
  renderYoutubeCommentHarnessPane(container, { document, harness, supportsToolIsolation: true });
  await container.querySelector('#ych-enabled').click();
  assert.equal(harness.getSnapshot().enabled, true);
  await container.querySelector('#ych-stop').click();
  assert.equal(harness.getSnapshot().enabled, false);
  assert.match(harness.getSnapshot().status, /STOPPED|DISABLED|cancelled/i);
});
