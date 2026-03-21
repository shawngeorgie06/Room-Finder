import pytest
import os
from datetime import time
from schedule import parse_time_range, parse_days, parse_location, load_schedule


class TestParseTimeRange:
    def test_parses_pm_times(self):
        start, end = parse_time_range("1:00 PM - 2:20 PM")
        assert start == time(13, 0)
        assert end == time(14, 20)

    def test_parses_am_times(self):
        start, end = parse_time_range("8:30 AM - 9:50 AM")
        assert start == time(8, 30)
        assert end == time(9, 50)

    def test_parses_noon(self):
        start, end = parse_time_range("12:00 PM - 1:20 PM")
        assert start == time(12, 0)
        assert end == time(13, 20)

    def test_returns_none_on_tba(self):
        assert parse_time_range("TBA") is None

    def test_returns_none_on_empty(self):
        assert parse_time_range("") is None


class TestParseDays:
    def test_mwf(self):
        assert parse_days("MWF") == [0, 2, 4]

    def test_tr(self):
        assert parse_days("TR") == [1, 3]

    def test_monday_only(self):
        assert parse_days("M") == [0]

    def test_saturday(self):
        assert parse_days("S") == [5]

    def test_all_days(self):
        assert parse_days("MTWRFS") == [0, 1, 2, 3, 4, 5]

    def test_unknown_code_skipped(self):
        assert parse_days("MU") == [0]


class TestParseLocation:
    def test_standard_location(self):
        assert parse_location("KUPF 207") == ("KUPF", "207")

    def test_different_building(self):
        assert parse_location("TIER 101") == ("TIER", "101")

    def test_building_with_room_letters(self):
        assert parse_location("ECEC 100A") == ("ECEC", "100A")

    def test_returns_none_on_blank(self):
        assert parse_location("") is None
        assert parse_location("   ") is None

    def test_returns_none_on_single_token(self):
        assert parse_location("KUPF") is None


class TestLoadSchedule:
    def _xlsx(self):
        return os.path.join(os.path.dirname(__file__), "..", "Course_Schedule_All_Subjects.xlsx")

    def test_returns_list(self):
        if not os.path.exists(self._xlsx()):
            pytest.skip("Excel file not present")
        result = load_schedule(self._xlsx())
        assert isinstance(result, list)
        assert len(result) > 0

    def test_each_entry_has_required_keys(self):
        if not os.path.exists(self._xlsx()):
            pytest.skip("Excel file not present")
        result = load_schedule(self._xlsx())
        for entry in result[:20]:
            assert "building" in entry
            assert "room" in entry
            assert "days" in entry
            assert "time_start" in entry
            assert "time_end" in entry

    def test_no_blank_locations(self):
        if not os.path.exists(self._xlsx()):
            pytest.skip("Excel file not present")
        result = load_schedule(self._xlsx())
        for entry in result:
            assert entry["building"].strip() != ""
            assert entry["room"].strip() != ""

    def test_all_days_are_valid_weekday_ints(self):
        if not os.path.exists(self._xlsx()):
            pytest.skip("Excel file not present")
        result = load_schedule(self._xlsx())
        for entry in result:
            for d in entry["days"]:
                assert 0 <= d <= 5


from schedule import get_empty_rooms

MONDAY = 0

SAMPLE_SCHEDULE = [
    # KUPF 207: class 9am-10am and 1pm-2pm on Mon
    {"building": "KUPF", "room": "207", "days": [MONDAY], "time_start": time(9, 0),  "time_end": time(10, 0)},
    {"building": "KUPF", "room": "207", "days": [MONDAY], "time_start": time(13, 0), "time_end": time(14, 0)},
    # KUPF 315: class 10am-11am on Mon
    {"building": "KUPF", "room": "315", "days": [MONDAY], "time_start": time(10, 0), "time_end": time(11, 0)},
    # TIER 101: Tuesday only
    {"building": "TIER", "room": "101", "days": [1], "time_start": time(9, 0), "time_end": time(17, 0)},
]


class TestGetEmptyRooms:
    def test_occupied_room_excluded(self):
        # 9:30am Monday — KUPF 207 has class 9-10am, so it's occupied
        result = get_empty_rooms(SAMPLE_SCHEDULE, weekday=MONDAY, now=time(9, 30))
        rooms = [(r["building"], r["room"]) for r in result]
        assert ("KUPF", "207") not in rooms

    def test_empty_room_included(self):
        # 9:30am Monday — KUPF 315 is empty (its class is 10-11)
        result = get_empty_rooms(SAMPLE_SCHEDULE, weekday=MONDAY, now=time(9, 30))
        rooms = [(r["building"], r["room"]) for r in result]
        assert ("KUPF", "315") in rooms

    def test_minutes_until_next_correct(self):
        # 9:30am Monday — KUPF 315 next class at 10:00 = 30 min
        result = get_empty_rooms(SAMPLE_SCHEDULE, weekday=MONDAY, now=time(9, 30))
        kupf_315 = next(r for r in result if r["room"] == "315" and r["building"] == "KUPF")
        assert kupf_315["minutes_until_next"] == 30

    def test_minutes_until_next_null_when_no_more_classes(self):
        # 11:30am Monday — KUPF 315 had its only class at 10-11, done for today
        result = get_empty_rooms(SAMPLE_SCHEDULE, weekday=MONDAY, now=time(11, 30))
        kupf_315 = next(r for r in result if r["room"] == "315" and r["building"] == "KUPF")
        assert kupf_315["minutes_until_next"] is None

    def test_class_end_boundary_room_is_empty(self):
        # 10:00am exactly — KUPF 207's first class just ended, room is free until 1pm
        result = get_empty_rooms(SAMPLE_SCHEDULE, weekday=MONDAY, now=time(10, 0))
        rooms = [(r["building"], r["room"]) for r in result]
        assert ("KUPF", "207") in rooms

    def test_room_with_no_classes_today_appears_with_null(self):
        # TIER 101 has no Monday classes — appears as empty, free all day
        result = get_empty_rooms(SAMPLE_SCHEDULE, weekday=MONDAY, now=time(9, 30))
        tier = next((r for r in result if r["building"] == "TIER" and r["room"] == "101"), None)
        assert tier is not None
        assert tier["minutes_until_next"] is None

    def test_sorted_by_building_then_room(self):
        result = get_empty_rooms(SAMPLE_SCHEDULE, weekday=MONDAY, now=time(12, 0))
        buildings = [r["building"] for r in result]
        assert buildings == sorted(buildings)
        kupf_rooms = [r["room"] for r in result if r["building"] == "KUPF"]
        assert kupf_rooms == sorted(kupf_rooms)

    def test_building_filter(self):
        result = get_empty_rooms(SAMPLE_SCHEDULE, weekday=MONDAY, now=time(9, 30), building="KUPF")
        assert all(r["building"] == "KUPF" for r in result)

    def test_building_filter_no_match(self):
        result = get_empty_rooms(SAMPLE_SCHEDULE, weekday=MONDAY, now=time(9, 30), building="NONEXISTENT")
        assert result == []
