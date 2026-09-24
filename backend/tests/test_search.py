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


def _set(sql: str, *params) -> None:
    with store.write() as conn:
        conn.execute(sql, params)


def test_prefix_of_a_word_matches():
    _prompt("s", "run the database migration", minutes_ago=1)
    assert len(db.search("migra")) == 1


def test_stronger_match_ranks_first_regardless_of_order():
    _prompt("s", "the auth token was refreshed", minutes_ago=1)
    _prompt("s", "auth auth auth: the auth module rewrite", minutes_ago=2)
    results = db.search("auth")
    assert results[0]["snippet"].startswith("auth auth auth")


def test_recency_breaks_ties_between_equal_matches():
    _prompt("old", "deploy the service", minutes_ago=60 * 24 * 30)
    _prompt("new", "deploy the service", minutes_ago=1)
    assert [r["session_id"] for r in db.search("deploy")] == ["new", "old"]


def test_index_follows_updates_and_deletes():
    _prompt("s", "original wording", minutes_ago=1)
    _set("UPDATE events SET detail = 'rewritten phrasing' WHERE session_id = 's'")
    assert db.search("original") == []
    assert len(db.search("rewritten")) == 1
    _set("DELETE FROM events WHERE session_id = 's'")
    assert db.search("rewritten") == []


def test_existing_rows_are_indexed_when_the_index_is_first_built():
    # Rows written before the index existed (an upgrade) must become searchable.
    with store.write() as conn:
        for trigger in ("events_fts_insert", "events_fts_delete", "events_fts_update"):
            conn.execute(f"DROP TRIGGER {trigger}")
        conn.execute("DROP TABLE events_fts")
    _prompt("s", "legacy prompt text", minutes_ago=1)
    db.init_db()
    assert len(db.search("legacy")) == 1


def test_mid_word_text_falls_back_to_a_full_scan():
    _prompt("s", "call scrollRangeIntoView here", minutes_ago=1)
    assert len(db.search("RangeInto")) == 1


def test_quotes_and_operators_in_the_query_are_plain_text():
    _prompt("s", 'grep "NOT found" OR near', minutes_ago=1)
    assert len(db.search('"NOT found" OR')) == 1
    assert len(db.search("NEAR(")) == 1
    assert len(db.search("found*")) == 1
