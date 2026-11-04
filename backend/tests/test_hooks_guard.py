"""The hook guard notices when an agent's hooks disappear and re-wires the
agents the person connected, without fighting a disconnect or a broken file."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import db, hooks_guard, hooks_install, main, mcp_install

REPO = Path(__file__).resolve().parents[2]
BRIDGE = REPO / "bridge" / "cot"
ENDPOINT = "http://127.0.0.1:9"


@pytest.fixture
def home(tmp_path, monkeypatch):
    home = tmp_path / "home"
    (home / ".claude").mkdir(parents=True)
    (home / ".cursor").mkdir(parents=True)
    monkeypatch.setenv("HOME", str(home))
    for key in ("COT_CLAUDE_HOME", "CLAUDE_CONFIG_DIR", "COT_CURSOR_HOME", "COT_CODEX_HOME", "CODEX_HOME",
                "XDG_CONFIG_HOME", "HERMES_HOME"):
        monkeypatch.delenv(key, raising=False)
    # The manifest the collector reads is the one the bridge writes.
    monkeypatch.setenv("COT_DB_PATH", str(home / ".cot" / "cot.db"))
    db.init_db()
    monkeypatch.setattr(mcp_install, "bridge_path", lambda: home / ".cot" / "bin" / "cot")
    monkeypatch.setattr(hooks_install, "resolve_python", lambda: sys.executable)
    monkeypatch.setattr(hooks_install, "_in_container", lambda: False)
    monkeypatch.setattr(hooks_guard, "_last_fingerprint", None)
    return home


def _connect(*agents: str) -> None:
    hooks_install.install(list(agents), endpoint=ENDPOINT, bridge_source=BRIDGE)
    hooks_guard.mark_wanted(list(agents))


def _claude_settings(home: Path) -> dict:
    return json.loads((home / ".claude" / "settings.json").read_text())


def _strip_cot(home: Path) -> None:
    """What an agent update or another tool does: rewrite the file without cot."""
    path = home / ".claude" / "settings.json"
    path.write_text(json.dumps({"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "say done"}]}]}}))


def test_refresh_sees_hooks_removed_after_install(home):
    _connect("claude")
    assert hooks_guard.read_manifest()["agents"]["claude"]["installed"]
    _strip_cot(home)
    assert hooks_guard.read_manifest()["agents"]["claude"]["installed"]  # stale until re-read
    assert hooks_install.refresh_status()
    assert not hooks_guard.read_manifest()["agents"]["claude"]["installed"]


def test_rewires_a_connected_agent_and_keeps_its_own_hooks(home):
    _connect("claude")
    _strip_cot(home)
    log = hooks_guard.check(BRIDGE, force=True)
    assert [(e["agent"], e["status"], e["reason"]) for e in log] == [("claude", "repaired", "hooks_missing")]
    hooks = json.dumps(_claude_settings(home)["hooks"])
    assert "cot hook claude" in hooks and "say done" in hooks
    assert hooks_guard.read_manifest()["agents"]["claude"]["installed"]
    assert hooks_guard.repairs()[0]["agent"] == "claude"


def test_leaves_agents_that_were_never_connected(home):
    _connect("claude")
    (home / ".cursor" / "hooks.json").write_text("{}")
    hooks_guard.check(BRIDGE, force=True)
    assert json.loads((home / ".cursor" / "hooks.json").read_text()) == {}


def test_respects_the_switch(home):
    _connect("claude")
    hooks_guard.set_keep_wired(False)
    _strip_cot(home)
    assert hooks_guard.check(BRIDGE, force=True) == []
    assert "cot hook" not in json.dumps(_claude_settings(home))


def test_does_not_overwrite_a_config_that_is_not_valid_json(home):
    _connect("claude")
    (home / ".claude" / "settings.json").write_text('{"hooks": ')
    assert hooks_guard.check(BRIDGE, force=True) == []
    assert (home / ".claude" / "settings.json").read_text() == '{"hooks": '


def test_stops_after_repeated_repairs(home):
    _connect("claude")
    for _ in range(hooks_guard._MAX_REPAIRS):
        _strip_cot(home)
        assert hooks_guard.check(BRIDGE, force=True)[0]["status"] == "repaired"
    _strip_cot(home)
    assert hooks_guard.check(BRIDGE, force=True)[0]["status"] == "paused"
    assert hooks_guard.paused() == {"claude": "keeps_reverting"}
    assert hooks_guard.check(BRIDGE, force=True) == []
    # Connecting again from the dashboard lifts the pause.
    hooks_guard.mark_wanted(["claude"])
    assert hooks_guard.paused() == {}


def test_repairs_a_bridge_whose_python_is_gone(home):
    _connect("claude")
    bridge = home / ".cot" / "bin" / "cot"
    _, _, body = bridge.read_bytes().partition(b"\n")
    bridge.write_bytes(b"#!/nonexistent/python3\n" + body)
    assert hooks_install.bridge_health()["state"] == "no_python"
    log = hooks_guard.check(BRIDGE, force=True)
    assert [(e["agent"], e["reason"]) for e in log] == [("claude", "bridge_no_python")]
    assert hooks_install.bridge_health()["state"] == "ok"


def test_seeds_connected_agents_from_an_existing_install(home):
    hooks_install.install(["claude"], endpoint=ENDPOINT, bridge_source=BRIDGE)
    assert hooks_guard.wanted() == ["claude"]


def test_a_partial_install_counts_as_connected(home):
    """An existing install missing one hook (e.g. SessionEnd) is still kept wired."""
    hooks_install.install(["claude"], endpoint=ENDPOINT, bridge_source=BRIDGE)
    path = home / ".claude" / "settings.json"
    settings = json.loads(path.read_text())
    settings["hooks"].pop("SessionEnd")
    path.write_text(json.dumps(settings))
    hooks_install.refresh_status()
    assert hooks_guard.read_manifest()["agents"]["claude"]["installed"] is False
    status = TestClient(main.app, base_url="http://127.0.0.1").get("/v1/hooks/status").json()
    claude = next(a for a in status["agents"] if a["source"] == "claude")
    assert claude["health"] == "missing_hooks" and claude["wanted"]
    hooks_guard.check(BRIDGE, force=True)
    assert "SessionEnd" in _claude_settings(home)["hooks"]


def test_unchanged_files_skip_the_bridge(home, monkeypatch):
    _connect("claude")
    hooks_guard.check(BRIDGE, force=True)
    calls = []
    monkeypatch.setattr(hooks_install, "refresh_status", lambda: calls.append(1) or True)
    hooks_guard.check(BRIDGE)
    assert calls == []
    _strip_cot(home)
    hooks_guard.check(BRIDGE)
    assert calls == [1]


def test_disconnect_removes_hooks_and_is_not_undone(home):
    _connect("claude")
    client = TestClient(main.app, base_url="http://127.0.0.1")
    r = client.post("/v1/hooks/uninstall", json={"agents": ["claude"]})
    assert r.status_code == 200, r.text
    assert "cot hook" not in json.dumps(_claude_settings(home))
    assert hooks_guard.wanted() == []
    assert hooks_guard.check(BRIDGE, force=True) == []
    status = client.get("/v1/hooks/status").json()
    claude = next(a for a in status["agents"] if a["source"] == "claude")
    assert claude["health"] == "not_installed" and not claude["wanted"]
    assert status["bridge"]["state"] == "ok" and status["keep_wired"]
