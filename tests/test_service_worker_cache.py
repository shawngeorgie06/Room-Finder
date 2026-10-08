"""Exercise generated cache identities rather than maintaining a second digest.

After the final public asset build, run ``npm run update:cache``. CI and
``npm run check:cache`` verify that no shell, precached asset or worker policy
changed afterward. Node is required; missing tooling must not skip this gate.
"""
from pathlib import Path
import re
import shutil
import subprocess

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'scripts' / 'cache-fingerprint.js'
VERSION = re.compile(r"(const CACHE_VERSION\s*=\s*')([^']+)(')")


def run_fingerprint(root, mode):
    node = shutil.which('node')
    assert node, 'Node is required to verify service-worker fingerprints'
    return subprocess.run(
        [node, str(SCRIPT), mode, '--root', str(root)],
        capture_output=True, text=True, timeout=15,
    )


def checked(root, mode):
    result = run_fingerprint(root, mode)
    assert result.returncode == 0, result.stdout + result.stderr
    return result


def version(root):
    return VERSION.search((root / 'static/sw.js').read_text()).group(2)


@pytest.fixture
def public_app(tmp_path):
    (tmp_path / 'static').mkdir()
    (tmp_path / 'templates').mkdir()
    (tmp_path / 'static/app.js').write_text('console.log("public app");\n')
    (tmp_path / 'static/test.bin').write_bytes(b'\x00\xff\x01\x80')
    (tmp_path / 'templates/index.html').write_text('<html>public shell</html>\n')
    (tmp_path / 'static/sw.js').write_text(
        "const CACHE_VERSION = 'room-finder-v15-obsolete';\n"
        "const PRECACHE = ['/', '/static/app.js', '/static/test.bin'];\n"
        "const HOME_QUERY = new Set(['view']);\n"
        "self.addEventListener('fetch', event => {});\n"
    )
    return tmp_path


def test_repository_cache_fingerprint_is_current():
    checked(ROOT, '--check')


def test_precache_includes_all_entry_scripts_and_room_building_query():
    source = (ROOT / 'static/sw.js').read_text()
    precache = re.search(r'const PRECACHE\s*=\s*\[([\s\S]*?)\];', source).group(1)
    for name in ('app.js', 'reliability.js', 'map.js'):
        assert f"'/static/{name}'" in precache
    home_query = re.search(r'const HOME_QUERY\s*=\s*new Set\(\[([\s\S]*?)\]\)', source).group(1)
    assert "'roomBuilding'" in home_query


def test_room_building_is_allowed_only_as_a_safe_home_query():
    node = shutil.which('node')
    assert node, 'Node is required to exercise the service-worker query contract'
    script = r"""
      const assert = require('node:assert/strict');
      const fs = require('node:fs');
      const vm = require('node:vm');
      const origin = 'https://room-finder.invalid';
      const context = vm.createContext({URL, self: {location: {origin}, addEventListener() {}}});
      vm.runInContext(fs.readFileSync(process.argv[1], 'utf8'), context);
      function classify(path, mode = 'navigate') {
        context.request = {url: origin + path, method: 'GET', cache: 'default', headers: new Headers(), mode};
        return vm.runInContext('requestKind(request)', context);
      }
      assert.equal(classify('/?view=rooms&roomBuilding=CKB&room=G-08'), 'home');
      assert.equal(classify('/?roomBuilding=CKB&token=private'), null);
      assert.equal(classify('/api/rooms?roomBuilding=CKB', 'cors'), null);
    """
    result = subprocess.run([node, '-e', script, str(ROOT / 'static/sw.js')], capture_output=True, text=True, timeout=15)
    assert result.returncode == 0, result.stderr


def test_update_is_deterministic_and_changes_only_version(public_app):
    worker = public_app / 'static/sw.js'
    original = worker.read_text()
    checked(public_app, '--update')
    generated = worker.read_text()
    assert re.fullmatch(r'room-finder-v15-[0-9a-f]{64}', version(public_app))
    assert VERSION.sub(r'\1EXCLUDED\3', generated) == VERSION.sub(r'\1EXCLUDED\3', original)
    timestamp = worker.stat().st_mtime_ns
    checked(public_app, '--check')
    checked(public_app, '--update')
    assert worker.read_text() == generated
    assert worker.stat().st_mtime_ns == timestamp


@pytest.mark.parametrize('changed', ['static/app.js', 'static/test.bin', 'templates/index.html', 'static/sw.js'])
def test_changed_asset_shell_or_policy_fails_until_regenerated(public_app, changed):
    checked(public_app, '--update')
    previous_version = version(public_app)
    file = public_app / changed
    if changed == 'static/sw.js':
        file.write_text(file.read_text().replace('event => {}', 'event => event.respondWith(fetch(event.request))'))
    else:
        file.write_bytes(file.read_bytes() + b'changed')
    before_check = (public_app / 'static/sw.js').read_bytes()
    result = run_fingerprint(public_app, '--check')
    assert result.returncode != 0
    assert 'stale' in result.stderr.lower()
    assert 'npm run update:cache' in result.stderr
    assert (public_app / 'static/sw.js').read_bytes() == before_check
    checked(public_app, '--update')
    assert version(public_app) != previous_version
    checked(public_app, '--check')


def test_existing_version_is_excluded_from_digest(public_app):
    checked(public_app, '--update')
    expected = version(public_app)
    worker = public_app / 'static/sw.js'
    worker.write_text(VERSION.sub(r"\1room-finder-v99-wrong\3", worker.read_text()))
    assert run_fingerprint(public_app, '--check').returncode != 0
    checked(public_app, '--update')
    assert version(public_app) == expected
    checked(public_app, '--check')


def test_fingerprint_is_independent_of_checkout_directory(public_app, tmp_path_factory):
    checked(public_app, '--update')
    relocated = tmp_path_factory.mktemp('relocated-fingerprint')
    shutil.copytree(public_app, relocated, dirs_exist_ok=True)
    checked(relocated, '--check')
    assert version(relocated) == version(public_app)


def test_precaching_worker_itself_does_not_introduce_self_reference(public_app):
    worker = public_app / 'static/sw.js'
    worker.write_text(worker.read_text().replace("'/static/test.bin'", "'/static/test.bin', '/static/sw.js'"))
    checked(public_app, '--update')
    previous = worker.read_bytes()
    checked(public_app, '--check')
    checked(public_app, '--update')
    assert worker.read_bytes() == previous


def test_only_explicit_assets_are_fingerprinted(public_app):
    checked(public_app, '--update')
    (public_app / 'static/unlisted.txt').write_text('not in the public cache')
    checked(public_app, '--check')


@pytest.mark.parametrize('missing', ['static/app.js', 'templates/index.html'])
@pytest.mark.parametrize('mode', ['--check', '--update'])
def test_missing_inputs_fail_without_changing_worker(public_app, missing, mode):
    worker = public_app / 'static/sw.js'
    original = worker.read_bytes()
    (public_app / missing).unlink()
    result = run_fingerprint(public_app, mode)
    assert result.returncode != 0
    assert missing in result.stderr
    assert 'missing' in result.stderr.lower()
    assert worker.read_bytes() == original


@pytest.mark.parametrize('entry', [
    'https://example.invalid/asset.js', '/api/export-schedule',
    '/static/../outside.txt', '/static/app.js?token=invalid',
    '/static//app.js',
])
def test_noncanonical_or_nonpublic_precache_entries_are_rejected(public_app, entry):
    worker = public_app / 'static/sw.js'
    worker.write_text(worker.read_text().replace('/static/app.js', entry))
    original = worker.read_bytes()
    result = run_fingerprint(public_app, '--update')
    assert result.returncode != 0
    assert 'precache' in result.stderr.lower()
    assert worker.read_bytes() == original


def test_missing_or_duplicate_precache_declarations_are_rejected(public_app):
    worker = public_app / 'static/sw.js'
    original = worker.read_text()
    worker.write_text(original.replace('const PRECACHE', 'const OTHER'))
    result = run_fingerprint(public_app, '--update')
    assert result.returncode != 0 and 'PRECACHE' in result.stderr
    worker.write_text(original + "const PRECACHE = ['/'];\n")
    result = run_fingerprint(public_app, '--update')
    assert result.returncode != 0 and 'PRECACHE' in result.stderr
