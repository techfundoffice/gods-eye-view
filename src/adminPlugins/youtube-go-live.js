/**
 * ADMIN plugin: YouTube Go Live.
 *
 * Session-gated operator pane for Studio QR/link, secure stream-key ingest,
 * broadcast provision/select, start/stop, readiness phases, and the watch
 * link. Reuses `/api/admin/live` and the shared live session — not a second
 * encoder.
 *
 * @module adminPlugins/youtube-go-live
 */

import {
  LIVE_POLL_MS,
  buildAdminLiveStartBody,
  canStartLive,
  createAdminClient,
  defaultLiveCaptureUrl,
  formatLiveUptime,
  isAdminUnlocked,
  liveStatusLabel,
} from '../adminConsole.js';

export const YOUTUBE_GO_LIVE_PLUGIN_ID = 'youtube-go-live';
export const YOUTUBE_GO_LIVE_LABEL = 'YouTube Go Live';
export const STUDIO_GO_LIVE_URL = 'https://studio.youtube.com/channel/UCse5uFZOiANS1FPBI_AR5nw/livestreaming';

const LIVE_POLL_STATUSES = new Set([
  'starting',
  'encoding',
  'ingesting',
  'waiting-for-youtube',
  'live',
]);

const PHASES = [
  ['account', 'YouTube authorization'],
  ['broadcast', 'Broadcast binding'],
  ['capture', 'Capture URL'],
  ['encoder', 'Chromium / FFmpeg'],
  ['ingest', 'RTMP ingest'],
  ['youtube', 'YouTube confirmation'],
  ['odbc', 'ODBC persistence'],
];

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
 * Shared broadcast identity the comment harness can adopt.
 *
 * @param {object} [live]
 * @returns {{id: string, title: string, watchUrl: string}|null}
 */
export function sharedLiveVideoFromSession(live) {
  const broadcast = live?.broadcast;
  const id = String(broadcast?.id || '').trim();
  if (!id) return null;
  return {
    id,
    title: String(broadcast.title || broadcast.id || '').trim(),
    watchUrl: String(broadcast.watchUrl || '').trim(),
    liveChatId: String(broadcast.liveChatId || '').trim(),
  };
}

/**
 * Paint the authenticated YouTube Go Live pane.
 *
 * @param {HTMLElement} container
 * @param {object} [context]
 * @returns {() => void}
 */
export function renderYoutubeGoLivePane(container, context = {}) {
  const doc = context.document || container?.ownerDocument || globalThis.document;
  if (!container || typeof doc?.createElement !== 'function') return () => {};

  const client = context.client || createAdminClient({ fetchImpl: context.fetchImpl });
  const session = context.session || { configured: true, authenticated: true };
  if (!isAdminUnlocked(session) && context.requireSession !== false) {
    const locked = el(doc, 'p', 'admin-ygl-locked', 'Sign in to ADMIN to use YouTube Go Live.');
    locked.id = 'ygl-locked';
    if (typeof container.replaceChildren === 'function') container.replaceChildren(locked);
    else container.append?.(locked);
    return () => {
      if (typeof container.replaceChildren === 'function') container.replaceChildren();
    };
  }

  const root = el(doc, 'div', 'admin-ygl');
  const title = el(doc, 'h2', 'admin-ygl-title', YOUTUBE_GO_LIVE_LABEL);
  const lead = el(
    doc,
    'p',
    'admin-ygl-lead',
    'Capture the globe with headless Chromium and publish H.264/AAC to YouTube Live. Stream keys stay on the server.',
  );

  const row = el(doc, 'div', 'admin-live-row');
  const chip = el(doc, 'span', 'admin-live-state', 'OFFLINE');
  chip.id = 'ygl-state';
  chip.dataset.liveStatus = 'idle';
  chip.setAttribute('role', 'status');
  const watch = el(doc, 'a', 'admin-live-watch', 'OPEN ON YOUTUBE');
  watch.id = 'ygl-watch';
  watch.href = '#';
  watch.target = '_blank';
  watch.rel = 'noopener';
  watch.hidden = true;
  row.append(el(doc, 'span', 'admin-mcp-label', 'BROADCAST'), chip, watch);

  const studio = el(doc, 'aside', 'admin-ygl-studio');
  const qr = el(doc, 'img', 'admin-ygl-qr');
  qr.id = 'ygl-studio-qr';
  qr.src = '/go-live-studio-qr.png';
  qr.width = 140;
  qr.height = 140;
  qr.alt = 'QR code that opens YouTube Studio Go live';
  const studioLink = el(doc, 'a', '', 'YouTube Studio → Go live');
  studioLink.id = 'ygl-studio-link';
  studioLink.href = STUDIO_GO_LIVE_URL;
  studioLink.target = '_blank';
  studioLink.rel = 'noopener';
  const studioHelp = el(
    doc,
    'p',
    'admin-ygl-studio-help',
    'Scan or open Studio, copy the current stream key (or the full rtmps://…/live2/… URL), then paste it below. Or create a broadcast from the signed-in YouTube account.',
  );
  studioHelp.append(studioLink);
  studio.append(qr, studioHelp);

  const phases = el(doc, 'ul', 'admin-live-phases');
  phases.id = 'ygl-phases';
  phases.setAttribute('aria-label', 'Broadcast readiness');
  for (const [id, label] of PHASES) {
    const item = el(doc, 'li', '');
    item.dataset.livePhase = id;
    item.append(el(doc, 'span', '', label), el(doc, 'strong', '', '—'));
    phases.append(item);
  }

  const form = el(doc, 'form', 'admin-live-form');
  form.id = 'ygl-form';
  form.autocomplete = 'off';

  const broadcastLabel = el(doc, 'label', 'admin-field');
  broadcastLabel.htmlFor = 'ygl-broadcast';
  broadcastLabel.append(el(doc, 'span', '', 'EXISTING BROADCAST'));
  const broadcastSelect = el(doc, 'select', '');
  broadcastSelect.id = 'ygl-broadcast';
  broadcastSelect.name = 'live-broadcast';
  const emptyOpt = el(doc, 'option', '', 'Create new or paste a Studio key');
  emptyOpt.value = '';
  broadcastSelect.append(emptyOpt);
  broadcastLabel.append(broadcastSelect);

  const titleInput = el(doc, 'input', '');
  titleInput.id = 'ygl-title';
  titleInput.type = 'text';
    titleInput.placeholder = 'Cloud Computer AI.com — live';
  const privacy = el(doc, 'select', '');
  privacy.id = 'ygl-privacy';
  for (const [value, label] of [['unlisted', 'Unlisted'], ['private', 'Private'], ['public', 'Public']]) {
    const option = el(doc, 'option', '', label);
    option.value = value;
    if (value === 'unlisted') option.selected = true;
    privacy.append(option);
  }
  const provision = el(doc, 'button', 'scene-btn', 'CREATE ON YOUTUBE');
  provision.id = 'ygl-provision';
  provision.type = 'button';

  const ingest = el(doc, 'input', '');
  ingest.id = 'ygl-ingest';
  ingest.type = 'text';
  ingest.placeholder = 'rtmp://a.rtmp.youtube.com/live2';
  const key = el(doc, 'input', '');
  key.id = 'ygl-key';
  key.type = 'password';
  key.autocomplete = 'off';
  key.placeholder = 'xxxx-xxxx-xxxx-xxxx or rtmps://…/live2/…';
  const paste = el(doc, 'button', 'scene-btn', 'PASTE KEY');
  paste.id = 'ygl-paste';
  paste.type = 'button';

  const capture = el(doc, 'input', '');
  capture.id = 'ygl-capture';
  capture.type = 'text';
  capture.placeholder = 'https://your-preview-host/';

  const start = el(doc, 'button', 'scene-btn', 'START BROADCAST');
  start.id = 'ygl-start';
  start.type = 'submit';
  const stop = el(doc, 'button', 'scene-btn', 'STOP');
  stop.id = 'ygl-stop';
  stop.type = 'button';
  stop.disabled = true;

  const grid = el(doc, 'div', 'admin-live-grid');
  const titleField = el(doc, 'label', 'admin-field');
  titleField.append(el(doc, 'span', '', 'BROADCAST TITLE'), titleInput);
  const privacyField = el(doc, 'label', 'admin-field');
  privacyField.append(el(doc, 'span', '', 'PRIVACY'), privacy);
  grid.append(titleField, privacyField, provision);

  const keyGrid = el(doc, 'div', 'admin-live-grid');
  const ingestField = el(doc, 'label', 'admin-field');
  ingestField.append(el(doc, 'span', '', 'RTMP INGEST URL'), ingest);
  const keyField = el(doc, 'label', 'admin-field');
  keyField.append(el(doc, 'span', '', 'STREAM KEY (PASTE FROM STUDIO — NEVER RETURNED)'), key);
  keyGrid.append(ingestField, keyField, paste);

  const captureField = el(doc, 'label', 'admin-field');
  captureField.append(el(doc, 'span', '', 'CAPTURE URL'), capture);

  const actions = el(doc, 'div', 'admin-live-actions');
  actions.append(start, stop);
  form.append(broadcastLabel, grid, keyGrid, captureField, actions);

  const summary = el(doc, 'p', 'admin-live-summary', 'Idle. Create or paste an ingest target to begin.');
  summary.id = 'ygl-summary';
  summary.setAttribute('role', 'status');
  const log = el(doc, 'pre', 'admin-live-log', '');
  log.id = 'ygl-log';
  log.setAttribute('aria-label', 'Encoder log');

  root.append(title, lead, row, studio, phases, form, summary, log);
  if (typeof container.replaceChildren === 'function') container.replaceChildren(root);
  else container.append?.(root);

  const state = {
    live: { status: 'idle', log: [], framesSent: 0, target: '', error: null, phases: null },
    broadcasts: [],
    watchUrl: '',
    busy: false,
    message: '',
  };
  let pollTimer = null;
  let cancelled = false;

  function valueOf(node, fallback = '') {
    return node ? String(node.value ?? '').trim() : fallback;
  }

  function ensureCapture() {
    if (!valueOf(capture)) {
      capture.value = defaultLiveCaptureUrl(globalThis.location?.origin || '');
    }
  }

  function paint() {
    const live = state.live || {};
    chip.textContent = live.phases?.youtube?.preview && live.status === 'live'
      ? 'YOUTUBE PREVIEW'
      : liveStatusLabel(live.status);
    chip.dataset.liveStatus = String(live.status || 'idle');
    start.disabled = state.busy || !canStartLive(live);
    start.textContent = live.status === 'starting' ? 'STARTING...' : 'START BROADCAST';
    stop.disabled = state.busy || canStartLive(live);
    provision.disabled = state.busy || !canStartLive(live);

    const phaseMap = live.phases || {};
    for (const rowEl of phases.querySelectorAll('[data-live-phase]')) {
      const phase = phaseMap[rowEl.dataset.livePhase] || {};
      rowEl.dataset.ready = phase.ready ? 'true' : 'false';
      const message = rowEl.querySelector('strong');
      if (message) message.textContent = phase.message || '—';
    }

    const selected = valueOf(broadcastSelect) || live.broadcast?.id || '';
    const options = [{ id: '', title: 'Create new or paste a Studio key' }, ...state.broadcasts];
    if (typeof broadcastSelect.replaceChildren === 'function') broadcastSelect.replaceChildren();
    else broadcastSelect.innerHTML = '';
    for (const item of options) {
      const option = el(doc, 'option', '', item.id
        ? `${item.lifeCycleStatus ? `${String(item.lifeCycleStatus).toUpperCase()} · ` : ''}${item.title || item.id}`
        : item.title);
      option.value = item.id || '';
      broadcastSelect.append(option);
    }
    if (selected) broadcastSelect.value = selected;

    const href = state.watchUrl || live.broadcast?.watchUrl || '';
    watch.href = href || '#';
    watch.hidden = !href;

    const parts = [];
    if (state.message) parts.push(state.message);
    if (live.target) parts.push(`PUBLISHING TO ${live.target}`);
    if (live.framesSent) parts.push(`${live.framesSent} FRAMES SENT`);
    const uptime = live.status === 'live' ? formatLiveUptime(live.startedAt) : '';
    if (uptime) parts.push(`UP ${uptime}`);
    if (live.error) parts.push(live.error);
    summary.textContent = parts.join(' · ') || 'Idle. Create or paste an ingest target to begin.';
    log.textContent = (live.log || []).join('\n');
  }

  function stopPoll() {
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  }

  function schedulePoll() {
    stopPoll();
    if (cancelled || !LIVE_POLL_STATUSES.has(String(state.live?.status || ''))) return;
    pollTimer = setTimeout(() => void refresh({ refreshBroadcasts: false }), LIVE_POLL_MS);
  }

  async function refresh({ refreshBroadcasts = true } = {}) {
    if (cancelled) return;
    ensureCapture();
    try {
      const payload = await client.liveStatus();
      state.live = payload.live || state.live;
      if (payload.live?.broadcast?.watchUrl) state.watchUrl = payload.live.broadcast.watchUrl;
      const shared = sharedLiveVideoFromSession(state.live);
      if (shared && globalThis.window) {
        globalThis.window.__gevSharedLiveVideo = shared;
      }
    } catch (error) {
      state.message = error.message;
    }
    if (refreshBroadcasts) {
      try {
        const listed = await client.listLiveBroadcasts();
        state.broadcasts = Array.isArray(listed.broadcasts) ? listed.broadcasts : [];
      } catch {
        state.broadcasts = [];
      }
    }
    paint();
    schedulePoll();
  }

  async function onProvision() {
    const titleText = valueOf(titleInput);
    if (!titleText) {
      state.message = 'Enter a broadcast title first.';
      paint();
      return;
    }
    state.busy = true;
    state.message = 'Creating the YouTube broadcast...';
    paint();
    try {
      const result = await client.provisionLive({
        title: titleText,
        privacyStatus: valueOf(privacy, 'unlisted') || 'unlisted',
      });
      if (result.live) state.live = result.live;
      if (result.broadcast?.watchUrl) state.watchUrl = result.broadcast.watchUrl;
      if (result.broadcast?.id) {
        state.broadcasts = [{
          id: result.broadcast.id,
          title: result.broadcast.title,
          privacy: result.broadcast.privacy,
          lifeCycleStatus: result.broadcast.lifeCycleStatus,
          watchUrl: result.broadcast.watchUrl,
        }, ...state.broadcasts.filter((row) => row.id !== result.broadcast.id)];
        broadcastSelect.value = result.broadcast.id;
      }
      state.message = 'Broadcast created. Start the encoder to go live.';
    } catch (error) {
      state.message = error.message;
    }
    state.busy = false;
    paint();
  }

  async function onSelect() {
    const broadcastId = valueOf(broadcastSelect);
    if (!broadcastId) return;
    state.busy = true;
    state.message = 'Loading the YouTube broadcast...';
    paint();
    try {
      const result = await client.selectLive(broadcastId);
      if (result.live) state.live = result.live;
      if (result.broadcast?.watchUrl) state.watchUrl = result.broadcast.watchUrl;
      key.value = '';
      state.message = 'Broadcast selected. Start the encoder to go live.';
    } catch (error) {
      state.message = error.message;
    }
    state.busy = false;
    paint();
  }

  async function onStart(event) {
    event?.preventDefault?.();
    state.busy = true;
    state.message = '';
    paint();
    try {
      const streamKey = valueOf(key);
      const payload = streamKey && !valueOf(broadcastSelect) && typeof client.ingestLiveKey === 'function'
        ? await client.ingestLiveKey({
          streamKey,
          ingestUrl: valueOf(ingest),
          captureUrl: valueOf(capture) || defaultLiveCaptureUrl(globalThis.location?.origin || ''),
        })
        : await client.startLive(buildAdminLiveStartBody({
          broadcastId: valueOf(broadcastSelect),
          captureUrl: valueOf(capture) || defaultLiveCaptureUrl(globalThis.location?.origin || ''),
          ingestUrl: valueOf(ingest),
          streamKey,
        }));
      state.live = payload.live || state.live;
      if (payload.live?.broadcast?.watchUrl) state.watchUrl = payload.live.broadcast.watchUrl;
      if (!canStartLive(state.live)) key.value = '';
    } catch (error) {
      state.message = error.message;
      if (error.payload?.live) state.live = error.payload.live;
    }
    state.busy = false;
    paint();
    schedulePoll();
  }

  async function onStop() {
    state.busy = true;
    paint();
    try {
      const payload = await client.stopLive();
      state.live = payload.live || state.live;
    } catch (error) {
      state.message = error.message;
    }
    state.busy = false;
    stopPoll();
    paint();
  }

  async function onPaste() {
    try {
      const text = await globalThis.navigator?.clipboard?.readText?.();
      const trimmed = String(text || '').trim();
      if (trimmed.length < 4) {
        state.message = 'Clipboard does not have a stream key.';
        paint();
        return;
      }
      key.value = trimmed;
    } catch {
      state.message = 'Allow clipboard access, or paste the key into the field.';
      paint();
    }
  }

  form.addEventListener('submit', onStart);
  stop.addEventListener('click', onStop);
  provision.addEventListener('click', onProvision);
  broadcastSelect.addEventListener('change', onSelect);
  paste.addEventListener('click', onPaste);

  const api = {
    refresh,
    getLive: () => state.live,
    sharedVideo: () => sharedLiveVideoFromSession(state.live),
  };
  try {
    container.__gevYoutubeGoLive = api;
    if (globalThis.window) globalThis.window.__gevYoutubeGoLive = api;
  } catch { /* tests */ }

  void refresh();

  return () => {
    cancelled = true;
    stopPoll();
    form.removeEventListener?.('submit', onStart);
    stop.removeEventListener?.('click', onStop);
    provision.removeEventListener?.('click', onProvision);
    broadcastSelect.removeEventListener?.('change', onSelect);
    paste.removeEventListener?.('click', onPaste);
    try {
      if (container.__gevYoutubeGoLive === api) delete container.__gevYoutubeGoLive;
      if (globalThis.window?.__gevYoutubeGoLive === api) delete globalThis.window.__gevYoutubeGoLive;
    } catch { /* tests */ }
    if (typeof container.replaceChildren === 'function') container.replaceChildren();
  };
}

const youtubeGoLivePlugin = {
  id: YOUTUBE_GO_LIVE_PLUGIN_ID,
  label: YOUTUBE_GO_LIVE_LABEL,
  description: 'Publish the globe to YouTube Live from an authenticated ADMIN session.',
  render: renderYoutubeGoLivePane,
};

export default youtubeGoLivePlugin;
