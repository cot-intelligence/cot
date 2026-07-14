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
    # Codex defers the last assistant message until flush; release it so tests
    # see it (a no-op for the other parsers).
    for ev in bridge._codex_flush_pending(state):  # noqa: SLF001
        out.append((ev, normalize(agent, ev)))
    return out


# --- Cursor -----------------------------------------------------------------

def test_cursor_adapter_emits_canonical_ingest_events():
    lines = [
        {"role": "user", "message": {"content": [{"type": "text", "text": "<user_query>\nhi\n</user_query>"}]}},
        {"role": "assistant", "message": {"content": [
            {"type": "thinking", "thinking": "planning"},
            {"type": "text", "text": "working"},
            {"type": "tool_use", "name": "StrReplace", "input": {"path": "/a.py"}},
        ]}},
    ]
    state: dict = {}
    events = []
    for lineno, obj in enumerate(lines):
        events.extend(
            bridge._cursor_line_to_ingest_events(  # noqa: SLF001
                obj, "SID", lineno=lineno, mtime=_MTIME, state=state, path="/t.jsonl"
            )
        )

    assert [ev["kind"] for ev in events] == ["prompt", "thought", "response", "tool_call"], events
    assert events[0]["text"] == "hi"
    assert events[0]["origin"] == "import"
    assert events[0]["dedup_key"] == "/t.jsonl:0:prompt"
    tool = events[-1]
    assert tool["phase"] == "instant"
    assert tool["tool_name"] == "StrReplace"
    assert tool["tool_input"] == {"path": "/a.py"}
    # The canonical seam should not expose the collector's hook-shaped transport fields.
    assert all("hook_event_name" not in ev for ev in events), events
    assert all("_dedup_key" not in ev and "_synthetic_category" not in ev for ev in events), events


def test_cursor_canonical_events_adapt_to_existing_hook_payloads():
    line = {"role": "assistant", "message": {"content": [
        {"type": "text", "text": "done"},
        {"type": "tool_use", "name": "Shell", "input": {"command": "ls"}},
    ]}}
    hooks = bridge._cursor_line_to_events(line, "SID", lineno=2, mtime=_MTIME, path="/t.jsonl")  # noqa: SLF001
    assert [(ev.get("hook_event_name"), ev.get("_synthetic_category")) for ev in hooks] == [
        ("afterAgentResponse", "response"),
        ("PostToolUse", None),
    ], hooks
    assert hooks[0]["_import"] is True
    assert hooks[0]["_dedup_key"] == "/t.jsonl:2:resp:0"
    assert hooks[1]["tool_name"] == "Shell"
    assert hooks[1]["_dedup_key"] == "/t.jsonl:2:tool:1"


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
    cats = [n["category"] for _, n in _categories("cursor", bridge._cursor_line_to_events, lines, mtime=_MTIME)]  # noqa: SLF001
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
    evs = _categories("cursor", bridge._cursor_line_to_events, lines, mtime=_MTIME)  # noqa: SLF001
    assert evs and all(n["phase"] in ("end", "instant") for _, n in evs)


def test_cursor_timestamps_derive_from_mtime_and_preserve_order():
    lines = [
        {"role": "user", "message": {"content": [{"type": "text", "text": "<user_query>\none\n</user_query>"}]}},
        {"role": "assistant", "message": {"content": [{"type": "text", "text": "two"}]}},
    ]
    evs = _categories("cursor", bridge._cursor_line_to_events, lines, mtime=_MTIME)  # noqa: SLF001
    tss = [n["ts"] for _, n in evs]
    # Anchored on the mtime day, not import-time.
    assert all(t.startswith("2026-05-01") for t in tss), tss
    # Strictly increasing in file order.
    assert tss == sorted(tss), tss


def test_cursor_dedup_keys_are_stable_across_reparse():
    lines = [{"role": "assistant", "message": {"content": [
        {"type": "tool_use", "name": "Shell", "input": {"command": "ls"}},
    ]}}]
    first = _categories("cursor", bridge._cursor_line_to_events, lines, mtime=_MTIME)  # noqa: SLF001
    second = _categories("cursor", bridge._cursor_line_to_events, lines, mtime=_MTIME)  # noqa: SLF001
    keys1 = [ev.get("_dedup_key") for ev, _ in first]
    keys2 = [ev.get("_dedup_key") for ev, _ in second]
    assert keys1 == keys2 and all(keys1)


# --- Claude -----------------------------------------------------------------

def test_claude_adapter_emits_canonical_tool_call_and_result():
    lines = [
        {"type": "assistant", "uuid": "u1", "timestamp": "2026-06-01T00:00:00Z",
         "message": {"role": "assistant", "content": [
             {"type": "thinking", "thinking": "checking"},
             {"type": "text", "text": "I will list files"},
             {"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "ls"}},
         ]}},
        {"type": "user", "uuid": "u2", "timestamp": "2026-06-01T00:00:01Z",
         "message": {"role": "user", "content": [
             {"type": "tool_result", "tool_use_id": "t1", "content": "file1", "is_error": False},
         ]}},
    ]
    state: dict = {}
    events = []
    for lineno, obj in enumerate(lines):
        events.extend(
            bridge._claude_line_to_ingest_events(  # noqa: SLF001
                obj, "SID", lineno=lineno, state=state, path="/claude.jsonl"
            )
        )

    assert [ev["kind"] for ev in events] == ["thought", "response", "tool_call", "tool_call"], events
    pre = events[2]
    post = events[3]
    assert pre["phase"] == "start" and pre["tool_name"] == "Bash", pre
    assert post["phase"] == "end" and post["tool_response"] == "file1", post
    assert post["tool_input"] == {"command": "ls"}, post
    assert all("hook_event_name" not in ev for ev in events), events
    assert all("_dedup_key" not in ev and "_synthetic_category" not in ev for ev in events), events


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
    evs = _categories("claude", bridge._claude_line_to_events, lines)  # noqa: SLF001
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
    evs = _categories("claude", bridge._claude_line_to_events, lines)  # noqa: SLF001
    statuses = [n["status"] for ev, n in evs if ev.get("hook_event_name") == "PostToolUseFailure"]
    assert statuses == ["error"], [(ev.get("hook_event_name"), n["status"]) for ev, n in evs]


# --- Codex ------------------------------------------------------------------

def test_codex_adapter_emits_canonical_tool_call_and_result():
    state: dict = {}
    call = {"type": "response_item", "id": "l1", "timestamp": "2026-04-01T00:00:00Z",
            "payload": {"type": "function_call", "name": "exec_command",
                        "arguments": "{\"cmd\": \"pwd\"}", "call_id": "c1"}}
    output = {"type": "response_item", "id": "l2", "timestamp": "2026-04-01T00:00:01Z",
              "payload": {"type": "function_call_output", "call_id": "c1",
                          "output": "/home", "status": "completed"}}

    events = []
    events.extend(bridge._codex_line_to_ingest_events(call, "SID", state=state))  # noqa: SLF001
    events.extend(bridge._codex_line_to_ingest_events(output, "SID", state=state))  # noqa: SLF001

    assert [ev["kind"] for ev in events] == ["tool_call", "tool_call"], events
    assert events[0]["phase"] == "start"
    assert events[0]["tool_name"] == "Bash"
    assert events[0]["tool_input"] == {"command": "pwd"}
    assert events[1]["phase"] == "end"
    assert events[1]["tool_response"] == "/home"
    assert all("hook_event_name" not in ev and "_dedup_key" not in ev for ev in events), events


def test_codex_canonical_pending_response_folds_token_usage():
    state: dict = {}
    lines = [
        {"type": "response_item", "id": "m1", "timestamp": "2026-04-01T00:00:00Z",
         "payload": {"type": "message", "role": "assistant", "phase": "final_answer",
                     "content": [{"type": "output_text", "text": "done"}]}},
        {"type": "event_msg", "timestamp": "2026-04-01T00:00:01Z",
         "payload": {"type": "token_count", "info": {"last_token_usage": {
             "input_tokens": 100, "cached_input_tokens": 40, "output_tokens": 20}}}},
    ]
    assert bridge._codex_line_to_ingest_events(lines[0], "SID", state=state) == []  # noqa: SLF001
    assert bridge._codex_line_to_ingest_events(lines[1], "SID", state=state) == []  # noqa: SLF001
    flushed = bridge._codex_flush_pending_ingest_events(state)  # noqa: SLF001
    assert len(flushed) == 1, flushed
    event = flushed[0]
    assert event["kind"] == "response", event
    assert event["text"] == "done", event
    assert event["usage"]["input_tokens"] == 100, event
    assert event["usage"]["cached_input_tokens"] == 40, event
    assert "hook_event_name" not in event and "_synthetic_category" not in event, event


def test_codex_function_call_and_output_pair():
    lines = [
        {"type": "response_item", "id": "l1", "timestamp": "2026-04-01T00:00:00Z",
         "payload": {"type": "function_call", "name": "exec_command",
                     "arguments": "{\"cmd\": \"pwd\"}", "call_id": "c1"}},
        {"type": "response_item", "id": "l2", "timestamp": "2026-04-01T00:00:01Z",
         "payload": {"type": "function_call_output", "call_id": "c1",
                     "output": "/home", "status": "completed"}},
    ]
    evs = _categories("codex", bridge._codex_line_to_events, lines)  # noqa: SLF001
    triples = [(ev.get("hook_event_name"), n["category"], n["phase"]) for ev, n in evs]
    assert ("PreToolUse", "shell", "start") in triples, triples
    assert ("PostToolUse", "shell", "end") in triples, triples


def test_codex_apply_patch_is_file_edit():
    lines = [
        {"type": "response_item", "id": "l1", "timestamp": "2026-04-01T00:00:00Z",
         "payload": {"type": "custom_tool_call", "name": "apply_patch", "call_id": "c2",
                     "input": "*** Begin Patch\n*** Update File: /a/b.py\n+x\n*** End Patch"}},
    ]
    evs = _categories("codex", bridge._codex_line_to_events, lines)  # noqa: SLF001
    cats = [n["category"] for _, n in evs]
    assert "file_edit" in cats, cats


def test_codex_reasoning_with_text_becomes_thought():
    with_text = [{"type": "response_item", "id": "l1", "timestamp": "2026-04-01T00:00:00Z",
                  "payload": {"type": "reasoning", "summary": [{"type": "summary_text", "text": "thinking"}]}}]
    encrypted = [{"type": "response_item", "id": "l2", "timestamp": "2026-04-01T00:00:00Z",
                  "payload": {"type": "reasoning", "summary": [], "content": "None",
                              "encrypted_content": "gAAA..."}}]
    evs_text = _categories("codex", bridge._codex_line_to_events, with_text)  # noqa: SLF001
    evs_enc = _categories("codex", bridge._codex_line_to_events, encrypted)  # noqa: SLF001
    assert [n["category"] for _, n in evs_text] == ["thought"]
    # Encrypted/empty reasoning produces nothing rather than a blank thought.
    assert evs_enc == []


def test_codex_token_count_folds_onto_message():
    lines = [
        {"type": "response_item", "id": "m1", "timestamp": "2026-04-01T00:00:00Z",
         "payload": {"type": "message", "role": "assistant", "phase": "final_answer",
                     "content": [{"type": "output_text", "text": "done"}]}},
        {"type": "event_msg", "timestamp": "2026-04-01T00:00:01Z",
         "payload": {"type": "token_count", "info": {"last_token_usage": {
             "input_tokens": 100, "cached_input_tokens": 40, "output_tokens": 20,
             "reasoning_output_tokens": 5, "total_tokens": 125}}}},
    ]
    evs = _categories("codex", bridge._codex_line_to_events, lines)  # noqa: SLF001
    resp = [n for ev, n in evs if n["category"] == "response"]
    assert len(resp) == 1, evs
    assert resp[0]["input_tokens"] == 100, resp[0]
    assert resp[0]["output_tokens"] == 20, resp[0]
    assert resp[0]["cache_read_tokens"] == 40, resp[0]


def test_codex_environment_context_becomes_system_event_not_prompt():
    env = ("<environment_context>\n  <cwd>/repo</cwd>\n  <shell>zsh</shell>\n"
           "</environment_context>")
    lines = [
        # Pure env block: no prompt, one system 'Environment context' event.
        {"type": "response_item", "id": "u1", "timestamp": "2026-04-01T00:00:00Z",
         "payload": {"type": "message", "role": "user",
                     "content": [{"type": "input_text", "text": env}]}},
        # env block followed by a real question: split into both.
        {"type": "response_item", "id": "u2", "timestamp": "2026-04-01T00:00:01Z",
         "payload": {"type": "message", "role": "user",
                     "content": [{"type": "input_text", "text": env + "\n\nreal question"}]}},
    ]
    evs = _categories("codex", bridge._codex_line_to_events, lines)  # noqa: SLF001
    prompts = [n["detail"] for ev, n in evs if n["category"] == "prompt"]
    assert prompts == ["real question"], prompts
    envs = [(ev, n) for ev, n in evs if n["title"] == "Environment context"]
    assert len(envs) == 2, evs
    assert all(n["category"] == "lifecycle" for _, n in envs), envs
    assert "<environment_context>" in envs[0][0]["environment_context"]
    # Identical blocks share a stable dedup key (collapse to one per session).
    assert envs[0][0]["_dedup_key"] == envs[1][0]["_dedup_key"], envs


def test_codex_environment_context_hook_prompt_is_relabeled():
    # Backend safety net: even if a raw prompt still carries the block inline.
    env = "<environment_context><cwd>/r</cwd></environment_context>"
    n = normalize("codex", {"hook_event_name": "UserPromptSubmit",
                            "session_id": "s", "prompt": env + "\n\nfix the bug"})
    assert n["category"] == "prompt" and n["detail"] == "fix the bug", n
    e = normalize("codex", {"hook_event_name": "CodexEnvironmentContext",
                            "session_id": "s", "cwd": "/r", "environment_context": env})
    assert e["category"] == "lifecycle" and e["title"] == "Environment context", e


def test_codex_upload_preamble_stripped_from_hook_prompt():
    # Codex clipboard/file uploads ship a "# Files mentioned ... ## My request
    # for Codex:" wrapper on the live hook path; only the request should remain.
    prompt = (
        "\n# Files mentioned by the user:\n\n"
        "## codex-clipboard-abc.png: /tmp/codex-clipboard-abc.png\n\n"
        "## My request for Codex:\nthere is some area which is not covered\n"
    )
    n = normalize("codex", {"hook_event_name": "UserPromptSubmit",
                            "session_id": "s", "prompt": prompt})
    assert n["category"] == "prompt", n
    assert n["detail"] == "there is some area which is not covered", n


def test_codex_in_app_browser_preamble_stripped_from_hook_prompt():
    prompt = (
        "\n# In app browser:\n- Current URL: http://localhost:8081/docs\n\n"
        "## My request for Codex:\ncreate a new button for update\n"
    )
    n = normalize("codex", {"hook_event_name": "UserPromptSubmit",
                            "session_id": "s", "prompt": prompt})
    assert n["detail"] == "create a new button for update", n


def test_user_typed_text_without_canonical_marker_is_preserved():
    # A user literally asking about the wrapper (no "## " marker) must NOT be
    # truncated — we only strip the canonical injected scaffolding.
    prompt = ("Files mentioned by the user:\nx.png: /p/x.png\n"
              "My request for Codex:\nkeep this\n\nwhy does the prompt look like this?")
    n = normalize("codex", {"hook_event_name": "UserPromptSubmit",
                            "session_id": "s", "prompt": prompt})
    assert "why does the prompt look like this?" in n["detail"], n


def test_codex_turn_aborted_marks_message_interrupted():
    lines = [
        {"type": "response_item", "id": "m1", "timestamp": "2026-04-01T00:00:00Z",
         "payload": {"type": "message", "role": "assistant", "phase": "final_answer",
                     "content": [{"type": "output_text", "text": "partial"}]}},
        {"type": "event_msg", "timestamp": "2026-04-01T00:00:01Z",
         "payload": {"type": "turn_aborted", "reason": "interrupted"}},
    ]
    evs = _categories("codex", bridge._codex_line_to_events, lines)  # noqa: SLF001
    resp = [n for ev, n in evs if n["category"] == "response"]
    assert len(resp) == 1 and resp[0]["status"] == "interrupted", evs


def test_codex_session_meta_and_turn_context_stamp_cwd_and_model():
    lines = [
        {"type": "session_meta", "timestamp": "2026-04-01T00:00:00Z",
         "payload": {"id": "SID", "cwd": "/work/repo"}},
        {"type": "turn_context", "timestamp": "2026-04-01T00:00:01Z",
         "payload": {"model": "gpt-5.5", "effort": "high"}},
        {"type": "response_item", "id": "m1", "timestamp": "2026-04-01T00:00:02Z",
         "payload": {"type": "message", "role": "assistant", "phase": "final_answer",
                     "content": [{"type": "output_text", "text": "hi"}]}},
    ]
    evs = _categories("codex", bridge._codex_line_to_events, lines)  # noqa: SLF001
    resp = [n for ev, n in evs if n["category"] == "response"]
    assert len(resp) == 1, evs
    assert resp[0]["cwd"] == "/work/repo", resp[0]
    assert resp[0]["model"] == "gpt-5.5", resp[0]


def test_codex_emits_session_start_with_posture():
    lines = [
        {"type": "session_meta", "timestamp": "2026-04-01T00:00:00Z",
         "payload": {"id": "SID", "cwd": "/work/repo", "cli_version": "0.140.0",
                     "originator": "Codex Desktop"}},
        {"type": "turn_context", "timestamp": "2026-04-01T00:00:01Z",
         "payload": {"model": "gpt-5.5", "effort": "high", "approval_policy": "on-request",
                     "sandbox_policy": {"type": "workspace-write", "network_access": False}}},
        {"type": "response_item", "id": "m1", "timestamp": "2026-04-01T00:00:02Z",
         "payload": {"type": "message", "role": "assistant", "phase": "final_answer",
                     "content": [{"type": "output_text", "text": "hi"}]}},
    ]
    evs = _categories("codex", bridge._codex_line_to_events, lines)  # noqa: SLF001
    starts = [(ev, n) for ev, n in evs if n["category"] == "lifecycle"]
    assert len(starts) == 1, evs
    ev, n = starts[0]
    assert n["title"] == "Session started" and n["target"] == "/work/repo", n
    cfg = ev["codex"]
    assert cfg["approval_policy"] == "on-request", cfg
    assert cfg["sandbox_policy"]["network_access"] is False, cfg
    assert cfg["effort"] == "high" and cfg["cli_version"] == "0.140.0", cfg
    # Exactly one SessionStart even across multiple turn_context lines.
    evs2 = _categories("codex", bridge._codex_line_to_events, lines + [  # noqa: SLF001
        {"type": "turn_context", "timestamp": "2026-04-01T00:00:03Z",
         "payload": {"model": "gpt-5.5", "approval_policy": "never"}},
    ])
    assert len([1 for _, n in evs2 if n["category"] == "lifecycle"]) == 1, evs2


# --- AskQuestion answer recovery -------------------------------------------

from app.question_recovery import recover_cursor_question_response  # noqa: E402

_ROLLOUT_Q = {"questions": [{"id": "rollout", "prompt": "How should I run the rollout?", "options": [
    {"id": "rebuild_prod", "label": "Rebuild prod image + restart (Recommended): docker build the fixed cot image, then `cot reimport`."},
    {"id": "dev_compose", "label": "Dev compose: `just prod down` then `just dev up`, then `cot reimport`."},
    {"id": "code_only", "label": "Code only: don't touch the running container or DB."},
]}]}


def test_question_recovers_paraphrased_selection():
    resp = recover_cursor_question_response(_ROLLOUT_Q, "Rebuilding the prod image with the fixes. This builds the dashboard + backend into a fresh image.")
    picked = resp.get("answers", {}).get("rollout", {}).get("answers", [])
    assert picked and picked[0].startswith("Rebuild prod image"), resp


def test_question_ambiguous_text_records_nothing():
    resp = recover_cursor_question_response(_ROLLOUT_Q, "Okay, let me proceed with the next steps now.")
    assert resp == {}, resp


def test_question_matches_other_option_by_its_own_title():
    resp = recover_cursor_question_response(_ROLLOUT_Q, "Bringing up the dev compose stack via just dev up.")
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
    resp = recover_cursor_question_response(_NAMING_Q, follow)
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
    assert bridge._hook_command("claude") == "$HOME/.cot/bin/cot hook claude"  # noqa: SLF001


def test_merge_hooks_does_not_false_positive_on_gryph():
    existing = {
        "SessionStart": [{
            "hooks": [{
                "type": "command",
                "command": "gryph _hook claude-code SessionStart",
            }],
        }],
    }
    template = bridge._hook_templates()["claude"]  # noqa: SLF001
    merged = bridge._merge_hooks(existing, template, "claude")  # noqa: SLF001
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
    template = bridge._hook_templates()["claude"]  # noqa: SLF001
    merged = bridge._merge_hooks(existing, template, "claude")  # noqa: SLF001
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
    cleaned = bridge._remove_hooks(existing, "claude")  # noqa: SLF001
    assert len(cleaned["SessionStart"]) == 1
    assert "gryph" in cleaned["SessionStart"][0]["hooks"][0]["command"]


# --- Subagent embedding (Cursor/Claude parity) ------------------------------
import json as _json  # noqa: E402
import tempfile as _tempfile  # noqa: E402
from pathlib import Path as _Path  # noqa: E402


def _with_env(key, value):
    """Context-free env override helper that restores the prior value."""
    prior = os.environ.get(key)
    os.environ[key] = value

    def restore():
        if prior is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = prior

    return restore


def test_tiny_import_smoke_records_all_sources_without_golden_session():
    """Tiny wiring smoke: parser -> normalize -> storage, no broad snapshot."""
    with _tempfile.TemporaryDirectory() as tmp:
        restore = _with_env("COT_DB_PATH", str(_Path(tmp) / "cot.db"))
        try:
            from app import db, store
            db.init_db()

            cases = [
                ("cursor", "smoke-cursor", bridge._cursor_line_to_events, [  # noqa: SLF001
                    {"role": "user", "message": {"content": [{"type": "text", "text": "<user_query>\nhi\n</user_query>"}]}},
                    {"role": "assistant", "message": {"content": [
                        {"type": "tool_use", "name": "Shell", "input": {"command": "ls"}},
                    ]}},
                ], _MTIME),
                ("claude", "smoke-claude", bridge._claude_line_to_events, [  # noqa: SLF001
                    {"type": "assistant", "uuid": "smoke-c1", "timestamp": "2026-06-01T00:00:00Z",
                     "message": {"role": "assistant", "content": [
                         {"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "pwd"}},
                     ]}},
                    {"type": "user", "uuid": "smoke-c2", "timestamp": "2026-06-01T00:00:01Z",
                     "message": {"role": "user", "content": [
                         {"type": "tool_result", "tool_use_id": "t1", "content": "/repo", "is_error": False},
                     ]}},
                ], None),
                ("codex", "smoke-codex", bridge._codex_line_to_events, [  # noqa: SLF001
                    {"type": "response_item", "id": "smoke-z1", "timestamp": "2026-04-01T00:00:00Z",
                     "payload": {"type": "function_call", "name": "exec_command",
                                 "arguments": "{\"cmd\": \"pwd\"}", "call_id": "cz1"}},
                    {"type": "response_item", "id": "smoke-z2", "timestamp": "2026-04-01T00:00:01Z",
                     "payload": {"type": "function_call_output", "call_id": "cz1",
                                 "output": "/repo", "status": "completed"}},
                ], None),
            ]

            def ingest_once():
                for agent, sid, parser, lines, mtime in cases:
                    state: dict = {}
                    for lineno, obj in enumerate(lines):
                        for ev in parser(obj, sid, lineno=lineno, mtime=mtime, state=state, path=f"/{sid}.jsonl"):
                            db.record_event(normalize(agent, ev), ev)
                    for ev in bridge._codex_flush_pending(state):  # noqa: SLF001
                        db.record_event(normalize(agent, ev), ev)

            ingest_once()
            ingest_once()

            with store.read() as conn:
                rows = conn.execute(
                    "SELECT source, category, COUNT(*) n FROM events"
                    " WHERE session_id LIKE 'smoke-%'"
                    " GROUP BY source, category ORDER BY source, category"
                ).fetchall()
            got = {(r["source"], r["category"]): r["n"] for r in rows}
            assert got[("cursor", "prompt")] == 1, got
            assert got[("cursor", "shell")] == 1, got
            assert got[("claude", "shell")] == 2, got
            assert got[("codex", "shell")] == 2, got
        finally:
            restore()


def test_discover_subagent_links_from_cursor_nesting():
    parent = "11111111-1111-1111-1111-111111111111"
    child = "22222222-2222-2222-2222-222222222222"
    # Under a test-owned $HOME so the bridge's _safe_transcript_root
    # home-confinement passes even when the real home is read-only.
    with _tempfile.TemporaryDirectory() as tmp:
        restore_home = _with_env("HOME", tmp)
        restore_userprofile = _with_env("USERPROFILE", tmp)
        d = _Path(tmp) / ".cursor" / "projects" / "proj" / "agent-transcripts" / parent / "subagents"
        d.mkdir(parents=True)
        (d / f"{child}.jsonl").write_text(
            _json.dumps({"role": "user", "message": {"content": [
                {"type": "text", "text": "<user_query>\nExplore the repo\n</user_query>"}]}}) + "\n",
            encoding="utf-8",
        )
        restore = _with_env("COT_CURSOR_HOME", str(_Path(tmp) / ".cursor"))
        try:
            links = bridge._discover_subagent_links("cursor")  # noqa: SLF001
        finally:
            restore()
            restore_userprofile()
            restore_home()
    assert len(links) == 1, links
    assert links[0]["child"] == child and links[0]["parent"] == parent, links
    # Label is wrapper-stripped to the user's words.
    assert links[0]["label"] == "Explore the repo", links


def test_discover_subagent_links_skips_claude_folded():
    # Claude stamps the parent sessionId inside its subagent lines (they fold
    # into the parent) and names the file agent-<hex> — a non-UUID stem. So it
    # must yield no separate child link.
    parent = "33333333-3333-3333-3333-333333333333"
    with _tempfile.TemporaryDirectory() as tmp:
        restore_home = _with_env("HOME", tmp)
        restore_userprofile = _with_env("USERPROFILE", tmp)
        d = _Path(tmp) / ".claude" / "projects" / "-proj" / parent / "subagents"
        d.mkdir(parents=True)
        (d / "agent-deadbeef0.jsonl").write_text(
            _json.dumps({"role": "user", "message": "hi"}) + "\n", encoding="utf-8")
        restore = _with_env("COT_CLAUDE_HOME", str(_Path(tmp) / ".claude"))
        try:
            links = bridge._discover_subagent_links("claude")  # noqa: SLF001
        finally:
            restore()
            restore_userprofile()
            restore_home()
    assert links == [], links


def test_subagent_link_embeds_child_under_parent():
    parent = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
    child = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
    with _tempfile.TemporaryDirectory() as tmp:
        restore = _with_env("COT_DB_PATH", str(_Path(tmp) / "cot.db"))
        try:
            from app import db, store
            db.init_db()
            base = "2026-04-01T00:00:0"

            def ev(sid, cat, phase, secs, *, target=None, hook="x", detail=None):
                with store.write() as conn:
                    store.insert_event(
                        conn,
                        session_id=sid,
                        source="cursor",
                        hook=hook,
                        phase=phase,
                        ts=f"{base}{secs}Z",
                        category=cat,
                        detail=detail,
                        target=target,
                        dedup_key=f"{sid}{phase}{secs}",
                        created_at=f"{base}{secs}Z",
                    )

            with store.write() as conn:
                for sid in (parent, child):
                    conn.execute(
                        "INSERT INTO sessions (id, source, started_at, status, created_at)"
                        " VALUES (?,?,?,?,?)",
                        (sid, "cursor", f"{base}0Z", "completed", f"{base}0Z"),
                    )
            ev(parent, "prompt", "instant", 0, detail="do the thing")
            ev(parent, "subagent", "start", 1, target="T", hook="subagentStart")
            ev(parent, "subagent", "end", 5, target="T", hook="subagentStop")
            ev(child, "shell", "instant", 2, target="ls")
            ev(child, "file_read", "instant", 3, target="/a.py")

            assert db.set_subagent_links([{"child": child, "parent": parent, "label": "explore"}]) == 1
            # Idempotent: re-applying the same link is a no-op.
            assert db.set_subagent_links([{"child": child, "parent": parent, "label": "explore"}]) == 0

            with store.read() as conn:
                links = db.session_links(conn, parent)
            kids = [c for c in links["children"] if c["type"] == "subagent"]
            assert len(kids) == 1 and kids[0]["session_id"] == child, links

            detail = db.get_session_detail(parent)
            inlined = [e for e in detail["events"] if e.get("inlined_subagent")]
            assert len(inlined) == 2, [(e["category"], e.get("inlined_subagent")) for e in detail["events"]]

            # The native subagentStart/Stop span is *adopted* (stamped with the
            # child session), not duplicated by a second synthetic bar.
            spans = [t for t in detail["timeline"] if t.get("category") == "subagent"]
            assert len(spans) == 1, spans
            assert spans[0]["subagent_child_session"] == child, spans[0]
            assert spans[0]["id"] > 0, spans[0]  # the real native span, not synthetic

            cdetail = db.get_session_detail(child)
            assert any(
                p["type"] == "subagent" and p["session_id"] == parent
                for p in cdetail["links"]["parents"]
            ), cdetail["links"]

            ids = [s["id"] for s in db.list_sessions(limit=500)]
            assert parent in ids and child not in ids, ids
        finally:
            restore()


def test_synthetic_subagent_span_groups_child_events():
    """A linked child with no native parent span still gets a synthetic
    ``subagent`` span so every provider renders the same collapsible group."""
    parent = "cccccccc-cccc-cccc-cccc-cccccccccccc"
    child = "dddddddd-dddd-dddd-dddd-dddddddddddd"
    with _tempfile.TemporaryDirectory() as tmp:
        restore = _with_env("COT_DB_PATH", str(_Path(tmp) / "cot.db"))
        try:
            from app import db, store
            db.init_db()
            base = "2026-05-01T00:00:0"

            def ev(sid, cat, phase, secs, *, target=None, detail=None):
                with store.write() as conn:
                    store.insert_event(
                        conn,
                        session_id=sid,
                        source="cursor",
                        phase=phase,
                        ts=f"{base}{secs}Z",
                        category=cat,
                        detail=detail,
                        target=target,
                        dedup_key=f"{sid}{phase}{secs}",
                        created_at=f"{base}{secs}Z",
                    )

            with store.write() as conn:
                for sid in (parent, child):
                    conn.execute(
                        "INSERT INTO sessions (id, source, started_at, status, created_at)"
                        " VALUES (?,?,?,?,?)",
                        (sid, "cursor", f"{base}0Z", "completed", f"{base}0Z"),
                    )
            # Parent has NO native subagent span (the real Cursor case).
            ev(parent, "prompt", "instant", 0, detail="do the thing")
            # Child captures a prompt + an action — a prompt would be dropped by
            # time-window grouping, so the synthetic-span path must claim it too.
            ev(child, "prompt", "instant", 1, detail="explore everything")
            ev(child, "shell", "instant", 2, target="ls")

            assert db.set_subagent_links(
                [{"child": child, "parent": parent, "label": "explore"}]
            ) == 1

            detail = db.get_session_detail(parent)
            spans = [t for t in detail["timeline"] if t.get("category") == "subagent"]
            assert len(spans) == 1, spans
            span = spans[0]
            assert span["subagent_child_session"] == child, span
            assert span["subagent_run_kind"] == "subagent", span
            # Label prefers the child's first instruction (richer than the
            # stored fallback label).
            assert span["title"] == "explore everything", span
            assert span["id"] < 0, span  # synthetic, no collision with real ids

            # Every child event (prompt included) is inlined and falls in the run.
            inlined = [e for e in detail["events"] if e.get("event_session_id") == child]
            assert {e["category"] for e in inlined} == {"prompt", "shell"}, inlined
            assert all(span["start_ts"] <= e["start_ts"] <= span["end_ts"] for e in inlined), (
                span, inlined,
            )
        finally:
            restore()


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
