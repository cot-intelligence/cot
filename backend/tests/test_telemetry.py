from __future__ import annotations

import sqlite3
import threading
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from pathlib import Path
from typing import Any

import pytest

from app import db, main, store


def _session(conn: sqlite3.Connection, session_id: str, started_at: str) -> None:
    conn.execute(
        "INSERT INTO sessions (id, source, started_at, status, created_at)"
        " VALUES (?, 'codex', ?, 'complete', ?)",
        (session_id, started_at, started_at),
    )


def test_telemetry_days_active_uses_installation_window(fresh_db: Path):
    db.set_setting("install_id", "test-install")
    db.set_setting("installed_at", "2026-01-02T00:00:00Z")

    with store.write() as conn:
        _session(conn, "before-install", "2026-01-01T00:00:00Z")
        store.insert_event(
            conn,
            session_id="before-install",
            source="codex",
            category="prompt",
            ts="2026-01-01T12:00:00Z",
        )
        _session(conn, "after-install", "2026-01-03T00:00:00Z")
        store.insert_event(
            conn,
            session_id="after-install",
            source="codex",
            category="response",
            ts="2026-01-03T12:00:00Z",
        )

    metrics = main._telemetry_payload()["metrics"]

    assert metrics["days_active"] == 1
    assert metrics["history_days_active"] == 2


def test_telemetry_days_active_excludes_same_day_events_before_install(
    fresh_db: Path,
):
    db.set_setting("install_id", "test-install")
    db.set_setting("installed_at", "2026-01-02T23:00:00Z")

    with store.write() as conn:
        _session(conn, "same-day-history", "2026-01-02T00:00:00Z")
        store.insert_event(
            conn,
            session_id="same-day-history",
            source="codex",
            category="prompt",
            ts="2026-01-02T01:00:00Z",
        )
        _session(conn, "after-install", "2026-01-03T00:00:00Z")
        store.insert_event(
            conn,
            session_id="after-install",
            source="codex",
            category="response",
            ts="2026-01-03T01:00:00Z",
        )

    metrics = main._telemetry_payload()["metrics"]

    assert metrics["days_active"] == 1
    assert metrics["history_days_active"] == 2


def test_telemetry_model_breakdown_accounts_for_every_event(fresh_db: Path):
    db.set_setting("install_id", "test-install")
    db.set_setting("installed_at", "2026-01-01T00:00:00Z")

    with store.write() as conn:
        _session(conn, "modeled", "2026-01-02T00:00:00Z")
        store.insert_event(
            conn,
            session_id="modeled",
            source="codex",
            category="response",
            model="gpt-5.5",
            ts="2026-01-02T00:00:01Z",
        )
        store.insert_event(
            conn,
            session_id="modeled",
            source="codex",
            category="prompt",
            ts="2026-01-02T00:00:02Z",
        )

    metrics = main._telemetry_payload()["metrics"]

    assert metrics["by_model"] == [
        {"model": "gpt-5.5", "events": 1},
        {"model": "unknown", "events": 1},
    ]
    assert sum(row["events"] for row in metrics["by_model"]) == metrics["events"]


def test_telemetry_category_breakdown_accounts_for_uncategorized_events(
    fresh_db: Path,
):
    db.set_setting("install_id", "test-install")
    db.set_setting("installed_at", "2026-01-01T00:00:00Z")

    with store.write() as conn:
        _session(conn, "uncategorized", "2026-01-02T00:00:00Z")
        store.insert_event(
            conn,
            session_id="uncategorized",
            source="codex",
            category=None,
            ts="2026-01-02T00:00:01Z",
        )

    metrics = main._telemetry_payload()["metrics"]

    assert metrics["by_category"] == [{"category": "unknown", "events": 1}]
    assert sum(row["events"] for row in metrics["by_category"]) == metrics["events"]


def test_telemetry_declares_snapshot_semantics(fresh_db: Path):
    db.set_setting("install_id", "test-install")
    db.set_setting("installed_at", "2026-01-01T00:00:00Z")

    payload = main._telemetry_payload()

    assert payload["schema_version"] == 2
    assert payload["report_kind"] == "current_database_snapshot"


def test_telemetry_uses_one_database_snapshot_during_concurrent_ingest(
    fresh_db: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    db.set_setting("install_id", "test-install")
    db.set_setting("installed_at", "2026-01-01T00:00:00Z")
    with store.write() as conn:
        _session(conn, "concurrent", "2026-01-02T00:00:00Z")
        store.insert_event(
            conn,
            session_id="concurrent",
            source="codex",
            category="prompt",
            ts="2026-01-02T00:00:01Z",
        )

    original_read = store.read
    writer_done = threading.Event()
    writer: threading.Thread | None = None

    def insert_concurrent_event() -> None:
        with store.write() as conn:
            store.insert_event(
                conn,
                session_id="concurrent",
                source="codex",
                category="response",
                model="gpt-5.5",
                ts="2026-01-02T00:00:02Z",
            )
        writer_done.set()

    class InterleavingConnection:
        def __init__(self, conn: sqlite3.Connection) -> None:
            self._conn = conn
            self._interleaved = False

        def execute(
            self,
            sql: str,
            parameters: Sequence[Any] = (),
        ) -> sqlite3.Cursor:
            nonlocal writer
            result = self._conn.execute(sql, parameters)
            if not self._interleaved and sql == "SELECT COUNT(*) n FROM events":
                self._interleaved = True
                writer = threading.Thread(target=insert_concurrent_event)
                writer.start()
                writer_done.wait(timeout=0.25)
            return result

        def __getattr__(self, name: str) -> Any:
            return getattr(self._conn, name)

    @contextmanager
    def interleaved_read() -> Iterator[InterleavingConnection]:
        with original_read() as conn:
            yield InterleavingConnection(conn)

    monkeypatch.setattr(store, "read", interleaved_read)
    metrics = main._telemetry_payload()["metrics"]

    assert writer is not None
    writer.join(timeout=2)
    assert not writer.is_alive()
    assert sum(row["events"] for row in metrics["by_source"]) == metrics["events"]
    assert sum(row["events"] for row in metrics["by_category"]) == metrics["events"]
    assert sum(row["events"] for row in metrics["by_model"]) == metrics["events"]
