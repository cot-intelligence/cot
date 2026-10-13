"""Context cost: the preamble every request carries, split into buckets."""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from app import activity, context_cost, extension_usage, extensions, store, timeutil


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)


def _skill(root: Path, name: str, description: str) -> None:
    _write(root / name / "SKILL.md", f"---\nname: {name}\ndescription: {description}\n---\nBody\n")


def _recent(minutes: int = 0) -> str:
    return (datetime.now(timezone.utc) - timedelta(minutes=minutes)).isoformat()


@pytest.fixture
def homes(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, fresh_db) -> dict[str, Path]:
    home = tmp_path / "home"
    claude = home / ".claude"
    cursor = home / ".cursor"
    project = tmp_path / "work" / "proj"
    (project / ".git").mkdir(parents=True)
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("COT_CLAUDE_HOME", str(claude))
    monkeypatch.setenv("COT_CURSOR_HOME", str(cursor))
    monkeypatch.setenv("COT_CODEX_HOME", str(home / ".codex"))
    monkeypatch.setenv("COT_AGENTS_HOME", str(home / ".agents"))
    monkeypatch.setenv("COT_CLAUDE_DESKTOP_CONFIG", str(tmp_path / "none.json"))
    monkeypatch.setenv("COT_CLAUDE_MANAGED_MCP", str(tmp_path / "none2.json"))
    extensions.clear_cache()

    # Claude: a global CLAUDE.md that imports another file, a project CLAUDE.md,
    # two skills (one used) and a project-scoped skill elsewhere.
    _write(claude / "CLAUDE.md", "Be brief.\n@RULES.md\n")
    _write(claude / "RULES.md", "r" * 400)
    _write(project / "CLAUDE.md", "p" * 800)
    _skill(claude / "skills", "used-one", "d" * 200)
    _skill(claude / "skills", "idle-one", "d" * 200)
    _skill(tmp_path / "other" / ".claude" / "skills", "elsewhere", "d" * 200)

    # Cursor: one user MCP server with cached tool definitions, never called,
    # and one that is called.
    _write(cursor / "mcp.json", json.dumps({"mcpServers": {"bigsrv": {"url": "https://x"}, "busy": {"url": "https://y"}}}))
    for server, tools in (("bigsrv", {"a": 16_000, "b": 8_000}), ("busy", {"go": 400})):
        base = cursor / "projects" / "slug" / "mcps" / server
        _write(base / "SERVER_METADATA.json", json.dumps({"serverName": server}))
        for tool, size in tools.items():
            _write(base / "tools" / f"{tool}.json", json.dumps({"name": tool, "description": "x" * size}))
    return {"home": home, "claude": claude, "project": project}


def _session(sid: str, source: str, cwd: str) -> None:
    now = timeutil.now()
    with store.write() as conn:
        conn.execute(
            "INSERT INTO sessions (id, source, cwd, started_at, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)",
            (sid, source, cwd, now, now),
        )


def _request(sid: str, source: str, *, i=10, cr=0, cw=0, model="claude-sonnet-4-5", minutes=1, **kw) -> None:
    with store.write() as conn:
        store.insert_event(conn, session_id=sid, source=source, hook="h", ts=_recent(minutes), model=model,
                           input_tokens=i, cache_read_tokens=cr, cache_write_tokens=cw, **kw)


def test_memory_files_follow_the_cwd_chain_and_imports(homes):
    (homes["project"] / "src").mkdir()
    files = {str(p): n for p, n in context_cost.memory_files("claude", str(homes["project"] / "src"))}
    assert files == {
        str(homes["claude"] / "CLAUDE.md"): len("Be brief.\n@RULES.md\n"),
        str((homes["claude"] / "RULES.md").resolve()): 400,
        str(homes["project"] / "CLAUDE.md"): 800,
    }
    # Codex reads AGENTS.md, not CLAUDE.md.
    assert context_cost.memory_files("codex", str(homes["project"])) == []


def test_report_measures_floor_and_splits_the_preamble(homes):
    proj = str(homes["project"])
    _session("c1", "claude", proj)
    # Anthropic semantics: cache reads sit beside input. Smallest prompt is the floor.
    _request("c1", "claude", i=5, cr=20_000, cw=1_000)
    _request("c1", "claude", i=5, cr=30_000)
    _request("c1", "claude", i=5, cr=25_000)

    r = context_cost.report(30)
    claude = next(a for a in r["agents"] if a["agent"] == "claude")
    assert claude["requests"] == 3
    assert claude["floor_tokens"] == 21_005
    per = claude["per_request"]
    # ~(10 + 400 bytes of global memory + 800 of project memory) / 4
    assert 290 <= per["memory"] <= 310
    # Two user skills; the other project's skill is not loaded here.
    keys = {s["key"] for s in r["skills"]}
    assert keys == {"skill:used-one", "skill:idle-one"}
    assert per["skills"] > 0
    assert per["agent_and_other"] == 21_005 - per["memory"] - per["skills"] - per["mcp"]
    assert claude["overhead_tokens"] == 3 * (per["memory"] + per["skills"] + per["mcp"])
    assert claude["overhead_cost_usd"] > 0


def test_openai_style_cached_input_is_not_double_counted(homes):
    _session("x1", "codex", str(homes["project"]))
    _request("x1", "codex", i=50_000, cr=45_000, model="gpt-5")
    codex = next(a for a in context_cost.report(30)["agents"] if a["agent"] == "codex")
    assert codex["floor_tokens"] == 50_000


def test_per_turn_sources_get_no_floor(homes):
    _session("k1", "cursor", str(homes["project"]))
    _request("k1", "cursor", i=900_000, cr=800_000, model="claude-sonnet-4-5")
    cursor = next(a for a in context_cost.report(30)["agents"] if a["agent"] == "cursor")
    assert cursor["floor_tokens"] is None
    assert cursor["per_request"]["agent_and_other"] is None
    # Cursor's cached tool definitions size its MCP servers.
    assert cursor["per_request"]["mcp"] > 6_000


def test_idle_mcp_server_is_worth_a_look(homes):
    proj = str(homes["project"])
    _session("k1", "cursor", proj)
    for m in range(4):
        _request("k1", "cursor", i=1000, minutes=m + 1)
    with store.write() as conn:
        store.insert_event(conn, session_id="k1", source="cursor", hook="h", tool="MCP:go", category="mcp",
                           target="MCP:go", ts=_recent(2))
    extension_usage.sync()

    r = context_cost.report(30)
    by = {m["name"]: m for m in r["mcp"]}
    assert by["bigsrv"]["idle"] is True and by["bigsrv"]["tools"] == 2
    assert by["busy"]["idle"] is False and by["busy"]["calls"] == 1
    assert by["bigsrv"]["tokens_total"] == by["bigsrv"]["tokens_per_request"] * 4

    [item] = context_cost.idle_attention("mcp", 30, compute=context_cost.report)
    assert item["kind"] == "idle_overhead"
    assert item["severity"] == "warn"
    assert item["names"] == ["bigsrv"]
    assert item["ref"] is None
    assert "1 MCP server never called" in item["title"]

    # Too short a range to call anything idle.
    assert context_cost.idle_attention("mcp", 1, compute=context_cost.report) == []

    # And it reaches the Activity page's list.
    kinds = [a["kind"] for a in activity.summarize("mcp", 30)["attention"]]
    assert "idle_overhead" in kinds


def test_claude_skill_descriptions_are_capped_by_the_listing_budget(homes, monkeypatch):
    monkeypatch.setattr(context_cost, "_CLAUDE_SKILL_DESC_BUDGET", 100)
    capped = context_cost._skill_listing("claude", {
        "skill:a": {"name": "a", "description": "d" * 1000},
        "skill:b": {"name": "b", "description": "d" * 1000},
    })
    uncapped = context_cost._skill_listing("codex", {
        "skill:a": {"name": "a", "description": "d" * 1000},
    })
    # Each keeps its name and half the 100-char budget.
    assert capped["skill:a"] == context_cost._tokens(1 + context_cost._SKILL_LISTING_OVERHEAD + 50)
    assert uncapped["skill:a"] == context_cost._tokens(1 + context_cost._SKILL_LISTING_OVERHEAD + 1000)
