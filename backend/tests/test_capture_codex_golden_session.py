"""Sanitizer behavior for captured Codex golden-session fixtures."""

from __future__ import annotations

import importlib.util
from pathlib import Path
from typing import Any


def _load_capture_module() -> Any:
    path = Path(__file__).resolve().parents[2] / "scripts" / "capture_codex_golden_session.py"
    spec = importlib.util.spec_from_file_location("capture_codex_golden_session", path)
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def test_sanitizer_preserves_command_shape_while_redacting_private_spans():
    capture = _load_capture_module()

    sanitized = capture._sanitize_obj(
        {
            "tool_name": "Bash",
            "tool_input": {
                "command": "python P:\\worktrees\\cot-demo-capabilities\\scripts\\demo.py --token sk-abcdefghijklmnop"
            },
        },
        cwd=Path("P:/worktrees/cot-demo-capabilities"),
        home=Path("C:/Users/maste"),
        redact_text=True,
    )

    command = sanitized["tool_input"]["command"]
    assert "python" in command
    assert "/workspace/cot/scripts/demo.py" in command
    assert "[REDACTED_SECRET]" in command
    assert "echo sanitized-command" not in command
    assert "sk-abcdefghijklmnop" not in command
    assert "P:" not in command


def test_sanitizer_preserves_apply_patch_target_path():
    capture = _load_capture_module()
    patch = "\n".join(
        [
            "*** Begin Patch",
            "*** Update File: src/App.tsx",
            "-const token = 'sk-abcdefghijklmnop';",
            "+const token = process.env.TOKEN;",
            "*** End Patch",
        ]
    )

    sanitized = capture._sanitize_obj(
        {"tool_name": "apply_patch", "tool_input": {"command": patch}},
        cwd=Path("P:/worktrees/cot-demo-capabilities"),
        home=Path("C:/Users/maste"),
        redact_text=True,
    )

    command = sanitized["tool_input"]["command"]
    assert "*** Begin Patch" in command
    assert "*** Update File: src/App.tsx" in command
    assert "[REDACTED_SECRET]" in command
    assert "echo sanitized-command" not in command
    assert "sk-abcdefghijklmnop" not in command


def test_history_fixture_keeps_unparsed_rollout_rows():
    capture = _load_capture_module()
    rows = [
        {"type": "session_meta", "payload": {"id": "session"}},
        {"type": "turn_context", "payload": {"cwd": "P:/worktrees/cot-demo-capabilities"}},
        {"type": "response_item", "payload": {"type": "reasoning", "summary": [{"text": "thinking"}]}},
    ]

    assert capture._parser_relevant_history_rows(rows) == rows


def test_sanitizer_redacts_output_text_but_preserves_output_shape():
    capture = _load_capture_module()

    sanitized = capture._sanitize_obj(
        {
            "tool_response": {
                "status": "ok",
                "output": "failed in C:\\Users\\maste\\.codex with token sk-abcdefghijklmnop",
                "files": ["P:\\worktrees\\cot-demo-capabilities\\src\\App.tsx"],
            }
        },
        cwd=Path("P:/worktrees/cot-demo-capabilities"),
        home=Path("C:/Users/maste"),
        redact_text=True,
    )

    response = sanitized["tool_response"]
    assert response["status"] == "ok"
    assert response["output"] == "Sanitized tool output."
    assert response["files"] == ["/workspace/cot/src/App.tsx"]


def test_sanitizer_scrubs_path_like_dictionary_keys():
    capture = _load_capture_module()

    sanitized = capture._sanitize_obj(
        {
            "payload": {
                "changes": {
                    "P:\\worktrees\\cot-demo-capabilities\\docs\\demo-short.md": {
                        "type": "add",
                        "content": "Created a demo artifact.",
                    }
                }
            }
        },
        cwd=Path("P:/worktrees/cot-demo-capabilities"),
        home=Path("C:/Users/maste"),
        redact_text=True,
    )

    changes = sanitized["payload"]["changes"]
    assert list(changes) == ["/workspace/cot/docs/demo-short.md"]
