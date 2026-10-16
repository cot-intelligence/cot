"""SQLite Store: connection lifecycle, write discipline, and Event row shape."""

from __future__ import annotations

import inspect
import json
import logging
import os
import sqlite3
import threading
import time
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path
from typing import Any

from . import timeutil


_write_lock = threading.Lock()

_EVENT_INSERT_SQL = (
    "INSERT INTO events (session_id, source, hook, tool, phase, ts, payload,"
    " category, title, detail, target, status, duration_ms, model,"
    " input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,"
    " attachments, dedup_key, origin, raw_ingest_id, created_at, composer_mode)"
    " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
)

# Every events column a display read needs: all but ``payload``, the raw hook
# body (the largest column), which reads only used for ``composer_mode`` before
# that had a column of its own.
_EVENT_READ_COLUMNS = (
    "id, session_id, source, hook, tool, phase, ts, category, title, detail, target,"
    " status, duration_ms, model, input_tokens, output_tokens, cache_read_tokens,"
    " cache_write_tokens, attachments, dedup_key, origin, raw_ingest_id, created_at,"
    " composer_mode"
)
# Rows from before the column are filled in by a background backfill; until it
# finishes, reads also fetch ``payload`` and event_row falls back to it.
_composer_backfilled: dict[Path, bool] = {}


def event_columns() -> str:
    """The SELECT list for display reads of events (see event_row)."""
    if _composer_backfilled.get(path()):
        return _EVENT_READ_COLUMNS
    return _EVENT_READ_COLUMNS + ", payload"


def mark_composer_backfilled(done: bool = True) -> None:
    _composer_backfilled[path()] = done


def _composer_mode(payload: Any) -> str | None:
    if isinstance(payload, Mapping):
        mode = payload.get("composer_mode")
    elif isinstance(payload, str) and '"composer_mode"' in payload:
        try:
            body = json.loads(payload)
        except (json.JSONDecodeError, TypeError):
            return None
        mode = body.get("composer_mode") if isinstance(body, dict) else None
    else:
        return None
    return mode if isinstance(mode, str) else None


# The DB file this request (or thread) reads and writes. Unset means the main
# store; Session Replay points it at replay.db so imported sessions never mix
# with traced ones.
_path_override: ContextVar[Path | None] = ContextVar("cot_store_path", default=None)


def main_path() -> Path:
    configured = os.environ.get("COT_DB_PATH")
    if configured:
        return Path(configured)
    return Path.home() / ".cot" / "cot.db"


def replay_path() -> Path:
    """Imported sessions (Session Replay) live beside the main DB, in their own file."""
    return main_path().with_name("replay.db")


def path() -> Path:
    return _path_override.get() or main_path()


@contextmanager
def use(db_file: Path) -> Iterator[None]:
    """Point every read/write in this context at ``db_file``."""
    token = _path_override.set(db_file)
    try:
        yield
    finally:
        _path_override.reset(token)


# Journal mode. The default is the rollback journal ("delete"): the Docker image
# keeps the DB on a host bind mount (~/.cot -> /data), and WAL's shared-memory
# file is not reliable across that boundary (SQLite: WAL does not work over a
# network filesystem). The Mac app runs its collector as a plain local process,
# where WAL is safe, so it sets COT_DB_JOURNAL_MODE=wal (desktop collector.rs):
# readers then never wait for a writer, which is what stalled the dashboard and
# dropped hook events under load. The mode is stored in the file, so whichever
# collector opens it next converts it to its own mode.
_JOURNAL_MODES = ("delete", "wal")


def journal_mode() -> str:
    mode = os.environ.get("COT_DB_JOURNAL_MODE", "delete").strip().lower()
    return mode if mode in _JOURNAL_MODES else "delete"


# In WAL mode SQLite checkpoints and deletes the -wal/-shm files whenever the
# last connection to the DB closes. Connections here are per request, so that
# would happen constantly; one idle connection per DB file, held for the life
# of the process, keeps the WAL in place between requests.
_wal_keepalive: dict[Path, sqlite3.Connection] = {}
_keepalive_lock = threading.Lock()


def _keep_wal_open(db_file: Path) -> None:
    if db_file in _wal_keepalive:
        return
    with _keepalive_lock:
        if db_file not in _wal_keepalive:
            keep = sqlite3.connect(db_file, check_same_thread=False, timeout=30.0)
            # A connection only joins the WAL once it has read something.
            keep.execute("PRAGMA schema_version").fetchone()
            _wal_keepalive[db_file] = keep


def close_wal_keepalives() -> None:
    """Release the idle WAL connections (tests; switching a file back to delete mode)."""
    with _keepalive_lock:
        for conn in _wal_keepalive.values():
            conn.close()
        _wal_keepalive.clear()


_MMAP_BYTES = 512 * 1024 * 1024


def _connect() -> sqlite3.Connection:
    db_file = path()
    db_file.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_file, check_same_thread=False, timeout=30.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout=5000;")
    want = journal_mode()
    current = conn.execute("PRAGMA journal_mode;").fetchone()[0]
    if str(current).lower() != want:
        conn.execute(f"PRAGMA journal_mode={want.upper()};")
    if want == "wal":
        _keep_wal_open(db_file)
        # WAL on a local disk (the Mac app). NORMAL skips the fsync on each
        # commit (only checkpoints sync); a power cut can lose the last commits
        # but never corrupts the file, unlike NORMAL in rollback mode. mmap lets
        # these short-lived connections share the OS page cache instead of each
        # starting with an empty SQLite cache. Neither is safe on Docker's bind
        # mount, so the rollback-journal default keeps both off.
        conn.execute("PRAGMA synchronous=NORMAL;")
        conn.execute(f"PRAGMA mmap_size={_MMAP_BYTES};")
    conn.execute("PRAGMA foreign_keys=ON;")
    conn.execute("PRAGMA temp_store=MEMORY;")
    return conn


# Reads and writes that hold their connection longer than this are logged with
# the calling function, so a regression shows up in the collector log instead of
# as a vaguely slower dashboard. 0 turns it off.
_log = logging.getLogger("uvicorn.error")


def _slow_ms() -> float:
    try:
        return float(os.environ.get("COT_SLOW_QUERY_MS", "100"))
    except ValueError:
        return 100.0


def _log_if_slow(kind: str, started: float, waited_ms: float = 0.0) -> None:
    threshold = _slow_ms()
    held_ms = (time.perf_counter() - started) * 1000
    if threshold <= 0 or held_ms < threshold:
        return
    # Frames: this function, the context manager's generator, contextlib's
    # __exit__, then the caller's ``with`` statement.
    frame = inspect.currentframe()
    for _ in range(3):
        frame = frame.f_back if frame else None
    caller = (
        f"{frame.f_globals.get('__name__', '?')}.{frame.f_code.co_name}:{frame.f_lineno}"
        if frame
        else "?"
    )
    wait = f" after waiting {waited_ms:.0f} ms for the write lock" if waited_ms >= 1 else ""
    _log.warning("slow %s: %.0f ms in %s%s", kind, held_ms, caller, wait)


@contextmanager
def read() -> Iterator[sqlite3.Connection]:
    started = time.perf_counter()
    conn = _connect()
    try:
        conn.execute("PRAGMA query_only=ON;")
        yield conn
    finally:
        conn.close()
        _log_if_slow("read", started)


@contextmanager
def write() -> Iterator[sqlite3.Connection]:
    asked = time.perf_counter()
    with _write_lock:
        started = time.perf_counter()
        conn = _connect()
        try:
            conn.execute("BEGIN IMMEDIATE")
            try:
                yield conn
            except BaseException:
                conn.rollback()
                raise
            else:
                conn.commit()
        finally:
            conn.close()
            _log_if_slow("write", started, (started - asked) * 1000)


def vacuum() -> None:
    """Rebuild the DB file so deletes return space to the OS.

    VACUUM cannot run inside a transaction, so this is a separate primitive
    from :func:`write`.
    """
    with _write_lock:
        conn = _connect()
        try:
            conn.isolation_level = None
            conn.execute("VACUUM")
            if journal_mode() == "wal":
                # In WAL mode the rebuilt pages land in the -wal file; copy them
                # back and truncate it, or the disk space isn't returned.
                conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        finally:
            conn.close()


def _json_value(value: Any) -> Any:
    if isinstance(value, (Mapping, list)):
        return json.dumps(value, ensure_ascii=False, default=str)
    return value


def insert_event(
    conn: sqlite3.Connection,
    *,
    session_id: str,
    source: str,
    hook: str = "unknown",
    tool: str | None = None,
    phase: str = "instant",
    ts: str | None = None,
    payload: Any = None,
    category: str | None = None,
    title: str | None = None,
    detail: str | None = None,
    target: str | None = None,
    status: str | None = None,
    duration_ms: int | None = None,
    model: str | None = None,
    input_tokens: int | None = 0,
    output_tokens: int | None = 0,
    cache_read_tokens: int | None = 0,
    cache_write_tokens: int | None = 0,
    attachments: Any = None,
    dedup_key: str | None = None,
    origin: str = "hook",
    raw_ingest_id: int | None = None,
    created_at: str | None = None,
) -> int:
    cursor = conn.execute(
        _EVENT_INSERT_SQL,
        (
            session_id,
            source,
            hook,
            tool,
            phase,
            ts or timeutil.now(),
            _json_value(payload),
            category,
            title,
            detail,
            target,
            status,
            duration_ms,
            model,
            input_tokens,
            output_tokens,
            cache_read_tokens,
            cache_write_tokens,
            _json_value(attachments),
            dedup_key,
            origin,
            raw_ingest_id,
            created_at or timeutil.now(),
            _composer_mode(payload),
        ),
    )
    return int(cursor.lastrowid)


def event_row(row: sqlite3.Row) -> dict[str, Any]:
    out: dict[str, Any] = {
        "id": row["id"],
        "hook": row["hook"],
        "tool": row["tool"],
        "phase": row["phase"],
        "ts": timeutil.format_ts(row["ts"]),
        "source": row["source"],
        "category": row["category"],
        "title": row["title"],
        "detail": row["detail"],
        "target": row["target"],
        "status": row["status"],
        "duration_ms": row["duration_ms"],
        "model": row["model"],
        "attachments": json.loads(row["attachments"]) if row["attachments"] else None,
    }
    keys = row.keys()
    mode = row["composer_mode"] if "composer_mode" in keys else None
    if mode is None and "payload" in keys:
        mode = _composer_mode(row["payload"])
    if isinstance(mode, str) and mode != "agent":
        out["composer_mode"] = mode
    return out
