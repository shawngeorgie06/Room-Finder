# NJIT Room Finder

Find empty classrooms at NJIT in real time. Shows which rooms are currently unoccupied and how long until the next class starts.

## Features

- Live room availability based on the current time and day
- Filter by building
- Shows time until next class (or "FREE ALL DAY")
- Auto-refreshes every 60 seconds
- Bookmarklet to extract the full campus schedule from Banner SSB

## How It Works

The app reads a course schedule CSV file and compares current time against all scheduled classes. Any room not currently in use is shown as available.

Only **Face-to-Face** and **Hybrid** sections are considered — online-only courses don't occupy physical rooms.

## Stack

- **Backend**: Python / Flask
- **Frontend**: Vanilla JS, HTML, CSS (no framework)
- **Data**: NJIT Banner SSB course schedule export

## Setup

**Requirements**: Python 3.10+, pip

```bash
pip install -r requirements.txt
```

Add a schedule CSV to the project root (see [Updating Schedule Data](#updating-schedule-data)), then run:

```bash
python app.py
```

App runs at `http://localhost:5000`.

## Updating Schedule Data

Schedule data is not committed to the repo — you need to generate it each semester using the included bookmarklet.

1. Open `bookmarklet/install.html` in your browser
2. Drag the **Extract NJIT Schedule** button to your bookmarks bar
3. Go to [Banner Course Schedule](https://generalssb-prod.ec.njit.edu/BannerExtensibility/customPage/page/stuRegCrseSched) and log in
4. Select the current term and wait for the page to load
5. Click the bookmarklet — it will loop through all subjects and download a combined CSV
6. Place the CSV in the project root and update the filename in `app.py` (line 17)

## API

```
GET /api/rooms
GET /api/rooms?building=CKB
```

Returns a JSON array of available rooms:

```json
[
  {
    "building": "CKB",
    "room": "217",
    "minutes_until_next": 45
  },
  {
    "building": "KUPF",
    "room": "107",
    "minutes_until_next": null
  }
]
```

`minutes_until_next` is `null` if the room is free for the rest of the day.

## Project Structure

```
njit-empty-rooms/
├── app.py              # Flask routes
├── schedule.py         # Schedule parsing and availability logic
├── requirements.txt    # Python dependencies
├── templates/
│   └── index.html      # Main page
├── static/
│   ├── style.css
│   └── app.js
└── bookmarklet/
    ├── install.html    # Drag-to-install bookmarklet page
    └── extract-schedule.js  # Annotated source
```
