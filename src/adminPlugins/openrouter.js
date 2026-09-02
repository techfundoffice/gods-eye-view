/**
 * ADMIN plugin: OpenRouter Free Models Router key.
 *
 * Operator pastes the key after login (wp-admin style). The raw key never
 * renders; the pane shows PRESENT / KEY REQUIRED and a Test ping.
 *
 * @module adminPlugins/openrouter
 */

import { createAdminClient } from '../adminConsole.js';

export const OPENROUTER_PLUGIN_ID = 'openrouter';
export const OPENROUTER_PLUGIN_LABEL = 'OpenRouter';

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
export function renderOpenRouterPane(container, context = {}) {
  const doc = context.document || container?.ownerDocument || globalThis.document;
  if (!container || typeof doc?.createElement !== 'function') return () => {};

  const client = context.client || createAdminClient({ fetchImpl: context.fetchImpl });

  const root = el(doc, 'div', 'admin-openrouter');
  const title = el(doc, 'h2', 'admin-openrouter-title', OPENROUTER_PLUGIN_LABEL);
  const lead = el(
    doc,
    'p',
    'admin-openrouter-lead',
    'YouTube comments and COMMANDS use the Free Models Router (openrouter/free). The key stays on the server.',
  );

  const statusEl = el(doc, 'p', 'admin-openrouter-status', 'Loading…');
  statusEl.id = 'admin-openrouter-status';
  statusEl.setAttribute('role', 'status');

  const facts = el(doc, 'dl', 'admin-openrouter-facts');

  const form = el(doc, 'form', 'admin-openrouter-form');
  form.id = 'admin-openrouter-form';
  const label = el(doc, 'label', 'admin-openrouter-label', 'API key');
  label.setAttribute('for', 'admin-openrouter-key');
  const input = el(doc, 'input', 'admin-openrouter-key');
  input.id = 'admin-openrouter-key';
  input.type = 'password';
  input.autocomplete = 'off';
  input.placeholder = 'sk-or-…';
  const save = el(doc, 'button', 'scene-btn', 'SAVE');
  save.id = 'admin-openrouter-save';
  save.type = 'submit';
  const testBtn = el(doc, 'button', 'scene-btn', 'TEST /FREE');
  testBtn.id = 'admin-openrouter-test';
  testBtn.type = 'button';
  form.append(label, input, save, testBtn);

  const message = el(doc, 'p', 'admin-openrouter-message', '');
  message.id = 'admin-openrouter-message';
  message.hidden = true;

  function paintStatus(status) {
    const present = Boolean(status?.present);
    statusEl.dataset.openrouterState = present ? 'present' : 'missing';
    statusEl.textContent = present
      ? `PRESENT · ${status.source || 'admin'} · ${status.model || 'openrouter/free'}`
      : 'KEY REQUIRED · paste an OpenRouter key and Save';
    statusEl.classList.toggle('warn', !present);
    if (typeof facts.replaceChildren === 'function') {
      const keyRow = el(doc, 'div');
      const dt = el(doc, 'dt', '', 'API key');
      const dd = el(doc, 'dd', '', present ? 'PRESENT' : 'KEY REQUIRED');
      keyRow.append(dt, dd);
      const modelRow = el(doc, 'div');
      modelRow.append(el(doc, 'dt', '', 'Model'), el(doc, 'dd', '', 'openrouter/free'));
      facts.replaceChildren(keyRow, modelRow);
    }
  }

  async function refresh() {
    const status = await client.openrouterStatus();
    paintStatus(status);
    return status;
  }

  async function onSave(event) {
    event?.preventDefault?.();
    message.hidden = true;
    try {
      const status = await client.saveOpenrouterKey(String(input.value || ''));
      input.value = '';
      paintStatus(status);
      message.hidden = false;
      message.textContent = status.present ? 'Key saved.' : 'Key cleared.';
    } catch (error) {
      message.hidden = false;
      message.textContent = error?.message || 'Could not save the OpenRouter key.';
    }
  }

  async function onTest() {
    message.hidden = true;
    try {
      const result = await client.testOpenrouter();
      message.hidden = false;
      message.textContent = result.ok
        ? `HTTP ${result.status} · ${result.model || 'openrouter/free'}`
        : `Test failed · HTTP ${result.status || ''} ${result.error || ''}`.trim();
    } catch (error) {
      message.hidden = false;
      message.textContent = error?.message || 'OpenRouter test failed.';
    }
  }

  form.addEventListener('submit', onSave);
  testBtn.addEventListener('click', onTest);
  root.append(title, lead, statusEl, facts, form, message);
  if (typeof container.replaceChildren === 'function') container.replaceChildren(root);
  else container.append?.(root);
  void refresh().catch((error) => {
    message.hidden = false;
    message.textContent = error?.message || 'Could not load OpenRouter status.';
  });

  return () => {
    form.removeEventListener?.('submit', onSave);
    testBtn.removeEventListener?.('click', onTest);
    if (typeof container.replaceChildren === 'function') container.replaceChildren();
  };
}

const openRouterPlugin = {
  id: OPENROUTER_PLUGIN_ID,
  label: OPENROUTER_PLUGIN_LABEL,
  description: 'Set the OpenRouter API key used by YouTube comments and COMMANDS (openrouter/free).',
  render: renderOpenRouterPane,
};

export default openRouterPlugin;
