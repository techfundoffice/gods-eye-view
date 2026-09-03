import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createFilePublicCommandLedger } from './youtubePublicCommandLedger.js';
import { createYoutubePublicCommandCoordinator } from './youtubePublicCommandCoordinator.js';
import { createPublicResponsesInterpreter } from './youtubePublicResponsesInterpreter.js';
import { PUBLIC_COMMAND_LIMITS, validatePublicToolCall } from './youtubePublicCommandPolicy.js';
import { createYoutubeLiveChatPoster } from './hermesYoutubeReply.js';

export const PUBLIC_EXECUTOR_HEADER = 'x-gev-capture-executor';
export const PUBLIC_EXECUTOR_ROUTE = '/api/youtube/homepage-chat/executor';

const terminal = new Set(['succeeded', 'rejected', 'failed', 'cancelled']);
const bounded = (value, max = 160) => String(value ?? '')
  .replace(/[\u0000-\u001f\u007f]/g, ' ')
  .trim()
  .slice(0, max);

function digest(value) {
  return createHash('sha256').update(String(value || '')).digest();
}

function safeEqual(left, right) {
  const a = digest(left);
  const b = Buffer.isBuffer(right) ? right : digest(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(body);
}

function readJson(req, maxBytes = 8_000) {
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
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(Object.assign(new Error('Request must be JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function isLoopback(req) {
  const address = String(req?.socket?.remoteAddress || '');
  const forwarded = String(req?.headers?.['x-forwarded-for'] || req?.headers?.forwarded || '').trim();
  const rawHost = String(req?.headers?.host || '').trim();
  let host = '';
  try {
    host = new URL(`http://${rawHost}`).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return false;
  }
  return !forwarded
    && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address)
    && ['127.0.0.1', 'localhost', '::1'].includes(host);
}

function publicRecord(record) {
  return {
    id: bounded(record?.id),
    videoId: bounded(record?.videoId, 80),
    commentId: bounded(record?.commentId),
    generation: Number(record?.generation) || 0,
    viewer: bounded(record?.viewer, 80),
    authorHandle: bounded(record?.authorHandle, 80),
    command: bounded(record?.command, 32),
    mode: bounded(record?.mode, 32),
    state: bounded(record?.state, 32),
    reason: bounded(record?.reason, 160),
    answer: bounded(record?.answer, 1000),
    updatedAt: Number(record?.updatedAt || record?.createdAt) || 0,
  };
}

export function createYoutubePublicCommandRuntime({
  ledger = createFilePublicCommandLedger(),
  interpret = createPublicResponsesInterpreter(),
  now = Date.now,
  youtubePoster = null,
} = {}) {
  const coordinator = createYoutubePublicCommandCoordinator({ ledger, interpret, now });
  let executor = null;
  let poster = youtubePoster;

  async function rotateExecutor() {
    if (executor) await ledger.cancelNonterminal('Capture executor restarted');
    const credential = randomBytes(32).toString('base64url');
    executor = {
      id: randomUUID(),
      epoch: randomUUID(),
      credentialDigest: digest(credential),
      createdAt: now(),
    };
    return {
      executorId: executor.id,
      captureEpoch: executor.epoch,
      credential,
      routePrefix: PUBLIC_EXECUTOR_ROUTE,
      headerName: PUBLIC_EXECUTOR_HEADER,
    };
  }

  function currentExecutor() {
    return executor ? { executorId: executor.id, captureEpoch: executor.epoch } : null;
  }

  function authorized(req) {
    const supplied = String(req?.headers?.[PUBLIC_EXECUTOR_HEADER] || '');
    return Boolean(executor && isLoopback(req) && supplied && safeEqual(supplied, executor.credentialDigest));
  }

  function bindingWithExecutor(binding = {}) {
    return {
      videoId: bounded(binding.videoId || binding.broadcast?.id, 80),
      generation: Number(binding.generation) || 0,
      commandsEnabled: binding.commandsEnabled === true,
      captureExecutorId: executor?.id || '',
      captureEpoch: executor?.epoch || '',
    };
  }

  async function reconcileBinding(binding = {}) {
    const target = bindingWithExecutor(binding);
    const verified = target.commandsEnabled && target.videoId && target.captureExecutorId;
    const reason = verified ? 'Live video or generation changed' : 'Verified YouTube live session ended';
    if (typeof ledger.cancelWhere === 'function') {
      return ledger.cancelWhere((record) => !verified
        || record.videoId !== target.videoId
        || record.generation !== target.generation
        || record.captureExecutorId !== target.captureExecutorId, reason);
    }
    let count = 0;
    for (const record of await ledger.list()) {
      if (!terminal.has(record.state) && (!verified
        || record.videoId !== target.videoId
        || record.generation !== target.generation
        || record.captureExecutorId !== target.captureExecutorId)) {
        const cancelled = await ledger.compareAndSet(record.id, record.state, { state: 'cancelled', reason });
        if (cancelled.changed) count += 1;
      }
    }
    return count;
  }

  async function registerMessage(message, binding) {
    if (!binding?.commandsEnabled || !executor) return { recognized: false, disabled: true };
    return coordinator.register({
      commentId: message?.id || message?.commentId,
      text: message?.text,
      author: { displayName: message?.author, handle: message?.authorHandle },
      authorHandle: message?.authorHandle,
      agentMode: message?.agentMode,
      deferAgent: message?.deferAgent === true,
    }, bindingWithExecutor(binding));
  }

  async function enqueueTool({ name, args = {}, source = 'api' } = {}, binding = {}) {
    const target = bindingWithExecutor(binding);
    if (!target.commandsEnabled || !target.videoId || !executor) {
      return { ok: false, error: { kind: 'offline', message: 'Go live before running GEV actions.' } };
    }
    const checked = validatePublicToolCall('execute', name, args && typeof args === 'object' ? args : {});
    if (!checked.ok) return { ok: false, error: { kind: 'invalid', message: checked.reason } };
    const record = {
      id: randomUUID(),
      videoId: target.videoId,
      commentId: `${bounded(source, 32)}-${randomUUID()}`,
      generation: Number(target.generation) || 0,
      captureExecutorId: target.captureExecutorId,
      viewer: bounded(source, 80) || 'api',
      authorHandle: bounded(source, 80) || 'api',
      comment: bounded(checked.name, 160),
      command: 'viewer-request',
      mode: 'execute',
      state: 'awaiting-execution',
      nonce: randomUUID(),
      validatedTool: checked,
      remainingTurns: PUBLIC_COMMAND_LIMITS.modelTurns,
      remainingTools: Math.max(0, PUBLIC_COMMAND_LIMITS.toolCalls - 1),
      expiresAt: Date.now() + PUBLIC_COMMAND_LIMITS.totalMs,
    };
    const inserted = await ledger.insert(record);
    return { ok: true, command: publicRecord(inserted.record) };
  }

  async function statuses(binding = {}) {
    await reconcileBinding(binding);
    coordinator.tick?.();
    const target = bindingWithExecutor(binding);
    const rows = await ledger.list();
    return rows
      .filter((record) => record.videoId === target.videoId && record.generation === target.generation)
      .sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0))
      .slice(-20)
      .map(publicRecord);
  }

  async function nextLease(binding = {}) {
    await reconcileBinding(binding);
    const target = bindingWithExecutor(binding);
    if (!target.commandsEnabled) return null;
    const rows = await ledger.list();
    let record = rows.find((row) => row.state === 'awaiting-execution'
      && row.videoId === target.videoId
      && row.generation === target.generation
      && row.captureExecutorId === target.captureExecutorId);
    if (!record) {
      const received = rows.find((row) => row.state === 'received'
        && row.videoId === target.videoId
        && row.generation === target.generation
        && row.captureExecutorId === target.captureExecutorId
        && !(Number(row.holdUntil) > Date.now()));
      if (received) {
        const claimed = await ledger.compareAndSet(received.id, 'received', {
          state: 'interpreting',
          expiresAt: Date.now() + PUBLIC_COMMAND_LIMITS.totalMs,
          remainingTurns: PUBLIC_COMMAND_LIMITS.modelTurns,
          remainingTools: PUBLIC_COMMAND_LIMITS.toolCalls,
        });
        if (claimed.changed) {
          const advanced = await coordinator.advance(received.id, target);
          record = advanced.record?.state === 'awaiting-execution' ? advanced.record : null;
        }
      }
    }
    if (!record) return null;
    const claimed = await ledger.compareAndSet(record.id, 'awaiting-execution', {
      state: 'executing',
      captureEpoch: executor?.epoch || '',
      redeemedAt: now(),
    });
    if (!claimed.changed) return null;
    return {
      commandId: record.id,
      videoId: record.videoId,
      generation: record.generation,
      captureEpoch: executor.epoch,
      nonce: record.nonce,
      tool: record.validatedTool,
    };
  }

  async function nextViewerLease(binding = {}, viewContext = {}) {
    await reconcileBinding(binding);
    const target = bindingWithExecutor(binding);
    if (!target.commandsEnabled) return null;
    const rows = await ledger.list();
    let record = rows.find((row) => row.state === 'awaiting-execution'
      && row.videoId === target.videoId
      && row.generation === target.generation
      && row.captureExecutorId === target.captureExecutorId);
    if (!record) {
      const received = rows.find((row) => row.state === 'received'
        && row.videoId === target.videoId
        && row.generation === target.generation
        && row.captureExecutorId === target.captureExecutorId);
      if (received) {
        const claimed = await ledger.compareAndSet(received.id, 'received', {
          state: 'interpreting',
          expiresAt: Date.now() + PUBLIC_COMMAND_LIMITS.totalMs,
          remainingTurns: PUBLIC_COMMAND_LIMITS.modelTurns,
          remainingTools: PUBLIC_COMMAND_LIMITS.toolCalls,
        });
        if (claimed.changed) {
          const advanced = await coordinator.advance(
            received.id,
            target,
            null,
            viewContext,
          );
          record = advanced.record?.state === 'awaiting-execution' ? advanced.record : null;
        }
      }
    }
    if (!record) return null;
    const claimed = await ledger.compareAndSet(record.id, 'awaiting-execution', {
      state: 'executing',
      delivery: 'viewer',
      redeemedAt: now(),
    });
    if (!claimed.changed) return null;
    return {
      commandId: record.id,
      commentId: record.commentId,
      videoId: record.videoId,
      generation: record.generation,
      nonce: record.nonce,
      tool: record.validatedTool,
    };
  }

  function middleware({ getBinding = () => ({}) } = {}) {
    return async function publicExecutorMiddleware(req, res) {
      const parsed = new URL(String(req.url || '/'), 'http://internal');
      const isExecutorRoute = parsed.pathname.startsWith('/executor');
      const isViewerRoute = parsed.pathname.startsWith('/agent');
      if (!isExecutorRoute && !isViewerRoute) return false;
      if (isExecutorRoute && !authorized(req)) {
        sendJson(res, 403, { error: { kind: 'executor-auth', message: 'Trusted capture executor required.' } });
        return true;
      }
      const binding = getBinding() || {};
      try {
        if (req.method === 'GET' && parsed.pathname === '/executor/lease') {
          const lease = await nextLease(binding);
          sendJson(res, 200, { lease });
          return true;
        }
        if ((req.method === 'GET' || req.method === 'POST') && parsed.pathname === '/agent/lease') {
          const body = req.method === 'POST' ? await readJson(req) : {};
          const lease = await nextViewerLease(binding, body.viewContext);
          sendJson(res, 200, { lease });
          return true;
        }
        if (req.method === 'POST' && parsed.pathname === '/executor/result') {
          const body = await readJson(req);
          if (bounded(body.captureEpoch) !== executor?.epoch) {
            sendJson(res, 409, { error: { kind: 'stale-executor', message: 'Capture epoch changed.' } });
            return true;
          }
          const target = bindingWithExecutor(binding);
          if (!target.commandsEnabled) {
            await reconcileBinding(binding);
            sendJson(res, 409, { error: { kind: 'not-verified-live', message: 'Verified live session ended.' } });
            return true;
          }
          const accepted = await coordinator.acceptToolResult(
            bounded(body.commandId),
            target,
            body.result && typeof body.result === 'object' ? body.result : { ok: false, error: 'Invalid result' },
          );
          sendJson(res, accepted.ok ? 200 : 409, accepted);
          return true;
        }
        if (req.method === 'POST' && parsed.pathname === '/agent/result') {
          const body = await readJson(req);
          const target = bindingWithExecutor(binding);
          if (!target.commandsEnabled) {
            await reconcileBinding(binding);
            sendJson(res, 409, { error: { kind: 'not-verified-live', message: 'Verified live session ended.' } });
            return true;
          }
          const accepted = await coordinator.acceptViewerToolResult(
            bounded(body.commandId),
            target,
            body.nonce,
            body.result && typeof body.result === 'object' ? body.result : { ok: false, error: 'Invalid result' },
            body.viewContext,
          );
          sendJson(res, accepted.ok ? 200 : 409, accepted);
          return true;
        }
        sendJson(res, 405, { error: { kind: 'method', message: 'Executor route not found.' } });
        return true;
      } catch (error) {
        sendJson(res, error?.status || 500, {
          error: { kind: 'executor', message: bounded(error?.message || 'Executor request failed') },
        });
        return true;
      }
    };
  }

  return {
    rotateExecutor,
    currentExecutor,
    registerMessage,
    enqueueTool,
    statuses,
    reconcileBinding,
    nextViewerLease,
    acceptViewerToolResult: coordinator.acceptViewerToolResult,
    middleware,
    cancelAfterRestart: coordinator.cancelAfterRestart,
    isTerminalState: (state) => terminal.has(String(state || '')),
  };
}