"""Focused checks for bridge installer interpreter selection."""

from __future__ import annotations

import os
import subprocess
import tempfile
from pathlib import Path


REPO = Path(__file__).resolve().parents[2]
INSTALLER = REPO / "bridge" / "install.sh"


def _write_executable(path: Path, body: str) -> None:
    path.write_text(f"#!/bin/sh\n{body}\n")
    path.chmod(0o755)


def _fake_curl(path: Path) -> None:
    _write_executable(
        path,
        "out=''\n"
        "while [ \"$#\" -gt 0 ]; do\n"
        "  if [ \"$1\" = '-o' ]; then out=$2; shift 2; else shift; fi\n"
        "done\n"
        "cp \"$BRIDGE_SOURCE\" \"$out\"",
    )


def _run_installer(home: Path, path: str, installer: Path = INSTALLER):
    env = {
        **os.environ,
        "HOME": str(home),
        "PATH": path,
        "BRIDGE_SOURCE": str(REPO / "bridge" / "cot"),
        "COT_AGENTS": "none",
        "COT_ENDPOINT": "http://127.0.0.1:31337",
        "COT_VERSION": "test",
        "NO_COLOR": "1",
    }
    return subprocess.run(
        ["/bin/sh", str(installer)],
        env=env,
        capture_output=True,
        text=True,
        timeout=15,
    )


def _pinned_interpreter(home: Path) -> str:
    installed = home / ".cot" / "bin" / "cot"
    shebang = installed.read_text().splitlines()[0]
    assert shebang.startswith("#!")
    return shebang[2:]


def test_installer_uses_working_python_later_on_path():
    with tempfile.TemporaryDirectory() as raw_tmp:
        tmp = Path(raw_tmp)
        home = tmp / "home"
        broken_bin = tmp / "broken"
        working_bin = tmp / "working"
        home.mkdir()
        broken_bin.mkdir()
        working_bin.mkdir()
        _write_executable(broken_bin / "python3", "exit 126")
        _write_executable(working_bin / "python3", 'exec /usr/bin/python3 "$@"')
        _fake_curl(working_bin / "curl")

        result = _run_installer(home, f"{broken_bin}:{working_bin}:/usr/bin:/bin")
        assert result.returncode == 0, result.stderr
        assert _pinned_interpreter(home) == str(working_bin / "python3")


def test_installer_skips_python_older_than_39():
    with tempfile.TemporaryDirectory() as raw_tmp:
        tmp = Path(raw_tmp)
        home = tmp / "home"
        old_bin = tmp / "old"
        working_bin = tmp / "working"
        home.mkdir()
        old_bin.mkdir()
        working_bin.mkdir()
        _write_executable(old_bin / "python3", "exit 1")
        _write_executable(working_bin / "python3", 'exec /usr/bin/python3 "$@"')
        _fake_curl(working_bin / "curl")

        result = _run_installer(home, f"{old_bin}:{working_bin}:/usr/bin:/bin")
        assert result.returncode == 0, result.stderr
        interpreter = _pinned_interpreter(home)
        assert interpreter == str(working_bin / "python3")
        version = subprocess.run(
            [interpreter, "-c", "import sys; print(sys.version_info[:2])"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        assert version.returncode == 0
        assert tuple(map(int, version.stdout.strip("()\n").split(", "))) >= (3, 9)


def test_installer_fails_clearly_without_working_python():
    with tempfile.TemporaryDirectory() as raw_tmp:
        tmp = Path(raw_tmp)
        home = tmp / "home"
        fake_bin = tmp / "bin"
        home.mkdir()
        fake_bin.mkdir()
        _write_executable(fake_bin / "python3", "exit 126")

        installer = tmp / "install.sh"
        installer.write_text(
            INSTALLER.read_text().replace(
                "/opt/homebrew/bin/python3 /usr/bin/python3 /usr/local/bin/python3",
                f"{tmp}/missing-a {tmp}/missing-b {tmp}/missing-c",
            )
        )
        result = _run_installer(home, str(fake_bin), installer)

        assert result.returncode == 1
        assert "Python 3.9 or newer is required" in result.stderr


if __name__ == "__main__":
    tests = [value for name, value in globals().items() if name.startswith("test_")]
    for test in tests:
        test()
    print(f"{len(tests)} passed")
