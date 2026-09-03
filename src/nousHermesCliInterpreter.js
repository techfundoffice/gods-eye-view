/**
 * YouTube comment interpreter that actually runs the Nous Research Hermes CLI.
 *
 * @module nousHermesCliInterpreter
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validatePublicToolCall } from './youtubePublicCommandPolicy.js';

export const NOUS_HERMES_BIN = '/home/runner/.local/bin/hermes';
export const NOUS_HERMES_SESSION = 'gev-youtube-live';

export function resolveHermesBin(explicit = process.env.HERMES_BIN) {
  const candidates = [
    String(explicit || '').trim(),
    NOUS_HERMES_BIN,
    path.join(os.homedir(), '.local/bin/hermes'),
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
      const name = parsed.tool || parsed.name || parsed.function || '';
      const args = parsed.arguments || parsed.args || parsed.parameters || {};
      const reply = String(parsed.reply || parsed.text || parsed.message || '').trim();
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
  return `You are God's Eye View on a live YouTube broadcast. You are Nous Research Hermes.

Viewer ${viewer} wrote in YouTube chat: ${JSON.stringify(comment)}
Current globe view: ${view}${prior}${toolResult}

If the globe must move or change, output ONLY JSON:
{"tool":"fly_to_location","arguments":{"query":"Los Angeles, CA","viewMode":"overview"},"reply":"short chat reply"}
Use viewMode overview for cities and countries. Close is only for a named building or street.

If they are chatting or you already finished the tool, output ONLY JSON:
{"reply":"short YouTube live chat reply addressing ${viewer}"}

No markdown. No extra prose. Keep reply under 240 characters.`;
}

export function createNousHermesCliInterpreter({
  bin = resolveHermesBin(),
  model = process.env.HERMES_MODEL || 'x-ai/grok-4.6',
  provider = 'openrouter',
  spawnImpl = spawn,
  timeoutMs = 45_000,
} = {}) {
  return async function interpret(input = {}) {
    const command = resolveHermesBin(bin);
    if (!command) {
      return { ok: false, kind: 'invalid', reason: 'Hermes CLI is not installed' };
    }
    const prompt = buildHermesChatPrompt(input);
    const args = [
      'chat',
      '-q', prompt,
      '--oneshot',
      '-Q',
      '--cli',
      '--yolo',
      '--provider', provider,
      '-m', model,
      '--max-turns', '2',
      '--run-budget', '30',
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
