/**
 * Identify the transient worker-module failure Cesium can surface when the
 * preview server or its proxy reconnects while geometry is being scheduled.
 *
 * @param {*} error - Value emitted through Scene.renderError.
 * @returns {boolean}
 */
export function isTransientCesiumWorkerImportError(error) {
  const message = typeof error === 'string'
    ? error
    : String(error?.message || error?.error || '');
  return /Failed to fetch dynamically imported module:/i.test(message)
    && /\/cesium\/Workers\/[^?\s]+\.js(?:[?\s]|$)/i.test(message);
}