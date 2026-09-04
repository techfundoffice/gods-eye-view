import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createIdleTrainingCoordinator } from './hermesIdleTraining.js';
import { createVersionedLessonStore, validateTrainingLesson } from './hermesLessonStore.js';
import { createGeneratedSkillManager, validateGeneratedSkill } from './hermesGeneratedSkillManager.js';
import { createHermesTrainingControl } from './hermesTrainingControl.js';
import { createYoutubeCommentHarnessMiddleware } from './youtubeCommentHarnessServer.js';
import { createYoutubePublicCommandRuntime } from './youtubePublicCommandRuntime.js';

function invoke(middleware, { body = {}, method = 'POST', url = '/hermes' } = {}) {
  return new Promise((resolve, reject) => {
    const listeners = new Map();
    const req = { method, url, destroy() {}, on(event, fn) {
      listeners.set(event, fn);
      if (listeners.has('data') && listeners.has('end')) queueMicrotask(() => {
        listeners.get('data')(Buffer.from(JSON.stringify(body))); listeners.get('end')();
      });
      return this;
    } };
    const res = { statusCode: 200, setHeader() {}, end(value) { resolve({ status: this.statusCode, body: JSON.parse(value) }); } };
    Promise.resolve(middleware(req, res)).catch(reject);
  });
}

const candidate = (version = '1.0.0') => ({
  name: 'generated-view-helper',
  version,
  instructions: 'Use the visible globe tools conservatively.',
  rules: ['Only change the visible view.'],
  examples: [],
  tools: ['zoom_to_globe'],
});

test('idle training is single-flight, bounded, and immediately preempted', async () => {
  let calls = 0;
  let release;
  const training = createIdleTrainingCoordinator({
    idleMs: 0,
    minIntervalMs: 0,
    maxRunMs: 10_000,
    maxRunsPerWindow: 2,
    train: ({ signal }) => {
      calls += 1;
      return new Promise((resolve, reject) => {
        release = resolve;
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
  });
  training.start();
  const first = training.trigger();
  const second = training.trigger();
  assert.equal(calls, 1);
  training.preemptForViewerActivity('viewer arrived');
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.cancelled, true);
  assert.equal(b.cancelled, true);
  assert.equal(training.status().preemptions, 1);
  release?.();
  training.stop();
});

test('lesson store rejects sensitive data and atomically versions clear/rollback', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hermes-lessons-'));
  const filePath = path.join(directory, 'lessons.json');
  try {
    assert.equal(validateTrainingLesson({ summary: 'x', viewerName: 'alice' }).ok, false);
    assert.equal(validateTrainingLesson({ summary: 'x', image: 'raw' }).ok, false);
    const store = createVersionedLessonStore({ filePath, now: () => 10 });
    await store.add({ summary: 'Prefer an overview for cities', tags: ['camera'] });
    await store.clear();
    assert.equal((await store.inspect()).lessonCount, 0);
    await store.rollback(1);
    assert.equal((await store.inspect()).lessonCount, 1);
    const disk = JSON.parse(await readFile(filePath, 'utf8'));
    assert.equal(disk.schemaVersion, 1);
    assert.equal(disk.lessons[0].data.summary, 'Prefer an overview for cities');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('generated skill activation requires view-safe schema and bounded replay', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hermes-skill-'));
  try {
    let replayCalls = 0;
    const skills = createGeneratedSkillManager({
      filePath: path.join(directory, 'skill.json'),
      replay: async (_skill, cases, options) => {
        replayCalls += 1;
        assert.equal(options.maxCases, 2);
        return { ok: cases.every((item) => item.ok) };
      },
      maxReplayCases: 2,
    });
    const unsafe = { ...candidate(), tools: ['write_file'], instructions: 'Run shell commands.' };
    assert.equal(validateGeneratedSkill(unsafe).ok, false);
    assert.equal((await skills.propose(unsafe, { rationale: 'bad' })).accepted, false);
    assert.equal(replayCalls, 0);
    const rejected = await skills.propose(candidate(), { rationale: 'test', cases: [{ ok: false }] });
    assert.equal(rejected.accepted, false);
    assert.equal((await skills.inspect()).active, null);
    const accepted = await skills.propose(candidate(), { rationale: 'Improves globe framing', cases: [{ ok: true }] });
    assert.equal(accepted.accepted, true);
    assert.match(accepted.diff, /instructions|name/);
    await skills.clear();
    await skills.rollback(1);
    assert.equal((await skills.inspect()).active.version, '1.0.0');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('control surface combines status and forwards viewer preemption', async () => {
  let preempted = '';
  const control = createHermesTrainingControl({
    training: {
      status: () => ({ state: 'idle' }),
      start() {}, stop() {}, trigger() {},
      preemptForViewerActivity(reason) { preempted = reason; },
    },
    lessons: { inspect: async () => ({ revision: 2 }), add() {}, clear() {}, rollback() {} },
    skills: { inspect: async () => ({ revision: 3 }), propose() {}, clear() {}, rollback() {} },
  });
  assert.deepEqual(await control.status(), {
    training: { state: 'idle' },
    lessons: { revision: 2 },
    generatedSkill: { revision: 3 },
  });
  control.viewerActivity('comment');
  assert.equal(preempted, 'comment');
});

test('ADMIN Hermes endpoint exposes learning status and training controls', async () => {
  const calls = [];
  const control = {
    async status() { return { training: { state: 'idle' }, lessons: { revision: 1 }, generatedSkill: { revision: 2 } }; },
    stop(reason) { calls.push(['stop', reason]); return { state: 'idle' }; },
    start() { calls.push(['start']); return { state: 'waiting' }; },
    async trainNow() { calls.push(['train']); return { ok: true }; },
    async clearLessons() { calls.push(['clearLessons']); },
    async clearSkill() { calls.push(['clearSkill']); },
    async rollbackLessons(revision) { calls.push(['rollbackLessons', revision]); },
    async rollbackSkill(revision) { calls.push(['rollbackSkill', revision]); },
  };
  const middleware = createYoutubeCommentHarnessMiddleware({
    authorizeAdminRequest: async () => ({ sub: 'admin' }),
    trainingControl: control,
    hermesController: { status: () => ({ ready: true }) },
  });
  const status = await invoke(middleware, { method: 'GET' });
  assert.equal(status.body.learning.training.state, 'idle');
  assert.equal((await invoke(middleware, { body: { action: 'pause-training' } })).status, 200);
  await invoke(middleware, { body: { action: 'rollback-learning', revision: 2, target: 'skill' } });
  assert.deepEqual(calls, [['stop', 'admin-pause'], ['rollbackSkill', 2]]);
});

test('public command runtime preempts idle learning before command registration', async () => {
  let activity = 0;
  const runtime = createYoutubePublicCommandRuntime({
    onViewerActivity: () => { activity += 1; },
    ledger: {
      cancelNonterminal: async () => 0,
      find: async () => null,
      insert: async (record) => ({ inserted: true, record }),
      compareAndSet: async () => ({ changed: true }),
      get: async () => null,
    },
  });
  await runtime.rotateExecutor();
  await runtime.registerMessage(
    { id: 'message', text: 'hi', agentMode: 'execute', deferAgent: true },
    { commandsEnabled: true, videoId: 'video', generation: 1 },
  );
  assert.equal(activity, 1);
});