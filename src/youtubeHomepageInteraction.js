const MIN_POLL_MS = 5_000;
const MAX_POLL_MS = 30_000;
const GLOBAL_ACTION_COOLDOWN_MS = 4_000;
const VIEWER_ACTION_COOLDOWN_MS = 8_000;
const MAX_SEEN = 500;
const MAX_PENDING_ACTIONS = 20;

function clampPoll(value) {
  const number = Number(value);
  return Math.max(MIN_POLL_MS, Math.min(MAX_POLL_MS, Number.isFinite(number) ? number : MIN_POLL_MS));
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
  documentRef = globalThis.document,
  now = Date.now,
  clock = globalThis,
} = {}) {
  let actionRunner = typeof runner === 'function' ? runner : null;
  let timer = null;
  let stopped = false;
  let continuation = '';
  let videoId = '';
  let lastActionAt = 0;
  const viewerLastActionAt = new Map();
  const seen = new Set();
  const pendingActions = [];
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
          return;
        }
      } catch (error) {
        setStatus(`YT LIVE · view request failed: ${safeText(error?.message || 'unavailable', 100)}`, 'error');
        return;
      }
    }
    const destination = actions.findLast?.((action) => action.action === 'fly_to_location')?.args?.query
      || actions.at?.(-1)?.action
      || 'view';
    setStatus(`YT LIVE · showing ${safeText(destination, 100)} for ${viewer}`, 'live');
  }

  async function ingest(items) {
    for (const message of items || []) {
      const id = `${safeText(message.videoId, 80)}:${safeText(message.id, 160)}`;
      if (!message.id || seen.has(id)) continue;
      remember(id);
      nextchat?.publishViewerMessage?.({
        author: safeText(message.author, 80) || 'YouTube viewer',
        text: safeText(message.text, 500),
        metadata: {
          source: 'youtube',
          commentId: safeText(message.id, 160),
          videoId: safeText(message.videoId, 80),
          receivedAt: safeText(message.publishedAt, 40),
        },
      });
      await applyMessageActions(message);
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
      delay = clampPoll(payload.pollingIntervalMillis);
      if (!response.ok) throw new Error(payload?.error?.message || 'YouTube live chat unavailable');
      if (!payload.active) {
        continuation = '';
        videoId = '';
        seen.clear();
        setTickerUrl('', false);
        setStatus('YT chat is waiting for an active broadcast', 'offline');
      } else {
        const nextVideoId = safeText(payload.videoId, 80);
        if (videoId && nextVideoId !== videoId) {
          continuation = '';
          seen.clear();
          viewerLastActionAt.clear();
          lastActionAt = 0;
        }
        videoId = nextVideoId;
        continuation = safeText(payload.nextPageToken, 4096) || continuation;
        setTickerUrl(payload.watchUrl, true);
        setStatus(`YT LIVE · ${safeText(payload.title || videoId, 100)} · viewer comments control this globe`, 'live');
        await ingest(payload.items || []);
      }
    } catch (error) {
      delay = 10_000;
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
    getState() {
      return {
        videoId,
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