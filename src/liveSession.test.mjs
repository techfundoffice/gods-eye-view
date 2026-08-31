import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { createLiveStreamController } from './liveStream.js';
import {
  YOUTUBE_NOT_RECEIVED,
  canStartLive,
  createLiveSessionController,
  deriveLiveSessionStatus,
  describeAccountPhase,
  describeLiveSession,
  liveStatusLabel,
} from './liveSession.js';

const KEY = 'abcd-1234-efgh-5678';

function fakeFfmpeg() {
  const proc = new EventEmitter();
  proc.written = [];
  proc.stdin = new EventEmitter();
  proc.stdin.write = (chunk) => { proc.written.push(chunk); return true; };
  proc.stdin.end = () => { proc.stdin.ended = true; };
  proc.stderr = new EventEmitter();
  proc.kill = () => { proc.killed = true; };
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

function encoderWith(overrides = {}) {
  return createLiveStreamController({
    spawn: () => fakeFfmpeg(),
    launchBrowser: async () => fakeBrowser(),
    chromiumPath: '/usr/bin/chromium',
    resolveFfmpeg: () => '/usr/bin/ffmpeg',
    probeCapture: async (url) => ({ url, status: 200 }),
    ...overrides,
  });
}

const START = {
  ingestUrl: 'rtmp://a.rtmp.youtube.com/live2',
  streamKey: KEY,
  captureUrl: 'http://localhost:4173/',
};

async function waitForFrames(session) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (session.status().framesSent > 0) return session.status();
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`timed out waiting for encoder frames; last status ${session.status().status}`);
}

function binding() {
  return {
    broadcastId: 'broadcast-1',
    streamId: 'stream-1',
    title: 'Globe live',
    privacy: 'unlisted',
    watchUrl: 'https://www.youtube.com/watch?v=broadcast-1',
    lifeCycleStatus: 'ready',
    ingestUrl: 'rtmps://a.rtmp.youtube.com/live2',
    streamKey: KEY,
  };
}

test('derived status stays waiting until YouTube has received the stream', () => {
  const encoding = { status: 'encoding', framesSent: 0 };
  assert.equal(deriveLiveSessionStatus(encoding, null, binding()), 'encoding');
  assert.equal(
    deriveLiveSessionStatus({ status: 'encoding', framesSent: 4 }, null, binding()),
    'waiting-for-youtube',
  );
  assert.equal(
    deriveLiveSessionStatus({ status: 'encoding', framesSent: 4 }, { received: true }, binding()),
    'live',
  );
  assert.equal(
    deriveLiveSessionStatus({ status: 'encoding', framesSent: 4 }, null, null),
    'ingesting',
  );
  assert.equal(deriveLiveSessionStatus({ status: 'error' }, { received: true }, binding()), 'error');
});

test('public session JSON never includes the stream key and names the waiting state', () => {
  const view = describeLiveSession({
    status: 'encoding',
    framesSent: 12,
    framesDropped: 0,
    target: 'rtmps://a.rtmp.youtube.com/live2/***',
    captureUrl: 'http://localhost:4173/',
    settings: { width: 1280, height: 720, fps: 24, videoBitrateKbps: 2500, audioSource: 'silent' },
    error: null,
    log: ['Publishing to rtmps://a.rtmp.youtube.com/live2/***'],
    startedAt: '2026-08-30T00:00:00.000Z',
  }, {
    binding: binding(),
    health: { received: false, streamStatus: 'ready', healthStatus: 'noData', broadcastStatus: 'ready', message: YOUTUBE_NOT_RECEIVED },
    account: describeAccountPhase({ canWrite: true }),
    encoderReady: { ready: true, message: 'ffmpeg and Chromium are available' },
  });
  assert.equal(view.status, 'waiting-for-youtube');
  assert.equal(view.phases.youtube.message, YOUTUBE_NOT_RECEIVED);
  assert.equal(view.phases.youtube.ready, false);
  assert.equal(view.broadcast.target, 'rtmps://a.rtmp.youtube.com/live2/***');
  assert.ok(!JSON.stringify(view).includes(KEY));
  assert.equal(canStartLive(view), false);
  assert.equal(liveStatusLabel(view.status), 'WAITING FOR YOUTUBE');
});

test('a pasted-key start without a broadcast id is ingesting, not live', async () => {
  const session = createLiveSessionController({
    encoder: encoderWith(),
    encoderReady: () => ({ ready: true, message: 'ok' }),
  });
  await session.start(START);
  const started = await waitForFrames(session);
  assert.equal(started.status, 'ingesting');
  assert.match(started.phases.youtube.message, /no broadcast id/);
  assert.ok(!JSON.stringify(started).includes(KEY));
  await session.stop();
});

test('start with a stored broadcast uses the server key and waits for YouTube', async () => {
  const spawned = [];
  const session = createLiveSessionController({
    encoder: encoderWith({
      spawn: (bin, args) => {
        spawned.push(args);
        return fakeFfmpeg();
      },
    }),
    encoderReady: () => ({ ready: true, message: 'ok' }),
    pollMs: 10_000,
  });
  const call = async (resource, options) => {
    if (resource === 'liveBroadcasts' && options.method === 'POST') {
      return { id: 'broadcast-1', status: { lifeCycleStatus: 'ready' } };
    }
    if (resource === 'liveStreams') {
      return {
        id: 'stream-1',
        cdn: {
          ingestionInfo: {
            rtmpsIngestionAddress: 'rtmps://a.rtmp.youtube.com/live2',
            streamName: KEY,
          },
        },
      };
    }
    if (resource === 'liveBroadcasts/bind') return { id: 'broadcast-1' };
    return {
      items: [{
        id: 'broadcast-1',
        snippet: { title: 'Globe live' },
        status: { privacyStatus: 'unlisted', lifeCycleStatus: 'ready' },
        contentDetails: { boundStreamId: 'stream-1' },
      }],
    };
  };
  session.bindAuth({ canWrite: true, getAccessToken: async () => 'token' }, async () => ({
    ok: true,
    json: async () => ({}),
  }));
  const provisioned = await session.provision({ title: 'Globe live' }, call);
  assert.ok(!JSON.stringify(provisioned).includes(KEY));
  assert.equal(provisioned.broadcast.id, 'broadcast-1');

  await session.start({
    broadcastId: 'broadcast-1',
    captureUrl: 'http://localhost:4173/',
  }, { call });
  const started = await waitForFrames(session);
  assert.equal(started.status, 'waiting-for-youtube');
  assert.equal(started.phases.youtube.message, YOUTUBE_NOT_RECEIVED);
  assert.ok(spawned[0].includes(`rtmps://a.rtmp.youtube.com/live2/${KEY}`));
  assert.ok(!JSON.stringify(started).includes(KEY));
  await session.stop();
});

test('a YouTube poll flipping the stream active promotes the session to live', async () => {
  let streamStatus = 'ready';
  let lifeCycleStatus = 'ready';
  const call = async (resource) => {
    if (resource === 'liveStreams') {
      return { items: [{ status: { streamStatus, healthStatus: { status: 'good' } } }] };
    }
    return { items: [{ status: { lifeCycleStatus } }] };
  };
  const session = createLiveSessionController({
    encoder: encoderWith(),
    encoderReady: () => ({ ready: true, message: 'ok' }),
    pollMs: 10_000,
  });
  await session.provision({ title: 'Globe live' }, async (resource) => {
    if (resource === 'liveStreams') {
      return {
        id: 'stream-1',
        cdn: { ingestionInfo: { rtmpsIngestionAddress: 'rtmps://a.rtmp.youtube.com/live2', streamName: KEY } },
      };
    }
    if (resource === 'liveBroadcasts/bind') return {};
    return { id: 'broadcast-1', status: { lifeCycleStatus: 'ready' } };
  });
  await session.start({ broadcastId: 'broadcast-1', captureUrl: 'http://localhost:4173/' }, { call });
  await waitForFrames(session);
  assert.equal(session.status().status, 'waiting-for-youtube');

  streamStatus = 'active';
  lifeCycleStatus = 'live';
  await session.pollNow(call);
  assert.equal(session.status().status, 'live');
  assert.equal(session.status().phases.youtube.ready, true);
  await session.stop();
});

test('quota during YouTube poll does not stop the encoder', async () => {
  const session = createLiveSessionController({
    encoder: encoderWith(),
    encoderReady: () => ({ ready: true, message: 'ok' }),
    pollMs: 10_000,
  });
  await session.provision({ title: 'Globe live' }, async (resource) => {
    if (resource === 'liveStreams') {
      return {
        id: 'stream-1',
        cdn: { ingestionInfo: { rtmpsIngestionAddress: 'rtmps://a.rtmp.youtube.com/live2', streamName: KEY } },
      };
    }
    if (resource === 'liveBroadcasts/bind') return {};
    return { id: 'broadcast-1', status: { lifeCycleStatus: 'ready' } };
  });
  await session.start({ broadcastId: 'broadcast-1', captureUrl: 'http://localhost:4173/' }, {
    call: async () => ({ items: [{ status: { streamStatus: 'ready', lifeCycleStatus: 'ready' } }] }),
  });
  await waitForFrames(session);
  const quotaCall = async () => {
    const error = new Error('quota');
    error.kind = 'quota';
    throw error;
  };
  await session.pollNow(quotaCall);
  const status = session.status();
  assert.equal(status.status, 'waiting-for-youtube');
  assert.match(status.phases.youtube.message, /quota is exhausted/);
  await session.stop();
  assert.equal(session.status().status, 'stopped');
});

test('waitForLive transitions a ready broadcast after the ingest is active', async () => {
  let lifeCycleStatus = 'ready';
  const seen = [];
  const call = async (resource, options = {}) => {
    seen.push({ resource, params: options.params || {} });
    if (resource === 'liveBroadcasts/transition') {
      lifeCycleStatus = String(options.params.broadcastStatus || '');
      return { id: 'broadcast-1', status: { lifeCycleStatus } };
    }
    if (resource === 'liveStreams') {
      return { items: [{ status: { streamStatus: 'active', healthStatus: { status: 'good' } } }] };
    }
    return { items: [{ status: { lifeCycleStatus } }] };
  };
  const session = createLiveSessionController({
    encoder: encoderWith(),
    encoderReady: () => ({ ready: true, message: 'ok' }),
    pollMs: 10_000,
  });
  await session.provision({ title: 'Globe live' }, async (resource) => {
    if (resource === 'liveStreams') {
      return {
        id: 'stream-1',
        cdn: { ingestionInfo: { rtmpsIngestionAddress: 'rtmps://a.rtmp.youtube.com/live2', streamName: KEY } },
      };
    }
    if (resource === 'liveBroadcasts/bind') return {};
    return { id: 'broadcast-1', status: { lifeCycleStatus: 'ready' } };
  });
  await session.start({ broadcastId: 'broadcast-1', captureUrl: 'http://localhost:4173/' }, { call });
  await waitForFrames(session);
  let t = 0;
  const confirmed = await session.waitForLive({
    timeoutMs: 500,
    intervalMs: 10,
    call,
    now: () => t,
    sleep: async (ms) => { t += ms; },
  });
  assert.equal(confirmed.status, 'live');
  assert.equal(confirmed.phases.youtube.broadcastStatus, 'live');
  assert.ok(seen.some((row) => (
    row.resource === 'liveBroadcasts/transition' && row.params.broadcastStatus === 'live'
  )));
  await session.stop();
});

test('labels cover every public status the ADMIN chip can show', () => {
  assert.equal(liveStatusLabel('waiting-for-youtube'), 'WAITING FOR YOUTUBE');
  assert.equal(liveStatusLabel('ingesting'), 'INGESTING');
  assert.equal(liveStatusLabel('encoding'), 'ENCODING');
  assert.equal(liveStatusLabel('live'), 'LIVE');
  assert.equal(describeAccountPhase(null).ready, false);
  assert.equal(describeAccountPhase({ canWrite: false }).ready, false);
  assert.equal(describeAccountPhase({ canWrite: true }).ready, true);
});
