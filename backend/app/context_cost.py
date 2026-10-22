"""What the fixed part of every prompt is made of, and what it costs.

Every model request an agent makes carries the same preamble before the
conversation: the agent's own system prompt and tools, memory files
(CLAUDE.md, AGENTS.md), the skill listing, and the tool definitions of every
MCP server it connected. None of it is free, and an MCP server nobody calls
still pays rent on every request.

Two kinds of numbers come out of here, and the report keeps them apart:

* **Measured**: requests and prompt sizes, from the token counts agents report.
  A session's smallest prompt is its *floor*, the preamble plus the first
  message, so the median floor is a measured upper bound on the preamble.
* **Estimated**: how that preamble splits into buckets, from what is on disk
  now. Memory files and skill descriptions are read directly. MCP tool
  definitions are only on disk where Cursor caches them, so other servers are
  counted as present but not sized. Tokens are estimated at four bytes each.

Agents that defer MCP tool definitions until they are searched for pay less
than the full schema; the estimate is what loading them in full would cost.
"""

from __future__ import annotations

import os
import re
import statistics
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

from . import extension_usage, extensions, folders, store, timeutil
from .pricing import cost_for

BYTES_PER_TOKEN = 4
# Per skill: separators and framing around the name and description.
_SKILL_LISTING_OVERHEAD = 8
# Claude Code lists every skill by name but drops descriptions past a character
# budget (SLASH_COMMAND_TOOL_CHAR_BUDGET), so a long tail of skills costs names only.
_CLAUDE_SKILL_DESC_BUDGET = int(os.environ.get("SLASH_COMMAND_TOOL_CHAR_BUDGET") or 15_000)
# Sources whose token counts arrive per model request. Cursor reports one sum
# per turn, so a floor computed from it would count several requests as one.
_PER_REQUEST_SOURCES = {"claude", "codex", "opencode"}
# Idle overhead below this is not worth anyone's attention.
_MIN_IDLE_TOKENS = 500
_WARN_IDLE_TOKENS = 5_000

_IMPORT_RE = re.compile(r"(?:^|\s)@((?:~|\.{1,2})?/?[\w./-]+\.md)\b")


def _agent(source: str | None) -> str:
    return "claude" if source == "cowork" else (source or "unknown")


def _tokens(nbytes: int) -> int:
    return (nbytes + BYTES_PER_TOKEN - 1) // BYTES_PER_TOKEN


def _since(days: int) -> str | None:
    if days <= 0:
        return None
    return (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%S")


def _prompt_size(row: dict[str, Any]) -> int:
    """Tokens the model read for one request. Anthropic reports cache reads
    beside input; OpenAI-style agents report them as a subset of input."""
    i = int(row["i"] or 0)
    cr = int(row["cr"] or 0)
    cw = int(row["cw"] or 0)
    return i + cw if i >= cr else i + cr + cw


# --- Memory files -----------------------------------------------------------


def _within(cwd: str | None, project: str) -> bool:
    if not cwd:
        return False
    root = project.rstrip("/")
    return cwd == root or cwd.startswith(root + "/")


def _dir_chain(cwd: str | None) -> list[Path]:
    """The cwd and its ancestors up to the git root (never above $HOME), root first."""
    if not cwd or not cwd.startswith("/") or not folders.readable(cwd):
        return []
    home = Path.home()
    out: list[Path] = []
    p = Path(cwd)
    for _ in range(8):
        out.append(p)
        if p == home or p == p.parent or (p / ".git").exists():
            break
        p = p.parent
    return list(reversed(out))


def _file_size(path: Path) -> int | None:
    try:
        return path.stat().st_size if path.is_file() else None
    except OSError:
        return None


def _with_imports(path: Path, seen: set[Path]) -> list[tuple[Path, int]]:
    """A memory file and the files it pulls in with ``@path`` (one level)."""
    size = _file_size(path)
    if size is None or path in seen:
        return []
    seen.add(path)
    out = [(path, size)]
    try:
        text = path.read_text(encoding="utf-8", errors="replace")[:200_000]
    except OSError:
        return out
    for ref in _IMPORT_RE.findall(text):
        target = Path(ref).expanduser() if ref.startswith("~") else (path.parent / ref)
        target = target.resolve() if target.exists() else target
        imported = _file_size(target)
        if imported is not None and target not in seen:
            seen.add(target)
            out.append((target, imported))
    return out


def memory_files(agent: str, cwd: str | None) -> list[tuple[Path, int]]:
    """Instruction files the agent loads into every request for a session in ``cwd``."""
    seen: set[Path] = set()
    out: list[tuple[Path, int]] = []
    chain = _dir_chain(cwd)
    if agent == "claude":
        out += _with_imports(extensions.claude_home() / "CLAUDE.md", seen)
        for d in chain:
            for name in ("CLAUDE.md", ".claude/CLAUDE.md", "CLAUDE.local.md"):
                out += _with_imports(d / name, seen)
    elif agent in ("codex", "opencode", "cursor"):
        if agent == "codex":
            out += _with_imports(extensions.codex_home() / "AGENTS.md", seen)
        elif agent == "opencode":
            out += _with_imports(Path.home() / ".config" / "opencode" / "AGENTS.md", seen)
        for d in chain:
            out += _with_imports(d / "AGENTS.md", seen)
        if agent == "cursor" and chain:
            out += _cursor_always_rules(chain[-1], seen)
    elif agent == "hermes":
        hermes_home = Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes")
        out += _with_imports(hermes_home / "SOUL.md", seen)
        # Hermes loads one project context type, the first it finds: the nearest
        # .hermes.md, else the AGENTS.md chain, else CLAUDE.md, else .cursorrules.
        cwd_dir = chain[-1:] if chain else []
        for found in (
            next(([f] for d in reversed(chain) for f in (d / ".hermes.md", d / "HERMES.md") if f.is_file()), []),
            [d / "AGENTS.md" for d in chain],
            [d / "CLAUDE.md" for d in cwd_dir],
            [d / ".cursorrules" for d in cwd_dir],
        ):
            loaded = [entry for path in found for entry in _with_imports(path, seen)]
            if loaded:
                out += loaded
                break
    return out


def _cursor_always_rules(cwd: Path, seen: set[Path]) -> list[tuple[Path, int]]:
    out: list[tuple[Path, int]] = []
    try:
        rules = sorted((cwd / ".cursor" / "rules").glob("*.mdc"))[:200]
    except OSError:
        return out
    for rule in rules:
        try:
            head = rule.read_text(encoding="utf-8", errors="replace")[:600]
        except OSError:
            continue
        if re.search(r"^alwaysApply:\s*true\s*$", head, re.M) and rule not in seen:
            seen.add(rule)
            out.append((rule, _file_size(rule) or 0))
    return out


# --- Extensions in context ----------------------------------------------------


def _visible(ext: dict[str, Any], agent: str, cwd: str | None) -> bool:
    """Whether the agent loads this extension for a session in ``cwd``."""
    for inst in ext.get("installs") or []:
        if inst.get("agent") != agent or inst.get("enabled") is False:
            continue
        project = inst.get("project")
        if not project or _within(cwd, project):
            return True
    return False


def _skill_listing(agent: str, skills: dict[str, dict[str, Any]]) -> dict[str, int]:
    """Estimated listing tokens per skill. Under Claude Code's description
    budget each skill keeps its share of the budget, so the shares add up to
    what the listing can actually hold."""
    names = {k: len((e.get("name") or "").encode("utf-8")) + _SKILL_LISTING_OVERHEAD for k, e in skills.items()}
    descs = {k: len((e.get("description") or "").encode("utf-8")) for k, e in skills.items()}
    total = sum(descs.values())
    scale = 1.0
    if agent == "claude" and total > _CLAUDE_SKILL_DESC_BUDGET:
        scale = _CLAUDE_SKILL_DESC_BUDGET / total
    return {k: _tokens(names[k] + int(descs[k] * scale)) for k in skills}


def _mcp_tokens(inv: extensions.Inventory, ext: dict[str, Any]) -> tuple[int | None, int]:
    """Estimated tokens for one server's tool definitions, and how many tools.
    ``None`` when no agent cached the definitions where cot can read them."""
    for name in [ext["name"], *(ext.get("aliases") or [])]:
        info = inv.cursor_tools.get(name)
        if info and info.get("sizes"):
            sizes = info["sizes"]
            return _tokens(sum(sizes.values())), len(sizes)
    return None, 0


class _Context:
    """Per (agent, cwd) preamble estimate, memoized for one report."""

    def __init__(self, inv: extensions.Inventory) -> None:
        self.inv = inv
        self._memo: dict[tuple[str, str | None], dict[str, Any]] = {}
        self._mcp: dict[str, tuple[int | None, int]] = {}

    def mcp(self, key: str) -> tuple[int | None, int]:
        if key not in self._mcp:
            self._mcp[key] = _mcp_tokens(self.inv, self.inv.extensions[key])
        return self._mcp[key]

    def of(self, agent: str, cwd: str | None) -> dict[str, Any]:
        k = (agent, cwd)
        if k in self._memo:
            return self._memo[k]
        mem = memory_files(agent, cwd)
        visible_skills: dict[str, dict[str, Any]] = {}
        servers: dict[str, int | None] = {}
        for key, ext in self.inv.extensions.items():
            if ext["kind"] not in ("skill", "mcp") or not _visible(ext, agent, cwd):
                continue
            if ext["kind"] == "skill":
                visible_skills[key] = ext
            else:
                servers[key] = self.mcp(key)[0]
        out = {
            "memory": [(str(p), _tokens(n)) for p, n in mem],
            "skills": _skill_listing(agent, visible_skills),
            "mcp": servers,
        }
        self._memo[k] = out
        return out


# --- Report -------------------------------------------------------------------


def _request_rows(since: str | None, project: str | None, source: str | None) -> list[dict[str, Any]]:
    clauses = [
        "s.archived = 0",
        "(e.input_tokens > 0 OR e.cache_read_tokens > 0 OR e.cache_write_tokens > 0)",
    ]
    params: list[Any] = []
    if since:
        clauses.append("e.ts >= ?")
        params.append(since)
    if project:
        clauses.append("s.cwd = ?")
        params.append(project)
    if source:
        clauses.append("e.source = ?")
        params.append(source)
    sql = (
        "SELECT e.session_id AS sid, e.source, e.model, s.cwd,"
        " e.input_tokens AS i, e.cache_read_tokens AS cr, e.cache_write_tokens AS cw"
        " FROM events e JOIN sessions s ON s.id = e.session_id"
        f" WHERE {' AND '.join(clauses)}"
    )
    with store.read() as conn:
        return [dict(r) for r in conn.execute(sql, params)]


def _usage_counts(kind: str, since: str | None, project: str | None, source: str | None) -> Counter[str]:
    items = extension_usage.activity_items(kind, since, project, source)
    return Counter(it["ext_key"] for it in items if it.get("ext_key"))


def report(days: int = 30, project: str | None = None, source: str | None = None) -> dict[str, Any]:
    """The preamble every request carried in the window, split into buckets."""
    since = _since(days)
    rows = _request_rows(since, project, source)
    inv = extension_usage.inventory()
    ctx = _Context(inv)

    # Requests per (agent, cwd, model), and each session's smallest prompt.
    requests: Counter[tuple[str, str | None, str | None]] = Counter()
    floors: dict[str, int] = {}
    session_agent: dict[str, str] = {}
    for r in rows:
        agent = _agent(r["source"])
        requests[(agent, r["cwd"], r["model"])] += 1
        session_agent[r["sid"]] = agent
        if agent in _PER_REQUEST_SOURCES:
            size = _prompt_size(r)
            if size > 0 and (r["sid"] not in floors or size < floors[r["sid"]]):
                floors[r["sid"]] = size

    mcp_calls = _usage_counts("mcp", since, project, source)
    skill_loads = _usage_counts("skill", since, project, source)

    agents: dict[str, dict[str, Any]] = {}
    per_mcp: dict[str, dict[str, Any]] = {}
    per_skill: dict[str, dict[str, Any]] = {}
    per_memory: dict[str, dict[str, Any]] = {}

    def acc(agent: str) -> dict[str, Any]:
        return agents.setdefault(agent, {
            "agent": agent, "requests": 0, "sessions": 0,
            "buckets": defaultdict(int), "unmeasured_mcp": set(), "cost_usd": 0.0, "priced": True,
        })

    for (agent, cwd, model), n in requests.items():
        c = ctx.of(agent, cwd)
        a = acc(agent)
        a["requests"] += n
        mem = sum(t for _, t in c["memory"])
        skills = sum(c["skills"].values())
        mcp = sum(t for t in c["mcp"].values() if t)
        a["buckets"]["memory"] += mem * n
        a["buckets"]["skills"] += skills * n
        a["buckets"]["mcp"] += mcp * n
        a["unmeasured_mcp"].update(k for k, t in c["mcp"].items() if t is None)
        # The preamble is cached after the first request, so price it as cache reads.
        price = cost_for(model, 0, 0, cache_read_tokens=(mem + skills + mcp) * n)
        if price is None:
            a["priced"] = False
        else:
            a["cost_usd"] += price
        for bucket, items in ((per_memory, c["memory"]), (per_mcp, c["mcp"].items()), (per_skill, c["skills"].items())):
            for key, t in items:
                m = bucket.setdefault(key, {"key": key, "total": 0, "sized": t is not None, "agents": set(), "requests": 0})
                m["agents"].add(agent)
                m["requests"] += n
                m["total"] += (t or 0) * n

    for sid, agent in session_agent.items():
        acc(agent)["sessions"] += 1

    out_agents = []
    for a in sorted(agents.values(), key=lambda a: -a["requests"]):
        sids = [s for s, ag in session_agent.items() if ag == a["agent"] and s in floors]
        floor = int(statistics.median(floors[s] for s in sids)) if sids else None
        req = a["requests"] or 1
        per_request = {k: round(v / req) for k, v in a["buckets"].items()}
        known = sum(per_request.values())
        out_agents.append({
            "agent": a["agent"],
            "sessions": a["sessions"],
            "requests": a["requests"],
            # Measured: the median session's smallest prompt.
            "floor_tokens": floor,
            "per_request": {
                "memory": per_request.get("memory", 0),
                "skills": per_request.get("skills", 0),
                "mcp": per_request.get("mcp", 0),
                # What the floor holds beyond the buckets: the agent's own system
                # prompt and built-in tools, unsized MCP servers and the first message.
                "agent_and_other": max(floor - known, 0) if floor is not None else None,
            },
            "unmeasured_mcp": len(a["unmeasured_mcp"]),
            "overhead_tokens": sum(a["buckets"].values()),
            "overhead_cost_usd": round(a["cost_usd"], 4) if a["priced"] or a["cost_usd"] else None,
        })

    def sized(m: dict[str, Any]) -> dict[str, Any]:
        return {
            "agents": sorted(m["agents"]),
            "requests": m["requests"],
            # Averaged over requests: agents size the same skill differently.
            "tokens_per_request": round(m["total"] / m["requests"]) if m["sized"] and m["requests"] else None,
            "tokens_total": m["total"] if m["sized"] else None,
        }

    def finish(m: dict[str, Any], used: Counter[str], kind: str) -> dict[str, Any]:
        ext = inv.extensions.get(m["key"], {})
        uses = used.get(m["key"], 0)
        return {
            "key": m["key"],
            "name": ext.get("display_name") or ext.get("name") or m["key"].partition(":")[2],
            "plugin": ext.get("plugin"),
            **sized(m),
            ("calls" if kind == "mcp" else "loads"): uses,
            "idle": uses == 0,
            **({"tools": ctx.mcp(m["key"])[1]} if kind == "mcp" else {}),
        }

    mcp_out = [finish(m, mcp_calls, "mcp") for m in per_mcp.values()]
    mcp_out.sort(key=lambda m: (-(m["tokens_total"] or 0), m["name"].lower()))
    skill_out = [finish(m, skill_loads, "skill") for m in per_skill.values()]
    skill_out.sort(key=lambda m: (-(m["tokens_total"] or 0), m["name"].lower()))
    memory_out = sorted(
        ({"path": m["key"], **sized(m)} for m in per_memory.values()),
        key=lambda m: -(m["tokens_total"] or 0),
    )

    return {
        "generated_at": timeutil.now(),
        "days": days,
        "bytes_per_token": BYTES_PER_TOKEN,
        "agents": out_agents,
        "mcp": mcp_out,
        "skills": skill_out,
        "memory": memory_out[:50],
    }


def session_cost(session_id: str) -> dict[str, Any] | None:
    """Where one session's tokens went: per model, the heaviest events, how
    much was served from cache, and the preamble every request carried.
    ``requests`` counts token-bearing events, a lower bound on model calls."""
    with store.read() as conn:
        sess = conn.execute("SELECT id, source, cwd FROM sessions WHERE id = ?", (session_id,)).fetchone()
        if sess is None:
            return None
        rows = [dict(r) for r in conn.execute(
            "SELECT id, ts, category, title, target, model, input_tokens AS i, output_tokens AS o,"
            " cache_read_tokens AS cr, cache_write_tokens AS cw FROM events WHERE session_id = ?"
            " AND (input_tokens > 0 OR output_tokens > 0 OR cache_read_tokens > 0 OR cache_write_tokens > 0)",
            (session_id,),
        )]
        children = conn.execute(
            "SELECT COUNT(*) FROM sessions WHERE parent_session_id = ?", (session_id,)
        ).fetchone()[0]
    agent = _agent(sess["source"])
    models: dict[str, dict[str, Any]] = {}
    for r in rows:
        m = models.setdefault(r["model"] or "unknown", {"model": r["model"], "requests": 0, "input": 0, "output": 0, "cache_read": 0, "cache_write": 0})
        m["requests"] += 1
        m["input"] += int(r["i"] or 0)
        m["output"] += int(r["o"] or 0)
        m["cache_read"] += int(r["cr"] or 0)
        m["cache_write"] += int(r["cw"] or 0)
    total_cost = 0.0
    priced = False
    for m in models.values():
        c = cost_for(m["model"], m["input"], m["output"], m["cache_read"], m["cache_write"])
        m["cost_usd"] = round(c, 4) if c is not None else None
        if c is not None:
            total_cost += c
            priced = True
    prompts = [_prompt_size(r) for r in rows]
    read = sum(int(r["cr"] or 0) for r in rows)
    heaviest = sorted(rows, key=lambda r: -(_prompt_size(r) + int(r["o"] or 0)))[:8]

    pre = _Context(extension_usage.inventory()).of(agent, sess["cwd"])
    buckets = {
        "memory": sum(t for _, t in pre["memory"]),
        "skills": sum(pre["skills"].values()),
        "mcp": sum(t for t in pre["mcp"].values() if t),
    }
    return {
        "session_id": session_id,
        "agent": agent,
        "requests": len(rows),
        "subagent_sessions": children,
        "cost_usd": round(total_cost, 4) if priced else None,
        "models": sorted(models.values(), key=lambda m: -(m["cost_usd"] or 0)),
        "prompt_tokens": {
            "floor": min((p for p in prompts if p > 0), default=None) if agent in _PER_REQUEST_SOURCES else None,
            "median": int(statistics.median(prompts)) if prompts else None,
            "max": max(prompts, default=None),
            "total": sum(prompts),
        },
        # Share of prompt tokens served from cache (cheap) rather than read fresh.
        "cache_read_share": round(read / sum(prompts), 3) if sum(prompts) else None,
        # An event can carry several model calls' usage (the bridge folds the
        # usage of calls it does not record onto the next event it keeps).
        "heaviest_events": [
            {
                "event_id": r["id"], "ts": timeutil.format_ts(r["ts"]), "category": r["category"],
                "title": r["title"], "target": (r["target"] or "")[:160] or None, "model": r["model"],
                "prompt_tokens": _prompt_size(r), "output_tokens": int(r["o"] or 0),
            }
            for r in heaviest
        ],
        "preamble_per_request": {
            **buckets,
            "unmeasured_mcp": sum(1 for t in pre["mcp"].values() if t is None),
            "estimated_total": sum(buckets.values()) * len(rows),
        },
    }


def cached_report(days: int = 30, project: str | None = None, source: str | None = None) -> dict[str, Any]:
    """:func:`report`, reused until a new MCP call or skill load, a config change
    or the minute rolls over (the Extensions view's cache)."""
    return extension_usage.cached(("context", days, project, source), lambda: report(days, project, source))


# --- Worth a look -------------------------------------------------------------


def _fmt_tokens(n: int) -> str:
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M"
    if n >= 1_000:
        return f"{n / 1_000:.1f}k"
    return str(n)


def idle_attention(
    category: str,
    days: int,
    project: str | None = None,
    source: str | None = None,
    compute: Callable[..., dict[str, Any]] = cached_report,
) -> list[dict[str, Any]]:
    """One "Worth a look" entry for extensions that sat in every prompt of the
    range without being used once. Ranges under a week are too short to call
    anything idle."""
    if category not in ("mcp", "skill") or 0 < days < 7:
        return []
    data = compute(days, project, source)
    rows = data["mcp"] if category == "mcp" else data["skills"]
    idle = [r for r in rows if r["idle"] and r["requests"]]
    if not idle:
        return []
    sized = [r for r in idle if r["tokens_per_request"]]
    total = sum(r["tokens_total"] for r in sized)
    # Per request of the agents that load them, not diluted by agents that don't.
    loading = {a for r in sized for a in r["agents"]}
    requests = sum(a["requests"] for a in data["agents"] if a["agent"] in loading)
    per_request = round(total / requests) if requests else 0
    if per_request < _MIN_IDLE_TOKENS:
        return []
    noun = "MCP server" if category == "mcp" else "skill"
    unused = "never called" if category == "mcp" else "never loaded"
    span = "all time" if days == 0 else f"the last {days} days"
    count = len(sized)
    return [{
        "kind": "idle_overhead",
        "severity": "warn" if per_request >= _WARN_IDLE_TOKENS else "info",
        "title": f"{count} {noun}{'' if count == 1 else 's'} {unused} in {span} add ~{_fmt_tokens(per_request)} tokens per request",
        "detail": f"≈{_fmt_tokens(total)} tokens across the range, estimated from their definitions on disk",
        "subject": None,
        "names": [r["name"] for r in sorted(sized, key=lambda r: -r["tokens_per_request"])][:12],
        "ref": None,
    }]
