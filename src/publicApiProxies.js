/**
 * Same-origin proxies for catalog-selected public geo APIs.
 * Secrets stay server-side. The browser never supplies an upstream URL.
 *
 * @module publicApiProxies
 */

import { naturalHazardsProxy } from './naturalHazardsProxy.js';

const USER_AGENT = 'GodsEyeView/1.0 (https://github.com/bilawalsidhu/gods-eye-view)';
const FETCH_MS = 20_000;
const MAX_LIMIT = 200;

/** USGS Instantaneous Values `bBox` product (lat span × lon span) must be ≤ 25. */
export const USGS_IV_BBOX_PRODUCT_MAX = 25;

function sendJson(res, status, obj) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

export function parseBbox(search) {
  const raw = String(search?.get?.('bbox') || search?.bbox || '').trim();
  if (!raw) return null;
  const parts = raw.split(',').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const [west, south, east, north] = parts;
  if (south < -90 || north > 90 || west < -180 || east > 180) return null;
  return { west, south, east, north };
}

/**
 * Shrink a camera bbox so USGS IV will accept it.
 *
 * The product of the latitude and longitude spans cannot exceed 25 square
 * degrees. A 10°×10° view (product 100) is clamped about its centre to 5°×5°.
 *
 * @param {{west: number, south: number, east: number, north: number}|null} bbox
 * @returns {{west: number, south: number, east: number, north: number}|null}
 */
export function clampUsgsIvBbox(bbox) {
  if (!bbox) return null;
  const latSpan = Math.abs(bbox.north - bbox.south);
  const lonSpan = Math.abs(bbox.east - bbox.west);
  const product = latSpan * lonSpan;
  if (!(product > 0) || !Number.isFinite(product)) return null;
  if (product <= USGS_IV_BBOX_PRODUCT_MAX) return { ...bbox };
  const scale = Math.sqrt(USGS_IV_BBOX_PRODUCT_MAX / product);
  const latHalf = (latSpan * scale) / 2;
  const lonHalf = (lonSpan * scale) / 2;
  const latC = (bbox.north + bbox.south) / 2;
  const lonC = (bbox.east + bbox.west) / 2;
  return {
    west: lonC - lonHalf,
    east: lonC + lonHalf,
    south: latC - latHalf,
    north: latC + latHalf,
  };
}

async function fetchJson(url, { headers = {} } = {}) {
  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': USER_AGENT, ...headers },
    signal: AbortSignal.timeout(FETCH_MS),
  });
  let body = {};
  try { body = await response.json(); } catch { body = { error: 'malformed upstream body' }; }
  return { ok: response.ok, status: response.status, body };
}

async function handleOpenAq(req, res, search) {
  const key = String(process.env.OPENAQ_API_KEY || '').trim();
  if (!key) {
    sendJson(res, 503, { error: 'no_key' });
    return;
  }
  const bbox = parseBbox(search);
  const url = new URL('https://api.openaq.org/v3/locations');
  url.searchParams.set('limit', String(MAX_LIMIT));
  if (bbox) {
    url.searchParams.set('bbox', `${bbox.west},${bbox.south},${bbox.east},${bbox.north}`);
  }
  const { status, body } = await fetchJson(url, { headers: { 'X-API-Key': key } });
  sendJson(res, status, body);
}

async function handleOpenChargeMap(req, res, search) {
  const key = String(process.env.OPEN_CHARGE_MAP_KEY || '').trim();
  const bbox = parseBbox(search);
  const url = new URL('https://api.openchargemap.io/v3/poi/');
  url.searchParams.set('output', 'json');
  url.searchParams.set('maxresults', String(MAX_LIMIT));
  url.searchParams.set('compact', 'true');
  url.searchParams.set('verbose', 'false');
  if (bbox) {
    url.searchParams.set('boundingbox', `(${bbox.south},${bbox.west}),(${bbox.north},${bbox.east})`);
  }
  const headers = {};
  if (key) headers['X-API-Key'] = key;
  const { status, body } = await fetchJson(url, { headers });
  sendJson(res, status, body);
}

async function handleGbif(req, res, search) {
  const bbox = parseBbox(search);
  const url = new URL('https://api.gbif.org/v1/occurrence/search');
  url.searchParams.set('hasCoordinate', 'true');
  url.searchParams.set('limit', String(MAX_LIMIT));
  if (bbox) {
    url.searchParams.set('decimalLatitude', `${bbox.south},${bbox.north}`);
    url.searchParams.set('decimalLongitude', `${bbox.west},${bbox.east}`);
  }
  const { status, body } = await fetchJson(url);
  sendJson(res, status, body);
}

async function handleUsgsWater(req, res, search) {
  const bbox = clampUsgsIvBbox(parseBbox(search));
  if (!bbox) {
    sendJson(res, 200, { value: { timeSeries: [] }, coverage: 'zoom-in' });
    return;
  }
  const url = new URL('https://waterservices.usgs.gov/nwis/iv/');
  url.searchParams.set('format', 'json');
  url.searchParams.set('siteStatus', 'active');
  url.searchParams.set('parameterCd', '00060');
  url.searchParams.set('siteType', 'ST');
  url.searchParams.set('bBox', `${bbox.west.toFixed(4)},${bbox.south.toFixed(4)},${bbox.east.toFixed(4)},${bbox.north.toFixed(4)}`);
  const { status, body } = await fetchJson(url);
  sendJson(res, status, body);
}

async function handleNwsAlerts(req, res) {
  const url = new URL('https://api.weather.gov/alerts/active');
  url.searchParams.set('status', 'actual');
  url.searchParams.set('limit', String(MAX_LIMIT));
  const { status, body } = await fetchJson(url);
  sendJson(res, status, body);
}

async function handleOpenSenseMap(req, res, search) {
  const bbox = parseBbox(search);
  if (!bbox) {
    sendJson(res, 200, { boxes: [], coverage: 'zoom-in' });
    return;
  }
  const url = new URL('https://api.opensensemap.org/boxes');
  url.searchParams.set('exposure', 'outdoor');
  url.searchParams.set('minimal', 'true');
  url.searchParams.set('bbox', `${bbox.west},${bbox.south},${bbox.east},${bbox.north}`);
  const { status, body } = await fetchJson(url);
  const boxes = Array.isArray(body) ? body.slice(0, MAX_LIMIT) : [];
  sendJson(res, status, { boxes, coverage: 'viewport' });
}

async function handlePurpleAir(req, res) {
  const key = String(process.env.PURPLEAIR_API_KEY || '').trim();
  if (!key) {
    sendJson(res, 503, { error: 'no_key' });
    return;
  }
  const url = new URL('https://api.purpleair.com/v1/sensors');
  url.searchParams.set('fields', 'name,latitude,longitude,pm2.5');
  url.searchParams.set('max_age', '3600');
  const { status, body } = await fetchJson(url, { headers: { 'X-API-Key': key } });
  sendJson(res, status, body);
}

async function handleIdigbio(req, res, search) {
  const bbox = parseBbox(search);
  const url = new URL('https://search.idigbio.org/v2/search/records');
  const rq = { geopoint: { type: 'exists' } };
  if (bbox) {
    rq.geopoint = {
      type: 'geo_bounding_box',
      top_left: { lat: bbox.north, lon: bbox.west },
      bottom_right: { lat: bbox.south, lon: bbox.east },
    };
  }
  url.searchParams.set('rq', JSON.stringify(rq));
  url.searchParams.set('limit', String(MAX_LIMIT));
  const { status, body } = await fetchJson(url);
  sendJson(res, status, body);
}

async function handleAqicn(req, res, search) {
  const token = String(process.env.AQICN_TOKEN || '').trim();
  if (!token) {
    sendJson(res, 503, { error: 'no_key' });
    return;
  }
  const bbox = parseBbox(search) || { west: -125, south: 24, east: -66, north: 50 };
  const url = new URL('https://api.waqi.info/map/bounds/');
  url.searchParams.set('latlng', `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`);
  url.searchParams.set('token', token);
  const { status, body } = await fetchJson(url);
  sendJson(res, status, body);
}

async function handleLuchtmeetnet(req, res) {
  const url = new URL('https://api.luchtmeetnet.nl/open_api/stations');
  const { status, body } = await fetchJson(url);
  sendJson(res, status, body);
}

async function handlePm25(req, res) {
  const url = new URL('https://pm25.lass-net.org/data/last-all-airbox.json');
  const { status, body } = await fetchJson(url);
  sendJson(res, status, body);
}

async function handleRefuge(req, res, search) {
  const bbox = parseBbox(search);
  const url = new URL('https://www.refugerestrooms.org/api/v1/restrooms.json');
  url.searchParams.set('per_page', String(Math.min(100, MAX_LIMIT)));
  if (bbox) {
    url.searchParams.set('lat', String((bbox.north + bbox.south) / 2));
    url.searchParams.set('lng', String((bbox.east + bbox.west) / 2));
  }
  const { status, body } = await fetchJson(url);
  sendJson(res, status, body);
}

const AVIATION_SAMPLE_AIRPORTS = 'ATL,ORD,DFW,DEN,LAX,CLT,MCO,LAS,PHX,MIA,SEA,IAH,JFK,EWR,SFO,MSP,DTW,BOS,PHL,LGA,FLL,BWI,IAD,TPA,SAN,MDW,HNL,SLC,DCA,PDX,AUS,STL,BNA,RDU,SMF,SJC,OAK,HOU,MCI,IND,CLE,PIT,CMH,MKE,SNA,OGG,RSW,BDL,JAX,BUF';

async function handleAviationApi(req, res) {
  const url = new URL('https://api.aviationapi.com/v1/airports');
  url.searchParams.set('apt', AVIATION_SAMPLE_AIRPORTS);
  const { status, body } = await fetchJson(url);
  sendJson(res, status, body);
}

async function handleNps(req, res) {
  const key = String(process.env.NPS_API_KEY || '').trim();
  if (!key) {
    sendJson(res, 503, { error: 'no_key' });
    return;
  }
  const url = new URL('https://developer.nps.gov/api/v1/parks');
  url.searchParams.set('limit', String(MAX_LIMIT));
  const { status, body } = await fetchJson(url, { headers: { 'X-Api-Key': key } });
  sendJson(res, status, body);
}

async function handleRidb(req, res) {
  const key = String(process.env.RIDB_API_KEY || '').trim();
  if (!key) {
    sendJson(res, 503, { error: 'no_key' });
    return;
  }
  const url = new URL('https://ridb.recreation.gov/api/v1/facilities');
  url.searchParams.set('limit', String(MAX_LIMIT));
  const { status, body } = await fetchJson(url, { headers: { apikey: key } });
  sendJson(res, status, body);
}

const ROUTES = Object.freeze({
  '/api/natural-hazards': naturalHazardsProxy(),
  '/api/openaq': handleOpenAq,
  '/api/open-charge-map': handleOpenChargeMap,
  '/api/gbif': handleGbif,
  '/api/usgs-water': handleUsgsWater,
  '/api/nws-alerts': handleNwsAlerts,
  '/api/opensensemap': handleOpenSenseMap,
  '/api/purpleair': handlePurpleAir,
  '/api/idigbio': handleIdigbio,
  '/api/aqicn': handleAqicn,
  '/api/luchtmeetnet': handleLuchtmeetnet,
  '/api/pm25-opendata': handlePm25,
  '/api/refuge-restrooms': handleRefuge,
  '/api/aviationapi': handleAviationApi,
  '/api/nps-parks': handleNps,
  '/api/ridb': handleRidb,
});

function installPublicApiProxy(server) {
  server.middlewares.use(async (req, res, next) => {
    const path = String(req.url || '').split('?')[0];
    const handler = ROUTES[path];
    if (!handler) return next();
    if (String(req.method || 'GET').toUpperCase() !== 'GET') {
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }
    try {
      const search = new URL(req.url || '/', 'http://local.invalid').searchParams;
      await handler(req, res, search);
    } catch (error) {
      sendJson(res, 502, { error: error?.message || 'upstream failed' });
    }
  });
}

/**
 * Vite plugin that mounts the catalog-selected public API proxies.
 * @returns {import('vite').Plugin}
 */
export function publicApiCatalogProxy() {
  return {
    name: 'public-api-catalog-proxy',
    configureServer: installPublicApiProxy,
    configurePreviewServer: installPublicApiProxy,
  };
}
