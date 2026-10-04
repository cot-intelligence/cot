"""Top-bar task tray: live sessions, passive runs in progress, recent finished runs."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from app import db, passive, store, timeutil  # noqa: F401  (db before main: import cycle)


@pytest.fixture(autouse=True)
def _use_fresh_db(fresh_db, monkeypatch, tmp_path):
    monkeypatch.setenv("COT_PASSIVE_SCHEDULER", "0")
    monkeypatch.setenv("HOME", str(tmp_path))  # passive scans read agent folders under home
    return fresh_db


def _client() -> TestClient:
    from app.main import app

    return TestClient(app, base_url="http://127.0.0.1")


def _session(sid: str, minutes_ago: float, prompt: str) -> None:
    ts = (datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)).isoformat()
    with store.write() as conn:
        conn.execute(
            "INSERT INTO sessions (id, source, cwd, started_at, status, created_at)"
            " VALUES (?, 'claude', '/code/atlas', ?, 'active', ?)",
            (sid, ts, timeutil.now()),
        )
        store.insert_event(conn, session_id=sid, source="claude", ts=ts, created_at=timeutil.now(),
                           hook="UserPromptSubmit", category="prompt", detail=prompt)


def test_live_sessions_are_running_and_quiet_ones_are_not():
    _session("live-1", 1, "fix the deploy")
    _session("old-1", 90, "write docs")
    body = _client().get("/v1/tasks").json()
    ids = [t["id"] for t in body["running"]]
    assert ids == ["session:live-1"]
    task = body["running"][0]
    assert task["kind"] == "session" and task["title"].startswith("fix the deploy") and task["source"] == "claude"


def test_passive_run_shows_while_running_and_lands_in_recent():
    passive._state.update(running=True, phase="analysis", trigger="schedule", started_at=timeutil.now())  # noqa: SLF001
    try:
        running = _client().get("/v1/tasks").json()["running"]
        assert {"id": "passive:current", "kind": "passive", "phase": "analysis"}.items() <= running[0].items()
    finally:
        passive._state.clear()  # noqa: SLF001
        passive._state["running"] = False  # noqa: SLF001
    done = passive.run("manual", importer=lambda a: 0, analyzer=lambda: 4)
    recent = _client().get("/v1/tasks").json()["recent"]
    assert recent[0]["id"] == f"passive:{done['id']}" and recent[0]["findings"] == 4 and recent[0]["status"] == "ok"
