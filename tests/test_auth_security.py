"""Protected-route regressions. All files and credentials are disposable."""
import base64
import http.client
import io
import json
from pathlib import Path
import re
import shutil
import subprocess
import threading
from unittest.mock import patch
from wsgiref.simple_server import WSGIRequestHandler, make_server

import pytest
from flask import Request

import app as app_module
from app import BANNER_ORIGIN, create_app

UPLOAD = '/api/upload-schedule'
EXPORT = '/api/export-schedule?term=202650'
REPORT = '/admin/visits'
PASSWORD = 'test-upload-only'
CSV = (b'Term,Course,Days,Times,Location,Max,Delivery Mode\n'
       b'202650,CS 113,MW,1:00 PM - 2:20 PM,KUPF 207,40,Face-to-Face\n')


def bearer(password=PASSWORD):
    return {'Authorization': f'Bearer {password}'}


def basic(password):
    token = base64.b64encode(f'admin:{password}'.encode()).decode()
    return {'Authorization': f'Basic {token}'}


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(app_module, 'UPLOAD_FOLDER', str(tmp_path))
    monkeypatch.setenv('UPLOAD_PASSWORD', PASSWORD)
    monkeypatch.setenv('ADMIN_PASSWORD', 'test-report-only')
    monkeypatch.delenv('RENDER_EXTERNAL_URL', raising=False)
    monkeypatch.delenv('TRUSTED_PROXY_HOPS', raising=False)
    (tmp_path / 'uploaded_schedule_202650.csv').write_bytes(CSV)
    app = create_app(schedule=[], visit_db_path=str(tmp_path / 'visits.sqlite3'))
    app.config['TESTING'] = True
    return app.test_client()


def test_unconfigured_upload_cannot_replace_schedule(client, monkeypatch, tmp_path):
    monkeypatch.delenv('UPLOAD_PASSWORD')
    original = (tmp_path / 'uploaded_schedule_202650.csv').read_bytes()
    response = client.post(UPLOAD, data={
        'file': (io.BytesIO(CSV.replace(b'KUPF 207', b'TEST 999')), 'Course_Schedule_202650.csv'),
    })
    assert response.status_code == 503
    assert (tmp_path / 'uploaded_schedule_202650.csv').read_bytes() == original
    assert client.get('/api/rooms/all').json == []


@pytest.mark.parametrize('path,method', [(UPLOAD, 'post'), (EXPORT, 'get')])
@pytest.mark.parametrize('secret', [None, '', '  '])
def test_schedule_routes_fail_closed(client, monkeypatch, tmp_path, path, method, secret):
    if secret is None:
        monkeypatch.delenv('UPLOAD_PASSWORD')
    else:
        monkeypatch.setenv('UPLOAD_PASSWORD', secret)
    before = {p.name: p.read_bytes() for p in tmp_path.iterdir()}
    with patch.object(app_module, 'load_schedule') as load:
        response = getattr(client, method)(path, headers=bearer())
    assert response.status_code == 503
    assert response.json['error']
    assert response.headers['Cache-Control'] == 'no-store'
    load.assert_not_called()
    assert before == {p.name: p.read_bytes() for p in tmp_path.iterdir()}


@pytest.mark.parametrize('path,method', [(UPLOAD, 'post'), (EXPORT, 'get')])
@pytest.mark.parametrize('headers', [{}, bearer('wrong'), bearer('test-report-only'), basic(PASSWORD)])
def test_denial_precedes_schedule_io(client, tmp_path, path, method, headers):
    before = {p.name: p.read_bytes() for p in tmp_path.iterdir()}
    with patch.object(app_module, 'load_schedule') as load:
        kwargs = {'data': {'file': (io.BytesIO(CSV), 'schedule.csv')}} if method == 'post' else {}
        response = getattr(client, method)(path, headers=headers, **kwargs)
    assert response.status_code == 401
    assert response.json['error']
    assert response.headers['Cache-Control'] == 'no-store'
    load.assert_not_called()
    assert client.get('/api/rooms/all').json == []  # injected schedule stays untouched
    assert before == {p.name: p.read_bytes() for p in tmp_path.iterdir()}


def test_export_rejects_query_credentials(client):
    response = client.get(EXPORT + '&password=' + PASSWORD)
    assert response.status_code == 401
    assert client.get(EXPORT + '&password=' + PASSWORD, headers=bearer()).status_code == 401
    assert client.get(EXPORT, headers=bearer()).status_code == 200


@pytest.mark.parametrize('as_header', [False, True])
def test_authorized_upload_and_export(client, as_header):
    data = {'file': (io.BytesIO(CSV), 'Course_Schedule_202650.csv')}
    if not as_header:
        data['password'] = PASSWORD
    response = client.post(UPLOAD, data=data, headers=bearer() if as_header else {})
    assert response.status_code == 200
    assert response.headers['Cache-Control'] == 'no-store'
    assert response.json['entries'] == 1
    exported = client.get(EXPORT, headers=bearer())
    assert exported.status_code == 200
    assert exported.data == CSV
    assert exported.headers['Cache-Control'] == 'no-store'


def test_header_denial_does_not_parse_multipart(client):
    with patch.object(Request, '_load_form_data', side_effect=AssertionError('body parsed')):
        assert client.post(UPLOAD, headers=bearer('wrong'), data=b'not multipart').status_code == 401


def test_unconfigured_upload_does_not_parse_multipart(client, monkeypatch):
    monkeypatch.delenv('UPLOAD_PASSWORD')
    with patch.object(Request, '_load_form_data', side_effect=AssertionError('body parsed')):
        assert client.post(UPLOAD, data=b'not multipart').status_code == 503


def test_invalid_header_cannot_fall_back_to_valid_form_password(client):
    assert client.post(UPLOAD, headers=bearer('wrong'), data={'password': PASSWORD}).status_code == 401


@pytest.mark.parametrize('path,method,target', [
    (UPLOAD, 'post', 'load_schedule'), (EXPORT, 'get', '_stored_term_files'),
    (REPORT, 'get', 'get_visits'),
])
def test_protected_server_errors_are_not_cacheable(client, path, method, target):
    client.application.config['TESTING'] = False
    headers = basic('test-report-only') if path == REPORT else bearer()
    kwargs = {'data': {'file': (io.BytesIO(CSV), 'schedule.csv')}} if method == 'post' else {}
    with patch.object(app_module, target, side_effect=RuntimeError('test failure')):
        response = getattr(client, method)(path, headers=headers, **kwargs)
    # The upload parser already translates parser exceptions to 422.
    assert response.status_code == (422 if path == UPLOAD else 500)
    assert response.headers['Cache-Control'] == 'no-store'
    if path == UPLOAD:
        assert response.headers['Access-Control-Allow-Origin'] == BANNER_ORIGIN


def test_credentials_use_constant_time_compare_and_admin_supports_unicode(client, monkeypatch):
    with patch.object(app_module.hmac, 'compare_digest', wraps=app_module.hmac.compare_digest) as compare:
        assert client.get(EXPORT, headers=bearer()).status_code == 200
        assert client.get(EXPORT, headers=bearer('wrong-é')).status_code == 401
    assert compare.call_count == 2
    monkeypatch.setenv('ADMIN_PASSWORD', 'admin-é')
    assert client.get(REPORT, headers=basic('admin-é')).status_code == 200


@pytest.mark.parametrize('secret', ['test-é', 'test-🔑', 'test\x7fsecret', 'test\tsecret'])
@pytest.mark.parametrize('path,method', [(UPLOAD, 'post'), (EXPORT, 'get')])
def test_unsupported_upload_secret_disables_routes_before_parsing(client, monkeypatch, secret, path, method):
    monkeypatch.setenv('UPLOAD_PASSWORD', secret)
    with patch.object(Request, '_load_form_data', side_effect=AssertionError('body parsed')):
        response = getattr(client, method)(path)
    assert response.status_code == 503
    assert 'printable ASCII' in response.json['error']
    assert 'UPLOAD_PASSWORD' in response.json['error']
    assert secret not in response.json['error']
    assert response.headers['Cache-Control'] == 'no-store'
    if path == UPLOAD:
        assert response.headers['Access-Control-Allow-Origin'] == BANNER_ORIGIN


@pytest.mark.parametrize('as_header', [False, True])
@pytest.mark.parametrize('secret', ['internal=equals=secret', 'test with space', 'test!#$%&()*+,-./:;<=>?@[\\]^_`{|}~'])
def test_upload_credentials_preserve_printable_ascii_and_trim_whitespace(client, monkeypatch, as_header, secret):
    monkeypatch.setenv('UPLOAD_PASSWORD', '  ' + secret + '  ')
    data = {'file': (io.BytesIO(CSV), 'Course_Schedule_202650.csv')}
    headers = {'Authorization': 'bEaReR   ' + secret + '  '} if as_header else {}
    if not as_header:
        data['password'] = ' \t' + secret + '\r\n '
    assert client.post(UPLOAD, data=data, headers=headers).status_code == 200
    assert client.get(EXPORT, headers={'Authorization': 'Bearer   ' + secret + '  '}).status_code == 200


@pytest.mark.parametrize('wire_header', [b'Bearer test-\xe9', b'Bearer test-\xc3\xa9'])
def test_wsgi_authorization_latin1_and_utf8_cannot_enable_unicode_upload_secret(client, monkeypatch, wire_header):
    # WSGI servers expose header bytes through Latin-1; a Flask Unicode header
    # alone does not reproduce the UTF-8-on-the-wire representation.
    environment = {'HTTP_AUTHORIZATION': wire_header.decode('latin-1')}
    monkeypatch.setenv('UPLOAD_PASSWORD', 'test-é')
    assert client.get(EXPORT, environ_overrides=environment).status_code == 503
    monkeypatch.setenv('UPLOAD_PASSWORD', PASSWORD)
    assert client.get(EXPORT, environ_overrides=environment).status_code == 401


def test_real_http_bearer_transport_and_unicode_admin(client, monkeypatch):
    class QuietHandler(WSGIRequestHandler):
        def log_message(self, *args):
            pass

    server = make_server('127.0.0.1', 0, client.application, handler_class=QuietHandler)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()

    def get(path, authorization):
        connection = http.client.HTTPConnection('127.0.0.1', server.server_port, timeout=5)
        try:
            connection.request('GET', path, headers={'Authorization': authorization})
            response = connection.getresponse()
            body = response.read()
            assert response.getheader('Cache-Control') == 'no-store'
            return response.status, body
        finally:
            connection.close()

    try:
        monkeypatch.setenv('UPLOAD_PASSWORD', '  test=internal=equals  ')
        status, body = get(EXPORT, b'Bearer   test=internal=equals  ')
        assert status == 200 and body == CSV
        for wire_header in (b'Bearer test-\xe9', b'Bearer test-\xc3\xa9'):
            monkeypatch.setenv('UPLOAD_PASSWORD', 'test-é')
            status, body = get(EXPORT, wire_header)
            assert status == 503 and b'printable ASCII' in body
            monkeypatch.setenv('UPLOAD_PASSWORD', PASSWORD)
            assert get(EXPORT, wire_header)[0] == 401
        monkeypatch.setenv('ADMIN_PASSWORD', 'admin-é')
        assert get(REPORT, basic('admin-é')['Authorization'])[0] == 200
    finally:
        server.shutdown()
        worker.join(timeout=5)
        server.server_close()


def test_installer_warns_about_old_bookmarks_and_deployment_secret_strength():
    html = (Path(__file__).parents[1] / 'bookmarklet' / 'install.html').read_text()
    assert 'Replace ALL old bookmarks' in html
    assert 'before entering a rotated secret' in html
    assert 'old bookmarks can re-save the rotated secret' in html
    assert 'at least 32 random printable-ASCII characters' in html
    assert 'not brute-force prevention' in html


@pytest.mark.parametrize('status', [401, 413, 422, 503])
def test_upload_errors_are_readable_to_banner(client, monkeypatch, status):
    headers = {'Origin': BANNER_ORIGIN, **bearer()}
    data = {'file': (io.BytesIO(b'not a schedule'), 'invalid.csv')}
    if status == 401:
        headers.update(bearer('wrong'))
    elif status == 413:
        client.application.config['MAX_CONTENT_LENGTH'] = 20
    elif status == 503:
        monkeypatch.delenv('UPLOAD_PASSWORD')
    response = client.post(UPLOAD, data=data, headers=headers)
    assert response.status_code == status
    assert response.json['error']
    assert response.headers['Access-Control-Allow-Origin'] == BANNER_ORIGIN
    assert response.headers['Cache-Control'] == 'no-store'


def test_options_are_public_and_cors_is_banner_only(client, monkeypatch):
    monkeypatch.delenv('UPLOAD_PASSWORD')
    response = client.options(UPLOAD, headers={
        'Origin': BANNER_ORIGIN, 'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'Authorization',
    })
    assert response.status_code == 204
    assert 'Authorization' in response.headers['Access-Control-Allow-Headers']
    other = client.post(UPLOAD, headers={'Origin': 'https://untrusted.example'})
    assert other.headers.get('Access-Control-Allow-Origin') in (None, BANNER_ORIGIN)
    assert 'Access-Control-Allow-Origin' not in client.get(EXPORT).headers
    assert client.options('/api/export-schedule').status_code == 200
    assert client.options(REPORT).status_code == 200


@pytest.mark.parametrize('path', [UPLOAD, '/api/export-schedule', REPORT])
def test_protected_method_errors_are_not_cacheable(client, path):
    response = client.delete(path)
    assert response.status_code == 405
    assert response.headers['Cache-Control'] == 'no-store'


@pytest.mark.parametrize('secret,headers,status', [
    ('', {}, 503), ('test-report-only', {}, 401),
    ('test-report-only', basic(PASSWORD), 401),
    ('test-report-only', basic('test-report-only'), 200),
])
def test_report_auth_is_separate_and_all_responses_are_private(client, monkeypatch, secret, headers, status):
    monkeypatch.setenv('ADMIN_PASSWORD', secret)
    response = client.get(REPORT, headers=headers)
    assert response.status_code == status
    assert response.headers['Cache-Control'] == 'no-store'
    assert response.headers['X-Robots-Tag'] == 'noindex, nofollow'


def test_throttle_is_shared_bounded_and_ignores_forwarded_ip(client, monkeypatch):
    clock = [100.0]
    monkeypatch.setattr(app_module.time, 'monotonic', lambda: clock[0])
    for i in range(20):
        path = [UPLOAD, EXPORT, REPORT][i % 3]
        method = client.post if path == UPLOAD else client.get
        response = method(path, headers={**bearer('wrong'), 'X-Forwarded-For': f'203.0.113.{i}'})
        assert response.status_code == 401
    response = client.get(EXPORT, headers=bearer('wrong'))
    assert response.status_code == 429
    assert response.json['error']
    assert 1 <= int(response.headers['Retry-After']) <= 60
    assert response.headers['Cache-Control'] == 'no-store'
    limited_upload = client.post(UPLOAD, headers={'Origin': BANNER_ORIGIN, **bearer('wrong')})
    assert limited_upload.status_code == 429
    assert limited_upload.headers['Access-Control-Allow-Origin'] == BANNER_ORIGIN
    assert client.options(UPLOAD).status_code == 204
    assert client.get('/ping').status_code == 200
    assert client.get(EXPORT, headers=bearer('wrong'), environ_overrides={'REMOTE_ADDR': '192.0.2.1'}).status_code == 401
    assert client.get(EXPORT, headers=bearer()).status_code == 200
    assert client.get(REPORT, headers=basic('test-report-only')).status_code == 200
    clock[0] += 61
    assert client.get(EXPORT, headers=bearer('wrong')).status_code == 401


def test_throttle_global_cap_bounds_memory_and_requests(client, monkeypatch):
    monkeypatch.setattr(app_module.time, 'monotonic', lambda: 100.0)
    for i in range(200):
        assert client.get(EXPORT, headers=bearer('wrong'), environ_overrides={'REMOTE_ADDR': f'peer-{i}'}).status_code == 401
    # Rotating addresses cannot grow the table without bound or bypass the failure budget.
    assert client.get(EXPORT, headers=bearer('wrong'), environ_overrides={'REMOTE_ADDR': 'new-peer'}).status_code == 429
    limiter = client.application.extensions['protected_rate_limiter']
    assert len(limiter.buckets) <= 200
    assert client.get(EXPORT).status_code == 401
    assert client.get(EXPORT, headers=bearer()).status_code == 200


@pytest.mark.parametrize('path,method', [(UPLOAD, 'post'), (EXPORT, 'get'), (REPORT, 'get')])
def test_anonymous_probes_do_not_lock_out_valid_credentials(client, path, method):
    for _ in range(30):
        assert getattr(client, method)(path).status_code == 401
    assert client.application.extensions['protected_rate_limiter'].buckets == {}
    assert client.get(EXPORT, headers=bearer()).status_code == 200


def test_throttle_counts_incorrect_multipart_passwords_but_valid_upload_recovers(client):
    for _ in range(20):
        assert client.post(UPLOAD, data={'password': 'wrong'}).status_code == 401
    assert client.post(UPLOAD, data={'password': 'wrong'}).status_code == 429
    response = client.post(UPLOAD, data={
        'password': PASSWORD,
        'file': (io.BytesIO(CSV), 'Course_Schedule_202650.csv'),
    })
    assert response.status_code == 200


def test_only_visitor_report_advertises_basic_authentication(client):
    assert client.post(UPLOAD).headers['WWW-Authenticate'] == 'Bearer'
    assert client.get(EXPORT).headers['WWW-Authenticate'] == 'Bearer'
    assert client.get(REPORT).headers['WWW-Authenticate'].startswith('Basic ')


@pytest.mark.parametrize('path', ['/', '/api/rooms', '/api/rooms/all', '/api/buildings', '/api/schedule-info'])
def test_public_responses_remain_cacheable_without_vary_cookie(client, path):
    response = client.get(path)
    assert response.status_code == 200
    assert 'no-store' not in response.headers.get('Cache-Control', '')
    assert 'private' not in response.headers.get('Cache-Control', '')
    assert 'cookie' not in response.headers.get('Vary', '').lower()


def test_trusted_proxy_hops_is_opt_in_and_uses_rightmost_trusted_hop(client, monkeypatch, tmp_path):
    monkeypatch.setenv('TRUSTED_PROXY_HOPS', '1')
    proxied = create_app(schedule=[], visit_db_path=str(tmp_path / 'proxy-visits.sqlite3')).test_client()
    assert proxied.application.config['TRUSTED_PROXY_HOPS'] == 1
    for i in range(20):
        response = proxied.get(EXPORT, headers={**bearer('wrong'), 'X-Forwarded-For': f'203.0.113.{i}, 192.0.2.10'})
        assert response.status_code == 401
    assert proxied.get(EXPORT, headers={**bearer('wrong'), 'X-Forwarded-For': '203.0.113.50, 192.0.2.10'}).status_code == 429
    assert proxied.get(EXPORT, headers={**bearer('wrong'), 'X-Forwarded-For': '192.0.2.11'}).status_code == 401
    assert set(proxied.application.extensions['protected_rate_limiter'].buckets) == {'192.0.2.10', '192.0.2.11'}


@pytest.mark.parametrize('hops', ['-1', 'invalid'])
def test_invalid_proxy_hops_configuration_is_rejected(monkeypatch, hops):
    monkeypatch.setenv('TRUSTED_PROXY_HOPS', hops)
    with pytest.raises(ValueError, match='TRUSTED_PROXY_HOPS'):
        create_app(schedule=[])


def _bookmarklet_script():
    html = (Path(__file__).parents[1] / 'bookmarklet' / 'install.html').read_text()
    return re.search(r'<script>(.*?)</script>', html, re.S).group(1)


@pytest.mark.parametrize('mode', ['success', 'cancel', 'denied', 'disabled', 'network', 'timeout', 'storage-blocked'])
def test_bookmarklet_prompts_transiently_cleans_legacy_secret_and_downloads_on_failure(mode):
    node = shutil.which('node')
    assert node, 'Node is required to exercise the bookmarklet credential flow'
    # Execute the actual generated upload section, with only Banner extraction replaced by fixtures.
    script = r'''
const vm = require('vm');
const assert = require('assert');
(async () => {
  const link = {};
  vm.runInNewContext(SOURCE, {location:{origin:'https://rooms.example'}, document:{getElementById:()=>link}});
  const full = decodeURIComponent(link.href.slice('javascript:'.length));
  let removed = 0, prompted = 0, uploads = 0, downloads = 0;
  const messages = [];
  const section = full.slice(full.indexOf('/* ── 7. Upload'), full.lastIndexOf('})();'));
  const context = {
    csv:'fake csv', fname:'fake.csv', summary:'one section', Blob, FormData, AbortController,
    setTimeout(callback, delay){ assert.equal(delay,30000); if(MODE==='timeout') queueMicrotask(callback); return 1; },
    clearTimeout(timer){ assert.equal(timer,1); },
    localStorage: {
      removeItem(key){ assert.equal(key,'njitRoomFinderUploadPw'); removed++; if(MODE==='storage-blocked') throw Error('blocked'); },
      getItem(){ throw Error('must not read saved credentials'); },
      setItem(){ throw Error('must not persist credentials'); }
    },
    prompt(){ prompted++; return MODE==='cancel' ? null : 'transient-test-secret'; },
    alert(message){ messages.push(message); },
    console:{log(){throw Error('must not print credentials');}},
    document:{createElement(){return {click(){downloads++;}};},body:{appendChild(){},removeChild(){}}},
    URL:{createObjectURL(){return 'blob:fake';},revokeObjectURL(){}},
    async fetch(url, options){
      uploads++;
      assert.equal(url,'https://rooms.example/api/upload-schedule');
      assert.equal(options.body.get('password'),'transient-test-secret');
      if(MODE==='network') throw Error('network failed');
      if(MODE==='timeout') await new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Error('timed out')),{once:true}));
      const status = MODE==='denied'?401:MODE==='disabled'?503:200;
      return {status,ok:status===200,json:async()=>status===200?{entries:1}:{error:'Upload unavailable'}};
    }
  };
  await vm.runInNewContext('(async function(){'+section+'})()',context);
  assert.equal(removed,1);
  assert.equal(prompted,1);
  assert.equal(uploads,MODE==='cancel'?0:1);
  assert.equal(downloads,['success','storage-blocked'].includes(MODE)?0:1);
  assert(!messages.join(' ').includes('transient-test-secret'));
})().catch(error => {console.error(error);process.exit(1);});
'''
    script = 'const SOURCE=' + json.dumps(_bookmarklet_script()) + '; const MODE=' + json.dumps(mode) + ';\n' + script
    result = subprocess.run([node, '-e', script], capture_output=True, text=True, timeout=10)
    assert result.returncode == 0, result.stderr
