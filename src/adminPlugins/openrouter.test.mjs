import assert from 'node:assert/strict';
import test from 'node:test';
import { adoptPluginModule } from '../adminPluginRegistry.js';
import openRouterPlugin, { renderOpenRouterPane } from './openrouter.js';

class Node {
  constructor(tagName = 'div') {
    this.tagName = String(tagName).toLowerCase();
    this.children = [];
    this.attrs = {};
    this._text = '';
    this._hidden = false;
    this.listeners = {};
    this.value = '';
    this.type = '';
    this.id = '';
    this.className = '';
    this.ownerDocument = null;
    this.classList = {
      names: new Set(),
      toggle: (name, force) => {
        const on = force === undefined ? !this.classList.names.has(name) : Boolean(force);
        if (on) this.classList.names.add(name);
        else this.classList.names.delete(name);
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
    if (name === 'type') this.type = String(value);
  }
  append(...nodes) { for (const node of nodes) this.appendChild(node); }
  appendChild(node) {
    this.children.push(node);
    return node;
  }
  replaceChildren(...nodes) {
    this.children = [...nodes];
  }
  addEventListener(type, fn) {
    this.listeners[type] = fn;
  }
  removeEventListener(type) {
    delete this.listeners[type];
  }
  querySelector(selector) {
    if (selector.startsWith('#')) {
      const id = selector.slice(1);
      if (this.id === id) return this;
    }
    for (const child of this.children) {
      const found = child.querySelector?.(selector);
      if (found) return found;
    }
    return null;
  }
}

function fakeDocument() {
  const doc = {
    createElement(tag) {
      const node = new Node(tag);
      node.ownerDocument = doc;
      return node;
    },
  };
  return doc;
}

test('plugin contract: id, label, render', () => {
  const adopted = adoptPluginModule(openRouterPlugin, {
    id: 'openrouter',
    label: 'OpenRouter',
    description: '',
  });
  assert.equal(adopted.id, 'openrouter');
  assert.equal(typeof adopted.render, 'function');
});

test('pane shows PRESENT and never echoes the raw key', async () => {
  const saved = [];
  const client = {
    openrouterStatus: async () => ({ present: true, source: 'admin', model: 'openrouter/free' }),
    saveOpenrouterKey: async (apiKey) => {
      saved.push(apiKey);
      return { present: true, source: 'admin', model: 'openrouter/free' };
    },
    testOpenrouter: async () => ({ ok: true, status: 200, model: 'poolside/laguna-s-2.1:free' }),
  };
  const doc = fakeDocument();
  const host = doc.createElement('div');
  const cleanup = renderOpenRouterPane(host, { document: doc, client });
  await Promise.resolve();
  await Promise.resolve();
  const text = host.textContent;
  assert.match(text, /PRESENT/);
  assert.doesNotMatch(text, /sk-or-/);
  const input = host.querySelector('#admin-openrouter-key');
  assert.equal(input.type, 'password');
  input.value = 'sk-or-v1-abcdefghijklmnopqrstuvwxyz012345';
  const form = host.querySelector('#admin-openrouter-form');
  await form.listeners.submit({ preventDefault() {} });
  assert.equal(saved[0].startsWith('sk-or-'), true);
  assert.equal(input.value, '');
  assert.doesNotMatch(host.textContent, /sk-or-v1-/);
  cleanup();
});

test('pane renders a model selector defaulting to the free router', async () => {
  const status = {
    present: true,
    source: 'admin',
    model: 'openrouter/free',
    choices: [
      { id: 'openrouter/free', label: 'Free Models Router', tier: 'free' },
      { id: 'google/gemini-2.5-flash', label: 'Gemini 2.5 Flash', tier: 'paid' },
    ],
  };
  const doc = fakeDocument();
  const host = doc.createElement('div');
  const cleanup = renderOpenRouterPane(host, {
    document: doc,
    client: {
      openrouterStatus: async () => status,
      saveOpenrouterKey: async () => status,
      saveOpenrouterModel: async () => status,
      testOpenrouter: async () => ({ ok: true, status: 200 }),
    },
  });
  await Promise.resolve();
  await Promise.resolve();

  // The regression: Model was a hardcoded <dd>, so no model was selectable.
  const select = host.querySelector('#admin-openrouter-model');
  assert.ok(select, 'a model selector must exist');
  assert.equal(select.tagName, 'select');
  assert.equal(select.children.length, 2);
  assert.equal(select.value, 'openrouter/free');
  assert.match(host.textContent, /Gemini 2\.5 Flash/);
  // Paid choices must be visibly labelled as paid.
  assert.match(host.textContent, /PAID/);
  cleanup();
});

test('choosing a model saves it and shows the effective model', async () => {
  const saved = [];
  const doc = fakeDocument();
  const host = doc.createElement('div');
  const cleanup = renderOpenRouterPane(host, {
    document: doc,
    client: {
      openrouterStatus: async () => ({
        present: true, source: 'admin', model: 'openrouter/free',
        choices: [
          { id: 'openrouter/free', label: 'Free Models Router', tier: 'free' },
          { id: 'google/gemini-2.5-flash', label: 'Gemini 2.5 Flash', tier: 'paid' },
        ],
      }),
      saveOpenrouterKey: async () => ({ present: true, model: 'openrouter/free' }),
      saveOpenrouterModel: async (model) => {
        saved.push(model);
        return { present: true, source: 'admin', model, choices: [] };
      },
      testOpenrouter: async () => ({ ok: true, status: 200 }),
    },
  });
  await Promise.resolve();
  await Promise.resolve();

  const select = host.querySelector('#admin-openrouter-model');
  select.value = 'google/gemini-2.5-flash';
  await select.listeners.change();
  assert.deepEqual(saved, ['google/gemini-2.5-flash']);
  assert.match(host.textContent, /google\/gemini-2\.5-flash/);
  cleanup();
});

test('the tier rides on the selected option itself, not just the list', async () => {
  // A collapsed <select> renders only the SELECTED option's text, so the tier
  // has to live in that text or PAID is something you scroll past rather than
  // something you see at the moment of choosing.
  const doc = fakeDocument();
  const host = doc.createElement('div');
  const cleanup = renderOpenRouterPane(host, {
    document: doc,
    client: {
      openrouterStatus: async () => ({
        present: true, source: 'admin', model: 'google/gemini-2.5-flash',
        choices: [
          { id: 'openrouter/free', label: 'Free Models Router', tier: 'free' },
          { id: 'google/gemini-2.5-flash', label: 'Gemini 2.5 Flash', tier: 'paid' },
        ],
      }),
      saveOpenrouterKey: async () => ({ present: true }),
      saveOpenrouterModel: async () => ({ present: true }),
      testOpenrouter: async () => ({ ok: true, status: 200 }),
    },
  });
  await Promise.resolve();
  await Promise.resolve();

  const select = host.querySelector('#admin-openrouter-model');
  const chosen = select.children.find((option) => option.value === select.value);
  assert.ok(chosen, 'the stored model must be the selected option');
  assert.equal(chosen.selected, true);
  assert.match(chosen.textContent, /PAID/, 'the selected option must carry its tier');
  assert.match(chosen.textContent, /Gemini 2\.5 Flash/);

  const free = select.children.find((option) => option.value === 'openrouter/free');
  assert.match(free.textContent, /FREE/);
  cleanup();
});
