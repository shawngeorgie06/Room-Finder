"""Characterisation tests for the room status/colour logic, executed in node.

Four separate implementations of "is this room free, closing soon, or in use"
grew up in app.js: roomStatus() (token-based), roomStatusMeta() (hex-based),
and three inline `isSoon` blocks in the render functions. They agree today by
coincidence of copy-paste, not by construction.

These tests pin down what each one returns BEFORE consolidating them, so the
refactor has to prove it changed nothing. They deliberately assert literal
expected values rather than comparing the implementations to each other — two
implementations that drift together would still pass a comparison test.

The two known-and-intended differences are captured explicitly: roomStatus()
says "In use" where roomStatusMeta() says "IN USE", and roomStatus() returns
CSS custom properties where roomStatusMeta() returns raw hex. Call sites
depend on both forms, so consolidation must preserve them.
"""
import json
import os
import re
import shutil
import subprocess

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP_JS = os.path.join(ROOT, 'static', 'app.js')

pytestmark = pytest.mark.skipif(shutil.which('node') is None,
                                reason='node is required to exercise the JS')

# The inputs that matter: busy regardless of minutes, the exact soon/free
# boundary on both sides, zero, null and undefined minutes, and hour-crossing
# values that exercise formatTime's branches.
CASES = [
    {'empty': False, 'minutes_until_next': 10},
    {'empty': False, 'minutes_until_next': None},
    {'empty': True, 'minutes_until_next': None},
    {'empty': True, 'minutes_until_next': 0},
    {'empty': True, 'minutes_until_next': 29},
    {'empty': True, 'minutes_until_next': 30},
    {'empty': True, 'minutes_until_next': 31},
    {'empty': True, 'minutes_until_next': 60},
    {'empty': True, 'minutes_until_next': 95},
    {'minutes_until_next': 5},
]


def _extract(fn_name):
    """Pull one top-level function's source out of app.js by brace matching."""
    src = open(APP_JS, encoding='utf-8').read()
    start = src.index(f'function {fn_name}(')
    depth = 0
    for j in range(src.index('{', start), len(src)):
        if src[j] == '{':
            depth += 1
        elif src[j] == '}':
            depth -= 1
            if depth == 0:
                return src[start:j + 1]
    raise AssertionError(f'unbalanced braces extracting {fn_name}')


def _extract_const(name):
    """Pull a top-level `const NAME = ...;` out of app.js."""
    src = open(APP_JS, encoding='utf-8').read()
    m = re.search(rf'^const {re.escape(name)}\s*=.*?;', src, re.M | re.S)
    assert m, f'could not find const {name}'
    return m.group(0)


def _preamble():
    """Every piece of app.js the status logic depends on, in dependency order."""
    return '\n'.join([
        _extract_const('STATUS_HEX'),
        _extract_const('STATUS_BORDER'),
        _extract('isClosingSoon'),
        _extract('formatTime'),
        _extract('roomStatus'),
        _extract('roomStatusMeta'),
        _extract('roomCardStatus'),
    ])


def _run(expr, threshold=30):
    """Evaluate `expr` against every case with state.soonThresholdMins set."""
    script = '\n'.join([
        _preamble(),
        f'const state = {{ soonThresholdMins: {threshold} }};',
        f'const cases = {json.dumps(CASES)};',
        f'console.log(JSON.stringify(cases.map(room => ({expr}))));',
    ])
    out = subprocess.run(['node', '-e', script], capture_output=True, text=True,
                         timeout=20)
    assert out.returncode == 0, out.stderr
    return json.loads(out.stdout)


def test_room_status_kinds():
    assert _run('roomStatus(room).kind') == [
        'busy', 'busy', 'free', 'soon', 'soon', 'soon', 'free', 'free', 'free',
        'soon',
    ]


def test_room_status_text():
    assert _run('roomStatus(room).text') == [
        'In use', 'In use', 'FREE ALL DAY', '~0M', '~29M', '~30M', '~31M',
        '1H', '1H 35M', '~5M',
    ]


def test_room_status_css_vars():
    assert _run('roomStatus(room).cssVar') == [
        'var(--busy)', 'var(--busy)', 'var(--free)', 'var(--soon)',
        'var(--soon)', 'var(--soon)', 'var(--free)', 'var(--free)',
        'var(--free)', 'var(--soon)',
    ]


def test_room_status_meta_text_is_uppercase_for_busy():
    """roomStatusMeta says IN USE where roomStatus says In use.

    This is not a bug to fix during consolidation — the search-result call
    site renders uppercase. Consolidation must keep this difference.
    """
    assert _run('roomStatusMeta(room).text') == [
        'IN USE', 'IN USE', 'FREE ALL DAY', '~0M', '~29M', '~30M', '~31M',
        '1H', '1H 35M', '~5M',
    ]


def test_room_status_meta_colors_are_raw_hex():
    """Call sites build inline style strings, which cannot use var() reliably
    inside every context, so this form returns literal hex."""
    assert _run('roomStatusMeta(room).color') == [
        '#ff7166', '#ff7166', '#3fff8b', '#f59e0b', '#f59e0b', '#f59e0b',
        '#3fff8b', '#3fff8b', '#3fff8b', '#f59e0b',
    ]


def test_threshold_is_honoured_by_both_implementations():
    """The soon window is user-configurable, so the boundary must move with it.

    At a 60-minute threshold the 31- and 60-minute rooms become 'soon' while
    the 95-minute room stays free. A consolidation that hardcoded 30 would
    pass every other test in this file and fail here.
    """
    assert _run('roomStatus(room).kind', threshold=60) == [
        'busy', 'busy', 'free', 'soon', 'soon', 'soon', 'soon', 'soon', 'free',
        'soon',
    ]
    assert _run('roomStatusMeta(room).color', threshold=60) == [
        '#ff7166', '#ff7166', '#3fff8b', '#f59e0b', '#f59e0b', '#f59e0b',
        '#f59e0b', '#f59e0b', '#3fff8b', '#f59e0b',
    ]


def test_undefined_minutes_is_treated_as_free_all_day_not_soon():
    """`undefined <= 30` is false, so undefined already lands on free.

    roomStatus() guards undefined explicitly; roomStatusMeta() only guards
    null and relies on the comparison. Both reach 'free', and a consolidation
    that swapped the guard for a truthiness check would break the 0-minute
    case above instead. Pinned here so the equivalence is deliberate.
    """
    script = '\n'.join([
        _preamble(),
        'const state = { soonThresholdMins: 30 };',
        'const r = { empty: true };',
        'console.log(JSON.stringify('
        '[roomStatus(r).kind, roomStatusMeta(r).color, roomStatus(r).text]));',
    ])
    out = subprocess.run(['node', '-e', script], capture_output=True, text=True,
                         timeout=20)
    assert out.returncode == 0, out.stderr
    assert json.loads(out.stdout) == ['free', '#3fff8b', 'FREE ALL DAY']


def test_the_soon_comparison_is_written_exactly_once():
    """The duplication this file was written to remove must not grow back.

    Four call sites each carried their own copy of the threshold comparison.
    Any new copy is a place the logic can drift, and none of the tests above
    would notice, because they only exercise the two named functions.
    """
    src = open(APP_JS, encoding='utf-8').read()
    occurrences = src.count('<= state.soonThresholdMins')
    assert occurrences == 1, (
        f'found {occurrences} copies of the closing-soon comparison; it '
        'belongs only in isClosingSoon()'
    )


def test_status_hex_literals_are_not_retyped_at_call_sites():
    """Same argument for the colours: STATUS_HEX or the :root var, not literals.

    occColor() is excluded — it maps an occupancy percentage, not a room
    status, and happens to reuse the same three hues.
    """
    src = open(APP_JS, encoding='utf-8').read()
    occ_start = src.index('function occColor(')
    occ_end = src.index('}', src.index('return', occ_start))
    without_occ = src[:occ_start] + src[occ_end:]
    hex_start = without_occ.index('const STATUS_HEX')
    hex_end = without_occ.index(';', hex_start)
    body = without_occ[:hex_start] + without_occ[hex_end:]
    for literal in ('#3fff8b', '#f59e0b', '#ff7166'):
        # The palette still appears in gradients, borders and glows with
        # varying alpha; what must not reappear is a bare status swap.
        assert f"isSoon ? '{literal}'" not in body
        assert f": '{literal}'\n" not in body


def test_room_card_shows_occupied_rooms_dimmed_rather_than_blank():
    """The Saved filter is the only path that feeds a busy room to the card.

    Before this existed the card had no busy branch at all: it would have
    drawn an occupied room in free-green with a time remaining. These pin the
    three presentations apart.
    """
    assert _run('roomCardStatus(room).label') == [
        'IN USE', 'IN USE', 'OPEN', 'CLOSING', 'CLOSING', 'CLOSING', 'OPEN',
        'OPEN', 'OPEN', 'CLOSING',
    ]
    assert _run('roomCardStatus(room).opacity') == [
        0.55, 0.55, 1, 1, 1, 1, 1, 1, 1, 1,
    ]


def test_occupied_room_card_prints_no_time_remaining():
    """"~10M free" on a room someone is teaching in is a lie, and the busy
    cases carry exactly the minutes that would produce one."""
    assert _run('roomCardStatus(room).timeText') == [
        '', '', 'FREE ALL DAY', '~0M', '~29M', '~30M', '~31M', '1H', '1H 35M',
        '~5M',
    ]


def test_room_card_borders_come_from_one_table():
    assert _run('roomCardStatus(room).border') == [
        'rgba(255,113,102,0.18)', 'rgba(255,113,102,0.18)',
        'rgba(63,255,139,0.1)', 'rgba(245,158,11,0.2)', 'rgba(245,158,11,0.2)',
        'rgba(245,158,11,0.2)', 'rgba(63,255,139,0.1)', 'rgba(63,255,139,0.1)',
        'rgba(63,255,139,0.1)', 'rgba(245,158,11,0.2)',
    ]


def test_screen_reader_text_does_not_promise_free_minutes_on_a_busy_room():
    assert _run('roomCardStatus(room).statusWord') == [
        'in use', 'in use', 'open', 'closing soon', 'closing soon',
        'closing soon', 'open', 'open', 'open', 'closing soon',
    ]
