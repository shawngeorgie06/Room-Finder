"""Schedule-only contracts shared by filtered lists, full rosters, and detail."""

from copy import deepcopy
from datetime import time

import pytest
import schedule


def entry(start, end, *, building="KUPF", room="207", days=(0,), capacity=30,
          course="CS 100"):
    return {
        "building": building,
        "room": room,
        "days": list(days),
        "time_start": time.fromisoformat(start),
        "time_end": time.fromisoformat(end),
        "capacity": capacity,
        "course": course,
        "title": "Original course title",
        "instructor": "Original instructor",
    }


@pytest.fixture
def overlapping_classes():
    # Unsorted, overlapping, nested, duplicate and touching classes form 09–13.
    return [
        entry("11:00", "12:00", course="CS 200"),
        entry("09:00", "11:00"),
        entry("09:30", "10:00", course="CS 110"),
        entry("09:00", "11:00"),
        entry("12:00", "13:00", course="CS 300"),
        entry("10:30", "11:30", course="CS 220"),
        entry("14:00", "15:00", course="CS 400"),
    ]


def facts(classes, at, **kwargs):
    return schedule.get_availability_facts(classes, time.fromisoformat(at), **kwargs)


def test_until_takes_precedence_over_duration():
    classes = [entry("12:00", "13:00")]
    result = schedule.get_empty_rooms(
        classes, 0, time(11), min_duration_mins=120, until=time(12)
    )
    assert len(result) == 1
    assert result[0]["matches_requested_window"] is True


@pytest.mark.parametrize("until", [time(11), time(10), time(0), "12:00", "banana"])
def test_invalid_explicit_windows_raise_value_error(until):
    # Validation must not be bypassed even when the inventory is empty.
    with pytest.raises(ValueError):
        schedule.get_empty_rooms([], 0, time(11), until=until)


def test_duration_crossing_midnight_rejected():
    with pytest.raises(ValueError):
        schedule.get_empty_rooms([], 0, time(23, 30), min_duration_mins=31)


@pytest.mark.parametrize("duration", [-1, 1.5, "30", None, True])
def test_invalid_duration_rejected_in_core(duration):
    with pytest.raises(ValueError):
        schedule.get_empty_rooms([], 0, time(11), min_duration_mins=duration)


@pytest.mark.parametrize("weekday", [-1, 7, "0", None, True])
def test_invalid_weekday_rejected_in_core(weekday):
    with pytest.raises(ValueError):
        schedule.get_room_availability([], weekday, time(11))


def test_merge_preserves_original_course_records(overlapping_classes):
    original = deepcopy(overlapping_classes)
    assert schedule.merged_busy_intervals(overlapping_classes) == [(540, 780), (840, 900)]
    facts(overlapping_classes, "10:15")
    schedule.get_room_availability(overlapping_classes, 0, time(10, 15))
    assert overlapping_classes == original
    assert len(overlapping_classes) == 7


@pytest.mark.parametrize(
    "at,empty,available_from,available_until,minutes",
    [
        ("08:00", True, 480, 540, 60),
        ("09:00", False, 780, 840, None),
        ("09:45", False, 780, 840, None),
        ("10:00", False, 780, 840, None),
        ("10:15", False, 780, 840, None),
        ("11:00", False, 780, 840, None),
        ("12:00", False, 780, 840, None),
        ("13:00", True, 780, 840, 60),
        ("13:20", True, 800, 840, 40),
        ("14:00", False, 900, None, None),
        ("14:30", False, 900, None, None),
        ("15:00", True, 900, None, None),
    ],
)
def test_half_open_merged_boundaries(
    overlapping_classes, at, empty, available_from, available_until, minutes
):
    result = facts(overlapping_classes, at)
    assert result == {
        "empty": empty,
        "matches_requested_window": empty,
        "available_from_min": available_from,
        "available_until_min": available_until,
        "minutes_until_next": minutes,
    }


def test_gap_starts_at_query_not_previous_class_end(overlapping_classes):
    result = facts(overlapping_classes, "13:20")
    assert result["available_from_min"] == 800
    assert result["minutes_until_next"] == 40


def test_final_occupied_class_has_availability_after_end():
    result = facts([entry("18:00", "20:50")], "19:00")
    assert result["empty"] is False
    assert result["matches_requested_window"] is False
    assert result["available_from_min"] == 1250
    assert result["available_until_min"] is None
    assert result["minutes_until_next"] is None


def test_duration_mismatch_does_not_change_occupancy_or_free_boundaries():
    classes = [entry("14:30", "16:00")]
    instant = facts(classes, "13:00")
    requested = facts(classes, "13:00", min_duration_mins=120)
    assert requested == {**instant, "matches_requested_window": False}
    assert requested["empty"] is True
    assert requested["minutes_until_next"] == 90


@pytest.mark.parametrize("duration,matching", [(0, True), (60, True), (61, False)])
def test_duration_boundary(duration, matching):
    result = facts([entry("12:00", "13:00")], "11:00", min_duration_mins=duration)
    assert result["matches_requested_window"] is matching
    assert result["empty"] is True


@pytest.mark.parametrize("until,matching", [(time(12), True), (time(12, 1), False)])
def test_explicit_end_boundary(until, matching):
    result = facts([entry("12:00", "13:00")], "11:00", until=until)
    assert result["matches_requested_window"] is matching
    assert result["empty"] is True


def test_until_ignores_unused_duration_even_if_it_would_cross_midnight():
    result = facts([], "23:00", min_duration_mins=120, until=time(23, 30))
    assert result["matches_requested_window"] is True


def test_duration_ending_at_midnight_is_valid_without_claiming_access():
    result = facts([], "23:30", min_duration_mins=30)
    assert result == {
        "empty": True,
        "matches_requested_window": True,
        "available_from_min": 1410,
        "available_until_min": None,
        "minutes_until_next": None,
    }


def test_room_capacity_stable_across_occupancy_day_and_match():
    classes = [entry("14:30", "16:00", capacity=30),
               entry("09:00", "10:00", days=(1,), capacity=50)]
    for weekday, at, duration, empty, matching in [
        (0, time(13), 0, True, True),
        (0, time(13), 120, True, False),
        (0, time(15), 0, False, False),
        (2, time(15), 120, True, True),
    ]:
        result, = schedule.get_room_availability(
            classes, weekday, at, min_duration_mins=duration
        )
        assert result["capacity"] == 50
        assert result["empty"] is empty
        assert result["matches_requested_window"] is matching


@pytest.mark.parametrize("capacities,expected", [([None, None], None), ([None, 0], 0), ([0, 40], 40)])
def test_capacity_aggregate_preserves_zero_and_unknown(capacities, expected):
    classes = [entry("12:00", "13:00", capacity=c) for c in capacities]
    result, = schedule.get_room_availability(classes, 0, time(12))
    assert result["capacity"] == expected


def test_inventory_is_all_schedule_rooms_including_zero_class_day():
    classes = [entry("09:00", "17:00", building="TIER", room="G-08", days=(1,)),
               entry("09:00", "17:00", room="BOWL")]
    result = schedule.get_room_availability(classes, 0, time(10))
    assert [(r["building"], r["room"]) for r in result] == [("KUPF", "BOWL"), ("TIER", "G-08")]
    tier = result[1]
    assert tier["empty"] is True
    assert tier["matches_requested_window"] is True
    assert tier["available_from_min"] == 600
    assert tier["available_until_min"] is None
    assert schedule.get_room_availability([], 0, time(10)) == []
    assert schedule.get_room_availability(classes, 0, time(10), building="TIER") == [tier]
    assert schedule.get_room_availability(classes, 0, time(10), building="UNKNOWN") == []


@pytest.mark.parametrize("options", [{}, {"min_duration_mins": 120}, {"until": time(12)},
                                     {"until": time(12), "min_duration_mins": 120}])
def test_compatibility_wrapper_returns_exactly_matching_facts(options):
    classes = [entry("12:00", "13:00", room="100"),
               entry("10:00", "13:00", room="200"),
               entry("12:00", "13:00", room="300", days=(1,))]
    all_rows = schedule.get_room_availability(classes, 0, time(11), **options)
    filtered = schedule.get_empty_rooms(classes, 0, time(11), **options)
    assert filtered == [row for row in all_rows if row["matches_requested_window"]]
    assert filtered
    assert all(row["empty"] and row["matches_requested_window"] for row in filtered)
