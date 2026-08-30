/**
 * USGS Water Services — river and lake monitoring sites.
 * @module usgsWater
 */

import { createCatalogGeoLayer } from './catalogGeoLayer.js';

export const USGS_WATER_ENDPOINT = '/api/usgs-water';

/**
 * @param {object} payload
 * @returns {Array<{id: string, lat: number, lon: number, title: string, subtitle: string}>}
 */
export function parseUsgsWaterPayload(payload) {
  const series = payload?.value?.timeSeries;
  const rows = Array.isArray(series) ? series
    : Array.isArray(payload?.sites) ? payload.sites
      : [];
  const records = [];
  const seen = new Set();
  for (const row of rows) {
    const geo = row?.sourceInfo?.geoLocation?.geogLocation
      || row?.geoLocation
      || {};
    const lat = Number(geo.latitude ?? row.lat);
    const lon = Number(geo.longitude ?? row.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const siteId = String(row?.sourceInfo?.siteCode?.[0]?.value || row.id || `${lat},${lon}`);
    if (seen.has(siteId)) continue;
    seen.add(siteId);
    records.push({
      id: `nwis-${siteId}`,
      lat,
      lon,
      title: String(row?.sourceInfo?.siteName || row.name || 'USGS site').slice(0, 48),
      subtitle: String(row?.variable?.variableName || row.variable || 'water'),
    });
  }
  return records;
}

export function createUsgsWaterLayer(options = {}) {
  return createCatalogGeoLayer({
    id: 'usgs-water',
    name: 'USGS Water Sites',
    icon: '≈',
    source: 'USGS NWIS',
    color: '#4dabf7',
    endpoint: USGS_WATER_ENDPOINT,
    parsePayload: parseUsgsWaterPayload,
    requiresKey: false,
    ...options,
  });
}

const usgsWaterLayer = createUsgsWaterLayer();
export default usgsWaterLayer;
