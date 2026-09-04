/**
 * The ADMIN console: native login gate, dashboard menu, plugin-builder chat, the
 * MCP server settings page, and the generated plugins the builder has already
 * written into this checkout.
 *
 * The page never holds the admin session token — it lives in an HttpOnly
 * cookie — so this module's whole notion of "signed in" is whatever
 * `GET /api/admin/session` last reported. Every mutating call carries the
 * `X-GEV-Admin` header the server requires.
 *
 * @module adminConsole
 */

import { createPluginRegistry, mountPlugin } from './adminPluginRegistry.js';
import {
  LIVE_POLL_MS,
  canStartLive,
  defaultLiveCaptureUrl,
  formatLiveUptime,
  liveStatusLabel,
  provisionYoutubeIngest,
} from './youtubeLive.js';

export {
  LIVE_POLL_MS,
  canStartLive,
  defaultLiveCaptureUrl,
  formatLiveUptime,
  liveStatusLabel,
  provisionYoutubeIngest,
};

/** Header the admin middleware requires on mutating calls. */
export const ADMIN_REQUEST_HEADER = 'X-GEV-Admin';
/** Poll cadence while an agent turn is in flight. */
export const ADMIN_POLL_MS = 1500;

/**
 * Fixed dashboard menu. Generated plugins are listed in a separate Plugins
 * group at runtime by `_renderMenu`, from the manifest `GET /api/admin/menu`
 * reports.
 *
 * @type {ReadonlyArray<{id: string, label: string, description: string}>}
 */
export const ADMIN_MENU_ITEMS = Object.freeze([
  {
    id: 'create-plugin',
    label: 'Create Plugin',
    description: 'Describe a plugin; the coding agent writes it into this codebase.',
  },
  {
    id: 'mcp-server',
    label: 'MCP Server',
    description: 'Expose this console to external MCP clients with an API key.',
  },
  {
    id: 'live-stream',
    label: 'Go Live',
    description: 'Capture the globe with headless Chromium and push it to YouTube over RTMP.',
  },
  {
    id: 'youtube-settings',
    label: 'YouTube Settings',
    description: 'Sign in, pick channel / broadcast, chat poll, and agent view.',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    description: 'API key and model for YouTube comment actions.',
  },
  {
    id: 'gev-api',
    label: 'Cloud Computer AI.com API',
    description: 'Document and enable every Cloud Computer AI.com function, YouTube owner, Hermes, MCP, and API keys.',
  },
  {
    id: 'hermes-admin',
    label: 'Hermes Admin',
    description: 'YouTube account that may run the Hermes CLI for code, skills, and go-live.',
  },
]);

/** Viewport width at which the left rail becomes a compact drawer. */
export const ADMIN_NAV_COMPACT_MAX_WIDTH = 900;
/** Class on `#admin-console` when the rail is in its compact/drawer layout. */
export const ADMIN_NAV_COMPACT_CLASS = 'admin-nav-compact';
/** Class on `#admin-console` while the compact rail drawer is open. */
export const ADMIN_NAV_DRAWER_OPEN_CLASS = 'admin-nav-drawer-open';

/**
 * One-word status for a plugin build.
 *
 * @param {string} status Job status from the server.
 * @returns {string}
 */
export function pluginStatusLabel(status) {
  switch (String(status || '')) {
    case 'running': return 'BUILDING';
    case 'ready': return 'READY';
    case 'failed': return 'FAILED';
    default: return 'UNKNOWN';
  }
}

/**
 * Speaker label for a transcript entry.
 *
 * @param {string} role
 * @returns {string}
 */
export function transcriptRoleLabel(role) {
  switch (String(role || '')) {
    case 'admin': return 'ADMIN';
    case 'agent': return 'CLAUDE';
    case 'tool': return 'AGENT · TOOL';
    default: return 'SYSTEM';
  }
}

/**
 * Whether the console may show, or act on, anything past the login gate.
 *
 * Both halves matter. `authenticated` is the signed-in session, and
 * `configured` is the server admitting native login is available at all — an
 * unconfigured deployment refuses every route, so a console that painted its
 * dashboard there would offer controls that cannot work.
 *
 * @param {object} state Payload from `GET /api/admin/session`.
 * @returns {boolean}
 */
export function isAdminUnlocked(state) {
  return Boolean(state?.configured && state?.authenticated);
}

/** Class on `#admin-console` that CSS uses to paint operator chrome. */
export const ADMIN_UNLOCKED_CLASS = 'admin-unlocked';

/**
 * Status of the generated-plugins group in the left rail.
 *
 * A missing/empty manifest is `empty` (no plugins, no errors). A failed
 * manifest load is `error` and must not look like a successful plugin list.
 *
 * @param {{ loaded?: boolean, plugins?: object[], errors?: object[] }} state
 * @returns {'loading'|'empty'|'error'|'ready'}
 */
export function pluginNavStatus({ loaded = false, plugins = [], errors = [] } = {}) {
  if (!loaded) return 'loading';
  if ((errors || []).length && !(plugins || []).length) return 'error';
  if (!(plugins || []).length) return 'empty';
  return 'ready';
}

/**
 * Operator-readable copy for a plugins-group status.
 *
 * @param {'loading'|'empty'|'error'|'ready'|string} status
 * @returns {string}
 */
export function pluginNavStatusMessage(status) {
  switch (String(status || '')) {
    case 'loading': return 'Loading plugins…';
    case 'empty': return 'No plugins yet.';
    case 'error': return 'Could not load plugins.';
    default: return '';
  }
}

/**
 * Apply compact-rail and drawer-open classes on the console root.
 *
 * The drawer can only be open in the compact layout; opening it on a wide
 * screen is a no-op so the persistent rail never overlays the workspace.
 *
 * @param {Element|null} root `#admin-console`
 * @param {{ compact?: boolean, drawerOpen?: boolean }} [options]
 * @returns {{ compact: boolean, drawerOpen: boolean }}
 */
export function applyAdminNavLayout(root, { compact = false, drawerOpen = false } = {}) {
  const nextCompact = Boolean(compact);
  const nextOpen = nextCompact && Boolean(drawerOpen);
  if (!root?.classList) return { compact: nextCompact, drawerOpen: nextOpen };
  root.classList.toggle(ADMIN_NAV_COMPACT_CLASS, nextCompact);
  root.classList.toggle(ADMIN_NAV_DRAWER_OPEN_CLASS, nextOpen);
  return { compact: nextCompact, drawerOpen: nextOpen };
}

/**
 * What Escape should do while the ADMIN console is on screen.
 *
 * The compact drawer claims Escape only while it is open — then the key
 * closes the drawer and must not also close the console. Otherwise Escape
 * still closes the console, matching the previous handler.
 *
 * @param {{ consoleOpen?: boolean, compact?: boolean, drawerOpen?: boolean }} [state]
 * @returns {'close-drawer'|'close-console'|null}
 */
export function adminEscapeAction({ consoleOpen = false, compact = false, drawerOpen = false } = {}) {
  if (!consoleOpen) return null;
  if (compact && drawerOpen) return 'close-drawer';
  return 'close-console';
}

/**
 * Next `[data-admin-view]` control for arrow/home/end keys inside the rail.
 *
 * @param {Array<Element>|NodeListOf<Element>} items
 * @param {Element|null} current
 * @param {string} key
 * @returns {Element|null}
 */
export function nextAdminNavItem(items, current, key) {
  const list = [...(items || [])].filter(Boolean);
  if (!list.length) return null;
  const index = list.indexOf(current);
  if (index < 0) {
    if (key === 'End' || key === 'ArrowUp' || key === 'ArrowLeft') return list[list.length - 1];
    if (key === 'Home' || key === 'ArrowDown' || key === 'ArrowRight') return list[0];
    return null;
  }
  switch (key) {
    case 'Home': return list[0];
    case 'End': return list[list.length - 1];
    case 'ArrowDown':
    case 'ArrowRight':
      return list[(index + 1) % list.length];
    case 'ArrowUp':
    case 'ArrowLeft':
      return list[(index - 1 + list.length) % list.length];
    default:
      return null;
  }
}

/**
 * Paint the locked-vs-unlocked admin overlay.
 *
 * Class `admin-unlocked` on the console root is the CSS gate: without it,
 * dashboard, plugin panes, menu, rail, drawer chrome, and sign-out are
 * `display: none !important`. `hidden` stays in step so the accessibility
 * tree matches the paint.
 *
 * @param {Element|null} root `#admin-console`
 * @param {object|null|undefined} session Payload from `GET /api/admin/session`.
 * @param {{ view?: string }} [options] Active dashboard view id when unlocked.
 * @returns {{ unlocked: boolean, showGate: boolean, showDashboard: boolean }}
 */
export function applyAdminLockPaint(root, session, { view = '' } = {}) {
  const unlocked = isAdminUnlocked(session);
  const showGate = !unlocked;
  const showDashboard = unlocked;
  if (!root?.classList) return { unlocked, showGate, showDashboard };

  root.classList.toggle(ADMIN_UNLOCKED_CLASS, unlocked);
  if (!unlocked) root.classList.remove(ADMIN_NAV_DRAWER_OPEN_CLASS);

  const gate = root.querySelector?.('#admin-gate');
  const dashboard = root.querySelector?.('#admin-dashboard');
  const signout = root.querySelector?.('#admin-signout');
  const toggle = root.querySelector?.('#admin-nav-toggle');
  const scrim = root.querySelector?.('#admin-nav-drawer-scrim');
  const nav = root.querySelector?.('#admin-nav');
  if (gate) gate.hidden = unlocked;
  if (dashboard) dashboard.hidden = !unlocked;
  if (signout) signout.hidden = !unlocked;
  if (toggle) toggle.hidden = !unlocked;
  if (scrim && !unlocked) scrim.hidden = true;
  if (nav && !unlocked) nav.setAttribute?.('aria-hidden', 'true');

  const panes = root.querySelectorAll?.('[data-admin-pane]') || [];
  for (const pane of panes) {
    pane.hidden = !unlocked || pane.dataset?.adminPane !== view;
  }

  return { unlocked, showGate, showDashboard };
}

/**
 * Headline describing the console's readiness.
 *
 * @param {object} state Payload from `GET /api/admin/session`.
 * @returns {string}
 */
export function describeSessionState(state) {
  if (!state?.configured) return 'ADMIN NOT CONFIGURED · REPLIT LOGIN UNAVAILABLE';
  if (!state.authenticated) return 'LOCKED · LOGIN REQUIRED';
  return state.mcpEnabled ? 'SIGNED IN · MCP ONLINE' : 'SIGNED IN';
}

/**
 * Ready-to-paste configuration for an external MCP client.
 *
 * @param {object} input
 * @param {string} input.origin Page origin, e.g. `https://example.repl.co`.
 * @param {string} [input.endpoint] Server-reported endpoint path.
 * @param {string} [input.token] Freshly minted key, when one is on screen.
 * @returns {string}
 */
export function adminMcpClientSnippet({ origin, endpoint = '/api/admin/mcp', token = '' }) {
  const url = `${String(origin || '').replace(/\/+$/, '')}${endpoint}`;
  return JSON.stringify({
    mcpServers: {
      'gods-eye-view-admin': {
        type: 'http',
        url,
        headers: { Authorization: `Bearer ${token || '<YOUR_ADMIN_API_KEY>'}` },
      },
    },
  }, null, 2);
}

/**
 * Whether any build in the list still has an agent turn running.
 *
 * @param {object[]} plugins
 * @returns {boolean}
 */
export function hasRunningBuild(plugins) {
  return (plugins || []).some((plugin) => plugin?.status === 'running');
}

/**
 * Same-origin admin API client.
 *
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {object}
 */
export function createAdminClient({ fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('Admin console requires fetch');

  async function request(path, { method = 'GET', body } = {}) {
    const headers = { Accept: 'application/json' };
    if (method !== 'GET') {
      headers[ADMIN_REQUEST_HEADER] = '1';
      if (body !== undefined) headers['Content-Type'] = 'application/json';
    }
    const response = await fetchImpl(`/api/admin${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let payload = {};
    try { payload = await response.json(); } catch { /* 204 and friends */ }
    if (!response.ok) {
      const error = new Error(payload?.error?.message || 'Admin request failed');
      error.kind = payload?.error?.kind || 'request';
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  async function youtubeRequest(path, { method = 'GET' } = {}) {
    const headers = { Accept: 'application/json' };
    if (method !== 'GET') headers[ADMIN_REQUEST_HEADER] = '1';
    const response = await fetchImpl(`/api/youtube/auth${path}`, {
      method,
      headers,
      credentials: 'same-origin',
    });
    let payload = {};
    try { payload = await response.json(); } catch { /* no response body */ }
    if (!response.ok) {
      const error = new Error(payload?.error?.message || 'YouTube authorization request failed');
      error.kind = payload?.error?.kind || 'request';
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  return {
    session: () => request('/session'),
    login: (password) => request('/login', { method: 'POST', body: { password } }),
    loginUrl: (returnTo = '/?admin=1') => `/api/admin/login?returnTo=${encodeURIComponent(returnTo)}`,
    logout: () => request('/logout', { method: 'POST' }),
    menu: () => request('/menu'),
    listPlugins: () => request('/plugins'),
    createPlugin: (name, instructions) => request('/plugins', { method: 'POST', body: { name, instructions } }),
    getPlugin: (id) => request(`/plugins/${encodeURIComponent(id)}`),
    sendPluginMessage: (id, message) => request(`/plugins/${encodeURIComponent(id)}/messages`, {
      method: 'POST',
      body: { message },
    }),
    mcpSettings: () => request('/mcp/settings'),
    setMcpEnabled: (enabled) => request('/mcp/settings', { method: 'POST', body: { enabled } }),
    createMcpKey: (label) => request('/mcp/keys', { method: 'POST', body: { label } }),
    revokeMcpKey: (id) => request(`/mcp/keys/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    liveStatus: () => request('/live'),
    listLiveBroadcasts: () => request('/live/broadcasts'),
    provisionLive: (options) => request('/live/provision', { method: 'POST', body: options }),
    selectLive: (broadcastId) => request('/live/select', { method: 'POST', body: { broadcastId } }),
    startLive: (options) => request('/live/start', { method: 'POST', body: options }),
    refreshLive: () => request('/live/refresh', { method: 'POST' }),
    ingestLiveKey: (options) => request('/live/ingest-key', { method: 'POST', body: options }),
    stopLive: () => request('/live/stop', { method: 'POST' }),
    openrouterStatus: () => request('/openrouter'),
    saveOpenrouter: (body) => request('/openrouter', { method: 'POST', body }),
    saveOpenrouterKey: (apiKey) => request('/openrouter', { method: 'POST', body: { apiKey } }),
    testOpenrouter: () => request('/openrouter/test', { method: 'POST' }),
    gevDocs: () => request('/gev'),
    setGevFunction: (name, enabled) => request('/gev-functions', { method: 'POST', body: { name, enabled } }),
    hermesYoutubeAdmin: () => request('/hermes-youtube-admin'),
    saveHermesYoutubeAdmin: (body) => request('/hermes-youtube-admin', { method: 'POST', body }),
    youtubeStatus: () => youtubeRequest('/status'),
    youtubeConnectUrl: () => '/api/youtube/auth/start?go=1',
    youtubeSignout: () => youtubeRequest('/signout', { method: 'POST' }),
  };
}

const LIVE_POLL_STATUSES = new Set([
  'starting',
  'encoding',
  'ingesting',
  'waiting-for-youtube',
  'live',
]);

/**
 * ADMIN start body: a selected/created broadcast never round-trips the key.
 *
 * @param {object} fields
 * @returns {object}
 */
export function buildAdminLiveStartBody(fields = {}) {
  const broadcastId = String(fields.broadcastId || '').trim();
  const body = {
    captureUrl: String(fields.captureUrl || '').trim(),
    audioSource: String(fields.audioSource || '').trim(),
    autoGoLive: fields.autoGoLive !== false,
    width: fields.width,
    height: fields.height,
    fps: fields.fps,
    videoBitrateKbps: fields.videoBitrateKbps,
  };
  if (broadcastId) {
    body.broadcastId = broadcastId;
    return body;
  }
  body.ingestUrl = String(fields.ingestUrl || '').trim();
  const streamKey = String(fields.streamKey || '').trim();
  if (streamKey) body.streamKey = streamKey;
  return body;
}

/**
 * Wire the ADMIN launcher, native Replit Login, and the dashboard.
 */
export class AdminConsoleController {
  /**
   * @param {HTMLElement} root The `#admin-console` overlay.
   * @param {object} options
   * @param {object} options.client Admin API client.
   * @param {object} [options.registry] Generated-plugin loader; injected in tests.
   */
  constructor(root, { client, registry }) {
    this.root = root;
    this.client = client;
    this.registry = registry || createPluginRegistry({
      loadManifest: async () => (await this.client.menu()).plugins,
      // Fully dynamic on purpose: these modules are written into the checkout
      // after this bundle was built, so Vite must serve them at request time
      // rather than try to resolve them now.
      importModule: (url) => import(/* @vite-ignore */ url),
    });
    this.state = {
      session: { configured: false, authenticated: false, mcpEnabled: false },
      view: 'create-plugin',
      plugins: [],
      activePluginId: '',
      activePlugin: null,
      // Placeholder until `_loadMcp` answers; `mcpLoaded` is what says whether
      // `mcp` describes the server or is still this default.
      mcp: { enabled: false, endpoint: '/api/admin/mcp', keys: [] },
      mcpLoaded: false,
      freshToken: '',
      live: { status: 'idle', log: [], framesSent: 0, target: '', error: null, phases: null },
      youtubeAuth: { configured: false, authenticated: false, canWrite: false, account: null },
      openrouter: { present: false, source: 'missing', model: 'google/gemini-3.8-flash' },
      openrouterLoaded: false,
      hermesYoutubeAdmin: { emails: ['techfundoffice@gmail.com'], handles: ['TechfundOffice'], channelIds: [] },
      hermesYoutubeAdminLoaded: false,
      gevApi: null,
      gevApiLoaded: false,
      liveWatchUrl: '',
      liveBroadcasts: [],
      menuPlugins: [],
      menuErrors: [],
      menuLoaded: false,
      navCompact: false,
      navDrawerOpen: false,
      busy: false,
      message: '',
    };
    this._pollTimer = null;
    this._livePollTimer = null;
    this._pluginCleanup = null;
    this._menuSignature = '';
    this._navMedia = null;
    this._onNavMedia = null;
    this._bind();
  }

  /**
   * @param {string} id
   * @returns {HTMLElement|null}
   */
  _el(id) {
    return this.root.querySelector(`#${id}`) || document.getElementById(id);
  }

  _bind() {
    globalThis.document?.getElementById('admin-launch')?.addEventListener('click', () => this.open());
    this._el('admin-close')?.addEventListener('click', () => this.close());
    this._el('admin-signout')?.addEventListener('click', () => this._signOut());
    this._el('admin-nav-toggle')?.addEventListener('click', () => this._toggleNavDrawer());
    this._el('admin-nav-drawer-scrim')?.addEventListener('click', () => this._setNavDrawerOpen(false));

    this._el('admin-login-form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      void this._signIn();
    });

    // Delegated rather than bound per button: the generated plugins add menu
    // items long after this runs, and they must work without rebinding.
    this.root.addEventListener('click', (event) => {
      const button = event.target?.closest?.('[data-admin-view]');
      if (button) this._setView(button.dataset.adminView);
    });
    this._el('admin-menu')?.addEventListener('keydown', (event) => this._onNavKeydown(event));

    const matchMedia = globalThis.window?.matchMedia;
    if (typeof matchMedia === 'function') {
      this._navMedia = matchMedia(`(max-width: ${ADMIN_NAV_COMPACT_MAX_WIDTH}px)`);
      this._onNavMedia = () => this._syncNavLayout();
      if (this._navMedia.addEventListener) this._navMedia.addEventListener('change', this._onNavMedia);
      else this._navMedia.addListener?.(this._onNavMedia);
      this._syncNavLayout();
    }

    this._el('admin-plugin-form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      void this._submitPluginTurn();
    });

    this._el('admin-plugin-list')?.addEventListener('click', (event) => {
      const row = event.target.closest('[data-plugin-id]');
      if (!row) return;
      void this._openPlugin(row.dataset.pluginId);
    });

    this._el('admin-plugin-new')?.addEventListener('click', () => {
      this.state.activePluginId = '';
      this.state.activePlugin = null;
      this.state.message = '';
      this._render();
    });

    this._el('admin-live-form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      void this._startLive();
    });
    this._el('admin-live-stop')?.addEventListener('click', () => void this._stopLive());
    this._el('admin-live-refresh')?.addEventListener('click', () => void this._refreshLive());
    this._el('admin-live-provision')?.addEventListener('click', () => void this._provisionLive());
    this._el('admin-live-broadcast')?.addEventListener('change', () => void this._selectLive());
    this._el('admin-live-paste')?.addEventListener('click', () => void this._pasteStudioKey());
    this._el('admin-youtube-connect')?.addEventListener('click', () => this._connectYoutube());
    this._el('admin-youtube-signout')?.addEventListener('click', () => void this._signOutYoutube());

    this._el('admin-mcp-toggle')?.addEventListener('click', () => void this._toggleMcp());
    this._el('admin-openrouter-form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      void this._saveOpenrouter();
    });
    this._el('admin-openrouter-test')?.addEventListener('click', () => void this._testOpenrouter());
    this._el('admin-hermes-admin-form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      void this._saveHermesYoutubeAdmin();
    });
    this._el('admin-mcp-key-form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      void this._createKey();
    });
    this._el('admin-mcp-keys')?.addEventListener('click', (event) => {
      const button = event.target.closest('[data-revoke-key]');
      if (button) void this._revokeKey(button.dataset.revokeKey);
    });
    this._el('admin-gev-api-list')?.addEventListener('click', (event) => {
      const button = event.target.closest('[data-gev-fn]');
      if (button) void this._toggleGevFunction(button.dataset.gevFn, button.dataset.enabled !== 'true');
    });

    globalThis.document?.addEventListener('keydown', (event) => this._onDocumentKeydown(event));
  }

  /**
   * Escape closes the compact drawer when it is open, otherwise the console.
   * The drawer path stops the event so it cannot also dismiss the console (or
   * become a fourth global ESC policy). The console-close path is unchanged.
   *
   * @param {KeyboardEvent} event
   * @returns {void}
   */
  _onDocumentKeydown(event) {
    if (event.key !== 'Escape' || this.root.hidden) return;
    const action = adminEscapeAction({
      consoleOpen: !this.root.hidden,
      compact: this.state.navCompact,
      drawerOpen: this.state.navDrawerOpen,
    });
    if (action === 'close-drawer') {
      event.preventDefault?.();
      event.stopImmediatePropagation?.();
      this._setNavDrawerOpen(false);
      return;
    }
    this.close();
  }

  /**
   * Arrow/home/end move focus between left-nav items.
   *
   * @param {KeyboardEvent} event
   * @returns {void}
   */
  _onNavKeydown(event) {
    const next = nextAdminNavItem(
      this._el('admin-menu')?.querySelectorAll?.('[data-admin-view]') || [],
      event.target?.closest?.('[data-admin-view]') || null,
      event.key,
    );
    if (!next || next === event.target) return;
    event.preventDefault?.();
    next.focus?.();
  }

  /** Open the console, refreshing session state first. @returns {Promise<void>} */
  async open() {
    // Locked is the assumption the console opens on. `_refreshSession` is a
    // round trip, and a session that expired between visits would otherwise
    // leave the last operator's dashboard on screen until it answered.
    this.state.session = { ...this.state.session, authenticated: false };
    this._render();
    this.root.hidden = false;
    globalThis.document?.body?.classList?.add('admin-console-open');
    await this._refreshSession();
    if (isAdminUnlocked(this.state.session)) {
      await this._loadPlugins();
      await this._loadMenu();
      this._el('admin-plugin-name')?.focus();
    } else if (this.state.session.configured) {
      this._el('admin-password')?.focus?.();
    }
  }

  /** Close the console and stop polling. @returns {void} */
  close() {
    this._setNavDrawerOpen(false, { restoreFocus: false });
    this.root.hidden = true;
    globalThis.document?.body?.classList?.remove('admin-console-open');
    this._stopPolling();
    this._unmountPluginView();
    globalThis.document?.getElementById('admin-launch')?.focus?.();
  }

  /**
   * Refuse an operator action while the console is locked.
   *
   * The gate is drawn in CSS and in `_render`, but neither prevents a click
   * that reaches a handler anyway — through a stylesheet regression, a stale
   * DOM, or a generated plugin's own markup. The server refuses these calls
   * too; this stops them being made at all, including the YouTube provisioning
   * that rides on the operator's own Google sign-in rather than on the admin
   * session.
   *
   * @returns {boolean} Whether the caller may proceed.
   */
  _requireUnlocked() {
    if (isAdminUnlocked(this.state.session)) return true;
    this.state.message = 'Log in before using ADMIN.';
    this._render();
    return false;
  }

  /** @returns {Promise<void>} */
  async _refreshSession() {
    try {
      this.state.session = await this.client.session();
    } catch (error) {
      this.state.session = { configured: error.status !== 503, authenticated: false, mcpEnabled: false };
      this.state.message = error.message;
    }
    this._render();
  }

  /** @returns {Promise<void>} */
  async _signIn() {
    const password = String(this._el('admin-password')?.value || '');
    if (password && typeof this.client.login === 'function') {
      try {
        this.state.busy = true;
        this._render();
        this.state.session = await this.client.login(password);
        const field = this._el('admin-password');
        if (field) field.value = '';
        this.state.message = '';
        if (isAdminUnlocked(this.state.session)) {
          await this._loadPlugins();
          await this._loadMenu();
        }
      } catch (error) {
        this.state.message = error.message;
      } finally {
        this.state.busy = false;
        this._render();
      }
      return;
    }
    const returnTo = `${window.location.pathname}${window.location.search ? window.location.search : '?admin=1'}`;
    window.location.assign(this.client.loginUrl(returnTo.includes('admin=1') ? returnTo : `${returnTo}${returnTo.includes('?') ? '&' : '?'}admin=1`));
  }

  /** @returns {Promise<void>} */
  async _signOut() {
    this._stopPolling();
    try {
      await this.client.logout();
    } catch { /* the cookie is cleared either way */ }
    this._unmountPluginView();
    this.state.session = { ...this.state.session, authenticated: false };
    this.state.plugins = [];
    this.state.menuPlugins = [];
    this.state.menuErrors = [];
    this.state.menuLoaded = false;
    this.state.view = ADMIN_MENU_ITEMS[0].id;
    this.state.activePlugin = null;
    this.state.activePluginId = '';
    this.state.freshToken = '';
    // The next operator to sign in must re-read the endpoint's real state
    // rather than inherit this session's last view of it.
    this.state.mcp = { enabled: false, endpoint: '/api/admin/mcp', keys: [] };
    this.state.mcpLoaded = false;
    this._render();
  }

  /** @returns {Promise<void>} */
  async _loadPlugins() {
    if (!isAdminUnlocked(this.state.session)) return;
    try {
      const payload = await this.client.listPlugins();
      if (!isAdminUnlocked(this.state.session)) return;
      this.state.plugins = payload.plugins || [];
    } catch (error) {
      this.state.message = error.message;
    }
    this._render();
  }

  /**
   * @param {string} id
   * @returns {Promise<void>}
   */
  async _openPlugin(id) {
    if (!this._requireUnlocked()) return;
    this.state.activePluginId = id;
    try {
      const payload = await this.client.getPlugin(id);
      this.state.activePlugin = payload.plugin;
    } catch (error) {
      this.state.message = error.message;
    }
    this._render();
    this._syncPolling();
  }

  /**
   * Start a build, or send the next chat message into the open one.
   * @returns {Promise<void>}
   */
  async _submitPluginTurn() {
    if (!this._requireUnlocked()) return;
    const nameInput = this._el('admin-plugin-name');
    const messageInput = this._el('admin-plugin-message');
    const name = String(nameInput?.value || '').trim();
    const message = String(messageInput?.value || '').trim();
    this.state.busy = true;
    this.state.message = '';
    this._render();
    try {
      if (this.state.activePlugin) {
        if (!message) return;
        const payload = await this.client.sendPluginMessage(this.state.activePlugin.id, message);
        this.state.activePlugin = payload.plugin;
      } else {
        if (!name) {
          this.state.message = 'Name the plugin you want built.';
          return;
        }
        const payload = await this.client.createPlugin(name, message);
        this.state.activePlugin = payload.plugin;
        this.state.activePluginId = payload.plugin.id;
        if (nameInput) nameInput.value = '';
      }
      if (messageInput) messageInput.value = '';
      await this._loadPlugins();
    } catch (error) {
      this.state.message = error.message;
    } finally {
      this.state.busy = false;
      this._render();
      this._syncPolling();
    }
  }

  /**
   * Switch dashboard views, tearing down whatever the last one mounted.
   *
   * @param {string} view Menu item id — a fixed one or a generated plugin's.
   * @returns {void}
   */
  _setView(view) {
    if (!view || !this._requireUnlocked()) return;
    this._unmountPluginView();
    this.state.view = view;
    this.state.message = '';
    this._setNavDrawerOpen(false, { restoreFocus: false });
    this._render();
    if (view === 'mcp-server') void this._loadMcp();
    if (view === 'live-stream') void this._loadLive();
    if (view === 'openrouter') void this._loadOpenrouter();
    if (view === 'gev-api') void this._loadGevApi();
    if (view === 'hermes-admin') {
      void this._loadHermesYoutubeAdmin();
      if (!this.state.gevApiLoaded) void this._loadGevApi();
      else void this.client.youtubeStatus().then((yt) => { this.state.gevYoutubeAccount = yt?.account || null; this._render(); }).catch(() => {});
    }
    else this._stopLivePolling();
    const plugin = this.state.menuPlugins.find((entry) => entry.id === view);
    if (plugin) this._mountPluginView(plugin);
  }

  /**
   * What a generated plugin is handed as its render context.
   *
   * Deliberately small: the admin API client it is already behind, and the
   * ability to close the console. A plugin wanting more can reach the app the
   * same way any other module does.
   *
   * @returns {object}
   */
  _pluginContext() {
    return {
      client: this.client,
      session: { ...this.state.session },
      close: () => this.close(),
      refresh: () => { void this._loadMenu(); },
    };
  }

  /**
   * Paint one generated plugin into the shared plugin pane.
   *
   * @param {{id: string, render: Function}} plugin
   * @returns {void}
   */
  _mountPluginView(plugin) {
    const host = this._el('admin-plugin-host');
    if (!host) return;
    host.replaceChildren();
    host.dataset.adminPane = plugin.id;
    host.hidden = false;
    const { cleanup, error } = mountPlugin(plugin, host, this._pluginContext());
    this._pluginCleanup = cleanup;
    if (error) this.state.message = error;
    this._render();
  }

  /** Run the mounted plugin's cleanup and empty its pane. @returns {void} */
  _unmountPluginView() {
    if (this._pluginCleanup) {
      this._pluginCleanup();
      this._pluginCleanup = null;
    }
    const host = this._el('admin-plugin-host');
    if (!host) return;
    host.replaceChildren();
    host.dataset.adminPane = '';
    host.hidden = true;
  }

  /**
   * Load the manifest and adopt every plugin the builder has written.
   *
   * @returns {Promise<void>}
   */
  async _loadMenu() {
    if (!isAdminUnlocked(this.state.session)) return;
    let result = { plugins: [], errors: [] };
    try {
      result = await this.registry.load();
    } catch (error) {
      result = { plugins: [], errors: [{ id: '', message: error?.message || 'Could not load plugins' }] };
    }
    if (!isAdminUnlocked(this.state.session)) return;
    this.state.menuPlugins = result.plugins || [];
    this.state.menuErrors = result.errors || [];
    this.state.menuLoaded = true;
    // A plugin that has been deleted from the manifest cannot stay on screen.
    if (!this._isKnownView(this.state.view)) {
      this._unmountPluginView();
      this.state.view = ADMIN_MENU_ITEMS[0].id;
    }
    this._render();
  }

  /**
   * @param {string} view
   * @returns {boolean} Whether the view still exists in the menu.
   */
  _isKnownView(view) {
    return ADMIN_MENU_ITEMS.some((item) => item.id === view)
      || this.state.menuPlugins.some((plugin) => plugin.id === view);
  }

  /** Paint core + generated plugin groups in the left rail. @returns {void} */
  _renderMenu() {
    const nav = this._el('admin-menu');
    if (!nav) return;
    const list = this._el('admin-plugins-list') || nav.querySelector?.('[data-admin-nav-group="plugins"]');
    // Rebuild only when the plugin set actually changed: `_render` runs on
    // every build poll, and replacing the buttons would steal focus from one.
    const signature = [
      this.state.menuLoaded ? '1' : '0',
      this.state.menuPlugins.map((plugin) => `${plugin.id}:${plugin.label}`).join('|'),
      (this.state.menuErrors || []).map((entry) => entry.message).join('|'),
    ].join('~');
    if (signature !== this._menuSignature) {
      this._menuSignature = signature;
      if (list?.querySelectorAll) {
        list.querySelectorAll('[data-admin-generated]').forEach((node) => node.remove());
      } else if (list?.replaceChildren) {
        list.replaceChildren();
      }
      this._appendMenuPlugins(list || nav);
    }
    for (const button of nav.querySelectorAll('[data-admin-view]')) {
      const active = button.dataset.adminView === this.state.view;
      button.classList.toggle('active', active);
      button.setAttribute('aria-current', active ? 'page' : 'false');
    }
    this._paintPluginNavStatus();
  }

  /** Empty / loading / error owned by the Plugins group. @returns {void} */
  _paintPluginNavStatus() {
    const status = pluginNavStatus({
      loaded: this.state.menuLoaded,
      plugins: this.state.menuPlugins,
      errors: this.state.menuErrors,
    });
    const loading = this._el('admin-plugins-loading');
    const empty = this._el('admin-plugins-empty');
    const errors = this._el('admin-menu-errors');
    if (loading) {
      loading.textContent = pluginNavStatusMessage('loading');
      loading.hidden = status !== 'loading';
    }
    if (empty) {
      empty.textContent = pluginNavStatusMessage('empty');
      empty.hidden = status !== 'empty';
    }
    if (!errors) return;
    const messages = (this.state.menuErrors || []).map((entry) => entry.message).filter(Boolean);
    errors.textContent = messages.join(' · ') || (status === 'error' ? pluginNavStatusMessage('error') : '');
    errors.hidden = status !== 'error' && !messages.length;
  }

  /**
   * @param {HTMLElement} nav Plugins list (or the menu, as a fallback).
   * @returns {void}
   */
  _appendMenuPlugins(nav) {
    if (!nav) return;
    const doc = nav.ownerDocument || globalThis.document;
    if (!doc?.createElement) return;
    for (const plugin of this.state.menuPlugins) {
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'admin-menu-item';
      button.dataset.adminView = plugin.id;
      button.dataset.adminGenerated = '1';
      button.title = plugin.description || plugin.label;
      const label = doc.createElement('strong');
      label.textContent = plugin.label;
      const description = doc.createElement('small');
      description.textContent = plugin.description || 'Generated from the ADMIN plugin builder.';
      if (typeof button.append === 'function') button.append(label, description);
      else {
        button.appendChild?.(label);
        button.appendChild?.(description);
      }
      if (typeof nav.append === 'function') nav.append(button);
      else nav.appendChild?.(button);
    }
  }

  /**
   * Keep compact/drawer classes, toggle chrome, and aria in step with state.
   *
   * @returns {void}
   */
  _syncNavLayout() {
    const compact = Boolean(this._navMedia?.matches);
    if (!compact) this.state.navDrawerOpen = false;
    this.state.navCompact = compact;
    this._applyNavDrawerPaint();
  }

  /**
   * Open or close the compact navigation drawer.
   *
   * @param {boolean} open
   * @returns {void}
   */
  /**
   * @param {boolean} open
   * @param {{ restoreFocus?: boolean }} [options]
   * @returns {void}
   */
  _setNavDrawerOpen(open, { restoreFocus = true } = {}) {
    const next = Boolean(open) && this.state.navCompact;
    const changed = next !== this.state.navDrawerOpen;
    this.state.navDrawerOpen = next;
    this._applyNavDrawerPaint();
    if (!changed) return;
    if (next) {
      this._el('admin-menu')?.querySelector?.('[data-admin-view]')?.focus?.();
    } else if (restoreFocus) {
      this._el('admin-nav-toggle')?.focus?.();
    }
  }

  /** Toggle the compact drawer from the header control. @returns {void} */
  _toggleNavDrawer() {
    if (!this._requireUnlocked()) return;
    if (!this.state.navCompact) return;
    this._setNavDrawerOpen(!this.state.navDrawerOpen);
  }

  /** @returns {void} */
  _applyNavDrawerPaint() {
    const { compact, drawerOpen } = applyAdminNavLayout(this.root, {
      compact: this.state.navCompact,
      drawerOpen: this.state.navDrawerOpen,
    });
    this.state.navCompact = compact;
    this.state.navDrawerOpen = drawerOpen;
    const unlocked = isAdminUnlocked(this.state.session);
    const toggle = this._el('admin-nav-toggle');
    if (toggle) {
      toggle.hidden = !unlocked;
      toggle.setAttribute('aria-expanded', String(drawerOpen));
      toggle.setAttribute('aria-label', drawerOpen ? 'Close admin navigation' : 'Open admin navigation');
    }
    const scrim = this._el('admin-nav-drawer-scrim');
    if (scrim) scrim.hidden = !unlocked || !drawerOpen;
    const nav = this._el('admin-nav');
    if (nav) {
      nav.setAttribute('aria-hidden', unlocked ? String(compact && !drawerOpen) : 'true');
    }
  }

  /** @returns {Promise<void>} */
  async _loadMcp() {
    try {
      this.state.mcp = await this.client.mcpSettings();
      this.state.mcpLoaded = true;
    } catch (error) {
      this.state.message = error.message;
    }
    this._render();
  }


  async _loadGevApi() {
    try {
      const docs = await this.client.gevDocs();
      let youtube = null;
      try { youtube = await this.client.youtubeStatus(); } catch { youtube = null; }
      this.state.gevApi = docs;
      this.state.gevYoutubeAccount = youtube?.account || null;
      this.state.gevYoutubeAuth = youtube || null;
      this.state.gevApiLoaded = true;
      this.state.message = '';
    } catch (error) {
      this.state.gevApiLoaded = true;
      this.state.message = error?.message || 'Unable to load Cloud Computer AI.com API docs.';
    }
    this._render();
  }

  async _toggleGevFunction(name, enabled) {
    if (!this._requireUnlocked() || !name) return;
    try {
      await this.client.setGevFunction(name, enabled);
      await this._loadGevApi();
      this.state.message = `${name} ${enabled ? 'enabled' : 'disabled'} for YouTube chat`;
    } catch (error) {
      this.state.message = error?.message || 'Unable to update Cloud Computer AI.com function';
    }
    this._render();
  }

  async _loadOpenrouter() {
    try {
      this.state.openrouter = await this.client.openrouterStatus();
      this.state.openrouterLoaded = true;
    } catch (error) {
      this.state.message = error.message;
    }
    this._render();
  }

  async _saveOpenrouter() {
    const model = String(this._el('admin-openrouter-model')?.value || '').trim();
    const apiKey = String(this._el('admin-openrouter-key')?.value || '').trim();
    const body = {};
    if (model) body.model = model;
    if (apiKey) body.apiKey = apiKey;
    if (!body.model && !body.apiKey) {
      this.state.message = 'Enter a model or an API key.';
      this._render();
      return;
    }
    try {
      this.state.openrouter = await this.client.saveOpenrouter(body);
      this.state.openrouterLoaded = true;
      this.state.message = `Saved OpenRouter model ${this.state.openrouter.model}.`;
      const keyField = this._el('admin-openrouter-key');
      if (keyField) keyField.value = '';
    } catch (error) {
      this.state.message = error.message;
    }
    this._render();
  }

  async _testOpenrouter() {
    try {
      const result = await this.client.testOpenrouter();
      this.state.message = result?.ok
        ? `OpenRouter ok · ${result.model || this.state.openrouter.model}`
        : (result?.error || 'OpenRouter test failed');
    } catch (error) {
      this.state.message = error.message;
    }
    this._render();
  }

  async _loadHermesYoutubeAdmin() {
    try {
      this.state.hermesYoutubeAdmin = await this.client.hermesYoutubeAdmin();
      this.state.hermesYoutubeAdminLoaded = true;
    } catch (error) {
      this.state.message = error.message;
    }
    this._render();
  }

  async _saveHermesYoutubeAdmin() {
    const split = (value) => String(value || '').split(/[,\n]/).map((part) => part.trim()).filter(Boolean);
    const body = {
      emails: split(this._el('admin-hermes-admin-emails')?.value),
      handles: split(this._el('admin-hermes-admin-handles')?.value),
      channelIds: split(this._el('admin-hermes-admin-channels')?.value),
    };
    try {
      this.state.hermesYoutubeAdmin = await this.client.saveHermesYoutubeAdmin(body);
      this.state.hermesYoutubeAdminLoaded = true;
      this.state.message = `Hermes YouTube admin: ${(this.state.hermesYoutubeAdmin.emails || []).join(', ')}`;
    } catch (error) {
      this.state.message = error.message;
    }
    this._render();
  }

  _renderHermesYoutubeAdmin() {
    const cfg = this.state.hermesYoutubeAdmin || {};
    const fill = (id, value) => {
      const field = this._el(id);
      if (field && this.state.hermesYoutubeAdminLoaded && document.activeElement !== field) {
        field.value = value;
      }
    };
    fill('admin-hermes-admin-emails', (cfg.emails || []).join(', '));
    fill('admin-hermes-admin-handles', (cfg.handles || []).join(', '));
    fill('admin-hermes-admin-channels', (cfg.channelIds || []).join(', '));
    const status = this._el('admin-hermes-admin-status');
    if (status) {
      status.textContent = this.state.hermesYoutubeAdminLoaded
        ? `YouTube operator · ${(cfg.emails || []).join(', ') || 'unset'} · @${(cfg.handles || ['TechfundOffice'])[0]}`
        : 'Hermes admin settings have not loaded yet.';
    }
    const account = this._el('admin-hermes-youtube-account');
    if (account) {
      const connected = this.state.gevYoutubeAccount || {};
      account.textContent = connected.email || connected.name
        ? `Connected YouTube account · ${connected.name || ''} ${connected.email || ''}`.trim()
        : 'Connected YouTube account · not signed in on Go Live';
    }
    const cli = this._el('admin-hermes-cli-status');
    if (cli) {
      const hermes = this.state.gevApi?.control?.hermes || {};
      cli.textContent = hermes.bin
        ? `Hermes CLI · ${hermes.bin} · ${hermes.ready ? 'ready' : (hermes.active || 'starting')} · ${hermes.model || ''}`
        : (this.state.gevApiLoaded ? 'Hermes CLI · not installed' : 'Hermes CLI · loading…');
    }
  }

  _renderOpenrouter() {
    const model = this._el('admin-openrouter-model');
    if (model && this.state.openrouterLoaded && document.activeElement !== model) {
      model.value = this.state.openrouter.model || '';
    }
    const status = this._el('admin-openrouter-status');
    if (status) {
      if (!this.state.openrouterLoaded) status.textContent = 'OpenRouter settings have not loaded yet.';
      else {
        const src = this.state.openrouter.source || 'missing';
        const present = this.state.openrouter.present ? 'key present' : 'no key';
        status.textContent = `${this.state.openrouter.model || 'unset'} · ${present} · ${src}`;
      }
    }
  }

  /**
   * Flip the endpoint on or off.
   *
   * The new value is derived from `state.mcp.enabled`, which is only the
   * server's answer once `_loadMcp` has landed. Opening the pane starts that
   * request without awaiting it, so a click that arrives first would otherwise
   * be computed from the placeholder `enabled: false` — sending `true` at an
   * endpoint that is already on, or worse, reading as ONLINE on screen while
   * the server was just told to switch off. The control stays disabled until
   * the real state is in hand.
   *
   * @returns {Promise<void>}
   */
  async _toggleMcp() {
    if (!this._requireUnlocked() || !this.state.mcpLoaded) return;
    try {
      this.state.mcp = await this.client.setMcpEnabled(!this.state.mcp.enabled);
      this.state.session = { ...this.state.session, mcpEnabled: this.state.mcp.enabled };
    } catch (error) {
      this.state.message = error.message;
    }
    this._render();
  }

  /** @returns {string} */
  _liveValue(id, fallback = '') {
    const field = this._el(id);
    return field ? String(field.value ?? '').trim() : fallback;
  }

  /** @returns {Promise<void>} */
  async _loadLive({ refreshBroadcasts = true } = {}) {
    this._ensureCaptureUrl();
    await this._loadYoutubeAuth();
    try {
      const payload = await this.client.liveStatus();
      this.state.live = payload.live || this.state.live;
      if (payload.live?.broadcast?.watchUrl) this.state.liveWatchUrl = payload.live.broadcast.watchUrl;
    } catch (error) {
      this.state.message = error.message;
    }
    if (refreshBroadcasts) {
      try {
        const listed = await this.client.listLiveBroadcasts();
        this.state.liveBroadcasts = Array.isArray(listed.broadcasts) ? listed.broadcasts : [];
      } catch (error) {
        this.state.liveBroadcasts = [];
        if (error.kind === 'authentication' || error.kind === 'insufficient-scope') {
          // Account phase on GET /live already explains this; don't clobber encoder errors.
          if (!this.state.live?.error) this.state.message = error.message;
        }
      }
    }
    this._render();
    this._scheduleLivePoll();
  }

  /** @returns {Promise<void>} */
  async _loadYoutubeAuth() {
    if (typeof this.client.youtubeStatus !== 'function') return;
    try {
      this.state.youtubeAuth = await this.client.youtubeStatus();
    } catch (error) {
      this.state.youtubeAuth = { configured: false, authenticated: false, canWrite: false, account: null };
      if (!this.state.live?.error) this.state.message = error.message;
    }
  }

  /** @returns {void} */
  _connectYoutube() {
    if (!this._requireUnlocked()) return;
    const target = typeof this.client.youtubeConnectUrl === 'function'
      ? this.client.youtubeConnectUrl()
      : '/api/youtube/auth/start?go=1';
    globalThis.location?.assign?.(target);
  }

  /** @returns {Promise<void>} */
  async _signOutYoutube() {
    if (!this._requireUnlocked() || typeof this.client.youtubeSignout !== 'function') return;
    this.state.busy = true;
    this._render();
    try {
      await this.client.youtubeSignout();
      this.state.youtubeAuth = { configured: true, authenticated: false, canWrite: false, account: null };
      this.state.liveBroadcasts = [];
      this.state.message = 'YouTube account disconnected from this server.';
    } catch (error) {
      this.state.message = error.message;
    }
    this.state.busy = false;
    this._render();
  }

  /**
   * Keep polling only while something is actually in flight.
   *
   * @returns {void}
   */
  _scheduleLivePoll() {
    this._stopLivePolling();
    if (this.root.hidden || this.state.view !== 'live-stream') return;
    const status = String(this.state.live?.status || '');
    if (!LIVE_POLL_STATUSES.has(status)) return;
    this._livePollTimer = setTimeout(() => void this._loadLive({ refreshBroadcasts: false }), LIVE_POLL_MS);
  }

  /** @returns {void} */
  _ensureCaptureUrl() {
    const field = this._el('admin-live-capture');
    if (!field || String(field.value || '').trim()) return;
    const origin = globalThis.location?.origin || '';
    field.value = defaultLiveCaptureUrl(origin);
  }

  /**
   * Ask YouTube for a broadcast and ingest key, then fill the form.
   *
   * @returns {Promise<void>}
   */
  async _provisionLive() {
    if (!this._requireUnlocked()) return;
    const title = this._liveValue('admin-live-title');
    if (!title) {
      this.state.message = 'Enter a broadcast title first.';
      this._render();
      return;
    }
    this.state.busy = true;
    this.state.message = 'Creating the YouTube broadcast...';
    this._render();
    try {
      const result = await this.client.provisionLive({
        title,
        privacyStatus: this._liveValue('admin-live-privacy', 'unlisted') || 'unlisted',
        autoGoLive: this._el('admin-live-auto-start')?.checked !== false,
      });
      this._applyBroadcast(result.broadcast);
      if (result.live) this.state.live = result.live;
      this.state.message = result.broadcast?.id
        ? 'Broadcast created. Start the encoder to go live.'
        : 'Broadcast created but YouTube returned no ingest target.';
    } catch (error) {
      this.state.message = error.kind === 'insufficient-scope'
        ? 'Reconnect YouTube above to grant live-control permission.'
        : error.message;
    }
    this.state.busy = false;
    this._render();
  }

  /** @returns {Promise<void>} */
  async _pasteStudioKey() {
    if (!this._requireUnlocked()) return;
    const field = this._el('admin-live-key');
    if (!field) return;
    try {
      const text = await globalThis.navigator?.clipboard?.readText?.();
      const trimmed = String(text || '').trim();
      if (trimmed.length < 4) {
        this.state.message = 'Clipboard does not have a stream key. Copy it from Studio, then try again.';
        this._render();
        return;
      }
      field.value = trimmed;
    } catch {
      this.state.message = 'Allow clipboard access, or paste the key into the stream-key field.';
      this._render();
    }
  }

  /** @returns {Promise<void>} */
  async _startLive() {
    if (!this._requireUnlocked()) return;
    this.state.busy = true;
    this.state.message = '';
    this._render();
    try {
      const payload = await this.client.startLive(buildAdminLiveStartBody({
        broadcastId: this._liveValue('admin-live-broadcast'),
        captureUrl: this._liveValue('admin-live-capture')
          || defaultLiveCaptureUrl(globalThis.location?.origin || ''),
        audioSource: this._liveValue('admin-live-audio'),
        ingestUrl: this._liveValue('admin-live-ingest'),
        streamKey: this._liveValue('admin-live-key'),
        width: this._liveValue('admin-live-width'),
        height: this._liveValue('admin-live-height'),
        fps: this._liveValue('admin-live-fps'),
        videoBitrateKbps: this._liveValue('admin-live-bitrate'),
        autoGoLive: this._el('admin-live-auto-start')?.checked !== false,
      }));
      this.state.live = payload.live || this.state.live;
      if (payload.live?.broadcast?.watchUrl) this.state.liveWatchUrl = payload.live.broadcast.watchUrl;
      if (!canStartLive(this.state.live)) {
        // ffmpeg holds the key now; nothing is gained by leaving a copy in a
        // form field that survives until the console is reloaded.
        const key = this._el('admin-live-key');
        if (key) key.value = '';
      }
    } catch (error) {
      this.state.message = error.message;
      if (error.payload?.live) this.state.live = error.payload.live;
    }
    this.state.busy = false;
    this._render();
    this._scheduleLivePoll();
  }

  /** @returns {Promise<void>} */
  async _stopLive() {
    if (!this._requireUnlocked()) return;
    this.state.busy = true;
    this._render();
    try {
      const payload = await this.client.stopLive();
      this.state.live = payload.live || this.state.live;
    } catch (error) {
      this.state.message = error.message;
    }
    this.state.busy = false;
    clearTimeout(this._livePollTimer);
    this._render();
  }

  /** @returns {Promise<void>} */
  async _refreshLive() {
    if (!this._requireUnlocked()) return;
    this.state.busy = true;
    this.state.message = 'Refreshing the live view without changing the YouTube broadcast...';
    this._render();
    try {
      const payload = await this.client.refreshLive();
      this.state.live = payload.live || this.state.live;
      this.state.message = 'Live view refreshed. The YouTube broadcast and viewer URL stayed the same.';
    } catch (error) {
      this.state.message = error.message;
      if (error.payload?.live) this.state.live = error.payload.live;
    }
    this.state.busy = false;
    this._render();
    this._scheduleLivePoll();
  }

  /**
   * Apply a redacted broadcast view to the form. Never writes a stream key.
   *
   * @param {object|null} broadcast
   * @returns {void}
   */
  _applyBroadcast(broadcast) {
    if (!broadcast?.id) return;
    const ingest = this._el('admin-live-ingest');
    const key = this._el('admin-live-key');
    if (ingest) ingest.value = broadcast.ingestUrl || broadcast.target || '';
    if (key) key.value = '';
    this.state.liveWatchUrl = broadcast.watchUrl || this.state.liveWatchUrl;
    const already = this.state.liveBroadcasts.some((row) => row.id === broadcast.id);
    if (!already) {
      this.state.liveBroadcasts = [
        {
          id: broadcast.id,
          title: broadcast.title,
          privacy: broadcast.privacy,
          lifeCycleStatus: broadcast.lifeCycleStatus,
          watchUrl: broadcast.watchUrl,
        },
        ...this.state.liveBroadcasts,
      ];
    }
    const select = this._el('admin-live-broadcast');
    if (select) select.value = broadcast.id;
  }

  /** @returns {Promise<void>} */
  async _selectLive() {
    if (!this._requireUnlocked()) return;
    const broadcastId = this._liveValue('admin-live-broadcast');
    if (!broadcastId) return;
    this.state.busy = true;
    this.state.message = 'Loading the YouTube broadcast...';
    this._render();
    try {
      const result = await this.client.selectLive(broadcastId);
      this._applyBroadcast(result.broadcast);
      if (result.live) this.state.live = result.live;
      this.state.message = 'Broadcast selected. Start the encoder to go live.';
    } catch (error) {
      this.state.message = error.message;
    }
    this.state.busy = false;
    this._render();
  }

  /** @returns {void} */
  _renderLivePhases(live) {
    const list = this._el('admin-live-phases');
    if (!list) return;
    const phases = live.phases || {};
    for (const row of list.querySelectorAll('[data-live-phase]')) {
      const phase = phases[row.dataset.livePhase] || {};
      row.dataset.ready = phase.ready ? 'true' : 'false';
      const message = row.querySelector('strong');
      if (message) message.textContent = phase.message || '—';
    }
  }

  /** @returns {void} */
  _renderBroadcastSelect(live) {
    const select = this._el('admin-live-broadcast');
    if (!select) return;
    const selected = this._liveValue('admin-live-broadcast') || live.broadcast?.id || '';
    const options = [
      { id: '', title: 'Create new or paste a Studio key', lifeCycleStatus: '' },
      ...this.state.liveBroadcasts,
    ];
    select.replaceChildren();
    for (const row of options) {
      const option = globalThis.document?.createElement?.('option') || { value: '', textContent: '' };
      option.value = row.id || '';
      option.textContent = row.id
        ? `${row.lifeCycleStatus ? `${String(row.lifeCycleStatus).toUpperCase()} · ` : ''}${row.title || row.id}`
        : row.title;
      select.append(option);
    }
    if (selected) select.value = selected;
  }

  /** @returns {void} */
  _renderLive() {
    const live = this.state.live || {};
    const auth = this.state.youtubeAuth || {};
    const authState = this._el('admin-youtube-auth-state');
    if (authState) {
      authState.textContent = !auth.configured
        ? 'NOT CONFIGURED'
        : auth.authenticated && auth.canWrite
          ? 'CONNECTED'
          : auth.authenticated
            ? 'READ ONLY'
            : 'DISCONNECTED';
      authState.dataset.liveStatus = auth.authenticated && auth.canWrite ? 'live' : 'idle';
    }
    const authAccount = this._el('admin-youtube-auth-account');
    if (authAccount) {
      authAccount.textContent = auth.account?.name || auth.account?.email || '';
    }
    const connect = this._el('admin-youtube-connect');
    if (connect) {
      connect.hidden = Boolean(auth.authenticated && auth.canWrite);
      connect.disabled = this.state.busy || !auth.configured;
      connect.textContent = auth.authenticated ? 'RECONNECT YOUTUBE' : 'CONNECT YOUTUBE';
    }
    const youtubeSignout = this._el('admin-youtube-signout');
    if (youtubeSignout) {
      youtubeSignout.hidden = !auth.authenticated;
      youtubeSignout.disabled = this.state.busy;
    }
    const chip = this._el('admin-live-state');
    if (chip) {
      chip.textContent = live.phases?.youtube?.preview && live.status === 'live'
        ? 'YOUTUBE PREVIEW'
        : liveStatusLabel(live.status);
      chip.dataset.liveStatus = String(live.status || 'idle');
    }

    const start = this._el('admin-live-start');
    if (start) {
      start.disabled = this.state.busy || !canStartLive(live);
      start.textContent = live.status === 'starting' ? 'STARTING...' : 'START BROADCAST';
    }
    const stop = this._el('admin-live-stop');
    if (stop) stop.disabled = this.state.busy || canStartLive(live);
    const refresh = this._el('admin-live-refresh');
    if (refresh) refresh.disabled = this.state.busy || canStartLive(live);
    const provision = this._el('admin-live-provision');
    if (provision) provision.disabled = this.state.busy || !canStartLive(live) || !auth.canWrite;

    this._renderLivePhases(live);
    this._renderBroadcastSelect(live);

    const summary = this._el('admin-live-summary');
    if (summary) {
      const parts = [];
      if (live.target) parts.push(`PUBLISHING TO ${live.target}`);
      if (live.settings) {
        parts.push(`${live.settings.width}x${live.settings.height} @ ${live.settings.fps}FPS · ${live.settings.videoBitrateKbps}KBPS · ${live.settings.audioSource === 'track' ? 'AUDIO BED' : 'SILENT'}`);
      }
      const uptime = live.status === 'live' ? formatLiveUptime(live.startedAt) : '';
      if (uptime) parts.push(`UP ${uptime}`);
      if (live.framesSent) parts.push(`${live.framesSent} FRAMES SENT`);
      if (live.phases?.youtube?.message && live.status === 'waiting-for-youtube') {
        parts.push(live.phases.youtube.message);
      }
      if (live.error) parts.push(live.error);
      summary.textContent = parts.join(' · ') || 'Idle. Create or paste an ingest target to begin.';
    }

    const watch = this._el('admin-live-watch');
    if (watch) {
      const href = this.state.liveWatchUrl || live.broadcast?.watchUrl || '';
      watch.href = href || '#';
      watch.hidden = !href;
    }

    const log = this._el('admin-live-log');
    if (log) log.textContent = (live.log || []).join('\n');
  }

  /** @returns {Promise<void>} */
  async _createKey() {
    if (!this._requireUnlocked()) return;
    const input = this._el('admin-mcp-key-label');
    try {
      const payload = await this.client.createMcpKey(String(input?.value || ''));
      this.state.freshToken = payload.token || '';
      if (input) input.value = '';
      await this._loadMcp();
    } catch (error) {
      this.state.message = error.message;
      this._render();
    }
  }

  /**
   * @param {string} id
   * @returns {Promise<void>}
   */
  async _revokeKey(id) {
    if (!this._requireUnlocked()) return;
    try {
      this.state.mcp = await this.client.revokeMcpKey(id);
      this.state.freshToken = '';
    } catch (error) {
      this.state.message = error.message;
    }
    this._render();
  }

  /** Poll only while an agent turn is actually running. @returns {void} */
  _syncPolling() {
    const running = this.state.activePlugin?.status === 'running';
    if (!running) {
      this._stopPolling();
      return;
    }
    if (this._pollTimer) return;
    this._pollTimer = window.setInterval(() => {
      if (this.root.hidden || !this.state.activePluginId) {
        this._stopPolling();
        return;
      }
      void this.client.getPlugin(this.state.activePluginId).then((payload) => {
        this.state.activePlugin = payload.plugin;
        this._render();
        if (payload.plugin?.status !== 'running') {
          this._stopPolling();
          void this._loadPlugins();
          // The build may have just registered a new menu item.
          void this._loadMenu();
        }
      }).catch(() => this._stopPolling());
    }, ADMIN_POLL_MS);
  }

  /** @returns {void} */
  _stopPolling() {
    // Called on close, sign-out, and build completion -- every point where the
    // console must stop touching the network, so the live poll stops here too.
    this._stopLivePolling();
    if (!this._pollTimer) return;
    window.clearInterval(this._pollTimer);
    this._pollTimer = null;
  }

  /** @returns {void} */
  _stopLivePolling() {
    if (!this._livePollTimer) return;
    clearTimeout(this._livePollTimer);
    this._livePollTimer = null;
  }

  /** Paint every view from `this.state`. @returns {void} */
  _render() {
    const { session } = this.state;
    const status = this._el('admin-status');
    if (status) status.textContent = describeSessionState(session);

    const { unlocked } = applyAdminLockPaint(this.root, session, { view: this.state.view });

    const unconfigured = this._el('admin-unconfigured');
    if (unconfigured) unconfigured.hidden = Boolean(session.configured);
    const loginForm = this._el('admin-login-form');
    if (loginForm) loginForm.hidden = !session.configured;

    const notice = this._el('admin-message');
    if (notice) {
      notice.textContent = this.state.message;
      notice.hidden = !this.state.message;
    }

    if (!unlocked) {
      this.state.menuLoaded = false;
      this.state.navDrawerOpen = false;
      this._applyNavDrawerPaint();
      this._clearGeneratedMenu();
      return;
    }

    this.root.querySelectorAll('[data-admin-view]').forEach((button) => {
      const active = button.dataset.adminView === this.state.view;
      button.classList.toggle('active', active);
      button.setAttribute('aria-current', active ? 'page' : 'false');
    });

    this._renderMenu();
    this._applyNavDrawerPaint();
    this._renderPluginList();
    this._renderTranscript();
    this._renderMcp();
    this._renderGevApi();
    this._renderOpenrouter();
    this._renderHermesYoutubeAdmin();
    this._renderLive();
  }

  /** Drop generated plugin tiles so a locked overlay cannot keep them. @returns {void} */
  _clearGeneratedMenu() {
    const list = this._el('admin-plugins-list');
    const nav = this._el('admin-menu');
    const generated = (list || nav)?.querySelectorAll?.('[data-admin-generated]');
    if (generated) {
      for (const node of generated) node.remove?.();
    }
    this._menuSignature = '';
    const loading = this._el('admin-plugins-loading');
    const empty = this._el('admin-plugins-empty');
    const errors = this._el('admin-menu-errors');
    if (loading) loading.hidden = true;
    if (empty) empty.hidden = true;
    if (errors) {
      errors.textContent = '';
      errors.hidden = true;
    }
  }

  /** @returns {void} */
  _renderPluginList() {
    const list = this._el('admin-plugin-list');
    if (!list) return;
    list.replaceChildren();
    if (!this.state.plugins.length) {
      const empty = document.createElement('li');
      empty.className = 'admin-plugin-empty';
      empty.textContent = 'No plugins built yet.';
      list.append(empty);
      return;
    }
    for (const plugin of this.state.plugins) {
      const row = document.createElement('li');
      row.className = 'admin-plugin-row';
      row.dataset.pluginId = plugin.id;
      if (plugin.id === this.state.activePluginId) row.classList.add('active');
      const name = document.createElement('span');
      name.className = 'admin-plugin-name';
      name.textContent = plugin.name;
      const state = document.createElement('span');
      state.className = `admin-plugin-state admin-plugin-state-${plugin.status}`;
      state.textContent = pluginStatusLabel(plugin.status);
      row.append(name, state);
      list.append(row);
    }
  }

  /** @returns {void} */
  _renderTranscript() {
    const feed = this._el('admin-transcript');
    if (!feed) return;
    const plugin = this.state.activePlugin;
    const nameField = this._el('admin-plugin-name-field');
    if (nameField) nameField.hidden = Boolean(plugin);
    const submit = this._el('admin-plugin-submit');
    if (submit) {
      submit.textContent = plugin ? 'SEND' : 'BUILD PLUGIN';
      submit.disabled = this.state.busy;
    }
    const heading = this._el('admin-chat-heading');
    if (heading) {
      heading.textContent = plugin
        ? `${plugin.name} · ${pluginStatusLabel(plugin.status)}`
        : 'Create Plugin';
    }

    feed.replaceChildren();
    const entries = plugin?.transcript || [];
    if (!entries.length) {
      const hint = document.createElement('div');
      hint.className = 'admin-chat-hint';
      hint.textContent = plugin
        ? 'Waiting for the agent…'
        : 'Type the name of the plugin to make, and optionally what it should do. '
          + 'The coding agent writes it into this codebase and registers it in this menu.';
      feed.append(hint);
      return;
    }
    for (const entry of entries) {
      const bubble = document.createElement('div');
      bubble.className = `admin-chat-entry admin-chat-${entry.role}`;
      const who = document.createElement('span');
      who.className = 'admin-chat-role';
      who.textContent = transcriptRoleLabel(entry.role);
      const text = document.createElement('p');
      text.className = 'admin-chat-text';
      text.textContent = entry.text;
      bubble.append(who, text);
      feed.append(bubble);
    }
    feed.scrollTop = feed.scrollHeight;
  }

  /** @returns {void} */

  _renderGevApi() {
    const status = this._el('admin-gev-api-status');
    const list = this._el('admin-gev-api-list');
    const curl = this._el('admin-gev-api-curl');
    const mcp = this._el('admin-gev-api-mcp');
    const owner = this._el('admin-gev-owner');
    const hermes = this._el('admin-gev-hermes');
    const docs = this.state.gevApi;
    const control = docs?.control || {};
    const youtubeOwner = control.youtubeOwner || this.state.hermesYoutubeAdmin || {};
    const account = this.state.gevYoutubeAccount || {};
    const hermesStatus = control.hermes || {};
    if (status) {
      const on = (docs?.functions || []).filter((fn) => fn.enabled !== false).length;
      status.textContent = this.state.gevApiLoaded
        ? (docs ? `${on}/${(docs.functions || []).length} functions enabled for YouTube chat · API key required for REST/MCP` : (this.state.message || 'Unavailable'))
        : 'LOADING';
    }
    if (owner) {
      const connected = account.email || account.name || 'not connected';
      const emails = (youtubeOwner.emails || []).join(', ') || 'unset';
      const handles = (youtubeOwner.handles || []).map((h) => `@${String(h).replace(/^@/, '')}`).join(', ') || 'unset';
      owner.textContent = `YouTube owner · connected: ${connected} · Hermes admin emails: ${emails} · handles: ${handles}`;
    }
    if (hermes) {
      const mcpHealth = hermesStatus.mcp || {};
      const mcpDetail = mcpHealth.connected
        ? ` · MCP ${mcpHealth.serverName || 'connected'} ${mcpHealth.protocolVersion || ''} · ${mcpHealth.exposedCount || 0}/${mcpHealth.discoveredCount || 0} exposed`
        : ` · MCP unavailable${mcpHealth.latestMcpError ? `: ${mcpHealth.latestMcpError}` : ''}`;
      hermes.textContent = this.state.gevApiLoaded
        ? `Hermes · ${hermesStatus.cli ? 'CLI installed' : 'CLI missing'} · ${hermesStatus.bin || 'no bin'} · model ${hermesStatus.model || control.openrouter?.model || 'unset'} · harness ${hermesStatus.active || hermesStatus.preferred || 'hermes'} · MCP ${control.mcpEnabled ? 'on' : 'off'}${mcpDetail}`
        : 'Hermes status loading…';
    }
    if (curl) curl.textContent = docs?.curl || '';
    if (mcp) {
      const cfg = docs?.mcp?.config || docs?.openrouter?.mcp;
      mcp.textContent = cfg
        ? JSON.stringify(cfg, null, 2)
        : 'Enable MCP Server and mint an API key. tools/list is the live Cloud Computer AI.com catalog for OpenRouter / Gemini.';
    }
    if (!list) return;
    list.replaceChildren();
    for (const fn of docs?.functions || []) {
      const row = document.createElement('li');
      row.className = 'admin-key-row admin-gev-fn';
      const name = document.createElement('code');
      name.textContent = fn.name;
      const path = document.createElement('span');
      path.className = 'admin-key-used';
      const keys = fn.parameterKeys || Object.keys(fn.parameters?.properties || {});
      path.textContent = `${fn.method} ${fn.path} · ${fn.description || ''} · args: ${keys.join(', ') || 'none'}`;
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'scene-btn';
      toggle.dataset.gevFn = fn.name;
      toggle.dataset.enabled = fn.enabled === false ? 'false' : 'true';
      toggle.textContent = fn.enabled === false ? 'ENABLE' : 'DISABLE';
      toggle.setAttribute('aria-pressed', String(fn.enabled !== false));
      row.append(name, path, toggle);
      list.append(row);
    }
  }

  _renderMcp() {
    const toggle = this._el('admin-mcp-toggle');
    if (toggle) {
      toggle.textContent = this.state.mcp.enabled ? 'DISABLE MCP SERVER' : 'ENABLE MCP SERVER';
      toggle.setAttribute('aria-pressed', String(Boolean(this.state.mcp.enabled)));
      toggle.disabled = !this.state.mcpLoaded;
    }
    const state = this._el('admin-mcp-state');
    if (state) {
      // Until the settings land, say so rather than claiming the endpoint is
      // off — the placeholder and a genuinely disabled endpoint look identical.
      state.textContent = this.state.mcpLoaded
        ? (this.state.mcp.enabled ? 'ONLINE' : 'OFF')
        : 'CHECKING';
    }

    const snippet = this._el('admin-mcp-snippet');
    if (snippet) {
      snippet.textContent = adminMcpClientSnippet({
        origin: window.location.origin,
        endpoint: this.state.mcp.endpoint,
        token: this.state.freshToken,
      });
    }

    const fresh = this._el('admin-mcp-fresh');
    if (fresh) {
      fresh.textContent = this.state.freshToken
        ? `New key (copy it now — it is not shown again): ${this.state.freshToken}`
        : '';
      fresh.hidden = !this.state.freshToken;
    }

    const keys = this._el('admin-mcp-keys');
    if (!keys) return;
    keys.replaceChildren();
    const rows = this.state.mcp.keys || [];
    if (!rows.length) {
      const empty = document.createElement('li');
      empty.className = 'admin-plugin-empty';
      empty.textContent = 'No API keys yet.';
      keys.append(empty);
      return;
    }
    for (const key of rows) {
      const row = document.createElement('li');
      row.className = 'admin-key-row';
      const label = document.createElement('span');
      label.className = 'admin-key-label';
      label.textContent = `${key.label} · ${key.preview}`;
      const used = document.createElement('span');
      used.className = 'admin-key-used';
      used.textContent = key.lastUsedAt ? `used ${key.lastUsedAt}` : 'never used';
      const revoke = document.createElement('button');
      revoke.type = 'button';
      revoke.className = 'scene-btn scene-btn-danger';
      revoke.dataset.revokeKey = key.id;
      revoke.textContent = 'REVOKE';
      row.append(label, used, revoke);
      keys.append(row);
    }
  }
}

/**
 * Mount the ADMIN console if its markup is present.
 *
 * @param {object} [options]
 * @param {HTMLElement} [options.root]
 * @param {object} [options.client]
 * @returns {AdminConsoleController|null}
 */
export function initAdminConsole({
  root = globalThis.document?.getElementById('admin-console'),
  client,
  registry,
} = {}) {
  if (!root) return null;
  const controller = new AdminConsoleController(root, {
    client: client || createAdminClient(),
    registry,
  });
  try {
    if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('admin') === '1') {
      const url = new URL(window.location.href);
      url.searchParams.delete('admin');
      window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
      queueMicrotask(() => void controller.open());
    }
  } catch {
    // Tests (and any window without a Location) skip the ?admin=1 auto-open.
  }
  return controller;
}
