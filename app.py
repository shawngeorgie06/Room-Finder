import os
from datetime import datetime
from flask import Flask, jsonify, render_template, request
from schedule import load_schedule, get_empty_rooms


def get_current_time():
    """Returns (weekday_int, time_object). Separate function for testability."""
    now = datetime.now()
    return now.weekday(), now.time()


def create_app(schedule=None):
    app = Flask(__name__)

    if schedule is None:
        xlsx_path = os.path.join(os.path.dirname(__file__), "Course_Schedule_All_Subjects.xlsx")
        schedule = load_schedule(xlsx_path)
        print(f"Loaded {len(schedule)} schedule entries.")

    @app.route("/")
    def index():
        return render_template("index.html")

    @app.route("/api/rooms")
    def rooms():
        weekday, now = get_current_time()
        building = request.args.get("building") or None
        result = get_empty_rooms(schedule, weekday=weekday, now=now, building=building)
        return jsonify(result)

    return app


if __name__ == "__main__":
    application = create_app()
    application.run(debug=True, port=5000)
