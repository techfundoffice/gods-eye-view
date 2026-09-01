import test from 'node:test';
import assert from 'node:assert/strict';
import { createYoutubePublicCommandCoordinator } from './youtubePublicCommandCoordinator.js';
import { createInMemoryPublicCommandLedger } from './youtubePublicCommandLedger.js';
import { PUBLIC_HELP_REPLY } from './youtubePublicCommandPolicy.js';

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

test('/help succeeds with the shipped reply and never invokes AI', async () => {
  const ledger = createInMemoryPublicCommandLedger({ now: () => 100 });
  let calls = 0;
  const coordinator = createYoutubePublicCommandCoordinator({
    ledger, now: () => 100, id: (() => { let n = 0; return () => `help-${++n}`; })(),
    interpret: async () => { calls += 1; return { ok: true, kind: 'complete', text: 'nope' }; },
  });
  const result = await coordinator.register(comment('help-1', '/help'), binding);
  assert.equal(calls, 0);
  assert.equal(result.record.state, 'succeeded');
  assert.equal(result.record.answer, PUBLIC_HELP_REPLY);
  assert.equal(result.record.command, '/help');
});

test('/live-contacts and /explore-manually queue run_view_preset without AI', async () => {
  const ledger = createInMemoryPublicCommandLedger({ now: () => 100 });
  let calls = 0;
  const coordinator = createYoutubePublicCommandCoordinator({
    ledger, now: () => 100, id: (() => { let n = 0; return () => `view-${++n}`; })(),
    interpret: async () => { calls += 1; return { ok: true, kind: 'complete', text: 'nope' }; },
  });
  const contacts = await coordinator.register(comment('view-1', '/live-contacts'), binding);
  assert.equal(calls, 0);
  assert.equal(contacts.record.state, 'awaiting-execution');
  assert.equal(contacts.record.validatedTool.name, 'run_view_preset');
  assert.equal(contacts.record.validatedTool.arguments.preset, '/live-contacts');

  const explore = await coordinator.register(comment('view-2', '/explore-manually'), binding);
  assert.equal(calls, 0);
  assert.equal(explore.record.state, 'awaiting-execution');
  assert.equal(explore.record.validatedTool.name, 'run_view_preset');
  assert.equal(explore.record.validatedTool.arguments.preset, '/explore-manually');

  await ledger.compareAndSet(explore.record.id, 'awaiting-execution', {
    state: 'executing',
    captureEpoch: 'epoch',
  });
  const done = await coordinator.acceptToolResult(explore.record.id, binding, { ok: true, choice: 'explore' });
  assert.equal(calls, 0);
  assert.equal(done.record.state, 'succeeded');
  assert.equal(done.record.answer, '/explore-manually');
});