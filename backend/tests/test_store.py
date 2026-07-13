from __future__ import annotations

import os
import sqlite3
import threading
from pathlib import Path

import pytest

from app import db, store


def _insert_session(conn: sqlite3.Connection, session_id: str) -> None:
    conn.execute(
        "INSERT INTO sessions (id, source, started_at, status, created_at)"
        " VALUES (?, 'codex', '2026-01-01T00:00:00Z', 'active', '2026-01-01T00:00:00Z')",
        (session_id,),
    )


def test_read_is_configured_read_only_and_closes(fresh_db: Path):
    with store.read() as conn:
        row = conn.execute("SELECT id FROM sessions LIMIT 1").fetchone()
        assert row is None
        assert conn.row_factory is sqlite3.Row
        with pytest.raises(sqlite3.OperationalError, match="readonly"):
            conn.execute(
                "INSERT INTO sessions (id, source, started_at, status, created_at)"
                " VALUES ('blocked', 'codex', '', 'active', '')"
            )

    with pytest.raises(sqlite3.ProgrammingError):
        conn.execute("SELECT 1")


def test_read_closes_when_caller_raises(fresh_db: Path):
    conn: sqlite3.Connection | None = None
    with pytest.raises(RuntimeError, match="caller failed"):
        with store.read() as opened:
            conn = opened
            raise RuntimeError("caller failed")

    assert conn is not None
    with pytest.raises(sqlite3.ProgrammingError):
        conn.execute("SELECT 1")


def test_write_commits_and_rolls_back_atomically(fresh_db: Path):
    with store.write() as conn:
        _insert_session(conn, "committed")

    with store.read() as conn:
        assert conn.execute(
            "SELECT 1 FROM sessions WHERE id = 'committed'"
        ).fetchone()

    with pytest.raises(RuntimeError, match="abort"):
        with store.write() as conn:
            _insert_session(conn, "rolled-back")
            conn.execute("CREATE TABLE rolled_back_ddl (id INTEGER PRIMARY KEY)")
            raise RuntimeError("abort")

    with store.read() as conn:
        assert conn.execute(
            "SELECT 1 FROM sessions WHERE id = 'rolled-back'"
        ).fetchone() is None
        assert conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'rolled_back_ddl'"
        ).fetchone() is None

    with pytest.raises(sqlite3.ProgrammingError):
        conn.execute("SELECT 1")


def test_write_serializes_callers_without_timing_assertions(fresh_db: Path):
    first_entered = threading.Event()
    release_first = threading.Event()
    second_attempted = threading.Event()
    second_entered = threading.Event()

    def first_writer() -> None:
        with store.write():
            first_entered.set()
            assert release_first.wait(timeout=5)

    def second_writer() -> None:
        assert first_entered.wait(timeout=5)
        second_attempted.set()
        with store.write():
            second_entered.set()

    first = threading.Thread(target=first_writer)
    second = threading.Thread(target=second_writer)
    first.start()
    second.start()
    assert second_attempted.wait(timeout=5)
    assert not second_entered.is_set()
    release_first.set()
    first.join(timeout=5)
    second.join(timeout=5)
    assert not first.is_alive()
    assert not second.is_alive()
    assert second_entered.is_set()


def test_insert_event_defaults_and_event_row_round_trip(fresh_db: Path):
    with store.write() as conn:
        _insert_session(conn, "s1")
        event_id = store.insert_event(
            conn,
            session_id="s1",
            source="codex",
            category="prompt",
            detail="ship it",
            payload={"composer_mode": "ask", "nested": [1, 2]},
            attachments=[{"name": "spec.md"}],
        )

    with store.read() as conn:
        row = conn.execute("SELECT * FROM events WHERE id = ?", (event_id,)).fetchone()
        event = store.event_row(row)

    assert event == {
        "id": event_id,
        "hook": "unknown",
        "tool": None,
        "phase": "instant",
        "ts": row["ts"],
        "source": "codex",
        "category": "prompt",
        "title": None,
        "detail": "ship it",
        "target": None,
        "status": None,
        "duration_ms": None,
        "model": None,
        "attachments": [{"name": "spec.md"}],
        "composer_mode": "ask",
    }
    assert row["origin"] == "hook"
    assert row["input_tokens"] == 0
    assert row["output_tokens"] == 0
    assert row["cache_read_tokens"] == 0
    assert row["cache_write_tokens"] == 0
    assert row["created_at"]


def test_path_follows_cot_db_path(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    expected = tmp_path / "nested" / "cot.db"
    monkeypatch.setenv("COT_DB_PATH", os.fspath(expected))
    assert store.path() == expected
    assert not expected.parent.exists()
    with store.read():
        pass
    assert expected.parent.is_dir()
