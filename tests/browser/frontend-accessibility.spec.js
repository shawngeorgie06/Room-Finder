const {test,expect}=require('./fixtures');

async function ready(page,appURL,query='?view=rooms') {
  await page.goto(appURL+query);
  await expect(page.locator('#data-status')).toHaveAttribute('data-state','success');
}
async function contained(page,id) {
  expect(await page.evaluate(id=>document.getElementById(id).contains(document.activeElement),id)).toBe(true);
}

test('finder to detail retains underlying dialog, traps focus and restores logical room',async({page,appURL})=>{
  await ready(page,appURL,'?view=dashboard');
  const trigger=page.locator('button[onclick="openFindRoom()"]');
  await trigger.click();
  const finder=page.getByRole('dialog',{name:'Find Me a Room',exact:true});
  await expect(finder).toBeVisible();
  await expect(page.locator('main')).toHaveAttribute('inert','');
  await contained(page,'find-room-modal');
  const row=page.locator('#fr-results [role="button"]').filter({hasText:'217'});
  await row.focus(); await page.keyboard.press('Enter');
  await expect(page.locator('#find-room-modal')).toHaveAttribute('inert','');
  await expect(page.getByRole('dialog',{name:/Room detail/})).toBeVisible();
  await page.keyboard.press('Shift+Tab'); await contained(page,'room-detail-sheet');
  await page.keyboard.press('Tab'); await contained(page,'room-detail-sheet');
  await page.keyboard.press('Escape');
  await expect(finder).toBeVisible();
  await expect(page.locator('#find-room-modal')).not.toHaveAttribute('inert','');
  await expect(row).toBeFocused();
  await page.keyboard.press('Escape'); await expect(trigger).toBeFocused();
  await expect(page.locator('main')).not.toHaveAttribute('inert','');
  expect(await page.evaluate(()=>document.body.style.overflow)).not.toBe('hidden');
});

test('building to detail closes only top overlay and restores refreshed room focus',async({page,appURL})=>{
  await ready(page,appURL,'?view=dashboard');
  const building=page.locator('#buildings-grid button').filter({hasText:'CKB'});
  await building.click();
  await expect(page.getByRole('dialog',{name:/Building CKB/})).toBeVisible();
  const room=page.locator('#floor-rooms button').filter({hasText:'217'});
  await room.focus(); await page.keyboard.press('Enter');
  await expect(page.locator('#floor-panel')).toHaveAttribute('inert','');
  await page.evaluate(()=>refresh());
  await page.keyboard.press('Escape'); await expect(room).toBeFocused();
  await page.keyboard.press('Escape'); await expect(building).toBeFocused();
});

for(const viewport of [{width:1440,height:1000},{width:390,height:844},{width:375,height:812}]) {
  test(`building panel groups rooms by floor and tile text fits at ${viewport.width}`,async({page,appURL})=>{
    await page.setViewportSize(viewport); await ready(page,appURL,'?view=dashboard');
    // Rooms with no recorded floor are grouped by room number, not dumped under one heading.
    await page.evaluate(()=>{
      state.allRoomsCache=state.allRoomsCache.map(r=>r.building==='CKB'?{...r,floor:null}:r);
      state.allRoomsCacheReady=true;
      openBuildingPanel(state.buildingsData.find(b=>b.building==='CKB'));
    });
    await expect(page.locator('#floor-rooms')).not.toContainText('Floor not recorded');
    await expect(page.locator('#floor-rooms [data-floor-head]').first()).toContainText(/(Floor \d|Ground floor)/);
    // Every status wording, including the long ones, must stay inside its tile.
    const overflowing=await page.evaluate(()=>{
      const mk=(room,o)=>({building:'CKB',room,floor:null,empty:true,minutes_until_next:45,...o});
      renderRoomsByFloor([
        mk('101',{empty:false}),mk('102',{availabilityUnknown:true}),mk('103',{missingFromSchedule:true}),
        mk('104',{minutes_until_next:null}),mk('105',{minutes_until_next:12}),mk('106',{minutes_until_next:95}),
        mk('107',{minutes_until_next:undefined}),mk('2020',{minutes_until_next:135}),
      ]);
      return [...document.querySelectorAll('#floor-rooms button[data-room]')].filter(btn=>{
        const range=document.createRange(); range.selectNodeContents(btn.lastElementChild);
        const text=range.getBoundingClientRect(), tile=btn.getBoundingClientRect();
        return text.right>tile.right-1||text.left<tile.left;
      }).map(btn=>btn.dataset.room);
    });
    expect(overflowing).toEqual([]);
  });

  test(`filter draft apply cancel reset and bounded detail at ${viewport.width}`,async({page,appURL},info)=>{
    await page.setViewportSize(viewport); await ready(page,appURL);
    const trigger=page.getByRole('button',{name:'Filters',exact:true});
    await trigger.click();
    const sheet=page.getByRole('dialog',{name:'Availability filters'});
    await expect(sheet).toBeVisible();
    await sheet.getByLabel('Start time Eastern').fill('13:00');
    await sheet.getByLabel('End time Eastern').fill('15:00');
    await page.keyboard.press('Escape');
    await expect(page).not.toHaveURL(/until=/); await expect(trigger).toBeFocused();
    await trigger.click(); await expect(sheet.getByLabel('End time Eastern')).toHaveValue('');
    await sheet.getByLabel('Start time Eastern').fill('13:00');
    await sheet.getByLabel('End time Eastern').fill('12:00');
    await sheet.getByRole('button',{name:'Apply filters',exact:true}).click();
    await expect(sheet.getByLabel('End time Eastern')).toBeFocused();
    await expect(sheet.getByRole('alert')).toContainText('after');
    await sheet.getByLabel('End time Eastern').fill('15:00');
    await sheet.getByRole('button',{name:'Apply filters',exact:true}).click();
    await expect(sheet).toBeHidden(); await expect(page).toHaveURL(/until=15%3A00/);
    await expect(page.locator('#rooms-container')).not.toContainText('217');
    await expect(page.locator('#applied-query')).toContainText('3:00 PM ET');
    await trigger.click(); await sheet.getByRole('button',{name:'Reset draft',exact:true}).click();
    await expect(page).toHaveURL(/until=/);
    await sheet.getByRole('button',{name:'Apply filters',exact:true}).click();
    await expect(page).not.toHaveURL(/until=/);
    await expect(page.locator('#rooms-container')).toContainText('217');
    await page.screenshot({animations:'disabled',path:info.outputPath(`filters-applied-${viewport.width}.png`)});
    await page.locator('#rooms-container [role="button"]').filter({hasText:'217'}).click();
    const detail=page.getByRole('dialog',{name:/Room detail/}); await expect(detail).toBeVisible();
    const box=await detail.boundingBox(); expect(box.width).toBeLessThanOrEqual(Math.min(720,viewport.width));
    const title=await page.locator('#rds-room').boundingBox(),status=await page.locator('#rds-status').boundingBox();
    expect(title.y+title.height<=status.y || title.x+title.width<=status.x).toBe(true);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({animations:'disabled',path:info.outputPath(`detail-${viewport.width}.png`)});
  });
}

test('keyboard boundaries, stack Escape and phone geometry',async({page,appURL})=>{
  await page.setViewportSize({width:375,height:812}); await ready(page,appURL,'?view=dashboard');
  await page.locator('button[onclick="openFindRoom()"]').click();
  const close=page.getByRole('button',{name:'Close find a room'});
  await close.focus(); await page.keyboard.press('Shift+Tab');
  expect.soft(await page.evaluate(()=>document.getElementById('find-room-modal').contains(document.activeElement))).toBe(true);
  expect.soft(await page.evaluate(()=>document.body.style.overflow)).toBe('hidden');
  await page.locator('#fr-results [role="button"]').filter({hasText:'217'}).click();
  await expect.soft(page.locator('#find-room-modal')).not.toHaveClass(/hidden/);
  await expect.soft(page.locator('#rds-room')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect.soft(page.locator('#find-room-modal')).not.toHaveClass(/hidden/);
});

test('filter refresh leaves dirty draft and focused control intact; Cancel discards',async({page,appURL})=>{
  await ready(page,appURL);
  await page.getByRole('button',{name:'Filters',exact:true}).click();
  const end=page.getByRole('dialog',{name:'Availability filters'}).getByLabel('End time Eastern');
  await end.fill('15:00'); await page.evaluate(()=>refresh());
  await expect(end).toHaveValue('15:00'); await expect(end).toBeFocused();
  await page.getByRole('button',{name:'Cancel filters'}).click();
  await expect(page).not.toHaveURL(/until=/);
});

test('terminal Edit filters opens correction sheet and returns to valid results',async({page,appURL})=>{
  await page.goto(appURL+'?view=rooms&at=banana');
  await page.getByRole('button',{name:'Edit filters',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Availability filters'});
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Start time Eastern').fill('13:00');
  await dialog.getByRole('button',{name:'Apply filters'}).click();
  await expect(page.locator('#data-status')).toHaveAttribute('data-state','success');
});

test('one active announcement region and no chatter for unchanged periodic refresh',async({page,appURL})=>{
  await page.clock.install({time:new Date('2026-10-05T17:00:00Z')});
  await ready(page,appURL);
  const regions=()=>page.locator('[role="status"], [aria-live="polite"]');
  expect(await regions().count()).toBe(2); // central announcer plus visible-only Settings upload result
  await page.evaluate(()=>{window.messages=[];new MutationObserver(()=>window.messages.push(document.getElementById('sr-status').textContent)).observe(document.getElementById('sr-status'),{childList:true,subtree:true});});
  await page.clock.fastForward(60001); await page.waitForTimeout(150);
  expect(await page.evaluate(()=>window.messages)).toEqual([]);
});

test('new building heatmap is Loading while its request is pending',async({page,appURL})=>{
  let release;const held=new Promise(resolve=>release=resolve);
  await page.route('**/api/heatmap*',async route=>{await held;await route.fallback();});
  await ready(page,appURL,'?view=dashboard');
  await page.locator('#buildings-grid button').filter({hasText:'CKB'}).click();
  await expect(page.locator('#panel-heatmap')).toHaveText('Loading weekly schedule…');
  release(); await expect(page.locator('#panel-heatmap .heatmap-cell').first()).toBeAttached();
});

test('phone filter sheet: visible Edit control, focus moves in, Apply/Reset/Esc work, focus returns',async({page,appURL})=>{
  await page.setViewportSize({width:390,height:844}); await ready(page,appURL);
  const trigger=page.getByRole('button',{name:'Filters',exact:true});
  const tb=await trigger.boundingBox();
  expect(tb.x).toBeGreaterThanOrEqual(0); expect(tb.x+tb.width).toBeLessThanOrEqual(390); expect(tb.height).toBeGreaterThanOrEqual(44);
  const summary=page.locator('#applied-query'); await expect(summary).toBeVisible();
  expect((await summary.boundingBox()).x+(await summary.boundingBox()).width).toBeLessThanOrEqual(390);
  await trigger.click();
  const sheet=page.getByRole('dialog',{name:'Availability filters'});
  await expect(sheet).toBeVisible(); await expect(sheet).toHaveAttribute('aria-modal','true');
  await contained(page,'filter-sheet');
  await expect(page.locator('main')).toHaveAttribute('inert','');
  for(const name of ['Apply filters','Reset draft','Cancel filters']) {
    const b=await sheet.getByRole('button',{name,exact:true}).boundingBox();
    expect(b.height).toBeGreaterThanOrEqual(44); expect(b.y+b.height).toBeLessThanOrEqual(844);
  }
  await sheet.getByLabel('Day',{exact:true}).selectOption('Monday');
  await sheet.getByLabel('Start time Eastern').fill('13:00');
  await sheet.getByLabel('Minimum free duration').selectOption('60');
  await sheet.getByLabel('No more scheduled classes today').check();
  await sheet.getByRole('button',{name:'Apply filters',exact:true}).click();
  await expect(sheet).toBeHidden(); await expect(trigger).toBeFocused();
  await expect(summary).toContainText('Monday'); await expect(summary).toContainText('1:00 PM');
  await expect(page).toHaveURL(/freeAllDay=1/);
  await trigger.click();
  await expect(sheet.getByLabel('No more scheduled classes today')).toBeChecked();
  await sheet.getByRole('button',{name:'Reset draft',exact:true}).click();
  await expect(sheet.getByLabel('Day',{exact:true})).toHaveValue('');
  await expect(sheet.getByLabel('No more scheduled classes today')).not.toBeChecked();
  await expect(sheet.getByRole('alert')).toHaveText('');
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden(); await expect(trigger).toBeFocused();
  await expect(page).toHaveURL(/freeAllDay=1/); // Esc discarded the reset draft
});

test('phone room detail header does not wrap and answer precedes schedule',async({page,appURL})=>{
  await page.setViewportSize({width:390,height:844}); await ready(page,appURL);
  await page.evaluate(()=>openRoomDetail('CKB','217'));
  const detail=page.getByRole('dialog',{name:/Room detail/}); await expect(detail).toBeVisible();
  await expect(page.locator('#rds-status')).not.toHaveText('Loading…');
  await page.evaluate(()=>{document.getElementById('rds-room').textContent='G-08';});
  const room=await page.locator('#rds-room').boundingBox();
  expect(room.height).toBeLessThan(50); // single line at text-3xl
  const buttons=await detail.locator('header button, button[aria-label="Close room detail"], #rds-pin, button[title="Copy link to this room"]').evaluateAll(els=>els.map(e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};}));
  for(const b of buttons) { expect(b.w).toBeGreaterThanOrEqual(44); expect(b.x+b.w).toBeLessThanOrEqual(390); expect(Math.abs(b.y-buttons[0].y)).toBeLessThan(2); }
  const status=await page.locator('#rds-status').boundingBox();
  expect(status.x+status.width).toBeLessThanOrEqual(390);
  const order=await page.evaluate(()=>{const q=s=>document.querySelector(s).getBoundingClientRect().top;return [q('#rds-status'),q('#rds-timeline'),q('#rds-list')];});
  expect(order[0]).toBeLessThan(order[1]); expect(order[1]).toBeLessThan(order[2]);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test('desktop room detail is a bounded centered panel, not full width',async({page,appURL})=>{
  await page.setViewportSize({width:1440,height:1000}); await ready(page,appURL);
  await page.evaluate(()=>openRoomDetail('CKB','217'));
  const detail=page.getByRole('dialog',{name:/Room detail/}); await expect(detail).toBeVisible();
  await page.waitForTimeout(500);
  const box=await detail.boundingBox();
  expect(box.width).toBeLessThanOrEqual(680); expect(box.width).toBeGreaterThan(400);
  expect(Math.abs((box.x+box.width/2)-720)).toBeLessThan(2);
  await page.keyboard.press('Escape'); await expect(detail).toBeHidden();
});

test('filter sheet aria, focus return and error live region at 390', async ({ page, appURL }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await ready(page, appURL);
  const trigger = page.getByRole('button', { name: 'Filters', exact: true });
  await trigger.click();
  const sheet = page.getByRole('dialog', { name: 'Availability filters' });
  expect(await sheet.getAttribute('aria-hidden')).toBe('false');
  expect(await page.locator('#filter-error').getAttribute('role')).toBe('alert');
  // Underlying page is inert, sheet is the only modal.
  await expect(page.locator('main')).toHaveAttribute('inert', '');
  await expect(page.locator('#filter-sheet')).not.toHaveAttribute('inert', '');
  // Invalid window keeps the sheet open and focuses the offending control.
  await sheet.getByLabel('Start time Eastern').fill('14:00');
  await sheet.getByLabel('End time Eastern').fill('13:00');
  await sheet.getByRole('button', { name: 'Apply filters', exact: true }).click();
  await expect(sheet).toBeVisible();
  await expect(sheet.getByLabel('End time Eastern')).toBeFocused();
  await expect(page).not.toHaveURL(/at=14/);
  // Esc discards and returns focus.
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(page).not.toHaveURL(/at=14/);
  // Reopening shows the committed query, not the discarded draft.
  await trigger.click();
  await expect(sheet.getByLabel('Start time Eastern')).toHaveValue('');
  await expect(sheet.getByLabel('End time Eastern')).toHaveValue('');
});

test('share link and saved pin survive a filter round trip', async ({ page, appURL, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await ready(page, appURL, '?view=rooms&day=Monday&at=13:00');
  await page.locator('#rooms-container [role="button"]').filter({ hasText: 'G-08' }).first().click();
  await expect(page.getByRole('dialog', { name: /Room detail/ })).toBeVisible();
  await page.locator('#rds-pin').click();
  await expect(page.locator('#rds-pin')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('button[aria-label="Copy link to this room"]').click();
  const link = await page.evaluate(() => navigator.clipboard.readText());
  expect(link).toContain('room=CKB-G-08');
  await page.goto(link);
  await expect(page.getByRole('dialog', { name: /Room detail/ })).toBeVisible();
  await expect(page.locator('#rds-room')).toHaveText('G-08');
  await expect(page.locator('#rds-building')).toContainText('CKB');
  await page.keyboard.press('Escape');
  await page.evaluate(() => setSavedOnly(true));
  await expect(page.locator('#rooms-container')).toContainText('G-08');
  expect(JSON.parse(await page.evaluate(() => localStorage.getItem('pinnedRooms')))).toEqual(['CKB|G-08']);
});
