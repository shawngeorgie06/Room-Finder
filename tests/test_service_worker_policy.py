"""Execute the real SW handlers with Node's Fetch API and disposable CacheStorage.

No production server/data, browser install, or extracted source fragments are used.
The harness models navigation-only Request fields and worker lifecycle promises;
real-browser upgrade/privacy coverage remains a separate release gate.
"""
from pathlib import Path
import shutil
import subprocess

import pytest

ROOT = Path(__file__).resolve().parents[1]

HARNESS = r"""
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const origin = 'https://rooms.test';
const handlers = {};
const stores = new Map();
const calls = [];
const fetchInputs = [];
const timers = [];
let network = async () => response('public');
let clock = '2026-10-04T15:00:00.000Z';
let failStorage = false;
class Clock extends Date {
  constructor(...args) { super(...(args.length ? args : [clock])); }
  static now() { return new Date(clock).getTime(); }
}
function urlOf(input) { return new URL(typeof input === 'string' ? input : input.url, origin).href; }
function response(body = 'public', {status = 200, headers = {}, url = '', redirected = false, type = 'basic'} = {}) {
  const result = new Response(body, {status, headers});
  Object.defineProperties(result, {
    url: {value: url}, redirected: {value: redirected}, type: {value: type}
  });
  const clone = result.clone.bind(result);
  result.clone = () => {
    const copy = clone();
    Object.defineProperties(copy, {url: {value: url}, redirected: {value: redirected}, type: {value: type}});
    return copy;
  };
  return result;
}
async function fetchMock(input, options) {
  fetchInputs.push({input, options});
  const req = input instanceof Request ? (options ? new Request(input, options) : input) : new Request(urlOf(input), options);
  calls.push(req);
  return network(req);
}
const caches = {
  async open(name) {
    if (failStorage) throw new Error('CacheStorage unavailable');
    if (!stores.has(name)) stores.set(name, new Map());
    const store = stores.get(name);
    return {
      async put(key, value) { store.set(urlOf(key), value.clone()); },
      async match(key) { return store.get(urlOf(key))?.clone(); },
      async delete(key) { return store.delete(urlOf(key)); },
      async keys() { return [...store.keys()].map(url => new Request(url)); },
      async add(key) { await this.put(key, await fetchMock(key)); }
    };
  },
  async keys() { return [...stores.keys()]; },
  async delete(name) { return stores.delete(name); },
  async match(key) {
    for (const store of stores.values()) if (store.has(urlOf(key))) return store.get(urlOf(key)).clone();
  }
};
const context = vm.createContext({
  self: {location: new URL(origin + '/sw.js'), addEventListener: (name, fn) => handlers[name] = fn,
    skipWaiting: async () => {}, clients: {claim: async () => {}}},
  caches, fetch: fetchMock, URL, Request, Response, Headers, AbortController,
  Date: Clock, console,
  setTimeout: (fn, ms) => { timers.push(ms); return setTimeout(fn, Math.min(ms, 25)); },
  clearTimeout
});
vm.runInContext(fs.readFileSync(process.argv[1], 'utf8'), context);
const version = vm.runInContext('CACHE_VERSION', context);
function request(path, options = {}) {
  const {navigate = false, ...init} = options;
  const req = new Request(new URL(path, origin), {
    credentials: navigate ? 'include' : 'same-origin', redirect: navigate ? 'manual' : 'follow',
    referrer: origin + '/bookmarklet', referrerPolicy: 'strict-origin-when-cross-origin', ...init
  });
  if (navigate) Object.defineProperty(req, 'mode', {value: 'navigate'});
  return req;
}
async function dispatch(path, options = {}) {
  let result;
  let handled = false;
  const pending = [];
  const req = request(path, options);
  handlers.fetch({request: req,
    respondWith(p) { handled = true; result = Promise.resolve(p); },
    waitUntil(p) { pending.push(p); }
  });
  let value, error;
  try { value = await result; } catch (e) { error = e; }
  await Promise.all(pending);
  await new Promise(resolve => setImmediate(resolve));
  return {handled, value, error, request: req};
}
async function lifecycle(name) {
  const pending = [];
  handlers[name]({waitUntil: p => pending.push(p)});
  await Promise.all(pending);
}
async function seed(path, body = 'old public', headers = {}, name = version) {
  await (await caches.open(name)).put(path, response(body, {headers}));
}
async function hit(path) { return (await caches.open(version)).match(path); }
async function body(path) { return (await hit(path))?.text(); }
function offline() { network = async () => { throw new TypeError('offline'); }; }
const apiHeaders = {'Content-Type': 'application/json', 'X-Schedule-Version': 'schedule-fixture',
  'X-Query-Day': 'Monday', 'X-Query-Time': '10:00', 'X-Query-Timezone': 'America/New_York',
  'X-Query-Preview': '1'};
const cases = {
  async private_routes() {
    await seed('/', 'home');
    for (const path of ['/admin/visits', '/bookmarklet', '/api/export-schedule?password=fixture',
      '/api/upload-schedule', '/api/private', '/unknown', '/static/make_icons.py', '/static/sw.js']) {
      for (const navigate of [true, false]) {
        const outcome = await dispatch(path, {navigate});
        assert.equal(outcome.handled, false, `must bypass ${path}, navigate=${navigate}`);
        assert.equal(await body('/'), 'home', 'private navigation replaced home');
        assert.equal(await hit(path), undefined, 'private entry cached');
      }
    }
    offline();
    assert.equal((await dispatch('/admin/visits', {navigate: true})).handled, false);
    const home = await dispatch('/', {navigate: true});
    assert.equal(await home.value.text(), 'home');
  },
  async credentials() {
    for (const path of ['/', '/api/rooms', '/static/app.js']) {
      const navigate = path === '/';
      for (const header of ['Authorization', 'Proxy-Authorization', 'X-Upload-Password', 'X-Api-Key', 'X-Access-Token']) {
        assert.equal((await dispatch(path, {navigate, headers: {[header]: 'fixture-only'}})).handled, false, header);
      }
      for (const key of ['password', 'token', 'access_token', 'api_key', 'Authorization', 'secret', 'unknown']) {
        assert.equal((await dispatch(`${path}?${key}=fixture-only`, {navigate})).handled, false, key);
      }
      assert.equal((await dispatch(path, {navigate, cache: 'no-store'})).handled, false);
      assert.equal((await dispatch(path, {navigate, headers: {'Cache-Control': 'no-store'}})).handled, false);
      assert.equal((await dispatch(path, {method: 'POST'})).handled, false);
    }
    assert.equal((await dispatch('/static/app.js', {headers: {Range: 'bytes=0-9'}})).handled, false);
    assert.equal(calls.length, 0);
  },
  async request_credentials_preserved() {
    network = async req => response('public', {headers: req.url.includes('/api/') ? apiHeaders : {}});
    for (const [path, options] of [['/', {navigate: true}], ['/api/rooms', {}], ['/static/app.js', {}]]) {
      const out = await dispatch(path, options);
      assert.equal(out.handled, true);
      const sent = calls.at(-1);
      assert.equal(fetchInputs.at(-1).input, out.request, 'fetch must receive the original Request');
      assert.equal(fetchInputs.at(-1).options, undefined, 'RequestInit reconstruction changes navigation referrers');
      assert.equal(sent, out.request);
      assert.equal(sent.mode, options.navigate ? 'navigate' : 'cors');
      assert.equal(sent.referrer, origin + '/bookmarklet');
      assert.equal(sent.referrerPolicy, 'strict-origin-when-cross-origin');
      assert.equal(sent.credentials, options.navigate ? 'include' : 'same-origin', 'preserve public visitor-cookie behavior');
      assert.equal(sent.redirect, options.navigate ? 'manual' : 'follow', 'preserve original network redirect behavior');
      assert.equal(sent.cache, 'default', 'preserve ordinary HTTP-cache semantics');
    }
  },
  async visitor_cookie_preserved() {
    network = async () => response('public visitor home');
    const out = await dispatch('/', {navigate: true, headers: {Cookie: 'room_finder_visitor=fixture-visitor'}});
    assert.equal(out.handled, true);
    assert.equal(calls.at(-1).credentials, 'include');
    assert.equal(calls.at(-1).headers.get('Cookie'), 'room_finder_visitor=fixture-visitor');
    assert.equal(await body('/'), 'public visitor home');
    // Cookies are not authentication for these nonpersonalized public routes.
    assert.equal((await dispatch('/api/rooms', {credentials: 'include'})).handled, true);
  },
  async home_identity() {
    network = async () => response('home');
    await dispatch('/?view=rooms&building=CKB&at=10%3A00&for=60&day=Monday&room=G-08', {navigate: true});
    assert.equal(await body('/'), 'home');
    assert.equal(stores.get(version).size, 1, 'home shell has exactly one canonical key');
    network = async () => response('bookmarklet');
    assert.equal((await dispatch('/bookmarklet', {navigate: true})).handled, false);
    assert.equal((await dispatch('/')).handled, false, 'non-navigation home cannot fill shell');
    offline();
    assert.equal(await (await dispatch('/?saved=1', {navigate: true})).value.text(), 'home');
    assert.equal((await dispatch('/missing', {navigate: true})).handled, false);
    assert.equal((await dispatch('/static/app.js', {navigate: true})).handled, false);
  },
  async response_policy() {
    const rejected = [
      {status: 404}, {status: 500}, {status: 401}, {status: 403}, {status: 206}, {status: 302},
      {headers: {'Cache-Control': 'public, NO-STORE'}},
      {headers: {'Cache-Control': 'private="X-User", max-age=60'}},
      {headers: {'Vary': '*'}}, {headers: {'Vary': 'Accept-Encoding, Cookie'}},
      {headers: {'Vary': 'Authorization'}},
      {redirected: true, url: origin + '/admin/visits'},
      {url: origin + '/bookmarklet'}, {url: 'https://other.test/'},
      {type: 'opaque'}, {type: 'opaqueredirect'}, {type: 'error'}
    ];
    for (const [path, options] of [['/', {navigate: true}], ['/api/rooms?day=Monday', {}], ['/static/app.js', {}]]) {
      for (const props of rejected) {
        stores.clear();
        network = async () => response('not cacheable', props);
        const out = await dispatch(path, options);
        assert.equal(out.handled, true);
        assert.equal(await hit(path), undefined, `${path}: ${JSON.stringify(props)}`);
        assert.equal(await hit('/'), undefined, 'unsafe shell cached');
      }
    }
  },
  async http_errors() {
    const path = '/api/rooms?day=Monday';
    network = async () => response('good', {headers: apiHeaders});
    await dispatch(path);
    for (const status of [400, 404, 429, 500, 503]) {
      network = async () => response('failure', {status});
      const out = await dispatch(path);
      assert.equal(out.value.status, status, 'HTTP error must not look like offline success');
      assert.equal(await out.value.text(), 'failure');
      assert.equal(await body(path), 'good', 'HTTP error poisoned last known public data');
    }
  },
  async private_response_revokes_old_entry() {
    for (const path of ['/', '/api/rooms']) {
      await seed(path);
      network = async () => response('now private', {headers: {'Cache-Control': 'private, no-store'}});
      await dispatch(path, {navigate: path === '/'});
      assert.equal(await hit(path), undefined, 'no-store response must retire prior public entry');
      offline();
      const out = await dispatch(path, {navigate: path === '/'});
      assert.ok(out.error || !out.value || out.value.type === 'error');
    }
  },
  async freshness_and_query_keys() {
    const paths = ['/api/rooms?day=Monday&at=10%3A00&for=60', '/api/rooms?day=Tuesday&at=10%3A00&for=60',
      '/api/rooms?day=Monday&at=10%3A00&until=11%3A00&building=CKB',
      '/api/room/schedule?building=CKB&room=G-08&_weekday=0&at=10%3A00',
      '/api/buildings', '/api/rooms/all', '/api/heatmap?building=CKB', '/api/terms', '/api/schedule-info'];
    network = async req => response(req.url, {headers: {...apiHeaders,
      'X-Room-Finder-Fetched-At': 'untrusted upstream timestamp', 'X-Room-Finder-Cache': 'offline'}});
    for (const path of paths) {
      const out = await dispatch(path);
      assert.equal(out.value.headers.get('X-Room-Finder-Cache'), 'network');
      assert.equal(out.value.headers.get('X-Room-Finder-Fetched-At'), clock);
      assert.equal(await out.value.text(), origin + path);
    }
    const original = clock;
    clock = '2026-10-04T17:00:00.000Z';
    offline();
    for (const path of paths) {
      const out = await dispatch(path);
      assert.equal(out.value.headers.get('X-Room-Finder-Cache'), 'offline');
      assert.equal(out.value.headers.get('X-Room-Finder-Fetched-At'), original);
      for (const [key, value] of Object.entries(apiHeaders)) assert.equal(out.value.headers.get(key), value);
      assert.equal(await out.value.text(), origin + path, 'query keys collapsed');
    }
    const miss = await dispatch('/api/rooms?day=Wednesday');
    assert.ok(miss.error || !miss.value || miss.value.type === 'error', 'different query got fallback data');
  },
  async install_policy() {
    const bad = [{headers: {'Cache-Control': 'no-store'}}, {headers: {'Cache-Control': 'private'}},
      {redirected: true, url: origin + '/admin/visits'}, {status: 500}, {type: 'opaque'}];
    for (const props of bad) {
      stores.clear();
      network = async () => response('unsafe install', props);
      await lifecycle('install');
      assert.equal(stores.get(version)?.size || 0, 0, 'install bypassed response safety');
    }
    stores.clear();
    network = async () => response('public install');
    await lifecycle('install');
    assert.equal(await body('/'), 'public install');
    assert.equal(await body('/static/app.js'), 'public install');
    for (const call of calls) {
      assert.equal(call.credentials, 'same-origin');
      assert.equal(call.redirect, 'follow');
    }
  },
  async contaminated_upgrade() {
    assert.notEqual(version, 'room-finder-v13', 'contaminated cache namespace must be retired');
    await seed('/', 'PRIVATE VISITOR REPORT', {}, 'room-finder-v13');
    await seed('/api/export-schedule?password=fixture', 'PRIVATE EXPORT', {}, 'room-finder-v13');
    await seed('/', 'old shell', {}, 'room-finder-v5');
    await seed('/', 'unrelated', {}, 'another-app-v1');
    await seed('/', 'unrelated prefix', {}, 'room-finder-notes');
    network = async () => response('fresh home');
    await lifecycle('install');
    await lifecycle('activate');
    assert.equal(stores.has('room-finder-v13'), false);
    assert.equal(stores.has('room-finder-v5'), false);
    assert.equal(stores.has('another-app-v1'), true);
    assert.equal(stores.has('room-finder-notes'), true);
    offline();
    assert.equal(await (await dispatch('/', {navigate: true})).value.text(), 'fresh home');
    stores.delete(version);
    const miss = await dispatch('/', {navigate: true});
    assert.ok(miss.error || !miss.value || miss.value.type === 'error', 'read unrelated origin cache');
  },
  async hung_network() {
    for (const [path, options] of [['/', {navigate: true}], ['/api/rooms', {}]]) {
      network = async () => response('good', {headers: apiHeaders});
      await dispatch(path, options);
      let signal;
      network = req => { signal = req.signal; return new Promise(() => {}); };
      const out = await Promise.race([dispatch(path, options),
        new Promise((_, reject) => setTimeout(() => reject(new Error('SW fetch hung without fallback')), 200))]);
      assert.equal(await out.value.text(), 'good');
      assert.equal(signal, out.request.signal, 'network receives the original cancellation signal');
      assert.equal(signal.aborted, false, 'timeout abandons an unchanged request instead of reconstructing it');
      if (path.startsWith('/api/')) assert.equal(out.value.headers.get('X-Room-Finder-Cache'), 'offline');
    }
    const miss = await dispatch('/api/rooms?day=Sunday');
    assert.ok(miss.error || !miss.value || miss.value.type === 'error');
    assert.ok(timers.length > 0 && timers.every(ms => ms > 0 && ms <= 8000));
  },
  async cached_response_safety() {
    for (const [path, options] of [['/', {navigate: true}], ['/api/rooms', {}], ['/static/app.js', {}]]) {
      for (const headers of [{'Cache-Control': 'no-store'}, {'Cache-Control': 'private'}]) {
        await seed(path, 'PRIVATE', headers);
        offline();
        const out = await dispatch(path, options);
        assert.ok(out.error || !out.value || out.value.type === 'error', 'unsafe cached response replayed');
      }
    }
  },
  async static_allowlist() {
    const paths = ['/static/icon-512.png', '/static/icon-512-maskable.png',
      '/static/fonts/xn7gYHE41ni1AdIRggexSvfedN4.woff2',
      '/static/fonts/V8mDoQDjQSkFtoMM3T6r8E7mPbF4C_k3HqU.woff2',
      '/static/vendor/leaflet/images/marker-icon.png'];
    for (const path of paths) {
      network = async () => response('public asset');
      assert.equal((await dispatch(path)).handled, true, path);
      assert.equal(await body(path), 'public asset');
      offline();
      assert.equal(await (await dispatch(path)).value.text(), 'public asset');
    }
    for (const path of ['/static/private.json', '/static/fonts/private.woff2',
      '/static/vendor/leaflet/private.js', '/static/app.js?version=secret', '/api/terms?token=x']) {
      assert.equal((await dispatch(path)).handled, false, path);
    }
  },
  async bounded_install_and_static_miss() {
    network = () => new Promise(() => {});
    await Promise.race([lifecycle('install'), new Promise((_, reject) =>
      setTimeout(() => reject(new Error('install hung')), 200))]);
    const out = await Promise.race([dispatch('/static/app.js'), new Promise((_, reject) =>
      setTimeout(() => reject(new Error('static miss hung')), 200))]);
    assert.ok(out.error || out.value?.type === 'error');
  },
  async late_response_cannot_refresh_cache() {
    const path = '/api/rooms';
    network = async () => response('original', {headers: apiHeaders});
    await dispatch(path);
    let resolve;
    network = () => new Promise(r => { resolve = r; });
    const out = await dispatch(path);
    assert.equal(await out.value.text(), 'original');
    resolve(response('too late', {headers: apiHeaders}));
    await new Promise(r => setImmediate(r));
    assert.equal(await body(path), 'original');
  },
  async storage_and_tiles() {
    for (const path of ['https://tiles.test/1/2/3.png', 'https://other.test/api/rooms']) {
      assert.equal((await dispatch(path)).handled, false);
    }
    failStorage = true;
    network = async () => response('network without storage', {headers: apiHeaders});
    for (const [path, options] of [['/', {navigate: true}], ['/api/rooms', {}], ['/static/app.js', {}]]) {
      const out = await dispatch(path, options);
      assert.equal(await out.value.text(), 'network without storage');
    }
  }
};
(async () => {
  await cases[process.argv[2]]();
  console.log('PASS ' + process.argv[2]);
})().catch(error => { console.error(error); process.exitCode = 1; });
"""


@pytest.mark.parametrize("scenario", [
    "private_routes", "credentials", "request_credentials_preserved", "home_identity",
    "response_policy", "http_errors", "private_response_revokes_old_entry",
    "freshness_and_query_keys", "install_policy", "contaminated_upgrade",
    "hung_network", "cached_response_safety", "storage_and_tiles", "visitor_cookie_preserved",
    "static_allowlist", "bounded_install_and_static_miss", "late_response_cannot_refresh_cache",
])
def test_service_worker_policy(scenario):
    node = shutil.which("node")
    assert node, "Node is required: do not silently skip service-worker policy coverage"
    result = subprocess.run(
        [node, "-e", HARNESS, str(ROOT / "static/sw.js"), scenario],
        capture_output=True, text=True, timeout=15,
    )
    assert result.returncode == 0, f"{scenario}:\n{result.stdout}\n{result.stderr}"
    assert f"PASS {scenario}" in result.stdout
