"""SQLite Store: connection lifecycle, write discipline, and Event row shape."""

from __future__ import annotations

import json
import os
import sqlite3
import threading
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from . import timeutil


_write_lock = threading.Lock()

_EVENT_INSERT_SQL = (
    "INSERT INTO events (session_id, source, hook, tool, phase, ts, payload,"
    " category, title, detail, target, status, duration_ms, model,"
    " input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,"
    " attachments, dedup_key, origin, raw_ingest_id, created_at)"
    " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
)


def path() -> Path:
    configured = os.environ.get("COT_DB_PATH")
    if configured:
        return Path(configured)
    return Path.home() / ".cot" / "cot.db"


def _connect() -> sqlite3.Connection:
    db_file = path()
    db_file.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_file, check_same_thread=False, timeout=30.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout=5000;")
    journal_mode = conn.execute("PRAGMA journal_mode;").fetchone()[0]
    if str(journal_mode).lower() != "delete":
        conn.execute("PRAGMA journal_mode=DELETE;")
    conn.execute("PRAGMA foreign_keys=ON;")
    conn.execute("PRAGMA temp_store=MEMORY;")
    return conn


@contextmanager
def read() -> Iterator[sqlite3.Connection]:
    conn = _connect()
    try:
        conn.execute("PRAGMA query_only=ON;")
        yield conn
    finally:
        conn.close()


@contextmanager
def write() -> Iterator[sqlite3.Connection]:
    with _write_lock:
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
    if row["payload"]:
        try:
            body = json.loads(row["payload"])
        except (json.JSONDecodeError, TypeError):
            body = {}
        mode = body.get("composer_mode")
        if isinstance(mode, str) and mode != "agent":
            out["composer_mode"] = mode
    return out
