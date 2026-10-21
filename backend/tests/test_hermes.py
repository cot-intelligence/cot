"""Hermes Agent: plugin translation, state.db import, and installation state.

``fixtures/hermes/hooks.jsonl`` is recorded from Hermes 0.22.2 (two CLI
sessions against a local model): the kwargs each observer hook received.
"""
from __future__ import annotations

import ast
import importlib.machinery
import importlib.util
import json
import sqlite3
from pathlib import Path

import pytest

from app import db, main
from app.normalize import normalize
from app.tool_classification import canonical_tool

REPO = Path(__file__).resolve().parents[2]
FIXTURE = Path(__file__).parent / "fixtures" / "hermes" / "hooks.jsonl"


def _load(name: str, path: Path):
    loader = importlib.machinery.SourceFileLoader(name, str(path))
    spec = importlib.util.spec_from_loader(name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


bridge = _load("cot_bridge_hermes_test", REPO / "bridge" / "cot")


@pytest.fixture
def plugin(monkeypatch):
    """The Hermes plugin with its forwarder replaced by a list."""
    module = _load("cot_hermes_plugin_test", REPO / "bridge" / "hermes-plugin" / "__init__.py")
    sent: list[dict] = []
    monkeypatch.setattr(module._queue, "put_nowait", lambda body: sent.append(json.loads(body)))
    monkeypatch.setattr(module, "_ensure_worker", lambda: None)
    monkeypatch.setattr(module, "_cwd", lambda: "/repo")
    module.sent = sent
    return module


def _replay(plugin) -> list[dict]:
    callbacks: dict = {}

    class Ctx:
        def register_hook(self, name, fn):
            callbacks[name] = fn

    plugin.register(Ctx())
    for line in FIXTURE.read_text().splitlines():
        row = json.loads(line)
        assert callbacks[row["hook"]](**row["kwargs"]) is None  # never a directive
    return plugin.sent


def test_recorded_session_projects_onto_cot_events(plugin):
    events = [normalize("hermes", p) for p in _replay(plugin) if p["session_id"] == "20261021_023606_92f354"]
    shape = [(e["hook"], e["category"], e["target"], e["status"]) for e in events]
    assert shape == [
        ("SessionStart", "lifecycle", "/repo", "ok"),
        ("UserPromptSubmit", "prompt", None, "ok"),
        ("ModelUsage", "lifecycle", "llama3.2-64k", "ok"),
        ("PostToolUse", "shell", "ls -la", "ok"),
        ("PostToolUse", "file_edit", "calc.py", "ok"),
        ("PostToolUse", "file_read", "calc.py", "ok"),
        ("ModelUsage", "lifecycle", "llama3.2-64k", "ok"),
        ("afterAgentResponse", "response", None, "ok"),
        ("Stop", "lifecycle", None, "ok"),
        ("SessionEnd", "lifecycle", None, "ok"),
    ]
    assert all(e["source"] == "hermes" and e["cwd"] == "/repo" for e in events)
    usage = [e for e in events if e["hook"] == "ModelUsage"]
    assert (usage[1]["input_tokens"], usage[1]["output_tokens"], usage[1]["cache_read_tokens"]) == (580, 191, 3518)
    assert next(e for e in events if e["category"] == "shell")["duration_ms"] == 1227


def test_command_blocked_by_approval_gate_is_a_failure(plugin):
    payloads = [p for p in _replay(plugin) if p.get("tool_name") == "terminal"
                and p["session_id"] == "20261021_022851_bbea04"]
    assert [(p["hook_event_name"], p["tool_status"]) for p in payloads] == [("PostToolUseFailure", "blocked")]
    assert normalize("hermes", payloads[0])["status"] == "error"


def test_turn_end_is_not_session_end_and_payloads_dedupe(plugin):
    payloads = _replay(plugin)
    stop = next(p for p in payloads if p["hook_event_name"] == "Stop")
    assert normalize("hermes", stop)["title"] == "Turn ended"
    keys = [p["_dedup_key"] for p in payloads if "_dedup_key" in p]
    assert len(keys) == len(set(keys))
    assert all(k.startswith(f"hermes:{p['session_id']}:") for p, k in
               ((p, p.get("_dedup_key")) for p in payloads) if k)


def test_finalize_without_activity_is_dropped(plugin):
    plugin._on_session_finalize(session_id="never-started", reason="shutdown")
    assert plugin.sent == []


def test_subagent_links_child_to_parent(plugin):
    plugin._on_subagent_start(parent_session_id="parent", child_session_id="child",
                              child_role="leaf", child_goal="Read calc.py")
    plugin._on_subagent_stop(parent_session_id="parent", child_session_id="child", child_role="leaf",
                             child_status="completed", duration_ms=64010)
    start, child, stop, end = plugin.sent
    assert (start["session_id"], start["hook_event_name"], start["subagent_id"]) == ("parent", "SubagentStart", "child")
    assert (child["session_id"], child["hook_event_name"], child["parent_session_id"]) == ("child", "SessionStart", "parent")
    assert (stop["session_id"], stop["hook_event_name"]) == ("parent", "SubagentStop")
    assert (end["session_id"], end["hook_event_name"]) == ("child", "SessionEnd")


def test_reasoning_and_interim_text_become_thoughts_and_responses(plugin):
    plugin._on_post_api_request(session_id="s", api_request_id="r1", model="m", usage=None,
                                response={"assistant_message": {"reasoning": "think first"}})
    plugin._on_interim_message(session_id="s", text="Looking at the file.", turn_id="t", iteration=1)
    assert [(p["hook_event_name"], p.get("thought") or p.get("response")) for p in plugin.sent] == [
        ("afterAgentThought", "think first"), ("afterAgentResponse", "Looking at the file."),
    ]


def test_callbacks_swallow_errors(plugin, monkeypatch):
    callbacks: dict = {}

    class Ctx:
        def register_hook(self, name, fn):
            callbacks[name] = fn

    plugin.register(Ctx())
    monkeypatch.setattr(plugin, "_send", lambda *a, **k: 1 / 0)
    assert callbacks["post_tool_call"](tool_name="terminal", args={}, session_id="s") is None


@pytest.mark.parametrize("tool,canonical", [
    ("terminal", "Bash"), ("read_file", "Read"), ("write_file", "Write"), ("patch", "Edit"),
    ("search_files", "Grep"), ("delegate_task", "Task"), ("clarify", "AskUserQuestion"),
])
def test_tool_aliases_are_hermes_only(tool, canonical):
    assert canonical_tool(tool, "hermes") == canonical
    assert canonical_tool(tool, "claude") == tool


# --- state.db import -----------------------------------------------------------

_SCHEMA = """
CREATE TABLE schema_version (version INTEGER NOT NULL);
CREATE TABLE sessions (
    id TEXT PRIMARY KEY, source TEXT NOT NULL, chat_id TEXT, model TEXT, parent_session_id TEXT,
    started_at REAL NOT NULL, ended_at REAL, end_reason TEXT, title TEXT, cwd TEXT, last_activity_at REAL);
CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT,
    tool_call_id TEXT, tool_calls TEXT, tool_name TEXT, timestamp REAL NOT NULL, reasoning TEXT,
    reasoning_content TEXT, active INTEGER NOT NULL DEFAULT 1, message_uid TEXT, tool_call_uids TEXT,
    tool_call_uid TEXT);
CREATE TABLE session_model_usage (
    session_id TEXT NOT NULL, model TEXT NOT NULL, task TEXT NOT NULL DEFAULT '', input_tokens INTEGER,
    output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, reasoning_tokens INTEGER,
    last_seen REAL);
"""


@pytest.fixture
def hermes_home(tmp_path, monkeypatch):
    home = tmp_path / ".hermes"
    home.mkdir()
    conn = sqlite3.connect(home / "state.db")
    conn.executescript(_SCHEMA)
    conn.execute("INSERT INTO schema_version VALUES (31)")
    conn.execute("INSERT INTO sessions VALUES ('cli1', 'oneshot', NULL, 'm', NULL, 100.5, 200, 'cli_close',"
                 " 'Fix', '/repo', 190)")
    conn.execute("INSERT INTO sessions VALUES ('tg1', 'telegram', '42', 'm', NULL, 50, NULL, NULL, NULL, NULL, 60)")
    calls = [{"id": "c1", "function": {"name": "read_file", "arguments": '{"path": "calc.py"}'}},
             {"id": "c2", "function": {"name": "terminal", "arguments": '{"command": "python3 -c x"}'}}]
    rows = [
        ("user", "fix it", None, None, None, 100.0, None, 1, "u1", None, None),
        ("assistant", "", None, json.dumps(calls), None, 101, "plan", 1, "a1", '{"c1": "x1", "c2": "x2"}', None),
        ("tool", '{"content": "1|def add"}', "c1", None, "read_file", 102, None, 1, "t1", None, "x1"),
        ("tool", '{"output": "", "exit_code": -1, "error": "BLOCKED"}', "c2", None, "terminal", 103, None, 1, "t2", None, "x2"),
        ("assistant", "superseded", None, None, None, 104, None, 0, "old", None, None),
        ("assistant", "Fixed.", None, None, None, 105, None, 1, "a2", None, None),
    ]
    conn.executemany(
        "INSERT INTO messages (session_id, role, content, tool_call_id, tool_calls, tool_name, timestamp,"
        " reasoning, active, message_uid, tool_call_uids, tool_call_uid) VALUES ('cli1',?,?,?,?,?,?,?,?,?,?,?)",
        rows,
    )
    conn.execute("INSERT INTO session_model_usage VALUES ('cli1', 'm', '', 10, 5, 3, 0, 0, 150)")
    conn.commit()
    conn.close()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.delenv("COT_HERMES_GATEWAY", raising=False)
    return home


def test_import_index_skips_gateway_chats(hermes_home, monkeypatch):
    assert [s["id"] for s in bridge._hermes_session_index(hermes_home)] == ["cli1"]
    monkeypatch.setenv("COT_HERMES_GATEWAY", "1")
    assert {s["id"] for s in bridge._hermes_session_index(hermes_home)} == {"cli1", "tg1"}


def test_import_payloads_pair_tools_and_skip_inactive_rows(hermes_home):
    session = bridge._hermes_session_index(hermes_home)[0]
    payloads = bridge._hermes_session_payloads(
        session, bridge._hermes_messages(hermes_home, "cli1"), bridge._hermes_model_usage(hermes_home, "cli1"))
    events = [normalize("hermes", p) for p in payloads]
    assert [(e["hook"], e["category"], e["target"], e["status"]) for e in events] == [
        ("SessionStart", "lifecycle", "/repo", "ok"),
        ("UserPromptSubmit", "prompt", None, "ok"),
        ("afterAgentThought", "thought", None, "ok"),
        ("PreToolUse", "file_read", "calc.py", "ok"),
        ("PreToolUse", "shell", "python3 -c x", "ok"),
        ("PostToolUse", "file_read", "calc.py", "ok"),
        ("PostToolUseFailure", "shell", "python3 -c x", "error"),
        ("afterAgentResponse", "response", None, "ok"),
        ("ModelUsage", "lifecycle", "m", "ok"),
        ("SessionEnd", "lifecycle", None, "ok"),
    ]
    # The first message predates the session row; the session starts with it.
    assert payloads[0]["timestamp"] <= payloads[1]["timestamp"]
    assert {p["_dedup_key"] for p in payloads} >= {"hermes:cli1:tool:start:x1", "hermes:cli1:tool:end:x1"}
    assert all(p["origin"] == "import" for p in payloads)


def test_import_is_incremental(hermes_home, monkeypatch):
    posted: list[dict] = []
    monkeypatch.setattr(bridge, "_import_home", lambda: hermes_home.parent)
    monkeypatch.setattr(bridge, "_send_once", lambda url, payload, timeout: posted.append(payload) or True)
    live: dict = {}
    monkeypatch.setattr(bridge, "_fetch_session_origins", lambda: dict(live))
    offsets: dict = {}
    assert bridge._import_hermes(offsets, {}, verbose=False) == 10
    assert bridge._import_hermes(offsets, {}, verbose=False) == 0
    assert bridge._import_hermes({}, {"cli1": "hook"}, verbose=False) == 0  # live capture wins
    # A session the plugin began capturing after the import's origin snapshot.
    live["cli1"] = "hook"
    assert bridge._import_hermes({}, {}, verbose=False) == 0


def test_unreadable_store_reads_as_empty(tmp_path):
    (tmp_path / "state.db").write_text("not sqlite")
    assert bridge._hermes_session_index(tmp_path) == []


# --- install state -------------------------------------------------------------


@pytest.mark.parametrize("config,enabled", [
    ("plugins:\n  enabled:\n    - cot\n  disabled: []\n", True),
    ("plugins:\n  clone_timeout_seconds: 300\n\n# ====\n# Model\n# ====\n  enabled:\n    - other\n    - cot\n", True),
    ("plugins:\n  enabled: [other, 'cot']\n", True),
    ("plugins:\n  enabled:\n    - cot-recorder\n  disabled:\n    - cot\n", False),
    ("model:\n  enabled:\n    - cot\n", False),
])
def test_plugin_enabled_scan(tmp_path, monkeypatch, config, enabled):
    (tmp_path / "config.yaml").write_text(config)
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    assert bridge._hermes_plugin_enabled() is enabled


def test_plugin_files_are_served_and_bundled(tmp_path, monkeypatch):
    tree = ast.parse((REPO / "desktop/packaging/cot-collector.spec").read_text())
    analysis = next(n for n in ast.walk(tree) if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == "Analysis")
    datas = next(k.value for k in analysis.keywords if k.arg == "datas")
    bundled = set()
    for entry in datas.elts:
        source, destination = entry.elts
        if ast.literal_eval(destination) == "bridge/hermes-plugin":
            bundled.add(ast.literal_eval(source.args[-1]))
    assert bundled == set(bridge.HERMES_PLUGIN_FILES)
    for name in bridge.HERMES_PLUGIN_FILES:
        assert Path(main.hermes_plugin(name).path) == REPO / "bridge" / "hermes-plugin" / name
    assert bridge.HERMES_PLUGIN_MARKER in (REPO / "bridge/hermes-plugin/__init__.py").read_text()
    with pytest.raises(main.HTTPException):
        main.hermes_plugin("../cot")


def test_bridge_and_collector_agree_on_expected_hooks():
    assert list(bridge.HERMES_EVENTS) == main.EXPECTED_HOOKS["hermes"]
    assert "hermes" in main.AGENTS and "hermes" in bridge.AGENTS


def test_manual_plugin_inferred_from_events(fresh_db, monkeypatch):
    db.record_ingest("hermes", {"session_id": "manual", "hook_event_name": "UserPromptSubmit", "prompt": "hi"})
    monkeypatch.setattr(main, "_read_hook_manifest", lambda: {"agents": {"claude": {"installed": True}}})
    status = next(a for a in main.get_hook_status()["agents"] if a["source"] == "hermes")
    assert (status["installed"], status["missing_hooks"]) == (True, [])


def test_child_session_records_its_parent(fresh_db):
    db.record_ingest("hermes", {"session_id": "parent", "hook_event_name": "SessionStart"})
    db.record_ingest("hermes", {"session_id": "child", "hook_event_name": "SessionStart",
                                "parent_session_id": "parent", "session_title": "Read calc.py"})
    from app import store
    with store.read() as conn:
        row = conn.execute("SELECT parent_session_id, subagent_label FROM sessions WHERE id='child'").fetchone()
    assert tuple(row) == ("parent", "Read calc.py")
