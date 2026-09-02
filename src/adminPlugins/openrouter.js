/**
 * ADMIN plugin: OpenRouter API key + model selection.
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
 * Fallback shown before the first status lands. The authoritative choice list
 * is server-side; the browser never invents a model id.
 */
const DEFAULT_MODEL = 'openrouter/free';

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
    'YouTube comments and COMMANDS run on the model selected here. Only tool-capable models are offered — one without function calling replies in prose and never moves the globe. The key stays on the server.',
  );

  const statusEl = el(doc, 'p', 'admin-openrouter-status', 'Loading…');
  statusEl.id = 'admin-openrouter-status';
  statusEl.setAttribute('role', 'status');

  const facts = el(doc, 'dl', 'admin-openrouter-facts');

  const modelLabel = el(doc, 'label', 'admin-openrouter-model-label', 'Model');
  modelLabel.setAttribute('for', 'admin-openrouter-model');
  const modelSelect = el(doc, 'select', 'admin-openrouter-model');
  modelSelect.id = 'admin-openrouter-model';
  const modelRowEl = el(doc, 'div', 'admin-openrouter-model-row');
  modelRowEl.append(modelLabel, modelSelect);

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
  const testBtn = el(doc, 'button', 'scene-btn', 'TEST');
  testBtn.id = 'admin-openrouter-test';
  testBtn.type = 'button';
  form.append(label, input, save, testBtn);

  const message = el(doc, 'p', 'admin-openrouter-message', '');
  message.id = 'admin-openrouter-message';
  message.hidden = true;

  function paintModelChoices(status) {
    const choices = Array.isArray(status?.choices) && status.choices.length
      ? status.choices
      : [{ id: DEFAULT_MODEL, label: 'Free Models Router', tier: 'free' }];
    const current = String(status?.model || DEFAULT_MODEL);
    if (typeof modelSelect.replaceChildren === 'function') modelSelect.replaceChildren();
    for (const choice of choices) {
      const option = el(doc, 'option', '', `${choice.label} · ${String(choice.tier || '').toUpperCase()}`);
      option.value = choice.id;
      if (choice.id === current) option.selected = true;
      modelSelect.append(option);
    }
    modelSelect.value = current;
  }

  function paintStatus(status) {
    const present = Boolean(status?.present);
    statusEl.dataset.openrouterState = present ? 'present' : 'missing';
    statusEl.textContent = present
      ? `PRESENT · ${status.source || 'admin'} · ${status.model || DEFAULT_MODEL}`
      : 'KEY REQUIRED · paste an OpenRouter key and Save';
    statusEl.classList.toggle('warn', !present);
    paintModelChoices(status);
    if (typeof facts.replaceChildren === 'function') {
      const keyRow = el(doc, 'div');
      const dt = el(doc, 'dt', '', 'API key');
      const dd = el(doc, 'dd', '', present ? 'PRESENT' : 'KEY REQUIRED');
      keyRow.append(dt, dd);
      const modelRow = el(doc, 'div');
      // The effective model the live comment path will send, which is not
      // necessarily the stored one — OPENROUTER_MODEL can still override it.
      modelRow.append(el(doc, 'dt', '', 'Model'), el(doc, 'dd', '', String(status?.model || DEFAULT_MODEL)));
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

  async function onModelChange() {
    message.hidden = true;
    const chosen = String(modelSelect.value || '');
    try {
      const status = await client.saveOpenrouterModel(chosen);
      paintStatus(status);
      message.hidden = false;
      message.textContent = `Model set to ${status.model || chosen}.`;
    } catch (error) {
      message.hidden = false;
      message.textContent = error?.message || 'Could not save the OpenRouter model.';
      // Put the control back on the server's truth rather than leaving it
      // showing a selection that was never persisted.
      void refresh().catch(() => {});
    }
  }

  form.addEventListener('submit', onSave);
  testBtn.addEventListener('click', onTest);
  modelSelect.addEventListener('change', onModelChange);
  root.append(title, lead, statusEl, facts, modelRowEl, form, message);
  if (typeof container.replaceChildren === 'function') container.replaceChildren(root);
  else container.append?.(root);
  void refresh().catch((error) => {
    message.hidden = false;
    message.textContent = error?.message || 'Could not load OpenRouter status.';
  });

  return () => {
    form.removeEventListener?.('submit', onSave);
    testBtn.removeEventListener?.('click', onTest);
    modelSelect.removeEventListener?.('change', onModelChange);
    if (typeof container.replaceChildren === 'function') container.replaceChildren();
  };
}

const openRouterPlugin = {
  id: OPENROUTER_PLUGIN_ID,
  label: OPENROUTER_PLUGIN_LABEL,
  description: 'Set the OpenRouter API key and select which tool-capable model handles YouTube comments and COMMANDS.',
  render: renderOpenRouterPane,
};

export default openRouterPlugin;
