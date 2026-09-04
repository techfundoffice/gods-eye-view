/**
 * Home-page YouTube player: the small embed under the title bar.
 *
 * Autoplays the ADMIN-configured default with sound, offers small / medium /
 * fullscreen, and shows the shared now-playing + queue that viewer
 * recommendations feed.
 *
 * Getting audio requires a two-step start. Every browser refuses to autoplay a
 * video with sound, so the embed starts muted -- that is the only way playback
 * begins at all -- and the player is then unmuted through the IFrame API as
 * soon as it reports ready. Where the browser still withholds audio (an
 * ordinary visitor with no autoplay permission for the site) the first click or
 * keypress anywhere on the page unmutes it. A capture browser launched with
 * `--autoplay-policy=no-user-gesture-required` gets sound immediately.
 *
 * Nothing here decides whether a recommendation is allowed. The player only
 * renders what the server already moderated; the gate lives in
 * `homeVideoModeration.js` and runs server-side.
 *
 * @module homeVideo
 */

import { DEFAULT_VIDEO_URL, parseYoutubeUrl } from './homeVideoModeration.js';

export const EVENT = 'gev:home-video';
export const STORAGE_KEY = 'gev:home-video:v1';
/** The root id of the player the GEV tool drives when several are mounted. */
export const PRIMARY_ROOT_ID = 'gev-home-video';
export const API_BASE = '/api/home-video';

/** Small and medium float in the title bar; large is the Fullscreen API. */
export const FLOAT_SIZES = Object.freeze(['sm', 'md']);
export const SIZES = Object.freeze([...FLOAT_SIZES, 'lg']);
export const DEFAULT_SIZE = 'sm';

const REFRESH_MS = 10_000;
const YOUTUBE_EMBED_ORIGIN = 'https://www.youtube-nocookie.com';
/** Exact origins the embed may speak from. A substring test would let
 *  `https://youtube.evil.test` drive the queue. */
const PLAYER_MESSAGE_ORIGINS = new Set([YOUTUBE_EMBED_ORIGIN, 'https://www.youtube.com']);
/** YouTube player states. */
const PLAYER_STATE_ENDED = 0;
const PLAYER_STATE_PLAYING = 1;
/** Full volume once the player accepts the unmute. */
const UNMUTED_VOLUME = 100;

/**
 * @param {unknown} value
 * @returns {string} one of SIZES
 */
export function normalizeSize(value) {
  const size = String(value ?? '').trim().toLowerCase();
  return SIZES.includes(size) ? size : DEFAULT_SIZE;
}

/**
 * Each player keeps its own size. The primary keeps the original bare key so an
 * existing stored preference is not orphaned.
 *
 * @param {string} [rootId]
 * @returns {string}
 */
export function storageKeyFor(rootId = PRIMARY_ROOT_ID) {
  return rootId === PRIMARY_ROOT_ID ? STORAGE_KEY : `${STORAGE_KEY}:${rootId}`;
}

/**
 * Fullscreen is a transient mode, not a stored preference -- restoring a page
 * straight into fullscreen is not something a browser will do anyway.
 *
 * @param {Storage} [storage]
 * @param {string} [key]
 * @returns {string}
 */
export function readSize(storage = safeStorage(), key = STORAGE_KEY) {
  try {
    const raw = storage?.getItem(key);
    const size = normalizeSize(JSON.parse(raw || '{}')?.size);
    return size === 'lg' ? DEFAULT_SIZE : size;
  } catch {
    return DEFAULT_SIZE;
  }
}

/**
 * @param {string} size
 * @param {Storage} [storage]
 * @param {string} [key]
 */
export function writeSize(size, storage = safeStorage(), key = STORAGE_KEY) {
  if (!FLOAT_SIZES.includes(size)) return;
  try {
    storage?.setItem(key, JSON.stringify({ size }));
  } catch { /* storage blocked; the player still works */ }
}

function safeStorage() {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

/**
 * Build the embed URL for a parsed YouTube reference.
 *
 * `loop` is only set when nothing is queued: a looping video never reports
 * ENDED, which is the signal the queue advances on.
 *
 * @param {{ kind: string, id: string }} ref
 * @param {{ loop?: boolean, origin?: string }} [options]
 * @returns {string} embed URL, or '' when the reference is not playable
 */
export function embedUrlFor(ref, options = {}) {
  const { loop = true, origin = '' } = options;
  const kind = ref?.kind;
  const id = String(ref?.id || '');
  if (!id || (kind !== 'video' && kind !== 'playlist')) return '';

  const url = new URL(
    kind === 'playlist' ? `${YOUTUBE_EMBED_ORIGIN}/embed/videoseries` : `${YOUTUBE_EMBED_ORIGIN}/embed/${id}`,
  );
  const params = url.searchParams;
  if (kind === 'playlist') params.set('list', id);
  params.set('autoplay', '1');
  // Starts muted ONLY so autoplay is permitted -- every browser blocks autoplay
  // with sound outright. The player is unmuted over the IFrame API the moment it
  // reports ready; see `unmutePlayer` below.
  params.set('mute', '1');
  params.set('playsinline', '1');
  params.set('rel', '0');
  params.set('modestbranding', '1');
  params.set('enablejsapi', '1');
  if (loop) {
    params.set('loop', '1');
    // A single-video loop needs its own id repeated as the playlist.
    if (kind === 'video') params.set('playlist', id);
  }
  if (origin) params.set('origin', origin);
  return url.toString();
}

/**
 * Live controllers keyed by root id. Keyed rather than a single slot because
 * `main.js` mounts on both the normal and WebGL-fallback paths: re-mounting the
 * SAME root must replace it, while a second player must be left alone.
 *
 * @type {Map<string, object>}
 */
const mounted = new Map();

/** The primary controller, which is what `requestHomeVideo` reaches. */
let active = null;

/**
 * Drive the player from outside the DOM module (the GEV action runner).
 *
 * Always targets the primary player; a secondary player is a view, not a
 * command target.
 *
 * @param {{ action: string, url?: string }} detail
 * @returns {Promise<object>} `{ ok, ... }` shaped for a GEV tool result
 */
export async function requestHomeVideo(detail) {
  if (!active) return { ok: false, error: 'Home video player is not on this page' };
  return active.apply(detail || {});
}

/**
 * @param {Document} doc
 * @param {string} id
 * @returns {HTMLElement|null}
 */
const byId = (doc, id) => doc.getElementById(id);

/**
 * Child element ids are derived from the root id, so a second player needs no
 * new naming scheme: `gev-home-video` + `-mount` is exactly today's markup, and
 * `gev-split-view` + `-mount` is the split view's.
 *
 * @param {string} rootId
 * @param {string} part
 * @returns {string}
 */
const childId = (rootId, part) => `${rootId}-${part}`;

/**
 * Mount a home-page video player.
 *
 * Safe to call twice for the same root (main.js calls it on both the normal and
 * WebGL-fallback paths); the second call replaces that root's controller only.
 *
 * @param {Document} [doc]
 * @param {object} [options]
 * @param {string} [options.rootId] Which player to mount.
 * @param {boolean} [options.muted] Leave this player silent (a second copy of
 *   the same stream would otherwise echo).
 * @param {boolean} [options.primary] Whether the GEV tool targets this one.
 * @returns {{ stop: () => void }|null} null when the markup is absent
 */
export function initHomeVideo(doc = globalThis.document, options = {}) {
  const {
    rootId = PRIMARY_ROOT_ID,
    muted = false,
    primary = rootId === PRIMARY_ROOT_ID,
  } = options;

  const root = byId(doc, rootId);
  if (!root) return null;
  mounted.get(rootId)?.stop();

  const mount = byId(doc, childId(rootId, 'mount'));
  const sourceSelect = byId(doc, childId(rootId, 'source'));
  const form = byId(doc, childId(rootId, 'recommend'));
  const urlInput = byId(doc, childId(rootId, 'url'));
  const statusEl = byId(doc, childId(rootId, 'status'));
  const nowEl = byId(doc, childId(rootId, 'now'));
  const queueEl = byId(doc, childId(rootId, 'queue'));
  const sizeButtons = [...root.querySelectorAll('[data-home-video-size]')];

  const win = doc.defaultView || globalThis;
  const storageKey = storageKeyFor(rootId);
  let size = readSize(safeStorage(), storageKey);
  let previousFloatSize = size;
  let config = { defaultVideoUrl: DEFAULT_VIDEO_URL, defaultPlaylistUrl: '', licenseCheckAvailable: false };
  let nowPlaying = null;
  let queue = [];
  let currentSrc = '';
  let iframe = null;
  let unmuteAttempted = false;
  let refreshTimer = 0;
  let stopped = false;

  const setStatus = (text, tone = '') => {
    if (!statusEl) return;
    statusEl.textContent = text || '';
    statusEl.dataset.tone = tone;
  };

  /** Publish the player height so #hud-center-cluster can sit clear of it. */
  // Measured on the rail, not this player: with two side by side both would
  // otherwise write --gev-home-video-height and the shorter one could win.
  const measured = () => root.closest?.('.gev-home-video-rail') || root;
  const publishHeight = () => {
    const height = size === 'lg' ? 0 : measured().getBoundingClientRect().height;
    doc.documentElement.style.setProperty('--gev-home-video-height', `${Math.round(height)}px`);
  };

  const renderSize = () => {
    root.dataset.size = size;
    for (const button of sizeButtons) {
      button.setAttribute('aria-pressed', String(button.dataset.homeVideoSize === size));
    }
    publishHeight();
  };

  const play = (ref, { loop } = {}) => {
    const src = embedUrlFor(ref, {
      loop: loop ?? queue.length === 0,
      origin: win.location?.origin || '',
    });
    if (!src || !mount) return false;
    if (src === currentSrc) return true;
    currentSrc = src;
    unmuteAttempted = false;

    const frame = doc.createElement('iframe');
    frame.className = 'gev-home-video-iframe';
    frame.src = src;
    frame.title = nowPlaying?.title || 'Home video player';
    frame.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
    frame.setAttribute('allowfullscreen', '');
    frame.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
    frame.addEventListener('load', subscribeToPlayer);
    mount.replaceChildren(frame);
    iframe = frame;
    return true;
  };

  /**
   * Ask the embed to report state changes. This is the documented `enablejsapi`
   * channel, so the queue can advance without loading YouTube's API script.
   */
  function subscribeToPlayer() {
    postToPlayer({ event: 'listening', id: rootId, channel: 'widget' });
  }

  /**
   * @param {object} message
   */
  function postToPlayer(message) {
    try {
      iframe?.contentWindow?.postMessage(JSON.stringify(message), YOUTUBE_EMBED_ORIGIN);
    } catch { /* cross-origin timing; state still reconciles on the next refresh */ }
  }

  /**
   * Turn the sound on. The embed can only autoplay while muted, so this runs as
   * soon as the player is ready and again on the first user gesture, which is
   * what a browser withholding audio is waiting for.
   *
   * Attempted once per loaded video: a viewer who mutes from YouTube's own
   * controls must stay muted.
   */
  function unmutePlayer() {
    // A muted player is a deliberate second view of the same stream; unmuting
    // it would double the audio a fraction of a second out of phase.
    if (muted) return;
    if (unmuteAttempted) return;
    unmuteAttempted = true;
    postToPlayer({ event: 'command', func: 'unMute', args: [] });
    postToPlayer({ event: 'command', func: 'setVolume', args: [UNMUTED_VOLUME] });
  }

  const onMessage = (event) => {
    if (!PLAYER_MESSAGE_ORIGINS.has(event.origin)) return;
    // Every player on the page listens on the same window, so a message has to
    // be matched to the frame that sent it. Without this the split view would
    // advance its queue and unmute itself off the other player's events.
    if (!iframe || event.source !== iframe.contentWindow) return;
    let payload;
    try {
      payload = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
    } catch {
      return;
    }
    // The player only accepts commands once it is ready.
    if (payload?.event === 'onReady') return void unmutePlayer();
    if (payload?.event !== 'onStateChange') return;
    const state = Number(payload.info);
    // onReady can be missed if the listening handshake lands late; PLAYING is
    // the backstop.
    if (state === PLAYER_STATE_PLAYING) unmutePlayer();
    if (state === PLAYER_STATE_ENDED) advance();
  };

  /** Current video finished: take the next queued item, else fall back home. */
  async function advance() {
    if (!queue.length) return;
    // Naming what finished lets the server ignore a stale or replayed call
    // rather than letting anyone drain the shared queue.
    const finishedVideoId = nowPlaying?.videoId || parseYoutubeUrl(config.defaultVideoUrl).id;
    try {
      await postJson(`${API_BASE}/advance`, { finishedVideoId });
    } catch { /* fall through to a refresh */ }
    await refresh();
  }

  const renderSources = () => {
    if (!sourceSelect) return;
    const options = [];
    if (config.defaultVideoUrl) options.push({ label: 'DEFAULT VIDEO', url: config.defaultVideoUrl });
    if (config.defaultPlaylistUrl) options.push({ label: 'DEFAULT PLAYLIST', url: config.defaultPlaylistUrl });
    sourceSelect.replaceChildren(...options.map(({ label, url }) => {
      const option = doc.createElement('option');
      option.value = url;
      // The URL is shown verbatim on purpose: ADMIN sets it and viewers copy it.
      option.textContent = `${label} · ${url}`;
      return option;
    }));
    sourceSelect.disabled = options.length === 0;
  };

  const renderQueue = () => {
    if (nowEl) {
      nowEl.textContent = nowPlaying?.title
        ? `NOW PLAYING · ${nowPlaying.title}${nowPlaying.requestedBy ? ` · requested by ${nowPlaying.requestedBy}` : ''}`
        : '';
    }
    if (!queueEl) return;
    queueEl.replaceChildren(...queue.map((entry) => {
      const li = doc.createElement('li');
      li.className = 'gev-home-video-queue-item';
      li.textContent = entry.requestedBy ? `${entry.title} — ${entry.requestedBy}` : entry.title;
      return li;
    }));
    queueEl.hidden = queue.length === 0;
  };

  async function refresh() {
    let payload;
    try {
      const response = await fetch(API_BASE, { headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error(`home-video ${response.status}`);
      payload = await response.json();
    } catch {
      // Server unreachable: still play the seed default rather than nothing.
      if (!currentSrc) play(parseYoutubeUrl(DEFAULT_VIDEO_URL));
      return;
    }
    if (stopped) return;

    config = {
      defaultVideoUrl: payload?.defaultVideoUrl || DEFAULT_VIDEO_URL,
      defaultPlaylistUrl: payload?.defaultPlaylistUrl || '',
      licenseCheckAvailable: Boolean(payload?.licenseCheckAvailable),
    };
    nowPlaying = payload?.nowPlaying || null;
    queue = Array.isArray(payload?.queue) ? payload.queue : [];

    renderSources();
    renderQueue();
    play(parseYoutubeUrl(nowPlaying?.url || config.defaultVideoUrl));
    publishHeight();
  }

  async function postJson(url, body) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(payload?.reason || 'request failed'), { payload });
    return payload;
  }

  const setSize = async (next) => {
    const wanted = normalizeSize(next);
    if (wanted === 'lg') {
      if (typeof root.requestFullscreen !== 'function') {
        setStatus('This browser does not offer fullscreen here', 'warn');
        return;
      }
      previousFloatSize = FLOAT_SIZES.includes(size) ? size : DEFAULT_SIZE;
      try {
        await root.requestFullscreen();
        size = 'lg';
      } catch {
        setStatus('Fullscreen was refused by the browser', 'warn');
        return;
      }
    } else {
      if (doc.fullscreenElement === root) await doc.exitFullscreen?.().catch(() => {});
      size = wanted;
      writeSize(size, safeStorage(), storageKey);
    }
    renderSize();
  };

  const onFullscreenChange = () => {
    if (doc.fullscreenElement === root) return;
    if (size !== 'lg') return;
    size = previousFloatSize;
    renderSize();
  };

  const onSizeClick = (event) => {
    const button = event.target.closest?.('[data-home-video-size]');
    if (!button) return;
    event.preventDefault();
    setSize(button.dataset.homeVideoSize);
  };

  const onSourceChange = () => {
    const ref = parseYoutubeUrl(sourceSelect.value);
    if (!ref.kind) return;
    currentSrc = '';
    nowPlaying = null;
    play(ref, { loop: true });
    setStatus('');
  };

  const onSubmit = async (event) => {
    event.preventDefault();
    const url = String(urlInput?.value || '').trim();
    if (!url) return;
    setStatus('Checking that video…');
    try {
      const result = await postJson(`${API_BASE}/recommend`, { url });
      if (result?.allowed) {
        urlInput.value = '';
        setStatus(`Queued · ${result.title || url}`, 'ok');
        await refresh();
      } else {
        setStatus(result?.reason || 'That video was not accepted', 'warn');
      }
    } catch (err) {
      setStatus(err?.payload?.reason || 'Could not check that video right now', 'warn');
    }
  };

  const resizeObserver = typeof win.ResizeObserver === 'function'
    ? new win.ResizeObserver(publishHeight)
    : null;

  // A browser that withheld audio on autoplay will grant it after any user
  // gesture. Capture phase so it still fires for clicks the page handles.
  const onFirstGesture = () => unmutePlayer();
  const gestureOptions = { once: true, capture: true };
  doc.addEventListener('pointerdown', onFirstGesture, gestureOptions);
  doc.addEventListener('keydown', onFirstGesture, gestureOptions);

  root.addEventListener('click', onSizeClick);
  form?.addEventListener('submit', onSubmit);
  sourceSelect?.addEventListener('change', onSourceChange);
  doc.addEventListener('fullscreenchange', onFullscreenChange);
  win.addEventListener('message', onMessage);
  resizeObserver?.observe(root);
  if (measured() !== root) resizeObserver?.observe(measured());

  renderSize();
  // Paint the seed default immediately so the player is never a blank box while
  // the config request is in flight.
  play(parseYoutubeUrl(DEFAULT_VIDEO_URL));
  refresh();
  refreshTimer = win.setInterval(refresh, REFRESH_MS);

  const controller = {
    /**
     * Apply a `control_video_player` tool call.
     *
     * @param {{ action?: string, url?: string }} detail
     */
    async apply(detail) {
      const action = String(detail?.action || '').toLowerCase();
      if (action === 'default') {
        currentSrc = '';
        play(parseYoutubeUrl(config.defaultVideoUrl), { loop: true });
        return { ok: true, action: 'control_video_player', applied: 'default' };
      }
      if (action === 'skip') {
        await advance();
        return { ok: true, action: 'control_video_player', applied: 'skip' };
      }
      if (action === 'play' || action === 'queue') {
        try {
          const result = await postJson(`${API_BASE}/recommend`, { url: detail?.url, source: 'agent' });
          await refresh();
          return result?.allowed
            ? { ok: true, action: 'control_video_player', applied: 'queue', title: result.title, videoId: result.videoId }
            : { ok: false, action: 'control_video_player', error: result?.reason || 'Video was not accepted' };
        } catch (err) {
          return { ok: false, action: 'control_video_player', error: err?.payload?.reason || 'Could not check that video' };
        }
      }
      return { ok: false, action: 'control_video_player', error: `Unknown action: ${action || 'missing'}` };
    },
    stop() {
      stopped = true;
      win.clearInterval(refreshTimer);
      doc.removeEventListener('pointerdown', onFirstGesture, gestureOptions);
      doc.removeEventListener('keydown', onFirstGesture, gestureOptions);
      root.removeEventListener('click', onSizeClick);
      form?.removeEventListener('submit', onSubmit);
      sourceSelect?.removeEventListener('change', onSourceChange);
      doc.removeEventListener('fullscreenchange', onFullscreenChange);
      win.removeEventListener('message', onMessage);
      resizeObserver?.disconnect();
      iframe?.removeEventListener('load', subscribeToPlayer);
      doc.documentElement.style.removeProperty('--gev-home-video-height');
      if (mounted.get(rootId) === controller) mounted.delete(rootId);
      if (active === controller) active = null;
    },
  };
  mounted.set(rootId, controller);
  if (primary) active = controller;
  return { stop: () => controller.stop() };
}
