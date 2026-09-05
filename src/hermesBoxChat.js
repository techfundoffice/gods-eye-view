/**
 * Hermes east-rail conversation box — Grok-Bot-style UX.
 * Sticky thread + composer, multi-turn session, parallel globe actions.
 *
 * @module hermesBoxChat
 */

export const HERMES_BOX_CHAT_ENDPOINT = '/api/hermes/box-chat';
export const HERMES_BOX_STORAGE_KEY = 'gev-hermes-box-thread-v1';
export const HERMES_BOX_TASKS_KEY = 'gev-hermes-box-tasks-v1';
export const HERMES_BOX_VOICE_MODE_KEY = 'gev-hermes-box-voice-mode-v1';

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
    try { closeSpaces(); } catch { /* ignore */ }
    try { closeProfile(); } catch { /* defined later */ }
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
    const attachmentContext = buildAttachmentContext();
    const bubbleText = attachmentContext
      ? `${prompt}\n\n(attached: ${pendingAttachments.map((a) => a.name).join(', ')})`
      : prompt;
    appendBubble('user', bubbleText, { author, source });
    setBusy(true);
    // Fire globe action in parallel (Grok does tools while chatting).
    const actionPromise = maybeRunGlobeAction(prompt, windowRef);
    try {
      const postBody = JSON.stringify({
        text: prompt,
        conversationId,
        source,
        author: text(author, 80),
        attachmentContext,
        workspacePath: activeWorkspacePath || undefined,
      });
      let response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: postBody,
        });
      } catch (firstErr) {
        // One quick retry — Replit preview sometimes drops the first long CLI attempt.
        await new Promise((r) => windowRef.setTimeout(r, 350));
        response = await fetchImpl(endpoint, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: postBody,
        });
      }
      const payload = await response.json().catch(() => ({}));
      let actionResult = null;
      try { actionResult = await actionPromise; } catch { /* ignore */ }

      if (!response.ok || !payload?.ok) {
        const err = text(payload?.error?.message || `Hermes unavailable (${response.status})`, 200);
        // If the globe action worked, still acknowledge it.
        if (actionResult?.ok !== false && actionResult?.ok) {
          const partial = `Done — I updated the globe view.\n(${err})`;
          appendBubble('assistant', partial, { source: 'partial' });
          clearAttachments();
          speakReply(partial);
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
      clearAttachments();
      speakReply(reply);
      return { ok: true, reply, source: payload.source, actionResult };
    } catch (error) {
      const raw = String(error?.message || 'Hermes box chat failed');
      const err = text(
        /failed to fetch|networkerror|load failed/i.test(raw)
          ? 'Cloudy is unreachable right now — retry in a second (desk API timed out or dropped).'
          : raw,
        200,
      );
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

  const pendingAttachments = [];
  const chipsEl = documentRef.getElementById('hermes-box-attach-chips');
  const profilePanel = documentRef.getElementById('hermes-box-profile-panel');
  const VOICE_KEY = HERMES_BOX_VOICE_MODE_KEY;

  const readVoiceMode = () => {
    try { return storage?.getItem?.(VOICE_KEY) === '1'; } catch { return false; }
  };
  const writeVoiceMode = (on) => {
    try { storage?.setItem?.(VOICE_KEY, on ? '1' : '0'); } catch { /* ignore */ }
  };

  let voiceModeOn = readVoiceMode();

  const speakReply = (replyText) => {
    if (!voiceModeOn) return;
    const utterText = String(replyText || '').trim();
    if (!utterText) return;
    try {
      const synth = windowRef?.speechSynthesis;
      if (!synth || typeof windowRef.SpeechSynthesisUtterance !== 'function') return;
      synth.cancel();
      const u = new windowRef.SpeechSynthesisUtterance(utterText.slice(0, 500));
      u.rate = 1.05;
      u.pitch = 1;
      synth.speak(u);
    } catch { /* ignore */ }
  };

  const buildAttachmentContext = () => {
    if (!pendingAttachments.length) return '';
    const parts = [];
    for (const item of pendingAttachments) {
      if (item.kind === 'text' && item.text) {
        parts.push(`File: ${item.name} (${item.mime || 'text'})\n${item.text}`);
      } else {
        parts.push(`File: ${item.name} (${item.mime || item.kind || 'binary'}, ${item.size || 0} bytes) — binary/image attached in UI; use filename context.`);
      }
    }
    return parts.join('\n\n').slice(0, 6000);
  };

  const renderAttachChips = () => {
    if (!chipsEl) return;
    chipsEl.replaceChildren();
    if (!pendingAttachments.length) {
      chipsEl.hidden = true;
      return;
    }
    chipsEl.hidden = false;
    pendingAttachments.forEach((item, index) => {
      const chip = documentRef.createElement('button');
      chip.type = 'button';
      chip.className = 'hermes-box-attach-chip';
      chip.title = 'Remove attachment';
      chip.textContent = item.name;
      chip.addEventListener('click', () => {
        pendingAttachments.splice(index, 1);
        renderAttachChips();
        refreshProfilePanel();
      });
      chipsEl.append(chip);
    });
  };

  const clearAttachments = () => {
    pendingAttachments.length = 0;
    renderAttachChips();
  };

  const readFileAsAttachment = (file) => new Promise((resolve) => {
    const mime = String(file.type || '');
    const name = String(file.name || 'file');
    const size = Number(file.size) || 0;
    const isText = /^text\//.test(mime) || /\.(txt|md|markdown|json|csv|log|js|ts|css|html|xml|yml|yaml)$/i.test(name);
    if (isText && size <= 120_000) {
      const reader = new windowRef.FileReader();
      reader.onload = () => {
        resolve({
          kind: 'text',
          name,
          mime: mime || 'text/plain',
          size,
          text: String(reader.result || '').slice(0, 8_000),
        });
      };
      reader.onerror = () => resolve({ kind: 'binary', name, mime, size });
      reader.readAsText(file);
      return;
    }
    resolve({
      kind: mime.startsWith('image/') ? 'image' : 'binary',
      name,
      mime: mime || 'application/octet-stream',
      size,
    });
  });

  const closeProfile = () => {
    if (!profilePanel) return;
    profilePanel.hidden = true;
    documentRef.getElementById('hermes-box-profile')?.setAttribute('aria-expanded', 'false');
  };

  const refreshProfilePanel = async () => {
    const statusEl = documentRef.getElementById('hermes-box-profile-status');
    const modelEl = documentRef.getElementById('hermes-box-profile-model');
    const capsEl = documentRef.getElementById('hermes-box-profile-caps');
    const voiceEl = documentRef.getElementById('hermes-box-profile-voice');
    const attachEl = documentRef.getElementById('hermes-box-profile-attach');
    const fromDom = (id) => documentRef.getElementById(id)?.textContent?.trim() || '';
    if (modelEl) modelEl.textContent = fromDom('hermes-agent-provider') || 'Unavailable';
    if (capsEl) capsEl.textContent = fromDom('hermes-agent-capabilities') || 'No capabilities reported';
    if (voiceEl) voiceEl.textContent = voiceModeOn ? 'On — speaks Hermes replies' : 'Off';
    if (attachEl) {
      attachEl.textContent = pendingAttachments.length
        ? pendingAttachments.map((a) => a.name).join(', ')
        : 'None';
    }
    if (statusEl) statusEl.textContent = root.dataset.state || root.dataset.chatState || 'idle';
    try {
      const res = await fetchImpl('/api/hermes/box-chat', { method: 'GET', credentials: 'same-origin', headers: { Accept: 'application/json' } });
      const payload = await res.json().catch(() => ({}));
      if (statusEl && payload?.ok) {
        statusEl.textContent = payload.ready ? 'Ready' : 'Degraded / fallback';
      }
    } catch {
      if (statusEl && statusEl.textContent === 'idle') statusEl.textContent = 'Local UI only';
    }
    try {
      const res = await fetchImpl('/api/youtube-comment-harness/hermes', { method: 'GET', credentials: 'same-origin', headers: { Accept: 'application/json' } });
      const payload = await res.json().catch(() => ({}));
      const harness = payload?.harness || payload || {};
      if (modelEl && (harness.provider || harness.model || harness.active)) {
        modelEl.textContent = `${harness.provider || harness.active || harness.preferred || 'Hermes'}${harness.model ? ` · ${harness.model}` : ''}`;
      }
      if (capsEl && (harness.modelCapabilities || harness.toolCount != null)) {
        capsEl.textContent = harness.modelCapabilities
          ? String(harness.modelCapabilities).slice(0, 160)
          : `${Number(harness.toolCount) || 0} tools`;
      }
      if (statusEl && (harness.running || harness.ready)) {
        statusEl.textContent = harness.running ? 'Running' : 'Ready';
      }
    } catch { /* ignore */ }
  };

  const toggleProfile = async () => {
    if (!profilePanel) return;
    const open = profilePanel.hidden;
    closeRecent();
    closeSettings();
    if (open) {
      await refreshProfilePanel();
      profilePanel.hidden = false;
      documentRef.getElementById('hermes-box-profile')?.setAttribute('aria-expanded', 'true');
    } else {
      closeProfile();
    }
  };

  const setVoiceMode = (on) => {
    voiceModeOn = Boolean(on);
    writeVoiceMode(voiceModeOn);
    chat.dataset.voiceMode = voiceModeOn ? 'on' : 'off';
    const voiceModeBtn = documentRef.getElementById('hermes-box-voice-mode');
    if (voiceModeBtn) {
      voiceModeBtn.setAttribute('aria-pressed', voiceModeOn ? 'true' : 'false');
      voiceModeBtn.classList.toggle('is-active', voiceModeOn);
    }
    if (!voiceModeOn) {
      try { windowRef?.speechSynthesis?.cancel?.(); } catch { /* ignore */ }
    }
    refreshProfilePanel();
  };


  const SPACES_ENDPOINT = '/api/hermes/workspace';
  const WORKSPACE_KEY = 'gev-hermes-box-workspace-path';
  const spacesPanel = documentRef.getElementById('hermes-box-spaces-panel');
  const spacesList = documentRef.getElementById('hermes-box-spaces-list');
  const spacesStatus = documentRef.getElementById('hermes-box-spaces-status');
  let activeWorkspacePath = '';
  try {
    activeWorkspacePath = String(windowRef?.localStorage?.getItem(WORKSPACE_KEY) || '').trim();
  } catch { /* ignore */ }

  const setSpacesStatus = (msg, show = true) => {
    if (!spacesStatus) return;
    spacesStatus.textContent = msg || '';
    spacesStatus.hidden = !show || !msg;
  };

  const closeSpaces = () => {
    if (!spacesPanel) return;
    spacesPanel.hidden = true;
    documentRef.getElementById('hermes-box-files')?.setAttribute('aria-expanded', 'false');
    if (spacesList) spacesList.hidden = true;
  };

  const refreshSpacesHeader = async () => {
    const labelEl = documentRef.getElementById('hermes-box-spaces-home-label');
    const pathEl = documentRef.getElementById('hermes-box-spaces-home-path');
    try {
      const res = await fetchImpl(SPACES_ENDPOINT, { method: 'GET', credentials: 'same-origin', headers: { Accept: 'application/json' } });
      const payload = await res.json().catch(() => ({}));
      if (payload?.cwd) {
        activeWorkspacePath = payload.cwd;
        try { windowRef?.localStorage?.setItem(WORKSPACE_KEY, activeWorkspacePath); } catch { /* ignore */ }
      }
      if (labelEl) labelEl.textContent = payload?.homeLabel || 'Home';
      if (pathEl) pathEl.textContent = activeWorkspacePath || payload?.cwd || '/home/runner/workspace';
      return payload;
    } catch {
      if (pathEl) pathEl.textContent = activeWorkspacePath || '/home/runner/workspace';
      return null;
    }
  };

  const renderWorktreeList = (trees) => {
    if (!spacesList) return;
    spacesList.replaceChildren();
    const rows = Array.isArray(trees) ? trees : [];
    if (!rows.length) {
      spacesList.hidden = true;
      return;
    }
    spacesList.hidden = false;
    for (const tree of rows) {
      const li = documentRef.createElement('li');
      const btn = documentRef.createElement('button');
      btn.type = 'button';
      btn.className = 'hermes-box-settings-item hermes-box-spaces-path-btn';
      const p = String(tree?.path || '').trim();
      const branch = String(tree?.branch || '').trim();
      btn.textContent = branch ? `${branch} — ${p}` : p;
      btn.title = p;
      btn.addEventListener('click', async () => {
        await postSpacesAction('set-path', { path: p });
      });
      li.append(btn);
      spacesList.append(li);
    }
  };

  const postSpacesAction = async (action, extra = {}) => {
    setSpacesStatus('Working…');
    try {
      const res = await fetchImpl(SPACES_ENDPOINT, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...extra }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok || payload?.ok === false) {
        setSpacesStatus(payload?.error?.message || 'Workspace action failed');
        return null;
      }
      if (payload?.cwd) {
        activeWorkspacePath = payload.cwd;
        try { windowRef?.localStorage?.setItem(WORKSPACE_KEY, activeWorkspacePath); } catch { /* ignore */ }
      }
      await refreshSpacesHeader();
      if (Array.isArray(payload?.worktrees)) renderWorktreeList(payload.worktrees);
      if (action === 'worktree' || action === 'new-worktree') {
        startNewTask();
        setSpacesStatus(`Worktree ready: ${payload?.cwd || ''}`);
        closeSpaces();
      } else if (action === 'set-path' || action === 'choose') {
        setSpacesStatus(`Switched to ${payload?.cwd || ''}`);
      } else if (action === 'manage' || action === 'list') {
        setSpacesStatus(`${(payload?.worktrees || []).length} workspace(s)`);
      } else if (action === 'home') {
        setSpacesStatus(`Home: ${payload?.cwd || ''}`);
      }
      return payload;
    } catch (error) {
      setSpacesStatus(error?.message || 'Workspace request failed');
      return null;
    }
  };

  const toggleSpaces = async () => {
    if (!spacesPanel) return;
    const open = spacesPanel.hidden;
    closeRecent();
    closeSettings();
    closeProfile();
    if (open) {
      spacesPanel.hidden = false;
      documentRef.getElementById('hermes-box-files')?.setAttribute('aria-expanded', 'true');
      setSpacesStatus('');
      const payload = await refreshSpacesHeader();
      if (payload?.worktrees) renderWorktreeList([]);
    } else {
      closeSpaces();
    }
  };

  const wireSpacesPanel = () => {
    documentRef.getElementById('hermes-box-spaces-home-label')?.addEventListener('click', (event) => {
      event.preventDefault();
      void postSpacesAction('home');
    });
    documentRef.getElementById('hermes-box-spaces-home-path')?.addEventListener('click', (event) => {
      event.preventDefault();
      void postSpacesAction('home');
    });
    documentRef.getElementById('hermes-box-spaces-worktree')?.addEventListener('click', (event) => {
      event.preventDefault();
      void postSpacesAction('worktree');
    });
    documentRef.getElementById('hermes-box-spaces-choose')?.addEventListener('click', (event) => {
      event.preventDefault();
      const current = activeWorkspacePath || '/home/runner/workspace';
      const next = windowRef?.prompt?.('Workspace path', current);
      if (next == null) return;
      const trimmed = String(next).trim();
      if (!trimmed) return;
      void postSpacesAction('set-path', { path: trimmed });
    });
    documentRef.getElementById('hermes-box-spaces-manage')?.addEventListener('click', async (event) => {
      event.preventDefault();
      const payload = await postSpacesAction('manage');
      if (payload?.worktrees) renderWorktreeList(payload.worktrees);
    });
  };
  wireSpacesPanel();

  // Outside click / Escape close spaces
  documentRef.addEventListener('click', (event) => {
    if (!spacesPanel || spacesPanel.hidden) return;
    const t = event.target;
    const filesBtnEl = documentRef.getElementById('hermes-box-files');
    if (!spacesPanel.contains(t) && !filesBtnEl?.contains?.(t)) closeSpaces();
  });
  documentRef.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeSpaces();
  });

  const wireComposerBar = () => {
    const attachBtn = documentRef.getElementById('hermes-box-attach');
    const attachInput = documentRef.getElementById('hermes-box-attach-input');
    const micBtn = documentRef.getElementById('hermes-box-mic');
    const voiceModeBtn = documentRef.getElementById('hermes-box-voice-mode');
    const profileBtn = documentRef.getElementById('hermes-box-profile');
    const filesBtn = documentRef.getElementById('hermes-box-files');
    const tuneBtn = documentRef.getElementById('hermes-box-tune');

    const recordBtn = documentRef.getElementById('hermes-box-record-video');
    const syncRecordBtn = () => {
      const sm = windowRef?.__godsEyeView?.styleManager;
      const on = Boolean(sm?._recordingMode || documentRef.body?.classList?.contains('recording-mode'));
      if (!recordBtn) return;
      recordBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
      recordBtn.classList.toggle('is-active', on);
      recordBtn.title = on ? 'Stop recording mode' : 'Record video';
      recordBtn.setAttribute('aria-label', on ? 'Stop recording mode' : 'Record video');
    };
    recordBtn?.addEventListener('click', (event) => {
      event.preventDefault();
      const sm = windowRef?.__godsEyeView?.styleManager;
      const on = Boolean(sm?._recordingMode || documentRef.body?.classList?.contains('recording-mode'));
      const next = !on;
      if (typeof sm?.setRecordingMode === 'function') {
        sm.setRecordingMode(next);
      } else {
        documentRef.body?.classList?.toggle('recording-mode', next);
      }
      syncRecordBtn();
    });
    syncRecordBtn();

    if (profileBtn) {
      profileBtn.setAttribute('aria-haspopup', 'dialog');
      profileBtn.setAttribute('aria-controls', 'hermes-box-profile-panel');
      profileBtn.setAttribute('aria-expanded', 'false');
    }

    setVoiceMode(voiceModeOn);

    attachBtn?.addEventListener('click', (event) => {
      event.preventDefault();
      attachInput?.click();
    });
    attachInput?.addEventListener('change', async () => {
      const files = Array.from(attachInput.files || []);
      if (!files.length) return;
      for (const file of files.slice(0, 6)) {
        if (pendingAttachments.length >= 8) break;
        const item = await readFileAsAttachment(file);
        pendingAttachments.push(item);
      }
      renderAttachChips();
      refreshProfilePanel();
      attachInput.value = '';
      try { input.focus(); } catch { /* ignore */ }
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
      setVoiceMode(!voiceModeOn);
      if (voiceModeOn) {
        // Kick listening so voice mode is immediately useful.
        micBtn?.click?.();
      }
    });

    profileBtn?.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      void toggleProfile();
    });

    filesBtn?.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      closeProfile();
      void toggleSpaces();
    });

    tuneBtn?.addEventListener('click', (event) => {
      event.preventDefault();
      closeProfile();
      if (typeof toggleSettings === 'function') toggleSettings();
      else settingsBtn?.click?.();
    });

    documentRef.getElementById('hermes-box-profile-refresh')?.addEventListener('click', (event) => {
      event.preventDefault();
      void refreshProfilePanel();
    });
    documentRef.getElementById('hermes-box-profile-diagnostics')?.addEventListener('click', (event) => {
      event.preventDefault();
      closeProfile();
      const details = root.querySelector('.hermes-box-diagnostics');
      if (details) {
        details.open = true;
        try { details.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch { /* ignore */ }
      }
    });
  };
  wireComposerBar();

  // Outside-click / Escape also closes profile.
  documentRef.addEventListener('click', (event) => {
    if (!profilePanel || profilePanel.hidden) return;
    const t = event.target;
    const profileBtn = documentRef.getElementById('hermes-box-profile');
    if (!profilePanel.contains(t) && !profileBtn?.contains?.(t)) closeProfile();
  });
  documentRef.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeProfile();
  });


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
