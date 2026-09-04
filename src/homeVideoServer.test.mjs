import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HOME_VIDEO_MAX_QUEUE,
  HOME_VIDEO_RATE_LIMIT,
  createHomeVideoServer,
} from './homeVideoServer.js';
import { CREATIVE_COMMONS_LICENSE, DEFAULT_VIDEO_ID, REASON_UNAVAILABLE } from './homeVideoModeration.js';

const CHANNEL = 'UCSMOQeBJ2RAnuFungnQOxLg';
const ids = ['aqz-KE-bpKQ', 'bbbbbbbbbbb', 'ccccccccccc', 'ddddddddddd'];

/** `videos.list` stub that answers for whatever id was asked about. */
function stubFetch({ license = CREATIVE_COMMONS_LICENSE, channelId = CHANNEL } = {}) {
  return async (url) => {
    const id = new URL(url).searchParams.get('id');
    return {
      ok: true,
      json: async () => ({
        items: [{
          status: { license, embeddable: true },
          snippet: { channelId, channelTitle: 'Blender', title: `Video ${id}` },
        }],
      }),
    };
  };
}

function makeServer(overrides = {}) {
  return createHomeVideoServer({
    readConfig: () => ({ defaultVideoUrl: `https://youtu.be/${DEFAULT_VIDEO_ID}`, approvedChannels: [CHANNEL] }),
    readApiKey: () => 'test-key',
    fetchImpl: stubFetch(),
    ...overrides,
  });
}

test('snapshot reports the ADMIN defaults and whether checking is even possible', () => {
  const withKey = makeServer().state();
  assert.equal(withKey.licenseCheckAvailable, true);
  assert.equal(withKey.approvedChannelCount, 1);
  assert.deepEqual(withKey.queue, []);
  assert.equal(withKey.nowPlaying, null);

  // No key must be visible to the UI, not hidden behind a generic failure.
  assert.equal(makeServer({ readApiKey: () => '' }).state().licenseCheckAvailable, false);
});

test('an approved video queues; the queue is what everyone sees', async () => {
  const server = makeServer();
  const result = await server.recommend({ url: `https://youtu.be/${ids[0]}`, requestedBy: 'viewerA' });
  assert.equal(result.allowed, true);
  assert.equal(result.queued, 1);

  const state = server.state();
  assert.equal(state.queue.length, 1);
  assert.equal(state.queue[0].videoId, ids[0]);
  assert.equal(state.queue[0].requestedBy, 'viewerA');
  assert.equal(state.queue[0].title, `Video ${ids[0]}`);
});

test('the gate still applies through the server', async () => {
  const unapproved = makeServer({ fetchImpl: stubFetch({ channelId: 'UCsomeoneelse' }) });
  assert.equal((await unapproved.recommend({ url: `https://youtu.be/${ids[0]}` })).allowed, false);

  const standard = makeServer({ fetchImpl: stubFetch({ license: 'youtube' }) });
  assert.equal((await standard.recommend({ url: `https://youtu.be/${ids[0]}` })).allowed, false);

  const keyless = makeServer({ readApiKey: () => '' });
  const verdict = await keyless.recommend({ url: `https://youtu.be/${ids[0]}` });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.reason, REASON_UNAVAILABLE);
  assert.equal(keyless.state().queue.length, 0);
});

test('duplicates and an over-long queue are refused', async () => {
  const server = makeServer();
  await server.recommend({ url: `https://youtu.be/${ids[0]}` });
  const again = await server.recommend({ url: `https://youtu.be/${ids[0]}` });
  assert.equal(again.allowed, false);
  assert.equal(again.reason, 'ALREADY QUEUED');
  assert.equal(server.state().queue.length, 1);

  const full = makeServer();
  for (let i = 0; i < HOME_VIDEO_MAX_QUEUE; i += 1) {
    // 11-character ids that differ from each other.
    await full.recommend({ url: `https://youtu.be/${String(i).padStart(11, 'q')}` });
  }
  assert.equal(full.state().queue.length, HOME_VIDEO_MAX_QUEUE);
  const overflow = await full.recommend({ url: `https://youtu.be/${ids[1]}` });
  assert.equal(overflow.allowed, false);
  assert.match(overflow.reason, /QUEUE IS FULL/);
});

test('advance takes the next item and falls back to the ADMIN default', async () => {
  const server = makeServer();
  await server.recommend({ url: `https://youtu.be/${ids[1]}`, requestedBy: 'viewerA' });
  await server.recommend({ url: `https://youtu.be/${ids[2]}`, requestedBy: 'viewerB' });

  // Nothing recommended is playing yet, so the default is what finished.
  const first = server.advance({ finishedVideoId: DEFAULT_VIDEO_ID });
  assert.equal(first.advanced, true);
  assert.equal(first.nowPlaying.videoId, ids[1]);
  assert.equal(first.queue.length, 1);

  const second = server.advance({ finishedVideoId: ids[1] });
  assert.equal(second.nowPlaying.videoId, ids[2]);
  assert.equal(second.queue.length, 0);

  const drained = server.advance({ finishedVideoId: ids[2] });
  assert.equal(drained.nowPlaying, null, 'empty queue returns to the ADMIN default');
});

test('a stale or replayed advance cannot drain the queue', async () => {
  const server = makeServer();
  await server.recommend({ url: `https://youtu.be/${ids[1]}` });
  await server.recommend({ url: `https://youtu.be/${ids[2]}` });

  const stale = server.advance({ finishedVideoId: ids[3] });
  assert.equal(stale.advanced, false);
  assert.equal(stale.reason, 'STALE');
  assert.equal(server.state().queue.length, 2);
  assert.equal(server.state().nowPlaying, null);
});

test('the moderated route is rate limited per caller', async () => {
  let clock = 0;
  const server = makeServer({ now: () => clock });
  const call = () => new Promise((resolve) => {
    const req = {
      url: '/api/home-video/recommend',
      method: 'POST',
      socket: { remoteAddress: '10.0.0.1' },
      on(event, handler) {
        if (event === 'data') handler(Buffer.from(JSON.stringify({ url: `https://youtu.be/${ids[0]}` })));
        if (event === 'end') handler();
        return this;
      },
    };
    const res = {
      setHeader() {}, statusCode: 0,
      end(body) { resolve({ status: res.statusCode, body: JSON.parse(body) }); },
    };
    server.middleware(req, res, () => resolve({ status: 404, body: {} }));
  });

  let limited = null;
  for (let i = 0; i <= HOME_VIDEO_RATE_LIMIT; i += 1) {
    const answer = await call();
    if (answer.status === 429) limited = answer;
  }
  assert.ok(limited, 'the budget must actually run out');
  assert.match(limited.body.reason, /TOO MANY REQUESTS/);
});

test('unknown paths fall through and wrong methods are refused', async () => {
  const server = makeServer();
  let fellThrough = false;
  await server.middleware({ url: '/api/other', method: 'GET' }, {}, () => { fellThrough = true; });
  assert.equal(fellThrough, true);

  const res = { setHeader() {}, statusCode: 0, end(body) { this.body = JSON.parse(body); } };
  await server.middleware({ url: '/api/home-video', method: 'DELETE' }, res, () => {});
  assert.equal(res.statusCode, 405);
});
