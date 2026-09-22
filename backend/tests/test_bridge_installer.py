"""Focused checks for bridge installer interpreter selection."""

from __future__ import annotations

import os
import subprocess
import tempfile
from pathlib import Path


REPO = Path(__file__).resolve().parents[2]


def test_installer_skips_broken_path_python_and_pins_working_interpreter():
    with tempfile.TemporaryDirectory() as raw_tmp:
        tmp = Path(raw_tmp)
        home = tmp / "home"
        fake_bin = tmp / "bin"
        home.mkdir()
        fake_bin.mkdir()

        broken_python = fake_bin / "python3"
        broken_python.write_text("#!/bin/sh\nexit 126\n")
        broken_python.chmod(0o755)

        fake_curl = fake_bin / "curl"
        fake_curl.write_text(
            "#!/bin/sh\n"
            "out=''\n"
            "while [ \"$#\" -gt 0 ]; do\n"
            "  if [ \"$1\" = '-o' ]; then out=$2; shift 2; else shift; fi\n"
            "done\n"
            "cp \"$BRIDGE_SOURCE\" \"$out\"\n"
        )
        fake_curl.chmod(0o755)

        env = {
            **os.environ,
            "HOME": str(home),
            "PATH": f"{fake_bin}:/usr/bin:/bin",
            "BRIDGE_SOURCE": str(REPO / "bridge" / "cot"),
            "COT_AGENTS": "none",
            "COT_ENDPOINT": "http://127.0.0.1:31337",
            "COT_VERSION": "test",
            "NO_COLOR": "1",
        }
        result = subprocess.run(
            ["/bin/sh", str(REPO / "bridge" / "install.sh")],
            env=env,
            capture_output=True,
            text=True,
            timeout=15,
        )
        assert result.returncode == 0, result.stderr

        installed = home / ".cot" / "bin" / "cot"
        shebang = installed.read_text().splitlines()[0]
        assert shebang.startswith("#!")
        interpreter = shebang[2:]
        assert interpreter != str(broken_python)
        assert subprocess.run(
            [interpreter, "--version"], capture_output=True, timeout=5
        ).returncode == 0


if __name__ == "__main__":
    test_installer_skips_broken_path_python_and_pins_working_interpreter()
    print("1 passed")
