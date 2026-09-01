import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPublicResponsesInterpreter,
  parsePublicResponsesOutput,
} from './youtubePublicResponsesInterpreter.js';

const response = (payload, ok = true, status = 200) => ({
  ok, status, json: async () => payload,
});

test('strict output parser accepts validated calls and text completions', () => {
  assert.deepEqual(parsePublicResponsesOutput({
    id: 'resp', output: [{ type: 'function_call', call_id: 'call', name: 'zoom_to_globe', arguments: '{}' }],
  }, 'whole-globe'), {
    ok: true, kind: 'tool-call',
    call: { responseId: 'resp', callId: 'call', name: 'zoom_to_globe', arguments: {} },
  });
  assert.deepEqual(parsePublicResponsesOutput({
    id: 'resp', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Answer' }] }],
  }, 'analyze'), { ok: true, kind: 'complete', text: 'Answer' });
});

test('strict parser rejects malformed JSON, multiple calls, forbidden modes and ADMIN MCP', () => {
  assert.equal(parsePublicResponsesOutput({ id: 'r', output: [{ type: 'function_call', call_id: 'c', name: 'zoom_to_globe', arguments: '{' }] }, 'navigate').ok, false);
  assert.equal(parsePublicResponsesOutput({ id: 'r', output: [
    { type: 'function_call', call_id: 'a', name: 'zoom_to_globe', arguments: '{}' },
    { type: 'function_call', call_id: 'b', name: 'stop_tracking', arguments: '{}' },
  ] }, 'navigate').ok, false);
  assert.match(parsePublicResponsesOutput({ id: 'r', output: [
    { type: 'function_call', call_id: 'a', name: 'list_admin_plugins', arguments: '{}' },
  ] }, 'execute').reason, /not allowed/);
  assert.equal(parsePublicResponsesOutput({ id: 'r', output: [
    { type: 'function_call', call_id: 'a', name: 'fly_to_location', arguments: '{"query":"Paris"}' },
  ] }, 'analyze').ok, false);
});

test('request exposes only mode schemas and bounded public context', async () => {
  let request;
  const interpret = createPublicResponsesInterpreter({
    apiKey: 'secret', now: () => 100,
    fetchImpl: async (_url, init) => {
      request = JSON.parse(init.body);
      return response({ id: 'r', output: [{ type: 'message', content: [{ text: 'done' }] }] });
    },
  });
  await interpret({
    mode: 'whole-globe', comment: 'x'.repeat(700), viewer: 'v'.repeat(100),
    videoId: 'video', generation: 2, remainingTurns: 3, startedAt: 100,
    viewContext: { label: 'safe' },
  });
  assert.deepEqual(request.tools.map((tool) => tool.name), ['zoom_to_globe']);
  assert.equal(request.input.includes('secret'), false);
  assert.equal(request.input.includes('admin'), false);
  assert.equal(JSON.parse(request.input).comment.length, 500);
});

test('continuations bind previous response and outstanding call id', async () => {
  let request;
  const interpret = createPublicResponsesInterpreter({
    apiKey: 'secret', now: () => 100,
    fetchImpl: async (_url, init) => {
      request = JSON.parse(init.body);
      return response({ id: 'r2', output: [{ type: 'message', content: [{ text: 'finished' }] }] });
    },
  });
  await interpret({
    mode: 'analyze', remainingTurns: 2, startedAt: 100,
    previousResponseId: 'r1', callId: 'call1', toolResult: { ok: true },
  });
  assert.equal(request.previous_response_id, 'r1');
  assert.equal(request.input[0].call_id, 'call1');
  assert.equal(request.input[0].type, 'function_call_output');
});

test('budget exhaustion fails before provider access', async () => {
  let called = false;
  const interpret = createPublicResponsesInterpreter({
    apiKey: 'secret', now: () => 25_000,
    fetchImpl: async () => { called = true; },
  });
  await assert.rejects(interpret({ mode: 'analyze', remainingTurns: 1, startedAt: 0 }), /budget/i);
  assert.equal(called, false);
});