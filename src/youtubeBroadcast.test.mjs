import assert from 'node:assert/strict';
import test from 'node:test';
import {
  YOUTUBE_NOT_RECEIVED,
  createOwnerLiveDiscovery,
  discoverActiveYoutubeLive,
  extractIngestInfo,
  isCompatibleBroadcastStatus,
  isStaleLiveChatError,
  isTerminalBroadcastStatus,
  listActiveBroadcasts,
  listCompatibleBroadcasts,
  listYoutubeLiveChatMessages,
  pickReusableBroadcast,
  nextYoutubeLiveTransition,
  pollYoutubeBroadcast,
  provisionYoutubeBroadcast,
  redactBroadcastView,
  selectYoutubeBroadcast,
  summarizeBroadcastItem,
  transitionYoutubeBroadcast,
  youtubeLiveOperatorMessage,
} from './youtubeBroadcast.js';

const KEY = 'abcd-1234-efgh-5678';

function streamResource({
  id = 'stream-1',
  ingestionAddress = 'rtmp://a.rtmp.youtube.com/live2',
  rtmpsIngestionAddress = 'rtmps://a.rtmp.youtube.com/live2',
  streamName = KEY,
} = {}) {
  return {
    id,
    cdn: { ingestionInfo: { ingestionAddress, rtmpsIngestionAddress, streamName } },
    status: { streamStatus: 'ready', healthStatus: { status: 'noData' } },
  };
}

function broadcastResource({
  id = 'broadcast-1',
  title = 'Globe live',
  privacy = 'unlisted',
  lifeCycleStatus = 'ready',
  boundStreamId = 'stream-1',
  liveChatId = '',
} = {}) {
  return {
    id,
    snippet: { title, liveChatId },
    status: { privacyStatus: privacy, lifeCycleStatus },
    contentDetails: { boundStreamId },
  };
}

function recordingCall(handler) {
  const seen = [];
  const call = async (resource, options = {}) => {
    seen.push({
      resource,
      method: options.method || 'GET',
      params: options.params || {},
      body: options.body,
    });
    return handler(resource, options, seen.length - 1);
  };
  return { call, seen };
}

test('provisioning creates a stream, a broadcast with auto-start and no monitor delay, and binds them', async () => {
  const { call, seen } = recordingCall((resource) => {
    if (resource === 'liveStreams') return streamResource();
    if (resource === 'liveBroadcasts/bind') return { id: 'broadcast-1' };
    return broadcastResource({ boundStreamId: '' });
  });

  const result = await provisionYoutubeBroadcast(call, { title: 'Globe live', privacyStatus: 'unlisted' });
  assert.equal(result.broadcastId, 'broadcast-1');
  assert.equal(result.streamId, 'stream-1');
  assert.equal(result.streamKey, KEY);
  assert.equal(result.ingestUrl, 'rtmps://a.rtmp.youtube.com/live2');
  assert.equal(result.watchUrl, 'https://www.youtube.com/watch?v=broadcast-1');

  assert.equal(seen[0].resource, 'liveStreams');
  assert.equal(seen[0].method, 'POST');
  assert.equal(seen[1].resource, 'liveBroadcasts');
  assert.equal(seen[1].body.contentDetails.enableAutoStart, true);
  assert.equal(seen[1].body.contentDetails.enableAutoStop, true);
  assert.equal(seen[1].body.contentDetails.monitorStream.enableMonitorStream, false);
  assert.equal(seen[1].body.status.privacyStatus, 'unlisted');
  assert.equal(seen[2].resource, 'liveBroadcasts/bind');
  assert.equal(seen[2].params.streamId, 'stream-1');
  assert.equal(seen[2].params.id, 'broadcast-1');

  await assert.rejects(() => provisionYoutubeBroadcast(call, { title: '  ' }), /title is required/);
});

test('pickReusableBroadcast prefers a named id, then a public ready live', () => {
  const waiting = {
    id: 'CVSB4QJhVTU',
    privacy: 'public',
    lifeCycleStatus: 'ready',
  };
  const unlisted = { id: 'other', privacy: 'unlisted', lifeCycleStatus: 'ready' };
  const complete = { id: 'old', privacy: 'public', lifeCycleStatus: 'complete' };
  assert.equal(pickReusableBroadcast([complete, unlisted, waiting]).id, 'CVSB4QJhVTU');
  assert.equal(pickReusableBroadcast([unlisted, waiting], { preferId: 'other' }).id, 'other');
  assert.equal(pickReusableBroadcast([complete]), null);
  assert.equal(pickReusableBroadcast([]), null);
  assert.equal(pickReusableBroadcast([unlisted], { requirePublic: true }), null);
});

test('the public broadcast view never includes the stream key', () => {
  const binding = {
    broadcastId: 'broadcast-1',
    streamId: 'stream-1',
    title: 'Globe live',
    privacy: 'unlisted',
    watchUrl: 'https://www.youtube.com/watch?v=broadcast-1',
    lifeCycleStatus: 'ready',
    ingestUrl: 'rtmps://a.rtmp.youtube.com/live2',
    streamKey: KEY,
  };
  const view = redactBroadcastView(binding);
  assert.equal(view.target, 'rtmps://a.rtmp.youtube.com/live2/***');
  assert.ok(!JSON.stringify(view).includes(KEY));
  assert.equal(view.ingestUrl, 'rtmps://a.rtmp.youtube.com/live2');
  assert.equal('streamKey' in view, false);
});

test('selecting a ready bound broadcast returns rtmps ingest from the bound stream', async () => {
  const { call, seen } = recordingCall((resource) => {
    if (resource === 'liveBroadcasts') {
      return { items: [broadcastResource()] };
    }
    return { items: [streamResource()] };
  });
  const result = await selectYoutubeBroadcast(call, { broadcastId: 'broadcast-1' });
  assert.equal(result.streamKey, KEY);
  assert.equal(result.ingestUrl, 'rtmps://a.rtmp.youtube.com/live2');
  assert.equal(seen[0].params.id, 'broadcast-1');
  assert.equal(seen[1].resource, 'liveStreams');
  assert.equal(seen[1].params.id, 'stream-1');
});

test('selecting a complete broadcast is incompatible', async () => {
  const { call } = recordingCall(() => ({
    items: [broadcastResource({ lifeCycleStatus: 'complete' })],
  }));
  await assert.rejects(
    () => selectYoutubeBroadcast(call, { broadcastId: 'broadcast-1' }),
    (error) => error.kind === 'incompatible' && /complete/.test(error.message),
  );
});

test('selecting an unbound ready broadcast inserts a stream and binds it', async () => {
  const { call, seen } = recordingCall((resource) => {
    if (resource === 'liveBroadcasts') {
      return { items: [broadcastResource({ boundStreamId: '' })] };
    }
    if (resource === 'liveStreams') return streamResource({ id: 'stream-new' });
    return { id: 'broadcast-1' };
  });
  const result = await selectYoutubeBroadcast(call, { broadcastId: 'broadcast-1' });
  assert.equal(result.streamId, 'stream-new');
  assert.deepEqual(seen.map((row) => row.resource), [
    'liveBroadcasts',
    'liveStreams',
    'liveBroadcasts/bind',
  ]);
  assert.equal(seen[2].params.streamId, 'stream-new');
});

test('listing drops terminal broadcasts and never carries ingest keys', async () => {
  const { call } = recordingCall(() => ({
    items: [
      broadcastResource({ id: 'ok', lifeCycleStatus: 'ready' }),
      broadcastResource({ id: 'done', lifeCycleStatus: 'complete' }),
      broadcastResource({ id: 'revoked', lifeCycleStatus: 'revoked' }),
      streamResource(),
    ],
  }));
  const rows = await listCompatibleBroadcasts(call);
  assert.deepEqual(rows.map((row) => row.id), ['ok']);
  assert.ok(!JSON.stringify(rows).includes(KEY));
});

test('poll reports waiting until the stream is active and the broadcast is live or testing', async () => {
  const waiting = await pollYoutubeBroadcast(
    async (resource) => {
      if (resource === 'liveStreams') {
        return { items: [{ status: { streamStatus: 'ready', healthStatus: { status: 'noData' } } }] };
      }
      return { items: [{ status: { lifeCycleStatus: 'ready' } }] };
    },
    { broadcastId: 'broadcast-1', streamId: 'stream-1' },
  );
  assert.equal(waiting.received, false);
  assert.equal(waiting.message, YOUTUBE_NOT_RECEIVED);

  const live = await pollYoutubeBroadcast(
    async (resource) => {
      if (resource === 'liveStreams') {
        return { items: [{ status: { streamStatus: 'active', healthStatus: { status: 'good' } } }] };
      }
      return { items: [{ status: { lifeCycleStatus: 'live' } }] };
    },
    { broadcastId: 'broadcast-1', streamId: 'stream-1' },
  );
  assert.equal(live.received, true);
  assert.equal(live.preview, false);

  const preview = await pollYoutubeBroadcast(
    async (resource) => {
      if (resource === 'liveStreams') {
        return { items: [{ status: { streamStatus: 'active', healthStatus: { status: 'ok' } } }] };
      }
      return { items: [{ status: { lifeCycleStatus: 'testing' } }] };
    },
    { broadcastId: 'broadcast-1', streamId: 'stream-1' },
  );
  assert.equal(preview.received, true);
  assert.equal(preview.preview, true);
  assert.match(preview.message, /preview/i);
});

test('quota and insufficient-scope become operator sentences', async () => {
  assert.equal(
    youtubeLiveOperatorMessage('quota'),
    'YouTube API quota is exhausted; retry after the quota reset.',
  );
  assert.equal(
    youtubeLiveOperatorMessage('insufficient-scope'),
    'Reconnect YouTube to grant live-control permission.',
  );

  const quotaCall = async () => {
    const error = new Error('quotaExceeded');
    error.kind = 'quota';
    throw error;
  };
  await assert.rejects(
    () => provisionYoutubeBroadcast(quotaCall, { title: 'Globe' }),
    (error) => error.kind === 'quota' && /quota is exhausted/.test(error.message),
  );

  const scopeCall = async () => ({
    ok: false,
    status: 403,
    json: async () => ({
      error: { message: 'Insufficient Permission', errors: [{ reason: 'insufficientPermissions' }] },
    }),
  });
  await assert.rejects(
    () => listCompatibleBroadcasts(scopeCall),
    (error) => error.kind === 'insufficient-scope' && /Reconnect YouTube/.test(error.message),
  );
});

test('transition posts liveBroadcasts/transition and next-step is live once the stream is active', async () => {
  const { call, seen } = recordingCall(() => ({
    id: 'broadcast-1',
    status: { lifeCycleStatus: 'live' },
  }));
  const result = await transitionYoutubeBroadcast(call, {
    broadcastId: 'broadcast-1',
    broadcastStatus: 'live',
  });
  assert.equal(result.status.lifeCycleStatus, 'live');
  assert.equal(seen[0].resource, 'liveBroadcasts/transition');
  assert.equal(seen[0].method, 'POST');
  assert.equal(seen[0].params.id, 'broadcast-1');
  assert.equal(seen[0].params.broadcastStatus, 'live');

  assert.equal(nextYoutubeLiveTransition({ streamStatus: 'ready' }), null);
  assert.equal(nextYoutubeLiveTransition({ streamStatus: 'active', received: false, preview: false }), 'live');
  assert.equal(nextYoutubeLiveTransition({ streamStatus: 'active', received: true, preview: true }), 'live');
  assert.equal(nextYoutubeLiveTransition({ streamStatus: 'active', received: true, preview: false }), null);
  assert.equal(nextYoutubeLiveTransition({ streamStatus: 'active', terminal: true }), null);

  await assert.rejects(
    () => transitionYoutubeBroadcast(call, { broadcastId: 'broadcast-1', broadcastStatus: 'ready' }),
    /testing, live, or complete/,
  );
});

test('extractIngestInfo prefers RTMPS and compatibility helpers match YouTube lifecycle names', () => {
  const ingest = extractIngestInfo(streamResource());
  assert.equal(ingest.ingestUrl, 'rtmps://a.rtmp.youtube.com/live2');
  assert.equal(ingest.streamKey, KEY);
  assert.equal(
    extractIngestInfo({ cdn: { ingestionInfo: { ingestionAddress: 'rtmp://a.rtmp.youtube.com/live2' } } }).ingestUrl,
    'rtmp://a.rtmp.youtube.com/live2',
  );
  assert.equal(isCompatibleBroadcastStatus('ready'), true);
  assert.equal(isCompatibleBroadcastStatus('testing'), true);
  assert.equal(isCompatibleBroadcastStatus('complete'), false);
  assert.equal(isTerminalBroadcastStatus('revoked'), true);
});

test('summarizeBroadcastItem includes liveChatId and listActiveBroadcasts uses mine+active', async () => {
  const summary = summarizeBroadcastItem(broadcastResource({
    id: '9ZiwwXr-qU4',
    title: 'Techfundoffice Live Stream',
    lifeCycleStatus: 'live',
    liveChatId: 'CHAT-LIVE',
  }));
  assert.equal(summary.liveChatId, 'CHAT-LIVE');
  assert.equal(summary.watchUrl, 'https://www.youtube.com/watch?v=9ZiwwXr-qU4');

  const { call, seen } = recordingCall(() => ({
    items: [
      broadcastResource({ id: 'ended-looking', lifeCycleStatus: 'complete', liveChatId: 'old' }),
      broadcastResource({ id: '9ZiwwXr-qU4', lifeCycleStatus: 'live', liveChatId: 'CHAT-LIVE', title: 'Now' }),
    ],
  }));
  const rows = await listActiveBroadcasts(call);
  assert.equal(seen[0].resource, 'liveBroadcasts');
  assert.equal(seen[0].params.broadcastStatus, 'active');
  assert.equal(seen[0].params.mine, 'true');
  assert.equal(rows[1].id, '9ZiwwXr-qU4');
  assert.equal(rows[1].liveChatId, 'CHAT-LIVE');
});

test('discoverActiveYoutubeLive selects verified live chat and treats liveStarting as connecting', async () => {
  const liveCall = recordingCall(() => ({
    items: [
      broadcastResource({ id: 'starting', lifeCycleStatus: 'liveStarting', liveChatId: '' }),
      broadcastResource({ id: '9ZiwwXr-qU4', lifeCycleStatus: 'live', liveChatId: 'CHAT-LIVE', title: 'Now' }),
    ],
  })).call;
  const live = await discoverActiveYoutubeLive(liveCall);
  assert.equal(live.active, true);
  assert.equal(live.status, 'live');
  assert.equal(live.videoId, '9ZiwwXr-qU4');
  assert.equal(live.liveChatId, 'CHAT-LIVE');

  const starting = await discoverActiveYoutubeLive(recordingCall(() => ({
    items: [broadcastResource({ id: 'starting', lifeCycleStatus: 'liveStarting', liveChatId: '' })],
  })).call);
  assert.equal(starting.active, false);
  assert.equal(starting.status, 'connecting');
  assert.equal(starting.videoId, 'starting');

  const offline = await discoverActiveYoutubeLive(recordingCall(() => ({ items: [] })).call);
  assert.equal(offline.status, 'offline');
  assert.equal(offline.active, false);
});

test('owner live discovery cache is scoped and cleared on stale chat errors', async () => {
  let lists = 0;
  const discovery = createOwnerLiveDiscovery({
    ownerKey: 'channel-owner',
    ttlMs: 60_000,
    getCall: async () => async () => {
      lists += 1;
      return {
        items: [broadcastResource({ id: '9ZiwwXr-qU4', lifeCycleStatus: 'live', liveChatId: 'CHAT-LIVE' })],
      };
    },
  });
  const first = await discovery.get();
  const second = await discovery.get();
  assert.equal(first.videoId, '9ZiwwXr-qU4');
  assert.equal(second.videoId, first.videoId);
  assert.equal(lists, 1);
  discovery.invalidate();
  await discovery.get();
  assert.equal(lists, 2);
  assert.equal(isStaleLiveChatError({ kind: 'ended' }), true);
  assert.equal(isStaleLiveChatError({ kind: 'not-found' }), true);
  assert.equal(isStaleLiveChatError({ reasons: ['liveChatEnded'] }), true);
  assert.equal(isStaleLiveChatError({ kind: 'quota' }), false);
});

test('listYoutubeLiveChatMessages uses the discovered chat id', async () => {
  const { call, seen } = recordingCall(() => ({
    items: [{ id: 'm1', snippet: { displayMessage: 'hi' } }],
    nextPageToken: 'T2',
    pollingIntervalMillis: 8000,
  }));
  const result = await listYoutubeLiveChatMessages(call, { liveChatId: 'CHAT-LIVE', pageToken: 'T1' });
  assert.equal(seen[0].resource, 'liveChatMessages');
  assert.equal(seen[0].params.liveChatId, 'CHAT-LIVE');
  assert.equal(seen[0].params.pageToken, 'T1');
  assert.equal(result.nextPageToken, 'T2');
});
