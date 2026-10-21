"""One-click `cot mcp` registration (app/mcp_install.py): merges into each
agent's config without touching anything else, and removes cleanly."""

from __future__ import annotations

import json

import pytest

from app import mcp_install


@pytest.fixture
def homes(fresh_db, tmp_path, monkeypatch):
    for name in ("claude", "cursor", "codex"):
        (tmp_path / name).mkdir()
    monkeypatch.setenv("COT_CLAUDE_HOME", str(tmp_path / "claude"))
    monkeypatch.setenv("COT_CURSOR_HOME", str(tmp_path / "cursor"))
    monkeypatch.setenv("COT_CODEX_HOME", str(tmp_path / "codex"))
    bridge = fresh_db.parent / "bin" / "cot"
    bridge.parent.mkdir()
    bridge.write_text("#!/bin/sh\n")
    return tmp_path, str(bridge)


def test_install_merges_and_keeps_existing_servers(homes):
    tmp, bridge = homes
    claude = tmp / "claude" / ".claude.json"
    claude.write_text(json.dumps({"numStartups": 9, "mcpServers": {"other": {"command": "x"}}}))
    codex = tmp / "codex" / "config.toml"
    codex.write_text('model = "o4"\n# keep me\n\n[mcp_servers.other]\ncommand = "y"\n')

    for agent in mcp_install.AGENTS:
        assert mcp_install.install(agent)["current"] is True

    data = json.loads(claude.read_text())
    assert data["numStartups"] == 9 and data["mcpServers"]["other"] == {"command": "x"}
    assert data["mcpServers"]["cot"] == {"type": "stdio", "command": bridge, "args": ["mcp"]}
    assert json.loads((tmp / "cursor" / "mcp.json").read_text())["mcpServers"]["cot"]["args"] == ["mcp"]
    text = codex.read_text()
    assert "# keep me" in text and "[mcp_servers.other]" in text and f'command = "{bridge}"' in text
    assert (tmp / "claude" / ".claude.json.cot-backup").exists()

    # Installing again replaces the entry instead of duplicating it.
    mcp_install.install("codex")
    assert codex.read_text().count("[mcp_servers.cot]") == 1


def test_uninstall_removes_only_cot(homes):
    tmp, _ = homes
    mcp_install.install("codex")
    mcp_install.install("cursor")
    assert mcp_install.uninstall("codex")["installed"] is False
    assert mcp_install.uninstall("cursor")["installed"] is False
    assert "mcp_servers.cot" not in (tmp / "codex" / "config.toml").read_text()
    assert json.loads((tmp / "cursor" / "mcp.json").read_text())["mcpServers"] == {}


def test_broken_json_is_left_alone(homes):
    tmp, _ = homes
    bad = tmp / "cursor" / "mcp.json"
    bad.write_text("{not json")
    with pytest.raises(mcp_install.InstallError):
        mcp_install.install("cursor")
    assert bad.read_text() == "{not json"


def test_startup_refreshes_stale_installed_bridge(fresh_db, tmp_path, monkeypatch):
    from app import main

    bundled = tmp_path / "bundle"
    bundled.mkdir()
    (bundled / "cot").write_text("#!/usr/bin/env python3\nprint('new')\n")
    monkeypatch.setattr(main, "_BRIDGE_DIR", bundled)
    installed = fresh_db.parent / "bin" / "cot"

    assert main._refresh_installed_bridge() is False  # never installs one
    assert not installed.exists()

    installed.parent.mkdir()
    installed.write_text("#!/opt/py/bin/python3\nprint('old')\n")
    installed.chmod(0o755)
    assert main._refresh_installed_bridge() is True
    assert installed.read_text() == "#!/opt/py/bin/python3\nprint('new')\n"
    assert installed.stat().st_mode & 0o111
    assert main._refresh_installed_bridge() is False
