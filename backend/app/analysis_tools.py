"""Read-only investigation tools for Analysis runs.

The analysis agent never gets a session pasted in whole: a big session is
millions of tokens, ~90% of it diffs and tool output. It starts from a compact
overview (one line per turn) and pulls what it needs through these tools — a
turn's steps, one step's full detail, a search, the rule findings, the cost
breakdown, a comparison with the person's other sessions.

The same tools serve two runners: cot's own agent loop (``analysis.py``, BYOK)
and an outside agent over ``cot mcp`` (``POST /v1/analysis/tools/{name}``), so a
report means the same thing whoever wrote it. Every string that leaves goes
through ``ai_insights.mask_text``.
"""

from __future__ import annotations

import json
import statistics
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from . import ai_insights, context_cost, db, insights, session_read

STEP_DETAIL_CHARS = 6000
TURN_ROW_LIMIT = 120
OVERVIEW_TURN_LIMIT = 150
PROMPT_CHARS = 1200
EXCERPT_CHARS = 280

_TOOL_CATEGORIES = {
    "shell", "file_read", "file_edit", "context_read", "mcp", "web", "subagent",
    "memory", "other", "permission",
}


class ToolError(ValueError):
    """A tool call the agent can recover from (bad id, unknown session…)."""


def _mask(text: Any) -> str:
    return ai_insights.mask_text(str(text or ""))


def _short(text: Any, limit: int) -> str:
    s = " ".join(str(text or "").split())
    return s if len(s) <= limit else s[: limit - 1] + "…"


def _head_tail(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    half = limit // 2
    return f"{text[:half]}\n… [{len(text) - limit} chars cut] …\n{text[-half:]}"


def _detail_text(detail: Any) -> str:
    if isinstance(detail, (dict, list)):
        return json.dumps(detail, ensure_ascii=False, indent=1)
    return str(detail or "")


def _since(days: int) -> str | None:
    if days <= 0:
        return None
    return (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%S")


def _failed(item: dict[str, Any]) -> bool:
    return (item.get("status") or "ok") not in ("ok", "", None)


def session_summary(session_id: str) -> dict[str, Any] | None:
    rows, _ = db.list_sessions_page(1, ids=[session_id])
    if not rows:
        return None
    s = rows[0]
    return {
        "id": s.get("id"),
        "title": _short(_mask(s.get("title")), 160),
        "agent": s.get("source"),
        "project": s.get("cwd"),
        "started_at": s.get("started_at"),
        "duration_seconds": s.get("duration_seconds"),
        "events": s.get("event_count"),
        "tool_calls": s.get("tool_count"),
        "tokens": (s.get("tokens") or {}).get("total"),
        "cost_usd": s.get("cost_usd") if s.get("has_cost") else None,
        "models": s.get("models"),
    }


class Toolbox:
    """Tools bound to one run. ``session_id`` is the run's session (None for a
    cross-session run, where every session tool needs an explicit id). Timeline
    reads are cached for the run, since the agent revisits the same session."""

    def __init__(self, session_id: str | None = None, days: int = 30):
        self.session_id = session_id
        self.days = days
        self._items: dict[str, list[dict[str, Any]]] = {}
        self.seen_ids: set[int] = set()

    # -- plumbing ---------------------------------------------------------

    def _sid(self, args: dict[str, Any]) -> str:
        sid = str(args.get("session_id") or self.session_id or "").strip()
        if not sid:
            raise ToolError("session_id is required")
        if sid not in self._items and not db.session_exists(sid):
            raise ToolError(f"unknown session {sid}")
        return sid

    def items(self, sid: str) -> list[dict[str, Any]]:
        if sid not in self._items:
            self._items[sid] = session_read.build_timeline_items(sid)
            self.seen_ids.update(int(i["id"]) for i in self._items[sid] if i.get("id") is not None)
        return self._items[sid]

    def turns(self, sid: str) -> list[list[dict[str, Any]]]:
        """Items split at each user prompt; turn 0 is anything before the first."""
        out: list[list[dict[str, Any]]] = [[]]
        for item in self.items(sid):
            if item.get("category") == "prompt":
                out.append([])
            out[-1].append(item)
        return out

    def _row(self, item: dict[str, Any]) -> str:
        cat = item.get("category") or "other"
        bits = [f"#{item.get('id')}", cat]
        if _failed(item):
            bits.append("FAILED")
        if cat in ("prompt", "response", "thought", "question", "plan"):
            text = item.get("detail") if isinstance(item.get("detail"), str) else item.get("title")
            limit = PROMPT_CHARS if cat == "prompt" else EXCERPT_CHARS
            bits.append(_short(_mask(text), limit))
        else:
            bits.append(_short(_mask(item.get("target") or item.get("title") or item.get("tool")), 160))
            if cat == "file_edit":
                bits.append(f"({len(_detail_text(item.get('detail')))} chars)")
        dur = item.get("duration_ms")
        if dur and dur >= 1000:
            bits.append(f"{dur / 1000:.0f}s")
        return " ".join(str(b) for b in bits if b)

    def _turn_rows(self, turn: list[dict[str, Any]]) -> list[str]:
        """One line per step. A long turn keeps every failure, prompt and reply
        (where the story is) and fills the rest from its start and end, with
        the gaps marked so the agent knows to narrow in."""
        if len(turn) <= TURN_ROW_LIMIT:
            return [self._row(i) for i in turn]
        keep = {n for n, i in enumerate(turn) if _failed(i) or i.get("category") in ("prompt", "response", "question")}
        budget = max(0, TURN_ROW_LIMIT - len(keep))
        edge = list(range(budget // 2)) + list(range(len(turn) - budget // 2, len(turn)))
        keep |= set(edge)
        # Fill short gaps: a marker for one or two hidden steps costs as much as the steps.
        ordered = sorted(keep)
        for a, b in zip(ordered, ordered[1:]):
            if 1 < b - a <= 3:
                keep.update(range(a + 1, b))
        rows: list[str] = []
        gap = 0
        for n, item in enumerate(turn):
            if n in keep:
                if gap:
                    rows.append(f"… {gap} steps (use search or get_step) …")
                    gap = 0
                rows.append(self._row(item))
            else:
                gap += 1
        if gap:
            rows.append(f"… {gap} steps …")
        return rows

    # -- tools --------------------------------------------------------------

    def overview(self, args: dict[str, Any]) -> dict[str, Any]:
        sid = self._sid(args)
        turns = self.turns(sid)
        counts: dict[str, int] = {}
        failures = 0
        for item in self.items(sid):
            counts[item.get("category") or "other"] = counts.get(item.get("category") or "other", 0) + 1
            failures += _failed(item)
        rows = []
        for n, turn in enumerate(turns):
            if not turn:
                continue
            prompt = next((i for i in turn if i.get("category") == "prompt"), None)
            tools = sum(1 for i in turn if i.get("category") in _TOOL_CATEGORIES)
            rows.append({
                "turn": n,
                "prompt_event": prompt.get("id") if prompt else None,
                "prompt": _short(_mask(prompt.get("detail") if prompt else "(before first prompt)"), 220),
                "steps": len(turn),
                "tool_calls": tools,
                "failed": sum(1 for i in turn if _failed(i)),
                "edits": sum(1 for i in turn if i.get("category") == "file_edit"),
                "started": turn[0].get("start_ts") if turn else None,
            })
        if len(rows) > OVERVIEW_TURN_LIMIT:
            keep = OVERVIEW_TURN_LIMIT // 2
            rows = rows[:keep] + [{"note": f"{len(rows) - 2 * keep} turns omitted; use get_turns"}] + rows[-keep:]
        return {
            "session": session_summary(sid),
            "turn_count": len(turns) - 1,
            "counts_by_category": dict(sorted(counts.items(), key=lambda kv: -kv[1])),
            "failed_steps": failures,
            "turns": rows,
        }

    def get_turns(self, args: dict[str, Any]) -> dict[str, Any]:
        sid = self._sid(args)
        turns = self.turns(sid)
        start = max(0, int(args.get("start") or 0))
        end = min(len(turns) - 1, int(args.get("end") if args.get("end") is not None else start))
        if end - start > 5:
            end = start + 5
        out = []
        for n in range(start, end + 1):
            out.append({"turn": n, "steps": self._turn_rows(turns[n])})
        return {"session_id": sid, "turns": out, "turn_count": len(turns) - 1}

    def get_step(self, args: dict[str, Any]) -> dict[str, Any]:
        try:
            event_id = int(args.get("event_id"))
        except (TypeError, ValueError):
            raise ToolError("event_id must be a number") from None
        sids = [self.session_id] if self.session_id else []
        sids += [s for s in self._items if s not in sids]
        owner = db.event_session_id(event_id)
        if owner and owner not in sids:
            sids.append(owner)
        for sid in sids:
            for item in self.items(sid):
                if item.get("id") == event_id or item.get("end_id") == event_id:
                    text = _mask(_detail_text(item.get("detail")))
                    return {
                        "event_id": item.get("id"),
                        "session_id": sid,
                        "category": item.get("category"),
                        "tool": item.get("tool"),
                        "target": _short(_mask(item.get("target")), 400),
                        "status": item.get("status"),
                        "duration_ms": item.get("duration_ms"),
                        "ts": item.get("start_ts"),
                        "detail": _head_tail(text, STEP_DETAIL_CHARS),
                    }
        raise ToolError(f"event {event_id} not found")

    def search(self, args: dict[str, Any]) -> dict[str, Any]:
        query = str(args.get("query") or "").strip()
        if len(query) < 2:
            raise ToolError("query must be at least 2 characters")
        sid = args.get("session_id") or self.session_id
        hits = db.search(query, min(int(args.get("limit") or 15), 30), session_id=sid)
        for h in hits:
            if h.get("event_id") is not None:
                self.seen_ids.add(int(h["event_id"]))
        return {"results": [
            {
                "session_id": h.get("session_id"),
                "event_id": h.get("event_id"),
                "category": h.get("category"),
                "target": _short(_mask(h.get("target")), 160),
                "snippet": _short(_mask(h.get("snippet") or h.get("title")), 240),
            }
            for h in hits
        ]}

    def findings(self, args: dict[str, Any]) -> dict[str, Any]:
        sid = args.get("session_id") or self.session_id
        if sid:
            data = insights.compute_insights(session_id=self._sid({"session_id": sid}))
        else:
            data = insights.compute_insights_shared(int(args.get("days") or self.days))
        out = []
        for f in (data.get("findings") or [])[:30]:
            ev = [e.get("event_id") for e in f.get("evidence") or [] if e.get("event_id") is not None]
            self.seen_ids.update(int(e) for e in ev)
            out.append({
                "rule": f.get("id"),
                "pillar": f.get("pillar"),
                "severity": f.get("severity"),
                "title": _mask(f.get("title")),
                "detail": _short(_mask(f.get("detail")), 400),
                "recommendation": _short(_mask(f.get("recommendation")), 300),
                "evidence_event_ids": ev[:8],
            })
        return {"findings": out}

    def cost(self, args: dict[str, Any]) -> dict[str, Any]:
        sid = self._sid(args)
        data = context_cost.session_cost(sid)
        if data is None:
            raise ToolError(f"unknown session {sid}")
        for e in data.get("heaviest_events") or []:
            self.seen_ids.add(int(e["event_id"]))
            e["target"] = _mask(e.get("target"))
            e["title"] = _mask(e.get("title"))
        return data

    def baseline(self, args: dict[str, Any]) -> dict[str, Any]:
        """This session against the median of the person's own recent sessions:
        what is unusual for *them*, not for some global average."""
        sid = self._sid(args)
        me = session_summary(sid)
        since = _since(self.days)
        rows, _ = db.list_sessions_page(300, since=since)
        peers = [r for r in rows if r.get("id") != sid and (r.get("event_count") or 0) > 5]

        def med(key: Callable[[dict[str, Any]], Any]) -> float | None:
            vals = [v for v in (key(r) for r in peers) if isinstance(v, (int, float))]
            return round(statistics.median(vals), 2) if vals else None

        metrics = {
            "duration_seconds": (lambda r: r.get("duration_seconds")),
            "events": (lambda r: r.get("event_count")),
            "tool_calls": (lambda r: r.get("tool_count")),
            "tokens": (lambda r: (r.get("tokens") or {}).get("total")),
            "cost_usd": (lambda r: r.get("cost_usd") if r.get("has_cost") else None),
        }
        return {
            "compared_with": f"{len(peers)} of the person's sessions in the last {self.days} days",
            "this_session": {k: (me or {}).get(k) for k in metrics},
            "their_median": {k: med(f) for k, f in metrics.items()},
        }

    def list_sessions(self, args: dict[str, Any]) -> dict[str, Any]:
        days = int(args.get("days") or self.days)
        since = _since(days)
        rows, total = db.list_sessions_page(
            min(int(args.get("limit") or 30), 60), since=since, project=args.get("project") or None,
            sort=str(args.get("sort") or "recent"),
        )
        return {"total": total, "sessions": [
            {
                "id": r.get("id"),
                "title": _short(_mask(r.get("title")), 120),
                "agent": r.get("source"),
                "project": (r.get("cwd") or "").rstrip("/").split("/")[-1] or None,
                "started_at": r.get("started_at"),
                "duration_seconds": r.get("duration_seconds"),
                "tool_calls": r.get("tool_count"),
                "cost_usd": r.get("cost_usd") if r.get("has_cost") else None,
            }
            for r in rows
        ]}

    def past_analyses(self, args: dict[str, Any]) -> dict[str, Any]:
        """Findings from earlier saved runs: the raw material of a
        cross-session report, so it doesn't re-read every session."""
        runs = db.list_analysis_runs(limit=int(args.get("limit") or 40), days=int(args.get("days") or self.days))
        out = []
        for r in runs:
            report = r.get("report") or {}
            if r.get("status") != "ok" or r.get("scope") != "session":
                continue
            out.append({
                "run_id": r["id"], "session_id": r.get("session_id"), "persona": r.get("persona"),
                "created_at": r.get("created_at"),
                "findings": [
                    {"severity": f.get("severity"), "title": f.get("title"), "evidence": f.get("evidence")}
                    for f in report.get("findings") or []
                ],
            })
        return {"runs": out}


_SID = {"type": "string", "description": "Session id. Defaults to the session under analysis."}

# name -> (method, description, JSON schema properties, required, cross-session only)
TOOL_SPECS: dict[str, tuple[str, str, dict[str, Any], list[str]]] = {
    "get_overview": ("overview", "A session's summary and one line per turn (the user's prompt, steps, tool calls, failures, edits). Start here for any session other than the one already given.", {"session_id": _SID}, []),
    "get_turns": ("get_turns", "Every step in turns start..end (at most 6 turns per call): event id, category, target or text excerpt, FAILED marker, duration.", {"session_id": _SID, "start": {"type": "integer"}, "end": {"type": "integer"}}, ["start"]),
    "get_step": ("get_step", "The full (secret-masked, size-capped) detail of one step: a command and its output, a diff, an MCP call, a full reply.", {"event_id": {"type": "integer"}}, ["event_id"]),
    "search": ("search", "Full-text search in a session (or every session when session_id is empty in a cross-session run). Returns event ids with snippets.", {"query": {"type": "string"}, "session_id": _SID, "limit": {"type": "integer"}}, ["query"]),
    "get_findings": ("findings", "cot's rule-based findings (retry loops, risky commands, secrets, cost waste…) for a session, or across all sessions when no session applies.", {"session_id": _SID, "days": {"type": "integer"}}, []),
    "get_cost": ("cost", "Where a session's tokens and dollars went: per model, the heaviest events, cache share, and the fixed preamble (memory files, skills, MCP definitions) each request carried.", {"session_id": _SID}, []),
    "compare_to_baseline": ("baseline", "This session's duration, events, tool calls, tokens and cost next to the median of the person's own recent sessions.", {"session_id": _SID}, []),
    "list_sessions": ("list_sessions", "Recent sessions with title, agent, project, duration, tool calls and cost. sort: recent | events | duration | cost.", {"days": {"type": "integer"}, "project": {"type": "string"}, "sort": {"type": "string"}, "limit": {"type": "integer"}}, []),
    "get_past_analyses": ("past_analyses", "Findings from earlier saved per-session Analysis runs in the window.", {"days": {"type": "integer"}, "limit": {"type": "integer"}}, []),
}

SESSION_TOOLS = ("get_overview", "get_turns", "get_step", "search", "get_findings", "get_cost", "compare_to_baseline")
ACROSS_TOOLS = (*SESSION_TOOLS, "list_sessions", "get_past_analyses")


def tool_names(scope: str) -> tuple[str, ...]:
    return ACROSS_TOOLS if scope == "across" else SESSION_TOOLS


def call(box: Toolbox, name: str, args: dict[str, Any]) -> dict[str, Any]:
    spec = TOOL_SPECS.get(name)
    if spec is None:
        raise ToolError(f"unknown tool {name}")
    return getattr(box, spec[0])(args if isinstance(args, dict) else {})


def json_schemas(names: tuple[str, ...]) -> list[dict[str, Any]]:
    """Provider-neutral tool definitions: name, description, JSON schema."""
    return [
        {
            "name": n,
            "description": TOOL_SPECS[n][1],
            "schema": {"type": "object", "properties": TOOL_SPECS[n][2], "required": TOOL_SPECS[n][3]},
        }
        for n in names
    ]
