"""Import safety and coherent snapshots; all storage and secrets are disposable."""
import csv
import io
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, time
from pathlib import Path
from unittest.mock import patch

import pytest

import app as app_module
from app import create_app
from schedule import load_schedule

FIELDS = ['Term', 'Course', 'Days', 'Times', 'Location', 'Max', 'Delivery Mode']
AUTH = {'Authorization': 'Bearer import-test-secret'}


def csv_bytes(**changes):
    row = dict(zip(FIELDS, ['202690', 'CS 101', 'MW', '9:00 AM - 10:00 AM', 'TEST G-08', '40', 'Face-to-Face']))
    row.update(changes)
    stream = io.StringIO()
    writer = csv.DictWriter(stream, fieldnames=FIELDS)
    writer.writeheader()
    writer.writerow(row)
    return stream.getvalue().encode()


@pytest.fixture
def isolated(tmp_path, monkeypatch):
    storage = tmp_path / 'storage'
    legacy = tmp_path / 'legacy'
    legacy.mkdir()
    monkeypatch.setenv('SCHEDULE_STORAGE_DIR', str(storage))
    monkeypatch.setenv('UPLOAD_PASSWORD', 'import-test-secret')
    monkeypatch.setattr(app_module, 'UPLOAD_FOLDER', str(legacy))
    monkeypatch.setattr(app_module, '_expected_term', lambda today: 202690)
    monkeypatch.delenv('RENDER_EXTERNAL_URL', raising=False)
    return storage, legacy, tmp_path / 'visits.sqlite3'


def upload(client, body=None, filename='original.csv'):
    return client.post('/api/upload-schedule', headers=AUTH,
                       data={'file': (io.BytesIO(body if body is not None else csv_bytes()), filename)})


def info(client):
    response = client.get('/api/schedule-info')
    assert response.status_code == 200
    assert response.headers['X-Schedule-Version'] == response.json['schedule_version']
    return response.json


@pytest.mark.parametrize('field,value', [
    ('Days', 'MX'), ('Times', '10:00 AM - 9:00 AM'),
    ('Times', '9:00 AM - 9:00 AM'), ('Times', 'bad'),
    ('Location', 'TEST'), ('Max', '-1'), ('Max', '3.5'),
    ('Max', 'NaN'), ('Max', 'Infinity'), ('Term', '202699'),
    ('Delivery Mode', 'Unknown physical mode'),
])
def test_malformed_inperson_row_rejects_entire_import(tmp_path, field, value):
    path = tmp_path / 'bad.csv'
    good = csv_bytes()
    path.write_bytes(good + csv_bytes(**{field: value}).split(b'\r\n', 1)[1])
    with pytest.raises(ValueError, match='row|Row'):
        load_schedule(path)


@pytest.mark.parametrize('location', ['TEST G-08', 'TEST 100A', 'CTR BOWL', 'CULM LECT 1', 'CULM LECT 2', 'CULM LECT 3'])
def test_exact_identifiers_bom_and_blank_capacity(tmp_path, location):
    path = tmp_path / 'good.csv'
    path.write_bytes(b'\xef\xbb\xbf' + csv_bytes(Location=location, Max=''))
    entry, = load_schedule(path)
    assert entry['room'] == location.split(' ', 1)[1]
    assert entry['capacity'] is None


def test_legacy_blank_mode_without_physical_location_is_excluded(tmp_path):
    path = tmp_path / 'legacy.csv'
    path.write_bytes(csv_bytes() + csv_bytes(**{'Delivery Mode': '', 'Location': '', 'Max': '0'}).split(b'\r\n', 1)[1])
    assert len(load_schedule(path)) == 1
    path.write_bytes(csv_bytes() + csv_bytes(**{'Delivery Mode': ''}).split(b'\r\n', 1)[1])
    with pytest.raises(ValueError, match='Delivery Mode'):
        load_schedule(path)


def test_physical_converged_learning_included_and_online_tba_excluded(tmp_path):
    path = tmp_path / 'modes.csv'
    path.write_bytes(csv_bytes(**{'Delivery Mode': 'Converged Learning'}) +
                     csv_bytes(**{'Delivery Mode': 'Online Newark', 'Times': 'TBA', 'Location': ''}).split(b'\r\n', 1)[1] +
                     csv_bytes(Times='TBA', Days='', Location='').split(b'\r\n', 1)[1])
    assert len(load_schedule(path)) == 1


@pytest.mark.parametrize('body', [b'Wrong,Headers\n1,2\n', csv_bytes().split(b'\r\n')[0] + b'\r\n',
                                csv_bytes() + csv_bytes(Term='202650').split(b'\r\n', 1)[1]])
def test_invalid_schema_empty_and_mixed_terms(tmp_path, body):
    path = tmp_path / 'invalid.csv'
    path.write_bytes(body)
    with pytest.raises(ValueError):
        load_schedule(path)


def test_errors_are_bounded_and_do_not_echo_cell_contents(tmp_path):
    path = tmp_path / 'bad.csv'
    path.write_bytes(csv_bytes(Times='untrusted-' + 'x' * 10000) * 50)
    with pytest.raises(ValueError) as error:
        load_schedule(path)
    assert len(str(error.value)) < 2500
    assert 'untrusted-' not in str(error.value)


def test_import_restart_provenance_original_export_and_legacy_preservation(isolated):
    storage, legacy, db = isolated
    historical = legacy / 'uploaded_schedule.csv'
    historical.write_bytes(csv_bytes(Term='', Location='OLD 101'))
    client = create_app(visit_db_path=str(db)).test_client()
    before = info(client)
    assert before['imported_at'] is None
    response = upload(client, filename='source-name.csv')
    assert response.status_code == 200
    first = info(client)
    assert first['source_filename'] == 'source-name.csv'
    assert first['source_exported_at'] is None
    for field in ('imported_at', 'activated_at', 'loaded_at'):
        assert datetime.fromisoformat(first[field]).utcoffset().total_seconds() == 0
    assert historical.read_bytes() == csv_bytes(Term='', Location='OLD 101')
    assert list(legacy.iterdir()) == [historical]
    assert client.get('/api/export-schedule?term=202690', headers=AUTH).data == csv_bytes()
    restarted = create_app(visit_db_path=str(db)).test_client()
    second = info(restarted)
    assert second['schedule_version'] == first['schedule_version']
    assert second['imported_at'] == first['imported_at']
    assert second['source_filename'] == 'source-name.csv'
    assert storage.is_dir()


def test_success_reports_legitimate_online_and_unscheduled_exclusions(isolated):
    _, _, db = isolated
    client = create_app(visit_db_path=str(db)).test_client()
    body = csv_bytes() + csv_bytes(**{'Delivery Mode': 'Online Newark'}).split(b'\r\n', 1)[1] + csv_bytes(Times='TBA', Days='', Location='').split(b'\r\n', 1)[1]
    response = upload(client, body)
    assert response.status_code == 200
    assert response.json['import_diagnostics'] == {
        'accepted_rows': 1, 'excluded_online': 1, 'excluded_unscheduled': 1,
    }
    assert 'online' in response.json['exclusion_note'].lower()
    assert 'TBA' in response.json['exclusion_note']


def test_invalid_import_preserves_disk_and_active_snapshot(isolated):
    storage, _, db = isolated
    client = create_app(visit_db_path=str(db)).test_client()
    assert upload(client).status_code == 200
    before = info(client)
    files = {p.name: p.read_bytes() for p in storage.iterdir()}
    assert upload(client, csv_bytes(Times='bad')).status_code == 422
    assert info(client) == before
    assert {p.name: p.read_bytes() for p in storage.iterdir()} == files


def test_termless_upload_is_retained_and_does_not_hide_termed_schedule(isolated):
    _, _, db = isolated
    client = create_app(visit_db_path=str(db)).test_client()
    assert upload(client).status_code == 200
    original = info(client)
    assert upload(client, csv_bytes(Term='', Location='FALLBACK BOWL')).status_code == 200
    assert info(client)['schedule_version'] == original['schedule_version']
    assert info(create_app(visit_db_path=str(db)).test_client())['schedule_version'] == original['schedule_version']


def test_version_is_computed_once_not_per_request(isolated):
    _, _, db = isolated
    entries = [{'building': 'TEST', 'room': '101', 'days': [0], 'time_start': time(9), 'time_end': time(10)}]
    with patch.object(app_module, '_schedule_version', wraps=app_module._schedule_version) as version:
        client = create_app(entries, visit_db_path=str(db)).test_client()
        initial_calls = version.call_count
        assert initial_calls == 1
        for _ in range(3):
            for path in ('/api/rooms', '/api/rooms/all', '/api/buildings', '/api/room/schedule?building=TEST&room=101', '/api/schedule-info', '/api/heatmap?building=TEST'):
                assert client.get(path).status_code == 200
        assert version.call_count == initial_calls


def test_injected_entries_are_detached_including_nested_days(isolated):
    _, _, db = isolated
    entries = [{'building': 'TEST', 'room': '101', 'days': [0], 'time_start': time(9), 'time_end': time(10)}]
    client = create_app(entries, visit_db_path=str(db)).test_client()
    original = info(client)
    entries[0]['room'] = 'CHANGED'
    entries[0]['days'].clear()
    assert info(client) == original
    room, = client.get('/api/rooms/all?day=Monday&at=09:30').json
    assert room['room'] == '101' and room['empty'] is False


@pytest.mark.parametrize('bad', [b'bad data', b'Term,Course,Days,Times,Location,Max,Delivery Mode\n'])
def test_failed_candidate_memoized_until_stat_changes(isolated, bad):
    _, legacy, db = isolated
    candidate = legacy / 'uploaded_schedule_202690.csv'
    candidate.write_bytes(bad)
    (legacy / 'schedule_default.csv').write_bytes(csv_bytes(Term='202650'))
    with patch.object(app_module, 'load_schedule', wraps=load_schedule) as load:
        client = create_app(visit_db_path=str(db)).test_client()
        for _ in range(3):
            info(client)
            client.get('/api/rooms')
        failed_calls = [call for call in load.call_args_list if Path(call.args[0]).name == candidate.name]
        assert len(failed_calls) == 1
        candidate.write_bytes(csv_bytes(Location='NEW 202'))
        assert info(client)['semester'] == 'Fall 2026'
        assert len([call for call in load.call_args_list if Path(call.args[0]).name == candidate.name]) == 2


def test_heatmap_rollover_captures_version(isolated, monkeypatch):
    _, legacy, db = isolated
    (legacy / 'uploaded_schedule_202650.csv').write_bytes(csv_bytes(Term='202650', Location='OLD 101'))
    (legacy / 'uploaded_schedule_202690.csv').write_bytes(csv_bytes(Location='NEW 202'))
    monkeypatch.setattr(app_module, '_expected_term', lambda today: 202650)
    client = create_app(visit_db_path=str(db)).test_client()
    before = client.get('/api/heatmap?building=OLD')
    monkeypatch.setattr(app_module, '_expected_term', lambda today: 202690)
    after = client.get('/api/heatmap?building=NEW')
    assert before.status_code == after.status_code == 200
    assert before.headers['X-Schedule-Version'] != after.headers['X-Schedule-Version']
    assert after.headers['X-Schedule-Version'] == info(client)['schedule_version']


@pytest.mark.parametrize('path', ['/api/schedule-info', '/api/rooms/all?day=Monday&at=09:30', '/api/heatmap?building=TEST', '/api/terms'])
def test_request_keeps_entries_version_and_provenance_across_import(isolated, path):
    from flask import request
    _, _, db = isolated
    app = create_app(visit_db_path=str(db))
    client = app.test_client()
    captured = threading.Event()
    resume = threading.Event()
    @app.before_request
    def pause_after_capture():
        if request.path != '/api/upload-schedule' and threading.current_thread().name.startswith('snapshot-reader'):
            captured.set()
            assert resume.wait(timeout=10)
    assert upload(client).status_code == 200
    original = client.get(path)
    with ThreadPoolExecutor(max_workers=1, thread_name_prefix='snapshot-reader') as pool:
        future = pool.submit(lambda: app.test_client().get(path))
        assert captured.wait(timeout=10)
        try:
            assert upload(client, csv_bytes(Location='REPLACED 202'), 'second.csv').status_code == 200
        finally:
            resume.set()
        old_response = future.result(timeout=10)
    assert old_response.json == original.json
    assert old_response.headers['X-Schedule-Version'] == original.headers['X-Schedule-Version']
    assert info(client)['schedule_version'] != original.headers['X-Schedule-Version']


def _format_bytes(extension, **changes):
    body = csv_bytes(**changes)
    if extension == 'csv':
        return body
    from openpyxl import Workbook
    workbook = Workbook()
    for row in csv.reader(io.StringIO(body.decode())):
        workbook.active.append(row)
    output = io.BytesIO()
    workbook.save(output)
    return output.getvalue()


@pytest.mark.parametrize('good_ext,bad_ext', [('csv', 'csv'), ('xlsx', 'csv'), ('csv', 'xlsx')])
def test_terms_and_export_agree_with_validated_active_source(isolated, good_ext, bad_ext):
    _, legacy, db = isolated
    good = legacy / f'Course_Schedule_202690.{good_ext}'
    bad = legacy / f'uploaded_schedule_202690.{bad_ext}'
    original_bytes = _format_bytes(good_ext)
    good.write_bytes(original_bytes)
    bad.write_bytes(_format_bytes(bad_ext, Times='malformed'))
    with patch.object(app_module, 'load_schedule', wraps=load_schedule) as load:
        client = create_app(visit_db_path=str(db)).test_client()
        active = info(client)
        assert active['filename'] == good.name
        for _ in range(3):
            term, = client.get('/api/terms').json
            assert term['source'] == 'bundled'
            assert term['active'] is True
            assert term['filename'] == active['filename']
            exported = client.get('/api/export-schedule?term=202690', headers=AUTH)
            assert exported.status_code == 200
            assert exported.data == original_bytes
            assert f'Course_Schedule_202690.{good_ext}' in exported.headers['Content-Disposition']
            assert exported.headers['Cache-Control'] == 'no-store'
        for candidate in (good, bad):
            assert len([call for call in load.call_args_list if Path(call.args[0]) == candidate]) == 1


def test_terms_preserve_actual_active_legacy_filename(isolated):
    _, legacy, db = isolated
    candidate = legacy / 'uploaded_schedule.csv'
    candidate.write_bytes(csv_bytes())
    client = create_app(visit_db_path=str(db)).test_client()
    active = info(client)
    term, = client.get('/api/terms').json
    assert term['filename'] == active['filename'] == candidate.name
    assert term['active'] is True
    assert client.get('/api/export-schedule?term=202690', headers=AUTH).data == csv_bytes()


def test_unexamined_historical_terms_are_validated_and_cached(isolated):
    _, legacy, db = isolated
    (legacy / 'Course_Schedule_202690.csv').write_bytes(csv_bytes())
    bad_only = legacy / 'uploaded_schedule_202610.csv'
    bad_only.write_bytes(csv_bytes(Term='202610', Times='malformed'))
    bad_preferred = legacy / 'uploaded_schedule_202650.csv'
    bad_preferred.write_bytes(csv_bytes(Term='202650', Times='malformed'))
    fallback = legacy / 'Course_Schedule_202650.xlsx'
    fallback_bytes = _format_bytes('xlsx', Term='202650')
    fallback.write_bytes(fallback_bytes)
    with patch.object(app_module, 'load_schedule', wraps=load_schedule) as load:
        client = create_app(visit_db_path=str(db)).test_client()
        for _ in range(3):
            terms = {term['term']: term for term in client.get('/api/terms').json}
            assert set(terms) == {202650, 202690}
            assert terms[202650]['source'] == 'bundled'
            assert terms[202650]['active'] is False
            assert client.get('/api/export-schedule?term=202610', headers=AUTH).status_code == 404
            assert client.get('/api/export-schedule?term=202650', headers=AUTH).data == fallback_bytes
        for candidate in (bad_only, bad_preferred, fallback):
            assert len([call for call in load.call_args_list if Path(call.args[0]) == candidate]) == 1
        # A changed historical candidate is revalidated, not permanently hidden.
        repaired_bytes = csv_bytes(Term='202650', Location='REPAIRED 202')
        bad_preferred.write_bytes(repaired_bytes)
        terms = {term['term']: term for term in client.get('/api/terms').json}
        assert terms[202650]['source'] == 'uploaded'
        assert client.get('/api/export-schedule?term=202650', headers=AUTH).data == repaired_bytes


@pytest.mark.parametrize('failure', ['json', 'nested_json', 'open', 'stat'])
def test_unreadable_manifest_preserves_live_snapshot_and_recovers_truthfully(isolated, monkeypatch, failure):
    from schedule_store import MANIFEST_NAME
    storage, legacy, db = isolated
    (legacy / 'Course_Schedule_202650.csv').write_bytes(csv_bytes(Term='202650', Location='OLDER 101'))
    client = create_app(visit_db_path=str(db)).test_client()
    assert upload(client, filename='known-source.csv').status_code == 200
    original = info(client)
    manifest = storage / MANIFEST_NAME
    good_manifest = manifest.read_bytes()
    files_before = set(storage.iterdir())
    with monkeypatch.context() as m:
        if failure == 'json':
            manifest.write_text('{not json')
        elif failure == 'nested_json':
            from schedule_store import MAX_MANIFEST_BYTES, published_records
            depth = 100_000
            manifest.write_text('[' * depth + '0' + ']' * depth)
            assert manifest.stat().st_size < MAX_MANIFEST_BYTES
            with pytest.raises(ValueError, match='nesting limit') as error:
                published_records(storage)
            assert len(str(error.value)) < 200
        else:
            method = getattr(Path, failure)
            def unavailable(path, *args, **kwargs):
                if path == manifest:
                    raise PermissionError('synthetic manifest read denial')
                return method(path, *args, **kwargs)
            m.setattr(Path, failure, unavailable)
        assert info(client) == original
        assert info(client) == original
        terms = {term['term']: term for term in client.get('/api/terms').json}
        assert terms[202690]['filename'] == original['filename']
        assert terms[202690]['source'] == 'uploaded' and terms[202690]['active'] is True
        assert client.get('/api/export-schedule?term=202690', headers=AUTH).data == csv_bytes()
        assert upload(client, csv_bytes(Location='REJECTED 999')).status_code == 500
        assert info(client) == original
        assert set(storage.iterdir()) == files_before
        # A restarted process has no trusted in-memory provenance. It may read
        # legacy data, but must not claim an orphan payload is a known import.
        restarted = create_app(visit_db_path=str(db)).test_client()
        fallback = info(restarted)
        assert fallback['filename'] == 'Course_Schedule_202650.csv'
        assert fallback['imported_at'] is None
        assert fallback['source_filename'] is None
        assert fallback['schedule_version'] != original['schedule_version']
    manifest.write_bytes(good_manifest)
    assert info(client) == original  # recovery is not a new activation
    recovered = info(restarted)
    assert recovered['filename'] == original['filename']
    assert recovered['schedule_version'] == original['schedule_version']
    assert recovered['imported_at'] == original['imported_at']
    assert recovered['activated_at'] != original['activated_at']


def test_concurrent_imports_are_serialized_and_restart_matches(isolated, monkeypatch):
    _, _, db = isolated
    app = create_app(visit_db_path=str(db))
    barrier = threading.Barrier(2)
    active = 0
    maximum = 0
    guard = threading.Lock()
    def observed_parse(path, **kwargs):
        nonlocal active, maximum
        with guard:
            active += 1
            maximum = max(maximum, active)
        try:
            return load_schedule(path, **kwargs)
        finally:
            with guard:
                active -= 1
    monkeypatch.setattr(app_module, 'load_schedule', observed_parse)
    def send(room):
        barrier.wait(timeout=10)
        return upload(app.test_client(), csv_bytes(Location=f'TEST {room}')).status_code
    with ThreadPoolExecutor(max_workers=2) as pool:
        assert list(pool.map(send, ('FIRST', 'SECOND'))) == [200, 200]
    assert maximum == 1
    current = info(app.test_client())
    assert info(create_app(visit_db_path=str(db)).test_client())['schedule_version'] == current['schedule_version']
