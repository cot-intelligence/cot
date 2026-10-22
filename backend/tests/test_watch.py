"""The transcript watcher debounces writes into one import per burst, imports
only enabled agents while passive mode is on, retries when a pass is running,
and imported sessions close only once they've gone quiet."""

from __future__ import annotations

import json
import threading
import time
from datetime import datetime, timedelta, timezone

import pytest

from app import db, passive, store, watch


@pytest.fixture
def passive_on(fresh_db):
    passive.update_config(enabled=True, agents=["claude", "codex"])
    return fresh_db


def test_burst_of_writes_is_one_import(passive_on):
    calls: list[list[str]] = []
    w = watch.Watcher(importer=lambda agents: calls.append(sorted(agents)) or True, debounce_s=0.05)
    for _ in range(20):
        w.notify("claude")
    w.notify("codex")
    w.run_once(threading.Event())
    assert calls == [["claude", "codex"]]


def test_waits_for_writes_to_go_quiet(passive_on):
    calls: list[float] = []
    w = watch.Watcher(importer=lambda agents: calls.append(time.monotonic()) or True, debounce_s=0.2)
    w.notify("claude")
    started = time.monotonic()
    threading.Timer(0.1, w.notify, args=("claude",)).start()  # still writing
    w.run_once(threading.Event())
    assert calls and calls[0] - started >= 0.28


def test_nothing_imports_while_passive_mode_is_off(fresh_db):
    passive.update_config(enabled=False, agents=["claude"])
    calls: list = []
    w = watch.Watcher(importer=lambda agents: calls.append(agents) or True, debounce_s=0.01)
    w.notify("claude")
    w.run_once(threading.Event())
    assert calls == []


def test_disabled_agent_is_not_imported(passive_on):
    calls: list = []
    w = watch.Watcher(importer=lambda agents: calls.append(agents) or True, debounce_s=0.01)
    w.notify("cursor")
    w.run_once(threading.Event())
    assert calls == []


def test_busy_lock_retries(passive_on, monkeypatch):
    monkeypatch.setattr(watch, "BUSY_RETRY_S", 0.01)
    results = iter([False, True])
    calls: list = []
    w = watch.Watcher(importer=lambda agents: calls.append(agents) or next(results), debounce_s=0.01)
    w.notify("claude")
    w.run_once(threading.Event())
    w.run_once(threading.Event())
    assert calls == [["claude"], ["claude"]]


def test_real_filesystem_events_trigger_an_import(passive_on, monkeypatch, tmp_path):
    pytest.importorskip("watchdog")
    root = tmp_path / ".claude" / "projects" / "-p"
    root.mkdir(parents=True)
    monkeypatch.setenv("COT_IMPORT_HOME", str(tmp_path))
    seen = threading.Event()
    w = watch.Watcher(importer=lambda agents: seen.set() or True, debounce_s=0.1)
    stop = threading.Event()
    try:
        assert w.start(stop) and set(w.roots) == {"claude"}
        time.sleep(0.5)  # let the stream start
        (root / "s.jsonl").write_text(json.dumps({"type": "user"}) + "\n")
        assert seen.wait(10)
    finally:
        stop.set()
        w.stop()


def _session_with_last_event(sid: str, minutes_ago: float) -> None:
    ts = (datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)).isoformat()
    db.record_ingests([("claude", {"session_id": sid, "hook_event_name": "UserPromptSubmit",
                                   "prompt": "hi", "timestamp": ts, "_import": True})])


def test_completion_leaves_sessions_still_being_written(fresh_db):
    _session_with_last_event("quiet", minutes_ago=30)
    _session_with_last_event("live", minutes_ago=1)
    assert db.complete_imported_sessions(quiet_seconds=600) == {"completed": 1}
    with store.read() as conn:
        status = dict(conn.execute("SELECT id, status FROM sessions").fetchall())
    assert status == {"quiet": "completed", "live": "active"}
    assert db.complete_imported_sessions() == {"completed": 1}  # an older bridge closes all
