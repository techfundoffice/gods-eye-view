// `/api/google/place-suggest` middleware: missing key, empty query, stubbed
// upstream, and rejection of client-supplied upstream URLs.
//
// Run with: npm test   (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPlaceSuggestMiddleware } from '../vite.config.js';
import { DISNEYLAND_SUGGEST_FIXTURE } from './locationSuggest.fixture.mjs';

function invoke(middleware, url, method = 'GET') {
  return new Promise((resolve, reject) => {
    const result = { status: 0, headers: {}, body: '' };
    const res = {
      statusCode: 200,
      setHeader(name, value) { result.headers[name] = value; },
      end(body = '') {
        result.status = this.statusCode;
        result.body = String(body);
        resolve(result);
      },
    };
    Promise.resolve(middleware({ url, method, socket: { remoteAddress: '127.0.0.1' } }, res))
      .catch(reject);
  });
}

function jsonBody(result) {
  return JSON.parse(result.body);
}

test('missing Google key returns 503 and an empty suggestion list', async () => {
  const middleware = createPlaceSuggestMiddleware({
    getApiKey: () => '',
    getRateLimiter: () => null,
    fetchImpl: async () => {
      throw new Error('must not call Google without a key');
    },
  });
  const result = await invoke(middleware, '/api/google/place-suggest?q=Disneyland');
  assert.equal(result.status, 503);
  const body = jsonBody(result);
  assert.deepEqual(body.suggestions, []);
  assert.match(String(body.error), /GOOGLE_MAPS_API_KEY/);
});

test('empty query returns 400 and an empty suggestion list', async () => {
  let called = 0;
  const middleware = createPlaceSuggestMiddleware({
    getApiKey: () => 'test-key',
    getRateLimiter: () => null,
    fetchImpl: async () => { called += 1; return new Response('{}'); },
  });
  const blank = await invoke(middleware, '/api/google/place-suggest?q=');
  assert.equal(blank.status, 400);
  assert.deepEqual(jsonBody(blank).suggestions, []);
  const missing = await invoke(middleware, '/api/google/place-suggest');
  assert.equal(missing.status, 400);
  assert.deepEqual(jsonBody(missing).suggestions, []);
  assert.equal(called, 0);
});

test('stubbed Autocomplete payload keeps several address-distinguished Disneylands', async () => {
  const middleware = createPlaceSuggestMiddleware({
    getApiKey: () => 'test-key',
    getRateLimiter: () => null,
    fetchImpl: async () => new Response(JSON.stringify({
      suggestions: [
        {
          placePrediction: {
            text: { text: 'Disneyland Park, Anaheim, CA, USA' },
            structuredFormat: {
              mainText: { text: 'Disneyland Park' },
              secondaryText: { text: 'Anaheim, CA, USA' },
            },
          },
        },
        {
          placePrediction: {
            text: { text: 'Walt Disney World Resort, Florida, USA' },
            structuredFormat: {
              mainText: { text: 'Walt Disney World Resort' },
              secondaryText: { text: 'Florida, USA' },
            },
          },
        },
        {
          placePrediction: {
            text: { text: 'Disneyland Paris, Boulevard de Parc, Coupvray, France' },
            structuredFormat: {
              mainText: { text: 'Disneyland Paris' },
              secondaryText: { text: 'Boulevard de Parc, Coupvray, France' },
            },
          },
        },
        {
          placePrediction: {
            text: { text: 'Tokyo Disneyland, Maihama, Urayasu, Chiba, Japan' },
            structuredFormat: {
              mainText: { text: 'Tokyo Disneyland' },
              secondaryText: { text: 'Maihama, Urayasu, Chiba, Japan' },
            },
          },
        },
      ],
    }), { status: 200 }),
  });
  const result = await invoke(middleware, '/api/google/place-suggest?q=Disneyland');
  assert.equal(result.status, 200);
  const body = jsonBody(result);
  assert.ok(body.suggestions.length > 1);
  const blob = body.suggestions.map((row) => `${row.name} ${row.address}`).join('\n').toLowerCase();
  assert.match(blob, /anaheim/);
  assert.match(blob, /florida/);
  assert.match(blob, /france/);
  assert.match(blob, /japan/);
});

test('stubbed upstream returns name+address suggestions for Disneyland', async () => {
  const middleware = createPlaceSuggestMiddleware({
    getApiKey: () => 'test-key',
    getRateLimiter: () => null,
    fetchImpl: async () => new Response(JSON.stringify(DISNEYLAND_SUGGEST_FIXTURE), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  });
  const result = await invoke(middleware, '/api/google/place-suggest?q=Disneyland');
  assert.equal(result.status, 200);
  const body = jsonBody(result);
  assert.ok(Array.isArray(body.suggestions));
  assert.ok(body.suggestions.length > 1, 'must not collapse to a single first hit');
  for (const row of body.suggestions) {
    assert.ok(row.name);
    assert.ok(row.address);
  }
  const blob = body.suggestions.map((row) => `${row.name} ${row.address}`).join('\n').toLowerCase();
  assert.match(blob, /anaheim/);
  assert.match(blob, /france|chessy/);
  assert.match(blob, /japan|chiba|urayasu/);
  assert.match(blob, /orlando|florida|fl\b/);
});

test('client-supplied url/lat/lon never become the upstream or a view bias', async () => {
  let upstreamUrl = '';
  let upstreamBody = null;
  const middleware = createPlaceSuggestMiddleware({
    getApiKey: () => 'test-key',
    getRateLimiter: () => null,
    fetchImpl: async (url, options = {}) => {
      upstreamUrl = String(url);
      upstreamBody = JSON.parse(options.body || '{}');
      return new Response(JSON.stringify(DISNEYLAND_SUGGEST_FIXTURE), { status: 200 });
    },
  });
  const result = await invoke(
    middleware,
    '/api/google/place-suggest?q=Disneyland&url=https://evil.example/places&lat=30.27&lon=-97.74&radiusM=50',
  );
  assert.equal(result.status, 200);
  assert.equal(upstreamUrl, 'https://places.googleapis.com/v1/places:autocomplete');
  assert.doesNotMatch(upstreamUrl, /evil/);
  assert.equal(upstreamBody.input, 'Disneyland');
  assert.equal('locationBias' in upstreamBody, false);
  assert.equal('locationRestriction' in upstreamBody, false);
  assert.equal('includedRegionCodes' in upstreamBody, false);
  assert.equal('location' in upstreamBody, false);
  assert.equal('textQuery' in upstreamBody, false);
});

test('POST is rejected and upstream errors stay an empty list', async () => {
  const middleware = createPlaceSuggestMiddleware({
    getApiKey: () => 'test-key',
    getRateLimiter: () => null,
    fetchImpl: async () => { throw new Error('upstream down'); },
  });
  const post = await invoke(middleware, '/api/google/place-suggest?q=Disneyland', 'POST');
  assert.equal(post.status, 405);
  assert.deepEqual(jsonBody(post).suggestions, []);

  const failed = await invoke(middleware, '/api/google/place-suggest?q=Disneyland');
  assert.equal(failed.status, 502);
  assert.deepEqual(jsonBody(failed).suggestions, []);
});
