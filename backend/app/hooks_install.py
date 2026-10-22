"""Wire agent hooks from the dashboard, with no trip to a terminal.

The collector runs as the person on their own machine (the desktop app, or
``cot up``), so it can do what ``install.sh`` does: put the bridge at
``~/.cot/bin/cot`` with a working Python on its shebang, save the endpoint to
``~/.cot/config.json``, and run ``cot install <agents>``, which merges cot's
hooks into each agent's config and keeps a backup of the first version.

It skips what only matters in a shell: the PATH line in the shell profile, and
the history import (setup runs that as its own step). A collector in a
container can't reach the person's home, so it reports itself unavailable and
the dashboard keeps showing the ``curl … | sh`` command.
"""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

from . import mcp_install

AGENTS = ("claude", "cursor", "codex", "opencode", "hermes")
_PYTHON_CHECK = "import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)"
_INSTALL_TIMEOUT_S = 60


class InstallError(RuntimeError):
    """Hooks couldn't be wired (message is user-facing)."""


def _in_container() -> bool:
    return Path("/.dockerenv").exists() or os.environ.get("COT_IN_DOCKER") in ("1", "true", "yes")


def _xcode_tools_present() -> bool:
    # Without the Command Line Tools, /usr/bin/python3 is a stub that opens an
    # install dialog instead of running.
    try:
        return subprocess.run(["/usr/bin/xcode-select", "-p"], capture_output=True, timeout=5).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def _python_works(candidate: str | None) -> bool:
    if not candidate or not os.path.isabs(candidate) or not os.access(candidate, os.X_OK):
        return False
    if sys.platform == "darwin" and candidate == "/usr/bin/python3" and not _xcode_tools_present():
        return False
    try:
        return subprocess.run([candidate, "-c", _PYTHON_CHECK], capture_output=True, timeout=10).returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def resolve_python() -> str | None:
    """A host Python 3.9+ for the bridge's shebang, in install.sh's order:
    ``COT_PYTHON``, then ``python3`` on PATH, then the usual install spots.
    The collector's own interpreter is never used: in the app it's frozen."""
    seen: set[str] = set()
    candidates = [os.environ.get("COT_PYTHON")]
    candidates += [os.path.join(d, "python3") for d in os.environ.get("PATH", "").split(os.pathsep) if d]
    candidates += ["/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"]
    for candidate in candidates:
        if not candidate or candidate in seen:
            continue
        seen.add(candidate)
        if _python_works(candidate):
            return candidate
    return None


def status() -> dict[str, Any]:
    if _in_container():
        return {"available": False, "reason": "container", "python": None}
    python = resolve_python()
    return {"available": python is not None, "reason": None if python else "no_python", "python": python}


def _write_atomic(target: Path, data: bytes, mode: int) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=target.parent, prefix=f".{target.name}.")
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
        os.chmod(tmp, mode)
        # Hooks may be running this file right now; a rename never shows them half of it.
        os.replace(tmp, target)
    except OSError:
        Path(tmp).unlink(missing_ok=True)
        raise


def install(agents: list[str], *, endpoint: str, bridge_source: Path) -> dict[str, Any]:
    """Install the bridge and wire hooks for ``agents``. Returns the bridge's
    own report (one line per agent) and which agents it skipped."""
    if _in_container():
        raise InstallError("This collector runs in a container, so it can't reach your agents' config files.")
    chosen = [a for a in dict.fromkeys(agents) if a in AGENTS]
    if not chosen:
        raise InstallError("Pick at least one agent.")
    python = resolve_python()
    if python is None:
        raise InstallError("Hooks need Python 3.9 or newer, and none was found. Install Python 3, or run the terminal command instead.")
    if not bridge_source.is_file():
        raise InstallError("The bridge isn't bundled with this collector.")

    target = mcp_install.bridge_path()
    _, _, body = bridge_source.read_bytes().partition(b"\n")
    _write_atomic(target, f"#!{python}\n".encode() + body, 0o755)
    endpoint = endpoint.rstrip("/")
    _write_atomic(target.parent.parent / "config.json", (f'{{"endpoint": "{endpoint}"}}\n').encode(), 0o644)

    env = {**os.environ, "COT_ENDPOINT": endpoint, "COT_REPAIR": "0", "COT_SKIP_IMPORT": "1"}
    # The app's collector is frozen; don't hand its loader paths to the bridge.
    for key in ("PYTHONHOME", "PYTHONPATH", "DYLD_LIBRARY_PATH", "LD_LIBRARY_PATH"):
        env.pop(key, None)
    try:
        proc = subprocess.run(
            [python, str(target), "install", *chosen],
            env=env, capture_output=True, text=True, timeout=_INSTALL_TIMEOUT_S,
            cwd=str(Path.home()),
        )
    except subprocess.TimeoutExpired:
        raise InstallError("Wiring hooks took too long. Try again, or run the terminal command instead.") from None
    except OSError as exc:
        raise InstallError(f"Could not run the bridge: {exc.strerror or exc}") from None
    lines = [ln for ln in (proc.stdout + proc.stderr).splitlines() if ln.strip()]
    skipped = [a for a in chosen if any(ln.startswith(f"cot: {a} not found") for ln in lines)]
    if proc.returncode != 0:
        failed = [ln.removeprefix("cot: ") for ln in lines if "failed" in ln]
        raise InstallError(failed[0] if failed else (lines[-1] if lines else "The bridge couldn't wire the hooks."))
    return {"ok": True, "agents": chosen, "skipped": skipped, "bridge": str(target), "python": python, "output": lines}

