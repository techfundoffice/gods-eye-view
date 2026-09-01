/**
 * Server-only OpenRouter Free Models Router client.
 * Never import this into browser bundles. Never fall back to OpenAI or
 * openrouter/auto (auto can bill).
 */

export const OPENROUTER_CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';
export const OPENROUTER_FREE_MODEL = 'openrouter/free';

const FREE_RPM = 20;
const FREE_RPD = 50;

export function createOpenRouterFreeRateLimiter({
  rpm = FREE_RPM,
  rpd = FREE_RPD,
  now = Date.now,
} = {}) {
  const minute = [];
  const day = [];
  return {
    tryTake() {
      const t = now();
      while (minute.length && t - minute[0] > 60_000) minute.shift();
      while (day.length && t - day[0] > 86_400_000) day.shift();
      if (minute.length >= rpm || day.length >= rpd) {
        return { ok: false, kind: 'rate-limited', rpm: minute.length, rpd: day.length };
      }
      minute.push(t);
      day.push(t);
      return { ok: true, rpm: minute.length, rpd: day.length };
    },
    snapshot() {
      return { rpm: minute.length, rpd: day.length, rpmCap: rpm, rpdCap: rpd };
    },
  };
}

const defaultLimiter = createOpenRouterFreeRateLimiter();

export function openRouterFreeModel() {
  const configured = String(process.env.OPENROUTER_MODEL || OPENROUTER_FREE_MODEL).trim();
  if (!configured || configured === 'openrouter/auto' || configured.includes('auto:free')) {
    return OPENROUTER_FREE_MODEL;
  }
  return configured;
}

export function openRouterApiKey() {
  return String(process.env.OPENROUTER_API_KEY || '').trim();
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
 * POST chat/completions to openrouter/free.
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
  limiter = defaultLimiter,
} = {}) {
  if (!apiKey) {
    return { ok: false, status: 503, payload: { error: 'OPENROUTER_API_KEY is not set' }, kind: 'unconfigured' };
  }
  if (model === 'openrouter/auto' || String(model).includes('auto:free')) {
    return { ok: false, status: 400, payload: { error: 'Paid auto router is not allowed' }, kind: 'provider' };
  }
  const taken = limiter.tryTake();
  if (!taken.ok) {
    return { ok: false, status: 429, payload: { error: 'OpenRouter free rate limit' }, kind: 'rate-limited' };
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
    return { ok: false, status: response.status, payload, kind };
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
