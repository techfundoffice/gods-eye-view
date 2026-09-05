import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyHermesTask,
  createHermesTaskLogoController,
  HERMES_TASK_LOGO_EVENT,
  resolveHermesExpression,
} from './hermesTaskLogo.js';

test('Hermes task text is bounded and maps to allowlisted expression categories', () => {
  assert.equal(classifyHermesTask('please debug this JavaScript API'), 'coding');
  assert.equal(classifyHermesTask('search the web for current news'), 'search');
  assert.equal(classifyHermesTask('navigate the globe to Tokyo'), 'maps');
  assert.equal(classifyHermesTask('watch the YouTube video'), 'video');
  assert.equal(classifyHermesTask('consider my request'), 'thinking');
});

test('Hermes expression precedence keeps failures above active tasks', () => {
  assert.equal(resolveHermesExpression({
    system: 'offline',
    conversation: 'talking',
    taskCategory: 'coding',
  }), 'offline');
  assert.equal(resolveHermesExpression({
    system: 'error',
    conversation: 'success',
    taskCategory: 'search',
  }), 'error');
  assert.equal(resolveHermesExpression({
    system: 'loading',
    conversation: '',
    taskCategory: 'reading',
  }), 'reading');
});

test('controller holds transitions, restores idle after success, and cleans up URLs', async () => {
  const listeners = new Map();
  const image = {
    dataset: {},
    src: '/brand.png',
    alt: '',
  };
  const scheduled = [];
  const revoked = [];
  let clock = 0;
  const documentRef = {
    querySelector: () => image,
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: (name) => listeners.delete(name),
  };
  const windowRef = {
    setTimeout: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      scheduled.push(timer);
      return timer;
    },
    clearTimeout: (timer) => { timer.cleared = true; },
    URL: {
      createObjectURL: () => `blob:${revoked.length + scheduled.length}`,
      revokeObjectURL: (url) => revoked.push(url),
    },
  };
  const controller = createHermesTaskLogoController({
    documentRef,
    windowRef,
    now: () => clock,
    minHoldMs: 100,
    successHoldMs: 200,
    fetchImpl: async () => ({
      ok: true,
      text: async () => '<svg><use href="#f-neutral" />\n</svg>',
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.expression, 'neutral');
  assert.equal(image.dataset.hermesTaskLogoManaged, 'true');

  controller.listening();
  clock = 100;
  scheduled.find((timer) => !timer.cleared)?.fn();
  assert.equal(controller.expression, 'listening');
  controller.setTask('please write code');
  clock = 200;
  scheduled.filter((timer) => !timer.cleared).at(-1)?.fn();
  assert.equal(controller.expression, 'code');

  listeners.get(HERMES_TASK_LOGO_EVENT)?.({ detail: { system: 'offline' } });
  assert.equal(controller.expression, 'offline');
  listeners.get(HERMES_TASK_LOGO_EVENT)?.({ detail: { system: 'idle' } });
  controller.success();
  clock = 300;
  scheduled.find((timer) => !timer.cleared && timer.ms === 100)?.fn();
  assert.equal(controller.expression, 'success');
  clock = 500;
  scheduled.find((timer) => !timer.cleared && timer.ms === 300)?.fn();

  controller.destroy();
  assert.equal(listeners.has(HERMES_TASK_LOGO_EVENT), false);
  assert.ok(revoked.length > 0);
});