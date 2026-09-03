/**
 * Classify GEV MCP tools by capability. Viewer-comment Hermes may use every
 * view operation; ADMIN, credentials, shell, and YouTube writes stay out.
 *
 * @module hermesViewSafeCatalog
 */

import {
  PUBLIC_GEV_TOOL_CATALOG,
  PUBLIC_GEV_TOOL_NAMES,
} from './youtubePublicCommandPolicy.js';
import { gevMcpToolDefinitions } from './gevApi.js';

export const HERMES_PROFILE_NAME = 'gev-youtube';
export const HERMES_SKILL_ID = 'gods-eye-view';
export const HERMES_SKILL_VERSION = '1.0.0';

export const EXCLUDED_CAPABILITIES = Object.freeze([
  'admin',
  'session',
  'credential',
  'youtube-write',
  'source-file',
  'shell',
  'package',
  'deploy',
  'unrestricted-network',
  'messaging',
  'cron',
  'destructive-persist',
]);

/**
 * @param {string} name
 * @returns {string} capability id (`view` or an excluded capability)
 */
export function classifyToolCapability(name) {
  const n = String(name || '').trim();
  const lower = n.toLowerCase();
  if (!n) return 'unknown';
  if (/^(list|create|get|send)_admin_/.test(lower) || lower.includes('admin')) return 'admin';
  if (/secret|credential|api_key|password|session_token/.test(lower)) return 'credential';
  if (/shell|exec|spawn|bash|terminal/.test(lower)) return 'shell';
  if (/npm|pip|package|install_dep/.test(lower)) return 'package';
  if (/deploy|repl_restart|git_push/.test(lower)) return 'deploy';
  if (/write_file|edit_file|read_source|unlink/.test(lower)) return 'source-file';
  if (/cron|schedule_job/.test(lower)) return 'cron';
  if (/send_sms|send_email|discord|slack|telegram/.test(lower)) return 'messaging';
  if (/livechat.*insert|ban_user|delete_message|youtube_write/.test(lower)) return 'youtube-write';
  if (PUBLIC_GEV_TOOL_NAMES.includes(n) || PUBLIC_GEV_TOOL_CATALOG[n]) return 'view';
  return 'unknown';
}

/**
 * @param {string} name
 * @returns {boolean}
 */
export function isViewSafeTool(name) {
  return classifyToolCapability(name) === 'view';
}

/**
 * Dynamic view-safe catalog from MCP `tools/list` (or the shipped GEV catalog).
 *
 * @param {object[]} [definitions]
 * @returns {object[]}
 */
export function viewSafeToolsFrom(definitions) {
  const list = Array.isArray(definitions) && definitions.length
    ? definitions
    : gevMcpToolDefinitions();
  return list.filter((tool) => isViewSafeTool(tool?.name));
}

/**
 * @param {string} name
 * @param {object} args
 * @returns {{ok: boolean, reason?: string, name?: string, arguments?: object}}
 */
export function validateViewSafeToolCall(name, args) {
  if (!isViewSafeTool(name)) {
    return {
      ok: false,
      reason: classifyToolCapability(name) === 'unknown'
        ? 'Unknown capability'
        : 'Tool is outside the viewer-comment boundary',
    };
  }
  const catalog = PUBLIC_GEV_TOOL_CATALOG[name];
  if (!catalog) return { ok: false, reason: 'Unknown capability' };
  const value = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  return { ok: true, name, arguments: structuredClone(value) };
}
