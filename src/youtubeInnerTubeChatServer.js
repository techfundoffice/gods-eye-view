/**
 * `/api/youtube/live-chat` — read-only InnerTube live chat for a video id.
 *
 * Gated on the signed-in YouTube session so the server is not an open chat
 * relay. The browser sends only `videoId` + optional continuation; the WEB
 * client key and watch-page HTML never leave this process.
 *
 * @module youtubeInnerTubeChatServer
 */

import {
  createYoutubeInnerTubeChat,
  innerTubeError,
  normalizeVideoId,
} from './youtubeInnerTubeChat.js';

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
  chat = createYoutubeInnerTubeChat(),
} = {}) {
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
          error: { kind: 'authentication', message: 'Sign in to YouTube to read live chat.' },
        });
        return;
      }

      const query = parseLiveChatQuery(req.url);
      const videoId = normalizeVideoId(query.videoId);
      if (!videoId) {
        throw innerTubeError('invalid-request', 'A YouTube video id is required.', 400);
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
