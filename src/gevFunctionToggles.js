/**
 * ADMIN-controlled enablement of GEV functions for YouTube chat / public execute.
 *
 * @module gevFunctionToggles
 */

import { PUBLIC_GEV_TOOL_NAMES } from './youtubePublicCommandPolicy.js';

let current = defaultGevFunctionToggles();

export function defaultGevFunctionToggles() {
  return Object.fromEntries(PUBLIC_GEV_TOOL_NAMES.map((name) => [name, true]));
}

export function normalizeGevFunctionToggles(raw) {
  const next = defaultGevFunctionToggles();
  if (!raw || typeof raw !== 'object') return next;
  for (const name of PUBLIC_GEV_TOOL_NAMES) {
    if (Object.prototype.hasOwnProperty.call(raw, name)) next[name] = raw[name] !== false;
  }
  return next;
}

export function setGevFunctionToggles(raw) {
  current = normalizeGevFunctionToggles(raw);
  return current;
}

export function getGevFunctionToggles() {
  return { ...current };
}

export function isGevFunctionEnabled(name) {
  return current[String(name || '')] !== false;
}

export function setGevFunctionEnabled(name, enabled) {
  if (!PUBLIC_GEV_TOOL_NAMES.includes(name)) {
    return { ok: false, reason: 'Unknown GEV function' };
  }
  current = { ...current, [name]: enabled !== false };
  return { ok: true, name, enabled: current[name], toggles: { ...current } };
}
