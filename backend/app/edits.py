"""Recent edits: the files agents changed, newest first, grouped by project and path.

Each file links back to the event that last touched it. Line counts come from the
tool input the agent sent (Edit's old/new strings, MultiEdit's edits, Write's
content, Codex's apply_patch), so they are what the agent asked for, and a
clipped detail undercounts rather than failing.
"""

from __future__ import annotations

import json
import os
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any

from . import store

# One feed page reads at most this many edit events; older edits fall off the end.
MAX_EVENTS = 20_000


def _lines(text: Any) -> int:
    if not isinstance(text, str) or not text:
        return 0
    return text.count("\n") + (0 if text.endswith("\n") else 1)


def _patch_counts(patch: str) -> tuple[int, int]:
    added = removed = 0
    for line in patch.splitlines():
        if line.startswith("***") or line.startswith("+++") or line.startswith("---"):
            continue
        if line.startswith("+"):
            added += 1
        elif line.startswith("-"):
            removed += 1
    return added, removed


def line_delta(detail: str | None) -> tuple[int, int]:
    """Lines added and removed by one edit, from the tool input in its detail."""
    if not detail:
        return 0, 0
    try:
        body = json.loads(detail)
    except (json.JSONDecodeError, TypeError):
        return 0, 0
    inp = body.get("input") if isinstance(body, dict) else None
    if not isinstance(inp, dict):
        return 0, 0
    if isinstance(inp.get("command"), str) and "*** Begin Patch" in inp["command"]:
        return _patch_counts(inp["command"])
    if isinstance(inp.get("patch"), str):
        return _patch_counts(inp["patch"])
    edits = inp.get("edits")
    if isinstance(edits, list):
        added = removed = 0
        for e in edits:
            if isinstance(e, dict):
                added += _lines(e.get("new_string"))
                removed += _lines(e.get("old_string"))
        return added, removed
    if "old_string" in inp or "new_string" in inp:
        return _lines(inp.get("new_string")), _lines(inp.get("old_string"))
    for key in ("content", "contents", "text"):
        if key in inp:
            return _lines(inp.get(key)), 0
    return 0, 0


def _relative(path: str, cwd: str | None) -> str:
    if cwd and path.startswith(cwd.rstrip("/") + "/"):
        return path[len(cwd.rstrip("/")) + 1:]
    return path


def recent(days: int = 7, project: str | None = None, source: str | None = None, limit: int = 200) -> dict[str, Any]:
    clauses = ["e.category = 'file_edit'", "e.target IS NOT NULL AND e.target != ''", "e.phase IN ('end', 'instant')"]
    params: list[Any] = []
    if days > 0:
        since = datetime.now(timezone.utc) - timedelta(days=days)
        clauses.append("e.ts >= ?")
        params.append(since.strftime("%Y-%m-%dT%H:%M:%S"))
    if project:
        clauses.append("s.cwd = ?")
        params.append(project)
    if source:
        clauses.append("e.source = ?")
        params.append(source)
    with store.read() as conn:
        rows = conn.execute(
            "SELECT e.id, e.session_id, e.source, e.tool, e.ts, e.status, e.target, e.detail, s.cwd"
            " FROM events e LEFT JOIN sessions s ON s.id = e.session_id"
            f" WHERE {' AND '.join(clauses)} ORDER BY e.ts DESC LIMIT ?",
            (*params, MAX_EVENTS),
        ).fetchall()

    files: dict[tuple[str, str], dict[str, Any]] = {}
    sessions: dict[tuple[str, str], set[str]] = defaultdict(set)
    for r in rows:
        cwd = r["cwd"] or ""
        key = (cwd, r["target"])
        added, removed = line_delta(r["detail"]) if r["status"] != "error" else (0, 0)
        f = files.get(key)
        if f is None:
            f = files[key] = {
                "project": cwd or None,
                "project_name": os.path.basename(cwd.rstrip("/")) if cwd else None,
                "path": r["target"],
                "relative": _relative(r["target"], cwd),
                "edits": 0,
                "failed": 0,
                "added": 0,
                "removed": 0,
                "agents": [],
                "last": {"session_id": r["session_id"], "event_id": r["id"], "ts": r["ts"], "tool": r["tool"], "source": r["source"]},
            }
        f["edits"] += 1
        f["failed"] += r["status"] == "error"
        f["added"] += added
        f["removed"] += removed
        if r["source"] not in f["agents"]:
            f["agents"].append(r["source"])
        sessions[key].add(r["session_id"])

    items = sorted(files.values(), key=lambda f: f["last"]["ts"] or "", reverse=True)
    for f in items:
        f["sessions"] = len(sessions[(f["project"] or "", f["path"])])

    projects: dict[str, dict[str, Any]] = {}
    for f in items:
        p = projects.setdefault(f["project"] or "", {
            "project": f["project"], "project_name": f["project_name"], "files": 0, "edits": 0,
            "added": 0, "removed": 0, "last_ts": f["last"]["ts"],
        })
        p["files"] += 1
        p["edits"] += f["edits"]
        p["added"] += f["added"]
        p["removed"] += f["removed"]

    return {
        "days": days,
        "totals": {
            "files": len(items),
            "edits": sum(f["edits"] for f in items),
            "added": sum(f["added"] for f in items),
            "removed": sum(f["removed"] for f in items),
            "projects": len(projects),
            "truncated": len(rows) >= MAX_EVENTS,
        },
        "projects": sorted(projects.values(), key=lambda p: p["last_ts"] or "", reverse=True),
        "items": items[:limit],
    }
