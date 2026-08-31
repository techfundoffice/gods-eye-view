/**
 * Narrow, server-side Composio control plane for the ADMIN console.
 *
 * The API key is read only from the server environment. Browser callers see
 * redacted account/tool metadata and stable capability ids, never credentials,
 * raw upstream responses, or arbitrary Composio slugs.
 *
 * @module composioAdminServer
 */

export const COMPOSIO_BASE_URL = 'https://backend.composio.dev/api/v3.1';
export const COMPOSIO_MAX_ACCOUNTS = 32;
export const COMPOSIO_MAX_TOOLS = 32;
export const COMPOSIO_MAX_INPUT_FIELDS = 32;
export const COMPOSIO_MAX_ARGUMENTS = 32;
export const COMPOSIO_MAX_TEXT = 2000;
export const COMPOSIO_MAX_RESPONSE_BYTES = 512 * 1024;

const TOOL_SLUG = /^[A-Z][A-Z0-9_]{0,119}$/;
const CAPABILITY_ID = /^composio:([A-Z][A-Z0-9_]{0,119})$/;

function boundedText(value, max = COMPOSIO_MAX_TEXT) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

/**
 * Parse the server-owned action allowlist.
 *
 * @param {unknown} value Comma-separated tool slugs.
 * @returns {string[]}
 */
export function parseComposioToolAllowlist(value = process.env.COMPOSIO_ALLOWED_TOOLS) {
  return [...new Set(String(value ?? '')
    .split(',')
    .map((item) => item.trim().toUpperCase())
    .filter((item) => TOOL_SLUG.test(item)))].slice(0, COMPOSIO_MAX_TOOLS);
}

/**
 * Convert a Composio input schema into safe UI metadata.
 *
 * @param {object} tool
 * @returns {object}
 */
export function publicComposioTool(tool) {
  const inputs = tool?.input_parameters && typeof tool.input_parameters === 'object'
    ? tool.input_parameters
    : {};
  const inputParameters = {};
  for (const [name, definition] of Object.entries(inputs).slice(0, COMPOSIO_MAX_INPUT_FIELDS)) {
    const safeName = boundedText(name, 80);
    if (!safeName || !/^[A-Za-z][A-Za-z0-9_.-]*$/.test(safeName)) continue;
    const entry = definition && typeof definition === 'object' ? definition : {};
    inputParameters[safeName] = {
      type: boundedText(entry.type || 'string', 32),
      description: boundedText(entry.description, 400),
      required: Boolean(entry.required),
      ...(Array.isArray(entry.enum)
        ? { enum: entry.enum.slice(0, 32).map((item) => boundedText(item, 120)) }
        : {}),
    };
  }
  return {
    capabilityId: `composio:${tool?.slug || ''}`,
    slug: boundedText(tool?.slug, 120),
    name: boundedText(tool?.name || tool?.slug, 120),
    description: boundedText(tool?.human_description || tool?.description, 500),
    toolkit: boundedText(tool?.toolkit?.slug, 80),
    version: boundedText(tool?.version, 80),
    inputParameters,
  };
}

function publicComposioAccount(account) {
  const status = boundedText(account?.status, 40).toUpperCase();
  return {
    id: boundedText(account?.id, 160),
    toolkit: boundedText(account?.toolkit?.slug, 80),
    status,
    usable: status === 'ACTIVE' || status === 'CONNECTED',
    alias: boundedText(account?.alias, 120),
    createdAt: boundedText(account?.created_at, 80),
  };
}

function composioError(kind, message, status = 502, cause = null) {
  const error = new Error(message);
  error.kind = kind;
  error.status = status;
  if (cause) error.cause = cause;
  return error;
}

function classifyComposioStatus(status) {
  if (status === 401 || status === 403) return ['authentication', 502];
  if (status === 429) return ['quota', 429];
  if (status >= 400 && status < 500) return ['upstream-request', 502];
  return ['upstream', 502];
}

function validateArguments(args, tool) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw composioError('invalid-request', 'Action inputs must be a JSON object.', 400);
  }
  const entries = Object.entries(args);
  if (entries.length > COMPOSIO_MAX_ARGUMENTS) {
    throw composioError('invalid-request', `Action inputs are limited to ${COMPOSIO_MAX_ARGUMENTS} fields.`, 400);
  }
  const definitions = tool?.inputParameters || {};
  for (const [name, value] of entries) {
    if (!Object.prototype.hasOwnProperty.call(definitions, name)) {
      throw composioError('invalid-request', `Input is not allowed for ${tool.slug}: ${name}`, 400);
    }
    if (typeof value === 'string' && value.length > COMPOSIO_MAX_TEXT) {
      throw composioError('invalid-request', `Input ${name} is too long.`, 400);
    }
    if (value !== null && typeof value === 'object') {
      const serialized = JSON.stringify(value);
      if (serialized.length > COMPOSIO_MAX_TEXT) {
        throw composioError('invalid-request', `Input ${name} is too large.`, 400);
      }
    }
  }
  for (const [name, definition] of Object.entries(definitions)) {
    if (definition.required && !Object.prototype.hasOwnProperty.call(args, name)) {
      throw composioError('invalid-request', `Required input is missing: ${name}`, 400);
    }
  }
  return args;
}

async function readBoundedJson(response) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > COMPOSIO_MAX_RESPONSE_BYTES) {
    throw composioError('response-too-large', 'Composio returned an oversized response.', 502);
  }
  let bytes;
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > COMPOSIO_MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw composioError('response-too-large', 'Composio returned an oversized response.', 502);
      }
      chunks.push(value);
    }
    bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), size);
  } else {
    const text = await response.text();
    bytes = Buffer.from(text);
    if (bytes.length > COMPOSIO_MAX_RESPONSE_BYTES) {
      throw composioError('response-too-large', 'Composio returned an oversized response.', 502);
    }
  }
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * Create the server-side Composio facade.
 *
 * @param {object} [options]
 * @param {string} [options.apiKey] Test injection; production reads env.
 * @param {Function} [options.fetchImpl]
 * @param {string} [options.baseUrl]
 * @param {string|string[]} [options.allowedTools]
 * @returns {object}
 */
export function createComposioAdminService({
  apiKey = process.env.COMPOSIO_API_KEY || '',
  fetchImpl = globalThis.fetch,
  baseUrl = COMPOSIO_BASE_URL,
  allowedTools = parseComposioToolAllowlist(),
} = {}) {
  const key = String(apiKey || '').trim();
  const allowlist = new Set(Array.isArray(allowedTools)
    ? allowedTools.map((item) => String(item).trim().toUpperCase()).filter((item) => TOOL_SLUG.test(item))
    : parseComposioToolAllowlist(allowedTools));
  const configured = Boolean(key);
  if (typeof fetchImpl !== 'function') throw new TypeError('Composio service requires fetch');

  async function request(path, { method = 'GET', body, query } = {}) {
    if (!configured) throw composioError('unconfigured', 'Composio is not configured on the server.', 503);
    const url = new URL(`${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`);
    for (const [name, value] of Object.entries(query || {})) {
      if (value !== undefined && value !== '') url.searchParams.set(name, String(value));
    }
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'x-api-key': key,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(12000),
      });
    } catch (cause) {
      throw composioError('upstream', 'Composio could not be reached.', 502, cause);
    }
    const payload = await readBoundedJson(response);
    if (!response.ok) {
      const [kind, status] = classifyComposioStatus(response.status);
      throw composioError(kind, `Composio returned HTTP ${response.status}.`, status);
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw composioError('malformed', 'Composio returned an invalid response.', 502);
    }
    return payload;
  }

  async function listAccounts() {
    const payload = await request('/connected_accounts', {
      query: { limit: COMPOSIO_MAX_ACCOUNTS, order_by: 'created_at', order_direction: 'desc' },
    });
    if (!Array.isArray(payload.items)) throw composioError('malformed', 'Composio returned no account list.', 502);
    return payload.items.slice(0, COMPOSIO_MAX_ACCOUNTS).map(publicComposioAccount);
  }

  async function listTools() {
    if (!allowlist.size) return [];
    const payload = await request('/tools', {
      query: { tool_slugs: [...allowlist].join(','), limit: COMPOSIO_MAX_TOOLS, include_deprecated: 'false' },
    });
    if (!Array.isArray(payload.items)) throw composioError('malformed', 'Composio returned no tool list.', 502);
    return payload.items
      .map(publicComposioTool)
      .filter((tool) => allowlist.has(tool.slug) && TOOL_SLUG.test(tool.slug))
      .slice(0, COMPOSIO_MAX_TOOLS);
  }

  function findCapability(tools, capabilityId) {
    const match = CAPABILITY_ID.exec(String(capabilityId || ''));
    const tool = match && tools.find((candidate) => candidate.slug === match[1]);
    if (!tool || !allowlist.has(tool.slug)) {
      throw composioError('not-allowed', 'That Composio capability is not enabled for this site.', 403);
    }
    return tool;
  }

  async function status() {
    if (!configured) {
      return {
        configured: false,
        state: 'unconfigured',
        health: 'not-configured',
        accounts: [],
        tools: [],
        capabilities: [...allowlist].map((slug) => `composio:${slug}`),
      };
    }
    try {
      const [accounts, tools] = await Promise.all([listAccounts(), listTools()]);
      return {
        configured: true,
        state: accounts.length ? (tools.length ? 'connected' : 'no-capabilities') : 'disconnected',
        health: 'healthy',
        accounts,
        tools,
        capabilities: tools.map((tool) => tool.capabilityId),
      };
    } catch (error) {
      throw error?.kind ? error : composioError('upstream', 'Composio status check failed.');
    }
  }

  async function validate({ capabilityId, arguments: args = {} } = {}) {
    const tools = await listTools();
    const tool = findCapability(tools, capabilityId);
    validateArguments(args, tool);
    return {
      ok: true,
      kind: 'validation',
      capabilityId: tool.capabilityId,
      message: 'Capability is allowlisted and the supplied inputs match its requirements.',
    };
  }

  async function execute({ capabilityId, arguments: args = {}, connectedAccountId = '' } = {}) {
    const [tools, accounts] = await Promise.all([listTools(), listAccounts()]);
    const tool = findCapability(tools, capabilityId);
    validateArguments(args, tool);
    const accountId = boundedText(connectedAccountId, 160);
    if (!accountId || !accounts.some((account) => (
      account.id === accountId && account.toolkit === tool.toolkit && account.usable
    ))) {
      throw composioError('invalid-request', 'Choose an active connected account for this capability.', 400);
    }
    const payload = await request(`/tools/execute/${encodeURIComponent(tool.slug)}`, {
      method: 'POST',
      body: {
        arguments: args,
        connected_account_id: accountId,
        ...(tool.version ? { version: tool.version } : {}),
      },
    });
    return {
      ok: Boolean(payload.success),
      capabilityId: tool.capabilityId,
      executionId: boundedText(payload.log_id, 160) || null,
      message: payload.success ? 'Composio action completed.' : 'Composio action did not complete.',
    };
  }

  return {
    configured,
    allowedTools: [...allowlist],
    status,
    listAccounts,
    listTools,
    validate,
    execute,
  };
}

/**
 * Redacted response helper for ADMIN routes.
 *
 * @param {object} error
 * @returns {{kind: string, message: string}}
 */
export function publicComposioError(error) {
  const kind = String(error?.kind || 'upstream');
  const fixed = {
    authentication: 'Composio rejected the configured server credential.',
    quota: 'Composio rate limited this request. Try again later.',
    upstream: 'Composio could not be reached.',
    'upstream-request': 'Composio rejected the server request.',
    malformed: 'Composio returned an invalid response.',
    'response-too-large': 'Composio returned an oversized response.',
  };
  return {
    kind,
    message: fixed[kind] || boundedText(error?.message || 'Composio request failed.', 300),
  };
}