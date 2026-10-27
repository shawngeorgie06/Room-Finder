"""Registry-only tests: synthetic room facts are not campus assertions."""

import copy
import json
from pathlib import Path

import pytest

from campus_metadata import CampusMetadata, DEFAULT_METADATA_PATH, load_registry


# Fixed snapshot of static/app.js at 6e6a871, not the mutable frontend file.
EXPECTED_BUILDINGS = {
    "GITC": ("Guttenberg Information Technologies Center", 40.74424, -74.17940),
    "FMH": ("Faculty Memorial Hall", 40.74188, -74.17880),
    "CKB": ("Central King Building", 40.74196, -74.17741),
    "KUPF": ("Kupfrian Hall", 40.74242, -74.17845),
    "TIER": ("Tiernan Hall", 40.74193, -74.17950),
    "CULM": ("Cullimore Hall", 40.74294, -74.17729),
    "ME": ("Mechanical & Industrial Engineering Center", 40.74402, -74.17870),
    "FENS": ("Fenster Hall", 40.74250, -74.17709),
    "ECEC": ("Electrical & Computer Engineering Building", 40.74140, -74.17874),
    "CAMP": ("Campbell Hall", 40.74163, -74.17779),
    "WEST": ("Weston Hall", 40.74120, -74.17734),
    "WEC": ("Wellness & Events Center", 40.74229, -74.18041),
    "COLT": ("Colton Hall", 40.74146, -74.17788),
    "DHRH": ("Dorman Honors Residence Hall", 40.74135, -74.18018),
    "HUD": ("Hudson Building", 40.74170, -74.17690),
    "MALL": ("Student Mall", 40.74012, -74.17845),
    "CTR": ("Campus Center", 40.74307, -74.17835),
    "CAB": ("Central Avenue Building", 40.74379, -74.17802),
}


@pytest.fixture
def document():
    return {
        "schema_version": 1,
        "buildings": {
            "TEST": {
                "name": "Synthetic building",
                "source": "test fixture",
                "verified_at": None,
                "coordinates": {
                    "lat": 40.0,
                    "lng": -74.0,
                    "kind": "representative",
                    "approximate": True,
                    "source": "test fixture",
                    "verified_at": None,
                },
                "rooms": {
                    "G-08": {
                        "floor": 0,
                        "room_type": "classroom",
                        "access": "Synthetic restriction",
                        "amenities": ["Synthetic whiteboard"],
                        "physical_capacity": 20,
                        "source": "test fixture",
                        "verified_at": "2026-01-02",
                    },
                    "B-01": {"floor": -1, "source": "test fixture"},
                    "M": {"floor": "Mezzanine", "source": "test fixture"},
                    "LECT 1": {"floor": 2, "source": "test fixture"},
                    "LECT 2": {"floor": 3, "source": "test fixture"},
                },
            }
        },
    }


def test_seed_contains_only_inherited_building_facts():
    raw = json.loads(DEFAULT_METADATA_PATH.read_text())
    assert raw["buildings"].keys() == EXPECTED_BUILDINGS.keys()
    assert len(raw["buildings"]) == 18
    registry = load_registry()
    for code, building in raw["buildings"].items():
        assert building["rooms"] == {}
        facts = registry.enrich_building({"building": code})["building_metadata"]
        assert facts["name"] == building["name"]
        assert facts["source"] == "Inherited from static/app.js:BUILDING_NAMES at commit 6e6a871; not externally verified"
        assert facts["verified_at"] is None
        point = facts["coordinates"]
        assert point["kind"] == "representative"
        assert point["approximate"] is True
        assert point["source"] == "Inherited from static/app.js:BUILDING_COORDS at commit 6e6a871; not a verified entrance"
        assert point["verified_at"] is None


@pytest.mark.parametrize("code,expected", EXPECTED_BUILDINGS.items())
def test_seed_matches_fixed_18_building_snapshot(code, expected):
    facts = load_registry().enrich_building({"building": code})["building_metadata"]
    assert (facts["name"], facts["coordinates"]["lat"], facts["coordinates"]["lng"]) == expected


@pytest.mark.parametrize("existing_building_metadata", [False, True])
def test_room_payload_does_not_repeat_building_facts(document, existing_building_metadata):
    registry = CampusMetadata(document)
    payload = {"building": "TEST", "room": "G-08", "capacity": 42}
    if existing_building_metadata:
        payload = registry.enrich_building(payload)
    original = copy.deepcopy(payload)
    result = registry.enrich_room(payload)
    assert "building_metadata" not in result
    assert result["floor"] == 0
    assert result["physical_capacity"] == 20
    assert result["schedule_capacity"] == 42
    assert payload == original
    assert registry.enrich_building({"building": "TEST"})["building_metadata"]["name"] == "Synthetic building"


@pytest.mark.parametrize("building,room", [
    ("CTR", "BOWL"), ("CAB", "2020"), ("CKB", "G-08"),
    ("CKB", "B-01"), ("CKB", "100A"), ("CKB", "301L"),
    ("CKB", "M"), ("CKB", "LECT 1"), ("CKB", "LECT 2"), ("UNKNOWN", "UNKNOWN"),
])
def test_absent_exact_room_is_retained_without_guesses(building, room):
    payload = {"building": building, "room": room, "capacity": 42,
               "floor": 9, "room_type": "LAB", "access": "Reservation required"}
    enriched = load_registry().enrich_room(payload)
    assert (enriched["building"], enriched["room"]) == (building, room)
    for field in ("floor", "room_type", "access", "amenities", "physical_capacity",
                  "room_metadata_source", "room_metadata_verified_at"):
        assert enriched[field] is None
    assert enriched["capacity"] == enriched["schedule_capacity"] == 42
    assert enriched["capacity_basis"] == "schedule_enrollment"
    assert payload["floor"] == 9


def test_unknown_building_has_no_invented_name_or_point():
    result = load_registry().enrich_building({"building": "NEW", "total_rooms": 2})
    assert result["total_rooms"] == 2
    assert result["building_metadata"] == {
        "name": None, "coordinates": None, "source": None, "verified_at": None,
    }


@pytest.mark.parametrize("room,floor", [("G-08", 0), ("B-01", -1), ("M", "Mezzanine")])
def test_only_explicit_exact_room_facts_set_floor(document, room, floor):
    registry = CampusMetadata(document)
    assert registry.enrich_room({"building": "TEST", "room": room})["floor"] == floor
    for building, other_room in [("OTHER", room), ("TEST", room.lower()), ("TEST", room + "A")]:
        assert registry.enrich_room({"building": building, "room": other_room})["floor"] is None


@pytest.mark.parametrize("room,floor", [("LECT 1", 2), ("LECT 2", 3)])
def test_internal_space_room_ids_are_exact_and_preserved(document, room, floor):
    registry = CampusMetadata(document)
    result = registry.enrich_room({"building": "TEST", "room": room})
    assert result["room"] == room
    assert result["floor"] == floor
    for other in (room.replace(" ", ""), room.replace(" ", "  "), room.lower()):
        unknown = registry.enrich_room({"building": "TEST", "room": other})
        assert unknown["room"] == other
        assert unknown["floor"] is None


@pytest.mark.parametrize("capacity", [None, 0, 45])
@pytest.mark.parametrize("empty", [True, False])
def test_physical_capacity_is_independent_of_schedule_and_occupancy(document, capacity, empty):
    payload = {"building": "TEST", "room": "G-08", "capacity": capacity,
               "empty": empty, "matches_requested_window": False, "classes": []}
    result = CampusMetadata(document).enrich_room(payload)
    assert result["capacity"] == result["schedule_capacity"] == capacity
    assert result["capacity_basis"] == "schedule_enrollment"
    assert result["physical_capacity"] == 20
    assert result["empty"] == empty
    assert result["matches_requested_window"] is False
    assert result["classes"] == []
    assert result["room_metadata_source"] == "test fixture"
    assert result["room_metadata_verified_at"] == "2026-01-02"
    json.dumps(result, allow_nan=False)


def test_missing_schedule_capacity_is_unknown(document):
    result = CampusMetadata(document).enrich_room({"building": "TEST", "room": "G-08"})
    assert result["schedule_capacity"] is None
    assert result["physical_capacity"] == 20


def test_inputs_outputs_and_schedule_import_cannot_mutate_registry(document, tmp_path):
    from schedule import load_schedule

    path = tmp_path / "campus_metadata.json"
    path.write_text(json.dumps(document))
    before = path.read_bytes()
    registry = load_registry(path)
    original = copy.deepcopy(document)
    constructed = CampusMetadata(document)
    document["buildings"]["TEST"]["rooms"]["G-08"]["floor"] = 999
    assert constructed.enrich_room({"building": "TEST", "room": "G-08"})["floor"] == 0

    csv_path = tmp_path / "schedule.csv"
    csv_path.write_text(
        "Term,Course,Title,Section,CRN,Days,Times,Location,Status,Max,Now,Instructor,Delivery Mode,floor,physical_capacity\n"
        "202650,CS 101,Fixture,001,12345,M,9:00 AM - 10:00 AM,TEST G-08,Open,80,5,Fixture,Face-to-Face,8,800\n"
    )
    imported = load_schedule(csv_path)
    assert len(imported) == 1
    enriched = registry.enrich_room(imported[0])
    assert enriched["schedule_capacity"] == 80
    assert enriched["physical_capacity"] == 20
    assert enriched["floor"] == 0
    enriched["amenities"].append("Not curated")
    building = registry.enrich_building({"building": "TEST"})
    building["building_metadata"]["coordinates"]["lat"] = 0
    again = registry.enrich_room(imported[0])
    assert again["amenities"] == ["Synthetic whiteboard"]
    assert "building_metadata" not in again
    assert registry.enrich_building({"building": "TEST"})["building_metadata"]["coordinates"]["lat"] == 40.0
    assert imported[0].get("floor") is None
    assert path.read_bytes() == before
    assert json.loads(path.read_text()) == original


@pytest.mark.parametrize("field,value", [
    ("floor", True), ("floor", 1.5), ("floor", {}), ("floor", " "),
    ("room_type", 1), ("room_type", []), ("access", False),
    ("amenities", "projector"), ("amenities", [1]), ("amenities", [""]),
    ("physical_capacity", True), ("physical_capacity", -1),
    ("physical_capacity", 2.5), ("physical_capacity", "20"),
    ("source", 12), ("source", None), ("verified_at", "yesterday"),
    ("verified_at", "2026-02-30"), ("verified_at", False),
    ("unexpected", "fact"),
])
def test_invalid_room_fields_rejected(document, field, value):
    document["buildings"]["TEST"]["rooms"]["G-08"][field] = value
    with pytest.raises(ValueError, match="TEST.*G-08"):
        CampusMetadata(document)


@pytest.mark.parametrize("field,value", [
    ("lat", float("nan")), ("lat", float("inf")), ("lat", -91), ("lat", 91),
    ("lat", "40"), ("lat", True), ("lat", None), ("lat", 10 ** 1000),
    ("lng", float("-inf")), ("lng", -181), ("lng", 181),
    ("kind", "entrance"), ("approximate", False), ("approximate", "true"),
    ("source", None), ("verified_at", "unknown"), ("altitude", 10),
])
def test_invalid_coordinates_rejected(document, field, value):
    document["buildings"]["TEST"]["coordinates"][field] = value
    with pytest.raises(ValueError, match="TEST.*coordinates"):
        CampusMetadata(document)


@pytest.mark.parametrize("field,value", [
    ("name", 123), ("name", ""), ("source", None), ("source", False),
    ("verified_at", "not-a-date"), ("rooms", []), ("coordinates", []),
    ("access", "All rooms need reservations"),
])
def test_invalid_building_fields_rejected(document, field, value):
    document["buildings"]["TEST"][field] = value
    with pytest.raises(ValueError, match="TEST"):
        CampusMetadata(document)


@pytest.mark.parametrize("document", [
    [], None, {"schema_version": True, "buildings": {}},
    {"schema_version": 2, "buildings": {}}, {"buildings": {}},
    {"schema_version": 1, "buildings": []},
    {"schema_version": 1, "buildings": {"": {}}},
    {"schema_version": 1, "buildings": {" TEST": {}}},
    {"schema_version": 1, "buildings": {"TEST": None}},
    {"schema_version": 1, "buildings": {"TEST": {"rooms": {"": {}}}}},
    {"schema_version": 1, "buildings": {"TEST": {"rooms": {1: {}}}}},
    {"schema_version": 1, "buildings": {"TEST": {"rooms": {"BOWL": []}}}},
    {"schema_version": 1, "buildings": {}, "schedule": []},
])
def test_invalid_registry_structure_rejected(document):
    with pytest.raises(ValueError):
        CampusMetadata(document)


def test_sparse_registry_and_null_unknown_fields_are_valid():
    registry = CampusMetadata({"schema_version": 1, "buildings": {"NEW": {"rooms": {"BOWL": {}}}}})
    result = registry.enrich_room({"building": "NEW", "room": "BOWL"})
    assert result["floor"] is result["room_type"] is result["physical_capacity"] is None


def test_duplicate_json_keys_rejected(tmp_path):
    path = tmp_path / "duplicate.json"
    path.write_text('{"schema_version":1,"buildings":{"TEST":{},"TEST":{}}}')
    with pytest.raises(ValueError, match="Duplicate"):
        load_registry(path)


def test_missing_and_malformed_registry_are_explicit_errors(tmp_path):
    with pytest.raises(FileNotFoundError):
        load_registry(tmp_path / "absent.json")
    path = tmp_path / "bad.json"
    path.write_text("not JSON")
    with pytest.raises(ValueError):
        load_registry(path)


@pytest.mark.parametrize("field", ["floor", "room_type", "access", "amenities", "physical_capacity"])
def test_known_room_facts_require_a_source(document, field):
    value = document["buildings"]["TEST"]["rooms"]["G-08"][field]
    document["buildings"]["TEST"]["rooms"] = {"G-08": {field: value}}
    with pytest.raises(ValueError, match="TEST.*G-08.*source"):
        CampusMetadata(document)


def test_null_room_facts_and_known_empty_amenities_are_distinct(document):
    rooms = document["buildings"]["TEST"]["rooms"]
    rooms["UNKNOWN"] = dict.fromkeys(("floor", "room_type", "access", "amenities", "physical_capacity"))
    rooms["NONE"] = {"amenities": [], "physical_capacity": 0, "source": "test fixture"}
    registry = CampusMetadata(document)
    assert registry.enrich_room({"building": "TEST", "room": "UNKNOWN"})["amenities"] is None
    known = registry.enrich_room({"building": "TEST", "room": "NONE"})
    assert known["amenities"] == []
    assert known["physical_capacity"] == 0


@pytest.mark.parametrize("field", ["lat", "lng", "kind", "approximate", "source"])
def test_partial_coordinates_rejected(document, field):
    del document["buildings"]["TEST"]["coordinates"][field]
    with pytest.raises(ValueError, match="TEST.*coordinates"):
        CampusMetadata(document)


@pytest.mark.parametrize("value", [1.0, "1", None])
def test_schema_version_is_strict_integer(document, value):
    document["schema_version"] = value
    with pytest.raises(ValueError, match="schema_version"):
        CampusMetadata(document)


def test_all_presentation_shapes_share_facts_without_mutating_payloads(document):
    registry = CampusMetadata(document)
    expected = None
    for dynamic in [
        {"minutes_until_next": 60, "capacity": 40},
        {"empty": False, "matches_requested_window": False, "capacity": 40},
        {"classes": [], "occupied_now": False, "next_free_window": None, "capacity": 40},
        {"duration": 180, "capacity": 40},
    ]:
        payload = {"building": "TEST", "room": "G-08", **dynamic,
                   "floor": 9, "room_type": "LAB", "access": "Imported restriction",
                   "amenities": ["Imported"], "physical_capacity": 999,
                   "room_metadata_source": "Imported"}
        before = copy.deepcopy(payload)
        result = registry.enrich_room(payload)
        facts = {key: result[key] for key in (
            "floor", "room_type", "access", "amenities", "physical_capacity",
            "room_metadata_source", "room_metadata_verified_at",
        )}
        if expected is None:
            expected = facts
        assert facts == expected
        assert all(result[key] == value for key, value in dynamic.items())
        assert payload == before
        assert registry.enrich_room(result) == result


def test_verified_date_requires_provenance(document):
    document["buildings"]["TEST"]["rooms"] = {"BOWL": {"verified_at": "2026-01-02"}}
    with pytest.raises(ValueError, match="source"):
        CampusMetadata(document)


def test_default_path_does_not_depend_on_working_directory(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    assert Path(DEFAULT_METADATA_PATH).is_absolute()
    assert load_registry().enrich_building({"building": "CKB"})["building_metadata"]["name"] == "Central King Building"
