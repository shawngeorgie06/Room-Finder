import pytest
from datetime import time
from unittest.mock import patch
from app import create_app

FAKE_SCHEDULE = [
    {"building": "KUPF", "room": "207", "days": [0], "time_start": time(13, 0), "time_end": time(14, 0)},
    {"building": "KUPF", "room": "315", "days": [0], "time_start": time(9, 0),  "time_end": time(10, 0)},
    {"building": "TIER", "room": "101", "days": [0], "time_start": time(9, 0),  "time_end": time(10, 0)},
]


@pytest.fixture
def client():
    app = create_app(schedule=FAKE_SCHEDULE)
    app.config["TESTING"] = True
    with app.test_client() as c:
        yield c


class TestRoomsEndpoint:
    def test_returns_200(self, client):
        with patch("app.get_current_time", return_value=(0, time(12, 0))):
            resp = client.get("/api/rooms")
        assert resp.status_code == 200

    def test_returns_json_list(self, client):
        with patch("app.get_current_time", return_value=(0, time(12, 0))):
            resp = client.get("/api/rooms")
        assert isinstance(resp.get_json(), list)

    def test_occupied_room_not_in_response(self, client):
        # 1:30pm Monday — KUPF 207 is in class (1pm-2pm)
        with patch("app.get_current_time", return_value=(0, time(13, 30))):
            resp = client.get("/api/rooms")
        rooms = [(r["building"], r["room"]) for r in resp.get_json()]
        assert ("KUPF", "207") not in rooms

    def test_empty_room_in_response(self, client):
        # 12pm Monday — KUPF 315 is empty (class was 9-10am)
        with patch("app.get_current_time", return_value=(0, time(12, 0))):
            resp = client.get("/api/rooms")
        rooms = [(r["building"], r["room"]) for r in resp.get_json()]
        assert ("KUPF", "315") in rooms

    def test_building_filter(self, client):
        with patch("app.get_current_time", return_value=(0, time(12, 0))):
            resp = client.get("/api/rooms?building=KUPF")
        assert all(r["building"] == "KUPF" for r in resp.get_json())

    def test_response_fields(self, client):
        with patch("app.get_current_time", return_value=(0, time(12, 0))):
            resp = client.get("/api/rooms")
        data = resp.get_json()
        assert len(data) > 0
        for room in data:
            assert "building" in room
            assert "room" in room
            assert "minutes_until_next" in room

    def test_minutes_until_next_type(self, client):
        with patch("app.get_current_time", return_value=(0, time(12, 0))):
            resp = client.get("/api/rooms")
        for room in resp.get_json():
            assert room["minutes_until_next"] is None or isinstance(room["minutes_until_next"], int)

    def test_index_returns_html(self, client):
        resp = client.get("/")
        assert resp.status_code == 200
        assert b"<!DOCTYPE html>" in resp.data or b"<html" in resp.data
