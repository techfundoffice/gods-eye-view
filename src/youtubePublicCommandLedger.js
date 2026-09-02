import { PUBLIC_COMMAND_LIMITS } from './youtubePublicCommandPolicy.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export const PUBLIC_COMMAND_STATES = Object.freeze([
  'received', 'interpreting', 'deferred', 'awaiting-execution', 'executing',
  'awaiting-model', 'succeeded', 'rejected', 'failed', 'cancelled',
]);
export const PUBLIC_COMMAND_TERMINAL_STATES = Object.freeze(['succeeded', 'rejected', 'failed', 'cancelled']);

/**
 * `deferred` is deliberately NON-terminal: an upstream rate limit is a wait,
 * not a verdict, and writing it as `rejected` killed the comment forever.
 */
const TRANSITIONS = Object.freeze({
  received: ['interpreting', 'rejected', 'cancelled', 'failed'],
  interpreting: ['awaiting-execution', 'deferred', 'succeeded', 'rejected', 'failed', 'cancelled'],
  deferred: ['interpreting', 'cancelled', 'failed'],
  'awaiting-execution': ['executing', 'cancelled', 'failed'],
  executing: ['awaiting-model', 'succeeded', 'failed', 'cancelled'],
  'awaiting-model': ['interpreting', 'succeeded', 'rejected', 'failed', 'cancelled'],
});

const clone = (value) => value == null ? value : structuredClone(value);
const keyOf = (record) => `${record.videoId}\u0000${record.commentId}`;

/**
 * Transactional ledger contract:
 * insert(record), get(id), find(videoId, commentId), compareAndSet(id, from,
 * patch), transaction(fn), cancelNonterminal(reason), cancelWhere(predicate,
 * reason), list().
 */
export function createInMemoryPublicCommandLedger({ maxRecords = 500, now = Date.now } = {}) {
  const records = new Map();
  const unique = new Map();
  let chain = Promise.resolve();

  const transaction = (operation) => {
    const run = chain.then(() => operation(api));
    chain = run.catch(() => {});
    return run;
  };
  const api = {
    transaction,
    async insert(input) {
      return transaction(() => {
        const record = clone(input);
        if (!record.id || !record.videoId || !record.commentId) throw new Error('Command id, videoId, and commentId are required');
        if (records.has(record.id) || unique.has(keyOf(record))) return { inserted: false, record: clone(records.get(unique.get(keyOf(record)))) };
        record.state = record.state || 'received';
        if (!PUBLIC_COMMAND_STATES.includes(record.state)) throw new Error('Invalid command state');
        record.createdAt ??= now();
        record.updatedAt ??= record.createdAt;
        record.remainingTurns ??= PUBLIC_COMMAND_LIMITS.modelTurns;
        record.remainingTools ??= PUBLIC_COMMAND_LIMITS.toolCalls;
        records.set(record.id, record);
        unique.set(keyOf(record), record.id);
        while (records.size > maxRecords) {
          const first = records.values().next().value;
          if (!PUBLIC_COMMAND_TERMINAL_STATES.includes(first.state)) break;
          records.delete(first.id); unique.delete(keyOf(first));
        }
        return { inserted: true, record: clone(record) };
      });
    },
    async get(id) { return clone(records.get(id) || null); },
    async find(videoId, commentId) { return clone(records.get(unique.get(`${videoId}\u0000${commentId}`)) || null); },
    async compareAndSet(id, expected, patch) {
      return transaction(() => {
        const record = records.get(id);
        if (!record || record.state !== expected) return { changed: false, record: clone(record || null) };
        const nextState = patch.state || record.state;
        if (nextState !== record.state && !(TRANSITIONS[record.state] || []).includes(nextState)) throw new Error(`Invalid transition ${record.state} -> ${nextState}`);
        Object.assign(record, clone(patch), { updatedAt: now() });
        return { changed: true, record: clone(record) };
      });
    },
    async cancelNonterminal(reason = 'Coordinator restarted') {
      return transaction(() => {
        let count = 0;
        for (const record of records.values()) {
          if (!PUBLIC_COMMAND_TERMINAL_STATES.includes(record.state)) {
            record.state = 'cancelled'; record.reason = String(reason).slice(0, 160); record.updatedAt = now(); count += 1;
          }
        }
        return count;
      });
    },
    async cancelWhere(predicate, reason = 'Live binding changed') {
      return transaction(() => {
        let count = 0;
        for (const record of records.values()) {
          if (!PUBLIC_COMMAND_TERMINAL_STATES.includes(record.state) && predicate(clone(record))) {
            record.state = 'cancelled';
            record.reason = String(reason).slice(0, 160);
            record.updatedAt = now();
            count += 1;
          }
        }
        return count;
      });
    },
    async list() { return [...records.values()].map(clone); },
  };
  return api;
}

/**
 * Atomic JSON-backed adapter for the single-process production coordinator.
 * Nonterminal records are cancelled during hydration and never reissued after
 * a process crash. The temp-file rename makes each committed snapshot atomic.
 */
export function createFilePublicCommandLedger({
  filePath = process.env.YOUTUBE_PUBLIC_COMMAND_LEDGER_PATH
    || path.join(process.cwd(), '.local/youtube-public-command-ledger.json'),
  maxRecords = 500,
  now = Date.now,
} = {}) {
  const memory = createInMemoryPublicCommandLedger({ maxRecords, now });
  let persistChain = Promise.resolve();
  const persist = () => {
    persistChain = persistChain.then(async () => {
      const records = await memory.list();
      const target = path.resolve(filePath);
      const temporary = `${target}.${process.pid}.tmp`;
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(temporary, `${JSON.stringify({ version: 1, records })}\n`, { mode: 0o600 });
      await fs.rename(temporary, target);
    });
    return persistChain;
  };
  const ready = (async () => {
    try {
      const payload = JSON.parse(await fs.readFile(filePath, 'utf8'));
      for (const record of Array.isArray(payload?.records) ? payload.records : []) {
        await memory.insert(record);
      }
      // A deferred command is waiting out an upstream rate-limit window, not
      // mid-flight against a runner that died with the process. Cancelling it
      // here would make a restart during a rate-limit burst silently drop
      // every queued comment, which is the failure this state exists to stop.
      await memory.cancelWhere(
        (record) => record.state !== 'deferred',
        'Coordinator restarted before completion',
      );
      await persist();
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  })();
  const api = {
    async insert(record) {
      await ready;
      const result = await memory.insert(record);
      if (result.inserted) await persist();
      return result;
    },
    async get(id) { await ready; return memory.get(id); },
    async find(videoId, commentId) { await ready; return memory.find(videoId, commentId); },
    async compareAndSet(id, expected, patch) {
      await ready;
      const result = await memory.compareAndSet(id, expected, patch);
      if (result.changed) await persist();
      return result;
    },
    async cancelNonterminal(reason) {
      await ready;
      const count = await memory.cancelNonterminal(reason);
      if (count) await persist();
      return count;
    },
    async cancelWhere(predicate, reason) {
      await ready;
      const count = await memory.cancelWhere(predicate, reason);
      if (count) await persist();
      return count;
    },
    async list() { await ready; return memory.list(); },
    async transaction(operation) {
      await ready;
      return operation(api);
    },
    ready: () => ready,
  };
  return api;
}