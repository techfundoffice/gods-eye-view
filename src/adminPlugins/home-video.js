/**
 * ADMIN plugin: the home-page video player (#gev-home-video).
 *
 * Sets the default video and playlist shown in the player's dropdown, and the
 * channel allowlist that viewer recommendations are checked against. Viewers
 * still have to clear the Creative Commons check as well -- this list is the
 * second gate, not a bypass.
 *
 * @module adminPlugins/home-video
 */

import {
  DEFAULT_HOME_VIDEO_CONFIG,
  normalizeHomeVideoConfig,
  parseYoutubeUrl,
} from '../homeVideoModeration.js';

export const HOME_VIDEO_PLUGIN_ID = 'home-video';
export const HOME_VIDEO_PLUGIN_LABEL = 'Home Video Player';

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
 * @param {Document} doc
 * @param {string} label
 * @param {string} hint
 * @param {HTMLElement} field
 * @returns {HTMLElement}
 */
function labelled(doc, label, hint, field) {
  const wrap = el(doc, 'div', 'admin-home-video-row');
  wrap.append(el(doc, 'label', 'admin-home-video-label', label));
  wrap.append(field);
  if (hint) wrap.append(el(doc, 'small', 'admin-home-video-hint', hint));
  return wrap;
}

/**
 * @param {HTMLElement} container
 * @param {object} [context]
 * @returns {() => void}
 */
export function renderHomeVideoPane(container, context = {}) {
  const doc = context.document || container?.ownerDocument || globalThis.document;
  if (!container || typeof doc?.createElement !== 'function') return () => {};
  const client = context.client || null;

  const root = el(doc, 'div', 'admin-home-video');
  root.append(el(doc, 'p', 'admin-live-summary',
    'The player sits under the title on the home page. These URLs fill its dropdown and stay listed there whatever is actually playing.'));

  const videoField = el(doc, 'input', 'admin-field');
  videoField.type = 'url';
  videoField.placeholder = DEFAULT_HOME_VIDEO_CONFIG.defaultVideoUrl;

  const playlistField = el(doc, 'input', 'admin-field');
  playlistField.type = 'url';
  playlistField.placeholder = 'https://www.youtube.com/playlist?list=…';

  const channelsField = el(doc, 'textarea', 'admin-field');
  channelsField.rows = 4;
  channelsField.placeholder = 'UCSMOQeBJ2RAnuFungnQOxLg\n@BlenderFoundation';

  root.append(
    labelled(doc, 'DEFAULT VIDEO', 'Autoplays on load, muted. A single video URL.', videoField),
    labelled(doc, 'DEFAULT PLAYLIST', 'Optional. Offered in the dropdown beside the default video.', playlistField),
    labelled(doc, 'APPROVED CHANNELS',
      'One channel ID, @handle, or channel URL per line. A viewer video must be Creative Commons AND from this list. Empty means no recommendation is ever accepted.',
      channelsField),
  );

  const saveBtn = el(doc, 'button', 'scene-btn', 'SAVE');
  saveBtn.type = 'button';
  const message = el(doc, 'p', 'admin-home-video-message');
  message.hidden = true;
  root.append(saveBtn, message);

  const say = (text, warn = false) => {
    message.textContent = text;
    message.hidden = !text;
    message.classList.toggle('warn', Boolean(warn));
  };

  const fill = (config) => {
    videoField.value = config.defaultVideoUrl || '';
    playlistField.value = config.defaultPlaylistUrl || '';
    channelsField.value = (config.approvedChannels || []).join('\n');
  };

  async function boot() {
    if (!client?.homeVideo) return void fill(normalizeHomeVideoConfig(null));
    try {
      fill(normalizeHomeVideoConfig(await client.homeVideo()));
    } catch (error) {
      fill(normalizeHomeVideoConfig(null));
      say(error?.message || 'Could not load the current settings', true);
    }
  }

  const onSave = async () => {
    const video = String(videoField.value || '').trim();
    const playlist = String(playlistField.value || '').trim();
    // Say which field is wrong here rather than letting the server quietly
    // substitute a default and leaving the operator to wonder.
    if (video && parseYoutubeUrl(video).kind !== 'video') {
      return say('DEFAULT VIDEO must be a single YouTube video URL', true);
    }
    if (playlist && parseYoutubeUrl(playlist).kind !== 'playlist') {
      return say('DEFAULT PLAYLIST must be a YouTube playlist URL', true);
    }
    const body = {
      defaultVideoUrl: video,
      defaultPlaylistUrl: playlist,
      approvedChannels: String(channelsField.value || '').split(/[\n,]/),
    };
    if (!client?.saveHomeVideo) return say('ADMIN session is not available', true);
    saveBtn.disabled = true;
    try {
      const saved = normalizeHomeVideoConfig(await client.saveHomeVideo(body));
      fill(saved);
      say(saved.approvedChannels.length
        ? `Saved · ${saved.approvedChannels.length} approved channel(s)`
        : 'Saved · no approved channels, so viewer recommendations will all be refused');
    } catch (error) {
      say(error?.message || 'Save failed', true);
    } finally {
      saveBtn.disabled = false;
    }
  };

  saveBtn.addEventListener('click', onSave);

  if (typeof container.replaceChildren === 'function') container.replaceChildren(root);
  else container.append?.(root);
  void boot();

  return () => {
    saveBtn.removeEventListener?.('click', onSave);
    if (typeof container.replaceChildren === 'function') container.replaceChildren();
  };
}

const homeVideoPlugin = {
  id: HOME_VIDEO_PLUGIN_ID,
  label: HOME_VIDEO_PLUGIN_LABEL,
  description: 'Default video/playlist and the approved-channel list for the home player',
  render: renderHomeVideoPane,
};

export default homeVideoPlugin;
