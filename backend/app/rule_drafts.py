"""Starting points for user rules, so nobody has to write a spec from scratch.

Two ways in, both ending in an *unsaved* spec the user reviews (with the live
preview) before saving:

* :func:`from_event` — "Make a rule from this" on an event the user is looking
  at. Proposes a few generalizations of that one event (this exact command /
  any ``npm install`` / any ``npm``), most specific first, and pre-picks the
  middle ground: exact matches rarely recur, and the bare program is too broad.
* :func:`from_text` — a plain-English description turned into a spec by the
  user's configured AI provider (BYOK, explicit action, never polled). The model
  only ever sees the field/operator vocabulary and the user's sentence — never
  traces — and its output goes through :func:`user_rules.validate` like any
  hand-written spec, with one repair round-trip when it doesn't validate.
"""

from __future__ import annotations

import json
import os
import re
from typing import Any

from . import activity, ai_insights, db, user_rules

FILE_CATEGORIES = ("file_read", "context_read", "file_edit", "memory")


class DraftError(ValueError):
    """A draft couldn't be made (unknown event, unusable model output…)."""


def _leaf(field: str, op: str, value: Any = None) -> dict[str, Any]:
    out: dict[str, Any] = {"field": field, "op": op}
    if value is not None:
        out["value"] = value
    return out


def _choice(label: str, *leaves: dict[str, Any]) -> dict[str, Any]:
    return {"label": label, "conditions": list(leaves)}


# --- from an event --------------------------------------------------------------


def _shell_choices(command: str) -> list[dict[str, Any]]:
    parsed = activity.parse_command(command)
    core = " ".join((parsed.core or command).split())
    # Long targets are stored clipped with "…"; match the part that was kept.
    core = core.removesuffix("…").rstrip()
    choices = [_choice(f"Exactly `{core[:80]}`", _leaf("target", "contains", core[:500]))]
    if parsed.program and parsed.verb:
        phrase = f"{parsed.program} {parsed.verb}"
        if phrase.lower() in core.lower() and phrase != core:
            choices.append(_choice(f"Any `{phrase}` command", _leaf("target", "contains", phrase)))
    if parsed.program and parsed.program not in ("(script)",):
        word = parsed.program
        if all(word != c["conditions"][0].get("value") for c in choices):
            choices.append(_choice(f"Anything that runs `{word}`", _leaf("program", "eq", word)))
    return choices


def _file_choices(path: str, project: str | None) -> list[dict[str, Any]]:
    exact = _leaf("target", "starts_with", path[:-1]) if path.endswith("…") else _leaf("target", "eq", path)
    choices = [_choice(f"This file, `{os.path.basename(path) or path}`", exact)]
    base = os.path.basename(path.rstrip("/"))
    if base:
        choices.append(_choice(f"Any file named `{base}`", _leaf("target", "glob", f"*/{base}")))
    stem, ext = os.path.splitext(base)
    if ext and stem:
        choices.append(_choice(f"Any `*{ext}` file", _leaf("target", "glob", f"*{ext}")))
    folder = os.path.dirname(path)
    if folder and folder not in ("/", ""):
        label = folder.replace(project.rstrip("/"), ".", 1) if project and folder.startswith(project) else folder
        choices.append(_choice(f"Anything in `{label}/`", _leaf("target", "starts_with", folder.rstrip("/") + "/")))
    return choices


def _web_choices(target: str, title: str | None) -> list[dict[str, Any]]:
    web = activity.web_target(target, title)
    exact = _leaf("target", "starts_with", target[:-1]) if target.endswith("…") else _leaf("target", "eq", target)
    choices = [_choice("This exact URL", exact)]
    if web["kind"] == "fetch" and web["key"] != target:
        choices.append(_choice(f"Anything on `{web['key']}`", _leaf("target", "contains", web["key"])))
    return choices


def _mcp_choices(tool: str) -> list[dict[str, Any]]:
    choices = [_choice(f"The `{tool.split('__')[-1]}` tool", _leaf("tool", "eq", tool))]
    server = user_rules.mcp_server(tool)
    if server:
        choices.append(_choice(f"Any tool on the `{server}` server", _leaf("mcp_server", "eq", server)))
    return choices


_VERB = {
    "shell": "ran a command",
    "file_read": "read a file",
    "context_read": "read a file",
    "file_edit": "edited a file",
    "memory": "touched memory",
    "web": "went to the web",
    "mcp": "called an MCP tool",
}


def from_event(event_id: int) -> dict[str, Any]:
    """A draft rule built from one stored event, plus the alternatives offered."""
    row = db.get_rule_event(event_id)
    if row is None:
        raise DraftError("That event no longer exists.")
    category, target, tool = row["category"], row["target"] or "", row["tool"] or ""

    category_leaf: dict[str, Any] | None
    if category == "shell" and target:
        choices = _shell_choices(target)
        category_leaf = _leaf("category", "eq", "shell")
    elif category in FILE_CATEGORIES and target:
        choices = _file_choices(target, row["cwd"])
        reads = category in ("file_read", "context_read")
        category_leaf = _leaf("category", "in", ["file_read", "context_read"] if reads else [category])
    elif category == "web" and target:
        choices = _web_choices(target, row["title"])
        category_leaf = _leaf("category", "eq", "web")
    elif tool.startswith("mcp__") or category == "mcp":
        choices = _mcp_choices(tool or target)
        category_leaf = _leaf("category", "eq", "mcp")
    elif tool:
        choices = [_choice(f"The `{tool}` tool", _leaf("tool", "eq", tool))]
        category_leaf = None
    else:
        raise DraftError("Rules can be made from commands, files, web requests and tool calls.")

    pick = min(1, len(choices) - 1)
    failed = row["status"] == "error"
    when = [category_leaf] if category_leaf else []
    when += choices[pick]["conditions"]
    if failed:
        when.append(_leaf("status", "eq", "error"))
    verb = _VERB.get(category, "used a tool")
    spec = {
        "version": user_rules.SPEC_VERSION,
        "name": f"Agent {verb}: {choices[pick]['label'].lower().replace('`', '')}"[:120],
        "pillar": "usability" if failed or category == "mcp" else "security",
        "severity": "warn" if failed else "info",
        "type": "match",
        "scope": {"sources": [], "projects": []},
        "when": {"all": when},
        "subject": "mcp_server" if category == "mcp" or tool.startswith("mcp__") else "target",
        "recommendation": "",
        "action": "finding",
    }
    return {
        "spec": user_rules.validate(spec),
        "choices": choices,
        "picked": pick,
        "event": {
            "id": row["id"], "session_id": row["session_id"], "category": category,
            "tool": tool or None, "target": target or None, "failed": failed,
        },
    }


# --- from plain English -----------------------------------------------------------

_SYSTEM = """You turn a user's plain-English description into a rule for "cot", a local
observability tool for AI coding agents (Claude Code, Cursor, Codex, OpenCode).
A rule watches the events those agents produce and raises a finding when they match.

Reply with ONE JSON object and nothing else: the rule spec described below.

{schema}

Spec shape:
{{"version": 1, "name": str (short, sentence case), "pillar": "security"|"cost"|"usability",
  "severity": "info"|"warn"|"critical", "type": "match"|"threshold",
  "scope": {{"sources": [agent ids, empty = all], "projects": [folder globs, empty = all]}},
  "when": condition, "subject": field name or "rule" (match only: one finding per distinct value),
  "threshold": {{"group_by": [field], "aggregate": "count"|"sum"|"distinct", "field": field,
                 "op": "gt"|"gte"|"lt"|"lte"|"eq", "value": number}} (threshold only),
  "recommendation": str (one sentence: what the user should do about a match),
  "action": "finding"}}
condition = {{"all": [condition...]}} | {{"any": [condition...]}} | {{"not": condition}}
          | {{"field": name, "op": operator, "value": ...}}

Guidance:
- Narrow by "category" first (shell = commands, file_read/context_read = reads, file_edit = edits,
  web = URLs and searches, mcp = MCP tool calls), then by "target" (the command, path or URL).
- Prefer "contains", "starts_with" and "glob" over "regex"; use regex only when nothing else fits.
  Text matching is case-insensitive.
- Use the curated operators when they fit: is_sensitive_path, is_risky_command, outside_project.
- "fails" means status eq "error". "more than N times" means a threshold rule with op "gt".
- Money is cost_usd (sum it per session or project for budgets).
"""


def schema_text() -> str:
    """The field/operator vocabulary, for prompts that ask a model for a spec."""
    return _schema_text()


def _schema_text() -> str:
    s = user_rules.schema()
    fields = "\n".join(
        f"- {f['name']} ({f['kind']}{': ' + ', '.join(f['options']) if f['options'] else ''}) — {f['label']}"
        for f in s["fields"]
    )
    ops = "\n".join(
        f"- {o['name']} ({'/'.join(o['kinds'])}; value: {o['value']}) — {o['label']}" for o in s["operators"]
    )
    return f"Fields:\n{fields}\n\nOperators:\n{ops}"


_FENCE_RE = re.compile(r"^\s*```(?:json)?\s*|\s*```\s*$")


def _parse(text: str) -> Any:
    try:
        return json.loads(_FENCE_RE.sub("", text.strip()))
    except (json.JSONDecodeError, TypeError) as exc:
        raise DraftError("The AI reply wasn't a rule. Try rephrasing.") from exc


def from_text(text: str) -> dict[str, Any]:
    """Ask the configured AI provider for a spec matching ``text``; validated."""
    text = (text or "").strip()
    if not text:
        raise DraftError("Describe what you want to catch.")
    if len(text) > 1000:
        raise DraftError("Keep the description under 1000 characters.")
    system = _SYSTEM.format(schema=_schema_text())
    reply = ai_insights.complete(system, text)
    spec = _parse(reply)
    try:
        canonical = user_rules.validate(spec)
    except user_rules.SpecError as exc:
        # One repair round-trip with the validator's message, then give up.
        retry = ai_insights.complete(
            system,
            f"{text}\n\nYour previous reply was:\n{reply}\n\nIt was rejected: {exc}. "
            "Reply with the corrected JSON rule only.",
        )
        try:
            canonical = user_rules.validate(_parse(retry))
        except user_rules.SpecError as exc2:
            raise DraftError(f"The AI couldn't produce a valid rule ({exc2.message}). Try rephrasing.") from exc2
    return {"spec": canonical}
