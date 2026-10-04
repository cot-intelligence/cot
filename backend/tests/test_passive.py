"""Passive mode: transcript scan, two-phase runs, the scheduler, the API, and a
real bridge import against a running collector."""

from __future__ import annotations

import json
import os
import socket
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import db, passive, store  # noqa: F401  (db before main: import cycle)


@pytest.fixture(autouse=True)
def _home(fresh_db, monkeypatch, tmp_path):
    """A throwaway home: agent folders and the bridge's ~/.cot state live here."""
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    for agent, env in (("claude", "COT_CLAUDE_HOME"), ("cursor", "COT_CURSOR_HOME"), ("codex", "COT_CODEX_HOME")):
        monkeypatch.setenv(env, str(home / f".{agent}"))
    monkeypatch.setenv("COT_PASSIVE_SCHEDULER", "0")
    return home


def _client() -> TestClient:
    from app.main import app

    return TestClient(app, base_url="http://127.0.0.1")


def _age(path: Path, minutes: float) -> None:
    """Make a transcript look last written ``minutes`` ago."""
    t = time.time() - minutes * 60
    os.utime(path, (t, t))


def _claude_transcript(home: Path, project: str, sid: str, prompt: str, *, age_min: float = 60) -> Path:
    path = home / ".claude" / "projects" / project / f"{sid}.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = [
        {"type": "user", "uuid": f"{sid}-p1", "sessionId": sid, "cwd": f"/Users/dev/code/{project}",
         "timestamp": "2026-09-01T10:00:00Z", "message": {"role": "user", "content": prompt}},
        {"type": "assistant", "uuid": f"{sid}-a1", "sessionId": sid, "timestamp": "2026-09-01T10:00:02Z",
         "message": {"role": "assistant", "model": "claude-sonnet-4-5", "content": [
             {"type": "text", "text": "Listing files"},
             {"type": "tool_use", "id": f"{sid}-t1", "name": "Bash", "input": {"command": "ls"}},
         ], "usage": {"input_tokens": 100, "output_tokens": 20}}},
        {"type": "user", "uuid": f"{sid}-r1", "sessionId": sid, "timestamp": "2026-09-01T10:00:03Z",
         "message": {"role": "user", "content": [
             {"type": "tool_result", "tool_use_id": f"{sid}-t1", "content": "README.md", "is_error": False},
         ]}},
        {"type": "assistant", "uuid": f"{sid}-a2", "sessionId": sid, "timestamp": "2026-09-01T10:00:05Z",
         "message": {"role": "assistant", "content": [{"type": "text", "text": "Done."}]}},
    ]
    path.write_text("\n".join(json.dumps(x) for x in lines) + "\n")
    _age(path, age_min)
    return path


SID_A = "11111111-1111-4111-8111-111111111111"
SID_B = "22222222-2222-4222-8222-222222222222"


def test_scan_reports_metadata_without_importing(_home):
    _claude_transcript(_home, "atlas", SID_A, "fix the deploy")
    _claude_transcript(_home, "ledger", SID_B, "add tests")
    s = passive.scan("claude")
    assert s["readable"] and s["transcripts"] == 2 and s["projects"] == 2 and s["bytes"] > 0
    assert s["oldest"] and s["newest"] and s["active"] == 0
    assert passive.scan("cursor")["readable"] is False  # no folder
    # Nothing was imported.
    assert passive._session_counts() == {}  # noqa: SLF001


def test_scan_refuses_folders_outside_home(monkeypatch, tmp_path):
    outside = tmp_path / "elsewhere"
    (outside / "projects" / "x").mkdir(parents=True)
    monkeypatch.setenv("COT_CLAUDE_HOME", str(outside))
    assert passive.scan("claude")["readable"] is False


def test_run_imports_then_analyzes_and_records_it(_home):
    _claude_transcript(_home, "atlas", SID_A, "fix the deploy")
    passive.update_config(agents=["claude", "cursor"])
    order: list[str] = []
    result = passive.run(
        "manual",
        importer=lambda a: order.append(f"import:{a}") or 7,
        analyzer=lambda: order.append("analyze") or 3,
    )
    # Cursor has no folder, so only Claude imports; analysis comes after.
    assert order == ["import:claude", "analyze"]
    assert result["status"] == "ok" and result["phase"] == "done"
    assert result["agents"] == {"claude": {"status": "ok", "events": 7, "held_back": 0}, "cursor": {"status": "unreadable"}}
    assert result["events"] == 7 and result["findings"] == 3
    stored = passive.runs(5)[0]
    assert stored["status"] == "ok" and stored["findings"] == 3 and stored["finished_at"]
    assert passive.running()["running"] is False


def test_one_agent_failing_keeps_the_others_going(_home):
    _claude_transcript(_home, "atlas", SID_A, "x")
    (_home / ".codex" / "sessions").mkdir(parents=True)
    passive.update_config(agents=["claude", "codex"])

    def importer(agent):
        if agent == "claude":
            raise RuntimeError("boom")
        return 2

    result = passive.run(importer=importer, analyzer=lambda: 0)
    assert result["status"] == "partial"
    assert result["agents"]["claude"]["status"] == "error" and result["agents"]["codex"]["events"] == 2


def test_due_waits_for_the_schedule():
    passive.update_config(enabled=True, expr="0 * * * *")
    t0 = datetime(2026, 10, 3, 10, 5, tzinfo=timezone.utc)
    assert passive.due(t0) is False  # first look only plans the next run (11:00)
    assert passive.due(t0 + timedelta(minutes=30)) is False
    assert passive.due(t0 + timedelta(minutes=55)) is True
    assert passive.due(t0 + timedelta(minutes=56)) is False  # next is 12:00
    passive.update_config(enabled=False)
    assert passive.due(t0 + timedelta(hours=5)) is False


def test_api_config_validation_and_preview(_home):
    _claude_transcript(_home, "atlas", SID_A, "x")
    client = _client()
    body = client.get("/v1/passive").json()
    assert body["enabled"] is False and body["cron"] == "0 * * * *"
    claude = next(a for a in body["agents_detail"] if a["agent"] == "claude")
    assert claude["readable"] and claude["transcripts"] == 1 and claude["sessions"] == 0

    res = client.put("/v1/passive", json={"enabled": True, "agents": ["claude"], "cron": "*/15 * * * *"})
    assert res.status_code == 200
    assert res.json()["schedule"]["description"] == "Every 15 minutes" and res.json()["agents"] == ["claude"]
    assert client.put("/v1/passive", json={"cron": "61 * * * *"}).status_code == 400

    ok = client.post("/v1/passive/schedule/preview", json={"cron": "30 18 * * 1-5"}).json()
    assert ok["valid"] and ok["description"] == "Weekdays at 18:30" and len(ok["next_runs"]) == 2
    assert client.get("/v1/passive/running").json() == {"running": {"running": False}, "last_run": None}
    bad = client.post("/v1/passive/schedule/preview", json={"cron": "nope"}).json()
    assert bad["valid"] is False and bad["error"]


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def test_real_import_builds_sessions_from_a_transcript(_home):
    """End to end: a live collector, the real bridge importer, a Claude transcript."""
    import uvicorn

    from app.main import app

    port = _free_port()
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="error"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    for _ in range(100):
        if server.started:
            break
        time.sleep(0.05)
    try:
        _claude_transcript(_home, "atlas", SID_A, "fix the flaky deploy")
        passive.update_config(agents=["claude"])

        def go():
            # In-process TestClient calls report port 80 to the self-URL
            # middleware; point the importer back at the real server each time.
            passive.self_url = f"http://127.0.0.1:{port}"
            return passive.run("manual", analyzer=lambda: 0)

        result = go()
        assert result["status"] == "ok", result
        assert result["agents"]["claude"]["events"] > 0 and result["new_sessions"] == 1
        listed = _client().get("/v1/sessions").json()["sessions"]
        assert [s["id"] for s in listed] == [SID_A]
        assert listed[0]["title"].startswith("fix the flaky deploy")
        # The bridge kept its offsets in the throwaway home, not the real ~/.cot.
        assert (_home / ".cot" / "import_offsets.json").exists()
        # A second pass reads nothing new.
        again = go()
        assert again["events"] == 0 and again["new_sessions"] == 0

        # A session still being written is held back whole, then imported once quiet.
        live = _claude_transcript(_home, "ledger", SID_B, "add tests", age_min=1)
        assert passive.scan("claude")["active"] == 1
        held = go()
        assert held["held_back"] == 1 and held["new_sessions"] == 0
        assert SID_B not in [s["id"] for s in _client().get("/v1/sessions").json()["sessions"]]
        _age(live, passive.ACTIVE_WINDOW_MIN + 5)
        later = go()
        assert later["held_back"] == 0 and later["new_sessions"] == 1
        assert SID_B in [s["id"] for s in _client().get("/v1/sessions").json()["sessions"]]
    finally:
        server.should_exit = True
        thread.join(timeout=5)
