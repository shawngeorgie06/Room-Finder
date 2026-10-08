import pytest
from app import create_app

AUTH = {"Authorization": "Bearer test-export-secret"}

CSV_BODY = (
    "Term,Course,Days,Times,Location,Max,Delivery Mode\n"
    "202650,CS 113,MW,1:00 PM - 2:20 PM,KUPF 207,40,Face-to-Face\n"
)


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr("app.UPLOAD_FOLDER", str(tmp_path))
    monkeypatch.setenv("UPLOAD_PASSWORD", "test-export-secret")
    (tmp_path / "uploaded_schedule_202650.csv").write_text(CSV_BODY)
    (tmp_path / "Course_Schedule_202690.csv").write_text(CSV_BODY.replace("202650", "202690"))
    app = create_app(schedule=[])
    app.config["TESTING"] = True
    return app.test_client()


class TestExportSchedule:
    def test_returns_stored_upload(self, client):
        resp = client.get("/api/export-schedule?term=202650", headers=AUTH)
        assert resp.status_code == 200
        assert b"CS 113" in resp.data
        assert "attachment" in resp.headers.get("Content-Disposition", "")

    def test_falls_back_to_bundled_export(self, client):
        resp = client.get("/api/export-schedule?term=202690", headers=AUTH)
        assert resp.status_code == 200
        assert b"202690" in resp.data

    def test_unknown_term_404(self, client):
        resp = client.get("/api/export-schedule?term=209990", headers=AUTH)
        assert resp.status_code == 404

    def test_missing_term_400(self, client):
        assert client.get("/api/export-schedule", headers=AUTH).status_code == 400

    @pytest.mark.parametrize("term", ["\u00b2", "\u00bd", "\u0663", "2026 50", "9" * 40])
    def test_non_decimal_or_oversized_term_is_rejected_not_a_server_error(self, client, term):
        """str.isdigit() admits Unicode digits int() cannot parse, and unbounded
        terms are echoed back in the 404 body."""
        client.application.config["TESTING"] = False
        resp = client.get("/api/export-schedule", query_string={"term": term}, headers=AUTH)
        assert resp.status_code == 400
        assert term not in resp.get_json()["error"]
        assert resp.headers["Cache-Control"] == "no-store"

    def test_password_requires_authorization_header(self, client):
        assert client.get("/api/export-schedule?term=202650").status_code == 401
        assert client.get("/api/export-schedule?term=202650&password=test-export-secret").status_code == 401
        ok = client.get("/api/export-schedule?term=202650", headers=AUTH)
        assert ok.status_code == 200
        assert ok.headers['Cache-Control'] == 'no-store'


class TestTermsListing:
    def test_lists_stored_terms(self, client):
        resp = client.get("/api/terms")
        assert resp.status_code == 200
        terms = {t["term"]: t for t in resp.get_json()}
        assert 202650 in terms and 202690 in terms
        assert terms[202650]["source"] == "uploaded"
        assert terms[202690]["source"] == "bundled"
