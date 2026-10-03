"""Inventory of the plugins, skills and MCP servers each agent can load.

Everything here reads agent config from disk; nothing is written and nothing
in a package is executed. Secrets never leave this module: MCP env and header
values are reduced to their names, and command arguments are masked.

An *install* is one place an extension is configured (an agent, a scope and a
file). Installs that share a kind and name group into one *extension*, keyed
``mcp:<server>``, ``skill:<name>`` or ``plugin:<name>@<marketplace>``, so a
skill shared by Claude Code and Codex reads as one thing installed twice.

Scopes:
    user      the agent's global config (``~/.claude``, ``~/.cursor``, ...)
    project   checked into a project (``.mcp.json``, ``.claude/skills``, ...)
    local     per-project but private to this machine (``~/.claude.json``
              ``projects[path]``, ``.claude/settings.local.json``)
    plugin    shipped inside a plugin
    builtin   bundled with the agent itself
    managed   pushed by an administrator
    desktop   the Claude desktop app's own config
"""

from __future__ import annotations

import json
import os
import re
import threading
import time
import tomllib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

from . import marketplace_scan

SKILL_FILE = "SKILL.md"
MAX_SKILL_DIRS = 2000
# How often a cached inventory checks whether any file it read has changed.
CHECK_EVERY_S = 2.0

# Every file and directory the running scan read. The cached inventory keeps
# this set and is rebuilt only when one of them changes (mtime, size, or it
# appears or disappears), not on a timer.
_watched: set[str] = set()


def _watch(path: Path | str | None) -> None:
    if path is not None:
        _watched.add(str(path))


def _signature(paths: Iterable[str]) -> tuple:
    out = []
    for p in sorted(paths):
        try:
            st = os.stat(p)
            out.append((p, st.st_mtime_ns, st.st_size))
        except OSError:
            out.append((p, None, None))
    return tuple(out)


# --- Agent homes -----------------------------------------------------------


def _env_path(*names: str, default: str) -> Path:
    for name in names:
        value = os.environ.get(name)
        if value:
            return Path(value).expanduser()
    return Path(default).expanduser()


def claude_home() -> Path:
    return _env_path("COT_CLAUDE_HOME", "CLAUDE_CONFIG_DIR", default="~/.claude")


def cursor_home() -> Path:
    return _env_path("COT_CURSOR_HOME", default="~/.cursor")


def codex_home() -> Path:
    return _env_path("COT_CODEX_HOME", "CODEX_HOME", default="~/.codex")


def agents_home() -> Path:
    """The cross-agent skills home (``~/.agents/skills``) Codex reads."""
    return _env_path("COT_AGENTS_HOME", default="~/.agents")


def claude_json_path() -> Path | None:
    """Claude Code keeps ``.claude.json`` in $HOME, or inside the config dir
    when one is set explicitly."""
    explicit = os.environ.get("COT_CLAUDE_HOME") or os.environ.get("CLAUDE_CONFIG_DIR")
    candidate = (claude_home() / ".claude.json") if explicit else Path.home() / ".claude.json"
    _watch(candidate)
    return candidate if candidate.is_file() else None


def claude_desktop_config() -> Path:
    return _env_path(
        "COT_CLAUDE_DESKTOP_CONFIG",
        default="~/Library/Application Support/Claude/claude_desktop_config.json",
    )


def claude_managed_mcp() -> Path:
    return _env_path(
        "COT_CLAUDE_MANAGED_MCP",
        default="/Library/Application Support/ClaudeCode/managed-mcp.json",
    )


# --- Small readers ---------------------------------------------------------


def _read_json(path: Path) -> Any:
    _watch(path)
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _read_toml(path: Path) -> dict[str, Any]:
    _watch(path)
    try:
        with path.open("rb") as fh:
            return tomllib.load(fh)
    except (OSError, tomllib.TOMLDecodeError):
        return {}


def _dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _str(value: Any) -> str | None:
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def _person(value: Any) -> str | None:
    if isinstance(value, dict):
        return _str(value.get("name")) or _str(value.get("email"))
    return _str(value)


def _mtime(path: Path) -> float | None:
    try:
        return path.stat().st_mtime
    except OSError:
        return None


def _iso(ts: float | None) -> str | None:
    if ts is None:
        return None
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts))


def _iso_ms(ms: Any) -> str | None:
    return _iso(ms / 1000) if isinstance(ms, (int, float)) and ms > 0 else None


def _dir_stats(root: Path, limit: int = 400) -> tuple[int, int, float | None]:
    """File count, total bytes and newest mtime, skipping vendored trees."""
    count = size = 0
    newest: float | None = None
    try:
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if d not in (".git", "node_modules", "__pycache__")]
            for name in filenames:
                try:
                    st = os.stat(os.path.join(dirpath, name))
                except OSError:
                    continue
                count += 1
                size += st.st_size
                newest = st.st_mtime if newest is None else max(newest, st.st_mtime)
                if count >= limit:
                    return count, size, newest
    except OSError:
        pass
    return count, size, newest


# --- Model -----------------------------------------------------------------


@dataclass
class Install:
    agent: str  # claude | cursor | codex
    kind: str  # plugin | skill | mcp
    name: str
    scope: str
    path: str | None = None  # package directory, or the config file for MCP
    project: str | None = None
    enabled: bool | None = True
    plugin: str | None = None  # parent plugin key
    config_file: str | None = None
    meta: dict[str, Any] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return {
            "agent": self.agent,
            "scope": self.scope,
            "path": self.path,
            "project": self.project,
            "enabled": self.enabled,
            "plugin": self.plugin,
            "config_file": self.config_file,
        }


def ext_key(kind: str, name: str) -> str:
    return f"{kind}:{name}"


# --- Skills ----------------------------------------------------------------


def _skill_dirs(root: Path) -> Iterable[Path]:
    """Skill directories directly under ``root`` (one level, symlinks followed)."""
    _watch(root)
    try:
        entries = sorted(root.iterdir())
    except OSError:
        return []
    out = []
    for entry in entries[:MAX_SKILL_DIRS]:
        if entry.name.startswith(".") and entry.name != ".system":
            continue
        if (entry / SKILL_FILE).is_file():
            out.append(entry)
        elif entry.name == ".system" and entry.is_dir():
            out.extend(_skill_dirs(entry))
    return out


def _skill_meta(skill_dir: Path) -> dict[str, Any]:
    _watch(skill_dir / SKILL_FILE)
    try:
        text = (skill_dir / SKILL_FILE).read_text(encoding="utf-8", errors="replace")[:64_000]
    except OSError:
        text = ""
    fm = marketplace_scan.parse_frontmatter(text)
    allowed = fm.get("allowed-tools") or fm.get("allowed_tools")
    if isinstance(allowed, str):
        allowed = [t.strip() for t in re.split(r"[,\s]+", allowed) if t.strip()]
    meta_block = _dict(fm.get("metadata"))
    return {
        "display_name": _str(fm.get("name")),
        "description": _str(fm.get("description")),
        "version": _str(fm.get("version")) or _str(meta_block.get("version")),
        "license": _str(fm.get("license")),
        "author": _str(fm.get("author")),
        "allowed_tools": allowed if isinstance(allowed, list) else None,
        "user_invocable": fm.get("user-invocable") not in ("false", False),
        "model_invocable": fm.get("disable-model-invocation") not in ("true", True),
    }


def _add_skills(
    out: list[Install],
    root: Path,
    agent: str,
    scope: str,
    *,
    project: str | None = None,
    plugin: str | None = None,
    prefix: str | None = None,
) -> list[str]:
    names: list[str] = []
    for skill_dir in _skill_dirs(root):
        base = skill_dir.name
        name = f"{prefix}:{base}" if prefix else base
        meta = _skill_meta(skill_dir)
        meta["real_path"] = str(_realpath(skill_dir))
        out.append(
            Install(
                agent=agent,
                kind="skill",
                name=name,
                scope="builtin" if skill_dir.parent.name == ".system" or scope == "builtin" else scope,
                path=str(skill_dir),
                project=project,
                plugin=plugin,
                meta=meta,
            )
        )
        names.append(name)
    return names


def _realpath(path: Path) -> Path:
    try:
        return path.resolve()
    except OSError:
        return path


# --- MCP servers -----------------------------------------------------------

_SECRET_KEY = re.compile(r"(?i)(key|token|secret|passw|pat\b|auth|credential|cookie|session)")
_SECRET_FLAG = re.compile(r"(?i)^--?(api[-_]?key|token|secret|password|auth|access[-_]?token|key)(=.*)?$")
_PINNED = re.compile(r"(@\d|==\d|@sha256:|:\d[\w.]*$)")
_LOCAL_HOSTS = ("localhost", "127.0.0.1", "[::1]", "0.0.0.0")


def _is_reference(value: str) -> bool:
    """``${VAR}`` / ``$VAR`` / ``{env:X}`` references hold no secret themselves."""
    v = value.strip()
    return not v or v.startswith("$") or v.startswith("{env:") or v.startswith("<")


def _mask_args(args: list[Any]) -> list[str]:
    out: list[str] = []
    hide_next = False
    for raw in args:
        arg = str(raw)
        if hide_next:
            out.append("••••" if not _is_reference(arg) else arg)
            hide_next = False
            continue
        m = _SECRET_FLAG.match(arg)
        if m:
            if "=" in arg:
                flag, _, value = arg.partition("=")
                out.append(f"{flag}=••••" if not _is_reference(value) else arg)
            else:
                out.append(arg)
                hide_next = True
            continue
        # marketplace_scan is kept identical to the marketplace branch's copy, so use its helper as-is.
        out.append(marketplace_scan._mask_secrets(arg))  # noqa: SLF001
    return out


def _host(url: str) -> str | None:
    m = re.match(r"^[a-z][a-z0-9+.-]*://([^/?#]+)", url.strip(), re.I)
    if not m:
        return None
    host = m.group(1).rsplit("@", 1)[-1]
    return host.lower()


def mcp_summary(cfg: dict[str, Any]) -> dict[str, Any]:
    """Shape of one MCP server config with every secret value removed."""
    url = _str(cfg.get("url")) or _str(cfg.get("serverUrl")) or _str(cfg.get("httpUrl"))
    command = _str(cfg.get("command"))
    transport = _str(cfg.get("type")) or _str(cfg.get("transport"))
    if not transport:
        transport = "stdio" if command else ("http" if url else "unknown")
    if transport == "streamable-http":
        transport = "http"
    args = cfg.get("args") if isinstance(cfg.get("args"), list) else []
    env = _dict(cfg.get("env"))
    headers = _dict(cfg.get("headers")) or _dict(cfg.get("http_headers"))
    env_vars = cfg.get("env_vars") if isinstance(cfg.get("env_vars"), list) else []
    return {
        "transport": transport,
        "command": Path(command).name if command and "/" in command else command,
        "command_path": command if command and "/" in command else None,
        "args": _mask_args(args),
        "url_host": _host(url) if url else None,
        "url_scheme": url.split(":", 1)[0].lower() if url and ":" in url else None,
        "env_keys": sorted(str(k) for k in env.keys()) + sorted(str(v) for v in env_vars if isinstance(v, str)),
        "header_keys": sorted(str(k) for k in headers.keys()),
        "cwd": _str(cfg.get("cwd")),
        "disabled": cfg.get("disabled") is True or cfg.get("enabled") is False,
    }


def mcp_risks(cfg: dict[str, Any], config_file: str | None) -> list[dict[str, Any]]:
    """Static checks on how an MCP server is launched. Evidence never includes a secret."""
    risks: list[dict[str, Any]] = []
    where = f" in {config_file}" if config_file else ""

    def add(severity: str, rule: str, title: str, detail: str) -> None:
        risks.append({"severity": severity, "rule": rule, "title": title, "detail": detail})

    for key, value in _dict(cfg.get("env")).items():
        if isinstance(value, str) and _SECRET_KEY.search(str(key)) and not _is_reference(value):
            add("high", "plaintext-secret", f"{key} is stored in plain text",
                f"The value sits in the config file{where}. Reference an environment variable instead.")
    headers = _dict(cfg.get("headers")) or _dict(cfg.get("http_headers"))
    for key, value in headers.items():
        if isinstance(value, str) and _SECRET_KEY.search(str(key)) and not _is_reference(value.replace("Bearer ", "")):
            add("high", "plaintext-secret", f"{key} header is stored in plain text",
                f"The credential sits in the config file{where}.")
    args = [str(a) for a in cfg.get("args") or [] if isinstance(a, (str, int, float))]
    for i, arg in enumerate(args):
        flag = _SECRET_FLAG.match(arg)
        if flag and "=" in arg and not _is_reference(arg.partition("=")[2]):
            add("high", "plaintext-secret", f"{arg.partition('=')[0]} is passed in plain text",
                "Command-line secrets are visible to every process on the machine.")
        elif flag and i + 1 < len(args) and not _is_reference(args[i + 1]):
            add("high", "plaintext-secret", f"{arg} is passed in plain text",
                "Command-line secrets are visible to every process on the machine.")
        elif marketplace_scan._mask_secrets(arg) != arg:  # noqa: SLF001 (shared scanner helper)
            add("high", "plaintext-secret", "An argument looks like a credential",
                "A token-shaped value is passed on the command line.")
    url = _str(cfg.get("url")) or _str(cfg.get("serverUrl")) or ""
    host = _host(url) if url else None
    if url.lower().startswith("http://") and host and not host.split(":")[0].endswith(_LOCAL_HOSTS):
        add("medium", "plain-http", "Remote endpoint over plain HTTP",
            f"Traffic to {host} is unencrypted.")
    command = (_str(cfg.get("command")) or "").rsplit("/", 1)[-1]
    if command in ("npx", "bunx", "pnpx", "uvx", "pipx", "dlx"):
        pkg = next((a for a in args if not a.startswith("-") and a not in ("run", "dlx")), None)
        if pkg and not _PINNED.search(pkg):
            add("medium", "unpinned", f"{pkg} is not pinned to a version",
                f"{command} fetches whatever version is newest each time the server starts.")
    if command == "docker":
        joined = " ".join(args)
        if "--privileged" in joined:
            add("high", "privileged-container", "Container runs privileged",
                "--privileged gives the server full access to the host.")
        if re.search(r"(-v|--volume)[ =]/(:|\s|$)", joined):
            add("high", "host-root-mount", "Host root is mounted into the container", "")
    if command in ("sh", "bash", "zsh") and any(re.search(r"curl|wget", a) for a in args):
        add("high", "remote-script", "Starts by piping a downloaded script into a shell", "")
    return risks


def _add_mcp(
    out: list[Install],
    servers: Any,
    agent: str,
    scope: str,
    config_file: Path | str | None,
    *,
    project: str | None = None,
    plugin: str | None = None,
    name_prefix: str = "",
    enabled_fn=None,
) -> list[str]:
    names: list[str] = []
    for raw_name, cfg in _dict(servers).items():
        if not isinstance(cfg, dict):
            continue
        name = f"{name_prefix}{raw_name}"
        summary = mcp_summary(cfg)
        enabled: bool | None = not summary["disabled"]
        if enabled_fn is not None and enabled:
            enabled = enabled_fn(raw_name)
        cf = str(config_file) if config_file else None
        out.append(
            Install(
                agent=agent,
                kind="mcp",
                name=name,
                scope=scope,
                path=cf,
                project=project,
                enabled=enabled,
                plugin=plugin,
                config_file=cf,
                meta={
                    "server": raw_name,
                    "mcp": summary,
                    "risks": mcp_risks(cfg, _home_rel(cf)),
                    "description": _str(cfg.get("description")),
                },
            )
        )
        names.append(name)
    return names


def _home_rel(path: str | None) -> str | None:
    if not path:
        return None
    home = str(Path.home())
    return "~" + path[len(home):] if path.startswith(home + "/") else path


# --- Plugins ---------------------------------------------------------------


def _plugin_manifest(root: Path) -> dict[str, Any]:
    for rel in (".claude-plugin/plugin.json", ".codex-plugin/plugin.json", ".cursor-plugin/plugin.json", "plugin.json"):
        data = _read_json(root / rel)
        if isinstance(data, dict):
            return data
    return {}


def _plugin_mcp_servers(root: Path, manifest: dict[str, Any]) -> dict[str, Any]:
    servers = manifest.get("mcpServers")
    if isinstance(servers, dict):
        return servers
    if isinstance(servers, str):
        data = _read_json(root / servers)
    else:
        data = _read_json(root / ".mcp.json")
    if isinstance(data, dict):
        return _dict(data.get("mcpServers")) or {k: v for k, v in data.items() if isinstance(v, dict)}
    return {}


def _count_md(root: Path) -> int:
    _watch(root)
    try:
        return sum(1 for p in root.iterdir() if p.suffix == ".md")
    except OSError:
        return 0


def _hook_count(root: Path, manifest: dict[str, Any]) -> int:
    hooks = manifest.get("hooks")
    if not isinstance(hooks, dict):
        data = _read_json(root / "hooks" / "hooks.json") or _read_json(root / "hooks.json")
        hooks = _dict(data).get("hooks") if isinstance(data, dict) else None
    if isinstance(hooks, dict) and isinstance(hooks.get("hooks"), dict):
        hooks = hooks["hooks"]
    return sum(len(v) for v in _dict(hooks).values() if isinstance(v, list))


def _add_plugin(
    out: list[Install],
    agent: str,
    key_name: str,
    root: Path | None,
    scope: str,
    *,
    project: str | None = None,
    enabled: bool | None = True,
    meta: dict[str, Any] | None = None,
    marketplace_entry: dict[str, Any] | None = None,
) -> None:
    plugin_name, _, marketplace = key_name.partition("@")
    manifest = _plugin_manifest(root) if root else {}
    entry = marketplace_entry or {}
    info: dict[str, Any] = {
        "marketplace": marketplace or None,
        "display_name": _str(manifest.get("name")) or plugin_name,
        "description": _str(manifest.get("description")) or _str(entry.get("description")),
        "version": _str(manifest.get("version")) or _str(entry.get("version")),
        "author": _person(manifest.get("author")) or _person(entry.get("author")),
        "homepage": _str(manifest.get("homepage")) or _str(entry.get("homepage")),
        "repository": _str(manifest.get("repository")) if isinstance(manifest.get("repository"), str)
        else _str(_dict(manifest.get("repository")).get("url")),
        "license": _str(manifest.get("license")) or _str(entry.get("license")),
        "keywords": manifest.get("keywords") if isinstance(manifest.get("keywords"), list) else None,
        "category": _str(entry.get("category")),
        "contents": {"skills": [], "mcp_servers": [], "commands": 0, "agents": 0, "hooks": 0},
        **(meta or {}),
    }
    key = ext_key("plugin", key_name)
    if root and root.is_dir():
        skills_dir = manifest.get("skills") if isinstance(manifest.get("skills"), str) else "skills"
        prefix = plugin_name if agent == "claude" else plugin_name
        info["contents"]["skills"] = _add_skills(
            out, root / skills_dir, agent, "plugin", project=project, plugin=key, prefix=prefix
        )
        mcp_prefix = f"plugin_{plugin_name}_" if agent == "claude" else ""
        info["contents"]["mcp_servers"] = _add_mcp(
            out, _plugin_mcp_servers(root, manifest), agent, "plugin",
            root / ".mcp.json", project=project, plugin=key, name_prefix=mcp_prefix,
        )
        info["contents"]["commands"] = _count_md(root / "commands")
        info["contents"]["agents"] = _count_md(root / "agents")
        info["contents"]["hooks"] = _hook_count(root, manifest)
    out.append(
        Install(
            agent=agent,
            kind="plugin",
            name=key_name,
            scope=scope,
            path=str(root) if root else None,
            project=project,
            enabled=enabled,
            meta=info,
        )
    )


def _marketplace_entries(market_root: Path) -> dict[str, dict[str, Any]]:
    data = _read_json(market_root / ".claude-plugin" / "marketplace.json") or _read_json(
        market_root / "marketplace.json"
    )
    out: dict[str, dict[str, Any]] = {}
    for p in _dict(data).get("plugins") or []:
        if isinstance(p, dict) and _str(p.get("name")):
            out[p["name"]] = p
    return out


def _latest_version_dir(root: Path) -> Path | None:
    _watch(root)
    try:
        dirs = [p for p in root.iterdir() if p.is_dir()]
    except OSError:
        return None
    if not dirs:
        return None
    return max(dirs, key=lambda p: (_mtime(p) or 0))


# --- Per-agent scanners ----------------------------------------------------


def _scan_claude(out: list[Install], projects: list[str]) -> dict[str, Any]:
    home = claude_home()
    cj_path = claude_json_path()
    cj = _dict(_read_json(cj_path)) if cj_path else {}
    native = {"skills": _dict(cj.get("skillUsage")), "plugins": _dict(cj.get("pluginUsage"))}

    _add_skills(out, home / "skills", "claude", "user")

    # Plugins: installed_plugins.json (v1 dict, v2 dict of lists) + enabledPlugins.
    settings = _dict(_read_json(home / "settings.json"))
    enabled_user = _dict(settings.get("enabledPlugins"))
    markets: dict[str, dict[str, dict[str, Any]]] = {}
    for mkt_name, mkt in _dict(_read_json(home / "plugins" / "known_marketplaces.json")).items():
        loc = _str(_dict(mkt).get("installLocation"))
        markets[mkt_name] = _marketplace_entries(Path(loc)) if loc else {}

    def entry_for(key_name: str) -> dict[str, Any]:
        name, _, mkt = key_name.partition("@")
        return markets.get(mkt, {}).get(name, {})

    seen_plugins: set[str] = set()
    installed = _dict(_dict(_read_json(home / "plugins" / "installed_plugins.json")).get("plugins"))
    for key_name, records in installed.items():
        for rec in records if isinstance(records, list) else [records]:
            rec = _dict(rec)
            scope = _str(rec.get("scope")) or "user"
            project = _str(rec.get("projectPath"))
            root = Path(rec["installPath"]) if _str(rec.get("installPath")) else None
            enabled: bool | None = enabled_user.get(key_name)
            if project:
                for fname in ("settings.json", "settings.local.json"):
                    proj_enabled = _dict(_read_json(Path(project) / ".claude" / fname)).get("enabledPlugins")
                    if isinstance(proj_enabled, dict) and key_name in proj_enabled:
                        enabled = bool(proj_enabled[key_name])
            _add_plugin(
                out, "claude", key_name, root, scope, project=project,
                enabled=True if enabled is None else bool(enabled),
                meta={
                    "installed_at": _str(rec.get("installedAt")),
                    "updated_at": _str(rec.get("lastUpdated")),
                    "git_sha": _str(rec.get("gitCommitSha")),
                    "version": _str(rec.get("version")),
                },
                marketplace_entry=entry_for(key_name),
            )
            seen_plugins.add(key_name)

    # Plugins enabled in settings but not in installed_plugins.json (older
    # layouts): resolve from the plugin cache.
    for key_name, on in enabled_user.items():
        if key_name in seen_plugins:
            continue
        name, _, mkt = key_name.partition("@")
        root = _latest_version_dir(home / "plugins" / "cache" / mkt / name)
        if root is None:
            loc = home / "plugins" / "marketplaces" / mkt / "plugins" / name
            root = loc if loc.is_dir() else None
        _add_plugin(out, "claude", key_name, root, "user", enabled=bool(on), marketplace_entry=entry_for(key_name))
        seen_plugins.add(key_name)

    # Plugins the desktop app manages itself (inline/builtin) only surface in
    # pluginUsage.
    for key_name, usage in native["plugins"].items():
        if key_name in seen_plugins or "@" not in key_name:
            continue
        _, _, mkt = key_name.partition("@")
        if mkt not in ("builtin", "inline"):
            continue
        _add_plugin(
            out, "claude", key_name, None, "builtin",
            meta={"native_usage": _native(usage), "description": "Bundled with the Claude app."},
        )

    # MCP servers.
    _add_mcp(out, cj.get("mcpServers"), "claude", "user", cj_path)
    for proj_path, proj in _dict(cj.get("projects")).items():
        proj = _dict(proj)
        _add_mcp(out, proj.get("mcpServers"), "claude", "local", cj_path, project=proj_path)
    for proj_path in projects:
        mcp_json = Path(proj_path) / ".mcp.json"
        _watch(mcp_json)
        if not mcp_json.is_file():
            continue
        proj_state = _dict(_dict(cj.get("projects")).get(proj_path))
        local = _dict(_read_json(Path(proj_path) / ".claude" / "settings.local.json"))
        enabled_list = set(proj_state.get("enabledMcpjsonServers") or []) | set(local.get("enabledMcpjsonServers") or [])
        disabled_list = set(proj_state.get("disabledMcpjsonServers") or []) | set(local.get("disabledMcpjsonServers") or [])
        enable_all = bool(local.get("enableAllProjectMcpServers") or proj_state.get("enableAllProjectMcpServers"))

        def state(name: str, en=enabled_list, dis=disabled_list, all_=enable_all) -> bool | None:
            if name in dis:
                return False
            if name in en or all_:
                return True
            return None  # awaiting the user's approval in Claude Code

        _add_mcp(
            out, _dict(_read_json(mcp_json)).get("mcpServers"), "claude", "project", mcp_json,
            project=proj_path, enabled_fn=state,
        )
    managed = claude_managed_mcp()
    _watch(managed)
    if managed.is_file():
        _add_mcp(out, _dict(_read_json(managed)).get("mcpServers"), "claude", "managed", managed)
    desktop = claude_desktop_config()
    _watch(desktop)
    if desktop.is_file():
        _add_mcp(out, _dict(_read_json(desktop)).get("mcpServers"), "claude", "desktop", desktop)

    for proj_path in projects:
        _add_skills(out, Path(proj_path) / ".claude" / "skills", "claude", "project", project=proj_path)
    return native


def _native(usage: Any) -> dict[str, Any] | None:
    usage = _dict(usage)
    if not usage:
        return None
    return {"count": usage.get("usageCount"), "last_used": _iso_ms(usage.get("lastUsedAt"))}


def _cursor_tool_index() -> dict[str, dict[str, Any]]:
    """Servers Cursor has connected, from its per-project tool descriptors.

    Cursor's live hooks name MCP tools ``MCP:<tool>`` without the server; these
    descriptors are how a tool name maps back to one."""
    servers: dict[str, dict[str, Any]] = {}
    root = cursor_home() / "projects"
    _watch(root)
    try:
        projects = list(root.iterdir())
    except OSError:
        return servers
    for proj in projects:
        mcps = proj / "mcps"
        _watch(mcps)
        try:
            server_dirs = list(mcps.iterdir())
        except OSError:
            continue
        for sdir in server_dirs:
            meta = _dict(_read_json(sdir / "SERVER_METADATA.json"))
            name = _str(meta.get("serverName")) or sdir.name
            entry = servers.setdefault(name, {"tools": {}, "projects": 0})
            entry["projects"] += 1
            try:
                tool_files = list((sdir / "tools").glob("*.json"))
            except OSError:
                tool_files = []
            for tf in tool_files:
                if tf.stem in entry["tools"]:
                    continue
                data = _dict(_read_json(tf))
                entry["tools"][tf.stem] = _str(data.get("description"))
    return servers


def _scan_cursor(out: list[Install], projects: list[str]) -> dict[str, Any]:
    home = cursor_home()
    _add_mcp(out, _dict(_read_json(home / "mcp.json")).get("mcpServers"), "cursor", "user", home / "mcp.json")
    for proj_path in projects:
        f = Path(proj_path) / ".cursor" / "mcp.json"
        _watch(f)
        if f.is_file():
            _add_mcp(out, _dict(_read_json(f)).get("mcpServers"), "cursor", "project", f, project=proj_path)
        _add_skills(out, Path(proj_path) / ".cursor" / "skills", "cursor", "project", project=proj_path)
    _add_skills(out, home / "skills", "cursor", "user")
    _add_skills(out, home / "skills-cursor", "cursor", "builtin")
    try:
        for manifest in sorted((home / "plugins").glob("*/*/.cursor-plugin/plugin.json"))[:200]:
            root = manifest.parent.parent
            data = _dict(_read_json(manifest))
            name = _str(data.get("name")) or root.name
            _add_plugin(out, "cursor", f"{name}@{root.parent.name}", root, "user")
    except OSError:
        pass

    configured = {i.name for i in out if i.agent == "cursor" and i.kind == "mcp"}
    tool_index = _cursor_tool_index()
    for server, info in tool_index.items():
        if server in configured:
            continue
        out.append(
            Install(
                agent="cursor", kind="mcp", name=server, scope="builtin", enabled=True,
                meta={"server": server, "mcp": {"transport": "builtin", "args": [], "env_keys": [], "header_keys": []},
                      "risks": [], "description": None},
            )
        )
    return {"cursor_tools": tool_index}


def _scan_codex(out: list[Install], projects: list[str]) -> dict[str, Any]:
    home = codex_home()
    cfg_path = home / "config.toml"
    cfg = _read_toml(cfg_path)
    _add_mcp(out, cfg.get("mcp_servers"), "codex", "user", cfg_path)
    _add_skills(out, home / "skills", "codex", "user")
    _add_skills(out, agents_home() / "skills", "codex", "user")

    markets = _dict(cfg.get("marketplaces"))
    for key_name, pcfg in _dict(cfg.get("plugins")).items():
        name, _, mkt = key_name.partition("@")
        root = _latest_version_dir(home / "plugins" / "cache" / mkt / name)
        if root is None:
            src = _str(_dict(markets.get(mkt)).get("source"))
            cand = Path(src) / "plugins" / name if src else None
            root = cand if cand and cand.is_dir() else None
        _add_plugin(
            out, "codex", key_name, root, "builtin" if mkt.startswith("openai-") else "user",
            enabled=_dict(pcfg).get("enabled") is not False,
        )
    for proj_path in projects:
        pcfg = Path(proj_path) / ".codex" / "config.toml"
        _watch(pcfg)
        if pcfg.is_file():
            _add_mcp(out, _read_toml(pcfg).get("mcp_servers"), "codex", "project", pcfg, project=proj_path)
        _add_skills(out, Path(proj_path) / ".agents" / "skills", "codex", "project", project=proj_path)
        _add_skills(out, Path(proj_path) / ".codex" / "skills", "codex", "project", project=proj_path)
    return {}


# --- Projects --------------------------------------------------------------

_PROJECT_MARKERS = (".mcp.json", ".claude", ".cursor", ".codex", ".agents")


def project_roots(cwds: Iterable[str]) -> list[str]:
    """Directories that may hold project-scoped config: each session cwd and its
    ancestors up to the git root (never above $HOME)."""
    home = Path.home().resolve()
    agent_homes = {claude_home().resolve(), cursor_home().resolve(), codex_home().resolve(), agents_home().resolve()}
    out: set[str] = set()
    seen: set[str] = set()
    for cwd in cwds:
        if not cwd or not cwd.startswith("/"):
            continue
        p = Path(cwd)
        for _ in range(8):
            key = str(p)
            if key in seen:
                break
            seen.add(key)
            _watch(p)  # a project gaining .mcp.json / .claude/ changes this directory
            if p == home or p == p.parent:
                break
            try:
                if not p.is_dir():
                    p = p.parent
                    continue
                if any((p / m).exists() for m in _PROJECT_MARKERS) and p.resolve() not in agent_homes:
                    out.add(key)
                if (p / ".git").exists():
                    break
            except OSError:
                break
            p = p.parent
    return sorted(out)


# --- Grouping --------------------------------------------------------------


def origin_label(kind: str, name: str) -> str | None:
    """Where an extension that is in no config file most likely comes from."""
    if kind != "mcp":
        return None
    if re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", name):
        return "claude.ai connector"
    if name.startswith(("Claude_", "ccd_", "claude-in-chrome", "computer-use", "visualize", "scheduled-tasks", "mcp-registry", "terminal")):
        return "Claude app built-in"
    if name.startswith("cursor-"):
        return "Cursor built-in"
    if name.startswith("plugin_"):
        return "plugin"
    return None


def group(installs: list[Install], native: dict[str, Any]) -> dict[str, dict[str, Any]]:
    by_key: dict[str, dict[str, Any]] = {}
    for inst in installs:
        key = ext_key(inst.kind, inst.name)
        ext = by_key.get(key)
        if ext is None:
            ext = by_key[key] = {
                "key": key,
                "kind": inst.kind,
                "name": inst.name,
                "display_name": inst.meta.get("display_name") or inst.name,
                "description": None,
                "version": None,
                "author": None,
                "license": None,
                "homepage": None,
                "repository": None,
                "marketplace": None,
                "plugin": inst.plugin,
                "installed": True,
                "origin": None,
                "installs": [],
                "aliases": set(),
                "paths": set(),
            }
        for fld in ("description", "version", "author", "license", "homepage", "repository", "marketplace"):
            if not ext[fld] and inst.meta.get(fld):
                ext[fld] = inst.meta[fld]
        for fld in ("allowed_tools", "contents", "category", "keywords", "git_sha", "installed_at", "updated_at"):
            if inst.meta.get(fld) and not ext.get(fld):
                ext[fld] = inst.meta[fld]
        if inst.kind == "mcp":
            ext.setdefault("mcp", inst.meta.get("mcp"))
            ext.setdefault("risks", [])
            for r in inst.meta.get("risks") or []:
                ext["risks"].append({**r, "agent": inst.agent, "scope": inst.scope, "project": inst.project})
            if inst.meta.get("server"):
                ext["aliases"].add(inst.meta["server"])
        if inst.kind == "skill":
            ext["aliases"].add(inst.name.rsplit(":", 1)[-1] if not inst.plugin else inst.name)
            if inst.path:
                ext["paths"].add(inst.path)
            if inst.meta.get("real_path"):
                ext["paths"].add(inst.meta["real_path"])
        if inst.plugin and not ext["plugin"]:
            ext["plugin"] = inst.plugin
        if inst.meta.get("native_usage") and not ext.get("native_usage"):
            ext["native_usage"] = inst.meta["native_usage"]
        ext["installs"].append(inst.as_dict())

    for ext in by_key.values():
        if ext["kind"] == "skill":
            usage = native.get("skills", {}).get(ext["name"]) or native.get("skills", {}).get(ext["name"].rsplit(":", 1)[-1])
            if usage and not ext.get("native_usage"):
                ext["native_usage"] = _native(usage)
        installs = ext["installs"]
        if all(i["scope"] == "builtin" for i in installs):
            ext["origin"] = origin_label(ext["kind"], ext["name"]) or "built-in"
        ext["agents"] = sorted({i["agent"] for i in installs})
        ext["scopes"] = sorted({i["scope"] for i in installs})
        ext["projects"] = sorted({i["project"] for i in installs if i["project"]})
        ext["enabled"] = any(i["enabled"] is not False for i in installs)
        ext["aliases"] = sorted(ext["aliases"])
        ext["paths"] = sorted(ext["paths"])
        ext["shadows"] = _shadowing(installs) if ext["kind"] == "skill" else None
        if ext["kind"] in ("skill", "plugin"):
            root = next((Path(i["path"]) for i in installs if i["path"]), None)
            if root and root.is_dir():
                count, size, newest = _dir_stats(root)
                ext["files"] = count
                ext["size_bytes"] = size
                ext.setdefault("updated_at", None)
                ext["updated_at"] = ext["updated_at"] or _iso(newest)
    return by_key


def _shadowing(installs: list[dict[str, Any]]) -> list[dict[str, Any]] | None:
    """A project skill with the same name as a global one wins inside that project."""
    per_agent: dict[str, list[dict[str, Any]]] = {}
    for i in installs:
        per_agent.setdefault(i["agent"], []).append(i)
    out = []
    for agent, items in per_agent.items():
        globals_ = [i for i in items if i["scope"] in ("user", "builtin")]
        for i in items:
            if i["scope"] == "project" and globals_:
                out.append({"agent": agent, "project": i["project"], "overrides": globals_[0]["path"]})
    return out or None


# --- Public API ------------------------------------------------------------


@dataclass
class Inventory:
    extensions: dict[str, dict[str, Any]]
    projects: list[str]
    cursor_tools: dict[str, dict[str, Any]]
    scanned_at: float
    # Bumped on every rescan; callers fold it into their own cache keys.
    version: int = 0
    cwds: tuple[str, ...] = ()
    signature: tuple = ()
    checked_at: float = 0.0

    def index(self) -> "InventoryIndex":
        return InventoryIndex(self)


class InventoryIndex:
    """Lookups from what a hook event says to an extension key."""

    def __init__(self, inv: Inventory) -> None:
        self.mcp: dict[str, str] = {}
        self.skill_name: dict[str, str] = {}
        self.skill_path: list[tuple[str, str]] = []
        self.cursor_tool: dict[str, list[str]] = {}
        for key, ext in inv.extensions.items():
            if ext["kind"] == "mcp":
                for name in [ext["name"], *ext["aliases"]]:
                    self.mcp.setdefault(name.lower(), key)
            elif ext["kind"] == "skill":
                self.skill_name.setdefault(ext["name"].lower(), key)
                for alias in ext["aliases"]:
                    self.skill_name.setdefault(alias.lower(), key)
                for p in ext["paths"]:
                    self.skill_path.append((p.rstrip("/") + "/", key))
        for name in list(self.skill_name):
            # Plugin skills are invoked as "plugin:skill"; also answer to the
            # bare name when no standalone skill has it.
            if ":" in name:
                self.skill_name.setdefault(name.rsplit(":", 1)[-1], self.skill_name[name])
        self.skill_path.sort(key=lambda t: -len(t[0]))
        for server, info in inv.cursor_tools.items():
            for tool in info.get("tools", {}):
                self.cursor_tool.setdefault(tool, []).append(server)
        # Keys of installed skills: a /command only counts as a skill load when it names one.
        self.known_skills: set[str] = set(self.skill_name.values())

    def mcp_key(self, server: str | None, tool: str | None) -> str:
        if server:
            return self.mcp.get(server.lower()) or ext_key("mcp", server)
        if tool:
            servers = self.cursor_tool.get(tool)
            if servers:
                return self.mcp.get(servers[0].lower()) or ext_key("mcp", servers[0])
        return ext_key("mcp", "unknown")

    def skill_key(self, name: str | None, path: str | None) -> str | None:
        if path:
            for prefix, key in self.skill_path:
                if path.startswith(prefix):
                    return key
        if name:
            key = self.skill_name.get(name.lower())
            if key:
                return key
            return ext_key("skill", name)
        return None


_cache_lock = threading.Lock()
_cache: Inventory | None = None


_versions = 0


def scan(cwds: Iterable[str], *, refresh: bool = False) -> Inventory:
    """Read every agent's config, reusing the last result until a file it read changes."""
    global _cache, _versions
    with _cache_lock:
        cwd_key = tuple(sorted(set(cwds)))
        now = time.time()
        if not refresh and _cache is not None and _cache.cwds == cwd_key:
            if now - _cache.checked_at < CHECK_EVERY_S:
                return _cache
            if _signature(_cache_watched) == _cache.signature:
                _cache.checked_at = now
                return _cache
        _watched.clear()
        cj_path = claude_json_path()
        cj = _dict(_read_json(cj_path)) if cj_path else {}
        codex_projects = list(_dict(_read_toml(codex_home() / "config.toml").get("projects")).keys())
        projects = project_roots([*cwd_key, *_dict(cj.get("projects")).keys(), *codex_projects])
        installs: list[Install] = []
        native = _scan_claude(installs, projects)
        cursor_extra = _scan_cursor(installs, projects)
        _scan_codex(installs, projects)
        watched = frozenset(_watched)
        _versions += 1
        _cache = Inventory(
            extensions=group(installs, native),
            projects=projects,
            cursor_tools=cursor_extra.get("cursor_tools", {}),
            scanned_at=now,
            version=_versions,
            cwds=cwd_key,
            signature=_signature(watched),
            checked_at=now,
        )
        _set_watched(watched)
        return _cache


_cache_watched: frozenset[str] = frozenset()


def _set_watched(paths: frozenset[str]) -> None:
    global _cache_watched
    _cache_watched = paths


def clear_cache() -> None:
    global _cache
    with _cache_lock:
        _cache = None
