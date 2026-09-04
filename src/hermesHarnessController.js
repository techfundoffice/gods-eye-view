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
  compareSkillToViewSafeCatalog,
  viewSafeToolsFrom,
} from './hermesViewSafeCatalog.js';
import { redactSecrets } from './hermesStdioBridge.js';
import {
  HERMES_DEFAULT_SKILL,
} from './hermesCommentInterpreter.js';
import { createPublicResponsesInterpreter } from './youtubePublicResponsesInterpreter.js';
import {
  HERMES_RUNTIME_COMMIT,
  HERMES_RUNTIME_TAG,
  HERMES_RUNTIME_VERSION,
  createNousHermesCliInterpreter,
  resolveHermesBin,
} from './nousHermesCliInterpreter.js';
import { openRouterApiKey } from './openrouterFreeClient.js';
import { isGevFunctionEnabled } from './gevFunctionToggles.js';
import { resolveModelCapabilities } from './modelCapabilities.js';
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
  openrouterInterpret = createPublicResponsesInterpreter(),
  hermesCommand = resolveHermesBin(process.env.HERMES_BIN),
  hermesModel = process.env.HERMES_MODEL || HERMES_GROK_MODEL,
  isFunctionEnabled = isGevFunctionEnabled,
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
  let preferenceRevision = 0;
  let mcp = null;
  let discoveredTools = [];
  let initialization = null;
  let mcpHealth = {
    connected: false,
    serverName: '',
    protocolVersion: '',
    discoveredCount: 0,
    exposedCount: 0,
    executionTransport: 'youtube-public-coordinator',
    latestMcpError: 'MCP server is not connected',
  };
  let liveTools = [];

  function refreshEnabledTools() {
    if (!mcpHealth.connected || !discoveredTools.length) {
      liveTools = [];
      mcpHealth = { ...mcpHealth, exposedCount: 0 };
      return liveTools;
    }
    liveTools = viewSafeToolsFrom(discoveredTools).filter((tool) => isFunctionEnabled(tool.name));
    mcpHealth = { ...mcpHealth, exposedCount: liveTools.length };
    return liveTools;
  }

  function mcpFailure(message) {
    const latestMcpError = redactSecrets(String(message || 'MCP discovery failed'));
    mcpHealth = { ...mcpHealth, connected: false, latestMcpError };
    discoveredTools = [];
    liveTools = [];
    return latestMcpError;
  }

  async function connectMcpServer(server) {
    mcp = server;
    if (!server || typeof server.handle !== 'function') {
      mcpFailure('MCP server is unavailable or malformed');
      return status();
    }
    try {
      const initialized = await server.handle({
        jsonrpc: '2.0', id: 'hermes-initialize', method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'hermes-youtube', version: '1.0.0' } },
      });
      const init = initialized?.result;
      if (initialized?.error || !init || typeof init.protocolVersion !== 'string'
        || !init.serverInfo || typeof init.serverInfo.name !== 'string') {
        throw new Error(initialized?.error?.message || 'Malformed MCP initialize response');
      }
      const listed = await server.handle({ jsonrpc: '2.0', id: 'hermes-tools-list', method: 'tools/list' });
      const discovered = listed?.result?.tools;
      if (listed?.error || !Array.isArray(discovered)
        || discovered.some((tool) => !tool || typeof tool.name !== 'string' || typeof tool.description !== 'string')) {
        throw new Error(listed?.error?.message || 'Malformed MCP tools/list response');
      }
      if (!discovered.length) throw new Error('MCP tools/list returned an empty catalog');
      discoveredTools = discovered;
      mcpHealth = {
        connected: true,
        serverName: init.serverInfo.name,
        protocolVersion: init.protocolVersion,
        discoveredCount: discovered.length,
        exposedCount: 0,
        executionTransport: 'youtube-public-coordinator',
        latestMcpError: '',
      };
      refreshEnabledTools();
    } catch (error) {
      mcpFailure(error?.message || 'MCP discovery failed');
    }
    return status();
  }

  function initializeMcpServer(server) {
    initialization = (async () => {
      await loadPreferred();
      const snapshot = await connectMcpServer(server);
      if (snapshot.mcpConnected && snapshot.preferred === HERMES_HARNESS_ID) {
        return startHermes();
      }
      return snapshot;
    })();
    return initialization;
  }

  async function loadPreferred() {
    const revision = preferenceRevision;
    try {
      const raw = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
      if (revision !== preferenceRevision) return;
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
    const tools = refreshEnabledTools();
    const reasons = [];
    if (!skill.ok) reasons.push(`GEV skill missing (${skill.reason || 'unreadable'})`);
    if (!tools.length) reasons.push('View-safe GEV catalog is empty');
    if (!mcpHealth.connected) reasons.push(`MCP discovery unavailable (${mcpHealth.latestMcpError || 'not connected'})`);
    if (preferred === HERMES_HARNESS_ID && !resolveHermesBin(hermesCommand)) {
      reasons.push('Hermes CLI is not installed in the persistent workspace; run scripts/install-hermes.sh');
    }
    return {
      ok: reasons.length === 0,
      reasons,
      toolCount: tools.length,
      skillVersion: skill.version,
      profile: HERMES_PROFILE_NAME,
    };
  }

  async function startHermes() {
    const revision = preferenceRevision;
    const check = await preflight();
    if (revision !== preferenceRevision || preferred !== HERMES_HARNESS_ID) return status();
    if (!check.ok) {
      started = false;
      active = preferred;
      fallbackReason = check.reasons.join('; ');
      lastError = fallbackReason;
      return status();
    }
    const bin = resolveHermesBin(hermesCommand);
    if (bin) {
      const apiKey = openRouterApiKey();
      hermesInterpret = createNousHermesCliInterpreter({
        bin,
        model,
        env: {
          ...process.env,
          ...(apiKey ? { OPENROUTER_API_KEY: apiKey } : {}),
          HERMES_HOME: path.join(process.cwd(), '.hermes'),
        },
        toolDefinitions: () => refreshEnabledTools(),
      });
      bridge = {
        start() {},
        stop() {},
        status() { return { running: true, pendingTurns: 0, lastError: '', command: bin }; },
      };
      started = true;
      active = preferred === HERMES_HARNESS_ID ? HERMES_HARNESS_ID : preferred;
      fallbackReason = '';
      lastError = '';
      return status();
    }
    started = false;
    active = preferred;
    fallbackReason = 'Hermes CLI is unavailable';
    lastError = fallbackReason;
    return status();
  }

  function stopHermes(reason = 'stopped') {
    bridge?.stop(reason);
    started = false;
    hermesInterpret = null;
    if (preferred === HERMES_HARNESS_ID) {
      active = HERMES_HARNESS_ID;
      fallbackReason = reason;
    }
    return status();
  }

  async function select(next) {
    preferenceRevision += 1;
    if (next === OPENROUTER_HARNESS_ID) {
      preferred = OPENROUTER_HARNESS_ID;
      active = OPENROUTER_HARNESS_ID;
      fallbackReason = '';
      bridge?.stop('operator-openrouter');
      bridge = null;
      hermesInterpret = null;
      started = false;
      await savePreferred();
      return status();
    }
    preferred = HERMES_HARNESS_ID;
    await savePreferred();
    return startHermes();
  }

  async function interpret(input, opts) {
    if (initialization) await initialization;
    refreshEnabledTools();
    if (active === HERMES_HARNESS_ID && typeof hermesInterpret === 'function') {
      try {
        return await hermesInterpret(input, opts);
      } catch (error) {
        lastError = redactSecrets(error?.message || 'Hermes failed');
        fallbackReason = lastError;
        throw Object.assign(new Error(lastError), { kind: 'hermes-unavailable' });
      }
    }
    if (preferred === OPENROUTER_HARNESS_ID) return openrouterInterpret(input, opts);
    throw Object.assign(new Error(lastError || 'Hermes CLI is offline'), { kind: 'hermes-unavailable' });
  }

  function status() {
    if (mcpHealth.connected) refreshEnabledTools();
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
      toolCount: liveTools.length,
      mcpConnected: mcpHealth.connected,
      mcpServerName: mcpHealth.serverName,
      mcpProtocolVersion: mcpHealth.protocolVersion,
      mcpDiscoveredCount: mcpHealth.discoveredCount,
      mcpExposedCount: mcpHealth.exposedCount,
      mcpExecutionTransport: mcpHealth.executionTransport,
      latestMcpError: mcpHealth.latestMcpError,
      mcp: { ...mcpHealth },
      model,
      provider: 'openrouter',
      modelVendor: model.split('/')[0] || '',
      modelCapabilities: resolveModelCapabilities(model, 'openrouter'),
      cli: Boolean(resolveHermesBin(hermesCommand)),
      bin: resolveHermesBin(hermesCommand),
      runtimeVersion: HERMES_RUNTIME_VERSION,
      runtimeTag: HERMES_RUNTIME_TAG,
      runtimeCommit: HERMES_RUNTIME_COMMIT,
    });
  }

  return {
    loadPreferred,
    connectMcpServer,
    initializeMcpServer,
    preflight,
    startHermes,
    stopHermes,
    select,
    interpret,
    status,
  };
}
