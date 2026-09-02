import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OPENROUTER_CHAT_URL,
  OPENROUTER_FREE_MODEL,
  catalogToolsToOpenRouter,
  retryAfterMs,
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
  });
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'provider');
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
  });
  assert.equal(result.kind, 'unconfigured');
  assert.equal(called, false);
  assert.equal(OPENROUTER_CHAT_URL, 'https://openrouter.ai/api/v1/chat/completions');
});

test('retry-after seconds and HTTP-date both become milliseconds', () => {
  const withHeader = (value) => ({ headers: { get: () => value } });
  assert.equal(retryAfterMs(withHeader('30')), 30_000);
  assert.equal(retryAfterMs(withHeader('0')), 0);
  const soon = new Date(Date.now() + 20_000).toUTCString();
  const parsed = retryAfterMs(withHeader(soon));
  assert.ok(parsed > 15_000 && parsed <= 20_000, `expected ~20s, got ${parsed}`);
  // Test doubles return bare objects; a missing headers bag must not throw.
  assert.equal(retryAfterMs({}), 0);
  assert.equal(retryAfterMs(withHeader('not-a-date')), 0);
});

test('a rate-limited response carries the upstream retry hint back to the caller', async () => {
  const result = await postOpenRouterChat({
    apiKey: 'sk-or-test',
    messages: [{ role: 'user', content: 'hi' }],
    fetchImpl: async () => ({
      ok: false,
      status: 429,
      headers: { get: (name) => (name === 'retry-after' ? '45' : null) },
      json: async () => ({ error: 'rate limited' }),
    }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'rate-limited');
  assert.equal(result.retryAfterMs, 45_000);
});
