/**
 * `/api/youtube/live` — operator go-live without the ADMIN password.
 *
 * Start/stop reuse the same ffmpeg controller as `/api/admin/live`. The gate
 * here is a signed-in YouTube session (the Google cookie the Settings panel
 * already holds), plus a custom header so a cross-origin form post cannot
 * drive the encoder. The stream key is accepted on start and never returned.
 *
 * @module youtubeLiveServer
 */

import { createLiveStreamController, resolveChromiumPath, resolveFfmpegPath, splitYoutubeIngestPaste } from './liveStream.js';
import { autoGoLiveEnabled, isLoopbackAddress } from './youtubeOAuth.js';

/** Largest live-control body accepted, in bytes. */
export const YOUTUBE_LIVE_MAX_BODY_BYTES = 64 * 1024;

/**
 * Browser callers must send this header. Node lowercases incoming names, so
 * the check is the lowercase form; the client sends `X-GEV-YouTube`.
 */
export const YOUTUBE_LIVE_REQUEST_HEADER = 'x-gev-youtube';

/**
 * Split a mounted request URL into path segments.
 *
 * @param {string} url Request URL as seen after the `/api/youtube/live` mount.
 * @returns {{segments: string[], query: URLSearchParams}}
 */
export function parseYoutubeLiveRoute(url) {
  const parsed = new URL(String(url || '/'), 'http://internal');
  const segments = parsed.pathname.split('/').filter(Boolean);
  return { segments, query: parsed.searchParams };
}

/**
 * @param {object} res Node response.
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

/**
 * Read and JSON-parse a bounded request body.
 *
 * @param {object} req Node request.
 * @param {number} [limit] Byte ceiling.
 * @returns {Promise<object>}
 */
export function readJsonBody(req, limit = YOUTUBE_LIVE_MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('Request body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(text);
        resolve(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {});
      } catch {
        reject(Object.assign(new Error('Body must be JSON'), { status: 400 }));
      }
    });
  });
}

/**
 * Build the `/api/youtube/live` middleware.
 *
 * @param {object} [options]
 * @param {object} [options.live] Encoder controller; defaults to a real one.
 * @param {Function} [options.authorizeRequest] YouTube session resolver.
 * @returns {(req: object, res: object, next: Function) => void}
 */
export function createYoutubeLiveMiddleware({
  live = createLiveStreamController(),
  authorizeRequest = async () => null,
  findWritableAuthorization = async () => null,
  goNow = null,
  sessionStatus = null,
} = {}) {
  let lastPublicWatchUrl = '';

  return async function youtubeLiveMiddleware(req, res, next) {
    const { segments } = parseYoutubeLiveRoute(req.url);
    const [action] = segments;

    try {
      if (action === 'session' && req.method === 'GET') {
        const session = typeof sessionStatus === 'function' ? sessionStatus() : null;
        const liveState = live.status();
        sendJson(res, 200, {
          live: liveState,
          broadcast: session?.broadcast || (lastPublicWatchUrl ? { watchUrl: lastPublicWatchUrl } : null),
          sessionStatus: session?.status || liveState?.status || '',
        });
        return;
      }

      if (action === 'ingest-key' && req.method === 'POST') {
        if (!req.headers?.[YOUTUBE_LIVE_REQUEST_HEADER]) {
          sendJson(res, 403, {
            error: { kind: 'csrf', message: `Missing ${YOUTUBE_LIVE_REQUEST_HEADER} header` },
          });
          return;
        }
        const body = await readJsonBody(req);
        const split = splitYoutubeIngestPaste(
          String(body.streamKey || '').trim(),
          String(body.ingestUrl || 'rtmps://a.rtmp.youtube.com/live2').trim(),
        );
        const streamKey = split.streamKey;
        if (!streamKey) {
          sendJson(res, 400, {
            error: { kind: 'invalid', message: 'A YouTube stream key is required.' },
          });
          return;
        }
        const ingestUrl = split.ingestUrl;
        const watchUrl = String(body.watchUrl || '').trim();
        if (watchUrl) lastPublicWatchUrl = watchUrl;
        try {
          const result = await live.start({ streamKey, ingestUrl });
          sendJson(res, result.status === 'error' ? 502 : 202, {
            live: result,
            broadcast: watchUrl ? { watchUrl } : null,
            sessionStatus: result.status,
          });
        } catch (error) {
          sendJson(res, error?.status === 409 ? 409 : 400, {
            error: {
              kind: error?.status === 409 ? 'conflict' : 'invalid',
              message: error?.message || 'Unable to start the broadcast',
            },
            live: live.status(),
          });
        }
        return;
      }

      if (action === 'stop' && req.method === 'POST') {
        if (!req.headers?.[YOUTUBE_LIVE_REQUEST_HEADER]) {
          sendJson(res, 403, {
            error: { kind: 'csrf', message: `Missing ${YOUTUBE_LIVE_REQUEST_HEADER} header` },
          });
          return;
        }
        sendJson(res, 200, { live: await live.stop() });
        return;
      }

      if (action === 'preflight' && req.method === 'GET') {
        if (!isLoopbackAddress(req.socket?.remoteAddress || req.connection?.remoteAddress)) {
          sendJson(res, 403, { error: { kind: 'forbidden', message: 'Preflight is loopback only.' } });
          return;
        }
        const authorization = await findWritableAuthorization();
        sendJson(res, 200, {
          ready: Boolean(authorization?.canWrite),
          authenticated: Boolean(authorization),
          autoGoLive: autoGoLiveEnabled(),
          chrome: Boolean(resolveChromiumPath()),
          ffmpeg: Boolean(resolveFfmpegPath()),
        });
        return;
      }

      if (action === 'go-now' && req.method === 'POST') {
        if (!isLoopbackAddress(req.socket?.remoteAddress || req.connection?.remoteAddress)) {
          sendJson(res, 403, { error: { kind: 'forbidden', message: 'Go-now is loopback only.' } });
          return;
        }
        const authorization = await findWritableAuthorization();
        if (!authorization) {
          sendJson(res, 401, {
            error: { kind: 'authentication', message: 'Sign in to YouTube to go live.' },
          });
          return;
        }
        if (typeof goNow !== 'function') {
          sendJson(res, 503, {
            error: { kind: 'unconfigured', message: 'Go-now is not wired on this server.' },
          });
          return;
        }
        const body = await readJsonBody(req);
        try {
          const result = await goNow({ authorization, req, body });
          sendJson(res, result?.live?.status === 'error' ? 502 : 202, result);
        } catch (error) {
          sendJson(res, error?.status || 400, {
            error: {
              kind: error?.kind || 'invalid',
              message: error?.message || 'Unable to go live',
            },
          });
        }
        return;
      }

      const authorization = await authorizeRequest(req);
      if (!authorization) {
        sendJson(res, 401, {
          error: { kind: 'authentication', message: 'Sign in to YouTube to go live.' },
        });
        return;
      }

      const mutating = req.method !== 'GET' && req.method !== 'HEAD';
      if (mutating && !req.headers?.[YOUTUBE_LIVE_REQUEST_HEADER]) {
        sendJson(res, 403, {
          error: { kind: 'csrf', message: `Missing ${YOUTUBE_LIVE_REQUEST_HEADER} header` },
        });
        return;
      }

      if (!action && req.method === 'GET') {
        const session = typeof sessionStatus === 'function' ? sessionStatus() : null;
        sendJson(res, 200, {
          live: live.status(),
          broadcast: session?.broadcast || null,
          sessionStatus: session?.status || live.status()?.status || '',
        });
        return;
      }

      if (action === 'start' && req.method === 'POST') {
        const body = await readJsonBody(req);
        try {
          const result = await live.start(body);
          sendJson(res, result.status === 'error' ? 502 : 202, { live: result });
        } catch (error) {
          sendJson(res, error?.status === 409 ? 409 : 400, {
            error: {
              kind: error?.status === 409 ? 'conflict' : 'invalid',
              message: error?.message || 'Unable to start the broadcast',
            },
            live: live.status(),
          });
        }
        return;
      }

      sendJson(res, 404, { error: { kind: 'not-found', message: 'YouTube live route not found.' } });
    } catch (error) {
      if (res.writableEnded) {
        if (typeof next === 'function') next(error);
        return;
      }
      sendJson(res, error?.status || 400, {
        error: { kind: 'invalid', message: error?.message || 'YouTube live request failed.' },
      });
    }
  };
}
