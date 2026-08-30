/**
 * `/api/admin` — the ADMIN console's server surface.
 *
 * Three groups of routes live here:
 *
 *   - Session: `GET /session`, native `GET /login` + `GET /callback`, and
 *     `POST /logout`.
 *   - Plugin builder: `GET|POST /plugins`, `GET /plugins/:id`,
 *     `POST /plugins/:id/messages`, `POST /plugins/:id/cancel`, and `GET /menu`
 *     for the generated plugins the dashboard should load.
 *   - MCP settings: `GET|POST /mcp/settings`, `POST /mcp/keys`,
 *     `DELETE /mcp/keys/:id`, and the external `POST /mcp` JSON-RPC endpoint.
 *   - Live stream: `GET /live`, `GET /live/broadcasts`, `POST /live/provision`,
 *     `POST /live/select`, `POST /live/start`, `POST /live/stop`.
 *
 * Everything except `POST /mcp` requires the admin session cookie; `POST /mcp`
 * requires an API key instead and is refused outright while the MCP setting is
 * off. With no configured native login, every route reports `unconfigured`
 * and does nothing — the console cannot be opened by omission.
 *
 * @module adminServer
 */

import {
  ADMIN_SESSION_COOKIE,
  ADMIN_SESSION_TTL_MS,
  createAdminAuth,
  extractApiKey,
  parseCookies,
  serializeAdminCookie,
} from './adminAuth.js';
import { createAdminMcpServer } from './adminMcpServer.js';
import { createPluginBuilder, readPluginManifest } from './adminPluginBuilder.js';
import { normalizePluginManifest } from './adminPluginRegistry.js';
import { createAdminStore } from './adminStore.js';
import { createLiveSessionController } from './liveSession.js';
import { youtubeLiveOperatorMessage } from './youtubeBroadcast.js';

/** Largest admin request body accepted, in bytes. */
export const ADMIN_MAX_BODY_BYTES = 256 * 1024;
/**
 * Browser callers must send this header. It is unforgeable by a plain
 * cross-origin form post, so together with the SameSite=Strict cookie it
 * closes CSRF against routes that can rewrite the codebase.
 */
export const ADMIN_REQUEST_HEADER = 'x-gev-admin';

/**
 * Split a mounted request URL into its path segments and query.
 *
 * @param {string} url Request URL as seen after the `/api/admin` mount.
 * @returns {{segments: string[], query: URLSearchParams}}
 */
export function parseAdminRoute(url) {
  const parsed = new URL(String(url || '/'), 'http://internal');
  const segments = parsed.pathname.split('/').filter(Boolean);
  return { segments, query: parsed.searchParams };
}

/**
 * Whether the deployment should mark cookies `Secure`.
 *
 * A plain-HTTP localhost checkout must still be able to log in, but any other
 * host — or anything behind an HTTPS proxy — gets the Secure flag.
 *
 * @param {object} req Node request.
 * @returns {boolean}
 */
export function requiresSecureCookie(req) {
  const authority = String(req?.headers?.host || '').trim();
  let host = '';
  try {
    host = new URL(`http://${authority}`).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    host = '';
  }
  const forwardedProto = String(req?.headers?.['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  const local = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  return forwardedProto === 'https' || !local;
}

/**
 * @param {object} res Node response.
 * @param {number} status
 * @param {object} payload
 * @returns {void}
 */
export function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.end(body);
}

/**
 * Read and JSON-parse a bounded request body.
 *
 * @param {object} req Node request.
 * @param {number} [limit] Byte ceiling.
 * @returns {Promise<object>} Parsed object; `{}` for an empty body.
 */
export function readJsonBody(req, limit = ADMIN_MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('Request body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
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
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        reject(Object.assign(new Error('Body must be JSON'), { status: 400 }));
      }
    });
  });
}

/**
 * Build the `/api/admin` middleware.
 *
 * @param {object} [options]
 * @param {object} [options.auth] Auth facade; defaults to env-configured.
 * @param {object|null} [options.replitAuth] Native Replit Login facade.
 * @param {object} [options.builder] Plugin builder; defaults to a real one.
 * @param {object} [options.store] Durable admin state.
 * @param {Function} [options.readManifest] Reads the generated-plugin manifest.
 * @param {string} [options.version] Version reported over MCP.
 * @returns {(req: object, res: object, next: Function) => void}
 */
export function createAdminMiddleware({
  store = createAdminStore(),
  auth = createAdminAuth({ store }),
  replitAuth = null,
  builder = createPluginBuilder(),
  live = createLiveSessionController(),
  youtubeAuth = { authorizeRequest: async () => null, proxy: null },
  readManifest = readPluginManifest,
  version = '1.0.0',
} = {}) {
  const mcp = createAdminMcpServer({ builder, version });

  /**
   * @param {object} req
   * @returns {object|null} Live session, or null.
   */
  function sessionFor(req) {
    if (replitAuth) {
      const session = replitAuth.authenticate(req);
      if (session) return session;
    }
    if (!auth.configured) return null;
    const cookies = parseCookies(req.headers?.cookie);
    return auth.authenticate(cookies[ADMIN_SESSION_COOKIE]);
  }

  const operatorConfigured = () => Boolean((replitAuth && replitAuth.configured) || auth.configured);

  /**
   * @param {object} req
   * @returns {string} Rate-limit bucket for login attempts.
   */
  function clientId(req) {
    const forwarded = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
    return forwarded || req.socket?.remoteAddress || 'unknown';
  }

  /**
   * Public view of the console's configuration and the caller's status.
   *
   * @param {object} req
   * @returns {object}
   */
  function sessionState(req) {
    const session = sessionFor(req);
    return {
      configured: operatorConfigured(),
      authenticated: Boolean(session),
      expiresAt: session ? new Date(session.expiresAt).toISOString() : null,
      username: session?.username || null,
      mcpEnabled: auth.mcpEnabled(),
      agentCommand: builder.command,
    };
  }

  /**
   * @returns {object} MCP settings view for the console.
   */
  function mcpSettings() {
    return {
      enabled: auth.mcpEnabled(),
      endpoint: '/api/admin/mcp',
      transport: 'http-json-rpc',
      keys: auth.listApiKeys(),
    };
  }

  /**
   * The external MCP endpoint. Authenticated by API key, never by cookie.
   *
   * @param {object} req
   * @param {object} res
   * @returns {Promise<void>}
   */
  async function handleMcp(req, res) {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: { kind: 'method', message: 'MCP endpoint accepts POST only' } });
      return;
    }
    if (!operatorConfigured()) {
      sendJson(res, 503, { error: { kind: 'unconfigured', message: 'Admin console is not configured' } });
      return;
    }
    if (!auth.mcpEnabled()) {
      sendJson(res, 403, { error: { kind: 'disabled', message: 'MCP server is switched off in ADMIN settings' } });
      return;
    }
    const key = auth.verifyApiKey(extractApiKey(req.headers || {}));
    if (!key) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="gev-admin"');
      sendJson(res, 401, { error: { kind: 'auth', message: 'Valid admin API key required' } });
      return;
    }
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      sendJson(res, error.status || 400, { error: { kind: 'body', message: error.message } });
      return;
    }
    // A batch is a JSON array; notifications inside it produce no response.
    if (Array.isArray(body)) {
      const responses = (await Promise.all(body.map((entry) => mcp.handle(entry)))).filter(Boolean);
      if (!responses.length) {
        res.statusCode = 204;
        res.end();
        return;
      }
      sendJson(res, 200, responses);
      return;
    }
    const response = await mcp.handle(body);
    if (!response) {
      res.statusCode = 204;
      res.end();
      return;
    }
    sendJson(res, 200, response);
  }

  /**
   * @param {object} res
   * @param {object|null} authorization
   * @returns {boolean} True when the response was already sent.
   */
  function rejectYoutubeWrite(res, authorization) {
    if (!authorization) {
      sendJson(res, 401, {
        error: {
          kind: 'authentication',
          message: youtubeLiveOperatorMessage('authentication'),
        },
      });
      return true;
    }
    if (authorization.canWrite === false) {
      sendJson(res, 403, {
        error: {
          kind: 'insufficient-scope',
          message: youtubeLiveOperatorMessage('insufficient-scope'),
        },
      });
      return true;
    }
    return false;
  }

  /**
   * @param {object} res
   * @param {Error} error
   * @returns {void}
   */
  function sendYoutubeLiveError(res, error) {
    const kind = error?.kind || 'invalid';
    let status = Number(error?.status);
    if (!Number.isFinite(status) || status < 400) {
      status = {
        authentication: 401,
        'insufficient-scope': 403,
        quota: 403,
        incompatible: 409,
        'not-found': 404,
        invalid: 400,
        'invalid-request': 400,
        upstream: 502,
      }[kind] || 400;
    }
    sendJson(res, status, {
      error: {
        kind,
        message: youtubeLiveOperatorMessage(kind, error?.message || 'YouTube live-control request failed.'),
      },
    });
  }

  return async function adminMiddleware(req, res, next) {
    const { segments, query } = parseAdminRoute(req.url);
    const [first, second, third] = segments;

    try {
      if (first === 'mcp' && segments.length === 1) {
        await handleMcp(req, res);
        return;
      }

      if (replitAuth && first === 'login' && req.method === 'GET') {
        await replitAuth.login(req, res, query.get('returnTo'));
        return;
      }

      if (replitAuth && first === 'callback' && req.method === 'GET') {
        await replitAuth.callback(req, res);
        return;
      }

      if (!operatorConfigured()) {
        sendJson(res, 503, {
          error: {
            kind: 'unconfigured',
            message: replitAuth
              ? 'Native Replit Login is not configured for this ADMIN console.'
              : 'Set ADMIN_PASSWORD_HASH (or ADMIN_PASSWORD) and restart to enable the ADMIN console.',
          },
          configured: false,
        });
        return;
      }

      // Cross-origin form posts cannot set a custom header; requiring one keeps
      // a logged-in browser from being driven by another site.
      const mutating = req.method !== 'GET' && req.method !== 'HEAD';
      if (mutating && !req.headers?.[ADMIN_REQUEST_HEADER]) {
        sendJson(res, 403, { error: { kind: 'csrf', message: `Missing ${ADMIN_REQUEST_HEADER} header` } });
        return;
      }

      if (first === 'session' && req.method === 'GET') {
        sendJson(res, 200, sessionState(req));
        return;
      }

      if (first === 'login' && req.method === 'POST') {
        if (!auth.configured) {
          sendJson(res, 405, {
            error: {
              kind: 'method',
              message: replitAuth?.configured
                ? 'Use native Replit Login.'
                : 'Admin password is not configured.',
            },
          });
          return;
        }
        const body = await readJsonBody(req);
        const result = auth.login(String(body.password ?? ''), { clientId: clientId(req) });
        if (!result.ok) {
          const status = result.reason === 'throttled' ? 429 : 401;
          if (result.retryAfterMs) {
            res.setHeader('Retry-After', String(Math.ceil(result.retryAfterMs / 1000)));
          }
          sendJson(res, status, {
            error: {
              kind: result.reason,
              message: result.reason === 'throttled'
                ? 'Too many failed attempts. Wait before trying again.'
                : 'Incorrect admin password.',
              retryAfterMs: result.retryAfterMs || 0,
            },
          });
          return;
        }
        res.setHeader('Set-Cookie', serializeAdminCookie(
          result.sessionId,
          ADMIN_SESSION_TTL_MS / 1000,
          requiresSecureCookie(req),
        ));
        // The request that carried the password has no session cookie on it
        // yet, so the caller is described from the session just minted rather
        // than from `sessionState`, which would report them still signed out.
        sendJson(res, 200, {
          ...sessionState(req),
          authenticated: true,
          expiresAt: new Date(result.expiresAt ?? Date.now() + ADMIN_SESSION_TTL_MS).toISOString(),
        });
        return;
      }

      if (first === 'logout' && req.method === 'POST') {
        if (replitAuth) {
          replitAuth.logout(req, res);
          sendJson(res, 200, { configured: true, authenticated: false, mcpEnabled: auth.mcpEnabled() });
          return;
        }
        const cookies = parseCookies(req.headers?.cookie);
        auth.logout(cookies[ADMIN_SESSION_COOKIE]);
        res.setHeader('Set-Cookie', serializeAdminCookie('', 0, requiresSecureCookie(req)));
        sendJson(res, 200, { configured: true, authenticated: false, mcpEnabled: auth.mcpEnabled() });
        return;
      }

      // Everything past this point is operator-only.
      if (!sessionFor(req)) {
        sendJson(res, 401, {
          error: { kind: 'auth', message: 'Admin sign-in required' },
          configured: true,
          authenticated: false,
        });
        return;
      }

      // The generated-plugin menu. Read fresh from disk on every request so a
      // build that just finished shows up without restarting the dev server.
      if (first === 'menu' && segments.length === 1 && req.method === 'GET') {
        sendJson(res, 200, { plugins: normalizePluginManifest(readManifest()) });
        return;
      }

      if (first === 'plugins') {
        if (segments.length === 1 && req.method === 'GET') {
          sendJson(res, 200, { plugins: builder.list() });
          return;
        }
        if (segments.length === 1 && req.method === 'POST') {
          const body = await readJsonBody(req);
          try {
            sendJson(res, 202, { plugin: builder.start({
              name: String(body.name ?? ''),
              instructions: String(body.instructions ?? ''),
            }) });
          } catch (error) {
            sendJson(res, 400, { error: { kind: 'name', message: error?.message || 'Invalid plugin name' } });
          }
          return;
        }
        if (segments.length === 2 && req.method === 'GET') {
          const job = builder.get(second);
          if (!job) {
            sendJson(res, 404, { error: { kind: 'missing', message: 'No such plugin build' } });
            return;
          }
          sendJson(res, 200, { plugin: job });
          return;
        }
        if (segments.length === 3 && third === 'messages' && req.method === 'POST') {
          const body = await readJsonBody(req);
          const job = builder.send(second, String(body.message ?? ''));
          if (!job) {
            sendJson(res, 404, { error: { kind: 'missing', message: 'No such plugin build' } });
            return;
          }
          sendJson(res, 202, { plugin: job });
          return;
        }
        if (segments.length === 3 && third === 'cancel' && req.method === 'POST') {
          sendJson(res, 200, { stopped: builder.cancel(second) });
          return;
        }
      }

      if (first === 'live') {
        const authorization = typeof youtubeAuth?.authorizeRequest === 'function'
          ? await youtubeAuth.authorizeRequest(req)
          : null;
        if (typeof live.bindAuth === 'function') {
          live.bindAuth(authorization, youtubeAuth?.proxy);
        }

        if (segments.length === 1 && req.method === 'GET') {
          sendJson(res, 200, { live: live.status() });
          return;
        }

        if (segments.length === 2 && second === 'broadcasts' && req.method === 'GET') {
          if (rejectYoutubeWrite(res, authorization)) return;
          try {
            sendJson(res, 200, { broadcasts: await live.listBroadcasts() });
          } catch (error) {
            sendYoutubeLiveError(res, error);
          }
          return;
        }

        if (segments.length === 2 && second === 'provision' && req.method === 'POST') {
          if (rejectYoutubeWrite(res, authorization)) return;
          const body = await readJsonBody(req);
          try {
            const result = await live.provision({
              title: body.title,
              description: body.description,
              privacyStatus: body.privacyStatus,
            });
            sendJson(res, 201, result);
          } catch (error) {
            sendYoutubeLiveError(res, error);
          }
          return;
        }

        if (segments.length === 2 && second === 'select' && req.method === 'POST') {
          if (rejectYoutubeWrite(res, authorization)) return;
          const body = await readJsonBody(req);
          try {
            const result = await live.select({ broadcastId: body.broadcastId });
            sendJson(res, 200, result);
          } catch (error) {
            sendYoutubeLiveError(res, error);
          }
          return;
        }

        if (segments.length === 2 && second === 'start' && req.method === 'POST') {
          const body = await readJsonBody(req);
          try {
            const result = typeof live.start === 'function'
              ? await live.start(body, { authorization, proxy: youtubeAuth?.proxy, req })
              : await live.start(body);
            // A refused or failed start is reported in the payload, not as a
            // transport error: the console renders the log either way.
            sendJson(res, result.status === 'error' ? 502 : 202, { live: result });
          } catch (error) {
            sendJson(res, error?.status === 409 ? 409 : (error?.status || 400), {
              error: {
                kind: error?.kind || (error?.status === 409 ? 'conflict' : 'invalid'),
                message: error?.message || 'Unable to start the broadcast',
              },
              live: live.status(),
            });
          }
          return;
        }
        if (segments.length === 2 && second === 'stop' && req.method === 'POST') {
          sendJson(res, 200, { live: await live.stop() });
          return;
        }
      }

      if (first === 'mcp' && second === 'settings') {
        if (req.method === 'GET') {
          sendJson(res, 200, mcpSettings());
          return;
        }
        if (req.method === 'POST') {
          const body = await readJsonBody(req);
          auth.setMcpEnabled(Boolean(body.enabled));
          sendJson(res, 200, mcpSettings());
          return;
        }
      }

      if (first === 'mcp' && second === 'keys') {
        if (segments.length === 2 && req.method === 'POST') {
          const body = await readJsonBody(req);
          const { token, record } = auth.createApiKey(body.label);
          // The only time the plaintext key is ever transmitted.
          sendJson(res, 201, { key: record, token });
          return;
        }
        if (segments.length === 3 && req.method === 'DELETE') {
          sendJson(res, 200, { revoked: auth.revokeApiKey(third), ...mcpSettings() });
          return;
        }
      }

      sendJson(res, 404, { error: { kind: 'route', message: 'Unknown admin route' } });
    } catch (error) {
      if (res.writableEnded) return;
      const status = error?.status || 500;
      sendJson(res, status, { error: { kind: 'server', message: error?.message || 'Admin request failed' } });
      if (status >= 500) next?.(error);
    }
  };

}
