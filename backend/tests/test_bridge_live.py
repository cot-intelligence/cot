"""Canonical Ingest Event and live-shell contract tests for the Bridge."""

from __future__ import annotations

import importlib.machinery
import importlib.util
import json
import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_BACKEND = os.path.dirname(_HERE)
_REPO = os.path.dirname(_BACKEND)

sys.path.insert(0, _BACKEND)


def _load_bridge():
    path = os.path.join(_REPO, "bridge", "cot")
    loader = importlib.machinery.SourceFileLoader("cot_bridge_live_under_test", path)
    spec = importlib.util.spec_from_loader("cot_bridge_live_under_test", loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


bridge = _load_bridge()


def _write_jsonl(path, *objects):
    path.write_text(
        "".join(json.dumps(obj, ensure_ascii=False) + "\n" for obj in objects),
        encoding="utf-8",
    )


def _capture_posts(monkeypatch):
    posted = []
    monkeypatch.setattr(bridge, "_post", lambda url, payload: posted.append((url, payload)))
    return posted


def _is_ingest(post, source):
    return post[0].endswith(f"/v1/ingest/{source}")


def test_live_kind_filter_folds_usage_onto_next_kept_event():
    events = [
        {"kind": "tool_call", "usage": {"input_tokens": 12}},
        {"kind": "thought", "text": "checking", "usage": {"output_tokens": 3}},
        {"kind": "prompt", "text": "already delivered", "usage": {"input_tokens": 5}},
        {"kind": "response", "text": "done"},
    ]

    prepared = bridge._prepare_ingest_events("claude", events, origin="hook")  # noqa: SLF001

    assert [event["kind"] for event in prepared] == ["thought", "response"]
    assert prepared[0]["usage"] == {"input_tokens": 12, "output_tokens": 3}
    assert prepared[1]["usage"] == {"input_tokens": 5}


def test_all_filtered_usage_folds_onto_hook_body(tmp_path, monkeypatch):
    transcript = tmp_path / "claude-tools-only.jsonl"
    _write_jsonl(transcript, {
        "type": "assistant",
        "uuid": "assistant-1",
        "message": {
            "role": "assistant",
            "usage": {"input_tokens": 20, "output_tokens": 4},
            "content": [
                {"type": "tool_use", "id": "tool-1", "name": "Bash",
                 "input": {"command": "pwd"}},
            ],
        },
    })
    monkeypatch.setattr(bridge, "STATE_DIR", tmp_path / "state")
    monkeypatch.setattr(bridge, "TRANSCRIPT_OFFSETS", tmp_path / "state" / "offsets.json")
    posted = _capture_posts(monkeypatch)
    body = {
        "hook_event_name": "Stop",
        "session_id": "SID",
        "transcript_path": str(transcript),
        "timestamp": "2026-07-14T12:00:01Z",
    }

    bridge._emit_claude_events(body, "claude")  # noqa: SLF001

    assert posted == []
    assert body["usage"] == {"input_tokens": 20, "output_tokens": 4}


def test_shared_post_steps_collapse_responses_and_flag_interruption():
    events = [
        {"kind": "response", "text": "Same   words"},
        {"kind": "response", "text": "same words"},
        {"kind": "interruption"},
    ]

    prepared = bridge._prepare_ingest_events("cursor", events, origin="import")  # noqa: SLF001

    assert prepared == [{"kind": "response", "text": "Same   words", "interrupted": True}]


def test_cursor_subagent_import_prepares_the_whole_transcript(tmp_path, monkeypatch):
    transcript = tmp_path / "subagent.jsonl"
    _write_jsonl(
        transcript,
        {"role": "assistant", "message": {"content": [
            {"type": "text", "text": "Repeated response"},
        ]}},
        {"role": "assistant", "message": {"content": [
            {"type": "text", "text": "  repeated   response  "},
        ]}},
        {"role": "assistant", "message": {"content": [
            {"type": "text", "text": "Partial response"},
            {"type": "tool_use", "name": "Shell", "input": {"command": "sleep 10"}},
        ]}},
        {
            "type": "turn_ended",
            "status": "aborted",
            "error": "User aborted/interrupted manually.",
        },
    )
    posted = _capture_posts(monkeypatch)

    bridge._import_cursor_subagent_responses(transcript, "CHILD")  # noqa: SLF001

    payloads = [payload for _, payload in posted]
    assert [payload["response"] for payload in payloads] == [
        "Repeated response",
        "Partial response",
    ]
    assert payloads[-1]["interrupted"] is True


def test_cursor_parser_emits_plan_instant_question_and_live_dedup_keys():
    line = {
        "role": "assistant",
        "message": {
            "content": [
                {"type": "thinking", "thinking": "considering"},
                {"type": "tool_use", "name": "AskQuestion", "input": {
                    "title": "Choose", "questions": [{"id": "q1", "prompt": "Which?"}],
                }},
                {"type": "tool_use", "name": "CreatePlan", "input": {
                    "name": "Ship", "overview": "Overview", "plan": "Body", "todos": ["one"],
                }},
            ]
        },
    }

    events = bridge._cursor_line_to_ingest_events(  # noqa: SLF001
        line,
        "SID",
        origin="hook",
        byte_offset=128,
        path="/transcript.jsonl",
    )

    assert [event["kind"] for event in events] == ["thought", "tool_call", "plan"]
    assert events[1]["phase"] == "instant" and events[1]["tool_name"] == "AskQuestion"
    assert events[2]["name"] == "Ship"
    assert all(event["dedup_key"].startswith("live:cursor:128:") for event in events)


def test_plan_adapter_uses_collector_plan_wire_shape():
    payload = bridge._ingest_event_to_hook_payload({  # noqa: SLF001
        "kind": "plan",
        "origin": "import",
        "session_id": "SID",
        "name": "Ship",
        "overview": "Overview",
        "body": "Body",
        "todos": ["one"],
        "timestamp": "2026-07-14T12:00:00Z",
    })

    assert payload["hook_event_name"] == "createPlan"
    assert payload["_synthetic_category"] == "plan"
    assert payload["plan_name"] == "Ship"
    assert payload["plan_overview"] == "Overview"
    assert payload["plan_body"] == "Body"
    assert payload["plan_todos"] == ["one"]
    assert payload["_import"] is True


def test_cursor_live_shell_posts_canonical_sequence_and_pairs_answer(tmp_path, monkeypatch):
    transcript = tmp_path / "cursor.jsonl"
    _write_jsonl(
        transcript,
        {"role": "assistant", "message": {"content": [
            {"type": "text", "text": "Working"},
            {"type": "text", "text": "  working  "},
            {"type": "thinking", "thinking": "Need a choice"},
            {"type": "tool_use", "name": "AskQuestion", "input": {
                "title": "Choose", "questions": [{"id": "q1", "prompt": "Which?"}],
            }},
            {"type": "tool_use", "name": "CreatePlan", "input": {
                "name": "Ship", "overview": "Overview", "plan": "Body", "todos": ["one"],
            }},
        ]}},
    )
    monkeypatch.setattr(bridge, "STATE_DIR", tmp_path / "state")
    monkeypatch.setattr(bridge, "TRANSCRIPT_OFFSETS", tmp_path / "state" / "offsets.json")
    posted = _capture_posts(monkeypatch)
    body = {
        "hook_event_name": "afterAgentResponse",
        "session_id": "SID",
        "transcript_path": str(transcript),
        "text": "I will use the first choice",
        "timestamp": "2026-07-14T12:00:00Z",
        "cwd": "/repo",
        "model": "cursor-model",
    }

    handled = bridge._emit_cursor_events(body, "cursor")  # noqa: SLF001

    assert handled is True
    ingest = [payload for post, payload in posted if post.endswith("/v1/ingest/cursor")]
    assert [payload.get("_synthetic_category") or payload.get("tool_name") for payload in ingest] == [
        "response", "thought", "AskQuestion", "plan", "response",
    ]
    assert [payload["response"] for payload in ingest if payload.get("response")] == [
        "Working", "I will use the first choice",
    ]
    assert all(payload.get("_dedup_key", "").startswith("live:cursor:") for payload in ingest)
    assert [payload["timestamp"] for payload in ingest] == sorted(
        payload["timestamp"] for payload in ingest
    )
    answers = [payload for post, payload in posted if post.endswith("/v1/questions/answer")]
    assert answers == [{
        "session_id": "SID",
        "title": "Choose",
        "qids": ["q1"],
        "response_text": "I will use the first choice",
    }]


def test_cursor_plan_only_turn_keeps_response_fallback(tmp_path, monkeypatch):
    transcript = tmp_path / "cursor-plan.jsonl"
    _write_jsonl(transcript, {"role": "assistant", "message": {"content": [
        {"type": "tool_use", "name": "CreatePlan", "input": {
            "name": "Ship", "overview": "Overview", "plan": "Plan body", "todos": [],
        }},
    ]}})
    monkeypatch.setattr(bridge, "STATE_DIR", tmp_path / "state")
    monkeypatch.setattr(bridge, "TRANSCRIPT_OFFSETS", tmp_path / "state" / "offsets.json")
    posted = _capture_posts(monkeypatch)

    handled = bridge._emit_cursor_events({  # noqa: SLF001
        "hook_event_name": "afterAgentResponse",
        "session_id": "SID",
        "transcript_path": str(transcript),
        "text": "",
        "timestamp": "2026-07-14T12:00:00Z",
    }, "cursor")

    assert handled is True
    ingest = [payload for post, payload in posted if _is_ingest((post, payload), "cursor")]
    assert [payload.get("_synthetic_category") for payload in ingest] == ["plan", "response"]
    assert ingest[-1]["response"] == "Plan body"


def test_claude_live_shell_uses_shared_parser_and_folds_filtered_usage(tmp_path, monkeypatch):
    transcript = tmp_path / "claude.jsonl"
    _write_jsonl(transcript, {
        "type": "assistant",
        "uuid": "assistant-1",
        "timestamp": "2026-07-14T12:00:00Z",
        "message": {
            "role": "assistant",
            "usage": {"input_tokens": 20, "output_tokens": 4},
            "content": [
                {"type": "tool_use", "id": "tool-1", "name": "Bash", "input": {"command": "pwd"}},
                {"type": "text", "text": "Done"},
            ],
        },
    })
    monkeypatch.setattr(bridge, "STATE_DIR", tmp_path / "state")
    monkeypatch.setattr(bridge, "TRANSCRIPT_OFFSETS", tmp_path / "state" / "offsets.json")
    posted = _capture_posts(monkeypatch)

    bridge._emit_claude_events({  # noqa: SLF001
        "hook_event_name": "Stop",
        "session_id": "SID",
        "transcript_path": str(transcript),
        "timestamp": "2026-07-14T12:00:01Z",
        "cwd": "/repo",
        "model": "claude-model",
    }, "claude")

    ingest = [payload for post, payload in posted if post.endswith("/v1/ingest/claude")]
    assert len(ingest) == 1
    assert ingest[0]["response"] == "Done"
    assert ingest[0]["usage"] == {"input_tokens": 20, "output_tokens": 4}
    assert ingest[0]["_dedup_key"] == "live:claude:assistant-1:resp:1"
    assert ingest[0]["cwd"] == "/repo" and ingest[0]["model"] == "claude-model"


def test_live_rescan_after_offset_loss_reuses_explicit_keys(tmp_path, monkeypatch):
    transcript = tmp_path / "cursor-rescan.jsonl"
    _write_jsonl(transcript, {"role": "assistant", "message": {"content": [
        {"type": "text", "text": "Stable"},
    ]}})
    monkeypatch.setattr(bridge, "STATE_DIR", tmp_path / "state")
    offsets = tmp_path / "state" / "offsets.json"
    monkeypatch.setattr(bridge, "TRANSCRIPT_OFFSETS", offsets)

    first = bridge._scan_live_ingest_events(  # noqa: SLF001
        "cursor", str(transcript), "SID", "2026-07-14T12:00:00Z"
    )
    offsets.unlink()
    second = bridge._scan_live_ingest_events(  # noqa: SLF001
        "cursor", str(transcript), "SID", "2026-07-14T12:00:00Z"
    )

    assert [event["dedup_key"] for event in first] == [event["dedup_key"] for event in second]
    assert all(event["dedup_key"].startswith("live:cursor:") for event in first)


def test_cursor_question_without_hook_text_posts_no_answer(tmp_path, monkeypatch):
    transcript = tmp_path / "cursor-question.jsonl"
    _write_jsonl(transcript, {"role": "assistant", "message": {"content": [
        {"type": "tool_use", "name": "AskQuestion", "input": {
            "title": "Choose", "questions": [{"id": "q1", "prompt": "Which?"}],
        }},
    ]}})
    monkeypatch.setattr(bridge, "STATE_DIR", tmp_path / "state")
    monkeypatch.setattr(bridge, "TRANSCRIPT_OFFSETS", tmp_path / "state" / "offsets.json")
    posted = _capture_posts(monkeypatch)

    handled = bridge._emit_cursor_events({  # noqa: SLF001
        "hook_event_name": "afterAgentResponse",
        "session_id": "SID",
        "transcript_path": str(transcript),
        "text": "",
        "timestamp": "2026-07-14T12:00:00Z",
    }, "cursor")

    assert handled is False
    ingest = [payload for post, payload in posted if post.endswith("/v1/ingest/cursor")]
    assert len(ingest) == 1 and ingest[0]["tool_name"] == "AskQuestion"
    assert not any(post.endswith("/v1/questions/answer") for post, _ in posted)


def test_codex_live_shell_emits_thought_response_usage_and_stable_keys(tmp_path, monkeypatch):
    transcript = tmp_path / "codex.jsonl"
    _write_jsonl(
        transcript,
        {"type": "response_item", "id": "thought-1", "timestamp": "2026-07-14T12:00:00Z",
         "payload": {"type": "message", "role": "assistant", "phase": "commentary",
                     "content": [{"type": "output_text", "text": "Checking"}]}},
        {"type": "response_item", "id": "tool-1", "timestamp": "2026-07-14T12:00:01Z",
         "payload": {"type": "function_call", "name": "exec_command", "call_id": "call-1",
                     "arguments": "{\"cmd\": \"pwd\"}"}},
        {"type": "response_item", "id": "response-1", "timestamp": "2026-07-14T12:00:02Z",
         "payload": {"type": "message", "role": "assistant", "phase": "final_answer",
                     "content": [{"type": "output_text", "text": "Done"}]}},
        {"type": "event_msg", "timestamp": "2026-07-14T12:00:03Z",
         "payload": {"type": "token_count", "info": {"last_token_usage": {
             "input_tokens": 30, "output_tokens": 5,
         }}}},
    )
    monkeypatch.setattr(bridge, "STATE_DIR", tmp_path / "state")
    monkeypatch.setattr(bridge, "TRANSCRIPT_OFFSETS", tmp_path / "state" / "offsets.json")
    posted = _capture_posts(monkeypatch)

    bridge._emit_codex_events({  # noqa: SLF001
        "hook_event_name": "Stop",
        "session_id": "SID",
        "transcript_path": str(transcript),
        "timestamp": "2026-07-14T12:00:04Z",
    }, "codex")

    ingest = [payload for post, payload in posted if post.endswith("/v1/ingest/codex")]
    assert [payload.get("_synthetic_category") for payload in ingest] == ["thought", "response"]
    assert ingest[1]["usage"] == {"input_tokens": 30, "output_tokens": 5}
    assert [payload["_dedup_key"] for payload in ingest] == [
        "live:codex:thought-1:think", "live:codex:response-1:resp",
    ]


def test_codex_stop_falls_back_when_transcript_is_unreadable(monkeypatch):
    posted = _capture_posts(monkeypatch)

    bridge._emit_codex_events({  # noqa: SLF001
        "hook_event_name": "Stop",
        "session_id": "SID",
        "transcript_path": "/missing/transcript.jsonl",
        "last_assistant_message": "Fallback answer",
        "timestamp": "2026-07-14T12:00:00Z",
    }, "codex")

    assert len(posted) == 1
    payload = posted[0][1]
    assert payload["response"] == "Fallback answer"
    assert payload["_dedup_key"].startswith("live:codex:fallback:")


def test_all_shared_parsers_emit_canonical_interruption_markers():
    claude = bridge._claude_line_to_ingest_events({  # noqa: SLF001
        "type": "user", "uuid": "u1", "message": {"role": "user", "content": [
            {"type": "text", "text": "[Request interrupted by user]"},
        ]},
    }, "SID")
    cursor = bridge._cursor_line_to_ingest_events({  # noqa: SLF001
        "role": "user", "message": {"content": [
            {"type": "text", "text": "[Request interrupted by user]"},
        ]},
    }, "SID", path="/cursor.jsonl")
    codex = bridge._codex_line_to_ingest_events({  # noqa: SLF001
        "type": "event_msg", "payload": {"type": "turn_aborted"},
    }, "SID")

    assert [event["kind"] for event in claude] == ["interruption"]
    assert [event["kind"] for event in cursor] == ["interruption"]
    assert [event["kind"] for event in codex] == ["interruption"]
