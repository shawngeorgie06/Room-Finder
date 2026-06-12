import io
import os
import pytest
from datetime import time
from unittest.mock import patch
from app import create_app

FAKE_SCHEDULE = [
    {"building": "KUPF", "room": "207", "days": [0], "time_start": time(13, 0), "time_end": time(14, 0)},
    {"building": "KUPF", "room": "315", "days": [0], "time_start": time(9, 0),  "time_end": time(10, 0)},
]


@pytest.fixture
def client():
    app = create_app(schedule=list(FAKE_SCHEDULE))
    app.config["TESTING"] = True
    with app.test_client() as c:
        yield c


class TestForParamValidation:
    """Bug 1: non-numeric ?for= values crashed with a 500."""

    def test_rooms_with_non_numeric_for_returns_200(self, client):
        with patch("app.get_current_time", return_value=(0, time(12, 0))):
            resp = client.get("/api/rooms?for=abc")
        assert resp.status_code == 200

    def test_buildings_with_non_numeric_for_returns_200(self, client):
        with patch("app.get_current_time", return_value=(0, time(12, 0))):
            resp = client.get("/api/buildings?for=abc")
        assert resp.status_code == 200

    def test_rooms_all_with_non_numeric_for_returns_200(self, client):
        with patch("app.get_current_time", return_value=(0, time(12, 0))):
            resp = client.get("/api/rooms/all?for=12abc")
        assert resp.status_code == 200

    def test_valid_for_still_filters(self, client):
        # 12pm Monday — KUPF 315 free all day, KUPF 207 has class at 1pm (60 min away)
        with patch("app.get_current_time", return_value=(0, time(12, 0))):
            resp = client.get("/api/rooms?for=90")
        rooms = [(r["building"], r["room"]) for r in resp.get_json()]
        assert ("KUPF", "315") in rooms
        assert ("KUPF", "207") not in rooms


class TestUploadValidation:
    """Bugs 2 & 3: a rejected upload must not leave a poisoned file on disk,
    and uploads must have a size cap."""

    def test_max_content_length_is_set(self, client):
        app = create_app(schedule=[])
        assert app.config.get("MAX_CONTENT_LENGTH") == 10 * 1024 * 1024

    def test_invalid_upload_leaves_no_file_behind(self, client, tmp_path, monkeypatch):
        monkeypatch.setattr("app.UPLOAD_FOLDER", str(tmp_path))
        # Header-only CSV: parses fine but yields zero schedule entries
        bad_csv = io.BytesIO(b"Term,Course,Days,Times,Location,Max,Delivery Mode\n")
        resp = client.post(
            "/api/upload-schedule",
            data={"file": (bad_csv, "empty.csv")},
            content_type="multipart/form-data",
        )
        assert resp.status_code == 422
        import glob
        assert glob.glob(os.path.join(str(tmp_path), "uploaded_schedule*")) == []

    def test_valid_upload_persists_file(self, client, tmp_path, monkeypatch):
        monkeypatch.setattr("app.UPLOAD_FOLDER", str(tmp_path))
        good_csv = io.BytesIO(
            b"Term,Course,Days,Times,Location,Max,Delivery Mode\n"
            b"202650,CS 113,MW,1:00 PM - 2:20 PM,KUPF 207,40,Face-to-Face\n"
        )
        resp = client.post(
            "/api/upload-schedule",
            data={"file": (good_csv, "Course_Schedule_202650.csv")},
            content_type="multipart/form-data",
        )
        assert resp.status_code == 200
        assert resp.get_json()["entries"] == 1
        # Saved under a term-suffixed name (term 202650 read from the data)
        assert os.path.exists(os.path.join(str(tmp_path), "uploaded_schedule_202650.csv"))

    def test_upload_removes_superseded_files(self, client, tmp_path, monkeypatch):
        # Legacy un-termed uploads and the same term's other extension are
        # superseded by a successful upload and must be removed — they would
        # outrank or shadow it in the restart load order.
        monkeypatch.setattr("app.UPLOAD_FOLDER", str(tmp_path))
        legacy = os.path.join(str(tmp_path), "uploaded_schedule.xlsx")
        same_term_xlsx = os.path.join(str(tmp_path), "uploaded_schedule_202650.xlsx")
        for p in (legacy, same_term_xlsx):
            with open(p, "wb") as fh:
                fh.write(b"stale")
        good_csv = io.BytesIO(
            b"Term,Course,Days,Times,Location,Max,Delivery Mode\n"
            b"202650,CS 113,MW,1:00 PM - 2:20 PM,KUPF 207,40,Face-to-Face\n"
        )
        resp = client.post(
            "/api/upload-schedule",
            data={"file": (good_csv, "Course_Schedule_202650.csv")},
            content_type="multipart/form-data",
        )
        assert resp.status_code == 200
        assert not os.path.exists(legacy)
        assert not os.path.exists(same_term_xlsx)


class TestUploadCORS:
    """The bookmarklet uploads directly from the Banner page (cross-origin),
    so /api/upload-schedule must answer with CORS headers — on errors too,
    or the bookmarklet can't read a 401 to know the password was wrong."""

    BANNER_ORIGIN = "https://generalssb-prod.ec.njit.edu"

    def test_preflight_options_allowed(self, client):
        resp = client.options("/api/upload-schedule")
        assert resp.status_code in (200, 204)
        assert resp.headers.get("Access-Control-Allow-Origin") == self.BANNER_ORIGIN
        assert "POST" in resp.headers.get("Access-Control-Allow-Methods", "")

    def test_post_response_has_cors_header(self, client, tmp_path, monkeypatch):
        monkeypatch.setattr("app.UPLOAD_FOLDER", str(tmp_path))
        good_csv = io.BytesIO(
            b"Term,Course,Days,Times,Location,Max,Delivery Mode\n"
            b"202650,CS 113,MW,1:00 PM - 2:20 PM,KUPF 207,40,Face-to-Face\n"
        )
        resp = client.post(
            "/api/upload-schedule",
            data={"file": (good_csv, "Course_Schedule_202650.csv")},
            content_type="multipart/form-data",
        )
        assert resp.status_code == 200
        assert resp.headers.get("Access-Control-Allow-Origin") == self.BANNER_ORIGIN

    def test_error_response_has_cors_header(self, client, monkeypatch):
        monkeypatch.setenv("UPLOAD_PASSWORD", "secret")
        resp = client.post(
            "/api/upload-schedule",
            data={"password": "wrong"},
            content_type="multipart/form-data",
        )
        assert resp.status_code == 401
        assert resp.headers.get("Access-Control-Allow-Origin") == self.BANNER_ORIGIN

    def test_other_endpoints_not_cors_enabled(self, client):
        with patch("app.get_current_time", return_value=(0, time(12, 0))):
            resp = client.get("/api/rooms")
        assert "Access-Control-Allow-Origin" not in resp.headers


class TestRoomScheduleCourseInfo:
    """Update: room detail timeline should say what class is in the room."""

    def test_classes_include_course_title_instructor(self):
        schedule = [
            {'building': 'KUPF', 'room': '207', 'days': [0],
             'time_start': time(9, 0), 'time_end': time(10, 0),
             'course': 'CS 113', 'title': 'Intro to Computer Science',
             'instructor': 'Smith John'},
        ]
        app = create_app(schedule=schedule)
        app.config['TESTING'] = True
        client = app.test_client()
        resp = client.get('/api/room/schedule?building=KUPF&room=207&_weekday=0&at=09:30')
        assert resp.status_code == 200
        cls = resp.get_json()['classes'][0]
        assert cls['course'] == 'CS 113'
        assert cls['title'] == 'Intro to Computer Science'
        assert cls['instructor'] == 'Smith John'

    def test_classes_tolerate_missing_course_fields(self):
        # Entries loaded before this feature (or passed in tests) lack the keys
        schedule = [
            {'building': 'KUPF', 'room': '207', 'days': [0],
             'time_start': time(9, 0), 'time_end': time(10, 0)},
        ]
        app = create_app(schedule=schedule)
        app.config['TESTING'] = True
        client = app.test_client()
        resp = client.get('/api/room/schedule?building=KUPF&room=207&_weekday=0&at=09:30')
        cls = resp.get_json()['classes'][0]
        assert cls['course'] == ''
        assert cls['title'] == ''
        assert cls['instructor'] == ''


class TestNextFreeWindowBackToBack:
    """Bug 5: back-to-back classes produced a zero-minute 'free window'."""

    @pytest.fixture
    def b2b_client(self):
        schedule = [
            {'building': 'KUPF', 'room': '207', 'days': [0],
             'time_start': time(9, 0), 'time_end': time(10, 0)},
            {'building': 'KUPF', 'room': '207', 'days': [0],
             'time_start': time(10, 0), 'time_end': time(11, 0)},
            {'building': 'KUPF', 'room': '207', 'days': [0],
             'time_start': time(13, 0), 'time_end': time(14, 0)},
        ]
        app = create_app(schedule=schedule)
        app.config['TESTING'] = True
        return app.test_client()

    def test_skips_zero_minute_gap(self, b2b_client):
        # At 9:30 (inside first class), next class is back-to-back at 10:00.
        # The real next free window is 11:00–1:00, not a 0-minute gap at 10:00.
        resp = b2b_client.get('/api/room/schedule?building=KUPF&room=207&_weekday=0&at=09:30')
        assert resp.status_code == 200
        data = resp.get_json()
        assert data['next_free_window'] == {'start': '11:00 AM', 'end': '1:00 PM', 'duration_mins': 120}

    def test_inside_last_class_returns_none(self, b2b_client):
        # At 1:30 (inside the final class) — free for the rest of the day after it
        resp = b2b_client.get('/api/room/schedule?building=KUPF&room=207&_weekday=0&at=13:30')
        data = resp.get_json()
        assert data['next_free_window'] is None
