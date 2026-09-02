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
