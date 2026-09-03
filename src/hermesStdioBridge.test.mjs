import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createHermesStdioBridge,
  encodeHermesFrame,
  parseHermesFrame,
  redactSecrets,
} from './hermesStdioBridge.js';

test('frames parse and secrets never survive redaction', () => {
  assert.equal(parseHermesFrame('').ok, false);
  assert.equal(parseHermesFrame('{').ok, false);
  assert.equal(parseHermesFrame(JSON.stringify({ type: 'final', text: 'hi' })).ok, true);
  assert.match(redactSecrets('key bb_live_wjQcWYVdZUHAY5p7zkinmLdGnW0 Bearer abc.def'), /\[redacted\]/);
  assert.doesNotMatch(redactSecrets('Bearer gev_secret_value'), /gev_secret_value/);
  assert.match(encodeHermesFrame({ type: 'ping' }), /\n$/);
});

test('in-process bridge correlates one turn and times out isolated ids', async () => {
  const bridge = createHermesStdioBridge({
    handler: async (frame) => {
      if (frame.type === 'turn') {
        return { type: 'tool_request', turnId: frame.turnId, callId: 'c1', name: 'zoom_to_globe', arguments: {} };
      }
      return { type: 'final', turnId: frame.turnId, text: 'Globe framed.' };
    },
    timeoutMs: 200,
  });
  bridge.start();
  const first = await bridge.request({ type: 'turn', turnId: 't1', comment: 'zoom out' });
  assert.equal(first.type, 'tool_request');
  assert.equal(first.name, 'zoom_to_globe');
  const done = await bridge.request({ type: 'tool_result', turnId: 't1', callId: 'c1', result: { ok: true } });
  assert.equal(done.type, 'final');
  assert.match(done.text, /Globe/);
  bridge.stop();
});
