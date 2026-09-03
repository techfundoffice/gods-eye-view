import assert from 'node:assert/strict';
import test from 'node:test';
import {
  channelLiveUrl,
  createLiveCommentIngestWorker,
  parseChannelLivePage,
} from './youtubeLiveCommentIngest.js';
import { createYoutubeHomepageChatMiddleware } from './youtubeHomepageChatServer.js';

function invoke(middleware, url = '/feed') {
  return new Promise((resolve, reject) => {
    const req = { method: 'GET', url };
    const headers = {};
    const res = {
      statusCode: 0,
      setHeader(name, value) { headers[String(name).toLowerCase()] = value; },
      end(body) {
        resolve({ status: this.statusCode, body: JSON.parse(String(body || '{}')) });
      },
    };
    Promise.resolve(middleware(req, res)).catch(reject);
  });
}

test('parseChannelLivePage reads public /live identity without Data API fields', () => {
  const html = `
    <link rel="canonical" href="https://www.youtube.com/watch?v=9ZiwwXr-qU4">
    <meta property="og:title" content="Techfundoffice Live Stream">
    {"isLiveNow":true}
  `;
  const parsed = parseChannelLivePage(html);
  assert.equal(parsed.videoId, '9ZiwwXr-qU4');
  assert.equal(parsed.isLive, true);
  assert.equal(channelLiveUrl('@TechfundOffice'), 'https://www.youtube.com/@TechfundOffice/live');
});

test('ingest worker fills a buffer from InnerTube and homepage feed reads memory only', async () => {
  let dataApiCalls = 0;
  let polls = 0;
  const scheduled = [];
  const worker = createLiveCommentIngestWorker({
    maxItems: 10,
    discoveryTtlMs: 60_000,
    discoverLive: async () => ({
      videoId: '9ZiwwXr-qU4',
      title: 'Techfundoffice Live Stream',
      watchUrl: 'https://www.youtube.com/watch?v=9ZiwwXr-qU4',
      isLive: true,
      status: 'live',
    }),
    chat: {
      async poll() {
        polls += 1;
        return {
          items: [{
            id: `chat-${polls}`,
            snippet: { displayMessage: 'testing testing 123', publishedAt: '2026-09-01T12:49:00.000Z' },
            authorDetails: { displayName: 'cloudcomputerai' },
          }],
          nextPageToken: 'CONT',
          pollingIntervalMillis: 5_000,
        };
      },
    },
    clock: {
      setTimeout(callback) {
        scheduled.push(callback);
        return scheduled.length;
      },
      clearTimeout() {},
    },
  });
  worker.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(worker.snapshot().active, true);
  assert.equal(worker.snapshot().channelHandle, '@TechfundOffice');
  assert.equal(worker.snapshot().videoId, '9ZiwwXr-qU4');
  assert.equal(worker.snapshot().items[0].authorDetails.displayName, 'cloudcomputerai');

  const middleware = createYoutubeHomepageChatMiddleware({
    ingest: worker,
    getOwnerCall: async () => {
      dataApiCalls += 1;
      throw new Error('Data API must not run on /feed');
    },
    listChat: async () => {
      dataApiCalls += 1;
      throw new Error('Data API must not run on /feed');
    },
  });
  const feed = await invoke(middleware, '/feed?videoId=CVSB4QJhVTU&liveChatId=stale');
  assert.equal(feed.status, 200);
  assert.equal(feed.body.active, true);
  assert.equal(feed.body.videoId, '9ZiwwXr-qU4');
  assert.equal(feed.body.items[0].author, 'cloudcomputerai');
  assert.equal(feed.body.items[0].text, 'testing testing 123');
  assert.equal(dataApiCalls, 0);
  assert.doesNotMatch(JSON.stringify(feed.body), /CVSB4QJhVTU/);
  worker.stop();
});

test('ended InnerTube session rediscovers and does not keep a stale video id', async () => {
  let discover = 0;
  const scheduled = [];
  const worker = createLiveCommentIngestWorker({
    discoverLive: async () => {
      discover += 1;
      if (discover === 1) {
        return {
          videoId: 'stale123456',
          title: 'Old',
          watchUrl: 'https://www.youtube.com/watch?v=stale123456',
          isLive: true,
          status: 'live',
        };
      }
      return { videoId: '', isLive: false, status: 'offline' };
    },
    chat: {
      async poll() {
        const error = new Error('This live broadcast has ended.');
        error.kind = 'ended';
        throw error;
      },
    },
    clock: {
      setTimeout(callback) {
        scheduled.push(callback);
        return scheduled.length;
      },
      clearTimeout() {},
    },
  });
  worker.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(worker.snapshot().status, 'ended');
  assert.equal(worker.snapshot().videoId, '');
  assert.equal(worker.snapshot().items.length, 0);
  await scheduled.at(-1)();
  assert.ok(discover >= 2);
  worker.stop();
});

test('worker keeps YouTube ingest interval separate from the browser snapshot hint', async () => {
  const scheduled = [];
  const worker = createLiveCommentIngestWorker({
    discoverLive: async () => ({
      videoId: '9ZiwwXr-qU4',
      title: 'Live',
      watchUrl: 'https://www.youtube.com/watch?v=9ZiwwXr-qU4',
      isLive: true,
      status: 'live',
    }),
    chat: {
      async poll() {
        return {
          items: [{ id: 'n1', snippet: { displayMessage: 'hi' }, authorDetails: { displayName: 'A' } }],
          nextPageToken: 'T',
          pollingIntervalMillis: 12_000,
        };
      },
    },
    clock: {
      setTimeout(callback, delay) {
        scheduled.push(delay);
        return scheduled.length;
      },
      clearTimeout() {},
    },
  });
  worker.start();
  await new Promise((resolve) => setImmediate(resolve));
  const snap = worker.snapshot();
  assert.equal(snap.ingestPollingIntervalMillis, 12_000);
  assert.equal(snap.pollingIntervalMillis, 800);
  assert.equal(scheduled[0], 12_000);
  assert.ok(snap.updatedAt > 0);
  worker.stop();
});
