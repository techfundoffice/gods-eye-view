/**
 * Server-side YouTube Live control: create, select, and poll broadcasts.
 *
 * The stream key stays in this process. Public views use a redacted ingest
 * target. Callers inject `call(resource, { method, params, body })` so tests
 * never need a network, and production uses `oauth.proxy` directly instead of
 * looping through `/api/youtube`.
 *
 * @module youtubeBroadcast
 */

import { classifyYoutubeError } from './youtubeProxy.js';
import { normalizeIngestTarget } from './liveStream.js';

/** Lifecycle statuses that can still take an ingest. */
export const COMPATIBLE_BROADCAST_STATUSES = Object.freeze([
  'created',
  'ready',
  'testStarting',
  'testing',
  'liveStarting',
  'live',
]);

/** Lifecycle statuses that cannot take a new ingest. */
export const TERMINAL_BROADCAST_STATUSES = Object.freeze([
  'complete',
  'revoked',
  'failed',
]);

/** Operator sentence while the encoder is up but YouTube has not gone active. */
export const YOUTUBE_NOT_RECEIVED = 'YouTube has not received the stream yet';

const REDACTED = '***';

/**
 * @param {string} status
 * @returns {boolean}
 */
export function isCompatibleBroadcastStatus(status) {
  return COMPATIBLE_BROADCAST_STATUSES.includes(String(status || ''));
}

/**
 * @param {string} status
 * @returns {boolean}
 */
export function isTerminalBroadcastStatus(status) {
  return TERMINAL_BROADCAST_STATUSES.includes(String(status || ''));
}

/**
 * Prefer an already-created public broadcast (the channel may already be
 * waiting for ingest) instead of inserting a second live.
 *
 * @param {object[]} items From {@link listCompatibleBroadcasts} or similar
 * @param {{preferId?: string, preferPublic?: boolean}} [options]
 * @returns {object|null}
 */
export function pickReusableBroadcast(items, { preferId = '', preferPublic = true, requirePublic = false } = {}) {
  const rows = (Array.isArray(items) ? items : []).filter(
    (row) => row?.id && isCompatibleBroadcastStatus(row.lifeCycleStatus),
  );
  const want = String(preferId || '').trim();
  if (want) {
    const hit = rows.find((row) => row.id === want);
    if (hit) return hit;
  }
  if (preferPublic) {
    const pub = rows.find((row) => String(row.privacy || '') === 'public');
    if (pub) return pub;
  }
  if (requirePublic) return null;
  return rows[0] || null;
}

/**
 * Operator-facing sentence for a classified YouTube error kind.
 *
 * @param {string} kind
 * @param {string} [fallback]
 * @returns {string}
 */
export function youtubeLiveOperatorMessage(kind, fallback = '') {
  switch (String(kind || '')) {
    case 'insufficient-scope':
      return 'Reconnect YouTube to grant live-control permission.';
    case 'authentication':
      return 'Paste a current Studio stream key, or sign in to create a broadcast.';
    case 'quota':
      return 'YouTube API quota is exhausted; retry after the quota reset.';
    case 'not-found':
      return 'That YouTube broadcast was not found, or it is not yours.';
    case 'rate-limit':
      return 'YouTube is rate limiting live-control requests. Try again shortly.';
    case 'incompatible':
      return fallback || 'That broadcast cannot take a new ingest.';
    default:
      return fallback || 'YouTube rejected this live-control request.';
  }
}

/**
 * Throw a classified error from a YouTube HTTP response payload.
 *
 * @param {number} status
 * @param {object} payload
 * @returns {never}
 */
export function throwYoutubeLiveError(status, payload) {
  const classified = classifyYoutubeError(status, payload);
  const error = new Error(youtubeLiveOperatorMessage(classified.kind, classified.message));
  error.kind = classified.kind;
  error.status = classified.code || status;
  error.reasons = classified.reasons || [];
  throw error;
}

/**
 * Pull RTMP ingest details out of a liveStreams resource. Prefers RTMPS.
 *
 * @param {object} stream
 * @returns {{ingestUrl: string, streamKey: string}}
 */
export function extractIngestInfo(stream) {
  const info = stream?.cdn?.ingestionInfo || {};
  const ingestUrl = String(info.rtmpsIngestionAddress || info.ingestionAddress || '').trim();
  const streamKey = String(info.streamName || '').trim();
  return { ingestUrl, streamKey };
}

/**
 * Public, credential-free view of a bound broadcast.
 *
 * @param {object} binding Internal binding (may include streamKey).
 * @returns {object}
 */
export function redactBroadcastView(binding = {}) {
  const ingestUrl = String(binding.ingestUrl || '').trim();
  let target = '';
  if (ingestUrl && binding.streamKey) {
    try {
      target = normalizeIngestTarget(ingestUrl, binding.streamKey).display;
    } catch {
      target = `${ingestUrl.replace(/\/+$/, '')}/${REDACTED}`;
    }
  } else if (ingestUrl) {
    target = `${ingestUrl.replace(/\/+$/, '')}/${REDACTED}`;
  }
  const json = JSON.stringify({
    id: String(binding.broadcastId || binding.id || ''),
    streamId: String(binding.streamId || ''),
    title: String(binding.title || ''),
    privacy: String(binding.privacy || ''),
    watchUrl: String(binding.watchUrl || ''),
    lifeCycleStatus: String(binding.lifeCycleStatus || ''),
    ingestUrl,
    target,
  });
  if (binding.streamKey && json.includes(binding.streamKey)) {
    throw new Error('Refusing to return a broadcast view that contains the stream key');
  }
  return JSON.parse(json);
}

/**
 * @param {object} item liveBroadcasts resource
 * @returns {object}
 */
export function summarizeBroadcastItem(item) {
  const id = String(item?.id || '');
  return {
    id,
    title: String(item?.snippet?.title || ''),
    privacy: String(item?.status?.privacyStatus || ''),
    lifeCycleStatus: String(item?.status?.lifeCycleStatus || ''),
    boundStreamId: String(item?.contentDetails?.boundStreamId || ''),
    liveChatId: String(item?.snippet?.liveChatId || ''),
    watchUrl: id ? `https://www.youtube.com/watch?v=${id}` : '',
  };
}

/** Chat/broadcast errors that mean the cached identity must not be reused. */
export const STALE_LIVE_CHAT_KINDS = Object.freeze([
  'ended',
  'not-found',
  'forbidden',
  'comments-disabled',
  'unavailable',
]);

/**
 * @param {object|null|undefined} error
 * @returns {boolean}
 */
export function isStaleLiveChatError(error) {
  const kind = String(error?.kind || '');
  if (STALE_LIVE_CHAT_KINDS.includes(kind)) return true;
  const reasons = Array.isArray(error?.reasons) ? error.reasons : [];
  return reasons.some((reason) => /liveChatEnded|liveChatNotFound|liveChatDisabled|commentsDisabled/i.test(String(reason)));
}

function emptyDiscovery(status) {
  return {
    active: false,
    status,
    videoId: '',
    title: '',
    watchUrl: '',
    liveChatId: '',
    lifeCycleStatus: '',
  };
}

/**
 * List the signed-in channel's currently active broadcasts.
 *
 * @param {Function} call
 * @returns {Promise<object[]>}
 */
export async function listActiveBroadcasts(call) {
  const payload = await youtubeCall(call, 'liveBroadcasts', {
    method: 'GET',
    params: {
      part: 'id,snippet,status,contentDetails',
      broadcastStatus: 'active',
      mine: 'true',
      maxResults: '50',
    },
  });
  const items = Array.isArray(payload.items) ? payload.items : [];
  return items.map(summarizeBroadcastItem).filter((row) => row.id);
}

/**
 * Resolve the channel owner's current live chat identity from YouTube.
 * Never consults environment broadcast IDs or encoder session state.
 *
 * @param {Function} call
 * @returns {Promise<object>}
 */
export async function discoverActiveYoutubeLive(call) {
  let rows = [];
  try {
    rows = await listActiveBroadcasts(call);
  } catch (error) {
    if (error?.kind === 'authentication' || error?.kind === 'insufficient-scope') {
      return emptyDiscovery('unauthenticated');
    }
    throw error;
  }
  const live = rows.find((row) => row.lifeCycleStatus === 'live' && row.liveChatId);
  if (live) {
    return {
      active: true,
      status: 'live',
      videoId: live.id,
      title: live.title,
      watchUrl: live.watchUrl,
      liveChatId: live.liveChatId,
      lifeCycleStatus: 'live',
    };
  }
  const starting = rows.find((row) => (
    row.lifeCycleStatus === 'liveStarting'
    || (row.lifeCycleStatus === 'live' && !row.liveChatId)
  ));
  if (starting) {
    return {
      active: false,
      status: 'connecting',
      videoId: starting.id,
      title: starting.title,
      watchUrl: starting.watchUrl,
      liveChatId: starting.liveChatId || '',
      lifeCycleStatus: starting.lifeCycleStatus,
    };
  }
  return emptyDiscovery('offline');
}

/**
 * Official liveChatMessages.list for a discovered chat id.
 *
 * @param {Function} call
 * @param {{liveChatId?: string, pageToken?: string}} [options]
 * @returns {Promise<{items: object[], nextPageToken: string, pollingIntervalMillis: number}>}
 */
export async function listYoutubeLiveChatMessages(call, { liveChatId, pageToken } = {}) {
  const id = String(liveChatId || '').trim();
  if (!id) {
    const error = new Error('Official live chat is unavailable for this video.');
    error.kind = 'unavailable';
    throw error;
  }
  try {
    const payload = await youtubeCall(call, 'liveChatMessages', {
      method: 'GET',
      params: {
        part: 'snippet,authorDetails',
        liveChatId: id,
        pageToken: pageToken || undefined,
      },
    });
    return {
      items: Array.isArray(payload.items) ? payload.items : [],
      nextPageToken: String(payload.nextPageToken || ''),
      pollingIntervalMillis: Number(payload.pollingIntervalMillis) || 5_000,
    };
  } catch (error) {
    const reasons = Array.isArray(error?.reasons) ? error.reasons : [];
    if (reasons.some((reason) => /liveChatEnded/i.test(String(reason))) || /ended/i.test(String(error?.message || ''))) {
      error.kind = 'ended';
    }
    throw error;
  }
}

/**
 * Owner-scoped in-memory cache around {@link discoverActiveYoutubeLive}.
 *
 * @param {object} [options]
 * @param {() => Promise<Function|{call: Function, ownerKey?: string}|null>} options.getCall
 * @param {string} [options.ownerKey]
 * @param {number} [options.ttlMs]
 * @param {() => number} [options.now]
 */
export function createOwnerLiveDiscovery({
  getCall,
  ownerKey = 'channel-owner',
  ttlMs = 20_000,
  now = Date.now,
} = {}) {
  const cache = new Map();
  let generation = 0;
  let lastVideoId = '';

  function slot(key) {
    return String(key || ownerKey);
  }

  return {
    invalidate(key = ownerKey) {
      cache.delete(slot(key));
    },
    async get() {
      let call = null;
      let key = ownerKey;
      try {
        const resolved = typeof getCall === 'function' ? await getCall() : null;
        if (resolved && typeof resolved === 'object' && typeof resolved.call === 'function') {
          call = resolved.call;
          key = resolved.ownerKey || ownerKey;
        } else {
          call = resolved;
        }
      } catch (error) {
        if (error?.kind === 'authentication' || error?.status === 401) {
          return { ...emptyDiscovery('unauthenticated'), generation };
        }
        throw error;
      }
      if (typeof call !== 'function') {
        return { ...emptyDiscovery('unauthenticated'), generation };
      }
      const cached = cache.get(slot(key));
      if (cached && now() - cached.at < ttlMs) {
        return { ...cached.identity, generation };
      }
      const identity = await discoverActiveYoutubeLive(call);
      if (identity.videoId !== lastVideoId) {
        generation += 1;
        lastVideoId = identity.videoId || '';
      }
      cache.set(slot(key), { at: now(), identity });
      return { ...identity, generation };
    },
  };
}

/**
 * @param {Function} call Injected YouTube caller.
 * @param {object} response Fetch-like `{ ok, status, json() }` or already-parsed payload.
 * @returns {Promise<object>}
 */
async function readPayload(response) {
  if (response && typeof response.json === 'function') {
    let payload = {};
    try { payload = await response.json(); } catch { payload = {}; }
    if (response.ok === false) throwYoutubeLiveError(response.status || 502, payload);
    return payload;
  }
  return response && typeof response === 'object' ? response : {};
}

/**
 * Invoke `call` and normalize errors so callers always see `.kind`.
 *
 * @param {Function} call
 * @param {string} resource
 * @param {object} [options]
 * @returns {Promise<object>}
 */
export async function youtubeCall(call, resource, options = {}) {
  if (typeof call !== 'function') throw new Error('YouTube live control requires a caller');
  let result;
  try {
    result = await call(resource, options);
  } catch (error) {
    if (error?.kind) {
      error.message = youtubeLiveOperatorMessage(error.kind, error.message);
      throw error;
    }
    const wrapped = new Error(error?.message || 'YouTube live-control request failed');
    wrapped.kind = 'upstream';
    throw wrapped;
  }
  return readPayload(result);
}

/**
 * Create a stream, a broadcast (auto-start, no monitor-stream delay), and bind.
 *
 * @param {Function} call
 * @param {{title: string, description?: string, privacyStatus?: string}} options
 * @returns {Promise<object>} Internal binding including streamKey.
 */
export async function provisionYoutubeBroadcast(call, {
  title,
  description = '',
  privacyStatus = 'unlisted',
} = {}) {
  const name = String(title || '').trim();
  if (!name) throw new Error('A broadcast title is required');
  const privacy = String(privacyStatus || 'unlisted').trim() || 'unlisted';

  const stream = await youtubeCall(call, 'liveStreams', {
    method: 'POST',
    params: { part: 'snippet,cdn,status' },
    body: {
      snippet: { title: `${name} ingest` },
      cdn: { frameRate: 'variable', ingestionType: 'rtmp', resolution: 'variable' },
    },
  });
  const ingest = extractIngestInfo(stream);
  if (!ingest.ingestUrl || !ingest.streamKey) {
    const error = new Error('YouTube returned no ingest key for the new stream.');
    error.kind = 'invalid-request';
    throw error;
  }

  const broadcast = await youtubeCall(call, 'liveBroadcasts', {
    method: 'POST',
    params: { part: 'snippet,status,contentDetails' },
    body: {
      snippet: {
        title: name,
        description,
        scheduledStartTime: new Date(Date.now() + 15_000).toISOString(),
      },
      status: { privacyStatus: privacy, selfDeclaredMadeForKids: false },
      contentDetails: {
        enableAutoStart: true,
        enableAutoStop: true,
        monitorStream: { enableMonitorStream: false, broadcastStreamDelayMs: 0 },
      },
    },
  });

  await youtubeCall(call, 'liveBroadcasts/bind', {
    method: 'POST',
    params: {
      part: 'id,contentDetails',
      id: broadcast.id,
      streamId: stream.id,
    },
  });

  return {
    broadcastId: String(broadcast.id || ''),
    streamId: String(stream.id || ''),
    title: name,
    privacy,
    watchUrl: broadcast.id ? `https://www.youtube.com/watch?v=${broadcast.id}` : '',
    lifeCycleStatus: String(broadcast.status?.lifeCycleStatus || 'ready'),
    ingestUrl: ingest.ingestUrl,
    streamKey: ingest.streamKey,
  };
}

/**
 * List the signed-in account's broadcasts that can still take an ingest.
 *
 * @param {Function} call
 * @returns {Promise<object[]>}
 */
export async function listCompatibleBroadcasts(call) {
  const payload = await youtubeCall(call, 'liveBroadcasts', {
    method: 'GET',
    params: { part: 'snippet,contentDetails,status', mine: 'true', maxResults: '50' },
  });
  const items = Array.isArray(payload.items) ? payload.items : [];
  return items
    .map(summarizeBroadcastItem)
    .filter((row) => row.id && isCompatibleBroadcastStatus(row.lifeCycleStatus));
}

/**
 * Load a broadcast, require a compatible lifecycle, bind a stream if needed,
 * and return ingest details for server-side start.
 *
 * @param {Function} call
 * @param {{broadcastId: string}} options
 * @returns {Promise<object>} Internal binding including streamKey.
 */
export async function selectYoutubeBroadcast(call, { broadcastId } = {}) {
  const id = String(broadcastId || '').trim();
  if (!id) throw new Error('A broadcast id is required');

  const listed = await youtubeCall(call, 'liveBroadcasts', {
    method: 'GET',
    params: { part: 'snippet,contentDetails,status', id },
  });
  const item = Array.isArray(listed.items) ? listed.items[0] : null;
  if (!item?.id) {
    const error = new Error('That YouTube broadcast was not found, or it is not yours.');
    error.kind = 'not-found';
    error.status = 404;
    throw error;
  }
  const summary = summarizeBroadcastItem(item);
  if (!isCompatibleBroadcastStatus(summary.lifeCycleStatus)) {
    const error = new Error(
      `That broadcast is ${summary.lifeCycleStatus || 'unknown'} and cannot take a new ingest.`,
    );
    error.kind = 'incompatible';
    error.status = 409;
    throw error;
  }

  let streamId = summary.boundStreamId;
  let stream = null;
  if (!streamId) {
    stream = await youtubeCall(call, 'liveStreams', {
      method: 'POST',
      params: { part: 'snippet,cdn,status' },
      body: {
        snippet: { title: `${summary.title || id} ingest` },
        cdn: { frameRate: 'variable', ingestionType: 'rtmp', resolution: 'variable' },
      },
    });
    streamId = String(stream.id || '');
    await youtubeCall(call, 'liveBroadcasts/bind', {
      method: 'POST',
      params: { part: 'id,contentDetails', id, streamId },
    });
  } else {
    const streams = await youtubeCall(call, 'liveStreams', {
      method: 'GET',
      params: { part: 'snippet,cdn,status', id: streamId },
    });
    stream = Array.isArray(streams.items) ? streams.items[0] : streams;
  }

  const ingest = extractIngestInfo(stream);
  if (!ingest.ingestUrl || !ingest.streamKey) {
    const error = new Error('YouTube returned no ingest key for that broadcast.');
    error.kind = 'invalid-request';
    throw error;
  }

  return {
    broadcastId: summary.id,
    streamId,
    title: summary.title,
    privacy: summary.privacy,
    watchUrl: summary.watchUrl,
    lifeCycleStatus: summary.lifeCycleStatus,
    ingestUrl: ingest.ingestUrl,
    streamKey: ingest.streamKey,
  };
}

/**
 * Read stream + broadcast health for the confirmation state machine.
 *
 * @param {Function} call
 * @param {{broadcastId: string, streamId: string}} ids
 * @returns {Promise<object>}
 */
export async function pollYoutubeBroadcast(call, { broadcastId, streamId } = {}) {
  const stream = streamId
    ? await youtubeCall(call, 'liveStreams', {
      method: 'GET',
      params: { part: 'status', id: String(streamId) },
    }).then((payload) => (Array.isArray(payload.items) ? payload.items[0] : payload))
    : null;
  const broadcast = broadcastId
    ? await youtubeCall(call, 'liveBroadcasts', {
      method: 'GET',
      params: { part: 'status,snippet', id: String(broadcastId) },
    }).then((payload) => (Array.isArray(payload.items) ? payload.items[0] : payload))
    : null;

  const streamStatus = String(stream?.status?.streamStatus || '');
  const healthStatus = String(stream?.status?.healthStatus?.status || '');
  const broadcastStatus = String(broadcast?.status?.lifeCycleStatus || '');
  const preview = broadcastStatus === 'testing' || broadcastStatus === 'testStarting';
  const live = broadcastStatus === 'live' || broadcastStatus === 'liveStarting';
  const received = streamStatus === 'active' && (preview || live);

  let message = YOUTUBE_NOT_RECEIVED;
  if (isTerminalBroadcastStatus(broadcastStatus)) {
    message = `That broadcast is ${broadcastStatus} and cannot take a new ingest.`;
  } else if (received && preview) {
    message = 'YouTube preview (testing)';
  } else if (received) {
    message = 'YouTube has received the stream and the broadcast is live.';
  } else if (streamStatus === 'error') {
    message = 'YouTube reported an error on the bound stream.';
  }

  return {
    streamStatus,
    healthStatus,
    broadcastStatus,
    received,
    preview,
    terminal: isTerminalBroadcastStatus(broadcastStatus),
    message,
  };
}

/** Statuses YouTube accepts on liveBroadcasts.transition. */
export const YOUTUBE_TRANSITION_STATUSES = Object.freeze(['testing', 'live', 'complete']);

/**
 * Flip a bound broadcast to testing or live once the ingest is active.
 *
 * enableAutoStart usually does this; some channels still need the explicit
 * call, especially when monitor-stream is off and the broadcast sits in ready.
 *
 * @param {Function} call
 * @param {{broadcastId: string, broadcastStatus: string}} options
 * @returns {Promise<object>}
 */
export async function transitionYoutubeBroadcast(call, { broadcastId, broadcastStatus } = {}) {
  const id = String(broadcastId || '').trim();
  const status = String(broadcastStatus || '').trim();
  if (!id) throw new Error('A broadcast id is required');
  if (!YOUTUBE_TRANSITION_STATUSES.includes(status)) {
    throw new Error('broadcastStatus must be testing, live, or complete');
  }
  return youtubeCall(call, 'liveBroadcasts/transition', {
    method: 'POST',
    params: {
      part: 'id,snippet,status,contentDetails',
      id,
      broadcastStatus: status,
    },
  });
}

/**
 * Next lifecycle push once the bound stream is active.
 *
 * @param {object|null} health From {@link pollYoutubeBroadcast}
 * @returns {'live'|'testing'|null}
 */
export function nextYoutubeLiveTransition(health) {
  if (!health || health.terminal) return null;
  if (health.streamStatus !== 'active') return null;
  if (health.received && !health.preview) return null;
  return 'live';
}

/**
 * Build a `call(resource, { method, params, body })` from the OAuth proxy.
 *
 * @param {Function} proxy `oauth.proxy`
 * @param {object} authorization From `oauth.authorizeRequest`
 * @returns {Function}
 */
export function createYoutubeApiCaller(proxy, authorization) {
  return async function call(resource, { method = 'GET', params = {}, body } = {}) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params || {})) {
      if (value === undefined || value === null || value === '') continue;
      query.set(key, String(value));
    }
    const path = `/youtube/v3/${resource}${query.toString() ? `?${query}` : ''}`;
    const response = await proxy('youtube', path, {}, authorization, {
      method,
      body,
    });
    return response;
  };
}
