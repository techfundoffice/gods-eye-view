const BASE_URL = '/hermes-expression-base.svg';
export const HERMES_TASK_LOGO_EVENT = 'gev:hermes-task-logo-status';

export const HERMES_EXPRESSIONS = Object.freeze({
  idle: 'neutral',
  neutral: 'neutral',
  listening: 'listening',
  thinking: 'thinking',
  search: 'search',
  writing: 'write',
  coding: 'code',
  reading: 'reading',
  maps: 'maps',
  video: 'video',
  live: 'live',
  talking: 'talking',
  loading: 'loading',
  longtask: 'longtask',
  success: 'success',
  error: 'error',
  offline: 'offline',
});

const EXPRESSION_LABELS = Object.freeze({
  neutral: 'Idle',
  listening: 'Listening',
  thinking: 'Thinking',
  search: 'Searching',
  write: 'Writing',
  code: 'Coding',
  reading: 'Reading',
  maps: 'Working with maps',
  video: 'Working with video',
  live: 'Working live',
  talking: 'Replying',
  loading: 'Loading',
  longtask: 'Working on a longer task',
  success: 'Task complete',
  error: 'Task error',
  offline: 'Offline',
});

const CATEGORY_RULES = Object.freeze([
  ['coding', /\b(code|coding|program|script|debug|bug|implement|developer|repository|github|npm|node|javascript|typescript|python|html|css|api)\b/i],
  ['search', /\b(search|research|find|look up|browse|web|online|trend|news)\b/i],
  ['writing', /\b(write|draft|edit|rewrite|compose|document|article|post|email|copy)\b/i],
  ['reading', /\b(read|review|summari[sz]e|analy[sz]e|inspect|study|document|file|pdf)\b/i],
  ['maps', /\b(map|globe|location|place|navigate|route|fly to|zoom|satellite|earth|geospatial)\b/i],
  ['video', /\b(video|youtube|clip|stream|camera|footage|film|broadcast)\b/i],
  ['live', /\b(live|realtime|real-time|viewer|comment|on air)\b/i],
  ['longtask', /\b(long task|training|learn|batch|all files|every file|entire project)\b/i],
]);

export function classifyHermesTask(value) {
  const bounded = String(value ?? '').slice(0, 400);
  for (const [category, matcher] of CATEGORY_RULES) {
    if (matcher.test(bounded)) return category;
  }
  return 'thinking';
}

export function resolveHermesExpression({ system = 'idle', conversation = '', taskCategory = '' } = {}) {
  if (system === 'error') return 'error';
  if (system === 'offline') return 'offline';
  if (conversation && HERMES_EXPRESSIONS[conversation]) return HERMES_EXPRESSIONS[conversation];
  if (taskCategory && HERMES_EXPRESSIONS[taskCategory]) return HERMES_EXPRESSIONS[taskCategory];
  if (system === 'loading') return 'loading';
  return 'neutral';
}

export function createHermesTaskLogoController({
  documentRef = globalThis.document,
  windowRef = globalThis.window,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  minHoldMs = 240,
  successHoldMs = 1_200,
} = {}) {
  let destroyed = false;
  let system = 'idle';
  let conversation = '';
  let taskCategory = '';
  let current = '';
  let changedAt = 0;
  let pendingTimer = null;
  let transientTimer = null;
  let sourceSvgPromise = null;
  const objectUrls = new Map();

  const image = () => documentRef?.querySelector?.('#hermes-box-logo-slot img');
  const clearTimer = (kind) => {
    if (kind === 'pending' && pendingTimer != null) windowRef?.clearTimeout?.(pendingTimer);
    if (kind === 'transient' && transientTimer != null) windowRef?.clearTimeout?.(transientTimer);
    if (kind === 'pending') pendingTimer = null;
    if (kind === 'transient') transientTimer = null;
  };
  const ensureUrl = async (expression) => {
    if (objectUrls.has(expression)) return objectUrls.get(expression);
    sourceSvgPromise ||= fetchImpl(BASE_URL, { credentials: 'same-origin' })
      .then((response) => {
        if (!response?.ok) throw new Error(`Hermes expression asset unavailable (${response?.status || 0})`);
        return response.text();
      });
    const source = await sourceSvgPromise;
    const selected = source.replace('href="#f-neutral" />\n</svg>', `href="#f-${expression}" />\n</svg>`);
    const url = windowRef?.URL?.createObjectURL?.(new Blob([selected], { type: 'image/svg+xml' })) || BASE_URL;
    objectUrls.set(expression, url);
    return url;
  };
  const paint = (expression) => {
    if (destroyed || expression === current) return;
    current = expression;
    changedAt = now();
    const img = image();
    if (!img) return;
    img.dataset.hermesTaskLogoManaged = 'true';
    img.dataset.hermesExpression = expression;
    img.alt = `Cloud Computer AI.com — ${EXPRESSION_LABELS[expression] || expression}`;
    void ensureUrl(expression).then((url) => {
      if (!destroyed && current === expression && image() === img) img.src = url;
    }).catch(() => {
      img.dataset.hermesExpressionFallback = 'true';
    });
  };
  const render = ({ immediate = false } = {}) => {
    const next = resolveHermesExpression({ system, conversation, taskCategory });
    if (next === current) return;
    clearTimer('pending');
    const wait = immediate || !current || next === 'error' || next === 'offline'
      ? 0
      : Math.max(0, minHoldMs - (now() - changedAt));
    if (!wait) paint(next);
    else pendingTimer = windowRef?.setTimeout?.(() => {
      pendingTimer = null;
      paint(resolveHermesExpression({ system, conversation, taskCategory }));
    }, wait);
  };
  const setConversation = (state, { transientMs = 0 } = {}) => {
    clearTimer('transient');
    conversation = HERMES_EXPRESSIONS[state] ? state : '';
    render();
    if (transientMs > 0) {
      transientTimer = windowRef?.setTimeout?.(() => {
        transientTimer = null;
        conversation = '';
        render();
      }, transientMs);
    }
  };
  const setTask = (categoryOrText) => {
    taskCategory = HERMES_EXPRESSIONS[categoryOrText]
      ? categoryOrText
      : classifyHermesTask(categoryOrText);
    render();
  };
  const onHarnessStatus = (event) => {
    const detail = event?.detail || {};
    system = ['offline', 'error', 'loading'].includes(detail.system) ? detail.system : 'idle';
    taskCategory = HERMES_EXPRESSIONS[detail.taskCategory] ? detail.taskCategory : '';
    render();
  };
  documentRef?.addEventListener?.(HERMES_TASK_LOGO_EVENT, onHarnessStatus);
  render({ immediate: true });
  for (const expression of new Set(Object.values(HERMES_EXPRESSIONS))) void ensureUrl(expression).catch(() => {});

  return {
    setConversation,
    setTask,
    listening() { setConversation('listening'); },
    replying() { setConversation('talking'); },
    success() { setConversation('success', { transientMs: successHoldMs }); },
    error() { setConversation('error', { transientMs: Math.max(successHoldMs, 1_600) }); },
    clearConversation() {
      clearTimer('transient');
      conversation = '';
      taskCategory = '';
      render();
    },
    get expression() { return current || 'neutral'; },
    destroy() {
      destroyed = true;
      clearTimer('pending');
      clearTimer('transient');
      documentRef?.removeEventListener?.(HERMES_TASK_LOGO_EVENT, onHarnessStatus);
      for (const url of objectUrls.values()) {
        if (url !== BASE_URL) windowRef?.URL?.revokeObjectURL?.(url);
      }
      objectUrls.clear();
    },
  };
}