import pytest
from datetime import time
from app import create_app

MONDAY = 0

HEATMAP_SCHEDULE = [
    # CKB 217: Monday 9:00–10:30
    {"building": "CKB", "room": "217", "days": [MONDAY],
     "time_start": time(9, 0), "time_end": time(10, 30)},
    # CKB 220: Monday 9:00–9:50
    {"building": "CKB", "room": "220", "days": [MONDAY],
     "time_start": time(9, 0), "time_end": time(9, 50)},
    # KUPF 207: different building
    {"building": "KUPF", "room": "207", "days": [MONDAY],
     "time_start": time(13, 0), "time_end": time(14, 0)},
]


@pytest.fixture
def client():
    app = create_app(schedule=list(HEATMAP_SCHEDULE))
    app.config["TESTING"] = True
    return app.test_client()


class TestHeatmapEndpoint:
    def test_requires_building(self, client):
        assert client.get("/api/heatmap").status_code == 400

    def test_unknown_building_404(self, client):
        assert client.get("/api/heatmap?building=NOPE").status_code == 404

    def test_shape(self, client):
        d = client.get("/api/heatmap?building=CKB").get_json()
        assert d["building"] == "CKB"
        assert d["total_rooms"] == 2
        assert d["hours"] == list(range(7, 22))   # 7 AM – 9 PM slots
        assert len(d["days"]) == 7                # Mon–Sun
        assert all(len(row) == len(d["hours"]) for row in d["days"])

    def test_counts_rooms_occupied_per_hour(self, client):
        d = client.get("/api/heatmap?building=CKB").get_json()
        monday = d["days"][MONDAY]
        hour = {h: c for h, c in zip(d["hours"], monday)}
        assert hour[9] == 2    # both rooms in class during 9–10
        assert hour[10] == 1   # only 217 (runs until 10:30)
        assert hour[11] == 0
        # Tuesday: nothing scheduled
        assert sum(d["days"][1]) == 0

    def test_other_building_not_counted(self, client):
        d = client.get("/api/heatmap?building=CKB").get_json()
        hour = {h: c for h, c in zip(d["hours"], d["days"][MONDAY])}
        assert hour[13] == 0   # KUPF's 1 PM class must not leak in
