import test from 'node:test';
import assert from 'node:assert/strict';
import { createYoutubePublicCommandCoordinator } from './youtubePublicCommandCoordinator.js';
import { createInMemoryPublicCommandLedger } from './youtubePublicCommandLedger.js';

const binding = {
  videoId: 'video',
  generation: 4,
  commandsEnabled: true,
  captureExecutorId: 'capture',
  captureEpoch: 'epoch',
};
const comment = (id, text) => ({ commentId: id, text, author: { displayName: 'Viewer' } });

test('recognized commands always invoke AI before persisting executable work', async () => {
  const ledger = createInMemoryPublicCommandLedger({ now: () => 100 });
  let calls = 0;
  const coordinator = createYoutubePublicCommandCoordinator({
    ledger, now: () => 100, id: (() => { let n = 0; return () => `id-${++n}`; })(),
    interpret: async () => {
      calls += 1;
      assert.equal((await ledger.list())[0].state, 'interpreting');
      return { ok: true, kind: 'tool-call', call: { responseId: 'r', callId: 'c', name: 'zoom_to_globe', arguments: {} } };
    },
  });
  const result = await coordinator.register(comment('c1', '/gods-eye-view'), binding);
  assert.equal(calls, 1);
  assert.equal(result.record.state, 'awaiting-execution');
  assert.equal(result.record.validatedTool.name, 'zoom_to_globe');
  assert.ok(result.record.nonce);
});

test('duplicates, malformed and ordinary comments never invoke AI', async () => {
  const ledger = createInMemoryPublicCommandLedger();
  let calls = 0;
  const coordinator = createYoutubePublicCommandCoordinator({ ledger, interpret: async () => { calls += 1; } });
  assert.equal((await coordinator.register(comment('a', 'ordinary'), binding)).recognized, false);
  assert.equal((await coordinator.register(comment('b', '/y'), binding)).record.state, 'rejected');
  await coordinator.register(comment('c', '/gods-eye-view'), binding);
  await coordinator.register(comment('c', '/gods-eye-view'), binding);
  assert.equal(calls, 1);
});

test('coordinator revalidates model calls and mode violations become rejected', async () => {
  const ledger = createInMemoryPublicCommandLedger();
  const coordinator = createYoutubePublicCommandCoordinator({
    ledger,
    interpret: async () => ({
      ok: true, kind: 'tool-call',
      call: { responseId: 'r', callId: 'c', name: 'fly_to_location', arguments: { query: 'Paris' } },
    }),
  });
  const result = await coordinator.register(comment('c1', '/y where?'), binding);
  assert.equal(result.record.state, 'rejected');
  assert.match(result.record.reason, /not allowed/);
});

test('continuations require an exact verified binding', async () => {
  const ledger = createInMemoryPublicCommandLedger();
  let turn = 0;
  const coordinator = createYoutubePublicCommandCoordinator({
    ledger,
    interpret: async () => (++turn === 1
      ? { ok: true, kind: 'tool-call', call: { responseId: 'r1', callId: 'call1', name: 'get_current_view_state', arguments: {} } }
      : { ok: true, kind: 'complete', text: 'There are 12.' }),
  });
  const first = await coordinator.register(comment('c1', '/y how many?'), binding);
  await ledger.compareAndSet(first.record.id, 'awaiting-execution', {
    state: 'executing',
    nonce: null,
    captureEpoch: 'epoch',
  });
  const done = await coordinator.acceptToolResult(first.record.id, binding, { ok: true, count: 12 });
  assert.equal(done.record.state, 'succeeded');
  assert.equal(done.record.answer, 'There are 12.');
  assert.equal(turn, 2);
});

test('a stale tool result atomically cancels executing work', async () => {
  const ledger = createInMemoryPublicCommandLedger();
  await ledger.insert({
    id: 'stale', videoId: 'video', commentId: 'c-stale', generation: 4,
    captureExecutorId: 'capture', captureEpoch: 'epoch', state: 'executing',
    mode: 'global-reset', command: '/gods-eye-view', comment: '/gods-eye-view',
    viewer: 'v', validatedTool: { name: 'zoom_to_globe', arguments: {} },
  });
  const result = await createYoutubePublicCommandCoordinator({
    ledger,
    interpret: async () => ({ ok: true, kind: 'complete', text: 'unused' }),
  }).acceptToolResult('stale', { ...binding, commandsEnabled: false }, { ok: true });
  assert.equal(result.reason, 'stale-or-invalid');
  assert.equal((await ledger.get('stale')).state, 'cancelled');
});

test('generation changes cancel work without late execution', async () => {
  const ledger = createInMemoryPublicCommandLedger();
  const coordinator = createYoutubePublicCommandCoordinator({
    ledger,
    interpret: async () => ({ ok: true, kind: 'complete', text: 'done' }),
  });
  await ledger.insert({
    id: 'id', videoId: 'video', commentId: 'c', generation: 4, state: 'interpreting',
    mode: 'analyze', command: '/y', comment: '/y q', viewer: 'v', expiresAt: Date.now() + 10_000,
  });
  assert.equal((await coordinator.advance('id', { ...binding, generation: 5 })).reason, 'stale');
  assert.equal((await ledger.get('id')).state, 'cancelled');
});