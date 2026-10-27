"""Curated campus facts, independent of schedule imports and availability.

Load once at application startup with ``load_registry()``. Enrich each existing
room response via ``registry.enrich_room(payload)`` and each building response
via ``registry.enrich_building(payload)``. Neither helper filters the roster.
Building facts are supplied only by enrich_building, never repeated per room;
frontend consumers look them up by building code. Identifiers are matched exactly,
including internal spaces, with no case folding or floor/type inference.

Missing facts are None (including amenities; [] means explicitly none recorded).
A null floor intentionally erases any previous guess, and the API never infers one.
Floor searches match only against known floors. The building panel alone groups
unrecorded rooms by room number for layout (see ``panelFloor`` in static/app.js);
that grouping is presentation, not data, and is never used for search or filtering.

Room provenance covers the supplied facts only, not unknown fields. Building-level
source/verified_at pertains only to the NAME; coordinates have their own provenance.
Verification is a nullable ISO date, not a schedule import/retrieval timestamp.
Seed names and points are inherited from static/app.js at commit 6e6a871, not
externally verified. Only approximate representative points are supported; these
are never entrance or accessibility directions.

Validation checks structure and types, not source credibility. ISO dates must be
calendar-valid but are not compared with today's date. Nonblank descriptive strings
(including amenities) retain surrounding whitespace and are not normalized or
deduplicated. Identifiers reject surrounding whitespace but retain internal spaces.

The legacy ``capacity`` field is preserved and exposed as ``schedule_capacity``
with ``capacity_basis='schedule_enrollment'``. Callers must supply its stable
schedule aggregate independently of occupancy/duration; this module cannot
reconstruct it from an endpoint response. ``physical_capacity`` comes only from
the registry. Unknown rooms remain in responses; endpoint owners must separately
check that a requested room exists in the schedule before returning HTTP 200.
"""

from collections.abc import Mapping
from copy import deepcopy
from datetime import date
import json
import math
from pathlib import Path


DEFAULT_METADATA_PATH = Path(__file__).resolve().parent / "data" / "campus_metadata.json"
_ROOM_FIELDS = ("floor", "room_type", "access", "amenities", "physical_capacity")
_PROVENANCE_FIELDS = {"source", "verified_at"}


def _object(value, allowed, path):
    if not isinstance(value, dict):
        raise ValueError(f"{path}: expected an object")
    if value.keys() - allowed:
        raise ValueError(f"{path}: unexpected fields {list(value.keys() - allowed)!r}")


def _text(value, path):
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{path}: expected a nonempty string")


def _identifier(value, path):
    _text(value, path)
    if value != value.strip():
        raise ValueError(f"{path}: identifiers must not have surrounding whitespace")


def _provenance(record, path, has_facts=False):
    if "source" in record:
        _text(record["source"], f"{path}.source")
    verified_at = record.get("verified_at")
    if verified_at is not None:
        try:
            if not isinstance(verified_at, str) or date.fromisoformat(verified_at).isoformat() != verified_at:
                raise ValueError
        except ValueError:
            raise ValueError(f"{path}.verified_at: expected an ISO date (YYYY-MM-DD) or null") from None
    if (has_facts or verified_at is not None) and "source" not in record:
        raise ValueError(f"{path}.source: required for supplied facts or verification")


def _coordinates(point, path):
    required = {"lat", "lng", "kind", "approximate", "source"}
    _object(point, required | {"verified_at"}, path)
    if required - point.keys():
        raise ValueError(f"{path}: incomplete coordinates")
    for key, bound in (("lat", 90), ("lng", 180)):
        value = point[key]
        # Check range before isfinite so even enormous JSON integers fail cleanly.
        if type(value) not in (int, float) or not -bound <= value <= bound or not math.isfinite(value):
            raise ValueError(f"{path}.{key}: expected a finite number within +/-{bound}")
    if point["kind"] != "representative" or point["approximate"] is not True:
        raise ValueError(f"{path}: only approximate representative points are supported")
    _provenance(point, path, has_facts=True)


def _room(record, path):
    _object(record, set(_ROOM_FIELDS) | _PROVENANCE_FIELDS, path)
    floor = record.get("floor")
    if floor is not None and type(floor) is not int:
        _text(floor, f"{path}.floor")
    for field in ("room_type", "access"):
        if record.get(field) is not None:
            _text(record[field], f"{path}.{field}")
    amenities = record.get("amenities")
    if amenities is not None:
        if not isinstance(amenities, list):
            raise ValueError(f"{path}.amenities: expected an array or null")
        for item in amenities:
            _text(item, f"{path}.amenities")
    capacity = record.get("physical_capacity")
    if capacity is not None and (type(capacity) is not int or capacity < 0):
        raise ValueError(f"{path}.physical_capacity: expected a nonnegative integer or null")
    _provenance(record, path, has_facts=any(record.get(field) is not None for field in _ROOM_FIELDS))


def _validate(document):
    _object(document, {"schema_version", "buildings"}, "registry")
    if type(document.get("schema_version")) is not int or document["schema_version"] != 1:
        raise ValueError("registry.schema_version: expected integer 1")
    buildings = document.get("buildings")
    if not isinstance(buildings, dict):
        raise ValueError("registry.buildings: expected an object")
    for code, building in buildings.items():
        _identifier(code, "building key")
        path = f"buildings.{code}"
        _object(building, {"name", "coordinates", "rooms"} | _PROVENANCE_FIELDS, path)
        if building.get("name") is not None:
            _text(building["name"], f"{path}.name")
        _provenance(building, path, has_facts=building.get("name") is not None)
        if building.get("coordinates") is not None:
            _coordinates(building["coordinates"], f"{path}.coordinates")
        rooms = building.get("rooms", {})
        if not isinstance(rooms, dict):
            raise ValueError(f"{path}.rooms: expected an object")
        for room_id, record in rooms.items():
            _identifier(room_id, f"{path}.rooms key")
            _room(record, f"{path}.rooms.{room_id}")


class CampusMetadata:
    """Validated, read-only registry; enrichment returns detached curated facts."""

    def __init__(self, document: dict):
        _validate(document)
        self._buildings = deepcopy(document["buildings"])

    def enrich_building(self, payload: Mapping) -> dict:
        """Copy a building payload and replace only ``building_metadata``.

        Missing building facts are null. Source/verified_at describes the name;
        coordinates carry separate provenance. The output never includes the
        registry's room map. Existing schedule/dynamic values are passed through.
        """
        building = self._buildings.get(payload["building"], {})
        return {
            **payload,
            "building_metadata": deepcopy({
                field: building.get(field)
                for field in ("name", "coordinates", "source", "verified_at")
            }),
        }

    def enrich_room(self, payload: Mapping) -> dict:
        """Copy an exact building/room payload, replacing all curated fact fields.

        Input must include string ``building`` and ``room`` identifiers. Existing
        guessed/imported room metadata is overwritten even when curated facts are
        unknown. Null floors erase guesses and are excluded
        from floor-specific matches. Any preexisting building_metadata is
        removed: obtain building facts separately via enrich_building. Dynamic
        fields are not recomputed, deep-copied, or mutated.
        """
        result = dict(payload)
        result.pop("building_metadata", None)
        building = self._buildings.get(payload["building"], {})
        room = building.get("rooms", {}).get(payload["room"], {})
        result.update(deepcopy({field: room.get(field) for field in _ROOM_FIELDS}))
        result.update({
            "room_metadata_source": room.get("source"),
            "room_metadata_verified_at": room.get("verified_at"),
            "schedule_capacity": payload.get("capacity"),
            "capacity_basis": "schedule_enrollment",
        })
        return result


def _unique_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"Duplicate metadata key: {key!r}")
        result[key] = value
    return result


def load_registry(path: str | Path = DEFAULT_METADATA_PATH) -> CampusMetadata:
    """Read and validate JSON; missing/malformed data raises rather than hiding it.

    No writes, automatic reload, dependency on Flask, or schedule imports occur.
    Duplicate keys are rejected instead of silently discarding curated records.
    """
    with Path(path).open(encoding="utf-8") as source:
        return CampusMetadata(json.load(source, object_pairs_hook=_unique_keys))
