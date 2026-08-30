/**
 * Shared DATA-layer factory for catalog-selected public geo feeds.
 *
 * Polls a same-origin proxy, plots a capped set of locatable points, and
 * reports honest getStats (never a silent count 0 for a feed that has not
 * answered; KEY REQUIRED for a declared missing optional key).
 *
 * @module catalogGeoLayer
 */

import * as Cesium from 'cesium';
import { governorRequestRender } from '../renderGovernor.js';
import {
  clearOverlaySource,
  setOverlayEntries,
  setOverlaySourceVisible,
} from '../overlays/worldOverlay.js';

const DEFAULT_OVERLAY_HOST = Object.freeze({
  setEntries: setOverlayEntries,
  setVisible: setOverlaySourceVisible,
  clearSource: clearOverlaySource,
});

export const CATALOG_GEO_POINT_CAP = 200;

/**
 * Camera bbox in degrees, or null when the view is too wide for a regional query.
 *
 * @param {object|null|undefined} viewer
 * @param {{ maxSpanDeg?: number }} [options]
 * @returns {{west: number, south: number, east: number, north: number}|null}
 */
export function catalogViewBbox(viewer, { maxSpanDeg = 50 } = {}) {
  const rect = viewer?.camera?.computeViewRectangle?.(viewer.scene?.globe?.ellipsoid);
  if (!rect) return null;
  const west = Cesium.Math.toDegrees(rect.west);
  const south = Cesium.Math.toDegrees(rect.south);
  const east = Cesium.Math.toDegrees(rect.east);
  const north = Cesium.Math.toDegrees(rect.north);
  if (![west, south, east, north].every(Number.isFinite)) return null;
  const span = Math.max(Math.abs(east - west), Math.abs(north - south));
  if (span > maxSpanDeg) return null;
  return { west, south, east, north };
}

/**
 * @param {Array<{id: string, lat: number, lon: number, title?: string}>} records
 * @param {number} [limit]
 * @returns {Array<object>}
 */
export function capCatalogRecords(records, limit = CATALOG_GEO_POINT_CAP) {
  const cap = Math.max(0, Math.min(CATALOG_GEO_POINT_CAP, Math.floor(Number(limit) || 0)));
  if (!Array.isArray(records) || cap === 0) return [];
  return records.slice(0, cap);
}

function finiteCoord(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * @param {object} spec
 * @returns {object} Layer module.
 */
export function createCatalogGeoLayer(spec) {
  const {
    id,
    name,
    icon,
    source,
    color = '#7ce8a4',
    updateInterval = 120000,
    endpoint,
    parsePayload,
    requiresKey = false,
    maxRecords = CATALOG_GEO_POINT_CAP,
    overlayHost = DEFAULT_OVERLAY_HOST,
    fetchImpl,
  } = spec;

  let _dataSource = null;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _keyRequired = false;
  let _loading = false;
  let _enabled = false;
  let _answered = false;
  let _coverage = '';

  async function request(viewer) {
    const fetchFn = fetchImpl || globalThis.fetch;
    const bbox = catalogViewBbox(viewer);
    const url = new URL(endpoint, 'http://local.invalid');
    if (bbox) {
      url.searchParams.set('bbox', `${bbox.west.toFixed(4)},${bbox.south.toFixed(4)},${bbox.east.toFixed(4)},${bbox.north.toFixed(4)}`);
    }
    const path = `${url.pathname}${url.search}`;
    const response = await fetchFn(path, { headers: { Accept: 'application/json' } });
    let payload = {};
    try { payload = await response.json(); } catch { payload = {}; }
    if (response.status === 503 && (payload?.error === 'no_key' || requiresKey)) {
      const error = new Error('KEY REQUIRED');
      error.keyRequired = true;
      throw error;
    }
    if (!response.ok) {
      const error = new Error(payload?.error?.message || payload?.error || `HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  const layer = {
    id,
    name,
    icon,
    source,
    updateInterval,

    init(viewer) {
      _dataSource = new Cesium.CustomDataSource(id);
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _keyRequired = false;
      _loading = false;
      _enabled = false;
      _answered = false;
      _coverage = '';
      overlayHost.setVisible(id, false);
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost.setVisible(id, true);
    },

    disable() {
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      overlayHost.clearSource(id);
      overlayHost.setVisible(id, false);
    },

    async update(viewer) {
      if (!_dataSource) return false;
      _loading = true;
      try {
        const payload = await request(viewer);
        if (payload?.coverage === 'zoom-in') {
          _coverage = 'zoom-in';
          _answered = true;
          _count = 0;
          _lastUpdate = Date.now();
          _lastError = null;
          _keyRequired = false;
          _dataSource.entities.removeAll();
          overlayHost.clearSource(id);
          overlayHost.setVisible(id, _enabled);
          governorRequestRender(`layer-tick:${id}`);
          return true;
        }
        const records = capCatalogRecords(parsePayload(payload) || [], maxRecords);
        _dataSource.entities.removeAll();
        const overlayEntries = [];
        let count = 0;
        for (const record of records) {
          const lat = finiteCoord(record.lat);
          const lon = finiteCoord(record.lon);
          if (lat == null || lon == null) continue;
          if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
          count += 1;
          const position = Cesium.Cartesian3.fromDegrees(lon, lat);
          const entityId = String(record.id || `${id}-${count}`);
          _dataSource.entities.add({
            id: entityId,
            position,
            point: {
              pixelSize: 8,
              color: Cesium.Color.fromCssColorString(color).withAlpha(0.9),
              outlineColor: Cesium.Color.BLACK.withAlpha(0.35),
              outlineWidth: 1,
              heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
            properties: {
              title: record.title || name,
              subtitle: record.subtitle || '',
            },
          });
          overlayEntries.push({
            id: entityId,
            position,
            variant: 'label',
            title: String(record.title || name).slice(0, 48),
            accent: color,
            priority: 1000 - count,
            collisionGroup: 'ambient-label',
            paintLane: 'ambient-label',
            interactive: false,
            edgeFade: 'keyhole',
            horizonCull: true,
            terrainOcclusion: false,
            gapPx: 15,
            verticalOnly: true,
            placement: 'above',
          });
        }
        overlayHost.setEntries(id, overlayEntries.slice(0, 64), {
          cohortLimit: 64,
          collisionCapacity: 32,
          moving: false,
        });
        _count = count;
        _answered = true;
        _coverage = payload?.coverage === 'viewport' ? 'viewport' : '';
        _lastUpdate = Date.now();
        _lastError = null;
        _keyRequired = false;
        governorRequestRender(`layer-tick:${id}`);
        return true;
      } catch (error) {
        if (error?.keyRequired || /KEY REQUIRED/i.test(error?.message || '')) {
          _keyRequired = true;
          _lastError = 'KEY REQUIRED';
        } else {
          _lastError = error?.message || 'request failed';
        }
        return false;
      } finally {
        _loading = false;
      }
    },

    destroy(viewer) {
      _enabled = false;
      overlayHost.clearSource(id);
      overlayHost.setVisible(id, false);
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _keyRequired = false;
      _answered = false;
      _coverage = '';
    },

    getStats() {
      const neverAnswered = !_answered;
      const zoomLimited = _coverage === 'zoom-in';
      return {
        count: neverAnswered || zoomLimited ? null : _count,
        lastUpdate: _lastUpdate,
        loading: _loading,
        keyRequired: _keyRequired,
        coverage: _coverage || undefined,
        status: zoomLimited ? 'zoom-in' : undefined,
        error: _keyRequired ? 'KEY REQUIRED' : _lastError,
        unavailable: Boolean(_enabled && neverAnswered && _lastError && !_keyRequired),
        loadingLabel: _keyRequired
          ? 'KEY REQUIRED'
          : (zoomLimited
            ? 'ZOOM IN'
            : (_lastError && neverAnswered ? _lastError : '')),
      };
    },
  };

  return layer;
}
