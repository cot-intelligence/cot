"""Session bookmarks: the flag round-trips and narrows the session list."""

from __future__ import annotations

import sqlite3

import pytest

from app import db, store, timeutil


@pytest.fixture(autouse=True)
def _use_fresh_db(fresh_db):
    return fresh_db


def _session(sid: str, *, archived: int = 0) -> None:
    now = timeutil.now()
    with store.write() as conn:
        conn.execute(
            "INSERT INTO sessions (id, source, cwd, started_at, status, archived, created_at)"
            " VALUES (?, 'claude', '/p', ?, 'active', ?, ?)",
            (sid, now, archived, now),
        )
        store.insert_event(
            conn,
            session_id=sid,
            source="claude",
            hook="UserPromptSubmit",
            phase="instant",
            ts=now,
            category="prompt",
            detail=f"prompt {sid}",
            created_at=now,
        )


def _ids(**kw) -> set[str]:
    return {s["id"] for s in db.list_sessions(**kw)}


def test_bookmark_filter_and_round_trip():
    _session("a")
    _session("b")
    assert db.set_bookmarked("a", True)

    by_id = {s["id"]: s for s in db.list_sessions()}
    assert by_id["a"]["bookmarked"] is True
    assert by_id["b"]["bookmarked"] is False
    assert _ids(bookmarked=True) == {"a"}

    assert db.set_bookmarked("a", False)
    assert _ids(bookmarked=True) == set()


def test_bookmark_survives_archive():
    _session("a")
    db.set_bookmarked("a", True)
    db.set_archived("a", True)
    assert _ids(bookmarked=True) == set()
    assert _ids(bookmarked=True, archived=True) == {"a"}


def test_bookmark_unknown_session():
    assert db.set_bookmarked("missing", True) is False


def test_migration_adds_column_to_old_db(fresh_db):
    with sqlite3.connect(fresh_db) as conn:
        conn.execute("ALTER TABLE sessions DROP COLUMN bookmarked")
    db.init_db()
    _session("a")
    assert db.set_bookmarked("a", True)
    assert _ids(bookmarked=True) == {"a"}
