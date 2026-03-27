# Configurable "Busy Soon" Threshold Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hardcoded 30-minute "closing soon" threshold with a user-configurable value exposed in the UI filter bar, so students with short breaks can set a tighter threshold.

**Architecture:** Frontend-only. The threshold is currently a magic number (`<= 30`) scattered across `app.js`. We'll centralize it in `state.soonThresholdMins`, add a UI control in the filter bar, and update all comparison sites. No backend changes needed.

**Tech Stack:** Vanilla JS, Tailwind CSS

---

## File Map

- **Modify:** `static/app.js` — add `soonThresholdMins` to state, replace all `<= 30` comparisons, add `applyThreshold()` function
- **Modify:** `templates/index.html` — add threshold selector to the filter bar

---

### Task 1: Centralize the threshold in state

**Files:**
- Modify: `static/app.js`

- [ ] **Step 1: Add `soonThresholdMins` to the `state` object**

Find the `state` object at the top of `app.js`:

```js
const state = {
  view: 'dashboard',
  building: '',
  timeAt: '',
  timeFor: 0,
  ...
};
```

Add `soonThresholdMins` with a default of 30:

```js
const state = {
  view: 'dashboard',
  building: '',
  timeAt: '',
  timeFor: 0,
  soonThresholdMins: 30,   // <-- ADD
  map: null,
  dashMap: null,
  markers: {},
  dashMarkers: {},
  buildingsData: [],
  allRoomsData: [],
  mapFloor: 1,
  floorRoomsData: [],
};
```

- [ ] **Step 2: Find and replace all hardcoded `<= 30` threshold comparisons**

Search `app.js` for `<= 30` — there are multiple sites. Each looks like:

```js
const isSoon = room.minutes_until_next !== null && room.minutes_until_next <= 30;
```

Replace every occurrence with:

```js
const isSoon = room.minutes_until_next !== null && room.minutes_until_next <= state.soonThresholdMins;
```

Also check for `30` appearing in tooltip/label text like `'Closing soon'` conditions — replace those too if they reference the threshold.

Locations to check (search for `<= 30` in app.js):
- `renderLiveFeed()`
- `renderDashRooms()`
- `renderRoomsTable()`
- `renderRoomsGrid()`
- `renderRoomGrid()` (floor panel version)

- [ ] **Step 3: Add `applyThreshold()` function**

Add after `resetTimeFilter()`:

```js
function applyThreshold() {
  const sel = $('soon-threshold-select');
  if (sel) state.soonThresholdMins = parseInt(sel.value) || 30;
  // Re-render with existing data (no new fetch needed — threshold is display-only)
  if (state.allRoomsData.length)    renderLiveFeed(state.allRoomsData);
  if (state.buildingsData.length)   renderHealthBars(state.buildingsData);
  // Re-fetch rooms so renderRoomsGrid and renderDashRooms get fresh calls
  fetchRooms();
}
```

- [ ] **Step 4: Commit JS changes**

```bash
git add static/app.js
git commit -m "refactor: centralize busy-soon threshold in state, replace magic 30"
```

---

### Task 2: Add threshold selector to the filter bar

**Files:**
- Modify: `templates/index.html`

- [ ] **Step 1: Find the filter bar in index.html**

Search for `time-filter-at` — the filter bar contains time inputs and Apply/Reset buttons. It's typically in the rooms view header or a shared filter strip.

- [ ] **Step 2: Add the threshold dropdown**

Inside the filter bar, after the "for N minutes" duration input, add:

```html
<!-- Busy Soon threshold -->
<div class="flex items-center gap-2">
  <label for="soon-threshold-select" class="text-[10px] font-label text-on-surface-variant uppercase tracking-widest whitespace-nowrap">
    Closing soon if
  </label>
  <select
    id="soon-threshold-select"
    onchange="applyThreshold()"
    class="bg-surface-container border border-outline-variant/30 text-white text-xs font-label px-2 py-1.5 rounded-sm focus:outline-none focus:border-primary/60"
  >
    <option value="15">≤ 15 min</option>
    <option value="30" selected>≤ 30 min</option>
    <option value="45">≤ 45 min</option>
    <option value="60">≤ 60 min</option>
  </select>
</div>
```

- [ ] **Step 3: Persist threshold selection in URL (if shareable-url plan is also applied)**

If the shareable URL plan has been applied, update `syncURL()` in `app.js` to include the threshold:

```js
function syncURL() {
  const params = new URLSearchParams();
  if (state.view && state.view !== 'dashboard')       params.set('view', state.view);
  if (state.building)                                  params.set('building', state.building);
  if (state.timeAt)                                    params.set('at', state.timeAt);
  if (state.timeFor)                                   params.set('for', String(state.timeFor));
  if (state.soonThresholdMins !== 30)                  params.set('soon', String(state.soonThresholdMins));
  const newURL = params.toString() ? '?' + params.toString() : window.location.pathname;
  window.history.replaceState(null, '', newURL);
}
```

And in `restoreStateFromURL()`:

```js
const soon = params.get('soon');
if (soon) {
  state.soonThresholdMins = parseInt(soon) || 30;
  const sel = $('soon-threshold-select');
  if (sel) sel.value = String(state.soonThresholdMins);
}
```

If the shareable-url plan is NOT applied, skip this step.

- [ ] **Step 4: Also call `applyThreshold()` from `applyTimeFilter()`**

To keep threshold in sync when filters are reapplied:

```js
function applyTimeFilter() {
  state.timeAt  = $('time-filter-at')?.value  || '';
  state.timeFor = parseInt($('time-filter-for')?.value || '0');
  const sel = $('soon-threshold-select');
  if (sel) state.soonThresholdMins = parseInt(sel.value) || 30;
  const ind = $('time-filter-indicator');
  if (ind) ind.classList.toggle('hidden', !state.timeAt && !state.timeFor);
  refresh();
}
```

- [ ] **Step 5: Test manually**

1. Start server: `python app.py`
2. Open `http://localhost:5000` → Room Grid
3. Default "Closing soon" threshold = 30 min (amber cards for rooms with < 30 min)
4. Change dropdown to "≤ 15 min" — amber cards should reduce (only rooms within 15 min show amber)
5. Change dropdown to "≤ 60 min" — more rooms turn amber (any room with < 60 min until next class)
6. Confirm dashboard live feed and mini grid also update color coding

- [ ] **Step 6: Commit**

```bash
git add templates/index.html static/app.js
git commit -m "feat: configurable busy-soon threshold via UI dropdown"
```
