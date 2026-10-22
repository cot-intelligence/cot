"""Register ``cot mcp`` with the person's agents from Settings, in one click.

Each agent keeps its MCP servers in its own user-level config:

* Claude Code — ``mcpServers`` in ``~/.claude.json`` (user scope)
* Cursor — ``mcpServers`` in ``~/.cursor/mcp.json``
* Codex — ``[mcp_servers.cot]`` in ``~/.codex/config.toml``

Install merges one ``cot`` entry and leaves everything else in the file as it
was (other servers, settings, comments in the TOML). Writes are atomic
(temp file + rename) and the first write keeps a ``.cot-backup`` copy beside the
file. Explicit action only; nothing here runs on its own.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import tempfile
from pathlib import Path
from typing import Any

from . import extensions, store

AGENTS = ("claude", "cursor", "codex")
SERVER = "cot"


class InstallError(ValueError):
    """The config couldn't be read or written (message is user-facing)."""


def bridge_path() -> Path:
    """The bridge the hooks already call: ``~/.cot/bin/cot`` next to the DB."""
    return store.path().parent / "bin" / "cot"


def config_path(agent: str) -> Path:
    if agent == "claude":
        explicit = os.environ.get("COT_CLAUDE_HOME") or os.environ.get("CLAUDE_CONFIG_DIR")
        return (extensions.claude_home() / ".claude.json") if explicit else Path.home() / ".claude.json"
    if agent == "cursor":
        return extensions.cursor_home() / "mcp.json"
    if agent == "codex":
        return extensions.codex_home() / "config.toml"
    raise InstallError(f"unknown agent {agent!r}")


def _agent_present(agent: str) -> bool:
    if agent == "claude":
        return config_path("claude").is_file() or extensions.claude_home().is_dir()
    if agent == "cursor":
        return extensions.cursor_home().is_dir()
    return extensions.codex_home().is_dir()


def _read_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8") or "{}")
    except (OSError, ValueError) as exc:
        raise InstallError(f"{path} isn't valid JSON, so cot left it alone ({exc})") from exc
    if not isinstance(data, dict):
        raise InstallError(f"{path} isn't a JSON object, so cot left it alone")
    return data


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    backup = path.with_name(path.name + ".cot-backup")
    if path.exists() and not backup.exists():
        shutil.copy2(path, backup)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(text)
        if path.exists():
            shutil.copymode(path, tmp)
        os.replace(tmp, path)
    except OSError:
        Path(tmp).unlink(missing_ok=True)
        raise


_TOML_TABLE = re.compile(r"(?ms)^\[mcp_servers\.cot\][^\n]*\n.*?(?=^\[|\Z)")


def _toml_entry(command: str) -> str:
    return f'[mcp_servers.cot]\ncommand = {json.dumps(command)}\nargs = ["mcp"]\n'


def _entry(agent: str, path: Path) -> dict[str, Any] | None:
    """The cot server entry currently in the agent's config, if any."""
    if agent == "codex":
        if not path.exists():
            return None
        text = path.read_text(encoding="utf-8")
        m = _TOML_TABLE.search(text)
        if not m:
            return None
        cmd = re.search(r'^command\s*=\s*"([^"]*)"', m.group(0), re.M)
        return {"command": cmd.group(1) if cmd else None}
    try:
        servers = _read_json(path).get("mcpServers")
    except InstallError:
        return None
    entry = servers.get(SERVER) if isinstance(servers, dict) else None
    return entry if isinstance(entry, dict) else None


def status() -> dict[str, Any]:
    bridge = bridge_path()
    agents = []
    for agent in AGENTS:
        path = config_path(agent)
        entry = _entry(agent, path)
        agents.append({
            "agent": agent,
            "present": _agent_present(agent),
            "config_path": str(path),
            "installed": entry is not None,
            "current": entry is not None and entry.get("command") == str(bridge),
        })
    return {"bridge": str(bridge), "bridge_exists": bridge.is_file(), "agents": agents}


def install(agent: str) -> dict[str, Any]:
    if agent not in AGENTS:
        raise InstallError(f"unknown agent {agent!r}")
    bridge = bridge_path()
    if not bridge.is_file():
        raise InstallError(f"the cot bridge isn't installed at {bridge}; install agent hooks first")
    path = config_path(agent)
    if agent == "codex":
        text = path.read_text(encoding="utf-8") if path.exists() else ""
        block = _toml_entry(str(bridge))
        if _TOML_TABLE.search(text):
            text = _TOML_TABLE.sub(lambda _m: block + "\n", text, count=1)
        else:
            text = (text.rstrip("\n") + "\n\n" if text.strip() else "") + block
        _write(path, text)
    else:
        data = _read_json(path)
        servers = data.get("mcpServers")
        if not isinstance(servers, dict):
            servers = {}
        servers[SERVER] = (
            {"type": "stdio", "command": str(bridge), "args": ["mcp"]} if agent == "claude"
            else {"command": str(bridge), "args": ["mcp"]}
        )
        data["mcpServers"] = servers
        _write(path, json.dumps(data, indent=2, ensure_ascii=False) + "\n")
    return next(a for a in status()["agents"] if a["agent"] == agent)


def uninstall(agent: str) -> dict[str, Any]:
    if agent not in AGENTS:
        raise InstallError(f"unknown agent {agent!r}")
    path = config_path(agent)
    if path.exists():
        if agent == "codex":
            text = path.read_text(encoding="utf-8")
            if _TOML_TABLE.search(text):
                _write(path, _TOML_TABLE.sub("", text, count=1).rstrip("\n") + "\n")
        else:
            data = _read_json(path)
            servers = data.get("mcpServers")
            if isinstance(servers, dict) and SERVER in servers:
                del servers[SERVER]
                _write(path, json.dumps(data, indent=2, ensure_ascii=False) + "\n")
    return next(a for a in status()["agents"] if a["agent"] == agent)
