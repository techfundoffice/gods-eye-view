/**
 * As-you-type suggestions for the bottom LOCATION finder.
 *
 * Network I/O hits the same-origin `/api/google/place-suggest` proxy (no
 * client-supplied upstream URL, no viewport bias). Mapping from upstream rows
 * to `{name, address, lat, lon, query}` is pure so tests can stub `fetch` and
 * still drive this module.
 */

export const LOCATION_SUGGEST_DEBOUNCE_MS = 220;
export const LOCATION_SUGGEST_MIN_CHARS = 2;
export const LOCATION_SUGGEST_MAX = 8;

const PLACE_SUGGEST_PATH = '/api/google/place-suggest';

/**
 * Escape text that will be interpolated into suggestion-row HTML.
 * @param {*} value
 * @returns {string}
 */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Normalize a Places Autocomplete / Text Search / already-flat payload into
 * suggestion rows. Never invents places — empty or malformed input is `[]`.
 *
 * @param {object|Array|null|undefined} payload
 * @returns {Array<{name: string, address: string, lat: number|null, lon: number|null, query: string, label: string, types: string[]}>}
 */
export function mapPlaceSuggestions(payload) {
  const rows = extractRows(payload);
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const mapped = mapOneSuggestion(row);
    if (!mapped) continue;
    const key = `${mapped.name}\n${mapped.address}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(mapped);
    if (out.length >= LOCATION_SUGGEST_MAX) break;
  }
  return out;
}

/**
 * Fetch suggestions for a typed query through the same-origin proxy.
 * Empty query, HTTP error, missing key (503), or a thrown fetch all return
 * `[]` — the UI must not fabricate Disneylands. AbortError is rethrown so a
 * newer keystroke can ignore a stale in-flight lookup.
 *
 * @param {string} query
 * @param {{fetch?: typeof fetch, signal?: AbortSignal}} [options]
 * @returns {Promise<Array<object>>}
 */
export async function fetchPlaceSuggestions(query, options = {}) {
  const q = String(query ?? '').trim();
  if (!q) return [];
  const fetchImpl = options.fetch || globalThis.fetch;
  const requestUrl = `${PLACE_SUGGEST_PATH}?q=${encodeURIComponent(q)}`;
  try {
    const response = await fetchImpl(requestUrl, { signal: options.signal });
    if (!response || !response.ok) return [];
    const data = await response.json();
    return mapPlaceSuggestions(data);
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    return [];
  }
}

/**
 * Markup for suggestion rows (name + distinguishing address). Used by the
 * location-bar renderer so tests can assert the shipped HTML without a DOM.
 *
 * @param {Array<{name?: string, address?: string}>} suggestions
 * @returns {string}
 */
export function suggestionButtonsHtml(suggestions) {
  const rows = Array.isArray(suggestions) ? suggestions : [];
  return rows.map((suggestion, index) => {
    const name = escapeHtml(suggestion?.name || '');
    const address = escapeHtml(suggestion?.address || '');
    return (
      `<li class="location-suggestion-item">`
      + `<button type="button" class="location-suggestion" role="option" data-index="${index}">`
      + `<span class="location-suggestion-name">${name}</span>`
      + `<span class="location-suggestion-address">${address}</span>`
      + `</button></li>`
    );
  }).join('');
}

/**
 * Render mapped suggestion rows into the location-bar list element.
 *
 * @param {HTMLElement|null|undefined} listEl
 * @param {Array<object>} suggestions
 * @returns {void}
 */
export function renderLocationSuggestions(listEl, suggestions) {
  if (!listEl) return;
  const rows = Array.isArray(suggestions) ? suggestions : [];
  if (!rows.length) {
    listEl.innerHTML = '';
    listEl.hidden = true;
    return;
  }
  listEl.innerHTML = suggestionButtonsHtml(rows);
  listEl.hidden = false;
}

/**
 * Debounced, abortable as-you-type lookup. A newer keystroke aborts the
 * in-flight request so an older response cannot overwrite newer suggestions.
 *
 * @param {object} [options]
 * @param {(query: string, opts: {signal?: AbortSignal}) => Promise<Array<object>>} [options.fetchSuggestions]
 * @param {(rows: Array<object>) => void} [options.onResults]
 * @param {number} [options.delayMs]
 * @param {number} [options.minChars]
 * @returns {{schedule: (query: string) => void, cancel: () => void}}
 */
export function createLocationSuggestController(options = {}) {
  const fetchSuggestions = options.fetchSuggestions || fetchPlaceSuggestions;
  const onResults = typeof options.onResults === 'function' ? options.onResults : () => {};
  const delayMs = Number.isFinite(options.delayMs) ? options.delayMs : LOCATION_SUGGEST_DEBOUNCE_MS;
  const minChars = Number.isFinite(options.minChars) ? options.minChars : LOCATION_SUGGEST_MIN_CHARS;
  const setTimeoutFn = options.setTimeout || globalThis.setTimeout.bind(globalThis);
  const clearTimeoutFn = options.clearTimeout || globalThis.clearTimeout.bind(globalThis);

  let timer = 0;
  let generation = 0;
  let abort = null;

  function clearInFlight() {
    if (timer) {
      clearTimeoutFn(timer);
      timer = 0;
    }
    if (abort) {
      abort.abort();
      abort = null;
    }
  }

  return {
    schedule(query) {
      const q = String(query ?? '').trim();
      clearInFlight();
      if (q.length < minChars) {
        generation += 1;
        onResults([]);
        return;
      }
      const gen = ++generation;
      timer = setTimeoutFn(async () => {
        timer = 0;
        abort = new AbortController();
        const signal = abort.signal;
        try {
          const rows = await fetchSuggestions(q, { signal });
          if (gen !== generation) return;
          onResults(Array.isArray(rows) ? rows : []);
        } catch (err) {
          if (err?.name === 'AbortError') return;
          if (gen !== generation) return;
          onResults([]);
        }
      }, delayMs);
    },
    cancel() {
      generation += 1;
      clearInFlight();
      onResults([]);
    },
  };
}

function extractRows(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.suggestions)) return payload.suggestions;
  if (Array.isArray(payload.places)) return payload.places;
  return [];
}

function textOf(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value.text === 'string') return value.text.trim();
  return '';
}

function finiteCoord(value, min, max) {
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? number : null;
}

function mapOneSuggestion(row) {
  if (!row || typeof row !== 'object') return null;
  const prediction = row.placePrediction && typeof row.placePrediction === 'object'
    ? row.placePrediction
    : null;

  const name = prediction
    ? (textOf(prediction.structuredFormat?.mainText) || textOf(prediction.text) || textOf(prediction.structuredFormat?.main_text))
    : (textOf(row.displayName) || textOf(row.name) || textOf(row.main_text) || textOf(row.mainText));
  if (!name) return null;

  const address = prediction
    ? (textOf(prediction.structuredFormat?.secondaryText) || textOf(prediction.structuredFormat?.secondary_text))
    : (textOf(row.formattedAddress)
      || textOf(row.shortFormattedAddress)
      || textOf(row.address)
      || textOf(row.formatted_address)
      || textOf(row.secondary_text)
      || textOf(row.secondaryText));

  const { lat, lon } = readLatLon(row);
  const query = textOf(row.query)
    || (prediction ? textOf(prediction.text) : '')
    || [name, address].filter(Boolean).join(', ');
  const types = Array.isArray(row.types)
    ? row.types.filter((type) => typeof type === 'string').slice(0, 8)
    : (Array.isArray(prediction?.types)
      ? prediction.types.filter((type) => typeof type === 'string').slice(0, 8)
      : []);
  const label = textOf(row.label) || (address ? `${name}, ${address}` : name);

  return { name, address, lat, lon, query, label, types };
}

function readLatLon(row) {
  const loc = row.location || row.geometry?.location || {};
  const lat = finiteCoord(
    row.lat ?? row.latitude ?? loc.latitude ?? loc.lat,
    -90,
    90,
  );
  const lon = finiteCoord(
    row.lon ?? row.lng ?? row.longitude ?? loc.longitude ?? loc.lng,
    -180,
    180,
  );
  return { lat, lon };
}
