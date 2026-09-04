import { promises as fs } from 'node:fs';
import path from 'node:path';

const FORBIDDEN_KEYS = /(?:viewer|username|user_?id|secret|token|password|credential|api_?key|image|video|audio|media|frame|blob|base64|transcript|comment|message)/i;
const FORBIDDEN_VALUE = /(?:data:(?:image|video|audio)\/|-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:api[_-]?key|bearer|password|secret)\s*[:=])/i;
const clone = (value) => value == null ? value : structuredClone(value);

export function validateTrainingLesson(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, reason: 'Lesson must be an object' };
  }
  const visit = (value, trail = []) => {
    if (trail.length > 8) return `Lesson nesting exceeds 8 levels at ${trail.join('.')}`;
    if (typeof value === 'string') {
      if (value.length > 8_000) return `Lesson string is too long at ${trail.join('.')}`;
      if (FORBIDDEN_VALUE.test(value)) return `Secret or raw media content is not permitted at ${trail.join('.')}`;
    } else if (Array.isArray(value)) {
      if (value.length > 100) return `Lesson array is too large at ${trail.join('.')}`;
      for (let i = 0; i < value.length; i += 1) {
        const invalid = visit(value[i], [...trail, String(i)]);
        if (invalid) return invalid;
      }
    } else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        if (FORBIDDEN_KEYS.test(key)) return `Forbidden lesson field: ${key}`;
        const invalid = visit(child, [...trail, key]);
        if (invalid) return invalid;
      }
    } else if (value !== null && !['boolean', 'number', 'undefined'].includes(typeof value)) {
      return `Unsupported lesson value at ${trail.join('.')}`;
    }
    return '';
  };
  const reason = visit(input);
  if (reason) return { ok: false, reason };
  let bytes;
  try { bytes = Buffer.byteLength(JSON.stringify(input)); } catch { return { ok: false, reason: 'Lesson must be serializable' }; }
  if (bytes > 32_000) return { ok: false, reason: 'Lesson exceeds 32KB' };
  if (typeof input.summary !== 'string' || !input.summary.trim()) {
    return { ok: false, reason: 'Lesson summary is required' };
  }
  return { ok: true, lesson: clone(input) };
}

export function createVersionedLessonStore({
  filePath = path.join(process.cwd(), '.local/hermes-lessons.json'),
  fsImpl = fs,
  now = Date.now,
  maxVersions = 50,
  maxLessons = 500,
} = {}) {
  let state = { schemaVersion: 1, revision: 0, lessons: [], history: [], updatedAt: null };
  let chain = Promise.resolve();
  const transaction = (fn) => {
    const result = chain.then(fn);
    chain = result.catch(() => {});
    return result;
  };
  const persist = async () => {
    const target = path.resolve(filePath);
    const temporary = `${target}.${process.pid}.${state.revision}.tmp`;
    await fsImpl.mkdir(path.dirname(target), { recursive: true });
    await fsImpl.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await fsImpl.rename(temporary, target);
  };
  const ready = (async () => {
    try {
      const parsed = JSON.parse(await fsImpl.readFile(filePath, 'utf8'));
      if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.lessons) || !Array.isArray(parsed.history)) {
        throw new Error('Invalid lesson store schema');
      }
      for (const lesson of parsed.lessons) {
        const checked = validateTrainingLesson(lesson.data);
        if (!checked.ok) throw new Error(`Unsafe persisted lesson: ${checked.reason}`);
      }
      state = parsed;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  })();
  const commit = async (lessons, operation) => {
    const previous = clone(state);
    state.history.push({
      revision: state.revision,
      lessons: clone(state.lessons),
      operation,
      archivedAt: now(),
    });
    state.history = state.history.slice(-maxVersions);
    state.revision += 1;
    state.lessons = lessons.slice(-maxLessons);
    state.updatedAt = now();
    try {
      await persist();
    } catch (error) {
      state = previous;
      throw error;
    }
    return inspect();
  };
  const inspect = ({ includeHistory = false } = {}) => ({
    schemaVersion: state.schemaVersion,
    revision: state.revision,
    lessonCount: state.lessons.length,
    lessons: clone(state.lessons),
    updatedAt: state.updatedAt,
    ...(includeHistory ? { history: clone(state.history) } : {}),
  });
  return {
    ready: () => ready,
    async add(input) {
      await ready;
      return transaction(async () => {
        const checked = validateTrainingLesson(input);
        if (!checked.ok) throw new Error(checked.reason);
        const entry = {
          id: `lesson-${state.revision + 1}-${state.lessons.length + 1}`,
          createdAt: now(),
          data: checked.lesson,
        };
        return commit([...state.lessons, entry], 'add');
      });
    },
    async inspect(options) { await ready; await chain; return inspect(options); },
    async clear() {
      await ready;
      return transaction(() => commit([], 'clear'));
    },
    async rollback(revision) {
      await ready;
      return transaction(async () => {
        const target = state.history.find((item) => item.revision === Number(revision));
        if (!target) throw new Error(`Lesson revision ${revision} is unavailable`);
        return commit(clone(target.lessons), `rollback:${revision}`);
      });
    },
  };
}