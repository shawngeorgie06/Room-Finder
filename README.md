# NJIT Room Finder

Find empty classrooms at NJIT in real time. Shows which rooms are currently unoccupied, how long until the next class, and lets you plan ahead by checking any day or time.

Live at: [https://room-finder.onrender.com](https://room-finder.onrender.com) *(replace with your Render URL)*

---

## Features

**Room Discovery**
- Live room availability based on current Eastern time
- Filter by building, minimum free duration, or day of week
- "Free All Day" filter — rooms with zero classes remaining
- Global search — type a room number to find it across all buildings
- Room capacity shown on every card (pulled from schedule data)

**Planning Ahead**
- Day override — check any day of the week (Mon–Sun)
- Time override — see which rooms will be free at a specific time
- "Free during my gap" — find rooms free for an entire time window (Find a Room modal)
- Next free slot — room detail shows when an occupied room opens up
- Weekly busyness heatmap per building — see which hours are quiet
- Future day + time combos fully supported

**Navigation**
- Campus map with live occupancy color coding per building
- Per-building room grid, grouped by floor when `data/campus_metadata.json` records
  one (the shipped seed records no rooms, so every room reads "Floor not recorded")
- Room detail sheet — daily timeline, class list, next free window
- Press `/` anywhere to jump to room search

**UX**
- Shareable URLs — filters sync to URL params, paste to share exact view
- Auto-refresh every 60 seconds with countdown ring
- Configurable "closing soon" threshold (15 / 30 / 45 / 60 min)
- "Matching rooms" — top rooms sorted by free time, in the desktop sidebar
- Mobile bottom nav with search overlay and room detail bottom sheet
- Installable PWA — add to home screen, works offline with last-known data
- Pin favorite rooms (★ on any room card) — pinned rooms sort first
- Weekend / no-classes banner when campus is quiet
- Room detail shows the course, title, and instructor for each class block
- Semester auto-detected from the data's Term column; a warning banner appears
  when the loaded schedule is from a past semester

---

## Stack

- **Backend**: Flask (stdlib `csv` + openpyxl for parsing — no pandas), SQLite for the visitor log
- **Frontend**: Vanilla JS, Tailwind CSS (prebuilt at `static/tailwind.css`), Leaflet.js (vendored)
- **Data**: NJIT Banner SSB course schedule export (CSV or XLSX)
- **Deploy**: `Procfile` runs `gunicorn app:app` (Render-style). Run it as **one worker** — see [Persistence](#persistence-and-scaling).

---

## Install and run

Python dependencies are pinned with hashes (`requirements.txt` is compiled from
`requirements.in`; `requirements-dev.txt` from `requirements-dev.in`, which adds
`pytest` and `freezegun`). CI uses Python 3.12 and the lock files were compiled
for 3.12.

```bash
python -m pip install --require-hashes -r requirements.txt       # runtime
python -m pip install --require-hashes -r requirements-dev.txt   # runtime + tests
python app.py        # → http://localhost:5000 (debug off, binds 0.0.0.0)
```

Node is only needed for CSS/service-worker release steps and browser tests
(`npm ci`).

### Environment variables

| Variable | Effect |
|---|---|
| `UPLOAD_PASSWORD` | Secret for `POST /api/upload-schedule` and `GET /api/export-schedule`. **If unset, both endpoints return 503 (disabled)** — it is not optional for uploads. Must be printable ASCII only (else 503). |
| `ADMIN_PASSWORD` | Password for `/admin/visits` (HTTP Basic; any username). If unset, the page returns 503. Also the fallback visitor-hash salt. |
| `VISITOR_LOG_SALT` | Salt for the one-way network-address hash. Set a stable random value so hashes stay comparable across deploys (falls back to `ADMIN_PASSWORD`, then a fixed development value). |
| `VISIT_DB_PATH` | SQLite visitor log path. Default `instance/visits.sqlite3` (Flask instance folder). |
| `SCHEDULE_STORAGE_DIR` | Where uploaded schedules and the manifest are stored. Default: the app directory (next to `app.py`). |
| `TRUSTED_PROXY_HOPS` | Non-negative integer, default `0`. When >0, applies `ProxyFix` for that many proxy hops (client IP and scheme). Only set it if your ingress strips/sets `X-Forwarded-*`; an invalid value stops startup. |
| `RENDER_EXTERNAL_URL` | If set, a background thread pings `/ping` every 14 minutes (keep-alive). |

Use long random secrets (the rate limiter code recommends at least 32 printable
ASCII characters, with `UPLOAD_PASSWORD` and `ADMIN_PASSWORD` different).

**Auth behavior.** Credentials are checked in constant time. Upload/export
accept `Authorization: Bearer <UPLOAD_PASSWORD>`; the upload endpoint also
accepts a multipart `password` form field (used by the bookmarklet) when no
`Authorization` header is sent. A `?password=` query parameter is always
rejected. After 20 wrong credentials per client address (200 total) in a
60-second window, further *wrong* credentials get `429`; correct credentials
still work. This limiter is in-memory, single-process, and not brute-force
prevention. Protected endpoints (`/api/upload-schedule`, `/api/export-schedule`,
`/admin/visits`) respond with `Cache-Control: no-store` and `X-Robots-Tag: noindex, nofollow`.

---

## Updating schedule data

**Option 1 — Upload via the UI.** Use the **Settings** page to upload a CSV or XLSX
Banner export (requires `UPLOAD_PASSWORD` to be set on the server). No restart is needed.

**Option 2 — Bookmarklet.**

1. Open `/bookmarklet` **on the deployed app** (its origin is baked into the
   bookmarklet at install time).
2. Drag **Extract NJIT Schedule** to your bookmarks bar.
3. Log in to [Banner Course Schedule](https://generalssb-prod.ec.njit.edu/BannerExtensibility/customPage/page/stuRegCrseSched),
   select the term, and click the bookmarklet. It uploads to the app (prompting
   for the upload password); on failure the CSV downloads for manual upload.
   Cross-origin access (CORS) on the upload endpoint is allowed only from the Banner origin.

### How imports work

- **Accepted files**: `.csv` or `.xlsx`, at most **10 MB** per upload (larger → 413).
  The source filename must be ≤255 characters with no control characters.
- **Validation** (`schedule.py`): required columns `Days`, `Times`, `Location`,
  `Delivery Mode`; duplicate headers rejected. Limits: 50,000 rows, 128 columns,
  4,096 characters per cell, and for XLSX 64 MiB expanded size / 1,000 ZIP members.
  Days use `MTWRFSU`; times look like `1:00 PM - 2:20 PM` (end after start);
  `Max` (capacity) must be a nonnegative whole number or blank; `Term` must be a
  six-digit Banner code (…10/30/50/90) or blank. A file must contain **one term**
  (mixed terms are rejected).
- **Exclusions**: explicit online delivery modes and blank/TBA/TBD/ARR meetings are
  skipped (they say nothing about physical-room occupancy). The upload response
  reports accepted/excluded row counts. A file with no in-person entries is rejected.
- **Errors**: invalid files return `422` with up to 10 row-level diagnostics (cell
  contents are not echoed). Nothing is changed on failure.
- **Atomic snapshots**: the upload is staged, validated, written as an immutable
  `.schedule-data-<id>.csv|xlsx` file, and only then published by atomically
  replacing `.schedule-manifest.json`. A failed import (validation, parse, or
  storage error → `500`) leaves the previous schedule and files in place; a
  successful same-term import supersedes the older one in the manifest (old bytes are not deleted).
- **Corrupted manifest**: a malformed/oversized (>1 MiB) manifest is treated as an
  error, never as "empty". At startup the app falls back to legacy files only
  (`uploaded_schedule*.csv|xlsx`, `Course_Schedule_*`, `schedule_default.csv`) and
  does not adopt unreferenced `.schedule-data-*` files; while running, the active
  schedule is kept; new uploads fail with `500` until the manifest is repaired.
- **Provenance**: `/api/schedule-info` reports `imported_at` (UTC, set at publish),
  `source_filename`, `activated_at`/`loaded_at`, `schedule_version` (content hash),
  term/semester and freshness (`status`: `current`, `stale`, `future`, `unknown`;
  `in_session`). `source_exported_at` is always `null` (not recorded).
- **Term selection**: terms coexist. The active one is the current semester (Jan–Apr
  Spring, May–Jul Summer, Aug–Dec Fall), else the nearest future term, else the newest
  past term (flagged stale). It is re-evaluated on schedule/availability requests,
  so a running server rolls over automatically. Unreadable candidates are skipped.
- **Bundled data**: `schedule_default.csv` and the committed `Course_Schedule_*`
  exports are fallbacks; other `*.csv`/`*.xlsx` and `uploaded_schedule*`,
  `.schedule-*` files are git-ignored runtime artifacts.

### Export

`GET /api/export-schedule?term=202650` with `Authorization: Bearer <UPLOAD_PASSWORD>`
downloads the stored schedule for that term in its original format as
`Course_Schedule_<term>.csv|xlsx` (400 for a bad term, 404 if none stored).
`GET /api/terms` (public) lists stored terms with `active` and `status`.

### Persistence and scaling

Uploaded schedules, the manifest, and the visitor database live on the local
filesystem (`SCHEDULE_STORAGE_DIR`, `VISIT_DB_PATH`). On an ephemeral filesystem
(e.g. Render's free tier) they vanish on deploy/restart. **Mount a durable disk
and point both variables at it before changing worker counts or moving hosts.**
The app is designed for a single process: the schedule lock, active snapshot,
rate limiter, and manifest publication are all in-process. Do not run multiple
workers or replicas against it without redesigning that state. Back up/move the
storage directory (including dotfiles) and the SQLite file together when migrating.

---

## Availability model

Availability is derived **only from the class schedule**. It does not know about
room bookings, locked doors, maintenance, or opening hours, so a room shown as free
is *not guaranteed accessible*.

For a room on the queried day, class times are merged (overlapping, nested or
touching classes count as one busy block). Each room in `/api/rooms/all` carries
independent facts:

- **Currently in use** — `empty: false` when a class covers the query time (`[start, end)`).
- **Fits requested duration** — `matches_requested_window`: the room is empty now and its
  next class starts no earlier than the end of the requested window (`?for=<minutes>`,
  or an explicit `?until=HH:MM`, which takes precedence). `/api/rooms` returns only
  matching rooms. Windows cannot cross midnight (400 with an `error_code`).
- **Available after class** — `available_from_min` is the query time if free, or the end
  of the current class block if occupied; `available_until_min` is the next class start
  (`null` = no further scheduled class that day). `minutes_until_next` describes only the
  current free interval (`null` if occupied or nothing later).

Rooms appear only if they are in the active schedule. `capacity` is the largest
schedule enrollment limit seen for the room (`capacity_basis: schedule_enrollment`),
not the physical capacity. Query params: `?at=HH:MM`, `?day=Monday|0-6`, `?for=`,
`?until=`, `?building=`; times are US Eastern. Responses include `X-Schedule-Version`
and `X-Query-*` headers.

---

## Campus metadata

`data/campus_metadata.json` holds curated, schedule-independent facts and is loaded
once at startup (restart to pick up edits). A missing, malformed, or invalid file
(including duplicate keys) stops the app from starting.

- Top level: `{"schema_version": 1, "buildings": {CODE: {...}}}`.
- Building: optional `name`, `coordinates` (`lat`, `lng`, `kind: "representative"`,
  `approximate: true`, `source`, optional `verified_at`), `rooms`, plus `source`/`verified_at`
  (which describe the **name**).
- Room (keyed by exact room id, e.g. `"207"`): optional `floor` (integer or text),
  `room_type`, `access`, `amenities` (list; `[]` = none recorded), `physical_capacity`
  (nonnegative integer), `source`, `verified_at`.
- Missing facts are `null`. Any supplied fact needs a `source`; `verified_at` is a
  `YYYY-MM-DD` date or `null`. Building/room codes must match the schedule exactly
  (case-sensitive, no surrounding whitespace). Unknown fields are rejected.
- Metadata enriches rooms/buildings from the schedule; it never adds rooms. Seed
  names/coordinates are inherited from older frontend constants and are marked
  not externally verified; coordinates are approximate and not entrance directions.

---

## Release steps (CSS and offline cache)

The service worker (`static/sw.js`) caches only the public home page, a fixed list of
bundled `/static/` assets, and read-only schedule APIs (`/api/rooms`, `/api/rooms/all`,
`/api/buildings`, `/api/room/schedule`, `/api/heatmap`, `/api/terms`, `/api/schedule-info`,
with only their known query parameters). Home and APIs are network-first with
offline fallback; assets are cache-first. **Private/admin pages and endpoints
(`/admin/visits`, upload, export), map tiles, non-GET requests, requests carrying
auth headers, and any response marked `private`/`no-store` or varying on
cookie/auth are never cached** (and a later private response evicts an earlier copy).

After changing templates, `static/app.js`, or other precached files, run in order:

```bash
npm ci                    # once
npm run build:css         # regenerate static/tailwind.css
npm run update:cache      # recompute CACHE_VERSION in static/sw.js
npm run check:css         # verify CSS is current
npm run check:cache       # verify the cache fingerprint is current
```

`update:cache` hashes the worker (minus its version), `templates/index.html`, and every
file in `PRECACHE`; run it after the final asset change or clients keep stale
files. Keep `PRECACHE` a literal list of `/` plus `/static/...` paths. Old
`room-finder-v*` caches are deleted when the new worker activates.

---

## API

```
GET  /api/rooms            # Rooms matching the query window (see Availability model)
GET  /api/rooms/all        # All rooms with availability facts
GET  /api/buildings        # Per-building occupancy summary
GET  /api/room/schedule    # One room's day schedule  ?building=KUPF&room=207
GET  /api/heatmap          # Weekly per-hour busyness  ?building=CKB
GET  /api/terms            # Stored semesters
GET  /api/schedule-info    # Active schedule metadata/provenance
POST /api/upload-schedule  # Upload (UPLOAD_PASSWORD)
GET  /api/export-schedule  # Download a stored term (UPLOAD_PASSWORD)
GET  /admin/visits         # Visitor report (ADMIN_PASSWORD)
GET  /ping                 # Health check
```

### Visitor report

`/admin/visits` (HTTP Basic, password = `ADMIN_PASSWORD`) shows page-opens of the
home page: time (Eastern), a random browser-cookie ID, a truncated salted hash of the
network address, user agent (500 chars), and the referrer reduced to origin + path.
No real names are collected. Records older than 90 days are deleted automatically.

---

## Project structure

```
app.py               # Flask app factory, routes, auth, schedule selection
schedule.py          # CSV/XLSX validation + availability logic
schedule_store.py    # Atomic schedule publication + manifest
campus_metadata.py   # Metadata registry loader/validator
visitor_log.py       # SQLite visitor log
data/                # campus_metadata.json
templates/, static/  # Frontend (static/sw.js = service worker)
scripts/cache-fingerprint.js
tests/               # pytest suite; tests/browser = Playwright specs + server.py
bookmarklet/
```

---

## Tests

```bash
python -m pytest tests/ -q      # unit/API tests (needs requirements-dev.txt)
npx playwright install chromium # once
npx playwright test             # browser tests (alias: npm run test:browser)
```

Browser tests start disposable real Flask servers via `tests/browser/server.py`,
using `python` unless `ROOM_FINDER_TEST_PYTHON` points to another interpreter that
has `requirements-dev.txt` installed. Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to
use a local browser instead of Playwright's Chromium. Output goes to `test-results/`
(override with `PLAYWRIGHT_OUTPUT_DIR`).

### CI (`.github/workflows/ci.yml`)

Runs on pushes to `master`, pull requests, and manual dispatch (Ubuntu, Python 3.12,
Node 24): install hashed dev requirements + `pip check` + `npm ci`; run pytest and
**fail if any test is skipped**; `npm run check:css` and the service-worker cache
tests; install Chromium and run the Playwright suite, failing on any skipped,
flaky, or retried test; upload reports as an artifact. Note that CI does not run
`npm run check:cache` directly — the cache consistency is covered by
`tests/test_service_worker_cache.py`.
