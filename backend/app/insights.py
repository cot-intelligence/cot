"""Rule-based actionable insights over collected traces.

Turns raw events into findings with a concrete recommendation, along three
pillars: usability, cost, security. Everything runs locally over SQLite —
findings (matched paths, commands, URLs) must NEVER be included in the
opt-in telemetry payload.

Copy tone: security findings are review prompts, not verdicts — "Review",
never "Breached". False positives are expected and cheap to dismiss.

## Adding a new rule
1. Write a function taking a ``RuleContext`` and returning ``list[dict]``
   (use ``_finding(...)`` to build each dict).
2. Decorate it with ``@rule(id="pillar.name", pillar=..., tier=...,
   aggregate_only=...)``.
3. Put its thresholds in ``CONSTANTS[rule_id]``.
4. Add a fires / doesn't-fire test pair in ``backend/tests/test_insights.py``.

The finding's ``subject`` must be the stable entity the finding is about
(command string, path, cwd, session id) — it drives the lifecycle
fingerprint, so re-detections refresh the same finding instead of creating
duplicates.

## Lifecycle
Aggregate findings persist in the ``insight_findings`` table keyed by
``sha1(rule_id|subject)``. On every aggregate compute we reconcile:
re-detected findings refresh ``last_seen`` (reopening resolved ones);
active findings that stop firing for ``resolve_grace_days`` auto-resolve —
which is also how "the user implemented the recommendation" manifests
(scripted commands, allowlisted permissions, rotated secrets simply stop
matching). Dismissal is manual, sticky per fingerprint, and survives
re-detection. Per-session findings are ephemeral and never persisted.

## Future: LLM insights (not implemented)
A second layer could send the rule-based findings plus windowed aggregates
(never raw traces) to Claude for narrative synthesis: recurring failure
causes extracted from error text, root-cause explanations of retry loops,
prompt-quality coaching, semantic secret/risk detection beyond the regex
prefixes below, and a prioritized weekly digest. Requirements: optional
``anthropic`` SDK behind ``try: import`` (feature hidden unless
configured), key via ``COT_ANTHROPIC_API_KEY`` env var (the settings table
is plaintext SQLite), an explicit ``POST /v1/insights/analyze`` action —
it costs money, so never poll — caching the last analysis, secret masking
applied before anything leaves the machine, and a hard off switch
``COT_DISABLE_LLM=1`` mirroring the telemetry conventions.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from . import db
from .pricing import cost_for, normalize_model

PILLARS = ("usability", "cost", "security")
SEVERITIES = ("info", "warn", "critical")
STATUSES = ("active", "resolved", "dismissed")

_SEVERITY_RANK = {"critical": 0, "warn": 1, "info": 2}

# All tunable thresholds, keyed by rule id (settings-table overrides = v2).
CONSTANTS: dict[str, dict[str, Any]] = {
    "usability.automate_command": {"min_repeats": 5, "min_len": 10},
    "usability.retry_loops": {"warn_run": 3, "critical_run": 5},
    "usability.permission_friction": {"min_events": 5, "ratio": 0.10},
    "usability.slow_commands": {"min_ms": 30_000, "min_occurrences": 2},
    "usability.reread_churn": {"min_reads": 5},
    "cost.expensive_project": {
        "project_share": 0.4,
        "session_multiple": 2.0,
        "min_total_usd": 0.5,
        "min_session_usd": 1.0,
    },
    "cost.unpriced_tokens": {"min_tokens": 50_000, "warn_tokens": 1_000_000},
    "cost.cache_write_waste": {"min_cache_write": 100_000, "max_ratio": 0.3},
    "cost.model_mismatch": {"opus_share": 0.6, "min_total_usd": 1.0, "median_tool_calls": 15},
    "cost.trend_anomaly": {"multiple": 2.0, "min_usd": 1.0},
    "security.read_then_exfil": {"window_seconds": 300},
    "security.repeat_blocked": {"min_repeats": 2},
    "lifecycle": {"resolve_grace_days": 3},
}

_EVIDENCE_CAP = 8

# Human label for each rule type, used to collapse many findings of the same
# rule into one group in the UI. Keyed by rule id.
GROUP_TITLES: dict[str, str] = {
    "usability.automate_command": "Repeated commands you could automate",
    "usability.retry_loops": "Tools stuck in retry loops",
    "usability.permission_friction": "Permission-prompt friction",
    "usability.stalled_clarifications": "Unanswered questions at session end",
    "usability.slow_commands": "Slow commands",
    "usability.reread_churn": "Files re-read repeatedly",
    "cost.expensive_project": "Expensive projects & sessions",
    "cost.unpriced_tokens": "Unpriced model usage",
    "cost.cache_write_waste": "Cache written but not reused",
    "cost.model_mismatch": "Model choice vs. workload",
    "cost.trend_anomaly": "Spend trend spikes",
    "security.risky_commands": "Risky shell commands",
    "security.sensitive_files": "Sensitive files accessed",
    "security.secrets_exposure": "Possible secrets in traces",
    "security.read_then_exfil": "Read-then-send sequences",
    "security.out_of_cwd_edits": "Edits outside the project",
    "security.repeat_blocked": "Retried blocked actions",
}


@dataclass
class RuleContext:
    conn: Any
    cutoff: str | None  # ISO timestamp lower bound; None = no window
    session_id: str | None  # set = per-session mode


@dataclass
class RuleMeta:
    id: str
    pillar: str
    tier: int
    aggregate_only: bool
    fn: Callable[[RuleContext], list[dict[str, Any]]]


RULES: dict[str, RuleMeta] = {}


def rule(*, id: str, pillar: str, tier: int, aggregate_only: bool = False):
    def wrap(fn: Callable[[RuleContext], list[dict[str, Any]]]):
        RULES[id] = RuleMeta(id=id, pillar=pillar, tier=tier, aggregate_only=aggregate_only, fn=fn)
        return fn

    return wrap


def _fingerprint(rule_id: str, subject: str) -> str:
    return hashlib.sha1(f"{rule_id}|{subject}".encode("utf-8")).hexdigest()


def _finding(
    meta_id: str,
    subject: str,
    severity: str,
    title: str,
    detail: str,
    recommendation: str,
    *,
    metric: dict[str, Any] | None = None,
    evidence: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    m = RULES[meta_id]
    return {
        "id": meta_id,
        "fingerprint": _fingerprint(meta_id, subject),
        "group_title": GROUP_TITLES.get(meta_id, m.pillar),
        "pillar": m.pillar,
        "tier": m.tier,
        "severity": severity,
        "title": title,
        "detail": detail,
        "recommendation": recommendation,
        "metric": metric,
        "evidence": (evidence or [])[:_EVIDENCE_CAP],
    }


def _ev(row: Any, label: str, value: str | None = None) -> dict[str, Any]:
    return {
        "session_id": row["session_id"],
        "event_id": row["id"] if "id" in row.keys() else None,
        "label": label[:200],
        "value": value,
        "ts": row["ts"] if "ts" in row.keys() else None,
    }


def _scope(ctx: RuleContext, extra: str = "") -> tuple[str, list[Any]]:
    """Shared FROM/WHERE for event queries honoring window + session mode."""
    sql = " FROM events e JOIN sessions s ON s.id = e.session_id WHERE s.archived = 0"
    params: list[Any] = []
    if ctx.cutoff:
        sql += " AND e.ts >= ?"
        params.append(ctx.cutoff)
    if ctx.session_id:
        sql += " AND e.session_id = ?"
        params.append(ctx.session_id)
    return sql + extra, params


def _fmt_usd(v: float) -> str:
    return f"${v:.2f}"


# --- usability ----------------------------------------------------------------


@rule(id="usability.automate_command", pillar="usability", tier=1, aggregate_only=True)
def _automate_command(ctx: RuleContext) -> list[dict[str, Any]]:
    c = CONSTANTS["usability.automate_command"]
    scope, params = _scope(ctx, " AND e.category = 'shell' AND e.target IS NOT NULL")
    rows = ctx.conn.execute(
        "SELECT e.target t, COUNT(*) n, COUNT(DISTINCT e.session_id) s,"
        " MAX(e.id) id, MAX(e.session_id) session_id, MAX(e.ts) ts"
        + scope
        + " GROUP BY e.target HAVING n >= ? ORDER BY n DESC LIMIT 20",
        params + [c["min_repeats"]],
    ).fetchall()
    out = []
    for r in rows:
        cmd = (r["t"] or "").strip()
        if len(cmd) < c["min_len"]:
            continue
        out.append(
            _finding(
                "usability.automate_command",
                cmd,
                "info",
                f"Ran the same command {r['n']} times",
                f"`{cmd[:120]}` was executed {r['n']} times across {r['s']} session(s).",
                "Wrap it in a Makefile/Justfile target, script, or agent rule so it runs in one step.",
                metric={"value": r["n"], "unit": "runs", "label": "repetitions"},
                evidence=[_ev(r, cmd, f"{r['n']} runs")],
            )
        )
    return out


@rule(id="usability.retry_loops", pillar="usability", tier=1)
def _retry_loops(ctx: RuleContext) -> list[dict[str, Any]]:
    c = CONSTANTS["usability.retry_loops"]
    scope, params = _scope(
        ctx, " AND e.tool IS NOT NULL AND e.target IS NOT NULL AND e.status IS NOT NULL"
    )
    rows = ctx.conn.execute(
        "SELECT e.id, e.session_id, e.tool, e.target, e.ts, e.status"
        + scope
        + " ORDER BY e.session_id, e.ts, e.id",
        params,
    ).fetchall()
    runs: dict[tuple[str, str, str], list[Any]] = {}
    best: dict[tuple[str, str, str], list[Any]] = {}
    for r in rows:
        key = (r["session_id"], r["tool"], r["target"])
        if r["status"] == "error":
            runs.setdefault(key, []).append(r)
            if len(runs[key]) > len(best.get(key, [])):
                best[key] = list(runs[key])
        else:
            runs.pop(key, None)
    out = []
    for (session_id, tool, target), streak in best.items():
        n = len(streak)
        if n < c["warn_run"]:
            continue
        severity = "critical" if n >= c["critical_run"] else "warn"
        out.append(
            _finding(
                "usability.retry_loops",
                f"{tool}|{target}",
                severity,
                f"{tool} failed {n} times in a row on the same target",
                f"`{target[:120]}` errored {n} consecutive times in session {session_id[:8]}.",
                "The agent is stuck in a retry loop — fix the underlying command or integration, "
                "and document the workaround in your project rules.",
                metric={"value": n, "unit": "errors", "label": "consecutive failures"},
                evidence=[_ev(r, target, r["status"]) for r in streak],
            )
        )
    return out


@rule(id="usability.permission_friction", pillar="usability", tier=1)
def _permission_friction(ctx: RuleContext) -> list[dict[str, Any]]:
    c = CONSTANTS["usability.permission_friction"]
    scope, params = _scope(ctx)
    tool_calls = ctx.conn.execute(
        "SELECT COUNT(*) n" + scope + " AND e.tool IS NOT NULL AND e.status IS NOT NULL", params
    ).fetchone()["n"]
    perm_scope, perm_params = _scope(ctx, " AND e.category = 'permission'")
    perms = ctx.conn.execute("SELECT COUNT(*) n" + perm_scope, perm_params).fetchone()["n"]
    out = []
    if perms >= c["min_events"] and tool_calls and perms / tool_calls > c["ratio"]:
        rows = ctx.conn.execute(
            "SELECT e.id, e.session_id, e.ts, e.tool, e.title, COUNT(*) n"
            + perm_scope
            + " GROUP BY COALESCE(e.tool, e.title) ORDER BY n DESC LIMIT 8",
            perm_params,
        ).fetchall()
        ratio = perms / tool_calls
        out.append(
            _finding(
                "usability.permission_friction",
                "overall",
                "warn",
                f"{perms} permission prompts ({ratio:.0%} of tool calls)",
                f"The agent asked for permission {perms} times against {tool_calls} tool calls.",
                "Pre-approve the tools and paths you always allow (agent settings allowlist) "
                "to stop breaking flow.",
                metric={"value": round(ratio, 3), "unit": "ratio", "label": "permission rate"},
                evidence=[_ev(r, r["tool"] or r["title"] or "permission", f"{r['n']}x") for r in rows],
            )
        )
    return out


@rule(id="usability.stalled_clarifications", pillar="usability", tier=1)
def _stalled_clarifications(ctx: RuleContext) -> list[dict[str, Any]]:
    # AskUserQuestion-style tools; Claude-only signal today (noted, acceptable).
    q_tools = ",".join("?" for _ in db._QUESTION_TOOLS)
    scope, params = _scope(ctx, f" AND e.tool IN ({q_tools})")
    rows = ctx.conn.execute(
        "SELECT e.id, e.session_id, e.ts, e.detail, e.tool, e.hook"
        + scope
        + " ORDER BY e.session_id, e.ts, e.id",
        params + list(db._QUESTION_TOOLS),
    ).fetchall()
    by_session: dict[str, list[Any]] = {}
    for r in rows:
        by_session.setdefault(r["session_id"], []).append(r)
    out = []
    for session_id, ev_rows in by_session.items():
        last = ctx.conn.execute(
            "SELECT MAX(ts) t FROM events WHERE session_id = ?", (session_id,)
        ).fetchone()["t"]
        if db._live_status(last) == "active":
            continue  # user may still answer a running session
        clars, _ = db._build_clarifications(ev_rows)
        open_qs = [q for q in clars if not q["answered"]]
        if not open_qs:
            continue
        first = open_qs[0]
        out.append(
            _finding(
                "usability.stalled_clarifications",
                session_id,
                "warn",
                f"Session ended with {len(open_qs)} unanswered question(s)",
                f'The agent asked "{first["question_excerpt"]}" and never got an answer — '
                "the work stopped there.",
                "Resume the session and answer, or add defaults to your rules so the agent "
                "asks less often.",
                evidence=[
                    {
                        "session_id": session_id,
                        "event_id": q["question_event_id"],
                        "label": q["question_excerpt"][:200],
                        "value": "unanswered",
                        "ts": q["question_ts"],
                    }
                    for q in open_qs
                ],
            )
        )
    return out


@rule(id="usability.slow_commands", pillar="usability", tier=2)
def _slow_commands(ctx: RuleContext) -> list[dict[str, Any]]:
    c = CONSTANTS["usability.slow_commands"]
    scope, params = _scope(
        ctx, " AND e.category = 'shell' AND e.target IS NOT NULL AND e.duration_ms >= ?"
    )
    rows = ctx.conn.execute(
        "SELECT e.target t, COUNT(*) n, MAX(e.duration_ms) mx,"
        " MAX(e.id) id, MAX(e.session_id) session_id, MAX(e.ts) ts"
        + scope
        + " GROUP BY e.target HAVING n >= ? ORDER BY mx DESC LIMIT 10",
        params + [c["min_ms"], c["min_occurrences"]],
    ).fetchall()
    out = []
    for r in rows:
        secs = (r["mx"] or 0) / 1000
        out.append(
            _finding(
                "usability.slow_commands",
                r["t"],
                "info",
                f"Slow command: {secs:.0f}s, ran {r['n']} times",
                f"`{r['t'][:120]}` repeatedly takes long (worst {secs:.0f}s).",
                "Narrow it (smaller test target, tighter grep) or tell the agent to skip it "
                "via rules — wall-clock time compounds.",
                metric={"value": round(secs, 1), "unit": "s", "label": "worst duration"},
                evidence=[_ev(r, r["t"], f"{secs:.0f}s")],
            )
        )
    return out


@rule(id="usability.reread_churn", pillar="usability", tier=2)
def _reread_churn(ctx: RuleContext) -> list[dict[str, Any]]:
    c = CONSTANTS["usability.reread_churn"]
    scope, params = _scope(
        ctx, " AND e.category IN ('file_read','context_read') AND e.target IS NOT NULL"
    )
    rows = ctx.conn.execute(
        "SELECT e.target t, e.session_id, COUNT(*) n, MAX(e.id) id, MAX(e.ts) ts"
        + scope
        + " GROUP BY e.session_id, e.target HAVING n >= ? ORDER BY n DESC LIMIT 10",
        params + [c["min_reads"]],
    ).fetchall()
    out = []
    for r in rows:
        out.append(
            _finding(
                "usability.reread_churn",
                r["t"],
                "info",
                f"Same file read {r['n']} times in one session",
                f"`{r['t']}` was re-read {r['n']} times in session {r['session_id'][:8]} — "
                "the agent keeps re-exploring.",
                "Add architecture pointers to CLAUDE.md/rules or pin the file as context up "
                "front to cut the exploration tax.",
                metric={"value": r["n"], "unit": "reads", "label": "re-reads"},
                evidence=[_ev(r, r["t"], f"{r['n']} reads")],
            )
        )
    return out


# --- cost ---------------------------------------------------------------------


def _session_costs(ctx: RuleContext) -> tuple[dict[str, float], dict[str, str | None]]:
    """Per-session USD cost and session→cwd map, priced per model like metrics()."""
    scope, params = _scope(ctx, " AND e.model IS NOT NULL AND e.model != ''")
    rows = ctx.conn.execute(
        "SELECT e.session_id sid, s.cwd cwd, e.model m,"
        " COALESCE(SUM(e.input_tokens),0) i, COALESCE(SUM(e.output_tokens),0) o,"
        " COALESCE(SUM(e.cache_read_tokens),0) cr, COALESCE(SUM(e.cache_write_tokens),0) cw"
        + scope
        + " GROUP BY e.session_id, e.model",
        params,
    ).fetchall()
    costs: dict[str, float] = {}
    cwds: dict[str, str | None] = {}
    for r in rows:
        cwds[r["sid"]] = r["cwd"]
        c = cost_for(r["m"], r["i"], r["o"], r["cr"], r["cw"])
        if c:
            costs[r["sid"]] = costs.get(r["sid"], 0.0) + c
    return costs, cwds


@rule(id="cost.expensive_project", pillar="cost", tier=1, aggregate_only=True)
def _expensive_project(ctx: RuleContext) -> list[dict[str, Any]]:
    c = CONSTANTS["cost.expensive_project"]
    costs, cwds = _session_costs(ctx)
    total = sum(costs.values())
    if total < c["min_total_usd"]:
        return []
    out = []
    by_cwd: dict[str, float] = {}
    for sid, usd in costs.items():
        cwd = cwds.get(sid) or "(unknown)"
        by_cwd[cwd] = by_cwd.get(cwd, 0.0) + usd
    if len(by_cwd) >= 2:
        top_cwd, top_usd = max(by_cwd.items(), key=lambda kv: kv[1])
        share = top_usd / total
        if share > c["project_share"]:
            out.append(
                _finding(
                    "cost.expensive_project",
                    top_cwd,
                    "info",
                    f"{top_cwd.rsplit('/', 1)[-1]} is {share:.0%} of your spend",
                    f"{_fmt_usd(top_usd)} of {_fmt_usd(total)} in this window went to {top_cwd}.",
                    "Consider a cheaper model for routine sessions in this repo, tighter "
                    "context via rules, or splitting large tasks.",
                    metric={"value": round(share, 3), "unit": "ratio", "label": "share of spend"},
                )
            )
    vals = sorted(costs.values())
    if vals:
        median = vals[len(vals) // 2]
        for sid, usd in sorted(costs.items(), key=lambda kv: -kv[1])[:5]:
            if usd >= max(c["min_session_usd"], median * c["session_multiple"]):
                out.append(
                    _finding(
                        "cost.expensive_project",
                        sid,
                        "warn",
                        f"Session cost {_fmt_usd(usd)} — {usd / median:.1f}x your median",
                        f"Session {sid[:8]} cost {_fmt_usd(usd)} vs a median of {_fmt_usd(median)}.",
                        "Review what ran here — long sessions accumulate context; splitting "
                        "the task or starting fresh is usually cheaper.",
                        metric={"value": round(usd, 2), "unit": "USD", "label": "session cost"},
                        evidence=[
                            {"session_id": sid, "event_id": None, "label": "open session",
                             "value": _fmt_usd(usd), "ts": None}
                        ],
                    )
                )
    return out


@rule(id="cost.unpriced_tokens", pillar="cost", tier=1)
def _unpriced_tokens(ctx: RuleContext) -> list[dict[str, Any]]:
    c = CONSTANTS["cost.unpriced_tokens"]
    scope, params = _scope(ctx, " AND e.model IS NOT NULL AND e.model != ''")
    rows = ctx.conn.execute(
        "SELECT e.model m,"
        " COALESCE(SUM(e.input_tokens),0) + COALESCE(SUM(e.output_tokens),0)"
        " + COALESCE(SUM(e.cache_read_tokens),0) + COALESCE(SUM(e.cache_write_tokens),0) t"
        + scope
        + " GROUP BY e.model",
        params,
    ).fetchall()
    unpriced: dict[str, int] = {}
    for r in rows:
        if cost_for(r["m"], 1, 1) is None:
            key = normalize_model(r["m"]) or r["m"]
            unpriced[key] = unpriced.get(key, 0) + (r["t"] or 0)
    out = []
    for model, tokens in unpriced.items():
        if tokens < c["min_tokens"]:
            continue
        severity = "warn" if tokens >= c["warn_tokens"] else "info"
        out.append(
            _finding(
                "cost.unpriced_tokens",
                model,
                severity,
                f"{tokens:,} tokens on '{model}' have no price",
                f"Cost for model '{model}' can't be computed, so every cost insight and "
                "metric silently undercounts.",
                "Add a rate for it in ~/.cot/pricing.overrides.json (or fix the model-id "
                "alias) so spend becomes visible.",
                metric={"value": tokens, "unit": "tokens", "label": "unpriced tokens"},
            )
        )
    return out


@rule(id="cost.cache_write_waste", pillar="cost", tier=1)
def _cache_write_waste(ctx: RuleContext) -> list[dict[str, Any]]:
    c = CONSTANTS["cost.cache_write_waste"]
    scope, params = _scope(ctx)
    tot = ctx.conn.execute(
        "SELECT COALESCE(SUM(e.cache_read_tokens),0) cr,"
        " COALESCE(SUM(e.cache_write_tokens),0) cw" + scope,
        params,
    ).fetchone()
    cw, cr = tot["cw"], tot["cr"]
    if cw < c["min_cache_write"]:
        return []
    ratio = cr / cw if cw else 0.0
    if ratio >= c["max_ratio"]:
        return []
    rows = ctx.conn.execute(
        "SELECT e.session_id, COALESCE(SUM(e.cache_write_tokens),0) cw,"
        " COALESCE(SUM(e.cache_read_tokens),0) cr, MAX(e.ts) ts"
        + scope
        + " GROUP BY e.session_id ORDER BY cw DESC LIMIT 5",
        params,
    ).fetchall()
    subject = ctx.session_id or "window"
    return [
        _finding(
            "cost.cache_write_waste",
            subject,
            "warn",
            f"Paying to write cache you rarely read ({ratio:.0%} read-back)",
            f"{cw:,} tokens were written to cache but only {cr:,} read back — "
            "context is being rebuilt instead of reused. (Cache data is "
            "Claude-only today.)",
            "Stay in one session for related edits and stop re-pasting files; cache pays "
            "off only when a session continues.",
            metric={"value": round(ratio, 3), "unit": "ratio", "label": "cache read/write"},
            evidence=[
                {"session_id": r["session_id"], "event_id": None,
                 "label": f"{r['cw']:,} written / {r['cr']:,} read", "value": None, "ts": r["ts"]}
                for r in rows
            ],
        )
    ]


@rule(id="cost.model_mismatch", pillar="cost", tier=2, aggregate_only=True)
def _model_mismatch(ctx: RuleContext) -> list[dict[str, Any]]:
    c = CONSTANTS["cost.model_mismatch"]
    scope, params = _scope(ctx, " AND e.model IS NOT NULL AND e.model != ''")
    rows = ctx.conn.execute(
        "SELECT e.model m, e.session_id sid,"
        " COALESCE(SUM(e.input_tokens),0) i, COALESCE(SUM(e.output_tokens),0) o,"
        " COALESCE(SUM(e.cache_read_tokens),0) cr, COALESCE(SUM(e.cache_write_tokens),0) cw"
        + scope
        + " GROUP BY e.model, e.session_id",
        params,
    ).fetchall()
    total = 0.0
    opus_cost = 0.0
    opus_sessions: set[str] = set()
    for r in rows:
        usd = cost_for(r["m"], r["i"], r["o"], r["cr"], r["cw"]) or 0.0
        total += usd
        norm = normalize_model(r["m"]) or ""
        if "opus" in norm or "fable" in norm or "mythos" in norm:
            opus_cost += usd
            opus_sessions.add(r["sid"])
    if total < c["min_total_usd"] or not opus_sessions:
        return []
    share = opus_cost / total
    if share <= c["opus_share"]:
        return []
    marks = ",".join("?" for _ in opus_sessions)
    calls = ctx.conn.execute(
        f"SELECT session_id, COUNT(*) n FROM events WHERE session_id IN ({marks})"
        " AND tool IS NOT NULL AND status IS NOT NULL GROUP BY session_id",
        list(opus_sessions),
    ).fetchall()
    counts = sorted(r["n"] for r in calls) or [0]
    median_calls = counts[len(counts) // 2]
    if median_calls >= c["median_tool_calls"]:
        return []  # heavy sessions genuinely need the big model
    return [
        _finding(
            "cost.model_mismatch",
            "opus-share",
            "info",
            f"Top-tier models are {share:.0%} of spend on light sessions",
            f"{_fmt_usd(opus_cost)} of {_fmt_usd(total)} went to top-tier models, but the "
            f"median such session ran only {median_calls} tool calls.",
            "Try a mid-tier model (e.g. Sonnet) for routine sessions and keep the "
            "expensive model for genuinely hard tasks.",
            metric={"value": round(share, 3), "unit": "ratio", "label": "top-tier share"},
        )
    ]


@rule(id="cost.trend_anomaly", pillar="cost", tier=2, aggregate_only=True)
def _trend_anomaly(ctx: RuleContext) -> list[dict[str, Any]]:
    c = CONSTANTS["cost.trend_anomaly"]
    now = datetime.now(timezone.utc)
    buckets = []
    for start_days, end_days in ((7, 0), (14, 7)):
        lo = (now - timedelta(days=start_days)).isoformat()
        hi = (now - timedelta(days=end_days)).isoformat()
        rows = ctx.conn.execute(
            "SELECT e.model m, COALESCE(SUM(e.input_tokens),0) i,"
            " COALESCE(SUM(e.output_tokens),0) o, COALESCE(SUM(e.cache_read_tokens),0) cr,"
            " COALESCE(SUM(e.cache_write_tokens),0) cw"
            " FROM events e JOIN sessions s ON s.id = e.session_id"
            " WHERE s.archived = 0 AND e.ts >= ? AND e.ts < ?"
            " AND e.model IS NOT NULL AND e.model != '' GROUP BY e.model",
            (lo, hi),
        ).fetchall()
        buckets.append(sum(cost_for(r["m"], r["i"], r["o"], r["cr"], r["cw"]) or 0.0 for r in rows))
    recent, prior = buckets
    if prior <= 0 or recent < prior * c["multiple"] or recent - prior < c["min_usd"]:
        return []
    return [
        _finding(
            "cost.trend_anomaly",
            "weekly-trend",
            "info",
            f"Spend jumped {recent / prior:.1f}x week-over-week",
            f"Last 7 days cost {_fmt_usd(recent)} vs {_fmt_usd(prior)} the week before.",
            "Check the Metrics page for which project/model drove the jump.",
            metric={"value": round(recent, 2), "unit": "USD", "label": "last 7 days"},
        )
    ]


# --- security -----------------------------------------------------------------

RISKY_COMMAND_PATTERNS: list[tuple[re.Pattern[str], str, str]] = [
    (re.compile(r"\b(?:curl|wget)\b[^|;&]*\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b"), "critical", "pipe-to-shell install"),
    (re.compile(r"\brm\s+(?:-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\s+(?:/|~/?|\$HOME)(?:\s|$)"), "critical", "recursive delete at root/home"),
    (re.compile(r"\bchmod\s+(?:-R\s+)?0?777\b"), "critical", "world-writable permissions"),
    (re.compile(r"\bbase64\s+(?:-d|--decode)\b[^|]*\|\s*(?:ba|z)?sh\b"), "critical", "decode-and-execute"),
    (re.compile(r"\bnc\b[^\n]*\s-e\s"), "critical", "netcat with command execution"),
    (re.compile(r"\beval\s+[\"']?\$\(\s*curl"), "critical", "eval of remote content"),
    (re.compile(r"(?:^|\s)sudo\s+"), "warn", "privilege escalation"),
    (re.compile(r"\bgit\s+push\b[^\n]*(?:\s--force\b|\s-f\b)"), "warn", "force push"),
    (re.compile(r"\b(?:pip3?|uv pip)\s+install\s+\S*git\+https?://|\bnpm\s+(?:install|i)\s+\S*(?:git\+|github:)"), "warn", "package install from raw git URL"),
]

SENSITIVE_PATH_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"(?:^|/)\.env(?:\.[\w.-]+)?$"), "info"),
    (re.compile(r"(?:^|/)\.ssh(?:/|$)"), "warn"),
    (re.compile(r"(?:^|/)\.aws(?:/|$)"), "warn"),
    (re.compile(r"(?:^|/)\.gnupg(?:/|$)"), "warn"),
    (re.compile(r"(?:^|/)id_(?:rsa|ed25519|ecdsa)(?:\.pub)?$"), "warn"),
    (re.compile(r"\.(?:pem|p12|pfx)$|(?<!\.lock)\.key$"), "warn"),
    (re.compile(r"(?:^|/)(?:credentials|\.netrc|\.npmrc|\.pypirc|\.git-credentials)$"), "warn"),
    (re.compile(r"(?:^|/)\.kube/config$"), "warn"),
    (re.compile(r"(?:^|/)(?:secrets?|credentials?)\.(?:json|ya?ml|toml)$"), "info"),
]
SENSITIVE_PATH_EXCLUDES = re.compile(r"\.(?:example|sample|template)$|(?:^|/)tests?/")

SECRET_PATTERNS: list[tuple[re.Pattern[str], str, str]] = [
    (re.compile(r"\bAKIA[0-9A-Z]{16}\b"), "critical", "AWS access key"),
    (re.compile(r"\bghp_[A-Za-z0-9]{36}\b"), "critical", "GitHub personal access token"),
    (re.compile(r"\bgithub_pat_[A-Za-z0-9_]{22,}\b"), "critical", "GitHub fine-grained PAT"),
    (re.compile(r"\bsk-ant-[A-Za-z0-9_-]{20,}\b"), "critical", "Anthropic API key"),
    (re.compile(r"\bsk-[A-Za-z0-9]{32,}\b"), "critical", "OpenAI-style API key"),
    (re.compile(r"\bxox[bapors]-[A-Za-z0-9-]{10,}\b"), "critical", "Slack token"),
    (re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b"), "critical", "Google API key"),
    (re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"), "critical", "private key material"),
    (re.compile(r"\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b"), "warn", "JWT"),
    (re.compile(r"\bpassword\s*=\s*['\"]?(?![\$\{<\*])[^\s'\"]{8,}"), "warn", "inline password"),
]

_EXFIL_TOOLS = re.compile(r"\b(?:curl|wget|scp|rsync|nc)\b")

# Paths agents legitimately edit outside the project (configs, temp, cot itself).
_OUT_OF_CWD_EXCLUDES = re.compile(
    r"/\.(?:claude|cursor|codex|config|cot|cache)(?:/|$)|^/(?:private/)?tmp(?:/|$)|^/var/folders/"
)


def mask_secret(text: str) -> str:
    """Show only the shape of a matched secret: first 4 + last 4 chars."""
    if len(text) <= 8:
        return "*" * len(text)
    return f"{text[:4]}{'*' * 6}{text[-4:]}"


def match_sensitive_path(path: str) -> str | None:
    """Return severity if the path looks sensitive, else None."""
    if SENSITIVE_PATH_EXCLUDES.search(path):
        return None
    for pat, severity in SENSITIVE_PATH_PATTERNS:
        if pat.search(path):
            return severity
    return None


def match_risky_command(command: str) -> tuple[str, str] | None:
    """Return (severity, label) for the highest-severity risky pattern hit."""
    hit: tuple[str, str] | None = None
    for pat, severity, label in RISKY_COMMAND_PATTERNS:
        if pat.search(command):
            if hit is None or _SEVERITY_RANK[severity] < _SEVERITY_RANK[hit[0]]:
                hit = (severity, label)
    return hit


@rule(id="security.risky_commands", pillar="security", tier=1)
def _risky_commands(ctx: RuleContext) -> list[dict[str, Any]]:
    scope, params = _scope(ctx, " AND e.category = 'shell' AND e.target IS NOT NULL")
    rows = ctx.conn.execute(
        "SELECT e.id, e.session_id, e.ts, e.target" + scope + " ORDER BY e.ts DESC LIMIT 5000",
        params,
    ).fetchall()
    by_label: dict[str, dict[str, Any]] = {}
    for r in rows:
        hit = match_risky_command(r["target"])
        if not hit:
            continue
        severity, label = hit
        g = by_label.setdefault(label, {"severity": severity, "rows": [], "commands": set()})
        if r["target"] not in g["commands"]:
            g["commands"].add(r["target"])
            g["rows"].append(r)
    out = []
    for label, g in by_label.items():
        n = len(g["commands"])
        out.append(
            _finding(
                "security.risky_commands",
                label,
                g["severity"],
                f"Review: {label} ({n} command{'s' if n > 1 else ''})",
                f"The agent ran {n} command(s) matching the '{label}' pattern.",
                "Review each before re-running; pin versions, avoid piping remote scripts "
                "to a shell, and add never-do rules for what you don't want repeated.",
                evidence=[_ev(r, r["target"]) for r in g["rows"]],
            )
        )
    return out


@rule(id="security.sensitive_files", pillar="security", tier=1)
def _sensitive_files(ctx: RuleContext) -> list[dict[str, Any]]:
    scope, params = _scope(
        ctx, " AND e.category IN ('file_read','file_edit') AND e.target IS NOT NULL"
    )
    rows = ctx.conn.execute(
        "SELECT e.id, e.session_id, e.ts, e.target, e.category"
        + scope
        + " ORDER BY e.ts DESC LIMIT 5000",
        params,
    ).fetchall()
    by_path: dict[str, dict[str, Any]] = {}
    for r in rows:
        severity = match_sensitive_path(r["target"])
        if severity is None:
            continue
        if r["category"] == "file_edit" and severity == "info":
            severity = "warn"  # writing to secret files is a step up from reading
        g = by_path.setdefault(r["target"], {"severity": severity, "rows": [], "edit": False})
        if _SEVERITY_RANK[severity] < _SEVERITY_RANK[g["severity"]]:
            g["severity"] = severity
        g["edit"] = g["edit"] or r["category"] == "file_edit"
        g["rows"].append(r)
    out = []
    for path, g in by_path.items():
        verb = "edited" if g["edit"] else "read"
        out.append(
            _finding(
                "security.sensitive_files",
                path,
                g["severity"],
                f"Review: agent {verb} a sensitive file",
                f"`{path}` was {verb} {len(g['rows'])} time(s). Its contents may have "
                "entered the model context.",
                "Confirm it was intentional; add a never-read rule for secret files, and "
                "rotate the credential if it entered a prompt.",
                evidence=[_ev(r, path, r["category"]) for r in g["rows"]],
            )
        )
    return out


@rule(id="security.secrets_exposure", pillar="security", tier=1)
def _secrets_exposure(ctx: RuleContext) -> list[dict[str, Any]]:
    scope, params = _scope(ctx, " AND e.category IN ('prompt','shell')")
    rows = ctx.conn.execute(
        "SELECT e.id, e.session_id, e.ts, e.category, e.target, e.title, e.detail"
        + scope
        + " ORDER BY e.ts DESC LIMIT 5000",
        params,
    ).fetchall()
    by_secret: dict[str, dict[str, Any]] = {}
    for r in rows:
        text = " ".join(filter(None, (r["target"], r["title"], r["detail"])))
        if not text:
            continue
        for pat, severity, kind in SECRET_PATTERNS:
            for m in pat.finditer(text):
                masked = mask_secret(m.group(0))
                g = by_secret.setdefault(
                    masked, {"severity": severity, "kind": kind, "rows": []}
                )
                if len(g["rows"]) < _EVIDENCE_CAP and (
                    not g["rows"] or g["rows"][-1]["id"] != r["id"]
                ):
                    g["rows"].append(r)
    out = []
    for masked, g in by_secret.items():
        where = "a prompt or command"
        out.append(
            _finding(
                "security.secrets_exposure",
                masked,
                g["severity"],
                f"Review: possible {g['kind']} in {where}",
                f"A string shaped like a {g['kind']} ({masked}) appeared in "
                f"{len(g['rows'])} event(s) and likely entered the model context.",
                "Rotate the credential and pass secrets via env vars or a secret manager, "
                "never inline in prompts or commands.",
                evidence=[_ev(r, f"{g['kind']}: {masked}", r["category"]) for r in g["rows"]],
            )
        )
    return out


@rule(id="security.read_then_exfil", pillar="security", tier=2)
def _read_then_exfil(ctx: RuleContext) -> list[dict[str, Any]]:
    c = CONSTANTS["security.read_then_exfil"]
    scope, params = _scope(
        ctx,
        " AND ((e.category IN ('file_read','file_edit') AND e.target IS NOT NULL)"
        " OR e.category IN ('shell','web'))",
    )
    rows = ctx.conn.execute(
        "SELECT e.id, e.session_id, e.ts, e.category, e.target"
        + scope
        + " ORDER BY e.session_id, e.ts, e.id",
        params,
    ).fetchall()
    out = []
    window = timedelta(seconds=c["window_seconds"])
    pending: dict[str, list[tuple[datetime, str, Any]]] = {}  # session → sensitive reads
    for r in rows:
        ts = db._parse_ts(r["ts"])
        if ts is None:
            continue
        sid = r["session_id"]
        if r["category"] in ("file_read", "file_edit"):
            if match_sensitive_path(r["target"]) is not None:
                pending.setdefault(sid, []).append((ts, r["target"], r))
            continue
        if r["category"] == "shell" and r["target"]:
            cmd = r["target"]
            if not _EXFIL_TOOLS.search(cmd):
                continue
            for read_ts, path, read_row in pending.get(sid, []):
                base = os.path.basename(path.rstrip("/"))
                if ts - read_ts <= window and (path in cmd or (base and base in cmd)):
                    out.append(
                        _finding(
                            "security.read_then_exfil",
                            f"{sid}|{path}",
                            "critical",
                            "Review: sensitive read followed by outbound command",
                            f"`{path}` was read, then within "
                            f"{int((ts - read_ts).total_seconds())}s the agent ran an "
                            f"outbound command referencing it.",
                            "Review this session's timeline now — verify no secret left "
                            "the machine, and tighten the agent's network rules.",
                            evidence=[_ev(read_row, path, "sensitive read"), _ev(r, cmd, "outbound")],
                        )
                    )
    return out


@rule(id="security.out_of_cwd_edits", pillar="security", tier=2)
def _out_of_cwd_edits(ctx: RuleContext) -> list[dict[str, Any]]:
    scope, params = _scope(
        ctx,
        " AND e.category = 'file_edit' AND e.target IS NOT NULL"
        " AND s.cwd IS NOT NULL AND s.cwd != ''",
    )
    rows = ctx.conn.execute(
        "SELECT e.id, e.session_id, e.ts, e.target, s.cwd"
        + scope
        + " ORDER BY e.ts DESC LIMIT 5000",
        params,
    ).fetchall()
    by_path: dict[str, dict[str, Any]] = {}
    for r in rows:
        target = os.path.normpath(r["target"])
        if not target.startswith("/"):
            continue  # relative paths are resolved against cwd by the agent
        cwd = os.path.normpath(r["cwd"])
        if target == cwd or target.startswith(cwd + "/"):
            continue
        if _OUT_OF_CWD_EXCLUDES.search(target):
            continue
        by_path.setdefault(target, {"rows": [], "cwd": cwd})["rows"].append(r)
    out = []
    for path, g in by_path.items():
        out.append(
            _finding(
                "security.out_of_cwd_edits",
                path,
                "warn",
                "Review: file edited outside the project",
                f"`{path}` was edited in a session working in {g['cwd']}.",
                "Verify the agent was meant to touch files outside the workspace; tighten "
                "workspace roots in agent settings if not.",
                evidence=[_ev(r, path) for r in g["rows"]],
            )
        )
    return out


@rule(id="security.repeat_blocked", pillar="security", tier=2)
def _repeat_blocked(ctx: RuleContext) -> list[dict[str, Any]]:
    c = CONSTANTS["security.repeat_blocked"]
    scope, params = _scope(
        ctx, " AND e.status IN ('blocked','error') AND e.target IS NOT NULL"
    )
    rows = ctx.conn.execute(
        "SELECT e.id, e.session_id, e.ts, e.target, e.status"
        + scope
        + " ORDER BY e.ts DESC LIMIT 5000",
        params,
    ).fetchall()
    by_target: dict[str, list[Any]] = {}
    for r in rows:
        risky = match_risky_command(r["target"]) or (
            ("warn", "sensitive path") if match_sensitive_path(r["target"]) else None
        )
        if not risky:
            continue
        by_target.setdefault(r["target"], []).append(r)
    out = []
    for target, hits in by_target.items():
        if len(hits) < c["min_repeats"]:
            continue
        out.append(
            _finding(
                "security.repeat_blocked",
                target,
                "warn",
                f"Agent retried a blocked risky action {len(hits)} times",
                f"`{target[:120]}` was blocked or failed {len(hits)} times — the agent "
                "keeps trying anyway.",
                "Add an explicit never-do rule for this action so the agent stops "
                "attempting it.",
                evidence=[_ev(r, target, r["status"]) for r in hits],
            )
        )
    return out


# --- engine -------------------------------------------------------------------


def _cutoff_iso(days: int) -> str | None:
    if days <= 0:
        return None
    return (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()


def _severity_sort_key(f: dict[str, Any]) -> tuple[int, int, str]:
    return (_SEVERITY_RANK.get(f["severity"], 3), f.get("tier", 2), f["id"])


def _stored_to_finding(r: Any) -> dict[str, Any]:
    return {
        "id": r["rule_id"],
        "fingerprint": r["fingerprint"],
        "group_title": GROUP_TITLES.get(r["rule_id"], r["pillar"]),
        "pillar": r["pillar"],
        "tier": r["tier"],
        "severity": r["severity"],
        "title": r["title"],
        "detail": r["detail"],
        "recommendation": r["recommendation"],
        "metric": None,
        "evidence": json.loads(r["evidence"] or "[]"),
        "status": r["status"],
        "first_seen": r["first_seen"],
        "last_seen": r["last_seen"],
        "resolved_at": r["resolved_at"],
    }


def _dedup(findings: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Collapse findings that share a fingerprint (same rule + subject across
    sessions), keeping the highest severity and merging evidence."""
    merged: dict[str, dict[str, Any]] = {}
    for f in findings:
        fp = f["fingerprint"]
        prev = merged.get(fp)
        if prev is None:
            merged[fp] = f
            continue
        if _SEVERITY_RANK[f["severity"]] < _SEVERITY_RANK[prev["severity"]]:
            prev["severity"], prev["title"], prev["detail"] = (
                f["severity"], f["title"], f["detail"]
            )
        prev["evidence"] = (prev["evidence"] + f["evidence"])[:_EVIDENCE_CAP]
    return list(merged.values())


def _reconcile(conn: Any, findings: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Persist current findings and merge lifecycle state (aggregate mode only)."""
    findings = _dedup(findings)
    now = db._now()
    grace = timedelta(days=CONSTANTS["lifecycle"]["resolve_grace_days"])
    stored = {
        r["fingerprint"]: r for r in conn.execute("SELECT * FROM insight_findings").fetchall()
    }
    out: list[dict[str, Any]] = []
    current: set[str] = set()
    for f in findings:
        fp = f["fingerprint"]
        current.add(fp)
        prev = stored.get(fp)
        if prev is None:
            conn.execute(
                "INSERT INTO insight_findings (fingerprint, rule_id, pillar, tier, severity,"
                " title, detail, recommendation, evidence, status, first_seen, last_seen)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)",
                (fp, f["id"], f["pillar"], f["tier"], f["severity"], f["title"], f["detail"],
                 f["recommendation"], json.dumps(f["evidence"]), now, now),
            )
            f["status"], f["first_seen"], f["last_seen"] = "active", now, now
        else:
            # Re-detection: refresh the snapshot; reopen resolved, keep dismissed hidden.
            status = "active" if prev["status"] == "resolved" else prev["status"]
            conn.execute(
                "UPDATE insight_findings SET severity = ?, title = ?, detail = ?,"
                " recommendation = ?, evidence = ?, status = ?, last_seen = ?,"
                " resolved_at = NULL WHERE fingerprint = ?",
                (f["severity"], f["title"], f["detail"], f["recommendation"],
                 json.dumps(f["evidence"]), status, now, fp),
            )
            f["status"], f["first_seen"], f["last_seen"] = status, prev["first_seen"], now
        f["resolved_at"] = None
        out.append(f)
    for fp, r in stored.items():
        if fp in current:
            continue
        if r["status"] == "active":
            last = db._parse_ts(r["last_seen"])
            if last is not None and datetime.now(timezone.utc) - last >= grace:
                conn.execute(
                    "UPDATE insight_findings SET status = 'resolved', resolved_at = ?"
                    " WHERE fingerprint = ?",
                    (now, fp),
                )
                r = conn.execute(
                    "SELECT * FROM insight_findings WHERE fingerprint = ?", (fp,)
                ).fetchone()
        out.append(_stored_to_finding(r))
    conn.commit()
    return out


def compute_insights(days: int = 30, session_id: str | None = None) -> dict[str, Any]:
    """Run all rules and return findings with lifecycle status.

    Aggregate mode (no session_id) persists findings and reconciles their
    lifecycle; per-session mode is ephemeral.
    """
    with db._connect() as conn:
        ctx = RuleContext(
            conn=conn,
            cutoff=None if session_id else _cutoff_iso(days),
            session_id=session_id,
        )
        findings: list[dict[str, Any]] = []
        for meta in RULES.values():
            if session_id and meta.aggregate_only:
                continue
            findings.extend(meta.fn(ctx))
        if session_id is None:
            findings = _reconcile(conn, findings)
        else:
            findings = _dedup(findings)
            for f in findings:
                f["status"] = "active"
                f["first_seen"] = f["last_seen"] = None
                f["resolved_at"] = None
    findings.sort(key=_severity_sort_key)
    active = [f for f in findings if f["status"] == "active"]
    week_ago = (datetime.now(timezone.utc) - timedelta(days=7)).isoformat()
    return {
        "generated_at": db._now(),
        "window_days": 0 if session_id else days,
        "insights": findings,
        "counts": {
            "by_pillar": {p: sum(1 for f in active if f["pillar"] == p) for p in PILLARS},
            "by_severity": {s: sum(1 for f in active if f["severity"] == s) for s in SEVERITIES},
            "resolved_recently": sum(
                1
                for f in findings
                if f["status"] == "resolved" and (f.get("resolved_at") or "") >= week_ago
            ),
        },
    }


def session_exists(session_id: str) -> bool:
    with db._connect() as conn:
        return (
            conn.execute("SELECT 1 FROM sessions WHERE id = ?", (session_id,)).fetchone()
            is not None
        )


def set_finding_status(fingerprint: str, status: str) -> bool:
    """Manual lifecycle control: dismiss or restore. Returns False if unknown."""
    assert status in ("dismissed", "active")
    now = db._now()
    with db._write_lock, db._connect() as conn:
        cur = conn.execute(
            "UPDATE insight_findings SET status = ?, dismissed_at = ?"
            " WHERE fingerprint = ?",
            (status, now if status == "dismissed" else None, fingerprint),
        )
        return cur.rowcount > 0
