"""Journal mode: rollback journal by default, WAL when the desktop app asks.

The Docker image keeps the DB on a host bind mount, where WAL's shared memory
isn't reliable, so WAL is opt-in via COT_DB_JOURNAL_MODE (set by the Mac app).
"""

from __future__ import annotations

import sqlite3
import threading

import pytest

from app import db, store


@pytest.fixture(autouse=True)
def _release_keepalives():
    yield
    store.close_wal_keepalives()


def _mode() -> str:
    with store.read() as conn:
        return conn.execute("PRAGMA journal_mode").fetchone()[0]


def test_default_is_rollback_journal(fresh_db, monkeypatch):
    if store.journal_mode() == "wal":
        pytest.skip("suite is running with COT_DB_JOURNAL_MODE=wal")
    assert _mode() == "delete"
    assert not fresh_db.with_name(fresh_db.name + "-wal").exists()


def test_unknown_mode_falls_back_to_delete(monkeypatch):
    monkeypatch.setenv("COT_DB_JOURNAL_MODE", "memory")
    assert store.journal_mode() == "delete"


def test_wal_when_asked_and_kept_between_requests(fresh_db, monkeypatch):
    monkeypatch.setenv("COT_DB_JOURNAL_MODE", "wal")
    assert _mode() == "wal"
    with store.write() as conn:
        conn.execute("INSERT INTO settings (key, value) VALUES ('k', 'v')")
    # Every request connection is closed, but the -wal file stays: no checkpoint
    # and teardown after each request.
    assert fresh_db.with_name(fresh_db.name + "-wal").exists()
    assert db.get_setting("k") == "v"
    assert db.db_size_bytes() > fresh_db.stat().st_size  # counts -wal/-shm


def test_wal_reads_do_not_wait_for_a_writer(fresh_db, monkeypatch):
    monkeypatch.setenv("COT_DB_JOURNAL_MODE", "wal")
    db.set_setting("k", "before")
    in_write, release = threading.Event(), threading.Event()

    def writer():
        with store.write() as conn:
            conn.execute("UPDATE settings SET value = 'after' WHERE key = 'k'")
            in_write.set()
            release.wait(5)

    t = threading.Thread(target=writer)
    t.start()
    in_write.wait(5)
    try:
        # Rollback-journal mode would block here once the writer commits; WAL
        # serves the last committed value straight away.
        assert db.get_setting("k") == "before"
    finally:
        release.set()
        t.join()
    assert db.get_setting("k") == "after"


def test_switches_back_to_delete_for_a_docker_collector(fresh_db, monkeypatch):
    monkeypatch.setenv("COT_DB_JOURNAL_MODE", "wal")
    db.set_setting("k", "v")
    store.close_wal_keepalives()  # the desktop collector exits
    monkeypatch.delenv("COT_DB_JOURNAL_MODE")
    assert _mode() == "delete"
    assert db.get_setting("k") == "v"  # nothing left behind in the WAL
    assert not fresh_db.with_name(fresh_db.name + "-wal").exists()
    with sqlite3.connect(fresh_db) as raw:
        assert raw.execute("PRAGMA journal_mode").fetchone()[0] == "delete"
