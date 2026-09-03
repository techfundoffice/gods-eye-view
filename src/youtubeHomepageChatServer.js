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
import { isLoopbackAddress } from './youtubeOAuth.js';

const MAX_CONTINUATION = 4096;
const VIEWER_IDENTITY_PARAMS = ['videoId', 'liveChatId', 'broadcastId', 'session', 'sessionId', 'authorization'];

function readJsonBody(req, maxBytes = 4000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error('too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(Object.assign(new Error('invalid json'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

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
  actions.push({ action: 'fly_to_location', args: { query: location, viewMode: 'overview' } });
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
  const authorHandle = boundedText(
    raw.authorHandle
    || (raw.author && typeof raw.author === 'object' ? raw.author.handle : '')
    || (String(raw.authorDetails?.displayName || '').startsWith('@') ? raw.authorDetails.displayName : ''),
    80,
  );
  const agentRequested = commandsEnabled;
  const channelId = boundedText(
    raw.channelId || raw.authorChannelId || raw.authorDetails?.channelId || normalized.author?.channelId,
    80,
  );
  const isChatOwner = raw.isChatOwner === true || raw.authorDetails?.isChatOwner === true;
  return {
    id: normalized.commentId,
    videoId: normalized.videoId,
    author: normalized.author.displayName,
    ...(authorHandle ? { authorHandle } : {}),
    ...(channelId ? { channelId } : {}),
    ...(isChatOwner ? { isChatOwner: true } : {}),
    text: normalized.text,
    publishedAt: normalized.receivedAt,
    source: 'youtube',
    ...(agentRequested ? { agentMode: 'execute', deferAgent: false } : {}),
    actions: [],
  };
}

function publicFeedBody(identity, extras = {}) {
  const status = boundedText(identity.status || 'offline', 40) || 'offline';
  const verifiedLive = identity.active === true && status === 'live' && Boolean(identity.videoId || identity.liveChatId);
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
  ingest = null,
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
    if (parsed.pathname === '/inject') {
      const loopback = isLoopbackAddress(req.socket?.remoteAddress || req.connection?.remoteAddress);
      if (!loopback) {
        sendJson(res, 403, { error: { kind: 'forbidden', message: 'Inject is loopback only.' } });
        return;
      }
      if (method !== 'POST') {
        sendJson(res, 405, { error: { kind: 'method', message: 'POST only' } });
        return;
      }
      let body = {};
      try { body = await readJsonBody(req); }
      catch (error) {
        sendJson(res, error.status || 400, { error: { kind: 'invalid', message: error.message } });
        return;
      }
      const text = boundedText(body.text, 500);
      if (!text) {
        sendJson(res, 400, { error: { kind: 'invalid', message: 'text required' } });
        return;
      }
      const snap = ingest && typeof ingest.snapshot === 'function' ? (ingest.snapshot() || {}) : {};
      const videoId = boundedText(body.videoId || snap.videoId, 80);
      const raw = {
        id: boundedText(body.id, 160) || `inject-${Date.now()}`,
        videoId,
        snippet: { displayMessage: text, publishedAt: new Date(now()).toISOString() },
        authorDetails: { displayName: boundedText(body.author, 80) || 'GEV Verify' },
        authorHandle: boundedText(body.authorHandle, 80) || '@gevverify',
        text,
        author: { displayName: boundedText(body.author, 80) || 'GEV Verify' },
      };
      if (ingest && typeof ingest.inject === 'function') ingest.inject(raw);
      let liveChatId = boundedText(body.liveChatId || snap.liveChatId, 80);
      if (liveChatId === 'innertube') liveChatId = '';
      if (!liveChatId && ownerDiscovery) {
        try {
          const identity = await ownerDiscovery.get();
          liveChatId = boundedText(identity?.liveChatId, 80);
        } catch { /* inject still runs the globe */ }
      }
      lastBinding = {
        videoId,
        generation: Math.max(0, Number(snap.generation) || 0),
        commandsEnabled: true,
        liveChatId,
      };
      const item = publicMessage(raw, videoId, now, { commandsEnabled: true });
      const registered = item ? await commandRuntime?.registerMessage?.(item, lastBinding) : { recognized: false };
      const commands = await commandRuntime?.statuses?.(lastBinding) || [];
      void Promise.resolve(commandRuntime?.deliverReplies?.(lastBinding)).catch(() => {});
      sendJson(res, 200, { ok: true, item, registered, commands: commands.slice(-5) });
      return;
    }
    if ((parsed.pathname.startsWith('/executor') || parsed.pathname.startsWith('/agent')) && executorMiddleware) {
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

    if (ingest && typeof ingest.snapshot === 'function' && typeof discoverActive !== 'function') {
      const snap = ingest.snapshot() || {};
      const live = snap.active === true && snap.status === 'live' && Boolean(snap.videoId);
      let liveChatId = boundedText(snap.liveChatId, 80);
      if (liveChatId === 'innertube') liveChatId = '';
      if (live && !liveChatId && ownerDiscovery) {
        try {
          const identity = await ownerDiscovery.get();
          liveChatId = boundedText(identity?.liveChatId, 80);
        } catch { /* comments still register */ }
      }
      lastBinding = {
        videoId: live ? boundedText(snap.videoId, 80) : '',
        generation: Math.max(0, Number(snap.generation) || 0),
        commandsEnabled: live,
        liveChatId,
      };
      const commands = await commandRuntime?.statuses?.(lastBinding) || [];
      const items = live
        ? (snap.items || []).map((item) => publicMessage(item, snap.videoId, now, { commandsEnabled: true })).filter(Boolean)
        : [];
      if (live && items.length) {
        for (const item of items) {
          void Promise.resolve(commandRuntime?.registerMessage?.(item, lastBinding)).catch(() => {});
        }
      }
      void Promise.resolve(commandRuntime?.deliverReplies?.(lastBinding)).catch(() => {});
      sendJson(res, 200, publicFeedBody(snap, {
        items,
        pollingIntervalMillis: Math.max(500, Math.min(30_000, Number(snap.pollingIntervalMillis) || (live ? 800 : 5_000))),
        ingestPollingIntervalMillis: Math.max(0, Number(snap.ingestPollingIntervalMillis) || 0),
        updatedAt: Math.max(0, Number(snap.updatedAt) || now()),
        snapshotAgeMs: Math.max(0, Number(snap.snapshotAgeMs) || 0),
        commands,
        ...(snap.error?.kind || snap.error?.message ? {
          error: {
            kind: boundedText(snap.error.kind, 40),
            message: boundedText(snap.error.message, 160),
          },
        } : {}),
      }));
      return;
    }

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
    lastBinding = { videoId: verifiedLive ? videoId : '', generation, commandsEnabled: verifiedLive, liveChatId: verifiedLive ? liveChatId : '' };

    if (!verifiedLive) {
      const commands = await commandRuntime?.statuses?.({ ...lastBinding, commandsEnabled: false }) || [];
      const extras = { commands };
      if (identity.error?.kind || identity.error?.message) {
        extras.error = {
          kind: boundedText(identity.error.kind, 40),
          message: boundedText(identity.error.message, 160),
        };
      }
      sendJson(res, 200, publicFeedBody(identity, extras));
      return;
    }

    const pageToken = boundedText(parsed.searchParams.get('continuation'), MAX_CONTINUATION);
    try {
      const result = await readChat({ liveChatId, pageToken });
      const items = (result.items || [])
        .map((item) => publicMessage(item, videoId, now, { commandsEnabled: true }))
        .filter(Boolean);
      const binding = lastBinding;
      if (items.length) {
        for (const item of items) {
          void Promise.resolve(commandRuntime?.registerMessage?.(item, binding)).catch(() => {});
        }
      }
      const commands = await commandRuntime?.statuses?.(binding) || [];
      void Promise.resolve(commandRuntime?.deliverReplies?.(binding)).catch(() => {});
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