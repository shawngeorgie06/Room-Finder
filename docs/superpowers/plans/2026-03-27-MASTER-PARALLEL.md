# NJIT Room Finder — Parallel Feature Sprint

## Overview

5 independent features, each in its own plan file. Run each in a separate Claude Code session (or agent) simultaneously. They touch different parts of the codebase with minimal overlap.

---

## Feature Plans

| # | Feature | Plan File | Files Touched | Backend? | Conflicts with |
|---|---------|-----------|---------------|----------|----------------|
| 1 | Global Room Search | `2026-03-27-global-room-search.md` | `app.js`, `index.html` (header + mobile nav) | None | Plan 4 (both add to header) |
| 2 | Next Free Slot | `2026-03-27-next-free-slot.md` | `app.py`, `app.js`, `index.html` (modal) | Yes — `app.py` | None |
| 3 | Shareable URL | `2026-03-27-shareable-url.md` | `app.js`, `index.html` (filter bar) | None | Plan 5 (both touch filter bar) |
| 4 | Auto-Refresh Countdown | `2026-03-27-auto-refresh-countdown.md` | `app.js`, `index.html` (sidebar + header) | None | Plan 1 (both touch header) |
| 5 | Busy-Soon Threshold | `2026-03-27-busy-soon-threshold.md` | `app.js`, `index.html` (filter bar) | None | Plan 3 (both touch filter bar) |

---

## Merge Order (to avoid conflicts)

Plans 1 & 4 both touch the header. Plans 3 & 5 both touch the filter bar. Suggested merge sequence:

```
Wave A (fully independent — merge in any order):
  Plan 2 — Next Free Slot     (only touches app.py + modal)

Wave B (merge one at a time in this order):
  Plan 1 — Global Room Search  (header input)
  Plan 4 — Auto-Refresh Countdown  (sidebar + header countdown — after Plan 1 so header edits don't clash)
  Plan 3 — Shareable URL       (filter bar + syncURL)
  Plan 5 — Busy-Soon Threshold (filter bar dropdown — after Plan 3 so syncURL is in place)
```

---

## Running Parallel Sessions

Each session needs:

```bash
cd /path/to/njit-empty-rooms
# Start fresh Claude Code session per feature
# Open the plan file and follow superpowers:subagent-driven-development or superpowers:executing-plans
```

Each plan is fully self-contained — the agent will know exactly which files to touch, what to write, and how to test.

---

## Integration Test After All Merges

After all 5 branches are merged, manually verify these combined flows:

- [ ] Search "207" → rooms view shows filtered results → copy share link → open in new tab → same results
- [ ] Change busy-soon to 15 min → amber cards reduce → countdown visible → refresh fires at 0s → counts reset
- [ ] Click occupied room → modal shows next free window → time is correct based on today's schedule
- [ ] Set time filter 14:00 + building KUPF → URL updates → open new tab → same filter restored
