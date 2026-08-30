/**
 * Additional catalog-selected locatable-collection layers.
 * @module catalogCollections
 */

import { createCatalogGeoLayer } from './catalogGeoLayer.js';

export function parsePurpleAirPayload(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  const fields = Array.isArray(payload?.fields) ? payload.fields : [];
  const latI = fields.indexOf('latitude');
  const lonI = fields.indexOf('longitude');
  const nameI = fields.indexOf('name');
  const records = [];
  if (latI < 0 || lonI < 0) {
    for (const row of Array.isArray(payload?.results) ? payload.results : []) {
      const lat = Number(row.latitude ?? row.lat);
      const lon = Number(row.longitude ?? row.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      records.push({
        id: `purpleair-${row.sensor_index ?? records.length}`,
        lat,
        lon,
        title: String(row.name || 'PurpleAir').slice(0, 48),
        subtitle: 'sensor',
      });
    }
    return records;
  }
  for (const row of rows) {
    const lat = Number(row[latI]);
    const lon = Number(row[lonI]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    records.push({
      id: `purpleair-${records.length}`,
      lat,
      lon,
      title: String(nameI >= 0 ? row[nameI] : 'PurpleAir').slice(0, 48),
      subtitle: 'sensor',
    });
  }
  return records;
}

export function parseIdigbioPayload(payload) {
  const items = Array.isArray(payload?.items) ? payload.items
    : Array.isArray(payload?.hits) ? payload.hits
      : [];
  const records = [];
  for (const item of items) {
    const idx = item?.indexTerms || item;
    const geo = idx?.geopoint || idx?.geoPoint || {};
    const lat = Number(geo.lat ?? geo.latitude ?? idx.lat);
    const lon = Number(geo.lon ?? geo.longitude ?? idx.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    records.push({
      id: `idigbio-${idx.uuid || item.uuid || records.length}`,
      lat,
      lon,
      title: String(idx.scientificname || idx.scientificName || 'Specimen').slice(0, 48),
      subtitle: String(idx.country || ''),
    });
  }
  return records;
}

export function parseAqicnPayload(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  const records = [];
  for (const row of rows) {
    const lat = Number(row?.lat);
    const lon = Number(row?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    records.push({
      id: `aqicn-${row.uid ?? records.length}`,
      lat,
      lon,
      title: String(row.station?.name || 'AQI station').slice(0, 48),
      subtitle: String(row.aqi ?? ''),
    });
  }
  return records;
}

export function parseLuchtmeetnetPayload(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  const records = [];
  for (const row of rows) {
    const coords = row?.geometry?.coordinates || [];
    const lon = Number(coords[0] ?? row.longitude);
    const lat = Number(coords[1] ?? row.latitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    records.push({
      id: `lucht-${row.number ?? row.id ?? records.length}`,
      lat,
      lon,
      title: String(row.location || row.name || 'RIVM station').slice(0, 48),
      subtitle: 'NL',
    });
  }
  return records;
}

export function parsePm25Payload(payload) {
  const feeds = payload?.feeds || payload?.devices || payload;
  const rows = Array.isArray(feeds) ? feeds : [];
  const records = [];
  for (const row of rows) {
    const lat = Number(row.gps_lat ?? row.LatLng?.lat ?? row.lat);
    const lon = Number(row.gps_lon ?? row.LatLng?.lng ?? row.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    records.push({
      id: `pm25-${row.device_id ?? row.SiteName ?? records.length}`,
      lat,
      lon,
      title: String(row.SiteName || row.device || 'PM2.5').slice(0, 48),
      subtitle: String(row.s_d0 ?? row.pm25 ?? ''),
    });
  }
  return records;
}

export function parseRefugePayload(payload) {
  const rows = Array.isArray(payload) ? payload : [];
  const records = [];
  for (const row of rows) {
    const lat = Number(row.latitude);
    const lon = Number(row.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    records.push({
      id: `refuge-${row.id ?? records.length}`,
      lat,
      lon,
      title: String(row.name || 'Restroom').slice(0, 48),
      subtitle: String(row.city || ''),
    });
  }
  return records;
}

export function parseAviationApiPayload(payload) {
  const rows = Array.isArray(payload) ? payload
    : payload && typeof payload === 'object' ? Object.values(payload).flat()
      : [];
  const records = [];
  for (const row of rows) {
    const lat = Number(row.latitude ?? row.lat ?? row.ARP_LATITUDE);
    const lon = Number(row.longitude ?? row.lon ?? row.ARP_LONGITUDE);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    records.push({
      id: `faa-${row.faa_ident ?? row.icao_ident ?? records.length}`,
      lat,
      lon,
      title: String(row.facility_name || row.name || row.faa_ident || 'Airport').slice(0, 48),
      subtitle: String(row.city || row.state || ''),
    });
  }
  return records;
}

export function parseNpsPayload(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  const records = [];
  for (const row of rows) {
    const lat = Number(row.latitude);
    const lon = Number(row.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    records.push({
      id: `nps-${row.parkCode || records.length}`,
      lat,
      lon,
      title: String(row.name || 'Park').slice(0, 48),
      subtitle: String(row.states || ''),
    });
  }
  return records;
}

export function parseRidbPayload(payload) {
  const rows = Array.isArray(payload?.RECDATA) ? payload.RECDATA
    : Array.isArray(payload?.data) ? payload.data
      : [];
  const records = [];
  for (const row of rows) {
    const lat = Number(row.FacilityLatitude ?? row.latitude);
    const lon = Number(row.FacilityLongitude ?? row.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    records.push({
      id: `ridb-${row.FacilityID ?? records.length}`,
      lat,
      lon,
      title: String(row.FacilityName || 'Recreation').slice(0, 48),
      subtitle: String(row.FacilityTypeDescription || ''),
    });
  }
  return records;
}

export function createPurpleAirLayer(options = {}) {
  return createCatalogGeoLayer({
    id: 'purpleair', name: 'PurpleAir', icon: '◉', source: 'PurpleAir',
    color: '#cc5de8', endpoint: '/api/purpleair', parsePayload: parsePurpleAirPayload,
    requiresKey: true, ...options,
  });
}
export function createIdigbioLayer(options = {}) {
  return createCatalogGeoLayer({
    id: 'idigbio', name: 'iDigBio Specimens', icon: '◇', source: 'iDigBio',
    color: '#fab005', endpoint: '/api/idigbio', parsePayload: parseIdigbioPayload,
    requiresKey: false, ...options,
  });
}
export function createAqicnLayer(options = {}) {
  return createCatalogGeoLayer({
    id: 'aqicn', name: 'AQI Cities', icon: '◌', source: 'AQICN',
    color: '#ff6b6b', endpoint: '/api/aqicn', parsePayload: parseAqicnPayload,
    requiresKey: true, ...options,
  });
}
export function createLuchtmeetnetLayer(options = {}) {
  return createCatalogGeoLayer({
    id: 'luchtmeetnet', name: 'NL Air Quality', icon: '◌', source: 'Luchtmeetnet',
    color: '#69db7c', endpoint: '/api/luchtmeetnet', parsePayload: parseLuchtmeetnetPayload,
    requiresKey: false, ...options,
  });
}
export function createPm25Layer(options = {}) {
  return createCatalogGeoLayer({
    id: 'pm25-opendata', name: 'PM2.5 Sensors', icon: '◌', source: 'LASS PM2.5',
    color: '#e599f7', endpoint: '/api/pm25-opendata', parsePayload: parsePm25Payload,
    requiresKey: false, ...options,
  });
}
export function createRefugeLayer(options = {}) {
  return createCatalogGeoLayer({
    id: 'refuge-restrooms', name: 'REFUGE Restrooms', icon: '⌂', source: 'REFUGE',
    color: '#74c0fc', endpoint: '/api/refuge-restrooms', parsePayload: parseRefugePayload,
    requiresKey: false, ...options,
  });
}
export function createAviationApiLayer(options = {}) {
  return createCatalogGeoLayer({
    id: 'aviationapi', name: 'FAA Airports', icon: '✈', source: 'AviationAPI',
    color: '#91a7ff', endpoint: '/api/aviationapi', parsePayload: parseAviationApiPayload,
    requiresKey: false, ...options,
  });
}
export function createNpsLayer(options = {}) {
  return createCatalogGeoLayer({
    id: 'nps-parks', name: 'US National Parks', icon: '▲', source: 'NPS',
    color: '#51cf66', endpoint: '/api/nps-parks', parsePayload: parseNpsPayload,
    requiresKey: true, ...options,
  });
}
export function createRidbLayer(options = {}) {
  return createCatalogGeoLayer({
    id: 'ridb', name: 'Recreation Sites', icon: '⛺', source: 'RIDB',
    color: '#63e6be', endpoint: '/api/ridb', parsePayload: parseRidbPayload,
    requiresKey: true, ...options,
  });
}

export const purpleairLayer = createPurpleAirLayer();
export const idigbioLayer = createIdigbioLayer();
export const aqicnLayer = createAqicnLayer();
export const luchtmeetnetLayer = createLuchtmeetnetLayer();
export const pm25Layer = createPm25Layer();
export const refugeLayer = createRefugeLayer();
export const aviationapiLayer = createAviationApiLayer();
export const npsLayer = createNpsLayer();
export const ridbLayer = createRidbLayer();
