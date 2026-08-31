import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { createLiveStreamController } from './liveStream.js';
import {
  YOUTUBE_LIVE_REQUEST_HEADER,
  createYoutubeLiveMiddleware,
} from './youtubeLiveServer.js';

const KEY = 'abcd-1234-efgh-5678';
const MUTATE = { [YOUTUBE_LIVE_REQUEST_HEADER]: '1' };

function invoke(middleware, { method = 'GET', url = '/', body = '', headers = {}, remoteAddress = '127.0.0.1' } = {}) {
  return new Promise((resolve, reject) => {
    const listeners = new Map();
    const req = {
      method,
      url,
      headers: { cookie: 'gev_youtube_session=session-1', ...headers },
      socket: { remoteAddress },
      on(event, handler) {
        listeners.set(event, handler);
        if (listeners.has('data') && listeners.has('end')) {
          queueMicrotask(() => {
            if (body) listeners.get('data')(Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)));
            listeners.get('end')();
          });
        }
        return this;
      },
    };
    const res = {
      statusCode: 200,
      writableEnded: false,
      setHeader() {},
      end(payload) {
        this.writableEnded = true;
        resolve({ status: this.statusCode, body: payload ? JSON.parse(payload) : {} });
      },
    };
    Promise.resolve(middleware(req, res, reject)).catch(reject);
  });
}

function fakeFfmpeg() {
  const proc = new EventEmitter();
  proc.written = [];
  proc.killed = false;
  proc.stdin = new EventEmitter();
  proc.stdin.write = (chunk) => { proc.written.push(chunk); return true; };
  proc.stdin.end = () => { proc.stdin.ended = true; };
  proc.stderr = new EventEmitter();
  proc.signals = [];
  proc.kill = (signal) => { proc.killed = true; proc.signals.push(signal); };
  return proc;
}

function fakeBrowser() {
  const browser = { closed: false, frames: 0 };
  browser.startScreencast = (onFrame) => {
    browser.frames += 1;
    onFrame(Buffer.from('jpeg-frame'));
    return Promise.resolve();
  };
  browser.close = () => { browser.closed = true; return Promise.resolve(); };
  return browser;
}

function encoderLive(overrides = {}) {
  return createLiveStreamController({
    spawn: () => fakeFfmpeg(),
    launchBrowser: async () => fakeBrowser(),
    chromiumPath: '/usr/bin/chromium',
    resolveFfmpeg: () => '/usr/bin/ffmpeg',
    probeCapture: async (url) => ({ url, status: 200 }),
    ...overrides,
  });
}

function signedIn(live, authorizeRequest) {
  return createYoutubeLiveMiddleware({
    live,
    authorizeRequest: authorizeRequest || (async () => ({ sessionId: 'yt-1', canWrite: true })),
  });
}

const START_BODY = {
  ingestUrl: 'rtmp://a.rtmp.youtube.com/live2',
  streamKey: KEY,
  captureUrl: 'http://localhost:4173/',
};

test('a signed-in operator starts and stops through /api/youtube/live without exposing the key', async () => {
  const spawned = [];
  const proc = fakeFfmpeg();
  const live = encoderLive({
    spawn: (bin, args) => { spawned.push({ bin, args }); return proc; },
  });
  const middleware = signedIn(live);

  const read = await invoke(middleware);
  assert.equal(read.status, 200);
  assert.equal(read.body.live.status, 'idle');

  const started = await invoke(middleware, {
    method: 'POST',
    url: '/start',
    headers: MUTATE,
    body: START_BODY,
  });
  assert.equal(started.status, 202);
  assert.equal(started.body.live.status, 'encoding');
  assert.equal(started.body.live.target, 'rtmp://a.rtmp.youtube.com/live2/***');
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].bin, '/usr/bin/ffmpeg');
  const argv = spawned[0].args.join(' ');
  assert.match(argv, /-c:v libx264/);
  assert.match(argv, /-pix_fmt yuv420p/);
  assert.match(argv, /-c:a aac/);
  assert.match(argv, /-f flv/);
  assert.equal(spawned[0].args[spawned[0].args.indexOf('-g') + 1], '48');
  assert.ok(!JSON.stringify(started.body).includes(KEY));

  const stopped = await invoke(middleware, { method: 'POST', url: '/stop', headers: MUTATE });
  assert.equal(stopped.status, 200);
  assert.equal(stopped.body.live.status, 'stopped');
  assert.ok(!JSON.stringify(stopped.body).includes(KEY));
});

test('unauthenticated callers cannot start a broadcast', async () => {
  let started = 0;
  const middleware = createYoutubeLiveMiddleware({
    live: {
      status: () => ({ status: 'idle', log: [] }),
      start: async () => { started += 1; return { status: 'live', log: [] }; },
      stop: async () => ({ status: 'stopped', log: [] }),
    },
    authorizeRequest: async () => null,
  });
  const response = await invoke(middleware, {
    method: 'POST',
    url: '/start',
    headers: MUTATE,
    body: START_BODY,
  });
  assert.equal(response.status, 401);
  assert.equal(response.body.error.kind, 'authentication');
  assert.equal(started, 0);
});

test('driving the encoder requires the anti-CSRF header', async () => {
  let started = 0;
  const middleware = signedIn({
    status: () => ({ status: 'idle', log: [] }),
    start: async () => { started += 1; return { status: 'live', log: [] }; },
    stop: async () => ({ status: 'stopped', log: [] }),
  });
  const response = await invoke(middleware, { method: 'POST', url: '/start', body: START_BODY });
  assert.equal(response.status, 403);
  assert.equal(response.body.error.kind, 'csrf');
  assert.equal(started, 0);
});

test('non-RTMP ingest is refused by the shipped encoder, not a stub', async () => {
  const middleware = signedIn(encoderLive());
  const response = await invoke(middleware, {
    method: 'POST',
    url: '/start',
    headers: MUTATE,
    body: { ingestUrl: 'file:///etc/passwd', streamKey: KEY, captureUrl: 'http://localhost:4173/' },
  });
  assert.equal(response.status, 400);
  assert.match(response.body.error.message, /rtmp/i);
  assert.notEqual(response.body.live?.status, 'live');
});

test('http ingest is refused the same way', async () => {
  const middleware = signedIn(encoderLive());
  const response = await invoke(middleware, {
    method: 'POST',
    url: '/start',
    headers: MUTATE,
    body: { ingestUrl: 'http://example.com/live', streamKey: KEY, captureUrl: 'http://localhost:4173/' },
  });
  assert.equal(response.status, 400);
  assert.match(response.body.error.message, /rtmp/i);
});

test('a start while already live is a conflict', async () => {
  const middleware = signedIn(encoderLive());
  const first = await invoke(middleware, {
    method: 'POST', url: '/start', headers: MUTATE, body: START_BODY,
  });
  assert.equal(first.status, 202);
  const second = await invoke(middleware, {
    method: 'POST',
    url: '/start',
    headers: MUTATE,
    body: { ...START_BODY, streamKey: 'other-key-zzzz' },
  });
  assert.equal(second.status, 409);
  assert.equal(second.body.error.kind, 'conflict');
  await invoke(middleware, { method: 'POST', url: '/stop', headers: MUTATE });
});

test('a missing ffmpeg is an error status, not live', async () => {
  const middleware = signedIn(encoderLive({
    resolveFfmpeg: () => null,
    spawn: () => { throw new Error('should not spawn ffmpeg'); },
    launchBrowser: async () => { throw new Error('should not launch a browser'); },
  }));
  const response = await invoke(middleware, {
    method: 'POST',
    url: '/start',
    headers: MUTATE,
    body: START_BODY,
  });
  assert.equal(response.status, 502);
  assert.equal(response.body.live.status, 'error');
  assert.match(response.body.live.error, /ffmpeg/i);
  assert.ok(!JSON.stringify(response.body).includes(KEY));
});

test('preflight is loopback-only and reports encoder readiness without a cookie', async () => {
  const previous = process.env.GEV_AUTO_GO_LIVE;
  process.env.GEV_AUTO_GO_LIVE = '1';
  try {
    const middleware = createYoutubeLiveMiddleware({
      authorizeRequest: async () => null,
      findWritableAuthorization: async () => null,
    });
    const remote = await invoke(middleware, { url: '/preflight', remoteAddress: '203.0.113.9' });
    assert.equal(remote.status, 403);

    const local = await invoke(middleware, { url: '/preflight' });
    assert.equal(local.status, 200);
    assert.equal(local.body.ready, false);
    assert.equal(local.body.authenticated, false);
    assert.equal(local.body.autoGoLive, true);
    assert.equal(typeof local.body.chrome, 'boolean');
    assert.equal(typeof local.body.ffmpeg, 'boolean');
  } finally {
    if (previous === undefined) delete process.env.GEV_AUTO_GO_LIVE;
    else process.env.GEV_AUTO_GO_LIVE = previous;
  }
});

test('go-now is loopback-only and uses the in-process writable session', async () => {
  let calls = 0;
  const middleware = createYoutubeLiveMiddleware({
    authorizeRequest: async () => null,
    findWritableAuthorization: async () => ({ sessionId: 'yt-1', canWrite: true }),
    goNow: async ({ authorization, body }) => {
      calls += 1;
      assert.equal(authorization.sessionId, 'yt-1');
      assert.equal(body.title, "God's Eye View LIVE");
      return {
        broadcast: { id: 'b1', watchUrl: 'https://www.youtube.com/watch?v=b1' },
        live: { status: 'encoding' },
      };
    },
  });

  const remote = await invoke(middleware, {
    method: 'POST',
    url: '/go-now',
    body: { title: "God's Eye View LIVE" },
    headers: {},
  });
  // invoke() defaults socket to 127.0.0.1 — override via a custom call
  assert.equal(remote.status, 202);
  assert.equal(remote.body.broadcast.watchUrl, 'https://www.youtube.com/watch?v=b1');
  assert.equal(calls, 1);

  const blocked = await new Promise((resolve, reject) => {
    const req = {
      method: 'POST',
      url: '/go-now',
      headers: {},
      socket: { remoteAddress: '203.0.113.9' },
      on(event, handler) {
        if (event === 'end') queueMicrotask(handler);
        return this;
      },
    };
    const res = {
      statusCode: 200,
      writableEnded: false,
      setHeader() {},
      end(payload) {
        this.writableEnded = true;
        resolve({ status: this.statusCode, body: payload ? JSON.parse(payload) : {} });
      },
    };
    Promise.resolve(middleware(req, res, reject)).catch(reject);
  });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.error.kind, 'forbidden');

  const unsigned = createYoutubeLiveMiddleware({
    authorizeRequest: async () => null,
    findWritableAuthorization: async () => null,
    goNow: async () => { throw new Error('should not run'); },
  });
  const denied = await invoke(unsigned, { method: 'POST', url: '/go-now', body: {} });
  assert.equal(denied.status, 401);
});

test('GET /session is public and never requires a YouTube cookie', async () => {
  const middleware = createYoutubeLiveMiddleware({
    live: {
      status: () => ({ status: 'idle', target: '', log: [] }),
      start: async () => { throw new Error('should not start'); },
      stop: async () => ({ status: 'stopped' }),
    },
    authorizeRequest: async () => null,
    sessionStatus: () => ({
      status: 'idle',
      broadcast: null,
    }),
  });
  const response = await invoke(middleware, { url: '/session' });
  assert.equal(response.status, 200);
  assert.equal(response.body.live.status, 'idle');
  assert.equal(response.body.sessionStatus, 'idle');
  assert.equal(response.body.broadcast, null);
});

test('POST /ingest-key starts the encoder without OAuth and redacts the stream key', async () => {
  const started = [];
  const middleware = createYoutubeLiveMiddleware({
    live: {
      status: () => ({ status: started.length ? 'encoding' : 'idle', target: 'rtmps://a.rtmp.youtube.com/live2/***', log: [] }),
      start: async (body) => {
        started.push(body);
        return { status: 'encoding', target: 'rtmps://a.rtmp.youtube.com/live2/***', log: [] };
      },
      stop: async () => ({ status: 'stopped' }),
    },
    authorizeRequest: async () => null,
  });

  const blocked = await invoke(middleware, {
    method: 'POST',
    url: '/ingest-key',
    body: { streamKey: KEY, watchUrl: 'https://www.youtube.com/watch?v=abc123def45' },
  });
  assert.equal(blocked.status, 403);
  assert.equal(started.length, 0);

  const missing = await invoke(middleware, {
    method: 'POST',
    url: '/ingest-key',
    headers: MUTATE,
    body: { watchUrl: 'https://www.youtube.com/watch?v=abc123def45' },
  });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error.kind, 'invalid');

  const startedRes = await invoke(middleware, {
    method: 'POST',
    url: '/ingest-key',
    headers: MUTATE,
    body: {
      streamKey: KEY,
      ingestUrl: 'rtmps://a.rtmp.youtube.com/live2',
      watchUrl: 'https://www.youtube.com/watch?v=abc123def45',
    },
  });
  assert.equal(startedRes.status, 202);
  assert.equal(startedRes.body.live.status, 'encoding');
  assert.equal(startedRes.body.broadcast.watchUrl, 'https://www.youtube.com/watch?v=abc123def45');
  assert.equal(started[0].streamKey, KEY);
  assert.ok(!JSON.stringify(startedRes.body).includes(KEY));

  const session = await invoke(middleware, { url: '/session' });
  assert.equal(session.status, 200);
  assert.equal(session.body.broadcast.watchUrl, 'https://www.youtube.com/watch?v=abc123def45');
  assert.ok(!JSON.stringify(session.body).includes(KEY));
});
