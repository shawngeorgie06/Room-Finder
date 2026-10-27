const { test, expect } = require('./fixtures');

// Standalone adapter contract, NOT the still-pending home/full-map integration.
// Serve real repository Leaflet + map.js from the disposable Flask origin; all
// tiles are controlled here. Never contact OSM from automated regression tests.
const TILE = '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#ddd"/><text x="20" y="120">Controlled test tile</text></svg>';
const tiles = route => route.fulfill({ contentType: 'image/svg+xml', body: TILE });

async function openAdapter(page, appURL) {
  await page.route(`${appURL}/adapter-test`, route => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Standalone map adapter test</title><link rel="stylesheet" href="/static/vendor/leaflet/leaflet.css">
      <style>body{font:16px sans-serif;margin:12px} #map{height:260px;width:100%} #preview{height:140px;width:100%}
      #preview-button{display:block;width:100%} #credit{display:block;padding:8px} a{color:#124ba0}</style>
      </head><body><div id="map"></div>
      <button id="preview-button" type="button" aria-label="Open full map"><div id="preview" inert></div></button>
      <div id="credit"></div><p id="status" role="status" aria-live="polite"></p>
      <button id="retry" type="button">Retry map</button>
      <section aria-label="Building list"><a href="#rooms">Central King Building rooms</a></section>
      <script src="/static/vendor/leaflet/leaflet.js"></script><script src="/static/map.js"></script></body></html>`
  }));
  await page.goto(`${appURL}/adapter-test`);
}

async function createAdapter(page, { labels = false, disabled = false, missingLeaflet = false, timeoutMs = 2000, animated = false } = {}) {
  await page.evaluate(({ labels, disabled, missingLeaflet, timeoutMs, animated }) => {
    window.map = L.map('map', { zoomAnimation: animated, fadeAnimation: animated }).setView([40.742, -74.178], 17);
    const config = disabled ? null : RoomFinderMap.getLayerConfig('osm-standard');
    if (labels) config.labels = {
      url: 'https://labels.example.test/{z}/{x}/{y}.png',
      attribution: [{ text: 'Test labels', url: 'https://labels.example.test/terms' }]
    };
    window.statuses = [];
    window.adapter = RoomFinderMap.createLayers(missingLeaflet ? null : L, map, {
      config, timeoutMs,
      onStatus(status) {
        statuses.push(status);
        const region = document.querySelector('#status');
        if (region.dataset.state !== status.state || region.textContent !== status.message) {
          region.textContent = status.message;
          region.dataset.state = status.state;
        }
      }
    });
    document.querySelector('#retry').addEventListener('click', () => adapter.retry());
  }, { labels, disabled, missingLeaflet, timeoutMs, animated });
}

async function expectState(page, state) {
  await expect(page.locator('#status')).toHaveAttribute('data-state', state);
}

for (const animated of [false, true]) {
test(`zoom pan and campus fit keep ready status without false errors or announcements (animation=${animated})`, async ({ page, appURL }) => {
  await page.route('https://tile.openstreetmap.org/**', tiles);
  await openAdapter(page, appURL);
  await createAdapter(page, { animated });
  await expectState(page, 'ready');
  await page.evaluate(() => {
    window.initialStatusCount = statuses.length;
    window.announcements = 0;
    new MutationObserver(changes => { announcements += changes.length; }).observe(document.querySelector('#status'), { childList: true });
  });
  for (const operation of ['pan', 'zoom', 'fit']) {
    await page.evaluate(operation => new Promise(resolve => {
      map.once('moveend', () => resolve());
      if (operation === 'pan') map.panBy([600, 0], { animate: false });
      if (operation === 'zoom') map.setZoom(16, { animate: true });
      if (operation === 'fit') RoomFinderMap.fitToCampus(map, { A: [40.74196, -74.17741], B: [40.74424, -74.17940] });
    }), operation);
    await expect.poll(() => page.evaluate(() => adapter.getStatus().layers.base)).toBe('ready');
  }
  expect(await page.evaluate(() => statuses.slice(initialStatusCount).every(s => s.state === 'ready' && !s.fallback))).toBe(true);
  expect(await page.evaluate(() => announcements)).toBe(0);
});
}

test('maps without an initial view are refused without timers or listeners', async ({ page, appURL, externalRequests }) => {
  await openAdapter(page, appURL);
  const result = await page.evaluate(async () => {
    const map = L.map('map');
    const statuses = [];
    const adapter = RoomFinderMap.createLayers(L, map, { timeoutMs: 10, onStatus: s => statuses.push(s.state) });
    await new Promise(resolve => setTimeout(resolve, 30));
    map.remove();
    window.dispatchEvent(new Event('offline'));
    return { states: statuses, retry: adapter.retry(), layer: !!adapter.baseLayer };
  });
  expect(result).toEqual({ states: ['unconfigured'], retry: false, layer: false });
  expect(externalRequests).toEqual([]);
});

test('hidden campus fit does not invalidate size move center or emit map events', async ({ page, appURL }) => {
  await openAdapter(page, appURL);
  const result = await page.evaluate(() => {
    const map = L.map('map').setView([40.742, -74.178], 17);
    const before = map.getCenter();
    map.getSize(); // Leaflet caches the visible size.
    const events = [];
    map.on('move', () => events.push('move'));
    map.on('resize', () => events.push('resize'));
    document.querySelector('#map').hidden = true;
    const fit = RoomFinderMap.fitToCampus(map, { A: [40.740, -74.180] });
    return { fit, unchanged: map.getCenter().equals(before), events };
  });
  expect(result).toEqual({ fit: false, unchanged: true, events: [] });
});

for (const kind of ['detached', 'display-none', 'aria-hidden', 'fragment', 'removed-control', 'inert-control', 'hidden-control']) {
  test(`rejects unusable attribution: ${kind}`, async ({ page, appURL, externalRequests }) => {
    await openAdapter(page, appURL);
    const result = await page.evaluate(kind => {
      const control = kind.endsWith('control');
      const map = L.map(control && kind === 'inert-control' ? 'preview' : 'map', { attributionControl: control, zoomControl: false }).setView([40.742, -74.178], 17);
      let credit = document.querySelector('#credit');
      if (kind === 'detached') credit.remove();
      if (kind === 'display-none') credit.style.display = 'none';
      if (kind === 'aria-hidden') credit.setAttribute('aria-hidden', 'true');
      if (kind === 'fragment') credit = document.createDocumentFragment();
      if (kind === 'removed-control') map.attributionControl.remove();
      if (kind === 'hidden-control') map.attributionControl.getContainer().style.visibility = 'hidden';
      const adapter = RoomFinderMap.createLayers(L, map, control ? {} : { attributionElement: credit });
      return { state: adapter.getStatus().state, layer: !!adapter.baseLayer };
    }, kind);
    expect(result).toEqual({ state: 'unconfigured', layer: false });
    expect(externalRequests).toEqual([]);
  });
}

test('real Leaflet loads tiles with visible full-map and sibling preview attribution', async ({ page, appURL, externalRequests }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('https://tile.openstreetmap.org/**', tiles);
  await openAdapter(page, appURL);
  await createAdapter(page);
  await expectState(page, 'ready');
  const credit = page.locator('#map .leaflet-control-attribution a[href="https://www.openstreetmap.org/copyright"]');
  await expect(credit).toBeVisible();
  await expect(credit).toContainText('OpenStreetMap contributors');
  const loaded = await page.locator('#map img.leaflet-tile').evaluateAll(images => images.every(image => image.complete && image.naturalWidth > 0));
  expect(loaded).toBe(true);
  await page.evaluate(() => {
    window.previewMap = L.map('preview', {
      attributionControl: false, zoomControl: false, dragging: false, scrollWheelZoom: false,
      touchZoom: false, doubleClickZoom: false, boxZoom: false, keyboard: false
    }).setView([40.742, -74.178], 16);
    window.previewAdapter = RoomFinderMap.createLayers(L, previewMap, {
      attributionElement: document.querySelector('#credit')
    });
  });
  const siblingCredit = page.locator('#credit a');
  await expect(siblingCredit).toBeVisible();
  await expect(siblingCredit).toHaveAttribute('href', 'https://www.openstreetmap.org/copyright');
  await expect(page.locator('#preview-button a')).toHaveCount(0);
  await page.locator('#preview-button').focus();
  await page.keyboard.press('Tab');
  await expect(siblingCredit).toBeFocused();
  expect(await page.evaluate(() => previewMap.dragging.enabled())).toBe(false);
  expect(externalRequests).toEqual([]);
});

test('default preview attribution control never nests links when sibling credit is supplied', async ({ page, appURL, externalRequests }) => {
  await page.route('https://tile.openstreetmap.org/**', tiles);
  await openAdapter(page, appURL);
  await page.evaluate(() => {
    const preview = L.map('preview', { zoomControl: false, dragging: false, keyboard: false }).setView([40.742, -74.178], 16);
    window.previewAdapter = RoomFinderMap.createLayers(L, preview, {
      attributionElement: document.querySelector('#credit')
    });
  });
  await expect.poll(() => page.evaluate(() => previewAdapter.getStatus().state)).toBe('ready');
  await expect(page.locator('#preview-button a')).toHaveCount(0);
  const credit = page.locator('#credit a');
  await expect(credit).toHaveCount(1);
  await expect(credit).toBeVisible();
  await expect(credit).toHaveText('© OpenStreetMap contributors');
  await expect(credit).toHaveAttribute('href', 'https://www.openstreetmap.org/copyright');
  await page.locator('#preview-button').focus();
  await page.keyboard.press('Tab');
  await expect(credit).toBeFocused();
  expect(externalRequests).toEqual([]);
});

test('provider denial exposes an accessible building-list fallback and Retry recovers', async ({ page, appURL }) => {
  let denied = true;
  await page.route('https://tile.openstreetmap.org/**', route => denied ? route.fulfill({ status: 403, body: 'Denied' }) : tiles(route));
  await openAdapter(page, appURL);
  await createAdapter(page);
  await expectState(page, 'base-error');
  await expect(page.getByRole('status')).toContainText('building list');
  const building = page.getByRole('link', { name: 'Central King Building rooms' });
  await building.focus();
  await expect(building).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#rooms$/);
  denied = false;
  await page.getByRole('button', { name: 'Retry map' }).click();
  await expectState(page, 'ready');
  expect(await page.evaluate(() => adapter.getStatus().fallback)).toBe(false);
});

test('labels-only failure preserves basemap usability and recovers independently', async ({ page, appURL }) => {
  let failed = true;
  await page.route('https://tile.openstreetmap.org/**', tiles);
  await page.route('https://labels.example.test/**', route => failed ? route.abort('failed') : tiles(route));
  await openAdapter(page, appURL);
  await createAdapter(page, { labels: true });
  await expectState(page, 'labels-error');
  expect(await page.evaluate(() => adapter.getStatus())).toMatchObject({
    fallback: false, layers: { base: 'ready', labels: 'error' }
  });
  failed = false;
  await page.getByRole('button', { name: 'Retry map' }).click();
  await expectState(page, 'ready');
});

test('stalled tiles time out without looping and late successful tiles recover', async ({ page, appURL }) => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let requests = 0;
  await page.route('https://tile.openstreetmap.org/**', async route => {
    requests++;
    await gate;
    await tiles(route);
  });
  try {
    await openAdapter(page, appURL);
    await createAdapter(page, { timeoutMs: 50 });
    await expectState(page, 'timeout');
    const initial = requests;
    expect(initial).toBeGreaterThan(0);
    await page.clock.fastForward(500);
    expect(requests).toBe(initial);
    release();
    await expectState(page, 'ready');
  } finally { release(); }
});

test('initial offline state requests no tiles and reconnect makes one recovery attempt', async ({ page, context, appURL }) => {
  let requests = 0;
  await page.route('https://tile.openstreetmap.org/**', route => { requests++; return tiles(route); });
  await openAdapter(page, appURL);
  await context.setOffline(true);
  await createAdapter(page);
  await expectState(page, 'offline');
  expect(requests).toBe(0);
  await context.setOffline(false);
  await expectState(page, 'ready');
  const recovered = requests;
  expect(recovered).toBeGreaterThan(0);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  expect(requests).toBe(recovered);
});

for (const [options, state] of [[{ disabled: true }, 'unconfigured'], [{ missingLeaflet: true }, 'unavailable']]) {
  test(`${state} map keeps a keyboard-reachable fallback without requesting tiles`, async ({ page, appURL, externalRequests }) => {
    await openAdapter(page, appURL);
    await createAdapter(page, options);
    await expectState(page, state);
    await expect(page.getByRole('status')).toContainText('building list');
    await page.getByRole('link', { name: 'Central King Building rooms' }).focus();
    await expect(page.getByRole('link', { name: 'Central King Building rooms' })).toBeFocused();
    expect(externalRequests).toEqual([]);
  });
}

test('campus fit waits for visibility and includes representative points without disabling gestures', async ({ page, appURL }) => {
  await openAdapter(page, appURL);
  const result = await page.evaluate(() => {
    const element = document.querySelector('#map');
    element.hidden = true;
    const map = L.map(element).setView([40.742, -74.178], 17);
    const coords = { CKB: [40.74196, -74.17741], GITC: [40.74424, -74.17940], unknown: null };
    const hidden = RoomFinderMap.fitToCampus(map, coords);
    element.hidden = false;
    const visible = RoomFinderMap.fitToCampus(map, coords);
    return { hidden, visible, zoom: map.getZoom(), inside: [coords.CKB, coords.GITC].every(point => map.getBounds().contains(point)), dragging: map.dragging.enabled() };
  });
  expect(result).toMatchObject({ hidden: false, visible: true, inside: true, dragging: true });
  expect(result.zoom).toBeLessThanOrEqual(17);
});

test('preview without usable attribution fails closed instead of nesting inert links', async ({ page, appURL, externalRequests }) => {
  await openAdapter(page, appURL);
  const status = await page.evaluate(() => {
    const preview = L.map('preview', { attributionControl: false, zoomControl: false }).setView([40.742, -74.178], 16);
    const adapter = RoomFinderMap.createLayers(L, preview, {
      attributionElement: document.querySelector('#preview') // Inside both inert and button ancestors.
    });
    return adapter.getStatus();
  });
  expect(status.state).toBe('unconfigured');
  expect(status.fallback).toBe(true);
  await expect(page.locator('#preview-button a')).toHaveCount(0);
  expect(externalRequests).toEqual([]);
});

test('removing a live Leaflet map automatically disposes its adapter', async ({ page, appURL }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://tile.openstreetmap.org/**', tiles);
  await openAdapter(page, appURL);
  await createAdapter(page);
  await expectState(page, 'ready');
  const result = await page.evaluate(() => {
    const count = statuses.length;
    map.remove();
    window.dispatchEvent(new Event('offline'));
    window.dispatchEvent(new Event('online'));
    return { unchanged: statuses.length === count, retry: adapter.retry() };
  });
  expect(result).toEqual({ unchanged: true, retry: false });
  expect(errors).toEqual([]);
});

test('destroy detaches layers and callbacks even when the Leaflet map is then removed', async ({ page, appURL }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://tile.openstreetmap.org/**', tiles);
  await openAdapter(page, appURL);
  await createAdapter(page);
  await expectState(page, 'ready');
  const result = await page.evaluate(() => {
    const before = statuses.length;
    adapter.destroy();
    adapter.destroy();
    const layers = Object.keys(map._layers).length;
    map.remove();
    window.dispatchEvent(new Event('offline'));
    window.dispatchEvent(new Event('online'));
    return { before, after: statuses.length, layers, retry: adapter.retry() };
  });
  expect(result.after).toBe(result.before);
  expect(result.layers).toBe(0);
  expect(result.retry).toBe(false);
  expect(errors).toEqual([]);
});
