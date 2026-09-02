/**
 * Server-only OpenRouter Free Models Router client.
 * Never import this into browser bundles. Never fall back to OpenAI or
 * openrouter/auto (auto can bill).
 */

import { resolveOpenRouterApiKey, resolveOpenRouterModel } from './openrouterAdminSecret.js';

export const OPENROUTER_CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';
export const OPENROUTER_FREE_MODEL = 'openrouter/free';

/**
 * The model every live-comment request is sent with.
 *
 * Resolution order is ADMIN selection → `OPENROUTER_MODEL` → the free router.
 * This is the single point the public-comment path reads, so the console's
 * choice takes effect here or not at all.
 *
 * @returns {string}
 */
export function openRouterFreeModel() {
  const configured = String(resolveOpenRouterModel() || OPENROUTER_FREE_MODEL).trim();
  if (!configured || configured === 'openrouter/auto' || configured.includes('auto:free')) {
    return OPENROUTER_FREE_MODEL;
  }
  return configured;
}

export function openRouterApiKey() {
  return resolveOpenRouterApiKey();
}

export function openRouterHeaders(apiKey = openRouterApiKey()) {
  const origin = process.env.REPLIT_DEV_DOMAIN
    ? `https://${process.env.REPLIT_DEV_DOMAIN}`
    : 'https://gods-eye-view.local';
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': origin,
    'X-Title': "God's Eye View",
  };
}

/**
 * Read the upstream's own retry hint off a rate-limited response.
 *
 * OpenRouter knows when its window reopens and we do not, so the server's
 * `Retry-After` (seconds, or an HTTP date) beats any local guess. Test doubles
 * return bare objects with no `headers`, so every access is defensive.
 *
 * @param {object} response
 * @returns {number} Milliseconds to wait, or 0 when the upstream gave no hint.
 */
export function retryAfterMs(response) {
  const raw = response?.headers?.get?.('retry-after');
  const header = String(raw ?? '').trim();
  if (!header) return 0;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : 0;
}

/**
 * POST chat/completions to the resolved OpenRouter model.
 */
export async function postOpenRouterChat({
  apiKey = openRouterApiKey(),
  model = openRouterFreeModel(),
  messages,
  tools,
  toolChoice = 'auto',
  maxTokens = 500,
  fetchImpl = globalThis.fetch,
  signal,
} = {}) {
  if (!apiKey) {
    return { ok: false, status: 503, payload: { error: 'OPENROUTER_API_KEY is not set' }, kind: 'unconfigured' };
  }
  if (model === 'openrouter/auto' || String(model).includes('auto:free')) {
    return { ok: false, status: 400, payload: { error: 'Paid auto router is not allowed' }, kind: 'provider' };
  }
  const body = {
    model,
    messages,
    max_tokens: maxTokens,
  };
  if (Array.isArray(tools) && tools.length) {
    body.tools = tools;
    body.tool_choice = toolChoice;
    body.parallel_tool_calls = false;
  }
  const response = await fetchImpl(OPENROUTER_CHAT_URL, {
    method: 'POST',
    signal,
    headers: openRouterHeaders(apiKey),
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const kind = response.status === 429 || response.status === 402 ? 'rate-limited' : 'provider';
    return { ok: false, status: response.status, payload, kind, retryAfterMs: retryAfterMs(response) };
  }
  return {
    ok: true,
    status: response.status,
    payload,
    model: typeof payload?.model === 'string' ? payload.model : model,
  };
}

export function catalogToolsToOpenRouter(catalogTools) {
  return (Array.isArray(catalogTools) ? catalogTools : []).map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description || `Public God's Eye View action: ${tool.name}`,
      parameters: tool.parameters || { type: 'object', properties: {} },
    },
  }));
}
