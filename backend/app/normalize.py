"""Translate raw Claude Code / Cursor / Codex hook payloads into a common shape + category."""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from typing import Any

Source = str  # 'claude' | 'cursor' | 'codex'

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

_CONTEXT_PATTERNS = (
    re.compile(r"(^|/)CLAUDE\.md$", re.I),
    re.compile(r"(^|/)AGENTS\.md$", re.I),
    re.compile(r"(^|/)SKILL\.md$", re.I),
    re.compile(r"(^|/)\.cursor/rules/", re.I),
    re.compile(r"(^|/)\.claude/", re.I),
    re.compile(r"(^|/)skills?/", re.I),
)

_MEMORY_PATTERNS = (
    re.compile(r"(^|/)CLAUDE\.md$", re.I),
    re.compile(r"memory", re.I),
)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _phase(hook: str) -> str:
    if hook in _START_HOOKS:
        return "start"
    if hook in _END_HOOKS:
        return "end"
    return "instant"


def _matches(path: str | None, patterns: tuple[re.Pattern[str], ...]) -> bool:
    if not path:
        return False
    return any(p.search(path.replace("\\", "/")) for p in patterns)


def _short(text: str | None, limit: int = 80) -> str:
    if not text:
        return ""
    text = str(text).strip().replace("\n", " ")
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _subagent_key(body: dict[str, Any]) -> str | None:
    """Stable per-run id from hook payloads (Cursor subagent_id, tool_call_id, etc.)."""
    for field in ("subagent_id", "tool_call_id", "tool_use_id"):
        val = body.get(field)
        if isinstance(val, str) and val.strip():
            # Cursor ids sometimes carry a second line (fc_…); the call_ prefix is enough.
            return val.strip().split("\n")[0].strip()
    return None


def _subagent_label(body: dict[str, Any], tool_input: dict[str, Any] | None = None) -> str:
    ti = tool_input if isinstance(tool_input, dict) else {}
    if not ti:
        raw = body.get("tool_input")
        ti = raw if isinstance(raw, dict) else {}
    desc = body.get("description") or ti.get("description") or body.get("task") or ti.get("prompt")
    stype = body.get("subagent_type") or body.get("agent_type") or ti.get("subagent_type")
    if desc:
        desc = _short(str(desc), 80)
    if stype and desc:
        return f"{stype} · {desc}"
    return stype or desc or "Subagent"


def _json_detail(obj: Any) -> str:
    return json.dumps(obj, indent=2, ensure_ascii=False, default=str)


def _extract_path(body: dict[str, Any]) -> str | None:
    for key in ("file_path", "path", "target"):
        val = body.get(key)
        if isinstance(val, str) and val:
            return val
    tool_input = body.get("tool_input")
    if isinstance(tool_input, dict):
        for key in ("file_path", "path", "notebook_path"):
            val = tool_input.get(key)
            if isinstance(val, str) and val:
                return val
    edits = body.get("edits")
    if isinstance(edits, list) and edits:
        first = edits[0]
        if isinstance(first, dict) and first.get("file_path"):
            return str(first["file_path"])
    return None


_PATCH_FILE_RE = re.compile(r"\*\*\*\s+(?:Update|Add|Delete) File:\s*(.+)")


def _extract_patch_path(patch: Any) -> str | None:
    """Pull the target path out of a Codex ``apply_patch`` command body."""
    if not isinstance(patch, str):
        return None
    match = _PATCH_FILE_RE.search(patch)
    return match.group(1).strip() if match else None


def _parse_mcp(tool_name: str | None) -> tuple[str | None, str | None]:
    if not tool_name or not tool_name.startswith("mcp__"):
        return None, None
    parts = tool_name.split("__", 2)
    if len(parts) >= 3:
        return parts[1], parts[2]
    return tool_name, None


_BROWSER_NETWORK_TOOLS = frozenset({"browser_navigate"})


def _tool_basename(tool_name: str | None) -> str:
    if not tool_name:
        return ""
    if tool_name.startswith("MCP:"):
        return tool_name[4:]
    if tool_name.startswith("mcp__"):
        _, _, mcp_tool = _parse_mcp(tool_name)
        return mcp_tool or tool_name
    if "/" in tool_name:
        return tool_name.rsplit("/", 1)[-1]
    return tool_name


def _is_browser_network_tool(tool_name: str | None) -> bool:
    return _tool_basename(tool_name) in _BROWSER_NETWORK_TOOLS


def _coerce_tool_input(val: Any) -> dict[str, Any]:
    if isinstance(val, dict):
        return val
    if isinstance(val, str) and val.strip():
        try:
            parsed = json.loads(val)
            return parsed if isinstance(parsed, dict) else {}
        except json.JSONDecodeError:
            return {}
    return {}


def _extract_network_url(body: dict[str, Any]) -> str | None:
    tool_input = _coerce_tool_input(body.get("tool_input"))
    url = tool_input.get("url")
    if isinstance(url, str) and url.strip():
        return url.strip()
    result = body.get("result_json")
    if isinstance(result, str):
        match = re.search(r"Page URL:\s*(\S+)", result)
        if match:
            return match.group(1).rstrip("/")
    return None


def _extract_web_target(tool_input: dict[str, Any]) -> str:
    for key in ("url", "query", "search_term"):
        val = tool_input.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
    for key in ("queries", "search_terms"):
        vals = tool_input.get(key)
        if isinstance(vals, list):
            first = next((v.strip() for v in vals if isinstance(v, str) and v.strip()), "")
            if first:
                return first
    return ""


def _question_target(tool_input: dict[str, Any], title: str) -> str:
    questions = tool_input.get("questions")
    qlist = questions if isinstance(questions, list) else []
    qids = [
        str(q.get("id") or q.get("prompt") or q.get("question") or "")
        for q in qlist
        if isinstance(q, dict)
    ]
    key = "|".join(q for q in qids if q) or title
    return _short(key, 160)


def _web_call(
    *,
    title: str,
    target: str,
    detail: Any,
    status: str = "ok",
    duration_ms: int | None = None,
) -> dict[str, Any]:
    return {
        "category": "web",
        "title": title,
        "target": target,
        "detail": detail if isinstance(detail, str) else _json_detail(detail),
        "status": status,
        "duration_ms": duration_ms,
    }


def _cursor_tool(hook: str, body: dict[str, Any]) -> str | None:
    if hook in ("preToolUse", "postToolUse", "postToolUseFailure"):
        return body.get("tool_name")
    mapping = {
        "beforeShellExecution": "shell",
        "afterShellExecution": "shell",
        "afterFileEdit": "edit",
        "beforeReadFile": "read",
        "beforeMCPExecution": "mcp",
        "afterMCPExecution": "mcp",
    }
    if hook in mapping:
        return mapping[hook]
    return body.get("tool_name")


def _is_failure(hook: str) -> bool:
    return hook in ("PostToolUseFailure", "postToolUseFailure")


# Structured search tools that map to ``shell`` alongside Bash/Shell. Cursor
# uses Grep / Codebase / Search; Claude uses Glob / Grep.
_SEARCH_TOOLS = frozenset(
    {"Glob", "Grep", "Search", "Codebase", "GrepSearch", "FileSearch", "ListDir"}
)


def _tool_event(
    hook: str,
    tool_name: str,
    tool_input: dict[str, Any],
    tool_response: Any,
    body: dict[str, Any],
    duration_ms: int | None,
) -> dict[str, Any] | None:
    """Categorize one tool call. Shared by Claude, Codex, and Cursor so the same
    tool always lands in the same bucket regardless of which agent emitted it.
    Returns ``None`` for tool names we don't have a dedicated bucket for."""
    if not isinstance(tool_input, dict):
        tool_input = {}
    status = "error" if _is_failure(hook) else "ok"
    path = _extract_path(body)

    # The agent explicitly asking the user something — Claude's AskUserQuestion,
    # Cursor's AskQuestion, or Codex's request_user_input. These are the only
    # "questions" we tag: structured prompts shown to the user, never heuristics
    # over assistant prose.
    if tool_name in ("AskUserQuestion", "AskQuestion", "request_user_input"):
        questions = tool_input.get("questions")
        qlist = questions if isinstance(questions, list) else []
        first = next(
            (
                str(q.get("question") or q.get("prompt"))
                for q in qlist
                if isinstance(q, dict) and (q.get("question") or q.get("prompt"))
            ),
            "",
        )
        title = first or "Question for the user"
        if len(qlist) > 1:
            title = f"{title} (+{len(qlist) - 1} more)"
        return {
            "category": "question",
            "title": _short(title, 120),
            "target": _question_target(tool_input, title),
            "detail": _json_detail({"input": tool_input, "response": tool_response}),
            "status": status,
            "duration_ms": duration_ms,
        }

    # Codex routes file edits through apply_patch; the patch body carries the
    # target path rather than a discrete file_path field.
    if tool_name == "apply_patch":
        patch = tool_input.get("command")
        path = _extract_patch_path(patch) or path
        cat = "memory" if _matches(path, _MEMORY_PATTERNS) else "file_edit"
        return {
            "category": cat,
            "title": "Edit file",
            "target": path,
            "detail": _json_detail({"input": tool_input, "response": tool_response}),
            "status": status,
            "duration_ms": duration_ms,
        }
    if tool_name in ("Task", "Agent", "Subagent"):
        key = _subagent_key(body)
        label = _subagent_label(body, tool_input)
        return {
            "category": "subagent",
            "title": label,
            "target": key or label,
            "detail": _json_detail({"input": tool_input, "response": tool_response}),
            "status": "ok",
            "duration_ms": duration_ms,
        }
    if tool_name in ("Bash", "Shell"):
        cmd = tool_input.get("command", "")
        return {
            "category": "shell",
            "title": "Shell command",
            "target": _short(cmd, 120),
            "detail": _json_detail({"command": cmd, "response": tool_response}),
            "status": status,
            "duration_ms": duration_ms,
        }
    if tool_name in ("Read", "NotebookRead"):
        cat = "context_read" if _matches(path, _CONTEXT_PATTERNS) else "file_read"
        content = tool_response if isinstance(tool_response, str) else _json_detail(tool_response)
        return {
            "category": cat,
            "title": "Read file",
            "target": path,
            "detail": content or _json_detail({"input": tool_input, "response": tool_response}),
            "status": status,
            "duration_ms": duration_ms,
        }
    if tool_name in ("Write", "Edit", "MultiEdit", "NotebookEdit", "Delete"):
        cat = "memory" if _matches(path, _MEMORY_PATTERNS) else "file_edit"
        return {
            "category": cat,
            "title": "Delete file" if tool_name == "Delete" else "Edit file",
            "target": path,
            "detail": _json_detail({"input": tool_input, "response": tool_response}),
            "status": status,
            "duration_ms": duration_ms,
        }
    if tool_name in _SEARCH_TOOLS:
        pattern = (
            tool_input.get("pattern")
            or tool_input.get("glob_pattern")
            or tool_input.get("query")
            or tool_input.get("glob")
            or tool_input.get("path")
            or tool_input.get("file_path")
            or ""
        )
        return {
            "category": "shell",
            "title": tool_name,
            "target": _short(str(pattern)),
            "detail": _json_detail({"input": tool_input, "response": tool_response}),
            "status": status,
            "duration_ms": duration_ms,
        }
    if tool_name in ("WebFetch", "WebSearch"):
        target = _extract_web_target(tool_input)
        return _web_call(
            title=tool_name,
            target=target,
            detail={"input": tool_input, "response": tool_response},
            status=status,
            duration_ms=duration_ms,
        )
    if tool_name.startswith("mcp__") or tool_name.startswith("MCP:"):
        # Cursor names MCP tools "MCP:<tool>" with no server; Claude/Codex use
        # "mcp__<server>__<tool>".
        if tool_name.startswith("MCP:"):
            server, mcp_tool = None, tool_name[4:]
        else:
            server, mcp_tool = _parse_mcp(tool_name)
        if _is_browser_network_tool(mcp_tool):
            url = _extract_network_url(body) or tool_input.get("url")
            if url:
                return _web_call(
                    title="External network",
                    target=str(url),
                    detail={"input": tool_input, "response": tool_response},
                    status=status,
                    duration_ms=duration_ms,
                )
        label = server or mcp_tool or tool_name
        if server and mcp_tool:
            target = f"{server}/{mcp_tool}"
        else:
            target = mcp_tool or server or tool_name
        return {
            "category": "memory" if server == "memory" else "mcp",
            "title": f"MCP {label}",
            "target": target,
            "detail": _json_detail({"input": tool_input, "response": tool_response}),
            "status": status,
            "duration_ms": duration_ms,
        }
    return None


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

    # --- Prompts ---
    if hook in ("UserPromptSubmit", "beforeSubmitPrompt"):
        prompt = body.get("prompt") or body.get("user_message") or ""
        return {
            "category": "prompt",
            "title": "User prompt",
            "target": None,
            "detail": str(prompt),
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
    if hook in ("SessionStart", "sessionStart"):
        return {
            "category": "lifecycle",
            "title": "Session started",
            "target": body.get("cwd"),
            "detail": _json_detail(body),
            "status": "ok",
            "duration_ms": duration_ms,
        }
    if hook in ("SessionEnd", "sessionEnd", "Stop", "stop"):
        return {
            "category": "lifecycle",
            "title": "Session ended",
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
    tool_name = tool or body.get("tool_name") or ""
    tool_input = _coerce_tool_input(body.get("tool_input"))
    tool_response = body.get("tool_response") or body.get("tool_output") or {}

    if source in ("claude", "codex") and tool_name:
        res = _tool_event(hook, tool_name, tool_input, tool_response, body, duration_ms)
        if res is not None:
            return res

    # --- Cursor hook-based ---
    if source == "cursor":
        if hook in ("beforeShellExecution", "afterShellExecution"):
            cmd = body.get("command") or ""
            return {
                "category": "shell",
                "title": "Shell command",
                "target": _short(cmd, 120),
                "detail": _json_detail(body),
                "status": "ok",
                "duration_ms": duration_ms,
            }
        if hook in ("beforeMCPExecution", "afterMCPExecution"):
            server = body.get("server") or body.get("mcp_server") or ""
            mcp_tool = body.get("tool_name") or body.get("tool") or ""
            if _is_browser_network_tool(mcp_tool):
                url = _extract_network_url(body) or (body.get("arguments") or {}).get("url")
                if url:
                    return _web_call(
                        title="External network",
                        target=str(url),
                        detail=body,
                        status="ok",
                        duration_ms=duration_ms,
                    )
            return {
                "category": "mcp",
                "title": f"MCP {server or 'call'}",
                "target": f"{server}/{mcp_tool}".strip("/") if server else mcp_tool,
                "detail": _json_detail(body),
                "status": "ok",
                "duration_ms": duration_ms,
            }
        if hook == "beforeReadFile":
            path = body.get("file_path") or body.get("path") or ""
            cat = "context_read" if _matches(path, _CONTEXT_PATTERNS) else "file_read"
            return {
                "category": cat,
                "title": "Read file",
                "target": path,
                "detail": _json_detail(body),
                "status": "ok",
                "duration_ms": duration_ms,
            }
        if hook == "afterFileEdit":
            path = _extract_path(body) or ""
            cat = "memory" if _matches(path, _MEMORY_PATTERNS) else "file_edit"
            return {
                "category": cat,
                "title": "Edit file",
                "target": path,
                "detail": _json_detail(body),
                "status": "ok",
                "duration_ms": duration_ms,
            }
        if hook in ("preToolUse", "postToolUse", "postToolUseFailure"):
            tn = body.get("tool_name") or tool or ""
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
        "ts": body.get("timestamp") or _now(),
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
