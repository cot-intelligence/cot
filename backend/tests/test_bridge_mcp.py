"""`cot mcp`: the bridge's read-only MCP server over stdio."""

from __future__ import annotations

import importlib.machinery
import importlib.util
import io
import json
import os
import sys
import urllib.error
from datetime import datetime, timedelta, timezone

_REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


def _load_bridge():
    path = os.path.join(_REPO, "bridge", "cot")
    loader = importlib.machinery.SourceFileLoader("cot_bridge_mcp_under_test", path)
    spec = importlib.util.spec_from_loader("cot_bridge_mcp_under_test", loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


bridge = _load_bridge()


def _ago(days: float) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()


def _serve(monkeypatch, *messages) -> list[dict]:
    monkeypatch.setattr(sys, "stdin", io.StringIO("\n".join(json.dumps(m) for m in messages) + "\n"))
    out = io.StringIO()
    monkeypatch.setattr(sys, "stdout", out)
    assert bridge._cmd_mcp([]) == 0
    return [json.loads(line) for line in out.getvalue().splitlines()]


def _call(name: str, args: dict, req_id: int = 1) -> dict:
    return {"jsonrpc": "2.0", "id": req_id, "method": "tools/call", "params": {"name": name, "arguments": args}}


def test_handshake_and_tool_list(monkeypatch):
    replies = _serve(
        monkeypatch,
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2024-11-05"}},
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
        {"jsonrpc": "2.0", "id": 3, "method": "nope"},
    )
    # The notification gets no reply.
    assert [r["id"] for r in replies] == [1, 2, 3]
    assert replies[0]["result"]["protocolVersion"] == "2024-11-05"
    assert replies[0]["result"]["capabilities"] == {"tools": {"listChanged": False}}
    tools = replies[1]["result"]["tools"]
    assert {t["name"] for t in tools} >= {"list_sessions", "get_session", "explain_session_cost", "search"}
    writers = {"save_analysis", "run_analysis", "apply_deliverable", "ask_followup"}
    assert {t["name"] for t in tools if not t["annotations"]["readOnlyHint"]} == writers
    assert all(t["inputSchema"]["type"] == "object" for t in tools)
    assert replies[2]["error"]["code"] == -32601


def test_unknown_protocol_version_gets_the_latest(monkeypatch):
    [reply] = _serve(monkeypatch, {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "1999-01-01"}})
    assert reply["result"]["protocolVersion"] == bridge._MCP_PROTOCOLS[0]


def test_malformed_lines_are_parse_errors(monkeypatch):
    monkeypatch.setattr(sys, "stdin", io.StringIO("not json\n"))
    out = io.StringIO()
    monkeypatch.setattr(sys, "stdout", out)
    bridge._cmd_mcp([])
    assert json.loads(out.getvalue())["error"]["code"] == -32700


def test_list_sessions_filters_by_window_and_rating(monkeypatch):
    calls = []

    def fake_get(path, params=None):
        calls.append((path, params))
        return {"sessions": [
            {"id": "new-up", "title": "a", "source": "claude", "last_activity": _ago(1), "rating": 1, "has_cost": True, "cost_usd": 1.5, "tokens": {"total": 10}},
            {"id": "new-down", "title": "b", "source": "claude", "last_activity": _ago(2), "rating": -1, "has_cost": False, "cost_usd": 0, "tokens": {"total": 5}},
            {"id": "old-up", "title": "c", "source": "codex", "last_activity": _ago(30), "rating": 1, "has_cost": False, "cost_usd": 0, "tokens": {}},
        ]}

    monkeypatch.setattr(bridge, "_mcp_get", fake_get)
    [reply] = _serve(monkeypatch, _call("list_sessions", {"days": 7, "rating": "up", "agent": "claude"}))
    data = json.loads(reply["result"]["content"][0]["text"])
    assert [s["id"] for s in data["sessions"]] == ["new-up"]
    assert data["sessions"][0]["rating"] == "up" and data["sessions"][0]["cost_usd"] == 1.5
    assert calls[0][1]["source"] == "claude"


def test_get_session_keeps_prompts_and_failures(monkeypatch):
    events = [{"id": 1, "category": "prompt", "detail": "do it", "ts": "t"}]
    events += [{"id": 10 + i, "category": "shell", "tool": "Bash", "target": f"cmd {i}", "ts": "t"} for i in range(30)]
    events += [{"id": 99, "category": "shell", "tool": "Bash", "target": "boom", "status": "error", "ts": "t"}]
    events += [{"id": 100, "category": "thought", "detail": "hmm", "ts": "t"}]

    def fake_get(path, params=None):
        if path.endswith("/annotations"):
            return {"session": {"rating": -1, "labels": ["looped"]}, "events": []}
        return {"summary": {"id": "s1", "title": "t"}, "events": events, "links": {"children": [{"type": "subagent", "session_id": "c1"}]}}

    monkeypatch.setattr(bridge, "_mcp_get", fake_get)
    [reply] = _serve(monkeypatch, _call("get_session", {"session_id": "s1", "max_events": 10}))
    data = json.loads(reply["result"]["content"][0]["text"])
    ids = [e["event_id"] for e in data["events"]]
    assert 1 in ids and 99 in ids and 100 not in ids
    assert len(ids) == 10 and data["events_omitted"] == 22
    assert data["subagents"] == ["c1"]
    assert data["annotation"]["labels"] == ["looped"]


def test_unreachable_collector_is_a_tool_error_not_a_crash(monkeypatch):
    def down(path, params=None):
        raise urllib.error.URLError("connection refused")

    monkeypatch.setattr(bridge, "_mcp_get", down)
    [reply] = _serve(monkeypatch, _call("search", {"query": "deploy"}))
    assert reply["result"]["isError"] is True
    assert "not reachable" in reply["result"]["content"][0]["text"]


def test_bad_arguments_are_tool_errors(monkeypatch):
    monkeypatch.setattr(bridge, "_mcp_get", lambda path, params=None: {})
    replies = _serve(monkeypatch, _call("search", {"query": "x"}, 1), _call("get_session", {}, 2), _call("nope", {}, 3))
    assert all(r["result"]["isError"] for r in replies)
