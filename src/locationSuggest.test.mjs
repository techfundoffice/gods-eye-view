// As-you-type LOCATION suggestions: mapper + lookup drive the shipped module.
// Stub only `fetch` — never reimplement mapping in the test.
//
// Run with: npm test   (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LOCATION_SUGGEST_DEBOUNCE_MS,
  LOCATION_SUGGEST_MIN_CHARS,
  createLocationSuggestController,
  fetchPlaceSuggestions,
  mapPlaceSuggestions,
  renderLocationSuggestions,
  suggestionButtonsHtml,
} from './locationSuggest.js';
import { DISNEYLAND_SUGGEST_FIXTURE } from './locationSuggest.fixture.mjs';

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

test('Disneyland maps to several geographically distinct suggestions', () => {
  const rows = mapPlaceSuggestions(DISNEYLAND_SUGGEST_FIXTURE);
  assert.ok(rows.length > 1, `expected several parks, got ${rows.length}`);
  assert.equal(rows.length, 4);

  for (const row of rows) {
    assert.equal(typeof row.name, 'string');
    assert.ok(row.name.length > 0, 'each suggestion needs a visible name');
    assert.equal(typeof row.address, 'string');
    assert.ok(row.address.length > 0, 'each suggestion needs a distinguishing address');
    assert.equal(typeof row.query, 'string');
    assert.ok(row.query.includes(row.name));
  }

  const blob = rows.map((row) => `${row.name} ${row.address}`).join('\n').toLowerCase();
  assert.match(blob, /anaheim/);
  assert.match(blob, /florida|orlando|fl\b/);
  assert.match(blob, /france|chessy/);
  assert.match(blob, /japan|chiba|urayasu|maihama/);

  const keys = new Set(rows.map((row) => `${row.name}|${row.address}`));
  assert.equal(keys.size, rows.length, 'must not collapse distinct parks to the first geocode hit');

  const coords = rows.map((row) => `${row.lat},${row.lon}`);
  assert.equal(new Set(coords).size, rows.length, 'parks must keep distinct coordinates');
});

test('Autocomplete-shaped rows also keep distinguishing localities', () => {
  const rows = mapPlaceSuggestions({
    suggestions: [
      {
        placePrediction: {
          text: { text: 'Disneyland Park, Anaheim, CA, USA' },
          structuredFormat: {
            mainText: { text: 'Disneyland Park' },
            secondaryText: { text: 'Anaheim, CA, USA' },
          },
        },
      },
      {
        placePrediction: {
          text: { text: 'Tokyo Disneyland, Maihama, Urayasu, Chiba, Japan' },
          structuredFormat: {
            mainText: { text: 'Tokyo Disneyland' },
            secondaryText: { text: 'Maihama, Urayasu, Chiba, Japan' },
          },
        },
      },
    ],
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, 'Disneyland Park');
  assert.match(rows[0].address, /anaheim/i);
  assert.equal(rows[1].name, 'Tokyo Disneyland');
  assert.match(rows[1].address, /japan/i);
  assert.equal(rows[0].lat, null);
  assert.equal(rows[1].lon, null);
});

test('already-flat proxy rows pass through without collapsing', () => {
  const mapped = mapPlaceSuggestions(DISNEYLAND_SUGGEST_FIXTURE);
  const again = mapPlaceSuggestions({ suggestions: mapped });
  assert.equal(again.length, mapped.length);
  assert.deepEqual(again.map((row) => row.address), mapped.map((row) => row.address));
});

test('empty or malformed payloads never invent places', () => {
  assert.deepEqual(mapPlaceSuggestions(null), []);
  assert.deepEqual(mapPlaceSuggestions({}), []);
  assert.deepEqual(mapPlaceSuggestions({ places: [] }), []);
  assert.deepEqual(mapPlaceSuggestions({ suggestions: [{}, { name: '' }] }), []);
  assert.deepEqual(mapPlaceSuggestions({ places: [{ formattedAddress: 'Nowhere' }] }), []);
});

test('fetchPlaceSuggestions drives the mapper through the same-origin proxy', async () => {
  const urls = [];
  const rows = await fetchPlaceSuggestions('Disneyland', {
    fetch: async (url) => {
      urls.push(String(url));
      return jsonResponse(DISNEYLAND_SUGGEST_FIXTURE);
    },
  });
  assert.deepEqual(urls, ['/api/google/place-suggest?q=Disneyland']);
  assert.ok(rows.length > 1);
  assert.match(rows.map((row) => row.address).join('\n'), /anaheim/i);
  assert.match(rows.map((row) => row.address).join('\n'), /japan/i);
});

test('fetchPlaceSuggestions stays honest on empty query, HTTP error, and throw', async () => {
  let called = 0;
  const boom = async () => {
    called += 1;
    throw new Error('network down');
  };
  assert.deepEqual(await fetchPlaceSuggestions('  ', { fetch: boom }), []);
  assert.equal(called, 0, 'empty query must not hit the network');

  const failed = await fetchPlaceSuggestions('Disneyland', {
    fetch: async () => jsonResponse({ error: 'GOOGLE_MAPS_API_KEY is not set', suggestions: [] }, 503),
  });
  assert.deepEqual(failed, []);

  const thrown = await fetchPlaceSuggestions('Disneyland', { fetch: boom });
  assert.deepEqual(thrown, []);
  assert.equal(called, 1);
});

test('fetchPlaceSuggestions never follows a client-supplied upstream URL option', async () => {
  const urls = [];
  await fetchPlaceSuggestions('Disneyland', {
    url: 'https://evil.example/places',
    fetch: async (url) => {
      urls.push(String(url));
      return jsonResponse({ places: [] });
    },
  });
  assert.equal(urls.length, 1);
  assert.equal(urls[0].startsWith('/api/google/place-suggest?q='), true);
  assert.doesNotMatch(urls[0], /evil/);
});

test('suggestion HTML lists each name with its distinguishing address', () => {
  const rows = mapPlaceSuggestions(DISNEYLAND_SUGGEST_FIXTURE);
  const html = suggestionButtonsHtml(rows);
  assert.match(html, /location-suggestion-name/);
  assert.match(html, /location-suggestion-address/);
  assert.match(html, /Disneyland Park/);
  assert.match(html, /Anaheim/);
  assert.match(html, /Tokyo Disneyland/);
  assert.match(html, /Japan/);
  assert.match(html, /France/);
  assert.match(html, /Orlando|Florida|FL/);
  assert.equal((html.match(/class="location-suggestion"/g) || []).length, rows.length);
});

test('renderLocationSuggestions writes the mapped rows and hides when empty', () => {
  const el = { innerHTML: 'stale', hidden: false };
  const rows = mapPlaceSuggestions(DISNEYLAND_SUGGEST_FIXTURE);
  renderLocationSuggestions(el, rows);
  assert.equal(el.hidden, false);
  assert.match(el.innerHTML, /Anaheim/);
  assert.match(el.innerHTML, /Japan/);
  renderLocationSuggestions(el, []);
  assert.equal(el.hidden, true);
  assert.equal(el.innerHTML, '');
});

test('a newer keystroke aborts the in-flight suggestion lookup', async () => {
  const signals = [];
  const received = [];
  let finishFirst;
  const firstGate = new Promise((resolve) => { finishFirst = resolve; });

  const controller = createLocationSuggestController({
    delayMs: 0,
    minChars: LOCATION_SUGGEST_MIN_CHARS,
    fetchSuggestions: async (query, { signal } = {}) => {
      signals.push({ query, signal });
      if (query === 'Disney') {
        await firstGate;
        return mapPlaceSuggestions({ places: [DISNEYLAND_SUGGEST_FIXTURE.places[0]] });
      }
      return mapPlaceSuggestions(DISNEYLAND_SUGGEST_FIXTURE);
    },
    onResults: (rows) => received.push(rows),
  });

  controller.schedule('Disney');
  await new Promise((resolve) => setTimeout(resolve, 5));
  controller.schedule('Disneyland');
  assert.equal(signals[0].signal.aborted, true, 'the older lookup must be aborted');
  finishFirst();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(received.length >= 1);
  const last = received[received.length - 1];
  assert.ok(last.length > 1, 'the newer Disneyland query must keep multiple parks');
  assert.equal(last.length, 4);
});

test('short or empty typing clears suggestions without fetching', async () => {
  let fetches = 0;
  const received = [];
  const controller = createLocationSuggestController({
    delayMs: 0,
    fetchSuggestions: async () => {
      fetches += 1;
      return mapPlaceSuggestions(DISNEYLAND_SUGGEST_FIXTURE);
    },
    onResults: (rows) => received.push(rows),
  });
  controller.schedule('D');
  controller.schedule('  ');
  assert.equal(fetches, 0);
  assert.deepEqual(received.at(-1), []);
  assert.ok(LOCATION_SUGGEST_DEBOUNCE_MS >= 100);
});
