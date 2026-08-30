/**
 * NextChat-shaped homepage chat overlay.
 *
 * Session/thread reducers and the send helper are DOM-free so node:test can
 * drive them. The live send path is `voice.sendTextCommand` on the shipped
 * GevRealtimeController — not a mock transcript and not a parallel chat API.
 */

export const NEXTCHAT_STORAGE_KEY = 'godsEyeView.nextchat.sessions.v1';

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
          role: message.role === 'assistant' || message.role === 'user' ? message.role : 'user',
          content: String(message.content || ''),
          streaming: Boolean(message.streaming),
        }))
        : [],
    }));
    const activeId = sessions.some((session) => session.id === parsed.activeId)
      ? parsed.activeId
      : sessions[0].id;
    return { sessions, activeId, unavailable: null };
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
    applyAssistantTranscriptDelta(delta) {
      state = applyAssistantTranscriptDelta(state, delta);
      emit();
    },
    finishAssistantStreaming() {
      state = finishAssistantStreaming(state);
      emit();
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
 * Start the existing Realtime session if idle, then require an open data channel.
 * Does not invent a second backend.
 * @param {object|null|undefined} voice GevRealtimeController (or test double with the same surface)
 * @returns {Promise<{ok: boolean, reason?: string, message?: string}>}
 */
export async function ensureVoiceReady(voice) {
  if (isVoiceChannelOpen(voice)) return { ok: true };
  if (!voice || typeof voice.sendTextCommand !== 'function') {
    return { ok: false, reason: 'unconnected', message: UNAVAILABLE_MESSAGE };
  }
  if (voice.status === 'error') {
    return { ok: false, reason: 'unavailable', message: voiceUnavailableMessage(voice) };
  }
  if (typeof voice.start === 'function') {
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
  const ready = await ensureVoiceReady(voice);
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

function renderThread(threadEl, session) {
  if (!threadEl) return;
  threadEl.replaceChildren();
  const messages = session?.messages || [];
  for (const message of messages) {
    const row = threadEl.ownerDocument.createElement('div');
    row.className = `gev-nextchat-msg gev-nextchat-${message.role}`;
    row.dataset.role = message.role;
    const who = threadEl.ownerDocument.createElement('span');
    who.className = 'gev-nextchat-role';
    who.textContent = message.role === 'user' ? 'You' : 'Assistant';
    const body = threadEl.ownerDocument.createElement('div');
    body.className = 'gev-nextchat-text';
    body.textContent = message.content;
    row.append(who, body);
    threadEl.appendChild(row);
  }
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
  const sessionsEl = root.querySelector('#gev-nextchat-sessions');
  const threadEl = root.querySelector('#gev-nextchat-thread');
  const statusEl = root.querySelector('#gev-nextchat-status');
  const form = root.querySelector('#gev-nextchat-form');
  const composer = root.querySelector('#gev-nextchat-composer');
  const newChatBtn = root.querySelector('#gev-nextchat-new');
  const toggleBtn = root.querySelector('#gev-nextchat-toggle');

  const paint = () => {
    const state = store.getState();
    renderSessions(sessionsEl, state);
    renderThread(threadEl, store.getActiveSession());
    if (statusEl) {
      statusEl.textContent = state.unavailable
        ? state.unavailable
        : attachedVoice
          ? 'Live globe agent — typed sends use GEV MIC tools'
          : 'Voice path unavailable until the globe agent starts';
      statusEl.hidden = false;
    }
  };

  store.subscribe(paint);
  paint();

  sessionsEl?.addEventListener('click', (event) => {
    const button = event.target?.closest?.('[data-session-id]');
    if (!button) return;
    store.selectSession(button.dataset.sessionId);
  });

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
  };
  root.__gevNextchat = api;
  try {
    globalThis.window && (globalThis.window.__gevNextchat = api);
  } catch {
    /* tests */
  }
  return api;
}
