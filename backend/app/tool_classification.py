"""Classify normalized tool invocations into event display categories."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any

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

_PATCH_FILE_RE = re.compile(r"\*\*\*\s+(?:Update|Add|Delete) File:\s*(.+)")
_BROWSER_NETWORK_TOOLS = frozenset({"browser_navigate"})
_SEARCH_TOOLS = frozenset(
    {"Glob", "Grep", "Search", "Codebase", "GrepSearch", "FileSearch", "ListDir"}
)

_TOOL_ALIASES = {
    "ReadFile": "Read",
    "StrReplace": "Edit",
    "SearchReplace": "Edit",
    "ApplyPatch": "apply_patch",
    "SemanticSearch": "Search",
    "ListDir": "Search",
    "rg": "Bash",
}

_TOOL_HOOKS = frozenset(
    {
        "PreToolUse",
        "PostToolUse",
        "PostToolUseFailure",
        "preToolUse",
        "postToolUse",
        "postToolUseFailure",
    }
)

_META_TOOLS: dict[str, str] = {
    "TodoWrite": "Update todos",
    "AwaitShell": "Await shell",
    "SwitchMode": "Switch mode",
    "ReadLints": "Read lints",
    "UpdateCurrentStep": "Update step",
    "updateCurrentStep": "Update step",
    "ToolSearch": "Tool search",
    "update_plan": "Update plan",
}


@dataclass(frozen=True)
class ToolInvocation:
    """Provider-neutral tool call shape consumed by the classifier."""

    name: str
    input: dict[str, Any] = field(default_factory=dict)
    response: Any = field(default_factory=dict)
    status: str = "ok"
    duration_ms: int | None = None
    body: dict[str, Any] = field(default_factory=dict)
    raw_input: Any = None


def json_detail(obj: Any) -> str:
    return json.dumps(obj, indent=2, ensure_ascii=False, default=str)


def short(text: str | None, limit: int = 80) -> str:
    if not text:
        return ""
    text = str(text).strip().replace("\n", " ")
    return text if len(text) <= limit else text[: limit - 1] + "…"


def matches_context_path(path: str | None) -> bool:
    return _matches(path, _CONTEXT_PATTERNS)


def matches_memory_path(path: str | None) -> bool:
    return _matches(path, _MEMORY_PATTERNS)


def _matches(path: str | None, patterns: tuple[re.Pattern[str], ...]) -> bool:
    if not path:
        return False
    return any(p.search(path.replace("\\", "/")) for p in patterns)


def canonical_tool(name: str | None) -> str:
    return _TOOL_ALIASES.get(name or "", name or "")


def is_tool_hook(hook: str) -> bool:
    return hook in _TOOL_HOOKS


def cursor_tool(hook: str, body: dict[str, Any]) -> str | None:
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


def subagent_key(body: dict[str, Any]) -> str | None:
    for field in ("subagent_id", "tool_call_id", "tool_use_id"):
        val = body.get(field)
        if isinstance(val, str) and val.strip():
            return val.strip().split("\n")[0].strip()
    return None


def subagent_label(body: dict[str, Any], tool_input: dict[str, Any] | None = None) -> str:
    ti = tool_input if isinstance(tool_input, dict) else {}
    if not ti:
        raw = body.get("tool_input")
        ti = raw if isinstance(raw, dict) else {}
    desc = body.get("description") or ti.get("description") or body.get("task") or ti.get("prompt")
    stype = body.get("subagent_type") or body.get("agent_type") or ti.get("subagent_type")
    if desc:
        desc = short(str(desc), 80)
    if stype and desc:
        return f"{stype} · {desc}"
    return stype or desc or "Subagent"


def coerce_tool_input(val: Any) -> dict[str, Any]:
    if isinstance(val, dict):
        return val
    if isinstance(val, str) and val.strip():
        try:
            parsed = json.loads(val)
            return parsed if isinstance(parsed, dict) else {}
        except json.JSONDecodeError:
            return {}
    return {}


def extract_path(body: dict[str, Any], tool_input: dict[str, Any] | None = None) -> str | None:
    for key in ("file_path", "path", "target"):
        val = body.get(key)
        if isinstance(val, str) and val:
            return val
    inputs = tool_input if isinstance(tool_input, dict) else body.get("tool_input")
    if isinstance(inputs, dict):
        for key in ("file_path", "path", "notebook_path"):
            val = inputs.get(key)
            if isinstance(val, str) and val:
                return val
    edits = body.get("edits")
    if isinstance(edits, list) and edits:
        first = edits[0]
        if isinstance(first, dict) and first.get("file_path"):
            return str(first["file_path"])
    return None


def extract_network_url(body: dict[str, Any], tool_input: dict[str, Any] | None = None) -> str | None:
    inputs = tool_input if isinstance(tool_input, dict) else coerce_tool_input(body.get("tool_input"))
    url = inputs.get("url")
    if isinstance(url, str) and url.strip():
        return url.strip()
    result = body.get("result_json")
    if isinstance(result, str):
        match = re.search(r"Page URL:\s*(\S+)", result)
        if match:
            return match.group(1).rstrip("/")
    return None


def is_browser_network_tool(tool_name: str | None) -> bool:
    return _tool_basename(tool_name) in _BROWSER_NETWORK_TOOLS


def web_call(
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
        "detail": detail if isinstance(detail, str) else json_detail(detail),
        "status": status,
        "duration_ms": duration_ms,
    }


def classify_cursor_hook(
    hook: str,
    body: dict[str, Any],
    duration_ms: int | None,
) -> dict[str, Any] | None:
    """Classify Cursor's granular live hook events without changing payload detail."""
    if hook in ("beforeShellExecution", "afterShellExecution"):
        cmd = body.get("command") or ""
        return {
            "category": "shell",
            "title": "Shell command",
            "target": short(cmd, 120),
            "detail": json_detail(body),
            "status": "ok",
            "duration_ms": duration_ms,
        }

    if hook in ("beforeMCPExecution", "afterMCPExecution"):
        server = body.get("server") or body.get("mcp_server") or ""
        mcp_tool = body.get("tool_name") or body.get("tool") or ""
        if is_browser_network_tool(mcp_tool):
            args = body.get("arguments") if isinstance(body.get("arguments"), dict) else {}
            url = extract_network_url(body) or args.get("url")
            if url:
                return web_call(
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
            "detail": json_detail(body),
            "status": "ok",
            "duration_ms": duration_ms,
        }

    if hook == "beforeReadFile":
        path = body.get("file_path") or body.get("path") or ""
        return {
            "category": "context_read" if matches_context_path(path) else "file_read",
            "title": "Read file",
            "target": path,
            "detail": json_detail(body),
            "status": "ok",
            "duration_ms": duration_ms,
        }

    if hook == "afterFileEdit":
        path = extract_path(body) or ""
        return {
            "category": "memory" if matches_memory_path(path) else "file_edit",
            "title": "Edit file",
            "target": path,
            "detail": json_detail(body),
            "status": "ok",
            "duration_ms": duration_ms,
        }

    return None


def classify_tool(invocation: ToolInvocation) -> dict[str, Any] | None:
    """Map one normalized tool invocation to category and display fields."""
    tool_name = canonical_tool(invocation.name)
    tool_input = invocation.input if isinstance(invocation.input, dict) else {}
    tool_response = invocation.response
    body = invocation.body or {}
    status = invocation.status or "ok"
    duration_ms = invocation.duration_ms
    path = extract_path(body, tool_input)

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
            "title": short(title, 120),
            "target": _question_target(tool_input, title),
            "detail": json_detail({"input": tool_input, "response": tool_response}),
            "status": status,
            "duration_ms": duration_ms,
        }

    if tool_name == "apply_patch":
        patch = tool_input.get("command")
        if not patch and isinstance(invocation.raw_input, str):
            patch = invocation.raw_input
        path = _extract_patch_path(patch) or path
        return {
            "category": "memory" if matches_memory_path(path) else "file_edit",
            "title": "Edit file",
            "target": path,
            "detail": json_detail({"input": tool_input, "response": tool_response}),
            "status": status,
            "duration_ms": duration_ms,
        }

    if tool_name in ("Task", "Agent", "Subagent"):
        key = subagent_key(body)
        label = subagent_label(body, tool_input)
        return {
            "category": "subagent",
            "title": label,
            "target": key or label,
            "detail": json_detail({"input": tool_input, "response": tool_response}),
            "status": "ok",
            "duration_ms": duration_ms,
        }

    if tool_name in ("Bash", "Shell"):
        cmd = tool_input.get("command", "")
        return {
            "category": "shell",
            "title": "Shell command",
            "target": short(cmd, 120),
            "detail": json_detail({"command": cmd, "response": tool_response}),
            "status": status,
            "duration_ms": duration_ms,
        }

    if tool_name in ("CallMcpTool", "call_mcp_tool"):
        server = tool_input.get("server") or ""
        mcp_tool = tool_input.get("toolName") or tool_input.get("tool") or ""
        if is_browser_network_tool(mcp_tool):
            args = coerce_tool_input(tool_input.get("arguments"))
            url = args.get("url") or extract_network_url(body, tool_input)
            if url:
                return web_call(
                    title="External network",
                    target=str(url),
                    detail={"input": tool_input, "response": tool_response},
                    status=status,
                    duration_ms=duration_ms,
                )
        target = f"{server}/{mcp_tool}" if server and mcp_tool else mcp_tool or server or tool_name
        return {
            "category": "memory" if server == "memory" else "mcp",
            "title": f"MCP {server or mcp_tool or 'call'}",
            "target": target,
            "detail": json_detail({"input": tool_input, "response": tool_response}),
            "status": status,
            "duration_ms": duration_ms,
        }

    if tool_name == "CreatePlan":
        todos = tool_input.get("todos")
        return {
            "category": "plan",
            "title": short(str(tool_input.get("name") or "Plan"), 120),
            "target": None,
            "detail": json_detail(
                {
                    "overview": tool_input.get("overview") or "",
                    "plan": tool_input.get("plan") or "",
                    "todos": todos if isinstance(todos, list) else [],
                }
            ),
            "status": status,
            "duration_ms": duration_ms,
        }

    if tool_name in ("Read", "NotebookRead"):
        content = tool_response if isinstance(tool_response, str) else json_detail(tool_response)
        return {
            "category": "context_read" if matches_context_path(path) else "file_read",
            "title": "Read file",
            "target": path,
            "detail": content or json_detail({"input": tool_input, "response": tool_response}),
            "status": status,
            "duration_ms": duration_ms,
        }

    if tool_name in ("Write", "Edit", "MultiEdit", "NotebookEdit", "Delete"):
        return {
            "category": "memory" if matches_memory_path(path) else "file_edit",
            "title": "Delete file" if tool_name == "Delete" else "Edit file",
            "target": path,
            "detail": json_detail({"input": tool_input, "response": tool_response}),
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
            "target": short(str(pattern)),
            "detail": json_detail({"input": tool_input, "response": tool_response}),
            "status": status,
            "duration_ms": duration_ms,
        }

    if tool_name in ("WebFetch", "WebSearch"):
        return web_call(
            title=tool_name,
            target=_extract_web_target(tool_input),
            detail={"input": tool_input, "response": tool_response},
            status=status,
            duration_ms=duration_ms,
        )

    if tool_name.startswith("mcp__") or tool_name.startswith("MCP:"):
        if tool_name.startswith("MCP:"):
            server, mcp_tool = None, tool_name[4:]
        else:
            server, mcp_tool = _parse_mcp(tool_name)
        if is_browser_network_tool(mcp_tool):
            url = extract_network_url(body, tool_input) or tool_input.get("url")
            if url:
                return web_call(
                    title="External network",
                    target=str(url),
                    detail={"input": tool_input, "response": tool_response},
                    status=status,
                    duration_ms=duration_ms,
                )
        label = server or mcp_tool or tool_name
        target = f"{server}/{mcp_tool}" if server and mcp_tool else mcp_tool or server or tool_name
        return {
            "category": "memory" if server == "memory" else "mcp",
            "title": f"MCP {label}",
            "target": target,
            "detail": json_detail({"input": tool_input, "response": tool_response}),
            "status": status,
            "duration_ms": duration_ms,
        }

    if tool_name == "Skill":
        skill = tool_input.get("name") or tool_input.get("skill") or tool_input.get("command")
        return {
            "category": "context_read",
            "title": "Skill",
            "target": short(str(skill)) if skill else None,
            "detail": json_detail({"input": tool_input, "response": tool_response}),
            "status": status,
            "duration_ms": duration_ms,
        }

    meta_title = _META_TOOLS.get(tool_name)
    if meta_title:
        return {
            "category": "meta",
            "title": meta_title,
            "target": None,
            "detail": json_detail({"input": tool_input, "response": tool_response}),
            "status": status,
            "duration_ms": duration_ms,
        }

    return None


def _extract_patch_path(patch: Any) -> str | None:
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
    return short(key, 160)
