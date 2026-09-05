import test from 'node:test';
import assert from 'node:assert/strict';
import { maybeRunGlobeAction, initHermesBoxChat } from './hermesBoxChat.js';

test('maybeRunGlobeAction executes slash commands via injected runner', async () => {
  const calls = [];
  const runner = async (name, args) => {
    calls.push({ name, args });
    return { ok: true, name };
  };

  const flyResult = await maybeRunGlobeAction('/fly Tokyo', {}, runner);
  assert.equal(flyResult?.ok, true);
  assert.equal(flyResult?.command, '/fly');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'fly_to_location');
  assert.equal(calls[0].args.query, 'Tokyo');
  assert.equal(calls[0].args.waitForArrival, true);

  const styleResult = await maybeRunGlobeAction('/style-thermal', {}, runner);
  assert.equal(styleResult?.ok, true);
  assert.equal(calls[1].name, 'set_visual_style');
  assert.equal(calls[1].args.style, 'thermal');
});

test('maybeRunGlobeAction executes natural language navigation', async () => {
  const calls = [];
  const runner = async (name, args) => {
    calls.push({ name, args });
    return { ok: true, name };
  };

  const navResult = await maybeRunGlobeAction('fly to Paris', {}, runner);
  assert.equal(navResult?.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'fly_to_location');
  assert.equal(calls[0].args.query, 'Paris');

  const globeResult = await maybeRunGlobeAction('show whole globe', {}, runner);
  assert.equal(globeResult?.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].name, 'zoom_to_globe');
});

test('maybeRunGlobeAction handles natural language layer toggling', async () => {
  const calls = [];
  const runner = async (name, args) => {
    calls.push({ name, args });
    return { ok: true, name };
  };

  await maybeRunGlobeAction('enable earthquakes', {}, runner);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'set_layer_visibility');
  assert.equal(calls[0].args.layerId, 'earthquakes');
  assert.equal(calls[0].args.enabled, true);

  await maybeRunGlobeAction('turn off flights', {}, runner);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].name, 'set_layer_visibility');
  assert.equal(calls[1].args.layerId, 'flights');
  assert.equal(calls[1].args.enabled, false);
});

test('initHermesBoxChat binds runner and exposes setRunner when DOM elements exist', () => {
  const mockStorage = {
    getItem: () => null,
    setItem: () => {},
  };
  const makeEl = (id = '') => ({
    id,
    dataset: {},
    classList: { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false },
    setAttribute: () => {},
    getAttribute: () => null,
    append: () => {},
    addEventListener: () => {},
    querySelector: () => null,
    querySelectorAll: () => [],
    style: {},
  });

  const elements = {
    'hermes-agent-card': makeEl('hermes-agent-card'),
    'hermes-box-chat': makeEl('hermes-box-chat'),
    'hermes-box-thread': makeEl('hermes-box-thread'),
    'hermes-box-empty': makeEl('hermes-box-empty'),
    'hermes-box-input': makeEl('hermes-box-input'),
    'hermes-box-send': makeEl('hermes-box-send'),
  };

  const mockDoc = {
    getElementById: (id) => elements[id] || makeEl(id),
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (tag) => makeEl(tag),
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  const mockWindow = {
    setTimeout: (fn) => setTimeout(fn, 0),
    clearTimeout: (id) => clearTimeout(id),
  };

  const chat = initHermesBoxChat({
    documentRef: mockDoc,
    windowRef: mockWindow,
    storage: mockStorage,
  });

  assert.ok(chat);
  assert.equal(typeof chat.setRunner, 'function');
  assert.equal(typeof chat.ask, 'function');
});
