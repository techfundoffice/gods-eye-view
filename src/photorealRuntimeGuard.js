/**
 * Google can resolve the Photorealistic 3D tileset manifest while every
 * content request is blocked or stalled. In that state Cesium has already
 * hidden its ellipsoid, leaving a black Earth. Require evidence that at least
 * one tile reached the renderer and fall back to a visible globe otherwise.
 */
export function guardPhotorealRendering({
  tileset,
  mapStackController,
  viewer,
  timeoutMs = 8000,
  maxTileFailures = 3,
  setTimeoutFn = globalThis.setTimeout,
  clearTimeoutFn = globalThis.clearTimeout,
  onFallback = null,
} = {}) {
  if (!tileset || !mapStackController || !viewer || typeof setTimeoutFn !== 'function') {
    return () => {};
  }

  let settled = false;
  let failures = 0;
  let timer = null;
  let removeVisible = null;
  let removeFailed = null;

  const dispose = () => {
    if (timer != null) clearTimeoutFn?.(timer);
    timer = null;
    removeVisible?.();
    removeFailed?.();
    removeVisible = null;
    removeFailed = null;
  };

  const confirmVisible = () => {
    if (settled) return;
    settled = true;
    dispose();
  };

  const fallback = async (reason) => {
    if (settled) return;
    if (mapStackController.getActiveId?.() !== 'photoreal') {
      settled = true;
      dispose();
      return;
    }
    settled = true;
    dispose();
    console.warn(`[MapStack] Google 3D rendered no usable tiles (${reason}); switching to OSM.`);
    const state = await mapStackController.setStack('osm');
    viewer.scene?.requestRender?.();
    console.info(`[MapStack] Visible fallback active: ${state?.activeId || mapStackController.getActiveId?.() || 'unknown'}.`);
    onFallback?.(reason);
  };

  removeVisible = tileset.tileVisible?.addEventListener?.(confirmVisible) || null;
  removeFailed = tileset.tileFailed?.addEventListener?.(() => {
    failures += 1;
    if (failures >= maxTileFailures) void fallback('tile requests failed');
  }) || null;
  timer = setTimeoutFn(() => void fallback('startup timed out'), timeoutMs);

  return dispose;
}