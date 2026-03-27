# Auto-Refresh Countdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a visible countdown (e.g. "Refresh in 42s") in the sidebar and optionally the header so users know exactly when the next data update fires.

**Architecture:** Frontend-only. The existing `setInterval(refresh, 60000)` drives data updates. We'll track time elapsed since last refresh and update a countdown display every second. No backend changes.

**Tech Stack:** Vanilla JS, existing `setInterval` pattern

---

## File Map

- **Modify:** `static/app.js` — track last-refresh timestamp, add 1-second countdown ticker, expose `refresh()` to update it
- **Modify:** `templates/index.html` — add countdown display element in sidebar status panel and optionally header

---

### Task 1: Add countdown state and ticker to app.js

**Files:**
- Modify: `static/app.js`

- [ ] **Step 1: Locate the refresh interval setup**

At the bottom of `app.js`, find:

```js
refresh();
setInterval(refresh, 60000);
```

We need to wrap this so we track when the next refresh fires.

- [ ] **Step 2: Replace the raw interval with a managed refresh cycle**

Replace the initialization block with:

```js
const REFRESH_INTERVAL_MS = 60000;
let nextRefreshAt = Date.now() + REFRESH_INTERVAL_MS;

function scheduledRefresh() {
  refresh();
  nextRefreshAt = Date.now() + REFRESH_INTERVAL_MS;
}

restoreStateFromURL();   // if shareable-url plan is also applied; otherwise remove this line
refresh();
setInterval(scheduledRefresh, REFRESH_INTERVAL_MS);
```

- [ ] **Step 3: Add the countdown ticker**

Add this block right after the `nextRefreshAt` declaration:

```js
function updateCountdown() {
  const secsLeft = Math.max(0, Math.ceil((nextRefreshAt - Date.now()) / 1000));
  const el = $('refresh-countdown');
  if (el) el.textContent = `Refresh in ${secsLeft}s`;
  const ring = $('refresh-ring');
  if (ring) {
    // 0–60 mapped to stroke-dashoffset 0–circumference
    const circ = 2 * Math.PI * 8; // r=8 → ~50.3
    const pct  = secsLeft / (REFRESH_INTERVAL_MS / 1000);
    ring.style.strokeDashoffset = circ * (1 - pct);
  }
}

setInterval(updateCountdown, 1000);
updateCountdown(); // immediate first paint
```

- [ ] **Step 4: Commit the JS changes**

```bash
git add static/app.js
git commit -m "feat: track refresh cycle and drive countdown ticker"
```

---

### Task 2: Add countdown display elements to the sidebar

**Files:**
- Modify: `templates/index.html` (sidebar System Status panel, lines ~139–148)

- [ ] **Step 1: Find the sidebar status panel**

Locate this block in `index.html`:

```html
<div class="bg-surface-container/50 p-3 border border-outline-variant/10 rounded-sm">
  <div class="text-[10px] font-label text-on-surface-variant mb-2">System Status</div>
  <div class="flex items-center gap-2">
    <div class="w-2 h-2 rounded-full bg-primary animate-pulse"></div>
    <span class="text-[11px] font-bold text-primary">Live · Auto-refresh</span>
  </div>
  <div id="sidebar-status" class="text-[9px] text-on-surface-variant mt-1 tracking-wider"></div>
</div>
```

- [ ] **Step 2: Replace with countdown-enhanced version**

Replace that entire block with:

```html
<div class="bg-surface-container/50 p-3 border border-outline-variant/10 rounded-sm">
  <div class="text-[10px] font-label text-on-surface-variant mb-2">System Status</div>
  <div class="flex items-center justify-between">
    <div class="flex items-center gap-2">
      <div class="w-2 h-2 rounded-full bg-primary animate-pulse"></div>
      <span class="text-[11px] font-bold text-primary">Live</span>
    </div>
    <!-- Countdown ring + label -->
    <div class="flex items-center gap-1.5">
      <svg width="20" height="20" viewBox="0 0 20 20" style="transform:rotate(-90deg)">
        <circle cx="10" cy="10" r="8" fill="none" stroke="rgba(63,255,139,0.15)" stroke-width="2"/>
        <circle id="refresh-ring" cx="10" cy="10" r="8" fill="none"
          stroke="#3fff8b" stroke-width="2"
          stroke-dasharray="50.27"
          stroke-dashoffset="0"
          style="transition:stroke-dashoffset 1s linear"
        />
      </svg>
      <span id="refresh-countdown" class="text-[9px] font-label text-primary tabular-nums">Refresh in 60s</span>
    </div>
  </div>
  <div id="sidebar-status" class="text-[9px] text-on-surface-variant mt-1 tracking-wider"></div>
</div>
```

- [ ] **Step 3: Test manually**

1. Start server: `python app.py`
2. Open `http://localhost:5000`
3. In the sidebar (desktop), confirm "Live" label + ring + "Refresh in 60s" text
4. Watch for 5–10 seconds — confirm countdown decrements each second
5. Watch the ring — the green stroke should drain clockwise as time passes
6. At 0s, data refreshes and counter resets to 60s

- [ ] **Step 4: Commit**

```bash
git add templates/index.html
git commit -m "feat: add countdown ring and timer to sidebar status panel"
```

---

### Task 3: Add a subtle countdown to the header (optional but nice)

Show the countdown in the header for users on mobile (who don't see the sidebar).

**Files:**
- Modify: `templates/index.html` (header, near `hdr-clock`)

- [ ] **Step 1: Add a header countdown badge**

In the header, find the `hdr-clock` element:

```html
<div id="hdr-clock" class="text-xs font-bold text-primary tabular-nums hidden sm:block">--:--:--</div>
```

Add a countdown element just after it (visible only on mobile where sidebar is hidden):

```html
<div id="hdr-countdown" class="text-[9px] font-label text-on-surface-variant tabular-nums md:hidden">
  ↻ <span id="hdr-countdown-secs">60</span>s
</div>
```

- [ ] **Step 2: Update `updateCountdown()` to also update the header element**

In `app.js`, update the `updateCountdown` function to also set `hdr-countdown-secs`:

```js
function updateCountdown() {
  const secsLeft = Math.max(0, Math.ceil((nextRefreshAt - Date.now()) / 1000));
  const el = $('refresh-countdown');
  if (el) el.textContent = `Refresh in ${secsLeft}s`;
  const hdrSecs = $('hdr-countdown-secs');
  if (hdrSecs) hdrSecs.textContent = secsLeft;
  const ring = $('refresh-ring');
  if (ring) {
    const circ = 2 * Math.PI * 8;
    const pct  = secsLeft / (REFRESH_INTERVAL_MS / 1000);
    ring.style.strokeDashoffset = circ * (1 - pct);
  }
}
```

- [ ] **Step 3: Test on mobile viewport**

In browser devtools, switch to a mobile viewport (390×844). The sidebar is hidden. Confirm the header shows a small "↻ 42s" indicator that counts down.

- [ ] **Step 4: Commit**

```bash
git add templates/index.html static/app.js
git commit -m "feat: add header countdown for mobile (no sidebar)"
```
