/**
 * Hermes east-rail conversation box (composer + thread + starters).
 * Replies stay inside #hermes-box-chat; does not touch Gemini greeting chips.
 *
 * @module hermesBoxChat
 */

export const HERMES_BOX_CHAT_ENDPOINT = '/api/hermes/box-chat';
export const HERMES_BOX_STARTERS = Object.freeze([
  { id: 'control', label: 'What can I control on this globe?', icon: 'public' },
  { id: 'screen', label: "What's on screen right now?", icon: 'visibility' },
  { id: 'flyover', label: 'Help me plan a flyover', icon: 'flight' },
]);

function text(value, max = 1500) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

function stripAiTag(value) {
  return text(value).replace(/^\s*#AI\b[:\s-]*/i, '').trim();
}

export function initHermesBoxChat({
  documentRef = globalThis.document,
  windowRef = globalThis.window,
  fetchImpl = globalThis.fetch,
  endpoint = HERMES_BOX_CHAT_ENDPOINT,
  conversationId = 'gev-hermes-box',
} = {}) {
  const root = documentRef?.getElementById?.('hermes-agent-card');
  const chat = documentRef?.getElementById?.('hermes-box-chat');
  const thread = documentRef?.getElementById?.('hermes-box-thread');
  const empty = documentRef?.getElementById?.('hermes-box-empty');
  const input = documentRef?.getElementById?.('hermes-box-input');
  const sendBtn = documentRef?.getElementById?.('hermes-box-send');
  if (!root || !chat || !thread || !input || !sendBtn) return null;

  let busy = false;
  let typingEl = null;

  const syncEmpty = () => {
    const hasMessages = thread.children.length > 0;
    if (empty) empty.hidden = hasMessages;
    thread.hidden = !hasMessages && !busy;
    chat.dataset.empty = hasMessages ? 'false' : 'true';
  };

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
  };

  const setBusy = (next) => {
    busy = Boolean(next);
    sendBtn.disabled = busy;
    input.disabled = busy;
    root.dataset.chatState = busy ? 'working' : 'idle';
    setTyping(busy);
  };

  async function ask(rawText, { source = 'composer', author = '' } = {}) {
    const prompt = stripAiTag(rawText);
    if (!prompt || busy) return null;
    appendBubble('user', prompt, { author, source });
    setBusy(true);
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
      if (!response.ok || !payload?.ok) {
        const err = text(payload?.error?.message || `Hermes unavailable (${response.status})`, 200);
        appendBubble('assistant', err, { source: 'error' });
        return { ok: false, error: err };
      }
      const reply = text(payload.reply, 2000) || '…';
      appendBubble('assistant', reply, { source: payload.source || 'hermes' });
      return { ok: true, reply, source: payload.source };
    } catch (error) {
      const err = text(error?.message || 'Hermes box chat failed', 200);
      appendBubble('assistant', err, { source: 'error' });
      return { ok: false, error: err };
    } finally {
      setBusy(false);
      syncEmpty();
    }
  }

  const sendFromComposer = () => {
    const value = text(input.value, 1500);
    if (!value) return;
    input.value = '';
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

  chat.querySelectorAll?.('[data-hermes-starter]')?.forEach((button) => {
    button.addEventListener('click', () => {
      const starter = text(button.dataset.hermesStarter || button.textContent, 200);
      if (!starter) return;
      void ask(starter, { source: 'starter' });
    });
  });

  syncEmpty();

  const api = {
    ask,
    isBusy: () => busy,
    conversationId,
  };
  try { windowRef.__gevHermesBox = api; } catch { /* ignore */ }
  return api;
}
