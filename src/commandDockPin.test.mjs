// src/commandDockPin.test.mjs
//
// LOCATION and VISUAL PRESETS start PINNED+expanded on a first run. An explicit
// stored unpin/collapse or a share-link panel field still wins. The pin control
// remains the unpin path.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  ALWAYS_VISIBLE_DOCK_PANEL_IDS,
  COMMAND_DOCK_PINNABLE_PANEL_IDS,
  pinCommandDockPanel,
  resolveCommandDockPin,
  restoreCommandDockPinDefaults,
} from './commandDockPin.js';
import { decodePanelStateParams } from './sharelink.js';

const uiSource = fs.readFileSync(new URL('./ui.js', import.meta.url), 'utf8');
const indexHtml = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const pinSource = fs.readFileSync(new URL('./commandDockPin.js', import.meta.url), 'utf8');

function openTag(html, id) {
  const match = html.match(new RegExp(`<div id="${id}"[^>]*>`));
  assert.ok(match, `missing #${id}`);
  return match[0];
}

function pinButtonMarkup(html, panelId) {
  const match = html.match(new RegExp(`<button class="dock-pin-btn" data-pin-target="${panelId}"[^>]*>`));
  assert.ok(match, `missing pin control for ${panelId}`);
  return match[0];
}

test('first-run pin policy pins only when nothing is stored', () => {
  assert.deepEqual([...COMMAND_DOCK_PINNABLE_PANEL_IDS], ['control-panel', 'location-bar']);
  assert.deepEqual([...ALWAYS_VISIBLE_DOCK_PANEL_IDS], ['control-panel']);
  assert.equal(resolveCommandDockPin(null, null), true, 'empty store is PINNED');
  assert.equal(resolveCommandDockPin('1', '1'), true, 'stored pin wins over collapse');
  assert.equal(resolveCommandDockPin('0', '0'), false, 'stored unpin wins over expand');
  assert.equal(resolveCommandDockPin(null, '1'), false, 'stored collapse is not re-forced open');
  assert.equal(resolveCommandDockPin(null, '0'), false, 'stored expand without a pin is not force-pinned');
  assert.equal(resolveCommandDockPin('0', '1', 'control-panel'), true, 'Visual Presets stay open over stored hide');
  assert.equal(resolveCommandDockPin('0', '0', 'location-bar'), false, 'LOCATION still honours stored unpin');
});

test('markup ships LOCATION and VISUAL PRESETS PINNED and expanded', () => {
  const location = openTag(indexHtml, 'location-bar');
  assert.match(location, /\bdock-pinned\b/);
  assert.doesNotMatch(location, /\bcollapsed\b/);
  assert.match(pinButtonMarkup(indexHtml, 'location-bar'), /aria-pressed="true"/);

  const presets = openTag(indexHtml, 'control-panel');
  assert.match(presets, /\bdock-pinned\b/);
  assert.doesNotMatch(presets, /\bcollapsed\b/);
  assert.match(pinButtonMarkup(indexHtml, 'control-panel'), /aria-pressed="true"/);
  assert.match(
    indexHtml,
    /id="control-panel-toggle"[^>]*aria-expanded="true"/,
    'Visual Presets disclosure starts expanded',
  );
});

test('ui.js init/restore/unpin still call the shipped pin functions', () => {
  assert.match(uiSource, /this\._restoreCommandDockPinDefaults\(\);/);
  assert.match(uiSource, /restoreCommandDockPinDefaults\(\{/);
  assert.match(uiSource, /pinCommandDockPanel\(\{/);
  assert.match(
    uiSource,
    /document\.querySelectorAll\('\.dock-pin-btn\[data-pin-target\]'\)\.forEach\(\(button\) => \{[\s\S]*?this\._setCommandDockPanelPinState\(panelId\);/,
    'unpin still goes through the existing pin toggle',
  );
  assert.match(uiSource, /savePin: \(pinned\) => this\._savePanelPinState\(panelId, pinned\)/);
  assert.match(
    uiSource,
    /if \(COMMAND_DOCK_PINNABLE_PANEL_IDS\.includes\(panelId\) && stored === null\) \{\s*collapsed = false;/,
  );
  assert.match(
    uiSource,
    /const pinned = spec\.pinnable\s*\? \(typeof state\.pinned === 'boolean' \? state\.pinned : !state\.collapsed\)\s*: false;/,
  );
  assert.match(pinSource, /if \(persist !== false\) savePin\?\.\(shouldPin\);/);
});

class MiniNode {
  constructor(tagName = 'div') {
    this.tagName = String(tagName).toLowerCase();
    this.children = [];
    this.parentNode = null;
    this.attrs = {};
    this._dataset = {};
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
  }

  get id() { return this.attrs.id || ''; }
  set id(value) { this.attrs.id = String(value); }

  setAttribute(name, value) {
    this.attrs[name] = String(value);
  }
  getAttribute(name) { return this.attrs[name] ?? null; }

  appendChild(node) {
    node.parentNode = this;
    this.children.push(node);
    return node;
  }

  matches(selector) {
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    if (selector.startsWith('.')) {
      return selector.slice(1).split('.').every((name) => this.classList.contains(name));
    }
    return false;
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
    if (this.matches(selector)) found.push(this);
    visit(this);
    return found;
  }
}

function mini(tag, attrs = {}, children = []) {
  const node = new MiniNode(tag);
  if (attrs.id) node.id = attrs.id;
  if (attrs.className) {
    for (const name of String(attrs.className).split(/\s+/).filter(Boolean)) {
      node.classList.add(name);
    }
  }
  if (attrs['aria-pressed'] != null) node.setAttribute('aria-pressed', attrs['aria-pressed']);
  for (const child of children) node.appendChild(child);
  return node;
}

function makeDockTree() {
  const presetsPin = mini('button', { className: 'dock-pin-btn', 'aria-pressed': 'true' });
  const locationPin = mini('button', { className: 'dock-pin-btn', 'aria-pressed': 'true' });
  const presets = mini('div', { id: 'control-panel', className: 'panel-collapsible dock-pinned' }, [presetsPin]);
  const location = mini('div', { id: 'location-bar', className: 'panel-collapsible dock-pinned' }, [locationPin]);
  const dock = mini('div', { id: 'command-dock' }, [presets, location]);
  return { dock, presets, location, presetsPin, locationPin };
}

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    read: (key) => (map.has(key) ? map.get(key) : null),
  };
}

function pinKey(id) { return `godsEyeView.v6.panelPinned.${id}`; }
function collapseKey(id) { return `godsEyeView.v6.panelCollapsed.${id}`; }

function attachHost(tree, storage) {
  const panels = {
    'control-panel': { panel: tree.presets, button: tree.presetsPin },
    'location-bar': { panel: tree.location, button: tree.locationPin },
  };
  const setCollapsed = (panelId, collapsed, { persist } = {}) => {
    panels[panelId].panel.classList.toggle('collapsed', collapsed);
    if (persist !== false) storage.setItem(collapseKey(panelId), collapsed ? '1' : '0');
  };
  const setPin = (panelId, pin, options = {}) => pinCommandDockPanel({
    panelEl: panels[panelId].panel,
    button: panels[panelId].button,
    dock: tree.dock,
    pin,
    restore: options.restore,
    persist: options.persist,
    hovering: false,
    setCollapsed: (collapsed, flags) => setCollapsed(panelId, collapsed, flags),
    savePin: (pinned) => storage.setItem(pinKey(panelId), pinned ? '1' : '0'),
  });
  return {
    setPin,
    restoreDefaults(shareById = null, allowStored = true) {
      restoreCommandDockPinDefaults({
        shareById,
        allowStored,
        readPin: (panelId) => storage.getItem(pinKey(panelId)),
        readCollapse: (panelId) => storage.getItem(collapseKey(panelId)),
        setPin,
        restoreCollapse: (panelId, { allowStored: allow } = {}) => {
          const stored = allow ? storage.getItem(collapseKey(panelId)) : null;
          let collapsed = panels[panelId].panel.classList.contains('collapsed');
          if (stored === '1') collapsed = true;
          if (stored === '0') collapsed = false;
          if (stored === null) collapsed = false;
          panels[panelId].panel.classList.toggle('collapsed', collapsed);
        },
      });
    },
  };
}

function snapshot(panel, pin) {
  return {
    pinned: panel.classList.contains('dock-pinned'),
    collapsed: panel.classList.contains('collapsed'),
    pressed: pin.getAttribute('aria-pressed'),
  };
}

test('a first run with no stored prefs and no share ui pins both trays open', () => {
  const tree = makeDockTree();
  const host = attachHost(tree, memoryStorage());
  host.restoreDefaults(null, true);
  assert.deepEqual(snapshot(tree.location, tree.locationPin), {
    pinned: true, collapsed: false, pressed: 'true',
  });
  assert.deepEqual(snapshot(tree.presets, tree.presetsPin), {
    pinned: true, collapsed: false, pressed: 'true',
  });
});

test('unpinning one tray leaves it not forced-open and does not change the other pin', () => {
  const tree = makeDockTree();
  const storage = memoryStorage();
  const host = attachHost(tree, storage);
  host.restoreDefaults(null, true);
  host.setPin('location-bar');
  assert.equal(tree.location.classList.contains('dock-pinned'), false);
  assert.equal(tree.location.classList.contains('collapsed'), true);
  assert.equal(tree.locationPin.getAttribute('aria-pressed'), 'false');
  assert.equal(tree.presets.classList.contains('dock-pinned'), true);
  assert.equal(tree.presets.classList.contains('collapsed'), false);
  assert.equal(storage.read(pinKey('location-bar')), '0');
  assert.equal(storage.read(collapseKey('location-bar')), '1');
  assert.equal(storage.read(pinKey('control-panel')), null);
});

test('stored unpin cannot hide Visual Presets', () => {
  const tree = makeDockTree();
  const storage = memoryStorage({
    [pinKey('control-panel')]: '0',
    [collapseKey('control-panel')]: '1',
  });
  const host = attachHost(tree, storage);
  host.restoreDefaults(null, true);
  assert.equal(tree.presets.classList.contains('dock-pinned'), true);
  assert.equal(tree.presets.classList.contains('collapsed'), false);
});

test('a stored unpin/collapse still wins over the first-run pin default', () => {
  const tree = makeDockTree();
  const storage = memoryStorage({
    [pinKey('location-bar')]: '0',
    [collapseKey('location-bar')]: '1',
  });
  const host = attachHost(tree, storage);
  host.restoreDefaults(null, true);
  assert.equal(tree.location.classList.contains('dock-pinned'), false);
  assert.equal(tree.location.classList.contains('collapsed'), true);
  assert.equal(tree.locationPin.getAttribute('aria-pressed'), 'false');
  assert.equal(tree.presets.classList.contains('dock-pinned'), true);
  assert.equal(tree.presets.classList.contains('collapsed'), false);
  assert.equal(tree.presetsPin.getAttribute('aria-pressed'), 'true');
});

test('a share-link unpinned/collapsed field still wins over the first-run pin default', () => {
  const tree = makeDockTree();
  const storage = memoryStorage();
  const host = attachHost(tree, storage);
  const panelState = decodePanelStateParams(new URLSearchParams('v=2&ui=l.c.1_l.p.0_c.c.1_c.p.0'));
  assert.ok(panelState, 'share ui state must decode');
  const shareById = new Map(panelState.specs.map((spec) => [spec.id, spec]));
  const pinCalls = [];
  restoreCommandDockPinDefaults({
    shareById,
    allowStored: false,
    readPin: () => { throw new Error('share restore must not read stored pin'); },
    readCollapse: () => { throw new Error('share restore must not read stored collapse'); },
    setPin: (panelId, pin) => pinCalls.push([panelId, pin]),
    restoreCollapse: () => { throw new Error('share restore must not apply stored collapse'); },
  });
  assert.deepEqual(pinCalls, [['control-panel', true]], 'Visual Presets stay pinned even when share ui hides them');

  for (const spec of panelState.specs) {
    const pinned = typeof spec.pinned === 'boolean' ? spec.pinned : !spec.collapsed;
    host.setPin(spec.id, pinned, { restore: true, persist: false });
    if (!pinned && spec.id !== 'control-panel') {
      const panel = spec.id === 'location-bar' ? tree.location : tree.presets;
      panel.classList.toggle('collapsed', spec.collapsed);
    }
  }
  assert.equal(tree.location.classList.contains('dock-pinned'), false);
  assert.equal(tree.location.classList.contains('collapsed'), true);
  assert.equal(tree.locationPin.getAttribute('aria-pressed'), 'false');
  assert.equal(tree.presets.classList.contains('dock-pinned'), true);
  assert.equal(tree.presets.classList.contains('collapsed'), false);
  assert.equal(tree.presetsPin.getAttribute('aria-pressed'), 'true');
  assert.equal(storage.read(pinKey('location-bar')), null, 'share restore must not persist over local prefs');
  assert.equal(storage.read(pinKey('control-panel')), null);
});
