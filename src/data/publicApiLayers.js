/**
 * DATA-panel layers selected from the public-apis catalog filter.
 * @module publicApiLayers
 */

import { PUBLIC_API_LAYER_IDS } from './publicApiCatalog.js';
import {
  aqicnLayer,
  aviationapiLayer,
  idigbioLayer,
  luchtmeetnetLayer,
  npsLayer,
  pm25Layer,
  purpleairLayer,
  refugeLayer,
  ridbLayer,
} from './catalogCollections.js';
import gbifLayer from './gbif.js';
import nwsAlertsLayer from './nwsAlerts.js';
import openChargeMapLayer from './openChargeMap.js';
import openaqLayer from './openaq.js';
import openSenseMapLayer from './openSenseMap.js';
import usgsWaterLayer from './usgsWater.js';

export const PUBLIC_API_LAYERS = Object.freeze([
  aqicnLayer,
  aviationapiLayer,
  gbifLayer,
  idigbioLayer,
  luchtmeetnetLayer,
  npsLayer,
  nwsAlertsLayer,
  openChargeMapLayer,
  openaqLayer,
  openSenseMapLayer,
  pm25Layer,
  purpleairLayer,
  refugeLayer,
  ridbLayer,
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
