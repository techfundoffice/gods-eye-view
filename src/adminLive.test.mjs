import assert from 'node:assert/strict';
import test from 'node:test';
import { createAdminMiddleware, ADMIN_REQUEST_HEADER } from './adminServer.js';
import { canStartLive, formatLiveUptime, liveStatusLabel, provisionYoutubeIngest } from './adminConsole.js';

function invoke(middleware, { method = 'GET', url = '/live', body = '', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const listeners = new Map();
    const req = {
      method,
      url,
      headers: { cookie: 'gev_admin=session-1', ...headers },
      socket: { remoteAddress: '127.0.0.1' },
      on(event, handler) {
        listeners.set(event, handler);
        if (listeners.has('data') && listeners.has('end')) {
          queueMicrotask(() => {
            if (body) listeners.get('data')(Buffer.from(body));
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

function adminWith(live) {
  return createAdminMiddleware({
    live,
    auth: {
      configured: true,
      authenticate: () => ({ expiresAt: Date.now() + 60_000 }),
      mcpEnabled: () => false,
      listApiKeys: () => [],
    },
    builder: { command: 'noop', list: () => [] },
  });
}

const MUTATE = { [ADMIN_REQUEST_HEADER]: '1' };

test('the console reads and drives the broadcast through /api/admin/live', async () => {
  const calls = [];
  const state = { status: 'idle', log: [], framesSent: 0, target: '', error: null };
  const middleware = adminWith({
    status: () => state,
    start: async (options) => { calls.push(options); return { ...state, status: 'live' }; },
    stop: async () => ({ ...state, status: 'stopped' }),
  });

  const read = await invoke(middleware);
  assert.equal(read.status, 200);
  assert.equal(read.body.live.status, 'idle');

  const started = await invoke(middleware, {
    method: 'POST',
    url: '/live/start',
    headers: MUTATE,
    body: JSON.stringify({ ingestUrl: 'rtmp://x/live2', streamKey: 'k' }),
  });
  assert.equal(started.status, 202);
  assert.equal(started.body.live.status, 'live');
  assert.equal(calls[0].ingestUrl, 'rtmp://x/live2');

  const stopped = await invoke(middleware, { method: 'POST', url: '/live/stop', headers: MUTATE });
  assert.equal(stopped.status, 200);
  assert.equal(stopped.body.live.status, 'stopped');
});

test('driving the broadcast requires the anti-CSRF header', async () => {
  let started = 0;
  const middleware = adminWith({
    status: () => ({ status: 'idle', log: [] }),
    start: async () => { started += 1; return { status: 'live', log: [] }; },
    stop: async () => ({ status: 'stopped', log: [] }),
  });
  const response = await invoke(middleware, { method: 'POST', url: '/live/start', body: '{}' });
  assert.equal(response.status, 403);
  assert.equal(response.body.error.kind, 'csrf');
  assert.equal(started, 0);
});

test('a rejected start reports the reason without a transport error', async () => {
  const middleware = adminWith({
    status: () => ({ status: 'idle', log: [] }),
    start: async () => { throw new Error('Only rtmp:// and rtmps:// ingest URLs are allowed'); },
    stop: async () => ({ status: 'stopped', log: [] }),
  });
  const response = await invoke(middleware, {
    method: 'POST',
    url: '/live/start',
    headers: MUTATE,
    body: JSON.stringify({ ingestUrl: 'file:///etc/passwd' }),
  });
  assert.equal(response.status, 400);
  assert.match(response.body.error.message, /rtmp/);
});

test('a start while already live is a conflict, not a silent replacement', async () => {
  const middleware = adminWith({
    status: () => ({ status: 'live', log: [] }),
    start: async () => {
      const error = new Error('A broadcast is already running. Stop it before starting another.');
      error.status = 409;
      throw error;
    },
    stop: async () => ({ status: 'stopped', log: [] }),
  });
  const response = await invoke(middleware, {
    method: 'POST', url: '/live/start', headers: MUTATE, body: '{}',
  });
  assert.equal(response.status, 409);
  assert.equal(response.body.error.kind, 'conflict');
});

test('broadcast status maps to a console label and gates the start button', () => {
  assert.equal(liveStatusLabel('live'), 'LIVE');
  assert.equal(liveStatusLabel('starting'), 'STARTING');
  assert.equal(liveStatusLabel('error'), 'ERROR');
  assert.equal(liveStatusLabel(''), 'OFFLINE');
  assert.equal(canStartLive({ status: 'idle' }), true);
  assert.equal(canStartLive({ status: 'stopped' }), true);
  assert.equal(canStartLive({ status: 'live' }), false);
  assert.equal(canStartLive({ status: 'starting' }), false);
});

test('provisioning creates a stream, a broadcast, and binds them', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined });
    if (url.includes('liveStreams')) {
      return new Response(JSON.stringify({
        id: 'stream-1',
        cdn: { ingestionInfo: { ingestionAddress: 'rtmp://a.rtmp.youtube.com/live2', streamName: 'key-1' } },
      }), { status: 200 });
    }
    if (url.includes('liveBroadcasts/bind')) return new Response('{}', { status: 200 });
    return new Response(JSON.stringify({ id: 'broadcast-1' }), { status: 200 });
  };

  const result = await provisionYoutubeIngest(fetchImpl, { title: 'Globe live' });
  assert.equal(result.ingestUrl, 'rtmp://a.rtmp.youtube.com/live2');
  assert.equal(result.streamKey, 'key-1');
  assert.equal(result.watchUrl, 'https://www.youtube.com/watch?v=broadcast-1');
  assert.deepEqual(seen.map((call) => call.method), ['POST', 'POST', 'POST']);
  assert.match(seen[0].url, /liveStreams\?part=snippet%2Ccdn%2Cstatus/);
  // Auto-start means YouTube flips the broadcast live once ffmpeg's bytes land.
  assert.equal(seen[1].body.contentDetails.enableAutoStart, true);
  assert.equal(seen[1].body.status.privacyStatus, 'unlisted');
  assert.match(seen[2].url, /liveBroadcasts\/bind\?.*streamId=stream-1/);

  await assert.rejects(() => provisionYoutubeIngest(fetchImpl, { title: '  ' }), /title is required/);
});

test('provisioning surfaces a read-only YouTube grant as insufficient scope', async () => {
  const fetchImpl = async () => new Response(
    JSON.stringify({ error: { kind: 'insufficient-scope', message: 'Reconnect YouTube to grant live-control permission.' } }),
    { status: 403 },
  );
  await assert.rejects(
    () => provisionYoutubeIngest(fetchImpl, { title: 'Globe live' }),
    (error) => error.kind === 'insufficient-scope' && /Reconnect YouTube/.test(error.message),
  );
});

test('broadcast uptime reads as H:MM:SS, drops the hour when short, and tolerates junk', () => {
  const base = Date.parse('2026-08-29T00:00:00.000Z');
  assert.equal(formatLiveUptime('2026-08-29T00:00:00.000Z', base + 65_000), '1:05');
  assert.equal(formatLiveUptime('2026-08-29T00:00:00.000Z', base + 3_725_000), '1:02:05');
  assert.equal(formatLiveUptime('2026-08-29T00:00:00.000Z', base), '0:00');
  // A clock skew must not render a negative duration.
  assert.equal(formatLiveUptime('2026-08-29T00:00:00.000Z', base - 5_000), '0:00');
  assert.equal(formatLiveUptime(null), '');
  assert.equal(formatLiveUptime('not-a-date'), '');
});
