import os
import subprocess

import pytest
from fastapi.testclient import TestClient

from app import main


@pytest.mark.parametrize("route", ["/install.sh", "/install.sh?repair=true", "/repair.sh"])
def test_sandbox_scripts_redirect_terminal_environment(monkeypatch, tmp_path, route):
    home = tmp_path / "sandbox home's data"
    home.mkdir()
    monkeypatch.setenv("COT_SANDBOX_HOME", str(home))
    monkeypatch.setenv("COT_PORT", "31491")
    response = TestClient(main.app, base_url="http://127.0.0.1").get(route)
    assert response.status_code == 200
    # Execute the actual exports served to a terminal, stopping before installation.
    prefix = response.text.split("#!/", 2)[1].split("\n", 1)[1].split("#!/", 1)[0]
    result = subprocess.run(
        ["sh", "-c", prefix + '\nprintf "%s\\n" "$HOME" "$COT_ENDPOINT" "$CODEX_HOME"'],
        env={**os.environ, "HOME": str(tmp_path / "real-home")},
        capture_output=True, text=True, check=True,
    )
    assert result.stdout.splitlines() == [str(home), "http://127.0.0.1:31491", str(home / ".codex")]


def test_normal_installer_is_unchanged(monkeypatch):
    monkeypatch.delenv("COT_SANDBOX_HOME", raising=False)
    script = "#!/bin/sh\necho install\n"
    assert main._sandbox_install_script(script) == script
