/**
 * Native Replit Login for the ADMIN console.
 *
 * The browser is redirected to Replit's OIDC provider. PKCE, state, and nonce
 * are kept in a short-lived encrypted HttpOnly cookie; the resulting ADMIN
 * session is also encrypted and never exposed to page JavaScript.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import * as openid from 'openid-client';
import { parseCookies } from './adminAuth.js';

export const REPLIT_AUTH_FLOW_COOKIE = 'gev_replit_auth_flow';
export const REPLIT_ADMIN_SESSION_COOKIE = 'gev_admin_session';
export const REPLIT_AUTH_FLOW_TTL_MS = 10 * 60 * 1000;
export const REPLIT_ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

function cookie(name, value, maxAgeSeconds, secure, sameSite = 'Lax') {
  return [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    `SameSite=${sameSite}`,
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
    secure ? 'Secure' : '',
  ].filter(Boolean).join('; ');
}

function secureCookieFor(req) {
  const host = String(req.headers?.host || '').split(':')[0].toLowerCase();
  const forwarded = String(req.headers?.['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  return forwarded === 'https' || !['localhost', '127.0.0.1', '::1'].includes(host);
}

function keyFrom(secret) {
  return createHash('sha256').update(String(secret)).digest();
}

export function sealAuthPayload(payload, secret, entropy = randomBytes) {
  const iv = entropy(12);
  const cipher = createCipheriv('aes-256-gcm', keyFrom(secret), iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final(),
  ]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString('base64url')).join('.');
}

export function openAuthPayload(value, secret) {
  try {
    const [ivText, tagText, bodyText, extra] = String(value || '').split('.');
    if (!ivText || !tagText || !bodyText || extra) return null;
    const decipher = createDecipheriv('aes-256-gcm', keyFrom(secret), Buffer.from(ivText, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
    const clear = Buffer.concat([
      decipher.update(Buffer.from(bodyText, 'base64url')),
      decipher.final(),
    ]);
    return JSON.parse(clear.toString('utf8'));
  } catch {
    return null;
  }
}

export function safeReturnTo(value) {
  const text = String(value || '/?admin=1');
  return text.startsWith('/') && !text.startsWith('//') && !text.includes('\\')
    ? text
    : '/?admin=1';
}

function requestOrigin(req, allowedHosts) {
  const host = String(req.headers?.['x-forwarded-host'] || req.headers?.host || '').split(',')[0].trim();
  if (!allowedHosts.has(host)) throw Object.assign(new Error('Unrecognized Replit application host'), { status: 400 });
  const forwarded = String(req.headers?.['x-forwarded-proto'] || '').split(',')[0].trim();
  const protocol = forwarded === 'https' || secureCookieFor(req) ? 'https' : 'http';
  return `${protocol}://${host}`;
}

function writeError(res, status, message) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(message);
}

/**
 * @param {object} [options]
 * @returns Native Replit Auth facade for `createAdminMiddleware`.
 */
export function createReplitAdminAuth({
  env = process.env,
  oidc = openid,
  now = () => Date.now(),
  entropy = randomBytes,
} = {}) {
  const clientId = String(env.REPL_ID || '');
  const secret = String(env.SESSION_SECRET || '');
  const issuer = String(env.ISSUER_URL || 'https://replit.com/oidc');
  const allowedHosts = new Set(
    [env.REPLIT_DOMAINS, env.REPLIT_DEV_DOMAIN]
      .filter(Boolean)
      .flatMap((entry) => String(entry).split(','))
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
  const allowedSubjects = new Set(
    [env.REPL_OWNER_ID, env.ADMIN_REPLIT_USER_IDS]
      .filter(Boolean)
      .flatMap((entry) => String(entry).split(','))
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
  const configured = Boolean(clientId && secret && allowedHosts.size && allowedSubjects.size);
  let configPromise;

  function config() {
    if (!configPromise) configPromise = oidc.discovery(new URL(issuer), clientId);
    return configPromise;
  }

  function authenticate(req) {
    if (!configured) return null;
    const value = parseCookies(req.headers?.cookie)[REPLIT_ADMIN_SESSION_COOKIE];
    const session = openAuthPayload(value, secret);
    if (!session || session.expiresAt <= now() || !allowedSubjects.has(String(session.sub))) return null;
    return session;
  }

  async function login(req, res, returnTo) {
    if (!configured) return writeError(res, 503, 'Replit Login is not configured for this ADMIN console.');
    try {
      const origin = requestOrigin(req, allowedHosts);
      const verifier = oidc.randomPKCECodeVerifier();
      const challenge = await oidc.calculatePKCECodeChallenge(verifier);
      const flow = {
        state: oidc.randomState(),
        nonce: oidc.randomNonce(),
        verifier,
        returnTo: safeReturnTo(returnTo),
        host: new URL(origin).host,
        expiresAt: now() + REPLIT_AUTH_FLOW_TTL_MS,
      };
      const redirect = oidc.buildAuthorizationUrl(await config(), {
        redirect_uri: `${origin}/api/admin/callback`,
        scope: 'openid email profile offline_access',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state: flow.state,
        nonce: flow.nonce,
        prompt: 'login consent',
      });
      res.setHeader('Set-Cookie', cookie(
        REPLIT_AUTH_FLOW_COOKIE,
        sealAuthPayload(flow, secret, entropy),
        REPLIT_AUTH_FLOW_TTL_MS / 1000,
        secureCookieFor(req),
      ));
      res.statusCode = 302;
      res.setHeader('Location', redirect.href);
      res.setHeader('Cache-Control', 'no-store');
      res.end();
    } catch (error) {
      writeError(res, error?.status || 502, 'Unable to start Replit Login.');
    }
  }

  async function callback(req, res) {
    if (!configured) return writeError(res, 503, 'Replit Login is not configured for this ADMIN console.');
    const secure = secureCookieFor(req);
    try {
      const origin = requestOrigin(req, allowedHosts);
      const flowValue = parseCookies(req.headers?.cookie)[REPLIT_AUTH_FLOW_COOKIE];
      const flow = openAuthPayload(flowValue, secret);
      if (!flow || flow.expiresAt <= now() || flow.host !== new URL(origin).host) {
        return writeError(res, 400, 'Replit Login request expired. Please try again.');
      }
      const currentUrl = new URL(`/api/admin/callback${new URL(String(req.url || '/'), 'http://internal').search}`, origin);
      const tokens = await oidc.authorizationCodeGrant(await config(), currentUrl, {
        pkceCodeVerifier: flow.verifier,
        expectedState: flow.state,
        expectedNonce: flow.nonce,
      });
      const claims = tokens.claims();
      const subject = String(claims?.sub || '');
      if (!subject || !allowedSubjects.has(subject)) {
        res.setHeader('Set-Cookie', cookie(REPLIT_AUTH_FLOW_COOKIE, '', 0, secure));
        return writeError(res, 403, 'This Replit account is not authorized for ADMIN.');
      }
      const expiresAt = Math.min(
        now() + REPLIT_ADMIN_SESSION_TTL_MS,
        Number(claims.exp || 0) * 1000 || Number.POSITIVE_INFINITY,
      );
      const session = {
        sub: subject,
        username: String(claims.username || claims.preferred_username || ''),
        expiresAt,
      };
      res.setHeader('Set-Cookie', [
        cookie(REPLIT_ADMIN_SESSION_COOKIE, sealAuthPayload(session, secret, entropy), REPLIT_ADMIN_SESSION_TTL_MS / 1000, secure, 'Strict'),
        cookie(REPLIT_AUTH_FLOW_COOKIE, '', 0, secure),
      ]);
      res.statusCode = 302;
      res.setHeader('Location', safeReturnTo(flow.returnTo));
      res.setHeader('Cache-Control', 'no-store');
      res.end();
    } catch {
      writeError(res, 401, 'Replit Login could not be verified. Please try again.');
    }
  }

  function logout(req, res) {
    res.setHeader('Set-Cookie', cookie(REPLIT_ADMIN_SESSION_COOKIE, '', 0, secureCookieFor(req), 'Strict'));
  }

  return {
    configured,
    authenticate,
    login,
    callback,
    logout,
  };
}