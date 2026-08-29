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

export const YOUTUBE_MAX_REQUEST_BODY_BYTES = 64 * 1024;

/**
 * The only mutations this proxy forwards: the YouTube Live lifecycle needed to
 * create a broadcast, bind it to an ingest stream, and drive it live. Anything
 * outside this list stays unreachable even when the session holds a write
 * scoped token, so a write grant never becomes blanket channel access.
 */
export const YOUTUBE_WRITE_OPERATIONS = Object.freeze([
  { method: 'POST', path: '/youtube/v3/liveBroadcasts' },
  { method: 'PUT', path: '/youtube/v3/liveBroadcasts' },
  { method: 'DELETE', path: '/youtube/v3/liveBroadcasts' },
  { method: 'POST', path: '/youtube/v3/liveBroadcasts/bind' },
  { method: 'POST', path: '/youtube/v3/liveBroadcasts/transition' },
  { method: 'POST', path: '/youtube/v3/liveStreams' },
  { method: 'PUT', path: '/youtube/v3/liveStreams' },
  { method: 'DELETE', path: '/youtube/v3/liveStreams' },
]);

/**
 * @param {string} method
 * @param {string} path
 * @returns {boolean}
 */
export function isYoutubeWriteAllowed(method, path) {
  const wanted = String(method || '').toUpperCase();
  const target = String(path || '').toLowerCase();
  return YOUTUBE_WRITE_OPERATIONS.some(
    (operation) => operation.method === wanted && operation.path.toLowerCase() === target,
  );
}

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
export function normalizeYoutubeRequest(path, input = '', method = 'GET') {
  const normalizedPath = normalizeYoutubePath(path);
  const verb = String(method || 'GET').toUpperCase();
  if (verb !== 'GET' && !isYoutubeWriteAllowed(verb, normalizedPath)) {
    throw new Error('This YouTube resource cannot be modified through the proxy');
  }
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
  if (verb === 'DELETE') {
    if (!params.has('id')) {
      throw new Error('YouTube delete requests must include the id parameter');
    }
  } else if (!params.has('part')) {
    throw new Error('YouTube requests must include the part parameter');
  }
  const search = params.toString();
  return {
    path: normalizedPath,
    search,
    params,
    method: verb,
    cacheKey: `${verb} ${normalizedPath}?${search}`,
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
    normalizedReasons.some((reason) => /insufficient.?(scope|permission)/.test(reason))
    || /insufficient (authentication scopes|permission)/.test(normalizedText)
  ) {
    kind = 'insufficient-scope';
  } else if (
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
    'insufficient-scope': 'Reconnect YouTube to grant live-control permission.',
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

async function readRequestBody(req, maxBytes = YOUTUBE_MAX_REQUEST_BODY_BYTES) {
  if (typeof req?.on !== 'function') return '';
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        settled = true;
        reject(new Error('YouTube request body exceeds size cap'));
        req.destroy?.();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
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
  writeAllow = makeLimiter({ windowMs: 60_000, max: 20 }),
  cacheMs = YOUTUBE_CACHE_MS,
  maxCacheEntries = YOUTUBE_MAX_CACHE_ENTRIES,
  upstreamTimeoutMs = YOUTUBE_UPSTREAM_TIMEOUT_MS,
  maxRequestBodyBytes = YOUTUBE_MAX_REQUEST_BODY_BYTES,
  enabled = true,
  writeEnabled = false,
  allowRequest = () => true,
  authorizeRequest = null,
} = {}) {
  if (typeof proxy !== 'function') throw new TypeError('YouTube proxy requires a proxy function');
  const inFlight = new Map();

  async function runUpstream(request, req, authorization, body) {
    let upstream;
    try {
      upstream = await Promise.race([
        proxy('youtube', `${request.path}?${request.search}`, req, authorization, {
          method: request.method,
          body,
        }),
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
        'X-YouTube-Cache': request.method === 'GET' ? 'MISS' : 'BYPASS',
      },
    };
  }

  return async function youtubeProxy(req, res, next) {
    if (!enabled) {
      sendJson(res, 403, { error: { kind: 'forbidden', message: 'YouTube account access is unavailable in public deployments.' } });
      return;
    }
    const method = String(req.method || 'GET').toUpperCase();
    const isWrite = method !== 'GET';
    if (isWrite && !writeEnabled) {
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
    // A session authorized before live control was enabled still holds a
    // read-only grant; say so instead of spending a quota unit on a 403.
    if (isWrite && authorization !== true && authorization.canWrite === false) {
      sendJson(res, 403, {
        error: {
          kind: 'insufficient-scope',
          message: 'Reconnect YouTube to grant live-control permission.',
        },
      });
      return;
    }
    try {
      const incoming = new URL(req.url || '/', 'http://localhost');
      const request = normalizeYoutubeRequest(incoming.pathname, incoming.searchParams, method);
      // Never key account data by IP alone: two users on the same network must
      // not share cached channel/video responses or in-flight requests.
      const identityKey = authorization?.sessionId || clientKey(req);

      if (isWrite) {
        if (!writeAllow(identityKey)) {
          res.setHeader('Retry-After', '10');
          sendJson(res, 429, { error: { kind: 'rate-limit', message: 'Too many YouTube live-control requests. Try again shortly.' } });
          return;
        }
        let raw = '';
        try {
          raw = await readRequestBody(req, maxRequestBodyBytes);
        } catch (error) {
          sendJson(res, 413, { error: { kind: 'request-too-large', message: error.message } });
          return;
        }
        let body;
        if (raw.trim()) {
          try {
            body = JSON.parse(raw);
          } catch {
            sendJson(res, 400, { error: { kind: 'invalid-request', message: 'YouTube live-control body must be JSON.' } });
            return;
          }
          if (!body || typeof body !== 'object' || Array.isArray(body)) {
            sendJson(res, 400, { error: { kind: 'invalid-request', message: 'YouTube live-control body must be a JSON object.' } });
            return;
          }
        }
        // Mutations are never cached, deduplicated, or replayed: a repeated
        // insert must reach YouTube so the caller sees the real outcome.
        const result = await runUpstream(request, req, authorization, body);
        sendJson(res, result.status, result.payload, result.headers);
        return;
      }

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
      const operation = runUpstream(request, req, authorization, undefined);
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
