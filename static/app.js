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

// ── Building full names (searchable; codes alone mean nothing to new students)
const BUILDING_NAMES = {
  'GITC': 'Guttenberg Information Technologies Center',
  'FMH':  'Faculty Memorial Hall',
  'CKB':  'Central King Building',
  'KUPF': 'Kupfrian Hall',
  'TIER': 'Tiernan Hall',
  'CULM': 'Cullimore Hall',
  'ME':   'Mechanical & Industrial Engineering Center',
  'FENS': 'Fenster Hall',
  'ECEC': 'Electrical & Computer Engineering Building',
  'CAMP': 'Campbell Hall',
  'WEST': 'Weston Hall',
  'WEC':  'Wellness & Events Center',
  'COLT': 'Colton Hall',
  'DHRH': 'Dorman Honors Residence Hall',
  'HUD':  'Hudson Building',
  'MALL': 'Student Mall',
  'CTR':  'Campus Center',
  'CAB':  'Central Avenue Building',
};

function buildingName(code) { return BUILDING_NAMES[code] || code; }
function buildingLabel(code) {
  const name = BUILDING_NAMES[code];
  return name ? `${code} · ${name}` : code;
}

// ── State ──────────────────────────────────────────────────────────────────
const state = {
  view: 'dashboard',
  query: Object.freeze({ building: '', day: '', at: '', for: 0, until: '' }),
  snapshot: null,
  requestState: 'loading',
  requestError: '',
  allRoomsCacheReady: false,
  openBuilding: '',
  detailData: null,
  pendingRefresh: null,
  freeAllDay: false, // show only rooms free for rest of day
  savedOnly: false,   // Rooms view: show only pinned rooms
  soonThresholdMins: 30,  // configurable "busy soon" threshold in minutes
  hideFullBuildings: true,  // hide buildings with nothing free (home grid)
  buildingSort: 'free',     // home grid ranking: 'free' | 'distance'
  map: null,       // full-screen map view instance
  dashMap: null,   // dashboard embedded map instance
  markers: {},
  dashMarkers: {},
  buildingsData: [],
  allRoomsData: [], // unfiltered rooms cache for Find Me a Room
  allRoomsCache: [],   // full roster including occupied rooms
  allRoomsCacheKey: null, // filter signature the cache was built for
  mapFloor: 1,
  floorRoomsData: [],
  lastRoomsData: [],   // most recent /api/rooms result, for pin re-renders
  detailRoom: '',      // Legacy "BLDG-ROOM" share key
  detailIdentity: null, // Exact original values for actions; never recover them from rendered markup
  userPos: null,       // {lat, lon} once the user opts into location
  frSort: 'time',      // Find Me a Room ranking: 'time' | 'distance'
  frLastRooms: [],     // last result set rendered in Find Me a Room
};

const reliability = RoomFinderReliability;
const refreshGeneration = reliability.createGeneration();
// Legacy call sites all address the same immutable committed query. Draft input
// values are only read by Apply; these aliases do not maintain a second context.
for (const [alias, key] of Object.entries({ building: 'building', dayAt: 'day', timeAt: 'at', timeFor: 'for', timeUntil: 'until' })) {
  Object.defineProperty(state, alias, {
    get: () => state.query[key],
    set: value => { state.query = Object.freeze({ ...state.query, [key]: value }); },
  });
}

// Shared modal stack. Keep launch identity rather than only a DOM reference:
// periodic refresh can replace the launching room while its detail is open.
const overlays = (() => {
  const stack = [];
  const blocked = new Map();
  let overflow = '';
  const top = () => stack[stack.length - 1];
  const focusable = root => Array.from(root.querySelectorAll('button, input, select, textarea, a[href], [tabindex]'))
    .filter(el => el.tabIndex >= 0 && !el.disabled && !el.closest('[inert]') && el.getClientRects().length);
  function update() {
    blocked.forEach((value, el) => { el.inert = value; });
    blocked.clear();
    const active = top();
    stack.forEach((entry, index) => {
      entry.root.style.zIndex = String(10000 + index * 2);
      entry.root.setAttribute('aria-modal', String(entry === active));
    });
    if (!active) { document.body.style.overflow = overflow; return; }
    // All dialogs are body children; exempt only the central announcement node
    // and the active detail backdrop, never an underlying dialog.
    for (const el of document.body.children) {
      if (el === active.root || el.id === 'sr-status' || el.tagName === 'SCRIPT' ||
          (active.root.id === 'room-detail-sheet' && el.id === 'room-detail-backdrop')) continue;
      blocked.set(el, el.inert); el.inert = true;
    }
    active.root.inert = false;
    const backdrop = $('room-detail-backdrop');
    if (backdrop && active.root.id === 'room-detail-sheet') backdrop.style.zIndex = String(Number(active.root.style.zIndex) - 1);
    document.body.style.overflow = 'hidden';
  }
  function open(id, dismiss, initial) {
    const root = $(id);
    if (!root || stack.some(entry => entry.root === root)) return;
    if (!stack.length) overflow = document.body.style.overflow;
    const launcher = document.activeElement;
    stack.push({root, dismiss, launcher, key:launcher?.dataset?.focusKey});
    root.setAttribute('aria-hidden', 'false'); root.inert = false;
    root.tabIndex = -1;
    update();
    (root.querySelector(initial || '[data-initial-focus]') || focusable(root)[0] || root).focus({preventScroll:true});
  }
  function close(id) {
    const index = stack.findIndex(entry => entry.root.id === id);
    if (index < 0) return;
    const wasTop = index === stack.length - 1;
    const [entry] = stack.splice(index, 1);
    update();
    entry.root.setAttribute('aria-hidden', 'true'); entry.root.inert = true;
    entry.root.removeAttribute('aria-modal');
    if (!wasTop) return;
    const target = entry.launcher?.isConnected ? entry.launcher : entry.key &&
      Array.from(document.querySelectorAll('[data-focus-key]')).find(el => el.dataset.focusKey === entry.key);
    if (target && !target.closest('[inert]') && target.getClientRects().length) target.focus({preventScroll:true});
    else if (top()) (focusable(top().root)[0] || top().root).focus({preventScroll:true});
    else $('filter-more-btn')?.focus({preventScroll:true});
  }
  document.addEventListener('keydown', event => {
    const active = top();
    if (!active) return;
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopImmediatePropagation(); active.dismiss();
    } else if (event.key === 'Tab') {
      const items = focusable(active.root), first = items[0], last = items[items.length - 1];
      if (!first || !active.root.contains(document.activeElement) ||
          (event.shiftKey && (document.activeElement === first || document.activeElement === active.root)) ||
          (!event.shiftKey && document.activeElement === last)) {
        event.preventDefault(); (event.shiftKey ? last : first)?.focus();
        if (!first) active.root.focus();
      }
    }
  }, true);
  document.addEventListener('focusin', event => {
    const active = top();
    if (active && !active.root.contains(event.target)) (focusable(active.root)[0] || active.root).focus({preventScroll:true});
  });
  return {open, close, active:() => top()?.root.id};
})();
let filterDraftOpen = false;

function commitQuery(query, errorId = 'query-error') {
  const error = reliability.validateQuery(query);
  setText(errorId, error);
  if (error) { announce(error); return false; }
  state.query = Object.freeze({ ...query });
  syncQueryInputs();
  syncURL();
  refresh();
  return true;
}

function editQueryFilters() {
  closeRoomDetail();
  closeFindRoom();
  closeFloorPanel();
  if (state.view !== 'rooms') switchView('rooms');
  openFilterSheet();
  const input = $(state.timeUntil ? 'time-filter-until' : state.timeFor ? 'time-filter-for' : 'time-filter-at');
  input?.focus();
  input?.scrollIntoView({block:'center', inline:'nearest'});
}

function syncQueryInputs() {
  for (const [id, value] of Object.entries({ 'time-filter-at': state.timeAt, 'time-filter-for': state.timeFor,
    'time-filter-until': state.timeUntil, 'day-filter': state.dayAt, 'fr-gap-from': state.timeAt, 'fr-gap-until': state.timeUntil })) {
    if (filterDraftOpen && !id.startsWith('fr-gap-')) continue;
    const el = $(id);
    if (el) {
      if (el.tagName === 'SELECT' && !Array.from(el.options).some(option => option.value === String(value))) {
        const option = document.createElement('option'); option.value = String(value); option.textContent = `${value} min`; el.appendChild(option);
      }
      el.value = String(value);
    }
  }
  $('time-filter-indicator')?.classList.toggle('hidden', !state.timeAt && !state.timeFor && !state.dayAt && !state.timeUntil);
  $('fr-gap-clear')?.classList.toggle('hidden', !state.timeUntil);
}

// ── Pinned rooms (localStorage) ─────────────────────────────────────────────
function getPins() {
  try {
    const pins = JSON.parse(localStorage.getItem('pinnedRooms') || '[]');
    return Array.isArray(pins) ? pins.filter(pin => typeof pin === 'string') : [];
  }
  catch (e) { return []; }
}
function isPinned(b, r) { return getPins().includes(`${b}|${r}`); }
function togglePin(b, r) {
  const key = `${b}|${r}`;
  let pins = getPins();
  pins = pins.includes(key) ? pins.filter(p => p !== key) : [...pins, key];
  localStorage.setItem('pinnedRooms', JSON.stringify(pins));
  preserveFocus(() => renderRoomsGrid(state.lastRoomsData));
  renderDetailPin();
}
function pinSort(rooms) {
  // Stable sort: pinned rooms float to the top, original order kept otherwise
  return [...rooms].sort((a, b) =>
    isPinned(b.building, b.room) - isPinned(a.building, a.room));
}

// ── URL state sync ─────────────────────────────────────────────────────────
function syncURL() {
  const params = reliability.queryParams(state.query, true);
  if (state.view && state.view !== 'dashboard') params.set('view', state.view);
  if (state.freeAllDay) params.set('freeAllDay', '1');
  if (state.savedOnly) params.set('saved', '1');
  if (state.soonThresholdMins !== 30) params.set('soon', String(state.soonThresholdMins));
  if (state.detailRoom) {
    params.set('room', state.detailRoom);
    if (state.detailIdentity?.building.includes('-')) params.set('roomBuilding', state.detailIdentity.building);
  }
  const newURL = params.toString() ? '?' + params.toString() : window.location.pathname;
  window.history.replaceState(null, '', newURL);
}

function restoreStateFromURL() {
  const params = new URLSearchParams(window.location.search);
  let view = params.get('view');
  state.query = reliability.readQuery(params);
  setText('query-error', reliability.validateQuery(state.query));
  syncQueryInputs();
  state.freeAllDay = params.get('freeAllDay') === '1';
  state.savedOnly = params.get('saved') === '1';
  updateSavedFilterButtons();
  const soon = Number(params.get('soon'));
  if (Number.isFinite(soon) && soon > 0 && soon <= 1440) {
    state.soonThresholdMins = soon;
    if ($('soon-threshold-select')) $('soon-threshold-select').value = String(soon);
  }
  // Preserve valid old view names and hyphenated room identifiers.
  if (view === 'buildings') view = 'dashboard';
  const roomLink = params.get('room');
  if (roomLink && roomLink.indexOf('-') > 0) {
    state.detailRoom = roomLink;
    const building = params.get('roomBuilding');
    if (building && roomLink.startsWith(building + '-')) state.detailIdentity = { key: roomLink, building, room: roomLink.slice(building.length + 1) };
  }
  if (view && ['dashboard','rooms','map','settings'].includes(view)) switchView(view);
  if (state.detailRoom) {
    const [building, room] = splitDetailRoom(state.detailRoom);
    showRoomDetail(building, room);
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
function textElement(tag, text, css = '') {
  const el = document.createElement(tag);
  el.textContent = text ?? '';
  if (css) el.style.cssText = css;
  return el;
}

// Room cards, floor tiles and pins are <div>/<span> with click handlers, which
// keyboard and screen-reader users cannot reach at all. This makes one behave
// like a button: focusable, labelled, and activated by Enter or Space.
function makeActivatable(el, label, onActivate) {
  el.setAttribute('role', 'button');
  el.setAttribute('tabindex', '0');
  if (label) el.setAttribute('aria-label', label);
  el.addEventListener('click', onActivate);
  el.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      onActivate(e);
    }
  });
}

// Screen-reader announcement for changes that are otherwise only visual
// (auto-refresh results, filter changes).
function announce(msg) {
  const el = $('sr-status');
  if (el) el.textContent = msg;
}
function setText(id, val) { const e = $(id); if (e) e.textContent = val; }

function formatTime(minutes) {
  if (minutes === undefined) return 'Availability unknown';
  if (minutes === null) return 'No more scheduled classes';
  if (minutes < 60) return `~${minutes}M`;
  const h = Math.floor(minutes / 60), m = minutes % 60;
  return m > 0 ? `${h}H ${m}M` : `${h}H`;
}

function occColor(pct) {
  if (pct >= 80) return '#ff7166';
  if (pct >= 50) return '#f59e0b';
  return '#3fff8b';
}

// The one definition of "closing soon". Four copies of this comparison used
// to live in app.js; they agreed by copy-paste, which is not the same as
// agreeing by construction. undefined is guarded explicitly because it
// otherwise reaches `undefined <= n`, which is false for the wrong reason.
function isClosingSoon(room) {
  const mins = room.minutes_until_next;
  return mins !== null && mins !== undefined && mins <= state.soonThresholdMins;
}

// ── Component helpers ──────────────────────────────────────────────────────
// app.js builds most of its UI as inline style strings. These read colour
// from the :root custom properties in index.html so the palette lives in one
// place rather than being retyped at every call site.

function roomStatus(room) {
  if (room.availabilityUnknown) return { kind: 'unknown', text: 'Availability unknown', cssVar: 'var(--muted)' };
  if (room.missingFromSchedule) return { kind: 'unknown', text: 'Not in current schedule', cssVar: 'var(--muted)' };
  if (room.empty === false) {
    return { kind: 'busy', text: 'In use', cssVar: 'var(--busy)' };
  }
  const mins = room.minutes_until_next;
  if (isClosingSoon(room)) {
    return { kind: 'soon', text: formatTime(mins), cssVar: 'var(--soon)' };
  }
  const shortText = mins === null ? 'Rest of day' : undefined;
  return { kind: 'free', text: formatTime(mins), shortText, cssVar: 'var(--free)' };
}

// compact: tiles are ~100px wide, so long wording gets a short form (the full
// text stays in the tile's aria-label and tooltip).
function statusPill(room, compact = false) {
  const st = roomStatus(room);
  const el = document.createElement('span');
  el.className = 'label';
  el.style.cssText = `color:${st.cssVar};white-space:nowrap;flex-shrink:0`;
  el.textContent = compact && st.shortText ? st.shortText : st.text;
  return el;
}

function groupLabel(text) {
  const el = document.createElement('div');
  el.className = 'label';
  el.setAttribute('role', 'presentation');
  el.style.cssText = 'color:var(--faint);padding:10px 2px 6px';
  el.textContent = text;
  return el;
}

// ── End component helpers ──────────────────────────────────────────────────

// ── Clock ──────────────────────────────────────────────────────────────────
function updateClock() {
  const t = new Date().toLocaleTimeString([], { timeZone: 'America/New_York', hour:'2-digit', minute:'2-digit', second:'2-digit' });
  setText('hdr-clock', t);
}
updateClock();
setInterval(updateClock, 1000);

// ── View switching ─────────────────────────────────────────────────────────
function switchView(view) {
  if (view === 'buildings') view = 'dashboard';
  state.view = view;
  // Nav ids were collapsed to three destinations (buildings/map/saved); this
  // maps each underlying view to the nav id that should highlight for it.
  // 'settings' has no sidebar/mobile nav entry (it lives in the header gear).
  const navIdForView = { dashboard: 'buildings', rooms: 'saved', map: 'map' };
  ['dashboard', 'rooms', 'map', 'settings'].forEach(v => {
    const el = $('view-' + v);
    if (el) el.classList.toggle('hidden', v !== view);

    const navId = navIdForView[v];
    if (navId) {
      // Desktop sidebar nav
      const nav = $('nav-' + navId);
      if (nav) {
        if (v === view) {
          nav.classList.add('active-nav');
          nav.classList.remove('text-on-surface-variant/60');
          nav.setAttribute('aria-current', 'page');
        } else {
          nav.classList.remove('active-nav');
          nav.classList.add('text-on-surface-variant/60');
          nav.removeAttribute('aria-current');
        }
      }

      // Mobile bottom nav
      const mob = $('mob-nav-' + navId);
      if (mob) {
        const color = v === view ? '#3fff8b' : '#adaaaa';
        mob.querySelectorAll('span').forEach(s => s.style.color = color);
        if (v === view) {
          mob.setAttribute('aria-current', 'page');
        } else {
          mob.removeAttribute('aria-current');
        }
      }
    }
  });
  if (view === 'map')       initMap();
  if (view === 'dashboard') showHomeHeroMap();
  if (view === 'settings') { fetchScheduleInfo(); loadExportTerms().catch(() => {}); }
  syncURL();
}

// ── Buildings grid (home) ───────────────────────────────────────────────────
function renderBuildingsGrid(buildings) {
  const container = $('buildings-grid');
  if (!container) return;
  container.textContent = '';

  const visible = state.hideFullBuildings
    ? buildings.filter(b => b.empty_rooms > 0)
    : buildings.slice();

  if (state.buildingSort === 'distance' && state.userPos) {
    // Buildings we have no coordinates for sink to the bottom rather than
    // sorting as if they were underfoot.
    visible.sort((a, b) => {
      const da = buildingDistanceMeters(a.building);
      const db = buildingDistanceMeters(b.building);
      if (da === null && db === null) return b.empty_rooms - a.empty_rooms;
      if (da === null) return 1;
      if (db === null) return -1;
      return da - db;
    });
  } else {
    visible.sort((a, b) => b.empty_rooms - a.empty_rooms);
  }

  if (!visible.length) {
    const empty = document.createElement('div');
    empty.className = 'label';
    empty.style.cssText = 'color:var(--muted);padding:32px 4px;text-align:center';
    empty.textContent = 'No buildings have free rooms in this query';
    container.appendChild(empty);
    return;
  }

  visible.forEach(b => {
    const card = document.createElement('button');
    card.type = 'button';
    card.setAttribute('aria-label',
      `${buildingName(b.building)}, ${b.empty_rooms} of ${b.total_rooms} rooms free`);
    card.style.cssText = 'display:flex;align-items:center;gap:12px;width:100%;min-height:64px;' +
      'padding:12px 14px;background:var(--raised);border:1px solid var(--hairline-soft);' +
      'border-radius:10px;text-align:left;cursor:pointer';
    card.addEventListener('click', () => openBuildingPanel(b));

    // Show the distance when we have one — a list sorted by a key the reader
    // cannot see is hard to trust. But suppress it when the fix is too coarse
    // to rank with: printing "304 m" off a +/-400 m fix claims a precision we
    // just told the user we do not have.
    const usable = state.userPos && !isPositionStale(state.userPos, Date.now()) && locationQuality(state.userPos.accuracy).tier !== 'unusable';
    const dist = usable ? buildingDistanceMeters(b.building) : null;
    const distLabel = dist === null ? '' :
      (dist >= 1000 ? `${(dist / 1000).toFixed(1)} km` : `${Math.round(dist)} m`);
    if (distLabel) {
      card.setAttribute('aria-label',
        `${buildingName(b.building)}, ${b.empty_rooms} of ${b.total_rooms} rooms free, ${distLabel} away`);
    }
    card.dataset.focusKey = `building:${b.building}`;
    card.appendChild(textElement('div', b.building, 'width:52px;flex:none;font-size:15px;font-weight:700;color:var(--text);overflow-wrap:anywhere'));
    card.appendChild(textElement('div', buildingName(b.building) + (distLabel ? ` · ${distLabel}` : ''), 'flex:1;min-width:0;font-size:12px;color:var(--muted)'));
    card.appendChild(textElement('div', `${b.empty_rooms} of ${b.total_rooms} free`, 'font-size:13px;font-weight:700;color:var(--text)'));
    container.appendChild(card);
  });
}



function toggleHideFull() {
  state.hideFullBuildings = !state.hideFullBuildings;
  renderBuildingsControls(state.buildingsData);
  renderBuildingsGrid(state.buildingsData);
  const n = state.buildingsData.filter(b => b.empty_rooms > 0).length;
  announce(state.hideFullBuildings
    ? `Showing ${n} buildings with free rooms.`
    : `Showing all ${state.buildingsData.length} buildings.`);
}

function renderBuildingsControls(buildings) {
  const container = $('buildings-controls');
  if (!container) return;
  container.textContent = '';

  const on = state.hideFullBuildings;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'label';
  btn.setAttribute('role', 'switch');
  btn.setAttribute('aria-checked', on ? 'true' : 'false');
  btn.style.cssText = 'display:flex;align-items:center;gap:8px;min-height:44px;padding:8px 14px;' +
    'border-radius:9999px;cursor:pointer;' +
    (on ? 'color:var(--free);background:rgba(63,255,139,0.09);border:1px solid rgba(63,255,139,0.28)'
        : 'color:var(--muted);background:transparent;border:1px solid var(--hairline-soft)');
  btn.textContent = 'Hide full';
  btn.dataset.focusKey = 'hide-full';
  btn.addEventListener('click', toggleHideFull);

  const track = document.createElement('span');
  track.setAttribute('aria-hidden', 'true');
  track.style.cssText = 'width:22px;height:12px;border-radius:9999px;position:relative;flex:none;' +
    (on ? 'background:rgba(63,255,139,0.32)' : 'background:rgba(255,255,255,0.12)');
  const knob = document.createElement('span');
  knob.style.cssText = 'position:absolute;top:1.5px;width:9px;height:9px;border-radius:9999px;' +
    (on ? 'right:1.5px;background:var(--free)' : 'left:1.5px;background:var(--faint)');
  track.appendChild(knob);
  btn.appendChild(track);
  container.appendChild(btn);

  const distanceOn = state.buildingSort === 'distance';
  const sortBtn = document.createElement('button');
  sortBtn.type = 'button';
  sortBtn.id = 'buildings-sort';
  sortBtn.dataset.focusKey = 'building-sort';
  sortBtn.className = 'label';
  sortBtn.setAttribute('aria-pressed', distanceOn ? 'true' : 'false');
  sortBtn.style.cssText = 'display:flex;align-items:center;gap:7px;min-height:44px;padding:8px 14px;' +
    'border-radius:9999px;cursor:pointer;' +
    (distanceOn ? 'color:var(--free);background:rgba(63,255,139,0.09);border:1px solid rgba(63,255,139,0.28)'
                : 'color:var(--muted);background:transparent;border:1px solid var(--hairline-soft)');
  sortBtn.textContent = distanceOn ? 'Nearest' : 'Most free';
  sortBtn.addEventListener('click', () => setBuildingSort(distanceOn ? 'free' : 'distance'));
  container.appendChild(sortBtn);

  const count = document.createElement('span');
  count.className = 'label';
  count.style.cssText = 'color:var(--faint);white-space:nowrap';
  const shown = on ? buildings.filter(b => b.empty_rooms > 0).length : buildings.length;
  count.textContent = `${shown} shown`;
  container.appendChild(count);
}

function setBuildingsGeoStatus(msg, color) {
  const el = $('buildings-geo-status');
  if (!el) return;
  if (!msg) { el.classList.add('hidden'); el.textContent = ''; return; }
  el.textContent = msg;
  el.style.color = color || 'var(--faint)';
  el.classList.remove('hidden');
}

// Ranking the home grid by distance. Shares state.userPos with Find Me a Room,
// so granting permission on either surface benefits the other.
async function setBuildingSort(mode) {
  if (mode === 'distance') {
    if (!state.userPos || isPositionStale(state.userPos, Date.now())) {
      setBuildingsGeoStatus('Getting your location…');
      try {
        await requestLocation();
      } catch (err) {
        setBuildingsGeoStatus(
          err && err.code === 1
            ? 'Location permission denied — sorted by most free instead.'
            : 'Could not get your location — sorted by most free instead.',
          'var(--soon)');
        state.buildingSort = 'free';
        renderBuildingsControls(state.buildingsData);
        renderBuildingsGrid(state.buildingsData);
        return;
      }
    }
    const q = locationQuality(state.userPos.accuracy);
    if (q.tier === 'unusable') {
      setBuildingsGeoStatus(q.message + ' Sorted by most free instead.', 'var(--soon)');
      state.buildingSort = 'free';
      renderBuildingsControls(state.buildingsData);
      renderBuildingsGrid(state.buildingsData);
      return;
    }
    setBuildingsGeoStatus(q.tier === 'coarse' ? q.message : '', 'var(--soon)');
  } else {
    setBuildingsGeoStatus('');
  }
  state.buildingSort = mode;
  renderBuildingsControls(state.buildingsData);
  renderBuildingsGrid(state.buildingsData);
  announce(mode === 'distance' ? 'Buildings sorted by distance.' : 'Buildings sorted by most free.');
}

// ── Fetch data ─────────────────────────────────────────────────────────────
// Availability is published together by refresh(), never by individual fetches.
async function fetchRooms() { return refresh(); }
function filterParams({ building = false } = {}) {
  return reliability.queryParams(state.query, building);
}
async function fetchAllRoomsCache() {
  const key = filterParams().toString();
  if (state.allRoomsCacheReady && state.allRoomsCacheKey === key &&
      state.snapshot && Date.now() - state.snapshot.acceptedAt < REFRESH_INTERVAL_MS) return;
  if (state.pendingRefresh && state.pendingRefresh.key === key) return state.pendingRefresh.promise;
  return refresh();
}

// ── Stats ──────────────────────────────────────────────────────────────────
function updateStats(buildings) {
  const totalRooms = buildings.reduce((s, b) => s + b.total_rooms, 0);
  const totalEmpty = buildings.reduce((s, b) => s + b.empty_rooms, 0);
  const totalOccupied = totalRooms - totalEmpty;
  const occ = totalRooms > 0 ? Math.round(totalOccupied / totalRooms * 100) + '%' : '—';
  setText('stat-total', totalRooms);
  setText('stat-empty', totalEmpty);
  setText('stat-occ', occ);
  setText('stat-bldg', buildings.length);
  setText('hdr-empty', totalEmpty);
  setText('hdr-occ', occ);
  const dayFull = state.snapshot?.meta.context?.day || state.dayAt || reliability.campusTime().day;
  setText('hdr-day', dayFull);
}


// ── Time filter ────────────────────────────────────────────────────────────
function openFilterSheet() {
  if (filterDraftOpen) return;
  syncQueryInputs();
  $('soon-threshold-select').value = String(state.soonThresholdMins);
  $('filter-free-all-day').checked = state.freeAllDay;
  setText('filter-error', '');
  filterDraftOpen = true;
  $('filter-sheet').classList.remove('hidden');
  overlays.open('filter-sheet', closeFilterSheet, '#day-filter');
}

function closeFilterSheet() {
  filterDraftOpen = false;
  $('filter-sheet')?.classList.add('hidden');
  overlays.close('filter-sheet');
  syncQueryInputs();
}

function applyTimeFilter() {
  const query = { ...state.query, at: $('time-filter-at')?.value || '',
    for: Number($('time-filter-for')?.value || 0), day: $('day-filter')?.value || '',
    until: $('time-filter-until')?.value || '' };
  const error = reliability.validateQuery(query);
  setText('filter-error', error);
  if (error) {
    const id = error.includes('after') ? 'time-filter-until' : error.includes('duration') ? 'time-filter-for' : 'time-filter-at';
    $(id)?.focus(); return;
  }
  // Validate before publishing any query or display preference. A single URL
  // update and refresh then use the complete committed selection.
  state.soonThresholdMins = Number($('soon-threshold-select')?.value) || 30;
  state.freeAllDay = Boolean($('filter-free-all-day')?.checked);
  closeFilterSheet();
  commitQuery(query);
}

function resetTimeFilter() {
  if (!filterDraftOpen) return commitQuery({ ...state.query, at:'', for:0, day:'', until:'' });
  for (const id of ['day-filter','time-filter-at','time-filter-until']) $(id).value = '';
  $('time-filter-for').value = '0';
  $('soon-threshold-select').value = '30';
  $('filter-free-all-day').checked = false;
  setText('filter-error', '');
}

function toggleFilterMore() { openFilterSheet(); }

// ── Global search (grouped as-you-type autocomplete) ───────────────────────
const SEARCH_STOPWORDS = new Set(['floor', 'fl', 'the', 'room', 'rooms', 'building', 'bldg', 'hall', 'at']);
const FLOOR_ALIASES = {
  ground: 0, grd: 0, gnd: 0, basement: 0, bsmt: 0,
  first: 1, '1st': 1,
  second: 2, '2nd': 2,
  third: 3, '3rd': 3,
  fourth: 4, '4th': 4,
  fifth: 5, '5th': 5,
  sixth: 6, '6th': 6,
  seventh: 7, '7th': 7,
};
const SEARCH_DEBOUNCE_MS = 150;
const SEARCH_MAX_BUILDINGS = 6;
const SEARCH_MAX_ROOMS = 8;

let searchDebounceTimer = null;
let searchActiveIndex = -1;
let searchFlatItems = [];
let searchPanelOpen = false;
// Bumped whenever a search render is superseded or the panel is dismissed, so
// an in-flight runSearch cannot re-open a panel the user already closed.
let searchRunSeq = 0;

function normalizeSearchQuery(raw) {
  return String(raw || '').trim().toLowerCase().replace(/[-_/,]+/g, ' ').replace(/\s+/g, ' ');
}

function floorLabel(floor) {
  if (floor === 0) return 'Ground';
  const v = floor % 100;
  const suffix = (v >= 11 && v <= 13) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[floor % 10] || 'th');
  return `${floor}${suffix} floor`;
}

function parseFloorFromTokens(tokens) {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (FLOOR_ALIASES[t] !== undefined) return FLOOR_ALIASES[t];
    const m = t.match(/^(?:fl(?:oor)?)(\d+)$/);
    if (m) return parseInt(m[1], 10);
    if ((t === 'floor' || t === 'fl') && /^\d+$/.test(tokens[i + 1] || '')) {
      return parseInt(tokens[i + 1], 10);
    }
  }
  return null;
}

function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 9;
  const al = a.length, bl = b.length;
  const prev = new Array(bl + 1);
  for (let j = 0; j <= bl; j++) prev[j] = j;
  for (let i = 1; i <= al; i++) {
    let prevDiag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= bl; j++) {
      const tmp = prev[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, prevDiag + cost);
      prevDiag = tmp;
    }
  }
  return prev[bl];
}

function searchRoomSource() {
  return state.allRoomsCacheReady ? state.allRoomsCache : state.allRoomsData;
}

function scoreBuilding(q, tokens, b) {
  const code = b.building.toLowerCase();
  const name = (BUILDING_NAMES[b.building] || '').toLowerCase();
  if (code === q || name === q) return 100;
  if (tokens.some(t => t === code)) return 92;
  if (code.startsWith(q)) return 90;
  if (name.startsWith(q)) return 85;
  if (name.includes(q)) return 75;
  if (code.includes(q)) return 70;
  if (tokens.some(t => t.length >= 3 && (name.includes(t) || code.includes(t)))) return 65;
  return 0;
}

function roomMatchesQuery(room, q, tokens, floorFilter, buildingCodes) {
  const code = room.building.toLowerCase();
  const num = String(room.room).toLowerCase();
  const name = (BUILDING_NAMES[room.building] || '').toLowerCase();
  const full = `${code} ${num}`;
  const compact = `${code}${num}`;
  if (full.includes(q) || compact.includes(q.replace(/ /g, '')) || num.includes(q) || name.includes(q)) {
    if (floorFilter !== null && buildingCodes.length && !buildingCodes.includes(room.building)) return false;
    if (floorFilter !== null && buildingCodes.length && room.floor !== floorFilter) return false;
    return true;
  }
  if (floorFilter !== null && room.floor === floorFilter) {
    return !buildingCodes.length || buildingCodes.includes(room.building);
  }
  return false;
}

function scoreRoom(room, q, tokens) {
  const num = String(room.room).toLowerCase();
  const last = tokens[tokens.length - 1] || q;
  let s = 0;
  if (num === last || num === q) s += 50;
  else if (num.startsWith(last)) s += 30;
  else if (num.includes(last)) s += 15;
  if (room.empty !== false) s += 10;
  if (room.minutes_until_next === null) s += 5;
  return s;
}

function buildingCodesFromTokens(tokens, buildings) {
  const codes = [];
  for (const t of tokens) {
    if (!t || SEARCH_STOPWORDS.has(t) || FLOOR_ALIASES[t] !== undefined) continue;
    for (const b of buildings) {
      const code = b.building.toLowerCase();
      const name = (BUILDING_NAMES[b.building] || '').toLowerCase();
      if (code === t || code.startsWith(t) || (t.length >= 3 && name.includes(t))) {
        if (!codes.includes(b.building)) codes.push(b.building);
      }
    }
  }
  return codes;
}

function nearbySearchSuggestions(q, buildings, rooms) {
  const out = [];
  const seenB = new Set();
  const seenR = new Set();
  for (const b of buildings) {
    const code = b.building.toLowerCase();
    const name = (BUILDING_NAMES[b.building] || '').toLowerCase();
    const dCode = editDistance(q, code);
    const dName = q.length >= 3 ? editDistance(q, name.slice(0, Math.max(q.length, 4))) : 9;
    if ((dCode > 0 && dCode <= 2) || (dName > 0 && dName <= 2)) {
      out.push({ kind: 'building', data: b });
      seenB.add(b.building);
    }
    if (out.length >= 3) return out;
  }
  const digits = q.replace(/\D/g, '');
  if (digits.length >= 2) {
    for (const r of rooms) {
      const num = String(r.room);
      const nd = num.replace(/\D/g, '');
      if (num.includes(digits) || (nd.length >= 2 && editDistance(digits, nd) <= 1)) {
        const key = `${r.building}|${r.room}`;
        if (seenR.has(key)) continue;
        out.push({ kind: 'room', data: r });
        seenR.add(key);
        if (out.length >= 3) return out;
      }
    }
  }
  for (const r of _sortedBestRooms(rooms.filter(rm => rm.empty !== false), 3)) {
    if (out.length >= 3) break;
    const key = `${r.building}|${r.room}`;
    if (seenR.has(key)) continue;
    out.push({ kind: 'room', data: r });
    seenR.add(key);
  }
  return out.slice(0, 3);
}

function buildSearchModel(rawQuery) {
  const q = normalizeSearchQuery(rawQuery);
  const buildings = state.buildingsData || [];
  const rooms = searchRoomSource();

  if (!q) {
    return {
      query: '',
      emptyQuery: true,
      buildings: [...buildings].sort((a, b) => b.empty_rooms - a.empty_rooms).slice(0, 3),
      rooms: _sortedBestRooms(rooms.filter(r => r.empty !== false), 3),
      nearby: [],
      findRoom: true,
    };
  }

  const tokens = q.split(' ').filter(Boolean);
  const floorFilter = parseFloorFromTokens(tokens);
  const bldgCodes = buildingCodesFromTokens(tokens, buildings);

  const scoredBuildings = buildings
    .map(b => ({ b, score: scoreBuilding(q, tokens, b) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, SEARCH_MAX_BUILDINGS)
    .map(x => x.b);

  const matchedRooms = rooms
    .filter(r => roomMatchesQuery(r, q, tokens, floorFilter, bldgCodes))
    .sort((a, b) => scoreRoom(b, q, tokens) - scoreRoom(a, q, tokens))
    .slice(0, SEARCH_MAX_ROOMS);

  const hasHits = scoredBuildings.length + matchedRooms.length > 0;
  return {
    query: rawQuery.trim(),
    emptyQuery: false,
    buildings: scoredBuildings,
    rooms: matchedRooms,
    nearby: hasHits ? [] : nearbySearchSuggestions(q, buildings, rooms),
    findRoom: !hasHits,
  };
}

// Hex mirror of the :root status custom properties, for the call sites below
// that assemble inline style strings by hand. Kept beside its only consumers
// rather than in the component-helpers region, which is deliberately hex-free.
const STATUS_HEX = { free: '#3fff8b', soon: '#f59e0b', busy: '#ff7166', unknown: '#adaaaa' };

// Everything the Rooms-view card needs to draw one room, derived from the
// single status source. Busy rooms only reach the card via the Saved filter —
// the free-rooms feed never returns them — and they are dimmed and shown
// rather than hidden, so a saved room that filled up still appears.
const STATUS_BORDER = {
  free: 'rgba(63,255,139,0.1)',
  soon: 'rgba(245,158,11,0.2)',
  busy: 'rgba(255,113,102,0.18)',
  unknown: 'var(--hairline-soft)',
};

function roomCardStatus(room) {
  const st = roomStatusMeta(room);
  const busy = st.kind === 'busy';
  return {
    kind: st.kind,
    color: st.color,
    border: STATUS_BORDER[st.kind],
    // The pill reads OPEN / CLOSING / IN USE; the right-hand figure is the
    // time remaining, which is meaningless for a room that is occupied.
    label: st.kind === 'unknown' ? st.text.toUpperCase() : busy ? 'IN USE' : st.kind === 'soon' ? 'CLOSING' : 'OPEN',
    timeText: busy || st.kind === 'unknown' ? '' : formatTime(room.minutes_until_next),
    statusWord: busy ? 'in use' : st.kind === 'soon' ? 'closing soon' : 'open',
    opacity: busy ? 0.55 : 1,
  };
}

// Adapter over roomStatus() for those same call sites. The uppercase busy
// label is deliberate and load-bearing — search results render it as-is.
function roomStatusMeta(room) {
  const st = roomStatus(room);
  return {
    kind: st.kind,
    text: st.kind === 'busy' ? 'IN USE' : st.text,
    color: STATUS_HEX[st.kind],
  };
}

function isMobileSearchOpen() {
  const overlay = $('mobile-search-overlay');
  return !!overlay && !overlay.classList.contains('hidden');
}

function isSearchPanelOpen() {
  return searchPanelOpen || isMobileSearchOpen();
}

function syncSearchInputs(value, exceptId) {
  ['global-search', 'mobile-search-input'].forEach(id => {
    if (id === exceptId) return;
    const el = $(id);
    if (el && el.value !== value) el.value = value;
  });
}

function setSearchExpanded(expanded) {
  ['global-search', 'mobile-search-input'].forEach(id => {
    const el = $(id);
    if (el) el.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  });
}

function hideSearchPanel() {
  searchRunSeq++;
  const el = $('search-results');
  if (el) {
    el.classList.add('hidden');
    el.textContent = '';
  }
  searchPanelOpen = false;
  searchActiveIndex = -1;
  searchFlatItems = [];
  const inp = $('global-search');
  if (inp) inp.removeAttribute('aria-activedescendant');
  if (!isMobileSearchOpen()) setSearchExpanded(false);
}

function closeSearchUI({ clear = false } = {}) {
  hideSearchPanel();
  if (isMobileSearchOpen()) {
    const overlay = $('mobile-search-overlay');
    if (overlay) overlay.classList.add('hidden');
    overlays.close('mobile-search-overlay');
  }
  if (clear) {
    ['global-search', 'mobile-search-input'].forEach(id => {
      const el = $(id); if (el) el.value = '';
    });
  }
  setSearchExpanded(false);
}

function addSearchGroupLabel(parent, text) {
  const lab = document.createElement('div');
  lab.setAttribute('role', 'presentation');
  lab.style.cssText = "padding:10px 14px 6px;font-family:'Space Grotesk',sans-serif;font-size:9px;font-weight:700;color:#767575;text-transform:uppercase;letter-spacing:0.18em";
  lab.textContent = text;
  parent.appendChild(lab);
}

function makeSearchOption(item, idx) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.id = `search-opt-${idx}`;
  btn.setAttribute('role', 'option');
  btn.setAttribute('aria-selected', 'false');
  btn.tabIndex = -1;
  btn.dataset.searchIdx = String(idx);
  btn.style.cssText = 'width:100%;display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:52px;padding:10px 14px;background:transparent;border:none;border-bottom:1px solid rgba(255,255,255,0.04);text-align:left;cursor:pointer';
  btn.addEventListener('mousedown', e => e.preventDefault());
  btn.addEventListener('click', () => activateSearchItem(item));
  btn.addEventListener('mouseenter', () => highlightSearchIndex(idx));
  return btn;
}

function highlightSearchIndex(idx) {
  searchActiveIndex = idx;
  searchFlatItems.forEach((_, i) => {
    const el = $(`search-opt-${i}`);
    if (!el) return;
    const on = i === idx;
    el.setAttribute('aria-selected', on ? 'true' : 'false');
    el.style.background = on ? 'rgba(63,255,139,0.08)' : 'transparent';
  });
  const active = $(`search-opt-${idx}`);
  const inp = isMobileSearchOpen() ? $('mobile-search-input') : $('global-search');
  if (inp) {
    if (active) inp.setAttribute('aria-activedescendant', active.id);
    else inp.removeAttribute('aria-activedescendant');
  }
  if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest' });
}

function activateSearchItem(item) {
  if (!item) return;
  if (item.kind === 'building') {
    closeSearchUI({ clear: true });
    const data = item.data;
    if (data) openBuildingPanel(data);
    return;
  }
  if (item.kind === 'room') {
    const room = item.data;
    closeSearchUI({ clear: true });
    if (room) openRoomDetail(room.building, room.room);
    return;
  }
  if (item.kind === 'find') {
    closeSearchUI({ clear: false });
    openFindRoom();
  }
}

function renderSearchModel(container, model) {
  if (!container) return;
  const previousSelection = searchFlatItems[searchActiveIndex];
  const selectionKey = item => item ? JSON.stringify([item.kind, item.data?.building, item.data?.room]) : null;
  const previousKey = selectionKey(previousSelection);
  container.textContent = '';
  searchFlatItems = [];
  searchActiveIndex = -1;

  const frag = document.createDocumentFragment();
  const addItem = (kind, data, builder) => {
    const item = { kind, data };
    const idx = searchFlatItems.length;
    searchFlatItems.push(item);
    const btn = makeSearchOption(item, idx);
    builder(btn);
    frag.appendChild(btn);
  };

  if (model.emptyQuery) {
    const hint = document.createElement('div');
    hint.style.cssText = "padding:12px 14px 4px;font-family:'Space Grotesk',sans-serif;font-size:11px;color:#adaaaa";
    hint.textContent = 'Type a building code, name, or room number — or pick a suggestion.';
    frag.appendChild(hint);
  }

  if (!model.emptyQuery && !model.buildings.length && !model.rooms.length) {
    const empty = document.createElement('div');
    empty.style.cssText = "padding:16px 14px 8px;font-family:'Space Grotesk',sans-serif";
    const title = document.createElement('div');
    title.style.cssText = 'font-size:13px;font-weight:700;color:#fff;margin-bottom:4px';
    title.textContent = 'No results';
    const sub = document.createElement('div');
    sub.style.cssText = 'font-size:11px;color:#adaaaa';
    sub.textContent = model.query ? `Nothing matched “${model.query}”. Try a nearby match or Find Me a Room.` : 'Nothing matched.';
    empty.appendChild(title);
    empty.appendChild(sub);
    frag.appendChild(empty);

    if (model.nearby.length) addSearchGroupLabel(frag, 'Nearby suggestions');
    model.nearby.forEach(n => {
      if (n.kind === 'building') {
        addItem('building', n.data, btn => fillBuildingOption(btn, n.data));
      } else if (n.kind === 'room') {
        addItem('room', n.data, btn => fillRoomOption(btn, n.data));
      }
    });
  } else {
    if (model.buildings.length) {
      addSearchGroupLabel(frag, 'Buildings');
      model.buildings.forEach(b => addItem('building', b, btn => fillBuildingOption(btn, b)));
    }
    if (model.rooms.length) {
      addSearchGroupLabel(frag, 'Rooms');
      model.rooms.forEach(r => addItem('room', r, btn => fillRoomOption(btn, r)));
    }
  }

  if (model.findRoom) {
    addItem('find', null, btn => {
      btn.setAttribute('aria-label', 'Find Me a Room — best matching rooms in this query');
      btn.innerHTML = `
        <div style="display:flex;align-items:center;gap:10px;min-width:0">
          <span class="material-symbols-outlined" style="font-size:18px;color:#3fff8b">search</span>
          <div>
            <div style="font-family:'Space Grotesk',sans-serif;font-size:13px;font-weight:700;color:#3fff8b">Find Me a Room</div>
            <div style="font-family:'Space Grotesk',sans-serif;font-size:10px;color:#adaaaa;margin-top:2px">Best matching rooms in this query</div>
          </div>
        </div>
        <span class="material-symbols-outlined" style="font-size:16px;color:#767575">arrow_forward</span>`;
    });
  }

  container.appendChild(frag);
  if (container.id === 'search-results') {
    container.classList.remove('hidden');
    searchPanelOpen = true;
  }
  setSearchExpanded(true);
  const restoredIndex = previousKey ? searchFlatItems.findIndex(item => selectionKey(item) === previousKey) : -1;
  highlightSearchIndex(restoredIndex);

  const n = searchFlatItems.length;
  if (model.emptyQuery) announce('Search suggestions. Type to filter buildings and rooms.');
  else if (!model.buildings.length && !model.rooms.length) announce(`No results for ${model.query}. ${n} suggestion${n === 1 ? '' : 's'} available.`);
  else announce(`${model.buildings.length} building${model.buildings.length === 1 ? '' : 's'}, ${model.rooms.length} room${model.rooms.length === 1 ? '' : 's'}.`);
}

function fillBuildingOption(btn, b) {
  btn.setAttribute('aria-label', `${buildingLabel(b.building)}, ${b.empty_rooms} of ${b.total_rooms} rooms free. Open building.`);
  btn.dataset.focusKey = `search-building:${b.building}`;
  btn.appendChild(textElement('div', buildingLabel(b.building), 'font-size:14px;color:var(--text)'));
  btn.appendChild(textElement('div', `${b.empty_rooms} free`, 'font-size:12px;color:var(--muted)'));
}

function fillRoomOption(btn, room) {
  const st = roomStatusMeta(room);
  btn.setAttribute('aria-label', `${buildingName(room.building)} room ${room.room}, ${st.text}. Open schedule.`);
  btn.dataset.focusKey = `search-room:${JSON.stringify([room.building,room.room])}`;
  const text = textElement('div', buildingLabel(room.building), 'font-size:11px;color:var(--muted)');
  text.appendChild(textElement('div', room.room, 'font-size:18px;font-weight:800;color:var(--text)'));
  btn.appendChild(text);
  btn.appendChild(textElement('span', st.text, `font-size:12px;color:${st.color}`));
}

async function runSearch(rawQuery) {
  const seq = ++searchRunSeq;
  await fetchAllRoomsCache();
  // Superseded by a newer query, or the panel was dismissed while we awaited.
  if (seq !== searchRunSeq) return;
  const model = buildSearchModel(rawQuery);
  const overlayOpen = isMobileSearchOpen();
  if (overlayOpen) {
    hideSearchPanel();
    renderSearchModel($('mobile-search-results'), model);
    return;
  }
  const panel = $('search-results');
  renderSearchModel(panel, model);
}

function onSearchInput(value, sourceId) {
  syncSearchInputs(value, sourceId);
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    searchDebounceTimer = null;
    runSearch(value);
  }, SEARCH_DEBOUNCE_MS);
}

function onSearchFocus(input) {
  const q = input ? input.value : '';
  syncSearchInputs(q, input && input.id);
  runSearch(q);
}

function onSearchKeydown(e) {
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closeSearchUI({ clear: false });
    if (e.target && e.target.blur) e.target.blur();
    return;
  }
  const navKeys = ['ArrowDown', 'ArrowUp', 'Enter', 'Home', 'End'];
  if (!navKeys.includes(e.key)) return;
  e.preventDefault();
  const pending = searchDebounceTimer;
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = null;
  const go = () => handleSearchNav(e);
  if (pending || !searchFlatItems.length) {
    runSearch(e.target.value || '').then(go);
  } else {
    go();
  }
}

function handleSearchNav(e) {
  if (!searchFlatItems.length) return;
  if (e.key === 'ArrowDown') {
    highlightSearchIndex((searchActiveIndex + 1) % searchFlatItems.length);
  } else if (e.key === 'ArrowUp') {
    highlightSearchIndex((searchActiveIndex - 1 + searchFlatItems.length) % searchFlatItems.length);
  } else if (e.key === 'Home') {
    highlightSearchIndex(0);
  } else if (e.key === 'End') {
    highlightSearchIndex(searchFlatItems.length - 1);
  } else if (e.key === 'Enter') {
    const item = searchFlatItems[searchActiveIndex] || searchFlatItems[0];
    activateSearchItem(item);
  }
}

function openMobileSearch() {
  const overlay = $('mobile-search-overlay');
  if (!overlay) return;
  hideSearchPanel();
  overlay.classList.remove('hidden');
  const headerVal = $('global-search')?.value || '';
  const inp = $('mobile-search-input');
  if (inp) {
    inp.value = headerVal;
  }
  overlays.open('mobile-search-overlay', () => closeSearchUI(), '#mobile-search-input');
  runSearch(headerVal);
}

function toggleMobileSearch() {
  const overlay = $('mobile-search-overlay');
  if (!overlay) return;
  if (overlay.classList.contains('hidden')) openMobileSearch();
  else closeSearchUI();
}

document.addEventListener('mousedown', e => {
  if (isMobileSearchOpen()) return;
  const wrap = $('search-wrap');
  if (wrap && !wrap.contains(e.target)) hideSearchPanel();
});

// ── Health bars ────────────────────────────────────────────────────────────
function _sortedBestRooms(rooms, limit) {
  return [...rooms].sort((a, b) => {
    if (a.minutes_until_next === null && b.minutes_until_next === null) return 0;
    if (a.minutes_until_next === null) return -1;
    if (b.minutes_until_next === null) return 1;
    return b.minutes_until_next - a.minutes_until_next;
  }).slice(0, limit);
}


function renderSidebarTopRooms(rooms) {
  const container = $('sidebar-top-rooms');
  if (!container) return;
  container.replaceChildren();
  const best = _sortedBestRooms(rooms, 5);
  if (!best.length) { container.textContent = 'No matching rooms'; return; }
  best.forEach(room => {
    const btn = textElement('button', '', 'width:100%;display:flex;flex-direction:column;align-items:flex-start;gap:2px;padding:6px 8px;cursor:pointer;background:transparent;text-align:left');
    btn.type = 'button';
    btn.dataset.focusKey = `sidebar:${JSON.stringify([room.building,room.room])}`;
    btn.addEventListener('click', () => openRoomDetail(room.building,room.room));
    btn.appendChild(textElement('span', `${room.building} ${room.room}`, 'font-size:12px;color:var(--text);overflow-wrap:anywhere'));
    btn.appendChild(statusPill(room));
    container.appendChild(btn);
  });
}

// ── Live feed (dashboard) ──────────────────────────────────────────────────

// ── Dashboard mini room grid ───────────────────────────────────────────────

// ── Rooms table (dashboard) ────────────────────────────────────────────────

// ── Dashboard building filter chips ───────────────────────────────────────

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
function savedRooms() {
  const roster = searchRoomSource();
  return getPins().map(pin => {
    const index = pin.indexOf('|');
    const building = pin.slice(0,index), room = pin.slice(index + 1);
    return roster.find(entry => entry.building === building && String(entry.room) === room) ||
      {building, room, ...(state.allRoomsCacheReady ? {missingFromSchedule:true} : {availabilityUnknown:true})};
  });
}

function suitabilityLabel(room) {
  if (room.availabilityUnknown) return 'Availability unknown';
  if (room.missingFromSchedule) return 'Not in current schedule';
  if (room.matches_requested_window === false) return 'Does not match requested window';
  if (room.matches_requested_window === true) return 'Matches requested window';
  return 'Requested-window match unknown';
}

function renderRoomsGrid(rooms) {
  const container = $('rooms-container');
  if (!container) return;
  updateSavedFilterButtons();
  setText('rooms-heading', state.savedOnly ? 'SAVED ROOMS' : 'AVAILABLE ROOMS');
  const chips = $('building-filter');
  if (chips) chips.style.display = state.savedOnly ? 'none' : 'flex';
  const visibleRooms = state.savedOnly ? savedRooms() : rooms;
  const noun = state.savedOnly ? 'saved room' : 'room';
  setText('grid-count', `${visibleRooms.length} ${noun}${visibleRooms.length === 1 ? '' : 's'}${state.savedOnly ? ' · independent of building/duration filters' : ' matching'}`);
  container.replaceChildren();
  if (!visibleRooms.length) {
    const empty = textElement('div', state.savedOnly ? 'No saved rooms yet' : 'No rooms match this query.', 'grid-column:1/-1;padding:32px 4px;color:var(--muted);text-align:center');
    empty.appendChild(textElement('div', state.savedOnly ? 'Tap ★ on any room to save it.' : 'Try adjusting filters or checking a different time.', 'font-size:12px;margin-top:8px'));
    container.appendChild(empty); return;
  }
  pinSort(visibleRooms).forEach(room => {
    const cs = roomCardStatus(room), pinned = isPinned(room.building,room.room);
    const key = JSON.stringify([room.building, String(room.room)]);
    const card = document.createElement('div');
    card.className = 'interactive' + (cs.kind === 'busy' ? ' room-card-busy' : '');
    card.dataset.roomKey = key;
    card.dataset.focusKey = `rooms:${key}`;
    card.style.cssText = `background:var(--raised);border:1px solid ${cs.border};padding:14px;border-radius:2px;position:relative;cursor:pointer`;
    card.title = `${room.building}-${room.room} · tap for schedule`;
    makeActivatable(card, `${buildingName(room.building)} room ${room.room}, ${roomStatus(room).text}. ${suitabilityLabel(room)}. Open schedule.`, () => openRoomDetail(room.building,room.room));
    const header = textElement('div', '', 'display:flex;align-items:center;justify-content:space-between;gap:8px');
    header.appendChild(textElement('span', room.building, 'font-size:11px;color:var(--muted);overflow-wrap:anywhere'));
    const pin = textElement('button', pinned ? '★' : '☆', `color:${pinned ? 'var(--free)' : 'var(--muted)'};background:none;border:none;padding:8px;font-size:17px;cursor:pointer`);
    pin.type = 'button'; pin.dataset.focusKey = `pin:${key}`;
    pin.setAttribute('aria-pressed', String(pinned));
    pin.setAttribute('aria-label', `${pinned ? 'Unpin' : 'Pin'} ${room.building} ${room.room}`);
    pin.addEventListener('click', event => { event.stopPropagation(); togglePin(room.building,room.room); });
    pin.addEventListener('keydown', event => event.stopPropagation());
    header.appendChild(pin); card.appendChild(header);
    card.appendChild(textElement('div', room.room, 'font-family:"Space Grotesk",sans-serif;font-size:26px;font-weight:800;color:var(--text);overflow-wrap:anywhere'));
    if (room.capacity) card.appendChild(textElement('div', `Schedule capacity ${room.capacity}`, 'font-size:10px;color:var(--muted)'));
    const status = textElement('div', cs.label, `font-size:11px;font-weight:700;margin-top:12px;color:${cs.color}`);
    card.appendChild(status);
    if (cs.timeText) card.appendChild(textElement('div', cs.timeText, 'font-size:12px;color:var(--text);margin-top:4px'));
    card.appendChild(textElement('div', suitabilityLabel(room), 'font-size:11px;color:var(--muted);margin-top:6px'));
    container.appendChild(card);
  });
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
    btn.dataset.focusKey = `building-filter:${value}`;
    btn.addEventListener('click', () => {
      state.building = value;
      const gs = $('global-search');
      if (gs) gs.value = '';
      syncSearchInputs('', 'global-search');
      hideSearchPanel();
      renderBuildingChips(buildings);
      fetchRooms();
      syncURL();
    });
    return btn;
  };
  container.appendChild(makeChip('ALL', ''));
  buildings.forEach(b => container.appendChild(makeChip(`${b.building} (${b.matching_rooms ?? b.empty_rooms})`, b.building)));
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

// `interactive:false` is for the home hero, whose markers must not respond to
// clicks: the hero is wrapped in a single button that opens the full Map, and
// Leaflet does not stop native DOM propagation, so a clickable pin would open
// the building panel AND bubble to the button, switching the view underneath.
function updateBuildingMarkers(map, markersObj, buildings, { interactive = true } = {}) {
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
      radius:18, fillColor:color, color:'#fff', weight:2, fillOpacity:0.65,
      interactive
    }).addTo(map);
    // Code above the circle, count below it, so neither covers the other.
    const labelNode = textElement('div', '', 'display:flex;flex-direction:column;align-items:center;justify-content:space-between;height:68px;pointer-events:none;text-shadow:0 1px 4px rgba(0,0,0,0.9)');
    labelNode.appendChild(textElement('div', b.building, 'font-size:12px;line-height:14px;font-weight:800;color:#fff'));
    labelNode.appendChild(textElement('div', `${b.empty_rooms} free`, 'font-size:12px;line-height:14px;font-weight:700;color:#fff;background:rgba(0,0,0,0.78);padding:0 6px;border-radius:7px;white-space:nowrap'));
    const label = L.marker(coords, {
      icon: L.divIcon({html:labelNode, className:'', iconSize:[70,68], iconAnchor:[35,34]}),
      interactive:false, zIndexOffset:1000
    }).addTo(map);
    if (interactive) {
      circle.on('click', () => openBuildingPanel(b));
      circle.on('mouseover', function(){ this.setStyle({fillOpacity:0.85, radius:22}); });
      circle.on('mouseout',  function(){ this.setStyle({fillOpacity:0.65, radius:18}); });
    }
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

// The home hero map. Deliberately inert: dragging and zoom are disabled so
// it cannot capture the page's scroll on a touch device, and the whole hero
// is a single tap target that opens the full Map view.
function initHomeHeroMap() {
  if (state.dashMap) return;
  const el = $('home-hero-map');
  if (!el) return;
  state.dashMap = L.map('home-hero-map', {
    center: [40.7424, -74.1779], zoom: 16,
    zoomControl: false,
    scrollWheelZoom: false,
    dragging: false,
    doubleClickZoom: false,
    boxZoom: false,
    keyboard: false,
    touchZoom: false,
    attributionControl: false,
  });
  makeTileLayers(state.dashMap);
  if (state.buildingsData.length) {
    updateBuildingMarkers(state.dashMap, state.dashMarkers, state.buildingsData, { interactive: false });
  }
}

// Construct the hero map if needed (the guard inside initHomeHeroMap()
// prevents double-construction), then always re-measure it. A re-measure is
// needed on every call, not just the first: if a deep link lands on another
// view first, #view-dashboard is display:none while initHomeHeroMap() runs,
// so its container has zero size and any invalidateSize() at that point is a
// no-op. Called from both switchView()'s dashboard branch and init() so the
// two paths can't drift apart again.
function showHomeHeroMap() {
  initHomeHeroMap();
  // A Leaflet map sized by the layout renders blank until it re-measures.
  setTimeout(() => { if (state.dashMap) state.dashMap.invalidateSize(); }, 60);
}

function updateHomeHeroStat(buildings) {
  const free = buildings.reduce((s, b) => s + b.empty_rooms, 0);
  setText('home-hero-stat', free === 1 ? '1 room free' : `${free} rooms free`);
}

// ── Building panel ──────────────────────────────────────────────────────────
function openBuildingPanel(buildingData) {
  const panel = $('floor-panel');
  if (!panel) return;
  const changed = state.openBuilding !== buildingData.building;
  state.openBuilding = buildingData.building;
  panel.style.transform = 'translateX(0)';
  if (changed && $('panel-search')) $('panel-search').value = '';
  renderOpenBuilding();
  panel.setAttribute('aria-label', `Building ${buildingData.building}`);
  overlays.open('floor-panel', closeFloorPanel, '[aria-label="Close building panel"]');
  refresh();
}

function renderOpenBuilding() {
  const code = state.openBuilding;
  if (!code) return;
  const data = state.buildingsData.find(building => building.building === code);
  setText('panel-building', code);
  setText('ps-free', data?.empty_rooms ?? '—');
  setText('ps-busy', data?.occupied_rooms ?? '—');
  setText('ps-total', data?.total_rooms ?? '—');
  state.floorRoomsData = searchRoomSource().filter(room => room.building === code);
  renderRoomsByFloor(state.floorRoomsData);
  filterFloorRooms($('panel-search')?.value || '');
  renderHeatmap(state.snapshot?.buildingKey === code ? state.snapshot.heatmap : null);
}

function closeFloorPanel() {
  state.openBuilding = '';
  const panel = $('floor-panel');
  if (panel) panel.style.transform = 'translateX(100%)';
  overlays.close('floor-panel');
}

// Preserve the existing weekly view, using bounded snapshot data and DOM titles.
function renderHeatmap(data) {
  const wrap = $('panel-heatmap');
  if (!wrap) return;
  wrap.replaceChildren();
  if (!data || !Array.isArray(data.days) || !Array.isArray(data.hours)) {
    wrap.textContent = 'Weekly schedule unavailable.'; return;
  }
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const grid = document.createElement('div');
  grid.style.cssText = `display:grid;grid-template-columns:26px repeat(${data.hours.length},1fr);gap:2px;align-items:center`;
  grid.appendChild(document.createElement('div'));
  data.hours.forEach(hour => grid.appendChild(textElement('div', [7,12,17,21].includes(hour) ? (hour % 12 || 12) + (hour < 12 ? 'a' : 'p') : '', 'font-size:8px;color:var(--muted)')));
  data.days.forEach((counts, day) => {
    if (!Array.isArray(counts) || (day >= 5 && counts.every(count => count === 0))) return;
    grid.appendChild(textElement('div', days[day], 'font-size:9px;color:var(--muted)'));
    counts.forEach((count, hour) => {
      const fraction = data.total_rooms ? Math.max(0,Math.min(1,Number(count) / data.total_rooms)) : 0;
      const cell = textElement('div', '', `height:12px;border-radius:1px;background:${fraction === 0 ? 'rgba(63,255,139,0.07)' : `rgba(255,113,102,${0.15 + 0.75 * fraction})`}`);
      cell.className = 'heatmap-cell';
      cell.title = `${days[day]} ${data.hours[hour]}:00: ${count}/${data.total_rooms} rooms busy`;
      grid.appendChild(cell);
    });
  });
  wrap.appendChild(grid);
  wrap.appendChild(textElement('div', 'Quiet → Busy · hover for scheduled room counts', 'font-size:9px;color:var(--muted);margin-top:6px'));
}

// Floor used only to group tiles inside the building panel. A recorded floor
// wins; otherwise fall back to the room number (first digit; G/B prefixes are
// ground). Floor *search* still ignores this and matches recorded floors only.
function panelFloor(room) {
  if (Number.isInteger(room.floor)) return room.floor;
  const id = String(room.room).toUpperCase();
  if (id.startsWith('G') || id.startsWith('B')) return 0;
  const digit = id.match(/\d/);
  return digit ? Number(digit[0]) : 1;
}

// Rooms grouped by floor. In-use rooms stay visible but dimmed — hiding them
// leaves a suspiciously short list with no sense of the building's size.
function renderRoomsByFloor(rooms) {
  const container = $('floor-rooms');
  if (!container) return;
  container.textContent = '';

  const floors = [...new Set(rooms.map(panelFloor))].sort((a, b) => a - b);
  const frag = document.createDocumentFragment();

  floors.forEach(floor => {
    const onFloor = rooms.filter(r => panelFloor(r) === floor);
    const freeCount = onFloor.filter(r => {
      const kind = roomStatus(r).kind;
      return kind === 'free' || kind === 'soon';
    }).length;

    const head = document.createElement('div');
    head.dataset.floorHead = floor;
    head.style.cssText = 'grid-column:1/-1;display:flex;align-items:center;gap:10px;margin-top:8px';
    head.appendChild(groupLabel(floor === 0 ? 'Ground floor' : `Floor ${floor}`));
    const rule = document.createElement('span');
    rule.style.cssText = 'flex:1;height:1px;background:var(--hairline-soft)';
    head.appendChild(rule);
    const cnt = document.createElement('span');
    cnt.className = 'label';
    cnt.style.cssText = 'color:var(--free)';
    cnt.textContent = `${freeCount} free`;
    head.appendChild(cnt);
    frag.appendChild(head);

    onFloor.forEach(room => {
      const st = roomStatus(room);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.room = room.room;
      btn.dataset.focusKey = `floor:${JSON.stringify([room.building,room.room])}`;
      btn.dataset.floor = floor;
      btn.title = st.text;
      btn.setAttribute('aria-label',
        `Room ${room.room}, ${st.text}. Open schedule.`);
      const tone = st.kind === 'busy'
        ? 'opacity:0.5;border-color:var(--hairline-soft);background:var(--surface)'
        : st.kind === 'soon'
          ? 'border-color:rgba(245,158,11,0.32);background:rgba(245,158,11,0.06)'
          : 'border-color:rgba(63,255,139,0.3);background:rgba(63,255,139,0.06)';
      btn.style.cssText = 'display:flex;flex-direction:column;justify-content:center;gap:3px;' +
        'min-height:54px;padding:9px 10px;border-radius:6px;border:1px solid;cursor:pointer;' +
        'text-align:left;' + tone;
      btn.addEventListener('click', () => openRoomDetail(room.building, room.room));

      const num = document.createElement('div');
      num.style.cssText = "font-family:'Space Grotesk',sans-serif;font-size:15px;font-weight:700;" +
        'font-variant-numeric:tabular-nums;line-height:1;color:var(--text)';
      num.textContent = room.room;
      btn.appendChild(num);
      btn.appendChild(statusPill(room, true));
      frag.appendChild(btn);
    });
  });

  container.appendChild(frag);
}

// Whole-building room search. Filters room buttons across every floor
// section and hides any floor header whose rooms are all filtered out —
// otherwise the user is left staring at an empty "Floor 2 — 4 free" header.
// The free counts themselves always describe the full floor, not the
// filtered subset, so they never appear to change while typing.
function filterFloorRooms(query) {
  const container = $('floor-rooms');
  if (!container) return;
  const q = query.trim().toLowerCase();

  const floorsWithVisibleRoom = new Set();
  container.querySelectorAll('button[data-room]').forEach(btn => {
    const match = !q || btn.dataset.room.toLowerCase().includes(q);
    // Restore 'flex' explicitly: these buttons carry an inline display:flex
    // from renderRoomsByFloor, and setting display='' REMOVES that declaration
    // rather than restoring it, which would blockify every matching tile.
    btn.style.display = match ? 'flex' : 'none';
    if (match) floorsWithVisibleRoom.add(btn.dataset.floor);
  });

  container.querySelectorAll('[data-floor-head]').forEach(head => {
    head.style.display = floorsWithVisibleRoom.has(head.dataset.floorHead) ? 'flex' : 'none';
  });
}

// ── Settings ───────────────────────────────────────────────────────────────
let selectedFile = null;

async function fetchScheduleInfo() {
  if (state.snapshot) renderScheduleInfo(state.snapshot.info);
  else return fetchAllRoomsCache();
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
  form.append('password', $('upload-password')?.value || '');
  if ($('upload-password')) $('upload-password').value = '';
  try {
    const {data} = await reliability.request('/api/upload-schedule', {method:'POST',body:form,timeoutMs:120000});
    clearFileSelection();
    showUploadStatus('success', `Schedule loaded — ${data.entries?.toLocaleString() || 0} entries. Refreshing availability…`);
    await refresh();
    await loadExportTerms().catch(() => {});
  } catch (error) {
    const uncertain = ['timeout','offline'].includes(error.kind) || [502,504].includes(error.status) || (error.kind === 'error' && !error.status);
    showUploadStatus('error', uncertain ? 'The upload outcome could not be confirmed and may have been applied. Check the current schedule before uploading again.' : error.message);
  } finally {
    if (btn) { btn.disabled = !selectedFile; btn.textContent = 'Upload & Apply Schedule'; }
  }
}

let exportTermsGeneration = 0;
async function loadExportTerms() {
  const generation = ++exportTermsGeneration;
  const select = $('export-term');
  setText('export-term-status', 'Loading stored semesters…');
  try {
    const {data} = await reliability.request('/api/terms', {cache:'no-store'});
    if (!Array.isArray(data)) throw new Error('Stored semester information is unavailable.');
    const terms = data.filter(item => Number.isInteger(item.term) && item.term > 0);
    if (generation !== exportTermsGeneration) return terms;
    if (select) {
      const previous = select.value;
      select.replaceChildren();
      terms.forEach(item => {
        const option = textElement('option', `${item.semester || item.term} · ${item.filename || 'stored schedule'}`);
        option.value = String(item.term); select.appendChild(option);
      });
      select.value = String(terms.find(item => String(item.term) === previous)?.term || terms.find(item => item.active)?.term || terms[0]?.term || '');
      select.disabled = !terms.length;
    }
    setText('export-term-status', terms.length ? 'Export uses the selected stored semester and original file format.' : 'No stored schedule to export. Upload a valid schedule first.');
    return terms;
  } catch (error) {
    if (generation === exportTermsGeneration) setText('export-term-status', error.message);
    throw error;
  }
}

async function exportSchedule() {
  const btn = $('export-btn');
  if (btn) btn.disabled = true;
  const password = ($('upload-password')?.value || '').trim();
  if ($('upload-password')) $('upload-password').value = '';
  try {
    const terms = await loadExportTerms();
    const term = terms.find(item => String(item.term) === $('export-term')?.value);
    if (!term) { showUploadStatus('error', 'No stored schedule to export. Upload a valid schedule first.'); return; }
    const {data, filename} = await reliability.request('/api/export-schedule?' + new URLSearchParams({term:term.term}), {
      headers: {Authorization: `Bearer ${password}`}, responseType:'blob', cache:'no-store', timeoutMs:60000,
    });
    const url = URL.createObjectURL(data);
    const link = document.createElement('a');
    link.href = url; link.download = filename || term.filename || 'schedule-download';
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showUploadStatus('success', 'Schedule exported. Password was not saved.');
  } catch (error) { showUploadStatus('error', error.message); }
  finally { if (btn) btn.disabled = false; }
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

// ── Saved room filter ─────────────────────────────────────────────────────
function updateSavedFilterButtons() {
  const all = $('rooms-all-btn');
  const saved = $('saved-rooms-btn');
  const active = 'background:#3fff8b;color:#005d2c;border-color:#3fff8b';
  const inactive = 'background:transparent;color:#adaaaa;border-color:rgba(255,255,255,0.08)';
  if (all) {
    all.setAttribute('aria-pressed', state.savedOnly ? 'false' : 'true');
    all.style.cssText = state.savedOnly ? inactive : active;
  }
  if (saved) {
    saved.setAttribute('aria-pressed', state.savedOnly ? 'true' : 'false');
    saved.style.cssText = state.savedOnly ? active : inactive;
  }
}

async function setSavedOnly(enabled) {
  state.savedOnly = enabled;
  updateSavedFilterButtons();
  // Populate the every-room cache before rendering, or the first click on
  // Saved shows the empty state for a moment even when rooms are saved.
  if (enabled) await fetchAllRoomsCache();
  renderRoomsGrid(state.lastRoomsData);
  syncURL();
  announce(enabled ? 'Showing saved rooms.' : 'Showing all available rooms.');
}

function toggleSavedOnly() {
  setSavedOnly(!state.savedOnly);
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
// The pin control on the detail sheet is the only way to pin a room from the
// Home -> building -> room path; the room-grid cards are the other entry point.
function renderDetailPin() {
  const btn = $('rds-pin');
  const icon = $('rds-pin-icon');
  if (!btn || !icon || !state.detailRoom) return;
  const [b, r] = splitDetailRoom(state.detailRoom);
  const on = isPinned(b, r);
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  btn.title = on ? 'Unpin this room' : 'Pin this room';
  icon.textContent = on ? 'star' : 'star_outline';
  icon.style.color = on ? 'var(--free)' : '';
}

function splitDetailRoom(key) {
  if (state.detailIdentity?.key === key) return [state.detailIdentity.building, state.detailIdentity.room];
  const i = key.indexOf('-');
  return [key.slice(0, i), key.slice(i + 1)];
}

function toggleDetailPin() {
  if (!state.detailRoom) return;
  const [b, r] = splitDetailRoom(state.detailRoom);
  togglePin(b, r);
  renderDetailPin();
}

function showRoomDetail(building, room) {
  const sheet = $('room-detail-sheet');
  if (!sheet) return;
  setText('rds-building', `${building} · Room Detail`);
  setText('rds-room', room);
  setText('rds-status', 'Loading…');
  setText('rds-day', reliability.contextLabel(state.query));
  setText('rds-summary', '');
  setText('rds-list', 'Loading schedule…');
  setText('rds-timeline', '');
  $('room-free-window')?.classList.add('hidden');
  $('rds-capacity')?.classList.add('hidden');
  $('room-detail-backdrop')?.classList.remove('hidden');
  sheet.style.transform = 'translateY(0)';
  sheet.setAttribute('aria-label', `Room detail · ${building} ${room}`);
  overlays.open('room-detail-sheet', closeRoomDetail, '[aria-label="Close room detail"]');
  renderDetailPin();
}

function openRoomDetail(building, room) {
  const key = `${building}-${room}`;
  const changed = state.detailIdentity?.building !== building || state.detailIdentity?.room !== room;
  state.detailIdentity = { key, building, room };
  if (changed || state.detailRoom !== key || !state.detailData) {
    state.detailRoom = key;
    state.detailData = null;
    showRoomDetail(building, room);
  }
  syncURL();
  return refresh();
}

function closeRoomDetail() {
  const sheet    = $('room-detail-sheet');
  const backdrop = $('room-detail-backdrop');
  if (sheet)    sheet.style.transform = 'translateY(100%)';
  if (backdrop) backdrop.classList.add('hidden');
  const fwEl = $('room-free-window');
  if (fwEl) fwEl.classList.add('hidden');
  state.detailRoom = '';
  overlays.close('room-detail-sheet');
  syncURL();
}

function copyRoomLink() {
  navigator.clipboard.writeText(window.location.href).then(() => {
    const icon = $('rds-share-icon');
    if (icon) {
      icon.textContent = 'check';
      setTimeout(() => { icon.textContent = 'link'; }, 1500);
    }
  }).catch(() => prompt('Copy this link:', window.location.href));
}

function detailRoomFacts(data) {
  return { ...data, empty: !data.occupied_now,
    minutes_until_next: data.minutes_until_next !== undefined ? data.minutes_until_next :
      data.occupied_now ? null : data.next_class ? data.next_class.start_min - data.now_min : null };
}

function nextAvailabilityText(data) {
  if (Number.isFinite(data.available_from_min)) {
    const start = minToTime(data.available_from_min);
    return Number.isFinite(data.available_until_min)
      ? `Available ${start} – ${minToTime(data.available_until_min)} ET`
      : `Available from ${start} ET · no later scheduled classes`;
  }
  if (data.occupied_now) return 'In use. Next availability is not verified.';
  if (data.next_free_window?.start && data.next_free_window?.end) {
    return `Available ${data.next_free_window.start} – ${data.next_free_window.end} (${data.next_free_window.duration_mins} min)`;
  }
  return 'No more scheduled classes in this day’s schedule.';
}

function renderRoomDetail(data) {
  const facts = detailRoomFacts(data), st = roomStatusMeta(facts);
  const status = $('rds-status');
  if (status) {
    status.textContent = st.kind === 'busy' ? 'In use' : st.kind === 'soon' ? 'Closing soon' : st.text;
    status.style.cssText = `color:${st.color};padding:4px 12px;font-size:12px;font-weight:700`;
  }
  const query = state.snapshot?.query || state.query;
  setText('rds-day', reliability.contextLabel(query, state.snapshot?.meta.context, state.snapshot?.meta.offline));
  setText('rds-summary', `${data.classes.length} scheduled class${data.classes.length === 1 ? '' : 'es'} · ${suitabilityLabel(facts)}`);
  const cap = $('rds-capacity');
  if (cap) { cap.textContent = data.capacity ? `Schedule capacity ${data.capacity}` : ''; cap.classList.toggle('hidden', !data.capacity); }
  const timeline = $('rds-timeline');
  if (timeline) {
    timeline.replaceChildren();
    const dayStart = 7 * 60, span = 15 * 60;
    data.classes.forEach(cls => {
      const left = Math.max(0, Math.min(100, (cls.start_min - dayStart) / span * 100));
      const right = Math.max(left, Math.min(100, (cls.end_min - dayStart) / span * 100));
      const mark = textElement('div', '', `position:absolute;top:0;bottom:0;left:${left}%;width:${right-left}%;background:${cls.is_current ? '#ff7166bb' : '#ff716640'};border-right:1px solid rgba(255,113,102,0.2)`);
      mark.title = `${cls.course || 'Class'} · ${minToTime(cls.start_min)} – ${minToTime(cls.end_min)}`;
      timeline.appendChild(mark);
    });
    if (Number.isFinite(data.now_min)) {
      const percent = Math.max(0, Math.min(100, (data.now_min - dayStart) / span * 100));
      const marker = textElement('div', '', `position:absolute;top:0;bottom:0;left:${percent}%;width:2px;background:var(--free);z-index:2`);
      marker.title = `Query time ${minToTime(data.now_min)} ET`;
      timeline.appendChild(marker);
    }
  }
  const list = $('rds-list');
  if (list) {
    list.replaceChildren();
    if (!data.classes.length) list.appendChild(textElement('div', `No recurring classes scheduled for this room on ${data.weekday}. Room access is not guaranteed.`, 'padding:24px;color:var(--muted);font-size:14px'));
    data.classes.forEach(cls => {
      const row = textElement('div', '', 'padding:12px 14px;background:var(--raised);border:1px solid var(--hairline-soft);border-radius:2px');
      row.appendChild(textElement('div', cls.is_current ? 'In session at selected time' : 'Scheduled class', `font-size:11px;color:${cls.is_current ? 'var(--busy)' : 'var(--muted)'}`));
      row.appendChild(textElement('div', `${minToTime(cls.start_min)} – ${minToTime(cls.end_min)} ET`, 'font-size:14px;color:var(--text);margin-top:4px'));
      if (cls.course || cls.title) row.appendChild(textElement('div', [cls.course, cls.title].filter(Boolean).join(' · '), 'font-size:13px;color:var(--text);margin-top:4px;overflow-wrap:anywhere'));
      if (cls.instructor) row.appendChild(textElement('div', cls.instructor, 'font-size:12px;color:var(--muted);margin-top:4px'));
      list.appendChild(row);
    });
  }
  setText('room-free-window-text', nextAvailabilityText(data));
  $('room-free-window')?.classList.remove('hidden');
}

// ── Geolocation: rank rooms by how far you have to walk ─────────────────────
// A commuter with a gap wants the closest free room, not the one with the
// most hours left on the far side of campus. BUILDING_COORDS already has
// every building, so this is a straight distance sort.
function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000, toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Distance to a building. Unlike "closest room", this is exact for the home
// grid: the grid IS building-level, so the label is literally true here.
function buildingDistanceMeters(code) {
  if (!state.userPos) return null;
  const c = BUILDING_COORDS[code];
  if (!c) return null;
  return haversineMeters(state.userPos.lat, state.userPos.lon, c[0], c[1]);
}

function roomDistanceMeters(room) {
  if (!state.userPos) return null;
  const c = BUILDING_COORDS[room.building];
  if (!c) return null;
  return haversineMeters(state.userPos.lat, state.userPos.lon, c[0], c[1]);
}

// Haversine gives a straight-line distance. Campus paths, crossings and
// building entrances make a walk about 40% longer on average. Keep the
// correction on time only: the metres are still a measured straight-line
// distance, while the walk estimate reflects the route a person takes.
const WALKING_PATH_TIME_FACTOR = 1.4;
const WALKING_METERS_PER_SECOND = 1.35;

function formatDistance(straightLineMeters) {
  if (straightLineMeters === null || straightLineMeters === undefined) return '';
  if (straightLineMeters < 50) return 'under 50 m away';
  if (straightLineMeters >= 1000) return `${(straightLineMeters / 1000).toFixed(1)} km away`;
  const mins = Math.max(1, Math.ceil(
    straightLineMeters / WALKING_METERS_PER_SECOND / 60 * WALKING_PATH_TIME_FACTOR
  ));
  return `${Math.round(straightLineMeters)} m · ${mins} min walk`;
}

function setGeoStatus(msg, color) {
  const el = $('fr-geo-status');
  if (!el) return;
  if (!msg) { el.classList.add('hidden'); return; }
  el.textContent = msg;
  el.style.color = color || '#767575';
  el.classList.remove('hidden');
}

// How trustworthy is a distance ranking at this GPS accuracy?
// Calibrated against the real campus, not taste: NJIT's 18 buildings span
// 465 m, with a median gap of 177 m between them. 50 m is under a third of
// that median, so ordering holds. Past 150 m the error approaches the whole
// campus and the ranking would be noise dressed up as an answer.
function locationQuality(accuracyMeters) {
  const a = Number(accuracyMeters);
  if (!Number.isFinite(a) || a <= 0) {
    return { tier: 'unusable', message: "Your device didn't report how accurate its location is, so rooms aren't ranked by distance." };
  }
  if (a <= 50) return { tier: 'good', message: '' };
  if (a <= 150) {
    return { tier: 'coarse', message: `Location accurate to ±${Math.round(a)} m — nearby buildings may be out of order.` };
  }
  return { tier: 'unusable', message: `Location only accurate to ±${Math.round(a)} m, which is too coarse to rank by distance on this campus.` };
}

// A cached fix goes stale as the user walks. Campus is 465 m end to end, and
// at ~1.35 m/s a two-minute-old position can already be ~160 m wrong — about
// the median gap between buildings, i.e. enough to invert the ranking.
const POSITION_MAX_AGE_MS = 120000;

function isPositionStale(pos, nowMs) {
  if (!pos || !Number.isFinite(pos.at)) return true;
  return (nowMs - pos.at) > POSITION_MAX_AGE_MS;
}

function requestLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('unsupported'));
    navigator.geolocation.getCurrentPosition(
      pos => {
        state.userPos = {
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          // Kept so callers can judge whether a ranking is honest. Previously
          // discarded, which made a +/-8 m fix and a +/-90 m fix look identical.
          accuracy: pos.coords.accuracy,
          // Captured so a fix cached earlier in the session cannot be reused
          // indefinitely after the user has walked somewhere else.
          at: Date.now(),
        };
        resolve(state.userPos);
      },
      err => reject(err),
      // 60s of cached position is ~80 m of walking on a 465 m campus — enough
      // to silently corrupt the ranking the user just asked for.
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 10000 }
    );
  });
}

function _updateSortButtons() {
  const on  = 'border:1px solid #3fff8b;background:rgba(63,255,139,0.12);color:#3fff8b';
  const off = 'border:1px solid rgba(255,255,255,0.08);background:transparent;color:#adaaaa';
  const t = $('fr-sort-time'), d = $('fr-sort-distance');
  if (t) t.style.cssText = state.frSort === 'time' ? on : off;
  if (d) d.style.cssText = (state.frSort === 'distance' ? on : off) +
                           ';display:flex;align-items:center;justify-content:center;gap:6px';
}

async function setFindRoomSort(mode) {
  if (mode === 'distance') {
    if (!state.userPos || isPositionStale(state.userPos, Date.now())) {
      setGeoStatus('Getting your location…', '#767575');
      try {
        await requestLocation();
        setGeoStatus('');
      } catch (err) {
        const msg = err && err.code === 1
          ? 'Location permission denied — sorting by free time instead.'
          : 'Could not get your location — sorting by free time instead.';
        setGeoStatus(msg, '#f59e0b');
        state.frSort = 'time';
        _updateSortButtons();
        renderFindRoom(state.frLastRooms);
        return;
      }
    }
    // A fix too coarse to separate buildings must not be dressed up as a
    // ranking — fall back rather than present noise as an answer.
    const q = locationQuality(state.userPos.accuracy);
    if (q.tier === 'unusable') {
      setGeoStatus(q.message + ' Sorting by free time instead.', 'var(--soon)');
      state.frSort = 'time';
      _updateSortButtons();
      renderFindRoom(state.frLastRooms);
      return;
    }

    // Off campus, distance ranking is meaningless.
    const far = haversineMeters(state.userPos.lat, state.userPos.lon, 40.7424, -74.1779) > 3000;
    if (far) setGeoStatus("You look far from campus — distances are from NJIT's Newark campus.", '#f59e0b');
    else if (q.tier === 'coarse') setGeoStatus(q.message, 'var(--soon)');
    else setGeoStatus('');
  }
  state.frSort = mode;
  _updateSortButtons();
  renderFindRoom(state.frLastRooms);
}

// ── Find Me a Room ───────────────────────────────────────────────────────────


function openFindRoom() {
  const modal = $('find-room-modal');
  if (!modal) return;
  modal.classList.remove('hidden');
  syncQueryInputs();
  if (state.snapshot) renderFindRoom(state.allRoomsData);
  else setText('fr-results', 'Loading schedule…');
  overlays.open('find-room-modal', closeFindRoom, '[aria-label="Close find a room"]');
  renderDataStatus();
  fetchAllRoomsCache();
}

function closeFindRoom() {
  $('find-room-modal')?.classList.add('hidden');
  overlays.close('find-room-modal');
}

function applyGapWindow() {
  const until = $('fr-gap-until')?.value || '';
  if (!until) { setText('fr-gap-error', 'Choose an end time.'); return; }
  commitQuery({ ...state.query, at: $('fr-gap-from')?.value || '', until }, 'fr-gap-error');
}

function clearGapWindow() {
  setText('fr-gap-error', '');
  commitQuery({ ...state.query, until: '' }, 'fr-gap-error');
}

function renderFindRoom(rooms) {
  const source = rooms || state.allRoomsData;
  state.frLastRooms = source;
  const filtered = state.building ? source.filter(r => r.building === state.building) : source;
  const query = state.snapshot?.query || state.query;
  const label = $('fr-gap-label');
  if (label) { label.textContent = query.until ? `${filtered.length} rooms match ${reliability.contextLabel(query, state.snapshot?.meta.context, state.snapshot?.meta.offline)}` : ''; label.classList.toggle('hidden', !query.until); }

  let sorted;
  if (state.frSort === 'distance' && state.userPos) {
    // Closest first; rooms in buildings we have no coordinates for sink to
    // the bottom rather than sorting as if they were at distance zero.
    sorted = [...filtered].sort((a, b) => {
      const da = roomDistanceMeters(a), db = roomDistanceMeters(b);
      if (da === null && db === null) return 0;
      if (da === null) return 1;
      if (db === null) return -1;
      return da - db;
    });
  } else {
    // Free all day first, then by most minutes remaining
    sorted = [...filtered].sort((a, b) => {
      if (a.minutes_until_next === null && b.minutes_until_next === null) return 0;
      if (a.minutes_until_next === null) return -1;
      if (b.minutes_until_next === null) return 1;
      return b.minutes_until_next - a.minutes_until_next;
    });
  }
  _updateSortButtons();

  // Building chips
  const chipsEl = $('fr-building-chips');
  if (chipsEl) {
    chipsEl.innerHTML = '';
    const makeChip = (label, val) => {
      const btn = document.createElement('button');
      const active = state.building === val;
      btn.style.cssText = `flex-shrink:0;padding:5px 12px;font-family:'Space Grotesk',sans-serif;font-size:10px;font-weight:700;border-radius:2px;text-transform:uppercase;letter-spacing:0.1em;cursor:pointer;border:1px solid ${active?'#3fff8b':'rgba(255,255,255,0.08)'};background:${active?'#3fff8b':'transparent'};color:${active?'#005d2c':'#adaaaa'};transition:all 0.15s`;
      btn.textContent = label;
      btn.dataset.focusKey = `finder-building:${val}`;
      btn.addEventListener('click', () => commitQuery({ ...state.query, building: val }));
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
    const isSoon = isClosingSoon(room);
    const color  = isSoon ? STATUS_HEX.soon : STATUS_HEX.free;
    const row = document.createElement('div');
    row.className = 'interactive';
    row.style.cssText = `display:flex;align-items:center;gap:14px;padding:13px 14px;background:rgba(63,255,139,0.03);border:1px solid rgba(63,255,139,0.07);border-radius:2px;cursor:pointer;transition:background 0.15s;min-height:56px`;
    row.onmouseover = () => { row.style.background = 'rgba(63,255,139,0.08)'; };
    row.onmouseout  = () => { row.style.background = 'rgba(63,255,139,0.03)'; };
    makeActivatable(row, `${buildingName(room.building)} room ${room.room}, ${formatTime(room.minutes_until_next)} free. Open schedule.`,
                    () => openRoomDetail(room.building, room.room));
    // Same gate as the buildings grid: a fix too coarse to rank with is too
    // coarse to print "304 m - 4 min walk" from.
    const usable = state.userPos && !isPositionStale(state.userPos, Date.now()) && locationQuality(state.userPos.accuracy).tier !== 'unusable';
    const dist = usable ? roomDistanceMeters(room) : null;
    row.dataset.roomKey = JSON.stringify([room.building,room.room]);
    row.dataset.focusKey = `finder:${row.dataset.roomKey}`;
    row.appendChild(textElement('div', `#${i+1}`, 'font-size:12px;color:var(--muted)'));
    const name = textElement('div', buildingLabel(room.building), 'flex:1;min-width:0;font-size:11px;color:var(--muted);overflow-wrap:anywhere');
    name.title = buildingName(room.building);
    name.appendChild(textElement('div', room.room, 'font-size:19px;font-weight:800;color:var(--text)'));
    if (dist !== null) name.appendChild(textElement('div', formatDistance(dist), 'font-size:11px;color:var(--muted);margin-top:3px'));
    row.appendChild(name);
    row.appendChild(statusPill(room));
    frag.appendChild(row);
  });
  res.appendChild(frag);
}

// ── Semester label ─────────────────────────────────────────────────────────
function renderScheduleInfo(d) {
  if (!d) return;
  setText('si-entries', d.entries?.toLocaleString() ?? 'Unknown');
  setText('si-buildings', d.buildings ?? 'Unknown');
  setText('si-rooms', d.rooms ?? 'Unknown');
  setText('si-filename', d.filename || 'Unknown');
  setText('si-loaded', d.imported_at ? displayTimestamp(d.imported_at) : 'Import time unknown');
  setText('footer-semester', d.semester || 'Semester unknown');
  setText('dash-semester', d.semester || 'Semester unknown');
  const status = d.status || (d.stale === true ? 'stale' : 'unknown');
  $('stale-data-banner')?.classList.toggle('hidden', status !== 'stale');
  setText('stale-banner-loaded', d.semester || 'an older semester');
  setText('stale-banner-expected', d.expected_semester || 'the current term');
  const future = status === 'future' || (status === 'current' && d.in_session === false);
  $('future-data-banner')?.classList.toggle('hidden', !future);
  setText('future-banner-title', status === 'future' ? `Showing ${d.semester || 'an upcoming semester'}` : 'Campus is between sessions');
  setText('future-banner-body', 'Availability follows the imported recurring class pattern. Actual room access and calendar exceptions are not verified.');
  const queryDay = state.snapshot?.meta.context?.day;
  const infoDay = d.weekday || (state.snapshot?.infoFetchedAt ? reliability.campusTime(new Date(state.snapshot.infoFetchedAt)).day : null);
  const noClasses = Boolean(queryDay && queryDay === infoDay && d.has_classes_today === false);
  ['no-classes-banner', 'dash-no-classes-banner'].forEach(id => $(id)?.classList.toggle('hidden', !noClasses));
  setText('no-classes-banner-day', queryDay || 'Day unknown');
  setText('dash-no-classes-banner-day', queryDay || 'Day unknown');
  setText('schedule-day-fact', queryDay && queryDay === infoDay && typeof d.has_classes_today === 'boolean'
    ? (d.has_classes_today ? `Classes are scheduled on ${queryDay}.` : `No recurring classes scheduled on ${queryDay}.`)
    : 'Day-level schedule information is unknown.');
}

// Close overlays on Escape; press / to focus search
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (isSearchPanelOpen()) {
      closeSearchUI({ clear: false });
      return;
    }
  }
  if (e.key === '/' && !overlays.active() && !['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)) {
    e.preventDefault();
    const search = $('global-search');
    if (search) search.focus();
  }
});

// ── Countdown ──────────────────────────────────────────────────────────────
const REFRESH_INTERVAL_MS = 60_000;
let nextRefreshAt = Date.now() + REFRESH_INTERVAL_MS;

function updateCountdown() {
  const secsLeft = Math.max(0, Math.ceil((nextRefreshAt - Date.now()) / 1000));
  if (['window-ended', 'invalid'].includes(state.requestState)) { setText('refresh-countdown', 'Adjust query to refresh'); return; }
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
function preserveFocus(render) {
  const active = document.activeElement;
  const key = active?.dataset?.focusKey;
  render();
  if (key && !active.isConnected) {
    const replacement = Array.from(document.querySelectorAll('[data-focus-key]')).find(el => el.dataset.focusKey === key);
    replacement?.focus({ preventScroll: true });
  }
}

function displayTimestamp(stamp) {
  return stamp ? new Date(stamp).toLocaleString('en-US', {
    timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  }) + ' ET' : 'Retrieval time unknown';
}

let lastScheduleAnnouncement = '';
function renderDataStatus() {
  const snapshot = state.snapshot;
  const phase = state.requestState;
  const terminal = ['invalid', 'window-ended'].includes(phase);
  if (terminal && state.detailRoom && !state.detailData) {
    setText('rds-status', 'Query needs editing');
    setText('rds-list', `${state.requestError} Use Edit filters to choose a valid query.`);
    $('room-free-window')?.classList.add('hidden');
  }
  document.querySelectorAll('[data-surface-edit]').forEach(el => el.classList.toggle('hidden', !terminal));
  const retained = snapshot && !['success', 'empty'].includes(phase);
  let message = phase === 'loading' ? 'Loading schedule…' : phase === 'refreshing' ? 'Refreshing — previous results retained.' :
    phase === 'offline' ? (snapshot ? 'Last-known schedule — offline.' : 'Offline — no verified cached schedule.') + (state.requestError ? ` ${state.requestError}` : '') :
    state.requestError || (phase === 'unverified' ? 'Schedule received, but availability context is unverified. Retry after the service is updated.' :
      phase === 'empty' ? 'No rooms in this schedule.' : '');
  if (snapshot) message += `${message ? ' ' : ''}${retained ? 'Last known: ' : 'Updated: '}${displayTimestamp(snapshot.meta.fetchedAt)}.`;
  if (snapshot && !snapshot.meta.verified) message += ' Schedule version/query context is unverified.';
  const context = snapshot ? reliability.contextLabel(snapshot.query, snapshot.meta.context, snapshot.meta.offline) :
    phase === 'invalid' ? 'Invalid query · correct the filters' : reliability.contextLabel(state.query);
  setText('query-context', context);
  setText('applied-query', `${reliability.contextLabel(state.query)}${state.freeAllDay ? ' · No more scheduled classes' : ''} · Closing soon ≤ ${state.soonThresholdMins} min`);
  if (snapshot && reliability.queryParams(snapshot.query, true).toString() !== filterParams({building:true}).toString()) {
    message += ` Requested ${reliability.contextLabel(state.query)}; shown results still use the previous query.`;
  }
  const status = $('data-status');
  if (status) status.dataset.state = phase;
  setText('data-status-text', message);
  const retry = !['loading', 'refreshing', 'success', 'empty', 'window-ended', 'invalid'].includes(phase);
  $('data-retry')?.classList.toggle('hidden', !retry);
  $('data-edit-query')?.classList.toggle('hidden', !['invalid', 'window-ended'].includes(phase));
  document.querySelectorAll('[data-surface-status]').forEach(el => { el.textContent = `${context} · ${message}`; });
  document.querySelectorAll('[data-surface-retry]').forEach(el => { el.classList.toggle('hidden', !retry); });
  const mode = phase === 'unverified' ? 'Unverified schedule' : phase === 'offline' ? (snapshot ? 'Offline · Last known' : 'Offline · Schedule not loaded') :
    ['error','timeout','inconsistent','permission-denied','window-ended','invalid','validation'].includes(phase) ? (snapshot ? 'Last known' : 'Schedule not loaded') : context;
  document.querySelectorAll('[data-live-label]').forEach(el => { el.textContent = mode; });
  setText('rooms-view-semester', `${mode} · ${snapshot?.info?.semester || 'Semester unknown'}`);
  setText('sidebar-semester', `${snapshot?.info?.semester || 'Semester unknown'} · ${mode}`);
  setText('sidebar-status', message);
  setText('grid-timestamp', snapshot ? displayTimestamp(snapshot.meta.fetchedAt) : 'Not loaded');
  setText('footer-sync', snapshot ? displayTimestamp(snapshot.meta.fetchedAt) : 'Not loaded');
  // Receipt/countdown changes remain visible but are not meaningful announcements.
  // Only the central live region (in the active dialog, if any) speaks updates.
  if (!['loading','refreshing'].includes(phase)) {
    const signature = JSON.stringify([phase, state.requestError, state.query, snapshot?.meta.version,
      state.allRoomsCache.map(room => [room.building,room.room,room.empty,room.matches_requested_window])]);
    if (signature !== lastScheduleAnnouncement) {
      lastScheduleAnnouncement = signature;
      announce(`${context}. ${['success','empty'].includes(phase) ? phase === 'empty' ? 'No rooms in this schedule.' : 'Schedule updated.' : message}`);
    }
  }
}

function renderSnapshot() {
  const snapshot = state.snapshot;
  if (!snapshot) return;
  preserveFocus(() => {
    updateStats(state.buildingsData);
    updateHomeHeroStat(state.buildingsData);
    renderBuildingChips(state.buildingsData);
    renderBuildingsControls(state.buildingsData);
    renderBuildingsGrid(state.buildingsData);
    renderRoomsGrid(state.lastRoomsData);
    renderSidebarTopRooms(state.lastRoomsData);
    if (state.map) updateBuildingMarkers(state.map, state.markers, state.buildingsData);
    if (state.dashMap) updateBuildingMarkers(state.dashMap, state.dashMarkers, state.buildingsData, {interactive:false});
    if (state.openBuilding) renderOpenBuilding();
    if (!$('find-room-modal')?.classList.contains('hidden')) renderFindRoom(state.allRoomsData);
    if (state.detailRoom && snapshot.detailKey === state.detailRoom) {
      if (snapshot.detail) { state.detailData = snapshot.detail; renderRoomDetail(snapshot.detail); }
      else { setText('rds-status', 'Not in current schedule'); setText('rds-list', 'This room is not in the current schedule. Your saved pin is retained.'); $('room-free-window')?.classList.add('hidden'); }
    }
    if (isSearchPanelOpen()) {
      const mobile = isMobileSearchOpen();
      const input = $(mobile ? 'mobile-search-input' : 'global-search');
      renderSearchModel($(mobile ? 'mobile-search-results' : 'search-results'), buildSearchModel(input?.value || ''));
    }
    renderScheduleInfo(snapshot.info);
  });
  renderDataStatus();
}

async function refresh({coherenceRetry = false} = {}) {
  const query = Object.freeze({ ...state.query });
  const key = reliability.queryParams(query).toString();
  const ticket = refreshGeneration.begin(key);
  const invalid = reliability.validateQuery(query);
  if (invalid) {
    state.requestState = query.until && !query.at && invalid.includes('after') ? 'window-ended' : 'invalid';
    state.requestError = state.requestState === 'window-ended' ? 'This requested window has ended. Choose a later end time or clear the window.' : invalid;
    setText('query-error', state.requestError);
    renderDataStatus();
    return;
  }
  const detailKey = state.detailRoom, buildingKey = state.openBuilding;
  state.requestState = state.snapshot ? 'refreshing' : 'loading';
  state.requestError = '';
  setText('query-error', '');
  if (!state.snapshot) renderRoomsGridSkeleton();
  if (buildingKey && (state.snapshot?.buildingKey !== buildingKey || !state.snapshot.heatmap)) setText('panel-heatmap', 'Loading weekly schedule…');
  renderDataStatus();
  const load = async () => {
    try {
      const params = reliability.queryParams(query), filtered = reliability.queryParams(query, true);
      const get = (path, qs = params) => reliability.request(path + (qs.toString() ? '?' + qs : ''), { signal: ticket.signal });
      const detailParams = new URLSearchParams(params);
      if (detailKey) { const [building, room] = splitDetailRoom(detailKey); detailParams.set('building', building); detailParams.set('room', room); }
      const heatmapParams = new URLSearchParams({building:buildingKey});
      const [buildings, available, roster, info, detail, heatmap] = await Promise.all([
        get('/api/buildings'), get('/api/rooms', filtered), get('/api/rooms/all'),
        get('/api/schedule-info', new URLSearchParams()),
        detailKey ? get('/api/room/schedule', detailParams).catch(error => { if (error.status === 404) return null; throw error; }) : null,
        buildingKey ? get('/api/heatmap', heatmapParams).catch(() => null) : null,
      ]);
      if (![buildings.data, available.data, roster.data].every(Array.isArray) || !info.data || typeof info.data !== 'object' ||
          (detail && !Array.isArray(detail.data.classes))) throw new Error('Invalid schedule response');
      const packets = [buildings, available, roster, ...(detail ? [detail] : [])];
      const meta = reliability.snapshotMetadata(packets);
      const version = info.version || info.data.schedule_version;
      if (version && meta.version && version !== meta.version) {
        throw Object.assign(new Error('Schedule changed during refresh. Retry for a consistent snapshot.'), {kind:'inconsistent'});
      }
      if (meta.offline && (!meta.verified || roster.data.some(room => typeof room.matches_requested_window !== 'boolean'))) {
        throw Object.assign(new Error('Cached schedule uses an older format. Reconnect and retry to verify availability.'), {kind:'offline'});
      }
      refreshGeneration.commit(ticket, () => {
        const snapshot = {query, meta, acceptedAt:Date.now(), info:info.data, infoFetchedAt:info.fetchedAt, detailKey, detail:detail?.data || null, buildingKey, heatmap:heatmap && (!meta.version || heatmap.version === meta.version) ? heatmap.data : null};
        // Publish caches only after the entire generation and context have passed.
        state.snapshot = snapshot;
        state.buildingsData = buildings.data;
        state.allRoomsCache = roster.data;
        state.allRoomsCacheReady = true;
        state.allRoomsCacheKey = key;
        state.allRoomsData = roster.data.filter(room => room.empty !== false && room.matches_requested_window !== false);
        state.lastRoomsData = state.freeAllDay ? available.data.filter(room => room.minutes_until_next === null) : available.data;
        state.requestState = meta.offline ? 'offline' : !meta.verified ? 'unverified' : roster.data.length ? 'success' : 'empty';
        renderSnapshot();
      });
    } catch (error) {
      if (!refreshGeneration.current(ticket)) return;
      if (error.kind === 'inconsistent' && !coherenceRetry) return refresh({coherenceRetry:true});
      state.requestState = error.kind || (navigator.onLine === false ? 'offline' : 'error');
      state.requestError = error.message || 'Could not load the schedule. Please retry.';
      if (['invalid', 'window-ended'].includes(state.requestState)) setText('query-error', state.requestError);
      if (!state.snapshot) { setText('rooms-container', 'Schedule not loaded.'); setText('fr-results', 'Schedule not loaded.'); }
      if (state.detailRoom === detailKey && !state.detailData) {
        setText('rds-status', 'Schedule unavailable');
        setText('rds-list', 'Could not load this room’s schedule. Use Retry above.');
      }
      if (buildingKey && state.openBuilding === buildingKey && (state.snapshot?.buildingKey !== buildingKey || !state.snapshot.heatmap)) renderHeatmap(null);
      renderDataStatus();
    } finally {
      if (state.pendingRefresh?.ticket === ticket) state.pendingRefresh = null;
    }
  };
  const promise = load();
  state.pendingRefresh = { key, promise, ticket };
  return promise;
}

async function scheduledRefresh() {
  if (['window-ended', 'invalid'].includes(state.requestState)) return;
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
  showHomeHeroMap(); // hero map needs data loaded for its markers; re-measures even if view was hidden
  setInterval(scheduledRefresh, REFRESH_INTERVAL_MS);

  // PWA: offline shell + add-to-home-screen
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
}

document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') scheduledRefresh(); });
window.addEventListener('online', scheduledRefresh);
window.addEventListener('offline', () => {
  if (!['invalid', 'window-ended'].includes(state.requestState)) state.requestState = 'offline';
  renderDataStatus();
});

init();
