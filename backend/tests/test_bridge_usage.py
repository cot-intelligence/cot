"""`cot capture` parses headless agent output; `cot sources` tags another machine's import."""

from __future__ import annotations

import importlib.machinery
import importlib.util
import json
from pathlib import Path

BRIDGE = Path(__file__).resolve().parents[2] / "bridge" / "cot"


def _bridge():
    loader = importlib.machinery.SourceFileLoader("cot_bridge_usage", str(BRIDGE))
    spec = importlib.util.spec_from_loader("cot_bridge_usage", loader)
    mod = importlib.util.module_from_spec(spec)
    loader.exec_module(mod)
    return mod


def test_capture_parses_claude_json_result():
    b = _bridge()
    out = b._capture_parse("claude", json.dumps({
        "type": "result", "total_cost_usd": 0.02, "num_turns": 3, "session_id": "s", "result": "ok",
        "usage": {"input_tokens": 5, "output_tokens": 7, "cache_read_input_tokens": 11, "cache_creation_input_tokens": 13},
        "modelUsage": {"a": {"outputTokens": 1}, "b": {"outputTokens": 9}},
    }))
    assert out["usage"] == {"input_tokens": 5, "output_tokens": 7, "cache_read_tokens": 11, "cache_write_tokens": 13}
    assert (out["cost_usd"], out["turns"], out["model"], out["result"]) == (0.02, 3, "b", "ok")


def test_capture_sums_codex_turns():
    b = _bridge()
    lines = [
        {"type": "thread.started", "thread_id": "t"},
        {"type": "turn.completed", "usage": {"input_tokens": 10, "cached_input_tokens": 4, "output_tokens": 2}},
        {"type": "item.completed", "item": {"type": "agent_message", "text": "done"}},
        {"type": "turn.completed", "usage": {"input_tokens": 1, "cached_input_tokens": 0, "output_tokens": 1}},
    ]
    out = b._capture_parse("codex", "\n".join(json.dumps(x) for x in lines) + "\nnot json\n")
    assert out["session_id"] == "t" and out["turns"] == 2 and out["result"] == "done"
    assert out["usage"]["input_tokens"] == 11 and out["usage"]["cache_read_tokens"] == 4


def test_sources_round_trip_and_import_tags_machine(tmp_path, monkeypatch):
    b = _bridge()
    monkeypatch.setattr(b, "SESSION_SOURCES_PATH", tmp_path / "session_sources.json")
    monkeypatch.setattr(b, "STATE_DIR", tmp_path)
    home = tmp_path / "devbox"
    home.mkdir()
    assert b._cmd_sources(["add", str(home), "--machine", "devbox"]) == 0
    assert b._session_sources() == [{"path": str(home), "machine": "devbox"}]

    seen = {}

    def fake_run(agents, **kwargs):
        seen["home"], seen["machine"] = b._import_home(), b._IMPORT_MACHINE
        return 3, []

    monkeypatch.setattr(b, "_run_import", fake_run)
    assert b._import_sources(["claude"]) == 3
    assert seen == {"home": home, "machine": "devbox"}
    assert b._IMPORT_HOME_OVERRIDE is None and b._IMPORT_MACHINE is None
    assert b._cmd_sources(["remove", "devbox"]) == 0 and b._session_sources() == []
