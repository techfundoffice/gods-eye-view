/**
 * Shared royalty-free music bed config for the left-nav speaker (#left-yt-music).
 * Library lives at /music/library.json; operator picks active beds in ADMIN.
 *
 * @module royaltyFreeMusic
 */

export const STORAGE_KEY = 'gev:royalty-free-music';
export const EVENT = 'gev:royalty-free-music-changed';

/** Fallback if /music/library.json is unreachable. */
export const FALLBACK_URLS = [
  '/music/soundhelix-1.mp3',
  '/music/soundhelix-2.mp3',
  '/music/soundhelix-3.mp3',
];

/**
 * @typedef {{ id: string, title: string, url: string, source?: string }} MusicTrack
 * @typedef {{ version?: number, attribution?: string, tracks?: MusicTrack[], defaultActiveIds?: string[] }} MusicLibrary
 * @typedef {{ enabled: boolean, activeIds: string[], customUrls: string[] }} MusicConfig
 */

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function asStringList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item ?? '').trim())
    .filter(Boolean);
}

/**
 * @param {unknown} raw
 * @returns {MusicConfig}
 */
export function normalizeConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const enabled = src.enabled !== false;
  const activeIds = asStringList(src.activeIds);
  const customUrls = asStringList(src.customUrls).filter((url) => isAllowedMusicUrl(url));
  return { enabled, activeIds, customUrls };
}

/**
 * Accept https://… or same-origin /music/… paths only.
 * @param {string} url
 * @returns {boolean}
 */
export function isAllowedMusicUrl(url) {
  const s = String(url || '').trim();
  if (!s) return false;
  if (s.startsWith('/music/')) return true;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<MusicLibrary>}
 */
export async function loadLibrary(fetchImpl = globalThis.fetch) {
  const res = await fetchImpl('/music/library.json', { cache: 'no-store' });
  if (!res?.ok) throw new Error(`library.json HTTP ${res?.status || '?'}`);
  const data = await res.json();
  const tracks = Array.isArray(data?.tracks)
    ? data.tracks
        .filter((t) => t && typeof t === 'object' && t.id && t.url)
        .map((t) => ({
          id: String(t.id),
          title: String(t.title || t.id),
          url: String(t.url),
          source: t.source != null ? String(t.source) : '',
        }))
    : [];
  return {
    version: Number(data?.version) || 1,
    attribution: String(data?.attribution || ''),
    tracks,
    defaultActiveIds: asStringList(data?.defaultActiveIds),
  };
}

/**
 * @returns {MusicConfig}
 */
export function readConfig() {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) {
      return normalizeConfig({
        enabled: true,
        activeIds: ['soundhelix-1', 'soundhelix-2', 'soundhelix-3'],
        customUrls: [],
      });
    }
    return normalizeConfig(JSON.parse(raw));
  } catch {
    return normalizeConfig({
      enabled: true,
      activeIds: ['soundhelix-1', 'soundhelix-2', 'soundhelix-3'],
      customUrls: [],
    });
  }
}

/**
 * @param {Partial<MusicConfig>} next
 * @returns {MusicConfig}
 */
export function writeConfig(next = {}) {
  const prev = readConfig();
  const merged = normalizeConfig({
    enabled: next.enabled != null ? next.enabled : prev.enabled,
    activeIds: next.activeIds != null ? next.activeIds : prev.activeIds,
    customUrls: next.customUrls != null ? next.customUrls : prev.customUrls,
  });
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(merged));
  } catch {
    /* ignore quota / private mode */
  }
  try {
    const detail = { ...merged };
    const target = globalThis.document || globalThis;
    target.dispatchEvent?.(new CustomEvent(EVENT, { detail }));
    if (target !== globalThis) {
      globalThis.dispatchEvent?.(new CustomEvent(EVENT, { detail }));
    }
  } catch {
    /* ignore */
  }
  return merged;
}

/**
 * Ordered URL list: active library tracks (library order) + custom URLs.
 * When disabled, returns [] so the player can no-op.
 *
 * @param {MusicLibrary|null|undefined} library
 * @param {MusicConfig|null|undefined} config
 * @returns {string[]}
 */
export function resolvePlaylist(library, config) {
  const cfg = normalizeConfig(config);
  if (!cfg.enabled) return [];

  const tracks = Array.isArray(library?.tracks) ? library.tracks : [];
  const idSet = new Set(
    cfg.activeIds.length
      ? cfg.activeIds
      : asStringList(library?.defaultActiveIds),
  );

  /** Prefer library order when filtering by active ids. */
  const fromLib = [];
  if (idSet.size) {
    for (const t of tracks) {
      if (idSet.has(t.id) && t.url) fromLib.push(String(t.url));
    }
  } else {
    for (const t of tracks) {
      if (t.url) fromLib.push(String(t.url));
    }
  }

  const customs = cfg.customUrls.filter(isAllowedMusicUrl);
  const urls = [...fromLib, ...customs];
  return urls.length ? urls : [...FALLBACK_URLS];
}

/**
 * Async helper used by the left-yt speaker.
 * @returns {Promise<string[]>}
 */
export async function getPlaylistUrls() {
  const config = readConfig();
  if (!config.enabled) return [];
  try {
    const library = await loadLibrary();
    return resolvePlaylist(library, config);
  } catch (err) {
    console.warn('[royalty-free-music] library load failed; using fallback', err);
    if (!config.enabled) return [];
    const customs = config.customUrls.filter(isAllowedMusicUrl);
    if (customs.length || config.activeIds.length) {
      // Still honor custom URLs even if library.json failed.
      const urls = [...FALLBACK_URLS.filter((u) => {
        // Keep fallbacks that match selected ids by filename when possible.
        const id = u.replace(/^.*\//, '').replace(/\.mp3$/i, '');
        return !config.activeIds.length || config.activeIds.includes(id);
      }), ...customs];
      return urls.length ? urls : [...FALLBACK_URLS, ...customs];
    }
    return [...FALLBACK_URLS];
  }
}

export default {
  STORAGE_KEY,
  EVENT,
  FALLBACK_URLS,
  loadLibrary,
  readConfig,
  writeConfig,
  resolvePlaylist,
  getPlaylistUrls,
  isAllowedMusicUrl,
  normalizeConfig,
};
