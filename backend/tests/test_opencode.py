"""OpenCode-specific projection and installation-state regressions."""
from __future__ import annotations

import ast
from pathlib import Path

import pytest

from app import db, main, store
from app.normalize import normalize
from app.tool_classification import canonical_tool


@pytest.mark.parametrize("tool,category", [("read", "file_read"), ("write", "file_edit"), ("edit", "file_edit")])
@pytest.mark.parametrize("path_key", ["path", "filePath"])
def test_native_file_tools_preserve_targets_and_errors(tool, category, path_key):
    event = normalize("opencode", {
        "session_id": "oc", "hook_event_name": "PostToolUseFailure", "tool_name": tool,
        "tool_input": {path_key: "/repo/π space.txt"}, "tool_response": "fixture error",
    })
    assert (event["tool"], event["category"], event["target"], event["status"]) == (
        tool, category, "/repo/π space.txt", "error",
    )


@pytest.mark.parametrize("tool", ["bash", "shell"])
def test_native_shell_keeps_command(tool):
    event = normalize("opencode", {
        "hook_event_name": "PostToolUse", "tool_name": tool,
        "tool_input": {"command": "printf π"}, "tool_response": "π",
    })
    assert (event["category"], event["target"], event["status"]) == ("shell", "printf π", "ok")


def test_aliases_are_source_specific_and_unknown_failures_remain_errors():
    assert canonical_tool("shell", "opencode") == "Shell"
    assert canonical_tool("shell", "claude") == "shell"
    event = normalize("opencode", {"tool_name": "new_tool", "hook_event_name": "PostToolUseFailure"})
    assert (event["category"], event["status"]) == ("other", "error")


@pytest.mark.parametrize("tool", ["task", "subagent"])
def test_subagent_failure_keeps_call_link(tool):
    event = normalize("opencode", {
        "tool_name": tool, "hook_event_name": "PostToolUseFailure", "tool_use_id": "child-call",
        "tool_input": {"description": "Inspect fixture", "prompt": "Read file"},
    })
    assert (event["category"], event["target"], event["status"]) == ("subagent", "child-call", "error")


@pytest.mark.parametrize("fields,status", [({"error": {"message": "provider rejected"}}, "error"), ({"interrupted": True}, "interrupted"), ({}, "ok")])
def test_terminal_execution_status_is_visible(fields, status):
    event = normalize("opencode", {"hook_event_name": "Stop", **fields})
    assert (event["category"], event["phase"], event["status"]) == ("lifecycle", "end", status)


def test_removed_plugin_is_not_inferred_from_historical_events(fresh_db, monkeypatch):
    db.record_ingest("opencode", {"session_id": "history", "hook_event_name": "UserPromptSubmit", "prompt": "old"})
    monkeypatch.setattr(main, "_read_hook_manifest", lambda: {"agents": {"opencode": {
        "installed": False, "installed_hooks": [], "missing_hooks": main.EXPECTED_HOOKS["opencode"],
    }}})
    status = next(a for a in main.get_hook_status()["agents"] if a["source"] == "opencode")
    assert status["installed"] is False
    assert status["health"] == "not_installed"
    assert status["missing_hooks"]


def test_manual_plugin_inferred_without_its_own_manifest_entry(fresh_db, monkeypatch):
    db.record_ingest("opencode", {"session_id": "manual", "hook_event_name": "UserPromptSubmit", "prompt": "new"})
    monkeypatch.setattr(main, "_read_hook_manifest", lambda: {"agents": {"claude": {"installed": True}}})
    status = next(a for a in main.get_hook_status()["agents"] if a["source"] == "opencode")
    assert status["installed"] is True
    assert status["missing_hooks"] == []


def test_desktop_spec_serves_the_plugin(tmp_path, monkeypatch):
    repo = Path(__file__).resolve().parents[2]
    tree = ast.parse((repo / "desktop/packaging/cot-collector.spec").read_text())
    analysis = next(n for n in ast.walk(tree) if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == "Analysis")
    datas = next(k.value for k in analysis.keywords if k.arg == "datas")
    for entry in datas.elts:
        source, destination = entry.elts
        if ast.literal_eval(destination) == "bridge":
            path = repo.joinpath(*(ast.literal_eval(a) for a in source.args[1:]))
            (tmp_path / path.name).write_bytes(path.read_bytes())
    monkeypatch.setattr(main, "_BRIDGE_DIR", tmp_path)
    response = main.opencode_plugin()
    assert Path(response.path).read_bytes() == (repo / "bridge/opencode-plugin.js").read_bytes()


def test_upgrade_repairs_existing_opencode_tools_without_reimport(fresh_db):
    for tool in ["read", "new_tool"]:
        db.record_ingest("opencode", {
            "session_id": "old-oc", "hook_event_name": "PostToolUseFailure", "tool_name": tool,
            "tool_input": {"filePath": "/repo/a.py"}, "_dedup_key": tool,
        })
    with store.write() as conn:
        conn.execute("UPDATE events SET category='other', status='ok', target=tool")
        conn.execute("UPDATE settings SET value='9' WHERE key='migrations_version'")
    db.init_db()
    db.init_db()
    with store.read() as conn:
        rows = conn.execute("SELECT tool, category, target, status FROM events ORDER BY id").fetchall()
    assert len(rows) == 2
    assert tuple(rows[0]) == ("read", "file_read", "/repo/a.py", "error")
    assert tuple(rows[1]) == ("new_tool", "other", "new_tool", "error")
