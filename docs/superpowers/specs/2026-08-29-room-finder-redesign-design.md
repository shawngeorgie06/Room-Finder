# NJIT Room Finder — Visual Redesign

**Date:** 2026-08-29
**Status:** Approved, ready for implementation planning
**Baseline:** tag `pre-redesign` (commit `9a816c8`)
**Branch:** `redesign`

## Goal

Modernize the UI, make it mobile-first, and make it legible to a student
opening it for the first time — without losing any existing capability.

The app is feature-rich: gap finder, day and time override, busyness
heatmaps, pinned rooms, floor grids, shareable URLs, PWA install. The
problem is not that it does too little. It is that the home screen shows a
first-time visitor five competing panels and no obvious first move. This
redesign sequences what already exists; it does not remove features.

## Non-goals

- No backend, API, or schedule-parsing changes.
- No change to the visual identity. The neon-dark language (`#080808`
  background, `#3fff8b` primary) is kept deliberately; the work is
  execution, not repainting.
- No new features. Every screen below is built from data the API already
  returns.

## Constraints

- `static/tailwind.css` is a **committed build artifact**. Any token change
  requires `npm run build:css`, and the rebuilt CSS must land in the same
  commit or the change silently does not apply in production.
- Shareable URLs are an advertised feature. All four existing `view=` values
  (`dashboard`, `rooms`, `map`, `settings`) must keep working.
- `master` deploys to Render. All work stays on `redesign` until explicitly
  approved for merge.
- Single Flask worker; uploads mutate in-process state. Irrelevant to this
  work but constrains any future backend change.

## Revert policy

Three levels, by explicit user request:

1. Work is isolated on `redesign`; `master` is untouched.
2. Tag `pre-redesign` pins the known-good state. `git reset --hard
   pre-redesign` restores everything.
3. Each section below is its own commit, so a single section can be reverted
   without losing the others.

The user can say "revert" at any point and the work returns to the tag.

---

## Section 1 — Foundation layer

### Measured problems

Evidence gathered from the current tree:

| Finding | Count |
|---|---|
| Color tokens defined in `tailwind.config.js` | ~50 |
| Color tokens actually referenced in `index.html` / `app.js` | 19 |
| Hardcoded hex values in `app.js` inline styles | 126 |
| `style.cssText` blocks in `app.js` | 91 |
| `rounded-full` usages rendering as ~12px | 14 |

The most-repeated hardcoded values are `#3fff8b` (44), `#adaaaa` (25),
`#767575` (21), `#ff7166` (14), `#f59e0b` (13) — the token palette, retyped
by hand at each call site because tokens were not reachable from
JS-generated markup.

### Changes

**Radius.** `borderRadius.full` is currently `0.75rem`, so every
`rounded-full` in the app renders as a small rounded rectangle instead of a
circle. Fix to `9999px`. Open the scale: `sm: 4px`, `DEFAULT: 6px`, `lg:
10px`, `xl: 14px`, `2xl: 20px`. Currently `xl` caps at `0.5rem`, so nothing
in the app is capable of looking soft. This is the single highest-leverage
change in the redesign.

**Colors.** Prune to the 19 live tokens. Add semantic tokens for the domain
concept the app actually reasons about — room availability:

- `free` — `#3fff8b`
- `soon` — `#f59e0b` (within the configurable closing-soon threshold)
- `busy` — `#ff7166`
- `unknown` — `#767575`

These four are currently invented ad-hoc at each call site.

**Type.** Three families exist (Space Grotesk for headline and label,
Manrope for body) with no scale; sizes run ad-hoc from `9px` to `5xl`. Adopt
an explicit scale:

| Role | Size / weight |
|---|---|
| `display` | 32px / 800 — screen titles |
| `title` | 20px / 700 — card and sheet headers |
| `body` | 15px / 400 |
| `data` | 18px / 800 tabular — room numbers, counts |
| `label` | 11px / 600, `0.08em` tracking, uppercase |

Collapse the `9px`/`10px` uppercase-tracked micro-label tier into the single
`label` size. After the radius, that tier is the most dated element in the
app, and `9px` uppercase text is below comfortable legibility on a phone.

**Spacing.** No rhythm today; card padding varies `p-3`/`p-4`/`p-5`/`p-6`
with no logic. Establish a 4px base and one standard card padding.

**JS component seam.** Expose tokens as CSS custom properties on `:root` so
inline-style blocks can use `var(--free)` rather than `#3fff8b`. Then
collapse the repeated blocks into helpers — `roomCard()`, `statusPill()`,
`groupLabel()`. This must happen before the screen work, so later sections
do not have to edit 91 separate string literals.

### Blast radius

Visually a no-op except the radius fix, which softens the entire app in one
commit. That is intended. Verification is a full visual pass, not a test
run.

---

## Section 2 — Information architecture

### Screens

**Buildings (home).** Grid of 18 building cards: code, full name, live free
count (`20 free of 32`), status bar. Two controls — a *hide buildings with
nothing free* toggle, and a sort (*most free* default, *nearest to me* when
geolocation is granted). One prominent **Find me a room** action above the
grid for students who do not want to choose.

**Building detail.** Replaces the current floor panel. Rooms grouped by
floor with real headers; each room shows number, status, time remaining. The
weekly busyness **heatmap moves here**, where it is contextual, rather than
sitting campus-wide on the home screen.

**Map.** The existing Leaflet campus map, essentially unchanged. It stops
being duplicated on the home screen.

**Saved.** Pinned rooms. Currently a `★` on room cards with no home of its
own. A tab makes the app stateful for returning students at near-zero cost.

**Room detail.** Existing bottom sheet (timeline, class list, next free
window), restyled.

**Planning sheet.** Day override, time override, and "free during my gap"
consolidated into one sheet reachable from the header. All three answer the
same question: *not now, but when?* Today they are split between the
settings view and the Find-a-Room modal.

**Settings.** Header gear. Threshold config, schedule info, PWA controls.

### Navigation

- Mobile bottom bar: **Buildings / Map / Saved**. Three targets.
- Search lives in the always-visible header field (shipped in PR #2). It
  does not need a tab.
- Settings is a header gear, not a tab.

### URL compatibility

All four `view=` values keep working. `buildings` aliases to `dashboard`.
Existing shared links must not break.

### Demotions (nothing deleted)

| Element | Destination |
|---|---|
| Live Room Feed | Folded into the buildings grid's live counts |
| Currently Available Rooms | The `rooms` view already does this |
| Available Room Directory | Same — third copy of one dataset |
| Dashboard embedded map | The Map tab |

The three-way duplication resolves by consolidation: one flat room list at
`view=rooms`, reachable but not competing for the home screen.

---

## Section 3 — Mobile behavior and verification

### Mobile

- Bottom bar respects `env(safe-area-inset-bottom)` (already correct; keep).
- Header keeps the always-visible search plus the settings gear. The `/`
  hint stays desktop-only.
- Building detail and room detail are bottom sheets on mobile, side panels
  on desktop. Room detail already works this way; building detail follows
  the existing pattern rather than inventing one.
- Minimum 44px tap targets. Current offenders: the `9px`/`10px` micro-label
  chips and the `w-9 h-9` header buttons.
- `body` currently carries `overflow-x-hidden`, which masks layout overflow
  rather than preventing it. Fix the causes; keep the guard as a backstop.

### Verification

The repo has 120 passing Python tests and **zero frontend tests**, while
100% of this redesign is frontend. That asymmetry is why PR #3 could delete
five dashboard panels and still look green.

1. **DOM smoke test per screen.** Drive the running app through lightpanda
   and assert what a screenshot cannot: that every element `app.js` writes
   into still exists after the HTML is restructured, that nav switches
   views, that the buildings grid populates. This catches orphaned render
   targets — PR #3's exact failure mode.
2. **The 120 Python tests** stay green, guarding API contracts.
3. **Per-section visual review** by the user. Taste is not automatable.

**Known limit:** lightpanda is text-only. It verifies structure and
behavior, not appearance. Nothing automated can confirm the spacing looks
right; that is a human checkpoint at each slice, and the reason to ship in
slices rather than one reveal.

---

## Sequence

1. Foundation (tokens, radius, type, spacing, JS component seam)
2. Buildings home
3. Building detail
4. Map and Saved
5. Planning sheet and Settings
6. Polish pass

Each slice is a separate commit on `redesign`, independently revertable, and
reviewed by the user before the next begins.

## Open questions

None. All design decisions resolved during brainstorming.

## Related work

- PR #3 (`cursor/collapse-nav-finder-explore-49ef`) remains open. It
  proposed a Finder/Explore nav collapse. Its good ideas — two-job framing,
  three-item mobile bar, settings-as-gear — are folded into Section 2. Its
  approach of deleting five dashboard panels is deliberately not adopted.
  The PR should be closed once Section 2 lands, superseded.
