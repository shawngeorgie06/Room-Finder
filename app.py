import os
from datetime import datetime
from flask import Flask, jsonify, render_template, request
from schedule import load_schedule, get_empty_rooms

UPLOAD_FOLDER = os.path.dirname(__file__)

def get_current_time():
    """Returns (weekday_int, time_object). Separate function for testability."""
    now = datetime.now()
    return now.weekday(), now.time()


def parse_at_param(at_str):
    """Parse '14:30' query param string to a time object. Returns None on failure."""
    if not at_str:
        return None
    try:
        return datetime.strptime(at_str.strip(), "%H:%M").time()
    except ValueError:
        return None


def create_app(schedule=None):
    app = Flask(__name__)

    # Schedule metadata tracked alongside the mutable list
    meta = {'filename': '', 'loaded_at': None}

    if schedule is None:
        csv_path = os.path.join(UPLOAD_FOLDER, "Course_Schedule_202610.csv")
        if os.path.exists(csv_path):
            schedule = load_schedule(csv_path)
            meta['filename'] = os.path.basename(csv_path)
            meta['loaded_at'] = datetime.now().isoformat(timespec='seconds')
            print(f"Loaded {len(schedule)} schedule entries.")
        else:
            schedule = []
            print("No schedule CSV found — upload one via the Settings page.")

    @app.route("/")
    def index():
        return render_template("index.html")

    @app.route("/api/rooms")
    def rooms():
        weekday, now = get_current_time()
        at_time = parse_at_param(request.args.get("at"))
        if at_time:
            now = at_time
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
                'minutes_until_next': minutes
            })

        return jsonify(result)

    @app.route("/api/room/schedule")
    def room_schedule_api():
        building = request.args.get("building", "").strip()
        room_num  = request.args.get("room", "").strip()
        if not building or not room_num:
            return jsonify({'error': 'building and room are required'}), 400

        weekday, now = get_current_time()
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

        return jsonify({
            'building':     building,
            'room':         room_num,
            'classes':      classes_out,
            'now_min':      now_min,
            'occupied_now': occupied_now,
            'next_class':   next_cls,
            'weekday':      weekday_names[weekday],
        })

    @app.route("/api/schedule-info")
    def schedule_info():
        buildings = set(e['building'] for e in schedule)
        rooms = set((e['building'], e['room']) for e in schedule)
        return jsonify({
            'filename': meta['filename'],
            'loaded_at': meta['loaded_at'],
            'entries': len(schedule),
            'buildings': len(buildings),
            'rooms': len(rooms),
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

    return app


# Module-level app instance for gunicorn (production)
app = create_app()

if __name__ == "__main__":
    app.run(host='0.0.0.0', debug=False, port=5000)
