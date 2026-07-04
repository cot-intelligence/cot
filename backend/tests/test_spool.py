"""Tests for the bridge event spool — the offline-durability path that queues
ingest events when the collector is unreachable and replays them in order on
the next successful contact.

Runnable with pytest or directly: ``python3 backend/tests/test_spool.py``.
"""

from __future__ import annotations

import importlib.machinery
import importlib.util
import json
import os
import sys
import tempfile
from pathlib import Path

_HERE = os.path.dirname(os.path.abspath(__file__))
_BACKEND = os.path.dirname(_HERE)
_REPO = os.path.dirname(_BACKEND)


def _load_bridge():
    path = os.path.join(_REPO, "bridge", "cot")
    loader = importlib.machinery.SourceFileLoader("cot_bridge_spool_under_test", path)
    spec = importlib.util.spec_from_loader("cot_bridge_spool_under_test", loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


bridge = _load_bridge()

INGEST = "http://127.0.0.1:31337/v1/ingest/claude"


class _Sink:
    """Stand-in collector: records deliveries and can be toggled up/down."""

    def __init__(self, up: bool = True) -> None:
        self.up = up
        self.delivered: list[dict] = []

    def send(self, url: str, payload: dict, timeout: float) -> bool:
        if not self.up:
            return False
        self.delivered.append(payload)
        return True


def _with_temp_spool(fn):
    """Point the bridge's spool at a throwaway dir for the duration of fn."""
    with tempfile.TemporaryDirectory() as d:
        state = Path(d)
        orig = (bridge.STATE_DIR, bridge.SPOOL_PATH, bridge.SPOOL_LOCK_PATH, bridge._send_once)
        bridge.STATE_DIR = state
        bridge.SPOOL_PATH = state / "spool.jsonl"
        bridge.SPOOL_LOCK_PATH = state / "spool.lock"
        try:
            fn(state)
        finally:
            (
                bridge.STATE_DIR,
                bridge.SPOOL_PATH,
                bridge.SPOOL_LOCK_PATH,
                bridge._send_once,
            ) = orig


def _spool_lines() -> list[dict]:
    if not bridge.SPOOL_PATH.exists():
        return []
    return [json.loads(ln) for ln in bridge.SPOOL_PATH.read_text().splitlines() if ln.strip()]


def test_post_spools_when_collector_down():
    def body(_state):
        sink = _Sink(up=False)
        bridge._send_once = sink.send
        bridge._post(INGEST, {"event_id": "e1"})
        queued = _spool_lines()
        assert len(queued) == 1
        assert queued[0]["payload"]["event_id"] == "e1"
        assert queued[0]["url"] == INGEST
        assert sink.delivered == []
    _with_temp_spool(body)


def test_flush_replays_in_order_and_clears():
    def body(_state):
        sink = _Sink(up=False)
        bridge._send_once = sink.send
        for i in range(3):
            bridge._post(INGEST, {"event_id": f"e{i}"})
        assert len(_spool_lines()) == 3

        sink.up = True
        assert bridge._spool_flush() is True
        assert [p["event_id"] for p in sink.delivered] == ["e0", "e1", "e2"]
        assert not bridge.SPOOL_PATH.exists()
    _with_temp_spool(body)


def test_post_drains_backlog_before_current_event():
    def body(_state):
        sink = _Sink(up=False)
        bridge._send_once = sink.send
        bridge._post(INGEST, {"event_id": "old"})  # queued while down

        sink.up = True
        bridge._post(INGEST, {"event_id": "new"})  # should drain old first
        assert [p["event_id"] for p in sink.delivered] == ["old", "new"]
        assert not bridge.SPOOL_PATH.exists()
    _with_temp_spool(body)


def test_down_during_flush_leaves_current_spooled_and_ordered():
    def body(_state):
        sink = _Sink(up=False)
        bridge._send_once = sink.send
        bridge._post(INGEST, {"event_id": "old"})
        # Collector still down: new event must queue AFTER old, nothing delivered.
        bridge._post(INGEST, {"event_id": "new"})
        assert sink.delivered == []
        assert [r["payload"]["event_id"] for r in _spool_lines()] == ["old", "new"]
    _with_temp_spool(body)


def test_non_ingest_failure_does_not_spool():
    def body(_state):
        sink = _Sink(up=False)
        bridge._send_once = sink.send
        bridge._post("http://127.0.0.1:31337/v1/audit/self", {"action": "x"})
        assert not bridge.SPOOL_PATH.exists()
    _with_temp_spool(body)


def test_byte_cap_drops_oldest():
    def body(_state):
        sink = _Sink(up=False)
        bridge._send_once = sink.send
        orig_cap = bridge._MAX_SPOOL_BYTES
        bridge._MAX_SPOOL_BYTES = 400  # tiny cap to force trimming
        try:
            for i in range(50):
                bridge._post(INGEST, {"event_id": f"e{i}", "pad": "x" * 40})
            lines = _spool_lines()
            assert lines, "spool should retain the most recent events"
            ids = [r["payload"]["event_id"] for r in lines]
            # Oldest were trimmed; the newest survives.
            assert ids[-1] == "e49"
            assert "e0" not in ids
        finally:
            bridge._MAX_SPOOL_BYTES = orig_cap
    _with_temp_spool(body)


def test_corrupt_line_is_skipped_not_wedged():
    def body(state):
        sink = _Sink(up=True)
        bridge._send_once = sink.send
        bridge.SPOOL_PATH.write_text(
            "not json\n" + json.dumps({"url": INGEST, "payload": {"event_id": "ok"}}) + "\n"
        )
        assert bridge._spool_flush() is True
        assert [p["event_id"] for p in sink.delivered] == ["ok"]
        assert not bridge.SPOOL_PATH.exists()
    _with_temp_spool(body)


def _run_all():
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in fns:
        fn()
        print(f"ok  {fn.__name__}")
    print(f"\n{len(fns)} passed")


if __name__ == "__main__":
    _run_all()
