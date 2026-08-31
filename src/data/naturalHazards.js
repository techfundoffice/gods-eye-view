import * as Cesium from 'cesium';
import { governorRequestRender } from '../renderGovernor.js';
import {
  clearSelectedEntityContextForLayer,
  registerEntityContext,
  removeEntityContextsForLayer,
  selectEntityContext,
} from './contextStore.js';
import {
  isOwnedByOtherLayer,
  registerPickOwner,
  resolvePickId,
  unregisterPickOwner,
} from './pickRegistry.js';
import {
  clearOverlaySource,
  hitTestWorldOverlay,
  setOverlayEntries,
  setOverlaySourceVisible,
} from '../overlays/worldOverlay.js';
import { requestWorldFocus } from '../worldFocus.js';

export const NATURAL_HAZARDS_ENDPOINT = '/api/natural-hazards';
export const NATURAL_HAZARDS_LAYER_ID = 'natural-hazards';
export const NATURAL_HAZARDS_RENDER_LIMIT = 200;
export const NATURAL_HAZARDS_LABEL_LIMIT = 48;

export const HAZARD_CATEGORIES = Object.freeze({
  earthquake: Object.freeze({ label: 'QUAKES', color: '#ff5c68', pixelSize: 9 }),
  wildfire: Object.freeze({ label: 'FIRES', color: '#ff9f43', pixelSize: 10 }),
  'severe-storm': Object.freeze({ label: 'STORMS', color: '#39d0ff', pixelSize: 11 }),
  volcano: Object.freeze({ label: 'VOLCANOES', color: '#f7d154', pixelSize: 11 }),
});

const SOURCE_LABELS = Object.freeze({
  eonet: 'EONET',
  usgs: 'USGS',
  fema: 'FEMA',
  reliefweb: 'RELIEFWEB',
});

const DEFAULT_FILTERS = Object.freeze(
  Object.fromEntries(Object.keys(HAZARD_CATEGORIES).map((category) => [category, true])),
);

const DEFAULT_OVERLAY_HOST = Object.freeze({
  setEntries: setOverlayEntries,
  setVisible: setOverlaySourceVisible,
  clearSource: clearOverlaySource,
  hitTest: hitTestWorldOverlay,
});

function hasContextHost() {
  return typeof window !== 'undefined' && Boolean(window);
}

function safeTimestamp(value) {
  const time = Date.parse(String(value || ''));
  return Number.isFinite(time) ? time : null;
}

function finiteCoordinate(value, min, max) {
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? number : null;
}

export function normalizeHazardPayload(payload) {
  const hazards = [];
  const seen = new Set();
  for (const raw of Array.isArray(payload?.hazards) ? payload.hazards : []) {
    const id = String(raw?.id || '').trim();
    const category = String(raw?.category || '').trim();
    const latitude = finiteCoordinate(raw?.coordinates?.latitude, -90, 90);
    const longitude = finiteCoordinate(raw?.coordinates?.longitude, -180, 180);
    const startedAtMs = safeTimestamp(raw?.startedAt);
    if (!id || seen.has(id) || !HAZARD_CATEGORIES[category]) continue;
    if (latitude == null || longitude == null || startedAtMs == null) continue;
    seen.add(id);
    hazards.push({
      id,
      category,
      title: String(raw?.title || HAZARD_CATEGORIES[category].label).slice(0, 120),
      latitude,
      longitude,
      startedAt: new Date(startedAtMs).toISOString(),
      updatedAt: raw?.updatedAt || raw?.startedAt,
      magnitude: Number.isFinite(raw?.magnitude) ? raw.magnitude : null,
      depthKm: Number.isFinite(raw?.depthKm) ? raw.depthKm : null,
      source: {
        name: String(raw?.source?.name || 'Unknown source').slice(0, 80),
        url: /^https?:\/\//.test(String(raw?.source?.url || '')) ? String(raw.source.url) : null,
        attribution: String(raw?.source?.attribution || '').slice(0, 160),
      },
    });
    if (hazards.length >= NATURAL_HAZARDS_RENDER_LIMIT) break;
  }
  return {
    hazards,
    context: (Array.isArray(payload?.context) ? payload.context : []).slice(0, 100),
    sources: payload?.sources && typeof payload.sources === 'object' ? payload.sources : {},
    generatedAt: safeTimestamp(payload?.generatedAt),
  };
}

export function hazardCounts(records) {
  const counts = Object.fromEntries(Object.keys(HAZARD_CATEGORIES).map((key) => [key, 0]));
  for (const record of records || []) {
    if (Object.hasOwn(counts, record?.category)) counts[record.category] += 1;
  }
  return counts;
}

export function visibleHazards(records, filters, limit = NATURAL_HAZARDS_RENDER_LIMIT) {
  const cap = Math.max(0, Math.min(NATURAL_HAZARDS_RENDER_LIMIT, Math.floor(Number(limit) || 0)));
  return (records || [])
    .filter((record) => filters?.[record.category] !== false)
    .sort((a, b) => {
      const magnitude = (b.magnitude || 0) - (a.magnitude || 0);
      return magnitude || Date.parse(b.updatedAt || b.startedAt) - Date.parse(a.updatedAt || a.startedAt)
        || a.id.localeCompare(b.id);
    })
    .slice(0, cap);
}

export function sourceHealthSummary(sources = {}) {
  const entries = Object.entries(SOURCE_LABELS).map(([id, label]) => {
    const status = String(sources?.[id]?.status || 'unavailable');
    return { id, label, status, fetchedAt: sources?.[id]?.fetchedAt || null };
  });
  const unavailable = entries.filter(({ status }) => status === 'unavailable');
  const stale = entries.filter(({ status }) => status === 'stale');
  return {
    entries,
    unavailable,
    stale,
    error: [...unavailable, ...stale].map(({ label, status }) => `${label} ${status}`).join(' · ') || null,
  };
}

function formatAge(value) {
  const time = safeTimestamp(value);
  if (time == null) return 'time unavailable';
  const minutes = Math.max(0, Math.floor((Date.now() - time) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

export function buildHazardOverlayEntry(record, { selected = false, activate = null } = {}) {
  const category = HAZARD_CATEGORIES[record.category];
  const details = [
    category.label,
    `Observed ${formatAge(record.updatedAt || record.startedAt)}`,
  ];
  if (record.magnitude != null) details.push(`Magnitude ${record.magnitude.toFixed(1)}`);
  if (record.depthKm != null) details.push(`Depth ${record.depthKm.toFixed(1)} km`);
  details.push(record.source.name);
  if (record.source.url) details.push(record.source.url);
  return {
    id: record.id,
    position: Cesium.Cartesian3.fromDegrees(record.longitude, record.latitude),
    variant: selected ? 'card' : 'label',
    title: record.title,
    details: selected ? details : [],
    accent: category.color,
    priority: (record.magnitude || 0) * 10_000 + (safeTimestamp(record.updatedAt) || 0) / 1e9,
    collisionGroup: selected ? 'selected-card' : 'ambient-label',
    paintLane: selected ? 'selected-card' : 'ambient-label',
    protected: selected,
    interactive: true,
    accessibilityLabel: `Focus ${category.label.toLowerCase()} event ${record.title}`,
    activate,
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
    gapPx: selected ? 22 : 15,
    verticalOnly: true,
    placement: 'above',
  };
}

export function createNaturalHazardsLayer({
  fetchImpl,
  overlayHost = DEFAULT_OVERLAY_HOST,
  screenSpaceEventHandlerFactory = (viewer) => new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas),
} = {}) {
  let viewer = null;
  let dataSource = null;
  let enabled = false;
  let loading = false;
  let answered = false;
  let records = [];
  let context = [];
  let sources = {};
  let lastUpdate = null;
  let lastError = null;
  let selectedId = null;
  let clickHandler = null;
  let activeController = null;
  let updatePromise = null;
  let rowControlsListener = null;
  const recordByEntityId = new Map();
  const filters = { ...DEFAULT_FILTERS };

  function entityId(record) {
    return `${NATURAL_HAZARDS_LAYER_ID}:${record.id}`;
  }

  function selectedRecord() {
    return records.find((record) => record.id === selectedId) || null;
  }

  function publishOverlay() {
    const visible = visibleHazards(records, filters);
    const selected = selectedRecord();
    const entries = [];
    if (selected && filters[selected.category] !== false) {
      entries.push(buildHazardOverlayEntry(selected, {
        selected: true,
        activate: () => focusRecord(selected),
      }));
    }
    for (const record of visible) {
      if (record.id === selected?.id || entries.length >= NATURAL_HAZARDS_LABEL_LIMIT) continue;
      entries.push(buildHazardOverlayEntry(record, {
        activate: () => focusRecord(record),
      }));
    }
    overlayHost.setEntries(NATURAL_HAZARDS_LAYER_ID, entries, {
      cohortLimit: NATURAL_HAZARDS_LABEL_LIMIT,
      collisionCapacity: 32,
      moving: false,
    });
    overlayHost.setVisible(NATURAL_HAZARDS_LAYER_ID, enabled);
  }

  function render() {
    if (!dataSource) return;
    dataSource.entities.removeAll();
    recordByEntityId.clear();
    if (hasContextHost()) removeEntityContextsForLayer(NATURAL_HAZARDS_LAYER_ID);
    for (const record of visibleHazards(records, filters)) {
      const category = HAZARD_CATEGORIES[record.category];
      const id = entityId(record);
      const entity = dataSource.entities.add({
        id,
        position: Cesium.Cartesian3.fromDegrees(record.longitude, record.latitude),
        point: {
          pixelSize: category.pixelSize,
          color: Cesium.Color.fromCssColorString(category.color).withAlpha(0.9),
          outlineColor: Cesium.Color.BLACK.withAlpha(0.65),
          outlineWidth: 2,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        properties: {
          hazardId: record.id,
          category: record.category,
          title: record.title,
          sourceUrl: record.source.url,
        },
      });
      entity.gevLabelModel = {
        title: record.title,
        details: buildHazardOverlayEntry(record, { selected: true }).details,
        accent: category.color,
      };
      if (hasContextHost()) {
        registerEntityContext(entity, {
          id: record.id,
          layerId: NATURAL_HAZARDS_LAYER_ID,
          type: 'natural-hazard',
          label: record.title,
          category: record.category,
          latitude: record.latitude,
          longitude: record.longitude,
          source: record.source.name,
          sourceUrl: record.source.url,
          dataSource,
        });
      }
      recordByEntityId.set(id, record);
    }
    if (selectedId && !recordByEntityId.has(entityId({ id: selectedId }))) {
      selectedId = null;
      if (hasContextHost()) {
        clearSelectedEntityContextForLayer(NATURAL_HAZARDS_LAYER_ID, { evicted: true });
      }
    }
    publishOverlay();
    governorRequestRender(`layer-tick:${NATURAL_HAZARDS_LAYER_ID}`);
  }

  function focusRecord(record) {
    if (!record) return false;
    selectedId = record.id;
    const entity = dataSource?.entities?.getById?.(entityId(record));
    if (entity && hasContextHost()) selectEntityContext(entity);
    const position = Cesium.Cartesian3.fromDegrees(record.longitude, record.latitude);
    requestWorldFocus({
      kind: 'natural-hazard',
      id: record.id,
      label: HAZARD_CATEGORIES[record.category].label,
      position,
    });
    publishOverlay();
    governorRequestRender('natural-hazard-selection');
    return true;
  }

  function installClickHandler() {
    if (clickHandler || !viewer) return;
    clickHandler = screenSpaceEventHandlerFactory(viewer);
    clickHandler.setInputAction((click) => {
      if (!enabled) return;
      const picked = viewer.scene.pick(click.position);
      const pickedId = resolvePickId(picked);
      const record = pickedId ? recordByEntityId.get(pickedId) : null;
      if (record) {
        focusRecord(record);
        return;
      }
      if (pickedId && isOwnedByOtherLayer(NATURAL_HAZARDS_LAYER_ID, pickedId)) return;
      const card = overlayHost.hitTest?.(click.position?.x, click.position?.y, {
        sourceId: NATURAL_HAZARDS_LAYER_ID,
      });
      if (card) {
        const cardRecord = records.find((item) => item.id === card.entryId);
        if (cardRecord) focusRecord(cardRecord);
        return;
      }
      selectedId = null;
      if (hasContextHost()) clearSelectedEntityContextForLayer(NATURAL_HAZARDS_LAYER_ID);
      publishOverlay();
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  }

  function removeClickHandler() {
    clickHandler?.destroy?.();
    clickHandler = null;
  }

  async function fetchPayload(signal) {
    const fetchFn = fetchImpl || globalThis.fetch;
    const controller = new AbortController();
    activeController?.abort('superseded');
    activeController = controller;
    const timeoutId = globalThis.setTimeout?.(() => controller.abort('timeout'), 15_000);
    const abort = () => controller.abort(signal?.reason || 'cancelled');
    signal?.addEventListener?.('abort', abort, { once: true });
    try {
      const response = await fetchFn(NATURAL_HAZARDS_ENDPOINT, {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
        signal: controller.signal,
      });
      let payload = {};
      try { payload = await response.json(); } catch { payload = {}; }
      if (!response.ok) throw new Error(`hazards HTTP ${response.status}`);
      return normalizeHazardPayload(payload);
    } finally {
      if (timeoutId != null) globalThis.clearTimeout?.(timeoutId);
      signal?.removeEventListener?.('abort', abort);
      if (activeController === controller) activeController = null;
    }
  }

  const layer = {
    id: NATURAL_HAZARDS_LAYER_ID,
    name: 'Natural Hazards',
    icon: '◉',
    source: 'NASA · USGS · FEMA · ReliefWeb',
    updateInterval: 5 * 60_000,

    init(nextViewer) {
      viewer = nextViewer;
      dataSource = new Cesium.CustomDataSource(NATURAL_HAZARDS_LAYER_ID);
      dataSource.show = false;
      viewer.dataSources.add(dataSource);
      overlayHost.setVisible(NATURAL_HAZARDS_LAYER_ID, false);
    },

    enable(nextViewer) {
      viewer = nextViewer || viewer;
      enabled = true;
      if (dataSource) dataSource.show = true;
      overlayHost.setVisible(NATURAL_HAZARDS_LAYER_ID, true);
      registerPickOwner(NATURAL_HAZARDS_LAYER_ID, (id) => recordByEntityId.has(id));
      installClickHandler();
    },

    disable() {
      enabled = false;
      activeController?.abort('disabled');
      if (dataSource) dataSource.show = false;
      selectedId = null;
      overlayHost.clearSource(NATURAL_HAZARDS_LAYER_ID);
      overlayHost.setVisible(NATURAL_HAZARDS_LAYER_ID, false);
      if (hasContextHost()) {
        clearSelectedEntityContextForLayer(NATURAL_HAZARDS_LAYER_ID);
        removeEntityContextsForLayer(NATURAL_HAZARDS_LAYER_ID);
      }
      unregisterPickOwner(NATURAL_HAZARDS_LAYER_ID);
      removeClickHandler();
    },

    update(_viewer, { signal = null } = {}) {
      if (updatePromise) return updatePromise;
      loading = true;
      rowControlsListener?.();
      updatePromise = fetchPayload(signal)
        .then((payload) => {
          if (signal?.aborted || !enabled) return false;
          records = payload.hazards;
          context = payload.context;
          sources = payload.sources;
          answered = true;
          lastUpdate = payload.generatedAt || Date.now();
          lastError = sourceHealthSummary(sources).error;
          render();
          return true;
        })
        .catch((error) => {
          if (error?.name === 'AbortError' || signal?.aborted) return false;
          lastError = 'hazard feed unavailable';
          return false;
        })
        .finally(() => {
          loading = false;
          updatePromise = null;
          rowControlsListener?.();
        });
      return updatePromise;
    },

    destroy(nextViewer) {
      this.disable();
      if (dataSource) (nextViewer || viewer)?.dataSources?.remove?.(dataSource, true);
      dataSource = null;
      viewer = null;
      records = [];
      context = [];
      sources = {};
      lastUpdate = null;
      lastError = null;
      answered = false;
    },

    setParams(params = {}) {
      let changed = false;
      for (const category of Object.keys(HAZARD_CATEGORIES)) {
        if (!Object.hasOwn(params, category) || typeof params[category] !== 'boolean') continue;
        if (filters[category] === params[category]) continue;
        filters[category] = params[category];
        changed = true;
      }
      if (changed && dataSource) render();
      return true;
    },

    getParams() {
      return { ...filters };
    },

    getRowControls() {
      const counts = hazardCounts(records);
      const health = sourceHealthSummary(sources);
      return {
        chips: [
          ...Object.entries(HAZARD_CATEGORIES).map(([id, category]) => ({
            id,
            label: `${category.label} ${counts[id]}`,
            title: `Show ${category.label.toLowerCase()} in Natural Hazards`,
            active: filters[id],
            params: { [id]: !filters[id] },
          })),
          ...health.entries.map((entry) => ({
            id: `source-${entry.id}`,
            label: `${entry.label} ${entry.status.toUpperCase()}`,
            title: entry.fetchedAt ? `Last source response ${formatAge(entry.fetchedAt)}` : 'No source response yet',
            active: ['fresh', 'cached'].includes(entry.status),
            state: entry.status === 'unavailable' ? 'error' : (entry.status === 'stale' ? 'loading' : 'active'),
            disabled: true,
          })),
        ],
        legend: Object.entries(HAZARD_CATEGORIES).map(([id, category]) => ({
          label: category.label,
          color: category.color,
          count: counts[id],
          blurb: `${category.label} from the Natural Hazards aggregate`,
        })),
      };
    },

    setRowControlsListener(listener) {
      rowControlsListener = typeof listener === 'function' ? listener : null;
    },

    getStats() {
      const health = sourceHealthSummary(sources);
      const stale = health.stale.length > 0;
      const reportCount = context.length;
      const visibleCount = visibleHazards(records, filters).length;
      let loadingLabel = '';
      if (loading) loadingLabel = answered ? 'refreshing sources...' : 'loading four sources...';
      else if (answered && records.length === 0) loadingLabel = `NO ACTIVE EVENTS · ${reportCount} REPORTS`;
      else if (answered) loadingLabel = `${visibleCount} EVENTS · ${reportCount} REPORTS`;
      return {
        count: answered ? visibleCount : null,
        totalCount: records.length,
        contextCount: reportCount,
        lastUpdate,
        loading,
        stale,
        source: layer.source,
        error: lastError,
        unavailable: Boolean(enabled && !answered && lastError),
        loadingLabel,
        sourceStates: health.entries,
      };
    },

    getContextRecords(maxCount = 100) {
      const limit = Math.max(0, Math.min(100, Math.floor(Number(maxCount) || 0)));
      return context.slice(0, limit);
    },

    getAnalystRecords(maxCount = NATURAL_HAZARDS_RENDER_LIMIT) {
      return visibleHazards(records, filters, maxCount).map((record) => ({ ...record }));
    },

    _selectForTest(id) {
      return focusRecord(records.find((record) => record.id === id));
    },
  };

  return layer;
}

const naturalHazardsLayer = createNaturalHazardsLayer();
export default naturalHazardsLayer;