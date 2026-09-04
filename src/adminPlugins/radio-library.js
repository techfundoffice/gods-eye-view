/**
 * ADMIN plugin: Radio Library — curated internet-radio stations.
 *
 * @module adminPlugins/radio-library
 */

import {
  EVENT,
  readConfig,
  writeConfig,
} from '../radioLibrary.js';

export const RADIO_LIBRARY_PLUGIN_ID = 'radio-library';
export const RADIO_LIBRARY_PLUGIN_LABEL = 'Radio Library';

/**
 * @param {Document} doc
 * @param {string} tag
 * @param {string} [className]
 * @param {string} [text]
 */
function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/**
 * @param {HTMLElement} container
 * @param {object} [context]
 * @returns {() => void}
 */
export function renderRadioLibraryPane(container, context = {}) {
  const doc = context.document || container?.ownerDocument || globalThis.document;
  if (!container || typeof doc?.createElement !== 'function') return () => {};

  /** @type {import('../radioLibrary.js').RadioLibraryStation[]} */
  let stations = readConfig().stations.map((s) => ({ ...s }));

  const root = el(doc, 'div', 'admin-radio-library');
  root.append(el(doc, 'h2', 'admin-radio-library-title', RADIO_LIBRARY_PLUGIN_LABEL));
  root.append(
    el(
      doc,
      'p',
      'admin-radio-library-lead',
      'Curated streams for the Radio companion. Globe Radio still uses Radio Browser for the worldwide directory; this library is your operator shortlist (name + HTTPS stream URL).',
    ),
  );

  const list = el(doc, 'div', 'admin-radio-library-list');
  list.setAttribute('role', 'group');
  list.setAttribute('aria-label', 'Curated radio stations');

  const addSection = el(doc, 'div', 'admin-radio-library-add');
  addSection.append(el(doc, 'h3', 'admin-radio-library-subtitle', 'Add station'));

  const nameInput = el(doc, 'input', 'admin-field');
  nameInput.type = 'text';
  nameInput.placeholder = 'Station name';
  nameInput.id = 'admin-radio-library-name';

  const urlInput = el(doc, 'input', 'admin-field');
  urlInput.type = 'url';
  urlInput.placeholder = 'https://stream.example.com/live.mp3';
  urlInput.id = 'admin-radio-library-url';

  const tagsInput = el(doc, 'input', 'admin-field');
  tagsInput.type = 'text';
  tagsInput.placeholder = 'tags (music news …)';
  tagsInput.id = 'admin-radio-library-tags';

  const homepageInput = el(doc, 'input', 'admin-field');
  homepageInput.type = 'url';
  homepageInput.placeholder = 'Homepage (optional)';
  homepageInput.id = 'admin-radio-library-homepage';

  const addBtn = el(doc, 'button', 'scene-btn', 'ADD');
  addBtn.type = 'button';
  addBtn.id = 'admin-radio-library-add';

  addSection.append(nameInput, urlInput, tagsInput, homepageInput, addBtn);

  const saveBtn = el(doc, 'button', 'scene-btn', 'SAVE');
  saveBtn.type = 'button';
  saveBtn.id = 'admin-radio-library-save';

  const message = el(doc, 'p', 'admin-radio-library-message', '');
  message.hidden = true;

  const link = el(doc, 'p', 'admin-radio-library-note');
  const a = el(doc, 'a', '', 'Open Radio Browser directory');
  a.href = 'https://www.radio-browser.info/';
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  link.append(a);

  root.append(list, addSection, saveBtn, message, link);
  if (typeof container.replaceChildren === 'function') container.replaceChildren(root);
  else container.append?.(root);

  const say = (text, warn = false) => {
    message.textContent = text;
    message.hidden = !text;
    message.classList.toggle('warn', Boolean(warn));
  };

  const paint = () => {
    list.replaceChildren();
    if (!stations.length) {
      list.append(el(doc, 'p', 'admin-radio-library-empty', 'No curated stations yet.'));
      return;
    }
    for (const st of stations) {
      const row = el(doc, 'label', 'admin-radio-library-row');
      const cb = doc.createElement('input');
      cb.type = 'checkbox';
      cb.checked = st.enabled !== false;
      cb.addEventListener('change', () => {
        st.enabled = cb.checked;
      });
      const meta = el(doc, 'span', 'admin-radio-library-meta');
      meta.append(el(doc, 'strong', '', st.name));
      meta.append(doc.createElement('br'));
      meta.append(doc.createTextNode(st.url));
      if (st.tags) {
        meta.append(doc.createElement('br'));
        meta.append(doc.createTextNode(st.tags));
      }
      const remove = el(doc, 'button', 'scene-btn', 'REMOVE');
      remove.type = 'button';
      remove.addEventListener('click', (ev) => {
        ev.preventDefault();
        stations = stations.filter((x) => x.id !== st.id);
        paint();
      });
      row.append(cb, meta, remove);
      list.append(row);
    }
  };

  const onAdd = () => {
    const name = String(nameInput.value || '').trim();
    const url = String(urlInput.value || '').trim();
    if (!name || !url) {
      say('Name and stream URL required.', true);
      return;
    }
    if (!(url.startsWith('https://') || url.startsWith('http://'))) {
      say('Stream URL must be http(s).', true);
      return;
    }
    stations.push({
      id: `st-${Date.now().toString(36)}`,
      name,
      url,
      tags: String(tagsInput.value || '').trim() || undefined,
      homepage: String(homepageInput.value || '').trim() || undefined,
      enabled: true,
    });
    nameInput.value = '';
    urlInput.value = '';
    tagsInput.value = '';
    homepageInput.value = '';
    paint();
    say('Added — click SAVE to keep.');
  };

  const onSave = () => {
    const saved = writeConfig({ stations });
    stations = saved.stations.map((s) => ({ ...s }));
    paint();
    say(`Saved ${stations.length} station(s) to Radio Library.`);
  };

  paint();
  addBtn.addEventListener('click', onAdd);
  saveBtn.addEventListener('click', onSave);

  return () => {
    addBtn.removeEventListener('click', onAdd);
    saveBtn.removeEventListener('click', onSave);
    if (typeof container.replaceChildren === 'function') container.replaceChildren();
  };
}

const radioLibraryPlugin = {
  id: RADIO_LIBRARY_PLUGIN_ID,
  label: RADIO_LIBRARY_PLUGIN_LABEL,
  description: 'Curated internet-radio shortlist for the Radio companion',
  render: renderRadioLibraryPane,
};

export default radioLibraryPlugin;
export { EVENT };
