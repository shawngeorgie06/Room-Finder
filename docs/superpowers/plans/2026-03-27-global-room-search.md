# Global Room Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a global search bar that lets users type a room number (e.g. "207" or "KUPF 207") and instantly see matching rooms across all buildings.

**Architecture:** Frontend-only change. A new search input queries the existing `/api/rooms/all` endpoint (no building filter) and filters results client-side. The search bar lives in the top header and is always visible. Results appear in the Room Grid view.

**Tech Stack:** Vanilla JS, Tailwind CSS (via CDN), Flask (no backend changes needed)

---

## File Map

- **Modify:** `static/app.js` — add `globalSearch()` function, wire up input, filter `renderRoomsGrid`
- **Modify:** `templates/index.html` — add search input to header and/or rooms view toolbar

---

### Task 1: Add search input to the header

**Files:**
- Modify: `templates/index.html` (header section, lines ~94–113)

- [ ] **Step 1: Open `templates/index.html` and locate the header**

Find the `<header>` element. It currently ends with a clock and avatar icon on the right side. We'll add a search input between the stats and the clock.

- [ ] **Step 2: Insert the search input into the header**

Replace the closing `</div>` of the `flex items-center gap-4` div (the one wrapping clock + avatar) with:

```html
    <div class="flex items-center gap-4 pl-4 border-l border-outline-variant/30">
      <div class="relative hidden sm:block">
        <span class="material-symbols-outlined absolute left-2 top-1/2 -translate-y-1/2 text-on-surface-variant" style="font-size:16px">search</span>
        <input
          id="global-search"
          type="text"
          placeholder="Search room..."
          oninput="globalSearch(this.value)"
          autocomplete="off"
          class="bg-surface-container border border-outline-variant/30 text-white text-xs font-label pl-8 pr-3 py-1.5 rounded-sm w-40 focus:outline-none focus:border-primary/60 placeholder:text-on-surface-variant/40"
        />
      </div>
      <div id="hdr-clock" class="text-xs font-bold text-primary tabular-nums hidden sm:block">--:--:--</div>
      <div class="w-9 h-9 rounded-sm bg-surface-container border border-outline-variant/20 flex items-center justify-center">
        <span class="material-symbols-outlined text-on-surface-variant">person</span>
      </div>
    </div>
```

- [ ] **Step 3: Manually verify the input appears in browser**

Start the server: `python app.py`
Open `http://localhost:5000` — confirm a small search box appears in the top-right of the header next to the clock.

- [ ] **Step 4: Commit**

```bash
git add templates/index.html
git commit -m "feat: add global room search input to header"
```

---

### Task 2: Implement `globalSearch()` in app.js

**Files:**
- Modify: `static/app.js`

The search needs to:
1. Cache all rooms (already done — `state.allRoomsData` is populated when `/api/rooms` is called with no filters)
2. If `allRoomsData` is empty, fetch `/api/rooms/all` (no building filter)
3. Filter by `building+room` string containing the query
4. Switch to rooms view and render filtered results

- [ ] **Step 1: Ensure `allRoomsData` is always populated**

In `app.js`, find the `fetchRooms()` function. The current cache condition is:
```js
if (!state.building && !state.timeAt && !state.timeFor) state.allRoomsData = data;
```

This only caches *empty* rooms. For search we need all rooms regardless of status. Add a separate full-roster cache. Find the `state` object at the top and add one property:

```js
const state = {
  view: 'dashboard',
  building: '',
  timeAt: '',
  timeFor: 0,
  map: null,
  dashMap: null,
  markers: {},
  dashMarkers: {},
  buildingsData: [],
  allRoomsData: [],
  allRoomsCache: [],   // <-- ADD THIS: full roster including occupied rooms
  mapFloor: 1,
  floorRoomsData: [],
};
```

- [ ] **Step 2: Populate `allRoomsCache` on first load**

Add a new async function after `fetchBuildings()`:

```js
async function fetchAllRoomsCache() {
  if (state.allRoomsCache.length) return; // already loaded
  try {
    const r = await fetch('/api/rooms/all');
    if (!r.ok) throw new Error(r.status);
    state.allRoomsCache = await r.json();
  } catch(e) { console.error('allRoomsCache error:', e); }
}
```

Call it inside the `refresh()` function (or wherever `fetchBuildings` and `fetchRooms` are called on startup). Find `refresh()` and add it:

```js
function refresh() {
  fetchBuildings();
  fetchRooms();
  fetchAllRoomsCache();  // <-- ADD THIS LINE
}
```

- [ ] **Step 3: Add the `globalSearch()` function**

Add this function after `resetTimeFilter()`:

```js
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
}
```

- [ ] **Step 4: Clear search when building filter chip is clicked**

In `renderBuildingChips()`, find the line that sets `state.building` and calls `fetchRooms()`:

```js
btn.addEventListener('click', () => { state.building = value; renderBuildingChips(buildings); fetchRooms(); });
```

Update it to also clear the search input:

```js
btn.addEventListener('click', () => {
  state.building = value;
  const gs = $('global-search');
  if (gs) gs.value = '';
  renderBuildingChips(buildings);
  fetchRooms();
});
```

- [ ] **Step 5: Test manually**

1. Open `http://localhost:5000`
2. Type "207" in the search box — rooms view should appear with all rooms containing "207" across buildings
3. Type "KUPF" — should filter to KUPF rooms only
4. Type "KUPF 3" — should narrow to KUPF rooms with "3" in the number
5. Clear the input — should restore normal view
6. Click a building chip — search input should clear

- [ ] **Step 6: Commit**

```bash
git add static/app.js
git commit -m "feat: implement global room search with cross-building filtering"
```

---

### Task 3: Add search to mobile (bottom bar or modal)

The header search is `hidden sm:block` — invisible on mobile. Add a search icon to the mobile bottom nav that focuses the header input on desktop and shows an inline search on mobile.

**Files:**
- Modify: `templates/index.html` (mobile bottom nav section)

- [ ] **Step 1: Find the mobile bottom nav in index.html**

Search for `mob-nav-` — the mobile nav is a fixed bottom bar with icon buttons for Dashboard, Rooms, Map, Settings.

- [ ] **Step 2: Add a search button to the mobile nav**

Inside the mobile nav flex container, add a search button between Rooms and Map:

```html
<button onclick="toggleMobileSearch()" class="flex flex-col items-center gap-1 px-3 py-2">
  <span id="mob-search-icon" class="material-symbols-outlined text-xl" style="color:#adaaaa">search</span>
  <span class="text-[9px] font-label uppercase tracking-widest" style="color:#adaaaa">Search</span>
</button>
```

- [ ] **Step 3: Add a mobile search overlay**

Just before `</body>`, add:

```html
<!-- Mobile search overlay -->
<div id="mobile-search-overlay" class="hidden fixed inset-0 z-[200] bg-[#080808]/95 backdrop-blur-md flex flex-col items-center pt-24 px-6 sm:hidden">
  <div class="w-full max-w-sm relative">
    <span class="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant" style="font-size:20px">search</span>
    <input
      id="mobile-search-input"
      type="text"
      placeholder="Search room (e.g. KUPF 207)..."
      oninput="globalSearch(this.value)"
      autocomplete="off"
      class="w-full bg-surface-container border border-outline-variant/30 text-white text-sm font-label pl-10 pr-4 py-3 rounded-sm focus:outline-none focus:border-primary/60 placeholder:text-on-surface-variant/40"
    />
  </div>
  <button onclick="toggleMobileSearch()" class="mt-6 text-xs text-on-surface-variant font-label uppercase tracking-widest">Cancel</button>
</div>
```

- [ ] **Step 4: Add `toggleMobileSearch()` to app.js**

```js
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
```

Also update `globalSearch()` to close the mobile overlay after a result is found (add at the end of the function after `switchView('rooms')`):

```js
// Close mobile overlay if open
const overlay = $('mobile-search-overlay');
if (overlay && !overlay.classList.contains('hidden') && !q) {
  overlay.classList.add('hidden');
}
```

- [ ] **Step 5: Test on mobile viewport**

In browser devtools, toggle to a mobile viewport (e.g. 390×844). Tap the Search icon in the bottom nav — overlay should appear. Type a room number — rooms view appears underneath when overlay closes.

- [ ] **Step 6: Commit**

```bash
git add templates/index.html static/app.js
git commit -m "feat: add mobile search overlay for room search"
```
