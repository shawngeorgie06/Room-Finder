import os
import threading
import time
import urllib.request
from datetime import datetime, date
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


def _term_code_from_filename(filename):
    """Return e.g. 202610 from 'Course_Schedule_202610.csv', or None."""
    import re
    m = re.search(r'(\d{4})(\d{2})', filename or '')
    return int(m.group(1) + m.group(2)) if m else None


def _term_label(term_code):
    """Return e.g. 'Spring 2026' for 202610, or None."""
    if term_code is None:
        return None
    year, code = divmod(term_code, 100)
    season = SEMESTER_CODES.get(f'{code:02d}', f'Term {code:02d}')
    return f'{season} {year}'


def _expected_term(today):
    """Term code for the semester in session on `today`:
    Jan–Apr → Spring (10), May–Jul → Summer (50), Aug–Dec → Fall (90)."""
    if today.month <= 4:
        code = 10
    elif today.month <= 7:
        code = 50
    else:
        code = 90
    return today.year * 100 + code


def _is_stale(term_code, today):
    """True if the loaded schedule's term predates the current semester.
    Current or future terms are fresh; None when the term is unknown."""
    if term_code is None:
        return None
    return term_code < _expected_term(today)


def _schedule_status(term_code, today):
    """Classify the loaded term vs the current semester:
    'current', 'stale' (past), 'future' (upcoming), or 'unknown'."""
    if term_code is None:
        return 'unknown'
    expected = _expected_term(today)
    if term_code == expected:
        return 'current'
    return 'stale' if term_code < expected else 'future'


def _in_session(term_code, today):
    """Whether classes for this term are actually meeting on `today`.
    Approximate NJIT windows: Spring Jan 15–May 15, Summer May 15–Aug 15,
    Fall Sep 1–Dec 23. Outside the window the weekly pattern doesn't apply
    (breaks, finals aftermath). None when the term is unknown."""
    if term_code is None:
        return None
    year, code = divmod(term_code, 100)
    windows = {
        10: (date(year, 1, 15), date(year, 5, 15)),
        50: (date(year, 5, 15), date(year, 8, 15)),
        90: (date(year, 9, 1), date(year, 12, 23)),
    }
    window = windows.get(code)
    if window is None:
        return None
    return window[0] <= today <= window[1]


def _term_from_entries(entries):
    """Most common term code in the loaded data (e.g. 202610), or None."""
    from collections import Counter
    counts = Counter(
        e.get('term', '') for e in entries
        if str(e.get('term', '')).strip().isdigit()
    )
    if not counts:
        return None
    return int(counts.most_common(1)[0][0])


def _default_schedule_candidates(folder, today=None):
    """Schedule files to try, best first. Ordering: legacy un-termed uploads,
    then term-dated files by closeness to the current semester (exact match,
    nearest future, newest past — per-term uploads beat bundled exports),
    then the bundled default. The loader takes the first non-empty one."""
    if today is None:
        today = datetime.now(EASTERN).date()
    expected = _expected_term(today)

    candidates = [
        c for c in ['uploaded_schedule.xlsx', 'uploaded_schedule.csv']
        if os.path.exists(os.path.join(folder, c))
    ]

    import glob
    dated = []
    for pattern in ('uploaded_schedule_*.csv', 'uploaded_schedule_*.xlsx',
                    'Course_Schedule_*.csv', 'Course_Schedule_*.xlsx'):
        for p in glob.glob(os.path.join(folder, pattern)):
            name = os.path.basename(p)
            term = _term_code_from_filename(name)
            if term:
                dated.append((name, term))

    def closeness(item):
        name, term = item
        is_export = 0 if name.startswith('uploaded_') else 1
        if term == expected:
            return (0, 0, is_export)
        if term > expected:
            return (1, term, is_export)   # future: nearest first
        return (2, -term, is_export)      # past: newest first

    candidates += [name for name, _ in sorted(dated, key=closeness)]

    if os.path.exists(os.path.join(folder, 'schedule_default.csv')):
        candidates.append('schedule_default.csv')
    return candidates


def _stored_term_files(folder):
    """Map of term_code -> (filename, source) for term files on disk.
    Runtime uploads shadow bundled repo exports for the same term."""
    import glob
    out = {}
    for pattern, source in (('Course_Schedule_*', 'bundled'),
                            ('uploaded_schedule_*', 'uploaded')):
        for ext in ('.csv', '.xlsx'):
            for p in glob.glob(os.path.join(folder, pattern + ext)):
                name = os.path.basename(p)
                term = _term_code_from_filename(name)
                if term:
                    out[term] = (name, source)
    return out


def _load_best_schedule():
    """Load the first usable schedule candidate from UPLOAD_FOLDER.
    Returns (entries, filename); ([], '') when nothing usable exists."""
    for candidate in _default_schedule_candidates(UPLOAD_FOLDER):
        try:
            entries = load_schedule(os.path.join(UPLOAD_FOLDER, candidate))
        except Exception as e:
            print(f"Skipping '{candidate}': {e}")
            continue
        if not entries:
            print(f"Skipping '{candidate}': no valid schedule entries.")
            continue
        return entries, candidate
    return [], ''

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

    # Case 2: first real gap (back-to-back classes produce zero-width gaps — skip them)
    for i in range(len(classes_out) - 1):
        gap_start = classes_out[i]['end_min']
        gap_end   = classes_out[i + 1]['start_min']
        if gap_start >= now_min and gap_end > gap_start:
            dur = gap_end - gap_start
            return {'start': mins_to_str(gap_start), 'end': mins_to_str(gap_end), 'duration_mins': dur}

    # Case 3: after all classes — free rest of day
    return None


def resolve_query_context():
    """Resolve (weekday, time, min_duration) from ?at/?day/?for query params,
    defaulting to the current Eastern time. Invalid values fall back to defaults."""
    weekday, now = get_current_time()
    at_time = parse_at_param(request.args.get("at"))
    if at_time:
        now = at_time
    day_override = parse_day_param(request.args.get("day"))
    if day_override is not None:
        weekday = day_override
    for_mins = request.args.get("for", default=0, type=int) or 0
    return weekday, now, for_mins


MAX_UPLOAD_BYTES = 10 * 1024 * 1024  # schedule exports are ~2 MB; 10 MB is generous

# The bookmarklet runs on the Banner page and POSTs the extracted schedule
# directly to this app — that cross-origin request needs CORS, but only on
# the upload endpoint and only for the Banner origin.
BANNER_ORIGIN = 'https://generalssb-prod.ec.njit.edu'
UPLOAD_ENDPOINT = '/api/upload-schedule'


def create_app(schedule=None):
    app = Flask(__name__)
    app.config['MAX_CONTENT_LENGTH'] = MAX_UPLOAD_BYTES

    # Schedule metadata tracked alongside the mutable list.
    # NOTE: uploads mutate this in-process list, which only stays consistent
    # because gunicorn runs a single worker. Don't add -w N without moving
    # schedule reload to a file-watch or per-request mtime check.
    meta = {'filename': '', 'loaded_at': None, 'term': None}
    if schedule:
        meta['term'] = _term_from_entries(schedule)

    def _activate(entries, filename):
        schedule.clear()
        schedule.extend(entries)
        meta['filename'] = filename
        meta['loaded_at'] = datetime.now().isoformat(timespec='seconds')
        meta['term'] = _term_from_entries(entries) or _term_code_from_filename(filename)

    def _maybe_reactivate():
        """Switch to a better schedule file if the semester rolled over.
        Cheap no-op when nothing changed: the scan stops as soon as it
        reaches the currently active file."""
        for candidate in _default_schedule_candidates(UPLOAD_FOLDER):
            if candidate == meta['filename']:
                return
            try:
                entries = load_schedule(os.path.join(UPLOAD_FOLDER, candidate))
            except Exception:
                continue
            if entries:
                _activate(entries, candidate)
                print(f"Semester rollover: switched to '{candidate}' ({len(entries)} entries).")
                return

    # Only re-resolve from disk for apps that loaded from disk — never for
    # explicitly injected schedules (tests)
    auto_loaded = schedule is None

    if schedule is None:
        schedule = []
        entries, filename = _load_best_schedule()
        if entries:
            _activate(entries, filename)
            print(f"Loaded {len(schedule)} entries from '{filename}'.")
        else:
            print("No usable schedule file found — upload one via the Settings page.")

    @app.after_request
    def add_upload_cors_headers(response):
        # Applied via after_request so error responses (401/413/422) carry the
        # headers too — otherwise the bookmarklet can't read failure reasons.
        if request.path == UPLOAD_ENDPOINT:
            response.headers['Access-Control-Allow-Origin'] = BANNER_ORIGIN
            response.headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS'
            response.headers['Access-Control-Allow-Headers'] = 'Content-Type'
        return response

    @app.route("/ping")
    def ping():
        return "ok", 200

    @app.route("/")
    def index():
        return render_template("index.html")

    @app.route("/sw.js")
    def service_worker():
        # Served from the root path so the service worker's scope covers
        # the whole app (a worker under /static/ could only control /static/)
        return send_from_directory(
            os.path.join(os.path.dirname(__file__), 'static'), 'sw.js',
            mimetype='application/javascript'
        )

    @app.route("/bookmarklet")
    def bookmarklet():
        return send_from_directory(
            os.path.join(os.path.dirname(__file__), 'bookmarklet'),
            'install.html'
        )

    @app.route("/api/rooms")
    def rooms():
        weekday, now, for_mins = resolve_query_context()
        building = request.args.get("building") or None
        until = parse_at_param(request.args.get("until"))
        result = get_empty_rooms(schedule, weekday=weekday, now=now, building=building,
                                 min_duration_mins=for_mins, until=until)
        return jsonify(result)

    @app.route("/api/buildings")
    def buildings_api():
        weekday, now, for_mins = resolve_query_context()
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
        weekday, now, for_mins = resolve_query_context()
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
                'course':     cls.get('course', ''),
                'title':      cls.get('title', ''),
                'instructor': cls.get('instructor', ''),
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

    @app.route("/api/heatmap")
    def heatmap_api():
        """Per-building weekly occupancy: for each weekday and each hour
        7 AM–10 PM, how many rooms have a class overlapping that hour."""
        building = request.args.get("building", "").strip()
        if not building:
            return jsonify({'error': 'building is required'}), 400

        entries = [e for e in schedule if e['building'] == building]
        if not entries:
            return jsonify({'error': f'No rooms found for building {building}.'}), 404

        hours = list(range(7, 22))
        days = []
        for d in range(7):
            counts = []
            for h in hours:
                h_start, h_end = h * 60, (h + 1) * 60
                occupied = set(
                    e['room'] for e in entries
                    if d in e['days']
                    and e['time_start'].hour * 60 + e['time_start'].minute < h_end
                    and e['time_end'].hour * 60 + e['time_end'].minute > h_start
                )
                counts.append(len(occupied))
            days.append(counts)

        return jsonify({
            'building': building,
            'total_rooms': len(set(e['room'] for e in entries)),
            'hours': hours,
            'days': days,
        })

    @app.route("/api/terms")
    def terms_api():
        """All semesters stored on disk, newest first."""
        today = datetime.now(EASTERN).date()
        return jsonify([
            {'term': t, 'semester': _term_label(t), 'filename': fn,
             'source': src, 'active': fn == meta['filename'],
             'status': _schedule_status(t, today)}
            for t, (fn, src) in sorted(_stored_term_files(UPLOAD_FOLDER).items(),
                                       reverse=True)
        ])

    @app.route("/api/export-schedule")
    def export_schedule():
        """Download a stored term's schedule file — lets an admin save a
        runtime upload into the repo so it survives Render redeploys."""
        required_pw = os.environ.get('UPLOAD_PASSWORD', '').strip()
        if required_pw and request.args.get('password', '').strip() != required_pw:
            return jsonify({'error': 'Invalid password.'}), 401
        term_str = request.args.get('term', '').strip()
        if not term_str.isdigit():
            return jsonify({'error': 'term is required, e.g. ?term=202650'}), 400
        entry = _stored_term_files(UPLOAD_FOLDER).get(int(term_str))
        if not entry:
            return jsonify({'error': f'No stored schedule for term {term_str}.'}), 404
        filename = entry[0]
        ext = os.path.splitext(filename)[1]
        return send_from_directory(
            UPLOAD_FOLDER, filename, as_attachment=True,
            download_name=f'Course_Schedule_{term_str}{ext}'
        )

    @app.route("/api/schedule-info")
    def schedule_info():
        if auto_loaded:
            _maybe_reactivate()
        buildings = set(e['building'] for e in schedule)
        rooms = set((e['building'], e['room']) for e in schedule)
        weekday, _ = get_current_time()
        has_classes_today = any(weekday in e['days'] for e in schedule)
        today = datetime.now(EASTERN).date()
        term = meta['term'] or _term_code_from_filename(meta['filename'])
        return jsonify({
            'filename': meta['filename'],
            'loaded_at': meta['loaded_at'],
            'entries': len(schedule),
            'buildings': len(buildings),
            'rooms': len(rooms),
            'semester': _term_label(term),
            'stale': _is_stale(term, today),
            'status': _schedule_status(term, today),
            'in_session': _in_session(term, today),
            'expected_semester': _term_label(_expected_term(today)),
            'has_classes_today': has_classes_today,
        })

    @app.route("/api/upload-schedule", methods=["POST", "OPTIONS"])
    def upload_schedule():
        if request.method == "OPTIONS":
            return "", 204  # CORS preflight; headers added by after_request
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

        # Validate against a temp file first — the final path is in the restart
        # load order, so a bad file must never land there.
        ext = '.xlsx' if f.filename.lower().endswith('.xlsx') else '.csv'
        # Temp name keeps the real extension — load_schedule sniffs it
        tmp_path = os.path.join(UPLOAD_FOLDER, f'uploaded_schedule_tmp{ext}')
        f.save(tmp_path)

        try:
            new_data = load_schedule(tmp_path)
        except Exception as e:
            os.remove(tmp_path)
            return jsonify({'error': f'Could not parse CSV: {e}'}), 422

        if not new_data:
            os.remove(tmp_path)
            return jsonify({'error': 'CSV parsed but no valid schedule entries found. Check the file format.'}), 422

        # One file per term so semesters coexist (upload fall while summer runs)
        term = _term_from_entries(new_data) or _term_code_from_filename(f.filename)
        stem = f'uploaded_schedule_{term}' if term else 'uploaded_schedule'
        os.replace(tmp_path, os.path.join(UPLOAD_FOLDER, f'{stem}{ext}'))

        # Remove files this upload supersedes: the same term's other extension
        # and legacy un-termed uploads (both outrank term files at load time).
        other_ext = '.csv' if ext == '.xlsx' else '.xlsx'
        for superseded in (f'{stem}{other_ext}',
                           'uploaded_schedule.csv', 'uploaded_schedule.xlsx'):
            path = os.path.join(UPLOAD_FOLDER, superseded)
            if os.path.exists(path):
                os.remove(path)

        # Activate the best term for today — not necessarily the one uploaded
        best_entries, best_file = _load_best_schedule()
        if best_entries:
            _activate(best_entries, best_file)

        buildings = set(e['building'] for e in new_data)
        rooms = set((e['building'], e['room']) for e in new_data)
        print(f"Upload saved: {len(new_data)} entries from '{f.filename}' "
              f"(term {term}); active schedule is '{meta['filename']}'")
        return jsonify({
            'success': True,
            'filename': f.filename,
            'loaded_at': meta['loaded_at'],
            'entries': len(new_data),
            'buildings': len(buildings),
            'rooms': len(rooms),
            'uploaded_semester': _term_label(term),
            'active_semester': _term_label(meta['term']),
        })

    _start_keepalive()
    return app


# Module-level app instance for gunicorn (production)
app = create_app()

if __name__ == "__main__":
    app.run(host='0.0.0.0', debug=False, port=5000)
