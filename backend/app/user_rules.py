"""User-written rules: a declarative spec compiled into the insights engine.

End users author rules in the dashboard; each rule is a JSON *spec* (never
code — specs can be shared and imported, so they must be inert data). A spec
compiles into the same ``fn(Snapshot) -> findings`` shape as the built-in rules
in ``insights.py``, so user findings reuse the existing lifecycle (fingerprints,
auto-resolve, sticky dismissal), evidence and Insights UI.

## Spec (version 1)
::

    {
      "version": 1,
      "name": "Agent queried a production database",
      "description": "optional",
      "pillar": "security",              # usability | cost | security
      "severity": "warn",                # info | warn | critical
      "type": "match",                   # match | threshold
      "scope": {"sources": ["claude"], "projects": ["~/work/*"]},   # optional
      "when": {"all": [
          {"field": "category", "op": "eq", "value": "shell"},
          {"field": "target", "op": "regex", "value": "psql .*prod"}
      ]},
      "subject": "target",               # match: what one finding is about
      "threshold": {...},                # threshold only, see below
      "recommendation": "Use the read replica.",
      "action": "finding"
    }

``when`` is a condition tree: ``{"all": [...]}``, ``{"any": [...]}``,
``{"not": {...}}`` or a leaf ``{"field", "op", "value"}``. ``threshold`` is
``{"group_by": [field...], "aggregate": "count"|"sum"|"distinct",
"field": <num field for sum / any field for distinct>, "op": "gte"|"gt"|...,
"value": <number>}`` and fires once per group whose aggregate passes.

## Built for enforcement later
Today cot only observes — the bridge posts hooks fire-and-forget. Blocking a
tool call needs a synchronous ``PreToolUse`` round trip, and the pieces it
needs are already here so that step is wiring, not a rewrite:

* **One evaluator, two callers.** Conditions run over a flat *facts* mapping,
  not over SQLite rows. Stored events become facts via :func:`facts_from_event`;
  a live hook body becomes facts via :func:`facts_from_hook` (the same
  ``normalize()`` the collector ingests with). Detection and enforcement can
  never disagree about what a condition means.
* **Field phases.** Every field declares whether it is known *before* the tool
  runs (``pre``: source, project, category, tool, target…) or only after
  (``post``: status, duration, tokens, cost). A rule is *enforceable* only if it
  is a ``match`` rule over ``pre`` fields — the API reports this per rule so the
  UI can show which rules could block once enforcement ships.
* **Actions.** ``action`` is ``"finding"`` today; ``"ask"`` and ``"deny"`` are
  reserved and rejected by validation until :data:`ENFORCEMENT_ENABLED` flips.
  :func:`decide` already resolves a hook to the strictest matching decision.
* **Bounded cost.** Specs are size-capped, regexes are compiled once at load and
  matched against a capped prefix of the value, and compiled rules are cached —
  the hot path must stay well inside a hook's timeout.

## Adding a field or operator
Add a :class:`FieldDef` to :data:`FIELDS` (with its phase and a getter over the
facts mapping) or an entry in :data:`OPERATORS`; the ``/v1/rules/schema``
endpoint publishes both, so the form builder picks them up without UI changes.
"""

from __future__ import annotations

import fnmatch
import hashlib
import json
import os
import re
import uuid
from dataclasses import dataclass
from typing import Any, Callable, Mapping

from . import db, timeutil
from .insight_snapshot import Event, Snapshot, event_from_row
from .pricing import cost_for

SPEC_VERSION = 1
RULE_TYPES = ("match", "threshold")
PILLARS = ("usability", "cost", "security")
SEVERITIES = ("info", "warn", "critical")
SOURCES = ("claude", "cursor", "codex", "opencode")
CATEGORIES = (
    "shell", "file_read", "file_edit", "context_read", "memory", "mcp", "web",
    "permission", "prompt", "question", "response", "thought", "plan",
    "subagent", "compaction", "lifecycle", "notification",
)

# "finding" records an insight. "ask"/"deny" are the enforcement actions a
# synchronous PreToolUse hook will return; validation rejects them until then.
ACTIONS = ("finding", "ask", "deny")
ENFORCEMENT_ACTIONS = ("ask", "deny")
ENFORCEMENT_ENABLED = False

ID_PREFIX = "user."

# Spec bounds — specs come from end users and may be imported from others.
_MAX_CONDITIONS = 40
_MAX_DEPTH = 6
_MAX_LIST = 100
_MAX_TEXT = 500
_MAX_NAME = 120
_MAX_REC = 1000
# Regexes only ever see this much of a value, which bounds backtracking cost.
_MATCH_CHARS = 4096
_MAX_FINDINGS_PER_RULE = 25
# A quantified group that itself contains a quantifier — ``(a+)+``, ``(.*x)*`` —
# is the classic catastrophic-backtracking shape. Python's ``re`` has no
# timeout, and these will run inside a hook once rules can block, so refuse them.
_NESTED_QUANTIFIER = re.compile(r"\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d*,)")
_OP_SYMBOL = {"gt": ">", "gte": "≥", "lt": "<", "lte": "≤", "eq": "="}
_EVIDENCE_CAP = 8


# --- facts ----------------------------------------------------------------------


def mcp_server(tool: str | None) -> str | None:
    if tool and tool.startswith("mcp__"):
        parts = tool.split("__", 2)
        if len(parts) == 3:
            return parts[1]
    return None


def _hour(ts: Any) -> int | None:
    parsed = timeutil.parse_ts(ts) if ts else None
    return parsed.astimezone().hour if parsed else None


def _program(facts: Mapping[str, Any]) -> str | None:
    """The program a shell command really runs (``git`` for ``cd x && rtk git status``)."""
    from .activity import parse_command  # activity imports insights, which imports us

    if facts.get("category") != "shell" or not facts.get("target"):
        return None
    return parse_command(str(facts["target"])[:_MATCH_CHARS]).program or None


# Facts that cost something to compute, filled in only when a rule reads them.
_DERIVED: dict[str, Callable[[Mapping[str, Any]], Any]] = {"program": _program}


class Facts(dict):
    """A facts mapping whose derived fields are computed on first read."""

    def get(self, key: str, default: Any = None) -> Any:
        if key not in self and key in _DERIVED:
            self[key] = _DERIVED[key](self)
        return super().get(key, default)


def _base_facts(m: Mapping[str, Any]) -> Facts:
    tool = m.get("tool")
    return Facts({
        "source": m.get("source"),
        "project": m.get("cwd"),
        "session": m.get("session_id"),
        "hook": m.get("hook"),
        "category": m.get("category"),
        "tool": tool,
        "mcp_server": mcp_server(tool),
        "target": m.get("target"),
        "title": m.get("title"),
        "detail": m.get("detail"),
        "model": m.get("model"),
        "status": m.get("status"),
        "duration_ms": m.get("duration_ms"),
        "hour": _hour(m.get("ts")),
    })


def facts_from_event(e: Event) -> Facts:
    """Facts for a stored event (detection path)."""
    facts = _base_facts({k: e[k] for k in e.keys()})
    tokens = e.input_tokens + e.output_tokens + e.cache_read_tokens + e.cache_write_tokens
    facts["tokens"] = tokens
    facts["cost_usd"] = (
        cost_for(e.model, e.input_tokens, e.output_tokens, e.cache_read_tokens, e.cache_write_tokens)
        if e.model and tokens else 0.0
    ) or 0.0
    return facts


def snapshot_facts(snap: Snapshot) -> list[tuple[Event, dict[str, Any]]]:
    """Facts for every countable event in a snapshot, built once and shared by all rules."""
    if snap.rule_facts is None:
        snap.rule_facts = [
            (e, facts_from_event(e)) for e in snap.events
            if e.hook not in ("PreToolUse", "preToolUse")
        ]
    return snap.rule_facts


def facts_from_hook(source: str, body: Mapping[str, Any]) -> Facts:
    """Facts for a live hook payload (future enforcement path).

    Runs the collector's own ``normalize`` so category/tool/target mean exactly
    what they mean for stored events. Post-phase fields are absent: the tool
    has not run yet.
    """
    from .normalize import normalize

    norm = normalize(source, dict(body))  # type: ignore[arg-type]
    facts = _base_facts(norm)
    for name, fd in FIELDS.items():
        if fd.phase == "post":
            facts[name] = None
    return facts


# --- fields & operators ---------------------------------------------------------


@dataclass(frozen=True)
class FieldDef:
    name: str
    label: str
    kind: str  # "text" | "number" | "enum"
    phase: str  # "pre" — known before the tool runs; "post" — only after
    options: tuple[str, ...] = ()
    groupable: bool = True


FIELDS: dict[str, FieldDef] = {
    f.name: f
    for f in (
        FieldDef("source", "Agent", "enum", "pre", SOURCES),
        FieldDef("project", "Project folder", "text", "pre"),
        FieldDef("session", "Session", "text", "pre"),
        FieldDef("category", "Activity type", "enum", "pre", CATEGORIES),
        FieldDef("tool", "Tool name", "text", "pre"),
        FieldDef("program", "Program (shell)", "text", "pre"),
        FieldDef("mcp_server", "MCP server", "text", "pre"),
        FieldDef("target", "Command / path / URL", "text", "pre"),
        FieldDef("title", "Title", "text", "pre"),
        FieldDef("hook", "Hook event", "text", "pre"),
        FieldDef("hour", "Hour of day (local)", "number", "pre"),
        FieldDef("detail", "Detail / output", "text", "post", groupable=False),
        FieldDef("model", "Model", "text", "post"),
        FieldDef("status", "Result", "enum", "post", ("ok", "error")),
        FieldDef("duration_ms", "Duration (ms)", "number", "post", groupable=False),
        FieldDef("tokens", "Tokens", "number", "post", groupable=False),
        FieldDef("cost_usd", "Cost (USD)", "number", "post", groupable=False),
    )
}


def _as_text(v: Any) -> str:
    return "" if v is None else str(v)[:_MATCH_CHARS]


def _num(v: Any) -> float | None:
    if isinstance(v, bool) or v is None:
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _expand(pattern: str) -> str:
    return os.path.expanduser(pattern)


def _outside_project(facts: Mapping[str, Any]) -> bool:
    target, project = facts.get("target"), facts.get("project")
    if not target or not project or not str(target).startswith(("/", "~")):
        return False
    path = os.path.normpath(os.path.expanduser(str(target)))
    root = os.path.normpath(os.path.expanduser(str(project)))
    return path != root and not path.startswith(root.rstrip("/") + "/")


def _sensitive_path(v: Any) -> bool:
    from .insights import match_sensitive_path

    return bool(v) and match_sensitive_path(str(v)) is not None


def _risky_command(v: Any) -> bool:
    from .insights import match_risky_command

    return bool(v) and match_risky_command(str(v)) is not None


@dataclass(frozen=True)
class OpDef:
    name: str
    label: str
    kinds: tuple[str, ...]
    value: str  # "none" | "one" | "list"


OPERATORS: dict[str, OpDef] = {
    o.name: o
    for o in (
        OpDef("eq", "is", ("text", "number", "enum"), "one"),
        OpDef("ne", "is not", ("text", "number", "enum"), "one"),
        OpDef("in", "is one of", ("text", "enum"), "list"),
        OpDef("not_in", "is none of", ("text", "enum"), "list"),
        OpDef("contains", "contains", ("text",), "one"),
        OpDef("not_contains", "does not contain", ("text",), "one"),
        OpDef("starts_with", "starts with", ("text",), "one"),
        OpDef("ends_with", "ends with", ("text",), "one"),
        OpDef("glob", "matches pattern", ("text",), "one"),
        OpDef("regex", "matches regex", ("text",), "one"),
        OpDef("gt", ">", ("number",), "one"),
        OpDef("gte", "≥", ("number",), "one"),
        OpDef("lt", "<", ("number",), "one"),
        OpDef("lte", "≤", ("number",), "one"),
        OpDef("exists", "is set", ("text", "number", "enum"), "none"),
        OpDef("missing", "is empty", ("text", "number", "enum"), "none"),
        # cot's curated detectors, so users don't have to rewrite them.
        OpDef("is_sensitive_path", "is a sensitive file", ("text",), "none"),
        OpDef("is_risky_command", "is a risky command", ("text",), "none"),
        OpDef("outside_project", "is outside the project", ("text",), "none"),
    )
}


# --- validation -----------------------------------------------------------------


class SpecError(ValueError):
    """A user-facing validation error; ``path`` points into the spec."""

    def __init__(self, path: str, message: str) -> None:
        super().__init__(f"{path}: {message}" if path else message)
        self.path = path
        self.message = message


def _text(spec: Mapping[str, Any], key: str, limit: int, *, required: bool = False) -> str | None:
    v = spec.get(key)
    if v is None or v == "":
        if required:
            raise SpecError(key, "is required")
        return None
    if not isinstance(v, str):
        raise SpecError(key, "must be text")
    v = v.strip()
    if required and not v:
        raise SpecError(key, "is required")
    if len(v) > limit:
        raise SpecError(key, f"must be at most {limit} characters")
    return v


def _choice(spec: Mapping[str, Any], key: str, options: tuple[str, ...], default: str | None = None) -> str:
    v = spec.get(key, default)
    if v not in options:
        raise SpecError(key, f"must be one of {', '.join(options)}")
    return v  # type: ignore[return-value]


class _Counter:
    def __init__(self) -> None:
        self.n = 0


def _validate_condition(node: Any, path: str, depth: int, counter: _Counter) -> dict[str, Any]:
    if depth > _MAX_DEPTH:
        raise SpecError(path, f"nests deeper than {_MAX_DEPTH} levels")
    if not isinstance(node, Mapping):
        raise SpecError(path, "must be a condition")
    for group in ("all", "any"):
        if group in node:
            items = node[group]
            if not isinstance(items, list) or not items:
                raise SpecError(f"{path}.{group}", "must be a non-empty list")
            return {group: [
                _validate_condition(c, f"{path}.{group}[{i}]", depth + 1, counter)
                for i, c in enumerate(items)
            ]}
    if "not" in node:
        return {"not": _validate_condition(node["not"], f"{path}.not", depth + 1, counter)}

    counter.n += 1
    if counter.n > _MAX_CONDITIONS:
        raise SpecError("when", f"has more than {_MAX_CONDITIONS} conditions")
    field, op = node.get("field"), node.get("op")
    fd = FIELDS.get(field) if isinstance(field, str) else None
    if fd is None:
        raise SpecError(f"{path}.field", f"unknown field {field!r}")
    od = OPERATORS.get(op) if isinstance(op, str) else None
    if od is None:
        raise SpecError(f"{path}.op", f"unknown operator {op!r}")
    if fd.kind not in od.kinds or (op == "outside_project" and field != "target"):
        raise SpecError(f"{path}.op", f"'{od.label}' doesn't apply to {fd.label}")
    out: dict[str, Any] = {"field": field, "op": op}
    value = node.get("value")
    if od.value == "one":
        if fd.kind == "number":
            if _num(value) is None:
                raise SpecError(f"{path}.value", "must be a number")
            value = _num(value)
        else:
            if not isinstance(value, (str, int, float)) or isinstance(value, bool) or str(value) == "":
                raise SpecError(f"{path}.value", "is required")
            value = str(value)
            if len(value) > _MAX_TEXT:
                raise SpecError(f"{path}.value", f"must be at most {_MAX_TEXT} characters")
            if fd.kind == "enum" and value not in fd.options:
                raise SpecError(f"{path}.value", f"must be one of {', '.join(fd.options)}")
            if op == "regex":
                try:
                    re.compile(value)
                except re.error as exc:
                    raise SpecError(f"{path}.value", f"invalid regex: {exc}") from None
                if _NESTED_QUANTIFIER.search(value):
                    raise SpecError(
                        f"{path}.value",
                        "this pattern repeats a repeated group, which can hang matching — simplify it",
                    )
        out["value"] = value
    elif od.value == "list":
        if not isinstance(value, list) or not value:
            raise SpecError(f"{path}.value", "must be a non-empty list")
        if len(value) > _MAX_LIST:
            raise SpecError(f"{path}.value", f"must have at most {_MAX_LIST} entries")
        items = [str(v) for v in value if str(v) != ""]
        if fd.kind == "enum":
            bad = [v for v in items if v not in fd.options]
            if bad:
                raise SpecError(f"{path}.value", f"unknown {fd.label}: {', '.join(bad)}")
        out["value"] = items
    return out


def _validate_threshold(t: Any) -> dict[str, Any]:
    if not isinstance(t, Mapping):
        raise SpecError("threshold", "is required for threshold rules")
    group_by = t.get("group_by") or []
    if not isinstance(group_by, list) or len(group_by) > 3:
        raise SpecError("threshold.group_by", "must be a list of up to 3 fields")
    for g in group_by:
        fd = FIELDS.get(g) if isinstance(g, str) else None
        if fd is None or not fd.groupable:
            raise SpecError("threshold.group_by", f"can't group by {g!r}")
    aggregate = _choice(t, "aggregate", ("count", "sum", "distinct"), "count")
    out: dict[str, Any] = {"group_by": list(group_by), "aggregate": aggregate}
    if aggregate != "count":
        field = t.get("field")
        fd = FIELDS.get(field) if isinstance(field, str) else None
        if fd is None:
            raise SpecError("threshold.field", "is required")
        if aggregate == "sum" and fd.kind != "number":
            raise SpecError("threshold.field", f"can't sum {fd.label}")
        out["field"] = field
    out["op"] = _choice(t, "op", ("gt", "gte", "lt", "lte", "eq"), "gte")
    value = _num(t.get("value"))
    if value is None:
        raise SpecError("threshold.value", "must be a number")
    out["value"] = value
    return out


def validate(spec: Any, *, allow_enforcement: bool | None = None) -> dict[str, Any]:
    """Validate and canonicalize a spec. Raises :class:`SpecError`."""
    if allow_enforcement is None:
        allow_enforcement = ENFORCEMENT_ENABLED
    if not isinstance(spec, Mapping):
        raise SpecError("", "rule must be an object")
    version = spec.get("version", SPEC_VERSION)
    if version != SPEC_VERSION:
        raise SpecError("version", f"unsupported version {version!r}")
    out: dict[str, Any] = {
        "version": SPEC_VERSION,
        "name": _text(spec, "name", _MAX_NAME, required=True),
        "description": _text(spec, "description", _MAX_REC),
        "pillar": _choice(spec, "pillar", PILLARS, "security"),
        "severity": _choice(spec, "severity", SEVERITIES, "warn"),
        "type": _choice(spec, "type", RULE_TYPES, "match"),
        "recommendation": _text(spec, "recommendation", _MAX_REC),
        "action": _choice(spec, "action", ACTIONS, "finding"),
    }
    if out["action"] in ENFORCEMENT_ACTIONS and not allow_enforcement:
        raise SpecError("action", "blocking rules aren't available yet — use 'finding'")

    scope = spec.get("scope") or {}
    if not isinstance(scope, Mapping):
        raise SpecError("scope", "must be an object")
    sources = scope.get("sources") or []
    if not isinstance(sources, list) or any(s not in SOURCES for s in sources):
        raise SpecError("scope.sources", f"must be a list of {', '.join(SOURCES)}")
    projects = scope.get("projects") or []
    if (not isinstance(projects, list) or len(projects) > _MAX_LIST
            or any(not isinstance(p, str) or not p.strip() or len(p) > _MAX_TEXT for p in projects)):
        raise SpecError("scope.projects", "must be a list of folder patterns")
    out["scope"] = {"sources": list(sources), "projects": [p.strip() for p in projects]}

    if "when" not in spec:
        raise SpecError("when", "add at least one condition")
    out["when"] = _validate_condition(spec["when"], "when", 0, _Counter())

    if out["type"] == "match":
        subject = spec.get("subject", "target")
        if subject != "rule" and (subject not in FIELDS or not FIELDS[subject].groupable):
            raise SpecError("subject", f"can't report per {subject!r}")
        out["subject"] = subject
    else:
        out["threshold"] = _validate_threshold(spec.get("threshold"))
        if out["action"] in ENFORCEMENT_ACTIONS:
            raise SpecError("action", "only match rules can block")
    return out


def _fields_used(node: Mapping[str, Any]) -> set[str]:
    if "all" in node or "any" in node:
        return set().union(*(_fields_used(c) for c in node.get("all") or node.get("any")))
    if "not" in node:
        return _fields_used(node["not"])
    return {node["field"]}


def enforceable(spec: Mapping[str, Any]) -> bool:
    """Whether the rule could be decided before a tool runs (match over pre fields)."""
    return spec["type"] == "match" and all(
        FIELDS[f].phase == "pre" for f in _fields_used(spec["when"])
    )


# --- compilation ----------------------------------------------------------------

Predicate = Callable[[Mapping[str, Any]], bool]


def _compile_leaf(node: Mapping[str, Any]) -> Predicate:
    field, op, value = node["field"], node["op"], node.get("value")
    kind = FIELDS[field].kind

    if op == "exists":
        return lambda f: f.get(field) not in (None, "")
    if op == "missing":
        return lambda f: f.get(field) in (None, "")
    if op == "is_sensitive_path":
        return lambda f: _sensitive_path(f.get(field))
    if op == "is_risky_command":
        return lambda f: _risky_command(f.get(field))
    if op == "outside_project":
        return _outside_project

    if kind == "number":
        ops: dict[str, Callable[[float, float], bool]] = {
            "eq": lambda a, b: a == b, "ne": lambda a, b: a != b,
            "gt": lambda a, b: a > b, "gte": lambda a, b: a >= b,
            "lt": lambda a, b: a < b, "lte": lambda a, b: a <= b,
        }
        cmp = ops[op]

        def num_pred(f: Mapping[str, Any]) -> bool:
            v = _num(f.get(field))
            return v is not None and cmp(v, value)

        return num_pred

    # Text and enum comparisons are case-insensitive: users type "Bash", agents say "bash".
    if op in ("in", "not_in"):
        wanted = {str(v).lower() for v in value}
        if op == "in":
            return lambda f: _as_text(f.get(field)).lower() in wanted
        return lambda f: f.get(field) not in (None, "") and _as_text(f.get(field)).lower() not in wanted
    if op == "regex":
        pat = re.compile(value, re.IGNORECASE)
        return lambda f: f.get(field) is not None and pat.search(_as_text(f.get(field))) is not None
    if op == "glob":
        pattern = _expand(value).lower()
        return lambda f: f.get(field) is not None and fnmatch.fnmatchcase(
            os.path.expanduser(_as_text(f.get(field))).lower(), pattern
        )
    v = str(value).lower()
    text_ops: dict[str, Callable[[str], bool]] = {
        "eq": lambda s: s == v,
        "ne": lambda s: s != v,
        "contains": lambda s: v in s,
        "not_contains": lambda s: v not in s,
        "starts_with": lambda s: s.startswith(v),
        "ends_with": lambda s: s.endswith(v),
    }
    test = text_ops[op]
    if op in ("ne", "not_contains"):
        return lambda f: f.get(field) in (None, "") or test(_as_text(f.get(field)).lower())
    return lambda f: f.get(field) is not None and test(_as_text(f.get(field)).lower())


def compile_condition(node: Mapping[str, Any]) -> Predicate:
    if "all" in node:
        parts = [compile_condition(c) for c in node["all"]]
        return lambda f: all(p(f) for p in parts)
    if "any" in node:
        parts = [compile_condition(c) for c in node["any"]]
        return lambda f: any(p(f) for p in parts)
    if "not" in node:
        inner = compile_condition(node["not"])
        return lambda f: not inner(f)
    return _compile_leaf(node)


def _compile_scope(scope: Mapping[str, Any]) -> Predicate:
    sources = {s.lower() for s in scope.get("sources") or []}
    projects = [_expand(p).rstrip("/") for p in scope.get("projects") or []]

    def in_project(cwd: Any) -> bool:
        if not cwd:
            return False
        path = os.path.expanduser(str(cwd)).rstrip("/")
        return any(
            fnmatch.fnmatchcase(path, p) or path == p or path.startswith(p + "/")
            for p in projects
        )

    def pred(f: Mapping[str, Any]) -> bool:
        if sources and _as_text(f.get("source")).lower() not in sources:
            return False
        return not projects or in_project(f.get("project"))

    return pred


@dataclass
class CompiledRule:
    id: str
    spec: dict[str, Any]
    enabled: bool
    predicate: Predicate  # scope AND when
    enforceable: bool

    @property
    def name(self) -> str:
        return self.spec["name"]

    def matches(self, facts: Mapping[str, Any]) -> bool:
        return self.predicate(facts)

    def run(self, snap: Snapshot) -> list[dict[str, Any]]:
        if self.spec["type"] == "threshold":
            return self._run_threshold(snap)
        return self._run_match(snap)

    # Claude/Codex store a start row before every tool result; skip it so
    # counts are per call — mirrors ``insights._is_tool_start``.
    def matching(self, snap: Snapshot) -> list[tuple[Event, dict[str, Any]]]:
        return [(e, facts) for e, facts in snapshot_facts(snap) if self.predicate(facts)]

    def _run_match(self, snap: Snapshot) -> list[dict[str, Any]]:
        subject = self.spec["subject"]
        groups: dict[str, list[tuple[Event, dict[str, Any]]]] = {}
        for e, facts in self.matching(snap):
            key = "rule" if subject == "rule" else _as_text(facts.get(subject)) or "(empty)"
            groups.setdefault(key, []).append((e, facts))
        ranked = sorted(groups.items(), key=lambda kv: len(kv[1]), reverse=True)
        out = []
        for key, hits in ranked[:_MAX_FINDINGS_PER_RULE]:
            sessions = {e.session_id for e, _ in hits}
            n = len(hits)
            label = FIELDS[subject].label.lower() if subject != "rule" else None
            detail = (
                f"Matched {n} time(s) across {len(sessions)} session(s)."
                if subject == "rule"
                else f"{label.capitalize()} `{key[:120]}` matched {n} time(s) across {len(sessions)} session(s)."
            )
            out.append(self._finding(
                key, n, "matches", detail, [e for e, _ in reversed(hits)],
            ))
        return out

    def _run_threshold(self, snap: Snapshot) -> list[dict[str, Any]]:
        t = self.spec["threshold"]
        groups: dict[tuple[str, ...], dict[str, Any]] = {}
        for e, facts in self.matching(snap):
            key = tuple(_as_text(facts.get(g)) for g in t["group_by"])
            g = groups.setdefault(key, {"n": 0, "sum": 0.0, "distinct": set(), "events": []})
            g["n"] += 1
            if t["aggregate"] == "sum":
                g["sum"] += _num(facts.get(t["field"])) or 0.0
            elif t["aggregate"] == "distinct":
                v = facts.get(t["field"])
                if v not in (None, ""):
                    g["distinct"].add(_as_text(v))
            g["events"].append(e)
        cmp = {
            "gt": lambda a, b: a > b, "gte": lambda a, b: a >= b,
            "lt": lambda a, b: a < b, "lte": lambda a, b: a <= b, "eq": lambda a, b: a == b,
        }[t["op"]]
        rows = []
        for key, g in groups.items():
            value = (
                g["n"] if t["aggregate"] == "count"
                else round(g["sum"], 4) if t["aggregate"] == "sum"
                else len(g["distinct"])
            )
            if cmp(value, t["value"]):
                rows.append((key, value, g))
        rows.sort(key=lambda r: r[1], reverse=True)
        unit = (
            "events" if t["aggregate"] == "count"
            else FIELDS[t["field"]].label.lower() if t["aggregate"] == "sum"
            else f"distinct {FIELDS[t['field']].label.lower()}"
        )
        out = []
        for key, value, g in rows[:_MAX_FINDINGS_PER_RULE]:
            parts = [
                f"{FIELDS[f].label} `{v[:80]}`" for f, v in zip(t["group_by"], key) if v
            ]
            where = ", ".join(parts) or "Across all activity"
            shown = f"{value:g}" if isinstance(value, float) else str(value)
            detail = f"{where}: {shown} {unit} (limit {_OP_SYMBOL[t['op']]} {t['value']:g})."
            out.append(self._finding(
                "|".join(key) or "all", value, unit, detail, list(reversed(g["events"])),
            ))
        return out

    def _finding(
        self, subject: str, value: Any, unit: str, detail: str, events: list[Event]
    ) -> dict[str, Any]:
        spec = self.spec
        title = spec["name"] if subject in ("rule", "all") else f"{spec['name']}: {subject[:80]}"
        return {
            "id": self.id,
            "fingerprint": fingerprint(self.id, subject),
            "group_title": spec["name"],
            "pillar": spec["pillar"],
            "tier": 2,
            "severity": spec["severity"],
            "title": title,
            "detail": detail,
            "recommendation": spec.get("recommendation") or "Review the matching activity.",
            "metric": {"value": value, "unit": unit, "label": unit},
            "evidence": [
                {
                    "session_id": e.session_id,
                    "event_id": e.id,
                    "label": (e.target or e.title or e.tool or e.category or "event")[:200],
                    "value": e.status,
                    "ts": e.ts,
                }
                for e in events[:_EVIDENCE_CAP]
            ],
            "user_rule": True,
        }


def fingerprint(rule_id: str, subject: str) -> str:
    return hashlib.sha1(f"{rule_id}|{subject}".encode("utf-8"), usedforsecurity=False).hexdigest()


def compile_rule(rule_id: str, spec: dict[str, Any], enabled: bool = True) -> CompiledRule:
    when = compile_condition(spec["when"])
    scope = _compile_scope(spec.get("scope") or {})
    return CompiledRule(
        id=rule_id,
        spec=spec,
        enabled=enabled,
        predicate=lambda f: scope(f) and when(f),
        enforceable=enforceable(spec),
    )


# --- enforcement (not wired to the bridge yet) -------------------------------------


@dataclass(frozen=True)
class Decision:
    action: str  # "ask" | "deny"
    rule_id: str
    rule_name: str
    reason: str


_ACTION_RANK = {"deny": 0, "ask": 1}


def decide(facts: Mapping[str, Any], rules: list[CompiledRule] | None = None) -> Decision | None:
    """The strictest enforcement decision for a pending tool call, or None to allow.

    Only enabled, enforceable rules with an ``ask``/``deny`` action take part.
    A future synchronous ``PreToolUse`` endpoint calls this with
    :func:`facts_from_hook`; the bridge maps the decision onto each agent's
    hook response (Claude ``permissionDecision``, Cursor ``permission``, …).
    """
    pool = rules if rules is not None else compiled_rules()
    best: Decision | None = None
    for r in pool:
        action = r.spec.get("action")
        if not r.enabled or not r.enforceable or action not in ENFORCEMENT_ACTIONS:
            continue
        if not r.matches(facts):
            continue
        d = Decision(
            action=action,
            rule_id=r.id,
            rule_name=r.name,
            reason=r.spec.get("recommendation") or f"Blocked by cot rule “{r.name}”.",
        )
        if best is None or _ACTION_RANK[action] < _ACTION_RANK[best.action]:
            best = d
    return best


# --- storage & cache --------------------------------------------------------------

_cache: dict[str, Any] = {"key": None, "rules": []}


def _invalidate() -> None:
    _cache["key"] = None


def compiled_rules() -> list[CompiledRule]:
    """All stored rules, compiled once per change (cached on the rule set's version)."""
    key = db.user_rules_version()
    if _cache["key"] != key:
        rules = []
        for row in db.list_user_rules():
            try:
                spec = validate(json.loads(row["spec"]), allow_enforcement=True)
            except (SpecError, json.JSONDecodeError):
                continue  # a spec that no longer validates is skipped, never crashes compute
            rules.append(compile_rule(row["id"], spec, bool(row["enabled"])))
        _cache["key"], _cache["rules"] = key, rules
    return _cache["rules"]


def active_rules() -> list[CompiledRule]:
    return [r for r in compiled_rules() if r.enabled]


def group_title(rule_id: str) -> str | None:
    for r in compiled_rules():
        if r.id == rule_id:
            return r.name
    return None


def _row_out(row: Mapping[str, Any]) -> dict[str, Any]:
    spec = json.loads(row["spec"])
    try:
        canonical = validate(spec, allow_enforcement=True)
        valid, error, can_enforce = True, None, enforceable(canonical)
    except SpecError as exc:
        valid, error, can_enforce = False, str(exc), False
    return {
        "id": row["id"],
        "spec": spec,
        "enabled": bool(row["enabled"]),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "valid": valid,
        "error": error,
        "enforceable": can_enforce,
    }


def list_rules() -> list[dict[str, Any]]:
    return [_row_out(r) for r in db.list_user_rules()]


def get_rule(rule_id: str) -> dict[str, Any] | None:
    row = db.get_user_rule(rule_id)
    return _row_out(row) if row else None


def create_rule(spec: Any, enabled: bool = True) -> dict[str, Any]:
    canonical = validate(spec)
    rule_id = ID_PREFIX + uuid.uuid4().hex[:10]
    db.upsert_user_rule(rule_id, json.dumps(canonical), enabled)
    _invalidate()
    return get_rule(rule_id)  # type: ignore[return-value]


def update_rule(rule_id: str, spec: Any | None = None, enabled: bool | None = None) -> dict[str, Any] | None:
    row = db.get_user_rule(rule_id)
    if row is None:
        return None
    spec_json = json.dumps(validate(spec)) if spec is not None else row["spec"]
    db.upsert_user_rule(rule_id, spec_json, bool(row["enabled"]) if enabled is None else enabled)
    if enabled is False or spec is not None:
        # A disabled or rewritten rule's old findings would otherwise linger as
        # active until the grace period; the next compute re-detects what still matches.
        db.delete_insight_findings_for_rule(rule_id)
    _invalidate()
    return get_rule(rule_id)


def delete_rule(rule_id: str) -> bool:
    ok = db.delete_user_rule(rule_id)
    if ok:
        db.delete_insight_findings_for_rule(rule_id)
        _invalidate()
    return ok


def preview(spec: Any, days: int = 30) -> dict[str, Any]:
    """Dry-run an unsaved spec over recent history. Nothing is persisted."""
    from .insights import cutoff_iso

    canonical = validate(spec)
    rule = compile_rule(ID_PREFIX + "preview", canonical)
    rows = db.read_rule_events(
        cutoff=cutoff_iso(days), with_detail="detail" in _fields_used(canonical["when"])
    )
    snap = Snapshot(events=[event_from_row(r) for r in rows])
    matched = rule.matching(snap)
    findings = rule.run(snap)
    examples: dict[str, dict[str, Any]] = {}
    for e, facts in matched:
        label = _as_text(facts.get("target") or facts.get("tool") or facts.get("title"))[:300] or "(no detail)"
        ex = examples.setdefault(label, {"label": label, "count": 0, "session_id": e.session_id, "event_id": e.id})
        ex["count"] += 1
        ex["session_id"], ex["event_id"] = e.session_id, e.id  # newest wins: events are ts-ordered per session
    top = sorted(examples.values(), key=lambda x: x["count"], reverse=True)[:6]
    return {
        "spec": canonical,
        "enforceable": rule.enforceable,
        "examples": top,
        "distinct_examples": len(examples),
        "window_days": days,
        "events_scanned": len(snap.events),
        "events_matched": len(matched),
        "sessions_matched": len({e.session_id for e, _ in matched}),
        "findings": findings,
    }


def schema() -> dict[str, Any]:
    """Everything the form builder needs to render fields and operators."""
    return {
        "version": SPEC_VERSION,
        "types": list(RULE_TYPES),
        "pillars": list(PILLARS),
        "severities": list(SEVERITIES),
        "actions": [a for a in ACTIONS if ENFORCEMENT_ENABLED or a not in ENFORCEMENT_ACTIONS],
        "enforcement_enabled": ENFORCEMENT_ENABLED,
        "sources": list(SOURCES),
        "fields": [
            {"name": f.name, "label": f.label, "kind": f.kind, "phase": f.phase,
             "options": list(f.options), "groupable": f.groupable}
            for f in FIELDS.values()
        ],
        "operators": [
            {"name": o.name, "label": o.label, "kinds": list(o.kinds), "value": o.value}
            for o in OPERATORS.values()
        ],
        "aggregates": ["count", "sum", "distinct"],
    }
