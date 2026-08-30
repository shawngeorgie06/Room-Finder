# Room Finder Redesign — Foundation & Home Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair the design-token foundation, then rebuild the home screen as a campus-map hero above a building-first browse grid.

**Architecture:** Slice 1 fixes `tailwind.config.js` (radius scale, pruned colours, type scale) and mirrors the tokens as CSS custom properties on `:root` so the 91 inline-style blocks in `app.js` can stop hardcoding hex. Slice 2 then replaces the five-panel dashboard with a non-interactive Leaflet hero plus a sorted, filterable building grid. No backend changes.

**Tech Stack:** Flask (Jinja templates), vanilla JS, Tailwind CSS 3.4 (prebuilt, committed), Leaflet.js, pytest.

**Spec:** `docs/superpowers/specs/2026-08-29-room-finder-redesign-design.md`

## Global Constraints

- **Rebuild CSS in the same commit as any token change.** `static/tailwind.css` is a committed build artifact. Run `npm run build:css` and stage the result, or the change does not apply in production.
- **`npm install` is required once** before any CSS work; `node_modules/` is not committed. Verified: the toolchain reproduces the current `static/tailwind.css` byte-identically, so any CSS diff is purely from your token edits.
- **All four `view=` URL values keep working:** `dashboard`, `rooms`, `map`, `settings`. `buildings` aliases to `dashboard`. Shared links must not break.
- **Never work on `master`.** All work lands on branch `redesign`. Tag `pre-redesign` is the revert point.
- **No backend, API, or schedule-parsing changes.** Every screen uses data the API already returns.
- **Identity is fixed:** ground `#080808`, primary `#3fff8b`. This is execution work, not repainting.
- **The 120 existing pytest tests must stay green** after every task: `.venv/bin/python -m pytest tests -q`.
- **App runs on port 5055 for local verification** (port 5000 is taken by macOS AirPlay):
  `.venv/bin/python -c "import app as m; m.app.run(host='127.0.0.1',port=5055)"`

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `tailwind.config.js` | Design tokens: colour, radius, type, spacing | Modify |
| `static/tailwind.css` | Built artifact | Rebuilt (never hand-edited) |
| `templates/index.html` | Page shell, all view markup, `:root` custom properties | Modify |
| `static/app.js` | State, fetch, render, map, nav | Modify |
| `tests/test_frontend_contract.py` | Guards JS→DOM element references | **Create** |

`app.js` is 2218 lines. This plan does not split it — that is a larger refactor than the redesign warrants, and the existing codebase convention is a single frontend file. Task 5 does introduce a small helper section that later slices can grow into a natural split point.

---

## Task 1: Frontend DOM contract test

The repo has 120 backend tests and zero frontend tests. PR #3 deleted five dashboard panels while `app.js` kept writing into them; nothing caught it because every render function is guarded with `if (!container) return;`. This task builds the guard rail **first**, so every later task in this plan is protected by it.

**Files:**
- Create: `tests/test_frontend_contract.py`
- Modify: `templates/index.html` (remove two dead references' cause), `static/app.js:1126` (remove dead `renderHealthBars`)

**Interfaces:**
- Consumes: nothing.
- Produces: `referenced_element_ids()` and `declared_element_ids()` helpers in the test module; later tasks rely on `pytest tests/test_frontend_contract.py` failing when they orphan an element.

- [ ] **Step 1: Write the failing test**

Create `tests/test_frontend_contract.py`:

```python
"""Guards the contract between app.js and index.html.

Every element app.js looks up with $('some-id') must exist in the template.
Render functions are all null-guarded, so an orphaned reference is silent at
runtime — it just renders nothing. This test makes it loud instead.
"""
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP_JS = os.path.join(ROOT, 'static', 'app.js')
INDEX_HTML = os.path.join(ROOT, 'templates', 'index.html')

# Ids app.js creates at runtime rather than reading from the template.
DYNAMIC_IDS = {'search-opt'}


def referenced_element_ids():
    """Ids app.js passes to $() as a plain string literal."""
    js = open(APP_JS, encoding='utf-8').read()
    ids = set(re.findall(r"""\$\(\s*['"]([A-Za-z0-9_-]+)['"]\s*\)""", js))
    return {i for i in ids if not any(i.startswith(d) for d in DYNAMIC_IDS)}


def declared_element_ids():
    """Ids declared in the template."""
    html = open(INDEX_HTML, encoding='utf-8').read()
    return set(re.findall(r"""\bid=["']([A-Za-z0-9_-]+)["']""", html))


def test_every_referenced_element_exists_in_template():
    missing = sorted(referenced_element_ids() - declared_element_ids())
    assert not missing, (
        "app.js reads elements that the template does not define: "
        + ", ".join(missing)
        + ". Either restore the element or delete the dead render code."
    )


def test_contract_test_sees_a_realistic_number_of_ids():
    """Guards the regexes themselves — if a refactor changes how elements are
    looked up, this test fails rather than the contract silently passing on an
    empty set."""
    assert len(referenced_element_ids()) > 40
    assert len(declared_element_ids()) > 80
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /Users/shawngeorgie/Projects/Room-Finder
.venv/bin/python -m pytest tests/test_frontend_contract.py -v
```

Expected: `test_every_referenced_element_exists_in_template` FAILS with:
`app.js reads elements that the template does not define: building-bars, health-bar`

These are two genuine pre-existing orphans: `renderHealthBars()` writes into `building-bars`, which no longer exists in the template.

- [ ] **Step 3: Delete the dead render code**

In `static/app.js`, find `renderHealthBars` (around line 1126) and delete the entire function:

```javascript
function renderHealthBars(buildings) {
  const container = $('building-bars');
  if (!container) return;
  // ...body...
}
```

Then remove its call site inside `fetchBuildings()` (around line 266):

```javascript
    updateStats(data);
    renderHealthBars(data);        // <-- delete this line
    renderBuildingChips(data);
```

Search for any remaining `health-bar` reference in `app.js` and delete that dead code too.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
.venv/bin/python -m pytest tests/test_frontend_contract.py -v
.venv/bin/python -m pytest tests -q
```

Expected: contract tests PASS; full suite shows `122 passed`.

- [ ] **Step 5: Commit**

```bash
git add tests/test_frontend_contract.py static/app.js
git commit -m "Add frontend DOM contract test; remove dead health-bar render

Every render function is null-guarded, so an element deleted from the
template fails silently. This test makes that loud. It immediately caught
renderHealthBars writing into building-bars, which no longer exists."
```

---

## Task 2: Repair the radius scale

The single highest-leverage change. `borderRadius.full` is `0.75rem`, so all 14 `rounded-full` elements render as ~12px blobs instead of circles, and `xl` caps at 8px so nothing can look soft.

**Files:**
- Modify: `tailwind.config.js:32`
- Rebuild: `static/tailwind.css`

**Interfaces:**
- Consumes: nothing.
- Produces: the utility classes `rounded-sm` (4px), `rounded` (6px), `rounded-lg` (10px), `rounded-xl` (14px), `rounded-2xl` (20px), `rounded-full` (9999px), used by every later task.

- [ ] **Step 1: Install the build toolchain**

```bash
cd /Users/shawngeorgie/Projects/Room-Finder
npm install --no-audit --no-fund
```

Expected: `node_modules/.bin/tailwindcss` exists.

- [ ] **Step 2: Confirm the toolchain reproduces the committed CSS**

```bash
cp static/tailwind.css /tmp/tw-before.css
npm run build:css
cmp /tmp/tw-before.css static/tailwind.css && echo "IDENTICAL"
```

Expected: `IDENTICAL`. If it differs, stop — the toolchain drifted, and any later CSS diff would be unreviewable. Report before continuing.

- [ ] **Step 3: Fix the radius scale**

In `tailwind.config.js`, replace this line:

```javascript
      borderRadius: {"DEFAULT": "0.125rem","lg": "0.25rem","xl": "0.5rem","full": "0.75rem"},
```

with:

```javascript
      // `full` was 0.75rem, so every rounded-full element rendered as a
      // ~12px blob rather than a circle. The rest of the scale was capped
      // at 8px, which made a soft surface impossible anywhere in the app.
      borderRadius: {
        "sm": "4px",
        "DEFAULT": "6px",
        "lg": "10px",
        "xl": "14px",
        "2xl": "20px",
        "full": "9999px",
      },
```

- [ ] **Step 4: Rebuild the CSS and confirm it changed**

```bash
npm run build:css
grep -c "border-radius:9999px" static/tailwind.css
```

Expected: a count of at least 1. If it is 0, the rebuild did not pick up the config.

- [ ] **Step 5: Verify the app still renders and tests pass**

```bash
.venv/bin/python -m pytest tests -q
```

Expected: `122 passed`.

Then start the app and confirm visually that pills and dots are round:

```bash
.venv/bin/python -c "import app as m; m.app.run(host='127.0.0.1',port=5055)" &
open http://127.0.0.1:5055/
```

- [ ] **Step 6: Commit**

```bash
git add tailwind.config.js static/tailwind.css
git commit -m "Repair the border-radius scale

borderRadius.full was 0.75rem, so all 14 rounded-full elements rendered as
12px blobs instead of circles, and xl capped at 8px meant nothing in the app
could look soft. Opens the scale to 4/6/10/14/20/9999px."
```

---

## Task 3: Prune colour tokens and add semantic availability tokens

Of ~50 Material-3 colour tokens, only 19 are ever referenced. Room availability — the concept the app exists to express — has no vocabulary, so it is re-invented as raw hex at 126 call sites.

**Files:**
- Modify: `tailwind.config.js:8-30`, `templates/index.html` (add `:root` custom properties)
- Rebuild: `static/tailwind.css`

**Interfaces:**
- Consumes: nothing.
- Produces: Tailwind classes `text-free`/`bg-free`/`border-free` (and `soon`, `busy`, `unknown`), plus CSS custom properties `--free`, `--soon`, `--busy`, `--unknown`, `--text`, `--muted`, `--faint`, `--surface`, `--raised`, `--hairline` readable from `app.js` inline styles as `var(--free)`.

- [ ] **Step 1: Replace the colour block**

In `tailwind.config.js`, replace the entire `colors: { ... }` object (lines 8–30) with:

```javascript
      colors: {
        // Only tokens actually referenced by index.html / app.js are kept.
        // The previous block carried ~50 Material-3 tokens, 31 of them dead.
        "background": "#0e0e0e",
        "on-background": "#ffffff",
        "surface": "#0e0e0e",
        "surface-variant": "#262626",
        "surface-container": "#1a1919",
        "on-surface": "#ffffff",
        "on-surface-variant": "#adaaaa",
        "outline": "#767575",
        "outline-variant": "#484847",
        "primary": "#3fff8b",
        "on-primary": "#005d2c",
        "secondary": "#ff7166",
        "tertiary": "#6e9bff",
        "error": "#ff716c",

        // Semantic availability tokens. This is the domain concept the app
        // reasons about, previously invented ad-hoc at each of 126 call sites.
        "free":    "#3fff8b",
        "soon":    "#f59e0b",
        "busy":    "#ff7166",
        "unknown": "#767575",
      },
```

- [ ] **Step 2: Rebuild and check for classes that lost their token**

```bash
npm run build:css
grep -oE '\b(text|bg|border|from|to|via)-(on-)?[a-z-]*(fixed|inverse|container-low|container-high|container-highest|container-lowest|dim|error-container|primary-container|secondary-container|tertiary-container)[a-z-]*' templates/index.html static/app.js | sort -u
```

Expected: **no output.** Any class printed here referenced a token you just deleted and will now render unstyled. If output appears, add those specific tokens back to the config and rebuild.

- [ ] **Step 3: Add the CSS custom properties**

In `templates/index.html`, inside the existing `<style>` block, add at the very top (before the first rule):

```css
  /* Token mirror for JS-generated markup. app.js builds most of its UI as
     inline style strings, which cannot reach Tailwind classes — these let it
     use var(--free) instead of hardcoding #3fff8b at 44 call sites. */
  :root {
    --free:    #3fff8b;
    --soon:    #f59e0b;
    --busy:    #ff7166;
    --unknown: #767575;

    --text:    #ffffff;
    --muted:   #adaaaa;
    --faint:   #767575;

    --surface:  #0e0e0e;
    --raised:   #1a1919;
    --hairline: rgba(63, 255, 139, 0.11);
    --hairline-soft: rgba(255, 255, 255, 0.06);
  }
```

- [ ] **Step 4: Run the tests**

```bash
.venv/bin/python -m pytest tests -q
```

Expected: `122 passed`.

- [ ] **Step 5: Commit**

```bash
git add tailwind.config.js static/tailwind.css templates/index.html
git commit -m "Prune dead colour tokens; add semantic availability tokens

31 of ~50 Material-3 tokens were never referenced. Adds free/soon/busy/
unknown as first-class names for the concept the app exists to express, and
mirrors the palette as CSS custom properties so app.js inline styles can stop
hardcoding hex."
```

---

## Task 4: Establish the type scale

Sizes run ad-hoc from `9px` to `5xl`. The `9px`/`10px` uppercase micro-label tier is below comfortable phone legibility and is the most dated element after the radius.

**Files:**
- Modify: `tailwind.config.js` (add `fontSize`), `templates/index.html` (`.label` helper class)
- Rebuild: `static/tailwind.css`

**Interfaces:**
- Consumes: nothing.
- Produces: Tailwind classes `text-display`, `text-title`, `text-data`, `text-label`, and a `.label` CSS class for JS-generated markup.

- [ ] **Step 1: Add the fontSize scale**

In `tailwind.config.js`, inside `theme.extend`, add after `fontFamily`:

```javascript
      fontSize: {
        "display": ["32px", { lineHeight: "1.1",  letterSpacing: "-0.03em", fontWeight: "800" }],
        "title":   ["20px", { lineHeight: "1.25", letterSpacing: "-0.01em", fontWeight: "700" }],
        "body":    ["15px", { lineHeight: "1.6" }],
        "data":    ["18px", { lineHeight: "1.1",  letterSpacing: "-0.01em", fontWeight: "800" }],
        "label":   ["11px", { lineHeight: "1.3",  letterSpacing: "0.08em", fontWeight: "600" }],
      },
```

- [ ] **Step 2: Add the `.label` class for JS-generated markup**

In `templates/index.html`, in the `<style>` block below the `:root` rule from Task 3:

```css
  /* The 9px/10px uppercase micro-label tier collapses into this one size.
     9px uppercase is below comfortable legibility on a phone. */
  .label {
    font-family: 'Space Grotesk', sans-serif;
    font-size: 11px; font-weight: 600;
    letter-spacing: 0.08em; text-transform: uppercase;
  }
```

- [ ] **Step 3: Replace the micro-label sizes in the template**

```bash
cd /Users/shawngeorgie/Projects/Room-Finder
sed -i '' 's/text-\[9px\]/text-label/g; s/text-\[10px\]/text-label/g' templates/index.html
grep -c 'text-label' templates/index.html
```

Expected: a count greater than 20.

- [ ] **Step 4: Rebuild, test, and eyeball**

```bash
npm run build:css
.venv/bin/python -m pytest tests -q
```

Expected: `122 passed`. Then reload `http://127.0.0.1:5055/` and confirm no label text wraps or overflows its container — 11px is larger than the 9px it replaces, so tight chips are where breakage would show.

- [ ] **Step 5: Commit**

```bash
git add tailwind.config.js static/tailwind.css templates/index.html
git commit -m "Establish a type scale; retire the 9px label tier

Sizes ran ad-hoc from 9px to 5xl with no scale. Collapses the 9px/10px
uppercase micro-label tier into a single 11px label — the old size was below
comfortable legibility on a phone."
```

---

## Task 5: Extract JS component helpers

`app.js` contains 91 `style.cssText` blocks and 126 hardcoded hex values. Later tasks would otherwise have to edit each string literal individually.

**Files:**
- Modify: `static/app.js` (add a helpers section after `esc()` at line 198)

**Interfaces:**
- Consumes: `--free`/`--soon`/`--busy`/`--unknown` custom properties from Task 3; `formatTime()` and `state.soonThresholdMins`, both already in `app.js`.
- Produces:
  - `roomStatus(room) -> {kind: 'free'|'soon'|'busy', text: string, cssVar: string}`
  - `statusPill(room) -> HTMLSpanElement`
  - `groupLabel(text) -> HTMLDivElement`

- [ ] **Step 1: Write the failing test**

Add to `tests/test_frontend_contract.py`:

```python
def test_component_helpers_exist_and_use_tokens():
    """The helpers must read colours from CSS custom properties, not hex.

    Hardcoded hex in JS-generated markup is why the palette drifted to 126
    hand-typed values in the first place.
    """
    js = open(APP_JS, encoding='utf-8').read()
    for fn in ('function roomStatus', 'function statusPill', 'function groupLabel'):
        assert fn in js, f"missing helper: {fn}"

    start = js.index('function roomStatus')
    end = js.index('// ── Global search')
    helpers = js[start:end]
    assert 'var(--free)' in helpers
    assert 'var(--soon)' in helpers
    assert 'var(--busy)' in helpers
    assert not re.search(r'#[0-9a-fA-F]{6}', helpers), \
        "component helpers must use var(--token), not hardcoded hex"
```

- [ ] **Step 2: Run it to verify it fails**

```bash
.venv/bin/python -m pytest tests/test_frontend_contract.py::test_component_helpers_exist_and_use_tokens -v
```

Expected: FAIL with `missing helper: function roomStatus`.

- [ ] **Step 3: Add the helpers**

In `static/app.js`, immediately after the `esc()` definition on line 198, insert:

```javascript
// ── Component helpers ──────────────────────────────────────────────────────
// app.js builds most of its UI as inline style strings. These read colour
// from the :root custom properties in index.html so the palette lives in one
// place rather than being retyped at every call site.

function roomStatus(room) {
  if (room.empty === false) {
    return { kind: 'busy', text: 'In use', cssVar: 'var(--busy)' };
  }
  const mins = room.minutes_until_next;
  if (mins !== null && mins !== undefined && mins <= state.soonThresholdMins) {
    return { kind: 'soon', text: formatTime(mins), cssVar: 'var(--soon)' };
  }
  return { kind: 'free', text: formatTime(mins), cssVar: 'var(--free)' };
}

function statusPill(room) {
  const st = roomStatus(room);
  const el = document.createElement('span');
  el.className = 'label';
  el.style.cssText = `color:${st.cssVar};white-space:nowrap;flex-shrink:0`;
  el.textContent = st.text;
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
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
.venv/bin/python -m pytest tests -q
```

Expected: `123 passed`.

- [ ] **Step 5: Commit**

```bash
git add static/app.js tests/test_frontend_contract.py
git commit -m "Extract roomStatus/statusPill/groupLabel helpers

app.js carried 91 inline style blocks and 126 hardcoded hex values. These
helpers read from the :root custom properties so the availability palette
lives in one place. A test enforces no hex inside them."
```

---

## Task 6: Home map hero — markup and layout

Replaces the dashboard's below-the-fold `dash-map-container` panel with a hero at the top of the home screen.

**Files:**
- Modify: `templates/index.html:262-330` (the `view-dashboard` block)

**Interfaces:**
- Consumes: radius and colour tokens from Tasks 2–3.
- Produces: elements `#home-hero`, `#home-hero-map`, `#home-hero-stat`; removes `#dash-map-container`.

- [ ] **Step 1: Add the hero markup**

In `templates/index.html`, inside `<div id="view-dashboard" ...>` and immediately after the opening `<div id="finder-home" ...>` wrapper, insert the hero as the **first child** (before the no-classes banner):

```html
      <!-- Campus map hero: the first thing on the home screen. A tap target,
           not a manipulable map — drag and zoom belong to the Map tab, and
           enabling them here would steal the page's scroll on touch. -->
      <button id="home-hero" type="button" onclick="switchView('map')"
              aria-label="Open the full campus map"
              class="relative w-full h-[38vh] min-h-[220px] max-h-[340px] mt-4 rounded-xl overflow-hidden border border-primary/20 block text-left">
        <div id="home-hero-map" class="absolute inset-0 z-0"></div>
        <div class="absolute inset-x-0 bottom-0 z-10 flex items-end justify-between gap-3 p-4
                    bg-gradient-to-t from-[#080808]/95 via-[#080808]/60 to-transparent pointer-events-none">
          <div>
            <div class="label text-primary mb-1">Campus now</div>
            <div id="home-hero-stat" class="text-title text-white">-- rooms free</div>
          </div>
          <span class="label text-on-surface-variant whitespace-nowrap">Open map &rarr;</span>
        </div>
      </button>
```

- [ ] **Step 2: Remove the old dashboard map panel**

In the same file, delete the entire `<!-- CAMPUS MAP (replaces heatmap) -->` block — the `<div class="col-span-12 xl:col-span-9 glass-card ...">` containing `<div id="dash-map-container" class="absolute inset-0"></div>` and its overlay header. It runs roughly from the comment to the closing `</div>` after `dash-map-container`.

- [ ] **Step 3: Run the contract test to catch the orphan**

```bash
.venv/bin/python -m pytest tests/test_frontend_contract.py -v
```

Expected: FAIL — `app.js reads elements that the template does not define: dash-map-container`. This is the guard rail working: `initDashMap()` still references the element you removed. Task 7 rewrites that function.

- [ ] **Step 4: Commit the markup**

```bash
git add templates/index.html
git commit -m "Add the home map hero markup; remove the dashboard map panel

The map moves from a below-the-fold dashboard card to the first thing on the
home screen. The contract test now fails on dash-map-container until
initDashMap is rewritten in the next commit."
```

---

## Task 7: Home map hero — Leaflet instance

`initDashMap()` currently binds to the removed `dash-map-container` and enables scroll-wheel zoom on click. The hero needs a different contract: non-interactive, and `invalidateSize()` after layout settles or it renders blank.

**Files:**
- Modify: `static/app.js:1353-1367` (`initDashMap`), `static/app.js:2200` (`init`), `static/app.js` (`fetchBuildings`)

**Interfaces:**
- Consumes: `makeTileLayers(map)`, `updateBuildingMarkers(map, markersObj, buildings)`, `state.buildingsData`, `state.dashMap`, `state.dashMarkers` — all already in `app.js`.
- Produces: `initHomeHeroMap()`, `updateHomeHeroStat(buildings)`. Removes `initDashMap()`.

- [ ] **Step 1: Replace initDashMap with initHomeHeroMap**

In `static/app.js`, replace the whole `initDashMap()` function with:

```javascript
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
    updateBuildingMarkers(state.dashMap, state.dashMarkers, state.buildingsData);
  }
  // A Leaflet map sized by the layout renders blank until it re-measures.
  setTimeout(() => { if (state.dashMap) state.dashMap.invalidateSize(); }, 60);
}

function updateHomeHeroStat(buildings) {
  const free = buildings.reduce((s, b) => s + b.empty_rooms, 0);
  setText('home-hero-stat', free === 1 ? '1 room free' : `${free} rooms free`);
}
```

- [ ] **Step 2: Update the call sites**

In `init()` (around line 2200), replace:

```javascript
  initDashMap(); // init dashboard map after data is loaded
```

with:

```javascript
  initHomeHeroMap(); // hero map needs data loaded for its markers
```

In `fetchBuildings()`, after the existing `updateStats(data);` line, add:

```javascript
    updateHomeHeroStat(data);
```

Then confirm no `initDashMap` references remain:

```bash
grep -n "initDashMap\|dash-map-container" static/app.js
```

Expected: no output.

- [ ] **Step 3: Run the contract test to verify it passes again**

```bash
.venv/bin/python -m pytest tests -q
```

Expected: `123 passed` — the `dash-map-container` orphan from Task 6 is resolved.

- [ ] **Step 4: Verify the hero renders in a browser**

Start the app on port 5055, open it, and confirm: the hero shows satellite tiles with coloured building pins, the caption reads a real room count, tapping it opens the Map view, and **scrolling the page over the hero scrolls the page** rather than panning the map.

- [ ] **Step 5: Commit**

```bash
git add static/app.js
git commit -m "Bind the home hero to its own inert Leaflet instance

Replaces initDashMap. Dragging, zoom, and keyboard control are all off so the
hero cannot capture page scroll on touch; the whole hero is one tap target to
the full Map view. invalidateSize after layout or Leaflet renders it blank."
```

---

## Task 8: Buildings grid

Replaces the Live Room Feed, Currently Available Rooms, and Available Room Directory — three renderings of one dataset — with a single building-first grid.

**Files:**
- Modify: `templates/index.html` (dashboard grid area), `static/app.js` (new `renderBuildingsGrid`)

**Interfaces:**
- Consumes: `state.buildingsData` (array of `{building, empty_rooms, occupied_rooms, total_rooms, occupancy_pct}`), `buildingName(code)`, `openBuildingPanel(buildingData)`, `esc()`.
- Produces: `renderBuildingsGrid(buildings)`, element `#buildings-grid`.

- [ ] **Step 1: Add the container to the template**

In `templates/index.html`, replace the `<div class="grid grid-cols-12 gap-6">` dashboard grid block (containing the Live Room Feed, Best Rooms, Currently Available Rooms, and Available Room Directory cards) with:

```html
      <div>
        <div class="flex items-center justify-between gap-3 mb-4">
          <h2 class="text-title text-white">Buildings</h2>
          <div id="buildings-controls" class="flex items-center gap-2"></div>
        </div>
        <div id="buildings-grid" class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2"></div>
      </div>
```

- [ ] **Step 2: Run the contract test to see which references orphan**

```bash
.venv/bin/python -m pytest tests/test_frontend_contract.py -v
```

Expected: FAIL listing `live-feed`, `dash-rooms`, `dash-building-filter`, `rooms-table-body`, `table-count`, `dash-best-rooms`. Note this list — Step 4 deletes exactly these render functions.

- [ ] **Step 3: Add renderBuildingsGrid**

In `static/app.js`, add near the other render functions:

```javascript
function renderBuildingsGrid(buildings) {
  const container = $('buildings-grid');
  if (!container) return;
  container.textContent = '';

  const visible = state.hideFullBuildings
    ? buildings.filter(b => b.empty_rooms > 0)
    : buildings.slice();

  visible.sort((a, b) => b.empty_rooms - a.empty_rooms);

  if (!visible.length) {
    const empty = document.createElement('div');
    empty.className = 'label';
    empty.style.cssText = 'color:var(--muted);padding:32px 4px;text-align:center';
    empty.textContent = 'No buildings have free rooms right now';
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

    const freePct = b.total_rooms ? Math.round(b.empty_rooms / b.total_rooms * 100) : 0;
    card.innerHTML = `
      <div style="width:52px;flex:none;font-family:'Space Grotesk',sans-serif;font-size:15px;font-weight:700;color:var(--text)">${esc(b.building)}</div>
      <div style="flex:1;min-width:0">
        <div style="font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(buildingName(b.building))}</div>
        <div style="height:4px;border-radius:9999px;background:rgba(255,255,255,0.07);margin-top:7px;overflow:hidden">
          <div style="height:100%;width:${freePct}%;border-radius:9999px;background:var(--free)"></div>
        </div>
      </div>
      <div style="text-align:right;flex:none">
        <div style="font-family:'Space Grotesk',sans-serif;font-size:17px;font-weight:700;font-variant-numeric:tabular-nums;color:var(--free);line-height:1.15">${b.empty_rooms}</div>
        <div class="label" style="color:var(--faint)">of ${b.total_rooms}</div>
      </div>`;
    container.appendChild(card);
  });
}
```

Add the state field — in the `state` object near line 51, after `soonThresholdMins`:

```javascript
  hideFullBuildings: true,  // hide buildings with nothing free (home grid)
```

Wire it into `fetchBuildings()`, after `updateHomeHeroStat(data);`:

```javascript
    renderBuildingsGrid(data);
```

- [ ] **Step 4: Delete the render functions whose targets are gone**

In `static/app.js`, delete these functions entirely and every call site of each: `renderLiveFeed`, `renderDashRooms`, `renderRoomsTable`, `renderDashBuildingFilter`. Leave `renderDashBestRooms` and `renderSidebarTopRooms` **only if** their target elements still exist in the template; the contract test in Step 5 is the arbiter.

```bash
grep -n "renderLiveFeed\|renderDashRooms\|renderRoomsTable\|renderDashBuildingFilter" static/app.js
```

Expected after deletion: no output.

- [ ] **Step 5: Run the tests**

```bash
.venv/bin/python -m pytest tests -q
```

Expected: `123 passed`. If the contract test still lists an orphan, delete that render function and its call sites too.

- [ ] **Step 6: Commit**

```bash
git add templates/index.html static/app.js
git commit -m "Replace the dashboard panels with a building-first grid

Live Room Feed, Currently Available Rooms, and Available Room Directory were
three renderings of one dataset competing for the home screen. One grid
replaces them; the flat room list remains at view=rooms."
```

---

## Task 9: Hide-full toggle and sort control

**Files:**
- Modify: `static/app.js` (new `renderBuildingsControls`)

**Interfaces:**
- Consumes: `state.hideFullBuildings` (Task 8), `renderBuildingsGrid(buildings)` (Task 8), `state.buildingsData`, `announce(msg)`.
- Produces: `renderBuildingsControls(buildings)`, `toggleHideFull()`.

- [ ] **Step 1: Add the controls renderer**

In `static/app.js`, immediately after `renderBuildingsGrid`:

```javascript
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

  const count = document.createElement('span');
  count.className = 'label';
  count.style.cssText = 'color:var(--faint);white-space:nowrap';
  const shown = on ? buildings.filter(b => b.empty_rooms > 0).length : buildings.length;
  count.textContent = `${shown} shown`;
  container.appendChild(count);
}
```

Wire it into `fetchBuildings()`, immediately before the `renderBuildingsGrid(data);` line:

```javascript
    renderBuildingsControls(data);
```

- [ ] **Step 2: Run the tests**

```bash
.venv/bin/python -m pytest tests -q
```

Expected: `123 passed`.

- [ ] **Step 3: Verify the toggle behaves**

Open the app on port 5055 during a busy weekday window so some buildings are full:

```
http://127.0.0.1:5055/?day=Tuesday&at=14:05
```

Confirm: the toggle starts on, full buildings are hidden, the "N shown" count matches the visible cards, clicking flips both, and the control is at least 44px tall.

- [ ] **Step 4: Commit**

```bash
git add static/app.js
git commit -m "Add the hide-full toggle and shown-count to the buildings grid"
```

---

## Task 10: Three-tab navigation and URL aliases

**Files:**
- Modify: `templates/index.html` (bottom nav, sidebar, header gear), `static/app.js` (`switchView`, `restoreStateFromURL`)

**Interfaces:**
- Consumes: `switchView(view)`, `restoreStateFromURL()`, `syncURL()` — all already in `app.js`.
- Produces: elements `#mob-nav-buildings`, `#mob-nav-map`, `#mob-nav-saved`, `#nav-buildings`, `#nav-map`, `#nav-saved`, `#hdr-settings`; `view=buildings` aliases to `dashboard`.

- [ ] **Step 1: Write the failing test**

Add to `tests/test_frontend_contract.py`:

```python
def test_all_shareable_view_values_are_still_handled():
    """Shared links are an advertised feature; these four must keep working."""
    js = open(APP_JS, encoding='utf-8').read()
    start = js.index('function restoreStateFromURL')
    body = js[start:start + 2500]
    for view in ('dashboard', 'rooms', 'map', 'settings'):
        assert f"'{view}'" in body, f"view={view} no longer handled"
    assert "'buildings'" in body, "view=buildings alias missing"
```

- [ ] **Step 2: Run it to verify it fails**

```bash
.venv/bin/python -m pytest tests/test_frontend_contract.py::test_all_shareable_view_values_are_still_handled -v
```

Expected: FAIL with `view=buildings alias missing`.

- [ ] **Step 3: Add the alias**

In `static/app.js`, in `restoreStateFromURL()`, replace:

```javascript
  if (view && ['dashboard','rooms','map','settings'].includes(view)) {
```

with:

```javascript
  // 'buildings' is the new name for the home view; 'dashboard' is kept so
  // links shared before the redesign keep working.
  if (view === 'buildings') view = 'dashboard';
  if (view && ['dashboard','rooms','map','settings'].includes(view)) {
```

And at the top of `switchView(view)`:

```javascript
function switchView(view) {
  if (view === 'buildings') view = 'dashboard';
```

- [ ] **Step 4: Replace the mobile bottom nav**

In `templates/index.html`, replace the five-button `<nav class="fixed bottom-0 ...">` with:

```html
<nav class="fixed bottom-0 left-0 right-0 bg-[#0a0a0a]/98 backdrop-blur-md border-t border-primary/10 flex md:hidden z-50"
     aria-label="Primary"
     style="padding-bottom:env(safe-area-inset-bottom);height:calc(3.5rem + env(safe-area-inset-bottom))">
  <button id="mob-nav-buildings" type="button" onclick="switchView('dashboard')" aria-label="Buildings"
          class="flex-1 flex flex-col items-center justify-center gap-0.5 py-2">
    <span class="material-symbols-outlined" style="font-size:20px;color:#3fff8b">grid_view</span>
    <span class="label" style="color:#3fff8b">Buildings</span>
  </button>
  <button id="mob-nav-map" type="button" onclick="switchView('map')" aria-label="Map"
          class="flex-1 flex flex-col items-center justify-center gap-0.5 py-2">
    <span class="material-symbols-outlined" style="font-size:20px;color:#adaaaa">map</span>
    <span class="label" style="color:#adaaaa">Map</span>
  </button>
  <button id="mob-nav-saved" type="button" onclick="switchView('rooms')" aria-label="Saved rooms"
          class="flex-1 flex flex-col items-center justify-center gap-0.5 py-2">
    <span class="material-symbols-outlined" style="font-size:20px;color:#adaaaa">star</span>
    <span class="label" style="color:#adaaaa">Saved</span>
  </button>
</nav>
```

> The Saved tab points at `view=rooms` for now. A dedicated saved-rooms view is slice 4; this keeps the tab honest rather than dead.

- [ ] **Step 5: Update the desktop sidebar and add the header gear**

Replace the sidebar `<nav>` items with `Buildings` (`nav-buildings` → `switchView('dashboard')`), `Map` (`nav-map`), and `Saved` (`nav-saved` → `switchView('rooms')`), keeping the existing `active-nav` class pattern. Add the settings gear to the header's right-hand group:

```html
    <button id="hdr-settings" type="button" onclick="switchView('settings')" aria-label="Settings"
            class="w-11 h-11 rounded-full bg-surface-container border border-outline-variant/20 flex items-center justify-center text-on-surface-variant hover:text-primary">
      <span class="material-symbols-outlined">settings</span>
    </button>
```

Then update `switchView`'s nav-highlighting loop so it targets the new ids (`nav-buildings`/`mob-nav-buildings` for `dashboard`, `nav-saved`/`mob-nav-saved` for `rooms`).

- [ ] **Step 6: Run the tests**

```bash
.venv/bin/python -m pytest tests -q
```

Expected: `124 passed`.

- [ ] **Step 7: Verify every shared-link form still resolves**

Load each and confirm the right view opens:

```
http://127.0.0.1:5055/?view=dashboard
http://127.0.0.1:5055/?view=buildings
http://127.0.0.1:5055/?view=rooms
http://127.0.0.1:5055/?view=map
http://127.0.0.1:5055/?view=settings
```

- [ ] **Step 8: Commit**

```bash
git add templates/index.html static/app.js tests/test_frontend_contract.py
git commit -m "Collapse navigation to Buildings / Map / Saved

Five mobile tabs become three; settings moves to a header gear. view=buildings
aliases to dashboard so links shared before the redesign keep resolving, and a
test now guards all five URL forms."
```

---

## Task 11: Building detail — floor grouping with in-use rooms visible

Approved in the demo: group rooms by floor with headers, and show in-use rooms greyed rather than hiding them, so the list conveys the building's size.

**Files:**
- Modify: `static/app.js` (`renderRoomGrid`, called from `openBuildingPanel`)

**Interfaces:**
- Consumes: `roomStatus(room)` and `groupLabel(text)` (Task 5), `state.floorRoomsData`, `openRoomDetail(building, room)`, `esc()`.
- Produces: `renderRoomsByFloor(rooms)`.

- [ ] **Step 1: Add the floor-grouped renderer**

In `static/app.js`:

```javascript
// Rooms grouped by floor. In-use rooms stay visible but dimmed — hiding them
// leaves a suspiciously short list with no sense of the building's size.
function renderRoomsByFloor(rooms) {
  const container = $('floor-rooms');
  if (!container) return;
  container.textContent = '';

  const floors = [...new Set(rooms.map(r => r.floor))].sort((a, b) => a - b);
  const frag = document.createDocumentFragment();

  floors.forEach(floor => {
    const onFloor = rooms.filter(r => r.floor === floor);
    const freeCount = onFloor.filter(r => r.empty !== false).length;

    const head = document.createElement('div');
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
      btn.appendChild(statusPill(room));
      frag.appendChild(btn);
    });
  });

  container.appendChild(frag);
}
```

- [ ] **Step 2: Call it from openBuildingPanel**

In `openBuildingPanel`, in the `.then(rooms => {...})` block, replace:

```javascript
      buildFloorTabs(floors, rooms);
      renderRoomGrid(rooms, state.mapFloor);
```

with:

```javascript
      renderRoomsByFloor(rooms);
```

Then delete `buildFloorTabs` and `renderRoomGrid` **only if** nothing else calls them:

```bash
grep -n "buildFloorTabs\|renderRoomGrid" static/app.js
```

If `#floor-tabs` becomes unused, remove it from the template too — the contract test will confirm.

- [ ] **Step 3: Run the tests**

```bash
.venv/bin/python -m pytest tests -q
```

Expected: `124 passed`.

- [ ] **Step 4: Verify against a real building**

Open `http://127.0.0.1:5055/?day=Tuesday&at=14:05`, tap KUPF, and confirm against known data: 1st floor shows 5 free (105/106/107/108 at ~25 min in amber, 129 free all day in green) and 4 in use dimmed; 2nd floor shows 4 free including 211 and 208 in green.

- [ ] **Step 5: Commit**

```bash
git add static/app.js templates/index.html
git commit -m "Group building detail by floor; keep in-use rooms visible

Floor tabs become floor sections, so a whole building reads at once. In-use
rooms are dimmed rather than hidden — hiding them left a short list that gave
no sense of the building's size."
```

---

## Task 12: Full-pass verification

**Files:** none modified — this is the gate before review.

- [ ] **Step 1: Full test suite**

```bash
.venv/bin/python -m pytest tests -q
```

Expected: `124 passed`.

- [ ] **Step 2: Confirm the CSS artifact is in sync**

```bash
npm run build:css && git diff --stat static/tailwind.css
```

Expected: **no diff.** A diff here means a token change was committed without its rebuild, and production would not match.

- [ ] **Step 3: Syntax-check the JS**

```bash
node --check static/app.js && echo "app.js OK"
```

- [ ] **Step 4: Confirm no hardcoded hex crept into new code**

```bash
git diff pre-redesign..HEAD -- static/app.js | grep '^+' | grep -c '#[0-9a-fA-F]\{6\}'
```

Expected: a small number, and every hit should be inside `updateBuildingMarkers` (Leaflet needs literal colours for canvas markers). Any hit in new render code should become `var(--token)`.

- [ ] **Step 5: Walk the app on a phone-width viewport**

At 390px wide, confirm: hero renders with pins and does not trap scroll; buildings grid is one column; hide-full toggle works and is ≥44px; tapping a building opens floor-grouped detail; the three-tab bar sits above the safe area; search still opens and returns grouped results.

- [ ] **Step 6: Confirm the revert path still works**

```bash
git stash list && git tag -l pre-redesign && git log --oneline pre-redesign..HEAD | wc -l
```

Expected: the tag exists and the commit count matches the tasks completed.

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| Radius scale repair | 2 |
| Colour prune + `free`/`soon`/`busy`/`unknown` | 3 |
| Type scale, 9px tier retired | 4 |
| CSS custom properties for JS markup | 3 |
| Component helpers | 5 |
| Spacing rhythm | 4, 8 (standard card padding in the grid) |
| Map hero on home | 6, 7 |
| Buildings grid, most-free sort | 8 |
| Hide-full toggle | 9 |
| Three-tab nav, settings gear | 10 |
| URL compatibility incl. `buildings` alias | 10 |
| Building detail floor grouping | 11 |
| In-use rooms greyed not hidden | 11 |
| Occupancy bar over percentage | 8 |
| DOM smoke test | 1 |
| 120 Python tests stay green | every task |

**Deferred to later slices, intentionally:** nearest-to-me sort (needs the geolocation opt-in flow, slice 4), the heatmap's move into building detail (slice 3), the dedicated Saved view (slice 4 — Task 10 points the tab at `view=rooms` in the meantime), and the planning sheet (slice 5). None of these are in slices 1–2.

**Placeholder scan:** no TBDs; every code step carries the actual code.

**Type consistency:** `roomStatus()` returns `{kind, text, cssVar}` in Task 5 and is consumed with those exact fields in Tasks 5 and 11. `renderBuildingsGrid(buildings)` is defined in Task 8 and called in Tasks 8 and 9. `state.hideFullBuildings` is introduced in Task 8 and read in Tasks 8 and 9. `initHomeHeroMap()` replaces `initDashMap()` in Task 7, with all call sites updated in the same task.

**Known risk:** Tasks 6 and 8 each land the template edit before the matching `app.js` edit, so the contract test is intentionally red between them. That is by design — the failure names exactly which render functions to delete — but it means those two commits are not independently green. If you need every commit green, merge Task 6 into 7 and Task 8's steps 1–4 into one commit.
