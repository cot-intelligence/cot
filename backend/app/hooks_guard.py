"""Keep agent hooks wired without anyone watching.

The bridge writes ``hooks_status.json`` when it installs hooks, but agents
rewrite their own configs (an update, another tool, a hand edit), so a
manifest from install time goes stale. The guard has the bridge re-read the
configs whenever one of them changes on disk, and every few minutes anyway,
then re-wires the agents the person connected.

It only touches agents the person connected (from setup, Settings, or an
install the guard found already in place) and forgets an agent they
disconnect. If something keeps stripping cot's hooks, it stops after a few
repairs an hour rather than fight it, and says so in Settings.
"""

from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path
from typing import Any

from . import db, hooks_install, mcp_install, store, timeutil

AGENTS = hooks_install.AGENTS

_KEEP_KEY = "hooks_keep_wired"
_WANTED_KEY = "hooks_wanted"
_LOG_KEY = "hooks_repairs"
_PAUSED_KEY = "hooks_repair_paused"

_POLL_S = 30.0
_FULL_REFRESH_S = 600.0
_MAX_REPAIRS = 3
_REPAIR_WINDOW_S = 3600.0
_LOG_LIMIT = 20

_lock = threading.Lock()
_last_fingerprint: tuple | None = None
_last_refresh = 0.0
_checked_at: str | None = None


def manifest_path() -> Path:
    return store.path().parent / "hooks_status.json"


def read_manifest() -> dict[str, Any]:
    try:
        data = json.loads(manifest_path().read_text())
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def _manifest_agents(manifest: dict[str, Any]) -> dict[str, dict[str, Any]]:
    agents = manifest.get("agents")
    if not isinstance(agents, dict):
        return {}
    return {k: v for k, v in agents.items() if k in AGENTS and isinstance(v, dict)}


def _json_setting(key: str, default: Any) -> Any:
    raw = db.get_setting(key)
    if raw is None:
        return default
    try:
        return json.loads(raw)
    except ValueError:
        return default


def keep_wired() -> bool:
    return db.get_setting(_KEEP_KEY, "1") != "0"


def set_keep_wired(on: bool) -> None:
    db.set_setting(_KEEP_KEY, "1" if on else "0")
    if on:
        db.set_setting(_PAUSED_KEY, "{}")


def _has_cot_hooks(entry: dict[str, Any]) -> bool:
    # The bridge calls an agent "installed" only with every hook in place; one
    # missing hook still means the person wired it up.
    return bool(entry.get("installed") or entry.get("installed_hooks"))


def wanted() -> list[str]:
    """Agents the person connected: any agent with cot's hooks still in its
    config (so an install that predates the guard counts, even a partial one),
    plus every agent connected from the dashboard since."""
    value = _json_setting(_WANTED_KEY, None)
    stored = value if isinstance(value, list) else []
    found = {a for a, e in _manifest_agents(read_manifest()).items() if _has_cot_hooks(e)}
    current = [a for a in AGENTS if a in stored or a in found]
    if current != [a for a in AGENTS if a in stored] or not isinstance(value, list):
        db.set_setting(_WANTED_KEY, json.dumps(current))
    return current


def mark_wanted(agents: list[str]) -> None:
    current = set(wanted()) | set(agents)
    db.set_setting(_WANTED_KEY, json.dumps([a for a in AGENTS if a in current]))
    _unpause(agents)


def mark_unwanted(agents: list[str]) -> None:
    current = set(wanted()) - set(agents)
    db.set_setting(_WANTED_KEY, json.dumps([a for a in AGENTS if a in current]))
    _unpause(agents)


def paused() -> dict[str, str]:
    value = _json_setting(_PAUSED_KEY, {})
    return {k: str(v) for k, v in value.items() if k in AGENTS} if isinstance(value, dict) else {}


def _unpause(agents: list[str]) -> None:
    current = paused()
    if any(a in current for a in agents):
        db.set_setting(_PAUSED_KEY, json.dumps({k: v for k, v in current.items() if k not in agents}))


def repairs() -> list[dict[str, Any]]:
    value = _json_setting(_LOG_KEY, [])
    return [r for r in value if isinstance(r, dict)] if isinstance(value, list) else []


def _log(entries: list[dict[str, Any]]) -> None:
    db.set_setting(_LOG_KEY, json.dumps((entries + repairs())[:_LOG_LIMIT]))


def checked_at() -> str | None:
    return _checked_at


def _endpoint(manifest: dict[str, Any]) -> str:
    try:
        cfg = json.loads((mcp_install.bridge_path().parent.parent / "config.json").read_text())
        if isinstance(cfg, dict) and isinstance(cfg.get("endpoint"), str) and cfg["endpoint"]:
            return cfg["endpoint"]
    except (OSError, ValueError):
        pass
    if isinstance(manifest.get("endpoint"), str) and manifest["endpoint"]:
        return manifest["endpoint"]
    return f"http://127.0.0.1:{os.environ.get('COT_PORT', '31337')}"


def _fingerprint(manifest: dict[str, Any]) -> tuple:
    """Cheap stat of every file the manifest depends on; a change means re-read."""
    paths = [str(mcp_install.bridge_path())]
    paths += [str(e["config_path"]) for e in _manifest_agents(manifest).values() if e.get("config_path")]
    out = []
    for p in sorted(set(paths)):
        try:
            st = os.stat(p)
            out.append((p, st.st_mtime_ns, st.st_size))
        except OSError:
            out.append((p, None, None))
    return tuple(out)


def _repair_reason(entry: dict[str, Any], bridge_state: str) -> str | None:
    """Why ``entry`` needs re-wiring, or None when it's fine or not ours to fix."""
    warnings = entry.get("warnings") if isinstance(entry.get("warnings"), list) else []
    if "plugin_disabled" in warnings:
        return None  # turned off inside Hermes on purpose
    if entry.get("valid_json") is False:
        return None  # mid-edit or broken by hand; rewriting it would lose their change
    if bridge_state != "ok":
        return f"bridge_{bridge_state}"
    if entry.get("installed"):
        return None
    if entry.get("config_exists") is False:
        return "config_missing"
    return "hooks_missing"


def _recent_repairs(agent: str, now: float) -> int:
    count = 0
    for r in repairs():
        if r.get("agent") != agent or r.get("status") != "repaired":
            continue
        at = timeutil.parse_ts(r.get("at"))
        if at is not None and now - at.timestamp() < _REPAIR_WINDOW_S:
            count += 1
    return count


def enforce(bridge_source: Path) -> list[dict[str, Any]]:
    """Re-wire every wanted agent whose hooks are gone. Returns new log entries."""
    if not keep_wired() or hooks_install.in_container():
        return []
    manifest = read_manifest()
    entries = _manifest_agents(manifest)
    bridge_state = hooks_install.bridge_health()["state"]
    stopped = paused()
    now = time.time()
    at = timeutil.now()
    log: list[dict[str, Any]] = []
    todo: dict[str, str] = {}
    for agent in wanted():
        if agent in stopped:
            continue
        entry = entries.get(agent)
        if entry is None and bridge_state == "ok":
            continue  # never seen by the bridge; nothing to compare against
        reason = _repair_reason(entry or {}, bridge_state)
        if reason is None:
            continue
        if _recent_repairs(agent, now) >= _MAX_REPAIRS:
            stopped[agent] = "keeps_reverting"
            log.append({"agent": agent, "at": at, "reason": reason, "status": "paused"})
            continue
        todo[agent] = reason
    if log:
        db.set_setting(_PAUSED_KEY, json.dumps(stopped))
    if todo:
        try:
            res = hooks_install.install(list(todo), endpoint=_endpoint(manifest), bridge_source=bridge_source, repair=True)
            for agent, reason in todo.items():
                if agent in res["skipped"]:
                    continue  # the agent itself is gone from this machine
                log.append({"agent": agent, "at": at, "reason": reason, "status": "repaired"})
        except (hooks_install.InstallError, OSError) as exc:
            for agent, reason in todo.items():
                log.append({"agent": agent, "at": at, "reason": reason, "status": "error", "error": str(exc)})
    if log:
        _log(log)
        for entry in log:
            db.record_audit_event(
                "hooks.auto_repaired" if entry["status"] == "repaired" else f"hooks.auto_repair.{entry['status']}",
                target=entry["agent"],
                status="ok" if entry["status"] == "repaired" else "error",
                detail={k: v for k, v in entry.items() if k != "agent"},
            )
    return log


def check(bridge_source: Path, *, force: bool = False) -> list[dict[str, Any]]:
    """Refresh the manifest when a config changed (or it's due), then enforce."""
    global _last_fingerprint, _last_refresh, _checked_at
    if hooks_install.in_container():
        return []
    with _lock:
        fp = _fingerprint(read_manifest())
        now = time.monotonic()
        if not force and fp == _last_fingerprint and now - _last_refresh < _FULL_REFRESH_S:
            return []
        hooks_install.refresh_status()
        log = enforce(bridge_source)
        # Re-stat after our own writes so they don't trigger another pass.
        _last_fingerprint = _fingerprint(read_manifest())
        _last_refresh = time.monotonic()
        _checked_at = timeutil.now()
        return log


def start(bridge_source: Path) -> threading.Thread | None:
    """Run the guard in the background, unless COT_HOOK_GUARD=0 (tests)."""
    if os.environ.get("COT_HOOK_GUARD", "1") == "0" or hooks_install.in_container():
        return None

    def loop() -> None:
        time.sleep(5)  # let startup and the first dashboard reads go first
        while True:
            try:
                check(bridge_source)
            except Exception:  # noqa: BLE001 - keep the guard alive
                pass
            time.sleep(_POLL_S)

    t = threading.Thread(target=loop, daemon=True, name="cot-hook-guard")
    t.start()
    return t
