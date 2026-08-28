import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyYoutubeError,
  createYoutubeProxyMiddleware,
  normalizeYoutubePath,
  normalizeYoutubeRequest,
} from './youtubeProxy.js';

function invokeMiddleware(middleware, {
  method = 'GET',
  url = '/youtube/v3/channels?part=snippet&mine=true',
  headers = {},
} = {}) {
  return new Promise((resolve, reject) => {
    const responseHeaders = {};
    const req = { method, url, headers, socket: { remoteAddress: '127.0.0.1' } };
    const res = {
      statusCode: 200,
      writableEnded: false,
      setHeader(name, value) { responseHeaders[name] = value; },
      end(body) {
        this.writableEnded = true;
        resolve({
          status: this.statusCode,
          headers: responseHeaders,
          body: JSON.parse(body),
        });
      },
    };
    Promise.resolve(middleware(req, res, reject)).catch(reject);
  });
}

test('YouTube path normalization only accepts Data API v3 resources', () => {
  assert.equal(normalizeYoutubePath('/youtube/v3/videos'), '/youtube/v3/videos');
  assert.equal(normalizeYoutubePath('https://www.googleapis.com/youtube/v3/channels'), '/youtube/v3/channels');
  assert.throws(() => normalizeYoutubePath('https://evil.example/youtube/v3/videos'), /only youtube/i);
  assert.throws(() => normalizeYoutubePath('/upload/youtube/v3/videos'), /only youtube/i);
  assert.throws(() => normalizeYoutubePath('/youtube/v3/../admin'), /only youtube/i);
});

test('request normalization requires part and bounds pagination', () => {
  const request = normalizeYoutubeRequest('/youtube/v3/commentThreads', {
    part: 'snippet,replies',
    videoId: 'abc',
    maxResults: '100',
  });
  assert.equal(request.path, '/youtube/v3/commentThreads');
  assert.equal(request.params.get('maxResults'), '100');
  assert.match(request.cacheKey, /commentThreads\?/);
  assert.throws(
    () => normalizeYoutubeRequest('/youtube/v3/videos', { id: 'abc' }),
    /part parameter/,
  );
  assert.throws(
    () => normalizeYoutubeRequest('/youtube/v3/videos', { part: 'snippet', maxResults: '51' }),
    /maxResults/,
  );
  assert.throws(
    () => normalizeYoutubeRequest('/youtube/v3/videos', { part: 'snippet', key: 'secret' }),
    /not allowed/,
  );
});

test('live chat pagination allows the provider-specific result ceiling', () => {
  assert.equal(
    normalizeYoutubeRequest('/youtube/v3/liveChatMessages', { part: 'snippet', maxResults: '200' })
      .params.get('maxResults'),
    '200',
  );
  assert.throws(
    () => normalizeYoutubeRequest('/youtube/v3/liveChatMessages', { part: 'snippet', maxResults: '201' }),
    /1 to 200/,
  );
});

test('YouTube errors classify quota, comments, auth, and unavailable states', () => {
  assert.equal(classifyYoutubeError(403, { error: { message: 'quota', errors: [{ reason: 'quotaExceeded' }] } }).kind, 'quota');
  assert.equal(classifyYoutubeError(403, { error: { errors: [{ reason: 'commentsDisabled' }] } }).kind, 'comments-disabled');
  assert.equal(classifyYoutubeError(401, { error: { message: 'expired' } }).kind, 'authentication');
  assert.equal(classifyYoutubeError(400, { error: { message: 'Connection requires re-authorization (invalid_grant)' } }).kind, 'authentication');
  assert.equal(classifyYoutubeError(404, { error: { message: 'gone' } }).kind, 'not-found');
  assert.equal(classifyYoutubeError(429, {}).kind, 'rate-limit');
});

test('deployment-disabled middleware denies forged preview headers before connector use', async () => {
  let calls = 0;
  const middleware = createYoutubeProxyMiddleware({
    enabled: false,
    proxy: async () => {
      calls += 1;
      throw new Error('connector must not be reached');
    },
  });
  for (const headers of [
    { host: '127.0.0.1:5000' },
    { host: 'forged.replit.dev', origin: 'https://forged.replit.dev' },
  ]) {
    const response = await invokeMiddleware(middleware, { headers });
    assert.equal(response.status, 403);
    assert.equal(response.body.error.kind, 'forbidden');
    assert.match(response.body.error.message, /unavailable in public deployments/i);
  }
  assert.equal(calls, 0);
});
