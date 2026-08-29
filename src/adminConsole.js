/**
 * The ADMIN console: password gate, dashboard menu, plugin-builder chat, the
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

/** Header the admin middleware requires on mutating calls. */
export const ADMIN_REQUEST_HEADER = 'X-GEV-Admin';
/** Poll cadence while an agent turn is in flight. */
export const ADMIN_POLL_MS = 1500;

/**
 * Fixed dashboard menu. Generated plugins are appended after these at runtime
 * by `_renderMenu`, from the manifest `GET /api/admin/menu` reports.
 *
 * @type {ReadonlyArray<{id: string, label: string, description: string}>}
 */
export const ADMIN_MENU_ITEMS = Object.freeze([
  {
    id: 'create-plugin',
    label: 'Create New Admin Menu Plugin',
    description: 'Describe a plugin; the coding agent writes it into this codebase.',
  },
  {
    id: 'mcp-server',
    label: 'MCP Server',
    description: 'Expose this console to external MCP clients with an API key.',
  },
  {
    id: 'live-stream',
    label: 'Go Live (ffmpeg)',
    description: 'Capture the globe with headless Chromium and push it to YouTube over RTMP.',
  },
]);

/** Poll cadence while a broadcast is running. */
export const LIVE_POLL_MS = 3000;

/**
 * One-word status for the broadcast, for the console's state chip.
 *
 * @param {string} status Controller status.
 * @returns {string}
 */
export function liveStatusLabel(status) {
  switch (String(status || '')) {
    case 'starting': return 'STARTING';
    case 'live': return 'LIVE';
    case 'stopped': return 'STOPPED';
    case 'error': return 'ERROR';
    default: return 'OFFLINE';
  }
}

/**
 * Whether the console should currently offer a start button.
 *
 * @param {object} live Public controller state.
 * @returns {boolean}
 */
export function canStartLive(live) {
  const status = String(live?.status || 'idle');
  return status !== 'live' && status !== 'starting';
}

/**
 * Create a YouTube broadcast, an ingest stream, and bind them.
 *
 * Runs in the browser so it reuses the operator's YouTube sign-in cookie; the
 * admin session never holds a Google token. `enableAutoStart` means YouTube
 * flips the broadcast live by itself once ffmpeg's bytes arrive, so no
 * separate transition call is needed.
 *
 * @param {Function} fetchImpl Fetch implementation.
 * @param {{title: string, description?: string, privacyStatus?: string}} options
 * @returns {Promise<{broadcastId: string, streamId: string, ingestUrl: string, streamKey: string, watchUrl: string}>}
 */
export async function provisionYoutubeIngest(fetchImpl, {
  title,
  description = '',
  privacyStatus = 'unlisted',
} = {}) {
  const name = String(title || '').trim();
  if (!name) throw new Error('A broadcast title is required');

  async function call(resource, params, body) {
    const query = new URLSearchParams(params).toString();
    const response = await fetchImpl(`/api/youtube/youtube/v3/${resource}?${query}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let payload = {};
    try { payload = await response.json(); } catch { /* empty body */ }
    if (!response.ok) {
      const error = new Error(payload?.error?.message || 'YouTube rejected the request');
      error.kind = payload?.error?.kind || 'request';
      throw error;
    }
    return payload;
  }

  const stream = await call('liveStreams', { part: 'snippet,cdn,status' }, {
    snippet: { title: `${name} ingest` },
    cdn: { frameRate: 'variable', ingestionType: 'rtmp', resolution: 'variable' },
  });
  const broadcast = await call('liveBroadcasts', { part: 'snippet,status,contentDetails' }, {
    snippet: { title: name, description, scheduledStartTime: new Date().toISOString() },
    status: { privacyStatus, selfDeclaredMadeForKids: false },
    contentDetails: { enableAutoStart: true, enableAutoStop: true },
  });
  await call('liveBroadcasts/bind', {
    part: 'id,contentDetails',
    id: broadcast.id,
    streamId: stream.id,
  });

  return {
    broadcastId: String(broadcast.id || ''),
    streamId: String(stream.id || ''),
    ingestUrl: String(stream?.cdn?.ingestionInfo?.ingestionAddress || ''),
    streamKey: String(stream?.cdn?.ingestionInfo?.streamName || ''),
    watchUrl: broadcast.id ? `https://www.youtube.com/watch?v=${broadcast.id}` : '',
  };
}

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
 * Headline describing the console's readiness.
 *
 * @param {object} state Payload from `GET /api/admin/session`.
 * @returns {string}
 */
export function describeSessionState(state) {
  if (!state?.configured) return 'ADMIN NOT CONFIGURED · SET ADMIN_PASSWORD';
  if (!state.authenticated) return 'LOCKED · ENTER ADMIN PASSWORD';
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

  return {
    session: () => request('/session'),
    login: (password) => request('/login', { method: 'POST', body: { password } }),
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
    startLive: (options) => request('/live/start', { method: 'POST', body: options }),
    stopLive: () => request('/live/stop', { method: 'POST' }),
  };
}

/**
 * Wire the ADMIN launcher, the password gate, and the dashboard.
 */
class AdminConsoleController {
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
      mcp: { enabled: false, endpoint: '/api/admin/mcp', keys: [] },
      freshToken: '',
      live: { status: 'idle', log: [], framesSent: 0, target: '', error: null },
      liveWatchUrl: '',
      menuPlugins: [],
      menuErrors: [],
      busy: false,
      message: '',
    };
    this._pollTimer = null;
    this._livePollTimer = null;
    this._pluginCleanup = null;
    this._menuSignature = '';
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
    document.getElementById('admin-launch')?.addEventListener('click', () => this.open());
    this._el('admin-close')?.addEventListener('click', () => this.close());
    this._el('admin-signout')?.addEventListener('click', () => this._signOut());

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
    this._el('admin-live-provision')?.addEventListener('click', () => void this._provisionLive());

    this._el('admin-mcp-toggle')?.addEventListener('click', () => void this._toggleMcp());
    this._el('admin-mcp-key-form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      void this._createKey();
    });
    this._el('admin-mcp-keys')?.addEventListener('click', (event) => {
      const button = event.target.closest('[data-revoke-key]');
      if (button) void this._revokeKey(button.dataset.revokeKey);
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !this.root.hidden) this.close();
    });
  }

  /** Open the console, refreshing session state first. @returns {Promise<void>} */
  async open() {
    this.root.hidden = false;
    document.body.classList.add('admin-console-open');
    await this._refreshSession();
    if (this.state.session.authenticated) {
      await this._loadPlugins();
      await this._loadMenu();
      this._el('admin-plugin-name')?.focus();
    } else {
      this._el('admin-password')?.focus();
    }
  }

  /** Close the console and stop polling. @returns {void} */
  close() {
    this.root.hidden = true;
    document.body.classList.remove('admin-console-open');
    this._stopPolling();
    this._unmountPluginView();
    document.getElementById('admin-launch')?.focus();
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
    const input = this._el('admin-password');
    const password = String(input?.value || '');
    this.state.busy = true;
    this.state.message = 'Verifying…';
    this._render();
    try {
      this.state.session = await this.client.login(password);
      if (input) input.value = '';
      this.state.message = '';
      await this._loadPlugins();
      await this._loadMenu();
    } catch (error) {
      this.state.message = error.message;
    } finally {
      this.state.busy = false;
      this._render();
    }
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
    this.state.view = ADMIN_MENU_ITEMS[0].id;
    this.state.activePlugin = null;
    this.state.activePluginId = '';
    this.state.freshToken = '';
    this._render();
  }

  /** @returns {Promise<void>} */
  async _loadPlugins() {
    try {
      const payload = await this.client.listPlugins();
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
    if (!view) return;
    this._unmountPluginView();
    this.state.view = view;
    this.state.message = '';
    this._render();
    if (view === 'mcp-server') void this._loadMcp();
    if (view === 'live-stream') void this._loadLive();
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
    let result = { plugins: [], errors: [] };
    try {
      result = await this.registry.load();
    } catch (error) {
      result = { plugins: [], errors: [{ id: '', message: error?.message || 'Could not load plugins' }] };
    }
    this.state.menuPlugins = result.plugins;
    this.state.menuErrors = result.errors;
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

  /** Append the generated plugins after the fixed menu items. @returns {void} */
  _renderMenu() {
    const nav = this._el('admin-menu');
    if (!nav) return;
    // Rebuild only when the plugin set actually changed: `_render` runs on
    // every build poll, and replacing the buttons would steal focus from one.
    const signature = this.state.menuPlugins.map((plugin) => `${plugin.id}:${plugin.label}`).join('|');
    if (signature !== this._menuSignature) {
      this._menuSignature = signature;
      nav.querySelectorAll('[data-admin-generated]').forEach((node) => node.remove());
      this._appendMenuPlugins(nav);
    }
    for (const button of nav.querySelectorAll('[data-admin-generated]')) {
      const active = button.dataset.adminView === this.state.view;
      button.classList.toggle('active', active);
      button.setAttribute('aria-current', active ? 'page' : 'false');
    }

    const errors = this._el('admin-menu-errors');
    if (!errors) return;
    const messages = (this.state.menuErrors || []).map((entry) => entry.message).filter(Boolean);
    errors.textContent = messages.join(' · ');
    errors.hidden = !messages.length;
  }

  /**
   * @param {HTMLElement} nav Menu container.
   * @returns {void}
   */
  _appendMenuPlugins(nav) {
    for (const plugin of this.state.menuPlugins) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'admin-menu-item';
      button.dataset.adminView = plugin.id;
      button.dataset.adminGenerated = '1';
      const label = document.createElement('strong');
      label.textContent = plugin.label;
      const description = document.createElement('small');
      description.textContent = plugin.description || 'Generated from the ADMIN plugin builder.';
      button.append(label, description);
      nav.append(button);
    }
  }

  /** @returns {Promise<void>} */
  async _loadMcp() {
    try {
      this.state.mcp = await this.client.mcpSettings();
    } catch (error) {
      this.state.message = error.message;
    }
    this._render();
  }

  /** @returns {Promise<void>} */
  async _toggleMcp() {
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
  async _loadLive() {
    try {
      const payload = await this.client.liveStatus();
      this.state.live = payload.live || this.state.live;
    } catch (error) {
      this.state.message = error.message;
    }
    this._render();
    this._scheduleLivePoll();
  }

  /**
   * Keep polling only while something is actually in flight.
   *
   * @returns {void}
   */
  _scheduleLivePoll() {
    clearTimeout(this._livePollTimer);
    const status = String(this.state.live?.status || '');
    if (status !== 'live' && status !== 'starting') return;
    this._livePollTimer = setTimeout(() => void this._loadLive(), LIVE_POLL_MS);
  }

  /**
   * Ask YouTube for a broadcast and ingest key, then fill the form.
   *
   * @returns {Promise<void>}
   */
  async _provisionLive() {
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
      const result = await provisionYoutubeIngest(globalThis.fetch.bind(globalThis), {
        title,
        privacyStatus: this._liveValue('admin-live-privacy', 'unlisted') || 'unlisted',
      });
      const ingest = this._el('admin-live-ingest');
      const key = this._el('admin-live-key');
      if (ingest) ingest.value = result.ingestUrl;
      if (key) key.value = result.streamKey;
      this.state.liveWatchUrl = result.watchUrl;
      this.state.message = result.streamKey
        ? 'Broadcast created. Start the encoder to go live.'
        : 'Broadcast created but YouTube returned no ingest key.';
    } catch (error) {
      this.state.message = error.kind === 'insufficient-scope'
        ? 'Reconnect YouTube from the YouTube panel to grant live-control permission.'
        : error.message;
    }
    this.state.busy = false;
    this._render();
  }

  /** @returns {Promise<void>} */
  async _startLive() {
    this.state.busy = true;
    this.state.message = '';
    this._render();
    try {
      const payload = await this.client.startLive({
        captureUrl: this._liveValue('admin-live-capture'),
        ingestUrl: this._liveValue('admin-live-ingest'),
        streamKey: this._liveValue('admin-live-key'),
        width: this._liveValue('admin-live-width'),
        height: this._liveValue('admin-live-height'),
        fps: this._liveValue('admin-live-fps'),
        videoBitrateKbps: this._liveValue('admin-live-bitrate'),
      });
      this.state.live = payload.live || this.state.live;
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

  /** @returns {void} */
  _renderLive() {
    const live = this.state.live || {};
    const chip = this._el('admin-live-state');
    if (chip) {
      chip.textContent = liveStatusLabel(live.status);
      chip.dataset.liveStatus = String(live.status || 'idle');
    }

    const start = this._el('admin-live-start');
    if (start) {
      start.disabled = this.state.busy || !canStartLive(live);
      start.textContent = live.status === 'starting' ? 'STARTING...' : 'START BROADCAST';
    }
    const stop = this._el('admin-live-stop');
    if (stop) stop.disabled = this.state.busy || canStartLive(live);
    const provision = this._el('admin-live-provision');
    if (provision) provision.disabled = this.state.busy || !canStartLive(live);

    const summary = this._el('admin-live-summary');
    if (summary) {
      const parts = [];
      if (live.target) parts.push(`PUBLISHING TO ${live.target}`);
      if (live.settings) {
        parts.push(`${live.settings.width}x${live.settings.height} @ ${live.settings.fps}FPS · ${live.settings.videoBitrateKbps}KBPS`);
      }
      if (live.framesSent) parts.push(`${live.framesSent} FRAMES SENT`);
      if (live.error) parts.push(live.error);
      summary.textContent = parts.join(' · ') || 'Idle. Create or paste an ingest target to begin.';
    }

    const watch = this._el('admin-live-watch');
    if (watch) {
      watch.href = this.state.liveWatchUrl || '#';
      watch.hidden = !this.state.liveWatchUrl;
    }

    const log = this._el('admin-live-log');
    if (log) log.textContent = (live.log || []).join('\n');
  }

  /** @returns {Promise<void>} */
  async _createKey() {
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
    if (!this._pollTimer) return;
    window.clearInterval(this._pollTimer);
    this._pollTimer = null;
  }

  /** Paint every view from `this.state`. @returns {void} */
  _render() {
    const { session } = this.state;
    const status = this._el('admin-status');
    if (status) status.textContent = describeSessionState(session);

    const gate = this._el('admin-gate');
    const dashboard = this._el('admin-dashboard');
    if (gate) gate.hidden = Boolean(session.authenticated);
    if (dashboard) dashboard.hidden = !session.authenticated;

    const unconfigured = this._el('admin-unconfigured');
    if (unconfigured) unconfigured.hidden = Boolean(session.configured);
    const loginForm = this._el('admin-login-form');
    if (loginForm) loginForm.hidden = !session.configured;

    const notice = this._el('admin-message');
    if (notice) {
      notice.textContent = this.state.message;
      notice.hidden = !this.state.message;
    }

    this.root.querySelectorAll('[data-admin-view]').forEach((button) => {
      const active = button.dataset.adminView === this.state.view;
      button.classList.toggle('active', active);
      button.setAttribute('aria-current', active ? 'page' : 'false');
    });
    this.root.querySelectorAll('[data-admin-pane]').forEach((pane) => {
      pane.hidden = pane.dataset.adminPane !== this.state.view;
    });

    this._renderMenu();
    this._renderPluginList();
    this._renderTranscript();
    this._renderMcp();
    this._renderLive();
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
        : 'Create New Admin Menu Plugin';
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
  _renderMcp() {
    const toggle = this._el('admin-mcp-toggle');
    if (toggle) {
      toggle.textContent = this.state.mcp.enabled ? 'DISABLE MCP SERVER' : 'ENABLE MCP SERVER';
      toggle.setAttribute('aria-pressed', String(Boolean(this.state.mcp.enabled)));
    }
    const state = this._el('admin-mcp-state');
    if (state) state.textContent = this.state.mcp.enabled ? 'ONLINE' : 'OFF';

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
export function initAdminConsole({ root = document.getElementById('admin-console'), client } = {}) {
  if (!root) return null;
  return new AdminConsoleController(root, { client: client || createAdminClient() });
}
