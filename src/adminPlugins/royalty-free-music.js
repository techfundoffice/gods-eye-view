/**
 * ADMIN plugin: Royalty-Free Music beds for the left-nav speaker (#left-yt-music).
 *
 * @module adminPlugins/royalty-free-music
 */

import {
  EVENT,
  isAllowedMusicUrl,
  loadLibrary,
  readConfig,
  writeConfig,
} from '../royaltyFreeMusic.js';

export const ROYALTY_FREE_MUSIC_PLUGIN_ID = 'royalty-free-music';
export const ROYALTY_FREE_MUSIC_PLUGIN_LABEL = 'Royalty-Free Music';

/**
 * @param {Document} doc
 * @param {string} tag
 * @param {string} [className]
 * @param {string} [text]
 * @returns {HTMLElement}
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
export function renderRoyaltyFreeMusicPane(container, context = {}) {
  const doc = context.document || container?.ownerDocument || globalThis.document;
  if (!container || typeof doc?.createElement !== 'function') return () => {};

  const loadLib = typeof context.loadLibrary === 'function' ? context.loadLibrary : loadLibrary;
  const read = typeof context.readConfig === 'function' ? context.readConfig : readConfig;
  const write = typeof context.writeConfig === 'function' ? context.writeConfig : writeConfig;

  /** @type {import('../royaltyFreeMusic.js').MusicLibrary | null} */
  let library = null;
  /** @type {HTMLAudioElement | null} */
  let previewAudio = null;
  /** @type {string | null} */
  let previewUrl = null;

  const root = el(doc, 'div', 'admin-rf-music');
  const title = el(doc, 'h2', 'admin-rf-music-title', ROYALTY_FREE_MUSIC_PLUGIN_LABEL);
  const lead = el(
    doc,
    'p',
    'admin-rf-music-lead',
    'Select beds for the left-nav speaker (#left-yt-music). SPD speed control stays on the HUD row.',
  );

  const attribution = el(doc, 'p', 'admin-rf-music-attribution', 'Loading library…');
  attribution.id = 'admin-rf-music-attribution';

  const enableField = el(doc, 'label', 'admin-field admin-rf-music-enable');
  const enableCb = doc.createElement('input');
  enableCb.type = 'checkbox';
  enableCb.id = 'admin-rf-music-enabled';
  enableField.append(enableCb, doc.createTextNode(' Enable speaker beds'));

  const trackList = el(doc, 'div', 'admin-rf-music-tracks');
  trackList.id = 'admin-rf-music-tracks';
  trackList.setAttribute('role', 'group');
  trackList.setAttribute('aria-label', 'Library tracks');

  const customSection = el(doc, 'div', 'admin-rf-music-custom');
  const customTitle = el(doc, 'h3', 'admin-rf-music-subtitle', 'Custom URLs');
  const addRow = el(doc, 'div', 'admin-rf-music-add-row');
  const urlField = el(doc, 'label', 'admin-field');
  urlField.setAttribute('for', 'admin-rf-music-url');
  urlField.append(doc.createTextNode('Add URL (https or /music/…)'));
  const urlInput = el(doc, 'input', 'admin-rf-music-url');
  urlInput.id = 'admin-rf-music-url';
  urlInput.type = 'url';
  urlInput.placeholder = 'https://… or /music/track.mp3';
  urlInput.autocomplete = 'off';
  urlField.append(urlInput);
  const addBtn = el(doc, 'button', 'scene-btn', 'ADD');
  addBtn.id = 'admin-rf-music-add';
  addBtn.type = 'button';
  addRow.append(urlField, addBtn);

  const customList = el(doc, 'ul', 'admin-rf-music-custom-list');
  customList.id = 'admin-rf-music-custom-list';
  customSection.append(customTitle, addRow, customList);

  const previewRow = el(doc, 'div', 'admin-rf-music-preview-row');
  const playBtn = el(doc, 'button', 'scene-btn', 'PREVIEW PLAY');
  playBtn.id = 'admin-rf-music-preview-play';
  playBtn.type = 'button';
  const stopBtn = el(doc, 'button', 'scene-btn', 'PREVIEW STOP');
  stopBtn.id = 'admin-rf-music-preview-stop';
  stopBtn.type = 'button';
  previewRow.append(playBtn, stopBtn);

  const saveBtn = el(doc, 'button', 'scene-btn', 'SAVE');
  saveBtn.id = 'admin-rf-music-save';
  saveBtn.type = 'button';

  const note = el(
    doc,
    'p',
    'admin-rf-music-note',
    'Note: playback speed (SPD) remains on the left YouTube chrome HUD next to the speaker.',
  );

  const message = el(doc, 'p', 'admin-rf-music-message', '');
  message.id = 'admin-rf-music-message';
  message.hidden = true;

  /** @type {string[]} */
  let customUrls = [];
  /** @type {Set<string>} */
  let activeIds = new Set();

  function showMessage(text, isError = false) {
    message.hidden = false;
    message.textContent = text;
    message.classList.toggle('warn', Boolean(isError));
  }

  function stopPreview() {
    try { previewAudio?.pause?.(); } catch { /* ignore */ }
    try { previewAudio?.removeAttribute?.('src'); previewAudio?.load?.(); } catch { /* ignore */ }
    try { previewAudio?.remove?.(); } catch { /* ignore */ }
    previewAudio = null;
    previewUrl = null;
  }

  function selectedPreviewUrl() {
    const checked = trackList.querySelector('input[type="checkbox"][data-track-url]:checked');
    if (checked?.dataset?.trackUrl) return checked.dataset.trackUrl;
    if (customUrls[0]) return customUrls[0];
    const first = library?.tracks?.[0]?.url;
    return first || null;
  }

  async function onPreviewPlay() {
    const url = selectedPreviewUrl();
    if (!url) {
      showMessage('No track selected to preview.', true);
      return;
    }
    stopPreview();
    previewAudio = doc.createElement('audio');
    previewAudio.preload = 'none';
    previewAudio.src = url;
    previewUrl = url;
    (doc.body || doc.documentElement).appendChild(previewAudio);
    try {
      await previewAudio.play();
      showMessage(`Preview: ${url}`);
    } catch (err) {
      showMessage(err?.message || 'Preview failed to start.', true);
      stopPreview();
    }
  }

  function paintCustomList() {
    if (typeof customList.replaceChildren === 'function') customList.replaceChildren();
    else customList.textContent = '';
    customUrls.forEach((url, index) => {
      const li = el(doc, 'li', 'admin-rf-music-custom-item');
      const span = el(doc, 'span', 'admin-rf-music-custom-url', url);
      const rm = el(doc, 'button', 'scene-btn', 'REMOVE');
      rm.type = 'button';
      rm.dataset.index = String(index);
      rm.addEventListener('click', () => {
        customUrls = customUrls.filter((_, i) => i !== index);
        paintCustomList();
      });
      li.append(span, rm);
      customList.append(li);
    });
  }

  function paintTracks() {
    if (typeof trackList.replaceChildren === 'function') trackList.replaceChildren();
    else trackList.textContent = '';
    const tracks = library?.tracks || [];
    if (!tracks.length) {
      trackList.append(el(doc, 'p', 'admin-rf-music-empty', 'No library tracks found.'));
      return;
    }
    for (const track of tracks) {
      const row = el(doc, 'label', 'admin-rf-music-track');
      const cb = doc.createElement('input');
      cb.type = 'checkbox';
      cb.checked = activeIds.has(track.id);
      cb.dataset.trackId = track.id;
      cb.dataset.trackUrl = track.url;
      cb.addEventListener('change', () => {
        if (cb.checked) activeIds.add(track.id);
        else activeIds.delete(track.id);
      });
      const meta = el(doc, 'span', 'admin-rf-music-track-meta');
      const name = el(doc, 'strong', '', track.title || track.id);
      const detail = el(
        doc,
        'span',
        'admin-rf-music-track-detail',
        `${track.source || 'local'} · ${track.url}`,
      );
      meta.append(name, detail);
      row.append(cb, meta);
      trackList.append(row);
    }
  }

  function paintFromConfig() {
    const cfg = read();
    enableCb.checked = cfg.enabled !== false;
    activeIds = new Set(cfg.activeIds);
    customUrls = [...cfg.customUrls];
    if (!activeIds.size && library?.defaultActiveIds?.length) {
      activeIds = new Set(library.defaultActiveIds);
    }
    paintTracks();
    paintCustomList();
  }

  function onAdd() {
    const raw = String(urlInput.value || '').trim();
    if (!raw) {
      showMessage('Enter a URL first.', true);
      return;
    }
    if (!isAllowedMusicUrl(raw)) {
      showMessage('URL must be https://… or a /music/… path.', true);
      return;
    }
    if (customUrls.includes(raw)) {
      showMessage('That URL is already in the list.');
      return;
    }
    customUrls.push(raw);
    urlInput.value = '';
    paintCustomList();
    showMessage('Custom URL added (Save to apply).');
  }

  function onSave() {
    const next = write({
      enabled: Boolean(enableCb.checked),
      activeIds: [...activeIds],
      customUrls: [...customUrls],
    });
    showMessage(
      next.enabled
        ? `Saved · ${next.activeIds.length} library + ${next.customUrls.length} custom.`
        : 'Saved · speaker beds disabled.',
    );
    try {
      softToastFromAdmin(doc, 'Royalty-free music beds saved');
    } catch { /* ignore */ }
  }

  async function boot() {
    try {
      library = await loadLib();
      attribution.textContent = library.attribution
        || 'SoundHelix demo MP3s — local copies under /music';
    } catch (err) {
      attribution.textContent = 'Could not load /music/library.json — fallbacks still available.';
      showMessage(err?.message || 'Library load failed.', true);
      library = { tracks: [], defaultActiveIds: [], attribution: '' };
    }
    paintFromConfig();
  }

  addBtn.addEventListener('click', onAdd);
  urlInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      onAdd();
    }
  });
  playBtn.addEventListener('click', () => { void onPreviewPlay(); });
  stopBtn.addEventListener('click', () => {
    stopPreview();
    showMessage('Preview stopped.');
  });
  saveBtn.addEventListener('click', onSave);

  root.append(
    title,
    lead,
    attribution,
    enableField,
    trackList,
    customSection,
    previewRow,
    saveBtn,
    note,
    message,
  );
  if (typeof container.replaceChildren === 'function') container.replaceChildren(root);
  else container.append?.(root);
  void boot();

  return () => {
    stopPreview();
    addBtn.removeEventListener?.('click', onAdd);
    playBtn.removeEventListener?.('click', () => {});
    stopBtn.removeEventListener?.('click', () => {});
    saveBtn.removeEventListener?.('click', onSave);
    if (typeof container.replaceChildren === 'function') container.replaceChildren();
  };
}

/**
 * @param {Document} doc
 * @param {string} text
 */
function softToastFromAdmin(doc, text) {
  const el = doc.getElementById('toast');
  if (!el) return;
  el.textContent = text;
  el.classList.add('visible');
  globalThis.setTimeout?.(() => el.classList.remove('visible'), 2200);
}

const royaltyFreeMusicPlugin = {
  id: ROYALTY_FREE_MUSIC_PLUGIN_ID,
  label: ROYALTY_FREE_MUSIC_PLUGIN_LABEL,
  description: 'Select beds for the left-nav speaker (#left-yt-music)',
  render: renderRoyaltyFreeMusicPane,
};

export default royaltyFreeMusicPlugin;
export { EVENT };
