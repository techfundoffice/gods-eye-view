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
  isActiveLiveStatus,
  resolveLiveCaptureTarget,
} from './liveStream.js';
import {
  YOUTUBE_NOT_RECEIVED,
  createYoutubeApiCaller,
  listCompatibleBroadcasts,
  pollYoutubeBroadcast,
  provisionYoutubeBroadcast,
  redactBroadcastView,
  selectYoutubeBroadcast,
  youtubeLiveOperatorMessage,
} from './youtubeBroadcast.js';

export { YOUTUBE_NOT_RECEIVED };

/** Poll cadence while waiting for YouTube to mark the stream active. */
export const LIVE_SESSION_POLL_MS = 3000;

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
      message: 'Sign in to YouTube from the YouTube Settings panel.',
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
    if (health?.received) return 'live';
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
  };

  const publicState = {
    ...encoderState,
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
} = {}) {
  let binding = null;
  let health = null;
  let youtubeCall = null;
  let pollTimer = null;
  let account = describeAccountPhase(null);

  function snapshot() {
    return describeLiveSession(encoder.status(), {
      binding,
      health,
      account,
      encoderReady: typeof encoderReady === 'function' ? encoderReady() : encoderReady,
    });
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

  function armPoll() {
    stopPolling();
    if (!binding?.streamId || typeof youtubeCall !== 'function') return;
    pollTimer = setInterval(() => {
      void pollNow().catch(() => {});
    }, pollMs);
    pollTimer.unref?.();
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
    binding = await selectYoutubeBroadcast(call, options);
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

    let ingestUrl = String(input.ingestUrl || '').trim();
    let streamKey = String(input.streamKey || '').trim();
    const requestedBroadcast = String(input.broadcastId || '').trim();

    if (requestedBroadcast) {
      if (!binding || binding.broadcastId !== requestedBroadcast) {
        if (typeof youtubeCall !== 'function' && typeof context.call !== 'function') {
          const error = new Error(describeAccountPhase(null).message);
          error.kind = 'authentication';
          error.status = 401;
          throw error;
        }
        binding = await selectYoutubeBroadcast(context.call || youtubeCall, {
          broadcastId: requestedBroadcast,
        });
      }
    }

    if (binding?.streamKey && (!streamKey || (requestedBroadcast && requestedBroadcast === binding.broadcastId))) {
      ingestUrl = binding.ingestUrl;
      streamKey = binding.streamKey;
    }

    const started = await encoder.start({
      ...input,
      captureUrl,
      ingestUrl,
      streamKey,
      hostResolverRules: hints.hostResolverRules,
      extraHeaders: hints.extraHeaders,
    });
    if (started.status === 'encoding' && binding?.streamId) {
      armPoll();
      void pollNow(context.call || youtubeCall).catch(() => {});
    }
    const publicState = snapshot();
    assertNoStreamKey(publicState, streamKey);
    return publicState;
  }

  async function stop() {
    stopPolling();
    health = null;
    await encoder.stop();
    return snapshot();
  }

  return {
    start,
    stop,
    status: snapshot,
    provision,
    select,
    listBroadcasts,
    bindAuth,
    pollNow,
    asEncoder: () => ({ start, stop, status: snapshot }),
  };
}
