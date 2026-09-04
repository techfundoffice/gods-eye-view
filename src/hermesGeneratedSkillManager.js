import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isViewSafeTool } from './hermesViewSafeCatalog.js';

const clone = (value) => value == null ? value : structuredClone(value);
const FORBIDDEN_TEXT = /\b(?:shell|bash|terminal|exec|spawn|curl|wget|fetch|https?:\/\/|api[_ -]?key|credential|password|secret|oauth|bearer|admin|write[_ -]?file|source code|deploy|package install|youtube write)\b/i;

export function validateGeneratedSkill(candidate) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return { ok: false, reasons: ['Candidate must be an object'] };
  const allowed = new Set(['name', 'version', 'instructions', 'rules', 'examples', 'tools']);
  const reasons = Object.keys(candidate).filter((key) => !allowed.has(key)).map((key) => `Unsupported field: ${key}`);
  if (typeof candidate.name !== 'string' || !/^[a-z][a-z0-9-]{1,63}$/.test(candidate.name)) reasons.push('Invalid skill name');
  if (typeof candidate.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(candidate.version)) reasons.push('Version must be semantic');
  if (typeof candidate.instructions !== 'string' || !candidate.instructions.trim() || candidate.instructions.length > 16_000) reasons.push('Instructions must be 1-16000 characters');
  for (const field of ['rules', 'examples', 'tools']) {
    if (!Array.isArray(candidate[field])) reasons.push(`${field} must be an array`);
    else if (candidate[field].length > 100) reasons.push(`${field} exceeds 100 entries`);
  }
  if (Array.isArray(candidate.tools)) {
    for (const tool of candidate.tools) if (typeof tool !== 'string' || !isViewSafeTool(tool)) reasons.push(`Tool is not view-safe: ${String(tool)}`);
  }
  if (Array.isArray(candidate.rules)) {
    for (const rule of candidate.rules) if (typeof rule !== 'string' || !rule.trim() || rule.length > 2_000) reasons.push('Rules must be non-empty strings of at most 2000 characters');
  }
  if (Array.isArray(candidate.examples)) {
    for (const example of candidate.examples) {
      if (!example || typeof example !== 'object' || Array.isArray(example)) reasons.push('Examples must be objects');
    }
  }
  const prose = [candidate.instructions, ...(candidate.rules || []), ...((candidate.examples || []).map((x) => JSON.stringify(x)))].join('\n');
  if (FORBIDDEN_TEXT.test(prose)) reasons.push('Candidate requests a forbidden capability');
  let bytes = Infinity;
  try { bytes = Buffer.byteLength(JSON.stringify(candidate)); } catch { reasons.push('Candidate must be serializable'); }
  if (bytes > 64_000) reasons.push('Candidate exceeds 64KB');
  return { ok: reasons.length === 0, reasons: [...new Set(reasons)], candidate: reasons.length ? undefined : clone(candidate) };
}

export function describeGeneratedSkillDiff(previous, candidate) {
  const fields = ['name', 'version', 'instructions', 'rules', 'examples', 'tools'];
  const lines = [];
  for (const field of fields) {
    const before = JSON.stringify(previous?.[field] ?? null);
    const after = JSON.stringify(candidate?.[field] ?? null);
    if (before !== after) lines.push(`${field}: ${before} -> ${after}`);
  }
  return lines.join('\n') || 'No changes';
}

export function createGeneratedSkillManager({
  filePath = path.join(process.cwd(), '.local/hermes-generated-skill.json'),
  replay,
  now = Date.now,
  maxReplayCases = 25,
  replayTimeoutMs = 15_000,
  fsImpl = fs,
} = {}) {
  if (typeof replay !== 'function') throw new TypeError('replay callback is required');
  let state = { schemaVersion: 1, revision: 0, active: null, history: [], lastDecision: null };
  let chain = Promise.resolve();
  const ready = (async () => {
    try {
      const parsed = JSON.parse(await fsImpl.readFile(filePath, 'utf8'));
      if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.history)) throw new Error('Invalid generated skill store');
      if (parsed.active && !validateGeneratedSkill(parsed.active).ok) throw new Error('Persisted generated skill is unsafe');
      state = parsed;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  })();
  const persist = async () => {
    const target = path.resolve(filePath);
    const temporary = `${target}.${process.pid}.${state.revision}.tmp`;
    await fsImpl.mkdir(path.dirname(target), { recursive: true });
    await fsImpl.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await fsImpl.rename(temporary, target);
  };
  const transact = (fn) => {
    const result = chain.then(fn);
    chain = result.catch(() => {});
    return result;
  };
  const inspect = () => clone({
    schemaVersion: state.schemaVersion,
    revision: state.revision,
    active: state.active,
    history: state.history.map(({ revision, activatedAt, rationale, diff }) => ({ revision, activatedAt, rationale, diff })),
    lastDecision: state.lastDecision,
  });
  const boundedReplay = async (candidate, cases) => {
    if (!Array.isArray(cases) || cases.length > maxReplayCases) throw new Error(`Replay cases must be an array of at most ${maxReplayCases}`);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('Replay time limit exceeded')), replayTimeoutMs);
    timeout.unref?.();
    try {
      return await Promise.race([
        replay(clone(candidate), clone(cases), { signal: controller.signal, maxCases: maxReplayCases }),
        new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true })),
      ]);
    } finally { clearTimeout(timeout); }
  };
  return {
    ready: () => ready,
    async inspect() { await ready; await chain; return inspect(); },
    async propose(candidate, { rationale, cases = [] } = {}) {
      await ready;
      return transact(async () => {
        const checked = validateGeneratedSkill(candidate);
        const diff = describeGeneratedSkillDiff(state.active, candidate);
        if (!checked.ok || typeof rationale !== 'string' || !rationale.trim() || !Array.isArray(cases) || cases.length < 1) {
          state.lastDecision = {
            accepted: false,
            reasons: checked.reasons.length
              ? checked.reasons
              : typeof rationale !== 'string' || !rationale.trim()
                ? ['Rationale is required']
                : ['At least one bounded replay case is required'],
            diff,
            at: now(),
          };
          return clone(state.lastDecision);
        }
        let replayResult;
        try { replayResult = await boundedReplay(checked.candidate, cases); } catch (error) {
          state.lastDecision = { accepted: false, reasons: [String(error?.message || error)], diff, rationale, at: now() };
          return clone(state.lastDecision);
        }
        if (!replayResult || replayResult.ok !== true) {
          state.lastDecision = { accepted: false, reasons: replayResult?.reasons || ['Replay validation failed'], diff, rationale, at: now() };
          return clone(state.lastDecision);
        }
        state.history.push({ revision: state.revision, skill: clone(state.active), activatedAt: now(), rationale, diff });
        state.history = state.history.slice(-20);
        state.active = checked.candidate;
        state.revision += 1;
        state.lastDecision = { accepted: true, revision: state.revision, diff, rationale, replay: clone(replayResult), at: now() };
        try {
          await persist();
        } catch (error) {
          state.active = state.history.pop()?.skill ?? null;
          state.revision -= 1;
          state.lastDecision = {
            accepted: false,
            reasons: [`Activation persistence failed: ${String(error?.message || error)}`],
            diff,
            rationale,
            at: now(),
          };
          return clone(state.lastDecision);
        }
        return clone(state.lastDecision);
      });
    },
    async rollback(revision) {
      await ready;
      return transact(async () => {
        const target = state.history.find((entry) => entry.revision === Number(revision));
        if (!target) throw new Error(`Generated skill revision ${revision} is unavailable`);
        const current = clone(state.active);
        state.history.push({ revision: state.revision, skill: current, activatedAt: now(), rationale: `rollback to ${revision}`, diff: describeGeneratedSkillDiff(current, target.skill) });
        state.active = clone(target.skill);
        state.revision += 1;
        state.lastDecision = { accepted: true, rollback: Number(revision), revision: state.revision, at: now() };
        try {
          await persist();
        } catch (error) {
          const restored = state.history.pop();
          state.active = restored?.skill ?? current;
          state.revision -= 1;
          throw error;
        }
        return inspect();
      });
    },
    async clear() {
      await ready;
      return transact(async () => {
        state.history.push({ revision: state.revision, skill: clone(state.active), activatedAt: now(), rationale: 'clear', diff: describeGeneratedSkillDiff(state.active, null) });
        state.active = null;
        state.revision += 1;
        state.lastDecision = { accepted: true, cleared: true, revision: state.revision, at: now() };
        try {
          await persist();
        } catch (error) {
          const restored = state.history.pop();
          state.active = restored?.skill ?? null;
          state.revision -= 1;
          throw error;
        }
        return inspect();
      });
    },
  };
}