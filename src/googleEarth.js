/**
 * Google Earth on this globe is Map Tiles Photorealistic 3D Tiles — Cesium's
 * `createGooglePhotorealistic3DTileset` path — not the discontinued Earth Plugin.
 *
 * Status and enablement stay Cesium-free so ADMIN and unit tests can report
 * KEY REQUIRED vs LOAD FAILED vs DISPLAYING without a WebGL context.
 *
 * @module googleEarth
 */

/** Map-stack id for the Google photoreal tileset. */
export const GOOGLE_EARTH_STACK_ID = 'photoreal';

/** Operator-facing Google Earth states. Missing-key is never LOAD FAILED. */
export const GOOGLE_EARTH_STATUS = Object.freeze({
  KEY_REQUIRED: 'KEY REQUIRED',
  LOAD_FAILED: 'LOAD FAILED',
  DISPLAYING: 'DISPLAYING',
  AVAILABLE: 'AVAILABLE',
});

/**
 * @param {unknown} value Candidate API key.
 * @returns {boolean} Whether the value can actually request Map Tiles.
 */
export function hasUsableGoogleMapsKey(value) {
  const key = String(value ?? '').trim();
  return key.length > 0 && key !== 'your_google_maps_api_key_here';
}

/**
 * @param {object|null|undefined} tileset Cesium3DTileset or a test stand-in.
 * @returns {boolean}
 */
export function isGoogleEarthTilesetLive(tileset) {
  if (!tileset) return false;
  if (typeof tileset.isDestroyed === 'function' && tileset.isDestroyed()) return false;
  return true;
}

/**
 * @param {object} [input]
 * @param {object|null} [input.tileset]
 * @param {string|null} [input.activeStackId]
 * @param {boolean|null} [input.globeShown]
 * @returns {boolean} True only when Google photoreal tiles are the visible Earth.
 */
export function isGoogleEarthDisplaying({
  tileset = null,
  activeStackId = null,
  globeShown = null,
} = {}) {
  if (!isGoogleEarthTilesetLive(tileset)) return false;
  if (tileset.show === false) return false;
  if (activeStackId && activeStackId !== GOOGLE_EARTH_STACK_ID) return false;
  if (globeShown === true) return false;
  return true;
}

/**
 * Why the photoreal stack cannot be picked. Shared by the map-stack chip
 * tooltip and the ADMIN plugin so they never invent different reasons.
 *
 * @param {object} [input]
 * @param {boolean} [input.keyPresent]
 * @param {string|null} [input.loadError]
 * @returns {string}
 */
export function googleEarthUnavailableReason({ keyPresent = false, loadError = null } = {}) {
  if (!keyPresent) return 'KEY REQUIRED · GOOGLE_MAPS_API_KEY';
  const detail = String(loadError || '').trim();
  return detail || 'Google Photorealistic 3D Tiles failed to load';
}

/**
 * Honest operator status for the Google Earth globe.
 *
 * @param {object} [input]
 * @param {unknown} [input.googleApiKey]
 * @param {object|null} [input.tileset]
 * @param {string|null} [input.activeStackId]
 * @param {string|null} [input.loadError]
 * @param {boolean|null} [input.globeShown]
 * @returns {{
 *   state: string,
 *   label: string,
 *   displaying: boolean,
 *   available: boolean,
 *   keyPresent: boolean,
 *   tilesetLoaded: boolean,
 *   activeStack: string|null,
 *   detail: string,
 * }}
 */
export function getGoogleEarthStatus({
  googleApiKey = '',
  tileset = null,
  activeStackId = null,
  loadError = null,
  globeShown = null,
} = {}) {
  const keyPresent = hasUsableGoogleMapsKey(googleApiKey);
  const tilesetLoaded = isGoogleEarthTilesetLive(tileset);
  const displaying = isGoogleEarthDisplaying({ tileset, activeStackId, globeShown });

  let state;
  let detail;
  if (!keyPresent && !tilesetLoaded) {
    state = GOOGLE_EARTH_STATUS.KEY_REQUIRED;
    detail = 'GOOGLE_MAPS_API_KEY is not set. Map Tiles API is required to display Google Earth.';
  } else if (!tilesetLoaded) {
    state = GOOGLE_EARTH_STATUS.LOAD_FAILED;
    detail = googleEarthUnavailableReason({ keyPresent, loadError });
  } else if (displaying) {
    state = GOOGLE_EARTH_STATUS.DISPLAYING;
    detail = 'Google Photorealistic 3D Tiles (Google Earth) are the visible globe.';
  } else {
    state = GOOGLE_EARTH_STATUS.AVAILABLE;
    detail = 'Google Earth tileset is loaded. Activate to show it on the globe.';
  }

  return {
    state,
    label: state,
    displaying,
    available: tilesetLoaded,
    keyPresent,
    tilesetLoaded,
    activeStack: activeStackId || null,
    detail,
  };
}

/**
 * Read the live globe's Google Earth inputs from `window.__godsEyeView`.
 *
 * @param {object} [source] Window-like object; defaults to `globalThis`.
 * @returns {object}
 */
export function readGoogleEarthRuntime(source = globalThis) {
  const root = source?.window && source.window.__godsEyeView ? source.window : source;
  const gev = root?.__godsEyeView || {};
  const key = gev.googleApiKey ?? root?.__GOOGLE_MAPS_API_KEY__ ?? '';
  const controller = gev.mapStackController || null;
  const viewer = gev.viewer || null;
  return {
    googleApiKey: key,
    tileset: gev.tileset || null,
    mapStackController: controller,
    viewer,
    loadError: gev.googleEarthLoadError || null,
    activeStackId: controller?.getActiveId?.() || null,
    globeShown: viewer?.scene?.globe?.show,
  };
}

/**
 * Switch the globe onto the photoreal / Google Earth stack when a tileset exists.
 *
 * @param {object} [runtime] Output of `readGoogleEarthRuntime` or a test double.
 * @returns {Promise<{ok: boolean, displaying: boolean, error: string, status: object, activeStack: string|null}>}
 */
export async function enableGoogleEarth(runtime = {}) {
  const mapStackController = runtime.mapStackController || null;
  const tileset = runtime.tileset || null;
  const googleApiKey = runtime.googleApiKey;
  const loadError = runtime.loadError || null;
  const activeStackId = mapStackController?.getActiveId?.() ?? runtime.activeStackId ?? null;
  const globeShown = runtime.viewer?.scene?.globe?.show ?? runtime.globeShown;

  const before = getGoogleEarthStatus({
    googleApiKey,
    tileset,
    activeStackId,
    loadError,
    globeShown,
  });

  if (!before.available) {
    return {
      ok: false,
      displaying: false,
      error: before.detail,
      status: before,
      activeStack: before.activeStack,
    };
  }
  if (!mapStackController || typeof mapStackController.setStack !== 'function') {
    return {
      ok: false,
      displaying: false,
      error: 'Map stack controller is not available.',
      status: before,
      activeStack: before.activeStack,
    };
  }

  const state = await mapStackController.setStack(GOOGLE_EARTH_STACK_ID);
  const afterStack = state?.activeId ?? mapStackController.getActiveId?.() ?? null;
  const afterGlobe = runtime.viewer?.scene?.globe?.show
    ?? (afterStack === GOOGLE_EARTH_STACK_ID ? false : globeShown);
  const after = getGoogleEarthStatus({
    googleApiKey,
    tileset,
    activeStackId: afterStack,
    loadError: state?.lastError || loadError,
    globeShown: afterGlobe,
  });
  const displaying = after.displaying === true;
  return {
    ok: displaying,
    displaying,
    error: displaying ? '' : (state?.lastError || after.detail),
    status: after,
    activeStack: after.activeStack,
  };
}
