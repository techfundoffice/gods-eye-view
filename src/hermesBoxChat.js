/**
 * Hermes east-rail conversation box — Grok-Bot-style UX.
 * Sticky thread + composer, multi-turn session, parallel globe actions.
 *
 * @module hermesBoxChat
 */

export const HERMES_BOX_CHAT_ENDPOINT = '/api/hermes/box-chat';
export const HERMES_BOX_STORAGE_KEY = 'gev-hermes-box-thread-v1';
export const HERMES_BOX_TASKS_KEY = 'gev-hermes-box-tasks-v1';

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


function loadTaskArchive(storage) {
  try {
    const raw = storage?.getItem?.(HERMES_BOX_TASKS_KEY);
    const rows = raw ? JSON.parse(raw) : [];
    return Array.isArray(rows) ? rows.filter((t) => typeof t === 'string' && t.trim()) : [];
  } catch {
    return [];
  }
}

function saveTaskArchive(storage, tasks) {
  try {
    const cleaned = [];
    const seen = new Set();
    for (const t of tasks || []) {
      const prompt = String(t || '').trim();
      if (!prompt || seen.has(prompt)) continue;
      seen.add(prompt);
      cleaned.push(prompt);
      if (cleaned.length >= 24) break;
    }
    storage?.setItem?.(HERMES_BOX_TASKS_KEY, JSON.stringify(cleaned));
  } catch { /* ignore */ }
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

  const recentBtn = documentRef.getElementById('hermes-box-recent-tasks');
  const recentPanel = documentRef.getElementById('hermes-box-recent-panel');
  const recentList = documentRef.getElementById('hermes-box-recent-list');
  const recentEmpty = documentRef.getElementById('hermes-box-recent-empty');

  const settingsBtn = documentRef.getElementById('hermes-box-settings');
  const settingsPanel = documentRef.getElementById('hermes-box-settings-panel');

  const closeRecent = () => {
    if (!recentPanel || !recentBtn) return;
    recentPanel.hidden = true;
    recentBtn.setAttribute('aria-expanded', 'false');
  };

  const closeSettings = () => {
    if (!settingsPanel || !settingsBtn) return;
    settingsPanel.hidden = true;
    settingsBtn.setAttribute('aria-expanded', 'false');
  };

  const closeAllMenus = () => {
    closeRecent();
    closeSettings();
  };

  const toggleSettings = () => {
    if (!settingsPanel || !settingsBtn) return;
    const open = settingsPanel.hidden;
    closeRecent();
    if (open) {
      settingsPanel.hidden = false;
      settingsBtn.setAttribute('aria-expanded', 'true');
    } else {
      closeSettings();
    }
  };

  const collectRecentPrompts = () => {
    const tasks = [];
    const seen = new Set();
    const push = (prompt) => {
      const text = String(prompt || '').trim();
      if (!text || seen.has(text)) return;
      seen.add(text);
      tasks.push(text);
    };
    for (let i = history.length - 1; i >= 0; i -= 1) {
      const row = history[i];
      if (!row || row.role !== 'user') continue;
      push(row.text);
      if (tasks.length >= 12) return tasks;
    }
    for (const archived of loadTaskArchive(storage)) {
      push(archived);
      if (tasks.length >= 12) break;
    }
    return tasks;
  };

  const archiveCurrentTasks = () => {
    const merged = [];
    const seen = new Set();
    for (const row of history) {
      if (!row || row.role !== 'user') continue;
      const prompt = String(row.text || '').trim();
      if (!prompt || seen.has(prompt)) continue;
      seen.add(prompt);
      merged.push(prompt);
    }
    for (const archived of loadTaskArchive(storage)) {
      if (seen.has(archived)) continue;
      seen.add(archived);
      merged.push(archived);
    }
    saveTaskArchive(storage, merged);
  };

  const startNewTask = () => {
    closeAllMenus();
    archiveCurrentTasks();
    history.length = 0;
    persist();
    thread.querySelectorAll('.hermes-box-msg').forEach((n) => n.remove());
    if (typingEl) {
      typingEl.remove();
      typingEl = null;
    }
    busy = false;
    sendBtn.disabled = false;
    root.dataset.chatState = 'idle';
    if (input) {
      input.value = '';
      try { input.focus(); } catch { /* ignore */ }
    }
    syncEmpty();
    autosize();
  };

  const renderRecentTasks = () => {
    if (!recentList) return;
    recentList.replaceChildren();
    const tasks = collectRecentPrompts();
    if (recentEmpty) recentEmpty.hidden = tasks.length > 0;
    for (const prompt of tasks) {
      const li = documentRef.createElement('li');
      const btn = documentRef.createElement('button');
      btn.type = 'button';
      btn.className = 'hermes-box-recent-item';
      btn.textContent = prompt.length > 90 ? `${prompt.slice(0, 87)}…` : prompt;
      btn.title = prompt;
      btn.addEventListener('click', () => {
        closeRecent();
        if (input) {
          input.value = prompt;
          try { input.focus(); } catch { /* ignore */ }
        }
        ask(prompt, { source: 'recent-tasks' });
      });
      li.append(btn);
      recentList.append(li);
    }
  };

  const toggleRecent = () => {
    if (!recentPanel || !recentBtn) return;
    const open = recentPanel.hidden;
    closeSettings();
    if (open) {
      renderRecentTasks();
      recentPanel.hidden = false;
      recentBtn.setAttribute('aria-expanded', 'true');
    } else {
      closeRecent();
    }
  };

  if (recentBtn) {
    recentBtn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleRecent();
    });
  }
  const newTaskBtn = documentRef.getElementById('hermes-box-new-task');
  if (newTaskBtn) {
    newTaskBtn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      startNewTask();
    });
  }
  if (settingsBtn) {
    settingsBtn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleSettings();
    });
  }
  documentRef.getElementById('hermes-box-settings-diagnostics')?.addEventListener('click', (event) => {
    event.preventDefault();
    closeAllMenus();
    const details = root.querySelector('.hermes-box-diagnostics');
    if (details) {
      details.open = true;
      try { details.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch { /* ignore */ }
    }
  });
  documentRef.getElementById('hermes-box-settings-clear-recent')?.addEventListener('click', (event) => {
    event.preventDefault();
    saveTaskArchive(storage, []);
    closeAllMenus();
  });
  documentRef.getElementById('hermes-box-settings-new-task')?.addEventListener('click', (event) => {
    event.preventDefault();
    startNewTask();
  });
  documentRef.addEventListener('click', (event) => {
    const t = event.target;
    if (recentPanel && !recentPanel.hidden) {
      if (!recentPanel.contains(t) && !recentBtn?.contains?.(t)) closeRecent();
    }
    if (settingsPanel && !settingsPanel.hidden) {
      if (!settingsPanel.contains(t) && !settingsBtn?.contains?.(t)) closeSettings();
    }
  });
  documentRef.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeAllMenus();
  });


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
    // Keep logo at top always; only hide idle greeting/starters.
    if (empty) empty.hidden = hasMessages;
    thread.hidden = false; // always show thread area like Grok (may be empty)
    chat.dataset.empty = hasMessages ? 'false' : 'true';
  };

  const persist = () => saveThread(storage, history);

  const copyIconHtml = `<svg class="hermes-box-copy-svg" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false"><rect x="9" y="9" width="13" height="13" rx="2" ry="2" fill="none" stroke="currentColor" stroke-width="1.9"/><path fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;

  const attachCopyAction = (li, messageText) => {
    if (!li || li.querySelector('.hermes-box-copy')) return;
    const actions = documentRef.createElement('div');
    actions.className = 'hermes-box-msg-actions';
    const btn = documentRef.createElement('button');
    btn.type = 'button';
    btn.className = 'hermes-box-copy';
    btn.title = 'Copy';
    btn.setAttribute('aria-label', 'Copy message');
    btn.innerHTML = copyIconHtml;
    btn.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const payload = String(messageText || '').trim();
      if (!payload) return;
      try {
        if (windowRef?.navigator?.clipboard?.writeText) {
          await windowRef.navigator.clipboard.writeText(payload);
        } else {
          const ta = documentRef.createElement('textarea');
          ta.value = payload;
          ta.setAttribute('readonly', '');
          ta.style.position = 'fixed';
          ta.style.left = '-9999px';
          documentRef.body.appendChild(ta);
          ta.select();
          documentRef.execCommand('copy');
          ta.remove();
        }
        btn.dataset.copied = 'true';
        btn.title = 'Copied';
        windowRef.setTimeout?.(() => {
          btn.dataset.copied = 'false';
          btn.title = 'Copy';
        }, 1400);
      } catch {
        btn.title = 'Copy failed';
      }
    });
    actions.append(btn);
    li.append(actions);
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
    const msgText = text(message, 2000);
    body.textContent = msgText;
    li.append(who, body);
    if (!meta.ephemeral) attachCopyAction(li, msgText);
    thread.append(li);
    thread.hidden = false;
    if (empty) empty.hidden = true;
    chat.dataset.empty = 'false';
    if (!meta.ephemeral) {
      history.push({ role, text: msgText, source: meta.source || '', at: Date.now() });
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
      const msgText = text(row.text, 2000);
      body.textContent = msgText;
      li.append(who, body);
      attachCopyAction(li, msgText);
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

  const wireComposerBar = () => {
    const attachBtn = documentRef.getElementById('hermes-box-attach');
    const attachInput = documentRef.getElementById('hermes-box-attach-input');
    const micBtn = documentRef.getElementById('hermes-box-mic');
    const voiceModeBtn = documentRef.getElementById('hermes-box-voice-mode');
    const profileBtn = documentRef.getElementById('hermes-box-profile');
    const filesBtn = documentRef.getElementById('hermes-box-files');
    const tuneBtn = documentRef.getElementById('hermes-box-tune');

    attachBtn?.addEventListener('click', (event) => {
      event.preventDefault();
      attachInput?.click();
    });
    attachInput?.addEventListener('change', () => {
      const files = Array.from(attachInput.files || []);
      if (!files.length) return;
      const names = files.map((f) => f.name).join(', ');
      const note = `Attached: ${names}`;
      if (input && !input.value.trim()) input.value = note;
      else if (input) input.value = `${input.value.trim()}\n${note}`;
      autosize();
      try { input.focus(); } catch { /* ignore */ }
      attachInput.value = '';
    });

    micBtn?.addEventListener('click', (event) => {
      event.preventDefault();
      const voice =
        documentRef.getElementById('gev-voice-button')
        || documentRef.querySelector('#gev-voice-control button')
        || documentRef.getElementById('left-yt-mic');
      try { voice?.click?.(); } catch { /* ignore */ }
    });

    voiceModeBtn?.addEventListener('click', (event) => {
      event.preventDefault();
      const on = voiceModeBtn.getAttribute('aria-pressed') !== 'true';
      voiceModeBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
      voiceModeBtn.classList.toggle('is-active', on);
      chat.dataset.voiceMode = on ? 'on' : 'off';
    });

    profileBtn?.addEventListener('click', (event) => {
      event.preventDefault();
      profileBtn.classList.add('is-active');
      profileBtn.setAttribute('aria-pressed', 'true');
      try { input.focus(); } catch { /* ignore */ }
    });

    filesBtn?.addEventListener('click', (event) => {
      event.preventDefault();
      // Reuse Recent Tasks as the local files/history drawer for now.
      if (typeof toggleRecent === 'function') toggleRecent();
      else recentBtn?.click?.();
    });

    tuneBtn?.addEventListener('click', (event) => {
      event.preventDefault();
      if (typeof toggleSettings === 'function') toggleSettings();
      else settingsBtn?.click?.();
    });
  };
  wireComposerBar();

  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    if (event.shiftKey) return;
    event.preventDefault();
    sendFromComposer();
  });
  const copyAllBtn = documentRef.getElementById('hermes-box-copy-all');
  const copyTextToClipboard = async (payload, btn) => {
    const text = String(payload || '').trim();
    if (!text) return false;
    try {
      if (windowRef?.navigator?.clipboard?.writeText) {
        await windowRef.navigator.clipboard.writeText(text);
      } else {
        const ta = documentRef.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        documentRef.body.appendChild(ta);
        ta.select();
        documentRef.execCommand('copy');
        ta.remove();
      }
      if (btn) {
        btn.dataset.copied = 'true';
        const prev = btn.title;
        btn.title = 'Copied';
        windowRef.setTimeout?.(() => {
          btn.dataset.copied = 'false';
          btn.title = prev || 'Copy all';
        }, 1400);
      }
      return true;
    } catch {
      if (btn) btn.title = 'Copy failed';
      return false;
    }
  };

  const buildThreadTranscript = () => {
    const lines = [];
    for (const row of history) {
      if (!row?.text) continue;
      const who = row.role === 'user' ? 'You' : 'Hermes';
      lines.push(`${who}: ${String(row.text).trim()}`);
    }
    if (!lines.length) {
      thread.querySelectorAll('.hermes-box-msg:not(.hermes-box-typing)').forEach((li) => {
        const who = li.querySelector('.hermes-box-msg-who')?.textContent?.trim() || 'Hermes';
        const body = li.querySelector('.hermes-box-msg-body')?.textContent?.trim() || '';
        if (body) lines.push(`${who}: ${body}`);
      });
    }
    return lines.join('\n\n');
  };

  if (copyAllBtn) {
    copyAllBtn.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const transcript = buildThreadTranscript();
      if (!transcript) {
        copyAllBtn.title = 'Nothing to copy';
        windowRef.setTimeout?.(() => { copyAllBtn.title = 'Copy all'; }, 1200);
        return;
      }
      await copyTextToClipboard(transcript, copyAllBtn);
    });
  }

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
      startNewTask();
    },
    newTask() {
      startNewTask();
    },
  };
  try { windowRef.__gevHermesBox = api; } catch { /* ignore */ }
  return api;
}
