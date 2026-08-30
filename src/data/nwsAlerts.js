/**
 * NWS active weather alerts — centroids of alert geometries.
 * @module nwsAlerts
 */

import { createCatalogGeoLayer } from './catalogGeoLayer.js';

export const NWS_ALERTS_ENDPOINT = '/api/nws-alerts';

function centroidOfCoordinates(coords) {
  if (!Array.isArray(coords) || !coords.length) return null;
  const first = coords[0];
  if (typeof first === 'number') {
    const lon = Number(coords[0]);
    const lat = Number(coords[1]);
    return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
  }
  let latSum = 0;
  let lonSum = 0;
  let n = 0;
  const walk = (node) => {
    if (!Array.isArray(node) || !node.length) return;
    if (typeof node[0] === 'number') {
      const lon = Number(node[0]);
      const lat = Number(node[1]);
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        latSum += lat;
        lonSum += lon;
        n += 1;
      }
      return;
    }
    for (const child of node) walk(child);
  };
  walk(coords);
  if (!n) return null;
  return { lat: latSum / n, lon: lonSum / n };
}

/**
 * @param {object} payload
 * @returns {Array<{id: string, lat: number, lon: number, title: string, subtitle: string}>}
 */
export function parseNwsAlertsPayload(payload) {
  const features = Array.isArray(payload?.features) ? payload.features : [];
  const records = [];
  for (const feature of features) {
    const point = centroidOfCoordinates(feature?.geometry?.coordinates)
      || {
        lat: Number(feature?.properties?.latitude),
        lon: Number(feature?.properties?.longitude),
      };
    if (!Number.isFinite(point.lat) || !Number.isFinite(point.lon)) continue;
    const props = feature.properties || {};
    records.push({
      id: `nws-${feature.id || records.length}`,
      lat: point.lat,
      lon: point.lon,
      title: String(props.event || props.headline || 'Weather alert').slice(0, 48),
      subtitle: String(props.areaDesc || props.severity || ''),
    });
  }
  return records;
}

export function createNwsAlertsLayer(options = {}) {
  return createCatalogGeoLayer({
    id: 'nws-alerts',
    name: 'NWS Alerts',
    icon: '!',
    source: 'US NWS',
    color: '#ff922b',
    endpoint: NWS_ALERTS_ENDPOINT,
    parsePayload: parseNwsAlertsPayload,
    requiresKey: false,
    ...options,
  });
}

const nwsAlertsLayer = createNwsAlertsLayer();
export default nwsAlertsLayer;
