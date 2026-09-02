/**
 * NextChat-shaped homepage chat overlay.
 *
 * Session/thread reducers and the send helper are DOM-free so node:test can
 * drive them. The live send path is `voice.sendTextCommand` on the shipped
 * GevRealtimeController — not a mock transcript and not a parallel chat API.
 */

export const NEXTCHAT_STORAGE_KEY = 'godsEyeView.nextchat.sessions.v1';
export const NEXTCHAT_MAX_MESSAGES = 100;
/** Cap for waiting on the Realtime data channel after start() returns at SDP. */
export const VOICE_CHANNEL_WAIT_MS = 20000;
export const NEXTCHAT_MAX_LIVE_COMMENTS = 7;
export const NEXTCHAT_MAX_ACTIONS = 3;
export const NEXTCHAT_MAX_PAIRED_ROWS = 3;
export const NEXTCHAT_COMMENT_FULL_OPACITY_MS = 12000;
export const INTERPRETING_REPLY_TEXT = 'Interpreting request…';
/** HUD-matching typewriter for GEV ACTIONS replies. */
export const ACTION_REPLY_TYPE_STEP = 2;
export const ACTION_REPLY_TYPE_MS = 24;

const PUBLIC_ACTION_STATES = new Set([
  'pending',
  'received',
  'interpreting',
  'awaiting-execution',
  'executing',
  'awaiting-model',
  'succeeded',
  'validated',
  'rejected',
  'failed',
  'cancelled',
]);

const actionReplyTimers = new WeakMap();

/** Viewer YouTube comments shown in LIVE COMMENTS, not command-status dumps. */
export function isLiveCommentMessage(message) {
  return message?.role === 'viewer' && String(message.metadata?.source || '') !== 'youtube-command';
}

/**
 * Newest Live Comments first. Ingest stays chronological (append);
 * display reverses the last `limit` live-comment rows.
 *
 * @param {object[]} messages
 * @param {{limit?: number}} [options]
 * @returns {object[]}
 */
export function orderLiveCommentMessages(messages, { limit = NEXTCHAT_MAX_LIVE_COMMENTS } = {}) {
  const list = Array.isArray(messages) ? messages.filter(isLiveCommentMessage) : [];
  const cap = Number.isFinite(limit) ? Math.max(0, limit) : list.length;
  return list.slice(-cap).reverse();
}

/** GEV ACTIONS · VIEW REQUESTS lane. */
export function isActionLaneMessage(message) {
  return PUBLIC_ACTION_STATES.has(String(message.metadata?.actionState || '').toLowerCase());
}

const PAIRED_REPLY_STATES = new Set([
  'pending',
  'interpreting',
  'replied',
  'rejected',
  'failed',
  'cancelled',
  'display',
]);

export function pairedRowKey(commentId, videoId, generation) {
  return `${String(commentId || '')}\0${String(videoId || '')}\0${String(Number(generation) || 0)}`;
}

export function sanitizeDisplayName(value) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80);
}

/**
 * Verified handle only. Empty unless the caller supplied a handle. Never
 * invents `@` from a display name or channel id.
 * @param {string} [value]
 * @returns {string} `@handle` or ''
 */
export function sanitizeAuthorHandle(value) {
  const raw = String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (!raw) return '';
  const stripped = raw.replace(/^@+/, '').slice(0, 79);
  if (!stripped || stripped.includes(' ')) return '';
  return `@${stripped}`;
}

export function displayCommentAuthor({ authorHandle, authorDisplay, author } = {}) {
  return sanitizeAuthorHandle(authorHandle)
    || sanitizeDisplayName(authorDisplay || author)
    || 'Viewer';
}

export function formatAddressedReply(identity, text) {
  const who = displayCommentAuthor(identity);
  const body = String(text || '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/\r\n/g, '\n')
    .trim()
    .slice(0, 1000);
  return body ? `${who}\n${body}` : who;
}

export function normalizeReplyState(value, { hasActions = false } = {}) {
  const raw = String(value || '').toLowerCase();
  if (raw === 'chat') return 'display';
  if (raw === 'succeeded' || raw === 'validated') return 'replied';
  if (raw === 'received' || raw === 'awaiting-execution' || raw === 'executing' || raw === 'awaiting-model') {
    return 'interpreting';
  }
  if (PAIRED_REPLY_STATES.has(raw)) return raw;
  return hasActions ? 'interpreting' : 'display';
}

function defaultReplyText(state) {
  if (state === 'interpreting' || state === 'pending') return INTERPRETING_REPLY_TEXT;
  if (state === 'rejected') return 'Rejected';
  if (state === 'failed') return 'Failed';
  if (state === 'cancelled') return 'Cancelled';
  return '';
}

function matchesLiveBroadcast(state, videoId, generation) {
  const live = state?.liveBroadcast || { videoId: '', generation: 0 };
  if (live.videoId && videoId && videoId !== live.videoId) return false;
  if (live.generation && generation && Number(generation) !== Number(live.generation)) return false;
  return true;
}

export function orderPairedRows(rows, { limit = NEXTCHAT_MAX_PAIRED_ROWS } = {}) {
  const list = Array.isArray(rows) ? rows.slice() : [];
  list.sort((a, b) => Number(a.createdAt ?? a.updatedAt ?? 0) - Number(b.createdAt ?? b.updatedAt ?? 0));
  const cap = Number.isFinite(limit) ? Math.max(0, limit) : list.length;
  if (cap === 0) return [];
  return cap >= list.length ? list : list.slice(-cap);
}

/**
 * Switch the active YouTube broadcast. A new video/generation drops stale rows.
 * @param {object} state
 * @param {{videoId?: string, generation?: number}} payload
 * @returns {object}
 */
export function setLiveBroadcast(state, payload = {}) {
  const videoId = String(payload.videoId || '').slice(0, 80);
  const generation = Math.max(0, Number(payload.generation) || 0);
  const current = state.liveBroadcast || { videoId: '', generation: 0 };
  if (current.videoId === videoId && current.generation === generation) {
    return { ...state, liveBroadcast: { videoId, generation } };
  }
  return {
    ...state,
    liveBroadcast: { videoId, generation },
    pairedRows: [],
  };
}

/**
 * Insert or refresh the left cell of a paired LIVE COMMENTS row.
 * @param {object} state
 * @param {object} payload
 * @param {number} [now]
 * @returns {object}
 */
export function upsertLiveCommentRow(state, payload, now = Date.now()) {
  const commentId = String(payload?.commentId || payload?.metadata?.commentId || '').slice(0, 160);
  const videoId = String(payload?.videoId || payload?.metadata?.videoId || state.liveBroadcast?.videoId || '').slice(0, 80);
  const generation = Math.max(
    0,
    Number(payload?.generation ?? payload?.metadata?.generation ?? state.liveBroadcast?.generation) || 0,
  );
  if (!commentId) return state;
  if (!matchesLiveBroadcast(state, videoId, generation)) return state;
  const commentText = String(payload?.text ?? payload?.content ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/\r\n/g, '\n')
    .trim()
    .slice(0, 500);
  if (!commentText) return state;
  const key = pairedRowKey(commentId, videoId, generation);
  const replyState = normalizeReplyState(
    payload?.replyState || payload?.metadata?.actionState,
    { hasActions: Number(payload?.metadata?.actionCount || payload?.actionCount || 0) > 0 },
  );
  const existing = (state.pairedRows || []).find((row) => row.key === key);
  const receivedAt = String(
    payload?.receivedAt
    || payload?.publishedAt
    || payload?.metadata?.receivedAt
    || existing?.receivedAt
    || '',
  ).slice(0, 40);
  const parsedReceivedAt = Date.parse(receivedAt);
  const row = {
    key,
    commentId,
    videoId,
    generation,
    authorDisplay: sanitizeDisplayName(payload?.authorDisplay || payload?.author) || 'Viewer',
    authorHandle: sanitizeAuthorHandle(payload?.authorHandle),
    commentText,
    replyState: existing?.replyState && existing.replyState !== 'display'
      ? existing.replyState
      : replyState,
    replyText: existing?.replyText || defaultReplyText(replyState),
    receivedAt,
    createdAt: existing?.createdAt
      ?? (Number.isFinite(parsedReceivedAt) ? parsedReceivedAt : now),
    updatedAt: now,
  };
  const pairedRows = [row, ...(state.pairedRows || []).filter((item) => item.key !== key)];
  return { ...state, pairedRows: orderPairedRows(pairedRows) };
}

/**
 * Update the right cell of an existing paired row. Stale video/generation is a no-op.
 * @param {object} state
 * @param {object} payload
 * @param {number} [now]
 * @returns {object}
 */
export function updateAgentReplyRow(state, payload, now = Date.now()) {
  const commentId = String(payload?.commentId || payload?.metadata?.commentId || '').slice(0, 160);
  const videoId = String(payload?.videoId || payload?.metadata?.videoId || state.liveBroadcast?.videoId || '').slice(0, 80);
  const generation = Math.max(
    0,
    Number(payload?.generation ?? payload?.metadata?.generation ?? state.liveBroadcast?.generation) || 0,
  );
  if (!commentId) return state;
  if (!matchesLiveBroadcast(state, videoId, generation)) return state;
  const key = pairedRowKey(commentId, videoId, generation);
  const existing = (state.pairedRows || []).find((row) => row.key === key);
  if (!existing) return state;
  const replyState = normalizeReplyState(payload?.replyState || payload?.metadata?.actionState || payload?.actionState);
  let replyText = payload?.replyText;
  if (typeof payload?.delta === 'string') {
    replyText = `${existing.replyText === INTERPRETING_REPLY_TEXT ? '' : existing.replyText || ''}${payload.delta}`;
  }
  if (replyText == null) replyText = payload?.text ?? defaultReplyText(replyState);
  if (payload?.address !== false && replyState === 'replied' && typeof replyText === 'string' && !String(replyText).includes('\n')) {
    replyText = formatAddressedReply(existing, replyText);
  }
  const row = {
    ...existing,
    replyState,
    replyText: String(replyText || '').slice(0, 1200),
    updatedAt: now,
  };
  const pairedRows = [row, ...(state.pairedRows || []).filter((item) => item.key !== key)];
  return { ...state, pairedRows: orderPairedRows(pairedRows) };
}

const ASSISTANT_DELTA_TYPES = new Set([
  'response.output_audio_transcript.delta',
  'response.audio_transcript.delta',
  'response.output_text.delta',
  'response.text.delta',
]);

const ASSISTANT_DONE_TYPES = new Set([
  'response.output_audio_transcript.done',
  'response.audio_transcript.done',
  'response.output_text.done',
  'response.text.done',
]);

const UNAVAILABLE_MESSAGE = 'GEV voice is not connected';

/**
 * @returns {string} Unique session id.
 */
export function createSessionId() {
  return `nc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * @param {string} text
 * @returns {string}
 */
export function titleFromUserText(text) {
  const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return 'New chat';
  return cleaned.length > 42 ? `${cleaned.slice(0, 41)}…` : cleaned;
}

/**
 * @param {number} [now]
 * @returns {{id: string, title: string, updatedAt: number, messages: object[]}}
 */
export function createEmptySession(now = Date.now()) {
  return {
    id: createSessionId(),
    title: 'New chat',
    updatedAt: now,
    messages: [],
  };
}

/**
 * @param {object} [seed]
 * @returns {{sessions: object[], activeId: string, unavailable: string|null}}
 */
export function createNextchatState(seed = {}) {
  const session = seed.sessions?.[0] || createEmptySession();
  return {
    sessions: seed.sessions || [session],
    activeId: seed.activeId || session.id,
    unavailable: seed.unavailable ?? null,
    harnessStatus: seed.harnessStatus ?? null,
    liveBroadcast: seed.liveBroadcast || { videoId: '', generation: 0 },
    pairedRows: Array.isArray(seed.pairedRows) ? seed.pairedRows : [],
  };
}

/**
 * @param {object} state
 * @returns {object|null}
 */
export function getActiveSession(state) {
  if (!state?.sessions?.length) return null;
  return state.sessions.find((session) => session.id === state.activeId) || state.sessions[0];
}

/**
 * Fail-open load. Blocked or corrupt storage yields a fresh empty session.
 * @param {Pick<Storage, 'getItem'>|null|undefined} storage
 * @returns {object}
 */
export function loadNextchatState(storage) {
  try {
    const raw = storage?.getItem?.(NEXTCHAT_STORAGE_KEY);
    if (!raw) return createNextchatState();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed?.sessions) || parsed.sessions.length === 0) {
      return createNextchatState();
    }
    const sessions = parsed.sessions.map((session) => ({
      id: String(session.id || createSessionId()),
      title: String(session.title || 'New chat'),
      updatedAt: Number(session.updatedAt) || Date.now(),
      messages: Array.isArray(session.messages)
        ? session.messages.map((message) => ({
          id: String(message.id || createSessionId()),
          role: message.role === 'assistant' || message.role === 'viewer' ? message.role : 'user',
          author: String(message.author || '').slice(0, 80),
          content: String(message.content || ''),
          metadata: message.metadata && typeof message.metadata === 'object' ? {
            source: String(message.metadata.source || '').slice(0, 16),
            commentId: String(message.metadata.commentId || '').slice(0, 160),
            videoId: String(message.metadata.videoId || '').slice(0, 80),
            receivedAt: String(message.metadata.receivedAt || '').slice(0, 40),
            actionState: String(message.metadata.actionState || '').slice(0, 24),
            actionCount: Math.max(0, Math.min(20, Number(message.metadata.actionCount) || 0)),
          } : undefined,
          streaming: Boolean(message.streaming),
        }))
        : [],
    }));
    const activeId = sessions.some((session) => session.id === parsed.activeId)
      ? parsed.activeId
      : sessions[0].id;
    return {
      sessions,
      activeId,
      unavailable: null,
      harnessStatus: null,
      liveBroadcast: { videoId: '', generation: 0 },
      pairedRows: [],
    };
  } catch {
    return createNextchatState();
  }
}

/**
 * Fail-open persist. A refused write does not throw.
 * @param {object} state
 * @param {Pick<Storage, 'setItem'>|null|undefined} storage
 * @returns {boolean} True when something was written.
 */
export function persistNextchatState(state, storage) {
  try {
    storage?.setItem?.(NEXTCHAT_STORAGE_KEY, JSON.stringify({
      sessions: state.sessions,
      activeId: state.activeId,
    }));
    return true;
  } catch {
    return false;
  }
}

/**
 * Start a new empty session without copying prior messages.
 * @param {object} state
 * @param {number} [now]
 * @returns {object}
 */
export function newChat(state, now = Date.now()) {
  const session = createEmptySession(now);
  return {
    ...state,
    sessions: [session, ...state.sessions],
    activeId: session.id,
    unavailable: null,
  };
}

/**
 * @param {object} state
 * @param {string} id
 * @returns {object}
 */
export function selectSession(state, id) {
  if (!state.sessions.some((session) => session.id === id)) return state;
  return { ...state, activeId: id };
}

function mapActiveSession(state, mapper, now = Date.now()) {
  return {
    ...state,
    sessions: state.sessions.map((session) => {
      if (session.id !== state.activeId) return session;
      const next = mapper({
        ...session,
        messages: session.messages.slice(),
      });
      next.updatedAt = now;
      return next;
    }),
  };
}

/**
 * @param {object} state
 * @param {string} text
 * @param {number} [now]
 * @returns {object}
 */
export function appendUserMessage(state, text, now = Date.now()) {
  const content = String(text || '').trim();
  if (!content) return state;
  return mapActiveSession(state, (session) => {
    session.messages.push({
      id: createSessionId(),
      role: 'user',
      content,
      streaming: false,
    });
    if (session.title === 'New chat') session.title = titleFromUserText(content);
    return session;
  }, now);
}

/**
 * Append an untrusted viewer comment. Author and text are stored as plain
 * strings; the thread renderer uses textContent only.
 *
 * @param {object} state
 * @param {{author?: string, text?: string, metadata?: object}} payload
 * @param {number} [now]
 * @returns {object}
 */
export function appendViewerMessage(state, payload, now = Date.now()) {
  const author = String(payload?.author || 'VIEWER').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80) || 'VIEWER';
  const content = String(payload?.text ?? payload?.content ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 500);
  if (!content) return state;
  const meta = payload?.metadata && typeof payload.metadata === 'object' ? payload.metadata : {};
  return mapActiveSession(state, (session) => {
    session.messages.push({
      id: createSessionId(),
      role: 'viewer',
      author,
      content,
      metadata: {
        source: String(meta.source || '').slice(0, 16),
        commentId: String(meta.commentId || '').slice(0, 160),
        videoId: String(meta.videoId || '').slice(0, 80),
        receivedAt: String(meta.receivedAt || '').slice(0, 40),
        actionState: String(meta.actionState || '').slice(0, 24),
        actionCount: Math.max(0, Math.min(20, Number(meta.actionCount) || 0)),
      },
      streaming: false,
    });
    if (session.messages.length > NEXTCHAT_MAX_MESSAGES) {
      session.messages.splice(0, session.messages.length - NEXTCHAT_MAX_MESSAGES);
    }
    if (session.title === 'New chat') session.title = titleFromUserText(`${author}: ${content}`);
    return session;
  }, now);
}

/**
 * Operator-readable harness status for the NextChat status line.
 *
 * @param {object} state
 * @param {string|null} message
 * @returns {object}
 */
export function setHarnessStatus(state, message) {
  const text = String(message || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200);
  return { ...state, harnessStatus: text || null };
}

/**
 * Publish a viewer message into a NextChat store or live overlay API.
 *
 * @param {{role?: string, author?: string, text?: string, metadata?: object}} payload
 * @param {object|null|undefined} target Store, overlay API, or null.
 * @returns {{ok: boolean, reason?: string}}
 */
export function publishNextChatMessage(payload, target = null) {
  const store = target?.store && typeof target.store.appendViewerMessage === 'function'
    ? target.store
    : target;
  if (!store || typeof store.appendViewerMessage !== 'function') {
    return { ok: false, reason: 'unavailable' };
  }
  store.appendViewerMessage({
    role: 'viewer',
    author: payload?.author,
    text: payload?.text,
    metadata: payload?.metadata,
  });
  return { ok: true };
}

/**
 * @param {string} message
 * @param {object|null|undefined} target
 * @returns {{ok: boolean}}
 */
export function setNextchatHarnessStatus(message, target = null) {
  const store = target?.store && typeof target.store.setHarnessStatus === 'function'
    ? target.store
    : target;
  if (!store || typeof store.setHarnessStatus !== 'function') return { ok: false };
  store.setHarnessStatus(message);
  return { ok: true };
}

/**
 * Append assistant text incrementally. The first delta creates the bubble;
 * later deltas concatenate. Does not wait for a done event.
 * @param {object} state
 * @param {string} delta
 * @param {number} [now]
 * @returns {object}
 */
export function applyAssistantTranscriptDelta(state, delta, now = Date.now()) {
  const piece = typeof delta === 'string' ? delta : '';
  if (!piece) return state;
  return mapActiveSession(state, (session) => {
    const last = session.messages[session.messages.length - 1];
    if (last?.role === 'assistant' && last.streaming) {
      last.content += piece;
      return session;
    }
    session.messages.push({
      id: createSessionId(),
      role: 'assistant',
      content: piece,
      streaming: true,
    });
    return session;
  }, now);
}

/**
 * Close the current streaming assistant bubble so a later turn starts a new one.
 * @param {object} state
 * @returns {object}
 */
export function finishAssistantStreaming(state) {
  return mapActiveSession(state, (session) => {
    const last = session.messages[session.messages.length - 1];
    if (last?.role === 'assistant') last.streaming = false;
    return session;
  });
}

/**
 * Append GEV ACTIONS reply text incrementally so LIVE COMMENTS-style print
 * type can paint from the store without resetting on each render.
 *
 * @param {object} state
 * @param {{delta?: string, text?: string, actionState?: string}} payload
 * @param {number} [now]
 * @returns {object}
 */
export function applyActionReplyDelta(state, payload, now = Date.now()) {
  const piece = typeof payload?.delta === 'string'
    ? payload.delta
    : typeof payload?.text === 'string' ? payload.text : '';
  if (!piece) return state;
  const actionState = String(payload?.actionState || 'succeeded').slice(0, 24) || 'succeeded';
  return mapActiveSession(state, (session) => {
    const last = session.messages[session.messages.length - 1];
    if (last?.role === 'assistant' && last.streaming && last.metadata?.actionState === actionState) {
      last.content += piece;
      return session;
    }
    session.messages.push({
      id: createSessionId(),
      role: 'assistant',
      author: 'GEV',
      content: piece,
      metadata: {
        source: 'youtube-command',
        commentId: '',
        videoId: '',
        receivedAt: new Date(now).toISOString(),
        actionState,
        actionCount: 0,
      },
      streaming: true,
    });
    return session;
  }, now);
}

export function finishActionReplyStreaming(state) {
  return finishAssistantStreaming(state);
}

/**
 * Type an action-lane reply 2 characters every 24ms, matching HUD summary.
 *
 * @param {string} text
 * @param {{store: object, clock?: {setTimeout: Function, clearTimeout?: Function}, step?: number, intervalMs?: number, actionState?: string}} options
 * @returns {{ok: boolean, cancel?: Function}}
 */
export function typeActionReply(text, options = {}) {
  const store = options.store;
  const clock = options.clock || globalThis;
  const step = Math.max(1, Number(options.step) || ACTION_REPLY_TYPE_STEP);
  const intervalMs = Math.max(1, Number(options.intervalMs) || ACTION_REPLY_TYPE_MS);
  const actionState = options.actionState || 'succeeded';
  const raw = String(text || '');
  const full = options.commentId
    ? formatAddressedReply({
      authorHandle: options.authorHandle,
      authorDisplay: options.authorDisplay || options.author,
    }, raw)
    : raw;
  if (!store || typeof store.applyActionReplyDelta !== 'function' || !full) {
    return { ok: false };
  }
  const previous = actionReplyTimers.get(store);
  if (previous != null) clock.clearTimeout?.(previous);
  let index = 0;
  const tick = () => {
    actionReplyTimers.delete(store);
    const next = Math.min(full.length, index + step);
    store.applyActionReplyDelta({
      delta: full.slice(index, next),
      actionState,
      replyState: 'replied',
      commentId: options.commentId,
      videoId: options.videoId,
      generation: options.generation,
      address: false,
    });
    index = next;
    if (index >= full.length) {
      store.finishActionReplyStreaming?.();
      return;
    }
    const handle = clock.setTimeout(tick, intervalMs);
    actionReplyTimers.set(store, handle);
  };
  const handle = clock.setTimeout(tick, intervalMs);
  actionReplyTimers.set(store, handle);
  return {
    ok: true,
    cancel() {
      const pending = actionReplyTimers.get(store);
      if (pending != null) clock.clearTimeout?.(pending);
      actionReplyTimers.delete(store);
    },
  };
}

/**
 * @param {object} state
 * @param {string|null} message
 * @returns {object}
 */
export function setUnavailable(state, message) {
  return { ...state, unavailable: message || UNAVAILABLE_MESSAGE };
}

/**
 * @param {object} state
 * @returns {object}
 */
export function clearUnavailable(state) {
  if (!state.unavailable) return state;
  return { ...state, unavailable: null };
}

/**
 * Pull assistant text from a Realtime server event, if any.
 * @param {object|null|undefined} payload
 * @returns {string}
 */
export function extractAssistantTranscriptDelta(payload) {
  if (!payload || typeof payload !== 'object') return '';
  if (!ASSISTANT_DELTA_TYPES.has(payload.type)) return '';
  const piece = payload.delta ?? payload.text ?? '';
  return typeof piece === 'string' ? piece : '';
}

/**
 * @param {object|null|undefined} payload
 * @returns {boolean}
 */
export function isAssistantTranscriptDone(payload) {
  return Boolean(payload && ASSISTANT_DONE_TYPES.has(payload.type));
}

/**
 * Mutable store wrapping the reducers with fail-open persist.
 * @param {Storage|null|undefined} storage
 * @returns {object}
 */
export function createNextchatStore(storage) {
  let state = loadNextchatState(storage);
  const listeners = new Set();

  const emit = () => {
    persistNextchatState(state, storage);
    for (const listener of listeners) listener(state);
  };

  return {
    getState() {
      return state;
    },
    getActiveSession() {
      return getActiveSession(state);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    newChat() {
      const previousId = state.activeId;
      const previousMessages = getActiveSession(state)?.messages?.slice() || [];
      state = newChat(state);
      emit();
      return { previousId, previousMessages, activeId: state.activeId };
    },
    selectSession(id) {
      state = selectSession(state, id);
      emit();
    },
    appendUserMessage(text) {
      state = appendUserMessage(state, text);
      emit();
    },
    appendViewerMessage(payload) {
      state = appendViewerMessage(state, payload);
      emit();
    },
    setHarnessStatus(message) {
      state = setHarnessStatus(state, message);
      emit();
    },
    applyAssistantTranscriptDelta(delta) {
      state = applyAssistantTranscriptDelta(state, delta);
      emit();
    },
    finishAssistantStreaming() {
      state = finishAssistantStreaming(state);
      emit();
    },
    applyActionReplyDelta(payload) {
      state = applyActionReplyDelta(state, payload);
      if (payload?.commentId) {
        state = updateAgentReplyRow(state, payload);
      }
      emit();
    },
    finishActionReplyStreaming() {
      state = finishActionReplyStreaming(state);
      emit();
    },
    setLiveBroadcast(payload) {
      state = setLiveBroadcast(state, payload);
      emit();
    },
    upsertLiveCommentRow(payload) {
      state = upsertLiveCommentRow(state, payload);
      emit();
    },
    updateAgentReplyRow(payload) {
      state = updateAgentReplyRow(state, payload);
      emit();
    },
    typeActionReply(text, options = {}) {
      return typeActionReply(text, { ...options, store: this });
    },
    setUnavailable(message) {
      state = setUnavailable(state, message);
      emit();
    },
    clearUnavailable() {
      state = clearUnavailable(state);
      emit();
    },
  };
}

/**
 * @param {object|null|undefined} voice
 * @returns {boolean}
 */
export function isVoiceChannelOpen(voice) {
  return voice?.dc?.readyState === 'open';
}

function voiceUnavailableMessage(voice, fallback = UNAVAILABLE_MESSAGE) {
  const detail = voice?.ui?.errorDetail?.textContent;
  if (typeof detail === 'string' && detail.trim()) return detail.trim();
  if (voice?.status === 'error') return 'Voice path unavailable';
  return fallback;
}

/**
 * Wait until the Realtime data channel is open, or the session errors / idles.
 * `GevRealtimeController.start()` returns after the SDP answer; `dc` is still
 * `connecting` until the later `open` event.
 * @param {object} voice
 * @param {{timeoutMs?: number}} [options]
 * @returns {Promise<{ok: boolean, reason?: string, message?: string}>}
 */
export function waitForVoiceChannel(voice, { timeoutMs = VOICE_CHANNEL_WAIT_MS } = {}) {
  if (isVoiceChannelOpen(voice)) return Promise.resolve({ ok: true });
  if (voice?.status === 'error') {
    return Promise.resolve({
      ok: false,
      reason: 'unavailable',
      message: voiceUnavailableMessage(voice),
    });
  }

  return new Promise((resolve) => {
    let settled = false;
    const dc = voice.dc;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      dc?.removeEventListener?.('open', onOpen);
      dc?.removeEventListener?.('error', onDead);
      dc?.removeEventListener?.('close', onDead);
      resolve(result);
    };
    const onOpen = () => finish({ ok: true });
    const onDead = () => finish({
      ok: false,
      reason: voice.status === 'error' ? 'unavailable' : 'unconnected',
      message: voiceUnavailableMessage(voice),
    });
    const timer = setTimeout(onDead, Math.max(1, Number(timeoutMs) || VOICE_CHANNEL_WAIT_MS));
    const poll = setInterval(() => {
      if (isVoiceChannelOpen(voice)) onOpen();
      else if (voice.status === 'error' || voice.status === 'idle') onDead();
    }, 25);
    if (dc && typeof dc.addEventListener === 'function') {
      dc.addEventListener('open', onOpen);
      dc.addEventListener('error', onDead);
      dc.addEventListener('close', onDead);
    }
    if (isVoiceChannelOpen(voice)) onOpen();
  });
}

/**
 * Start the existing Realtime session if idle, then wait until the data
 * channel is actually open. `start()` returning is not enough — the channel
 * opens on a later event. Does not invent a second backend.
 * @param {object|null|undefined} voice GevRealtimeController (or test double with the same surface)
 * @param {{timeoutMs?: number}} [options]
 * @returns {Promise<{ok: boolean, reason?: string, message?: string}>}
 */
export async function ensureVoiceReady(voice, options = {}) {
  if (isVoiceChannelOpen(voice)) return { ok: true };
  if (!voice || typeof voice.sendTextCommand !== 'function') {
    return { ok: false, reason: 'unconnected', message: UNAVAILABLE_MESSAGE };
  }
  if (voice.status === 'error') {
    return { ok: false, reason: 'unavailable', message: voiceUnavailableMessage(voice) };
  }
  if (typeof voice.start === 'function' && !voice.isActive?.()) {
    try {
      await voice.start({ pushToTalk: false });
    } catch (error) {
      return {
        ok: false,
        reason: 'unavailable',
        message: error?.message || 'Voice path unavailable',
      };
    }
  }
  if (isVoiceChannelOpen(voice)) return { ok: true };
  if (voice.status === 'error') {
    return { ok: false, reason: 'unavailable', message: voiceUnavailableMessage(voice) };
  }
  const pending = voice.status === 'connecting'
    || voice.status === 'listening'
    || voice.dc?.readyState === 'connecting';
  if (pending) return waitForVoiceChannel(voice, options);
  return { ok: false, reason: 'unconnected', message: UNAVAILABLE_MESSAGE };
}

/**
 * Homepage composer send. Empty text is a no-op. A successful path calls the
 * live `sendTextCommand` (which dispatches tools via GEV_REALTIME_TOOLS /
 * gevActions). Unconnected / 503 does not append a fake assistant reply.
 * @param {{text: string, store: object, voice: object|null|undefined}} input
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
export async function submitNextchatSend(input) {
  const text = String(input?.text ?? '').trim();
  if (!text) return { ok: false, reason: 'empty' };

  const store = input.store;
  const voice = input.voice;
  const ready = await ensureVoiceReady(voice, input);
  if (!ready.ok) {
    store?.setUnavailable?.(ready.message || UNAVAILABLE_MESSAGE);
    return { ok: false, reason: ready.reason || 'unconnected' };
  }

  try {
    voice.sendTextCommand(text);
  } catch (error) {
    store?.setUnavailable?.(error?.message || UNAVAILABLE_MESSAGE);
    return { ok: false, reason: 'unconnected' };
  }

  store?.clearUnavailable?.();
  store?.appendUserMessage?.(text);
  return { ok: true };
}

/**
 * Apply a Realtime payload to the store (incremental assistant text).
 * @param {object} store
 * @param {object} payload
 * @returns {void}
 */
export function ingestRealtimePayload(store, payload) {
  const delta = extractAssistantTranscriptDelta(payload);
  if (delta) store.applyAssistantTranscriptDelta(delta);
  if (isAssistantTranscriptDone(payload)) store.finishAssistantStreaming();
}

function renderSessions(listEl, state) {
  if (!listEl) return;
  listEl.replaceChildren();
  for (const session of state.sessions) {
    const button = listEl.ownerDocument.createElement('button');
    button.type = 'button';
    button.className = 'gev-nextchat-session';
    button.dataset.sessionId = session.id;
    button.setAttribute('aria-current', session.id === state.activeId ? 'true' : 'false');
    button.textContent = session.title;
    listEl.appendChild(button);
  }
}

function renderThread(threadEl, session, {
  include = () => true,
  limit = Infinity,
  newestFirst = false,
  now = Date.now(),
  onNeedsAgeRefresh = null,
} = {}) {
  if (!threadEl) return;
  threadEl.replaceChildren();
  const filtered = (session?.messages || []).filter(include);
  const messages = newestFirst
    ? orderLiveCommentMessages(filtered, { limit })
    : filtered.slice(-limit);
  for (const message of messages) {
    const row = threadEl.ownerDocument.createElement('div');
    row.className = `gev-nextchat-msg gev-nextchat-${message.role}`;
    row.dataset.role = message.role;
    if (message.metadata?.actionState) {
      row.dataset.actionState = message.metadata.actionState;
    }
    const receivedAt = Date.parse(String(message.metadata?.receivedAt || ''));
    if (message.role === 'viewer' && Number.isFinite(receivedAt)) {
      const age = now - receivedAt;
      if (age >= NEXTCHAT_COMMENT_FULL_OPACITY_MS) {
        row.classList.add('gev-nextchat-msg-older');
      } else if (typeof onNeedsAgeRefresh === 'function') {
        onNeedsAgeRefresh(NEXTCHAT_COMMENT_FULL_OPACITY_MS - Math.max(0, age));
      }
    }
    const who = threadEl.ownerDocument.createElement('span');
    who.className = 'gev-nextchat-role';
    who.textContent = message.role === 'user'
      ? 'You'
      : message.role === 'viewer'
        ? (message.author || 'Viewer')
        : 'Assistant';
    const body = threadEl.ownerDocument.createElement('div');
    body.className = 'gev-nextchat-text';
    body.textContent = message.content;
    row.append(who, body);
    if (message.role === 'viewer' && message.metadata?.receivedAt) {
      const timestamp = threadEl.ownerDocument.createElement('time');
      timestamp.className = 'gev-nextchat-timestamp';
      timestamp.dateTime = message.metadata.receivedAt;
      timestamp.textContent = formatViewerTimestamp(message.metadata.receivedAt);
      row.appendChild(timestamp);
    }
    threadEl.appendChild(row);
  }
  threadEl.scrollTop = newestFirst ? 0 : threadEl.scrollHeight;
}

export function renderPairedRows(containerEl, rows, { now = Date.now(), onNeedsAgeRefresh = null } = {}) {
  if (!containerEl?.ownerDocument) return;
  const doc = containerEl.ownerDocument;
  containerEl.replaceChildren();
  for (const row of orderPairedRows(rows)) {
    const pair = doc.createElement('div');
    pair.className = 'gev-nextchat-pair';
    pair.dataset.commentId = row.commentId || '';
    pair.dataset.replyState = row.replyState || 'display';
    const commentTimestamp = row.receivedAt || (
      Number.isFinite(Number(row.createdAt)) ? new Date(Number(row.createdAt)).toISOString() : ''
    );
    const commentTime = Date.parse(commentTimestamp);
    if (Number.isFinite(commentTime)) {
      const age = now - commentTime;
      if (age >= NEXTCHAT_COMMENT_FULL_OPACITY_MS) pair.classList.add('gev-nextchat-msg-older');
      else if (typeof onNeedsAgeRefresh === 'function') {
        onNeedsAgeRefresh(NEXTCHAT_COMMENT_FULL_OPACITY_MS - Math.max(0, age));
      }
    }
    const live = doc.createElement('div');
    live.className = 'gev-nextchat-live-lane gev-nextchat-pair-cell';
    const liveWho = doc.createElement('span');
    liveWho.className = 'gev-nextchat-role';
    liveWho.textContent = displayCommentAuthor(row);
    const liveBody = doc.createElement('div');
    liveBody.className = 'gev-nextchat-text';
    liveBody.textContent = row.commentText || '';
    live.append(liveWho, liveBody);
    if (commentTimestamp && Number.isFinite(commentTime)) {
      const timestamp = doc.createElement('time');
      timestamp.className = 'gev-nextchat-timestamp';
      timestamp.dateTime = commentTimestamp;
      timestamp.textContent = formatViewerTimestamp(commentTimestamp);
      live.appendChild(timestamp);
    }

    const reply = doc.createElement('div');
    reply.className = 'gev-nextchat-action-lane gev-nextchat-pair-cell';
    const replyMsg = doc.createElement('div');
    replyMsg.className = 'gev-nextchat-msg gev-nextchat-assistant';
    replyMsg.dataset.actionState = row.replyState || 'display';
    const replyWho = doc.createElement('span');
    replyWho.className = 'gev-nextchat-role';
    replyWho.textContent = 'GEV';
    const replyStatus = doc.createElement('span');
    replyStatus.className = 'gev-nextchat-status-label';
    replyStatus.textContent = row.replyState || 'display';
    const replyBody = doc.createElement('div');
    replyBody.className = 'gev-nextchat-text';
    replyBody.textContent = row.replyText || defaultReplyText(row.replyState);
    replyMsg.append(replyWho, replyStatus, replyBody);
    reply.appendChild(replyMsg);

    pair.append(live, reply);
    containerEl.appendChild(pair);
  }
  containerEl.scrollTop = 0;
}

function registryEntries(registry) {
  if (Array.isArray(registry)) return registry;
  if (registry instanceof Map) return [...registry.values()];
  if (registry && typeof registry === 'object') return Object.values(registry);
  return [];
}

/**
 * Render slash help from an injected canonical command registry. Registry
 * entries may expose command/name/slash and description/legend/label fields.
 * No fallback list is embedded here, so recognition and visible help cannot
 * silently drift apart.
 *
 * @param {object[]|Map|object|null} registry
 * @param {Element|null} target
 * @returns {number} Number of rendered commands.
 */
export function renderCommandLegend(registry, target) {
  if (!target?.ownerDocument) return 0;
  target.replaceChildren();
  let count = 0;
  for (const entry of registryEntries(registry)) {
    if (!entry || entry.hidden === true || entry.public === false) continue;
    const rawCommand = String(entry.command || entry.slash || entry.name || '').trim();
    if (!rawCommand) continue;
    const command = rawCommand.startsWith('/') ? rawCommand : `/${rawCommand}`;
    const description = String(entry.description || entry.legend || entry.label || '').trim();
    const item = target.ownerDocument.createElement('span');
    item.className = 'gev-command-legend-item';
    const code = target.ownerDocument.createElement('strong');
    code.textContent = command;
    item.appendChild(code);
    if (description) {
      const text = target.ownerDocument.createElement('span');
      text.textContent = description;
      item.appendChild(text);
    }
    target.appendChild(item);
    count += 1;
  }
  target.closest?.('#gev-command-legend')?.toggleAttribute('hidden', count === 0);
  return count;
}

function formatViewerTimestamp(value) {
  const date = new Date(String(value || ''));
  if (!Number.isFinite(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * Bind the homepage NextChat chrome. Safe to call before the globe / voice
 * controller exist (ADMIN-style, outside the WebGL gate).
 * @param {object} [options]
 * @param {Document} [options.documentRef]
 * @param {Storage|null} [options.storage]
 * @param {object|null} [options.voice]
 * @returns {object|null}
 */
export function initNextchat({
  documentRef = globalThis.document,
  storage,
  voice = null,
  commandRegistry = null,
} = {}) {
  const doc = documentRef;
  const root = doc?.getElementById?.('gev-nextchat');
  if (!root) return null;

  let resolvedStorage = storage;
  if (resolvedStorage === undefined) {
    try {
      resolvedStorage = globalThis.localStorage;
    } catch {
      resolvedStorage = null;
    }
  }

  const store = createNextchatStore(resolvedStorage);
  let attachedVoice = voice || null;
  const actionThreadEl = root.querySelector('#gev-nextchat-action-thread');
  const liveThreadEl = root.querySelector('#gev-nextchat-live-thread');
  const pairsEl = root.querySelector('#gev-nextchat-pairs');
  const statusEl = root.querySelector('#gev-nextchat-status');
  const form = root.querySelector('#gev-nextchat-form');
  const composer = root.querySelector('#gev-nextchat-composer');
  const newChatBtn = root.querySelector('#gev-nextchat-new');
  const toggleBtn = root.querySelector('#gev-nextchat-toggle');
  const legendEl = doc.getElementById?.('gev-command-legend-items');
  let ageRefreshTimer = null;
  let ageRefreshAt = Infinity;
  let legendRegistry = commandRegistry;

  const scheduleAgeRefresh = (delay) => {
    const dueAt = Date.now() + delay;
    if (ageRefreshTimer !== null && dueAt >= ageRefreshAt) return;
    if (ageRefreshTimer !== null) clearTimeout(ageRefreshTimer);
    ageRefreshAt = dueAt;
    ageRefreshTimer = setTimeout(() => {
      ageRefreshTimer = null;
      ageRefreshAt = Infinity;
      paint();
    }, Math.max(1, delay));
  };

  const paint = () => {
    const state = store.getState();
    const session = store.getActiveSession();
    if (pairsEl) {
      renderPairedRows(pairsEl, state.pairedRows, { onNeedsAgeRefresh: scheduleAgeRefresh });
    } else if (liveThreadEl) {
      renderThread(liveThreadEl, session, {
        include: isLiveCommentMessage,
        limit: NEXTCHAT_MAX_LIVE_COMMENTS,
        newestFirst: true,
        onNeedsAgeRefresh: scheduleAgeRefresh,
      });
      renderThread(actionThreadEl, session, {
        include: isActionLaneMessage,
        limit: NEXTCHAT_MAX_ACTIONS,
      });
    } else {
      renderThread(actionThreadEl, session);
    }
    if (statusEl) {
      statusEl.textContent = state.unavailable
        ? state.unavailable
        : state.harnessStatus
          ? state.harnessStatus
          : attachedVoice
            ? 'Live globe agent — typed sends use GEV MIC tools'
            : 'Voice path unavailable until the globe agent starts';
      statusEl.hidden = false;
    }
  };

  store.subscribe(paint);
  renderCommandLegend(legendRegistry, legendEl);
  paint();

  newChatBtn?.addEventListener('click', () => {
    store.newChat();
  });

  toggleBtn?.addEventListener('click', () => {
    const collapsed = root.classList.toggle('collapsed');
    toggleBtn.setAttribute('aria-expanded', String(!collapsed));
  });

  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = composer?.value || '';
    void (async () => {
      const result = await submitNextchatSend({
        text,
        store,
        voice: attachedVoice,
      });
      if (result.ok && composer) composer.value = '';
    })();
  });

  composer?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    form?.requestSubmit?.() || form?.dispatchEvent(new Event('submit', { cancelable: true }));
  });

  /**
   * Attach the live voice controller and subscribe to Realtime transcript deltas.
   * @param {object|null} controller
   * @returns {void}
   */
  const attachVoice = (controller) => {
    attachedVoice = controller || null;
    if (controller && typeof controller === 'object') {
      controller.onRealtimeEvent = (payload) => ingestRealtimePayload(store, payload);
    }
    paint();
  };

  if (attachedVoice) attachVoice(attachedVoice);

  const api = {
    store,
    attachVoice,
    submit(text) {
      return submitNextchatSend({ text, store, voice: attachedVoice });
    },
    getVoice() {
      return attachedVoice;
    },
    publishViewerMessage(payload) {
      const result = publishNextChatMessage(payload, store);
      if (result.ok && payload?.metadata?.commentId) {
        store.upsertLiveCommentRow?.({
          ...payload,
          commentId: payload.metadata.commentId,
          videoId: payload.metadata.videoId,
          generation: payload.metadata.generation,
          authorHandle: payload.authorHandle,
        });
      }
      return result;
    },
    setLiveBroadcast(payload) {
      return store.setLiveBroadcast?.(payload);
    },
    upsertLiveComment(payload) {
      return store.upsertLiveCommentRow?.(payload);
    },
    updateAgentReply(payload) {
      return store.updateAgentReplyRow?.(payload);
    },
    typeActionReply(text, options = {}) {
      return typeActionReply(text, { ...options, store });
    },
    setHarnessStatus(message) {
      return setNextchatHarnessStatus(message, store);
    },
    renderCommandLegend(registry) {
      legendRegistry = registry;
      return renderCommandLegend(legendRegistry, legendEl);
    },
  };
  root.__gevNextchat = api;
  try {
    globalThis.window && (globalThis.window.__gevNextchat = api);
  } catch {
    /* tests */
  }
  return api;
}
