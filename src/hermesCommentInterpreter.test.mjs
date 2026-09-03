import test from 'node:test';
import assert from 'node:assert/strict';
import { createHermesStdioBridge } from './hermesStdioBridge.js';
import { createHermesCommentInterpreter } from './hermesCommentInterpreter.js';

test('Hermes interpreter returns a view-safe tool call then a final reply', async () => {
  const bridge = createHermesStdioBridge({
    handler: async (frame) => {
      if (frame.type === 'turn') {
        return {
          type: 'tool_request',
          turnId: frame.turnId,
          callId: 'call-1',
          name: 'fly_to_location',
          arguments: { query: 'Los Angeles', viewMode: 'overview' },
        };
      }
      return { type: 'final', turnId: frame.turnId, text: '@ada Map overview of Los Angeles is up.' };
    },
  });
  bridge.start();
  const interpret = createHermesCommentInterpreter({ bridge, id: () => 'turn-1' });
  const first = await interpret({ comment: 'navigate to los angeles', viewer: 'ada' });
  assert.equal(first.kind, 'tool-call');
  assert.equal(first.call.name, 'fly_to_location');
  assert.equal(first.call.arguments.viewMode, 'overview');
  const done = await interpret({
    comment: 'navigate to los angeles',
    previousResponseId: first.call.responseId,
    callId: first.call.callId,
    toolResult: { ok: true, label: 'Los Angeles, CA, USA', rangeM: 28000 },
  });
  assert.equal(done.kind, 'complete');
  assert.match(done.text, /Los Angeles/);
  bridge.stop();
});

test('ADMIN tools requested by Hermes are rejected at the interpreter boundary', async () => {
  const bridge = createHermesStdioBridge({
    handler: async (frame) => ({
      type: 'tool_request',
      turnId: frame.turnId,
      callId: 'x',
      name: 'create_admin_plugin',
      arguments: { name: 'nope' },
    }),
  });
  bridge.start();
  const interpret = createHermesCommentInterpreter({ bridge, id: () => 't' });
  const result = await interpret({ comment: 'hack admin' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /boundary|not allowed|outside/i);
  bridge.stop();
});
