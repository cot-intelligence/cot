"""A JSON array posted to /v1/ingest/{source} is recorded in one transaction,
each body on its own: one that fails to project keeps its raw row, marked."""

from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from app import db, main, store


def test_batch_ingest_records_each_body_and_isolates_failures(fresh_db: Path, monkeypatch):
    real = db.normalize

    def flaky(source, raw):
        if raw.get("boom"):
            raise ValueError("cannot project")
        return real(source, raw)

    monkeypatch.setattr(db, "normalize", flaky)
    client = TestClient(main.app, base_url="http://127.0.0.1")
    body = [
        {"session_id": "b1", "hook_event_name": "UserPromptSubmit", "prompt": "one"},
        {"session_id": "b1", "hook_event_name": "UserPromptSubmit", "prompt": "two", "boom": True},
        {"session_id": "b1", "hook_event_name": "UserPromptSubmit", "prompt": "three"},
    ]
    resp = client.post("/v1/ingest/claude", json=body)
    assert resp.status_code == 200
    statuses = [r["raw_status"] for r in resp.json()["results"]]
    assert statuses == ["projected", "failed", "projected"]
    with store.read() as conn:
        raw = conn.execute("SELECT status, projection_error FROM raw_ingest_events ORDER BY id").fetchall()
        events = conn.execute("SELECT detail FROM events WHERE session_id = 'b1' ORDER BY id").fetchall()
    assert [r["status"] for r in raw] == ["projected", "failed", "projected"]
    assert "cannot project" in raw[1]["projection_error"]
    assert [e["detail"] for e in events] == ["one", "three"]


def test_single_body_ingest_still_returns_its_result(fresh_db: Path):
    client = TestClient(main.app, base_url="http://127.0.0.1")
    resp = client.post(
        "/v1/ingest/claude",
        json={"session_id": "s1", "hook_event_name": "UserPromptSubmit", "prompt": "hi"},
    )
    assert resp.status_code == 200
    assert resp.json()["raw_status"] == "projected"
