/* Standalone Leaflet adapter; the caller owns markers, visibility and the building list.
 * OSM standard raster terms checked 2026-10-04:
 * https://operations.osmfoundation.org/policies/tiles/
 * https://www.openstreetmap.org/copyright
 * https://osmfoundation.org/wiki/Licence/Attribution_Guidelines
 * Browser image requests retain normal HTTP caching and an origin Referer. No
 * prefetch, offline downloads, credentials or cache-busting. Service is best-effort.
 */
(function (root) {
  'use strict';

  function getLayerConfig(provider = 'osm-standard') {
    if (provider !== 'osm-standard') return null;
    return {
      id: provider,
      base: {
        url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
        maxZoom: 19,
        attribution: [{ text: '© OpenStreetMap contributors', url: 'https://www.openstreetmap.org/copyright' }]
      },
      labels: null // Street/building labels are already part of the standard tiles.
    };
  }

  function secureURL(value) {
    if (typeof value !== 'string' || !value.startsWith('https://')) return false;
    try {
      const url = new URL(value);
      return !!url.hostname && !url.username && !url.password;
    } catch (_) { return false; }
  }

  function validLayer(layer) {
    return !!layer && secureURL(layer.url) && ['{z}', '{x}', '{y}'].every(token => layer.url.includes(token)) &&
      Array.isArray(layer.attribution) && layer.attribution.length > 0 &&
      layer.attribution.every(item => item && typeof item.text === 'string' && item.text.trim() && secureURL(item.url));
  }

  function escapeHTML(text) {
    return text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  }

  function attributionHTML(items) {
    return items.map(item => `<a href="${escapeHTML(item.url)}">${escapeHTML(item.text)}</a>`).join(' | ');
  }

  function visibleElement(element) {
    const view = element && element.ownerDocument && element.ownerDocument.defaultView;
    if (!view || typeof view.Element !== 'function' || !(element instanceof view.Element) ||
        !element.isConnected || !element.getClientRects().length) return false;
    for (let node = element; node; node = node.parentElement) {
      const style = view.getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' ||
          style.opacity === '0' || style.contentVisibility === 'hidden') return false;
    }
    return true;
  }

  function usableAttribution(element) {
    return visibleElement(element) && !element.closest('button, a, [role="button"], [inert], [hidden], [aria-hidden="true"]');
  }

  function hasView(map) {
    try {
      const center = map.getCenter(); // Leaflet throws before its first setView/fitBounds.
      return Number.isFinite(center.lat) && Number.isFinite(center.lng) && Number.isFinite(map.getZoom());
    } catch (_) { return false; }
  }

  /**
   * onStatus receives {state, message, fallback, layers:{base,labels}} immediately
   * and on changes. Update role=status textContent only when state/message changes,
   * not for layers-only progress, to avoid repeating announcements during panning.
   * Keep the building list reachable, especially when fallback is true.
   * A labels-error leaves the base usable. Missing dependencies => unavailable;
   * missing/invalid config or attribution sink => unconfigured. Tile HTTP errors
   * (including provider denial) are opaque to Leaflet and reported as base-error.
   *
   * For an inert preview use attributionControl:false and pass a visible sibling
   * attributionElement OUTSIDE the preview button/inert subtree. This adapter
   * never enables interactions. Do not create layers for off-screen maps. Call
   * after setView/fitBounds and after showing the attribution (opacity:0 is
   * refused too). With a valid external sibling, an unusable own attribution
   * control is removed to avoid nested/inert links, including Leaflet's prefix.
   * It is not restored by destroy; recreate it if the caller changes the layout.
   * Without a view or usable attribution, this handle remains unconfigured;
   * create a new one once those prerequisites are met (no timers/listeners are
   * installed on refusal).
   * Explicit null config disables tiles; omitted config selects OSM standard.
   * eventTarget/navigator are optional network test seams (default: window).
   */
  function createLayers(L, map, options = {}) {
    const config = options.config === undefined ? getLayerConfig() : options.config;
    const target = options.eventTarget || root;
    const navigator = options.navigator || root.navigator || {};
    const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 12000;
    const records = { base: null, labels: null };
    const listeners = [];
    let offline = navigator.onLine === false;
    let destroyed = false;
    let lastStatus = '';
    let hasBeenReady = false;
    const unavailable = !L || typeof L.tileLayer !== 'function' || !map || typeof map.removeLayer !== 'function';
    let configured = validLayer(config && config.base);
    const invalidLabels = !!(config && config.labels != null && !validLayer(config.labels));
    const attribution = options.attributionElement;
    // A truthy control object does not prove that its DOM is visible or attached.
    const externalCredit = usableAttribution(attribution);
    const controlCredit = !unavailable && map.attributionControl &&
      typeof map.attributionControl.getContainer === 'function' && usableAttribution(map.attributionControl.getContainer());
    if (!unavailable && ((!externalCredit && !controlCredit) || !hasView(map))) configured = false;

    function layerState(record, absent) {
      if (!record) return absent;
      if (record.failed.size || record.broken || record.settledEmpty) return 'error';
      if (record.timedOut) return 'timeout';
      // Zoom/fit unload old tiles before the next loading event. An empty set
      // during that transition is not evidence of a failed request.
      if (!record.complete || !record.loaded.size) return 'loading';
      return 'ready';
    }

    function getStatus() {
      const base = layerState(records.base, 'unconfigured');
      const labels = layerState(records.labels, invalidLabels ? 'unconfigured' : 'none');
      const baseUsable = base === 'ready' || (hasBeenReady && base === 'loading');
      let state, message, fallback = true;
      if (unavailable) {
        state = 'unavailable'; message = 'Map unavailable. Use the building list to find rooms.';
      } else if (!configured) {
        state = 'unconfigured'; message = 'Map view, provider or visible attribution is not configured. Use the building list to find rooms.';
      } else if (offline) {
        state = 'offline'; message = 'You are offline. Use the building list; map tiles may be unavailable.';
      } else if (base === 'error') {
        state = 'base-error'; message = 'Map tiles could not load. Retry or use the building list to find rooms.';
      } else if (base === 'timeout') {
        state = 'timeout'; message = 'Map loading timed out. Retry or use the building list to find rooms.';
      } else if (baseUsable && ['error', 'timeout', 'unconfigured'].includes(labels)) {
        state = 'labels-error'; message = 'Some map labels are unavailable. The basemap and building list remain usable.'; fallback = false;
      } else if (baseUsable && (['ready', 'none'].includes(labels) || (hasBeenReady && labels === 'loading'))) {
        state = 'ready'; message = 'Map ready. Building points are approximate, not verified entrances.'; fallback = false;
      } else {
        state = 'loading'; message = 'Loading map. You can use the building list while waiting.'; fallback = base !== 'ready';
      }
      return { state, message, fallback, layers: { base, labels } };
    }

    function notify() {
      if (destroyed) return;
      const status = getStatus();
      if (status.state === 'ready') hasBeenReady = true;
      const key = JSON.stringify(status);
      if (key === lastStatus) return;
      lastStatus = key;
      if (typeof options.onStatus === 'function') options.onStatus(status);
    }

    function clearTimer(record) {
      clearTimeout(record.timer);
      record.timer = null;
    }

    function startTimer(record) {
      clearTimer(record);
      if (offline || destroyed) return;
      record.timer = setTimeout(() => {
        record.timedOut = true;
        notify();
      }, timeoutMs);
    }

    function listen(object, type, handler, dom = false) {
      if (dom) {
        if (typeof object.addEventListener !== 'function') return;
        object.addEventListener(type, handler);
        listeners.push(() => object.removeEventListener(type, handler));
      } else {
        object.on(type, handler);
        listeners.push(() => object.off(type, handler));
      }
    }

    function makeLayer(definition) {
      const record = { layer: null, failed: new Set(), loaded: new Set(), complete: false, settledEmpty: false, timedOut: false, broken: false, timer: null };
      try {
        record.layer = L.tileLayer(definition.url, {
          ...(controlCredit ? { attribution: attributionHTML(definition.attribution) } : {}),
          maxZoom: Number.isFinite(definition.maxZoom) ? definition.maxZoom : 19,
          keepBuffer: 0, detectRetina: false, updateWhenIdle: true,
          referrerPolicy: 'strict-origin-when-cross-origin'
        });
        const layer = record.layer;
        listen(layer, 'loading', () => {
          record.complete = false;
          record.settledEmpty = false;
          record.timedOut = false;
          startTimer(record);
          notify();
        });
        listen(layer, 'tileerror', event => {
          record.failed.add(event.tile);
          record.loaded.delete(event.tile);
          notify();
        });
        listen(layer, 'tileload', event => {
          record.failed.delete(event.tile);
          record.loaded.add(event.tile);
          notify();
        });
        listen(layer, 'tileunload', event => {
          record.failed.delete(event.tile);
          record.loaded.delete(event.tile);
          notify();
        });
        // Leaflet emits load when tiles have settled, including failed tiles.
        listen(layer, 'load', () => {
          clearTimer(record);
          record.complete = true;
          record.settledEmpty = !record.loaded.size && !record.failed.size;
          record.timedOut = false;
          notify();
        });
      } catch (_) { record.broken = true; }
      return record;
    }

    function mount(record, redraw) {
      if (!record || !record.layer) return;
      startTimer(record);
      try {
        if (redraw && map.hasLayer(record.layer)) record.layer.redraw();
        else record.layer.addTo(map);
      } catch (_) {
        clearTimer(record);
        record.broken = true;
        notify();
      }
    }

    function retry() {
      if (destroyed || unavailable || !configured || offline) return false;
      hasBeenReady = false;
      for (const record of Object.values(records)) {
        if (!record || !record.layer) continue;
        clearTimer(record);
        record.failed.clear();
        record.loaded.clear();
        record.complete = false;
        record.settledEmpty = false;
        record.timedOut = false;
        record.broken = false;
      }
      notify();
      for (const record of Object.values(records)) mount(record, true);
      return true;
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      listeners.splice(0).forEach(remove => remove());
      for (const record of Object.values(records)) {
        if (!record) continue;
        clearTimer(record);
        if (record.layer && map.hasLayer(record.layer)) map.removeLayer(record.layer);
        record.loaded.clear();
        record.failed.clear();
      }
      // Keep adjacent attribution in place; it is owned by the caller and may
      // also describe a retained preview image during a view transition.
    }

    if (!unavailable && configured) {
      if (externalCredit) {
        const definitions = [config.base, ...(validLayer(config.labels) ? [config.labels] : [])];
        const items = definitions.flatMap(definition => definition.attribution);
        const nodes = [];
        const seen = new Set();
        for (const item of items) {
          const key = JSON.stringify([item.text, item.url]);
          if (seen.has(key)) continue;
          seen.add(key);
          if (nodes.length) nodes.push(attribution.ownerDocument.createTextNode(' | '));
          const link = attribution.ownerDocument.createElement('a');
          link.href = item.url;
          link.textContent = item.text;
          nodes.push(link);
        }
        attribution.replaceChildren(...nodes);
        if (!controlCredit && map.attributionControl && typeof map.attributionControl.remove === 'function') {
          map.attributionControl.remove();
        }
      }
      records.base = makeLayer(config.base);
      if (validLayer(config.labels)) records.labels = makeLayer(config.labels);
      listen(map, 'unload', destroy);
      listen(target, 'offline', () => {
        offline = true;
        Object.values(records).filter(Boolean).forEach(clearTimer);
        notify();
      }, true);
      listen(target, 'online', () => {
        if (!offline) return;
        offline = false;
        retry(); // One recovery attempt, never a timer-driven retry loop.
      }, true);
    }
    notify();
    if (!offline) Object.values(records).forEach(record => mount(record, false));
    return {
      baseLayer: records.base && records.base.layer,
      labelsLayer: records.labels && records.labels.layer,
      getStatus, retry, destroy
    };
  }

  // Coordinates are representative building points, not access/entrance routing.
  // Call after revealing the map; false means no valid points or a hidden map.
  function fitToCampus(map, buildingCoords, options = {}) {
    if (!map || typeof map.fitBounds !== 'function' || !buildingCoords) return false;
    const points = Object.values(buildingCoords).filter(point => Array.isArray(point) && point.length === 2 &&
      point.every(Number.isFinite) && Math.abs(point[0]) <= 90 && Math.abs(point[1]) <= 180);
    if (!points.length) return false;
    // Read the actual container, not Leaflet's cached getSize(). Invalidating a
    // now-hidden container can change its cached center and emit move events.
    const container = map.getContainer();
    if (!visibleElement(container) || container.clientWidth <= 0 || container.clientHeight <= 0) return false;
    map.invalidateSize({ pan: false, animate: false });
    const size = map.getSize();
    if (size.x <= 0 || size.y <= 0) return false;
    map.fitBounds(points, { padding: [24, 24], maxZoom: 17, animate: false, ...options });
    return true;
  }

  const api = { getLayerConfig, createLayers, fitToCampus };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RoomFinderMap = api;
})(typeof window !== 'undefined' ? window : globalThis);
