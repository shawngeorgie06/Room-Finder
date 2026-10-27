/* NJIT Room Finder service worker.
 * Only the nonpersonalized public home, bundled assets and read-only APIs
 * participate. Private routes and third-party map tiles stay network-only.
 * Home/API: network-first; assets: cache-first. Never renew replay timestamps.
 */
const CACHE_VERSION = 'room-finder-v15-ac763eb0d474b7f20a425730380c485e0a088717ca406ccad732edc054f2a3c2';
const FETCH_TIMEOUT_MS = 8000;
const PRECACHE = [
  '/',
  '/static/tailwind.css',
  '/static/reliability.js',
  '/static/map.js',
  '/static/app.js',
  '/static/manifest.json',
  '/static/icon.svg',
  '/static/icon-512.png',
  '/static/icon-512-maskable.png',
  '/static/apple-touch-icon.png',
  '/static/fonts/fonts.css',
  '/static/fonts/material-symbols-subset.woff2',
  '/static/fonts/xn7gYHE41ni1AdIRggOxSvfedN62Zw.woff2',
  '/static/fonts/xn7gYHE41ni1AdIRggSxSvfedN62Zw.woff2',
  '/static/fonts/xn7gYHE41ni1AdIRggexSvfedN4.woff2',
  '/static/fonts/xn7gYHE41ni1AdIRggixSvfedN62Zw.woff2',
  '/static/fonts/xn7gYHE41ni1AdIRggmxSvfedN62Zw.woff2',
  '/static/fonts/xn7gYHE41ni1AdIRggqxSvfedN62Zw.woff2',
  '/static/fonts/V8mDoQDjQSkFtoMM3T6r8E7mPb54C_k3HqUtEw.woff2',
  '/static/fonts/V8mDoQDjQSkFtoMM3T6r8E7mPb94C_k3HqUtEw.woff2',
  '/static/fonts/V8mDoQDjQSkFtoMM3T6r8E7mPbF4C_k3HqU.woff2',
  '/static/vendor/leaflet/leaflet.js',
  '/static/vendor/leaflet/leaflet.css',
  '/static/vendor/leaflet/images/layers-2x.png',
  '/static/vendor/leaflet/images/layers.png',
  '/static/vendor/leaflet/images/marker-icon-2x.png',
  '/static/vendor/leaflet/images/marker-icon.png',
  '/static/vendor/leaflet/images/marker-shadow.png',
];
const STATIC_PATHS = new Set(PRECACHE.slice(1));
const HOME_QUERY = new Set([
  'view', 'building', 'room', 'roomBuilding', 'day', 'at', 'for', 'until', 'freeAllDay', 'saved', 'soon',
]);
const AVAILABILITY_QUERY = ['building', 'day', 'at', 'for', 'until'];
const API_QUERY = new Map([
  ['/api/rooms', new Set(AVAILABILITY_QUERY)],
  ['/api/rooms/all', new Set(AVAILABILITY_QUERY)],
  ['/api/buildings', new Set(AVAILABILITY_QUERY)],
  ['/api/room/schedule', new Set([...AVAILABILITY_QUERY, 'room', '_weekday'])],
  ['/api/heatmap', new Set(['building'])],
  ['/api/terms', new Set()],
  ['/api/schedule-info', new Set()],
]);
const AUTH_HEADERS = [
  'Authorization', 'Proxy-Authorization', 'X-Upload-Password', 'X-Admin-Password',
  'X-Api-Key', 'X-Access-Token',
];

function forbidsStorage(headers) {
  return /(?:^|,)\s*(?:private|no-store)\s*(?:=|,|$)/i.test(headers.get('Cache-Control') || '');
}

function requestKind(request, installing = false) {
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin ||
      url.username || url.password || request.cache === 'no-store' ||
      forbidsStorage(request.headers) || request.headers.has('Range') ||
      AUTH_HEADERS.some(header => request.headers.has(header))) return null;

  // Browsers may attach HTTP-auth credentials below the visible Request headers.
  // A worker cannot reliably detect that implicit authentication. Do not strip
  // credentials/cookies: room_finder_visitor is not authentication. These
  // allowlisted routes MUST remain nonpersonalized; private routes are bypassed
  // regardless of headers, and their responses must also declare no-store.
  let kind, keys;
  if (url.pathname === '/' && (installing || request.mode === 'navigate')) {
    kind = 'home';
    keys = HOME_QUERY;
  } else if (request.mode !== 'navigate' && STATIC_PATHS.has(url.pathname)) {
    kind = 'static';
    keys = new Set();
  } else if (request.mode !== 'navigate' && API_QUERY.has(url.pathname)) {
    kind = 'api';
    keys = API_QUERY.get(url.pathname);
  } else {
    return null;
  }
  // Unknown query keys are excluded too, rather than guessing all possible
  // credential names. Keep accepted API URLs intact, including their queries.
  return [...url.searchParams.keys()].every(key => keys.has(key)) ? kind : null;
}

function privateResponse(response) {
  const vary = (response.headers.get('Vary') || '').split(',').map(s => s.trim().toLowerCase());
  // Set-Cookie is hidden from browser Fetch responses; it cannot be a safety
  // signal here. Public routes must remain nonpersonalized and private routes
  // must declare no-store. The visitor cookie does not personalize the shell.
  return forbidsStorage(response.headers) ||
    vary.some(header => header === '*' || header === 'cookie' ||
      AUTH_HEADERS.some(auth => auth.toLowerCase() === header));
}

function eligibleResponse(response, request) {
  if (response.status !== 200 || !['basic', 'default'].includes(response.type) ||
      response.redirected || privateResponse(response)) return false;
  // Never relabel redirected/private HTML as the public home. A constructed
  // cached response has no URL; network responses must have the requested URL.
  return !response.url || response.url === request.url;
}

function markedResponse(response, source) {
  const headers = new Headers(response.headers);
  headers.set('X-Room-Finder-Cache', source);
  if (source === 'network') headers.set('X-Room-Finder-Fetched-At', new Date().toISOString());
  return new Response(response.body, {
    status: response.status, statusText: response.statusText, headers,
  });
}

async function cachedResponse(key, request) {
  try {
    // Never search other namespaces, even if activation cleanup was interrupted.
    const cache = await caches.open(CACHE_VERSION);
    const hit = await cache.match(key);
    if (!hit) return null;
    if (eligibleResponse(hit, request)) return markedResponse(hit, 'offline');
    await cache.delete(key);
  } catch (_) {
    // CacheStorage may be disabled/full. Network access must still work.
  }
  return null;
}

async function storeResponse(key, response) {
  try {
    const cache = await caches.open(CACHE_VERSION);
    await cache.put(key, response);
  } catch (_) {
    // Caching is best-effort, not a prerequisite to using a successful response.
  }
}

async function forgetResponse(key) {
  try {
    await (await caches.open(CACHE_VERSION)).delete(key);
  } catch (_) {}
}

async function boundedFetch(request) {
  let timer;
  try {
    // Even adding a signal reconstructs a navigation Request in browsers,
    // changing its mode/referrer to the worker's context. Forward it unchanged.
    // Its original cancellation signal still applies. Our deadline abandons
    // (does not abort) a hung fetch; a late response cannot enter the cache.
    return await Promise.race([
      fetch(request),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Room Finder network timeout')), FETCH_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function publicResponse(request, kind, event) {
  const key = kind === 'home' ? '/' : request;
  if (kind === 'static') {
    const hit = await cachedResponse(key, request);
    if (hit) return hit;
  }
  let response;
  try {
    response = await boundedFetch(request);
  } catch (error) {
    const hit = await cachedResponse(key, request);
    if (hit) return hit;
    throw error;
  }
  if (!eligibleResponse(response, request)) {
    // An explicit privacy-policy change retires an earlier public copy. HTTP
    // errors alone stay errors and must not overwrite last-known successes.
    if (privateResponse(response)) await forgetResponse(key);
    return response;
  }
  const marked = markedResponse(response, 'network');
  const stored = storeResponse(key, marked.clone());
  if (event) event.waitUntil(stored);
  else await stored;
  return marked;
}

self.addEventListener('install', event => {
  event.waitUntil(Promise.all(PRECACHE.map(async path => {
    const request = new Request(new URL(path, self.location.origin));
    const kind = requestKind(request, true);
    if (!kind) return;
    try {
      await publicResponse(request, kind);
    } catch (_) {
      // One missing/offline asset must not discard the other safe entries.
    }
  })).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys
      .filter(key => /^room-finder-v\d+(?:-|$)/.test(key) && key !== CACHE_VERSION)
      .map(key => caches.delete(key))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  const kind = requestKind(event.request);
  if (kind) event.respondWith(publicResponse(event.request, kind, event));
});
