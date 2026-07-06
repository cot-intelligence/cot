"""Raw ingest ledger and drift report contract tests.

Runnable with pytest or directly: ``python3 backend/tests/test_raw_ingest_drift.py``.
"""

from __future__ import annotations

import os
import sys
import tempfile

_HERE = os.path.dirname(os.path.abspath(__file__))
_BACKEND = os.path.dirname(_HERE)
_TMP = tempfile.mkdtemp(prefix="cot-raw-ingest-test-")

sys.path.insert(0, _BACKEND)
os.environ["COT_DB_PATH"] = os.path.join(_TMP, "bootstrap.db")

from app import db  # noqa: E402

_case = 0


def _fresh() -> None:
    global _case
    _case += 1
    os.environ["COT_DB_PATH"] = os.path.join(_TMP, f"case{_case}.db")
    db.init_db()


def test_record_ingest_persists_raw_before_projection_and_ignored_rows():
    _fresh()
    projected = db.record_ingest(
        "claude",
        {
            "hook_event_name": "UserPromptSubmit",
            "session_id": "ledger-s1",
            "cwd": "/repo",
            "timestamp": "2026-07-06T09:00:00Z",
            "prompt": "ship it",
        },
    )
    ignored = db.record_ingest(
        "cursor",
        {
            "hook_event_name": "beforeReadFile",
            "conversation_id": "ledger-s2",
            "timestamp": "2026-07-06T09:01:00Z",
            "path": "/repo/app.py",
            "cursor_version": "1.2.3",
        },
    )

    assert projected["raw_ingest_id"] and projected["event_id"], projected
    assert ignored["raw_status"] == "ignored" and ignored["event_id"] is None, ignored

    rows = db.raw_ingest_events()
    statuses = [row["status"] for row in rows]
    assert statuses == ["projected", "ignored"], rows
    assert rows[0]["event_id"] == projected["event_id"], rows
    assert rows[0]["session_id_guess"] == "ledger-s1", rows

    with db._connect() as conn:
        events = conn.execute(
            "SELECT id, raw_ingest_id, category FROM events ORDER BY id"
        ).fetchall()
    assert len(events) == 1
    assert events[0]["raw_ingest_id"] == projected["raw_ingest_id"]
    assert events[0]["category"] == "prompt"


def test_malformed_raw_input_is_evidence_not_a_timeline_event():
    _fresh()
    result = db.record_malformed_ingest(
        "codex",
        "{not-json",
        origin="hook",
        error="Expecting property name enclosed in double quotes",
    )

    assert result["raw_status"] == "malformed"
    assert result["event_id"] is None
    rows = db.raw_ingest_events()
    assert len(rows) == 1, rows
    assert rows[0]["source"] == "codex"
    assert rows[0]["status"] == "malformed"
    assert "Expecting property name" in rows[0]["projection_error"]

    with db._connect() as conn:
        assert conn.execute("SELECT COUNT(*) n FROM events").fetchone()["n"] == 0


def test_drift_report_groups_weekly_unknown_rates_and_raw_status_counts():
    _fresh()
    db.record_ingest(
        "claude",
        {
            "hook_event_name": "PostToolUse",
            "session_id": "drift-s1",
            "timestamp": "2026-06-29T10:00:00Z",
            "tool_name": "BrandNewTool",
            "tool_input": {"value": "x"},
        },
    )
    db.record_ingest(
        "claude",
        {
            "hook_event_name": "UserPromptSubmit",
            "session_id": "drift-s1",
            "timestamp": "2026-06-29T10:01:00Z",
            "prompt": "hello",
        },
    )
    db.record_ingest(
        "cursor",
        {
            "hook_event_name": "beforeReadFile",
            "conversation_id": "drift-s2",
            "timestamp": "2026-06-29T10:02:00Z",
            "path": "/repo/app.py",
            "cursor_version": "1.2.3",
        },
    )

    report = db.drift_report()
    claude = [
        row for row in report["weeks"]
        if row["source"] == "claude" and row["period_start"] == "2026-06-29"
    ][0]
    assert claude["total_events"] == 2, claude
    assert claude["other_events"] == 1, claude
    assert claude["other_rate"] == 0.5, claude
    assert claude["top_unknown_tools"] == [{"tool": "BrandNewTool", "events": 1}], claude
    assert claude["raw_status_counts"]["projected"] == 2, claude

    cursor = [
        row for row in report["weeks"]
        if row["source"] == "cursor" and row["period_start"] == "2026-06-29"
    ][0]
    assert cursor["total_events"] == 0, cursor
    assert cursor["raw_status_counts"]["ignored"] == 1, cursor


if __name__ == "__main__":
    failures = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"ok   {name}")
            except AssertionError as exc:
                failures += 1
                print(f"FAIL {name}: {exc}")
    sys.exit(1 if failures else 0)
