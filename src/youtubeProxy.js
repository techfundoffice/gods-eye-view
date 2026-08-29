/**
 * Server-side YouTube Data API proxy.
 *
 * The browser only sees /api/youtube. The server injects the signed-in user's
 * OAuth token for every upstream request; no token or API key is accepted from
 * query parameters or request headers.
 */

export const YOUTUBE_API_PREFIX = '/youtube/v3';
export const YOUTUBE_PROXY_PREFIX = '/api/youtube';
export const YOUTUBE_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
export const YOUTUBE_CACHE_MS = 5_000;
export const YOUTUBE_MAX_CACHE_ENTRIES = 100;
export const YOUTUBE_UPSTREAM_TIMEOUT_MS = 15_000;

const SAFE_RESOURCE_PATH = /^\/youtube\/v3\/[a-z][a-z0-9]*(?:\/[a-z][a-z0-9]*)?$/i;
const BLOCKED_QUERY_KEYS = new Set([
  'key',
  'access_token',
  'authorization',
  'token',
  'api_key',
  'callback',
]);
const MAX_QUERY_VALUE_LENGTH = 2048;
const MAX_PAGE_TOKEN_LENGTH = 512;
const MAX_RESULTS_DEFAULT = 50;
const MAX_RESULTS_COMMENTS = 100;
const MAX_RESULTS_LIVE_CHAT = 200;

/**
 * Return the path the connector proxy is allowed to receive.
 * @param {string} input
 * @returns {string}
 */
export function normalizeYoutubePath(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('YouTube API path is required');
  const parsed = new URL(raw, 'https://www.googleapis.com');
  if (parsed.origin !== 'https://www.googleapis.com' || !SAFE_RESOURCE_PATH.test(parsed.pathname)) {
    throw new Error('Only YouTube Data API v3 resource paths are allowed');
  }
  return parsed.pathname;
}

/**
 * Normalize and bound a read-only YouTube request. Keeping this separate makes
 * it possible to test the security boundary without starting Vite.
 *
 * @param {string} path
 * @param {URLSearchParams|object|string} [input]
 * @returns {{path:string, search:string, params:URLSearchParams, cacheKey:string}}
 */
export function normalizeYoutubeRequest(path, input = '') {
  const normalizedPath = normalizeYoutubePath(path);
  const source = input instanceof URLSearchParams
    ? input
    : new URLSearchParams(typeof input === 'string' ? input : Object.entries(input || {}));
  const params = new URLSearchParams();
  for (const [key, value] of source.entries()) {
    const name = String(key).trim();
    const text = String(value).trim();
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name)) {
      throw new Error('Invalid YouTube query parameter');
    }
    if (BLOCKED_QUERY_KEYS.has(name.toLowerCase())) {
      throw new Error(`YouTube query parameter "${name}" is not allowed`);
    }
    if (text.length > (name.toLowerCase() === 'pagetoken' ? MAX_PAGE_TOKEN_LENGTH : MAX_QUERY_VALUE_LENGTH)) {
      throw new Error(`YouTube query parameter "${name}" is too long`);
    }
    if (name.toLowerCase() === 'maxresults') {
      const max = Number(text);
      const resource = normalizedPath.split('/').pop()?.toLowerCase();
      const ceiling = resource === 'commentthreads' || resource === 'comments'
        ? MAX_RESULTS_COMMENTS
        : resource === 'livechatmessages' ? MAX_RESULTS_LIVE_CHAT : MAX_RESULTS_DEFAULT;
      if (!Number.isInteger(max) || max < 1 || max > ceiling) {
        throw new Error(`maxResults must be an integer from 1 to ${ceiling}`);
      }
    }
    params.append(name, text);
  }
  if (!params.has('part')) {
    throw new Error('YouTube requests must include the part parameter');
  }
  const search = params.toString();
  return {
    path: normalizedPath,
    search,
    params,
    cacheKey: `${normalizedPath}?${search}`,
  };
}

/**
 * Convert YouTube's several 401/403/404 shapes into stable UI categories.
 * @param {number} status
 * @param {*} payload
 * @returns {{kind:string, code:number, message:string, reasons:string[]}}
 */
export function classifyYoutubeError(status, payload) {
  const error = payload?.error || payload || {};
  const reasons = Array.isArray(error.errors)
    ? error.errors.map((entry) => String(entry?.reason || entry?.message || '').trim()).filter(Boolean)
    : [];
  const text = String(error.message || payload?.message || '').trim();
  const normalizedText = text.toLowerCase();
  const normalizedReasons = reasons.map((reason) => reason.toLowerCase());
  let kind = 'upstream';
  if (
    status === 401
    || /invalid_grant|reauthori[sz]|auth|token|credential/.test(normalizedText)
    || normalizedReasons.some((reason) => /auth|token|login|credential/.test(reason))
  ) {
    kind = 'authentication';
  } else if (normalizedReasons.some((reason) => /quota|rate.?limit|daily.?limit/.test(reason))) {
    kind = 'quota';
  } else if (normalizedReasons.some((reason) => /commentsdisabled|comment.*disabled/.test(reason))) {
    kind = 'comments-disabled';
  } else if (status === 404 || normalizedReasons.some((reason) => /not.?found|video.?not.?found/.test(reason))) {
    kind = 'not-found';
  } else if (status === 403 || normalizedReasons.some((reason) => /forbidden|insufficient.?scope|permission/.test(reason))) {
    kind = 'forbidden';
  } else if (status === 429) {
    kind = 'rate-limit';
  } else if (status >= 400 && status < 500) {
    kind = 'invalid-request';
  }
  const fallback = {
    authentication: 'YouTube connection needs attention.',
    quota: 'YouTube API quota is exhausted or rate limited.',
    'comments-disabled': 'Comments are disabled for this video.',
    'not-found': 'The YouTube resource is private, deleted, or unavailable.',
    forbidden: 'This YouTube resource is not available with the current permissions.',
    'rate-limit': 'YouTube is rate limiting requests. Retrying more slowly.',
    'invalid-request': 'YouTube rejected this request.',
    upstream: 'YouTube is temporarily unavailable.',
  };
  return {
    kind,
    code: Number.isFinite(Number(status)) ? Number(status) : 502,
    message: fallback[kind] || fallback.upstream,
    reasons: [],
  };
}

function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
  res.end(body);
}

async function readResponseText(
  response,
  maxBytes = YOUTUBE_MAX_RESPONSE_BYTES,
  timeoutMs = YOUTUBE_UPSTREAM_TIMEOUT_MS,
) {
  if (!response?.body?.getReader) {
    const text = await Promise.race([
      response.text(),
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error('YouTube response timed out')), timeoutMs);
        timer.unref?.();
      }),
    ]);
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error('YouTube response exceeds size cap');
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    await Promise.race([
      (async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value?.byteLength || 0;
          if (total > maxBytes) throw new Error('YouTube response exceeds size cap');
          chunks.push(value);
        }
      })(),
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error('YouTube response timed out')), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // Best-effort cancellation; preserve the original size/timeout error.
    }
    throw error;
  } finally {
    reader.releaseLock?.();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return Buffer.from(merged).toString('utf8');
}

function clientKey(req) {
  return String(req.socket?.remoteAddress || 'local');
}

function makeLimiter({ windowMs = 60_000, max = 120 } = {}) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const recent = (hits.get(key) || []).filter((time) => now - time < windowMs);
    if (recent.length >= max) {
      hits.set(key, recent);
      return false;
    }
    recent.push(now);
    hits.set(key, recent);
    if (hits.size > 512) {
      for (const [candidate, times] of hits) {
        if (!times.length || now - times[times.length - 1] >= windowMs) hits.delete(candidate);
      }
    }
    return true;
  };
}

/**
 * Create a Vite-compatible middleware. The proxy factory is injected in tests;
 * production creates a fresh Replit connector for each request.
 */
export function createYoutubeProxyMiddleware({
  proxy,
  cache = new Map(),
  now = () => Date.now(),
  allow = makeLimiter(),
  cacheMs = YOUTUBE_CACHE_MS,
  maxCacheEntries = YOUTUBE_MAX_CACHE_ENTRIES,
  upstreamTimeoutMs = YOUTUBE_UPSTREAM_TIMEOUT_MS,
  enabled = true,
  allowRequest = () => true,
  authorizeRequest = null,
} = {}) {
  if (typeof proxy !== 'function') throw new TypeError('YouTube proxy requires a proxy function');
  const inFlight = new Map();
  return async function youtubeProxy(req, res, next) {
    if (!enabled) {
      sendJson(res, 403, { error: { kind: 'forbidden', message: 'YouTube account access is unavailable in public deployments.' } });
      return;
    }
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: { kind: 'method-not-allowed', message: 'YouTube proxy is read-only.' } });
      return;
    }
    if (!allowRequest(req)) {
      sendJson(res, 403, { error: { kind: 'forbidden', message: 'YouTube account access is limited to the workspace preview.' } });
      return;
    }
    const authorization = typeof authorizeRequest === 'function'
      ? await authorizeRequest(req)
      : true;
    if (!authorization) {
      sendJson(res, 401, { error: { kind: 'authentication', message: 'Sign in to YouTube to continue.' } });
      return;
    }
    try {
      const incoming = new URL(req.url || '/', 'http://localhost');
      const request = normalizeYoutubeRequest(incoming.pathname, incoming.searchParams);
      // Never key account data by IP alone: two users on the same network must
      // not share cached channel/video responses or in-flight requests.
      const identityKey = authorization?.sessionId || clientKey(req);
      const scopedCacheKey = `${identityKey}:${request.cacheKey}`;
      const timestamp = now();
      for (const [key, entry] of cache) {
        if (timestamp - entry.cachedAt >= cacheMs) cache.delete(key);
      }
      const cached = cache.get(scopedCacheKey);
      if (cached && now() - cached.cachedAt < cacheMs) {
        sendJson(res, cached.status, cached.payload, { ...cached.headers, 'X-YouTube-Cache': 'HIT' });
        return;
      }
      const pending = inFlight.get(scopedCacheKey);
      if (pending) {
        const result = await pending;
        sendJson(res, result.status, result.payload, result.headers);
        return;
      }
      if (!allow(identityKey)) {
        res.setHeader('Retry-After', '10');
        sendJson(res, 429, { error: { kind: 'rate-limit', message: 'Too many YouTube requests. Try again shortly.' } });
        return;
      }
      const operation = (async () => {
        let upstream;
        try {
          upstream = await Promise.race([
            proxy('youtube', `${request.path}?${request.search}`, req, authorization),
            new Promise((_, reject) => {
              const timer = setTimeout(() => reject(new Error('YouTube request timed out')), upstreamTimeoutMs);
              timer.unref?.();
            }),
          ]);
        } catch (error) {
          return {
            status: error?.youtubeAuth ? 401 : 502,
            payload: {
              error: error?.youtubeAuth
                ? { kind: 'authentication', message: 'YouTube sign-in has expired. Reconnect to continue.' }
                : { kind: 'upstream', message: 'Unable to reach YouTube right now.' },
            },
            headers: {},
          };
        }
        let text;
        try {
          text = await readResponseText(upstream, YOUTUBE_MAX_RESPONSE_BYTES, upstreamTimeoutMs);
        } catch (error) {
          return {
            status: 502,
            payload: { error: { kind: 'response-too-large', message: error.message } },
            headers: {},
          };
        }
        let payload;
        try {
          payload = text ? JSON.parse(text) : {};
        } catch {
          payload = { error: { kind: 'invalid-upstream', message: 'YouTube returned an invalid response.' } };
        }
        if (!upstream.ok) {
          const classified = classifyYoutubeError(upstream.status, payload);
          return { status: classified.code, payload: { error: classified }, headers: {} };
        }
        return {
          status: 200,
          payload,
          headers: {
            'X-YouTube-Cache': 'MISS',
          },
        };
      })();
      inFlight.set(scopedCacheKey, operation);
      const result = await operation;
      inFlight.delete(scopedCacheKey);
      if (result.status === 200) {
        while (cache.size >= maxCacheEntries) cache.delete(cache.keys().next().value);
        cache.set(scopedCacheKey, { ...result, cachedAt: now() });
      }
      sendJson(res, result.status, result.payload, result.headers);
    } catch (error) {
      sendJson(res, 400, {
        error: {
          kind: 'invalid-request',
          message: error?.message || 'Invalid YouTube request.',
        },
      });
      if (typeof next === 'function' && !res.writableEnded) next(error);
    }
  };
}
