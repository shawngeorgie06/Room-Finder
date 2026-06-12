import pytest
from datetime import time
from unittest.mock import patch
from schedule import get_empty_rooms
from app import create_app

MONDAY = 0

# KUPF 207 has one Monday class: 12:00–1:00 PM
GAP_SCHEDULE = [
    {"building": "KUPF", "room": "207", "days": [MONDAY],
     "time_start": time(12, 0), "time_end": time(13, 0)},
    # TIER 101 has no Monday classes at all
    {"building": "TIER", "room": "101", "days": [1],
     "time_start": time(9, 0), "time_end": time(17, 0)},
]


def _rooms(result):
    return [(r["building"], r["room"]) for r in result]


class TestGetEmptyRoomsUntil:
    def test_room_with_class_inside_window_excluded(self):
        # Window 11:30–12:30 overlaps the 12:00 class
        result = get_empty_rooms(GAP_SCHEDULE, weekday=MONDAY,
                                 now=time(11, 30), until=time(12, 30))
        assert ("KUPF", "207") not in _rooms(result)

    def test_window_ending_when_class_starts_included(self):
        # Window 10:00–12:00; class starts exactly at window end → still free
        result = get_empty_rooms(GAP_SCHEDULE, weekday=MONDAY,
                                 now=time(10, 0), until=time(12, 0))
        assert ("KUPF", "207") in _rooms(result)

    def test_window_starting_when_class_ends_included(self):
        # Window 1:00–2:00; class ends exactly at window start → free
        result = get_empty_rooms(GAP_SCHEDULE, weekday=MONDAY,
                                 now=time(13, 0), until=time(14, 0))
        assert ("KUPF", "207") in _rooms(result)

    def test_window_overlapping_class_end_excluded(self):
        # Window 12:30–2:00 overlaps the tail of the class
        result = get_empty_rooms(GAP_SCHEDULE, weekday=MONDAY,
                                 now=time(12, 30), until=time(14, 0))
        assert ("KUPF", "207") not in _rooms(result)

    def test_no_classes_room_always_included(self):
        result = get_empty_rooms(GAP_SCHEDULE, weekday=MONDAY,
                                 now=time(11, 30), until=time(12, 30))
        assert ("TIER", "101") in _rooms(result)

    def test_until_none_keeps_old_behavior(self):
        # 11:30 with no window: room is free now (class at 12:00)
        result = get_empty_rooms(GAP_SCHEDULE, weekday=MONDAY,
                                 now=time(11, 30), until=None)
        assert ("KUPF", "207") in _rooms(result)


class TestRoomsAPIUntil:
    @pytest.fixture
    def client(self):
        app = create_app(schedule=list(GAP_SCHEDULE))
        app.config["TESTING"] = True
        return app.test_client()

    def test_until_param_filters_window(self, client):
        with patch("app.get_current_time", return_value=(MONDAY, time(11, 30))):
            resp = client.get("/api/rooms?until=12:30")
        assert resp.status_code == 200
        assert ("KUPF", "207") not in [(r["building"], r["room"]) for r in resp.get_json()]

    def test_until_with_at_override(self, client):
        resp = client.get("/api/rooms?day=0&at=10:00&until=12:00")
        assert ("KUPF", "207") in [(r["building"], r["room"]) for r in resp.get_json()]

    def test_invalid_until_ignored(self, client):
        with patch("app.get_current_time", return_value=(MONDAY, time(11, 30))):
            resp = client.get("/api/rooms?until=banana")
        assert resp.status_code == 200
        # falls back to instant check: room free at 11:30
        assert ("KUPF", "207") in [(r["building"], r["room"]) for r in resp.get_json()]
