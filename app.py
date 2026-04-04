import os
import threading
import time
import urllib.request
from datetime import datetime
from zoneinfo import ZoneInfo
from flask import Flask, jsonify, render_template, request, send_from_directory
from schedule import load_schedule, get_empty_rooms


def _start_keepalive():
    """Ping self every 14 min so Render doesn't spin down the free instance."""
    url = os.environ.get('RENDER_EXTERNAL_URL', '').rstrip('/')
    if not url:
        return  # not on Render, skip

    def _ping():
        while True:
            time.sleep(14 * 60)
            try:
                urllib.request.urlopen(f"{url}/ping", timeout=10)
            except Exception:
                pass  # best-effort, ignore errors

    t = threading.Thread(target=_ping, daemon=True)
    t.start()

UPLOAD_FOLDER = os.path.dirname(__file__)
EASTERN = ZoneInfo('America/New_York')

DAY_NAMES = {
    'monday': 0, 'tuesday': 1, 'wednesday': 2, 'thursday': 3,
    'friday': 4, 'saturday': 5, 'sunday': 6,
}
SEMESTER_CODES = {'10': 'Spring', '50': 'Summer', '90': 'Fall', '30': 'Fall'}


def parse_day_param(day_str):
    """Parse 'Monday' or '0'–'6' to weekday int. Returns None if absent/invalid."""
    if not day_str:
        return None
    s = day_str.strip().lower()
    if s in DAY_NAMES:
        return DAY_NAMES[s]
    try:
        d = int(s)
        if 0 <= d <= 6:
            return d
    except ValueError:
        pass
    return None


def _parse_semester(filename):
    """Return e.g. 'Spring 2026' from 'Course_Schedule_202610.csv', or None."""
    import re
    m = re.search(r'(\d{4})(\d{2})', filename or '')
    if not m:
        return None
    year, code = m.group(1), m.group(2)
    season = SEMESTER_CODES.get(code, f'Term {code}')
    return f'{season} {year}'

def get_current_time():
    """Returns (weekday_int, time_object) in Eastern time."""
    now = datetime.now(EASTERN)
    return now.weekday(), now.time()


def parse_at_param(at_str):
    """Parse '14:30' query param string to a time object. Returns None on failure."""
    if not at_str:
        return None
    try:
        return datetime.strptime(at_str.strip(), "%H:%M").time()
    except ValueError:
        return None


def _compute_next_free_window(classes_out, now_min):
    """
    Given a sorted list of class dicts (each with start_min, end_min, time_start, time_end)
    and the current time in minutes, return the next free window as
    {'start': 'HH:MM AM/PM', 'end': 'HH:MM AM/PM', 'duration_mins': int}
    or None if free for the rest of the day.

    A free window is a gap between consecutive classes, or the gap from now
    until the first class (if room is currently free before class starts).
    """
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


def create_app(schedule=None):
    app = Flask(__name__)

    # Schedule metadata tracked alongside the mutable list
    meta = {'filename': '', 'loaded_at': None}

    if schedule is None:
        # Prefer a previously uploaded schedule, then bundled default
        for candidate in ['uploaded_schedule.xlsx', 'uploaded_schedule.csv',
                          'schedule_default.csv', 'Course_Schedule_202610.csv']:
            csv_path = os.path.join(UPLOAD_FOLDER, candidate)
            if os.path.exists(csv_path):
                schedule = load_schedule(csv_path)
                meta['filename'] = candidate
                meta['loaded_at'] = datetime.now().isoformat(timespec='seconds')
                print(f"Loaded {len(schedule)} entries from '{candidate}'.")
                break
        else:
            schedule = []
            print("No schedule CSV found — upload one via the Settings page.")

    @app.route("/ping")
    def ping():
        return "ok", 200

    @app.route("/")
    def index():
        return render_template("index.html")

    @app.route("/bookmarklet")
    def bookmarklet():
        return send_from_directory(
            os.path.join(os.path.dirname(__file__), 'bookmarklet'),
            'install.html'
        )

    @app.route("/api/rooms")
    def rooms():
        weekday, now = get_current_time()
        at_time = parse_at_param(request.args.get("at"))
        if at_time:
            now = at_time
        day_override = parse_day_param(request.args.get("day"))
        if day_override is not None:
            weekday = day_override
        for_mins = int(request.args.get("for", 0) or 0)
        building = request.args.get("building") or None
        result = get_empty_rooms(schedule, weekday=weekday, now=now, building=building, min_duration_mins=for_mins)
        return jsonify(result)

    @app.route("/api/buildings")
    def buildings_api():
        weekday, now = get_current_time()
        at_time = parse_at_param(request.args.get("at"))
        if at_time:
            now = at_time
        day_override = parse_day_param(request.args.get("day"))
        if day_override is not None:
            weekday = day_override
        for_mins = int(request.args.get("for", 0) or 0)
        empty_rooms = get_empty_rooms(schedule, weekday=weekday, now=now, min_duration_mins=for_mins)

        empty_by_building = {}
        for room in empty_rooms:
            b = room['building']
            empty_by_building[b] = empty_by_building.get(b, 0) + 1

        rooms_by_building = {}
        for entry in schedule:
            b = entry['building']
            r = entry['room']
            if b not in rooms_by_building:
                rooms_by_building[b] = set()
            rooms_by_building[b].add(r)

        result = []
        for b in sorted(rooms_by_building.keys()):
            total = len(rooms_by_building[b])
            empty = empty_by_building.get(b, 0)
            result.append({
                'building': b,
                'total_rooms': total,
                'empty_rooms': empty,
                'occupied_rooms': total - empty,
                'occupancy_pct': round((total - empty) / total * 100) if total > 0 else 0
            })

        return jsonify(result)

    @app.route("/api/rooms/all")
    def all_rooms_api():
        weekday, now = get_current_time()
        at_time = parse_at_param(request.args.get("at"))
        if at_time:
            now = at_time
        day_override = parse_day_param(request.args.get("day"))
        if day_override is not None:
            weekday = day_override
        for_mins = int(request.args.get("for", 0) or 0)
        building_filter = request.args.get("building") or None

        empty_rooms_list = get_empty_rooms(schedule, weekday=weekday, now=now, building=building_filter, min_duration_mins=for_mins)
        empty_map = {(r['building'], r['room']): r for r in empty_rooms_list}

        rooms_seen = {}
        for entry in schedule:
            b = entry['building']
            r = entry['room']
            if building_filter and b != building_filter:
                continue
            key = (b, r)
            if key not in rooms_seen:
                rooms_seen[key] = True

        result = []
        for (b, r) in sorted(rooms_seen.keys()):
            is_empty = (b, r) in empty_map
            minutes = empty_map.get((b, r), {}).get('minutes_until_next')

            r_upper = str(r).upper()
            if r_upper.startswith('G') or r_upper.startswith('B'):
                floor = 0
            else:
                floor = 1
                for ch in r_upper:
                    if ch.isdigit():
                        floor = int(ch)
                        break

            result.append({
                'building': b,
                'room': r,
                'floor': floor,
                'empty': is_empty,
                'minutes_until_next': minutes,
                'capacity': empty_map.get((b, r), {}).get('capacity'),
            })

        return jsonify(result)

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

        # ── Compute room capacity (max across all schedule entries for this room) ──
        room_capacity = max(
            (e.get('capacity') for e in schedule
             if e['building'] == building and e['room'] == room_num and e.get('capacity')),
            default=None,
        )

        return jsonify({
            'building':          building,
            'room':              room_num,
            'classes':           classes_out,
            'now_min':           now_min,
            'occupied_now':      occupied_now,
            'next_class':        next_cls,
            'weekday':           weekday_names[weekday],
            'next_free_window':  next_free_window,
            'capacity':          room_capacity,
        })

    @app.route("/api/schedule-info")
    def schedule_info():
        buildings = set(e['building'] for e in schedule)
        rooms = set((e['building'], e['room']) for e in schedule)
        weekday, _ = get_current_time()
        has_classes_today = any(weekday in e['days'] for e in schedule)
        return jsonify({
            'filename': meta['filename'],
            'loaded_at': meta['loaded_at'],
            'entries': len(schedule),
            'buildings': len(buildings),
            'rooms': len(rooms),
            'semester': _parse_semester(meta['filename']),
            'has_classes_today': has_classes_today,
        })

    @app.route("/api/upload-schedule", methods=["POST"])
    def upload_schedule():
        # Password check — only enforced when UPLOAD_PASSWORD env var is set
        required_pw = os.environ.get('UPLOAD_PASSWORD', '').strip()
        if required_pw:
            supplied_pw = request.form.get('password', '').strip()
            if not supplied_pw or supplied_pw != required_pw:
                return jsonify({'error': 'Invalid password.'}), 401

        if 'file' not in request.files:
            return jsonify({'error': 'No file provided.'}), 400
        f = request.files['file']
        if not f.filename:
            return jsonify({'error': 'Empty filename.'}), 400
        if not f.filename.lower().endswith(('.csv', '.xlsx')):
            return jsonify({'error': 'Only CSV or Excel (.xlsx) files are accepted.'}), 400

        ext = '.xlsx' if f.filename.lower().endswith('.xlsx') else '.csv'
        save_path = os.path.join(UPLOAD_FOLDER, f'uploaded_schedule{ext}')
        f.save(save_path)

        try:
            new_data = load_schedule(save_path)
        except Exception as e:
            return jsonify({'error': f'Could not parse CSV: {e}'}), 422

        if not new_data:
            return jsonify({'error': 'CSV parsed but no valid schedule entries found. Check the file format.'}), 422

        schedule.clear()
        schedule.extend(new_data)
        meta['filename'] = f.filename
        meta['loaded_at'] = datetime.now().isoformat(timespec='seconds')

        buildings = set(e['building'] for e in schedule)
        rooms = set((e['building'], e['room']) for e in schedule)
        print(f"Schedule reloaded: {len(schedule)} entries from '{f.filename}'")
        return jsonify({
            'success': True,
            'filename': meta['filename'],
            'loaded_at': meta['loaded_at'],
            'entries': len(schedule),
            'buildings': len(buildings),
            'rooms': len(rooms),
        })

    _start_keepalive()
    return app


# Module-level app instance for gunicorn (production)
app = create_app()

if __name__ == "__main__":
    app.run(host='0.0.0.0', debug=False, port=5000)
