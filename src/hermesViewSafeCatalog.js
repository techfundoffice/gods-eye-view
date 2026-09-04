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
export const HERMES_SKILL_VERSION = '1.1.0';

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
  const canonical = new Map(gevMcpToolDefinitions().map((tool) => [tool.name, tool]));
  const list = Array.isArray(definitions) && definitions.length
    ? definitions
    : [...canonical.values()];
  return list.filter((tool) => {
    const base = canonical.get(tool?.name);
    const enabled = tool?._meta?.enabled ?? base?._meta?.enabled;
    return isViewSafeTool(tool?.name) && enabled !== false;
  }).map((tool) => {
    const base = canonical.get(tool.name) || {};
    return {
      ...tool,
      description: base.description || tool.description,
      inputSchema: tool.inputSchema || tool.parameters || base.inputSchema,
      annotations: { ...(base.annotations || {}), ...(tool.annotations || {}) },
      _meta: {
        ...(base._meta || {}),
        ...(tool._meta || {}),
        capability: 'view',
        viewSafe: true,
        availability: 'enabled',
        authorizationScope: 'view-safe',
        executableServerSide: true,
        requiredInputs: [...((tool.inputSchema || tool.parameters || base.inputSchema)?.required || [])],
      },
    };
  });
}

/**
 * Backticked GEV tool names documented in the YouTube operator skill.
 * Admin MCP tools must not appear as usable.
 *
 * @param {string} skillText
 * @returns {string[]}
 */
export function documentedViewSafeToolsFromSkill(skillText) {
  const names = new Set();
  const text = String(skillText || '');
  for (const match of text.matchAll(/`([a-z][a-z0-9_]{2,})`/g)) {
    const name = match[1];
    if (PUBLIC_GEV_TOOL_NAMES.includes(name)) names.add(name);
  }
  return [...names];
}

/**
 * @param {string} skillText
 * @param {object[]} [definitions]
 * @returns {{ok: boolean, missingFromSkill: string[], extraInSkill: string[], adminNamed: string[]}}
 */
export function compareSkillToViewSafeCatalog(skillText, definitions) {
  const live = new Set(viewSafeToolsFrom(definitions).map((tool) => tool.name));
  const documented = new Set(documentedViewSafeToolsFromSkill(skillText));
  const missingFromSkill = [...live].filter((name) => !documented.has(name)).sort();
  const extraInSkill = [...documented].filter((name) => !live.has(name)).sort();
  const adminNamed = [...new Set(
    [...String(skillText || '').matchAll(/`([a-z][a-z0-9_]{2,})`/g)].map((m) => m[1]),
  )].filter((name) => classifyToolCapability(name) === 'admin');
  return {
    ok: missingFromSkill.length === 0 && extraInSkill.length === 0,
    missingFromSkill,
    extraInSkill,
    adminNamed,
  };
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
