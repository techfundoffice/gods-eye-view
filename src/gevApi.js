/**
 * Canonical GEV function catalog for REST, MCP, OpenRouter, and YouTube chat.
 *
 * @module gevApi
 */

import {
  PUBLIC_GEV_TOOL_CATALOG,
  PUBLIC_GEV_TOOL_NAMES,
} from './youtubePublicCommandPolicy.js';
import { getGevFunctionToggles } from './gevFunctionToggles.js';

export const GEV_API_PREFIX = '/api/gev';

/** Operator + model-facing descriptions. Keep in sync with SCHEMAS. */
export const GEV_FUNCTION_DOCS = Object.freeze({
  fly_to_location: 'Fly the globe camera to a named place, coordinates, or location id.',
  select_nearest_aircraft: 'Select the nearest aircraft or military contact around a place.',
  adjust_camera_zoom: 'Zoom the camera in or out by a little, medium, or a lot.',
  zoom_to_globe: 'Pull back and frame the whole Earth.',
  set_layer_visibility: 'Show or hide a data layer (flights, satellites, CCTV, AIS, vessels).',
  show_data_layers_menu: 'Open the data-layers menu, optionally focused on one layer.',
  set_panel_open: 'Open or close a HUD panel (data, location, control, CCTV, radio, scene).',
  set_context_mode: 'Switch mission context: off, contacts, flights, space-missions, missions.',
  control_cockpit: 'Enter, exit, or step through cockpit / first-person tracking.',
  set_visual_style: 'Apply a visual style: normal, retro, surveillance, thermal, anime, noir, snow.',
  get_entity_context: 'Read entities in view or the current selection (datacenters, dams, cables, firms).',
  get_current_view_state: 'Read the current camera, location, layers, and HUD state.',
  set_hud: 'Show, hide, or restyle the HUD.',
  set_detection: 'Tune contact detection density and allocation.',
  set_map_stack: 'Change the basemap / imagery stack.',
  set_post_processing: 'Toggle bloom, grain, or other post-process effects.',
  control_scene: 'Play, pause, or step a scene / cinematic.',
  control_cctv: 'Open, close, or retarget a CCTV camera.',
  control_radio: 'Tune or mute radio.',
  track_entity: 'Keep the camera locked on a named entity.',
  stop_tracking: 'Stop camera tracking.',
  frame_overhead: 'Look straight down over the current or named place.',
  annotate_map: 'Drop a map annotation / pin.',
  clear_annotations: 'Remove map annotations.',
  move_camera: 'Nudge the camera (pan / orbit / dolly) without changing target.',
  fly_route: 'Fly a sequence of waypoints.',
  analyst_query: 'Answer an analytical question from current GEV data.',
  next_iss_pass: 'Look up the next ISS pass for a place.',
  run_view_preset: 'Switch to a named view preset (contacts, space-missions, environmental, explore).',
  apply_default_view: 'Apply Google Earth default look: Normal style, soft photoreal/satellite, tactical layers off (keeps current place).',
});

/**
 * @param {string} name
 * @returns {string}
 */
export function gevFunctionPath(name) {
  return `${GEV_API_PREFIX}/${String(name || '').trim()}`;
}

/**
 * @param {string} name
 * @returns {string}
 */
export function gevFunctionDescription(name) {
  return GEV_FUNCTION_DOCS[name]
    || `Cloud Computer AI.com action: ${String(name || '').replaceAll('_', ' ')}.`;
}

/**
 * REST + MCP + OpenRouter view of every GEV function.
 *
 * @returns {object[]}
 */
export function listGevFunctions() {
  const enabled = getGevFunctionToggles();
  return PUBLIC_GEV_TOOL_NAMES.map((name) => {
    const entry = PUBLIC_GEV_TOOL_CATALOG[name];
    const parameters = entry?.parameters || { type: 'object', additionalProperties: false, properties: {} };
    return {
      name,
      method: 'POST',
      path: gevFunctionPath(name),
      description: gevFunctionDescription(name),
      parameters,
      parameterKeys: Object.keys(parameters.properties || {}),
      enabled: enabled[name] !== false,
      available: enabled[name] !== false,
      availability: enabled[name] !== false ? 'enabled' : 'disabled-by-admin',
      youtubeChat: enabled[name] !== false,
      capability: 'view',
      viewSafe: true,
      authorizationScope: 'view-safe',
      executableServerSide: true,
      requiredInputs: [...(parameters.required || [])],
      annotations: {
        readOnlyHint: name.startsWith('get_') || name === 'analyst_query' || name === 'next_iss_pass',
        destructiveHint: false,
        openWorldHint: false,
      },
    };
  });
}

/**
 * @returns {object[]}
 */
export function gevMcpToolDefinitions() {
  return listGevFunctions().map((fn) => ({
    name: fn.name,
    description: fn.description,
    inputSchema: fn.parameters,
    annotations: fn.annotations,
    _meta: {
      capability: fn.capability,
      viewSafe: fn.viewSafe,
      enabled: fn.enabled,
      youtubeChat: fn.youtubeChat,
    },
  }));
}

/**
 * OpenRouter / OpenAI function-calling tools (Gemini 3 or any future model).
 *
 * @returns {object[]}
 */
export function gevOpenRouterTools() {
  return listGevFunctions().filter((fn) => fn.enabled && fn.viewSafe).map((fn) => ({
    type: 'function',
    function: {
      name: fn.name,
      description: fn.description,
      parameters: fn.parameters,
    },
  }));
}

/**
 * MCP client config for ADMIN, OpenRouter MCP, Claude, Cursor, etc.
 *
 * @param {{origin?: string, endpoint?: string, token?: string}} [options]
 * @returns {object}
 */
export function gevMcpClientConfig({
  origin = '',
  endpoint = '/api/admin/mcp',
  token = '',
} = {}) {
  const url = `${String(origin || '').replace(/\/+$/, '')}${endpoint}`;
  return {
    mcpServers: {
      'gods-eye-view': {
        type: 'http',
        url,
        headers: { Authorization: `Bearer ${token || 'gev_YOUR_API_KEY'}` },
      },
    },
  };
}

/**
 * Operator-facing documentation payload for ADMIN.
 *
 * @param {{origin?: string, mcpEndpoint?: string}} [options]
 * @returns {object}
 */
export function gevApiDocumentation({
  origin = '',
  mcpEndpoint = '/api/admin/mcp',
} = {}) {
  const base = String(origin || '').replace(/\/+$/, '');
  const functions = listGevFunctions();
  const example = functions.find((fn) => fn.name === 'fly_to_location') || functions[0];
  const curl = example
    ? [
      `curl -X POST ${base}${example.path} \\`,
      '  -H "Authorization: Bearer gev_YOUR_API_KEY" \\',
      '  -H "Content-Type: application/json" \\',
      '  -d \'{"query":"Reykjavik Iceland","viewMode":"close"}\'',
    ].join('\n')
    : '';
  const mcpConfig = gevMcpClientConfig({ origin: base, endpoint: mcpEndpoint });
  return {
    title: 'Cloud Computer AI.com API',
    prefix: GEV_API_PREFIX,
    auth: 'Bearer ADMIN API key (minted in ADMIN → MCP Server). Same key for REST and MCP.',
    execution: 'Calls run on the live capture globe — the same globe YouTube viewers see.',
    functions,
    curl,
    mcp: {
      url: `${base}${mcpEndpoint}`,
      transport: 'http-json-rpc',
      tools: functions.map((fn) => fn.name),
      config: mcpConfig,
      note: 'Enable MCP Server in ADMIN, mint an API key, then paste this config into any MCP client (Claude, Cursor, OpenRouter MCP). tools/list is the live GEV catalog.',
    },
    openrouter: {
      model: 'ADMIN → OpenRouter. YouTube comments use this model through Hermes CLI or the OpenRouter fallback.',
      tools: functions.length,
      youtubeChat: 'YouTube live comments go to Hermes. Hermes may call any enabled GEV function; the capture globe executes it.',
      mcp: mcpConfig,
    },
    admin: {
      youtubeOwner: 'ADMIN → Hermes Admin: emails, YouTube handles, and channel IDs that own Hermes / go-live.',
      youtubeAccount: 'ADMIN → Go Live: connected Google/YouTube OAuth account for the live channel.',
      functions: 'Each function below can be enabled or disabled for YouTube chat. Disabled tools are rejected.',
      hermes: 'ADMIN → Youtube AI Comment Harness: Hermes vs OpenRouter. ADMIN → OpenRouter: model and key.',
      mcp: 'ADMIN → MCP Server: API keys for REST /api/gev and JSON-RPC /api/admin/mcp.',
      live: 'ADMIN → Go Live: broadcast, ingest, capture URL.',
    },
  };
}
