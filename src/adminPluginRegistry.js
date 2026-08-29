/**
 * Discovery and loading of generated ADMIN menu plugins.
 *
 * `adminPluginBuilder` asks the coding agent to write a plugin module into
 * `src/adminPlugins/` and register it in `manifest.json`. This module is the
 * other half of that contract: it turns the manifest into menu entries and
 * loads each module into the dashboard.
 *
 * Everything here is deliberately failure-tolerant. The manifest is written by
 * an agent into a checkout an operator can also hand-edit, so a malformed
 * entry, a missing file, or a module that throws on import must cost that one
 * plugin its menu slot and nothing more — the console itself keeps working.
 * For the same reason nothing in this file touches `node:fs`: it is imported
 * by the browser console and by the server route that reads the manifest.
 *
 * @module adminPluginRegistry
 */

/** Where the dev server serves generated plugin modules from. */
export const ADMIN_PLUGIN_ROUTE_BASE = '/src/adminPlugins/';
/** Upper bound on menu entries, so a runaway manifest cannot flood the nav. */
export const ADMIN_MAX_MENU_PLUGINS = 24;
/** Plugin ids are slugs, matching what `normalizePluginName` produces. */
const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
/** Module files are flat, plain-ASCII filenames inside the plugin directory. */
const PLUGIN_FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\.js$/;

/**
 * Trim and bound a free-text field written by the agent.
 *
 * @param {unknown} value
 * @param {number} limit Maximum characters kept.
 * @returns {string}
 */
function text(value, limit) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

/**
 * Normalize a parsed manifest into menu entries.
 *
 * Accepts either a bare array or `{ plugins: [...] }`, because the agent is
 * told the file is an array but a hand-edit may wrap it. Entries without a
 * usable slug id are dropped, ids are deduplicated first-wins, and the list is
 * capped.
 *
 * @param {unknown} raw Parsed manifest contents.
 * @returns {Array<{id: string, label: string, description: string, module: string}>}
 */
export function normalizePluginManifest(raw) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.plugins) ? raw.plugins : [];
  const seen = new Set();
  const entries = [];
  for (const candidate of list) {
    if (!candidate || typeof candidate !== 'object') continue;
    const id = text(candidate.id, 64).toLowerCase();
    if (!PLUGIN_ID_PATTERN.test(id) || seen.has(id)) continue;
    seen.add(id);
    entries.push({
      id,
      label: text(candidate.label, 80) || id,
      description: text(candidate.description, 160),
      module: text(candidate.module, 160) || `./${id}.js`,
    });
    if (entries.length >= ADMIN_MAX_MENU_PLUGINS) break;
  }
  return entries;
}

/**
 * Resolve a manifest entry's `module` to a URL the browser may import.
 *
 * Only a plain `.js` filename inside the plugin directory is accepted: an
 * absolute path, a parent-directory escape, or anything carrying a scheme is
 * refused rather than rewritten, so a manifest cannot point the console at
 * another origin or at a file outside `src/adminPlugins/`.
 *
 * @param {{module?: string, id?: string}} entry Normalized manifest entry.
 * @param {string} [base] Directory URL the modules are served from.
 * @returns {string} Importable URL, or `''` when the entry is unsafe.
 */
export function pluginModuleUrl(entry, base = ADMIN_PLUGIN_ROUTE_BASE) {
  const raw = String(entry?.module || '').trim();
  if (!raw || raw.startsWith('/') || raw.startsWith('\\') || /^[a-z][a-z0-9+.-]*:/i.test(raw)) return '';
  const file = raw.replace(/^\.\//, '');
  if (!PLUGIN_FILE_PATTERN.test(file)) return '';
  return `${base}${file}`;
}

/**
 * Check a loaded module against the plugin contract.
 *
 * The documented shape is a default export of
 * `{ id, label, description, render(container, context) }`; a module that
 * exports the object directly is accepted too. `render` is the only hard
 * requirement — without it there is nothing to show.
 *
 * @param {unknown} module Imported module namespace.
 * @param {{id: string, label: string, description: string}} entry Manifest entry.
 * @returns {{id: string, label: string, description: string, render: Function}|null}
 */
export function adoptPluginModule(module, entry) {
  const candidate = module && typeof module === 'object' && 'default' in module ? module.default : module;
  if (!candidate || typeof candidate !== 'object') return null;
  if (typeof candidate.render !== 'function') return null;
  return {
    id: entry.id,
    label: text(candidate.label, 80) || entry.label,
    description: text(candidate.description, 160) || entry.description,
    render: candidate.render.bind(candidate),
  };
}

/**
 * Render one plugin into the console and hand back its teardown.
 *
 * A plugin that throws while rendering, or returns something other than a
 * cleanup function, still yields a callable teardown so the caller never has
 * to special-case it.
 *
 * @param {{id: string, render: Function}} plugin Adopted plugin.
 * @param {object} container Element the plugin paints into.
 * @param {object} [context] Value handed to the plugin as its second argument.
 * @returns {{cleanup: () => void, error: string}}
 */
export function mountPlugin(plugin, container, context = {}) {
  let cleanup = () => {};
  try {
    const result = plugin.render(container, context);
    if (typeof result === 'function') {
      cleanup = () => {
        try {
          result();
        } catch {
          // A plugin that fails to tear down must not trap the operator in
          // its own menu item.
        }
      };
    }
  } catch (error) {
    return { cleanup, error: error?.message || `Plugin ${plugin.id} failed to render` };
  }
  return { cleanup, error: '' };
}

/**
 * Build the loader that turns the manifest into usable plugins.
 *
 * @param {object} options
 * @param {() => Promise<unknown>} options.loadManifest Fetches raw manifest entries.
 * @param {(url: string) => Promise<unknown>} options.importModule Imports one module URL.
 * @param {string} [options.base] Directory URL the modules are served from.
 * @returns {{load: () => Promise<{plugins: object[], errors: Array<{id: string, message: string}>}>}}
 */
export function createPluginRegistry({ loadManifest, importModule, base = ADMIN_PLUGIN_ROUTE_BASE }) {
  if (typeof loadManifest !== 'function') throw new TypeError('loadManifest is required');
  if (typeof importModule !== 'function') throw new TypeError('importModule is required');

  async function load() {
    const errors = [];
    let entries = [];
    try {
      entries = normalizePluginManifest(await loadManifest());
    } catch (error) {
      // No manifest route, no manifest file, or a build still in flight: the
      // dashboard simply has no generated plugins yet.
      return { plugins: [], errors: [{ id: '', message: error?.message || 'Could not read the plugin manifest' }] };
    }

    const plugins = [];
    for (const entry of entries) {
      const url = pluginModuleUrl(entry, base);
      if (!url) {
        errors.push({ id: entry.id, message: `${entry.id}: module path is not inside the plugin directory` });
        continue;
      }
      try {
        const adopted = adoptPluginModule(await importModule(url), entry);
        if (!adopted) {
          errors.push({ id: entry.id, message: `${entry.id}: no default export with a render() function` });
          continue;
        }
        plugins.push(adopted);
      } catch (error) {
        errors.push({ id: entry.id, message: `${entry.id}: ${error?.message || 'failed to load'}` });
      }
    }
    return { plugins, errors };
  }

  return { load };
}
