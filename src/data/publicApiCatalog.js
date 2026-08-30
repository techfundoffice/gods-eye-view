/**
 * Relevance filter over the public-apis/public-apis catalog.
 *
 * The catalog lists ~1,400 APIs. This module is the inventory gate for globe
 * DATA layers: HTTPS, geographically plottable public payloads, redistributable
 * terms, not already plotted here, and not APILayer/paywalled/lookup-only.
 *
 * Rows that fail are rejected with a reason — they are not silently dropped.
 *
 * @module publicApiCatalog
 */

/** Categories whose payloads are not Earth locations. */
export const PUBLIC_API_NON_GEO_CATEGORIES = Object.freeze([
  'Animals',
  'Anime',
  'Anti-Malware',
  'Art & Design',
  'Authentication & Authorization',
  'Blockchain',
  'Books',
  'Business',
  'Calendar',
  'Cloud Storage & File Sharing',
  'Continuous Integration',
  'Cryptocurrency',
  'Currency Exchange',
  'Data Validation',
  'Development',
  'Dictionaries',
  'Documents & Productivity',
  'Email',
  'Entertainment',
  'Events',
  'Finance',
  'Food & Drink',
  'Games & Comics',
  'Health',
  'Jobs',
  'Machine Learning',
  'Music',
  'News',
  'Open Source Projects',
  'Patent',
  'Personality',
  'Phone',
  'Photography',
  'Programming',
  'Security',
  'Shopping',
  'Social',
  'Sports & Fitness',
  'Test Data',
  'Text Analysis',
  'URL Shorteners',
  'Video',
]);

/** Categories that can contain globe-plottable feeds. */
export const PUBLIC_API_CANDIDATE_CATEGORIES = Object.freeze([
  'Environment',
  'Geocoding',
  'Government',
  'Open Data',
  'Science & Math',
  'Tracking',
  'Transportation',
  'Vehicle',
  'Weather',
]);

const APILAYER_PATTERN = /apilayer|aviationstack|weatherstack|ipstack|positionstack|mailboxlayer|numverify|fixer\.io|marketstack|currencylayer|coinlayer|userstack|screenshotlayer/i;

const ALREADY_PLOTTED = [
  { pattern: /opensky network/i, layerId: 'flights' },
  { pattern: /usgs earthquake/i, layerId: 'earthquakes' },
  { pattern: /ads-?b exchange|adsb\.lol/i, layerId: 'flights' },
  { pattern: /\bais hub\b|aisstream/i, layerId: 'ais-live-vessels' },
  { pattern: /celestrak|\btle\b/i, layerId: 'satellites' },
  { pattern: /launch library/i, layerId: 'rocket-launches' },
  { pattern: /citybikes|gbfs|bikeshare|velib/i, layerId: 'bikeshare' },
  { pattern: /open-meteo/i, layerId: 'open-meteo' },
  { pattern: /nominatim/i, layerId: 'nominatim' },
  { pattern: /tomtom/i, layerId: 'traffic' },
  { pattern: /wildfire detection|nasa firms|modis.*fire/i, layerId: 'local-firms' },
];

const LOOKUP_ONLY_PATTERN = /\b(geocod|ip (address|geolocation|lookup)|zip.?code|routing|turn-by-turn|visa |forecast data|historic(al)? weather|for a specific location|calculate|carbon (offset|footprint|intensity)|exchange rate|validate|search trips|price estimation|by icao code)\b/i;

const REGIONAL_ONLY_PATTERN = /^(transport for |city, |metro lisboa|bay area rapid transit|boston mbta)/i;

const COMMERCIAL_HOST_PATTERN = /\biqair\b|accuweather|openweathermap|tomorrow\.io|visual crossing/i;

/**
 * A locatable collection: the primary payload is Earth-located features
 * (stations, sensors, parks, restrooms, occurrences, airports, chargers),
 * not a calculator, geocoder, or point-forecast lookup.
 */
const LOCATABLE_COLLECTION = /\b(air quality|pm2\.?5|charging locations?|electric vehicle charging|biodiversity|occurrence|specimen|idigbio|restroom|water quality|water services|water level|sensebox|personal weather stations?|national weather service|purple air|luchtmeetnet|aqicn|aviationapi|aeronautical charts|airport information|national park service|recreation information|ridb|recreation\.gov)\b/i;

const LAYER_ID_BY_NAME = Object.freeze({
  OpenAQ: 'openaq',
  'Open Charge Map': 'open-charge-map',
  GBIF: 'gbif',
  'USGS Water Services': 'usgs-water',
  'US Weather': 'nws-alerts',
  openSenseMap: 'opensensemap',
  'Purple Air': 'purpleair',
  iDigBio: 'idigbio',
  AQICN: 'aqicn',
  Luchtmeetnet: 'luchtmeetnet',
  'PM2.5 Open Data Portal': 'pm25-opendata',
  'REFUGE Restrooms': 'refuge-restrooms',
  AviationAPI: 'aviationapi',
  'National Park Service, US': 'nps-parks',
  RIDB: 'ridb',
});

/**
 * Stable DATA-layer id for a catalog row. Known names keep fixed slugs;
 * anything else is a lowercase hyphenated name — not a description whitelist.
 *
 * @param {object} entry
 * @returns {string}
 */
export function catalogLayerId(entry) {
  const name = String(entry?.name || '').trim();
  if (LAYER_ID_BY_NAME[name]) return LAYER_ID_BY_NAME[name];
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
}

/**
 * Snapshot of public-apis/public-apis README rows used as the inventory for
 * this upgrade. Representative pass/fail cases from Environment, Weather,
 * Transportation, Science & Math, Geocoding, plus non-geo and commercial rows.
 *
 * @type {ReadonlyArray<{name: string, description: string, auth: string, https: boolean, category: string, url: string}>}
 */
export const PUBLIC_API_CATALOG_SNAPSHOT = Object.freeze([
  Object.freeze({
    name: 'OpenAQ',
    description: 'Open air quality data',
    auth: 'apiKey',
    https: true,
    category: 'Environment',
    url: 'https://docs.openaq.org/',
  }),
  Object.freeze({
    name: 'Open Charge Map',
    description: 'Global public registry of electric vehicle charging locations',
    auth: 'apiKey',
    https: true,
    category: 'Transportation',
    url: 'https://openchargemap.org/site/develop/api',
  }),
  Object.freeze({
    name: 'GBIF',
    description: 'Global Biodiversity Information Facility',
    auth: 'No',
    https: true,
    category: 'Science & Math',
    url: 'https://www.gbif.org/developer/summary',
  }),
  Object.freeze({
    name: 'USGS Water Services',
    description: 'Water quality and level info for rivers and lakes',
    auth: 'No',
    https: true,
    category: 'Science & Math',
    url: 'https://waterservices.usgs.gov/',
  }),
  Object.freeze({
    name: 'US Weather',
    description: 'US National Weather Service',
    auth: 'No',
    https: true,
    category: 'Weather',
    url: 'https://www.weather.gov/documentation/services-web-api',
  }),
  Object.freeze({
    name: 'openSenseMap',
    description: 'Data from Personal Weather Stations called senseBoxes',
    auth: 'No',
    https: true,
    category: 'Weather',
    url: 'https://api.opensensemap.org/',
  }),
  Object.freeze({
    name: 'Purple Air',
    description: 'Real Time Air Quality Monitoring',
    auth: 'No',
    https: true,
    category: 'Science & Math',
    url: 'https://www2.purpleair.com/',
  }),
  Object.freeze({
    name: 'iDigBio',
    description: 'Access millions of museum specimens from organizations around the world',
    auth: 'No',
    https: true,
    category: 'Science & Math',
    url: 'https://github.com/idigbio/idigbio-search-api/wiki',
  }),
  Object.freeze({
    name: 'AQICN',
    description: 'Air Quality Index Data for over 1000 cities',
    auth: 'apiKey',
    https: true,
    category: 'Weather',
    url: 'https://aqicn.org/api/',
  }),
  Object.freeze({
    name: 'Luchtmeetnet',
    description: 'Predicted and actual air quality components for The Netherlands (RIVM)',
    auth: 'No',
    https: true,
    category: 'Environment',
    url: 'https://api-docs.luchtmeetnet.nl/',
  }),
  Object.freeze({
    name: 'PM2.5 Open Data Portal',
    description: 'Open low-cost PM2.5 sensor data',
    auth: 'No',
    https: true,
    category: 'Environment',
    url: 'https://pm25.lass-net.org/#apis',
  }),
  Object.freeze({
    name: 'REFUGE Restrooms',
    description: 'Provides safe restroom access for transgender, intersex and gender nonconforming individuals',
    auth: 'No',
    https: true,
    category: 'Transportation',
    url: 'https://www.refugerestrooms.org/api/docs/#!/restrooms',
  }),
  Object.freeze({
    name: 'AviationAPI',
    description: 'FAA Aeronautical Charts and Publications, Airport Information, and Airport Weather',
    auth: 'No',
    https: true,
    category: 'Transportation',
    url: 'https://docs.aviationapi.com',
  }),
  Object.freeze({
    name: 'National Park Service, US',
    description: 'Data from the US National Park Service',
    auth: 'apiKey',
    https: true,
    category: 'Government',
    url: 'https://www.nps.gov/subjects/developer/',
  }),
  Object.freeze({
    name: 'RIDB',
    description: 'Recreation Information Database of US recreation areas and facilities',
    auth: 'apiKey',
    https: true,
    category: 'Government',
    url: 'https://ridb.recreation.gov/',
  }),
  Object.freeze({
    name: 'BreezoMeter Pollen',
    description: 'Daily Forecast pollen conditions data for a specific location',
    auth: 'apiKey',
    https: true,
    category: 'Environment',
    url: 'https://docs.breezometer.com/api-documentation/pollen-api/v2/',
  }),
  Object.freeze({
    name: 'IQAir',
    description: 'Air quality and weather data',
    auth: 'apiKey',
    https: true,
    category: 'Environment',
    url: 'https://www.iqair.com/air-pollution-data-api',
  }),
  Object.freeze({
    name: 'Cat Facts',
    description: 'Daily cat facts',
    auth: 'No',
    https: true,
    category: 'Animals',
    url: 'https://alexwohlbruck.github.io/cat-facts/',
  }),
  Object.freeze({
    name: 'Jikan',
    description: 'Unofficial MyAnimeList API',
    auth: 'No',
    https: true,
    category: 'Anime',
    url: 'https://jikan.moe',
  }),
  Object.freeze({
    name: 'Mail.GW',
    description: 'Temporary email service',
    auth: 'No',
    https: true,
    category: 'Email',
    url: 'https://docs.mail.gw',
  }),
  Object.freeze({
    name: 'Weatherstack',
    description: 'Real-Time & Historical World Weather Data API',
    auth: 'apiKey',
    https: true,
    category: 'Weather',
    url: 'https://weatherstack.com/?utm_source=Github&utm_medium=Referral&utm_campaign=Public-apis-repo-Best-sellers',
  }),
  Object.freeze({
    name: 'IPstack',
    description: 'Locate and identify website visitors by IP address',
    auth: 'apiKey',
    https: true,
    category: 'Geocoding',
    url: 'https://ipstack.com/?utm_source=Github&utm_medium=Referral&utm_campaign=Public-apis-repo-Best-sellers',
  }),
  Object.freeze({
    name: 'USGS Earthquake Hazards Program',
    description: 'Earthquakes data real-time',
    auth: 'No',
    https: true,
    category: 'Science & Math',
    url: 'https://earthquake.usgs.gov/fdsnws/event/1/',
  }),
  Object.freeze({
    name: 'OpenSky Network',
    description: 'Free real-time ADS-B aviation data',
    auth: 'No',
    https: true,
    category: 'Transportation',
    url: 'https://opensky-network.org/apidoc/index.html',
  }),
  Object.freeze({
    name: 'Open-Meteo',
    description: 'Global weather forecast API for non-commercial use',
    auth: 'No',
    https: true,
    category: 'Weather',
    url: 'https://open-meteo.com/',
  }),
  Object.freeze({
    name: 'Carbon Interface',
    description: 'API to calculate carbon (C02) emissions estimates for common C02 emitting activities',
    auth: 'apiKey',
    https: true,
    category: 'Environment',
    url: 'https://docs.carboninterface.com/',
  }),
  Object.freeze({
    name: 'Bay Area Rapid Transit',
    description: 'Stations and predicted arrivals for BART',
    auth: 'apiKey',
    https: false,
    category: 'Transportation',
    url: 'http://api.bart.gov',
  }),
  Object.freeze({
    name: 'apilayer aviationstack',
    description: 'Real-time Flight Status & Global Aviation Data API',
    auth: 'OAuth',
    https: true,
    category: 'Transportation',
    url: 'https://aviationstack.com/',
  }),
  Object.freeze({
    name: 'Zippopotam.us',
    description: 'Get information about place such as country, city, state, etc',
    auth: 'No',
    https: false,
    category: 'Geocoding',
    url: 'http://www.zippopotam.us',
  }),
  Object.freeze({
    name: 'kanari',
    description: 'Real-time worldwide wildfire detections, water bomber tracking and open fire archive',
    auth: 'No',
    https: true,
    category: 'Environment',
    url: 'https://kanari.io/en/api',
  }),
]);

function haystack(entry) {
  return `${entry?.name || ''} ${entry?.description || ''} ${entry?.url || ''}`;
}

/**
 * @param {object} entry Catalog row.
 * @returns {{accepted: boolean, reason: string, layerId?: string}}
 */
export function evaluatePublicApiRelevance(entry) {
  if (!entry || typeof entry !== 'object') {
    return { accepted: false, reason: 'invalid-entry' };
  }
  if (entry.https !== true) {
    return { accepted: false, reason: 'https-required' };
  }
  const category = String(entry.category || '');
  if (PUBLIC_API_NON_GEO_CATEGORIES.includes(category)) {
    return { accepted: false, reason: 'non-geo-category' };
  }
  if (!PUBLIC_API_CANDIDATE_CATEGORIES.includes(category)) {
    return { accepted: false, reason: 'non-geo-category' };
  }
  const text = haystack(entry);
  if (APILAYER_PATTERN.test(text) || APILAYER_PATTERN.test(String(entry.name || ''))
    || COMMERCIAL_HOST_PATTERN.test(text)) {
    return { accepted: false, reason: 'commercial-apilayer' };
  }
  for (const known of ALREADY_PLOTTED) {
    if (known.pattern.test(text) || known.pattern.test(String(entry.name || ''))) {
      return { accepted: false, reason: 'already-plotted', layerId: known.layerId };
    }
  }
  if (LOOKUP_ONLY_PATTERN.test(text) || category === 'Geocoding') {
    return { accepted: false, reason: 'lookup-only' };
  }
  if (REGIONAL_ONLY_PATTERN.test(String(entry.name || ''))) {
    return { accepted: false, reason: 'not-globe-plottable' };
  }
  if (String(entry.auth || '').toLowerCase() === 'oauth') {
    return { accepted: false, reason: 'not-runtime-fetchable' };
  }
  if (!LOCATABLE_COLLECTION.test(text)) {
    return { accepted: false, reason: 'no-geo-payload' };
  }
  return { accepted: true, reason: 'plottable-geo', layerId: catalogLayerId(entry) };
}

/**
 * Keep only catalog rows that pass the relevance filter, in catalog order.
 *
 * @param {Iterable<object>} [catalog]
 * @returns {Array<object>}
 */
export function selectGlobeRelevantPublicApis(catalog = PUBLIC_API_CATALOG_SNAPSHOT) {
  const accepted = [];
  for (const entry of catalog || []) {
    const verdict = evaluatePublicApiRelevance(entry);
    if (!verdict.accepted) continue;
    accepted.push({ ...entry, layerId: verdict.layerId, reason: verdict.reason });
  }
  return accepted;
}

/** Layer ids the snapshot filter currently accepts. */
export const PUBLIC_API_LAYER_IDS = Object.freeze(
  selectGlobeRelevantPublicApis(PUBLIC_API_CATALOG_SNAPSHOT).map((entry) => entry.layerId),
);
