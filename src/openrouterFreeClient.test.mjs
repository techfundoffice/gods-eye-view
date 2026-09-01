import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OPENROUTER_CHAT_URL,
  OPENROUTER_FREE_MODEL,
  catalogToolsToOpenRouter,
  createOpenRouterFreeRateLimiter,
  openRouterFreeModel,
  postOpenRouterChat,
} from './openrouterFreeClient.js';

test('openrouter/auto is refused so YouTube commands cannot bill', async () => {
  const saved = process.env.OPENROUTER_MODEL;
  process.env.OPENROUTER_MODEL = 'openrouter/auto';
  try {
    assert.equal(openRouterFreeModel(), OPENROUTER_FREE_MODEL);
  } finally {
    if (saved === undefined) delete process.env.OPENROUTER_MODEL;
    else process.env.OPENROUTER_MODEL = saved;
  }
  const result = await postOpenRouterChat({
    apiKey: 'sk-or-test',
    model: 'openrouter/auto',
    messages: [{ role: 'user', content: 'hi' }],
    fetchImpl: async () => { throw new Error('should not fetch'); },
    limiter: { tryTake: () => ({ ok: true }) },
  });
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'provider');
});

test('rate limiter trips before the provider after 20 calls in a minute', async () => {
  let now = 1_000;
  const limiter = createOpenRouterFreeRateLimiter({ rpm: 2, rpd: 3, now: () => now });
  assert.equal((await postOpenRouterChat({
    apiKey: 'k', messages: [], limiter,
    fetchImpl: async () => ({ ok: true, json: async () => ({ id: 'a', model: 'x:free' }) }),
  })).ok, true);
  assert.equal((await postOpenRouterChat({
    apiKey: 'k', messages: [], limiter,
    fetchImpl: async () => ({ ok: true, json: async () => ({ id: 'b', model: 'x:free' }) }),
  })).ok, true);
  const blocked = await postOpenRouterChat({
    apiKey: 'k', messages: [], limiter,
    fetchImpl: async () => ({ ok: true, json: async () => ({ id: 'c' }) }),
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.kind, 'rate-limited');
  assert.equal(blocked.status, 429);
});

test('catalog tools wrap into OpenAI-style function tools', () => {
  assert.deepEqual(catalogToolsToOpenRouter([{
    type: 'function', name: 'zoom_to_globe', description: 'Frame', parameters: { type: 'object' },
  }]), [{
    type: 'function',
    function: { name: 'zoom_to_globe', description: 'Frame', parameters: { type: 'object' } },
  }]);
});

test('missing key is unconfigured and does not hit the network', async () => {
  let called = false;
  const result = await postOpenRouterChat({
    apiKey: '',
    messages: [{ role: 'user', content: 'hi' }],
    fetchImpl: async () => { called = true; },
    limiter: { tryTake: () => ({ ok: true }) },
  });
  assert.equal(result.kind, 'unconfigured');
  assert.equal(called, false);
  assert.equal(OPENROUTER_CHAT_URL, 'https://openrouter.ai/api/v1/chat/completions');
});
