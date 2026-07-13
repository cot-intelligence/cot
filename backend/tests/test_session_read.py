from __future__ import annotations

import json

import pytest

from app import db, store, timeutil  # noqa: E402
from app.normalize import APPROVAL_REVIEW_PREFIX  # noqa: E402


@pytest.fixture(autouse=True)
def _use_fresh_db(fresh_db):
    return fresh_db


def _session(sid: str, *, source: str = "cursor", status: str = "completed") -> None:
    with store.write() as conn:
        conn.execute(
            "INSERT INTO sessions (id, source, started_at, status, created_at)"
            " VALUES (?,?,?,?,?)",
            (sid, source, "2026-06-01T00:00:00Z", status, "2026-06-01T00:00:00Z"),
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
    status: str | None = None,
) -> int:
    ts = f"2026-06-01T00:00:{seconds:02d}Z"
    with store.write() as conn:
        return store.insert_event(
            conn,
            session_id=sid,
            source=source,
            hook=hook,
            tool=tool,
            phase=phase,
            ts=ts,
            category=category,
            title=title,
            detail=detail,
            target=target,
            status=status,
            dedup_key=f"{sid}:{seconds}:{category}:{phase}:{target}",
            origin="hook",
            created_at=ts,
        )


def test_session_detail_exposes_backend_owned_timeline_runs_for_inlined_child():
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
    assert runs[0]["item"]["owner_session_id"] == parent
    assert runs[0]["item"]["subagent_child_session"] == child
    assert runs[0]["item"]["subagent_run_kind"] == "subagent"
    child_events = [e for e in detail["events"] if e.get("owner_session_id") == child]
    assert {e["category"] for e in child_events} == {"prompt", "shell"}
    assert all(e["run_id"] == runs[0]["id"] for e in child_events), child_events
    assert all(e["event_session_id"] == child for e in child_events), child_events
    assert all(e["inlined_subagent"] is True for e in child_events), child_events


def test_session_detail_orders_synthetic_spans_with_events():
    parent = "15151515-1515-1515-1515-151515151515"
    child = "16161616-1616-1616-1616-161616161616"
    _session(parent)
    _session(child)
    _event(parent, seconds=0, category="prompt", detail="delegate")
    _event(child, seconds=1, category="prompt", detail="child work")
    _event(parent, seconds=4, category="response", detail="done")

    assert db.set_subagent_links([{"child": child, "parent": parent, "label": "child"}]) == 1

    detail = db.get_session_detail(parent)
    assert detail is not None
    assert [e["category"] for e in detail["events"]] == [
        "prompt",
        "prompt",
        "subagent",
        "response",
    ]
    assert detail["events"][1]["owner_session_id"] == child
    assert detail["events"][2]["subagent_child_session"] == child
    assert detail["events"][2]["subagent_run_kind"] == "subagent"


def test_session_detail_synthetic_run_uses_link_status():
    parent = "18181818-1818-1818-1818-181818181818"
    child = "19191919-1919-1919-1919-191919191919"
    _session(parent)
    _session(child)
    _event(parent, seconds=0, category="prompt", detail="delegate")
    now = timeutil.now()
    with store.write() as conn:
        store.insert_event(
            conn,
            session_id=child,
            source="cursor",
            hook="x",
            ts=now,
            category="prompt",
            detail="still working",
            dedup_key=f"{child}:active",
            created_at=now,
        )

    assert db.set_subagent_links([{"child": child, "parent": parent, "label": "child"}]) == 1

    detail = db.get_session_detail(parent)
    assert detail is not None
    run = detail["timeline_runs"][0]
    assert run["status"] == "active"
    assert run["ongoing"] is True
    assert run["end"] is None
    assert run["duration_ms"] is None


def test_session_detail_synthetic_run_uses_terminal_child_status():
    parent = "21212121-2121-2121-2121-212121212121"
    child = "22222222-2222-2222-2222-222222222222"
    _session(parent)
    _session(child, status="active")
    _event(parent, seconds=0, category="prompt", detail="delegate")
    _event(child, seconds=1, category="shell", target="pytest", status="error")
    _event(child, seconds=2, category="prompt", detail="later status-less event")

    assert db.set_subagent_links([{"child": child, "parent": parent, "label": "child"}]) == 1

    detail = db.get_session_detail(parent)
    assert detail is not None
    run = detail["timeline_runs"][0]
    assert run["status"] == "error"
    assert run["ongoing"] is False
    assert run["end"] is not None


def test_session_detail_synthetic_run_clears_recovered_child_status():
    parent = "24242424-2424-2424-2424-242424242424"
    child = "25252525-2525-2525-2525-252525252525"
    _session(parent)
    _session(child, status="active")
    _event(parent, seconds=0, category="prompt", detail="delegate")
    _event(child, seconds=1, category="shell", target="pytest", status="error")
    _event(child, seconds=2, category="shell", target="pytest", status="ok")

    assert db.set_subagent_links([{"child": child, "parent": parent, "label": "child"}]) == 1

    detail = db.get_session_detail(parent)
    assert detail is not None
    run = detail["timeline_runs"][0]
    assert run["status"] == "completed"
    assert run["ongoing"] is False


def test_detail_preview_lookup_points_at_owning_session_for_parent_and_child_events():
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
    child_event = next(e for e in detail["events"] if e.get("owner_session_id") == child)

    assert parent_event["detail_truncated"] is True
    assert parent_event["detail_lookup"] == {"session_id": parent, "event_id": parent_id}
    assert len(parent_event["detail"]) == 4000
    full = db.get_event_detail(
        parent_event["detail_lookup"]["session_id"],
        parent_event["detail_lookup"]["event_id"],
    )
    assert full is not None and full["detail"] == "p" * 4100

    assert child_event["id"] == child_id
    assert child_event["provenance"] == "subagent"
    assert child_event["event_session_id"] == child
    assert child_event["inlined_subagent"] is True
    assert child_event["detail_truncated"] is True
    assert child_event["detail_lookup"] == {"session_id": child, "event_id": child_id}
    child_full = db.get_event_detail(
        child_event["detail_lookup"]["session_id"],
        child_event["detail_lookup"]["event_id"],
    )
    assert child_full is not None and child_full["detail"] == "c" * 4100


def test_session_detail_pairs_structured_question_and_answer_annotations():
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


def test_session_detail_drops_orphan_subagent_stop_events():
    sid = "66666666-6666-6666-6666-666666666666"
    _session(sid)
    stop_id = _event(
        sid,
        seconds=5,
        category="subagent",
        phase="end",
        hook="SubagentStop",
        title="Subagent",
        target="Subagent",
    )

    detail = db.get_session_detail(sid)
    assert detail is not None
    assert all(e["id"] != stop_id for e in detail["events"]), detail["events"]
    assert detail["timeline_runs"] == []


def test_session_detail_keeps_orphan_subagent_stop_with_detail():
    sid = "13131313-1313-1313-1313-131313131313"
    _session(sid)
    stop_id = _event(
        sid,
        seconds=5,
        category="subagent",
        phase="end",
        hook="SubagentStop",
        title="Subagent",
        target="Subagent",
        detail="Subagent completed with notes.",
    )

    detail = db.get_session_detail(sid)
    assert detail is not None
    subagent_events = [e for e in detail["events"] if e["category"] == "subagent"]
    assert [e["id"] for e in subagent_events] == [stop_id]
    assert subagent_events[0]["detail"] == "Subagent completed with notes."
    assert len(detail["timeline_runs"]) == 1


def test_session_detail_merges_subagent_stop_detail_into_run():
    sid = "17171717-1717-1717-1717-171717171717"
    _session(sid)
    start_id = _event(
        sid,
        seconds=0,
        category="subagent",
        phase="start",
        hook="PreToolUse",
        tool="Agent",
        title="Explore",
        target="toolu_1",
        detail='{"input": {"description": "Explore"}}',
    )
    _event(
        sid,
        seconds=1,
        category="subagent",
        phase="end",
        hook="PostToolUse",
        tool="Agent",
        title="Explore",
        target="toolu_1",
    )
    _event(
        sid,
        seconds=20,
        category="subagent",
        phase="end",
        hook="SubagentStop",
        title="Explore",
        target="Subagent",
        detail='{"response": "final notes"}',
    )

    detail = db.get_session_detail(sid)
    assert detail is not None
    run = detail["timeline_runs"][0]
    assert run["id"] == start_id
    assert run["duration_ms"] == 20000
    assert "Explore" in run["item"]["detail"]
    assert "final notes" in run["item"]["detail"]
    full_detail = db.get_event_detail(sid, start_id)
    assert full_detail is not None
    assert "final notes" in full_detail["detail"]


def test_session_detail_keeps_overlapping_native_run_membership():
    sid = "20202020-2020-2020-2020-202020202020"
    _session(sid)
    run_a = _event(
        sid,
        seconds=0,
        category="subagent",
        phase="start",
        hook="PreToolUse",
        tool="Agent",
        title="Agent A",
        target="toolu_a",
    )
    _event(
        sid,
        seconds=1,
        category="subagent",
        phase="end",
        hook="PostToolUse",
        tool="Agent",
        title="Agent A",
        target="toolu_a",
    )
    run_b = _event(
        sid,
        seconds=2,
        category="subagent",
        phase="start",
        hook="PreToolUse",
        tool="Agent",
        title="Agent B",
        target="toolu_b",
    )
    _event(
        sid,
        seconds=3,
        category="subagent",
        phase="end",
        hook="PostToolUse",
        tool="Agent",
        title="Agent B",
        target="toolu_b",
    )
    shared_id = _event(sid, seconds=5, category="shell", title="Shared action", target="pwd")
    _event(
        sid,
        seconds=10,
        category="subagent",
        phase="end",
        hook="SubagentStop",
        title="Agent A",
        target="Subagent A",
    )
    _event(
        sid,
        seconds=12,
        category="subagent",
        phase="end",
        hook="SubagentStop",
        title="Agent B",
        target="Subagent B",
    )

    detail = db.get_session_detail(sid)
    assert detail is not None
    shared = next(e for e in detail["events"] if e["id"] == shared_id)
    assert shared["run_id"] == run_a
    assert shared["run_ids"] == [run_a, run_b]


def test_session_detail_merges_cursor_keyed_subagent_stop():
    sid = "12121212-1212-1212-1212-121212121212"
    _session(sid)
    start_id = _event(
        sid,
        seconds=0,
        category="subagent",
        phase="start",
        source="cursor",
        hook="subagentStart",
        title="Cursor sub",
        target="sub_123",
    )
    stop_id = _event(
        sid,
        seconds=30,
        category="subagent",
        phase="end",
        source="cursor",
        hook="subagentStop",
        title="Cursor sub",
        target="sub_123",
    )

    detail = db.get_session_detail(sid)
    assert detail is not None
    subagent_events = [e for e in detail["events"] if e["category"] == "subagent"]
    assert [e["id"] for e in subagent_events] == [start_id]
    assert stop_id not in [e["id"] for e in detail["events"]]
    assert subagent_events[0]["duration_ms"] >= 29_000
    assert subagent_events[0]["ongoing"] is False
    assert len(detail["timeline_runs"]) == 1
    assert detail["timeline_runs"][0]["id"] == start_id


def test_session_detail_events_use_merged_display_spans():
    sid = "99999999-9999-9999-9999-999999999999"
    _session(sid)
    start_id = _event(
        sid,
        seconds=1,
        category="shell",
        phase="start",
        hook="PreToolUse",
        tool="Bash",
        title="Run shell",
        target="npm test",
        detail='{"input": {"command": "npm test"}}',
    )
    _event(
        sid,
        seconds=6,
        category="shell",
        phase="end",
        hook="PostToolUse",
        tool="Bash",
        title="Run shell",
        target="npm test",
        detail='{"response": "ok"}',
    )

    detail = db.get_session_detail(sid)
    assert detail is not None
    shell_events = [e for e in detail["events"] if e["category"] == "shell"]
    assert len(shell_events) == 1, shell_events
    assert shell_events[0]["id"] == start_id
    assert shell_events[0]["start_ts"] == "2026-06-01T00:00:01+00:00"
    assert shell_events[0]["end_ts"] == "2026-06-01T00:00:06+00:00"
    assert shell_events[0]["ongoing"] is False
    assert shell_events[0]["duration_ms"] == 5000
    assert "npm test" in shell_events[0]["detail"]
    assert "ok" in shell_events[0]["detail"]
    assert shell_events[0]["hook"] == "PreToolUse"
    assert shell_events[0]["phase"] == "start"


def test_session_detail_keeps_overlapping_same_target_spans():
    sid = "23232323-2323-2323-2323-232323232323"
    _session(sid)
    first_id = _event(
        sid,
        seconds=1,
        category="shell",
        phase="start",
        hook="PreToolUse",
        tool="Bash",
        title="Run shell",
        target="npm test",
        detail='{"input": {"run": "first"}}',
    )
    second_id = _event(
        sid,
        seconds=2,
        category="shell",
        phase="start",
        hook="PreToolUse",
        tool="Bash",
        title="Run shell",
        target="npm test",
        detail='{"input": {"run": "second"}}',
    )
    _event(
        sid,
        seconds=3,
        category="shell",
        phase="end",
        hook="PostToolUse",
        tool="Bash",
        title="Run shell",
        target="npm test",
        detail='{"response": "first done"}',
    )
    _event(
        sid,
        seconds=4,
        category="shell",
        phase="end",
        hook="PostToolUse",
        tool="Bash",
        title="Run shell",
        target="npm test",
        detail='{"response": "second done"}',
    )

    detail = db.get_session_detail(sid)
    assert detail is not None
    shell_events = [e for e in detail["events"] if e["category"] == "shell"]
    assert [e["id"] for e in shell_events] == [first_id, second_id]
    assert [e["duration_ms"] for e in shell_events] == [2000, 2000]
    assert "first done" in shell_events[0]["detail"]
    assert "second done" in shell_events[1]["detail"]


def test_session_detail_full_lookup_uses_merged_span_detail():
    sid = "14141414-1414-1414-1414-141414141414"
    _session(sid)
    start_id = _event(
        sid,
        seconds=1,
        category="shell",
        phase="start",
        hook="PreToolUse",
        tool="Bash",
        title="Run shell",
        target="npm test",
        detail=json.dumps({"input": {"command": "npm test", "padding": "x" * 4100}}),
    )
    _event(
        sid,
        seconds=6,
        category="shell",
        phase="end",
        hook="PostToolUse",
        tool="Bash",
        title="Run shell",
        target="npm test",
        detail=json.dumps({"response": "ok"}),
    )

    detail = db.get_session_detail(sid)
    assert detail is not None
    shell_event = next(e for e in detail["events"] if e["category"] == "shell")
    assert shell_event["id"] == start_id
    assert shell_event["detail_truncated"] is True
    assert shell_event["detail_lookup"] == {"session_id": sid, "event_id": start_id}
    full_detail = db.get_event_detail(
        shell_event["detail_lookup"]["session_id"],
        shell_event["detail_lookup"]["event_id"],
    )
    assert full_detail is not None
    assert "npm test" in full_detail["detail"]
    assert "ok" in full_detail["detail"]


def test_event_detail_lookup_merges_missing_category_spans():
    cases = [
        ("26262626-2626-2626-2626-262626262626", None, "null"),
        ("27272727-2727-2727-2727-272727272727", "", "empty"),
    ]
    for sid, category, label in cases:
        _session(sid)
        with store.write() as conn:
            start_id = store.insert_event(
                conn,
                session_id=sid,
                source="cursor",
                hook="PreToolUse",
                tool="Unknown",
                phase="start",
                ts="2026-06-01T00:00:01Z",
                category=category,
                title="Unknown",
                detail=json.dumps({"input": {"value": "start"}}),
                target="same-target",
                dedup_key=f"{sid}:{label}-category:start",
                created_at="2026-06-01T00:00:01Z",
            )
            store.insert_event(
                conn,
                session_id=sid,
                source="cursor",
                hook="PostToolUse",
                tool="Unknown",
                phase="end",
                ts="2026-06-01T00:00:02Z",
                category=category,
                title="Unknown",
                detail=json.dumps({"response": "end"}),
                target="same-target",
                dedup_key=f"{sid}:{label}-category:end",
                created_at="2026-06-01T00:00:02Z",
            )

        full_detail = db.get_event_detail(sid, start_id)
        assert full_detail is not None
        assert "start" in full_detail["detail"]
        assert "end" in full_detail["detail"]


def test_session_detail_annotates_inlined_child_questions():
    parent = "77777777-7777-7777-7777-777777777777"
    child = "88888888-8888-8888-8888-888888888888"
    question = {
        "input": {
            "questions": [
                {
                    "id": "mode",
                    "header": "Mode",
                    "question": "Review or edit?",
                    "options": [{"label": "review"}, {"label": "edit"}],
                }
            ]
        }
    }
    answer = {
        **question,
        "response": {"answers": {"mode": {"answers": ["review"]}}},
    }
    _session(parent)
    _session(child)
    _event(parent, seconds=0, category="prompt", detail="delegate")
    qid = _event(
        child,
        seconds=1,
        category="question",
        hook="request_user_input",
        tool="request_user_input",
        detail=json.dumps(question),
    )
    aid = _event(
        child,
        seconds=2,
        category="question",
        hook="postToolUse",
        tool="request_user_input",
        detail=json.dumps(answer),
    )
    assert db.set_subagent_links([{"child": child, "parent": parent, "label": "child"}]) == 1

    detail = db.get_session_detail(parent)
    assert detail is not None
    child_question = next(
        e for e in detail["events"] if e.get("owner_session_id") == child and e["id"] == qid
    )
    child_answer = next(
        e for e in detail["events"] if e.get("owner_session_id") == child and e["id"] == aid
    )
    assert child_question["provenance"] == "subagent"
    assert child_question["is_question"] is True
    assert child_question["answered"] is True
    assert child_question["answer_event_id"] == aid
    assert child_answer["answers_event_id"] == qid
    assert child_answer["questions"][0]["answer"] == "review"
    assert any(
        c["question_session_id"] == child
        and c["question_event_id"] == qid
        and c["answer_session_id"] == child
        and c["answer_event_id"] == aid
        for c in detail["clarifications"]
    ), detail["clarifications"]


def test_session_detail_inlines_approval_review_as_review_run():
    parent = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
    review = "ffffffff-1111-2222-3333-444444444444"
    _session(parent, source="codex")
    _session(review, source="codex")
    _event(parent, seconds=0, category="prompt", detail="original task")
    _event(parent, seconds=1, category="response", detail="done")
    history = (
        f"{APPROVAL_REVIEW_PREFIX}\n\n"
        f"Reviewed Codex session id: {parent}\n\n"
        "Check the previous session."
    )
    history_id = _event(review, seconds=2, category="prompt", detail=history)
    response_detail = "Looks clean. " + ("x" * 4100)
    response_id = _event(review, seconds=3, category="response", detail=response_detail)

    detail = db.get_session_detail(parent)
    assert detail is not None
    assert "timeline" in detail
    assert all(e.get("owner_session_id") == parent for e in detail["timeline"])
    review_events = [e for e in detail["events"] if e.get("owner_session_id") == review]
    assert [e["id"] for e in review_events] == [response_id], review_events
    assert all(e["id"] != history_id for e in detail["events"])
    assert review_events[0]["provenance"] == "approval_review"
    assert review_events[0]["event_session_id"] == review
    assert review_events[0]["inlined_approval_review"] is True
    assert review_events[0]["run_kind"] == "review"
    assert review_events[0]["detail_truncated"] is True
    assert review_events[0]["detail_lookup"] == {"session_id": review, "event_id": response_id}
    full_detail = db.get_event_detail(
        review_events[0]["detail_lookup"]["session_id"],
        review_events[0]["detail_lookup"]["event_id"],
    )
    assert full_detail is not None
    assert full_detail["detail"] == response_detail
    runs = detail["timeline_runs"]
    assert len(runs) == 1, runs
    assert runs[0]["kind"] == "review"
    assert runs[0]["child_session_id"] == review
    assert runs[0]["label"] == "Approval review"
    assert review_events[0]["run_id"] == runs[0]["id"]
