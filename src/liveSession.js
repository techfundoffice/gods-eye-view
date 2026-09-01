/**
 * Normalized live-session contract for ADMIN Go Live and the operator encoder.
 *
 * The ffmpeg controller reports `encoding`. This module is what may promote
 * that to `waiting-for-youtube` or `live`, and it is the only place a bound
 * stream key is stored.
 *
 * @module liveSession
 */

import {
  LIVE_DEFAULTS,
  chromiumCaptureHints,
  createLiveStreamController,
  describeEncoderReadiness,
  encoderCaptureFromHints,
  isActiveLiveStatus,
  resolveLiveCaptureTarget,
} from './liveStream.js';
import {
  YOUTUBE_NOT_RECEIVED,
  createYoutubeApiCaller,
  listCompatibleBroadcasts,
  nextYoutubeLiveTransition,
  pollYoutubeBroadcast,
  provisionYoutubeBroadcast,
  redactBroadcastView,
  selectYoutubeBroadcast,
  transitionYoutubeBroadcast,
  youtubeLiveOperatorMessage,
} from './youtubeBroadcast.js';
import { describeOdbcPersistence, recordLiveAuditEvent } from './odbcLiveAudit.js';

export { YOUTUBE_NOT_RECEIVED };

/** Poll cadence while waiting for YouTube to mark the stream active. */
export const LIVE_SESSION_POLL_MS = 3000;

/** How long go-now waits for YouTube to report live after ingest starts. */
export const LIVE_SESSION_CONFIRM_MS = 90_000;

/**
 * Account-readiness row from the current YouTube OAuth authorization.
 *
 * @param {object|null} authorization
 * @returns {{ready: boolean, message: string, canWrite: boolean}}
 */
export function describeAccountPhase(authorization) {
  if (!authorization) {
    return {
      ready: false,
      canWrite: false,
      message: 'Paste a current Studio stream key, or sign in to create a broadcast.',
    };
  }
  if (authorization.canWrite === false) {
    return {
      ready: false,
      canWrite: false,
      message: 'Reconnect YouTube to grant live-control permission.',
    };
  }
  return {
    ready: true,
    canWrite: true,
    message: 'YouTube account can create and control broadcasts.',
  };
}

/**
 * Derive the public session status from encoder + YouTube health.
 *
 * @param {object} encoderState
 * @param {object|null} health
 * @param {object|null} binding
 * @returns {string}
 */
export function deriveLiveSessionStatus(encoderState = {}, health = null, binding = null) {
  const encoderStatus = String(encoderState.status || 'idle');
  if (encoderStatus === 'error' || encoderStatus === 'stopped' || encoderStatus === 'idle') {
    return encoderStatus;
  }
  if (encoderStatus === 'starting') return 'starting';
  if (health?.terminal) return 'error';
  if (encoderStatus === 'encoding' || isActiveLiveStatus(encoderStatus)) {
    const streamVerified = health?.received
      && (!health?.streamStatus || health.streamStatus === 'active')
      && (!health?.broadcastStatus
        || ['live', 'liveStarting'].includes(String(health.broadcastStatus)));
    if (streamVerified) {
      return 'live';
    }
    if (binding?.streamId) {
      return encoderState.framesSent > 0 ? 'waiting-for-youtube' : 'encoding';
    }
    return encoderState.framesSent > 0 ? 'ingesting' : 'encoding';
  }
  return encoderStatus;
}

/**
 * Public, credential-free session document for ADMIN and the operator panel.
 *
 * @param {object} encoderState From {@link describeLiveState}.
 * @param {object} [context]
 * @returns {object}
 */
export function describeLiveSession(encoderState, {
  binding = null,
  health = null,
  account = describeAccountPhase(null),
  encoderReady = describeEncoderReadiness(),
  odbc = describeOdbcPersistence(),
  generation = 0,
} = {}) {
  const status = deriveLiveSessionStatus(encoderState, health, binding);
  const broadcastView = binding ? redactBroadcastView(binding) : null;
  const framesFlowing = (encoderState.framesSent || 0) > 0
    && isActiveLiveStatus(encoderState.status);
  const encoderRunning = encoderState.status === 'encoding' || encoderState.status === 'starting';

  const phases = {
    account: {
      ready: Boolean(account?.ready),
      message: account?.message || describeAccountPhase(null).message,
    },
    broadcast: broadcastView
      ? {
        ready: true,
        message: `${broadcastView.title || broadcastView.id} · ${broadcastView.lifeCycleStatus || 'ready'}`,
      }
      : { ready: false, message: 'Create or select a YouTube broadcast.' },
    capture: encoderState.captureUrl
      ? { ready: encoderRunning || status === 'error', message: encoderState.captureUrl }
      : { ready: false, message: 'Capture URL will be probed when the broadcast starts.' },
    encoder: {
      ready: Boolean(encoderReady?.ready) && (encoderRunning || !isActiveLiveStatus(status)),
      message: encoderRunning
        ? `Encoder running · ${encoderState.settings?.width || LIVE_DEFAULTS.width}x${encoderState.settings?.height || LIVE_DEFAULTS.height}`
        : (encoderReady?.message || 'ffmpeg and Chromium are not ready.'),
    },
    ingest: {
      ready: framesFlowing,
      message: framesFlowing
        ? `Publishing to ${encoderState.target || broadcastView?.target || 'RTMP'}`
        : (encoderRunning ? 'Waiting for the first capture frame.' : 'Encoder is not publishing.'),
    },
    youtube: {
      ready: Boolean(health?.received),
      streamStatus: health?.streamStatus || '',
      healthStatus: health?.healthStatus || '',
      broadcastStatus: health?.broadcastStatus || (broadcastView?.lifeCycleStatus || ''),
      message: youtubePhaseMessage(status, health, binding),
    },
    odbc: {
      ready: Boolean(odbc?.ready),
      available: Boolean(odbc?.available),
      message: odbc?.message || describeOdbcPersistence().message,
    },
  };

  const publicState = {
    ...encoderState,
    generation: Math.max(0, Number(generation) || 0),
    status,
    broadcast: broadcastView,
    phases,
    error: terminalSessionError(encoderState, health, status),
  };
  assertNoStreamKey(publicState, binding?.streamKey);
  return publicState;
}

/**
 * @param {string} status
 * @param {object|null} health
 * @param {object|null} binding
 * @returns {string}
 */
export function youtubePhaseMessage(status, health, binding) {
  if (health?.message) return health.message;
  if (status === 'waiting-for-youtube') return YOUTUBE_NOT_RECEIVED;
  if (status === 'live' && health?.preview) return 'YouTube preview (testing)';
  if (status === 'live') return 'YouTube has received the stream and the broadcast is live.';
  if (!binding?.streamId) return 'YouTube API confirmation unavailable (no broadcast id)';
  return 'YouTube has not been polled yet.';
}

function terminalSessionError(encoderState, health, status) {
  if (status === 'error' && health?.terminal) {
    return health.message || 'That broadcast can no longer take this ingest. Stop, then create or select a new broadcast.';
  }
  return encoderState.error || null;
}

function assertNoStreamKey(value, streamKey) {
  const key = String(streamKey || '').trim();
  if (!key) return;
  if (JSON.stringify(value).includes(key)) {
    throw new Error('Refusing to return live session state that contains the stream key');
  }
}

export function liveStatusLabel(status) {
  switch (String(status || '')) {
    case 'starting': return 'STARTING';
    case 'encoding': return 'ENCODING';
    case 'ingesting': return 'INGESTING';
    case 'waiting-for-youtube': return 'WAITING FOR YOUTUBE';
    case 'live': return 'LIVE';
    case 'public-live-unverified': return 'LIVE · UNVERIFIED';
    case 'reconnecting': return 'RECONNECTING';
    case 'stopping': return 'STOPPING';
    case 'stopped': return 'STOPPED';
    case 'error': return 'ERROR';
    default: return 'OFFLINE';
  }
}

/**
 * Whether the start button should be offered.
 *
 * @param {object} live
 * @returns {boolean}
 */
export function canStartLive(live) {
  return !isActiveLiveStatus(live?.status);
}

/**
 * Create the shared live session.
 *
 * @param {object} [deps]
 * @returns {object}
 */
export function createLiveSessionController({
  encoder = createLiveStreamController(),
  pollMs = LIVE_SESSION_POLL_MS,
  now = () => Date.now(),
  encoderReady = describeEncoderReadiness,
  odbc = describeOdbcPersistence,
  audit = recordLiveAuditEvent,
} = {}) {
  let binding = null;
  let health = null;
  let youtubeCall = null;
  let pollTimer = null;
  let account = describeAccountPhase(null);
  let generation = 0;

  function advanceGeneration() {
    generation += 1;
    return generation;
  }

  function snapshot() {
    return describeLiveSession(encoder.status(), {
      binding,
      health,
      account,
      encoderReady: typeof encoderReady === 'function' ? encoderReady() : encoderReady,
      odbc: typeof odbc === 'function' ? odbc() : odbc,
      generation,
    });
  }

  function auditLater(event, live) {
    if (typeof audit !== 'function') return;
    void Promise.resolve(audit({ event, live })).catch(() => {});
  }

  function stopPolling() {
    if (!pollTimer) return;
    clearInterval(pollTimer);
    pollTimer = null;
  }

  /**
   * @param {Function} [call]
   * @returns {Promise<object|null>}
   */
  async function pollNow(call = youtubeCall) {
    if (!binding?.streamId || typeof call !== 'function') return health;
    try {
      health = await pollYoutubeBroadcast(call, {
        broadcastId: binding.broadcastId,
        streamId: binding.streamId,
      });
    } catch (error) {
      if (error?.kind === 'authentication' || error?.kind === 'insufficient-scope' || error?.kind === 'quota') {
        health = {
          ...(health || {}),
          received: false,
          streamStatus: health?.streamStatus || '',
          healthStatus: health?.healthStatus || '',
          broadcastStatus: health?.broadcastStatus || '',
          message: youtubeLiveOperatorMessage(error.kind, error.message),
        };
        return health;
      }
      throw error;
    }
    return health;
  }

  function armPoll(call = youtubeCall, autoGoLive = true) {
    stopPolling();
    if (!binding?.streamId || typeof call !== 'function') return;
    pollTimer = setInterval(() => {
      void pollAndMaybeTransition(call, autoGoLive).catch(() => {});
    }, pollMs);
    pollTimer.unref?.();
  }

  async function pollAndMaybeTransition(call = youtubeCall, autoGoLive = true) {
    await pollNow(call);
    const next = autoGoLive ? nextYoutubeLiveTransition(health) : null;
    if (next && binding?.broadcastId && typeof call === 'function') {
      await transitionYoutubeBroadcast(call, {
        broadcastId: binding.broadcastId,
        broadcastStatus: next,
      });
      await pollNow(call);
    }
    return health;
  }

  /**
   * Remember the YouTube authorization for later polls and the account row.
   *
   * @param {object|null} authorization
   * @param {Function} [proxy]
   * @returns {Function|null} API caller, or null.
   */
  function bindAuth(authorization, proxy) {
    account = describeAccountPhase(authorization);
    // A later GET without the YouTube cookie must not drop the poll caller
    // that is waiting for ingest confirmation.
    if (authorization && authorization.canWrite !== false && typeof proxy === 'function') {
      youtubeCall = createYoutubeApiCaller(proxy, authorization);
    }
    return youtubeCall;
  }

  async function provision(options, call = youtubeCall) {
    if (typeof call !== 'function') {
      const error = new Error(describeAccountPhase(null).message);
      error.kind = 'authentication';
      error.status = 401;
      throw error;
    }
    binding = await provisionYoutubeBroadcast(call, options);
    advanceGeneration();
    health = null;
    return {
      broadcast: redactBroadcastView(binding),
      live: snapshot(),
    };
  }

  async function select(options, call = youtubeCall) {
    if (typeof call !== 'function') {
      const error = new Error(describeAccountPhase(null).message);
      error.kind = 'authentication';
      error.status = 401;
      throw error;
    }
    const nextBinding = await selectYoutubeBroadcast(call, options);
    if (nextBinding?.broadcastId !== binding?.broadcastId || nextBinding?.streamId !== binding?.streamId) {
      advanceGeneration();
    }
    binding = nextBinding;
    health = null;
    return {
      broadcast: redactBroadcastView(binding),
      live: snapshot(),
    };
  }

  async function listBroadcasts(call = youtubeCall) {
    if (typeof call !== 'function') {
      const error = new Error(describeAccountPhase(null).message);
      error.kind = 'authentication';
      error.status = 401;
      throw error;
    }
    return listCompatibleBroadcasts(call);
  }

  /**
   * Resolve ingest + capture, then start the encoder.
   *
   * @param {object} input
   * @param {object} [context]
   * @returns {Promise<object>}
   */
  async function start(input = {}, context = {}) {
    if (context.authorization !== undefined || context.proxy) {
      bindAuth(context.authorization || null, context.proxy);
    }
    const env = context.env || process.env;
    const captureUrl = resolveLiveCaptureTarget({
      requested: input.captureUrl,
      req: context.req || null,
      env,
    });
    const hints = chromiumCaptureHints(captureUrl, env);
    const encoderCapture = encoderCaptureFromHints(captureUrl, hints);

    let ingestUrl = String(input.ingestUrl || '').trim();
    let streamKey = String(input.streamKey || '').trim();
    const requestedBroadcast = String(input.broadcastId || '').trim();
    let bindingChanged = false;

    if (requestedBroadcast) {
      if (!binding || binding.broadcastId !== requestedBroadcast) {
        if (typeof youtubeCall !== 'function' && typeof context.call !== 'function') {
          const error = new Error(describeAccountPhase(null).message);
          error.kind = 'authentication';
          error.status = 401;
          throw error;
        }
        const nextBinding = await selectYoutubeBroadcast(context.call || youtubeCall, {
          broadcastId: requestedBroadcast,
        });
        bindingChanged = nextBinding?.broadcastId !== binding?.broadcastId
          || nextBinding?.streamId !== binding?.streamId;
        binding = nextBinding;
        if (bindingChanged) advanceGeneration();
      }
    }

    if (binding?.streamKey && (!streamKey || (requestedBroadcast && requestedBroadcast === binding.broadcastId))) {
      ingestUrl = binding.ingestUrl;
      streamKey = binding.streamKey;
    }

    const autoGoLive = input.autoGoLive !== false;
    const beforeStatus = encoder.status();
    const started = await encoder.start({
      ...input,
      captureUrl: encoderCapture.captureUrl,
      ingestUrl,
      streamKey,
      hostResolverRules: encoderCapture.hostResolverRules,
      extraHeaders: encoderCapture.extraHeaders,
    });
    if (!bindingChanged && !isActiveLiveStatus(beforeStatus?.status) && isActiveLiveStatus(started?.status)) {
      advanceGeneration();
    }
    if (started.status === 'encoding' && binding?.streamId) {
      const call = context.call || youtubeCall;
      armPoll(call, autoGoLive);
      void pollAndMaybeTransition(call, autoGoLive).catch(() => {});
    }
    const publicState = snapshot();
    assertNoStreamKey(publicState, streamKey);
    auditLater(publicState.status, publicState);
    return publicState;
  }

  /**
   * Poll YouTube until the bound stream is live, transitioning if auto-start
   * leaves the broadcast in ready/testing after ingest is active.
   *
   * @param {object} [options]
   * @returns {Promise<object>} Public session snapshot.
   */
  async function waitForLive({
    timeoutMs = LIVE_SESSION_CONFIRM_MS,
    intervalMs = pollMs,
    call = youtubeCall,
    now: nowFn = now,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {}) {
    const deadline = nowFn() + Math.max(0, Number(timeoutMs) || 0);
    const wait = Math.max(50, Number(intervalMs) || pollMs);
    const tried = new Set();
    while (nowFn() < deadline) {
      if (binding?.streamId && typeof call === 'function') {
        await pollNow(call).catch(() => {});
      }
      const snap = snapshot();
      if (snap.status === 'live' && health?.received && !health?.preview) return snap;
      if (health?.terminal) return snap;
      const next = nextYoutubeLiveTransition(health);
      if (next && binding?.broadcastId && typeof call === 'function' && !tried.has(next)) {
        tried.add(next);
        try {
          await transitionYoutubeBroadcast(call, {
            broadcastId: binding.broadcastId,
            broadcastStatus: next,
          });
          await pollNow(call).catch(() => {});
          const after = snapshot();
          if (after.status === 'live' && health?.received && !health?.preview) return after;
        } catch {
          // Auto-start may still win on the next poll.
        }
      }
      if (nowFn() + wait >= deadline) break;
      await sleep(wait);
    }
    if (binding?.streamId && typeof call === 'function') {
      await pollNow(call).catch(() => {});
    }
    return snapshot();
  }

  async function stop() {
    stopPolling();
    health = null;
    await encoder.stop();
    advanceGeneration();
    const publicState = snapshot();
    auditLater('stopped', publicState);
    return publicState;
  }

  async function refresh() {
    if (typeof encoder.refresh !== 'function') {
      const error = new Error('The live capture cannot be refreshed by this encoder.');
      error.status = 409;
      throw error;
    }
    await encoder.refresh();
    const publicState = snapshot();
    auditLater('refreshed', publicState);
    return publicState;
  }

  return {
    start,
    refresh,
    stop,
    status: snapshot,
    provision,
    select,
    listBroadcasts,
    bindAuth,
    pollNow,
    waitForLive,
    asEncoder: () => ({ start, refresh, stop, status: snapshot }),
  };
}
