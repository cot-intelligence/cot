"""Raw ingest ledger and drift report contract tests.

Run with pytest via ``just check``.
"""

from __future__ import annotations

import pytest

from app import db, store  # noqa: E402


@pytest.fixture(autouse=True)
def _use_fresh_db(fresh_db):
    return fresh_db


def test_record_ingest_persists_raw_before_projection_and_ignored_rows():
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

    with store.read() as conn:
        events = conn.execute(
            "SELECT id, raw_ingest_id, category FROM events ORDER BY id"
        ).fetchall()
    assert len(events) == 1
    assert events[0]["raw_ingest_id"] == projected["raw_ingest_id"]
    assert events[0]["category"] == "prompt"


def test_namespaced_live_event_supersedes_import_and_retry_is_idempotent():
    sid = "reconcile-s1"
    imported = {
        "session_id": sid,
        "hook_event_name": "afterAgentResponse",
        "response": "Imported approximation",
        "_synthetic_category": "response",
        "_import": True,
        "_dedup_key": "/transcript.jsonl:0:resp:0",
        "timestamp": "2026-07-14T12:00:00Z",
    }
    live = {
        "session_id": sid,
        "hook_event_name": "afterAgentResponse",
        "response": "Hook truth",
        "_synthetic_category": "response",
        "_dedup_key": "live:cursor:0:resp:0",
        "timestamp": "2026-07-14T12:00:01Z",
    }

    assert db.record_ingest("cursor", imported)["raw_status"] == "projected"
    assert db.record_ingest("cursor", live)["raw_status"] == "projected"
    assert db.record_ingest("cursor", live)["raw_status"] == "duplicate"

    detail = db.get_session_detail(sid)
    assert detail is not None
    responses = [
        event["detail"] for event in detail["events"]
        if event["category"] == "response"
    ]
    assert responses == ["Hook truth"]
    assert db.session_origins()[sid] == "hook"


def test_claude_stop_ends_turn_session_end_closes_and_session_start_reopens():
    sid = "claude-desktop-lifecycle"
    db.record_ingest(
        "claude",
        {
            "hook_event_name": "SessionStart",
            "session_id": sid,
            "cwd": "/repo",
            "timestamp": "2026-07-16T03:20:29Z",
        },
    )
    db.record_ingest(
        "claude",
        {
            "hook_event_name": "Stop",
            "session_id": sid,
            "cwd": "/repo",
            "timestamp": "2026-07-16T03:20:58Z",
            "last_assistant_message": "Check complete.",
        },
    )

    detail = db.get_session_detail(sid)
    assert detail is not None
    assert detail["summary"]["ended_at"] is None
    assert [event["title"] for event in detail["events"]] == [
        "Session started",
        "Turn ended",
    ]

    db.record_ingest(
        "claude",
        {
            "hook_event_name": "SessionEnd",
            "session_id": sid,
            "cwd": "/repo",
            "timestamp": "2026-07-16T03:21:30Z",
            "reason": "other",
        },
    )

    detail = db.get_session_detail(sid)
    assert detail is not None
    assert detail["summary"]["ended_at"] == "2026-07-16T03:21:30+00:00"
    assert [event["title"] for event in detail["events"]] == [
        "Session started",
        "Turn ended",
        "Session ended",
    ]

    db.record_ingest(
        "claude",
        {
            "hook_event_name": "SessionStart",
            "session_id": sid,
            "cwd": "/repo",
            "timestamp": "2026-07-16T03:22:00Z",
        },
    )

    detail = db.get_session_detail(sid)
    assert detail is not None
    assert detail["summary"]["ended_at"] is None


def test_claude_desktop_suggestion_subagent_is_evidence_not_a_timeline_event():
    sid = "claude-desktop-suggestions"
    db.record_ingest(
        "claude",
        {
            "hook_event_name": "SessionStart",
            "session_id": sid,
            "cwd": "/repo",
            "timestamp": "2026-07-16T03:20:29Z",
        },
    )

    suggestion = db.record_ingest(
        "claude",
        {
            "hook_event_name": "SubagentStop",
            "session_id": sid,
            "cwd": "/repo",
            "timestamp": "2026-07-16T03:21:15Z",
            "agent_id": "a1ea05adf9a1d9b17",
            "agent_type": "",
            "agent_transcript_path": "/repo/subagents/agent-a1ea05adf9a1d9b17.jsonl",
            "last_assistant_message": "update the readme",
        },
    )
    explicit = db.record_ingest(
        "claude",
        {
            "hook_event_name": "SubagentStop",
            "session_id": sid,
            "cwd": "/repo",
            "timestamp": "2026-07-16T03:22:15Z",
            "agent_id": "af7b1027e6e6d8880",
            "agent_type": "Explore",
            "agent_transcript_path": "/repo/subagents/agent-af7b1027e6e6d8880.jsonl",
            "last_assistant_message": "Repository inspection complete.",
        },
    )

    assert suggestion["raw_status"] == "ignored"
    assert suggestion["event_id"] is None
    assert explicit["raw_status"] == "projected"
    detail = db.get_session_detail(sid)
    assert detail is not None
    subagents = [
        event for event in detail["events"] if event["category"] == "subagent"
    ]
    assert len(subagents) == 1
    assert subagents[0]["title"] == "Explore"


def test_migration_repairs_stored_claude_desktop_lifecycle_and_suggestions():
    sid = "stored-claude-desktop-session"
    db.record_ingest(
        "claude",
        {
            "hook_event_name": "SessionStart",
            "session_id": sid,
            "cwd": "/repo",
            "timestamp": "2026-07-16T03:20:29Z",
        },
    )
    stop = db.record_ingest(
        "claude",
        {
            "hook_event_name": "Stop",
            "session_id": sid,
            "cwd": "/repo",
            "timestamp": "2026-07-16T03:20:58Z",
            "last_assistant_message": "Check complete.",
        },
    )
    suggestion_payload = {
        "hook_event_name": "SubagentStop",
        "session_id": sid,
        "cwd": "/repo",
        "timestamp": "2026-07-16T03:21:15Z",
        "agent_id": "a1ea05adf9a1d9b17",
        "agent_type": "",
        "last_assistant_message": "update the readme",
    }
    with store.write() as conn:
        store.insert_event(
            conn,
            session_id=sid,
            source="claude",
            hook="SubagentStop",
            phase="end",
            ts="2026-07-16T03:21:15Z",
            payload=suggestion_payload,
            category="subagent",
            title="Subagent",
            detail="update the readme",
            target="a1ea05adf9a1d9b17",
            status="ok",
            created_at="2026-07-16T03:21:15Z",
        )
        conn.execute(
            "UPDATE events SET title = 'Session ended' WHERE id = ?",
            (stop["event_id"],),
        )
        conn.execute(
            "UPDATE sessions SET status = 'completed', ended_at = ? WHERE id = ?",
            ("2026-07-16T03:20:58Z", sid),
        )
        conn.execute(
            "UPDATE settings SET value = 'pre-claude-desktop-repair'"
            " WHERE key = 'migrations_version'"
        )
        conn.execute("UPDATE events SET origin = NULL WHERE session_id = ?", (sid,))

    db.init_db()

    detail = db.get_session_detail(sid)
    assert detail is not None
    assert detail["summary"]["ended_at"] is None
    assert [event["title"] for event in detail["events"]] == [
        "Session started",
        "Turn ended",
    ]
    suggestion_raw = [
        row
        for row in db.raw_ingest_events()
        if row["session_id_guess"] == sid and row["raw_kind"] == "SubagentStop"
    ]
    assert len(suggestion_raw) == 1
    assert suggestion_raw[0]["status"] == "ignored"
    assert suggestion_raw[0]["event_id"] is None


def test_malformed_raw_input_is_evidence_not_a_timeline_event():
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

    with store.read() as conn:
        assert conn.execute("SELECT COUNT(*) n FROM events").fetchone()["n"] == 0


def test_drift_report_groups_weekly_unknown_rates_and_raw_status_counts():
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
