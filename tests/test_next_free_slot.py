import pytest
from datetime import time
from app import create_app

@pytest.fixture
def client():
    # Minimal in-memory schedule: KUPF 207, Monday, 9:00-10:15 and 11:00-12:15
    schedule = [
        {'building': 'KUPF', 'room': '207', 'days': [0],
         'time_start': time(9, 0), 'time_end': time(10, 15)},
        {'building': 'KUPF', 'room': '207', 'days': [0],
         'time_start': time(11, 0), 'time_end': time(12, 15)},
    ]
    app = create_app(schedule=schedule)
    app.config['TESTING'] = True
    return app.test_client()

def test_next_free_window_between_classes(client):
    # At 9:30 (during first class), free window should be 10:15–11:00
    resp = client.get('/api/room/schedule?building=KUPF&room=207&_weekday=0&at=09:30')
    assert resp.status_code == 200
    data = resp.get_json()
    assert data['next_free_window'] == {'start': '10:15 AM', 'end': '11:00 AM', 'duration_mins': 45}

def test_next_free_window_after_last_class(client):
    # At 12:30 (after all classes), free window should be None (free rest of day)
    resp = client.get('/api/room/schedule?building=KUPF&room=207&_weekday=0&at=12:30')
    assert resp.status_code == 200
    data = resp.get_json()
    assert data['next_free_window'] is None  # free rest of day

def test_next_free_window_before_first_class(client):
    # At 8:00 (before any class), free window is now until 9:00
    resp = client.get('/api/room/schedule?building=KUPF&room=207&_weekday=0&at=08:00')
    assert resp.status_code == 200
    data = resp.get_json()
    assert data['next_free_window'] == {'start': '8:00 AM', 'end': '9:00 AM', 'duration_mins': 60}
