# Shareable / Permalink URL Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sync the app's filter state (view, building, time, duration) to the URL so users can bookmark or share a specific filtered state (e.g. `/?view=rooms&building=KUPF&at=14:00&for=60`).

**Architecture:** Frontend-only. On state change, write `window.history.replaceState` with current params. On page load, read URL params and restore state before first fetch. No backend changes.

**Tech Stack:** Vanilla JS, browser History API (`replaceState`, `URLSearchParams`)

---

## File Map

- **Modify:** `static/app.js` — add `pushState()` helper, call it on every state mutation, add `restoreStateFromURL()` on init

---

### Task 1: Write `pushState()` helper and call on state changes

**Files:**
- Modify: `static/app.js`

- [ ] **Step 1: Write a failing test (manual verification approach)**

Because this is pure browser History API, we'll use manual test cases documented here. Run through them in Step 6. No pytest needed for this task.

- [ ] **Step 2: Add `syncURL()` helper to app.js**

Add this function right after the `state` object definition (around line 37):

```js
// ── URL state sync ─────────────────────────────────────────────────────────
function syncURL() {
  const params = new URLSearchParams();
  if (state.view && state.view !== 'dashboard') params.set('view', state.view);
  if (state.building) params.set('building', state.building);
  if (state.timeAt)   params.set('at', state.timeAt);
  if (state.timeFor)  params.set('for', String(state.timeFor));
  const newURL = params.toString() ? '?' + params.toString() : window.location.pathname;
  window.history.replaceState(null, '', newURL);
}
```

- [ ] **Step 3: Call `syncURL()` whenever state changes**

There are 4 places where state mutates and the UI should update the URL:

**a) In `switchView()`** — add `syncURL()` at the end of the function:
```js
function switchView(view) {
  state.view = view;
  // ... existing code ...
  syncURL();   // <-- ADD at end
}
```

**b) In `applyTimeFilter()`** — add `syncURL()` after `refresh()`:
```js
function applyTimeFilter() {
  state.timeAt  = $('time-filter-at')?.value  || '';
  state.timeFor = parseInt($('time-filter-for')?.value || '0');
  const ind = $('time-filter-indicator');
  if (ind) ind.classList.toggle('hidden', !state.timeAt && !state.timeFor);
  refresh();
  syncURL();   // <-- ADD
}
```

**c) In `resetTimeFilter()`** — add `syncURL()` after `refresh()`:
```js
function resetTimeFilter() {
  state.timeAt  = '';
  state.timeFor = 0;
  if ($('time-filter-at'))  $('time-filter-at').value  = '';
  if ($('time-filter-for')) $('time-filter-for').value = '0';
  const ind = $('time-filter-indicator');
  if (ind) ind.classList.add('hidden');
  refresh();
  syncURL();   // <-- ADD
}
```

**d) In `renderBuildingChips()` click handler** — add `syncURL()` after `fetchRooms()`:
```js
btn.addEventListener('click', () => {
  state.building = value;
  renderBuildingChips(buildings);
  fetchRooms();
  syncURL();   // <-- ADD
});
```

- [ ] **Step 4: Commit the syncURL work**

```bash
git add static/app.js
git commit -m "feat: sync filter state to URL on every state change"
```

---

### Task 2: Restore state from URL on page load

**Files:**
- Modify: `static/app.js` — add `restoreStateFromURL()`, call before first `refresh()`

- [ ] **Step 1: Add `restoreStateFromURL()` function**

Add this function just after `syncURL()`:

```js
function restoreStateFromURL() {
  const params = new URLSearchParams(window.location.search);

  const view     = params.get('view');
  const building = params.get('building');
  const at       = params.get('at');
  const forMins  = params.get('for');

  if (building) state.building = building;
  if (at)       state.timeAt   = at;
  if (forMins)  state.timeFor  = parseInt(forMins) || 0;

  // Restore time filter inputs so UI reflects the state
  if (at && $('time-filter-at'))        $('time-filter-at').value  = at;
  if (forMins && $('time-filter-for'))  $('time-filter-for').value = forMins;
  if ((at || forMins) && $('time-filter-indicator')) {
    $('time-filter-indicator').classList.remove('hidden');
  }

  // Switch to the saved view (must happen after DOM is ready)
  if (view && ['dashboard','rooms','map','settings'].includes(view)) {
    switchView(view);
  }
}
```

- [ ] **Step 2: Call `restoreStateFromURL()` before first `refresh()`**

Find the bottom of `app.js` where the app initializes (typically a `refresh()` call or `DOMContentLoaded` handler). It looks something like:

```js
refresh();
setInterval(refresh, 60000);
```

Update it to:

```js
restoreStateFromURL();
refresh();
setInterval(refresh, 60000);
```

- [ ] **Step 3: Manual test — verify URL round-trips**

Start server: `python app.py`

Test cases:
1. Load `http://localhost:5000` — URL stays clean (`/`)
2. Click "Room Grid" in sidebar — URL becomes `/?view=rooms`
3. Click building chip "KUPF" — URL becomes `/?view=rooms&building=KUPF`
4. Set time filter to 14:00, 60 min — URL becomes `/?view=rooms&building=KUPF&at=14%3A00&for=60`
5. Copy that URL, open new tab, paste — page loads with KUPF filter active, time set to 14:00, room grid shown
6. Click "ALL" building chip — URL drops `building` param
7. Click reset time filter — URL drops `at` and `for` params
8. Click Dashboard — URL becomes `/?view=dashboard` (or just `/` if dashboard is default)

- [ ] **Step 4: Handle dashboard as default (clean URL)**

In `syncURL()`, `dashboard` is already excluded:
```js
if (state.view && state.view !== 'dashboard') params.set('view', state.view);
```
Verify: clicking Dashboard gives a clean `/` URL with no params (assuming no other filters active).

- [ ] **Step 5: Commit**

```bash
git add static/app.js
git commit -m "feat: restore filter state from URL on page load (shareable links)"
```

---

### Task 3: Add a "Copy Link" button to the filter bar

Surface the shareable URL with a one-click copy button so users know the feature exists.

**Files:**
- Modify: `templates/index.html` — add copy button near time filter controls

- [ ] **Step 1: Find the time filter controls in index.html**

Search for `time-filter-at` — this is the time input. The filter area has an "Apply" and "Reset" button. Add a "Copy Link" button nearby.

- [ ] **Step 2: Add the copy button**

Next to the Reset button in the time filter section, add:

```html
<button
  onclick="copyShareLink()"
  id="copy-link-btn"
  title="Copy shareable link"
  class="flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-bold font-label uppercase tracking-widest border border-outline-variant/30 text-on-surface-variant rounded-sm hover:border-primary/40 hover:text-primary transition-all"
>
  <span class="material-symbols-outlined" style="font-size:14px">link</span>
  <span id="copy-link-label">Share</span>
</button>
```

- [ ] **Step 3: Add `copyShareLink()` to app.js**

```js
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
```

- [ ] **Step 4: Test the copy button**

1. Set building = KUPF, time = 14:00
2. Click "Share" — button briefly shows "Copied!"
3. Paste into address bar — should see the correct URL with params
4. Open in new tab — page restores KUPF + 14:00 filter

- [ ] **Step 5: Commit**

```bash
git add templates/index.html static/app.js
git commit -m "feat: add copy-link button to share filtered room view"
```
