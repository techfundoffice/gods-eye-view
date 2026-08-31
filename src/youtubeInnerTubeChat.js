/**
 * Read-only YouTube live chat via InnerTube (the web `get_live_chat` surface).
 *
 * Protocol follows Agash/YTLiveChat: fetch `/watch?v=` for the WEB client key
 * and continuation, then POST `youtubei/v1/live_chat/get_live_chat`. This path
 * does not spend YouTube Data API quota. It is unofficial; payloads can change.
 * Callers must keep tokens and HTML on the server.
 *
 * @module youtubeInnerTubeChat
 */

export const INNERTUBE_ORIGIN = 'https://www.youtube.com';
export const INNERTUBE_CHAT_PATH = '/youtubei/v1/live_chat/get_live_chat';
export const INNERTUBE_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
export const INNERTUBE_MAX_HTML_BYTES = 2 * 1024 * 1024;
export const INNERTUBE_MAX_JSON_BYTES = 1 * 1024 * 1024;
export const INNERTUBE_MAX_CONTINUATION = 4096;
export const INNERTUBE_UPSTREAM_TIMEOUT_MS = 15_000;
export const INNERTUBE_SESSION_CACHE_MS = 10 * 60 * 1000;
export const INNERTUBE_MAX_SESSIONS = 32;
export const YOUTUBE_VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

/**
 * @param {string} kind
 * @param {string} message
 * @param {number} [status]
 * @returns {Error}
 */
export function innerTubeError(kind, message, status = 502) {
  const error = new Error(message);
  error.kind = kind;
  error.status = status;
  return error;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeVideoId(value) {
  const raw = String(value || '').trim();
  const fromUrl = raw.match(/(?:v=|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  const id = fromUrl ? fromUrl[1] : raw;
  return YOUTUBE_VIDEO_ID_RE.test(id) ? id : '';
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeContinuation(value) {
  const token = String(value || '').trim();
  if (!token) return '';
  if (token.length > INNERTUBE_MAX_CONTINUATION) {
    throw innerTubeError('invalid-request', 'Continuation token is too long.', 400);
  }
  return token;
}

/**
 * @param {string} html
 * @returns {boolean}
 */
export function isConsentInterstitial(html) {
  const raw = String(html || '');
  return /consent\.youtube\.com/i.test(raw) || /Before you continue to YouTube/i.test(raw);
}

/**
 * Concatenate InnerTube message runs to plain text (emoji shortcuts, no images).
 *
 * @param {unknown} runs
 * @returns {string}
 */
export function messageRunsToText(runs) {
  if (typeof runs === 'string') return runs.trim();
  if (runs && typeof runs === 'object' && !Array.isArray(runs)) {
    const simple = runs.simpleText || runs.text;
    if (typeof simple === 'string') return simple.trim();
    if (Array.isArray(runs.runs)) return messageRunsToText(runs.runs);
    return '';
  }
  if (!Array.isArray(runs)) return '';
  return runs.map((run) => {
    if (!run || typeof run !== 'object') return '';
    if (typeof run.text === 'string') return run.text;
    const emoji = run.emoji;
    if (emoji && typeof emoji === 'object') {
      if (Array.isArray(emoji.shortcuts) && emoji.shortcuts[0]) return String(emoji.shortcuts[0]);
      if (emoji.emojiId) return String(emoji.emojiId);
    }
    return '';
  }).join('').trim();
}

/**
 * @param {unknown} renderer
 * @returns {{moderator: boolean, owner: boolean}}
 */
function authorRoles(renderer) {
  const badges = Array.isArray(renderer?.authorBadges) ? renderer.authorBadges : [];
  let moderator = false;
  let owner = false;
  for (const badge of badges) {
    const type = badge?.liveChatAuthorBadgeRenderer?.icon?.iconType;
    if (type === 'MODERATOR') moderator = true;
    if (type === 'OWNER') owner = true;
  }
  return { moderator, owner };
}

/**
 * Map an InnerTube chat renderer onto the Data API liveChatMessages item shape
 * so existing `normalizeLiveChatMessage` / harness ingest keep working.
 *
 * @param {object} renderer
 * @param {string} [type]
 * @returns {object|null}
 */
export function innerTubeRendererToDataApiItem(renderer, type = 'textMessageEvent') {
  if (!renderer || typeof renderer !== 'object') return null;
  const id = String(renderer.id || '').trim();
  const text = messageRunsToText(renderer.message);
  if (!id || !text) return null;
  const usec = Number(renderer.timestampUsec);
  const publishedAt = Number.isFinite(usec) && usec > 0
    ? new Date(Math.floor(usec / 1000)).toISOString()
    : '';
  const { moderator, owner } = authorRoles(renderer);
  const authorName = renderer.authorName?.simpleText
    || renderer.authorName?.text
    || messageRunsToText(renderer.authorName)
    || '';
  const eventType = renderer.purchaseAmountText ? 'superChatEvent' : type;
  return {
    id,
    snippet: {
      type: eventType,
      displayMessage: text,
      publishedAt,
      textMessageDetails: { messageText: text },
    },
    authorDetails: {
      displayName: authorName,
      channelId: String(renderer.authorExternalChannelId || '').trim(),
      isChatModerator: moderator,
      isChatOwner: owner,
    },
  };
}

/**
 * @param {unknown} action
 * @returns {object|null}
 */
export function rendererFromAction(action) {
  if (!action || typeof action !== 'object') return null;
  const item = action.addChatItemAction?.item
    || action.replayChatItemAction?.actions?.[0]?.addChatItemAction?.item;
  if (!item || typeof item !== 'object') return null;
  return item.liveChatTextMessageRenderer
    || item.liveChatPaidMessageRenderer
    || null;
}

/**
 * @param {unknown} payload
 * @returns {{items: object[], continuation: string, timeoutMs: number}}
 */
export function parseLiveChatResponse(payload) {
  const continuationContents = payload?.continuationContents?.liveChatContinuation || {};
  const actions = Array.isArray(continuationContents.actions) ? continuationContents.actions : [];
  const items = [];
  for (const action of actions) {
    const mapped = innerTubeRendererToDataApiItem(rendererFromAction(action));
    if (mapped) items.push(mapped);
  }
  const list = Array.isArray(continuationContents.continuations)
    ? continuationContents.continuations
    : [];
  const first = list[0] || {};
  const timed = first.timedContinuationData || first.invalidationContinuationData || {};
  const fallback = payload?.invalidationContinuationData || {};
  const continuation = String(timed.continuation || fallback.continuation || '').trim();
  const timeoutMs = Number(timed.timeoutMs || fallback.timeoutMs);
  return {
    items,
    continuation,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 5_000,
  };
}

/**
 * @param {string} html
 * @returns {string}
 */
function extractLiveId(html) {
  const canonical = String(html || '').match(
    /rel=["']canonical["'][^>]*href=["']https:\/\/www\.youtube\.com\/watch\?v=([A-Za-z0-9_-]{11})/i,
  );
  if (canonical) return canonical[1];
  const details = String(html || '').match(/"videoId"\s*:\s*"([A-Za-z0-9_-]{11})"/);
  return details ? details[1] : '';
}

/**
 * Prefer the live-chat continuation over other page continuations.
 *
 * @param {string} html
 * @returns {string}
 */
function extractInitialContinuation(html) {
  const raw = String(html || '');
  const liveChunk = raw.match(/liveChatRenderer[\s\S]{0,12000}/);
  const fromChat = liveChunk?.[0]?.match(/"continuation"\s*:\s*"([^"]+)"/);
  if (fromChat?.[1]) return fromChat[1];
  return raw.match(/"continuation"\s*:\s*"([^"]+)"/)?.[1] || '';
}

/**
 * Bootstrap InnerTube options from a watch-page HTML document.
 *
 * @param {string} html
 * @returns {{apiKey: string, clientVersion: string, continuation: string, liveId: string}}
 */
export function parseWatchPageOptions(html) {
  const raw = String(html || '');
  if (isConsentInterstitial(raw)) {
    throw innerTubeError('unavailable', 'YouTube presented a consent interstitial.', 503);
  }
  if (/"isReplay"\s*:\s*true/.test(raw)) {
    throw innerTubeError('ended', 'This live broadcast has ended.', 404);
  }
  const apiKey = raw.match(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/)?.[1] || '';
  const clientVersion = raw.match(/"INNERTUBE_CONTEXT_CLIENT_VERSION"\s*:\s*"([^"]+)"/)?.[1] || '';
  if (!apiKey) throw innerTubeError('unavailable', 'YouTube live chat key was not found.', 502);
  if (!clientVersion) throw innerTubeError('unavailable', 'YouTube live chat client version was not found.', 502);
  const continuation = extractInitialContinuation(raw);
  if (!continuation) throw innerTubeError('no-chat', 'No active live chat for this video.', 404);
  const liveId = extractLiveId(raw);
  return { apiKey, clientVersion, continuation, liveId };
}

/**
 * @param {Response} response
 * @param {number} maxBytes
 * @returns {Promise<string>}
 */
async function readBoundedText(response, maxBytes) {
  if (response?.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value?.byteLength || 0;
        if (total > maxBytes) throw innerTubeError('upstream', 'YouTube response exceeds size cap.', 502);
        chunks.push(value);
      }
    } finally {
      try { reader.releaseLock?.(); } catch { /* ignore */ }
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return Buffer.from(merged).toString('utf8');
  }
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw innerTubeError('upstream', 'YouTube response exceeds size cap.', 502);
  }
  return text;
}

/**
 * @param {AbortSignal|undefined} signal
 * @param {number} timeoutMs
 * @returns {AbortSignal}
 */
function mergeTimeout(signal, timeoutMs) {
  const timeout = typeof AbortSignal?.timeout === 'function'
    ? AbortSignal.timeout(timeoutMs)
    : undefined;
  if (timeout && signal && typeof AbortSignal.any === 'function') return AbortSignal.any([signal, timeout]);
  return timeout || signal;
}

/**
 * @param {string} videoId
 * @param {{fetchImpl: Function, signal?: AbortSignal}} options
 * @returns {Promise<string>}
 */
export async function fetchWatchPage(videoId, { fetchImpl, signal } = {}) {
  const id = normalizeVideoId(videoId);
  if (!id) throw innerTubeError('invalid-request', 'A YouTube video id is required.', 400);
  const url = `${INNERTUBE_ORIGIN}/watch?v=${encodeURIComponent(id)}&hl=en`;
  const response = await fetchImpl(url, {
    method: 'GET',
    redirect: 'follow',
    signal: mergeTimeout(signal, INNERTUBE_UPSTREAM_TIMEOUT_MS),
    headers: {
      'User-Agent': INNERTUBE_USER_AGENT,
      'Accept-Language': 'en-US,en;q=0.9',
      Accept: 'text/html,application/xhtml+xml',
    },
  });
  const finalUrl = String(response.url || url);
  if (/consent\.youtube\.com/i.test(finalUrl)) {
    throw innerTubeError('unavailable', 'YouTube presented a consent interstitial.', 503);
  }
  if (!response.ok) {
    throw innerTubeError(
      response.status === 404 ? 'not-found' : 'upstream',
      'Unable to load the YouTube watch page.',
      response.status === 404 ? 404 : 502,
    );
  }
  return readBoundedText(response, INNERTUBE_MAX_HTML_BYTES);
}

/**
 * @param {object} options
 * @returns {Promise<object>}
 */
export async function fetchLiveChatPage({
  fetchImpl,
  signal,
  apiKey,
  clientVersion,
  continuation,
  liveId,
} = {}) {
  const key = String(apiKey || '').trim();
  const token = normalizeContinuation(continuation);
  if (!key || !token) throw innerTubeError('unavailable', 'YouTube live chat session is incomplete.', 502);
  const url = `${INNERTUBE_ORIGIN}${INNERTUBE_CHAT_PATH}?prettyPrint=false&key=${encodeURIComponent(key)}`;
  const response = await fetchImpl(url, {
    method: 'POST',
    redirect: 'follow',
    signal: mergeTimeout(signal, INNERTUBE_UPSTREAM_TIMEOUT_MS),
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': INNERTUBE_USER_AGENT,
      Origin: INNERTUBE_ORIGIN,
      Referer: `${INNERTUBE_ORIGIN}/watch?v=${encodeURIComponent(liveId || '')}`,
    },
    body: JSON.stringify({
      context: {
        client: {
          clientName: 'WEB',
          clientVersion: String(clientVersion || '').trim() || '2.20240827.01.00',
        },
      },
      continuation: token,
    }),
  });
  const text = await readBoundedText(response, INNERTUBE_MAX_JSON_BYTES);
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw innerTubeError('upstream', 'YouTube returned an invalid live chat response.', 502);
  }
  if (!response.ok) {
    if (response.status === 429) throw innerTubeError('rate-limit', 'YouTube is rate limiting live chat.', 429);
    throw innerTubeError('upstream', 'Unable to read YouTube live chat.', response.status >= 400 ? response.status : 502);
  }
  return payload;
}

function evictOldest(cache) {
  if (cache.size <= INNERTUBE_MAX_SESSIONS) return;
  const first = cache.keys().next().value;
  if (first !== undefined) cache.delete(first);
}

/**
 * Server-side InnerTube live-chat poller. HTML bootstrap and WEB client keys
 * stay in this process; the browser only sees normalized messages.
 *
 * @param {object} [options]
 * @returns {{poll: Function, cache: Map}}
 */
export function createYoutubeInnerTubeChat({
  fetchImpl = globalThis.fetch,
  now = Date.now,
  cache = new Map(),
  cacheMs = INNERTUBE_SESSION_CACHE_MS,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('InnerTube chat requires fetch');

  async function ensureSession(cacheKey, videoId, signal) {
    const cached = cache.get(cacheKey);
    const fresh = cached && (now() - cached.at) < cacheMs && cached.apiKey && cached.clientVersion;
    if (fresh) return cached;
    const html = await fetchWatchPage(videoId, { fetchImpl, signal });
    const options = parseWatchPageOptions(html);
    const session = { ...options, liveId: options.liveId || videoId, at: now() };
    cache.set(cacheKey, session);
    evictOldest(cache);
    return session;
  }

  /**
   * @param {{videoId?: string, continuation?: string, cacheKey?: string, signal?: AbortSignal}} [request]
   * @returns {Promise<{items: object[], nextPageToken: string, pollingIntervalMillis: number, videoId: string, source: string}>}
   */
  async function poll(request = {}) {
    const videoId = normalizeVideoId(request.videoId);
    if (!videoId) throw innerTubeError('invalid-request', 'A YouTube video id is required.', 400);
    const continuation = normalizeContinuation(request.continuation);
    const cacheKey = `${String(request.cacheKey || 'local')}:${videoId}`;
    const session = await ensureSession(cacheKey, videoId, request.signal);
    const token = continuation || session.continuation;
    const payload = await fetchLiveChatPage({
      fetchImpl,
      signal: request.signal,
      apiKey: session.apiKey,
      clientVersion: session.clientVersion,
      continuation: token,
      liveId: session.liveId || videoId,
    });
    const parsed = parseLiveChatResponse(payload);
    cache.set(cacheKey, {
      ...session,
      continuation: parsed.continuation || session.continuation,
      at: now(),
    });
    return {
      items: parsed.items,
      nextPageToken: parsed.continuation || '',
      pollingIntervalMillis: parsed.timeoutMs,
      videoId: session.liveId || videoId,
      source: 'innertube',
    };
  }

  return { poll, cache };
}
