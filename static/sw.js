/* NJIT Room Finder service worker.
 * Static assets: cache-first (updated on new CACHE_VERSION).
 * API requests: network-first with cache fallback, so the app still shows
 * the last-known room data when offline. */
const CACHE_VERSION = 'room-finder-v3';
const PRECACHE = [
  '/',
  '/static/tailwind.css',
  '/static/app.js',
  '/static/manifest.json',
  '/static/icon.svg',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_VERSION).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting())
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

  // Static + navigation: cache-first, fall back to network, then cached shell
  e.respondWith(
    caches.match(e.request).then(hit =>
      hit || fetch(e.request).catch(() =>
        e.request.mode === 'navigate' ? caches.match('/') : undefined
      )
    )
  );
});
