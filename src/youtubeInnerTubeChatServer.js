/**
 * `/api/youtube/live-chat` — read-only chat on our own YouTube Live page.
 *
 * Gated on the signed-in YouTube session so this is the operator's broadcast,
 * not an open chat relay. The browser sends only `videoId` + optional
 * continuation; the WEB client key and watch-page HTML never leave this process.
 *
 * @module youtubeInnerTubeChatServer
 */

import {
  createYoutubeInnerTubeChat,
  innerTubeError,
  normalizeVideoId,
} from './youtubeInnerTubeChat.js';

const OWN_BROADCAST_CACHE_TTL_MS = 10 * 60 * 1000;
const OWN_BROADCAST_CACHE_MAX_SESSIONS = 64;

/**
 * @param {string} url
 * @returns {{videoId: string, continuation: string}}
 */
export function parseLiveChatQuery(url) {
  const parsed = new URL(String(url || '/'), 'http://internal');
  return {
    videoId: String(parsed.searchParams.get('videoId') || '').trim(),
    continuation: String(parsed.searchParams.get('continuation') || '').trim(),
  };
}

/**
 * @param {object} res
 * @param {number} status
 * @param {object} payload
 * @returns {void}
 */
export function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.end(body);
}

function publicChatPayload(result) {
  return {
    items: Array.isArray(result?.items) ? result.items : [],
    nextPageToken: String(result?.nextPageToken || ''),
    pollingIntervalMillis: Number(result?.pollingIntervalMillis) || 5_000,
    videoId: String(result?.videoId || ''),
    source: 'innertube',
  };
}

/**
 * @param {object} [options]
 * @returns {(req: object, res: object, next: Function) => Promise<void>}
 */
export function createYoutubeInnerTubeChatMiddleware({
  authorizeRequest = async () => null,
  listOwnBroadcasts = async () => [],
  chat = createYoutubeInnerTubeChat(),
  ownershipCacheTtlMs = OWN_BROADCAST_CACHE_TTL_MS,
  now = () => Date.now(),
} = {}) {
  const ownershipCache = new Map();

  async function ownedBroadcasts(authorization) {
    const sessionId = String(authorization?.sessionId || '');
    if (!sessionId) return listOwnBroadcasts(authorization);
    const current = now();
    const cached = ownershipCache.get(sessionId);
    if (cached && cached.expiresAt > current) return cached.promise;

    const promise = Promise.resolve(listOwnBroadcasts(authorization))
      .then((broadcasts) => Array.isArray(broadcasts) ? broadcasts : [])
      .catch((error) => {
        if (ownershipCache.get(sessionId)?.promise === promise) ownershipCache.delete(sessionId);
        throw error;
      });
    ownershipCache.set(sessionId, {
      expiresAt: current + Math.max(1_000, Number(ownershipCacheTtlMs) || OWN_BROADCAST_CACHE_TTL_MS),
      promise,
    });
    while (ownershipCache.size > OWN_BROADCAST_CACHE_MAX_SESSIONS) {
      ownershipCache.delete(ownershipCache.keys().next().value);
    }
    return promise;
  }

  return async function youtubeInnerTubeChatMiddleware(req, res, next) {
    const method = String(req.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      sendJson(res, 405, {
        error: { kind: 'method-not-allowed', message: 'YouTube live chat is read-only.' },
      });
      return;
    }

    try {
      const authorization = await authorizeRequest(req);
      if (!authorization) {
        sendJson(res, 401, {
          error: { kind: 'authentication', message: 'Sign in to YouTube to read chat on your live page.' },
        });
        return;
      }
      const query = parseLiveChatQuery(req.url);
      const videoId = normalizeVideoId(query.videoId);
      if (!videoId) {
        throw innerTubeError('invalid-request', 'A YouTube video id is required.', 400);
      }
      const broadcasts = await ownedBroadcasts(authorization);
      if (!broadcasts.some((broadcast) => String(broadcast?.id || '') === videoId)) {
        throw innerTubeError('not-found', 'That YouTube broadcast was not found, or it is not yours.', 404);
      }

      const result = await chat.poll({
        videoId,
        continuation: query.continuation,
        cacheKey: authorization.sessionId || 'session',
      });
      sendJson(res, 200, publicChatPayload(result));
    } catch (error) {
      if (typeof next === 'function' && !error?.kind) {
        next(error);
        return;
      }
      sendJson(res, error?.status || 502, {
        error: {
          kind: error?.kind || 'upstream',
          message: error?.kind
            ? error.message
            : 'Unable to read YouTube live chat.',
        },
      });
    }
  };
}
