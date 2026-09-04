/**
 * ADMIN plugin: Image Library — Youtube Chat brand logo.
 *
 * @module adminPlugins/image-library
 */

import {
  DEFAULT_BRAND_LOGO_URL,
  EVENT,
  applyBrandLogo,
  readConfig,
  writeConfig,
} from '../imageLibrary.js';

export const IMAGE_LIBRARY_PLUGIN_ID = 'image-library';
export const IMAGE_LIBRARY_PLUGIN_LABEL = 'Image Library';

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
export function renderImageLibraryPane(container, context = {}) {
  const doc = context.document || container?.ownerDocument || globalThis.document;
  if (!container || typeof doc?.createElement !== 'function') return () => {};

  const root = el(doc, 'div', 'admin-image-library');
  root.append(el(doc, 'h2', 'admin-image-library-title', IMAGE_LIBRARY_PLUGIN_LABEL));
  root.append(
    el(
      doc,
      'p',
      'admin-image-library-lead',
      'Brand images for the live HUD. The Youtube Chat brand block (#youtube-chat-brand) shows this logo above NOW TAKING REQUESTS.',
    ),
  );

  const previewWrap = el(doc, 'div', 'admin-image-library-preview');
  const previewImg = el(doc, 'img', 'admin-image-library-preview-img');
  previewImg.alt = 'Brand logo preview';
  previewWrap.append(previewImg);

  const urlField = el(doc, 'label', 'admin-field');
  urlField.append(doc.createTextNode('Logo URL (site path or https)'));
  const urlInput = el(doc, 'input', 'admin-field');
  urlInput.type = 'url';
  urlInput.id = 'admin-image-library-logo-url';
  urlInput.placeholder = DEFAULT_BRAND_LOGO_URL;
  urlInput.autocomplete = 'off';
  urlField.append(urlInput);

  const fileField = el(doc, 'label', 'admin-field');
  fileField.append(doc.createTextNode('Or upload image (stored as data URL in this browser)'));
  const fileInput = el(doc, 'input', 'admin-field');
  fileInput.type = 'file';
  fileInput.accept = 'image/png,image/jpeg,image/webp,image/svg+xml,image/gif';
  fileInput.id = 'admin-image-library-file';
  fileField.append(fileInput);

  const row = el(doc, 'div', 'admin-image-library-actions');
  const saveBtn = el(doc, 'button', 'scene-btn', 'SAVE');
  saveBtn.type = 'button';
  saveBtn.id = 'admin-image-library-save';
  const resetBtn = el(doc, 'button', 'scene-btn', 'RESET DEFAULT');
  resetBtn.type = 'button';
  resetBtn.id = 'admin-image-library-reset';
  row.append(saveBtn, resetBtn);

  const message = el(doc, 'p', 'admin-image-library-message', '');
  message.hidden = true;

  root.append(previewWrap, urlField, fileField, row, message);
  if (typeof container.replaceChildren === 'function') container.replaceChildren(root);
  else container.append?.(root);

  const say = (text, warn = false) => {
    message.textContent = text;
    message.hidden = !text;
    message.classList.toggle('warn', Boolean(warn));
  };

  const paint = (url) => {
    const next = String(url || DEFAULT_BRAND_LOGO_URL).trim() || DEFAULT_BRAND_LOGO_URL;
    urlInput.value = next;
    previewImg.src = next;
  };

  paint(readConfig().brandLogoUrl);

  const onFile = () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    if (file.size > 2_500_000) {
      say('Image too large (max ~2.5 MB for localStorage).', true);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || '');
      if (!dataUrl.startsWith('data:image/')) {
        say('Could not read that image.', true);
        return;
      }
      paint(dataUrl);
      say('Upload loaded into preview — click SAVE to apply.');
    };
    reader.onerror = () => say('Upload failed.', true);
    reader.readAsDataURL(file);
  };

  const onSave = () => {
    const url = String(urlInput.value || '').trim() || DEFAULT_BRAND_LOGO_URL;
    const saved = writeConfig({ brandLogoUrl: url });
    applyBrandLogo(doc, saved);
    paint(saved.brandLogoUrl);
    say('Saved — live Youtube Chat brand logo updated.');
  };

  const onReset = () => {
    const saved = writeConfig({ brandLogoUrl: DEFAULT_BRAND_LOGO_URL });
    applyBrandLogo(doc, saved);
    paint(saved.brandLogoUrl);
    fileInput.value = '';
    say('Reset to default Cloud Computer AI.com logo.');
  };

  fileInput.addEventListener('change', onFile);
  saveBtn.addEventListener('click', onSave);
  resetBtn.addEventListener('click', onReset);

  return () => {
    fileInput.removeEventListener('change', onFile);
    saveBtn.removeEventListener('click', onSave);
    resetBtn.removeEventListener('click', onReset);
    if (typeof container.replaceChildren === 'function') container.replaceChildren();
  };
}

const imageLibraryPlugin = {
  id: IMAGE_LIBRARY_PLUGIN_ID,
  label: IMAGE_LIBRARY_PLUGIN_LABEL,
  description: 'Youtube Chat brand logo above NOW TAKING REQUESTS (#youtube-chat-brand)',
  render: renderImageLibraryPane,
};

export default imageLibraryPlugin;
export { EVENT };
