import pytest
from datetime import date, time
from app import (create_app, _expected_term, _is_stale, _schedule_status,
                 _default_schedule_candidates, _term_from_entries, _in_session)

GOOD_CSV = (
    "Term,Course,Title,Days,Times,Location,Max,Instructor,Delivery Mode\n"
    "202610,CS 113,Intro CS,MW,1:00 PM - 2:20 PM,KUPF 207,40,Smith,Face-to-Face\n"
)
# Mirrors a real partial bookmarklet export: course codes only, no schedule data
JUNK_CSV = "Term,Course,Title,Days,Times,Location,Max,Instructor,Delivery Mode\n,ACCT 615,,,,,,,\n"


class TestExpectedTerm:
    def test_june_is_summer(self):
        assert _expected_term(date(2026, 6, 11)) == 202650

    def test_february_is_spring(self):
        assert _expected_term(date(2026, 2, 1)) == 202610

    def test_october_is_fall(self):
        assert _expected_term(date(2025, 10, 1)) == 202590

    def test_december_is_fall(self):
        assert _expected_term(date(2025, 12, 20)) == 202590


class TestIsStale:
    def test_matching_term_is_fresh(self):
        assert _is_stale(202650, date(2026, 6, 11)) is False

    def test_old_term_is_stale(self):
        assert _is_stale(202610, date(2026, 6, 11)) is True

    def test_unknown_term_is_none(self):
        assert _is_stale(None, date(2026, 6, 11)) is None

    def test_future_term_is_not_stale(self):
        # Fall 2026 data uploaded during Summer 2026 is ahead, not outdated
        assert _is_stale(202690, date(2026, 6, 11)) is False


class TestInSession:
    """Approximate NJIT session windows: Spring Jan 15–May 15,
    Summer May 15–Aug 15, Fall Sep 1–Dec 23."""

    def test_summer_in_june(self):
        assert _in_session(202650, date(2026, 6, 11)) is True

    def test_fall_not_started_in_june(self):
        assert _in_session(202690, date(2026, 6, 11)) is False

    def test_fall_in_october(self):
        assert _in_session(202690, date(2026, 10, 1)) is True

    def test_fall_over_during_winter_break(self):
        assert _in_session(202690, date(2026, 12, 28)) is False

    def test_spring_in_february(self):
        assert _in_session(202610, date(2026, 2, 1)) is True

    def test_spring_before_classes_start(self):
        assert _in_session(202610, date(2026, 1, 5)) is False

    def test_unknown_term_is_none(self):
        assert _in_session(None, date(2026, 6, 11)) is None


class TestTermFromEntries:
    def test_most_common_term_wins(self):
        entries = [{'term': '202650'}, {'term': '202650'}, {'term': '202610'}]
        assert _term_from_entries(entries) == 202650

    def test_missing_or_blank_terms_return_none(self):
        assert _term_from_entries([{'term': ''}, {}]) is None
        assert _term_from_entries([]) is None


class TestDefaultScheduleCandidates:
    TODAY = date(2026, 6, 11)  # Summer 2026 → expected term 202650

    def test_legacy_upload_wins(self, tmp_path):
        (tmp_path / "uploaded_schedule.csv").write_text("x")
        (tmp_path / "Course_Schedule_202650.csv").write_text("x")
        assert _default_schedule_candidates(str(tmp_path), self.TODAY)[0] == "uploaded_schedule.csv"

    def test_current_term_first_then_past_then_default(self, tmp_path):
        (tmp_path / "Course_Schedule_202610.csv").write_text("x")
        (tmp_path / "Course_Schedule_202650.csv").write_text("x")
        (tmp_path / "schedule_default.csv").write_text("x")
        assert _default_schedule_candidates(str(tmp_path), self.TODAY) == [
            "Course_Schedule_202650.csv",
            "Course_Schedule_202610.csv",
            "schedule_default.csv",
        ]

    def test_future_term_preferred_over_past(self, tmp_path):
        # No current-term file: fall (future) should beat spring (past)
        (tmp_path / "Course_Schedule_202610.csv").write_text("x")
        (tmp_path / "uploaded_schedule_202690.csv").write_text("x")
        assert _default_schedule_candidates(str(tmp_path), self.TODAY) == [
            "uploaded_schedule_202690.csv",
            "Course_Schedule_202610.csv",
        ]

    def test_upload_preferred_over_export_for_same_term(self, tmp_path):
        (tmp_path / "Course_Schedule_202650.csv").write_text("x")
        (tmp_path / "uploaded_schedule_202650.csv").write_text("x")
        assert _default_schedule_candidates(str(tmp_path), self.TODAY)[0] == "uploaded_schedule_202650.csv"

    def test_falls_back_to_default(self, tmp_path):
        (tmp_path / "schedule_default.csv").write_text("x")
        assert _default_schedule_candidates(str(tmp_path), self.TODAY) == ["schedule_default.csv"]

    def test_empty_folder_returns_empty_list(self, tmp_path):
        assert _default_schedule_candidates(str(tmp_path), self.TODAY) == []


class TestScheduleStatus:
    TODAY = date(2026, 6, 11)

    def test_current(self):
        assert _schedule_status(202650, self.TODAY) == 'current'

    def test_stale(self):
        assert _schedule_status(202610, self.TODAY) == 'stale'

    def test_future(self):
        assert _schedule_status(202690, self.TODAY) == 'future'

    def test_unknown(self):
        assert _schedule_status(None, self.TODAY) == 'unknown'


class TestMultiTermUpload:
    def _client(self, tmp_path, monkeypatch):
        monkeypatch.setattr("app.UPLOAD_FOLDER", str(tmp_path))
        app = create_app(schedule=[])
        app.config['TESTING'] = True
        return app.test_client()

    def _post(self, client, body, name="export.csv"):
        import io
        return client.post(
            "/api/upload-schedule",
            data={"file": (io.BytesIO(body.encode()), name)},
            content_type="multipart/form-data",
        )

    def test_upload_saved_with_term_suffix(self, tmp_path, monkeypatch):
        client = self._client(tmp_path, monkeypatch)
        fall = GOOD_CSV.replace("202610", "202690")
        resp = self._post(client, fall)
        assert resp.status_code == 200
        assert (tmp_path / "uploaded_schedule_202690.csv").exists()

    def test_uploads_for_different_terms_coexist(self, tmp_path, monkeypatch):
        client = self._client(tmp_path, monkeypatch)
        self._post(client, GOOD_CSV)  # spring 202610
        self._post(client, GOOD_CSV.replace("202610", "202690"))  # fall
        assert (tmp_path / "uploaded_schedule_202610.csv").exists()
        assert (tmp_path / "uploaded_schedule_202690.csv").exists()

    def test_best_term_activated_after_upload(self, tmp_path, monkeypatch):
        # Upload fall first, then spring: fall must stay active (it is the
        # current-or-nearest term from June 2026 onward; spring is older).
        client = self._client(tmp_path, monkeypatch)
        self._post(client, GOOD_CSV.replace("202610", "202690"))
        self._post(client, GOOD_CSV)
        info = client.get('/api/schedule-info').get_json()
        assert info['semester'] == 'Fall 2026'

    def test_semester_rollover_switches_active_term(self, tmp_path, monkeypatch):
        # Summer and fall files both on disk; when the semester rolls over,
        # a long-running server must switch to the fall schedule on its own.
        monkeypatch.setattr("app.UPLOAD_FOLDER", str(tmp_path))
        (tmp_path / "uploaded_schedule_202650.csv").write_text(GOOD_CSV.replace("202610", "202650"))
        (tmp_path / "uploaded_schedule_202690.csv").write_text(GOOD_CSV.replace("202610", "202690"))
        monkeypatch.setattr("app._expected_term", lambda today: 202650)
        app = create_app()
        app.config['TESTING'] = True
        client = app.test_client()
        assert client.get('/api/schedule-info').get_json()['semester'] == 'Summer 2026'
        # Fall semester begins
        monkeypatch.setattr("app._expected_term", lambda today: 202690)
        assert client.get('/api/schedule-info').get_json()['semester'] == 'Fall 2026'

    def test_schedule_info_includes_status(self, tmp_path, monkeypatch):
        client = self._client(tmp_path, monkeypatch)
        self._post(client, GOOD_CSV)
        info = client.get('/api/schedule-info').get_json()
        assert info['status'] in ('current', 'stale', 'future', 'unknown')


class TestStartupFallback:
    def test_skips_candidate_with_zero_entries(self, tmp_path, monkeypatch):
        # Newest term file is a junk export — startup must fall back to the
        # next candidate instead of booting with an empty schedule.
        monkeypatch.setattr("app.UPLOAD_FOLDER", str(tmp_path))
        (tmp_path / "Course_Schedule_202650.csv").write_text(JUNK_CSV)
        (tmp_path / "schedule_default.csv").write_text(GOOD_CSV)
        app = create_app()
        app.config['TESTING'] = True
        info = app.test_client().get('/api/schedule-info').get_json()
        assert info['entries'] == 1
        assert info['filename'] == 'schedule_default.csv'
        # Semester comes from the Term column in the data, not the filename —
        # so a term-less filename like schedule_default.csv still gets flagged
        assert info['semester'] == 'Spring 2026'
        assert info['stale'] is True


class TestScheduleInfoStaleness:
    def test_schedule_info_has_stale_flag(self):
        schedule = [
            {'building': 'KUPF', 'room': '207', 'days': [0],
             'time_start': time(9, 0), 'time_end': time(10, 0)},
        ]
        app = create_app(schedule=schedule)
        app.config['TESTING'] = True
        resp = app.test_client().get('/api/schedule-info')
        assert resp.status_code == 200
        assert 'stale' in resp.get_json()
        assert 'expected_semester' in resp.get_json()
