"""Session Replay: exported sessions imported into a separate replay store."""

from __future__ import annotations

import json
import uuid

import pytest
from fastapi.testclient import TestClient

from app import db, store, timeutil  # noqa: F401  (db before session_read: import cycle)
from app.normalize import APPROVAL_REVIEW_PREFIX


@pytest.fixture(autouse=True)
def _use_fresh_db(fresh_db):
    return fresh_db


ROOT = str(uuid.uuid4())
SUB = str(uuid.uuid4())
REVIEW = str(uuid.uuid4())


def _client() -> TestClient:
    from app.main import app

    return TestClient(app, base_url="http://127.0.0.1")


def _session(conn, sid, *, source="claude", parent=None, label=None, ts="2026-09-01T10:00:00+00:00"):
    conn.execute(
        "INSERT INTO sessions (id, source, cwd, started_at, status, created_at,"
        " parent_session_id, subagent_label) VALUES (?, ?, '/proj', ?, 'done', ?, ?, ?)",
        (sid, source, ts, timeutil.now(), parent, label),
    )


def _event(conn, sid, secs, **kw):
    ts = f"2026-09-01T10:00:{secs:02d}+00:00"
    base = dict(session_id=sid, source=kw.pop("source", "claude"), ts=ts, created_at=timeutil.now())
    return store.insert_event(conn, **base, **kw)


def _seed_family() -> None:
    """A parent with a subagent child and a Codex approval-review child."""
    with store.write() as conn:
        _session(conn, ROOT)
        _session(conn, SUB, parent=ROOT, label="Explore")
        _session(conn, REVIEW, source="codex")
        _event(conn, ROOT, 1, hook="UserPromptSubmit", category="prompt",
               detail="migrate the billing tables")
        _event(conn, ROOT, 2, hook="PreToolUse", tool="Bash", phase="start", category="shell",
               target="ls", title="Shell command", payload={"session_id": ROOT})
        _event(conn, ROOT, 3, hook="PostToolUse", tool="Bash", phase="end", category="shell",
               target="rtk ls", title="Shell command", detail='{"response": "README.md"}',
               input_tokens=120, output_tokens=40)
        _event(conn, SUB, 4, hook="PostToolUse", tool="Read", phase="instant",
               category="file_read", target="/proj/billing.sql", title="Read file")
        _event(conn, REVIEW, 5, source="codex", hook="UserPromptSubmit", category="prompt",
               detail=f"{APPROVAL_REVIEW_PREFIX}\nReviewed Codex session id: {ROOT}\n…")


def _export(client, sid, **params) -> dict:
    res = client.get(f"/v1/sessions/{sid}/export", params=params)
    assert res.status_code == 200, res.text
    return res.json()


def _import(client, body) -> dict:
    raw = body if isinstance(body, (bytes, str)) else json.dumps(body)
    return client.post("/v1/replay/import", content=raw)


def _replay(client, path, **params):
    return client.get(path, params={"store": "replay", **params})


def test_export_v2_carries_linked_child_sessions():
    _seed_family()
    body = _export(_client(), ROOT)
    assert body["format_version"] == 2
    assert body["session"]["id"] == ROOT
    linked = {s["session"]["id"]: s for s in body["linked_sessions"]}
    assert set(linked) == {SUB, REVIEW}
    assert len(linked[SUB]["raw_events"]) == 1
    assert linked[SUB]["session"]["parent_session_id"] == ROOT


def test_import_round_trips_into_the_replay_store():
    _seed_family()
    client = _client()
    original = _export(client, ROOT)

    res = _import(client, original)
    assert res.status_code == 200, res.text
    new_root = res.json()["session_id"]
    assert new_root != ROOT
    assert res.json()["sessions"] == 3

    again = _export(client, new_root, store="replay")
    assert again["summary"]["imported_from"] == ROOT
    assert again["summary"]["tokens"] == original["summary"]["tokens"]
    assert again["summary"]["category_counts"] == original["summary"]["category_counts"]
    assert [e["detail"] for e in again["events"]] == [e["detail"] for e in original["events"]]
    assert len(again["raw_events"]) == len(original["raw_events"])

    # Children came along with new ids, still linked to the new parent.
    kids = {k["session"]["imported_from"]: k["session"] for k in again["linked_sessions"]}
    assert set(kids) == {SUB, REVIEW}
    assert kids[SUB]["parent_session_id"] == new_root
    review_prompt = next(
        k for k in again["linked_sessions"] if k["session"]["imported_from"] == REVIEW
    )["raw_events"][0]["detail"]
    assert new_root in review_prompt and ROOT not in review_prompt


def test_imported_sessions_stay_out_of_the_main_store():
    _seed_family()
    client = _client()
    before = client.get("/v1/stats").json()
    new_root = _import(client, _export(client, ROOT)).json()["session_id"]

    main_ids = {s["id"] for s in client.get("/v1/sessions").json()["sessions"]}
    assert new_root not in main_ids
    assert client.get("/v1/stats").json() == before
    assert all(r["session_id"] != new_root for r in client.get("/v1/search", params={"q": "billing"}).json()["results"])
    assert client.get(f"/v1/sessions/{new_root}").status_code == 404

    replay_ids = [s["id"] for s in _replay(client, "/v1/sessions").json()["sessions"]]
    assert replay_ids == [new_root]  # children nest under it, like the main list
    hits = _replay(client, "/v1/search", q="billing", session_id=new_root).json()["results"]
    assert hits and all(h["session_id"] == new_root for h in hits)


def test_importing_the_same_file_twice_gives_two_sessions():
    _seed_family()
    client = _client()
    body = _export(client, ROOT)
    first = _import(client, body).json()["session_id"]
    second = _import(client, body).json()["session_id"]
    assert first != second
    listed = {s["id"] for s in _replay(client, "/v1/sessions").json()["sessions"]}
    assert listed == {first, second}


def test_version_1_files_import_without_children():
    _seed_family()
    client = _client()
    body = _export(client, ROOT)
    body["format_version"] = 1
    for key in ("session", "linked_sessions"):
        body.pop(key)
    res = _import(client, body)
    assert res.status_code == 200, res.text
    assert res.json()["sessions"] == 1


@pytest.mark.parametrize(
    "body",
    [b"not json", b"[]", json.dumps({"format": "something-else"}), json.dumps(
        {"format": "cot.session-export", "format_version": 1, "summary": {"id": "x"}}
    )],
)
def test_bad_files_are_rejected_with_a_reason(body):
    res = _import(_client(), body)
    assert res.status_code == 400
    assert res.json()["detail"]


def test_delete_removes_an_imported_session_and_its_children():
    _seed_family()
    client = _client()
    new_root = _import(client, _export(client, ROOT)).json()["session_id"]
    res = client.delete(f"/v1/sessions/{new_root}", params={"store": "replay"})
    assert res.status_code == 200
    assert _replay(client, "/v1/sessions").json()["sessions"] == []
    assert _replay(client, "/v1/search", q="billing").json()["results"] == []


def test_real_sessions_cannot_be_deleted():
    _seed_family()
    assert _client().delete(f"/v1/sessions/{ROOT}").status_code == 404
    with store.read() as conn:
        assert conn.execute("SELECT 1 FROM sessions WHERE id = ?", (ROOT,)).fetchone()


def test_unknown_store_is_rejected():
    assert _client().get("/v1/sessions", params={"store": "other"}).status_code == 400
