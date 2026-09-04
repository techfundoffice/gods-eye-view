/**
 * Moderation for viewer-recommended home-page videos.
 *
 * A recommendation plays only when BOTH conditions hold: YouTube reports the
 * video under a Creative Commons license, and its channel is on the ADMIN
 * approved list. Order matters only for the message the viewer gets back.
 *
 * An unverifiable video is not an approved one. With no API key, no network, or
 * a malformed upstream answer the result is `allowed: false` with an explicit
 * reason -- never a silent pass. Putting a copyrighted video on the broadcast
 * because a lookup failed is the failure this module exists to prevent.
 *
 * Server-safe: no browser, ADMIN, or Cesium imports, and `fetch` arrives as a
 * parameter so the boundary is testable without network.
 *
 * @module homeVideoModeration
 */

export const YOUTUBE_VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
export const YOUTUBE_PLAYLIST_ID_RE = /^[A-Za-z0-9_-]{12,64}$/;
export const YOUTUBE_CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{22}$/;

export const CREATIVE_COMMONS_LICENSE = 'creativeCommon';
export const YOUTUBE_VIDEOS_ENDPOINT = 'https://www.googleapis.com/youtube/v3/videos';
export const LICENSE_LOOKUP_TIMEOUT_MS = 10_000;

/** Big Buck Bunny -- Blender Foundation, CC-BY 3.0. Seed default; ADMIN may replace it. */
export const DEFAULT_VIDEO_ID = 'aqz-KE-bpKQ';
export const DEFAULT_VIDEO_URL = `https://www.youtube.com/watch?v=${DEFAULT_VIDEO_ID}`;

/** Reasons are viewer-facing. Keep them short enough for a live-chat reply. */
export const REASON_UNAVAILABLE = 'LICENSE CHECK UNAVAILABLE';
export const REASON_NOT_YOUTUBE = 'NOT A YOUTUBE LINK';
export const REASON_NOT_A_VIDEO = 'RECOMMEND A SINGLE VIDEO';
export const REASON_NOT_FOUND = 'VIDEO NOT FOUND';
export const REASON_NOT_ROYALTY_FREE = 'NOT ROYALTY FREE';
export const REASON_NOT_EMBEDDABLE = 'VIDEO CANNOT BE EMBEDDED';
export const REASON_CHANNEL_NOT_APPROVED = 'CHANNEL NOT APPROVED';

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtube-nocookie.com',
  'youtu.be',
]);

/** Path prefixes that carry a bare video id as the next segment. */
const VIDEO_PATH_PREFIXES = new Set(['embed', 'shorts', 'live', 'v']);

/** Path prefixes that carry a channel name (not an id) as the next segment. */
const CHANNEL_NAME_PREFIXES = new Set(['c', 'user']);

/**
 * Approved-channel entries are matched loosely on purpose: an operator pasting
 * a channel URL, a bare `UC...` id, or an `@handle` should all work.
 *
 * @param {unknown} value
 * @returns {string[]} normalized, de-duplicated, non-empty entries
 */
export function normalizeApprovedChannels(value) {
  const list = Array.isArray(value) ? value : String(value ?? '').split(/[\n,]/);
  const seen = new Set();
  for (const raw of list) {
    const text = String(raw ?? '').trim();
    if (!text) continue;
    const parsed = parseYoutubeUrl(text);
    const entry = parsed.kind === 'channel' ? (parsed.id || parsed.handle) : text;
    const key = entry.replace(/^@/, '').toLowerCase();
    if (key) seen.add(key);
  }
  return [...seen];
}

/**
 * Classify any YouTube link into the one thing it identifies.
 *
 * @param {unknown} value URL, or a bare 11-character video id
 * @returns {{ kind: ''|'video'|'playlist'|'channel', id: string, handle: string, reason: string }}
 */
export function parseYoutubeUrl(value) {
  const raw = String(value ?? '').trim();
  const miss = (reason) => ({ kind: '', id: '', handle: '', reason });
  if (!raw) return miss('empty');
  if (YOUTUBE_VIDEO_ID_RE.test(raw)) return { kind: 'video', id: raw, handle: '', reason: '' };

  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return miss('unparseable');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return miss('not-youtube');

  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (!YOUTUBE_HOSTS.has(host)) return miss('not-youtube');

  const segments = url.pathname.split('/').filter(Boolean);

  // youtu.be/<id> puts the id in the path with no query key.
  if (host === 'youtu.be') {
    const id = segments[0] || '';
    return YOUTUBE_VIDEO_ID_RE.test(id)
      ? { kind: 'video', id, handle: '', reason: '' }
      : miss('bad-video-id');
  }

  // `watch?v=<id>&list=<playlist>` is a video played in a playlist context; the
  // video is the thing being recommended, so it wins over `list`.
  const v = url.searchParams.get('v') || '';
  if (YOUTUBE_VIDEO_ID_RE.test(v)) return { kind: 'video', id: v, handle: '', reason: '' };

  const list = url.searchParams.get('list') || '';
  if (YOUTUBE_PLAYLIST_ID_RE.test(list)) return { kind: 'playlist', id: list, handle: '', reason: '' };

  const head = (segments[0] || '').toLowerCase();

  if (segments.length >= 2 && VIDEO_PATH_PREFIXES.has(head)) {
    const id = segments[1];
    return YOUTUBE_VIDEO_ID_RE.test(id)
      ? { kind: 'video', id, handle: '', reason: '' }
      : miss('bad-video-id');
  }

  if (head === 'channel' && YOUTUBE_CHANNEL_ID_RE.test(segments[1] || '')) {
    return { kind: 'channel', id: segments[1], handle: '', reason: '' };
  }

  if ((segments[0] || '').startsWith('@') && segments[0].length > 1) {
    return { kind: 'channel', id: '', handle: segments[0].slice(1), reason: '' };
  }

  if (CHANNEL_NAME_PREFIXES.has(head) && segments[1]) {
    return { kind: 'channel', id: '', handle: segments[1], reason: '' };
  }

  return miss('unrecognized');
}

/**
 * Ask YouTube what license a video carries.
 *
 * `videos.list` is public data, so this uses a server-side API key rather than
 * the operator's OAuth session -- moderation runs in the background, where no
 * browser session cookie exists.
 *
 * @param {string} videoId
 * @param {{ fetchImpl?: Function, apiKey?: string, timeoutMs?: number }} [options]
 * @returns {Promise<{ ok: boolean, license: string, channelId: string, channelTitle: string, title: string, unavailable: boolean, reason: string }>}
 */
export async function checkVideoLicense(videoId, options = {}) {
  const {
    fetchImpl = globalThis.fetch,
    apiKey = '',
    timeoutMs = LICENSE_LOOKUP_TIMEOUT_MS,
  } = options;

  const blank = (reason, extra = {}) => ({
    ok: false,
    license: '',
    channelId: '',
    channelTitle: '',
    title: '',
    unavailable: false,
    reason,
    ...extra,
  });

  const id = String(videoId ?? '').trim();
  if (!YOUTUBE_VIDEO_ID_RE.test(id)) return blank(REASON_NOT_YOUTUBE);
  if (!String(apiKey).trim()) return blank(REASON_UNAVAILABLE, { unavailable: true });
  if (typeof fetchImpl !== 'function') return blank(REASON_UNAVAILABLE, { unavailable: true });

  const url = new URL(YOUTUBE_VIDEOS_ENDPOINT);
  url.searchParams.set('part', 'status,snippet');
  url.searchParams.set('id', id);
  url.searchParams.set('key', String(apiKey).trim());

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let payload;
  try {
    const response = await fetchImpl(url.toString(), { signal: controller.signal });
    if (!response?.ok) return blank(REASON_UNAVAILABLE, { unavailable: true });
    payload = await response.json();
  } catch {
    return blank(REASON_UNAVAILABLE, { unavailable: true });
  } finally {
    clearTimeout(timer);
  }

  const item = Array.isArray(payload?.items) ? payload.items[0] : null;
  if (!item) return blank(REASON_NOT_FOUND);

  const license = String(item?.status?.license || '');
  const channelId = String(item?.snippet?.channelId || '');
  const channelTitle = String(item?.snippet?.channelTitle || '');
  const title = String(item?.snippet?.title || '');
  const found = { license, channelId, channelTitle, title, unavailable: false };

  if (license !== CREATIVE_COMMONS_LICENSE) {
    return { ok: false, ...found, reason: `${REASON_NOT_ROYALTY_FREE} — standard YouTube license` };
  }
  // A Creative Commons video with embedding disabled would render as an error
  // frame on the broadcast, so it is refused here rather than on air.
  if (item?.status?.embeddable === false) {
    return { ok: false, ...found, reason: REASON_NOT_EMBEDDABLE };
  }
  return { ok: true, ...found, reason: '' };
}

/**
 * @param {{ channelId?: string, channelTitle?: string }} video
 * @param {string[]|string} approvedChannels
 * @returns {boolean}
 */
export function isApprovedChannel(video, approvedChannels) {
  const approved = normalizeApprovedChannels(approvedChannels);
  if (!approved.length) return false;
  const candidates = [video?.channelId, video?.channelTitle]
    .map((entry) => String(entry ?? '').trim().replace(/^@/, '').toLowerCase())
    .filter(Boolean);
  return candidates.some((candidate) => approved.includes(candidate));
}

/**
 * The full gate: parse, license-check, then channel-check.
 *
 * @param {unknown} rawUrl
 * @param {{ approvedChannels?: string[]|string, fetchImpl?: Function, apiKey?: string, timeoutMs?: number }} [options]
 * @returns {Promise<{ allowed: boolean, videoId: string, title: string, channelId: string, channelTitle: string, license: string, unavailable: boolean, reason: string }>}
 */
export async function moderateRecommendation(rawUrl, options = {}) {
  const { approvedChannels = [], ...lookup } = options;
  const refuse = (reason, extra = {}) => ({
    allowed: false,
    videoId: '',
    title: '',
    channelId: '',
    channelTitle: '',
    license: '',
    unavailable: false,
    reason,
    ...extra,
  });

  const parsed = parseYoutubeUrl(rawUrl);
  if (!parsed.kind) return refuse(REASON_NOT_YOUTUBE);
  // A playlist or channel is a moving target: its future contents cannot be
  // license-checked now, so only a single video can clear the gate.
  if (parsed.kind !== 'video') {
    return refuse(`${REASON_NOT_A_VIDEO} — a whole ${parsed.kind} cannot be license-checked`);
  }

  const licensed = await checkVideoLicense(parsed.id, lookup);
  const found = {
    videoId: parsed.id,
    title: licensed.title,
    channelId: licensed.channelId,
    channelTitle: licensed.channelTitle,
    license: licensed.license,
    unavailable: licensed.unavailable,
  };
  if (!licensed.ok) return refuse(licensed.reason, found);

  if (!isApprovedChannel(licensed, approvedChannels)) {
    const who = licensed.channelTitle || licensed.channelId || 'that channel';
    return refuse(`${REASON_CHANNEL_NOT_APPROVED} — ${who}`, found);
  }
  return { allowed: true, ...found, reason: '' };
}
