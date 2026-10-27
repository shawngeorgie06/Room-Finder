"""Disposable browser-test server for local Python 3.12+.

Input is fixture-owned JSON, with ISO time and time-only schedule strings.
Only the actual application factory/routes are served (no fake APIs). The
parent must keep stdin open: EOF shuts down even after the worker is SIGKILLed.
This local test runtime does not establish the production Python version.
"""
import json
import os
from pathlib import Path
import re
import shutil
import signal
import sys
import tempfile
import threading
from datetime import time

from freezegun import freeze_time
from werkzeug.serving import make_server

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))


def owns_directory(directory, token):
    """Never recursively remove arbitrary paths supplied on the command line."""
    marker = directory / '.fixture-owner'
    return (
        not directory.is_symlink()
        and directory.parent.resolve() == Path(tempfile.gettempdir()).resolve()
        and directory.name.startswith('room-finder-browser-')
        and isinstance(token, str)
        and re.fullmatch(r'[0-9a-f]{48}', token) is not None
        and not marker.is_symlink()
        and marker.is_file()
        and marker.read_text() == token
    )


def main():
    config_path = Path(sys.argv[1]).absolute()
    config = json.loads(config_path.read_text())
    directory = config_path.parent
    token = config.get('ownerToken')
    if config_path.name != 'fixture.json' or not owns_directory(directory, token):
        raise ValueError('Refusing a directory that is not fixture-owned')

    def terminate(_signum, _frame):
        raise SystemExit(0)

    def watch_parent():
        # Raw reads avoid holding a buffered-stdin lock during interpreter
        # shutdown if startup fails while the parent is still alive.
        while os.read(sys.stdin.fileno(), 4096):
            pass
        os.kill(os.getpid(), signal.SIGTERM)

    signal.signal(signal.SIGTERM, terminate)
    try:
        threading.Thread(target=watch_parent, daemon=True).start()
        os.environ.update({
            'ADMIN_PASSWORD': config['auth']['adminPassword'],
            'UPLOAD_PASSWORD': config['auth']['uploadPassword'],
            'VISITOR_LOG_SALT': 'disposable-browser-test-salt',
            'VISIT_DB_PATH': str(directory / 'visits.sqlite3'),
            'SCHEDULE_STORAGE_DIR': str(directory),
        })
        # Importing app constructs its gunicorn instance; disable keepalive too.
        os.environ.pop('RENDER_EXTERNAL_URL', None)
        import app as application

        # Keep the legacy fallback until the backend supports the env setting.
        application.UPLOAD_FOLDER = str(directory)
        entries = [{
            **entry,
            'time_start': time.fromisoformat(entry['time_start']),
            'time_end': time.fromisoformat(entry['time_end']),
        } for entry in config['schedule']]
        with freeze_time(config['now']):
            app = application.create_app(schedule=entries, visit_db_path=os.environ['VISIT_DB_PATH'])
            app.config.update(TESTING=True)
            # Atomic OS port allocation. No reloader or child process.
            with make_server('127.0.0.1', 0, app, threaded=True) as server:
                print(json.dumps({'ready': True, 'url': f'http://127.0.0.1:{server.server_port}'}), flush=True)
                server.serve_forever()
    finally:
        if owns_directory(directory, token):
            shutil.rmtree(directory)


if __name__ == '__main__':
    main()
