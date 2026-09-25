"""Session export: one JSON file with everything stored for a session."""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from app import db, store, timeutil  # noqa: F401  (db before session_read: import cycle)
from app.session_read import DETAIL_PREVIEW_CHARS


@pytest.fixture(autouse=True)
def _use_fresh_db(fresh_db):
    return fresh_db


LONG_REPLY = "x" * (DETAIL_PREVIEW_CHARS + 500)
LONG_OUTPUT = "line\n" * 2000


def _session(sid: str = "abcdef123456") -> str:
    now = timeutil.now()
    with store.write() as conn:
        conn.execute(
            "INSERT INTO sessions (id, source, cwd, started_at, status, created_at)"
            " VALUES (?, 'claude', '/proj', ?, 'active', ?)",
            (sid, now, now),
        )
        common = dict(session_id=sid, source="claude", created_at=now)
        store.insert_event(conn, **common, hook="Stop", phase="instant", ts=now,
                           category="response", detail=LONG_REPLY)
        store.insert_event(conn, **common, hook="PreToolUse", tool="Bash", phase="start",
                           ts=now, category="shell", target="ls", title="Shell command",
                           payload={"tool_input": {"command": "ls"}})
        store.insert_event(conn, **common, hook="PostToolUse", tool="Bash", phase="end",
                           ts=now, category="shell", target="ls", title="Shell command",
                           detail=LONG_OUTPUT)
    return sid


def _client() -> TestClient:
    from app.main import app

    return TestClient(app, base_url="http://127.0.0.1")


def test_export_is_a_json_download_with_nothing_truncated():
    sid = _session()
    res = _client().get(f"/v1/sessions/{sid}/export")
    assert res.status_code == 200
    assert res.headers["content-type"].startswith("application/json")
    disposition = res.headers["content-disposition"]
    assert disposition.startswith("attachment;")
    assert 'filename="cot-session-abcdef12-' in disposition

    body = res.json()
    assert body["format"] == "cot.session-export"
    assert body["summary"]["id"] == sid
    details = sorted(len(e["detail"] or "") for e in body["events"])
    assert details[-2:] == sorted([len(LONG_REPLY), len(LONG_OUTPUT)])
    assert not any(e.get("detail_truncated") for e in body["events"])


def test_export_includes_raw_hook_rows_with_payloads():
    sid = _session()
    body = _client().get(f"/v1/sessions/{sid}/export").json()
    raw = body["raw_events"]
    assert [r["hook"] for r in raw] == ["Stop", "PreToolUse", "PostToolUse"]
    assert raw[1]["payload"] == {"tool_input": {"command": "ls"}}
    assert "insights" in body


def test_export_of_an_unknown_session_is_404():
    assert _client().get("/v1/sessions/nope/export").status_code == 404


def test_export_file_is_pretty_printed():
    sid = _session()
    text = _client().get(f"/v1/sessions/{sid}/export").text
    assert text.startswith("{\n")
    json.loads(text)
