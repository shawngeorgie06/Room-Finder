# Next Free Slot for Occupied Rooms Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a user clicks an occupied room, show the next available free window (e.g. "Free 2:00 PM – 3:30 PM") in addition to the today's class schedule.

**Architecture:** Backend change to `/api/room/schedule` in `app.py` — add a `next_free_window` field to the response by computing gaps between consecutive classes. Frontend change in `app.js` `openRoomDetail()` to display the new field prominently.

**Tech Stack:** Python/Flask backend, Vanilla JS frontend

---

## File Map

- **Modify:** `app.py` — add gap-finding logic inside `room_schedule_api()`, add `next_free_window` to response
- **Modify:** `static/app.js` — update `openRoomDetail()` / room detail modal rendering to display free window
- **Modify:** `templates/index.html` — update room detail modal HTML to add a free-window badge

---

### Task 1: Add `next_free_window` computation to backend

**Files:**
- Modify: `app.py` (function `room_schedule_api`, lines ~144–184)

The logic: given today's sorted class list, find the first gap after `now` where a room is free. A gap exists between `classes[i].end` and `classes[i+1].start`. Also check the gap from `now` to `classes[0].start` if the room is currently free (but this endpoint is usually called for occupied rooms too — compute it regardless).

- [ ] **Step 1: Write a test for gap computation**

Create `tests/test_next_free_slot.py`:

```python
import pytest
from datetime import time
from app import create_app

@pytest.fixture
def client():
    # Minimal in-memory schedule: KUPF 207, Monday, 9:00-10:15 and 11:00-12:15
    schedule = [
        {'building': 'KUPF', 'room': '207', 'days': [0],
         'time_start': time(9, 0), 'time_end': time(10, 15)},
        {'building': 'KUPF', 'room': '207', 'days': [0],
         'time_start': time(11, 0), 'time_end': time(12, 15)},
    ]
    app = create_app(schedule=schedule)
    app.config['TESTING'] = True
    return app.test_client()

def test_next_free_window_between_classes(client):
    # At 9:30 (during first class), free window should be 10:15–11:00
    resp = client.get('/api/room/schedule?building=KUPF&room=207&_weekday=0&at=09:30')
    assert resp.status_code == 200
    data = resp.get_json()
    assert data['next_free_window'] == {'start': '10:15 AM', 'end': '11:00 AM', 'duration_mins': 45}

def test_next_free_window_after_last_class(client):
    # At 12:30 (after all classes), free window should be None (free rest of day)
    resp = client.get('/api/room/schedule?building=KUPF&room=207&_weekday=0&at=12:30')
    assert resp.status_code == 200
    data = resp.get_json()
    assert data['next_free_window'] is None  # free rest of day

def test_next_free_window_before_first_class(client):
    # At 8:00 (before any class), free window is now until 9:00
    resp = client.get('/api/room/schedule?building=KUPF&room=207&_weekday=0&at=08:00')
    assert resp.status_code == 200
    data = resp.get_json()
    assert data['next_free_window'] == {'start': '8:00 AM', 'end': '9:00 AM', 'duration_mins': 60}
```

- [ ] **Step 2: Run the tests — confirm they fail**

```bash
cd /path/to/njit-empty-rooms
pytest tests/test_next_free_slot.py -v
```

Expected: `FAILED` — `next_free_window` key not in response, and `_weekday`/`at` params not yet supported in that endpoint.

- [ ] **Step 3: Update `room_schedule_api` to accept `at` and `_weekday` test params**

In `app.py`, find `room_schedule_api()`. The function currently calls `get_current_time()` unconditionally. Update it to accept optional overrides (mirrors how `/api/rooms` already handles `?at=`):

```python
@app.route("/api/room/schedule")
def room_schedule_api():
    building = request.args.get("building", "").strip()
    room_num  = request.args.get("room", "").strip()
    if not building or not room_num:
        return jsonify({'error': 'building and room are required'}), 400

    weekday, now = get_current_time()

    # Allow time override (used by frontend time-filter and tests)
    at_time = parse_at_param(request.args.get("at"))
    if at_time:
        now = at_time

    # Allow weekday override for testing only
    _wd = request.args.get("_weekday")
    if _wd is not None:
        try:
            weekday = int(_wd)
        except ValueError:
            pass

    now_min = now.hour * 60 + now.minute

    today_classes = sorted(
        [e for e in schedule
         if e['building'] == building and e['room'] == room_num and weekday in e['days']],
        key=lambda c: c['time_start']
    )

    classes_out = []
    for cls in today_classes:
        s = cls['time_start'].hour * 60 + cls['time_start'].minute
        e = cls['time_end'].hour * 60 + cls['time_end'].minute
        classes_out.append({
            'time_start': cls['time_start'].strftime('%I:%M %p').lstrip('0'),
            'time_end':   cls['time_end'].strftime('%I:%M %p').lstrip('0'),
            'start_min':  s,
            'end_min':    e,
            'is_current': s <= now_min < e,
        })

    occupied_now = any(c['start_min'] <= now_min < c['end_min'] for c in classes_out)
    next_cls = next((c for c in classes_out if c['start_min'] > now_min), None)
    weekday_names = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday']

    # ── Compute next free window ──────────────────────────────────────────
    next_free_window = _compute_next_free_window(classes_out, now_min)

    return jsonify({
        'building':          building,
        'room':              room_num,
        'classes':           classes_out,
        'now_min':           now_min,
        'occupied_now':      occupied_now,
        'next_class':        next_cls,
        'weekday':           weekday_names[weekday],
        'next_free_window':  next_free_window,
    })
```

- [ ] **Step 4: Add `_compute_next_free_window` helper to `app.py`**

Add this function above `create_app()`:

```python
def _compute_next_free_window(classes_out, now_min):
    """
    Given a sorted list of class dicts (each with start_min, end_min, time_start, time_end)
    and the current time in minutes, return the next free window as
    {'start': 'HH:MM AM/PM', 'end': 'HH:MM AM/PM', 'duration_mins': int}
    or None if free for the rest of the day.

    A free window is a gap between consecutive classes, or the gap from now
    until the first class (if room is currently free before class starts).
    """
    from datetime import time as dtime

    def mins_to_str(m):
        h, mn = divmod(m, 60)
        period = 'AM' if h < 12 else 'PM'
        h12 = h % 12 or 12
        return f"{h12}:{mn:02d} {period}"

    if not classes_out:
        # No classes today — free all day, no specific window
        return None

    # Case 1: before any class starts — free from now until first class
    first_start = classes_out[0]['start_min']
    if now_min < first_start:
        dur = first_start - now_min
        return {'start': mins_to_str(now_min), 'end': mins_to_str(first_start), 'duration_mins': dur}

    # Case 2: find gap between consecutive classes after now
    for i in range(len(classes_out) - 1):
        gap_start = classes_out[i]['end_min']
        gap_end   = classes_out[i + 1]['start_min']
        if gap_start > now_min and gap_end > gap_start:
            dur = gap_end - gap_start
            return {'start': mins_to_str(gap_start), 'end': mins_to_str(gap_end), 'duration_mins': dur}
        # If we're inside a class, look for gap after it ends
        if classes_out[i]['start_min'] <= now_min < classes_out[i]['end_min']:
            gap_start = classes_out[i]['end_min']
            if i + 1 < len(classes_out):
                gap_end = classes_out[i + 1]['start_min']
                dur = gap_end - gap_start
                return {'start': mins_to_str(gap_start), 'end': mins_to_str(gap_end), 'duration_mins': dur}

    # Case 3: after all classes — free rest of day
    return None
```

- [ ] **Step 5: Run tests — confirm they pass**

```bash
pytest tests/test_next_free_slot.py -v
```

Expected:
```
PASSED tests/test_next_free_slot.py::test_next_free_window_between_classes
PASSED tests/test_next_free_slot.py::test_next_free_window_after_last_class
PASSED tests/test_next_free_slot.py::test_next_free_window_before_first_class
```

- [ ] **Step 6: Commit**

```bash
git add app.py tests/test_next_free_slot.py
git commit -m "feat: add next_free_window to room schedule API"
```

---

### Task 2: Display next free window in the room detail modal (frontend)

**Files:**
- Modify: `static/app.js` — update `openRoomDetail()` response handler
- Modify: `templates/index.html` — update room detail modal HTML

- [ ] **Step 1: Find the room detail modal in index.html**

Search for `id="room-detail-modal"` or `openRoomDetail` in `index.html`. The modal shows today's classes. Locate the container that renders the schedule timeline.

- [ ] **Step 2: Add a "Next free" banner element to the modal**

Inside the room detail modal, just above the class list container, add:

```html
<!-- Next free window banner -->
<div id="room-free-window" class="hidden mb-4 px-4 py-3 bg-primary/10 border border-primary/30 rounded-sm flex items-center gap-3">
  <span class="material-symbols-outlined text-primary text-xl">schedule</span>
  <div>
    <div class="text-[9px] font-label text-on-surface-variant uppercase tracking-widest mb-0.5">Next Free Window</div>
    <div id="room-free-window-text" class="text-sm font-headline font-bold text-primary"></div>
  </div>
</div>
```

- [ ] **Step 3: Update `openRoomDetail()` in app.js to render the banner**

Find the `openRoomDetail` function (or wherever `/api/room/schedule` response is processed). After the response is received and the class list is rendered, add:

```js
// Render next free window banner
const fwEl  = $('room-free-window');
const fwTxt = $('room-free-window-text');
if (fwEl && fwTxt) {
  const fw = data.next_free_window;
  if (fw) {
    fwTxt.textContent = `${fw.start} – ${fw.end}  (${fw.duration_mins} min)`;
    fwEl.classList.remove('hidden');
  } else {
    // Free rest of day
    fwTxt.textContent = 'Free for the rest of the day';
    fwEl.classList.remove('hidden');
    // Change styling to reflect "free all day"
    fwEl.style.background = 'rgba(63,255,139,0.05)';
  }
}
```

Also make sure to hide the banner when the modal closes. Find the modal close function and add:

```js
const fwEl = $('room-free-window');
if (fwEl) fwEl.classList.add('hidden');
```

- [ ] **Step 4: Test manually**

1. Start server: `python app.py`
2. Open `http://localhost:5000`
3. Click any occupied room (red card in room grid or floor panel)
4. Confirm the modal shows a green banner: "Next Free Window: 2:00 PM – 3:30 PM (90 min)"
5. Click a free room — banner should show "Free for the rest of the day" or the next window
6. Close modal — banner hidden on reopen

- [ ] **Step 5: Commit**

```bash
git add templates/index.html static/app.js
git commit -m "feat: show next free window in room detail modal"
```
