/**
 * MCP server exposing the ADMIN console to clients outside the app.
 *
 * This is the "MCP server" ADMIN setting: an API-key-authenticated JSON-RPC
 * endpoint at `/api/admin/mcp` that speaks the Model Context Protocol over
 * plain HTTP POST, so an external client (another Claude Code session, an IDE,
 * an automation) can list and drive plugin builds without a browser session.
 *
 * The endpoint stays off until an operator enables it and mints a key. Key
 * verification happens in `adminServer`; this module owns the protocol and the
 * tool surface only.
 *
 * @module adminMcpServer
 */

import { gevMcpToolDefinitions } from './gevApi.js';

/** Protocol revision advertised in `initialize`. */
export const MCP_PROTOCOL_VERSION = '2024-11-05';
/** Server identity reported to MCP clients. */
export const MCP_SERVER_NAME = 'gods-eye-view-admin';

/** JSON-RPC error codes used by this endpoint. */
export const JSON_RPC_ERRORS = Object.freeze({
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
});

/**
 * Tool descriptors advertised by `tools/list`.
 *
 * @returns {object[]}
 */
export function adminMcpToolDefinitions() {
  return [
    ...gevMcpToolDefinitions(),
    {
      name: 'list_admin_plugins',
      description: 'List admin menu plugin builds started from the ADMIN console, newest first.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'create_admin_plugin',
      description: 'Start a new admin menu plugin build. The coding agent writes the plugin into this '
        + 'repository and registers it in the admin menu manifest.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Plugin name, e.g. "Fleet Watchlist".' },
          instructions: { type: 'string', description: 'What the plugin should do.' },
        },
        required: ['name'],
        additionalProperties: false,
      },
    },
    {
      name: 'get_admin_plugin',
      description: 'Read one plugin build, including its full agent transcript.',
      inputSchema: {
        type: 'object',
        properties: { jobId: { type: 'string', description: 'Build id from list_admin_plugins.' } },
        required: ['jobId'],
        additionalProperties: false,
      },
    },
    {
      name: 'send_admin_plugin_message',
      description: 'Send a follow-up message into an existing plugin build conversation.',
      inputSchema: {
        type: 'object',
        properties: {
          jobId: { type: 'string', description: 'Build id from list_admin_plugins.' },
          message: { type: 'string', description: 'Instruction for the coding agent.' },
        },
        required: ['jobId', 'message'],
        additionalProperties: false,
      },
    },
  ];
}

/**
 * @param {unknown} id JSON-RPC request id.
 * @param {object} result
 * @returns {object}
 */
export function jsonRpcResult(id, result) {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

/**
 * @param {unknown} id JSON-RPC request id.
 * @param {number} code
 * @param {string} message
 * @returns {object}
 */
export function jsonRpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

/**
 * Wrap a value as an MCP tool result payload.
 *
 * @param {unknown} value Serializable tool output.
 * @param {boolean} [isError]
 * @returns {{content: object[], isError: boolean}}
 */
export function toolContent(value, isError = false) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: 'text', text }], isError };
}

/**
 * Build the MCP request handler.
 *
 * @param {object} options
 * @param {object} options.builder Plugin builder from `createPluginBuilder`.
 * @param {string} [options.version] Reported server version.
 * @returns {{handle: (message: object) => Promise<object|null>, tools: object[]}}
 */
export function createAdminMcpServer({ builder, version = '1.0.0', runGevAction = null }) {
  if (!builder) throw new TypeError('MCP server requires a plugin builder');
  const tools = adminMcpToolDefinitions();

  /**
   * @param {string} name Tool name.
   * @param {object} args Tool arguments.
   * @returns {Promise<object>} MCP tool result.
   */
  async function callTool(name, args = {}) {
    switch (name) {
      case 'list_admin_plugins':
        return toolContent({ plugins: builder.list() });
      case 'create_admin_plugin': {
        const pluginName = String(args?.name ?? '').trim();
        if (!pluginName) return toolContent('A plugin name is required.', true);
        try {
          return toolContent(builder.start({
            name: pluginName,
            instructions: String(args?.instructions ?? ''),
          }));
        } catch (error) {
          return toolContent(error?.message || 'Could not start the plugin build.', true);
        }
      }
      case 'get_admin_plugin': {
        const job = builder.get(String(args?.jobId ?? ''));
        return job ? toolContent(job) : toolContent('No build with that id.', true);
      }
      case 'send_admin_plugin_message': {
        const job = builder.send(String(args?.jobId ?? ''), String(args?.message ?? ''));
        return job ? toolContent(job) : toolContent('No build with that id.', true);
      }
      default: {
        if (typeof runGevAction === 'function' && tools.some((tool) => tool.name === name)) {
          try {
            const result = await runGevAction(name, args || {});
            return toolContent(result, result?.ok === false);
          } catch (error) {
            return toolContent(error?.message || 'GEV action failed', true);
          }
        }
        return toolContent(`Unknown tool: ${name}`, true);
      }
    }
  }

  /**
   * Handle one JSON-RPC message.
   *
   * @param {object} message Parsed request or notification.
   * @returns {Promise<object|null>} Response, or null for notifications.
   */
  async function handle(message) {
    if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0' || !message.method) {
      return jsonRpcError(message?.id, JSON_RPC_ERRORS.invalidRequest, 'Invalid JSON-RPC request');
    }
    const { method, id } = message;
    // A notification carries no id and must never receive a response body.
    const isNotification = id === undefined || id === null;

    switch (method) {
      case 'initialize':
        return jsonRpcResult(id, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: MCP_SERVER_NAME, version },
        });
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null;
      case 'ping':
        return isNotification ? null : jsonRpcResult(id, {});
      case 'tools/list':
        return jsonRpcResult(id, { tools });
      case 'tools/call': {
        const name = String(message.params?.name ?? '');
        if (!tools.some((tool) => tool.name === name)) {
          return jsonRpcError(id, JSON_RPC_ERRORS.invalidParams, `Unknown tool: ${name || '(none)'}`);
        }
        try {
          return jsonRpcResult(id, await callTool(name, message.params?.arguments || {}));
        } catch (error) {
          return jsonRpcError(id, JSON_RPC_ERRORS.internal, error?.message || 'Tool call failed');
        }
      }
      default:
        return isNotification
          ? null
          : jsonRpcError(id, JSON_RPC_ERRORS.methodNotFound, `Unknown method: ${method}`);
    }
  }

  return { handle, tools };
}
