export const VIEW_AGENT_MAX_COMMENT_LENGTH = 500;
export const VIEW_AGENT_MIN_INTERVAL_MS = 4_000;

const ACTIONS = new Set([
  'fly_to_location',
  'set_layer_visibility',
  'set_visual_style',
  'set_panel_open',
  'zoom_to_globe',
]);
const STYLES = new Set(['normal', 'retro', 'surveillance', 'thermal', 'anime', 'noir', 'snow']);
const PANELS = new Set([
  'data-panel', 'location-bar', 'control-panel', 'cctv-panel',
  'radio-panel', 'global-context-panel', 'scene-panel', 'pp-toggles',
]);
const LAYERS = new Set([
  'flights', 'military', 'earthquakes', 'satellites', 'rocket-launches',
  'traffic', 'cctv', 'radio', 'bikeshare', 'ais-live-vessels',
  'local-datacenters', 'local-dams', 'telegeography-submarine-cables',
  'local-firms', 'military-installations',
]);

function boundedText(value, max = VIEW_AGENT_MAX_COMMENT_LENGTH) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

export function normalizeViewerRequest(item, source = 'comment') {
  const id = boundedText(item?.id, 160);
  const comment = boundedText(item?.text);
  if (!id || !comment) return null;
  return {
    id,
    source: source === 'chat' ? 'chat' : 'comment',
    author: boundedText(item?.author, 80) || 'VIEWER',
    comment,
    publishedAt: boundedText(item?.publishedAt, 40),
  };
}

export function validateViewIntent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: 'Agent returned no structured intent' };
  }
  if (value.action === 'ignore') {
    return { ok: true, intent: { action: 'ignore', reason: boundedText(value.reason, 160) || 'No view request detected' } };
  }
  const action = boundedText(value.action, 40);
  if (!ACTIONS.has(action)) return { ok: false, reason: 'Requested action is not allowed' };
  const args = value.args && typeof value.args === 'object' && !Array.isArray(value.args) ? value.args : {};
  let safeArgs;
  if (action === 'fly_to_location') {
    const query = boundedText(args.query, 160);
    const latitude = Number(args.latitude);
    const longitude = Number(args.longitude);
    if (query) safeArgs = { query, viewMode: 'close' };
    else if (Number.isFinite(latitude) && latitude >= -90 && latitude <= 90
      && Number.isFinite(longitude) && longitude >= -180 && longitude <= 180) {
      safeArgs = { latitude, longitude, viewMode: 'close' };
    } else return { ok: false, reason: 'Location request is missing a valid place or coordinates' };
  } else if (action === 'set_layer_visibility') {
    const layerId = boundedText(args.layerId, 80);
    if (!LAYERS.has(layerId)) return { ok: false, reason: 'Requested layer is not allowed' };
    safeArgs = { layerId, enabled: args.enabled !== false };
  } else if (action === 'set_visual_style') {
    const style = boundedText(args.style, 40);
    if (!STYLES.has(style)) return { ok: false, reason: 'Requested style is not allowed' };
    safeArgs = { style };
  } else if (action === 'set_panel_open') {
    const panelId = boundedText(args.panelId, 80);
    if (!PANELS.has(panelId)) return { ok: false, reason: 'Requested panel is not allowed' };
    safeArgs = { panelId, open: args.open !== false };
  } else {
    safeArgs = {};
  }
  return {
    ok: true,
    intent: {
      action,
      args: safeArgs,
      reason: boundedText(value.reason, 160) || 'Viewer requested a frontend view change',
    },
  };
}

export function createViewAgentClient({ fetchImpl = globalThis.fetch } = {}) {
  return {
    async interpret(request, context = {}, signal) {
      const response = await fetchImpl('/api/youtube-view-agent/interpret', {
        method: 'POST',
        signal,
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ request, context }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(payload?.error?.message || 'View agent unavailable');
        error.kind = payload?.error?.kind || 'agent';
        throw error;
      }
      return payload;
    },
  };
}

export class ViewerCommentAgentController {
  constructor({ client = createViewAgentClient(), runner = null, onStatus = () => {}, now = Date.now } = {}) {
    this.client = client;
    this.runner = runner;
    this.onStatus = onStatus;
    this.now = now;
    this.enabled = false;
    this.seen = new Set();
    this.lastRunAt = 0;
    this.controller = null;
    this.generation = 0;
  }

  setRunner(runner) { this.runner = runner; }
  seed(items, source) {
    for (const item of items || []) {
      const request = normalizeViewerRequest(item, source);
      if (request) this.seen.add(`${request.source}:${request.id}`);
    }
  }
  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    if (!this.enabled) this.cancel('VIEW AGENT OFF');
    this.onStatus(this.enabled ? 'VIEW AGENT READY' : 'VIEW AGENT OFF');
  }
  reset() {
    this.seen.clear();
    this.generation += 1;
    this.controller?.abort();
    this.controller = null;
  }
  cancel(status = 'VIEW AGENT CANCELLED') {
    this.generation += 1;
    this.controller?.abort();
    this.controller = null;
    this.onStatus(status);
  }

  async ingest(items, source, context = {}) {
    if (!this.enabled || !this.runner) return null;
    const request = (items || []).map((item) => normalizeViewerRequest(item, source))
      .find((item) => item && !this.seen.has(`${item.source}:${item.id}`));
    if (!request) return null;
    this.seen.add(`${request.source}:${request.id}`);
    if (this.seen.size > 500) this.seen.delete(this.seen.values().next().value);
    if (this.now() - this.lastRunAt < VIEW_AGENT_MIN_INTERVAL_MS) {
      this.onStatus('VIEW AGENT RATE LIMITED');
      return null;
    }
    this.lastRunAt = this.now();
    const generation = ++this.generation;
    this.controller?.abort();
    this.controller = new AbortController();
    this.onStatus(`INTERPRETING · ${request.author}`);
    try {
      const payload = await this.client.interpret(request, context, this.controller.signal);
      if (!this.enabled || generation !== this.generation) return null;
      const checked = validateViewIntent(payload?.intent);
      if (!checked.ok) throw new Error(checked.reason);
      if (checked.intent.action === 'ignore') {
        this.onStatus(`IGNORED · ${checked.intent.reason}`);
        return checked.intent;
      }
      this.onStatus(`APPLYING · ${checked.intent.action}`);
      const result = await this.runner(checked.intent.action, checked.intent.args, {
        signal: this.controller.signal,
        isCurrent: () => this.enabled && generation === this.generation,
      });
      if (generation !== this.generation) return null;
      this.onStatus(result?.ok === false
        ? `REJECTED · ${boundedText(result.error, 120)}`
        : `APPLIED · ${checked.intent.reason}`);
      return { ...checked.intent, result };
    } catch (error) {
      if (error?.name !== 'AbortError' && generation === this.generation) {
        this.onStatus(`VIEW AGENT ERROR · ${boundedText(error?.message, 100)}`);
      }
      return null;
    }
  }
}