import base64
import sqlite3
from datetime import time

from app import create_app


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
