import assert from 'node:assert/strict';
import test from 'node:test';
import {
  YOUTUBE_MAX_REQUEST_BODY_BYTES,
  classifyYoutubeError,
  createYoutubeProxyMiddleware,
  isYoutubeWriteAllowed,
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

test('authenticated sessions isolate response caches even behind the same IP', async () => {
  let calls = 0;
  const middleware = createYoutubeProxyMiddleware({
    authorizeRequest: async (request) => ({ sessionId: request.headers['x-session'] }),
    proxy: async (_name, _path, _request, authorization) => {
      calls += 1;
      return new Response(JSON.stringify({ session: authorization.sessionId }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  const first = await invokeMiddleware(middleware, { headers: { 'x-session': 'user-a' } });
  const second = await invokeMiddleware(middleware, { headers: { 'x-session': 'user-b' } });
  const cached = await invokeMiddleware(middleware, { headers: { 'x-session': 'user-a' } });
  assert.equal(first.body.session, 'user-a');
  assert.equal(second.body.session, 'user-b');
  assert.equal(cached.body.session, 'user-a');
  assert.equal(calls, 2);
  assert.equal(cached.headers['X-YouTube-Cache'], 'HIT');
});

function invokeWrite(middleware, {
  method = 'POST',
  url = '/youtube/v3/liveBroadcasts?part=snippet,status',
  headers = {},
  body = '',
} = {}) {
  return new Promise((resolve, reject) => {
    const responseHeaders = {};
    const listeners = new Map();
    const req = {
      method,
      url,
      headers,
      socket: { remoteAddress: '127.0.0.1' },
      destroy() { this.destroyed = true; },
      on(event, handler) {
        listeners.set(event, handler);
        if (listeners.has('data') && listeners.has('end')) {
          queueMicrotask(() => {
            if (body) listeners.get('data')(Buffer.from(body));
            if (!this.destroyed) listeners.get('end')();
          });
        }
        return this;
      },
    };
    const res = {
      statusCode: 200,
      writableEnded: false,
      setHeader(name, value) { responseHeaders[name] = value; },
      end(payload) {
        this.writableEnded = true;
        resolve({ status: this.statusCode, headers: responseHeaders, body: JSON.parse(payload) });
      },
    };
    Promise.resolve(middleware(req, res, reject)).catch(reject);
  });
}

test('only the YouTube Live lifecycle is writable', () => {
  for (const [method, path] of [
    ['POST', '/youtube/v3/liveBroadcasts'],
    ['POST', '/youtube/v3/liveBroadcasts/bind'],
    ['POST', '/youtube/v3/liveBroadcasts/transition'],
    ['POST', '/youtube/v3/liveStreams'],
    ['DELETE', '/youtube/v3/liveStreams'],
  ]) {
    assert.ok(isYoutubeWriteAllowed(method, path), `${method} ${path}`);
  }
  for (const [method, path] of [
    ['POST', '/youtube/v3/videos'],
    ['DELETE', '/youtube/v3/playlists'],
    ['POST', '/youtube/v3/liveChatMessages'],
    ['PATCH', '/youtube/v3/liveBroadcasts'],
    ['GET', '/youtube/v3/liveBroadcasts'],
  ]) {
    assert.equal(isYoutubeWriteAllowed(method, path), false, `${method} ${path}`);
  }
});

test('write normalization rejects unlisted resources and bounds delete requests', () => {
  const insert = normalizeYoutubeRequest('/youtube/v3/liveBroadcasts', { part: 'snippet,status' }, 'POST');
  assert.equal(insert.method, 'POST');
  assert.match(insert.cacheKey, /^POST /);
  assert.throws(
    () => normalizeYoutubeRequest('/youtube/v3/videos', { part: 'snippet' }, 'POST'),
    /cannot be modified/,
  );
  assert.equal(
    normalizeYoutubeRequest('/youtube/v3/liveStreams', { id: 'stream-1' }, 'DELETE').params.get('id'),
    'stream-1',
  );
  assert.throws(
    () => normalizeYoutubeRequest('/youtube/v3/liveStreams', { part: 'snippet' }, 'DELETE'),
    /id parameter/,
  );
});

test('YouTube reports insufficient scope distinctly from a generic auth failure', () => {
  assert.equal(
    classifyYoutubeError(403, { error: { message: 'Request had insufficient authentication scopes.' } }).kind,
    'insufficient-scope',
  );
  assert.equal(
    classifyYoutubeError(403, { error: { errors: [{ reason: 'insufficientPermissions' }] } }).kind,
    'insufficient-scope',
  );
});

test('writes stay refused while live control is disabled', async () => {
  let calls = 0;
  const middleware = createYoutubeProxyMiddleware({
    proxy: async () => { calls += 1; throw new Error('upstream must not be reached'); },
  });
  const response = await invokeWrite(middleware, { body: '{"snippet":{"title":"x"}}' });
  assert.equal(response.status, 405);
  assert.equal(response.body.error.kind, 'method-not-allowed');
  assert.equal(calls, 0);
});

test('a read-only session is told to reconnect instead of spending quota', async () => {
  let calls = 0;
  const middleware = createYoutubeProxyMiddleware({
    writeEnabled: true,
    authorizeRequest: async () => ({ sessionId: 'user-a', canWrite: false }),
    proxy: async () => { calls += 1; throw new Error('upstream must not be reached'); },
  });
  const response = await invokeWrite(middleware);
  assert.equal(response.status, 403);
  assert.equal(response.body.error.kind, 'insufficient-scope');
  assert.equal(calls, 0);
});

test('an authorized write forwards method and body and is never cached', async () => {
  const seen = [];
  const middleware = createYoutubeProxyMiddleware({
    writeEnabled: true,
    authorizeRequest: async () => ({ sessionId: 'user-a', canWrite: true }),
    proxy: async (_name, path, _req, _auth, options) => {
      seen.push({ path, method: options.method, body: options.body });
      return new Response(JSON.stringify({ id: `broadcast-${seen.length}` }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  const first = await invokeWrite(middleware, { body: '{"snippet":{"title":"Live"}}' });
  assert.equal(first.status, 200);
  assert.equal(first.body.id, 'broadcast-1');
  assert.equal(first.headers['X-YouTube-Cache'], 'BYPASS');
  assert.equal(seen[0].method, 'POST');
  assert.deepEqual(seen[0].body, { snippet: { title: 'Live' } });

  // An identical repeat must reach YouTube again rather than replay a cache hit.
  const second = await invokeWrite(middleware, { body: '{"snippet":{"title":"Live"}}' });
  assert.equal(second.body.id, 'broadcast-2');
  assert.equal(seen.length, 2);
});

test('write requests reject unlisted paths, oversized bodies, and non-object JSON', async () => {
  let calls = 0;
  const middleware = createYoutubeProxyMiddleware({
    writeEnabled: true,
    authorizeRequest: async () => ({ sessionId: 'user-a', canWrite: true }),
    proxy: async () => { calls += 1; throw new Error('upstream must not be reached'); },
  });
  const unlisted = await invokeWrite(middleware, { url: '/youtube/v3/videos?part=snippet' });
  assert.equal(unlisted.status, 400);
  assert.match(unlisted.body.error.message, /cannot be modified/);

  const oversized = await invokeWrite(middleware, {
    body: JSON.stringify({ pad: 'x'.repeat(YOUTUBE_MAX_REQUEST_BODY_BYTES + 1) }),
  });
  assert.equal(oversized.status, 413);
  assert.equal(oversized.body.error.kind, 'request-too-large');

  const notAnObject = await invokeWrite(middleware, { body: '[1,2,3]' });
  assert.equal(notAnObject.status, 400);
  assert.match(notAnObject.body.error.message, /JSON object/);

  const malformed = await invokeWrite(middleware, { body: '{oops' });
  assert.equal(malformed.status, 400);
  assert.match(malformed.body.error.message, /must be JSON/);

  assert.equal(calls, 0);
});
