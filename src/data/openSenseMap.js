/**
 * openSenseMap — outdoor senseBox weather stations.
 * @module openSenseMap
 */

import { createCatalogGeoLayer } from './catalogGeoLayer.js';

export const OPEN_SENSE_MAP_ENDPOINT = '/api/opensensemap';

/**
 * @param {object|Array} payload
 * @returns {Array<{id: string, lat: number, lon: number, title: string, subtitle: string}>}
 */
export function parseOpenSenseMapPayload(payload) {
  const rows = Array.isArray(payload) ? payload
    : Array.isArray(payload?.boxes) ? payload.boxes
      : [];
  const records = [];
  for (const row of rows) {
    const coords = row?.currentLocation?.coordinates
      || row?.loc?.coordinates
      || [];
    const lon = Number(coords[0] ?? row.lon);
    const lat = Number(coords[1] ?? row.lat);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    records.push({
      id: `sensebox-${row._id || row.id || records.length}`,
      lat,
      lon,
      title: String(row.name || 'senseBox').slice(0, 48),
      subtitle: String(row.exposure || ''),
    });
  }
  return records;
}

export function createOpenSenseMapLayer(options = {}) {
  return createCatalogGeoLayer({
    id: 'opensensemap',
    name: 'SenseBoxes',
    icon: '▣',
    source: 'openSenseMap',
    color: '#ffd43b',
    endpoint: OPEN_SENSE_MAP_ENDPOINT,
    parsePayload: parseOpenSenseMapPayload,
    requiresKey: false,
    ...options,
  });
}

const openSenseMapLayer = createOpenSenseMapLayer();
export default openSenseMapLayer;
