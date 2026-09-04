import test from 'node:test';
import assert from 'node:assert/strict';
import {
  captureHermesViewContext,
  HERMES_TRAINING_ACTIONS,
  initHermesAgentCard,
} from './hermesAgentCard.js';

test('Hermes card maps training controls to learning endpoints, never runtime lifecycle actions', () => {
  assert.deepEqual(HERMES_TRAINING_ACTIONS, {
    pause: 'pause-training',
    resume: 'resume-training',
    clear: 'clear-learning',
    rollback: 'rollback-learning',
    inspect: 'inspect-learning',
  });
  assert.equal(Object.values(HERMES_TRAINING_ACTIONS).includes('stop'), false);
  assert.equal(Object.values(HERMES_TRAINING_ACTIONS).includes('start'), false);
});

test('Hermes context uses canonical registered layers and never captures text secrets', async () => {
  const controls = [
    {
      type: 'password', id: 'api-key', value: 'secret', disabled: false, hidden: false,
      tagName: 'INPUT', textContent: '', title: '', name: 'api-key',
      getAttribute: () => null, closest: () => null,
    },
    {
      type: 'checkbox', id: 'traffic-toggle', checked: true, disabled: false, hidden: false,
      tagName: 'INPUT', textContent: '', title: 'Traffic', name: '',
      getAttribute: () => null, closest: () => null,
    },
  ];
  const module = { name: 'Traffic' };
  const dataManager = {
    layers: new Map([['traffic', { module }]]),
    isEnabled: (id) => id === 'traffic',
    getLayerLifecycleState: () => ({ lifecycleState: 'enabled' }),
  };
  const documentRef = {
    documentElement: { dataset: {} },
    querySelectorAll: (selector) => selector.startsWith('button') ? controls : [],
    querySelector: () => null,
    getElementById: () => null,
  };
  const context = await captureHermesViewContext({
    includeScreenshot: false,
    documentRef,
    windowRef: {
      __godsEyeView: { dataManager, styleManager: { activeStyle: 'thermal' } },
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
      innerWidth: 1000,
      innerHeight: 700,
      devicePixelRatio: 2,
    },
  });
  assert.deepEqual(context.layers.enabled, ['traffic']);
  assert.equal(context.layers.states[0].label, 'Traffic');
  assert.equal(context.style, 'thermal');
  assert.equal(context.controls[1].checked, true);
  assert.equal(JSON.stringify(context).includes('secret'), false);
});

test('nested learning status renders as a readable count and skill version', async () => {
  const nodes = new Map([
    ['hermes-agent-learning', { textContent: '' }],
    ['hermes-agent-status', { textContent: '', dataset: {} }],
  ]);
  const root = {
    dataset: {},
    closest: () => null,
    parentElement: null,
    querySelector: (selector) => nodes.get(selector.replace(/^#/, '')) || null,
    querySelectorAll: () => [],
  };
  const card = initHermesAgentCard({
    documentRef: {
      getElementById: (id) => id === 'hermes-agent-card' ? root : null,
    },
    windowRef: {},
    pollMs: 0,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        harness: { running: true },
        learning: {
          training: { state: 'idle' },
          lessons: { lessonCount: 2, lessons: [] },
          generatedSkill: { active: { version: '1.0.2' } },
        },
      }),
    }),
  });
  await card.refresh();
  assert.equal(nodes.get('hermes-agent-learning').textContent, '2 saved lessons · skill 1.0.2');
});