const HERMES_ENDPOINT = '/api/youtube-comment-harness/hermes';
const MAX_CONTROLS = 80;
const MAX_SCREENSHOT_CHARS = 120_000;
export const HERMES_TRAINING_ACTIONS = Object.freeze({
  pause: 'pause-training',
  resume: 'resume-training',
  clear: 'clear-learning',
  rollback: 'rollback-learning',
  inspect: 'inspect-learning',
});

function text(value, max = 240) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

function finite(value, digits = 5) {
  const number = Number(value);
  return Number.isFinite(number) ? Number(number.toFixed(digits)) : null;
}

function isVisible(element, windowRef) {
  if (!element || element.hidden || element.getAttribute?.('aria-hidden') === 'true') return false;
  const style = windowRef?.getComputedStyle?.(element);
  return !style || (style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) !== 0);
}

function publicControlState(element) {
  const type = text(element.type, 20).toLowerCase();
  const state = {
    id: text(element.id || element.getAttribute?.('data-action') || '', 80) || null,
    label: text(
      element.getAttribute?.('aria-label')
      || element.title
      || element.textContent
      || element.name,
      120,
    ),
    disabled: Boolean(element.disabled),
  };
  const pressed = element.getAttribute?.('aria-pressed');
  const expanded = element.getAttribute?.('aria-expanded');
  if (pressed != null) state.pressed = pressed === 'true';
  if (expanded != null) state.expanded = expanded === 'true';
  if (element.tagName === 'SELECT') state.selection = text(element.selectedOptions?.[0]?.textContent, 80);
  if (type === 'checkbox' || type === 'radio') state.checked = Boolean(element.checked);
  // Text and password values can contain credentials, API keys, chat drafts, or
  // private searches. Range values and option labels are presentation state.
  if (type === 'range') state.value = finite(element.value, 2);
  return state;
}

function captureScreenshot(documentRef) {
  const source = documentRef?.querySelector?.('#cesiumContainer canvas');
  if (!source || !source.width || !source.height || typeof source.toDataURL !== 'function') return null;
  try {
    const scale = Math.min(1, 480 / source.width, 270 / source.height);
    const width = Math.max(1, Math.round(source.width * scale));
    const height = Math.max(1, Math.round(source.height * scale));
    let output = source;
    if (scale < 1 && documentRef.createElement) {
      output = documentRef.createElement('canvas');
      output.width = width;
      output.height = height;
      output.getContext?.('2d')?.drawImage?.(source, 0, 0, width, height);
    }
    const dataUrl = output.toDataURL('image/webp', 0.55);
    if (!dataUrl || dataUrl.length > MAX_SCREENSHOT_CHARS) {
      return { available: false, reason: 'screenshot exceeded 120000 character limit', width, height };
    }
    return { available: true, mimeType: 'image/webp', width, height, dataUrl };
  } catch (error) {
    return { available: false, reason: text(error?.message || 'canvas capture unavailable', 120) };
  }
}

function captureMediaFrame(documentRef, source, label) {
  if (!source) return null;
  try {
    const sourceWidth = source.videoWidth || source.naturalWidth || source.width;
    const sourceHeight = source.videoHeight || source.naturalHeight || source.height;
    if (!sourceWidth || !sourceHeight || !documentRef?.createElement) {
      return { available: false, reason: `${label} frame is not ready` };
    }
    const scale = Math.min(1, 480 / sourceWidth, 270 / sourceHeight);
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    const canvas = documentRef.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext?.('2d')?.drawImage?.(source, 0, 0, width, height);
    const dataUrl = canvas.toDataURL('image/webp', 0.5);
    if (!dataUrl || dataUrl.length > MAX_SCREENSHOT_CHARS) {
      return { available: false, reason: `${label} frame exceeded the media limit`, width, height };
    }
    return { available: true, mimeType: 'image/webp', width, height, dataUrl };
  } catch (error) {
    return { available: false, reason: text(error?.message || `${label} frame is unavailable`, 120) };
  }
}

function layerContext(dataManager) {
  if (!(dataManager?.layers instanceof Map)) return { enabled: [], states: [] };
  const states = [];
  for (const [id, entry] of dataManager.layers) {
    const lifecycle = dataManager.getLayerLifecycleState?.(id);
    states.push({
      id: text(id, 80),
      label: text(entry?.module?.name || entry?.module?.label || id, 100),
      enabled: Boolean(dataManager.isEnabled?.(id)),
      lifecycle: text(lifecycle?.lifecycleState || '', 40) || null,
    });
  }
  return {
    enabled: states.filter((item) => item.enabled).map((item) => item.id),
    states,
  };
}

function moduleContext(dataManager, id) {
  const module = dataManager?.layers?.get?.(id)?.module;
  if (!module) return null;
  try {
    const state = module.getUIState?.() || module.getStats?.() || null;
    if (!state || typeof state !== 'object') return null;
    if (id === 'radio') {
      const selected = state.selected;
      return {
        enabled: Boolean(dataManager.isEnabled?.(id)),
        filter: text(state.filter, 40) || null,
        selected: text(selected?.name || selected?.label || selected, 100) || null,
        playing: Boolean(state.playing || state.playingStationId),
        audioState: text(state.audioState, 40) || null,
      };
    }
    return {
      enabled: Boolean(dataManager.isEnabled?.(id)),
      activeCameraId: text(state.activeCameraId || state.selectedCameraId, 100) || null,
      activeCamera: text(state.activeCamera?.name || state.activeCamera?.label, 120) || null,
      coverageMode: text(state.coverageMode, 40) || null,
      showProjection: Boolean(state.showProjection),
      autoHop: Boolean(state.autoHop),
      count: finite(state.count, 0),
    };
  } catch {
    return null;
  }
}

/** Capture only public presentation state; no storage, cookies, headers, or text-field values. */
export async function captureHermesViewContext({
  windowRef = globalThis.window,
  documentRef = globalThis.document,
  includeScreenshot = true,
} = {}) {
  const app = windowRef?.__godsEyeView || {};
  const dataManager = app.dataManager;
  const viewer = app.viewer;
  const camera = viewer?.camera;
  const cartographic = camera?.positionCartographic;
  const radiansToDegrees = (value) => finite(Number(value) * (180 / Math.PI), 6);
  const controls = [...(documentRef?.querySelectorAll?.('button, select, input[type="checkbox"], input[type="radio"], input[type="range"]') || [])]
    .filter((element) => !element.closest?.('#admin-console') && isVisible(element, windowRef))
    .slice(0, MAX_CONTROLS)
    .map(publicControlState);
  const panels = [...(documentRef?.querySelectorAll?.('[data-panel-id], [role="dialog"], [aria-controls]') || [])]
    .filter((element) => !element.closest?.('#admin-console') && isVisible(element, windowRef))
    .slice(0, 40)
    .map((element) => ({
      id: text(element.dataset?.panelId || element.id, 80),
      label: text(element.getAttribute?.('aria-label') || element.querySelector?.('.panel-title')?.textContent, 100),
      open: !element.classList?.contains?.('collapsed') && element.getAttribute?.('aria-expanded') !== 'false',
    }))
    .filter((panel) => panel.id || panel.label);
  const cctvFrameSource = documentRef?.querySelector?.(
    '#cctv-panel video, #cctv-panel img, [data-panel-id="cctv-panel"] video, [data-panel-id="cctv-panel"] img, [data-cctv] video, [data-cctv] img',
  );
  const cctv = moduleContext(dataManager, 'cctv');
  const cctvFrame = captureMediaFrame(documentRef, cctvFrameSource, 'CCTV');
  if (cctv && cctvFrame) cctv.image = cctvFrame;
  const radio = moduleContext(dataManager, 'radio');
  const radioTranscript = text(
    documentRef?.querySelector?.('[data-radio-transcript], #radio-transcript, .radio-transcript')?.textContent,
    500,
  );
  if (radio && radioTranscript) radio.transcript = radioTranscript;
  const videoFrames = [...(documentRef?.querySelectorAll?.(
    '#cctv-panel video, [data-panel-id="cctv-panel"] video, [data-cctv] video',
  ) || [])].slice(0, 2).map((element) => captureMediaFrame(documentRef, element, 'Video')).filter(Boolean);

  return {
    capturedAt: new Date().toISOString(),
    viewport: {
      width: finite(windowRef?.innerWidth, 0),
      height: finite(windowRef?.innerHeight, 0),
      devicePixelRatio: finite(windowRef?.devicePixelRatio, 2),
    },
    screenshot: includeScreenshot ? captureScreenshot(documentRef) : null,
    camera: camera ? {
      latitude: radiansToDegrees(cartographic?.latitude),
      longitude: radiansToDegrees(cartographic?.longitude),
      altitudeMeters: finite(cartographic?.height, 1),
      headingDegrees: radiansToDegrees(camera.heading),
      pitchDegrees: radiansToDegrees(camera.pitch),
      rollDegrees: radiansToDegrees(camera.roll),
      trackedEntity: text(viewer?.trackedEntity?.name || viewer?.trackedEntity?.id, 100) || null,
      mode: documentRef?.getElementById?.('cockpit-hud')?.hidden === false ? 'cockpit' : 'map',
    } : null,
    location: {
      place: text(documentRef?.getElementById?.('location-mini-city')?.textContent, 140) || null,
      landmark: text(documentRef?.getElementById?.('location-mini-poi')?.textContent, 140) || null,
    },
    style: text(app.styleManager?.activeStyle || documentRef?.documentElement?.dataset?.gevStyle, 40) || 'normal',
    mapSource: text(
      app.mapStackController?.getState?.().activeId
      || documentRef?.querySelector?.('[data-stack-id][aria-pressed="true"]')?.dataset?.stackId,
      60,
    ) || null,
    layers: layerContext(dataManager),
    panels,
    controls,
    radio,
    cctv,
    videoFrames,
  };
}

function listText(value, fallback) {
  const items = Array.isArray(value) ? value : value ? [value] : [];
  return items.length ? items.map((item) => text(item?.data?.summary || item?.name || item?.summary || item, 100)).filter(Boolean).join(' · ') : fallback;
}

function capabilityText(value, fallback) {
  if (Array.isArray(value)) return listText(value, fallback);
  if (value && typeof value === 'object') {
    const enabled = Object.entries(value)
      .filter(([, supported]) => supported === true)
      .map(([name]) => name.replace(/([A-Z])/g, ' $1').trim());
    return enabled.length ? enabled.join(' · ') : fallback;
  }
  return listText(value, fallback);
}

export function initHermesAgentCard({
  documentRef = globalThis.document,
  windowRef = globalThis.window,
  fetchImpl = globalThis.fetch,
  pollMs = 5_000,
} = {}) {
  const root = documentRef?.getElementById?.('hermes-agent-card');
  if (!root) return null;
  const get = (id) => root.querySelector?.(`#${id}`);
  const statusEl = get('hermes-agent-status');
  const inspectEl = get('hermes-agent-inspection');
  let stopped = false;
  let timer = null;

  const setMessage = (message, state = '') => {
    if (!statusEl) return;
    statusEl.textContent = text(message, 240);
    statusEl.dataset.state = state;
  };

  const render = (state = {}) => {
    const harness = state.harness && typeof state.harness === 'object' ? state.harness : state;
    const learning = state.learning && typeof state.learning === 'object' ? state.learning : {};
    const training = (state.training || learning.training) && typeof (state.training || learning.training) === 'object' ? (state.training || learning.training) : {};
    const lessons = (state.lessons || learning.lessons) && typeof (state.lessons || learning.lessons) === 'object' ? (state.lessons || learning.lessons) : {};
    const generatedSkill = (state.generatedSkill || learning.generatedSkill) && typeof (state.generatedSkill || learning.generatedSkill) === 'object' ? (state.generatedSkill || learning.generatedSkill) : {};
    const skillFailure = Array.isArray(generatedSkill.lastDecision?.reasons)
      ? generatedSkill.lastDecision.reasons.join(' · ')
      : generatedSkill.lastDecision?.reason;
    const currentLearning = typeof state.learning === 'string'
      ? state.learning
      : typeof state.currentLearning === 'string'
        ? state.currentLearning
        : '';
    root.dataset.state = harness.running ? 'running' : harness.ready ? 'ready' : 'offline';
    const values = {
      'hermes-agent-seeing': state.seeing || state.observation || (harness.running ? 'Live interface and bounded globe frame' : 'Waiting for live interface'),
      'hermes-agent-practicing': state.practicing || training.currentPractice
        || (training.state === 'training' ? `Training · ${text(training.currentPractice || training.startedAt || 'active', 100)}` : `Training ${text(training.state || 'idle', 40)}`),
      'hermes-agent-attempting': state.attempting || harness.currentTask || (harness.running ? 'Ready for the next viewer turn' : 'No active attempt'),
      'hermes-agent-observing': state.observing || training.observedResult || (harness.running ? 'Waiting for the next observed result' : 'Waiting for live interface'),
      'hermes-agent-learning': currentLearning
        || `${Number(lessons.lessonCount) || 0} saved lesson${Number(lessons.lessonCount) === 1 ? '' : 's'}${generatedSkill.active?.version ? ` · skill ${text(generatedSkill.active.version, 40)}` : ''}`,
      'hermes-agent-provider': `${text(harness.provider || harness.active || harness.preferred || 'Unavailable', 80)}${harness.model ? ` · ${text(harness.model, 100)}` : ''}`,
      'hermes-agent-capabilities': harness.modelCapabilities
        ? capabilityText(harness.modelCapabilities, 'No model capabilities reported')
        : harness.toolCount != null
          ? `${Math.max(0, Number(harness.toolCount) || 0)} registered tools`
          : capabilityText(harness.capabilities || harness.tools, 'No capabilities reported'),
      'hermes-agent-failure': text(
        state.latestFailure || training.lastError || skillFailure || harness.lastError || harness.fallbackReason || state.error,
        180,
      ) || 'None reported',
      'hermes-agent-lessons': listText(state.savedLessons || lessons.lessons || state.lessons, 'No saved lessons reported'),
    };
    for (const [id, value] of Object.entries(values)) {
      const element = get(id);
      if (element) element.textContent = value;
    }
    setMessage(harness.running ? 'HERMES RUNNING' : harness.ready ? 'HERMES READY' : 'HERMES OFFLINE', harness.running ? 'ok' : '');
  };

  const request = async (action = null, details = {}) => {
    const response = await fetchImpl(HERMES_ENDPOINT, {
      method: action ? 'POST' : 'GET',
      credentials: 'same-origin',
      headers: action ? { 'Content-Type': 'application/json', Accept: 'application/json' } : { Accept: 'application/json' },
      ...(action ? { body: JSON.stringify({ action, ...details }) } : {}),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = text(payload?.error?.message, 160);
      if (response.status === 401 || response.status === 403) {
        throw new Error(`AUTH REQUIRED${detail ? ` · ${detail}` : ''}`);
      }
      if (response.status === 404 || response.status === 405 || payload?.error?.kind === 'invalid') {
        throw new Error(`UNSUPPORTED${detail ? ` · ${detail}` : ` (${response.status})`}`);
      }
      throw new Error(detail || `Hermes endpoint unavailable (${response.status})`);
    }
    render(payload);
    return payload;
  };

  const refresh = async () => {
    try { await request(); } catch (error) { setMessage(error?.message || 'Hermes status unavailable', 'error'); }
  };

  root.querySelectorAll?.('[data-hermes-action]')?.forEach((button) => {
    button.addEventListener('click', async () => {
      const action = button.dataset.hermesAction;
      button.disabled = true;
      setMessage(`${action.toUpperCase()} REQUESTED`);
      try {
        await request(action, action === 'rollback-learning' ? { target: 'all' } : {});
      } catch (error) {
        setMessage(`${action.toUpperCase()} FAILED · ${error?.message || 'endpoint unavailable'}`, 'error');
      } finally {
        button.disabled = false;
      }
    });
  });
  get('hermes-agent-inspect')?.addEventListener('click', async () => {
    setMessage('CAPTURING LIVE CONTEXT');
    try {
      const context = await captureHermesViewContext({ documentRef, windowRef });
      let learning = null;
      let learningError = '';
      try {
        learning = await request(HERMES_TRAINING_ACTIONS.inspect);
      } catch (error) {
        learningError = text(error?.message || 'learning inspection unavailable', 200);
      }
      if (inspectEl) {
        inspectEl.textContent = JSON.stringify({
          liveContext: context,
          learningInspection: learning,
          ...(learningError ? { learningInspectionError: learningError } : {}),
        }, null, 2);
        inspectEl.hidden = false;
      }
      setMessage(learningError ? `CONTEXT CAPTURED · LEARNING INSPECT FAILED · ${learningError}` : 'LIVE CONTEXT + LEARNING INSPECTED', learningError ? 'error' : 'ok');
    } catch (error) {
      setMessage(`INSPECT FAILED · ${error?.message || 'capture unavailable'}`, 'error');
    }
  });
  void refresh();
  if (pollMs > 0) timer = windowRef?.setInterval?.(refresh, pollMs);
  return {
    refresh,
    captureContext: () => captureHermesViewContext({ documentRef, windowRef }),
    destroy() {
      stopped = true;
      if (timer != null) windowRef?.clearInterval?.(timer);
      timer = null;
    },
    get stopped() { return stopped; },
  };
}