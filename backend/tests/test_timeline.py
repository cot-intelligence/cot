"""Tests for timeline span merging (app/db.timeline), focused on subagents.

Claude subagents open with a PreToolUse(Agent) start keyed by tool_use_id and
close with a SubagentStop that carries no tool_use_id, so the two can't
key-match. For background agents the PostToolUse(Agent) "launched" ack closes
the span almost instantly. The merge must attach the trailing SubagentStop to
its launch (correct window, no duplicate) and drop truly-orphan stops.

Runnable with pytest or directly: ``python3 backend/tests/test_timeline.py``.
"""

from __future__ import annotations

import os
import sys
import tempfile
from datetime import datetime, timedelta, timezone

_HERE = os.path.dirname(os.path.abspath(__file__))
_BACKEND = os.path.dirname(_HERE)
_TMP = tempfile.mkdtemp(prefix="cot-timeline-test-")

sys.path.insert(0, _BACKEND)
os.environ["COT_DB_PATH"] = os.path.join(_TMP, "bootstrap.db")

from app import db  # noqa: E402

_NOW = datetime(2026, 7, 3, 12, 0, 0, tzinfo=timezone.utc)
_case = 0


def _fresh() -> str:
    global _case
    _case += 1
    os.environ["COT_DB_PATH"] = os.path.join(_TMP, f"case{_case}.db")
    db.init_db()
    sid = f"s{_case}"
    with db._connect() as conn:
        conn.execute(
            "INSERT INTO sessions (id, source, cwd, started_at, status, archived, created_at)"
            " VALUES (?, 'claude', '/p', ?, 'active', 0, ?)",
            (sid, _NOW.isoformat(), db._now()),
        )
    return sid


def _ev(sid, *, source="claude", hook, tool=None, phase, category, target, title=None,
        secs=0.0, status="ok"):
    ts = (_NOW + timedelta(seconds=secs)).isoformat()
    with db._connect() as conn:
        conn.execute(
            "INSERT INTO events (session_id, source, hook, tool, phase, ts, category,"
            " title, target, status, created_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (sid, source, hook, tool, phase, ts, category, title or "Subagent", target,
             status, db._now()),
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
