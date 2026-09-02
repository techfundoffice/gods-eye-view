/**
 * Server-safe policy for commands originating in public YouTube chat.
 * This module deliberately has no browser, ADMIN, MCP, or runner imports.
 */

export const PUBLIC_COMMAND_LIMITS = Object.freeze({
  commentText: 500,
  viewerName: 80,
  id: 160,
  modelTurnMs: 90_000,
  totalMs: 86_400_000,
  modelTurns: 8,
  toolCalls: 4,
});

const string = (extra = {}) => ({ type: 'string', ...extra });
const number = (extra = {}) => ({ type: 'number', ...extra });
const boolean = { type: 'boolean' };
const object = (properties = {}, extra = {}) => ({
  type: 'object', additionalProperties: false, properties, ...extra,
});
const array = (items, extra = {}) => ({ type: 'array', items, ...extra });
const enumeration = (...values) => string({ enum: values });

const location = {
  locationId: enumeration('austin', 'sf', 'nyc', 'tokyo', 'london', 'paris', 'dubai', 'dc'),
  query: string({ maxLength: 200 }),
  latitude: number({ minimum: -90, maximum: 90 }),
  longitude: number({ minimum: -180, maximum: 180 }),
  rangeM: number({ minimum: 100, maximum: 20_000_000 }),
  viewMode: enumeration('close', 'overview'),
  waitForArrival: boolean,
};

// These are the same public GEV action names and argument vocabulary consumed
// by the existing validated action runner. Keeping schemas here makes them
// usable in Node without importing Cesium/browser modules.
const SCHEMAS = {
  fly_to_location: object(location),
  select_nearest_aircraft: object({
    layerId: enumeration('flights', 'military'), locationId: location.locationId,
    locationQuery: string({ maxLength: 160 }), latitude: location.latitude, longitude: location.longitude,
  }, { required: ['layerId'] }),
  adjust_camera_zoom: object({ direction: enumeration('in', 'out'), amount: enumeration('little', 'medium', 'lot') }, { required: ['direction', 'amount'] }),
  zoom_to_globe: object(),
  set_layer_visibility: object({
    layerId: enumeration('flights', 'military', 'earthquakes', 'natural-hazards', 'satellites', 'rocket-launches', 'traffic', 'cctv', 'radio', 'bikeshare', 'ais-live-vessels', 'local-datacenters', 'local-dams', 'telegeography-submarine-cables', 'local-firms'),
    enabled: boolean,
  }, { required: ['layerId', 'enabled'] }),
  show_data_layers_menu: object({
    layerId: enumeration('flights', 'military', 'earthquakes', 'natural-hazards', 'satellites', 'traffic', 'cctv', 'radio', 'bikeshare', 'ais-live-vessels', 'local-datacenters', 'local-dams', 'telegeography-submarine-cables', 'local-firms'),
  }),
  set_panel_open: object({
    panelId: enumeration('data-panel', 'location-bar', 'control-panel', 'cctv-panel', 'radio-panel', 'scene-panel', 'pp-toggles', 'global-context-panel'),
    open: boolean,
  }, { required: ['panelId', 'open'] }),
  set_context_mode: object({ mode: enumeration('off', 'contacts', 'flights', 'space-missions', 'missions') }, { required: ['mode'] }),
  control_cockpit: object({
    action: enumeration('enter', 'exit', 'previous', 'next', 'prev', 'status'),
    targetLayer: enumeration('flights', 'military', 'ais-live-vessels', 'military-installations'),
    aircraftClass: string({ maxLength: 80 }),
  }, { required: ['action'] }),
  set_visual_style: object({ style: enumeration('normal', 'retro', 'surveillance', 'thermal', 'anime', 'noir', 'snow') }, { required: ['style'] }),
  get_entity_context: object({
    scope: enumeration('auto', 'selected', 'in_view'),
    layerId: enumeration('local-datacenters', 'local-dams', 'telegeography-submarine-cables', 'local-firms'),
    limit: number({ minimum: 1, maximum: 12 }),
  }),
  get_current_view_state: object(),
  set_hud: object({ visible: enumeration('on', 'off', 'auto'), layout: enumeration('tactical', 'operator', 'minimal') }),
  set_detection: object({
    enabled: boolean, mode: enumeration('sparse', 'balanced', 'dense'),
    densityPct: number(),
    allocationStrategy: enumeration('elastic', 'weighted'),
  }),
  set_map_stack: object({ stack: enumeration('photoreal', 'bing-aerial', 'bing-labels', 'osm') }, { required: ['stack'] }),
  set_post_processing: object({
    bloom: object({ enabled: boolean, intensity: number(), threshold: number() }),
    sharpen: object({ enabled: boolean, intensity: number() }),
  }),
  control_scene: object({ action: enumeration('list', 'play', 'stop', 'next', 'status'), sceneId: string() }, { required: ['action'] }),
  control_cctv: object({
    action: enumeration('enable', 'disable', 'select', 'next', 'prev', 'nearest', 'focus', 'coverage', 'viewshed', 'adjust', 'projection', 'autohop'),
    cameraQuery: string(), enabled: boolean,
  }, { required: ['action'] }),
  control_radio: object({
    action: enumeration('enable', 'disable', 'play', 'resume', 'pause', 'stop', 'next', 'previous', 'volume', 'select', 'status'),
    category: enumeration('all', 'news', 'talk', 'weather', 'public-safety', 'aviation-marine', 'traffic-transit', 'music'),
    country: string({ maxLength: 80 }), stationQuery: string({ maxLength: 120 }),
    locationId: location.locationId, locationQuery: string({ maxLength: 120 }),
    latitude: location.latitude, longitude: location.longitude,
    volumePct: number({ minimum: 0, maximum: 100 }),
  }, { required: ['action'] }),
  track_entity: object({ query: string({ maxLength: 160 }), layerId: string({ maxLength: 80 }) }, { required: ['query'] }),
  stop_tracking: object(),
  frame_overhead: object({ target: enumeration('flights', 'military', 'satellites', 'vessels'), radiusKm: number() }, { required: ['target'] }),
  annotate_map: object({
    annotations: array(object({
      type: enumeration('pin', 'highlight', 'area', 'arrow', 'route'),
      label: string({ maxLength: 120 }), query: string({ maxLength: 200 }),
      entityKind: enumeration('building', 'compound', 'district', 'street', 'point_feature'),
      latitude: location.latitude, longitude: location.longitude,
      screenX: number({ minimum: 0, maximum: 1 }), screenY: number({ minimum: 0, maximum: 1 }),
      points: array(object({ query: string({ maxLength: 200 }), latitude: location.latitude, longitude: location.longitude }), { maxItems: 12 }),
      mode: enumeration('walking', 'driving', 'cycling'),
    }, { required: ['type', 'label'] }), { minItems: 1, maxItems: 10 }),
    flyTo: boolean, persist: boolean,
  }, { required: ['annotations'] }),
  clear_annotations: object(),
  move_camera: object({
    motion: enumeration('orbit', 'pan', 'tilt', 'rotate', 'stop'),
    direction: enumeration('left', 'right', 'up', 'down'),
    speed: enumeration('slow', 'normal', 'fast'), mode: enumeration('once', 'continuous'),
  }, { required: ['motion'] }),
  fly_route: object({ label: string(), speed: enumeration('slow', 'normal', 'fast') }),
  analyst_query: object({
    layers: array(string({ maxLength: 80 }), { minItems: 1, maxItems: 8 }),
    scope: object({ kind: enumeration('view', 'radius', 'world'), query: string({ maxLength: 160 }), radiusKm: number({ minimum: 1, maximum: 20_000 }) }),
    filters: array(object({ field: string({ maxLength: 80 }), op: string({ maxLength: 20 }), value: {} }), { maxItems: 12 }),
    sortBy: string({ maxLength: 80 }), sortDir: enumeration('asc', 'desc'),
    limit: number({ minimum: 1, maximum: 100 }), followUp: boolean,
  }),
  next_iss_pass: object({
    latitude: location.latitude, longitude: location.longitude,
    minElevationDeg: number({ minimum: 5, maximum: 60 }),
  }),
  run_view_preset: object({
    preset: enumeration('/live-contacts', '/space-missions', '/environmental', '/explore-manually'),
  }, { required: ['preset'] }),
};

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

export const PUBLIC_GEV_TOOL_CATALOG = deepFreeze(Object.fromEntries(
  Object.entries(SCHEMAS).map(([name, parameters]) => [name, {
    type: 'function',
    name,
    description: `Public God's Eye View action: ${name.replaceAll('_', ' ')}`,
    parameters,
  }]),
));

export const PUBLIC_GEV_TOOL_NAMES = Object.freeze(Object.keys(PUBLIC_GEV_TOOL_CATALOG));

const Y_TOOLS = ['get_current_view_state', 'get_entity_context', 'analyst_query', 'next_iss_pass'];
const Z_TOOLS = ['fly_to_location', 'select_nearest_aircraft', 'adjust_camera_zoom', 'zoom_to_globe', 'move_camera', 'frame_overhead', 'fly_route', 'stop_tracking'];

/** Exact GEV ACTIONS reply for `/help`. The space before the first comma is intentional. */
export const PUBLIC_HELP_REPLY = 'I can help you if you type /live-contacts , /space-missions, /environmental, /explore-manually';

/** Slash command → first-run Mission Control choice. `/explore-manually` is required. */
export const PUBLIC_VIEW_PRESETS = deepFreeze({
  '/live-contacts': 'contacts',
  '/space-missions': 'space-missions',
  '/environmental': 'environmental',
  '/explore-manually': 'explore',
});

export const PUBLIC_COMMAND_REGISTRY = deepFreeze({
  '/help': { command: '/help', mode: 'help', description: 'List view commands', requiresText: false, enabled: true, tools: [] },
  '/live-contacts': { command: '/live-contacts', mode: 'live-contacts', description: 'Live contacts', requiresText: false, enabled: true, tools: ['run_view_preset'] },
  '/space-missions': { command: '/space-missions', mode: 'space-missions', description: 'Space missions', requiresText: false, enabled: true, tools: ['run_view_preset'] },
  '/environmental': { command: '/environmental', mode: 'environmental', description: 'Environmental view', requiresText: false, enabled: true, tools: ['run_view_preset'] },
  '/explore-manually': { command: '/explore-manually', mode: 'explore-manually', description: 'Explore manually', requiresText: false, enabled: true, tools: ['run_view_preset'] },
  '/x': { command: '/x', mode: 'execute', description: 'Execute or operate GEV', requiresText: true, enabled: true, tools: PUBLIC_GEV_TOOL_NAMES },
  '/y': { command: '/y', mode: 'analyze', description: 'Analyze or answer from GEV data', requiresText: true, enabled: true, tools: Y_TOOLS },
  '/z': { command: '/z', mode: 'navigate', description: 'Move or frame the camera', requiresText: true, enabled: true, tools: Z_TOOLS },
  '/gods-eye-view': { command: '/gods-eye-view', mode: 'whole-globe', description: 'Frame the whole globe', requiresText: false, enabled: true, tools: ['zoom_to_globe'] },
});

export function publicCommandLegend() {
  return Object.values(PUBLIC_COMMAND_REGISTRY).map(({ command, description, mode }) => ({ command, description, mode }));
}

/** Pure leading-command parser. Unknown slash text is intentionally ordinary. */
export function parsePublicCommand(value) {
  const text = String(value ?? '').trim();
  if (!text) return { recognized: false, command: null, mode: null, request: '', valid: false, reason: 'empty' };
  const token = text.match(/^(\S+)/)?.[1].toLowerCase() || '';
  const policy = PUBLIC_COMMAND_REGISTRY[token];
  if (!policy) return { recognized: false, command: null, mode: null, request: text, valid: false, reason: 'unknown' };
  const request = text.slice(token.length).trim();
  if (policy.requiresText && !request) {
    return { recognized: true, command: token, mode: policy.mode, request, valid: false, reason: 'request-required' };
  }
  return { recognized: true, command: token, mode: policy.mode, request, valid: true, reason: '' };
}

function validateSchema(schema, value, path, errors) {
  if (!schema || !Object.keys(schema).length) return;
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return void errors.push(`${path} must be an object`);
    for (const key of schema.required || []) if (!(key in value)) errors.push(`${path}.${key} is required`);
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) if (!(key in (schema.properties || {}))) errors.push(`${path}.${key} is not allowed`);
    }
    for (const [key, child] of Object.entries(schema.properties || {})) if (key in value) validateSchema(child, value[key], `${path}.${key}`, errors);
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) return void errors.push(`${path} must be an array`);
    if (value.length < (schema.minItems || 0)) errors.push(`${path} has too few items`);
    if (schema.maxItems != null && value.length > schema.maxItems) errors.push(`${path} has too many items`);
    value.forEach((item, index) => validateSchema(schema.items, item, `${path}[${index}]`, errors));
  } else if (schema.type === 'string') {
    if (typeof value !== 'string') errors.push(`${path} must be a string`);
    else if (schema.maxLength != null && value.length > schema.maxLength) errors.push(`${path} is too long`);
  } else if (schema.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) errors.push(`${path} must be a finite number`);
  else if (schema.type === 'boolean' && typeof value !== 'boolean') errors.push(`${path} must be a boolean`);
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path} is not an allowed value`);
  if (typeof value === 'number' && (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) errors.push(`${path} is out of range`);
}

/** Validate untrusted model output both for mode membership and arguments. */
export function validatePublicToolCall(modeOrCommand, name, args) {
  const policy = PUBLIC_COMMAND_REGISTRY[modeOrCommand]
    || Object.values(PUBLIC_COMMAND_REGISTRY).find((entry) => entry.mode === modeOrCommand);
  if (!policy) return { ok: false, reason: 'Unknown public command mode' };
  if (!policy.enabled) return { ok: false, reason: 'Command mode is disabled' };
  if (!policy.tools.includes(name) || !PUBLIC_GEV_TOOL_CATALOG[name]) return { ok: false, reason: 'Tool is not allowed in this mode' };
  const errors = [];
  validateSchema(PUBLIC_GEV_TOOL_CATALOG[name].parameters, args, 'arguments', errors);
  return errors.length ? { ok: false, reason: errors[0], errors } : { ok: true, name, arguments: structuredClone(args) };
}

export function toolsForPublicMode(modeOrCommand) {
  const policy = PUBLIC_COMMAND_REGISTRY[modeOrCommand]
    || Object.values(PUBLIC_COMMAND_REGISTRY).find((entry) => entry.mode === modeOrCommand);
  return policy ? policy.tools.map((name) => PUBLIC_GEV_TOOL_CATALOG[name]) : [];
}