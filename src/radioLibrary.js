/**
 * Curated Radio Library for ADMIN Radio Library.
 * Featured stations the operator wants available alongside Radio Browser.
 *
 * @module radioLibrary
 */

export const EVENT = "gev:radio-library-changed";
export const STORAGE_KEY = "gev:radio-library-v1";

/**
 * @typedef {{
 *   id: string,
 *   name: string,
 *   url: string,
 *   homepage?: string,
 *   tags?: string,
 *   enabled: boolean,
 * }} RadioLibraryStation
 *
 * @typedef {{ version: number, stations: RadioLibraryStation[], updatedAt?: string }} RadioLibraryConfig
 */

/** @returns {RadioLibraryConfig} */
export function defaultConfig() {
  return {
    version: 1,
    stations: [
      {
        id: "demo-soma-groove",
        name: "SomaFM Groove Salad (demo entry — replace with your streams)",
        url: "https://ice1.somafm.com/groovesalad-128-mp3",
        homepage: "https://somafm.com/groovesalad/",
        tags: "music ambient",
        enabled: false,
      },
    ],
  };
}

/**
 * @param {unknown} raw
 * @returns {RadioLibraryStation | null}
 */
function normalizeStation(raw) {
  if (!raw || typeof raw !== "object") return null;
  const o = /** @type {any} */ (raw);
  const url = String(o.url || "").trim();
  const name = String(o.name || "").trim();
  if (!url || !name) return null;
  if (!(url.startsWith("https://") || url.startsWith("http://") || url.startsWith("/"))) {
    return null;
  }
  const id = String(o.id || "").trim() || `st-${Math.random().toString(36).slice(2, 10)}`;
  return {
    id,
    name,
    url,
    homepage: String(o.homepage || "").trim() || undefined,
    tags: String(o.tags || "").trim() || undefined,
    enabled: o.enabled !== false,
  };
}

/**
 * @param {unknown} raw
 * @returns {RadioLibraryConfig}
 */
export function normalizeConfig(raw) {
  const base = defaultConfig();
  if (!raw || typeof raw !== "object") return base;
  const list = Array.isArray(/** @type {any} */ (raw).stations)
    ? /** @type {any} */ (raw).stations
    : [];
  const stations = [];
  for (const row of list) {
    const st = normalizeStation(row);
    if (st) stations.push(st);
  }
  return {
    version: 1,
    stations,
    updatedAt: typeof /** @type {any} */ (raw).updatedAt === "string"
      ? /** @type {any} */ (raw).updatedAt
      : undefined,
  };
}

/** @returns {RadioLibraryConfig} */
export function readConfig() {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return defaultConfig();
    return normalizeConfig(JSON.parse(raw));
  } catch {
    return defaultConfig();
  }
}

/**
 * @param {RadioLibraryConfig} config
 * @returns {RadioLibraryConfig}
 */
export function writeConfig(config) {
  const next = normalizeConfig({
    ...config,
    updatedAt: new Date().toISOString(),
  });
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
  try {
    globalThis.document?.dispatchEvent?.(new CustomEvent(EVENT, { detail: next }));
    globalThis.dispatchEvent?.(new CustomEvent(EVENT, { detail: next }));
  } catch {
    /* ignore */
  }
  return next;
}

/** @returns {RadioLibraryStation[]} */
export function getEnabledStations() {
  return readConfig().stations.filter((s) => s.enabled);
}
