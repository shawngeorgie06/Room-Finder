"""Single-worker schedule publication, without migrating or deleting legacy data.

Original bytes live in immutable, uniquely named files. Only records referenced by
an atomically replaced manifest are published. A failed transaction cleans its own
staging/payload files, never a previous revision. Callers serialize prepare/commit
and snapshot activation with their process-local lock; this is not multiworker DB
coordination. Legacy files remain readable through the application's candidate list.
"""
from dataclasses import dataclass
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import tempfile
from uuid import uuid4

MANIFEST_NAME = '.schedule-manifest.json'
MAX_MANIFEST_BYTES = 1024 * 1024


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec='microseconds')


@dataclass(frozen=True)
class StoredSchedule:
    filename: str
    path: str
    term: int | None = None
    version: str | None = None
    imported_at: str | None = None
    source_filename: str | None = None
    source_exported_at: str | None = None


def _timestamp(value):
    if not isinstance(value, str):
        raise ValueError('Invalid schedule provenance timestamp')
    parsed = datetime.fromisoformat(value)
    if parsed.utcoffset() != timezone.utc.utcoffset(parsed):
        raise ValueError('Schedule provenance timestamps must be explicit UTC')
    return value


def published_records(folder):
    """Read committed records only; malformed manifests are explicit failures."""
    folder = Path(folder)
    manifest = folder / MANIFEST_NAME
    try:
        size = manifest.stat().st_size
    except FileNotFoundError:
        return {}
    if size > MAX_MANIFEST_BYTES:
        raise ValueError('Schedule manifest exceeds size limit')
    with manifest.open(encoding='utf-8') as stream:
        try:
            document = json.load(stream)
        except RecursionError as error:
            raise ValueError('Schedule manifest exceeds JSON nesting limit') from error
    if not isinstance(document, dict) or document.get('schema_version') != 1 or not isinstance(document.get('records'), dict):
        raise ValueError('Invalid schedule manifest')
    result = {}
    for key, value in document['records'].items():
        if not isinstance(value, dict):
            raise ValueError('Invalid published schedule record')
        term = value.get('term')
        if term is not None and (type(term) is not int or not re.fullmatch(r'[1-9][0-9]{3}(10|30|50|90)', str(term))):
            raise ValueError('Invalid published schedule term')
        expected_key = str(term) if term else 'unknown'
        payload = value.get('payload', '')
        if key != expected_key or not isinstance(payload, str) or not re.fullmatch(r'\.schedule-data-[a-f0-9]{32}\.(csv|xlsx)', payload):
            raise ValueError('Invalid published schedule path')
        version = value.get('version', '')
        if not isinstance(version, str) or not re.fullmatch(r'[a-f0-9]{64}', version):
            raise ValueError('Invalid published schedule version')
        source = value.get('source_filename')
        if not isinstance(source, str) or not source or len(source) > 255 or any(ord(ch) < 32 for ch in source):
            raise ValueError('Invalid published source filename')
        imported = _timestamp(value.get('imported_at'))
        suffix = Path(payload).suffix
        filename = f'uploaded_schedule_{term}{suffix}' if term else f'uploaded_schedule{suffix}'
        result[filename] = StoredSchedule(filename, str(folder / payload), term, version, imported, source)
    return result


@dataclass
class PreparedPublication:
    record: StoredSchedule
    staged_path: str
    document: dict


class ScheduleStore:
    def __init__(self, folder):
        self.folder = Path(folder)

    def stage(self, upload, suffix):
        """Create storage only for an authorized upload, and clean failed saves."""
        self.folder.mkdir(parents=True, exist_ok=True)
        fd, path = tempfile.mkstemp(prefix='.schedule-stage-', suffix=suffix, dir=self.folder)
        os.close(fd)
        try:
            upload.save(path)
            with open(path, 'rb') as stream:
                os.fsync(stream.fileno())
            return path
        except BaseException:
            Path(path).unlink(missing_ok=True)
            raise

    def prepare(self, staged_path, term, source_filename, version):
        records = published_records(self.folder)
        suffix = Path(staged_path).suffix
        filename = f'uploaded_schedule_{term}{suffix}' if term else f'uploaded_schedule{suffix}'
        record = StoredSchedule(filename, str(self.folder / f'.schedule-data-{uuid4().hex}{suffix}'),
                                term, version, utc_now(), source_filename)
        # A same-term replacement supersedes the manifest pointer, not old bytes.
        records = {name: old for name, old in records.items() if old.term != term}
        records[filename] = record
        document = {'schema_version': 1, 'records': {
            str(item.term) if item.term else 'unknown': {
                'term': item.term, 'payload': Path(item.path).name,
                'version': item.version, 'imported_at': item.imported_at,
                'source_filename': item.source_filename, 'source_exported_at': None,
            } for item in records.values()
        }}
        return PreparedPublication(record, staged_path, document)

    def commit(self, publication):
        """One manifest replacement commits bytes and provenance together."""
        fd, manifest_tmp = tempfile.mkstemp(prefix='.schedule-manifest-stage-', suffix='.json', dir=self.folder)
        moved_payload = False
        try:
            with os.fdopen(fd, 'w', encoding='utf-8') as stream:
                json.dump(publication.document, stream, separators=(',', ':'), sort_keys=True)
                if stream.tell() > MAX_MANIFEST_BYTES:
                    raise ValueError('Schedule manifest exceeds size limit')
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(publication.staged_path, publication.record.path)
            moved_payload = True
            # Make the immutable payload's directory entry durable before any
            # manifest can reference it. A sync failure is still pre-commit.
            directory_fd = os.open(self.folder, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0))
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
            os.replace(manifest_tmp, self.folder / MANIFEST_NAME)
            # Nothing fallible after the commit point: caller swaps prepared state.
        except BaseException:
            Path(manifest_tmp).unlink(missing_ok=True)
            if moved_payload:
                Path(publication.record.path).unlink(missing_ok=True)
            raise
