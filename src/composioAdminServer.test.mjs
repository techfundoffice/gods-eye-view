import assert from 'node:assert/strict';
import test from 'node:test';
import {
  COMPOSIO_MAX_ACCOUNTS,
  createComposioAdminService,
  parseComposioToolAllowlist,
  publicComposioTool,
} from './composioAdminServer.js';

function response(body, { status = 200 } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('the configured tool allowlist is normalized, deduplicated, and rejects arbitrary names', () => {
  assert.deepEqual(
    parseComposioToolAllowlist(' github_get_me, GITHUB_GET_ME, bad slug, SHELL '),
    ['GITHUB_GET_ME', 'SHELL'],
  );
});

test('public tool metadata is bounded and excludes scopes, auth state, and output data', () => {
  const tool = publicComposioTool({
    slug: 'GITHUB_GET_ME',
    name: 'Get profile',
    description: 'safe',
    scopes: ['repo'],
    output_parameters: { token: 'secret' },
    input_parameters: {
      owner: { type: 'string', description: 'owner', required: true },
    },
    toolkit: { slug: 'github', logo: 'https://example.invalid/private' },
  });
  assert.equal(tool.capabilityId, 'composio:GITHUB_GET_ME');
  assert.equal(tool.inputParameters.owner.required, true);
  assert.equal(tool.scopes, undefined);
  assert.equal(tool.output_parameters, undefined);
  assert.equal(JSON.stringify(tool).includes('secret'), false);
});

test('an absent server credential is an explicit unconfigured state without an upstream call', async () => {
  let calls = 0;
  const service = createComposioAdminService({
    apiKey: '',
    allowedTools: ['GITHUB_GET_ME'],
    fetchImpl: async () => { calls += 1; },
  });
  assert.deepEqual(await service.status(), {
    configured: false,
    state: 'unconfigured',
    health: 'not-configured',
    accounts: [],
    tools: [],
    capabilities: ['composio:GITHUB_GET_ME'],
  });
  assert.equal(calls, 0);
});

test('status sends the secret only in the upstream header and returns bounded redacted metadata', async () => {
  const secret = 'composio-secret-key';
  const calls = [];
  const accounts = Array.from({ length: COMPOSIO_MAX_ACCOUNTS + 5 }, (_, index) => ({
    id: `account-${index}`,
    toolkit: { slug: 'github' },
    status: 'ACTIVE',
    alias: `alias-${index}`,
    state: { access_token: secret },
  }));
  const service = createComposioAdminService({
    apiKey: secret,
    allowedTools: ['GITHUB_GET_ME'],
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      if (String(url).includes('/connected_accounts')) return response({ items: accounts });
      return response({ items: [{
        slug: 'GITHUB_GET_ME',
        name: 'Get profile',
        toolkit: { slug: 'github' },
        version: '20260101_00',
        input_parameters: {},
      }] });
    },
  });
  const status = await service.status();
  assert.equal(status.state, 'connected');
  assert.equal(status.accounts.length, COMPOSIO_MAX_ACCOUNTS);
  assert.equal(status.tools.length, 1);
  assert.equal(calls.every((call) => call.options.headers['x-api-key'] === secret), true);
  assert.equal(JSON.stringify(status).includes(secret), false);
  assert.equal(calls.some((call) => call.url.includes(`limit=${COMPOSIO_MAX_ACCOUNTS}`)), true);
});

test('malformed and failed upstream responses become explicit safe errors', async () => {
  const malformed = createComposioAdminService({
    apiKey: 'secret',
    allowedTools: [],
    fetchImpl: async () => response({ not_items: [] }),
  });
  await assert.rejects(() => malformed.status(), (error) => error.kind === 'malformed' && error.status === 502);

  const rejected = createComposioAdminService({
    apiKey: 'secret',
    allowedTools: [],
    fetchImpl: async () => response({ error: 'credential secret leaked' }, { status: 401 }),
  });
  await assert.rejects(() => rejected.status(), (error) => {
    assert.equal(error.kind, 'authentication');
    assert.equal(error.message.includes('credential secret leaked'), false);
    return true;
  });
});

test('validation and execution reject tools outside the server allowlist', async () => {
  const service = createComposioAdminService({
    apiKey: 'secret',
    allowedTools: ['GITHUB_GET_ME'],
    fetchImpl: async (url) => {
      if (String(url).includes('/tools')) return response({ items: [{
        slug: 'GITHUB_GET_ME',
        name: 'Get profile',
        toolkit: { slug: 'github' },
        input_parameters: {},
      }] });
      return response({ items: [] });
    },
  });
  await assert.rejects(
    () => service.validate({ capabilityId: 'composio:GITHUB_DELETE_REPO', arguments: {} }),
    (error) => error.kind === 'not-allowed' && error.status === 403,
  );
});

test('validation checks required and unknown inputs without executing an action', async () => {
  let executeCalls = 0;
  const service = createComposioAdminService({
    apiKey: 'secret',
    allowedTools: ['GITHUB_GET_REPO'],
    fetchImpl: async (url) => {
      if (String(url).includes('/tools/execute/')) executeCalls += 1;
      return response({ items: [{
        slug: 'GITHUB_GET_REPO',
        name: 'Get repository',
        toolkit: { slug: 'github' },
        input_parameters: { repo: { type: 'string', required: true } },
      }] });
    },
  });
  await assert.rejects(
    () => service.validate({ capabilityId: 'composio:GITHUB_GET_REPO', arguments: {} }),
    /Required input is missing/,
  );
  await assert.rejects(
    () => service.validate({ capabilityId: 'composio:GITHUB_GET_REPO', arguments: { repo: 'x', shell: 'rm' } }),
    /Input is not allowed/,
  );
  const valid = await service.validate({
    capabilityId: 'composio:GITHUB_GET_REPO',
    arguments: { repo: 'owner/repo' },
  });
  assert.equal(valid.ok, true);
  assert.equal(executeCalls, 0);
});

test('execution requires a matching account and redacts bounded upstream output', async () => {
  const secret = 'must-not-cross';
  const service = createComposioAdminService({
    apiKey: 'server-key',
    allowedTools: ['GITHUB_GET_ME'],
    fetchImpl: async (url, options) => {
      const href = String(url);
      if (href.includes('/connected_accounts')) return response({ items: [{
        id: 'account-1',
        toolkit: { slug: 'github' },
        status: 'ACTIVE',
      }] });
      if (href.includes('/tools/execute/')) {
        assert.deepEqual(JSON.parse(options.body), {
          arguments: {},
          connected_account_id: 'account-1',
          version: '20260101_00',
        });
        return response({
          successful: true,
          success: true,
          data: { login: 'octocat', access_token: secret, nested: { password: secret } },
        });
      }
      return response({ items: [{
        slug: 'GITHUB_GET_ME',
        name: 'Get profile',
        toolkit: { slug: 'github' },
        version: '20260101_00',
        input_parameters: {},
      }] });
    },
  });

  await assert.rejects(
    () => service.execute({
      capabilityId: 'composio:GITHUB_GET_ME',
      arguments: {},
      connectedAccountId: 'other-account',
    }),
    /Choose an active connected account/,
  );
  const result = await service.execute({
    capabilityId: 'composio:GITHUB_GET_ME',
    arguments: {},
    connectedAccountId: 'account-1',
  });
  assert.equal(result.ok, true);
  assert.equal(result.result, undefined);
  assert.equal(result.executionId, null);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('oversized upstream responses are rejected before JSON parsing', async () => {
  const service = createComposioAdminService({
    apiKey: 'server-key',
    allowedTools: [],
    fetchImpl: async () => new Response(JSON.stringify({
      items: [],
      padding: 'x'.repeat(600 * 1024),
    }), { status: 200 }),
  });
  await assert.rejects(
    () => service.status(),
    (error) => error.kind === 'response-too-large' && error.status === 502,
  );
});