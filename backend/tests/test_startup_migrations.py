"""Startup migrations must fit inside the desktop app's startup window.

Every version bump used to re-run the whole migration chain, which took 18-27s
on a 3GB DB; the desktop app stops a collector that isn't healthy after 15s,
which rolled the migration back and failed every launch. A DB one version
behind now runs only that version's listed steps, and a marker file tells the
app to keep waiting while any migration runs.
"""

from __future__ import annotations

import pytest

from app import db, store


@pytest.fixture(autouse=True)
def _use_fresh_db(fresh_db):
    return fresh_db


def _set_version(value: str) -> None:
    with store.write() as conn:
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('migrations_version', ?)"
            " ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (value,),
        )


def _version() -> str | None:
    with store.read() as conn:
        row = conn.execute("SELECT value FROM settings WHERE key = 'migrations_version'").fetchone()
    return row["value"] if row else None


def _forbid(monkeypatch: pytest.MonkeyPatch, name: str) -> None:
    def boom(conn):
        raise AssertionError(f"{name} should not run on an incremental upgrade")

    monkeypatch.setattr(db, name, boom)


def test_one_version_behind_runs_only_that_versions_steps(monkeypatch):
    current = int(db._MIGRATIONS_VERSION)
    ran: list[str] = []
    monkeypatch.setitem(db._UPGRADES, current, (lambda conn: ran.append("listed"),))
    for name in ("_backfill", "_backfill_cursor_questions", "_recategorize_subagents"):
        _forbid(monkeypatch, name)
    _set_version(str(current - 1))

    db.init_db(build_search_index=False)

    assert ran == ["listed"]
    assert _version() == db._MIGRATIONS_VERSION


def test_a_version_without_listed_steps_runs_the_whole_chain(monkeypatch):
    current = int(db._MIGRATIONS_VERSION)
    ran: list[str] = []
    real = db._backfill
    monkeypatch.setattr(db, "_backfill", lambda conn: (ran.append("chain"), real(conn)))
    # Nothing is listed for the version before the first one in _UPGRADES.
    _set_version(str(min(db._UPGRADES) - 2))

    db.init_db(build_search_index=False)

    assert ran == ["chain"]
    assert _version() == str(current)


def test_current_db_runs_nothing(monkeypatch):
    _forbid(monkeypatch, "_backfill")
    monkeypatch.setitem(db._UPGRADES, int(db._MIGRATIONS_VERSION), ())
    db.init_db(build_search_index=False)
    assert _version() == db._MIGRATIONS_VERSION


def test_marker_exists_only_while_migrating(monkeypatch):
    seen: list[bool] = []
    current = int(db._MIGRATIONS_VERSION)
    monkeypatch.setitem(
        db._UPGRADES, current, (lambda conn: seen.append(db._migration_marker_path().exists()),)
    )
    _set_version(str(current - 1))

    db.init_db(build_search_index=False)

    assert seen == [True]
    assert not db._migration_marker_path().exists()


def test_marker_is_removed_when_a_migration_fails(monkeypatch):
    current = int(db._MIGRATIONS_VERSION)

    def fail(conn):
        raise RuntimeError("boom")

    monkeypatch.setitem(db._UPGRADES, current, (fail,))
    _set_version(str(current - 1))

    with pytest.raises(RuntimeError):
        db.init_db(build_search_index=False)
    assert not db._migration_marker_path().exists()
    # Rolled back: the version did not move, so the next start retries.
    assert _version() == str(current - 1)


@pytest.mark.parametrize("stored", [None, "not-a-number", db._MIGRATIONS_VERSION, "999"])
def test_pending_upgrades_falls_back_or_skips(stored):
    assert db._pending_upgrades(stored) is None
