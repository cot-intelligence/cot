"""Transcript import posts many events per request when the collector takes
batches, and stores exactly what the one-event-per-request path stores."""

from __future__ import annotations

import importlib.machinery
import importlib.util
import json
import sqlite3
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

_REPO = Path(__file__).resolve().parents[2]


def _load_bridge():
    path = str(_REPO / "bridge" / "cot")
    loader = importlib.machinery.SourceFileLoader("cot_bridge_batching_under_test", path)
    spec = importlib.util.spec_from_loader("cot_bridge_batching_under_test", loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


bridge = _load_bridge()
URL = "http://collector.invalid/v1/ingest/claude"


@pytest.fixture
def sends(monkeypatch, tmp_path):
    """Record each request body; the collector takes batches and is up."""
    sent: list = []
    monkeypatch.setattr(bridge, "SPOOL_PATH", tmp_path / "spool.jsonl")
    monkeypatch.setattr(bridge, "_collector_accepts_batches", lambda endpoint=None: True)
    monkeypatch.setattr(bridge, "_collector_reachable", lambda: True)
    monkeypatch.setattr(bridge, "_send_once", lambda url, body, timeout, **kw: sent.append(body) or True)
    return sent


def test_events_go_in_ordered_batches(sends, monkeypatch):
    monkeypatch.setattr(bridge, "_IMPORT_POST_BATCH", 3)
    poster = bridge._ImportPoster(URL)
    for i in range(7):
        poster.add({"n": i})
    poster.flush()
    assert sends == [[{"n": 0}, {"n": 1}, {"n": 2}], [{"n": 3}, {"n": 4}, {"n": 5}], {"n": 6}]


def test_attachment_goes_alone_after_what_came_before(sends):
    poster = bridge._ImportPoster(URL)
    poster.add({"n": 0})
    poster.add({"n": 1})
    poster.add({"_attach_to_prompt": True, "n": 2})
    poster.add({"n": 3})
    poster.flush()
    assert sends == [[{"n": 0}, {"n": 1}], {"_attach_to_prompt": True, "n": 2}, {"n": 3}]


def test_older_collector_gets_one_event_per_request(sends, monkeypatch):
    monkeypatch.setattr(bridge, "_collector_accepts_batches", lambda endpoint=None: False)
    poster = bridge._ImportPoster(URL)
    for i in range(3):
        poster.add({"n": i})
    poster.flush()
    assert sends == [{"n": 0}, {"n": 1}, {"n": 2}]


def test_undelivered_batch_is_spooled_in_order(monkeypatch, tmp_path):
    spooled: list = []
    monkeypatch.setattr(bridge, "SPOOL_PATH", tmp_path / "spool.jsonl")
    monkeypatch.setattr(bridge, "_collector_accepts_batches", lambda endpoint=None: True)
    monkeypatch.setattr(bridge, "_collector_reachable", lambda: True)
    monkeypatch.setattr(bridge, "_send_once", lambda url, body, timeout, **kw: False)
    monkeypatch.setattr(bridge, "_spool_append", lambda url, payload: spooled.append(payload) or True)
    poster = bridge._ImportPoster(URL)
    for i in range(3):
        poster.add({"n": i})
    poster.flush()
    assert spooled == [{"n": 0}, {"n": 1}, {"n": 2}]


def test_batch_treats_server_error_as_undelivered(monkeypatch, tmp_path):
    """One busy write must not drop a whole batch: a 5xx spools it for replay,
    while a single event keeps the old delivered-on-any-answer rule."""
    import urllib.error

    def boom(req, timeout):
        raise urllib.error.HTTPError(req.full_url, 500, "busy", {}, None)

    monkeypatch.setattr(bridge, "COLLECTOR_DOWN_PATH", tmp_path / "down")
    monkeypatch.setattr(bridge.urllib.request, "urlopen", boom)
    assert bridge._send_once(URL, [{"n": 0}, {"n": 1}], timeout=1, retry_5xx=True) is False
    assert bridge._send_once(URL, {"n": 0}, timeout=1) is True


def _claude_lines(sid: str) -> list[dict]:
    lines = [{"type": "user", "uuid": f"{sid}-p", "sessionId": sid, "cwd": "/proj",
              "timestamp": "2026-06-01T00:00:00Z",
              "message": {"role": "user", "content": "do the thing"}}]
    for t in range(30):
        ts = f"2026-06-01T00:{t + 1:02d}:00Z"
        lines.append({"type": "assistant", "uuid": f"{sid}-a{t}", "sessionId": sid, "timestamp": ts,
                      "message": {"role": "assistant", "model": "claude-sonnet-4-5", "content": [
                          {"type": "thinking", "thinking": f"step {t}"},
                          {"type": "text", "text": f"running {t}"},
                          {"type": "tool_use", "id": f"t{t}", "name": "Bash", "input": {"command": f"echo {t}"}},
                      ], "usage": {"input_tokens": 100, "output_tokens": 10}}})
        lines.append({"type": "user", "uuid": f"{sid}-r{t}", "sessionId": sid, "timestamp": ts,
                      "message": {"role": "user", "content": [
                          {"type": "tool_result", "tool_use_id": f"t{t}", "content": f"out {t}",
                           "is_error": t % 7 == 0},
                      ]}})
    return lines


def _import_into(db_file: Path, home: Path, monkeypatch, *, batched: bool) -> list[tuple]:
    """Run the Claude import into a fresh DB through the real ingest route."""
    from app import db, main

    monkeypatch.setenv("COT_DB_PATH", str(db_file))
    db.init_db()
    client = TestClient(main.app, base_url="http://127.0.0.1")
    requests = []

    def send(url, body, timeout, **kw):
        requests.append(body)
        assert client.post("/v1/ingest/claude", json=body).status_code == 200
        return True

    monkeypatch.setattr(bridge, "SPOOL_PATH", home / "spool.jsonl")
    monkeypatch.setattr(bridge, "_collector_accepts_batches", lambda endpoint=None: batched)
    monkeypatch.setattr(bridge, "_collector_reachable", lambda: True)
    monkeypatch.setattr(bridge, "_send_once", send)
    monkeypatch.setenv("COT_IMPORT_HOME", str(home))
    posted = bridge._import_agent("claude", None, {}, {}, verbose=False)
    assert posted > 100
    if batched:
        assert len(requests) < posted / 50
    else:
        assert len(requests) == posted

    conn = sqlite3.connect(db_file)
    try:
        return conn.execute(
            "SELECT session_id, hook, tool, phase, ts, category, title, target, detail, status,"
            " duration_ms, model, input_tokens, output_tokens, dedup_key, origin"
            " FROM events ORDER BY session_id, ts, dedup_key, hook, title"
        ).fetchall()
    finally:
        conn.close()


def test_batched_import_stores_what_single_posts_store(monkeypatch, tmp_path):
    home = tmp_path / "home"
    for n, sid in enumerate(("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222")):
        folder = home / ".claude" / "projects" / f"-proj-{n}"
        folder.mkdir(parents=True)
        (folder / f"{sid}.jsonl").write_text("".join(json.dumps(x) + "\n" for x in _claude_lines(sid)))

    single = _import_into(tmp_path / "single.db", home, monkeypatch, batched=False)
    batched = _import_into(tmp_path / "batched.db", home, monkeypatch, batched=True)
    assert single and batched == single
