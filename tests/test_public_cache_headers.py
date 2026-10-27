"""Backend contract required by the public-only browser service worker.

Use an injected schedule, disposable visitor database/storage and test secrets.
Cookies and implicit HTTP Basic credentials must not personalize public routes;
Set-Cookie is not observable from browser Fetch and cannot enforce cache safety.
"""
import base64
from datetime import time
import io

import pytest

import app as app_module

CSV = (
    b'Term,Course,Days,Times,Location,Max,Delivery Mode\n'
    b'202690,TEST 101,M,2:30 PM - 3:30 PM,CKB 217,30,Face-to-Face\n'
)
UPLOAD_AUTH = {'Authorization': 'Bearer cache-contract-upload'}
REPORT_AUTH = {'Authorization': 'Basic ' + base64.b64encode(b'test:cache-contract-report').decode()}
PUBLIC_URLS = [
    '/',
    '/?view=rooms&building=CKB&room=CKB-217&saved=1',
    '/api/rooms?day=Monday&at=13:00&for=60',
    '/api/rooms/all?day=Monday&at=13:00&for=60',
    '/api/buildings?day=Monday&at=13:00&for=60',
    '/api/room/schedule?building=CKB&room=217&_weekday=0&at=13:00',
    '/api/heatmap?building=CKB',
    '/api/terms',
    '/api/schedule-info',
]


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(app_module, 'UPLOAD_FOLDER', str(tmp_path))
    monkeypatch.setenv('SCHEDULE_STORAGE_DIR', str(tmp_path))
    monkeypatch.setenv('ADMIN_PASSWORD', 'cache-contract-report')
    monkeypatch.setenv('UPLOAD_PASSWORD', 'cache-contract-upload')
    monkeypatch.setenv('VISITOR_LOG_SALT', 'cache-contract-disposable-salt')
    monkeypatch.delenv('RENDER_EXTERNAL_URL', raising=False)
    (tmp_path / 'uploaded_schedule_202690.csv').write_bytes(CSV)
    application = app_module.create_app(schedule=[{
        'building': 'CKB', 'room': '217', 'days': [0],
        'time_start': time(14, 30), 'time_end': time(15, 30),
        'capacity': 30, 'course': 'TEST 101', 'title': 'Synthetic class',
        'instructor': 'Test Instructor', 'term': 202690,
    }], visit_db_path=str(tmp_path / 'visits.sqlite3'))
    application.config['TESTING'] = True
    return application.test_client()


def assert_public_headers(response):
    assert response.status_code == 200
    assert not response.cache_control.private
    assert not response.cache_control.no_store
    vary = {header.strip().lower() for header in response.headers.get('Vary', '').split(',')}
    assert not vary.intersection({'cookie', 'authorization', '*'})


@pytest.mark.parametrize('url', PUBLIC_URLS)
def test_public_responses_remain_nonpersonalized_with_visitor_cookie_and_basic_auth(client, url):
    ordinary = client.get(url)
    assert_public_headers(ordinary)
    client.set_cookie('room_finder_visitor', '1' * 32)
    authenticated = client.get(url, headers=REPORT_AUTH)
    assert_public_headers(authenticated)
    assert ordinary.data == authenticated.data


def test_home_cookie_is_for_visitors_not_a_cache_privacy_signal(client):
    response = client.get('/')
    assert 'room_finder_visitor=' in response.headers['Set-Cookie']
    assert_public_headers(response)


@pytest.mark.parametrize('url,method,secret', [
    ('/admin/visits', 'get', 'ADMIN_PASSWORD'),
    ('/api/export-schedule?term=202690', 'get', 'UPLOAD_PASSWORD'),
    ('/api/upload-schedule', 'post', 'UPLOAD_PASSWORD'),
])
def test_protected_denials_and_disabled_routes_are_no_store(client, monkeypatch, url, method, secret):
    denied = getattr(client, method)(url)
    assert denied.status_code == 401
    assert denied.cache_control.no_store
    monkeypatch.delenv(secret)
    disabled = getattr(client, method)(url)
    assert disabled.status_code == 503
    assert disabled.cache_control.no_store


@pytest.mark.parametrize('url,headers', [
    ('/admin/visits', REPORT_AUTH),
    ('/api/export-schedule?term=202690', UPLOAD_AUTH),
])
def test_protected_read_successes_are_no_store(client, url, headers):
    response = client.get(url, headers=headers)
    assert response.status_code == 200
    assert response.cache_control.no_store


def test_protected_upload_success_is_no_store(client):
    response = client.post('/api/upload-schedule', headers=UPLOAD_AUTH, data={
        'file': (io.BytesIO(CSV), 'Course_Schedule_202690.csv'),
    })
    assert response.status_code == 200
    assert response.cache_control.no_store
