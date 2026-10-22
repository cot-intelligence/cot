"""Protected folders: macOS asks before an app reads Documents, Desktop,
Downloads, iCloud Drive or a mounted volume, so the collector leaves them
alone unless the person turns reading them on."""
from __future__ import annotations

from pathlib import Path

import pytest

from app import context_cost, db, extensions, folders, outcomes, store


@pytest.fixture
def mac(monkeypatch, tmp_path):
    monkeypatch.setattr(folders.sys, "platform", "darwin")
    monkeypatch.setattr(folders, "homes", lambda: [tmp_path])
    folders._cache["at"] = -1e9
    return tmp_path


def test_which_folders_are_protected(mac):
    assert folders.protected(mac / "Documents")
    assert folders.protected(mac / "Desktop" / "app")
    assert folders.protected(mac / "Library" / "Mobile Documents" / "com~apple~CloudDocs" / "x")
    assert folders.protected("/Volumes/USB/repo")
    assert not folders.protected(mac / "Dev" / "cot")
    assert not folders.protected(mac / "Documentation")


def test_off_by_default_and_on_by_setting(fresh_db, mac, monkeypatch):
    monkeypatch.setattr(folders, "request_access", lambda: None)
    assert not folders.readable(mac / "Documents" / "app")
    assert folders.readable(mac / "Dev" / "app")
    folders.set_allowed(True)
    assert folders.readable(mac / "Documents" / "app")


def test_other_platforms_read_everything(monkeypatch, tmp_path):
    monkeypatch.setattr(folders.sys, "platform", "linux")
    assert folders.readable(tmp_path / "Documents" / "app")


def test_features_skip_protected_project_folders(fresh_db, mac, monkeypatch):
    project = mac / "Documents" / "app"
    (project / ".git").mkdir(parents=True)
    (project / ".claude").mkdir()
    called: list = []
    monkeypatch.setattr(outcomes.subprocess, "run", lambda *a, **k: called.append(a))
    assert outcomes._repo_root(str(project)) is None and called == []
    assert context_cost._dir_chain(str(project)) == []
    assert extensions.project_roots([str(project)]) == []


def test_counts_sessions_in_protected_folders(fresh_db, mac):
    with store.write() as conn:
        for sid, cwd in (("a", mac / "Documents" / "x"), ("b", mac / "Documents"), ("c", mac / "Dev" / "y"),
                         ("d", mac / "Documents_old")):
            conn.execute("INSERT INTO sessions (id, source, cwd, started_at, created_at) VALUES (?, 'claude', ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')", (sid, str(cwd)))
    assert folders.sessions_in_protected() == 2


def test_settings_api(fresh_db, mac, monkeypatch):
    from fastapi.testclient import TestClient

    from app import main

    monkeypatch.setattr(folders, "request_access", lambda: None)
    client = TestClient(main.app, base_url="http://127.0.0.1")
    assert client.get("/v1/settings").json()["read_protected_folders"] is False
    assert client.put("/v1/settings", json={"read_protected_folders": True}).status_code == 200
    assert client.get("/v1/settings").json()["read_protected_folders"] is True
    assert db.get_setting("read_protected_folders") == "1"
