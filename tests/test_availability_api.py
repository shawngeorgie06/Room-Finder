"""Cross-surface availability, validation and effective-context contracts."""

from copy import deepcopy
from datetime import time
from unittest.mock import patch

import pytest

from app import create_app
from tests.test_availability_facts import entry


SURFACES = ["/api/rooms", "/api/rooms/all", "/api/buildings", "/api/room/schedule"]
DETAIL = {"building": "KUPF", "room": "207"}
FACT_KEYS = ("empty", "matches_requested_window", "available_from_min",
             "available_until_min", "minutes_until_next", "capacity")


@pytest.fixture
def entries():
    return [
        entry("14:30", "16:00", capacity=30),
        entry("09:00", "10:00", days=(1,), capacity=50),
        entry("12:00", "14:00", room="315", capacity=40),
        entry("09:00", "10:00", building="TIER", room="G-08", days=(1,), capacity=None),
    ]


@pytest.fixture
def client(entries, tmp_path):
    app = create_app(entries, visit_db_path=str(tmp_path / "visits.sqlite3"))
    app.config["TESTING"] = True
    return app.test_client()


def query(client, path, **params):
    return client.get(path, query_string={**DETAIL, **params})


def fact_subset(row):
    return {key: row[key] for key in FACT_KEYS}


def test_all_surfaces_share_facts_but_matching_does_not_change_occupancy(client):
    params = {"day": "Monday", "at": "13:00"}
    instant = query(client, "/api/rooms/all", **params).get_json()
    requested = query(client, "/api/rooms/all", **params, **{"for": 120}).get_json()
    instant_by_room = {r["room"]: r for r in instant}
    for row in requested:
        old = instant_by_room[row["room"]]
        for key in ("empty", "capacity", "minutes_until_next", "available_from_min", "available_until_min"):
            assert row[key] == old[key]
    room = next(row for row in requested if row["room"] == "207")
    assert room["empty"] is True
    assert room["matches_requested_window"] is False
    assert room["capacity"] == 50
    detail = query(client, "/api/room/schedule", **params, **{"for": 120}).get_json()
    assert fact_subset(detail) == fact_subset(room)
    assert detail["occupied_now"] is False
    assert query(client, "/api/rooms", **params, **{"for": 120}).get_json() == []
    building = next(b for b in query(client, "/api/buildings", **params, **{"for": 120}).get_json()
                    if b["building"] == "KUPF")
    expected = {"building": "KUPF", "total_rooms": 2, "empty_rooms": 1,
                "occupied_rooms": 1, "occupancy_pct": 50, "matching_rooms": 0}
    assert {key: building[key] for key in expected} == expected


@pytest.mark.parametrize("path", SURFACES)
def test_until_takes_precedence_across_surfaces(client, path):
    short = query(client, path, day="Monday", at="13:00", until="14:30", **{"for": 9999})
    assert short.status_code == 200
    data = short.get_json()
    if path == "/api/buildings":
        assert next(b for b in data if b["building"] == "KUPF")["matching_rooms"] == 1
    elif path == "/api/room/schedule":
        assert data["matches_requested_window"] is True
    else:
        assert next(r for r in data if r["room"] == "207")["matches_requested_window"] is True


@pytest.mark.parametrize("path", SURFACES)
@pytest.mark.parametrize("until", ["banana", "", "25:00", "24:00", "13:00", "12:59", "00:30"])
def test_invalid_explicit_windows_return_clear_400(client, path, until):
    response = query(client, path, day="Monday", at="13:00", until=until)
    assert response.status_code == 400
    assert response.get_json()["error"]
    assert response.get_json()["error_code"] == "invalid_window"


@pytest.mark.parametrize("path", SURFACES)
def test_duration_crossing_midnight_returns_400(client, path):
    response = query(client, path, day="Monday", at="23:30", **{"for": 31})
    assert response.status_code == 400
    assert response.get_json()["error_code"] == "invalid_window"
    assert response.headers["X-Query-Time"] == "23:30"
    assert response.headers["X-Query-Preview"] == "1"
    assert query(client, path, day="Monday", at="23:30", **{"for": 30}).status_code == 200


@pytest.mark.parametrize("path", SURFACES)
@pytest.mark.parametrize("params,preview", [
    ({}, "0"),
    ({"at": "invalid"}, "0"),
    ({"day": "Tuesday"}, "1"),
    ({"day": "Tuesday", "at": "invalid"}, "1"),
])
def test_live_duration_exceeding_day_has_actionable_terminal_error(client, path, params, preview):
    with patch("app.get_current_time", return_value=(0, time(22, 1, 59))):
        response = query(client, path, **params, **{"for": 120})
    assert response.status_code == 400
    assert response.get_json() == {
        "error_code": "duration_exceeds_day",
        "error": "Choose a shorter duration or a start time; this search cannot cross midnight.",
    }
    assert response.headers["X-Query-Time"] == "22:01"
    assert response.headers["X-Query-Day"] == ("Tuesday" if "day" in params else "Monday")
    assert response.headers["X-Query-Preview"] == preview


@pytest.mark.parametrize("path", SURFACES)
def test_live_until_overrides_duration_that_would_exceed_day(client, path):
    with patch("app.get_current_time", return_value=(0, time(22, 1))):
        response = query(client, path, until="22:30", **{"for": 120})
    assert response.status_code == 200
    assert response.headers["X-Query-Time"] == "22:01"
    assert response.headers["X-Query-Preview"] == "0"


@pytest.mark.parametrize("path", SURFACES)
@pytest.mark.parametrize("until", ["14:3", "1:05", "9:00", "14:03 ", " 14:03", "１４:03", "14:０3"])
def test_until_requires_strict_ascii_hh_mm(client, path, until):
    response = query(client, path, day="Monday", at="00:00", until=until)
    assert response.status_code == 400
    assert response.get_json()["error_code"] == "invalid_window"


@pytest.mark.parametrize("path", SURFACES)
def test_legacy_at_parsing_is_not_tightened_with_until(client, path):
    response = query(client, path, day="Monday", at="9:00", until="10:00")
    assert response.status_code == 200
    assert response.headers["X-Query-Time"] == "09:00"
    assert response.headers["X-Query-Preview"] == "1"


@pytest.mark.parametrize("path", SURFACES)
@pytest.mark.parametrize("at", [None, "invalid"])
def test_elapsed_live_window_is_terminal_window_ended(client, path, at):
    params = {"until": "13:00"}
    if at is not None:
        params["at"] = at
    with patch("app.get_current_time", return_value=(0, time(13))):
        response = query(client, path, **params)
    assert response.status_code == 400
    assert response.get_json()["error_code"] == "window_ended"
    assert response.headers["X-Query-Time"] == "13:00"
    assert response.headers["X-Query-Preview"] == "0"


def test_filtered_rooms_are_exactly_the_matching_full_roster(client):
    for options in ({}, {"for": 120}, {"until": "14:30"}, {"until": "14:31"}):
        params = {"day": "Monday", "at": "13:00", **options}
        all_rows = client.get("/api/rooms/all", query_string=params).get_json()
        matched = client.get("/api/rooms", query_string=params).get_json()
        assert {(r["building"], r["room"]) for r in matched} == {
            (r["building"], r["room"]) for r in all_rows if r["matches_requested_window"]
        }
        assert all(r["empty"] and r["matches_requested_window"] for r in matched)


def test_unknown_room_is_404_but_known_zero_class_day_is_200(client):
    assert query(client, "/api/room/schedule", room="unknown").status_code == 404
    assert query(client, "/api/room/schedule", building="unknown").status_code == 404
    response = query(client, "/api/room/schedule", building="TIER", room="G-08", day="Monday", at="13:00")
    assert response.status_code == 200
    assert response.get_json()["classes"] == []
    assert response.get_json()["empty"] is True
    assert response.get_json()["available_from_min"] == 780
    assert response.get_json()["available_until_min"] is None


@pytest.mark.parametrize("weekday", ["-1", "7", "100", "banana", ""])
def test_legacy_weekday_is_bounded(client, weekday):
    response = query(client, "/api/room/schedule", _weekday=weekday)
    assert response.status_code == 400
    assert response.get_json()["error"]


@pytest.mark.parametrize("params,day,at,preview", [
    ({}, "Wednesday", "13:17", "0"),
    ({"at": "bad", "day": "bad", "for": "bad"}, "Wednesday", "13:17", "0"),
    ({"day": "Monday"}, "Monday", "13:17", "1"),
    ({"at": "08:00"}, "Wednesday", "08:00", "1"),
    ({"day": "0", "at": "bad"}, "Monday", "13:17", "1"),
    ({"at": "13:17", "for": "-1"}, "Wednesday", "13:17", "1"),
])
@pytest.mark.parametrize("path", SURFACES)
def test_headers_describe_actual_context_once_per_request(client, path, params, day, at, preview):
    with patch("app.get_current_time", return_value=(2, time(13, 17, 59))) as clock:
        response = query(client, path, **params)
    assert response.status_code == 200
    assert clock.call_count == 1
    assert response.headers["X-Query-Day"] == day
    assert response.headers["X-Query-Time"] == at
    assert response.headers["X-Query-Timezone"] == "America/New_York"
    assert response.headers["X-Query-Preview"] == preview
    assert response.headers["X-Schedule-Version"]
    if path == "/api/room/schedule":
        assert response.get_json()["weekday"] == day
        h, m = map(int, at.split(":"))
        assert response.get_json()["now_min"] == h * 60 + m


def test_legacy_weekday_header_reflects_effective_override(client):
    response = query(client, "/api/room/schedule", day="Tuesday", _weekday="6", at="10:00")
    assert response.headers["X-Query-Day"] == "Sunday"
    assert response.headers["X-Query-Preview"] == "1"
    assert response.get_json()["weekday"] == "Sunday"


def test_deterministic_versions_match_across_surfaces_and_schedule_info(client, entries, tmp_path):
    responses = [query(client, path, day="Monday", at="13:00") for path in SURFACES]
    versions = {response.headers["X-Schedule-Version"] for response in responses}
    assert len(versions) == 1
    version, = versions
    info = client.get("/api/schedule-info")
    assert info.headers["X-Schedule-Version"] == version
    assert info.get_json()["schedule_version"] == version
    restarted = create_app(list(reversed(deepcopy(entries))), visit_db_path=str(tmp_path / "other.sqlite3")).test_client()
    assert restarted.get("/api/rooms?day=Tuesday&at=09:00").headers["X-Schedule-Version"] == version
    changed = deepcopy(entries)
    changed[0]["capacity"] = 31
    updated = create_app(changed, visit_db_path=str(tmp_path / "changed.sqlite3")).test_client()
    assert updated.get("/api/rooms").headers["X-Schedule-Version"] != version


def test_overlap_and_current_gap_detail_preserve_courses_and_legacy_window(tmp_path):
    entries = [entry("09:00", "12:00", course="OUTER"),
               entry("09:30", "10:00", course="INNER"),
               entry("11:00", "11:30", course="NESTED"),
               entry("12:00", "13:00", course="TOUCHING"),
               entry("14:00", "15:00", course="FINAL")]
    client = create_app(entries, visit_db_path=str(tmp_path / "detail.sqlite3")).test_client()
    expected = [
        ("10:15", False, 780, 840, {"start": "1:00 PM", "end": "2:00 PM", "duration_mins": 60}),
        ("13:20", True, 800, 840, {"start": "1:20 PM", "end": "2:00 PM", "duration_mins": 40}),
        ("14:30", False, 900, None, None),
        ("15:00", True, 900, None, None),
    ]
    for at, empty, start, end, legacy in expected:
        detail = query(client, "/api/room/schedule", day="Monday", at=at).get_json()
        assert detail["empty"] is empty
        assert detail["occupied_now"] is not empty
        assert detail["available_from_min"] == start
        assert detail["available_until_min"] == end
        assert detail["next_free_window"] == legacy
        assert [c["course"] for c in detail["classes"]] == ["OUTER", "INNER", "NESTED", "TOUCHING", "FINAL"]
        assert detail["classes"][0]["title"] == "Original course title"
        row, = query(client, "/api/rooms/all", day="Monday", at=at).get_json()
        assert fact_subset(row) == fact_subset(detail)


def test_empty_inventory_still_validates_windows(tmp_path):
    client = create_app([], visit_db_path=str(tmp_path / "empty.sqlite3")).test_client()
    for path in SURFACES:
        assert query(client, path, at="13:00", until="12:00").status_code == 400
    assert client.get("/api/rooms/all?day=Monday&at=13:00").get_json() == []


@pytest.mark.parametrize("path", SURFACES)
def test_rollover_precedes_availability_and_changes_content_version(path, monkeypatch, tmp_path):
    # Stub disk selection, not parser/import behavior: each surface must capture
    # the newly selected schedule without waiting for a schedule-info request.
    old = [entry("14:00", "15:00", capacity=30)]
    new = [entry("12:00", "14:00", capacity=50)]
    monkeypatch.setattr("app._load_best_schedule", lambda: (old, "old.csv"))
    monkeypatch.setattr("app._default_schedule_candidates", lambda folder: ["old.csv"])
    client = create_app(visit_db_path=str(tmp_path / "rollover.sqlite3")).test_client()
    first = query(client, path, day="Monday", at="13:00")
    monkeypatch.setattr("app._default_schedule_candidates", lambda folder: ["new.csv", "old.csv"])
    monkeypatch.setattr("app.load_schedule", lambda filename: new)
    second = query(client, path, day="Monday", at="13:00")
    assert first.status_code == second.status_code == 200
    assert first.headers["X-Schedule-Version"] != second.headers["X-Schedule-Version"]
    if path == "/api/rooms":
        assert first.get_json()[0]["room"] == "207"
        assert second.get_json() == []
    elif path == "/api/buildings":
        assert first.get_json()[0]["empty_rooms"] == 1
        assert second.get_json()[0]["empty_rooms"] == 0
    else:
        row = second.get_json() if path.endswith("/schedule") else second.get_json()[0]
        assert row["empty"] is False
        assert row["capacity"] == 50
    info = client.get("/api/schedule-info")
    assert info.get_json()["schedule_version"] == second.headers["X-Schedule-Version"]
