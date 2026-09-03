/**
 * ADMIN-facing Hermes comment harness: preferred default, start/stop, health,
 * and temporary OpenRouter fallback that is never saved as the default.
 *
 * @module hermesHarnessController
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  HERMES_PROFILE_NAME,
  HERMES_SKILL_ID,
  HERMES_SKILL_VERSION,
  viewSafeToolsFrom,
} from './hermesViewSafeCatalog.js';
import { createHermesStdioBridge, redactSecrets } from './hermesStdioBridge.js';
import {
  HERMES_DEFAULT_SKILL,
  createHermesCommentInterpreter,
  createHermesSkillAgent,
} from './hermesCommentInterpreter.js';
import { createPublicResponsesInterpreter } from './youtubePublicResponsesInterpreter.js';
import { openRouterApiKey, openRouterFreeModel, postOpenRouterChat } from './openrouterFreeClient.js';

export const HERMES_HARNESS_ID = 'hermes';
export const OPENROUTER_HARNESS_ID = 'openrouter';
export const HERMES_GROK_MODEL = 'x-ai/grok-4.6';
export const HERMES_GROK_MODELS = Object.freeze([
  'x-ai/grok-4.6',
  'x-ai/grok-4.3',
  'x-ai/grok-4',
]);

function defaultSettingsPath() {
  return path.join(process.cwd(), '.local/hermes-harness.json');
}

function defaultSkillPath() {
  return path.join(process.cwd(), 'skills/gods-eye-view/SKILL.md');
}

export async function readHermesSkill(filePath = defaultSkillPath()) {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    return { ok: true, text, version: HERMES_SKILL_VERSION, path: filePath };
  } catch (error) {
    return { ok: false, text: HERMES_DEFAULT_SKILL, version: HERMES_SKILL_VERSION, reason: error?.message || 'skill missing' };
  }
}

export function redactedHermesStatus(status) {
  const copy = status && typeof status === 'object' ? { ...status } : {};
  for (const key of Object.keys(copy)) {
    if (typeof copy[key] === 'string') copy[key] = redactSecrets(copy[key]);
  }
  if (copy.credential || copy.apiKey || copy.token) {
    delete copy.credential;
    delete copy.apiKey;
    delete copy.token;
  }
  return copy;
}

/**
 * @param {object} [options]
 */
export function createHermesHarnessController({
  settingsPath = defaultSettingsPath(),
  skillPath = defaultSkillPath(),
  now = Date.now,
  postChat = (input) => postOpenRouterChat({
    apiKey: openRouterApiKey(),
    model: input.model || openRouterFreeModel(),
    messages: input.messages,
    tools: input.tools,
    maxTokens: input.maxTokens,
  }),
  openrouterInterpret = createPublicResponsesInterpreter(),
  hermesCommand = process.env.HERMES_BIN || '',
  hermesModel = process.env.HERMES_MODEL || HERMES_GROK_MODEL,
} = {}) {
  let preferred = HERMES_HARNESS_ID;
  let model = hermesModel;
  let active = OPENROUTER_HARNESS_ID;
  let fallbackReason = '';
  let lastError = '';
  let skill = { ok: false, text: HERMES_DEFAULT_SKILL, version: HERMES_SKILL_VERSION };
  let bridge = null;
  let hermesInterpret = null;
  let started = false;

  async function loadPreferred() {
    try {
      const raw = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
      if (raw?.preferred === OPENROUTER_HARNESS_ID || raw?.preferred === HERMES_HARNESS_ID) {
        preferred = raw.preferred;
      }
      if (typeof raw?.model === 'string' && raw.model.startsWith('x-ai/')) model = raw.model;
    } catch { /* first run defaults to Hermes */ }
  }

  async function savePreferred() {
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await fs.writeFile(settingsPath, `${JSON.stringify({
      preferred,
      skillId: HERMES_SKILL_ID,
      skillVersion: HERMES_SKILL_VERSION,
      profile: HERMES_PROFILE_NAME,
      model,
      updatedAt: now(),
    }, null, 2)}\n`);
  }

  async function preflight() {
    skill = await readHermesSkill(skillPath);
    const tools = viewSafeToolsFrom();
    const reasons = [];
    if (!skill.ok) reasons.push(`GEV skill missing (${skill.reason || 'unreadable'})`);
    if (!tools.length) reasons.push('View-safe GEV catalog is empty');
    const hasModel = Boolean(openRouterApiKey() || hermesCommand);
    if (!hasModel) reasons.push('No Hermes CLI and no OpenRouter key');
    return {
      ok: reasons.length === 0,
      reasons,
      toolCount: tools.length,
      skillVersion: skill.version,
      profile: HERMES_PROFILE_NAME,
    };
  }

  async function startHermes() {
    const check = await preflight();
    if (!check.ok) {
      started = false;
      active = OPENROUTER_HARNESS_ID;
      fallbackReason = check.reasons.join('; ');
      lastError = fallbackReason;
      return status();
    }
    const tools = viewSafeToolsFrom();
    const handler = createHermesSkillAgent({
      postChat,
      model,
      skillText: skill.text,
      tools,
    });
    bridge = createHermesStdioBridge({
      command: hermesCommand,
      args: hermesCommand ? ['-p', HERMES_PROFILE_NAME] : [],
      handler: hermesCommand ? null : handler,
      env: {},
      now,
    });
    bridge.start();
    hermesInterpret = createHermesCommentInterpreter({ bridge, tools });
    started = true;
    active = preferred === HERMES_HARNESS_ID ? HERMES_HARNESS_ID : preferred;
    fallbackReason = '';
    lastError = '';
    return status();
  }

  function stopHermes(reason = 'stopped') {
    bridge?.stop(reason);
    started = false;
    hermesInterpret = null;
    if (preferred === HERMES_HARNESS_ID) {
      active = OPENROUTER_HARNESS_ID;
      fallbackReason = reason;
    }
    return status();
  }

  async function select(next) {
    if (next === OPENROUTER_HARNESS_ID) {
      preferred = OPENROUTER_HARNESS_ID;
      active = OPENROUTER_HARNESS_ID;
      fallbackReason = '';
      await savePreferred();
      return status();
    }
    preferred = HERMES_HARNESS_ID;
    await savePreferred();
    return startHermes();
  }

  async function interpret(input, opts) {
    if (active === HERMES_HARNESS_ID && typeof hermesInterpret === 'function') {
      try {
        return await hermesInterpret(input, opts);
      } catch (error) {
        lastError = redactSecrets(error?.message || 'Hermes failed');
        active = OPENROUTER_HARNESS_ID;
        fallbackReason = lastError;
        return openrouterInterpret(input, opts);
      }
    }
    return openrouterInterpret(input, opts);
  }

  function status() {
    const health = bridge?.status?.() || { running: false, pendingTurns: 0, lastError: '' };
    return redactedHermesStatus({
      preferred,
      active,
      defaultHarness: HERMES_HARNESS_ID,
      profile: HERMES_PROFILE_NAME,
      skillId: HERMES_SKILL_ID,
      skillVersion: skill.version,
      running: Boolean(started && health.running),
      ready: active === HERMES_HARNESS_ID && Boolean(started && health.running),
      fallbackReason: redactSecrets(fallbackReason),
      lastError: redactSecrets(lastError || health.lastError),
      pendingTurns: health.pendingTurns || 0,
      toolCount: viewSafeToolsFrom().length,
      model,
      provider: 'x-ai',
    });
  }

  return {
    loadPreferred,
    preflight,
    startHermes,
    stopHermes,
    select,
    interpret,
    status,
  };
}
