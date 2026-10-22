"""Analysis personas: who a report is for, what it looks for, how it reads, and
which deliverables it ends with.

A persona is more than a prompt. Its outline fixes the report's sections so two
runs of the same persona compare side by side, and its deliverable kinds fix
what the person walks away with. The investigation underneath is shared.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

# What each deliverable kind is and the extra fields it carries. Every
# deliverable also has title, body (markdown) and evidence (event ids).
DELIVERABLE_KINDS: dict[str, dict[str, Any]] = {
    "prompt_rewrite": {
        "label": "Prompt rewrite",
        "about": "One of the person's real prompts rewritten so the agent gets it right first time.",
        "fields": {"before": "the original prompt, verbatim", "after": "the rewritten prompt"},
    },
    "memory_edit": {
        "label": "Project instructions",
        "about": "Text to append to the project's CLAUDE.md or AGENTS.md so the lesson sticks across sessions.",
        "fields": {"file": "CLAUDE.md or AGENTS.md", "append": "the exact markdown to append"},
    },
    "rule": {
        "label": "cot rule",
        "about": "A cot rule that raises a finding the next time this pattern happens.",
        "fields": {"rule_text": "plain-English description of what to catch", "rule_spec": "the rule spec JSON (schema below)"},
    },
    "checklist": {"label": "Checklist", "about": "A short markdown checklist the person keeps using.", "fields": {}},
    "root_cause": {"label": "Root-cause write-up", "about": "What failed, why, the failing steps in order, and the fix.", "fields": {}},
    "cost_table": {"label": "Cost breakdown", "about": "A markdown table of where the money went (by model, phase or step) with totals.", "fields": {}},
    "config_change": {
        "label": "Config change",
        "about": "A specific settings or setup change (model choice, MCP servers to disable, context trimming, permission allowlist) with what it saves or prevents.",
        "fields": {"savings_usd": "estimated dollars saved per similar session, or null"},
    },
    "risk_register": {"label": "Risk register", "about": "A markdown table: what was touched, why it matters, severity (info/review/high), what to do. Never say 'breached'.", "fields": {}},
    "summary": {"label": "Shareable summary", "about": "A plain-language markdown summary someone outside the session can read: goal, outcome, time, blockers.", "fields": {}},
    "task_list": {"label": "Follow-up tasks", "about": "Concrete follow-up tasks as a markdown checklist, each one line, most important first.", "fields": {}},
}


@dataclass(frozen=True)
class Persona:
    key: str
    name: str
    blurb: str
    focus: str
    outline: tuple[str, ...]
    deliverables: tuple[str, ...]
    across_outline: tuple[str, ...]
    starters: tuple[str, ...] = field(default_factory=tuple)

    def to_dict(self) -> dict[str, Any]:
        return {
            "key": self.key,
            "name": self.name,
            "blurb": self.blurb,
            "outline": list(self.outline),
            "across_outline": list(self.across_outline),
            "deliverables": [
                {"kind": k, "label": DELIVERABLE_KINDS[k]["label"]} for k in self.deliverables
            ],
            "starters": list(self.starters),
        }


PERSONAS: dict[str, Persona] = {p.key: p for p in (
    Persona(
        key="coach",
        name="Prompt coach",
        blurb="How you asked, and how to ask so the agent gets it right the first time.",
        focus=(
            "Read the person's prompts closely. Find vague asks, constraints stated late or "
            "repeated, missing context the agent had to go and discover, and follow-ups that "
            "caused rework. Tie each to what it cost (turns, minutes, reverted edits)."
        ),
        outline=("How you asked", "Where it cost you", "What to change"),
        across_outline=("Your prompting habits", "Patterns that cost you", "What to change"),
        deliverables=("prompt_rewrite", "memory_edit", "checklist"),
        starters=("Which of my prompts caused the most rework?",),
    ),
    Persona(
        key="debugger",
        name="Agent debugger",
        blurb="Where the agent got stuck, looped, or went off track, and why.",
        focus=(
            "Trace where the agent went wrong: retry loops on unchanged commands, edits to files "
            "it never read, wrong assumptions, ignored errors, abandoned approaches. Read the "
            "failing steps' full output before naming a root cause."
        ),
        outline=("What happened", "Root cause", "Where it went off track", "How to prevent it"),
        across_outline=("Recurring failure modes", "Root causes", "How to prevent them"),
        deliverables=("root_cause", "memory_edit", "rule"),
        starters=("Why did this take so long?",),
    ),
    Persona(
        key="cost",
        name="Cost optimizer",
        blurb="What made the session expensive and what would have cut it.",
        focus=(
            "Find where tokens and dollars went: heavy reads of unchanged files, long outputs kept "
            "in context, cache misses, an expensive model on simple work, preamble overhead from "
            "memory files, skills and MCP servers. Quantify savings in dollars where you can."
        ),
        outline=("Where the money went", "Waste", "What to change"),
        across_outline=("Where your money goes", "Biggest sources of waste", "What to change"),
        deliverables=("cost_table", "config_change", "memory_edit"),
        starters=("Where did the tokens go?",),
    ),
    Persona(
        key="security",
        name="Security reviewer",
        blurb="Risky commands, secrets touched, and permissions the agent used.",
        focus=(
            "Review what the agent touched: destructive or privileged commands, secrets or "
            "credential files read into context, network calls and installs, permission prompts "
            "approved. Use calm wording ('review', never 'breached'); say clearly when nothing "
            "risky happened."
        ),
        outline=("What the agent touched", "Risks to review", "Recommended guardrails"),
        across_outline=("What your agents touch", "Risks to review", "Recommended guardrails"),
        deliverables=("risk_register", "rule", "config_change"),
        starters=("Did anything risky run?",),
    ),
    Persona(
        key="manager",
        name="Engineering manager",
        blurb="A plain-language recap: what shipped, what is left, and how it went.",
        focus=(
            "Recap for someone who was not there: the goal, what got done (files, tests, "
            "outcome), how long it took, where time went, and what is left open. Plain language, "
            "no jargon the reader would need the session to understand."
        ),
        outline=("What got done", "How it went", "What's left"),
        across_outline=("What got done", "How the work went", "What's left"),
        deliverables=("summary", "task_list"),
        starters=("Write me a recap I can share.",),
    ),
    Persona(
        key="custom",
        name="Custom question",
        blurb="Ask anything about the session; the report answers it.",
        focus="Answer the person's question directly, then back it up.",
        outline=("Answer", "Details"),
        across_outline=("Answer", "Details"),
        deliverables=("checklist", "memory_edit", "rule", "task_list", "summary"),
    ),
)}


def get(key: str) -> Persona:
    persona = PERSONAS.get(key)
    if persona is None:
        raise ValueError(f"unknown persona {key!r}; one of {', '.join(PERSONAS)}")
    return persona


def catalog() -> dict[str, Any]:
    return {
        "personas": [p.to_dict() for p in PERSONAS.values()],
        "deliverable_kinds": {k: {"label": v["label"], "about": v["about"]} for k, v in DELIVERABLE_KINDS.items()},
    }
