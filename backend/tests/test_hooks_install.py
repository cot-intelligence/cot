"""Setup wires hooks from the dashboard: the collector installs the bridge and
runs ``cot install`` itself, so nobody has to open a terminal."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import hooks_install, main, mcp_install

REPO = Path(__file__).resolve().parents[2]


@pytest.fixture
def home(tmp_path, monkeypatch):
    home = tmp_path / "home"
    (home / ".claude").mkdir(parents=True)
    monkeypatch.setenv("HOME", str(home))
    for key in ("COT_CLAUDE_HOME", "CLAUDE_CONFIG_DIR", "COT_CURSOR_HOME", "COT_CODEX_HOME", "CODEX_HOME", "XDG_CONFIG_HOME"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setattr(mcp_install, "bridge_path", lambda: home / ".cot" / "bin" / "cot")
    monkeypatch.setattr(hooks_install, "resolve_python", lambda: sys.executable)
    monkeypatch.setattr(hooks_install, "_in_container", lambda: False)
    return home


def test_installs_bridge_and_wires_claude(home):
    res = hooks_install.install(["claude", "bogus"], endpoint="http://127.0.0.1:9/", bridge_source=REPO / "bridge" / "cot")
    assert res["agents"] == ["claude"]
    bridge = home / ".cot" / "bin" / "cot"
    assert bridge.read_text().splitlines()[0] == f"#!{sys.executable}"
    assert bridge.stat().st_mode & 0o111
    assert json.loads((home / ".cot" / "config.json").read_text()) == {"endpoint": "http://127.0.0.1:9"}
    settings = json.loads((home / ".claude" / "settings.json").read_text())
    assert "cot hook claude" in json.dumps(settings["hooks"])


def test_reports_agents_that_are_not_installed(home):
    res = hooks_install.install(["claude", "hermes"], endpoint="http://127.0.0.1:9", bridge_source=REPO / "bridge" / "cot")
    assert res["skipped"] == ["hermes"]
    assert not (home / ".hermes").exists()


def test_refuses_in_a_container(home, monkeypatch):
    monkeypatch.setattr(hooks_install, "_in_container", lambda: True)
    assert hooks_install.status() == {"available": False, "reason": "container", "python": None}
    with pytest.raises(hooks_install.InstallError):
        hooks_install.install(["claude"], endpoint="http://127.0.0.1:9", bridge_source=REPO / "bridge" / "cot")
    assert not (home / ".cot").exists()


def test_needs_a_python_for_the_bridge(home, monkeypatch):
    monkeypatch.setattr(hooks_install, "resolve_python", lambda: None)
    assert hooks_install.status()["reason"] == "no_python"
    with pytest.raises(hooks_install.InstallError, match="Python 3.9"):
        hooks_install.install(["claude"], endpoint="http://127.0.0.1:9", bridge_source=REPO / "bridge" / "cot")


def test_endpoint_rejects_a_bad_body(home):
    client = TestClient(main.app, base_url="http://127.0.0.1")
    assert client.post("/v1/hooks/install", json={"agents": "claude"}).status_code == 400
    r = client.post("/v1/hooks/install", json={"agents": []})
    assert r.status_code == 400 and "Pick at least one agent" in r.json()["detail"]
