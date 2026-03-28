// ── NJIT Building Coordinates (Newark NJ campus) ───────────────────────────
const BUILDING_COORDS = {
  'GITC': [40.74424, -74.17940],  // Guttenberg Information Technologies Center
  'FMH':  [40.74188, -74.17880],  // Faculty Memorial Hall
  'CKB':  [40.74196, -74.17741],  // Central King Building
  'KUPF': [40.74242, -74.17845],  // Kupfrian Hall
  'TIER': [40.74193, -74.17950],  // Tiernan Hall
  'CULM': [40.74294, -74.17729],  // Cullimore Hall
  'ME':   [40.74402, -74.17870],  // Mechanical & Industrial Engineering Center
  'FENS': [40.74250, -74.17709],  // Fenster Hall
  'ECEC': [40.74140, -74.17874],  // Electrical & Computer Engineering Building
  'CAMP': [40.74163, -74.17779],  // Campbell Hall
  'WEST': [40.74120, -74.17734],  // Weston Hall
  'WEC':  [40.74229, -74.18041],  // Wellness & Events Center
  'COLT': [40.74146, -74.17788],  // Colton Hall
  'DHRH': [40.74135, -74.18018],  // Dorman Honors Residence Hall
  'HUD':  [40.74170, -74.17690],  // Hudson building (approximate)
  'MALL': [40.74012, -74.17845],  // Student Mall
  'CTR':  [40.74307, -74.17835],  // Campus Center
  'CAB':  [40.74379, -74.17802],  // Central Avenue Building / Van Houten Library
};

// ── State ──────────────────────────────────────────────────────────────────
const state = {
  view: 'dashboard',
  building: '',
  timeAt: '',      // custom time for filter (HH:MM string, empty = now)
  timeFor: 0,      // minimum free duration in minutes (0 = any)
  dayAt: '',       // day override ('Monday'…'Sunday', empty = today)
  freeAllDay: false, // show only rooms free for rest of day
  soonThresholdMins: 30,  // configurable "busy soon" threshold in minutes
  map: null,       // full-screen map view instance
  dashMap: null,   // dashboard embedded map instance
  markers: {},
  dashMarkers: {},
  buildingsData: [],
  allRoomsData: [], // unfiltered rooms cache for Find Me a Room
  allRoomsCache: [],   // full roster including occupied rooms
  mapFloor: 1,
  floorRoomsData: [],
};

// ── URL state sync ─────────────────────────────────────────────────────────
function syncURL() {
  const params = new URLSearchParams();
  if (state.view && state.view !== 'dashboard') params.set('view', state.view);
  if (state.building) params.set('building', state.building);
  if (state.timeAt)   params.set('at', state.timeAt);
  if (state.timeFor)  params.set('for', String(state.timeFor));
  if (state.dayAt)    params.set('day', state.dayAt);
  if (state.freeAllDay) params.set('freeAllDay', '1');
  if (state.soonThresholdMins !== 30) params.set('soon', String(state.soonThresholdMins));
  const newURL = params.toString() ? '?' + params.toString() : window.location.pathname;
  window.history.replaceState(null, '', newURL);
}

function restoreStateFromURL() {
  const params = new URLSearchParams(window.location.search);

  const view     = params.get('view');
  const building = params.get('building');
  const at       = params.get('at');
  const forMins  = params.get('for');
  const day      = params.get('day');
  const fad      = params.get('freeAllDay');

  if (building) state.building = building;
  if (at)       state.timeAt   = at;
  if (forMins)  state.timeFor  = parseInt(forMins) || 0;
  if (day)    { state.dayAt = day; const sel = $('day-filter'); if (sel) sel.value = day; }
  if (fad)    { state.freeAllDay = true; _updateFreeAllDayBtn(true); }

  const soon = params.get('soon');
  if (soon) {
    state.soonThresholdMins = parseInt(soon) || 30;
    const sel = $('soon-threshold-select');
    if (sel) sel.value = String(state.soonThresholdMins);
  }

  // Restore time filter inputs so UI reflects the state
  if (at && $('time-filter-at'))        $('time-filter-at').value  = at;
  if (forMins && $('time-filter-for'))  $('time-filter-for').value = forMins;
  if ((at || forMins || day) && $('time-filter-indicator')) {
    $('time-filter-indicator').classList.remove('hidden');
  }

  // Switch to the saved view (must happen after DOM is ready)
  if (view && ['dashboard','rooms','map','settings'].includes(view)) {
    switchView(view);
  }
}

function copyShareLink() {
  const url = window.location.href;
  navigator.clipboard.writeText(url).then(() => {
    const label = $('copy-link-label');
    if (label) {
      label.textContent = 'Copied!';
      setTimeout(() => { label.textContent = 'Share'; }, 2000);
    }
  }).catch(() => {
    // Fallback: select and prompt manual copy
    prompt('Copy this link:', url);
  });
}

// ── Helpers ────────────────────────────────────────────────────────────────
function $(id) { return document.getElementById(id); }
function setText(id, val) { const e = $(id); if (e) e.textContent = val; }

function formatTime(minutes) {
  if (minutes === null || minutes === undefined) return 'FREE ALL DAY';
  if (minutes < 60) return `~${minutes}M`;
  const h = Math.floor(minutes / 60), m = minutes % 60;
  return m > 0 ? `${h}H ${m}M` : `${h}H`;
}

function occColor(pct) {
  if (pct >= 80) return '#ff7166';
  if (pct >= 50) return '#f59e0b';
  return '#3fff8b';
}

// ── Clock ──────────────────────────────────────────────────────────────────
function updateClock() {
  const t = new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' });
  setText('hdr-clock', t);
}
updateClock();
setInterval(updateClock, 1000);

// ── View switching ─────────────────────────────────────────────────────────
function switchView(view) {
  state.view = view;
  ['dashboard', 'rooms', 'map', 'settings'].forEach(v => {
    const el = $('view-' + v);
    if (el) el.classList.toggle('hidden', v !== view);

    // Desktop sidebar nav
    const nav = $('nav-' + v);
    if (nav) {
      if (v === view) {
        nav.classList.add('active-nav');
        nav.classList.remove('text-on-surface-variant/60');
      } else {
        nav.classList.remove('active-nav');
        nav.classList.add('text-on-surface-variant/60');
      }
    }

    // Mobile bottom nav
    const mob = $('mob-nav-' + v);
    if (mob) {
      const color = v === view ? '#3fff8b' : '#adaaaa';
      mob.querySelectorAll('span').forEach(s => s.style.color = color);
    }
  });
  if (view === 'map')       initMap();
  if (view === 'dashboard') initDashMap();
  if (view === 'settings')  fetchScheduleInfo();
  syncURL();
}

// ── Fetch data ─────────────────────────────────────────────────────────────
async function fetchBuildings() {
  try {
    const params = [];
    if (state.timeAt)  params.push(`at=${encodeURIComponent(state.timeAt)}`);
    if (state.timeFor) params.push(`for=${state.timeFor}`);
    if (state.dayAt)   params.push(`day=${encodeURIComponent(state.dayAt)}`);
    const url = '/api/buildings' + (params.length ? '?' + params.join('&') : '');
    const r = await fetch(url);
    if (!r.ok) throw new Error(r.status);
    const data = await r.json();
    state.buildingsData = data;
    updateStats(data);
    renderHealthBars(data);
    renderBuildingChips(data);
    renderDashBuildingFilter(data);
    if (state.map)     updateBuildingMarkers(state.map,     state.markers,     data);
    if (state.dashMap) updateBuildingMarkers(state.dashMap, state.dashMarkers, data);
    // Show no-classes banner if all buildings have 0 occupied rooms and no day override
    const totalOccupied = data.reduce((s, b) => s + b.occupied_rooms, 0);
    const isWeekendOrHoliday = !state.dayAt && totalOccupied === 0 && data.length > 0;
    if (isWeekendOrHoliday) {
      const dayName = new Date().toLocaleDateString('en-US', { weekday: 'long' });
      ['no-classes-banner-day', 'dash-no-classes-banner-day'].forEach(id => {
        const el = $(id); if (el) el.textContent = dayName;
      });
    }
    ['no-classes-banner', 'dash-no-classes-banner'].forEach(id => {
      const el = $(id);
      if (el) el.classList.toggle('hidden', !isWeekendOrHoliday);
    });
  } catch(e) { console.error('Buildings error:', e); }
}

async function fetchAllRoomsCache() {
  if (state.allRoomsCache.length) return; // already loaded
  try {
    const r = await fetch('/api/rooms/all');
    if (!r.ok) throw new Error(r.status);
    state.allRoomsCache = await r.json();
  } catch(e) { console.error('allRoomsCache error:', e); }
}

async function fetchRooms() {
  const params = [];
  if (state.building) params.push(`building=${encodeURIComponent(state.building)}`);
  if (state.timeAt)   params.push(`at=${encodeURIComponent(state.timeAt)}`);
  if (state.timeFor)  params.push(`for=${state.timeFor}`);
  if (state.dayAt)    params.push(`day=${encodeURIComponent(state.dayAt)}`);
  const url = '/api/rooms' + (params.length ? '?' + params.join('&') : '');
  renderRoomsGridSkeleton();
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(r.status);
    let data = await r.json();
    // Cache unfiltered rooms for Find Me a Room
    if (!state.building && !state.timeAt && !state.timeFor && !state.dayAt) state.allRoomsData = data;
    // Free all day filter
    if (state.freeAllDay) data = data.filter(r => r.minutes_until_next === null);
    renderLiveFeed(data);
    renderDashRooms(data);
    renderRoomsTable(data);
    renderRoomsGrid(data);
    renderBestRooms(data);
    renderSidebarTopRooms(data);
    const t = new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
    setText('sidebar-status', `${data.length} rooms free · ${t}`);
    setText('footer-sync', t);
  } catch(e) { console.error('Rooms error:', e); }
}

// ── Stats ──────────────────────────────────────────────────────────────────
function updateStats(buildings) {
  const totalRooms = buildings.reduce((s, b) => s + b.total_rooms, 0);
  const totalEmpty = buildings.reduce((s, b) => s + b.empty_rooms, 0);
  const totalOccupied = totalRooms - totalEmpty;
  const isNoClasses = !state.dayAt && totalOccupied === 0 && buildings.length > 0;
  const occ = isNoClasses ? '—' : (totalRooms > 0 ? Math.round(totalOccupied / totalRooms * 100) + '%' : '0%');
  setText('stat-total', totalRooms);
  setText('stat-empty', isNoClasses ? 'All' : totalEmpty);
  setText('stat-occ', occ);
  setText('stat-bldg', buildings.length);
  setText('hdr-empty', isNoClasses ? 'All' : totalEmpty);
  setText('hdr-occ', occ);
  const dayFull = state.dayAt || new Date().toLocaleDateString('en-US', { weekday: 'long' });
  setText('hdr-day', dayFull);
  setText('health-sections', (totalRooms * 3).toLocaleString());
  setText('health-bldg', buildings.length);
  setText('health-occ', occ + '%');
  const bar = $('health-bar');
  if (bar) bar.style.width = occ + '%';
  setText('health-bar-label', `Schedule coverage ${occ}%`);
}


// ── Time filter ────────────────────────────────────────────────────────────
function applyTimeFilter() {
  state.timeAt  = $('time-filter-at')?.value  || '';
  state.timeFor = parseInt($('time-filter-for')?.value || '0');
  state.dayAt   = $('day-filter')?.value || '';
  const sel = $('soon-threshold-select');
  if (sel) state.soonThresholdMins = parseInt(sel.value) || 30;
  const ind = $('time-filter-indicator');
  if (ind) ind.classList.toggle('hidden', !state.timeAt && !state.timeFor && !state.dayAt);
  refresh();
  syncURL();
}

function resetTimeFilter() {
  state.timeAt  = '';
  state.timeFor = 0;
  state.dayAt   = '';
  if ($('time-filter-at'))  $('time-filter-at').value  = '';
  if ($('time-filter-for')) $('time-filter-for').value = '0';
  if ($('day-filter'))      $('day-filter').value      = '';
  const ind = $('time-filter-indicator');
  if (ind) ind.classList.add('hidden');
  refresh();
  syncURL();
}

function roomType(room) {
  return String(room).toUpperCase().endsWith('L') ? 'LAB' : null;
}

function toggleFilterMore() {
  const sec = $('filter-secondary');
  const btn = $('filter-more-btn');
  if (!sec) return;
  const open = sec.style.display !== 'none';
  sec.style.display = open ? 'none' : 'flex';
  if (btn) btn.style.color = open ? '' : '#3fff8b';
}

function applyThreshold() {
  const sel = $('soon-threshold-select');
  if (sel) state.soonThresholdMins = parseInt(sel.value) || 30;
  // Re-render with existing data (no new fetch needed — threshold is display-only)
  if (state.allRoomsData.length)    renderLiveFeed(state.allRoomsData);
  if (state.buildingsData.length)   renderHealthBars(state.buildingsData);
  // Re-fetch rooms so renderRoomsGrid and renderDashRooms get fresh calls
  fetchRooms();
  syncURL();
}

// ── Global search ──────────────────────────────────────────────────────────
function globalSearch(query) {
  const q = query.trim().toLowerCase();
  if (!q) {
    // Clear search: restore normal rooms view
    state.building = '';
    fetchRooms();
    return;
  }

  // Switch to rooms view so results are visible
  switchView('rooms');

  const source = state.allRoomsCache.length ? state.allRoomsCache : state.allRoomsData;
  const matches = source.filter(room => {
    const full = `${room.building} ${room.room}`.toLowerCase();
    const roomOnly = room.room.toLowerCase();
    return full.includes(q) || roomOnly.includes(q);
  });

  // Only show empty rooms in search results (consistent with rooms view)
  const emptyMatches = matches.filter(r => r.empty !== false);

  setText('grid-count', `${emptyMatches.length} rooms match "${query}"`);
  renderRoomsGrid(emptyMatches);

  // Close mobile overlay if open
  const overlay = $('mobile-search-overlay');
  if (overlay && !overlay.classList.contains('hidden') && !q) {
    overlay.classList.add('hidden');
  }
}

function toggleMobileSearch() {
  const overlay = $('mobile-search-overlay');
  if (!overlay) return;
  const isHidden = overlay.classList.contains('hidden');
  overlay.classList.toggle('hidden', !isHidden);
  if (isHidden) {
    const inp = $('mobile-search-input');
    if (inp) { inp.value = ''; inp.focus(); }
  }
}

// ── Health bars ────────────────────────────────────────────────────────────
function _sortedBestRooms(rooms, limit) {
  return [...rooms].sort((a, b) => {
    if (a.minutes_until_next === null && b.minutes_until_next === null) return 0;
    if (a.minutes_until_next === null) return -1;
    if (b.minutes_until_next === null) return 1;
    return b.minutes_until_next - a.minutes_until_next;
  }).slice(0, limit);
}

function renderBestRooms(rooms) {
  const container = $('dash-best-rooms');
  if (!container) return;
  container.innerHTML = '';
  const best = _sortedBestRooms(rooms, 6);
  if (!best.length) {
    container.innerHTML = `<div style="text-align:center;padding:32px;color:#484847;font-family:'Space Grotesk',sans-serif;font-size:11px;text-transform:uppercase;letter-spacing:0.1em">No rooms available</div>`;
    return;
  }
  best.forEach(room => {
    const isSoon = room.minutes_until_next !== null && room.minutes_until_next <= state.soonThresholdMins;
    const color = isSoon ? '#f59e0b' : '#3fff8b';
    const barPct = room.minutes_until_next === null ? 100 : Math.min(100, room.minutes_until_next / 180 * 100);
    const row = document.createElement('div');
    row.style.cssText = `padding:10px 12px;background:rgba(255,255,255,0.02);border:1px solid rgba(255,255,255,0.04);border-radius:2px;cursor:pointer;transition:all 0.15s`;
    row.addEventListener('click', () => openRoomDetail(room.building, room.room));
    row.addEventListener('mouseover', () => { row.style.background = 'rgba(63,255,139,0.05)'; row.style.borderColor = 'rgba(63,255,139,0.15)'; });
    row.addEventListener('mouseout',  () => { row.style.background = 'rgba(255,255,255,0.02)'; row.style.borderColor = 'rgba(255,255,255,0.04)'; });
    row.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
        <div>
          <span style="font-family:'Space Grotesk',sans-serif;font-size:9px;color:#767575;text-transform:uppercase;letter-spacing:0.1em">${room.building}</span>
          <span style="font-family:'Space Grotesk',sans-serif;font-size:16px;font-weight:800;color:#fff;margin-left:8px">${room.room}</span>
        </div>
        <span style="font-family:'Space Grotesk',sans-serif;font-size:12px;font-weight:700;color:${color}">${formatTime(room.minutes_until_next)}</span>
      </div>
      <div style="height:2px;background:rgba(255,255,255,0.06);border-radius:2px;overflow:hidden">
        <div style="height:100%;width:${barPct}%;background:${color};opacity:0.5;transition:width 0.5s ease"></div>
      </div>`;
    container.appendChild(row);
  });
}

function renderSidebarTopRooms(rooms) {
  const container = $('sidebar-top-rooms');
  if (!container) return;
  container.innerHTML = '';
  const best = _sortedBestRooms(rooms, 5);
  if (!best.length) {
    const el = document.createElement('div');
    el.style.cssText = `padding:8px;font-family:'Space Grotesk',sans-serif;font-size:9px;color:#484847;text-transform:uppercase;letter-spacing:0.1em`;
    el.textContent = 'None available';
    container.appendChild(el);
    return;
  }
  best.forEach(room => {
    const isSoon = room.minutes_until_next !== null && room.minutes_until_next <= state.soonThresholdMins;
    const color = isSoon ? '#f59e0b' : '#3fff8b';
    const btn = document.createElement('button');
    btn.style.cssText = `width:100%;display:flex;align-items:center;justify-content:space-between;padding:6px 8px;border-radius:2px;transition:background 0.15s;cursor:pointer;border:none;background:transparent;text-align:left`;
    btn.addEventListener('click', () => openRoomDetail(room.building, room.room));
    btn.addEventListener('mouseover', () => { btn.style.background = 'rgba(255,255,255,0.05)'; });
    btn.addEventListener('mouseout',  () => { btn.style.background = 'transparent'; });
    btn.innerHTML = `
      <div>
        <span style="font-family:'Space Grotesk',sans-serif;font-size:8px;color:#767575;text-transform:uppercase;letter-spacing:0.1em">${room.building}</span>
        <span style="font-family:'Space Grotesk',sans-serif;font-size:13px;font-weight:700;color:#fff;margin-left:6px">${room.room}</span>
      </div>
      <span style="font-family:'Space Grotesk',sans-serif;font-size:9px;font-weight:700;color:${color};white-space:nowrap">${formatTime(room.minutes_until_next)}</span>`;
    container.appendChild(btn);
  });
}

function renderHealthBars(buildings) {
  const container = $('building-bars');
  if (!container) return;
  container.textContent = '';
  const maxTotal = Math.max(...buildings.map(b => b.total_rooms), 1);
  buildings.slice(0, 14).forEach(b => {
    const bar = document.createElement('div');
    const h = Math.max(8, Math.round((b.total_rooms / maxTotal) * 80));
    const color = occColor(b.occupancy_pct);
    bar.style.cssText = `flex:1;background:${color}33;height:${h}px;min-height:8px;border-radius:2px;transition:all 0.3s;cursor:pointer`;
    bar.title = `${b.building}: ${b.occupancy_pct}% occupied`;
    bar.addEventListener('mouseover', () => { bar.style.background = color + '88'; });
    bar.addEventListener('mouseout',  () => { bar.style.background = color + '33'; });
    container.appendChild(bar);
  });
}

// ── Live feed (dashboard) ──────────────────────────────────────────────────
function renderLiveFeed(rooms) {
  const container = $('live-feed');
  if (!container) return;
  container.textContent = '';
  const t = new Date().toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
  rooms.slice(0, 10).forEach(room => {
    const isSoon = room.minutes_until_next !== null && room.minutes_until_next <= state.soonThresholdMins;
    const color = isSoon ? '#f59e0b' : '#3fff8b';
    const label = isSoon ? 'Closing soon' : 'Available';
    const item = document.createElement('div');
    item.className = 'relative pl-6 border-l';
    item.style.borderColor = color + '33';
    item.innerHTML = `
      <div class="absolute -left-1 top-0 w-2 h-2 rounded-full" style="background:${color};box-shadow:0 0 5px ${color}"></div>
      <div style="font-family:'Space Grotesk',sans-serif;font-size:10px;color:${color};margin-bottom:3px;letter-spacing:0.1em">${t} // ${label}</div>
      <p style="font-family:'Space Grotesk',sans-serif;font-size:12px;font-weight:700;color:#fff;margin-bottom:2px">${room.building}-${room.room}</p>
      <p style="font-family:'Space Grotesk',sans-serif;font-size:10px;color:#adaaaa;line-height:1.4">${room.minutes_until_next === null ? 'Free for the rest of the day.' : `Next class in ${room.minutes_until_next} minutes.`}</p>`;
    container.appendChild(item);
  });
  if (!rooms.length) {
    container.innerHTML = `<p style="font-family:'Space Grotesk',sans-serif;font-size:10px;color:#767575;text-align:center;padding:40px 0;text-transform:uppercase;letter-spacing:0.1em">No rooms available</p>`;
  }
}

// ── Dashboard mini room grid ───────────────────────────────────────────────
function renderDashRooms(rooms) {
  const container = $('dash-rooms');
  if (!container) return;
  container.textContent = '';
  rooms.slice(0, 12).forEach(room => {
    const isSoon = room.minutes_until_next !== null && room.minutes_until_next <= state.soonThresholdMins;
    const color = isSoon ? '#f59e0b' : '#3fff8b';
    const cell = document.createElement('div');
    cell.style.cssText = `background:${color}10;border:1px solid ${color}30;padding:8px;border-radius:2px;cursor:pointer;transition:background 0.15s`;
    cell.title = `${room.building}-${room.room} · tap for schedule`;
    cell.onclick = () => openRoomDetail(room.building, room.room);
    cell.onmouseover = () => { cell.style.background = `${color}20`; };
    cell.onmouseout  = () => { cell.style.background = `${color}10`; };
    const _dcBldg = document.createElement('div');
    _dcBldg.style.cssText = "font-family:'Space Grotesk',sans-serif;font-size:9px;font-weight:600;color:#767575;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:2px";
    _dcBldg.textContent = room.building;
    const _dcRoom = document.createElement('div');
    _dcRoom.style.cssText = `font-family:'Space Grotesk',sans-serif;font-size:16px;font-weight:800;color:#fff`;
    _dcRoom.textContent = room.room;
    const _dcStatus = document.createElement('div');
    _dcStatus.style.cssText = 'display:flex;align-items:center;gap:4px;margin-top:4px';
    const _dcDot = document.createElement('span');
    _dcDot.style.cssText = `width:5px;height:5px;border-radius:50%;background:${color};display:inline-block;flex-shrink:0`;
    const _dcLabel = document.createElement('span');
    _dcLabel.style.cssText = `font-family:'Space Grotesk',sans-serif;font-size:9px;font-weight:700;color:${color};text-transform:uppercase;letter-spacing:0.08em`;
    _dcLabel.textContent = isSoon ? 'Closing soon' : 'Open';
    _dcStatus.appendChild(_dcDot);
    _dcStatus.appendChild(_dcLabel);
    cell.appendChild(_dcBldg);
    cell.appendChild(_dcRoom);
    cell.appendChild(_dcStatus);
    container.appendChild(cell);
  });
}

// ── Rooms table (dashboard) ────────────────────────────────────────────────
function renderRoomsTable(rooms) {
  const tbody = $('rooms-table-body');
  if (!tbody) return;
  setText('table-count', rooms.length);
  tbody.textContent = '';
  rooms.slice(0, 15).forEach(room => {
    const isSoon = room.minutes_until_next !== null && room.minutes_until_next <= state.soonThresholdMins;
    const color = isSoon ? '#f59e0b' : '#3fff8b';
    const tr = document.createElement('tr');
    tr.className = 'hover:bg-primary/5 transition-colors';
    tr.innerHTML = `
      <td class="px-3 sm:px-6 py-3"><span style="font-family:'Space Grotesk',sans-serif;font-size:11px;font-weight:700;color:#fff;letter-spacing:0.1em">${room.building}</span></td>
      <td class="px-3 sm:px-6 py-3"><span style="font-family:'Space Grotesk',sans-serif;font-size:14px;font-weight:700;color:#fff">${room.room}</span></td>
      <td class="px-3 sm:px-6 py-3 hidden sm:table-cell"><div style="display:flex;align-items:center;gap:6px"><span style="width:6px;height:6px;border-radius:50%;background:${color};box-shadow:0 0 5px ${color};display:inline-block"></span><span style="font-family:'Space Grotesk',sans-serif;font-size:10px;font-weight:700;color:${color};text-transform:uppercase;letter-spacing:0.1em">${isSoon?'CLOSING':'OPEN'}</span></div></td>
      <td class="px-3 sm:px-6 py-3 hidden sm:table-cell"><span style="font-family:'Space Grotesk',sans-serif;font-size:10px;color:#adaaaa">${room.minutes_until_next===null?'End of day':'~'+room.minutes_until_next+'m'}</span></td>
      <td class="px-3 sm:px-6 py-3"><span style="font-family:'Space Grotesk',sans-serif;font-size:10px;font-weight:700;color:${color}">${formatTime(room.minutes_until_next)}</span></td>`;
    tbody.appendChild(tr);
  });
}

// ── Dashboard building filter chips ───────────────────────────────────────
function renderDashBuildingFilter(buildings) {
  const container = $('dash-building-filter');
  if (!container) return;
  container.textContent = '';
  buildings.slice(0, 8).forEach(b => {
    const btn = document.createElement('button');
    btn.style.cssText = `padding:3px 8px;font-family:'Space Grotesk',sans-serif;font-size:9px;font-weight:700;border:1px solid rgba(63,255,139,0.2);color:#adaaaa;border-radius:2px;cursor:pointer;text-transform:uppercase;letter-spacing:0.1em;background:transparent;transition:all 0.15s`;
    btn.textContent = `${b.building}(${b.empty_rooms})`;
    btn.addEventListener('mouseover', () => { btn.style.color='#3fff8b'; btn.style.borderColor='rgba(63,255,139,0.5)'; });
    btn.addEventListener('mouseout',  () => { btn.style.color='#adaaaa'; btn.style.borderColor='rgba(63,255,139,0.2)'; });
    btn.addEventListener('click', () => { state.building = b.building; fetchRooms(); switchView('rooms'); });
    container.appendChild(btn);
  });
}

// ── Room grid skeleton loader ──────────────────────────────────────────────
function renderRoomsGridSkeleton() {
  const container = $('rooms-container');
  if (!container) return;
  container.textContent = '';
  const frag = document.createDocumentFragment();
  for (let i = 0; i < 12; i++) {
    const card = document.createElement('div');
    card.style.cssText = `background:linear-gradient(135deg,rgba(26,25,25,0.8),rgba(14,14,14,0.95));border:1px solid rgba(63,255,139,0.05);padding:14px;border-radius:2px;animation:pulse 1.5s ease-in-out infinite;animation-delay:${i*80}ms`;
    const line1 = document.createElement('div');
    line1.style.cssText = 'height:8px;width:40%;background:rgba(255,255,255,0.05);border-radius:2px;margin-bottom:8px';
    const line2 = document.createElement('div');
    line2.style.cssText = 'height:28px;width:60%;background:rgba(255,255,255,0.07);border-radius:2px;margin-bottom:16px';
    const line3 = document.createElement('div');
    line3.style.cssText = 'height:8px;width:80%;background:rgba(255,255,255,0.04);border-radius:2px';
    card.appendChild(line1);
    card.appendChild(line2);
    card.appendChild(line3);
    frag.appendChild(card);
  }
  container.appendChild(frag);
}

// ── Room grid (rooms view) ─────────────────────────────────────────────────
function renderRoomsGrid(rooms) {
  const container = $('rooms-container');
  if (!container) return;
  setText('grid-count', `${rooms.length} rooms available`);
  const _ts = $('grid-timestamp');
  if (_ts) {
    const _now = new Date();
    _ts.textContent = `Updated ${_now.getHours()}:${String(_now.getMinutes()).padStart(2,'0')}`;
  }
  container.textContent = '';

  if (!rooms.length) {
    const _emptyDiv = document.createElement('div');
    _emptyDiv.className = 'col-span-full flex flex-col items-center justify-center py-24 gap-4';
    const _emptyIcon = document.createElement('span');
    _emptyIcon.className = 'material-symbols-outlined';
    _emptyIcon.style.cssText = 'font-size:48px;color:#3fff8b;opacity:0.2';
    _emptyIcon.textContent = 'meeting_room';
    const _emptyText = document.createElement('div');
    _emptyText.style.textAlign = 'center';
    const _emptyTitle = document.createElement('div');
    _emptyTitle.style.cssText = "font-family:'Space Grotesk',sans-serif;font-size:11px;font-weight:700;color:#adaaaa;text-transform:uppercase;letter-spacing:0.15em";
    _emptyTitle.textContent = 'No empty rooms right now';
    const _emptySub = document.createElement('div');
    _emptySub.style.cssText = "font-family:'Space Grotesk',sans-serif;font-size:10px;color:#555;margin-top:6px";
    _emptySub.textContent = 'Try adjusting filters or checking a different time';
    _emptyText.appendChild(_emptyTitle);
    _emptyText.appendChild(_emptySub);
    _emptyDiv.appendChild(_emptyIcon);
    _emptyDiv.appendChild(_emptyText);
    container.appendChild(_emptyDiv);
    return;
  }

  const frag = document.createDocumentFragment();
  rooms.forEach((room, i) => {
    const isSoon = room.minutes_until_next !== null && room.minutes_until_next <= state.soonThresholdMins;
    const color = isSoon ? '#f59e0b' : '#3fff8b';
    const border = isSoon ? 'rgba(245,158,11,0.2)' : 'rgba(63,255,139,0.1)';
    const card = document.createElement('div');
    card.className = 'room-card-in';
    card.style.cssText = `background:linear-gradient(135deg,rgba(26,25,25,0.8),rgba(14,14,14,0.95));border:1px solid ${border};padding:14px;border-radius:2px;position:relative;overflow:hidden;transition:border-color 0.2s,background 0.2s;cursor:pointer;animation-delay:${Math.min(i,30)*22}ms`;
    card.title = `${room.building}-${room.room} · tap for schedule`;
    card.addEventListener('click',     () => openRoomDetail(room.building, room.room));
    card.addEventListener('mouseover', () => { card.style.borderColor = color + '50'; card.style.background = `linear-gradient(135deg,rgba(26,25,25,0.95),rgba(${color==='#3fff8b'?'14,40,24':'40,20,14'},0.95))`; });
    card.addEventListener('mouseout',  () => { card.style.borderColor = border; card.style.background = 'linear-gradient(135deg,rgba(26,25,25,0.8),rgba(14,14,14,0.95))'; });
    const capLabel = room.capacity ? `<span style="font-family:'Space Grotesk',sans-serif;font-size:8px;color:#484847;letter-spacing:0.1em">cap ${room.capacity}</span>` : '';
    const type = roomType(room.room);
    const typeLabel = type ? `<span style="font-family:'Space Grotesk',sans-serif;font-size:8px;font-weight:700;padding:1px 5px;background:rgba(110,155,255,0.12);border:1px solid rgba(110,155,255,0.25);color:#6e9bff;border-radius:2px;letter-spacing:0.08em">${type}</span>` : '';
    card.innerHTML = `
      <div style="position:absolute;top:0;left:0;right:0;height:2px;background:${color};opacity:0.6"></div>
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px">
        <span style="font-family:'Space Grotesk',sans-serif;font-size:9px;font-weight:600;color:#767575;letter-spacing:0.15em;text-transform:uppercase">${room.building}</span>
        ${typeLabel}
      </div>
      <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:12px">
        <span style="font-family:'Space Grotesk',sans-serif;font-size:26px;font-weight:800;color:#fff;letter-spacing:0.05em">${room.room}</span>
        ${capLabel}
      </div>
      <div style="display:flex;align-items:center;justify-content:space-between">
        <div style="display:flex;align-items:center;gap:5px">
          <span style="width:6px;height:6px;border-radius:50%;background:${color};display:inline-block;animation:pulse 2s infinite"></span>
          <span style="font-family:'Space Grotesk',sans-serif;font-size:9px;font-weight:700;color:${color};text-transform:uppercase;letter-spacing:0.1em">${isSoon?'CLOSING':'OPEN'}</span>
        </div>
        <span style="font-family:'Space Grotesk',sans-serif;font-size:14px;font-weight:800;color:${color};letter-spacing:0.02em">${formatTime(room.minutes_until_next)}</span>
      </div>`;
    frag.appendChild(card);
  });
  container.appendChild(frag);
}

// ── Building filter chips (rooms view) ────────────────────────────────────
function renderBuildingChips(buildings) {
  const container = $('building-filter');
  if (!container) return;
  container.textContent = '';
  const makeChip = (label, value) => {
    const btn = document.createElement('button');
    const active = state.building === value;
    btn.style.cssText = `flex-shrink:0;padding:6px 14px;font-family:'Space Grotesk',sans-serif;font-size:10px;font-weight:700;border-radius:2px;text-transform:uppercase;letter-spacing:0.1em;transition:all 0.15s;cursor:pointer;border:1px solid ${active?'#3fff8b':'rgba(255,255,255,0.08)'};background:${active?'#3fff8b':'transparent'};color:${active?'#005d2c':'#adaaaa'}`;
    btn.textContent = label;
    btn.addEventListener('click', () => {
      state.building = value;
      const gs = $('global-search');
      if (gs) gs.value = '';
      renderBuildingChips(buildings);
      fetchRooms();
      syncURL();
    });
    return btn;
  };
  container.appendChild(makeChip('ALL', ''));
  buildings.forEach(b => container.appendChild(makeChip(`${b.building} (${b.empty_rooms})`, b.building)));
}

// ── Map helpers ────────────────────────────────────────────────────────────
function makeTileLayers(map) {
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    attribution:'Tiles &copy; Esri', maxZoom:19
  }).addTo(map);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png', {
    attribution:'', subdomains:'abcd', maxZoom:19, opacity:0.85
  }).addTo(map);
}

function updateBuildingMarkers(map, markersObj, buildings) {
  Object.values(markersObj).forEach(({circle, label}) => {
    if (circle) map.removeLayer(circle);
    if (label)  map.removeLayer(label);
  });
  // clear in-place
  Object.keys(markersObj).forEach(k => delete markersObj[k]);

  buildings.forEach(b => {
    const coords = BUILDING_COORDS[b.building];
    if (!coords) return;
    const color = occColor(b.occupancy_pct);
    const circle = L.circleMarker(coords, {
      radius:18, fillColor:color, color:'#fff', weight:2, fillOpacity:0.65
    }).addTo(map);
    const label = L.marker(coords, {
      icon: L.divIcon({
        html:`<div style="text-align:center;pointer-events:none;transform:translateY(-50%)"><div style="font-family:'Space Grotesk',sans-serif;font-size:11px;font-weight:800;color:#fff;text-shadow:0 1px 4px rgba(0,0,0,0.9);letter-spacing:0.08em">${b.building}</div><div style="font-family:'Space Grotesk',sans-serif;font-size:9px;color:${color};text-shadow:0 1px 3px rgba(0,0,0,0.9)">${b.empty_rooms} free</div></div>`,
        className:'', iconSize:[70,32], iconAnchor:[35,16]
      }), interactive:false, zIndexOffset:1000
    }).addTo(map);
    circle.on('click', () => openBuildingPanel(b));
    circle.on('mouseover', function(){ this.setStyle({fillOpacity:0.85, radius:22}); });
    circle.on('mouseout',  function(){ this.setStyle({fillOpacity:0.65, radius:18}); });
    markersObj[b.building] = {circle, label};
  });
}

// ── Map ────────────────────────────────────────────────────────────────────
function initMap() {
  if (state.map) return;
  state.map = L.map('map-container', {
    center: [40.7424, -74.1779], zoom: 17,
    zoomControl: true,
    scrollWheelZoom: true,
  });
  makeTileLayers(state.map);
  if (state.buildingsData.length) updateBuildingMarkers(state.map, state.markers, state.buildingsData);
}

function initDashMap() {
  if (state.dashMap) return;
  const el = $('dash-map-container');
  if (!el) return;
  state.dashMap = L.map('dash-map-container', {
    center: [40.7424, -74.1779], zoom: 16,
    zoomControl: true,
    scrollWheelZoom: false,  // disabled so page can still scroll; activates on map click
  });
  // Enable scroll wheel zoom when user clicks/interacts with the map
  state.dashMap.on('click', () => state.dashMap.scrollWheelZoom.enable());
  makeTileLayers(state.dashMap);
  if (state.buildingsData.length) updateBuildingMarkers(state.dashMap, state.dashMarkers, state.buildingsData);
}

// ── Building panel ──────────────────────────────────────────────────────────
function openBuildingPanel(buildingData) {
  const panel = $('floor-panel');
  if (!panel) return;

  // Update header
  setText('panel-building', buildingData.building);
  setText('ps-free',  buildingData.empty_rooms);
  setText('ps-busy',  buildingData.total_rooms - buildingData.empty_rooms);
  setText('ps-total', buildingData.total_rooms);

  // Slide in
  panel.style.transform = 'translateX(0)';

  // CAB = library special case
  if (buildingData.building === 'CAB') {
    const ft = $('floor-tabs'); if (ft) ft.innerHTML = '';
    const fw = $('floor-tabs-wrap'); if (fw) fw.style.display = 'none';
    const sw = $('panel-search-wrap'); if (sw) sw.style.display = 'none';
    const fc = $('floor-rooms');
    if (fc) {
      fc.innerHTML = `<div style="padding:32px 16px;text-align:center;grid-column:1/-1">
        <span class="material-symbols-outlined" style="font-size:36px;color:#3fff8b;opacity:0.4;display:block;margin-bottom:10px">menu_book</span>
        <div style="font-family:'Space Grotesk',sans-serif;font-size:11px;color:#adaaaa;line-height:1.7;margin-bottom:14px">Study rooms must be reserved online via the NJIT Library.</div>
        <a href="https://researchguides.njit.edu/services/group-study-rooms" target="_blank" rel="noopener"
           style="display:inline-block;padding:8px 16px;background:#3fff8b22;border:1px solid #3fff8b55;color:#3fff8b;font-family:'Space Grotesk',sans-serif;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.15em;text-decoration:none;border-radius:2px">
          Reserve Study Rooms ↗
        </a></div>`;
    }
    return;
  }

  // Restore sections
  const fw = $('floor-tabs-wrap'); if (fw) fw.style.display = '';
  const sw = $('panel-search-wrap'); if (sw) sw.style.display = '';
  if ($('panel-search')) $('panel-search').value = '';

  // Loading state
  const fc = $('floor-rooms');
  if (fc) fc.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:48px 16px;color:#adaaaa;font-family:'Space Grotesk',sans-serif;font-size:11px;text-transform:uppercase;letter-spacing:0.1em">Loading…</div>`;
  const ft = $('floor-tabs'); if (ft) ft.innerHTML = '';

  fetch(`/api/rooms/all?building=${encodeURIComponent(buildingData.building)}`)
    .then(r => r.json())
    .then(rooms => {
      state.floorRoomsData = rooms;
      const floors = [...new Set(rooms.map(r => r.floor))].sort((a,b) => a - b);
      state.mapFloor = floors[0] ?? 1;
      buildFloorTabs(floors, rooms);
      renderRoomGrid(rooms, state.mapFloor);
    })
    .catch(() => {
      if (fc) fc.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:48px;color:#ff7166;font-size:11px">Error loading rooms.</div>`;
    });
}

function closeFloorPanel() {
  const panel = $('floor-panel');
  if (panel) panel.style.transform = 'translateX(100%)';
}

function buildFloorTabs(floors, rooms) {
  const container = $('floor-tabs');
  if (!container) return;
  container.innerHTML = '';
  floors.forEach(f => {
    const freeCount = rooms.filter(r => r.floor === f && r.empty).length;
    const isActive  = f === state.mapFloor;
    const label     = f === 0 ? 'GRD' : `FL ${f}`;
    const btn = document.createElement('button');
    btn.dataset.floor = f;
    btn.innerHTML = `<span style="display:block">${label}</span><span style="display:block;font-size:8px;opacity:0.65;margin-top:1px">${freeCount} free</span>`;
    btn.style.cssText = `padding:6px 11px;font-family:'Space Grotesk',sans-serif;font-size:10px;font-weight:700;border-radius:2px;text-transform:uppercase;letter-spacing:0.08em;cursor:pointer;transition:all 0.15s;text-align:center;line-height:1.2;border:1px solid ${isActive ? '#3fff8b' : 'rgba(72,72,71,0.4)'};background:${isActive ? 'rgba(63,255,139,0.12)' : 'transparent'};color:${isActive ? '#3fff8b' : '#adaaaa'}`;
    btn.addEventListener('click', () => {
      state.mapFloor = f;
      if ($('panel-search')) $('panel-search').value = '';
      document.querySelectorAll('#floor-tabs button').forEach(b => {
        b.style.border = '1px solid rgba(72,72,71,0.4)';
        b.style.background = 'transparent';
        b.style.color = '#adaaaa';
      });
      btn.style.border = '1px solid #3fff8b';
      btn.style.background = 'rgba(63,255,139,0.12)';
      btn.style.color = '#3fff8b';
      renderRoomGrid(state.floorRoomsData, f);
    });
    container.appendChild(btn);
  });
}

function filterFloorRooms(query) {
  renderRoomGrid(state.floorRoomsData, state.mapFloor, query);
}

function renderRoomGrid(rooms, floor, query = '') {
  let list = rooms
    .filter(r => r.floor === floor)
    .sort((a, b) => a.room.localeCompare(b.room, undefined, {numeric: true}));
  if (query) list = list.filter(r => r.room.toLowerCase().includes(query.toLowerCase()));

  const container = $('floor-rooms');
  if (!container) return;
  container.innerHTML = '';

  const freeCount = list.filter(r => r.empty).length;
  setText('floor-room-count', query ? `${list.length} match${list.length !== 1 ? 'es' : ''}` : `${freeCount} / ${list.length} free`);

  if (!list.length) {
    container.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:48px 16px;color:#adaaaa;font-family:'Space Grotesk',sans-serif;font-size:11px;text-transform:uppercase;letter-spacing:0.1em">${query ? 'No rooms match.' : 'No rooms on this floor.'}</div>`;
    return;
  }

  const frag = document.createDocumentFragment();
  list.forEach(room => {
    const isSoon = room.empty && room.minutes_until_next !== null && room.minutes_until_next <= state.soonThresholdMins;
    const color  = !room.empty ? '#ff7166' : isSoon ? '#f59e0b' : '#3fff8b';
    const status = !room.empty ? 'In Use'
                 : room.minutes_until_next === null ? 'Free all day'
                 : `${room.minutes_until_next}m free`;
    const cell = document.createElement('div');
    cell.style.cssText = `background:${color}0d;border:1px solid ${color}30;border-top:2px solid ${color};padding:10px 9px 9px;border-radius:2px;transition:all 0.15s;cursor:pointer`;
    cell.title = `${room.room} · tap for schedule`;
    cell.onclick = () => openRoomDetail(room.building, room.room);
    cell.onmouseover = () => { cell.style.background = `${color}1a`; cell.style.transform = 'translateY(-1px)'; };
    cell.onmouseout  = () => { cell.style.background = `${color}0d`; cell.style.transform = ''; };
    cell.innerHTML = `
      <div style="font-family:'Space Grotesk',sans-serif;font-size:16px;font-weight:800;color:#fff;letter-spacing:0.03em;line-height:1;margin-bottom:5px">${room.room}</div>
      <div style="font-family:'Space Grotesk',sans-serif;font-size:9px;font-weight:600;color:${color};text-transform:uppercase;letter-spacing:0.08em">${status}</div>`;
    frag.appendChild(cell);
  });
  container.appendChild(frag);
}

// ── Settings ───────────────────────────────────────────────────────────────
let selectedFile = null;

async function fetchScheduleInfo() {
  try {
    const r = await fetch('/api/schedule-info');
    const d = await r.json();
    setText('si-entries',   d.entries?.toLocaleString() ?? '--');
    setText('si-buildings', d.buildings ?? '--');
    setText('si-rooms',     d.rooms ?? '--');
    setText('si-filename',  d.filename || 'Unknown');
    const loaded = $('si-loaded');
    if (loaded) {
      loaded.textContent = d.loaded_at
        ? new Date(d.loaded_at).toLocaleString([], {dateStyle:'medium', timeStyle:'short'})
        : '--';
    }
  } catch(e) { console.error('schedule-info error:', e); }
}

function handleDrop(e) {
  e.preventDefault();
  const dz = $('drop-zone');
  if (dz) dz.classList.remove('border-primary', 'bg-primary/10');
  const file = e.dataTransfer.files[0];
  if (file) handleFileSelect(file);
}

function handleFileSelect(file) {
  if (!file) return;
  if (!file.name.toLowerCase().endsWith('.csv') && !file.name.toLowerCase().endsWith('.xlsx')) {
    showUploadStatus('error', 'Only CSV or Excel (.xlsx) files are accepted.');
    return;
  }
  selectedFile = file;
  const preview = $('file-preview');
  if (preview) preview.classList.remove('hidden');
  setText('file-preview-name', file.name);
  setText('file-preview-size', `${(file.size / 1024).toFixed(1)} KB`);
  const btn = $('upload-btn');
  if (btn) {
    btn.disabled = false;
    btn.className = btn.className
      .replace('bg-primary/10', 'bg-primary')
      .replace('border-primary/20', 'border-primary')
      .replace('text-primary/40', 'text-on-primary')
      .replace('cursor-not-allowed', 'cursor-pointer hover:brightness-110');
  }
  hideUploadStatus();
}

function clearFileSelection() {
  selectedFile = null;
  const preview = $('file-preview');
  if (preview) preview.classList.add('hidden');
  const input = $('csv-file-input');
  if (input) input.value = '';
  const btn = $('upload-btn');
  if (btn) {
    btn.disabled = true;
    btn.className = btn.className
      .replace('bg-primary', 'bg-primary/10')
      .replace('border-primary ', 'border-primary/20 ')
      .replace('text-on-primary', 'text-primary/40')
      .replace('cursor-pointer hover:brightness-110', 'cursor-not-allowed');
  }
  hideUploadStatus();
}

async function uploadSchedule() {
  if (!selectedFile) return;
  const btn = $('upload-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Uploading…'; }

  const form = new FormData();
  form.append('file', selectedFile);
  const pw = ($('upload-password') || {}).value || '';
  if (pw) form.append('password', pw);

  try {
    const r = await fetch('/api/upload-schedule', { method: 'POST', body: form });
    const d = await r.json();

    if (!r.ok || d.error) {
      showUploadStatus('error', d.error || 'Upload failed.');
      if (btn) { btn.disabled = false; btn.textContent = 'Upload & Apply Schedule'; }
      return;
    }

    // Success — update info panel and refresh all data
    showUploadStatus('success',
      `✓ Schedule loaded — ${d.entries.toLocaleString()} entries · ${d.buildings} buildings · ${d.rooms} rooms`);
    fetchScheduleInfo();
    clearFileSelection();
    await refresh(); // re-fetch buildings + rooms so the rest of the app updates immediately

    if (btn) { btn.disabled = false; btn.textContent = 'Upload & Apply Schedule'; }
  } catch(e) {
    showUploadStatus('error', 'Network error — could not reach server.');
    if (btn) { btn.disabled = false; btn.textContent = 'Upload & Apply Schedule'; }
  }
}

function showUploadStatus(type, msg) {
  const el = $('upload-status');
  if (!el) return;
  el.classList.remove('hidden');
  el.textContent = msg;
  if (type === 'success') {
    el.style.cssText = 'display:block;padding:12px 16px;background:rgba(63,255,139,0.08);border:1px solid rgba(63,255,139,0.3);color:#3fff8b;border-radius:2px;font-size:12px;font-family:"Space Grotesk",sans-serif;font-weight:600';
  } else {
    el.style.cssText = 'display:block;padding:12px 16px;background:rgba(255,113,102,0.08);border:1px solid rgba(255,113,102,0.3);color:#ff7166;border-radius:2px;font-size:12px;font-family:"Space Grotesk",sans-serif;font-weight:600';
  }
}

function hideUploadStatus() {
  const el = $('upload-status');
  if (el) el.classList.add('hidden');
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function minToTime(min) {
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}

// ── Room Detail Sheet ────────────────────────────────────────────────────────
function openRoomDetail(building, room) {
  const sheet    = $('room-detail-sheet');
  const backdrop = $('room-detail-backdrop');
  if (!sheet) return;

  setText('rds-building', `${building} · Room Detail`);
  setText('rds-room', room);
  const statusEl = $('rds-status');
  if (statusEl) { statusEl.textContent = 'Loading…'; statusEl.style.cssText = 'color:#767575;font-size:10px;font-family:"Space Grotesk",sans-serif'; }
  setText('rds-day', '');
  setText('rds-summary', '');
  const tl = $('rds-timeline'); if (tl) tl.innerHTML = '';
  const list = $('rds-list');
  if (list) list.innerHTML = `<div style="text-align:center;padding:40px;color:#adaaaa;font-family:'Space Grotesk',sans-serif;font-size:11px;text-transform:uppercase;letter-spacing:0.1em">Loading…</div>`;

  if (backdrop) backdrop.classList.remove('hidden');
  sheet.style.transform = 'translateY(0)';

  fetch(`/api/room/schedule?building=${encodeURIComponent(building)}&room=${encodeURIComponent(room)}`)
    .then(r => r.json())
    .then(data => renderRoomDetail(data))
    .catch(() => {
      if (list) list.innerHTML = `<div style="color:#ff7166;text-align:center;padding:40px;font-size:11px;font-family:'Space Grotesk',sans-serif">Error loading schedule.</div>`;
    });
}

function closeRoomDetail() {
  const sheet    = $('room-detail-sheet');
  const backdrop = $('room-detail-backdrop');
  if (sheet)    sheet.style.transform = 'translateY(100%)';
  if (backdrop) backdrop.classList.add('hidden');
  const fwEl = $('room-free-window');
  if (fwEl) fwEl.classList.add('hidden');
}

function renderRoomDetail(data) {
  const DAY_START = 7 * 60, DAY_END = 22 * 60, SPAN = DAY_END - DAY_START;

  // Status badge
  const statusEl = $('rds-status');
  if (statusEl) {
    let label, color;
    if (data.occupied_now) {
      label = 'In Use'; color = '#ff7166';
    } else {
      const min = data.next_class ? data.next_class.start_min - data.now_min : null;
      label = min === null ? 'Free All Day' : min <= 30 ? 'Closing Soon' : 'Free Now';
      color = (min !== null && min <= 30) ? '#f59e0b' : '#3fff8b';
    }
    statusEl.textContent = label;
    statusEl.style.cssText = `background:${color}1a;border:1px solid ${color}44;color:${color};padding:4px 12px;border-radius:2px;font-size:10px;font-weight:700;font-family:'Space Grotesk',sans-serif;text-transform:uppercase;letter-spacing:0.1em`;
  }

  setText('rds-day', `${data.weekday} · Today`);
  const n = data.classes.length;
  setText('rds-summary', n === 0 ? 'No classes today' : `${n} class${n !== 1 ? 'es' : ''} scheduled`);
  const capEl = $('rds-capacity');
  if (capEl) {
    if (data.capacity) { capEl.textContent = `cap ${data.capacity}`; capEl.classList.remove('hidden'); }
    else { capEl.classList.add('hidden'); }
  }

  // Timeline bar
  const tl = $('rds-timeline');
  if (tl) {
    tl.innerHTML = '';
    data.classes.forEach(cls => {
      const left  = Math.max(0, (cls.start_min - DAY_START) / SPAN * 100);
      const width = Math.min(100 - left, (cls.end_min - cls.start_min) / SPAN * 100);
      const div = document.createElement('div');
      div.style.cssText = `position:absolute;top:0;bottom:0;left:${left}%;width:${width}%;background:${cls.is_current ? '#ff7166bb' : '#ff716640'};border-right:1px solid rgba(255,113,102,0.2)`;
      tl.appendChild(div);
    });
    // Current time marker
    const nowPct = Math.max(0, Math.min(100, (data.now_min - DAY_START) / SPAN * 100));
    const marker = document.createElement('div');
    marker.style.cssText = `position:absolute;top:0;bottom:0;left:${nowPct}%;width:2px;background:#3fff8b;box-shadow:0 0 6px #3fff8b;z-index:2`;
    tl.appendChild(marker);
    const nowLbl = document.createElement('div');
    nowLbl.style.cssText = `position:absolute;top:2px;left:${nowPct}%;font-size:7px;color:#3fff8b;font-family:'Space Grotesk',sans-serif;transform:translateX(-50%);z-index:3;font-weight:700`;
    nowLbl.textContent = 'NOW';
    tl.appendChild(nowLbl);
  }

  // Build slot list: interleave free windows + classes
  const list = $('rds-list');
  if (!list) return;
  list.innerHTML = '';

  if (n === 0) {
    list.innerHTML = `<div style="text-align:center;padding:48px 16px">
      <div style="font-size:36px;margin-bottom:10px">✓</div>
      <div style="font-family:'Space Grotesk',sans-serif;font-size:14px;font-weight:700;color:#3fff8b">Free all day</div>
      <div style="font-family:'Space Grotesk',sans-serif;font-size:11px;color:#767575;margin-top:6px">No classes scheduled today</div>
    </div>`;
    // Hide free window banner — room is free all day; large checkmark above is sufficient
    const fwEl0 = $('room-free-window');
    if (fwEl0) fwEl0.classList.add('hidden');
    return;
  }

  const slots = [];
  let prev = DAY_START;
  data.classes.forEach(cls => {
    if (cls.start_min > prev) slots.push({ type:'free', start:prev, end:cls.start_min });
    slots.push({ type:'class', start:cls.start_min, end:cls.end_min, isCurrent:cls.is_current });
    prev = cls.end_min;
  });
  if (prev < DAY_END) slots.push({ type:'free', start:prev, end:DAY_END });

  const frag = document.createDocumentFragment();
  slots.forEach(slot => {
    const dur = slot.end - slot.start;
    const h = Math.floor(dur / 60), m = dur % 60;
    const durStr = h > 0 ? (m > 0 ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
    const isNow  = slot.start <= data.now_min && data.now_min < slot.end;
    const isPast = slot.end <= data.now_min;
    const row = document.createElement('div');

    if (slot.type === 'class') {
      row.style.cssText = `display:flex;align-items:center;gap:12px;padding:11px 14px;background:${slot.isCurrent?'rgba(255,113,102,0.08)':'rgba(255,255,255,0.03)'};border:1px solid ${slot.isCurrent?'rgba(255,113,102,0.3)':'rgba(255,255,255,0.07)'};border-radius:2px`;
      row.innerHTML = `
        <div style="width:3px;align-self:stretch;background:#ff7166;border-radius:2px;flex-shrink:0"></div>
        <div style="flex:1;min-width:0">
          <div style="font-family:'Space Grotesk',sans-serif;font-size:10px;font-weight:700;color:${slot.isCurrent?'#ff7166':'#767575'};text-transform:uppercase;letter-spacing:0.08em;margin-bottom:3px">${slot.isCurrent?'● In session':'Class'}</div>
          <div style="font-family:'Space Grotesk',sans-serif;font-size:13px;color:#fff">${minToTime(slot.start)} – ${minToTime(slot.end)}</div>
        </div>
        <div style="font-family:'Space Grotesk',sans-serif;font-size:10px;color:#767575;flex-shrink:0">${durStr}</div>`;
    } else {
      const col = isNow ? '#3fff8b' : isPast ? '#444' : '#adaaaa';
      row.style.cssText = `display:flex;align-items:center;gap:12px;padding:11px 14px;background:${isNow?'rgba(63,255,139,0.05)':'transparent'};border:1px solid ${isNow?'rgba(63,255,139,0.15)':'rgba(255,255,255,0.04)'};border-radius:2px`;
      row.innerHTML = `
        <div style="width:3px;align-self:stretch;background:${col}66;border-radius:2px;flex-shrink:0"></div>
        <div style="flex:1;min-width:0">
          <div style="font-family:'Space Grotesk',sans-serif;font-size:10px;font-weight:700;color:${col};text-transform:uppercase;letter-spacing:0.08em;margin-bottom:3px">${isNow?'● Free now':isPast?'Was free':'Free window'}</div>
          <div style="font-family:'Space Grotesk',sans-serif;font-size:13px;color:${isPast?'#555':'#fff'}">${minToTime(slot.start)} – ${minToTime(slot.end)}</div>
        </div>
        <div style="font-family:'Space Grotesk',sans-serif;font-size:10px;font-weight:700;color:${isNow?col:'#767575'};flex-shrink:0">${durStr}</div>`;
    }
    frag.appendChild(row);
  });
  list.appendChild(frag);

  // Render next free window banner
  const fwEl  = $('room-free-window');
  const fwTxt = $('room-free-window-text');
  if (fwEl && fwTxt) {
    const fw = data.next_free_window;
    if (fw) {
      fwTxt.textContent = `${fw.start} \u2013 ${fw.end}  (${fw.duration_mins} min)`;
      fwEl.style.background = '';
      fwEl.classList.remove('hidden');
    } else {
      // Free rest of day
      fwTxt.textContent = 'Free for the rest of the day';
      fwEl.style.background = 'rgba(63,255,139,0.05)';
      fwEl.classList.remove('hidden');
    }
  }
}

// ── Find Me a Room ───────────────────────────────────────────────────────────
let frBuilding = '';

function openFindRoom() {
  const modal = $('find-room-modal');
  if (!modal) return;
  modal.classList.remove('hidden');
  // If we have cached rooms use them; otherwise fetch fresh
  if (state.allRoomsData.length) {
    renderFindRoom(state.allRoomsData);
  } else {
    const res = $('fr-results');
    if (res) res.innerHTML = `<div style="text-align:center;padding:40px;color:#adaaaa;font-family:'Space Grotesk',sans-serif;font-size:11px;text-transform:uppercase">Loading…</div>`;
    fetch('/api/rooms')
      .then(r => r.json())
      .then(data => { state.allRoomsData = data; renderFindRoom(data); })
      .catch(() => { if (res) res.innerHTML = `<div style="color:#ff7166;text-align:center;padding:40px;font-size:11px">Error loading rooms.</div>`; });
  }
}

function closeFindRoom() {
  const modal = $('find-room-modal');
  if (modal) modal.classList.add('hidden');
}

function renderFindRoom(rooms) {
  // Sort: free all day first, then by most minutes remaining
  const source = rooms || state.allRoomsData;
  const filtered = frBuilding ? source.filter(r => r.building === frBuilding) : source;
  const sorted = [...filtered].sort((a, b) => {
    if (a.minutes_until_next === null && b.minutes_until_next === null) return 0;
    if (a.minutes_until_next === null) return -1;
    if (b.minutes_until_next === null) return 1;
    return b.minutes_until_next - a.minutes_until_next;
  });

  // Building chips
  const chipsEl = $('fr-building-chips');
  if (chipsEl) {
    chipsEl.innerHTML = '';
    const makeChip = (label, val) => {
      const btn = document.createElement('button');
      const active = frBuilding === val;
      btn.style.cssText = `flex-shrink:0;padding:5px 12px;font-family:'Space Grotesk',sans-serif;font-size:10px;font-weight:700;border-radius:2px;text-transform:uppercase;letter-spacing:0.1em;cursor:pointer;border:1px solid ${active?'#3fff8b':'rgba(255,255,255,0.08)'};background:${active?'#3fff8b':'transparent'};color:${active?'#005d2c':'#adaaaa'};transition:all 0.15s`;
      btn.textContent = label;
      btn.onclick = () => { frBuilding = val; renderFindRoom(source); };
      return btn;
    };
    chipsEl.appendChild(makeChip('All', ''));
    [...new Set(source.map(r => r.building))].sort().forEach(b => chipsEl.appendChild(makeChip(b, b)));
  }

  // Results
  const res = $('fr-results');
  if (!res) return;
  res.innerHTML = '';

  if (!sorted.length) {
    res.innerHTML = `<div style="text-align:center;padding:48px;color:#767575;font-family:'Space Grotesk',sans-serif;font-size:11px;text-transform:uppercase">No rooms available</div>`;
    return;
  }

  const frag = document.createDocumentFragment();
  sorted.slice(0, 12).forEach((room, i) => {
    const isSoon = room.minutes_until_next !== null && room.minutes_until_next <= state.soonThresholdMins;
    const color  = isSoon ? '#f59e0b' : '#3fff8b';
    const row = document.createElement('div');
    row.style.cssText = `display:flex;align-items:center;gap:14px;padding:13px 14px;background:rgba(63,255,139,0.03);border:1px solid rgba(63,255,139,0.07);border-radius:2px;cursor:pointer;transition:background 0.15s`;
    row.onmouseover = () => { row.style.background = 'rgba(63,255,139,0.08)'; };
    row.onmouseout  = () => { row.style.background = 'rgba(63,255,139,0.03)'; };
    row.onclick = () => { closeFindRoom(); openRoomDetail(room.building, room.room); };
    row.innerHTML = `
      <div style="font-family:'Space Grotesk',sans-serif;font-size:12px;font-weight:800;color:#444;min-width:20px;text-align:center">#${i+1}</div>
      <div style="flex:1;min-width:0">
        <div style="font-family:'Space Grotesk',sans-serif;font-size:9px;font-weight:700;color:#767575;text-transform:uppercase;letter-spacing:0.12em;margin-bottom:3px">${room.building}</div>
        <div style="font-family:'Space Grotesk',sans-serif;font-size:19px;font-weight:800;color:#fff;line-height:1">${room.room}</div>
      </div>
      <div style="text-align:right;flex-shrink:0">
        <div style="font-family:'Space Grotesk',sans-serif;font-size:14px;font-weight:700;color:${color}">${formatTime(room.minutes_until_next)}</div>
        <div style="font-family:'Space Grotesk',sans-serif;font-size:9px;color:#767575;margin-top:3px;text-transform:uppercase">${room.minutes_until_next===null?'all day':isSoon?'closing soon':'remaining'}</div>
      </div>`;
    frag.appendChild(row);
  });
  res.appendChild(frag);
}

// ── Free All Day filter ────────────────────────────────────────────────────
function _updateFreeAllDayBtn(active) {
  const btn = $('free-all-day-btn');
  if (!btn) return;
  btn.style.borderColor  = active ? '#3fff8b' : '';
  btn.style.color        = active ? '#3fff8b' : '';
  btn.style.background   = active ? 'rgba(63,255,139,0.08)' : '';
}

function toggleFreeAllDay() {
  state.freeAllDay = !state.freeAllDay;
  _updateFreeAllDayBtn(state.freeAllDay);
  fetchRooms();
  syncURL();
}

// ── Semester label ─────────────────────────────────────────────────────────
function _inferSemester() {
  const now = new Date();
  const month = now.getMonth() + 1; // 1-12
  const year  = now.getFullYear();
  if (month >= 1 && month <= 5)  return `Spring ${year}`;
  if (month >= 6 && month <= 7)  return `Summer ${year}`;
  return `Fall ${year}`;
}

async function fetchSemesterLabel() {
  try {
    const r = await fetch('/api/schedule-info');
    if (!r.ok) return;
    const d = await r.json();
    const sem = d.semester || _inferSemester();
    setText('sidebar-semester', `${sem} · Live`);
    setText('dash-semester',    `${sem} · Auto-refresh 60s`);
    setText('footer-semester',  sem);
    setText('rooms-view-semester', `LIVE · ${sem}`);
  } catch(e) { /* non-critical */ }
}

// Close overlays on Escape; press / to focus search
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeRoomDetail(); closeFindRoom(); }
  if (e.key === '/' && !['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)) {
    e.preventDefault();
    const search = $('global-search');
    if (search) { search.focus(); switchView('rooms'); }
  }
});

// ── Countdown ──────────────────────────────────────────────────────────────
const REFRESH_INTERVAL_MS = 60_000;
let nextRefreshAt = Date.now() + REFRESH_INTERVAL_MS;

function updateCountdown() {
  const secsLeft = Math.max(0, Math.ceil((nextRefreshAt - Date.now()) / 1000));
  const el = $('refresh-countdown');
  if (el) el.textContent = `Refresh in ${secsLeft}s`;
  const hdrSecs = $('hdr-countdown-secs');
  if (hdrSecs) hdrSecs.textContent = secsLeft;
  const ring = $('refresh-ring');
  if (ring) {
    const circ = 2 * Math.PI * 8; // r=8 → ~50.27
    const pct  = secsLeft / (REFRESH_INTERVAL_MS / 1000);
    ring.style.strokeDashoffset = circ * (1 - pct);
  }
}

// ── Init ───────────────────────────────────────────────────────────────────
async function refresh() {
  await Promise.all([fetchBuildings(), fetchRooms()]);
  fetchAllRoomsCache();
}

async function scheduledRefresh() {
  await refresh();
  nextRefreshAt = Date.now() + REFRESH_INTERVAL_MS;
}

async function init() {
  updateClock();
  setInterval(updateClock, 1000);
  setInterval(updateCountdown, 1000);
  restoreStateFromURL();
  await refresh();
  nextRefreshAt = Date.now() + REFRESH_INTERVAL_MS;
  updateCountdown();
  initDashMap(); // init dashboard map after data is loaded
  fetchSemesterLabel();
  setInterval(scheduledRefresh, REFRESH_INTERVAL_MS);
}

init();
