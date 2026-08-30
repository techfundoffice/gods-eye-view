/**
 * ADMIN plugin: Google Earth (Photorealistic 3D Tiles) status and enablement.
 *
 * @module adminPlugins/google-earth
 */

import {
  GOOGLE_EARTH_STACK_ID,
  GOOGLE_EARTH_STATUS,
  enableGoogleEarth,
  getGoogleEarthStatus,
  readGoogleEarthRuntime,
} from '../googleEarth.js';

export {
  GOOGLE_EARTH_STACK_ID,
  GOOGLE_EARTH_STATUS,
  enableGoogleEarth,
  getGoogleEarthStatus,
  readGoogleEarthRuntime,
};

/**
 * @param {Document} doc
 * @param {string} term
 * @param {string} value
 * @returns {HTMLElement}
 */
function factRow(doc, term, value) {
  const row = doc.createElement('div');
  const dt = doc.createElement('dt');
  dt.textContent = term;
  const dd = doc.createElement('dd');
  dd.textContent = value;
  row.append(dt, dd);
  return row;
}

/**
 * Paint the Google Earth operator pane into an ADMIN plugin host.
 *
 * @param {HTMLElement} container
 * @param {object} [context]
 * @param {Document} [context.document]
 * @param {() => object} [context.readRuntime]
 * @param {(runtime: object) => Promise<object>} [context.enable]
 * @returns {() => void} Teardown.
 */
export function renderGoogleEarthPane(container, context = {}) {
  const doc = context.document || container?.ownerDocument || globalThis.document;
  if (!container || typeof doc?.createElement !== 'function') return () => {};

  const readRuntime = typeof context.readRuntime === 'function'
    ? context.readRuntime
    : readGoogleEarthRuntime;
  const enable = typeof context.enable === 'function' ? context.enable : enableGoogleEarth;

  const root = doc.createElement('div');
  root.className = 'admin-google-earth';

  const title = doc.createElement('h2');
  title.className = 'admin-google-earth-title';
  title.textContent = 'Google Earth';

  const lead = doc.createElement('p');
  lead.className = 'admin-google-earth-lead';
  lead.textContent = 'Map Tiles API Photorealistic 3D Tiles — the live Google Earth globe in this app.';

  const statusEl = doc.createElement('p');
  statusEl.id = 'admin-google-earth-status';
  statusEl.className = 'admin-google-earth-status';
  statusEl.setAttribute('role', 'status');

  const facts = doc.createElement('dl');
  facts.className = 'admin-google-earth-facts';

  const button = doc.createElement('button');
  button.id = 'admin-google-earth-show';
  button.type = 'button';
  button.className = 'scene-btn';
  button.textContent = 'SHOW GOOGLE EARTH';

  const message = doc.createElement('p');
  message.id = 'admin-google-earth-message';
  message.className = 'admin-google-earth-message';
  message.hidden = true;

  function paint() {
    const status = getGoogleEarthStatus(readRuntime());
    statusEl.dataset.googleEarthState = status.state;
    statusEl.textContent = `${status.label} · ${status.detail}`;
    statusEl.classList.toggle('warn', status.state !== GOOGLE_EARTH_STATUS.DISPLAYING);
    if (typeof facts.replaceChildren === 'function') {
      facts.replaceChildren(
        factRow(doc, 'API key', status.keyPresent ? 'PRESENT' : 'KEY REQUIRED'),
        factRow(doc, 'Tileset', status.tilesetLoaded ? 'LOADED' : (status.keyPresent ? 'LOAD FAILED' : 'NOT LOADED')),
        factRow(doc, 'Active stack', status.activeStack || 'none'),
        factRow(doc, 'Displaying', status.displaying ? 'YES' : 'NO'),
      );
    }
    button.disabled = !status.available;
  }

  async function onShow() {
    const result = await enable(readRuntime());
    paint();
    message.hidden = Boolean(result?.ok);
    message.textContent = result?.ok ? '' : (result?.error || 'Could not show Google Earth.');
  }

  button.addEventListener('click', onShow);
  root.append(title, lead, statusEl, facts, button, message);
  if (typeof container.replaceChildren === 'function') container.replaceChildren(root);
  else container.append?.(root);
  paint();

  return () => {
    button.removeEventListener?.('click', onShow);
    if (typeof container.replaceChildren === 'function') container.replaceChildren();
  };
}

const googleEarthPlugin = {
  id: 'google-earth',
  label: 'Google Earth',
  description: 'Show Google Photorealistic 3D Tiles on the globe and report key/tileset status.',
  render: renderGoogleEarthPane,
};

export default googleEarthPlugin;
