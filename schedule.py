import pandas as pd
from datetime import datetime
import warnings

DAY_MAP = {"M": 0, "T": 1, "W": 2, "R": 3, "F": 4, "S": 5}
VALID_MODES = {"Face-to-Face", "Hybrid"}


def parse_time_range(time_str):
    """Parse '1:00 PM - 2:20 PM' into (time, time). Returns None on failure."""
    if not time_str or not isinstance(time_str, str):
        return None
    parts = time_str.strip().split(" - ")
    if len(parts) != 2:
        return None
    try:
        start = datetime.strptime(parts[0].strip(), "%I:%M %p").time()
        end = datetime.strptime(parts[1].strip(), "%I:%M %p").time()
        return start, end
    except ValueError:
        return None


def parse_days(days_str):
    """Parse 'MWF' into [0, 2, 4]. Unknown codes are silently skipped."""
    if not days_str or not isinstance(days_str, str):
        return []
    return [DAY_MAP[ch] for ch in days_str.strip() if ch in DAY_MAP]


def parse_location(location_str):
    """Parse 'KUPF 207' into ('KUPF', '207'). Returns None if invalid."""
    if not location_str or not isinstance(location_str, str):
        return None
    stripped = location_str.strip()
    if not stripped:
        return None
    parts = stripped.split(" ", 1)
    if len(parts) < 2 or not parts[1].strip():
        return None
    return parts[0].strip(), parts[1].strip()


def load_schedule(xlsx_path):
    """
    Load and parse the Excel schedule file.
    Returns a list of dicts: building, room, days, time_start, time_end.
    Filters to Face-to-Face and Hybrid only. Skips rows with blank locations.
    """
    df = pd.read_excel(xlsx_path, dtype=str)
    df.columns = [c.strip() for c in df.columns]

    results = []
    for _, row in df.iterrows():
        mode = str(row.get("Delivery Mode", "")).strip()
        if mode not in VALID_MODES:
            continue

        loc = parse_location(str(row.get("Location", "")))
        if loc is None:
            continue
        building, room = loc

        days = parse_days(str(row.get("Days", "")))
        if not days:
            continue

        parsed = parse_time_range(str(row.get("Times", "")))
        if parsed is None:
            warnings.warn(f"Skipping row with unparseable time: {row.get('Times')}")
            continue
        time_start, time_end = parsed

        results.append({
            "building": building,
            "room": room,
            "days": days,
            "time_start": time_start,
            "time_end": time_end,
        })

    return results


def _time_to_minutes(t):
    return t.hour * 60 + t.minute


def get_empty_rooms(schedule, weekday, now, building=None):
    """
    Return all rooms currently empty as of (weekday, now).
    Each result: {"building", "room", "minutes_until_next"} (minutes is int or None).
    Sorted by building, then room. Optional building filter.
    """
    # Collect all unique rooms and their classes for today
    all_rooms = {}  # (building, room) -> [today's class entries]
    for entry in schedule:
        key = (entry["building"], entry["room"])
        if key not in all_rooms:
            all_rooms[key] = []
        if weekday in entry["days"]:
            all_rooms[key].append(entry)

    now_min = _time_to_minutes(now)
    results = []

    for (bldg, room), today_classes in all_rooms.items():
        if building and bldg != building:
            continue

        occupied = any(
            _time_to_minutes(c["time_start"]) <= now_min < _time_to_minutes(c["time_end"])
            for c in today_classes
        )
        if occupied:
            continue

        future = [c for c in today_classes if _time_to_minutes(c["time_start"]) > now_min]
        if future:
            nxt = min(future, key=lambda c: c["time_start"])
            minutes_until_next = _time_to_minutes(nxt["time_start"]) - now_min
        else:
            minutes_until_next = None

        results.append({"building": bldg, "room": room, "minutes_until_next": minutes_until_next})

    results.sort(key=lambda r: (r["building"], r["room"]))
    return results
