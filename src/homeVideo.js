/**
 * Home-page YouTube player: the small embed under the title bar.
 *
 * Autoplays the ADMIN-configured default (muted, because every browser blocks
 * autoplay with sound), offers small / medium / fullscreen, and shows the
 * shared now-playing + queue that viewer recommendations feed.
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
export const API_BASE = '/api/home-video';

/** Small and medium float in the title bar; large is the Fullscreen API. */
export const FLOAT_SIZES = Object.freeze(['sm', 'md']);
export const SIZES = Object.freeze([...FLOAT_SIZES, 'lg']);
export const DEFAULT_SIZE = 'sm';

const REFRESH_MS = 10_000;
const YOUTUBE_EMBED_ORIGIN = 'https://www.youtube-nocookie.com';
/** YouTube player state 0 = ENDED. */
const PLAYER_STATE_ENDED = 0;

/**
 * @param {unknown} value
 * @returns {string} one of SIZES
 */
export function normalizeSize(value) {
  const size = String(value ?? '').trim().toLowerCase();
  return SIZES.includes(size) ? size : DEFAULT_SIZE;
}

/**
 * Fullscreen is a transient mode, not a stored preference -- restoring a page
 * straight into fullscreen is not something a browser will do anyway.
 *
 * @param {Storage} [storage]
 * @returns {string}
 */
export function readSize(storage = safeStorage()) {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    const size = normalizeSize(JSON.parse(raw || '{}')?.size);
    return size === 'lg' ? DEFAULT_SIZE : size;
  } catch {
    return DEFAULT_SIZE;
  }
}

/**
 * @param {string} size
 * @param {Storage} [storage]
 */
export function writeSize(size, storage = safeStorage()) {
  if (!FLOAT_SIZES.includes(size)) return;
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify({ size }));
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
  // Autoplay with sound is blocked everywhere; muted is the only way it starts.
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

/** Module-scoped so `requestHomeVideo` can reach the live player from gevActions. */
let active = null;

/**
 * Drive the player from outside the DOM module (the GEV action runner).
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
 * Mount the home-page video player.
 *
 * Safe to call twice (main.js calls it on both the normal and WebGL-fallback
 * paths); the second call tears the first one down first.
 *
 * @param {Document} [doc]
 * @returns {{ stop: () => void }|null} null when the markup is absent
 */
export function initHomeVideo(doc = globalThis.document) {
  const root = byId(doc, 'gev-home-video');
  if (!root) return null;
  if (active) active.stop();

  const mount = byId(doc, 'gev-home-video-mount');
  const sourceSelect = byId(doc, 'gev-home-video-source');
  const form = byId(doc, 'gev-home-video-recommend');
  const urlInput = byId(doc, 'gev-home-video-url');
  const statusEl = byId(doc, 'gev-home-video-status');
  const nowEl = byId(doc, 'gev-home-video-now');
  const queueEl = byId(doc, 'gev-home-video-queue');
  const sizeButtons = [...root.querySelectorAll('[data-home-video-size]')];

  const win = doc.defaultView || globalThis;
  let size = readSize();
  let previousFloatSize = size;
  let config = { defaultVideoUrl: DEFAULT_VIDEO_URL, defaultPlaylistUrl: '', licenseCheckAvailable: false };
  let nowPlaying = null;
  let queue = [];
  let currentSrc = '';
  let iframe = null;
  let refreshTimer = 0;
  let stopped = false;

  const setStatus = (text, tone = '') => {
    if (!statusEl) return;
    statusEl.textContent = text || '';
    statusEl.dataset.tone = tone;
  };

  /** Publish the player height so #hud-center-cluster can sit clear of it. */
  const publishHeight = () => {
    const height = size === 'lg' ? 0 : root.getBoundingClientRect().height;
    doc.documentElement.style.setProperty('--gev-home-video-height', `${Math.round(height)}px`);
  };

  const renderSize = () => {
    root.dataset.size = size;
    doc.body?.setAttribute('data-home-video-size', size);
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
    try {
      iframe?.contentWindow?.postMessage(
        JSON.stringify({ event: 'listening', id: 'gev-home-video', channel: 'widget' }),
        YOUTUBE_EMBED_ORIGIN,
      );
    } catch { /* cross-origin timing; the queue still advances on refresh */ }
  }

  const onMessage = (event) => {
    if (!String(event.origin || '').includes('youtube')) return;
    let payload;
    try {
      payload = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
    } catch {
      return;
    }
    if (payload?.event !== 'onStateChange') return;
    if (Number(payload.info) === PLAYER_STATE_ENDED) advance();
  };

  /** Current video finished: take the next queued item, else fall back home. */
  async function advance() {
    if (!queue.length) return;
    try {
      await postJson(`${API_BASE}/advance`, {});
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
      previousFloatSize = FLOAT_SIZES.includes(size) ? size : DEFAULT_SIZE;
      try {
        await root.requestFullscreen?.();
        size = 'lg';
      } catch {
        setStatus('Fullscreen was refused by the browser', 'warn');
        return;
      }
    } else {
      if (doc.fullscreenElement === root) await doc.exitFullscreen?.().catch(() => {});
      size = wanted;
      writeSize(size);
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

  root.addEventListener('click', onSizeClick);
  form?.addEventListener('submit', onSubmit);
  sourceSelect?.addEventListener('change', onSourceChange);
  doc.addEventListener('fullscreenchange', onFullscreenChange);
  win.addEventListener('message', onMessage);
  resizeObserver?.observe(root);

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
      root.removeEventListener('click', onSizeClick);
      form?.removeEventListener('submit', onSubmit);
      sourceSelect?.removeEventListener('change', onSourceChange);
      doc.removeEventListener('fullscreenchange', onFullscreenChange);
      win.removeEventListener('message', onMessage);
      resizeObserver?.disconnect();
      iframe?.removeEventListener('load', subscribeToPlayer);
      doc.documentElement.style.removeProperty('--gev-home-video-height');
      if (active === controller) active = null;
    },
  };
  active = controller;
  return { stop: () => controller.stop() };
}
