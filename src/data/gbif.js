/**
 * GBIF — recent georeferenced biodiversity occurrences.
 * @module gbif
 */

import { createCatalogGeoLayer } from './catalogGeoLayer.js';

export const GBIF_ENDPOINT = '/api/gbif';

/**
 * @param {object} payload
 * @returns {Array<{id: string, lat: number, lon: number, title: string, subtitle: string}>}
 */
export function parseGbifPayload(payload) {
  const rows = Array.isArray(payload?.results) ? payload.results : [];
  const records = [];
  for (const row of rows) {
    const lat = Number(row.decimalLatitude ?? row.lat);
    const lon = Number(row.decimalLongitude ?? row.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    records.push({
      id: `gbif-${row.key ?? row.gbifID ?? records.length}`,
      lat,
      lon,
      title: String(row.scientificName || row.species || 'Occurrence').slice(0, 48),
      subtitle: String(row.country || row.datasetName || ''),
    });
  }
  return records;
}

export function createGbifLayer(options = {}) {
  return createCatalogGeoLayer({
    id: 'gbif',
    name: 'Biodiversity (GBIF)',
    icon: '◈',
    source: 'GBIF',
    color: '#8ce99a',
    endpoint: GBIF_ENDPOINT,
    parsePayload: parseGbifPayload,
    requiresKey: false,
    ...options,
  });
}

const gbifLayer = createGbifLayer();
export default gbifLayer;
