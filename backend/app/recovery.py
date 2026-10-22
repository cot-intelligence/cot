"""Tool-error recovery: what an agent did after a tool call failed.

A chain starts at a failed tool call and follows the session's next tool calls.
Each step is a retry (the same tool on the same target), a tweak (the same tool
on a different target) or a switch (another tool). The chain is recovered when
the failed tool succeeds within ``MAX_STEPS``: other tools succeeding in between
is the agent working around it, not fixing it. A chain where only other tools
succeeded moved on; one where nothing did is abandoned. Read straight from the
recorded calls; no model is involved.
"""

from __future__ import annotations

import json
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any

from . import store

MAX_STEPS = 8
# Searches that find nothing exit non-zero but are answers, not failures.
_NOT_FAILURES = {"Grep", "Glob", "grep", "glob"}


def _error_text(payload: str | None) -> str | None:
    if not payload:
        return None
    try:
        body = json.loads(payload)
    except (json.JSONDecodeError, TypeError):
        return None
    if not isinstance(body, dict):
        return None
    err = body.get("error") or body.get("error_message")
    if isinstance(err, dict):
        err = err.get("message")
    return str(err)[:300] if err else None


def chains_from(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Recovery chains in one session's tool calls (oldest first)."""
    out: list[dict[str, Any]] = []
    chain: dict[str, Any] | None = None

    def close(c: dict[str, Any]) -> None:
        c["outcome"] = "moved_on" if any(st["ok"] for st in c["steps"]) else "abandoned"
        out.append(c)

    for r in rows:
        if r["status"] == "error" and r["tool"] in _NOT_FAILURES:
            continue  # neither a failure nor a recovery
        failed = r["status"] == "error"
        if chain is None:
            if failed:
                chain = {
                    "event_id": r["id"], "ts": r["ts"], "tool": r["tool"], "target": r["target"],
                    "category": r["category"], "error": _error_text(r.get("payload")), "steps": [],
                }
            continue
        same_tool = r["tool"] == chain["tool"]
        kind = "retry" if same_tool and r["target"] == chain["target"] else "tweak" if same_tool else "switch"
        chain["steps"].append({"event_id": r["id"], "tool": r["tool"], "target": r["target"], "kind": kind, "ok": not failed})
        if same_tool and not failed:
            chain["outcome"] = "recovered"
            chain["recovered_by"] = kind
            out.append(chain)
            chain = None
        elif len(chain["steps"]) >= MAX_STEPS:
            close(chain)
            chain = None
    if chain is not None:
        close(chain)
    return out


def _columns(t: str) -> str:
    return (f"{t}id, {t}session_id, {t}ts, {t}tool, {t}category, {t}target, {t}status,"
            f" CASE WHEN {t}status = 'error' THEN {t}payload END AS payload")


def _where(t: str) -> str:
    return f"{t}tool IS NOT NULL AND {t}phase IN ('end', 'instant')"


def for_session(session_id: str) -> dict[str, Any]:
    with store.read() as conn:
        rows = [dict(r) for r in conn.execute(
            f"SELECT {_columns('')} FROM events WHERE session_id = ? AND {_where('')} ORDER BY ts, id", (session_id,)
        ).fetchall()]
    chains = chains_from(rows)
    return {"session_id": session_id, "tool_calls": len(rows), "chains": chains, **_rollup(chains)}


def _rollup(chains: list[dict[str, Any]]) -> dict[str, Any]:
    recovered = [c for c in chains if c["outcome"] == "recovered"]
    by = defaultdict(int)
    for c in recovered:
        by[c["recovered_by"]] += 1
    return {
        "failures": len(chains),
        "recovered": len(recovered),
        "moved_on": sum(1 for c in chains if c["outcome"] == "moved_on"),
        "abandoned": sum(1 for c in chains if c["outcome"] == "abandoned"),
        "recovery_rate": round(len(recovered) / len(chains), 3) if chains else None,
        "avg_steps": round(sum(len(c["steps"]) for c in recovered) / len(recovered), 1) if recovered else None,
        "recovered_by": dict(by),
    }


def summary(days: int = 7, project: str | None = None, source: str | None = None) -> dict[str, Any]:
    clauses = [_where("e.")]
    params: list[Any] = []
    if days > 0:
        clauses.append("e.ts >= ?")
        params.append((datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%S"))
    if project:
        clauses.append("s.cwd = ?")
        params.append(project)
    if source:
        clauses.append("e.source = ?")
        params.append(source)
    with store.read() as conn:
        rows = conn.execute(
            f"SELECT {_columns('e.')} FROM events e LEFT JOIN sessions s ON s.id = e.session_id"
            f" WHERE {' AND '.join(clauses)} ORDER BY e.session_id, e.ts, e.id",
            params,
        ).fetchall()
    per_session: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for r in rows:
        per_session[r["session_id"]].append(dict(r))

    chains: list[dict[str, Any]] = []
    for sid, srows in per_session.items():
        for c in chains_from(srows):
            c["session_id"] = sid
            chains.append(c)

    tools: dict[str, dict[str, Any]] = {}
    for c in chains:
        t = tools.setdefault(c["tool"] or "(unknown)", {"tool": c["tool"], "failures": 0, "recovered": 0, "steps": 0, "sample": None})
        t["failures"] += 1
        if c["outcome"] == "recovered":
            t["recovered"] += 1
            t["steps"] += len(c["steps"])
        if t["sample"] is None and c["error"]:
            t["sample"] = {"session_id": c["session_id"], "event_id": c["event_id"], "error": c["error"]}
    for t in tools.values():
        t["recovery_rate"] = round(t["recovered"] / t["failures"], 3)
        t["avg_steps"] = round(t["steps"] / t["recovered"], 1) if t["recovered"] else None
        del t["steps"]

    abandoned = sorted((c for c in chains if c["outcome"] == "abandoned"), key=lambda c: c["ts"] or "", reverse=True)
    return {
        "days": days,
        "tool_calls": len(rows),
        **_rollup(chains),
        "tools": sorted(tools.values(), key=lambda t: t["failures"], reverse=True)[:20],
        "abandoned_recent": [
            {k: c.get(k) for k in ("session_id", "event_id", "ts", "tool", "target", "error")} | {"steps": len(c["steps"])}
            for c in abandoned[:10]
        ],
    }
