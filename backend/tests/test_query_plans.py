"""Guardrail: the hot read and ingest paths never scan the whole events table.

Every SQL statement the dashboard's hot endpoints and a hook ingest run is
captured and EXPLAINed. A plan line that scans ``events`` without an index means
that query reads every row's payload/detail blobs, seconds on a large DB, so a
change that introduces one fails here instead of in someone's dashboard.
"""

from __future__ import annotations

import re
import sqlite3
from pathlib import Path

from app import db, insights, store
from app.session_read import build_session_detail

_FULL_SCAN = re.compile(r"SCAN (events|e|ev|fp)\b")
_SKIP = ("PRAGMA", "BEGIN", "COMMIT", "SAVEPOINT", "RELEASE", "ROLLBACK", "CREATE", "INSERT INTO EVENTS (")


def _hook(session_id: str, **body) -> dict:
    return {"session_id": session_id, "cwd": "/proj", **body}


def test_hot_paths_use_indexes_on_events(fresh_db: Path, monkeypatch):
    db.ensure_query_indexes()
    db.ensure_insight_indexes()
    db.backfill_composer_mode()
    for i in range(3):
        sid = f"s{i}"
        db.record_ingest("claude", _hook(sid, hook_event_name="UserPromptSubmit", prompt=f"hello {i}"))
        db.record_ingest(
            "claude",
            _hook(sid, hook_event_name="PostToolUse", tool_name="Bash",
                  tool_input={"command": "ls"}, tool_response={"stdout": "x"}),
        )

    statements: dict[str, None] = {}
    connect = store._connect

    def traced() -> sqlite3.Connection:
        conn = connect()
        conn.set_trace_callback(lambda sql: statements.setdefault(" ".join(sql.split()), None))
        return conn

    monkeypatch.setattr(store, "_connect", traced)
    db.stats()
    db.list_sessions_page(limit=50)
    db.list_sessions_page(limit=50, q="hello")
    db.metrics("Asia/Kolkata")
    db.connections()
    db.session_window(30)
    build_session_detail("s0")
    insights.compute_insights(30)
    db.record_ingest(
        "claude",
        _hook("s0", hook_event_name="PostToolUse", tool_name="Read",
              tool_input={"file_path": "/a"}, tool_response={}),
    )
    monkeypatch.setattr(store, "_connect", connect)

    explained = 0
    scans: list[tuple[str, str]] = []
    with store.read() as conn:
        for sql in statements:
            if "events" not in sql or sql.upper().startswith(_SKIP):
                continue
            try:
                plan = [row[3] for row in conn.execute("EXPLAIN QUERY PLAN " + sql)]
            except sqlite3.Error:
                continue  # not explainable on its own (e.g. a trigger body)
            explained += 1
            scans += [(line, sql[:160]) for line in plan if _FULL_SCAN.match(line) and "INDEX" not in line]
    assert explained > 20  # the capture worked
    assert scans == []
