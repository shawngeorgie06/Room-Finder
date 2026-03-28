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
- Next free slot — room detail shows when an occupied room opens up
- Future day + time combos fully supported

**Navigation**
- Campus map with live occupancy color coding per building
- Floor-level room grid per building (click any building on map)
- Room detail sheet — daily timeline, class list, next free window
- Press `/` anywhere to jump to room search

**UX**
- Shareable URLs — filters sync to URL params, paste to share exact view
- Auto-refresh every 60 seconds with countdown ring
- Configurable "closing soon" threshold (15 / 30 / 45 / 60 min)
- "Best Rooms Right Now" — top rooms sorted by free time, on dashboard and sidebar
- Mobile bottom nav with search overlay and room detail bottom sheet
- Weekend / no-classes banner when campus is quiet
- Semester label auto-detected from filename, falls back to current date

---

## Stack

- **Backend**: Python 3.10+, Flask, Pandas
- **Frontend**: Vanilla JS, Tailwind CSS (CDN), Leaflet.js
- **Data**: NJIT Banner SSB course schedule export (CSV or XLSX)
- **Deploy**: Render (gunicorn)

---

## Setup

```bash
pip install -r requirements.txt
python app.py
# → http://localhost:5000
```

On first run the app loads `schedule_default.csv` from the project root. Upload a current semester schedule via the **Settings** page in the UI (no restart needed).

---

## Updating Schedule Data

**Option 1 — Upload via UI (recommended)**

1. Go to the **Settings** page in the app
2. Upload a CSV or XLSX file exported from Banner SSB
3. The schedule reloads instantly — no restart needed
4. The uploaded file persists across restarts as `uploaded_schedule.csv/xlsx`

**Option 2 — Bookmarklet**

1. Go to `/bookmarklet` in the app (linked from the Settings page)
2. Drag the **Extract NJIT Schedule** button to your bookmarks bar
3. Log in to [Banner Course Schedule](https://generalssb-prod.ec.njit.edu/BannerExtensibility/customPage/page/stuRegCrseSched)
4. Select the current term, wait for the page to load
5. Click the bookmarklet — downloads a combined CSV
6. Upload via the Settings page — updates instantly, no restart needed

---

## API

All endpoints support optional query params: `?at=HH:MM`, `?day=Monday`, `?for=30`, `?building=KUPF`

```
GET /api/rooms                  # Empty rooms right now
GET /api/rooms/all              # All rooms (empty + occupied) with status
GET /api/buildings              # Per-building occupancy summary
GET /api/room/schedule          # One room's full day schedule
  ?building=KUPF&room=207
GET /api/schedule-info          # Loaded file metadata + semester label
GET /api/upload-schedule        # POST — upload new schedule file
```

**Example response — `/api/rooms`**
```json
[
  { "building": "CKB",  "room": "217", "minutes_until_next": 45,  "capacity": 35 },
  { "building": "KUPF", "room": "107", "minutes_until_next": null, "capacity": 43 }
]
```

`minutes_until_next` is `null` when the room is free for the rest of the day.

---

## Project Structure

```
njit-empty-rooms/
├── app.py                  # Flask app factory + all API routes
├── schedule.py             # CSV/XLSX parsing + availability logic
├── requirements.txt
├── templates/
│   └── index.html          # Single-page app (Tailwind + Leaflet)
├── static/
│   └── app.js              # All frontend logic (~1200 lines)
├── tests/
│   ├── test_api.py
│   ├── test_schedule.py
│   ├── test_next_free_slot.py
│   └── test_capacity.py
└── bookmarklet/
    ├── install.html
    └── extract-schedule.js
```

---

## Tests

```bash
python -m pytest tests/ -v
# 45 tests, all passing
```

---

## Deployment (Render)

The app uses gunicorn as the WSGI server. `render.yaml` or manual setup:

- **Build command**: `pip install -r requirements.txt`
- **Start command**: `gunicorn app:app`
- **Environment**: `UPLOAD_PASSWORD=yourpassword` (optional — restricts schedule uploads)
