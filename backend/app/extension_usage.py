"""Which plugins, skills and MCP servers sessions actually used.

``sync()`` copies the events that touched an extension into the small
``extension_uses`` table, past a watermark, so reads never scan the
payload-heavy events table. ``overview()`` and ``detail()`` join that usage to
the on-disk inventory from :mod:`extensions`, resolving what each event said
(``mcp__github__create_issue``, ``Skill pptx``, a ``SKILL.md`` read, a
``/command`` prompt) to an installed extension.
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
import statistics
import threading
import time
from collections.abc import Callable
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from . import extensions, marketplace_scan, store, timeutil

# Bump to rebuild extension_uses from scratch (e.g. when classify() changes).
USAGE_VERSION = "1"
_WATERMARK_KEY = "extension_uses_watermark"
_VERSION_KEY = "extension_uses_version"

_SLASH = re.compile(r"^\s*/([A-Za-z0-9][\w.:-]*)(?=\s|$)")
_COMMAND_TAG = re.compile(r"<command-name>/?([\w.:-]+)</command-name>")
# A skill read right after the Skill tool loaded it is the same load.
_FOLD_WINDOW_S = 180

_sync_lock = threading.Lock()


# --- Classification --------------------------------------------------------


def _parse_mcp_tool(tool: str) -> tuple[str | None, str | None]:
    parts = tool.split("__", 2)
    if len(parts) == 3:
        return parts[1], parts[2]
    return None, None


def classify(row: dict[str, Any]) -> dict[str, Any] | None:
    """What one event says about extension use, or None."""
    tool = row.get("tool") or ""
    target = row.get("target") or ""
    category = row.get("category") or ""
    if tool.startswith("mcp__"):
        server, mcp_tool = _parse_mcp_tool(tool)
        return {"kind": "mcp", "name": server, "tool": mcp_tool, "via": "call"}
    if tool.startswith("MCP:"):
        # Cursor's live hooks omit the server; resolved from Cursor's tool
        # descriptors at read time.
        return {"kind": "mcp", "name": None, "tool": tool[4:], "via": "call"}
    if tool == "CallMcpTool":
        try:
            body = json.loads(row.get("payload") or "{}")
        except ValueError:
            body = {}
        tin = body.get("tool_input") if isinstance(body, dict) else None
        tin = tin if isinstance(tin, dict) else {}
        server = tin.get("server") if isinstance(tin.get("server"), str) else None
        mcp_tool = tin.get("toolName") if isinstance(tin.get("toolName"), str) else None
        if not server and "/" in target:
            server, _, mcp_tool = target.partition("/")
        return {"kind": "mcp", "name": server, "tool": mcp_tool, "via": "call"}
    if tool == "Skill":
        return {"kind": "skill", "name": target or None, "via": "tool"} if target else None
    if target.lower().endswith("/skill.md") and category in ("context_read", "memory", "file_read"):
        return {"kind": "skill", "name": Path(target).parent.name, "path": target, "via": "read"}
    if category == "prompt":
        text = row.get("detail") or ""
        m = _COMMAND_TAG.search(text) or _SLASH.match(text)
        if m:
            return {"kind": "skill", "name": m.group(1), "via": "slash"}
    return None


# --- Sync ------------------------------------------------------------------

_SYNC_SELECT = (
    "SELECT id, session_id, source, tool, category, target, phase, status, duration_ms, ts,"
    " CASE WHEN tool = 'CallMcpTool' THEN payload END AS payload,"
    " CASE WHEN category = 'prompt' THEN substr(detail, 1, 400) END AS detail"
    " FROM events"
    " WHERE category IN ('mcp', 'memory', 'web', 'context_read', 'file_read', 'prompt') AND id > ?"
)


def _settings_get(conn, key: str) -> str | None:
    row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else None


def _settings_set(conn, key: str, value: str) -> None:
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?, ?)"
        " ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )


def sync(batch: int = 2000) -> int:
    """Copy new extension-touching events into extension_uses. Returns rows added.

    Autoincrement ids only grow and inserts are serialized, so everything past
    the watermark is new. The category index keeps this a narrow read even on
    the first run."""
    with _sync_lock:
        with store.read() as conn:
            version = _settings_get(conn, _VERSION_KEY)
            mark = int(_settings_get(conn, _WATERMARK_KEY) or 0) if version == USAGE_VERSION else 0
            rows = [dict(r) for r in conn.execute(_SYNC_SELECT, (mark,)).fetchall()]
        if version != USAGE_VERSION:
            with store.write() as conn:
                conn.execute("DELETE FROM extension_uses")
                _settings_set(conn, _VERSION_KEY, USAGE_VERSION)
                _settings_set(conn, _WATERMARK_KEY, "0")
        if not rows:
            return 0
        added = 0
        rows.sort(key=lambda r: r["id"])
        for start in range(0, len(rows), batch):
            chunk = rows[start : start + batch]
            values = []
            for r in chunk:
                c = classify(r)
                if c is None:
                    continue
                values.append((
                    r["id"], r["session_id"], r["source"], c["kind"], c.get("name"), c.get("tool"),
                    c.get("path"), c["via"], r["phase"], r["status"], r["duration_ms"], r["ts"],
                ))
            with store.write() as conn:
                if values:
                    conn.executemany(
                        "INSERT OR REPLACE INTO extension_uses (event_id, session_id, source, kind, name,"
                        " tool, path, via, phase, status, duration_ms, ts)"
                        " SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?"
                        " WHERE EXISTS (SELECT 1 FROM events WHERE id = ?)"
                        " AND EXISTS (SELECT 1 FROM sessions WHERE id = ?)",
                        [(*v, v[0], v[1]) for v in values],
                    )
                _settings_set(conn, _WATERMARK_KEY, str(chunk[-1]["id"]))
            added += len(values)
        return added


def sync_quietly() -> None:
    try:
        sync()
    except Exception:  # never let a background backfill take the collector down
        pass


def _sync_for_read() -> None:
    """Catch up before a read, but a busy DB (an index build, a long import)
    only means the view is a few events behind, not an error."""
    try:
        sync()
    except sqlite3.OperationalError:
        pass


# --- Read side -------------------------------------------------------------


# --- Result cache --------------------------------------------------------------
#
# The dashboard refetches on every live event (coalesced to ~1.5s) while any
# agent works, but most events are not MCP calls or skill loads. Results are
# reused until something they depend on changes: a new or deleted use, an
# archive toggle, a config change (inventory version), a finished security scan,
# or the minute rolling over (windows like "last 7 days" slide).

_memo: dict[tuple, tuple[tuple, Any]] = {}
_memo_lock = threading.Lock()
_scan_revision = 0
_MEMO_MAX = 64


def _state_token(inv: "extensions.Inventory") -> tuple:
    with store.read() as conn:
        last, count = conn.execute("SELECT COALESCE(MAX(event_id), 0), COUNT(*) FROM extension_uses").fetchone()
        archived = conn.execute("SELECT COUNT(*) FROM sessions WHERE archived = 1").fetchone()[0]
    return (str(store.path()), last, count, archived, inv.version, _scan_revision, int(time.time() // 60))


def cached(key: tuple, compute: Callable[[], Any], inv: "extensions.Inventory | None" = None) -> Any:
    """``compute()``, or its last result when nothing it depends on has changed."""
    token = _state_token(inv or inventory())
    with _memo_lock:
        hit = _memo.get(key)
        if hit is not None and hit[0] == token:
            return hit[1]
    value = compute()
    with _memo_lock:
        if len(_memo) >= _MEMO_MAX:
            _memo.clear()
        _memo[key] = (token, value)
    return value


def _session_cwds() -> list[str]:
    with store.read() as conn:
        return [r["cwd"] for r in conn.execute("SELECT DISTINCT cwd FROM sessions WHERE cwd IS NOT NULL")]


def inventory(refresh: bool = False) -> extensions.Inventory:
    return extensions.scan(_session_cwds(), refresh=refresh)


def _load_uses(where: str = "", params: tuple = ()) -> list[dict[str, Any]]:
    with store.read() as conn:
        rows = conn.execute(
            "SELECT u.event_id, u.session_id, u.source, u.kind, u.name, u.tool, u.path, u.via, u.phase,"
            " u.status, u.duration_ms, u.ts, s.cwd, s.parent_session_id, s.archived"
            " FROM extension_uses u JOIN sessions s ON s.id = u.session_id" + where,
            params,
        ).fetchall()
    return [dict(r) for r in rows]


def _resolve(uses: list[dict[str, Any]], idx: extensions.InventoryIndex) -> None:
    for u in uses:
        if u["kind"] == "mcp":
            u["key"] = idx.mcp_key(u["name"], u["tool"])
        else:
            u["key"] = idx.skill_key(u["name"], u["path"])
            if u["via"] == "slash" and u["key"] not in idx.known_skills:
                u["key"] = None  # /clear, /model ... are commands, not skills


def _parse(ts: str | None) -> datetime | None:
    return timeutil.parse_ts(ts) if ts else None


class _Acc:
    """Rolls one extension's uses into calls, errors, sessions and a trend."""

    def __init__(self) -> None:
        self.sessions: set[str] = set()
        self.root_sessions: set[str] = set()
        self.by_agent: dict[str, set[str]] = {}
        self.projects: dict[str, set[str]] = {}
        self.calls = 0
        self.errors = 0
        self.durations: list[int] = []
        self.first: str | None = None
        self.last: str | None = None
        self.daily: dict[str, int] = {}
        self.tools: dict[str, dict[str, Any]] = {}
        self.via: dict[str, int] = {}
        # (session, tool) -> phase counts, paired like session_components does.
        self.phases: dict[tuple[str, str], dict[str, int]] = {}
        self.skill_loads: dict[str, list[tuple[datetime | None, str]]] = {}

    def add(self, u: dict[str, Any]) -> None:
        if u["kind"] == "skill" and u["phase"] == "start":
            return  # a Read's start and end are one load
        sid = u["session_id"]
        self.sessions.add(sid)
        self.root_sessions.add(u["parent_session_id"] or sid)
        agent = "claude" if u["source"] == "cowork" else u["source"]
        self.by_agent.setdefault(agent, set()).add(u["parent_session_id"] or sid)
        if u["cwd"]:
            self.projects.setdefault(u["cwd"], set()).add(u["parent_session_id"] or sid)
        ts = u["ts"]
        if ts and (self.first is None or ts < self.first):
            self.first = ts
        if ts and (self.last is None or ts > self.last):
            self.last = ts
        self.via[u["via"]] = self.via.get(u["via"], 0) + 1
        if u["kind"] == "mcp":
            tool = u["tool"] or "?"
            phases = self.phases.setdefault((sid, tool), {})
            phase = u["phase"] or "instant"
            phases[phase] = phases.get(phase, 0) + 1
            t = self.tools.setdefault(tool, {"tool": tool, "calls": 0, "errors": 0, "durations": []})
            if u["status"] == "error" and phase != "start":
                self.errors += 1
                t["errors"] += 1
            if u["duration_ms"] is not None and phase != "start":
                self.durations.append(u["duration_ms"])
                t["durations"].append(u["duration_ms"])
            self._day(ts, phase)
        else:
            self.skill_loads.setdefault(sid, []).append((_parse(ts), u["via"]))
            if u["status"] == "error":
                self.errors += 1

    def _day(self, ts: str | None, phase: str) -> None:
        if not ts or phase == "start":
            return
        day = ts[:10]
        self.daily[day] = self.daily.get(day, 0) + 1

    def finish(self, days: int = 30) -> dict[str, Any]:
        for (sid, tool), phases in self.phases.items():
            n = max(phases.get("start", 0), phases.get("end", 0)) + phases.get("instant", 0)
            self.calls += n
            self.tools[tool]["calls"] += n
        for sid, loads in self.skill_loads.items():
            loads.sort(key=lambda x: x[0] or datetime.min.replace(tzinfo=timezone.utc))
            last_explicit: datetime | None = None
            for when, via in loads:
                if via in ("tool", "slash"):
                    self.calls += 1
                    last_explicit = when
                    self._day(when.isoformat() if when else None, "end")
                elif not (last_explicit and when and (when - last_explicit).total_seconds() <= _FOLD_WINDOW_S):
                    self.calls += 1
                    self._day(when.isoformat() if when else None, "end")
        today = datetime.now(timezone.utc).date()
        trend = [self.daily.get((today - timedelta(days=i)).isoformat(), 0) for i in range(days - 1, -1, -1)]
        return {
            "sessions": len(self.root_sessions),
            "calls": self.calls,
            "errors": self.errors,
            "error_rate": round(self.errors / self.calls, 4) if self.calls else 0,
            "p50_ms": int(statistics.median(self.durations)) if self.durations else None,
            "first_used": timeutil.format_ts(self.first),
            "last_used": timeutil.format_ts(self.last),
            "agents": {a: len(s) for a, s in sorted(self.by_agent.items())},
            "projects": len(self.projects),
            "trend": trend,
            "recent_calls": sum(trend),
        }


def _rollup(uses: list[dict[str, Any]]) -> dict[str, _Acc]:
    accs: dict[str, _Acc] = {}
    for u in uses:
        if u["key"]:
            accs.setdefault(u["key"], _Acc()).add(u)
    return accs


def _merge_plugin_usage(inv: extensions.Inventory, accs: dict[str, _Acc]) -> None:
    """A plugin's usage is the usage of the skills and servers it ships."""
    children: dict[str, list[str]] = {}
    for key, ext in inv.extensions.items():
        if ext.get("plugin") and ext["kind"] != "plugin":
            children.setdefault(ext["plugin"], []).append(key)
    for plugin_key, kids in children.items():
        merged = _Acc()
        any_use = False
        for k in kids:
            acc = accs.get(k)
            if not acc:
                continue
            any_use = True
            merged.sessions |= acc.sessions
            merged.root_sessions |= acc.root_sessions
            for a, s in acc.by_agent.items():
                merged.by_agent.setdefault(a, set()).update(s)
            for p, s in acc.projects.items():
                merged.projects.setdefault(p, set()).update(s)
            merged.phases.update({(sid, f"{k}/{t}"): v for (sid, t), v in acc.phases.items()})
            for (sid, t) in acc.phases:
                merged.tools.setdefault(f"{k}/{t}", {"tool": t, "calls": 0, "errors": 0, "durations": []})
            for sid, loads in acc.skill_loads.items():
                merged.skill_loads.setdefault(sid, []).extend(loads)
            merged.errors += acc.errors
            merged.durations += acc.durations
            for d, n in acc.daily.items():
                merged.daily[d] = merged.daily.get(d, 0) + n
            merged.first = min(filter(None, [merged.first, acc.first]), default=None)
            merged.last = max(filter(None, [merged.last, acc.last]), default=None)
        if any_use:
            accs[plugin_key] = merged


_EMPTY_USAGE = {
    "sessions": 0, "calls": 0, "errors": 0, "error_rate": 0, "p50_ms": None, "first_used": None,
    "last_used": None, "agents": {}, "projects": 0, "trend": [0] * 30, "recent_calls": 0,
}


def _uninstalled(key: str, agents: set[str]) -> dict[str, Any]:
    kind, _, name = key.partition(":")
    return {
        "key": key,
        "kind": kind,
        "name": name,
        "display_name": name,
        "description": None,
        "installed": False,
        "origin": extensions.origin_label(kind, name),
        "installs": [],
        "agents": sorted(agents),
        "scopes": [],
        "projects": [],
        "enabled": None,
        "plugin": None,
        "aliases": [],
        "paths": [],
    }


def _compact(ext: dict[str, Any], usage: dict[str, Any]) -> dict[str, Any]:
    risk = risk_summary(ext)
    return {
        "key": ext["key"],
        "kind": ext["kind"],
        "name": ext["name"],
        "display_name": ext.get("display_name") or ext["name"],
        "description": ext.get("description"),
        "version": ext.get("version"),
        "marketplace": ext.get("marketplace"),
        "plugin": ext.get("plugin"),
        "installed": ext.get("installed", True),
        "origin": ext.get("origin"),
        "enabled": ext.get("enabled"),
        "agents": ext.get("agents", []),
        "scopes": ext.get("scopes", []),
        "projects": ext.get("projects", []),
        "transport": (ext.get("mcp") or {}).get("transport"),
        "contents": ext.get("contents"),
        "native_usage": ext.get("native_usage"),
        "usage": usage,
        "risk": risk,
    }


def _build(inv: extensions.Inventory, uses: list[dict[str, Any]]) -> tuple[dict[str, dict[str, Any]], dict[str, _Acc]]:
    _resolve(uses, inv.index())
    accs = _rollup(uses)
    _merge_plugin_usage(inv, accs)
    exts = dict(inv.extensions)
    for key, acc in accs.items():
        if key not in exts:
            exts[key] = _uninstalled(key, set(acc.by_agent))
        else:
            exts[key] = {**exts[key], "agents": sorted(set(exts[key]["agents"]) | set(acc.by_agent))}
    return exts, accs


def overview(refresh: bool = False, days: int = 0) -> dict[str, Any]:
    """Every extension with its usage. ``days`` > 0 limits uses, sessions and
    failures to that window (matching the Activity range); last used and
    "never used" always look at all history."""
    _sync_for_read()
    inv = inventory(refresh)
    return cached(("overview", days), lambda: _overview(inv, days), inv)


def _overview(inv: extensions.Inventory, days: int) -> dict[str, Any]:
    uses = _load_uses(" WHERE s.archived = 0")
    exts, accs_all = _build(inv, uses)
    if days > 0:
        since = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
        accs = _rollup([u for u in uses if (u["ts"] or "") >= since])
        _merge_plugin_usage(inv, accs)
    else:
        accs = accs_all
    trend_days = 7 if 0 < days <= 7 else 30
    items = []
    for key, ext in exts.items():
        usage = accs[key].finish(trend_days) if key in accs else {**_EMPTY_USAGE, "trend": [0] * trend_days}
        ever = accs_all.get(key)
        usage["last_used"] = timeutil.format_ts(ever.last) if ever else None
        usage["first_used"] = timeutil.format_ts(ever.first) if ever else None
        if not any(usage["trend"]):
            usage["trend"] = []  # most rows (hundreds of unused skills) would send only zeros
        item = _compact(ext, usage)
        item["ever_used"] = ever is not None
        items.append(item)
    items.sort(key=lambda i: (-(i["usage"]["calls"]), -(i["usage"]["sessions"]), i["name"].lower()))

    installed = [i for i in items if i["installed"]]
    cutoff = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()
    summary = {
        kind: {
            "installed": sum(1 for i in installed if i["kind"] == kind),
            "used": sum(1 for i in items if i["kind"] == kind and i["usage"]["calls"]),
            "used_30d": sum(1 for i in items if i["kind"] == kind and (i["usage"]["last_used"] or "") >= cutoff),
            "unused": sum(1 for i in installed if i["kind"] == kind and not i["ever_used"]),
            "project_scoped": sum(1 for i in installed if i["kind"] == kind and i["projects"]),
            "not_installed": sum(1 for i in items if i["kind"] == kind and not i["installed"]),
            "flagged": sum(1 for i in items if i["kind"] == kind and i["risk"]["level"] in ("high", "critical")),
        }
        for kind in ("plugin", "skill", "mcp")
    }
    return {
        "generated_at": timeutil.now(),
        "days": days,
        "summary": summary,
        "projects": inv.projects,
        "items": items,
        "scan": scan_progress(),
    }


def detail(key: str, refresh: bool = False) -> dict[str, Any] | None:
    _sync_for_read()
    inv = inventory(refresh)
    return cached(("detail", key), lambda: _detail(inv, key), inv)


def _detail(inv: extensions.Inventory, key: str) -> dict[str, Any] | None:
    uses = _load_uses()
    exts, accs = _build(inv, uses)
    ext = exts.get(key)
    if ext is None:
        return None
    acc = accs.get(key)
    usage = acc.finish(days=90) if acc else {**_EMPTY_USAGE, "trend": [0] * 90}
    tools = []
    projects = []
    if acc:
        for t in acc.tools.values():
            d = t["durations"]
            tools.append({
                "tool": t["tool"], "calls": t["calls"], "errors": t["errors"],
                "p50_ms": int(statistics.median(d)) if d else None,
            })
        tools.sort(key=lambda t: -t["calls"])
        installed_in = set(ext.get("projects") or [])
        for cwd, sids in sorted(acc.projects.items(), key=lambda kv: -len(kv[1])):
            projects.append({
                "path": cwd,
                "sessions": len(sids),
                "installed_here": any(cwd == p or cwd.startswith(p.rstrip("/") + "/") for p in installed_in),
            })
    member_keys = {key} | {k for k, e in exts.items() if e.get("plugin") == key}
    sessions = _sessions_for([u for u in uses if u.get("key") in member_keys])
    children = [
        _compact(e, accs[k].finish() if k in accs else dict(_EMPTY_USAGE))
        for k, e in exts.items() if e.get("plugin") == key
    ]
    public = {k: v for k, v in ext.items() if k not in ("aliases",)}
    return {
        **public,
        "installs": [{**i, "path": i["path"]} for i in ext.get("installs", [])],
        "usage": usage,
        "tools": tools,
        "projects_used": projects[:50],
        "sessions": sessions[:100],
        "children": children,
        "risk": risk_summary(ext),
        "security": cached_scan(ext),
        "mcp_tools_known": _known_tools(inv, ext),
    }


def _known_tools(inv: extensions.Inventory, ext: dict[str, Any]) -> list[dict[str, Any]] | None:
    if ext["kind"] != "mcp":
        return None
    info = inv.cursor_tools.get(ext["name"])
    if not info:
        return None
    return [{"tool": t, "description": (d or "")[:240] or None} for t, d in sorted(info["tools"].items())]


def _sessions_for(uses: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by: dict[str, dict[str, Any]] = {}
    for u in uses:
        sid = u["parent_session_id"] or u["session_id"]
        s = by.setdefault(sid, {"id": sid, "source": u["source"], "cwd": u["cwd"], "uses": 0, "last_used": None, "first_event_id": u["event_id"]})
        if u["phase"] != "start":
            s["uses"] += 1
        if not s["last_used"] or (u["ts"] or "") > s["last_used"]:
            s["last_used"] = u["ts"]
        s["first_event_id"] = min(s["first_event_id"], u["event_id"])
    out = sorted(by.values(), key=lambda s: s["last_used"] or "", reverse=True)
    for s in out:
        s["last_used"] = timeutil.format_ts(s["last_used"])
    return out


def session_extensions(session_id: str) -> list[dict[str, Any]]:
    """Extensions one session (and its subagents) used, for the session view."""
    _sync_for_read()
    inv = inventory()
    uses = _load_uses(" WHERE s.id = ? OR s.parent_session_id = ?", (session_id, session_id))
    exts, accs = _build(inv, uses)
    out = []
    for key, acc in accs.items():
        ext = exts[key]
        if ext["kind"] == "plugin":
            continue
        u = acc.finish(days=1)
        out.append({
            "key": key, "kind": ext["kind"], "name": ext["name"],
            "display_name": ext.get("display_name") or ext["name"],
            "installed": ext.get("installed", True), "scopes": ext.get("scopes", []),
            "plugin": ext.get("plugin"), "calls": u["calls"], "errors": u["errors"],
            "tools": sorted(acc.tools, key=lambda t: -acc.tools[t]["calls"])[:8] if ext["kind"] == "mcp" else [],
        })
    out.sort(key=lambda e: (e["kind"], -e["calls"]))
    return out


# --- Security --------------------------------------------------------------

_SEVERITY_RANK = {"info": 0, "low": 1, "medium": 2, "high": 3, "critical": 4}
_scan_lock = threading.Lock()
_scan_state: dict[str, Any] = {"running": False, "done": 0, "total": 0}


def _scan_file() -> Path:
    return store.main_path().with_name("extension-scans.json")


# Scan reports per DB file, held in memory once read; the JSON file beside
# the DB only persists them across restarts.
_scans_mem: dict[str, dict[str, Any]] = {}


def _load_scans() -> dict[str, Any]:
    path = _scan_file()
    data = _scans_mem.get(str(path))
    if data is None:
        try:
            data = json.loads(path.read_text())
        except (OSError, ValueError):
            data = {}
        _scans_mem[str(path)] = data
    return data


def _save_scans(data: dict[str, Any]) -> None:
    path = _scan_file()
    tmp = path.with_suffix(".tmp")
    try:
        tmp.write_text(json.dumps(data))
        os.replace(tmp, path)
    except OSError:
        pass


def _scan_root(ext: dict[str, Any]) -> Path | None:
    if ext["kind"] not in ("skill", "plugin"):
        return None
    for i in ext.get("installs", []):
        if i.get("path") and Path(i["path"]).is_dir():
            return Path(i["path"])
    return None


# Bump when run_scan's post-processing changes, so cached reports refresh.
_SCAN_REVISION = "2"


def _fingerprint(ext: dict[str, Any], root: Path) -> str:
    """Changes when the package's files do (the inventory already walked them)."""
    return f"{_SCAN_REVISION}|{root}|{ext.get('files')}|{ext.get('size_bytes')}|{ext.get('updated_at')}"


def _accept_plugin_manifest(report: dict[str, Any]) -> None:
    """The scanner only knows ``.claude-plugin`` manifests; a Codex or Cursor
    plugin the inventory already identified is not an unknown package."""
    findings = report.get("findings") or []
    kept = [f for f in findings if f.get("rule") != "provenance.kind"]
    if len(kept) == len(findings):
        return
    ran = {p["id"] for p in report.get("perspectives", []) if p.get("status") != "skipped"}
    report.update(marketplace_scan.score_report([marketplace_scan.Finding(**f) for f in kept], ran))
    report["findings"] = kept
    report["kind"] = "plugin"


def cached_scan(ext: dict[str, Any]) -> dict[str, Any] | None:
    root = _scan_root(ext)
    if root is None:
        return None
    entry = _load_scans().get(ext["key"])
    if entry and entry.get("fingerprint") == _fingerprint(ext, root):
        return entry["report"]
    return None


def run_scan(ext: dict[str, Any], *, persist: bool = True) -> dict[str, Any] | None:
    root = _scan_root(ext)
    if root is None:
        return None
    report = marketplace_scan.scan(root)
    report.pop("files", None)
    if ext["kind"] == "plugin":
        _accept_plugin_manifest(report)
    with _scan_lock:
        scans = _load_scans()
        scans[ext["key"]] = {"fingerprint": _fingerprint(ext, root), "report": report}
        global _scan_revision
        _scan_revision += 1
        if persist:
            _save_scans(scans)
    return report


def _persist_scans() -> None:
    with _scan_lock:
        _save_scans(_load_scans())


def scan_one(key: str) -> dict[str, Any] | None:
    inv = inventory()
    ext = inv.extensions.get(key)
    if ext is None:
        return None
    return run_scan(ext)


def scan_progress() -> dict[str, Any]:
    return dict(_scan_state)


def scan_all_in_background() -> dict[str, Any]:
    if _scan_state["running"]:
        return scan_progress()
    inv = inventory()
    todo = [e for e in inv.extensions.values() if _scan_root(e) is not None and cached_scan(e) is None]
    _scan_state.update(running=True, done=0, total=len(todo))

    def work() -> None:
        try:
            for n, ext in enumerate(todo, 1):
                try:
                    run_scan(ext, persist=False)
                except Exception:
                    pass
                _scan_state["done"] += 1
                if n % 50 == 0:
                    _persist_scans()
        finally:
            _persist_scans()
            _scan_state["running"] = False

    threading.Thread(target=work, name="extension-scan", daemon=True).start()
    return scan_progress()


def risk_summary(ext: dict[str, Any]) -> dict[str, Any]:
    """Worst finding across the package scan (skills/plugins) or the MCP launch checks."""
    findings: list[dict[str, Any]] = list(ext.get("risks") or [])
    verdict = None
    score = None
    report = cached_scan(ext) if ext["kind"] in ("skill", "plugin") else None
    if report:
        verdict = report.get("verdict")
        score = report.get("score")
        findings += [{"severity": f["severity"], "title": f["title"]} for f in report.get("findings", [])]
    worst = max((f["severity"] for f in findings), key=lambda s: _SEVERITY_RANK.get(s, 0), default=None)
    # MCP launch checks read the server's config; one no config lists was never checked.
    scanned = report is not None or (ext["kind"] == "mcp" and ext.get("installed", True))
    return {
        "level": worst if worst and _SEVERITY_RANK.get(worst, 0) >= 2 else ("ok" if scanned else None),
        "findings": len(findings),
        "verdict": verdict,
        "score": score,
        "scanned": scanned,
    }


# --- Activity ----------------------------------------------------------------

_VIA_LABEL = {"tool": "Skill tool", "slash": "/command", "read": "file read"}


def activity_items(kind: str, since: str | None, project: str | None, source: str | None) -> list[dict[str, Any]]:
    """MCP calls (``kind='mcp'``) or skill loads (``'skill'``) as Activity items, newest first.

    One item per finished call: a call's start row is dropped, and a SKILL.md
    read right after the Skill tool loaded it folds into that load, the same
    counting the Extensions view uses."""
    _sync_for_read()
    inv = inventory()
    if since is not None:
        # A window start is a fresh timestamp on every call, so it would never hit the cache.
        return _activity_items(inv, kind, since, project, source)
    return cached(("activity", kind, project, source), lambda: _activity_items(inv, kind, None, project, source), inv)


def _activity_items(
    inv: extensions.Inventory, kind: str, since: str | None, project: str | None, source: str | None
) -> list[dict[str, Any]]:
    clauses = ["u.kind = ?", "u.phase IS NOT 'start'"]
    params: list[Any] = [kind]
    if since:
        clauses.append("u.ts >= ?")
        params.append(since)
    if project:
        clauses.append("s.cwd = ?")
        params.append(project)
    if source:
        clauses.append("u.source = ?")
        params.append(source)
    with store.read() as conn:
        rows = [dict(r) for r in conn.execute(
            "SELECT u.event_id, u.session_id, u.source, u.kind, u.name, u.tool, u.path, u.via, u.phase,"
            " u.status, u.duration_ms, u.ts, s.cwd,"
            " CASE WHEN u.status = 'error' AND json_valid(e.payload)"
            " THEN COALESCE(json_extract(e.payload, '$.error'), json_extract(e.payload, '$.error_message'),"
            " json_extract(e.payload, '$.tool_response.error')) END AS error"
            " FROM extension_uses u JOIN sessions s ON s.id = u.session_id"
            " LEFT JOIN events e ON e.id = u.event_id"
            f" WHERE {' AND '.join(clauses)} ORDER BY u.ts DESC",
            params,
        )]
    idx = inv.index()
    _resolve(rows, idx)
    if kind == "skill":
        rows = _fold_skill_reads(rows)

    from .activity import parse_error  # imported here: activity imports this module

    out = []
    for r in rows:
        key = r.get("key")
        if not key:
            continue
        ext = inv.extensions.get(key)
        label = (ext or {}).get("display_name") or key.partition(":")[2]
        plugin = (ext or {}).get("plugin")
        if kind == "mcp":
            tool = r["tool"] or "?"
            target = f"{label} › {tool}"
            via: list[str] = []
        else:
            tool = None
            target = label
            via = [_VIA_LABEL.get(r["via"], r["via"])]
        failed = r["status"] == "error"
        out.append({
            "event_id": r["event_id"],
            "session_id": r["session_id"],
            "ts": r["ts"],
            "source": r["source"],
            "cwd": r["cwd"],
            "duration_ms": r["duration_ms"],
            "failed": failed,
            "error": parse_error(r["error"]) if failed else None,
            "target": target,
            "key": label,
            "ext_key": key,
            "installed": ext is not None,
            # Where an extension no config lists comes from (e.g. "Claude app built-in").
            "origin": (ext or {}).get("origin") or extensions.origin_label(kind, key.partition(":")[2]),
            "plugin": plugin,
            "verb": tool if kind == "mcp" else via[0],
            "core": target,
            "path": r["path"],
            "tool": None,
            "program": None,
            "risk": None,
            "via": via,
        })
    return out


def _fold_skill_reads(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Drop a SKILL.md read that follows the Skill tool / a /command loading the same skill."""
    explicit: dict[tuple[str, str], list[datetime]] = {}
    for r in rows:
        if r["via"] in ("tool", "slash") and r.get("key"):
            when = _parse(r["ts"])
            if when:
                explicit.setdefault((r["session_id"], r["key"]), []).append(when)
    out = []
    for r in rows:
        if r["via"] == "read" and r.get("key"):
            when = _parse(r["ts"])
            loads = explicit.get((r["session_id"], r["key"]), [])
            if when and any(0 <= (when - t).total_seconds() <= _FOLD_WINDOW_S for t in loads):
                continue
        out.append(r)
    return out
