/**
 * Public, read-only live-chat feed for the broadcast currently owned by the
 * shared live session. The client cannot choose an arbitrary video id.
 */
import { createYoutubeInnerTubeChat } from './youtubeInnerTubeChat.js';
import {
  boundedText,
  detectUnsafeInterpretation,
  normalizeIncomingMessage,
} from './youtubeCommentHarness.js';
import { validateViewIntent } from './youtubeViewAgent.js';

const ACTIVE_STATUSES = new Set([
  'starting',
  'encoding',
  'ingesting',
  'waiting-for-youtube',
  'live',
]);
const MAX_CONTINUATION = 4096;

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.end(body);
}

function cleanLocationQuery(value) {
  return boundedText(value, 160)
    .replace(/[.?!]+$/g, '')
    .replace(/^(?:the\s+)?(?:earthquake|earthquakes|fire|fires|weather|storm|storms|flight|flights|ship|ships)\s+(?:in|near|at|around)\s+/i, '')
    .replace(/^(?:location|city|place)\s+/i, '')
    .trim();
}

/**
 * Deterministic safety-first interpretation used when no external model is
 * configured. It intentionally recognizes only explicit globe-view requests.
 */
export function inferHomepageViewerActions(text) {
  const raw = boundedText(text, 500);
  if (!raw) return [];
  if (detectUnsafeInterpretation(raw)) return [];
  const lower = raw.toLowerCase();
  const wantsView = /\b(?:show|see|view|look at|take me to|go to|fly to|zoom to|focus on|find|locate|display)\b/i.test(raw)
    || /\bi want to see\b/i.test(raw);
  if (!wantsView) return [];

  if (/\b(?:whole|full|entire)\s+(?:earth|globe|world)\b/i.test(raw)
    || /\bzoom\s+out\s+to\s+(?:the\s+)?(?:earth|globe|world)\b/i.test(raw)) {
    return [{ action: 'zoom_to_globe', args: {} }];
  }

  let location = '';
  const nearMatch = raw.match(/\b(?:in|near|at|around)\s+([^#\n]{2,160})$/i);
  if (nearMatch) location = cleanLocationQuery(nearMatch[1]);
  if (!location) {
    const commandMatch = raw.match(/\b(?:take me to|go to|fly to|zoom to|focus on|look at|show|see|view|find|locate|display)\s+(?:me\s+)?(.{2,160})$/i);
    if (commandMatch) location = cleanLocationQuery(commandMatch[1]);
  }
  if (!location || /^(?:it|this|that|there|something|anything)$/i.test(location)) return [];

  const actions = [];
  if (/\bearthquakes?\b/.test(lower)) {
    actions.push({ action: 'set_layer_visibility', args: { layerId: 'earthquakes', enabled: true } });
  }
  actions.push({ action: 'fly_to_location', args: { query: location, viewMode: 'close' } });
  return actions
    .map((intent) => validateViewIntent(intent))
    .filter((checked) => checked.ok && checked.intent?.action !== 'ignore')
    .map((checked) => checked.intent);
}

function publicMessage(raw, videoId, now) {
  const normalized = normalizeIncomingMessage(raw, {
    source: 'innerTube',
    videoId,
    now,
  });
  if (!normalized) return null;
  return {
    id: normalized.commentId,
    videoId: normalized.videoId,
    author: normalized.author.displayName,
    text: normalized.text,
    publishedAt: normalized.receivedAt,
    source: 'youtube',
    actions: inferHomepageViewerActions(normalized.text),
  };
}

export function createYoutubeHomepageChatMiddleware({
  sessionStatus = () => null,
  chat = createYoutubeInnerTubeChat(),
  now = Date.now,
} = {}) {
  return async function youtubeHomepageChatMiddleware(req, res) {
    const method = String(req.method || 'GET').toUpperCase();
    const parsed = new URL(String(req.url || '/'), 'http://internal');
    if ((method !== 'GET' && method !== 'HEAD') || !['/', '/feed'].includes(parsed.pathname)) {
      sendJson(res, method === 'GET' || method === 'HEAD' ? 404 : 405, {
        error: { kind: 'not-found', message: 'Homepage YouTube chat route not found.' },
      });
      return;
    }

    const session = sessionStatus() || {};
    const live = session.live && typeof session.live === 'object' ? session.live : session;
    const broadcast = live.broadcast || session.broadcast || {};
    const videoId = boundedText(broadcast.id || broadcast.videoId, 80);
    const status = boundedText(live.status || session.status, 40).toLowerCase();
    if (!videoId || !ACTIVE_STATUSES.has(status)) {
      sendJson(res, 200, {
        active: false,
        status: status || 'offline',
        videoId: '',
        watchUrl: '',
        items: [],
        nextPageToken: '',
        pollingIntervalMillis: 5_000,
      });
      return;
    }

    try {
      const result = await chat.poll({
        videoId,
        continuation: boundedText(parsed.searchParams.get('continuation'), MAX_CONTINUATION),
        cacheKey: `homepage-live:${videoId}`,
      });
      const items = (result.items || [])
        .map((item) => publicMessage(item, videoId, now))
        .filter(Boolean);
      sendJson(res, 200, {
        active: true,
        status,
        videoId,
        title: boundedText(broadcast.title || 'YouTube Live', 120),
        watchUrl: boundedText(broadcast.watchUrl, 240),
        items,
        nextPageToken: boundedText(result.nextPageToken, MAX_CONTINUATION),
        pollingIntervalMillis: Math.max(5_000, Math.min(30_000, Number(result.pollingIntervalMillis) || 5_000)),
      });
    } catch (error) {
      sendJson(res, error?.status || 502, {
        active: true,
        status,
        videoId,
        items: [],
        nextPageToken: '',
        pollingIntervalMillis: 10_000,
        error: {
          kind: boundedText(error?.kind || 'upstream', 40),
          message: error?.kind
            ? boundedText(error.message, 160)
            : 'Unable to read the active YouTube live chat.',
        },
      });
    }
  };
}