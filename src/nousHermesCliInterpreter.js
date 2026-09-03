/**
 * YouTube comment interpreter that actually runs the Nous Research Hermes CLI.
 *
 * @module nousHermesCliInterpreter
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PUBLIC_GEV_TOOL_NAMES, validatePublicToolCall } from './youtubePublicCommandPolicy.js';
import { isGevFunctionEnabled } from './gevFunctionToggles.js';
import { GEV_FUNCTION_DOCS } from './gevApi.js';

export const HERMES_RUNTIME_VERSION = '0.21.0';
export const HERMES_RUNTIME_TAG = 'v2026.8.31';
export const HERMES_RUNTIME_COMMIT = '29112bef099274229cadff79cdff7bf7b99c4b77';
export const NOUS_HERMES_BIN = path.join(
  process.cwd(),
  '.hermes/hermes-agent/venv/bin/hermes',
);
export const NOUS_HERMES_SESSION = 'gev-youtube-live';

export function resolveHermesBin(explicit = process.env.HERMES_BIN) {
  const candidates = [
    String(explicit || '').trim(),
    NOUS_HERMES_BIN,
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch { /* next */ }
  }
  return '';
}

export function parseHermesCliOutput(stdout, mode = 'execute') {
  const raw = String(stdout || '').trim();
  const jsonText = extractJson(raw);
  if (jsonText) {
    try {
      const parsed = JSON.parse(jsonText);
      const first = Array.isArray(parsed.tools) && parsed.tools[0] ? parsed.tools[0] : parsed;
      const name = first.tool || first.name || first.function || parsed.tool || parsed.name || '';
      const args = first.arguments || first.args || first.parameters || parsed.arguments || parsed.args || {};
      const reply = String(parsed.reply || parsed.text || parsed.message || first.reply || '').trim();
      if (name) {
        const checked = validatePublicToolCall(mode, name, args && typeof args === 'object' ? args : {});
        if (checked.ok) {
          return {
            ok: true,
            kind: 'tool-call',
            call: {
              responseId: `hermes-${randomUUID()}`,
              callId: `call-${randomUUID()}`,
              name: checked.name,
              arguments: checked.arguments,
            },
            text: reply,
          };
        }
      }
      if (reply) return { ok: true, kind: 'complete', text: reply.slice(0, 1000) };
    } catch { /* fall through to prose */ }
  }
  const text = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 1000);
  return text
    ? { ok: true, kind: 'complete', text }
    : { ok: false, kind: 'invalid', reason: 'Hermes CLI returned no reply' };
}

function extractJson(raw) {
  const fenced = raw.match(/```json\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) return raw.slice(start, end + 1);
  return '';
}

export function gevCapabilityList() {
  return PUBLIC_GEV_TOOL_NAMES.filter((name) => isGevFunctionEnabled(name)).map((name) => `- ${name}: ${GEV_FUNCTION_DOCS[name] || name}`).join('\n');
}

export function buildHermesChatPrompt(input = {}) {
  const viewer = String(input.viewer || input.authorHandle || 'viewer').trim() || 'viewer';
  const comment = String(input.comment || '').trim();
  const view = input.viewContext && typeof input.viewContext === 'object'
    ? JSON.stringify(input.viewContext)
    : '{}';
  const toolResult = input.toolResult
    ? `\nTool result: ${JSON.stringify(input.toolResult).slice(0, 1500)}`
    : '';
  const prior = input.priorCall
    ? `\nYou already called ${input.priorCall.name} ${JSON.stringify(input.priorCall.arguments || {})}.`
    : '';
  return `You are Cloud Computer AI.com on a live YouTube broadcast. You are Nous Research Hermes.

You have EVERY Cloud Computer AI.com capability below. Do not limit yourself to fly_to_location. Pick the function that actually does what the viewer asked: camera, layers, HUD, style, cockpit, tracking, CCTV, radio, annotations, presets, analysis, ISS, routing.

Capabilities:
${gevCapabilityList()}

Viewer ${viewer} wrote in YouTube chat: ${JSON.stringify(comment)}
Current globe view: ${view}${prior}${toolResult}

Output ONLY JSON, one next action:
{"tool":"<exact capability name>","arguments":{...},"reply":"short chat reply to ${viewer}"}
If no globe change is needed:
{"reply":"short YouTube live chat reply addressing ${viewer}"}

Examples:
{"tool":"set_layer_visibility","arguments":{"layerId":"flights","enabled":true},"reply":"@user Flights are on."}
{"tool":"set_visual_style","arguments":{"style":"thermal"},"reply":"@user Thermal view is up."}
{"tool":"frame_overhead","arguments":{},"reply":"@user Looking straight down."}
{"tool":"run_view_preset","arguments":{"preset":"contacts"},"reply":"@user Live contacts preset."}
{"tool":"fly_to_location","arguments":{"query":"Los Angeles, CA","viewMode":"overview"},"reply":"@user Map overview of LA."}

Cities/countries use fly_to_location viewMode overview. Close is only for a named building or street. No markdown. Keep reply under 240 characters.`;
}

function safeSessionName(value) {
  const normalized = String(value || NOUS_HERMES_SESSION)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return normalized || NOUS_HERMES_SESSION;
}

export function createNousHermesCliInterpreter({
  bin = resolveHermesBin(),
  model = process.env.HERMES_MODEL || 'x-ai/grok-4.6',
  provider = 'openrouter',
  spawnImpl = spawn,
  timeoutMs = 90_000,
} = {}) {
  return async function interpret(input = {}) {
    const command = resolveHermesBin(bin);
    if (!command) {
      return { ok: false, kind: 'invalid', reason: 'Hermes CLI is not installed' };
    }
    const prompt = buildHermesChatPrompt(input);
    const sessionName = safeSessionName(input.conversationId);
    const args = [
      'chat',
      '-q', prompt,
      '--oneshot',
      '--continue', sessionName,
      '--create-if-missing',
      '-Q',
      '--cli',
      '--yolo',
      '--provider', provider,
      '-m', model,
      '--max-turns', '8',
      '--run-budget', '60',
    ];
    const result = await runCommand(spawnImpl, command, args, timeoutMs);
    if (!result.ok) {
      return { ok: false, kind: 'invalid', reason: result.reason };
    }
    return parseHermesCliOutput(result.stdout, input.mode || 'execute');
  };
}

function runCommand(spawnImpl, command, args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawnImpl(command, args, {
      env: {
        ...process.env,
        HERMES_ACCEPT_HOOKS: '1',
        PATH: `${path.dirname(command)}:${process.env.PATH || ''}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ ok: false, reason: 'Hermes CLI timed out' });
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, reason: error.message || 'Hermes CLI failed to start' });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && !stdout.trim()) {
        resolve({ ok: false, reason: (stderr || `Hermes CLI exited ${code}`).slice(0, 160) });
        return;
      }
      resolve({ ok: true, stdout, stderr });
    });
  });
}
