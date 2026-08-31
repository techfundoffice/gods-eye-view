/**
 * Pure normalization boundary for the Natural Hazards endpoint.  Nothing in
 * this module fetches data, reads the clock, or depends on browser APIs.
 */

export const HAZARD_LIMIT = 200;
export const CONTEXT_LIMIT = 100;

const EONET_CATEGORIES = new Map([
  ['wildfires', 'wildfire'],
  ['severe storms', 'severe-storm'],
  ['severestorms', 'severe-storm'],
  ['volcanoes', 'volcano'],
]);

function text(value, fallback = '') {
  const result = String(value ?? '').replace(/\s+/g, ' ').trim();
  return result || fallback;
}

export function safeUrl(value, fallback = null) {
  try {
    const url = new URL(String(value));
    return /^https?:$/.test(url.protocol) ? url.href : fallback;
  } catch {
    return fallback;
  }
}

export function normalizedCoordinates(value) {
  const lon = Number(Array.isArray(value) ? value[0] : value?.longitude ?? value?.lon);
  const lat = Number(Array.isArray(value) ? value[1] : value?.latitude ?? value?.lat);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { latitude: lat, longitude: lon };
}

export function normalizedTime(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = new Date(typeof value === 'number' ? value : String(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function source(name, url, attribution) {
  return { name, url, attribution };
}

function hazard(record) {
  if (!record.id || !record.category || !record.title || !record.coordinates || !record.startedAt) return null;
  return {
    id: String(record.id),
    category: record.category,
    title: record.title,
    coordinates: record.coordinates,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt || record.startedAt,
    source: record.source,
    ...(Number.isFinite(record.magnitude) ? { magnitude: record.magnitude } : {}),
    ...(Number.isFinite(record.depthKm) ? { depthKm: record.depthKm } : {}),
  };
}

export function normalizeEonet(payload) {
  const events = Array.isArray(payload?.events) ? payload.events : [];
  return events.map((event) => {
    const category = (event?.categories || [])
      .map((item) => EONET_CATEGORIES.get(String(item?.id || item?.title || '').toLowerCase().replace(/-/g, ' ')))
      .find(Boolean);
    const geometry = (event?.geometry || []).find((item) => item?.type === 'Point' && normalizedCoordinates(item.coordinates));
    const startedAt = normalizedTime(geometry?.date || event?.closed || event?.date);
    return hazard({
      id: event?.id ? `eonet:${event.id}` : null,
      category,
      title: text(event?.title),
      coordinates: normalizedCoordinates(geometry?.coordinates),
      startedAt,
      source: source('NASA EONET', safeUrl(event?.link, 'https://eonet.gsfc.nasa.gov/'), 'NASA Earth Observatory Natural Event Tracker'),
    });
  }).filter(Boolean);
}

export function normalizeUsgs(payload) {
  const features = Array.isArray(payload?.features) ? payload.features : [];
  return features.map((feature) => {
    const properties = feature?.properties || {};
    const coords = normalizedCoordinates(feature?.geometry?.coordinates);
    const depth = Number(feature?.geometry?.coordinates?.[2]);
    return hazard({
      id: feature?.id ? `usgs:${feature.id}` : null,
      category: 'earthquake',
      title: text(properties.title, 'Earthquake'),
      coordinates: coords,
      startedAt: normalizedTime(properties.time),
      updatedAt: normalizedTime(properties.updated) || normalizedTime(properties.time),
      magnitude: Number(properties.mag),
      depthKm: depth,
      source: source('USGS Earthquake Hazards Program', safeUrl(properties.url, 'https://earthquake.usgs.gov/'), 'U.S. Geological Survey'),
    });
  }).filter(Boolean);
}

function context(record) {
  if (!record.id || !record.type || !record.title || !record.publishedAt) return null;
  return {
    id: String(record.id),
    type: record.type,
    title: record.title,
    publishedAt: record.publishedAt,
    ...(record.coordinates ? { coordinates: record.coordinates } : {}),
    source: record.source,
  };
}

export function normalizeFema(payload) {
  const declarations = Array.isArray(payload?.DisasterDeclarationsSummaries)
    ? payload.DisasterDeclarationsSummaries : Array.isArray(payload?.value) ? payload.value : [];
  return declarations.map((item) => context({
    id: item?.disasterNumber ? `fema:${item.disasterNumber}:${text(item?.designatedArea, 'all')}` : null,
    type: 'declaration',
    title: text(item?.declarationTitle || item?.incidentType || item?.title, 'FEMA disaster declaration'),
    publishedAt: normalizedTime(item?.declarationDate || item?.incidentBeginDate),
    source: source('OpenFEMA', safeUrl(item?.declarationRequestNumber, 'https://www.fema.gov/openfema-data-page/disaster-declarations-summaries-v2'), 'Federal Emergency Management Agency'),
  })).filter(Boolean);
}

export function normalizeReliefWeb(payload) {
  const reports = Array.isArray(payload?.data) ? payload.data : [];
  return reports.map((item) => {
    const fields = item?.fields || item || {};
    const point = fields?.location?.[0]?.coordinates || fields?.primary_country?.location?.coordinates;
    return context({
      id: item?.id ? `reliefweb:${item.id}` : null,
      type: 'report',
      title: text(fields?.title, 'ReliefWeb report'),
      publishedAt: normalizedTime(fields?.date?.created || fields?.date?.original || fields?.date?.published),
      coordinates: normalizedCoordinates(point),
      source: source('ReliefWeb', safeUrl(fields?.url, 'https://reliefweb.int/'), 'United Nations Office for the Coordination of Humanitarian Affairs'),
    });
  }).filter(Boolean);
}

export function capAndDedupe(records, limit) {
  const seen = new Set();
  return records
    .filter(Boolean)
    .sort((a, b) => {
      const recent = Date.parse(b.updatedAt || b.startedAt || b.publishedAt || 0)
        - Date.parse(a.updatedAt || a.startedAt || a.publishedAt || 0);
      return recent || String(a.id).localeCompare(String(b.id));
    })
    .filter((record) => !seen.has(record.id) && seen.add(record.id))
    .slice(0, limit);
}

export function capHazardsByCategory(records, limit) {
  const categories = ['earthquake', 'wildfire', 'severe-storm', 'volcano'];
  const deduped = capAndDedupe(records, records.length);
  const boundedLimit = Math.max(0, Math.floor(Number(limit) || 0));
  const perCategory = Math.floor(boundedLimit / categories.length);
  const selected = [];
  const selectedIds = new Set();
  for (const category of categories) {
    for (const record of deduped.filter((item) => item.category === category).slice(0, perCategory)) {
      selected.push(record);
      selectedIds.add(record.id);
    }
  }
  for (const record of deduped) {
    if (selected.length >= boundedLimit) break;
    if (!selectedIds.has(record.id)) {
      selected.push(record);
      selectedIds.add(record.id);
    }
  }
  return capAndDedupe(selected, boundedLimit);
}

export function normalizeNaturalHazards({ eonet, usgs, fema, reliefweb } = {}, {
  hazardLimit = HAZARD_LIMIT,
  contextLimit = CONTEXT_LIMIT,
} = {}) {
  return {
    hazards: capHazardsByCategory([...normalizeEonet(eonet), ...normalizeUsgs(usgs)], hazardLimit),
    context: capAndDedupe([...normalizeFema(fema), ...normalizeReliefWeb(reliefweb)], contextLimit),
  };
}