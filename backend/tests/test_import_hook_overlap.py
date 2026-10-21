"""A transcript import must not double a session that hooks captured live.

Hooks and the importer each record every tool call under their own dedup keys,
so importing a hooked session's transcript stored each call twice (the bridge's
skip list comes from ``/v1/sessions/origins``, which can time out).
"""

from __future__ import annotations

import importlib.machinery
import importlib.util
from pathlib import Path

import pytest

from app import db, store

SID = "2679bb31-0000-4000-8000-000000000001"


def _load_bridge():
    path = Path(__file__).resolve().parents[2] / "bridge" / "cot"
    loader = importlib.machinery.SourceFileLoader("cot_bridge_overlap", str(path))
    spec = importlib.util.spec_from_loader("cot_bridge_overlap", loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


bridge = _load_bridge()


@pytest.fixture(autouse=True)
def _use_fresh_db(fresh_db):
    return fresh_db


def _hook_bash_call(sid: str) -> None:
    base = {"session_id": sid, "cwd": "/repo", "tool_name": "Bash", "tool_use_id": "toolu_1"}
    db.record_ingest("claude", {
        **base, "hook_event_name": "PreToolUse",
        "tool_input": {"command": "rtk ls"}, "timestamp": "2026-10-20T20:31:21.230148Z",
    })
    db.record_ingest("claude", {
        **base, "hook_event_name": "PostToolUse", "tool_input": {"command": "rtk ls"},
        "tool_response": {"stdout": "cot/"}, "timestamp": "2026-10-20T20:31:23.414587Z",
    })


def _transcript_payloads(sid: str, source: str = "claude") -> list[dict]:
    """The same call as the importer posts it from the transcript."""
    lines = [
        {"type": "assistant", "uuid": "u1", "timestamp": "2026-10-20T20:31:21.081Z",
         "message": {"role": "assistant", "content": [
             {"type": "tool_use", "id": "toolu_1", "name": "Bash", "input": {"command": "ls"}},
         ]}},
        {"type": "user", "uuid": "u2", "timestamp": "2026-10-20T20:31:23.428Z",
         "message": {"role": "user", "content": [
             {"type": "tool_result", "tool_use_id": "toolu_1", "content": "cot/", "is_error": False},
         ]}},
    ]
    state: dict = {}
    out: list[dict] = []
    for lineno, obj in enumerate(lines):
        out.extend(bridge._import_line_to_hook_payloads(  # noqa: SLF001
            source, obj, sid, lineno=lineno, state=state, path="/t.jsonl"
        ))
    assert out and all(p.get("_import") for p in out), out
    return out


def _counts(sid: str) -> tuple[int, int]:
    with store.read() as conn:
        row = conn.execute(
            "SELECT event_count, tool_count FROM session_stats WHERE session_id = ?", (sid,)
        ).fetchone()
    return row["event_count"], row["tool_count"]


def test_import_after_hooks_does_not_store_calls_twice():
    _hook_bash_call(SID)
    before = _counts(SID)

    results = [db.record_ingest("claude", p) for p in _transcript_payloads(SID)]

    assert {r["raw_status"] for r in results} == {"ignored"}, results
    assert _counts(SID) == before == (2, 2)
    detail = db.get_session_detail(SID)
    bash = [e for e in detail["events"] if e["tool"] == "Bash"]
    assert len(bash) == 1, bash


def test_import_of_unhooked_session_still_lands_and_hooks_still_win():
    for p in _transcript_payloads(SID):
        assert db.record_ingest("claude", p)["raw_status"] == "projected"
    assert _counts(SID) == (2, 2)

    # A live hook arriving later replaces the imported approximation.
    _hook_bash_call(SID)
    assert db.session_origins()[SID] == "hook"
    assert _counts(SID) == (2, 2)
    for p in _transcript_payloads(SID):
        assert db.record_ingest("claude", p)["raw_status"] == "ignored"


def test_migration_purges_existing_duplicates_but_keeps_cursor_supplements(monkeypatch):
    # Rows written by a collector without the guard.
    monkeypatch.setattr(db, "_import_shadows_hooks", lambda *_: False)
    _hook_bash_call(SID)
    for p in _transcript_payloads(SID):
        db.record_ingest("claude", p)
    assert _counts(SID) == (4, 4)

    cursor_sid = "cursor-hooked"
    db.record_ingest("cursor", {
        "conversation_id": cursor_sid, "hook_event_name": "preToolUse",
        "tool_name": "Shell", "tool_input": {"command": "ls"},
        "timestamp": "2026-10-20T20:00:00Z",
    })
    db.record_ingest("cursor", {
        "session_id": cursor_sid, "hook_event_name": "PostToolUse", "tool_name": "ReadLints",
        "_import": True, "_dedup_key": "/c.jsonl:3:tool:0", "timestamp": "2026-10-20T20:00:05Z",
    })
    cursor_before = _counts(cursor_sid)

    with store.write() as conn:
        db._purge_import_for_hook_sessions(conn)  # noqa: SLF001

    assert _counts(SID) == (2, 2)
    assert _counts(cursor_sid) == cursor_before


def test_session_origins_matches_a_full_group_by():
    _hook_bash_call(SID)
    for p in _transcript_payloads("import-only"):
        db.record_ingest("claude", p)
    db.ensure_query_indexes()

    with store.read() as conn:
        expected = {
            r["session_id"]: "hook" if r["has_hook"] else "import"
            for r in conn.execute(
                "SELECT session_id, MAX(origin = 'hook' OR origin IS NULL) AS has_hook"
                " FROM events GROUP BY session_id"
            )
        }
    assert db.session_origins() == expected == {SID: "hook", "import-only": "import"}
