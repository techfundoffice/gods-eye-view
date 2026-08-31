import { normalizeNaturalHazards } from './data/naturalHazardContract.js';

export const NATURAL_HAZARD_SOURCES = Object.freeze({
  eonet: 'https://eonet.gsfc.nasa.gov/api/v3/events?status=open&limit=200',
  usgs: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson',
  fema: 'https://www.fema.gov/api/open/v2/DisasterDeclarationsSummaries?$top=100&$orderby=declarationDate%20desc',
  reliefweb: 'https://api.reliefweb.int/v2/reports?appname=godseyeview&profile=list&preset=latest&limit=100',
});
export const NATURAL_HAZARD_CACHE_MS = 5 * 60_000;
export const NATURAL_HAZARD_TIMEOUT_MS = 12_000;
export const NATURAL_HAZARD_MAX_BYTES = 1_000_000;

export async function readJsonCapped(response, maxBytes = NATURAL_HAZARD_MAX_BYTES) {
  const length = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(length) && length > maxBytes) throw new Error('upstream response too large');
  if (!response.body?.getReader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error('upstream response too large');
    return JSON.parse(new TextDecoder().decode(bytes));
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error('upstream response too large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export function coalesceNaturalHazardRequest(inFlight, key, create) {
  if (inFlight.has(key)) return inFlight.get(key);
  const promise = Promise.resolve().then(create).finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}

export function createNaturalHazardsProxy({
  fetchImpl = fetch,
  now = () => Date.now(),
  cacheMs = NATURAL_HAZARD_CACHE_MS,
  timeoutMs = NATURAL_HAZARD_TIMEOUT_MS,
  maxBytes = NATURAL_HAZARD_MAX_BYTES,
  urls = NATURAL_HAZARD_SOURCES,
} = {}) {
  const cache = new Map();
  const inFlight = new Map();
  async function refresh(name) {
    const response = await fetchImpl(urls[name], {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`upstream HTTP ${response.status}`);
    const body = await readJsonCapped(response, maxBytes);
    const fetchedAt = now();
    cache.set(name, { body, fetchedAt });
    return { body, status: 'fresh', fetchedAt };
  }
  async function getSource(name) {
    const cached = cache.get(name);
    if (cached && now() - cached.fetchedAt < cacheMs) return { body: cached.body, status: 'cached', fetchedAt: cached.fetchedAt };
    try {
      return await coalesceNaturalHazardRequest(inFlight, name, () => refresh(name));
    } catch {
      if (cached) return { body: cached.body, status: 'stale', fetchedAt: cached.fetchedAt };
      return { body: null, status: 'unavailable', fetchedAt: null };
    }
  }
  async function getPayload() {
    const entries = await Promise.all(Object.keys(urls).map(async (name) => [name, await getSource(name)]));
    const byName = Object.fromEntries(entries);
    const normalized = normalizeNaturalHazards({
      eonet: byName.eonet.body, usgs: byName.usgs.body, fema: byName.fema.body, reliefweb: byName.reliefweb.body,
    });
    return {
      ...normalized,
      generatedAt: new Date(now()).toISOString(),
      sources: Object.fromEntries(entries.map(([name, value]) => [name, {
        status: value.status,
        fetchedAt: value.fetchedAt === null ? null : new Date(value.fetchedAt).toISOString(),
      }])),
    };
  }
  return { getPayload, cache, inFlight };
}

export function naturalHazardsProxy(options) {
  const proxy = createNaturalHazardsProxy(options);
  return async function handleNaturalHazards(req, res) {
    const payload = await proxy.getPayload();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(payload));
  };
}