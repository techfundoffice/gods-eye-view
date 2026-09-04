/**
 * Hermes east-rail conversation box — Grok-Bot-style UX.
 * Sticky thread + composer, multi-turn session, parallel globe actions.
 *
 * @module hermesBoxChat
 */

export const HERMES_BOX_CHAT_ENDPOINT = '/api/hermes/box-chat';
export const HERMES_BOX_STORAGE_KEY = 'gev-hermes-box-thread-v1';

function text(value, max = 1500) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

function stripAiTag(value) {
  return text(value).replace(/^\s*#AI\b[:\s-]*/i, '').trim();
}

function loadThread(storage) {
  try {
    const raw = storage?.getItem?.(HERMES_BOX_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? parsed.slice(-40) : [];
  } catch {
    return [];
  }
}

function saveThread(storage, rows) {
  try {
    storage?.setItem?.(HERMES_BOX_STORAGE_KEY, JSON.stringify((rows || []).slice(-40)));
  } catch { /* ignore */ }
}

/** Best-effort GEV action while Hermes replies (Grok-style: do the thing + talk). */
async function maybeRunGlobeAction(prompt, windowRef) {
  const runner = windowRef?.__godsEyeView?.voiceCommands?.runner;
  if (typeof runner !== 'function') return null;
  const raw = String(prompt || '');
  const nav = raw.match(
    /\b(?:navigate|fly|go|take\s+me|show|zoom|look)\s+(?:to\s+|me\s+to\s+|at\s+)?(.+?)(?:[.!?]|$)/i,
  );
  if (nav?.[1]) {
    const query = text(nav[1], 160);
    if (query) {
      try {
        return await runner('fly_to_location', {
          query,
          viewMode: 'overview',
          waitForArrival: true,
        });
      } catch (error) {
        return { ok: false, error: error?.message || 'fly failed' };
      }
    }
  }
  const layerOn = raw.match(/\b(?:enable|show|turn on|open)\s+(earthquakes?|flights?|ships?|satellites?|traffic|cctv|weather|fires?)\b/i);
  if (layerOn?.[1]) {
    const token = String(layerOn[1]).toLowerCase();
    const layerId = (
      /^earthquake/.test(token) ? 'earthquakes'
      : /^flight/.test(token) ? 'flights'
      : /^ship/.test(token) ? 'ships'
      : /^satellite/.test(token) ? 'satellites'
      : /^fire/.test(token) ? 'fires'
      : token
    );
    try {
      return await runner('set_layer_visibility', { layerId, enabled: true });
    } catch (error) {
      return { ok: false, error: error?.message || 'layer failed' };
    }
  }
  return null;
}

export function initHermesBoxChat({
  documentRef = globalThis.document,
  windowRef = globalThis.window,
  fetchImpl = globalThis.fetch,
  endpoint = HERMES_BOX_CHAT_ENDPOINT,
  conversationId = 'gev-hermes-box',
  storage = globalThis.sessionStorage,
} = {}) {
  const root = documentRef?.getElementById?.('hermes-agent-card');
  const chat = documentRef?.getElementById?.('hermes-box-chat');
  const thread = documentRef?.getElementById?.('hermes-box-thread');
  const empty = documentRef?.getElementById?.('hermes-box-empty');
  const input = documentRef?.getElementById?.('hermes-box-input');
  const sendBtn = documentRef?.getElementById?.('hermes-box-send');
  if (!root || !chat || !thread || !input || !sendBtn) return null;

  chat.classList.add('hermes-box-chat--grok');

  // MOVE brand logo into empty/logo slot (no clone).
  try {
    const slot = documentRef.getElementById('hermes-box-logo-slot') || empty;
    const logo = documentRef.querySelector('#youtube-chat-brand .youtube-chat-brand-logo, img.youtube-chat-brand-logo');
    if (slot && logo && logo.parentElement !== slot) {
      slot.appendChild(logo);
      logo.classList.add('hermes-box-brand-logo');
    }
    documentRef.querySelectorAll?.('.hermes-box-mark')?.forEach((el) => el.remove());
  } catch { /* ignore */ }

  let busy = false;
  let typingEl = null;
  const history = [];

  const syncEmpty = () => {
    const hasMessages = thread.querySelectorAll('.hermes-box-msg:not(.hermes-box-typing)').length > 0;
    if (empty) empty.hidden = hasMessages;
    thread.hidden = false; // always show thread area like Grok (may be empty)
    chat.dataset.empty = hasMessages ? 'false' : 'true';
  };

  const persist = () => saveThread(storage, history);

  const appendBubble = (role, message, meta = {}) => {
    const li = documentRef.createElement('li');
    li.className = `hermes-box-msg hermes-box-msg-${role}`;
    li.dataset.role = role;
    if (meta.source) li.dataset.source = String(meta.source);
    const who = documentRef.createElement('span');
    who.className = 'hermes-box-msg-who';
    who.textContent = role === 'user'
      ? (meta.author ? text(meta.author, 40) : 'You')
      : 'Hermes';
    const body = documentRef.createElement('p');
    body.className = 'hermes-box-msg-body';
    body.textContent = text(message, 2000);
    li.append(who, body);
    thread.append(li);
    thread.hidden = false;
    if (empty) empty.hidden = true;
    chat.dataset.empty = 'false';
    if (!meta.ephemeral) {
      history.push({ role, text: text(message, 2000), source: meta.source || '', at: Date.now() });
      persist();
    }
    try { li.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch { /* ignore */ }
    return li;
  };

  const setTyping = (on) => {
    if (typingEl) {
      typingEl.remove();
      typingEl = null;
    }
    if (!on) return;
    typingEl = documentRef.createElement('li');
    typingEl.className = 'hermes-box-msg hermes-box-msg-assistant hermes-box-typing';
    typingEl.innerHTML = '<span class="hermes-box-msg-who">Hermes</span><p class="hermes-box-msg-body">Working…</p>';
    thread.append(typingEl);
    thread.hidden = false;
    if (empty) empty.hidden = true;
    try { typingEl.scrollIntoView({ block: 'nearest' }); } catch { /* ignore */ }
  };

  const setBusy = (next) => {
    busy = Boolean(next);
    sendBtn.disabled = busy;
    // Keep input editable like Grok Bot — only send is gated.
    root.dataset.chatState = busy ? 'working' : 'idle';
    setTyping(busy);
  };

  const restore = () => {
    const rows = loadThread(storage);
    for (const row of rows) {
      if (!row?.text || (row.role !== 'user' && row.role !== 'assistant')) continue;
      history.push(row);
      const li = documentRef.createElement('li');
      li.className = `hermes-box-msg hermes-box-msg-${row.role}`;
      li.dataset.role = row.role;
      const who = documentRef.createElement('span');
      who.className = 'hermes-box-msg-who';
      who.textContent = row.role === 'user' ? 'You' : 'Hermes';
      const body = documentRef.createElement('p');
      body.className = 'hermes-box-msg-body';
      body.textContent = text(row.text, 2000);
      li.append(who, body);
      thread.append(li);
    }
    syncEmpty();
    if (thread.lastElementChild) {
      try { thread.lastElementChild.scrollIntoView({ block: 'nearest' }); } catch { /* ignore */ }
    }
  };

  async function ask(rawText, { source = 'composer', author = '' } = {}) {
    const prompt = stripAiTag(rawText);
    if (!prompt || busy) return null;
    appendBubble('user', prompt, { author, source });
    setBusy(true);
    // Fire globe action in parallel (Grok does tools while chatting).
    const actionPromise = maybeRunGlobeAction(prompt, windowRef);
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: prompt,
          conversationId,
          source,
          author: text(author, 80),
        }),
      });
      const payload = await response.json().catch(() => ({}));
      let actionResult = null;
      try { actionResult = await actionPromise; } catch { /* ignore */ }

      if (!response.ok || !payload?.ok) {
        const err = text(payload?.error?.message || `Hermes unavailable (${response.status})`, 200);
        // If the globe action worked, still acknowledge it.
        if (actionResult?.ok !== false && actionResult?.ok) {
          appendBubble('assistant', `Done — I updated the globe view.\n(${err})`, { source: 'partial' });
          return { ok: true, reply: 'globe updated', source: 'action', actionResult };
        }
        appendBubble('assistant', err, { source: 'error' });
        return { ok: false, error: err };
      }
      let reply = text(payload.reply, 2000) || '…';
      if (actionResult?.ok && !/navigat|flew|flying|los angeles|moved|showing/i.test(reply)) {
        // Light confirm if model didn't mention the action.
        reply = `${reply}`;
      }
      appendBubble('assistant', reply, { source: payload.source || 'hermes' });
      return { ok: true, reply, source: payload.source, actionResult };
    } catch (error) {
      const err = text(error?.message || 'Hermes box chat failed', 200);
      appendBubble('assistant', err, { source: 'error' });
      return { ok: false, error: err };
    } finally {
      setBusy(false);
      syncEmpty();
      try { input.focus(); } catch { /* ignore */ }
    }
  }

  const autosize = () => {
    try {
      input.style.height = 'auto';
      input.style.height = `${Math.min(input.scrollHeight, 72)}px`;
    } catch { /* ignore */ }
  };

  const sendFromComposer = () => {
    const value = text(input.value, 1500);
    if (!value || busy) return;
    input.value = '';
    autosize();
    void ask(value, { source: 'composer' });
  };

  sendBtn.addEventListener('click', (event) => {
    event.preventDefault();
    sendFromComposer();
  });

  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    if (event.shiftKey) return;
    event.preventDefault();
    sendFromComposer();
  });
  input.addEventListener('input', autosize);

  chat.querySelectorAll?.('[data-hermes-starter]')?.forEach((button) => {
    button.addEventListener('click', () => {
      const starter = text(button.dataset.hermesStarter || button.textContent, 200);
      if (!starter) return;
      void ask(starter, { source: 'starter' });
    });
  });

  restore();
  syncEmpty();
  autosize();

  const api = {
    ask,
    isBusy: () => busy,
    conversationId,
    clear() {
      history.length = 0;
      persist();
      thread.querySelectorAll('.hermes-box-msg').forEach((n) => n.remove());
      syncEmpty();
    },
  };
  try { windowRef.__gevHermesBox = api; } catch { /* ignore */ }
  return api;
}
