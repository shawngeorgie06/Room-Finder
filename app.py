import os
import hmac
import hashlib
import json
import re
import math
import sqlite3
import threading
import time
import urllib.request
from functools import wraps
from datetime import datetime, date, time as time_of_day
from zoneinfo import ZoneInfo
from flask import Flask, g, jsonify, render_template, request, send_from_directory
from werkzeug.middleware.proxy_fix import ProxyFix
from dataclasses import dataclass, replace
from types import MappingProxyType
from pathlib import Path
from schedule import load_schedule, ScheduleValidationError, get_availability_facts, get_room_availability
from schedule_store import ScheduleStore, StoredSchedule, published_records, utc_now
from campus_metadata import load_registry
from visitor_log import get_visits, normalize_visitor_id, record_visit


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
    m = re.search(r'(?<![0-9])([1-9][0-9]{3})(10|30|50|90)(?![0-9])', filename or '')
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
    """Single validated data term, or unknown; never choose a mixed-term majority."""
    terms = {str(e.get('term', '')).strip() for e in entries}
    if len(terms) > 1:
        raise ValueError('Mixed terms; export a single semester')
    term = next(iter(terms), '')
    return int(term) if term else None


def _default_schedule_candidates(folder, today=None, *, include_published=True):
    """Termed candidates first (current, nearest future, newest past), then
    legacy termless fallback. Published uploads shadow legacy same-term files.
    Historical files are never deleted or rewritten by discovery.
    """
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

    published = _published_or_empty(folder) if include_published else {}
    for name, record in published.items():
        if record.term:
            dated.append((name, record.term))
        elif name not in candidates:
            candidates.append(name)
    candidates = list(dict.fromkeys([name for name, _ in sorted(dated, key=closeness)] + candidates))

    if os.path.exists(os.path.join(folder, 'schedule_default.csv')):
        candidates.append('schedule_default.csv')
    return candidates


# Single-process coordination includes startup, publication, and rollover. The
# deployment remains one worker; this does not pretend to be a distributed lock.
_schedule_lock = threading.RLock()
_candidate_failures = {}
# Cache validation identities, not entire historical rosters. Catalog/export
# requests must not repeatedly parse/hash unchanged historical schedules.
_candidate_validations = {}


def _storage_folder():
    return os.path.abspath(os.environ.get('SCHEDULE_STORAGE_DIR') or UPLOAD_FOLDER)


def _published_or_empty(folder):
    """Only a missing manifest is empty; unreadable provenance is an error."""
    return published_records(folder)


def _file_signature(path):
    try:
        stat = os.stat(path)
        return (os.path.abspath(path), stat.st_mtime_ns, stat.st_size)
    except OSError:
        return (os.path.abspath(path), None, None)


def _record_key(record):
    return (record.path,) if record.imported_at is not None else _file_signature(record.path)


def _remember_failure(record):
    if len(_candidate_failures) >= 512:
        _candidate_failures.pop(next(iter(_candidate_failures)))
    _candidate_failures[os.path.abspath(record.path)] = _file_signature(record.path)


def _all_schedule_candidates(folder=None, replacement=None, *, tolerate_manifest_errors=False):
    folder = folder or _storage_folder()
    roots = list(dict.fromkeys((os.path.abspath(folder), os.path.abspath(UPLOAD_FOLDER))))
    expected = _expected_term(datetime.now(EASTERN).date())
    candidates = []
    for root in roots:
        try:
            published = _published_or_empty(root)
            names = _default_schedule_candidates(root)
        except (OSError, ValueError):
            if not tolerate_manifest_errors:
                raise
            # Startup has no trusted live state; only explicit legacy files
            # remain discoverable. Never adopt unreferenced managed payloads.
            published = {}
            names = _default_schedule_candidates(root, include_published=False)
        for name in names:
            record = published.get(name) or StoredSchedule(name, os.path.join(root, name), _term_code_from_filename(name))
            # A new manifest record replaces all managed revisions for its term.
            if replacement and record.imported_at and record.term == replacement.term:
                continue
            candidates.append(record)
    if replacement:
        candidates.insert(0, replacement)

    def rank(record):
        term = record.term
        source = 0 if record.imported_at else (1 if record.filename.startswith('uploaded_') else 2)
        if term == expected:
            return (0, 0, source)
        if term is not None and term > expected:
            return (1, term, source)
        if term is not None:
            return (2, -term, source)
        return (3, 0, source)
    return sorted(candidates, key=rank)


def _load_candidate(record):
    signature = _file_signature(record.path)
    if _candidate_failures.get(signature[0]) == signature:
        return None
    try:
        entries = load_schedule(record.path)
        if not entries:
            raise ValueError('No scheduled entries')
        term = _term_from_entries(entries)
        if record.term is not None and term is not None and record.term != term:
            raise ValueError('Data term differs from stored filename/manifest')
        version = _schedule_version(entries)
        if record.version is not None and version != record.version:
            raise ValueError('Published schedule content differs from provenance')
        if len(_candidate_validations) >= 512:
            _candidate_validations.pop(next(iter(_candidate_validations)))
        _candidate_validations[(record, signature)] = True
        return entries, replace(record, version=version)
    except Exception:
        _remember_failure(record)
        return None


def _stored_term_files(folder, active=None):
    """Validated original-format downloads, preferring the actual active source.

    An unreadable manifest cannot revoke trusted live provenance, but no other
    managed payload is discoverable without a readable publication record.
    """
    out = {}
    if active is not None and active.term is not None and active.record_key:
        path = active.record_key[0]
        if active.imported_at is not None or _file_signature(path) == active.record_key:
            source = 'uploaded' if active.filename.startswith('uploaded_') else 'bundled'
            out[active.term] = (path, source)
    for record in _all_schedule_candidates(folder, tolerate_manifest_errors=True):
        if record.term is None or record.term in out:
            continue
        identity = (record, _file_signature(record.path))
        if identity not in _candidate_validations and _load_candidate(record) is None:
            continue
        source = 'uploaded' if record.filename.startswith('uploaded_') else 'bundled'
        out[record.term] = (record.path, source)
    return out


def _load_best_schedule():
    """Load once at startup, retaining failed-candidate stat memo for requests."""
    for record in _all_schedule_candidates(tolerate_manifest_errors=True):
        loaded = _load_candidate(record)
        if loaded is not None:
            return loaded
    return [], ''


@dataclass(frozen=True)
class ScheduleSnapshot:
    entries: tuple
    version: str
    filename: str
    term: int | None
    activated_at: str
    imported_at: str | None
    source_filename: str | None
    source_exported_at: str | None
    record_key: tuple | None


def _make_snapshot(entries, record=None):
    # Freeze both outer roster and nested days; never retain caller-owned dicts.
    frozen = tuple(MappingProxyType({**entry, 'days': tuple(entry['days'])}) for entry in entries)
    if isinstance(record, str):  # compatibility for injected loader test seams
        record = StoredSchedule(record, os.path.join(_storage_folder(), record), _term_code_from_filename(record)) if record else None
    return ScheduleSnapshot(
        frozen, record.version if record and record.version else _schedule_version(frozen),
        record.filename if record else '',
        _term_from_entries(frozen) or (record.term if record else None), utc_now(),
        record.imported_at if record else None, record.source_filename if record else None,
        record.source_exported_at if record else None, _record_key(record) if record else None,
    )

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
    """Legacy null-or-complete finite window, using the shared interval model.

    None means no finite next window, NOT that the room is currently free.
    The additive numeric facts distinguish the final occupied class from a
    currently free room with no more scheduled classes.
    """
    classes = [
        {'time_start': time_of_day(*divmod(c['start_min'], 60)),
         'time_end': time_of_day(*divmod(c['end_min'], 60))}
        for c in classes_out
    ]
    facts = get_availability_facts(classes, time_of_day(*divmod(now_min, 60)))
    start, end = facts['available_from_min'], facts['available_until_min']
    if end is None:
        return None

    def mins_to_str(m):
        h, mn = divmod(m, 60)
        period = 'AM' if h < 12 else 'PM'
        return f"{h % 12 or 12}:{mn:02d} {period}"

    return {'start': mins_to_str(start), 'end': mins_to_str(end), 'duration_mins': end - start}


def _schedule_version(entries):
    """Stable content identity for loaded and injected schedules, independent of row order."""
    records = [json.dumps({
        **entry,
        'days': sorted(entry['days']),
        'time_start': entry['time_start'].isoformat(),
        'time_end': entry['time_end'].isoformat(),
    }, sort_keys=True, separators=(',', ':')) for entry in entries]
    content = '[' + ','.join(sorted(records)) + ']'
    return hashlib.sha256(content.encode('utf-8')).hexdigest()


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
    for_mins = max(0, request.args.get("for", default=0, type=int) or 0)
    return weekday, now.replace(second=0, microsecond=0), for_mins


MAX_UPLOAD_BYTES = 10 * 1024 * 1024  # schedule exports are ~2 MB; 10 MB is generous

# The bookmarklet runs on the Banner page and POSTs the extracted schedule
# directly to this app — that cross-origin request needs CORS, but only on
# the upload endpoint and only for the Banner origin.
BANNER_ORIGIN = 'https://generalssb-prod.ec.njit.edu'
UPLOAD_ENDPOINT = '/api/upload-schedule'
PROTECTED_ENDPOINTS = {UPLOAD_ENDPOINT, '/api/export-schedule', '/admin/visits'}


class _ProtectedRateLimiter:
    """Single-worker, thread-safe bad-response classification, not guess prevention.

    After 20 presented-but-wrong credentials per peer or 200 total per 60-second
    window, failures return 429. At most 200 peer entries are retained. Anonymous
    probes and valid credentials never consume this budget; valid credentials
    still work during throttling so a proxy-wide failure cannot lock out admins.
    Every presented secret is compared even after the budget is exhausted: this
    is NOT brute-force prevention. Deployment requires separate secrets of at
    least 32 random printable-ASCII characters plus edge abuse protection.
    State resets on restart; multiple workers/replicas require shared state.
    Identity is REMOTE_ADDR, adjusted only by explicitly configured ProxyFix.
    """

    def __init__(self):
        self.buckets = {}
        self._started_at = None
        self._total = 0
        self._lock = threading.Lock()

    def retry_after(self, peer):
        with self._lock:
            now = time.monotonic()
            if self._started_at is None or now - self._started_at >= 60:
                self._started_at = now
                self._total = 0
                self.buckets.clear()
            count = self.buckets.get(peer, 0)
            if self._total >= 200 or count >= 20:
                return max(1, math.ceil(self._started_at + 60 - now))
            self.buckets[peer] = count + 1
            self._total += 1
            return 0


def create_app(schedule=None, visit_db_path=None, metadata_registry=None):
    app = Flask(__name__)
    try:
        proxy_hops = int(os.environ.get('TRUSTED_PROXY_HOPS', '0'))
        if proxy_hops < 0:
            raise ValueError
    except ValueError:
        raise ValueError('TRUSTED_PROXY_HOPS must be a non-negative integer.') from None
    app.config['TRUSTED_PROXY_HOPS'] = proxy_hops
    if proxy_hops:
        # Opt in only when ingress strips/sets these headers and the exact hop
        # count is known. Never infer trust from the presence of a header.
        app.wsgi_app = ProxyFix(app.wsgi_app, x_for=proxy_hops, x_proto=proxy_hops,
                                x_host=0, x_port=0, x_prefix=0)
    app.config['MAX_CONTENT_LENGTH'] = MAX_UPLOAD_BYTES
    app.config['VISIT_DB_PATH'] = visit_db_path or os.environ.get(
        'VISIT_DB_PATH', os.path.join(app.instance_path, 'visits.sqlite3')
    )

    limiter = _ProtectedRateLimiter()
    app.extensions['protected_rate_limiter'] = limiter

    def _protected_required(secret_name, *, allow_form=False):
        def decorate(view):
            @wraps(view)
            def wrapped(*args, **kwargs):
                if request.method == 'OPTIONS':
                    return view(*args, **kwargs)
                required = os.environ.get(secret_name, '').strip()
                if not required:
                    return jsonify({'error': f'This endpoint is disabled. Set {secret_name}.'}), 503
                is_admin = secret_name == 'ADMIN_PASSWORD'
                if not is_admin and not (required.isascii() and required.isprintable()):
                    return jsonify({'error': 'This endpoint is disabled. UPLOAD_PASSWORD must contain only printable ASCII characters.'}), 503
                supplied = ''
                if is_admin:
                    auth = request.authorization
                    if auth and auth.type == 'basic':
                        supplied = auth.password or ''
                elif 'password' not in request.args:
                    # A supplied header is authoritative: never fall back to
                    # multipart credentials when a header is invalid.
                    if 'Authorization' in request.headers:
                        # Parse the raw scheme/value: Werkzeug interprets an
                        # internal '=' as auth parameters, not a Bearer secret.
                        parts = request.headers['Authorization'].split(None, 1)
                        if len(parts) == 2 and parts[0].lower() == 'bearer':
                            supplied = parts[1].strip()
                    elif allow_form:
                        # Reading the multipart envelope is necessary for the
                        # Banner form credential. No file is saved or schedule
                        # parsed until authorization has succeeded.
                        supplied = request.form.get('password', '').strip()
                if not hmac.compare_digest(supplied.encode('utf-8'), required.encode('utf-8')):
                    presented = supplied or request.headers.get('Authorization') or 'password' in request.args
                    retry_after = limiter.retry_after(request.remote_addr or '') if presented else 0
                    if retry_after:
                        return jsonify({'error': 'Too many failed credentials. Try again later.'}), 429, {
                            'Retry-After': str(retry_after),
                        }
                    challenge = 'Basic realm="Room Finder visitor report"' if is_admin else 'Bearer'
                    return jsonify({'error': 'Invalid or missing credentials.'}), 401, {
                        'WWW-Authenticate': challenge,
                    }
                return view(*args, **kwargs)
            return wrapped
        return decorate

    _admin_required = _protected_required('ADMIN_PASSWORD')

    registry = metadata_registry if metadata_registry is not None else load_registry()
    storage_dir = _storage_folder()
    app.config['SCHEDULE_STORAGE_DIR'] = storage_dir
    store = ScheduleStore(storage_dir)
    auto_loaded = schedule is None
    with _schedule_lock:
        if auto_loaded:
            entries, record = _load_best_schedule()
            snapshot = _make_snapshot(entries, record)
        else:
            snapshot = _make_snapshot(schedule)

    def _select_snapshot(replacement=None, replacement_entries=None):
        """Prepare selection without modifying active state or published files."""
        try:
            candidates = _all_schedule_candidates(storage_dir, replacement=replacement)
        except (OSError, ValueError):
            if replacement is not None:
                raise  # publication must fail closed, not silently keep old data
            return snapshot
        for record in candidates:
            if replacement is not None and record.path == replacement.path:
                return _make_snapshot(replacement_entries, replacement)
            if _record_key(record) == snapshot.record_key:
                return snapshot
            loaded = _load_candidate(record)
            if loaded is not None:
                entries, validated = loaded
                return _make_snapshot(entries, validated)
        # Missing/corrupt candidates must not erase the last usable snapshot.
        return snapshot

    def _maybe_reactivate():
        nonlocal snapshot
        snapshot = _select_snapshot()

    availability_paths = {'/api/rooms', '/api/rooms/all', '/api/buildings', '/api/room/schedule'}

    @app.before_request
    def prepare_availability_context():
        if request.path not in availability_paths | {'/api/schedule-info', '/api/heatmap', '/api/terms'}:
            return
        with _schedule_lock:
            if auto_loaded:
                _maybe_reactivate()
            g.schedule_snapshot = snapshot
            if request.path == '/api/terms':
                g.schedule_catalog = _stored_term_files(storage_dir, snapshot)
        g.schedule_entries = g.schedule_snapshot.entries
        g.schedule_version = g.schedule_snapshot.version
        if request.path not in availability_paths:
            return

        weekday, now, for_mins = resolve_query_context()
        at_time = parse_at_param(request.args.get('at'))
        preview = at_time is not None or parse_day_param(request.args.get('day')) is not None
        g.query_context = (weekday, now, for_mins)
        g.query_preview = preview
        if request.path == '/api/room/schedule' and '_weekday' in request.args:
            override = parse_day_param(request.args['_weekday'])
            if not request.args['_weekday'].strip().lstrip('+-').isdigit() or override is None:
                return jsonify({'error': '_weekday must be an integer from 0 to 6',
                                'error_code': 'invalid_weekday'}), 400
            weekday = override
            g.query_context = (weekday, now, for_mins)
            g.query_preview = True

        until_text = request.args.get('until')
        until = parse_at_param(until_text)
        if until_text is not None and (not re.fullmatch(r'[0-9]{2}:[0-9]{2}', until_text) or until is None):
            return jsonify({'error': 'Window end must be a valid HH:MM time',
                            'error_code': 'invalid_window'}), 400
        try:
            # Use the same validation even for empty inventories and unknown rooms.
            get_availability_facts([], now, min_duration_mins=for_mins, until=until)
        except ValueError as error:
            code, message = 'invalid_window', str(error)
            if at_time is None:
                if until is not None and until <= now:
                    code = 'window_ended'
                elif until is None and now.hour * 60 + now.minute + for_mins > 24 * 60:
                    code = 'duration_exceeds_day'
                    message = 'Choose a shorter duration or a start time; this search cannot cross midnight.'
            return jsonify({'error': message, 'error_code': code}), 400
        g.query_until = until

    @app.after_request
    def add_availability_headers(response):
        if hasattr(g, 'schedule_version'):
            response.headers['X-Schedule-Version'] = g.schedule_version
        if hasattr(g, 'query_context'):
            weekday, now, _ = g.query_context
            response.headers['X-Query-Day'] = list(DAY_NAMES)[weekday].title()
            response.headers['X-Query-Time'] = now.strftime('%H:%M')
            response.headers['X-Query-Timezone'] = 'America/New_York'
            response.headers['X-Query-Preview'] = '1' if g.query_preview else '0'
        return response

    @app.after_request
    def add_protected_headers(response):
        # Apply by path, not decorator, to cover all statuses, including
        # framework-generated 405/413/500 responses and unauthenticated errors.
        if request.path in PROTECTED_ENDPOINTS:
            response.headers['Cache-Control'] = 'no-store'
            response.headers['X-Robots-Tag'] = 'noindex, nofollow'
        if request.path == UPLOAD_ENDPOINT:
            response.headers['Access-Control-Allow-Origin'] = BANNER_ORIGIN
            response.headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS'
            response.headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization'
        return response

    @app.errorhandler(413)
    def upload_too_large(error):
        if request.path == UPLOAD_ENDPOINT:
            return jsonify({'error': 'Schedule file exceeds the upload size limit.'}), 413
        return error.get_response()

    @app.route("/ping")
    def ping():
        return "ok", 200

    @app.route("/")
    def index():
        visitor_id = normalize_visitor_id(request.cookies.get('room_finder_visitor'))
        # Same identity as throttling; ProxyFix adjusts it only with explicit trust.
        ip_address = request.remote_addr or ''
        salt = os.environ.get('VISITOR_LOG_SALT') or os.environ.get('ADMIN_PASSWORD') or 'local-development'
        try:
            record_visit(
                app.config['VISIT_DB_PATH'], visitor_id, ip_address,
                request.headers.get('User-Agent', ''),
                request.headers.get('Referer', ''), salt,
            )
        except (sqlite3.Error, OSError):
            # Analytics must never take down the public page; an unwritable or
            # missing storage directory raises OSError before SQLite is reached.
            app.logger.exception('Could not record visitor')
        response = app.make_response(render_template("index.html"))
        response.set_cookie(
            'room_finder_visitor', visitor_id, max_age=60 * 60 * 24 * 365,
            secure=request.is_secure, httponly=True, samesite='Lax'
        )
        return response

    @app.route('/admin/visits')
    @_admin_required
    def visitor_report():
        visits, summary = get_visits(app.config['VISIT_DB_PATH'])
        for visit in visits:
            parsed = datetime.fromisoformat(visit['visited_at'])
            visit['local_time'] = parsed.astimezone(EASTERN).strftime('%a, %b %-d, %Y · %-I:%M:%S %p')
        return render_template('visits.html', visits=visits, summary=summary)

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

    def _query_rooms(building=None, entries=None):
        weekday, now, for_mins = g.query_context
        return [registry.enrich_room(row) for row in get_room_availability(
            g.schedule_entries if entries is None else entries, weekday, now,
            building=building, min_duration_mins=for_mins, until=g.query_until,
        )]

    @app.route("/api/rooms")
    def rooms():
        result = _query_rooms(building=request.args.get('building') or None)
        return jsonify([row for row in result if row['matches_requested_window']])

    @app.route("/api/buildings")
    def buildings_api():
        by_building = {}
        for room in _query_rooms():
            counts = by_building.setdefault(room['building'], {
                'building': room['building'], 'total_rooms': 0,
                'empty_rooms': 0, 'matching_rooms': 0,
            })
            counts['total_rooms'] += 1
            counts['empty_rooms'] += int(room['empty'])
            counts['matching_rooms'] += int(room['matches_requested_window'])

        for counts in by_building.values():
            counts['occupied_rooms'] = counts['total_rooms'] - counts['empty_rooms']
            counts['occupancy_pct'] = round(counts['occupied_rooms'] / counts['total_rooms'] * 100)
        return jsonify([registry.enrich_building(by_building[b]) for b in sorted(by_building)])

    @app.route("/api/rooms/all")
    def all_rooms_api():
        result = _query_rooms(building=request.args.get('building') or None)
        return jsonify(result)

    @app.route("/api/room/schedule")
    def room_schedule_api():
        building = request.args.get("building", "").strip()
        room_num  = request.args.get("room", "").strip()
        if not building or not room_num:
            return jsonify({'error': 'building and room are required'}), 400

        weekday, now, _ = g.query_context
        now_min = now.hour * 60 + now.minute
        room_entries = [e for e in g.schedule_entries
                        if e['building'] == building and e['room'] == room_num]
        if not room_entries:
            return jsonify({'error': 'Room not found in the active schedule'}), 404
        availability, = _query_rooms(entries=room_entries)
        today_classes = sorted(
            [e for e in room_entries if weekday in e['days']],
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

        next_cls = next((c for c in classes_out if c['start_min'] > now_min), None)
        next_free_window = _compute_next_free_window(classes_out, now_min)
        return jsonify({
            **availability,
            'classes':           classes_out,
            'now_min':           now_min,
            'occupied_now':      not availability['empty'],
            'next_class':        next_cls,
            'weekday':           list(DAY_NAMES)[weekday].title(),
            'next_free_window':  next_free_window,
        })

    @app.route("/api/heatmap")
    def heatmap_api():
        """Per-building weekly occupancy: for each weekday and each hour
        7 AM–10 PM, how many rooms have a class overlapping that hour."""
        building = request.args.get("building", "").strip()
        if not building:
            return jsonify({'error': 'building is required'}), 400

        entries = [e for e in g.schedule_entries if e['building'] == building]
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
        terms = []
        for term, (path, source) in sorted(g.schedule_catalog.items(), reverse=True):
            active = bool(g.schedule_snapshot.record_key and path == g.schedule_snapshot.record_key[0])
            filename = f'uploaded_schedule_{term}{Path(path).suffix}' if source == 'uploaded' else Path(path).name
            terms.append({
                'term': term, 'semester': _term_label(term),
                'filename': g.schedule_snapshot.filename if active else filename,
                'source': source, 'active': active, 'status': _schedule_status(term, today),
            })
        return jsonify(terms)

    @app.route("/api/export-schedule")
    @_protected_required('UPLOAD_PASSWORD')
    def export_schedule():
        """Download a stored term's schedule using a Bearer upload credential.
        Password query parameters are rejected, even with a valid header."""
        term_str = request.args.get('term', '').strip()
        # str.isdigit() accepts superscripts and other Unicode digits that
        # int() rejects, and does not bound the value echoed back on 404.
        if not re.fullmatch(r'[0-9]{1,9}', term_str):
            return jsonify({'error': 'term is required, e.g. ?term=202650'}), 400
        with _schedule_lock:
            if auto_loaded:
                _maybe_reactivate()
            entry = _stored_term_files(storage_dir, snapshot).get(int(term_str))
        if not entry:
            return jsonify({'error': f'No stored schedule for term {term_str}.'}), 404
        filename = entry[0]
        ext = os.path.splitext(filename)[1]
        return send_from_directory(
            os.path.dirname(filename), os.path.basename(filename), as_attachment=True,
            download_name=f'Course_Schedule_{term_str}{ext}'
        )

    @app.route("/api/schedule-info")
    def schedule_info():
        entries = g.schedule_entries
        buildings = set(e['building'] for e in entries)
        rooms = set((e['building'], e['room']) for e in entries)
        weekday, _ = get_current_time()
        has_classes_today = any(weekday in e['days'] for e in entries)
        today = datetime.now(EASTERN).date()
        state = g.schedule_snapshot
        term = state.term
        return jsonify({
            'filename': state.filename,
            'loaded_at': state.activated_at,
            'activated_at': state.activated_at,
            'imported_at': state.imported_at,
            'source_filename': state.source_filename,
            'source_exported_at': state.source_exported_at,
            'entries': len(entries),
            'schedule_version': g.schedule_version,
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
    @_protected_required('UPLOAD_PASSWORD', allow_form=True)
    def upload_schedule():
        if request.method == "OPTIONS":
            return "", 204  # CORS preflight; headers added by after_request

        if 'file' not in request.files:
            return jsonify({'error': 'No file provided.'}), 400
        f = request.files['file']
        if not f.filename:
            return jsonify({'error': 'Empty filename.'}), 400
        if not f.filename.lower().endswith(('.csv', '.xlsx')):
            return jsonify({'error': 'Only CSV or Excel (.xlsx) files are accepted.'}), 400

        nonlocal snapshot, auto_loaded
        source_filename = f.filename.replace('\\', '/').rsplit('/', 1)[-1]
        if len(source_filename) > 255 or any(ord(ch) < 32 for ch in source_filename):
            return jsonify({'error': 'Use a source filename of at most 255 characters without control characters.'}), 400
        ext = '.xlsx' if source_filename.lower().endswith('.xlsx') else '.csv'
        tmp_path = None
        with _schedule_lock:
            try:
                tmp_path = store.stage(f, ext)
                try:
                    import_report = {}
                    new_data = load_schedule(tmp_path, report=import_report)
                    if not new_data:
                        raise ScheduleValidationError(['no scheduled in-person entries'])
                    term = _term_from_entries(new_data)
                except ScheduleValidationError as error:
                    return jsonify({'error': str(error), 'diagnostics': error.diagnostics,
                                    'error_count': error.error_count}), 422
                except Exception:
                    # Third-party parser errors can contain arbitrary workbook text.
                    return jsonify({'error': 'Could not parse schedule. Export a fresh single-semester CSV or XLSX file.'}), 422
                version = _schedule_version(new_data)
                publication = store.prepare(tmp_path, term, source_filename, version)
                next_snapshot = _select_snapshot(publication.record, new_data)
                # Prepare the complete response and snapshot before the commit point.
                payload = {
                    'success': True, 'filename': source_filename,
                    'import_diagnostics': import_report,
                    'exclusion_note': 'Explicit online modes and unscheduled blank/TBA meetings are excluded from physical-room occupancy.',
                    'loaded_at': next_snapshot.activated_at,
                    'activated_at': next_snapshot.activated_at,
                    'imported_at': publication.record.imported_at,
                    'source_filename': source_filename, 'source_exported_at': None,
                    'schedule_version': next_snapshot.version,
                    'entries': len(new_data),
                    'buildings': len({e['building'] for e in new_data}),
                    'rooms': len({(e['building'], e['room']) for e in new_data}),
                    'uploaded_semester': _term_label(term),
                    'active_semester': _term_label(next_snapshot.term),
                }
                response = jsonify(payload)
                store.commit(publication)
                tmp_path = None  # moved into its immutable published payload
                snapshot = next_snapshot
                auto_loaded = True
                return response
            except (OSError, ValueError):
                return jsonify({'error': 'Schedule could not be saved. The previous schedule is unchanged; check storage permissions and retry.'}), 500
            finally:
                if tmp_path is not None:
                    Path(tmp_path).unlink(missing_ok=True)

    _start_keepalive()
    return app


# Module-level app instance for gunicorn (production)
app = create_app()

if __name__ == "__main__":
    app.run(host='0.0.0.0', debug=False, port=5000)
