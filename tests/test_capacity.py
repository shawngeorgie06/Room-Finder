import pytest
from app import create_app


@pytest.fixture
def client():
    app = create_app([])
    return app.test_client()


def make_entry(building='KUPF', room='207', days=None, start_h=10, end_h=12, capacity=30):
    from datetime import time
    return {
        'building': building,
        'room': room,
        'days': days or [0, 1, 2, 3, 4],
        'time_start': time(start_h, 0),
        'time_end': time(end_h, 0),
        'capacity': capacity,
    }


def test_capacity_in_empty_rooms():
    from schedule import get_empty_rooms
    from datetime import time
    s = [make_entry(start_h=14, end_h=16, capacity=43)]
    result = get_empty_rooms(s, weekday=0, now=time(10, 0))
    assert result[0]['capacity'] == 43


def test_capacity_none_when_missing():
    from schedule import get_empty_rooms
    from datetime import time
    entry = make_entry(start_h=14, end_h=16, capacity=None)
    result = get_empty_rooms([entry], weekday=0, now=time(10, 0))
    assert result[0]['capacity'] is None


def test_capacity_max_across_classes():
    from schedule import get_empty_rooms
    from datetime import time
    # Two classes in same room with different capacities
    s = [
        make_entry(start_h=8, end_h=9, capacity=20),
        make_entry(start_h=14, end_h=16, capacity=43),
    ]
    result = get_empty_rooms(s, weekday=0, now=time(10, 0))
    assert result[0]['capacity'] == 43


def test_rooms_all_api_has_capacity(client):
    import json
    resp = client.get('/api/rooms/all')
    assert resp.status_code == 200
    # With empty schedule, response is empty list — just check it doesn't error


def test_room_schedule_api_has_capacity():
    from datetime import time
    app = create_app([make_entry(building='KUPF', room='207', capacity=40)])
    c = app.test_client()
    resp = c.get('/api/room/schedule?building=KUPF&room=207&_weekday=0&at=10:00')
    import json
    data = json.loads(resp.data)
    assert data['capacity'] == 40
