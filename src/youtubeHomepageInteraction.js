import { PUBLIC_HELP_REPLY } from './youtubePublicCommandPolicy.js';
import { contextualFollowUps, formatUtcTime, FOLLOW_UP_WINDOW_MS } from './voice/nextchat.js';

/** Browser wait for local /feed memory. Not the YouTube InnerTube interval. */
export const MEMORY_POLL_LIVE_MS = 800;
export const MEMORY_POLL_HIDDEN_MS = 5_000;
export const MEMORY_POLL_IDLE_MS = 8_000;
export const MIN_POLL_MS = MEMORY_POLL_LIVE_MS;
export const MAX_POLL_MS = 30_000;
const GLOBAL_ACTION_COOLDOWN_MS = 45_000;
const VIEWER_ACTION_COOLDOWN_MS = 90_000;
const MAX_SEEN = 500;
const MAX_PENDING_ACTIONS = 20;

const MAX_PANEL_COMMENTS = 100;
/** Visible rows that fit a 720p public frame without clipping mid-comment. */
export const MAX_VISIBLE_COMMENTS = 14;
export const MAX_VISIBLE_ACTIONS = 14;

export function formatFollowUpCountdown(remainingMs) {
  const seconds = Math.max(0, Math.ceil(Number(remainingMs || 0) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function appendAgentCta(replyRow, comment, documentRef, currentTime) {
  const state = String(comment?.replyState || '');
  if (state !== 'succeeded' && state !== 'replied' && state !== 'validated') return;
  const cta = documentRef.createElement('span');
  cta.className = 'youtube-agent-cta';
  const remaining = Number(comment.followUpExpiresAt || 0) - currentTime;
  cta.textContent = remaining > 0
    ? `REPLY TO ASK: ${(comment.followUpOptions || []).join(' · ')}`
    : 'FOLLOW-UP WINDOW EXPIRED';
  if (remaining > 0 && remaining <= 30_000) cta.classList?.add?.('youtube-agent-cta-urgent');
  replyRow.append(cta);
}

function isConversationActive(comment, currentTime) {
  const state = String(comment?.replyState || 'display');
  if (['pending', 'interpreting', 'received', 'awaiting-execution', 'executing', 'awaiting-model'].includes(state)) return true;
  return ['succeeded', 'replied', 'validated'].includes(state)
    && Number(comment?.followUpExpiresAt || 0) > currentTime;
}

function appendCommentBody(row, comment, documentRef) {
  const meta = documentRef.createElement('span');
  meta.className = 'youtube-feed-meta';
  meta.textContent = `${comment.authorHandle || comment.author}${formatUtcTime(comment.publishedAt) ? ` · ${formatUtcTime(comment.publishedAt)}` : ''}`;
  const body = documentRef.createElement('span');
  body.className = 'youtube-feed-text';
  body.textContent = comment.text;
  row.append(meta, body);
}

function appendConversationReply(row, comment, documentRef, currentTime) {
  const replyRow = documentRef.createElement('div');
  replyRow.className = 'youtube-agent-reply';
  const state = String(comment.replyState || 'display');
  const processing = ['interpreting', 'pending', 'received', 'awaiting-execution', 'executing', 'awaiting-model'].includes(state);
  const remaining = Number(comment.followUpExpiresAt || 0) - currentTime;
  if (!processing && remaining > 0) {
    const countdown = documentRef.createElement('div');
    countdown.className = `youtube-followup-countdown${remaining <= 30_000 ? ' is-urgent' : ''}`;
    const countdownValue = documentRef.createElement('span');
    countdownValue.className = 'youtube-followup-countdown-value';
    countdownValue.textContent = formatFollowUpCountdown(remaining);
    const countdownLabel = documentRef.createElement('span');
    countdownLabel.className = 'youtube-followup-countdown-label';
    countdownLabel.textContent = 'TIME LEFT TO REPLY';
    countdown.append(countdownValue, countdownLabel);
    replyRow.append(countdown);
  }
  const turn = documentRef.createElement('span');
  turn.className = `youtube-conversation-turn ${processing ? 'is-agent-turn' : 'is-viewer-turn'}`;
  turn.textContent = processing
    ? "CLOUD COMPUTER AI.COM'S TURN"
    : `${comment.authorHandle || comment.author || 'VIEWER'}'S TURN`;
  const replyWho = documentRef.createElement('span');
  replyWho.className = 'youtube-agent-role';
  replyWho.textContent = `CLOUD COMPUTER AI.COM REPLY${formatUtcTime(comment.replyAt) ? ` · ${formatUtcTime(comment.replyAt)}` : ''}`;
  const label = documentRef.createElement('span');
  label.className = `youtube-agent-state youtube-agent-state-${state}`;
  const stateLabel = processing
    ? 'INTERPRETING'
    : state === 'replied' ? 'REPLIED'
    : state === 'failed' ? 'FAILED'
    : state === 'rejected' ? 'REJECTED'
    : state === 'display' ? ''
    : state.toUpperCase();
  label.textContent = stateLabel;
  const replyBody = documentRef.createElement('span');
  replyBody.className = 'youtube-feed-text youtube-agent-text';
  replyBody.textContent = comment.replyText || (processing ? 'Interpreting request...' : '');
  replyRow.append(turn, replyWho);
  if (stateLabel) replyRow.append(label);
  replyRow.append(replyBody);
  appendAgentCta(replyRow, comment, documentRef, currentTime);
  row.append(replyRow);
}


function clampPoll(value) {
  const number = Number(value);
  return Math.max(MIN_POLL_MS, Math.min(MAX_POLL_MS, Number.isFinite(number) ? number : MIN_POLL_MS));
}

/**
 * Browser /feed cadence. Never uses ingestPollingIntervalMillis (YouTube worker).
 *
 * @param {object} payload
 * @param {{hidden?: boolean}} [options]
 * @returns {number}
 */
export function memoryPollDelay(payload, { hidden = false } = {}) {
  if (hidden) return MEMORY_POLL_HIDDEN_MS;
  const status = String(payload?.status || '');
  if (payload?.active === true && status === 'live') {
    return clampPoll(payload.pollingIntervalMillis || MEMORY_POLL_LIVE_MS);
  }
  if (status === 'connecting') return 1_000;
  return MEMORY_POLL_IDLE_MS;
}

function safeText(value, max = 160) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

function safeStreamUrl(value) {
  const candidate = safeText(value, 240);
  if (!candidate) return '';
  try {
    const parsed = new URL(candidate);
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : '';
  } catch {
    return '';
  }
}

function summarizeActionResults(actions, actionResults) {
  const completed = Array.isArray(actionResults) ? actionResults : [];
  const navigation = completed.findLast?.((item) => item.action === 'fly_to_location');
  const destination = navigation?.result?.destination
    || navigation?.result?.label
    || navigation?.args?.query;
  const mode = navigation?.result?.viewMode
    || navigation?.result?.mode
    || navigation?.args?.viewMode;
  const layers = completed
    .filter((item) => item.action === 'set_layer_visibility' && item.args?.enabled !== false)
    .map((item) => item.result?.label || item.args?.layerId)
    .filter(Boolean);
  if (destination) {
    return `I NAVIGATED TO ${safeText(destination, 100).toUpperCase()}${mode ? ` · ${safeText(mode, 32).toUpperCase()} VIEW` : ''}${layers.length ? ` · ${layers.join(', ').toUpperCase()} ON` : ''}`;
  }
  if (layers.length) return `I ENABLED ${layers.join(', ').toUpperCase()}`;
  const last = completed.at(-1);
  const outcome = last?.result?.message || last?.result?.label || last?.action || actions?.at?.(-1)?.action;
  return outcome ? `I UPDATED THE VIEW · ${safeText(outcome, 120).toUpperCase()}` : 'I UPDATED THE VIEW';
}

export function createYoutubeHomepageInteraction({
  fetchImpl = globalThis.fetch,
  nextchat = null,
  runner = null,
  getViewContext = null,
  documentRef = globalThis.document,
  now = Date.now,
  clock = globalThis,
} = {}) {
  let actionRunner = typeof runner === 'function' ? runner : null;
  let timer = null;
  let stopped = false;
  let continuation = '';
  let videoId = '';
  let generation = 0;
  let commandsEnabled = false;
  let executorBusy = false;
  let lastActionAt = 0;
  const viewerLastActionAt = new Map();
  const seen = new Set();
  const pendingActions = [];
  const commandStates = new Map();
  const liveComments = [];
  let broadcastTitle = '';
  const badge = documentRef?.getElementById?.('gev-nextchat-live-badge') || null;
  const ticker = documentRef?.getElementById?.('live-news-ticker') || null;
  const tickerUrl = documentRef?.getElementById?.('live-news-ticker-url') || null;


  function commentsPanelEls() {
    const root = documentRef?.getElementById?.('youtube-comments-panel');
    if (!root) return null;
    return {
      root,
      list: root.querySelector('#youtube-comments-list'),
      progressList: root.querySelector('#youtube-progress-list'),
      progressStatus: root.querySelector('#youtube-progress-status'),
      progressCount: root.querySelector('#youtube-progress-count'),
      status: root.querySelector('#youtube-comments-status'),
      subject: root.querySelector('#youtube-comments-video'),
      count: root.querySelector('#youtube-comments-count'),
      refresh: root.querySelector('#youtube-comments-refresh'),
      more: root.querySelector('#youtube-comments-more'),
    };
  }

  function renderLiveCommentsPanel({ active = false, title = '', videoId: liveVideoId = '' } = {}) {
    const els = commentsPanelEls();
    if (!els) return;
    if (!active) {
      delete els.root.dataset.liveHomepage;
      liveComments.length = 0;
      if (els.subject) els.subject.textContent = 'NO VIDEO SELECTED';
      if (els.status) els.status.textContent = 'CONNECT YOUTUBE TO LOAD COMMENTS';
      if (els.count) els.count.textContent = '0';
      if (els.progressCount) els.progressCount.textContent = '0';
      if (els.progressStatus) els.progressStatus.textContent = 'NO CONVERSATIONS IN PROGRESS';
      if (els.refresh) els.refresh.disabled = true;
      if (els.more) els.more.disabled = true;
      if (els.list) {
        els.list.replaceChildren();
        const empty = documentRef.createElement('li');
        empty.className = 'youtube-feed-empty';
        empty.textContent = 'CONNECT YOUTUBE TO LOAD COMMENTS';
        els.list.append(empty);
      }
      els.progressList?.replaceChildren?.();
      return;
    }
    els.root.dataset.liveHomepage = '1';
    const heading = safeText(title || liveVideoId || 'LIVE', 100);
    if (els.subject) els.subject.textContent = `${heading} · LIVE`;
    if (els.status) {
      els.status.textContent = liveComments.length
        ? `${liveComments.length} LIVE COMMENT${liveComments.length === 1 ? '' : 'S'}`
        : 'YT LIVE · waiting for comments';
    }
    if (els.count) els.count.textContent = String(liveComments.length);
    if (els.refresh) els.refresh.disabled = true;
    if (els.more) els.more.disabled = true;
    if (!els.list) return;
    els.list.replaceChildren();
    if (!liveComments.length) {
      const empty = documentRef.createElement('li');
      empty.className = 'youtube-feed-empty';
      empty.textContent = 'YT LIVE · waiting for comments';
      els.list.append(empty);
      if (els.progressCount) els.progressCount.textContent = '0';
      if (els.progressStatus) els.progressStatus.textContent = 'NO CONVERSATIONS IN PROGRESS';
      if (els.progressList) {
        els.progressList.replaceChildren();
        const progressEmpty = documentRef.createElement('li');
        progressEmpty.className = 'youtube-feed-empty youtube-progress-empty';
        progressEmpty.textContent = 'WAITING FOR A VIEWER REQUEST';
        els.progressList.append(progressEmpty);
      }
      return;
    }
    const chronological = [...liveComments].sort((a, b) => {
      const ta = Date.parse(a.publishedAt) || 0;
      const tb = Date.parse(b.publishedAt) || 0;
      return ta - tb;
    });
    const visibleComments = [...chronological].reverse();
    for (const comment of visibleComments) {
      const row = documentRef.createElement('li');
      row.className = 'youtube-feed-item youtube-comment-thread';
      appendCommentBody(row, comment, documentRef);
      els.list.append(row);
    }
    if (!els.progressList) return;
    els.progressList.replaceChildren();
    const currentTime = now();
    const activeConversations = chronological
      .filter((comment) => isConversationActive(comment, currentTime))
      .sort((a, b) => {
        const aProcessing = ['pending', 'interpreting', 'received', 'awaiting-execution', 'executing', 'awaiting-model'].includes(String(a.replyState));
        const bProcessing = ['pending', 'interpreting', 'received', 'awaiting-execution', 'executing', 'awaiting-model'].includes(String(b.replyState));
        if (aProcessing !== bProcessing) return aProcessing ? -1 : 1;
        return (Number(a.followUpExpiresAt || 0) || Date.parse(a.publishedAt) || 0)
          - (Number(b.followUpExpiresAt || 0) || Date.parse(b.publishedAt) || 0);
      })
      .slice(0, MAX_VISIBLE_ACTIONS);
    if (els.progressCount) els.progressCount.textContent = String(activeConversations.length);
    if (els.progressStatus) {
      els.progressStatus.textContent = activeConversations.length
        ? `${activeConversations.length} ACTIVE CONVERSATION${activeConversations.length === 1 ? '' : 'S'}`
        : 'NO CONVERSATIONS IN PROGRESS';
    }
    if (!activeConversations.length) {
      const empty = documentRef.createElement('li');
      empty.className = 'youtube-feed-empty youtube-progress-empty';
      empty.textContent = 'WAITING FOR A VIEWER REQUEST';
      els.progressList.append(empty);
      return;
    }
    for (const comment of activeConversations) {
      const row = documentRef.createElement('li');
      row.className = 'youtube-feed-item youtube-comment-thread youtube-active-conversation';
      appendConversationReply(row, comment, documentRef, currentTime);
      appendCommentBody(row, comment, documentRef);
      els.progressList.append(row);
    }
  }

  function notifyAgentReply(payload) {
    nextchat?.updateAgentReply?.(payload);
    const id = safeText(payload?.commentId, 160);
    if (!id) return;
    const row = liveComments.find((item) => item.id === id);
    if (!row) return;
    if (payload.replyState) row.replyState = String(payload.replyState);
    if (payload.replyText != null && payload.replyText !== '') {
      row.replyText = safeText(payload.replyText, 240);
    } else if (row.replyState === 'interpreting' || row.replyState === 'pending') {
      row.replyText = row.replyText || 'Interpreting request...';
    }
    row.replyAt = safeText(payload?.replyAt || new Date(now()).toISOString(), 40);
    row.actions = Array.isArray(payload?.actions) ? payload.actions : (row.actions || []);
    row.actionResult = payload?.actionResult ?? row.actionResult;
    if (row.replyState === 'replied' || row.replyState === 'succeeded' || row.replyState === 'validated') {
      row.followUpOptions = contextualFollowUps(row);
      row.followUpExpiresAt ||= now() + FOLLOW_UP_WINDOW_MS;
    }
    renderLiveCommentsPanel({ active: true, title: broadcastTitle, videoId });
  }

  function setStatus(message, state = '') {
    nextchat?.setHarnessStatus?.(safeText(message, 200));
    if (badge) {
      badge.textContent = state === 'live' ? 'YT LIVE' : state === 'error' ? 'YT ERROR' : 'YT OFFLINE';
      badge.dataset.state = state || 'offline';
      badge.hidden = false;
    }
  }

  async function readViewContext() {
    if (typeof getViewContext !== 'function') return {};
    try {
      const context = await getViewContext();
      return context && typeof context === 'object' ? context : {};
    } catch {
      return {};
    }
  }

  function setTickerUrl(value, active = false) {
    if (!tickerUrl) return;
    const url = safeStreamUrl(value);
    if (url) {
      tickerUrl.href = url;
      tickerUrl.textContent = url;
      tickerUrl.removeAttribute('aria-disabled');
      ticker?.setAttribute?.('data-state', 'live');
      return;
    }

    tickerUrl.removeAttribute('href');
    tickerUrl.textContent = active ? 'CURRENT STREAM URL PENDING' : 'STREAM OFFLINE';
    tickerUrl.setAttribute('aria-disabled', 'true');
    ticker?.setAttribute?.('data-state', active ? 'pending' : 'offline');
  }

  function remember(id) {
    seen.add(id);
    while (seen.size > MAX_SEEN) seen.delete(seen.values().next().value);
  }

  function dismissFirstRunLauncher() {
    const launcher = documentRef?.getElementById?.('first-run-launcher');
    if (!launcher || launcher.hidden || !launcher.classList?.contains?.('visible')) return;
    launcher.querySelector?.('[data-first-run-choice="explore"]')?.click?.();
  }

  async function applyMessageActions(message) {
    const actions = Array.isArray(message.actions) ? message.actions : [];
    if (!actions.length) return;
    if (!actionRunner) {
      pendingActions.push(message);
      while (pendingActions.length > MAX_PENDING_ACTIONS) pendingActions.shift();
      setStatus(`YT LIVE · ${safeText(message.author, 80) || 'Viewer'} request queued until globe is ready`, 'live');
      return;
    }
    const current = now();
    const viewer = safeText(message.author, 80) || 'Viewer';
    if ((current - lastActionAt) < GLOBAL_ACTION_COOLDOWN_MS
      || (current - (viewerLastActionAt.get(viewer) || 0)) < VIEWER_ACTION_COOLDOWN_MS) {
      setStatus(`YT LIVE · ${viewer} request skipped during camera cooldown`, 'live');
      return;
    }
    lastActionAt = current;
    viewerLastActionAt.set(viewer, current);
    setStatus(`YT LIVE · applying ${viewer}'s view request`, 'live');
    dismissFirstRunLauncher();
    const actionResults = [];
    for (const intent of actions) {
      try {
        const args = intent.action === 'fly_to_location'
          ? { ...(intent.args || {}), waitForArrival: true }
          : (intent.args || {});
        const result = await actionRunner(intent.action, args, {
          isCurrent: () => !stopped && message.videoId === videoId,
        });
        actionResults.push({ action: intent.action, args, result });
        if (result?.ok === false) {
          setStatus(`YT LIVE · request rejected: ${safeText(result.error || result.reason || 'view unavailable', 100)}`, 'live');
          notifyAgentReply({
            commentId: safeText(message.id, 160),
            videoId: safeText(message.videoId, 80),
            generation,
            replyState: 'failed',
            replyText: safeText(result.error || result.reason || 'view unavailable', 180),
          });
          return;
        }
      } catch (error) {
        setStatus(`YT LIVE · view request failed: ${safeText(error?.message || 'unavailable', 100)}`, 'error');
        notifyAgentReply({
          commentId: safeText(message.id, 160),
          videoId: safeText(message.videoId, 80),
          generation,
          replyState: 'failed',
          replyText: safeText(error?.message || 'unavailable', 180),
        });
        return;
      }
    }
    const destination = actions.findLast?.((action) => action.action === 'fly_to_location')?.args?.query
      || actions.at?.(-1)?.action
      || 'view';
    setStatus(`YT LIVE · showing ${safeText(destination, 100)} for ${viewer}`, 'live');
    notifyAgentReply({
      commentId: safeText(message.id, 160),
      videoId: safeText(message.videoId, 80),
      generation,
      replyState: 'replied',
      replyText: summarizeActionResults(actions, actionResults),
      actions,
      actionResult: actionResults,
      replyAt: new Date(now()).toISOString(),
      address: false,
    });
  }

  async function ingest(items) {
    for (const message of items || []) {
      const id = `${safeText(message.videoId, 80)}:${safeText(message.id, 160)}`;
      if (!message.id || seen.has(id)) continue;
      remember(id);
      const actions = Array.isArray(message.actions) ? message.actions : [];
      const agentRequested = Boolean(message.agentMode);
      nextchat?.publishViewerMessage?.({
        author: safeText(message.author, 80) || 'YouTube viewer',
        authorHandle: safeText(message.authorHandle, 80),
        text: safeText(message.text, 500),
        metadata: {
          source: 'youtube',
          commentId: safeText(message.id, 160),
          videoId: safeText(message.videoId, 80),
          generation,
          receivedAt: safeText(message.publishedAt, 40),
          actionState: actions.length || agentRequested ? 'interpreting' : 'chat',
          actionCount: actions.length,
        },
      });
      nextchat?.upsertLiveComment?.({
        commentId: safeText(message.id, 160),
        videoId: safeText(message.videoId, 80),
        generation,
        author: safeText(message.author, 80) || 'YouTube viewer',
        authorHandle: safeText(message.authorHandle, 80),
        text: safeText(message.text, 500),
        receivedAt: safeText(message.publishedAt, 40),
        replyState: actions.length || agentRequested ? 'interpreting' : 'display',
        actionCount: actions.length,
      });
      liveComments.unshift({
        id: safeText(message.id, 160),
        author: safeText(message.author, 80) || 'YouTube viewer',
        authorHandle: safeText(message.authorHandle, 80),
        text: safeText(message.text, 500),
        publishedAt: safeText(message.publishedAt, 40),
        replyState: actions.length || agentRequested ? 'interpreting' : 'display',
        replyAt: actions.length || agentRequested ? new Date(now()).toISOString() : '',
      });
      while (liveComments.length > MAX_PANEL_COMMENTS) liveComments.pop();
      await applyMessageActions(message);
    }
    renderLiveCommentsPanel({ active: true, title: broadcastTitle, videoId });
  }

  function publishCommandStatuses(commands) {
    for (const command of commands || []) {
      const id = safeText(command.id, 160);
      const state = safeText(command.state, 32);
      if (!id || !state || commandStates.get(id) === state) continue;
      commandStates.set(id, state);
      while (commandStates.size > 100) commandStates.delete(commandStates.keys().next().value);
      const slash = safeText(command.command, 32);
      const commentId = safeText(command.commentId, 160);
      const commandVideoId = safeText(command.videoId, 80);
      const commandGeneration = Math.max(0, Number(command.generation) || generation);
      if (slash === '/help' && state === 'succeeded') {
        const answer = safeText(command.answer, 1000) || PUBLIC_HELP_REPLY;
        if (typeof nextchat?.typeActionReply === 'function') {
          nextchat.typeActionReply(answer, {
            commentId,
            videoId: commandVideoId,
            generation: commandGeneration,
            author: safeText(command.viewer, 80),
            authorHandle: safeText(command.authorHandle, 80),
            actionState: 'succeeded',
          });
          notifyAgentReply({
            commentId,
            videoId: commandVideoId,
            generation: commandGeneration,
            replyState: 'replied',
            replyText: answer,
          });
        } else {
          notifyAgentReply({
            commentId,
            videoId: commandVideoId,
            generation: commandGeneration,
            replyState: 'replied',
            replyText: answer,
            actionState: 'succeeded',
          });
        }
        continue;
      }
      const detail = safeText(command.answer || command.reason, 180);
      notifyAgentReply({
        commentId,
        videoId: commandVideoId,
        generation: commandGeneration,
        replyState: state,
        actionState: state,
        replyText: `${slash || 'command'} · ${state}${detail ? ` · ${detail}` : ''}`,
        address: state === 'succeeded' || state === 'validated',
      });
    }
  }

  async function drainCaptureExecutor() {
    if (executorBusy || !commandsEnabled || !actionRunner || globalThis.__GEV_CAPTURE_EXECUTOR__ !== true) return;
    executorBusy = true;
    try {
      const response = await fetchImpl('/api/youtube/homepage-chat/executor/lease', {
        method: 'GET',
        headers: { Accept: 'application/json' },
        credentials: 'same-origin',
      });
      if (!response.ok) return;
      const payload = await response.json().catch(() => ({}));
      const lease = payload?.lease;
      if (!lease?.commandId || Number(lease.generation) !== generation || safeText(lease.videoId, 80) !== videoId) return;
      const tool = lease.tool || {};
      let result;
      try {
        const output = await actionRunner(tool.name, tool.arguments || {}, {
          isCurrent: () => !stopped
            && commandsEnabled
            && Number(lease.generation) === generation
            && safeText(lease.videoId, 80) === videoId,
        });
        result = output && typeof output === 'object' ? output : { ok: true };
      } catch (error) {
        result = { ok: false, error: safeText(error?.message || 'GEV action failed', 160) };
      }
      await fetchImpl('/api/youtube/homepage-chat/executor/result', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          commandId: lease.commandId,
          captureEpoch: lease.captureEpoch,
          result,
        }),
      });
    } finally {
      executorBusy = false;
    }
  }

  async function drainViewerAgent() {
    if (
      executorBusy
      || !commandsEnabled
      || !actionRunner
      || globalThis.__GEV_CAPTURE_EXECUTOR__ === true
    ) return;
    executorBusy = true;
    try {
      const response = await fetchImpl('/api/youtube/homepage-chat/agent/lease', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ viewContext: await readViewContext() }),
      });
      if (!response.ok) return;
      const payload = await response.json().catch(() => ({}));
      const lease = payload?.lease;
      if (!lease?.commandId || Number(lease.generation) !== generation || safeText(lease.videoId, 80) !== videoId) return;
      const tool = lease.tool || {};
      let result;
      try {
        const output = await actionRunner(tool.name, tool.arguments || {}, {
          isCurrent: () => !stopped
            && commandsEnabled
            && Number(lease.generation) === generation
            && safeText(lease.videoId, 80) === videoId,
        });
        result = output && typeof output === 'object' ? output : { ok: true };
      } catch (error) {
        result = { ok: false, error: safeText(error?.message || 'GEV action failed', 160) };
      }
      await fetchImpl('/api/youtube/homepage-chat/agent/result', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          commandId: lease.commandId,
          nonce: lease.nonce,
          result,
          viewContext: await readViewContext(),
        }),
      });
    } finally {
      executorBusy = false;
    }
  }

  async function poll() {
    if (stopped) return;
    let delay = MIN_POLL_MS;
    try {
      const query = continuation ? `?continuation=${encodeURIComponent(continuation)}` : '';
      const response = await fetchImpl(`/api/youtube/homepage-chat/feed${query}`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        credentials: 'same-origin',
      });
      const payload = await response.json().catch(() => ({}));
      const hidden = Boolean(documentRef?.hidden) || documentRef?.visibilityState === 'hidden';
      delay = memoryPollDelay(payload, { hidden });
      if (!response.ok) throw new Error(payload?.error?.message || 'YouTube live chat unavailable');
      if (!payload.active) {
        continuation = '';
        videoId = '';
        generation = 0;
        commandsEnabled = false;
        seen.clear();
        commandStates.clear();
        nextchat?.setLiveBroadcast?.({ videoId: '', generation: 0 });
        const feedStatus = safeText(payload.status, 40);
        const errorText = safeText(payload.error?.message, 160);
        if (feedStatus === 'connecting') {
          setTickerUrl(payload.watchUrl, true);
          setStatus('YT LIVE · connecting to YouTube chat', 'live');
        } else {
          broadcastTitle = '';
          renderLiveCommentsPanel({ active: false });
          setTickerUrl('', false);
          const state = ['ended', 'unavailable', 'unauthenticated', 'error'].includes(feedStatus)
            ? 'error'
            : 'offline';
          setStatus(
            errorText
              ? `YT chat unavailable · ${errorText}`
              : feedStatus === 'unauthenticated'
                ? 'YT chat unavailable · YouTube sign-in required'
                : feedStatus === 'ended'
                  ? 'YT chat unavailable · This live broadcast has ended.'
                  : 'YT chat is waiting for an active broadcast',
            state,
          );
        }
      } else {
        const nextVideoId = safeText(payload.videoId, 80);
        const nextGeneration = Math.max(0, Number(payload.generation) || 0);
        if ((videoId && nextVideoId !== videoId) || (generation && nextGeneration !== generation)) {
          continuation = '';
          seen.clear();
          viewerLastActionAt.clear();
          lastActionAt = 0;
          commandStates.clear();
          liveComments.length = 0;
        }
        videoId = nextVideoId;
        generation = nextGeneration;
        broadcastTitle = safeText(payload.title, 100);
        const channelHandle = safeText(payload.channelHandle, 80);
        nextchat?.setLiveBroadcast?.({ videoId, generation });
        commandsEnabled = payload.commandsEnabled === true;
        continuation = safeText(payload.nextPageToken, 4096) || continuation;
        setTickerUrl(payload.watchUrl, true);
        setStatus(
          `YT LIVE · ${channelHandle ? `${channelHandle} · ` : ''}showing every comment from ${safeText(payload.title || videoId, 100)}`,
          'live',
        );
        await ingest(payload.items || []);
        publishCommandStatuses(payload.commands || []);
        await drainViewerAgent();
        await drainCaptureExecutor();
      }
    } catch (error) {
      delay = 10_000;
      commandsEnabled = false;
      setTickerUrl('', false);
      setStatus(`YT chat unavailable · ${safeText(error?.message || 'retrying', 120)}`, 'error');
    } finally {
      if (!stopped) timer = clock.setTimeout(() => void poll(), delay);
    }
  }

  return {
    start() {
      if (stopped) stopped = false;
      if (timer == null) void poll();
    },
    stop() {
      stopped = true;
      if (timer != null) clock.clearTimeout(timer);
      timer = null;
      continuation = '';
      generation = 0;
      commandsEnabled = false;
      commandStates.clear();
    },
    setRunner(nextRunner) {
      actionRunner = typeof nextRunner === 'function' ? nextRunner : null;
      if (actionRunner && pendingActions.length) {
        const queued = pendingActions.splice(0, pendingActions.length);
        void (async () => {
          for (const message of queued) await applyMessageActions(message);
        })();
      }
    },
    ingest,
    publishCommandStatuses,
    getState() {
      return {
        videoId,
        generation,
        continuation,
        seen: seen.size,
        pendingActions: pendingActions.length,
        runnerReady: Boolean(actionRunner),
        running: !stopped,
      };
    },
  };
}

export function initYoutubeHomepageInteraction(options = {}) {
  const interaction = createYoutubeHomepageInteraction(options);
  interaction.start();
  return interaction;
}