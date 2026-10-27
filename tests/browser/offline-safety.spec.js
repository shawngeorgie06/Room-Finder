const { test, expect } = require('./fixtures');
const { readFileSync } = require('node:fs');
const { writeFile } = require('node:fs/promises');
const path = require('node:path');

const workerSource = readFileSync(path.join(__dirname, '../../static/sw.js'), 'utf8');
const currentCache = workerSource.match(/CACHE_VERSION\s*=\s*'([^']+)'/)[1];
const visitorCookie = 'room_finder_visitor';
const privateMarker = 'PRIVATE-VISITOR-REPORT-UPGRADE-FIXTURE';
const legacyAPI = '/api/rooms/all?day=Monday&at=13%3A00&for=90';

// Archived executable v13 from commit 6e6a871 (comments/formatting omitted).
// Inline so shallow CI checkouts need no historical git objects. Install and
// activate the real predecessor before updating /sw.js to the current worker.
const legacyWorker = `
const CACHE_VERSION = 'room-finder-v13';
const PRECACHE = ['/', '/static/tailwind.css', '/static/app.js', '/static/manifest.json',
  '/static/icon.svg', '/static/fonts/fonts.css', '/static/fonts/material-symbols-subset.woff2',
  '/static/vendor/leaflet/leaflet.js', '/static/vendor/leaflet/leaflet.css'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_VERSION)
    .then(c => Promise.all(PRECACHE.map(u => c.add(u).catch(() => {}))))
    .then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).then(resp => {
      const copy = resp.clone();
      caches.open(CACHE_VERSION).then(c => c.put('/', copy));
      return resp;
    }).catch(() => caches.match(e.request).then(hit => hit || caches.match('/'))));
    return;
  }
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(fetch(e.request).then(resp => {
      const copy = resp.clone();
      caches.open(CACHE_VERSION).then(c => c.put(e.request, copy));
      return resp;
    }).catch(() => caches.match(e.request)));
    return;
  }
  e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request).then(resp => {
    const copy = resp.clone();
    caches.open(CACHE_VERSION).then(c => c.put(e.request, copy));
    return resp;
  })));
});
`;

test.use({ serviceWorkers: 'allow' });

async function controlPage(page) {
  await page.evaluate(async () => {
    await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' });
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
    }
  });
}

async function openPublicHome(page, appURL) {
  const response = await page.goto(appURL);
  expect(response.ok()).toBeTruthy();
  await controlPage(page);
  await expect.poll(() => page.evaluate(async name => {
    const cache = await caches.open(name);
    return !!(await cache.match('/'));
  }, currentCache)).toBe(true);
}

async function cacheEntries(page) {
  return page.evaluate(async () => {
    const result = [];
    for (const name of await caches.keys()) {
      for (const request of await (await caches.open(name)).keys()) {
        result.push({ name, url: request.url });
      }
    }
    return result;
  });
}

async function expectPublicOfflineHome(page, context, appURL) {
  await context.setOffline(true);
  const response = await page.goto(appURL);
  expect(response.status()).toBe(200);
  expect(response.fromServiceWorker()).toBe(true);
  await expect(page).toHaveTitle(/NJIT Room Finder/);
  await expect(page.locator('script[src="/static/app.js"]')).toHaveCount(1);
  await expect(page.locator('body')).not.toContainText('Visitor Log');
  await expect(page.locator('body')).not.toContainText(privateMarker);
  await expect(page).not.toHaveTitle(/Schedule Extractor/);
}

async function apiResult(page, url) {
  return page.evaluate(async url => {
    const response = await fetch(url);
    return { status: response.status, body: await response.json(), headers: Object.fromEntries(response.headers) };
  }, url);
}

test('an authenticated report cannot replace the public offline home or enter CacheStorage', async ({ page, context, appURL, server }) => {
  await openPublicHome(page, appURL);
  // Exercise the browser's actual HTTP Basic challenge/cache rather than just
  // adding a visible Authorization header to a mocked fetch.
  await context.setHTTPCredentials({ username: 'test', password: server.adminPassword });
  const report = await page.goto(`${appURL}/admin/visits`);
  expect(report.status()).toBe(200);
  expect(report.headers()['cache-control']).toContain('no-store');
  await expect(page).toHaveTitle('Visitor Log · NJIT Room Finder');
  await expect(page.locator('h1')).toHaveText('Visitor Log');
  await expectPublicOfflineHome(page, context, appURL);
  const entries = await cacheEntries(page);
  expect(entries.some(({ url }) => new URL(url).pathname.startsWith('/admin/'))).toBe(false);
  const cachedHome = await page.evaluate(async name => (await (await caches.open(name)).match('/')).text(), currentCache);
  expect(cachedHome).not.toContain('Visitor Log');
});

test('bookmarklet navigation cannot overwrite the canonical offline home', async ({ page, context, appURL }) => {
  await openPublicHome(page, appURL);
  const bookmarklet = await page.goto(`${appURL}/bookmarklet`);
  expect(bookmarklet.status()).toBe(200);
  await expect(page).toHaveTitle(/Schedule Extractor/);
  expect((await cacheEntries(page)).some(({ url }) => new URL(url).pathname === '/bookmarklet')).toBe(false);
  await expectPublicOfflineHome(page, context, `${appURL}/?view=rooms&building=CKB&room=CKB-G-08`);
});

test('a real worker upgrade purges contaminated v13 home and API entries but keeps unrelated caches', async ({ page, context, appURL }) => {
  const serveLegacy = route => route.fulfill({ status: 200, contentType: 'application/javascript', body: legacyWorker });
  await context.route('**/sw.js', serveLegacy);
  // This public page has no automatic worker registration or startup API reads.
  await page.goto(`${appURL}/bookmarklet`);
  await controlPage(page);
  await page.evaluate(async ({ marker, api }) => {
    const legacy = await caches.open('room-finder-v13');
    await legacy.put('/', new Response(`<title>Visitor Log</title>${marker}`, { headers: { 'Content-Type': 'text/html' } }));
    await legacy.put(api, new Response(JSON.stringify([{ building: 'CKB', room: '217', empty: false, old_semantics: true }]), {
      headers: { 'Content-Type': 'application/json', 'X-Schedule-Version': 'obsolete-v13' },
    }));
    await legacy.put('/api/export-schedule?password=obsolete-fixture', new Response('PRIVATE EXPORT'));
    await (await caches.open('room-finder-v5')).put('/', new Response('old home'));
    await (await caches.open('unrelated-app-v1')).put('/', new Response('unrelated data'));
    await (await caches.open('room-finder-notes')).put('/', new Response('unrelated prefix'));
  }, { marker: privateMarker, api: legacyAPI });
  await context.setOffline(true);
  expect((await apiResult(page, legacyAPI)).body[0].old_semantics).toBe(true);
  await context.setOffline(false);

  await context.unroute('**/sw.js', serveLegacy);
  await page.evaluate(async () => {
    const changed = new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
    await (await navigator.serviceWorker.getRegistration()).update();
    await changed;
  });
  // controllerchange can precede completion of the new activate event.
  await expect.poll(() => page.evaluate(async () => (await caches.keys()).sort())).toEqual([currentCache, 'unrelated-app-v1', 'room-finder-notes'].sort());
  const names = await page.evaluate(() => caches.keys());
  expect(names).not.toContain('room-finder-v13');
  expect(names).not.toContain('room-finder-v5');

  await context.setOffline(true);
  const oldQueryMiss = await page.evaluate(async url => {
    try { const response = await fetch(url); return { success: true, body: await response.text() }; }
    catch { return { success: false }; }
  }, legacyAPI);
  expect(oldQueryMiss).toEqual({ success: false });
  await expectPublicOfflineHome(page, context, appURL);
  expect((await cacheEntries(page)).some(({ url }) => url.includes('/api/export-schedule'))).toBe(false);

  await context.setOffline(false);
  const fresh = await apiResult(page, legacyAPI);
  expect(fresh.status).toBe(200);
  expect(fresh.body.some(room => room.building === 'CKB' && room.room === '217')).toBe(true);
  expect(fresh.body.some(room => room.old_semantics)).toBe(false);
  await context.setOffline(true);
  const replay = await apiResult(page, legacyAPI);
  expect(replay.body).toEqual(fresh.body);
  expect(replay.headers['x-room-finder-cache']).toBe('offline');
});

test('protected export successes, denials and credential URLs are absent from CacheStorage', async ({ page, appURL, server }) => {
  await writeFile(path.join(server.directory, 'uploaded_schedule_202690.csv'),
    'Term,Course,Days,Times,Location,Max,Delivery Mode\n202690,TEST 101,M,2:30 PM - 3:30 PM,CKB 217,30,Face-to-Face\n');
  await openPublicHome(page, appURL);
  const results = await page.evaluate(async password => {
    const entries = [];
    for (const [url, headers] of [
      ['/api/export-schedule?term=202690', { Authorization: `Bearer ${password}` }],
      ['/api/export-schedule?term=202690', {}],
      [`/api/export-schedule?term=202690&password=${encodeURIComponent(password)}`, {}],
    ]) {
      const response = await fetch(url, { headers });
      entries.push({ status: response.status, policy: response.headers.get('Cache-Control'), body: await response.text() });
    }
    return entries;
  }, server.uploadPassword);
  expect(results.map(result => result.status)).toEqual([200, 401, 401]);
  for (const result of results) expect(result.policy).toContain('no-store');
  expect(results[0].body).toContain('CKB');
  const entries = await cacheEntries(page);
  expect(entries.some(({ url }) => /export-schedule|password=|upload-schedule/.test(url))).toBe(false);
});

test('public API offline replay keeps its original retrieval timestamp, body and backend context', async ({ page, context, appURL }) => {
  await openPublicHome(page, appURL);
  const url = '/api/room/schedule?building=CKB&room=G-08&_weekday=0&at=13%3A01';
  const network = await apiResult(page, url);
  expect(network.status).toBe(200);
  expect(network.headers['x-room-finder-cache']).toBe('network');
  const fetchedAt = network.headers['x-room-finder-fetched-at'];
  expect(fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  expect(Number.isNaN(Date.parse(fetchedAt))).toBe(false);
  await expect.poll(() => page.evaluate(async ({ name, url }) => !!(await (await caches.open(name)).match(url)), { name: currentCache, url })).toBe(true);
  await context.setOffline(true);
  const replay = await apiResult(page, url);
  expect(replay.status).toBe(200);
  expect(replay.body).toEqual(network.body);
  expect(replay.headers['x-room-finder-cache']).toBe('offline');
  expect(replay.headers['x-room-finder-fetched-at']).toBe(fetchedAt);
  for (const key of Object.keys(network.headers).filter(key => key === 'x-schedule-version' || key.startsWith('x-query-'))) {
    expect(replay.headers[key]).toBe(network.headers[key]);
  }
});

test('controlled navigation records the originating page referrer rather than the worker URL', async ({ page, context, request, appURL, server }) => {
  await openPublicHome(page, appURL);
  const headers = { Authorization: `Basic ${Buffer.from(`test:${server.adminPassword}`).toString('base64')}` };
  for (const originPath of ['/bookmarklet', '/?view=rooms']) {
    await page.goto(appURL + originPath);
    const marker = (originPath === '/bookmarklet' ? '11' : '22').repeat(16);
    await context.addCookies([{ name: visitorCookie, value: marker, url: appURL }]);
    await page.evaluate(() => {
      const link = document.createElement('a');
      link.href = '/?saved=1';
      link.textContent = 'Offline test home navigation';
      link.dataset.testid = 'offline-test-home';
      document.body.prepend(link);
    });
    const [navigation] = await Promise.all([
      page.waitForNavigation(),
      // The real app has a fixed header; layout is outside this request test.
      page.getByTestId('offline-test-home').evaluate(link => link.click()),
    ]);
    expect(navigation.status()).toBe(200);
    expect(navigation.fromServiceWorker()).toBe(true);
    const report = await request.get('/admin/visits', { headers });
    expect(report.status()).toBe(200);
    const referrers = await page.evaluate(({ html, marker }) => {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      return [...doc.querySelectorAll('tbody tr')]
        .filter(row => row.cells[1]?.textContent.trim() === marker.slice(0, 8))
        .map(row => row.cells[4].textContent.trim());
    }, { html: await report.text(), marker });
    // Identify this navigation by its visitor ID: the fixture clock makes all stored
    // timestamps equal, so report row order cannot identify the latest visit.
    // Storage intentionally redacts the query but keeps the originating path.
    expect(referrers).toEqual([appURL + new URL(originPath, appURL).pathname]);
  }
});

test('visitor identity and counting survive repeated service-worker-controlled home navigations', async ({ page, context, appURL, server }) => {
  const first = await page.goto(appURL);
  expect(first.status()).toBe(200);
  const initialCookie = (await context.cookies(appURL)).find(cookie => cookie.name === visitorCookie);
  expect(initialCookie?.value).toBeTruthy();
  await controlPage(page);
  for (const suffix of ['/?view=rooms', '/?saved=1', '/']) {
    const response = await page.goto(appURL + suffix);
    expect(response.status()).toBe(200);
    expect(response.fromServiceWorker()).toBe(true);
    const cookie = (await context.cookies(appURL)).find(cookie => cookie.name === visitorCookie);
    expect(cookie.value).toBe(initialCookie.value);
  }
  await context.setHTTPCredentials({ username: 'test', password: server.adminPassword });
  expect((await page.goto(`${appURL}/admin/visits`)).status()).toBe(200);
  const counts = await page.locator('.cards .number').allTextContents();
  expect(Number(counts[0])).toBeGreaterThanOrEqual(4);
  expect(Number(counts[1])).toBe(1);
});
