"""Agentic Analysis (app/analysis.py): the tool-use loop against a scripted
provider, evidence checking, deliverable actions, and reports saved by an
outside agent over cot mcp."""

from __future__ import annotations

import copy
from pathlib import Path

import pytest

from app import ai_insights, analysis, db, store, timeutil, user_rules


def _seed(tmp_path: Path) -> tuple[str, dict[str, int]]:
    sid = "sess-analysis-1"
    project = tmp_path / "proj"
    project.mkdir()
    with store.write() as conn:
        conn.execute(
            "INSERT INTO sessions (id, source, cwd, started_at, status, archived, created_at)"
            " VALUES (?, 'claude', ?, ?, 'active', 0, ?)",
            (sid, str(project), timeutil.now(), timeutil.now()),
        )
        ids = {}
        for name, category, phase, status, detail in (
            ("prompt", "prompt", "start", "ok", "fix the failing test"),
            ("run1", "shell", "instant", "error", '{"command": "pytest", "response": {"stderr": "ImportError: foo"}}'),
            ("run2", "shell", "instant", "error", '{"command": "pytest", "response": {"stderr": "ImportError: foo"}}'),
            ("reply", "response", "instant", "ok", "Fixed the import."),
        ):
            ids[name] = store.insert_event(
                conn, session_id=sid, source="claude", hook="PostToolUse", phase=phase,
                ts=timeutil.now(), category=category, target="pytest" if category == "shell" else None,
                status=status, detail=detail, created_at=timeutil.now(),
            )
    return sid, ids


class _SyncThread:
    def __init__(self, target, args=(), **_kw):
        self.target, self.args = target, args

    def start(self):
        self.target(*self.args)


def _anthropic_script(monkeypatch, replies: list[dict]) -> list[dict]:
    sent: list[dict] = []

    def fake(url, headers, body):
        sent.append(copy.deepcopy(body))
        return replies.pop(0)

    monkeypatch.setattr(ai_insights, "post_json", fake)
    monkeypatch.setattr(analysis.threading, "Thread", _SyncThread)
    monkeypatch.setenv("COT_ANTHROPIC_API_KEY", "sk-ant-test-key")
    monkeypatch.delenv("COT_DISABLE_LLM", raising=False)
    return sent


def _tool_use(name: str, args: dict, cid: str = "t1") -> dict:
    return {"content": [{"type": "tool_use", "id": cid, "name": name, "input": args}],
            "usage": {"input_tokens": 1000, "output_tokens": 100}}


_VALID_RULE = {
    "version": 1, "name": "Repeated pytest failure", "pillar": "usability", "severity": "warn",
    "type": "match", "scope": {"sources": [], "projects": []},
    "when": {"all": [{"field": "category", "op": "eq", "value": "shell"},
                     {"field": "target", "op": "starts_with", "value": "pytest"},
                     {"field": "status", "op": "eq", "value": "error"}]},
    "subject": "rule", "recommendation": "Read the error before re-running.", "action": "finding",
}


def _report(ids: dict[str, int]) -> dict:
    return {
        "title": "pytest retried on an unchanged import error",
        "summary": "The agent re-ran pytest twice before reading the error.",
        "sections": [
            {"heading": "What happened", "body": "Two identical runs failed.", "evidence": [ids["run1"], ids["run2"]]},
            {"heading": "Root cause", "body": "A missing import.", "evidence": [ids["run1"]]},
        ],
        "findings": [
            {"severity": "warn", "title": "Retry loop", "detail": "Same command, same error.", "evidence": [ids["run1"], f"#{ids['run2']}"]},
            {"severity": "info", "title": "Made up", "detail": "cites nothing real", "evidence": [999999]},
        ],
        "deliverables": [
            {"kind": "memory_edit", "title": "Read errors first", "body": "", "file": "CLAUDE.md",
             "append": "- Read a failing command's error before re-running it.", "evidence": [ids["run2"]]},
            {"kind": "rule", "title": "Flag repeated pytest failures", "body": "", "rule_text": "pytest failing",
             "rule_spec": _VALID_RULE},
            {"kind": "summary", "title": "not this persona's kind", "body": "x"},
        ],
    }


def test_session_run_investigates_validates_and_applies(fresh_db, tmp_path, monkeypatch):
    sid, ids = _seed(tmp_path)
    sent = _anthropic_script(monkeypatch, [
        _tool_use("get_turns", {"start": 1, "end": 1}),
        _tool_use("submit_report", _report(ids), "t2"),
    ])
    run = analysis.start_run("session", sid, "debugger")
    done = analysis.get_run(run["id"])

    assert done["status"] == "ok", done["error"]
    report = done["report"]
    # The finding citing a non-existent event is dropped; '#id' strings are accepted.
    assert [f["title"] for f in report["findings"]] == ["Retry loop"]
    assert report["dropped_findings"] == 1
    assert report["findings"][0]["evidence"] == [
        {"event_id": ids["run1"], "session_id": sid}, {"event_id": ids["run2"], "session_id": sid},
    ]
    # Sections follow the persona outline; kinds outside the persona are dropped.
    assert [s["heading"] for s in report["sections"]] == ["What happened", "Root cause"]
    assert [d["kind"] for d in done["deliverables"]] == ["memory_edit", "rule"]
    assert done["deliverables"][1]["rule_spec"]["name"] == "Repeated pytest failure"
    # The second request carried the tool result back; the system prompt is cached.
    assert sent[1]["messages"][-1]["content"][0]["type"] == "tool_result"
    assert sent[0]["system"][0]["cache_control"] == {"type": "ephemeral"}
    assert any(s["summary"] == "Read turn 1" for s in done["steps"])
    assert done["usage"]["input"] == 2000

    edit = analysis.apply_deliverable(run["id"], "d1")
    target = tmp_path / "proj" / "CLAUDE.md"
    assert edit["status"] == "applied" and target.read_text().strip() == "- Read a failing command's error before re-running it."
    # Applying twice does not duplicate the text.
    analysis.apply_deliverable(run["id"], "d1")
    assert target.read_text().count("Read a failing") == 1

    rule = analysis.apply_deliverable(run["id"], "d2")
    assert any(r["id"] == rule["applied"]["rule_id"] for r in user_rules.list_rules())

    md = analysis.markdown(run["id"])
    assert "## Root cause" in md and "Append to `CLAUDE.md`" in md


def test_invalid_rule_spec_is_kept_as_text_only(fresh_db, tmp_path, monkeypatch):
    sid, ids = _seed(tmp_path)
    bad = _report(ids)
    bad["deliverables"][1]["rule_spec"] = {"version": 1, "name": "broken"}
    _anthropic_script(monkeypatch, [_tool_use("submit_report", bad)])
    run = analysis.get_run(analysis.start_run("session", sid, "debugger")["id"])
    rule = next(d for d in run["deliverables"] if d["kind"] == "rule")
    assert rule["rule_spec"] is None and rule["rule_text"] == "pytest failing"


def test_unknown_tool_is_reported_back_not_fatal(fresh_db, tmp_path, monkeypatch):
    sid, ids = _seed(tmp_path)
    sent = _anthropic_script(monkeypatch, [
        _tool_use("drop_tables", {}),
        _tool_use("submit_report", _report(ids), "t2"),
    ])
    run = analysis.get_run(analysis.start_run("session", sid, "debugger")["id"])
    assert run["status"] == "ok"
    result = sent[1]["messages"][-1]["content"][0]
    assert result["is_error"] is True and "unknown tool" in result["content"]


def test_step_cap_forces_the_report(fresh_db, tmp_path, monkeypatch):
    sid, ids = _seed(tmp_path)
    replies = [_tool_use("get_overview", {}, f"t{n}") for n in range(analysis.MAX_STEPS)]
    sent = _anthropic_script(monkeypatch, [*replies, _tool_use("submit_report", _report(ids), "last")])
    run = analysis.get_run(analysis.start_run("session", sid, "debugger")["id"])
    assert run["status"] == "ok"
    assert sent[-1]["tool_choice"] == {"type": "tool", "name": "submit_report"}


def test_openai_wire_format(fresh_db, tmp_path, monkeypatch):
    import json

    sid, ids = _seed(tmp_path)
    replies = [
        {"choices": [{"message": {"role": "assistant", "content": None, "tool_calls": [
            {"id": "c1", "type": "function", "function": {"name": "submit_report", "arguments": json.dumps(_report(ids))}},
        ]}}], "usage": {"prompt_tokens": 500, "completion_tokens": 50, "prompt_tokens_details": {"cached_tokens": 200}}},
    ]
    _anthropic_script(monkeypatch, replies)
    monkeypatch.delenv("COT_ANTHROPIC_API_KEY")
    monkeypatch.setenv("COT_OPENAI_API_KEY", "sk-test-openai")
    db.set_setting("ai_provider", "openai")
    run = analysis.get_run(analysis.start_run("session", sid, "debugger")["id"])
    assert run["status"] == "ok" and run["provider"] == "openai"
    assert run["usage"]["input"] == 300 and run["usage"]["cache_read"] == 200


def test_no_key_and_custom_without_question_are_refused(fresh_db, tmp_path, monkeypatch):
    sid, _ = _seed(tmp_path)
    monkeypatch.delenv("COT_ANTHROPIC_API_KEY", raising=False)
    with pytest.raises(ai_insights.AiNotConfiguredError):
        analysis.start_run("session", sid, "coach")
    monkeypatch.setenv("COT_ANTHROPIC_API_KEY", "sk-ant-test-key")
    with pytest.raises(analysis.AnalysisError):
        analysis.start_run("session", sid, "custom")


def test_outside_agent_brief_tools_and_save(fresh_db, tmp_path):
    from fastapi.testclient import TestClient

    from app import main

    sid, ids = _seed(tmp_path)
    client = TestClient(main.app, base_url="http://127.0.0.1")
    brief = client.get("/v1/analysis/brief", params={"persona": "debugger", "session_id": sid}).json()
    assert "save_analysis" in brief["instructions"] and "submit_report" not in brief["instructions"]
    assert brief["report_schema"]["properties"]["deliverables"]["items"]["properties"]["kind"]["enum"] == ["root_cause", "memory_edit", "rule"]

    turns = client.post("/v1/analysis/tools/get_turns", json={"session_id": sid, "start": 1}).json()
    assert any(f"#{ids['run1']}" in row for row in turns["turns"][0]["steps"])
    assert client.post("/v1/analysis/tools/nope", json={}).status_code == 400

    saved = client.post("/v1/analysis/runs/external", json={
        "persona": "debugger", "scope": "session", "session_id": sid, "report": _report(ids), "agent": "claude-code",
    }).json()["run"]
    assert saved["runner"] == "agent" and saved["provider"] == "claude-code" and saved["status"] == "ok"
    listed = client.get("/v1/analysis/runs", params={"session_id": sid}).json()["runs"]
    assert listed[0]["id"] == saved["id"] and listed[0]["deliverables"] == 2

    status = client.post(f"/v1/analysis/runs/{saved['id']}/deliverables/d1/status", json={"status": "dismissed"}).json()
    assert status["deliverable"]["status"] == "dismissed"
    export = client.get(f"/v1/analysis/runs/{saved['id']}/export.md")
    assert export.status_code == 200 and export.text.startswith("# pytest retried")
    assert client.get("/v1/analysis/runs/missing").status_code == 404
