import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PUBLIC_API_CATALOG_SNAPSHOT,
  PUBLIC_API_LAYER_IDS,
  evaluatePublicApiRelevance,
  selectGlobeRelevantPublicApis,
} from './publicApiCatalog.js';

function byName(name) {
  const row = PUBLIC_API_CATALOG_SNAPSHOT.find((entry) => entry.name === name);
  assert.ok(row, `snapshot missing ${name}`);
  return row;
}

test('plottable Environment/Weather/Transportation/Science rows pass the shipped filter', () => {
  const openaq = evaluatePublicApiRelevance(byName('OpenAQ'));
  assert.equal(openaq.accepted, true);
  assert.equal(openaq.layerId, 'openaq');
  assert.equal(openaq.reason, 'plottable-geo');

  const ocm = evaluatePublicApiRelevance(byName('Open Charge Map'));
  assert.equal(ocm.accepted, true);
  assert.equal(ocm.layerId, 'open-charge-map');

  const gbif = evaluatePublicApiRelevance(byName('GBIF'));
  assert.equal(gbif.accepted, true);
  assert.equal(gbif.layerId, 'gbif');

  const water = evaluatePublicApiRelevance(byName('USGS Water Services'));
  assert.equal(water.accepted, true);
  assert.equal(water.layerId, 'usgs-water');

  const nws = evaluatePublicApiRelevance(byName('US Weather'));
  assert.equal(nws.accepted, true);
  assert.equal(nws.layerId, 'nws-alerts');

  const sense = evaluatePublicApiRelevance(byName('openSenseMap'));
  assert.equal(sense.accepted, true);
  assert.equal(sense.layerId, 'opensensemap');
});

test('non-geo catalog rows such as Animals/Anime/Email are rejected, not omitted', () => {
  assert.deepEqual(evaluatePublicApiRelevance(byName('Cat Facts')), {
    accepted: false,
    reason: 'non-geo-category',
  });
  assert.deepEqual(evaluatePublicApiRelevance(byName('Jikan')), {
    accepted: false,
    reason: 'non-geo-category',
  });
  assert.deepEqual(evaluatePublicApiRelevance(byName('Mail.GW')), {
    accepted: false,
    reason: 'non-geo-category',
  });
});

test('APILayer commercial and auth-walled suite products are rejected', () => {
  const weatherstack = evaluatePublicApiRelevance(byName('Weatherstack'));
  assert.equal(weatherstack.accepted, false);
  assert.equal(weatherstack.reason, 'commercial-apilayer');

  const ipstack = evaluatePublicApiRelevance(byName('IPstack'));
  assert.equal(ipstack.accepted, false);
  assert.ok(['commercial-apilayer', 'lookup-only'].includes(ipstack.reason));

  const aviation = evaluatePublicApiRelevance(byName('apilayer aviationstack'));
  assert.equal(aviation.accepted, false);
  assert.equal(aviation.reason, 'commercial-apilayer');
});

test('sources this app already plots are rejected as duplicates', () => {
  const quakes = evaluatePublicApiRelevance(byName('USGS Earthquake Hazards Program'));
  assert.equal(quakes.accepted, false);
  assert.equal(quakes.reason, 'already-plotted');
  assert.equal(quakes.layerId, 'earthquakes');

  const flights = evaluatePublicApiRelevance(byName('OpenSky Network'));
  assert.equal(flights.accepted, false);
  assert.equal(flights.reason, 'already-plotted');
  assert.equal(flights.layerId, 'flights');

  const fires = evaluatePublicApiRelevance(byName('kanari'));
  assert.equal(fires.accepted, false);
  assert.equal(fires.reason, 'already-plotted');
  assert.equal(fires.layerId, 'local-firms');

  const meteo = evaluatePublicApiRelevance(byName('Open-Meteo'));
  assert.equal(meteo.accepted, false);
  assert.equal(meteo.reason, 'already-plotted');
});

test('lookup-only, HTTP-only, and calculator rows fail with an explicit reason', () => {
  assert.equal(evaluatePublicApiRelevance(byName('Carbon Interface')).reason, 'lookup-only');
  assert.equal(evaluatePublicApiRelevance(byName('Bay Area Rapid Transit')).reason, 'https-required');
  assert.equal(evaluatePublicApiRelevance(byName('Zippopotam.us')).reason, 'https-required');
});

test('selectGlobeRelevantPublicApis returns only the accepted snapshot rows', () => {
  const selected = selectGlobeRelevantPublicApis();
  assert.deepEqual(
    selected.map((entry) => entry.layerId),
    [...PUBLIC_API_LAYER_IDS],
  );
  assert.deepEqual(
    [...PUBLIC_API_LAYER_IDS].sort(),
    ['gbif', 'nws-alerts', 'open-charge-map', 'openaq', 'opensensemap', 'usgs-water'],
  );
  for (const entry of selected) {
    assert.equal(entry.reason, 'plottable-geo');
    assert.equal(evaluatePublicApiRelevance(entry).accepted, true);
  }
  const rejected = PUBLIC_API_CATALOG_SNAPSHOT.filter(
    (entry) => !evaluatePublicApiRelevance(entry).accepted,
  );
  assert.ok(rejected.length >= 8, 'the snapshot must include rejected inventory rows');
});
