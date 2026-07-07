from __future__ import annotations

import json
import os
import sys
import tempfile

_HERE = os.path.dirname(os.path.abspath(__file__))
_BACKEND = os.path.dirname(_HERE)

sys.path.insert(0, _BACKEND)

from app import db  # noqa: E402


def _fresh_db() -> tempfile.TemporaryDirectory[str]:
    tmp = tempfile.TemporaryDirectory()
    os.environ["COT_DB_PATH"] = os.path.join(tmp.name, "cot.db")
    db.init_db()
    return tmp


def _session(sid: str, *, source: str = "cursor") -> None:
    with db._connect() as conn:
        conn.execute(
            "INSERT INTO sessions (id, source, started_at, status, created_at)"
            " VALUES (?,?,?,?,?)",
            (sid, source, "2026-06-01T00:00:00Z", "completed", "2026-06-01T00:00:00Z"),
        )


def _event(
    sid: str,
    *,
    seconds: int,
    category: str,
    phase: str = "instant",
    source: str = "cursor",
    hook: str = "x",
    tool: str | None = None,
    title: str | None = None,
    detail: str | None = None,
    target: str | None = None,
) -> int:
    ts = f"2026-06-01T00:00:{seconds:02d}Z"
    with db._connect() as conn:
        cur = conn.execute(
            "INSERT INTO events (session_id, source, hook, tool, phase, ts, category,"
            " title, detail, target, dedup_key, origin, created_at)"
            " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                sid,
                source,
                hook,
                tool,
                phase,
                ts,
                category,
                title,
                detail,
                target,
                f"{sid}:{seconds}:{category}:{phase}:{target}",
                "hook",
                ts,
            ),
        )
        return int(cur.lastrowid)


def test_session_detail_exposes_backend_owned_timeline_runs_for_inlined_child():
    tmp = _fresh_db()
    try:
        parent = "11111111-1111-1111-1111-111111111111"
        child = "22222222-2222-2222-2222-222222222222"
        _session(parent)
        _session(child)
        _event(parent, seconds=0, category="prompt", detail="delegate this")
        _event(
            parent,
            seconds=1,
            category="subagent",
            phase="start",
            hook="subagentStart",
            title="Explore files",
            target="sub_1",
        )
        _event(
            parent,
            seconds=8,
            category="subagent",
            phase="end",
            hook="subagentStop",
            title="Explore files",
            target="sub_1",
        )
        _event(child, seconds=2, category="prompt", detail="read the tree")
        _event(child, seconds=3, category="shell", target="ls")

        assert db.set_subagent_links([{"child": child, "parent": parent, "label": "explore"}]) == 1

        detail = db.get_session_detail(parent)
        assert detail is not None
        runs = detail["timeline_runs"]
        assert len(runs) == 1, runs
        assert runs[0]["kind"] == "subagent"
        assert runs[0]["label"] == "Explore files"
        assert runs[0]["child_session_id"] == child
        assert runs[0]["item"]["subagent_child_session"] == child
    finally:
        tmp.cleanup()


def test_detail_preview_lookup_points_at_owning_session_for_parent_and_child_events():
    tmp = _fresh_db()
    try:
        parent = "33333333-3333-3333-3333-333333333333"
        child = "44444444-4444-4444-4444-444444444444"
        _session(parent)
        _session(child)
        parent_id = _event(parent, seconds=0, category="prompt", detail="p" * 4100)
        child_id = _event(child, seconds=1, category="response", detail="c" * 4100)
        assert db.set_subagent_links([{"child": child, "parent": parent, "label": "child"}]) == 1

        detail = db.get_session_detail(parent)
        assert detail is not None
        parent_event = next(e for e in detail["events"] if e["id"] == parent_id)
        child_event = next(e for e in detail["events"] if e.get("event_session_id") == child)

        assert parent_event["detail_truncated"] is True
        assert parent_event["detail_lookup"] == {"session_id": parent, "event_id": parent_id}
        assert len(parent_event["detail"]) == 4000

        assert child_event["id"] == child_id
        assert child_event["detail_truncated"] is True
        assert child_event["detail_lookup"] == {"session_id": child, "event_id": child_id}
    finally:
        tmp.cleanup()


def test_session_detail_pairs_structured_question_and_answer_annotations():
    tmp = _fresh_db()
    try:
        sid = "55555555-5555-5555-5555-555555555555"
        question = {
            "input": {
                "questions": [
                    {
                        "id": "scope",
                        "header": "Scope",
                        "question": "Which branch?",
                        "options": [{"label": "main"}, {"label": "current"}],
                    }
                ]
            }
        }
        answer = {
            **question,
            "response": {"answers": {"scope": {"answers": ["current"]}}},
        }
        _session(sid, source="codex")
        qid = _event(
            sid,
            seconds=0,
            category="question",
            hook="request_user_input",
            tool="request_user_input",
            detail=json.dumps(question),
        )
        aid = _event(
            sid,
            seconds=1,
            category="question",
            hook="postToolUse",
            tool="request_user_input",
            detail=json.dumps(answer),
        )

        detail = db.get_session_detail(sid)
        assert detail is not None
        assert len(detail["clarifications"]) == 1
        clarification = detail["clarifications"][0]
        assert clarification["question_event_id"] == qid
        assert clarification["question_ts"] == "2026-06-01T00:00:00Z"
        assert clarification["question_excerpt"] == "Which branch?"
        assert clarification["answer_event_id"] == aid
        assert clarification["answer_ts"] == "2026-06-01T00:00:01Z"
        assert clarification["answer_excerpt"]
        assert clarification["answered"] is True
        question_event = next(e for e in detail["events"] if e["id"] == qid)
        answer_event = next(e for e in detail["events"] if e["id"] == aid)
        assert question_event["is_question"] is True
        assert question_event["answered"] is True
        assert question_event["answer_event_id"] == aid
        assert question_event["questions"][0]["answer"] is None
        assert answer_event["answers_event_id"] == qid
        assert answer_event["questions"][0]["answer"] == "current"
    finally:
        tmp.cleanup()
