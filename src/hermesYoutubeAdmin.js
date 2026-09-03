/**
 * YouTube-owner operator path: only the ADMIN channel may drive the real
 * Hermes CLI (code, skills.sh, go-live). Viewers stay on view-safe GEV.
 *
 * @module hermesYoutubeAdmin
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { resolveHermesBin, parseHermesCliOutput } from './nousHermesCliInterpreter.js';

const ADMIN_STATE_FILE = '.gev-cache/admin-state.json';

export const DEFAULT_HERMES_YOUTUBE_ADMIN_EMAIL = 'techfundoffice@gmail.com';
export const DEFAULT_HERMES_YOUTUBE_ADMIN_HANDLE = 'TechfundOffice';

export const DEFAULT_HERMES_YOUTUBE_ADMIN = Object.freeze({
  emails: Object.freeze([DEFAULT_HERMES_YOUTUBE_ADMIN_EMAIL]),
  handles: Object.freeze([DEFAULT_HERMES_YOUTUBE_ADMIN_HANDLE, 'Techfund Office']),
  channelIds: Object.freeze([]),
});

function uniqueStrings(values, fallback = []) {
  const out = [];
  const seen = new Set();
  for (const value of [...(Array.isArray(values) ? values : []), ...fallback]) {
    const text = String(value || '').trim();
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

export function normalizeHermesYoutubeAdmin(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    emails: uniqueStrings(source.emails, DEFAULT_HERMES_YOUTUBE_ADMIN.emails),
    handles: uniqueStrings(source.handles, DEFAULT_HERMES_YOUTUBE_ADMIN.handles),
    channelIds: uniqueStrings(source.channelIds, DEFAULT_HERMES_YOUTUBE_ADMIN.channelIds),
  };
}

export function readHermesYoutubeAdminConfig(file = ADMIN_STATE_FILE) {
  try {
    const resolved = path.isAbsolute(file) ? file : path.join(process.cwd(), file);
    const raw = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    return normalizeHermesYoutubeAdmin(raw?.hermesYoutubeAdmin);
  } catch {
    return normalizeHermesYoutubeAdmin(null);
  }
}

function normHandle(value) {
  return String(value || '').trim().replace(/^@/, '').toLowerCase().replace(/\s+/g, '');
}

function normEmail(value) {
  return String(value || '').trim().toLowerCase();
}

export function isGoLiveComment(text) {
  return /\bgo\s+live\b/i.test(String(text || ''));
}

export function redactHermesAdminReply(text) {
  return String(text || '')
    .replace(/sk-or-v1-[A-Za-z0-9_-]+/g, '[redacted-openrouter-key]')
    .replace(/AIza[A-Za-z0-9_-]{20,}/g, '[redacted-google-key]')
    .replace(/ya29\.[A-Za-z0-9._-]+/g, '[redacted-oauth-token]')
    .replace(/1\/\/[A-Za-z0-9_-]+/g, '[redacted-refresh-token]')
    .replace(/(?:OPENROUTER_API_KEY|YOUTUBE_CLIENT_SECRET|GEV_ADMIN_PASSWORD)\s*=\s*\S+/g, '[redacted-env]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, 1800);
}

/**
 * True only for the configured YouTube operator. Display names like "Marcus"
 * never match. Chat-owner on the admin live broadcast does match.
 *
 * @param {object} comment
 * @param {object} [config]
 * @param {object} [owner]
 * @returns {boolean}
 */
export function isHermesYoutubeAdmin(comment = {}, config, owner = {}) {
  if (comment?.adminOperator === true) return true;
  const cfg = normalizeHermesYoutubeAdmin(config);
  const emails = new Set(cfg.emails.map(normEmail));
  const handles = new Set(cfg.handles.map(normHandle));
  const channels = new Set(cfg.channelIds.map((id) => String(id).trim()).filter(Boolean));

  const email = normEmail(comment.email || owner.email);
  if (email && emails.has(email)) return true;

  const channelId = String(
    comment.channelId
    || comment.author?.channelId
    || comment.authorChannelId
    || '',
  ).trim();
  if (channelId && channels.has(channelId)) return true;
  if (channelId && owner.channelId && channelId === String(owner.channelId).trim() && email && emails.has(email)) {
    return true;
  }

  const handle = normHandle(
    comment.authorHandle
    || comment.author?.handle
    || comment.handle
    || '',
  );
  if (handle && handles.has(handle)) return true;

  const display = normHandle(comment.author?.displayName || comment.author || comment.viewer || '');
  if (display && handles.has(display)) return true;

  if (comment.isChatOwner === true || comment.authorDetails?.isChatOwner === true) {
    const ownerHandle = normHandle(owner.handle || owner.channelTitle);
    if (!ownerHandle || handles.has(ownerHandle) || emails.has(normEmail(owner.email))) return true;
  }
  return false;
}

export function buildHermesAdminPrompt(input = {}) {
  const viewer = String(input.viewer || input.authorHandle || 'admin').trim();
  const comment = String(input.comment || '').trim();
  return `You are Nous Research Hermes Agent CLI running at the root of the Cloud Computer AI.com repository.

The YouTube account owner (${DEFAULT_HERMES_YOUTUBE_ADMIN_EMAIL} / @${DEFAULT_HERMES_YOUTUBE_ADMIN_HANDLE}) sent this live-chat command as ${viewer}:
${JSON.stringify(comment)}

This is an operator session, not a viewer GEV request.
You may edit this repository, run shell commands, install Hermes skills with \`hermes skills install …\` (skills.sh), and change program behavior. Do not refuse coding work.

If they asked to go live on YouTube, say you are starting the live encoder and output:
{"adminAction":"go_live"}
If they asked to change the globe view, you may still output a GEV JSON tool:
{"tool":"<gev function>","arguments":{...},"reply":"short status"}

Otherwise work like the Hermes CLI in this working directory and reply with the same text you would print in the shell: files changed, command output, skill install result. Never print API keys, tokens, passwords, or .env values.`;
}

export function createHermesAdminCliInterpreter({
  bin = resolveHermesBin(),
  model = process.env.HERMES_MODEL || 'x-ai/grok-4.6',
  provider = 'openrouter',
  cwd = process.cwd(),
  goLive = null,
  spawnImpl = spawn,
  timeoutMs = 180_000,
} = {}) {
  return async function interpret(input = {}) {
    const comment = String(input.comment || '');
    if (isGoLiveComment(comment) && typeof goLive === 'function') {
      try {
        const result = await goLive({ title: 'Cloud Computer AI.com LIVE' });
        const status = result?.live?.status || result?.status || 'started';
        const url = result?.broadcast?.watchUrl || result?.watchUrl || '';
        return {
          ok: true,
          kind: 'complete',
          text: redactHermesAdminReply(`Go live ${status}${url ? ` · ${url}` : ''}`),
          admin: true,
        };
      } catch (error) {
        return {
          ok: true,
          kind: 'complete',
          text: redactHermesAdminReply(`Go live failed: ${error?.message || error}`),
          admin: true,
        };
      }
    }

    const command = resolveHermesBin(bin);
    if (!command) return { ok: false, kind: 'invalid', reason: 'Hermes CLI is not installed' };
    const prompt = buildHermesAdminPrompt(input);
    const args = [
      'chat', '-q', prompt,
      '--oneshot', '-Q', '--cli', '--yolo',
      '--provider', provider, '-m', model,
      '--max-turns', '20',
      '--run-budget', '120',
    ];
    const result = await runAdminCommand(spawnImpl, command, args, cwd, timeoutMs);
    if (!result.ok) return { ok: false, kind: 'invalid', reason: result.reason };
    const parsed = parseHermesCliOutput(result.stdout, input.mode || 'execute');
    if (parsed.ok && parsed.kind === 'tool-call') return { ...parsed, admin: true };
    const action = extractAdminAction(result.stdout);
    if (action === 'go_live' && typeof goLive === 'function') {
      try {
        const live = await goLive({ title: 'Cloud Computer AI.com LIVE' });
        return {
          ok: true,
          kind: 'complete',
          text: redactHermesAdminReply(`${parsed.text || 'Go live'} ${live?.broadcast?.watchUrl || ''}`.trim()),
          admin: true,
        };
      } catch (error) {
        return { ok: true, kind: 'complete', text: redactHermesAdminReply(`Go live failed: ${error?.message || error}`), admin: true };
      }
    }
    const text = redactHermesAdminReply(parsed.text || result.stdout);
    return text
      ? { ok: true, kind: 'complete', text, admin: true }
      : { ok: false, kind: 'invalid', reason: 'Hermes admin CLI returned no reply' };
  };
}

function extractAdminAction(stdout) {
  const match = String(stdout || '').match(/"adminAction"\s*:\s*"([^"]+)"/);
  return match ? match[1] : '';
}

function runAdminCommand(spawnImpl, command, args, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawnImpl(command, args, {
      cwd,
      env: { ...process.env, HERMES_ACCEPT_HOOKS: '1', PATH: `${path.dirname(command)}:${process.env.PATH || ''}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ ok: false, reason: 'Hermes admin CLI timed out' });
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, reason: error.message || 'Hermes admin CLI failed to start' });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && !stdout.trim()) {
        resolve({ ok: false, reason: (stderr || `Hermes admin CLI exited ${code}`).slice(0, 160) });
        return;
      }
      resolve({ ok: true, stdout, stderr });
    });
  });
}
