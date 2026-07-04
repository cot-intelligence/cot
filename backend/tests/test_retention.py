"""Tests for retention: age-based cleanup, disk reclamation via VACUUM, and the
DB-size figure the dashboard uses to nudge users toward enabling a policy.

Runnable with pytest or directly: ``python3 backend/tests/test_retention.py``.
"""

from __future__ import annotations

import os
import sys
import tempfile
from datetime import datetime, timedelta, timezone

_HERE = os.path.dirname(os.path.abspath(__file__))
_BACKEND = os.path.dirname(_HERE)
_TMP = tempfile.mkdtemp(prefix="cot-retention-test-")

sys.path.insert(0, _BACKEND)
os.environ["COT_DB_PATH"] = os.path.join(_TMP, "bootstrap.db")

from app import db  # noqa: E402

_NOW = datetime.now(timezone.utc)
_case = 0


def _ts(days_ago: float) -> str:
    return (_NOW - timedelta(days=days_ago)).isoformat()


def _fresh_db() -> None:
    global _case
    _case += 1
    os.environ["COT_DB_PATH"] = os.path.join(_TMP, f"case{_case}.db")
    db.init_db()


def _session_with_event(sid: str, *, days_ago: float, pad: int = 0) -> None:
    with db._connect() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO sessions (id, source, cwd, started_at, status,"
            " archived, created_at) VALUES (?, 'claude', '/proj', ?, 'active', 0, ?)",
            (sid, _ts(days_ago), db._now()),
        )
        conn.execute(
            "INSERT INTO events (session_id, source, hook, phase, ts, payload, category,"
            " dedup_key, origin, created_at)"
            " VALUES (?, 'claude', 'PostToolUse', 'end', ?, ?, 'shell', ?, 'hook', ?)",
            (sid, _ts(days_ago), "x" * pad, f"dk-{sid}", db._now()),
        )


def test_status_reports_db_size():
    _fresh_db()
    _session_with_event("s1", days_ago=1)
    status = db.retention_status()
    assert "db_size_bytes" in status
    assert status["db_size_bytes"] > 0


def test_cleanup_deletes_only_aged_sessions():
    _fresh_db()
    _session_with_event("old", days_ago=90)
    _session_with_event("recent", days_ago=1)
    db.set_retention_policy(enabled=True, days=30)

    result = db.cleanup_retention(dry_run=False)
    assert result["deleted_sessions"] == 1
    with db._connect() as conn:
        ids = {r["id"] for r in conn.execute("SELECT id FROM sessions").fetchall()}
    assert ids == {"recent"}


def test_disabled_policy_deletes_nothing_but_previews():
    _fresh_db()
    _session_with_event("old", days_ago=90)
    # Policy disabled by default: cleanup is a no-op...
    result = db.cleanup_retention(dry_run=False)
    assert result["deleted_sessions"] == 0
    # ...but status still previews what a policy *would* remove, for the UI nudge.
    assert db.retention_status()["preview_sessions"] == 1
    with db._connect() as conn:
        count = conn.execute("SELECT COUNT(*) AS c FROM sessions").fetchone()["c"]
    assert count == 1


def test_vacuum_reclaims_disk_after_delete():
    _fresh_db()
    # A few fat old sessions so the freed pages are measurable after VACUUM.
    for i in range(20):
        _session_with_event(f"old{i}", days_ago=90, pad=50_000)
    _session_with_event("recent", days_ago=1)
    db.set_retention_policy(enabled=True, days=30)

    before = db.db_size_bytes()
    result = db.cleanup_retention(dry_run=False)
    after = db.db_size_bytes()

    assert result["deleted_sessions"] == 20
    assert result["reclaimed_bytes"] > 0
    assert after < before


def test_dry_run_never_deletes_or_vacuums():
    _fresh_db()
    _session_with_event("old", days_ago=90)
    db.set_retention_policy(enabled=True, days=30)

    result = db.cleanup_retention(dry_run=True)
    assert result["deleted_sessions"] == 0
    assert result["reclaimed_bytes"] == 0
    assert result["eligible_sessions"] == 1
    with db._connect() as conn:
        count = conn.execute("SELECT COUNT(*) AS c FROM sessions").fetchone()["c"]
    assert count == 1


def _run_all():
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in fns:
        fn()
        print(f"ok  {fn.__name__}")
    print(f"\n{len(fns)} passed")


if __name__ == "__main__":
    _run_all()
