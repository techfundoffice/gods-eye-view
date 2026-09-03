/**
 * `/api/gev` — API-key REST surface for every GEV function.
 *
 * GET  /           catalog
 * GET  /docs       operator documentation
 * POST /:name      enqueue the action on the live capture globe
 *
 * @module gevApiServer
 */

import { extractApiKey } from './adminAuth.js';
import {
  GEV_API_PREFIX,
  gevApiDocumentation,
  listGevFunctions,
} from './gevApi.js';
import { validatePublicToolCall } from './youtubePublicCommandPolicy.js';

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(body);
}

function readJsonBody(req, maxBytes = 16_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error('Request is too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(text);
        resolve(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {});
      } catch {
        reject(Object.assign(new Error('Body must be JSON'), { status: 400 }));
      }
    });
  });
}

/**
 * @param {object} options
 * @param {{verifyApiKey: Function}} options.auth
 * @param {{enqueueTool?: Function}} [options.commandRuntime]
 * @param {Function} [options.getBinding]
 * @param {string} [options.origin]
 * @returns {(req: object, res: object, next?: Function) => Promise<void>}
 */
export function createGevApiMiddleware({
  auth,
  commandRuntime = null,
  getBinding = () => ({}),
  origin = '',
} = {}) {
  if (!auth || typeof auth.verifyApiKey !== 'function') {
    throw new TypeError('Cloud Computer AI.com API requires admin API-key verification');
  }

  function authorize(req, res) {
    const key = auth.verifyApiKey(extractApiKey(req.headers || {}));
    if (!key) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="gev-api"');
      sendJson(res, 401, { error: { kind: 'auth', message: 'Valid admin API key required' } });
      return null;
    }
    return key;
  }

  return async function gevApiMiddleware(req, res) {
    const method = String(req.method || 'GET').toUpperCase();
    const parsed = new URL(String(req.url || '/'), 'http://internal');
    const segments = parsed.pathname.split('/').filter(Boolean);

    if (!authorize(req, res)) return;

    if (segments.length === 0 && method === 'GET') {
      sendJson(res, 200, { functions: listGevFunctions() });
      return;
    }
    if (segments.length === 1 && segments[0] === 'docs' && method === 'GET') {
      sendJson(res, 200, gevApiDocumentation({ origin, mcpEndpoint: '/api/admin/mcp' }));
      return;
    }
    if (segments.length === 1 && method === 'POST') {
      const name = segments[0];
      let args = {};
      try {
        args = await readJsonBody(req);
      } catch (error) {
        sendJson(res, error.status || 400, { error: { kind: 'invalid', message: error.message } });
        return;
      }
      const checked = validatePublicToolCall('execute', name, args);
      if (!checked.ok) {
        sendJson(res, 400, { error: { kind: 'invalid', message: checked.reason } });
        return;
      }
      if (typeof commandRuntime?.enqueueTool !== 'function') {
        sendJson(res, 503, { error: { kind: 'unavailable', message: 'GEV action runtime is not ready' } });
        return;
      }
      const binding = typeof getBinding === 'function' ? (getBinding() || {}) : {};
      const result = await commandRuntime.enqueueTool({
        name: checked.name,
        args: checked.arguments,
        source: 'api',
      }, binding);
      if (!result?.ok) {
        const status = result?.error?.kind === 'offline' ? 409 : 400;
        sendJson(res, status, { error: result?.error || { kind: 'failed', message: 'Action was not queued' } });
        return;
      }
      sendJson(res, 202, {
        ok: true,
        path: `${GEV_API_PREFIX}/${checked.name}`,
        command: result.command,
      });
      return;
    }

    sendJson(res, method === 'GET' || method === 'HEAD' ? 404 : 405, {
      error: { kind: 'not-found', message: 'Cloud Computer AI.com API route not found' },
    });
  };
}
