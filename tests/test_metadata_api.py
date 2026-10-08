"""Metadata API facts remain independent of schedule occupancy and inventory."""
from datetime import time

from app import create_app
from campus_metadata import CampusMetadata


def test_registry_enriches_every_room_surface_without_guessing_or_creating_inventory(tmp_path):
    registry = CampusMetadata({'schema_version': 1, 'buildings': {'TEST': {
        'name': 'Synthetic building', 'source': 'test fixture', 'rooms': {
            'G-08': {'floor': 0, 'physical_capacity': 25, 'source': 'test fixture'},
            'METADATA-ONLY': {'floor': 3, 'source': 'test fixture'},
        },
    }}})
    entries = [{'building': 'TEST', 'room': room, 'days': [0],
                'time_start': time(9), 'time_end': time(10), 'capacity': 40}
               for room in ('G-08', 'BOWL', 'LECT 1')]
    client = create_app(entries, visit_db_path=str(tmp_path / 'visits.sqlite3'), metadata_registry=registry).test_client()
    for at in ('08:00', '09:30', '10:00'):
        all_rooms = client.get(f'/api/rooms/all?day=Monday&at={at}&for=120').json
        assert len(all_rooms) == 3
        for row in all_rooms:
            detail = client.get(f'/api/room/schedule?building=TEST&room={row["room"]}&day=Monday&at={at}&for=120').json
            for item in (row, detail):
                assert item['capacity'] == item['schedule_capacity'] == 40
                assert item['capacity_basis'] == 'schedule_enrollment'
                assert item['floor'] == (0 if row['room'] == 'G-08' else None)
                assert item['physical_capacity'] == (25 if row['room'] == 'G-08' else None)
                assert 'building_metadata' not in item
    matching = client.get('/api/rooms?day=Monday&at=10:00').json
    assert all('floor' in row and 'schedule_capacity' in row for row in matching)
    building, = client.get('/api/buildings?day=Monday&at=09:30').json
    assert building['total_rooms'] == 3
    assert building['building_metadata']['name'] == 'Synthetic building'
    assert 'rooms' not in building['building_metadata']
    assert client.get('/api/room/schedule?building=TEST&room=METADATA-ONLY').status_code == 404


def test_default_registry_does_not_guess_bowl_type_or_floor(tmp_path):
    client = create_app([{'building': 'CTR', 'room': 'BOWL', 'days': [0],
                          'time_start': time(9), 'time_end': time(10)}],
                        visit_db_path=str(tmp_path / 'visits.sqlite3')).test_client()
    room, = client.get('/api/rooms/all').json
    assert room['floor'] is None
    assert room['room_type'] is None
    assert room['access'] is None
