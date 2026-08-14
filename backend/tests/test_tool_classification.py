"""Contract tests for provider-neutral tool classification."""

from __future__ import annotations

import os
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))
_BACKEND = os.path.dirname(_HERE)
sys.path.insert(0, _BACKEND)

from app.tool_classification import (  # noqa: E402
    ToolInvocation,
    canonical_tool,
    classify_cursor_hook,
    classify_tool,
)


def _classify(name, input=None, **kwargs):
    return classify_tool(ToolInvocation(name=name, input=input or {}, **kwargs))


def test_tool_aliases_normalize_before_classification():
    assert canonical_tool("StrReplace") == "Edit"
    assert canonical_tool("ReadFile") == "Read"
    assert canonical_tool("rg") == "Bash"


def test_file_and_context_paths_classify_without_transcript_fixtures():
    cases = [
        ("Read", {"path": "/repo/app.py"}, "file_read", "/repo/app.py"),
        ("Read", {"path": "/repo/AGENTS.md"}, "context_read", "/repo/AGENTS.md"),
        ("Edit", {"path": "/repo/src/app.py"}, "file_edit", "/repo/src/app.py"),
        ("Edit", {"path": "/repo/CLAUDE.md"}, "memory", "/repo/CLAUDE.md"),
        ("Delete", {"path": "/repo/memory/notes.md"}, "memory", "/repo/memory/notes.md"),
    ]
    for name, input, category, target in cases:
        result = _classify(name, input)
        assert result["category"] == category, (name, result)
        assert result["target"] == target, (name, result)


def test_apply_patch_raw_input_extracts_file_target():
    patch = "*** Begin Patch\n*** Update File: /repo/app.py\n+x\n*** End Patch"
    result = classify_tool(ToolInvocation(name="apply_patch", raw_input=patch))
    assert result["category"] == "file_edit", result
    assert result["target"] == "/repo/app.py", result


def test_shell_and_search_tools_share_shell_category():
    shell = _classify("Shell", {"command": "pytest backend/tests"})
    search = _classify("Grep", {"pattern": "canonical ingest"})
    assert shell["category"] == "shell" and shell["target"] == "pytest backend/tests", shell
    assert search["category"] == "shell" and search["target"] == "canonical ingest", search


def test_mcp_memory_and_browser_network_classification():
    memory = _classify("mcp__memory__search", {"query": "decisions"})
    assert memory["category"] == "memory", memory
    assert memory["target"] == "memory/search", memory

    browser = _classify(
        "CallMcpTool",
        {
            "server": "browser",
            "toolName": "browser_navigate",
            "arguments": "{\"url\":\"https://example.com\"}",
        },
    )
    assert browser["category"] == "web", browser
    assert browser["target"] == "https://example.com", browser


def test_cursor_granular_hooks_classify_without_transcript_fixtures():
    shell = classify_cursor_hook("beforeShellExecution", {"command": "ls"}, None)
    read = classify_cursor_hook("beforeReadFile", {"path": "/repo/AGENTS.md"}, None)
    edit = classify_cursor_hook("afterFileEdit", {"file_path": "/repo/app.py"}, 5)
    web = classify_cursor_hook(
        "beforeMCPExecution",
        {
            "server": "browser",
            "tool_name": "browser_navigate",
            "arguments": {"url": "https://example.com"},
        },
        None,
    )

    assert shell["category"] == "shell" and shell["target"] == "ls", shell
    assert read["category"] == "context_read", read
    assert edit["category"] == "file_edit" and edit["duration_ms"] == 5, edit
    assert web["category"] == "web" and web["target"] == "https://example.com", web


def test_question_subagent_and_meta_categories():
    question = _classify(
        "request_user_input",
        {"questions": [{"id": "rollout", "question": "How should rollout run?"}]},
    )
    assert question["category"] == "question", question
    assert question["target"] == "rollout", question

    subagent = classify_tool(
        ToolInvocation(
            name="Task",
            input={"subagent_type": "explore", "description": "scan imports"},
            body={"tool_call_id": "call_123"},
        )
    )
    assert subagent["category"] == "subagent", subagent
    assert subagent["target"] == "call_123", subagent

    meta = _classify("TodoWrite", {"todos": []})
    assert meta["category"] == "meta", meta


def test_unknown_tool_remains_uncategorized_and_failure_status_is_preserved():
    assert _classify("SomeBrandNewTool") is None

    failed = _classify("Shell", {"command": "boom"}, status="error", duration_ms=42)
    assert failed["status"] == "error", failed
    assert failed["duration_ms"] == 42, failed


def _run_all():
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    failed = 0
    for test in tests:
        try:
            test()
            print(f"PASS {test.__name__}")
        except AssertionError as exc:
            failed += 1
            print(f"FAIL {test.__name__}: {exc}")
        except Exception as exc:  # noqa: BLE001
            failed += 1
            print(f"ERROR {test.__name__}: {exc!r}")
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(_run_all())
