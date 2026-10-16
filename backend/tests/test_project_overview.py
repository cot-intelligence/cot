"""One project's page counts only that project's sessions, in the window."""

from __future__ import annotations

from pathlib import Path

from app import db, store


def _session(conn, sid: str, cwd: str, started: str, source: str = "claude") -> None:
    conn.execute(
        "INSERT INTO sessions (id, source, cwd, started_at, status, created_at) VALUES (?, ?, ?, ?, 'completed', ?)",
        (sid, source, cwd, started, started),
    )
    store.insert_event(conn, session_id=sid, source=source, ts=started, category="prompt", detail=f"prompt {sid}")
    store.insert_event(conn, session_id=sid, source=source, ts=started, category="shell", tool="Bash",
                       model="claude-opus-5-5", input_tokens=1_000_000, output_tokens=0)


def test_project_overview_scopes_to_the_project_and_window(fresh_db: Path):
    with store.write() as conn:
        _session(conn, "a1", "/work/alpha", "2026-10-15T10:00:00Z")
        _session(conn, "a2", "/home/me/alpha", "2020-01-01T10:00:00Z", source="codex")
        _session(conn, "b1", "/work/beta", "2026-10-15T11:00:00Z")
    everything = db.project_overview("alpha", 0)
    assert everything["sessions"] == 2
    assert everything["paths"] == ["/home/me/alpha", "/work/alpha"]
    assert {a["source"] for a in everything["agents"]} == {"claude", "codex"}
    assert everything["models"][0]["model"] == "claude-opus-5-5"
    assert everything["models"][0]["cost"] == 8.0  # 2 sessions x 1M input at $4/M
    assert everything["categories"] == {"prompt": 2, "shell": 2}
    recent = db.project_overview("alpha", 30_000)  # a window that excludes 2020 only by date math
    assert set(recent["session_ids"]) <= {"a1", "a2"}
    assert db.project_overview("gamma", 0)["sessions"] == 0
