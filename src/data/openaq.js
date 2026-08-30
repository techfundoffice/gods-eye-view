/**
 * OpenAQ v3 locations — global air-quality stations.
 * @module openaq
 */

import { createCatalogGeoLayer } from './catalogGeoLayer.js';

export const OPENAQ_ENDPOINT = '/api/openaq';

/**
 * @param {object} payload
 * @returns {Array<{id: string, lat: number, lon: number, title: string, subtitle: string}>}
 */
export function parseOpenAqPayload(payload) {
  const rows = Array.isArray(payload?.results) ? payload.results
    : Array.isArray(payload?.locations) ? payload.locations
      : [];
  const records = [];
  for (const row of rows) {
    const lat = Number(row?.coordinates?.latitude ?? row?.lat);
    const lon = Number(row?.coordinates?.longitude ?? row?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    records.push({
      id: `openaq-${row.id ?? records.length}`,
      lat,
      lon,
      title: String(row.name || row.locality || 'OpenAQ station').slice(0, 48),
      subtitle: String(row.country?.name || row.country || ''),
    });
  }
  return records;
}

export function createOpenAqLayer(options = {}) {
  return createCatalogGeoLayer({
    id: 'openaq',
    name: 'Air Quality (OpenAQ)',
    icon: '◌',
    source: 'OpenAQ',
    color: '#7ce8a4',
    endpoint: OPENAQ_ENDPOINT,
    parsePayload: parseOpenAqPayload,
    requiresKey: true,
    ...options,
  });
}

const openaqLayer = createOpenAqLayer();
export default openaqLayer;
