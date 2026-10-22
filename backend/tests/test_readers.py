"""Passive readers: the bridge's registry of agents imported from disk.

Each reader gets a small store written the way that agent writes it, and must
turn it into prompts, replies, tool calls with results, and token usage.
"""
from __future__ import annotations

import hashlib
import importlib.machinery
import importlib.util
import json
import sqlite3
from pathlib import Path

import pytest

from app import db, passive, store

REPO = Path(__file__).resolve().parents[2]


def _load(name: str, path: Path):
    loader = importlib.machinery.SourceFileLoader(name, str(path))
    spec = importlib.util.spec_from_loader(name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


bridge = _load("cot_bridge_readers_test", REPO / "bridge" / "cot")


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.setattr(bridge, "_import_home", lambda: tmp_path)
    return tmp_path


def _write(path: Path, data) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(data, list) and data and isinstance(data[0], dict) and path.suffix in (".jsonl", ".ndjson"):
        path.write_text("".join(json.dumps(x) + "\n" for x in data))
    else:
        path.write_text(json.dumps(data) if not isinstance(data, str) else data)
    return path


def _payloads(agent: str) -> list[dict]:
    reader = bridge.READERS[agent]
    sessions = reader.sessions()
    assert sessions, f"{agent}: no sessions found"
    out: list[dict] = []
    for s in sessions:
        out += bridge._session_payloads(reader, s, {})
    return out


def _hooks(payloads: list[dict]) -> list[str]:
    return [p["hook_event_name"] for p in payloads]


def _tool(payloads: list[dict], name: str) -> dict:
    return next(p for p in payloads if p["hook_event_name"] == "PreToolUse" and p["tool_name"] == name)


def _usage(payloads: list[dict]) -> dict:
    total: dict = {}
    for p in payloads:
        if p["hook_event_name"] == "ModelUsage":
            for k, v in p["usage"].items():
                total[k] = total.get(k, 0) + v
    return total


def _common(payloads: list[dict], agent: str) -> None:
    assert payloads[0]["hook_event_name"] == "SessionStart"
    assert all(p["_reader"] == agent and p["_import"] for p in payloads)
    keys = [p["_dedup_key"] for p in payloads]
    assert len(keys) == len(set(keys)), "dedup keys must be unique within a session"
    assert all(p["timestamp"] for p in payloads)


# ------------------------------------------------------------------ readers

def test_gemini_cli(home):
    project = "/work/app"
    _write(home / ".gemini" / "projects.json", {"projects": {project: "app"}})
    digest = hashlib.sha256(project.encode()).hexdigest()
    _write(home / ".gemini" / "tmp" / digest / "chats" / "session-2026-01-01T10-00-abc.json", {
        "sessionId": "g-1", "startTime": "2026-01-01T10:00:00Z", "lastUpdated": "2026-01-01T10:05:00Z",
        "messages": [
            {"id": "m1", "type": "user", "timestamp": "2026-01-01T10:00:01Z", "content": "list the files"},
            {"id": "m2", "type": "gemini", "timestamp": "2026-01-01T10:00:05Z", "content": "Here they are.",
             "model": "gemini-2.5-pro", "thoughts": [{"subject": "Plan", "description": "run ls"}],
             "tokens": {"input": 1200, "output": 40, "cached": 200, "thoughts": 10},
             "toolCalls": [{"id": "t1", "name": "run_shell_command", "args": {"command": "ls"}, "status": "success",
                            "result": [{"functionResponse": {"id": "t1", "response": {"output": "a.py"}}}]}]},
        ],
    })
    p = _payloads("gemini-cli")
    _common(p, "gemini-cli")
    assert p[0]["session_id"] == "g-1" and p[0]["cwd"] == project
    assert "UserPromptSubmit" in _hooks(p) and "afterAgentThought" in _hooks(p)
    shell = _tool(p, "Bash")
    assert shell["tool_input"]["command"] == "ls" and shell["raw_tool_name"] == "run_shell_command"
    assert any(x["hook_event_name"] == "PostToolUse" and x["tool_response"] == "a.py" for x in p)
    assert _usage(p) == {"input_tokens": 1000, "output_tokens": 50, "cache_read_tokens": 200, "reasoning_tokens": 10}


def test_copilot_cli(home):
    _write(home / ".copilot" / "session-state" / "c-1" / "events.jsonl", [
        {"type": "session.start", "timestamp": "2026-01-01T10:00:00Z",
         "data": {"sessionId": "c-1", "context": {"cwd": "/work/api"}}},
        {"type": "user.message", "timestamp": "2026-01-01T10:00:01Z", "data": {"content": "fix the test"}},
        {"type": "assistant.message", "timestamp": "2026-01-01T10:00:03Z",
         "data": {"content": "Running it.", "model": "gpt-5", "reasoningText": "check output",
                  "toolRequests": [{"toolCallId": "k1", "name": "bash", "arguments": {"command": "pytest"}}]}},
        {"type": "tool.execution_complete", "timestamp": "2026-01-01T10:00:09Z",
         "data": {"toolCallId": "k1", "success": False, "result": {"content": "1 failed"}}},
        {"type": "session.shutdown", "timestamp": "2026-01-01T10:01:00Z",
         "data": {"modelMetrics": {"gpt-5": {"usage": {"inputTokens": 900, "cacheReadTokens": 100,
                                                       "outputTokens": 30}}}}},
    ])
    p = _payloads("copilot-cli")
    _common(p, "copilot-cli")
    assert p[0]["cwd"] == "/work/api"
    assert any(x["hook_event_name"] == "PostToolUseFailure" and x["tool_response"] == "1 failed" for x in p)
    assert _usage(p)["input_tokens"] == 800 and _hooks(p)[-1] == "SessionEnd"


def test_github_copilot_jsonl_replay(home):
    user = home / "Library" / "Application Support" / "Code" / "User"
    _write(user / "workspaceStorage" / "w1" / "workspace.json", {"folder": "file:///work/site%20one"})
    _write(user / "workspaceStorage" / "w1" / "chatSessions" / "v-1.jsonl", [
        {"kind": 0, "v": {"sessionId": "v-1", "creationDate": 1767261600000, "requests": []}},
        {"kind": 2, "k": ["requests"], "v": [{
            "requestId": "r1", "timestamp": 1767261601000, "modelId": "copilot/gpt-5",
            "message": {"text": "run the build"},
            "response": [{"value": "Building."},
                         {"kind": "toolInvocationSerialized", "toolId": "copilot_runInTerminal", "toolCallId": "x1",
                          "invocationMessage": "Running `npm run build`",
                          "toolSpecificData": {"commandLine": {"original": "npm run build"}}}],
            "result": {"metadata": {"promptTokens": 500, "outputTokens": 20, "resolvedModel": "gpt-5"}},
        }]},
        {"kind": 1, "k": ["customTitle"], "v": "Build"},
    ])
    _write(user / "workspaceStorage" / "w1" / "chatSessions" / "empty.json", {"sessionId": "e", "requests": []})
    p = _payloads("github-copilot")
    _common(p, "github-copilot")
    assert {x["session_id"] for x in p} == {"v-1"}, "an empty chat is skipped"
    assert p[0]["cwd"] == "/work/site one" and p[0]["session_title"] == "Build"
    assert _tool(p, "Bash")["tool_input"]["command"] == "npm run build"
    assert _usage(p) == {"input_tokens": 500, "output_tokens": 20}


def test_zed(home):
    db_path = home / "Library" / "Application Support" / "Zed" / "threads" / "threads.db"
    db_path.parent.mkdir(parents=True)
    conn = sqlite3.connect(db_path)
    conn.execute("CREATE TABLE threads (id TEXT PRIMARY KEY, summary TEXT, updated_at TEXT, data_type TEXT,"
                 " data BLOB, folder_paths TEXT)")
    doc = {"model": {"model": "claude-sonnet-4"}, "messages": [
        {"User": {"content": [{"Text": "read main.rs"}]}},
        {"Agent": {"content": [{"Thinking": {"text": "open it"}}, {"Text": "Done."},
                               {"ToolUse": {"id": "u1", "name": "read_file", "input": {"path": "src/main.rs"}}}],
                   "tool_results": {"u1": {"output": "fn main() {}", "is_error": False}}}},
    ], "request_token_usage": {"r1": {"input_tokens": 300, "output_tokens": 12}}}
    conn.execute("INSERT INTO threads VALUES ('z-1', 'Read main', '2026-01-01T10:00:00Z', 'json', ?, '/work/rs')",
                 (json.dumps(doc).encode(),))
    conn.commit()
    conn.close()
    p = _payloads("zed")
    _common(p, "zed")
    assert p[0]["cwd"] == "/work/rs"
    assert _tool(p, "Read")["tool_input"]["file_path"] == "src/main.rs"
    assert _usage(p) == {"input_tokens": 300, "output_tokens": 12}


def test_trae(home):
    ws = home / "Library" / "Application Support" / "Trae" / "User" / "workspaceStorage" / "t1"
    _write(ws / "workspace.json", {"folder": "file:///work/trae"})
    conn = sqlite3.connect(ws / "state.vscdb")
    conn.execute("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)")
    conn.execute("INSERT INTO ItemTable VALUES (?, ?)", ("memento/icube-ai-agent-storage", json.dumps({"list": [
        {"sessionId": "tr-1", "createdAt": 1767261600000, "updatedAt": 1767261660000, "model": "doubao",
         "messages": [{"role": "user", "content": "add a route", "timestamp": 1767261601000},
                      {"role": "assistant", "content": "", "agentTaskContent": {"proposal": "Added /health."},
                       "timestamp": 1767261650000}]}]})))
    conn.commit()
    conn.close()
    p = _payloads("trae")
    _common(p, "trae")
    assert p[0]["cwd"] == "/work/trae"
    assert [x.get("response") for x in p if x["hook_event_name"] == "afterAgentResponse"] == ["Added /health."]


def test_goose_database_and_running_totals(home):
    root = home / ".local" / "share" / "goose" / "sessions"
    root.mkdir(parents=True)
    conn = sqlite3.connect(root / "sessions.db")
    conn.execute("CREATE TABLE sessions (id TEXT, name TEXT, working_dir TEXT, created_at TEXT, updated_at TEXT,"
                 " model_config_json TEXT, parent_session_id TEXT, accumulated_input_tokens INT,"
                 " accumulated_output_tokens INT, accumulated_total_tokens INT,"
                 " accumulated_cache_read_tokens INT, accumulated_cache_write_tokens INT)")
    conn.execute("CREATE TABLE messages (id INTEGER PRIMARY KEY, message_id TEXT, session_id TEXT, role TEXT,"
                 " content_json TEXT, created_timestamp INT, timestamp TEXT)")
    conn.execute("INSERT INTO sessions VALUES ('go-1', 'Fix lint', '/work/go', '2026-01-01T10:00:00Z',"
                 " '2026-01-01T10:02:00Z', '{\"model_name\": \"gpt-4.1\"}', NULL, 1000, 50, 1050, 0, 0)")
    rows = [("u1", "user", [{"type": "text", "text": "run lint"}]),
            ("a1", "assistant", [{"type": "text", "text": "ok"}, {"type": "toolRequest", "id": "tc1", "toolCall": {
                "status": "success", "value": {"name": "developer__shell", "arguments": {"command": "make lint"}}}}]),
            ("u2", "user", [{"type": "toolResponse", "id": "tc1", "toolResult": {
                "status": "success", "value": [{"type": "text", "text": "clean"}]}}])]
    for i, (mid, role, content) in enumerate(rows):
        conn.execute("INSERT INTO messages (message_id, session_id, role, content_json, created_timestamp)"
                     " VALUES (?, 'go-1', ?, ?, ?)", (mid, role, json.dumps(content), 1767261600 + i))
    conn.commit()
    reader = bridge.READERS["goose"]
    totals: dict = {}
    first = bridge._session_payloads(reader, reader.sessions()[0], totals)
    _common(first, "goose")
    shell = _tool(first, "Bash")
    assert shell["tool_input"]["command"] == "make lint"
    assert any(x["hook_event_name"] == "PostToolUse" and x["tool_response"] == "clean" for x in first)
    assert _usage(first) == {"input_tokens": 1000, "output_tokens": 50}
    # The session grows: only the new tokens are added, under a new key.
    conn.execute("UPDATE sessions SET accumulated_input_tokens = 1500, accumulated_output_tokens = 80")
    conn.commit()
    conn.close()
    second = bridge._session_payloads(reader, reader.sessions()[0], totals)
    assert _usage(second) == {"input_tokens": 500, "output_tokens": 30}
    assert {x["_dedup_key"] for x in second if x["hook_event_name"] == "ModelUsage"}.isdisjoint(
        {x["_dedup_key"] for x in first if x["hook_event_name"] == "ModelUsage"})


def test_crush(home):
    project = home / "work" / "crush-app"
    _write(home / ".local" / "share" / "crush" / "projects.json",
           {"projects": [{"path": str(project), "data_dir": str(project / ".crush")}]})
    (project / ".crush").mkdir(parents=True)
    conn = sqlite3.connect(project / ".crush" / "crush.db")
    conn.execute("CREATE TABLE sessions (id TEXT, title TEXT, parent_session_id TEXT, message_count INT,"
                 " prompt_tokens INT, completion_tokens INT, cost REAL, created_at INT, updated_at INT)")
    conn.execute("CREATE TABLE messages (id TEXT, session_id TEXT, role TEXT, parts TEXT, model TEXT, created_at INT)")
    conn.execute("INSERT INTO sessions VALUES ('cr-1', 'Tests', '', 3, 700, 25, 0.01, 1767261600, 1767261700)")
    parts = [("m1", "user", [{"type": "text", "data": {"text": "find TODOs"}}]),
             ("m2", "assistant", [{"type": "tool_call", "data": {"id": "c1", "name": "grep", "input": "{\"pattern\": \"TODO\"}"}}]),
             ("m3", "tool", [{"type": "tool_result", "data": {"tool_call_id": "c1", "content": "a.go:3", "is_error": False}}])]
    for i, (mid, role, ps) in enumerate(parts):
        conn.execute("INSERT INTO messages VALUES (?, 'cr-1', ?, ?, 'claude-sonnet-4', ?)",
                     (mid, role, json.dumps(ps), 1767261600 + i))
    conn.commit()
    conn.close()
    p = _payloads("crush")
    _common(p, "crush")
    assert p[0]["cwd"] == str(project)
    assert _tool(p, "Grep")["tool_input"]["pattern"] == "TODO"
    assert _usage(p)["input_tokens"] == 700


def test_qwen_code(home):
    _write(home / ".qwen" / "projects" / "-work-q" / "chats" / "q-1.jsonl", [
        {"sessionId": "q-1", "cwd": "/work/q", "uuid": "a", "timestamp": "2026-01-01T10:00:00Z", "type": "user",
         "message": {"role": "user", "parts": [{"text": "read setup.py"}]}},
        {"sessionId": "q-1", "uuid": "b", "timestamp": "2026-01-01T10:00:02Z", "type": "assistant", "model": "qwen3-coder",
         "message": {"role": "model", "parts": [{"text": "Reading."}, {"functionCall": {
             "id": "f1", "name": "read_file", "args": {"absolute_path": "/work/q/setup.py"}}}]},
         "usageMetadata": {"promptTokenCount": 400, "candidatesTokenCount": 9, "cachedContentTokenCount": 100}},
        {"sessionId": "q-1", "uuid": "c", "timestamp": "2026-01-01T10:00:03Z", "type": "tool_result",
         "message": {"role": "user", "parts": [{"functionResponse": {"id": "f1", "response": {"output": "setup()"}}}]}},
    ])
    p = _payloads("qwen-code")
    _common(p, "qwen-code")
    assert _tool(p, "Read")["tool_input"]["file_path"] == "/work/q/setup.py"
    assert any(x["hook_event_name"] == "PostToolUse" and x["tool_response"] == "setup()" for x in p)
    assert _usage(p)["input_tokens"] == 300


def test_cline_cli(home):
    d = home / ".cline" / "data" / "sessions" / "cl-1"
    _write(d / "cl-1.json", {"session_id": "cl-1", "cwd": "/work/cl", "model": "claude-sonnet-4",
                             "started_at": "2026-01-01T10:00:00Z", "ended_at": "2026-01-01T10:03:00Z"})
    _write(d / "cl-1.messages.json", {"messages": [
        {"id": "1", "role": "user", "ts": 1767261601000, "content": [{"type": "text", "text": "rename foo"}]},
        {"id": "2", "role": "assistant", "ts": 1767261602000, "content": [
            {"type": "tool_use", "id": "tu1", "name": "replace_in_file", "input": {"path": "a.ts"}}],
         "metrics": {"inputTokens": 50, "outputTokens": 5}},
        {"id": "3", "role": "user", "ts": 1767261603000, "content": [
            {"type": "tool_result", "tool_use_id": "tu1", "content": "done"}]},
    ]})
    p = _payloads("cline-cli")
    _common(p, "cline-cli")
    assert _tool(p, "Edit")["tool_input"]["file_path"] == "a.ts"
    assert _hooks(p)[-1] == "SessionEnd"


def test_roo_code_task(home):
    task = (home / "Library" / "Application Support" / "Code" / "User" / "globalStorage"
            / "rooveterinaryinc.roo-cline" / "tasks" / "rt-1")
    _write(task / "history_item.json", {"id": "rt-1", "ts": 1767261600000, "task": "add tests", "workspace": "/work/roo"})
    _write(task / "ui_messages.json", [
        {"ts": 1767261600000, "type": "say", "say": "text", "text": "add tests"},
        {"ts": 1767261601000, "type": "say", "say": "api_req_started",
         "text": json.dumps({"tokensIn": 120, "tokensOut": 8, "cacheReads": 40})},
        {"ts": 1767261602000, "type": "ask", "ask": "tool", "text": json.dumps({"tool": "readFile", "path": "a.py"})},
        {"ts": 1767261603000, "type": "ask", "ask": "command", "text": "pytest -q"},
        {"ts": 1767261604000, "type": "say", "say": "command_output", "text": "3 passed"},
        {"ts": 1767261605000, "type": "say", "say": "completion_result", "text": "Tests added."},
    ])
    p = _payloads("roo-code")
    _common(p, "roo-code")
    assert p[0]["cwd"] == "/work/roo"
    assert _tool(p, "Read")["tool_input"]["file_path"] == "a.py"
    assert any(x["hook_event_name"] == "PostToolUse" and x["tool_name"] == "Bash" and x["tool_response"] == "3 passed"
               for x in p)
    assert _usage(p) == {"input_tokens": 120, "output_tokens": 8, "cache_read_tokens": 40}


def test_kimi(home):
    _write(home / ".kimi" / "kimi.json", {"work_dirs": [{"path": "/work/k"}]})
    digest = hashlib.md5(b"/work/k").hexdigest()  # noqa: S324
    _write(home / ".kimi" / "sessions" / digest / "s-1" / "wire.jsonl", [
        {"timestamp": 1767261600.0, "message": {"type": "TurnBegin", "payload": {"user_input": [{"type": "text", "text": "hi"}]}}},
        {"timestamp": 1767261601.0, "message": {"type": "ContentPart", "payload": {"type": "text", "text": "Hello"}}},
        {"timestamp": 1767261602.0, "message": {"type": "ToolCall", "payload": {
            "id": "k1", "function": {"name": "Shell", "arguments": "{\"command\": \"pwd\"}"}}}},
        {"timestamp": 1767261603.0, "message": {"type": "ToolResult", "payload": {
            "tool_call_id": "k1", "return_value": {"is_error": False, "output": "/work/k"}}}},
    ])
    p = _payloads("kimi")
    _common(p, "kimi")
    assert p[0]["cwd"] == "/work/k"
    assert _tool(p, "Bash")["tool_input"]["command"] == "pwd"


def test_kiro_cli(home):
    base = home / ".kiro" / "sessions" / "cli"
    _write(base / "ki-1.json", {"cwd": "/work/kiro", "title": "Docs"})
    _write(base / "ki-1.jsonl", [
        {"kind": "Prompt", "data": {"content": [{"kind": "text", "data": "update README"}]}},
        {"kind": "AssistantMessage", "data": {"content": [
            {"kind": "toolUse", "data": {"toolUseId": "w1", "name": "write",
                                         "input": {"command": "strReplace", "path": "README.md"}}}]}},
        {"kind": "ToolResults", "data": {"content": [{"kind": "toolResult", "data": {"toolUseId": "w1", "content": "ok"}}]}},
    ])
    p = _payloads("kiro-cli")
    _common(p, "kiro-cli")
    assert _tool(p, "Edit")["tool_input"]["file_path"] == "README.md"


def test_openhands(home):
    conv = home / ".openhands" / "conversations" / "oh-1"
    _write(conv / "base_state.json", {"id": "oh-1", "agent": {"llm": {"model": "gpt-5"}}})
    _write(conv / "events" / "0001.json", {"id": "e1", "kind": "MessageEvent", "source": "user",
                                            "timestamp": "2026-01-01T10:00:00",
                                            "llm_message": {"role": "user", "content": [{"type": "text", "text": "ls"}]}})
    _write(conv / "events" / "0002.json", {"id": "e2", "kind": "ActionEvent", "timestamp": "2026-01-01T10:00:01",
                                            "tool_name": "execute_bash", "tool_call_id": "c1", "action": {"command": "ls"}})
    _write(conv / "events" / "0003.json", {"id": "e3", "kind": "ObservationEvent", "timestamp": "2026-01-01T10:00:02",
                                            "tool_call_id": "c1", "observation": {"content": "x", "exit_code": 2}})
    p = _payloads("openhands")
    _common(p, "openhands")
    assert any(x["hook_event_name"] == "PostToolUseFailure" and x["tool_name"] == "Bash" for x in p)


def test_amp(home):
    _write(home / ".local" / "share" / "amp" / "threads" / "T-1.json", {
        "id": "T-1", "created": 1767261600000, "title": "Tidy",
        "env": {"initial": {"trees": [{"uri": "file:///work/amp"}]}},
        "messages": [
            {"role": "user", "content": [{"type": "text", "text": "tidy imports"}], "meta": {"sentAt": 1767261600000}},
            {"role": "assistant", "content": [{"type": "text", "text": "Done"}],
             "usage": {"model": "claude-sonnet-4", "inputTokens": 80, "outputTokens": 6}},
        ]})
    p = _payloads("amp")
    _common(p, "amp")
    assert p[0]["cwd"] == "/work/amp" and _usage(p)["input_tokens"] == 80


def test_aider_is_opt_in_and_reads_history(home, monkeypatch):
    repo = home / "work" / "aid"
    _write(repo / ".aider.chat.history.md",
           "# aider chat started at 2026-01-01 10:00:00\n\n#### add a docstring\n\nSure.\n\n"
           "> Applied edit to app.py\n")
    assert bridge.READERS["aider"].opt_in and not bridge.READERS["aider"].roots()
    monkeypatch.setenv("AIDER_DIR", str(home / "work"))
    p = _payloads("aider")
    _common(p, "aider")
    assert p[0]["cwd"] == str(repo)
    assert _tool(p, "Edit")["tool_input"]["file_path"] == "app.py"
    assert "aider" not in bridge._default_import_agents()


def test_claude_cowork_uses_the_claude_parser(home, monkeypatch):
    ws = home / "Library" / "Application Support" / "Claude" / "local-agent-mode-sessions" / "org" / "ws"
    _write(ws / "local_abc.json", {"title": "Review", "userSelectedFolders": ["/work/picked"]})
    sid = "11111111-2222-3333-4444-555555555555"
    _write(ws / "local_abc" / ".claude" / "projects" / "-sandbox" / f"{sid}.jsonl", [
        {"type": "user", "sessionId": sid, "cwd": "/sandbox", "uuid": "u1", "timestamp": "2026-01-01T10:00:00Z",
         "message": {"role": "user", "content": "summarize README"}},
        {"type": "assistant", "sessionId": sid, "cwd": "/sandbox", "uuid": "a1", "timestamp": "2026-01-01T10:00:02Z",
         "message": {"role": "assistant", "model": "claude-opus-4", "content": [{"type": "text", "text": "It's a CLI."}],
                     "usage": {"input_tokens": 10, "output_tokens": 4}}},
    ])
    posted: list[dict] = []
    monkeypatch.setattr(bridge, "_INGEST_SINK", lambda url, body: posted.extend(body if isinstance(body, list) else [body]))
    count = bridge._import_agent("claude-cowork", None, {}, {}, verbose=False)
    assert count == len(posted) > 0
    assert {p["_reader"] for p in posted} == {"claude-cowork"}
    assert {p["cwd"] for p in posted} == {"/work/picked"}
    assert {p["session_id"] for p in posted} == {sid}


# ------------------------------------------------------- import and storage

def test_import_store_is_incremental(home, monkeypatch):
    test_copilot_cli(home)
    posted: list[dict] = []
    monkeypatch.setattr(bridge, "_INGEST_SINK", lambda url, body: posted.extend(body if isinstance(body, list) else [body]))
    offsets: dict = {}
    reader = bridge.READERS["copilot-cli"]
    first = bridge._import_store(reader, offsets, {}, verbose=False)
    assert first > 0 and bridge._import_store(reader, offsets, {}, verbose=False) == 0
    assert bridge._import_store(reader, {}, {"c-1": "hook"}, verbose=False) == 0  # live capture wins


def test_reader_events_keep_their_source(fresh_db, home):
    test_gemini_cli(home)
    payloads = _payloads("gemini-cli")
    db.record_ingests([("gemini-cli", p) for p in payloads])
    with store.read() as conn:
        session = conn.execute("SELECT source, cwd FROM sessions WHERE id = 'g-1'").fetchone()
        categories = {r["category"] for r in conn.execute("SELECT category FROM events WHERE session_id = 'g-1'")}
    assert session["source"] == "gemini-cli" and session["cwd"] == "/work/app"
    assert "shell" in categories and "prompt" in categories


def test_ingest_route_accepts_reader_sources(fresh_db):
    from fastapi.testclient import TestClient

    from app import main

    client = TestClient(main.app, base_url="http://127.0.0.1")
    body = {"session_id": "z-9", "hook_event_name": "UserPromptSubmit", "prompt": "hi", "_reader": "zed",
            "_import": True, "origin": "import", "timestamp": "2026-01-01T10:00:00Z"}
    assert client.post("/v1/ingest/zed", json=body).status_code == 200
    assert client.post("/v1/ingest/not-an-agent", json=body).status_code == 404


def test_passive_turns_on_agents_added_after_the_list_was_saved(fresh_db):
    db.set_setting("passive_agents", json.dumps(["claude", "codex"]))  # saved before the registry
    agents = passive.config()["agents"]
    assert "claude" in agents and "codex" in agents and "cursor" not in agents
    assert "gemini-cli" in agents and "aider" not in agents
    passive.update_config(agents=["claude"])
    assert passive.config()["agents"] == ["claude"]


def test_passive_scan_counts_a_store(fresh_db, home, monkeypatch):
    monkeypatch.setattr(passive, "_import_home", lambda: home)
    monkeypatch.setattr(passive, "_bridge_module", bridge)
    test_copilot_cli(home)
    info = passive.scan("copilot-cli")
    assert info["readable"] and info["transcripts"] == 1 and info["projects"] == 0


# ------------------------------------------------- more agents, same shapes

def _sqlite(path: Path, *statements: tuple) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    for st in statements:
        conn.execute(*st) if isinstance(st, tuple) else conn.execute(st)
    conn.commit()
    conn.close()


def test_chat_log_shapes_pi_openai_responses_and_ai_sdk(home):
    # Pi-style typed records with a session header.
    _write(home / ".omp" / "agent" / "sessions" / "--w--" / "a.jsonl", [
        {"type": "session", "id": "omp-1", "cwd": "/work/omp", "timestamp": "2026-01-01T10:00:00Z"},
        {"type": "message", "id": "m1", "timestamp": "2026-01-01T10:00:01Z",
         "message": {"role": "user", "content": [{"type": "text", "text": "list files"}]}},
        {"type": "message", "id": "m2", "timestamp": "2026-01-01T10:00:02Z",
         "message": {"role": "assistant", "model": "gpt-5", "content": [
             {"type": "toolCall", "id": "c1", "name": "bash", "arguments": {"command": "ls"}}],
             "usage": {"input": 40, "output": 3, "cacheRead": 10}}},
        {"type": "message", "id": "m3", "timestamp": "2026-01-01T10:00:03Z",
         "message": {"role": "toolResult", "toolCallId": "c1", "content": [{"type": "text", "text": "a.py"}]}},
    ])
    p = _payloads("ohmypi")
    _common(p, "ohmypi")
    assert p[0]["session_id"] == "omp-1" and p[0]["cwd"] == "/work/omp"
    assert _tool(p, "Bash")["tool_input"]["command"] == "ls"
    assert any(x["hook_event_name"] == "PostToolUse" and x["tool_response"] == "a.py" for x in p)
    assert _usage(p) == {"input_tokens": 40, "output_tokens": 3, "cache_read_tokens": 10}
    # OpenAI chat messages with role "tool" results (Reasonix).
    _write(home / ".reasonix" / "sessions" / "r1.jsonl", [
        {"role": "user", "content": "grep TODO", "created_at": "2026-01-01T10:00:00Z"},
        {"role": "assistant", "content": "", "tool_calls": [
            {"id": "t1", "function": {"name": "grep", "arguments": "{\"pattern\": \"TODO\"}"}}]},
        {"role": "tool", "tool_call_id": "t1", "content": "x.go:1"},
        {"role": "assistant", "content": "One TODO.", "reasoning_content": "count them"},
    ])
    p = _payloads("reasonix")
    assert _tool(p, "Grep")["tool_input"]["pattern"] == "TODO"
    assert "afterAgentThought" in _hooks(p) and "afterAgentResponse" in _hooks(p)
    # Responses-API items (WorkBuddy) and AI-SDK parts (Posit Assistant).
    _write(home / ".workbuddy" / "projects" / "p" / "11111111-aaaa-bbbb-cccc-000000000001.jsonl", [
        {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "run tests"}]},
        {"type": "function_call", "callId": "f1", "name": "shell", "arguments": "{\"command\": \"pytest\"}"},
        {"type": "function_call_output", "callId": "f1", "output": "ok"},
    ])
    p = _payloads("workbuddy")
    assert _tool(p, "Bash")["tool_input"]["command"] == "pytest"
    ws = home / ".posit" / "assistant" / "workspaces" / "w1"
    _write(ws / "workspace.json", {"path": "/work/r"})
    _write(ws / "c1" / "conversation.json", {"root": {"title": "Plot sales"}})
    _write(ws / "c1" / "lm-messages.jsonl", [
        {"id": 0, "message": {"role": "user", "content": "plot it"}},
        {"id": 1, "message": {"role": "assistant", "content": [
            {"type": "tool-call", "toolCallId": "k1", "toolName": "read_file", "input": {"path": "sales.csv"}}]}},
        {"id": 2, "message": {"role": "tool", "content": [{"type": "tool-result", "toolCallId": "k1", "output": "a,b"}]}},
    ])
    p = _payloads("posit-assistant")
    assert p[0]["cwd"] == "/work/r" and p[0]["session_title"] == "Plot sales"
    assert any(x["hook_event_name"] == "PostToolUse" and x["tool_name"] == "Read" for x in p)


def test_file_patterns_skip_sidecars_and_subagents(home):
    base = home / ".commandcode" / "projects" / "p"
    for name in ("s1.jsonl", "s1.checkpoints.jsonl", "s1.prompts.jsonl"):
        _write(base / name, [{"role": "user", "content": "hi"}])
    assert [s["_path"].name for s in bridge.READERS["command-code"].sessions()] == ["s1.jsonl"]
    q = home / ".qoder" / "projects" / "proj"
    _write(q / "s2.jsonl", [{"role": "user", "content": "hi"}])
    _write(q / "agent-x.jsonl", [{"role": "user", "content": "sub"}])
    assert [s["_path"].name for s in bridge.READERS["qoder"].sessions()] == ["s2.jsonl"]
    _write(home / ".openclaw" / "agents" / "main" / "sessions" / "s3.jsonl", [{"role": "user", "content": "hi"}])
    _write(home / ".openclaw" / "agents" / "main" / "notes.jsonl", [{"role": "user", "content": "not a session"}])
    assert [s["_path"].name for s in bridge.READERS["openclaw"].sessions()] == ["s3.jsonl"]


def test_cortex_reads_the_companion_history(home):
    conv = home / ".snowflake" / "cortex" / "conversations"
    _write(conv / "c-1.json", {"session_id": "c-1", "title": "Query", "working_directory": "/work/sf"})
    _write(conv / "c-1.history.jsonl", [
        {"role": "user", "content": [{"type": "text", "text": "count rows"}]},
        {"role": "assistant", "content": [{"type": "text", "text": "42"}]},
    ])
    p = _payloads("cortex-code")
    assert p[0]["cwd"] == "/work/sf" and "afterAgentResponse" in _hooks(p)


def test_sqlite_stores(home):
    # ZCode: OpenCode's message / part JSON in its own tables.
    _sqlite(home / ".zcode" / "cli" / "db" / "db.sqlite",
            "CREATE TABLE session (id TEXT, project_id TEXT, workspace_id TEXT, directory TEXT, title TEXT,"
            " time_created TEXT, time_updated TEXT)",
            "CREATE TABLE message (id TEXT, session_id TEXT, data TEXT, time_created TEXT)",
            "CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, data TEXT)",
            "INSERT INTO session VALUES ('z1', 'p', 'w', '/work/z', 'Fix', '2026-01-01T10:00:00Z', '2026-01-01T10:01:00Z')",
            ("INSERT INTO message VALUES ('m1', 'z1', ?, '2026-01-01T10:00:01Z')", (json.dumps({"role": "user"}),)),
            ("INSERT INTO part VALUES ('p1', 'm1', 'z1', ?)", (json.dumps({"type": "text", "text": "fix it"}),)))
    p = _payloads("zcode")
    assert p[0]["cwd"] == "/work/z" and "UserPromptSubmit" in _hooks(p)
    # Shelley: Go llm.Message JSON with numeric content types.
    _sqlite(home / ".config" / "shelley" / "shelley.db",
            "CREATE TABLE conversations (conversation_id TEXT, slug TEXT, created_at TEXT, updated_at TEXT, cwd TEXT,"
            " parent_conversation_id TEXT, model TEXT)",
            "CREATE TABLE messages (conversation_id TEXT, sequence_id INT, type TEXT, llm_data TEXT, user_data TEXT,"
            " usage_data TEXT, created_at TEXT)",
            "INSERT INTO conversations VALUES ('s1', 'tidy', '2026-01-01', '2026-01-01', '/work/s', '', 'claude')",
            ("INSERT INTO messages VALUES ('s1', 1, 'user', ?, '', '', '2026-01-01T10:00:00Z')",
             (json.dumps({"Role": 0, "Content": [{"Type": 2, "Text": "tidy up"}]}),)),
            ("INSERT INTO messages VALUES ('s1', 2, 'agent', ?, '', ?, '2026-01-01T10:00:01Z')",
             (json.dumps({"Role": 1, "Content": [{"Type": 5, "ID": "t1", "ToolName": "bash", "ToolInput": {"command": "ls"}}]}),
              json.dumps({"input_tokens": 9, "output_tokens": 2}))),
            ("INSERT INTO messages VALUES ('s1', 3, 'tool', ?, '', '', '2026-01-01T10:00:02Z')",
             (json.dumps({"Role": 0, "Content": [{"Type": 6, "ToolUseID": "t1", "ToolResult": [{"Type": 2, "Text": "a"}]}]}),)))
    p = _payloads("shelley")
    assert _tool(p, "Bash")["tool_input"]["command"] == "ls"
    assert any(x["hook_event_name"] == "PostToolUse" and x["tool_response"] == "a" for x in p)
    # Omnigent: Responses-style items with integer types.
    _sqlite(home / ".omnigent" / "chat.db",
            "CREATE TABLE conversations (id TEXT, workspace_id TEXT, title TEXT, updated_at INT)",
            "CREATE TABLE conversation_items (id INTEGER PRIMARY KEY, workspace_id TEXT, conversation_id TEXT,"
            " position INT, type INT, data TEXT)",
            "INSERT INTO conversations VALUES ('o1', 'w', 'Shell', 1767261600)",
            ("INSERT INTO conversation_items (workspace_id, conversation_id, position, type, data) VALUES ('w', 'o1', 0, 1, ?)",
             (json.dumps({"role": "user", "content": [{"type": "input_text", "text": "where am i"}]}),)),
            ("INSERT INTO conversation_items (workspace_id, conversation_id, position, type, data) VALUES ('w', 'o1', 1, 2, ?)",
             (json.dumps({"name": "sys_os_shell", "arguments": "{\"command\": \"pwd\"}", "call_id": "c1"}),)),
            ("INSERT INTO conversation_items (workspace_id, conversation_id, position, type, data) VALUES ('w', 'o1', 2, 3, ?)",
             (json.dumps({"call_id": "c1", "output": "/w"}),)))
    p = _payloads("omnigent")
    assert _tool(p, "Bash")["tool_input"]["command"] == "pwd"
    # Devin: OpenAI-style messages in message_nodes.
    _sqlite(home / ".local" / "share" / "devin" / "cli" / "sessions.db",
            "CREATE TABLE sessions (id TEXT, title TEXT, working_directory TEXT, model TEXT, created_at INT,"
            " last_activity_at INT, hidden INT)",
            "CREATE TABLE message_nodes (row_id INTEGER PRIMARY KEY, session_id TEXT, node_id TEXT, parent_node_id TEXT,"
            " chat_message TEXT, created_at INT)",
            "INSERT INTO sessions VALUES ('d1', 'Ship', '/work/d', 'swe-1', 1767261600, 1767261660, 0)",
            ("INSERT INTO message_nodes (session_id, chat_message, created_at) VALUES ('d1', ?, 1767261601)",
             (json.dumps({"role": "user", "content": "ship it"}),)))
    p = _payloads("devin")
    assert p[0]["cwd"] == "/work/d" and "UserPromptSubmit" in _hooks(p)


def test_event_logs_junie_poolside_muse(home):
    _write(home / ".junie" / "sessions" / "index.jsonl", [{"sessionId": "j1", "projectDir": "/work/j"}])
    _write(home / ".junie" / "sessions" / "j1" / "events.jsonl", [
        {"kind": "UserPromptEvent", "timestampMs": 1767261600000, "prompt": "add docs"},
        {"kind": "SessionA2uxEvent", "timestampMs": 1767261601000,
         "event": {"agentEvent": {"kind": "MarkdownBlockUpdatedEvent", "stepId": "s", "text": "Draft"}}},
        {"kind": "SessionA2uxEvent", "timestampMs": 1767261602000,
         "event": {"agentEvent": {"kind": "MarkdownBlockUpdatedEvent", "stepId": "s", "text": "Done"}}},
    ])
    p = _payloads("junie")
    assert p[0]["cwd"] == "/work/j"
    assert [x["response"] for x in p if x["hook_event_name"] == "afterAgentResponse"] == ["Done"]
    _write(home / ".local" / "state" / "poolside" / "trajectories" / "trajectory-1.ndjson", [
        {"type": "session_start", "timestamp": "2026-01-01T10:00:00Z", "session_start": {"workspace": "/work/p", "prompt": "lint"}},
        {"type": "tool_call_parsed", "timestamp": "2026-01-01T10:00:01Z", "tool_call_parsed": {"id": "t", "name": "shell_run", "args": {"cmd": "ruff"}}},
        {"type": "tool_call_result", "timestamp": "2026-01-01T10:00:02Z", "tool_call_result": {"id": "t", "observation": "ok"}},
    ])
    p = _payloads("poolside")
    assert p[0]["cwd"] == "/work/p" and _tool(p, "Bash")["tool_input"]["command"] == "ruff"
    _write(home / ".local" / "share" / "muse" / "sessions" / "2026" / "01" / "01" / "mu-1" / "session.jsonl", [
        {"payload_type": "runtime.session", "recorded_at": 1767261600000000,
         "payload": {"kind": "run", "event": {"kind": "started", "prompt": "hello"}}},
        {"payload_type": "runtime.session", "recorded_at": 1767261601000000,
         "payload": {"kind": "run", "event": {"kind": "assistant_message_committed", "text": "hi", "response_id": "r"}}},
    ])
    p = _payloads("muse-code")
    assert p[0]["session_id"] == "mu-1" and "afterAgentResponse" in _hooks(p)


def test_cursor_ide_skips_chats_cot_already_has(home, monkeypatch):
    db_path = home / "Library" / "Application Support" / "Cursor" / "User" / "globalStorage" / "state.vscdb"
    doc = {"name": "Rename", "createdAt": 1767261600000, "lastUpdatedAt": 1767261660000,
           "workspaceIdentifier": {"uri": {"fsPath": "/work/cur"}},
           "fullConversationHeadersOnly": [{"bubbleId": "b1", "type": 1}, {"bubbleId": "b2", "type": 2}]}
    _sqlite(db_path, "CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB)",
            ("INSERT INTO cursorDiskKV VALUES ('composerData:cid', ?)", (json.dumps(doc),)),
            ("INSERT INTO cursorDiskKV VALUES ('bubbleId:cid:b1', ?)",
             (json.dumps({"type": 1, "text": "rename foo", "createdAt": "2026-01-01T10:00:00Z"}),)),
            ("INSERT INTO cursorDiskKV VALUES ('bubbleId:cid:b2', ?)",
             (json.dumps({"type": 2, "text": "", "createdAt": "2026-01-01T10:00:01Z", "toolFormerData": {
                 "toolCallId": "t1", "name": "edit_file_v2", "rawArgs": "{\"relativeWorkspacePath\": \"a.ts\"}",
                 "status": "completed", "result": "ok"}}),)))
    p = _payloads("cursor-ide")
    assert p[0]["cwd"] == "/work/cur" and _tool(p, "Edit")["tool_input"]["file_path"] == "a.ts"
    posted: list[dict] = []
    monkeypatch.setattr(bridge, "_INGEST_SINK", lambda url, body: posted.extend(body if isinstance(body, list) else [body]))
    monkeypatch.setattr(bridge, "_fetch_session_origins", lambda: {"cid": "import"})
    offsets: dict = {}
    assert bridge._import_store(bridge.READERS["cursor-ide"], offsets, {}, verbose=False) == 0
    assert "cursor-ide:cid" in offsets and not posted


def test_kiro_cli_sqlite_store(home):
    value = {"history": [
        {"user": {"content": {"Prompt": {"prompt": "read main"}}, "timestamp": "2026-01-01T10:00:00Z",
                  "env_context": {"env_state": {"current_working_directory": "/work/k"}}},
         "assistant": {"ToolUse": {"message_id": "a1", "content": "", "tool_uses": [
             {"id": "t1", "name": "fs_read", "args": {"path": "main.rs"}}]}}},
        {"user": {"content": {"ToolUseResults": {"tool_use_results": [
            {"tool_use_id": "t1", "content": [{"Text": "fn main"}], "status": "Success"}]}}},
         "assistant": {"Response": {"message_id": "a2", "content": "It prints."}}},
    ]}
    _sqlite(home / ".local" / "share" / "kiro-cli" / "data.sqlite3",
            "CREATE TABLE conversations_v2 (key TEXT, conversation_id TEXT, value TEXT, created_at INT, updated_at INT)",
            ("INSERT INTO conversations_v2 VALUES ('k', 'kc1', ?, 1767261600000, 1767261660000)", (json.dumps(value),)))
    p = _payloads("kiro-cli")
    assert p[0]["cwd"] == "/work/k"
    assert any(x["hook_event_name"] == "PostToolUse" and x["tool_response"] == "fn main" for x in p)


def test_extra_homes_codex_archive_and_hermes_profiles(home, tmp_path, monkeypatch):
    monkeypatch.setattr(bridge, "AGENT_HOMES_PATH", tmp_path / "agent_homes.json")
    monkeypatch.setattr(bridge, "_import_home", lambda: None)
    monkeypatch.setenv("HOME", str(home))
    work = home / ".claude-work"
    _write(work / "projects" / "-w" / "11111111-2222-3333-4444-555555555555.jsonl", [{"type": "user"}])
    assert bridge._add_agent_home("claude", "~/.claude-work") == str(work.resolve())
    assert work.resolve() in bridge.READERS["claude"].roots()
    assert any(p.parent.parent.parent == work.resolve() for p in bridge.READERS["claude"].discover())
    with pytest.raises(ValueError):
        bridge._add_agent_home("claude", str(tmp_path.parent))  # outside home
    assert bridge._remove_agent_home("claude", str(work.resolve())) == 1
    _write(home / ".codex" / "archived_sessions" / "rollout-2026-x.jsonl", [{"type": "session_meta"}])
    assert any("archived_sessions" in str(p) for p in bridge.READERS["codex"].discover())
    (home / ".hermes" / "profiles" / "work").mkdir(parents=True)
    sqlite3.connect(home / ".hermes" / "profiles" / "work" / "state.db").close()
    assert any(r.name == "work" for r in bridge.READERS["hermes"].roots())


def test_extra_homes_api(fresh_db, tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    from app import main

    monkeypatch.setattr(passive._bridge(), "AGENT_HOMES_PATH", tmp_path / "agent_homes.json")
    folder = Path.home() / ".cot-test-home-does-not-exist"
    client = TestClient(main.app, base_url="http://127.0.0.1")
    r = client.post("/v1/passive/homes", json={"agent": "claude", "path": str(folder)})
    assert r.status_code == 400 and "No folder at" in r.json()["detail"]
    r = client.post("/v1/passive/homes", json={"agent": "nope", "path": "~"})
    assert r.status_code == 400


def test_bridge_defines_each_top_level_name_once():
    """The bridge is one long script: a second def of a name silently replaces
    the first for every caller (a reader helper once shadowed the hook
    installer's _read_json_file and broke `cot install`)."""
    import ast
    import collections

    tree = ast.parse((REPO / "bridge" / "cot").read_text())
    names = [n.name for n in tree.body if isinstance(n, (ast.FunctionDef, ast.ClassDef))]
    assert [n for n, c in collections.Counter(names).items() if c > 1] == []
