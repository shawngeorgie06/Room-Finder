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
