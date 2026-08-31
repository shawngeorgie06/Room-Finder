"""Guards the contract between app.js and index.html.

Every element app.js looks up with $('some-id') must exist in the template.
Render functions are all null-guarded, so an orphaned reference is silent at
runtime — it just renders nothing. This test makes it loud instead.
"""
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP_JS = os.path.join(ROOT, 'static', 'app.js')
INDEX_HTML = os.path.join(ROOT, 'templates', 'index.html')

# Ids app.js creates at runtime rather than reading from the template.
DYNAMIC_IDS = {'search-opt'}


def referenced_element_ids():
    """Ids app.js passes to $() or setText() as plain string literals."""
    js = open(APP_JS, encoding='utf-8').read()
    # Capture ids from $('id') calls
    dollar_ids = set(re.findall(r"""\$\(\s*['"]([A-Za-z0-9_-]+)['"]\s*\)""", js))
    # Capture ids from setText('id', ...) calls
    settext_ids = set(re.findall(r"""setText\s*\(\s*['"]([A-Za-z0-9_-]+)['"]\s*,""", js))
    ids = dollar_ids | settext_ids
    return {i for i in ids if not any(i.startswith(d) for d in DYNAMIC_IDS)}


def declared_element_ids():
    """Ids declared in the template."""
    html = open(INDEX_HTML, encoding='utf-8').read()
    return set(re.findall(r"""\bid=["']([A-Za-z0-9_-]+)["']""", html))


def test_every_referenced_element_exists_in_template():
    missing = sorted(referenced_element_ids() - declared_element_ids())
    assert not missing, (
        "app.js reads elements that the template does not define: "
        + ", ".join(missing)
        + ". Either restore the element or delete the dead render code."
    )


def test_contract_test_sees_a_realistic_number_of_ids():
    """Guards the regexes themselves — if a refactor changes how elements are
    looked up, this test fails rather than the contract silently passing on an
    empty set."""
    assert len(referenced_element_ids()) > 40
    assert len(declared_element_ids()) > 80


def test_component_helpers_exist_and_use_tokens():
    """The helpers must read colours from CSS custom properties, not hex.

    Hardcoded hex in JS-generated markup is why the palette drifted to 126
    hand-typed values in the first place.
    """
    js = open(APP_JS, encoding='utf-8').read()
    for fn in ('function roomStatus', 'function statusPill', 'function groupLabel'):
        assert fn in js, f"missing helper: {fn}"

    start = js.index('// ── Component helpers')
    end = js.index('// ── End component helpers')
    helpers = js[start:end]
    assert 'var(--free)' in helpers
    assert 'var(--soon)' in helpers
    assert 'var(--busy)' in helpers
    assert not re.search(r'#[0-9a-fA-F]{6}', helpers), \
        "component helpers must use var(--token), not hardcoded hex"


def _restore_state_body():
    js = open(APP_JS, encoding='utf-8').read()
    start = js.index('function restoreStateFromURL')
    return js[start:start + 2500]


def test_all_shareable_view_values_are_still_handled():
    """Shared links are an advertised feature; these four must keep working."""
    body = _restore_state_body()
    for view in ('dashboard', 'rooms', 'map', 'settings'):
        assert f"'{view}'" in body, f"view={view} no longer handled"
    assert "'buildings'" in body, "view=buildings alias missing"


def test_view_alias_variable_is_reassignable():
    """The 'buildings' alias reassigns `view`, so `view` must not be a const.

    This test exists because its predecessor did not catch a real crash. That
    test only asserted the string 'buildings' appeared in the function body —
    and it DID appear, on the very line that threw. `const view = ...` followed
    by `view = 'dashboard'` raises TypeError, which aborts init() and leaves the
    whole app dead on /?view=buildings, while the server still returns HTTP 200.
    A guard rail that passes on broken code is not a guard rail.
    """
    body = _restore_state_body()

    reassigns = re.search(r"^\s*if \(view === 'buildings'\) view = ", body, re.M)
    assert reassigns, "the buildings->dashboard alias reassignment is missing"

    decl = re.search(r"^\s*(const|let|var)\s+view\s*=", body, re.M)
    assert decl, "could not find the declaration of `view` in restoreStateFromURL"
    assert decl.group(1) != 'const', (
        "`view` is declared with const but is reassigned by the 'buildings' "
        "alias — this throws TypeError and kills init(). Use `let`."
    )


def test_saved_rooms_filter_has_markup_state_and_shareable_url_support():
    """Saved is a Rooms scope, so it must survive refreshes and shared links."""
    js = open(APP_JS, encoding='utf-8').read()
    html = open(INDEX_HTML, encoding='utf-8').read()
    assert 'savedOnly: false' in js
    assert "params.set('saved', '1')" in js
    assert "params.get('saved')" in js
    assert 'function setSavedOnly(enabled)' in js  # async- prefix allowed
    # Saved mode must read the every-room cache, not the free-rooms feed:
    # /api/rooms omits occupied rooms, so a saved room would disappear the
    # moment a class started in it.
    assert "searchRoomSource()" in js
    saved_block = js[js.index('const visibleRooms = state.savedOnly'):]
    saved_block = saved_block[:saved_block.index(': rooms;')]
    assert 'searchRoomSource()' in saved_block
    assert 'isPinned(room.building, room.room)' in saved_block
    assert 'id="rooms-all-btn"' in html
    assert 'id="saved-rooms-btn"' in html
    assert 'No saved rooms yet' in js
    assert 'Tap ★ on any room to save it.' in js
