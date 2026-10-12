"""The findings read stays short: what it fetches, how it's shared.

In rollback-journal mode a long read plus a pending writer stalls every other
request, so these pin down the pieces that keep the findings read short:
``detail`` only where the secrets rule needs it, per-session views narrowed in
session mode, the tool-call index, and one shared pass per burst of requests.
"""

from __future__ import annotations

import threading
import time
from datetime import datetime, timedelta, timezone

import pytest

from app import db, insights, store, timeutil


@pytest.fixture(autouse=True)
def _use_fresh_db(fresh_db):
    insights.forget_shared_insights()
    return fresh_db


def _ts(minutes_ago: float = 0.0) -> str:
    return (datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)).isoformat()


def _event(sid: str, **kw) -> int:
    with store.write() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO sessions (id, source, cwd, started_at, status, archived, created_at)"
            " VALUES (?, 'claude', '/proj', ?, 'active', 0, ?)",
            (sid, _ts(600), timeutil.now()),
        )
        return store.insert_event(
            conn, session_id=sid, source="claude", hook=kw.pop("hook", "PostToolUse"),
            phase="end", ts=kw.pop("ts", _ts()), created_at=timeutil.now(), **kw,
        )


def test_detail_is_read_only_for_prompts_and_shell():
    _event("s1", category="shell", tool="Bash", target="ls", status="ok", detail="shell out")
    _event("s1", category="prompt", detail="prompt text")
    _event("s1", category="file_read", tool="Read", target="/x", status="ok", detail="file body")
    rows = db.read_insight_inputs(cutoff=None, session_id=None, trend_since=None)["events"]
    by_cat = {r["category"]: r["detail"] for r in rows}
    assert by_cat == {"shell": "shell out", "prompt": "prompt text", "file_read": None}


def test_session_mode_narrows_per_session_views():
    _event("s1", category="shell", tool="Bash", target="ls", status="ok")
    _event("s2", category="shell", tool="Bash", target="ls", status="ok")
    data = db.read_insight_inputs(cutoff=None, session_id="s1", trend_since=None)
    assert set(data["session_last_ts"]) == {"s1"}
    assert data["session_tool_calls"] == {"s1": 1}
    full = db.read_insight_inputs(cutoff=None, session_id=None, trend_since=None)
    assert full["session_tool_calls"] == {"s1": 1, "s2": 1}


def test_tool_call_counts_use_the_partial_index():
    db.ensure_insight_indexes()
    db.ensure_insight_indexes()  # idempotent
    with store.read() as conn:
        plan = " ".join(
            r[3] for r in conn.execute(
                "EXPLAIN QUERY PLAN SELECT session_id, COUNT(*) n FROM events"
                " WHERE tool IS NOT NULL AND status IS NOT NULL GROUP BY session_id"
            )
        )
    assert "idx_events_tool_calls" in plan


def test_concurrent_requests_share_one_pass(monkeypatch):
    calls = []

    def slow(days=30, **_kw):
        calls.append(days)
        time.sleep(0.3)
        return {"insights": [{"id": "x"}], "counts": {}}

    monkeypatch.setattr(insights, "compute_insights", slow)
    out: list[dict] = []
    threads = [threading.Thread(target=lambda: out.append(insights.compute_insights_shared(30))) for _ in range(5)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert calls == [30]
    assert len(out) == 5 and all(o["insights"] == [{"id": "x"}] for o in out)
    out[0]["insights"].append("mutated")  # callers get their own list
    assert insights.compute_insights_shared(30)["insights"] == [{"id": "x"}]
    assert calls == [30]  # still fresh
    insights.compute_insights_shared(7)
    assert calls == [30, 7]  # a different window is its own pass


def test_dismiss_drops_the_shared_result(monkeypatch):
    calls = []
    monkeypatch.setattr(insights, "compute_insights", lambda days=30, **_: calls.append(days) or {"insights": []})
    insights.compute_insights_shared(30)
    insights.set_finding_status("nope", "dismissed")
    insights.compute_insights_shared(30)
    assert calls == [30, 30]


def test_failed_pass_lets_a_waiter_retry(monkeypatch):
    state = {"n": 0}

    def flaky(days=30, **_):
        state["n"] += 1
        time.sleep(0.1)
        if state["n"] == 1:
            raise RuntimeError("boom")
        return {"insights": []}

    monkeypatch.setattr(insights, "compute_insights", flaky)
    errors: list[Exception] = []
    results: list[dict] = []

    def call():
        try:
            results.append(insights.compute_insights_shared(30))
        except RuntimeError as exc:
            errors.append(exc)

    a = threading.Thread(target=call)
    a.start()
    time.sleep(0.02)
    b = threading.Thread(target=call)
    b.start()
    a.join()
    b.join()
    assert len(errors) == 1 and results == [{"insights": []}]


def test_batched_read_keeps_rows_and_order(monkeypatch):
    for sid in ("s3", "s1", "s2"):
        for m in (3, 1, 2):
            _event(sid, category="shell", tool="Bash", target=f"{sid}-{m}", status="ok", ts=_ts(m))
    whole = db.read_insight_inputs(cutoff=None, session_id=None, trend_since=None)["events"]
    monkeypatch.setattr(db, "_INSIGHT_SESSION_BATCH", 1)
    batched = db.read_insight_inputs(cutoff=None, session_id=None, trend_since=None)["events"]
    assert [e["id"] for e in batched] == [e["id"] for e in whole]
    assert [(e["session_id"], e["ts"]) for e in batched] == sorted((e["session_id"], e["ts"]) for e in batched)


def test_task_poll_does_not_take_the_write_lock(monkeypatch):
    from app import passive

    passive.runs()
    monkeypatch.setattr(store, "write", lambda: (_ for _ in ()).throw(AssertionError("poll wrote")))
    assert passive.runs() == []
