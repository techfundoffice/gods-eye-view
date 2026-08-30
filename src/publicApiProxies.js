/**
 * Same-origin proxies for catalog-selected public geo APIs.
 * Secrets stay server-side. The browser never supplies an upstream URL.
 *
 * @module publicApiProxies
 */

const USER_AGENT = 'GodsEyeView/1.0 (https://github.com/bilawalsidhu/gods-eye-view)';
const FETCH_MS = 20_000;
const MAX_LIMIT = 200;

function sendJson(res, status, obj) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function parseBbox(search) {
  const raw = String(search.get('bbox') || '').trim();
  if (!raw) return null;
  const parts = raw.split(',').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const [west, south, east, north] = parts;
  if (south < -90 || north > 90 || west < -180 || east > 180) return null;
  return { west, south, east, north };
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
  const bbox = parseBbox(search);
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
    sendJson(res, 200, []);
    return;
  }
  const url = new URL('https://api.opensensemap.org/boxes');
  url.searchParams.set('exposure', 'outdoor');
  url.searchParams.set('minimal', 'true');
  url.searchParams.set('bbox', `${bbox.west},${bbox.south},${bbox.east},${bbox.north}`);
  const { status, body } = await fetchJson(url);
  sendJson(res, status, Array.isArray(body) ? body.slice(0, MAX_LIMIT) : body);
}

const ROUTES = Object.freeze({
  '/api/openaq': handleOpenAq,
  '/api/open-charge-map': handleOpenChargeMap,
  '/api/gbif': handleGbif,
  '/api/usgs-water': handleUsgsWater,
  '/api/nws-alerts': handleNwsAlerts,
  '/api/opensensemap': handleOpenSenseMap,
});

/**
 * Vite plugin that mounts the catalog-selected public API proxies.
 * @returns {import('vite').Plugin}
 */
export function publicApiCatalogProxy() {
  return {
    name: 'public-api-catalog-proxy',
    configureServer(server) {
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
    },
  };
}
