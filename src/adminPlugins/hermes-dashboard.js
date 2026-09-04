/**
 * ADMIN plugin: link to the separately managed bundled Hermes dashboard.
 *
 * @module adminPlugins/hermes-dashboard
 */

export const HERMES_DASHBOARD_PLUGIN_ID = 'hermes-dashboard';
export const HERMES_DASHBOARD_PLUGIN_LABEL = 'HERMES DASHBOARD Port 8000';
export const HERMES_DASHBOARD_PORT = '8000';

/**
 * Build the dashboard URL from the ADMIN page's current public hostname.
 * Replit maps the secondary service onto the same hostname at port 8000.
 *
 * @param {Location|URL|{href?: string}} [location]
 * @returns {string}
 */
export function hermesDashboardUrl(location = globalThis.location) {
  const href = String(location?.href || '');
  if (!href) return `http://127.0.0.1:${HERMES_DASHBOARD_PORT}/`;
  try {
    const url = new URL(href);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    url.port = HERMES_DASHBOARD_PORT;
    url.pathname = '/';
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return '';
  }
}

/**
 * @param {HTMLElement} container
 * @param {object} [context]
 * @returns {() => void}
 */
export function renderHermesDashboardPane(container, context = {}) {
  const doc = context.document || container?.ownerDocument || globalThis.document;
  if (!container || typeof doc?.createElement !== 'function') return () => {};

  const root = doc.createElement('div');
  root.className = 'admin-hermes-dashboard';

  const title = doc.createElement('h2');
  title.textContent = HERMES_DASHBOARD_PLUGIN_LABEL;

  const lead = doc.createElement('p');
  lead.textContent = 'Open the bundled Hermes Agent dashboard running as the separate Replit service on port 8000.';

  const link = doc.createElement('a');
  link.id = 'admin-hermes-dashboard-open';
  link.className = 'scene-btn';
  link.textContent = 'OPEN IN A NEW TAB';
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.href = hermesDashboardUrl(context.location || globalThis.location);

  if (!link.href) {
    link.removeAttribute?.('href');
    link.setAttribute('aria-disabled', 'true');
    link.textContent = 'DASHBOARD URL UNAVAILABLE';
  }

  const note = doc.createElement('p');
  note.textContent = 'Sign in with username admin and the existing ADMIN password. Port 5000 remains the globe application.';

  root.append(title, lead, link, note);
  if (typeof container.replaceChildren === 'function') container.replaceChildren(root);
  else container.append?.(root);

  return () => {
    if (typeof container.replaceChildren === 'function') container.replaceChildren();
  };
}

const hermesDashboardPlugin = {
  id: HERMES_DASHBOARD_PLUGIN_ID,
  label: HERMES_DASHBOARD_PLUGIN_LABEL,
  description: 'Open the authenticated bundled Hermes dashboard on Replit port 8000.',
  render: renderHermesDashboardPane,
};

export default hermesDashboardPlugin;