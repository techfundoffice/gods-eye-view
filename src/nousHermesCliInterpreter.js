/**
 * YouTube comment interpreter that actually runs the Nous Research Hermes CLI.
 *
 * @module nousHermesCliInterpreter
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { validatePublicToolCall } from './youtubePublicCommandPolicy.js';
import { assembleLiveViewContext } from './liveViewContext.js';

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
        return { ok: false, kind: 'invalid-tool-call', reason: checked.reason || 'Hermes returned an invalid tool call' };
      }
      if (reply) return { ok: true, kind: 'complete', text: reply.slice(0, 1000) };
      return { ok: false, kind: 'invalid-output', reason: 'Hermes CLI JSON contained no supported output' };
    } catch {
      return { ok: false, kind: 'invalid-json', reason: 'Hermes CLI returned malformed JSON' };
    }
  }
  if (/^\s*(?:```json\s*)?[\[{]/i.test(raw)) {
    return { ok: false, kind: 'invalid-json', reason: 'Hermes CLI returned malformed JSON' };
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

export function gevCapabilityList(toolDefinitions = []) {
  return (Array.isArray(toolDefinitions) ? toolDefinitions : [])
    .filter((tool) => tool && typeof tool.name === 'string')
    .map((tool) => `- ${tool.name}: ${String(tool.description || tool.name)}`)
    .join('\n');
}

export function buildHermesChatPrompt(input = {}, toolDefinitions = []) {
  const viewer = String(input.viewer || input.authorHandle || 'viewer').trim() || 'viewer';
  const comment = String(input.comment || '').trim();
  const live = assembleLiveViewContext(input.viewContext, { model: input.model });
  const view = live.ok ? JSON.stringify(live.context) : '{}';
  const toolResult = input.toolResult
    ? `\nTool result: ${JSON.stringify(input.toolResult).slice(0, 1500)}`
    : '';
  const prior = input.priorCall
    ? `\nYou already called ${input.priorCall.name} ${JSON.stringify(input.priorCall.arguments || {})}.`
    : '';
  const perception = input.perception
    ? `\nPerception transport: ${JSON.stringify(input.perception).slice(0, 1000)}`
    : '';
  const generatedSkill = input.generatedSkill
    ? `\nValidated generated learning: ${JSON.stringify(input.generatedSkill).slice(0, 16_000)}`
    : '';
  return `You are Cloud Computer AI.com on a live YouTube broadcast. You are Nous Research Hermes.

You have EVERY Cloud Computer AI.com capability below. Do not limit yourself to fly_to_location. Pick the function that actually does what the viewer asked: camera, layers, HUD, style, cockpit, tracking, CCTV, radio, annotations, presets, analysis, ISS, routing.

Capabilities:
${gevCapabilityList(toolDefinitions)}

Viewer ${viewer} wrote in YouTube chat: ${JSON.stringify(comment)}
Current globe view: ${view}${perception}${generatedSkill}${prior}${toolResult}

Output ONLY JSON, one next action:
{"tool":"<exact capability name>","arguments":{...},"reply":"short chat reply to ${viewer}"}
If no globe change is needed:
{"reply":"short YouTube live chat reply addressing ${viewer}"}

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
  timeoutMs = 0,
  env = process.env,
  toolDefinitions = [],
} = {}) {
  return async function interpret(input = {}) {
    const command = resolveHermesBin(bin);
    if (!command) {
      return { ok: false, kind: 'unconfigured', reason: 'Hermes CLI is not installed' };
    }
    const currentDefinitions = typeof toolDefinitions === 'function'
      ? toolDefinitions()
      : toolDefinitions;
    const liveContext = assembleLiveViewContext(input.viewContext, { model, provider });
    if (!liveContext.ok) return liveContext;
    const mediaParts = liveContext.content.filter((part) => part?.type !== 'text');
    const unsupported = mediaParts.filter((part) => part.type !== 'image_url');
    if (unsupported.length) {
      return {
        ok: false,
        kind: 'unsupported-media-transport',
        reason: `Hermes CLI cannot transport: ${[...new Set(unsupported.map((part) => part.type))].join(', ')}`,
      };
    }
    const imageParts = mediaParts.filter((part) => part.type === 'image_url');
    if (imageParts.length > 1) {
      return {
        ok: false,
        kind: 'unsupported-media-transport',
        reason: `Hermes CLI accepts one image but this turn contains ${imageParts.length} visual inputs; no media was sent`,
      };
    }
    const prompt = buildHermesChatPrompt({
      ...input,
      viewContext: liveContext.context,
      model,
      perception: {
        capabilities: liveContext.capabilities,
        attachedImage: imageParts.length > 0,
        attachedImages: imageParts.length,
        omittedImages: 0,
        mediaFailures: liveContext.mediaFailures,
      },
    }, currentDefinitions);
    const sessionName = safeSessionName(input.conversationId);
    let imagePath = '';
    if (imageParts[0]?.image_url?.url) {
      const match = imageParts[0].image_url.url.match(/^data:image\/(png|jpeg|webp);base64,(.+)$/is);
      if (!match) return { ok: false, kind: 'invalid-media', reason: 'Hermes image attachment is malformed' };
      const buffer = Buffer.from(match[2], 'base64');
      if (!buffer.length || buffer.length > liveContext.capabilities.limits.imageBytes) {
        return { ok: false, kind: 'invalid-media', reason: 'Hermes image attachment exceeds the model limit' };
      }
      const directory = path.join(process.cwd(), '.local', 'hermes-turn-media');
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      imagePath = path.join(directory, `${randomUUID()}.${match[1] === 'jpeg' ? 'jpg' : match[1]}`);
      fs.writeFileSync(imagePath, buffer, { mode: 0o600 });
    }
    const args = [
      'chat',
      '-q', prompt,
      '--oneshot',
      '--continue', sessionName,
      '--create-if-missing',
      '-Q',
      '--cli',
      '--safe-mode',
      '--source', 'tool',
      '--provider', provider,
      '-m', model,
      '--max-turns', '8',
      '--run-budget', '60',
    ];
    if (imagePath) args.push('--image', imagePath);
    try {
      const result = await runCommand(spawnImpl, command, args, timeoutMs, env);
      if (!result.ok) {
        return { ok: false, kind: result.kind || 'transport', reason: result.reason };
      }
      return parseHermesCliOutput(result.stdout, input.mode || 'execute');
    } finally {
      if (imagePath) {
        try { fs.rmSync(imagePath, { force: true }); } catch { /* best effort for transient turn media */ }
      }
    }
  };
}

function runCommand(spawnImpl, command, args, timeoutMs, env) {
  return new Promise((resolve) => {
    const child = spawnImpl(command, args, {
      env: {
        ...env,
        HERMES_ACCEPT_HOOKS: '0',
        PATH: `${path.dirname(command)}:${env.PATH || process.env.PATH || ''}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = Number(timeoutMs) > 0
      ? setTimeout(() => {
        child.kill('SIGKILL');
        resolve({ ok: false, kind: 'timeout', reason: 'Hermes CLI timed out' });
      }, timeoutMs)
      : null;
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      resolve({ ok: false, kind: 'transport', reason: error.message || 'Hermes CLI failed to start' });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (code !== 0 && !stdout.trim()) {
        resolve({ ok: false, kind: 'process', reason: (stderr || `Hermes CLI exited ${code}`).slice(0, 160) });
        return;
      }
      resolve({ ok: true, stdout, stderr });
    });
  });
}
