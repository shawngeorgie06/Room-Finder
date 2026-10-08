import base64
import hashlib
import sqlite3
import re
from datetime import datetime, time, timedelta, timezone

import pytest

from app import create_app
from visitor_log import RETENTION_DAYS, get_visits, record_visit


@pytest.fixture(autouse=True)
def untrusted_proxy_by_default(monkeypatch):
    monkeypatch.delenv('TRUSTED_PROXY_HOPS', raising=False)


def _client(tmp_path):
    app = create_app(schedule=[{
        'building': 'TEST', 'room': '1', 'days': [0],
        'time_start': time(9), 'time_end': time(10),
    }], visit_db_path=str(tmp_path / 'visits.sqlite3'))
    app.config['TESTING'] = True
    return app.test_client(), app.config['VISIT_DB_PATH']


def _basic(password):
    token = base64.b64encode(f'admin:{password}'.encode()).decode()
    return {'Authorization': f'Basic {token}'}


def test_index_records_visit_and_reuses_browser_id(tmp_path):
    client, path = _client(tmp_path)
    client.get('/', headers={'User-Agent': 'Test Browser', 'X-Forwarded-For': '203.0.113.5'})
    client.get('/', headers={'User-Agent': 'Test Browser', 'X-Forwarded-For': '203.0.113.5'})

    with sqlite3.connect(path) as db:
        rows = db.execute('SELECT visitor_id, ip_hash FROM visits').fetchall()
    assert len(rows) == 2
    assert rows[0][0] == rows[1][0]
    assert rows[0][1] != '203.0.113.5'


def test_unwritable_visit_storage_does_not_break_the_public_page(tmp_path):
    """Analytics is best-effort; an unwritable directory raises OSError from
    os.makedirs before SQLite is ever reached."""
    readonly = tmp_path / 'readonly'
    readonly.mkdir(mode=0o500)
    try:
        app = create_app(schedule=[], visit_db_path=str(readonly / 'nested' / 'visits.sqlite3'))
        app.config['TESTING'] = False
        response = app.test_client().get('/')
        assert response.status_code == 200
        assert b'NJIT Room Finder' in response.data
        assert not (readonly / 'nested').exists()
    finally:
        readonly.chmod(0o700)


def test_report_is_disabled_without_admin_password(tmp_path, monkeypatch):
    monkeypatch.delenv('ADMIN_PASSWORD', raising=False)
    client, _ = _client(tmp_path)
    assert client.get('/admin/visits').status_code == 503


def test_report_requires_password_and_lists_visit(tmp_path, monkeypatch):
    monkeypatch.setenv('ADMIN_PASSWORD', 'correct horse')
    client, _ = _client(tmp_path)
    client.get('/', headers={'User-Agent': 'Test Browser'})

    assert client.get('/admin/visits').status_code == 401
    response = client.get('/admin/visits', headers=_basic('correct horse'))
    assert response.status_code == 200
    assert b'Test Browser' in response.data
    assert b'1</span>page opens' in response.data
    assert response.headers['Cache-Control'] == 'no-store'


def test_non_page_requests_are_not_recorded(tmp_path):
    client, path = _client(tmp_path)
    client.get('/ping')
    client.get('/api/rooms')
    client.get('/admin/visits')
    if not tmp_path.joinpath('visits.sqlite3').exists():
        return
    with sqlite3.connect(path) as db:
        count = db.execute('SELECT COUNT(*) FROM visits').fetchone()[0]
    assert count == 0


@pytest.mark.parametrize('referrer,expected', [
    ('https://example.test/path?password=private#token', 'https://example.test/path'),
    ('https://name:password@example.test/path?token=private', 'https://example.test/path'),
    ('https://example.test/path', 'https://example.test/path'),
    ('https://[broken/?password=private', ''),
    ('javascript:private', ''),
])
def test_referrer_is_redacted_before_persistence(tmp_path, referrer, expected):
    client, path = _client(tmp_path)
    client.get('/', headers={'Referer': referrer})
    with sqlite3.connect(path) as db:
        assert db.execute('SELECT referrer FROM visits').fetchone()[0] == expected


@pytest.mark.parametrize('cookie', ['untrusted', 'x' * 3000, '../path', 'A' * 32, ''])
def test_invalid_cookie_is_replaced_with_bounded_random_id(tmp_path, cookie):
    client, path = _client(tmp_path)
    client.set_cookie('room_finder_visitor', cookie)
    response = client.get('/')
    with sqlite3.connect(path) as db:
        visitor_id = db.execute('SELECT visitor_id FROM visits').fetchone()[0]
    assert re.fullmatch(r'[0-9a-f]{32}', visitor_id)
    assert visitor_id != cookie
    assert client.get_cookie('room_finder_visitor').value == visitor_id
    assert 'HttpOnly' in response.headers['Set-Cookie']
    assert 'SameSite=Lax' in response.headers['Set-Cookie']


def test_valid_cookie_stays_stable_and_secure_over_https(tmp_path):
    client, path = _client(tmp_path)
    visitor_id = 'a' * 32
    client.set_cookie('room_finder_visitor', visitor_id)
    response = client.get('/', base_url='https://localhost')
    with sqlite3.connect(path) as db:
        assert db.execute('SELECT visitor_id FROM visits').fetchone()[0] == visitor_id
    assert 'Secure' in response.headers['Set-Cookie']


def test_record_visit_defensively_bounds_identifiers_and_metadata(tmp_path):
    path = str(tmp_path / 'visits.sqlite3')
    record_visit(path, 'x' * 5000, '192.0.2.1', 'u' * 2000,
                 'https://example.test/' + 'p' * 2000 + '?private#secret', 'test-salt')
    with sqlite3.connect(path) as db:
        visitor_id, agent, referrer = db.execute('SELECT visitor_id, user_agent, referrer FROM visits').fetchone()
    assert re.fullmatch(r'[0-9a-f]{32}', visitor_id)
    assert len(agent) <= 500
    assert len(referrer) <= 1000
    assert 'private' not in referrer


@pytest.mark.parametrize('operation', ['read', 'write'])
def test_retention_prunes_expired_rows_on_reads_and_writes(tmp_path, operation):
    path = str(tmp_path / 'visits.sqlite3')
    record_visit(path, 'a' * 32, '192.0.2.1', 'Old Browser', '', 'test-salt')
    old = (datetime.now(timezone.utc) - timedelta(days=RETENTION_DAYS + 1)).isoformat()
    with sqlite3.connect(path) as db:
        db.execute('UPDATE visits SET visited_at = ?', (old,))
    if operation == 'write':
        record_visit(path, 'b' * 32, '192.0.2.2', 'New Browser', '', 'test-salt')
    visits, summary = get_visits(path)
    assert all(v['user_agent'] != 'Old Browser' for v in visits)
    assert summary['visits'] == (1 if operation == 'write' else 0)
    assert summary['visitors'] == summary['visits']
    with sqlite3.connect(path) as db:
        assert db.execute('SELECT COUNT(*) FROM visits WHERE visited_at = ?', (old,)).fetchone()[0] == 0


def test_forwarded_ip_does_not_override_direct_peer(tmp_path):
    client, path = _client(tmp_path)
    client.get('/', headers={'X-Forwarded-For': '203.0.113.1'})
    client.get('/', headers={'X-Forwarded-For': '203.0.113.2'})
    with sqlite3.connect(path) as db:
        hashes = db.execute('SELECT ip_hash FROM visits').fetchall()
    assert hashes[0] == hashes[1]


def test_opt_in_proxy_identity_is_shared_by_visits_and_throttle(tmp_path, monkeypatch):
    monkeypatch.setenv('TRUSTED_PROXY_HOPS', '1')
    monkeypatch.setenv('VISITOR_LOG_SALT', 'test-salt')
    monkeypatch.setenv('UPLOAD_PASSWORD', 'test-upload-secret')
    client, path = _client(tmp_path)
    headers = {'X-Forwarded-For': '203.0.113.1, 192.0.2.8', 'X-Forwarded-Proto': 'https'}
    response = client.get('/', headers=headers)
    assert 'Secure' in response.headers['Set-Cookie']
    assert client.get('/api/export-schedule', headers={**headers, 'Authorization': 'Bearer wrong'}).status_code == 401
    assert set(client.application.extensions['protected_rate_limiter'].buckets) == {'192.0.2.8'}
    with sqlite3.connect(path) as db:
        expected = hashlib.sha256(b'test-salt:192.0.2.8').hexdigest()[:12]
        assert db.execute('SELECT ip_hash FROM visits').fetchone()[0] == expected
