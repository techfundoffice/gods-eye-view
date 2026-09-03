import assert from 'node:assert/strict';
import test from 'node:test';
import { guardPhotorealRendering } from './photorealRuntimeGuard.js';

function eventDouble() {
  let listener = null;
  return {
    event: {
      addEventListener(callback) {
        listener = callback;
        return () => { listener = null; };
      },
    },
    raise(value) { listener?.(value); },
  };
}

test('falls back to OSM when Google resolves but never renders a tile', async () => {
  const visible = eventDouble();
  const failed = eventDouble();
  let timeout = null;
  const stacks = [];
  const tileset = { tileVisible: visible.event, tileFailed: failed.event };
  const controller = {
    getActiveId: () => stacks.at(-1) || 'photoreal',
    async setStack(id) { stacks.push(id); return { activeId: id }; },
  };
  let renders = 0;

  guardPhotorealRendering({
    tileset,
    mapStackController: controller,
    viewer: { scene: { requestRender: () => { renders += 1; } } },
    setTimeoutFn: (callback) => { timeout = callback; return 1; },
    clearTimeoutFn: () => {},
  });

  timeout();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(stacks, ['osm']);
  assert.equal(renders, 1);
});

test('keeps Google 3D when a tile reaches the renderer', async () => {
  const visible = eventDouble();
  const failed = eventDouble();
  let timeout = null;
  const stacks = [];
  guardPhotorealRendering({
    tileset: { tileVisible: visible.event, tileFailed: failed.event },
    mapStackController: {
      getActiveId: () => 'photoreal',
      async setStack(id) { stacks.push(id); },
    },
    viewer: { scene: {} },
    setTimeoutFn: (callback) => { timeout = callback; return 1; },
    clearTimeoutFn: () => {},
  });

  visible.raise({});
  timeout();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(stacks, []);
});