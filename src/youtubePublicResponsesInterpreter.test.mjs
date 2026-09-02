import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  createPublicResponsesInterpreter,
  parsePublicChatCompletionsOutput,
  parsePublicResponsesOutput,
} from './youtubePublicResponsesInterpreter.js';
import { OPENROUTER_CHAT_URL, OPENROUTER_DEFAULT_MODEL } from './openrouterFreeClient.js';

const chat = (payload, ok = true, status = 200) => ({
  ok, status, json: async () => payload,
});

const zoomCall = {
  id: 'gen-1',
  model: 'meta-llama/llama-3.2-3b-instruct:free',
  choices: [{
    message: {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call',
        type: 'function',
        function: { name: 'zoom_to_globe', arguments: '{}' },
      }],
    },
  }],
};

test('chat completions parser accepts validated calls and text completions', () => {
  assert.deepEqual(parsePublicChatCompletionsOutput(zoomCall, 'whole-globe'), {
    ok: true, kind: 'tool-call',
    call: { responseId: 'gen-1', callId: 'call', name: 'zoom_to_globe', arguments: {} },
  });
  assert.deepEqual(parsePublicChatCompletionsOutput({
    id: 'gen-2',
    choices: [{ message: { role: 'assistant', content: 'Answer' } }],
  }, 'analyze'), { ok: true, kind: 'complete', text: 'Answer' });
});

test('legacy Responses fixtures still parse through the compatibility wrapper', () => {
  assert.deepEqual(parsePublicResponsesOutput({
    id: 'resp', output: [{ type: 'function_call', call_id: 'call', name: 'zoom_to_globe', arguments: '{}' }],
  }, 'whole-globe'), {
    ok: true, kind: 'tool-call',
    call: { responseId: 'resp', callId: 'call', name: 'zoom_to_globe', arguments: {} },
  });
});

test('strict parser rejects malformed JSON, multiple calls, forbidden modes and ADMIN MCP', () => {
  assert.equal(parsePublicChatCompletionsOutput({
    id: 'r',
    choices: [{ message: { tool_calls: [{ id: 'c', function: { name: 'zoom_to_globe', arguments: '{' } }] } }],
  }, 'navigate').ok, false);
  assert.equal(parsePublicChatCompletionsOutput({
    id: 'r',
    choices: [{ message: { tool_calls: [
      { id: 'a', function: { name: 'zoom_to_globe', arguments: '{}' } },
      { id: 'b', function: { name: 'stop_tracking', arguments: '{}' } },
    ] } }],
  }, 'navigate').ok, false);
  assert.match(parsePublicChatCompletionsOutput({
    id: 'r',
    choices: [{ message: { tool_calls: [
      { id: 'a', function: { name: 'list_admin_plugins', arguments: '{}' } },
    ] } }],
  }, 'execute').reason, /not allowed/);
  assert.equal(parsePublicChatCompletionsOutput({
    id: 'r',
    choices: [{ message: { tool_calls: [
      { id: 'a', function: { name: 'fly_to_location', arguments: '{"query":"Paris"}' } },
    ] } }],
  }, 'analyze').ok, false);
});

test('request posts to OpenRouter free with OpenAI-style tools and bounded public context', async () => {
  let url;
  let request;
  const interpret = createPublicResponsesInterpreter({
    apiKey: 'secret', now: () => 100,
    limiter: { tryTake: () => ({ ok: true }) },
    fetchImpl: async (postedUrl, init) => {
      url = postedUrl;
      request = JSON.parse(init.body);
      return chat({ id: 'r', choices: [{ message: { content: 'done' } }] });
    },
  });
  await interpret({
    mode: 'whole-globe', comment: 'x'.repeat(700), viewer: 'v'.repeat(100),
    videoId: 'video', generation: 2, remainingTurns: 3, startedAt: 100,
    viewContext: { label: 'safe' },
  });
  assert.equal(url, OPENROUTER_CHAT_URL);
  assert.equal(request.model, OPENROUTER_DEFAULT_MODEL);
  assert.deepEqual(request.tools.map((tool) => tool.function.name), ['zoom_to_globe']);
  assert.equal(request.messages[0].role, 'system');
  const user = JSON.parse(request.messages[1].content);
  assert.equal(user.comment.length, 500);
  assert.equal(JSON.stringify(request).includes('secret'), false);
  assert.equal(JSON.stringify(user).toLowerCase().includes('admin'), false);
});

test('continuations replay the outstanding call as chat tool results and resend tools', async () => {
  let request;
  const interpret = createPublicResponsesInterpreter({
    apiKey: 'secret', now: () => 100,
    limiter: { tryTake: () => ({ ok: true }) },
    fetchImpl: async (_url, init) => {
      request = JSON.parse(init.body);
      return chat({ id: 'r2', choices: [{ message: { content: 'finished' } }] });
    },
  });
  await interpret({
    mode: 'analyze', remainingTurns: 2, startedAt: 100, comment: 'look',
    previousResponseId: 'r1', callId: 'call1', toolResult: { ok: true },
    priorCall: { name: 'get_current_view_state', arguments: {} },
  });
  assert.equal(request.tools.length > 0, true);
  assert.equal(request.messages.at(-1).role, 'tool');
  assert.equal(request.messages.at(-1).tool_call_id, 'call1');
  assert.equal(request.messages.at(-2).tool_calls[0].function.name, 'get_current_view_state');
});

test('budget exhaustion fails before provider access', async () => {
  let called = false;
  const interpret = createPublicResponsesInterpreter({
    apiKey: 'secret', now: () => 25_000,
    fetchImpl: async () => { called = true; },
  });
  await assert.rejects(interpret({ mode: 'analyze', remainingTurns: 0, startedAt: 0 }), /budget/i);
  assert.equal(called, false);
});

test('public interpreter never posts to api.openai.com', () => {
  const src = fs.readFileSync(new URL('./youtubePublicResponsesInterpreter.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /api\.openai\.com/);
});
