/**
 * Same-origin Hermes desk conversation endpoint for the east-rail box chat.
 * Prefers Nous Hermes CLI multi-turn sessions; falls back to OpenRouter chat.
 *
 * @module hermesBoxChatServer
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { resolveHermesBin } from './nousHermesCliInterpreter.js';
import { openRouterApiKey, postOpenRouterChat } from './openrouterFreeClient.js';

export const HERMES_BOX_CHAT_PATH = '/box-chat';
export const DEFAULT_CONVERSATION_ID = 'gev-hermes-box';
export const MAX_BOX_CHAT_TEXT = 1500;
export const MAX_BOX_CHAT_REPLY = 1200;

const MAX_BODY_BYTES = 8_000;
const RATE_WINDOW_MS = 8_000;

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
  bin = resolveHermesBin(),
  model = process.env.HERMES_MODEL || 'x-ai/grok-4.6',
  provider = 'openrouter',
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
  hermesController = null,
  fetchImpl = globalThis.fetch,
} = {}) {
  const cleaned = sanitizeBoxChatText(text);
  if (!cleaned) {
    return { ok: false, status: 400, error: { kind: 'invalid', message: 'Message text is required' } };
  }
  const session = safeConversationId(conversationId);
  const attribution = String(author || '').trim().slice(0, 80);
  const promptText = attribution
    ? `[From ${attribution} via ${String(source || 'chat').slice(0, 40)}] ${cleaned}`
    : cleaned;

  // Conversational CLI first (stable session id). OpenRouter is the fallback.
  void hermesController;
  const cliResult = await runHermesCliChat({
    text: promptText,
    conversationId: session,
  });

  if (cliResult.ok) {
    return {
      ok: true,
      status: 200,
      reply: cliResult.reply,
      source: cliResult.source || 'hermes-cli',
      conversationId: session,
    };
  }

  const fallback = await postOpenRouterChat({
    messages: [
      { role: 'system', content: BOX_SYSTEM },
      { role: 'user', content: promptText },
    ],
    maxTokens: 400,
    fetchImpl,
  });
  if (!fallback.ok) {
    return {
      ok: false,
      status: fallback.status || 503,
      error: {
        kind: fallback.kind || 'unavailable',
        message: String(fallback.payload?.error || cliResult.reason || 'Hermes box chat unavailable').slice(0, 200),
        hermes: cliResult.reason || '',
      },
    };
  }
  const reply = extractOpenRouterReply(fallback.payload).slice(0, MAX_BOX_CHAT_REPLY);
  if (!reply) {
    return {
      ok: false,
      status: 502,
      error: {
        kind: 'invalid',
        message: 'OpenRouter returned an empty reply',
        hermes: cliResult.reason || '',
      },
    };
  }
  return {
    ok: true,
    status: 200,
    reply,
    source: 'openrouter-fallback',
    conversationId: session,
    hermesFallbackReason: cliResult.reason || '',
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
      return send(res, 200, {
        ok: true,
        route: '/api/hermes/box-chat',
        ready: Boolean(snap.ready || snap.cli),
        conversationId: DEFAULT_CONVERSATION_ID,
      });
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
