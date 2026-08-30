/**
 * Open Charge Map — public EV charging locations.
 * @module openChargeMap
 */

import { createCatalogGeoLayer } from './catalogGeoLayer.js';

export const OPEN_CHARGE_MAP_ENDPOINT = '/api/open-charge-map';

/**
 * @param {object|Array} payload
 * @returns {Array<{id: string, lat: number, lon: number, title: string, subtitle: string}>}
 */
export function parseOpenChargeMapPayload(payload) {
  const rows = Array.isArray(payload) ? payload
    : Array.isArray(payload?.results) ? payload.results
      : [];
  const records = [];
  for (const row of rows) {
    const info = row?.AddressInfo || row?.addressInfo || {};
    const lat = Number(info.Latitude ?? info.latitude ?? row.lat);
    const lon = Number(info.Longitude ?? info.longitude ?? row.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    records.push({
      id: `ocm-${row.ID ?? row.id ?? records.length}`,
      lat,
      lon,
      title: String(info.Title || info.title || 'EV charger').slice(0, 48),
      subtitle: String(info.Town || info.town || info.Country?.Title || ''),
    });
  }
  return records;
}

export function createOpenChargeMapLayer(options = {}) {
  return createCatalogGeoLayer({
    id: 'open-charge-map',
    name: 'EV Chargers',
    icon: '⚡',
    source: 'Open Charge Map',
    color: '#4dabf7',
    endpoint: OPEN_CHARGE_MAP_ENDPOINT,
    parsePayload: parseOpenChargeMapPayload,
    requiresKey: false,
    ...options,
  });
}

const openChargeMapLayer = createOpenChargeMapLayer();
export default openChargeMapLayer;
