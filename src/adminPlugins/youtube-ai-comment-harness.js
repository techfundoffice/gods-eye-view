/**
 * ADMIN plugin: Youtube AI Comment Harness.
 *
 * Reads YouTube comments / live chat, shows them in NextChat, and routes
 * leading `#Task` comments through a constrained interpreter into the
 * existing GEV action runner.
 *
 * @module adminPlugins/youtube-ai-comment-harness
 */

import {
  HARNESS_LABEL,
  HARNESS_PLUGIN_ID,
  createYoutubeCommentHarness,
  createYoutubeHarnessSource,
  createNextChatAdapter,
} from '../youtubeCommentHarness.js';

/**
 * @param {Document} doc
 * @param {string} tag
 * @param {string} [className]
 * @param {string} [text]
 * @returns {HTMLElement}
 */
function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/**
 * @param {Document} doc
 * @param {string} id
 * @param {string} label
 * @returns {{row: HTMLElement, value: HTMLElement}}
 */
function counterRow(doc, id, label) {
  const row = el(doc, 'div', 'admin-ych-counter');
  const dt = el(doc, 'dt', '', label);
  const dd = el(doc, 'dd', '');
  dd.id = id;
  dd.textContent = '0';
  row.append(dt, dd);
  return { row, value: dd };
}

/**
 * Paint a list of untrusted strings using text content only.
 *
 * @param {HTMLElement} list
 * @param {object[]} items
 * @param {'message'|'task'} kind
 * @returns {void}
 */
function paintList(list, items, kind) {
  if (!list || typeof list.replaceChildren !== 'function') return;
  const doc = list.ownerDocument;
  const nodes = (items || []).map((item) => {
    const li = el(doc, 'li', `admin-ych-${kind}`);
    const who = el(doc, 'span', 'admin-ych-author', item.author || 'VIEWER');
    const body = el(doc, 'span', 'admin-ych-text', item.text || '');
    li.append(who, body);
    if (kind === 'task') {
      const meta = el(
        doc,
        'span',
        'admin-ych-task-meta',
        [item.decision, item.action, item.reason, item.result].filter(Boolean).join(' · '),
      );
      li.append(meta);
    }
    return li;
  });
  list.replaceChildren(...nodes);
}

/**
 * Operator pane for the Youtube AI Comment Harness.
 *
 * @param {HTMLElement} container
 * @param {object} [context]
 * @returns {() => void}
 */
export function renderYoutubeCommentHarnessPane(container, context = {}) {
  const doc = context.document || container?.ownerDocument || globalThis.document;
  if (!container || typeof doc?.createElement !== 'function') return () => {};

  const harness = context.harness || createYoutubeCommentHarness({
    interpret: context.interpret,
    runner: context.runner,
    youtubeSource: context.youtubeSource || createYoutubeHarnessSource({ fetchImpl: context.fetchImpl }),
    nextChat: context.nextChat || createNextChatAdapter({ getApi: context.getNextchatApi }),
    supportsToolIsolation: context.supportsToolIsolation,
    configured: context.configured,
    fetchImpl: context.fetchImpl,
  });

  const root = el(doc, 'div', 'admin-ych');
  const title = el(doc, 'h2', 'admin-ych-title', HARNESS_LABEL);
  const lead = el(
    doc,
    'p',
    'admin-ych-lead',
    'Reads YouTube comments and live chat into NextChat. Only leading #Task comments can propose a validated globe view.',
  );

  const statusEl = el(doc, 'p', 'admin-ych-status', 'DISABLED');
  statusEl.id = 'ych-status';
  statusEl.setAttribute('role', 'status');

  const connectionEl = el(doc, 'p', 'admin-ych-connection', 'YOUTUBE DISCONNECTED');
  connectionEl.id = 'ych-connection';

  const controls = el(doc, 'div', 'admin-ych-controls');
  const enableBtn = el(doc, 'button', 'scene-btn', 'ENABLE');
  enableBtn.id = 'ych-enabled';
  enableBtn.type = 'button';
  enableBtn.setAttribute('aria-pressed', 'false');

  const stopBtn = el(doc, 'button', 'scene-btn admin-ych-stop', 'STOP / CANCEL');
  stopBtn.id = 'ych-stop';
  stopBtn.type = 'button';

  const sourceSelect = el(doc, 'select', 'admin-ych-select');
  sourceSelect.id = 'ych-source';
  const commentOpt = el(doc, 'option', '', 'Comments');
  commentOpt.value = 'comment';
  const chatOpt = el(doc, 'option', '', 'Live chat');
  chatOpt.value = 'liveChat';
  sourceSelect.append(commentOpt, chatOpt);

  const videoSelect = el(doc, 'select', 'admin-ych-select');
  videoSelect.id = 'ych-video';
  const placeholder = el(doc, 'option', '', 'No video selected');
  placeholder.value = '';
  videoSelect.append(placeholder);

  controls.append(enableBtn, stopBtn, sourceSelect, videoSelect);

  const counters = el(doc, 'dl', 'admin-ych-counters');
  const received = counterRow(doc, 'ych-received', 'Received');
  const displayed = counterRow(doc, 'ych-displayed', 'Displayed');
  const accepted = counterRow(doc, 'ych-accepted', 'Accepted');
  const rejected = counterRow(doc, 'ych-rejected', 'Rejected');
  const rateLimited = counterRow(doc, 'ych-rate-limited', 'Rate limited');
  const failed = counterRow(doc, 'ych-failed', 'Failed');
  counters.append(
    received.row, displayed.row, accepted.row,
    rejected.row, rateLimited.row, failed.row,
  );

  const messagesHead = el(doc, 'h3', 'admin-ych-heading', 'Recent messages');
  const messages = el(doc, 'ol', 'admin-ych-list');
  messages.id = 'ych-messages';

  const tasksHead = el(doc, 'h3', 'admin-ych-heading', '#Task requests');
  const tasks = el(doc, 'ol', 'admin-ych-list');
  tasks.id = 'ych-tasks';

  root.append(
    title, lead, statusEl, connectionEl, controls, counters,
    messagesHead, messages, tasksHead, tasks,
  );
  if (typeof container.replaceChildren === 'function') container.replaceChildren(root);
  else container.append?.(root);

  function paint(snapshot) {
    const state = snapshot || harness.getSnapshot();
    statusEl.textContent = state.status || 'DISABLED';
    statusEl.classList.toggle('warn', !state.enabled || !state.isolationOk);
    const connectionLabel = state.connection === 'connected'
      ? (state.videoTitle || state.videoId ? `CONNECTED · ${state.videoTitle || state.videoId}` : 'CONNECTED')
      : state.connection === 'unavailable'
        ? 'YOUTUBE UNAVAILABLE'
        : 'YOUTUBE DISCONNECTED';
    connectionEl.textContent = `${connectionLabel} · ${state.source === 'liveChat' ? 'LIVE CHAT' : 'COMMENTS'}`;
    enableBtn.textContent = state.enabled ? 'DISABLE' : 'ENABLE';
    enableBtn.setAttribute('aria-pressed', String(Boolean(state.enabled)));
    enableBtn.disabled = !state.isolationOk && !state.enabled;
    sourceSelect.value = state.source === 'liveChat' ? 'liveChat' : 'comment';
    const options = [el(doc, 'option', '', state.videos.length ? 'Select a video' : 'No video selected')];
    options[0].value = '';
    for (const video of state.videos) {
      const option = el(doc, 'option', '', video.title || video.id);
      option.value = video.id;
      if (video.id === state.videoId) option.selected = true;
      options.push(option);
    }
    if (typeof videoSelect.replaceChildren === 'function') videoSelect.replaceChildren(...options);
    videoSelect.value = state.videoId || '';
    received.value.textContent = String(state.counters.received);
    displayed.value.textContent = String(state.counters.displayed);
    accepted.value.textContent = String(state.counters.accepted);
    rejected.value.textContent = String(state.counters.rejected);
    rateLimited.value.textContent = String(state.counters.rateLimited);
    failed.value.textContent = String(state.counters.failed);
    paintList(messages, state.recentMessages, 'message');
    paintList(tasks, state.recentTasks, 'task');
  }

  function onEnable() {
    const state = harness.getSnapshot();
    harness.setEnabled(!state.enabled);
  }
  function onStop() {
    harness.stop();
  }
  function onSource() {
    harness.setSource(sourceSelect.value);
  }
  function onVideo() {
    const id = videoSelect.value;
    const video = harness.getSnapshot().videos.find((item) => item.id === id) || { id };
    harness.setVideo(video);
  }

  enableBtn.addEventListener('click', onEnable);
  stopBtn.addEventListener('click', onStop);
  sourceSelect.addEventListener('change', onSource);
  videoSelect.addEventListener('change', onVideo);

  const unsubscribe = harness.subscribe(paint);
  paint();

  const api = {
    ingest: (...args) => harness.ingest(...args),
    getSnapshot: () => harness.getSnapshot(),
    setEnabled: (value) => harness.setEnabled(value),
    setSource: (value) => harness.setSource(value),
    setVideo: (value) => harness.setVideo(value),
    setToolIsolation: (value, reason) => harness.setToolIsolation(value, reason),
    stop: () => harness.stop(),
  };
  try {
    container.__gevYoutubeCommentHarness = api;
    if (globalThis.window) globalThis.window.__gevYoutubeCommentHarness = api;
  } catch { /* tests */ }

  let cancelled = false;
  if (!context.harness && typeof context.supportsToolIsolation !== 'boolean') {
    const fetchImpl = context.fetchImpl || globalThis.fetch;
    if (typeof fetchImpl === 'function') {
      Promise.resolve(fetchImpl('/api/youtube-comment-harness/status', {
        headers: { Accept: 'application/json' },
        credentials: 'same-origin',
      })).then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (cancelled) return;
        harness.setConfigured(payload.configured !== false);
        harness.setToolIsolation(Boolean(payload.supportsToolIsolation), payload.reason || '');
      }).catch(() => {
        if (cancelled) return;
        harness.setToolIsolation(false, 'Harness status unavailable');
      });
    }
  }
  if (!context.harness) void harness.refreshYoutube?.();

  return () => {
    cancelled = true;
    enableBtn.removeEventListener?.('click', onEnable);
    stopBtn.removeEventListener?.('click', onStop);
    sourceSelect.removeEventListener?.('change', onSource);
    videoSelect.removeEventListener?.('change', onVideo);
    unsubscribe?.();
    harness.stop();
    harness.destroy();
    try {
      if (container.__gevYoutubeCommentHarness === api) delete container.__gevYoutubeCommentHarness;
      if (globalThis.window?.__gevYoutubeCommentHarness === api) delete globalThis.window.__gevYoutubeCommentHarness;
    } catch { /* tests */ }
    if (typeof container.replaceChildren === 'function') container.replaceChildren();
  };
}

const youtubeCommentHarnessPlugin = {
  id: HARNESS_PLUGIN_ID,
  label: HARNESS_LABEL,
  description: 'Read YouTube comments into NextChat and apply validated #Task globe views.',
  render: renderYoutubeCommentHarnessPane,
};

export default youtubeCommentHarnessPlugin;
