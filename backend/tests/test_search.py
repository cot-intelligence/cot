"""Search: token matching and per-session scoping."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app import db, store, timeutil

_NOW = datetime.now(timezone.utc)


@pytest.fixture(autouse=True)
def _use_fresh_db(fresh_db):
    return fresh_db


def _prompt(sid: str, text: str, *, minutes_ago: float) -> None:
    ts = (_NOW - timedelta(minutes=minutes_ago)).isoformat()
    with store.write() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO sessions (id, source, cwd, started_at, status, created_at)"
            " VALUES (?, 'claude', '/p', ?, 'active', ?)",
            (sid, ts, timeutil.now()),
        )
        store.insert_event(
            conn,
            session_id=sid,
            source="claude",
            hook="UserPromptSubmit",
            phase="instant",
            ts=ts,
            category="prompt",
            detail=text,
            created_at=timeutil.now(),
        )


def test_scoped_search_is_not_crowded_out_by_newer_sessions():
    # An older session with a few matches, buried under many newer matches.
    for i in range(3):
        _prompt("old", f"run the migration step {i}", minutes_ago=1000 + i)
    for i in range(50):
        _prompt("new", f"another migration note {i}", minutes_ago=i)

    unscoped = db.search("migration", limit=10)
    assert {r["session_id"] for r in unscoped} == {"new"}

    scoped = db.search("migration", limit=10, session_id="old")
    assert len(scoped) == 3
    assert {r["session_id"] for r in scoped} == {"old"}


def test_search_matches_all_terms():
    _prompt("s", "fix the **auth** token refresh", minutes_ago=1)
    _prompt("s", "auth only", minutes_ago=2)

    results = db.search("auth refresh")
    assert [r["snippet"] for r in results] == ["fix the **auth** token refresh"]
