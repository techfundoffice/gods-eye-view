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

  const trendingEnabled = el(doc, 'input', 'admin-field');
  trendingEnabled.type = 'checkbox';
  const regionField = el(doc, 'input', 'admin-field');
  regionField.placeholder = 'US';
  const refreshMinutesField = el(doc, 'input', 'admin-field');
  refreshMinutesField.type = 'number';
  refreshMinutesField.min = '15';
  refreshMinutesField.value = '60';
  const categoriesField = el(doc, 'input', 'admin-field');
  categoriesField.placeholder = '0,10,20';
  const providerField = el(doc, 'input', 'admin-field');
  providerField.value = 'gemini';
  providerField.placeholder = 'gemini';
  const modelField = el(doc, 'input', 'admin-field');
  modelField.value = 'gemini-2.5-flash';
  modelField.placeholder = 'gemini-2.5-flash';
  const voiceEnabled = el(doc, 'input', 'admin-field');
  voiceEnabled.type = 'checkbox';
  const avatarEnabled = el(doc, 'input', 'admin-field');
  avatarEnabled.type = 'checkbox';
  const manualField = el(doc, 'input', 'admin-field');
  manualField.type = 'url';
  manualField.placeholder = 'Optional YouTube video URL override';

  root.append(
    labelled(doc, 'DEFAULT VIDEO', 'Autoplays on load, muted. A single video URL.', videoField),
    labelled(doc, 'DEFAULT PLAYLIST', 'Optional. Offered in the dropdown beside the default video.', playlistField),
    labelled(doc, 'APPROVED CHANNELS',
      'One channel ID, @handle, or channel URL per line. A viewer video must be Creative Commons AND from this list. Empty means no recommendation is ever accepted.',
      channelsField),
    el(doc, 'h3', 'admin-home-video-section', 'TRENDING AI COMMENTATOR'),
    labelled(doc, 'ENABLE DESK', 'Publishes the read-only AI commentary surface beside Player 1.', trendingEnabled),
    labelled(doc, 'TRENDING REGION', 'YouTube region code used to select the source.', regionField),
    labelled(doc, 'REFRESH MINUTES', 'How long a selected source remains fresh.', refreshMinutesField),
    labelled(doc, 'CATEGORY IDS', 'Comma-separated YouTube category IDs.', categoriesField),
    labelled(doc, 'ANALYSIS PROVIDER', 'Configured provider name; no provider is implied by the viewer.', providerField),
    labelled(doc, 'ANALYSIS MODEL', 'Configured model identifier.', modelField),
    labelled(doc, 'BROWSER VOICE', 'Optional speech synthesis for generated commentary only.', voiceEnabled),
    labelled(doc, 'ABSTRACT AVATAR', 'Show the faceless system state in the desk chrome.', avatarEnabled),
    labelled(doc, 'MANUAL VIDEO OVERRIDE', 'Optional single YouTube URL; source identity remains attributed to YouTube.', manualField),
  );

  const saveBtn = el(doc, 'button', 'scene-btn', 'SAVE');
  saveBtn.type = 'button';
  const refreshBtn = el(doc, 'button', 'scene-btn', 'REFRESH TRENDING');
  refreshBtn.type = 'button';
  const message = el(doc, 'p', 'admin-home-video-message');
  message.hidden = true;
  root.append(saveBtn, refreshBtn, message);

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
  const fillTrending = (config) => {
    trendingEnabled.checked = config?.enabled === true;
    regionField.value = config?.regionCode || 'US';
    refreshMinutesField.value = config?.refreshMinutes ?? 60;
    categoriesField.value = (config?.categoryIds || []).join(',');
    providerField.value = config?.analysisProvider || 'gemini';
    modelField.value = config?.analysisModel || 'gemini-2.5-flash';
    voiceEnabled.checked = Boolean(config?.voiceEnabled);
    avatarEnabled.checked = config?.avatarEnabled === true;
    manualField.value = config?.manualVideoUrl || '';
  };

  async function boot() {
    if (!client?.homeVideo) return void fill(normalizeHomeVideoConfig(null));
    try {
      fill(normalizeHomeVideoConfig(await client.homeVideo()));
      if (client.trendingCommentary) fillTrending(await client.trendingCommentary());
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
    const manual = String(manualField.value || '').trim();
    if (manual && parseYoutubeUrl(manual).kind !== 'video') {
      return say('MANUAL VIDEO OVERRIDE must be a single YouTube video URL', true);
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
      if (client.saveTrendingCommentary) {
        await client.saveTrendingCommentary({
          enabled: Boolean(trendingEnabled.checked),
          regionCode: String(regionField.value || 'US').trim().toUpperCase(),
          refreshMinutes: Math.max(15, Number(refreshMinutesField.value) || 60),
          categoryIds: String(categoriesField.value || '').split(',').map((value) => value.trim()).filter(Boolean),
          analysisProvider: String(providerField.value || 'gemini').trim() || 'gemini',
          analysisModel: String(modelField.value || 'gemini-2.5-flash').trim() || 'gemini-2.5-flash',
          voiceEnabled: Boolean(voiceEnabled.checked),
          avatarEnabled: Boolean(avatarEnabled.checked),
          manualVideoUrl: manual,
        });
      }
      say(saved.approvedChannels.length
        ? `Saved · ${saved.approvedChannels.length} approved channel(s)`
        : 'Saved · no approved channels, so viewer recommendations will all be refused');
    } catch (error) {
      say(error?.message || 'Save failed', true);
    } finally {
      saveBtn.disabled = false;
    }
  };
  const onRefresh = async () => {
    if (!client?.refreshTrendingCommentary) return say('Trending controls are not available', true);
    refreshBtn.disabled = true;
    try {
      const result = await client.refreshTrendingCommentary();
      say(`Trending refresh requested · ${result?.status || 'queued'}`);
    } catch (error) {
      say(error?.message || 'Trending refresh failed', true);
    } finally {
      refreshBtn.disabled = false;
    }
  };

  saveBtn.addEventListener('click', onSave);
  refreshBtn.addEventListener('click', onRefresh);

  if (typeof container.replaceChildren === 'function') container.replaceChildren(root);
  else container.append?.(root);
  void boot();

  return () => {
    saveBtn.removeEventListener?.('click', onSave);
    refreshBtn.removeEventListener?.('click', onRefresh);
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
