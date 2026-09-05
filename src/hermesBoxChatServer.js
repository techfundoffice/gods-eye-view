/**
 * Same-origin Hermes desk conversation endpoint for the east-rail box chat.
 * Prefers Nous Hermes CLI multi-turn sessions; falls back to OpenRouter chat.
 *
 * @module hermesBoxChatServer
 */

import { spawn, execFileSync } from 'node:child_process';
/* === GEV_HERMES_SPACES_V1 === */
import path from 'node:path';
import { resolveHermesBin } from './nousHermesCliInterpreter.js';
import { openRouterApiKey, postOpenRouterChat } from './openrouterFreeClient.js';
import fs from 'node:fs';

function readHermesActiveModel(home = path.join(process.cwd(), '.hermes')) {
  try {
    const raw = fs.readFileSync(path.join(home, 'config.yaml'), 'utf8');
    const modelMatch = raw.match(/^\s*default:\s*([^\s#]+)/m);
    const providerMatch = raw.match(/^\s*provider:\s*([^\s#]+)/m);
    // Prefer model.provider under the model: block — first provider after model: default
    let provider = 'nous';
    let model = 'google/gemini-3.8-flash';
    const modelBlock = raw.match(/model:\s*\n([\s\S]*?)(?:\n[a-z_]+:|\n#|$)/i);
    if (modelBlock) {
      const block = modelBlock[1];
      const d = block.match(/^\s*default:\s*([^\s#]+)/m);
      const p = block.match(/^\s*provider:\s*([^\s#]+)/m);
      if (d?.[1]) model = d[1].trim();
      if (p?.[1]) provider = p[1].trim();
    } else {
      if (modelMatch?.[1]) model = modelMatch[1].trim();
      if (providerMatch?.[1]) provider = providerMatch[1].trim();
    }
    return { provider, model };
  } catch {
    return { provider: 'nous', model: 'google/gemini-3.8-flash' };
  }
}


export const HERMES_BOX_CHAT_PATH = '/box-chat';
export const DEFAULT_CONVERSATION_ID = 'gev-hermes-box';

const WORKSPACE_STATE_PATH = path.join(process.cwd(), '.hermes', 'gev-box-workspace.json');

function readWorkspaceState() {
  try {
    const raw = fs.readFileSync(WORKSPACE_STATE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    const cwd = typeof parsed?.cwd === 'string' ? parsed.cwd.trim() : '';
    return { cwd: cwd || process.cwd() };
  } catch {
    return { cwd: process.cwd() };
  }
}

function writeWorkspaceState(next) {
  const cwd = String(next?.cwd || process.cwd()).trim() || process.cwd();
  fs.mkdirSync(path.dirname(WORKSPACE_STATE_PATH), { recursive: true });
  fs.writeFileSync(WORKSPACE_STATE_PATH, JSON.stringify({ cwd, updatedAt: new Date().toISOString() }, null, 2));
  return { cwd };
}

function isSafeWorkspacePath(candidate) {
  const resolved = path.resolve(String(candidate || '').trim());
  if (!resolved || resolved === '/' || resolved.includes('\0')) return null;
  try {
    const st = fs.statSync(resolved);
    if (!st.isDirectory()) return null;
  } catch {
    return null;
  }
  // Stay under runner home / workspace for safety on Replit.
  const home = path.resolve('/home/runner');
  if (!resolved.startsWith(home + path.sep) && resolved !== home) return null;
  return resolved;
}

function listGitWorktrees(repoRoot = process.cwd()) {
  try {
    const out = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 8000,
    });
    const trees = [];
    let cur = null;
    for (const line of String(out).split('\n')) {
      if (line.startsWith('worktree ')) {
        if (cur) trees.push(cur);
        cur = { path: line.slice(9).trim(), branch: '', bare: false };
      } else if (line.startsWith('branch ') && cur) {
        cur.branch = line.slice(7).trim().replace(/^refs\/heads\//, '');
      } else if (line === 'bare' && cur) {
        cur.bare = true;
      } else if (line === '' && cur) {
        trees.push(cur);
        cur = null;
      }
    }
    if (cur) trees.push(cur);
    return trees.filter((t) => t.path && !t.bare);
  } catch {
    return [{ path: process.cwd(), branch: 'main' }];
  }
}

function createIsolatedWorktree(repoRoot = process.cwd()) {
  const id = `cloudy-${Date.now().toString(36)}`;
  const branch = `hermes/${id}`;
  const dest = path.join(repoRoot, '.worktrees', id);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  execFileSync('git', ['worktree', 'add', '-b', branch, dest], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { path: dest, branch, id };
}

export const MAX_BOX_CHAT_TEXT = 1500;
export const MAX_BOX_CHAT_REPLY = 1200;

const MAX_BODY_BYTES = 48_000;
const RATE_WINDOW_MS = 2_500;

const BOX_SYSTEM = `You are Hermes, the Cloud Computer AI.com / God's Eye View (GEV) desk agent on a live globe HUD.
Be conversational, concise, and helpful. You may mention globe commands viewers can use (fly to places, toggle layers, CCTV, radio, styles).
Do not invent desktop file/schedule features. Keep replies under 600 characters when possible. No markdown fences.`;

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request is too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(Object.assign(new Error('Request must be JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function pathOf(req) {
  return String(req.url || '').split('?')[0];
}

export function sanitizeBoxChatText(value, max = MAX_BOX_CHAT_TEXT) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/^\s*#AI\b[:\s-]*/i, '')
    .trim()
    .slice(0, max);
}

export function safeConversationId(value) {
  const normalized = String(value || DEFAULT_CONVERSATION_ID)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return normalized || DEFAULT_CONVERSATION_ID;
}

function extractOpenRouterReply(payload) {
  const choice = payload?.choices?.[0]?.message;
  const content = choice?.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('').trim();
  }
  return '';
}


function isHermesCliFailureText(value) {
  const text = String(value || '');
  return /billing or credits exhausted|requires more credits|HTTP 402|OpenRouter reported that billing|insufficient credits|api key|unauthorized|rate.?limit/i.test(text);
}

function runHermesCliChat({
  text,
  conversationId,
  workspacePath = '',
  bin = resolveHermesBin(),
  model = process.env.HERMES_MODEL || readHermesActiveModel().model,
  provider = process.env.HERMES_PROVIDER || readHermesActiveModel().provider || 'nous',
  timeoutMs = 45_000,
  env = process.env,
  spawnImpl = spawn,
} = {}) {
  return new Promise((resolve) => {
    const command = resolveHermesBin(bin);
    if (!command) {
      resolve({ ok: false, kind: 'unconfigured', reason: 'Hermes CLI is not installed' });
      return;
    }
    const prompt = `${BOX_SYSTEM}\n\nUser message: ${JSON.stringify(text)}`;
    const sessionName = safeConversationId(conversationId);
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
      '--max-turns', '4',
      '--run-budget', '45',
    ];
    const workspaceCwd = isSafeWorkspacePath(workspacePath) || readWorkspaceState().cwd;
    if (workspaceCwd) args.push('--in', workspaceCwd);
    const apiKey = openRouterApiKey();
    const child = spawnImpl(command, args, {
      env: {
        ...env,
        ...(apiKey ? { OPENROUTER_API_KEY: apiKey } : {}),
        HERMES_ACCEPT_HOOKS: '0',
        HERMES_HOME: path.join(process.cwd(), '.hermes'),
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
      const raw = String(stdout || '').trim();
      if (!raw) {
        resolve({
          ok: false,
          kind: 'process',
          reason: (stderr || `Hermes CLI exited ${code}`).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 160),
        });
        return;
      }
      let reply = raw;
      try {
        const start = raw.indexOf('{');
        const end = raw.lastIndexOf('}');
        if (start >= 0 && end > start) {
          const parsed = JSON.parse(raw.slice(start, end + 1));
          reply = String(parsed.reply || parsed.text || parsed.message || raw).trim();
        }
      } catch { /* plain text reply */ }
      reply = reply
        .replace(/^\s*⚠[^\n]*\n?/gm, "")
        .replace(/tirith security scanner[^\.\n]*\.?/gi, "")
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .replace(/\s{2,}/g, " ")
        .trim()
        .slice(0, MAX_BOX_CHAT_REPLY);
      if (!reply) {
        resolve({ ok: false, kind: 'invalid', reason: 'Hermes CLI returned no reply' });
        return;
      }
      if (isHermesCliFailureText(reply)) {
        resolve({
          ok: false,
          kind: 'provider',
          reason: reply.replace(/https:\/\/openrouter\.ai\/[^\s]+/gi, 'https://openrouter.ai/…').slice(0, 180),
        });
        return;
      }
      resolve({ ok: true, reply, source: 'hermes-cli', conversationId: sessionName });
    });
  });
}

export async function runHermesBoxChat({
  text,
  conversationId = DEFAULT_CONVERSATION_ID,
  author = '',
  source = 'composer',
  attachmentContext = '',
  workspacePath = '',
  hermesController = null,
  fetchImpl = globalThis.fetch,
} = {}) {
  const cleaned = sanitizeBoxChatText(text);
  if (!cleaned) {
    return { ok: false, status: 400, error: { kind: 'invalid', message: 'Message text is required' } };
  }
  const session = safeConversationId(conversationId);
  const attribution = String(author || '').trim().slice(0, 80);
  const attachNote = sanitizeBoxChatText(attachmentContext, 6000);
  let promptText = attribution
    ? `[From ${attribution} via ${String(source || 'chat').slice(0, 40)}] ${cleaned}`
    : cleaned;
  if (attachNote) {
    promptText = `${promptText}\n\n[Attached context]\n${attachNote}`;
  }

  // Hermes Agent active connector first (Nous Portal / config.yaml model.provider).
  void hermesController;
  const active = readHermesActiveModel();
  const cliResult = await runHermesCliChat({
    text: promptText,
    conversationId: session,
    workspacePath: workspacePath || readWorkspaceState().cwd,
    provider: process.env.HERMES_PROVIDER || active.provider || 'nous',
    model: process.env.HERMES_MODEL || active.model || 'google/gemini-3.8-flash',
    timeoutMs: 35_000,
  });

  if (cliResult.ok) {
    return {
      ok: true,
      status: 200,
      reply: cliResult.reply,
      source: cliResult.source || 'hermes-cli',
      conversationId: session,
      provider: process.env.HERMES_PROVIDER || active.provider || 'nous',
      model: process.env.HERMES_MODEL || active.model || 'google/gemini-3.8-flash',
    };
  }

  // Last-resort only if Nous/Hermes CLI is down — not the preferred path.
  const fallback = await postOpenRouterChat({
    messages: [
      { role: 'system', content: BOX_SYSTEM },
      { role: 'user', content: promptText },
    ],
    maxTokens: 400,
    fetchImpl,
  });
  if (fallback.ok) {
    const reply = extractOpenRouterReply(fallback.payload).slice(0, MAX_BOX_CHAT_REPLY);
    if (reply) {
      return {
        ok: true,
        status: 200,
        reply,
        source: 'openrouter-fallback',
        conversationId: session,
        hermesFallbackReason: cliResult.reason || '',
      };
    }
  }

  return {
    ok: false,
    status: fallback.status || 503,
    error: {
      kind: cliResult.kind || fallback.kind || 'unavailable',
      message: String(
        cliResult.reason
        || fallback.payload?.error
        || 'Hermes Nous connector unavailable',
      ).slice(0, 200),
      hermes: cliResult.reason || '',
    },
  };
}

/**
 * Mount at /api/hermes — handles POST /box-chat.
 */
export function createHermesBoxChatMiddleware({
  hermesController = null,
  fetchImpl = globalThis.fetch,
} = {}) {
  let lastAt = 0;
  return async function hermesBoxChatMiddleware(req, res) {
    const routePath = pathOf(req);
    if (req.method === 'OPTIONS' && (routePath === HERMES_BOX_CHAT_PATH || routePath === '/')) {
      res.statusCode = 204;
      res.setHeader('allow', 'POST, OPTIONS');
      res.end();
      return;
    }
    if (req.method === 'GET' && (routePath === HERMES_BOX_CHAT_PATH || routePath === '/' || routePath === '')) {
      const snap = hermesController?.status?.() || {};
      const active = readHermesActiveModel();
      return send(res, 200, {
        ok: true,
        route: '/api/hermes/box-chat',
        ready: Boolean(snap.ready || snap.cli || true),
        conversationId: DEFAULT_CONVERSATION_ID,
        provider: active.provider,
        model: active.model,
      });
    }

    if ((req.method === 'GET' || req.method === 'POST') && (routePath === '/workspace' || routePath === '/spaces')) {
      const state = readWorkspaceState();
      if (req.method === 'GET') {
        return send(res, 200, {
          ok: true,
          homeLabel: 'Home',
          cwd: state.cwd,
          worktrees: listGitWorktrees(process.cwd()),
        });
      }
      let body;
      try {
        body = await readBody(req);
      } catch (error) {
        return send(res, error?.status || 400, {
          error: { kind: 'invalid', message: error?.message || 'Invalid JSON body' },
        });
      }
      const action = String(body?.action || '').trim();
      try {
        if (action === 'set-path' || action === 'choose') {
          const safe = isSafeWorkspacePath(body?.path || body?.cwd);
          if (!safe) {
            return send(res, 400, { ok: false, error: { kind: 'invalid', message: 'Path must be an existing directory under /home/runner' } });
          }
          const next = writeWorkspaceState({ cwd: safe });
          return send(res, 200, { ok: true, cwd: next.cwd, worktrees: listGitWorktrees(process.cwd()) });
        }
        if (action === 'worktree' || action === 'new-worktree') {
          const created = createIsolatedWorktree(process.cwd());
          const next = writeWorkspaceState({ cwd: created.path });
          return send(res, 200, {
            ok: true,
            cwd: next.cwd,
            worktree: created,
            worktrees: listGitWorktrees(process.cwd()),
            conversationHint: 'new',
          });
        }
        if (action === 'manage' || action === 'list') {
          return send(res, 200, {
            ok: true,
            cwd: state.cwd,
            worktrees: listGitWorktrees(process.cwd()),
          });
        }
        if (action === 'home' || action === 'reset') {
          const next = writeWorkspaceState({ cwd: process.cwd() });
          return send(res, 200, { ok: true, cwd: next.cwd, worktrees: listGitWorktrees(process.cwd()) });
        }
        return send(res, 400, { ok: false, error: { kind: 'invalid', message: 'Unknown workspace action' } });
      } catch (error) {
        return send(res, 500, {
          ok: false,
          error: { kind: 'process', message: String(error?.message || error).slice(0, 200) },
        });
      }
    }

    if (req.method !== 'POST' || (routePath !== HERMES_BOX_CHAT_PATH && routePath !== '/')) {
      return send(res, 404, { error: { kind: 'not-found', message: 'Hermes box chat route not found' } });
    }
    const now = Date.now();
    if (now - lastAt < RATE_WINDOW_MS) {
      return send(res, 429, { error: { kind: 'rate-limit', message: 'Hermes box chat is cooling down' } });
    }
    lastAt = now;
    let body;
    try {
      body = await readBody(req);
    } catch (error) {
      return send(res, error?.status || 400, {
        error: { kind: 'invalid', message: error?.message || 'Invalid JSON body' },
      });
    }
    const result = await runHermesBoxChat({
      text: body?.text || body?.message || body?.prompt,
      conversationId: body?.conversationId,
      author: body?.author || body?.authorHandle,
      source: body?.source || 'composer',
      attachmentContext: body?.attachmentContext || body?.attachmentsText || '',
      workspacePath: body?.workspacePath || body?.cwd || '',
      hermesController,
      fetchImpl,
    });
    if (!result.ok) {
      return send(res, result.status || 503, { ok: false, error: result.error });
    }
    return send(res, 200, {
      ok: true,
      reply: result.reply,
      source: result.source,
      conversationId: result.conversationId,
      ...(result.hermesFallbackReason ? { hermesFallbackReason: result.hermesFallbackReason } : {}),
    });
  };
}
