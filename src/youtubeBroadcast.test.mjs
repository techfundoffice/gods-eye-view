import assert from 'node:assert/strict';
import test from 'node:test';
import {
  YOUTUBE_NOT_RECEIVED,
  extractIngestInfo,
  isCompatibleBroadcastStatus,
  isTerminalBroadcastStatus,
  listCompatibleBroadcasts,
  pickReusableBroadcast,
  nextYoutubeLiveTransition,
  pollYoutubeBroadcast,
  provisionYoutubeBroadcast,
  redactBroadcastView,
  selectYoutubeBroadcast,
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
} = {}) {
  return {
    id,
    snippet: { title },
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
