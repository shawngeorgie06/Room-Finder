/* NJIT Room Finder service worker.
 * Navigations: network-first, so a deploy reaches users on their next load
 *   instead of waiting for a CACHE_VERSION bump.
 * Static assets: cache-first (updated on new CACHE_VERSION).
 * API requests: network-first with cache fallback, so the app still shows
 *   the last-known room data when offline.
 * Map tiles are third-party and intentionally not cached — offline the map
 * renders its markers over an empty basemap. */
const CACHE_VERSION = 'room-finder-v6';
const PRECACHE = [
  '/',
  '/static/tailwind.css',
  '/static/app.js',
  '/static/manifest.json',
  '/static/icon.svg',
  '/static/fonts/fonts.css',
  '/static/fonts/material-symbols-subset.woff2',
  '/static/vendor/leaflet/leaflet.js',
  '/static/vendor/leaflet/leaflet.css',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_VERSION)
      // addAll is atomic: a single failure would discard the whole precache,
      // so add each entry independently and let individual misses fail quietly.
      .then(c => Promise.all(PRECACHE.map(u => c.add(u).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;

  // Navigations: network-first, cached shell as the offline fallback.
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then(resp => {
          const copy = resp.clone();
          caches.open(CACHE_VERSION).then(c => c.put('/', copy));
          return resp;
        })
        .catch(() => caches.match(e.request).then(hit => hit || caches.match('/')))
    );
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    // Network-first: fresh data when online, last-known data when offline
    e.respondWith(
      fetch(e.request)
        .then(resp => {
          const copy = resp.clone();
          caches.open(CACHE_VERSION).then(c => c.put(e.request, copy));
          return resp;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // Static assets: cache-first, falling back to the network (and caching it,
  // so font files fetched lazily by fonts.css survive going offline).
  e.respondWith(
    caches.match(e.request).then(hit =>
      hit || fetch(e.request).then(resp => {
        const copy = resp.clone();
        caches.open(CACHE_VERSION).then(c => c.put(e.request, copy));
        return resp;
      })
    )
  );
});
