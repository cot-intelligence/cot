"""Tests for the bridge event spool — the offline-durability path that queues
ingest events when the collector is unreachable and replays them in order on
the next successful contact.

Runnable with pytest or directly: ``python3 backend/tests/test_spool.py``.
"""

from __future__ import annotations

import importlib.machinery
import importlib.util
import io
import json
import os
import sys
import tempfile
import time
import urllib.error
import urllib.parse
from datetime import timezone
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
_REAL_SEND_ONCE = bridge._send_once
_REAL_PROBE_HEALTH = bridge._probe_health

INGEST = "http://127.0.0.1:31337/v1/ingest/claude"


class _Sink:
    """Stand-in collector: records deliveries and can be toggled up/down."""

    def __init__(self, up: bool = True) -> None:
        self.up = up
        self.urls: list[str] = []
        self.delivered: list[dict] = []

    def send(self, url: str, payload: dict, timeout: float) -> bool:
        if not self.up:
            return False
        self.urls.append(url)
        self.delivered.append(payload)
        return True


def _with_temp_spool(fn):
    """Point the bridge's spool at a throwaway dir for the duration of fn."""
    with tempfile.TemporaryDirectory() as d:
        state = Path(d)
        orig = (
            bridge.STATE_DIR,
            bridge.SPOOL_PATH,
            bridge.SPOOL_LOCK_PATH,
            bridge.COLLECTOR_DOWN_PATH,
            bridge._send_once,
            bridge._probe_health,
        )
        bridge.STATE_DIR = state
        bridge.SPOOL_PATH = state / "spool.jsonl"
        bridge.SPOOL_LOCK_PATH = state / "spool.lock"
        bridge.COLLECTOR_DOWN_PATH = state / "collector_down"
        bridge._down_since = None
        try:
            fn(state)
        finally:
            (
                bridge.STATE_DIR,
                bridge.SPOOL_PATH,
                bridge.SPOOL_LOCK_PATH,
                bridge.COLLECTOR_DOWN_PATH,
                bridge._send_once,
                bridge._probe_health,
            ) = orig
            bridge._down_since = None


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
        assert queued[0]["path"] == "/v1/ingest/claude"
        assert "url" not in queued[0]
        assert sink.delivered == []
    _with_temp_spool(body)


def test_spooled_event_keeps_capture_time_not_replay_time():
    # Codex/Claude hook payloads carry no timestamp, so the collector stamps
    # arrival time. A replayed event must keep when it happened, or a whole
    # outage's tool calls land after the transcript-timed thoughts around them.
    def body(_state):
        sink = _Sink(up=False)
        bridge._send_once = sink.send
        bridge._post(INGEST, {"event_id": "e1"})
        bridge._post(INGEST, {"event_id": "e2", "timestamp": "2026-01-01T00:00:00Z"})
        captured = [r["payload"].get("timestamp") for r in _spool_lines()]
        assert captured[0] and captured[0].endswith("+00:00")
        assert captured[1] == "2026-01-01T00:00:00Z"  # an agent-supplied ts wins

        sink.up = True
        assert bridge._spool_flush() is True
        assert [p.get("timestamp") for p in sink.delivered] == captured
    _with_temp_spool(body)


def test_spooled_hook_keeps_hook_start_time_when_collector_hangs():
    # A hanging collector costs each failed send a full timeout before the event
    # is spooled, and a Codex hook can post several events first. The capture
    # time must be when the hook fired, not when spooling finally happened.
    from datetime import datetime, timedelta

    def body(state):
        def slow_down(url, payload, timeout):
            time.sleep(0.5)
            return False

        bridge._send_once = slow_down
        orig = (sys.argv, sys.stdin, sys.stdout)
        sys.argv = ["cot", "hook", "codex"]
        sys.stdin = io.StringIO(json.dumps({
            "session_id": "hang-test",
            "hook_event_name": "PreToolUse",
            "tool_name": "Bash",
            "tool_input": {"command": "true"},
            "tool_use_id": "call-1",
            "transcript_path": str(state / "missing.jsonl"),
        }))
        sys.stdout = io.StringIO()
        fired = datetime.now(timezone.utc)
        try:
            bridge.main()
        finally:
            sys.argv, sys.stdin, sys.stdout = orig
            bridge._HOOK_CAPTURED_AT = None
        [rec] = _spool_lines()
        captured = datetime.fromisoformat(rec["payload"]["timestamp"])
        assert captured - fired < timedelta(seconds=0.25), captured - fired
    _with_temp_spool(body)


def test_flush_retargets_legacy_url_to_current_endpoint():
    def body(_state):
        sink = _Sink(up=True)
        bridge._send_once = sink.send
        original_endpoint = bridge.COT_ENDPOINT
        bridge.COT_ENDPOINT = "http://127.0.0.1:31337"
        try:
            bridge.SPOOL_PATH.write_text(json.dumps({
                "url": "http://127.0.0.1:31338/v1/ingest/codex?source=hook",
                "payload": {"event_id": "legacy"},
            }) + "\n")
            assert bridge._spool_flush() is True
        finally:
            bridge.COT_ENDPOINT = original_endpoint

        assert sink.urls == [
            "http://127.0.0.1:31337/v1/ingest/codex?source=hook"
        ]
        assert [p["event_id"] for p in sink.delivered] == ["legacy"]
        assert not bridge.SPOOL_PATH.exists()
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


class _FakeNet:
    """Stands in for urlopen, so the real send path runs. "hang" mimics a
    collector that accepts connections and never answers."""

    def __init__(self, mode: str) -> None:
        self.mode = mode
        self.calls: list[tuple[str, float]] = []

    def __call__(self, req, timeout=None):
        url = req if isinstance(req, str) else req.full_url
        self.calls.append((urllib.parse.urlsplit(url).path, timeout))
        if self.mode == "hang":
            time.sleep(0.05)
            raise TimeoutError("timed out")
        if self.mode == "http_error":
            raise urllib.error.HTTPError(url, 500, "boom", {}, None)
        return io.BytesIO(b"{}")


def _with_fake_net(mode: str, fn):
    def body(state):
        net = _FakeNet(mode)
        bridge._send_once = _REAL_SEND_ONCE
        bridge._probe_health = _REAL_PROBE_HEALTH
        orig = bridge.urllib.request.urlopen
        bridge.urllib.request.urlopen = net
        try:
            fn(state, net)
        finally:
            bridge.urllib.request.urlopen = orig
    _with_temp_spool(body)


def test_hung_collector_costs_one_timeout_per_hook_run():
    def body(_state, net):
        for i in range(5):
            bridge._post(INGEST, {"event_id": f"e{i}"})
        assert len(net.calls) == 1  # only the first send waited on the network
        assert [r["payload"]["event_id"] for r in _spool_lines()] == [f"e{i}" for i in range(5)]
        assert bridge.COLLECTOR_DOWN_PATH.exists()
    _with_fake_net("hang", body)


def test_down_marker_is_shared_across_hook_runs():
    def body(_state, net):
        bridge._post(INGEST, {"event_id": "first-run"})
        bridge._down_since = None  # a fresh hook process only sees the marker
        net.calls.clear()
        bridge._post(INGEST, {"event_id": "second-run"})
        assert net.calls == []
        assert [r["payload"]["event_id"] for r in _spool_lines()] == ["first-run", "second-run"]
    _with_fake_net("hang", body)


def _age_marker() -> None:
    old = time.time() - bridge._DOWN_BACKOFF_S - 1
    os.utime(bridge.COLLECTOR_DOWN_PATH, (old, old))
    bridge._down_since = None


def test_stale_marker_probe_fails_fast_while_still_hung():
    def body(_state, net):
        bridge._post(INGEST, {"event_id": "e0"})
        _age_marker()
        net.calls.clear()
        bridge._post(INGEST, {"event_id": "e1"})
        assert net.calls == [("/health", bridge._PROBE_TIMEOUT_S)]
        assert time.time() - bridge.COLLECTOR_DOWN_PATH.stat().st_mtime < 1  # refreshed
        assert len(_spool_lines()) == 2
    _with_fake_net("hang", body)


def test_stale_marker_recovers_and_drains_in_order():
    def body(_state, net):
        bridge._post(INGEST, {"event_id": "queued"})
        _age_marker()
        net.mode = "up"
        net.calls.clear()
        bridge._post(INGEST, {"event_id": "live"})
        assert [c[0] for c in net.calls] == ["/health", "/v1/ingest/claude", "/v1/ingest/claude"]
        assert not bridge.COLLECTOR_DOWN_PATH.exists()
        assert not bridge.SPOOL_PATH.exists()
    _with_fake_net("hang", body)


def test_http_error_is_not_an_outage():
    def body(_state, net):
        bridge._post(INGEST, {"event_id": "rejected"})
        bridge._post(INGEST, {"event_id": "next"})
        assert len(net.calls) == 2
        assert not bridge.COLLECTOR_DOWN_PATH.exists()
        assert not bridge.SPOOL_PATH.exists()
    _with_fake_net("http_error", body)


def test_codex_hook_with_transcript_events_waits_once_when_hung():
    # The real slowdown: a Codex hook posts its transcript events and then
    # itself, and each used to wait out a full timeout.
    def body(state, net):
        sid = "hang-codex"
        now = "2026-09-22T07:25:56.790Z"
        transcript = state / "rollout.jsonl"
        lines = [{"timestamp": now, "type": "session_meta", "payload": {"id": sid}}]
        for i in range(3):
            lines.append({"timestamp": now, "type": "response_item", "payload": {
                "type": "message", "role": "assistant",
                "content": [{"type": "output_text", "text": f"step {i}"}]}})
        transcript.write_text("".join(json.dumps(line) + "\n" for line in lines))
        orig = (sys.argv, sys.stdin, sys.stdout, bridge.TRANSCRIPT_OFFSETS)
        bridge.TRANSCRIPT_OFFSETS = state / "transcript_offsets.json"
        sys.argv = ["cot", "hook", "codex"]
        sys.stdin = io.StringIO(json.dumps({
            "session_id": sid, "hook_event_name": "PreToolUse", "tool_name": "Bash",
            "tool_input": {"command": "true"}, "tool_use_id": "call-1",
            "transcript_path": str(transcript),
        }))
        sys.stdout = io.StringIO()
        try:
            bridge.main()
        finally:
            sys.argv, sys.stdin, sys.stdout, bridge.TRANSCRIPT_OFFSETS = orig
            bridge._HOOK_CAPTURED_AT = None
        assert len(_spool_lines()) >= 2, "transcript events and the hook should all spool"
        assert len(net.calls) == 1, net.calls
    _with_fake_net("hang", body)


def _run_all():
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for fn in fns:
        fn()
        print(f"ok  {fn.__name__}")
    print(f"\n{len(fns)} passed")


if __name__ == "__main__":
    _run_all()
