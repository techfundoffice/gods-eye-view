import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveModelCapabilities } from './modelCapabilities.js';

test('model capabilities conservatively resolve vision in one place', () => {
  assert.equal(resolveModelCapabilities('google/gemini-3.8-flash').acceptsImages, true);
  assert.deepEqual(
    Object.keys(resolveModelCapabilities('google/gemini-3.8-flash').limits).includes('maxVideoFrames'),
    true,
  );
  assert.equal(resolveModelCapabilities('google/gemini-3.8-flash').provider, 'google');
  assert.equal(resolveModelCapabilities('google/gemini-3.8-flash').video, true);
  assert.equal(resolveModelCapabilities('openrouter/free').acceptsImages, false);
  assert.equal(resolveModelCapabilities('unknown/vendor-model').contentFormat, 'text');
});