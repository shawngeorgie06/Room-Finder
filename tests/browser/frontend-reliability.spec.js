const { test, expect } = require('./fixtures');

// Explicit additive backend contract. These tests verify the frontend boundary,
// not backend rollout. The separate real-endpoint cases below use Flask without API interception.
const FETCHED = '2026-10-05T17:00:00.000Z';
const rooms = [
  { building: 'CKB', room: '217', floor: 2, empty: true, minutes_until_next: 90, capacity: 30,
    matches_requested_window: true, available_from_min: 780, available_until_min: 870 },
  { building: 'CKB', room: 'G-08', floor: 0, empty: false, minutes_until_next: null, capacity: 20,
    matches_requested_window: false, available_from_min: 900, available_until_min: null },
  { building: 'FMH', room: '101', floor: 1, empty: true, minutes_until_next: null, capacity: 20,
    matches_requested_window: true, available_from_min: 780, available_until_min: null },
];
function detail(room, query) {
  return { ...room, occupied_now: !room.empty, weekday: query.get('day') || 'Monday', now_min: 780,
    next_class: null, next_free_window: null,
    classes: room.empty ? [] : [{ start_min: 720, end_min: 900, is_current: true, course: 'CS "A"', title: 'Systems <intro>', instructor: "O'Neil — 李" }] };
}
async function contract(page, options = {}) {
  const calls = [];
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    calls.push(url);
    if (options.intercept && await options.intercept(route, url)) return;
    const roster = typeof options.rooms === 'function' ? options.rooms(url) : options.rooms || rooms;
    let data;
    if (url.pathname === '/api/rooms/all') data = roster;
    else if (url.pathname === '/api/rooms') data = roster.filter(r => r.empty && r.matches_requested_window && (!url.searchParams.get('building') || r.building === url.searchParams.get('building')));
    else if (url.pathname === '/api/buildings') data = [...new Set(roster.map(r => r.building))].map(building => {
      const list = roster.filter(r => r.building === building), free = list.filter(r => r.empty).length;
      return { building, total_rooms: list.length, empty_rooms: free, occupied_rooms: list.length - free, occupancy_pct: (list.length - free) / list.length * 100, matching_rooms: list.filter(r => r.matches_requested_window).length };
    });
    else if (url.pathname === '/api/room/schedule') {
      const room = roster.find(r => r.building === url.searchParams.get('building') && r.room === url.searchParams.get('room'));
      if (!room) return route.fulfill({ status: 404, json: { error: 'Room not found' } });
      data = detail(room, url.searchParams);
    } else if (url.pathname === '/api/schedule-info') data = { semester: 'Fall 2026', status: 'current', has_classes_today: true, weekday: 'Monday', entries: 3, buildings: 2, rooms: 3, schedule_version: options.version || 'v1' };
    else if (url.pathname === '/api/heatmap') data = { days: [], hours: [], total_rooms: 2 };
    else if (url.pathname === '/api/terms') data = [{term:202690,semester:'Fall 2026',filename:'Course_Schedule_202690.csv',active:true}];
    else return route.fallback();
    const headers = {
      'X-Query-Day': url.searchParams.get('day') || 'Monday', 'X-Query-Time': url.searchParams.get('at') || '13:00',
      'X-Query-Timezone': 'America/New_York', 'X-Query-Preview': url.searchParams.has('day') || url.searchParams.has('at') ? '1' : '0',
      'X-Schedule-Version': options.version || 'v1', 'X-Room-Finder-Fetched-At': typeof options.fetchedAt === 'function' ? options.fetchedAt() : options.fetchedAt || FETCHED,
      'X-Room-Finder-Cache': options.offline ? 'offline' : 'network',
    };
    await route.fulfill({ json: data, headers });
  });
  return calls;
}
async function ready(page, appURL, query = '?view=rooms') {
  await page.goto(appURL + query);
  await expect(page.locator('#rooms-container')).toContainText('217');
}

test('Saved ignores hidden building and duration, retains occupied and missing pins', async ({ page, appURL }) => {
  await contract(page);
  await page.addInitScript(() => localStorage.setItem('pinnedRooms', JSON.stringify(['CKB|G-08', 'OLD|100A'])));
  await page.goto(appURL + '?view=rooms&saved=1&building=FMH&for=120');
  await expect(page.locator('#rooms-container')).toContainText('G-08');
  await expect(page.locator('#rooms-container')).toContainText('IN USE');
  await expect(page.locator('#rooms-container')).toContainText('Does not match requested window');
  await expect(page.locator('#rooms-container')).toContainText('100A');
  await expect(page.locator('#rooms-container')).toContainText('Not in current schedule');
});

test('gap commits one query through reopen, sort, share and detail; invalid end is inline', async ({ page, appURL }) => {
  const calls = await contract(page);
  await ready(page, appURL, '?view=rooms&day=Monday&for=30');
  await page.evaluate(() => openFindRoom());
  await page.locator('#fr-gap-from').fill('13:00');
  await page.locator('#fr-gap-until').fill('15:00');
  await page.locator('button[onclick="applyGapWindow()"]').click();
  await expect(page).toHaveURL(/until=15%3A00/);
  await expect(page.locator('#fr-gap-label')).toContainText('3:00 PM ET');
  await page.evaluate(() => { closeFindRoom(); openFindRoom(); setFindRoomSort('time'); });
  await expect(page.locator('#fr-gap-from')).toHaveValue('13:00');
  await expect(page.locator('#fr-gap-until')).toHaveValue('15:00');
  await page.locator('#fr-results [role="button"]').filter({ hasText: '217' }).click();
  await expect.poll(() => calls.filter(u => u.pathname === '/api/room/schedule').at(-1)?.searchParams.get('until')).toBe('15:00');
  await page.evaluate(() => { closeRoomDetail(); openFindRoom(); });
  for (const until of ['13:00', '12:00']) {
    await page.locator('#fr-gap-until').fill(until);
    await page.locator('button[onclick="applyGapWindow()"]').click();
    await expect(page.locator('#fr-gap-error')).toContainText('after');
    await expect(page).toHaveURL(/until=15%3A00/);
  }
});

test('latest request owns cache and rendering even when old transport ignores abort', async ({ page, appURL }) => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let oldStarted = false;
  await contract(page, {rooms:url=>url.searchParams.get('at') === '09:00' ? [{...rooms[0],room:'OLD'}] : rooms,
    intercept: async (route, url) => {
      if (url.searchParams.get('at') === '09:00') { oldStarted = true; await held; }
      return false; // All old responses remain valid, coherent data, not deliberate errors.
    }
  });
  await ready(page, appURL);
  await page.evaluate(() => {
    const original = RoomFinderReliability.request;
    RoomFinderReliability.request = (url, options) => original(url, {...options,signal:undefined});
    state.timeAt = '09:00'; window.oldRefresh = refresh();
  });
  await expect.poll(() => oldStarted).toBe(true);
  await page.evaluate(() => { state.timeAt = '13:00'; return refresh(); });
  release();
  await page.evaluate(() => window.oldRefresh);
  await expect(page.locator('#rooms-container')).toContainText('217');
  await expect(page.locator('#rooms-container')).not.toContainText('OLD');
  expect(await page.evaluate(() => state.allRoomsCache.map(r => r.room))).toEqual(['217','G-08','101']);
  expect(await page.evaluate(() => state.allRoomsCacheKey)).toContain('13%3A00');
  expect(await page.evaluate(() => state.snapshot.meta.context.at)).toBe('13:00');
});

test('refresh updates full roster, search, finder, open building/detail without dropping focus', async ({ page, appURL }) => {
  let occupied = false;
  const calls = await contract(page, { rooms: () => rooms.map(r => r.room === '217' ? { ...r, empty: !occupied, matches_requested_window: !occupied, minutes_until_next: occupied ? null : 90 } : r) });
  await ready(page, appURL);
  await page.evaluate(() => { localStorage.setItem('pinnedRooms', '["CKB|217"]'); return setSavedOnly(true); });
  const card = page.locator('#rooms-container [data-room-key]').first();
  await card.focus();
  await page.evaluate(() => refresh());
  await expect(card).toBeFocused();
  await page.evaluate(() => { openBuildingPanel(state.buildingsData.find(b => b.building === 'CKB')); openFindRoom(); openRoomDetail('CKB','217'); });
  await expect(page.locator('#rds-room')).toHaveText('217');
  occupied = true;
  const count = calls.filter(u => u.pathname === '/api/rooms/all').length;
  await page.evaluate(() => refresh());
  expect(calls.filter(u => u.pathname === '/api/rooms/all').length).toBeGreaterThan(count);
  await expect(page.locator('#rooms-container')).toContainText('IN USE');
  await expect(page.locator('#floor-rooms')).toContainText('In use');
  await expect(page.locator('#rds-status')).toContainText(/in use/i);
  await expect(page.locator('#fr-results')).not.toContainText('217');
  await page.evaluate(() => { closeRoomDetail(); closeFindRoom(); closeFloorPanel(); return runSearch('217'); });
  await expect(page.locator('#search-results')).toContainText('IN USE');
});

test('success then HTTP failure retains previous results and timestamp with visible Retry', async ({ page, appURL }) => {
  let fail = false;
  await contract(page, { intercept: async (route, url) => {
    if (fail && url.pathname === '/api/rooms/all') { await route.fulfill({ status: 500, json: { error: 'outage' } }); return true; }
    return false;
  }});
  await ready(page, appURL);
  const stamp = await page.locator('#grid-timestamp').innerText();
  fail = true;
  await page.evaluate(() => refresh());
  await expect(page.locator('#rooms-container')).toContainText('217');
  await expect(page.locator('#data-status')).toContainText(/could not|failed/i);
  await expect(page.locator('#data-retry')).toBeVisible();
  await expect(page.locator('#grid-timestamp')).toHaveText(stamp);
  fail = false;
  await page.locator('#data-retry').click();
  await expect(page.locator('#data-status')).toHaveAttribute('data-state', 'success');
});

test('mixed schedule versions do not publish any part of a refresh', async ({ page, appURL }) => {
  let mixed = false;
  await contract(page, { intercept: async (route, url) => {
    if (mixed && url.pathname === '/api/rooms/all') {
      await route.fulfill({ json: [], headers: { 'X-Schedule-Version': 'v2', 'X-Query-Day': 'Monday', 'X-Query-Time': '13:00', 'X-Query-Timezone': 'America/New_York', 'X-Query-Preview': '0' } }); return true;
    } return false;
  }});
  await ready(page, appURL);
  mixed = true;
  await page.evaluate(() => refresh());
  await expect(page.locator('#rooms-container')).toContainText('217');
  await expect(page.locator('#data-status')).toContainText(/consistent|changed/i);
  expect(await page.evaluate(() => state.snapshot.meta.version)).toBe('v1');
});

test('cached replay preserves original time and query context, never claims LIVE', async ({ page, appURL }) => {
  await contract(page, { offline: true, fetchedAt: '2026-10-05T16:00:00Z' });
  await ready(page, appURL, '?view=rooms&day=Monday&at=12:00');
  await expect(page.locator('#data-status')).toContainText(/offline/i);
  await expect(page.locator('#query-context')).toContainText('12:00 PM ET');
  await expect(page.locator('#grid-timestamp')).toContainText('12:00');
  await expect(page.locator('#rooms-view-semester')).not.toContainText(/live/i);
  await page.evaluate(() => refresh());
  expect(await page.evaluate(() => state.snapshot.meta.fetchedAt)).toBe('2026-10-05T16:00:00.000Z');
});

test('replayed live query reads Last known, never Now, on every surface', async ({ page, appURL }) => {
  await contract(page, { offline: true, fetchedAt: '2026-10-05T16:00:00Z' });
  await ready(page, appURL, '?view=rooms');
  await expect(page.locator('#query-context')).toHaveText('Last known · Monday · 1:00 PM ET');
  await expect(page.locator('#query-context')).not.toContainText('Now ·');
  await page.locator('#rooms-container [role="button"]').filter({ hasText: '217' }).first().click();
  await expect(page.locator('#rds-day')).toHaveText('Last known · Monday · 1:00 PM ET');
  await expect(page.locator('#room-detail-sheet [data-surface-status]')).not.toContainText('Now ·');
});

test('valid empty roster is cached success, not repeated fetch or a stale fallback', async ({ page, appURL }) => {
  const calls = await contract(page, { rooms: [] });
  await page.goto(appURL + '?view=rooms');
  await expect(page.locator('#data-status')).toHaveAttribute('data-state', 'empty');
  const count = calls.filter(u => u.pathname === '/api/rooms/all').length;
  await page.evaluate(async () => { await runSearch('217'); await runSearch('G-08'); });
  expect(calls.filter(u => u.pathname === '/api/rooms/all').length).toBe(count);
  await expect(page.locator('#search-results')).toContainText('No results');
});

test('initial timeout is bounded and retry recovers without endless skeletons', async ({ page, appURL }) => {
  let hang = true;
  await contract(page, { intercept: async (route, url) => {
    if (hang && url.pathname === '/api/rooms/all') { return true; }
    return false;
  }});
  await page.goto(appURL + '?view=rooms');
  await expect(page.locator('#data-status')).toHaveAttribute('data-state', 'timeout', { timeout: 16000 });
  await expect(page.locator('#data-retry')).toBeVisible();
  await expect(page.locator('#rooms-container')).not.toContainText('217');
  hang = false;
  await page.locator('#data-retry').click();
  await expect(page.locator('#rooms-container')).toContainText('217');
});

test('foreground and reconnect refresh the roster', async ({ page, appURL }) => {
  const calls = await contract(page);
  await ready(page, appURL);
  for (const event of ['online', 'visibilitychange']) {
    const count = calls.filter(u => u.pathname === '/api/rooms/all').length;
    await page.evaluate(event => event === 'online' ? window.dispatchEvent(new Event(event)) : document.dispatchEvent(new Event(event)), event);
    await expect.poll(() => calls.filter(u => u.pathname === '/api/rooms/all').length).toBeGreaterThan(count);
  }
});

test('final occupied class is available after its end, and detail shares the configured threshold', async ({ page, appURL }) => {
  await contract(page);
  await ready(page, appURL, '?view=rooms&day=Monday&at=13:00&soon=120');
  await page.evaluate(() => openRoomDetail('CKB', 'G-08'));
  await expect(page.locator('#rds-status')).toContainText(/in use/i);
  await expect(page.locator('#room-free-window-text')).toContainText('3:00 PM');
  await expect(page.locator('#room-free-window-text')).not.toContainText('rest of the day');
  await expect(page.locator('#rds-day')).toContainText('Preview');
  await expect(page.locator('#rds-day')).not.toContainText('Today');
  await page.evaluate(() => openRoomDetail('CKB', '217'));
  await expect(page.locator('#rds-status')).toContainText(/closing/i);
});

test('zero occupancy does not imply a no-classes day', async ({ page, appURL }) => {
  await contract(page, { rooms: rooms.map(r => ({ ...r, empty: true })) });
  await ready(page, appURL);
  await expect(page.locator('#no-classes-banner')).toBeHidden();
  await expect(page.locator('#dash-no-classes-banner')).toBeHidden();
});

test('imported identifiers and metadata remain literal across all renderers and actions', async ({ page, appURL }) => {
  const building = `Q"'><b data-probe>李</b>`;
  const room = `G-08"'><img data-probe src=x>é`;
  await contract(page, { rooms: [{ ...rooms[0], building, room, empty: false }, ...rooms] });
  await ready(page, appURL);
  await page.evaluate(({ building, room }) => {
    localStorage.setItem('pinnedRooms', JSON.stringify([`${building}|${room}`]));
    return setSavedOnly(true);
  }, { building, room });
  await expect(page.locator('#rooms-container')).toContainText(room);
  await expect(page.locator('[data-probe]')).toHaveCount(0);
  await page.locator('#rooms-container button[aria-pressed]').click();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('pinnedRooms')))).toEqual([]);
  await page.evaluate(({ building, room }) => {
    const record = state.allRoomsCache.find(r => r.room === room);
    renderSidebarTopRooms([record]); renderFindRoom([record]);
    runSearch('G-08');
    BUILDING_COORDS[building] = [40.742, -74.178];
    updateBuildingMarkers(state.dashMap, state.dashMarkers, [{building, empty_rooms:1,total_rooms:1,occupancy_pct:0}], {interactive:false});
  }, { building, room });
  await expect(page.locator('#sidebar-top-rooms')).toContainText(room);
  await expect(page.locator('#fr-results')).toContainText(room);
  await expect(page.locator('#search-results')).toContainText(room);
  await expect(page.locator('[data-probe]')).toHaveCount(0);
  await page.evaluate(({building,room}) => openRoomDetail(building,room), {building,room});
  await expect(page.locator('#rds-room')).toHaveText(room);
  await expect(page.locator('#rds-list')).toContainText('Systems <intro>');
  await expect(page.locator('#rds-list')).toContainText("O'Neil — 李");
  await expect(page.locator('[data-probe]')).toHaveCount(0);
});

test('Settings export uses a transient Bearer header, never a password URL', async ({ page, appURL, server }) => {
  await contract(page);
  await ready(page, appURL);
  await page.evaluate(() => switchView('settings'));
  await page.locator('#upload-password').fill(server.uploadPassword);
  const request = page.waitForRequest(r => new URL(r.url()).pathname === '/api/export-schedule');
  await page.locator('#export-btn').click();
  const outgoing = await request;
  expect(outgoing.url()).not.toContain(server.uploadPassword);
  expect(outgoing.url()).not.toContain('password');
  expect(outgoing.headers().authorization).toBe(`Bearer ${server.uploadPassword}`);
  await expect(page.locator('#upload-password')).toHaveValue('');
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage }))).not.toContain(server.uploadPassword);
});

test('Settings upload failure preserves the file and explains auth recovery', async ({ page, appURL }) => {
  await contract(page, { intercept: async (route, url) => {
    if (url.pathname === '/api/upload-schedule') { await route.fulfill({ status:401,json:{error:'Unauthorized'} }); return true; }
    return false;
  }});
  await ready(page, appURL);
  await page.evaluate(() => switchView('settings'));
  await page.locator('#csv-file-input').setInputFiles({ name:'retry.csv', mimeType:'text/csv', buffer:Buffer.from('schedule') });
  await page.locator('#upload-password').fill('wrong');
  await page.locator('#upload-btn').click();
  await expect(page.locator('#upload-status')).toContainText(/password.*retry/i);
  await expect(page.locator('#file-preview-name')).toHaveText('retry.csv');
  await expect(page.locator('#upload-btn')).toBeEnabled();
  await expect(page.locator('#upload-password')).toHaveValue('');
});


test('periodic refresh publishes the new response receipt rather than keeping the old one', async ({ page, appURL }) => {
  await page.clock.install({ time: new Date(FETCHED) });
  let receipt = FETCHED;
  const calls = await contract(page,{fetchedAt:()=>receipt});
  await ready(page, appURL);
  await expect(page.locator('#grid-timestamp')).toContainText('1:00 PM');
  const count = calls.filter(url => url.pathname === '/api/rooms/all').length;
  receipt = '2026-10-05T17:01:00.000Z';
  await page.clock.fastForward(60001);
  await expect.poll(() => calls.filter(url => url.pathname === '/api/rooms/all').length).toBeGreaterThan(count);
  await expect(page.locator('#grid-timestamp')).toContainText('1:01 PM');
  expect(await page.evaluate(()=>state.snapshot.meta.fetchedAt)).toBe(receipt);
});

test('search keyboard selection stays on its room across a reordered refresh', async ({ page, appURL }) => {
  let reverse = false;
  await contract(page, { rooms: () => reverse ? [...rooms].reverse() : rooms });
  await ready(page, appURL);
  await page.locator('#global-search').fill('CKB');
  await page.evaluate(async () => { await runSearch('CKB'); highlightSearchIndex(2); });
  const before = await page.evaluate(() => searchFlatItems[searchActiveIndex].data.room);
  reverse = true;
  await page.evaluate(() => refresh());
  expect(await page.evaluate(() => searchFlatItems[searchActiveIndex]?.data.room)).toBe(before);
});

test('a newly opened detail leaves loading state visibly on failed fetch', async ({ page, appURL }) => {
  await contract(page, { intercept: async (route, url) => {
    if (url.pathname === '/api/room/schedule') { await route.fulfill({status:500,json:{error:'outage'}}); return true; }
    return false;
  }});
  await ready(page, appURL);
  await page.evaluate(() => openRoomDetail('CKB','217'));
  await expect(page.locator('#room-detail-sheet [data-surface-status]')).toContainText(/failed/i);
  await expect(page.locator('#rds-status')).not.toContainText(/loading/i);
  await expect(page.locator('#room-detail-sheet [data-surface-retry]')).toBeVisible();
});

test('elapsed live window is terminal without a retry loop; clearing recovers', async ({ page, appURL }) => {
  await page.clock.install({ time: new Date(FETCHED) });
  let ended = false;
  const calls = await contract(page, { intercept: async (route, url) => {
    if (ended && url.pathname === '/api/rooms' && url.searchParams.has('until')) {
      await route.fulfill({status:400,json:{error_code:'window_ended'}}); return true;
    }
    return false;
  }});
  await ready(page, appURL, '?view=rooms&until=14:00');
  ended = true;
  await page.evaluate(() => refresh());
  await expect(page.locator('#data-status')).toHaveAttribute('data-state','window-ended');
  await expect(page.locator('#data-status')).toContainText('ended');
  await expect(page.locator('#data-retry')).toBeHidden();
  const count = calls.length;
  await page.clock.fastForward(120001);
  for (let i=0; i<3; i++) { await page.waitForTimeout(50); expect(calls.length).toBe(count); }
  await page.evaluate(() => clearGapWindow());
  await expect(page.locator('#data-status')).toHaveAttribute('data-state','success');
});

test('legacy offline payload without context/version is not published as current availability', async ({ page, appURL }) => {
  await contract(page, { intercept: async (route, url) => {
    if (['/api/rooms','/api/rooms/all','/api/buildings'].includes(url.pathname)) {
      await route.fulfill({json:[],headers:{'X-Room-Finder-Cache':'offline'}}); return true;
    }
    return false;
  }});
  await page.goto(appURL + '?view=rooms');
  await expect(page.locator('#data-status')).toHaveAttribute('data-state','offline');
  await expect(page.locator('#data-status')).toContainText('older format');
  expect(await page.evaluate(() => state.snapshot)).toBeNull();
});

test('invalid URL time is visible validation, never a false Preview label', async ({ page, appURL }) => {
  await contract(page);
  await page.goto(appURL + '?view=rooms&at=banana');
  await expect(page.locator('#query-error')).toContainText('valid time');
  await expect(page.locator('#query-context')).not.toContainText('Preview');
});

test('missing server auth configuration has clear recovery and retains the upload file', async ({ page, appURL }) => {
  await contract(page, { intercept: async (route, url) => {
    if (url.pathname === '/api/upload-schedule' || url.pathname === '/api/export-schedule') {
      await route.fulfill({status:503,json:{error:'disabled'}}); return true;
    } return false;
  }});
  await ready(page, appURL);
  await page.evaluate(() => switchView('settings'));
  await page.locator('#csv-file-input').setInputFiles({name:'retry.csv',mimeType:'text/csv',buffer:Buffer.from('schedule')});
  await page.locator('#upload-btn').click();
  await expect(page.locator('#upload-status')).toContainText('configured upload password');
  await expect(page.locator('#file-preview-name')).toHaveText('retry.csv');
  await page.locator('#export-btn').click();
  await expect(page.locator('#upload-status')).toContainText('administrator');
  await expect(page.locator('#export-btn')).toBeEnabled();
});

// Real Flask routes, synthetic schedule, no contract route fulfillment.
for (const viewport of [{width:1440,height:1000}, {width:390,height:844}, {width:375,height:812}]) {
  test(`real endpoints preserve query, Saved, finder and detail at ${viewport.width}x${viewport.height}`, async ({page,appURL}, testInfo) => {
    await page.setViewportSize(viewport);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => localStorage.setItem('pinnedRooms', '["FMH|101","OLD|100A"]'));
    await page.goto(appURL + '?view=rooms&day=Monday&at=13:00&until=15:00');
    await expect(page.locator('#data-status')).toHaveAttribute('data-state','success');
    await expect(page.locator('#query-context')).toContainText('Preview · Monday · 1:00 PM ET');
    await expect(page.locator('#rooms-container')).toContainText('G-08');
    await expect(page.locator('#rooms-container')).not.toContainText('217');
    expect(await page.evaluate(() => ({verified:state.snapshot.meta.verified, count:state.allRoomsCache.length}))).toEqual({verified:true,count:4});
    await page.screenshot({animations:'disabled',path:testInfo.outputPath(`rooms-${viewport.width}.png`)});
    await page.evaluate(() => setSavedOnly(true));
    await expect(page.locator('#rooms-container')).toContainText('IN USE');
    await expect(page.locator('#rooms-container')).toContainText('Not in current schedule');
    await page.evaluate(() => openFindRoom());
    await expect(page.locator('#fr-gap-until')).toHaveValue('15:00');
    await expect(page.locator('#fr-results')).toContainText('G-08');
    await expect(page.locator('#fr-results')).not.toContainText('217');
    await page.screenshot({animations:'disabled',path:testInfo.outputPath(`finder-${viewport.width}.png`)});
    await page.evaluate(() => { closeFindRoom(); openRoomDetail('FMH','101'); });
    await expect(page.locator('#rds-status')).toContainText(/in use/i);
    await expect(page.locator('#room-free-window')).toContainText('2:00 PM');
    await page.reload();
    await expect(page.locator('#rds-status')).toContainText(/in use/i);
    await expect(page.locator('#room-detail-sheet [data-surface-status]')).toContainText('3:00 PM ET');
    await page.screenshot({animations:'disabled',path:testInfo.outputPath(`detail-${viewport.width}.png`)});
    await page.evaluate(() => { closeRoomDetail(); openBuildingPanel(state.buildingsData.find(b => b.building === 'CKB')); });
    await expect(page.locator('#floor-panel')).toContainText('217');
    await expect(page.locator('#data-status')).toHaveAttribute('data-state','success');
    expect(errors).toEqual([]);
  });
}

test('sidebar identifiers stay readable beside long availability labels', async ({page,appURL}) => {
  await page.setViewportSize({width:1440,height:1000});
  await page.goto(appURL + '?view=rooms');
  await expect(page.locator('#data-status')).toHaveAttribute('data-state','success');
  const identity = page.locator('#sidebar-top-rooms button').filter({hasText:'CAB 2020'}).locator('span').first();
  const size = await identity.evaluate(el => ({height:el.getBoundingClientRect().height, line:parseFloat(getComputedStyle(el).lineHeight)}));
  expect(size.height).toBeLessThanOrEqual(size.line * 1.1);
});

test.describe('late-night real endpoint validation', () => {
  test.use({fixtureNow:'2026-10-06T02:01:00.000Z'}); // Monday 22:01 Eastern
  for (const query of ['for=120', 'day=Monday&for=120', 'at=22:01&for=120']) {
    test(`impossible window is terminal and editable: ${query}`, async ({page,appURL,request}) => {
      const response = await request.get('/api/rooms?' + query);
      expect(response.status()).toBe(400);
      expect((await response.json()).error_code).toBe(query.includes('at=') ? 'invalid_window' : 'duration_exceeds_day');
      await page.clock.install({time:new Date('2026-10-06T02:01:00.000Z')});
      let requests = 0;
      page.on('request', request => { if (new URL(request.url()).pathname === '/api/rooms') requests++; });
      await page.goto(appURL + '?view=rooms&' + query);
      await expect(page.locator('#data-status')).toHaveAttribute('data-state','invalid');
      await expect(page.locator('#data-status')).toContainText(/shorter duration|start time/i);
      await expect(page.locator('#query-error')).not.toBeEmpty();
      await expect(page.locator('#data-retry')).toBeHidden();
      await page.locator('#data-edit-query').click();
      await expect(page.locator('#time-filter-for')).toBeFocused();
      const count = requests;
      await page.clock.fastForward(120001);
      for (let i=0; i<3; i++) { await page.waitForTimeout(50); expect(requests).toBe(count); }
      await page.evaluate(() => commitQuery({...state.query,for:30}));
      await expect(page.locator('#data-status')).toHaveAttribute('data-state','success');
    });
  }
});

const VALID_CSV = 'Term,Course,Days,Times,Location,Max,Delivery Mode\n202690,CS 113,MW,1:00 PM - 2:20 PM,KUPF 207,40,Face-to-Face\n';

for (const format of ['csv','xlsx']) test(`F1 real ${format} upload then export downloads exact bytes and server filename`, async ({page,appURL,server}, testInfo) => {
  const bytes = format === 'csv' ? Buffer.from(VALID_CSV) : require('node:child_process').execFileSync(process.env.ROOM_FINDER_TEST_PYTHON, ['-c',
    'import csv,io,sys; from openpyxl import Workbook; w=Workbook(); s=w.active; [s.append(r) for r in csv.reader(io.StringIO(sys.argv[1]))]; b=io.BytesIO(); w.save(b); sys.stdout.buffer.write(b.getvalue())',VALID_CSV]);
  await page.goto(appURL + '?view=settings');
  await page.locator('#csv-file-input').setInputFiles({name:`original.${format}`,mimeType:format === 'csv' ? 'text/csv' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:bytes});
  await page.locator('#upload-password').fill(server.uploadPassword);
  await page.locator('#upload-btn').click();
  await expect(page.locator('#upload-status')).toContainText('Schedule loaded');
  await page.locator('#upload-password').fill(server.uploadPassword);
  const downloaded = page.waitForEvent('download');
  await page.locator('#export-btn').click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe(`Course_Schedule_202690.${format}`);
  const {readFile} = require('node:fs/promises');
  expect(await readFile(await download.path())).toEqual(bytes);
  await expect(page.locator('#upload-status')).toContainText('Schedule exported');
  await expect(page.locator('#upload-password')).toHaveValue('');
  const contrast = await page.locator('#export-term').evaluate(el => {
    const rgba = value => {
      const parts = value.match(/[\d.]+/g).map(Number);
      return [parts[0],parts[1],parts[2],parts[3] ?? 1];
    };
    const layers=[];
    for (let node=el;node;node=node.parentElement) layers.unshift(rgba(getComputedStyle(node).backgroundColor));
    // Composite all ancestor fills over the opaque browser canvas, then the text.
    const over=(front,back)=>front.slice(0,3).map((v,i)=>v*front[3]+back[i]*(1-front[3]));
    const background=layers.reduce((back,front)=>over(front,back),[255,255,255]);
    const ink=over(rgba(getComputedStyle(el).color),background);
    const luminance=rgb=>rgb.map(v=>v/255).map(v=>v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[0.2126,0.7152,0.0722][i],0);
    const a=luminance(ink), b=luminance(background);
    return (Math.max(a,b)+0.05)/(Math.min(a,b)+0.05);
  });
  expect(contrast).toBeGreaterThanOrEqual(4.5);
  testInfo.annotations.push({type:'export-selector-contrast',description:`${contrast.toFixed(2)}:1`});
  await page.screenshot({animations:'disabled',path:testInfo.outputPath(`export-${format}-success.png`)});
});

test('F1 selected historical term controls real export bytes', async ({page,appURL,request,server}) => {
  const historical = VALID_CSV.replaceAll('202690','202650');
  for (const body of [VALID_CSV,historical]) {
    const response = await request.post('/api/upload-schedule',{multipart:{password:server.uploadPassword,file:{name:'term.csv',mimeType:'text/csv',buffer:Buffer.from(body)}}});
    expect(response.status()).toBe(200);
  }
  await page.goto(appURL+'?view=settings');
  await page.locator('#export-term').selectOption('202650');
  await page.locator('#upload-password').fill(server.uploadPassword);
  const downloaded=page.waitForEvent('download');
  await page.locator('#export-btn').click();
  const file=await downloaded;
  expect(file.suggestedFilename()).toBe('Course_Schedule_202650.csv');
  expect(await require('node:fs/promises').readFile(await file.path(),'utf8')).toBe(historical);
});

test('F2 capped imported diagnostic is literal text, never markup',async({page,appURL})=>{
  const diagnostic='<img src=x onerror="window.injected=true">'+ 'x'.repeat(800);
  await contract(page,{intercept:async(route,url)=>{
    if (url.pathname === '/api/upload-schedule') {await route.fulfill({status:422,json:{error:diagnostic}});return true;}return false;
  }});
  await page.goto(appURL+'?view=settings');
  await page.locator('#csv-file-input').setInputFiles({name:'bad.csv',mimeType:'text/csv',buffer:Buffer.from('bad')});
  await page.locator('#upload-btn').click();
  await expect(page.locator('#upload-status')).toHaveText(diagnostic.slice(0,600));
  await expect(page.locator('#upload-status img')).toHaveCount(0);
  expect(await page.evaluate(()=>window.injected)).toBeUndefined();
});

test('F8 export allows a longer read but remains bounded',async({page,appURL})=>{
  await page.clock.install({time:new Date(FETCHED)});
  let exports=0;
  await contract(page,{intercept:async(route,url)=>{
    if (url.pathname === '/api/export-schedule') {exports++;return true;}return false;
  }});
  await page.goto(appURL+'?view=settings');
  await page.locator('#export-btn').click();
  await expect.poll(()=>exports).toBe(1);
  await page.clock.fastForward(13000);
  await expect(page.locator('#export-btn')).toBeDisabled();
  await page.clock.fastForward(60000);
  await expect(page.locator('#upload-status')).toContainText('too long');
  await expect(page.locator('#export-btn')).toBeEnabled();
  await page.waitForTimeout(150);
  expect(exports).toBe(1);
});

for (const failure of ['connectionreset',502,504]) test(`F8 interrupted upload warns outcome uncertainty without automatic resend: ${failure}`,async({page,appURL})=>{
  let calls=0;
  await contract(page,{intercept:async(route,url)=>{
    if (url.pathname === '/api/upload-schedule') {
      calls++;
      if (typeof failure === 'number') await route.fulfill({status:failure,json:{error:'upstream unavailable'}});
      else await route.abort(failure);
      return true;
    }return false;
  }});
  await page.goto(appURL+'?view=settings');
  await page.locator('#csv-file-input').setInputFiles({name:'maybe.csv',mimeType:'text/csv',buffer:Buffer.from(VALID_CSV)});
  await page.locator('#upload-btn').click();
  await expect(page.locator('#upload-status')).toContainText('may have been applied');
  await page.waitForTimeout(150);
  expect(calls).toBe(1);
});

test('R1 availability404 retains data with Last known badge, never Now',async({page,appURL})=>{
  let fail=false;
  await contract(page,{intercept:async(route,url)=>{
    if (fail && url.pathname === '/api/rooms/all') {await route.fulfill({status:404,json:{error:'route unavailable'}});return true;}
    return false;
  }});
  await ready(page,appURL);
  const receipt=await page.locator('#grid-timestamp').textContent();
  fail=true;
  await page.evaluate(()=>refresh());
  await expect(page.locator('#rooms-container')).toContainText('217');
  await expect(page.locator('#grid-timestamp')).toHaveText(receipt);
  await expect(page.locator('[data-live-label]').first()).toHaveText('Last known');
  await expect(page.locator('#rooms-view-semester')).not.toContainText('Now');
});

test('F1 no stored term is honest, not a broken export request', async ({page,appURL}) => {
  let exports = 0;
  page.on('request', r => {if (r.url().includes('/api/export-schedule')) exports++;});
  await page.goto(appURL + '?view=settings');
  await page.evaluate(() => exportSchedule());
  await expect(page.locator('#upload-status')).toContainText('No stored schedule');
  expect(exports).toBe(0);
});

test('F2 actual malformed CSV upload exposes actionable validation and keeps file', async ({page,appURL,server}) => {
  await page.goto(appURL + '?view=settings');
  await page.locator('#csv-file-input').setInputFiles({name:'broken.csv',mimeType:'text/csv',buffer:Buffer.from('not,a,schedule\n1,2,3\n')});
  await page.locator('#upload-password').fill(server.uploadPassword);
  const response = page.waitForResponse(r => r.url().includes('/api/upload-schedule'));
  await page.locator('#upload-btn').click();
  const result = await response;
  expect(result.status()).toBe(422);
  const error = (await result.json()).error;
  await expect(page.locator('#upload-status')).toHaveText(error.slice(0,600));
  await expect(page.locator('#file-preview-name')).toHaveText('broken.csv');
  await expect(page.locator('#upload-password')).toHaveValue('');
});

for (const path of ['client-ended','server-ended','invalid-deep-link']) {
  test(`F3 terminal detail and offline retain Edit filters: ${path}`, async ({page,appURL}) => {
    let ended = false;
    await contract(page,{intercept:async(route,url)=>{
      if (ended && url.pathname !== '/api/schedule-info') {await route.fulfill({status:400,json:{error_code:'window_ended'}});return true;}
      return false;
    }});
    if (path === 'invalid-deep-link') await page.goto(appURL + '?view=rooms&at=banana&room=CKB-217');
    else {
      await ready(page,appURL,'?view=rooms&until=14:00');
      if (path === 'client-ended') await page.clock.setFixedTime(new Date('2026-10-05T18:05:00Z'));
      else ended = true;
      await page.evaluate(() => openRoomDetail('CKB','217'));
    }
    await expect(page.locator('#rds-status')).not.toContainText(/loading/i);
    await expect(page.locator('#rds-list')).not.toContainText('Retry');
    await expect(page.locator('#room-detail-sheet [data-surface-edit]')).toBeVisible();
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    await expect(page.locator('#data-status')).toHaveAttribute('data-state',path === 'invalid-deep-link' ? 'invalid' : 'window-ended');
    await expect(page.locator('#room-detail-sheet [data-surface-retry]')).toBeHidden();
  });
}

test('F4 changing buildings clears old heatmap when refresh fails', async ({page,appURL}) => {
  let fail = false;
  await page.route('**/api/**', route => fail ? route.fulfill({status:503,json:{error:'down'}}) : route.fallback());
  await ready(page,appURL);
  await page.evaluate(() => openBuildingPanel(state.buildingsData.find(b=>b.building === 'CAB')));
  await expect(page.locator('#panel-heatmap .heatmap-cell').first()).toBeAttached();
  fail = true;
  await page.evaluate(() => openBuildingPanel(state.buildingsData.find(b=>b.building === 'FMH')));
  await expect(page.locator('#data-status')).toHaveAttribute('data-state','error');
  await expect(page.locator('#panel-heatmap .heatmap-cell')).toHaveCount(0);
  await expect(page.locator('#panel-heatmap')).toContainText(/unavailable/i);
});

test('F4 optional heatmap404 does not discard availability refresh', async ({page,appURL}) => {
  await page.route('**/api/heatmap*', route => route.fulfill({status:404,json:{error:'unavailable'}}));
  await ready(page,appURL);
  await page.evaluate(() => openBuildingPanel(state.buildingsData.find(b=>b.building === 'CKB')));
  await expect.poll(() => page.evaluate(() => state.snapshot.buildingKey)).toBe('CKB');
  await expect(page.locator('#data-status')).toHaveAttribute('data-state','success');
  await expect(page.locator('#panel-heatmap')).toContainText(/unavailable/i);
  await expect(page.locator('#floor-panel')).toContainText('217');
});

for (const scenario of ['503','offline','invalid']) {
  test(`F5 unloaded Saved pins remain unknown after ${scenario}`, async ({page,appURL}) => {
    await page.addInitScript(() => localStorage.setItem('pinnedRooms','["CKB|217"]'));
    await page.route('**/api/**', route => scenario === 'offline' ? route.abort('internetdisconnected') : route.fulfill({status:503,json:{error:'down'}}));
    await page.goto(appURL + '?view=rooms' + (scenario === 'invalid' ? '&at=banana' : ''));
    await expect(page.locator('#data-status')).not.toHaveAttribute('data-state','loading');
    await page.locator('#saved-rooms-btn').click();
    await expect(page.locator('#rooms-container')).toContainText('Availability unknown');
    await expect(page.locator('#rooms-container')).not.toContainText(/Not in current schedule/i);
  });
}

test('F6 Rooms chips count matching rooms not instantaneous emptiness', async ({page,appURL}) => {
  await page.goto(appURL + '?view=rooms&for=120');
  await expect(page.locator('#data-status')).toHaveAttribute('data-state','success');
  await expect(page.locator('#building-filter')).toContainText('CKB (1)');
});

for (const resolves of [false,true]) {
  test(`F7 first incoherent load retries once without claiming retained data: resolves=${resolves}`, async ({page,appURL}) => {
    let rosterCalls=0;
    await contract(page,{intercept:async(route,url)=>{
      if (url.pathname === '/api/rooms/all') {
        rosterCalls++;
        if (!resolves || rosterCalls===1) { await route.fulfill({json:rooms,headers:{'X-Schedule-Version':'different'}});return true; }
      } return false;
    }});
    await page.goto(appURL + '?view=rooms');
    await expect.poll(()=>rosterCalls).toBe(2);
    await expect(page.locator('#data-status')).toHaveAttribute('data-state',resolves?'success':'inconsistent');
    if (!resolves) {
      await expect(page.locator('#data-status-text')).not.toContainText(/previous|retained/i);
      await expect(page.locator('[data-live-label]').first()).not.toContainText(/last known/i);
    }
    await page.waitForTimeout(150);
    expect(rosterCalls).toBe(2);
  });
}

test('F8 upload has longer bounded timeout and warns uncertain application without retry', async ({page,appURL}) => {
  await page.clock.install({time:new Date(FETCHED)});
  let calls=0;
  await contract(page,{intercept:async(route,url)=>{
    if (url.pathname === '/api/upload-schedule') {calls++;return true;} return false;
  }});
  await ready(page,appURL);
  await page.evaluate(()=>switchView('settings'));
  await page.locator('#csv-file-input').setInputFiles({name:'slow.csv',mimeType:'text/csv',buffer:Buffer.from(VALID_CSV)});
  await page.locator('#upload-btn').click();
  await expect.poll(()=>calls).toBe(1);
  await page.clock.fastForward(13000);
  await expect(page.locator('#upload-btn')).toBeDisabled();
  await page.clock.fastForward(120000);
  await expect(page.locator('#upload-status')).toContainText('may have been applied');
  await expect(page.locator('#upload-status')).toContainText('Check the current schedule');
  await expect(page.locator('#file-preview-name')).toHaveText('slow.csv');
  await page.waitForTimeout(150);
  expect(calls).toBe(1);
});

test.describe('F9 exact hyphenated identity and legacy links',()=>{
  test.use({fixtureSchedule:[[
    {building:'A-B',room:'C-1',days:[0],time_start:'14:30',time_end:'15:30',capacity:30,course:'T 1',title:'x',instructor:'y',term:202690},
    {building:'A',room:'B-C-1',days:[0],time_start:'09:00',time_end:'10:00',capacity:30,course:'T 2',title:'x',instructor:'y',term:202690}
  ],{option:true}]});
  test('roundtrips roomBuilding while preserving legacy first-dash interpretation',async({page,appURL})=>{
    await page.goto(appURL+'?view=rooms&room=A-B-C-1&roomBuilding=A-B');
    await expect(page.locator('#rds-building')).toHaveText('A-B · Room Detail');
    await expect(page.locator('#rds-room')).toHaveText('C-1');
    await expect(page.locator('#rds-status')).not.toContainText(/loading/i);
    await page.evaluate(()=>openRoomDetail('A','B-C-1'));
    await expect(page.locator('#rds-building')).toHaveText('A · Room Detail');
    await expect(page).not.toHaveURL(/roomBuilding/);
    await page.reload();
    await expect(page.locator('#rds-room')).toHaveText('B-C-1');
    await expect(page.locator('#rds-building')).toHaveText('A · Room Detail');
  });
});

test.describe('campus time does not follow browser timezone', () => {
  test.use({timezoneId:'Asia/Tokyo'});
  test('Now, preview and receipt labels remain Eastern', async ({page,appURL}) => {
    await contract(page);
    await ready(page,appURL);
    await expect(page.locator('#query-context')).toContainText('Now · Monday · 1:00 PM ET');
    await expect(page.locator('#grid-timestamp')).toContainText('1:00 PM ET');
    await expect(page.locator('#hdr-day')).toHaveText('Monday');
  });
});
