/**
 * Youtube AI Comment Harness — normalize viewer messages, publish them to
 * NextChat, and route only leading `#Task` comments through a constrained
 * view-intent interpreter into the existing GEV action runner.
 *
 * @module youtubeCommentHarness
 */

import { validateViewIntent } from './youtubeViewAgent.js';
import { createYoutubeClient, normalizeCommentThread, normalizeLiveChatMessage } from './youtubeLive.js';
import { publishNextChatMessage, setNextchatHarnessStatus } from './voice/nextchat.js';

export const HARNESS_SCHEMA_VERSION = 1;
export const HARNESS_MAX_TEXT = 500;
export const HARNESS_MAX_AUTHOR = 80;
export const HARNESS_MAX_ID = 160;
export const HARNESS_MAX_RECENT = 40;
export const HARNESS_MAX_QUEUE = 4;
export const HARNESS_MAX_SEEN = 500;
export const HARNESS_MAX_NEXTCHAT_QUEUE = 50;
export const HARNESS_COOLDOWN_MS = 4_000;
export const HARNESS_VIEWER_COOLDOWN_MS = 8_000;
export const HARNESS_MIN_CONFIDENCE = 0.5;
export const HARNESS_POLL_MS = 10_000;
export const HARNESS_LABEL = 'Youtube AI Comment Harness';
export const HARNESS_PLUGIN_ID = 'youtube-ai-comment-harness';

const UNSAFE_ADAPTER_REASON = 'Cursor adapter cannot yet enforce a tool-less session';

/**
 * @param {unknown} value
 * @param {number} [max]
 * @returns {string}
 */
export function boundedText(value, max = HARNESS_MAX_TEXT) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

/**
 * @param {unknown} value
 * @param {() => number} [now]
 * @returns {string}
 */
export function isoTimestamp(value, now = Date.now) {
  const parsed = Date.parse(String(value || '').trim());
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  return new Date(now()).toISOString();
}

/**
 * @returns {{received: number, displayed: number, accepted: number, rejected: number, rateLimited: number, failed: number}}
 */
export function createEmptyCounters() {
  return {
    received: 0,
    displayed: 0,
    accepted: 0,
    rejected: 0,
    rateLimited: 0,
    failed: 0,
  };
}

/**
 * @param {unknown} source
 * @returns {'comment'|'liveChat'}
 */
export function normalizeSource(source) {
  return source === 'liveChat' || source === 'chat' ? 'liveChat' : 'comment';
}

/**
 * Normalize a YouTube comment or live-chat item into the schemaVersion-1 object.
 *
 * @param {object|null|undefined} item
 * @param {{source?: string, videoId?: string, now?: () => number}} [options]
 * @returns {object|null}
 */
export function normalizeIncomingMessage(item, options = {}) {
  if (!item || typeof item !== 'object') return null;
  const now = options.now || Date.now;
  const snippet = item.snippet?.topLevelComment?.snippet || item.snippet || {};
  const authorObject = item.author && typeof item.author === 'object' && !Array.isArray(item.author)
    ? item.author
    : null;
  const commentId = boundedText(
    item.commentId || item.id || item.snippet?.topLevelComment?.id,
    HARNESS_MAX_ID,
  );
  const text = boundedText(
    item.text
    || item.textDisplay
    || item.textOriginal
    || snippet.textDisplay
    || snippet.textOriginal
    || snippet.displayMessage
    || snippet.textMessageDetails?.messageText,
  );
  if (!commentId || !text) return null;
  const displayName = boundedText(
    authorObject?.displayName
    || item.authorDisplayName
    || (typeof item.author === 'string' ? item.author : '')
    || snippet.authorDisplayName
    || item.authorDetails?.displayName,
    HARNESS_MAX_AUTHOR,
  ) || 'VIEWER';
  const channelId = boundedText(
    authorObject?.channelId
    || item.channelId
    || item.authorChannelId
    || snippet.authorChannelId
    || item.authorDetails?.channelId,
    80,
  );
  const videoId = boundedText(options.videoId || item.videoId || snippet.videoId, 80);
  const author = { displayName };
  if (channelId) author.channelId = channelId;
  return {
    schemaVersion: HARNESS_SCHEMA_VERSION,
    source: normalizeSource(options.source || item.source),
    commentId,
    videoId,
    author,
    text,
    receivedAt: isoTimestamp(item.receivedAt || item.publishedAt || snippet.publishedAt, now),
  };
}

/**
 * Leading `#Task` marker, case-insensitive, with optional `:` / `-` separator.
 *
 * @param {unknown} text
 * @returns {{isTask: boolean, body: string, marker: string}}
 */
export function parseTaskMarker(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return { isTask: false, body: '', marker: '' };
  const bare = trimmed.match(/^#task$/i);
  if (bare) return { isTask: true, body: '', marker: trimmed };
  const match = trimmed.match(/^#task(?:\s*[:\-–—]\s*|\s+)([\s\S]*)$/i);
  if (!match) return { isTask: false, body: trimmed, marker: '' };
  return { isTask: true, body: String(match[1] || '').trim(), marker: '#Task' };
}

/**
 * @param {unknown} text
 * @returns {string|null}
 */
export function detectUnsafeInterpretation(text) {
  const raw = String(text ?? '');
  if (!raw) return 'Empty interpretation';
  if (/```/.test(raw)) return 'Code fences are rejected';
  if (/https?:\/\//i.test(raw) || /(?:javascript|data|file|vbscript):/i.test(raw)) return 'URLs are rejected';
  if (/<\s*script\b/i.test(raw) || /\beval\s*\(|\bnew\s+Function\b/.test(raw)) return 'JavaScript is rejected';
  if (/\b(?:rm\s+-rf|curl\s+|wget\s+|bash\s+|sh\s+-c|powershell\b)/i.test(raw)) return 'Shell commands are rejected';
  if (/\b(?:readFile|writeFile|unlinkSync|mkdirSync|fs\.|child_process|spawn\s*\()/i.test(raw)) {
    return 'File operations are rejected';
  }
  if (/\b(?:tool_calls|function_call|mcp_|activeTools|hidden.?tool)/i.test(raw)) return 'Hidden tool calls are rejected';
  return null;
}

/**
 * Deterministic no-op when interpretation cannot proceed.
 *
 * @param {string} reason
 * @param {number} [confidence]
 * @returns {{kind: 'reject', intent: null, reason: string, confidence: number}}
 */
export function rejectInterpretation(reason, confidence = 0) {
  return {
    kind: 'reject',
    intent: null,
    reason: boundedText(reason, 160) || 'Request was not applied',
    confidence: clampConfidence(confidence),
  };
}

function clampConfidence(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(1, number));
}

/**
 * Validate the constrained interpretation JSON, then the existing view-intent
 * allowlists. The browser and server both call this.
 *
 * @param {unknown} value
 * @returns {{ok: boolean, kind: 'view_request'|'reject', intent: object|null, reason: string, confidence: number}}
 */
export function validateHarnessInterpretation(value) {
  if (typeof value === 'string') {
    const unsafe = detectUnsafeInterpretation(value);
    if (unsafe) return { ok: false, ...rejectInterpretation(unsafe) };
    let parsed;
    try {
      parsed = JSON.parse(value);
    } catch {
      return { ok: false, ...rejectInterpretation('Prose-only answers are rejected') };
    }
    return validateHarnessInterpretation(parsed);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, ...rejectInterpretation('Interpretation must be JSON matching the view-request schema') };
  }
  const packed = JSON.stringify(value);
  const unsafe = detectUnsafeInterpretation(packed);
  if (unsafe) return { ok: false, ...rejectInterpretation(unsafe) };

  const kind = value.kind === 'view_request' || value.kind === 'reject' ? value.kind : '';
  if (!kind) return { ok: false, ...rejectInterpretation('kind must be view_request or reject') };

  const confidence = clampConfidence(value.confidence);
  const reason = boundedText(value.reason, 160) || (kind === 'reject' ? 'Request was not applied' : 'Viewer requested a frontend view change');

  if (kind === 'reject') {
    return { ok: false, kind: 'reject', intent: null, reason, confidence };
  }
  if (confidence < HARNESS_MIN_CONFIDENCE) {
    return { ok: false, ...rejectInterpretation('Confidence is too low', confidence) };
  }
  const checked = validateViewIntent({
    ...(value.intent && typeof value.intent === 'object' ? value.intent : {}),
    reason,
  });
  if (!checked.ok) return { ok: false, ...rejectInterpretation(checked.reason, confidence) };
  if (checked.intent.action === 'ignore') {
    return { ok: false, ...rejectInterpretation(checked.intent.reason || 'No view request detected', confidence) };
  }
  return {
    ok: true,
    kind: 'view_request',
    intent: checked.intent,
    reason: boundedText(reason || checked.intent.reason, 160),
    confidence,
  };
}

/**
 * Non-sensitive view context sent with a `#Task` body. No tokens, keys, or camera internals.
 *
 * @param {object} [context]
 * @returns {{videoId: string, videoTitle: string, source: string}}
 */
export function boundedViewSummary(context = {}) {
  return {
    videoId: boundedText(context.videoId, 80),
    videoTitle: boundedText(context.videoTitle, 120),
    source: normalizeSource(context.source),
  };
}

/**
 * @param {boolean} supportsToolIsolation
 * @param {boolean} [configured]
 * @returns {{ok: boolean, reason: string}}
 */
export function toolIsolationState(supportsToolIsolation, configured = true) {
  if (!supportsToolIsolation) {
    return {
      ok: false,
      reason: configured
        ? UNSAFE_ADAPTER_REASON
        : `Cursor view agent is not configured. ${UNSAFE_ADAPTER_REASON}`,
    };
  }
  if (!configured) {
    return { ok: false, reason: 'Cursor view agent is not configured' };
  }
  return { ok: true, reason: '' };
}

/**
 * Operator-facing harness status. Isolation failure always wins over YouTube
 * connection copy so ENABLE being disabled still has an explanation.
 *
 * @param {object} [state]
 * @returns {string}
 */
export function harnessOperatorStatus(state = {}) {
  if (state.isolationOk === false) {
    const reason = boundedText(state.isolationReason, 160);
    return reason ? `DISABLED · ${reason}` : 'DISABLED';
  }
  return boundedText(state.status, 200) || 'DISABLED';
}

/**
 * Resolve the live NextChat API mounted on the homepage overlay.
 *
 * @returns {object|null}
 */
export function resolveNextchatApi() {
  try {
    return globalThis.window?.__gevNextchat
      || globalThis.document?.getElementById?.('gev-nextchat')?.__gevNextchat
      || null;
  } catch {
    return null;
  }
}

/**
 * NextChat adapter used by the harness. Falls back to a bounded local queue.
 *
 * @param {object} [options]
 * @returns {object}
 */
export function createNextChatAdapter(options = {}) {
  const getApi = typeof options.getApi === 'function' ? options.getApi : resolveNextchatApi;
  const maxQueue = Number.isFinite(options.maxQueue) ? options.maxQueue : HARNESS_MAX_NEXTCHAT_QUEUE;
  const queue = [];

  return {
    queue,
    available() {
      const api = getApi();
      return Boolean(api?.store?.appendViewerMessage || api?.publishViewerMessage);
    },
    publish(payload) {
      const api = getApi();
      if (api?.publishViewerMessage) {
        const result = api.publishViewerMessage(payload);
        if (result?.ok !== false) return { ok: true };
      }
      const result = publishNextChatMessage(payload, api);
      if (result.ok) return result;
      queue.push({
        author: boundedText(payload?.author, HARNESS_MAX_AUTHOR),
        text: boundedText(payload?.text),
        metadata: payload?.metadata || {},
      });
      if (queue.length > maxQueue) queue.shift();
      return { ok: false, reason: 'unavailable', queued: queue.length };
    },
    setStatus(text) {
      const api = getApi();
      setNextchatHarnessStatus(boundedText(text, 200), api);
    },
  };
}

/**
 * @param {object} [options]
 * @returns {(comment: object, context: object, signal?: AbortSignal) => Promise<object>}
 */
export function createHarnessInterpretClient({ fetchImpl = globalThis.fetch } = {}) {
  return async function interpret(comment, context, signal) {
    const response = await fetchImpl('/api/youtube-comment-harness/interpret', {
      method: 'POST',
      signal,
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ comment, context: boundedViewSummary(context) }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload?.error?.message || 'Harness interpreter unavailable');
      error.kind = payload?.error?.kind || 'agent';
      error.status = response.status;
      throw error;
    }
    return payload.interpretation || payload;
  };
}

/**
 * @param {Function|null|undefined} explicit
 * @returns {Function|null}
 */
export function resolveGevActionRunner(explicit) {
  if (typeof explicit === 'function') return explicit;
  try {
    const run = globalThis.window?.__godsEyeView?.voiceCommands?.runner
      || globalThis.window?.__gevVoiceCommands?.runner;
    return typeof run === 'function' ? run : null;
  } catch {
    return null;
  }
}

function safeErrorMessage(error) {
  return boundedText(error?.message || 'failed', 120)
    .replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/ya29\.[A-Za-z0-9._-]+/g, '[redacted]');
}

function seenKey(message) {
  return `${message.videoId}:${message.source}:${message.commentId}`;
}

function viewerKey(message) {
  return `${message.videoId}:${message.author.channelId || message.author.displayName}`;
}

/**
 * Default YouTube read source. Reuses the same-origin Data API proxy and, when
 * present, the operator YouTube panel's already-loaded video list.
 *
 * @param {object} [options]
 * @returns {object}
 */
export function createYoutubeHarnessSource({ fetchImpl = globalThis.fetch } = {}) {
  const client = createYoutubeClient({ fetchImpl });

  return {
    async status() {
      try {
        const response = await fetchImpl('/api/youtube/auth/status', {
          headers: { Accept: 'application/json' },
          credentials: 'same-origin',
        });
        const payload = await response.json().catch(() => ({}));
        return {
          connected: Boolean(payload?.authenticated),
          configured: payload?.configured !== false,
          account: payload?.account ? { name: boundedText(payload.account.name || payload.account.email, 80) } : null,
        };
      } catch {
        return { connected: false, configured: false, account: null };
      }
    },
    async listVideos() {
      try {
        const panel = globalThis.window?.__godsEyeView?.youtubePanel;
        const existing = panel?.state?.videos;
        if (Array.isArray(existing) && existing.length) {
          return existing.map((video) => ({
            id: boundedText(video?.id, 80),
            title: boundedText(video?.snippet?.title || video?.id, 120),
            liveChatId: boundedText(video?.liveStreamingDetails?.activeLiveChatId, 80),
          })).filter((video) => video.id);
        }
        const channels = await client.get('channels', {
          part: 'snippet,contentDetails',
          mine: 'true',
          maxResults: 1,
        });
        const uploadsId = channels?.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
        if (!uploadsId) return [];
        const [uploadPage, livePage] = await Promise.all([
          client.get('playlistItems', {
            part: 'snippet,contentDetails',
            playlistId: uploadsId,
            maxResults: 25,
          }),
          client.get('liveBroadcasts', {
            part: 'snippet,contentDetails,status',
            mine: 'true',
            maxResults: 25,
          }).catch(() => ({ items: [] })),
        ]);
        const ids = [...new Set([
          ...(uploadPage?.items || []).map((item) => boundedText(item?.contentDetails?.videoId || item?.snippet?.resourceId?.videoId, 80)),
          ...(livePage?.items || []).map((item) => boundedText(item?.id, 80)),
        ].filter(Boolean))].slice(0, 50);
        if (!ids.length) return [];
        const details = await client.get('videos', {
          part: 'snippet,liveStreamingDetails,status',
          id: ids.join(','),
          maxResults: 50,
        });
        return (details?.items || []).map((video) => ({
          id: boundedText(video?.id, 80),
          title: boundedText(video?.snippet?.title || video?.id, 120),
          liveChatId: boundedText(video?.liveStreamingDetails?.activeLiveChatId, 80),
        })).filter((video) => video.id);
      } catch {
        return [];
      }
    },
    async fetchComments(videoId, signal) {
      const payload = await client.get('commentThreads', {
        part: 'snippet,replies',
        videoId,
        order: 'time',
        textFormat: 'plainText',
        maxResults: 25,
      }, signal);
      return (payload?.items || []).map(normalizeCommentThread);
    },
    async fetchLiveChat(liveChatId, pageToken, signal) {
      const payload = await client.get('liveChatMessages', {
        part: 'snippet,authorDetails',
        liveChatId,
        maxResults: 200,
        pageToken: pageToken || '',
      }, signal);
      return {
        items: (payload?.items || []).map(normalizeLiveChatMessage),
        nextPageToken: boundedText(payload?.nextPageToken, 160),
        pollingIntervalMillis: Number(payload?.pollingIntervalMillis) || HARNESS_POLL_MS,
      };
    },
  };
}

/**
 * Controller: ingest → NextChat display → `#Task` interpret → validate → GEV runner.
 *
 * @param {object} [options]
 * @returns {object}
 */
export function createYoutubeCommentHarness(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const clock = {
    setTimeout: options.clock?.setTimeout || globalThis.setTimeout.bind(globalThis),
    clearTimeout: options.clock?.clearTimeout || globalThis.clearTimeout.bind(globalThis),
  };
  const nextChat = options.nextChat || createNextChatAdapter({ getApi: options.getNextchatApi });
  const youtubeSource = options.youtubeSource || null;
  const interpret = typeof options.interpret === 'function'
    ? options.interpret
    : createHarnessInterpretClient({ fetchImpl: options.fetchImpl });
  const pollMs = Math.max(5_000, Number(options.pollMs) || HARNESS_POLL_MS);
  const listeners = new Set();

  let generation = 0;
  let enabled = false;
  let configured = options.configured !== false;
  let supportsIsolation = options.supportsToolIsolation === true;
  let isolation = toolIsolationState(supportsIsolation, configured);
  let videoId = boundedText(options.videoId, 80);
  let videoTitle = boundedText(options.videoTitle, 120);
  let liveChatId = boundedText(options.liveChatId, 80);
  let videos = Array.isArray(options.videos) ? options.videos.slice() : [];
  let source = normalizeSource(options.source);
  let connection = options.connection || 'disconnected';
  let status = isolation.ok ? 'DISABLED' : `DISABLED · ${isolation.reason}`;
  let pollTimer = null;
  let pollAbort = null;
  let interpretAbort = null;
  let chatPageToken = '';
  let drainChain = Promise.resolve();
  const seen = new Set();
  const viewerLastTaskAt = new Map();
  let lastTaskAt = 0;
  const taskQueue = [];
  const recentMessages = [];
  const recentTasks = [];
  const counters = createEmptyCounters();

  function emit() {
    const snapshot = getSnapshot();
    for (const listener of listeners) {
      try { listener(snapshot); } catch { /* plugin paint must not throw into ingest */ }
    }
  }

  function setStatus(next, { nextChat: mirror = true } = {}) {
    status = isolation.ok
      ? (boundedText(next, 200) || status)
      : `DISABLED · ${isolation.reason}`;
    if (mirror) nextChat.setStatus?.(status);
    emit();
  }

  function bumpGeneration(reason) {
    generation += 1;
    interpretAbort?.abort();
    interpretAbort = null;
    pollAbort?.abort();
    pollAbort = null;
    taskQueue.length = 0;
    if (reason) setStatus(reason);
    else emit();
    return generation;
  }

  function remember(message) {
    recentMessages.unshift({
      author: message.author.displayName,
      text: message.text,
      source: message.source,
      commentId: message.commentId,
      videoId: message.videoId,
      receivedAt: message.receivedAt,
    });
    if (recentMessages.length > HARNESS_MAX_RECENT) recentMessages.pop();
  }

  function rememberTask(entry) {
    recentTasks.unshift({
      author: boundedText(entry.author, HARNESS_MAX_AUTHOR),
      text: boundedText(entry.text),
      commentId: boundedText(entry.commentId, HARNESS_MAX_ID),
      videoId: boundedText(entry.videoId, 80),
      decision: boundedText(entry.decision, 40),
      reason: boundedText(entry.reason, 160),
      action: boundedText(entry.action, 40),
      result: boundedText(entry.result, 160),
      at: isoTimestamp(entry.at, now),
    });
    if (recentTasks.length > HARNESS_MAX_RECENT) recentTasks.pop();
  }

  function trimSeen() {
    while (seen.size > HARNESS_MAX_SEEN) {
      seen.delete(seen.values().next().value);
    }
  }

  function getSnapshot() {
    return {
      enabled,
      configured,
      isolationOk: isolation.ok,
      isolationReason: isolation.reason,
      videoId,
      videoTitle,
      liveChatId,
      videos: videos.map((video) => ({
        id: boundedText(video.id, 80),
        title: boundedText(video.title, 120),
        liveChatId: boundedText(video.liveChatId, 80),
      })),
      source,
      connection,
      status: harnessOperatorStatus({
        isolationOk: isolation.ok,
        isolationReason: isolation.reason,
        status,
      }),
      generation,
      nextChat: {
        available: nextChat.available?.() !== false,
        queued: Array.isArray(nextChat.queue) ? nextChat.queue.length : 0,
      },
      counters: { ...counters },
      recentMessages: recentMessages.slice(),
      recentTasks: recentTasks.slice(),
    };
  }

  async function handleTask(job, jobGeneration) {
    if (!enabled || jobGeneration !== generation) return;
    if (!isolation.ok) {
      counters.rejected += 1;
      rememberTask({
        ...job,
        author: job.message.author.displayName,
        text: job.message.text,
        commentId: job.message.commentId,
        videoId: job.message.videoId,
        decision: 'rejected',
        reason: isolation.reason,
        result: 'not applied',
        at: now(),
      });
      setStatus(`DISABLED · ${isolation.reason}`);
      return;
    }
    const runner = resolveGevActionRunner(options.runner);
    const elapsed = now() - lastTaskAt;
    const viewerElapsed = now() - (viewerLastTaskAt.get(viewerKey(job.message)) || 0);
    if (lastTaskAt && elapsed < HARNESS_COOLDOWN_MS) {
      counters.rateLimited += 1;
      rememberTask({
        author: job.message.author.displayName,
        text: job.message.text,
        commentId: job.message.commentId,
        videoId: job.message.videoId,
        decision: 'rate-limited',
        reason: 'Cooldown',
        result: 'not applied',
        at: now(),
      });
      setStatus('RATE LIMITED · request was not applied');
      return;
    }
    if (viewerElapsed < HARNESS_VIEWER_COOLDOWN_MS && viewerLastTaskAt.has(viewerKey(job.message))) {
      counters.rateLimited += 1;
      rememberTask({
        author: job.message.author.displayName,
        text: job.message.text,
        commentId: job.message.commentId,
        videoId: job.message.videoId,
        decision: 'rate-limited',
        reason: 'Per-viewer cooldown',
        result: 'not applied',
        at: now(),
      });
      setStatus('RATE LIMITED · request was not applied');
      return;
    }

    lastTaskAt = now();
    viewerLastTaskAt.set(viewerKey(job.message), now());
    interpretAbort?.abort();
    interpretAbort = new AbortController();
    const signal = interpretAbort.signal;
    setStatus(`INTERPRETING · ${job.message.author.displayName}`);
    let interpretation;
    try {
      interpretation = await interpret({
        ...job.message,
        taskBody: job.body,
      }, boundedViewSummary({
        videoId: job.message.videoId || videoId,
        videoTitle,
        source: job.message.source,
      }), signal);
    } catch (error) {
      if (error?.name === 'AbortError' || jobGeneration !== generation || !enabled) return;
      counters.failed += 1;
      rememberTask({
        author: job.message.author.displayName,
        text: job.message.text,
        commentId: job.message.commentId,
        videoId: job.message.videoId,
        decision: 'failed',
        reason: safeErrorMessage(error),
        result: 'not applied',
        at: now(),
      });
      setStatus(`FAILED · ${safeErrorMessage(error)} · request was not applied`);
      return;
    }
    if (!enabled || jobGeneration !== generation) return;

    const checked = validateHarnessInterpretation(interpretation);
    if (!checked.ok) {
      counters.rejected += 1;
      rememberTask({
        author: job.message.author.displayName,
        text: job.message.text,
        commentId: job.message.commentId,
        videoId: job.message.videoId,
        decision: 'rejected',
        reason: checked.reason,
        result: 'not applied',
        at: now(),
      });
      setStatus(`REJECTED · ${checked.reason}`);
      return;
    }

    if (typeof runner !== 'function') {
      counters.failed += 1;
      rememberTask({
        author: job.message.author.displayName,
        text: job.message.text,
        commentId: job.message.commentId,
        videoId: job.message.videoId,
        decision: 'failed',
        action: checked.intent.action,
        reason: 'GEV action runner is unavailable',
        result: 'not applied',
        at: now(),
      });
      setStatus('FAILED · GEV action runner is unavailable · request was not applied');
      return;
    }

    setStatus(`APPLYING · ${checked.intent.action}`);
    let result;
    try {
      result = await runner(checked.intent.action, checked.intent.args, {
        signal,
        isCurrent: () => enabled && jobGeneration === generation,
      });
    } catch (error) {
      if (error?.name === 'AbortError' || jobGeneration !== generation || !enabled) return;
      counters.failed += 1;
      rememberTask({
        author: job.message.author.displayName,
        text: job.message.text,
        commentId: job.message.commentId,
        videoId: job.message.videoId,
        decision: 'failed',
        action: checked.intent.action,
        reason: safeErrorMessage(error),
        result: 'not applied',
        at: now(),
      });
      setStatus(`FAILED · ${safeErrorMessage(error)} · request was not applied`);
      return;
    }
    if (!enabled || jobGeneration !== generation) return;
    if (result?.ok === false) {
      counters.rejected += 1;
      rememberTask({
        author: job.message.author.displayName,
        text: job.message.text,
        commentId: job.message.commentId,
        videoId: job.message.videoId,
        decision: 'rejected',
        action: checked.intent.action,
        reason: safeErrorMessage({ message: result.error || result.reason || 'Action refused' }),
        result: 'not applied',
        at: now(),
      });
      setStatus(`REJECTED · ${safeErrorMessage({ message: result.error || result.reason || 'Action refused' })}`);
      return;
    }
    counters.accepted += 1;
    rememberTask({
      author: job.message.author.displayName,
      text: job.message.text,
      commentId: job.message.commentId,
      videoId: job.message.videoId,
      decision: 'accepted',
      action: checked.intent.action,
      reason: checked.reason,
      result: boundedText(result?.label || result?.action || 'applied', 160),
      at: now(),
    });
    setStatus(`APPLIED · ${checked.reason}`);
  }

  function drain() {
    drainChain = drainChain.catch(() => {}).then(async () => {
      let processed = 0;
      while (taskQueue.length && enabled) {
        const job = taskQueue.shift();
        if (!job) break;
        const jobGeneration = generation;
        await handleTask(job, jobGeneration);
        processed += 1;
        if (processed > 50) break;
      }
    });
    return drainChain;
  }

  /**
   * @param {object[]} items
   * @param {{source?: string, videoId?: string}} [meta]
   * @returns {Promise<object>}
   */
  async function ingest(items, meta = {}) {
    const inboundSource = normalizeSource(meta.source || source);
    const inboundVideoId = boundedText(meta.videoId || videoId, 80);
    for (const raw of items || []) {
      counters.received += 1;
      const message = normalizeIncomingMessage(raw, {
        source: inboundSource,
        videoId: inboundVideoId,
        now,
      });
      if (!message) continue;
      const key = seenKey(message);
      if (seen.has(key)) continue;
      seen.add(key);
      trimSeen();

      const published = nextChat.publish({
        role: 'viewer',
        author: message.author.displayName,
        text: message.text,
        metadata: {
          source: message.source,
          commentId: message.commentId,
          videoId: message.videoId,
          receivedAt: message.receivedAt,
        },
      });
      if (published.ok) counters.displayed += 1;
      else setStatus('NEXTCHAT UNAVAILABLE · queued', { nextChat: true });
      remember(message);

      const parsed = parseTaskMarker(message.text);
      if (!parsed.isTask) continue;
      if (!parsed.body) {
        counters.rejected += 1;
        rememberTask({
          author: message.author.displayName,
          text: message.text,
          commentId: message.commentId,
          videoId: message.videoId,
          decision: 'rejected',
          reason: 'Empty #Task body',
          result: 'not applied',
          at: now(),
        });
        continue;
      }
      if (!enabled) {
        counters.rejected += 1;
        rememberTask({
          author: message.author.displayName,
          text: message.text,
          commentId: message.commentId,
          videoId: message.videoId,
          decision: 'rejected',
          reason: 'Harness is disabled',
          result: 'not applied',
          at: now(),
        });
        continue;
      }
      if (!isolation.ok) {
        counters.rejected += 1;
        rememberTask({
          author: message.author.displayName,
          text: message.text,
          commentId: message.commentId,
          videoId: message.videoId,
          decision: 'rejected',
          reason: isolation.reason,
          result: 'not applied',
          at: now(),
        });
        setStatus(`DISABLED · ${isolation.reason}`);
        continue;
      }
      if (taskQueue.length >= HARNESS_MAX_QUEUE) {
        counters.rateLimited += 1;
        rememberTask({
          author: message.author.displayName,
          text: message.text,
          commentId: message.commentId,
          videoId: message.videoId,
          decision: 'rate-limited',
          reason: 'Queue is full',
          result: 'not applied',
          at: now(),
        });
        setStatus('RATE LIMITED · queue is full · request was not applied');
        continue;
      }
      taskQueue.push({ message, body: parsed.body });
    }
    emit();
    await drain();
    return getSnapshot();
  }

  function stopPolling() {
    if (pollTimer != null) {
      clock.clearTimeout(pollTimer);
      pollTimer = null;
    }
    pollAbort?.abort();
    pollAbort = null;
  }

  async function pollOnce() {
    if (!enabled || !youtubeSource) return;
    const jobGeneration = generation;
    pollAbort?.abort();
    pollAbort = new AbortController();
    const signal = pollAbort.signal;
    try {
      if (typeof youtubeSource.status === 'function') {
        const auth = await youtubeSource.status();
        if (jobGeneration !== generation || !enabled) return;
        connection = auth?.connected ? 'connected' : (auth?.configured === false ? 'unavailable' : 'disconnected');
        if (connection !== 'connected') {
          setStatus(connection === 'unavailable' ? 'YOUTUBE UNAVAILABLE' : 'YOUTUBE DISCONNECTED');
          return;
        }
      }
      if (source === 'liveChat') {
        if (!liveChatId) {
          setStatus('NO ACTIVE LIVE CHAT');
          return;
        }
        const payload = await youtubeSource.fetchLiveChat(liveChatId, chatPageToken, signal);
        if (jobGeneration !== generation || !enabled) return;
        chatPageToken = payload?.nextPageToken || chatPageToken;
        await ingest(payload?.items || [], { source: 'liveChat', videoId });
      } else {
        if (!videoId) {
          setStatus('SELECT A VIDEO');
          return;
        }
        const items = await youtubeSource.fetchComments(videoId, signal);
        if (jobGeneration !== generation || !enabled) return;
        await ingest(items || [], { source: 'comment', videoId });
      }
    } catch (error) {
      if (error?.name === 'AbortError' || jobGeneration !== generation || !enabled) return;
      connection = 'disconnected';
      setStatus(safeErrorMessage(error));
    }
  }

  function schedulePoll() {
    stopPolling();
    if (!enabled || !youtubeSource) return;
    const jobGeneration = generation;
    const tick = async () => {
      if (!enabled || jobGeneration !== generation) return;
      await pollOnce();
      if (!enabled || jobGeneration !== generation) return;
      pollTimer = clock.setTimeout(tick, pollMs);
    };
    pollTimer = clock.setTimeout(tick, 0);
  }

  function setEnabled(next) {
    const want = Boolean(next);
    if (want && !isolation.ok) {
      enabled = false;
      setStatus(`DISABLED · ${isolation.reason}`);
      return getSnapshot();
    }
    if (want === enabled) return getSnapshot();
    enabled = want;
    if (!enabled) {
      stopPolling();
      bumpGeneration('DISABLED · pending work cancelled');
    } else {
      bumpGeneration();
      setStatus('HARNESS READY');
      schedulePoll();
    }
    return getSnapshot();
  }

  function setSource(next) {
    const normalized = normalizeSource(next);
    if (normalized === source) return getSnapshot();
    source = normalized;
    chatPageToken = '';
    bumpGeneration(enabled ? `SOURCE · ${source}` : status);
    if (enabled) schedulePoll();
    return getSnapshot();
  }

  function setVideo(video) {
    const nextId = boundedText(typeof video === 'string' ? video : video?.id, 80);
    const nextTitle = boundedText(typeof video === 'string' ? videoTitle : (video?.title || video?.snippet?.title), 120);
    const nextLive = boundedText(typeof video === 'string' ? liveChatId : video?.liveChatId, 80);
    if (nextId === videoId && nextTitle === videoTitle && nextLive === liveChatId) return getSnapshot();
    videoId = nextId;
    videoTitle = nextTitle;
    liveChatId = nextLive;
    seen.clear();
    viewerLastTaskAt.clear();
    lastTaskAt = 0;
    chatPageToken = '';
    bumpGeneration(enabled ? `VIDEO · ${videoTitle || videoId || 'none'}` : status);
    if (enabled) schedulePoll();
    return getSnapshot();
  }

  function setVideos(list) {
    videos = Array.isArray(list) ? list.map((video) => ({
      id: boundedText(video?.id, 80),
      title: boundedText(video?.title || video?.snippet?.title, 120),
      liveChatId: boundedText(video?.liveChatId || video?.liveStreamingDetails?.activeLiveChatId, 80),
    })).filter((video) => video.id) : [];
    emit();
    return getSnapshot();
  }

  function setConnection(next) {
    connection = boundedText(next, 40) || connection;
    emit();
    return getSnapshot();
  }

  function setToolIsolation(supports, reason = '') {
    const previous = isolation.ok;
    supportsIsolation = Boolean(supports);
    isolation = toolIsolationState(supportsIsolation, configured);
    if (reason && !isolation.ok) isolation = { ok: false, reason: boundedText(reason, 160) };
    if (!isolation.ok && enabled) {
      enabled = false;
      stopPolling();
      bumpGeneration(`DISABLED · ${isolation.reason}`);
    } else if (previous !== isolation.ok && !enabled) {
      setStatus(isolation.ok ? 'DISABLED' : `DISABLED · ${isolation.reason}`);
    } else {
      emit();
    }
    return getSnapshot();
  }

  function setConfigured(next) {
    configured = Boolean(next);
    return setToolIsolation(supportsIsolation);
  }

  function stop(reason = 'STOPPED · pending work cancelled') {
    enabled = false;
    stopPolling();
    bumpGeneration(reason);
    return getSnapshot();
  }

  function destroy() {
    stop('DESTROYED · pending work cancelled');
    listeners.clear();
    seen.clear();
    viewerLastTaskAt.clear();
    recentMessages.length = 0;
    recentTasks.length = 0;
    if (Array.isArray(nextChat.queue)) nextChat.queue.length = 0;
    return getSnapshot();
  }

  async function refreshYoutube() {
    if (!youtubeSource) {
      connection = connection || 'disconnected';
      emit();
      return getSnapshot();
    }
    try {
      const auth = await youtubeSource.status?.();
      connection = auth?.connected ? 'connected' : (auth?.configured === false ? 'unavailable' : 'disconnected');
      if (connection === 'connected' && typeof youtubeSource.listVideos === 'function') {
        const list = await youtubeSource.listVideos();
        setVideos(list);
        if (!videoId && videos[0]) setVideo(videos[0]);
      }
      if (connection !== 'connected' && !enabled && isolation.ok) {
        setStatus(connection === 'unavailable' ? 'YOUTUBE UNAVAILABLE' : 'YOUTUBE DISCONNECTED');
      } else {
        emit();
      }
    } catch {
      connection = 'disconnected';
      if (isolation.ok) setStatus('YOUTUBE DISCONNECTED');
      else emit();
    }
    return getSnapshot();
  }

  return {
    ingest,
    setEnabled,
    setSource,
    setVideo,
    setVideos,
    setConnection,
    setToolIsolation,
    setConfigured,
    stop,
    destroy,
    refreshYoutube,
    getSnapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
