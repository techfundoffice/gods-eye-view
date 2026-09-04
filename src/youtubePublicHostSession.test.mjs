import test from 'node:test';
import assert from 'node:assert/strict';
import { createYoutubePublicCommandCoordinator } from './youtubePublicCommandCoordinator.js';
import { createInMemoryPublicCommandLedger } from './youtubePublicCommandLedger.js';
import {
  HOST_FOLLOWUP_MS,
  formatHostAsk,
  isHostActionableComment,
  isNewPlaceComment,
  isViewChoiceComment,
} from './youtubePublicHostSession.js';

const binding = {
  videoId: 'video',
  generation: 4,
  commandsEnabled: true,
  captureExecutorId: 'capture',
  captureEpoch: 'epoch',
};

test('host ask names the viewer, the place, the views, and the 30 second deadline', () => {
  const text = formatHostAsk({ handle: 'marcusmanagementservices488', place: 'Los Angeles, CA, USA' });
  assert.match(text, /@marcusmanagementservices488/);
  assert.match(text, /Los Angeles/);
  assert.match(text, /30 seconds to reply/);
  assert.match(text, /Downtown closer/);
  assert.match(text, /3D buildings/);
});

test('view-choice replies are not treated as a new place', () => {
  assert.equal(isViewChoiceComment('yes show me 3D buildings'), true);
  assert.equal(isViewChoiceComment('orbit'), true);
  assert.equal(isNewPlaceComment('yes show me 3D buildings'), false);
  assert.equal(isNewPlaceComment('navigate to tokyo'), true);
  assert.equal(isViewChoiceComment('navigate to tokyo'), false);
});

test('ordinary chat does not claim or enter the viewer-control queue', () => {
  assert.equal(isHostActionableComment('This stream looks great!'), false);
  assert.equal(isHostActionableComment('Navigate to Tokyo'), true);
  assert.equal(isHostActionableComment('turn on live flights'), true);
});

test('after a fly, only that username may continue; others queue for 30 seconds', async () => {
  const clock = { t: 1_000 };
  const ledger = createInMemoryPublicCommandLedger({ now: () => clock.t });
  const coordinator = createYoutubePublicCommandCoordinator({
    ledger,
    now: () => clock.t,
    id: (() => { let n = 0; return () => `id-${++n}`; })(),
    interpret: async ({ previousResponseId }) => previousResponseId
      ? {
        ok: true,
        kind: 'complete',
        text: '@marcusmanagementservices488 Los Angeles is up. You have 30 seconds to reply.',
      }
      : {
        ok: true,
        kind: 'tool-call',
        call: {
          responseId: 'r',
          callId: 'c',
          name: 'fly_to_location',
          arguments: { query: 'Los Angeles', viewMode: 'overview' },
        },
      },
  });
  const first = await coordinator.register({
    commentId: 'm1',
    text: 'navigate to los angeles ca',
    author: { displayName: 'Marcus', handle: 'marcusmanagementservices488' },
    authorHandle: 'marcusmanagementservices488',
    agentMode: 'execute',
  }, binding);
  await ledger.compareAndSet(first.record.id, 'awaiting-execution', {
    state: 'executing',
    captureEpoch: 'epoch',
  });
  const done = await coordinator.acceptToolResult(first.record.id, binding, {
    ok: true,
    action: 'fly_to_location',
    label: 'Los Angeles, CA, USA',
  });
  assert.equal(done.record.state, 'succeeded');
  assert.match(done.record.answer, /@marcusmanagementservices488/);
  assert.match(done.record.answer, /30 seconds to reply/);
  assert.match(done.record.answer, /Los Angeles/);

  const other = await coordinator.register({
    commentId: 'o1',
    text: 'navigate to tokyo',
    author: { displayName: 'Other', handle: 'someoneelse' },
    authorHandle: 'someoneelse',
    agentMode: 'execute',
  }, binding);
  assert.equal(other.queued, true);
  assert.equal(other.record.state, 'received');
  assert.match(other.record.reason, /Queued/);

  const follow = await coordinator.register({
    commentId: 'm2',
    text: 'yes show me 3D buildings',
    author: { displayName: 'Marcus', handle: 'marcusmanagementservices488' },
    authorHandle: 'marcusmanagementservices488',
    agentMode: 'execute',
  }, binding);
  assert.equal(follow.queued, undefined);
  assert.equal(follow.record.state, 'awaiting-execution');
  assert.equal(follow.record.validatedTool.name, 'fly_to_location');

  clock.t += HOST_FOLLOWUP_MS + 1;
  coordinator.tick();
  const later = await coordinator.register({
    commentId: 'o2',
    text: 'navigate to tokyo',
    author: { displayName: 'Other', handle: 'someoneelse' },
    authorHandle: 'someoneelse',
    agentMode: 'execute',
  }, binding);
  assert.notEqual(later.record.state, 'received');
});
