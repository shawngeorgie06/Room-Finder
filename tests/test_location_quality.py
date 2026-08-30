"""Unit tests for the JS locationQuality() tier logic, executed in node.

The repo has no JS test runner, but this logic is a pure function and is the
thing most worth testing: it decides whether a distance ranking is honest
enough to show. Extracting it and running it in node gives real assertions
against the real source rather than a regex that only proves text exists.
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


def _extract(fn_name):
    """Pull one top-level function's source out of app.js by brace matching."""
    src = open(APP_JS, encoding='utf-8').read()
    start = src.index(f'function {fn_name}(')
    depth, i = 0, src.index('{', start)
    for j in range(i, len(src)):
        if src[j] == '{':
            depth += 1
        elif src[j] == '}':
            depth -= 1
            if depth == 0:
                return src[start:j + 1]
    raise AssertionError(f'unbalanced braces extracting {fn_name}')


def _run(accuracies):
    script = _extract('locationQuality') + '\n' + (
        'console.log(JSON.stringify('
        + json.dumps(accuracies)
        + '.map(a => locationQuality(a).tier)));'
    )
    out = subprocess.run(['node', '-e', script], capture_output=True, text=True,
                         timeout=20)
    assert out.returncode == 0, out.stderr
    return json.loads(out.stdout)


def test_good_accuracy_ranks_normally():
    # Well under the 177 m median gap between NJIT buildings.
    assert _run([5, 25, 50]) == ['good'] * 3


def test_coarse_accuracy_still_ranks_but_is_flagged():
    # Typical indoor GPS. Ranking is useful but nearby buildings may swap.
    assert _run([51, 90, 150]) == ['coarse'] * 3


def test_unusable_accuracy_refuses_to_rank():
    # Approaching the campus's full 465 m extent — the order would be noise.
    assert _run([151, 300, 1000]) == ['unusable'] * 3


def test_missing_or_nonsensical_accuracy_is_treated_as_unusable():
    """A fix with no accuracy figure must not be presented as trustworthy.

    Zero and negatives are included deliberately: a device claiming 0 m
    accuracy is reporting nonsense, not perfection, and treating that as the
    most trustworthy tier would invert the whole point of this gate.
    """
    assert _run([None, 0, -1]) == ['unusable'] * 3


def test_tiers_carry_a_human_message_except_when_good():
    script = _extract('locationQuality') + '\n' + (
        'console.log(JSON.stringify([5, 90, 400].map(a => locationQuality(a))));'
    )
    out = subprocess.run(['node', '-e', script], capture_output=True, text=True,
                         timeout=20)
    assert out.returncode == 0, out.stderr
    good, coarse, unusable = json.loads(out.stdout)
    assert good['message'] == ''
    assert '90' in coarse['message'], 'coarse tier should quote the actual figure'
    assert coarse['message'] and unusable['message']
