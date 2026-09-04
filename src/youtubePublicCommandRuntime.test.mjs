import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createInMemoryPublicCommandLedger } from './youtubePublicCommandLedger.js';
import {
  createYoutubePublicCommandRuntime,
  PUBLIC_EXECUTOR_HEADER,
} from './youtubePublicCommandRuntime.js';
import { VIEWER_REPLY_WINDOW_MS } from './youtubeViewerTurnPolicy.js';
import { createHermesTrainingViewerGate } from './hermesTrainingViewerGate.js';

function executorRequest({ method = 'GET', url = '/executor/lease', credential, remoteAddress = '127.0.0.1', host = '127.0.0.1:5000', headers = {}, body = null } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.socket = { remoteAddress };
  req.headers = { host, ...headers, ...(credential ? { [PUBLIC_EXECUTOR_HEADER]: credential } : {}) };
  const res = {
    statusCode: 0,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    end(value) { this.body = JSON.parse(value); },
  };
  return { req, res, body };
}

async function invoke(middleware, options) {
  const { req, res, body } = executorRequest(options);
  const pending = middleware(req, res);
  if (body != null) req.emit('data', Buffer.from(JSON.stringify(body)));
  req.emit('end');
  await pending;
  return res;
}

test('executor middleware only authorizes exact loopback connections and rejects forwarded or invalid hosts', async () => {
  const runtime = createYoutubePublicCommandRuntime({ ledger: createInMemoryPublicCommandLedger() });
  const session = await runtime.rotateExecutor();
  const middleware = runtime.middleware();
  for (const options of [
    { credential: session.credential, remoteAddress: '127.0.0.1', host: '127.0.0.1:5000' },
    { credential: session.credential, remoteAddress: '::1', host: '[::1]:5000' },
  ]) {
    const res = await invoke(middleware, options);
    assert.equal(res.statusCode, 200);
  }
  for (const options of [
    { credential: session.credential, remoteAddress: '10.0.0.5', host: '127.0.0.1:5000' },
    { credential: session.credential, remoteAddress: '127.0.0.1', host: 'app.example.replit.dev' },
    { credential: session.credential, remoteAddress: '127.0.0.1', host: 'localhost.evil:5000' },
    { credential: session.credential, remoteAddress: '127.0.0.1', host: '127.0.0.1:5000', headers: { 'x-forwarded-for': '127.0.0.1' } },
  ]) {
    const res = await invoke(middleware, options);
    assert.equal(res.statusCode, 403);
  }
});

test('executor lease is redeemed only once by compare-and-set', async () => {
  const ledger = createInMemoryPublicCommandLedger();
  const runtime = createYoutubePublicCommandRuntime({
    ledger,
    interpret: async () => ({
      ok: true,
      kind: 'tool',
      call: { name: 'zoom_to_globe', arguments: {}, responseId: 'response', callId: 'call' },
    }),
  });
  const session = await runtime.rotateExecutor();
  const binding = { commandsEnabled: true, videoId: 'video', generation: 1 };
  await runtime.registerMessage({ id: 'comment', text: '/gods-eye-view', author: 'viewer' }, binding);
  const middleware = runtime.middleware({ getBinding: () => binding });
  const [one, two] = await Promise.all([
    invoke(middleware, { credential: session.credential }),
    invoke(middleware, { credential: session.credential }),
  ]);
  assert.equal([one.body.lease, two.body.lease].filter(Boolean).length, 1);
  assert.equal((await ledger.list())[0].state, 'executing');
});

test('aborted idle practice cancels its exact queued command', async () => {
  const ledger = createInMemoryPublicCommandLedger();
  const runtime = createYoutubePublicCommandRuntime({ ledger });
  const session = await runtime.rotateExecutor();
  const binding = { commandsEnabled: true, videoId: 'video', generation: 1 };
  const queued = await runtime.enqueueTool({
    name: 'get_current_view_state',
    args: {},
    source: 'idle-practice',
  }, binding);
  const controller = new AbortController();
  controller.abort(new Error('Viewer work preempted idle practice'));
  const observed = await runtime.waitForObservedExecution(
    queued.command.id,
    binding,
    { signal: controller.signal, pollMs: 1 },
  );
  assert.equal(observed.ok, false);
  assert.equal(observed.reason, 'Viewer work preempted idle practice');
  const record = await ledger.get(queued.command.id);
  assert.equal(record.state, 'cancelled');
  assert.equal(record.reason, 'Viewer work preempted idle practice');
});

test('a leased idle practice becomes invalid as soon as viewer work preempts it', async () => {
  const ledger = createInMemoryPublicCommandLedger();
  const runtime = createYoutubePublicCommandRuntime({ ledger });
  const session = await runtime.rotateExecutor();
  const binding = { commandsEnabled: true, videoId: 'video', generation: 1 };
  await runtime.enqueueTool({
    name: 'get_current_view_state',
    args: {},
    source: 'idle-practice',
  }, binding);
  const middleware = runtime.middleware({ getBinding: () => binding });
  const leased = await invoke(middleware, { credential: session.credential });
  assert.equal(
    await runtime.isExecutorLeaseActive(
      leased.body.lease.commandId,
      leased.body.lease.captureEpoch,
      binding,
    ),
    true,
  );
  await runtime.cancelIdleWork('Viewer work preempted idle practice');
  assert.equal(
    await runtime.isExecutorLeaseActive(
      leased.body.lease.commandId,
      leased.body.lease.captureEpoch,
      binding,
    ),
    false,
  );
});

test('visible viewer lease runs the AI tool and continues to a final reply', async () => {
  const ledger = createInMemoryPublicCommandLedger();
  const interpreted = [];
  const runtime = createYoutubePublicCommandRuntime({
    ledger,
    interpret: async (input) => {
      interpreted.push(input);
      return input.toolResult
        ? { ok: true, kind: 'complete', text: 'Live Contacts is active. What next?' }
        : {
        ok: true,
        kind: 'tool',
        call: {
          name: 'run_view_preset',
          arguments: { preset: '/live-contacts' },
          responseId: 'response',
          callId: 'call',
        },
      };
    },
  });
  const session = await runtime.rotateExecutor();
  const binding = { commandsEnabled: true, videoId: 'video', generation: 1 };
  await runtime.registerMessage({
    id: 'comment',
    text: '/live-contacts',
    author: 'viewer',
    agentMode: 'execute',
    deferAgent: true,
  }, binding);
  assert.equal(interpreted.length, 0);
  const middleware = runtime.middleware({ getBinding: () => binding });

  const viewContext = {
    camera: { heading: 90 },
    layers: ['aircraft'],
    screenshot: { dataUrl: `data:image/webp;base64,${'a'.repeat(12_000)}` },
  };
  const lease = await invoke(middleware, {
    method: 'POST',
    url: '/agent/lease',
    credential: session.credential,
    body: { viewContext },
  });
  assert.equal(lease.statusCode, 200);
  assert.equal(lease.body.lease.tool.name, 'run_view_preset');
  assert.deepEqual(interpreted[0].viewContext, viewContext);

  const resultViewContext = {
    camera: { heading: 120 },
    layers: ['aircraft', 'flights'],
    screenshot: { dataUrl: `data:image/webp;base64,${'b'.repeat(12_000)}` },
  };
  const result = await invoke(middleware, {
    method: 'POST',
    url: '/agent/result',
    credential: session.credential,
    body: {
      commandId: lease.body.lease.commandId,
      nonce: lease.body.lease.nonce,
      result: { ok: true, action: 'run_view_preset', preset: '/live-contacts' },
      viewContext: resultViewContext,
    },
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.record.state, 'succeeded');
  assert.equal(result.body.record.answer, 'Live Contacts is active. What next?');
  assert.deepEqual(interpreted[1].viewContext, resultViewContext);
});

test('visible viewer result rejects a stale nonce without changing the lease', async () => {
  const ledger = createInMemoryPublicCommandLedger();
  const runtime = createYoutubePublicCommandRuntime({
    ledger,
    interpret: async () => ({
      ok: true,
      kind: 'tool',
      call: { name: 'zoom_to_globe', arguments: {}, responseId: 'response', callId: 'call' },
    }),
  });
  const session = await runtime.rotateExecutor();
  const binding = { commandsEnabled: true, videoId: 'video', generation: 1 };
  await runtime.registerMessage({ id: 'comment', text: '/gods-eye-view', author: 'viewer' }, binding);
  const middleware = runtime.middleware({ getBinding: () => binding });
  const lease = await invoke(middleware, { url: '/agent/lease', credential: session.credential });
  const result = await invoke(middleware, {
    method: 'POST',
    url: '/agent/result',
    credential: session.credential,
    body: {
      commandId: lease.body.lease.commandId,
      nonce: 'wrong',
      result: { ok: true },
    },
  });
  assert.equal(result.statusCode, 409);
  assert.equal(result.body.reason, 'nonce');
  assert.equal((await ledger.list())[0].state, 'executing');
});

test('viewer work queues behind active training without invalidating its practice command', async () => {
  const ledger = createInMemoryPublicCommandLedger();
  const turnGate = createHermesTrainingViewerGate();
  const finishTraining = turnGate.tryBeginTraining();
  let interpretations = 0;
  const runtime = createYoutubePublicCommandRuntime({
    ledger,
    turnGate,
    interpret: async () => {
      interpretations += 1;
      return { ok: true, kind: 'complete', text: 'Training finished; viewer handled.' };
    },
  });
  const session = await runtime.rotateExecutor();
  const binding = { commandsEnabled: true, videoId: 'video', generation: 1 };
  const practice = await runtime.enqueueTool(
    { name: 'zoom_to_globe', args: {}, source: 'idle-practice' },
    binding,
  );
  assert.equal(practice.ok, true);
  const first = await runtime.registerMessage(
    { id: 'viewer-comment', text: '/gods-eye-view', author: 'viewer' },
    binding,
  );
  const second = await runtime.registerMessage(
    { id: 'viewer-comment-2', text: '/gods-eye-view', author: 'viewer two' },
    binding,
  );
  const rows = await ledger.list();
  assert.equal(rows.find((row) => row.id === practice.command.id).state, 'awaiting-execution');
  assert.equal(first.record.state, 'received');
  assert.equal(second.record.state, 'received');
  assert.match(first.record.reason, /finishes its current training task/i);
  assert.equal(interpretations, 0);
  assert.equal(await runtime.nextViewerLease(binding), null);

  const trainingLease = await invoke(runtime.middleware({ getBinding: () => binding }), {
    credential: session.credential,
  });
  assert.equal(trainingLease.body.lease.commandId, practice.command.id);
  finishTraining();
  assert.equal(await runtime.nextViewerLease(binding), null);
  assert.equal(interpretations, 1);
  const after = await ledger.list();
  assert.equal(after.find((row) => row.commentId === 'viewer-comment').state, 'succeeded');
  assert.equal(after.find((row) => row.commentId === 'viewer-comment-2').state, 'received');
});

test('executor rejects a result from an old capture epoch', async () => {
  const runtime = createYoutubePublicCommandRuntime({ ledger: createInMemoryPublicCommandLedger() });
  const old = await runtime.rotateExecutor();
  const current = await runtime.rotateExecutor();
  const res = await invoke(runtime.middleware(), {
    method: 'POST',
    url: '/executor/result',
    credential: current.credential,
    body: { commandId: 'anything', captureEpoch: old.captureEpoch, result: { ok: true } },
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error.kind, 'stale-executor');
});

test('verified to unverified transition cancels queued work before lease issue', async () => {
  const ledger = createInMemoryPublicCommandLedger();
  const runtime = createYoutubePublicCommandRuntime({
    ledger,
    interpret: async () => ({
      ok: true,
      kind: 'tool',
      call: { name: 'zoom_to_globe', arguments: {}, responseId: 'response', callId: 'call' },
    }),
  });
  const session = await runtime.rotateExecutor();
  const binding = { commandsEnabled: true, videoId: 'video', generation: 1 };
  await runtime.registerMessage({ id: 'comment', text: '/gods-eye-view', author: 'viewer' }, binding);
  binding.commandsEnabled = false;
  const response = await invoke(runtime.middleware({ getBinding: () => binding }), {
    credential: session.credential,
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.lease, null);
  assert.equal((await ledger.list())[0].state, 'cancelled');
});

test('unverified result submission cancels an already redeemed lease', async () => {
  const ledger = createInMemoryPublicCommandLedger();
  const runtime = createYoutubePublicCommandRuntime({
    ledger,
    interpret: async () => ({
      ok: true,
      kind: 'tool',
      call: { name: 'zoom_to_globe', arguments: {}, responseId: 'response', callId: 'call' },
    }),
  });
  const session = await runtime.rotateExecutor();
  const binding = { commandsEnabled: true, videoId: 'video', generation: 1 };
  await runtime.registerMessage({ id: 'comment', text: '/gods-eye-view', author: 'viewer' }, binding);
  const middleware = runtime.middleware({ getBinding: () => binding });
  const leased = await invoke(middleware, { credential: session.credential });
  assert.ok(leased.body.lease);
  binding.commandsEnabled = false;
  const result = await invoke(middleware, {
    method: 'POST',
    url: '/executor/result',
    credential: session.credential,
    body: {
      commandId: leased.body.lease.commandId,
      captureEpoch: leased.body.lease.captureEpoch,
      result: { ok: true },
    },
  });
  assert.equal(result.statusCode, 409);
  assert.equal(result.body.error.kind, 'not-verified-live');
  assert.equal((await ledger.list())[0].state, 'cancelled');
});

test('video or generation changes cancel old nonterminal records', async () => {
  const ledger = createInMemoryPublicCommandLedger();
  const runtime = createYoutubePublicCommandRuntime({
    ledger,
    interpret: async () => ({
      ok: true,
      kind: 'tool',
      call: { name: 'zoom_to_globe', arguments: {}, responseId: 'response', callId: 'call' },
    }),
  });
  await runtime.rotateExecutor();
  await runtime.registerMessage(
    { id: 'comment', text: '/gods-eye-view', author: 'viewer' },
    { commandsEnabled: true, videoId: 'video-a', generation: 1 },
  );
  await runtime.statuses({ commandsEnabled: true, videoId: 'video-b', generation: 2 });
  assert.equal((await ledger.list())[0].state, 'cancelled');
});

test('same YouTube message id is deduplicated across replacement broadcasts', async () => {
  const ledger = createInMemoryPublicCommandLedger();
  let calls = 0;
  let viewerActivity = 0;
  const runtime = createYoutubePublicCommandRuntime({
    ledger,
    onViewerActivity: () => { viewerActivity += 1; },
    interpret: async () => {
      calls += 1;
      return { ok: true, kind: 'complete', text: 'Handled once.' };
    },
  });
  await runtime.rotateExecutor();
  await runtime.registerMessage(
    { id: 'globally-unique-comment', text: 'Show me Hawaii', author: 'viewer', agentMode: 'execute' },
    { commandsEnabled: true, videoId: 'video-a', generation: 1 },
  );
  await runtime.registerMessage(
    { id: 'globally-unique-comment', text: 'Show me Hawaii', author: 'viewer', agentMode: 'execute' },
    { commandsEnabled: true, videoId: 'video-b', generation: 2 },
  );
  assert.equal(calls, 1);
  assert.equal(viewerActivity, 2, 'the new message and its reply window each reset training once');
  assert.equal((await ledger.list()).length, 1);
});

test('terminal viewer comment blocks training for 30 seconds after Hermes replies, then is set aside', async () => {
  let currentTime = 1_000;
  const activity = [];
  const ledger = createInMemoryPublicCommandLedger({ now: () => currentTime });
  const runtime = createYoutubePublicCommandRuntime({
    ledger,
    now: () => currentTime,
    onViewerActivity: (reason) => activity.push(reason),
    interpret: async () => ({ ok: true, kind: 'complete', text: 'Hawaii is ready.' }),
  });
  await runtime.rotateExecutor();
  const binding = { commandsEnabled: true, videoId: 'video', generation: 1 };
  const registered = await runtime.registerMessage({
    id: 'hawaii',
    text: 'Show me Hawaii',
    author: 'Viewer',
    authorHandle: '@viewer',
    agentMode: 'execute',
  }, binding);

  assert.equal(registered.record.state, 'succeeded');
  assert.deepEqual(activity, ['viewer message', 'viewer reply window']);
  assert.equal(await runtime.hasPendingViewer(binding), true);

  currentTime += VIEWER_REPLY_WINDOW_MS - 1;
  assert.equal(await runtime.hasPendingViewer(binding), true);

  currentTime += 1;
  assert.equal(await runtime.hasPendingViewer(binding), false);
  assert.equal((await ledger.get(registered.record.id)).state, 'succeeded');
});