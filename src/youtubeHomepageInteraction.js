import { PUBLIC_HELP_REPLY } from './youtubePublicCommandPolicy.js';

/** Browser wait for local /feed memory. Not the YouTube InnerTube interval. */
export const MEMORY_POLL_LIVE_MS = 800;
export const MEMORY_POLL_HIDDEN_MS = 5_000;
export const MEMORY_POLL_IDLE_MS = 8_000;
export const MIN_POLL_MS = MEMORY_POLL_LIVE_MS;
export const MAX_POLL_MS = 30_000;
const GLOBAL_ACTION_COOLDOWN_MS = 4_000;
const VIEWER_ACTION_COOLDOWN_MS = 8_000;
const MAX_SEEN = 500;
const MAX_PENDING_ACTIONS = 20;

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
  const badge = documentRef?.getElementById?.('gev-nextchat-live-badge') || null;
  const ticker = documentRef?.getElementById?.('live-news-ticker') || null;
  const tickerUrl = documentRef?.getElementById?.('live-news-ticker-url') || null;

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
    for (const intent of actions) {
      try {
        const args = intent.action === 'fly_to_location'
          ? { ...(intent.args || {}), waitForArrival: true }
          : (intent.args || {});
        const result = await actionRunner(intent.action, args, {
          isCurrent: () => !stopped && message.videoId === videoId,
        });
        if (result?.ok === false) {
          setStatus(`YT LIVE · request rejected: ${safeText(result.error || result.reason || 'view unavailable', 100)}`, 'live');
          nextchat?.updateAgentReply?.({
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
        nextchat?.updateAgentReply?.({
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
    nextchat?.updateAgentReply?.({
      commentId: safeText(message.id, 160),
      videoId: safeText(message.videoId, 80),
      generation,
      replyState: 'replied',
      replyText: `showing ${safeText(destination, 100)}`,
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
        replyState: actions.length || agentRequested ? 'interpreting' : 'display',
        actionCount: actions.length,
      });
      await applyMessageActions(message);
    }
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
        } else {
          nextchat?.updateAgentReply?.({
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
      nextchat?.updateAgentReply?.({
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
        }
        videoId = nextVideoId;
        generation = nextGeneration;
        nextchat?.setLiveBroadcast?.({ videoId, generation });
        commandsEnabled = payload.commandsEnabled === true;
        continuation = safeText(payload.nextPageToken, 4096) || continuation;
        setTickerUrl(payload.watchUrl, true);
        setStatus(`YT LIVE · showing every comment from ${safeText(payload.title || videoId, 100)}`, 'live');
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