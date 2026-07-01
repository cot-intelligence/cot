"""Tests for the historical transcript import pipeline.

Covers the bridge line parsers (Claude / Cursor / Codex) and how their output
flows through normalize.categorize, guarding the bugs the import rework fixed:
tool calls landing in the right category, tool results being captured, stable
dedup keys making re-imports idempotent, and Cursor timestamps deriving from
the transcript mtime instead of collapsing onto import time.

Runnable with pytest or directly: ``python3 backend/tests/test_import.py``.
"""

from __future__ import annotations

import importlib.machinery
import importlib.util
import os
import sys
from datetime import datetime, timezone

_HERE = os.path.dirname(os.path.abspath(__file__))
_BACKEND = os.path.dirname(_HERE)
_REPO = os.path.dirname(_BACKEND)

sys.path.insert(0, _BACKEND)
from app.normalize import normalize  # noqa: E402


def _load_bridge():
    path = os.path.join(_REPO, "bridge", "cot")
    loader = importlib.machinery.SourceFileLoader("cot_bridge_under_test", path)
    spec = importlib.util.spec_from_loader("cot_bridge_under_test", loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


bridge = _load_bridge()

# A fixed mtime so Cursor timestamp assertions are deterministic.
_MTIME = datetime(2026, 5, 1, 12, 0, 0, tzinfo=timezone.utc).timestamp()


def _categories(agent, parser, lines, *, mtime=None):
    """Parse JSONL objects and return (normalized events) for assertions."""
    state: dict = {}
    out = []
    for lineno, obj in enumerate(lines):
        for ev in parser(obj, "SID", lineno=lineno, mtime=mtime, state=state, path="/t.jsonl"):
            out.append((ev, normalize(agent, ev)))
    return out


# --- Cursor -----------------------------------------------------------------

def test_cursor_tool_calls_categorize_correctly():
    lines = [
        {"role": "user", "message": {"content": [{"type": "text", "text": "<user_query>\nhi\n</user_query>"}]}},
        {"role": "assistant", "message": {"content": [
            {"type": "text", "text": "working"},
            {"type": "tool_use", "name": "Read", "input": {"path": "/a.py"}},
            {"type": "tool_use", "name": "StrReplace", "input": {"path": "/a.py", "old_string": "x", "new_string": "y"}},
            {"type": "tool_use", "name": "Shell", "input": {"command": "ls"}},
            {"type": "tool_use", "name": "CallMcpTool", "input": {"server": "glean", "toolName": "search", "arguments": "{}"}},
            {"type": "tool_use", "name": "WebSearch", "input": {"search_term": "q"}},
            {"type": "tool_use", "name": "Task", "input": {"subagent_type": "explore", "description": "d"}},
        ]}},
    ]
    cats = [n["category"] for _, n in _categories("cursor", bridge._cursor_line_to_events, lines, mtime=_MTIME)]
    assert "prompt" in cats
    assert "response" in cats
    for expected in ("file_read", "file_edit", "shell", "mcp", "web", "subagent"):
        assert expected in cats, f"missing {expected}: {cats}"
    # No tool call should fall through to 'other'.
    assert "other" not in cats, cats


def test_cursor_tool_events_are_not_dangling_starts():
    """Cursor tool events render as standalone (end/instant), never an open
    'start' span that would dangle as ongoing in the timeline."""
    lines = [{"role": "assistant", "message": {"content": [
        {"type": "tool_use", "name": "Read", "input": {"path": "/a"}},
    ]}}]
    evs = _categories("cursor", bridge._cursor_line_to_events, lines, mtime=_MTIME)
    assert evs and all(n["phase"] in ("end", "instant") for _, n in evs)


def test_cursor_timestamps_derive_from_mtime_and_preserve_order():
    lines = [
        {"role": "user", "message": {"content": [{"type": "text", "text": "<user_query>\none\n</user_query>"}]}},
        {"role": "assistant", "message": {"content": [{"type": "text", "text": "two"}]}},
    ]
    evs = _categories("cursor", bridge._cursor_line_to_events, lines, mtime=_MTIME)
    tss = [n["ts"] for _, n in evs]
    # Anchored on the mtime day, not import-time.
    assert all(t.startswith("2026-05-01") for t in tss), tss
    # Strictly increasing in file order.
    assert tss == sorted(tss), tss


def test_cursor_dedup_keys_are_stable_across_reparse():
    lines = [{"role": "assistant", "message": {"content": [
        {"type": "tool_use", "name": "Shell", "input": {"command": "ls"}},
    ]}}]
    first = _categories("cursor", bridge._cursor_line_to_events, lines, mtime=_MTIME)
    second = _categories("cursor", bridge._cursor_line_to_events, lines, mtime=_MTIME)
    keys1 = [ev.get("_dedup_key") for ev, _ in first]
    keys2 = [ev.get("_dedup_key") for ev, _ in second]
    assert keys1 == keys2 and all(keys1)


# --- Claude -----------------------------------------------------------------

def test_claude_tool_result_paired_to_call():
    """tool_use (assistant) + tool_result (next user msg) become Pre/Post with
    the result body and matching tool name."""
    lines = [
        {"type": "assistant", "uuid": "u1", "timestamp": "2026-06-01T00:00:00Z",
         "message": {"role": "assistant", "content": [
             {"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "ls"}},
         ]}},
        {"type": "user", "uuid": "u2", "timestamp": "2026-06-01T00:00:01Z",
         "message": {"role": "user", "content": [
             {"type": "tool_result", "tool_use_id": "t1", "content": "file1\nfile2", "is_error": False},
         ]}},
    ]
    evs = _categories("claude", bridge._claude_line_to_events, lines)
    hooks = [(ev.get("hook_event_name"), n["category"], n["phase"]) for ev, n in evs]
    assert ("PreToolUse", "shell", "start") in hooks, hooks
    # The result is emitted as an end-phase shell event carrying the output.
    post = [ev for ev, n in evs if ev.get("hook_event_name") == "PostToolUse"]
    assert post and "file1" in str(post[0].get("tool_response")), hooks


def test_claude_tool_result_error_status():
    lines = [
        {"type": "assistant", "uuid": "u1", "timestamp": "2026-06-01T00:00:00Z",
         "message": {"role": "assistant", "content": [
             {"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "boom"}},
         ]}},
        {"type": "user", "uuid": "u2", "timestamp": "2026-06-01T00:00:01Z",
         "message": {"role": "user", "content": [
             {"type": "tool_result", "tool_use_id": "t1", "content": "err", "is_error": True},
         ]}},
    ]
    evs = _categories("claude", bridge._claude_line_to_events, lines)
    statuses = [n["status"] for ev, n in evs if ev.get("hook_event_name") == "PostToolUseFailure"]
    assert statuses == ["error"], [(ev.get("hook_event_name"), n["status"]) for ev, n in evs]


# --- Codex ------------------------------------------------------------------

def test_codex_function_call_and_output_pair():
    lines = [
        {"type": "response_item", "id": "l1", "timestamp": "2026-04-01T00:00:00Z",
         "payload": {"type": "function_call", "name": "exec_command",
                     "arguments": "{\"cmd\": \"pwd\"}", "call_id": "c1"}},
        {"type": "response_item", "id": "l2", "timestamp": "2026-04-01T00:00:01Z",
         "payload": {"type": "function_call_output", "call_id": "c1",
                     "output": "/home", "status": "completed"}},
    ]
    evs = _categories("codex", bridge._codex_line_to_events, lines)
    triples = [(ev.get("hook_event_name"), n["category"], n["phase"]) for ev, n in evs]
    assert ("PreToolUse", "shell", "start") in triples, triples
    assert ("PostToolUse", "shell", "end") in triples, triples


def test_codex_shell_command_is_shell():
    lines = [
        {"type": "response_item", "id": "l1", "timestamp": "2026-04-01T00:00:00Z",
         "payload": {"type": "function_call", "name": "shell_command",
                     "arguments": "{\"command\": \"git status --short\"}", "call_id": "c1"}},
    ]
    evs = _categories("codex", bridge._codex_line_to_events, lines)
    cats = [n["category"] for _, n in evs]
    assert cats == ["shell"], cats


def test_codex_apply_patch_is_file_edit():
    lines = [
        {"type": "response_item", "id": "l1", "timestamp": "2026-04-01T00:00:00Z",
         "payload": {"type": "custom_tool_call", "name": "apply_patch", "call_id": "c2",
                     "input": "*** Begin Patch\n*** Update File: /a/b.py\n+x\n*** End Patch"}},
    ]
    evs = _categories("codex", bridge._codex_line_to_events, lines)
    cats = [n["category"] for _, n in evs]
    assert "file_edit" in cats, cats


def test_codex_reasoning_with_text_becomes_thought():
    with_text = [{"type": "response_item", "id": "l1", "timestamp": "2026-04-01T00:00:00Z",
                  "payload": {"type": "reasoning", "summary": [{"type": "summary_text", "text": "thinking"}]}}]
    encrypted = [{"type": "response_item", "id": "l2", "timestamp": "2026-04-01T00:00:00Z",
                  "payload": {"type": "reasoning", "summary": [], "content": "None",
                              "encrypted_content": "gAAA..."}}]
    evs_text = _categories("codex", bridge._codex_line_to_events, with_text)
    evs_enc = _categories("codex", bridge._codex_line_to_events, encrypted)
    assert [n["category"] for _, n in evs_text] == ["thought"]
    # Encrypted/empty reasoning produces nothing rather than a blank thought.
    assert evs_enc == []


# --- AskQuestion answer recovery -------------------------------------------

from app.db import _cursor_question_response  # noqa: E402

_ROLLOUT_Q = {"questions": [{"id": "rollout", "prompt": "How should I run the rollout?", "options": [
    {"id": "rebuild_prod", "label": "Rebuild prod image + restart (Recommended): docker build the fixed cot image, then `cot reimport`."},
    {"id": "dev_compose", "label": "Dev compose: `just prod down` then `just dev up`, then `cot reimport`."},
    {"id": "code_only", "label": "Code only: don't touch the running container or DB."},
]}]}


def test_question_recovers_paraphrased_selection():
    resp = _cursor_question_response(_ROLLOUT_Q, "Rebuilding the prod image with the fixes. This builds the dashboard + backend into a fresh image.")
    picked = resp.get("answers", {}).get("rollout", {}).get("answers", [])
    assert picked and picked[0].startswith("Rebuild prod image"), resp


def test_question_ambiguous_text_records_nothing():
    resp = _cursor_question_response(_ROLLOUT_Q, "Okay, let me proceed with the next steps now.")
    assert resp == {}, resp


def test_question_matches_other_option_by_its_own_title():
    resp = _cursor_question_response(_ROLLOUT_Q, "Bringing up the dev compose stack via just dev up.")
    picked = resp.get("answers", {}).get("rollout", {}).get("answers", [])
    assert picked and picked[0].startswith("Dev compose"), resp


_NAMING_Q = {"questions": [{"id": "naming", "prompt": "What exact identifier and directory layout for the renamed plugin?", "options": [
    {"id": "kebab-both", "label": "security-architect everywhere (directories, plugin id, marketplace)"},
    {"id": "name-only", "label": "Rename the plugin name/identifier only; keep the existing directory names to minimize churn"},
    {"id": "other-name", "label": "Use a different id than 'security-architect'"},
]}]}


def test_question_recovers_choice_stated_after_acknowledgment():
    # Real shape: a short acknowledgment paragraph, then the explicit choice in
    # the next paragraph. The decision must still be recovered (not cut off).
    follow = (
        "Got it — full rename including the telemetry namespace. I'll fold this in as Phase 0.\n\n"
        "I'm settling on \"security-architect\" as the consistent naming across directories, "
        "the plugin configuration, and the marketplace listing."
    )
    resp = _cursor_question_response(_NAMING_Q, follow)
    picked = resp.get("answers", {}).get("naming", {}).get("answers", [])
    assert picked and picked[0].startswith("security-architect"), resp


# --- Categorization: meta bucket -------------------------------------------

def test_meta_tools_leave_other():
    base = {"session_id": "s", "_import": True, "timestamp": "2026-05-01T00:00:00Z",
            "hook_event_name": "PostToolUse"}
    for tool in ("TodoWrite", "AwaitShell", "SwitchMode", "ReadLints", "update_plan"):
        n = normalize("cursor", {**base, "tool_name": tool, "tool_input": {}})
        assert n["category"] == "meta", (tool, n["category"])
    # Genuinely unknown tools must still be 'other'.
    n = normalize("cursor", {**base, "tool_name": "SomeBrandNewTool", "tool_input": {}})
    assert n["category"] == "other", n["category"]


# --- Pricing: family-tier fallback -----------------------------------------

from app.pricing import cost_for as _cost_for  # noqa: E402


def test_pricing_known_model():
    assert _cost_for("claude-opus-4-8-thinking-medium", 1_000_000, 0, 0, 0) is not None


def test_pricing_tier_fallback_for_unknown_new_model():
    # Unknown future point-releases borrow the family-tier rate.
    assert _cost_for("claude-opus-4-9", 1_000_000, 0, 0, 0) is not None
    assert _cost_for("gemini-3.1-pro", 1_000_000, 0, 0, 0) is not None
    # Truly unknown families stay unpriced (None), never guessed.
    assert _cost_for("totally-unknown-model", 1_000_000, 0, 0, 0) is None


def test_pricing_variants_normalize_to_same_rate():
    a = _cost_for("claude-opus-4-8", 1_000_000, 0, 0, 0)
    b = _cost_for("claude-opus-4-8-thinking-high", 1_000_000, 0, 0, 0)
    assert a == b and a is not None


# --- Hook install merge ------------------------------------------------------

def test_hook_command_uses_home():
    assert bridge._hook_command("claude") == "$HOME/.cot/bin/cot hook claude"


def test_merge_hooks_does_not_false_positive_on_gryph():
    existing = {
        "SessionStart": [{
            "hooks": [{
                "type": "command",
                "command": "gryph _hook claude-code SessionStart",
            }],
        }],
    }
    template = bridge._hook_templates()["claude"]
    merged = bridge._merge_hooks(existing, template, "claude")
    cmds = [
        h["command"]
        for entry in merged["SessionStart"]
        for h in entry.get("hooks", [])
    ]
    assert any("gryph _hook claude-code" in c for c in cmds)
    assert "$HOME/.cot/bin/cot hook claude" in cmds


def test_merge_hooks_normalizes_legacy_absolute_path():
    existing = {
        "Stop": [{
            "hooks": [{
                "type": "command",
                "command": "/Users/user/.cot/bin/cot hook claude",
            }],
        }],
    }
    template = bridge._hook_templates()["claude"]
    merged = bridge._merge_hooks(existing, template, "claude")
    cmd = merged["Stop"][0]["hooks"][0]["command"]
    assert cmd == "$HOME/.cot/bin/cot hook claude"


def test_remove_hooks_preserves_gryph():
    existing = {
        "SessionStart": [
            {
                "hooks": [{
                    "type": "command",
                    "command": "gryph _hook claude-code SessionStart",
                }],
            },
            {
                "hooks": [{
                    "type": "command",
                    "command": "$HOME/.cot/bin/cot hook claude",
                }],
            },
        ],
    }
    cleaned = bridge._remove_hooks(existing, "claude")
    assert len(cleaned["SessionStart"]) == 1
    assert "gryph" in cleaned["SessionStart"][0]["hooks"][0]["command"]


def _run_all():
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    failed = 0
    for t in tests:
        try:
            t()
            print(f"PASS {t.__name__}")
        except AssertionError as exc:
            failed += 1
            print(f"FAIL {t.__name__}: {exc}")
        except Exception as exc:  # noqa: BLE001
            failed += 1
            print(f"ERROR {t.__name__}: {exc!r}")
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(_run_all())
