/**
 * Quota-free live-comment ingest: public channel /live identity + InnerTube
 * chat. One worker talks to YouTube; homepage clients only read memory.
 *
 * @module youtubeLiveCommentIngest
 */

import {
  INNERTUBE_USER_AGENT,
  createYoutubeInnerTubeChat,
  normalizeVideoId,
} from './youtubeInnerTubeChat.js';

export const DEFAULT_CHANNEL_HANDLE = 'TechfundOffice';
export const DEFAULT_BUFFER_SIZE = 1000;
export const LIVE_DISCOVERY_TTL_MS = 60_000;

const WATCH_ID_RE = /(?:watch\?v=|youtu\.be\/)([A-Za-z0-9_-]{11})/;

/**
 * @param {string} handle
 * @returns {string}
 */
export function channelLiveUrl(handle) {
  const name = String(handle || '').trim().replace(/^@/, '');
  return name ? `https://www.youtube.com/@${name}/live` : '';
}

/**
 * Parse a YouTube watch/live HTML page for the current public broadcast.
 * Does not use the Data API.
 *
 * @param {string} html
 * @returns {{videoId: string, title: string, watchUrl: string, isLive: boolean}}
 */
export function parseChannelLivePage(html) {
  const raw = String(html || '');
  const canonical = raw.match(/<link rel="canonical" href="([^"]+)"/i)?.[1]
    || raw.match(/<meta property="og:url" content="([^"]+)"/i)?.[1]
    || '';
  const videoId = normalizeVideoId(canonical.match(WATCH_ID_RE)?.[1] || '')
    || normalizeVideoId(raw.match(/"videoId"\s*:\s*"([A-Za-z0-9_-]{11})"/)?.[1] || '');
  const title = String(raw.match(/<meta property="og:title" content="([^"]+)"/i)?.[1] || '')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .trim();
  const isLive = /"isLiveNow"\s*:\s*true/.test(raw)
    || /"isLive"\s*:\s*true/.test(raw)
    || /itemprop="isLiveBroadcast"[^>]*content="True"/i.test(raw);
  return {
    videoId,
    title,
    watchUrl: videoId ? `https://www.youtube.com/watch?v=${videoId}` : '',
    isLive: Boolean(videoId && isLive),
  };
}

/**
 * Fetch the owner channel's current public live video id.
 *
 * @param {object} [options]
 * @returns {Promise<{videoId: string, title: string, watchUrl: string, isLive: boolean, status: string}>}
 */
export async function discoverPublicChannelLive({
  channelHandle = DEFAULT_CHANNEL_HANDLE,
  fetchImpl = globalThis.fetch,
  signal,
} = {}) {
  const url = channelLiveUrl(channelHandle);
  if (!url || typeof fetchImpl !== 'function') {
    return { videoId: '', title: '', watchUrl: '', isLive: false, status: 'offline' };
  }
  const response = await fetchImpl(url, {
    method: 'GET',
    redirect: 'follow',
    signal,
    headers: {
      'User-Agent': INNERTUBE_USER_AGENT,
      Accept: 'text/html',
    },
  });
  const html = await response.text();
  const parsed = parseChannelLivePage(html);
  if (parsed.isLive) return { ...parsed, status: 'live', html };
  const configured = normalizeVideoId(process.env.YOUTUBE_BROADCAST_ID || '')
    || normalizeVideoId(String(process.env.YOUTUBE_WATCH_URL || '').match(WATCH_ID_RE)?.[1] || '');
  if (configured) {
    return {
      videoId: configured,
      title: parsed.title || 'Cloud Computer AI.com LIVE',
      watchUrl: `https://www.youtube.com/watch?v=${configured}`,
      isLive: true,
      status: 'live',
      html,
    };
  }
  if (parsed.videoId) return { ...parsed, isLive: false, status: 'offline', html };
  return { videoId: '', title: '', watchUrl: '', isLive: false, status: 'offline', html: '' };
}

/**
 * Singleton InnerTube ingest worker. Homepage /feed must only call snapshot().
 *
 * @param {object} [options]
 * @returns {{start: Function, stop: Function, snapshot: Function, getState: Function}}
 */
export function createLiveCommentIngestWorker({
  chat = createYoutubeInnerTubeChat(),
  discoverLive = discoverPublicChannelLive,
  channelHandle = process.env.YOUTUBE_CHANNEL_HANDLE || DEFAULT_CHANNEL_HANDLE,
  maxItems = DEFAULT_BUFFER_SIZE,
  now = Date.now,
  clock = globalThis,
  discoveryTtlMs = LIVE_DISCOVERY_TTL_MS,
} = {}) {
  const normalizedChannelHandle = String(channelHandle || '').trim().replace(/^@/, '');
  let stopped = true;
  let timer = null;
  let continuation = '';
  let videoId = '';
  let title = '';
  let watchUrl = '';
  let status = 'offline';
  let generation = 0;
  let error = null;
  let discoveredAt = 0;
  let updatedAt = 0;
  let ingestDelayMs = 5_000;
  const buffer = [];
  const seen = new Set();

  function remember(id) {
    seen.add(id);
    while (seen.size > maxItems * 2) seen.delete(seen.values().next().value);
  }

  function pushItems(items) {
    for (const item of items || []) {
      const id = String(item?.id || item?.commentId || '');
      if (!id || seen.has(id)) continue;
      remember(id);
      buffer.push(item);
      while (buffer.length > maxItems) buffer.shift();
    }
  }

  function clearStream() {
    if (videoId) generation += 1;
    videoId = '';
    title = '';
    watchUrl = '';
    continuation = '';
    buffer.length = 0;
    seen.clear();
  }

  function snapshot() {
    const live = status === 'live' && Boolean(videoId);
    const stamp = updatedAt || now();
    return {
      active: live,
      status,
      channelHandle: normalizedChannelHandle ? `@${normalizedChannelHandle}` : '',
      videoId: live || status === 'connecting' ? videoId : '',
      title: live || status === 'connecting' ? title : '',
      watchUrl: live || status === 'connecting' ? watchUrl : '',
      liveChatId: live ? 'innertube' : '',
      items: buffer.slice(),
      generation,
      commandsEnabled: live,
      updatedAt: stamp,
      snapshotAgeMs: Math.max(0, now() - stamp),
      ingestPollingIntervalMillis: ingestDelayMs,
      pollingIntervalMillis: live ? 800 : 5_000,
      error,
    };
  }

  async function resolveLive() {
    const stale = !videoId || (now() - discoveredAt) >= discoveryTtlMs;
    if (!stale && videoId) {
      return { videoId, title, watchUrl, isLive: true, status: 'live' };
    }
    const live = await discoverLive({ channelHandle: normalizedChannelHandle });
    discoveredAt = now();
    return live;
  }

  async function tick() {
    if (stopped) return;
    let delay = 5_000;
    try {
      const live = await resolveLive();
      if (!live?.isLive || !live.videoId) {
        status = live?.status === 'connecting' ? 'connecting' : (live?.status || 'offline');
        error = null;
        if (videoId && live?.videoId !== videoId) clearStream();
        if (!live?.isLive) clearStream();
      } else {
        if (live.videoId !== videoId) {
          clearStream();
          videoId = live.videoId;
          title = live.title || '';
          watchUrl = live.watchUrl || `https://www.youtube.com/watch?v=${live.videoId}`;
          status = 'connecting';
        }
        if (live.html && typeof chat.seedSession === 'function') {
          try { chat.seedSession(videoId, live.html, 'homepage-ingest'); }
          catch { /* poll() will bootstrap if the live HTML has no chat continuation */ }
        }
        const page = await chat.poll({
          videoId,
          continuation,
          cacheKey: 'homepage-ingest',
        });
        continuation = String(page.nextPageToken || continuation);
        pushItems(page.items || []);
        status = 'live';
        error = null;
        updatedAt = now();
        delay = Math.max(2_000, Math.min(15_000, Number(page.pollingIntervalMillis) || 5_000));
        ingestDelayMs = delay;
      }
    } catch (caught) {
      const kind = String(caught?.kind || 'upstream');
      if (kind === 'ended' || kind === 'no-chat') {
        const configured = normalizeVideoId(process.env.YOUTUBE_BROADCAST_ID || '')
          || normalizeVideoId(String(process.env.YOUTUBE_WATCH_URL || '').match(WATCH_ID_RE)?.[1] || '');
        if (configured && (configured === videoId || !videoId)) {
          videoId = videoId || configured;
          watchUrl = watchUrl || `https://www.youtube.com/watch?v=${videoId}`;
          status = 'live';
          error = { kind, message: String(caught.message || 'Live chat page not ready yet.') };
          updatedAt = now();
        } else {
          status = 'ended';
          error = { kind, message: String(caught.message || 'This live broadcast has ended.') };
          clearStream();
          discoveredAt = 0;
        }
      } else {
        status = 'unavailable';
        error = { kind, message: String(caught.message || 'YouTube live chat unavailable.') };
      }
      delay = kind === 'ended' ? 8_000 : 10_000;
    } finally {
      schedule(delay);
    }
  }

  function schedule(delayMs) {
    if (stopped) return;
    if (timer != null) clock.clearTimeout(timer);
    timer = clock.setTimeout(() => {
      timer = null;
      void Promise.resolve()
        .then(() => tick())
        .catch((err) => {
          status = 'unavailable';
          error = { kind: 'upstream', message: String(err?.message || err) };
          schedule(10_000);
        });
    }, Math.max(0, Number(delayMs) || 5_000));
  }

  return {
    inject(raw) {
      const item = raw && typeof raw === "object" ? raw : null;
      if (!item) return snapshot();
      if (!videoId) {
        videoId = String(item.videoId || "").trim();
        status = videoId ? "live" : status;
      }
      pushItems([item]);
      updatedAt = now();
      return snapshot();
    },
    start() {
      if (!stopped && timer != null) return;
      stopped = false;
      if (timer == null) {
        void Promise.resolve()
          .then(() => tick())
          .catch((err) => {
            status = 'unavailable';
            error = { kind: 'upstream', message: String(err?.message || err) };
            schedule(10_000);
          });
      }
    },
    stop() {
      stopped = true;
      if (timer != null) clock.clearTimeout(timer);
      timer = null;
    },
    snapshot,
    getState() {
      return { videoId, status, generation, buffered: buffer.length, running: !stopped };
    },
  };
}
