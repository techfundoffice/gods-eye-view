/**
 * The second home surface: a deliberately small, read-only AI desk.
 * It never joins the shared home-video queue and never speaks for the source.
 */
export const TRENDING_API = '/api/youtube/trending-commentary';
export const TRENDING_ROOT_ID = 'gev-split-view';
const YOUTUBE_ORIGIN = 'https://www.youtube-nocookie.com';
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

export function validVideoId(value) {
  const id = String(value || '').trim();
  return VIDEO_ID.test(id) ? id : '';
}

export function embedUrlForTrending(id, origin = '') {
  const videoId = validVideoId(id);
  if (!videoId) return '';
  const url = new URL(`${YOUTUBE_ORIGIN}/embed/${videoId}`);
  url.searchParams.set('autoplay', '1');
  url.searchParams.set('mute', '1');
  url.searchParams.set('playsinline', '1');
  url.searchParams.set('rel', '0');
  url.searchParams.set('modestbranding', '1');
  if (origin) url.searchParams.set('origin', origin);
  return url.toString();
}

function text(value, fallback = '') {
  return String(value == null ? fallback : value).trim();
}

function errorMessage(error, fallback) {
  return text(error?.message ?? error, fallback);
}

function freshness(source) {
  const until = Date.parse(source?.freshUntil || '');
  if (!Number.isFinite(until)) return 'freshness unavailable';
  const delta = until - Date.now();
  if (delta <= 0) return 'stale · refresh required';
  const minutes = Math.max(1, Math.round(delta / 60000));
  return `fresh for ${minutes}m`;
}

function configuredFlag(commentator, key) {
  if (commentator?.[key] === true || commentator?.status?.[key] === true) return true;
  const channel = key === 'voiceEnabled' ? commentator?.voice : commentator?.avatar;
  return channel?.enabled === true || channel?.status?.enabled === true;
}

export function initTrendingCommentator(doc = globalThis.document, options = {}) {
  const root = doc?.getElementById?.(options.rootId || TRENDING_ROOT_ID);
  if (!root) return null;
  const mount = doc.getElementById(`${root.id}-mount`);
  if (!mount) return null;
  let stopped = false;
  let timer = 0;
  let speechTimer = 0;
  let current = null;
  const fetchImpl = options.fetchImpl || doc.defaultView?.fetch || globalThis.fetch;

  root.classList.add('gev-trending-commentator');
  root.replaceChildren();
  const desk = doc.createElement('div');
  desk.className = 'gev-trending-desk';
  const frame = doc.createElement('div');
  frame.className = 'gev-trending-frame';
  const status = doc.createElement('p');
  status.className = 'gev-trending-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const copy = doc.createElement('div');
  copy.className = 'gev-trending-copy';
  desk.append(frame, copy, status);
  root.append(desk);

  const setState = (value, tone = '') => {
    status.textContent = value;
    status.dataset.tone = tone;
  };
  const stopTimers = () => {
    clearTimeout(timer);
    clearTimeout(speechTimer);
  };
  const render = (payload) => {
    if (stopped) return;
    stopTimers();
    current = payload || {};
    const source = current.source;
    const analysis = current.analysis;
    const enabled = current.enabled !== false;
    const state = text(current.status || analysis?.status || '');
    if (!enabled) {
      frame.replaceChildren();
      copy.replaceChildren();
      return setState('TRENDING DESK · DISABLED', 'muted');
    }
    if (!source || !validVideoId(source.videoId)) {
      frame.replaceChildren();
      copy.replaceChildren();
      const attribution = doc.createElement('p');
      attribution.className = 'gev-trending-attribution';
      attribution.textContent = `AI-generated commentary · ${text(current.commentator?.label, 'faceless system voice')}`;
      const summary = doc.createElement('p');
      summary.className = 'gev-trending-segment';
      summary.textContent = text(analysis?.summary, state === 'loading'
        ? 'Selecting an embeddable public video from YouTube trends.'
        : 'No source is currently available for analysis.');
      copy.append(attribution, summary);
      if (state === 'loading') return setState('TRENDING DESK · LOADING');
      return setState(`TRENDING DESK · ${state === 'error' ? 'ERROR' : 'UNAVAILABLE'} · ${errorMessage(current.error, 'TRY AGAIN LATER')}`, 'warn');
    }
    const videoId = validVideoId(source.videoId);
    const stale = state === 'stale'
      || (Number.isFinite(Date.parse(source.freshUntil || '')) && Date.parse(source.freshUntil) <= Date.now());
    const existing = frame.querySelector?.('iframe');
    if (!existing || existing.dataset.videoId !== videoId) {
      const iframe = doc.createElement('iframe');
      iframe.className = 'gev-trending-iframe';
      iframe.src = embedUrlForTrending(videoId, doc.defaultView?.location?.origin || '');
      iframe.title = 'Official YouTube embed for trending video';
      iframe.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
      iframe.dataset.videoId = videoId;
      iframe.setAttribute('allowfullscreen', '');
      iframe.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
      frame.replaceChildren(iframe);
    }
    copy.replaceChildren();
    if (configuredFlag(current.commentator, 'avatarEnabled')) {
      const avatar = doc.createElement('div');
      avatar.className = 'gev-trending-avatar';
      avatar.setAttribute('aria-label', 'Abstract faceless AI commentator');
      avatar.textContent = 'AI';
      copy.append(avatar);
    }
    const eyebrow = doc.createElement('p');
    eyebrow.className = 'gev-trending-eyebrow';
    eyebrow.textContent = `AI COMMENTARY · ${text(source.regionCode, 'GLOBAL')} TRENDING`;
    const title = doc.createElement('h3');
    title.textContent = text(source.title, 'Trending video');
    const meta = doc.createElement('p');
    meta.className = 'gev-trending-meta';
    meta.textContent = `${text(source.channelTitle, 'Channel unavailable')} · ${freshness(source)}`;
    const attribution = doc.createElement('p');
    attribution.className = 'gev-trending-attribution';
    attribution.textContent = `AI-generated commentary · ${text(current.commentator?.label, 'faceless system voice')}`;
    const segment = doc.createElement('p');
    segment.className = 'gev-trending-segment';
    segment.textContent = text(analysis?.summary, 'Listening for the next analysis cue…');
    copy.append(eyebrow, title, meta, attribution, segment);
    const provider = text(analysis?.provider);
    setState(state === 'error' ? `TRENDING DESK · ERROR · ${errorMessage(current.error, 'TRY AGAIN LATER')}`
      : stale ? 'TRENDING DESK · STALE · REFRESH REQUIRED'
      : (analysis?.status === 'loading' ? 'ANALYSIS · GENERATING'
        : `ANALYSIS · ${provider || 'PROVIDER UNAVAILABLE'}`), state === 'error' || stale ? 'warn' : '');
    const segments = Array.isArray(analysis?.segments) ? analysis.segments
      .filter((item) => Number.isFinite(Number(item?.atSeconds)) && text(item?.text))
      .sort((a, b) => Number(a.atSeconds) - Number(b.atSeconds)) : [];
    let index = 0;
    const speak = (line) => {
      if (!configuredFlag(current.commentator, 'voiceEnabled') || !doc.defaultView?.speechSynthesis || !doc.defaultView.SpeechSynthesisUtterance) return;
      doc.defaultView.speechSynthesis.cancel();
      const utterance = new doc.defaultView.SpeechSynthesisUtterance(line);
      utterance.volume = 0.7;
      doc.defaultView.speechSynthesis.speak(utterance);
    };
    const advance = () => {
      if (stopped || index >= segments.length) return;
      const item = segments[index++];
      segment.textContent = text(item.text);
      if (configuredFlag(current.commentator, 'voiceEnabled')) speechTimer = setTimeout(() => speak(text(item.text)), 0);
      const next = segments[index];
      if (next) timer = setTimeout(advance, Math.max(250, (Number(next.atSeconds) - Number(item.atSeconds)) * 1000));
    };
    if (segments.length) timer = setTimeout(advance, Math.max(0, Number(segments[0].atSeconds) * 1000));
  };
  const refresh = async () => {
    setState('TRENDING DESK · LOADING');
    try {
      if (typeof fetchImpl !== 'function') throw new Error('Fetch unavailable');
      const response = await fetchImpl(TRENDING_API, { headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      render(await response.json());
    } catch {
      setState('TRENDING DESK · ERROR · RETRYING', 'warn');
    }
  };
  void refresh();
  const refreshTimer = (doc.defaultView || globalThis).setInterval(refresh, 30000);
  return {
    refresh,
    stop() { stopped = true; stopTimers(); clearInterval(refreshTimer); current = null; },
  };
}