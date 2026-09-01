/**
 * Public, read-only live-chat feed for the channel owner's current YouTube
 * broadcast. Identity comes from liveBroadcasts.list (active, mine) →
 * snippet.liveChatId. Viewers cannot choose a video, chat, or OAuth session.
 */
import {
  createOwnerLiveDiscovery,
  isStaleLiveChatError,
  listYoutubeLiveChatMessages,
} from './youtubeBroadcast.js';
import {
  boundedText,
  detectUnsafeInterpretation,
  normalizeIncomingMessage,
} from './youtubeCommentHarness.js';
import { validateViewIntent } from './youtubeViewAgent.js';
import { parsePublicCommand } from './youtubePublicCommandPolicy.js';

const MAX_CONTINUATION = 4096;
const VIEWER_IDENTITY_PARAMS = ['videoId', 'liveChatId', 'broadcastId', 'session', 'sessionId', 'authorization'];

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

function publicMessage(raw, videoId, now, { commandsEnabled = false } = {}) {
  const normalized = normalizeIncomingMessage(raw, {
    source: 'liveChat',
    videoId,
    now,
  });
  if (!normalized) return null;
  const slash = parsePublicCommand(normalized.text);
  return {
    id: normalized.commentId,
    videoId: normalized.videoId,
    author: normalized.author.displayName,
    text: normalized.text,
    publishedAt: normalized.receivedAt,
    source: 'youtube',
    actions: commandsEnabled && !slash.recognized ? inferHomepageViewerActions(normalized.text) : [],
  };
}

function publicFeedBody(identity, extras = {}) {
  const status = boundedText(identity.status || 'offline', 40) || 'offline';
  const verifiedLive = identity.active === true && status === 'live' && Boolean(identity.liveChatId);
  return {
    active: verifiedLive,
    status: verifiedLive ? 'live' : status,
    videoId: verifiedLive || status === 'connecting' ? boundedText(identity.videoId, 80) : '',
    title: verifiedLive || status === 'connecting' ? boundedText(identity.title, 120) : '',
    watchUrl: verifiedLive || status === 'connecting' ? boundedText(identity.watchUrl, 240) : '',
    items: [],
    nextPageToken: '',
    pollingIntervalMillis: 5_000,
    generation: Math.max(0, Number(identity.generation) || 0),
    commandsEnabled: verifiedLive,
    commands: [],
    ...extras,
  };
}

/**
 * Public homepage chat middleware.
 *
 * @param {object} [options]
 * @param {() => Promise<object>} [options.discoverActive]
 * @param {(opts: {liveChatId: string, pageToken: string}) => Promise<object>} [options.listChat]
 * @param {{get: Function, invalidate: Function}} [options.discovery]
 * @param {() => Promise<Function|{call: Function, ownerKey?: string}|null>} [options.getOwnerCall]
 * @param {Function} [options.now]
 * @param {object|null} [options.commandRuntime]
 */
export function createYoutubeHomepageChatMiddleware({
  discoverActive = null,
  listChat = null,
  discovery = null,
  getOwnerCall = null,
  now = Date.now,
  commandRuntime = null,
} = {}) {
  const ownerDiscovery = discovery || (typeof getOwnerCall === 'function'
    ? createOwnerLiveDiscovery({ getCall: getOwnerCall })
    : null);
  let lastBinding = { videoId: '', generation: 0, commandsEnabled: false };
  let lastCall = null;

  async function resolveIdentity() {
    if (typeof discoverActive === 'function') return discoverActive() || {};
    if (ownerDiscovery) return ownerDiscovery.get();
    return { active: false, status: 'offline' };
  }

  async function resolveCall() {
    if (lastCall) return lastCall;
    if (typeof getOwnerCall !== 'function') return null;
    const resolved = await getOwnerCall();
    if (resolved && typeof resolved === 'object' && typeof resolved.call === 'function') return resolved.call;
    return typeof resolved === 'function' ? resolved : null;
  }

  async function readChat({ liveChatId, pageToken }) {
    if (typeof listChat === 'function') return listChat({ liveChatId, pageToken });
    const call = await resolveCall();
    return listYoutubeLiveChatMessages(call, { liveChatId, pageToken });
  }

  function invalidate() {
    ownerDiscovery?.invalidate?.();
    lastCall = null;
  }

  const executorMiddleware = commandRuntime?.middleware?.({
    getBinding: () => lastBinding,
  });

  return async function youtubeHomepageChatMiddleware(req, res) {
    const method = String(req.method || 'GET').toUpperCase();
    const parsed = new URL(String(req.url || '/'), 'http://internal');
    if (parsed.pathname.startsWith('/executor') && executorMiddleware) {
      await executorMiddleware(req, res);
      return;
    }
    if ((method !== 'GET' && method !== 'HEAD') || !['/', '/feed'].includes(parsed.pathname)) {
      sendJson(res, method === 'GET' || method === 'HEAD' ? 404 : 405, {
        error: { kind: 'not-found', message: 'Homepage YouTube chat route not found.' },
      });
      return;
    }

    for (const name of VIEWER_IDENTITY_PARAMS) parsed.searchParams.delete(name);

    let identity = {};
    try {
      identity = await resolveIdentity();
    } catch (error) {
      if (error?.kind === 'authentication' || error?.status === 401) {
        identity = { active: false, status: 'unauthenticated' };
      } else {
        sendJson(res, 200, publicFeedBody({ active: false, status: 'unavailable' }, {
          error: {
            kind: boundedText(error?.kind || 'upstream', 40),
            message: boundedText(error?.message || 'Unable to discover the current YouTube broadcast.', 160),
          },
        }));
        return;
      }
    }

    const status = boundedText(identity.status || 'offline', 40) || 'offline';
    const videoId = boundedText(identity.videoId, 80);
    const liveChatId = boundedText(identity.liveChatId, 80);
    const generation = Math.max(0, Number(identity.generation) || 0);
    const verifiedLive = identity.active === true && status === 'live' && Boolean(liveChatId);
    lastBinding = { videoId: verifiedLive ? videoId : '', generation, commandsEnabled: verifiedLive };

    if (!verifiedLive) {
      const commands = await commandRuntime?.statuses?.({ ...lastBinding, commandsEnabled: false }) || [];
      sendJson(res, 200, publicFeedBody(identity, { commands }));
      return;
    }

    const pageToken = boundedText(parsed.searchParams.get('continuation'), MAX_CONTINUATION);
    try {
      const result = await readChat({ liveChatId, pageToken });
      const items = (result.items || [])
        .map((item) => publicMessage(item, videoId, now, { commandsEnabled: true }))
        .filter(Boolean);
      const binding = lastBinding;
      for (const item of items) {
        void Promise.resolve(commandRuntime?.registerMessage?.(item, binding)).catch(() => {});
      }
      const commands = await commandRuntime?.statuses?.(binding) || [];
      sendJson(res, 200, publicFeedBody(identity, {
        items,
        nextPageToken: boundedText(result.nextPageToken, MAX_CONTINUATION),
        pollingIntervalMillis: Math.max(5_000, Math.min(30_000, Number(result.pollingIntervalMillis) || 5_000)),
        commands,
      }));
    } catch (error) {
      if (isStaleLiveChatError(error)) invalidate();
      const kind = isStaleLiveChatError(error)
        ? boundedText(error?.kind === 'ended' ? 'ended' : (error?.kind || 'unavailable'), 40)
        : boundedText(error?.kind || 'upstream', 40);
      const failedStatus = kind === 'ended' ? 'ended' : kind === 'authentication' ? 'unauthenticated' : 'unavailable';
      lastBinding = { videoId: '', generation, commandsEnabled: false };
      const commands = await commandRuntime?.statuses?.(lastBinding) || [];
      sendJson(res, 200, publicFeedBody({
        active: false,
        status: failedStatus,
        generation,
      }, {
        error: {
          kind,
          message: boundedText(
            error?.message || 'Unable to read the active YouTube live chat.',
            160,
          ),
        },
        pollingIntervalMillis: 10_000,
        commands,
      }));
    }
  };
}