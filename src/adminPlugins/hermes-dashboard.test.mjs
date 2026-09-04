import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  HERMES_DASHBOARD_PLUGIN_LABEL,
  hermesDashboardUrl,
  renderHermesDashboardPane,
} from './hermes-dashboard.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));

class Node {
  constructor(tagName, ownerDocument) {
    this.tagName = tagName;
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.attrs = {};
    this._text = '';
    this.href = '';
    this.target = '';
    this.rel = '';
    this.id = '';
    this.className = '';
  }

  get textContent() {
    return this.children.length ? this.children.map((child) => child.textContent).join('') : this._text;
  }

  set textContent(value) {
    this._text = String(value ?? '');
    this.children = [];
  }

  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  removeAttribute(name) { delete this.attrs[name]; }
  querySelector(selector) {
    const id = selector.startsWith('#') ? selector.slice(1) : '';
    for (const child of this.children) {
      if (id && child.id === id) return child;
      const nested = child.querySelector?.(selector);
      if (nested) return nested;
    }
    return null;
  }
}

function makeDocument() {
  const document = {
    createElement(tagName) {
      return new Node(tagName, document);
    },
  };
  return document;
}

test('manifest registers the exact Hermes dashboard ADMIN menu label', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));
  const entry = manifest.find((item) => item.id === 'hermes-dashboard');
  assert.ok(entry);
  assert.equal(entry.label, 'HERMES DASHBOARD Port 8000');
  assert.equal(entry.module, './hermes-dashboard.js');
});

test('dashboard URL keeps the current host and selects Replit port 8000', () => {
  assert.equal(
    hermesDashboardUrl({ href: 'https://example.replit.dev/admin?view=hermes#top' }),
    'https://example.replit.dev:8000/',
  );
  assert.equal(
    hermesDashboardUrl({ href: 'http://127.0.0.1:5000/admin' }),
    'http://127.0.0.1:8000/',
  );
});

test('plugin renders a safe new-tab link to the dashboard', () => {
  const document = makeDocument();
  const container = document.createElement('div');
  renderHermesDashboardPane(container, {
    document,
    location: { href: 'https://example.replit.dev/admin' },
  });
  const link = container.querySelector('#admin-hermes-dashboard-open');
  assert.ok(link);
  assert.equal(link.href, 'https://example.replit.dev:8000/');
  assert.equal(link.target, '_blank');
  assert.equal(link.rel, 'noopener noreferrer');
  assert.equal(link.textContent, 'OPEN IN A NEW TAB');
  assert.match(container.textContent, new RegExp(HERMES_DASHBOARD_PLUGIN_LABEL));
});