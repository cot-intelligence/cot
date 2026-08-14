"""Translate raw Claude Code / Cursor / Codex hook payloads into a common shape + category."""

from __future__ import annotations

import json
import re
from typing import Any, Literal

from . import timeutil
from .tool_classification import (
    ToolInvocation,
    canonical_tool as _canonical_tool,
    classify_cursor_hook,
    classify_tool,
    coerce_tool_input as _coerce_tool_input,
    cursor_tool as _cursor_tool,
    is_tool_hook as _is_tool_hook,
    subagent_key as _subagent_key,
    subagent_label as _subagent_label,
)

Source = str  # 'claude' | 'cursor' | 'codex'
LifecycleBoundary = Literal["session_start", "turn_end", "session_end"]
APPROVAL_REVIEW_PREFIX = "The following is the Codex agent history"

_START_HOOKS = {
    "PreToolUse",
    "UserPromptSubmit",
    "beforeSubmitPrompt",
    "beforeShellExecution",
    "beforeMCPExecution",
    "beforeReadFile",
    "preToolUse",
    "subagentStart",
    "SubagentStart",
    "sessionStart",
}
_END_HOOKS = {
    "PostToolUse",
    "postToolUse",
    "afterFileEdit",
    "afterShellExecution",
    "afterMCPExecution",
    "Stop",
    "SubagentStop",
    "subagentStop",
    "stop",
    "sessionEnd",
}


def _phase(hook: str) -> str:
    if hook in _START_HOOKS:
        return "start"
    if hook in _END_HOOKS:
        return "end"
    return "instant"


def lifecycle_boundary(source: Source, hook: str) -> LifecycleBoundary | None:
    """Classify lifecycle hooks once for both display and Session state."""
    if hook in ("SessionStart", "sessionStart"):
        return "session_start"
    if hook in ("SessionEnd", "sessionEnd"):
        return "session_end"
    if hook in ("Stop", "stop"):
        return "turn_end" if source == "claude" else "session_end"
    return None


def _short(text: str | None, limit: int = 80) -> str:
    if not text:
        return ""
    text = str(text).strip().replace("\n", " ")
    return text if len(text) <= limit else text[: limit - 1] + "…"


_ENV_CONTEXT_RE = re.compile(r"<environment_context>.*?</environment_context>", re.S)
_UPLOADED_DOCS_RE = re.compile(r"<uploaded_documents>.*?</uploaded_documents>", re.S)
_EMPTY_IMAGE_RE = re.compile(r"<image\b[^>]*>\s*</image>", re.S)
_USER_QUERY_RE = re.compile(r"<user_query>\s*(.*?)\s*</user_query>", re.S)
_CODEX_REQUEST_MARKER = "## My request for Codex:"


def clean_prompt_wrappers(text: Any) -> str:
    """Strip agent-injected scaffolding so the stored prompt is the user's words.

    Codex wraps clipboard/file uploads in a ``# Files mentioned by the user:`` …
    ``## My request for Codex:`` preamble and injects ``<environment_context>``;
    Cursor wraps the prompt in ``<user_query>``. None of that is what the human
    typed, so it is removed here — the single chokepoint for every source and
    both the hook and import paths."""
    out = _ENV_CONTEXT_RE.sub("", str(text or "")).strip()
    match = _USER_QUERY_RE.search(out)
    if match:
        out = match.group(1).strip()
    # The Files-mentioned preamble (paths/clipboard refs) precedes this marker;
    # keep only the request that follows it.
    if _CODEX_REQUEST_MARKER in out:
        out = out.split(_CODEX_REQUEST_MARKER, 1)[1].strip()
    out = _UPLOADED_DOCS_RE.sub("", out).strip()
    out = _EMPTY_IMAGE_RE.sub("", out).strip()
    return out


def _json_detail(obj: Any) -> str:
    return json.dumps(obj, indent=2, ensure_ascii=False, default=str)


def _is_failure(hook: str) -> bool:
    return hook in ("PostToolUseFailure", "postToolUseFailure")


def _tool_event(
    hook: str,
    tool_name: str,
    tool_input: dict[str, Any],
    tool_response: Any,
    body: dict[str, Any],
    duration_ms: int | None,
) -> dict[str, Any] | None:
    return classify_tool(
        ToolInvocation(
            name=tool_name,
            input=tool_input,
            response=tool_response,
            status="error" if _is_failure(hook) else "ok",
            duration_ms=duration_ms,
            body=body,
            raw_input=body.get("tool_input"),
        )
    )


def categorize(source: Source, hook: str, body: dict[str, Any], tool: str | None) -> dict[str, Any]:
    """Map hook/tool to category + display fields. Full content in detail."""
    body = body or {}
    # Cursor reports elapsed time as ``duration`` (float ms); Claude/Codex hooks
    # don't carry one, but accept ``duration_ms`` for forward-compat.
    duration_ms = body.get("duration_ms")
    if duration_ms is None:
        duration_ms = body.get("duration")
    if duration_ms is not None:
        try:
            duration_ms = int(duration_ms)
        except (TypeError, ValueError):
            duration_ms = None

    # --- Environment context (agent-injected, not a user prompt) ---
    if hook == "CodexEnvironmentContext":
        return {
            "category": "lifecycle",
            "title": "Environment context",
            "target": body.get("cwd"),
            "detail": str(body.get("environment_context") or ""),
            "status": "ok",
            "duration_ms": duration_ms,
        }

    # --- Prompts ---
    if hook in ("UserPromptSubmit", "beforeSubmitPrompt"):
        prompt = body.get("prompt") or body.get("user_message") or ""
        return {
            "category": "prompt",
            "title": "User prompt",
            "target": None,
            "detail": clean_prompt_wrappers(prompt),
            "status": "ok",
            "duration_ms": duration_ms,
        }

    # --- Responses / thoughts ---
    # A user-stop marks the cut-off thought/response as interrupted.
    msg_status = "interrupted" if body.get("interrupted") else "ok"
    if hook == "afterAgentResponse":
        text = body.get("response") or body.get("text") or body.get("message") or ""
        return {
            "category": "response",
            "title": "Agent response",
            "target": None,
            "detail": str(text),
            "status": msg_status,
            "duration_ms": duration_ms,
        }
    if hook == "afterAgentThought":
        text = body.get("thought") or body.get("text") or body.get("message") or ""
        return {
            "category": "thought",
            "title": "Agent thought",
            "target": None,
            "detail": str(text),
            "status": msg_status,
            "duration_ms": duration_ms,
        }

    # --- Lifecycle ---
    boundary = lifecycle_boundary(source, hook)
    if boundary == "session_start":
        return {
            "category": "lifecycle",
            "title": "Session started",
            "target": body.get("cwd"),
            "detail": _json_detail(body),
            "status": "ok",
            "duration_ms": duration_ms,
        }
    if boundary == "session_end":
        return {
            "category": "lifecycle",
            "title": "Session ended",
            "target": None,
            "detail": _json_detail(body),
            "status": "ok",
            "duration_ms": duration_ms,
        }
    if boundary == "turn_end":
        return {
            "category": "lifecycle",
            "title": "Turn ended",
            "target": None,
            "detail": _json_detail(body),
            "status": "ok",
            "duration_ms": duration_ms,
        }

    # --- Subagents (before lifecycle used to swallow subagentStop) ---
    if hook in ("subagentStart", "SubagentStart", "subagentStop", "SubagentStop"):
        tool_input = body.get("tool_input") if isinstance(body.get("tool_input"), dict) else {}
        key = _subagent_key(body)
        label = _subagent_label(body, tool_input)
        return {
            "category": "subagent",
            "title": label,
            "target": key or label,
            "detail": _json_detail(body),
            "status": "ok",
            "duration_ms": duration_ms,
        }

    # --- Compaction ---
    if hook in ("PreCompact", "preCompact", "PostCompact", "postCompact"):
        return {
            "category": "compaction",
            "title": "Context compaction",
            "target": None,
            "detail": _json_detail(body),
            "status": "ok",
            "duration_ms": duration_ms,
        }

    # --- Notifications / permissions ---
    if hook == "Notification":
        return {
            "category": "notification",
            "title": "Notification",
            "target": None,
            "detail": _json_detail(body),
            "status": "ok",
            "duration_ms": duration_ms,
        }
    if hook in ("PermissionRequest", "PermissionDenied"):
        return {
            "category": "permission",
            "title": hook,
            "target": body.get("tool_name"),
            "detail": _json_detail(body),
            "status": "blocked" if hook == "PermissionDenied" else "pending",
            "duration_ms": duration_ms,
        }

    # --- Tool calls ---
    tool_name = _canonical_tool(tool or body.get("tool_name") or "")
    tool_input = _coerce_tool_input(body.get("tool_input"))
    tool_response = body.get("tool_response") or body.get("tool_output") or {}

    # A tool-use hook (any casing, any source) with a tool name is a tool call.
    # Imported Cursor history rides Claude-style capitalized hooks, so gating
    # this on source previously dropped every Cursor tool call into ``other``.
    if tool_name and _is_tool_hook(hook):
        res = _tool_event(hook, tool_name, tool_input, tool_response, body, duration_ms)
        if res is not None:
            return res

    # --- Cursor hook-based ---
    if source == "cursor":
        res = classify_cursor_hook(hook, body, duration_ms)
        if res is not None:
            return res
        if hook in ("preToolUse", "postToolUse", "postToolUseFailure"):
            tn = _canonical_tool(body.get("tool_name") or tool or "")
            if tn:
                res = _tool_event(hook, tn, tool_input, tool_response, body, duration_ms)
                if res is not None:
                    return res

    # --- Response events injected by bridge ---
    if body.get("_synthetic_category") == "response":
        return {
            "category": "response",
            "title": "Agent response",
            "target": None,
            "detail": body.get("response") or _json_detail(body),
            "status": msg_status,
            "duration_ms": duration_ms,
        }
    if body.get("_synthetic_category") == "thought":
        return {
            "category": "thought",
            "title": "Agent thought",
            "target": None,
            "detail": body.get("thought") or body.get("text") or _json_detail(body),
            "status": msg_status,
            "duration_ms": duration_ms,
        }
    # Plan-mode plan recovered from the Cursor transcript (the CreatePlan tool
    # fires no hooks, so the bridge reconstructs it). Structured todos ride in
    # detail for the frontend's checklist render.
    if body.get("_synthetic_category") == "plan":
        todos = body.get("plan_todos")
        return {
            "category": "plan",
            "title": _short(body.get("plan_name") or "Plan", 120),
            "target": None,
            "detail": _json_detail(
                {
                    "overview": body.get("plan_overview") or "",
                    "plan": body.get("plan_body") or "",
                    "todos": todos if isinstance(todos, list) else [],
                }
            ),
            "status": "ok",
            "duration_ms": duration_ms,
        }

    return {
        "category": "other",
        "title": hook,
        "target": tool or body.get("tool_name"),
        "detail": _json_detail(body),
        "status": "ok",
        "duration_ms": duration_ms,
    }


def _clean_model(model: Any) -> str | None:
    if not isinstance(model, str):
        return None
    model = model.strip()
    if not model or model.lower() == "default":
        return None
    return model


def _tokens(body: dict[str, Any]) -> dict[str, int | None]:
    """Pull token counts from a hook body. Claude rides them in a ``usage`` dict
    (from the transcript); accept flat keys too for forward-compat."""
    usage = body.get("usage") if isinstance(body.get("usage"), dict) else {}

    def pick(*keys: str) -> int | None:
        for src in (body, usage):
            for k in keys:
                v = src.get(k)
                if isinstance(v, (int, float)):
                    return int(v)
        return None

    return {
        "input_tokens": pick("input_tokens"),
        "output_tokens": pick("output_tokens"),
        "cache_read_tokens": pick(
            "cache_read_tokens", "cache_read_input_tokens", "cached_input_tokens"
        ),
        "cache_write_tokens": pick("cache_write_tokens", "cache_creation_input_tokens"),
    }


# Fields only ever present on Cursor hook payloads.
_CURSOR_MARKERS = ("cursor_version", "composer_mode", "conversation_id")


def _real_source(source: Source, body: dict[str, Any]) -> Source:
    """Trust the payload shape over the endpoint. Cursor (Claude-Code-compatible)
    also runs the hooks in ~/.claude/settings.json, so Cursor payloads arrive on
    the /claude endpoint too — classify those as cursor regardless."""
    if any(k in body for k in _CURSOR_MARKERS):
        return "cursor"
    return source


def normalize(source: Source, body: dict[str, Any] | None) -> dict[str, Any]:
    body = body or {}
    source = _real_source(source, body)
    hook = (
        body.get("hook_event_name")
        or body.get("hook")
        or body.get("event")
        or "unknown"
    )

    if source == "cursor":
        session_id = (
            body.get("conversation_id")
            or body.get("session_id")
            or body.get("generation_id")
            or "unknown"
        )
        cwd = body.get("cwd")
        roots = body.get("workspace_roots")
        if not cwd and isinstance(roots, list) and roots:
            cwd = roots[0]
        tool = _cursor_tool(hook, body)
    else:
        # Claude Code and Codex both ride Claude-Code-style stdin payloads.
        if source != "codex":
            source = "claude"
        session_id = body.get("session_id") or "unknown"
        cwd = body.get("cwd")
        tool = body.get("tool_name")

    norm = {
        "source": source,
        "hook": hook,
        "session_id": str(session_id),
        "cwd": cwd,
        "tool": tool,
        "phase": _phase(hook),
        "ts": body.get("timestamp") or timeutil.now(),
        # Model behind this event when known. Cursor sends it on every hook;
        # for Claude it rides along on synthetic response events (from the
        # transcript) — plain tool hooks don't carry it. Cursor's "default"
        # placeholder is not a real model id, so treat it as unknown.
        "model": _clean_model(body.get("model")),
        **_tokens(body),
    }
    cat = categorize(source, hook, body, tool)
    norm.update(cat)
    return norm
