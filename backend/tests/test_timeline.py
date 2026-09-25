"""Tests for timeline span merging (app/db.timeline), focused on subagents.

Claude subagents open with a PreToolUse(Agent) start keyed by tool_use_id and
close with a SubagentStop that carries no tool_use_id, so the two can't
key-match. For background agents the PostToolUse(Agent) "launched" ack closes
the span almost instantly. The merge must attach the trailing SubagentStop to
its launch (correct window, no duplicate) and drop truly-orphan stops.

Run with pytest via ``just check``.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app import db, store, timeutil  # noqa: E402

_NOW = datetime(2026, 7, 3, 12, 0, 0, tzinfo=timezone.utc)
_case = 0


@pytest.fixture(autouse=True)
def _use_fresh_db(fresh_db):
    return fresh_db


def _fresh() -> str:
    global _case
    _case += 1
    sid = f"s{_case}"
    with store.write() as conn:
        conn.execute(
            "INSERT INTO sessions (id, source, cwd, started_at, status, archived, created_at)"
            " VALUES (?, 'claude', '/p', ?, 'active', 0, ?)",
            (sid, _NOW.isoformat(), timeutil.now()),
        )
    return sid


def _ev(sid, *, source="claude", hook, tool=None, phase, category, target, title=None,
        secs=0.0, status="ok"):
    ts = (_NOW + timedelta(seconds=secs)).isoformat()
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
            title=title or "Subagent",
            target=target,
            status=status,
            created_at=timeutil.now(),
        )


def _subs(sid):
    return [it for it in db.timeline(sid) if it.get("category") == "subagent"]


def test_background_subagent_window_extends_to_stop():
    sid = _fresh()
    # PreToolUse start, PostToolUse "launched" ack 0.005s later, SubagentStop 110s later.
    _ev(sid, hook="PreToolUse", tool="Agent", phase="start", category="subagent",
        target="toluu_1", title="Explore · data model", secs=0)
    _ev(sid, hook="PostToolUse", tool="Agent", phase="end", category="subagent",
        target="toluu_1", title="Explore · data model", secs=0.005)
    _ev(sid, hook="SubagentStop", phase="end", category="subagent", target="Explore", secs=110)
    subs = _subs(sid)
    assert len(subs) == 1, subs
    span = subs[0]
    assert span["title"] == "Explore · data model"  # keeps the launch's real label
    assert span["duration_ms"] >= 109_000  # window extended to the stop, not the 5ms ack
    assert span["end_ts"] == (_NOW + timedelta(seconds=110)).isoformat()


def test_orphan_subagent_stop_is_dropped():
    sid = _fresh()
    _ev(sid, hook="SubagentStop", phase="end", category="subagent", target="Subagent", secs=5)
    assert _subs(sid) == []


def test_two_subagents_pair_fifo():
    sid = _fresh()
    # Two launches, then two stops — each stop extends the oldest open launch.
    _ev(sid, hook="PreToolUse", tool="Agent", phase="start", category="subagent",
        target="toluu_a", title="Agent A", secs=0)
    _ev(sid, hook="PostToolUse", tool="Agent", phase="end", category="subagent",
        target="toluu_a", title="Agent A", secs=0.01)
    _ev(sid, hook="PreToolUse", tool="Agent", phase="start", category="subagent",
        target="toluu_b", title="Agent B", secs=1)
    _ev(sid, hook="PostToolUse", tool="Agent", phase="end", category="subagent",
        target="toluu_b", title="Agent B", secs=1.01)
    _ev(sid, hook="SubagentStop", phase="end", category="subagent", target="A", secs=50)
    _ev(sid, hook="SubagentStop", phase="end", category="subagent", target="B", secs=70)
    subs = sorted(_subs(sid), key=lambda s: s["title"])
    assert [s["title"] for s in subs] == ["Agent A", "Agent B"]
    assert subs[0]["duration_ms"] >= 49_000  # A extended by first stop (50s)
    assert subs[1]["duration_ms"] >= 68_000  # B extended by second stop (70s - 1s start)


def test_cursor_matched_stop_still_merges_normally():
    sid = _fresh()
    # Cursor's start and stop share a subagent_id key, so they merge via the
    # normal path and must NOT be dropped by the orphan handling.
    _ev(sid, source="cursor", hook="subagentStart", phase="start", category="subagent",
        target="sub_123", title="Cursor sub", secs=0)
    _ev(sid, source="cursor", hook="subagentStop", phase="end", category="subagent",
        target="sub_123", title="Cursor sub", secs=30)
    subs = _subs(sid)
    assert len(subs) == 1
    assert subs[0]["duration_ms"] >= 29_000


def test_paired_span_records_its_end_event_id():
    # Search can hit either half of a tool call; the timeline shows one item
    # under the start id, so it must also carry the end id to be findable.
    sid = _fresh()
    start = _ev(sid, hook="PreToolUse", tool="Bash", phase="start", category="shell",
                target="ls", title="Shell command", secs=0)
    end = _ev(sid, hook="PostToolUse", tool="Bash", phase="end", category="shell",
              target="ls", title="Shell command", secs=1)
    (item,) = [it for it in db.timeline(sid) if it["category"] == "shell"]
    assert item["id"] == start
    assert item["end_id"] == end


def test_retargeted_span_records_its_end_event_id():
    # A hook rewrote the command between pre and post, so the halves pair by tool.
    sid = _fresh()
    _ev(sid, hook="PreToolUse", tool="Bash", phase="start", category="shell",
        target="ls", title="Shell command", secs=0)
    end = _ev(sid, hook="PostToolUse", tool="Bash", phase="end", category="shell",
              target="rtk ls", title="Shell command", secs=1)
    (item,) = [it for it in db.timeline(sid) if it["category"] == "shell"]
    assert item["end_id"] == end


def test_lazy_detail_of_a_retargeted_call_includes_its_output():
    # A PreToolUse hook (e.g. rtk) rewrote the command, so start and end targets
    # differ. The timeline pairs them by tool; the lazy detail must too, or the
    # session page shows the command without its output.
    sid = _fresh()
    with store.write() as conn:
        common = dict(session_id=sid, source="claude", tool="Bash", category="shell",
                      title="Shell command", created_at=timeutil.now())
        start = store.insert_event(conn, **common, hook="PreToolUse", phase="start",
                                   ts=_NOW.isoformat(), target="ls",
                                   detail='{"command": "ls"}')
        store.insert_event(conn, **common, hook="PostToolUse", phase="end",
                           ts=(_NOW + timedelta(seconds=1)).isoformat(), target="rtk ls",
                           detail='{"command": "rtk ls", "response": "README.md"}')
    detail = db.get_event_detail(sid, start)["detail"]
    assert "README.md" in detail
