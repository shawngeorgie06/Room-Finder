"""Exercise the standalone map adapter in Node, without network or npm deps."""
import os
from pathlib import Path
import shutil
import subprocess

import pytest

ADAPTER = Path(__file__).resolve().parents[1] / "static" / "map.js"

MOCKS = r"""
const assert = require('node:assert/strict');
class Events {
  constructor() { this.events = new Map(); }
  on(type, fn) {
    if (!this.events.has(type)) this.events.set(type, new Set());
    this.events.get(type).add(fn); return this;
  }
  off(type, fn) { this.events.get(type)?.delete(fn); return this; }
  fire(type, event = {}) { for (const fn of [...(this.events.get(type) || [])]) fn(event); }
  addEventListener(type, fn) { this.on(type, fn); }
  removeEventListener(type, fn) { this.off(type, fn); }
  count() { return [...this.events.values()].reduce((n, set) => n + set.size, 0); }
}
class ElementMock {
  constructor() {
    this.isConnected = true;
    this.blocked = false;
    this.visible = true;
    this.ownerDocument = { defaultView: { Element: ElementMock, getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }) } };
  }
  closest() { return this.blocked ? this : null; }
  getClientRects() { return this.visible ? [{}] : []; }
  replaceChildren() {}
}
function setup(options = {}) {
  const map = new Events();
  const credit = new ElementMock();
  map.attributionControl = { getContainer: () => credit };
  map.getCenter = () => ({ lat: 40.742, lng: -74.178 });
  map.getZoom = () => 17;
  const container = Object.assign(new ElementMock(), { clientWidth: 390, clientHeight: 240 });
  map.getContainer = () => container;
  map.layers = new Set();
  map.hasLayer = layer => map.layers.has(layer);
  map.removeLayer = layer => map.layers.delete(layer);
  map.getSize = () => ({ x: 390, y: 240 });
  map.invalidateSize = options => { map.invalidated = options; };
  map.fitBounds = (bounds, options) => { map.fitted = { bounds, options }; };
  const layers = [];
  const L = { tileLayer(url, options) {
    const layer = new Events();
    Object.assign(layer, { url, options, redraws: 0 });
    layer.addTo = map => { map.layers.add(layer); layer.fire('loading'); return layer; };
    layer.redraw = () => { layer.redraws++; layer.fire('loading'); return layer; };
    layers.push(layer);
    return layer;
  }};
  const network = new Events();
  const navigator = { onLine: true };
  const statuses = [];
  if (options.beforeCreate) options.beforeCreate(map, credit);
  const adapter = api.createLayers(L, map, {
    eventTarget: network, navigator, onStatus: status => statuses.push(status), ...options
  });
  handles.push(adapter);
  return { map, layers, network, navigator, statuses, adapter };
}
function loaded(layer, tile = {}) {
  layer.fire('tileload', { tile });
  layer.fire('load');
  return tile;
}
const handles = [];
"""


def run_node(tmp_path, body):
    node = shutil.which("node")
    assert node, "Node is required; map coverage must not silently skip"
    script = (
        f"const api = require({str(ADAPTER)!r});\n" + MOCKS
        + "\n(async () => { try {\n" + body
        + "\n} finally { handles.forEach(handle => handle.destroy()); } })()"
        + ".catch(error => { console.error(error); process.exitCode = 1; });"
    )
    env = {key: value for key, value in os.environ.items()
           if key not in {"NODE_OPTIONS", "NODE_PATH"}}
    result = subprocess.run([node, "-e", script], cwd=tmp_path, env=env,
                            capture_output=True, text=True, timeout=15)
    assert result.returncode == 0, result.stdout + result.stderr


def test_view_changes_never_invent_failures_or_top_level_loading(tmp_path):
    run_node(tmp_path, r"""
const { adapter, layers: [base], statuses } = setup();
const tile = loaded(base);
const before = statuses.length;
base.fire('tileunload', { tile }); // Real zoom/fit unloads before the next loading.
assert.equal(adapter.getStatus().state, 'ready');
base.fire('loading');
assert.equal(adapter.getStatus().state, 'ready');
assert.equal(adapter.getStatus().layers.base, 'loading');
loaded(base);
assert.ok(statuses.slice(before).every(status => status.state === 'ready' && !status.fallback));
base.fire('loading');
base.fire('tileerror', { tile: {} });
assert.equal(adapter.getStatus().state, 'base-error', 'real failures must still surface');
""")


def test_subsequent_view_timeout_still_surfaces(tmp_path):
    run_node(tmp_path, r"""
const { adapter, layers: [base] } = setup({ timeoutMs: 10 });
const tile = loaded(base);
base.fire('tileunload', { tile });
base.fire('loading');
assert.equal(adapter.getStatus().state, 'ready');
await new Promise(resolve => setTimeout(resolve, 25));
assert.equal(adapter.getStatus().state, 'timeout');
loaded(base);
assert.equal(adapter.getStatus().state, 'ready');
""")


@pytest.mark.parametrize('bad_credit', [
    "credit.isConnected = false", "credit.visible = false", "credit.blocked = true",
    "map.attributionControl = {}", "map.attributionControl = {getContainer: () => ({})}",
])
def test_rejects_unusable_actual_attribution_control(tmp_path, bad_credit):
    run_node(tmp_path, f"""
const {{ adapter, layers }} = setup({{ beforeCreate(map, credit) {{ {bad_credit}; }} }});
assert.equal(adapter.getStatus().state, 'unconfigured');
assert.equal(layers.length, 0);
""")


@pytest.mark.parametrize('element', [
    '{ ownerDocument: {}, replaceChildren() {} }',
    '{ ownerDocument: { defaultView: {} }, replaceChildren() {} }',
])
def test_non_element_external_attribution_is_safe(tmp_path, element):
    run_node(tmp_path, f"""
const {{ adapter, layers }} = setup({{
  beforeCreate(map) {{ map.attributionControl = null; }},
  attributionElement: {element}
}});
assert.equal(adapter.getStatus().state, 'unconfigured');
assert.equal(layers.length, 0);
""")


def test_no_view_refuses_layers_timers_and_listeners(tmp_path):
    run_node(tmp_path, r"""
const { adapter, layers, statuses, network, map } = setup({ timeoutMs: 10,
  beforeCreate(map) { map.getCenter = () => { throw Error('Set map center and zoom first.'); }; }
});
assert.equal(adapter.getStatus().state, 'unconfigured');
assert.equal(layers.length, 0);
assert.equal(network.count(), 0);
assert.equal(map.count(), 0);
await new Promise(resolve => setTimeout(resolve, 25));
assert.equal(statuses.length, 1);
assert.equal(adapter.retry(), false);
""")


def test_hidden_fit_has_no_side_effects_even_with_cached_nonzero_map_size(tmp_path):
    run_node(tmp_path, r"""
const { map } = setup();
map.getContainer = () => Object.assign(new ElementMock(), { clientWidth: 0, clientHeight: 0 });
assert.equal(api.fitToCampus(map, { A: [40.742, -74.178] }), false);
assert.equal(map.invalidated, undefined);
assert.equal(map.fitted, undefined);
""")


def test_external_credit_omits_base_and_labels_attribution_for_unusable_control(tmp_path):
    run_node(tmp_path, r"""
const external = new ElementMock();
external.ownerDocument.createElement = () => ({});
external.ownerDocument.createTextNode = text => ({ text });
external.replaceChildren = (...nodes) => { external.nodes = nodes; };
let removed = 0;
const config = api.getLayerConfig();
config.labels = { ...config.base, url: 'https://labels.example.test/{z}/{x}/{y}.png' };
const { layers } = setup({ config, attributionElement: external,
  beforeCreate(map, credit) {
    credit.blocked = true;
    map.attributionControl.remove = () => { removed++; };
  }
});
assert.equal(removed, 1);
assert.equal(layers.length, 2);
for (const layer of layers) assert.equal(Object.hasOwn(layer.options, 'attribution'), false);
assert.equal(external.nodes.length, 1, 'duplicate provider credits are combined');
assert.equal(external.nodes[0].textContent, '© OpenStreetMap contributors');
assert.equal(external.nodes[0].href, 'https://www.openstreetmap.org/copyright');
""")


def test_usable_own_control_is_not_removed(tmp_path):
    run_node(tmp_path, r"""
const { layers: [base] } = setup({ beforeCreate(map) {
  map.attributionControl.remove = () => { throw Error('usable control must not be removed'); };
}});
assert.match(base.options.attribution, /OpenStreetMap contributors/);
""")


def test_default_provider_attribution_and_no_prefetch(tmp_path):
    run_node(tmp_path, r"""
const config = api.getLayerConfig();
assert.equal(config.base.url, 'https://tile.openstreetmap.org/{z}/{x}/{y}.png');
assert.equal(config.labels, null);
assert.equal(config.base.attribution[0].url, 'https://www.openstreetmap.org/copyright');
assert.match(config.base.attribution[0].text, /OpenStreetMap contributors/);
config.base.url = 'changed';
assert.notEqual(api.getLayerConfig().base.url, 'changed');
const { layers, adapter } = setup();
assert.equal(layers.length, 1);
assert.equal(adapter.baseLayer, layers[0]);
assert.equal(adapter.labelsLayer, null);
assert.match(layers[0].options.attribution, /href="https:\/\/www.openstreetmap.org\/copyright"/);
assert.equal(layers[0].options.keepBuffer, 0);
assert.equal(layers[0].options.detectRetina, false);
assert.equal(layers[0].options.referrerPolicy, 'strict-origin-when-cross-origin');
assert.equal(layers[0].options.updateWhenIdle, true);
""")


def test_success_error_partial_success_and_recovery(tmp_path):
    run_node(tmp_path, r"""
const { layers: [base], adapter, statuses } = setup();
assert.equal(statuses[0].state, 'loading');
loaded(base);
assert.equal(adapter.getStatus().state, 'ready');
const failed = {};
base.fire('loading');
base.fire('tileerror', { tile: failed });
assert.equal(adapter.getStatus().state, 'base-error');
assert.equal(adapter.getStatus().fallback, true);
loaded(base); // A different tile loading must not conceal the failed tile.
assert.equal(adapter.getStatus().state, 'base-error');
loaded(base, failed);
assert.equal(adapter.getStatus().state, 'ready');
assert.equal(adapter.getStatus().fallback, false);
const before = statuses.length;
base.fire('load');
assert.equal(statuses.length, before, 'unchanged status should not spam live regions');
const copy = adapter.getStatus();
copy.layers.base = 'error';
assert.equal(adapter.getStatus().layers.base, 'ready');
""")


def test_unloaded_failed_tile_no_longer_poisoning_view(tmp_path):
    run_node(tmp_path, r"""
const { layers: [base], adapter } = setup();
const tile = {};
base.fire('tileerror', { tile });
loaded(base);
assert.equal(adapter.getStatus().state, 'base-error');
base.fire('tileunload', { tile });
assert.equal(adapter.getStatus().state, 'ready');
""")


def test_label_failure_is_not_a_basemap_failure(tmp_path):
    run_node(tmp_path, r"""
const config = api.getLayerConfig();
config.labels = {
  url: 'https://labels.example.test/{z}/{x}/{y}.png',
  attribution: [{ text: 'Test labels', url: 'https://labels.example.test/terms' }]
};
const { layers: [base, labels], adapter } = setup({ config });
loaded(base);
const tile = {};
labels.fire('tileerror', { tile });
labels.fire('load');
const status = adapter.getStatus();
assert.equal(status.state, 'labels-error');
assert.equal(status.layers.base, 'ready');
assert.equal(status.layers.labels, 'error');
assert.equal(status.fallback, false);
assert.match(status.message, /labels/i);
loaded(labels, tile);
assert.equal(adapter.getStatus().state, 'ready');
""")


def test_offline_and_reconnect_retry_without_auto_retry_loop(tmp_path):
    run_node(tmp_path, r"""
const { layers: [base], adapter, network, navigator } = setup();
loaded(base);
navigator.onLine = false;
network.fire('offline');
assert.equal(adapter.getStatus().state, 'offline');
assert.equal(adapter.getStatus().fallback, true);
base.fire('tileerror', { tile: {} });
assert.equal(adapter.getStatus().state, 'offline');
assert.equal(adapter.retry(), false);
assert.equal(base.redraws, 0);
navigator.onLine = true;
network.fire('online');
assert.equal(base.redraws, 1);
assert.equal(adapter.getStatus().state, 'loading');
loaded(base);
assert.equal(adapter.getStatus().state, 'ready');
network.fire('online');
assert.equal(base.redraws, 1, 'duplicate online event must not fetch again');
assert.equal(adapter.retry(), true);
assert.equal(base.redraws, 2);
""")


def test_initial_offline_status(tmp_path):
    run_node(tmp_path, r"""
const { adapter, statuses } = setup({ navigator: { onLine: false } });
assert.equal(statuses[0].state, 'offline');
assert.match(adapter.getStatus().message, /building list/i);
""")


@pytest.mark.parametrize("config", [
    "null", "{}", "api.getLayerConfig('unknown')",
    "{base: {url: 'http://unsafe.test/{z}/{x}/{y}', attribution: []}}",
    "{base: {url: 'https://tiles.test/{z}/{x}/{y}', attribution: []}}",
    "{base: {url: 'https://tiles.test/{z}/{x}/{y}', "
    "attribution: [{text:'Bad', url:'javascript:alert(1)'}]}}",
])
def test_unconfigured_or_invalid_provider_creates_no_tiles(tmp_path, config):
    run_node(tmp_path, f"""
const {{ adapter, layers, statuses }} = setup({{config: {config}}});
assert.equal(layers.length, 0);
assert.equal(statuses[0].state, 'unconfigured');
assert.equal(adapter.getStatus().fallback, true);
assert.match(adapter.getStatus().message, /building list/i);
assert.equal(adapter.retry(), false);
""")


def test_invalid_labels_preserve_working_basemap(tmp_path):
    run_node(tmp_path, r"""
const config = api.getLayerConfig();
config.labels = {};
const { layers, adapter } = setup({ config });
assert.equal(layers.length, 1);
loaded(layers[0]);
assert.equal(adapter.getStatus().state, 'labels-error');
assert.equal(adapter.getStatus().layers.labels, 'unconfigured');
""")


def test_timeout_recovery_and_teardown(tmp_path):
    run_node(tmp_path, r"""
const { adapter, layers: [base], network, map, statuses } = setup({ timeoutMs: 10 });
await new Promise(resolve => setTimeout(resolve, 25));
assert.equal(adapter.getStatus().state, 'timeout');
assert.match(adapter.getStatus().message, /timed out/i);
assert.equal(base.redraws, 0);
loaded(base);
assert.equal(adapter.getStatus().state, 'ready');
base.fire('loading');
adapter.destroy();
adapter.destroy();
const count = statuses.length;
assert.equal(base.count(), 0);
assert.equal(network.count(), 0);
assert.equal(map.count(), 0);
assert.equal(map.layers.size, 0);
assert.equal(adapter.retry(), false);
network.fire('online');
base.fire('tileerror', { tile: {} });
await new Promise(resolve => setTimeout(resolve, 25));
assert.equal(statuses.length, count);
""")


def test_map_unload_disposes_callbacks(tmp_path):
    run_node(tmp_path, r"""
const { map, network, layers: [base], adapter } = setup();
map.fire('unload');
assert.equal(network.count(), 0);
assert.equal(base.count(), 0);
assert.equal(adapter.retry(), false);
""")


def test_fit_campus_filters_unknown_points_and_preserves_map_interaction(tmp_path):
    run_node(tmp_path, r"""
const { map } = setup();
assert.equal(api.fitToCampus(map, {
  A: [40.742, -74.18], B: [40.744, -74.17], unknown: null,
  bad: [NaN, 1], bad2: [91, 0], bad3: ['40', -74], bad4: [40, Infinity]
}), true);
assert.deepEqual(map.fitted.bounds, [[40.742, -74.18], [40.744, -74.17]]);
assert.deepEqual(map.fitted.options, { padding: [24, 24], maxZoom: 17, animate: false });
assert.deepEqual(map.invalidated, { pan: false, animate: false });
map.fitted = null;
assert.equal(api.fitToCampus(map, {}), false);
assert.equal(map.fitted, null);
map.getSize = () => ({ x: 0, y: 0 });
assert.equal(api.fitToCampus(map, [[40.742, -74.18]]), false);
assert.equal(map.fitted, null, 'caller must retry fit after making its container visible');
map.getSize = () => ({ x: 100, y: 100 });
assert.equal(api.fitToCampus(map, [[40.742, -74.18]], { maxZoom: 16 }), true);
assert.equal(map.fitted.options.maxZoom, 16);
""")


def test_missing_leaflet_returns_actionable_fallback(tmp_path):
    run_node(tmp_path, r"""
const statuses = [];
const adapter = api.createLayers(null, {}, { onStatus: s => statuses.push(s) });
handles.push(adapter);
assert.equal(adapter.baseLayer, null);
assert.equal(adapter.getStatus().state, 'unavailable');
assert.equal(statuses[0].fallback, true);
assert.match(statuses[0].message, /building list/i);
assert.equal(adapter.retry(), false);
""")


def test_load_with_only_errors_never_reports_ready(tmp_path):
    run_node(tmp_path, r"""
const { layers: [base], adapter } = setup();
base.fire('tileerror', { tile: {} });
base.fire('load'); // Leaflet load means settled, NOT successful.
assert.equal(adapter.getStatus().state, 'base-error');
assert.equal(adapter.retry(), true);
base.fire('load');
assert.notEqual(adapter.getStatus().state, 'ready');
loaded(base);
assert.equal(adapter.getStatus().state, 'ready');
""")


def test_labels_timeout_keeps_basemap_usable(tmp_path):
    run_node(tmp_path, r"""
const config = api.getLayerConfig();
config.labels = { ...config.base, url: 'https://labels.example.test/{z}/{x}/{y}.png' };
const { layers: [base, labels], adapter } = setup({ config, timeoutMs: 10 });
loaded(base);
await new Promise(resolve => setTimeout(resolve, 25));
assert.equal(adapter.getStatus().state, 'labels-error');
assert.equal(adapter.getStatus().layers.labels, 'timeout');
assert.equal(adapter.getStatus().fallback, false);
loaded(labels);
assert.equal(adapter.getStatus().state, 'ready');
""")


def test_no_requests_on_initial_offline_until_reconnected(tmp_path):
    run_node(tmp_path, r"""
const offline = { onLine: false };
const { map, adapter, network, layers: [base] } = setup({ navigator: offline });
assert.equal(map.layers.size, 0);
assert.equal(adapter.retry(), false);
offline.onLine = true;
network.fire('online');
assert.equal(map.layers.size, 1);
loaded(base);
assert.equal(adapter.getStatus().state, 'ready');
""")


def test_requires_attribution_sink_before_requesting_tiles(tmp_path):
    run_node(tmp_path, r"""
const statuses = [];
const map = { removeLayer() {} };
const adapter = api.createLayers({ tileLayer() { throw Error('must not create'); } }, map, {
  onStatus: s => statuses.push(s)
});
handles.push(adapter);
assert.equal(adapter.getStatus().state, 'unconfigured');
assert.equal(adapter.baseLayer, null);
assert.match(statuses[0].message, /attribution/i);
""")


def test_each_map_has_independent_error_and_network_lifecycle(tmp_path):
    run_node(tmp_path, r"""
const first = setup();
const second = setup();
loaded(first.layers[0]);
loaded(second.layers[0]);
first.layers[0].fire('tileerror', { tile: {} });
assert.equal(first.adapter.getStatus().state, 'base-error');
assert.equal(second.adapter.getStatus().state, 'ready');
first.adapter.destroy();
assert.ok(second.network.count() > 0);
assert.equal(second.adapter.retry(), true);
""")


def test_attribution_html_escapes_custom_provider_text(tmp_path):
    run_node(tmp_path, r"""
const config = api.getLayerConfig();
config.base.attribution = [{ text: '<img src=x onerror=bad()>', url: 'https://example.test/?a="bad"&b=1' }];
const { layers: [base] } = setup({ config });
assert.ok(!base.options.attribution.includes('<img'));
assert.ok(base.options.attribution.includes('&lt;img'));
assert.ok(base.options.attribution.includes('&quot;'));
""")
