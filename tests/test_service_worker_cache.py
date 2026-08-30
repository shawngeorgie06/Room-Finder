"""Guards the service worker's cache-busting contract.

The SW is network-first for navigations but CACHE-FIRST for static assets,
keyed on CACHE_VERSION. So shipping a change to app.js or tailwind.css without
bumping CACHE_VERSION gives every returning user NEW html driven by OLD
JavaScript and OLD css — worse than shipping nothing.

This is exactly what happened during the redesign: 27 commits changed app.js,
tailwind.css and index.html while CACHE_VERSION sat at v5 the whole time. No
test caught it because no task touched sw.js.

When this test fails, do BOTH:
  1. bump CACHE_VERSION in static/sw.js
  2. update EXPECTED_DIGEST below to the digest printed in the failure
"""
import hashlib
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SW = os.path.join(ROOT, 'static', 'sw.js')

# Update together, never separately.
EXPECTED_VERSION = 'room-finder-v6'
EXPECTED_DIGEST = '5131a52a48a66cdc'


def _sw_source():
    return open(SW, encoding='utf-8').read()


def cache_version():
    m = re.search(r"CACHE_VERSION\s*=\s*'([^']+)'", _sw_source())
    assert m, 'could not find CACHE_VERSION in sw.js'
    return m.group(1)


def precached_asset_digest():
    """Digest of every same-origin static asset the SW precaches."""
    paths = re.findall(r"'(/static/[^']+)'", _sw_source())
    h = hashlib.sha256()
    for rel in sorted(paths):
        abs_path = os.path.join(ROOT, rel.lstrip('/'))
        if os.path.exists(abs_path):
            h.update(rel.encode())
            h.update(open(abs_path, 'rb').read())
    return h.hexdigest()[:16]


def test_precache_list_points_at_real_files():
    """A precache entry that 404s is silently swallowed by the install handler,
    so a typo would never surface at runtime."""
    missing = [p for p in re.findall(r"'(/static/[^']+)'", _sw_source())
               if not os.path.exists(os.path.join(ROOT, p.lstrip('/')))]
    assert not missing, f'sw.js precaches files that do not exist: {missing}'


def test_cache_version_bumped_when_precached_assets_change():
    digest = precached_asset_digest()
    version = cache_version()
    assert (version, digest) == (EXPECTED_VERSION, EXPECTED_DIGEST), (
        "Precached static assets changed without a CACHE_VERSION bump.\n"
        f"  CACHE_VERSION is {version!r}, test expects {EXPECTED_VERSION!r}\n"
        f"  asset digest is {digest!r}, test expects {EXPECTED_DIGEST!r}\n"
        "Returning users are served cached static assets until CACHE_VERSION "
        "changes, so they would get new HTML with stale JS/CSS.\n"
        "Fix: bump CACHE_VERSION in static/sw.js, then set\n"
        f"  EXPECTED_VERSION = '<new version>'\n"
        f"  EXPECTED_DIGEST = '{digest}'\n"
        "in this test."
    )
