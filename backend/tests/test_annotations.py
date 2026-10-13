"""Annotations: thumbs, labels and notes on sessions and events."""

from __future__ import annotations

from fastapi.testclient import TestClient

from app import db, main, store, timeutil


def _session(sid: str) -> int:
    now = timeutil.now()
    with store.write() as conn:
        conn.execute(
            "INSERT INTO sessions (id, source, cwd, started_at, status, created_at) VALUES (?, 'claude', '/w', ?, 'active', ?)",
            (sid, now, now),
        )
        store.insert_event(conn, session_id=sid, source="claude", hook="UserPromptSubmit", ts=now,
                           category="prompt", detail="fix the flaky test")
        return store.insert_event(conn, session_id=sid, source="claude", hook="PostToolUse", tool="Bash",
                                  ts=now, category="shell", target="pytest -q")


def test_session_and_event_annotations_round_trip(fresh_db):
    eid = _session("s1")
    client = TestClient(main.app, base_url="http://127.0.0.1")

    r = client.put("/v1/sessions/s1/annotations", json={"rating": -1, "labels": ["Looped", "looped", " wrong  approach "], "note": "went in circles"})
    assert r.status_code == 200
    assert r.json()["rating"] == -1
    assert r.json()["labels"] == ["looped", "wrong approach"]

    r = client.put("/v1/sessions/s1/annotations", json={"event_id": eid, "rating": 1})
    assert r.json()["event_id"] == eid

    got = client.get("/v1/sessions/s1/annotations").json()
    assert got["session"]["note"] == "went in circles"
    assert [a["event_id"] for a in got["events"]] == [eid]

    # The session list carries the session-level thumbs.
    rows, _ = db.list_sessions_page()
    assert rows[0]["rating"] == -1

    listed = client.get("/v1/annotations", params={"label": "looped"}).json()["items"]
    assert len(listed) == 1 and listed[0]["session_title"] == "fix the flaky test"
    up = client.get("/v1/annotations", params={"rating": 1}).json()["items"]
    assert up[0]["event"]["target"] == "pytest -q"


def test_empty_annotation_clears_it(fresh_db):
    _session("s1")
    client = TestClient(main.app, base_url="http://127.0.0.1")
    client.put("/v1/sessions/s1/annotations", json={"rating": 1})
    r = client.put("/v1/sessions/s1/annotations", json={})
    assert r.status_code == 200 and r.json()["rating"] is None
    assert client.get("/v1/sessions/s1/annotations").json() == {"session": None, "events": []}


def test_bad_targets_are_rejected(fresh_db):
    _session("s1")
    _session("s2")
    other = _session("s3")
    client = TestClient(main.app, base_url="http://127.0.0.1")
    assert client.put("/v1/sessions/nope/annotations", json={"rating": 1}).status_code == 404
    # An event from another session is not this session's to annotate.
    assert client.put("/v1/sessions/s1/annotations", json={"event_id": other, "rating": 1}).status_code == 404
    assert client.put("/v1/sessions/s1/annotations", json={"rating": 5}).status_code == 422


def test_deleting_a_session_drops_its_annotations(fresh_db):
    _session("s1")
    db.set_annotation("s1", None, rating=1, labels=None, note=None)
    with store.write() as conn:
        conn.execute("DELETE FROM sessions WHERE id = 's1'")
    with store.read() as conn:
        assert conn.execute("SELECT COUNT(*) FROM annotations").fetchone()[0] == 0
