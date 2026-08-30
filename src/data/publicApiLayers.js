/**
 * DATA-panel layers selected from the public-apis catalog filter.
 * @module publicApiLayers
 */

import { PUBLIC_API_LAYER_IDS } from './publicApiCatalog.js';
import gbifLayer from './gbif.js';
import nwsAlertsLayer from './nwsAlerts.js';
import openChargeMapLayer from './openChargeMap.js';
import openaqLayer from './openaq.js';
import openSenseMapLayer from './openSenseMap.js';
import usgsWaterLayer from './usgsWater.js';

export const PUBLIC_API_LAYERS = Object.freeze([
  gbifLayer,
  nwsAlertsLayer,
  openChargeMapLayer,
  openaqLayer,
  openSenseMapLayer,
  usgsWaterLayer,
]);

const BY_ID = new Map(PUBLIC_API_LAYERS.map((layer) => [layer.id, layer]));

/**
 * @param {string} id
 * @returns {object|undefined}
 */
export function publicApiLayerById(id) {
  return BY_ID.get(id);
}

export { PUBLIC_API_LAYER_IDS };

export default PUBLIC_API_LAYERS;
