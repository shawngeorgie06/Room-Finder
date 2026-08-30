"""The room detail sheet must honour the day override, like every other view.

/api/room/schedule accepted `at` (time) and a test-only `_weekday` integer,
but not the named `day` param the rest of the frontend uses. So setting a day
filter changed the buildings list and the building panel while the room detail
sheet silently kept showing today — two screens disagreeing about the same
question.
"""
from datetime import time

import pytest

from app import create_app


def entry(building='KUPF', room='207', days=None, start_h=10, end_h=12):
    return {
        'building': building,
        'room': room,
        'days': days if days is not None else [1],   # Tuesday only
        'time_start': time(start_h, 0),
        'time_end': time(end_h, 0),
        'capacity': 30,
        'course': 'TEST 101',
        'title': 'Test Course',
        'instructor': 'Someone',
    }


@pytest.fixture
def client():
    # One class, Tuesdays 10:00-12:00.
    return create_app([entry()]).test_client()


def test_named_day_selects_that_weekday(client):
    """day=Tuesday must surface the Tuesday class."""
    resp = client.get('/api/room/schedule?building=KUPF&room=207&day=Tuesday&at=09:00')
    assert resp.status_code == 200
    classes = resp.get_json()['classes']
    assert len(classes) == 1, 'the Tuesday class should be listed for day=Tuesday'


def test_named_day_excludes_other_weekdays(client):
    """day=Wednesday must show the room as free — the class is Tuesday only."""
    resp = client.get('/api/room/schedule?building=KUPF&room=207&day=Wednesday&at=09:00')
    assert resp.status_code == 200
    assert resp.get_json()['classes'] == []


def test_numeric_day_is_accepted(client):
    """The param is shared with other endpoints, which accept 0-6 too."""
    resp = client.get('/api/room/schedule?building=KUPF&room=207&day=1&at=09:00')
    assert len(resp.get_json()['classes']) == 1


def test_invalid_day_falls_back_rather_than_erroring(client):
    """A malformed value must not 500 — it falls back to the real weekday."""
    resp = client.get('/api/room/schedule?building=KUPF&room=207&day=Notaday&at=09:00')
    assert resp.status_code == 200


def test_weekday_override_still_works(client):
    """The pre-existing _weekday escape hatch must keep working."""
    resp = client.get('/api/room/schedule?building=KUPF&room=207&_weekday=1&at=09:00')
    assert len(resp.get_json()['classes']) == 1
