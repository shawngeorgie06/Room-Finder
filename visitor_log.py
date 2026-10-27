"""Small, dependency-free visitor log backed by SQLite.

Only visits to the app shell are recorded. IP addresses are irreversibly hashed
before storage; the browser cookie is a random identifier, not an identity.
"""

import hashlib
import os
import re
import sqlite3
import uuid
from urllib.parse import urlsplit, urlunsplit
from contextlib import closing
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo


RETENTION_DAYS = 90


def normalize_visitor_id(value):
    """Accept only the bounded lowercase hex identifiers this app issues."""
    if isinstance(value, str) and re.fullmatch(r'[0-9a-f]{32}', value):
        return value
    return uuid.uuid4().hex


def _redact_referrer(value):
    """Persist only an HTTP(S) origin/path, never userinfo, query or fragment."""
    try:
        parsed = urlsplit(value)
        if parsed.scheme not in ('http', 'https') or not parsed.hostname:
            return ''
        # Reject malformed ports/authorities as well as browser backslash URLs.
        if parsed.port is not None and not 0 < parsed.port <= 65535:
            return ''
        if '\\' in parsed.netloc:
            return ''
        return urlunsplit((parsed.scheme, parsed.netloc.rsplit('@', 1)[-1],
                           parsed.path, '', ''))[:1000]
    except ValueError:
        return ''


def _prune_expired(db, now):
    cutoff = (now - timedelta(days=RETENTION_DAYS)).isoformat()
    db.execute("DELETE FROM visits WHERE visited_at < ?", (cutoff,))


def connect(path):
    folder = os.path.dirname(path)
    if folder:
        os.makedirs(folder, exist_ok=True)
    db = sqlite3.connect(path, timeout=10)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA journal_mode=WAL")
    db.execute(
        """CREATE TABLE IF NOT EXISTS visits (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            visitor_id TEXT NOT NULL,
            visited_at TEXT NOT NULL,
            ip_hash TEXT NOT NULL,
            user_agent TEXT NOT NULL,
            referrer TEXT NOT NULL
        )"""
    )
    db.execute("CREATE INDEX IF NOT EXISTS idx_visits_time ON visits(visited_at DESC)")
    db.execute("CREATE INDEX IF NOT EXISTS idx_visits_visitor ON visits(visitor_id)")
    return db


def record_visit(path, visitor_id, ip_address, user_agent, referrer, salt):
    """Record one page open and prune entries beyond the retention window."""
    now = datetime.now(timezone.utc)
    ip_hash = hashlib.sha256(f"{salt}:{ip_address}".encode()).hexdigest()[:12]
    with closing(connect(path)) as db:
        with db:
            db.execute(
                "INSERT INTO visits(visitor_id, visited_at, ip_hash, user_agent, referrer) "
                "VALUES (?, ?, ?, ?, ?)",
                (normalize_visitor_id(visitor_id), now.isoformat(), ip_hash,
                 user_agent[:500], _redact_referrer(referrer)),
            )
            _prune_expired(db, now)


def get_visits(path, limit=500):
    """Prune expired visits, then return retained visits and summary statistics."""
    limit = max(1, min(int(limit), 2000))
    eastern_midnight = datetime.now(ZoneInfo('America/New_York')).replace(
        hour=0, minute=0, second=0, microsecond=0
    ).astimezone(timezone.utc).isoformat()
    with closing(connect(path)) as db:
        with db:
            _prune_expired(db, datetime.now(timezone.utc))
        visits = db.execute(
            """SELECT visitor_id, visited_at, ip_hash, user_agent, referrer
               FROM visits ORDER BY visited_at DESC LIMIT ?""",
            (limit,),
        ).fetchall()
        summary = db.execute(
            """SELECT COUNT(*) AS visits,
                      COUNT(DISTINCT visitor_id) AS visitors,
                      COUNT(DISTINCT CASE WHEN visited_at >= ? THEN visitor_id END) AS visitors_today
               FROM visits""",
            (eastern_midnight,),
        ).fetchone()
    return [dict(row) for row in visits], dict(summary)
