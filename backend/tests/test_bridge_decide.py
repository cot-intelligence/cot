"""The bridge's side of Block / Ask first: asking /v1/decide and replying per agent."""

from __future__ import annotations

import importlib.machinery
import importlib.util
import io
import json
import os
import sys
import urllib.error

_REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


def _load_bridge():
    path = os.path.join(_REPO, "bridge", "cot")
    loader = importlib.machinery.SourceFileLoader("cot_bridge_decide_under_test", path)
    spec = importlib.util.spec_from_loader("cot_bridge_decide_under_test", loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


bridge = _load_bridge()

_DENY = {"decision": "deny", "rule_id": "user.x", "rule_name": "No prod", "reason": "Blocked by cot rule “No prod”."}


class _Resp(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def _fake_collector(monkeypatch, answer):
    calls = []

    def urlopen(req, timeout=None):
        calls.append((req.full_url, timeout))
        if isinstance(answer, Exception):
            raise answer
        return _Resp(json.dumps(answer).encode())

    monkeypatch.setattr(bridge, "_collector_reachable", lambda: True)
    monkeypatch.setattr(bridge.urllib.request, "urlopen", urlopen)
    return calls


def test_claude_deny_reply():
    out = bridge._hook_response("claude", {"hook_event_name": "PreToolUse"}, _DENY)
    assert out == {"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": _DENY["reason"],
    }}


def test_cursor_ask_reply():
    out = bridge._hook_response("cursor", {"hook_event_name": "preToolUse"}, {**_DENY, "decision": "ask"})
    assert out == {"permission": "ask", "user_message": _DENY["reason"], "agent_message": _DENY["reason"]}


def test_no_decision_keeps_passive_replies():
    assert bridge._hook_response("claude", {"hook_event_name": "PreToolUse"}) == {
        "continue": True, "suppressOutput": True}
    assert bridge._hook_response("cursor", {"hook_event_name": "preToolUse"}) == {"continue": True}
    assert bridge._hook_response("codex", {"hook_event_name": "PreToolUse"}) is None


def test_decide_asks_only_on_pre_tool_hooks(monkeypatch):
    calls = _fake_collector(monkeypatch, _DENY)
    assert bridge._decide("claude", {"hook_event_name": "PreToolUse"}) == _DENY
    assert calls[0][0].endswith("/v1/decide/claude")
    assert calls[0][1] == bridge._DECIDE_TIMEOUT_S
    assert bridge._decide("claude", {"hook_event_name": "PostToolUse"}) is None
    assert bridge._decide("codex", {"hook_event_name": "PreToolUse"}) is None
    assert len(calls) == 1


def test_decide_allows_on_failure(monkeypatch):
    _fake_collector(monkeypatch, TimeoutError())
    assert bridge._decide("claude", {"hook_event_name": "PreToolUse"}) is None
    _fake_collector(monkeypatch, urllib.error.URLError("down"))
    assert bridge._decide("cursor", {"hook_event_name": "preToolUse"}) is None
    _fake_collector(monkeypatch, {"decision": "allow"})
    assert bridge._decide("claude", {"hook_event_name": "PreToolUse"}) is None


def test_decide_still_asks_inside_the_down_backoff(monkeypatch):
    # A slow ingest post marks the collector down; blocking must not lapse with it.
    calls = _fake_collector(monkeypatch, _DENY)
    monkeypatch.setattr(bridge, "_collector_reachable", lambda: False)
    assert bridge._decide("claude", {"hook_event_name": "PreToolUse"}) == _DENY
    assert len(calls) == 1
